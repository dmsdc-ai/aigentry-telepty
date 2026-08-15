'use strict';

// telepty#60 Stage A — the truth cutover, at the fireAutoReport seam.
//
// The daemon asserts TASK COMPLETION from PTY-derived signals it cannot measure: silence,
// elapsed time, a prompt glyph, a submit flag. Stage A removes every terminal claim and emits
// honest absence instead: one `task_completion_unknown` observation carrying
// `completion_fact: null`, never a sentence that says the work is done.
//
// These are the design's §8.1 rows that land on this seam. Each one drives a NON-FACT
// measurement and asserts two things:
//   1. no terminal outcome is produced (not in the source-facing text, not on the bus);
//   2. exactly one completion-absence observation IS produced — absence is emitted, never
//      silence (§A2). A bare `return` that emits nothing fails these tests as loudly as a
//      false TASK_COMPLETE does, which is the point: the #52 consumption gate at
//      daemon.js:803-810 is a silent return, and tightening `confirmed` without removing it
//      routes every non-fact turn into that silence. That is what killed design rounds 2, 3
//      and 5.
//
// Hermetic: no daemon spawn, no PTY, no HTTP. Uses the exported deps DI seam (injected clock,
// captured deliver fn, captured bus) exactly as test/enforce-submit-gate.test.js does.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Hermetic require. `require('../daemon')` reads $HOME at load: with the real HOME it restores
// every live persisted session ("[PERSIST] Restored session orchestrator …") and arms their
// reconnect/bootstrap timers inside this test process. That is both a leak and a read of
// production state. Redirect HOME to a temp dir and pin PORT=0 BEFORE the require, so this
// file can only ever see an empty session store.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty60-obs-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.PORT = '0';

const daemon = require('../daemon');
const { fireAutoReport, recordObservation, describeSessionTeardown } = daemon;

const NOW = 1_700_000_000_000; // fixed clock

// Terminal vocabulary Stage A must never produce again. `TASK_ERROR` is included: it also
// asserts a task outcome ("the inject was NOT processed") from a screen scrape.
const TERMINAL_TEXT_RE = /\b(TASK_COMPLETE|TASK_COMPLETE_WITH_REPORT|TASK_IDLE_UNCONFIRMED|TASK_ERROR)\b/;
const TERMINAL_EVENT_RE = /^(TASK_COMPLETE|TASK_COMPLETE_WITH_REPORT|TASK_IDLE_UNCONFIRMED|TASK_ERROR|TASK_IDLE_NO_REPORT|TASK_DEAD_NO_REPORT)$/;

// The named nonterminal results §A2 requires every eligible invocation to return.
const NAMED_RESULTS = new Set([
  'observation_emitted',
  'observation_duplicate',
  'unmapped_transition_cause',
  'tracking_superseded',
  'tracking_unavailable',
  'observation_deferred',
  'tracking_persistence_failed',
]);

// Drive fireAutoReport with an injected clock, capturing BOTH the source-facing delivery and
// the bus. Returns the decision plus everything observable, so one call can be asserted for
// "no terminal claim" and "one absence emission" together.
function runObservation(pendingReportOverrides, {
  trigger = 'real-idle',
  elapsedSec = 5.0,
  autoState = 'idle',          // live state at the settle recheck; 'idle' keeps the target
                               // branch reachable (a 'working' recheck returns EARLY and the
                               // test would pass without exercising anything — the vacuity
                               // shape the dispatch names)
  session = { id: 'worker-1', type: 'spawned' },
  extraDeps = {},
} = {}) {
  const delivered = [];
  const busEvents = [];
  const timers = [];
  const pendingReport = {
    source: 'orch',
    injectId: 'probe',
    injectedAt: new Date(NOW - elapsedSec * 1000).toISOString(),
    ...pendingReportOverrides,
  };
  const deps = {
    now: () => NOW,
    setTimeout: (fn) => { timers.push(fn); return 0; },
    broadcastSessionEvent: (type, sid, _sess, payload) => busEvents.push({ type, sid, payload }),
    resolveSessionAlias: (s) => s,
    sessions: { orch: { id: 'orch' }, 'worker-1': session },
    pendingReports: { 'worker-1': pendingReport },
    deliverInjectionToSession: (srcId, _srcSession, msg) => delivered.push({ srcId, msg }),
    getAutoState: () => autoState,
    sampleChildCpu: () => null,   // unobservable → the #52 CPU re-arm cannot fire
    ...extraDeps,
  };
  const decision = fireAutoReport('worker-1', session, pendingReport, trigger, deps);
  let guard = 0;
  while (timers.length && guard++ < 50) timers.shift()(); // flush the settle chain
  return { decision, delivered, busEvents, pendingReport };
}

