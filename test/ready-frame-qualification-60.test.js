'use strict';

// telepty#60 Stage A — §8.1 `ready_frame_is_qualified`.
//
// A bridge `ready` frame says a SURFACE looks ready to receive an inject. It says nothing about
// whether a turn ended, and it certainly says nothing about a task. The pre-Stage-A daemon fed an
// unqualified `ready` into the same auto-report path that produced TASK_COMPLETE, so a composer
// redraw could settle a dispatch.
//
// Stage A splits it three ways at the observation layer, and keeps the LEGACY frame distinct on
// purpose: a 0.7.1 bridge still sends a bare `{type:"ready"}`, and that frame must not be able to
// borrow the meaning of a qualified one just because a newer daemon is reading it (§3.7).
//
//   composer surface detected → ready_frame_composer_surface → composer_surface_observed
//   prompt suffix detected    → ready_frame_prompt_suffix    → prompt_suffix_observed
//   bare/unknown frame        → ready_frame_legacy_unqualified → legacy_ready_observed
//
// SCOPE — READ THIS BEFORE EXTENDING THE FILE
// -------------------------------------------
// The design's row describes a BRIDGE harness ("Claude registry-tail and generic `$ ` current
// frame"). That half cannot be written from this branch: src/transport/websocket.js:264 still
// handles a bare `{type:'ready'}` and never sets `session.readyKind` / `readyDetector` /
// `readyCliKey`, and websocket.js is out of this track's file boundary (base commit "NOT DONE"
// item 3, owned by the sibling doing the transport work). What IS implemented, and what this file
// pins, is the CONSUMER half: daemon.js:919-943 selects the cause and attaches the detector
// evidence from those session fields. When the bridge half lands, the producer side belongs in the
// same change as the producer.
//
// Hermetic: the exported fireAutoReport DI seam. No daemon spawn, no PTY, no WebSocket.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Hermetic require — see completion-unknown-observation-60.test.js:29-38.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty60-ready-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.PORT = '0';

const daemon = require('../daemon');
const { fireAutoReport } = daemon;
const { OBSERVATION_CAUSES, OBSERVATION_DISPLAY } = require('../session-state');

const NOW = 1_700_000_000_000;
const TERMINAL_TEXT_RE = /\b(TASK_COMPLETE|TASK_COMPLETE_WITH_REPORT|TASK_IDLE_UNCONFIRMED|TASK_ERROR)\b/;
const TERMINAL_EVENT_RE = /^(TASK_COMPLETE|TASK_COMPLETE_WITH_REPORT|TASK_IDLE_UNCONFIRMED|TASK_ERROR|TASK_IDLE_NO_REPORT|TASK_DEAD_NO_REPORT)$/;

// Drive the ready-signal entrance with a session carrying whatever the bridge qualified.
//
// THE DWELL STATE IS PINNED DELIBERATELY, AND IT IS FIDDLY. The #32 ready dwell at
// daemon.js:969-989 has TWO early returns before the emitter, and both are vacuity traps:
//
//   * submit evidence ALREADY present → `observation_duplicate`, emitting nothing. A fixture that
//     sets `submitConfirmedAt` to "make sure the dwell doesn't defer" lands here and asserts
//     nothing about qualification at all. (This file was written that way first; it went red on
//     the patched branch, which is how the trap was found rather than shipped.)
//   * still inside AUTO_REPORT_MIN_REAL_SECONDS, or a submit in progress → `observation_deferred`.
//
// The arms below take the FALL-THROUGH path, which is the real production shape for this row: a
// ready frame arriving long after a submit that never produced a verdict. Both early returns are
// asserted separately at the bottom of the file, because "named, not silent" is the §A2 property
// they have to satisfy.
function runReady({ readyKind, readyDetector, readyCliKey } = {}, { elapsedSec = 30 } = {}) {
  const delivered = [];
  const busEvents = [];
  const timers = [];
  const session = {
    id: 'worker-1',
    type: 'spawned',
    ...(readyKind !== undefined ? { readyKind } : {}),
    ...(readyDetector !== undefined ? { readyDetector } : {}),
    ...(readyCliKey !== undefined ? { readyCliKey } : {}),
  };
  const pendingReport = {
    source: 'orch',
    injectId: 'probe',
    injectedAt: new Date(NOW - elapsedSec * 1000).toISOString(),
    submitExpected: true,
    // A submit was attempted and NEVER produced a verdict — no confirmedAt, no sawWorking, no
    // accepted confirm — so `pendingReportHasSubmitEvidence` is false and the dwell does not treat
    // the frame as already answered. `submitInProgress` is false and elapsed is well past
    // AUTO_REPORT_MIN_REAL_SECONDS (1.0s), so it does not defer either: it falls through to the
    // emitter, which is the branch this file is about.
    submitStartedAt: new Date(NOW - elapsedSec * 1000 + 500).toISOString(),
    submitInProgress: false,
    // Skip the #48 settle debounce: this file is about which NAME a qualified frame gets, not
    // about when a follow-up is allowed to speak.
    unconfirmedSettleDone: true,
  };
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
  const decision = fireAutoReport('worker-1', session, pendingReport, 'ready-signal', deps);
  let guard = 0;
  while (timers.length && guard++ < 50) timers.shift()();

  const absence = busEvents.filter(e => e.type === 'task_completion_unknown');
  assert.equal(absence.length, 1, `expected 1 completion-absence emission, got ${absence.length}`);
  const body = absence[0].payload.extra || absence[0].payload;
  for (const d of delivered) {
    assert.ok(!TERMINAL_TEXT_RE.test(d.msg), `ready frame emitted terminal outcome: ${d.msg}`);
  }
  for (const e of busEvents) {
    assert.ok(!TERMINAL_EVENT_RE.test(e.type), `ready frame emitted terminal bus event: ${e.type}`);
  }
  return { body, decision, delivered };
}

