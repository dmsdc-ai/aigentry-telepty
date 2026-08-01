'use strict';

// #537 / Bug B: ENFORCE-REPORT must NOT emit TASK_COMPLETE for a never-started worker.
//
// #60 Stage A resolves this by removing the claim rather than guarding it: no input produces
// TASK_COMPLETE for any worker now, started or not. See the block above the first test for why
// the two-way verdict this file was written around could never be measured.
//
// A transient submit failure (cmux `send-key` → "Failed to write to socket") means the
// injected prompt's Enter never reaches the live CLI, so claude sits idle. The daemon then
// observes claude's startup busy→idle settle (~4.5s) and, prior to this fix, fired a bogus
// `TASK_COMPLETE` because the real-idle path trusted the elapsed floor alone.
//
// Two surgical guards are verified here, both fully hermetic (no daemon spawn, no PTY):
//   1) fireAutoReport()'s real-idle gate — via the exported deps DI seam.
//   2) forceSubmitDeliveredToSurface() — PTY-native force-confirm (#544: a successful
//      pty_cr IS real delivery on every backend; honesty comes from the PTY-derived confirm).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const daemon = require('../daemon');
const { fireAutoReport, forceSubmitDeliveredToSurface } = daemon;

const NOW = 1_700_000_000_000; // fixed clock

// Drive fireAutoReport with an injected clock + a captured deliver fn, returning the
// auto-report message that would be delivered back to the source session (or null).
function runGate(pendingReportOverrides, { trigger = 'real-idle', elapsedSec = 4.5 } = {}) {
  const captured = [];
  const timers = []; // #48: settle-and-recheck defers UNCONFIRMED — capture and flush below
  const pendingReport = {
    source: 'orch',
    injectId: 'inj-1',
    injectedAt: new Date(NOW - elapsedSec * 1000).toISOString(),
    ...pendingReportOverrides,
  };
  const deps = {
    now: () => NOW,
    setTimeout: (fn) => { timers.push(fn); return 0; },
    broadcastSessionEvent: () => {},
    resolveSessionAlias: (s) => s,
    sessions: { orch: { id: 'orch' } },
    pendingReports: { 'worker-1': pendingReport },
    deliverInjectionToSession: (srcId, _srcSession, msg) => captured.push({ srcId, msg }),
    getAutoState: () => 'idle', // #48: still idle at recheck → the honest label fires
  };
  fireAutoReport('worker-1', { id: 'worker-1' }, pendingReport, trigger, deps);
  while (timers.length) timers.shift()(); // #48: run the settle recheck
  return captured.length ? captured[0].msg : null;
}

// ---------------- the gate is gone, because the discrimination was never measurable ----------
//
// This file was built around a two-way verdict: A/B (never-started worker) had to say
// TASK_IDLE_UNCONFIRMED, and C/D/D2 (legitimate work) had to say TASK_COMPLETE. #60 Stage A
// deletes BOTH labels, so the five cases below now produce the same literal sentence.
//
// That is not the migration losing a distinction — it is the release admitting the distinction
// was never backed by a measurement. C's "STRONG-confirmed" is a `force` accept, which measured
// no screen at all; D and D2 rest on `sawWorkingAfterInject` and an elapsed floor, and the very
// next test down (B) exists because startup pollution makes that flag untrustworthy. The daemon
// was choosing between "done" and "maybe not delivered" from inputs that could not tell them
// apart, which is Bug B's actual root cause rather than a special case of it.
//
// What survives, and is asserted per case, is the evidence itself: `consumption.basis` names
// exactly which rule fired, so the A/B vs C/D/D2 difference is still visible where it is real.

const COMPLETION_UNKNOWN_RE =
  /^TASK_COMPLETION_UNKNOWN: worker-1 inject=inj-1 — no completion fact observed; pty_quiet=\d+\.\ds; consumption=(observed|not_established); outcome protocol unavailable$/;

function assertNoVerdict(msg) {
  assert.ok(msg, 'an observation should be delivered — never silence');
  assert.match(msg, COMPLETION_UNKNOWN_RE);
  assert.doesNotMatch(msg, /TASK_COMPLETE:/);
  assert.doesNotMatch(msg, /TASK_IDLE_UNCONFIRMED:/);
}

test('A: real-idle with submit expected + submit explicitly FAILED → no verdict, absence stated', () => {
  const msg = runGate({
    submitExpected: true,
    submitConfirm: { accepted: false, reason: 'cmux_send_failed' },
  });
  // A failed submit is still the strongest signal here, and it is still recorded — as a
  // consumption basis rather than as a label. What it can no longer do is imply the inject was
  // not processed, which the old text asserted outright.
  assertNoVerdict(msg);
  assert.match(msg, /consumption=not_established/);
});

test('B: real-idle with submit expected + only startup sawWorkingAfterInject (no confirm)', () => {
  // sawWorkingAfterInject is startup-polluted and must NOT be trusted when a submit was expected.
  // Stage A makes that structural: the flag is not an input to any consumption admission, so it
  // cannot dress a never-started worker up as a started one under any label.
  const msg = runGate({ submitExpected: true, sawWorkingAfterInject: true });
  assertNoVerdict(msg);
  assert.match(msg, /consumption=not_established/);
});

// ---------------- the three cases that used to be promoted to TASK_COMPLETE ----------------

test('C: real-idle with a force accept + real work (82s) is NOT a completion', () => {
  const msg = runGate({
    submitExpected: true,
    submitConfirmedAt: new Date(NOW - 82_000).toISOString(),
    submitConfirm: { accepted: true, reason: 'force' },
    sawWorkingAfterInject: true,
  }, { elapsedSec: 82.7 });
  // The old name for this fixture was "STRONG-confirmed". `force` skips the synchronous
  // consumption classify entirely — daemon.js's own comment says a busy-parked body would
  // silently drop — so it is not screen-derived evidence and never was.
  assertNoVerdict(msg);
  assert.match(msg, /consumption=not_established/);
});

test('D: real-idle, no submit expected (auto-enter inject) + saw working is NOT a completion', () => {
  const msg = runGate({ submitExpected: false, sawWorkingAfterInject: true }, { elapsedSec: 5 });
  assertNoVerdict(msg);
});

test('D2: real-idle, no submit expected, above the old elapsed floor is NOT a completion', () => {
  // The legacy floor is deleted as a decision input. Elapsed is carried as a measurement — the
  // text still reports it — but crossing a threshold is not evidence that work finished.
  const msg = runGate({ submitExpected: false }, { elapsedSec: 5 });
  assertNoVerdict(msg);
  assert.match(msg, /pty_quiet=5\.0s/);
});

// ---------------- honest force-confirm: delivery to rendered surface ----------------

// #544: PTY-native submit flips this. terminalLevelSubmit now emits pty_cr ONLY, and a
// successful pty_cr writes the bare 0x0D into the CLI's innermost node-pty — real delivery
// even on a cmux surface (live 2026-06-07: 3/3 with cmux send-key failing). The former
// false-negative here was the direct cause of BUG B's bogus UNCONFIRMED reports.
test('E: force pty_cr on a cmux surface IS delivered (PTY-native submit, #544)', () => {
  assert.equal(forceSubmitDeliveredToSurface({ backend: 'cmux', cmuxWorkspaceId: 'w1' }, 'pty_cr'), true);
});

test('F: force via cmux strategy IS delivered (pure-fn: any truthy strategy delivers)', () => {
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
