'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readinessSnapshot, recordReadyEvidence, waitForReadiness, registerReadinessRoute } = require('../src/readiness');
const { runReadinessCommand } = require('../src/cli/readiness');
const registry = require('../src/prompt-symbol-registry');
function owner() {
  return { id: 'worker', command: 'claude', type: 'wrapped', sessionEpoch: 'epoch1',
    interactionOwnerGeneration: 'owner1', interactionInputGeneration: 2,
    interactionGeometryGeneration: 1, ownerWs: { readyState: 1 }, outputRing: [],
    readyKind: 'composer_surface_observed', readyDetector: 'claude_composer', readyCliKey: 'claude' };
}

test('#22 known composer with old Welcome banner reports bound evidence without mutation', () => {
  const s = owner();
  const prompt = 'Welcome back ...\n────────────────────\n❯ Try "fix lint errors"\n────────────────────';
  assert.equal(registry.detectOutput('claude', prompt).found, true);
  s.outputRing = [prompt]; recordReadyEvidence(s, 1000);
  const before = JSON.stringify(s);
  const r = readinessSnapshot(s, { nowMs: 2000, machineId: 'host' });
  assert.equal(r.ready, true); assert.equal(r.status, 'ready');
  assert.equal(r.session_epoch, 'epoch1'); assert.equal(r.owner_generation, 'owner1');
  assert.equal(r.observed_at, new Date(1000).toISOString());
  assert.equal(r.completion_fact, null); assert.equal(r.terminal, false);
  assert.equal(JSON.stringify(s), before);
});

for (const field of ['sessionEpoch', 'interactionOwnerGeneration', 'interactionInputGeneration', 'interactionGeometryGeneration']) {
  test(`#22 changed ${field} invalidates composer evidence`, () => {
    const s = owner(); recordReadyEvidence(s);
    s[field] = typeof s[field] === 'number' ? s[field] + 1 : 'changed';
    assert.equal(readinessSnapshot(s).ready, false);
    assert.equal(readinessSnapshot(s).reason, 'composer_evidence_invalidated');
  });
}

test('#22 replacement/disconnection cannot inherit readiness', () => {
  const s = owner(); recordReadyEvidence(s);
  s.ownerWs = { readyState: 1 };
  assert.equal(readinessSnapshot(s).ready, false);
  s.ownerWs.readyState = 3;
  assert.equal(readinessSnapshot(s).reason, 'owner_disconnected');
});

test('#22 compatibility ready and CONNECTED are not composer evidence', () => {
  const s = owner(); s.command = 'bash'; s.ready = true;
  s.readyKind = 'prompt_suffix_observed'; s.readyCliKey = null; recordReadyEvidence(s);
  assert.equal(readinessSnapshot(s).status, 'unsupported');
  assert.equal(readinessSnapshot(s).ready, false);
  const known = owner(); known.ready = true; known.bootstrapReady = true;
  assert.equal(readinessSnapshot(known).reason, 'no_current_composer_evidence');
});

test('#22 modal is an observed blocker, never auto-approved', () => {
  const s = owner(); recordReadyEvidence(s);
  s.outputRing = ['Yes, I trust this folder'];
  const before = JSON.stringify(s);
  assert.equal(readinessSnapshot(s).status, 'blocked');
  assert.equal(JSON.stringify(s), before);
});

test('#22 wait pins the original instance and bounds polling', async () => {
  const s = owner(); let current = s; let now = 0; let polls = 0;
  const sleep = async ms => { now += ms; polls++; };
  const timeout = await waitForReadiness(() => current, { timeoutMs: 250, now: () => now, sleep });
  assert.equal(timeout.status, 'timeout'); assert.equal(timeout.waited_ms, 250); assert.ok(polls <= 3);
  now = 0;
  const changed = await waitForReadiness(() => current, { timeoutMs: 250, now: () => now,
    sleep: async ms => { now += ms; current = { ...s, sessionEpoch: 'new' }; } });
  assert.equal(changed.reason, 'session_instance_changed'); assert.equal(changed.ready, false);
});

