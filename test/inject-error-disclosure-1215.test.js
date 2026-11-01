'use strict';
// #1215 pipe200 S24 (disclosure197 P1) — frozen negative regression. When delivery throws inside the inject route's
// catch-all, the raw exception text must not reach the HTTP response or the inject_failed event/bus sink. A strict-mode
// non-owner principal holding only a `session.inject` grant can reach this route, and it is not entitled to host
// filesystem metadata. Status 500 and code DELIVERY_FAILED stay unchanged, and the raw text is kept as a LOCAL operator
// diagnostic only.
//
// It drives the REAL route through the existing createSessionActions(shared) seam (as ledger-caller-wiring-1207.test.js).
// Only `shared` is a stand-in, and its deliverInjectionToSession throws an Error carrying a private marker. Strict
// reachability is asserted on the REAL action map (src/principal/http.js resolveAction). On the unchanged product the
// catch-all returns `err.message`, so the marker-absence assertion fails ("raw exception text reached the inject
// response").
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createSessionActions } = require('../src/routes/session-actions');
const { resolveAction } = require('../src/principal/http');

const MARK = 'MARK-1215-private';

function fixture(deliver, sessionId = 'target') {
  const events = [], audit = [], bus = [];
  const session = { id: sessionId, type: 'spawned', clients: new Set(), isClosing: false, outputRing: [], ready: true };
  const shared = {
    sessions: { [sessionId]: session }, pendingReports: Object.create(null), crypto, MACHINE_ID: 'synthetic-host', ORCHESTRATOR_SIDS: [],
    busClients: [{ readyState: 1, send: (frame) => bus.push(String(frame)) }],
    resolveSessionAlias: (id) => (Object.hasOwn(shared.sessions, id) ? id : null),
    respondWithError: (res, status, code, error, extra = {}) => res.status(status).json({ success: false, code, error, ...extra }),
    buildErrorBody: (code, error, extra = {}) => ({ success: false, code, error, ...extra }),
    verifiedPrincipalFromReq: () => null,
    verifiedSenderFields: () => ({ verified_sender_sid: null, verified_sender_epoch: null, verified_sender_generation: null }),
    classifyPeerLaneInject: () => ({ decision: 'allow', lane: 'none' }),
    emitInjectFailureEvent: (...args) => events.push(JSON.stringify(args)),
    broadcastSessionEvent: (...args) => events.push(JSON.stringify(args)),
    auditAppend: (record) => audit.push(JSON.stringify(record)),
    deliveryAuditResult: (delivery) => (delivery && (delivery.poll_only || delivery.bootstrap_queued) ? 'queued' : 'success'),
    abortTrackedInjection: async () => ({ ok: true }),
    beginTrackedInjection: async () => ({ ok: false, reason: 'not_expected_in_this_fixture' }),
    deliverInjectionToSession: deliver,
  };
  let handler = null;
  createSessionActions(shared, {}).registerInjectRoute({ post(route, fn) { if (route === '/api/sessions/:id/inject') handler = fn; } });
  assert.equal(typeof handler, 'function');
  const call = async (id, body) => {
    const res = { statusCode: 200, body: null, status(code) { res.statusCode = code; return res; }, json(value) { res.body = value; return res; } };
    await handler({ params: { id }, body, headers: {}, rawHeaders: [], method: 'POST', originalUrl: `/api/sessions/${id}/inject` }, res);
    return res;
  };
  return { call, events, audit, bus };
}
async function captureConsoleError(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => { lines.push(args.map((arg) => (arg && arg.stack ? arg.stack : String(arg))).join(' ')); };
  try { return { result: await fn(), lines }; } finally { console.error = original; }
}

test('[S24 reachability] strict mode admits any session.inject grant holder to the inject route (not owner-only)', () => {
  const action = resolveAction({ method: 'POST', originalUrl: '/api/sessions/target/inject', url: '/api/sessions/target/inject', body: {} });
  assert.deepEqual(action, { action: 'session.inject', target: 'target', explicitInject: true });
  const destroy = resolveAction({ method: 'POST', originalUrl: '/api/sessions/target/kill', url: '/api/sessions/target/kill', body: {} });
  assert.equal(destroy.action, 'session.destroy', 'control: destroy remains a different (owner-only) action');
});

