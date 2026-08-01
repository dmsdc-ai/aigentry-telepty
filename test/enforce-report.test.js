'use strict';

const { afterEach, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionId, delay, startTestDaemon, waitFor } = require('../test-support/daemon-harness');

let harness;

// #533 Phase 2: these tests model orchestrator→worker REPORT enforcement. The
// work-INJECTOR (the "source" that later receives the report) plays the orchestrator
// role, so it must classify as orch-lane (not peer-lane) under the inject guardrail.
// ORCH/ORCH2 are the fixture orchestrator sids, registered via AIGENTRY_ORCHESTRATOR_SIDS
// in beforeEach. ORCH2 is a second distinct orchestrator sid for the overwrite test.
const ORCH = 'orch';
const ORCH2 = 'orch2';

// #60 Stage A: the terminal vocabulary the daemon is no longer entitled to emit at all. Every
// one of these used to be reachable from TEXT — a REPORT:/STATUS: prefix routed back to a
// session's pending-report source, or an idle flip after an inject. No text can authenticate its
// sender or correlate itself to a dispatch, so no text may settle one, and there is no longer a
// producer for any of these names.
//
// TASK_DISMISSED is deliberately NOT in this list: it survives, but ONLY as the explicit
// orchestrator DELETE below. What was withdrawn is the inference from text, not the operation.
const REMOVED_TERMINAL_EVENTS = [
  'TASK_COMPLETE',
  'TASK_COMPLETE_WITH_REPORT',
  'TASK_BLOCKED_WITH_REASON',
  'TASK_IDLE_NO_REPORT',
  'TASK_IDLE_UNCONFIRMED',
  'TASK_DEAD_NO_REPORT',
  'TASK_ERROR',
];

// The §2.3 observation kinds a session going quiet can produce. All three measure the SCREEN
// going still; none is a turn boundary. They are distinct names precisely so a silence timeout
// can no longer present itself as an OSC-133 REPL-done mark.
const QUIET_OBSERVATION_KINDS = [
  'pty_quiet',
  'prompt_suffix_after_quiet_observed',
  'pty_quiet_after_osc_133_a_or_b_observed',
];

function assertNoTerminalClaim(messages) {
  for (const type of REMOVED_TERMINAL_EVENTS) {
    assert.equal(messages.find(m => m.type === type), undefined,
      `${type} must not be emitted — 0.8.0 has no producer for it`);
  }
}

function collectJsonMessages(ws) {
  const messages = [];
  ws.on('message', (chunk) => {
    try {
      messages.push(JSON.parse(chunk.toString()));
    } catch {
      // ignore
    }
  });
  return messages;
}

// Force state machine to transition to idle quickly
beforeEach(async () => {
  harness = await startTestDaemon({
    env: {
      TELEPTY_STATE_IDLE_TIMEOUT_MS: '300', // fast idle for tests
      // #577 CI-flake fix: shrink the idle-unconfirmed settle debounce (default 5s,
      // daemon.js IDLE_UNCONFIRMED_SETTLE_SECONDS) the same way TELEPTY_STATE_IDLE_TIMEOUT_MS
      // shrinks the idle timeout for tests. Without it the idle→TASK_IDLE_NO_REPORT emit is
      // bimodal (~1s confirmed vs a settle-debounced path). The settle path can RE-ARM up to
      // IDLE_UNCONFIRMED_CPU_MAX_REARMS (24) times, each waiting one settle window, when the
      // wrapped child's CPU sampling reads as advancing under a contended CI runner — so the
      // worst-case emit is ~= 24 × settleMs. At 100ms that tail is bounded to ~2.4s (was 7.2s
      // at 300ms — which is what timed out macOS at 8.1s), keeping total emit well under the
      // budget below. Can't zero the rearm caps from env (daemon uses `Number(x) || 24`, so
      // '0' → 24); shrinking the window is the clean lever. Idle path still genuinely exercised.
      TELEPTY_IDLE_UNCONFIRMED_SETTLE_SECONDS: '0.1',
      // Register the fixture orchestrator sids so orchestrator→worker injects
      // classify as orch-lane (allowed), not peer-lane-blocked (#533 Phase 2).
      AIGENTRY_ORCHESTRATOR_SIDS: `orchestrator aigentry-orchestrator-claude ${ORCH} ${ORCH2}`,
    }
  });
});

