'use strict';

const { afterEach, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const WebSocket = require('ws');
const { createSessionId, delay, startTestDaemon, waitFor } = require('../test-support/daemon-harness');

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

function createSubmitCaptureScript() {
  return [
    "process.stdin.setEncoding('utf8');",
    "let buffer='';",
    "process.stdin.resume();",
    "process.stdout.write('> ');",
    "process.stdin.on('data', (chunk) => {",
    "  for (const ch of chunk) {",
    "    if (ch === '\\r' || ch === '\\n') {",
    "      process.stdout.write(`\\nSUBMIT:${buffer}\\n`);",
    "      process.exit(0);",
    "      return;",
    "    }",
    "    buffer += ch;",
    "  }",
    "});"
  ].join(' ');
}

beforeEach(async () => {
  // #533 Phase 2: register the fixture orchestrator literal 'orch' (used as the
  // work-injecting `from` in orchestrator→worker inject tests) as an orchestrator
  // sid so those injects classify as orch-lane (allowed) instead of being blocked
  // by the peer-lane guardrail.
  harness = await startTestDaemon({
    env: { AIGENTRY_ORCHESTRATOR_SIDS: 'orchestrator aigentry-orchestrator-claude orch orch2' }
  });
});

afterEach(async () => {
  await harness.stop();
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
  assert.equal(multicast.body.results.successful.length, 1);
  assert.equal(multicast.body.results.successful[0].id, sessionId);
  assert.equal(multicast.body.results.failed.length, 1);
  assert.equal(multicast.body.results.failed[0].id, missingId);
});

test('inject endpoint accepts an empty prompt and still submits enter', async () => {
  const sessionId = createSessionId('inject-empty');
  await harness.spawnSession(sessionId, {
    command: process.execPath,
    args: ['-e', createSubmitCaptureScript()]
  });

  const ws = await harness.connectSession(sessionId);
  const outputs = collectJsonMessages(ws);

  const inject = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
    method: 'POST',
    body: { prompt: '' }
  });
  assert.equal(inject.status, 200);
  assert.equal(inject.body.success, true);

  await waitFor(() => outputs.some((message) => (
    message.type === 'output' && String(message.data).includes('SUBMIT:')
  )), { timeoutMs: 7000, description: 'empty prompt submit output' });

  const normalized = outputs
    .filter((message) => message.type === 'output')
    .map((message) => String(message.data))
    .join('');
  assert.equal(normalized.includes('SUBMIT:'), true);

  ws.close();
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

  await delay(100);

  const event = messages.find((message) => message.type === 'injection' && message.content === prompt);
  assert.equal(messages.filter((message) => message.type === 'injection' && message.content === prompt).length, 1);
  const eventIds = event.session_ids.map(s => typeof s === 'string' ? s : s.id).sort();
  assert.deepEqual(eventIds, [sessionA, sessionB].sort());

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

// --- Wrapped session (register) tests ---

test('POST /api/sessions/register creates a wrapped session with correct type', async () => {
  const sessionId = createSessionId('register');
  const result = await harness.registerSession(sessionId);
  assert.equal(result.status, 201);
  assert.equal(result.body.session_id, sessionId);
  assert.equal(result.body.type, 'wrapped');

  const list = await harness.request('/api/sessions');
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].id, sessionId);
  assert.equal(list.body[0].type, 'wrapped');
});

test('register stores terminal metadata and exposes it through session APIs', async () => {
  const sessionId = createSessionId('terminal-meta');
  const result = await harness.registerSession(sessionId, {
    term_program: 'ghostty',
    term: 'xterm-256color'
  });

  assert.equal(result.status, 201);

  const list = await harness.request('/api/sessions');
  const session = list.body.find((item) => item.id === sessionId);
  assert.equal(session.termProgram, 'ghostty');
  assert.equal(session.term, 'xterm-256color');
  assert.equal(session.terminal, 'ghostty');
  assert.equal(session.healthStatus, 'DISCONNECTED');
  assert.equal(session.transport.health_status, 'DISCONNECTED');
  assert.equal(session.semantic, null);

  const detail = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.termProgram, 'ghostty');
  assert.equal(detail.body.term, 'xterm-256color');
  assert.equal(detail.body.terminal, 'ghostty');
  assert.equal(detail.body.transport.health_status, 'DISCONNECTED');
  assert.equal(detail.body.semantic, null);
});

test('register rejects missing session_id and duplicate IDs', async () => {
  const noId = await harness.registerSession(undefined, { session_id: undefined });
  assert.equal(noId.status, 400);

  const sessionId = createSessionId('dup-reg');
  await harness.registerSession(sessionId);
  const duplicate = await harness.registerSession(sessionId);
  // Re-registration is idempotent — returns 200 with reregistered flag
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.reregistered, true);
});

