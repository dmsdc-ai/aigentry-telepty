'use strict';

// #109 — follow-up to the #107 submit barrier in deliverInjectionToSession (daemon.js).
//
// (a) The barrier waits on the session OBJECT captured at route entry, then enqueues by ID and
//     writes the deferred CR to the captured object. Nothing re-checks that the id still names
//     that object once the wait is over. A session destroyed (or destroyed and recreated under
//     the same id) while an inject is queued behind the barrier gets: a 200 for text that went
//     to no live session, or the queued text routed into the REPLACEMENT session with no CR.
// (b) The wait is unbounded: K queued injects make the (K+1)th caller wait ≈ K × submitDelay
//     with no typed answer, so a burst caller hits its own client timeout while the text is
//     still delivered later.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

const { startTestDaemon, createSessionId, waitFor, HARNESS_OBSERVATION_MARGIN_MS } = require('../test-support/daemon-harness');

const QUEUE_BOUND_MS = 1200;

let harness;
before(async () => {
  harness = await startTestDaemon({ env: { TELEPTY_SUBMIT_QUEUE_TIMEOUT_MS: String(QUEUE_BOUND_MS) } });
});
after(async () => { if (harness) await harness.stop(); });

// #1215 correction7: helpers take the daemon fixture explicitly (default: the shared bounded-wait fixture), so one
// test can use its own daemon without swapping shared mutable state.
async function ownerSocket(sid, h = harness) {
  const frames = [];
  const ws = new WebSocket(
    `ws://${h.host}:${h.port}/api/sessions/${encodeURIComponent(sid)}`
    + `?owner=1&owner_pid=${process.pid}&command=test-wrap&token=${encodeURIComponent(h.authToken())}`,
    h.ownerAuth(sid));
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'inject') frames.push(msg.data);
    } catch { /* not a frame we record */ }
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return { ws, frames };
}

async function wrappedOwner(sid, h = harness) {
  const reg = await h.registerSession(sid, { command: 'test-wrap' });
  assert.ok([200, 201].includes(reg.status), `register -> ${reg.status}`);
  return ownerSocket(sid, h);
}