// --- assertions -------------------------------------------------------------------------

function assertNoTerminalOutcome(r) {
  for (const d of r.delivered) {
    assert.ok(
      !TERMINAL_TEXT_RE.test(d.msg),
      `non-fact measurement emitted terminal outcome: ${d.msg}`
    );
  }
  for (const e of r.busEvents) {
    assert.ok(
      !TERMINAL_EVENT_RE.test(e.type),
      `non-fact measurement emitted terminal bus event: ${e.type}`
    );
  }
}

// Exactly one completion-absence emission. Both halves matter: 0 is silence (the bare-return
// defect), 2+ is a duplicate the observation ledger was supposed to dedup.
function absenceEmissions(r) {
  return r.busEvents.filter(e => e.type === 'task_completion_unknown');
}

function assertOneAbsence(r) {
  const found = absenceEmissions(r);
  assert.equal(
    found.length, 1,
    `expected 1 completion-absence emission, got ${found.length}`
  );
  const body = found[0].payload && (found[0].payload.extra || found[0].payload);
  assert.equal(body.completion_fact, null, 'completion_fact must be null');
  assert.equal(body.terminal, false, 'terminal must be false');
  assert.equal(body.schema_version, 2, 'schema_version must be 2');
  return body;
}

function assertNamedDecision(r) {
  assert.ok(
    NAMED_RESULTS.has(r.decision),
    `expected one of [${[...NAMED_RESULTS].join(', ')}], got ${JSON.stringify(r.decision)}`
  );
}

// --- §8.1 elapsed_is_not_completion -----------------------------------------------------

test('elapsed_is_not_completion: 5.0s of elapsed time is not a completion fact', () => {
  const r = runObservation({}, { trigger: 'real-idle', elapsedSec: 5.0 });
  assertNoTerminalOutcome(r);
  const body = assertOneAbsence(r);
  assert.equal(body.observation.kind, 'pty_quiet');
  assertNamedDecision(r);
});

// --- §8.1 working_edge_is_not_completion ------------------------------------------------

test('working_edge_is_not_completion: a busy edge 0.2s after inject is not a completion fact', () => {
  // sawWorkingAfterInject is startup-polluted (#537): a claude that merely BOOTED rides this
  // edge without ever consuming the inject.
  const r = runObservation(
    { sawWorkingAfterInject: true },
    { trigger: 'real-idle', elapsedSec: 0.2 }
  );
  assertNoTerminalOutcome(r);
  assertOneAbsence(r);
  assertNamedDecision(r);
});

// --- §8.1 submit_accept_is_not_completion -----------------------------------------------

test('submit_accept_is_not_completion: a force-accepted submit + reliable idle is not completion', () => {
  // idleEvidenceReliable:true is pinned deliberately — it selects the production
  // reliable-idle promotion branch (daemon.js:700-715) rather than relying on an omitted
  // dependency. The earlier probe that omitted it was vacuous and its RED was withdrawn.
  // `force` is NOT screen-derived consumption evidence, and with no fresh non-busy→busy edge
  // there is nothing here that measures consumption at all.
  const r = runObservation({
    submitExpected: true,
    submitConfirmedAt: new Date(NOW - 10_000).toISOString(),
    submitConfirm: { accepted: true, reason: 'force', ambiguous: false },
  }, { trigger: 'real-idle', elapsedSec: 10.0, extraDeps: { idleEvidenceReliable: true } });

  assertNoTerminalOutcome(r);
  const body = assertOneAbsence(r);
  assert.equal(body.consumption.status, 'not_established',
    'a force-only accept measures no consumption');
  assert.equal(body.completion_fact, null);
  assertNamedDecision(r);
});

