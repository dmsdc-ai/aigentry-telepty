'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Pick a random high port to avoid conflicts with a running daemon
const TEST_PORT = 30000 + Math.floor(Math.random() * 5000);
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

// Set env vars BEFORE requiring daemon so it binds to our test port
process.env.PORT = String(TEST_PORT);
process.env.HOST = '127.0.0.1';

// Load the daemon module - it calls app.listen() at module level
require('../daemon');

// Helper: wait until the server is actually accepting connections
async function waitForServer(url, maxMs = 5000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${url}/api/sessions`);
      return; // success
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  throw new Error(`Server at ${url} did not start within ${maxMs}ms`);
}

before(async () => {
  await waitForServer(BASE_URL);
});

after(() => {
  // Close all open net.Server / WebSocketServer handles so the process can exit
  for (const handle of process._getActiveHandles()) {
    if (typeof handle.close === 'function') {
      try { handle.close(); } catch { /* ignore */ }
    }
    if (typeof handle.destroy === 'function') {
      try { handle.destroy(); } catch { /* ignore */ }
    }
  }
});

// ── helpers ─────────────────────────────────────────────────────────────────

function post(path, body) {
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function del(path) {
  return fetch(`${BASE_URL}${path}`, { method: 'DELETE' });
}

function get(path) {
  return fetch(`${BASE_URL}${path}`);
}

// ── tests ────────────────────────────────────────────────────────────────────

test('GET /api/sessions returns empty array initially', async () => {
  const res = await get('/api/sessions');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body), 'response should be an array');
  assert.equal(body.length, 0);
});

test('POST /api/sessions/spawn with missing session_id returns 400', async () => {
  const res = await post('/api/sessions/spawn', { command: 'echo' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error, 'error field should be present');
});

test('POST /api/sessions/spawn with missing command returns 400', async () => {
  const res = await post('/api/sessions/spawn', { session_id: 'test-no-cmd' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error, 'error field should be present');
});

test('POST /api/sessions/spawn with valid data returns 201', async () => {
  const res = await post('/api/sessions/spawn', {
    session_id: 'test-session-1',
    command: 'bash',
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.session_id, 'test-session-1');
  assert.equal(body.command, 'bash');
});

test('GET /api/sessions returns the spawned session', async () => {
  const res = await get('/api/sessions');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body));
  const session = body.find(s => s.id === 'test-session-1');
  assert.ok(session, 'test-session-1 should appear in session list');
  assert.equal(session.command, 'bash');
});

test('POST /api/sessions/:id/inject with valid prompt returns success', async () => {
  const res = await post('/api/sessions/test-session-1/inject', {
    prompt: 'echo hello',
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
});

test('POST /api/sessions/:id/inject with missing prompt returns 400', async () => {
  const res = await post('/api/sessions/test-session-1/inject', {});
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error, 'error field should be present');
});

test('DELETE /api/sessions/:id returns success', async () => {
  const res = await del('/api/sessions/test-session-1');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
});

test('POST /api/sessions/spawn with duplicate ID returns 409', async () => {
  // Spawn the session first
  const first = await post('/api/sessions/spawn', {
    session_id: 'dup-session',
    command: 'bash',
  });
  assert.equal(first.status, 201);

  // Attempt to spawn with the same ID
  const second = await post('/api/sessions/spawn', {
    session_id: 'dup-session',
    command: 'bash',
  });
  assert.equal(second.status, 409);
  const body = await second.json();
  assert.ok(body.error, 'error field should be present');

  // Cleanup
  await del('/api/sessions/dup-session');
});
