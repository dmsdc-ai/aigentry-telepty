'use strict';

// telepty#60 Stage A — §8.1 `fresh_busy_edge_requires_accepted_submit` +
// `launcher_watermark_is_not_consumption`, table-driven.
//
// The single admission this release allows: consumption is `observed` ONLY when a qualified fresh
// busy edge and an accepted, non-ambiguous, SCREEN-DERIVED submit confirmation both hold. Every
// other shape is `not_established` with a literal basis that names what WAS measured (§A3).
//
// WHY THIS FILE DRIVES THE PRODUCTION ORDER RATHER THAN SEEDING THE FIELDS
// -----------------------------------------------------------------------
// The design states the admission conjuncts at the transition site, but `submitConfirm` does not
// exist at that instant: its strongest reason, `state_working`, is PRODUCED BY the very transition
// being judged (src/submit-gate.js:218-227). A test that seeds `injectConsumptionCandidate` and
// `submitConfirm` together therefore proves nothing about whether arm A is reachable in
// production — it would stay green against an implementation in which `observed` can never occur.
// So every arm here runs the real sequence:
//
//   1. `markPendingReportSubmitStarted`-shaped state (submitStartedAt is set at the CR);
//   2. `maybeRecordInjectConsumption(pr, from, to, sinceMs)` — the real edge recorder, at the real
//      transition, recording a CANDIDATE only;
//   3. the confirmation lands afterwards, as `markPendingReportSubmitConfirmed` /
//      `markPendingReportSubmitUnconfirmed` write it;
//   4. `fireAutoReport` at the later idle, whose emitted envelope carries the verdict.
//
// The assertion is read off the EMITTED observation, not off a helper's return value, so an arm
// cannot pass while being unreachable from the daemon's own call path.
//
// Hermetic: no daemon spawn, no PTY, no HTTP — the exported DI seam, as
// test/completion-unknown-observation-60.test.js does.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Hermetic require: with the real HOME, requiring daemon.js restores every live persisted session
// and arms its timers inside this process. See completion-unknown-observation-60.test.js:29-38.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty60-consume-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.PORT = '0';

const daemon = require('../daemon');
const { fireAutoReport, maybeRecordInjectConsumption, maybeRecordLauncherConsumption } = daemon;

const NOW = 1_700_000_000_000;
const TERMINAL_TEXT_RE = /\b(TASK_COMPLETE|TASK_COMPLETE_WITH_REPORT|TASK_IDLE_UNCONFIRMED|TASK_ERROR)\b/;

// Elapsed used by every non-launcher arm. 30s is past the #48 settle and past the launcher floor,
// so no arm can pass merely because it was too early for a decision to be made.
const ELAPSED_SEC = 30;
const SUBMIT_STARTED_MS = NOW - 29_000;
const EDGE_SINCE_MS = NOW - 28_000; // the turn began AFTER the CR — a fresh edge

// Build the pendingReport in the state the submit path leaves it in at the CR, before any
// confirmation exists.
function pendingAtSubmit(overrides = {}) {
  return {
    source: 'orch',
    injectId: 'probe',
    injectedAt: new Date(NOW - ELAPSED_SEC * 1000).toISOString(),
    submitExpected: true,
    submitStartedAt: new Date(SUBMIT_STARTED_MS).toISOString(),
    injectedBodyPreview: 'REPORT when done',
    ringBytesAtInject: 0,
    ...overrides,
  };
}

