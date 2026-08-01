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

// The consumption block on the single observation this path now emits. #60 Stage A deleted the
// suppress/notify gate, so what used to be a choice between two message LABELS is now one
// message plus a named `consumption` field. The cry-wolf this file exists to prevent is
// therefore gone by construction on the message side — the text accuses nobody of anything —
// and what remains testable, and worth testing, is whether the evidence is classified correctly.
function consumptionOf(ctx) {
  assert.equal(ctx.delivered.length, 1, 'exactly one observation is stated — never silence');
  assert.match(ctx.delivered[0].msg, /^TASK_COMPLETION_UNKNOWN: worker-1 inject=inj-619 /);
  assert.doesNotMatch(ctx.delivered[0].msg, /TASK_COMPLETE:|TASK_IDLE_UNCONFIRMED:/);
  const ev = ctx.broadcasts.find((b) => b.type === 'task_completion_unknown');
  assert.ok(ev);
  assert.equal(ev.opts.extra.completion_fact, null, 'no consumption evidence is ever a completion');
  return ev.opts.extra.consumption;
}

test('#619 reproduce: long completion with decayed at-idle evidence no longer cries wolf', () => {
  const ctx = makeGate(decayedLongCompletion());
  ctx.fire('real-idle');
  ctx.flushTimers(); // settle elapses: still idle, output stalled, no CPU → state it
  // The bug was the ACCUSATION: `TASK_IDLE_UNCONFIRMED: ... inject may NOT have been processed;
  // verify before treating as done` on a worker that had in fact finished. That sentence is
  // deleted, because "may not have been processed" was never a measurement either. The honest
  // statement that replaces it reports what was actually seen: quiet, and no consumption
  // evidence still derivable from a screen that decayed 800 seconds ago.
  const consumption = consumptionOf(ctx);
  assert.equal(consumption.basis, 'no_consumption_evidence');
  assert.match(ctx.delivered[0].msg, /pty_quiet=8\d\d\.\ds/);
});

// ---------------------------------------------------------------------------
// fix — a durable early-consumption candidate makes the decayed at-idle evidence moot.
// ---------------------------------------------------------------------------

test('#619 fix: an early-recorded fresh-turn candidate survives 800s of decay', () => {
  const ctx = makeGate(decayedLongCompletion({
    // Captured at turn-start (~T-805s), long before idle — this is the decay-proof half.
    injectConsumptionCandidate: {
      from: 'idle', to: 'working',
      sinceMs: T0 - 805_000, at: new Date(T0 - 805_000).toISOString(),
    },
    // ...and the screen-derived confirmation from that same early moment. Stage A requires BOTH
    // conjuncts: the edge alone is not consumption (see the invariant below). `state_working` is
    // produced by the very transition being judged, which is why the predicate is evaluated here
    // at classification time rather than at the edge.
    submitConfirm: { accepted: true, reason: 'state_working', ambiguous: false },
  }));
  ctx.fire('real-idle');
  ctx.flushTimers();
  // The #619 win, restated: consumption is established at idle-time from a fact recorded ~800s
  // earlier, with no dependence on a ring or an OSC mark that has since scrolled away.
  const consumption = consumptionOf(ctx);
  assert.equal(consumption.status, 'observed');
  assert.equal(consumption.basis, 'fresh_busy_transition');
  assert.equal(consumption.transition_from, 'idle');
  assert.equal(consumption.transition_to, 'working');
  assert.equal(consumption.submit_confirm_reason, 'state_working');
  assert.equal(consumption.evaluated_at, 'consumption_classification');
  assert.match(ctx.delivered[0].msg, /consumption=observed/);
  // Consumption established is still NOT a completion — the old test asserted this promoted to
  // TASK_COMPLETE, and that promotion is exactly what Stage A removes.
  assert.doesNotMatch(ctx.delivered[0].msg, /TASK_COMPLETE/);
});

// ---------------------------------------------------------------------------
// invariant — never-false-complete: consumption may not be established without BOTH
// conjuncts. Under the old code the durable fact alone flipped the verdict; the
// migrated invariant pins the stronger rule.
// ---------------------------------------------------------------------------

test('#619 invariant: a recorded candidate alone, with an ambiguous confirm, is not consumption', () => {
  const ctx = makeGate(decayedLongCompletion({
    // The fresh-turn edge IS recorded — the old code's sole condition for promoting.
    injectConsumptionCandidate: {
      from: 'idle', to: 'working',
      sinceMs: T0 - 805_000, at: new Date(T0 - 805_000).toISOString(),
    },
    // But the long turn's confirm is `no_observable`/ambiguous, which measured no screen. The
    // whitelist is narrower than `accepted === true` on purpose.
  }));
  ctx.fire('real-idle');
  ctx.flushTimers();
  const consumption = consumptionOf(ctx);
  assert.equal(consumption.status, 'not_established', 'never-false-complete preserved');
  assert.equal(consumption.basis, 'no_consumption_evidence');
  assert.equal(consumption.submit_confirm_reason, 'no_observable');
});

// ---------------------------------------------------------------------------
// maybeRecordInjectConsumption — the capture seam. Records a durable fact ONLY for a
// genuine fresh-turn transition at/after the inject CR (the #615 `consumed` rule).
// ---------------------------------------------------------------------------

function freshReport(over = {}) {
  return { submitExpected: true, submitStartedAt: new Date(T0).toISOString(), ...over };
}

test('#619 capture: idle→working at/after the CR records the consumption candidate', () => {
  const pr = freshReport();
  const recorded = maybeRecordInjectConsumption(pr, 'idle', 'working', T0 + 1500);
  assert.equal(recorded, true);
  // Renamed presence. The capture seam and its rules are unchanged; what it writes is now a
  // CANDIDATE edge rather than a settled `injectConsumedAt`, because the confirmation conjunct
  // does not exist yet at this instant — `state_working` is produced BY this transition.
  assert.equal(pr.injectConsumedAt, undefined, 'the edge no longer settles consumption by itself');
  assert.equal(pr.injectConsumptionCandidate.sinceMs, T0 + 1500);
  assert.equal(pr.injectConsumptionCandidate.from, 'idle');
  assert.equal(pr.injectConsumptionCandidate.to, 'working');
  assert.ok(pr.injectConsumptionCandidate.at);
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

test('#619 capture: idempotent — an already-recorded candidate is not overwritten', () => {
  const first = { from: 'idle', to: 'working', sinceMs: 111, at: 'first' };
  const pr = freshReport({ injectConsumptionCandidate: first });
  assert.equal(maybeRecordInjectConsumption(pr, 'idle', 'working', T0 + 9999), false);
  assert.deepEqual(pr.injectConsumptionCandidate, first, 'the FIRST fresh edge is the one that counts');
});

test('#619 capture: a non-turn transition (idle→waiting) records nothing', () => {
  const pr = freshReport();
  assert.equal(maybeRecordInjectConsumption(pr, 'idle', 'waiting', T0 + 1000), false);
});
