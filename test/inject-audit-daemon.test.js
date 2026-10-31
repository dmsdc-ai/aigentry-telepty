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
const { beginAuditCompletion, classify, AuditCompletionError } = require('../test-support/audit-completion');

// #1215 audit44 (root disposition D1): every case that waits for an audit line declares { timeout: 60000 }; its t.signal is
// the ONLY deadline of that wait. The former fixed 4000 ms visibility assumption is replaced by a completion fact (see
// test-support/audit-completion.js). 60000 ms is the already-admitted Windows diagnostic per-file ceiling, not a product
// latency promise. Main-loop stalls stay an open performance investigation; a passing wait does not close them.
const AUDIT_CASE = { timeout: 60000 };

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

let daemon;
let logPath;

before(async () => {
  daemon = await startTestDaemon({ env: { TELEPTY_AUDIT_FLUSH_MS: '10' } });
  logPath = path.join(daemon.homeDir, '.telepty', 'logs', 'injects.jsonl');
});

after(async () => { if (daemon) await daemon.stop(); });

// Wait until the audit writer has completed every line the already-accepted request appended (`audit` was begun BEFORE
// that request), then read the log ONCE and return ALL parsed lines; a completed write with no line matching `predicate`
// fails. Predicate-gated so a test never reads lines from earlier tests as its own.
async function waitForAudit(audit, predicate, diagKeys = null) {
  const t0 = Date.now();
  const atStart = auditFileIdentity();   // #1215 diagnostics baseline only (one stat); never asserted
  try {
    return await audit.settledRows({
      read: () => { const raw = fs.readFileSync(logPath, 'utf8'); return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)); },
      match: predicate,
    });
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

