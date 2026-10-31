'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validStateBody } = require('../src/transport/strict-bus');
test('strict bus state body has bounded explicit fields and no routing or sender claims', () => {
  assert.equal(validStateBody({ phase: 'working', seq: 1 }), true);
  for (const body of [null, [], { phase: 'working', target: 'other' }, { phase: 'working', from: 'owner' },
    { phase: 'working', seq: -1 }, { phase: 'working', current_task: 'x'.repeat(4097) }]) assert.equal(validStateBody(body), false);
});
const crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const WebSocket = require('ws');
const { createSignedAssertion, validateTrustConfiguration } = require('../src/principal/proof');
const { createPrincipalAuthentication } = require('../src/principal/http');
const { startTestDaemon, waitFor } = require('../test-support/daemon-harness');
const { linuxOnly, nonLinuxOnly, assertStrictDaemonRefused } = require('../test-support/windows-879/linux-authority');
function open(url, proof) { return new Promise(resolve => {
  const ws = new WebSocket(url, { headers: { 'x-telepty-principal': proof } }), messages = [];
  ws.on('message', bytes => messages.push(JSON.parse(bytes))); ws.on('error', () => {});
  ws.once('open', () => resolve({ ws, messages })); ws.once('unexpected-response', (_r, res) => { res.resume(); ws.terminate(); resolve({ status: res.statusCode }); });
}); }
function keys() { return Object.fromEntries(['owner','outsider','stream-only','foreign'].map(id => [id, crypto.generateKeyPairSync('ed25519')])); }
function trustDocument(pairs) {
  return { schema: 'telepty.principals/v1', audience: 'fixture', keys: Object.entries(pairs).map(([id, pair]) => ({
    key_id: id, principal_id: id, ...(id === 'owner' || id === 'outsider' ? { authority: 'operator' } : {}),
    public_key_spki: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    grants: (id === 'owner' ? ['session.register','session.bus','session.input_stream','session.state','session.inject','mailbox.read'] : id === 'outsider' ? ['session.bus','session.state','session.inject'] : id === 'stream-only' ? ['session.bus'] : ['session.state','session.inject'])
      .map(action => ({ action, targets: ['mine','protected'] })) })) };
}
function signer(pairs, challenge, epoch = 'epoch') { return (extra = {}, id = 'owner') => createSignedAssertion({ privateKey: pairs[id].privateKey, keyId: id,
  principalId: id, audience: 'fixture', challenge, method: 'GET', target: '/api/bus/sessions/mine', body: {}, action: 'session.bus', transport: 'websocket', sessionEpoch: epoch, ...extra }); }
