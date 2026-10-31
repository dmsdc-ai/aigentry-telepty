'use strict';

// Task 1215 queue71 Track A — P1 (native64 ROOT-CAUSE secondary_product_finding_P1): the submit-queue bound
// (TELEPTY_SUBMIT_QUEUE_TIMEOUT_MS) is enforced only by TIMER ORDER, not at admission
// (src/mailbox/session-delivery.js, the `while (session.pendingSubmit)` barrier wait). When the holder's
// CR timer and a waiter's deadline timer are BOTH overdue, the earlier-due CR runs first, its release resolves
// the waiter's race to `false`, and the loop exits without comparing Date.now() with queueDeadline: an expired
// waiter is ADMITTED and its text is written.
//
// Deterministic, no invented seam: the real production delivery runtime + FileMailbox + DeliveryEngine through
// test-support/session-delivery-fixture.js, the documented TELEPTY_SUBMIT_QUEUE_TIMEOUT_MS knob, and a wrapped
// session whose owner WebSocket is the real delivery leg (shape of test/claude-modal-inject-760). The loop is
// blocked synchronously (Atomics.wait) past the waiter's deadline, which makes both timers overdue; Node drains
// microtasks after each timer callback, so the CR callback's synchronous wrapped write and releaseSubmit settle
// the waiter's race before the waiter's own timer callback runs.
//
// Source facts the causality relies on (b9541a0):
//   - the holder returns only after arming its CR timer (setTimeout(submitDelay=500)) — so the CR is due before
//     any later waiter's deadline whenever bound > 500 + (waiter call − holder return);
//   - before the barrier, a wrapped, ready, modal-free inject awaits only resolveModalGate, which returns null
//     without a macrotask — so one setImmediate after the call, the waiter is inside its barrier race with its
//     deadline timer armed, and queueEnteredAt ≤ the block start;
//   - writeDataToSession for a wrapped session is a synchronous ws.send inside an async function.
//
// RED on the supplied product: the expired waiter is admitted (success, its text reaches the owner socket).
// Controls (expected to hold on the supplied product AND after a correct fix):
//   C1 no block — a waiter well inside its bound is admitted after the holder's CR (the admission path works);
//   C2 deadline timer first (bound 300 < CR delay 500, no block) — the typed QUEUE_TIMEOUT refusal, nothing written;
//   C3 SESSION_GONE precedence — the same overdue ordering with the session gone answers 410 SESSION_GONE, never
//      QUEUE_TIMEOUT, and writes nothing.
// "PRECONDITION:" = setup invariant (a failure is INVALID, not product RED).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionDeliveryFixture } = require('../test-support/session-delivery-fixture');

