'use strict';
// Actual CLI + node-pty + daemon HTTP/WS. Every process, credential and path is
// test-owned; no daemon on the user's configured port or HOME is contacted.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const pty = require('node-pty');
const { startTestDaemon, waitFor, createSessionId } = require('../test-support/daemon-harness');
const { defaultSessionPersistPath } = require('../src/session-store/persistence');
const ROOT = path.resolve(__dirname, '..');
const linux = { skip: process.platform !== 'linux', timeout: 60000 };
function privateRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-bridge-92-'));
  for (const part of ['home', 'channels']) fs.mkdirSync(path.join(root, part), { mode: 0o700 });
  return root;
}
function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('TELEPTY_') || key.startsWith('AIGENTRY_TELEPTY_') || ['NODE_OPTIONS', 'PORT', 'HOST'].includes(key)) delete env[key];
  return env;
}
function spawnBridge({ root, daemon, sid, enabled, port = daemon.port }) {
  const processEnv = {
    ...cleanEnv(), HOME: daemon.homeDir, USERPROFILE: daemon.homeDir,
    XDG_CONFIG_HOME: path.join(daemon.homeDir, '.config'), TMPDIR: path.join(root, 'channels'),
    TELEPTY_HOST: daemon.host, TELEPTY_PORT: String(port), TELEPTY_AUTH_TOKEN: daemon.authToken(),
    TELEPTY_NO_TAILNET_AUTO: '1', TELEPTY_NO_SUPERVISOR_DEFER: '1', TELEPTY_CLIENT_RESTART: 'off',
    TELEPTY_DISABLE_UPDATE_NOTIFIER: '1', NO_UPDATE_NOTIFIER: '1',
    ...(enabled ? { TELEPTY_SESSION_CREDENTIAL_REFRESH: '1' } : {})
  };
  const proc = pty.spawn(process.execPath, ['cli.js', 'allow', '--id', sid, '--idle-ttl', 'off', '--',
    process.execPath, path.join(ROOT, 'test-support/credential-bridge-child-92.js')], {
    cwd: ROOT, env: processEnv, cols: 100, rows: 30, name: 'xterm-256color'
  });
  const state = { proc, output: '', exit: null, witnesses: [] };
  proc.onData(data => {
    state.output += data;
    state.witnesses = [...state.output.matchAll(/CREDENTIAL_WITNESS (\{[^\r\n]*\})/g)].map(match => JSON.parse(match[1]));
  });
  proc.onExit(event => { state.exit = event.exitCode; });
  return state;
}
async function stopBridge(bridge) {
  if (!bridge || bridge.exit !== null) return;
  try { bridge.proc.write('EXIT\n'); } catch {}
  try { await waitFor(() => bridge.exit !== null, { timeoutMs: 3000 }); return; } catch {}
  try { bridge.proc.kill('SIGTERM'); } catch {}
  try { await waitFor(() => bridge.exit !== null, { timeoutMs: 3000 }); return; } catch {}
  try { bridge.proc.kill('SIGKILL'); } catch {}
  await waitFor(() => bridge.exit !== null, { timeoutMs: 3000, description: 'owned bridge termination' });
}
function snapshot(daemon, sid) { return JSON.parse(fs.readFileSync(defaultSessionPersistPath(daemon.homeDir), 'utf8'))[sid]; }
async function connected(daemon, sid) {
  const result = await daemon.request('/api/sessions');
  return result.body.find(session => session.id === sid && session.healthStatus === 'CONNECTED');
}
function assertWitness(witness, persisted, bridge) {
  assert.ok(witness.enabled);
  assert.equal(witness.epoch, persisted.sessionEpoch);
  assert.equal(witness.generation, persisted.credentialGeneration);
  assert.equal(witness.verifier, persisted.credentialVerifier);
  assert.equal(witness.wrapper, bridge.proc.pid);
  assert.equal(witness.wrapper, persisted.ownerPid);
}

