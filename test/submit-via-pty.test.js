'use strict';

// #544 / #537 (BUG B): submit via the PTY/context layer (pty-only) + PTY-native confirm.
//
// Codifies the 2026-06-07 validation: telepty delivers the submit Enter as a bare 0x0D into
// the CLI's innermost node-pty (no kitty send-text / cmux send-key surface ops), confirmation
// is screen-free (state + outputRing, no `cmux read-screen`), and the UNCONFIRMED-race accept
// signal stays pinned to RELIABLE evidence only — a never-started worker's startup spinner
// must NOT be reported TASK_COMPLETE.
//
// Fully hermetic: no daemon spawn, no PTY, no cmux/kitty binaries. See
// docs/adr/2026-06-07-submit-via-pty-context-layer.md and
// docs/superpowers/specs/2026-06-07-submit-via-pty-context-layer.md.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const child_process = require('node:child_process');

const daemon = require('../daemon');
const { terminalLevelSubmit, submitViaPty, forceSubmitDeliveredToSurface, fireAutoReport, runSubmitAll } = daemon;
const { confirmSubmitAccepted, observeBodyVisibility } = require('../src/submit-gate');

// ---------------------------------------------------------------------------
// 1) pty-only submit: single 0x0D, separate write, no surface shell-out
// ---------------------------------------------------------------------------

function captureWrappedOwnerWs() {
  const sent = [];
  return {
    sent,
    session: {
      type: 'wrapped',
      // Deliberately ALSO set the cmux + kitty handles: pre-#544 these would have
      // been tried first (P1 kitty / P2 cmux). PTY-only must ignore them.
      backend: 'cmux',
      cmuxWorkspaceId: 'workspace:1',
      ownerWs: { readyState: 1, send: (m) => sent.push(m) },
    },
  };
}

test('terminalLevelSubmit returns pty_cr and emits a SINGLE 0x0D via ownerWs (wrapped)', () => {
  const { sent, session } = captureWrappedOwnerWs();
  const strategy = terminalLevelSubmit('s1', session);

  assert.equal(strategy, 'pty_cr');
  assert.equal(sent.length, 1, 'exactly one inject write');
  const msg = JSON.parse(sent[0]);
  assert.equal(msg.type, 'inject');
  assert.equal(msg.data, '\r');
  const bytes = Buffer.from(msg.data, 'utf8');
  assert.equal(bytes.length, 1, 'submit is a single byte');
  assert.equal(bytes[0], 0x0d, 'submit byte is 0x0D (CR / Ink "return" = SUBMIT)');
  assert.notEqual(bytes[0], 0x0a, 'submit byte is NOT 0x0A (LF / Ink "enter" = newline)');
  assert.notEqual(msg.data, '\r\n', 'submit is bare CR, never CRLF');
});

test('terminalLevelSubmit performs NO cmux/kitty surface shell-out (no child_process.execSync)', () => {
  const { session } = captureWrappedOwnerWs();
  const realExecSync = child_process.execSync;
  let execCalls = 0;
  child_process.execSync = (...args) => { execCalls++; return realExecSync.apply(child_process, args); };
  try {
    const strategy = terminalLevelSubmit('s1', session);
    assert.equal(strategy, 'pty_cr');
  } finally {
    child_process.execSync = realExecSync;
  }
  assert.equal(execCalls, 0, 'submit must not shell to cmux send-key / kitty send-text');
});

test('submitViaPty writes a SINGLE 0x0D into the spawned ptyProcess (non-wrapped)', () => {
  const writes = [];
  const session = { type: 'pty', ptyProcess: { write: (d) => writes.push(d) } };
  const ok = submitViaPty(session);

  assert.equal(ok, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0], '\r');
  const bytes = Buffer.from(writes[0], 'utf8');
  assert.equal(bytes.length, 1);
  assert.equal(bytes[0], 0x0d);
});

test('submitViaPty returns false (no submit) when the wrapped ownerWs is not connected', () => {
  const session = { type: 'wrapped', ownerWs: { readyState: 0, send: () => { throw new Error('must not send'); } } };
  assert.equal(submitViaPty(session), false);
  assert.equal(terminalLevelSubmit('s1', session), null, 'no fallback surface path remains');
});

// ---------------------------------------------------------------------------
// 2) per-backend matrix (PTY path is backend-agnostic) + aterm EXCLUDED
// ---------------------------------------------------------------------------
// cmux is live-proven (2026-06-07). warp/tmux are DESIGN HOOKS only: the PTY
// submit is identical across backends, but cmux send-key removal from the
// codebase stays gated on a live warp/tmux regression matrix (not asserted here).

