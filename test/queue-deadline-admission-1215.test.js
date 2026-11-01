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

// Task 1215 windows110 — DIAGNOSTIC ONLY (attribution of the opt-in TELEPTY_QUEUE_DIAGNOSTICS=1 fields; not a deadline
// contract, not a fix, not a native Windows root cause). Holder A releases to queued B while C waits behind both. B is
// admitted inside its bound, then its real FileMailbox.prototype.enqueue (wrapped only while armed for B's request, restored
// in cleanup) blocks the loop past C's deadline. C's continuation runs after B's synchronous claim→first-await span and is
// refused while B is still 'claimed' (the windows105 signature). Checks: C refused with nothing enqueued or written for it;
// barrier order kept; the single failed-request record attributes the block to B's claim→enqueue span, not enqueue→deliver.
const { FileMailbox } = require('../src/mailbox');
const QUEUE_DIAG_FIELDS = ['elapsed_ms', 'cpu_user_ms', 'cpu_system_ms', 'lock_acquired', 'lock_wait_ms', 'lock_pauses',
  'lock_pause_actual_ms', 'lock_pauses_over_2x', 'lock_eperm'];

test('#1215 diagnostic: the queue_timeout record attributes a blocking next-holder enqueue to its claim→enqueue span', async (t) => {
  const BOUND_MS = 1200, BLOCK_MS = BOUND_MS + 400, DIAG_PREFIX = '[telepty-diag] submit_barrier ';
  const priorFlag = process.env.TELEPTY_QUEUE_DIAGNOSTICS;
  process.env.TELEPTY_QUEUE_DIAGNOSTICS = '1'; // read once when the delivery context is created
  let fixture;
  try { fixture = fixtureWithBound(t, BOUND_MS); } finally {
    if (priorFlag === undefined) delete process.env.TELEPTY_QUEUE_DIAGNOSTICS; else process.env.TELEPTY_QUEUE_DIAGNOSTICS = priorFlag;
  }
  const realEnqueue = FileMailbox.prototype.enqueue, realConsoleError = console.error;
  const records = [];
  let armed = false, blocked = null, cEnqueued = 0;
  FileMailbox.prototype.enqueue = function enqueue(msg) {
    const label = typeof msg?.payload === 'string' ? unwrap(msg.payload) : null;
    if (label === 'WAITER-C') cEnqueued++;
    const ack = realEnqueue.call(this, msg);
    if (armed && label === 'WAITER-B') { armed = false; const begun = performance.now(); blockLoop(BLOCK_MS); blocked = performance.now() - begun; }
    return ack;
  };
  console.error = function (...args) {
    if (typeof args[0] === 'string' && args[0].startsWith(DIAG_PREFIX)) {
      try { records.push(JSON.parse(args[0].slice(DIAG_PREFIX.length))); } catch { records.push('unparsed'); }
    }
    return realConsoleError.apply(this, args);
  };
  t.after(() => { FileMailbox.prototype.enqueue = realEnqueue; console.error = realConsoleError; });

  const session = wrappedSession();
  const aReturned = await holder(fixture, 'diag-w110', session);
  armed = true;
  const bCalled = performance.now();
  const b = fixture.deliverInjectionToSession('diag-w110', session, 'WAITER-B', {});
  const c = fixture.deliverInjectionToSession('diag-w110', session, 'WAITER-C', {});
  assert.ok(BOUND_MS > SUBMIT_DELAY_MS + (bCalled - aReturned), 'PRECONDITION: the holder CR is due before B\'s deadline');
  const [bRes, cRes] = await Promise.all([b, c]);
  await sleep(SUBMIT_DELAY_MS + 300); // B's deferred CR (and any late write) lands before the wire is read
  assert.ok(blocked !== null && blocked > BOUND_MS + 100, `PRECONDITION: B's enqueue blocked the loop past C's deadline (${blocked})`);
  assert.equal(bRes.success, true, `PRECONDITION: B was admitted inside its bound: ${JSON.stringify({ code: bRes.code ?? null })}`);

  assert.equal(cRes.code, 'QUEUE_TIMEOUT', `C is refused: ${JSON.stringify({ success: cRes.success, code: cRes.code ?? null })}`);
  assert.equal(cRes.httpStatus, 503);
  assert.ok(cRes.queue_wait_ms > BOUND_MS, `C's measured wait crossed its bound (${cRes.queue_wait_ms})`);
  assert.equal(cEnqueued, 0, 'nothing was enqueued for the refused waiter');
  assert.deepEqual(session.written.map(unwrap), ['HOLDER-A', '\r', 'WAITER-B', '\r'], 'no late write for C; barrier order kept');

  assert.equal(records.length, 1, `failed-request-only: one record, for C's refusal: ${JSON.stringify(records)}`);
  const holderView = records[0].holder;
  assert.equal(records[0].category, 'queue_timeout');
  assert.ok(holderView && holderView.phase === 'claimed', `B still holds the barrier, no existing mark yet: ${JSON.stringify(holderView)}`);
  const { claim_to_enqueue: toEnqueue, enqueue_to_deliver: toDeliver, claim_to_refusal: toRefusal,
    deliver_to_refusal: deliverToRefusal } = holderView.queue_diag || {};
  for (const [name, span] of [['claim_to_enqueue', toEnqueue], ['enqueue_to_deliver', toDeliver],
    ['claim_to_refusal', toRefusal], ['deliver_to_refusal', deliverToRefusal]]) {
    assert.deepEqual(Object.keys(span || {}).sort(), [...QUEUE_DIAG_FIELDS].sort(), `${name}: fixed numeric fields only`);
    for (const field of QUEUE_DIAG_FIELDS) assert.ok(Number.isFinite(span[field]) && span[field] >= 0, `${name}.${field} = ${span[field]}`);
  }
  assert.ok(toEnqueue.elapsed_ms + 0.1 >= blocked, `the block is inside claim→enqueue (${toEnqueue.elapsed_ms} vs ${blocked})`);
  assert.ok(toDeliver.elapsed_ms < blocked, `enqueue→deliver does not contain the block (${toDeliver.elapsed_ms})`);
  assert.ok(toEnqueue.cpu_user_ms + toEnqueue.cpu_system_ms < toEnqueue.elapsed_ms, 'a sleeping block reads as wall time, not CPU');
  assert.ok(toEnqueue.lock_acquired >= 1, 'B\'s own enqueue lock acquisition is counted');
  assert.ok(toDeliver.lock_acquired >= 1, 'the tick\'s dequeue/fence lock acquisitions are counted');
  // windows113 R1: the refusal sample closes the claimed interval, including the deliverFn→send tail before B's first yield.
  assert.ok(toRefusal.elapsed_ms + 0.2 >= toEnqueue.elapsed_ms + toDeliver.elapsed_ms,
    `claim→refusal covers claim→enqueue→deliver (${toRefusal.elapsed_ms} vs ${toEnqueue.elapsed_ms} + ${toDeliver.elapsed_ms})`);
  assert.ok(deliverToRefusal.elapsed_ms < blocked, `deliver→refusal does not contain the block (${deliverToRefusal.elapsed_ms})`);
  for (const view of records[0].recent) {
    assert.ok(!view.queue_diag || !('claim_to_refusal' in view.queue_diag || 'deliver_to_refusal' in view.queue_diag),
      'released (recent) views carry no refusal spans');
  }
});