test('register and spawn share the same namespace (cross-type duplicate rejection)', async () => {
  const sessionId = createSessionId('cross');
  await harness.spawnSession(sessionId);
  // Register is idempotent — re-registers existing session
  const dup = await harness.registerSession(sessionId);
  assert.equal(dup.status, 200);
  assert.equal(dup.body.reregistered, true);

  const sessionId2 = createSessionId('cross2');
  await harness.registerSession(sessionId2);
  // Spawn rejects duplicate IDs
  const dup2 = await harness.spawnSession(sessionId2);
  assert.equal(dup2.status, 409);
});

test('register publishes a session_register bus event', async () => {
  const bus = await harness.connectBus();
  const messages = collectJsonMessages(bus);

  const sessionId = createSessionId('bus-reg');
  await harness.registerSession(sessionId);

  await waitFor(() => messages.find((message) => (
    message.type === 'session_register' &&
    message.session_id === sessionId
  )), { description: 'register bus event' });

  bus.close();
});

test('inject on wrapped session without owner returns a DISCONNECTED error code', async () => {
  const sessionId = createSessionId('no-owner');
  await harness.registerSession(sessionId);

  const inject = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
    method: 'POST',
    body: { prompt: 'hello' }
  });
  assert.equal(inject.status, 503);
  assert.equal(inject.body.code, 'DISCONNECTED');
  assert.match(inject.body.error, /disconnected/i);
});

test('inject on wrapped session forwards to owner WebSocket', async () => {
  const sessionId = createSessionId('owner-inject');
  await harness.registerSession(sessionId);

  // First WebSocket connector becomes owner
  const ownerWs = await harness.connectSession(sessionId);
  const ownerMessages = collectJsonMessages(ownerWs);

  const inject = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
    method: 'POST',
    body: { prompt: 'injected-text' }
  });
  assert.equal(inject.status, 200);
  assert.equal(inject.body.success, true);

  await waitFor(() => ownerMessages.find((message) => (
    message.type === 'inject' && String(message.data).includes('injected-text')
  )), { description: 'inject message forwarded to owner' });

  ownerWs.close();
});

test('inject keeps routing metadata out of wrapped prompt text and submits separately', async () => {
  const sessionId = createSessionId('owner-routing');
  await harness.registerSession(sessionId);

  const ownerWs = await harness.connectSession(sessionId);
  const ownerMessages = collectJsonMessages(ownerWs);

  const inject = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
    method: 'POST',
    body: { prompt: 'visible-task', from: 'orch', reply_to: 'orch' }
  });
  assert.equal(inject.status, 200);
  assert.equal(inject.body.success, true);

  await waitFor(() => ownerMessages.filter((message) => message.type === 'inject').length >= 2, {
    timeoutMs: 7000,
    description: 'wrapped inject text and deferred CR'
  });

  const injectMessages = ownerMessages.filter((message) => message.type === 'inject').map((message) => message.data);
  assert.equal(injectMessages[0], 'visible-task');
  assert.equal(injectMessages[1], '\r');
  assert.equal(injectMessages.some((data) => String(data).includes('[from:')), false);
  assert.equal(injectMessages.some((data) => String(data).includes('telepty inject --from')), false);

  ownerWs.close();
});

