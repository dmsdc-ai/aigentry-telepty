'use strict';

// Snyk Code findings on PR #108 (task #2026101201). Each test sends the crafted input that reaches
// the flagged sink through the real daemon, so it is RED against db2f532 and GREEN after the fix.
//
//   ace25647  session_id was interpolated into PS1, which bash expands on every prompt: a
//             `$(...)` in the id ran as a command in the spawned shell.
//   4ce269b3  the caller's `command` was the console.log FORMAT string, so `%s`/`%o` in it
//             consumed the following arguments and rewrote the log line.
//   d07e1fda / 39d3b3ec  spawn fields were used without type checks (`type.toUpperCase()`,
//             `command.includes()`), so a non-string reached the PTY or threw a 500.
//   c28e5ccb / 824c56bc / f29f900e / 655151ed  `__proto__` as a route id resolved to
//             Object.prototype through the plain-object session/handoff/thread maps, and the
//             handlers then WROTE to it (session.id, handoff.result/updated_at, thread.*).
//   e933068f  participant_session_ids was stored and counted without checking it is an array.
//   9ca81d65  Express advertised itself in X-Powered-By.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startTestDaemon, createSessionId, delay } = require('../test-support/daemon-harness');

let daemon;
before(async () => { daemon = await startTestDaemon(); });
after(async () => { if (daemon) await daemon.stop(); });

test('9ca81d65: responses do not carry X-Powered-By', async () => {
  const res = await daemon.request('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('ace25647: a session_id carrying shell syntax is refused before it can reach the prompt', async (t) => {
  if (process.platform === 'win32') return t.skip('PS1/PROMPT are only set on POSIX');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snyk-ace25647-'));
  const marker = path.join(dir, 'ran');
  try {
    const sid = `x$(touch ${marker})`;
    const res = await daemon.spawnSession(sid);
    // Give an (unfixed) interactive bash time to print its prompt, which is when PS1 is expanded.
    await delay(1500);
    assert.equal(fs.existsSync(marker), false, 'the session id was executed as a command');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INVALID_SESSION_ID');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ace25647: an ordinary session id still spawns', async () => {
  const sid = createSessionId('snyk-ok');
  const res = await daemon.spawnSession(sid);
  assert.equal(res.status, 201);
  await daemon.request(`/api/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' });
});

test('4ce269b3: format directives in the command are logged literally', async () => {
  const sid = createSessionId('snyk-fmt');
  const command = 'no-such-command-%s-%o';
  const res = await daemon.spawnSession(sid, { command, args: ['ARGV-SENTINEL'] });
  const { stdout } = daemon.getLogs();
  assert.match(stdout, /\[SPAWN\] Spawning no-such-command-%s-%o with args:/);
  if (res.status === 201) {
    await daemon.request(`/api/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' });
  }
});

test('d07e1fda/39d3b3ec: non-string spawn fields are a 400, never reach the PTY', async () => {
  const cases = [
    { command: ['bash'] },
    { command: { includes: 1 } },
    { type: 7 },
    { args: 'bash -c id' },
    { args: [1, 2] },
    { cwd: ['/'] },
    { session_id: ['a'] }
  ];
  for (const overrides of cases) {
    const sid = createSessionId('snyk-type');
    const res = await daemon.spawnSession(sid, overrides);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(overrides)}, got ${res.status}`);
    assert.equal(res.body.code, 'INVALID_REQUEST');
  }
  const list = await daemon.request('/api/sessions');
  assert.deepEqual(list.body.filter((s) => s.id.startsWith('snyk-type')), []);
});

test('c28e5ccb: PATCH /api/sessions/__proto__ does not resolve to Object.prototype', async () => {
  const res = await daemon.request('/api/sessions/__proto__', { method: 'PATCH', body: { new_id: createSessionId('snyk-proto') } });
  assert.equal(res.status, 404);
});

test('824c56bc/f29f900e: handoff routes do not resolve __proto__', async () => {
  const claim = await daemon.request('/api/handoff/__proto__/claim', { method: 'POST', body: { agent_session_id: 'a' } });
  assert.equal(claim.status, 404);
  const patch = await daemon.request('/api/handoff/__proto__', { method: 'PATCH', body: { result: 'polluted' } });
  assert.equal(patch.status, 404);
  // An unfixed daemon has now copied `result`/`updated_at` onto Object.prototype itself.
  const read = await daemon.request('/api/handoff/__proto__');
  assert.equal(read.status, 404);
});

test('655151ed: PATCH /api/threads/__proto__ does not resolve to Object.prototype', async () => {
  const res = await daemon.request('/api/threads/__proto__', { method: 'PATCH', body: { message_count: 7 } });
  assert.equal(res.status, 404);
});

test('e933068f: participant_session_ids must be an array of strings', async () => {
  for (const participant_session_ids of ['abc', { length: 3 }, [1]]) {
    const res = await daemon.request('/api/threads', { method: 'POST', body: { topic: 't', participant_session_ids } });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(participant_session_ids)}`);
  }
  const ok = await daemon.request('/api/threads', { method: 'POST', body: { topic: 't', participant_session_ids: ['a', 'b'] } });
  assert.equal(ok.status, 201);
  const omitted = await daemon.request('/api/threads', { method: 'POST', body: { topic: 't' } });
  assert.equal(omitted.status, 201);
});
