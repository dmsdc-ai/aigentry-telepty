'use strict';

// Task 1292 W2 — mint and delivery of reply-capability-v1 (SPEC §2, §6.4, §8 mint rows; SPEC-DEVIATIONS W2-D1).
// TEST-PLAN ids owned by W2: U2, U3 (golden: field absent ⇒ route and delivery unchanged), U7(d,e), U13, U14,
// plus Root's S3 (no token in the inbound audit line, preview on) and the W2-D1 branch refusals.
// The REAL route (createSessionActions(shared).registerInjectRoute) and the REAL delivery
// (createSessionDeliveryContext) are driven. Only `shared` / the delivery dependencies are stand-ins. The store is the
// real W1 store with the clocks injected. Date is mocked (node:test mock.timers) where the plan needs a clock.
// No network, no daemon, no file.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const rc = require('../src/reply-capability');
const { createSessionActions } = require('../src/routes/session-actions');
const { createSessionDeliveryContext } = require('../src/mailbox/session-delivery');
const { buildAuditLine } = require('../src/audit/inject-log');
const { applyProvenance } = require('../src/audit/provenance');

const T0 = 1800000000000;
const NOT_AFTER = T0 + 600000;
const PREFIX = 'REPLY 0123456789abcdef0123456789abcdef\n';
const PROMPT = 'synthetic task text';
const Q_BEARER = 'bearer-requester-q';
const TOKEN_ANYWHERE = /rc1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/;
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
const clocked = new WeakSet();
function mockClock(t) {
  if (clocked.has(t)) return;
  clocked.add(t);
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
}

// ───────────────────────────── route harness ─────────────────────────────

function routeFixture(t, { store = 'real', limits, deliver, begin, peer } = {}) {
  mockClock(t);
  const calls = { begin: [], deliver: [], abort: [], audit: [], events: [], failures: [], bus: [], store: [], peer: [], mintedIds: [], errorReplies: [] };
  // GB-03: the requester is in the support matrix (an aterm session reached over its unix socket).
  const requester = { id: 'requester-q', type: 'aterm', delivery: { transport: 'unix_socket', address: '/synthetic/requester-q.sock' },
    sessionEpoch: 'epoch-q', credentialGeneration: 1, isClosing: false, clients: new Set() };
  const responder = { id: 'responder-a', type: 'wrapped', sessionEpoch: 'epoch-r', sessionEpochProved: 'epoch-r',
    credentialGeneration: 1, isClosing: false, clients: new Set() };
  const sessions = { 'requester-q': requester, 'responder-a': responder };
  const principals = { [Q_BEARER]: { sid: 'requester-q', epoch: 'epoch-q', generation: 1 } };
  const realStore = rc.createReplyCapabilityStore({ now: () => Date.now(), monoNow: () => Date.now(), ...(limits ? { limits } : {}) });
  const spyStore = {};
  for (const [name, value] of Object.entries(realStore)) {
    spyStore[name] = typeof value !== 'function' ? value : (...args) => {
      calls.store.push(name);
      const result = value(...args);
      if (name === 'mint' && result.ok) calls.mintedIds.push(result.id);   // the id only, never the token
      return result;
    };
  }
  let uuids = 0;
  const shared = {
    sessions, pendingReports: Object.create(null), MACHINE_ID: 'synthetic-host', ORCHESTRATOR_SIDS: [],
    crypto: { randomUUID: () => uuid(++uuids), createHash: (...args) => crypto.createHash(...args) },
    busClients: [{ readyState: 1, send: frame => calls.bus.push(JSON.parse(String(frame))) }],
    resolveSessionAlias: id => (Object.hasOwn(sessions, id) ? id : null),
    // The fake response carries the status and code only: the error text is recorded in the call log, never sent back.
    respondWithError: (res, status, code, error, extra = {}) => {
      calls.errorReplies.push({ status, code, error });
      return res.status(status).json({ success: false, code, ...extra });
    },
    buildErrorBody: (code, error, extra = {}) => {
      calls.errorReplies.push({ code, error });
      return { success: false, code, ...extra };
    },
    verifiedPrincipalFromReq: req => principals[req.headers && req.headers['x-telepty-session-token']] || null,
    verifiedSenderFields: p => ({ verified_sender_sid: p ? p.sid : null, verified_sender_epoch: p ? p.epoch : null,
      verified_sender_generation: p ? p.generation : null }),
    classifyPeerLaneInject: args => { calls.peer.push({ storeSize: realStore.size() }); return peer ? peer(args) : { decision: 'allow', lane: 'none' }; },
    emitInjectFailureEvent: (...args) => calls.failures.push(args),
    broadcastSessionEvent: (type, id, _session, data) => calls.events.push({ type, id, data }),
    auditAppend: record => calls.audit.push(record),
    deliveryAuditResult: d => (d && d.queued === true && (d.strategy === 'bootstrap_queue' || d.poll_only === true
      || d.delivery_status === 'retry_pending') ? 'queued' : 'success'),
    abortTrackedInjection: async (...args) => { calls.abort.push(args); return 'tracking_aborted'; },
    beginTrackedInjection: async args => {
      calls.begin.push({ args, storeSize: realStore.size() });
      return begin ? begin(args) : { ok: true, record: { inject_id: args.injectId } };
    },
    deliverInjectionToSession: async (id, session, prompt, options) => {
      calls.deliver.push({ id, session, prompt, options });
      return deliver ? deliver({ id, session, prompt, options }) : { success: true, strategy: 'mailbox', msg_id: 'm-1', queued: false, pending: 0, submit: 'deferred' };
    },
  };
  if (store === 'real') shared.replyCapabilityStore = spyStore;
  else if (store !== null) shared.replyCapabilityStore = store;
  const handlers = {};
  const actions = createSessionActions(shared, {});
  const app = { post(route, fn) { handlers[route] = fn; } };
  actions.registerInjectRoute(app, '/api/forwarded/sessions/:id/inject');
  actions.registerInjectRoute(app);
  const call = async (id, body, { headers = {}, remote = '127.0.0.1', clientProfile, forwarded = false } = {}) => {
    const res = { statusCode: 200, body: null, status(code) { res.statusCode = code; return res; }, json(value) { res.body = value; return res; } };
    const req = { params: { id }, body, headers: { 'x-telepty-session-token': Q_BEARER, ...headers },
      socket: { remoteAddress: remote }, method: 'POST', ...(clientProfile ? { clientProfile } : {}) };
    await handlers[forwarded ? '/api/forwarded/sessions/:id/inject' : '/api/sessions/:id/inject'](req, res);
    return res;
  };
  return { call, calls, shared, sessions, requester, responder, principals, realStore };
}

function mintBody(over = {}, rcOver = {}) {
  return { prompt: PROMPT, from: 'requester-q', exact_target: true,
    reply_capability: { v: 1, not_after_ms: NOT_AFTER, reply_prefix: PREFIX, ...rcOver }, ...over };
}

async function quietly(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  console.log = console.warn = console.error = (...args) => lines.push(args.map(String).join(' '));
  try { return { result: await fn(), lines }; } finally { Object.assign(console, saved); }
}

function preMint(store, responder, requester) {
  const minted = store.mint({ responder, requester, inbound_inject_id: 'pre-existing', reply_prefix: PREFIX, not_after_ms: NOT_AFTER });
  assert.equal(minted.ok, true);
}

function assertNoEffect(f, before) {
  assert.deepEqual(f.calls.begin, [], 'beginTrackedInjection ran after a mint refusal');
  assert.deepEqual(f.calls.deliver, [], 'delivery ran after a mint refusal');
  assert.equal(f.calls.store.includes('mint'), false, 'store.mint ran after a mint refusal');
  assert.equal(f.realStore.size(), before, 'a record was created by a refused mint');
  assert.deepEqual(f.calls.audit, []);
  assert.deepEqual(f.calls.events, []);
  assert.deepEqual(f.calls.bus, []);
  assert.deepEqual(Object.keys(f.shared.pendingReports), []);
}

// ───────────────────────────── U2: admission M1–M9 ─────────────────────────────

// rc-fix6: a wrapped session whose CURRENT owner generation's bridge declared reply-guard-v1 on its owner-WS handshake
// (what bindImmediateSubmitCapability records) and announced its started child (process_started, child_seq 1).
function announcingWrapped(record, generation) {
  record.type = 'wrapped';
  record.sessionEpochProved = record.sessionEpoch;
  delete record.delivery;
  record.interactionOwnerGeneration = generation;
  record.replyGuardGeneration = generation;
  record.transportReadiness = { owner_generation: generation, capable: true, nonce: 'n'.repeat(22),
    process_started: { child_seq: 1, pid: 4242, exec: 'unverified', observed_at: new Date(T0).toISOString() },
    input_transport_ready: null, retired_child_seq: 0, cleared_reason: null };
  return record;
}

const OTHER = { sid: 'other-q', epoch: 'epoch-o', generation: 1 };
const RESPONDER_A = { sid: 'responder-a', epoch: 'epoch-r', generation: 1 };
const REQUESTER_Q = { sid: 'requester-q', epoch: 'epoch-q', generation: 1 };