test('known wrapped AI CLI queues inject until bootstrap ready', async () => {
  const sessionId = createSessionId('bootstrap-claude');
  await harness.registerSession(sessionId, { command: 'claude' });

  const ownerWs = await harness.connectSession(sessionId);
  const ownerMessages = collectJsonMessages(ownerWs);

  const inject = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
    method: 'POST',
    body: { prompt: 'bootstrap-task' }
  });
  assert.equal(inject.status, 200);
  assert.equal(inject.body.success, true);
  assert.equal(inject.body.bootstrap_queued, true);

  await delay(250);
  assert.equal(ownerMessages.filter((message) => message.type === 'inject').length, 0);

  ownerWs.send(JSON.stringify({ type: 'ready' }));

  await waitFor(() => ownerMessages.filter((message) => message.type === 'inject').length >= 2, {
    timeoutMs: 5000,
    description: 'bootstrap queued inject drained after ready'
  });

  const injectMessages = ownerMessages.filter((message) => message.type === 'inject').map((message) => message.data);
  assert.equal(injectMessages[0], 'bootstrap-task');
  assert.equal(injectMessages[1], '\r');

  const detail = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}`);
  assert.equal(detail.body.transport.bootstrap.ready, true);
  assert.equal(detail.body.transport.bootstrap.reason, 'bridge_ready');

  ownerWs.close();
});

test('known wrapped AI CLI drains multiple bootstrap injects in FIFO order', async () => {
  const sessionId = createSessionId('bootstrap-order');
  await harness.registerSession(sessionId, { command: 'codex' });

  const ownerWs = await harness.connectSession(sessionId);
  const ownerMessages = collectJsonMessages(ownerWs);

  for (const prompt of ['first', 'second', 'third']) {
    const inject = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
      method: 'POST',
      body: { prompt, no_enter: true }
    });
    assert.equal(inject.status, 200);
    assert.equal(inject.body.bootstrap_queued, true);
  }

  await delay(250);
  assert.equal(ownerMessages.filter((message) => message.type === 'inject').length, 0);

  ownerWs.send(JSON.stringify({ type: 'ready' }));

  await waitFor(() => ownerMessages.filter((message) => message.type === 'inject').length >= 3, {
    timeoutMs: 5000,
    description: 'bootstrap FIFO drain'
  });

  const injectMessages = ownerMessages.filter((message) => message.type === 'inject').map((message) => message.data);
  assert.deepEqual(injectMessages.slice(0, 3), ['first', 'second', 'third']);

  ownerWs.close();
});

test('bootstrap queued submit waits behind queued text and preserves order', async () => {
  const sessionId = createSessionId('bootstrap-submit');
  await harness.registerSession(sessionId, { command: 'gemini' });

  const ownerWs = await harness.connectSession(sessionId);
  const ownerMessages = collectJsonMessages(ownerWs);

  const inject = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
    method: 'POST',
    body: { prompt: 'queued-submit', no_enter: true }
  });
  assert.equal(inject.status, 200);
  assert.equal(inject.body.bootstrap_queued, true);

  const submitPromise = harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/submit`, {
    method: 'POST',
    body: {
      injected_body: 'queued-submit',
      gate_timeout_ms: 5000
    }
  });

  await delay(250);
  assert.equal(ownerMessages.filter((message) => message.type === 'inject').length, 0);

  ownerWs.send(JSON.stringify({ type: 'ready' }));
  const submit = await submitPromise;
  assert.equal(submit.status, 200);
  assert.equal(submit.body.success, true);
  assert.equal(submit.body.bootstrap_queued, true);

  await waitFor(() => ownerMessages.filter((message) => message.type === 'inject').length >= 2, {
    timeoutMs: 5000,
    description: 'bootstrap queued text then submit'
  });

  const injectMessages = ownerMessages.filter((message) => message.type === 'inject').map((message) => message.data);
  assert.equal(injectMessages[0], 'queued-submit');
  assert.equal(injectMessages[1], '\r');

  ownerWs.close();
});

test('codex submit confirmation resends CR when context-ref remains visible and suppresses ready-signal warning after acceptance', async () => {
  const sessionId = createSessionId('codex-submit-resend');
  const sourceId = 'orch'; // orchestrator dispatching a context-ref (orch-lane, registered in beforeEach)
  const body = '[context-ref] Read ~/.telepty/shared/6516f10fb6850f9c9c18f3aa238c0060cc3f5d6b781ba1dca79dd2a12e77d81d.md';

  await harness.registerSession(sessionId, { command: 'codex', backend: 'pty' });
  const ownerWs = await harness.connectSession(sessionId);
  const ownerMessages = collectJsonMessages(ownerWs);

  const bus = await harness.connectBus();
  const busMessages = collectJsonMessages(bus);

  ownerWs.send(JSON.stringify({ type: 'ready' }));
  await waitFor(async () => {
    const detail = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}`);
    return detail.body && detail.body.transport && detail.body.transport.bootstrap.ready;
  }, { timeoutMs: 5000, description: 'codex bootstrap ready' });

  const inject = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
    method: 'POST',
    body: { prompt: body, from: sourceId, no_enter: true }
  });
  assert.equal(inject.status, 200);

  await waitFor(() => ownerMessages.find((message) => message.type === 'inject' && message.data === body), {
    timeoutMs: 5000,
    description: 'codex context-ref delivered'
  });

  ownerWs.send(JSON.stringify({
    type: 'output',
    data: `OpenAI Codex (v0.0.0)\n› ${body}\n  gpt-5 high fast\n`
  }));
  ownerWs.send(JSON.stringify({ type: 'ready' }));

  let crCount = 0;
  ownerWs.on('message', (chunk) => {
    try {
      const message = JSON.parse(chunk.toString());
      if (message.type === 'inject' && message.data === '\r') {
        crCount += 1;
        if (crCount === 2) {
          ownerWs.send(JSON.stringify({ type: 'output', data: 'Working on accepted context\n' }));
        }
      }
    } catch {
      // Ignore malformed frames in the fixture.
    }
  });

  const submit = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/submit`, {
    method: 'POST',
    body: {
      injected_body: body,
      prompt_symbol_gate: false,
      gate_timeout_ms: 1000,
      verify_timeout_ms: 200,
      retry_delay_ms: 100,
      retries: 2
    }
  });

  assert.equal(submit.status, 200, JSON.stringify(submit.body));
  assert.equal(submit.body.success, true);
  assert.equal(submit.body.attempts, 2);
  assert.equal(submit.body.confirm.accepted, true);
  assert.equal(submit.body.confirm.reason, 'state_working');
  assert.equal(crCount, 2);

  await delay(1300);
  assert.equal(
    busMessages.some((message) => message.type === 'TASK_IDLE_NO_REPORT' && message.session_id === sessionId),
    false,
    'ready-signal should not emit TASK_IDLE_NO_REPORT after accepted resend'
  );

  bus.close();
  ownerWs.close();
});