// Task 1215 harness133: `requestOptions` (default none) carries only an explicit harness observation budget; callers that
// pass nothing keep the 5000 ms harness default.
const inject = (sid, prompt, h = harness, requestOptions = {}) => h.request(`/api/sessions/${encodeURIComponent(sid)}/inject`, {
  method: 'POST', body: { prompt }, ...requestOptions
});
const destroy = (sid) => harness.request(`/api/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Measured on 5b3619e: B answered 200 (`strategy: mailbox`) for a session deleted while B waited.
test('#109(a): an inject queued behind the barrier when its session is destroyed answers SESSION_GONE, not 200', async (t) => {
  const sid = createSessionId('i109-gone');
  const { ws } = await wrappedOwner(sid);
  t.after(() => { try { ws.close(); } catch {} });

  const first = await inject(sid, 'first holds the barrier');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const queued = inject(sid, 'second queued behind it');
  await sleep(100);
  const del = await destroy(sid);
  assert.ok(del.status < 300, `delete -> ${del.status}`);

  const second = await queued;
  assert.equal(second.status, 410, `queued inject answered ${second.status}: ${JSON.stringify(second.body)}`);
  assert.equal(second.body.code, 'SESSION_GONE', JSON.stringify(second.body));
});

// Measured on 5b3619e: the replacement received ['second queued behind it'] — the old
// instance's queued text, with no CR, in a session that never asked for it.
test('#109(a): an inject queued across destroy+recreate under the same id never reaches the replacement', async (t) => {
  const sid = createSessionId('i109-recreate');
  const old = await wrappedOwner(sid);
  t.after(() => { try { old.ws.close(); } catch {} });

  const first = await inject(sid, 'first holds the barrier');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const queued = inject(sid, 'second queued behind it');
  await sleep(100);
  const del = await destroy(sid);
  assert.ok(del.status < 300, `delete -> ${del.status}`);
  const replacement = await wrappedOwner(sid);
  t.after(() => { try { replacement.ws.close(); } catch {} });

  const second = await queued;
  await sleep(1000); // past every submit delay that could still fire

  assert.deepEqual(replacement.frames, [],
    `the replacement session received bytes meant for its predecessor: ${JSON.stringify(replacement.frames)}`);
  assert.equal(second.status, 410, `queued inject answered ${second.status}: ${JSON.stringify(second.body)}`);
  assert.equal(second.body.code, 'SESSION_GONE', JSON.stringify(second.body));
});

// Measured on 5b3619e: with 6 concurrent injects the slowest caller waited ≈ 2.5 s
// (5 × 500 ms submit delay) — far past the configured bound — and every one answered 200.
test('#109(b): the barrier wait is bounded — late callers get QUEUE_TIMEOUT, and only 200s are delivered', async (t) => {
  const sid = createSessionId('i109-bound');
  const { ws, frames } = await wrappedOwner(sid);
  t.after(() => { try { ws.close(); } catch {} });

  // Task 1215 native39 (failure-only evidence): the daemon's own payload-free submit_barrier records emitted after this point.
  const DIAG_PREFIX = '[telepty-diag] submit_barrier ', diagFrom = harness.getLogs().stderr.length, t0 = Date.now();
  const prompts = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'];
  const timed = await Promise.all(prompts.map(async (p) => {
    const started = Date.now();
    const res = await inject(sid, p);
    return { p, res, elapsed: Date.now() - started, issued_ms: started - t0 };
  }));
  const slowest = Math.max(...timed.map((r) => r.elapsed));
  const delivered = timed.filter((r) => r.res.status === 200).map((r) => r.p);
  const refused = timed.filter((r) => r.res.status !== 200);

  // Let every deferred CR that is still owed land before reading the owner socket.
  await waitFor(() => frames.filter((f) => f === '\r').length >= delivered.length,
    { timeoutMs: 5000, description: 'a CR for every accepted inject' });
  await sleep(700);

  // Task 1215 queue239: the bound is judged on the daemon's own clock and records (boundedWaitVerdict, below), not on caller
  // latency. The original gate here was `slowest < QUEUE_BOUND_MS + 800` on the CALLER clock, which also counts HTTP accept,
  // pre-barrier work and daemon timer scheduling (Windows job 124879010996: 462-466 ms before barrier entry plus 408-409 ms
  // of timer lateness; every refusal typed). Caller latency stays recorded on every run as an observation, not a bound.
  const callers = timed.map((r) => ({ p: r.p, issued_ms: r.issued_ms, elapsed_ms: r.elapsed, status: r.res.status, code: (r.res.body && r.res.body.code) || null,
    queue_wait_ms: r.res.body && Number.isSafeInteger(r.res.body.queue_wait_ms) ? r.res.body.queue_wait_ms : null }));
  const records = harness.getLogs().stderr.slice(diagFrom).split(/\r?\n/).filter((line) => line.startsWith(DIAG_PREFIX))
    .map((line) => { try { return JSON.parse(line.slice(DIAG_PREFIX.length)); } catch { return 'unparsed'; } });
  t.diagnostic(`task1215 queue239 caller latency observation (not a product bound): ${JSON.stringify({ bound_ms: QUEUE_BOUND_MS, slowest_ms: slowest, callers })}`);
  const verdict = boundedWaitVerdict({ callers, records, boundMs: QUEUE_BOUND_MS });
  // Task 1215 native39: on failure the message carries each caller's issue offset, code and daemon-measured barrier wait plus
  // the daemon's submit_barrier lines (pre_barrier_in_delivery_ms, wait_rounds, holder phase marks).
  assert.ok(verdict.ok, `bounded-wait contract (bound ${QUEUE_BOUND_MS} ms): ${JSON.stringify(verdict.reasons)} | #1215 native39 evidence ${JSON.stringify({ callers, daemon: records.slice(-6) })}`);
  assert.ok(refused.length > 0, 'six back-to-back injects all fit inside the bound — the test proves nothing');
  for (const r of refused) {
    assert.equal(r.res.status, 503, JSON.stringify(r.res.body));
    assert.equal(r.res.body.code, 'QUEUE_TIMEOUT', JSON.stringify(r.res.body));
  }
  // Never silent: every accepted text arrived with its own CR, and no refused text arrived at all.
  assert.deepEqual(frames.filter((f) => f !== '\r').sort(), [...delivered].sort(), JSON.stringify(frames));
  for (let i = 0; i < frames.length; i += 2) assert.equal(frames[i + 1], '\r', JSON.stringify(frames));
});

