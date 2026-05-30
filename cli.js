#!/usr/bin/env node

const path = require('path');
const os = require('os');
const fs = require('fs');
const { constants: osConstants } = require('os');
const WebSocket = require('ws');
const { execSync, execFileSync, spawn } = require('child_process');
const readline = require('readline');
const prompts = require('prompts');
const updateNotifier = require('update-notifier');
const pkg = require('./package.json');
const { getConfig } = require('./auth');
const { cleanupDaemonProcesses } = require('./daemon-control');
const { attachInteractiveTerminal, getTerminalSize, restoreTerminalModes } = require('./interactive-terminal');
const { getRuntimeInfo } = require('./runtime-info');
const { formatHostLabel, groupSessionsByHost, pickSessionTarget } = require('./session-routing');
const { buildSharedContextPrompt, createSharedContextDescriptor, ensureSharedContextFile } = require('./shared-context');
const { runInteractiveSkillInstaller } = require('./skill-installer');
const { resolveWindowsExecutable } = require('./src/win-resolve-executable');
const { decideVersionAction } = require('./src/version-handshake');
const crossMachine = require('./cross-machine');
const { parseHostSpec, buildDaemonUrl, buildDaemonWsUrl } = require('./host-spec');
const { FileMailbox } = require('./src/mailbox/index');
const readyRegistry = require('./src/prompt-symbol-registry');
const lifecycle = require('./src/lifecycle');
const args = process.argv.slice(2);
let pendingTerminalInputError = null;
let simulatedPromptErrorInjected = false;

function isRecoverableTerminalInputError(error) {
  return Boolean(error && (error.code === 'EIO' || error.syscall === 'read'));
}

function rememberTerminalInputError(error) {
  pendingTerminalInputError = error;
}

function consumeTerminalInputError() {
  if (!pendingTerminalInputError) {
    return null;
  }

  const error = pendingTerminalInputError;
  pendingTerminalInputError = null;
  return error;
}

function resetInteractiveInput(stream = process.stdin) {
  if (!stream) {
    return;
  }

  if (stream.isTTY && (stream.isRaw || stream.__teleptyRawModeActive)) {
    restoreTerminalModes(process.stdout);
  }

  if (stream.isTTY && typeof stream.setRawMode === 'function') {
    try {
      stream.setRawMode(false);
      stream.__teleptyRawModeActive = false;
    } catch {
      // Ignore raw-mode reset failures when the TTY is already gone.
    }
  }

  if (typeof stream.pause === 'function') {
    stream.pause();
  }

  if (typeof stream.resume === 'function') {
    stream.resume();
  }
}

function handleTerminalInputError(error, options = {}) {
  if (!isRecoverableTerminalInputError(error)) {
    return false;
  }

  rememberTerminalInputError(error);
  resetInteractiveInput(options.stream);

  if (!options.silent) {
    process.stderr.write('\n\x1b[33m⚠️ Terminal input was interrupted. Returning to the telepty menu...\x1b[0m\n');
  }

  return true;
}

const originalCreateInterface = readline.createInterface.bind(readline);
readline.createInterface = function patchedCreateInterface(...interfaceArgs) {
  const rl = originalCreateInterface(...interfaceArgs);
  rl.on('error', (error) => {
    if (handleTerminalInputError(error, { stream: rl.input, silent: true })) {
      try {
        rl.close();
      } catch {
        // Ignore close failures after a TTY read error.
      }
      return;
    }

    process.stderr.write(`\n❌ Telepty terminal input error: ${error.message}\n`);
  });
  return rl;
};

process.stdin.on('error', (error) => {
  if (handleTerminalInputError(error, { stream: process.stdin, silent: true })) {
    return;
  }

  process.stderr.write(`\n❌ Telepty stdin error: ${error.message}\n`);
});

process.on('exit', () => {
  resetInteractiveInput(process.stdin);
});

// Check for updates unless explicitly disabled for tests/CI.
if (!process.env.NO_UPDATE_NOTIFIER && !process.env.TELEPTY_DISABLE_UPDATE_NOTIFIER) {
  updateNotifier({pkg}).notify({ isGlobal: true });
}

// Support remote host via environment variable or default to localhost.
// TELEPTY_HOST accepts: `host`, `host:port`, or `http://host:port`. Embedded
// port from TELEPTY_HOST is used unless TELEPTY_PORT is set explicitly.
const _explicitPort = process.env.TELEPTY_PORT ? Number(process.env.TELEPTY_PORT) : null;
const _hostSpec = parseHostSpec(process.env.TELEPTY_HOST, _explicitPort || 3848);
let REMOTE_HOST = _hostSpec.host;
const PORT = _explicitPort != null ? _explicitPort : _hostSpec.port;
let DAEMON_URL = buildDaemonUrl(REMOTE_HOST, PORT);
let WS_URL = buildDaemonWsUrl(REMOTE_HOST, PORT);

function daemonUrl(host) {
  if (host == null || host === '') return DAEMON_URL;
  return buildDaemonUrl(host, PORT);
}

function daemonWsUrl(host) {
  if (host == null || host === '') return WS_URL;
  return buildDaemonWsUrl(host, PORT);
}

let cachedAuthToken = null;

function getAuthToken() {
  if (cachedAuthToken == null) {
    cachedAuthToken = getConfig().authToken;
  }
  return cachedAuthToken;
}

const fetchWithAuth = (url, options = {}) => {
  const headers = { ...options.headers, 'x-telepty-token': getAuthToken() };
  return fetch(url, { ...options, headers });
};

