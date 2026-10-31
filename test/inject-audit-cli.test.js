'use strict';

// #43 P2/P3 — CLI surface (integration via the daemon harness).
//  P2: `telepty inject` carries x-telepty-session-token from TELEPTY_SESSION_TOKEN, so the
//      daemon resolves verified_sender_sid for the audit line.
//  P3: `telepty injects [--to --from --since --json]` reads GET /api/injects.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestDaemon, createSessionId } = require('../test-support/daemon-harness');
const { beginAuditCompletion } = require('../test-support/audit-completion');

// #1215 audit44 (root disposition D1): each case that waits for an audit line declares { timeout: 60000 } and its t.signal is
// the ONLY deadline of that wait; the former fixed 5000 ms visibility assumption is replaced by a completion fact
// (test-support/audit-completion.js). Not a product latency promise; main-loop stalls stay an open performance investigation.
const AUDIT_CASE = { timeout: 60000 };

let daemon;
let logPath;

before(async () => {
  daemon = await startTestDaemon({ env: { TELEPTY_AUDIT_FLUSH_MS: '10' } });
  logPath = path.join(daemon.homeDir, '.telepty', 'logs', 'injects.jsonl');
});
after(async () => { if (daemon) await daemon.stop(); });

// Completion of every line the already-accepted request appended (`audit` begun BEFORE it), then ONE read of the log;
// a completed write without a line matching `predicate` fails. Failures carry the helper's bounded counter diagnostics.
async function waitForAudit(audit, predicate) {
  return audit.settledRows({
    read: () => fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    match: predicate,
  });
}

test('P2: `telepty inject` carries TELEPTY_SESSION_TOKEN => verified_sender_sid set', AUDIT_CASE, async (t) => {
  const reg = await daemon.request('/api/sessions/register', { method: 'POST', body: { session_id: 'orchestrator', command: 'x' } });
  const token = reg.body.session_token;
  assert.ok(token);

  const target = createSessionId('cli-target');
  await daemon.spawnSession(target);

  const audit = await beginAuditCompletion(daemon, t.signal);
  const out = await daemon.runCli(['inject', '--from', 'orchestrator', target, 'cli verified body'], {
    env: { TELEPTY_SESSION_ID: 'orchestrator', TELEPTY_SESSION_TOKEN: token }
  });
  assert.equal(out.code, 0, `inject failed: ${out.stderr}`);

  const lines = await waitForAudit(audit, (l) => l.to === target && l.claimed_from === 'orchestrator');
  const line = lines.find((l) => l.to === target && l.claimed_from === 'orchestrator');
  assert.ok(line);
  assert.equal(line.verified_sender_sid, 'orchestrator');
  assert.equal(line.spoof_suspected, false);
});

test('P3: `telepty injects --to <sid> --json` lists the audit lines', AUDIT_CASE, async (t) => {
  const target = createSessionId('cli-query');
  await daemon.spawnSession(target);
  const audit = await beginAuditCompletion(daemon, t.signal);
  await daemon.request(`/api/sessions/${encodeURIComponent(target)}/inject`, {
    method: 'POST', body: { prompt: 'query via cli', from: 'orchestrator' }
  });
  await waitForAudit(audit, (l) => l.to === target);

  const out = await daemon.runCli(['injects', '--to', target, '--json']);
  assert.equal(out.code, 0, `injects failed: ${out.stderr}`);
  const parsed = JSON.parse(out.stdout);
  const arr = Array.isArray(parsed) ? parsed : parsed.injects;
  assert.ok(Array.isArray(arr));
  const hit = arr.find((l) => l.to === target);
  assert.ok(hit, `expected the injected line in CLI output: ${out.stdout}`);
  assert.equal(hit.claimed_from, 'orchestrator');
});

test('P3: `telepty injects` (table form) prints a header and the target row', AUDIT_CASE, async (t) => {
  const target = createSessionId('cli-table');
  await daemon.spawnSession(target);
  const audit = await beginAuditCompletion(daemon, t.signal);
  await daemon.request(`/api/sessions/${encodeURIComponent(target)}/inject`, {
    method: 'POST', body: { prompt: 'table row body', from: 'orchestrator' }
  });
  await waitForAudit(audit, (l) => l.to === target);

  const out = await daemon.runCli(['injects', '--to', target]);
  assert.equal(out.code, 0, `injects failed: ${out.stderr}`);
  assert.match(out.stdout, new RegExp(target));
});