// Each condition makes exactly one of M1–M9 fail. `fx` = fixture options, `body`/`rcOver` = request, `req` = call
// options, `setup` mutates the fixture before the call.
const CONDITIONS = {
  M1_store: { code: 'REPLY_CAPABILITY_UNAVAILABLE', fx: { store: null } },
  M1_profile: { code: 'REPLY_CAPABILITY_UNAVAILABLE', req: { clientProfile: { id: 'profile-1' } } },
  M1_forwarded: { code: 'REPLY_CAPABILITY_UNAVAILABLE', req: { forwarded: true } },
  M2_extra_key: { code: 'REPLY_CAPABILITY_REQUEST_INVALID', rcOver: { extra: 1 } },
  M2_version: { code: 'REPLY_CAPABILITY_REQUEST_INVALID', rcOver: { v: 2 } },
  M2_deadline_type: { code: 'REPLY_CAPABILITY_REQUEST_INVALID', rcOver: { not_after_ms: String(NOT_AFTER) } },
  M2_prefix_newline: { code: 'REPLY_CAPABILITY_REQUEST_INVALID', rcOver: { reply_prefix: 'REPLY\nX' } },
  M2_prefix_empty: { code: 'REPLY_CAPABILITY_REQUEST_INVALID', rcOver: { reply_prefix: '' } },
  M2_null: { code: 'REPLY_CAPABILITY_REQUEST_INVALID', body: { reply_capability: null } },
  M2_array: { code: 'REPLY_CAPABILITY_REQUEST_INVALID', body: { reply_capability: [1, NOT_AFTER, PREFIX] } },
  M3_remote: { code: 'REPLY_CAPABILITY_SENDER_UNVERIFIED', req: { remote: '192.0.2.7' } },
  M3_origin: { code: 'REPLY_CAPABILITY_SENDER_UNVERIFIED', req: { headers: { origin: 'http://127.0.0.1' } } },
  M3_forwarding: { code: 'REPLY_CAPABILITY_SENDER_UNVERIFIED', body: { forwarding: true } },
  M4_no_bearer: { code: 'REPLY_CAPABILITY_SENDER_UNVERIFIED', req: { headers: { 'x-telepty-session-token': undefined } } },
  M4_from: { code: 'REPLY_CAPABILITY_SENDER_UNVERIFIED', body: { from: 'someone-else' } },
  M5_epoch: { code: 'REPLY_CAPABILITY_REQUESTER_STALE', setup: f => { f.requester.sessionEpoch = 'epoch-q2'; } },
  M5_generation: { code: 'REPLY_CAPABILITY_REQUESTER_STALE', setup: f => { f.requester.credentialGeneration = 2; } },
  M5_closing: { code: 'REPLY_CAPABILITY_REQUESTER_STALE', setup: f => { f.requester.isClosing = true; } },
  M5_gone: { code: 'REPLY_CAPABILITY_REQUESTER_STALE', setup: f => { delete f.sessions['requester-q']; } },
  M6_exact: { code: 'REPLY_CAPABILITY_REQUEST_INVALID', body: { exact_target: undefined } },
  M7_unproved: { code: 'REPLY_CAPABILITY_TARGET_UNSUPPORTED', setup: f => { f.responder.sessionEpochProved = 'epoch-old'; } },
  M7_no_epoch: { code: 'REPLY_CAPABILITY_TARGET_UNSUPPORTED', setup: f => { delete f.responder.sessionEpoch; delete f.responder.sessionEpochProved; } },
  M7_type: { code: 'REPLY_CAPABILITY_TARGET_UNSUPPORTED', setup: f => { f.responder.type = 'aterm'; } },
  M7_ssh: { code: 'REPLY_CAPABILITY_TARGET_UNSUPPORTED', setup: f => { f.responder.sshRemote = { host: 'h' }; } },
  M7_closing: { code: 'REPLY_CAPABILITY_TARGET_UNSUPPORTED', setup: f => { f.responder.isClosing = true; } },
  M7_self: { code: 'REPLY_CAPABILITY_TARGET_UNSUPPORTED', target: 'requester-q',
    setup: f => { f.requester.type = 'wrapped'; f.requester.sessionEpochProved = 'epoch-q'; } },
  // GB-03 (M7a): requesters outside the support matrix, refused at mint.
  M7a_mailbox: { code: 'REPLY_CAPABILITY_REQUESTER_UNSUPPORTED', setup: f => { f.requester.type = 'mailbox'; delete f.requester.delivery; } },
  M7a_wrapped: { code: 'REPLY_CAPABILITY_REQUESTER_UNSUPPORTED', setup: f => { f.requester.type = 'wrapped'; f.requester.sessionEpochProved = 'epoch-q'; delete f.requester.delivery; } },
  // rc-fix6: a daemon-owned PTY requester is now in the matrix; one over SSH is not (replaces the former M7a_spawned row).
  M7a_spawned_ssh: { code: 'REPLY_CAPABILITY_REQUESTER_UNSUPPORTED', setup: f => { f.requester.type = 'spawned'; f.requester.sshRemote = { host: 'h' }; delete f.requester.delivery; } },
  // rc-fix6: a wrapped requester whose bridge announced reply-guard-v1 only in an EARLIER owner generation (old bridge now).
  M7a_wrapped_stale_announcement: { code: 'REPLY_CAPABILITY_REQUESTER_UNSUPPORTED', setup: f => { announcingWrapped(f.requester, 'owner-gen-q'); f.requester.replyGuardGeneration = 'owner-gen-q-previous'; } },
  M7a_aterm_http: { code: 'REPLY_CAPABILITY_REQUESTER_UNSUPPORTED', setup: f => { f.requester.delivery = null; f.requester.deliveryEndpoint = 'http://127.0.0.1:9/inject'; } },
  M7a_aterm_ssh: { code: 'REPLY_CAPABILITY_REQUESTER_UNSUPPORTED', setup: f => { f.requester.sshRemote = { host: 'h' }; } },
  M8_soon: { code: 'REPLY_CAPABILITY_DEADLINE_INVALID', rcOver: { not_after_ms: T0 + 29999 } },
  M8_late: { code: 'REPLY_CAPABILITY_DEADLINE_INVALID', rcOver: { not_after_ms: T0 + 3600001 } },
  M9_responder: { code: 'REPLY_CAPABILITY_CAPACITY', fx: { limits: { maxLivePerResponder: 1 } },
    setup: f => preMint(f.realStore, RESPONDER_A, OTHER) },
  M9_requester: { code: 'REPLY_CAPABILITY_CAPACITY', fx: { limits: { maxLivePerRequester: 1 } },
    setup: f => preMint(f.realStore, { sid: 'responder-z', epoch: 'epoch-z', generation: 1 }, REQUESTER_Q) },
  M9_global: { code: 'REPLY_CAPABILITY_CAPACITY', fx: { limits: { maxLiveGlobal: 1 } },
    setup: f => preMint(f.realStore, { sid: 'responder-z', epoch: 'epoch-z', generation: 1 }, OTHER) },
};

async function runConditions(t, names) {
  const merged = { fx: {}, body: {}, rcOver: {}, req: { headers: {} }, setups: [], target: 'responder-a' };
  for (const name of names) {
    const c = CONDITIONS[name];
    Object.assign(merged.fx, c.fx || {});
    if (c.fx && c.fx.limits) merged.fx.limits = { ...(merged.fx.limits || {}), ...c.fx.limits };
    Object.assign(merged.body, c.body || {});
    Object.assign(merged.rcOver, c.rcOver || {});
    merged.req = { ...merged.req, ...(c.req || {}), headers: { ...merged.req.headers, ...((c.req && c.req.headers) || {}) } };
    if (c.setup) merged.setups.push(c.setup);
    if (c.target) merged.target = c.target;
  }
  const f = routeFixture(t, merged.fx);
  for (const setup of merged.setups) setup(f);
  const before = f.realStore.size();
  const body = mintBody(merged.body, merged.rcOver);
  const res = await f.call(merged.target, body, merged.req);
  return { f, res, before };
}

for (const [name, condition] of Object.entries(CONDITIONS)) {
  test(`U2 ${name}: ${condition.code} before any effect`, async t => {
    const { f, res, before } = await runConditions(t, [name]);
    assert.equal(res.statusCode, rc.ERROR_STATUS[condition.code]);
    assert.equal(res.body.code, condition.code);
    assert.equal(Object.hasOwn(res.body, 'reply_capability'), false);
    assertNoEffect(f, before);
  });
}

// Two failing conditions at once: the EARLIER one in SPEC order answers.
const ORDER_PAIRS = [
  ['M1_profile', 'M2_extra_key'], ['M2_extra_key', 'M3_origin'], ['M3_origin', 'M5_epoch'], ['M4_from', 'M5_epoch'],
  ['M5_epoch', 'M6_exact'], ['M5_epoch', 'M7_unproved'], ['M6_exact', 'M7_unproved'], ['M7_unproved', 'M8_soon'],
  ['M8_soon', 'M9_responder'],
  ['M7_unproved', 'M7a_mailbox'], ['M7a_mailbox', 'M8_soon'], ['M7a_mailbox', 'M9_responder'],
];
for (const [first, second] of ORDER_PAIRS) {
  test(`U2 order: ${first} answers before ${second}`, async t => {
    const { f, res, before } = await runConditions(t, [first, second]);
    assert.equal(res.body.code, CONDITIONS[first].code);
    assertNoEffect(f, before);
  });
}