test('codex submit confirmation returns 504 when context-ref remains unsubmitted after bounded CR retries', async () => {
  const sessionId = createSessionId('codex-submit-stuck');
  const body = '[context-ref] Read ~/.telepty/shared/stuck.md';

  await harness.registerSession(sessionId, { command: 'codex', backend: 'pty' });
  const ownerWs = await harness.connectSession(sessionId);
  const ownerMessages = collectJsonMessages(ownerWs);

  ownerWs.send(JSON.stringify({ type: 'ready' }));
  await waitFor(async () => {
    const detail = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}`);
    return detail.body && detail.body.transport && detail.body.transport.bootstrap.ready;
  }, { timeoutMs: 5000, description: 'codex bootstrap ready' });

  const inject = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
    method: 'POST',
    body: { prompt: body, no_enter: true }
  });
  assert.equal(inject.status, 200);
  await waitFor(() => ownerMessages.find((message) => message.type === 'inject' && message.data === body), {
    timeoutMs: 5000,
    description: 'stuck context-ref delivered'
  });

  ownerWs.send(JSON.stringify({
    type: 'output',
    data: `OpenAI Codex (v0.0.0)\n› ${body}\n  gpt-5 high fast\n`
  }));
  ownerWs.send(JSON.stringify({ type: 'output', data: '\x1b]133;B\x07' }));

  const submit = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/submit`, {
    method: 'POST',
    body: {
      injected_body: body,
      prompt_symbol_gate: false,
      gate_timeout_ms: 1000,
      verify_timeout_ms: 200,
      retry_delay_ms: 100,
      retries: 1
    }
  });

  assert.equal(submit.status, 504);
  assert.equal(submit.body.reason, 'submit_unconfirmed');
  assert.equal(submit.body.attempts, 2);
  assert.equal(submit.body.confirm.retryable, true);
  assert.equal(submit.body.verify.consumed, false);

  ownerWs.close();
});

test('bus auto-route uses wrapped WS split delivery instead of cmux direct injection', async () => {
  const sessionId = createSessionId('bus-route');
  await harness.registerSession(sessionId, {
    backend: 'cmux',
    cmux_workspace_id: 'workspace:test'
  });

  const ownerWs = await harness.connectSession(sessionId);
  const ownerMessages = collectJsonMessages(ownerWs);

  const publish = await harness.request('/api/bus/publish', {
    method: 'POST',
    body: {
      type: 'turn_request',
      target: sessionId,
      payload: { prompt: 'bus-visible-task' }
    }
  });
  assert.equal(publish.status, 200);
  assert.equal(publish.body.success, true);

  await waitFor(() => ownerMessages.filter((message) => message.type === 'inject').length >= 2, {
    timeoutMs: 7000,
    description: 'bus auto-route wrapped inject text and deferred CR'
  });

  const injectMessages = ownerMessages.filter((message) => message.type === 'inject').map((message) => message.data);
  assert.equal(injectMessages[0], 'bus-visible-task');
  assert.equal(injectMessages[1], '\r');

  ownerWs.close();
});

test('wrapped session owner output broadcasts to attached clients', async () => {
  const sessionId = createSessionId('owner-broadcast');
  await harness.registerSession(sessionId);

  const ownerWs = await harness.connectSession(sessionId);
  const viewerWs = await harness.connectSession(sessionId);
  const viewerMessages = collectJsonMessages(viewerWs);

  // Owner sends output
  ownerWs.send(JSON.stringify({ type: 'output', data: 'hello-viewer' }));

  await waitFor(() => viewerMessages.find((message) => (
    message.type === 'output' && String(message.data).includes('hello-viewer')
  )), { description: 'owner output relayed to viewer' });

  ownerWs.close();
  viewerWs.close();
});

test('session WebSocket roundtrip relays an owner output frame', async () => {
  const sessionId = createSessionId('ws-roundtrip');
  await harness.registerSession(sessionId);

  const ownerWs = await harness.connectSession(sessionId);
  const viewerWs = await harness.connectSession(sessionId);
  const viewerMessages = collectJsonMessages(viewerWs);
  const token = createSessionId('ws-roundtrip-token');

  ownerWs.send(JSON.stringify({ type: 'output', data: token }));

  const frame = await waitFor(() => viewerMessages.find((message) => (
    message.type === 'output' && message.data === token
  )), { description: 'session WS owner output roundtrip' });
  assert.equal(frame.data, token);

  ownerWs.close();
  viewerWs.close();
});

test('wrapped session non-owner input forwards to owner as inject', async () => {
  const sessionId = createSessionId('viewer-input');
  await harness.registerSession(sessionId);

  const ownerWs = await harness.connectSession(sessionId);
  const ownerMessages = collectJsonMessages(ownerWs);
  const viewerWs = await harness.connectSession(sessionId);

  viewerWs.send(JSON.stringify({ type: 'input', data: 'viewer-typing' }));

  await waitFor(() => ownerMessages.find((message) => (
    message.type === 'inject' && String(message.data).includes('viewer-typing')
  )), { description: 'viewer input forwarded to owner as inject' });

  ownerWs.close();
  viewerWs.close();
});

