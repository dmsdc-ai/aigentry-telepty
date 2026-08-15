'use strict';

// #52: TASK_IDLE_UNCONFIRMED still false-positived on codex quiet-thinking AFTER the #48
// settle-and-recheck, because the recheck consults the same screen-state classifier that
// produced the false idle — a structurally unclosable window. The signal's semantic is
// "inject may NOT have been processed", so the fix gates the notification on inject-
// CONSUMPTION evidence the wrapper/daemon already owns, instead of screen idleness:
//
//   1. (semantic fix) The injected body observed echoed in frames appended AFTER the
//      inject (composer/transcript redraw in the PTY-fed outputRing), or a screen-verified
//      submit confirmation (body_consumed / state transition) → the inject WAS consumed —
//      suppress the unconfirmed-delivery warning no matter how idle the screen looks.
//   2. (auxiliary heuristic) At settle-recheck time, the wrapped child's CPU time advanced
//      while the screen stayed idle-classified → quiet thinking — re-settle instead of
//      notifying (own bound, separate from the output-advance rearm bound).
//
// never-false-complete is preserved conservatively:
//   - echo matching requires a sufficient-length normalized body and window samples that
//     do NOT pre-exist in the pre-inject ring (a redraw of an identical earlier message
//     is not fresh echo);
//   - a definitively failed submit (accepted:false — body stuck in the composer) can
//     never be overridden by echo;
//   - no branch can produce a completion claim.
//
// #60 Stage A changed HOW that evidence is expressed, not what counts as evidence: the
// suppression is deleted and every branch emits one observation carrying `consumption.basis`.
// See the stateOnce() helper below for why.
//
// Unit tests drive fireAutoReport() via its deps DI seam (same pattern as
// test/idle-unconfirmed-settle.test.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const daemon = require('../daemon');
const { fireAutoReport } = daemon;

const T0 = 1_700_000_000_000; // fixed clock origin

// A realistic inject body — long enough for conservative echo matching.
const BODY =
  'TASK: explore the worktree, read every spec under docs/, then prepare a one-page architecture summary for review';

// Build a DI context around fireAutoReport (extends the #48 makeGate shape with an
// outputRing-bearing session, the post-inject byte watermark, and a CPU sampler seam).
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
    injectId: 'inj-52',
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
  ctx.fire = (trigger = 'ready-signal') =>
    fireAutoReport('worker-1', ctx.session, ctx.pendingReport, trigger, ctx.deps);
  ctx.flushTimers = () => {
    const due = ctx.timers.splice(0);
    for (const { fn, ms } of due) { ctx.nowMs += ms; fn(); }
  };
  return ctx;
}

// A scripted CPU sampler: returns the next value on each call (arm samples and recheck
// samples alternate), repeating the last value when the script runs dry.
function cpuScript(values) {
  let i = 0;
  return () => (i < values.length ? values[i++] : values[values.length - 1]);
}

// ---------------------------------------------------------------------------
// #60 Stage A — the #52 consumption GATE is deleted; consumption is a FIELD
// ---------------------------------------------------------------------------
//
// #52 expressed its evidence as a SUPPRESSION: when the inject looked consumed, fireAutoReport
// took a bare `return` and emitted nothing at all. That was tolerable only while a separate
// `confirmed` path still spoke; with the terminal claims removed it would have become pure
// silence, and silence is the defect this release exists to remove — a consumer cannot tell
// "consumed, so nothing to warn about" from "the daemon died".
//
// So every branch below now emits exactly ONE observation, and the evidence discrimination this
// file was written to protect moves intact onto `consumption.basis`. That is strictly more
// information than before: seven distinguishable bases where there used to be a silent/loud bit.
//
// Note `status` stays 'not_established' throughout. 'observed' additionally requires a qualified
// fresh non-busy→busy edge recorded at transition time, which none of these fixtures produce —
// echo and a body-removal confirm are screen facts, not proof a turn started.
function stateOnce(ctx) {
  assert.equal(ctx.delivered.length, 1, 'exactly one observation is stated — never silence');
  assert.match(ctx.delivered[0].msg, /^TASK_COMPLETION_UNKNOWN: worker-1 inject=inj-52 /);
  assert.doesNotMatch(ctx.delivered[0].msg, /TASK_COMPLETE:|TASK_IDLE_UNCONFIRMED:/);
  assert.equal(ctx.delivered[0].srcId, 'orch');
  const ev = ctx.broadcasts.find((b) => b.type === 'task_completion_unknown');
  assert.ok(ev, 'the bus hears the absence too');
  assert.equal(ev.opts.extra.completion_fact, null);
  assert.equal(ev.opts.extra.terminal, false);
  // The retired once-only flag must not come back; dedup is ledger identity now.
  assert.equal('idleNotified' in ctx.pendingReport, false, 'the retired once-only flag is not resurrected');
  return ev.opts.extra.consumption;
}