// --- §8.1 consumed_settled_path_is_total ------------------------------------------------

test('consumed_settled_path_is_total: the settled+consumed path emits absence, never silence', () => {
  // This is the #52 gate at daemon.js:803-810 — a bare `return` that emits nothing and sets
  // nothing. Today it is reached only when `confirmed` is false, and `confirmed === true`
  // bypasses it; the moment `confirmed` gets stricter, EVERY non-fact turn routes here and
  // goes silent. Consumption must be a FIELD of the observation, never a gate in front of it.
  const r = runObservation({
    submitExpected: true,
    unconfirmedSettleDone: true,
    submitStartedAt: new Date(NOW - 30_000).toISOString(),
    injectConsumedAt: new Date(NOW - 25_000).toISOString(),
    injectConsumedVia: 'fresh_busy_transition',
    injectConsumedSinceMs: NOW - 25_000,
    injectConsumptionCandidate: {
      from: 'idle', to: 'working',
      at: new Date(NOW - 25_000).toISOString(), sinceMs: NOW - 25_000,
    },
    submitConfirm: { accepted: true, reason: 'body_consumed', ambiguous: false },
    submitConfirmedAt: new Date(NOW - 29_000).toISOString(),
  }, { trigger: 'real-idle', elapsedSec: 30.0 });

  assertNoTerminalOutcome(r);
  const body = assertOneAbsence(r);
  assert.equal(body.consumption.status, 'observed',
    'a qualified fresh edge with an accepted non-ambiguous screen-derived confirm IS consumption');
  assert.equal(body.consumption.basis, 'fresh_busy_transition');
  assert.equal(body.completion_fact, null,
    'consumption observed is still not a completion fact');
  assertNamedDecision(r);
});

// --- §A2 totality: every eligible invocation returns a named decision -------------------

test('every_eligible_invocation_returns_a_named_decision: no path returns undefined', () => {
  // §A2 item 2: "Every eligible invocation returns and persists one of observation_emitted,
  // observation_duplicate, unmapped_transition_cause, tracking_superseded,
  // tracking_unavailable, or another named nonterminal result." A bare `return` is the defect.
  const arms = [
    ['plain real-idle', {}, { trigger: 'real-idle', elapsedSec: 5 }],
    ['silence-timeout', {}, { trigger: 'silence-timeout', elapsedSec: 12 }],
    ['ready-signal, submit expected, no evidence', { submitExpected: true },
      { trigger: 'ready-signal', elapsedSec: 0.1 }],
    ['ready-signal, submit already confirmed', {
      submitExpected: true,
      submitConfirmedAt: new Date(NOW - 2_000).toISOString(),
      submitConfirm: { accepted: true, reason: 'body_consumed', ambiguous: false },
    }, { trigger: 'ready-signal', elapsedSec: 2 }],
    ['settled, submit rejected', {
      submitExpected: true,
      unconfirmedSettleDone: true,
      submitConfirm: { accepted: false, reason: 'body_still_visible' },
    }, { trigger: 'real-idle', elapsedSec: 8 }],
    ['recheck says working (suppression arm)', {}, { trigger: 'real-idle', elapsedSec: 5, autoState: 'working' }],
  ];
  for (const [label, overrides, opts] of arms) {
    const r = runObservation(overrides, opts);
    assert.ok(
      NAMED_RESULTS.has(r.decision),
      `[${label}] expected a named observation decision, got ${JSON.stringify(r.decision)}`
    );
    assertNoTerminalOutcome(r);
  }
});

// --- §8.1 duplicate handling ------------------------------------------------------------