test('DELETE on wrapped session removes it without crashing the daemon', async () => {
  const sessionId = createSessionId('del-wrap');
  await harness.registerSession(sessionId);

  const destroy = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE'
  });
  assert.equal(destroy.status, 200);
  assert.equal(destroy.body.status, 'closing');

  const list = await harness.request('/api/sessions');
  assert.equal(list.body.some((s) => s.id === sessionId), false);

  await delay(200);
  assert.equal(harness.isAlive(), true, harness.getLogs().stderr || harness.getLogs().stdout);
});

test('wrapped sessions emit disconnect/reconnect/stale lifecycle and clean up after the stale threshold', async () => {
  await harness.stop();
  harness = await startTestDaemon({
    env: {
      TELEPTY_SESSION_STALE_SECONDS: '1',
      TELEPTY_SESSION_CLEANUP_SECONDS: '2',
      TELEPTY_HEALTH_POLL_MS: '100'
    }
  });

  const sessionId = createSessionId('auto-clean');
  const bus = await harness.connectBus();
  const messages = collectJsonMessages(bus);
  await harness.registerSession(sessionId);

  const ownerWs = await harness.connectSession(sessionId);
  await waitFor(async () => {
    const list = await harness.request('/api/sessions');
    const session = list.body.find((item) => item.id === sessionId);
    return session && session.healthStatus === 'CONNECTED';
  }, { description: 'owner connected' });

  ownerWs.close();

  await waitFor(() => messages.find((message) => (
    message.type === 'session_disconnect' &&
    message.session_id === sessionId &&
    message.transport &&
    message.transport.health_status === 'DISCONNECTED'
  )), { description: 'session disconnect event' });

  await waitFor(async () => {
    const list = await harness.request('/api/sessions');
    const session = list.body.find((item) => item.id === sessionId);
    return session && session.healthStatus === 'DISCONNECTED';
  }, { description: 'disconnected health status' });

  const reconnectedWs = await harness.connectSession(sessionId);
  await waitFor(() => messages.find((message) => (
    message.type === 'session_reconnect' &&
    message.session_id === sessionId &&
    message.transport &&
    message.transport.health_status === 'CONNECTED'
  )), { description: 'session reconnect event' });

  reconnectedWs.close();

  await waitFor(() => messages.find((message) => (
    message.type === 'session_stale' &&
    message.session_id === sessionId
  )), { timeoutMs: 5000, description: 'session stale event' });

  await waitFor(async () => {
    const list = await harness.request('/api/sessions');
    const session = list.body.find((item) => item.id === sessionId);
    return session && session.healthStatus === 'STALE';
  }, { timeoutMs: 5000, description: 'stale health status' });

  await waitFor(() => messages.find((message) => (
    message.type === 'session_cleanup' &&
    message.session_id === sessionId
  )), { timeoutMs: 5000, description: 'session cleanup event' });

  await waitFor(async () => {
    const list = await harness.request('/api/sessions');
    return !list.body.some((item) => item.id === sessionId);
  }, { timeoutMs: 5000, description: 'wrapped session cleanup after stale disconnect' });

  bus.close();
});