// N5: accepted callers are served in arrival order. Staggered starts make arrival order known.
// #1215 correction7 timing: f3 waits behind TWO barrier holders. Each holder spans its text delivery, the 500 ms wrapped
// submit delay and its CR write, so f3's wait is >= 2 × 500 ms + the holders' text/timer overhead (measured on win32
// 3b2c44a: CR at 1072 ms, f2 text at 1305 ms, f3 refused after 1203 ms against 1200). Three serialized callers therefore
// cannot be asserted against the shared 1200 ms bound. That bound is covered by the bounded-wait test above, which keeps
// the shared fixture; this case uses its own daemon at the product default bound (session-delivery.js, 10000 ms).
const PRODUCT_QUEUE_BOUND_MS = 10000;
// Task 1215 harness133: a queued inject's product bound is the barrier wait (PRODUCT_QUEUE_BOUND_MS) plus the text wait
// MAILBOX_TEXT_WAIT_MS = 2 x DELIVERY_TIMEOUT_MS (session-delivery.js; daemon.js default 5000) = 20000 ms. This case's
// harness OBSERVATION budget is that plus the one named margin (not a product deadline; the other cases are unchanged).
const QUEUED_INJECT_BOUND_MS = PRODUCT_QUEUE_BOUND_MS + 2 * 5000;
test('#109(b): queued callers are delivered in arrival order, each text followed by its own CR', async (t) => {
  // Own fixture: no queue-bound override (an inherited one is removed: spawn drops undefined values). Stopped on any outcome.
  const own = await startTestDaemon({ env: { TELEPTY_SUBMIT_QUEUE_TIMEOUT_MS: undefined } });
  t.after(async () => { await own.stop(); });
  const sid = createSessionId('i109-fifo');
  const { ws, frames } = await wrappedOwner(sid, own);
  t.after(() => { try { ws.close(); } catch {} });

  // #879 diagnostics only: per-caller timing and owner-frame arrival times. Frame labels are restricted to the exact
  // test-owned prompts f1/f2/f3 and CR; anything else is recorded as 'other' with its numeric length only (never its body).
  // The recorded list is bounded; frames beyond the cap are counted in frames_omitted.
  const t0 = Date.now(), callers = [], frameTimes = [], FRAME_CAP = 16, OWNED = new Set(['f1', 'f2', 'f3']);
  let framesOmitted = 0;
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type !== 'inject') return;
      if (frameTimes.length >= FRAME_CAP) { framesOmitted++; return; }
      const label = msg.data === '\r' ? 'CR' : (typeof msg.data === 'string' && OWNED.has(msg.data) ? msg.data : 'other');
      frameTimes.push(label === 'other'
        ? { at_ms: Date.now() - t0, label, utf16_length: typeof msg.data === 'string' ? msg.data.length : null }
        : { at_ms: Date.now() - t0, label });
    } catch { /* not a frame */ }
  });
  // #1215 G5: the daemon's own bounded barrier record(s) for a refusal (fixed fields only), last DAEMON_DIAG_CAP lines emitted after this test began.
  const DAEMON_DIAG_CAP = 4, DAEMON_DIAG = '[telepty-diag] submit_barrier ', daemonDiagFrom = own.getLogs().stderr.length;
  const daemonDiag = () => own.getLogs().stderr.slice(daemonDiagFrom).split(/\r?\n/).filter((line) => line.startsWith(DAEMON_DIAG)).slice(-DAEMON_DIAG_CAP)
    .map((line) => { try { return JSON.parse(line.slice(DAEMON_DIAG.length)); } catch { return 'unparsed'; } });
  const diagnose = (stage) => t.diagnostic(`#879 diag ${stage} ${JSON.stringify({ queue_bound_ms: PRODUCT_QUEUE_BOUND_MS, callers, frames: frameTimes, frames_omitted: framesOmitted, daemon: daemonDiag() })}`);
  const pending = [];
  for (const p of ['f1', 'f2', 'f3']) {
    const issued = Date.now() - t0;
    pending.push(inject(sid, p, own, { timeoutMs: QUEUED_INJECT_BOUND_MS + HARNESS_OBSERVATION_MARGIN_MS }).then((r) => {
      callers.push({ p, issued_ms: issued, answered_ms: Date.now() - t0, status: r.status, code: (r.body && r.body.code) || null,
        // Task 1215 (#879 discriminator): the daemon-measured barrier wait of a refusal (pre-barrier = answered - issued - this).
        queue_wait_ms: r.body && Number.isSafeInteger(r.body.queue_wait_ms) ? r.body.queue_wait_ms : null });
      return r;
    }));
    await sleep(30);
  }
  const results = await Promise.all(pending);
  if (results.some((r) => r.status !== 200)) diagnose('fifo_results');
  for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body));
  await waitFor(() => frames.length >= 6, { timeoutMs: 3000, description: 'three texts and three CRs' })
    .catch((error) => { diagnose('fifo_frames'); throw error; });

  assert.deepEqual(frames, ['f1', '\r', 'f2', '\r', 'f3', '\r'], JSON.stringify(frames));
  // Non-vacuity on ONE clock (t0: caller issue times and owner-frame arrival times): f2 and f3 were issued before f1's
  // CR, so both had to wait behind the barrier, and f3's text arrived only after f2's CR. A sequence that never queued
  // (each caller arriving after the previous CR) cannot satisfy this.
  const issued = Object.fromEntries(callers.map((c) => [c.p, c.issued_ms]));
  const frameAt = (label, nth = 0) => (frameTimes.filter((f) => f.label === label)[nth] || {}).at_ms;
  const proof = JSON.stringify({ issued, frames: frameTimes });
  assert.ok(Number.isSafeInteger(issued.f2) && Number.isSafeInteger(issued.f3) && Number.isSafeInteger(frameAt('CR', 0)), proof);
  assert.ok(issued.f2 < frameAt('CR', 0) && issued.f3 < frameAt('CR', 0), `f2 and f3 must be issued before f1's CR: ${proof}`);
  assert.ok(frameAt('f3') > frameAt('CR', 1), `f3's text must follow f2's CR: ${proof}`);
});