for (const backend of ['cmux', 'warp', 'tmux']) {
  test(`terminalLevelSubmit → pty_cr for a wrapped ${backend} session (backend-agnostic 0x0D)`, () => {
    const sent = [];
    const session = { type: 'wrapped', backend, cmuxWorkspaceId: backend === 'cmux' ? 'workspace:9' : null,
      ownerWs: { readyState: 1, send: (m) => sent.push(m) } };
    assert.equal(terminalLevelSubmit('s', session), 'pty_cr');
    assert.equal(JSON.parse(sent[0]).data, '\r');
  });
}

test('aterm is EXCLUDED from the PTY submit path (no ownerWs, no ptyProcess → no submit)', () => {
  // The daemon delivery path guards `session.type !== 'aterm'` BEFORE submit, so
  // terminalLevelSubmit is never invoked for aterm (UDS Inject, submit intentionally
  // skipped). An aterm session has neither a wrapped ownerWs nor a spawned ptyProcess,
  // so any accidental routing here cannot silently deliver a CR — it throws. This pins
  // the exclusion: aterm must be filtered upstream, never reach submitViaPty.
  const aterm = { type: 'aterm', backend: 'aterm' };
  assert.throws(() => terminalLevelSubmit('a1', aterm), /ptyProcess|Cannot read|undefined/);
});

// ---------------------------------------------------------------------------
// 3) PTY-native confirm: state + outputRing, NO `cmux read-screen` shell-out
// ---------------------------------------------------------------------------

test('confirmSubmitAccepted confirms a cmux session via outputRing — NO cmux read-screen', async () => {
  const body = '[context-ref] Read ~/.telepty/shared/hash.md';
  // Body was visible (in history) then state moves to working — accepted via state, source
  // must be the PTY-fed outputRing, never a screen shell-out.
  const session = { backend: 'cmux', cmuxWorkspaceId: 'workspace:7', outputRing: [`› ${body}`] };
  const submittedAtMs = Date.now();
  let state = { state: 'idle', confidence: 0.9, since_ms: submittedAtMs - 10 };
  setTimeout(() => { state = { state: 'working', confidence: 0.9, since_ms: Date.now() }; }, 15);

  const realExecSync = child_process.execSync;
  let execCalls = 0;
  child_process.execSync = (...args) => { execCalls++; return realExecSync.apply(child_process, args); };
  let result;
  try {
    result = await confirmSubmitAccepted(session, body, {
      submittedAtMs, timeoutMs: 250, intervalMs: 10, getState: () => state,
    });
  } finally {
    child_process.execSync = realExecSync;
  }

  assert.equal(result.accepted, true);
  assert.equal(result.reason, 'state_working');
  assert.equal(execCalls, 0, 'confirm must not shell to `cmux read-screen`');
});

test('observeBodyVisibility sources from outputRing (not screen) for a cmux session with no readScreen', () => {
  const body = 'unique-needle-xyz';
  const session = { backend: 'cmux', cmuxWorkspaceId: 'workspace:7', outputRing: [`› ${body} still here`] };
  const realExecSync = child_process.execSync;
  let execCalls = 0;
  child_process.execSync = (...args) => { execCalls++; return realExecSync.apply(child_process, args); };
  let vis;
  try {
    vis = observeBodyVisibility(session, body);
  } finally {
    child_process.execSync = realExecSync;
  }
  assert.equal(vis.observable, true);
  assert.equal(vis.visible, true);
  assert.equal(vis.source, 'output_ring', 'confirm source is the PTY-fed outputRing, not screen');
  assert.equal(execCalls, 0, 'no cmux read-screen shell-out');
});

test('confirmSubmitAccepted still honors an explicit opts.readScreen seam (future surface adaptors)', async () => {
  const body = 'screen-needle';
  const session = { backend: 'cmux', cmuxWorkspaceId: 'workspace:7', outputRing: [] };
  // Screen shows the body gone → consumed/absent → accepted via the injected reader.
  const result = await confirmSubmitAccepted(session, body, {
    timeoutMs: 100, intervalMs: 10, readScreen: () => 'prompt › (empty)',
  });
  assert.equal(result.accepted, true);
});

// ---------------------------------------------------------------------------
// 4) #537 / BUG B regression (CONDITION-mandated): never-started worker stays UNCONFIRMED
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

// #60 Stage A: the broadcast is captured too, because the verdict this section was written to
// discriminate now lives in `consumption.basis` on the emitted observation rather than in a
// choice between two message labels.
const broadcasts = [];