afterEach(async () => {
  await harness.stop();
});

// ---------------- reverse-routed report TEXT settles nothing (#60 Stage A) ----------------

// These three used to assert that a REPORT:/STATUS: prefix routed back to a session's
// pending-report source produced a TERMINAL bus event carrying a `report_status`. §3.6 deletes
// that path outright rather than renaming it, so what is pinned here is the ABSENCE.
//
// Absence alone would be vacuous — nothing emits those names any more, so a bare "did not fire"
// passes without exercising anything. Each test therefore also asserts the POSITIVE half: the
// reverse-routed inject is still delivered as an ordinary message, and the sender's tracked
// record is still queryable and still says `completion_fact: null`. That is what fails if the
// text path is ever rewired to settle a record.

async function trackedInject(targetId, body) {
  const resp = await harness.request(`/api/sessions/${encodeURIComponent(targetId)}/inject`, {
    method: 'POST', body,
  });
  assert.equal(resp.status, 200);
  assert.ok(resp.body.inject_id, 'inject returns its transport inject_id');
  return resp.body.inject_id;
}

async function assertStillUnknown(injectId, sessionId) {
  const obs = await harness.request(`/api/inject-observations/${encodeURIComponent(injectId)}`);
  assert.equal(obs.status, 200, 'observation query is always 200, never a task-state signal');
  assert.equal(obs.body.session_id, sessionId);
  assert.equal(obs.body.tracking_state, 'tracked', 'the record must still exist to be meaningful');
  assert.equal(obs.body.completion_fact, null);
  assert.equal(obs.body.terminal, false);
  assert.equal(obs.body.capability.outcome_protocol, 'unavailable');
  return obs.body;
}

test('reverse-routed REPORT text emits no terminal outcome and leaves tracking unknown', async () => {
  const senderId = createSessionId('sender');
  const receiverId = ORCH;

  // Register both as wrapped sessions
  await harness.spawnSession(senderId);
  await harness.spawnSession(receiverId);

  const bus = await harness.connectBus();
  const messages = collectJsonMessages(bus);

  // Step 1: receiver injects INTO sender with from=receiver
  // This creates pendingReports[sender] = { source: receiver, ... } and tracks the inject.
  const trackedId = await trackedInject(senderId, { prompt: 'please do work', from: receiverId });

  // Step 2: sender replies with REPORT: back to receiver — the exact reverse-match the deleted
  // path read as "sender reported its task complete".
  await trackedInject(receiverId, { prompt: 'REPORT: done', from: senderId });

  await delay(500);

  assertNoTerminalClaim(messages);
  await assertStillUnknown(trackedId, senderId);

  bus.close();
});

test('reverse-routed STATUS: blocked text emits no terminal outcome', async () => {
  const senderId = createSessionId('sender');
  const receiverId = ORCH;
  await harness.spawnSession(senderId);
  await harness.spawnSession(receiverId);

  const bus = await harness.connectBus();
  const messages = collectJsonMessages(bus);

  const trackedId = await trackedInject(senderId, { prompt: 'do work', from: receiverId });
  await trackedInject(receiverId, { prompt: 'STATUS: blocked on review', from: senderId });

  await delay(500);

  assertNoTerminalClaim(messages);
  await assertStillUnknown(trackedId, senderId);

  bus.close();
});

test('reverse-routed STATUS: dismissed text cannot dismiss — only the explicit DELETE can', async () => {
  const senderId = createSessionId('sender');
  const receiverId = ORCH;
  await harness.spawnSession(senderId);
  await harness.spawnSession(receiverId);

  const bus = await harness.connectBus();
  const messages = collectJsonMessages(bus);

  const trackedId = await trackedInject(senderId, { prompt: 'do work', from: receiverId });
  await trackedInject(receiverId, { prompt: 'STATUS: dismissed', from: senderId });

  await delay(500);

  // The sharp case: TASK_DISMISSED still EXISTS as an event, so this is not the vacuous
  // "the name is gone" check. What was withdrawn is the TEXT's authority to reach it.
  assert.equal(messages.find(m => m.type === 'TASK_DISMISSED'), undefined,
    'text may not dismiss — dismissal is an explicit orchestrator operation');
  assertNoTerminalClaim(messages);

  // Still pending, therefore still dismissible by the operation that does have the authority.
  await assertStillUnknown(trackedId, senderId);
  const dismiss = await harness.request(`/api/pendingReports/${encodeURIComponent(senderId)}`, {
    method: 'DELETE'
  });
  assert.equal(dismiss.status, 200, 'the pending entry survived the report text');

  bus.close();
});

