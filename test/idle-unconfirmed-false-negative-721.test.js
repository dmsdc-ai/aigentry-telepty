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
const { classifyReportPrompt } = require('../src/report-enforcement');

const T0 = 1_700_000_000_000;

const BODY =
  'TASK: implement the hold-and-redeliver fix, run the full suite, commit on top of the base, then REPORT back';

const TASK_COMPLETE_RE = /^TASK_COMPLETE: worker-1 is now idle after processing inject/;
const UNCONFIRMED_RE = /^TASK_IDLE_UNCONFIRMED: worker-1 signaled idle/;

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

test('#721 Repro 1 (root cause b): worker-launcher turn never records the durable consumption fact → cries wolf; should record + report TASK_COMPLETE', () => {
  const { pendingReport, transitions, idleState, idleTrigger } = driveWorkerLauncherTurn('1a');
  const edges = transitions.map((t) => `${t.from}->${t.to}(${t.trigger}) since_ms>=submit:${t.since_ms != null && t.submitStartedAt != null && t.since_ms >= new Date(t.submitStartedAt).getTime()}`).join(', ');

  // Trigger condition (a): the launcher idle flip carries no OSC133 → weak evidence. Passes now
  // and after the fix — it documents WHY the durable fact is the only thing that can rescue it.
  assert.equal(idleState, 'idle');
  assert.equal(idleTrigger, 'silence_timeout',
    `launcher idle flip must be evidence-unreliable (no OSC133); observed edges: ${edges}`);
  assert.equal(pendingReport.sawWorkingAfterInject, true, 'the launcher child provably worked after the inject');

  // RED (root cause b): a genuine turn fired, so the durable consumption fact MUST be recorded
  // across the real wiring. On main it is `undefined` — no transition was a qualifying
  // {idle|waiting}→{working|thinking} edge (the launcher never settles to idle first).
  assert.ok(pendingReport.injectConsumedAt,
    `injectConsumedAt must be recorded for a genuine worker-launcher turn, but the real wiring never reached maybeRecordInjectConsumption with a qualifying edge. Observed transitions: ${edges}`);

  // RED (consequence): with the fact recorded, the decayed late idle flip must report DONE, not
  // TASK_IDLE_UNCONFIRMED. Reuses the 806.9s decayed profile from the #619 cousin.
  const ctx = makeGate({ pendingReport, elapsedSec: 806.9, idleEvidenceReliable: false, postFrames: ['all 128 checks passed\n'] });
  ctx.fire('real-idle');
  ctx.flushTimers();
  assert.equal(ctx.delivered.length, 1, 'a verdict is emitted (not suppressed)');
  assert.match(ctx.delivered[0].msg, TASK_COMPLETE_RE,
    'a recorded consumption fact must promote the decayed launcher idle to TASK_COMPLETE; main cries wolf with TASK_IDLE_UNCONFIRMED');
});

// ===========================================================================
// Repro 2 — compounding cause (c) / #579: the clear-on-REPORT reverse-match misses a
// non-prefix REPORT payload, so the stale pending report survives and the honest idle cries
// wolf. Seam: daemon.js:3406-3448 reverse-match + classifyReportPrompt (src/report-enforcement.js:35).
// ===========================================================================

// Faithful transcription of the reverse-match clear decision (daemon.js:3410-3419), with
// resolveSessionAlias as identity (in-test aliases are literal). Mutates `pendingReports`.
// Returns whether the delivered inject cleared the sender's pending report.
function reverseMatchClear(pendingReports, fromSid, recipientSid, prompt) {
  const senderPending = pendingReports[fromSid];
  if (!senderPending) return false;
  if (senderPending.source !== recipientSid) return false;
  const classification = classifyReportPrompt(prompt); // daemon.js:3417 — the sole gate (the #579 hole)
  if (!classification) return false;
  delete pendingReports[fromSid]; // daemon.js:3419
  return true;
}

test('#721 Repro 2 (cause c/#579): a non-prefix (--ref/markdown) REPORT payload does NOT clear the pending report → later idle cries wolf; should clear', () => {
  const pendingReports = {
    'worker-1': {
      source: 'orch',
      submitExpected: true,
      submitStartedAt: new Date(T0 - 305_000).toISOString(),
      injectId: 'inj-721',
      injectedAt: new Date(T0 - 306_900).toISOString(),
      injectConsumedAt: undefined,
      idleNotified: false,
    },
  };

  // The worker pushes its REPORT to its pending source (orch) via `telepty inject --ref FILE`;
  // the delivered payload is the file contents, whose first line is a markdown title — NOT a
  // REPORT:-prefixed line (analyst §3, Repro 2).
  const refReportPayload = '# worker-1 report\n\nDONE | files: daemon.js | build: pass | remaining: none\n';

  // RED (the #579 hole, at the named seam): a delivered REPORT to the pending source must be
  // recognized as completion evidence. On main classifyReportPrompt returns null (no recognized
  // prefix), so the reverse-match never clears the entry.
  assert.ok(classifyReportPrompt(refReportPayload),
    'a delivered REPORT payload must be recognized as completion evidence — main misses non-prefix (--ref/markdown) REPORTs (#579)');

  const cleared = reverseMatchClear(pendingReports, 'worker-1', 'orch', refReportPayload);
  assert.ok(cleared, 'an outbound REPORT to the pending source must clear the sender pending report');
  assert.ok(!pendingReports['worker-1'],
    'the pending report must be cleared once the worker delivered its REPORT; on main it survives and the next honest idle cries wolf (see Repro 1 gate)');
});

test('#721 Repro 2 boundary (keep green): a prefixed `REPORT:` payload DOES clear the pending report', () => {
  const pendingReports = {
    'worker-1': { source: 'orch', submitExpected: true, injectId: 'inj-721', injectedAt: new Date(T0 - 100_000).toISOString() },
  };
  const prefixed = 'REPORT: [idle721] DONE | files: daemon.js | build: pass | remaining: none';
  assert.equal(classifyReportPrompt(prefixed), 'report_complete', 'the existing prefix path must keep classifying');
  const cleared = reverseMatchClear(pendingReports, 'worker-1', 'orch', prefixed);
  assert.ok(cleared, 'a prefix-shaped REPORT clears (guards against a fix that regresses the existing path)');
  assert.ok(!pendingReports['worker-1']);
});
