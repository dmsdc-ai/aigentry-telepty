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

const deathObservations = (events, sessionId) => events.filter((e) => (
  e.session_id === sessionId
  && e.type === 'session_activity_observation'
  && e.observation && e.observation.kind === 'session_process_exited'
));

test('F1: a DELETE-killed session emits its death observation (§A2)', async () => {
  const sessionId = createSessionId('delete-death');
  const events = collectBus(bus);
  await harness.spawnSession(sessionId);
  await waitFor(async () => (await harness.request(`/api/sessions/${sessionId}`)).status === 200,
    { timeoutMs: 10000, description: 'the spawned session to register' });

  const res = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  await waitFor(() => deathObservations(events, sessionId).length > 0, {
    timeoutMs: 10000,
    description: 'a death observation for the operator-killed session',
  });

  const observed = deathObservations(events, sessionId)[0];
  assert.equal(observed.observation.kind, 'session_process_exited');
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