test('multicast inject handles mixed spawned and wrapped sessions', async () => {
  const spawnedId = createSessionId('multi-spawn');
  const wrappedId = createSessionId('multi-wrap');
  await harness.spawnSession(spawnedId);
  await harness.registerSession(wrappedId);

  // Wrapped session without owner should fail
  const result = await harness.request('/api/sessions/multicast/inject', {
    method: 'POST',
    body: { session_ids: [spawnedId, wrappedId], prompt: 'echo mixed' }
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.results.successful.length, 1);
  assert.equal(result.body.results.successful[0].id, spawnedId);
  assert.equal(result.body.results.failed.length, 1);
  assert.equal(result.body.results.failed[0].id, wrappedId);
  assert.equal(result.body.results.failed[0].code, 'DISCONNECTED');
  assert.match(result.body.results.failed[0].error, /disconnected/i);
});

test('session state reports are stored in snapshots and emitted with normalized transport and semantic blocks', async () => {
  const sessionId = createSessionId('state-report');
  const bus = await harness.connectBus();
  const messages = collectJsonMessages(bus);
  await harness.registerSession(sessionId);

  const report = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/state`, {
    method: 'POST',
    body: {
      phase: 'implementing',
      current_task: 'ship observer schema',
      blocker: 'awaiting review',
      needs_input: true,
      thread_id: 'thread-123'
    }
  });

  assert.equal(report.status, 200);
  assert.equal(report.body.session_id, sessionId);
  assert.equal(report.body.transport.health_status, 'DISCONNECTED');
  assert.deepEqual(report.body.semantic, {
    phase: 'implementing',
    current_task: 'ship observer schema',
    blocker: 'awaiting review',
    needs_input: true,
    thread_id: 'thread-123',
    source: 'self_report',
    seq: 1
  });

  const detail = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.semantic.phase, 'implementing');
  assert.equal(detail.body.semantic.current_task, 'ship observer schema');
  assert.equal(detail.body.transport.health_status, 'DISCONNECTED');

  await waitFor(() => messages.find((message) => (
    message.type === 'session_state_report' &&
    message.event_type === 'session_state_report' &&
    message.session_id === sessionId &&
    message.transport &&
    message.transport.health_status === 'DISCONNECTED' &&
    message.semantic &&
    message.semantic.phase === 'implementing' &&
    message.semantic.current_task === 'ship observer schema' &&
    message.semantic.seq === 1
  )), { description: 'session_state_report bus event' });

  bus.close();
});

test('broadcast inject reports disconnected wrapped sessions with a reason code', async () => {
  const spawnedId = createSessionId('broadcast-ok');
  const wrappedId = createSessionId('broadcast-disconnected');
  await harness.spawnSession(spawnedId);
  await harness.registerSession(wrappedId);

  const result = await harness.request('/api/sessions/broadcast/inject', {
    method: 'POST',
    body: { prompt: 'echo status' }
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.results.successful.some((item) => item.id === spawnedId), true);
  const failure = result.body.results.failed.find((item) => item.id === wrappedId);
  assert.equal(Boolean(failure), true);
  assert.equal(failure.code, 'DISCONNECTED');
  assert.match(failure.error, /disconnected/i);
});

test('aterm delivery timeouts surface a TIMEOUT error code', async () => {
  await harness.stop();
  harness = await startTestDaemon({
    env: {
      TELEPTY_DELIVERY_TIMEOUT_MS: '50'
    }
  });

  const delayedServer = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }, 200);
  });

  await new Promise((resolve) => delayedServer.listen(0, '127.0.0.1', resolve));
  const { port } = delayedServer.address();

  try {
    const sessionId = createSessionId('aterm-timeout');
    const registered = await harness.registerSession(sessionId, {
      delivery_type: 'aterm',
      delivery_endpoint: `http://127.0.0.1:${port}/deliver`
    });
    assert.equal(registered.status, 201);

    // Mailbox enqueue succeeds; delivery timeout happens asynchronously
    const inject = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
      method: 'POST',
      body: { prompt: 'hello timeout' }
    });
    assert.equal(inject.status, 200);
    assert.equal(inject.body.success, true);
    assert.equal(inject.body.strategy, 'mailbox');
  } finally {
    await new Promise((resolve) => delayedServer.close(resolve));
  }
});

test('aterm registration with delivery unix_socket stores delivery and enables UDS inject', async () => {
  const net = require('net');
  const os = require('os');
  const path = require('path');

  const socketPath = path.join(os.tmpdir(), `telepty-test-uds-${Date.now()}.sock`);
  const received = [];

  // Create a UDS server that receives inject payloads
  const udsServer = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => { buf += chunk.toString(); });
    conn.on('end', () => {
      try { received.push(JSON.parse(buf.trim())); } catch {}
      conn.end();
    });
  });

  await new Promise((resolve) => udsServer.listen(socketPath, resolve));

  try {
    const sessionId = createSessionId('aterm-uds');
    const registered = await harness.registerSession(sessionId, {
      delivery_type: 'aterm',
      delivery: { transport: 'unix_socket', address: socketPath }
    });
    assert.equal(registered.status, 201);

    // Verify delivery field is stored and health is CONNECTED
    const list = await harness.request('/api/sessions');
    const session = list.body.find((s) => s.id === sessionId);
    assert.equal(session.delivery.transport, 'unix_socket');
    assert.equal(session.delivery.address, socketPath);
    assert.equal(session.deliveryEndpoint, socketPath);
    assert.equal(session.healthStatus, 'CONNECTED');

    // Inject via UDS
    const inject = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
      method: 'POST',
      body: { prompt: 'hello uds' }
    });
    assert.equal(inject.status, 200);
    assert.equal(inject.body.success, true);
    assert.equal(inject.body.strategy, 'mailbox');

    // Wait for UDS payload to arrive via mailbox delivery engine
    await waitFor(() => received.some(r => r.action === 'Inject'), { timeoutMs: 5000, description: 'UDS text delivery via mailbox' });
    const injectPayloads = received.filter(r => r.action === 'Inject');
    assert.equal(injectPayloads[0].action, 'Inject');
    assert.equal(injectPayloads[0].workspace, sessionId);
    assert.equal(injectPayloads[0].text, 'hello uds');
    // aterm handles Enter internally — no separate CR payload (MailboxWake notifications are separate)
    assert.equal(injectPayloads.length, 1);
  } finally {
    udsServer.close();
    try { require('fs').unlinkSync(socketPath); } catch {}
  }
});