function isSubmitForceDefaultEnabled(env = process.env) {
  const value = (env.TELEPTY_SUBMIT_FORCE_DEFAULT || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

async function getDaemonMeta(host = REMOTE_HOST) {
  try {
    const res = await fetchWithAuth(`${daemonUrl(host)}/api/meta`, {
      signal: AbortSignal.timeout(1500)
    });
    if (!res.ok) {
      return null;
    }
    return await res.json();
  } catch {
    return null;
  }
}

function detectTerminalProgram(env = process.env) {
  const rawTermProgram = typeof env.TERM_PROGRAM === 'string' ? env.TERM_PROGRAM.trim() : '';
  if (rawTermProgram) {
    return rawTermProgram;
  }

  if (env.TMUX) {
    return 'tmux';
  }

  const term = typeof env.TERM === 'string' ? env.TERM.toLowerCase() : '';
  if (term.includes('kitty')) return 'kitty';
  if (term.includes('ghostty')) return 'ghostty';
  if (term.includes('tmux')) return 'tmux';

  return null;
}

function formatSessionTerminal(session) {
  const terminal = session.terminal || session.termProgram || null;
  const term = session.term || null;
  if (terminal && term) {
    return `${terminal} (${term})`;
  }
  return terminal || term || 'unknown';
}

function formatSessionHealth(session) {
  const status = session.healthStatus || 'UNKNOWN';
  const reason = session.healthReason || null;
  if (reason && reason !== status) {
    return `${status} (${reason})`;
  }
  return status;
}

function enrichSessionIdle(session, nowMs = Date.now()) {
  const idleSeconds = typeof session.idleSeconds === 'number'
    ? session.idleSeconds
    : lifecycle.computeIdleSeconds(session.lastActivityAt, nowMs);
  return {
    ...session,
    idleSeconds,
    idle_seconds: idleSeconds
  };
}

function formatSessionStatusWithIdle(session) {
  const base = formatSessionHealth(session);
  const idleSeconds = typeof session.idleSeconds === 'number' ? session.idleSeconds : null;
  if (idleSeconds !== null && idleSeconds > 60) {
    return `${base} 💤 idle (${lifecycle.formatIdleDuration(idleSeconds)})`;
  }
  return base;
}

function formatApiError(data, fallback = 'Request failed.') {
  if (!data) {
    return fallback;
  }

  const code = data.code ? `[${data.code}] ` : '';
  const message = data.error || fallback;
  return `${code}${message}`;
}

function buildInjectRequestBody(prompt, options = {}) {
  const body = {
    prompt,
    no_enter: options.noEnter === true
  };

  if (options.fromId) body.from = options.fromId;
  if (options.replyTo) body.reply_to = options.replyTo;
  if (options.replyExpected) body.reply_expected = true;

  return body;
}

function buildSessionStateReportBody(options = {}) {
  const body = {
    phase: options.phase,
    source: options.source || 'self_report'
  };

  if (options.currentTask !== undefined) body.current_task = options.currentTask;
  if (options.blocker !== undefined) body.blocker = options.blocker;
  if (options.needsInput !== undefined) body.needs_input = options.needsInput;
  if (options.threadId !== undefined) body.thread_id = options.threadId;
  if (options.seq !== undefined) body.seq = options.seq;

  return body;
}

function splitSessionsByTransport(sessions) {
  const local = [];
  const remoteByPeer = new Map();

  for (const session of sessions) {
    if (!isRemoteSession(session)) {
      local.push(session);
      continue;
    }

    const peerName = session.peerName || session.host;
    if (!remoteByPeer.has(peerName)) {
      remoteByPeer.set(peerName, []);
    }
    remoteByPeer.get(peerName).push(session);
  }

  return { local, remoteByPeer };
}

function parseRefOption(argv) {
  const refIndex = argv.indexOf('--ref');
  if (refIndex === -1) {
    return { useRef: false, refFilePath: null };
  }

  argv.splice(refIndex, 1);
  const candidate = argv[refIndex];
  if (!candidate || candidate.startsWith('--')) {
    return { useRef: true, refFilePath: null };
  }

  try {
    if (fs.statSync(candidate).isFile()) {
      argv.splice(refIndex, 1);
      return { useRef: true, refFilePath: candidate };
    }
  } catch {
    // Fall through to inline ref mode when the candidate is not a readable file.
  }

  return { useRef: true, refFilePath: null };
}

function createSharedReferenceDescriptor(prompt, refFilePath) {
  if (refFilePath) {
    const fileContent = fs.readFileSync(refFilePath, 'utf8');
    return createSharedContextDescriptor(fileContent);
  }

  return createSharedContextDescriptor(prompt);
}

function buildSharedReferenceInjectPrompt(referencePath, message = '') {
  const basePrompt = buildSharedContextPrompt(referencePath);
  const normalizedMessage = String(message ?? '').trim();
  return normalizedMessage ? `${basePrompt} ${normalizedMessage}` : basePrompt;
}

function ensureLocalSharedReference(descriptor, message = '') {
  const reference = ensureSharedContextFile(descriptor);
  return {
    descriptor: reference,
    referencePath: reference.promptPath,
    prompt: buildSharedReferenceInjectPrompt(reference.promptPath, message)
  };
}

function ensureRemoteSharedReference(peerName, descriptor, message = '') {
  const result = crossMachine.remoteEnsureSharedContext(peerName, descriptor);
  if (!result.success) {
    throw new Error(result.error || `Failed to prepare shared context on ${peerName}`);
  }

  const referencePath = result.promptPath || descriptor.promptPath;
  return {
    descriptor,
    referencePath,
    prompt: buildSharedReferenceInjectPrompt(referencePath, message)
  };
}

function printSessionInfo(session, options = {}) {
  const host = options.host || session.host || '127.0.0.1';
  console.log('\x1b[1mSession Info:\x1b[0m');
  console.log(`  - ID: \x1b[36m${session.id}\x1b[0m`);
  console.log(`    Host: ${formatHostLabel(host)}`);
  console.log(`    Command: ${session.command}`);
  console.log(`    Type: ${session.type || 'unknown'}`);
  console.log(`    Status: ${formatSessionHealth(session)}`);
  console.log(`    Terminal: ${session.terminal || session.termProgram || 'unknown'}`);
  console.log(`    TERM: ${session.term || 'n/a'}`);
  console.log(`    CWD: ${session.cwd}`);
  console.log(`    Clients: ${session.active_clients ?? 0}`);
  if (session.createdAt) {
    console.log(`    Started: ${new Date(session.createdAt).toLocaleString()}`);
  }
  if (session.lastActivityAt) {
    console.log(`    Last Activity: ${new Date(session.lastActivityAt).toLocaleString()}`);
  }
  if (typeof session.idleSeconds === 'number') {
    console.log(`    Idle: ${session.idleSeconds}s`);
  }
  if (session.semantic && session.semantic.phase) {
    console.log(`    Phase: ${session.semantic.phase}`);
  }
  if (session.semantic && session.semantic.current_task) {
    console.log(`    Current Task: ${session.semantic.current_task}`);
  }
  if (session.semantic && session.semantic.blocker) {
    console.log(`    Blocker: ${session.semantic.blocker}`);
  }
  console.log('');
}

function resolveTeleptyEntryPoint() {
  // After npm upgrade, process.argv[1] still points to the OLD version's cli.js.
  // Resolve the current telepty binary from PATH, which npm updates on install.
  try {
    const cmd = process.platform === 'win32' ? 'where telepty' : 'which telepty';
    const binPath = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0];
    if (binPath && fs.existsSync(binPath)) {
      return fs.realpathSync(binPath);
    }
  } catch {}
  return process.argv[1];
}

function startDetachedDaemon() {
  const entryPoint = resolveTeleptyEntryPoint();
  const cp = spawn(process.argv[0], [entryPoint, 'daemon'], {
    detached: true,
    stdio: 'ignore'
  });
  cp.unref();
}

async function waitForDaemonHealth(maxMs = 5000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const meta = await getDaemonMeta('127.0.0.1');
      if (meta && meta.version) return meta;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

async function restartDaemonGraceful(options = {}) {
  const maxAttempts = options.maxAttempts || 3;
  const requiredCapabilities = options.requiredCapabilities || [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // (a) Kill existing daemon processes
    const results = cleanupDaemonProcesses();

    // (b) Wait up to 3s for old processes to fully exit
    if (results.stopped.length > 0) {
      const { isProcessRunning } = require('./daemon-control');
      const killDeadline = Date.now() + 3000;
      for (const item of results.stopped) {
        while (Date.now() < killDeadline && isProcessRunning(item.pid)) {
          await new Promise(r => setTimeout(r, 100));
        }
      }
    }

    // (c) Start new daemon
    startDetachedDaemon();

    // (d) Wait for new daemon to respond with correct version
    const meta = await waitForDaemonHealth(5000);
    if (meta && meta.version === pkg.version) {
      const hasCapabilities = requiredCapabilities.every(c => (meta.capabilities || []).includes(c));
      if (hasCapabilities || requiredCapabilities.length === 0) {
        return { success: true, meta, attempt };
      }
    }

    // Retry with backoff
    if (attempt < maxAttempts) {
      const backoff = 1000 * attempt;
      // stderr (not stdout): banner must not contaminate `telepty list --json` (task #400, telepty#15)
      process.stderr.write(`\x1b[33m⚠️ Daemon restart attempt ${attempt}/${maxAttempts} failed. Retrying in ${backoff / 1000}s...\x1b[0m\n`);
      await new Promise(r => setTimeout(r, backoff));
    }
  }

  console.error(`\x1b[31m❌ Daemon restart failed after ${maxAttempts} attempts. Run "telepty daemon" manually to start.\x1b[0m`);
  return { success: false, meta: null, attempt: maxAttempts };
}

function renderInteractiveHeader() {
  const runtimeInfo = getRuntimeInfo(__dirname);
  console.clear();
  console.log('\x1b[36m\x1b[1m⚡ Telepty Agent Manager\x1b[0m\n');
  console.log(`\x1b[90mVersion ${runtimeInfo.version}  Updated ${runtimeInfo.updatedAtLabel}\x1b[0m\n`);
}

async function promptWithRecovery(promptConfig) {
  if (process.env.TELEPTY_TEST_TRIGGER_PROMPT_EIO_ONCE === '1' && !simulatedPromptErrorInjected) {
    simulatedPromptErrorInjected = true;
    rememberTerminalInputError(Object.assign(new Error('simulated terminal EIO'), { code: 'EIO', syscall: 'read' }));
    console.log('\n\x1b[33m⚠️ Terminal input was interrupted. Returning to the telepty menu...\x1b[0m\n');
    return { __teleptyRetry: true };
  }

  const response = await prompts(promptConfig);
  const terminalError = consumeTerminalInputError();
  if (terminalError) {
    console.log('\n\x1b[33m⚠️ Terminal input was interrupted. Returning to the telepty menu...\x1b[0m\n');
    return { __teleptyRetry: true };
  }

  return response;
}

// #26: validate a filesystem-path CLI argument before it reaches fs.*. Rejects empty input
// and null-byte injection, then normalizes to a canonical absolute path (path.resolve folds
// out any `..` traversal segments). telepty is a local CLI, so the path is operator-chosen and
// arbitrary locations are legitimate — this hardens against malformed/encoded traversal input
// rather than confining to a base directory.
function sanitizePathArg(input, label = 'path') {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0') || input.includes('..')) {
    throw new Error(`Invalid ${label} path argument`);
  }
  return path.resolve(input);
}

// #29: per-session backend classification, exposed for unit-testing. `env` and the kitty-socket
// probe are injected (findKittySocketCli is nested in main()), so a test can drive each branch
// without real env/sockets. Behavior matches the original inline ternary exactly.
function classifyBackend(env, findKitty) {
  if (env.TERM_PROGRAM === 'WarpTerminal') return 'warp';
  if (env.CMUX_WORKSPACE_ID) return 'cmux';
  return findKitty() ? 'kitty' : 'pty';
}

// #17 (OQ-2): decide whether a daemon WS 'close' is the daemon's explicit session-destroy
// (code 1000 'Session destroyed') — in which case the bridge must terminate, not reconnect.
// Pure predicate, exposed for unit-testing; `reason` may be a Buffer (ws) or string.
function isDaemonDestroyClose(code, reason) {
  const reasonText = reason ? reason.toString() : '';
  return code === 1000 && reasonText === 'Session destroyed';
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

async function repairLocalDaemon(options = {}) {
  if (process.env.TELEPTY_SKIP_DAEMON_REPAIR === '1') {
    return { stopped: 0, failed: 0, meta: null, skipped: true };
  }

  const restart = options.restart !== false;
  const results = cleanupDaemonProcesses();

  if (!restart) {
    return { stopped: results.stopped.length, failed: results.failed.length, meta: null };
  }

  const restartResult = await restartDaemonGraceful();
  return {
    stopped: results.stopped.length,
    failed: results.failed.length,
    meta: restartResult.meta,
    versionMatch: restartResult.success
  };
}

function getDiscoveryHosts() {
  const hosts = new Set();
  if (REMOTE_HOST && REMOTE_HOST !== '127.0.0.1') {
    hosts.add(REMOTE_HOST);
  } else {
    hosts.add('127.0.0.1');
  }
  return Array.from(hosts);
}

async function discoverSessions(options = {}) {
  await ensureDaemonRunning();
  const allSessions = [];

  if (!options.silent) {
    process.stdout.write('\x1b[36m🔍 Discovering active sessions across connected machines...\x1b[0m\n');
  }

  // Local daemon sessions
  try {
    const res = await fetchWithAuth(`${daemonUrl('127.0.0.1')}/api/sessions`, {
      signal: AbortSignal.timeout(1500)
    });
    if (res.ok) {
      const sessions = await res.json();
      sessions.forEach((session) => {
        allSessions.push({ host: '127.0.0.1', ...session });
      });
    }
  } catch {}

  // Remote peer sessions via SSH direct
  const remoteSessions = crossMachine.discoverAllRemoteSessions();
  allSessions.push(...remoteSessions);

  // Remote peer sessions via HTTP (no SSH)
  try {
    const httpSessions = await crossMachine.discoverHttpRemoteSessions();
    allSessions.push(...httpSessions);
  } catch {
    // HTTP peer discovery is best-effort.
  }

  return allSessions;
}

function isRemoteSession(session) {
  return session.remote === true || (session.host && session.host !== '127.0.0.1' && session.host.includes('@'));
}

async function resolveSessionTarget(sessionRef, options = {}) {
  const sessions = options.sessions || await discoverSessions({ silent: true });
  const target = pickSessionTarget(sessionRef, sessions, REMOTE_HOST);
  // When <id>@<peerName> uses an SSH peer alias (e.g. `winserver`) and the
  // session is not in `sessions` (discovery missed it, ControlMaster expired,
  // or remote has no such session), pickSessionTarget returns a synthetic
  // target with no peerName/remote flag. Detect SSH peer alias here so the
  // caller routes through cross-machine.remoteInject (SSH path) rather than
  // falling into the HTTP fetch path with `http://winserver:3848/...`. #411
  if (
    target &&
    !target.peerName &&
    target.host &&
    target.host !== '127.0.0.1' &&
    !target.host.includes(':') &&
    !target.host.includes('@')
  ) {
    const sshPeer = crossMachine.getSshPeerHandle(target.host);
    if (sshPeer) {
      target.peerName = target.host;
      target.remote = true;
    }
  }
  return target;
}

async function ensureDaemonRunning(options = {}) {
  if (REMOTE_HOST !== '127.0.0.1') return; // Only auto-start local daemon

  const requiredCapabilities = options.requiredCapabilities || [];

  try {
    const meta = await getDaemonMeta('127.0.0.1');
    const hasCapabilities = meta && requiredCapabilities.every((item) => meta.capabilities.includes(item));

    const sessionsRes = await fetchWithAuth(`${DAEMON_URL}/api/sessions`, {
      signal: AbortSignal.timeout(1500)
    });

    if (sessionsRes.ok && hasCapabilities) {
      // Delegate decision to pure-functional handshake so the policy is unit-testable
      // and consistent across CLI invocations.
      const decision = decideVersionAction({ daemonVersion: meta && meta.version, cliVersion: pkg.version });
      if (decision.action === 'restart') {
        // stderr (not stdout): banner must not contaminate `telepty list --json` (task #400, telepty#15)
        process.stderr.write(`\x1b[33m⚙️ Daemon version mismatch (running v${meta.version}, installed v${pkg.version}). Restarting...\x1b[0m\n`);
        await restartDaemonGraceful({ requiredCapabilities });
        return;
      }
      return;
    } else if (sessionsRes.ok && !meta) {
      process.stderr.write('\x1b[33m⚙️ Found an older local telepty daemon. Restarting it...\x1b[0m\n');
    } else if (sessionsRes.ok && meta) {
      process.stderr.write('\x1b[33m⚙️ Found a local telepty daemon without the required features. Restarting it...\x1b[0m\n');
    }
  } catch (e) {
    // Continue to auto-start below.
  }

  process.stderr.write('\x1b[33m⚙️ Auto-starting local telepty daemon...\x1b[0m\n');
  await restartDaemonGraceful({ requiredCapabilities });
}

async function manageInteractiveAttach(sessionId, targetHost) {
  const wsUrl = `${daemonWsUrl(targetHost)}/api/sessions/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(getAuthToken())}`;
  const ws = new WebSocket(wsUrl);
  let cleanupTerminal = null;
  return new Promise((resolve) => {
    ws.on('open', () => {
      // Set Ghostty tab title to show session ID
      process.stdout.write(`\x1b]0;⚡ telepty :: ${sessionId}\x07`);
      console.log(`\n\x1b[32mEntered room '${sessionId}'.\x1b[0m\n`);
      cleanupTerminal = attachInteractiveTerminal(process.stdin, process.stdout, {
        onData: (d) => ws.send(JSON.stringify({ type: 'input', data: d.toString() })),
        onResize: () => {
          const size = getTerminalSize(process.stdout, { cols: 80, rows: 30 });
          ws.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
        }
      });
    });
    ws.on('message', m => {
      const msg = JSON.parse(m);
      if (msg.type === 'output') process.stdout.write(msg.data);
    });
    ws.on('close', async () => {
      process.stdout.write(`\x1b]0;\x07`); // Restore default terminal title
      if (cleanupTerminal) cleanupTerminal();

      // Check if other clients are still attached before destroying
      try {
        const res = await fetchWithAuth(`${daemonUrl(targetHost)}/api/sessions`);
        if (res.ok) {
          const sessions = await res.json();
          const session = sessions.find(s => s.id === sessionId);
          if (session && session.active_clients > 0) {
            console.log(`\n\x1b[33mLeft room '${sessionId}'. Other clients still attached — session kept alive.\x1b[0m\n`);
          } else {
            console.log(`\n\x1b[33mLeft room '${sessionId}'. No other clients — destroying session.\x1b[0m\n`);
            await fetchWithAuth(`${daemonUrl(targetHost)}/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
          }
        }
      } catch(e) {
        // Daemon unreachable, nothing to clean up
      }

      resolve();
    });
  });
}

async function manageInteractive() {
  renderInteractiveHeader();

  while (true) {
    const response = await promptWithRecovery({
      type: 'select',
      name: 'action',
      message: 'What would you like to do?',
      choices: [
        { title: '🖥️   Enter a room (Attach to session)', value: 'attach' },
        { title: '➕  Create a new room (Spawn session)', value: 'spawn' },
        { title: '🔌  Allow inject (Run CLI with inject)', value: 'allow' },
        { title: '💬  Send message to a room (Inject command)', value: 'inject' },
        { title: '📋  View all open rooms (List sessions)', value: 'list' },
        { title: '🧹  Repair local daemon', value: 'repair-daemon' },
        { title: '🧠  Install telepty skills', value: 'install-skills' },
        { title: '🔄  Update telepty to latest version', value: 'update' },
        { title: '❌  Exit', value: 'exit' }
      ]
    });

    if (response.__teleptyRetry) {
      renderInteractiveHeader();
      continue;
    }

    if (response.action === 'update') {
      console.log('\n\x1b[36m🔄 Updating telepty to the latest version...\x1b[0m');
      try {
        runUpdateInstall();
        console.log('\n\x1b[32m✅ Update complete! Restarting daemon...\x1b[0m');
        const repairResult = await repairLocalDaemon({ restart: true });
        if (repairResult.skipped) {
          console.log('\x1b[36m↻ Refreshing telepty without daemon restart...\x1b[0m\n');
        } else {
          console.log('\x1b[36m↻ Returning to telepty...\x1b[0m\n');
        }
        renderInteractiveHeader();
      } catch (e) {
        console.error(`\n❌ Update failed: ${e.message}\n`);
      }
      continue;
    }

    if (!response.action || response.action === 'exit') {
      console.log('Goodbye!');
      process.exit(0);
    }

    if (response.action === 'daemon') {
      console.log('\n\x1b[33mStarting daemon in background...\x1b[0m');
      cleanupDaemonProcesses();
      startDetachedDaemon();
      console.log('✅ Daemon started.\n');
      continue;
    }

    if (response.action === 'repair-daemon') {
      console.log('\n\x1b[36m🧹 Repairing local telepty daemon...\x1b[0m');
      const result = await repairLocalDaemon({ restart: true });
      if (result.meta) {
        console.log(`✅ Local daemon is healthy. Version ${result.meta.version}, pid ${result.meta.pid}, stopped ${result.stopped} old daemon(s).\n`);
      } else {
        console.log(`⚠️ Daemon cleanup ran, but a fresh local daemon did not respond. Stopped ${result.stopped} old daemon(s).\n`);
      }
      continue;
    }

    if (response.action === 'install-skills') {
      try {
        await runInteractiveSkillInstaller({ packageRoot: __dirname, cwd: process.cwd() });
      } catch (e) {
        console.error(`\n❌ ${e.message}\n`);
      }
      continue;
    }

    if (response.action === 'list') {
      console.log('\n');
      const sessions = await discoverSessions();
      if (sessions.length === 0) {
        console.log('❌ No active sessions found.');
      } else {
        console.log('\x1b[1mAvailable Sessions:\x1b[0m');
        sessions.forEach(s => {
          const hostLabel = formatHostLabel(s.host);
          const stEmoji = s.autoState ? s.autoState.emoji : '';
          const stLabel = s.autoState ? s.autoState.state : '';
          console.log(`  - \x1b[36m${s.id}\x1b[0m (\x1b[33m${hostLabel}\x1b[0m) [${s.command}] - ${s.healthStatus || 'UNKNOWN'}${stLabel ? ` ${stEmoji} ${stLabel}` : ''} - Clients: ${s.active_clients}`);
        });
      }
      console.log('\n');
      continue;
    }

    if (response.action === 'spawn') {
      const spawnResponse = await promptWithRecovery([
        { type: 'text', name: 'id', message: 'Enter new session ID (e.g. agent-1):', validate: v => v ? true : 'Required' },
        { type: 'text', name: 'command', message: 'Enter command to run (e.g. bash, zsh, python):', initial: 'bash' }
      ]);
      if (spawnResponse.__teleptyRetry) {
        renderInteractiveHeader();
        continue;
      }
      const { id, command } = spawnResponse;
      if (!id || !command) continue;

      await ensureDaemonRunning();

      const cols = process.stdout.columns || 80;
      const rows = process.stdout.rows || 30;
      try {
        const res = await fetchWithAuth(`${DAEMON_URL}/api/sessions/spawn`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: id, command, args: [], cwd: process.cwd(), cols, rows, type: 'USER' })
        });
        const data = await res.json();
        if (!res.ok) console.error(`\n❌ Error: ${data.error}\n`);
        else {
          // Immediately attach to the spawned session automatically
          console.log(`\n✅ Session '\x1b[36m${data.session_id}\x1b[0m' spawned. Entering room automatically...\n`);
          args[1] = data.session_id; // Spoof args for attach
          return manageInteractiveAttach(data.session_id, '127.0.0.1');
        }
      } catch (e) {
        console.error('\n❌ Failed to connect to local daemon. Is it running?\n');
      }
      continue;
    }

    if (response.action === 'allow') {
      const allowResponse = await promptWithRecovery([
        { type: 'text', name: 'id', message: 'Enter session ID (e.g. my-claude):', validate: v => v ? true : 'Required' },
        { type: 'text', name: 'command', message: 'Enter command to run (e.g. claude, codex, gemini, bash):', initial: 'bash' }
      ]);
      if (allowResponse.__teleptyRetry) {
        renderInteractiveHeader();
        continue;
      }
      const { id, command } = allowResponse;
      if (!id || !command) continue;

      // Delegate to the allow command handler by setting up args and calling main flow
      process.argv.splice(2, process.argv.length - 2, 'allow', '--id', id, command);
      args.length = 0;
      args.push('allow', '--id', id, command);
      return main();
    }

    if (response.action === 'attach' || response.action === 'inject') {
      const sessions = await discoverSessions();
      if (sessions.length === 0) {
        console.log('\n❌ No active sessions found to ' + response.action + '.\n');
        continue;
      }
      const attachOrInjectResponse = await promptWithRecovery({
        type: 'select',
        name: 'target',
        message: `Select a session to ${response.action}:`,
        choices: sessions.map(s => ({
          title: `${s.id} (${s.host === '127.0.0.1' ? 'Local' : s.host}) - ${s.command}`,
          value: s
        }))
      });
      if (attachOrInjectResponse.__teleptyRetry) {
        renderInteractiveHeader();
        continue;
      }
      const { target } = attachOrInjectResponse;

      if (!target) continue;

      if (response.action === 'attach') {
        await manageInteractiveAttach(target.id, target.host);
        continue;
      }

      if (response.action === 'inject') {
        const injectPromptResponse = await promptWithRecovery({
          type: 'text',
          name: 'promptText',
          message: 'Enter text to inject:',
          validate: v => v ? true : 'Required'
        });
        if (injectPromptResponse.__teleptyRetry) {
          renderInteractiveHeader();
          continue;
        }
        const { promptText } = injectPromptResponse;
        if (!promptText) continue;
        try {
          const res = await fetchWithAuth(`${daemonUrl(target.host)}/api/sessions/${encodeURIComponent(target.id)}/inject`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: promptText })
          });
          const data = await res.json();
          if (!res.ok) console.error(`\n❌ ${formatApiError(data)}\n`);
          else console.log(`\n✅ Injected successfully into '\x1b[36m${target.id}\x1b[0m'.\n`);
        } catch (e) { console.error('\n❌ Failed to connect.\n'); }
        continue;
      }
    }
  }
}

async function main() {
  const cmd = args[0];
  
  if (!cmd) {
    return manageInteractive();
  }

  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    console.log(pkg.version);
    return;
  }

  if (cmd === 'init') {
    const { main: runInit } = require('./src/init/print-snippet');
    const exitCode = runInit(args.slice(1));
    if (exitCode) {
      process.exitCode = exitCode;
    }
    return;
  }

  if (cmd === 'update') {
    console.log('\x1b[36m🔄 Updating telepty to the latest version...\x1b[0m');
    try {
      runUpdateInstall();
      console.log('\n\x1b[32m✅ Update complete! Restarting daemon...\x1b[0m');
      await repairLocalDaemon({ restart: true });
      console.log('🎉 You are now using the latest version.');
    } catch (e) {
      console.error('\n❌ Update failed. Please try running: npm install -g @dmsdc-ai/aigentry-telepty@latest');
    }
    return;
  }

  if (cmd === 'cleanup-daemons') {
    const results = cleanupDaemonProcesses();
    console.log(`Stopped ${results.stopped.length} telepty daemon(s).`);
    if (results.failed.length > 0) {
      console.log(`Failed to stop ${results.failed.length} daemon(s).`);
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === 'daemon') {
    console.log('Starting telepty daemon...');
    // daemon.js binds the port only when launched as the daemon. The CLI reaches
    // it via require() (not as require.main), so signal intent explicitly — tests
    // that `require('./daemon.js')` without this env stay side-effect-free. (#15 / 0.5.0 daemon-never-listened regression)
    process.env.AIGENTRY_TELEPTY_DAEMON_MAIN = '1';
    require('./daemon.js');
    return;
  }

  if (cmd === 'tui' || cmd === 'dashboard') {
    const { TuiDashboard } = require('./tui');
    new TuiDashboard();
    return;
  }

  if (cmd === 'list') {
    try {
      let sessions = await discoverSessions({ silent: true });
      // Bridge merge: surface supervisor-managed sessions discovered via
      // filesystem manifest scan. De-dup with daemon entries by session id.
      // Daemon path remains source-of-truth when both surfaces report the
      // same session; bridge fills the gap when daemon is down (P2 #430).
      try {
        const bridgeSessions = require('./src/bridge/j3-shim').list();
        const seenIds = new Set(sessions.map((s) => s.id));
        for (const bs of bridgeSessions) {
          if (!seenIds.has(bs.id)) {
            sessions.push(bs);
            seenIds.add(bs.id);
          }
        }
      } catch {
        // Best-effort: daemon list still surfaced above.
      }
      const nowMs = Date.now();
      sessions = sessions.map((session) => enrichSessionIdle(session, nowMs));
      if (args.includes('--json')) {
        console.log(JSON.stringify(sessions, null, 2));
        return;
      }
      if (sessions.length === 0) { console.log('No active sessions found.'); return; }
      console.log('\x1b[1mActive Sessions:\x1b[0m');
      sessions.forEach(s => {
        console.log(`  - ID: \x1b[36m${s.id}\x1b[0m`);
        console.log(`    Host: ${formatHostLabel(s.host)}`);
        console.log(`    Command: ${s.command}`);
        const autoEmoji = s.autoState ? s.autoState.emoji : '';
      const autoLabel = s.autoState ? s.autoState.state : '';
      console.log(`    Status: ${formatSessionStatusWithIdle(s)}${autoLabel ? ` ${autoEmoji} ${autoLabel}` : ''}`);
        console.log(`    Terminal: ${formatSessionTerminal(s)}`);
        console.log(`    CWD: ${s.cwd}`);
        console.log(`    Clients: ${s.active_clients}`);
        console.log(`    Started: ${new Date(s.createdAt).toLocaleString()}`);
        console.log('');
      });
    } catch (e) {
      console.error(`❌ ${e.message || 'Failed to discover sessions.'}`);
    }
    return;
  }

  if (cmd === 'spawn') {
    const idIndex = args.indexOf('--id');
    if (idIndex === -1 || !args[idIndex + 1]) { console.error('❌ Usage: telepty spawn --id <session_id> <command> [args...]'); process.exit(1); }
    const sessionId = args[idIndex + 1];
    const spawnArgs = args.filter((a, i) => a !== 'spawn' && i !== idIndex && i !== idIndex + 1);
    if (spawnArgs.length === 0) { console.error('❌ Missing command. Example: telepty spawn --id "test" bash'); process.exit(1); }
    const command = spawnArgs[0]; const cmdArgs = spawnArgs.slice(1);
    
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 30;

    try {
      const res = await fetchWithAuth(`${DAEMON_URL}/api/sessions/spawn`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, command: command, args: cmdArgs, cwd: process.cwd(), cols, rows, type: 'USER' })
      });
      const data = await res.json();
      if (!res.ok) { console.error(`❌ Error: ${data.error}`); return; }
      console.log(`✅ Session '\x1b[36m${data.session_id}\x1b[0m' spawned. Entering room automatically...`);
      return manageInteractiveAttach(data.session_id, '127.0.0.1');
    } catch (e) { console.error('❌ Failed to connect to daemon. Is it running?'); }
    return;
  }

  if (cmd === 'allow' || cmd === 'enable' || cmd === 'wrap') {
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
        process.exit(1);
      }
      idleTtl = allowArgs[idleTtlIndex + 1];
      try {
        lifecycle.parseDuration(idleTtl, { fieldName: 'idle_ttl' });
      } catch (err) {
        console.error(`❌ ${err.message}`);
        process.exit(1);
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
      process.exit(1);
    }

    // Default session ID = {folder}-{cli} (e.g. aigentry-dustcraw-claude)
    if (!sessionId) {
      const folder = path.basename(process.cwd());
      const cli = path.basename(command).replace(/\..*$/, '');
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

    await ensureDaemonRunning({ requiredCapabilities: ['wrapped-sessions'] });

    // Detect terminal backend for session registration
    function findKittySocketCli() {
      try {
        const files = require('fs').readdirSync('/tmp').filter(f => f.startsWith('kitty-sock'));
        return files.length > 0;
      } catch { return false; }
    }
    // #29: classify Warp first (TERM_PROGRAM=WarpTerminal) for honest telemetry + a named
    // branch (Warp readiness uses the #29 owner-alive floor, not a cmux read-screen poll).
    const detectedBackend = classifyBackend(process.env, findKittySocketCli);

    // Register session with daemon
    const terminalProgram = detectTerminalProgram(process.env);
    const terminalType = process.env.TERM || null;
    try {
      const res = await fetchWithAuth(`${DAEMON_URL}/api/sessions/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          command,
          cwd: process.cwd(),
          backend: detectedBackend,
          cmux_workspace_id: process.env.CMUX_WORKSPACE_ID || null,
          cmux_surface_id: process.env.CMUX_SURFACE_ID || null,
          term_program: terminalProgram,
          term: terminalType,
          owner_pid: process.pid,
          ...(idleTtl !== null ? { idle_ttl: idleTtl } : {})
        })
      });
      const data = await res.json();
      if (!res.ok) {
        console.error(`❌ Error: ${data.error}`);
        process.exit(1);
      }
    } catch (e) {
      console.error('❌ Failed to register with daemon:', e.message);
      process.exit(1);
    }

    // Spawn local PTY (preserves isTTY, env, shell config)
    const pty = require('node-pty');
    const sessionCwd = process.cwd();
    const sessionEnv = { ...process.env, TELEPTY_SESSION_ID: sessionId, TELEPTY_AVAILABLE: 'true' };
    let child = null;
    let sessionStartTime = Date.now();
    let crashCount = 0;
    const MAX_CRASHES = 3;
    const DEATH_LOG_PATH = path.join(os.homedir(), '.telepty', 'logs', 'session-deaths.log');

    function updateDaemonProcessMetadata() {
      const body = {
        session_id: sessionId,
        command,
        cwd: process.cwd(),
        backend: detectedBackend,
        cmux_workspace_id: process.env.CMUX_WORKSPACE_ID || null,
        cmux_surface_id: process.env.CMUX_SURFACE_ID || null,
        term_program: terminalProgram,
        term: terminalType,
        owner_pid: process.pid,
        ...(child && child.pid ? { pty_pid: child.pid } : {}),
        ...(idleTtl !== null ? { idle_ttl: idleTtl } : {})
      };
      fetchWithAuth(`${DAEMON_URL}/api/sessions/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).catch(() => {});
    }

    function logSessionDeath(exitCode, signal, duration) {
      try {
        fs.mkdirSync(path.dirname(DEATH_LOG_PATH), { recursive: true });
        const entry = `[${new Date().toISOString()}] session=${sessionId} command=${command} exit=${exitCode} signal=${signal || 'none'} duration=${Math.round(duration / 1000)}s crashes=${crashCount}\n`;
        fs.appendFileSync(DEATH_LOG_PATH, entry);
      } catch {}
    }

    function emitDeathEvent(exitCode, signal, willRestart) {
      if (wsReady && daemonWs && daemonWs.readyState === 1) {
        daemonWs.send(JSON.stringify({
          type: 'session_died',
          session_id: sessionId,
          exitCode, signal: signal || null,
          duration: Date.now() - sessionStartTime,
          crashCount,
          willRestart,
          timestamp: new Date().toISOString()
        }));
      }
    }

    function emitRestartEvent(attempt) {
      if (wsReady && daemonWs && daemonWs.readyState === 1) {
        daemonWs.send(JSON.stringify({
          type: 'session_restarted',
          session_id: sessionId,
          attempt,
          timestamp: new Date().toISOString()
        }));
      }
    }

    function spawnChild() {
      // Windows: walk %PATHEXT% so bare names (`claude`, `codex`, `gemini`)
      // resolve to their npm-global `.cmd`/`.ps1` shims. POSIX: no-op. (#25)
      const resolvedCommand = resolveWindowsExecutable(command, process.env);
      // #26 (Snyk waiver, accepted-by-design): spawning the operator/user-chosen CLI IS the
      // `telepty allow` feature — `command` comes from the local CLI invocation, not an
      // untrusted boundary, so this is not an exploitable injection. Pre-existing baseline
      // finding; not fixable without removing `telepty allow`.
      child = pty.spawn(resolvedCommand, cmdArgs, {
        name: 'xterm-256color',
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 30,
        cwd: sessionCwd,
        env: sessionEnv
      });
      sessionStartTime = Date.now();
      updateDaemonProcessMetadata();
      return child;
    }

    spawnChild();

    // Prompt-ready detection for safe inject delivery.
    // Known AI CLIs use the centralized geometry-aware registry; generic
    // commands keep the permissive legacy prompt regex for compatibility.
    const knownAiCli = readyRegistry.isKnownAiCli(command);
    const promptPattern = /[❯>$#%]\s*$/;
    let promptReady = false;  // wait for CLI prompt before accepting inject
    let firstReadyObserved = false;
    let outputTail = '';
    let lastUserInputTime = 0;  // timestamp of last user keystroke
    const IDLE_THRESHOLD = 2000; // ms after last user input to consider idle

    // Mailbox-backed inject queue (replaces in-memory array for crash resilience)
    const bridgeMailbox = new FileMailbox({
      root: path.join(os.homedir(), '.aigentry', 'mailbox', 'bridge'),
    });
    const bridgeTarget = sessionId;
    let bridgeMsgSeq = 0;
    let bridgePendingCount = 0;

    // Recover undelivered messages from a previous crash
    try {
      const leftover = bridgeMailbox.peek(bridgeTarget).filter(m => m.state === 'pending' || m.state === 'in_flight');
      bridgePendingCount = leftover.length;
      if (bridgePendingCount > 0) {
        console.log(`\x1b[33m[BRIDGE] Recovered ${bridgePendingCount} undelivered message(s) from previous session\x1b[0m`);
      }
    } catch {}

    function enqueueBridgeMessage(text) {
      const msgId = `${sessionId}:${Date.now()}:${++bridgeMsgSeq}`;
      try {
        bridgeMailbox.enqueue({
          msg_id: msgId, from: 'daemon', to: bridgeTarget,
          payload: text, created_at: Math.floor(Date.now() / 1000), attempt: 0,
        });
        bridgePendingCount++;
      } catch (err) {
        // Fallback: write directly if mailbox fails
        console.error(`[BRIDGE] Mailbox enqueue failed, writing directly: ${err.message}`);
        child.write(text);
      }
    }

    function isIdle() {
      return promptReady && (Date.now() - lastUserInputTime > IDLE_THRESHOLD);
    }

    function observePromptReady(data) {
      if (knownAiCli) {
        outputTail = (outputTail + data).slice(-20000);
        return !!readyRegistry.detectOutput(command, outputTail).found;
      }
      return promptPattern.test(data);
    }

    let queueFlushTimer = null;
    let idleCheckTimer = null;

    function flushBridgeMailbox() {
      if (queueFlushTimer) { clearTimeout(queueFlushTimer); queueFlushTimer = null; }
      if (idleCheckTimer) { clearInterval(idleCheckTimer); idleCheckTimer = null; }
      if (bridgePendingCount === 0) return;
      let delay = 0;
      const batch = [];
      // Dequeue all pending messages
      while (true) {
        const msg = bridgeMailbox.dequeue(bridgeTarget);
        if (!msg) break;
        batch.push(msg);
      }
      if (batch.length === 0) { bridgePendingCount = 0; return; }
      for (const msg of batch) {
        const text = msg.payload;
        const msgId = msg.msg_id;
        setTimeout(() => {
          child.write(text);
          try { bridgeMailbox.ack(bridgeTarget, msgId); } catch {}
        }, delay);
        delay += text === '\r' ? 0 : 100;
      }
      bridgePendingCount = Math.max(0, bridgePendingCount - batch.length);
      promptReady = false;
    }
    function scheduleIdleFlush() {
      if (idleCheckTimer) return;
      // Poll every 500ms for idle state
      idleCheckTimer = setInterval(() => {
        if (isIdle() && bridgePendingCount > 0) {
          flushBridgeMailbox();
        }
      }, 500);
      // Safety fallback is compatibility-only during known AI CLI bootstrap:
      // first dispatch must wait for a strong ready signal.
      if ((!knownAiCli || firstReadyObserved) && !queueFlushTimer) {
        queueFlushTimer = setTimeout(() => {
          queueFlushTimer = null;
          if (bridgePendingCount > 0) {
            flushBridgeMailbox();
          }
        }, 5000);
      }
    }

    // Connect to daemon WebSocket with auto-reconnect
    // owner=1 tells daemon this is the allow bridge (owner), not an attach viewer.
    // Daemon uses this to reclaim ownership even if a stale ownerWs is still registered.
    const wsUrl = `${daemonWsUrl(REMOTE_HOST)}/api/sessions/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(getAuthToken())}&owner=1`;
    let daemonWs = null;
    let wsReady = false;
    let reconnectAttempts = 0;
    let reconnectTimer = null;
    let lastInjectTextTime = 0;
    const MAX_RECONNECT_DELAY = 30000;

    async function connectDaemonWs() {
      // Re-register session BEFORE WebSocket connect (daemon rejects WS if session unknown)
      if (reconnectAttempts > 0) {
        try {
          await fetchWithAuth(`${DAEMON_URL}/api/sessions/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              session_id: sessionId,
              command,
              cwd: process.cwd(),
              backend: detectedBackend,
              cmux_workspace_id: process.env.CMUX_WORKSPACE_ID || null,
              cmux_surface_id: process.env.CMUX_SURFACE_ID || null,
              term_program: terminalProgram,
              term: terminalType,
              owner_pid: process.pid,
              ...(child && child.pid ? { pty_pid: child.pid } : {}),
              ...(idleTtl !== null ? { idle_ttl: idleTtl } : {})
            })
          });
        } catch (e) {
          // Registration may fail if session already exists or daemon not ready
        }
      }

      daemonWs = new WebSocket(wsUrl);

      daemonWs.on('open', () => {
        wsReady = true;
        // No resize trick on reconnect — it causes visible flickering across all
        // terminals when the daemon restarts and multiple sessions reconnect at once.
        reconnectAttempts = 0;
        // Re-send ready on reconnect so new daemon knows CLI is ready
        if (readyNotified && promptReady) {
          daemonWs.send(JSON.stringify({ type: 'ready' }));
        }
      });

      daemonWs.on('message', (message) => {
        try {
          const msg = JSON.parse(message);
          if (msg.type === 'inject') {
            const chunks = [];
            const rawData = typeof msg.data === 'string' ? msg.data : String(msg.data ?? '');
            // Keep text+CR combined — do NOT split them.
            chunks.push(rawData);

            for (const chunk of chunks) {
              if (!chunk) {
                continue;
              }

              const isCr = chunk === '\r';
              if (isCr && bridgePendingCount > 0) {
                // CR with pending queued text — queue CR too and wait for the
                // same readiness gate as the text. This preserves order during
                // bootstrap and busy-session delivery.
                enqueueBridgeMessage(chunk);
                if (isIdle()) {
                  if (queueFlushTimer) { clearTimeout(queueFlushTimer); queueFlushTimer = null; }
                  flushBridgeMailbox();
                } else {
                  scheduleIdleFlush();
                }
              } else if (isCr) {
                // CR always written immediately — never idle-gated.
                child.write(chunk);
              } else if (isIdle()) {
                // Text when idle — write immediately.
                child.write(chunk);
                promptReady = false;
                lastInjectTextTime = Date.now();
              } else {
                // Text when not idle — queue for safe delivery.
                enqueueBridgeMessage(chunk);
                scheduleIdleFlush();
              }
            }
            // Reset readyNotified so next prompt detection re-notifies daemon (auto-report)
            if (rawData && rawData !== '\r') {
              readyNotified = false;
            }
          } else if (msg.type === 'resize') {
            child.resize(msg.cols, msg.rows);
          }
        } catch (e) {
          // ignore malformed messages
        }
      });

      daemonWs.on('close', (code, reason) => {
        wsReady = false;
        // #17 (OQ-2): the daemon explicitly destroyed this session (manual kill or the
        // surface-gone GC) → close code 1000 'Session destroyed'. Terminate the bridge
        // instead of reconnecting; otherwise the orphan bridge re-registers and defeats the
        // GC. Daemon restarts / network drops use other codes (e.g. 1006) and still reconnect,
        // preserving the #487/#488 survive-and-reattach guarantee.
        if (isDaemonDestroyClose(code, reason)) {
          if (closeAllowSession()) {
            exitAllowSession(0);
          }
          return;
        }
        scheduleReconnect();
      });

      daemonWs.on('error', () => {
        // Error will be followed by close event
      });
    }

    function scheduleReconnect() {
      if (reconnectTimer) return;
      reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
      if (reconnectAttempts === 1) {
        // Silent — no console output to avoid breaking TUI rendering
      }
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectDaemonWs();
      }, delay);
    }

    connectDaemonWs();

    // Set terminal title
    process.stdout.write(`\x1b]0;⚡ telepty :: ${sessionId}\x07`);
    console.log(`\x1b[32m⚡ '${command}' is now session '\x1b[36m${sessionId}\x1b[32m'. Inject allowed.\x1b[0m\n`);

    const cleanupTerminal = attachInteractiveTerminal(process.stdin, process.stdout, {
      onData: (data) => {
        lastUserInputTime = Date.now();
        child.write(data.toString());
      },
      onResize: () => {
        const size = getTerminalSize(process.stdout, { cols: 120, rows: 40 });
        child.resize(size.cols, size.rows);
      }
    });
    let allowSessionClosed = false;
    const allowSignalHandlers = new Map();

    function closeAllowSession() {
      if (allowSessionClosed) {
        return false;
      }

      allowSessionClosed = true;
      cleanupTerminal();
      // Purge bridge mailbox on clean exit (undelivered messages are stale)
      try { bridgeMailbox.purge(bridgeTarget); } catch {}
      process.stdout.write(`\x1b]0;\x07`);
      fetchWithAuth(`${DAEMON_URL}/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).catch(() => {});
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        daemonWs.close();
      } catch {}
      for (const [signalName, handler] of allowSignalHandlers) {
        process.off(signalName, handler);
      }
      return true;
    }

    function exitAllowSession(code, exitCtx) {
      if (exitCtx) {
        logSessionDeath(exitCtx.exitCode, exitCtx.signal, exitCtx.duration);
      }
      process.exit(code);
    }

    // Intercept terminal title escape sequences and prefix with session ID
    const titlePrefix = `\u26A1 ${sessionId}`;
    function rewriteTitleSequences(output) {
      // Match OSC title sequences with BEL (\x07) or ST (\x1b\\) terminator
      return output.replace(/\x1b\]([02]);([^\x07\x1b]*?)(\x07|\x1b\\)/g, (match, code, title, term) => {
        return `\x1b]${code};${titlePrefix} | ${title}${term}`;
      });
    }

    // Relay PTY output to current terminal + send to daemon for attach clients
    let readyNotified = false;
    child.onData((data) => {
      const rewritten = rewriteTitleSequences(data);
      process.stdout.write(rewritten);
      if (wsReady && daemonWs.readyState === 1) {
        daemonWs.send(JSON.stringify({ type: 'output', data }));
      }
      // Detect prompt in output to enable inject delivery
      if (observePromptReady(data)) {
        promptReady = true;
        firstReadyObserved = true;
        flushBridgeMailbox();
        // Notify daemon that CLI is ready for inject
        if (!readyNotified && wsReady && daemonWs.readyState === 1) {
          readyNotified = true;
          daemonWs.send(JSON.stringify({ type: 'ready' }));
        }
      }
    });

    // Handle child exit with death tracking + auto-restart
    function attachChildExitHandler() {
      child.onExit(({ exitCode, signal }) => {
        const duration = Date.now() - sessionStartTime;
        const isAbnormal = exitCode !== 0 || signal;
        const durationStr = duration > 60000 ? `${Math.round(duration / 60000)}m ${Math.round((duration % 60000) / 1000)}s` : `${Math.round(duration / 1000)}s`;

        logSessionDeath(exitCode, signal, duration);

        if (isAbnormal && autoRestart && crashCount < MAX_CRASHES) {
          crashCount++;
          const backoffMs = Math.min(1000 * Math.pow(2, crashCount - 1), 8000);
          const willRestart = true;
          emitDeathEvent(exitCode, signal, willRestart);
          console.log(`\n\x1b[33m⚠️ Session '${sessionId}' died (code ${exitCode}, signal ${signal || 'none'}, ${durationStr}). Restarting in ${backoffMs}ms (attempt ${crashCount}/${MAX_CRASHES})...\x1b[0m`);

          setTimeout(() => {
            try {
              spawnChild();
              promptReady = false;
              firstReadyObserved = false;
              readyNotified = false;
              outputTail = '';
              // Re-attach output relay, prompt detection, and exit handler
              child.onData((data) => {
                const rewritten = rewriteTitleSequences(data);
                process.stdout.write(rewritten);
                if (wsReady && daemonWs.readyState === 1) {
                  daemonWs.send(JSON.stringify({ type: 'output', data }));
                }
                if (observePromptReady(data)) {
                  promptReady = true;
                  firstReadyObserved = true;
                  flushBridgeMailbox();
                  if (wsReady && daemonWs.readyState === 1) {
                    daemonWs.send(JSON.stringify({ type: 'ready' }));
                  }
                }
              });
              attachChildExitHandler();
              emitRestartEvent(crashCount);
              console.log(`\x1b[32m✅ Session '${sessionId}' restarted (attempt ${crashCount}).\x1b[0m\n`);
              // Reset crash counter if session survives 30s
              setTimeout(() => { if (crashCount > 0) crashCount = 0; }, 30000);
            } catch (err) {
              console.error(`\x1b[31m❌ Failed to restart session '${sessionId}': ${err.message}\x1b[0m`);
              emitDeathEvent(exitCode, signal, false);
              if (!closeAllowSession()) return;
              exitAllowSession(exitCode || 1);
            }
          }, backoffMs);
        } else {
          if (isAbnormal && autoRestart && crashCount >= MAX_CRASHES) {
            console.log(`\n\x1b[31m❌ Session '${sessionId}' crashed ${MAX_CRASHES} times. Giving up.\x1b[0m`);
          }
          emitDeathEvent(exitCode, signal, false);
          if (!closeAllowSession()) return;
          console.log(`\n\x1b[33mSession '${sessionId}' exited (code ${exitCode}${signal ? ', signal ' + signal : ''}, ${durationStr}).\x1b[0m`);
          exitAllowSession(exitCode || 0);
        }
      });
    }
    attachChildExitHandler();

    process.on('SIGHUP', () => {
      // Explicit no-op: decouples telepty-allow lifecycle from parent terminal app.
      // Node default for SIGHUP is process.exit; this handler overrides that default.
      // See ADR 2026-05-27-cmux-telepty-session-boundary §4.
    });
    process.stdout.on('error', () => {});

    for (const signalName of ['SIGTERM', 'SIGQUIT']) {
      const handler = () => {
        closeAllowSession();
        try {
          child.kill(signalName);
        } catch {}
        const signalCode = osConstants.signals[signalName] || 1;
        exitAllowSession(128 + signalCode, {
          exitCode: null,
          signal: signalName,
          duration: Date.now() - sessionStartTime
        });
      };
      allowSignalHandlers.set(signalName, handler);
      process.on(signalName, handler);
    }

    // Graceful shutdown on SIGINT (let child handle it via PTY)
    process.on('SIGINT', () => {});

    return;
  }

  if (cmd === 'attach') {
    let sessionId = args[1];
    let targetHost = REMOTE_HOST;

    if (!sessionId) {
      const sessions = await discoverSessions();
      if (sessions.length === 0) {
        console.log('❌ No active sessions found on any known networks.');
        process.exit(0);
      }

      console.log('\n\x1b[1mAvailable Sessions:\x1b[0m');
      sessions.forEach((s, i) => {
        const hostLabel = formatHostLabel(s.host);
        console.log(`  [${i + 1}] \x1b[36m${s.id}\x1b[0m (\x1b[33m${hostLabel}\x1b[0m) - ${s.command}`);
      });

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise(resolve => rl.question('\nSelect a session number to attach: ', resolve));
      rl.close();

      const idx = parseInt(answer) - 1;
      if (isNaN(idx) || !sessions[idx]) {
        console.error('❌ Invalid selection.');
        process.exit(1);
      }

      sessionId = sessions[idx].id;
      targetHost = sessions[idx].host;
    } else {
      try {
        const target = await resolveSessionTarget(sessionId);
        if (!target) {
          console.error(`❌ Session '${sessionId}' was not found on any discovered host.`);
          process.exit(1);
        }
        sessionId = target.id;
        targetHost = target.host;
      } catch (error) {
        console.error(`❌ ${error.message}`);
        process.exit(1);
      }
    }

    const wsUrl = `${daemonWsUrl(targetHost)}/api/sessions/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(getAuthToken())}`;
    const ws = new WebSocket(wsUrl);
    let cleanupTerminal = null;

    ws.on('open', () => {
      // Set Ghostty tab title to show session ID
      const hostSuffix = targetHost === '127.0.0.1' ? '' : ` @ ${targetHost}`;
      process.stdout.write(`\x1b]0;⚡ telepty :: ${sessionId}${hostSuffix}\x07`);
      console.log(`\x1b[32mEntered room '${sessionId}'${hostSuffix ? ` (${targetHost})` : ''}.\x1b[0m\n`);

      cleanupTerminal = attachInteractiveTerminal(process.stdin, process.stdout, {
        onData: (data) => {
          ws.send(JSON.stringify({ type: 'input', data: data.toString() }));
        },
        onResize: () => {
          const size = getTerminalSize(process.stdout, { cols: 80, rows: 30 });
          ws.send(JSON.stringify({
            type: 'resize',
            cols: size.cols,
            rows: size.rows
          }));
        }
      });
    });

    ws.on('message', (message) => {
      const { type, data } = JSON.parse(message);
      if (type === 'output') {
        process.stdout.write(data);
      }
    });

    ws.on('close', async (code, reason) => {
      process.stdout.write(`\x1b]0;\x07`); // Restore default terminal title
      if (cleanupTerminal) cleanupTerminal();

      // Check if other clients are still attached before destroying
      try {
        const res = await fetchWithAuth(`${daemonUrl(targetHost)}/api/sessions`);
        if (res.ok) {
          const allSessions = await res.json();
          const session = allSessions.find(s => s.id === sessionId);
          if (session && session.active_clients > 0) {
            console.log(`\n\x1b[33mLeft room '${sessionId}'. Other clients still attached — session kept alive.\x1b[0m`);
          } else {
            console.log(`\n\x1b[33mLeft room '${sessionId}'. No other clients — destroying session.\x1b[0m`);
            await fetchWithAuth(`${daemonUrl(targetHost)}/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
          }
        }
      } catch(e) {}
      process.exit(0);
    });

    ws.on('error', (err) => {
      console.error('❌ WebSocket Error:', err.message);
      process.exit(1);
    });

    return;
  }

  if (cmd === 'read-screen') {
    const sessionId = args[1];
    if (!sessionId) { console.error('❌ Usage: telepty read-screen <session_id> [--lines N] [--raw]'); process.exit(1); }

    const linesIndex = args.indexOf('--lines');
    const lines = (linesIndex !== -1 && args[linesIndex + 1]) ? args[linesIndex + 1] : '50';
    const raw = args.includes('--raw');

    try {
      const target = await resolveSessionTarget(sessionId);
      if (!target) {
        console.error(`❌ Session '${sessionId}' was not found on any discovered host.`);
        process.exit(1);
      }

      const res = await fetchWithAuth(`${daemonUrl(target.host)}/api/sessions/${encodeURIComponent(target.id)}/screen?lines=${lines}${raw ? '&raw=1' : ''}`);
      const data = await res.json();
      if (!res.ok) { console.error(`❌ Error: ${data.error}`); process.exit(1); }

      if (!data.screen) {
        console.log('(empty screen)');
      } else {
        console.log(data.screen);
      }
    } catch (e) { console.error(`❌ ${e.message || 'Failed to connect to the target daemon.'}`); }
    return;
  }

  if (cmd === 'inject') {
    const { useRef, refFilePath } = parseRefOption(args);

    if (args.includes('--no-enter')) {
      console.error('❌ telepty inject always submits after text. Use `telepty enter <session_id>` to send Enter only.');
      process.exit(1);
    }

    // Extract --submit flag (terminal-level submit instead of deferred PTY CR)
    const submitIndex = args.indexOf('--submit');
    const useSubmit = submitIndex !== -1;
    if (useSubmit) args.splice(submitIndex, 1);

    // Extract --submit-force flag (gate bypass; opt-in escape hatch).
    // Mirrors `telepty send-key`'s force semantics: skip both Layer 3 and
    // Layer 1 gates and dispatch Enter immediately. Safe only when the
    // caller is confident the target REPL is ready (e.g., orchestrator is
    // visibly idle). See specs/2026-05-02-submit-force-and-retry.md
    const submitForceIndex = args.indexOf('--submit-force');
    const noSubmitForceIndex = args.indexOf('--no-submit-force');
    const explicitSubmitForce = submitForceIndex !== -1;
    const explicitNoSubmitForce = noSubmitForceIndex !== -1;
    for (const index of [submitForceIndex, noSubmitForceIndex].filter((i) => i !== -1).sort((a, b) => b - a)) {
      args.splice(index, 1);
    }
    const submitForceFromEnv = !explicitSubmitForce && !explicitNoSubmitForce && isSubmitForceDefaultEnabled();
    const submitForce = explicitSubmitForce || submitForceFromEnv;

    // Extract --submit-retry N flag (default 1, clamp [0, 3]). On a 504
    // gated-failure with a retry-safe reason (gate timed out and body is
    // still in the input box → idempotent), wait 300ms and retry. Hard-fail
    // reasons (session_dead/error/restarting/no_state) do NOT retry —
    // re-firing won't recover and would be a wasted round-trip.
    let submitRetries = 1;
    const submitRetryIndex = args.indexOf('--submit-retry');
    if (submitRetryIndex !== -1) {
      const raw = Number(args[submitRetryIndex + 1]);
      if (Number.isFinite(raw)) {
        submitRetries = Math.min(Math.max(Math.floor(raw), 0), 3);
        args.splice(submitRetryIndex, 2);
      } else {
        args.splice(submitRetryIndex, 1);
      }
    }

    // Extract --from flag
    let fromId;
    const fromIndex = args.indexOf('--from');
    if (fromIndex !== -1 && args[fromIndex + 1]) {
      fromId = args[fromIndex + 1];
      args.splice(fromIndex, 2);
    } else {
      fromId = process.env.TELEPTY_SESSION_ID || undefined;
    }

    // Extract --reply-to flag
    let replyTo;
    const replyToIndex = args.indexOf('--reply-to');
    if (replyToIndex !== -1 && args[replyToIndex + 1]) {
      replyTo = args[replyToIndex + 1];
      args.splice(replyToIndex, 2);
    }

    // Extract --reply-expected flag
    const replyExpectedIndex = args.indexOf('--reply-expected');
    const replyExpected = replyExpectedIndex !== -1;
    if (replyExpected) args.splice(replyExpectedIndex, 1);

    const sessionId = args[1];
    const hasPromptArgument = args.length >= 3;
    const prompt = args.slice(2).join(' ');
    if (!sessionId || (!refFilePath && !hasPromptArgument)) { console.error('❌ Usage: telepty inject [--ref [file]] [--from <id>] [--reply-to <id>] <session_id> "<prompt text>"'); process.exit(1); }
    try {
      const target = await resolveSessionTarget(sessionId);
      if (!target) {
        console.error(`❌ Session '${sessionId}' was not found on any discovered host.`);
        process.exit(1);
      }

      let injectPrompt = prompt;
      let referencePath = null;
      const refDescriptor = useRef ? createSharedReferenceDescriptor(prompt, refFilePath) : null;

      // Remote session: use SSH direct execution
      if (isRemoteSession(target)) {
        const { checkEntitlement } = require('./entitlement');
        const ent = checkEntitlement({ feature: 'telepty.remote_sessions' });
        if (!ent.allowed) {
          console.error(`⚠️  ${ent.reason}\n   Upgrade: ${ent.upgrade_url}`);
          process.exit(1);
        }

        if (useRef) {
          const reference = ensureRemoteSharedReference(target.peerName, refDescriptor, refFilePath ? prompt : '');
          injectPrompt = reference.prompt;
          referencePath = reference.referencePath;
        }

        const result = crossMachine.remoteInject(target.peerName, target.id, injectPrompt, {
          from: fromId,
          reply_to: replyTo,
          reply_expected: replyExpected
        });
        if (result.success) {
          const refSuffix = referencePath ? ` (ref: ${referencePath})` : '';
          console.log(`✅ Context injected successfully into '\x1b[36m${target.id}\x1b[0m' @ ${target.peerName}.${refSuffix}`);
        } else {
          console.error(`❌ ${result.error}`);
        }
        return;
      }

      if (useRef) {
        const reference = ensureLocalSharedReference(refDescriptor, refFilePath ? prompt : '');
        injectPrompt = reference.prompt;
        referencePath = reference.referencePath;
      }

      // Bridge-first attempt for local supervisor-managed sessions (P2 #430).
      // Gated submit semantics (render-gate, retry, submit-force) stay on
      // daemon.js — P2 wire does not carry those yet — so we only bridge the
      // basic inject path. Bridge failure (no manifest, supervisor crashed
      // mid-call, etc.) falls through to the daemon HTTP path below.
      if (!useSubmit) {
        const bridgeShim = require('./src/bridge/j3-shim');
        if (bridgeShim.findSupervisorManifest(target.id)) {
          const bridgeRes = await bridgeShim.inject(target.id, `${injectPrompt}\r`, {});
          if (bridgeRes.success) {
            const refSuffix = referencePath ? ` (ref: ${referencePath})` : '';
            console.log(`✅ Context injected successfully into '\x1b[36m${target.id}\x1b[0m' (bridge).${refSuffix}`);
            return;
          }
        }
      }

      const body = buildInjectRequestBody(injectPrompt, {
        fromId,
        replyTo,
        replyExpected,
        noEnter: useSubmit
      });

      const res = await fetchWithAuth(`${daemonUrl(target.host)}/api/sessions/${encodeURIComponent(target.id)}/inject`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) { console.error(`❌ ${formatApiError(data)}`); return; }
      const refSuffix = referencePath ? ` (ref: ${referencePath})` : '';
      console.log(`✅ Context injected successfully into '\x1b[36m${target.id}\x1b[0m'.${refSuffix}`);

      // Terminal-level submit: POST /submit after text injection.
      // Daemon-side render-gate handles timing (waits for REPL readiness),
      // so the CLI no longer needs the legacy 500ms blind sleep. Pass the
      // injected body so the daemon can verify it was consumed by the input
      // box and bounded-retry once if not.
      //
      // 0.3.3: opt-in --submit-force (gate bypass) and idempotent client-side
      // retry on retry-safe 504s. The retry guard is gate timeout + body
      // still visible in the input box (verify.consumed=false) — re-firing
      // an Enter that genuinely never landed cannot double-submit.
      // See docs/superpowers/specs/2026-04-26-inject-submit-enter-reliability.md
      if (useSubmit) {
        if (submitForceFromEnv) {
          console.error('[telepty inject] submit-force=env-default (TELEPTY_SUBMIT_FORCE_DEFAULT=1)');
        }
        const submitBody = {
          injected_body: injectPrompt || '',
          retries: 1,
          retry_delay_ms: 500,
          ...(submitForce ? { force: true } : {}),
        };
        const RETRY_DELAY_MS = 300;
        const RETRY_SAFE_REASONS = new Set([
          'gated_dispatch_unconsumed',
          'gate_timeout',
          'no_prompt_symbol_seen',
        ]);
        const maxAttempts = 1 + submitRetries;
        let submitRes = null;
        let submitData = null;
        let attemptsMade = 0;
        let lastError = null;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          if (attempt > 0) {
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          }
          attemptsMade = attempt + 1;
          try {
            submitRes = await fetchWithAuth(`${daemonUrl(target.host)}/api/sessions/${encodeURIComponent(target.id)}/submit`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(submitBody),
            });
            submitData = await submitRes.json();
          } catch (submitErr) {
            lastError = submitErr;
            submitRes = null;
            submitData = null;
            break;
          }
          if (submitRes.ok) break;
          if (submitRes.status !== 504) break;
          const retryReason = submitData && typeof submitData.reason === 'string' ? submitData.reason : null;
          if (!RETRY_SAFE_REASONS.has(retryReason)) break;
        }
        if (lastError) {
          console.error(`⚠️  Submit failed: ${lastError.message}`);
        } else if (submitRes && submitRes.ok) {
          const gateNote = submitData.gated && submitData.gate_wait_ms > 0
            ? ` [gate ${submitData.gate_wait_ms}ms]`
            : '';
          const lateNote = submitData.gated_dispatch_after_timeout
            ? ' (dispatched-after-gate-timeout)'
            : '';
          const attemptsNote = submitData.attempts > 1 ? ` (${submitData.attempts} attempts)` : '';
          const retryNote = attemptsMade > 1 ? ` [retry ${attemptsMade - 1}/${submitRetries}]` : '';
          const forcedNote = submitData.forced ? ' [forced]' : '';
          console.log(`✅ Submitted via ${submitData.strategy}${attemptsNote}${gateNote}${lateNote}${retryNote}${forcedNote}.`);
        } else if (submitRes && submitRes.status === 504) {
          // Soft failure: REPL never readied. Orchestrator scripts depend on
          // exit 0 here — surface a clear remediation hint but do not exit
          // non-zero.
          const reason = (submitData && submitData.reason) || 'gate_timeout';
          const lastState = (submitData && submitData.last_state) || 'unknown';
          const retriesNote = attemptsMade > 1 ? ` after ${attemptsMade} attempts` : '';
          const hint = submitForce
            ? ''
            : ` Try \`telepty inject --submit --submit-force ${target.id} ...\` or manual \`telepty send-key ${target.id} enter\`.`;
          console.log(`⚠️  Submit gated-timeout (${reason}, last_state=${lastState})${retriesNote}.${hint}`);
        } else {
          console.error(`⚠️  Submit failed: ${formatApiError(submitData)}`);
        }
      }
    } catch (e) { console.error(`❌ ${e.message || 'Failed to connect to the target daemon.'}`); }
    return;
  }

  if (cmd === 'enter') {
    const sessionId = args[1];
    if (!sessionId) { console.error('❌ Usage: telepty enter <session_id>'); process.exit(1); }

    try {
      const target = await resolveSessionTarget(sessionId);
      if (!target) {
        console.error(`❌ Session '${sessionId}' was not found on any discovered host.`);
        process.exit(1);
      }

      if (isRemoteSession(target)) {
        const { checkEntitlement } = require('./entitlement');
        const ent = checkEntitlement({ feature: 'telepty.remote_sessions' });
        if (!ent.allowed) {
          console.error(`⚠️  ${ent.reason}\n   Upgrade: ${ent.upgrade_url}`);
          process.exit(1);
        }

        const result = crossMachine.remoteInject(target.peerName, target.id, '', {});
        if (result.success) {
          console.log(`✅ Enter sent successfully into '\x1b[36m${target.id}\x1b[0m' @ ${target.peerName}.`);
        } else {
          console.error(`❌ ${result.error}`);
        }
        return;
      }

      const res = await fetchWithAuth(`${daemonUrl(target.host)}/api/sessions/${encodeURIComponent(target.id)}/inject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildInjectRequestBody('', {}))
      });
      const data = await res.json();
      if (!res.ok) { console.error(`❌ ${formatApiError(data)}`); return; }
      console.log(`✅ Enter sent successfully into '\x1b[36m${target.id}\x1b[0m'.`);
    } catch (e) {
      console.error(`❌ ${e.message || 'Failed to connect to the target daemon.'}`);
    }
    return;
  }

  if (cmd === 'send-key') {
    const sessionId = args[1];
    const key = (args[2] || '').toLowerCase();
    if (!sessionId || !key) { console.error('❌ Usage: telepty send-key <session_id> <key>\n   Supported keys: enter'); process.exit(1); }
    if (key !== 'enter' && key !== 'return') {
      console.error(`❌ Unsupported key: '${key}'. Supported keys: enter`);
      process.exit(1);
    }

    try {
      const target = await resolveSessionTarget(sessionId);
      if (!target) {
        console.error(`❌ Session '${sessionId}' was not found on any discovered host.`);
        process.exit(1);
      }

      // send-key is a manual override — bypass the render gate via force=true.
      // See: docs/superpowers/specs/2026-04-26-submit-gate-fixes-v2.md §3.1
      const res = await fetchWithAuth(`${daemonUrl(target.host)}/api/sessions/${encodeURIComponent(target.id)}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      const data = await res.json();
      if (!res.ok) { console.error(`❌ ${formatApiError(data)}`); return; }
      console.log(`✅ Key '${key}' sent to '\x1b[36m${target.id}\x1b[0m'. (strategy: ${data.strategy})`);
    } catch (e) {
      console.error(`❌ ${e.message || 'Failed to connect to the target daemon.'}`);
    }
    return;
  }

  if (cmd === 'reply') {
    const mySessionId = process.env.TELEPTY_SESSION_ID;
    if (!mySessionId) { console.error('❌ TELEPTY_SESSION_ID env var is required for reply command'); process.exit(1); }
    const replyText = args.slice(1).join(' ');
    if (!replyText) { console.error('❌ Usage: telepty reply "<text>"'); process.exit(1); }
    try {
      const metaRes = await fetchWithAuth(`${DAEMON_URL}/api/sessions/${encodeURIComponent(mySessionId)}`);
      if (!metaRes.ok) { console.error(`❌ Could not fetch session metadata for '${mySessionId}'`); process.exit(1); }
      const meta = await metaRes.json();
      const replyTo = meta.lastInjectReplyTo;
      if (!replyTo) { console.error(`❌ No pending reply-to found for session '${mySessionId}'`); process.exit(1); }
      const target = await resolveSessionTarget(replyTo);
      if (!target) { console.error(`❌ Session '${replyTo}' was not found on any discovered host.`); process.exit(1); }
      const body = { prompt: replyText, from: mySessionId, reply_to: mySessionId };
      const res = await fetchWithAuth(`${daemonUrl(target.host)}/api/sessions/${encodeURIComponent(target.id)}/inject`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) { console.error(`❌ ${formatApiError(data)}`); return; }
      console.log(`✅ Reply sent to '\x1b[36m${replyTo}\x1b[0m'.`);
    } catch (e) { console.error(`❌ ${e.message || 'Failed to connect to the target daemon.'}`); }
    return;
  }

  if (cmd === 'status') {
    const statusSessionId = args[1] || process.env.TELEPTY_SESSION_ID;
    if (!statusSessionId) {
      console.error('❌ Usage: telepty status <session_id>');
      process.exit(1);
    }

    try {
      const target = await resolveSessionTarget(statusSessionId);
      if (!target) {
        console.error(`❌ Session '${statusSessionId}' was not found on any discovered host.`);
        process.exit(1);
      }

      const res = await fetchWithAuth(`${daemonUrl(target.host)}/api/sessions/${encodeURIComponent(target.id)}/state`);
      const data = await res.json();
      if (!res.ok) {
        console.error(`❌ ${formatApiError(data)}`);
        process.exit(1);
      }

      const auto = data.auto || {};
      const selfReport = data.self_report || {};

      // Color-coded state display
      const stateColors = {
        starting: '\x1b[33m',      // yellow
        idle: '\x1b[32m',          // green
        working: '\x1b[36m',       // cyan
        thinking: '\x1b[35m',      // magenta
        waiting: '\x1b[33m',       // yellow
        error: '\x1b[31m',         // red
        restarting: '\x1b[33m',    // yellow
        dead: '\x1b[90m',          // gray
      };
      const stateColor = stateColors[auto.state] || '\x1b[37m';
      const reset = '\x1b[0m';

      console.log(`\n  Session: \x1b[36m${data.session_id}${reset}`);
      const stateEmoji = auto.emoji || '';
      console.log(`  State: ${stateColor}${stateEmoji} ${auto.state || 'unknown'}${reset} (confidence: ${auto.confidence != null ? (auto.confidence * 100).toFixed(0) + '%' : '?'})`);
      if (auto.since) {
        const durationMs = auto.duration_ms || 0;
        const durationStr = durationMs < 60000
          ? `${(durationMs / 1000).toFixed(0)}s`
          : `${(durationMs / 60000).toFixed(1)}m`;
        console.log(`  Since: ${auto.since} (${durationStr} ago)`);
      }
      if (auto.detail) {
        console.log(`  Trigger: ${auto.detail.trigger || '-'}`);
        if (auto.detail.matched_line) console.log(`  Matched: "${auto.detail.matched_line}"`);
        if (auto.detail.silence_ms) console.log(`  Silence: ${(auto.detail.silence_ms / 1000).toFixed(1)}s`);
        if (auto.detail.repeat_count) console.log(`  Error repeats: ${auto.detail.repeat_count}`);
      }
      if (auto.last_output_preview) {
        const preview = auto.last_output_preview.replace(/\n/g, '\\n').slice(-80);
        console.log(`  Last output: "${preview}"`);
      }

      if (selfReport.phase) {
        console.log(`\n  Self-report:`);
        console.log(`    Phase: ${selfReport.phase}`);
        if (selfReport.current_task) console.log(`    Task: ${selfReport.current_task}`);
        if (selfReport.blocker) console.log(`    Blocker: \x1b[31m${selfReport.blocker}${reset}`);
        if (selfReport.needs_input) console.log(`    Needs input: \x1b[35myes${reset}`);
      }
      console.log('');
    } catch (e) {
      console.error(`❌ ${e.message || 'Failed to get session state.'}`);
      process.exit(1);
    }
    return;
  }

  if (cmd === 'status-report') {
    const reportArgs = args.slice(1);
    let sessionId = process.env.TELEPTY_SESSION_ID || undefined;

    const idIndex = reportArgs.indexOf('--id');
    if (idIndex !== -1) {
      if (!reportArgs[idIndex + 1]) {
        console.error('❌ Usage: telepty status-report [--id <session_id>] --phase <phase> [--task <text>] [--blocker <text>] [--needs-input] [--thread-id <id>] [--seq <n>]');
        process.exit(1);
      }
      sessionId = reportArgs[idIndex + 1];
      reportArgs.splice(idIndex, 2);
    }

    function takeFlagValue(flag) {
      const index = reportArgs.indexOf(flag);
      if (index === -1) return undefined;
      if (!reportArgs[index + 1]) {
        console.error(`❌ ${flag} requires a value.`);
        process.exit(1);
      }
      const value = reportArgs[index + 1];
      reportArgs.splice(index, 2);
      return value;
    }

    const phase = takeFlagValue('--phase');
    const currentTask = takeFlagValue('--task') ?? takeFlagValue('--current-task');
    const blocker = takeFlagValue('--blocker');
    const threadId = takeFlagValue('--thread-id');
    const source = takeFlagValue('--source');
    const seqRaw = takeFlagValue('--seq');
    const needsInputIndex = reportArgs.indexOf('--needs-input');
    const needsInput = needsInputIndex !== -1;
    if (needsInput) reportArgs.splice(needsInputIndex, 1);

    if (!sessionId || !phase || reportArgs.length > 0) {
      console.error('❌ Usage: telepty status-report [--id <session_id>] --phase <phase> [--task <text>] [--blocker <text>] [--needs-input] [--thread-id <id>] [--seq <n>]');
      process.exit(1);
    }

    if (seqRaw !== undefined && (!Number.isInteger(Number(seqRaw)) || Number(seqRaw) < 0)) {
      console.error('❌ --seq must be a non-negative integer.');
      process.exit(1);
    }

    try {
      const target = await resolveSessionTarget(sessionId);
      if (!target) {
        console.error(`❌ Session '${sessionId}' was not found on any discovered host.`);
        process.exit(1);
      }
      if (isRemoteSession(target)) {
        console.error('❌ telepty status-report currently supports local daemon sessions only.');
        process.exit(1);
      }

      const res = await fetchWithAuth(`${daemonUrl(target.host)}/api/sessions/${encodeURIComponent(target.id)}/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildSessionStateReportBody({
          phase,
          currentTask,
          blocker,
          needsInput,
          threadId,
          source,
          seq: seqRaw === undefined ? undefined : Number(seqRaw)
        }))
      });
      const data = await res.json();
      if (!res.ok) {
        console.error(`❌ ${formatApiError(data)}`);
        return;
      }
      console.log(`✅ Session state reported for '\x1b[36m${target.id}\x1b[0m' (${phase}).`);
    } catch (e) {
      console.error(`❌ ${e.message || 'Failed to report session state.'}`);
    }
    return;
  }

  if (cmd === 'multicast') {
    const sessionIdsRaw = args[1]; const prompt = args.slice(2).join(' ');
    if (!sessionIdsRaw || !prompt) { console.error('❌ Usage: telepty multicast <id1,id2,...> "<prompt text>"'); process.exit(1); }
    const sessionRefs = sessionIdsRaw.split(',').map(s => s.trim()).filter(s => s);
    try {
      const discovered = await discoverSessions({ silent: true });
      const groupedTargets = new Map();
      for (const sessionRef of sessionRefs) {
        const target = await resolveSessionTarget(sessionRef, { sessions: discovered });
        if (!target) {
          throw new Error(`Session '${sessionRef}' was not found on any discovered host.`);
        }
        if (!groupedTargets.has(target.host)) {
          groupedTargets.set(target.host, []);
        }
        groupedTargets.get(target.host).push(target.id);
      }

      const aggregate = { successful: [], failed: [] };
      for (const [host, ids] of groupedTargets.entries()) {
        const res = await fetchWithAuth(`${daemonUrl(host)}/api/sessions/multicast/inject`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_ids: ids, prompt })
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(formatApiError(data, `Multicast failed on ${host}`));
        }
        aggregate.successful.push(...data.results.successful.map((id) => `${id}@${host}`));
        aggregate.failed.push(...data.results.failed.map((item) => ({ ...item, host })));
      }

      console.log(`✅ Context multicasted successfully to ${aggregate.successful.length} session(s).`);
      if (aggregate.failed.length > 0) {
        console.warn(`⚠️ Failed to inject into ${aggregate.failed.length} session(s):`, aggregate.failed.map((item) => `${item.id}@${item.host} [${item.code || 'UNKNOWN'}] ${item.error || ''}`.trim()).join(', '));
      }
    } catch (e) { console.error(`❌ ${e.message || 'Failed to connect to the target daemon.'}`); }
    return;
  }

  if (cmd === 'broadcast') {
    const { useRef, refFilePath } = parseRefOption(args);

    const prompt = args.slice(1).join(' ');
    if (!prompt && !refFilePath) { console.error('❌ Usage: telepty broadcast [--ref [file]] "<prompt text>"'); process.exit(1); }
    try {
      const discovered = await discoverSessions({ silent: true });
      const aggregate = { successful: [], failed: [] };
      const { local, remoteByPeer } = splitSessionsByTransport(discovered);
      let descriptor = useRef ? createSharedReferenceDescriptor(prompt, refFilePath) : null;
      let referencePath = null;

      if (local.length > 0) {
        let localPrompt = prompt;
        if (useRef) {
          const reference = ensureLocalSharedReference(descriptor, refFilePath ? prompt : '');
          descriptor = reference.descriptor;
          referencePath = reference.referencePath;
          localPrompt = reference.prompt;
        }

        for (const host of groupSessionsByHost(local).keys()) {
          const res = await fetchWithAuth(`${daemonUrl(host)}/api/sessions/broadcast/inject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: localPrompt })
          });
          const data = await res.json();
          if (!res.ok) {
            throw new Error(formatApiError(data, `Broadcast failed on ${host}`));
          }
          aggregate.successful.push(...data.results.successful.map((id) => `${id}@${host}`));
          aggregate.failed.push(...data.results.failed.map((item) => ({ ...item, host })));
        }
      }

      for (const [peerName, sessions] of remoteByPeer.entries()) {
        let remotePrompt = prompt;
        if (useRef) {
          const reference = ensureRemoteSharedReference(peerName, descriptor, refFilePath ? prompt : '');
          referencePath ||= reference.referencePath;
          remotePrompt = reference.prompt;
        }

        for (const session of sessions) {
          const result = crossMachine.remoteInject(peerName, session.id, remotePrompt);
          if (result.success) {
            aggregate.successful.push(`${session.id}@${session.host}`);
          } else {
            aggregate.failed.push({ id: session.id, host: session.host, error: result.error });
          }
        }
      }

      const refSuffix = referencePath ? ` (ref: ${referencePath})` : '';
      console.log(`✅ Context broadcasted successfully to ${aggregate.successful.length} active session(s).${refSuffix}`);
      if (aggregate.failed.length > 0) {
        console.warn(`⚠️ Failed to inject into ${aggregate.failed.length} session(s):`, aggregate.failed.map((item) => `${item.id}@${item.host} [${item.code || 'UNKNOWN'}] ${item.error || ''}`.trim()).join(', '));
      }
    } catch (e) { console.error(`❌ ${e.message || 'Failed to connect to the target daemon.'}`); }
    return;
  }

  if (cmd === 'delete') {
    const sessionRef = args[1];
    if (!sessionRef) { console.error('❌ Usage: telepty delete <session-id>'); process.exit(1); }
    try {
      const target = await resolveSessionTarget(sessionRef);
      if (!target) { console.error(`❌ Session '${sessionRef}' not found.`); process.exit(1); }
      const res = await fetchWithAuth(`${daemonUrl(target.host)}/api/sessions/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) { console.error(`❌ Error: ${data.error}`); return; }
      console.log(`✅ Session '\x1b[36m${target.id}\x1b[0m' deleted.`);
    } catch (e) { console.error(`❌ ${e.message || 'Failed to delete session.'}`); }
    return;
  }

  if (cmd === 'kill') {
    const killArgs = args.slice(1);
    const force = killArgs.includes('--force');
    const timeoutIndex = killArgs.indexOf('--timeout');
    let timeout = 5;
    if (timeoutIndex !== -1) {
      if (!killArgs[timeoutIndex + 1]) {
        console.error('❌ Usage: telepty kill <session-id> [--force] [--timeout <sec>]');
        process.exit(1);
      }
      timeout = Number(killArgs[timeoutIndex + 1]);
      if (!Number.isFinite(timeout) || timeout < 0) {
        console.error('❌ --timeout must be a non-negative number of seconds.');
        process.exit(1);
      }
      killArgs.splice(timeoutIndex, 2);
    }
    const filtered = killArgs.filter((item) => item !== '--force');
    const sessionRef = filtered[0];
    if (!sessionRef) { console.error('❌ Usage: telepty kill <session-id> [--force] [--timeout <sec>]'); process.exit(1); }

    try {
      const target = await resolveSessionTarget(sessionRef);
      if (!target) { console.error(`❌ Session '${sessionRef}' not found.`); process.exit(1); }
      const res = await fetchWithAuth(`${daemonUrl(target.host)}/api/sessions/${encodeURIComponent(target.id)}/kill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force, timeout, source: 'cli' })
      });
      const data = await res.json();
      if (!res.ok) {
        console.error(`❌ Error: ${data.error || 'Failed to kill session.'}`);
        process.exit(1);
      }
      console.log(`✅ Session '\x1b[36m${target.id}\x1b[0m' killed${data.kill && data.kill.escalated ? ' (escalated)' : ''}.`);
    } catch (e) {
      console.error(`❌ ${e.message || 'Failed to kill session.'}`);
      process.exit(1);
    }
    return;
  }

  if (cmd === 'clean') {
    try {
      const cleanArgs = args.slice(1);
      const dryRun = cleanArgs.includes('--dry-run');
      const idle = cleanArgs.includes('--idle');
      const olderThanIndex = cleanArgs.indexOf('--older-than');
      let olderThanMs = null;
      if (olderThanIndex !== -1) {
        if (!cleanArgs[olderThanIndex + 1]) {
          console.error('❌ Usage: telepty clean [--older-than <duration>] [--idle] [--dry-run]');
          process.exit(1);
        }
        try {
          olderThanMs = lifecycle.parseDuration(cleanArgs[olderThanIndex + 1], { fieldName: '--older-than' });
        } catch (err) {
          console.error(`❌ ${err.message}`);
          process.exit(1);
        }
        if (olderThanMs == null) {
          console.error('❌ --older-than must be a duration like 30m, 1h, or 2d.');
          process.exit(1);
        }
      }

      const sessions = await discoverSessions({ silent: true });
      if (sessions.length === 0) { console.log('No sessions found.'); return; }
      if (olderThanMs !== null) {
        const targets = lifecycle.selectCleanOlderThanTargets(sessions, {
          olderThanMs,
          idle,
          nowMs: Date.now()
        });
        if (targets.length === 0) {
          console.log(`✅ No ${idle ? 'idle ' : ''}sessions older than ${cleanArgs[olderThanIndex + 1]} found.`);
          return;
        }
        if (dryRun) {
          targets.forEach((target) => {
            console.log(`  Would remove: \x1b[36m${target.id}\x1b[0m (${target.reference}, ${Math.floor(target.ageSeconds / 60)}m old)`);
          });
          console.log(`✅ Dry run: ${targets.length} session(s) would be removed.`);
          return;
        }

        let cleaned = 0;
        for (const target of targets) {
          try {
            const host = target.session.host || '127.0.0.1';
            const res = await fetchWithAuth(`${daemonUrl(host)}/api/sessions/${encodeURIComponent(target.id)}/kill`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ force: false, timeout: 5, source: 'clean', reason: idle ? 'CLEAN_IDLE_OLDER_THAN' : 'CLEAN_OLDER_THAN' })
            });
            if (res.ok) {
              console.log(`  🗑  Removed session: \x1b[36m${target.id}\x1b[0m (${target.reference})`);
              cleaned++;
            }
          } catch (_) {}
        }
        console.log(cleaned > 0 ? `✅ Cleaned ${cleaned} session(s).` : '✅ No sessions cleaned.');
        return;
      }

      let cleaned = 0;
      for (const s of sessions) {
        if (s.healthStatus === 'STALE' || s.healthStatus === 'DISCONNECTED') {
          try {
            const host = s.host || '127.0.0.1';
            const res = await fetchWithAuth(`${daemonUrl(host)}/api/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
            if (res.ok) { console.log(`  🗑  Removed ghost: \x1b[36m${s.id}\x1b[0m (${s.healthStatus})`); cleaned++; }
          } catch (_) {}
        }
      }
      console.log(cleaned > 0 ? `✅ Cleaned ${cleaned} ghost session(s).` : '✅ No ghost sessions found.');
    } catch (e) { console.error(`❌ ${e.message || 'Failed to clean sessions.'}`); }
    return;
  }

  if (cmd === 'rename') {
    const oldId = args[1]; const newId = args[2];
    if (!oldId || !newId) { console.error('❌ Usage: telepty rename <old_id> <new_id>'); process.exit(1); }
    try {
      const target = await resolveSessionTarget(oldId);
      if (!target) {
        console.error(`❌ Session '${oldId}' was not found on any discovered host.`);
        process.exit(1);
      }

      const res = await fetchWithAuth(`${daemonUrl(target.host)}/api/sessions/${encodeURIComponent(target.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ new_id: newId })
      });
      const data = await res.json();
      if (!res.ok) { console.error(`❌ Error: ${data.error}`); return; }
      const hostSuffix = target.host === '127.0.0.1' ? '' : ` @ ${target.host}`;
      console.log(`✅ Session renamed: '\x1b[36m${target.id}\x1b[0m' → '\x1b[36m${newId}\x1b[0m'${hostSuffix}`);
    } catch (e) { console.error(`❌ ${e.message || 'Failed to connect to the target daemon.'}`); }
    return;
  }

  if (cmd === 'session' && args[1] === 'info') {
    const sessionRef = args[2];
    if (!sessionRef) {
      console.error('❌ Usage: telepty session info <id[@host]>');
      process.exit(1);
    }

    try {
      const sessions = await discoverSessions({ silent: true });
      const target = await resolveSessionTarget(sessionRef, { sessions });
      if (!target) {
        console.error(`❌ Session '${sessionRef}' was not found on any discovered host.`);
        process.exit(1);
      }

      if (args.includes('--json')) {
        if (isRemoteSession(target)) {
          console.log(JSON.stringify(target, null, 2));
          return;
        }

        const res = await fetchWithAuth(`${daemonUrl(target.host)}/api/sessions/${encodeURIComponent(target.id)}`);
        const data = await res.json();
        if (!res.ok) {
          console.error(`❌ Error: ${data.error}`);
          process.exit(1);
        }
        console.log(JSON.stringify({ host: target.host, ...data }, null, 2));
        return;
      }

      if (isRemoteSession(target)) {
        printSessionInfo(target, { host: target.host });
        return;
      }

      const res = await fetchWithAuth(`${daemonUrl(target.host)}/api/sessions/${encodeURIComponent(target.id)}`);
      const data = await res.json();
      if (!res.ok) {
        console.error(`❌ Error: ${data.error}`);
        process.exit(1);
      }

      printSessionInfo(data, { host: target.host });
    } catch (e) {
      console.error(`❌ ${e.message || 'Failed to fetch session info.'}`);
    }
    return;
  }

  if (cmd === 'session' && args[1] === 'start') {
    // Generate kitty session file and launch
    const configArg = args.find(a => a.startsWith('--config='));
    const configPath = configArg ? configArg.split('=').slice(1).join('=') : null;
    const cliArg = args.find(a => a.startsWith('--cli='));
    const cli = cliArg ? cliArg.split('=')[1] : 'claude --dangerously-skip-permissions --continue';
    const projectsDir = args.find(a => a.startsWith('--dir=')) ? args.find(a => a.startsWith('--dir=')).split('=')[1] : process.cwd();

    // Discover project folders (subdirectories with .git)
    let projects;
    if (configPath) {
      projects = JSON.parse(fs.readFileSync(sanitizePathArg(configPath, 'config'), 'utf8')).projects;
    } else {
      const resolvedDir = sanitizePathArg(projectsDir, 'dir');
      projects = fs.readdirSync(sanitizePathArg(projectsDir, 'dir'), { withFileTypes: true })
        .filter(d => d.isDirectory() && fs.existsSync(path.join(resolvedDir, d.name, '.git')))
        .map(d => ({ name: d.name, cwd: path.join(resolvedDir, d.name) }));
    }

    if (projects.length === 0) {
      console.error('❌ No git projects found in', projectsDir);
      process.exit(1);
    }

    // Resolve full paths (kitty @ launch has no shell PATH)
    const cliParts = cli.split(' ');
    let teleptyFullPath, cliFullPath;
    try {
      teleptyFullPath = execSync('which telepty', { encoding: 'utf8' }).trim();
    } catch {
      teleptyFullPath = process.argv[1];
    }
    try {
      cliFullPath = execSync(`which ${cliParts[0]}`, { encoding: 'utf8' }).trim();
    } catch {
      cliFullPath = cliParts[0];
    }
    const cliFullArgs = cliParts.slice(1).join(' ');
    const nodeFullPath = process.execPath; // Bypass #!/usr/bin/env node shebang (nvm not in PATH for non-interactive shells)

    // Generate kitty session file
    const sessionFile = path.join(os.tmpdir(), `telepty-session-${Date.now()}.conf`);
    let conf = '# Auto-generated telepty session\n';
    projects.forEach((p, i) => {
      const name = p.name;
      const cwd = p.cwd || path.join(projectsDir, name);
      const sessionId = `${name}-${cli.split(' ')[0]}`;
      if (i === 0) {
        conf += `new_tab ${name}\n`;
      } else {
        conf += `\nnew_tab ${name}\n`;
      }
      conf += `layout tall\n`;
      conf += `cd ${cwd}\n`;
      conf += `title ${name}\n`;
      conf += `env TELEPTY_SESSION_ID=\n`;
      conf += `env PATH=${process.env.PATH}\n`;
      conf += `launch --type=window /bin/zsh -c 'unset TELEPTY_SESSION_ID; ${nodeFullPath} ${teleptyFullPath} allow --id ${sessionId} ${cliFullPath}${cliFullArgs ? ' ' + cliFullArgs : ''}'\n`;
    });

    fs.writeFileSync(sessionFile, conf);
    console.log(`✅ Kitty session file: ${sessionFile}`);
    console.log(`   ${projects.length} projects, CLI: ${cli}`);

    // Auto-launch if --launch flag
    if (args.includes('--launch')) {
      const { spawn, execFileSync } = require('child_process');

      // Detect existing kitty instance via remote control socket
      let kittySocket = null;
      try {
        const sockFiles = fs.readdirSync('/tmp').filter(f => f.startsWith('kitty-sock'));
        if (sockFiles.length > 0) {
          const candidate = '/tmp/' + sockFiles[0];
          // Verify socket is alive
          execFileSync('kitty', ['@', '--to', `unix:${candidate}`, 'ls'], {
            timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
          });
          kittySocket = candidate;
        }
      } catch { kittySocket = null; }

      if (kittySocket) {
        // Launch tabs in existing kitty instance (single Dock icon, kitty @ controllable)
        let launched = 0;
        for (const p of projects) {
          const name = p.name;
          const cwd = p.cwd || path.join(projectsDir, name);
          const sessionIdForProject = `${name}-${cli.split(' ')[0]}`;
          const shellCmd = `unset TELEPTY_SESSION_ID; ${nodeFullPath} ${teleptyFullPath} allow --id ${sessionIdForProject} ${cliFullPath}${cliFullArgs ? ' ' + cliFullArgs : ''}`;
          const launchArgs = ['@', '--to', `unix:${kittySocket}`,
            'launch', '--type=os-window', '--cwd', cwd,
            '--env', 'TELEPTY_SESSION_ID=',
            '--env', `PATH=${process.env.PATH}`,
            '/bin/zsh', '-c', shellCmd];
          try {
            execFileSync('kitty', launchArgs, { timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
            launched++;
          } catch (e) {
            console.error(`⚠️  Failed to launch tab for ${name}: ${e.message}`);
          }
        }
        console.log(`🚀 ${launched}/${projects.length} tabs launched in existing kitty instance.`);
      } else {
        // No existing kitty — start a new instance with session file
        console.log(`\n   Launch: kitty --session ${sessionFile}\n`);
        spawn('kitty', ['--session', sessionFile], { detached: true, stdio: 'ignore' }).unref();
        console.log('🚀 Kitty launched (new instance).');
      }
    } else {
      console.log(`\n   Launch: kitty --session ${sessionFile}\n`);
    }
    return;
  }

  if (cmd === 'layout') {
    const layoutType = args[1] || 'grid';
    const validLayouts = ['grid', 'tall', 'stack'];
    if (!validLayouts.includes(layoutType)) {
      console.error(`❌ Invalid layout: ${layoutType}. Valid: ${validLayouts.join(', ')}`);
      process.exit(1);
    }

    await ensureDaemonRunning();
    const { execSync } = require('child_process');

    // Get active session count for grid calculation
    try {
      const sessionsRes = await fetchWithAuth(`${DAEMON_URL}/api/sessions`);
      const sessionsList = await sessionsRes.json();
      const activeIds = Object.keys(sessionsList);
      if (activeIds.length === 0) {
        console.log('No active sessions to arrange.');
        return;
      }
    } catch (e) {
      console.error('❌ Could not fetch sessions:', e.message);
      process.exit(1);
    }

    // Detect kitty process name
    let processName = 'kitty';
    try {
      execSync(`osascript -e 'tell application "System Events" to get name of first process whose name is "kitty"'`, {
        timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch {
      processName = 'stable';
    }

    // Get screen dimensions
    let screenW = 2560, screenH = 1440;
    try {
      const bounds = execSync(`osascript -e 'tell application "Finder" to get bounds of window of desktop'`, {
        encoding: 'utf8', timeout: 3000
      }).trim();
      const parts = bounds.split(', ');
      screenW = parseInt(parts[2]);
      screenH = parseInt(parts[3]);
    } catch {}

    const menuBarH = 25;
    const dockH = 70;
    const usableH = screenH - menuBarH - dockH;

    // Build AppleScript — collect windows from ALL kitty process instances
    // (kitty --session spawns separate processes, each with its own window)
    const collectWindows = `
          set wList to {}
          set kittyProcs to every process whose name is "${processName}"
          repeat with p in kittyProcs
            repeat with w in (every window of p)
              set end of wList to w
            end repeat
          end repeat
          set n to count of wList
          if n = 0 then return "0"`;

    let layoutBody;
    if (layoutType === 'grid') {
      layoutBody = `
            set numCols to (n ^ 0.5) as integer
            if numCols * numCols < n then set numCols to numCols + 1
            set numRows to ((n - 1) div numCols) + 1
            set cellW to ${screenW} div numCols
            set cellH to ${usableH} div numRows
            repeat with i from 1 to n
              set c to ((i - 1) mod numCols)
              set r to ((i - 1) div numCols)
              set position of (item i of wList) to {c * cellW, ${menuBarH} + r * cellH}
              set size of (item i of wList) to {cellW, cellH}
            end repeat`;
    } else if (layoutType === 'tall') {
      layoutBody = `
            set halfW to ${screenW} div 2
            if n = 1 then
              set position of (item 1 of wList) to {0, ${menuBarH}}
              set size of (item 1 of wList) to {${screenW}, ${usableH}}
            else
              set position of (item 1 of wList) to {0, ${menuBarH}}
              set size of (item 1 of wList) to {halfW, ${usableH}}
              set rightH to ${usableH} div (n - 1)
              repeat with i from 2 to n
                set y to ${menuBarH} + ((i - 2) * rightH)
                set position of (item i of wList) to {halfW, y}
                set size of (item i of wList) to {halfW, rightH}
              end repeat
            end if`;
    } else if (layoutType === 'stack') {
      layoutBody = `
            set cellH to ${usableH} div n
            repeat with i from 1 to n
              set y to ${menuBarH} + ((i - 1) * cellH)
              set position of (item i of wList) to {0, y}
              set size of (item i of wList) to {${screenW}, cellH}
            end repeat`;
    }

    const script = `
        tell application "System Events"
          ${collectWindows}
          ${layoutBody}
          return n
        end tell`;

    try {
      const result = execSync(`osascript -e '${script}'`, { encoding: 'utf8', timeout: 10000 }).trim();
      if (result === '0') {
        console.log('⚠️  No kitty windows found. Sessions may be in tabs — use kitty @ launch --type=os-window for separate windows.');
      } else {
        console.log(`✅ Layout '${layoutType}' applied to ${result} kitty windows.`);
      }
    } catch (e) {
      console.error(`❌ Layout failed: ${e.message}`);
    }
    return;
  }

  if (cmd === 'deliberate') {
    await ensureDaemonRunning();
    const subCmd = args[1];

    if (subCmd === 'status') {
      // telepty deliberate status [thread_id]
      const threadId = args[2];
      try {
        if (threadId) {
          const resp = await fetchWithAuth(`${DAEMON_URL}/api/threads/${threadId}`);
          const thread = await resp.json();
          if (!resp.ok) { console.error('Error:', thread.error); process.exit(1); }
          console.log(`\n  Thread: ${thread.id}`);
          console.log(`  Topic: ${thread.topic}`);
          console.log(`  Status: ${thread.status}`);
          console.log(`  Orchestrator: ${thread.orchestrator_session_id || '(none)'}`);
          console.log(`  Participants: ${thread.participant_session_ids.join(', ') || '(none)'}`);
          console.log(`  Messages: ${thread.message_count}`);
          console.log(`  Created: ${thread.created_at}`);
          if (thread.closed_at) console.log(`  Closed: ${thread.closed_at}`);
          console.log();
        } else {
          const resp = await fetchWithAuth(`${DAEMON_URL}/api/threads`);
          const list = await resp.json();
          if (list.length === 0) {
            console.log('No deliberation threads found.');
          } else {
            console.log(`\n  Deliberation Threads (${list.length}):\n`);
            for (const t of list) {
              const icon = t.status === 'active' ? '🟢' : '⏹️';
              console.log(`  ${icon} ${t.id.slice(0, 8)}  ${t.status.padEnd(8)}  msgs:${t.message_count}  participants:${t.participant_count}  "${t.topic}"`);
            }
            console.log();
          }
        }
      } catch (err) {
        console.error('Failed:', err.message);
        process.exit(1);
      }
      return;
    }

    if (subCmd === 'end') {
      // telepty deliberate end <thread_id>
      const threadId = args[2];
      if (!threadId) { console.error('Usage: telepty deliberate end <thread_id>'); process.exit(1); }
      try {
        const resp = await fetchWithAuth(`${DAEMON_URL}/api/threads/${threadId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'closed' })
        });
        const result = await resp.json();
        if (!resp.ok) { console.error('Error:', result.error); process.exit(1); }
        console.log(`Deliberation thread ${threadId} closed.`);
      } catch (err) {
        console.error('Failed:', err.message);
        process.exit(1);
      }
      return;
    }

    // telepty deliberate --topic "..." [--sessions id1,id2,...] [--context path]
    // Extract flags
    const topicIdx = args.indexOf('--topic');
    const sessionsIdx = args.indexOf('--sessions');
    const contextIdx = args.indexOf('--context');

    const topic = topicIdx !== -1 && args[topicIdx + 1] ? args[topicIdx + 1] : null;
    const sessionsArg = sessionsIdx !== -1 && args[sessionsIdx + 1] ? args[sessionsIdx + 1] : null;
    const contextPath = contextIdx !== -1 && args[contextIdx + 1] ? args[contextIdx + 1] : null;

    if (!topic) {
      console.error('Usage: telepty deliberate --topic "topic description" [--sessions id1,id2,...] [--context file]');
      console.error('       telepty deliberate status [thread_id]');
      console.error('       telepty deliberate end <thread_id>');
      process.exit(1);
    }

    const orchestratorId = process.env.TELEPTY_SESSION_ID || null;

    // Read context file if provided
    let contextContent = null;
    if (contextPath) {
      try {
        contextContent = fs.readFileSync(sanitizePathArg(contextPath, 'context'), 'utf-8');
      } catch (err) {
        console.error(`Failed to read context file: ${err.message}`);
        process.exit(1);
      }
    }

    // Discover target sessions
    let targetSessions;
    try {
      const discovered = await discoverSessions({ silent: true });
      if (sessionsArg) {
        const requestedIds = sessionsArg.split(',').map(s => s.trim());
        targetSessions = discovered.filter(s => requestedIds.includes(s.id));
        const foundIds = targetSessions.map(s => s.id);
        const missing = requestedIds.filter(id => !foundIds.includes(id));
        if (missing.length > 0) {
          console.error(`Warning: Sessions not found: ${missing.join(', ')}`);
        }
      } else {
        // All sessions except orchestrator
        targetSessions = discovered.filter(s => s.id !== orchestratorId);
      }
    } catch (err) {
      console.error('Failed to discover sessions:', err.message);
      process.exit(1);
    }

    if (targetSessions.length === 0) {
      console.error('No target sessions found.');
      process.exit(1);
    }

    const participantIds = targetSessions.map(s => s.id);

    // Create thread on daemon
    let threadId;
    try {
      const resp = await fetchWithAuth(`${DAEMON_URL}/api/threads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic,
          orchestrator_session_id: orchestratorId,
          participant_session_ids: participantIds,
          context: contextContent
        })
      });
      const result = await resp.json();
      if (!resp.ok) { console.error('Error:', result.error); process.exit(1); }
      threadId = result.thread_id;
    } catch (err) {
      console.error('Failed to create thread:', err.message);
      process.exit(1);
    }

    // Build session directory
    const sessionDirectory = targetSessions.map(s => {
      const proj = s.cwd ? s.cwd.split('/').pop() : '(unknown)';
      return `  - ${s.id} (${s.command || 'unknown'}, project: ${proj})`;
    }).join('\n');

    // Build protocol template
    const protocolTemplate = `[from: ${orchestratorId || 'orchestrator'}] [reply-to: ${orchestratorId || 'orchestrator'}]

## Bidirectional Multi-Session Deliberation

**Thread ID:** ${threadId}
**Topic:** ${topic}
**Orchestrator:** ${orchestratorId || '(not set)'}

### Session Directory
${sessionDirectory}

${contextContent ? `### Context\n${contextContent}\n` : ''}
### Protocol Rules (MANDATORY)

1. **Always include sender identity**: Every message you send to another session MUST include \`[from: YOUR_SESSION_ID] [reply-to: YOUR_SESSION_ID]\` at the beginning.

2. **Use telepty for cross-session communication**: To send a message to another session:
   \`\`\`
   telepty inject --from YOUR_SESSION_ID --reply-to YOUR_SESSION_ID <target_session_id> "your message"
   \`\`\`
   Or use: \`telepty reply "your message"\` to reply to the last sender.

3. **Do NOT self-resolve cross-cutting concerns**: If a question involves another project's domain, ASK that session directly via telepty inject. Do not guess or assume.

4. **Sub-deliberation allowed**: You may initiate side conversations with specific sessions for detailed technical discussions.

5. **Thread tracking**: Include \`thread_id: ${threadId}\` in bus events for this deliberation.

6. **Completion**: When you believe the discussion on your part is complete, send a summary to the orchestrator (${orchestratorId || 'orchestrator'}).

### Your Task
Discuss the following topic from your project's perspective. Engage with other sessions to align on interfaces and implementation details.

**Topic:** ${topic}
`;

    // Inject protocol to all target sessions
    console.log(`\nStarting deliberation thread ${threadId.slice(0, 8)}...`);
    console.log(`Topic: ${topic}`);
    console.log(`Participants: ${participantIds.length}\n`);

    let successCount = 0;
    let failCount = 0;

    for (const session of targetSessions) {
      try {
        const host = session._host || '127.0.0.1';
        const body = {
          prompt: protocolTemplate,
          no_enter: true,
          from: orchestratorId,
          reply_to: orchestratorId,
          thread_id: threadId
        };
        const resp = await fetchWithAuth(`${daemonUrl(host)}/api/sessions/${encodeURIComponent(session.id)}/inject`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (resp.ok) {
          // Submit after text injection (300ms delay handled by daemon)
          setTimeout(async () => {
            try {
              await fetchWithAuth(`${daemonUrl(host)}/api/sessions/${encodeURIComponent(session.id)}/submit`, { method: 'POST' });
            } catch {}
          }, 500);
          console.log(`  ✅ Injected to ${session.id}`);
          successCount++;
        } else {
          const err = await resp.json();
          console.log(`  ❌ Failed ${session.id}: ${err.error}`);
          failCount++;
        }
      } catch (err) {
        console.log(`  ❌ Failed ${session.id}: ${err.message}`);
        failCount++;
      }
    }

    console.log(`\nDeliberation started: ${successCount} injected, ${failCount} failed`);
    console.log(`Thread ID: ${threadId}`);
    console.log(`Monitor: telepty deliberate status ${threadId}`);
    console.log(`End: telepty deliberate end ${threadId}`);

    // Wait for submit timeouts to complete
    await new Promise(resolve => setTimeout(resolve, 1500));
    return;
  }

  if (cmd === 'handoff') {
    const handoffCmd = args[1];

    if (!handoffCmd || handoffCmd === 'list') {
      // telepty handoff list [--status=pending]
      const statusFilter = args.find(a => a.startsWith('--status='));
      const qs = statusFilter ? `?status=${statusFilter.split('=')[1]}` : '';
      try {
        const resp = await fetchWithAuth(`${DAEMON_URL}/api/handoff${qs}`);
        const list = await resp.json();
        if (list.length === 0) {
          console.log('No handoffs found.');
        } else {
          console.log(`\n  Handoffs (${list.length}):\n`);
          for (const h of list) {
            const statusIcon = { pending: '⏳', claimed: '🔄', executing: '⚙️', completed: '✅', failed: '❌' }[h.status] || '?';
            console.log(`  ${statusIcon} ${h.id.slice(0, 8)}  ${h.status.padEnd(10)}  tasks:${h.task_count}  ${h.deliberation_id || '(no delib)'}  ${h.created_at}`);
          }
          console.log();
        }
      } catch (err) {
        console.error('Failed to list handoffs:', err.message);
        process.exit(1);
      }

    } else if (handoffCmd === 'drop') {
      // telepty handoff drop [--delib=ID] [--source=SESSION] [--auto-execute] < synthesis.json
      // Or: telepty handoff drop --summary="..." --tasks='[{"task":"do X","files":["a.js"]}]'
      const delibFlag = args.find(a => a.startsWith('--delib='));
      const sourceFlag = args.find(a => a.startsWith('--source='));
      const autoExec = args.includes('--auto-execute');
      const summaryFlag = args.find(a => a.startsWith('--summary='));
      const tasksFlag = args.find(a => a.startsWith('--tasks='));

      let synthesis;
      if (summaryFlag && tasksFlag) {
        synthesis = {
          summary: summaryFlag.split('=').slice(1).join('='),
          tasks: JSON.parse(tasksFlag.split('=').slice(1).join('='))
        };
      } else if (!process.stdin.isTTY) {
        // Read from stdin
        const chunks = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
        }
        synthesis = JSON.parse(Buffer.concat(chunks).toString());
      } else {
        console.error('Usage: telepty handoff drop --summary="..." --tasks=\'[...]\'');
        console.error('  Or pipe JSON: echo \'{"summary":"...","tasks":[...]}\' | telepty handoff drop');
        process.exit(1);
      }

      try {
        const resp = await fetchWithAuth(`${DAEMON_URL}/api/handoff`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deliberation_id: delibFlag ? delibFlag.split('=').slice(1).join('=') : null,
            source_session_id: sourceFlag ? sourceFlag.split('=').slice(1).join('=') : (process.env.TELEPTY_SESSION_ID || null),
            synthesis,
            auto_execute: autoExec
          })
        });
        const result = await resp.json();
        if (resp.ok) {
          console.log(`Handoff created: ${result.handoff_id}`);
        } else {
          console.error('Failed:', result.error);
          process.exit(1);
        }
      } catch (err) {
        console.error('Failed to create handoff:', err.message);
        process.exit(1);
      }

    } else if (handoffCmd === 'claim') {
      // telepty handoff claim <handoff_id> [--agent=SESSION_ID]
      const handoffId = args[2];
      if (!handoffId) {
        console.error('Usage: telepty handoff claim <handoff_id> [--agent=SESSION_ID]');
        process.exit(1);
      }
      const agentFlag = args.find(a => a.startsWith('--agent='));
      const agentId = agentFlag ? agentFlag.split('=').slice(1).join('=') : process.env.TELEPTY_SESSION_ID;
      if (!agentId) {
        console.error('Error: --agent=SESSION_ID or TELEPTY_SESSION_ID env required');
        process.exit(1);
      }

      try {
        const resp = await fetchWithAuth(`${DAEMON_URL}/api/handoff/${handoffId}/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_session_id: agentId })
        });
        const result = await resp.json();
        if (resp.ok) {
          console.log(`Claimed handoff ${handoffId}`);
        } else {
          console.error('Failed:', result.error);
          process.exit(1);
        }
      } catch (err) {
        console.error('Failed to claim handoff:', err.message);
        process.exit(1);
      }

    } else if (handoffCmd === 'status') {
      // telepty handoff status <handoff_id> [executing|completed|failed] [--message="..."]
      const handoffId = args[2];
      if (!handoffId) {
        console.error('Usage: telepty handoff status <handoff_id> [new_status] [--message="..."]');
        process.exit(1);
      }

      const newStatus = args[3] && !args[3].startsWith('--') ? args[3] : null;
      const msgFlag = args.find(a => a.startsWith('--message='));

      if (!newStatus) {
        // GET status
        try {
          const resp = await fetchWithAuth(`${DAEMON_URL}/api/handoff/${handoffId}`);
          const handoff = await resp.json();
          if (!resp.ok) {
            console.error('Error:', handoff.error);
            process.exit(1);
          }
          console.log(`\n  Handoff: ${handoff.id}`);
          console.log(`  Status: ${handoff.status}`);
          console.log(`  Deliberation: ${handoff.deliberation_id || '(none)'}`);
          console.log(`  Claimed by: ${handoff.claimed_by || '(unclaimed)'}`);
          console.log(`  Tasks: ${Array.isArray(handoff.synthesis.tasks) ? handoff.synthesis.tasks.length : 0}`);
          if (handoff.synthesis.summary) console.log(`  Summary: ${handoff.synthesis.summary}`);
          if (handoff.progress.length > 0) {
            console.log(`  Progress:`);
            for (const p of handoff.progress) {
              console.log(`    - ${p.timestamp}: ${p.message}`);
            }
          }
          console.log();
        } catch (err) {
          console.error('Failed:', err.message);
          process.exit(1);
        }
      } else {
        // PATCH status
        try {
          const resp = await fetchWithAuth(`${DAEMON_URL}/api/handoff/${handoffId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              status: newStatus,
              message: msgFlag ? msgFlag.split('=').slice(1).join('=') : null
            })
          });
          const result = await resp.json();
          if (resp.ok) {
            console.log(`Handoff ${handoffId} -> ${newStatus}`);
          } else {
            console.error('Failed:', result.error);
            process.exit(1);
          }
        } catch (err) {
          console.error('Failed:', err.message);
          process.exit(1);
        }
      }

    } else if (handoffCmd === 'get') {
      // telepty handoff get <handoff_id> — dump full synthesis JSON
      const handoffId = args[2];
      if (!handoffId) {
        console.error('Usage: telepty handoff get <handoff_id>');
        process.exit(1);
      }
      try {
        const resp = await fetchWithAuth(`${DAEMON_URL}/api/handoff/${handoffId}`);
        const handoff = await resp.json();
        if (!resp.ok) {
          console.error('Error:', handoff.error);
          process.exit(1);
        }
        // Output raw JSON for piping to other tools
        console.log(JSON.stringify(handoff.synthesis, null, 2));
      } catch (err) {
        console.error('Failed:', err.message);
        process.exit(1);
      }

    } else {
      console.error(`Unknown handoff command: ${handoffCmd}`);
      console.error('Available: list, drop, claim, status, get');
      process.exit(1);
    }
    return;
  }

  // telepty connect <target> [--name <name>] [--port <port>]
  if (cmd === 'connect') {
    const target = args[1];
    if (!target) {
      console.error('❌ Usage: telepty connect <user@host> [--name <name>] [--port <port>]');
      process.exit(1);
    }
    const nameFlag = args.indexOf('--name');
    const portFlag = args.indexOf('--port');
    const options = {};
    if (nameFlag !== -1 && args[nameFlag + 1]) options.name = args[nameFlag + 1];
    if (portFlag !== -1 && args[portFlag + 1]) options.port = Number(args[portFlag + 1]);

    process.stdout.write(`\x1b[36m🔗 Connecting to ${target}...\x1b[0m\n`);
    const result = await crossMachine.connect(target, options);
    if (result.success) {
      console.log(`\x1b[32m✅ Connected to ${result.name}\x1b[0m`);
      console.log(`   Machine ID: ${result.machineId}`);
      console.log(`\nSessions on ${result.name} are now discoverable via \x1b[36mtelepty list\x1b[0m`);
    } else {
      console.error(`\x1b[31m❌ ${result.error}\x1b[0m`);
      process.exit(1);
    }
    return;
  }

  // telepty connect-http <host>[:port] [--name <name>] [--token <token>]
  // HTTP-only remote daemon registration (no SSH/sshd required).
  // Records peer in ~/.telepty/peers.json with transport='http' so subsequent
  // `telepty list`/`inject`/etc. discover sessions on the remote daemon via
  // its HTTP API. Designed for laptop daemons where running sshd is not
  // viable. See GitHub issue #13.
  if (cmd === 'connect-http') {
    const target = args[1];
    if (!target) {
      console.error('❌ Usage: telepty connect-http <host>[:port] [--name <name>] [--token <token>]');
      process.exit(1);
    }
    const nameFlag = args.indexOf('--name');
    const tokenFlag = args.indexOf('--token');
    const options = {};
    if (nameFlag !== -1 && args[nameFlag + 1]) options.name = args[nameFlag + 1];
    if (tokenFlag !== -1 && args[tokenFlag + 1]) options.token = args[tokenFlag + 1];

    process.stdout.write(`\x1b[36m🔗 Connecting to ${target} via HTTP...\x1b[0m\n`);
    try {
      const result = await crossMachine.connectHttp(target, options);
      if (result.success) {
        console.log(`\x1b[32m✅ Connected to ${result.name}\x1b[0m`);
        console.log(`   Host: ${result.host}:${result.port}`);
        console.log(`   Machine ID: ${result.machineId}`);
        console.log(`\nSessions on ${result.name} are now discoverable via \x1b[36mtelepty list\x1b[0m`);
      } else {
        console.error(`\x1b[31m❌ ${result.error}\x1b[0m`);
        process.exit(1);
      }
    } catch (err) {
      console.error(`\x1b[31m❌ ${err.message}\x1b[0m`);
      process.exit(1);
    }
    return;
  }

  // telepty disconnect [<name> | --all]
  if (cmd === 'disconnect') {
    if (args[1] === '--all') {
      const result = crossMachine.disconnectAll();
      console.log(`\x1b[32m✅ Disconnected from ${result.disconnected.length} peer(s)\x1b[0m`);
    } else if (args[1]) {
      const result = crossMachine.disconnect(args[1]);
      if (result.success) {
        console.log(`\x1b[32m✅ Disconnected from ${result.name}\x1b[0m`);
      } else {
        console.error(`\x1b[31m❌ ${result.error}\x1b[0m`);
      }
    } else {
      console.error('❌ Usage: telepty disconnect <name> | --all');
      process.exit(1);
    }
    return;
  }

  // telepty peers [--remove <name>]
  if (cmd === 'peers') {
    if (args[1] === '--remove' && args[2]) {
      crossMachine.removePeer(args[2]);
      console.log(`\x1b[32m✅ Removed peer ${args[2]}\x1b[0m`);
      return;
    }

    const active = crossMachine.listActivePeers();
    const known = crossMachine.listKnownPeers();
    const httpPeers = crossMachine.listHttpPeers();

    console.log('\x1b[1mConnected Peers (SSH ControlMaster):\x1b[0m');
    if (active.length === 0) {
      console.log('  (none)');
    } else {
      for (const peer of active) {
        console.log(`  \x1b[32m●\x1b[0m ${peer.name} (${peer.target}) → localhost:${peer.localPort} [${peer.machineId}]`);
      }
    }

    const knownNames = Object.keys(known);
    const httpNames = new Set(httpPeers.map((p) => p.name));
    const disconnected = knownNames.filter(n => !active.find(a => a.name === n) && !httpNames.has(n));
    if (disconnected.length > 0) {
      console.log('\n\x1b[1mKnown Peers (disconnected):\x1b[0m');
      for (const name of disconnected) {
        const p = known[name];
        console.log(`  \x1b[90m○\x1b[0m ${name} (${p.target}) — last: ${p.lastConnected || 'never'}`);
      }
    }

    if (httpPeers.length > 0) {
      console.log('\n\x1b[1mHTTP Peers (no SSH):\x1b[0m');
      for (const peer of httpPeers) {
        const tokenNote = peer.hasToken ? ' [token]' : '';
        console.log(`  \x1b[36m◆\x1b[0m ${peer.name} (${peer.host}:${peer.port}) [${peer.machineId}]${tokenNote}`);
      }
    }
    return;
  }

  if (cmd === 'listen' || cmd === 'monitor') {
    await ensureDaemonRunning();
    
    if (cmd === 'monitor') {
      console.log('\x1b[36m\x1b[1m📺 Telepty Event Billboard\x1b[0m');
      console.log('Listening for background agent communications...\n');
    } else {
      console.log('\x1b[36m👂 Listening to the telepty event bus...\x1b[0m');
    }

    const hosts = getDiscoveryHosts();
    let connectedHosts = 0;

    hosts.forEach((host) => {
      const wsUrl = `${daemonWsUrl(host)}/api/bus?token=${encodeURIComponent(getAuthToken())}`;
      const ws = new WebSocket(wsUrl);

      ws.on('open', () => {
        connectedHosts += 1;
      });

      ws.on('message', (message) => {
        const raw = message.toString();
        if (cmd === 'listen') {
          try {
            const payload = JSON.parse(raw);
            console.log(JSON.stringify({ host, ...payload }));
          } catch (e) {
            console.log(JSON.stringify({ host, raw }));
          }
          return;
        }

        try {
          const msg = JSON.parse(raw);
          const time = new Date().toLocaleTimeString();
          const sender = msg.sender || msg.from || 'Unknown';
          const target = msg.target_agent || msg.to || 'Bus';
          const hostLabel = formatHostLabel(host);

          let preview = msg.content || msg.message || msg.payload || msg.data;
          if (msg.type === 'session_spawn') {
            console.log(`\x1b[90m[${time}]\x1b[0m 🚀 \x1b[32m\x1b[1mNew Session\x1b[0m: \x1b[36m${msg.session_id}\x1b[0m (${msg.command}) @ ${hostLabel}`);
            return;
          }

          if (typeof preview === 'object') preview = JSON.stringify(preview);
          if (preview && preview.length > 200) preview = preview.substring(0, 197) + '...';

          console.log(`\x1b[90m[${time}]\x1b[0m \x1b[32m\x1b[1m${sender}\x1b[0m ➔ \x1b[33m\x1b[1m${target}\x1b[0m @ ${hostLabel}`);
          if (preview) console.log(`  \x1b[37m${preview}\x1b[0m\n`);
        } catch (e) {
          console.log(`\x1b[90m[${new Date().toLocaleTimeString()}]\x1b[0m 📦 \x1b[37m${raw}\x1b[0m @ ${formatHostLabel(host)}\n`);
        }
      });

      ws.on('close', () => {
        connectedHosts -= 1;
        if (connectedHosts <= 0) {
          console.error('\x1b[31m❌ Disconnected from event bus.\x1b[0m');
          process.exit(1);
        }
      });

      ws.on('error', (err) => {
        console.error(`\x1b[31m❌ WebSocket error (${formatHostLabel(host)}):\x1b[0m`, err.message);
      });
    });
    return;
  }

  console.log(`
\x1b[1mtelepty\x1b[0m — Connect any terminal to any terminal, any machine.

\x1b[1mSession Management:\x1b[0m
  telepty daemon                                 Start the background daemon (port 3848)
  telepty spawn --id <id> <command> [args...]    Spawn a new background session
  telepty allow [--id <id>] [--idle-ttl 1h|off] [--auto-restart] <command> [args...]  Wrap a CLI for remote control
  telepty list [--json]                          List sessions (local + Tailnet)
  telepty attach [id[@host]]                     Attach interactively (picker if no ID)
  telepty rename <old_id[@host]> <new_id>        Rename a session
  telepty kill <id[@host]> [--force] [--timeout N]  Gracefully terminate a session
  telepty clean [--older-than 7d] [--idle] [--dry-run]  Clean ghost or old sessions
  telepty session info <id[@host]> [--json]      Show session metadata

\x1b[1mInject & Communicate:\x1b[0m
  telepty inject [--ref [file]] [--from <id>] <id[@host]> "<prompt>"  Inject text
  telepty enter <id[@host]>                      Send Enter/Return
  telepty reply "<text>"                         Reply to last injector
  telepty multicast <id1,id2> "<prompt>"         Inject into multiple sessions
  telepty broadcast [--ref [file]] "<prompt>"    Inject into ALL sessions
  telepty read-screen <id[@host]> [--lines N]    Read session screen buffer

\x1b[1mCross-Machine:\x1b[0m
  telepty connect <user@host> [--name N] [--port P]      SSH tunnel to remote host
  telepty connect-http <host>[:port] [--name N] [--token T]  Register remote daemon via HTTP (no SSH)
  telepty disconnect <name> | --all              Disconnect remote host
  telepty peers [--remove <name>]                List connected peers

\x1b[1mMonitoring:\x1b[0m
  telepty tui                                    Full TUI dashboard
  telepty monitor                                Real-time event billboard
  telepty listen                                 Stream event bus as JSON

\x1b[1mHandoff:\x1b[0m
  telepty handoff list [--status=S]              List handoffs
  telepty handoff drop [options]                 Create handoff from synthesis
  telepty handoff claim <id> [--agent=S]         Claim a pending handoff
  telepty handoff status <id> [status]           Get/update handoff status

\x1b[1mDeliberation:\x1b[0m
  telepty deliberate --topic "..." [--sessions s1,s2]  Start multi-session discussion
  telepty deliberate status [thread_id]          Show thread details
  telepty deliberate end <thread_id>             Close a thread

\x1b[1mOther:\x1b[0m
  telepty update                                 Update to latest version
  telepty layout [grid|tall|stack]               Arrange terminal windows
  telepty status-report --phase <p> [options]    Emit structured status event

\x1b[1mExamples:\x1b[0m
  \x1b[2m# Wrap Claude Code for remote control\x1b[0m
  telepty allow --id my-claude claude

  \x1b[2m# Send a prompt to a session\x1b[0m
  telepty inject my-claude "explain the auth module"

  \x1b[2m# Read what a session is showing\x1b[0m
  telepty read-screen my-claude --lines 30

  \x1b[2m# Broadcast to all sessions\x1b[0m
  telepty broadcast "status report please"

  \x1b[2m# Inject into a session on another machine\x1b[0m
  telepty inject my-claude@server-01 "run the tests"
`);
}

// Guard the entry point so a test can `require('./cli.js')` to reach the exported pure helpers
// without dispatching the argv command. Behavior when run as the CLI is unchanged.
if (require.main === module) {
  main();
}

// Minimal test surface (no logic change) — pure decisions exposed for unit-testing.
module.exports = {
  classifyBackend,        // #29: TERM_PROGRAM/CMUX/kitty → backend string
  isDaemonDestroyClose,   // #17 OQ-2: 1000 'Session destroyed' → terminate-not-reconnect
  sanitizePathArg,        // #26: path-arg validation/normalization
};
