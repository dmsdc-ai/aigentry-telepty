// Actual CLI security producers; retain the original non-strict semantics.
// Construction does not read shared getters or start CLI/native/network work.
function createCliSecurityActions(shared, {
  execSync = (...args) => (0, shared.execSync)(...args),
  execFileSync = (...args) => (0, shared.execFileSync)(...args),
  fetch = (...args) => (0, globalThis.fetch)(...args),
  exit = code => process.exit(code)
} = {}) {
function getAuthToken() {
  if (shared.cachedAuthToken == null) {
    shared.cachedAuthToken = process.env.TELEPTY_AUTH_TOKEN || (0, shared.getConfig)().authToken;
  }
  return shared.cachedAuthToken;
}

function peerTokenFor(host, port) {
  if (shared.cachedPeerTokens == null) {
    shared.cachedPeerTokens = new Map();
    try {
      for (const entry of Object.values(shared.crossMachine.loadPeers().peers || {})) {
        if (entry && entry.token && entry.host) {
          shared.cachedPeerTokens.set(`${entry.host}:${entry.port}`, entry.token);
        }
      }
    } catch { /* no peers.json, or unreadable — nothing to resolve, fall through to the local token */ }
  }
  return shared.cachedPeerTokens.get(`${host}:${port}`) || null;
}

function isLocalHostname(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function resolveTargetToken(url) {
  if (process.env.TELEPTY_AUTH_TOKEN) return process.env.TELEPTY_AUTH_TOKEN;
  let host = null;
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    // Keyed on host AND port, so two daemons on one host are two targets. Not skipped for
    // loopback: nobody runs `connect-http` against their own daemon, so the local address has no
    // entry and this falls through — but if an entry for that exact address DOES exist, it is a
    // deliberate act and honouring it is correct.
    const peerToken = peerTokenFor(host, Number(parsed.port) || shared.PORT);
    if (peerToken) return peerToken;
  } catch { /* not a URL we can read — see below: no host, so nothing is dialled from here */ }
  if (host && !isLocalHostname(host)) throw credentialRefusalError(host);
  return getAuthToken();
}

function credentialRefusalError(host) {
  const error = new Error(
    `Refusing to send this machine's daemon token to ${host} — no stored credential for that address, `
    + 'and the local token is not valid there.\n  '
    + credentialRefusalHint(host)
  );
  error.name = 'CredentialRefusalError';
  error.code = 'NO_TARGET_CREDENTIAL';
  markCommandFailed();
  return error;
}

function credentialRefusalHint(host) {
  if (!host || isLocalHostname(host)) {
    return 'The local daemon is running and REFUSED this token. It freezes the token at start, by design, '
      + 'so a rotated ~/.telepty/config.json needs a daemon restart to take effect.';
  }
  return `Each node mints its own token, so the local one is not valid at ${host}. Store that host's token:\n`
    + `    telepty connect-http ${host} --token <that host's authToken>\n`
    + '  or export TELEPTY_AUTH_TOKEN with a token both ends share (the daemon must see it too).';
}

function namedTransportError(url, cause) {
  let origin = String(url);
  try { origin = new URL(url).origin; } catch { /* not parseable — naming the raw target still beats naming nothing */ }
  const code = (cause && (cause.code || (cause.cause && cause.cause.code))) || null;
  const detail = cause && cause.name === 'TimeoutError'
    ? 'timed out'
    : `${(cause && cause.message) || 'unknown error'}${code ? ` (${code})` : ''}`;
  const error = new Error(`Could not reach ${origin} — ${detail}`);
  error.name = 'TransportError';
  error.origin = origin;
  error.code = code;
  error.cause = cause;
  return error;
}

function markCommandFailed() {
  if (shared.isMainModule) process.exitCode = 1;
}

function classifyBackend(env, findKitty) {
  if (env.TERM_PROGRAM === 'WarpTerminal') return 'warp';
  if (env.CMUX_WORKSPACE_ID) return 'cmux';
  return findKitty() ? 'kitty' : 'pty';
}

function runUpdateInstall() {
  if (process.env.TELEPTY_SKIP_PACKAGE_UPDATE === '1') {
    return;
  }

  // #26: default self-update runs npm with a fixed arg array via execFileSync (no shell →
  // no command injection). An explicit operator-supplied TELEPTY_UPDATE_COMMAND is a trusted
  // env override (the operator deliberately chose to run a custom shell command — setting the
  // env already implies shell control, so no privilege boundary is crossed). This execSync is
  // accepted-by-design, consistent with the documented Snyk baseline waiver (CHANGELOG).
  const override = process.env.TELEPTY_UPDATE_COMMAND;
  if (override) {
    execSync(override, { stdio: 'inherit' });
    return;
  }
  execFileSync('npm', ['install', '-g', '@dmsdc-ai/aigentry-telepty@latest'], { stdio: 'inherit' });
}

function createTrailingPayloadHelp() {
return {
  allow: [
    'Usage: telepty allow [--id <session_id>] [--idle-ttl <duration|off>] [--auto-restart] <command> [args...]',
    '',
    'Wrap a CLI so other sessions can inject into it. Aliases: enable, wrap.',
    'Use `--` before the command to pass hyphenated arguments literally:',
    '  telepty allow -- claude --help'
  ],
  inject: [
    'Usage: telepty inject [--ref [file]] [--from <id>] [--reply-to <id>] [--submit] [--submit-force] [--submit-retry N] <session_id> "<prompt text>"',
    '',
    'Inject prompt text into a session. Use `--` before the prompt to send a payload',
    'that starts with a hyphen: telepty inject my-session -- --help'
  ],
  multicast: [
    'Usage: telepty multicast <id1,id2,...> "<prompt text>"',
    '',
    'Inject prompt text into multiple sessions. Use `--` before the prompt to send',
    'a payload that starts with a hyphen: telepty multicast id1,id2 -- --help'
  ],
  broadcast: [
    'Usage: telepty broadcast [--ref [file]] "<prompt text>"',
    '',
    'Inject prompt text into ALL active sessions. Use `--` before the prompt to send',
    'a payload that starts with a hyphen: telepty broadcast -- --help'
  ]
};
}

function helpRequested(argv) {
  for (const arg of argv) {
    if (arg === '--') return false;
    if (arg === '--help' || arg === '-h') return true;
  }
  return false;
}

function interceptSubcommandHelp(cmd, argv) {
  const canonical = (cmd === 'enable' || cmd === 'wrap') ? 'allow' : cmd;
  const lines = shared.TRAILING_PAYLOAD_HELP[canonical];
  if (!lines || !helpRequested(argv)) return false;
  console.log(lines.join('\n'));
  return true;
}

const fetchWithAuth = (url, options = {}) => {
  const headers = { ...options.headers, 'x-telepty-token': resolveTargetToken(url) };
  // #43 P2 — present the per-session verified-sender token (minted at register, carried in the
  // parent-hijack-protected env beside TELEPTY_SESSION_ID) so the daemon can map token→sid and
  // record verified_sender_sid. Header only, never the body. Absent for operator/human shells.
  const sessionToken = process.env.TELEPTY_SESSION_TOKEN;
  if (sessionToken) headers['x-telepty-session-token'] = sessionToken;
  // Wrapped here rather than at the 45 call sites: every one of them either prints `e.message`
  // or swallows the throw, so this is the single place the origin can be attached without
  // changing what any caller does with the error.
  return fetch(url, { ...options, headers }).catch((error) => { throw namedTransportError(url, error); });
};

function parseAllowInvocation(cmd, args) {
    if (interceptSubcommandHelp(cmd, args.slice(1))) return; // telepty#51: never wrap "--help" as a command
    // Parse arguments: telepty allow [--id <session_id>] <command> [args...]
    // Also supports legacy: telepty allow [--id <session_id>] -- <command> [args...]
    const allowArgs = args.slice(1);

    // Extract --id flag
    let sessionId;
    const idIndex = allowArgs.indexOf('--id');
    if (idIndex !== -1 && allowArgs[idIndex + 1]) {
      sessionId = allowArgs[idIndex + 1];
      allowArgs.splice(idIndex, 2);
    }

    // Extract per-session idle TTL override
    let idleTtl = null;
    const idleTtlIndex = allowArgs.indexOf('--idle-ttl');
    if (idleTtlIndex !== -1) {
      if (!allowArgs[idleTtlIndex + 1]) {
        console.error('❌ Usage: telepty allow [--id <session_id>] [--idle-ttl <duration|off>] <command> [args...]');
        exit(1);
      }
      idleTtl = allowArgs[idleTtlIndex + 1];
      try {
        shared.lifecycle.parseDuration(idleTtl, { fieldName: 'idle_ttl' });
      } catch (err) {
        console.error(`❌ ${err.message}`);
        exit(1);
      }
      allowArgs.splice(idleTtlIndex, 2);
    }

    // Extract --auto-restart flag
    const autoRestartIndex = allowArgs.indexOf('--auto-restart');
    const autoRestart = autoRestartIndex !== -1;
    if (autoRestart) allowArgs.splice(autoRestartIndex, 1);

    // Strip optional -- separator for backward compat
    const sepIndex = allowArgs.indexOf('--');
    if (sepIndex !== -1) allowArgs.splice(sepIndex, 1);

    const command = allowArgs[0];
    const cmdArgs = allowArgs.slice(1);

    if (!command) {
      console.error('❌ Usage: telepty allow [--id <session_id>] <command> [args...]');
      exit(1);
    }

    // Default session ID = {folder}-{cli} (e.g. aigentry-dustcraw-claude)
    if (!sessionId) {
      const folder = shared.path.basename(process.cwd());
      const cli = shared.path.basename(command).replace(/\..*$/, '');
      sessionId = `${folder}-${cli}`;
    }

    // Override inherited TELEPTY_SESSION_ID — prevent parent session hijacking
    // When launched via kitty @ launch, the parent's env leaks through.
    // With --id flag, we always use the explicitly requested session ID.
    if (process.env.TELEPTY_SESSION_ID && process.env.TELEPTY_SESSION_ID !== sessionId) {
      console.error(`⚠️  [allow] Overriding inherited TELEPTY_SESSION_ID="${process.env.TELEPTY_SESSION_ID}" → "${sessionId}"`);
    }
    delete process.env.TELEPTY_SESSION_ID;
    process.env.TELEPTY_SESSION_ID = sessionId;
    process.env.TELEPTY_AVAILABLE = 'true';
    // #43 P2 — drop any inherited verified-sender token so a parent process cannot smuggle one
    // in; the daemon mints the real one at register (below) and we set it into the same
    // protected env.
    delete process.env.TELEPTY_SESSION_TOKEN;
    // #47 P4 — same parent-hijack defense for the per-session provenance nonce: drop any inherited
    // value so a parent cannot pre-seed a known nonce, then carry the daemon-minted one (below).
    delete process.env.TELEPTY_SESSION_NONCE;
    return { sessionId, command, cmdArgs, idleTtl, autoRestart };
}

return { createTrailingPayloadHelp, getAuthToken, peerTokenFor, isLocalHostname, resolveTargetToken, credentialRefusalError, credentialRefusalHint, namedTransportError, markCommandFailed, classifyBackend, runUpdateInstall, helpRequested, interceptSubcommandHelp, fetchWithAuth, parseAllowInvocation };
}