test('duplicate_idle_transition_is_total: a repeat of the same observation is named, not silent', () => {
  // The once-only `idleNotified` latch (daemon.js:127 guard, :819 assignment) is burned by a
  // WRONG-label emission and then drops the later genuine one. Stage A replaces it with
  // dedup keyed on OBSERVATION IDENTITY, which cannot become an authority gate: the repeat is
  // reported as `observation_duplicate`, not swallowed by a bare `return`.
  const delivered = [];
  const busEvents = [];
  const timers = [];
  const pendingReport = {
    source: 'orch',
    injectId: 'probe',
    injectedAt: new Date(NOW - 5_000).toISOString(),
  };
  const session = { id: 'worker-1', type: 'spawned' };
  const deps = {
    now: () => NOW,
    setTimeout: (fn) => { timers.push(fn); return 0; },
    broadcastSessionEvent: (type, sid, _s, payload) => busEvents.push({ type, sid, payload }),
    resolveSessionAlias: (s) => s,
    sessions: { orch: { id: 'orch' }, 'worker-1': session },
    pendingReports: { 'worker-1': pendingReport },
    deliverInjectionToSession: (srcId, _s, msg) => delivered.push({ srcId, msg }),
    getAutoState: () => 'idle',
    sampleChildCpu: () => null,
  };

  // Dedup lives in the LEDGER, keyed on observation identity, so the record has to exist for the
  // dedup path to be the thing under test. Create it the way the inject handler does.
  const begun = daemon.beginTrackedInjection({
    injectId: pendingReport.injectId, sessionId: 'worker-1', source: 'orch', session,
  });
  assert.equal(begun.ok, true, 'the tracked record must commit before delivery');

  // Skip the #48 settle debounce: it delays FOLLOW-UP observations, and what is under test here
  // is the identity dedup, not the debounce. (The debounce itself is covered by the totality arms.)
  pendingReport.unconfirmedSettleDone = true;

  const first = recordObservation({
    sessionId: 'worker-1', session, pendingReport,
    destination: 'idle', cause: 'silence_timeout', evidence: { silence_ms: 5000 },
    deliverToSource: true, trigger: 'real-idle', deps,
  });
  const second = recordObservation({
    sessionId: 'worker-1', session, pendingReport,
    destination: 'idle', cause: 'silence_timeout', evidence: { silence_ms: 5000 },
    deliverToSource: true, trigger: 'real-idle', deps,
  });
  // A DIFFERENT measurement on the same inject is not a duplicate — the dedup must not become an
  // authority gate that swallows later genuine observations, which is exactly what the one-way
  // `idleNotified` bit did.
  const third = recordObservation({
    sessionId: 'worker-1', session, pendingReport,
    destination: 'waiting', cause: 'input_request_pattern', evidence: { matched_line: 'Continue?' },
    deliverToSource: true, trigger: 'transition', deps,
  });

  assert.equal(first, 'observation_emitted',
    `expected the first quiet observation to be emitted, got ${JSON.stringify(first)}`);
  assert.equal(second, 'observation_duplicate',
    `expected observation decision on the repeat, got ${JSON.stringify(second)}`);
  assert.equal(third, 'observation_emitted',
    `a different measurement must still be emitted, got ${JSON.stringify(third)}`);

  const record = daemon.getTrackedInjection(pendingReport.injectId);
  assert.equal(record.last_observation.kind, 'input_request_pattern_observed');
  assert.equal(record.observation_seq, 3, 'tracking_started + quiet + input-request');

  // The bus hears every call (a subscriber must never infer from silence), but the SOURCE is not
  // spammed with the duplicate.
  assert.equal(busEvents.filter(e => e.type === 'task_completion_unknown').length, 3);
  assert.equal(delivered.length, 2, `expected 2 source deliveries (dup suppressed), got ${delivered.length}`);
  for (const d of delivered) {
    assert.ok(!TERMINAL_TEXT_RE.test(d.msg), `terminal outcome emitted: ${d.msg}`);
  }
});

// --- #843 failed_commit_is_not_silence --------------------------------------------------