// ---------------------------------------------------------------------------
// (a) quiet-thinking: no output, no spinner — but the inject echo IS in the ring
// ---------------------------------------------------------------------------

test('#52 (a): quiet-thinking — body echoed in post-inject frames → recorded as inject_echo_observed', () => {
  const ctx = makeGate({
    preFrames: ['codex 0.99 — workspace ready\n› \n'],
    postFrames: [`│ › ${BODY} │\n`], // composer redraw with the injected text
  });
  ctx.fire();
  ctx.flushTimers(); // settle elapses: still idle-classified, output stalled (quiet thinking)
  // OLD: asserted SILENCE — the gate returned without emitting. The echo detection itself is
  // unchanged and still fires; what changed is that it now NAMES itself instead of muting the
  // statement, so a consumer reading this observation learns strictly more than it used to.
  const consumption = stateOnce(ctx);
  assert.equal(consumption.basis, 'inject_echo_observed');
  assert.equal(consumption.status, 'not_established',
    'echo proves bytes reached the screen, never that a turn started — it was never consumption');
});

test('#52 (a): an echoed inject still never yields a completion claim (never-false-complete)', () => {
  const ctx = makeGate({ postFrames: [`› ${BODY}\n`] });
  ctx.fire();
  ctx.flushTimers();
  const consumption = stateOnce(ctx);
  assert.equal(consumption.basis, 'inject_echo_observed');
  // The original point of this test — the strongest available evidence must not manufacture a
  // completion — survives verbatim, and is now checked against a statement rather than silence.
  const ev = ctx.broadcasts.find((b) => b.type === 'task_completion_unknown');
  assert.equal(ev.opts.extra.capability.outcome_protocol, 'unavailable');
});

test('#52 (a): echo survives composer line-wrapping and box borders', () => {
  // The TUI wraps the body across bordered composer lines — contiguous full-body
  // matching would fail; conservative window sampling must still observe the echo.
  const wrapAt = 60;
  const wrapped = `│ ${BODY.slice(0, wrapAt)}\n│ ${BODY.slice(wrapAt)}\n`;
  const ctx = makeGate({ postFrames: [wrapped] });
  ctx.fire();
  ctx.flushTimers();
  assert.equal(stateOnce(ctx).basis, 'inject_echo_observed', 'wrapped echo is still observed');
});

test('#52 (a): screen-verified submit confirm (body_consumed) is named, and names its shortfall', () => {
  // Live #52 shape: submit screen-verified as consumed, codex quiet-thinks, the
  // classifier flips real-idle with unreliable evidence. Pre-fix this notified
  // UNCONFIRMED; #52 then suppressed it entirely.
  const ctx = makeGate({
    elapsedSec: 20,
    pendingReportOverrides: {
      submitExpected: true,
      submitConfirmedAt: new Date(T0 - 19_000).toISOString(),
      submitConfirm: { accepted: true, reason: 'body_consumed' },
      injectedBodyPreview: undefined, // evidence comes from the confirm, not echo
    },
    idleEvidenceReliable: false,
  });
  ctx.fire('real-idle');
  ctx.flushTimers();
  const consumption = stateOnce(ctx);
  assert.equal(consumption.basis, 'submit_body_removed_observed');
  assert.equal(consumption.submit_confirm_reason, 'body_consumed');
  // This is the sharpest gain over the old binary. `body_consumed` is a genuine screen-derived
  // confirmation, but on its own it still falls short of consumption, and the gap is now stated
  // rather than hidden behind a suppression that looked identical to real evidence.
  assert.equal(consumption.status, 'not_established');
  assert.equal(consumption.shortfall, 'no_qualifying_fresh_busy_edge');
});

