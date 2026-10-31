const { buildPtySpawnTarget } = require('../win-spawn-target');
const bridgeStage = require('../mailbox/bridge-stage');
const readinessHandshake = require('../transport/readiness-handshake');
// Actual CLI security producers; retain the original non-strict semantics.
// Construction does not read shared getters or start CLI/native/network work.
// A registration error body is not credential issuance. Keep the wrapper and
// its future child-spawn environment consistent only after successful issuance.
function credentialOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    if (url.protocol === 'wss:') url.protocol = 'https:';
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch { return null; }
}
function scopedSessionToken(url, { env = process.env, localOrigin = 'http://127.0.0.1:3848' } = {}) {
  const destination = credentialOrigin(url);
  const boundOrigin = credentialOrigin(env.TELEPTY_SESSION_ORIGIN || localOrigin);
  return destination && destination === boundOrigin ? env.TELEPTY_SESSION_TOKEN || null : null;
}
function adoptRegistrationCredential(response, data, env, childEnv = env, origin) {
  if (!response?.ok || typeof data?.session_token !== 'string' || !data.session_token) return false;
  const boundOrigin = origin === undefined ? null : credentialOrigin(origin);
  if (origin !== undefined && !boundOrigin) return false;
  if (boundOrigin) { env.TELEPTY_SESSION_ORIGIN = boundOrigin; childEnv.TELEPTY_SESSION_ORIGIN = boundOrigin; }
  env.TELEPTY_SESSION_TOKEN = data.session_token;
  childEnv.TELEPTY_SESSION_TOKEN = data.session_token;
  return true;
}