test('GB-03 a mailbox-only requester learns at mint time: 409 REQUESTER_UNSUPPORTED before the store is touched, no token is sent', async t => {
  const f = routeFixture(t);
  f.requester.type = 'mailbox';
  delete f.requester.delivery;
  const res = await f.call('responder-a', mintBody());
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'REPLY_CAPABILITY_REQUESTER_UNSUPPORTED');
  assert.equal(Object.hasOwn(res.body, 'reply_capability'), false);
  assert.deepEqual(f.calls.store, [], 'no store method ran: not the deadline check, the capacity sweep or the mint');
  assert.deepEqual(f.calls.peer, []);
  assert.deepEqual(f.calls.deliver, [], 'the responder never receives a token it could not spend');
  assert.equal(f.realStore.size(), 0);
});

test('U2 the peer-lane guard runs after M1–M9 and before the mint; its block leaves no capability', async t => {
  const block = () => ({ decision: 'block', reason: 'unsanctioned', kind: 'raw', envelopePresent: false, lane: 'peer' });
  const f = routeFixture(t, { peer: block });
  const { result: res } = await quietly(() => f.call('responder-a', mintBody()));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'PEER_INJECT_BLOCKED');
  assert.equal(f.realStore.size(), 0);
  assert.equal(f.calls.store.includes('mint'), false);
  assert.equal(f.calls.audit.length, 1);
  assert.equal(Object.hasOwn(f.calls.audit[0], 'reply_capability'), false);
  assert.deepEqual(f.calls.begin, []);
  const g = routeFixture(t, { peer: block });
  const late = await g.call('responder-a', mintBody({}, { not_after_ms: T0 + 1000 }));
  assert.equal(late.body.code, 'REPLY_CAPABILITY_DEADLINE_INVALID', 'M8 must answer before the peer-lane guard');
  assert.deepEqual(g.calls.peer, []);
  assert.deepEqual(g.calls.audit, []);
});

test('U2 admitted: one record minted after the peer guard and before beginTrackedInjection, bound as SPEC §2.2', async t => {
  const f = routeFixture(t);
  const { result: res, lines } = await quietly(() => f.call('responder-a', mintBody()));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(f.calls.peer, [{ storeSize: 0 }]);
  assert.equal(f.calls.begin.length, 1);
  assert.equal(f.calls.begin[0].storeSize, 1);
  const id = res.body.reply_capability.id;
  assert.deepEqual(res.body.reply_capability, { v: 1, id, not_after_ms: NOT_AFTER,
    responder: { session_id: 'responder-a', epoch: 'epoch-r', generation: 1 } });
  const record = f.realStore.get(id);
  assert.equal(record.state, 'issued');
  assert.deepEqual(record.responder, RESPONDER_A);
  assert.deepEqual(record.requester, REQUESTER_Q);
  assert.equal(record.inbound_inject_id, res.body.inject_id);
  assert.equal(record.reply_prefix, PREFIX);
  assert.equal(record.not_after_ms, NOT_AFTER);
  assert.doesNotMatch(JSON.stringify(res.body), TOKEN_ANYWHERE);
  for (const line of lines) assert.doesNotMatch(line, TOKEN_ANYWHERE);
  const trailer = f.calls.deliver[0].options.replyCapabilityTrailer;
  const token = trailer.match(TOKEN_ANYWHERE)[0];
  assert.equal(trailer, rc.replyCapabilityTrailer({ id, token, not_after_ms: NOT_AFTER }));
  assert.deepEqual(f.realStore.resolve(token), { ok: true, id });
});

test('U2 a mailbox-type target with a proved epoch record is admitted (M7 second arm)', async t => {
  const f = routeFixture(t);
  f.responder.type = 'mailbox';
  delete f.responder.sessionEpochProved;
  const { result: res } = await quietly(() => f.call('responder-a', mintBody()));
  assert.equal(res.statusCode, 200);
  assert.equal(f.realStore.size(), 1);
});

// ───────────────────────────── U3: golden, field absent ─────────────────────────────

const GOLDEN_LINE_KEYS = ['v', 'ts', 'inject_id', 'kind', 'source', 'claimed_from', 'verified_sender_sid', 'verified_sender_epoch',
  'verified_sender_generation', 'spoof_suspected', 'to', 'to_alias', 'origin', 'origin_host', 'ref_path', 'payload_sha256',
  'payload_bytes', 'payload_preview', 'delivery_result', 'claimed_return_locator', 'return_locator_verification', 'claimed_cross_host'];

function goldenOutputs(t, store, deliver) {
  return (async () => {
    const f = routeFixture(t, { store, deliver });
    const { result: res } = await quietly(() => f.call('responder-a', { prompt: PROMPT, from: 'requester-q', exact_target: true }));
    return { f, res };
  })();
}

const TOUCH_TRAP = new Proxy({}, { get() { throw new Error('the reply-capability store was touched without the field'); } });

for (const [label, store] of [['store present (trap)', TOUCH_TRAP], ['store present (spy)', 'real'], ['store absent', null]]) {
  test(`U3 golden success, field absent, ${label}: response, audit, bus, tracking and delivery args are the pre-change values`, async t => {
    const { f, res } = await goldenOutputs(t, store);
    const ts = new Date(T0).toISOString();
    const U1 = uuid(1);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, inject_id: U1, strategy: 'mailbox', submit: 'deferred', exact_target: true, session_id: 'responder-a' });
    assert.deepEqual(f.calls.begin.map(c => c.args), [{ injectId: U1, sessionId: 'responder-a', source: 'requester-q', session: f.responder }]);
    assert.deepEqual(f.shared.pendingReports['responder-a'], { source: 'requester-q', injectedAt: ts, injectId: U1, submitExpected: false,
      noEnter: false, injectedBodyPreview: PROMPT, ringBytesAtInject: 0, awaitingReport: true });
    assert.deepEqual(f.calls.deliver.map(c => [c.id, c.prompt, c.options]), [['responder-a', PROMPT, { noEnter: false,
      cooperativeHandoffConsent: null, source: 'inject', externalApproval: null, from: 'requester-q', injectId: U1, pairInjectId: U1,
      verifiedSenderSid: 'requester-q' }]]);
    assert.deepEqual(f.calls.audit, [{ ts, inject_id: U1, kind: 'inject', source: 'inject', claimed_from: 'requester-q',
      verified_sender_sid: 'requester-q', verified_sender_epoch: 'epoch-q', verified_sender_generation: 1,
      claimed_return: { locator: 'requester-q', verification: 'unverified', claimed_cross_host: false, host_qualified: false },
      to: 'responder-a', to_alias: null, origin: 'trusted-local', origin_host: 'synthetic-host', ref_path: null,
      payload: PROMPT, delivery_result: 'success' }]);
    assert.deepEqual(Object.keys(JSON.parse(buildAuditLine(f.calls.audit[0]))), GOLDEN_LINE_KEYS);
    assert.deepEqual(f.calls.events, [{ type: 'inject_written', id: 'responder-a', data: { timestamp: ts, extra: { inject_id: U1,
      target_agent: 'responder-a', content_sha256: sha256(PROMPT), content_length: 19, from: 'requester-q',
      verified_sender_sid: 'requester-q', verified_sender_epoch: 'epoch-q', verified_sender_generation: 1, spoof_suspected: false,
      origin: 'trusted-local', reply_to: 'requester-q', thread_id: null, reply_expected: false } } }]);
    assert.deepEqual(f.calls.bus, [{ type: 'message_routed', message_id: U1, from: 'requester-q', to: 'responder-a', reply_to: 'requester-q',
      inject_id: U1, deliberation_session_id: null, thread_id: null, timestamp: ts }]);
    assert.deepEqual(f.calls.store, []);
    assert.equal(f.realStore.size(), 0);
  });
}

test('U3 golden definitive refusal, field absent: the error body and the failed audit line are the pre-change values', async t => {
  const refusal = { success: false, httpStatus: 409, code: 'COMPOSER_STRANDED', error: 'stranded', bytes_written: 0 };
  const { f, res } = await goldenOutputs(t, TOUCH_TRAP, () => refusal);
  const U1 = uuid(1);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { success: false, code: 'COMPOSER_STRANDED', inject_id: U1, tracking_state: 'aborted' });
  assert.deepEqual(f.calls.errorReplies, [{ status: 409, code: 'COMPOSER_STRANDED', error: 'stranded' }]);
  assert.equal(f.calls.audit.length, 1);
  assert.equal(f.calls.audit[0].delivery_result, 'failed:COMPOSER_STRANDED');
  assert.equal(Object.hasOwn(f.calls.audit[0], 'reply_capability'), false);
  assert.deepEqual(Object.keys(JSON.parse(buildAuditLine(f.calls.audit[0]))), GOLDEN_LINE_KEYS);
});

