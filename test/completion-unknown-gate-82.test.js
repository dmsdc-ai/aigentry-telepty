'use strict';

// gh#82 (F) — `TASK_COMPLETION_UNKNOWN` fired on essentially every inject to a Claude Code worker,
// and (D)'s other half — `telepty list` could not tell a live wrapper from a dead leftover.
//
// (F) The reporter sent roughly a dozen injects to five `telepty allow … claude` workers in one
// day and got an UNKNOWN for nearly all of them; every one was contradicted by the worker's own
// REPORT. Four measured `pty_quiet` at 5.1–5.9s (a model thinking), and one reported
// `repeated_error_pattern_observed` while the screen held nothing but spinner frames
// (`Twisting… ✻ ✽ ✶`), confirmed with `read-screen`. The cause is structural, not tuning:
// `src/completion-observation.js` hardcodes `outcome_protocol: 'unavailable'` (Stage B deferred to
// 0.9.0), so the screen heuristics carry the whole judgement. A notification that is wrong every
// time is worse than none — an orchestrator that acts on it interrupts healthy work, and one that
// learns to ignore it also ignores the true positives.
//
// So while the outcome protocol is unavailable, only absences made of a DAEMON-MEASURED process or
// transport fact are pushed to the source. Everything is still recorded: the bus event and the
// ledger append are unconditional, and `TELEPTY_COMPLETION_UNKNOWN_PUSH=1` restores the push.
//
// (D) `telepty list` showed `STALE (OWNER_DISCONNECTED_STALE), Clients: 0` for the session that was
// LIVE and serving a human; `telepty kill` on that line would have destroyed 10 hours of work. The
// pids were already in the payload — only the probe and the words were missing.
//
// Hermetic: no daemon spawn, no PTY, no HTTP. Uses the recordObservation/fireAutoReport DI seam
// exactly as test/completion-unknown-observation-60.test.js does.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Hermetic require: with the real HOME, `require('../daemon')` restores every live persisted
// session into this test process. Redirect HOME and pin PORT=0 BEFORE the require.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty82-gate-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.PORT = '0';

const daemon = require('../daemon');
const { recordObservation } = daemon;
const {
  shouldPushCompletionUnknown,
  PROCESS_FACT_OBSERVATION_KINDS,
  CAPABILITY_STAGE_A,
  buildCompletionUnknown,
} = require('../src/completion-observation');
const sessionView = require('../src/cli/session-view');

// --- (F) the push gate, driven through the total emitter ---------------------------------

// One observation, with everything observable captured: what the source was told, what the bus
// heard. `cause`/`destination` select the row in session-state.js OBSERVATION_CAUSES.
function observe({ cause, destination, evidence = {}, env = null }) {
  const delivered = [];
  const busEvents = [];
  const session = { id: 'worker-1', type: 'wrapped' };
  const injectId = `gate-82-${cause}-${Date.now()}`;
  // The ledger record has to exist for "the observation is still recorded and queryable" to be
  // the thing under test rather than an assumption. Created the way the inject handler does.
  const begun = daemon.beginTrackedInjection({ injectId, sessionId: 'worker-1', source: 'orch', session });
  assert.equal(begun.ok, true, 'the tracked record must commit before the observation');

  const previous = process.env.TELEPTY_COMPLETION_UNKNOWN_PUSH;
  if (env === null) delete process.env.TELEPTY_COMPLETION_UNKNOWN_PUSH;
  else process.env.TELEPTY_COMPLETION_UNKNOWN_PUSH = env;
  try {
    const result = recordObservation({
      sessionId: 'worker-1',
      session,
      pendingReport: { source: 'orch', injectId },
      destination,
      cause,
      evidence: { elapsed_ms: 186900, silence_ms: 5900, ...evidence },
      deliverToSource: true,
      trigger: 'transition',
      deps: {
        sessions: { orch: { id: 'orch' }, 'worker-1': session },
        resolveSessionAlias: (s) => s,
        broadcastSessionEvent: (type, sid, _sess, payload) => busEvents.push({ type, sid, payload }),
        deliverInjectionToSession: (srcId, _srcSession, msg) => delivered.push({ srcId, msg }),
      },
    });
    return { result, delivered, busEvents, injectId };
  } finally {
    if (previous === undefined) delete process.env.TELEPTY_COMPLETION_UNKNOWN_PUSH;
    else process.env.TELEPTY_COMPLETION_UNKNOWN_PUSH = previous;
  }
}

