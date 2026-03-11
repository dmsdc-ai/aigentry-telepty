#!/usr/bin/env node

const path = require('path');
const os = require('os');
const WebSocket = require('ws');
const { execSync, spawn } = require('child_process');
const readline = require('readline');
const prompts = require('prompts');
const updateNotifier = require('update-notifier');
const pkg = require('./package.json');
const { getConfig } = require('./auth');
const { attachInteractiveTerminal } = require('./interactive-terminal');
const { runInteractiveSkillInstaller } = require('./skill-installer');
const args = process.argv.slice(2);

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

async function discoverSessions() {
  await ensureDaemonRunning();
  const hosts = ['127.0.0.1'];
  try {
    const tsStatus = execSync('tailscale status --json', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    const tsData = JSON.parse(tsStatus);
    if (tsData && tsData.Peer) {
      for (const peer of Object.values(tsData.Peer)) {
        if (peer.Online && peer.TailscaleIPs && peer.TailscaleIPs.length > 0) {
          hosts.push(peer.TailscaleIPs[0]);
        }
      }
    }
  } catch (e) {
    // Tailscale not available or not running, ignore
  }

  const allSessions = [];
  process.stdout.write('\x1b[36m🔍 Discovering active sessions across your Tailnet...\x1b[0m\n');
  
  await Promise.all(hosts.map(async (host) => {
    try {
      const res = await fetchWithAuth(`http://${host}:${PORT}/api/sessions`, { 
        signal: AbortSignal.timeout(1500) 
      });
      if (res.ok) {
        const sessions = await res.json();
        sessions.forEach(s => {
          allSessions.push({ host, ...s });
        });
      }
    } catch (e) {
      // Ignore nodes that don't have telepty running
    }
  }));

  return allSessions;
}

async function ensureDaemonRunning() {
  if (REMOTE_HOST !== '127.0.0.1') return; // Only auto-start local daemon
  try {
    const res = await fetchWithAuth(`${DAEMON_URL}/api/sessions`);
    if (res.ok) return; // Already running
  } catch (e) {
    // Not running, let's start it
    process.stdout.write('\x1b[33m⚙️ Auto-starting local telepty daemon...\x1b[0m\n');
    const cp = spawn(process.argv[0], [process.argv[1], 'daemon'], {
      detached: true,
      stdio: 'ignore'
    });
    cp.unref();
    
    // Wait a brief moment for the daemon to boot up
    await new Promise(r => setTimeout(r, 1000));
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
        onResize: () => ws.send(JSON.stringify({ type: 'resize', cols: process.stdout.columns, rows: process.stdout.rows }))
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
  console.clear();
  console.log('\x1b[36m\x1b[1m⚡ Telepty Agent Manager\x1b[0m\n');

  while (true) {
    const response = await prompts({
      type: 'select',
      name: 'action',
      message: 'What would you like to do?',
      choices: [
        { title: '🖥️   Enter a room (Attach to session)', value: 'attach' },
        { title: '➕  Create a new room (Spawn session)', value: 'spawn' },
        { title: '🔌  Allow inject (Run CLI with inject)', value: 'allow' },
        { title: '💬  Send message to a room (Inject command)', value: 'inject' },
        { title: '📋  View all open rooms (List sessions)', value: 'list' },
        { title: '🧠  Install telepty skills', value: 'install-skills' },
        { title: '🔄  Update telepty to latest version', value: 'update' },
        { title: '❌  Exit', value: 'exit' }
      ]
    });

    if (response.action === 'update') {
      console.log('\n\x1b[36m🔄 Updating telepty to the latest version...\x1b[0m');
      try {
        execSync('npm install -g @dmsdc-ai/aigentry-telepty@latest', { stdio: 'inherit' });
        console.log('\n\x1b[32m✅ Update complete! Restarting daemon...\x1b[0m');
        try {
          const os = require('os');
          if (os.platform() === 'win32') execSync('taskkill /IM node.exe /FI "WINDOWTITLE eq telepty daemon*" /F', { stdio: 'ignore' });
          else execSync('pkill -f "telepty daemon"', { stdio: 'ignore' });
        } catch(e) {}
      } catch (e) {
        console.error('\n❌ Update failed.\n');
      }
      process.exit(0);
    }

    if (!response.action || response.action === 'exit') {
      console.log('Goodbye!');
      process.exit(0);
    }

    if (response.action === 'daemon') {
      console.log('\n\x1b[33mStarting daemon in background...\x1b[0m');
      const cp = spawn(process.argv[0], [process.argv[1], 'daemon'], {
        detached: true,
        stdio: 'ignore'
      });
      cp.unref();
      console.log('✅ Daemon started.\n');
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
          const hostLabel = s.host === '127.0.0.1' ? 'Local' : s.host;
          console.log(`  - \x1b[36m${s.id}\x1b[0m (\x1b[33m${hostLabel}\x1b[0m) [${s.command}] - Clients: ${s.active_clients}`);
        });
      }
      console.log('\n');
      continue;
    }

    if (response.action === 'spawn') {
      const { id, command } = await prompts([
        { type: 'text', name: 'id', message: 'Enter new session ID (e.g. agent-1):', validate: v => v ? true : 'Required' },
        { type: 'text', name: 'command', message: 'Enter command to run (e.g. bash, zsh, python):', initial: 'bash' }
      ]);
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
      const { id, command } = await prompts([
        { type: 'text', name: 'id', message: 'Enter session ID (e.g. my-claude):', validate: v => v ? true : 'Required' },
        { type: 'text', name: 'command', message: 'Enter command to run (e.g. claude, codex, gemini, bash):', initial: 'bash' }
      ]);
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
      const { target } = await prompts({
        type: 'select',
        name: 'target',
        message: `Select a session to ${response.action}:`,
        choices: sessions.map(s => ({
          title: `${s.id} (${s.host === '127.0.0.1' ? 'Local' : s.host}) - ${s.command}`,
          value: s
        }))
      });

      if (!target) continue;

      if (response.action === 'attach') {
        await manageInteractiveAttach(target.id, target.host);
        continue;
      }

      if (response.action === 'inject') {
        const { promptText } = await prompts({
          type: 'text',
          name: 'promptText',
          message: 'Enter text to inject:',
          validate: v => v ? true : 'Required'
        });
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

  if (cmd === 'update') {
    console.log('\x1b[36m🔄 Updating telepty to the latest version...\x1b[0m');
    try {
      execSync('npm install -g @dmsdc-ai/aigentry-telepty@latest', { stdio: 'inherit' });
      console.log('\n\x1b[32m✅ Update complete! Restarting daemon...\x1b[0m');
      
      // Kill local daemon if running, so it auto-restarts on next command
      try {
        if (os.platform() === 'win32') {
          execSync('taskkill /IM node.exe /FI "WINDOWTITLE eq telepty daemon*" /F', { stdio: 'ignore' });
        } else {
          execSync('pkill -f "telepty daemon"', { stdio: 'ignore' });
        }
      } catch (e) {} // Ignore if not running

      console.log('🎉 You are now using the latest version.');
    } catch (e) {
      console.error('\n❌ Update failed. Please try running: npm install -g @dmsdc-ai/aigentry-telepty@latest');
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
      const res = await fetchWithAuth(`${DAEMON_URL}/api/sessions`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const sessions = await res.json();
      if (sessions.length === 0) { console.log('No active sessions found.'); return; }
      console.log('\x1b[1mActive Sessions:\x1b[0m');
      sessions.forEach(s => {
        console.log(`  - ID: \x1b[36m${s.id}\x1b[0m`);
        console.log(`    Command: ${s.command}`);
        console.log(`    CWD: ${s.cwd}`);
        console.log(`    Clients: ${s.active_clients}`);
        console.log(`    Started: ${new Date(s.createdAt).toLocaleString()}`);
        console.log('');
      });
    } catch (e) {
      console.error('❌ Failed to connect to daemon. Is it running? (run `telepty daemon`)');
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

    await ensureDaemonRunning();

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
          child.write(msg.data);
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
        child.resize(process.stdout.columns, process.stdout.rows);
      }
    });

    // Relay PTY output to current terminal + send to daemon for attach clients
    child.onData((data) => {
      process.stdout.write(data);
      if (wsReady && daemonWs.readyState === 1) {
        daemonWs.send(JSON.stringify({ type: 'output', data }));
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
        const hostLabel = s.host === '127.0.0.1' ? 'Local' : s.host;
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
          ws.send(JSON.stringify({
            type: 'resize',
            cols: process.stdout.columns,
            rows: process.stdout.rows
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
    
    const sessionId = args[1]; const prompt = args.slice(2).join(' ');
    if (!sessionId || !prompt) { console.error('❌ Usage: telepty inject [--no-enter] <session_id> "<prompt text>"'); process.exit(1); }
    try {
      const res = await fetchWithAuth(`${DAEMON_URL}/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, no_enter: noEnter })
      });
      const data = await res.json();
      if (!res.ok) { console.error(`❌ Error: ${data.error}`); return; }
      console.log(`✅ Context injected successfully into '\x1b[36m${sessionId}\x1b[0m'.`);
    } catch (e) { console.error('❌ Failed to connect to daemon. Is it running?'); }
    return;
  }

  if (cmd === 'multicast') {
    const sessionIdsRaw = args[1]; const prompt = args.slice(2).join(' ');
    if (!sessionIdsRaw || !prompt) { console.error('❌ Usage: telepty multicast <id1,id2,...> "<prompt text>"'); process.exit(1); }
    const sessionIds = sessionIdsRaw.split(',').map(s => s.trim()).filter(s => s);
    try {
      const res = await fetchWithAuth(`${DAEMON_URL}/api/sessions/multicast/inject`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_ids: sessionIds, prompt })
      });
      const data = await res.json();
      if (!res.ok) { console.error(`❌ Error: ${data.error}`); return; }
      console.log(`✅ Context multicasted successfully to ${data.results.successful.length} sessions.`);
      if (data.results.failed.length > 0) {
        console.warn(`⚠️ Failed to inject into ${data.results.failed.length} sessions:`, data.results.failed.map(f => f.id).join(', '));
      }
    } catch (e) { console.error('❌ Failed to connect to daemon. Is it running?'); }
    return;
  }

  if (cmd === 'broadcast') {
    const prompt = args.slice(1).join(' ');
    if (!prompt) { console.error('❌ Usage: telepty broadcast "<prompt text>"'); process.exit(1); }
    try {
      const res = await fetchWithAuth(`${DAEMON_URL}/api/sessions/broadcast/inject`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt })
      });
      const data = await res.json();
      if (!res.ok) { console.error(`❌ Error: ${data.error}`); return; }
      console.log(`✅ Context broadcasted successfully to ${data.results.successful.length} active sessions.`);
    } catch (e) { console.error('❌ Failed to connect to daemon. Is it running?'); }
    return;
  }

  if (cmd === 'rename') {
    const oldId = args[1]; const newId = args[2];
    if (!oldId || !newId) { console.error('❌ Usage: telepty rename <old_id> <new_id>'); process.exit(1); }
    try {
      const res = await fetchWithAuth(`${DAEMON_URL}/api/sessions/${encodeURIComponent(oldId)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ new_id: newId })
      });
      const data = await res.json();
      if (!res.ok) { console.error(`❌ Error: ${data.error}`); return; }
      console.log(`✅ Session renamed: '\x1b[36m${oldId}\x1b[0m' → '\x1b[36m${newId}\x1b[0m'`);
    } catch (e) { console.error('❌ Failed to connect to daemon. Is it running?'); }
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

    const wsUrl = `ws://${REMOTE_HOST}:${PORT}/api/bus?token=${encodeURIComponent(TOKEN)}`;
    const ws = new WebSocket(wsUrl);
    
    ws.on('open', () => {
      // connected
    });

    ws.on('message', (message) => {
      const raw = message.toString();
      if (cmd === 'listen') {
        // Raw JSON output for machines
        console.log(raw);
      } else {
        // Human readable billboard output
        try {
          const msg = JSON.parse(raw);
          const time = new Date().toLocaleTimeString();
          const sender = msg.sender || msg.from || 'Unknown';
          const target = msg.target_agent || msg.to || 'Bus';
          
          let preview = msg.content || msg.message || msg.payload || msg.data;
          if (msg.type === 'session_spawn') {
            console.log(`\x1b[90m[${time}]\x1b[0m 🚀 \x1b[32m\x1b[1mNew Session\x1b[0m: \x1b[36m${msg.session_id}\x1b[0m (${msg.command})`);
            return;
          }
          
          if (typeof preview === 'object') preview = JSON.stringify(preview);
          if (preview && preview.length > 200) preview = preview.substring(0, 197) + '...';

          console.log(`\x1b[90m[${time}]\x1b[0m \x1b[32m\x1b[1m${sender}\x1b[0m ➔ \x1b[33m\x1b[1m${target}\x1b[0m`);
          if (preview) console.log(`  \x1b[37m${preview}\x1b[0m\n`);
        } catch (e) {
          // Fallback if not valid JSON
          console.log(`\x1b[90m[${new Date().toLocaleTimeString()}]\x1b[0m 📦 \x1b[37m${raw}\x1b[0m\n`);
        }
      }
    });

    ws.on('close', () => {
      console.error('\x1b[31m❌ Disconnected from event bus.\x1b[0m');
      process.exit(1);
    });

    ws.on('error', (err) => {
      console.error('\x1b[31m❌ WebSocket error:\x1b[0m', err.message);
    });
    return;
  }

  console.log(`
\x1b[1maigentry-telepty\x1b[0m - Remote PTY Control

Usage:
  telepty daemon                                 Start the background daemon
  telepty spawn --id <id> <command> [args...]    Spawn a new background CLI
  telepty allow [--id <id>] <command> [args...]       Allow inject on a CLI
  telepty list                                   List all active sessions
  telepty attach [id]                            Attach to a session (Interactive picker if no ID)
  telepty inject [--no-enter] <id> "<prompt>"    Inject text into a single session
  telepty multicast <id1,id2> "<prompt>"         Inject text into multiple specific sessions
  telepty broadcast "<prompt>"                   Inject text into ALL active sessions
  telepty rename <old_id> <new_id>               Rename a session (updates terminal title too)
  telepty listen                                 Listen to the event bus and print JSON to stdout
  telepty monitor                                Human-readable real-time billboard of bus events
  telepty update                                 Update telepty to the latest version
`);
}

main();
