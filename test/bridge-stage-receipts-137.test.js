'use strict';

// #137 (RB2) regression source, task 1215: daemon-side stage receipts bound to the current owner
// socket and generation. Written BEFORE the production fix; see SPEC.md §5.2.
//
// Real seams: a real daemon.js process via test-support/daemon-harness.js (loopback, PORT=0,
// private HOME), a real `ws` owner socket (?owner=1 + session bearer) playing the bridge, a real
// viewer socket, the real POST /inject, /api/meta, GET /api/sessions/:id and the diagnostics
// correlation endpoint (pattern: test/diagnostic-correlation-probes.test.js). The strict-owner
// cases use the real createStrictOwnerTransport + real principal proof (pattern:
// test/strict-owner-ws.test.js). Payload strings are synthetic.
//
// "PRECONDITION:" assertions validate setup (failure = INVALID, not RED).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const WebSocket = require('ws');
const { WebSocketServer } = require('ws');
const { startTestDaemon, waitFor, delay } = require('../test-support/daemon-harness');
const { createStrictOwnerTransport } = require('../src/transport/strict-owner');
const { validateTrustConfiguration, createSignedAssertion } = require('../src/principal/proof');
const { createPrincipalAuthentication } = require('../src/principal/http');

let harness = null;
const sockets = [];

before(async () => { harness = await startTestDaemon(); }, { timeout: 30000 });
after(async () => {
  for (const ws of sockets) { try { ws.terminate(); } catch {} }
  if (harness) await harness.stop();
}, { timeout: 30000 });

function receipt(fields) {
  return JSON.stringify({ type: 'bridge_receipt', schema: 1, daemon_msg_id: null, inject_id: null, part: 'body',
    bridge_msg_id: 'synthetic-bridge-msg', stage: 'pty_written', reason: null, certainty: 'written', bridge_seq: 1,
    at_ms: Date.now(), clock: 'bridge_wall', owner_generation: null, ...fields });
}

async function ownedSession(sid) {
  const created = await harness.registerSession(sid, { command: 'fixture' });
  assert.equal(created.status, 201, `PRECONDITION: register ${JSON.stringify(created.body)}`);
  const frames = [];
  const owner = new WebSocket(`ws://${harness.host}:${harness.port}/api/sessions/${encodeURIComponent(sid)}?owner=1`,
    { headers: { ...harness.ownerAuth(sid).headers, 'x-telepty-token': harness.authToken() } });
  sockets.push(owner);
  owner.on('message', raw => { try { frames.push(JSON.parse(raw)); } catch {} });
  await new Promise((resolve, reject) => { owner.once('open', resolve); owner.once('error', reject); });
  const token = await waitFor(() => frames.find(f => f.type === 'owner_token'), { timeoutMs: 5000, description: 'owner_token' });
  const ownerGeneration = token.interaction_binding && token.interaction_binding.owner_generation;
  assert.equal(typeof ownerGeneration, 'string', 'PRECONDITION: owner_token carries interaction_binding.owner_generation');
  owner.send(JSON.stringify({ type: 'ready' }));
  return { sid, owner, frames, ownerGeneration, epoch: created.body.session_epoch };
}

async function injectTracked(s, prompt) {
  const seen = s.frames.filter(f => f.type === 'inject').length;
  const injected = await harness.request(`/api/sessions/${encodeURIComponent(s.sid)}/inject`, { method: 'POST',
    body: { from: 'orchestrator', prompt, no_enter: true, exact_target: true } });
  assert.equal(injected.status, 200, `PRECONDITION: inject accepted ${JSON.stringify(injected.body)}`);
  const injectId = injected.body.inject_id;
  assert.equal(typeof injectId, 'string', 'PRECONDITION: inject_id returned');
  const frame = await waitFor(() => s.frames.filter(f => f.type === 'inject').slice(seen)
    .find(f => typeof f.data === 'string' && f.data.includes(prompt)), { timeoutMs: 5000, description: 'owner inject frame' });
  return { injectId, frame };
}

async function messaging(s, injectId) {
  const meta = (await harness.request('/api/meta')).body;
  const query = new URLSearchParams({ machine_id: meta.machine_id, inject_id: injectId, session_epoch: s.epoch });
  const result = await harness.request(`/api/sessions/${encodeURIComponent(s.sid)}/diagnostics?${query}`);
  assert.equal(result.status, 200, `PRECONDITION: diagnostics ${JSON.stringify(result.body)}`);
  return { body: result.body, messaging: result.body.messaging };
}