// The absence must still be EMITTED (§A2) — suppressing the PUSH may never become silence. Both
// halves are checked: the bus event a subscriber hears, and the ledger row a poll can read back.
function assertRecorded(r, kind) {
  const absences = r.busEvents.filter((e) => e.type === 'task_completion_unknown');
  assert.equal(absences.length, 1, `expected the absence on the bus exactly once, got ${absences.length}`);
  const body = absences[0].payload.extra;
  assert.equal(body.observation.kind, kind, 'the bus must carry the kind that was measured');
  assert.equal(body.completion_fact, null);
  assert.equal(body.terminal, false);
  assert.equal(r.result, 'observation_emitted', 'the ledger append still happened');
  const record = daemon.getTrackedInjection(r.injectId);
  assert.equal(record.last_observation.kind, kind, 'the observation is queryable by inject_id');
}

test('gh#82(F): `pty_quiet` is NOT pushed to the source while the outcome protocol is unavailable', () => {
  const r = observe({ cause: 'silence_timeout', destination: 'idle' });
  assert.deepEqual(r.delivered, [],
    'the reporter\'s 4-of-5 shape: ~5s of silence is a model thinking, and it was pushed as an '
    + 'alarm on essentially every inject');
  assertRecorded(r, 'pty_quiet');
});

test('gh#82(F): a repeated-error pattern is NOT pushed either — it matched spinner frames', () => {
  const r = observe({
    cause: 'repeated_error_pattern',
    destination: 'error',
    evidence: { error_fingerprint: 'twisting-spinner', repeat_count: 3, window_ms: 20000 },
  });
  assert.deepEqual(r.delivered, [], 'the reporter\'s 5th shape, confirmed against read-screen');
  assertRecorded(r, 'repeated_error_pattern_observed');
});

test('gh#82(F): `session_process_exited` IS still pushed — a worker that actually died is the '
  + 'one absence an orchestrator must not miss', () => {
  const r = observe({
    cause: 'process_exit',
    destination: 'dead',
    evidence: { exit_observed_at: '2026-09-07T07:45:12.503Z' },
  });
  assert.equal(r.delivered.length, 1, 'a measured child exit is not a screen scrape');
  assert.equal(r.delivered[0].srcId, 'orch');
  assert.match(r.delivered[0].msg, /session_process_exited/);
  assertRecorded(r, 'session_process_exited');
});

test('gh#82(F): `session_termination_requested` is NOT pushed — it tells the requester what the '
  + 'requester just did, about a session that is already gone', () => {
  const r = observe({
    cause: 'termination_requested',
    destination: 'dead',
    evidence: { reason: 'operator_delete', requested_at: '2026-09-07T07:45:12.503Z' },
  });
  assert.deepEqual(r.delivered, []);
  assertRecorded(r, 'session_termination_requested');
});

test('gh#82(F): TELEPTY_COMPLETION_UNKNOWN_PUSH=1 restores the 0.8.1 push, opt-in', () => {
  const r = observe({ cause: 'silence_timeout', destination: 'idle', env: '1' });
  assert.equal(r.delivered.length, 1, 'an operator who wants every absence can still have it');
  assert.match(r.delivered[0].msg, /TASK_COMPLETION_UNKNOWN: worker-1/);
  assertRecorded(r, 'pty_quiet');
});

test('gh#82(F): the gate is keyed on the capability, so Stage B lifts it with no change here', () => {
  const screenDerived = { observation: { kind: 'pty_quiet' } };
  assert.equal(
    shouldPushCompletionUnknown({ ...screenDerived, capability: CAPABILITY_STAGE_A }), false,
    'unavailable → screen-derived rows are withheld');
  assert.equal(
    shouldPushCompletionUnknown({ ...screenDerived, capability: { outcome_protocol: 'available' } }), true,
    'once an outcome protocol exists, the screen is no longer carrying the judgement');
  // An envelope with no capability block at all defaults to Stage A (buildCompletionUnknown), so
  // the gate must not fail OPEN on a missing field.
  assert.equal(shouldPushCompletionUnknown(buildCompletionUnknown({ sessionId: 'x' })), false);
  for (const kind of PROCESS_FACT_OBSERVATION_KINDS) {
    assert.equal(
      shouldPushCompletionUnknown({ capability: CAPABILITY_STAGE_A, observation: { kind } }), true,
      `${kind} is a daemon-measured fact, not a screen reading`);
  }
});