test('control-only redraws do not re-mark a quiet session working', async () => {
  const senderId = createSessionId('wrapped-sender');

  await harness.registerSession(senderId);
  const senderOwner = await harness.connectSession(senderId);

  // §3.8: the read model is renamed too. `auto.state` served the INTERNAL FSM name straight to
  // consumers, which is how `idle` reached a sidebar as a green done-pill. It is now
  // `activity_observation`, keyed by the measured CAUSE, with completion split into its own
  // permanently-unknown block.
  const observationOf = async () => {
    const state = await harness.request(`/api/sessions/${encodeURIComponent(senderId)}/state`);
    assert.equal(state.status, 200);
    return state.body;
  };

  senderOwner.send(JSON.stringify({ type: 'output', data: 'working on task\n' }));
  await waitFor(async () => (await observationOf()).activity_observation.kind === 'output_observed',
    { timeoutMs: 2000, description: 'sender output_observed' });

  // This test used to reach idle by injecting REPORT text at the sender's report source and
  // asserted `detail.trigger === 'report_inject'`. Text can no longer mark a session idle, and
  // `report_inject` is not a measurement. But the guard it was really protecting — a control-only
  // redraw must not read as new work — is independent of the report path and still live, so it
  // is driven from a real measurement instead: the raw OSC 133 prompt marker.
  senderOwner.send(JSON.stringify({ type: 'output', data: '\x1b]133;B\x07' }));
  await waitFor(async () => (await observationOf()).activity_observation.kind === 'osc_133_a_or_b_observed',
    { timeoutMs: 2000, description: 'sender quiet at a prompt marker' });

  senderOwner.send(JSON.stringify({ type: 'output', data: '\x1b[?25l\r\x1b[2K\x1b[?25h' }));
  await delay(100);

  const afterControl = await observationOf();
  // Unchanged: control-only bytes carry no measurement, so they may neither re-mark the session
  // as working nor restate the cause.
  assert.equal(afterControl.activity_observation.kind, 'osc_133_a_or_b_observed');
  assert.equal(afterControl.activity_observation.cause, 'osc_133_a_or_b_received');
  // §8.5.5: a quiet session must never present as task success. Nothing in the observation
  // display table is green, and this is the entrance the sidebar pill reads.
  assert.equal(afterControl.activity_observation.tone, 'neutral');
  // The read model states an activity measurement and, separately, that it knows no outcome.
  assert.equal(afterControl.completion.completion_fact, null);
  assert.equal(afterControl.completion.terminal, false);
  assert.equal(afterControl.completion.capability.outcome_protocol, 'unavailable');

  senderOwner.send(JSON.stringify({ type: 'output', data: 'new task output\n' }));
  await waitFor(async () => (await observationOf()).activity_observation.kind === 'output_observed',
    { timeoutMs: 2000, description: 'sender output_observed after meaningful output' });

  senderOwner.close();
});

test('REPORT prefix WITHOUT matching reverse-match is treated as regular inject (no enforcement event)', async () => {
  const senderId = createSessionId('sender');
  const receiverId = ORCH;
  const unrelatedId = createSessionId('unrelated');
  await harness.spawnSession(senderId);
  await harness.spawnSession(receiverId);
  await harness.spawnSession(unrelatedId);

  const bus = await harness.connectBus();
  const messages = collectJsonMessages(bus);

  // No pendingReports created — inject a REPORT prefix without prior inject
  const trackedId = await trackedInject(receiverId, { prompt: 'REPORT: unsolicited', from: unrelatedId });

  await delay(500);

  const enforcementEvent = messages.find(m =>
    m.type === 'TASK_COMPLETE_WITH_REPORT' ||
    m.type === 'TASK_BLOCKED_WITH_REASON' ||
    m.type === 'TASK_DISMISSED'
  );
  assert.equal(enforcementEvent, undefined, 'should NOT fire enforcement event without reverse-match');

  // This assertion used to carry weight because a MATCHING reverse-route did fire an enforcement
  // event; with that path deleted, "no event" alone is now true of every input and proves nothing.
  // The positive half restores the teeth: the unsolicited REPORT is delivered as an ordinary
  // inject and is tracked exactly like any other, with nothing concluded from its text.
  await assertStillUnknown(trackedId, receiverId);

  bus.close();
});