// Task 1215 windows113 R2 — DIAGNOSTIC CONTROL (runtime off-path): with TELEPTY_QUEUE_DIAGNOSTICS removed around fixture
// creation (so this holds even under Windows CI's inherited '1'), a C2-shaped refusal (bound 300 < CR 500) emits the
// unchanged G5 holder shape: no queue_diag key at all.
const G5_HOLDER_KEYS = ['submit_delay_ms', 'cr_ok', 'tick_outcome', 'tick_done_ms', 'text_settled_ms', 'cr_timer_fired_ms',
  'cr_write_done_ms', 'released_ms', 'cr_timer_late_ms', 'age_ms', 'phase'];

test('#1215 diagnostic control: with TELEPTY_QUEUE_DIAGNOSTICS unset the queue_timeout holder keeps the G5 shape', async (t) => {
  const BOUND_MS = 300, DIAG_PREFIX = '[telepty-diag] submit_barrier ';
  const priorFlag = process.env.TELEPTY_QUEUE_DIAGNOSTICS;
  delete process.env.TELEPTY_QUEUE_DIAGNOSTICS; // read once when the delivery context is created
  let fixture;
  try { fixture = fixtureWithBound(t, BOUND_MS); } finally {
    if (priorFlag !== undefined) process.env.TELEPTY_QUEUE_DIAGNOSTICS = priorFlag;
  }
  const realConsoleError = console.error;
  const records = [];
  console.error = function (...args) {
    if (typeof args[0] === 'string' && args[0].startsWith(DIAG_PREFIX)) {
      try { records.push(JSON.parse(args[0].slice(DIAG_PREFIX.length))); } catch { records.push('unparsed'); }
    }
    return realConsoleError.apply(this, args);
  };
  t.after(() => { console.error = realConsoleError; });

  const session = wrappedSession();
  const aReturned = await holder(fixture, 'diag-off', session);
  const bCalled = performance.now();
  assert.ok(bCalled - aReturned + BOUND_MS < SUBMIT_DELAY_MS, 'PRECONDITION: the waiter deadline is due before the holder CR');
  const b = await fixture.deliverInjectionToSession('diag-off', session, 'WAITER-B', {});
  assert.equal(b.code, 'QUEUE_TIMEOUT');
  assert.equal(b.httpStatus, 503);
  await sleep(SUBMIT_DELAY_MS + 300);
  assert.deepEqual(session.written.map(unwrap), ['HOLDER-A', '\r'], 'nothing written for the refused waiter');

  assert.equal(records.length, 1, `failed-request-only: one record: ${JSON.stringify(records)}`);
  const holderView = records[0].holder;
  assert.ok(holderView, 'the holder still holds the barrier at the refusal');
  assert.equal(Object.hasOwn(holderView, 'queue_diag'), false, `flag off: no queue_diag: ${JSON.stringify(holderView)}`);
  assert.deepEqual(Object.keys(holderView).sort(), [...G5_HOLDER_KEYS].sort(), 'flag off: exactly the G5 holder fields');
});
