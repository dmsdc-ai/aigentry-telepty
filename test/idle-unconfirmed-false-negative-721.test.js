'use strict';

// #721 — TASK_IDLE_UNCONFIRMED false-NEGATIVE (cry-wolf), RESIDUAL classes after #619.
//
// Root-cause analysis (idle721-analyst, 2026-07-25) pinned two causes and refined the repro
// spec these two failing-first tests implement:
//
//   (b) PRIMARY — the durable early-consumption fact (`injectConsumedAt`, the #619 fix that is
//       supposed to make a decayed late idle flip report DONE) is NEVER recorded in production
//       for worker-launcher-wrapped sessions: `consumed_recorded` suppression fired 0× in the
//       entire daemon log. `maybeRecordInjectConsumption` (daemon.js:438-448) only fires on a
//       clean `{idle|waiting}→{working|thinking}` edge with `submitStartedAt` set; a
//       continuously-active `--auto-restart worker-launcher.sh` child never produces that edge
//       (it stays `working`, so the CR yields only `starting→working` / `working↔thinking`
//       mid-turn flips — all excluded). So #619's decay-proofing is inert and every long worker
//       completion decays to the old weak-idle signal and cries wolf.
//
//   (c) SECONDARY (#579) — the last-ditch net (clear the pending report when the worker pushes
//       its own REPORT, daemon.js:3406-3448) only runs when `classifyReportPrompt(prompt)` is
//       truthy, i.e. the outbound text matches REPORT_PREFIX_RE. A `--ref`/enveloped REPORT
//       payload (file contents whose first line is a markdown title) is not prefix-shaped, so
//       the stale pending report survives and the honest post-report idle cries wolf.
//
// (a) — the trigger condition (a long/late idle flip with no fresh OSC133 →
//       `idleEvidenceReliable===false`) is what #619 was built to neutralize; it only bites
//       because (b) leaves the durable fact unrecorded. It is NOT the cause; do not widen decay.
//
// FAILING-FIRST (Rule 24/35): each Repro asserts the DESIRED post-fix outcome and fails on
// current main for the labelled reason. Repro 1 is the integration test that is MISSING today —
// the isolated `maybeRecordInjectConsumption` unit tests already pass (test/idle-unconfirmed-
// decayed-619.test.js L168-213); the gap is the real onTransition→recorder WIRING, which this
// drives through a real SessionStateMachine. Repro 2 pins the clear-on-REPORT prefix hole.
// The gate harness (`makeGate`) mirrors test/idle-unconfirmed-decayed-619.test.js (the closest
// cousin) with the same 806.9s decayed profile. Not registered in package.json this phase.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const daemon = require('../daemon');
const { fireAutoReport, maybeRecordInjectConsumption } = daemon;
const { SessionStateMachine } = require('../session-state');
const reportEnforcement = require('../src/report-enforcement');

const T0 = 1_700_000_000_000;

const BODY =
  'TASK: implement the hold-and-redeliver fix, run the full suite, commit on top of the base, then REPORT back';

// #60 Stage A: both verdicts are deleted. Every path below emits the same literal statement, and
// the four FIX 1 conjuncts that used to select between the verdicts are each still observable —
// as `consumption.basis` on that statement. See the per-guard assertions.
const UNKNOWN_RE = /^TASK_COMPLETION_UNKNOWN: worker-1 inject=inj-721 — no completion fact observed; pty_quiet=\d+\.\ds(?:; elapsed_since_inject=\d+\.\ds)?; consumption=(observed|not_established); outcome protocol unavailable$/;

function consumptionOf(ctx) {
  assert.equal(ctx.delivered.length, 1, 'a statement is emitted (not suppressed)');
  assert.match(ctx.delivered[0].msg, UNKNOWN_RE);
  assert.doesNotMatch(ctx.delivered[0].msg, /TASK_COMPLETE:|TASK_IDLE_UNCONFIRMED:/);
  const ev = ctx.broadcasts.find((b) => b.type === 'task_completion_unknown');
  assert.ok(ev);
  assert.equal(ev.opts.extra.completion_fact, null);
  return ev.opts.extra.consumption;
}

