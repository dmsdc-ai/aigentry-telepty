'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { projectSessionEvent } = require('../src/transport/session-events');
test('trusted session event projection drops unknown kinds and all arbitrary event fields', () => {
  const session = { sessionEpoch: 'epoch' };
  const event = { type: 'fake', session_id: 'other-secret-session', cwd: '/private', command: 'secret', pid: 123, prompt: 'secret', token: 'secret',
    transport: { health_status: 'CONNECTED', owner_pid: 12 }, semantic: { current_task: 'secret' }, extra: { source: 'foreign' } };
  const projected = projectSessionEvent(session, 'mine', 'session_health', event);
  assert.equal(projected.type, 'session_health'); assert.equal(projected.session_id, 'mine');
  assert.equal(projected.session_epoch, 'epoch'); assert.equal(projected.health_status, 'CONNECTED');
  assert.equal(JSON.stringify(projected).includes('secret'), false); assert.equal(JSON.stringify(projected).includes('other-secret-session'), false);
  assert.equal(projectSessionEvent(session, 'mine', 'turn_request', event), null);
  assert.equal(projectSessionEvent(session, 'mine', 'app_event', event), null);
});
const crypto = require('node:crypto');
const http = require('node:http');
const WebSocket = require('ws');
const { createPrincipalAuthentication } = require('../src/principal/http');
const { validateTrustConfiguration, createSignedAssertion } = require('../src/principal/proof');
const { createSessionEventTransport, publishTrustedSessionEvent } = require('../src/transport/session-events');
const { waitFor, startTestDaemon } = require('../test-support/daemon-harness');
function fixture() {
  const pair = crypto.generateKeyPairSync('ed25519'), other = crypto.generateKeyPairSync('ed25519'), operator = crypto.generateKeyPairSync('ed25519');
  const names = ['mine', ...Array.from({ length: 8 }, (_, i) => `session${i}`)];
  const sessions = Object.fromEntries(names.map(id => [id, { sessionEpoch: 'epoch', credentialGeneration: 1,
    owningPrincipal: { id: 'reader', source: 'ed25519', audience: 'fixture' } }]));
  const key = (keyId, pair, authority) => ({ key_id: keyId, principal_id: keyId, ...(authority ? { authority } : {}), public_key_spki: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    grants: ['session.events', 'session.observe'].map(action => ({ action, targets: names })) });
  const trust = validateTrustConfiguration({ schema: 'telepty.principals/v1', audience: 'fixture', keys: [key('reader', pair), key('other', other), key('operator', operator, 'operator')] });
  const auth = createPrincipalAuthentication({ trust, sessions });
  const sign = (extra = {}, signer = 'reader') => createSignedAssertion({ privateKey: ({ reader: pair, other, operator })[signer].privateKey,
    keyId: signer, principalId: signer, audience: 'fixture', challenge: auth.verifier.challenge,
    method: 'GET', target: '/api/events/sessions/mine', action: 'session.events', sessionEpoch: 'epoch', transport: 'websocket', body: {}, ...extra });
  const req = proof => ({ method: 'GET', url: '/api/events/sessions/mine', headers: { 'x-telepty-principal': proof }, rawHeaders: [] });
  return { sessions, session: sessions.mine, auth, sign, req };
}
function open(url, headers) {
  return new Promise(resolve => {
    const ws = new WebSocket(url, { headers }), frames = [];
    ws.on('message', bytes => frames.push(JSON.parse(bytes))); ws.on('error', () => {});
    ws.once('open', () => resolve({ ws, frames }));
    ws.once('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve({ status: res.statusCode }); });
  });
}
test('session events use an exact separate grant, current epoch, header proof and owner/operator read policy', () => {
  const f = fixture(), proof = f.sign();
  assert.equal(f.auth.authorizeEvents(f.req(proof)).ok, true);
  assert.equal(f.auth.authorizeEvents(f.req(proof)).ok, false);
  const nonce = 'shared-cache-nonce-00000000000001';
  assert.equal(f.auth.authorizeEvents(f.req(f.sign({ nonce }))).ok, true);
  const otherRoute = { ...f.req(f.sign({ nonce, target: '/api/observe/sessions/mine', action: 'session.observe' })), url: '/api/observe/sessions/mine' };
  assert.equal(f.auth.authorizeObserver(otherRoute).ok, false);
  for (const extra of [{ action: 'session.observe' }, { transport: 'http' }, { sessionEpoch: 'stale' }, { target: '/api/events/sessions/mine?filter=legacy' }]) {
    assert.equal(f.auth.authorizeEvents(f.req(f.sign(extra))).ok, false);
  }
  assert.equal(f.auth.authorizeEvents(f.req(f.sign({}, 'other'))).ok, false);
  assert.equal(f.auth.authorizeEvents(f.req(f.sign({}, 'operator'))).ok, true);
  assert.equal(f.auth.authorizeEvents({ ...f.req(f.sign()), rawHeaders: ['x-telepty-principal', 'a', 'X-Telepty-Principal', 'b'] }).ok, false);
  assert.equal(f.auth.authorizeEvents({ ...f.req(f.sign()), headers: { 'x-telepty-token': 'legacy' } }).ok, false);
});
async function transportFixture(t) {
  const f = fixture(), server = http.createServer(); let allowedPeer = true;
  const transport = createSessionEventTransport({ authentication: f.auth, sessions: f.sessions, server,
    refuse: (s, status) => s.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`),
    forbiddenOrigin: value => !!value, allowedPeer: () => allowedPeer });
  server.on('upgrade', (req, socket, head) => transport.handle(req, socket, head));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { transport.close(); server.close(); });
  const url = `ws://127.0.0.1:${server.address().port}/api/events/sessions/mine`;
  const connect = (extra = {}, headers = {}) => open(url, { 'x-telepty-principal': f.sign(extra), ...headers });
  return { ...f, transport, url, connect, denyPeer: () => { allowedPeer = false; } };
}
test('real event sockets receive projected trusted same-session events only and reject every application frame', async t => {
  const f = await transportFixture(t), c = await f.connect(); await waitFor(() => c.frames.length);
  assert.equal(c.frames[0].read_only, true);
  const secret = { prompt: 'SENSITIVE_SENTINEL', command: 'SENSITIVE_SENTINEL', transport: { health_status: 'CONNECTED', owner_pid: 123 }, semantic: { current_task: 'SENSITIVE_SENTINEL' } };
  publishTrustedSessionEvent(f.sessions.session0, 'session0', 'session_health', secret);
  publishTrustedSessionEvent(f.session, 'wrong-session', 'session_health', secret);
  publishTrustedSessionEvent(f.session, 'mine', 'turn_request', secret);
  publishTrustedSessionEvent(f.session, 'mine', 'session_health', secret);
  await waitFor(() => c.frames.length === 2);
  assert.equal(c.frames[1].type, 'session_health'); assert.equal(JSON.stringify(c.frames).includes('SENSITIVE_SENTINEL'), false);
  assert.equal(c.frames[1].health_status, 'CONNECTED');
  for (const type of ['input', 'resize', 'owner', 'subscribe', 'session_state_report', 'turn_request', 'app.event']) {
    const writer = await f.connect(); writer.ws.send(JSON.stringify({ type, payload: 'must-never-write' })); await waitFor(() => writer.ws.readyState === 3);
  }
  assert.equal((await f.connect({}, { origin: 'https://foreign.invalid' })).status, 403);
  f.denyPeer(); assert.equal((await f.connect()).status, 403);
});
test('event sockets fence all session identity changes and backpressure before another event', async t => {
  const f = await transportFixture(t);
  for (const mutate of [() => { f.sessions.mine = { ...f.session }; }, () => { f.session.sessionEpoch = 'changed'; },
    () => { f.session.credentialGeneration++; }, () => { f.session.interactionOwnerGeneration = 'changed'; },
    () => { f.session.ownerWs = {}; }, () => { f.session.owningPrincipal.id = 'other'; }, () => { f.session.isClosing = true; }]) {
    f.sessions.mine = f.session; f.session.sessionEpoch = 'epoch'; f.session.credentialGeneration = 1;
    delete f.session.interactionOwnerGeneration; delete f.session.ownerWs; delete f.session.isClosing; f.session.owningPrincipal.id = 'reader';
    const c = await f.connect(); await waitFor(() => c.frames.length); mutate();
    publishTrustedSessionEvent(f.session, 'mine', 'session_state_report', {});
    await waitFor(() => c.ws.readyState === 3); assert.equal(c.frames.length, 1);
  }
  f.session.isClosing = false; f.session.owningPrincipal.id = 'reader';
  const c = await f.connect(); await waitFor(() => c.frames.length);
  const serverWs = [...f.transport.wss.clients].at(-1); Object.defineProperty(serverWs, 'bufferedAmount', { value: 131072 });
  publishTrustedSessionEvent(f.session, 'mine', 'session_health', {}); await waitFor(() => c.ws.readyState === 3);
  assert.equal(c.frames.length, 1);
});
test('event sockets enforce finite TTL and global/per-principal-session caps', async t => {
  const f = await transportFixture(t);
  const short = await f.connect({ ttlSeconds: 1 }); await waitFor(() => short.ws.readyState === 3, { timeoutMs: 2000 });
  const clients = [];
  for (let i = 0; i < 8; i++) clients.push(await f.connect());
  assert.equal((await f.connect()).status, 503);
  for (let sid = 0; sid < 7; sid++) for (let i = 0; i < 8; i++) {
    const path = `/api/events/sessions/session${sid}`;
    clients.push(await open(f.url.replace('/mine', `/session${sid}`), { 'x-telepty-principal': f.sign({ target: path }) }));
  }
  const path = '/api/events/sessions/session7';
  assert.equal((await open(f.url.replace('/mine', '/session7'), { 'x-telepty-principal': f.sign({ target: path }) })).status, 503);
  f.transport.close(); await waitFor(() => clients.every(c => c.ws.readyState === 3));
});
test('actual strict daemon publishes projected committed state events without legacy bus access', { skip: process.platform !== 'linux', timeout: 10000 }, async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-session-events-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const pair = crypto.generateKeyPairSync('ed25519'), trustPath = path.join(home, 'trust.json');
  fs.writeFileSync(trustPath, JSON.stringify({ schema: 'telepty.principals/v1', audience: 'events-fixture', keys: [{ key_id: 'operator', principal_id: 'operator', authority: 'operator',
    public_key_spki: pair.publicKey.export({ type: 'spki', format: 'pem' }), grants: ['session.register', 'session.state', 'session.events'].map(action => ({ action, targets: ['mine', 'other'] })) }] }), { mode: 0o600 });
  const daemon = await startTestDaemon({ homeDir: home, env: { TELEPTY_PRINCIPAL_MODE: 'strict', TELEPTY_PRINCIPAL_TRUST_FILE: trustPath, TELEPTY_MACHINE_ID: 'events-fixture' } });
  t.after(() => daemon.stop());
  const challenge = (await daemon.request('/api/auth/challenge', { noAuth: true })).body.challenge;
  const sign = extra => createSignedAssertion({ privateKey: pair.privateKey, keyId: 'operator', principalId: 'operator', audience: 'events-fixture',
    challenge, method: 'GET', target: '/api/events/sessions/mine', action: 'session.events', transport: 'websocket', body: {}, ...extra });
  const epochs = {};
  for (const sid of ['mine', 'other']) {
    const body = { session_id: sid, command: 'SENSITIVE_COMMAND_SENTINEL', cwd: home };
    const result = await daemon.request('/api/sessions/register', { method: 'POST', body,
      headers: { 'x-telepty-principal': sign({ method: 'POST', target: '/api/sessions/register', action: 'session.register', transport: 'http', body }) } });
    assert.equal(result.status, 201); epochs[sid] = result.body.session_epoch;
  }
  const url = `ws://${daemon.host}:${daemon.port}/api/events/sessions/mine`, proof = sign({ sessionEpoch: epochs.mine });
  const c = await open(url, { 'x-telepty-principal': proof }); assert.ok(c.ws); t.after(() => c.ws.terminate());
  assert.equal((await open(url, { 'x-telepty-principal': proof })).status, 409);
  assert.equal((await open(url + '?token=legacy', { 'x-telepty-principal': sign({ sessionEpoch: epochs.mine }) })).status, 403);
  assert.equal((await open(`ws://${daemon.host}:${daemon.port}/api/bus`, { 'x-telepty-principal': sign({ sessionEpoch: epochs.mine }) })).status, 401);
  const state = async sid => {
    const body = { phase: 'SENSITIVE_TASK_SENTINEL', current_task: 'SENSITIVE_TASK_SENTINEL', thread_id: 'SENSITIVE_THREAD_SENTINEL', source: 'SENSITIVE_SOURCE_SENTINEL' };
    return daemon.request(`/api/sessions/${sid}/state`, { method: 'POST', body, headers: { 'x-telepty-principal': sign({
      method: 'POST', target: `/api/sessions/${sid}/state`, action: 'session.state', body, transport: 'http', sessionEpoch: epochs[sid] }) } });
  };
  assert.equal((await state('other')).status, 200);
  assert.equal((await state('mine')).status, 200);
  await waitFor(() => c.frames.some(frame => frame.type === 'session_state_report'));
  assert.ok(c.frames.every(frame => frame.session_id === 'mine'));
  const encoded = JSON.stringify(c.frames);
  for (const secret of ['SENSITIVE_', home, 'session_token', 'owner_pid', 'current_task', 'thread_id']) assert.equal(encoded.includes(secret), false);
  const rawBus = { type: 'session_state_report', session_id: 'mine', phase: 'should-not-publish' };
  const denied = await daemon.request('/api/bus/publish', { method: 'POST', body: rawBus, headers: { 'x-telepty-principal': sign({
    method: 'POST', target: '/api/bus/publish', action: 'session.state', transport: 'http', body: rawBus, sessionEpoch: epochs.mine }) } });
  assert.equal(denied.status, 403);
});