test('#22 wait observes a new qualified frame without any write', async () => {
  const s = owner(); let now = 0;
  const r = await waitForReadiness(() => s, { timeoutMs: 1000, now: () => now,
    sleep: async ms => { now += ms; recordReadyEvidence(s, now); } });
  assert.equal(r.ready, true); assert.equal(r.waited_ms, 100);
});

test('#22 route is exact, refuses stale epoch, and rejects unbounded waits', async () => {
  const s = owner(); recordReadyEvidence(s); const sessions = { worker: s, 'work-1': owner(), 'work-2': owner() };
  let handler; registerReadinessRoute({ get: (_p, h) => { handler = h; } }, { sessions, machineId: 'local' });
  async function request(id, query = {}) {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(body) { this.body = body; return this; } };
    await handler({ params: { id }, query }, res); return res;
  }
  const before = JSON.stringify(sessions);
  assert.equal((await request('work')).code, 404, 'no fuzzy fallback over ambiguous prefix');
  assert.equal((await request('worker', { session_epoch: 'stale' })).code, 409);
  assert.equal((await request('worker', { timeout_ms: '30001' })).code, 400);
  assert.equal((await request('worker')).body.ready, true);
  assert.equal(JSON.stringify(sessions), before);
});

test('#22 CLI reads only exact configured endpoint and bounds requests', async () => {
  const calls = []; const output = [];
  const result = await runReadinessCommand('wait-ready', ['worker', '--timeout-ms', '25', '--json'], {
    remoteHost: '127.0.0.1', daemonUrl: host => `http://${host}:1234`,
    fetchWithAuth: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ ready: true, status: 'ready' }) }; },
    print: line => output.push(line)
  });
  assert.equal(result, 0); assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/sessions\/worker\/handshake\?timeout_ms=25$/);
  assert.equal(calls[0].options.method, 'GET'); assert.ok(calls[0].options.signal);
  assert.equal(JSON.parse(output[0]).ready, true);
});

