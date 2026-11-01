'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const H = require('../test-support/bridge-pipe-harness');

// Actual wrapper and private daemon; the PATH-selected ssh is a local executable fixture.
// It never opens a network connection or reads/writes known_hosts or SSH credentials.
for (const termination of ['delete', 'kill']) test(`#11 persistent fake SSH survives >3 exits, fences bootstrap/input, and stops on ${termination}`, {
  skip: process.platform === 'win32' ? 'POSIX executable fixture; native Windows SSH acceptance remains open' : false
}, async t => {
  const home = H.makeHome(); const bin = path.join(home, 'fake-bin'); fs.mkdirSync(bin);
  const counter = path.join(home, 'attempts'); const input = path.join(home, 'input.jsonl');
  const release = path.join(home, 'release'); const starts = path.join(home, 'starts.jsonl');
  const fake = path.join(bin, 'ssh');
  fs.writeFileSync(fake, `#!${process.execPath}
const fs = require('fs');
const countFile = process.env.SSH_TEST_COUNTER;
const attempt = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8') : 0) + 1;
fs.writeFileSync(countFile, String(attempt));
fs.appendFileSync(process.env.SSH_TEST_STARTS, JSON.stringify({ attempt, argv: process.argv.slice(2), leaked: Object.keys(process.env).filter(k => k.startsWith('TELEPTY_')) })+'\\n');
if (attempt <= 4) { console.log('Connection reset by fixture'); process.exit(255); }
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
let released = false;
const composer = 'OpenAI Codex (v0.160.0)\\r\\n› \\r\\nGPT-6-Astra xhigh fast\\r\\n';
console.log('Password: ');
setInterval(() => { if (!released && fs.existsSync(process.env.SSH_TEST_RELEASE)) { released = true; process.stdout.write(composer); } }, 20);
process.stdin.on('data', chunk => {
 fs.appendFileSync(process.env.SSH_TEST_INPUT, JSON.stringify({ attempt, data: chunk.toString() })+'\\n');
 if (chunk.toString().includes('DROP_BODY')) { if (fs.existsSync(process.env.SSH_TEST_RELEASE)) fs.unlinkSync(process.env.SSH_TEST_RELEASE); process.exit(255); }
 if (chunk.toString().includes('\\r')) { console.log('SSH_REPLY'); process.stdout.write(composer); }
});
`, { mode: 0o755 });
  const daemon = H.startDaemon({ home }); let bridge;
  t.after(async () => {
    if (bridge && bridge.exitCode === null && bridge.signalCode === null) bridge.kill('SIGKILL');
    await H.stopDaemon(daemon); fs.rmSync(home, { recursive: true, force: true });
  });
  const port = await H.daemonReady(daemon); const token = H.daemonToken(home);
  const proxy = H.startProxy({ targetPort: port });
  const bridgePort = await proxy.listen();
  t.after(() => proxy.close());
  const api = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method,
      headers: { 'x-telepty-token': token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { code: response.status, body: await response.json() };
  };
  let output = '';
  bridge = spawn(process.execPath, ['cli.js', 'ssh', 'fixture.invalid', '--id', 'ssh-fixture', '--persistent',
    '--remote-command', 'codex', '--cwd', '~/safe directory', '--resume', 'explicit-session',
    '--backoff-ms', '10', '--backoff-max-ms', '500'], {
    cwd: path.resolve(__dirname, '..'), stdio: ['pipe','pipe','pipe'],
    env: { ...process.env, HOME: home, TELEPTY_HOST: '127.0.0.1', TELEPTY_PORT: String(bridgePort),
      PATH: `${bin}${path.delimiter}${process.env.PATH}`, SSH_TEST_COUNTER: counter, SSH_TEST_INPUT: input,
      SSH_TEST_RELEASE: release, SSH_TEST_STARTS: starts, TELEPTY_DISABLE_UPDATE_NOTIFIER: '1' }
  });
  bridge.stdout.on('data', c => { output += c; }); bridge.stderr.on('data', c => { output += c; });
  await H.waitFor(() => fs.existsSync(counter) && Number(fs.readFileSync(counter,'utf8')) >= 5 && output.includes('Password:'), {
    timeoutMs: 15000, description: 'fifth persistent attempt waits at bootstrap', context: () => output
  });
  const metadata = (await api('GET', '/api/sessions/ssh-fixture')).body;
  assert.equal(metadata.command, 'ssh'); assert.equal(metadata.sshRemote.agent, 'codex');
  assert.equal(metadata.sshRemote.identity, 'operator_declared'); assert.equal(metadata.sshRemote.version_status, 'unsupported');
  const blocked = await api('POST', '/api/sessions/ssh-fixture/inject', { prompt: 'NO_AUTH_INPUT' });
  assert.equal(blocked.body.success, false); assert.equal(blocked.body.code, 'SSH_NOT_READY');
  assert.equal(fs.existsSync(input), false, 'no automated bytes reached password UI');
  fs.writeFileSync(release, 'ready');
  await H.waitFor(async () => (await api('GET', '/api/sessions/ssh-fixture/handshake')).body.ready === true, {
    timeoutMs: 5000, description: 'qualified remote composer', context: () => output
  });
  const boundBefore = (await api('GET', '/api/sessions/ssh-fixture/handshake')).body.owner_generation;
  proxy.dropConnections();
  await H.waitFor(async () => {
    const r = (await api('GET', '/api/sessions/ssh-fixture/handshake')).body;
    return r.ready === true && r.owner_generation !== boundBefore;
  }, { timeoutMs: 7000, description: 'daemon WS reconnect rebinds current child composer', context: () => output });
  assert.equal(Number(fs.readFileSync(counter, 'utf8')), 5, 'daemon reconnect does not respawn SSH');
  const success = await api('POST', '/api/sessions/ssh-fixture/inject', { prompt: 'SAFE_BODY' });
  assert.equal(success.body.success, true, JSON.stringify(success));
  await H.waitFor(() => output.includes('SSH_REPLY'), { timeoutMs: 3000, description: 'fake child sees separate Enter' });
  await H.waitFor(async () => (await api('GET', '/api/sessions/ssh-fixture/handshake')).body.ready === true, {
    timeoutMs: 5000, description: 'composer after submitted input' });
  const disconnected = await api('POST', '/api/sessions/ssh-fixture/inject', { prompt: 'DROP_BODY' });
  assert.equal(disconnected.body.success, false); assert.equal(disconnected.body.text_written, true);
  await H.waitFor(() => Number(fs.readFileSync(counter,'utf8')) >= 6, { timeoutMs: 3000, description: 'sixth attempt after child disconnect' });
  const writes = fs.readFileSync(input,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(writes.some(row => row.attempt >= 6), false, 'deferred Enter never reaches successor/authentication');
  const runs = fs.readFileSync(starts,'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(runs.every(row => row.leaked.length === 0), 'SSH child has no local Telepty credentials/capabilities');
  assert.ok(runs.every(row => row.argv[0] === '-tt' && row.argv.includes('BatchMode=yes')));
  // An operator-controlled fixture input exits child six; cancel during its pending backoff.
  bridge.stdin.write('DROP_BODY');
  await H.waitFor(async () => (await api('GET', '/api/sessions/ssh-fixture')).body.ssh?.phase === 'reconnecting', {
    timeoutMs: 1000, intervalMs: 10, description: 'pending reconnect delay before cancellation' });
  const attempts = Number(fs.readFileSync(counter,'utf8'));
  const removed = termination === 'delete' ? await api('DELETE', '/api/sessions/ssh-fixture')
    : await api('POST', '/api/sessions/ssh-fixture/kill', { force: true, timeout_ms: 0 });
  assert.equal(removed.body.success, true);
  await H.waitFor(() => bridge.exitCode !== null || bridge.signalCode !== null, { timeoutMs: 5000, description: 'delete cancels persistent wrapper' });
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(Number(fs.readFileSync(counter,'utf8')), attempts, 'no restart after delete');
});