// The three qualifications, each with the detector the bridge would have used.
const READY_MATRIX = [
  {
    label: 'claude registry-tail composer surface',
    session: { readyKind: 'composer_surface_observed', readyDetector: 'registry_tail', readyCliKey: 'claude' },
    kind: 'composer_surface_observed',
    trigger: 'ready_frame_composer_surface',
    detector: 'registry_tail',
  },
  {
    label: 'generic `$ ` current frame',
    session: { readyKind: 'prompt_suffix_observed', readyDetector: 'prompt_suffix', readyCliKey: 'bash' },
    kind: 'prompt_suffix_observed',
    trigger: 'ready_frame_prompt_suffix',
    detector: 'prompt_suffix',
  },
  {
    label: 'a 0.7.1 bridge sending a bare {type:"ready"}',
    session: {},                       // no readyKind at all — nothing was qualified
    kind: 'legacy_ready_observed',
    trigger: 'ready_frame_legacy_unqualified',
    // No detector — and that is the point. daemon.js:941 computes `detector:'unqualified'`, but the
    // legacy row declares `requires: []`, so the whitelist drops it. An unqualified frame therefore
    // carries no claim about HOW it was qualified, which is the only honest thing it can say.
    detector: undefined,
  },
];

test('ready_frame_is_qualified: each ready frame gets its own observation name and detector', () => {
  for (const row of READY_MATRIX) {
    const { body } = runReady(row.session);
    assert.equal(body.observation.kind, row.kind,
      `[${row.label}] expected ready_kind ${JSON.stringify(row.kind)}, got ${JSON.stringify(body.observation.kind)}`);
    assert.equal(body.observation.trigger, row.trigger,
      `[${row.label}] expected cause ${row.trigger}, got ${body.observation.trigger}`);
    // §2.3: the ready rows REQUIRE `detector`. A frame with no detector cannot be stated as
    // qualified — it fails closed rather than emitting the stronger name with a hole in it.
    assert.equal(body.observation.detector, row.detector, `[${row.label}] detector evidence`);
    // …and ONLY the declared evidence. daemon.js:942 also computes `evidence.cli_key`, but the
    // mapper is a whitelist over the row's `requires`, so it never reaches the observation. That
    // is the correct direction of failure (§2.3: "include only fields required by the selected
    // row"), and pinning it stops the whitelist from being quietly widened later — a name that can
    // acquire unrequired fields is a name that can acquire unmeasured ones.
    assert.equal(body.observation.cli_key, undefined,
      `[${row.label}] the mapper must not pass through evidence the row does not require`);
    // §A1/§A3 — readiness to RECEIVE is not an outcome, on any of the three.
    assert.equal(body.completion_fact, null, `[${row.label}] completion_fact must be null`);
    assert.equal(body.terminal, false, `[${row.label}] terminal must be false`);
  }
});

test('ready_frame_is_qualified: the three names are distinct, and the legacy frame cannot borrow a qualified one', () => {
  // The point of keeping `legacy_ready_observed` separate: an old bridge's unqualified frame is a
  // WEAKER measurement than either qualified frame, and it must stay legible as such no matter
  // which daemon version reads it.
  const kinds = READY_MATRIX.map(row => runReady(row.session).body.observation.kind);
  assert.equal(new Set(kinds).size, READY_MATRIX.length,
    `the three ready frames must not collapse into one name: ${kinds.join(', ')}`);

  // An unrecognised readyKind is a bridge speaking a vocabulary this daemon does not know. It
  // degrades to the legacy (weakest) name — never to a qualified one.
  const unknown = runReady({ readyKind: 'turn_finished_observed', readyDetector: 'invented' });
  assert.equal(unknown.body.observation.kind, 'legacy_ready_observed',
    'an unknown qualification must degrade downward, never upward');
});

test('ready_frame_is_qualified: readiness never establishes consumption', () => {
  // A composer that is ready to receive is, if anything, evidence the previous body is GONE from
  // the surface — which is exactly the shape that used to be read as "the inject was processed".
  for (const row of READY_MATRIX) {
    const { body } = runReady(row.session);
    assert.equal(body.consumption.status, 'not_established',
      `[${row.label}] a ready frame is not consumption evidence`);
  }
});

