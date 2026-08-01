'use strict';

// telepty#60 Stage A §2.3 row 1 — the START PHASE must be observable.
//
// Design §2.3's first producer row is "constructor / `markStarting`" → `session_start_phase_observed`.
// `markStarting()` sets the normalized cause `lifecycle_starting`, but the CONSTRUCTOR assigned
// `this._state = STATES.STARTING` with `this._detail = null` directly, bypassing it. So a session
// that had merely been registered carried NO cause, and `mapObservationCause` — correctly failing
// closed — returned `unmapped_transition_cause`.
//
// Two things made that worse than a cosmetic gap:
//
//   1. `_tick` early-returns while the state is STARTING (session-state.js), so a registered
//      session that is never fed output NEVER LEAVES the start phase. It is not a transient
//      unmapped window on the way to a real observation; it is where the session permanently sits.
//   2. Stage A's whole promise is that absence is EMITTED, never inferred from silence. A
//      transition that can never fire is an observation that can never be emitted — a hole in
//      exactly the guarantee this release exists to make.
//
// It failed closed rather than lying, which is why it survived: nothing was ever mislabelled, the
// name was simply missing. This pins it, including the structural guard that made it possible —
// two independent definitions of the same initial cause, one of which was silently skipped.
//
// Pure: no daemon, no PTY, no HTTP. Machines are destroyed so the file exits on its own timers
// rather than depending on --test-force-exit (which, per this branch's REPORT, truncates counts).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SessionStateMachine,
  SessionStateManager,
  OBSERVATION_CAUSES,
  mapObservationCause,
} = require('../session-state');

// The observation a consumer would actually be served for this machine — the same derivation
// daemon.js uses in serializeSession and GET /api/sessions/:id/state.
function observationFor(sm) {
  const state = sm.getState();
  return mapObservationCause({
    destination: state.state,
    cause: state.detail ? state.detail.trigger : null,
    evidence: { ...(state.detail || {}), confidence: state.confidence },
  });
}

test('a freshly constructed machine is observable as its start phase (§2.3 row 1)', () => {
  const sm = new SessionStateMachine('start-phase-ctor');
  try {
    const observed = observationFor(sm);
    assert.equal(observed.kind, 'session_start_phase_observed',
      `the constructor must produce a mapped observation, got ${JSON.stringify(observed)}`);
    assert.equal(observed.cause, 'lifecycle_starting');
  } finally {
    sm.destroy();
  }
});

test('the constructor and markStarting() agree on the start cause', () => {
  // The structural guard. The defect was TWO definitions of one initial cause, with the
  // constructor's silently skipped; if they are ever allowed to drift again this fails, whichever
  // of the two is changed. That is the property, not the literal string.
  const constructed = new SessionStateMachine('start-phase-agree-a');
  const marked = new SessionStateMachine('start-phase-agree-b');
  try {
    marked.markStarting();
    const a = constructed.getState();
    const b = marked.getState();

    assert.deepEqual(
      a.detail && a.detail.trigger,
      b.detail && b.detail.trigger,
      'a session that was constructed and one that was explicitly marked are in the SAME phase; '
      + 'they must not report different causes for it'
    );
    assert.equal(observationFor(constructed).kind, observationFor(marked).kind);
  } finally {
    constructed.destroy();
    marked.destroy();
  }
});

test('a registered-but-never-fed session is observable, not permanently unmapped', () => {
  // The real-world path: daemon.js calls sessionStateManager.register() at /register and /spawn,
  // and a session that has not yet emitted PTY output sits here indefinitely because `_tick`
  // early-returns on STARTING. This is what `telepty list` / `telepty status` / the sidebar and
  // every bus subscriber were being served for it.
  const manager = new SessionStateManager();
  try {
    manager.register('start-phase-registered');
    // Through the manager's own accessor — the exact call daemon.js makes.
    const state = manager.getState('start-phase-registered');
    const observed = mapObservationCause({
      destination: state.state,
      cause: state.detail ? state.detail.trigger : null,
      evidence: { ...(state.detail || {}), confidence: state.confidence },
    });
    assert.notEqual(observed.kind, 'unmapped_transition_cause',
      'a registered session must not be permanently unobservable');
    assert.equal(observed.kind, 'session_start_phase_observed');
  } finally {
    manager.destroyAll();
  }
});

test('the start cause is a real mapping row admitting the start destination', () => {
  // Guards the shape rather than the value, so a future rename that updates BOTH definitions
  // still passes while one that points the constructor at a cause the table does not admit for
  // `starting` — the failure mode that produced `unmapped_transition_cause` — does not.
  const sm = new SessionStateMachine('start-phase-row');
  try {
    const detail = sm.getState().detail;
    assert.ok(detail && detail.trigger, 'the initial state must carry a measured cause');

    const row = OBSERVATION_CAUSES[detail.trigger];
    assert.ok(row, `the initial cause "${detail.trigger}" is not a declared observation cause`);
    assert.ok(
      row.destinations.includes('*') || row.destinations.includes('starting'),
      `the initial cause "${detail.trigger}" is not admitted for the "starting" destination, so it `
      + 'maps to unmapped_transition_cause'
    );
    // Required evidence must actually be satisfiable at construction, or the row still fails closed.
    assert.deepEqual(row.requires.filter((f) => detail[f] === undefined || detail[f] === null), [],
      'the initial detail is missing evidence its own mapping row requires');
  } finally {
    sm.destroy();
  }
});