// Review 1 B1, measured on aeb436b: a rename inside the submit delay left the owner with
// ['hello'] and no CR (inject_failed SESSION_GONE). A rename moves the SAME live instance —
// it received the text, so it must receive the CR.
test('#109: a rename inside the submit delay still delivers the CR to the same live instance', async (t) => {
  const sid = createSessionId('i109-rename');
  const newId = `${sid}-renamed`;
  const { ws, frames } = await wrappedOwner(sid);
  t.after(() => { try { ws.close(); } catch {} });

  const inj = await inject(sid, 'hello');
  assert.equal(inj.status, 200, JSON.stringify(inj.body));
  const ren = await harness.request(`/api/sessions/${encodeURIComponent(sid)}`, { method: 'PATCH', body: { new_id: newId } });
  assert.equal(ren.status, 200, JSON.stringify(ren.body));
  await sleep(1200);

  assert.deepEqual(frames, ['hello', '\r'], JSON.stringify(frames));
});

// Guard for the CR timer recheck: destroy (and recreate under the same id) inside the submit
// delay must not put a bare CR into the replacement, which never received this inject's text.
test('#109: a destroy+recreate inside the submit delay writes no CR to the replacement', async (t) => {
  const sid = createSessionId('i109-destroy-cr');
  const old = await wrappedOwner(sid);
  t.after(() => { try { old.ws.close(); } catch {} });

  const inj = await inject(sid, 'hello');
  assert.equal(inj.status, 200, JSON.stringify(inj.body));
  const del = await destroy(sid);
  assert.ok(del.status < 300, `delete -> ${del.status}`);
  const replacement = await wrappedOwner(sid);
  t.after(() => { try { replacement.ws.close(); } catch {} });
  await sleep(1200);

  assert.deepEqual(old.frames, ['hello'], JSON.stringify(old.frames));
  assert.deepEqual(replacement.frames, [], JSON.stringify(replacement.frames));
});