// Run the real sequence and return the emitted envelope body plus everything observable.
function runArm({ pendingReport, edge, confirm, session, elapsedSec = ELAPSED_SEC, extraDeps = {} }) {
  const delivered = [];
  const busEvents = [];
  const timers = [];
  const sess = session || { id: 'worker-1', type: 'spawned' };

  // (2) the transition fires FIRST — the recorder sees no confirmation, exactly as in production.
  let edgeRecorded = null;
  if (edge) {
    edgeRecorded = maybeRecordInjectConsumption(pendingReport, edge.from, edge.to, edge.sinceMs);
  }
  // (3) …and only then does the confirmation land.
  if (confirm !== undefined) pendingReport.submitConfirm = confirm;

  // The #48 settle window debounces FOLLOW-UP observations; the arms under test are the admission
  // conjuncts, not the debounce, so skip straight to the emit (the debounce is covered by
  // completion-unknown-observation-60.test.js's totality arms).
  pendingReport.unconfirmedSettleDone = true;

  const deps = {
    now: () => NOW,
    setTimeout: (fn) => { timers.push(fn); return 0; },
    broadcastSessionEvent: (type, sid, _s, payload) => busEvents.push({ type, sid, payload }),
    resolveSessionAlias: (s) => s,
    sessions: { orch: { id: 'orch' }, 'worker-1': sess },
    pendingReports: { 'worker-1': pendingReport },
    deliverInjectionToSession: (srcId, _s, msg) => delivered.push({ srcId, msg }),
    getAutoState: () => 'idle',
    sampleChildCpu: () => null,
    ...extraDeps,
  };
  const decision = fireAutoReport('worker-1', sess, pendingReport, 'real-idle', deps);
  let guard = 0;
  while (timers.length && guard++ < 50) timers.shift()();

  const absence = busEvents.filter(e => e.type === 'task_completion_unknown');
  assert.equal(absence.length, 1, `expected 1 completion-absence emission, got ${absence.length}`);
  const body = absence[0].payload.extra || absence[0].payload;
  for (const d of delivered) {
    assert.ok(!TERMINAL_TEXT_RE.test(d.msg), `non-fact measurement emitted terminal outcome: ${d.msg}`);
  }
  return { body, decision, edgeRecorded, pendingReport };
}

// ---------------------------------------------------------------------------------------------
// §8.1 fresh_busy_edge_requires_accepted_submit — the four arms, both qualifying edge shapes
// ---------------------------------------------------------------------------------------------
//
// `edge` is the transition the recorder is handed; `confirm` is what the submit path writes
// afterwards. Expected values are read off the EMITTED envelope's `consumption` block.
const ADMISSION_MATRIX = [
  // (A) accepted, non-ambiguous, screen-derived → the ONLY admission.
  {
    label: 'A/idle→working: accepted non-ambiguous body_consumed',
    edge: { from: 'idle', to: 'working', sinceMs: EDGE_SINCE_MS },
    confirm: { accepted: true, reason: 'body_consumed', ambiguous: false },
    expect: { status: 'observed', basis: 'fresh_busy_transition' },
  },
  {
    label: 'A/waiting→thinking: accepted non-ambiguous state_working',
    edge: { from: 'waiting', to: 'thinking', sinceMs: EDGE_SINCE_MS },
    confirm: { accepted: true, reason: 'state_working', ambiguous: false },
    expect: { status: 'observed', basis: 'fresh_busy_transition' },
  },
  // (B) accepted but ambiguous, or accepted for a reason that measured no screen at all. Four
  // production confirm sites normalize to {accepted:true, ambiguous:false} for reasons that read
  // nothing — force (daemon.js:3661), gate_off (:3747), redelivered (:1363), empty_body (:1432).
  // `accepted === true` is therefore NOT the predicate; the screen-derived whitelist is.
  {
    label: 'B/ambiguous accept on a qualifying edge',
    edge: { from: 'idle', to: 'working', sinceMs: EDGE_SINCE_MS },
    confirm: { accepted: true, reason: 'state_working', ambiguous: true },
    expect: { status: 'not_established', basis: 'no_consumption_evidence' },
  },
  {
    label: 'B/force-only accept on a qualifying edge',
    edge: { from: 'idle', to: 'working', sinceMs: EDGE_SINCE_MS },
    confirm: { accepted: true, reason: 'force', ambiguous: false },
    expect: { status: 'not_established', basis: 'no_consumption_evidence' },
  },
  {
    label: 'B/gate_off accept on a qualifying edge',
    edge: { from: 'idle', to: 'working', sinceMs: EDGE_SINCE_MS },
    confirm: { accepted: true, reason: 'gate_off', ambiguous: false },
    expect: { status: 'not_established', basis: 'no_consumption_evidence' },
  },
  // (C) REJECTION PRECEDENCE. The edge qualifies AND a stale durable consumption field is present
  // from an earlier turn — and the rejection still wins, because it is evaluated before any
  // durable field is read. If the order were reversed this arm would return `observed`, which is
  // exactly the defect `observeConsumptionEvidence` shipped: it returned `consumed_recorded`
  // before ever looking at `accepted:false`.
  {
    label: 'C/positive rejection outranks a qualifying edge AND a stale durable field',
    seed: { injectConsumedAt: new Date(NOW - 600_000).toISOString(), injectConsumedVia: 'fresh_busy_transition' },
    edge: { from: 'idle', to: 'working', sinceMs: EDGE_SINCE_MS },
    confirm: { accepted: false, reason: 'body_still_visible' },
    expect: { status: 'not_established', basis: 'submit_rejection_observed' },
  },
  // (D) no confirmation at all — the submit never resolved. Absence of a rejection is not consent.
  {
    label: 'D/missing confirmation on a qualifying edge',
    edge: { from: 'idle', to: 'working', sinceMs: EDGE_SINCE_MS },
    confirm: undefined,
    expect: { status: 'not_established', basis: 'no_consumption_evidence' },
  },
];

