'use strict';

// #109 — follow-up to the #107 submit barrier in deliverInjectionToSession (daemon.js).
//
// (a) The barrier waits on the session OBJECT captured at route entry, then enqueues by ID and
//     writes the deferred CR to the captured object. Nothing re-checks that the id still names
//     that object once the wait is over. A session destroyed (or destroyed and recreated under
//     the same id) while an inject is queued behind the barrier gets: a 200 for text that went
//     to no live session, or the queued text routed into the REPLACEMENT session with no CR.
// (b) The wait is unbounded: K queued injects make the (K+1)th caller wait ≈ K × submitDelay
//     with no typed answer, so a burst caller hits its own client timeout while the text is
//     still delivered later.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

const { startTestDaemon, createSessionId, waitFor } = require('../test-support/daemon-harness');

const QUEUE_BOUND_MS = 1200;

let harness;
before(async () => {
  harness = await startTestDaemon({ env: { TELEPTY_SUBMIT_QUEUE_TIMEOUT_MS: String(QUEUE_BOUND_MS) } });
});
after(async () => { if (harness) await harness.stop(); });

async function ownerSocket(sid) {
  const frames = [];
  const ws = new WebSocket(
    `ws://${harness.host}:${harness.port}/api/sessions/${encodeURIComponent(sid)}`
    + `?owner=1&owner_pid=${process.pid}&command=test-wrap&token=${encodeURIComponent(harness.authToken())}`,
    harness.ownerAuth(sid));
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'inject') frames.push(msg.data);
    } catch { /* not a frame we record */ }
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return { ws, frames };
}

async function wrappedOwner(sid) {
  const reg = await harness.registerSession(sid, { command: 'test-wrap' });
  assert.ok([200, 201].includes(reg.status), `register -> ${reg.status}`);
  return ownerSocket(sid);
}

const inject = (sid, prompt) => harness.request(`/api/sessions/${encodeURIComponent(sid)}/inject`, {
  method: 'POST', body: { prompt }
});
const destroy = (sid) => harness.request(`/api/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Measured on 5b3619e: B answered 200 (`strategy: mailbox`) for a session deleted while B waited.
test('#109(a): an inject queued behind the barrier when its session is destroyed answers SESSION_GONE, not 200', async (t) => {
  const sid = createSessionId('i109-gone');
  const { ws } = await wrappedOwner(sid);
  t.after(() => { try { ws.close(); } catch {} });

  const first = await inject(sid, 'first holds the barrier');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const queued = inject(sid, 'second queued behind it');
  await sleep(100);
  const del = await destroy(sid);
  assert.ok(del.status < 300, `delete -> ${del.status}`);

  const second = await queued;
  assert.equal(second.status, 410, `queued inject answered ${second.status}: ${JSON.stringify(second.body)}`);
  assert.equal(second.body.code, 'SESSION_GONE', JSON.stringify(second.body));
});

// Measured on 5b3619e: the replacement received ['second queued behind it'] — the old
// instance's queued text, with no CR, in a session that never asked for it.
test('#109(a): an inject queued across destroy+recreate under the same id never reaches the replacement', async (t) => {
  const sid = createSessionId('i109-recreate');
  const old = await wrappedOwner(sid);
  t.after(() => { try { old.ws.close(); } catch {} });

  const first = await inject(sid, 'first holds the barrier');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const queued = inject(sid, 'second queued behind it');
  await sleep(100);
  const del = await destroy(sid);
  assert.ok(del.status < 300, `delete -> ${del.status}`);
  const replacement = await wrappedOwner(sid);
  t.after(() => { try { replacement.ws.close(); } catch {} });

  const second = await queued;
  await sleep(1000); // past every submit delay that could still fire

  assert.deepEqual(replacement.frames, [],
    `the replacement session received bytes meant for its predecessor: ${JSON.stringify(replacement.frames)}`);
  assert.equal(second.status, 410, `queued inject answered ${second.status}: ${JSON.stringify(second.body)}`);
  assert.equal(second.body.code, 'SESSION_GONE', JSON.stringify(second.body));
});

// Measured on 5b3619e: with 6 concurrent injects the slowest caller waited ≈ 2.5 s
// (5 × 500 ms submit delay) — far past the configured bound — and every one answered 200.
test('#109(b): the barrier wait is bounded — late callers get QUEUE_TIMEOUT, and only 200s are delivered', async (t) => {
  const sid = createSessionId('i109-bound');
  const { ws, frames } = await wrappedOwner(sid);
  t.after(() => { try { ws.close(); } catch {} });

  const prompts = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'];
  const timed = await Promise.all(prompts.map(async (p) => {
    const started = Date.now();
    const res = await inject(sid, p);
    return { p, res, elapsed: Date.now() - started };
  }));
  const slowest = Math.max(...timed.map((r) => r.elapsed));
  const delivered = timed.filter((r) => r.res.status === 200).map((r) => r.p);
  const refused = timed.filter((r) => r.res.status !== 200);

  // Let every deferred CR that is still owed land before reading the owner socket.
  await waitFor(() => frames.filter((f) => f === '\r').length >= delivered.length,
    { timeoutMs: 5000, description: 'a CR for every accepted inject' });
  await sleep(700);

  assert.ok(slowest < QUEUE_BOUND_MS + 800,
    `slowest caller waited ${slowest} ms with a ${QUEUE_BOUND_MS} ms bound: ${JSON.stringify(timed.map((r) => [r.p, r.res.status, r.elapsed]))}`);
  assert.ok(refused.length > 0, 'six back-to-back injects all fit inside the bound — the test proves nothing');
  for (const r of refused) {
    assert.equal(r.res.status, 503, JSON.stringify(r.res.body));
    assert.equal(r.res.body.code, 'QUEUE_TIMEOUT', JSON.stringify(r.res.body));
  }
  // Never silent: every accepted text arrived with its own CR, and no refused text arrived at all.
  assert.deepEqual(frames.filter((f) => f !== '\r').sort(), [...delivered].sort(), JSON.stringify(frames));
  for (let i = 0; i < frames.length; i += 2) assert.equal(frames[i + 1], '\r', JSON.stringify(frames));
});

// N5: accepted callers are served in arrival order. Staggered starts make arrival order known;
// three injects fit inside the bound (2 × 500 ms wrapped submit delay < QUEUE_BOUND_MS).
test('#109(b): queued callers are delivered in arrival order, each text followed by its own CR', async (t) => {
  const sid = createSessionId('i109-fifo');
  const { ws, frames } = await wrappedOwner(sid);
  t.after(() => { try { ws.close(); } catch {} });

  // #879 diagnostics only: per-caller timing and owner-frame arrival times. Frame labels are restricted to the exact
  // test-owned prompts f1/f2/f3 and CR; anything else is recorded as 'other' with its numeric length only (never its body).
  // The recorded list is bounded; frames beyond the cap are counted in frames_omitted.
  const t0 = Date.now(), callers = [], frameTimes = [], FRAME_CAP = 16, OWNED = new Set(['f1', 'f2', 'f3']);
  let framesOmitted = 0;
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type !== 'inject') return;
      if (frameTimes.length >= FRAME_CAP) { framesOmitted++; return; }
      const label = msg.data === '\r' ? 'CR' : (typeof msg.data === 'string' && OWNED.has(msg.data) ? msg.data : 'other');
      frameTimes.push(label === 'other'
        ? { at_ms: Date.now() - t0, label, utf16_length: typeof msg.data === 'string' ? msg.data.length : null }
        : { at_ms: Date.now() - t0, label });
    } catch { /* not a frame */ }
  });
  const diagnose = (stage) => t.diagnostic(`#879 diag ${stage} ${JSON.stringify({ queue_bound_ms: QUEUE_BOUND_MS, callers, frames: frameTimes, frames_omitted: framesOmitted })}`);
  const pending = [];
  for (const p of ['f1', 'f2', 'f3']) {
    const issued = Date.now() - t0;
    pending.push(inject(sid, p).then((r) => {
      callers.push({ p, issued_ms: issued, answered_ms: Date.now() - t0, status: r.status, code: (r.body && r.body.code) || null });
      return r;
    }));
    await sleep(30);
  }
  const results = await Promise.all(pending);
  if (results.some((r) => r.status !== 200)) diagnose('fifo_results');
  for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body));
  await waitFor(() => frames.length >= 6, { timeoutMs: 3000, description: 'three texts and three CRs' })
    .catch((error) => { diagnose('fifo_frames'); throw error; });

  assert.deepEqual(frames, ['f1', '\r', 'f2', '\r', 'f3', '\r'], JSON.stringify(frames));
});

