'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, generateKeyPairSync } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { registerReplyCapabilityV1Route } = require('../src/routes/reply-capability');
const rc = require('../src/reply-capability');
const { buildAuditLine } = require('../src/audit/inject-log');
const { createCredentialStore } = require('../src/session-store/session-credentials');
const { createDeliveryRuntime } = require('../src/mailbox/delivery-runtime');
const { authorizeMailboxRequest } = require('../src/mailbox/poll-session');
const { hostTokenMatches } = require('../src/protocol/clear-strand');
const { createAuthMiddleware } = require('../src/protocol/http-auth');
const { CLIENT_TOKEN_HEADER, createClientProfileGate } = require('../src/protocol/client-profiles');
const { createPrincipalAuthentication } = require('../src/principal/http');
const { validateTrustConfiguration } = require('../src/principal/proof');

const ROUTE = '/api/reply-capability-v1';
const HOST_TOKEN = 'fixture-host-token';
const T0 = 1800000000000;
const STARTED = new Date(T0).toISOString();
const MARGIN = 15000;
const TTL = 60000;
const PREFIX = 'REPLY 0123456789abcdef0123456789abcdef\n';
const R = 'responder';
const Q = 'requester';
const OK = { success: true };
const QUEUED = { success: true, queued: true, delivery_status: 'retry_pending' };
const EXPIRED_AT_WRITE = { success: false, code: 'REPLY_DEADLINE_PASSED', httpStatus: 410, bytes_written: 0 };
const RESULT_KEYS = [
  'schema', 'stage', 'outcome', 'reason', 'capability_id', 'reply_inject_id',
  'destination_session_id', 'replayed', 'retryable'
];

function harness({ deliver = () => OK, enabled = true, started = STARTED, seed = 0, orchestratorSids = [Q] } = {}) {
  const clock = { wall: T0, mono: 1000 };
  let tick;
  let intervals = 0;
  let unrefs = 0;
  let randomCounter = seed;
  const store = rc.createReplyCapabilityStore({
    now: () => clock.wall,
    monoNow: () => clock.mono,
    randomBytes(n) {
      const buffer = Buffer.alloc(n);
      buffer.writeUInt32BE(++randomCounter);
      return buffer;
    },
    limits: { acceptMarginMs: MARGIN },
    timers: {
      setInterval(fn, ms) {
        assert.equal(ms, 60000);
        intervals++;
        tick = fn;
        return { unref() { unrefs++; } };
      },
      clearInterval() {}
    },
    daemonInstanceId: 'fixture-daemon',
    daemonStartedAt: started
  });
  const credentials = createCredentialStore();
  const sessions = Object.create(null);
  function replace(sid) {
    credentials.revoke(sid);
    const credential = credentials.issue(sid);
    sessions[sid] = { sessionEpoch: credential.epoch, credentialGeneration: credential.generation };
    return credential.bearer;
  }
  const requesterBearer = replace(Q);
  const responderBearer = replace(R);
  const foreignBearer = replace('third');
  const runtime = createDeliveryRuntime({ PEER_INJECT_KINDS: new Set(['ask-request', 'ask-reply']) });
  const audits = [];
  const bus = [];
  const deliveries = [];
  const peerCalls = [];
  let ledgerCalls = 0;
  let storeReads = 0;
  const shared = {
    MACHINE_ID: 'fixture-machine',
    get replyCapabilityStore() { storeReads++; return enabled ? store : null; },
    sessions,
    sessionCredentials: credentials,
    ORCHESTRATOR_SIDS: orchestratorSids,
    auditAppend: row => audits.push(row),
    broadcastSessionEvent: (...event) => bus.push(event),
    deliveryAuditResult: runtime.deliveryAuditResult,
    classifyPeerLaneInject(input) {
      peerCalls.push(input);
      return runtime.classifyPeerLaneInject(input);
    },
    deliverInjectionToSession(...args) {
      deliveries.push(args);
      return deliver(...args);
    },
    beginTrackedInjection() { ledgerCalls++; }
  };
  let handler;
  registerReplyCapabilityV1Route({ post(route, fn) {
    assert.equal(route, ROUTE);
    assert.equal(handler, undefined);
    handler = fn;
  } }, {
    shared,
    verifyHostToken: req => hostTokenMatches(req.headers['x-telepty-token'], HOST_TOKEN)
  });
  assert.equal(typeof handler, 'function');
  storeReads = 0;

  function principal(sid) {
    return { sid, epoch: sessions[sid].sessionEpoch, generation: sessions[sid].credentialGeneration };
  }
  function mintFields(overrides = {}) {
    return {
      responder: principal(R), requester: principal(Q), inbound_inject_id: 'inbound-1',
      reply_prefix: PREFIX, not_after_ms: clock.wall + TTL, ...overrides
    };
  }
  function mint(overrides) {
    const result = store.mint(mintFields(overrides));
    assert.equal(result.ok, true);
    return result;
  }

  return {
    store, clock, credentials, sessions, replace, requesterBearer, responderBearer, foreignBearer,
    audits, bus, deliveries, peerCalls, handler, mintFields, mint,
    sweepTick: () => tick(),
    get timers() { return { intervals, unrefs }; },
    get ledgerCalls() { return ledgerCalls; },
    get storeReads() { return storeReads; }
  };
}

