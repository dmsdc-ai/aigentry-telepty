'use strict';

// #43 P1+P2+P3 — daemon-side audit wiring (integration, real daemon subprocess).
//  P1: inject/multicast/broadcast deliveries append a schema-v1 line to
//      ~/.telepty/logs/injects.jsonl with claimed_from + payload_sha256, hash-only.
//  P2: a per-session token from /register, presented as x-telepty-session-token, yields
//      verified_sender_sid; a spoofed/absent token yields verified=null / spoof_suspected.
//  P3: GET /api/injects returns filtered, paginated lines (token-gated by the shared
//      auth middleware — covered as a unit in http-auth path; here we assert filters work).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { startTestDaemon, createSessionId } = require('../test-support/daemon-harness');

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

let daemon;
let logPath;

before(async () => {
  daemon = await startTestDaemon({ env: { TELEPTY_AUDIT_FLUSH_MS: '10' } });
  logPath = path.join(daemon.homeDir, '.telepty', 'logs', 'injects.jsonl');
});

after(async () => { if (daemon) await daemon.stop(); });

// Wait until at least one audit line matches `predicate`, then return ALL parsed lines.
// Predicate-gated so a test never races the 10ms flush against lines from earlier tests.
async function waitForAudit(predicate) {
  return daemon.waitFor(() => {
    let raw = '';
    try { raw = fs.readFileSync(logPath, 'utf8'); } catch { return null; }
    const lines = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return lines.some(predicate) ? lines : null;
  }, { timeoutMs: 4000, description: 'audit lines' });
}

test('P1: inject appends an audit line (schema v1, claimed_from, hash-only)', async () => {
  const sid = createSessionId('aud');
  await daemon.spawnSession(sid);
  const payload = 'audit me please';
  const res = await daemon.request(`/api/sessions/${encodeURIComponent(sid)}/inject`, {
    method: 'POST', body: { prompt: payload, from: 'orchestrator' }
  });
  assert.equal(res.status, 200);

  const lines = await waitForAudit((l) => l.to === sid && l.claimed_from === 'orchestrator');
  const line = lines.find((l) => l.claimed_from === 'orchestrator' && l.to === sid);
  assert.ok(line, 'expected an audit line for this inject');
  assert.equal(line.v, 1);
  assert.equal(line.kind, 'inject');
  assert.equal(line.payload_sha256, sha256(payload));
  assert.equal(line.payload_preview, null); // hash-only default — no prompt content on disk
  assert.equal(line.delivery_result, 'success');
  // payload content must NOT appear anywhere on disk
  assert.equal(fs.readFileSync(logPath, 'utf8').includes('audit me please'), false);
});

test('P2: valid session token (claim == verified) => verified_sender_sid set, no spoof', async () => {
  // Register the sender AS the orchestrator so claimed == verified and the #45 guard allows it.
  const reg = await daemon.request('/api/sessions/register', { method: 'POST', body: { session_id: 'orchestrator', command: 'x' } });
  assert.equal(reg.status === 200 || reg.status === 201, true);
  const token = reg.body.session_token;
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 16);

  const target = createSessionId('target');
  await daemon.spawnSession(target);
  const res = await daemon.request(`/api/sessions/${encodeURIComponent(target)}/inject`, {
    method: 'POST',
    headers: { 'x-telepty-session-token': token },
    body: { prompt: 'verified hello', from: 'orchestrator' }
  });
  assert.equal(res.status, 200);

  const lines = await waitForAudit((l) => l.to === target && l.claimed_from === 'orchestrator' && l.verified_sender_sid === 'orchestrator');
  const line = lines.find((l) => l.to === target && l.claimed_from === 'orchestrator');
  assert.ok(line, 'expected audit line for verified inject');
  assert.equal(line.verified_sender_sid, 'orchestrator');
  assert.equal(line.spoof_suspected, false);
});

