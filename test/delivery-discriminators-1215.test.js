'use strict';

// Task 1215 / #879 — discriminators for the Windows delivery failures (windows-runtime21 CAUSES.md D1/D2/D4).
// Real daemon (test-support/daemon-harness), real owner WebSockets, real inject route; nothing is stubbed.
//
//   D1/D2  A negotiated owner (input-transport-ready-v1) whose input_transport_ready never ARRIVES keeps an inject
//          parked daemon-side while the session looks CONNECTED. The discriminator makes a REFUSED milestone frame
//          observable (transport.readiness.refused_frames: count + last {milestone, reason}); with no refusal the
//          view carries no such field. On the current head a refused frame leaves no trace — these assertions fail
//          there and pass on the candidate. The parked inject is still released ONLY by the valid handshake.
//   D4     A QUEUE_TIMEOUT refusal carries the daemon-measured barrier wait (queue_wait_ms). Absent on the head.
//          The refusal is caused by the test owner withholding the first submit's SSH write receipt (real receipt
//          protocol), not by host speed or load; arrival order across accepted callers stays covered by #109(b).
//
// Nothing here relaxes readiness: the refused frames release nothing, and the bound/timeouts are unchanged.
// "PRECONDITION:" assertions validate setup (failure = INVALID, not product RED).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

const { startTestDaemon, createSessionId, waitFor } = require('../test-support/daemon-harness');

const QUEUE_BOUND_MS = 300;
let harness;
const sockets = [];
before(async () => { harness = await startTestDaemon({ env: { TELEPTY_SUBMIT_QUEUE_TIMEOUT_MS: String(QUEUE_BOUND_MS) } }); });
after(async () => {
  for (const ws of sockets) { try { ws.close(); } catch {} }
  if (harness) await harness.stop();
});

// A current bridge's claim: it declares the readiness handshake, exactly as cli.js does.
async function capableClaim(sid) {
  const reg = await harness.registerSession(sid, { command: 'test-wrap' });
  assert.ok([200, 201].includes(reg.status) && reg.body.session_token, `PRECONDITION: register -> ${reg.status}`);
  const frames = [];
  const owner = new WebSocket(`ws://${harness.host}:${harness.port}/api/sessions/${encodeURIComponent(sid)}?owner=1`,
    { headers: { 'x-telepty-session-token': reg.body.session_token, 'x-telepty-token': harness.authToken(),
      'x-telepty-bridge-capabilities': 'input-transport-ready-v1' } });
  sockets.push(owner);
  owner.on('message', (raw) => { try { frames.push(JSON.parse(raw)); } catch {} });
  await new Promise((resolve, reject) => { owner.once('open', resolve); owner.once('error', reject); });
  const token = await waitFor(() => frames.find((f) => f.type === 'owner_token'), { timeoutMs: 5000, description: `${sid} owner_token` });
  assert.equal(typeof token.readiness_nonce, 'string', 'PRECONDITION: the daemon negotiated the readiness handshake');
  return { owner, frames, token };
}
function milestone(sid, owned, type, overrides = {}) {
  const b = owned.token.interaction_binding;
  const frame = { type, schema: 1, session_id: sid, session_epoch: b.session_epoch ?? null, owner_generation: b.owner_generation,
    readiness_nonce: owned.token.readiness_nonce, child_seq: 1,
    ...(type === 'process_started' ? { pid: process.pid, exec: 'unverified' } : { input_loop: 'attached' }), ...overrides };
  owned.owner.send(JSON.stringify(frame));
}
const transportOf = async (sid) => (await harness.request(`/api/sessions/${encodeURIComponent(sid)}`)).body.transport;
const injects = (owned) => owned.frames.filter((f) => f.type === 'inject').map((f) => f.data);

