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

// Task 1215 delete88 — F2 (POSIX, deterministic): a DELETE of a spawned PTY must END the child process, measured by the
// daemon's own onExit record (`[EXIT] Session <sid> exited with code`, src/routes/spawn.js — the first statement of
// onExit, before any registry guard), not by the record disappearing. The child ignores SIGHUP by construction
// (`trap '' HUP`; SIG_IGN survives `exec`), so a teardown that sends node-pty's default kill() signal (SIGHUP) and
// never confirms or escalates leaves it running. This is NOT a reproduction of the historical Mac instance (unattributed).
//
// Causal readiness, no sleep: the viewer is attached FIRST (a spawned session's viewer gets no replay, so output printed
// before attach would be lost), then one input line is written through that viewer (the existing viewer-write gate). The
// child reads the line only after `trap` ran, then prints the marker: seeing the marker on the viewer proves the HUP
// disposition is in force. The exit observation is armed (stdout offset) before the DELETE; the acceptance bound is the
// package smoke's 15000 ms. Containment: the child self-exits via `exec sleep 20` (bounded orphan, nothing is killed by
// the test); the asserted PRECONDITION places that self-exit after the acceptance window, so it can never satisfy it.
const F2_POSIX_ONLY = process.platform === 'win32' ? 'POSIX SIGHUP/SIG_IGN semantics; not defined for Windows ConPTY' : false;
test('F2: DELETE of a spawned PTY whose child ignores SIGHUP must end the child within 15 s (daemon [EXIT] record)',
  { skip: F2_POSIX_ONLY, timeout: 60000 }, async () => {
    const sessionId = createSessionId('delete-hup');
    const MARKER = 'hup-ignored-armed', EXIT_ACCEPT_MS = 15000, SELF_EXIT_MS = 20000;
    const script = `trap '' HUP; read line; printf '${MARKER}\\n'; exec sleep ${SELF_EXIT_MS / 1000}`;
    const spawned = await harness.spawnSession(sessionId, { command: 'sh', args: ['-c', script] });
    assert.ok([200, 201].includes(spawned.status), `PRECONDITION: spawn ${spawned.status} ${JSON.stringify(spawned.body)}`);
    const viewer = await harness.connectSession(sessionId);
    let output = '';
    viewer.on('message', (raw) => {
      try { const msg = JSON.parse(raw.toString()); if (msg.type === 'output' && typeof msg.data === 'string') output += msg.data; } catch { /* not a frame */ }
    });
    try {
      const inputSentAt = Date.now();
      viewer.send(JSON.stringify({ type: 'input', data: 'go\r', from: 'orchestrator' }));
      await waitFor(() => output.includes(MARKER), { timeoutMs: 10000, description: 'PRECONDITION: the HUP-ignored marker on the viewer' });

      const exitLine = `[EXIT] Session ${sessionId} exited with code`;
      const exitFrom = harness.getLogs().stdout.length; // the real exit observation, armed before the DELETE
      const deleteStartedAt = Date.now();
      assert.ok(deleteStartedAt - inputSentAt < SELF_EXIT_MS - EXIT_ACCEPT_MS - 1000,
        `PRECONDITION: the child's bounded self-exit lies after the acceptance window (${deleteStartedAt - inputSentAt} ms)`);
      const res = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body && res.body.success, true, JSON.stringify(res.body));

      const exited = await waitFor(() => harness.getLogs().stdout.slice(exitFrom).includes(exitLine),
        { timeoutMs: EXIT_ACCEPT_MS, description: 'the deleted PTY child to exit' }).then(() => true, () => false);
      const since = harness.getLogs().stdout.slice(exitFrom);
      assert.equal(exited, true, `no [EXIT] for the deleted PTY within ${EXIT_ACCEPT_MS} ms of DELETE: ${JSON.stringify({
        waited_ms: Date.now() - deleteStartedAt, kill_removed_logged: since.includes(`[KILL] Session ${sessionId} removed`),
        delete_status: res.body && res.body.status ? String(res.body.status).slice(0, 32) : null })}`);
    } finally {
      try { viewer.close(); } catch { /* already closed */ }
    }
  });