test('failed_commit_is_not_silence: a ledger write failure is still emitted, and does not poison the retry', () => {
  // §A2 inside the emitter written to enforce §A2. `recordObservation` returned
  // `tracking_persistence_failed` BEFORE the broadcast, so a store that could not be written
  // produced no bus event and no source delivery at all — total silence, which is the one output
  // Stage A forbids. And because `appendLedgerObservation` had already mutated
  // `record.last_observation`, the identity dedup then suppressed every RETRY of that same
  // measurement as a duplicate: the first attempt was silent and the first silenced the rest.
  //
  // Drive the real failure, not a stub: make the ledger directory unwritable, which is exactly
  // how this reproduces in the field (a HOME whose .config is read-only).
  const ledgerDir = path.join(TMP_HOME, '.config', 'aigentry-telepty');
  fs.mkdirSync(ledgerDir, { recursive: true });

  const session = { id: 'ledger-1', type: 'spawned' };
  const pendingReport = { source: 'orch', injectId: 'inj-ledger', unconfirmedSettleDone: true };
  const busEvents = [];
  const delivered = [];
  const deps = {
    broadcastSessionEvent: (type, sid, _s, payload) => busEvents.push({ type, sid, payload }),
    resolveSessionAlias: (s) => s,
    sessions: { orch: { id: 'orch' }, 'ledger-1': session },
    deliverInjectionToSession: (srcId, _s, msg) => delivered.push({ srcId, msg }),
  };
  const measurement = () => ({
    sessionId: 'ledger-1', session, pendingReport,
    destination: 'idle', cause: 'silence_timeout', evidence: { silence_ms: 6000 },
    deliverToSource: true, trigger: 'transition', deps,
  });

  const begun = daemon.beginTrackedInjection({
    injectId: pendingReport.injectId, sessionId: 'ledger-1', source: 'orch', session,
  });
  assert.equal(begun.ok, true, 'the write-ahead record must commit while the store is still writable');
  const seqBefore = daemon.getTrackedInjection(pendingReport.injectId).observation_seq;

  fs.chmodSync(ledgerDir, 0o500);
  let first;
  try {
    first = recordObservation(measurement());
  } finally {
    fs.chmodSync(ledgerDir, 0o700);
  }

  assert.equal(first, 'tracking_persistence_failed',
    'the named result is right — it is the silence around it that is the defect');
  assert.equal(busEvents.filter(e => e.type === 'task_completion_unknown').length, 1,
    'a store that cannot be written is a condition to REPORT: the bus must still hear the absence');
  assert.equal(delivered.length, 1,
    'and the source waiting on this inject must still be told, not left inferring from silence');
  const body = busEvents[0].payload.extra;
  assert.equal(body.tracking_result, 'tracking_persistence_failed',
    'the envelope must NAME the durability gap rather than presenting a normal observation');
  assert.equal(body.completion_fact, null);
  assert.equal(body.terminal, false);

  // The in-memory record must be rolled back to exactly what is on disk. A `last_observation`
  // describing an append that never reached the ledger is a claim about durable state that was
  // not measured — and it is what turns the retry into a phantom duplicate.
  const rolledBack = daemon.getTrackedInjection(pendingReport.injectId);
  assert.equal(rolledBack.observation_seq, seqBefore,
    'a failed commit must not advance the durable sequence it failed to write');
  assert.notEqual(rolledBack.last_observation && rolledBack.last_observation.kind, 'pty_quiet',
    'the un-persisted observation must not be left standing as the record\'s last one');

  // The retry, once the store is writable again, is the FIRST successful statement of this
  // measurement — never a duplicate of one that only ever existed in memory.
  const second = recordObservation(measurement());
  assert.equal(second, 'observation_emitted',
    `the retry of an observation that never landed must be emitted, got ${JSON.stringify(second)}`);
  assert.equal(daemon.getTrackedInjection(pendingReport.injectId).last_observation.kind, 'pty_quiet');
  assert.equal(busEvents.filter(e => e.type === 'task_completion_unknown').length, 2);
  for (const d of delivered) {
    assert.ok(!TERMINAL_TEXT_RE.test(d.msg), `terminal outcome emitted: ${d.msg}`);
  }
});

// --- #843 a failed kill must not report success -----------------------------------------

