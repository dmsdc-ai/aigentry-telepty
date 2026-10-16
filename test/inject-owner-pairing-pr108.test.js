'use strict';

// PR #108 Mac static re-review (task #2026101201), executed here as tests.
//
// TP1: a second ?owner=1 claim with the SAME bearer keeps the session object and its epoch, so the
//      #109 identity checks (record + epoch) pass, but ownerWs changes. A queued inject then wrote
//      its text, and a deferred CR wrote '\r', into the replacement owner that never got the text.
// TP2: the inject path ran `await mailboxDelivery.tick()` and scheduled the CR. tick() returns at
//      once while another tick is in flight (here: one stuck on a slow unrelated session), so the
//      CR was written before the text it belongs to.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');

const { startTestDaemon, createSessionId, waitFor } = require('../test-support/daemon-harness');

let harness;
before(async () => { harness = await startTestDaemon(); });
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

function busEvents(bus) {
  const events = [];
  bus.on('message', (raw) => { try { events.push(JSON.parse(raw)); } catch { /* ignore */ } });
  return events;
}

const inject = (sid, prompt) => harness.request(`/api/sessions/${encodeURIComponent(sid)}/inject`, {
  method: 'POST', body: { prompt }
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('TP1: a same-bearer owner takeover inside the submit delay gets no CR; the failure is typed', async (t) => {
  const sid = createSessionId('pr108-takeover-cr');
  const first = await wrappedOwner(sid);
  t.after(() => { try { first.ws.close(); } catch {} });
  const bus = await harness.connectBus();
  t.after(() => { try { bus.close(); } catch {} });
  const events = busEvents(bus);

  const inj = await inject(sid, 'hello');
  assert.equal(inj.status, 200, JSON.stringify(inj.body));
  const second = await ownerSocket(sid); // same bearer: same record, same epoch
  t.after(() => { try { second.ws.close(); } catch {} });
  await sleep(1200);

  assert.deepEqual(second.frames, [], `the replacement owner received: ${JSON.stringify(second.frames)}`);
  assert.deepEqual(first.frames, ['hello'], JSON.stringify(first.frames));
  const failed = events.find((e) => e.type === 'inject_failed' && e.session_id === sid);
  assert.ok(failed, `no inject_failed event: ${JSON.stringify(events.map((e) => e.type))}`);
  assert.equal((failed.code || (failed.extra && failed.extra.code)), 'SESSION_GONE', JSON.stringify(failed));
});

test('TP1: an inject queued behind the barrier across a same-bearer takeover answers SESSION_GONE and writes nothing', async (t) => {
  const sid = createSessionId('pr108-takeover-q');
  const first = await wrappedOwner(sid);
  t.after(() => { try { first.ws.close(); } catch {} });

  const holder = await inject(sid, 'first holds the barrier');
  assert.equal(holder.status, 200, JSON.stringify(holder.body));
  const queued = inject(sid, 'second queued behind it');
  await sleep(100);
  const second = await ownerSocket(sid);
  t.after(() => { try { second.ws.close(); } catch {} });

  const res = await queued;
  await sleep(1000);
  assert.deepEqual(second.frames, [], `the replacement owner received: ${JSON.stringify(second.frames)}`);
  assert.equal(res.status, 410, `queued inject answered ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.code, 'SESSION_GONE', JSON.stringify(res.body));
});

test('TP2: with a tick in flight on a slow unrelated session, the text still precedes its CR', async (t) => {
  const slowServer = http.createServer((req, res) => {
    req.resume();
    setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); }, 2000);
  });
  await new Promise((resolve) => slowServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => slowServer.close(resolve)));

  const slow = createSessionId('pr108-slow');
  const reg = await harness.registerSession(slow, {
    delivery_type: 'aterm',
    delivery_endpoint: `http://127.0.0.1:${slowServer.address().port}/deliver`
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));

  const sid = createSessionId('pr108-pair');
  const { ws, frames } = await wrappedOwner(sid);
  t.after(() => { try { ws.close(); } catch {} });

  const slowInject = inject(slow, 'occupies the delivery tick');
  await sleep(150); // the tick is now awaiting the slow endpoint
  const res = await inject(sid, 'hello');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await waitFor(() => frames.length >= 2, { timeoutMs: 6000, description: 'text and CR' });
  await slowInject;

  assert.deepEqual(frames, ['hello', '\r'], `CR overtook its text: ${JSON.stringify(frames)}`);
});

test('TP2: text not delivered within the bound is withdrawn — typed failure, and it never lands later', async (t) => {
  // DELIVERY_TIMEOUT_MS=200 → the pairing wait is 400 ms, while six slow unrelated sessions hold the
  // delivery tick for up to 200 ms each. Our message is still pending when the wait ends.
  const short = await startTestDaemon({ env: { TELEPTY_DELIVERY_TIMEOUT_MS: '200' } });
  t.after(() => short.stop());
  const slowServer = http.createServer((req, res) => { req.resume(); setTimeout(() => res.end('{}'), 1500); });
  await new Promise((resolve) => slowServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => slowServer.close(resolve)));

  const slowIds = [];
  for (let i = 0; i < 6; i++) {
    const slow = createSessionId(`pr108-slow-w${i}`);
    const reg = await short.registerSession(slow, { delivery_type: 'aterm', delivery_endpoint: `http://127.0.0.1:${slowServer.address().port}/d` });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    slowIds.push(slow);
  }
  const sid = createSessionId('pr108-withdraw');
  const reg = await short.registerSession(sid, { command: 'test-wrap' });
  assert.ok([200, 201].includes(reg.status));
  const frames = [];
  const ws = new WebSocket(
    `ws://${short.host}:${short.port}/api/sessions/${encodeURIComponent(sid)}`
    + `?owner=1&owner_pid=${process.pid}&command=test-wrap&token=${encodeURIComponent(short.authToken())}`,
    short.ownerAuth(sid));
  ws.on('message', (raw) => { try { const m = JSON.parse(raw); if (m.type === 'inject') frames.push(m.data); } catch {} });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  t.after(() => { try { ws.close(); } catch {} });

  const slowInjects = slowIds.map((s) => short.request(`/api/sessions/${encodeURIComponent(s)}/inject`, { method: 'POST', body: { prompt: 'x' } }));
  await sleep(100);
  const res = await short.request(`/api/sessions/${encodeURIComponent(sid)}/inject`, { method: 'POST', body: { prompt: 'late' } });
  await Promise.all(slowInjects);
  await sleep(2500); // past the slow tick and a retry backoff

  assert.equal(res.status, 504, JSON.stringify(res.body));
  assert.equal(res.body.code, 'TIMEOUT', JSON.stringify(res.body));
  assert.deepEqual(frames, [], `withdrawn text or a CR still arrived: ${JSON.stringify(frames)}`);
});