// ---------------- DELETE /api/pendingReports/:id ----------------

test('DELETE /api/pendingReports/:id fires TASK_DISMISSED and clears entry', async () => {
  const senderId = createSessionId('sender');
  const receiverId = ORCH;
  await harness.spawnSession(senderId);
  await harness.spawnSession(receiverId);

  const bus = await harness.connectBus();
  const messages = collectJsonMessages(bus);

  // Create pending report
  await harness.request(`/api/sessions/${encodeURIComponent(senderId)}/inject`, {
    method: 'POST',
    body: { prompt: 'work', from: receiverId }
  });

  // DELETE dismisses
  const dismiss = await harness.request(`/api/pendingReports/${encodeURIComponent(senderId)}`, {
    method: 'DELETE'
  });
  assert.equal(dismiss.status, 200);
  assert.equal(dismiss.body.success, true);

  await waitFor(() => messages.some(m => m.type === 'TASK_DISMISSED'), {
    timeoutMs: 2000,
    description: 'TASK_DISMISSED bus event'
  });
  const event = messages.find(m => m.type === 'TASK_DISMISSED');
  assert.equal(event.dismissed_by, 'orchestrator');

  // Second DELETE should 404
  const again = await harness.request(`/api/pendingReports/${encodeURIComponent(senderId)}`, {
    method: 'DELETE'
  });
  assert.equal(again.status, 404);

  bus.close();
});

// ---------------- GET /api/pendingReports/:id ----------------

test('GET /api/pendingReports/:id returns pending entry with auto_summary', async () => {
  const senderId = createSessionId('sender');
  const receiverId = ORCH;
  await harness.spawnSession(senderId);
  await harness.spawnSession(receiverId);

  await harness.request(`/api/sessions/${encodeURIComponent(senderId)}/inject`, {
    method: 'POST',
    body: { prompt: 'work', from: receiverId }
  });

  const resp = await harness.request(`/api/pendingReports/${encodeURIComponent(senderId)}`);
  assert.equal(resp.status, 200);
  assert.equal(resp.body.session_id, senderId);
  assert.equal(resp.body.source, receiverId);
  assert.equal(resp.body.awaiting_report, true);
  assert.ok('auto_summary' in resp.body, 'auto_summary field must be present');
});

test('GET /api/pendingReports/:id returns 404 when no pending entry', async () => {
  const resp = await harness.request('/api/pendingReports/nonexistent-session');
  assert.equal(resp.status, 404);
});

// ---------------- Overwrite warning ----------------

test('Duplicate pendingReport overwrites without error (warning path)', async () => {
  const senderId = createSessionId('sender');
  const firstSource = ORCH;
  const secondSource = ORCH2;
  await harness.spawnSession(senderId);
  await harness.spawnSession(firstSource);
  await harness.spawnSession(secondSource);

  await harness.request(`/api/sessions/${encodeURIComponent(senderId)}/inject`, {
    method: 'POST',
    body: { prompt: 'first', from: firstSource }
  });
  await harness.request(`/api/sessions/${encodeURIComponent(senderId)}/inject`, {
    method: 'POST',
    body: { prompt: 'second', from: secondSource }
  });

  const resp = await harness.request(`/api/pendingReports/${encodeURIComponent(senderId)}`);
  assert.equal(resp.status, 200);
  // Latest source should have overwritten
  assert.equal(resp.body.source, secondSource);
});

// ---------------- No enforcement for user-driven work ----------------