function request(capability, options = {}) {
  const {
    body = { v: 1, capability, body: 'reply text' },
    headers = {}, raw = Buffer.from(JSON.stringify(body)), remote = '127.0.0.1',
    query = {}, clientProfile
  } = options;
  const requestHeaders = { 'content-type': 'application/json', 'x-telepty-token': HOST_TOKEN, ...headers };
  const originalUrl = Object.keys(query).length ? ROUTE + '?' + new URLSearchParams(query) : ROUTE;
  return {
    body, headers: requestHeaders, principalRawBody: raw, socket: { remoteAddress: remote },
    rawHeaders: Object.entries(requestHeaders).filter(([, value]) => value !== undefined).flat(),
    path: ROUTE, originalUrl, ip: remote, method: 'POST', query, clientProfile
  };
}

function response() {
  const reply = {};
  return {
    reply,
    status(status) { reply.status = status; return this; },
    json(result) { reply.result = result; return reply; }
  };
}

async function fire(h, req, auth) {
  const res = response();
  if (auth) await auth(req, res, () => h.handler(req, res));
  else await h.handler(req, res);
  return res.reply;
}

function ordinaryAuth(h, options = {}) {
  return createAuthMiddleware({
    expectedToken: HOST_TOKEN,
    verifyJwt: token => token === 'fixture-jwt',
    isAllowedPeer: () => true,
    allowedOrigins: ['https://fixture.invalid'],
    authorizeSessionRequest: req => authorizeMailboxRequest(req, h.sessions, h.credentials),
    ...options
  });
}

function refused(reply, status, code, id = null, retryable = false) {
  assert.equal(reply.status, status);
  assert.equal(reply.result.schema, rc.RESULT_SCHEMA);
  assert.deepEqual(Object.keys(reply.result), code === 'REPLY_CAPABILITY_UNKNOWN'
    ? [...RESULT_KEYS, 'daemon_started_at'] : RESULT_KEYS);
  assert.equal(reply.result.reason, code);
  assert.equal(reply.result.stage, 'refused');
  assert.equal(reply.result.capability_id, id);
  assert.equal(reply.result.retryable, retryable);
  assert.equal(reply.result.replayed, false);
  assert.equal(reply.result.destination_session_id, null);
  assert.equal(reply.result.outcome, null);
}

function wrongSecret(token, replacement = 'A') {
  return token.slice(0, 27) + replacement + token.slice(28);
}

