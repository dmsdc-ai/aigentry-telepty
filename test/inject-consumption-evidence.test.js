'use strict';

// #53 — inject 'delivered' != 'consumed'. The DELIVERY-side dual of #52: a bare
// `Submitted via pty_cr` only proves bytes reached the PTY master. A BUSY Claude Code TUI
// parks the CR'd text in its composer ("Press up to edit queued messages") and never starts
// a turn, yet the prior confirm read the busy recipient's mid-turn output as success
// (isAcceptedSubmitState's last_output_at leak). classifyInjectConsumption distinguishes:
//
//   consumed — non-busy start that produced a FRESH idle→working/thinking turn (since_ms ≥ CR).
//   queued   — body still parked on screen after a short settle (windowed echo, #52 technique);
//              a recipient already busy at the CR can ONLY ever land here, never `consumed`.
//   unknown  — neither positive signal (conservative; never-false-consumed).
//
// Pure helper, driven through its now/sleep/getState DI seams against an outputRing double.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classifyInjectConsumption } = require('../src/submit-gate');

// A realistic REPORT body — long enough for conservative windowed echo matching (≥ 48 chars).
const BODY = 'REPORT: 615-DONE | approach=consumption-evidence | files=3 | commit=abc1234 | tests pass';

// Scripted clock + sleep: sleep advances the clock and yields, so an async poll loop runs
// to completion in real time ~0ms while observing deterministic elapsed values.
function makeClock(startMs) {
  let clock = startMs;
  return {
    now: () => clock,
    sleep: (ms) => { clock += ms; return Promise.resolve(); },
  };
}

// An outputRing double mirroring the daemon's appendToOutputRing byte bookkeeping.
function makeSession({ preFrames = [], postFrames = [] } = {}) {
  const ring = [...preFrames, ...postFrames];
  const preBytes = preFrames.reduce((s, d) => s + d.length, 0);
  const totalBytes = ring.reduce((s, d) => s + d.length, 0);
  return { session: { outputRing: ring, outputRingTotalBytes: totalBytes }, sinceBytes: preBytes };
}

// ---------------------------------------------------------------------------
// (a) consumed — non-busy recipient began a fresh turn at/after the CR
// ---------------------------------------------------------------------------

test('#53 (a): non-busy recipient transitions to a fresh turn → consumed', async () => {
  const submittedAtMs = 1000;
  const clock = makeClock(submittedAtMs);
  const { session, sinceBytes } = makeSession({ preFrames: ['› ready\n'] });
  // The CR fired a turn: idle→working with since_ms ≥ the submit time.
  const getState = () => ({ state: 'working', since_ms: 1050 });

  const result = await classifyInjectConsumption(session, BODY, {
    submittedAtMs, sinceBytes, getState, ...clock, timeoutMs: 600, settleMs: 200,
  });

  assert.equal(result.status, 'consumed');
  assert.match(result.reason, /^turn_started_/);
});

// ---------------------------------------------------------------------------
// (b) queued — busy recipient parks the body in its composer, no turn fires
// ---------------------------------------------------------------------------

test('#53 (b): busy recipient parks body in composer → queued', async () => {
  const submittedAtMs = 1000;
  const clock = makeClock(submittedAtMs);
  const { session, sinceBytes } = makeSession({
    preFrames: ['› running prior turn…\n'],
    // composer redraw with the queued REPORT text, appended AFTER the CR watermark
    postFrames: [`│ › ${BODY} │\n  Press up to edit queued messages\n`],
  });
  // Already busy BEFORE the CR (since_ms < submit) — fact 1: a busy CR queues, never fires.
  const getState = () => ({ state: 'working', since_ms: 200 });

  const result = await classifyInjectConsumption(session, BODY, {
    submittedAtMs, sinceBytes, getState, ...clock, timeoutMs: 1200, settleMs: 250,
  });

  assert.equal(result.status, 'queued');
  assert.equal(result.reason, 'busy_parked');
});

// ---------------------------------------------------------------------------
// (c) unknown — no fresh turn AND no observable parked body (conservative)
// ---------------------------------------------------------------------------

test('#53 (c): no turn transition and body not observable → unknown', async () => {
  const submittedAtMs = 1000;
  const clock = makeClock(submittedAtMs);
  const { session, sinceBytes } = makeSession({
    preFrames: ['› ready\n'],
    postFrames: ['› \n'], // recipient idle, composer empty — the body is nowhere on screen
  });
  const getState = () => ({ state: 'idle', since_ms: 500 });

  const result = await classifyInjectConsumption(session, BODY, {
    submittedAtMs, sinceBytes, getState, ...clock, timeoutMs: 600, settleMs: 200,
  });

  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'no_turn');
});

// ---------------------------------------------------------------------------
// (d) never-false-consumed — a busy recipient that merely flips working→thinking
//     AFTER the CR (since_ms ≥ submit) must NOT be read as consumed.
// ---------------------------------------------------------------------------

test('#53 (d): busy sub-state flip after CR is never consumed (closes the last_output leak)', async () => {
  const submittedAtMs = 1000;
  const clock = makeClock(submittedAtMs);
  const { session, sinceBytes } = makeSession({
    preFrames: ['› running prior turn…\n'],
    postFrames: [`│ › ${BODY} │\n`],
  });
  // Initial sample is busy (since_ms < submit) → startedBusy; a later thinking flip has
  // since_ms ≥ submit but belongs to the SAME running turn, not our inject.
  let calls = 0;
  const getState = () => (calls++ === 0
    ? { state: 'working', since_ms: 200 }
    : { state: 'thinking', since_ms: 1100 });

  const result = await classifyInjectConsumption(session, BODY, {
    submittedAtMs, sinceBytes, getState, ...clock, timeoutMs: 1200, settleMs: 250,
  });

  assert.notEqual(result.status, 'consumed');
  assert.equal(result.status, 'queued'); // body parked → queued, never a false success
});

// ---------------------------------------------------------------------------
// Conservatism guards — short / empty bodies and a missing ring claim nothing.
// ---------------------------------------------------------------------------

test('#53: a body below the min-chars floor is unknown (claims nothing)', async () => {
  const clock = makeClock(1000);
  const { session, sinceBytes } = makeSession({ postFrames: ['ok\n'] });
  const result = await classifyInjectConsumption(session, 'ok', {
    submittedAtMs: 1000, sinceBytes, getState: () => ({ state: 'idle', since_ms: 500 }), ...clock,
  });
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'body_too_short');
});

test('#53: a session without an outputRing is unknown, not a crash', async () => {
  const clock = makeClock(1000);
  const result = await classifyInjectConsumption({}, BODY, {
    submittedAtMs: 1000, getState: () => ({ state: 'idle', since_ms: 500 }), ...clock,
  });
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'no_ring');
});