test('U3 golden audit builder: a line without a plain reply_capability object is the pre-change line, byte for byte', () => {
  const record = { ts: 'x', inject_id: 'i', kind: 'inject', source: 'inject', claimed_from: 'a', verified_sender_sid: 'a',
    verified_sender_epoch: 'e', verified_sender_generation: 1, to: 'b', payload: 'p', delivery_result: 'success' };
  const line = buildAuditLine(record);
  assert.equal(line, JSON.stringify({ v: 1, ts: 'x', inject_id: 'i', kind: 'inject', source: 'inject', claimed_from: 'a',
    verified_sender_sid: 'a', verified_sender_epoch: 'e', verified_sender_generation: 1, spoof_suspected: false, to: 'b',
    to_alias: null, origin: 'trusted-local', origin_host: null, ref_path: null, payload_sha256: sha256('p'), payload_bytes: 1,
    payload_preview: null, delivery_result: 'success' }));
  for (const notAnObject of [null, 'rc', 7, ['id']]) assert.equal(buildAuditLine({ ...record, reply_capability: notAnObject }), line);
});

// ───────────────────────────── audit block (S2 / H4 shape) ─────────────────────────────

test('S2 audit block: whitelisted keys only, typed, token never passes', () => {
  const token = `rc1.${'A'.repeat(22)}.${'B'.repeat(43)}`;
  const line = JSON.parse(buildAuditLine({ kind: 'inject', payload: '', reply_capability: { id: 'cap-id', not_after_ms: NOT_AFTER,
    sender_proof: 'reply-capability-v1', reply_to_inject_id: 'inbound-1', reply_attempt: 2, suppressed_count: 3, token, secret: token,
    verifier: 'v' } }));
  assert.equal(line.reply_capability_id, 'cap-id');
  assert.equal(line.reply_capability_not_after, new Date(NOT_AFTER).toISOString());
  assert.equal(line.sender_proof, 'reply-capability-v1');
  assert.equal(line.reply_to_inject_id, 'inbound-1');
  assert.equal(line.reply_attempt, 2);
  assert.equal(line.suppressed_count, 3);
  assert.doesNotMatch(JSON.stringify(line), TOKEN_ANYWHERE);
  assert.equal(Object.hasOwn(line, 'verifier'), false);
  const loose = JSON.parse(buildAuditLine({ reply_capability: { id: 7, not_after_ms: 9e15, sender_proof: 'bearer', reply_attempt: '2',
    reply_to_inject_id: 5, suppressed_count: 1.5 } }));
  assert.equal(loose.reply_capability_id, null);
  for (const key of ['reply_capability_not_after', 'sender_proof', 'reply_attempt', 'reply_to_inject_id', 'suppressed_count']) {
    assert.equal(Object.hasOwn(loose, key), false, key);
  }
});

// ───────────────────────────── U13: trailer placement (route side) and S3 ─────────────────────────────

test('U13/S3 route: audit hashes and previews the RAW prompt; viewer, bus, events and pending preview never carry the token', async t => {
  const f = routeFixture(t);
  const viewerFrames = [];
  f.responder.clients.add({ readyState: 1, send: frame => viewerFrames.push(String(frame)) });
  const { result: res, lines } = await quietly(() => f.call('responder-a', mintBody()));
  assert.equal(res.statusCode, 200);
  const trailer = f.calls.deliver[0].options.replyCapabilityTrailer;
  assert.match(trailer, TOKEN_ANYWHERE);
  assert.equal(f.calls.deliver[0].prompt, PROMPT, 'the route hands the RAW prompt; the trailer is a separate option');
  const record = f.calls.audit[0];
  assert.equal(record.payload, PROMPT);
  assert.deepEqual(record.reply_capability, { id: res.body.reply_capability.id, not_after_ms: NOT_AFTER });
  const line = JSON.parse(buildAuditLine(record));
  assert.equal(line.payload_sha256, sha256(PROMPT));
  assert.equal(line.reply_capability_id, res.body.reply_capability.id);
  assert.equal(line.reply_capability_not_after, new Date(NOT_AFTER).toISOString());
  const previewLine = buildAuditLine({ ...record, preview: true });
  assert.equal(JSON.parse(previewLine).payload_preview, PROMPT);
  assert.doesNotMatch(previewLine, TOKEN_ANYWHERE, 'S3: the token reached the audit line with preview enabled');
  assert.equal(previewLine.includes(trailer.match(TOKEN_ANYWHERE)[0]), false);
  for (const surface of [JSON.stringify(f.calls.events), JSON.stringify(f.calls.bus), JSON.stringify(f.shared.pendingReports),
    JSON.stringify(viewerFrames), JSON.stringify(res.body), lines.join('\n')]) {
    assert.doesNotMatch(surface, TOKEN_ANYWHERE);
  }
  assert.equal(JSON.parse(viewerFrames[0]).content, PROMPT);
  assert.equal(f.shared.pendingReports['responder-a'].injectedBodyPreview, PROMPT);
});

// ───────────────────────────── U14: inbound settlement (SPEC §2.4) ─────────────────────────────

const INBOUND = [
  { name: 'success', delivery: { success: true, strategy: 'mailbox', msg_id: 'm', queued: false, submit: 'deferred' }, state: 'issued', status: 200, field: true },
  { name: 'queued (poll_only)', delivery: { success: true, strategy: 'mailbox', poll_only: true, queued: true, delivered: false, bytes_written: 0, msg_id: 'm', pending: 1, submit: 'not_applicable' }, state: 'issued', status: 200, field: true },
  { name: 'uncertain', delivery: { success: false, httpStatus: 504, code: 'DELIVERY_UNCERTAIN', delivery_uncertain: true, bytes_written: null, error: 'u' }, state: 'issued', status: 504, field: true },
  { name: 'definitive refusal', delivery: { success: false, httpStatus: 409, code: 'COMPOSER_STRANDED', bytes_written: 0, error: 'r' }, state: 'revoked', status: 409, field: false },
  { name: 'W2-D1 unsupported branch', delivery: { success: false, httpStatus: 409, code: 'REPLY_CAPABILITY_DELIVERY_UNSUPPORTED', bytes_written: 0, error: 'x' }, state: 'revoked', status: 409, field: false },
  { name: 'session gone', delivery: { success: false, httpStatus: 410, code: 'SESSION_GONE', error: 'g' }, state: 'revoked', status: 410, field: false },
];
for (const row of INBOUND) {
  test(`U14 inbound ${row.name} → capability ${row.state}`, async t => {
    const f = routeFixture(t, { deliver: () => row.delivery });
    const { result: res } = await quietly(() => f.call('responder-a', mintBody()));
    assert.equal(res.statusCode, row.status);
    assert.equal(f.calls.mintedIds.length, 1);
    const record = f.realStore.get(f.calls.mintedIds[0]);
    assert.equal(record.state, row.state);
    if (row.state === 'revoked') assert.equal(record.revoked_reason, 'inbound_refused');
    assert.equal(Object.hasOwn(res.body, 'reply_capability'), row.field);
    if (row.field) assert.deepEqual(res.body.reply_capability, f.realStore.publicView(record.id));
    assert.deepEqual(f.calls.audit[0].reply_capability, { id: record.id, not_after_ms: NOT_AFTER });
  });
}

test('U14 route catch (delivery threw) → capability stays issued; the 500 body is unchanged', async t => {
  const f = routeFixture(t, { deliver: () => { throw new Error('boom'); } });
  const { result: res } = await quietly(() => f.call('responder-a', mintBody()));
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { success: false, code: 'DELIVERY_FAILED' });
  assert.deepEqual(f.calls.errorReplies, [{ code: 'DELIVERY_FAILED', error: 'Delivery failed; see daemon log.' }]);
  assert.equal(f.realStore.get(f.calls.mintedIds[0]).state, 'issued');
});

for (const [label, begun, status] of [['capacity', { ok: false, capacity: true, reason: 'full' }, 503],
  ['persistence', { ok: false, reason: 'tracking_persistence_failed' }, 500]]) {
  test(`U14 beginTrackedInjection refusal (${label}) → capability revoked before the existing error answer`, async t => {
    const f = routeFixture(t, { begin: () => begun });
    const { result: res } = await quietly(() => f.call('responder-a', mintBody()));
    assert.equal(res.statusCode, status);
    assert.equal(Object.hasOwn(res.body, 'reply_capability'), false);
    assert.deepEqual(f.calls.deliver, []);
    assert.equal(f.calls.begin[0].storeSize, 1, 'the mint ran before beginTrackedInjection');
    const record = f.realStore.get(f.calls.mintedIds[0]);
    assert.equal(record.state, 'revoked');
    assert.equal(record.revoked_reason, 'inbound_refused');
    assert.equal(record.inbound_inject_id, f.calls.begin[0].args.injectId);
  });
}

// ───────────────────────────── delivery harness ─────────────────────────────