test('P2: spoof — claim orchestrator but token maps to a different sid => spoof_suspected', async () => {
  // The imposter registers (gets a real token for its true sid) yet CLAIMS to be the
  // orchestrator. claimed='orchestrator' passes the #45 guard; the token reveals the truth.
  const imposterSid = createSessionId('imposter');
  const reg = await daemon.request('/api/sessions/register', { method: 'POST', body: { session_id: imposterSid, command: 'x' } });
  const token = reg.body.session_token;

  const target = createSessionId('victim');
  await daemon.spawnSession(target);
  const res = await daemon.request(`/api/sessions/${encodeURIComponent(target)}/inject`, {
    method: 'POST',
    headers: { 'x-telepty-session-token': token },
    body: { prompt: 'i am totally the orchestrator', from: 'orchestrator' }
  });
  assert.equal(res.status, 200);

  const lines = await waitForAudit((l) => l.to === target && l.claimed_from === 'orchestrator');
  const line = lines.find((l) => l.to === target && l.claimed_from === 'orchestrator');
  assert.ok(line, 'expected audit line for spoofed inject');
  assert.equal(line.verified_sender_sid, imposterSid); // daemon-verified true identity
  assert.equal(line.spoof_suspected, true);            // claimed != verified
});

test('P2: absent token => verified_sender_sid null (operator/unverified, no spoof flag)', async () => {
  const target = createSessionId('notok');
  await daemon.spawnSession(target);
  const res = await daemon.request(`/api/sessions/${encodeURIComponent(target)}/inject`, {
    method: 'POST', body: { prompt: 'no token here', from: 'orchestrator' }
  });
  assert.equal(res.status, 200);
  const lines = await waitForAudit((l) => l.to === target && l.claimed_from === 'orchestrator');
  const line = lines.find((l) => l.to === target && l.claimed_from === 'orchestrator');
  assert.ok(line);
  assert.equal(line.verified_sender_sid, null);
  assert.equal(line.spoof_suspected, false); // null verified is never a spoof
});

test('P3: GET /api/injects returns lines filtered by to + from with pagination shape', async () => {
  const target = createSessionId('queryme');
  await daemon.spawnSession(target);
  await daemon.request(`/api/sessions/${encodeURIComponent(target)}/inject`, {
    method: 'POST', body: { prompt: 'p3 query body', from: 'orchestrator' }
  });
  await waitForAudit((l) => l.to === target); // ensure flushed

  const res = await daemon.request(`/api/injects?to=${encodeURIComponent(target)}&from=orchestrator&limit=50`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.injects));
  assert.equal(Object.prototype.hasOwnProperty.call(res.body, 'next_cursor'), true);
  const hit = res.body.injects.find((l) => l.to === target);
  assert.ok(hit, 'expected the just-injected line in the query');
  assert.equal(hit.claimed_from, 'orchestrator');
});

test('P3: /api/injects is token-gated by the shared auth middleware (401 unauthorized)', async () => {
  // #820: this used to need `isAllowedPeer: () => false` to "simulate a remote caller", because
  // the live daemon TRUSTED localhost and a 401 was otherwise unreachable from a test. That was
  // the vulnerability. The peer stub is now `true` (reachable, the ordinary case) and the 401 is
  // produced by the thing that should produce it: no credential.
  const express = require('express');
  const { createAuthMiddleware } = require('../src/protocol/http-auth');
  const { readInjectLog } = require('../src/audit/inject-log');
  const app = express();
  app.use(createAuthMiddleware({
    isAllowedPeer: () => true,
    expectedToken: 'sekret',
    verifyJwt: () => false
  }));
  app.get('/api/injects', (req, res) => res.json(readInjectLog('/nonexistent', {})));

  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const unauth = await fetch(`${base}/api/injects`);
    assert.equal(unauth.status, 401);
    const authed = await fetch(`${base}/api/injects`, { headers: { 'x-telepty-token': 'sekret' } });
    assert.equal(authed.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('P1: multicast appends one audit line per target sharing an inject_id', async () => {
  const a = createSessionId('mc-a');
  const b = createSessionId('mc-b');
  await daemon.spawnSession(a);
  await daemon.spawnSession(b);
  const res = await daemon.request('/api/sessions/multicast/inject', {
    method: 'POST', body: { session_ids: [a, b], prompt: 'fan out', from: 'orchestrator' }
  });
  assert.equal(res.status, 200);

  const lines = await waitForAudit((l) => l.kind === 'multicast' && l.to === b);
  const mcLines = lines.filter((l) => l.kind === 'multicast' && (l.to === a || l.to === b));
  assert.equal(mcLines.length >= 2, true);
  const forA = mcLines.find((l) => l.to === a);
  const forB = mcLines.find((l) => l.to === b);
  assert.ok(forA && forB);
  assert.equal(forA.inject_id, forB.inject_id); // one fan-out, grouped by inject_id
});