test('fresh_busy_edge_requires_accepted_submit: only an accepted, non-ambiguous, screen-derived confirm admits', () => {
  for (const row of ADMISSION_MATRIX) {
    const pendingReport = pendingAtSubmit(row.seed || {});
    const { body } = runArm({ pendingReport, edge: row.edge, confirm: row.confirm });

    assert.equal(body.consumption.status, row.expect.status,
      `[${row.label}] expected consumption.status ${row.expect.status}, got ${body.consumption.status}`);
    assert.equal(body.consumption.basis, row.expect.basis,
      `[${row.label}] expected consumption.basis ${row.expect.basis}, got ${body.consumption.basis}`);
    // §A1: consumption is never a completion fact, not even on the arm that IS observed.
    assert.equal(body.completion_fact, null, `[${row.label}] completion_fact must be null`);
    assert.equal(body.terminal, false, `[${row.label}] terminal must be false`);
    // §8.1: "Only A may set/retain injectConsumedAt". In Stage A NO path writes that field any
    // more — the durable consumption fact was the thing that could outlive its evidence — so the
    // strict reading is that no arm, including A, may create it.
    assert.equal(pendingReport.injectConsumedAt === undefined || row.seed !== undefined, true,
      `[${row.label}] no arm may create injectConsumedAt`);
  }
});

test('fresh_busy_edge_requires_accepted_submit: arm A carries its provenance, not just its verdict', () => {
  // A verdict with no provenance cannot be audited later, and §3.10 requires the evaluation point
  // to be recorded precisely because it is NOT where the design first stated the predicate.
  const pendingReport = pendingAtSubmit();
  const { body } = runArm({
    pendingReport,
    edge: { from: 'idle', to: 'working', sinceMs: EDGE_SINCE_MS },
    confirm: { accepted: true, reason: 'body_consumed', ambiguous: false },
  });
  assert.equal(body.consumption.status, 'observed');
  assert.equal(body.consumption.submit_confirm_reason, 'body_consumed');
  assert.equal(body.consumption.transition_from, 'idle');
  assert.equal(body.consumption.transition_to, 'working');
  assert.equal(body.consumption.evaluated_at, 'consumption_classification');
});

// ---------------------------------------------------------------------------------------------
// The edge gate itself: which transitions may become a candidate at all
// ---------------------------------------------------------------------------------------------

const EDGE_GATE = [
  {
    label: 'starting→working is #537 startup pollution, not a turn entrance',
    edge: { from: 'starting', to: 'working', sinceMs: EDGE_SINCE_MS }, recorded: false,
  },
  {
    label: 'working→thinking is a mid-turn sub-state flip of a turn that is not ours',
    edge: { from: 'working', to: 'thinking', sinceMs: EDGE_SINCE_MS }, recorded: false,
  },
  {
    label: 'idle→idle is not a turn entrance',
    edge: { from: 'idle', to: 'idle', sinceMs: EDGE_SINCE_MS }, recorded: false,
  },
  {
    label: 'a turn that began BEFORE our CR is the #617 busy-park case',
    edge: { from: 'idle', to: 'working', sinceMs: SUBMIT_STARTED_MS - 5_000 }, recorded: false,
  },
  {
    label: 'idle→working after the CR qualifies',
    edge: { from: 'idle', to: 'working', sinceMs: EDGE_SINCE_MS }, recorded: true,
  },
  {
    label: 'waiting→thinking after the CR qualifies',
    edge: { from: 'waiting', to: 'thinking', sinceMs: EDGE_SINCE_MS }, recorded: true,
  },
];

test('fresh_busy_edge_requires_accepted_submit: the edge gate admits only a post-CR entrance from a non-busy state', () => {
  for (const row of EDGE_GATE) {
    const pendingReport = pendingAtSubmit();
    // The same accepted, non-ambiguous, screen-derived confirmation on EVERY row, so the only
    // thing that can differ in the verdict is the edge.
    const { body, edgeRecorded } = runArm({
      pendingReport,
      edge: row.edge,
      confirm: { accepted: true, reason: 'body_consumed', ambiguous: false },
    });
    assert.equal(edgeRecorded, row.recorded,
      `[${row.label}] expected edge recorded=${row.recorded}, got ${edgeRecorded}`);
    assert.equal(body.consumption.status, row.recorded ? 'observed' : 'not_established',
      `[${row.label}] edge recorded=${edgeRecorded} but consumption.status=${body.consumption.status}`);
  }
});

