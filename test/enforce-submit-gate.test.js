'use strict';

// #537 / Bug B: ENFORCE-REPORT must NOT emit TASK_COMPLETE for a never-started worker.
//
// A transient submit failure (cmux `send-key` → "Failed to write to socket") means the
// injected prompt's Enter never reaches the live CLI, so claude sits idle. The daemon then
// observes claude's startup busy→idle settle (~4.5s) and, prior to this fix, fired a bogus
// `TASK_COMPLETE` because the real-idle path trusted the elapsed floor alone.
//
// Two surgical guards are verified here, both fully hermetic (no daemon spawn, no PTY):
//   1) fireAutoReport()'s real-idle gate — via the exported deps DI seam.
//   2) forceSubmitDeliveredToSurface() — honest force-confirm (pty_cr on cmux = not delivered).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const daemon = require('../daemon');
const { fireAutoReport, forceSubmitDeliveredToSurface } = daemon;

const NOW = 1_700_000_000_000; // fixed clock

// Drive fireAutoReport with an injected clock + a captured deliver fn, returning the
// auto-report message that would be delivered back to the source session (or null).
function runGate(pendingReportOverrides, { trigger = 'real-idle', elapsedSec = 4.5 } = {}) {
  const captured = [];
  const pendingReport = {
    source: 'orch',
    injectId: 'inj-1',
    injectedAt: new Date(NOW - elapsedSec * 1000).toISOString(),
    ...pendingReportOverrides,
  };
  const deps = {
    now: () => NOW,
    setTimeout: () => 0, // ready-signal defer timer — never armed for real-idle
    broadcastSessionEvent: () => {},
    resolveSessionAlias: (s) => s,
    sessions: { orch: { id: 'orch' } },
    pendingReports: {},
    deliverInjectionToSession: (srcId, _srcSession, msg) => captured.push({ srcId, msg }),
  };
  fireAutoReport('worker-1', { id: 'worker-1' }, pendingReport, trigger, deps);
  return captured.length ? captured[0].msg : null;
}

// ---------------- the gate: never-started worker → NOT TASK_COMPLETE ----------------

test('A: real-idle with submit expected + submit explicitly FAILED → TASK_IDLE_UNCONFIRMED', () => {
  const msg = runGate({
    submitExpected: true,
    submitConfirm: { accepted: false, reason: 'cmux_send_failed' },
  });
  assert.ok(msg, 'an auto-report should be delivered');
  assert.match(msg, /^TASK_IDLE_UNCONFIRMED:/);
  assert.doesNotMatch(msg, /^TASK_COMPLETE:/);
});

test('B: real-idle with submit expected + only startup sawWorkingAfterInject (no confirm) → TASK_IDLE_UNCONFIRMED', () => {
  // sawWorkingAfterInject is startup-polluted and must NOT be trusted when a submit was expected.
  const msg = runGate({ submitExpected: true, sawWorkingAfterInject: true });
  assert.match(msg, /^TASK_IDLE_UNCONFIRMED:/);
  assert.doesNotMatch(msg, /^TASK_COMPLETE:/);
});

// ---------------- legit completions: TASK_COMPLETE still fires ----------------

test('C: real-idle with submit STRONG-confirmed + real work (82s) → TASK_COMPLETE', () => {
  const msg = runGate({
    submitExpected: true,
    submitConfirmedAt: new Date(NOW - 82_000).toISOString(),
    submitConfirm: { accepted: true, reason: 'force' },
    sawWorkingAfterInject: true,
  }, { elapsedSec: 82.7 });
  assert.match(msg, /^TASK_COMPLETE:/);
});

test('D: real-idle, no submit expected (auto-enter inject) + saw working → TASK_COMPLETE (back-compat)', () => {
  const msg = runGate({ submitExpected: false, sawWorkingAfterInject: true }, { elapsedSec: 5 });
  assert.match(msg, /^TASK_COMPLETE:/);
});

test('D2: real-idle, no submit expected, above elapsed floor → TASK_COMPLETE (legacy floor preserved)', () => {
  const msg = runGate({ submitExpected: false }, { elapsedSec: 5 });
  assert.match(msg, /^TASK_COMPLETE:/);
});

// ---------------- honest force-confirm: delivery to rendered surface ----------------

test('E: force pty_cr fallback on a cmux surface is NOT delivered (cmux send-key failed)', () => {
  assert.equal(forceSubmitDeliveredToSurface({ backend: 'cmux', cmuxWorkspaceId: 'w1' }, 'pty_cr'), false);
});

test('F: force via cmux strategy IS delivered', () => {
  assert.equal(forceSubmitDeliveredToSurface({ backend: 'cmux', cmuxWorkspaceId: 'w1' }, 'cmux'), true);
});

test('force via kitty (terminal-level) is delivered even on a cmux session', () => {
  assert.equal(forceSubmitDeliveredToSurface({ backend: 'cmux', cmuxWorkspaceId: 'w1' }, 'kitty'), true);
});

test('force pty_cr on a non-cmux session is delivered (pty is the primary surface there)', () => {
  assert.equal(forceSubmitDeliveredToSurface({ type: 'pty' }, 'pty_cr'), true);
});

test('force with no strategy is never delivered', () => {
  assert.equal(forceSubmitDeliveredToSurface({ backend: 'cmux', cmuxWorkspaceId: 'w1' }, null), false);
});

// Requiring daemon.js loads persisted sessions for read-only inspection; ensure the test
// process exits even if module-load left background handles open.
test.after(() => { setImmediate(() => process.exit(0)); });