function digest(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

test('U4 C1–C10 precedence, schema bounds and unknown-secret refusals before effect', async () => {
  const h = harness({ orchestratorSids: ['unrelated'] });
  const cap = h.mint();
  const body = text => ({ v: 1, capability: cap.token, body: text });
  for (const options of [
    { body: { ...body('ok'), to: Q } }, { body: { ...body('ok'), v: '1' } },
    { body: [body('ok')] }, { body: body('') }, { body: body('x\0y') },
    { body: body('\uD800') }, { body: body('é'.repeat(32769)) },
    { body: body('ok'), raw: Buffer.alloc(rc.REQUEST_MAX_BYTES + 1) },
    { body: body('ok'), raw: null }, { body: { ...body('ok'), capability: 'short' } }
  ]) {
    refused(await fire(h, request(cap.token, options)), 400, 'REPLY_REQUEST_INVALID');
    assert.equal(h.store.get(cap.id).state, 'issued');
  }
  for (const first of ['B', 'C', 'D']) {
    const wrong = await fire(h, request(wrongSecret(cap.token, first)));
    refused(wrong, 404, 'REPLY_CAPABILITY_UNKNOWN');
    assert.equal(wrong.result.daemon_started_at, STARTED);
    assert.equal(h.store.get(cap.id).attempts, 0);
    assert.equal(h.store.get(cap.id).state, 'issued');
  }
  const unknown = await fire(h, request('rc1.' + 'Z'.repeat(22) + '.' + cap.token.split('.')[2]));
  assert.deepEqual(unknown, await fire(h, request(wrongSecret(cap.token, 'E'))));
  h.sessions[Q].isClosing = true;
  const mismatch = { 'x-telepty-session-token': h.foreignBearer };
  refused(await fire(h, request(cap.token, { headers: mismatch })), 403, 'REPLY_SENDER_MISMATCH', cap.id);
  assert.equal(h.store.get(cap.id).state, 'issued');
  h.sessions[R].isClosing = true;
  refused(await fire(h, request(cap.token, { headers: mismatch })), 410, 'REPLY_CAPABILITY_SUPERSEDED', cap.id);
  assert.equal(h.store.get(cap.id).state, 'superseded');
  assert.equal(h.deliveries.length, 0);
  assert.equal(h.peerCalls.length, 0);
  assert.equal(h.ledgerCalls, 0);

  const allowed = harness();
  const fresh = allowed.mint();
  for (const first of ['B', 'C', 'D']) {
    refused(await fire(allowed, request(wrongSecret(fresh.token, first))), 404, 'REPLY_CAPABILITY_UNKNOWN');
    assert.equal(allowed.store.get(fresh.id).state, 'issued');
  }
  const max = 'é'.repeat(32768);
  const maxBody = { v: 1, capability: fresh.token, body: max };
  const encoded = Buffer.from(JSON.stringify(maxBody));
  const raw = Buffer.concat([encoded, Buffer.alloc(rc.REQUEST_MAX_BYTES - encoded.length, 0x20)]);
  const result = await fire(allowed, request(fresh.token, { body: maxBody, raw }));
  assert.equal(result.status, 200);
  assert.equal(allowed.deliveries[0][2], PREFIX + max);
});

test('U5 fifty concurrent consumes allow one delivery and terminal replay adds no effects', async () => {
  let release;
  const h = harness({ deliver: () => new Promise(resolve => { release = resolve; }) });
  const cap = h.mint();
  const requests = Array.from({ length: 50 }, (_, i) => request(cap.token, {
    body: { v: 1, capability: cap.token, body: i % 2 ? 'different' : 'same' }
  }));
  const [first, ...contenders] = requests.map(req => fire(h, req));
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.store.get(cap.id).state, 'in_flight');
  for (const reply of await Promise.all(contenders)) refused(reply, 409, 'REPLY_CAPABILITY_IN_FLIGHT', cap.id, true);
  refused(await fire(h, request(wrongSecret(cap.token, 'B'))), 404, 'REPLY_CAPABILITY_UNKNOWN');
  assert.equal(h.store.get(cap.id).attempts, 1);
  release(OK);
  const accepted = await first;
  assert.equal(accepted.status, 200);
  assert.deepEqual(await fire(h, requests[0]), { status: 200, result: { ...accepted.result, replayed: true } });
  refused(await fire(h, requests[1]), 409, 'REPLY_CAPABILITY_CONSUMED', cap.id);
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.bus.length, 1);
  assert.equal(h.audits.filter(row => row.kind === 'inject').length, 1);
  assert.equal(h.ledgerCalls, 0);
});