function positiveInt(raw, fallback) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function createCliSecurityActions(shared, {
  execSync = (...args) => (0, shared.execSync)(...args),
  execFileSync = (...args) => (0, shared.execFileSync)(...args),
  fetch = (...args) => (0, globalThis.fetch)(...args),
  exit = code => process.exit(code),
  platform = process.platform,
  guardUpdate = options => require('../update-plan').assertUpdateCanRun(options)
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

function resolveTargetToken(url, { readOnly = false } = {}) {
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
  return readOnly ? (0, shared.getConfig)({ create: false }).authToken : getAuthToken();
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
  // Applies to explicit and interactive update entry points before any command or repair.
  try { guardUpdate({ platform }); } catch (error) { markCommandFailed(); throw error; }
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
    'Usage: telepty allow [--id <session_id>] [--idle-ttl <duration|off>] [--auto-restart] [--input-policy <user-supervised|guarded>] <command> [args...]',
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
  const { readOnlyAuth = false, ...requestOptions } = options;
  const headers = Object.fromEntries(new Headers(requestOptions.headers).entries());
  headers['x-telepty-token'] = resolveTargetToken(url, { readOnly: readOnlyAuth });
  delete headers['x-telepty-session-token'];
  // #43 P2 — present the per-session verified-sender token (minted at register, carried in the
  // parent-hijack-protected env beside TELEPTY_SESSION_ID) so the daemon can map token→sid and
  // record verified_sender_sid. Header only, never the body. Absent for operator/human shells.
  const sessionToken = scopedSessionToken(url, { localOrigin: shared.localOrigin || `http://127.0.0.1:${shared.PORT || 3848}` });
  if (sessionToken) headers['x-telepty-session-token'] = sessionToken;
  // Wrapped here rather than at the 45 call sites: every one of them either prints `e.message`
  // or swallows the throw, so this is the single place the origin can be attached without
  // changing what any caller does with the error.
  return fetch(url, { ...requestOptions, headers, redirect: 'error' }).catch((error) => { throw namedTransportError(url, error); });
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

    // Task 1215: --input-policy <user-supervised|guarded>. Only a host launch may request
    // user-supervised; a nested launch (inside an existing telepty session) is refused here and,
    // independently, by the daemon. Requesting is not granting: the daemon binds it, or not.
    let inputPolicy = null;
    const inputPolicyIndex = allowArgs.indexOf('--input-policy');
    if (inputPolicyIndex !== -1) {
      inputPolicy = allowArgs[inputPolicyIndex + 1];
      if (inputPolicy !== 'user-supervised' && inputPolicy !== 'guarded') {
        console.error('❌ Usage: telepty allow --input-policy <user-supervised|guarded> ...');
        exit(1);
      }
      if (inputPolicy === 'user-supervised' && (process.env.TELEPTY_SESSION_ID || process.env.TELEPTY_SESSION_TOKEN)) {
        console.error('❌ --input-policy user-supervised is only for a host launch, not from inside a telepty session.');
        exit(1);
      }
      allowArgs.splice(inputPolicyIndex, 2);
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
    delete process.env.TELEPTY_SESSION_CREDENTIAL_PATH;
    delete process.env.TELEPTY_SESSION_CREDENTIAL_INSTANCE;
    delete process.env.TELEPTY_SESSION_TOKEN;
    delete process.env.TELEPTY_SESSION_ORIGIN;
    // #47 P4 — same parent-hijack defense for the per-session provenance nonce: drop any inherited
    // value so a parent cannot pre-seed a known nonce, then carry the daemon-minted one (below).
    delete process.env.TELEPTY_SESSION_NONCE;
    return { sessionId, command, cmdArgs, idleTtl, autoRestart, ...(inputPolicy ? { inputPolicy } : {}) };
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
    function canWrite(child) { return !shared.handoffPending && canDeliver(child); }
    function canDeliver(child) {
      return !isClosed() && child === shared.child;
    }

    // #136/#137 (task 1215) — bridge-local readiness, bounded visible wait and stage receipts.
    // The VT grid is fed the actual child output (observePromptReady) and read only from the 500 ms
    // tick while something is pending; a complete idle frame reuses the relay's onReady route.
    // Records are indexed in memory (ids, age, pair) so the tick never re-reads queue history.
    const READY_SETTLE_MS = positiveInt(process.env.TELEPTY_BRIDGE_READY_SETTLE_MS, 750);
    const STALL_MS = positiveInt(process.env.TELEPTY_BRIDGE_STALL_MS, 15000);
    const VT_READY_ENABLED = process.env.TELEPTY_BRIDGE_VT_READY !== '0';
    const QUEUE_REPORT_MIN_MS = 1000;
    const RECORD_INDEX_MAX = 4096;
    const UNWRITTEN_MAX = 256;
    const bridgeRecords = new Map(); // msg_id -> { meta, createdMs, isCr, state, withheld }
    const unwrittenBodies = new Set(); // daemon_msg_id of bodies quarantined before any write
    // Task 1215 F5: id-less CR adjacency. Set when a body is quarantined unwritten; cleared by any
    // bridge write to the child. A local keystroke after it also breaks adjacency (user input is
    // never routed through here, so ordinary terminal typing is never blocked).
    let unwrittenBodyAdjacentAt = null;
    // Task 1215 F2: child sequence for spawn-readiness milestones; the subscribed child is the one
    // whose output/exit handlers are attached.
    let childSeq = 0;
    let subscribedChild = null;
    let relayOnReady = null;
    let bridgeScreen = null;
    let bridgeGeometry = null;
    let vtStatus = null;
    let lastOutputAt = null;
    let readySource = null;
    let stallReason = null;
    let receiptSeq = 0;
    let lastQueueAt = -Infinity;
    let lastQueueKey = null;
    let vtSkippedOutput = false;

    // Task 1215: user-supervised = requested at launch AND confirmed by the daemon for the current
    // owner generation (cli.js owner_token). Admission is then the live child/owner transport and
    // the user's own typing quiet only: no tail, VT, busy/modal or glyph classifier is consulted.
    function supervised() { return shared.inputPolicy === 'user-supervised' && !shared.sshPlan; }

    function sendBridgeFrame(raw) {
      if (!raw || isClosed() || !shared.wsReady || shared.daemonWs?.readyState !== 1) return false;
      try { shared.daemonWs.send(raw); return true; } catch { return false; }
    }
    function sendReceipt(msgId, meta, stage, certainty, reason = null) {
      return sendBridgeFrame(bridgeStage.receiptFrame({ meta: meta || {}, bridgeMsgId: msgId, stage, reason, certainty,
        bridgeSeq: ++receiptSeq, atMs: now(), ownerGeneration: shared.interactionBinding?.owner_generation ?? null }));
    }
    function rememberRecord(msgId, meta, isCr) {
      if (bridgeRecords.size >= RECORD_INDEX_MAX) bridgeRecords.delete(bridgeRecords.keys().next().value);
      bridgeRecords.set(msgId, { meta, createdMs: now(), isCr, state: 'pending', withheld: null });
    }
    function rememberUnwritten(daemonMsgId) {
      if (!daemonMsgId) return;
      unwrittenBodies.add(daemonMsgId);
      if (unwrittenBodies.size > UNWRITTEN_MAX) unwrittenBodies.delete(unwrittenBodies.values().next().value);
    }
    // Dead-letter one record with its payload (never ack it) and say so on the owner socket.
    // Returns true when moved, false when it was no longer withdrawable, null when the mailbox threw.
    function quarantine(msgId, reason, certainty, { inFlight = false, deliveryUncertain = false } = {}) {
      const record = bridgeRecords.get(msgId);
      const meta = record ? record.meta : {};
      let moved;
      try { moved = shared.bridgeMailbox.withdraw(shared.bridgeTarget, msgId, reason, { inFlight, deliveryUncertain, meta }); }
      catch { return null; }
      if (record) { record.state = moved ? 'quarantined' : 'gone'; bridgeRecords.delete(msgId); }
      if (!moved) return false;
      if (record && !record.isCr) rememberUnwritten(meta.daemon_msg_id);
      if (record && !record.isCr && certainty === 'not_written') unwrittenBodyAdjacentAt = now();
      sendReceipt(msgId, meta, 'quarantined', certainty, reason);
      return true;
    }

    function markVtUnavailable(reason) {
      vtStatus = `unavailable:${/^[a-z0-9_]{1,48}$/i.test(String(reason)) ? reason : 'unknown'}`;
      try { bridgeScreen?.dispose(); } catch {}
      bridgeScreen = null;
    }
    function resetBridgeScreen() {
      try { bridgeScreen?.dispose(); } catch {}
      bridgeScreen = null; vtStatus = null; lastOutputAt = null; vtSkippedOutput = false;
    }
    function noteBridgeOutput(data) {
      lastOutputAt = now();
      // Supervised: the grid is not fed. If the session later falls back to guarded, this child's
      // grid could only start mid-stream, so VT readiness is unavailable for it (fails closed and
      // says so) until a new child gives a new stream origin.
      if (supervised()) { vtSkippedOutput = true; return; }
      if (!shared.knownAiCli || shared.sshPlan || !VT_READY_ENABLED || bridgeScreenUnavailable()) return;
      if (!bridgeScreen && vtSkippedOutput) { markVtUnavailable('mid_stream_after_supervision'); return; }
      try {
        if (!bridgeScreen) {
          const out = getStdout();
          const geometry = bridgeGeometry || { cols: out.columns || 80, rows: out.rows || 30 };
          bridgeScreen = new (require('../vt/session-screen').SessionScreen)({ sessionId: String(shared.sessionId || 'bridge'),
            cause: 'stream_origin', localSource: true, geometrySource: 'local_pty', cols: geometry.cols, rows: geometry.rows });
          const probe = bridgeScreen.readFrameSync();
          if (probe.observation_basis === 'unavailable') { markVtUnavailable(probe.degraded_reasons[0] || 'unavailable'); return; }
          vtStatus = 'available';
        }
        bridgeScreen.noteOutput(typeof data === 'string' ? data : String(data));
      } catch { markVtUnavailable('vt_error'); }
    }
    function bridgeScreenUnavailable() { return typeof vtStatus === 'string' && vtStatus.startsWith('unavailable:'); }
    function noteBridgeGeometry(cols, rows) {
      if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
      bridgeGeometry = { cols, rows };
      try { bridgeScreen?.noteGeometry({ cols, rows, source: 'local_pty' }); } catch { markVtUnavailable('vt_error'); }
    }
    function unobservedReason() { return shared.firstReadyObserved ? 'ready_unobserved' : 'first_ready_unobserved'; }
    // null = the VT gate does not apply (unknown CLI, SSH child, kill switch); then only the
    // existing tail/prompt detector can make the session ready, exactly as before.
    function frameVerdict() {
      if (supervised() || !shared.knownAiCli || shared.sshPlan || !VT_READY_ENABLED) return null;
      if (bridgeScreenUnavailable()) return { ready: false, reason: 'vt_unavailable' };
      if (!bridgeScreen) return { ready: false, reason: unobservedReason() };
      let frame;
      try { frame = bridgeScreen.readFrameSync(); } catch { markVtUnavailable('vt_error'); return { ready: false, reason: 'vt_unavailable' }; }
      if (frame.observation_basis === 'unavailable') { markVtUnavailable(frame.degraded_reasons[0] || 'unavailable'); return { ready: false, reason: 'vt_unavailable' }; }
      const hit = shared.readyRegistry.detectFrame(shared.command, frame);
      if (hit.found) return { ready: true, detector: hit.reason || 'registry_match' };
      if (hit.reason === 'busy_indicator' || hit.reason === 'modal_ui') return { ready: false, reason: hit.reason };
      return { ready: false, reason: unobservedReason() };
    }
    function userInputRecent() { return now() - shared.lastUserInputTime <= shared.IDLE_THRESHOLD; }
    function withholdReason() {
      if (shared.handoffPending) return 'handoff_pending';
      // Task 1215 F6: the reason is read from actual state, never a fixed label.
      if (supervised()) {
        if (userInputRecent()) return 'user_input_recent';
        if (isClosed()) return 'session_closed';
        if (!shared.child || !canWrite(shared.child)) return 'child_unavailable';
        if (!shared.wsReady || shared.daemonWs?.readyState !== 1) return 'owner_transport_unavailable';
        return 'delivery_pending';
      }
      const verdict = frameVerdict();
      if (verdict && !verdict.ready) return verdict.reason;
      if ((verdict || shared.promptReady) && userInputRecent()) return 'user_input_recent';
      return unobservedReason();
    }
    // Called only from the tick while records are pending. Fails closed on every gate.
    function probeFrameReady() {
      if (!relayOnReady || shared.handoffPending || lastOutputAt === null || now() - lastOutputAt < READY_SETTLE_MS) return false;
      if (userInputRecent()) return false;
      const verdict = frameVerdict();
      if (!verdict || !verdict.ready) return false;
      shared.readyQualification = { ready_kind: 'composer_surface_observed', detector: `vt_frame:${verdict.detector}`,
        cli_key: shared.readyRegistry.commandKey(shared.command) };
      readySource = 'vt_frame';
      relayOnReady();
      return true;
    }
    // TTL and stall visibility for pending records. Never writes.
    function maintainPendingRecords() {
      const ttlMs = (0, shared.bridgeInjectTtlSecs)(process.env) * 1000;
      const pending = [...bridgeRecords.entries()].filter(([, record]) => record.state === 'pending');
      let reason = null;
      for (let i = 0; i < pending.length; i++) {
        const [msgId, record] = pending[i];
        if (record.state !== 'pending') continue;
        const age = now() - record.createdMs;
        if (age > ttlMs) {
          if (quarantine(msgId, 'expired_unwritten', 'not_written')) {
            shared.bridgePendingCount = Math.max(0, shared.bridgePendingCount - 1);
            if (!record.isCr) withdrawPairedSubmits(record, pending, i);
          }
          continue;
        }
        if (age >= STALL_MS) {
          reason = reason || withholdReason();
          if (record.withheld !== reason) { record.withheld = reason; sendReceipt(msgId, record.meta, 'withheld', 'not_written', reason); }
        }
      }
      stallReason = reason;
    }
    // A submit CR must never outlive the body it submits. Legacy records (no daemon ids) pair by
    // adjacency: only the CR queued directly behind the body.
    function withdrawPairedSubmits(body, pending, index) {
      const bodyId = body.meta.daemon_msg_id;
      for (let j = index + 1; j < pending.length; j++) {
        const [crId, cr] = pending[j];
        const paired = cr.state === 'pending' && cr.isCr && (bodyId ? cr.meta.pair === bodyId : !cr.meta.pair);
        if (paired && quarantine(crId, 'pair_unwritten', 'not_written')) {
          shared.bridgePendingCount = Math.max(0, shared.bridgePendingCount - 1);
        }
        if (!bodyId) break;
      }
    }
    function vtLabel() {
      if (supervised() || !shared.knownAiCli || shared.sshPlan) return 'not_applicable';
      if (!VT_READY_ENABLED) return 'disabled';
      return vtStatus || 'awaiting_output';
    }
    function bridgeQueueSummary() {
      let pending = 0;
      let oldest = null;
      for (const record of bridgeRecords.values()) {
        if (record.state !== 'pending') continue;
        pending++;
        if (oldest === null || record.createdMs < oldest) oldest = record.createdMs;
      }
      const age = oldest === null ? null : Math.max(0, Math.floor(now() - oldest));
      const phase = deliveryTimers.size ? 'draining' : pending === 0 ? 'open' : age >= STALL_MS ? 'stalled' : 'waiting';
      const identity = shared.bridgeIdentity || {};
      return { type: 'bridge_queue', schema: bridgeStage.SCHEMA, pending, in_flight: deliveryTimers.size, oldest_age_ms: age, phase,
        reason: phase === 'stalled' ? stallReason : null, first_ready_observed: !!shared.firstReadyObserved, ready_source: readySource,
        vt: vtLabel(), input_policy: supervised() ? 'user-supervised' : 'guarded',
        bridge_version: identity.bridge_version ?? null, bridge_code_digest: identity.bridge_code_digest ?? null,
        owner_generation: shared.interactionBinding?.owner_generation ?? null };
    }
    // At most one bridge_queue frame per second, sent on change; a change inside the window is
    // re-evaluated on the next tick. `force` re-announces an unchanged summary (owner bound).
    function reportBridgeQueue(force = false) {
      if (isClosed()) return false;
      const summary = bridgeQueueSummary();
      const { oldest_age_ms: _age, ...stable } = summary;
      const key = JSON.stringify(stable);
      if (force) lastQueueKey = null;
      if (key === lastQueueKey || now() - lastQueueAt < QUEUE_REPORT_MIN_MS) return false;
      if (!sendBridgeFrame(JSON.stringify(summary))) return false;
      lastQueueAt = now();
      lastQueueKey = key;
      return true;
    }
    function bridgeTick() {
      if (isClosed()) return;
      maintainPendingRecords();
      if (isClosed()) return;
      if (shared.bridgePendingCount > 0) {
        if (isIdle()) flushBridgeMailbox();
        else if (!supervised()) probeFrameReady();
      }
      if (isClosed()) return;
      reportBridgeQueue();
      let pending = false;
      for (const record of bridgeRecords.values()) if (record.state === 'pending') { pending = true; break; }
      if (!pending && shared.bridgePendingCount === 0 && shared.idleCheckTimer) {
        clearInterval(shared.idleCheckTimer);
        shared.idleCheckTimer = null;
      }
    }
    function armBridgeTick() {
      if (isClosed() || shared.handoffPending || shared.idleCheckTimer) return;
      // Poll every 500ms for idle state
      shared.idleCheckTimer = setInterval(bridgeTick, 500);
    }
    // Direct (unqueued) inject writes from the owner-frame handler. A submit whose body was
    // quarantined unwritten is refused instead of becoming a lone CR — named by `pair`, or, for an
    // id-less CR (old daemon, terminal-level submit), by adjacency: the latest bridge record event
    // was that unwritten body and nothing was written or typed since (task 1215 F5).
    function idlessCrAdjacentToUnwritten() {
      return unwrittenBodyAdjacentAt !== null && !(shared.lastUserInputTime > unwrittenBodyAdjacentAt);
    }
    function writeDirectInject(text, meta) {
      const child = shared.child;
      if (!canWrite(child)) return false;
      const ids = bridgeStage.frameMeta(meta);
      if (text === '\r' && (ids.pair ? unwrittenBodies.has(ids.pair) : idlessCrAdjacentToUnwritten())) {
        sendReceipt(null, ids, 'refused', 'not_written', 'pair_unwritten');
        return false;
      }
      child.write(text);
      unwrittenBodyAdjacentAt = null;
      sendReceipt(null, ids, 'pty_written', 'written');
      return true;
    }

    // Task 1215 F4 — THE owner-WS inject handler (cli.js calls this; tests call this). Keeps text
    // and CR as sent, queues behind pending records, and routes every direct write through
    // writeDirectInject. Returns what cli.js needs for its own closure state.
    function handleOwnerInject(msg) {
      invalidateBridgeInteraction('automated_input');
      const rawData = typeof msg.data === 'string' ? msg.data : String(msg.data ?? '');
      // #137: the daemon ids of this frame travel with the queued record (receipts only).
      const meta = {};
      for (const key of ['daemon_msg_id', 'inject_id', 'part', 'pair', 'owner_generation']) {
        if (msg[key] !== undefined) meta[key] = msg[key];
      }
      let textWritten = false;
      if (!rawData) return { rawData, textWritten };
      const isCr = rawData === '\r';
      if (isCr && shared.bridgePendingCount > 0) {
        // CR with pending queued text — queue CR too and wait for the same gate as the text.
        enqueueBridgeMessage(rawData, meta);
        if (isIdle()) {
          if (shared.queueFlushTimer) { clearTimeout(shared.queueFlushTimer); shared.queueFlushTimer = null; }
          flushBridgeMailbox();
        } else {
          scheduleIdleFlush();
        }
      } else if (isCr) {
        // CR is never idle-gated, but never for a body that was quarantined unwritten (#136, F5).
        writeDirectInject(rawData, meta);
      } else if (isIdle()) {
        if (writeDirectInject(rawData, meta)) { shared.promptReady = false; textWritten = true; }
      } else {
        enqueueBridgeMessage(rawData, meta);
        scheduleIdleFlush();
      }
      return { rawData, textWritten };
    }

    // Task 1215 F2 — spawn-readiness milestones for the CURRENT child and owner generation, for
    // every role: process_started (node-pty returned this child; exec unverified) and
    // input_transport_ready (its output/exit subscription is attached and this owner's inject loop
    // is live). Needs the daemon-issued readiness nonce; a legacy daemon sends none and nothing is
    // announced. No screen, model, glyph or prompt text is consulted.
    function announceTransportReady() {
      const child = shared.child;
      if (isClosed() || shared.handoffPending || !child || child !== subscribedChild || !canDeliver(child)) return false;
      const base = { sessionId: shared.sessionId, binding: shared.interactionBinding, nonce: shared.readinessNonce, childSeq };
      const started = readinessHandshake.milestoneFrame('process_started', { ...base, pid: child.pid });
      const ready = readinessHandshake.milestoneFrame('input_transport_ready', base);
      if (!started || !ready) return false;
      return sendBridgeFrame(started) && sendBridgeFrame(ready);
    }

    function updateDaemonProcessMetadata() {
      const body = {
        session_id: shared.sessionId,
        command: shared.command,
        ...(shared.sshPlan ? { ssh_remote: shared.sshPlan.metadata } : {}),
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

    function createOutputRelay({ onInteraction, onBytes, rewrite, write, sendOutput, observeReady, onReady }) {
      relayOnReady = onReady; // #136: the VT probe reuses this exact ready route
      return data => {
        onInteraction();
        onBytes(data.length);
        write(rewrite(data));
        sendOutput(data);
        if (observeReady(data)) onReady();
      };
    }

    // Fence retained callbacks before they can touch any shared successor state.
    function subscribeChild(child, onData, onExit) {
      let exited = false;
      const current = () => !exited && canDeliver(child);
      child.onData(data => { if (current()) onData(data); });
      child.onExit(event => {
        if (subscribedChild === child) subscribedChild = null;
        if (!current()) return;
        exited = true;
        onExit(event);
      });
      subscribedChild = child;
    }

    function spawnChild() {
      if (isClosed()) return null;
      // Windows: walk %PATHEXT% so bare names (`claude`, `codex`, `gemini`)
      // resolve to their npm-global `.cmd`/`.ps1` shims. POSIX: no-op. (#25)
      const target = buildPtySpawnTarget(shared.command, shared.cmdArgs, shared.sessionEnv);
      // #136: a new child is a new stream origin for the bridge VT grid.
      resetBridgeScreen();
      bridgeGeometry = { cols: getStdout().columns || 80, rows: getStdout().rows || 30 };
      // #26 (Snyk waiver, accepted-by-design): spawning the operator/user-chosen CLI IS the
      // `telepty allow` feature — `command` comes from the local CLI invocation, not an
      // untrusted boundary, so this is not an exploitable injection. Pre-existing baseline
      // finding; not fixable without removing `telepty allow`.
      shared.child = spawnPty(target.file, target.args, {
        name: 'xterm-256color',
        cols: bridgeGeometry.cols,
        rows: bridgeGeometry.rows,
        cwd: shared.sessionCwd,
        env: shared.sshPlan ? require('../ssh-session').sshChildEnvironment(shared.sessionEnv) : shared.sessionEnv
      });
      childSeq++;   // Task 1215 F2: a new child is a new readiness sequence
      if (shared.onChildSpawn) (0, shared.onChildSpawn)(shared.child);
      shared.resetInteractionProvider?.(shared.child);
      shared.sessionStartTime = now();
      updateDaemonProcessMetadata();
      return shared.child;
    }

    // #137: `meta` is the daemon ids of the inject frame (daemon_msg_id, inject_id, part, pair,
    // owner_generation). It is indexed with the record for receipts; it is not a payload field.
    function enqueueBridgeMessage(text, meta) {
      if (isClosed() || shared.handoffPending) return;
      const child = shared.child;
      const msgId = `${shared.sessionId}:${now()}:${++shared.bridgeMsgSeq}`;
      const ids = bridgeStage.frameMeta(meta);
      try {
        shared.bridgeMailbox.enqueue({
          msg_id: msgId, from: 'daemon', to: shared.bridgeTarget,
          payload: text, created_at: Math.floor(now() / 1000), attempt: 0,
        });
      } catch (err) {
        // Fallback: write directly if mailbox fails
        if (!canWrite(child)) return;
        console.error(`[BRIDGE] Mailbox enqueue failed, writing directly: ${err.message}`);
        invalidateBridgeInteraction('automated_input');
        if (!canWrite(child)) return;
        child.write(text);
        unwrittenBodyAdjacentAt = null;
        sendReceipt(msgId, ids, 'pty_written', 'written', 'mailbox_unavailable');
        return;
      }
      rememberRecord(msgId, ids, text === '\r');
      if (!canWrite(child)) return;
      shared.bridgePendingCount++;
      sendReceipt(msgId, ids, 'queued', 'not_written');
    }

    function isIdle() {
      if(shared.handoffPending)return false;
      if (supervised()) return now() - shared.lastUserInputTime > shared.IDLE_THRESHOLD;
      return shared.promptReady && (now() - shared.lastUserInputTime > shared.IDLE_THRESHOLD);
    }

    function observePromptReady(data) {
      noteBridgeOutput(data);
      if (supervised()) return false; // no screen/tail classifier for a supervised owner
      if (shared.knownAiCli) {
        shared.outputTail = (shared.outputTail + data).slice(-20000);
        const hit = shared.readyRegistry.detectOutput(shared.command, shared.outputTail);
        if (!hit.found) return false;
        shared.readyQualification = {
          ready_kind: 'composer_surface_observed',
          detector: hit.reason || 'registry_match',
          cli_key: shared.readyRegistry.commandKey(shared.command),
        };
        readySource = 'tail';
        return true;
      }
      if (!shared.promptPattern.test(data)) return false;
      shared.readyQualification = {
        ready_kind: 'prompt_suffix_observed',
        detector: 'generic_prompt_suffix',
        cli_key: null,
      };
      readySource = 'tail';
      return true;
    }

    function flushBridgeMailbox() {
      if (isClosed() || shared.handoffPending) return;
      const child = shared.child;
      if (shared.queueFlushTimer) { clearTimeout(shared.queueFlushTimer); shared.queueFlushTimer = null; }
      if (shared.idleCheckTimer) { clearInterval(shared.idleCheckTimer); shared.idleCheckTimer = null; }
      if (shared.bridgePendingCount === 0) return;
      let delay = 0;
      const batch = [];
      // Dequeue all pending messages
      while (true) {
        if (!canWrite(child)) return;
        const msg = shared.bridgeMailbox.dequeue(shared.bridgeTarget);
        if (!canWrite(child)) return;
        if (!msg) break;
        batch.push(msg);
        const record = bridgeRecords.get(msg.msg_id);
        if (record) record.state = 'in_flight';
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
        if (!canWrite(child)) return;
        // #136 F4: a dropped inject was never written. Dead-letter it with its payload; an ack
        // here would relabel "never written" as delivered.
        quarantine(msg.msg_id, reason === 'duplicate' ? 'bridge_duplicate' : 'expired_unwritten', 'not_written', { inFlight: true });
        console.warn(`\x1b[33m[BRIDGE] dropped ${reason} inject ${msg.msg_id} (age=${nowSecs - msg.created_at}s)\x1b[0m`);
      }
      const delivering = new Set(deliver);
      const droppedIds = new Set(dropped.map(({ msg }) => msg.msg_id));
      let previous = null;
      for (const msg of batch) {
        const before = previous;
        previous = msg;
        if (!delivering.has(msg)) continue;
        if (!canWrite(child)) return;
        const text = msg.payload;
        const msgId = msg.msg_id;
        const meta = bridgeRecords.get(msgId)?.meta || {};
        // A submit whose body was dropped or quarantined unwritten is never written alone.
        if (text === '\r' && (meta.pair ? unwrittenBodies.has(meta.pair)
          : !!before && before.payload !== '\r' && droppedIds.has(before.msg_id))) {
          quarantine(msgId, 'pair_unwritten', 'not_written', { inFlight: true });
          continue;
        }
        const timer = setTimeout(() => {
          deliveryTimers.delete(timer);
          if (!canWrite(child)) return;
          invalidateBridgeInteraction('automated_input');
          if (!canWrite(child)) return;
          try { child.write(text); }
          catch (error) {
            const record = bridgeRecords.get(msgId);
            if (record) record.state = 'unknown';
            sendReceipt(msgId, meta, 'unknown', 'unknown', 'write_threw');
            throw error;
          }
          bridgeRecords.delete(msgId);
          unwrittenBodyAdjacentAt = null;
          // PTY master write only; never consumption, turn acceptance or completion.
          sendReceipt(msgId, meta, 'pty_written', 'written');
          if (!canWrite(child)) return;
          try { shared.bridgeMailbox.ack(shared.bridgeTarget, msgId); } catch {}
        }, delay);
        deliveryTimers.add(timer);
        delay += text === '\r' ? 0 : 100;
      }
      if (!canWrite(child)) return;
      shared.bridgePendingCount = Math.max(0, shared.bridgePendingCount - batch.length);
      shared.promptReady = false;
    }

    function scheduleIdleFlush() {
      if (isClosed() || shared.handoffPending || shared.idleCheckTimer) return;
      armBridgeTick();
      // Safety fallback is compatibility-only and never applies to a known AI CLI: before first
      // ready it would be a blind first write, and after it the same timer ignored busy/modal
      // frames (#136). Known CLIs are drained only by an observed ready (tail or VT frame).
      if (!shared.knownAiCli && !shared.queueFlushTimer) {
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

    // #136: exit keeps custody. Every record still pending or in flight is dead-lettered with its
    // payload (dead-letter.jsonl is never purged) before the live queue files are cleared. A record
    // this bridge still holds unwritten is not_written; anything else in flight is unknown.
    function quarantineAtExit() {
      let rows;
      try { rows = shared.bridgeMailbox.peek(shared.bridgeTarget).filter(m => m.state === 'pending' || m.state === 'in_flight'); }
      catch { return false; }
      let complete = true;
      for (const row of rows) {
        const known = row.state === 'pending' || bridgeRecords.get(row.msg_id)?.state === 'in_flight';
        const moved = quarantine(row.msg_id, known ? 'bridge_exit_unwritten' : 'bridge_exit_in_flight_unknown',
          known ? 'not_written' : 'unknown', { inFlight: row.state === 'in_flight', deliveryUncertain: !known });
        if (moved !== true) complete = false;
      }
      return complete;
    }

    function closeAllowSession({ destroySession = true } = {}) {
      if (closed) return false;
      const custodyKept = destroySession ? quarantineAtExit() : false;
      closed = true;
      shared.allowSessionClosed = true;
      shared.credentialChannel?.close();
      shared.disposeInteractionProvider?.();
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
      try { bridgeScreen?.dispose(); } catch {}
      bridgeScreen = null;
      (0, shared.cleanupTerminal)();
      // Clear the live queue files on clean exit only once every undelivered record is in dead
      // letter with its payload (#136); a record that could not be moved keeps the queue intact.
      if (destroySession && custodyKept) {
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

    // #136 F4: records left by a PREVIOUS bridge process are never replayed. Pending ones were
    // not written; in-flight ones have an unknown write outcome. Both go to dead letter with their
    // payload. Records this context enqueued itself stay queued.
    function recoverBridgeMailbox() {
    if (isClosed()) return;
    try {
      const leftover = shared.bridgeMailbox.peek(shared.bridgeTarget).filter(m => m.state === 'pending' || m.state === 'in_flight');
      let own = 0;
      let quarantined = 0;
      for (const m of leftover) {
        if (bridgeRecords.has(m.msg_id)) { if (m.state === 'pending') own++; continue; }
        const inFlight = m.state === 'in_flight';
        if (quarantine(m.msg_id, inFlight ? 'recovered_in_flight_unknown' : 'recovered_previous_bridge',
          inFlight ? 'unknown' : 'not_written', { inFlight, deliveryUncertain: inFlight }) === true) quarantined++;
      }
      shared.bridgePendingCount = own;
      if (quarantined > 0) {
        console.log(`\x1b[33m[BRIDGE] Quarantined ${quarantined} undelivered message(s) from a previous bridge (kept in dead letter; not replayed)\x1b[0m`);
      }
      if (own > 0) armBridgeTick();
    } catch {}
    }

function cooperativeQueueEmpty(){
      if(deliveryTimers.size || shared.bridgePendingCount || shared.queueFlushTimer)return false;
      try{return shared.bridgeMailbox.snapshotCustody(shared.bridgeTarget).length===0;}catch{return false;}
    }
return { cooperativeQueueEmpty, updateDaemonProcessMetadata, createOutputRelay, subscribeChild, spawnChild, enqueueBridgeMessage, isIdle, observePromptReady, flushBridgeMailbox, scheduleIdleFlush, invalidateBridgeInteraction, closeAllowSession, createBridgeMailbox, recoverBridgeMailbox,
  noteBridgeGeometry, writeDirectInject, bridgeQueueSummary, reportBridgeQueue, handleOwnerInject, announceTransportReady };
}

module.exports = { createCliSecurityActions, createAllowSecurityContext, adoptRegistrationCredential, scopedSessionToken, credentialOrigin };