async function pollMessaging(s, injectId, predicate, ms = 3000) {
  const deadline = Date.now() + ms;
  let last = await messaging(s, injectId);
  while (!predicate(last.messaging) && Date.now() < deadline) {
    await delay(100);
    last = await messaging(s, injectId);
  }
  return last;
}

async function sessionView(sid) {
  const result = await harness.request(`/api/sessions/${encodeURIComponent(sid)}`);
  assert.equal(result.status, 200, `PRECONDITION: session GET ${JSON.stringify(result.body)}`);
  return result.body;
}

test('#137 S1: the owner inject frame carries inject_id, part, owner_generation and daemon_msg_id', { timeout: 30000 }, async () => {
  const s = await ownedSession('r137-frame-ids');
  const { injectId, frame } = await injectTracked(s, 'R137-FRAME-IDS-PAYLOAD');
  assert.deepEqual({
    inject_id: frame.inject_id,
    part: frame.part,
    owner_generation: frame.owner_generation,
    daemon_msg_id: typeof frame.daemon_msg_id,
  }, { inject_id: injectId, part: 'body', owner_generation: s.ownerGeneration, daemon_msg_id: 'string' });
});

test('#137 guard: receipts from a viewer socket, a stale owner_generation or over 512 B never mark input written', { timeout: 30000 }, async () => {
  const s = await ownedSession('r137-forged');
  const { injectId, frame } = await injectTracked(s, 'R137-FORGED-PAYLOAD');
  const viewer = await harness.connectSession(s.sid);
  sockets.push(viewer);
  const base = { inject_id: injectId, daemon_msg_id: frame.daemon_msg_id ?? null };
  viewer.send(receipt({ ...base, owner_generation: s.ownerGeneration, bridge_msg_id: 'forged-viewer' }));
  s.owner.send(receipt({ ...base, owner_generation: 'stale-owner-generation', bridge_msg_id: 'forged-generation' }));
  s.owner.send(receipt({ ...base, owner_generation: s.ownerGeneration, bridge_msg_id: 'forged-oversize', reason: 'x'.repeat(600) }));
  await delay(500);
  const after = (await messaging(s, injectId)).messaging;
  assert.equal(after.input_written.status, 'unknown');
});

test('#137 S2: a bounded pty_written receipt from the current owner/generation is recorded as input_written observed', { timeout: 30000 }, async () => {
  const s = await ownedSession('r137-observed');
  const { injectId, frame } = await injectTracked(s, 'R137-OBSERVED-PAYLOAD');
  const raw = receipt({ inject_id: injectId, daemon_msg_id: frame.daemon_msg_id ?? null, owner_generation: s.ownerGeneration });
  assert.ok(Buffer.byteLength(raw) <= 512, 'PRECONDITION: the genuine receipt is within 512 B');
  s.owner.send(raw);
  const last = await pollMessaging(s, injectId, m => m.input_written.status !== 'unknown');
  assert.deepEqual({
    inputWritten: last.messaging.input_written.status,
    payloadInDiagnostics: JSON.stringify(last.body).includes('R137-OBSERVED-PAYLOAD'),
  }, { inputWritten: 'observed', payloadInDiagnostics: false });
});

test('#137 S3: /api/meta advertises bridge-stage-receipts-v1', { timeout: 30000 }, async () => {
  const meta = await harness.request('/api/meta');
  assert.equal(meta.status, 200, 'PRECONDITION: /api/meta');
  assert.equal(Array.isArray(meta.body.capabilities), true, 'PRECONDITION: capabilities list');
  assert.equal(meta.body.capabilities.includes('bridge-stage-receipts-v1'), true);
});

test('#137 S4: a bridge that never sends receipts is reported as unsupported_by_bridge, not as delivered', { timeout: 30000 }, async () => {
  const s = await ownedSession('r137-old-bridge');
  await injectTracked(s, 'R137-OLD-BRIDGE-PAYLOAD');
  const view = await sessionView(s.sid);
  assert.equal(view.bridge_receipts, 'unsupported_by_bridge');
});

