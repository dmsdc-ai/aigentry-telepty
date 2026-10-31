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
async function waitForAudit(predicate, diagKeys = null) {
  const t0 = Date.now();
  const atStart = auditFileIdentity();   // #1215 diagnostics baseline only (one stat); never asserted
  try {
    return await daemon.waitFor(() => {
      let raw = '';
      try { raw = fs.readFileSync(logPath, 'utf8'); } catch { return null; }
      const lines = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      return lines.some(predicate) ? lines : null;
    }, { timeoutMs: 4000, description: 'audit lines' });
  } catch (error) {
    // #1215 diagnostics only (CI 5914cc3 win32: three audit waits timed out with no daemon evidence):
    // appended to the already-failing error, never consulted by an assertion. Separates "never queued"
    // ([INJECT] line absent) from a writer error ([AUDIT] write error) from a writer that did not
    // complete a write in the window (file unchanged since before the wait).
    // #1215 (a01 win32 multicast): also the same-file identity across the wait, one final re-read, and the
    // daemon's own audit-writer counters/stage + event-loop telemetry from /api/meta (bounded 2 s), so a
    // dropped append, a writer exception, an armed-but-unfired flush timer and a stalled fs stage differ.
    error.message += ` | [telepty-diag] audit_wait ${JSON.stringify(await auditDiag(t0, atStart, predicate, diagKeys))}`;
    throw error;
  }
}
function auditFileIdentity() {
  try { const st = fs.statSync(logPath); return { bytes: st.size, mtime_ms: st.mtimeMs, ino: st.ino, birthtime_ms: st.birthtimeMs }; }
  catch (e) { return { error: e.code || 'stat_failed' }; }
}
async function auditDiag(t0, atStart, predicate, diagKeys) {
  const rel = (f) => (f.error ? f : { bytes: f.bytes, mtime_ms_after_wait_start: Math.round(f.mtime_ms - t0) });
  const atCatch = auditFileIdentity();
  let reread = null;
  try {
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    let matching = 0; let unparsed = 0;
    for (const l of lines) { try { if (predicate(JSON.parse(l))) matching++; } catch { unparsed++; } }
    reread = { lines: lines.length, matching, unparsed };
  } catch (e) { reread = { error: e.code || 'read_failed' }; }
  const { stdout, stderr } = daemon.getLogs();
  const keep = (l) => !Array.isArray(diagKeys) || diagKeys.some((k) => l.includes(k));
  // The target filter applies to [INJECT] lines only: '[AUDIT] write error' lines carry no sid (daemon.js:486), so
  // filtering them by target would always hide writer errors. Both tails stay the last 4 lines, each capped at 300 chars.
  const tail = (text, prefix, filtered) => text.split(/\r?\n/).filter((l) => l.startsWith(prefix) && (!filtered || keep(l))).slice(-4).map((l) => l.slice(0, 300));
  let meta = null; let timer = null;
  const tm = Date.now();
  try {
    const r = await Promise.race([daemon.request('/api/meta'),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), 2000); })]);
    meta = r ? { request_ms: Date.now() - tm, status: r.status, audit_writer: r.body && r.body.audit_writer,
      event_loop: r.body && r.body.event_loop ? { latest: r.body.event_loop.latest, last_stall: r.body.event_loop.last_stall, freshness_ms: r.body.event_loop.freshness_ms } : null }
      : { timed_out_ms: 2000 };
  } catch (e) { meta = { error: (e && e.message ? e.message : String(e)).slice(0, 200) }; } finally { clearTimeout(timer); }
  return { waited_ms: Date.now() - t0, file_at_start: rel(atStart), file_at_catch: rel(atCatch),
    same_file: !atStart.error && !atCatch.error && atStart.ino === atCatch.ino && atStart.birthtime_ms === atCatch.birthtime_ms,
    rotated_1_present: fs.existsSync(`${logPath}.1`), final_reread: reread,
    log_filter: Array.isArray(diagKeys) ? { inject_log: diagKeys, audit_log: 'none' } : 'none', inject_log: tail(stdout, '[INJECT]', true), audit_log: tail(stderr, '[AUDIT]', false), meta };
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

  // fanout logs no [INJECT] line: the diagnostic [INJECT] tail is filtered to these targets so an earlier
  // test's line is never read as this multicast's evidence ([AUDIT] lines carry no sid and stay unfiltered).
  const lines = await waitForAudit((l) => l.kind === 'multicast' && l.to === b, [a, b]);
  const mcLines = lines.filter((l) => l.kind === 'multicast' && (l.to === a || l.to === b));
  assert.equal(mcLines.length >= 2, true);
  const forA = mcLines.find((l) => l.to === a);
  const forB = mcLines.find((l) => l.to === b);
  assert.ok(forA && forB);
  assert.equal(forA.inject_id, forB.inject_id); // one fan-out, grouped by inject_id
});
