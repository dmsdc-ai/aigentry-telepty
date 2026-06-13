'use strict';

// #619 / telepty#54 — TASK_IDLE_UNCONFIRMED false-NEGATIVE (cry-wolf) on long-running
// Claude TUI completions. The DELIVERY-side fix #52/#545 gates the idle warning on
// CONSUMPTION evidence, but it re-derives that evidence from the outputRing/OSC133 marks
// AT IDLE-TIME. Consumption is an EARLY event (the inject's turn fires ~T+2s); on a long
// turn the gate evaluates it LATE (idle at T+800-1400s), by which time the injected body
// has scrolled off the ring and there is no fresh inject-correlated OSC133 mark →
// idleEvidenceReliable===false → idleEvidenceUnreliable → conservative UNCONFIRMED, even
// though the worker genuinely completed. EVERY long Claude worker got cried-wolf, defeating
// #52's own safety purpose.
//
// Root cause: consumption evidence is consumed-time data evaluated at idle-time from a
// decayed screen. Fix: persist the consumption as a DURABLE FACT at consumption-time
// (maybeRecordInjectConsumption, recorded on the genuine fresh-turn transition — the #615
// `consumed` signal), and have the idle-gate read the stored fact (decay-proof) instead of
// re-deriving it. never-false-complete preserved: the fact is recorded ONLY for a genuine
// non-busy→turn transition at/after the inject CR, so a never-consumed inject still UNCONFIRMED.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const daemon = require('../daemon');
const { fireAutoReport, maybeRecordInjectConsumption } = daemon;

const T0 = 1_700_000_000_000;

const BODY =
  'TASK: implement the hold-and-redeliver fix, run the full suite, commit on top of the base, then REPORT back';

// DI context around fireAutoReport — mirrors test/idle-unconfirmed-consumption.test.js.
function makeGate({
  elapsedSec = 0.2,
  pendingReportOverrides = {},
  sessionOverrides = {},
  autoState = 'idle',
  preFrames = [],
  postFrames = [],
  sampleChildCpu = null,
  idleEvidenceReliable,
} = {}) {
  const ring = [...preFrames, ...postFrames];
  const preBytes = preFrames.reduce((s, d) => s + d.length, 0);
  const totalBytes = ring.reduce((s, d) => s + d.length, 0);

  const ctx = {
    nowMs: T0,
    autoState,
    timers: [],
    delivered: [],
    broadcasts: [],
    session: {
      id: 'worker-1',
      lastActivityAt: new Date(T0 - 60_000).toISOString(),
      outputRing: ring,
      outputRingTotalBytes: totalBytes,
      ...sessionOverrides,
    },
  };
  ctx.pendingReport = {
    source: 'orch',
    injectId: 'inj-619',
    injectedAt: new Date(T0 - elapsedSec * 1000).toISOString(),
    injectedBodyPreview: BODY,
    ringBytesAtInject: preBytes,
    ...pendingReportOverrides,
  };
  ctx.deps = {
    now: () => ctx.nowMs,
    setTimeout: (fn, ms) => { ctx.timers.push({ fn, ms }); return ctx.timers.length; },
    broadcastSessionEvent: (type, sid, _s, opts) => ctx.broadcasts.push({ type, sid, opts }),
    resolveSessionAlias: (s) => s,
    sessions: { orch: { id: 'orch' }, 'worker-1': ctx.session },
    pendingReports: { 'worker-1': ctx.pendingReport },
    deliverInjectionToSession: (srcId, _s, msg) => ctx.delivered.push({ srcId, msg }),
    getAutoState: () => ctx.autoState,
  };
  if (sampleChildCpu) ctx.deps.sampleChildCpu = sampleChildCpu;
  if (idleEvidenceReliable !== undefined) ctx.deps.idleEvidenceReliable = idleEvidenceReliable;
  ctx.fire = (trigger = 'real-idle') =>
    fireAutoReport('worker-1', ctx.session, ctx.pendingReport, trigger, ctx.deps);
  ctx.flushTimers = () => {
    const due = ctx.timers.splice(0);
    for (const { fn, ms } of due) { ctx.nowMs += ms; fn(); }
  };
  return ctx;
}

// A long-completion pending report whose at-idle evidence has decayed: submit was confirmed
// early, but at idle the body scrolled off the ring (no post-inject echo) and the idle flip
// carried no fresh OSC133 mark (idleEvidenceReliable=false).
function decayedLongCompletion(extra = {}) {
  return {
    elapsedSec: 806.9,
    idleEvidenceReliable: false,
    preFrames: ['… 800s of build/test output that pushed the inject off the ring …\n'],
    postFrames: [], // body decayed out of the ring — no echo re-derivable at idle-time
    pendingReportOverrides: {
      submitExpected: true,
      submitStartedAt: new Date(T0 - 805_000).toISOString(),
      submitConfirmedAt: new Date(T0 - 804_000).toISOString(),
      // Ambiguous accept — a long turn's screen confirm is inconclusive, NOT body_consumed.
      submitConfirm: { accepted: true, reason: 'no_observable', ambiguous: true },
      ...extra,
    },
  };
}

// ---------------------------------------------------------------------------
// reproduce — the live false-negative: a genuine long completion is cried-wolf.
// ---------------------------------------------------------------------------