const SUBMIT_DELAY_MS = 500; // wrapped submitDelay in src/mailbox/session-delivery.js
const unwrap = (d) => d.replace(/^\x1b\[200~/, '').replace(/\x1b\[201~$/, '');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const turn = () => new Promise((resolve) => setImmediate(resolve));
const blockLoop = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// A wrapped session as the daemon models one (test/claude-modal-inject-760.test.js): clear surface, bootstrap ready,
// the owner WebSocket is the delivery leg. `written` is exactly what reached the wire.
function wrappedSession() {
  const written = [];
  return {
    type: 'wrapped', command: 'claude', backend: 'pty', cmuxWorkspaceId: null,
    bootstrapReady: true, bootstrapReadyReason: 'owner_alive',
    outputRing: [''], outputRingTotalBytes: 0, bracketedPasteCapable: true,
    ownerWs: { readyState: 1, send: (msg) => { written.push(JSON.parse(msg).data); } },
    written,
  };
}
// The bound is read when the delivery context is created; restore the environment immediately after.
function fixtureWithBound(t, boundMs) {
  const prior = process.env.TELEPTY_SUBMIT_QUEUE_TIMEOUT_MS;
  process.env.TELEPTY_SUBMIT_QUEUE_TIMEOUT_MS = String(boundMs);
  let fixture;
  try { fixture = createSessionDeliveryFixture(); } finally {
    if (prior === undefined) delete process.env.TELEPTY_SUBMIT_QUEUE_TIMEOUT_MS; else process.env.TELEPTY_SUBMIT_QUEUE_TIMEOUT_MS = prior;
  }
  t.after(() => fixture.dispose());
  return fixture;
}
// Holder A owns the barrier: its text is written and its CR timer is armed when it returns.
async function holder(fixture, sid, session) {
  const a = await fixture.deliverInjectionToSession(sid, session, 'HOLDER-A', {});
  assert.equal(a.success, true, `PRECONDITION: the holder is delivered: ${JSON.stringify(a)}`);
  assert.equal(a.submit, 'deferred', 'PRECONDITION: the holder owes a CR (its timer is armed)');
  assert.deepEqual(session.written.map(unwrap), ['HOLDER-A'], 'PRECONDITION: only the holder text is on the wire');
  assert.ok(session.pendingSubmit, 'PRECONDITION: the holder holds the submit barrier');
  return performance.now();
}
const bText = (session) => session.written.map(unwrap).filter((d) => d === 'WAITER-B').length;

test('P1 RED: a waiter whose barrier deadline expired before admission is refused and nothing is written', async (t) => {
  const BOUND_MS = 1200;
  const fixture = fixtureWithBound(t, BOUND_MS);
  const session = wrappedSession();
  const aReturned = await holder(fixture, 'p1-red', session);
  const bCalled = performance.now();
  const waiter = fixture.deliverInjectionToSession('p1-red', session, 'WAITER-B', {});
  await turn(); // the waiter is now inside its barrier race (source fact above)
  assert.ok(BOUND_MS > SUBMIT_DELAY_MS + (bCalled - aReturned), 'PRECONDITION: the holder CR is due before the waiter deadline');
  const blockStart = performance.now();
  blockLoop(BOUND_MS + 400);
  const blocked = performance.now() - blockStart;
  assert.ok(blocked > BOUND_MS + 100, `PRECONDITION: both timers are overdue (blocked ${Math.round(blocked)} ms)`);
  const b = await waiter;
  await sleep(SUBMIT_DELAY_MS + 300); // any deferred CR of an admitted waiter lands before the wire is read
  // The waiter's deadline (queueEnteredAt + bound ≤ blockStart + bound) passed before it could be admitted.
  assert.equal(b.code, 'QUEUE_TIMEOUT', `an expired waiter must be refused at admission: ${JSON.stringify({ success: b.success, code: b.code ?? null })}`);
  assert.equal(b.httpStatus, 503);
  assert.equal(bText(session), 0, 'no write after queue expiry');
  assert.deepEqual(session.written.map(unwrap), ['HOLDER-A', '\r'], 'the holder text and its CR only');
});

test('P1 control C1: a waiter inside its bound is admitted after the holder CR (no block)', async (t) => {
  const BOUND_MS = 1200;
  const fixture = fixtureWithBound(t, BOUND_MS);
  const session = wrappedSession();
  await holder(fixture, 'p1-c1', session);
  const b = await fixture.deliverInjectionToSession('p1-c1', session, 'WAITER-B', {});
  assert.equal(b.success, true, `admitted within its bound: ${JSON.stringify({ code: b.code ?? null })}`);
  await sleep(SUBMIT_DELAY_MS + 300);
  assert.deepEqual(session.written.map(unwrap), ['HOLDER-A', '\r', 'WAITER-B', '\r'], 'barrier order: the waiter follows the holder CR');
});

test('P1 control C2: when the deadline timer runs first, the typed QUEUE_TIMEOUT refusal writes nothing', async (t) => {
  const BOUND_MS = 300; // < the 500 ms CR delay, so the waiter's own timer is due first
  const fixture = fixtureWithBound(t, BOUND_MS);
  const session = wrappedSession();
  const aReturned = await holder(fixture, 'p1-c2', session);
  const bCalled = performance.now();
  assert.ok(bCalled - aReturned + BOUND_MS < SUBMIT_DELAY_MS, 'PRECONDITION: the waiter deadline is due before the holder CR');
  const b = await fixture.deliverInjectionToSession('p1-c2', session, 'WAITER-B', {});
  assert.equal(b.code, 'QUEUE_TIMEOUT');
  assert.equal(b.httpStatus, 503);
  assert.ok(Number.isFinite(b.queue_wait_ms) && b.queue_wait_ms >= BOUND_MS - 2, `measured wait ${b.queue_wait_ms}`);
  await sleep(SUBMIT_DELAY_MS + 300);
  assert.equal(bText(session), 0, 'nothing written for the refused waiter');
  assert.deepEqual(session.written.map(unwrap), ['HOLDER-A', '\r']);
});

test('P1 control C3: SESSION_GONE keeps precedence over the expired deadline and nothing is written', async (t) => {
  const BOUND_MS = 1200;
  const fixture = fixtureWithBound(t, BOUND_MS);
  const session = wrappedSession();
  const aReturned = await holder(fixture, 'p1-c3', session);
  const bCalled = performance.now();
  const waiter = fixture.deliverInjectionToSession('p1-c3', session, 'WAITER-B', {});
  await turn();
  assert.ok(BOUND_MS > SUBMIT_DELAY_MS + (bCalled - aReturned), 'PRECONDITION: the holder CR is due before the waiter deadline');
  delete fixture.sessions['p1-c3']; // the instance is gone while the waiter is queued (as test/session-delivery-identity-unit)
  try {
    const blockStart = performance.now();
    blockLoop(BOUND_MS + 400);
    assert.ok(performance.now() - blockStart > BOUND_MS + 100, 'PRECONDITION: both timers are overdue');
    const b = await waiter;
    await sleep(SUBMIT_DELAY_MS + 300);
    assert.equal(b.code, 'SESSION_GONE', `a gone instance answers SESSION_GONE, not QUEUE_TIMEOUT: ${JSON.stringify({ code: b.code ?? null })}`);
    assert.equal(b.httpStatus, 410);
    assert.equal(bText(session), 0, 'no write into a gone instance');
    assert.deepEqual(session.written.map(unwrap), ['HOLDER-A'], 'the holder CR is withheld from a gone instance, too');
  } finally {
    // Task 1215 queue80 (teardown only, after every assertion): the fixture registered this record's SessionStateMachine
    // (a referenced setInterval, session-state.js) and dispose() unregisters only ids still in `sessions`. Re-listing the
    // record lets the unchanged dispose() release it — the one Timeout that kept run 41252716256 alive to its 60 s bound.
    fixture.sessions['p1-c3'] = session;
  }
});