test('U6 settlement maps delivery, queue, uncertainty, closing, deadline and zero-byte refusals', async () => {
  const cases = [
    [OK, 200, 'consumed', 'delivered', null, false],
    [QUEUED, 200, 'consumed', 'queued', null, false],
    [{ success: true, queued: true, strategy: 'bootstrap_queue' }, 200, 'consumed', 'queued', null, false],
    [{ success: true, queued: true, poll_only: true }, 200, 'consumed', 'queued', null, false],
    [{ success: false, delivery_uncertain: true }, 500, 'unknown', null, null, false],
    [{ success: false, bytes_written: null }, 500, 'unknown', null, null, false],
    [{ success: false, bytes_written: 1 }, 500, 'unknown', null, null, false],
    [new Error('fixture delivery threw'), 500, 'unknown', null, null, false],
    [{ success: false, code: 'SESSION_GONE', bytes_written: 0 }, 410, 'revoked', null, 'REPLY_DESTINATION_GONE', false],
    [{ success: false, code: 'SESSION_CLOSING', bytes_written: 0 }, 410, 'revoked', null, 'REPLY_DESTINATION_GONE', false],
    [EXPIRED_AT_WRITE, 410, 'expired', null, 'REPLY_CAPABILITY_EXPIRED', false],
    [{ success: false, code: 'QUEUE_TIMEOUT', httpStatus: 503 }, 503, 'issued', null, 'QUEUE_TIMEOUT', true],
    [{ success: false, code: 'REPLY_CAPABILITY_DELIVERY_UNSUPPORTED', httpStatus: 409, bytes_written: 0 },
      409, 'issued', null, 'REPLY_CAPABILITY_DELIVERY_UNSUPPORTED', true]
  ];
  for (const [delivery, status, state, outcome, reason, retryable] of cases) {
    const h = harness({ deliver() { if (delivery instanceof Error) throw delivery; return delivery; } });
    const cap = h.mint();
    const req = request(cap.token);
    const answer = await fire(h, req);
    assert.deepEqual(Object.keys(answer.result), RESULT_KEYS);
    assert.equal(answer.status, status);
    assert.equal(answer.result.stage, status === 200 ? 'accepted' : status === 500 ? 'outcome_unknown' : 'refused');
    assert.equal(answer.result.reason, reason);
    assert.equal(answer.result.outcome, outcome);
    assert.equal(answer.result.retryable, retryable);
    assert.equal(answer.result.destination_session_id, status === 200 ? Q : null);
    assert.equal(h.store.get(cap.id).state, state);
    assert.equal(h.deliveries.length, 1);
    assert.equal(h.bus.length, status === 200 ? 1 : 0);
    if (state === 'unknown') {
      assert.deepEqual(await fire(h, req), { status, result: { ...answer.result, replayed: true } });
      refused(await fire(h, request(cap.token, {
        body: { v: 1, capability: cap.token, body: 'different' }
      })), 409, 'REPLY_CAPABILITY_CONSUMED', cap.id);
      assert.equal(h.deliveries.length, 1);
      assert.equal(h.audits.filter(row => row.kind === 'inject').length, 1);
    }
  }
  const h = harness({ deliver: () => ({ success: false, code: 'BODY_CUSTODY_FULL', httpStatus: 409, bytes_written: 0 }) });
  const cap = h.mint();
  const injectIds = new Set();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const reply = await fire(h, request(cap.token, { body: { v: 1, capability: cap.token, body: 'try ' + attempt } }));
    refused(reply, 409, 'BODY_CUSTODY_FULL', cap.id, attempt < 3);
    injectIds.add(reply.result.reply_inject_id);
    assert.equal(h.store.get(cap.id).state, attempt < 3 ? 'issued' : 'void');
  }
  refused(await fire(h, request(cap.token)), 410, 'REPLY_CAPABILITY_VOID', cap.id);
  assert.equal(injectIds.size, 3);
  assert.equal(h.deliveries.length, 3);
});

test('U7 accept margin enforces each clock independently and is inclusive at the boundary', async () => {
  for (const [wallChange, monoChange] of [
    [TTL - MARGIN + 1, 0], [-3600000, TTL - MARGIN + 1], [TTL + 1, 0]
  ]) {
    const h = harness();
    const cap = h.mint();
    h.clock.wall += wallChange;
    h.clock.mono += monoChange;
    h.sessions[R].isClosing = true;
    refused(await fire(h, request(cap.token)), 410, 'REPLY_CAPABILITY_EXPIRED', cap.id);
    assert.equal(h.store.get(cap.id).state, 'expired');
    assert.equal(h.deliveries.length, 0);
  }
  const h = harness();
  const cap = h.mint();
  h.clock.wall += TTL - MARGIN;
  h.clock.mono += TTL - MARGIN;
  assert.equal((await fire(h, request(cap.token))).status, 200);
});

test('U7 passes the absolute write deadline and settles its zero-byte refusal', async () => {
  const h = harness({ async deliver(_sid, _target, _text, options) {
    await Promise.resolve();
    h.clock.wall += TTL + 1;
    h.clock.mono += TTL + 1;
    return h.clock.wall > options.notAfterMs ? EXPIRED_AT_WRITE : OK;
  } });
  const cap = h.mint();
  refused(await fire(h, request(cap.token)), 410, 'REPLY_CAPABILITY_EXPIRED', cap.id);
  assert.equal(h.deliveries[0][3].notAfterMs, cap.not_after_ms);
  assert.equal(h.store.get(cap.id).state, 'expired');
  assert.equal(h.bus.length, 0);
});