test('#22 real owner frames and CLI observe readiness, invalidate on output/input, and never write', async t => {
  const http = require('node:http');
  const express = require('express');
  const WebSocket = require('ws');
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const { installWebSocketTransport } = require('../src/transport/websocket');
  const { createCredentialStore } = require('../src/session-store/session-credentials');
  const app = express(); const server = http.createServer(app);
  const s = owner(); s.ownerWs = null; s.clients = new Set();
  const sessions = { worker: s }; const credentials = createCredentialStore();
  const issued = credentials.issue('worker'); const token = 'readiness-test-daemon-token';
  registerReadinessRoute(app, { sessions, machineId: 'isolated-test' });
  const messages = [];
  installWebSocketTransport({ server, sessions, credentials, busClients: new Set(),
    expectedToken: token, verifyJwt: () => false, isAllowedPeer: () => true,
    initializeBootstrapState: () => {}, findKittySocket: () => null, findKittyWindowId: () => null,
    markSessionConnected: () => {}, scheduleBootstrapPromptPoll: () => {},
    emitSessionLifecycleEvent: () => {}, persistSessions: () => {},
    appendToOutputRing: (session, data) => session.outputRing.push(data),
    sessionStateManager: { feed: () => {} }, isBootstrapGatedSession: () => false,
    markBootstrapReady: () => {}, pendingReports: {}, fireAutoReport: () => {},
    markSessionDisconnected: () => {}, resolveSessionAlias: id => id,
    applySessionStateReport: () => ({ success: false }), busAutoRoute: () => {} });
  const port = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/worker?token=${token}&owner=1`, {
    headers: { 'x-telepty-session-token': issued.bearer }
  });
  t.after(async () => { ws.terminate(); await new Promise(resolve => server.close(resolve)); });
  ws.on('message', value => messages.push(JSON.parse(value)));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  async function until(predicate) {
    const end = Date.now() + 1000;
    while (!predicate()) {
      assert.ok(Date.now() < end, 'test-owned frame processing must finish');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  const ready = () => ws.send(JSON.stringify({ type: 'ready', ready_kind: 'composer_surface_observed',
    detector: 'claude_composer', cli_key: 'claude' }));
  ready(); await until(() => readinessSnapshot(s).ready);
  const before = messages.length;
  const result = await promisify(execFile)(process.execPath, ['cli.js', 'wait-ready', 'worker', '--json', '--timeout-ms', '50'], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: { ...process.env, TELEPTY_AUTH_TOKEN: token, TELEPTY_HOST: '127.0.0.1', TELEPTY_PORT: String(port) }
  });
  assert.equal(JSON.parse(result.stdout).ready, true);
  assert.equal(JSON.parse(result.stdout).session_epoch, issued.epoch);
  assert.equal(messages.length, before, 'GET handshake sends no keys or owner frames');
  ws.send(JSON.stringify({ type: 'output', data: 'Processing a task' }));
  await until(() => !readinessSnapshot(s).ready);
  assert.equal(readinessSnapshot(s).reason, 'composer_evidence_invalidated');
  ready(); await until(() => readinessSnapshot(s).ready);
  ws.send(JSON.stringify({ type: 'session_died', exitCode: 1, willRestart: true }));
  await until(() => !readinessSnapshot(s).ready);
  ready(); await until(() => readinessSnapshot(s).ready);
  ws.send(JSON.stringify({ type: 'interaction_invalidated', owner_generation: s.interactionOwnerGeneration,
    input_generation: s.interactionInputGeneration + 1, geometry_generation: s.interactionGeometryGeneration }));
  await until(() => !readinessSnapshot(s).ready);
  assert.equal(readinessSnapshot(s).reason, 'composer_evidence_invalidated');
});

test('#22 actual read-only CLI with no credentials fails without creating config or daemon state', async t => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { promisify } = require('node:util'); const { execFile } = require('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-ready-missing-auth-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, TELEPTY_HOST: '127.0.0.1', TELEPTY_PORT: '1' };
  delete env.TELEPTY_AUTH_TOKEN; delete env.TELEPTY_SESSION_TOKEN;
  let failure;
  try { await promisify(execFile)(process.execPath, ['cli.js', 'readiness', 'worker', '--json'], {
    cwd: path.resolve(__dirname, '..'), env
  }); } catch (error) { failure = error; }
  assert.equal(failure?.code, 1);
  assert.equal(JSON.parse(failure.stdout).status, 'error');
  assert.deepEqual(fs.readdirSync(home), [], 'no config, peer store, or daemon state is created');
});

test('#22 closing and destroyed PTY observations override a previously ready composer', () => {
  const s = owner(); recordReadyEvidence(s);
  s.isClosing = true;
  assert.equal(readinessSnapshot(s).reason, 'session_closing');
  s.isClosing = false; s.bridgeReadSide = 'destroyed';
  assert.equal(readinessSnapshot(s).reason, 'pty_read_side_unavailable');
});

test('#22 pending wait capacity is bounded and released after each deadline', async () => {
  let handler; const s = owner();
  registerReadinessRoute({ get: (_p, h) => { handler = h; } }, { sessions: { worker: s } });
  function request() {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(body) { this.body = body; return this; } };
    const pending = handler({ params: { id: 'worker' }, query: { timeout_ms: '5' } }, res);
    return { pending, res };
  }
  const requests = Array.from({ length: 32 }, request);
  const excess = request(); await excess.pending;
  assert.equal(excess.res.code, 429);
  await Promise.all(requests.map(r => r.pending));
  const next = request(); await next.pending;
  assert.equal(next.res.code, 408, 'capacity is released on completion');
});
