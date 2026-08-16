'use strict';

// #914 — an IDLE worker re-delivers the SAME absence to its source forever.
//
// Measured on the operator host: the orchestrator received
// `TASK_COMPLETION_UNKNOWN: <sid> inject=<same id> …` every settle tick (~30s) for one idle
// worker, ~70 turns across one night and still going. The mechanism, read from source:
//
//   daemon.js observationIdentity(kind, cause) = `kind|cause`
//   daemon.js recordObservation() compares the new identity against `record.last_observation`
//             — ONE entry, the immediately-previous observation
//   daemon.js source delivery runs unless `result === 'observation_duplicate'`
//
// An idle session cycles causes (silence_timeout → prompt_suffix_after_quiet →
// thinking_timeout → back), so no observation ever equals the one immediately before it, the
// duplicate branch never fires, and every tick is delivered. The debounce daemon.js states it
// achieves ("#48 settle window and #52 CPU re-arm still DEBOUNCE follow-up observations") is
// real for the LEDGER and absent on the SOURCE-DELIVERY leg.
//
// The fix is scoped to source delivery only. These invariants must hold on both sides of it:
//   • the bus hears EVERY observation, always (a subscriber must never infer from silence)
//   • the ledger / last_observation / observation_seq semantics are untouched
//   • the FIRST absence for an inject is always delivered (§A2)
//   • a GENUINE new observation kind is still delivered
//
// Hermetic: temp HOME + PORT=0 before the require, same discipline as
// test/completion-unknown-observation-60.test.js — no daemon spawn, no PTY, no HTTP.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty914-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.PORT = '0';

const daemon = require('../daemon');
const { recordObservation, beginTrackedInjection, getTrackedInjection } = daemon;

// The three causes an idle session actually cycles through, with the evidence each row
// requires (session-state.js OBSERVATION_CAUSES).
const IDLE_CYCLE = [
  { destination: 'idle', cause: 'silence_timeout', evidence: { silence_ms: 5200 } },
  { destination: 'idle', cause: 'prompt_suffix_after_quiet', evidence: { silence_ms: 5800 } },
  { destination: 'error', cause: 'thinking_timeout', evidence: { thinking_duration_ms: 30000 } },
];

let seq = 0;

// One inject, tracked for real, then N observations driven through the real emitter. Returns
// what the SOURCE received and what the BUS received, so the two legs can be asserted apart.
function driveObservations(sequence) {
  seq += 1;
  const sessionId = `worker-914-${seq}`;
  const injectId = `probe-914-${seq}`;
  const session = { id: sessionId, type: 'spawned' };
  const delivered = [];
  const busEvents = [];

  const begun = beginTrackedInjection({
    injectId,
    sessionId,
    session,
    source: 'orch',
  });
  assert.equal(begun.ok, true, 'tracked injection must be created for this fixture to mean anything');

  const pendingReport = {
    source: 'orch',
    injectId,
    injectedAt: new Date().toISOString(),
  };

  const results = [];
  for (const step of sequence) {
    results.push(recordObservation({
      sessionId,
      session,
      pendingReport,
      destination: step.destination,
      cause: step.cause,
      evidence: step.evidence,
      deliverToSource: true,
      trigger: 'settle-tick',
      deps: {
        broadcastSessionEvent: (type, sid, _s, payload) => busEvents.push({ type, sid, payload }),
        resolveSessionAlias: (s) => s,
        sessions: { orch: { id: 'orch' }, [sessionId]: session },
        deliverInjectionToSession: (srcId, _srcSession, msg) => delivered.push({ srcId, msg }),
      },
    }));
  }

  return { delivered, busEvents, results, record: getTrackedInjection(injectId), injectId };
}

// ── The defect ──────────────────────────────────────────────────────────────────────────
test('#914: cycling causes on one inject deliver the SAME absences to the source over and over', () => {
  // Two full laps of the idle cycle: 6 observations, 3 distinct `kind|cause` identities.
  const { delivered } = driveObservations([...IDLE_CYCLE, ...IDLE_CYCLE]);

  assert.equal(
    delivered.length,
    3,
    'the source must hear each DISTINCT absence once per inject — cycling causes must not defeat '
    + `the debounce (got ${delivered.length} deliveries for 3 distinct identities)`
  );
});

test('#914: even a single alternating pair re-delivers today (A,B,A ⇒ 2, not 3)', () => {
  const [a, b] = IDLE_CYCLE;
  const { delivered } = driveObservations([a, b, a]);

  assert.equal(delivered.length, 2, 'A,B,A is two distinct absences, so the source hears two');
});

// ── The invariants the fix must not move ────────────────────────────────────────────────
test('#914: the bus still hears EVERY observation — dedup is a delivery concern only', () => {
  const { busEvents } = driveObservations([...IDLE_CYCLE, ...IDLE_CYCLE]);

  const absences = busEvents.filter((e) => e.type === 'task_completion_unknown');
  assert.equal(
    absences.length,
    6,
    'a subscriber must never have to infer from silence: all 6 observations stay on the bus'
  );
});

test('#914: the ledger still records every observation — observation_seq unchanged', () => {
  const { record } = driveObservations([...IDLE_CYCLE, ...IDLE_CYCLE]);

  // 6 observations + the `tracking_started` entry beginTrackedInjection appends.
  assert.equal(record.observation_seq, 7, 'ledger append semantics must be untouched');
  assert.equal(record.observations.length, 7);
});

test('#914: the FIRST absence for an inject is always delivered (§A2)', () => {
  const { delivered } = driveObservations([IDLE_CYCLE[0]]);
  assert.equal(delivered.length, 1, 'absence is emitted, never silence');
});

test('#914: a genuinely NEW observation kind is still delivered after the cycle goes quiet', () => {
  const withExit = [
    ...IDLE_CYCLE,
    ...IDLE_CYCLE,
    // Not an idle tick — the process actually died. This must reach the source.
    { destination: 'dead', cause: 'process_exit', evidence: { exit_observed_at: new Date().toISOString() } },
  ];
  const { delivered } = driveObservations(withExit);

  assert.equal(delivered.length, 4, '3 distinct idle absences + the new session_process_exited');
  assert.match(
    delivered[delivered.length - 1].msg,
    /session_process_exited|process_exit/,
    'the new kind is the one that got through'
  );
});

test('#914: back-to-back identical observations stay deduped by the existing ledger rule', () => {
  const [a] = IDLE_CYCLE;
  const { results, delivered } = driveObservations([a, a]);

  assert.equal(results[1], 'observation_duplicate', 'the existing last_observation rule is untouched');
  assert.equal(delivered.length, 1);
});

// Two injects are two conversations: suppression is per-inject, never global.
test('#914: suppression is scoped to one inject — a second inject hears its own first absence', () => {
  const first = driveObservations([...IDLE_CYCLE]);
  const second = driveObservations([...IDLE_CYCLE]);

  assert.equal(first.delivered.length, 3);
  assert.equal(second.delivered.length, 3, 'a different inject is a different conversation');
});