function frame(sign, c, type, sequence, key, body, id = 'owner') {
  const target = '/api/sessions/mine/' + (type === 'state_report' ? 'state' : 'inject');
  return { type, connection_id: c.messages[0].connection_id, sequence, idempotency_key: key, body,
    assertion: sign({ method: 'POST', target, body, action: type === 'state_report' ? 'session.state' : 'session.inject', transport: 'http' }, id) };
}
// #879: the strict daemon loads TELEPTY_PRINCIPAL_TRUST_FILE through readAuthorityFile — Linux-only
// (src/principal/authority-file.js:15); the off-Linux refusal is asserted at the end of this file.
test('actual strict bus effects preserve HTTP owner, inject, approval, signer and pre-reservation authority', { timeout: 15000, skip: linuxOnly }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-bus-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const pairs = keys(), trust = path.join(home, 'trust'); fs.writeFileSync(trust, JSON.stringify(trustDocument(pairs)), { mode: 0o600 });
  const daemon = await startTestDaemon({ homeDir: home, env: { TELEPTY_PRINCIPAL_MODE: 'strict', TELEPTY_PRINCIPAL_TRUST_FILE: trust, TELEPTY_MACHINE_ID: 'fixture' } }); t.after(() => daemon.stop());
  const challenge = (await daemon.request('/api/auth/challenge', { noAuth: true })).body.challenge;
  let sign = signer(pairs, challenge);
  const register = async (sid, extra = {}) => {
    const body = { session_id: sid, delivery_type: 'mailbox', ...extra };
    return daemon.request('/api/sessions/register', { method: 'POST', body, headers: { 'x-telepty-principal': sign({ method: 'POST', target: '/api/sessions/register', body, action: 'session.register', transport: 'http', sessionEpoch: undefined }) } });
  };
  const registered = await register('mine'); assert.equal(registered.status, 201); const epoch = registered.body.session_epoch; sign = signer(pairs, challenge, epoch);
  const url = `ws://${daemon.host}:${daemon.port}/api/bus/sessions/mine`;
  const connect = async (id = 'owner') => { const c = await open(url, sign({}, id)); assert.ok(c.ws); t.after(() => c.ws.terminate()); await waitFor(() => c.messages.length); return c; };
  const owner = await connect();
  const stateBody = { phase: 'BUS_STATE_SECRET', current_task: 'BUS_STATE_SECRET', blocker: 'BUS_PRIVATE_BLOCKER', seq: 3 };
  const turnBody = { prompt: 'BUS_TURN_SECRET', expected_epoch: epoch, exact_target: true, no_enter: true };
  const key = 'bus-shared-key-00000001';
  owner.ws.send(JSON.stringify(frame(sign, owner, 'state_report', 1, key, stateBody))); await waitFor(() => owner.messages.length === 2);
  assert.equal(owner.messages[1].state, 'accepted'); assert.equal(owner.messages[1].seq, 3);
  assert.equal(JSON.stringify(owner.messages).includes('BUS_STATE_SECRET'), false); assert.equal(owner.messages[1].semantic, undefined);
  owner.ws.send(JSON.stringify(frame(sign, owner, 'routed_turn', 2, key, turnBody))); await waitFor(() => owner.messages.length === 3);
  assert.equal(owner.messages[2].state, 'accepted'); assert.notEqual(owner.messages[2].receipt_id, owner.messages[1].receipt_id);
  owner.ws.send(JSON.stringify(frame(sign, owner, 'state_report', 3, key, stateBody))); await waitFor(() => owner.messages.length === 4);
  assert.equal(owner.messages[3].receipt_id, owner.messages[1].receipt_id);
  owner.ws.send(JSON.stringify(frame(sign, owner, 'state_report', 4, key, { ...stateBody, phase: 'conflict' }))); await waitFor(() => owner.messages.length === 5);
  assert.equal(owner.messages[4].code, 'IDEMPOTENCY_CONFLICT');
  const beforeCrossOwner = fs.readdirSync(path.join(home, '.telepty', 'forward-receipts')).length;
  const outsider = await connect('outsider'); outsider.ws.send(JSON.stringify(frame(sign, outsider, 'state_report', 1, 'bus-cross-owner-000001', stateBody, 'outsider')));
  await waitFor(() => outsider.messages.length === 2); assert.equal(outsider.messages[1].state, 'refused'); assert.equal(outsider.messages[1].code, 'PRINCIPAL_SESSION_OWNER_REQUIRED');
  assert.equal(fs.readdirSync(path.join(home, '.telepty', 'forward-receipts')).length, beforeCrossOwner, 'cross-owner state consumes no durable capacity');
  const directlyDenied = await daemon.request('/api/sessions/mine/state', { method: 'POST', body: stateBody, headers: { 'x-telepty-principal': sign({ method: 'POST', target: '/api/sessions/mine/state', body: stateBody, action: 'session.state', transport: 'http' }, 'outsider') } });
  assert.equal(directlyDenied.status, 403); assert.equal(directlyDenied.body.code, 'PRINCIPAL_SESSION_OWNER_REQUIRED');
  // The same foreign operator can inject only because it has an explicit inject grant.
  outsider.ws.send(JSON.stringify(frame(sign, outsider, 'routed_turn', 2, 'bus-explicit-inject-0001', turnBody, 'outsider'))); await waitFor(() => outsider.messages.length === 3);
  assert.equal(outsider.messages[2].state, 'accepted');
  const ledgerDir = path.join(home, '.telepty', 'forward-receipts'), before = fs.readdirSync(ledgerDir).length;
  owner.ws.send(JSON.stringify(frame(sign, owner, 'routed_turn', 5, 'bus-foreign-signer-0001', turnBody, 'foreign'))); await waitFor(() => owner.messages.length === 6);
  assert.equal(owner.messages[5].code, 'BUS_SIGNER_MISMATCH');
  const streamOnly = await connect('stream-only'); streamOnly.ws.send(JSON.stringify(frame(sign, streamOnly, 'routed_turn', 1, 'bus-no-effect-grant-0001', turnBody, 'stream-only'))); await waitFor(() => streamOnly.messages.length === 2);
  assert.equal(streamOnly.messages[1].code, 'PRINCIPAL_GRANT_DENIED'); assert.equal(fs.readdirSync(ledgerDir).length, before);
  owner.ws.send(JSON.stringify({ type: 'receipt', effect: 'state_report', connection_id: owner.messages[0].connection_id, sequence: 6, idempotency_key: key })); await waitFor(() => owner.messages.length === 7);
  assert.equal(owner.messages[6].seq, 3);
  const mailbox = await daemon.request('/api/sessions/mine/mailbox', { headers: { 'x-telepty-principal': sign({ target: '/api/sessions/mine/mailbox', action: 'mailbox.read', transport: 'http', body: undefined, sessionEpoch: undefined }) } });
  assert.equal(mailbox.body.pending.length, 2);
  const protectedSession = await register('protected', { external_approval_policy: { public_key_spki: pairs.owner.publicKey.export({ type: 'spki', format: 'pem' }) } });
  const protectedEpoch = protectedSession.body.session_epoch, protectedSign = signer(pairs, challenge, protectedEpoch);
  const protectedChannel = await open(url.replace('/mine', '/protected'), protectedSign({ target: '/api/bus/sessions/protected' })); t.after(() => protectedChannel.ws.terminate()); await waitFor(() => protectedChannel.messages.length);
  const body = { ...turnBody, expected_epoch: protectedEpoch }, target = '/api/sessions/protected/inject';
  protectedChannel.ws.send(JSON.stringify({ type: 'routed_turn', connection_id: protectedChannel.messages[0].connection_id, sequence: 1, idempotency_key: 'bus-protected-turn-0001', body,
    assertion: protectedSign({ method: 'POST', target, body, action: 'session.inject', transport: 'http' }) })); await waitFor(() => protectedChannel.messages.length === 2);
  assert.equal(protectedChannel.messages[1].code, 'EXTERNAL_APPROVAL_REQUIRED');
  const stored = fs.readdirSync(ledgerDir).map(name => fs.readFileSync(path.join(ledgerDir, name), 'utf8')).join('');
  for (const secret of ['BUS_STATE_SECRET','BUS_TURN_SECRET','BUS_PRIVATE_BLOCKER']) assert.equal(stored.includes(secret), false);
});
const http = require('node:http');
const { createStrictBusTransport } = require('../src/transport/strict-bus');
async function wireFixture(t, mode = 'lost') {
  const pairs = keys(), home = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-wire-'));
  const session = { sessionEpoch: 'epoch', credentialGeneration: 1, owningPrincipal: { id: 'owner', source: 'ed25519', audience: 'fixture' } }, sessions = { mine: session };
  const authentication = createPrincipalAuthentication({ trust: validateTrustConfiguration(trustDocument(pairs)), sessions });
  const sign = signer(pairs, authentication.verifier.challenge); let effects = 0, transport;
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      req.principalRawBody = Buffer.concat(chunks); req.body = JSON.parse(req.principalRawBody);
      const proof = authentication.authorize(req);
      if (!proof.ok) { res.writeHead(proof.status); return res.end(JSON.stringify({ success: false, code: proof.code })); }
      assert.equal(req.headers['x-telepty-token'], undefined); assert.equal(proof.principal.id, 'owner'); effects++;
      if (mode === 'lost') return req.socket.destroy();
      if (mode === 'malformed') return res.end('null');
      if (mode === 'server-error') { res.writeHead(503); return res.end(JSON.stringify({ success: false, code: 'STORAGE_FAILED' })); }
      res.end(JSON.stringify({ success: true, ...(mode==='contradictory'?{delivery_uncertain:true}:{}), session_id: 'mine', exact_target: true, inject_id: crypto.randomUUID(), semantic: { seq: 1, current_task: 'MUST_NOT_LEAK' } }));
    });
  });
  const install = () => { transport = createStrictBusTransport({ authentication, sessions, server, homeDir: home,
    refuse: (socket, status) => socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`), forbiddenOrigin: () => false, allowedPeer: () => true }); };
  install(); server.on('upgrade', (req, socket, head) => transport.handle(req, socket, head)); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { transport.close(); server.closeAllConnections(); server.close(); fs.rmSync(home, { recursive: true, force: true }); });
  // Diagnostic: a refused upgrade resolves { status } only; name that status (no proof, URL or payload).
  const connect = async extra => { const c = await open(`ws://127.0.0.1:${server.address().port}/api/bus/sessions/mine`, sign(extra)); assert.ok(c.ws, `strict bus connection refused before establishment: status=${c.status === undefined ? 'none' : c.status}`); t.after(() => c.ws.terminate()); await waitFor(() => c.messages.length); return c; };
  return { home, sign, session, sessions, authentication, server, connect, effects: () => effects, restart() { transport.close(); install(); } };
}
for (const mode of ['lost','malformed','server-error','contradictory']) test(`bus ${mode} remains uncertain across adapter restart for both effects`, async t => {
  const f = await wireFixture(t, mode); let c = await f.connect();
  for (const [index, type] of ['state_report','routed_turn'].entries()) {
    const body = type === 'state_report' ? { phase: 'PRIVATE_BUS_BODY', seq: 1 } : { prompt: 'PRIVATE_BUS_BODY', expected_epoch: 'epoch', exact_target: true, no_enter: true };
    c.ws.send(JSON.stringify(frame(f.sign, c, type, index + 1, 'bus-uncertain-key-0001', body))); await waitFor(() => c.messages.length === index + 2);
    assert.equal(c.messages[index + 1].state, 'outcome_unknown'); assert.equal(c.messages[index + 1].success, false); assert.equal(c.messages[index + 1].retryable, false);
  }
  assert.equal(f.effects(), 2); f.restart(); c = await f.connect();
  for (const [index, effect] of ['state_report','routed_turn'].entries()) {
    c.ws.send(JSON.stringify({ type: 'receipt', effect, sequence: index + 1, connection_id: c.messages[0].connection_id, idempotency_key: 'bus-uncertain-key-0001' }));
    await waitFor(() => c.messages.length === index + 2); assert.equal(c.messages[index + 1].state, 'outcome_unknown');
  }
  const body = { prompt: 'PRIVATE_BUS_BODY', expected_epoch: 'epoch', exact_target: true, no_enter: true };
  c.ws.send(JSON.stringify(frame(f.sign, c, 'routed_turn', 3, 'bus-uncertain-key-0001', body))); await waitFor(() => c.messages.length === 4);
  assert.equal(c.messages[3].state, 'outcome_unknown'); assert.equal(f.effects(), 2);
  const stored = fs.readdirSync(path.join(f.home, '.telepty', 'forward-receipts')).map(name => fs.readFileSync(path.join(f.home, '.telepty', 'forward-receipts', name), 'utf8')).join('');
  assert.equal(stored.includes('PRIVATE_BUS_BODY'), false); assert.equal(stored.includes('MUST_NOT_LEAK'), false);
});
test('bus refuses bad crypto and failed durable reservation before HTTP effects', async t => {
  const f = await wireFixture(t, 'ok'), c = await f.connect(), body = { phase: 'working', seq: 1 };
  const forged = frame(f.sign, c, 'state_report', 1, 'bus-forged-proof-0001', body);
  const original = forged.assertion, parts = original.split('.'), signature = Buffer.from(parts[2], 'base64url');
  signature[0] ^= 1; parts[2] = signature.toString('base64url'); forged.assertion = parts.join('.');
  assert.notEqual(forged.assertion, original, 'the corruption must actually change the signed bytes');
  c.ws.send(JSON.stringify(forged)); await waitFor(() => c.messages.length === 2);
  assert.equal(c.messages[1].state, 'refused'); assert.equal(f.effects(), 0);
  assert.equal(fs.existsSync(path.join(f.home, '.telepty', 'forward-receipts')), false);
  fs.mkdirSync(path.join(f.home, '.telepty')); fs.writeFileSync(path.join(f.home, '.telepty', 'forward-receipts'), 'blocked');
  c.ws.send(JSON.stringify(frame(f.sign, c, 'state_report', 2, 'bus-failed-storage-0001', body))); await waitFor(() => c.messages.length === 3);
  assert.equal(c.messages[2].state, 'refused'); assert.equal(c.messages[2].code, 'BUS_STORAGE_UNAVAILABLE'); assert.equal(f.effects(), 0);
});
test('bus fences identity, exact route/action, sequence and protocol and expires with its proof', async t => {
  const f = await wireFixture(t, 'ok'); let c = await f.connect();
  f.session.credentialGeneration++; c.ws.send(JSON.stringify(frame(f.sign, c, 'state_report', 1, 'bus-changed-identity-0001', { phase: 'work' })));
  await waitFor(() => c.ws.readyState === 3); assert.equal(f.effects(), 0);
  for (const type of ['input','resize','publish','turn_request','session_state_report']) {
    c = await f.connect(); c.ws.send(JSON.stringify({ type, connection_id: c.messages[0].connection_id, sequence: 1, idempotency_key: 'bus-unsupported-kind-0001' })); await waitFor(() => c.ws.readyState === 3);
  }
  c = await f.connect(); const bad = frame(f.sign, c, 'state_report', 1, 'bus-wrong-path-000001', { phase: 'work' });
  bad.assertion = f.sign({ method: 'POST', target: '/api/sessions/protected/state', action: 'session.state', transport: 'http', body: bad.body });
  c.ws.send(JSON.stringify(bad)); await waitFor(() => c.messages.length === 2); assert.equal(c.messages[1].state, 'refused');
  c.ws.send(JSON.stringify(frame(f.sign, c, 'state_report', 1, 'bus-replayed-sequence-0001', { phase: 'work' }))); await waitFor(() => c.ws.readyState === 3);
  const short = await f.connect({ ttlSeconds: 1 }); await waitFor(() => short.ws.readyState === 3, { timeoutMs: 2000 }); assert.equal(f.effects(), 0);
});
test('common transport reuses pre-existing strict input key and body fingerprint without dispatch', async t => {
  const f = await wireFixture(t, 'ok'), { createStrictInputTransport } = require('../src/transport/strict-input');
  const input = createStrictInputTransport({ authentication: f.authentication, sessions: f.sessions, server: f.server, homeDir: f.home,
    refuse: (socket, status) => socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`), forbiddenOrigin: () => false, allowedPeer: () => true });
  t.after(() => input.close()); f.server.on('upgrade', (req, socket, head) => input.handle(req, socket, head));
  const body = { prompt: 'LEGACY_PRIVATE_BODY', expected_epoch: 'epoch', exact_target: true, no_enter: true }, key = 'input-legacy-record-0001';
  const { bodyDigest, canonicalJSON } = require('../src/principal/encoding');
  const receiptId = crypto.createHash('sha256').update(canonicalJSON(['strict-input/v1','fixture','owner','owner','mine','epoch',key])).digest('hex');
  const ledger = require('../src/peer-forwarding').createForwardLedger(f.home);
  const old = ledger.reserve(receiptId, bodyDigest(body), { direction: 'strict-input', session: 'mine', expected_epoch: 'epoch' }).record;
  ledger.write({ ...old, state: 'accepted', remote_receipt: { success: true, inject_id: 'legacy-inject-id', queued: true, retryable: false } });
  const c = await open(`ws://127.0.0.1:${f.server.address().port}/api/input/sessions/mine`, f.sign({ target: '/api/input/sessions/mine', action: 'session.input_stream' })); t.after(() => c.ws.terminate()); await waitFor(() => c.messages.length);
  c.ws.send(JSON.stringify({ type: 'inject', connection_id: c.messages[0].connection_id, sequence: 1, idempotency_key: key, body,
    assertion: f.sign({ method: 'POST', target: '/api/sessions/mine/inject', action: 'session.inject', transport: 'http', body }) })); await waitFor(() => c.messages.length === 2);
  assert.equal(c.messages[1].receipt_id, receiptId); assert.equal(c.messages[1].inject_id, 'legacy-inject-id'); assert.equal(c.messages[1].state, 'accepted');
  assert.equal(c.messages[1].schema, 'telepty.input-receipt/v1'); assert.equal(f.effects(), 0);
});

test('off Linux the strict daemon refuses to start rather than run without its trust file', { timeout: 15000, skip: nonLinuxOnly }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-bus-refusal-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const trust = path.join(home, 'trust'); fs.writeFileSync(trust, JSON.stringify(trustDocument(keys())), { mode: 0o600 });
  await assertStrictDaemonRefused(startTestDaemon, { homeDir: home, env: { TELEPTY_PRINCIPAL_MODE: 'strict', TELEPTY_PRINCIPAL_TRUST_FILE: trust, TELEPTY_MACHINE_ID: 'fixture' } });
});