test('failed_kill_is_not_success: DELETE reports the kill it could not confirm', () => {
  // `DELETE /api/sessions/:id` removed the registry record and answered
  // `{success:true, status:'force-removed'}` even when `ptyProcess.kill()` threw. The process may
  // still be running, and it is now untracked — the daemon has lost the ability to observe or kill
  // it — and the caller was told the teardown worked. `bin/session-cleanup.sh` is the operator
  // entrance here, so that success reads as "the worker is gone".
  //
  // The removal itself stays: leaving a half-torn record behind would be worse, and the record is
  // being dropped either way. What changes is that the response states which of the two happened.
  // Unit-tested through the pure decision because a real `ptyProcess.kill()` does not throw on a
  // reaped child (node-pty swallows ESRCH), so the branch is unreachable from an integration test —
  // and an unreachable branch that returns success is exactly what shipped.
  const ok = describeSessionTeardown(null);
  assert.equal(ok.httpStatus, 200);
  assert.equal(ok.body.success, true);
  assert.equal(ok.body.status, 'closing');

  const failed = describeSessionTeardown(new Error('kill EPERM'));
  assert.notEqual(failed.httpStatus, 200, 'a teardown that could not be confirmed is not a 200');
  assert.equal(failed.body.success, false);
  assert.equal(failed.body.code, 'KILL_FAILED');
  assert.match(String(failed.body.error), /kill EPERM/, 'the cause must survive into the response');
  assert.equal(failed.body.registry_removed, true,
    'the record IS gone — the caller has to know that too, or it will assume the session is still tracked');
});

// --- §8.1 arbitrary_reverse_message_is_not_report ---------------------------------------

test('arbitrary_reverse_message_is_not_report: no text is parsed as a terminal report', () => {
  // daemon.js:481 mapped EVERY reverse-routed payload to `report_complete` — including a
  // clarifying question — and CHANGELOG.md:122-125 records that mislabel as accepted. In
  // 0.8.0 an ordinary reverse-routed inject is an ordinary message: there is no terminal
  // producer and no text classifier at all.
  assert.equal(typeof daemon.resolveOutboundReportStatus, 'undefined',
    'the reverse-route completion verdict must not exist in 0.8.0');

  const reportEnforcement = require('../src/report-enforcement');
  assert.equal(typeof reportEnforcement.classifyReportPrompt, 'undefined',
    '0.8.0 classifies no report-shaped text: the validator returns in Stage B (#816/#817)');
});

// --- #843 a frozen reason contradicted by its own record --------------------------------

test('capability_reason_matches_the_record: a proven epoch is not reported as "no epoch fact"', () => {
  // `CAPABILITY_STAGE_A` is frozen with `session_authentication_reason: 'no_815_epoch_fact'` and
  // spread onto every ledger record — including records whose own `session_epoch` field holds the
  // epoch the session PROVED on its #815 handshake. One response body then carries both
  // `session_epoch: "<id>"` and a reason saying there is no epoch fact.
  //
  // §A4 requires capability gaps to be explicit; it does not license reporting a gap that was
  // measured shut. A reader reconciling those two fields has to decide which half of one object to
  // believe, which is worse than either answer alone.
  const proven = daemon.beginTrackedInjection({
    injectId: 'inj-epoch', sessionId: 'epoch-1', source: 'orch',
    session: { id: 'epoch-1', sessionEpoch: '1IWURA54wVOSjXlZmNVhsA' },
  });
  assert.equal(proven.ok, true);
  const record = daemon.getTrackedInjection('inj-epoch');
  assert.equal(record.session_epoch, '1IWURA54wVOSjXlZmNVhsA');
  assert.equal(record.session_epoch_reason, null);
  assert.notEqual(record.capability.session_authentication_reason, 'no_815_epoch_fact',
    'the record proves the epoch fact was measured — its capability block may not deny it');
  assert.equal(record.capability.session_authentication, 'observed');
  assert.equal(record.capability.session_authentication_reason, null);

  // The unproven case is untouched: an absence is still reported as an absence, with its reason.
  const unproven = daemon.beginTrackedInjection({
    injectId: 'inj-noepoch', sessionId: 'epoch-2', source: 'orch', session: { id: 'epoch-2' },
  });
  assert.equal(unproven.ok, true);
  const bare = daemon.getTrackedInjection('inj-noepoch');
  assert.equal(bare.session_epoch, null);
  assert.equal(bare.capability.session_authentication, 'unavailable');
  assert.equal(bare.capability.session_authentication_reason, 'no_815_epoch_fact');
});