// ---------------------------------------------------------------------------
// (b) genuinely unconsumed: no echo + no CPU advance → the signal is preserved
// ---------------------------------------------------------------------------

test('#52 (b): no echo + no CPU advance → no_consumption_evidence (format intact)', () => {
  const ctx = makeGate({
    preFrames: ['some unrelated screen content\n'],
    postFrames: [], // the inject never echoed — nothing reached the TUI
    sampleChildCpu: cpuScript([42.0]), // CPU flat across arm/recheck
  });
  ctx.fire();
  ctx.flushTimers();
  // The signal is preserved, and it is now the literal absence statement rather than a claim
  // that "the inject may NOT have been processed" — which was never measured either.
  const consumption = stateOnce(ctx);
  assert.equal(consumption.basis, 'no_consumption_evidence');
  assert.match(ctx.delivered[0].msg,
    /^TASK_COMPLETION_UNKNOWN: worker-1 inject=inj-52 — no completion fact observed; legacy_ready_observed(?:; elapsed_since_inject=\d+\.\ds)?; consumption=not_established; outcome protocol unavailable$/);
});

test('#52 (b): body below the conservative length floor never claims echo', () => {
  const ctx = makeGate({
    pendingReportOverrides: { injectedBodyPreview: 'ACK status please' }, // < 24 normalized chars
    postFrames: ['› ACK status please\n'],
  });
  ctx.fire();
  ctx.flushTimers();
  assert.equal(stateOnce(ctx).basis, 'no_consumption_evidence',
    'short bodies are too weak for echo evidence — the conservative floor still holds');
});

test('#52 (b): identical re-inject — body already in PRE-inject frames, only redrawn after', () => {
  // An alt-screen redraw of an EARLIER identical message lands in the post-inject
  // suffix; windows that pre-exist before the watermark are not fresh echo.
  const oldEcho = `│ › ${BODY} │\n`;
  const ctx = makeGate({
    preFrames: ['boot\n', oldEcho],
    postFrames: [oldEcho], // full-screen redraw of the OLD content after the new inject
  });
  ctx.fire();
  ctx.flushTimers();
  assert.equal(stateOnce(ctx).basis, 'no_consumption_evidence',
    'a redraw of pre-existing identical text is not fresh echo');
});

test('#52 (b): definitively failed submit (body stuck in composer) can never be echo-overridden', () => {
  const ctx = makeGate({
    pendingReportOverrides: {
      submitExpected: true,
      submitConfirm: { accepted: false, reason: 'body_still_visible', retryable: true },
    },
    postFrames: [`│ › ${BODY} │\n`], // echoed, but the CR never landed
  });
  ctx.fire('real-idle');
  ctx.flushTimers();
  const consumption = stateOnce(ctx);
  // Rejection PRECEDENCE, which is the load-bearing half of this test: the body IS echoed, so
  // the echo branch would have matched, but a positive submit rejection is evaluated first and
  // wins outright. Under the old binary both outcomes were just "notified" and the ordering was
  // untestable from here; now the basis names which rule fired.
  assert.equal(consumption.basis, 'submit_rejection_observed');
  assert.equal(consumption.submit_confirm_reason, 'body_still_visible');
});

test("#52 (b): a 'force' submit confirm is not screen-verified consumption", () => {
  const ctx = makeGate({
    elapsedSec: 20,
    pendingReportOverrides: {
      submitExpected: true,
      submitConfirmedAt: new Date(T0 - 19_000).toISOString(),
      submitConfirm: { accepted: true, reason: 'force' },
      injectedBodyPreview: undefined,
    },
    idleEvidenceReliable: false,
  });
  ctx.fire('real-idle');
  ctx.flushTimers();
  const consumption = stateOnce(ctx);
  // `accepted: true` is NOT sufficient — the whitelist is narrower than acceptance, and `force`
  // measured no screen at all. The recorded reason proves the confirm was seen and rejected as
  // evidence, rather than simply not being present.
  assert.equal(consumption.basis, 'no_consumption_evidence');
  assert.equal(consumption.submit_confirm_reason, 'force');
});