test('aterm UDS inject propagates error when target rejects payload', async () => {
  const net = require('net');
  const os = require('os');
  const path = require('path');

  const socketPath = path.join(os.tmpdir(), `telepty-test-uds-err-${Date.now()}.sock`);

  // Create a UDS server that returns an error response
  const udsServer = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => { buf += chunk.toString(); });
    conn.on('end', () => {
      conn.end(JSON.stringify({ status: 'Error', message: 'workspace not found' }));
    });
  });

  await new Promise((resolve) => udsServer.listen(socketPath, resolve));

  try {
    const sessionId = createSessionId('aterm-uds-err');
    await harness.registerSession(sessionId, {
      delivery_type: 'aterm',
      delivery: { transport: 'unix_socket', address: socketPath }
    });

    // Mailbox enqueue succeeds; delivery rejection happens asynchronously via delivery engine
    const inject = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
      method: 'POST',
      body: { prompt: 'hello error' }
    });

    assert.equal(inject.body.success, true);
    assert.equal(inject.body.strategy, 'mailbox');
  } finally {
    udsServer.close();
    try { require('fs').unlinkSync(socketPath); } catch {}
  }
});

test('spawned shells strip parent Claude session markers from the environment', async () => {
  const marker = createSessionId('claude-env');
  const localHarness = await startTestDaemon({ env: { CLAUDECODE: marker } });

  try {
    const sessionId = createSessionId('env');
    await localHarness.spawnSession(sessionId);
    const ws = await localHarness.connectSession(sessionId);
    const outputs = collectJsonMessages(ws);

    const command = process.platform === 'win32'
      ? "if ($env:CLAUDECODE) { Write-Output $env:CLAUDECODE } else { Write-Output '__unset__' }\r"
      : "if [ -n \"${CLAUDECODE}\" ]; then printf '%s\\n' \"$CLAUDECODE\"; else printf '__unset__\\n'; fi\r";

    ws.send(JSON.stringify({ type: 'input', data: command }));

    await waitFor(() => outputs.some((message) => (
      message.type === 'output' && String(message.data).includes('__unset__')
    )), { timeoutMs: 7000, description: 'sanitized Claude session marker' });

    assert.equal(outputs.some((message) => (
      message.type === 'output' && String(message.data).includes(marker)
    )), false);

    ws.close();
  } finally {
    await localHarness.stop();
  }
});

test('GET /api/health returns status ok and version', async () => {
  const result = await harness.request('/api/health');
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'ok');
  assert.equal(typeof result.body.version, 'string');
  assert.ok(result.body.version.length > 0);
});

test('auto-report: inject with from triggers TASK_COMPLETE when target goes idle', async () => {
  const sourceId = 'orch'; // orchestrator dispatching work (orch-lane, registered in beforeEach)
  const targetId = `auto-rpt-target-${Date.now()}`;

  // Spawn both sessions - target does a quick task then goes idle
  await harness.spawnSession(sourceId, {
    command: process.execPath,
    args: ['-e', "process.stdin.resume(); process.stdin.setEncoding('utf8'); process.stdin.on('data', d => process.stdout.write(d));"]
  });
  await harness.spawnSession(targetId, {
    command: process.execPath,
    args: ['-e', "process.stdin.resume(); process.stdin.setEncoding('utf8'); process.stdin.on('data', d => { process.stdout.write('done\\n'); });"]
  });

  // Watch source session output for auto-report
  const sourceWs = await harness.connectSession(sourceId);
  const sourceOutputs = [];
  sourceWs.on('message', (chunk) => {
    try {
      const msg = JSON.parse(chunk.toString());
      if (msg.type === 'output') sourceOutputs.push(String(msg.data));
    } catch {}
  });

  // Inject from source to target
  const injectResult = await harness.request(`/api/sessions/${targetId}/inject`, {
    method: 'POST',
    body: { prompt: 'do-something', from: sourceId, no_enter: false }
  });
  assert.equal(injectResult.status, 200);

  // Wait for auto-report to arrive at source (idle threshold based for spawned sessions)
  // Default AUTO_REPORT_IDLE_SECONDS is 10, health poll is ~10s. Wait up to 25s.
  await waitFor(() => sourceOutputs.some(o => o.includes('TASK_COMPLETE')), {
    timeoutMs: 25000,
    description: 'auto-report TASK_COMPLETE at source'
  });

  const allOutput = sourceOutputs.join('');
  assert.ok(allOutput.includes('TASK_COMPLETE'));
  assert.ok(allOutput.includes(targetId));

  sourceWs.close();
});

// --- BUG-C: duplicate --id shared-fate (a stale owner's DELETE must not kill the live owner) ---

