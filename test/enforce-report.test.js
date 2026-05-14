'use strict';

const { afterEach, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionId, delay, startTestDaemon, waitFor } = require('../test-support/daemon-harness');

let harness;

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
    }
  });
});

afterEach(async () => {
  await harness.stop();
});

// ---------------- REPORT detection via reverse-match ----------------

test('REPORT-prefixed inject with matching reverse-match emits TASK_COMPLETE_WITH_REPORT', async () => {
  const senderId = createSessionId('sender');
  const receiverId = createSessionId('receiver');

  // Register both as wrapped sessions
  await harness.spawnSession(senderId);
  await harness.spawnSession(receiverId);

  const bus = await harness.connectBus();
  const messages = collectJsonMessages(bus);

  // Step 1: receiver injects INTO sender with from=receiver
  // This creates pendingReports[sender] = { source: receiver, ... }
  const first = await harness.request(`/api/sessions/${encodeURIComponent(senderId)}/inject`, {
    method: 'POST',
    body: { prompt: 'please do work', from: receiverId }
  });
  assert.equal(first.status, 200);

  // Step 2: sender replies with REPORT: back to receiver
  // This is the reverse-match: incoming inject to receiver, from=sender,
  // with pendingReports[sender].source === receiver
  const second = await harness.request(`/api/sessions/${encodeURIComponent(receiverId)}/inject`, {
    method: 'POST',
    body: { prompt: 'REPORT: done', from: senderId }
  });
  assert.equal(second.status, 200);

  await waitFor(() => messages.some(m => m.type === 'TASK_COMPLETE_WITH_REPORT'), {
    timeoutMs: 2000,
    description: 'TASK_COMPLETE_WITH_REPORT bus event'
  });

  const event = messages.find(m => m.type === 'TASK_COMPLETE_WITH_REPORT');
  assert.ok(event);
  assert.equal(event.session_id, senderId);
  assert.equal(event.source, receiverId);
  assert.equal(event.report_status, 'report_complete');
  assert.ok(event.report_summary.includes('REPORT: done'));

  bus.close();
});

test('reverse-matched REPORT forces sender idle and control-only redraws do not re-mark working', async () => {
  const senderId = createSessionId('wrapped-sender');
  const receiverId = createSessionId('wrapped-receiver');

  await harness.registerSession(senderId);
  await harness.registerSession(receiverId);

  const senderOwner = await harness.connectSession(senderId);
  const receiverOwner = await harness.connectSession(receiverId);

  senderOwner.send(JSON.stringify({ type: 'output', data: 'working on task\n' }));
  await waitFor(async () => {
    const state = await harness.request(`/api/sessions/${encodeURIComponent(senderId)}/state`);
    return state.body.auto.state === 'working';
  }, { timeoutMs: 2000, description: 'sender working state' });

  const first = await harness.request(`/api/sessions/${encodeURIComponent(senderId)}/inject`, {
    method: 'POST',
    body: { prompt: 'please do work', from: receiverId, no_enter: true }
  });
  assert.equal(first.status, 200);

  const report = await harness.request(`/api/sessions/${encodeURIComponent(receiverId)}/inject`, {
    method: 'POST',
    body: { prompt: 'REPORT: done', from: senderId, no_enter: true }
  });
  assert.equal(report.status, 200);

  await waitFor(async () => {
    const state = await harness.request(`/api/sessions/${encodeURIComponent(senderId)}/state`);
    return state.body.auto.state === 'idle' && state.body.auto.detail.trigger === 'report_inject';
  }, { timeoutMs: 2000, description: 'sender forced idle after report' });

  senderOwner.send(JSON.stringify({ type: 'output', data: '\x1b[?25l\r\x1b[2K\x1b[?25h' }));
  await delay(100);

  const afterControl = await harness.request(`/api/sessions/${encodeURIComponent(senderId)}/state`);
  assert.equal(afterControl.body.auto.state, 'idle');
  assert.equal(afterControl.body.auto.detail.trigger, 'report_inject');

  senderOwner.send(JSON.stringify({ type: 'output', data: 'new task output\n' }));
  await waitFor(async () => {
    const state = await harness.request(`/api/sessions/${encodeURIComponent(senderId)}/state`);
    return state.body.auto.state === 'working';
  }, { timeoutMs: 2000, description: 'sender working after meaningful output' });

  senderOwner.close();
  receiverOwner.close();
});