test('D1/D2 discriminator: a refused milestone frame is named (fixed reason), releases nothing, and the valid handshake still releases the parked inject', async () => {
  const sid = createSessionId('d21-refused');
  const owned = await capableClaim(sid);

  const fresh = await transportOf(sid);
  assert.deepEqual({ status: fresh.readiness.input_transport_ready.status, refused: Object.hasOwn(fresh.readiness, 'refused_frames') },
    { status: 'not_observed', refused: false }, 'no frame yet: not_observed and no refusal record');

  const parked = await harness.request(`/api/sessions/${encodeURIComponent(sid)}/inject`, { method: 'POST', body: { prompt: 'd21-parked', no_enter: true } });
  assert.equal(parked.status, 200, `PRECONDITION: inject accepted ${JSON.stringify(parked.body)}`);
  assert.equal(parked.body.strategy, 'bootstrap_queue', 'PRECONDITION: a negotiated owner without the handshake parks the inject');

  milestone(sid, owned, 'input_transport_ready');                                   // before process_started
  milestone(sid, owned, 'process_started', { readiness_nonce: 'x'.repeat(22) });    // wrong nonce
  const refused = await waitFor(async () => {
    const t = await transportOf(sid);
    return t.readiness.refused_frames && t.readiness.refused_frames.count === 2 ? t : null;
  }, { timeoutMs: 5000, description: 'two refused milestone frames recorded' });
  assert.deepEqual({ last: { milestone: refused.readiness.refused_frames.last.milestone, reason: refused.readiness.refused_frames.last.reason },
    status: refused.readiness.input_transport_ready.status, queued: refused.bootstrap.queued, delivered: injects(owned) },
  { last: { milestone: 'process_started', reason: 'nonce' }, status: 'not_observed', queued: 1, delivered: [] });

  milestone(sid, owned, 'process_started');
  milestone(sid, owned, 'input_transport_ready');
  await waitFor(() => (injects(owned).includes('d21-parked') ? true : null), { timeoutMs: 5000, description: 'the parked inject released by the valid handshake' });
  const ready = await transportOf(sid);
  assert.deepEqual({ status: ready.readiness.input_transport_ready.status, refusedCount: ready.readiness.refused_frames.count, queued: ready.bootstrap.queued },
    { status: 'observed', refusedCount: 2, queued: 0 });
});

// D4 — the barrier is held CAUSALLY by the test owner, not by host speed. An SSH-remote wrapped session delivers
// through the real receipt protocol (src/ssh-session.js requestSshWrite → `ssh_inject` frame → the owner's
// `ssh_write_receipt`), and the inject route holds the #107/#109 submit barrier across that write
// (src/mailbox/session-delivery.js). So: q1's `ssh_inject` arriving at the owner proves q1 HOLDS the barrier; the
// owner withholds q1's receipt; q2 is then issued and can only be answered by the barrier bound. Its refusal must
// be QUEUE_TIMEOUT with the measured wait, and nothing of q2 may be written. Only after q2's answer does the owner
// release q1, whose text and CR then arrive as one pair. No response, timestamp or state is fabricated: every
// frame is the daemon's own, and every wait is bounded. The only residual bound is product-owned: q1's receipt
// wait (3000 ms, requestSshWrite) must outlast q2's pre-barrier work plus the 300 ms bound. If it does not, q1
// reports SSH_WRITE_UNCONFIRMED, and that is asserted as an explicit PRECONDITION failure, never treated as a pass.
const SSH_REMOTE = { target: 'd23-fixture.invalid', port: 22, agent: null, remote_cwd: null, uri: 'ssh://d23-fixture.invalid',
  persistent: false, resume_requested: false, identity: 'operator_declared', version_status: 'unsupported', remote_shell: 'posix' };
function within(promise, ms, description) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), ms); })])
    .finally(() => clearTimeout(timer));
}