test('ready_frame_is_qualified: the ready rows are declared in the §2.3 table with detector required', () => {
  // The mapper is what actually enforces "no detector, no qualified name". If a row lost its
  // `requires:['detector']`, a bridge could emit a qualified name carrying no evidence of how it
  // was qualified, and nothing downstream could tell the difference.
  for (const row of READY_MATRIX) {
    const declared = OBSERVATION_CAUSES[row.trigger];
    assert.ok(declared, `${row.trigger} must exist in OBSERVATION_CAUSES`);
    assert.equal(declared.kind, row.kind);
    // Ready frames are transport-level and are not tied to a destination state.
    assert.deepEqual(declared.destinations, ['*']);
  }
  assert.deepEqual(OBSERVATION_CAUSES.ready_frame_composer_surface.requires, ['detector']);
  assert.deepEqual(OBSERVATION_CAUSES.ready_frame_prompt_suffix.requires, ['detector']);
  assert.deepEqual(OBSERVATION_CAUSES.ready_frame_legacy_unqualified.requires, []);
});

// Drive a ready frame WITHOUT forcing the fall-through, and report what the dwell decided plus
// everything it emitted. Separate from runReady because these paths emit nothing by design — the
// property under test is that they are NAMED, not that they speak.
function runDwell(pendingReportOverrides, { elapsedSec = 30 } = {}) {
  const busEvents = [];
  const timers = [];
  const session = { id: 'worker-1', type: 'spawned', readyKind: 'composer_surface_observed', readyDetector: 'registry_tail' };
  const pendingReport = {
    source: 'orch',
    injectId: 'probe',
    injectedAt: new Date(NOW - elapsedSec * 1000).toISOString(),
    submitExpected: true,
    unconfirmedSettleDone: true,
    ...pendingReportOverrides,
  };
  const deps = {
    now: () => NOW,
    setTimeout: (fn) => { timers.push(fn); return 0; },
    broadcastSessionEvent: (type, sid, _s, payload) => busEvents.push({ type, sid, payload }),
    resolveSessionAlias: (s) => s,
    sessions: { orch: { id: 'orch' }, 'worker-1': session },
    pendingReports: { 'worker-1': pendingReport },
    deliverInjectionToSession: () => {},
    getAutoState: () => 'idle',
    sampleChildCpu: () => null,
  };
  const decision = fireAutoReport('worker-1', session, pendingReport, 'ready-signal', deps);
  return { decision, busEvents, armedTimers: timers.length };
}

test('ready_frame_is_qualified: both dwell early returns are named, never a bare return', () => {
  // §A2 item 2: every eligible invocation returns a named nonterminal result. These two paths
  // deliberately emit NOTHING — a ready frame that adds no new measurement should not manufacture
  // an observation — but "emits nothing" and "returns nothing" are different, and only the second
  // is the defect. The caller must be able to tell a considered no-op from a fallthrough.

  // (1) the submit verdict is already in: the frame adds no measurement.
  const answered = runDwell({
    submitConfirmedAt: new Date(NOW - 2_000).toISOString(),
    submitConfirm: { accepted: true, reason: 'body_consumed', ambiguous: false },
  });
  assert.equal(answered.decision, 'observation_duplicate',
    `an already-answered submit must return a named result, got ${JSON.stringify(answered.decision)}`);
  assert.equal(answered.busEvents.length, 0, 'a duplicate measurement must not be re-broadcast');

  // (2) the submit is still running: the verdict is coming, so the frame waits for it.
  const inProgress = runDwell({ submitInProgress: true });
  assert.equal(inProgress.decision, 'observation_deferred',
    `a submit in progress must return a named result, got ${JSON.stringify(inProgress.decision)}`);
  assert.equal(inProgress.armedTimers, 1, 'the deferral must arm a re-check, not drop the frame');

  // (3) too early — the frame arrived inside the minimum-real floor.
  const tooEarly = runDwell({}, { elapsedSec: 0.2 });
  assert.equal(tooEarly.decision, 'observation_deferred',
    `a frame inside the real-seconds floor must return a named result, got ${JSON.stringify(tooEarly.decision)}`);
  assert.equal(tooEarly.armedTimers, 1);
});

test('ready_frame_is_qualified: no ready observation renders as done, and the legacy frame has no green', () => {
  // §8.5.5/§8.5.12: presentation is keyed by observation KIND. A ready frame is a delivery-surface
  // hint; if any of these picked up the internal-idle green pill the sidebar would show a dispatch
  // as succeeded the moment its composer redrew.
  for (const row of READY_MATRIX) {
    const display = OBSERVATION_DISPLAY[row.kind];
    // These three rows are deliberately absent from OBSERVATION_DISPLAY: an undeclared kind falls
    // through to the neutral `unmapped_transition_cause` entry rather than to a success style.
    const effective = display || OBSERVATION_DISPLAY.unmapped_transition_cause;
    assert.notEqual(effective.tone, 'done', `[${row.kind}] a ready frame must never render as done`);
    assert.notEqual(effective.color, '\x1b[32m', `[${row.kind}] a ready frame must never render green`);
  }
});