test('STATUS: blocked with matching reverse-match emits TASK_BLOCKED_WITH_REASON', async () => {
  const senderId = createSessionId('sender');
  const receiverId = createSessionId('receiver');
  await harness.spawnSession(senderId);
  await harness.spawnSession(receiverId);

  const bus = await harness.connectBus();
  const messages = collectJsonMessages(bus);

  await harness.request(`/api/sessions/${encodeURIComponent(senderId)}/inject`, {
    method: 'POST',
    body: { prompt: 'do work', from: receiverId }
  });
  await harness.request(`/api/sessions/${encodeURIComponent(receiverId)}/inject`, {
    method: 'POST',
    body: { prompt: 'STATUS: blocked on review', from: senderId }
  });

  await waitFor(() => messages.some(m => m.type === 'TASK_BLOCKED_WITH_REASON'), {
    timeoutMs: 2000,
    description: 'TASK_BLOCKED_WITH_REASON bus event'
  });

  const event = messages.find(m => m.type === 'TASK_BLOCKED_WITH_REASON');
  assert.equal(event.report_status, 'report_blocked');

  bus.close();
});

test('STATUS: dismissed with matching reverse-match emits TASK_DISMISSED', async () => {
  const senderId = createSessionId('sender');
  const receiverId = createSessionId('receiver');
  await harness.spawnSession(senderId);
  await harness.spawnSession(receiverId);

  const bus = await harness.connectBus();
  const messages = collectJsonMessages(bus);

  await harness.request(`/api/sessions/${encodeURIComponent(senderId)}/inject`, {
    method: 'POST',
    body: { prompt: 'do work', from: receiverId }
  });
  await harness.request(`/api/sessions/${encodeURIComponent(receiverId)}/inject`, {
    method: 'POST',
    body: { prompt: 'STATUS: dismissed', from: senderId }
  });

  await waitFor(() => messages.some(m => m.type === 'TASK_DISMISSED'), {
    timeoutMs: 2000,
    description: 'TASK_DISMISSED bus event'
  });
  const event = messages.find(m => m.type === 'TASK_DISMISSED');
  assert.equal(event.report_status, 'report_dismissed');

  bus.close();
});

test('REPORT prefix WITHOUT matching reverse-match is treated as regular inject (no enforcement event)', async () => {
  const senderId = createSessionId('sender');
  const receiverId = createSessionId('receiver');
  const unrelatedId = createSessionId('unrelated');
  await harness.spawnSession(senderId);
  await harness.spawnSession(receiverId);
  await harness.spawnSession(unrelatedId);

  const bus = await harness.connectBus();
  const messages = collectJsonMessages(bus);

  // No pendingReports created — inject a REPORT prefix without prior inject
  await harness.request(`/api/sessions/${encodeURIComponent(receiverId)}/inject`, {
    method: 'POST',
    body: { prompt: 'REPORT: unsolicited', from: unrelatedId }
  });

  await delay(500);

  const enforcementEvent = messages.find(m =>
    m.type === 'TASK_COMPLETE_WITH_REPORT' ||
    m.type === 'TASK_BLOCKED_WITH_REASON' ||
    m.type === 'TASK_DISMISSED'
  );
  assert.equal(enforcementEvent, undefined, 'should NOT fire enforcement event without reverse-match');

  bus.close();
});

// ---------------- DELETE /api/pendingReports/:id ----------------

test('DELETE /api/pendingReports/:id fires TASK_DISMISSED and clears entry', async () => {
  const senderId = createSessionId('sender');
  const receiverId = createSessionId('receiver');
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
  const receiverId = createSessionId('receiver');
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
  const firstSource = createSessionId('src1');
  const secondSource = createSessionId('src2');
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

  bus.close();
});

// ---------------- Version check ----------------

test('package.json version is semver-shaped', async () => {
  const pkg = require('../package.json');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
});

// ---------------- Legacy back-compat ----------------

test('Legacy TASK_COMPLETE text is still emitted for back-compat', async () => {
  // This test verifies the legacy text-inject still fires when sessions go idle.
  // We use a spawned session (shell) since the state machine idle timeout triggers
  // the legacy path reliably.
  const senderId = createSessionId('legacy-sender');
  const receiverId = createSessionId('legacy-receiver');

  // Spawn two shell sessions
  await harness.spawnSession(senderId);
  await harness.spawnSession(receiverId);

  const bus = await harness.connectBus();
  const messages = collectJsonMessages(bus);

  // Receiver → sender inject
  await harness.request(`/api/sessions/${encodeURIComponent(senderId)}/inject`, {
    method: 'POST',
    body: { prompt: 'echo hello', from: receiverId }
  });

  // Wait for idle (TELEPTY_STATE_IDLE_TIMEOUT_MS=300ms set in beforeEach)
  await waitFor(() => messages.some(m => m.type === 'TASK_IDLE_NO_REPORT'), {
    timeoutMs: 4000,
    description: 'TASK_IDLE_NO_REPORT bus event'
  });

  const event = messages.find(m => m.type === 'TASK_IDLE_NO_REPORT');
  assert.ok(event);
  assert.equal(event.source, receiverId);
  assert.ok(typeof event.elapsed_secs === 'number');

  bus.close();
});