test('#137 S5: the current owner bridge_queue report is exposed; a viewer copy is ignored', { timeout: 30000 }, async () => {
  const s = await ownedSession('r137-queue');
  const report = { type: 'bridge_queue', schema: 1, pending: 1, in_flight: 0, oldest_age_ms: 15000, phase: 'stalled',
    reason: 'first_ready_unobserved', first_ready_observed: false, ready_source: null, vt: 'available',
    bridge_version: '0.10.0', bridge_code_digest: '0'.repeat(64), owner_generation: s.ownerGeneration };
  s.owner.send(JSON.stringify(report));
  const viewer = await harness.connectSession(s.sid);
  sockets.push(viewer);
  viewer.send(JSON.stringify({ ...report, pending: 99, phase: 'draining' }));
  const deadline = Date.now() + 3000;
  let view = await sessionView(s.sid);
  while (!view.bridge_queue && Date.now() < deadline) { await delay(100); view = await sessionView(s.sid); }
  const q = view.bridge_queue || {};
  assert.deepEqual({ source: q.source, pending: q.pending, phase: q.phase, reason: q.reason },
    { source: 'bridge_report', pending: 1, phase: 'stalled', reason: 'first_ready_unobserved' });
});

// --- strict-owner transport (src/transport/strict-owner.js OWNER_FRAMES) -----------------------

function strictFixture() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const session = { type: 'wrapped', sessionEpoch: 'epoch', credentialGeneration: 1, owningPrincipal: { id: 'owner', source: 'ed25519', audience: 'fixture' } };
  const trust = validateTrustConfiguration({ schema: 'telepty.principals/v1', audience: 'fixture', keys: [{ key_id: 'owner', principal_id: 'owner',
    authority: 'principal', public_key_spki: pair.publicKey.export({ type: 'spki', format: 'pem' }), grants: [{ action: 'session.owner', targets: ['mine'] }] }] });
  const auth = createPrincipalAuthentication({ trust, sessions: { mine: session } });
  const sign = () => createSignedAssertion({ privateKey: pair.privateKey, keyId: 'owner', principalId: 'owner', audience: 'fixture',
    challenge: auth.verifier.challenge, method: 'GET', target: '/api/owner/sessions/mine', body: {}, action: 'session.owner',
    sessionEpoch: 'epoch', transport: 'websocket' });
  return { auth, session, sign };
}

async function strictOwnerFrames(t, sendTypes) {
  const f = strictFixture();
  const sessions = { mine: f.session };
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const verdicts = [];
  const transport = createStrictOwnerTransport({ authentication: f.auth,
    credentials: { hasCredential: () => true, matches: (_id, bearer) => bearer === 'synthetic', verify: () => ({ sid: 'mine', epoch: 'epoch' }) },
    sessions, wss, refuse: (s, status) => s.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`),
    forbiddenOrigin: () => false, allowedPeer: () => true });
  server.on('upgrade', (r, s, h) => transport.handle(r, s, h));
  wss.on('connection', (ws, req) => {
    const context = transport.context(req);
    f.session.ownerWs = ws;
    f.session.interactionOwnerGeneration = crypto.randomUUID();
    assert.equal(context.bind(ws), true, 'PRECONDITION: strict owner bound');
    ws.on('message', b => { const msg = JSON.parse(b); verdicts.push({ type: msg.type, accepted: context.accept(msg) }); });
    ws.send(JSON.stringify({ type: 'owner_token', token: 'synthetic-owner' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { transport.close(); server.close(); });
  const frames = [];
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/owner/sessions/mine`,
    { headers: { 'x-telepty-principal': f.sign(), 'x-telepty-session-token': 'synthetic' } });
  ws.on('message', b => frames.push(JSON.parse(b)));
  ws.on('error', () => {});
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('unexpected-response', () => reject(new Error('PRECONDITION: strict owner upgrade refused'))); });
  const token = await waitFor(() => frames.find(m => m.type === 'owner_token'), { timeoutMs: 5000, description: 'strict owner_token' });
  assert.equal(typeof token.connection_id, 'string', 'PRECONDITION: strict outbound frames carry connection_id');
  sendTypes.forEach((type, i) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type, schema: 1, connection_id: token.connection_id, sequence: i + 1 }));
  });
  const deadline = Date.now() + 3000;
  while (verdicts.length < sendTypes.length && ws.readyState === 1 && Date.now() < deadline) await delay(50);
  await delay(100);
  ws.terminate();
  return verdicts;
}

test('#137 strict-owner control: a sequenced heartbeat owner frame is accepted', { timeout: 30000 }, async t => {
  assert.deepEqual(await strictOwnerFrames(t, ['heartbeat']), [{ type: 'heartbeat', accepted: true }]);
});

test('#137 S6: strict-owner transport accepts bridge_receipt and bridge_queue as sequenced owner frames', { timeout: 30000 }, async t => {
  assert.deepEqual(await strictOwnerFrames(t, ['bridge_receipt', 'bridge_queue']), [
    { type: 'bridge_receipt', accepted: true }, { type: 'bridge_queue', accepted: true },
  ]);
});
