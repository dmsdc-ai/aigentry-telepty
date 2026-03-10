#!/usr/bin/env node

const path = require('path');
const args = process.argv.slice(2);
const DAEMON_URL = 'http://127.0.0.1:3848';

async function main() {
  const cmd = args[0];
  if (cmd === 'daemon') {
    console.log('Starting telepty daemon...');
    require('./daemon.js');
    return;
  }

  if (cmd === 'list') {
    try {
      const res = await fetch(`${DAEMON_URL}/api/sessions`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const sessions = await res.json();
      if (sessions.length === 0) { console.log('No active sessions found.'); return; }
      console.log('Active Sessions:');
      sessions.forEach(s => {
        console.log(`  - ID: \x1b[36m${s.id}\x1b[0m`);
        console.log(`    Command: ${s.command}`);
        console.log(`    CWD: ${s.cwd}`);
        console.log(`    Started: ${new Date(s.createdAt).toLocaleString()}`);
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
    try {
      const res = await fetch(`${DAEMON_URL}/api/sessions/spawn`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, command: command, args: cmdArgs, cwd: process.cwd() })
      });
      const data = await res.json();
      if (!res.ok) { console.error(`❌ Error: ${data.error}`); return; }
      console.log(`✅ Session '\x1b[36m${data.session_id}\x1b[0m' spawned successfully.`);
    } catch (e) { console.error('❌ Failed to connect to daemon. Is it running?'); }
    return;
  }

  if (cmd === 'inject') {
    const sessionId = args[1]; const prompt = args.slice(2).join(' ');
    if (!sessionId || !prompt) { console.error('❌ Usage: telepty inject <session_id> "<prompt text>"'); process.exit(1); }
    try {
      const res = await fetch(`${DAEMON_URL}/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt })
      });
      const data = await res.json();
      if (!res.ok) { console.error(`❌ Error: ${data.error}`); return; }
      console.log(`✅ Context injected successfully into '\x1b[36m${sessionId}\x1b[0m'.`);
    } catch (e) { console.error('❌ Failed to connect to daemon. Is it running?'); }
    return;
  }

  console.log(`\n\x1b[1maigentry-telepty\x1b[0m - Cross-machine PTY-based remote prompt injection\n\nUsage:\n  telepty daemon                                 Start the background daemon\n  telepty spawn --id <id> <command> [args...]    Spawn a new background CLI\n  telepty list                                   List all active sessions\n  telepty inject <id> "<prompt>"                 Inject text into an active session\n  `);
}

main();