// ------------------------------------------------------------------------------------------------
// Task 1215 queue239 — the bounded-wait CONTRACT as src/mailbox/session-delivery.js states it (#109, queue80), judged on
// the daemon's own clock and records rather than on caller latency:
//   * every caller gets a typed answer: 200 (admitted) or 503 QUEUE_TIMEOUT carrying the daemon-measured barrier wait
//     (queue_wait_ms, whose clock starts at barrier entry);
//   * the bound is exercised: at least one caller is refused and at least one is admitted;
//   * each refusal is the daemon's own bounded-wait refusal: exactly one `[telepty-diag] submit_barrier` queue_timeout
//     record per refusal, with bound_ms equal to the configured bound and wait_rounds >= 1. Missing, extra or unparsed
//     evidence fails.
// Caller-observed latency (HTTP accept, pre-barrier work, timer scheduling on the daemon loop, response) is not part of
// that contract and no source or document promises a figure for it: it is RECORDED on every run, not gated. Admission
// after an expired deadline (P1), the deadline-first typed refusal that fails if the bound is not honoured (C2) and
// SESSION_GONE precedence (C3) stay deterministically covered by test/queue-deadline-admission-1215.test.js.
// ------------------------------------------------------------------------------------------------
function boundedWaitVerdict({ callers, records, boundMs }) {
  if (!Array.isArray(callers) || callers.length === 0 || !Array.isArray(records)) return { ok: false, reasons: ['evidence missing'] };
  const reasons = [];
  for (const c of callers) {
    if (c && c.status === 200) continue;
    if (!c || c.status !== 503 || c.code !== 'QUEUE_TIMEOUT') reasons.push(`${c && c.p}: untyped or unexpected answer ${c && c.status} ${c && c.code}`);
    else if (!Number.isSafeInteger(c.queue_wait_ms) || c.queue_wait_ms < 0) reasons.push(`${c.p}: refusal without a measured queue_wait_ms`);
  }
  const refused = callers.filter((c) => !c || c.status !== 200).length;
  if (refused === 0) reasons.push('no caller was refused: the bound was not exercised');
  if (refused === callers.length) reasons.push('no caller was admitted');
  if (records.length !== refused) reasons.push(`daemon queue_timeout records ${records.length} != refusals ${refused}`);
  for (const r of records) {
    const shaped = r !== null && typeof r === 'object' && r.category === 'queue_timeout' && r.bound_ms === boundMs
      && Number.isSafeInteger(r.wait_rounds) && r.wait_rounds >= 1 && Number.isSafeInteger(r.queue_wait_ms) && r.queue_wait_ms >= 0;
    if (!shaped) reasons.push(`daemon record is not a bounded-wait refusal: ${JSON.stringify(r !== null && typeof r === 'object'
      ? { category: r.category, bound_ms: r.bound_ms, wait_rounds: r.wait_rounds, queue_wait_ms: r.queue_wait_ms } : r)}`);
  }
  return { ok: reasons.length === 0, reasons };
}

// The exact evidence retained by Windows diagnostic run 41316988399 / job 124879010996 (main#68, TAP error of case 3):
// callers verbatim; the four daemon records reduced to the fields the verdict reads (values verbatim).
const MEASURED_124879010996 = Object.freeze({
  callers: [
    { p: 'q1', issued_ms: 0, elapsed_ms: 461, status: 200, code: null, queue_wait_ms: null },
    { p: 'q2', issued_ms: 1, elapsed_ms: 1182, status: 200, code: null, queue_wait_ms: null },
    { p: 'q3', issued_ms: 2, elapsed_ms: 2071, status: 503, code: 'QUEUE_TIMEOUT', queue_wait_ms: 1609 },
    { p: 'q4', issued_ms: 2, elapsed_ms: 2072, status: 503, code: 'QUEUE_TIMEOUT', queue_wait_ms: 1609 },
    { p: 'q5', issued_ms: 2, elapsed_ms: 2074, status: 503, code: 'QUEUE_TIMEOUT', queue_wait_ms: 1608 },
    { p: 'q6', issued_ms: 3, elapsed_ms: 2074, status: 503, code: 'QUEUE_TIMEOUT', queue_wait_ms: 1609 },
  ],
  records: [
    { category: 'queue_timeout', bound_ms: 1200, queue_wait_ms: 1609, pre_barrier_in_delivery_ms: 0, wait_rounds: 2 },
    { category: 'queue_timeout', bound_ms: 1200, queue_wait_ms: 1609, pre_barrier_in_delivery_ms: 0, wait_rounds: 2 },
    { category: 'queue_timeout', bound_ms: 1200, queue_wait_ms: 1608, pre_barrier_in_delivery_ms: 1, wait_rounds: 2 },
    { category: 'queue_timeout', bound_ms: 1200, queue_wait_ms: 1609, pre_barrier_in_delivery_ms: 0, wait_rounds: 2 },
  ],
});