test('D4 discriminator: while the owner withholds the first submit\'s write receipt, a second submit is refused QUEUE_TIMEOUT with its measured barrier wait and is never written; the first keeps its text+CR pair', async () => {
  const sid = createSessionId('d23-queue');
  const reg = await harness.registerSession(sid, { command: 'ssh', ssh_remote: SSH_REMOTE });
  assert.ok([200, 201].includes(reg.status), `PRECONDITION: ssh register -> ${reg.status} ${JSON.stringify(reg.body)}`);
  const writes = [];          // every ssh_inject the daemon sent this owner, in arrival order
  let held = null;            // q1's text write, receipt withheld
  const owner = new WebSocket(`ws://${harness.host}:${harness.port}/api/sessions/${encodeURIComponent(sid)}`
    + `?owner=1&owner_pid=${process.pid}&command=ssh&token=${encodeURIComponent(harness.authToken())}`, harness.ownerAuth(sid));
  sockets.push(owner);
  const send = (frame) => owner.send(JSON.stringify(frame));
  const sshState = (phase) => send({ type: 'ssh_state', generation: 1, phase, reason: 'd23_fixture_owner' });
  const receipt = (w) => send({ type: 'ssh_write_receipt', request_id: w.request_id, generation: w.generation, stage: 'written' });
  owner.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type !== 'ssh_inject') return;
    writes.push({ request_id: m.request_id, generation: m.generation, data: m.data });
    if (m.data === '\r') { receipt(m); sshState('ready'); return; }   // a submit is acknowledged at once
    if (m.data === 'q1' && !held) held = m;                            // q1's text: receipt withheld
  });
  await new Promise((resolve, reject) => { owner.once('open', resolve); owner.once('error', reject); });
  const inject = (prompt) => harness.request(`/api/sessions/${encodeURIComponent(sid)}/inject`, { method: 'POST', body: { prompt } });

  try {
    sshState('ready');
    await waitFor(async () => {
      const s = (await harness.request(`/api/sessions/${encodeURIComponent(sid)}`)).body;
      return s && s.ssh && s.ssh.phase === 'ready' && s.ssh.generation === 1 ? true : null;
    }, { timeoutMs: 5000, description: 'PRECONDITION: the daemon applied the owner\'s ssh_state ready' });

    const q1 = inject('q1');
    q1.catch(() => {});   // observed below; only keeps an early assertion failure from also being an unhandled rejection
    await waitFor(() => (held ? true : null), { timeoutMs: 5000, description: 'PRECONDITION: q1 holds the barrier (its ssh_inject reached the owner)' });

    const q2Issued = Date.now();
    const q2 = await within(inject('q2'), QUEUE_BOUND_MS + 2500, 'q2 answered by the barrier bound while q1 is held');
    const q2Elapsed = Date.now() - q2Issued;
    const writesAtRefusal = writes.map((w) => w.data);
    // The barrier timer (libuv loop clock) and Date.now() may differ by about 1 ms, hence the 2 ms granularity allowance.
    assert.deepEqual({ status: q2.status, code: q2.body.code, measured: Number.isSafeInteger(q2.body.queue_wait_ms),
      atLeastBound: q2.body.queue_wait_ms >= QUEUE_BOUND_MS - 2, withinRequest: q2.body.queue_wait_ms <= q2Elapsed + 2, writesAtRefusal },
    { status: 503, code: 'QUEUE_TIMEOUT', measured: true, atLeastBound: true, withinRequest: true, writesAtRefusal: ['q1'] }, JSON.stringify(q2.body));

    receipt(held);
    sshState('awaiting_submit');          // what a real bridge reports after the body is written; the CR needs it
    const q1Res = await within(q1, 5000, 'q1 answered after its receipt was released');
    assert.notEqual(q1Res.body && q1Res.body.code, 'SSH_WRITE_UNCONFIRMED',
      'PRECONDITION: q1\'s receipt wait (3000 ms) expired before q2 was refused, so the hold was not causal on this host');
    assert.deepEqual({ status: q1Res.status, strategy: q1Res.body.strategy, submit: q1Res.body.submit, writes: writes.map((w) => w.data) },
      { status: 200, strategy: 'ssh_bridge', submit: 'written', writes: ['q1', '\r'] }, JSON.stringify(q1Res.body));
  } finally {
    if (held && owner.readyState === 1) { try { receipt(held); } catch {} }   // never leave the daemon waiting on this owner
  }
});
