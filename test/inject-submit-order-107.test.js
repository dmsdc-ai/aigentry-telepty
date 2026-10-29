'use strict';

// #107 — two injects into one wrapped session, back to back, arrive at the PTY as
//   text1 text2 CR CR
// instead of
//   text1 CR text2 CR
// so the target reads ONE glued line ("text1text2") and the second command is never parsed.
//
// Where: deliverInjectionToSession (daemon.js) writes an inject's TEXT through the mailbox at
// once, returns, and sends that inject's submit CR from a 500 ms setTimeout. Nothing stops the
// next inject's text from reaching the owner socket inside that window. The bridge then adds a
// second loss: when both CRs end up parked in its mailbox they are consecutive identical
// payloads, and the #720 flush filter drops the second one as a "duplicate inject".
//
// Measured in telesession RC5 (real daemon + `telepty allow` bridge + restart-credential child),
// byte trace of the child's stdin: "rc5 probe after the restartRCREPLY …\r" — one line, the
// RCREPLY command never ran. Here the owner socket stands in for the bridge, so this pins the
// daemon-side order directly.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

const { startTestDaemon, createSessionId, waitFor } = require('../test-support/daemon-harness');

let harness;
before(async () => { harness = await startTestDaemon(); });
after(async () => { if (harness) await harness.stop(); });

async function wrappedOwner(prefix) {
  const sid = createSessionId(prefix);
  const reg = await harness.registerSession(sid, { command: 'test-wrap' });
  assert.ok([200, 201].includes(reg.status), `register -> ${reg.status}`);
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
  return { sid, ws, frames };
}

const inject = (sid, prompt) => harness.request(`/api/sessions/${encodeURIComponent(sid)}/inject`, {
  method: 'POST', body: { prompt }
});

test('#107: back-to-back injects reach the owner as text1 CR text2 CR — never text1 text2 CR CR', async (t) => {
  const { sid, ws, frames } = await wrappedOwner('i107-order');
  t.after(() => { try { ws.close(); } catch {} });

  const first = await inject(sid, 'first line');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const second = await inject(sid, 'RCREPLY second');
  assert.equal(second.status, 200, JSON.stringify(second.body));

  await waitFor(() => frames.filter((f) => f === '\r').length >= 2,
    { timeoutMs: 5000, description: 'both submit CRs on the owner socket' });

  assert.deepEqual(frames, ['first line', '\r', 'RCREPLY second', '\r'],
    'the second inject\'s text overtook the first inject\'s deferred submit CR');
});

test('#107: three concurrent injects keep each text paired with its own CR, in order', async (t) => {
  const { sid, ws, frames } = await wrappedOwner('i107-concurrent');
  t.after(() => { try { ws.close(); } catch {} });

  const results = await Promise.all(['one', 'two', 'three'].map((p) => inject(sid, p)));
  for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body));

  await waitFor(() => frames.filter((f) => f === '\r').length >= 3,
    { timeoutMs: 6000, description: 'three submit CRs on the owner socket' });

  // Concurrent HTTP requests may be admitted in any order; what must hold is the pairing.
  assert.equal(frames.length, 6, JSON.stringify(frames));
  for (let i = 0; i < 6; i += 2) {
    assert.notEqual(frames[i], '\r', `frame ${i} should be a text: ${JSON.stringify(frames)}`);
    assert.equal(frames[i + 1], '\r', `text ${JSON.stringify(frames[i])} is not followed by its own CR: ${JSON.stringify(frames)}`);
  }
  assert.deepEqual(frames.filter((f) => f !== '\r').sort(), ['one', 'three', 'two']);
});