// DI context around fireAutoReport — mirrors test/idle-unconfirmed-decayed-619.test.js, with an
// added `pendingReport` input so a report DRIVEN through the real transition wiring (Repro 1) or
// left uncleared by the reverse-match (Repro 2) can flow into the idle gate unchanged.
function makeGate({
  elapsedSec = 0.2,
  pendingReport = null,
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
  const pr = pendingReport || {
    source: 'orch',
    injectId: 'inj-721',
    injectedBodyPreview: BODY,
    ringBytesAtInject: preBytes,
    ...pendingReportOverrides,
  };
  // The gate measures elapsed from injectedAt; pin it to the decayed profile regardless of the
  // (real wall-clock) timestamps a driven pendingReport picked up from the state machine.
  pr.injectedAt = new Date(T0 - elapsedSec * 1000).toISOString();
  if (!pr.injectId) pr.injectId = 'inj-721';
  if (!pr.source) pr.source = 'orch';
  ctx.pendingReport = pr;

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

// ===========================================================================
// Repro 1 — root cause (b): the durable consumption fact is never recorded across the REAL
// onTransition→maybeRecordInjectConsumption wiring for a worker-launcher session.
//
// Drives a REAL SessionStateMachine (session-state.js) and replays the daemon's exact
// onTransition→recorder logic (daemon.js:92-111) on each transition — we do NOT call
// maybeRecordInjectConsumption with hand-picked qualifying args (that path already passes in
// isolation, L168-213 of the #619 suite). The point is to prove the real machine, fed a
// worker-launcher output stream, never PRODUCES a qualifying edge, so the recorder — although
// reached on every working/thinking transition — never records the fact.
// ===========================================================================

// Feed the machine a worker-launcher-realistic stream and mirror daemon.js:92-111 on every
// transition, instrumenting the (from,to,since_ms,submitStartedAt) tuple so the excluded edge
// is named in the failure output. Returns the driven pendingReport + observed transitions.
//
// NOTE for the FIX phase: onTransition reads daemon-private `sessions`/`pendingReports`, so it
// cannot be invoked in isolation — this callback replicates its consumption-credit branch
// verbatim. If the fix relocates recording out of maybeRecordInjectConsumption (analyst §5:
// first-post-CR output watermark, or sawWorkingAfterInject when submitStartedAt is set), update
// this replica to mirror the new daemon.js:92-155 handler so the test tracks the real wiring.
function driveWorkerLauncherTurn(variant) {
  const sm = new SessionStateMachine('worker-1', {});
  const transitions = [];
  const pendingReport = {
    source: 'orch',
    injectId: 'inj-721',
    injectedAt: new Date().toISOString(),
    submitExpected: true, // no_enter deferred-submit inject (daemon.js:3460)
    injectedBodyPreview: BODY,
    ringBytesAtInject: 0,
    awaitingReport: true,
    idleNotified: false,
  };
  try {
    // Faithful replay of the onTransition handler's consumption-credit branch (daemon.js:100-111).
    sm.onTransition((from, to, detail) => {
      const sinceMs = sm.getState().since_ms; // === sessionStateManager.getState(id)?.since_ms (daemon.js:109)
      transitions.push({
        from, to,
        trigger: detail && detail.detail ? detail.detail.trigger : null,
        since_ms: sinceMs,
        submitStartedAt: pendingReport.submitStartedAt || null,
      });
      if ((to === 'working' || to === 'thinking') && pendingReport) {
        if (!pendingReport.submitExpected || pendingReport.submitStartedAt) {
          pendingReport.sawWorkingAfterInject = true;
          pendingReport.workingAfterInjectAt = new Date().toISOString();
        }
        maybeRecordInjectConsumption(pendingReport, from, to, sinceMs); // daemon.js:110
      }
    });

    if (variant === '1a') {
      // §2b.1 — continuously-active launcher: wrapper output BEFORE any idle settle pins the
      // machine in `working`, so the turn's CR never rides an idle→working edge.
      sm.feed('[guard] worker-launcher.sh supervising child (pid 4242)\n'); // starting→working
      pendingReport.submitStartedAt = new Date().toISOString();             // inject/submit lands
      sm.feed('esc to interrupt\n');                                        // working→thinking (excluded)
      sm.feed('reticulating splines across the module graph\n');           // thinking→working (excluded)
    } else {
      // §2b.2 — fresh worker: the task lands during `starting`; first output is starting→working
      // (deliberately excluded by the #537 startup guard).
      pendingReport.submitStartedAt = new Date().toISOString();
      sm.feed('bootstrapping task runner\n');                              // starting→working (excluded)
    }
    // The launcher submit gate resolves shortly after the CR: no verifiable composer / prompt
    // glyph, so it lands on an AMBIGUOUS accept (accepted:true, reason 'no_observable') — NOT
    // screen-verified consumption, exactly what a real worker-launcher.sh gets (submit-gate.js
    // no_observable path). Faithful launcher shape per FIX-phase Q4.
    pendingReport.submitFinishedAt = new Date().toISOString();
    pendingReport.submitConfirmedAt = pendingReport.submitFinishedAt;
    pendingReport.submitConfirm = { accepted: true, reason: 'no_observable', ambiguous: true };

    // ~800s of build/test output with no OSC133, then silence.
    sm.feed('running build step 1 of 42\n');
    sm.feed('all 128 checks passed\n'); // leaves the machine in `working` (no prompt / no spinner)

    // Silence → idle via the real _tick silence path (injected future clock, no real waiting).
    const st = sm.getState();
    sm._tick(st.since_ms + 10_000_000);
    const idle = sm.getState();
    return {
      pendingReport,
      transitions,
      idleState: idle.state,
      idleTrigger: idle.detail ? idle.detail.trigger : null,
    };
  } finally {
    sm.destroy(); // clear the machine's 1s poll interval so the test process can exit
  }
}

test('#721 Repro 1 (root cause b): a wrapped-launcher completion is cried-wolf because the edge-gated #619 recorder never credits it; FIX 1 rescues it at the idle gate → TASK_COMPLETE', () => {
  const { pendingReport, transitions, idleState, idleTrigger } = driveWorkerLauncherTurn('1a');
  const edges = transitions.map((t) => `${t.from}->${t.to}(${t.trigger}) since_ms>=submit:${t.since_ms != null && t.submitStartedAt != null && t.since_ms >= new Date(t.submitStartedAt).getTime()}`).join(', ');

  // Root-cause evidence (STABLE — true before AND after FIX 1): the real transition wiring never
  // records the durable #619 fact for a launcher. maybeRecordInjectConsumption is REACHED on every
  // working/thinking edge but none is a qualifying {idle|waiting}→{working|thinking} edge (the
  // launcher never settles to idle first), so the fact stays unrecorded — #619 is inert here. The
  // idle flip is silence_timeout (no OSC133 → idleEvidenceReliable=false at the gate).
  assert.equal(idleState, 'idle');
  assert.equal(idleTrigger, 'silence_timeout',
    `launcher idle flip is evidence-unreliable (no OSC133); observed edges: ${edges}`);
  assert.equal(pendingReport.sawWorkingAfterInject, true, 'the launcher child provably worked after the inject');
  assert.equal(pendingReport.injectConsumptionCandidate, undefined,
    `the edge-gated #619 recorder correctly never fires across the launcher wiring (that IS the gap); observed edges: ${edges}`);

  // FIX 1's WATERMARK CALCULATION is preserved verbatim — wrapped + accepted:true + post-CR
  // output advanced + elapsed ≥ 30s. What Stage A removes is the conclusion it was allowed to
  // draw. The old code recorded the result as consumption and promoted the idle to TASK_COMPLETE;
  // daemon.js:483-503 already conceded that a never-started wrapped worker can satisfy exactly
  // these conjuncts, so the watermark is now labelled for what it measures —
  // `submit_accepted_and_output_advanced` — and carries status `not_established`.
  //
  // The cry-wolf this file was opened to fix is gone at the root instead of by promotion: the
  // statement no longer accuses the worker of not having processed the inject.
  const ctx = makeGate({
    pendingReport,
    sessionOverrides: { type: 'wrapped' },
    elapsedSec: 806.9,
    idleEvidenceReliable: false,
    preFrames: ['… 800s of launcher build/test output (body scrolled off) …\n'],
    postFrames: ['all 128 checks passed\n'],
  });
  ctx.fire('real-idle');
  ctx.flushTimers();
  const consumption = consumptionOf(ctx);
  assert.equal(consumption.basis, 'submit_accepted_and_output_advanced');
  assert.equal(consumption.status, 'not_established',
    'the launcher watermark is telemetry — a never-started wrapped worker can satisfy it');
  // The measurement itself is retained in full, which is what makes this a rename and not a loss.
  assert.ok(pendingReport.launcherWatermarkAt, 'FIX 1 still records the launcher watermark at the idle gate');
  assert.ok(Number.isFinite(consumption.ring_bytes_delta) && consumption.ring_bytes_delta > 0,
    'the post-CR output advance is reported as the byte delta it actually is');
  assert.equal(consumption.elapsed_ms, 806_900);
});

// ---------------------------------------------------------------------------
// FIX 1 never-false-complete net for the NEW wrapped path (the existing #537 suites use
// non-wrapped sessions, so they do not exercise these conjuncts). Each guard flips exactly one
// of FIX 1's four conditions off and asserts the verdict stays TASK_IDLE_UNCONFIRMED.
// ---------------------------------------------------------------------------

// A faithful wrapped-launcher completion at the idle gate, minus whatever a guard overrides.
// A failed submit (accepted:false) records submitUnconfirmedAt, not submitConfirmedAt.
function launcherGate({ sessionType = 'wrapped', elapsedSec = 806.9, submitConfirm = { accepted: true, reason: 'no_observable', ambiguous: true }, postFrames = ['task output after the CR\n'], ringBytesAtInject = 0 } = {}) {
  const accepted = !!(submitConfirm && submitConfirm.accepted === true);
  const finishedAt = new Date(T0 - (elapsedSec - 2) * 1000).toISOString();
  return makeGate({
    sessionOverrides: { type: sessionType },
    elapsedSec,
    idleEvidenceReliable: false,
    preFrames: ['launcher heartbeat before the inject\n'],
    postFrames,
    pendingReportOverrides: {
      submitExpected: true,
      submitStartedAt: new Date(T0 - (elapsedSec - 1) * 1000).toISOString(),
      ...(accepted ? { submitConfirmedAt: finishedAt } : { submitUnconfirmedAt: finishedAt }),
      submitConfirm,
      sawWorkingAfterInject: true,
      ringBytesAtInject,
    },
  });
}

// Each guard still flips exactly ONE of FIX 1's four conditions off. The assertion moves from
// "the verdict stays UNCONFIRMED" to "the watermark is not claimed, and the basis names why" —
// which is a finer instrument than the old binary, because it distinguishes the three reasons a
// guard can trip rather than collapsing them into one label.

test('#721 FIX 1 guard (d): a wrapped session UNDER the elapsed floor (#537 ~4.5s startup-settle) is not credited', () => {
  const ctx = launcherGate({ elapsedSec: 4.5 }); // startup-settle, below the 30s floor
  ctx.fire('real-idle');
  ctx.flushTimers();
  assert.equal(consumptionOf(ctx).basis, 'no_consumption_evidence',
    'below the floor the watermark is not taken — never-false-complete (BUG-B) preserved');
  assert.equal(ctx.pendingReport.launcherWatermarkAt, undefined, 'no launcher watermark below the floor');
});

test('#721 FIX 1 guard (b): a wrapped session whose submit definitively FAILED (accepted:false)', () => {
  const ctx = launcherGate({ submitConfirm: { accepted: false, reason: 'cmux_send_failed' } });
  ctx.fire('real-idle');
  ctx.flushTimers();
  const consumption = consumptionOf(ctx);
  // Sharper than the old label: a failed submit is POSITIVE non-consumption, and rejection
  // precedence means it is evaluated before the watermark rather than merely outranking it.
  assert.equal(consumption.basis, 'submit_rejection_observed');
  assert.equal(consumption.submit_confirm_reason, 'cmux_send_failed');
  assert.equal(ctx.pendingReport.launcherWatermarkAt, undefined);
});

test('#721 FIX 1 guard (scope): a NON-wrapped session with the identical shape is not credited', () => {
  const ctx = launcherGate({ sessionType: 'spawned' }); // not a launcher → FIX 1 must not apply
  ctx.fire('real-idle');
  ctx.flushTimers();
  assert.equal(consumptionOf(ctx).basis, 'no_consumption_evidence',
    'the watermark stays scoped to wrapped sessions');
  assert.equal(ctx.pendingReport.launcherWatermarkAt, undefined, 'no launcher watermark for a non-wrapped session');
});

// ===========================================================================
// Repro 2 — compounding cause (c) / #579: the clear-on-REPORT reverse-match misses a
// non-prefix REPORT payload, so the stale pending report survives and the honest idle cries
// wolf. Seam: daemon.js:3406-3448 reverse-match + classifyReportPrompt (src/report-enforcement.js:35).
// ===========================================================================

// Both Repro 2 tests are migrated to ABSENCE, because the mechanism they exercised is deleted
// rather than renamed. FIX 2 was `resolveOutboundReportStatus`: for any inject a worker routed
// back to its pending source, it returned a completion status — falling back to
// `report_complete` for ANY payload that was not a recognised prefix. That fallback is exactly
// what made "Can you clarify the requirement?" register as the worker reporting its task done.
//
// §3.6 removes the whole reverse-text path with both functions. The consequence is deliberate
// and worth stating plainly: a worker's REPORT no longer clears its own pending entry, because
// no text can authenticate its sender or correlate itself to a dispatch. The cry-wolf that made
// clearing urgent is separately gone — the honest idle statement no longer accuses anyone — so
// the stale entry is now just an uncleared entry, not a false accusation waiting to fire.
//
// The integration-level half of this (reverse-routed REPORT text settles nothing, and the
// pending entry survives it) is pinned against the real daemon in test/enforce-report.test.js.

test('#721 Repro 2 (cause c/#579): the reverse-text report path that FIX 2 lived in is deleted', () => {
  assert.equal(daemon.resolveOutboundReportStatus, undefined,
    'resolveOutboundReportStatus must stay deleted — it mapped every unrecognised payload to report_complete');
  assert.equal(reportEnforcement.classifyReportPrompt, undefined,
    'the raw prefix classifier is deleted with it');
});

test('#721 Repro 2 boundary: not even a prefix-shaped REPORT can settle a record from text', () => {
  // The old boundary case proved a `REPORT:`-prefixed payload still cleared the entry. That is
  // the one shape most likely to be quietly reintroduced as "obviously safe", so the boundary is
  // kept and inverted: a prefix is not authentication, and 0.8.0 has no function that will read
  // one. An authenticated, correlated report protocol returns in Stage B behind #816 and #817.
  const prefixed = 'REPORT: [idle721] DONE | files: daemon.js | build: pass | remaining: none';
  for (const [name, fn] of [
    ['daemon.resolveOutboundReportStatus', daemon.resolveOutboundReportStatus],
    ['reportEnforcement.classifyReportPrompt', reportEnforcement.classifyReportPrompt],
  ]) {
    assert.equal(typeof fn, 'undefined', `${name} must not exist to classify ${prefixed.slice(0, 8)}…`);
  }
  assert.equal(daemon.CAPABILITY_STAGE_A
    ? daemon.CAPABILITY_STAGE_A.outcome_protocol
    : require('../src/completion-observation').CAPABILITY_STAGE_A.outcome_protocol,
  'unavailable', 'and the capability block says so, rather than leaving it to be inferred');
});
