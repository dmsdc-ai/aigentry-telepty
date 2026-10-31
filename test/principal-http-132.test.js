'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { loadPrincipalTrust, createPrincipalAuthenticationFromEnvironment, createPrincipalAuthentication } = require('../src/principal/http');
const { validateTrustConfiguration, createSignedAssertion } = require('../src/principal/proof');
const { createHttpApp, registerHealthAndAuth } = require('../src/protocol/http-app');
const { createAuthMiddleware } = require('../src/protocol/http-auth');
const { createCredentialStore } = require('../src/session-store/session-credentials');
const { createSessionRecordContext, registerSessionRegisterRoute } = require('../src/routes/session-records');
const persistence = require('../src/session-store/persistence');

function configuration() {
  const alice = crypto.generateKeyPairSync('ed25519'), operator = crypto.generateKeyPairSync('ed25519');
  const key = (id, pair, authority, grants) => ({ key_id: id, principal_id: id,
    public_key_spki: pair.publicKey.export({ type: 'spki', format: 'pem' }), authority, grants });
  return { alice, operator, json: { schema: 'telepty.principals/v1', audience: 'fixture-node', keys: [
    key('alice', alice, 'principal', [
      { action: 'session.register', targets: ['mine', 'legacy'] }, { action: 'session.inspect', targets: ['mine', 'legacy'] },
      { action: 'session.state', targets: ['mine', 'legacy'] }, { action: 'session.inject', targets: ['mine', 'legacy', 'broadcast', 'multicast', 'alias'] },
      { action: 'daemon.inspect', targets: ['daemon'] }, { action: 'session.destroy', targets: ['mine'] },
      { action: 'session.create', targets: ['new-pty'] }
    ]), key('operator', operator, 'operator', [
      { action: 'session.list', targets: ['*'] }, { action: 'session.inspect', targets: ['*'] },
      { action: 'session.state', targets: ['legacy'] }, { action: 'daemon.inspect', targets: ['daemon'] },
      { action: 'session.register', targets: ['operator-wrapper'] }
    ])
  ] } };
}
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-principal-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('Linux public trust load checks ownership/mode/link/ancestor integrity and invalid mode never falls back', { skip: process.platform !== 'linux' }, t => {
  const dir = temp(t), file = path.join(dir, 'public-trust.json'), config = configuration();
  fs.writeFileSync(file, JSON.stringify(config.json), { mode: 0o600 });
  assert.equal(loadPrincipalTrust(file, { audience: 'fixture-node' }).keys.size, 2);
  assert.equal(createPrincipalAuthenticationFromEnvironment({ env: {}, machineId: 'fixture-node', sessions: {} }), null);
  for (const env of [{ TELEPTY_PRINCIPAL_MODE: 'strict' }, { TELEPTY_PRINCIPAL_MODE: 'typo' },
    { TELEPTY_PRINCIPAL_MODE: 'strict', TELEPTY_PRINCIPAL_TRUST_FILE: path.join(dir, 'missing') }]) {
    assert.throws(() => createPrincipalAuthenticationFromEnvironment({ env, machineId: 'fixture-node', sessions: {} }));
  }
  for (const platform of ['win32', 'darwin']) assert.throws(() => loadPrincipalTrust(file, { platform, audience: 'fixture-node' }));
  fs.chmodSync(file, 0o666);
  assert.throws(() => loadPrincipalTrust(file, { audience: 'fixture-node' }));
  fs.chmodSync(file, 0o600);
  const link = path.join(dir, 'linked.json'); fs.symlinkSync(file, link);
  assert.throws(() => loadPrincipalTrust(link, { audience: 'fixture-node' }));
  fs.linkSync(file, path.join(dir, 'hardlink.json'));
  assert.throws(() => loadPrincipalTrust(file, { audience: 'fixture-node' }));
  fs.unlinkSync(path.join(dir, 'hardlink.json'));
  fs.chmodSync(dir, 0o777);
  assert.throws(() => loadPrincipalTrust(file, { audience: 'fixture-node' }));
});