test('U8 requester instance is exact at accept and captured through delivery', async () => {
  for (const invalidate of [
    h => h.replace(Q),
    h => { h.sessions[Q].sessionEpoch = 'new-epoch'; h.sessions[Q].credentialGeneration++; },
    h => { h.sessions[Q].credentialGeneration++; },
    h => { h.sessions[Q].isClosing = true; },
    h => { Object.setPrototypeOf(h.sessions, { [Q]: h.sessions[Q] }); delete h.sessions[Q]; }
  ]) {
    const h = harness({ orchestratorSids: ['unrelated'] });
    const cap = h.mint();
    invalidate(h);
    refused(await fire(h, request(cap.token)), 410, 'REPLY_DESTINATION_GONE', cap.id);
    assert.equal(h.store.get(cap.id).state, 'revoked');
    assert.equal(h.deliveries.length, 0);
    assert.equal(h.peerCalls.length, 0);
  }
  const h = harness({ async deliver(sid, target) {
    assert.equal(target, original);
    h.replace(sid);
    await Promise.resolve();
    assert.notEqual(h.sessions[sid], target);
    return { success: false, code: 'SESSION_GONE', bytes_written: 0 };
  } });
  const original = h.sessions[Q];
  const cap = h.mint();
  refused(await fire(h, request(cap.token)), 410, 'REPLY_DESTINATION_GONE', cap.id);
  assert.equal(h.store.get(cap.id).state, 'revoked');
  assert.equal(h.bus.length, 0);
});

test('U9 responder rotation, generation-only changes and recreation supersede old capabilities', async () => {
  for (const invalidate of [
    h => { h.sessions[R].sessionEpoch = 'rotated'; h.sessions[R].credentialGeneration++; },
    h => { h.sessions[R].credentialGeneration++; },
    h => { delete h.sessions[R]; h.replace(R); }
  ]) {
    const h = harness();
    const old = h.mint();
    invalidate(h);
    refused(await fire(h, request(old.token)), 410, 'REPLY_CAPABILITY_SUPERSEDED', old.id);
    assert.equal(h.store.get(old.id).state, 'superseded');
    assert.equal(h.deliveries.length, 0);
    const fresh = h.mint();
    assert.equal((await fire(h, request(fresh.token))).status, 200);
  }
});

test('U10 an optional bearer must verify to the full bound responder principal', async () => {
  const h = harness();
  const cap = h.mint();
  const otherEpoch = h.credentials.issue(R);
  for (const bearer of [h.foreignBearer, h.requesterBearer, otherEpoch.bearer, 'invalid', '']) {
    refused(await fire(h, request(cap.token, { headers: { 'x-telepty-session-token': bearer } })),
      403, 'REPLY_SENDER_MISMATCH', cap.id);
    assert.equal(h.store.get(cap.id).state, 'issued');
  }
  const headers = { 'x-telepty-session-token': h.responderBearer };
  const credential = { ...h.sessions[R], credentialVerifier: digest(h.responderBearer) };
  h.credentials.adopt(R, { ...credential, credentialGeneration: credential.credentialGeneration + 1 });
  refused(await fire(h, request(cap.token, { headers })), 403, 'REPLY_SENDER_MISMATCH', cap.id);
  h.credentials.adopt(R, credential);
  assert.equal((await fire(h, request(cap.token, { headers }))).status, 200);
  assert.equal((await fire(h, request(h.mint().token))).status, 200);
});