function runGate(pendingReportOverrides, { trigger = 'real-idle', elapsedSec = 4.5, idleEvidenceReliable } = {}) {
  const captured = [];
  const timers = []; // #48: settle-and-recheck defers the follow-up — capture and flush below
  broadcasts.length = 0;
  const pendingReport = {
    source: 'orch',
    injectId: 'inj-1',
    injectedAt: new Date(NOW - elapsedSec * 1000).toISOString(),
    ...pendingReportOverrides,
  };
  const deps = {
    now: () => NOW,
    setTimeout: (fn) => { timers.push(fn); return 0; },
    broadcastSessionEvent: (type, sid, _s, opts) => broadcasts.push({ type, opts }),
    resolveSessionAlias: (s) => s,
    sessions: { orch: { id: 'orch' } },
    pendingReports: { 'worker-1': pendingReport },
    deliverInjectionToSession: (srcId, _s, msg) => captured.push({ srcId, msg }),
    idleEvidenceReliable, // #545: now recorded as EVIDENCE, no longer a promotion input
    getAutoState: () => 'idle', // #48: still idle at recheck → the observation fires
  };
  fireAutoReport('worker-1', { id: 'worker-1' }, pendingReport, trigger, deps);
  while (timers.length) timers.shift()(); // #48: run the settle recheck
  return captured.length ? captured[0].msg : null;
}

const UNKNOWN_RE = /^TASK_COMPLETION_UNKNOWN: worker-1 inject=inj-1 — no completion fact observed; pty_quiet=\d+\.\ds; consumption=(observed|not_established); outcome protocol unavailable$/;

// The whole of section 4/4b used to turn on a two-way verdict: UNCONFIRMED for a never-started
// worker, TASK_COMPLETE for a real one. Both are deleted, so every case below states the same
// sentence. That is the point rather than a loss — note that the three "positive" cases all rest
// on a `force` accept, which measured no screen at all, and #545 exists precisely because a
// confirmed submit plus a weak idle flip was already known not to establish anything.
function statedAbsence(msg) {
  assert.ok(msg, 'an observation is delivered — never silence');
  assert.match(msg, UNKNOWN_RE);
  assert.doesNotMatch(msg, /TASK_COMPLETE:/);
  assert.doesNotMatch(msg, /TASK_IDLE_UNCONFIRMED:/);
  const ev = broadcasts.find((b) => b.type === 'task_completion_unknown');
  assert.ok(ev, 'the bus hears it too');
  assert.equal(ev.opts.extra.completion_fact, null);
  assert.equal(ev.opts.extra.terminal, false);
  return ev.opts.extra.consumption;
}

test('BUG B: never-started worker (submit failed, only a startup spinner) is never a completion [real-idle]', () => {
  // Submit was expected but never strong-confirmed (no submitConfirmedAt, accepted:false).
  // The ONLY positive signal is sawWorkingAfterInject — a startup-spinner-polluted transition,
  // which Stage A does not admit as an input to consumption at all.
  const consumption = statedAbsence(runGate({
    submitExpected: true,
    sawWorkingAfterInject: true,
    submitConfirm: { accepted: false, reason: 'strategy_failed' },
  }));
  assert.equal(consumption.basis, 'submit_rejection_observed');
  assert.equal(consumption.submit_confirm_reason, 'strategy_failed');
});

test('BUG B: never-started worker is not a completion on the silence-timeout trigger either', () => {
  const consumption = statedAbsence(
    runGate({ submitExpected: true, sawWorkingAfterInject: true }, { trigger: 'silence-timeout', elapsedSec: 12 })
  );
  assert.equal(consumption.basis, 'no_consumption_evidence',
    'sawWorkingAfterInject on its own is not evidence of anything');
});

test('a force-accepted pty_cr submit (post-#544) is delivery, not completion', () => {
  // Change 2a: a delivered pty_cr sets submitConfirmedAt at submit time. That is a TRANSPORT
  // fact — the CR reached the PTY — and the old gate promoted it to a completion claim. The two
  // are different domains, which is the separation Stage A exists to draw.
  const consumption = statedAbsence(runGate({
    submitExpected: true,
    submitConfirmedAt: new Date(NOW - 30_000).toISOString(),
    submitConfirm: { accepted: true, reason: 'force' },
  }, { elapsedSec: 30 }));
  assert.equal(consumption.basis, 'no_consumption_evidence');
  assert.equal(consumption.submit_confirm_reason, 'force',
    'the accept was seen and rejected as evidence — force is outside the screen-derived whitelist');
});

// ---------------------------------------------------------------------------
// 4b) #545 DEFENSE: real-idle with weak idle evidence → UNCONFIRMED, never TASK_COMPLETE
// ---------------------------------------------------------------------------
// The THINKING-only state guard (session-state.js) covers the spinner case; this daemon gate
// covers the residual WORKING-silence/prompt_detected flip: a worker whose submit IS confirmed
// but whose idle was NOT a reliable OSC133-marked / body-consumed transition must report the
// honest TASK_IDLE_UNCONFIRMED, never a false TASK_COMPLETE.