// Hold real WS upgrades to inspect the pre-ACK state. The adversarial mode
// supplies a fabricated test registration bearer for an incumbent ID; the real
// daemon must then refuse its claim with 4003, without publication or spawn.
async function bridgeProxy(daemon, sid, { fabricateRegistration = false } = {}) {
  const sockets = new Set();
  const held = [];
  let holding = true;
  const epoch = crypto.randomBytes(16).toString('base64url');
  const server = http.createServer((request, response) => {
    if (fabricateRegistration && request.method === 'POST' && request.url === '/api/sessions/register') {
      request.resume();
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ session_id: sid, session_epoch: epoch, credential_generation: 1,
        session_token: `${epoch}.${crypto.randomBytes(32).toString('base64url')}` }));
      return;
    }
    const upstream = http.request({ hostname: daemon.host, port: daemon.port, method: request.method, path: request.url, headers: request.headers }, remote => {
      response.writeHead(remote.statusCode, remote.headers); remote.pipe(response);
    });
    upstream.on('error', () => { response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  function forwardUpgrade(request, socket, head) {
    const upstream = net.connect(daemon.port, daemon.host, () => {
      upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n` + Object.entries(request.headers).map(([key, value]) => `${key}: ${value}\r\n`).join('') + '\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => socket.destroy()); socket.on('close', () => upstream.destroy());
  }
  server.on('upgrade', (request, socket, head) => {
    if (holding) held.push([request, socket, head]);
    else forwardUpgrade(request, socket, head);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, heldCount: () => held.length,
    release() { holding = false; for (const args of held.splice(0)) forwardUpgrade(...args); },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}

test('actual allow opt-in publishes only after owner ACK and refreshes an already-running child after lost registration', linux, async t => {
  const root = privateRoot();
  const homeDir = path.join(root, 'home');
  const token = crypto.randomBytes(32).toString('hex');
  const daemonEnv = { TELEPTY_AUTH_TOKEN: token, TELEPTY_NO_TAILNET_AUTO: '1', TELEPTY_NO_SUPERVISOR_DEFER: '1' };
  let daemon = await startTestDaemon({ homeDir, env: daemonEnv });
  let bridge, proxy;
  t.after(async () => { await stopBridge(bridge); if (proxy) await proxy.close(); await daemon.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const sid = createSessionId('credential-92');
  proxy = await bridgeProxy(daemon, sid);
  bridge = spawnBridge({ root, daemon, port: proxy.port, sid, enabled: true });
  await waitFor(() => proxy.heldCount() === 1, { timeoutMs: 10000, description: 'accepted registration awaiting real WS owner ACK' });
  const pendingDirectories = fs.readdirSync(path.join(root, 'channels')).filter(name => name.startsWith('telepty-credential-'));
  assert.equal(pendingDirectories.length, 1);
  assert.equal(fs.existsSync(path.join(root, 'channels', pendingDirectories[0], 'credential.json')), false);
  assert.equal(bridge.witnesses.length, 0);
  assert.doesNotMatch(bridge.output, /Inject allowed|CREDENTIAL_WITNESS/);
  proxy.release();
  const first = await waitFor(() => bridge.witnesses[0], { timeoutMs: 15000, description: 'opt-in child starts with published credential' });
  await waitFor(() => connected(daemon, sid), { timeoutMs: 5000 });
  assertWitness(first, snapshot(daemon, sid), bridge);
  assert.equal(first.sequence, 1); assert.equal(first.ambientMatches, true);
  const channelPath = path.join(root, 'channels', pendingDirectories[0], 'credential.json');
  const initialSyntheticBearer = JSON.parse(fs.readFileSync(channelPath, 'utf8')).session_token;
  assert.equal(bridge.output.includes(initialSyntheticBearer), false, 'bearer never appears in child/CLI output');
  assert.equal(JSON.stringify(daemon.getLogs()).includes(initialSyntheticBearer), false, 'bearer never appears in test-daemon logs');
  assert.doesNotMatch(bridge.output, /CREDENTIAL_WITNESS_ERROR|ReferenceError/);

  // Kill only the harness daemon, then discard only its test-owned session
  // snapshot. A normal persisted restart does not rotate a valid credential.
  const port = daemon.port;
  await daemon.kill();
  fs.unlinkSync(defaultSessionPersistPath(homeDir));
  daemon = await startTestDaemon({ homeDir, port, env: daemonEnv });
  const next = await waitFor(() => bridge.witnesses.find(witness => witness.epoch !== first.epoch), { timeoutMs: 20000, description: 'same child reads re-registered new epoch' });
  await waitFor(() => connected(daemon, sid), { timeoutMs: 5000 });
  assertWitness(next, snapshot(daemon, sid), bridge);
  assert.equal(next.handle, first.handle); assert.equal(next.instance, first.instance);
  assert.equal(next.pid, first.pid); assert.ok(next.sequence > first.sequence);
  assert.equal(next.ambientMatches, false, 'running child env stays immutable while helper sees current credential');
  const refreshedSyntheticBearer = JSON.parse(fs.readFileSync(channelPath, 'utf8')).session_token;
  assert.equal(bridge.output.includes(initialSyntheticBearer) || bridge.output.includes(refreshedSyntheticBearer), false);
  assert.equal(JSON.stringify(daemon.getLogs()).includes(refreshedSyntheticBearer), false);
  await stopBridge(bridge);
  assert.equal(fs.readdirSync(path.join(root, 'channels')).filter(name => name.startsWith('telepty-credential-')).length, 0);
});

test('actual refused WS claim never publishes or starts a challenger and cannot alter incumbent channel', linux, async t => {
  const root = privateRoot();
  const daemon = await startTestDaemon({ homeDir: path.join(root, 'home'), env: { TELEPTY_AUTH_TOKEN: crypto.randomBytes(32).toString('hex'), TELEPTY_NO_TAILNET_AUTO: '1' } });
  let incumbent, challenger, proxy;
  t.after(async () => { await stopBridge(challenger); await stopBridge(incumbent); if (proxy) await proxy.close(); await daemon.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const sid = createSessionId('credential-refuse-92');
  incumbent = spawnBridge({ root, daemon, sid, enabled: true });
  const first = await waitFor(() => incumbent.witnesses[0], { timeoutMs: 15000 });
  const directories = fs.readdirSync(path.join(root, 'channels')).filter(name => name.startsWith('telepty-credential-'));
  assert.equal(directories.length, 1);
  const recordPath = path.join(root, 'channels', directories[0], 'credential.json');
  const beforeHash = crypto.createHash('sha256').update(fs.readFileSync(recordPath)).digest('hex');
  proxy = await bridgeProxy(daemon, sid, { fabricateRegistration: true });
  challenger = spawnBridge({ root, daemon, port: proxy.port, sid, enabled: true });
  await waitFor(() => proxy.heldCount() === 1, { timeoutMs: 10000, description: 'fabricated issuance awaiting refused WS claim' });
  const staged = fs.readdirSync(path.join(root, 'channels')).filter(name => name.startsWith('telepty-credential-') && !directories.includes(name));
  assert.equal(staged.length, 1);
  assert.equal(fs.existsSync(path.join(root, 'channels', staged[0], 'credential.json')), false);
  assert.doesNotMatch(challenger.output, /Inject allowed|CREDENTIAL_WITNESS/);
  proxy.release();
  await waitFor(() => challenger.exit !== null, { timeoutMs: 15000, description: 'real daemon refuses fake owner bearer' });
  assert.equal(challenger.exit, 1);
  assert.match(challenger.output, /Owner claim refused/);
  assert.equal(challenger.witnesses.length, 0);
  assert.doesNotMatch(challenger.output, /Inject allowed|CREDENTIAL_WITNESS/);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(recordPath)).digest('hex'), beforeHash);
  assert.deepEqual(fs.readdirSync(path.join(root, 'channels')).filter(name => name.startsWith('telepty-credential-')), directories);
  assert.ok(await connected(daemon, sid));
  assertWitness(first, snapshot(daemon, sid), incumbent);
});

test('actual allow opt-out handles owner ACK and starts child without a refresh channel', linux, async t => {
  const root = privateRoot();
  const daemon = await startTestDaemon({ homeDir: path.join(root, 'home'), env: { TELEPTY_AUTH_TOKEN: crypto.randomBytes(32).toString('hex'), TELEPTY_NO_TAILNET_AUTO: '1' } });
  let bridge;
  t.after(async () => { await stopBridge(bridge); await daemon.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const sid = createSessionId('credential-optout-92');
  bridge = spawnBridge({ root, daemon, sid, enabled: false });
  const witness = await waitFor(() => bridge.witnesses[0], { timeoutMs: 15000 });
  assert.equal(witness.enabled, false);
  assert.ok(await connected(daemon, sid));
  assert.equal(fs.readdirSync(path.join(root, 'channels')).filter(name => name.startsWith('telepty-credential-')).length, 0);
  assert.doesNotMatch(bridge.output, /ReferenceError|Credential refresh refused/);
});