// Mac re-review of 9cff4bf, R2: the checks above run at admission and at CR time, but the TEXT is
// written by whichever tick dequeues it, and deliverFn re-resolved sessions[id] and its current
// owner socket. With the tick held by a slow unrelated session, the text sat in the mailbox across
// an owner replacement and was then written to the replacement (whose socket the waiter recorded,
// so the CR followed).
async function slowTickHolder(t, label) {
  const slowServer = http.createServer((req, res) => {
    req.resume();
    setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); }, 2000);
  });
  await new Promise((resolve) => slowServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => slowServer.close(resolve)));
  const slow = createSessionId(label);
  const reg = await harness.registerSession(slow, {
    delivery_type: 'aterm', delivery_endpoint: `http://127.0.0.1:${slowServer.address().port}/deliver`
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  return () => inject(slow, 'occupies the delivery tick');
}

for (const noEnter of [false, true]) {
  test(`R2: text queued behind a slow tick is not written to a same-bearer replacement owner (no_enter=${noEnter})`, async (t) => {
    const hold = await slowTickHolder(t, `pr108-r2-slow-${noEnter}`);
    const sid = createSessionId(`pr108-r2-takeover-${noEnter}`);
    const first = await wrappedOwner(sid);
    t.after(() => { try { first.ws.close(); } catch {} });

    const slowInject = hold();
    await sleep(150); // the tick is now awaiting the slow endpoint
    const pending = harness.request(`/api/sessions/${encodeURIComponent(sid)}/inject`, {
      method: 'POST', body: { prompt: 'queued text', no_enter: noEnter }
    });
    await sleep(150); // admitted for `first` and enqueued; not yet dequeued
    const second = await ownerSocket(sid); // same bearer: same record, same epoch, new socket
    t.after(() => { try { second.ws.close(); } catch {} });
    const res = await pending;
    await slowInject;
    await sleep(4000); // past the held tick and the retry backoffs

    assert.deepEqual(second.frames, [], `the replacement owner received: ${JSON.stringify(second.frames)}`);
    assert.deepEqual(first.frames, [], `the displaced owner received: ${JSON.stringify(first.frames)}`);
    if (!noEnter) {
      assert.equal(res.status, 410, `inject answered ${res.status}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, 'SESSION_GONE', JSON.stringify(res.body));
    }
  });
}

test('R2: text queued behind a slow tick is not written to a same-name re-created session', async (t) => {
  const hold = await slowTickHolder(t, 'pr108-r2-slow-recreate');
  const sid = createSessionId('pr108-r2-recreate');
  const first = await wrappedOwner(sid);
  t.after(() => { try { first.ws.close(); } catch {} });

  const slowInject = hold();
  await sleep(150);
  const pending = inject(sid, 'queued text');
  await sleep(150);
  assert.equal((await harness.request(`/api/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' })).status, 200);
  const replacement = await wrappedOwner(sid); // same name, new instance
  t.after(() => { try { replacement.ws.close(); } catch {} });
  const res = await pending;
  await slowInject;
  await sleep(4000);

  assert.deepEqual(replacement.frames, [], `the re-created session received: ${JSON.stringify(replacement.frames)}`);
  assert.ok([410, 504].includes(res.status), `inject answered ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(['SESSION_GONE', 'TIMEOUT'].includes(res.body.code), JSON.stringify(res.body));
});

test('DELIVERY_UNCERTAIN closes the tracked record as uncertain (bytes not measured), not as a refusal of 0 bytes', () => {
  const { deliveryAbortCause } = require('../daemon');
  assert.equal(typeof deliveryAbortCause, 'function');
  assert.deepEqual(deliveryAbortCause('DELIVERY_UNCERTAIN'),
    { kind: 'inject_delivery_uncertain', trigger: 'delivery_uncertain', bytesWritten: null });
  for (const code of ['SESSION_GONE', 'TIMEOUT', 'QUEUE_TIMEOUT', undefined]) assert.deepEqual(deliveryAbortCause(code), {});
});

test('FileMailbox.withdraw dead-letters only a pending message', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { FileMailbox } = require('../src/mailbox/index');
  const mb = new FileMailbox({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'pr108-withdraw-')) });
  const base = { from: 'a', to: 's', payload: 'p', created_at: Math.floor(Date.now() / 1000) - 1, attempt: 0 };
  mb.enqueue({ ...base, msg_id: 'm1' });
  mb.enqueue({ ...base, msg_id: 'm2' });
  assert.equal(mb.withdraw('s', 'm1', 'test'), true);
  assert.equal(mb.withdraw('s', 'm1', 'test'), false, 'already withdrawn');
  const next = mb.dequeue('s');
  assert.equal(next && next.msg_id, 'm2', 'a withdrawn message must never be dequeued');
  assert.equal(mb.withdraw('s', 'm2', 'test'), false, 'in flight: a deliverer holds it');
  assert.equal(mb.withdraw('s', 'nope', 'test'), false);
  assert.deepEqual(mb.peekDeadLetter('s').map((e) => [e.msg_id, e.reason]), [['m1', 'test']]);
});
