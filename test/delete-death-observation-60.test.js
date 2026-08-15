'use strict';

// telepty#60 Stage A §A2 (F1) — an operator-killed session's death must be OBSERVED.
//
// `DELETE /api/sessions/:id` killed the PTY and then removed the record in this order:
//
//     delete sessions[id];
//     sessionStateManager.unregister(id);
//
// It never called `markDead`, and the kill's `onExit` fires asynchronously — by which point
// `sessions[id]` is already gone, so the transition listener's `if (!session) return` guard takes
// the early return and NOTHING is emitted on any channel. The natural-exit path calls `markDead`
// while the record is still live and works correctly, so telepty had two death entrances: one
// honest, one mute.
//
// That is the §A2 violation ("absence is emitted, never silence") on the entrance the ORCHESTRATOR
// uses — `bin/session-cleanup.sh` calls exactly this DELETE, so every cleaned-up worker produced
// zero observation about its own death.
//
// These tests pin the FIXED behaviour, deliberately: a test asserting the old silence would have
// banked the defect as intended behaviour. The natural-exit arm is a CONTROL and is expected green
// both before and after — it is what makes the DELETE arm's red mean "this entrance is mute"
// rather than "the bus/harness does not work".

const { afterEach, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionId, startTestDaemon, waitFor } = require('../test-support/daemon-harness');

let harness;
let bus;

beforeEach(async () => {
  harness = await startTestDaemon();
  bus = await harness.connectBus();
});

afterEach(async () => {
  try { bus.close(); } catch { /* already gone */ }
  await harness.stop();
});

// Every bus frame, so an assertion can say which observations DID arrive rather than only that the
// one it wanted did not.
function collectBus(ws) {
  const events = [];
  ws.on('message', (chunk) => {
    try { events.push(JSON.parse(chunk.toString())); } catch { /* ignore non-JSON */ }
  });
  return events;
}

const observationsOfKind = (events, sessionId, kind) => events.filter((e) => (
  e.session_id === sessionId
  && e.type === 'session_activity_observation'
  && e.observation && e.observation.kind === kind
));
const deathObservations = (events, sessionId) => observationsOfKind(events, sessionId, 'session_process_exited');

test('F1: a DELETE-killed session emits its end observation (§A2) — under a name that matches what was measured (#843)', async () => {
  // The §A2 half of this is unchanged and still asserted: this entrance used to emit NOTHING, and
  // silence is the one output Stage A forbids.
  //
  // What #843 changes is the NAME. The A2 fix routed the DELETE through `markDead`, whose external
  // kind is `session_process_exited` — an assertion that a child process was seen to exit. Nothing
  // on this path saw that. The daemon asked for a teardown; the exit status is genuinely unknown at
  // this instant, which is exactly why the fix deliberately left exit_code and signal null. The
  // fields were honest and the name was not, so the honest fields were filed under a claim that
  // contradicted them.
  const sessionId = createSessionId('delete-death');
  const events = collectBus(bus);
  await harness.spawnSession(sessionId);
  await waitFor(async () => (await harness.request(`/api/sessions/${sessionId}`)).status === 200,
    { timeoutMs: 10000, description: 'the spawned session to register' });

  const res = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  await waitFor(() => observationsOfKind(events, sessionId, 'session_termination_requested').length > 0, {
    timeoutMs: 10000,
    description: 'a termination-requested observation for the operator-killed session',
  });

  const observed = observationsOfKind(events, sessionId, 'session_termination_requested')[0];
  assert.equal(observed.observation.kind, 'session_termination_requested');
  assert.equal(observed.observation.reason, 'operator_delete',
    'the observation must say WHY the session ended, since it cannot say how the process did');
  // The overclaim, asserted negatively: no observed-exit name may appear on this entrance at all.
  // A DELETE does kill the PTY, and its onExit may well fire later — but the state machine is
  // unregistered synchronously here, so nothing downstream may report an exit this path never saw.
  assert.equal(deathObservations(events, sessionId).length, 0,
    'no process exit was observed on this path, so session_process_exited must not be emitted');
  // A death is not a task outcome. The session is gone; what it was doing is still unknown.
  assert.equal(observed.completion_fact, null);
  assert.equal(observed.terminal, false);
});

test('F1 control: a naturally-exiting session emits the same observation on the same channel', async () => {
  // Expected GREEN before and after the fix. It proves the channel, the event name and the
  // observation kind are all reachable in this harness, so the DELETE arm above cannot go red for
  // an incidental reason and be mistaken for the defect.
  const sessionId = createSessionId('natural-death');
  const events = collectBus(bus);
  await harness.spawnSession(sessionId, { command: 'sh', args: ['-c', 'exit 0'] });

  await waitFor(() => deathObservations(events, sessionId).length > 0, {
    timeoutMs: 10000,
    description: 'a death observation for the naturally-exiting session',
  });

  const observed = deathObservations(events, sessionId)[0];
  assert.equal(observed.observation.kind, 'session_process_exited');
  assert.equal(observed.completion_fact, null);
});

test('F1: the DELETE still removes the session — the fix is ordering, not retention', async () => {
  // The ordering change moves markDead/unregister ahead of the delete; it must not leave the
  // record behind. A death that is observed but never cleaned up would trade one defect for a
  // worse one.
  const sessionId = createSessionId('delete-removes');
  await harness.spawnSession(sessionId);
  await waitFor(async () => (await harness.request(`/api/sessions/${sessionId}`)).status === 200,
    { timeoutMs: 10000, description: 'the spawned session to register' });

  await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });

  await waitFor(async () => (await harness.request(`/api/sessions/${sessionId}`)).status === 404, {
    timeoutMs: 10000,
    description: 'the session to be gone from the registry',
  });
});