test('#619 reproduce: long completion with decayed at-idle evidence → TASK_IDLE_UNCONFIRMED (the bug)', () => {
  const ctx = makeGate(decayedLongCompletion());
  ctx.fire('real-idle');
  ctx.flushTimers(); // settle elapses: still idle, output stalled, no CPU → notify
  assert.equal(ctx.delivered.length, 1, 'pre-fix: the genuine completion is cried-wolf');
  assert.match(ctx.delivered[0].msg, /^TASK_IDLE_UNCONFIRMED: worker-1 signaled idle/);
});

// ---------------------------------------------------------------------------
// fix — a durable early-consumption fact makes the decayed at-idle evidence moot.
// ---------------------------------------------------------------------------

test('#619 fix: a recorded early consumption → TASK_COMPLETE, no false UNCONFIRMED', () => {
  const ctx = makeGate(decayedLongCompletion({
    // recorded at turn-start (~T+1s), long before idle — decay-proof.
    injectConsumedAt: new Date(T0 - 805_000).toISOString(),
    injectConsumedSinceMs: T0 - 805_000,
  }));
  ctx.fire('real-idle');
  ctx.flushTimers();
  assert.equal(ctx.delivered.length, 1);
  assert.match(
    ctx.delivered[0].msg,
    /^TASK_COMPLETE: worker-1 is now idle after processing inject/,
    'stored consumption fact promotes the decayed idle to a genuine completion'
  );
  assert.ok(
    !ctx.delivered.some((d) => /^TASK_IDLE_UNCONFIRMED:/.test(d.msg)),
    'no cry-wolf once consumption is a recorded fact'
  );
});

// ---------------------------------------------------------------------------
// invariant — never-false-complete: a genuinely UNCONSUMED long inject (no recorded
// fact, decayed screen, no echo) must STILL be UNCONFIRMED. The fix only flips
// genuinely-consumed-but-decayed cases.
// ---------------------------------------------------------------------------

test('#619 invariant: never-consumed inject (no recorded fact) stays UNCONFIRMED', () => {
  const ctx = makeGate(decayedLongCompletion()); // NO injectConsumedAt
  ctx.fire('real-idle');
  ctx.flushTimers();
  assert.equal(ctx.delivered.length, 1);
  assert.match(ctx.delivered[0].msg, /^TASK_IDLE_UNCONFIRMED:/, 'never-false-complete preserved');
});

// ---------------------------------------------------------------------------
// maybeRecordInjectConsumption — the capture seam. Records a durable fact ONLY for a
// genuine fresh-turn transition at/after the inject CR (the #615 `consumed` rule).
// ---------------------------------------------------------------------------

function freshReport(over = {}) {
  return { submitExpected: true, submitStartedAt: new Date(T0).toISOString(), ...over };
}

test('#619 capture: idle→working at/after the CR records the consumption fact', () => {
  const pr = freshReport();
  const recorded = maybeRecordInjectConsumption(pr, 'idle', 'working', T0 + 1500);
  assert.equal(recorded, true);
  assert.equal(pr.injectConsumedSinceMs, T0 + 1500);
  assert.ok(pr.injectConsumedAt);
});

test('#619 capture: waiting→thinking after the CR also records (interactive-prompt resume)', () => {
  const pr = freshReport();
  assert.equal(maybeRecordInjectConsumption(pr, 'waiting', 'thinking', T0 + 500), true);
});

test('#619 capture: a STARTUP flip (starting→working) is never a consumption (no false fact)', () => {
  const pr = freshReport();
  assert.equal(maybeRecordInjectConsumption(pr, 'starting', 'working', T0 + 1000), false);
  assert.equal(pr.injectConsumedAt, undefined);
});

test('#619 capture: a mid-turn sub-state flip (working→thinking) is not a fresh consumption', () => {
  const pr = freshReport();
  assert.equal(maybeRecordInjectConsumption(pr, 'working', 'thinking', T0 + 1000), false);
});

test('#619 capture: a turn that started BEFORE the CR (busy-park) is never consumed', () => {
  const pr = freshReport();
  // since_ms < submitStartedAt → the turn predates our CR (the #617 queued case), not ours.
  assert.equal(maybeRecordInjectConsumption(pr, 'idle', 'working', T0 - 5000), false);
});

test('#619 capture: no submitStartedAt (non-submit inject) records nothing', () => {
  const pr = { submitExpected: true };
  assert.equal(maybeRecordInjectConsumption(pr, 'idle', 'working', T0 + 1000), false);
});

test('#619 capture: idempotent — an already-recorded fact is not overwritten', () => {
  const pr = freshReport({ injectConsumedAt: 'first', injectConsumedSinceMs: 111 });
  assert.equal(maybeRecordInjectConsumption(pr, 'idle', 'working', T0 + 9999), false);
  assert.equal(pr.injectConsumedAt, 'first');
  assert.equal(pr.injectConsumedSinceMs, 111);
});

test('#619 capture: a non-turn transition (idle→waiting) records nothing', () => {
  const pr = freshReport();
  assert.equal(maybeRecordInjectConsumption(pr, 'idle', 'waiting', T0 + 1000), false);
});