// ---------------------------------------------------------------------------
// (c) CPU-advance heuristic at settle-recheck: quiet thinking re-settles
// ---------------------------------------------------------------------------

test('#52 (c): screen idle + child CPU advancing at recheck → re-settles instead of notifying', () => {
  const ctx = makeGate({
    postFrames: [], // no echo observable (non-echoing TUI)
    sampleChildCpu: cpuScript([100.0, 100.5, 100.5, 100.5]), // arm, recheck(+0.5), re-arm, recheck(flat)
  });
  ctx.fire();
  ctx.flushTimers(); // recheck 1: CPU advanced → quiet thinking, re-settle
  assert.equal(ctx.delivered.length, 0, 'CPU-active session is working — the follow-up debounces');
  assert.equal(ctx.timers.length, 1, 'a fresh settle window is open');
  ctx.flushTimers(); // recheck 2: CPU flat → genuinely stalled → state it
  assert.equal(stateOnce(ctx).basis, 'no_consumption_evidence');
});

test('#52 (c): CPU re-settles are bounded — a perpetually-busy child cannot starve the signal forever', () => {
  let v = 0;
  const ctx = makeGate({
    postFrames: [],
    sampleChildCpu: () => { v += 1; return v; }, // always advancing
  });
  ctx.fire();
  let flushes = 0;
  while (ctx.delivered.length === 0 && flushes < 100) {
    assert.ok(ctx.timers.length > 0, `settle chain must stay alive or notify (flush ${flushes})`);
    ctx.flushTimers();
    flushes++;
  }
  assert.equal(ctx.delivered.length, 1, 'bounded: eventually states it even with CPU always advancing');
  assert.equal(stateOnce(ctx).basis, 'no_consumption_evidence');
  assert.ok(flushes >= 5, 'the CPU bound is meaningfully larger than a single settle');
});

test('#52 (c): no PID / sampler unavailable → CPU heuristic silently skips (prior behavior)', () => {
  const ctx = makeGate({
    postFrames: [],
    sampleChildCpu: () => null,
  });
  ctx.fire();
  ctx.flushTimers();
  assert.equal(ctx.delivered.length, 1, 'falls back to the #48 behavior when CPU is unobservable');
});

// ---------------------------------------------------------------------------
// src/child-cpu.js — platform sampler (pure parse + DI exec)
// ---------------------------------------------------------------------------

test('#52 child-cpu: parsePsTimeSeconds handles macOS, Linux and day-form ps TIME values', () => {
  const { parsePsTimeSeconds } = require('../src/child-cpu');
  assert.equal(parsePsTimeSeconds('0:01.23'), 1.23);      // macOS MM:SS.cc
  assert.equal(parsePsTimeSeconds('2:05.40'), 125.4);     // macOS MM:SS.cc
  assert.equal(parsePsTimeSeconds('00:00:05'), 5);        // Linux HH:MM:SS
  assert.equal(parsePsTimeSeconds('1-02:03:04'), 93784);  // DD-HH:MM:SS
  assert.equal(parsePsTimeSeconds(''), null);
  assert.equal(parsePsTimeSeconds('garbage'), null);
});

test('#52 child-cpu: sampleChildCpuSeconds skips win32 and bad pids, parses DI exec output', () => {
  const { sampleChildCpuSeconds } = require('../src/child-cpu');
  assert.equal(sampleChildCpuSeconds(null), null);
  assert.equal(sampleChildCpuSeconds(0), null);
  assert.equal(sampleChildCpuSeconds(1234, { platform: 'win32' }), null);
  assert.equal(
    sampleChildCpuSeconds(1234, { platform: 'darwin', execFileSync: () => '0:02.50\n' }),
    2.5
  );
  assert.equal(
    sampleChildCpuSeconds(1234, { platform: 'linux', execFileSync: () => { throw new Error('no such pid'); } }),
    null
  );
});