// #545's `idleEvidenceReliable` is no longer a gate that downgrades a completion — there is no
// completion to downgrade. It is computed and recorded as evidence about the idle flip. So the
// three cases below assert the property that replaces the old gate: the reliability of the idle
// evidence CANNOT change what is claimed, in either direction, on any trigger.

test('#545: unreliable idle evidence with a confirmed submit claims nothing', () => {
  const consumption = statedAbsence(runGate({
    submitExpected: true,
    submitConfirmedAt: new Date(NOW - 30_000).toISOString(),
    submitConfirm: { accepted: true, reason: 'force' },
  }, { elapsedSec: 30, idleEvidenceReliable: false }));
  assert.equal(consumption.basis, 'no_consumption_evidence');
});

test('#545: RELIABLE idle evidence (OSC133 + body consumed) still claims nothing', () => {
  // The load-bearing half. This is the strongest idle evidence the daemon can have, and it was
  // the exact input that produced TASK_COMPLETE. It now produces the same sentence as the
  // unreliable case above — a reliable idle flip measures the SCREEN settling, never a turn
  // ending, so it never had the standing to conclude the task was done.
  const consumption = statedAbsence(runGate({
    submitExpected: true,
    submitConfirmedAt: new Date(NOW - 30_000).toISOString(),
    submitConfirm: { accepted: true, reason: 'force' },
  }, { elapsedSec: 30, idleEvidenceReliable: true }));
  assert.equal(consumption.basis, 'no_consumption_evidence');
});

test('#545: the reliability flag changes nothing on a silence-timeout trigger either', () => {
  const consumption = statedAbsence(runGate({
    submitExpected: true,
    submitConfirmedAt: new Date(NOW - 30_000).toISOString(),
    submitConfirm: { accepted: true, reason: 'force' },
  }, { trigger: 'silence-timeout', elapsedSec: 30, idleEvidenceReliable: false }));
  assert.equal(consumption.basis, 'no_consumption_evidence');
});

// ---------------------------------------------------------------------------
// 5) force-confirm: pty_cr IS delivery on every backend (#544 flip)
// ---------------------------------------------------------------------------

test('forceSubmitDeliveredToSurface: pty_cr is delivered on cmux (PTY-native) and everywhere', () => {
  assert.equal(forceSubmitDeliveredToSurface({ backend: 'cmux', cmuxWorkspaceId: 'w1' }, 'pty_cr'), true);
  assert.equal(forceSubmitDeliveredToSurface({ type: 'pty' }, 'pty_cr'), true);
  assert.equal(forceSubmitDeliveredToSurface({ backend: 'cmux', cmuxWorkspaceId: 'w1' }, null), false);
});

// ---------------------------------------------------------------------------
// 6) #546: submit-all routes EVERY backend through the PTY path (zero cmux send-key)
// ---------------------------------------------------------------------------
// The last surface-op submit caller (cmux `send-key --surface return`) is removed; submit-all
// now delivers a bare 0x0D via the PTY/context path per session — the same path validated 3/3
// live for per-session submit (#544). submitViaCmux is deleted (0 live callers).

test('#546: submit-all delivers a single 0x0D via the PTY path to ≥2 wrapped sessions (no cmux send-key)', () => {
  const sentA = [];
  const sentB = [];
  const sessionsMap = {
    a: { type: 'wrapped', command: 'claude', backend: 'cmux', cmuxWorkspaceId: 'ws:1',
         ownerWs: { readyState: 1, send: (m) => sentA.push(m) } },
    b: { type: 'wrapped', command: 'codex', backend: 'cmux', cmuxWorkspaceId: 'ws:2',
         ownerWs: { readyState: 1, send: (m) => sentB.push(m) } },
  };
  const realExecSync = child_process.execSync;
  let execCalls = 0;
  child_process.execSync = (...args) => { execCalls++; return realExecSync.apply(child_process, args); };
  let results;
  try {
    results = runSubmitAll(sessionsMap);
  } finally {
    child_process.execSync = realExecSync;
  }

  assert.equal(results.successful.length, 2, 'both sessions submitted');
  assert.equal(results.failed.length, 0);
  assert.equal(execCalls, 0, 'submit-all must NOT shell to cmux send-key');
  for (const sent of [sentA, sentB]) {
    assert.equal(sent.length, 1, 'exactly one inject write per session');
    const msg = JSON.parse(sent[0]);
    assert.equal(msg.type, 'inject');
    const bytes = Buffer.from(msg.data, 'utf8');
    assert.equal(bytes.length, 1, 'single byte');
    assert.equal(bytes[0], 0x0d, 'submit byte is 0x0D via the PTY path');
  }
});

// Requiring daemon.js loads persisted sessions for read-only inspection; ensure the test
// process exits even if module-load left background handles open.
test.after(() => { setImmediate(() => process.exit(0)); });