async function fixture(t, { strict = true } = {}) {
  const dir = temp(t), config = configuration(), sessions = { legacy: { id: 'legacy', type: 'wrapped', sessionEpoch: 'legacy-epoch' } };
  sessions.broadcast = { id: 'broadcast', type: 'wrapped' };
  sessions.multicast = { id: 'multicast', type: 'wrapped' };
  sessions['alias-002'] = { id: 'alias-002', type: 'wrapped' };
  const writes = [];
  const trust = validateTrustConfiguration(config.json, { audience: 'fixture-node' });
  const authentication = strict ? createPrincipalAuthentication({ trust, sessions }) : null;
  const app = createHttpApp({ express: require('express'), cors: require('cors') });
  registerHealthAndAuth(app, { pkg: { version: 'fixture' }, createAuthMiddleware, isAllowedPeer: () => true,
    EXPECTED_TOKEN: 'legacy-secret', verifyJwt: () => true, authorizeSessionRequest: () => true, principalAuthentication: authentication });
  app.get('/api/meta', (req, res) => res.json({ id: req.authenticationPrincipal?.id || null }));
  app.get('/api/sessions', (_req, res) => res.json(Object.keys(sessions)));
  app.get('/api/sessions/:id', (req, res) => res.json(sessions[req.params.id]));
  app.post('/api/sessions/:id/state', (_req, res) => res.json({ success: true }));
  app.post('/api/sessions/broadcast/inject', (_req, res) => { writes.push('broadcast'); res.json({ success: true }); });
  app.post('/api/sessions/multicast/inject', (_req, res) => { writes.push('multicast'); res.json({ success: true }); });
  app.post('/api/sessions/:id/inject', (req, res) => { writes.push(req.params.id); res.json({ success: true }); });
  app.delete('/api/sessions/:id', (_req, res) => res.json({ success: true }));
  const context = createSessionRecordContext({ sessions, sessionCredentials: createCredentialStore(), sidNonces: new Map(), sessionPersistPath: path.join(dir, 'sessions.json') });
  registerSessionRegisterRoute(app, { context, sessionStateManager: { register() {} }, busClients: new Set() });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  function sign(target, action, body, { id = 'alice', method = 'GET', ...extra } = {}) {
    return createSignedAssertion({ privateKey: config[id].privateKey, keyId: id, principalId: id, audience: 'fixture-node',
      challenge: authentication.verifier.challenge, method, target, body, action, ...extra });
  }
  async function request(target, { proof, body, raw, method = 'GET', headers = {} } = {}) {
    const result = await fetch(url + target, { method, headers: { ...(proof ? { 'x-telepty-principal': proof } : {}),
      ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: result.status, body: await result.json() };
  }
  return { sessions, authentication, sign, request, context, config, writes, file: path.join(dir, 'sessions.json') };
}

test('strict real HTTP refuses shared/JWT/session fallback, exposes restart challenge, and verifies principal proof', async t => {
  const f = await fixture(t);
  for (const headers of [{ 'x-telepty-token': 'legacy-secret' }, { Authorization: 'Bearer signed-by-old-shared-secret' }, { 'x-telepty-session-token': 'session-token' }]) {
    assert.equal((await f.request('/api/meta', { headers })).status, 401);
  }
  const challenge = await f.request('/api/auth/challenge');
  assert.equal(challenge.status, 200); assert.equal(challenge.body.challenge, f.authentication.verifier.challenge);
  const proof = f.sign('/api/meta', 'daemon.inspect');
  assert.equal((await f.request('/api/meta', { proof })).body.id, 'alice');
  assert.equal((await f.request('/api/meta', { proof })).status, 409);
  assert.equal((await f.request('/api/unknown', { proof: f.sign('/api/unknown', 'daemon.inspect') })).status, 403);
});

test('strict creation persists only verified principal ownership and refuses ordinary adoption of legacy records', async t => {
  const f = await fixture(t);
  const body = { session_id: 'mine', delivery_type: 'mailbox', owningPrincipal: { id: 'operator' } };
  const created = await f.request('/api/sessions/register', { method: 'POST', body,
    proof: f.sign('/api/sessions/register', 'session.register', body, { method: 'POST' }) });
  assert.equal(created.status, 201);
  assert.equal(f.sessions.mine.owningPrincipal.id, 'alice');
  const disk = persistence.loadPersistedSessions(f.file);
  assert.equal(disk.mine.owningPrincipal.id, 'alice');
  assert.equal(persistence.buildRestoredWrappedSession('mine', disk.mine).owningPrincipal.id, 'alice');
  const report = await f.request('/api/sessions/mine', { proof: f.sign('/api/sessions/mine', 'session.inspect') });
  assert.equal(report.status, 200);
  const mutation = { phase: 'working' };
  assert.equal((await f.request('/api/sessions/legacy/state', { method: 'POST', body: mutation,
    proof: f.sign('/api/sessions/legacy/state', 'session.state', mutation, { method: 'POST', sessionEpoch: 'legacy-epoch' }) })).status, 403);
  assert.equal((await f.request('/api/sessions/legacy', { proof: f.sign('/api/sessions/legacy', 'session.inspect') })).status, 403);
  assert.equal((await f.request('/api/sessions/legacy', { proof: f.sign('/api/sessions/legacy', 'session.inspect', undefined, { id: 'operator' }) })).status, 200);
  const register = { session_id: 'legacy', command: 'take over' };
  assert.equal((await f.request('/api/sessions/register', { method: 'POST', body: register,
    proof: f.sign('/api/sessions/register', 'session.register', register, { method: 'POST', sessionEpoch: 'legacy-epoch' }) })).status, 403);
  assert.equal(f.sessions.legacy.owningPrincipal, undefined);
});

test('exact cross-session inject grants work without implying owner or operator mutation authority', async t => {
  const f = await fixture(t), body = { prompt: 'synthetic' };
  assert.equal((await f.request('/api/sessions/legacy/inject', { method: 'POST', body,
    proof: f.sign('/api/sessions/legacy/inject', 'session.inject', body, { method: 'POST' }) })).status, 200);
  assert.equal((await f.request('/api/sessions/legacy/state', { method: 'POST', body,
    proof: f.sign('/api/sessions/legacy/state', 'session.state', body, { id: 'operator', method: 'POST', sessionEpoch: 'legacy-epoch' }) })).status, 403);
});

test('ambiguous raw JSON and exact path/query/body mismatches refuse before routes', async t => {
  const f = await fixture(t), target = '/api/sessions/legacy/inject', body = { prompt: 'signed' };
  assert.equal((await f.request(target, { method: 'POST', raw: '{"prompt":"other","prompt":"signed"}',
    proof: f.sign(target, 'session.inject', body, { method: 'POST' }) })).status, 400);
  assert.equal((await f.request(target, { method: 'POST', body: { prompt: 'other' },
    proof: f.sign(target, 'session.inject', body, { method: 'POST' }) })).status, 401);
  assert.equal((await f.request(target + '?no_enter=false', { method: 'POST', body,
    proof: f.sign(target + '?no_enter=true', 'session.inject', body, { method: 'POST' }) })).status, 401);
});

test('legacy mode retains shared token behavior without signed principal or owner adoption', async t => {
  const f = await fixture(t, { strict: false });
  assert.equal((await f.request('/api/meta', { headers: { 'x-telepty-token': 'legacy-secret' } })).status, 200);
  assert.equal(f.sessions.legacy.owningPrincipal, undefined);
});

test('static fanout paths and encoded aliases cannot turn an exact inject grant into other-session writes', async t => {
  const f = await fixture(t), body = { prompt: 'never delivered', session_ids: ['mine', 'legacy'] };
  for (const target of ['/api/sessions/broadcast/inject', '/api/sessions/multicast/inject',
    '/api/sessions/%62roadcast/inject', '/api/sessions/%6dulticast/inject']) {
    assert.equal((await f.request(target, { method: 'POST', body,
      proof: f.sign(target, 'session.inject', body, { method: 'POST' }) })).status, 403);
  }
  for (const target of ['/api/sessions/alias/inject', '/api/sessions/%61lias/inject']) {
    assert.equal((await f.request(target, { method: 'POST', body,
      proof: f.sign(target, 'session.inject', body, { method: 'POST' }) })).status, 404);
  }
  for (const target of ['/api/sessions/submit-all', '/api/bus/publish']) {
    assert.equal((await f.request(target, { method: 'POST', body,
      proof: f.sign(target, 'session.inject', body, { method: 'POST' }) })).status, 403);
  }
  // The newly recognized forwarded path still refuses an ordinary inject assertion;
  // a correctly bound forwarded assertion separately requires its explicit grant.
  const forwarded = '/api/forwarded/sessions/legacy/inject';
  assert.equal((await f.request(forwarded, { method: 'POST', body,
    proof: f.sign(forwarded, 'session.inject', body, { method: 'POST' }) })).status, 401);
  const exactBody = { ...body, expected_epoch: 'legacy-epoch' };
  assert.equal((await f.request(forwarded, { method: 'POST', body: exactBody,
    proof: f.sign(forwarded, 'session.forwarded_inject', exactBody, { method: 'POST', sessionEpoch: 'legacy-epoch' }) })).status, 403);
  assert.deepEqual(f.writes, []);
});

test('owned destructive operations require the current exact epoch even with a valid principal', async t => {
  const f = await fixture(t);
  f.sessions.mine = { id: 'mine', type: 'wrapped', sessionEpoch: 'current-fixture-epoch',
    owningPrincipal: { id: 'alice', source: 'ed25519', audience: 'fixture-node' } };
  for (const sessionEpoch of [undefined, 'old-fixture-epoch']) {
    assert.equal((await f.request('/api/sessions/mine', { method: 'DELETE',
      proof: f.sign('/api/sessions/mine', 'session.destroy', undefined, { method: 'DELETE', sessionEpoch }) })).status, 401);
  }
  assert.equal((await f.request('/api/sessions/mine', { method: 'DELETE',
    proof: f.sign('/api/sessions/mine', 'session.destroy', undefined, { method: 'DELETE', sessionEpoch: 'current-fixture-epoch' }) })).status, 200);
});

test('real strict daemon persists ownership, retains session-token gates and changes its startup challenge', { skip: process.platform !== 'linux', timeout: 15000 }, async t => {
  const { startTestDaemon } = require('../test-support/daemon-harness');
  const home = temp(t), config = configuration(), trustFile = path.join(home, 'public-trust.json');
  fs.writeFileSync(trustFile, JSON.stringify(config.json), { mode: 0o600 });
  const env = { TELEPTY_PRINCIPAL_MODE: 'strict', TELEPTY_PRINCIPAL_TRUST_FILE: trustFile, TELEPTY_MACHINE_ID: 'fixture-node' };
  let daemon = await startTestDaemon({ homeDir: home, env });
  t.after(async () => { if (daemon) await daemon.stop(); });
  const challenge = (await daemon.request('/api/auth/challenge', { noAuth: true })).body.challenge;
  const sign = (target, action, body, method = 'GET', extra = {}) => createSignedAssertion({ privateKey: config.alice.privateKey,
    keyId: 'alice', principalId: 'alice', audience: 'fixture-node', challenge, target, action, body, method, ...extra });
  assert.equal((await daemon.request('/api/meta')).status, 401, 'shared daemon secret is not strict principal proof');
  const body = { session_id: 'mine', delivery_type: 'mailbox', require_owner_proof: true };
  const created = await daemon.request('/api/sessions/register', { method: 'POST', body,
    headers: { 'x-telepty-principal': sign('/api/sessions/register', 'session.register', body, 'POST') } });
  assert.equal(created.status, 201);
  const bearer = created.body.session_token, epoch = created.body.session_epoch;
  const renew = { session_id: 'mine', delivery_type: 'mailbox' };
  const proof = () => sign('/api/sessions/register', 'session.register', renew, 'POST', { sessionEpoch: epoch });
  assert.equal((await daemon.request('/api/sessions/register', { method: 'POST', body: renew,
    headers: { 'x-telepty-principal': proof() } })).status, 403, 'principal proof does not bypass the current session bearer');
  assert.equal((await daemon.request('/api/sessions/register', { method: 'POST', body: renew,
    headers: { 'x-telepty-principal': proof(), 'x-telepty-session-token': bearer } })).status, 200);
  const oldProof = sign('/api/meta', 'daemon.inspect');
  await daemon.kill();
  daemon = await startTestDaemon({ homeDir: home, env });
  const nextChallenge = (await daemon.request('/api/auth/challenge', { noAuth: true })).body.challenge;
  assert.notEqual(nextChallenge, challenge);
  assert.equal((await daemon.request('/api/meta', { headers: { 'x-telepty-principal': oldProof } })).status, 401);
  const inspect = createSignedAssertion({ privateKey: config.alice.privateKey, keyId: 'alice', principalId: 'alice',
    audience: 'fixture-node', challenge: nextChallenge, target: '/api/sessions/mine', method: 'GET', action: 'session.inspect' });
  const restored = await daemon.request('/api/sessions/mine', { headers: { 'x-telepty-principal': inspect } });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.owningPrincipal.id, 'alice');
  const WebSocket = require('ws');
  const ws = new WebSocket(`ws://${daemon.host}:${daemon.port}/api/sessions/mine?token=${daemon.authToken()}`);
  const refused = new Promise((resolve, reject) => {
    ws.once('unexpected-response', (_request, res) => { const code = res.headers['x-telepty-refusal']; res.resume(); ws.terminate(); resolve(code); });
    ws.on('error', () => {}); ws.once('open', () => { ws.terminate(); reject(new Error('strict mode upgraded legacy WebSocket')); });
  });
  t.after(() => ws.terminate());
  assert.equal(await refused, 'PRINCIPAL_WEBSOCKET_UNSUPPORTED');
});

test('explicit strict daemon with missing trust fails before any listening socket', { timeout: 5000 }, async t => {
  const { spawn } = require('node:child_process');
  const home = temp(t);
  const child = spawn(process.execPath, ['daemon.js'], { cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, HOME: home, USERPROFILE: home, PORT: '0', HOST: '127.0.0.1',
      TELEPTY_AUTH_TOKEN: 'synthetic-daemon-secret', TELEPTY_PRINCIPAL_MODE: 'strict',
      TELEPTY_PRINCIPAL_TRUST_FILE: path.join(home, 'missing-public-trust.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  assert.notEqual(await exited, 0);
  assert.match(output, /PRINCIPAL_TRUST_UNAVAILABLE/);
  assert.doesNotMatch(output, /listening on/);
  assert.equal(output.includes('synthetic-daemon-secret'), false);
});

test('forged or inherited request metadata cannot assign a session owner', () => {
  const { verifiedOwningPrincipal } = require('../src/principal/http');
  const config = configuration();
  const authentication = createPrincipalAuthentication({ trust: validateTrustConfiguration(config.json, { audience: 'fixture-node' }), sessions: {} });
  const document = { privateKey: config.alice.privateKey, keyId: 'alice', principalId: 'alice', audience: 'fixture-node',
    challenge: authentication.verifier.challenge, method: 'GET', target: '/api/meta', action: 'daemon.inspect' };
  const req = { method: 'GET', originalUrl: '/api/meta', headers: { 'x-telepty-principal': createSignedAssertion(document) } };
  assert.equal(authentication.authorize(req).ok, true);
  assert.equal(verifiedOwningPrincipal(req).id, 'alice');
  assert.equal(verifiedOwningPrincipal(Object.create(req)), null);
  assert.equal(verifiedOwningPrincipal({ authenticationPrincipal: req.authenticationPrincipal }), null);
});

test('ordinary registration cannot manufacture OS process custody or external delivery authority', async t => {
  const f = await fixture(t);
  for (const body of [{ session_id: 'mine', owner_pid: 111, pty_pid: 222 },
    { session_id: 'mine', delivery_type: 'aterm', delivery_endpoint: 'http://internal.invalid/' }]) {
    assert.equal((await f.request('/api/sessions/register', { method: 'POST', body,
      proof: f.sign('/api/sessions/register', 'session.register', body, { method: 'POST' }) })).status, 403);
    assert.equal(f.sessions.mine, undefined);
  }
  const spawn = { session_id: 'new-pty', command: 'synthetic' };
  assert.equal((await f.request('/api/sessions/spawn', { method: 'POST', body: spawn,
    proof: f.sign('/api/sessions/spawn', 'session.create', spawn, { method: 'POST' }) })).status, 403);
  const mailbox = { session_id: 'mine', delivery_type: 'mailbox', owner_pid: 111, pty_pid: 222 };
  assert.equal((await f.request('/api/sessions/register', { method: 'POST', body: mailbox,
    proof: f.sign('/api/sessions/register', 'session.register', mailbox, { method: 'POST' }) })).status, 201);
  assert.equal(f.sessions.mine.ownerPid, null); assert.equal(f.sessions.mine.ptyPid, null);
  const operatorBody = { session_id: 'operator-wrapper', owner_pid: 111, command: 'synthetic' };
  assert.equal((await f.request('/api/sessions/register', { method: 'POST', body: operatorBody,
    proof: f.sign('/api/sessions/register', 'session.register', operatorBody, { id: 'operator', method: 'POST' }) })).status, 201);
  assert.equal(f.sessions['operator-wrapper'].owningPrincipal.id, 'operator');
});
