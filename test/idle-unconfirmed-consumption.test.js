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
//   - suppression emits nothing (no TASK_COMPLETE) and does not consume the once-only
//     idleNotified guard.
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
// (a) quiet-thinking: no output, no spinner — but the inject echo IS in the ring
// ---------------------------------------------------------------------------

test('#52 (a): quiet-thinking — body echoed in post-inject frames → UNCONFIRMED suppressed', () => {
  const ctx = makeGate({
    preFrames: ['codex 0.99 — workspace ready\n› \n'],
    postFrames: [`│ › ${BODY} │\n`], // composer redraw with the injected text
  });
  ctx.fire();
  ctx.flushTimers(); // settle elapses: still idle-classified, output stalled (quiet thinking)
  assert.equal(ctx.delivered.length, 0, 'consumed inject must not raise an unconfirmed-delivery warning');
  assert.equal(ctx.broadcasts.length, 0, 'no TASK_IDLE_NO_REPORT bus event either');
  assert.equal(ctx.pendingReport.idleNotified, undefined, 'once-only guard not consumed — a later evidence-backed idle may still report');
});

test('#52 (a): suppression never emits TASK_COMPLETE (never-false-complete)', () => {
  const ctx = makeGate({ postFrames: [`› ${BODY}\n`] });
  ctx.fire();
  ctx.flushTimers();
  assert.equal(ctx.delivered.length, 0);
  assert.ok(!ctx.delivered.some((d) => /^TASK_COMPLETE:/.test(d.msg)));
});

test('#52 (a): echo survives composer line-wrapping and box borders', () => {
  // The TUI wraps the body across bordered composer lines — contiguous full-body
  // matching would fail; conservative window sampling must still observe the echo.
  const wrapAt = 60;
  const wrapped = `│ ${BODY.slice(0, wrapAt)}\n│ ${BODY.slice(wrapAt)}\n`;
  const ctx = makeGate({ postFrames: [wrapped] });
  ctx.fire();
  ctx.flushTimers();
  assert.equal(ctx.delivered.length, 0, 'wrapped echo still counts as consumption evidence');
});

test('#52 (a): screen-verified submit confirm (body_consumed) suppresses the #545-shape UNCONFIRMED', () => {
  // Live #52 shape: submit screen-verified as consumed, codex quiet-thinks, the
  // classifier flips real-idle with unreliable evidence. Pre-fix this notified
  // UNCONFIRMED; consumed + idle-looking is at most a TASK_IDLE fact — suppress.
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
  assert.equal(ctx.delivered.length, 0, 'screen-verified consumption gates the warning');
  assert.equal(ctx.pendingReport.idleNotified, undefined);
});

// ---------------------------------------------------------------------------
// (b) genuinely unconsumed: no echo + no CPU advance → the signal is preserved
// ---------------------------------------------------------------------------

test('#52 (b): no echo + no CPU advance → TASK_IDLE_UNCONFIRMED still fires (format intact)', () => {
  const ctx = makeGate({
    preFrames: ['some unrelated screen content\n'],
    postFrames: [], // the inject never echoed — nothing reached the TUI
    sampleChildCpu: cpuScript([42.0]), // CPU flat across arm/recheck
  });
  ctx.fire();
  ctx.flushTimers();
  assert.equal(ctx.delivered.length, 1, 'genuinely-unconsumed inject must notify');
  assert.match(
    ctx.delivered[0].msg,
    /^TASK_IDLE_UNCONFIRMED: worker-1 signaled idle \d+\.\ds after inject \(via ready-signal inject=inj-52\)/,
    'consumer-visible message format preserved'
  );
  assert.equal(ctx.pendingReport.idleNotified, true);
});

test('#52 (b): body below the conservative length floor never claims echo → still notifies', () => {
  const ctx = makeGate({
    pendingReportOverrides: { injectedBodyPreview: 'ACK status please' }, // < 24 normalized chars
    postFrames: ['› ACK status please\n'],
  });
  ctx.fire();
  ctx.flushTimers();
  assert.equal(ctx.delivered.length, 1, 'short bodies are too weak for echo evidence — signal preserved');
  assert.match(ctx.delivered[0].msg, /^TASK_IDLE_UNCONFIRMED:/);
});

test('#52 (b): identical re-inject — body already in PRE-inject frames, only redrawn after → still notifies', () => {
  // An alt-screen redraw of an EARLIER identical message lands in the post-inject
  // suffix; windows that pre-exist before the watermark are not fresh echo.
  const oldEcho = `│ › ${BODY} │\n`;
  const ctx = makeGate({
    preFrames: ['boot\n', oldEcho],
    postFrames: [oldEcho], // full-screen redraw of the OLD content after the new inject
  });
  ctx.fire();
  ctx.flushTimers();
  assert.equal(ctx.delivered.length, 1, 'a redraw of pre-existing identical text is not consumption evidence');
  assert.match(ctx.delivered[0].msg, /^TASK_IDLE_UNCONFIRMED:/);
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
  assert.equal(ctx.delivered.length, 1, 'stuck-composer inject was NOT consumed — signal preserved');
  assert.match(ctx.delivered[0].msg, /^TASK_IDLE_UNCONFIRMED:/);
});

test("#52 (b): a 'force' submit confirm is not screen-verified consumption — without echo it still notifies", () => {
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
  assert.equal(ctx.delivered.length, 1, 'force-confirm bypassed verification — not consumption evidence');
  assert.match(ctx.delivered[0].msg, /^TASK_IDLE_UNCONFIRMED:/);
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
  assert.equal(ctx.delivered.length, 0, 'CPU-active session is working — no notification');
  assert.equal(ctx.timers.length, 1, 'a fresh settle window is open');
  ctx.flushTimers(); // recheck 2: CPU flat → genuinely stalled → notify
  assert.equal(ctx.delivered.length, 1);
  assert.match(ctx.delivered[0].msg, /^TASK_IDLE_UNCONFIRMED:/);
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
  assert.equal(ctx.delivered.length, 1, 'bounded: eventually notifies even with CPU always advancing');
  assert.match(ctx.delivered[0].msg, /^TASK_IDLE_UNCONFIRMED:/);
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