function deliveryFixture(t, over = {}) {
  mockClock(t);
  const frames = [], enqueued = [], withdrawn = [], bootstrapOps = [], parkedOps = [];
  const session = { id: 'target', type: 'wrapped', sessionEpoch: 'epoch-t', interactionOwnerGeneration: 1,
    ownerWs: { readyState: 1, send: raw => frames.push(JSON.parse(raw).data) }, ...(over.session || {}) };
  const sessions = { target: session };
  const mailbox = {
    enqueue: msg => { enqueued.push(msg); return { queued: true, pending: enqueued.length }; },
    withdraw: (...args) => { withdrawn.push(args); return true; },
    messageState: () => 'dead_letter',
  };
  let context;
  const dependencies = {
    sessions, crypto, DELIVERY_TIMEOUT_MS: 50,
    monoNow: () => Date.now(),   // GB-02: the delivery's monotonic clock follows the mocked clock unless a test splits them
    hasHeldInteraction: () => false, interaction: { invalidateInteraction() {} },
    isOpenWebSocket: ws => !!ws && ws.readyState === 1, armUpstreamProbe() {},
    shouldQueueBootstrapOperation: () => false, getInjectFailure: () => null,
    getSessionHealthStatus: () => 'HEALTHY',
    enqueueBootstrapOperation: (_id, target, op) => { bootstrapOps.push(op); (target.bootstrapQueue ||= []).push(op); return { op_id: 'op-1', ...op }; },
    parkTrackedInjection: async () => {},
    bootstrapQueuedResponse: (op, extra) => ({ success: true, strategy: 'bootstrap_queue', queued: true, bootstrap_queued: true, bootstrap_op_id: op.op_id, ...extra }),
    parkOperationOnModal: (_id, target, op) => { parkedOps.push(op); (target.bootstrapQueue ||= []).push(op); return { op_id: 'park-1', ...op }; },
    modalParkResponse: (op, _decision, extra) => ({ success: true, strategy: 'bootstrap_queue', queued: true, ...extra }),
    modalRejectionResponse: () => ({ code: 'MODAL' }),
    resolveModalGate: async () => null, modalRemedy: () => 'reject', hasBootstrapBacklog: () => false,
    applyProvenance, maybeBracketedPaste: payload => payload, emitInjectFailureEvent() {},
    buildErrorBody: (code, _error, extra) => ({ success: false, code, ...extra }),
    getMailbox: () => mailbox, getMailboxNotifier: () => ({ notify() {} }),
    getMailboxDelivery: () => ({ tick: async () => {} }),
    broadcastSessionEvent() {},
    ...(over.dependencies || {}),
  };
  context = createSessionDeliveryContext(dependencies);
  return { session, sessions, frames, enqueued, withdrawn, bootstrapOps, parkedOps, mailbox, context, dependencies };
}

// GB-01/GB-02: the one requester state in the support matrix — an aterm session reached over its unix socket. `net` is a
// stand-in that records every UDS write (the `text` of each Inject payload) and answers the endpoint's positive receipt.
// `holdConnect(cb)` keeps the connect callback until the test fires it; `failFirstConnect` makes the first connect fail
// before any write (DISCONNECTED, zero bytes). The immediate tick delivers the newest enqueued message through deliverFn.
function atermFixture(t, over = {}) {
  const writes = [];
  let connects = 0;
  let failNext = over.failFirstConnect === true;
  const net = {
    connect(_address, onConnect) {
      connects += 1;
      const sock = new EventEmitter();
      sock.destroy = () => {};
      sock.end = payload => {
        writes.push(JSON.parse(String(payload)).text);
        setImmediate(() => { sock.emit('data', Buffer.from('{"success":true}')); sock.emit('end'); });
      };
      if (failNext) { failNext = false; setImmediate(() => sock.emit('error', new Error('synthetic refusal'))); }
      else if (over.holdConnect) over.holdConnect(onConnect);
      else setImmediate(onConnect);
      return sock;
    },
  };
  let f;
  f = deliveryFixture(t, {
    session: { type: 'aterm', ownerWs: undefined, pendingSubmit: null,
      delivery: { transport: 'unix_socket', address: '/synthetic/target.sock' }, ...(over.session || {}) },
    dependencies: {
      // A UDS write completes over setImmediate turns here; 500 ms keeps the transport timeout out of the way on a slow
      // runner (the route's text wait is 2 x this).
      DELIVERY_TIMEOUT_MS: 500,
      net, markSessionDisconnected() {},
      getMailboxDelivery: () => ({ tick: async () => {
        const msg = f.enqueued[f.enqueued.length - 1];
        if (msg) await f.context.mailboxDeliveryOptions.deliverFn('target', msg);
      } }),
      ...(over.dependencies || {}),
    },
  });
  f.mailbox.beginNonRetryableAttempt = () => true;
  f.writes = writes;
  Object.defineProperty(f, 'connects', { get: () => connects });
  return f;
}

async function until(predicate) {
  for (let i = 0; i < 1000 && !predicate(); i += 1) await new Promise(resolve => setImmediate(resolve));
  assert.ok(predicate(), 'PRECONDITION: the awaited state was reached');
}

const TRAILER = rc.replyCapabilityTrailer({ id: 'A'.repeat(22), token: `rc1.${'A'.repeat(22)}.${'C'.repeat(43)}`, not_after_ms: NOT_AFTER });

// ───────────────────────────── U13: trailer placement (delivery side) ─────────────────────────────

test('U13 delivery: delivered text = applyProvenance(raw) + trailer, after the provenance fence', async t => {
  const f = deliveryFixture(t, { session: { provenanceCapable: true, provenanceNonce: 'nonce-1' } });
  const result = await f.context.deliverInjectionToSession('target', f.session, PROMPT,
    { noEnter: true, from: 'requester-q', verifiedSenderSid: 'requester-q', replyCapabilityTrailer: TRAILER });
  assert.equal(result.success, true);
  const fenced = applyProvenance(PROMPT, { capable: true, nonce: 'nonce-1', verified: 'requester-q', claimed: 'requester-q' }).payload;
  assert.notEqual(fenced, PROMPT);
  assert.equal(f.enqueued[0].payload, fenced + TRAILER);
  assert.ok(f.enqueued[0].payload.indexOf(TRAILER) > f.enqueued[0].payload.lastIndexOf('telepty:end nonce=nonce-1'));
});

test('U13 delivery: a mailbox-type target receives the trailer (trailer alone is allowed, W2-D1 a1)', async t => {
  const f = deliveryFixture(t, { session: { type: 'mailbox' } });
  const result = await f.context.deliverInjectionToSession('target', f.session, PROMPT, { replyCapabilityTrailer: TRAILER });
  assert.equal(result.success, true);
  assert.equal(result.poll_only, true);
  assert.equal(f.enqueued[0].payload, PROMPT + TRAILER);
});

// ───────────────────────────── U3: golden delivery, options absent ─────────────────────────────

test('U3 golden delivery: without the new options the enqueued message, the bootstrap op and the mailbox enqueue are unchanged', async t => {
  const f = deliveryFixture(t);
  const result = await f.context.deliverInjectionToSession('target', f.session, PROMPT, { noEnter: true, from: 'requester-q' });
  assert.deepEqual(result, { success: true, msg_id: f.enqueued[0].msg_id, queued: true, pending: 1, strategy: 'mailbox', submit: 'skipped' });
  assert.match(f.enqueued[0].msg_id, /^requester-q:1800000000000:[0-9a-f]{8}$/);
  assert.deepEqual(f.enqueued[0], { msg_id: f.enqueued[0].msg_id, from: 'requester-q', to: 'target', payload: PROMPT,
    created_at: Math.floor(T0 / 1000), attempt: 0 });

  const b = deliveryFixture(t, { dependencies: { shouldQueueBootstrapOperation: () => true } });
  const queued = await b.context.deliverInjectionToSession('target', b.session, PROMPT, { from: 'requester-q', injectId: 'i-1' });
  assert.equal(queued.bootstrap_queued, true);
  assert.deepEqual(b.bootstrapOps, [{ type: 'inject', prompt: PROMPT, noEnter: false, injectId: 'i-1', pairInjectId: null,
    options: { source: 'inject', from: 'requester-q' } }]);

  const m = deliveryFixture(t, { session: { type: 'mailbox' } });
  const polled = await m.context.deliverInjectionToSession('target', m.session, PROMPT, {});
  assert.equal(polled.poll_only, true);
  assert.deepEqual(m.enqueued, [{ msg_id: m.enqueued[0].msg_id, from: 'daemon', to: 'target', payload: PROMPT,
    created_at: Math.floor(T0 / 1000), attempt: 0 }]);

  t.mock.timers.tick(7200000);
  const written = await f.context.mailboxDeliveryOptions.deliverFn('target', f.enqueued[0]);
  assert.equal(written.success, true, 'a message without notAfterMs is never subject to the deadline');
  assert.deepEqual(f.frames, [PROMPT]);
  assert.deepEqual(f.withdrawn, []);
});

// ───────────────────────────── W2-D1: branches that cannot carry a reply capability ─────────────────────────────

const UNSUPPORTED = { success: false, httpStatus: 409, code: 'REPLY_CAPABILITY_DELIVERY_UNSUPPORTED', bytes_written: 0 };
const REPLY_OPTIONS = { trailer: { replyCapabilityTrailer: TRAILER }, deadline: { notAfterMs: NOT_AFTER } };

