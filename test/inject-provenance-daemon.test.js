'use strict';

// #47 P4+P5 — daemon-side provenance + audit wiring (integration, real daemon subprocess).
//  P4: /register mints a per-session nonce and echoes the opt-in capability (default-OFF). The
//      banner-wrapping decision itself is pure (covered by test/provenance.test.js); here we lock
//      the register contract the `allow` wrapper depends on.
//  P5: a #45-blocked peer-lane inject (single + fan-out) records a `blocked:<reason>` audit line —
//      the gate logic is unchanged; the attempt is now auditable, not just successful deliveries.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestDaemon, createSessionId } = require('../test-support/daemon-harness');

let daemon;
let logPath;

before(async () => {
  daemon = await startTestDaemon({ env: { TELEPTY_AUDIT_FLUSH_MS: '10', AIGENTRY_ORCHESTRATOR_SIDS: 'orchestrator' } });
  logPath = path.join(daemon.homeDir, '.telepty', 'logs', 'injects.jsonl');
});

after(async () => { if (daemon) await daemon.stop(); });

async function waitForAudit(predicate) {
  return daemon.waitFor(() => {
    let raw = '';
    try { raw = fs.readFileSync(logPath, 'utf8'); } catch { return null; }
    const lines = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return lines.some(predicate) ? lines : null;
  }, { timeoutMs: 4000, description: 'audit lines' });
}

// --- P4 register contract ---------------------------------------------------

test('P4: register mints a per-session nonce; capability is OFF by default', async () => {
  const sid = createSessionId('prov-off');
  const reg = await daemon.request('/api/sessions/register', { method: 'POST', body: { session_id: sid, command: 'x' } });
  assert.equal(reg.status === 200 || reg.status === 201, true);
  assert.equal(typeof reg.body.session_nonce, 'string');
  assert.ok(reg.body.session_nonce.length >= 16, 'nonce carries entropy');
  assert.equal(reg.body.provenance_capable, false, 'default-OFF: no banner until opted in');
});

test('P4: provenance_capable:true opts the session in; nonce is stable across re-register', async () => {
  const sid = createSessionId('prov-on');
  const reg1 = await daemon.request('/api/sessions/register', { method: 'POST', body: { session_id: sid, command: 'x', provenance_capable: true } });
  assert.equal(reg1.body.provenance_capable, true);
  const nonce1 = reg1.body.session_nonce;

  // A metadata re-register (no capability flag) must NOT drop capability nor rotate the nonce —
  // the carried env copy would otherwise go stale and every banner would read as untrusted.
  const reg2 = await daemon.request('/api/sessions/register', { method: 'POST', body: { session_id: sid, command: 'x' } });
  assert.equal(reg2.body.provenance_capable, true, 'capability is sticky once on');
  assert.equal(reg2.body.session_nonce, nonce1, 'nonce is idempotent per sid');
});

// --- P5 #45 blocked-inject audit line ---------------------------------------

test('P5: a blocked peer-lane single inject records a blocked:<reason> audit line', async () => {
  const a = createSessionId('peer-a');
  const b = createSessionId('peer-b');
  await daemon.request('/api/sessions/register', { method: 'POST', body: { session_id: a, command: 'x' } });
  await daemon.request('/api/sessions/register', { method: 'POST', body: { session_id: b, command: 'x' } });

  // peer→peer plain prompt (no sanctioned ask envelope) → #45 hard block (403).
  const res = await daemon.request(`/api/sessions/${encodeURIComponent(b)}/inject`, {
    method: 'POST', body: { prompt: 'do my work for me', from: a }
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'PEER_INJECT_BLOCKED');

  const lines = await waitForAudit((l) => l.to === b && l.claimed_from === a && /^blocked:/.test(l.delivery_result));
  const line = lines.find((l) => l.to === b && l.claimed_from === a && /^blocked:/.test(l.delivery_result));
  assert.ok(line, 'expected a blocked: audit line for the blocked peer inject');
  assert.match(line.delivery_result, /^blocked:/);
  assert.equal(line.kind, 'inject');
  // hash-only default holds for blocked attempts too — no prompt content on disk.
  assert.equal(line.payload_preview, null);
  assert.equal(fs.readFileSync(logPath, 'utf8').includes('do my work for me'), false);
});

test('P5: a blocked peer-lane multicast records a blocked: line per intended target', async () => {
  const a = createSessionId('mc-a');
  const t1 = createSessionId('mc-t1');
  const t2 = createSessionId('mc-t2');
  await daemon.request('/api/sessions/register', { method: 'POST', body: { session_id: a, command: 'x' } });
  await daemon.request('/api/sessions/register', { method: 'POST', body: { session_id: t1, command: 'x' } });
  await daemon.request('/api/sessions/register', { method: 'POST', body: { session_id: t2, command: 'x' } });

  const res = await daemon.request('/api/sessions/multicast/inject', {
    method: 'POST', body: { session_ids: [t1, t2], prompt: 'fan out my work', from: a }
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'PEER_INJECT_BLOCKED');

  await waitForAudit((l) => l.to === t1 && l.claimed_from === a && /^blocked:/.test(l.delivery_result));
  const lines = await waitForAudit((l) => l.to === t2 && l.claimed_from === a && /^blocked:/.test(l.delivery_result));
  const forT1 = lines.find((l) => l.to === t1 && l.claimed_from === a && /^blocked:/.test(l.delivery_result));
  const forT2 = lines.find((l) => l.to === t2 && l.claimed_from === a && /^blocked:/.test(l.delivery_result));
  assert.ok(forT1 && forT2, 'one blocked: line per intended fan-out target');
  assert.equal(forT1.kind, 'multicast');
  assert.equal(forT2.source, 'multicast');
});