test('U11 delivery audit and bus correlate the bound sender and never expose the presented token', async t => {
  const consoleOutput = [];
  for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, (...args) => consoleOutput.push(args));
  for (const [delivery, deliveryResult, event] of [
    [OK, 'success', 'inject_written'], [QUEUED, 'queued', 'inject_queued'],
    [{ success: false, httpStatus: 409, code: 'QUEUE_TIMEOUT', bytes_written: 0 }, 'failed:QUEUE_TIMEOUT', null],
    [{ success: false, delivery_uncertain: true }, 'failed:OUTCOME_UNKNOWN', null],
    [null, 'failed:OUTCOME_UNKNOWN', null]
  ]) {
    const h = harness({ deliver(_sid, _session, text) {
      if (delivery === null) throw new Error(text);
      return delivery;
    } });
    const cap = h.mint();
    const body = cap.token + '\nreply text';
    const req = request(cap.token, { body: { v: 1, capability: cap.token, body } });
    const answer = await fire(h, req);
    const [sid, dest, prompt, options] = h.deliveries[0];
    assert.equal(sid, Q);
    assert.equal(dest, h.sessions[Q]);
    assert.equal(prompt === PREFIX + body, true);
    assert.deepEqual(options, {
      from: R, source: rc.CAPABILITY, injectId: null, pairInjectId: answer.result.reply_inject_id,
      verifiedSenderSid: R, notAfterMs: cap.not_after_ms
    });
    assert.equal(h.audits.length, 1);
    const row = h.audits[0];
    const line = buildAuditLine({ ...row, preview: row.preview ?? true });
    assert.equal(line.kind, 'inject');
    assert.equal(line.source, rc.CAPABILITY);
    assert.equal(line.inject_id, answer.result.reply_inject_id);
    assert.equal(line.to, Q);
    assert.equal(line.claimed_from, R);
    assert.equal(line.verified_sender_sid, R);
    assert.equal(line.verified_sender_epoch, h.sessions[R].sessionEpoch);
    assert.equal(line.verified_sender_generation, h.sessions[R].credentialGeneration);
    assert.equal(line.spoof_suspected, false);
    assert.equal(line.delivery_result, deliveryResult);
    assert.equal(line.payload_sha256, digest(PREFIX + body));
    assert.equal(line.payload_preview, null);
    assert.equal(line.sender_proof, rc.SENDER_PROOF);
    assert.equal(line.reply_capability_id, cap.id);
    assert.equal(line.reply_to_inject_id, 'inbound-1');
    assert.equal(line.reply_attempt, 1);
    assert.equal(h.bus.length, event ? 1 : 0);
    if (event) {
      const [eventType, target, session, { extra }] = h.bus[0];
      assert.equal(eventType, event);
      assert.equal(target, Q);
      assert.equal(session, dest);
      assert.equal(extra.inject_id, line.inject_id);
      assert.equal(extra.content_sha256, line.payload_sha256);
      assert.equal(extra.content_length, Buffer.byteLength(prompt));
      assert.equal(extra.transport, rc.CAPABILITY);
      assert.equal(extra.reply_capability_id, cap.id);
    }
    const secret = cap.token.split('.')[2];
    assert.equal(JSON.stringify([line, h.bus, consoleOutput, answer]).includes(secret), false);
    assert.equal(h.ledgerCalls, 0);
  }
});

test('U11 budgets refusals by held id or monotonic bucket and reports suppression once', async () => {
  const h = harness();
  const cap = h.mint({ not_after_ms: T0 + 3 * TTL });
  const req = request(wrongSecret(cap.token, 'B'));
  for (let i = 0; i < 10; i++) await fire(h, req);
  assert.equal(h.audits.length, 8);
  for (const row of h.audits) {
    const line = buildAuditLine(row);
    assert.equal(line.kind, 'reply-capability');
    assert.equal(line.source, rc.CAPABILITY);
    assert.equal(line.to, null);
    assert.equal(line.verified_sender_sid, null);
    assert.equal(line.verified_sender_epoch, null);
    assert.equal(line.verified_sender_generation, null);
    assert.equal(line.payload_sha256, digest(''));
    assert.equal(line.delivery_result, 'refused:REPLY_CAPABILITY_UNKNOWN');
    assert.equal(line.reply_capability_id, cap.id);
    assert.equal(line.suppressed_count, 0);
    assert.equal(JSON.stringify(line).includes(req.body.capability), false);
  }
  for (let i = 0; i < 11; i++) await fire(h, request('malformed'));
  assert.equal(h.audits.length, 18);
  assert.equal(buildAuditLine(h.audits[8]).suppressed_count, 2);
  assert.equal(buildAuditLine(h.audits[9]).suppressed_count, 0);
  assert.equal(buildAuditLine(h.audits[8]).reply_capability_id, null);
  h.clock.wall += 60000;
  await fire(h, request('malformed'));
  assert.equal(h.audits.length, 18);
  h.clock.mono += 60000;
  await fire(h, request('malformed'));
  assert.equal(h.audits.length, 19);
  assert.equal(buildAuditLine(h.audits[18]).suppressed_count, 2);
  await fire(h, request('malformed'));
  assert.equal(buildAuditLine(h.audits[19]).suppressed_count, 0);

  assert.equal((await fire(h, request(cap.token))).status, 200);
  assert.equal(buildAuditLine(h.audits.at(-1)).delivery_result, 'success');
});

