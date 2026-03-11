'use strict';

const { after, afterEach, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionId, delay, startTestDaemon, waitFor } = require('./helpers/daemon-harness');

let harness;

function collectJsonMessages(ws) {
  const messages = [];
  ws.on('message', (chunk) => {
    try {
      messages.push(JSON.parse(chunk.toString()));
    } catch {
      // Ignore malformed payloads in tests.
    }
  });
  return messages;
}

before(async () => {
  harness = await startTestDaemon();
});

after(async () => {
  await harness.stop();
});

afterEach(async () => {
  await harness.cleanupSessions();
});

test('GET /api/sessions returns an empty array on a fresh daemon', async () => {
  const result = await harness.request('/api/sessions');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, []);
});

test('spawned sessions appear in the list and duplicate IDs are rejected', async () => {
  const sessionId = createSessionId('spawn');
  const first = await harness.spawnSession(sessionId);
  assert.equal(first.status, 201);
  assert.equal(first.body.session_id, sessionId);

  const duplicate = await harness.spawnSession(sessionId);
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.error, /already active/i);

  const list = await harness.request('/api/sessions');
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].id, sessionId);
  assert.equal(list.body[0].active_clients, 0);
});

test('PATCH /api/sessions/:id renames the session and publishes a bus event', async () => {
  const originalId = createSessionId('rename');
  const newId = `${originalId}-renamed`;
  await harness.spawnSession(originalId);

  const bus = await harness.connectBus();
  const messages = collectJsonMessages(bus);

  const rename = await harness.request(`/api/sessions/${encodeURIComponent(originalId)}`, {
    method: 'PATCH',
    body: { new_id: newId }
  });

  assert.equal(rename.status, 200);
  assert.equal(rename.body.new_id, newId);

  await waitFor(() => messages.find((message) => (
    message.type === 'session_rename' &&
    message.old_id === originalId &&
    message.new_id === newId
  )), { description: 'rename bus event' });

  const list = await harness.request('/api/sessions');
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].id, newId);

  bus.close();
});

test('inject and multicast endpoints report success and partial failure correctly', async () => {
  const sessionId = createSessionId('inject');
  const missingId = createSessionId('missing');
  await harness.spawnSession(sessionId);

  const inject = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
    method: 'POST',
    body: { prompt: 'echo injected' }
  });
  assert.equal(inject.status, 200);
  assert.equal(inject.body.success, true);

  const injectMissingPrompt = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
    method: 'POST',
    body: {}
  });
  assert.equal(injectMissingPrompt.status, 400);

  const multicast = await harness.request('/api/sessions/multicast/inject', {
    method: 'POST',
    body: {
      session_ids: [sessionId, missingId],
      prompt: 'echo multicast'
    }
  });

  assert.equal(multicast.status, 200);
  assert.deepEqual(multicast.body.results.successful, [sessionId]);
  assert.equal(multicast.body.results.failed.length, 1);
  assert.equal(multicast.body.results.failed[0].id, missingId);
});

test('broadcast inject publishes a single bus event with all successful target IDs', async () => {
  const sessionA = createSessionId('broadcast-a');
  const sessionB = createSessionId('broadcast-b');
  await harness.spawnSession(sessionA);
  await harness.spawnSession(sessionB);

  const bus = await harness.connectBus();
  const messages = collectJsonMessages(bus);

  const prompt = `echo ${createSessionId('broadcast-token')}`;
  const broadcast = await harness.request('/api/sessions/broadcast/inject', {
    method: 'POST',
    body: { prompt }
  });

  assert.equal(broadcast.status, 200);
  assert.equal(broadcast.body.results.successful.length, 2);

  await waitFor(() => messages.filter((message) => (
    message.type === 'injection' &&
    message.target_agent === 'all' &&
    message.content === prompt
  )).length === 1, { description: 'single broadcast bus event' });

  const event = messages.find((message) => message.type === 'injection' && message.content === prompt);
  assert.deepEqual(event.session_ids.slice().sort(), [sessionA, sessionB].sort());

  bus.close();
});

test('session WebSocket updates active client counts and relays PTY output', async () => {
  const sessionId = createSessionId('ws');
  await harness.spawnSession(sessionId);

  const firstClient = await harness.connectSession(sessionId);
  const secondClient = await harness.connectSession(sessionId);
  const outputs = collectJsonMessages(firstClient);

  await waitFor(async () => {
    const list = await harness.request('/api/sessions');
    const session = list.body.find((item) => item.id === sessionId);
    return session && session.active_clients === 2;
  }, { description: 'two attached websocket clients' });

  const token = createSessionId('ws-output');
  firstClient.send(JSON.stringify({ type: 'input', data: `echo ${token}\r` }));

  await waitFor(() => outputs.some((message) => (
    message.type === 'output' && String(message.data).includes(token)
  )), { timeoutMs: 7000, description: 'PTY output over websocket' });

  secondClient.close();

  await waitFor(async () => {
    const list = await harness.request('/api/sessions');
    const session = list.body.find((item) => item.id === sessionId);
    return session && session.active_clients === 1;
  }, { description: 'one attached websocket client after close' });

  firstClient.close();

  await waitFor(async () => {
    const list = await harness.request('/api/sessions');
    const session = list.body.find((item) => item.id === sessionId);
    return session && session.active_clients === 0;
  }, { description: 'zero attached websocket clients after close' });
});

test('DELETE /api/sessions/:id closes the session without crashing the daemon', async () => {
  const sessionId = createSessionId('delete');
  await harness.spawnSession(sessionId);

  const destroy = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE'
  });
  assert.equal(destroy.status, 200);
  assert.equal(destroy.body.status, 'closing');

  await waitFor(async () => {
    const list = await harness.request('/api/sessions');
    return list.status === 200 && !list.body.some((session) => session.id === sessionId);
  }, { description: 'session removal after delete' });

  await delay(200);
  assert.equal(harness.isAlive(), true, harness.getLogs().stderr || harness.getLogs().stdout);

  const healthCheck = await harness.request('/api/sessions');
  assert.equal(healthCheck.status, 200);
});