function createAllowSecurityContext(shared, {
  spawnPty = (...args) => shared.pty.spawn(...args),
  now = () => Date.now(),
  setTimeout = (...args) => (0, globalThis.setTimeout)(...args),
  clearTimeout = (...args) => (0, globalThis.clearTimeout)(...args),
  setInterval = (...args) => (0, globalThis.setInterval)(...args),
  clearInterval = (...args) => (0, globalThis.clearInterval)(...args),
  getStdout = () => process.stdout,
  removeSignalHandler = (...args) => process.off(...args),
  bridgeRoot
} = {}) {
    // This fence belongs to this context, even if another context resets shared state.
    let closed = false;
    const deliveryTimers = new Set();
    function isClosed() {
      if (shared.allowSessionClosed) closed = true;
      return closed;
    }
    function canDeliver(child) {
      return !isClosed() && child === shared.child;
    }

    function updateDaemonProcessMetadata() {
      const body = {
        session_id: shared.sessionId,
        command: shared.command,
        cwd: process.cwd(),
        backend: shared.detectedBackend,
        cmux_workspace_id: process.env.CMUX_WORKSPACE_ID || null,
        cmux_surface_id: process.env.CMUX_SURFACE_ID || null,
        term_program: shared.terminalProgram,
        term: shared.terminalType,
        owner_pid: process.pid,
        ...(shared.child && shared.child.pid ? { pty_pid: shared.child.pid } : {}),
        ...(shared.idleTtl !== null ? { idle_ttl: shared.idleTtl } : {})
      };
      (0, shared.fetchWithAuth)(`${shared.DAEMON_URL}/api/sessions/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).catch(() => {});
    }

    function spawnChild() {
      // Windows: walk %PATHEXT% so bare names (`claude`, `codex`, `gemini`)
      // resolve to their npm-global `.cmd`/`.ps1` shims. POSIX: no-op. (#25)
      const resolvedCommand = (0, shared.resolveWindowsExecutable)(shared.command, process.env);
      // #26 (Snyk waiver, accepted-by-design): spawning the operator/user-chosen CLI IS the
      // `telepty allow` feature — `command` comes from the local CLI invocation, not an
      // untrusted boundary, so this is not an exploitable injection. Pre-existing baseline
      // finding; not fixable without removing `telepty allow`.
      shared.child = spawnPty(resolvedCommand, shared.cmdArgs, {
        name: 'xterm-256color',
        cols: getStdout().columns || 80,
        rows: getStdout().rows || 30,
        cwd: shared.sessionCwd,
        env: shared.sessionEnv
      });
      shared.sessionStartTime = now();
      updateDaemonProcessMetadata();
      return shared.child;
    }

    function enqueueBridgeMessage(text) {
      if (isClosed()) return;
      const child = shared.child;
      const msgId = `${shared.sessionId}:${now()}:${++shared.bridgeMsgSeq}`;
      try {
        shared.bridgeMailbox.enqueue({
          msg_id: msgId, from: 'daemon', to: shared.bridgeTarget,
          payload: text, created_at: Math.floor(now() / 1000), attempt: 0,
        });
        if (!canDeliver(child)) return;
        shared.bridgePendingCount++;
      } catch (err) {
        // Fallback: write directly if mailbox fails
        if (!canDeliver(child)) return;
        console.error(`[BRIDGE] Mailbox enqueue failed, writing directly: ${err.message}`);
        invalidateBridgeInteraction('automated_input');
        if (!canDeliver(child)) return;
        child.write(text);
      }
    }

    function isIdle() {
      return shared.promptReady && (now() - shared.lastUserInputTime > shared.IDLE_THRESHOLD);
    }

    function observePromptReady(data) {
      if (shared.knownAiCli) {
        shared.outputTail = (shared.outputTail + data).slice(-20000);
        const hit = shared.readyRegistry.detectOutput(shared.command, shared.outputTail);
        if (!hit.found) return false;
        shared.readyQualification = {
          ready_kind: 'composer_surface_observed',
          detector: hit.reason || 'registry_match',
          cli_key: shared.readyRegistry.commandKey(shared.command),
        };
        return true;
      }
      if (!shared.promptPattern.test(data)) return false;
      shared.readyQualification = {
        ready_kind: 'prompt_suffix_observed',
        detector: 'generic_prompt_suffix',
        cli_key: null,
      };
      return true;
    }

    function flushBridgeMailbox() {
      if (isClosed()) return;
      const child = shared.child;
      if (shared.queueFlushTimer) { clearTimeout(shared.queueFlushTimer); shared.queueFlushTimer = null; }
      if (shared.idleCheckTimer) { clearInterval(shared.idleCheckTimer); shared.idleCheckTimer = null; }
      if (shared.bridgePendingCount === 0) return;
      let delay = 0;
      const batch = [];
      // Dequeue all pending messages
      while (true) {
        if (!canDeliver(child)) return;
        const msg = shared.bridgeMailbox.dequeue(shared.bridgeTarget);
        if (!canDeliver(child)) return;
        if (!msg) break;
        batch.push(msg);
      }
      if (batch.length === 0) { shared.bridgePendingCount = 0; return; }
      // #720: drop stale-parked and consecutive-duplicate injects before writing,
      // so a long-closed gate does not deliver the same question N times or replay
      // an inject that went stale while parked.
      const nowSecs = Math.floor(now() / 1000);
      const { deliver, dropped } = (0, shared.filterBridgeBatch)(batch, {
        ttlSecs: (0, shared.bridgeInjectTtlSecs)(process.env), nowSecs,
      });
      for (const { msg, reason } of dropped) {
        if (!canDeliver(child)) return;
        // Ack so the dropped inject clears in_flight instead of lingering; never write it.
        try { shared.bridgeMailbox.ack(shared.bridgeTarget, msg.msg_id); } catch {}
        console.warn(`\x1b[33m[BRIDGE] dropped ${reason} inject ${msg.msg_id} (age=${nowSecs - msg.created_at}s)\x1b[0m`);
      }
      for (const msg of deliver) {
        if (!canDeliver(child)) return;
        const text = msg.payload;
        const msgId = msg.msg_id;
        const timer = setTimeout(() => {
          deliveryTimers.delete(timer);
          if (!canDeliver(child)) return;
          invalidateBridgeInteraction('automated_input');
          if (!canDeliver(child)) return;
          child.write(text);
          if (!canDeliver(child)) return;
          try { shared.bridgeMailbox.ack(shared.bridgeTarget, msgId); } catch {}
        }, delay);
        deliveryTimers.add(timer);
        delay += text === '\r' ? 0 : 100;
      }
      if (!canDeliver(child)) return;
      shared.bridgePendingCount = Math.max(0, shared.bridgePendingCount - batch.length);
      shared.promptReady = false;
    }

    function scheduleIdleFlush() {
      if (isClosed() || shared.idleCheckTimer) return;
      // Poll every 500ms for idle state
      shared.idleCheckTimer = setInterval(() => {
        if (isClosed()) return;
        if (isIdle() && shared.bridgePendingCount > 0) {
          flushBridgeMailbox();
        }
      }, 500);
      // Safety fallback is compatibility-only during known AI CLI bootstrap:
      // first dispatch must wait for a strong ready signal.
      if ((!shared.knownAiCli || shared.firstReadyObserved) && !shared.queueFlushTimer) {
        shared.queueFlushTimer = setTimeout(() => {
          if (isClosed()) return;
          shared.queueFlushTimer = null;
          if (shared.bridgePendingCount > 0) {
            flushBridgeMailbox();
          }
        }, 5000);
      }
    }

    function invalidateBridgeInteraction(reason) {
      if (isClosed()) return;
      if (shared.interactionBinding) {
        shared.interactionBinding.input_generation++;
        if (reason === 'resize') shared.interactionBinding.geometry_generation++;
      }
      if (shared.wsReady && shared.daemonWs?.readyState === 1) {
        const size = (0, shared.getTerminalSize)(getStdout(), { cols: 120, rows: 40 });
        if (isClosed()) return;
        if (shared.interactionBinding) Object.assign(shared.interactionBinding, size);
        try { shared.daemonWs.send(JSON.stringify({ type: 'interaction_invalidated', reason,
          owner_generation: shared.interactionBinding?.owner_generation,
          input_generation: shared.interactionBinding?.input_generation,
          geometry_generation: shared.interactionBinding?.geometry_generation, ...size })); } catch {}
      }
    }

    function closeAllowSession({ destroySession = true } = {}) {
      if (closed) return false;
      closed = true;
      shared.allowSessionClosed = true;
      for (const timer of deliveryTimers) clearTimeout(timer);
      deliveryTimers.clear();
      if (shared.queueFlushTimer != null) clearTimeout(shared.queueFlushTimer);
      if (shared.idleCheckTimer != null) clearInterval(shared.idleCheckTimer);
      if (shared.reconnectTimer != null) clearTimeout(shared.reconnectTimer);
      if (shared.heartbeatTimer != null) clearInterval(shared.heartbeatTimer);
      shared.queueFlushTimer = null;
      shared.idleCheckTimer = null;
      shared.reconnectTimer = null;
      shared.heartbeatTimer = null;
      (0, shared.cleanupTerminal)();
      // Purge bridge mailbox on clean exit (undelivered messages are stale)
      if (destroySession) {
        try { shared.bridgeMailbox.purge(shared.bridgeTarget); } catch {}
      }
      getStdout().write(`\x1b]0;\x07`);
      // BUG-C: carry our owner token so the daemon destroys only on the CURRENT owner's exit;
      // a stale/displaced owner's DELETE (mismatched token) must not tear down the live owner.
      if (destroySession) {
        const deleteUrl = shared.currentOwnerToken
          ? `${shared.DAEMON_URL}/api/sessions/${encodeURIComponent(shared.sessionId)}?owner_token=${encodeURIComponent(shared.currentOwnerToken)}`
          : `${shared.DAEMON_URL}/api/sessions/${encodeURIComponent(shared.sessionId)}`;
        (0, shared.fetchWithAuth)(deleteUrl, { method: 'DELETE' }).catch(() => {});
      }
      try {
        shared.daemonWs.close();
      } catch {}
      for (const [signalName, handler] of shared.allowSignalHandlers) {
        removeSignalHandler(signalName, handler);
      }
      return true;
    }

    function createBridgeMailbox() {
    return new shared.FileMailbox({
      root: bridgeRoot === undefined ? shared.path.join(shared.os.homedir(), '.aigentry', 'mailbox', 'bridge') : bridgeRoot,
    });
    }

    function recoverBridgeMailbox() {
    if (isClosed()) return;
    try {
      const leftover = shared.bridgeMailbox.peek(shared.bridgeTarget).filter(m => m.state === 'pending' || m.state === 'in_flight');
      shared.bridgePendingCount = leftover.length;
      if (shared.bridgePendingCount > 0) {
        console.log(`\x1b[33m[BRIDGE] Recovered ${shared.bridgePendingCount} undelivered message(s) from previous session\x1b[0m`);
      }
    } catch {}
    }

return { updateDaemonProcessMetadata, spawnChild, enqueueBridgeMessage, isIdle, observePromptReady, flushBridgeMailbox, scheduleIdleFlush, invalidateBridgeInteraction, closeAllowSession, createBridgeMailbox, recoverBridgeMailbox };
}

module.exports = { createCliSecurityActions, createAllowSecurityContext };