test('[S24 negative] a thrown delivery error never reaches the inject response or the inject_failed sink; status, code and the local diagnostic stay', async () => {
  const f = fixture(async () => { throw new Error(`EACCES: open /home/${MARK}/state.json`); });
  const { result: res, lines } = await captureConsoleError(() => f.call('target', { prompt: 'synthetic prompt' }));
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.success, false);
  assert.equal(res.body.code, 'DELIVERY_FAILED');
  assert.doesNotMatch(JSON.stringify(res.body), new RegExp(MARK), 'raw exception text reached the inject response');
  assert.equal(typeof res.body.error, 'string');
  assert.ok(res.body.error.length > 0);
  const failure = f.events.find((event) => event.includes('DELIVERY_FAILED'));
  assert.ok(failure, 'the inject_failed event is still emitted');
  for (const event of f.events) assert.doesNotMatch(event, new RegExp(MARK), 'raw exception text reached an event sink');
  for (const frame of f.bus) assert.doesNotMatch(frame, new RegExp(MARK), 'raw exception text reached a bus frame');
  assert.ok(lines.some((line) => line.includes(MARK)), 'the local operator diagnostic keeps the raw error');
});

test('[S24 controls] normal refusals keep their status and code; a normal delivery still succeeds', async () => {
  const f = fixture(async () => ({ success: true, strategy: 'synthetic', submit: 'skipped' }));
  const missing = await f.call('absent', { prompt: 'x' });
  assert.deepEqual([missing.statusCode, missing.body.code], [404, 'SESSION_NOT_FOUND']);
  const invalid = await f.call('target', {});
  assert.deepEqual([invalid.statusCode, invalid.body.code], [400, 'INVALID_REQUEST']);
  const ok = await f.call('target', { prompt: 'synthetic prompt' });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.success, true);
  assert.equal(typeof ok.body.inject_id, 'string');
  assert.equal(ok.body.strategy, 'synthetic');
});

// #1215 format211 (security208 T3, javascript/FormatString): the local diagnostic must not let a session id act as a
// util.format directive. Register/WS admit '%' in ids (spawn ids do not). console.error is captured through the REAL
// node:util.format(...args), exactly as Node formats it; joining the arguments would hide the defect.
async function captureConsoleErrorFormatted(fn) {
  const { format } = require('node:util');
  const original = console.error;
  const lines = [];
  console.error = (...args) => { lines.push(format(...args)); };
  try { return { result: await fn(), lines }; } finally { console.error = original; }
}

test('[S24 T3] a percent-containing session id cannot consume the local diagnostic; response and event stay generic', async () => {
  const id = 't%c';
  const f = fixture(async () => { throw new Error('MARK-T3'); }, id);
  const { result: res, lines } = await captureConsoleErrorFormatted(() => f.call(id, { prompt: 'synthetic prompt' }));
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, 'DELIVERY_FAILED');
  const logLine = lines.find((line) => line.includes('[INJECT] delivery threw for')) || '';
  assert.ok(logLine.includes('MARK-T3'), 'MARK-T3 missing from the formatted local log');
  assert.ok(logLine.includes(`for ${id} inject_id=`), 'the literal session id is not preserved in the formatted local log');
  assert.doesNotMatch(JSON.stringify(res.body), /MARK-T3/, 'the thrown text reached the inject response');
  assert.equal(res.body.error, 'Delivery failed; see daemon log.');
  const failure = f.events.find((event) => event.includes('DELIVERY_FAILED'));
  assert.ok(failure, 'the inject_failed event is still emitted');
  assert.match(failure, /Delivery failed; see daemon log\./);
  for (const event of f.events) assert.doesNotMatch(event, /MARK-T3/, 'the thrown text reached an event sink');
  for (const frame of f.bus) assert.doesNotMatch(frame, /MARK-T3/, 'the thrown text reached a bus frame');
});