test('P1: inject appends an audit line (schema v1, claimed_from, hash-only)', AUDIT_CASE, async (t) => {
  const sid = createSessionId('aud');
  await daemon.spawnSession(sid);
  const payload = 'audit me please';
  const audit = await beginAuditCompletion(daemon, t.signal);
  const res = await daemon.request(`/api/sessions/${encodeURIComponent(sid)}/inject`, {
    method: 'POST', body: { prompt: payload, from: 'orchestrator' }
  });
  assert.equal(res.status, 200);

  const lines = await waitForAudit(audit, (l) => l.to === sid && l.claimed_from === 'orchestrator');
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

test('P2: valid session token (claim == verified) => verified_sender_sid set, no spoof', AUDIT_CASE, async (t) => {
  // Register the sender AS the orchestrator so claimed == verified and the #45 guard allows it.
  const reg = await daemon.request('/api/sessions/register', { method: 'POST', body: { session_id: 'orchestrator', command: 'x' } });
  assert.equal(reg.status === 200 || reg.status === 201, true);
  const token = reg.body.session_token;
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 16);

  const target = createSessionId('target');
  await daemon.spawnSession(target);
  const audit = await beginAuditCompletion(daemon, t.signal);
  const res = await daemon.request(`/api/sessions/${encodeURIComponent(target)}/inject`, {
    method: 'POST',
    headers: { 'x-telepty-session-token': token },
    body: { prompt: 'verified hello', from: 'orchestrator' }
  });
  assert.equal(res.status, 200);

  const lines = await waitForAudit(audit, (l) => l.to === target && l.claimed_from === 'orchestrator' && l.verified_sender_sid === 'orchestrator');
  const line = lines.find((l) => l.to === target && l.claimed_from === 'orchestrator');
  assert.ok(line, 'expected audit line for verified inject');
  assert.equal(line.verified_sender_sid, 'orchestrator');
  assert.equal(line.spoof_suspected, false);
});

test('P2: spoof — claim orchestrator but token maps to a different sid => spoof_suspected', AUDIT_CASE, async (t) => {
  // The imposter registers (gets a real token for its true sid) yet CLAIMS to be the
  // orchestrator. claimed='orchestrator' passes the #45 guard; the token reveals the truth.
  const imposterSid = createSessionId('imposter');
  const reg = await daemon.request('/api/sessions/register', { method: 'POST', body: { session_id: imposterSid, command: 'x' } });
  const token = reg.body.session_token;

  const target = createSessionId('victim');
  await daemon.spawnSession(target);
  const audit = await beginAuditCompletion(daemon, t.signal);
  const res = await daemon.request(`/api/sessions/${encodeURIComponent(target)}/inject`, {
    method: 'POST',
    headers: { 'x-telepty-session-token': token },
    body: { prompt: 'i am totally the orchestrator', from: 'orchestrator' }
  });
  assert.equal(res.status, 200);

  const lines = await waitForAudit(audit, (l) => l.to === target && l.claimed_from === 'orchestrator');
  const line = lines.find((l) => l.to === target && l.claimed_from === 'orchestrator');
  assert.ok(line, 'expected audit line for spoofed inject');
  assert.equal(line.verified_sender_sid, imposterSid); // daemon-verified true identity
  assert.equal(line.spoof_suspected, true);            // claimed != verified
});

test('P2: absent token => verified_sender_sid null (operator/unverified, no spoof flag)', AUDIT_CASE, async (t) => {
  const target = createSessionId('notok');
  await daemon.spawnSession(target);
  const audit = await beginAuditCompletion(daemon, t.signal);
  const res = await daemon.request(`/api/sessions/${encodeURIComponent(target)}/inject`, {
    method: 'POST', body: { prompt: 'no token here', from: 'orchestrator' }
  });
  assert.equal(res.status, 200);
  const lines = await waitForAudit(audit, (l) => l.to === target && l.claimed_from === 'orchestrator');
  const line = lines.find((l) => l.to === target && l.claimed_from === 'orchestrator');
  assert.ok(line);
  assert.equal(line.verified_sender_sid, null);
  assert.equal(line.spoof_suspected, false); // null verified is never a spoof
});

test('P3: GET /api/injects returns lines filtered by to + from with pagination shape', AUDIT_CASE, async (t) => {
  const target = createSessionId('queryme');
  await daemon.spawnSession(target);
  const audit = await beginAuditCompletion(daemon, t.signal);
  await daemon.request(`/api/sessions/${encodeURIComponent(target)}/inject`, {
    method: 'POST', body: { prompt: 'p3 query body', from: 'orchestrator' }
  });
  await waitForAudit(audit, (l) => l.to === target); // ensure flushed (completion observed, then the line is present)

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

test('P1: multicast appends one audit line per target sharing an inject_id', AUDIT_CASE, async (t) => {
  const a = createSessionId('mc-a');
  const b = createSessionId('mc-b');
  await daemon.spawnSession(a);
  await daemon.spawnSession(b);
  const audit = await beginAuditCompletion(daemon, t.signal);
  const res = await daemon.request('/api/sessions/multicast/inject', {
    method: 'POST', body: { session_ids: [a, b], prompt: 'fan out', from: 'orchestrator' }
  });
  assert.equal(res.status, 200);

  // fanout logs no [INJECT] line: the diagnostic [INJECT] tail is filtered to these targets so an earlier
  // test's line is never read as this multicast's evidence ([AUDIT] lines carry no sid and stay unfiltered).
  const lines = await waitForAudit(audit, (l) => l.kind === 'multicast' && l.to === b, [a, b]);
  const mcLines = lines.filter((l) => l.kind === 'multicast' && (l.to === a || l.to === b));
  assert.equal(mcLines.length >= 2, true);
  const forA = mcLines.find((l) => l.to === a);
  const forB = mcLines.find((l) => l.to === b);
  assert.ok(forA && forB);
  assert.equal(forA.inject_id, forB.inject_id); // one fan-out, grouped by inject_id
});

// --- #1215 audit44 — deterministic regressions of the ACTUAL helper (classification + cancellation loop) -----------------
// Scripted observation sequences stand in for /api/meta `audit_writer`, and `sleep` is controlled, so no real time passes (the
// default abort-aware pause is exercised once, with an immediate abort). They prove the completion logic only; they do not
// attribute native main-loop stalls, which stay an open performance investigation.
const W = (appended, written_lines, extra = {}) => ({ appended, written_lines, errors: 0, dropped: 0, closed: false, ...extra });
function scripted(sequence) {
  const calls = { observe: 0, sleep: 0 };
  return {
    calls,
    observe: async () => { const value = sequence[Math.min(calls.observe, sequence.length - 1)]; calls.observe += 1; return value; },
    sleep: async () => { calls.sleep += 1; },
  };
}

test('#1215 audit44 helper: pending -> complete is decided by the writer watermark; a fixed 4000 ms visibility cut-off would have failed this accepted write', AUDIT_CASE, async () => {
  // Virtual timeline per observation (before, after-response, ...), modelled on the measured win32 batch (last_write_ms 23461).
  const virtualMs = [0, 0, 4000, 23461];
  const s = scripted([W(3, 3), W(5, 3, { writing_stage: 'prune' }), W(5, 3, { writing_stage: 'append' }), W(6, 5)]);
  const audit = await beginAuditCompletion(null, new AbortController().signal, { observe: s.observe, sleep: s.sleep });
  const done = await audit.settled();
  assert.deepEqual({ observations: done.observations, watermark: done.watermark, observeCalls: s.calls.observe, sleeps: s.calls.sleep },
    { observations: 3, watermark: 5, observeCalls: 4, sleeps: 2 }, 'first observation sets the watermark; no pause before it');
  assert.equal(virtualMs[s.calls.observe - 1] > 4000, true, 'completion arrived after the former 4000 ms assumption');
  assert.equal(classify({ errors: 0, dropped: 0 }, 5, W(6, 4)).state, 'pending');
  assert.equal(classify({ errors: 0, dropped: 0 }, 5, W(9, 5)).state, 'complete', 'later appends by other callers do not move this watermark');
});

test('#1215 audit44 helper: a completed write is read exactly once; a missing row FAILS (never polled again, never accepted)', AUDIT_CASE, async () => {
  const s = scripted([W(1, 1), W(2, 2)]);
  const audit = await beginAuditCompletion(null, new AbortController().signal, { observe: s.observe, sleep: s.sleep });
  let reads = 0;
  await assert.rejects(audit.settledRows({ read: () => { reads += 1; return [{ to: 'someone-else' }]; }, match: (r) => r.to === 'mine' }),
    (error) => error instanceof AuditCompletionError && error.reason === 'completed_row_missing' && error.detail.rows === 1);
  assert.deepEqual({ reads, observeCalls: s.calls.observe }, { reads: 1, observeCalls: 2 });
  const ok = scripted([W(1, 1), W(2, 2)]);
  const present = await beginAuditCompletion(null, new AbortController().signal, { observe: ok.observe, sleep: ok.sleep });
  assert.deepEqual(await present.settledRows({ read: () => [{ to: 'mine' }], match: (r) => r.to === 'mine' }), [{ to: 'mine' }]);
});

test('#1215 audit44 helper: writer error, drop or closed FAILS even when written_lines has reached the watermark', AUDIT_CASE, async () => {
  for (const [observed, reason] of [[W(2, 2, { errors: 1 }), 'writer_error'], [W(2, 2, { dropped: 1 }), 'writer_dropped'],
    [W(2, 1, { closed: true }), 'writer_closed'], [{ appended: 2 }, 'meta_invalid']]) {
    const s = scripted([W(1, 1), observed]);
    const audit = await beginAuditCompletion(null, new AbortController().signal, { observe: s.observe, sleep: s.sleep });
    await assert.rejects(audit.settled(), (error) => error instanceof AuditCompletionError && error.reason === reason, reason);
  }
  const closed = scripted([W(1, 1, { closed: true })]);
  await assert.rejects(beginAuditCompletion(null, new AbortController().signal, { observe: closed.observe, sleep: closed.sleep }),
    (error) => error.reason === 'writer_closed' && error.detail.phase === 'before');
});

test('#1215 audit44 helper: an abort before the baseline, before settling, during a pause or during an observation stops the wait at once', AUDIT_CASE, async () => {
  const early = new AbortController(); early.abort();
  const none = scripted([W(1, 1)]);
  await assert.rejects(beginAuditCompletion(null, early.signal, { observe: none.observe, sleep: none.sleep }), (error) => error.reason === 'aborted');
  assert.equal(none.calls.observe, 0, 'no meta request after an abort');

  const later = new AbortController(), s = scripted([W(1, 1), W(2, 1)]);
  const audit = await beginAuditCompletion(null, later.signal, { observe: s.observe, sleep: s.sleep });
  later.abort();
  await assert.rejects(audit.settled(), (error) => error.reason === 'aborted' && error.detail.observations === 0);
  assert.equal(s.calls.observe, 1, 'only the baseline was observed');

  const pausing = new AbortController(); let observed = 0;
  const pauseAbort = (ms, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    pausing.abort(); // the case deadline fires while the helper pauses between observations
  });
  const paused = await beginAuditCompletion(null, pausing.signal, { observe: async () => { observed += 1; return observed === 1 ? W(1, 1) : W(2, 1); }, sleep: pauseAbort });
  await assert.rejects(paused.settled(), (error) => error.reason === 'aborted' && error.detail.observations === 1);
  assert.equal(observed, 2, 'no observation after the abort');

  const inflight = new AbortController(); let calls = 0;
  const hanging = (signal) => { calls += 1; if (calls === 1) return Promise.resolve(W(1, 1));
    return new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }); setImmediate(() => inflight.abort()); }); };
  const pending = await beginAuditCompletion(null, inflight.signal, { observe: hanging });
  await assert.rejects(pending.settled(), (error) => error.reason === 'aborted' && error.detail.observations === 0);

  const realPause = new AbortController(), r = scripted([W(1, 1), W(2, 1)]);
  const timed = await beginAuditCompletion(null, realPause.signal, { observe: r.observe, pollMs: 60000 }); // default abort-aware pause
  setImmediate(() => realPause.abort());
  await assert.rejects(timed.settled(), (error) => error.reason === 'aborted' && error.detail.observations === 1);
});