test('[queue239 K1] the measured failing evidence: the original caller-latency gate rejects it, the bounded-wait contract accepts it, and the clocks differ by pre-barrier time plus timer lateness', () => {
  const m = MEASURED_124879010996;
  const slowest = Math.max(...m.callers.map((c) => c.elapsed_ms));
  const refused = m.callers.filter((c) => c.status !== 200);
  const observed = {
    original_gate: slowest < QUEUE_BOUND_MS + 800,               // the original #109(b) caller-side predicate
    candidate: boundedWaitVerdict({ callers: m.callers, records: m.records, boundMs: QUEUE_BOUND_MS }),
    caller_minus_queue_wait_ms: refused.map((c) => c.elapsed_ms - c.queue_wait_ms),
    refusal_lateness_ms: refused.map((c) => c.queue_wait_ms - QUEUE_BOUND_MS),
  };
  assert.deepEqual(observed, { original_gate: false, candidate: { ok: true, reasons: [] },
    caller_minus_queue_wait_ms: [462, 463, 466, 465], refusal_lateness_ms: [409, 409, 408, 409] }, JSON.stringify(observed));
});

test('[queue239 K2] the bounded-wait contract rejects untyped or unknown answers, unmeasured refusals, a bound that was not exercised and missing, extra, unparsed or foreign daemon evidence', () => {
  const m = MEASURED_124879010996;
  const verdict = (callers, records = m.records) => boundedWaitVerdict({ callers, records, boundMs: QUEUE_BOUND_MS }).ok;
  const patch = (i, fields) => m.callers.map((c, k) => (k === i ? { ...c, ...fields } : c));
  const admitAll = m.callers.map((c) => ({ ...c, status: 200, code: null, queue_wait_ms: null }));
  const refuseAll = m.callers.map((c) => ({ ...c, status: 503, code: 'QUEUE_TIMEOUT', queue_wait_ms: 1609 }));
  const observed = {
    measured: verdict(m.callers),
    untyped_503: verdict(patch(2, { code: null })),
    unknown_202: verdict(patch(2, { status: 202, code: null })),
    uncertain_504: verdict(patch(2, { status: 504, code: 'DELIVERY_UNCERTAIN' })),
    gone_410: verdict(patch(2, { status: 410, code: 'SESSION_GONE' })),
    unmeasured_refusal: verdict(patch(2, { queue_wait_ms: null })),
    no_refusal: verdict(admitAll, []),
    no_admission: verdict(refuseAll, [...m.records, m.records[0], m.records[0]]),
    record_missing: verdict(m.callers, m.records.slice(1)),
    record_extra: verdict(m.callers, [...m.records, m.records[0]]),
    record_unparsed: verdict(m.callers, [...m.records.slice(1), 'unparsed']),
    record_wrong_bound: verdict(m.callers, [{ ...m.records[0], bound_ms: 10000 }, ...m.records.slice(1)]),
    record_never_waited: verdict(m.callers, [{ ...m.records[0], wait_rounds: 0 }, ...m.records.slice(1)]),
    record_other_category: verdict(m.callers, [{ ...m.records[0], category: 'other' }, ...m.records.slice(1)]),
    evidence_absent: boundedWaitVerdict({ callers: [], records: [], boundMs: QUEUE_BOUND_MS }).ok,
    records_absent: boundedWaitVerdict({ callers: m.callers, records: null, boundMs: QUEUE_BOUND_MS }).ok,
  };
  assert.deepEqual(observed, { measured: true, untyped_503: false, unknown_202: false, uncertain_504: false, gone_410: false, unmeasured_refusal: false,
    no_refusal: false, no_admission: false, record_missing: false, record_extra: false, record_unparsed: false, record_wrong_bound: false,
    record_never_waited: false, record_other_category: false, evidence_absent: false, records_absent: false }, JSON.stringify(observed));
});
