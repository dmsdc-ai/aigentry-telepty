#!/usr/bin/env node

const path = require('path');
const WebSocket = require('ws');
const { execSync, spawn } = require('child_process');
const readline = require('readline');
const prompts = require('prompts');
const updateNotifier = require('update-notifier');
const pkg = require('./package.json');
const { getConfig } = require('./auth');
const args = process.argv.slice(2);

// Check for updates
updateNotifier({pkg}).notify({ isGlobal: true });

// Support remote host via environment variable or default to localhost
let REMOTE_HOST = process.env.TELEPTY_HOST || '127.0.0.1';
const PORT = 3848;
let DAEMON_URL = `http://${REMOTE_HOST}:${PORT}`;
let WS_URL = `ws://${REMOTE_HOST}:${PORT}`;

const config = getConfig();
const TOKEN = config.authToken;

const fetchWithAuth = (url, options = {}) => {
  const headers = { ...options.headers, 'x-telepty-token': TOKEN };
  return fetch(url, { ...options, headers });
};

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
        { title: '💬  Send message to a room (Inject command)', value: 'inject' },
        { title: '📋  View all open rooms (List sessions)', value: 'list' },
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

      const cols = process.stdout.columns || 80;
      const rows = process.stdout.rows || 30;
      try {
        const res = await fetchWithAuth(`${DAEMON_URL}/api/sessions/spawn`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: id, command, args: [], cwd: process.cwd(), cols, rows })
        });
        const data = await res.json();
        if (!res.ok) console.error(`\n❌ Error: ${data.error}\n`);
        else console.log(`\n✅ Session '\x1b[36m${data.session_id}\x1b[0m' spawned successfully.\n`);
      } catch (e) {
        console.error('\n❌ Failed to connect to local daemon. Is it running?\n');
      }
      continue;
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
        const wsUrl = `ws://${target.host}:${PORT}/api/sessions/${encodeURIComponent(target.id)}?token=${encodeURIComponent(TOKEN)}`;
        const ws = new WebSocket(wsUrl);
        await new Promise((resolve) => {
          ws.on('open', () => {
            console.log(`\n\x1b[32mConnected to '${target.id}'. Press Ctrl+C to detach.\x1b[0m\n`);
            if (process.stdin.isTTY) process.stdin.setRawMode(true);
            process.stdin.on('data', d => ws.send(JSON.stringify({ type: 'input', data: d.toString() })));
            const resizer = () => ws.send(JSON.stringify({ type: 'resize', cols: process.stdout.columns, rows: process.stdout.rows }));
            process.stdout.on('resize', resizer); resizer();
          });
          ws.on('message', m => {
            const msg = JSON.parse(m);
            if (msg.type === 'output') process.stdout.write(msg.data);
          });
          ws.on('close', () => {
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            console.log(`\n\x1b[33mDisconnected from session.\x1b[0m\n`);
            process.stdin.removeAllListeners('data');
            resolve();
          });
        });
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
    require('./mcp.js');
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
        body: JSON.stringify({ session_id: sessionId, command: command, args: cmdArgs, cwd: process.cwd(), cols, rows })
      });
      const data = await res.json();
      if (!res.ok) { console.error(`❌ Error: ${data.error}`); return; }
      console.log(`✅ Session '\x1b[36m${data.session_id}\x1b[0m' spawned successfully.`);
    } catch (e) { console.error('❌ Failed to connect to daemon. Is it running?'); }
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

    ws.on('open', () => {
      console.log(`\x1b[32mConnected to session '${sessionId}' at ${targetHost}. Press Ctrl+C to detach.\x1b[0m\n`);
      
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }

      process.stdin.on('data', (data) => {
        ws.send(JSON.stringify({ type: 'input', data: data.toString() }));
      });

      const resizeHandler = () => {
        ws.send(JSON.stringify({
          type: 'resize',
          cols: process.stdout.columns,
          rows: process.stdout.rows
        }));
      };

      process.stdout.on('resize', resizeHandler);
      resizeHandler(); // Initial resize
    });

    ws.on('message', (message) => {
      const { type, data } = JSON.parse(message);
      if (type === 'output') {
        process.stdout.write(data);
      }
    });

    ws.on('close', (code, reason) => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      console.log(`\n\x1b[33mDisconnected from session. (Code: ${code}, Reason: ${reason || 'None'})\x1b[0m`);
      process.exit(0);
    });

    ws.on('error', (err) => {
      console.error('❌ WebSocket Error:', err.message);
      process.exit(1);
    });

    return;
  }

  if (cmd === 'inject') {
    const sessionId = args[1]; const prompt = args.slice(2).join(' ');
    if (!sessionId || !prompt) { console.error('❌ Usage: telepty inject <session_id> "<prompt text>"'); process.exit(1); }
    try {
      const res = await fetchWithAuth(`${DAEMON_URL}/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt })
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

  console.log(`
\x1b[1maigentry-telepty\x1b[0m - Remote PTY Control

Usage:
  telepty daemon                                 Start the background daemon
  telepty spawn --id <id> <command> [args...]    Spawn a new background CLI
  telepty list                                   List all active sessions
  telepty attach [id]                            Attach to a session (Interactive picker if no ID)
  telepty inject <id> "<prompt>"                 Inject text into a single session
  telepty multicast <id1,id2> "<prompt>"         Inject text into multiple specific sessions
  telepty broadcast "<prompt>"                   Inject text into ALL active sessions
  telepty update                                 Update telepty to the latest version
  telepty mcp                                    Start the MCP stdio server
`);
}

main();