test('Idle WITHOUT pendingReports (no inject source) fires no enforcement event', async () => {
  const sessionId = createSessionId('user-driven');
  await harness.spawnSession(sessionId);

  const bus = await harness.connectBus();
  const messages = collectJsonMessages(bus);

  // Do NOT inject — just wait for idle state
  await delay(1000);

  const enforcementEvent = messages.find(m =>
    m.type === 'TASK_IDLE_NO_REPORT' ||
    m.type === 'TASK_COMPLETE_WITH_REPORT' ||
    m.type === 'TASK_DEAD_NO_REPORT'
  );
  assert.equal(enforcementEvent, undefined, 'no enforcement event for user-driven work');

  // Same vacuity problem as above — those names have no producer left, so their absence is now
  // true unconditionally. The distinction worth pinning in 0.8.0 is between the two layers this
  // release separated: ACTIVITY is measurable and is emitted for any session, whereas
  // task_completion_unknown is scoped to a tracked dispatch and must NOT appear for user-driven
  // work, because nothing was dispatched for its completion to be unknown about.
  const activity = messages.filter(m => m.type === 'session_activity_observation'
    && m.session_id === sessionId);
  assert.ok(activity.length > 0, 'activity observations still flow for an untracked session');
  for (const m of activity) {
    assert.equal(m.completion_fact, null);
    assert.equal(m.terminal, false);
    assert.ok(m.observation.kind, 'every activity observation is named');
  }
  assert.equal(messages.find(m => m.type === 'task_completion_unknown'
    && m.session_id === sessionId), undefined,
  'no tracked dispatch → no completion-unknown record for this session');
  assertNoTerminalClaim(messages);

  bus.close();
});

// ---------------- Version check ----------------

test('package.json version is semver-shaped', async () => {
  const pkg = require('../package.json');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
});

// ---------------- idle after an inject is an observation, not an outcome ----------------

test('idle after an inject emits task_completion_unknown, not a terminal claim', async () => {
  // This used to assert the LEGACY back-compat pair: a `TASK_IDLE_NO_REPORT` bus event plus the
  // `TASK_COMPLETE:` text-inject, both fired from the idle flip. #60 Stage A deletes both — an
  // idle flip is a measurement of the SCREEN, and no screen measurement is a task outcome.
  //
  // This is a RENAMED PRESENCE, not a deletion: the notification still fires on the same idle
  // path, carrying the same `source`. What changed is what it is allowed to say. So the test
  // still waits for a real emission (it would fail on silence, which is the #52 defect in
  // reverse) and then pins that the emission claims nothing terminal.
  const senderId = createSessionId('legacy-sender');
  const receiverId = ORCH;

  // Spawn two shell sessions
  await harness.spawnSession(senderId);
  await harness.spawnSession(receiverId);

  const bus = await harness.connectBus();
  const messages = collectJsonMessages(bus);

  // Receiver → sender inject
  const trackedId = await trackedInject(senderId, { prompt: 'echo hello', from: receiverId });

  // Wait for idle (TELEPTY_STATE_IDLE_TIMEOUT_MS=300ms set in beforeEach)
  // #577: 10000ms budget. With the shrunk settle above the daemon's bounded worst-case emit is
  // ~detect(1-2s) + settle-rearms(3×0.1) + cpu-rearms(24×0.1) ≈ 4.5s; 10s covers that plus
  // headroom for 1000ms state poll-tick scheduling jitter on a loaded CI runner (was 4000/8000).
  const isQuietObservation = (m) => m.type === 'task_completion_unknown'
    && m.session_id === senderId
    && QUIET_OBSERVATION_KINDS.includes(m.observation && m.observation.kind);

  await waitFor(() => messages.some(isQuietObservation), {
    timeoutMs: 10000,
    description: 'task_completion_unknown for the quiet sender'
  });

  const event = messages.find(isQuietObservation);
  assert.ok(event);
  assert.equal(event.source, receiverId);
  // The withdrawn claim, pinned where it used to be made.
  assert.equal(event.completion_fact, null);
  assert.equal(event.terminal, false);
  assert.equal(event.capability.outcome_protocol, 'unavailable');
  // Quiet is not consumption either — the two were conflated by the deleted `confirmed` flag.
  assert.ok(['observed', 'not_established'].includes(event.consumption.status));
  assertNoTerminalClaim(messages);

  // And the durable record agrees with the bus.
  await assertStillUnknown(trackedId, senderId);

  bus.close();
});