test('U12 held records are capped and retention forgets terminal results exactly at its boundary', async () => {
  const h = harness();
  const first = h.mint({ reply_prefix: 'x'.repeat(256) });
  assert.equal((await fire(h, request(first.token))).status, 200);
  let recordBytes = Buffer.byteLength(JSON.stringify(h.store.get(first.id)));
  const fields = { reply_prefix: 'x'.repeat(256), not_after_ms: T0 + 3 * TTL };
  for (let i = 0; i < 63; i++) {
    const cap = h.mint(fields);
    recordBytes += Buffer.byteLength(JSON.stringify(h.store.get(cap.id)));
  }
  const r = { sid: 'another-r', epoch: 'another-r-epoch', generation: 1 };
  const q = { sid: 'another-q', epoch: 'another-q-epoch', generation: 1 };
  for (const overrides of [{ requester: q }, { responder: r }]) {
    assert.deepEqual(h.store.mint(h.mintFields(overrides)), { ok: false, code: 'REPLY_CAPABILITY_CAPACITY' });
  }
  for (let i = 1; i < 64; i++) {
    const responder = { ...r, sid: r.sid + i };
    const requester = { ...q, sid: q.sid + i };
    for (let j = 0; j < 64; j++) {
      const cap = h.mint({ ...fields, responder, requester });
      recordBytes += Buffer.byteLength(JSON.stringify(h.store.get(cap.id)));
    }
  }
  assert.equal(h.store.size(), 4096);
  assert.ok(recordBytes <= 4096 * 1024);
  assert.deepEqual(h.store.mint(h.mintFields({ responder: r, requester: q })),
    { ok: false, code: 'REPLY_CAPABILITY_CAPACITY' });

  h.clock.wall += TTL + 60000 - 1;
  assert.equal(h.store.sweep().visited, 1);
  assert.equal((await fire(h, request(first.token))).result.replayed, true);
  h.clock.wall++;
  const gone = await fire(h, request(first.token));
  refused(gone, 404, 'REPLY_CAPABILITY_UNKNOWN');
  assert.equal(h.store.size(), 4095);
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.store.sweep().visited, 0);
  assert.equal(h.mint({ responder: r, requester: q }).ok, true);
});

test('U12 one unrefed sweep detects requester and responder replacement while issued', () => {
  const r = harness();
  const q = harness();
  const one = r.mint();
  const two = q.mint();
  assert.deepEqual(r.timers, { intervals: 1, unrefs: 1 });
  r.replace(R);
  q.replace(Q);
  r.sweepTick();
  q.sweepTick();
  assert.equal(r.store.get(one.id).state, 'superseded');
  assert.equal(q.store.get(two.id).state, 'revoked');
});

test('U16 strict meta and mode refusals preserve shared principal and profile gate decisions', async () => {
  const daemon = fs.readFileSync(path.join(__dirname, '../daemon.js'), 'utf8');
  const meta = daemon.slice(daemon.indexOf("app.get('/api/meta'"), daemon.indexOf('// Task 1215 W3B: authenticated LOCAL'));
  assert.match(meta, /\.\.\.\(principalAuthentication \? \[\] : \[replyCapability\.CAPABILITY\]\)/);
  const actions = daemon.slice(daemon.indexOf('const sessionActions = createSessionActions('),
    daemon.indexOf('const deliveryRuntime = createDeliveryRuntime('));
  assert.match(actions, /get replyCapabilityStore\(\) \{ return principalAuthentication \? null : replyCapabilityStore; \}/);

  const h = harness({ enabled: false });
  const req = request('malformed');
  refused(await fire(h, req), 503, 'REPLY_CAPABILITY_UNAVAILABLE');
  refused(await fire(h, request('malformed', { headers: { 'x-telepty-token': undefined } })),
    403, 'REPLY_TRANSPORT_REFUSED');
  assert.deepEqual(h.timers, { intervals: 0, unrefs: 0 });
  const { publicKey } = generateKeyPairSync('ed25519');
  const trust = validateTrustConfiguration({
    schema: 'telepty.principals/v1', audience: 'fixture-node',
    keys: [{
      key_id: 'fixture', principal_id: 'fixture', authority: 'principal',
      public_key_spki: publicKey.export({ type: 'spki', format: 'pem' }),
      grants: [{ action: 'daemon.inspect', targets: ['daemon'] }]
    }]
  });
  const strict = ordinaryAuth(h, {
    principalAuthentication: createPrincipalAuthentication({ trust, sessions: h.sessions })
  });
  const reads = h.storeReads;
  const strictRefusal = await fire(h, req, strict);
  assert.equal(strictRefusal.status, 403);
  assert.equal(strictRefusal.result.code, 'PRINCIPAL_ACTION_DENIED');
  assert.equal(h.storeReads, reads);

  const ordinary = harness();
  refused(await fire(ordinary, request('malformed', { clientProfile: {} })), 503, 'REPLY_CAPABILITY_UNAVAILABLE');
  const profileToken = 'tpc1.1.' + 'A'.repeat(43);
  const sha256 = digest(profileToken);
  const gate = createClientProfileGate({
    registry: { load: () => ({ byVerifier: new Map([['sha256:' + sha256, { verifier: Buffer.from(sha256, 'hex') }]]) }) },
    sessions: () => ordinary.sessions,
    credentials: ordinary.credentials
  });
  const denied = await fire(ordinary, request('malformed', {
    headers: { 'x-telepty-token': undefined, [CLIENT_TOKEN_HEADER]: profileToken }
  }), ordinaryAuth(ordinary, { clientProfileGate: gate }));
  assert.equal(denied.status, 403);
  assert.equal(denied.result.code, 'PROFILE_ACTION_DENIED');
  assert.equal(ordinary.storeReads, 1);
  assert.equal(h.audits.length + ordinary.audits.length, 0);
  assert.equal(h.deliveries.length + ordinary.deliveries.length, 0);
});

