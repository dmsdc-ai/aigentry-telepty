#!/usr/bin/env node

const path = require('path');
const WebSocket = require('ws');
const { getConfig } = require('./auth');
const args = process.argv.slice(2);

// Support remote host via environment variable or default to localhost
const REMOTE_HOST = process.env.TELEPTY_HOST || '127.0.0.1';
const PORT = 3848;
const DAEMON_URL = `http://${REMOTE_HOST}:${PORT}`;
const WS_URL = `ws://${REMOTE_HOST}:${PORT}`;

const config = getConfig();
const TOKEN = config.authToken;

const fetchWithAuth = (url, options = {}) => {
  const headers = { ...options.headers, 'x-telepty-token': TOKEN };
  return fetch(url, { ...options, headers });
};

async function main() {
  const cmd = args[0];
  if (cmd === 'mcp') {
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
    const sessionId = args[1];
    if (!sessionId) { console.error('❌ Usage: telepty attach <session_id>'); process.exit(1); }

    const ws = new WebSocket(`${WS_URL}/api/sessions/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(TOKEN)}`);

    ws.on('open', () => {
      console.log(`\x1b[32mConnected to session '${sessionId}'. Press Ctrl+C to detach (if shell supports) or use your shell's exit command.\x1b[0m\n`);
      
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

  console.log(`
\x1b[1maigentry-telepty\x1b[0m - Remote PTY Control

Usage:
  telepty daemon                                 Start the background daemon
  telepty spawn --id <id> <command> [args...]    Spawn a new background CLI
  telepty list                                   List all active sessions
  telepty attach <id>                            Attach to an active session (Interactive)
  telepty inject <id> "<prompt>"                 Inject text into an active session
  telepty mcp                                    Start the MCP stdio server
`);
}

main();