test('fresh_busy_edge_requires_accepted_submit: a non-submit text inject records no edge at all', () => {
  // No submitStartedAt: nothing was ever CR'd, so no transition can be attributed to this inject.
  const pendingReport = pendingAtSubmit({ submitStartedAt: undefined, submitExpected: false });
  const { body, edgeRecorded } = runArm({
    pendingReport,
    edge: { from: 'idle', to: 'working', sinceMs: EDGE_SINCE_MS },
    confirm: { accepted: true, reason: 'body_consumed', ambiguous: false },
  });
  assert.equal(edgeRecorded, false, 'a turn with no CR behind it cannot be our consumption');
  assert.equal(body.consumption.status, 'not_established');
});

// ---------------------------------------------------------------------------------------------
// §8.1 launcher_watermark_is_not_consumption
// ---------------------------------------------------------------------------------------------

test('launcher_watermark_is_not_consumption: submit accepted + output advanced is telemetry, not a turn', () => {
  // #721's watermark keeps its whole calculation and loses its false name. Its own source comment
  // admits the hole: "a never-started wrapped worker whose stale pending report RE-FIRES real-idle
  // > floor later can satisfy (a-d) and false-complete". A signal that a never-started worker can
  // satisfy is not a measurement of a started turn.
  const session = {
    id: 'worker-1',
    type: 'wrapped',              // the watermark is scoped to launcher sessions
    outputRing: ['boot banner\n'],
    outputRingTotalBytes: 4096,   // the ring advanced past the inject watermark (0)
  };
  const pendingReport = pendingAtSubmit();
  // A launcher's accept is the force/ambiguous shape — which is exactly why (c)+(d) were bolted on.
  const { body } = runArm({
    pendingReport,
    edge: null,                   // NO fresh non-busy→busy edge: a launcher child never rides one
    confirm: { accepted: true, reason: 'force', ambiguous: true },
    session,
  });

  assert.equal(body.consumption.status, 'not_established',
    'the launcher watermark must never establish consumption');
  assert.equal(body.consumption.basis, 'submit_accepted_and_output_advanced');
  assert.equal(body.consumption.ring_bytes_delta, 4096);
  assert.equal(body.consumption.elapsed_ms, ELAPSED_SEC * 1000);
  assert.equal(body.completion_fact, null);
  // The durable consumption field is not written by this path any more — that write is what let a
  // watermark masquerade as #619's genuine fresh-turn fact downstream.
  assert.equal(pendingReport.injectConsumedAt, undefined,
    'the launcher path must not write injectConsumedAt');
  // The calculation itself is preserved: the telemetry fields exist and are populated.
  assert.equal(typeof pendingReport.launcherWatermarkAt, 'string');
});

test('launcher_watermark_is_not_consumption: the watermark loses to a qualifying fresh edge, and to a rejection', () => {
  // Ordering inside classifyConsumption, pinned from the outside: the watermark sits BELOW the one
  // positive admission and BELOW rejection precedence, so it can neither manufacture nor mask a
  // verdict that was actually measured.
  const session = { id: 'worker-1', type: 'wrapped', outputRing: ['x'], outputRingTotalBytes: 4096 };

  const consumed = pendingAtSubmit();
  const a = runArm({
    pendingReport: consumed,
    edge: { from: 'idle', to: 'working', sinceMs: EDGE_SINCE_MS },
    confirm: { accepted: true, reason: 'body_consumed', ambiguous: false },
    session,
  });
  assert.equal(a.body.consumption.basis, 'fresh_busy_transition',
    'a real fresh edge must not be reported as a watermark');

  const rejected = pendingAtSubmit();
  const b = runArm({
    pendingReport: rejected,
    edge: null,
    confirm: { accepted: false, reason: 'body_still_visible' },
    session,
  });
  assert.equal(b.body.consumption.basis, 'submit_rejection_observed',
    'a positive rejection must not be masked by watermark telemetry');
});