// Review 1 B1, measured on aeb436b: a rename inside the submit delay left the owner with
// ['hello'] and no CR (inject_failed SESSION_GONE). A rename moves the SAME live instance —
// it received the text, so it must receive the CR.
test('#109: a rename inside the submit delay still delivers the CR to the same live instance', async (t) => {
  const sid = createSessionId('i109-rename');
  const newId = `${sid}-renamed`;
  const { ws, frames } = await wrappedOwner(sid);
  t.after(() => { try { ws.close(); } catch {} });

  const inj = await inject(sid, 'hello');
  assert.equal(inj.status, 200, JSON.stringify(inj.body));
  const ren = await harness.request(`/api/sessions/${encodeURIComponent(sid)}`, { method: 'PATCH', body: { new_id: newId } });
  assert.equal(ren.status, 200, JSON.stringify(ren.body));
  await sleep(1200);

  assert.deepEqual(frames, ['hello', '\r'], JSON.stringify(frames));
});

// Guard for the CR timer recheck: destroy (and recreate under the same id) inside the submit
// delay must not put a bare CR into the replacement, which never received this inject's text.
test('#109: a destroy+recreate inside the submit delay writes no CR to the replacement', async (t) => {
  const sid = createSessionId('i109-destroy-cr');
  const old = await wrappedOwner(sid);
  t.after(() => { try { old.ws.close(); } catch {} });

  const inj = await inject(sid, 'hello');
  assert.equal(inj.status, 200, JSON.stringify(inj.body));
  const del = await destroy(sid);
  assert.ok(del.status < 300, `delete -> ${del.status}`);
  const replacement = await wrappedOwner(sid);
  t.after(() => { try { replacement.ws.close(); } catch {} });
  await sleep(1200);

  assert.deepEqual(old.frames, ['hello'], JSON.stringify(old.frames));
  assert.deepEqual(replacement.frames, [], JSON.stringify(replacement.frames));
});