for (const [optionLabel, replyOptions] of Object.entries(REPLY_OPTIONS)) {
  test(`W2-D1 bootstrap queue refuses a ${optionLabel} delivery before the enqueue`, async t => {
    const f = deliveryFixture(t, { dependencies: { shouldQueueBootstrapOperation: () => true } });
    const result = await f.context.deliverInjectionToSession('target', f.session, PROMPT, { ...replyOptions });
    assert.deepEqual({ ...result, error: undefined }, { ...UNSUPPORTED, error: undefined });
    assert.deepEqual(f.bootstrapOps, []);
    assert.deepEqual(f.frames, []);
  });

  test(`W2-D1 modal park refuses a ${optionLabel} delivery before the park`, async t => {
    const f = deliveryFixture(t, { dependencies: { resolveModalGate: async () => ({ action: 'park', reason: 'modal_open' }) } });
    const result = await f.context.deliverInjectionToSession('target', f.session, PROMPT, { ...replyOptions });
    assert.equal(result.code, UNSUPPORTED.code);
    assert.equal(result.bytes_written, 0);
    assert.deepEqual(f.parkedOps, []);
    assert.deepEqual(f.enqueued, []);
  });

  test(`W2-D1 external approval refuses a ${optionLabel} delivery before the signed write`, async t => {
    const f = deliveryFixture(t, { session: { externalApprovalPolicy: { key: 'k' } } });
    const result = await f.context.deliverInjectionToSession('target', f.session, PROMPT, { ...replyOptions, externalApproval: { document: {} } });
    assert.equal(result.code, UNSUPPORTED.code);
    assert.equal(result.httpStatus, 409);
    assert.equal(result.bytes_written, 0);
    assert.deepEqual(f.frames, []);
  });
}

test('W2-D1 a mailbox-type target refuses a notAfterMs delivery before the enqueue', async t => {
  const f = deliveryFixture(t, { session: { type: 'mailbox' } });
  const result = await f.context.deliverInjectionToSession('target', f.session, PROMPT, { notAfterMs: NOT_AFTER });
  assert.equal(result.code, UNSUPPORTED.code);
  assert.equal(result.httpStatus, 409);
  assert.equal(result.bytes_written, 0);
  assert.deepEqual(f.enqueued, []);
});

test('W2-D1 controls: without the options the same branches keep their existing answers', async t => {
  const f = deliveryFixture(t, { dependencies: { resolveModalGate: async () => ({ action: 'park', reason: 'modal_open' }) } });
  const parked = await f.context.deliverInjectionToSession('target', f.session, PROMPT, {});
  assert.equal(parked.success, true);
  assert.equal(f.parkedOps.length, 1);
  const e = deliveryFixture(t, { session: { externalApprovalPolicy: { key: 'k' } } });
  const denied = await e.context.deliverInjectionToSession('target', e.session, PROMPT, {});
  assert.equal(denied.code, 'EXTERNAL_APPROVAL_REQUIRED');
});

// ───────────────────────────── U7(d): the write-time guard ─────────────────────────────

function deadlineRefusal(result) {
  assert.equal(result.success, false);
  assert.equal(result.code, 'REPLY_DEADLINE_PASSED');
  assert.equal(result.httpStatus, 410);
  assert.equal(result.bytes_written, 0);
}

test('U7(d) entry: a deadline already passed (or malformed) refuses before anything runs', async t => {
  let gateCalls = 0;
  const f = atermFixture(t, { dependencies: { resolveModalGate: async () => { gateCalls++; return null; } } });
  deadlineRefusal(await f.context.deliverInjectionToSession('target', f.session, PROMPT, { notAfterMs: T0 - 1 }));
  deadlineRefusal(await f.context.deliverInjectionToSession('target', f.session, PROMPT, { notAfterMs: String(NOT_AFTER) }));
  assert.equal(gateCalls, 0);
  assert.deepEqual(f.enqueued, []);
  assert.deepEqual(f.frames, []);
  assert.deepEqual(f.writes, []);
  const ok = await f.context.deliverInjectionToSession('target', f.session, PROMPT, { noEnter: true, notAfterMs: T0 });
  assert.equal(ok.success, true, 'not_after itself is still in time');
  assert.deepEqual(f.writes, [PROMPT]);
});

test('U7(d) suspended across the modal gate: the clock passes not_after during the await → refused, zero bytes', async t => {
  let release;
  const f = atermFixture(t, { dependencies: { resolveModalGate: () => new Promise(resolve => { release = resolve; }) } });
  const pending = f.context.deliverInjectionToSession('target', f.session, PROMPT, { noEnter: true, notAfterMs: T0 + 1000 });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1001);
  release(null);
  deadlineRefusal(await pending);
  assert.deepEqual(f.enqueued, []);
  assert.deepEqual(f.frames, []);
  assert.deepEqual(f.writes, []);
});

test('U7(d) suspended behind the submit barrier: the clock passes not_after during the wait → refused, zero bytes', async t => {
  const f = atermFixture(t);
  let releaseHolder;
  f.session.pendingSubmit = new Promise(resolve => { releaseHolder = resolve; });
  const pending = f.context.deliverInjectionToSession('target', f.session, PROMPT, { notAfterMs: T0 + 1000 });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1001);
  f.session.pendingSubmit = null;
  releaseHolder();
  deadlineRefusal(await pending);
  assert.deepEqual(f.enqueued, []);
  assert.deepEqual(f.frames, []);
  assert.deepEqual(f.writes, []);
});

test('U7(d) direct fallback: the clock passes not_after before the fallback write → refused, zero bytes, barrier released', async t => {
  let gets = 0;
  const f = atermFixture(t, { dependencies: { getMailbox: () => { gets++; t.mock.timers.tick(1001); throw new Error('mailbox unavailable'); } } });
  const { result } = await quietly(() => f.context.deliverInjectionToSession('target', f.session, PROMPT, { notAfterMs: T0 + 1000 }));
  deadlineRefusal(result);
  assert.equal(gets, 1);
  assert.deepEqual(f.frames, []);
  assert.equal(f.connects, 0);
  assert.equal(f.session.pendingSubmit, null);
});

// Replaces the former "U7(d) non-site" case, which asserted a CR written after not_after into a wrapped requester (W2-D5).
// GB-01/GB-02: a requester that owes a daemon-side deferred CR is outside the support matrix, so nothing is written at all.
test('GB-01/02 a reply into a requester that owes a deferred CR is refused before any text: no body, no CR', async t => {
  let ticks = 0;
  const f = deliveryFixture(t, { dependencies: { getMailboxDelivery: () => ({ tick: async () => { ticks++; } }) } });
  const result = await f.context.deliverInjectionToSession('target', f.session, PROMPT, { notAfterMs: T0 + 1000 });
  assert.deepEqual({ ...result, error: undefined }, { ...UNSUPPORTED, error: undefined });
  t.mock.timers.tick(5000);
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.deepEqual(f.frames, [], 'neither the body nor a CR');
  assert.deepEqual(f.enqueued, []);
  assert.equal(ticks, 0);
  assert.equal(f.session.pendingSubmit, undefined, 'the submit barrier was never claimed');
});

// ───────────────────────────── U7(e): parked in the mailbox queue ─────────────────────────────

test('U7(e) a message queued with notAfterMs and ticked after not_after is withdrawn, zero bytes', async t => {
  const f = atermFixture(t, { failFirstConnect: true });
  const queued = await quietly(() => f.context.deliverInjectionToSession('target', f.session, PROMPT, { noEnter: true, notAfterMs: T0 + 1000 }));
  assert.equal(queued.result.success, true);
  assert.equal(queued.result.delivery_status, 'retry_pending');
  const msg = f.enqueued[0];
  t.mock.timers.tick(1001);
  const result = await f.context.mailboxDeliveryOptions.deliverFn('target', msg);
  deadlineRefusal(result);
  assert.deepEqual(f.withdrawn, [['target', msg.msg_id, 'reply_deadline_passed', { inFlight: true }]]);
  assert.deepEqual(f.frames, []);
  assert.deepEqual(f.writes, []);
});

test('U7(e) control: the same message ticked before not_after is written', async t => {
  const f = atermFixture(t, { failFirstConnect: true });
  await quietly(() => f.context.deliverInjectionToSession('target', f.session, PROMPT, { noEnter: true, notAfterMs: T0 + 1000 }));
  t.mock.timers.tick(999);
  const result = await f.context.mailboxDeliveryOptions.deliverFn('target', f.enqueued[0]);
  assert.equal(result.success, true);
  assert.deepEqual(f.writes, [PROMPT]);
  assert.deepEqual(f.withdrawn, []);
});

test('GB-02 a wall clock that stands still or runs back after the enqueue cannot keep the final-write check open (monotonic bound)', async t => {
  let mono = 5000;
  const f = atermFixture(t, { failFirstConnect: true, dependencies: { monoNow: () => mono } });
  const queued = await quietly(() => f.context.deliverInjectionToSession('target', f.session, PROMPT, { noEnter: true, notAfterMs: T0 + 1000 }));
  assert.equal(queued.result.delivery_status, 'retry_pending');
  mono += 1001;   // monotonic time passes not_after; the (mocked) wall clock stays at T0
  assert.equal(Date.now(), T0, 'PRECONDITION: the wall clock did not advance');
  const result = await f.context.mailboxDeliveryOptions.deliverFn('target', f.enqueued[0]);
  deadlineRefusal(result);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.withdrawn, [['target', f.enqueued[0].msg_id, 'reply_deadline_passed', { inFlight: true }]]);
});