// --- (D) the list line: a STALE record whose processes are alive is not a leftover -------

const STALE = { id: 'orchestrator', host: '127.0.0.1', healthStatus: 'STALE', healthReason: 'OWNER_DISCONNECTED_STALE' };

test('gh#82(D): a STALE session whose owner pid is ALIVE says so on the list line', () => {
  const enriched = sessionView.enrichSessionIdle(
    { ...STALE, ownerPid: process.pid, ptyPid: process.pid }, Date.now());
  assert.equal(enriched.owner_alive, true, '--json carries the booleans');
  assert.equal(enriched.pty_alive, true);
  const line = sessionView.formatSessionStatusWithIdle(enriched);
  assert.match(line, /STALE \(OWNER_DISCONNECTED_STALE\)/, 'the health verdict is unchanged');
  assert.match(line, new RegExp(`owner pid ${process.pid} ALIVE: not a leftover`),
    'this is the line `telepty kill` would otherwise have been run against');
});

test('gh#82(D): a STALE session whose processes are GONE reads exactly as it did before', () => {
  // A pid that was real and is now dead: the process has exited and been reaped, so the probe
  // measures `false` rather than declining to answer. (The kernel could in principle recycle the
  // number, but not within the microseconds between these two lines.)
  const dead = require('node:child_process').spawnSync(process.execPath, ['-e', '']).pid;
  const enriched = sessionView.enrichSessionIdle({ ...STALE, ownerPid: dead, ptyPid: dead }, Date.now());
  assert.equal(enriched.owner_alive, false, 'probed and dead — this one really is a leftover');
  assert.equal(sessionView.formatSessionStatusWithIdle(enriched), 'STALE (OWNER_DISCONNECTED_STALE)');
});

test('gh#82(D): a session with no pid on the record reports null, never a bare false', () => {
  // `serializeSession` sends `ownerPid: session.ownerPid || null`, so this is the real shape for
  // a session that never had an owner pid. Nothing was measured, and the JSON has to say so.
  const enriched = sessionView.enrichSessionIdle({ ...STALE, ownerPid: null, ptyPid: null }, Date.now());
  assert.equal(enriched.owner_alive, null);
  assert.equal(enriched.pty_alive, null);
  assert.equal(sessionView.formatSessionStatusWithIdle(enriched), 'STALE (OWNER_DISCONNECTED_STALE)');
});

test('gh#82(D): a healthy session gains no note — the clause exists to contradict "leftover"', () => {
  const enriched = sessionView.enrichSessionIdle(
    { ...STALE, healthStatus: 'CONNECTED', healthReason: null, ownerPid: process.pid }, Date.now());
  assert.equal(enriched.owner_alive, true);
  assert.equal(sessionView.formatSessionStatusWithIdle(enriched), 'CONNECTED');
});

test('gh#82(D): a REMOTE session is never pid-probed — the local pid table is not the peer\'s', () => {
  const enriched = sessionView.enrichSessionIdle(
    { ...STALE, host: '100.64.0.7', ownerPid: process.pid, ptyPid: process.pid }, Date.now());
  assert.equal(enriched.owner_alive, null, 'a peer\'s pid number means nothing on this machine');
  assert.equal(enriched.pty_alive, null);
  assert.equal(sessionView.formatSessionStatusWithIdle(enriched), 'STALE (OWNER_DISCONNECTED_STALE)');
});

test('gh#82(D): the idle suffix and the liveness note coexist', () => {
  const enriched = sessionView.enrichSessionIdle(
    { ...STALE, ownerPid: process.pid, idleSeconds: 38160 }, Date.now());
  const line = sessionView.formatSessionStatusWithIdle(enriched);
  assert.match(line, /💤 idle/, 'the 10h36m the reporter watched');
  assert.match(line, /ALIVE: not a leftover$/, 'and the reason not to kill it, last on the line');
});