test('U18 transport refusals do not access the store even when upstream auth admits a different carrier', async () => {
  const h = harness();
  const cap = h.mint();
  const auth = ordinaryAuth(h);
  for (const options of [
    { remote: '192.0.2.10' }, { headers: { origin: '' } },
    { headers: { origin: 'https://fixture.invalid' } },
    { headers: { 'x-telepty-token': undefined }, query: { token: HOST_TOKEN } },
    { headers: { 'x-telepty-token': undefined, authorization: 'Bearer fixture-jwt' } },
    { headers: { 'content-type': 'application/jsonx' } },
    { headers: { 'content-type': 'text/plain' } },
    { headers: { 'content-type': 'application/json bogus' } }
  ]) {
    refused(await fire(h, request(cap.token, options), auth), 403, 'REPLY_TRANSPORT_REFUSED');
  }
  const bearerOnly = request(cap.token, {
    headers: { 'x-telepty-token': undefined, 'x-telepty-session-token': h.responderBearer }
  });
  refused(await fire(h, bearerOnly), 403, 'REPLY_TRANSPORT_REFUSED');
  const upstreamDenial = await fire(h, bearerOnly, auth);
  assert.equal(upstreamDenial.status, 401);
  assert.equal(upstreamDenial.result.code, 'PERMISSION_DENIED');
  assert.equal(h.storeReads, 0);
  assert.equal(h.audits.length, 0);
  assert.equal(h.deliveries.length, 0);
  assert.equal(h.store.get(cap.id).state, 'issued');
  assert.equal((await fire(h, request(cap.token, {
    remote: '::ffff:127.0.0.1', headers: { 'content-type': 'Application/JSON; charset=utf-8' }
  }), auth)).status, 200);
});

test('U19 a restarted store reports its own start time and accepts a fresh capability', async () => {
  const original = harness();
  const old = original.mint();
  const started = new Date(T0 + 1000).toISOString();
  const restarted = harness({ started, seed: 100 });
  const unknown = await fire(restarted, request(old.token));
  refused(unknown, 404, 'REPLY_CAPABILITY_UNKNOWN');
  assert.equal(unknown.result.daemon_started_at, started);
  assert.equal(restarted.deliveries.length, 0);
  const newCap = restarted.mint();
  assert.notEqual(newCap.id, old.id);
  const delivered = await fire(restarted, request(newCap.token));
  assert.equal(delivered.status, 200);
  assert.equal(Object.hasOwn(delivered.result, 'daemon_started_at'), false);
});

test('U20 peer-lane blocks the prefixed prompt once per refusal within the per-id budget', async () => {
  const h = harness({ orchestratorSids: ['orchestrator'] });
  const cap = h.mint();
  for (let i = 0; i < 11; i++) await fire(h, request('malformed'));
  const previousAudits = h.audits.length;
  for (let i = 0; i < 9; i++) {
    refused(await fire(h, request(cap.token)), 403, 'PEER_INJECT_BLOCKED', cap.id);
  }
  assert.deepEqual(h.peerCalls[0], { from: R, to: Q, prompt: PREFIX + 'reply text', orchestratorSids: ['orchestrator'] });
  assert.equal(h.store.get(cap.id).state, 'issued');
  assert.equal(h.store.get(cap.id).attempts, 0);
  assert.equal(h.deliveries.length, 0);
  assert.equal(h.bus.length, 0);
  assert.equal(h.ledgerCalls, 0);
  const blocked = h.audits.slice(previousAudits).map(buildAuditLine);
  assert.equal(blocked.length, 8);
  assert.equal(blocked[0].suppressed_count, 1);
  assert.equal(blocked[1].suppressed_count, 0);
  for (const line of blocked) {
    assert.equal(line.kind, 'inject');
    assert.equal(line.source, rc.CAPABILITY);
    assert.equal(line.delivery_result, 'blocked:malformed-envelope');
    assert.equal(line.to, Q);
    assert.equal(line.verified_sender_sid, R);
    assert.equal(line.payload_sha256, digest(''));
    assert.equal(line.reply_capability_id, cap.id);
  }
});
