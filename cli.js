#!/usr/bin/env node

const path = require('path');
const os = require('os');
const fs = require('fs');
const WebSocket = require('ws');
const { execSync, spawn } = require('child_process');
const readline = require('readline');
const prompts = require('prompts');
const updateNotifier = require('update-notifier');
const pkg = require('./package.json');
const { getConfig } = require('./auth');
const { cleanupDaemonProcesses } = require('./daemon-control');
const { attachInteractiveTerminal, getTerminalSize } = require('./interactive-terminal');
const { getRuntimeInfo } = require('./runtime-info');
const { formatHostLabel, groupSessionsByHost, pickSessionTarget } = require('./session-routing');
const { runInteractiveSkillInstaller } = require('./skill-installer');
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

  if (stream.isTTY && typeof stream.setRawMode === 'function') {
    try {
      stream.setRawMode(false);
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

// Check for updates unless explicitly disabled for tests/CI.
if (!process.env.NO_UPDATE_NOTIFIER && !process.env.TELEPTY_DISABLE_UPDATE_NOTIFIER) {
  updateNotifier({pkg}).notify({ isGlobal: true });
}

// Support remote host via environment variable or default to localhost
let REMOTE_HOST = process.env.TELEPTY_HOST || '127.0.0.1';
const PORT = Number(process.env.TELEPTY_PORT || 3848);
let DAEMON_URL = `http://${REMOTE_HOST}:${PORT}`;
let WS_URL = `ws://${REMOTE_HOST}:${PORT}`;

const config = getConfig();
const TOKEN = config.authToken;

const fetchWithAuth = (url, options = {}) => {
  const headers = { ...options.headers, 'x-telepty-token': TOKEN };
  return fetch(url, { ...options, headers });
};

async function getDaemonMeta(host = REMOTE_HOST) {
  try {
    const res = await fetchWithAuth(`http://${host}:${PORT}/api/meta`, {
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

function startDetachedDaemon() {
  const cp = spawn(process.argv[0], [process.argv[1], 'daemon'], {
    detached: true,
    stdio: 'ignore'
  });
  cp.unref();
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

function runUpdateInstall() {
  if (process.env.TELEPTY_SKIP_PACKAGE_UPDATE === '1') {
    return;
  }

  const updateCommand = process.env.TELEPTY_UPDATE_COMMAND || 'npm install -g @dmsdc-ai/aigentry-telepty@latest';
  execSync(updateCommand, { stdio: 'inherit' });
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

  startDetachedDaemon();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const meta = await getDaemonMeta('127.0.0.1');
  return { stopped: results.stopped.length, failed: results.failed.length, meta };
}

function getDiscoveryHosts() {
  const hosts = new Set();

  if (REMOTE_HOST && REMOTE_HOST !== '127.0.0.1') {
    hosts.add(REMOTE_HOST);
  } else {
    hosts.add('127.0.0.1');
  }

  const extraHosts = String(process.env.TELEPTY_DISCOVERY_HOSTS || '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  extraHosts.forEach((host) => hosts.add(host));

  if (REMOTE_HOST && REMOTE_HOST !== '127.0.0.1') {
    return Array.from(hosts);
  }

  try {
    const tsStatus = execSync('tailscale status --json', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    const tsData = JSON.parse(tsStatus);
    if (tsData && tsData.Peer) {
      for (const peer of Object.values(tsData.Peer)) {
        if (peer.Online && peer.TailscaleIPs && peer.TailscaleIPs.length > 0) {
          hosts.add(peer.TailscaleIPs[0]);
        }
      }
    }
  } catch (e) {
    // Tailscale not available or not running, ignore
  }

  return Array.from(hosts);
}

async function discoverSessions(options = {}) {
  await ensureDaemonRunning();
  const hosts = getDiscoveryHosts();
  const allSessions = [];

  if (!options.silent) {
    process.stdout.write('\x1b[36m🔍 Discovering active sessions across your Tailnet...\x1b[0m\n');
  }

  await Promise.all(hosts.map(async (host) => {
    try {
      const res = await fetchWithAuth(`http://${host}:${PORT}/api/sessions`, {
        signal: AbortSignal.timeout(1500)
      });
      if (res.ok) {
        const sessions = await res.json();
        sessions.forEach((session) => {
          allSessions.push({ host, ...session });
        });
      }
    } catch (e) {
      // Ignore nodes that don't have telepty running
    }
  }));

  return allSessions;
}

async function resolveSessionTarget(sessionRef, options = {}) {
  const sessions = options.sessions || await discoverSessions({ silent: true });
  return pickSessionTarget(sessionRef, sessions, REMOTE_HOST);
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
      return;
    }

    if (sessionsRes.ok && !meta) {
      process.stdout.write('\x1b[33m⚙️ Found an older local telepty daemon. Restarting it...\x1b[0m\n');
      cleanupDaemonProcesses();
    } else if (sessionsRes.ok && meta) {
      process.stdout.write('\x1b[33m⚙️ Found a local telepty daemon without the required features. Restarting it...\x1b[0m\n');
      cleanupDaemonProcesses();
    }
  } catch (e) {
    // Continue to auto-start below.
  }

  process.stdout.write('\x1b[33m⚙️ Auto-starting local telepty daemon...\x1b[0m\n');
  cleanupDaemonProcesses();
  startDetachedDaemon();
  await new Promise(r => setTimeout(r, 1000));

  const meta = await getDaemonMeta('127.0.0.1');
  if (!meta || !requiredCapabilities.every((item) => meta.capabilities.includes(item))) {
    console.error('❌ Failed to start a compatible local telepty daemon. Open telepty and choose "Repair local daemon", or rerun the installer.');
  }
}

async function manageInteractiveAttach(sessionId, targetHost) {
  const wsUrl = `ws://${targetHost}:${PORT}/api/sessions/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(TOKEN)}`;
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
        const res = await fetchWithAuth(`http://${targetHost}:${PORT}/api/sessions`);
        if (res.ok) {
          const sessions = await res.json();
          const session = sessions.find(s => s.id === sessionId);
          if (session && session.active_clients > 0) {
            console.log(`\n\x1b[33mLeft room '${sessionId}'. Other clients still attached — session kept alive.\x1b[0m\n`);
          } else {
            console.log(`\n\x1b[33mLeft room '${sessionId}'. No other clients — destroying session.\x1b[0m\n`);
            await fetchWithAuth(`http://${targetHost}:${PORT}/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
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
          console.log(`  - \x1b[36m${s.id}\x1b[0m (\x1b[33m${hostLabel}\x1b[0m) [${s.command}] - Clients: ${s.active_clients}`);
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
          const res = await fetchWithAuth(`http://${target.host}:${PORT}/api/sessions/${encodeURIComponent(target.id)}/inject`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: promptText })
          });
          const data = await res.json();
          if (!res.ok) console.error(`\n❌ Error: ${data.error}\n`);
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
    require('./daemon.js');
    return;
  }

  if (cmd === 'list') {
    try {
      const sessions = await discoverSessions({ silent: true });
      if (sessions.length === 0) { console.log('No active sessions found.'); return; }
      console.log('\x1b[1mActive Sessions:\x1b[0m');
      sessions.forEach(s => {
        console.log(`  - ID: \x1b[36m${s.id}\x1b[0m`);
        console.log(`    Host: ${formatHostLabel(s.host)}`);
        console.log(`    Command: ${s.command}`);
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

    // Strip optional -- separator for backward compat
    const sepIndex = allowArgs.indexOf('--');
    if (sepIndex !== -1) allowArgs.splice(sepIndex, 1);

    const command = allowArgs[0];
    const cmdArgs = allowArgs.slice(1);

    if (!command) {
      console.error('❌ Usage: telepty allow [--id <session_id>] <command> [args...]');
      process.exit(1);
    }

    // Default session ID = command name
    if (!sessionId) {
      sessionId = path.basename(command);
    }

    await ensureDaemonRunning({ requiredCapabilities: ['wrapped-sessions'] });

    // Register session with daemon
    try {
      const res = await fetchWithAuth(`${DAEMON_URL}/api/sessions/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, command, cwd: process.cwd() })
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
    const child = pty.spawn(command, cmdArgs, {
      name: 'xterm-256color',
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 30,
      cwd: process.cwd(),
      env: { ...process.env, TELEPTY_SESSION_ID: sessionId }
    });

    // Prompt-ready detection for safe inject delivery
    const PROMPT_PATTERNS = {
      claude: /[❯>]\s*$/,
      gemini: /[❯>]\s*$/,
      codex: /[❯>]\s*$/,
    };
    const cmdBase = path.basename(command).replace(/\..*$/, '');
    const promptPattern = PROMPT_PATTERNS[cmdBase] || /[❯>$#%]\s*$/;
    let promptReady = true;  // assume ready initially for first inject
    const injectQueue = [];

    function flushInjectQueue() {
      if (injectQueue.length === 0) return;
      const batch = injectQueue.splice(0);
      let delay = 0;
      for (const item of batch) {
        setTimeout(() => child.write(item), delay);
        delay += item === '\r' ? 0 : 100;
      }
      promptReady = false;
    }

    // Connect to daemon WebSocket for inject reception and output relay
    const wsUrl = `ws://${REMOTE_HOST}:${PORT}/api/sessions/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(TOKEN)}`;
    const daemonWs = new WebSocket(wsUrl);
    let wsReady = false;

    daemonWs.on('open', () => {
      wsReady = true;
    });

    // Receive inject messages from daemon
    daemonWs.on('message', (message) => {
      try {
        const msg = JSON.parse(message);
        if (msg.type === 'inject') {
          if (promptReady) {
            child.write(msg.data);
            // After writing prompt text (not \r), mark as not ready until next prompt
            if (msg.data !== '\r' && msg.data.length > 1) {
              promptReady = false;
            }
          } else {
            injectQueue.push(msg.data);
          }
        } else if (msg.type === 'resize') {
          child.resize(msg.cols, msg.rows);
        }
      } catch (e) {
        // ignore malformed messages
      }
    });

    daemonWs.on('close', () => {
      wsReady = false;
      console.error(`\n\x1b[33m⚠️ Disconnected from daemon. Inject unavailable. Session continues locally.\x1b[0m`);
    });

    daemonWs.on('error', () => {
      // silently handle
    });

    // Set terminal title
    process.stdout.write(`\x1b]0;⚡ telepty :: ${sessionId}\x07`);
    console.log(`\x1b[32m⚡ '${command}' is now session '\x1b[36m${sessionId}\x1b[32m'. Inject allowed.\x1b[0m\n`);

    const cleanupTerminal = attachInteractiveTerminal(process.stdin, process.stdout, {
      onData: (data) => {
        child.write(data.toString());
      },
      onResize: () => {
        const size = getTerminalSize(process.stdout, { cols: 120, rows: 40 });
        child.resize(size.cols, size.rows);
      }
    });

    // Intercept terminal title escape sequences and prefix with session ID
    const titlePrefix = `\u26A1 ${sessionId}`;
    function rewriteTitleSequences(output) {
      // Match OSC title sequences: \x1b]0;TITLE\x07 or \x1b]2;TITLE\x07
      return output.replace(/\x1b\]([02]);([^\x07]*)\x07/g, (match, code, title) => {
        return `\x1b]${code};${titlePrefix} | ${title}\x07`;
      });
    }

    // Relay PTY output to current terminal + send to daemon for attach clients
    child.onData((data) => {
      const rewritten = rewriteTitleSequences(data);
      process.stdout.write(rewritten);
      if (wsReady && daemonWs.readyState === 1) {
        daemonWs.send(JSON.stringify({ type: 'output', data }));
      }
      // Detect prompt in output to enable inject delivery
      if (promptPattern.test(data)) {
        promptReady = true;
        flushInjectQueue();
      }
    });

    // Handle child exit
    child.onExit(({ exitCode }) => {
      cleanupTerminal();
      process.stdout.write(`\x1b]0;\x07`);
      console.log(`\n\x1b[33mSession '${sessionId}' exited (code ${exitCode}).\x1b[0m`);

      // Deregister from daemon
      fetchWithAuth(`${DAEMON_URL}/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).catch(() => {});
      daemonWs.close();
      process.exit(exitCode || 0);
    });

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

    const wsUrl = `ws://${targetHost}:${PORT}/api/sessions/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(TOKEN)}`;
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
        const res = await fetchWithAuth(`http://${targetHost}:${PORT}/api/sessions`);
        if (res.ok) {
          const allSessions = await res.json();
          const session = allSessions.find(s => s.id === sessionId);
          if (session && session.active_clients > 0) {
            console.log(`\n\x1b[33mLeft room '${sessionId}'. Other clients still attached — session kept alive.\x1b[0m`);
          } else {
            console.log(`\n\x1b[33mLeft room '${sessionId}'. No other clients — destroying session.\x1b[0m`);
            await fetchWithAuth(`http://${targetHost}:${PORT}/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
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

  if (cmd === 'inject') {
    // Check for --no-enter flag
    const noEnterIndex = args.indexOf('--no-enter');
    const noEnter = noEnterIndex !== -1;
    if (noEnter) args.splice(noEnterIndex, 1);

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

    const sessionId = args[1]; const prompt = args.slice(2).join(' ');
    if (!sessionId || !prompt) { console.error('❌ Usage: telepty inject [--no-enter] [--from <id>] [--reply-to <id>] <session_id> "<prompt text>"'); process.exit(1); }
    try {
      const target = await resolveSessionTarget(sessionId);
      if (!target) {
        console.error(`❌ Session '${sessionId}' was not found on any discovered host.`);
        process.exit(1);
      }

      const body = { prompt, no_enter: noEnter };
      if (fromId) body.from = fromId;
      if (replyTo) body.reply_to = replyTo;

      const res = await fetchWithAuth(`http://${target.host}:${PORT}/api/sessions/${encodeURIComponent(target.id)}/inject`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) { console.error(`❌ Error: ${data.error}`); return; }
      const hostSuffix = target.host === '127.0.0.1' ? '' : ` @ ${target.host}`;
      console.log(`✅ Context injected successfully into '\x1b[36m${target.id}\x1b[0m'${hostSuffix}.`);
    } catch (e) { console.error(`❌ ${e.message || 'Failed to connect to the target daemon.'}`); }
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
      const fullPrompt = `[from: ${mySessionId}] [reply-to: ${mySessionId}] ${replyText}`;
      const body = { prompt: fullPrompt, from: mySessionId, reply_to: mySessionId };
      const res = await fetchWithAuth(`http://${target.host}:${PORT}/api/sessions/${encodeURIComponent(target.id)}/inject`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) { console.error(`❌ Error: ${data.error}`); return; }
      console.log(`✅ Reply sent to '\x1b[36m${replyTo}\x1b[0m'.`);
    } catch (e) { console.error(`❌ ${e.message || 'Failed to connect to the target daemon.'}`); }
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
        const res = await fetchWithAuth(`http://${host}:${PORT}/api/sessions/multicast/inject`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_ids: ids, prompt })
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || `Multicast failed on ${host}`);
        }
        aggregate.successful.push(...data.results.successful.map((id) => `${id}@${host}`));
        aggregate.failed.push(...data.results.failed.map((item) => ({ ...item, host })));
      }

      console.log(`✅ Context multicasted successfully to ${aggregate.successful.length} session(s).`);
      if (aggregate.failed.length > 0) {
        console.warn(`⚠️ Failed to inject into ${aggregate.failed.length} session(s):`, aggregate.failed.map((item) => `${item.id}@${item.host}`).join(', '));
      }
    } catch (e) { console.error(`❌ ${e.message || 'Failed to connect to the target daemon.'}`); }
    return;
  }

  if (cmd === 'broadcast') {
    const prompt = args.slice(1).join(' ');
    if (!prompt) { console.error('❌ Usage: telepty broadcast "<prompt text>"'); process.exit(1); }
    try {
      const discovered = await discoverSessions({ silent: true });
      const grouped = groupSessionsByHost(discovered);
      const aggregate = { successful: [], failed: [] };

      for (const host of grouped.keys()) {
        const res = await fetchWithAuth(`http://${host}:${PORT}/api/sessions/broadcast/inject`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt })
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || `Broadcast failed on ${host}`);
        }
        aggregate.successful.push(...data.results.successful.map((id) => `${id}@${host}`));
        aggregate.failed.push(...data.results.failed.map((item) => ({ ...item, host })));
      }

      console.log(`✅ Context broadcasted successfully to ${aggregate.successful.length} active session(s).`);
      if (aggregate.failed.length > 0) {
        console.warn(`⚠️ Failed to inject into ${aggregate.failed.length} session(s):`, aggregate.failed.map((item) => `${item.id}@${item.host}`).join(', '));
      }
    } catch (e) { console.error(`❌ ${e.message || 'Failed to connect to the target daemon.'}`); }
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

      const res = await fetchWithAuth(`http://${target.host}:${PORT}/api/sessions/${encodeURIComponent(target.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ new_id: newId })
      });
      const data = await res.json();
      if (!res.ok) { console.error(`❌ Error: ${data.error}`); return; }
      const hostSuffix = target.host === '127.0.0.1' ? '' : ` @ ${target.host}`;
      console.log(`✅ Session renamed: '\x1b[36m${target.id}\x1b[0m' → '\x1b[36m${newId}\x1b[0m'${hostSuffix}`);
    } catch (e) { console.error(`❌ ${e.message || 'Failed to connect to the target daemon.'}`); }
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
        contextContent = fs.readFileSync(contextPath, 'utf-8');
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
        const resp = await fetchWithAuth(`http://${host}:${PORT}/api/sessions/${encodeURIComponent(session.id)}/inject`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (resp.ok) {
          // Submit after text injection (300ms delay handled by daemon)
          setTimeout(async () => {
            try {
              await fetchWithAuth(`http://${host}:${PORT}/api/sessions/${encodeURIComponent(session.id)}/submit`, { method: 'POST' });
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
      const wsUrl = `ws://${host}:${PORT}/api/bus?token=${encodeURIComponent(TOKEN)}`;
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
\x1b[1maigentry-telepty\x1b[0m - Remote PTY Control

Usage:
  telepty daemon                                 Start the background daemon
  telepty spawn --id <id> <command> [args...]    Spawn a new background CLI
  telepty allow [--id <id>] <command> [args...]       Allow inject on a CLI
  telepty list                                   List all active sessions across discovered hosts
  telepty attach [id[@host]]                     Attach to a session (Interactive picker if no ID)
  telepty inject [--no-enter] [--from <id>] [--reply-to <id>] <id[@host]> "<prompt>"    Inject text into a single session
  telepty reply "<text>"                         Reply to the session that last injected into $TELEPTY_SESSION_ID
  telepty multicast <id1[@host],id2[@host]> "<prompt>"  Inject text into multiple specific sessions
  telepty broadcast "<prompt>"                   Inject text into ALL active sessions
  telepty rename <old_id[@host]> <new_id>        Rename a session (updates terminal title too)
  telepty listen                                 Listen to the event bus and print JSON to stdout
  telepty monitor                                Human-readable real-time billboard of bus events
  telepty update                                 Update telepty to the latest version

  Handoff Commands:
    handoff list [--status=S]        List handoffs (filter: pending/claimed/executing/completed)
    handoff drop [options]           Create handoff from synthesis (pipe JSON or use --summary/--tasks)
    handoff claim <id> [--agent=S]   Claim a pending handoff
    handoff status <id> [status]     Get or update handoff status
    handoff get <id>                 Get full synthesis JSON (for piping)

  Deliberation Commands:
    deliberate --topic "..." [--sessions s1,s2] [--context file]
                                       Start multi-session deliberation
    deliberate status [thread_id]      List threads or show thread details
    deliberate end <thread_id>         Close a deliberation thread
`);
}

main();