// ───────────────────────────── GB-01/GB-02: the support matrix at delivery ─────────────────────────────

const OUTSIDE_MATRIX = {
  wrapped: {},
  // rc-fix6: a spawned (daemon-owned PTY) requester is now supported; the same over SSH is not (replaces the former row).
  'spawned over SSH': { type: 'spawned', ownerWs: undefined, sshRemote: { host: 'h' }, ptyProcess: { killed: false, write() { throw new Error('PTY written'); } } },
  'ssh-remote wrapped': { sshRemote: { host: 'h' } },
  'aterm over HTTP': { type: 'aterm', ownerWs: undefined, deliveryEndpoint: 'http://127.0.0.1:9/inject' },
  mailbox: { type: 'mailbox' },
};
for (const [label, session] of Object.entries(OUTSIDE_MATRIX)) {
  test(`GB-01/02 a reply to a ${label} requester is refused at entry: no await, nothing enqueued or written`, async t => {
    let gateCalls = 0;
    let fetches = 0;
    const f = deliveryFixture(t, { session, dependencies: {
      resolveModalGate: async () => { gateCalls++; return null; }, fetch: async () => { fetches++; return { ok: true }; } } });
    const result = await f.context.deliverInjectionToSession('target', f.session, PROMPT, { noEnter: true, notAfterMs: NOT_AFTER });
    assert.deepEqual({ ...result, error: undefined }, { ...UNSUPPORTED, error: undefined });
    assert.equal(gateCalls, 0);
    assert.deepEqual(f.enqueued, []);
    assert.deepEqual(f.frames, []);
    assert.equal(fetches, 0);
  });
}

test('GB-01/02 control: the same reply to an aterm requester over its unix socket is written once', async t => {
  const f = atermFixture(t);
  const result = await f.context.deliverInjectionToSession('target', f.session, PROMPT, { notAfterMs: NOT_AFTER });
  assert.equal(result.success, true);
  assert.deepEqual(f.writes, [PROMPT]);
  assert.match(f.enqueued[0].msg_id, /:reply-capability-v1$/);
  assert.deepEqual(f.withdrawn, []);
});

test('GB-02 the deadline passes between deliverFn\'s check and the UDS connect callback → nothing written, withdrawn', async t => {
  let connected = null;
  const f = atermFixture(t, { holdConnect: cb => { connected = cb; } });
  const pending = f.context.deliverInjectionToSession('target', f.session, PROMPT, { notAfterMs: T0 + 1000 });
  await until(() => connected !== null);
  t.mock.timers.tick(1001);
  connected();
  deadlineRefusal(await pending);
  assert.deepEqual(f.writes, [], 'sock.end was never called');
  assert.deepEqual(f.withdrawn[0], ['target', f.enqueued[0].msg_id, 'reply_deadline_passed', { inFlight: true }]);
});

test('GB-02 the requester instance changes before the UDS connect callback → nothing written, destination gone', async t => {
  let connected = null;
  const f = atermFixture(t, { holdConnect: cb => { connected = cb; } });
  const pending = f.context.deliverInjectionToSession('target', f.session, PROMPT, { notAfterMs: NOT_AFTER });
  await until(() => connected !== null);
  f.session.sessionEpoch = 'epoch-t2';   // same record, new instance: the pre-existing callback check compares the record only
  connected();
  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(result.code, 'SESSION_GONE');
  assert.equal(result.bytes_written, 0);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.withdrawn[0], ['target', f.enqueued[0].msg_id, 'session_gone', { inFlight: true }]);
});

test('GB-02 the direct fallback (mailbox unavailable) refuses a reply: no UDS connect at all', async t => {
  const f = atermFixture(t, { dependencies: { getMailbox: () => { throw new Error('mailbox unavailable'); } } });
  const { result } = await quietly(() => f.context.deliverInjectionToSession('target', f.session, PROMPT, { notAfterMs: NOT_AFTER }));
  assert.deepEqual({ ...result, error: undefined }, { ...UNSUPPORTED, error: undefined });
  assert.equal(f.connects, 0);
  assert.deepEqual(f.writes, []);
});

test('GB-01 a reply row still pending when the daemon restarts is withdrawn unwritten by the new incarnation; an ordinary row is not', async t => {
  const f = atermFixture(t, { dependencies: { getMailboxDelivery: () => ({ tick: async () => {} }) } });   // tick busy elsewhere
  await quietly(() => f.context.deliverInjectionToSession('target', f.session, PROMPT, { notAfterMs: NOT_AFTER }));
  await quietly(() => f.context.deliverInjectionToSession('target', f.session, 'ordinary text', { noEnter: true }));
  const [reply, ordinary] = f.enqueued;
  assert.match(reply.msg_id, /:reply-capability-v1$/);
  assert.match(ordinary.msg_id, /^daemon:\d+:[0-9a-f]{8}$/, 'an ordinary msg_id keeps its exact format');
  f.withdrawn.length = 0;
  // The new incarnation: same mailbox rows and session record, no in-memory injection targets.
  const restarted = createSessionDeliveryContext(f.dependencies);
  const refused = await restarted.mailboxDeliveryOptions.deliverFn('target', reply);
  assert.equal(refused.success, false);
  assert.equal(refused.bytes_written, 0);
  assert.deepEqual(f.writes, [], 'the reply row was not written by the new daemon');
  assert.deepEqual(f.withdrawn, [['target', reply.msg_id, 'reply_binding_lost', { inFlight: true }]]);
  const written = await restarted.mailboxDeliveryOptions.deliverFn('target', ordinary);
  assert.equal(written.success, true, 'an ordinary row is delivered exactly as before');
  assert.deepEqual(f.writes, ['ordinary text']);
});

// ───────────────────────────── rc-fix6: wrapped (P2) and daemon-owned PTY (P1) requesters ─────────────────────────────

const OWNER_GEN = 'owner-gen-target';
const REPLY_INJECT_ID = uuid(77);   // the consume route's reply_inject_id, passed as pairInjectId → the frames' inject_id
const replyOptions = (notAfterMs = NOT_AFTER) => ({ from: 'responder-a', source: 'reply-capability-v1', injectId: null,
  pairInjectId: REPLY_INJECT_ID, verifiedSenderSid: 'responder-a', notAfterMs });
