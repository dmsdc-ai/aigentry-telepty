'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validApplicationBody } = require('../src/application-publication');
test('application publication bounds opaque data without accepting envelope overrides', () => {
  const body = { expected_epoch: 'epoch', topic: 'app/task.notice', data: { type: 'turn_request', prompt: 'opaque' } };
  assert.equal(validApplicationBody(body, 'epoch'), true);
  for (const bad of [{ ...body, type: 'session_health' }, { ...body, from: 'other' }, { ...body, expected_epoch: 'old' },
    { ...body, topic: 'session_health' }, { ...body, data: 'x'.repeat(4097) }, { ...body, data: Array(129).fill(0) }]) assert.equal(validApplicationBody(bad, 'epoch'), false);
  let deep = {}; for (let i = 0; i < 10; i++) deep = { deep };
  assert.equal(validApplicationBody({ ...body, data: deep }, 'epoch'), false);
});
const crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const WebSocket = require('ws');
const { createSignedAssertion, validateTrustConfiguration } = require('../src/principal/proof');
const { createPrincipalAuthentication } = require('../src/principal/http');
const { startTestDaemon, waitFor } = require('../test-support/daemon-harness');
function open(url, proof) { return new Promise(resolve => {
  const ws = new WebSocket(url, { headers: { 'x-telepty-principal': proof } }), frames = [];
  ws.on('message', bytes => frames.push(JSON.parse(bytes))); ws.on('error', () => {}); ws.once('open', () => resolve({ ws, frames }));
  ws.once('unexpected-response', (_r, res) => { res.resume(); ws.terminate(); resolve({ status: res.statusCode }); });
}); }
test('actual private daemon isolates opaque application events from trusted events, routing and caller authority', { timeout: 15000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'application-events-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const pairs = Object.fromEntries(['owner','outsider','reader','weak'].map(id => [id, crypto.generateKeyPairSync('ed25519')]));
  const entry = (key, principal, authority, actions) => ({ key_id: key, principal_id: principal, ...(authority ? { authority } : {}),
    public_key_spki: pairs[key].publicKey.export({ type: 'spki', format: 'pem' }), grants: actions.map(action => ({ action, targets: ['mine','other'] })) });
  const trustFile = path.join(home, 'trust'); fs.writeFileSync(trustFile, JSON.stringify({ schema: 'telepty.principals/v1', audience: 'fixture', keys: [
    entry('owner','owner','operator',['session.register','session.publish','session.app_events','session.events','session.bus','mailbox.read']),
    entry('outsider','outsider','operator',['session.publish','session.app_events','session.bus']), entry('reader','reader',undefined,['session.app_events']),
    entry('weak','owner',undefined,['session.bus'])] }), { mode: 0o600 });
  const daemon = await startTestDaemon({ homeDir: home, env: { TELEPTY_PRINCIPAL_MODE: 'strict', TELEPTY_PRINCIPAL_TRUST_FILE: trustFile, TELEPTY_MACHINE_ID: 'fixture' } }); t.after(() => daemon.stop());
  const challenge = (await daemon.request('/api/auth/challenge', { noAuth: true })).body.challenge;
  const sign = (extra, key = 'owner') => createSignedAssertion({ privateKey: pairs[key].privateKey, keyId: key, principalId: key === 'weak' ? 'owner' : key, audience: 'fixture',
    challenge, method: 'GET', target: '/api/application-events/sessions/mine', action: 'session.app_events', transport: 'websocket', body: {}, ...extra });
  const epochs = {};
  for (const sid of ['mine','other']) {
    const body = { session_id: sid, delivery_type: 'mailbox' };
    const created = await daemon.request('/api/sessions/register', { method: 'POST', body, headers: { 'x-telepty-principal': sign({ method: 'POST', target: '/api/sessions/register', action: 'session.register', transport: 'http', body }) } });
    assert.equal(created.status, 201); epochs[sid] = created.body.session_epoch;
  }
  const data = { type: 'turn_request', target: 'mine', sender: 'daemon', from: 'outsider', trusted_daemon_event: true,
    actor: { id: 'forged' }, payload: { prompt: 'OPAQUE_APPLICATION_SECRET' } };
  const pubBody = sid => ({ expected_epoch: epochs[sid], topic: 'app/turn_request', data });
  const publish = (sid, body = pubBody(sid), key = 'owner') => daemon.request(`/api/sessions/${sid}/events`, { method: 'POST', body, headers: { 'x-telepty-principal': sign({
    method: 'POST', target: `/api/sessions/${sid}/events`, action: 'session.publish', transport: 'http', sessionEpoch: epochs[sid], body }, key) } });
  const early = await publish('mine'); assert.equal(early.status, 200); assert.equal(early.body.matched_socket_count, 0); assert.equal(early.body.delivery_ack, false);
  const url = `ws://${daemon.host}:${daemon.port}/api/application-events/sessions/mine`;
  const proof = sign({ sessionEpoch: epochs.mine }), owner = await open(url, proof); assert.ok(owner.ws); t.after(() => owner.ws.terminate()); await waitFor(() => owner.frames.length);
  assert.equal((await open(url, proof)).status, 409);
  assert.equal((await open(url, sign({ sessionEpoch: epochs.mine }, 'reader'))).status, 403);
  assert.equal((await open(url, sign({ action: 'session.events', sessionEpoch: epochs.mine }))).status, 401);
  assert.equal((await open(url + '?token=legacy', sign({ sessionEpoch: epochs.mine }))).status, 403);
  const outsider = await open(url, sign({ sessionEpoch: epochs.mine }, 'outsider')); assert.ok(outsider.ws); t.after(() => outsider.ws.terminate());
  const trusted = await open(url.replace('/application-events/', '/events/'), sign({ target: '/api/events/sessions/mine', action: 'session.events', sessionEpoch: epochs.mine })); t.after(() => trusted.ws.terminate()); await waitFor(() => trusted.frames.length);
  const published = await publish('mine'); assert.equal(published.status, 200); assert.equal(published.body.matched_socket_count, 2);
  await waitFor(() => owner.frames.length === 2 && outsider.frames.length === 2);
  const event = owner.frames[1]; assert.equal(event.type, 'application_event'); assert.equal(event.trusted_daemon_event, false); assert.equal(event.data_untrusted, true);
  assert.deepEqual(event.actor, { id: 'owner', key_id: 'owner', audience: 'fixture', source: 'ed25519' }); assert.deepEqual(event.data, data);
  assert.equal(event.session_id, 'mine'); assert.equal(event.session_epoch, epochs.mine); assert.equal(event.publication_id, published.body.publication_id);
  assert.equal(event.foreign_session_identity_verified, false); assert.equal(trusted.frames.some(frame => frame.type === 'application_event'), false);
  await publish('other'); assert.equal(owner.frames.length, 2);
  assert.equal((await publish('mine', pubBody('mine'), 'outsider')).status, 403);
  assert.equal((await publish('mine', { ...pubBody('mine'), type: 'session_health' })).status, 400);
  assert.equal((await publish('mine', { ...pubBody('mine'), data: 'x'.repeat(4097) })).status, 400);
  assert.equal((await publish('mine', { ...pubBody('mine'), expected_epoch: 'old' })).status, 400);
  const mailbox = await daemon.request('/api/sessions/mine/mailbox', { headers: { 'x-telepty-principal': sign({ target: '/api/sessions/mine/mailbox', action: 'mailbox.read', transport: 'http', body: undefined }) } });
  assert.equal(mailbox.body.pending.length, 0, 'nested turn_request remains inert application data');
  const busUrl = `ws://${daemon.host}:${daemon.port}/api/bus/sessions/mine`;
  const connectBus = async key => { const c = await open(busUrl, sign({ target: '/api/bus/sessions/mine', action: 'session.bus', sessionEpoch: epochs.mine }, key)); assert.ok(c.ws); t.after(() => c.ws.terminate()); await waitFor(() => c.frames.length); return c; };
  const bus = await connectBus('owner'), body = pubBody('mine'), key = 'app-publication-key-0001';
  const frame = sequence => ({ type: 'app_publish', connection_id: bus.frames[0].connection_id, sequence, idempotency_key: key, body,
    assertion: sign({ method: 'POST', target: '/api/sessions/mine/events', action: 'session.publish', transport: 'http', sessionEpoch: epochs.mine, body }) });
  bus.ws.send(JSON.stringify(frame(1))); await waitFor(() => bus.frames.length === 2 && owner.frames.length === 3);
  assert.equal(bus.frames[1].state, 'accepted'); assert.equal(bus.frames[1].matched_socket_count, 2); assert.equal(bus.frames[1].delivery_ack, false);
  assert.equal(JSON.stringify(bus.frames).includes('OPAQUE_APPLICATION_SECRET'), false);
  bus.ws.send(JSON.stringify(frame(2))); await waitFor(() => bus.frames.length === 3); assert.equal(bus.frames[2].publication_id, bus.frames[1].publication_id); assert.equal(owner.frames.length, 3);
  const dir = path.join(home, '.telepty', 'forward-receipts'), count = fs.readdirSync(dir).length;
  for (const [actor, code] of [['outsider','PRINCIPAL_SESSION_OWNER_REQUIRED'],['weak','PRINCIPAL_GRANT_DENIED']]) {
    const c = await connectBus(actor); c.ws.send(JSON.stringify({ ...frame(1), connection_id: c.frames[0].connection_id,
      assertion: sign({ method: 'POST', target: '/api/sessions/mine/events', action: 'session.publish', transport: 'http', sessionEpoch: epochs.mine, body }, actor) }));
    await waitFor(() => c.frames.length === 2); assert.equal(c.frames[1].code, code); assert.equal(c.frames[1].state, 'refused'); assert.equal(fs.readdirSync(dir).length, count);
  }
  const stored = fs.readdirSync(dir).map(name => fs.readFileSync(path.join(dir, name), 'utf8')).join(''); assert.equal(stored.includes('OPAQUE_APPLICATION_SECRET'), false);
  const activeWriter = await open(url, sign({ sessionEpoch: epochs.mine })); t.after(() => activeWriter.ws.terminate()); activeWriter.ws.send(JSON.stringify({ type: 'publish', body })); await waitFor(() => activeWriter.ws.readyState === 3);
});
const { createApplicationEventTransport } = require('../src/transport/application-events');
const { createStrictBusTransport } = require('../src/transport/strict-bus');
const { registerApplicationEventRoute } = require('../src/routes/application-events');
test('application readers require actual TLS or literal loopback, ignoring forwarded headers', () => {
  let verified = 0, refusal;
  const transport = createApplicationEventTransport({ authentication: { authorizeApplicationEvents() { verified++; return { ok: false, status: 401, code: 'PROOF_REQUIRED' }; } }, sessions: {},
    refuse: (_socket, _status, _reason, code) => { refusal = code; }, forbiddenOrigin: () => false, allowedPeer: () => true });
  for (const socket of [{ remoteAddress: '192.0.2.1' }, { remoteAddress: '127.0.0.2' }, { remoteAddress: '192.0.2.1', encrypted: false }]) {
    transport.handle({ method: 'GET', url: '/api/application-events/sessions/mine', socket, headers: { 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'https' } }, socket, Buffer.alloc(0));
    assert.equal(refusal, 'APPLICATION_EVENTS_SECURE_TRANSPORT_REQUIRED');
  }
  assert.equal(verified, 0);
  for (const socket of [{ remoteAddress: '127.0.0.1' }, { remoteAddress: '::1' }, { remoteAddress: '192.0.2.1', encrypted: true }]) {
    transport.handle({ method: 'GET', url: '/api/application-events/sessions/mine', socket, headers: {} }, socket, Buffer.alloc(0)); assert.equal(refusal, 'PROOF_REQUIRED');
  }
  assert.equal(verified, 3); transport.close();
});
test('lost bus publication response stays unknown without republishing after transport restart', async t => {
  const express = require('express'), http = require('node:http');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'application-unknown-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const pair = crypto.generateKeyPairSync('ed25519'), session = { sessionEpoch: 'epoch', credentialGeneration: 1, owningPrincipal: { id: 'owner', source: 'ed25519', audience: 'fixture' } }, sessions = { mine: session };
  const trust = validateTrustConfiguration({ schema: 'telepty.principals/v1', audience: 'fixture', keys: [{ key_id: 'owner', principal_id: 'owner', public_key_spki: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    grants: ['session.bus','session.publish','session.app_events'].map(action => ({ action, targets: ['mine'] })) }] });
  const authentication = createPrincipalAuthentication({ trust, sessions });
  const sign = extra => createSignedAssertion({ privateKey: pair.privateKey, keyId: 'owner', principalId: 'owner', audience: 'fixture', challenge: authentication.verifier.challenge,
    method: 'GET', target: '/api/bus/sessions/mine', action: 'session.bus', transport: 'websocket', sessionEpoch: 'epoch', body: {}, ...extra });
  const app = express(); app.use(express.json({ verify(req, _res, bytes) { req.principalRawBody = Buffer.from(bytes); } }));
  app.use((req, res, next) => { const proof = authentication.authorize(req); if (!proof.ok) return res.status(proof.status).json({ success: false, code: proof.code }); next(); });
  registerApplicationEventRoute(app, { sessions }); const server = http.createServer(app);
  const deps = { authentication, sessions, server, homeDir: home, refuse: (socket, status) => socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`), forbiddenOrigin: () => false, allowedPeer: () => true };
  const readers = createApplicationEventTransport(deps); let sent = 0;
  const install = () => createStrictBusTransport({ ...deps, fetch: async (url, options) => { sent++; const response = await fetch(url, options); await response.body.cancel(); throw new TypeError('Synthetic lost publication response'); } });
  let bus = install(); server.on('upgrade', (req, socket, head) => { if (!readers.handle(req, socket, head)) bus.handle(req, socket, head); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { readers.close(); bus.close(); server.closeAllConnections(); server.close(); });
  const origin = `ws://127.0.0.1:${server.address().port}`;
  const subscriber = await open(origin + '/api/application-events/sessions/mine', sign({ target: '/api/application-events/sessions/mine', action: 'session.app_events' })); t.after(() => subscriber.ws.terminate());
  const connect = async () => { const c = await open(origin + '/api/bus/sessions/mine', sign()); t.after(() => c.ws.terminate()); await waitFor(() => c.frames.length); return c; };
  let c = await connect(); const body = { expected_epoch: 'epoch', topic: 'app/opaque', data: { secret: 'PRIVATE_APPLICATION_DATA' } }, key = 'unknown-application-key-0001';
  const frame = (c, sequence) => ({ type: 'app_publish', connection_id: c.frames[0].connection_id, sequence, idempotency_key: key, body,
    assertion: sign({ method: 'POST', target: '/api/sessions/mine/events', action: 'session.publish', transport: 'http', body }) });
  c.ws.send(JSON.stringify(frame(c, 1))); await waitFor(() => c.frames.length === 2 && subscriber.frames.length === 2);
  assert.equal(c.frames[1].state, 'outcome_unknown'); assert.equal(c.frames[1].retryable, false); assert.equal(c.frames[1].publication_id, undefined);
  bus.close(); bus = install(); c = await connect(); c.ws.send(JSON.stringify(frame(c, 1))); await waitFor(() => c.frames.length === 2);
  assert.equal(c.frames[1].state, 'outcome_unknown'); assert.equal(sent, 1); assert.equal(subscriber.frames.length, 2);
  c.ws.send(JSON.stringify({ type: 'receipt', effect: 'app_publish', connection_id: c.frames[0].connection_id, sequence: 2, idempotency_key: key })); await waitFor(() => c.frames.length === 3);
  assert.equal(c.frames[2].state, 'outcome_unknown'); assert.equal(sent, 1);
  const stored = fs.readdirSync(path.join(home, '.telepty', 'forward-receipts')).map(name => fs.readFileSync(path.join(home, '.telepty', 'forward-receipts', name), 'utf8')).join('');
  assert.equal(stored.includes('PRIVATE_APPLICATION_DATA'), false);
});
test('publication handler requires private verified request context and real secure socket', () => {
  const pair = crypto.generateKeyPairSync('ed25519'), session = { sessionEpoch: 'epoch', owningPrincipal: { id: 'owner', source: 'ed25519', audience: 'fixture' } }, sessions = { mine: session };
  const authentication = createPrincipalAuthentication({ sessions, trust: validateTrustConfiguration({ schema: 'telepty.principals/v1', audience: 'fixture', keys: [{ key_id: 'owner', principal_id: 'owner',
    public_key_spki: pair.publicKey.export({ type: 'spki', format: 'pem' }), grants: [{ action: 'session.publish', targets: ['mine'] }] }] }) });
  let handler, response;
  registerApplicationEventRoute({ post(_path, fn) { handler = fn; } }, { sessions });
  const body = { expected_epoch: 'epoch', topic: 'app/test', data: null };
  const req = { method: 'POST', originalUrl: '/api/sessions/mine/events', url: '/api/sessions/mine/events', params: { id: 'mine' }, body,
    principalRawBody: Buffer.from(JSON.stringify(body)), rawHeaders: [], socket: { remoteAddress: '127.0.0.1' }, headers: {},
    authenticationPrincipal: { id: 'owner', keyId: 'owner', audience: 'fixture', source: 'ed25519' } };
  const res = { status(value) { this.statusCode = value; return this; }, json(value) { response = value; return this; } };
  handler(req, res); assert.equal(response.code, 'APPLICATION_PUBLICATION_DENIED');
  req.headers['x-telepty-principal'] = createSignedAssertion({ privateKey: pair.privateKey, keyId: 'owner', principalId: 'owner', audience: 'fixture', challenge: authentication.verifier.challenge,
    method: 'POST', target: req.url, body, action: 'session.publish', sessionEpoch: 'epoch' });
  assert.equal(authentication.authorize(req).ok, true);
  req.socket.remoteAddress = '192.0.2.1'; req.headers['x-forwarded-for'] = '127.0.0.1'; req.headers['x-forwarded-proto'] = 'https';
  handler(req, res); assert.equal(response.code, 'APPLICATION_PUBLICATION_DENIED');
  req.socket.encrypted = true; handler(req, res); assert.equal(response.success, true); assert.equal(response.matched_socket_count, 0);
});

test('publication receipt projection refuses inconsistent delivery ACK claims and strips data', () => {
  const { projectPublicationReceipt } = require('../src/application-publication');
  const response = { ok: true, status: 200 }, remote = { success: true, session_id: 'mine', publication_id: crypto.randomUUID(), matched_socket_count: 1, delivery_ack: false, data: 'PRIVATE_RESPONSE_DATA' };
  const projected = projectPublicationReceipt(response, remote, 'mine'); assert.equal(projected.accepted, true); assert.equal(projected.safe.data, undefined);
  for (const delivery_ack of [true, undefined]) {
    const invalid = projectPublicationReceipt(response, { ...remote, delivery_ack }, 'mine'); assert.equal(invalid.accepted, false); assert.equal(invalid.uncertain, true);
    assert.equal(invalid.safe.publication_id, undefined); assert.equal(invalid.safe.delivery_ack, false);
  }
});
test('a successful-looking publication response cannot erase explicit uncertainty',()=>{
 const {projectPublicationReceipt}=require('../src/application-publication');
 const receipt=projectPublicationReceipt({ok:true,status:200},{success:true,session_id:'mine',publication_id:crypto.randomUUID(),matched_socket_count:1,delivery_ack:false,delivery_uncertain:true},'mine');
 assert.equal(receipt.accepted,false);assert.equal(receipt.uncertain,true);assert.equal(receipt.safe.success,false);assert.equal(receipt.safe.publication_id,undefined);
});
