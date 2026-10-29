'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { startTestDaemon, createSessionId, waitFor } = require('../test-support/daemon-harness');

test('#124: actual listen --json stdout remains JSON through startup, events and session reconnect', async t => {
  const h = await startTestDaemon();
  t.after(() => h.stop());
  const publisher = await h.connectBus();
  t.after(() => publisher.close());
  const listener = spawn(process.execPath, ['cli.js', 'listen', '--json'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, HOME: h.homeDir, USERPROFILE: h.homeDir,
      TELEPTY_HOST: h.host, TELEPTY_PORT: String(h.port), TELEPTY_CLIENT_RESTART: 'off',
      TELEPTY_DISABLE_UPDATE_NOTIFIER: '1', NO_UPDATE_NOTIFIER: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exited = once(listener, 'close');
  t.after(async () => { if (listener.exitCode === null) listener.kill(); await exited; });
  let stdout = '';
  listener.stdout.setEncoding('utf8');
  listener.stdout.on('data', chunk => { stdout += chunk; });
  const records = () => stdout.split('\n').filter(s => s.trim()).map(s => JSON.parse(s));
  await waitFor(() => (h.getLogs().stdout.match(/New agent connected to event bus/g) || []).length >= 2,
    { timeoutMs: 5000, description: 'listen CLI connected to owned test bus' });
  publisher.send(JSON.stringify({ type: 'fixture_event', content: '한글 🐾' }));
  await waitFor(() => stdout.includes('fixture_event'), { description: 'real bus frame reached CLI' });
  assert.ok(records().some(r => r.type === 'fixture_event' && r.content === '한글 🐾'));
  const sid = createSessionId('json-reconnect');
  await h.registerSession(sid);
  const first = await h.connectSession(sid, h.ownerAuth(sid));
  first.close();
  await waitFor(() => records().some(r => r.type === 'session_disconnect' && r.session_id === sid));
  const second = await h.connectSession(sid, h.ownerAuth(sid));
  t.after(() => second.close());
  await waitFor(() => records().some(r => r.type === 'session_reconnect' && r.session_id === sid));
  const reconnect = records().find(r => r.type === 'session_reconnect' && r.session_id === sid);
  assert.equal(reconnect.host, h.host);
  assert.equal(reconnect.transport.health_status, 'CONNECTED');
  assert.ok(records().length >= 3);
  assert.doesNotMatch(stdout, /\x1b|Listening to the telepty/);
});