test('launcher_watermark_is_not_consumption: the watermark recorder itself keeps every #721 conjunct', () => {
  // The four conjuncts are the calculation Stage A preserves verbatim; only the NAME changed. If
  // any of them quietly relaxed, the telemetry would start appearing on turns it never described.
  const base = () => ({
    submitExpected: true,
    submitStartedAt: new Date(SUBMIT_STARTED_MS).toISOString(),
    submitConfirm: { accepted: true, reason: 'force', ambiguous: true },
    ringBytesAtInject: 0,
  });
  const wrapped = { type: 'wrapped', outputRingTotalBytes: 4096 };

  assert.equal(maybeRecordLauncherConsumption({ type: 'spawned', outputRingTotalBytes: 4096 }, base(), 60, NOW), false,
    '(scope) a non-wrapped session has no launcher watermark');
  assert.equal(maybeRecordLauncherConsumption(wrapped, { ...base(), submitStartedAt: undefined }, 60, NOW), false,
    '(a) nothing was CR\'d');
  assert.equal(maybeRecordLauncherConsumption(wrapped, { ...base(), submitConfirm: { accepted: false, reason: 'no_land' } }, 60, NOW), false,
    '(b) the CR was refused');
  assert.equal(maybeRecordLauncherConsumption({ type: 'wrapped', outputRingTotalBytes: 0 }, base(), 60, NOW), false,
    '(c) the ring never advanced past the inject watermark');
  assert.equal(maybeRecordLauncherConsumption(wrapped, base(), 29, NOW), false,
    '(d) elapsed is below the 30s floor that guards the ~4.5s startup settle');
  assert.equal(maybeRecordLauncherConsumption(wrapped, base(), 30, NOW), true,
    'all four conjuncts hold at the floor');
});

// =============================================================================================
// #843 — the one sentence the orchestrator actually reads
// =============================================================================================

const {
  formatCompletionUnknownText,
  buildCompletionUnknown,
} = require('../src/completion-observation');

test('#843: the absence text states the measurement its NAME is made of, not a bigger number', () => {
  // `formatCompletionUnknownText` tested `elapsed_ms` FIRST and only fell back to `silence_ms`.
  // Those are different measurements: `silence_ms` is how long the PTY has been quiet — the thing
  // `pty_quiet` is named after and the only evidence its row requires — while `elapsed_ms` is time
  // since the inject, a qualifier that rides along on every row. A 3-second silence 900 seconds
  // into a dispatch was therefore delivered as `pty_quiet=900.0s`: the observation's own name
  // attached to a number two orders of magnitude larger than what it measured, in the release
  // that renamed everything to stop exactly this. It is also the single line the orchestrator
  // reads, so it is the overclaim with the widest blast radius in the file.
  const envelope = buildCompletionUnknown({
    sessionId: 'worker-1',
    injectId: 'inj-1',
    observation: { kind: 'pty_quiet', trigger: 'silence_timeout', silence_ms: 3000, elapsed_ms: 900_000 },
    consumption: { status: 'not_established', basis: 'no_consumption_evidence' },
  });
  const text = formatCompletionUnknownText(envelope);

  assert.match(text, /pty_quiet=3\.0s/, 'the named measurement must carry its own value');
  assert.doesNotMatch(text, /pty_quiet=900\.0s/,
    'the quiet name must never be attached to the elapsed-since-inject number');
  // Elapsed is real and worth stating — as itself, under its own label.
  assert.match(text, /elapsed_since_inject=900\.0s/,
    'elapsed time is a measurement too; the fix is to name it, not to drop it');
  assert.match(text, /consumption=not_established/);
  assert.doesNotMatch(text, /\b(TASK_COMPLETE|TASK_ERROR)\b/);
});

test('#843: a row with no silence measurement states its name bare, and elapsed separately', () => {
  const noSilence = formatCompletionUnknownText(buildCompletionUnknown({
    sessionId: 'worker-1',
    observation: { kind: 'output_observed', trigger: 'output_received', elapsed_ms: 4200 },
  }));
  assert.match(noSilence, /output_observed;/, 'a row that measured no silence claims none');
  assert.doesNotMatch(noSilence, /output_observed=/,
    'and must not borrow elapsed as though it were the thing the name measures');
  assert.match(noSilence, /elapsed_since_inject=4\.2s/);

  const neither = formatCompletionUnknownText(buildCompletionUnknown({
    sessionId: 'worker-1',
    observation: { kind: 'owner_transport_detached', trigger: 'owner_transport_detached' },
  }));
  assert.match(neither, /owner_transport_detached; consumption=/);
  assert.doesNotMatch(neither, /elapsed_since_inject/, 'no elapsed measured, none stated');
});