// Real-time wait: the deferred CR is a real 300/500 ms timer (only Date is mocked).
async function waitFor(predicate, label) {
  for (let i = 0; i < 400 && !predicate(); i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(predicate(), `PRECONDITION: ${label}`);
}

// The requester is wrapped. Its owner socket is an EventEmitter (the daemon reads this reply's bridge receipts from it)
// that records every raw frame; `receipt()` plays the bridge's answer in the exact bridge_receipt wire shape.
function wrappedReplyFixture(t, over = {}) {
  const raw = [];
  const ownerWs = new EventEmitter();
  ownerWs.readyState = 1;
  ownerWs.send = frame => raw.push(String(frame));
  let f;
  f = deliveryFixture(t, {
    session: { ownerWs, interactionOwnerGeneration: OWNER_GEN, pendingSubmit: null },
    dependencies: {
      getMailboxDelivery: () => ({ tick: async () => {
        const msg = f.enqueued[f.enqueued.length - 1];
        if (msg) await f.context.mailboxDeliveryOptions.deliverFn('target', msg);
      } }),
      emitInjectFailureEvent: (...args) => f.failures.push(args),
    },
  });
  f.failures = [];
  if (over.announce !== false) announcingWrapped(f.session, OWNER_GEN);
  f.raw = raw;
  f.parsed = () => raw.map(frame => JSON.parse(frame));
  f.receipt = (daemonMsgId, part, stage, certainty, reason = null) => ownerWs.emit('message', Buffer.from(JSON.stringify({
    type: 'bridge_receipt', schema: 1, daemon_msg_id: daemonMsgId, inject_id: part === 'body' ? REPLY_INJECT_ID : null, part, bridge_msg_id: null,
    stage, reason, certainty, bridge_seq: 1, at_ms: T0, clock: 'bridge_wall', owner_generation: OWNER_GEN })));
  return f;
}

// The requester is a daemon-owned PTY (type spawned); every PTY write is recorded.
function ptyReplyFixture(t) {
  const ptyWrites = [];
  let f;
  f = deliveryFixture(t, {
    session: { type: 'spawned', ownerWs: undefined, pendingSubmit: null,
      ptyProcess: { killed: false, write: data => ptyWrites.push(String(data)) } },
    dependencies: {
      getMailboxDelivery: () => ({ tick: async () => {
        const msg = f.enqueued[f.enqueued.length - 1];
        if (msg) await f.context.mailboxDeliveryOptions.deliverFn('target', msg);
      } }),
      emitInjectFailureEvent: (...args) => f.failures.push(args),
    },
  });
  f.failures = [];
  f.ptyWrites = ptyWrites;
  return f;
}

test('rc-fix6 golden: an ordinary inject to a wrapped session sends the pre-change frames byte for byte; a reply adds exactly the four reply_* keys', async t => {
  const o = wrappedReplyFixture(t);
  const ordinary = await o.context.deliverInjectionToSession('target', o.session, PROMPT, { from: 'requester-q' });
  assert.deepEqual(ordinary, { success: true, msg_id: o.enqueued[0].msg_id, queued: true, pending: 1, strategy: 'mailbox', submit: 'deferred' });
  await waitFor(() => o.raw.length === 2, 'the ordinary CR was sent');
  const id = o.enqueued[0].msg_id;
  assert.match(id, /^requester-q:1800000000000:[0-9a-f]{8}$/);
  assert.deepEqual(o.raw, [
    '{"type":"inject","data":"synthetic task text","daemon_msg_id":"' + id + '","part":"body","owner_generation":"owner-gen-target"}',
    '{"type":"inject","data":"\\r","daemon_msg_id":"' + id + ':submit","part":"submit","pair":"' + id + '","owner_generation":"owner-gen-target"}',
  ], 'the ordinary frames are the snapshot\'s frames, byte for byte');
  assert.equal(o.ownerWs.listenerCount('message'), 0, 'an ordinary inject never listens on the owner socket');
  assert.equal(o.session.strandedComposer, undefined);

  const r = wrappedReplyFixture(t);
  const pending = r.context.deliverInjectionToSession('target', r.session, PROMPT, replyOptions());
  await waitFor(() => r.raw.length === 1, 'the reply body was sent');
  const replyId = r.enqueued[0].msg_id;
  const reply = {
    reply_not_after_ms: NOT_AFTER, reply_ttl_ms: NOT_AFTER - T0, reply_session_epoch: 'epoch-t', reply_child_seq: 1 };
  assert.equal(r.raw[0], JSON.stringify({ type: 'inject', data: PROMPT, daemon_msg_id: replyId, inject_id: REPLY_INJECT_ID,
    part: 'body', owner_generation: OWNER_GEN, ...reply }));
  r.receipt(replyId, 'body', 'pty_written', 'written');
  await waitFor(() => r.raw.length === 2, 'the reply CR was sent');
  assert.equal(r.raw[1], JSON.stringify({ type: 'inject', data: '\r', daemon_msg_id: `${replyId}:submit`, part: 'submit',
    pair: replyId, owner_generation: OWNER_GEN, ...reply }));
  r.receipt(`${replyId}:submit`, 'submit', 'pty_written', 'written');
  const result = await pending;
  assert.equal(result.success, true);
  assert.equal(result.submit, 'written');
  assert.equal(r.ownerWs.listenerCount('message'), 0, 'the receipt listener is removed once decided');
});

test('rc-fix6 P2: the bridge drops the reply body (deadline or instance) → zero-byte settlement, the CR is never sent', async t => {
  for (const [reason, code, status] of [['reply_deadline_passed', 'REPLY_DEADLINE_PASSED', 410],
    ['reply_instance_changed', 'REPLY_BRIDGE_NOT_WRITTEN', 409]]) {
    const f = wrappedReplyFixture(t);
    const pending = f.context.deliverInjectionToSession('target', f.session, PROMPT, replyOptions());
    await waitFor(() => f.raw.length === 1, 'the reply body was sent');
    f.receipt(f.enqueued[0].msg_id, 'body', 'refused', 'not_written', reason);
    const result = await pending;
    assert.equal(result.success, false, reason);
    assert.equal(result.code, code, reason);
    assert.equal(result.httpStatus, status, reason);
    assert.equal(result.bytes_written, 0, reason);
    assert.equal(f.raw.length, 1, `${reason}: no CR frame followed a dropped body`);
    assert.equal(f.session.strandedComposer, undefined, `${reason}: nothing is in the composer`);
  }
});

test('rc-fix6 P2: the bridge refuses the CR after the body was written → outcome unknown, composer stranded, inject_failed', async t => {
  const f = wrappedReplyFixture(t);
  const pending = f.context.deliverInjectionToSession('target', f.session, PROMPT, replyOptions());
  await waitFor(() => f.raw.length === 1, 'the reply body was sent');
  const id = f.enqueued[0].msg_id;
  f.receipt(id, 'body', 'pty_written', 'written');
  await waitFor(() => f.raw.length === 2, 'the reply CR was sent');
  f.receipt(`${id}:submit`, 'submit', 'refused', 'not_written', 'reply_deadline_passed');
  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(result.code, 'DELIVERY_UNCERTAIN');
  assert.equal(result.delivery_uncertain, true);
  assert.equal(result.bytes_written, null, 'never a zero-byte refusal: the body is in the composer');
  assert.equal(f.session.strandedComposer.epoch, 'epoch-t');
  assert.equal(f.session.strandedComposer.reason, 'submit_refused_after_body');
  assert.equal(f.session.strandedComposer.inject_id, REPLY_INJECT_ID);
  assert.ok(f.failures.some(([sid, code, , extra]) => sid === 'target' && code === 'DELIVERY_UNCERTAIN' && extra.phase === 'submit'));
});

test('rc-fix6 P2: an old bridge (no reply-guard-v1 for this owner generation) is refused at delivery before any frame', async t => {
  const unannounced = wrappedReplyFixture(t, { announce: false });
  const stale = wrappedReplyFixture(t);
  stale.session.replyGuardGeneration = 'owner-gen-previous';   // declared by an earlier owner generation only
  const noChild = wrappedReplyFixture(t);
  noChild.session.transportReadiness.process_started = null;   // the bridge announced no child for this generation
  for (const [label, f] of [['unannounced', unannounced], ['stale generation', stale], ['no announced child', noChild]]) {
    const result = await f.context.deliverInjectionToSession('target', f.session, PROMPT, replyOptions());
    assert.deepEqual({ ...result, error: undefined }, { ...UNSUPPORTED, error: undefined }, label);
    assert.deepEqual(f.raw, [], label);
    assert.deepEqual(f.enqueued, [], label);
  }
  // Control: the same bridge with the announcement is admitted (refused at entry on the snapshot).
  const ok = wrappedReplyFixture(t);
  const pending = ok.context.deliverInjectionToSession('target', ok.session, PROMPT, replyOptions());
  await waitFor(() => ok.raw.length === 1, 'the announcing bridge received the body');
  ok.receipt(ok.enqueued[0].msg_id, 'body', 'refused', 'not_written', 'reply_deadline_passed');
  assert.equal((await pending).code, 'REPLY_DEADLINE_PASSED');
});

test('rc-fix6 P1: a PTY reply body is written only with the submit headroom left → otherwise zero bytes, withdrawn', async t => {
  const f = ptyReplyFixture(t);
  const result = await f.context.deliverInjectionToSession('target', f.session, PROMPT, replyOptions(T0 + 1000));
  deadlineRefusal(result);
  assert.deepEqual(f.ptyWrites, [], 'neither the body nor a CR reached the PTY');
  assert.deepEqual(f.withdrawn[0], ['target', f.enqueued[0].msg_id, 'reply_deadline_passed', { inFlight: true }]);
});

test('rc-fix6 P1: the deadline passes between the PTY body and its CR → no CR, stranded, settled outcome unknown', async t => {
  const f = ptyReplyFixture(t);
  const pending = f.context.deliverInjectionToSession('target', f.session, PROMPT, replyOptions(T0 + 2000));
  await waitFor(() => f.ptyWrites.length === 1, 'the body was written inside the headroom');
  t.mock.timers.tick(2001);   // the CR timer fires after not_after (an event-loop stall longer than the headroom)
  const result = await pending;
  assert.deepEqual(f.ptyWrites, [PROMPT], 'the CR was not written after the deadline');
  assert.equal(result.success, false);
  assert.equal(result.code, 'DELIVERY_UNCERTAIN');
  assert.equal(result.bytes_written, null, 'never accepted and never a zero-byte refusal');
  assert.equal(f.session.strandedComposer.reason, 'submit_refused_after_body');
  assert.ok(f.failures.some(([sid, code, , extra]) => sid === 'target' && code === 'REPLY_DEADLINE_PASSED' && extra.phase === 'submit'),
    'the existing submit-phase inject_failed event');
});

test('rc-fix6 P1 control: an in-time PTY reply writes the body and its CR and is accepted only after the CR', async t => {
  const f = ptyReplyFixture(t);
  const result = await f.context.deliverInjectionToSession('target', f.session, PROMPT, replyOptions());
  assert.deepEqual(f.ptyWrites, [PROMPT, '\r'], 'the result waited for the CR write');
  assert.equal(result.success, true);
  assert.equal(result.submit, 'written');
  assert.equal(f.session.strandedComposer, undefined);
});

test('rc-fix6 M7a: a spawned requester and a wrapped requester whose bridge announced reply-guard-v1 are admitted at mint', async t => {
  for (const setup of [r => { r.type = 'spawned'; delete r.delivery; }, r => announcingWrapped(r, 'owner-gen-q')]) {
    const f = routeFixture(t);
    setup(f.requester);
    const { result: res } = await quietly(() => f.call('responder-a', mintBody()));
    assert.equal(res.statusCode, 200);
    assert.equal(f.realStore.size(), 1);
    assert.match(f.calls.deliver[0].options.replyCapabilityTrailer, TOKEN_ANYWHERE);
  }
});