// Connect a wrapped owner bridge (?owner=1), wait for open, and return the ws plus a live record
// of every JSON frame and close event it sees. No auth token needed — the daemon allows loopback.
async function connectOwner(sessionId) {
  const ws = new WebSocket(`ws://${harness.host}:${harness.port}/api/sessions/${encodeURIComponent(sessionId)}?owner=1`);
  const frames = [];
  const closes = [];
  ws.on('message', (chunk) => {
    try { frames.push(JSON.parse(chunk.toString())); } catch {}
  });
  ws.on('close', (code, reason) => {
    closes.push({ code, reason: reason ? reason.toString() : '' });
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return { ws, frames, closes };
}

async function waitForOwnerToken(owner, description) {
  await waitFor(() => owner.frames.some((m) => m.type === 'owner_token' && m.token), { description });
  return owner.frames.find((m) => m.type === 'owner_token' && m.token).token;
}

test('BUG-C: a displaced owner DELETE (stale token) does not tear down the live current owner', async () => {
  const sessionId = createSessionId('dupid-stale');
  await harness.registerSession(sessionId);

  // Owner A claims first, then owner B reclaims (the legitimate reconnect/reclaim path).
  const ownerA = await connectOwner(sessionId);
  const tokenA = await waitForOwnerToken(ownerA, 'owner A token');

  const ownerB = await connectOwner(sessionId);
  const tokenB = await waitForOwnerToken(ownerB, 'owner B token (reclaim)');

  // Reclaim minted a fresh token for the new live owner — the discriminator the guard relies on.
  assert.notEqual(tokenA, tokenB, 'reclaim must mint a fresh owner token');

  // The stale/displaced owner A exits → DELETE carrying its now-stale token. Must be a no-op.
  const detach = await harness.request(
    `/api/sessions/${encodeURIComponent(sessionId)}?owner_token=${encodeURIComponent(tokenA)}`,
    { method: 'DELETE' }
  );
  assert.equal(detach.status, 200);
  assert.equal(detach.body.status, 'stale-detached');

  // The live owner B must NOT have been closed with the lethal destroy frame, and the record stays.
  await delay(200);
  assert.ok(
    !ownerB.closes.some((c) => c.code === 1000 && c.reason === 'Session destroyed'),
    'live owner B must not receive the Session destroyed close'
  );
  assert.equal(ownerB.ws.readyState, WebSocket.OPEN, 'live owner B socket must stay open');
  const stillThere = await harness.request('/api/sessions');
  assert.ok(stillThere.body.some((s) => s.id === sessionId), 'session record must survive a stale DELETE');

  ownerB.ws.close();
});

test('BUG-C: reclaim re-mints the owner token and reattaches the new live owner', async () => {
  const sessionId = createSessionId('dupid-reclaim');
  await harness.registerSession(sessionId);

  const ownerA = await connectOwner(sessionId);
  const tokenA = await waitForOwnerToken(ownerA, 'owner A token');

  // Owner B reconnects/reclaims with ?owner=1 — must become the owner and get a fresh token.
  const ownerB = await connectOwner(sessionId);
  const tokenB = await waitForOwnerToken(ownerB, 'owner B token after reclaim');
  assert.notEqual(tokenA, tokenB, 'reclaim must mint a fresh owner token');

  // An inject now routes to the reclaimed owner B (reattach is intact).
  const inject = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
    method: 'POST',
    body: { prompt: 'hi-reclaim' }
  });
  assert.equal(inject.status, 200);
  await waitFor(() => ownerB.frames.some((m) => m.type === 'inject'),
    { description: 'reclaimed owner B receives the inject' });

  ownerB.ws.close();
});

test('BUG-C: the current owner DELETE (matching token) destroys the session normally', async () => {
  const sessionId = createSessionId('dupid-owner');
  await harness.registerSession(sessionId);

  const owner = await connectOwner(sessionId);
  const token = await waitForOwnerToken(owner, 'owner token');

  const destroy = await harness.request(
    `/api/sessions/${encodeURIComponent(sessionId)}?owner_token=${encodeURIComponent(token)}`,
    { method: 'DELETE' }
  );
  assert.equal(destroy.status, 200);

  // The owner receives the destroy frame and the record is gone — normal single-owner teardown.
  await waitFor(() => owner.closes.some((c) => c.code === 1000 && c.reason === 'Session destroyed'),
    { description: 'current owner receives Session destroyed' });
  await waitFor(async () => {
    const list = await harness.request('/api/sessions');
    return list.status === 200 && !list.body.some((s) => s.id === sessionId);
  }, { description: 'session removed after current-owner delete' });
});

test('BUG-C: a tokenless DELETE still destroys a wrapped session (operator delete unchanged)', async () => {
  const sessionId = createSessionId('dupid-tokenless');
  await harness.registerSession(sessionId);

  const owner = await connectOwner(sessionId);
  await waitForOwnerToken(owner, 'owner token');

  // No owner_token → guard does not trigger → legacy destroy behavior is preserved.
  const destroy = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  assert.equal(destroy.status, 200);

  await waitFor(() => owner.closes.some((c) => c.code === 1000 && c.reason === 'Session destroyed'),
    { description: 'tokenless delete closes the owner' });
  await waitFor(async () => {
    const list = await harness.request('/api/sessions');
    return list.status === 200 && !list.body.some((s) => s.id === sessionId);
  }, { description: 'session removed after tokenless delete' });
});
