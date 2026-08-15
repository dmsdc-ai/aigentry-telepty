'use strict';

// telepty#860 F2 — an accepted-then-parked inject was audited `success` with zero bytes written,
// and tracked forever.
//
// `deliverInjectionToSession` has a THIRD outcome that is neither success nor refusal: the op is
// pushed onto the bootstrap / modal-park queue and the route is handed
// `{success: true, strategy: 'bootstrap_queue', queued: true}`. Nothing has been written. Every
// audited inject door then wrote `delivery_result: "success"` — the strongest of the two words
// BOUNDARY.md says "deliberately do not share a word" — and the write-ahead ledger stayed at
// `tracking_state: "tracked"` / `inject_accepted`.
//
// `abortTrackedInjection` had exactly one call site, the synchronous refusal arm, so none of that
// queue's terminal outcomes could ever move the record: `drainBootstrapQueue`'s failure arm,
// `failBootstrapQueueOnTimeout` and `flushModalParkQueue` each emitted a bus event and nothing
// durable — the same push-only gap `src/transport/websocket.js` argues against in this release.
//
// The daemon here binds PORT=0 with a temp HOME. Nothing touches the production daemon.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startTestDaemon, createSessionId } = require('../test-support/daemon-harness');

// Hermetic require, same reason as test/completion-unknown-observation-60.test.js: `require`ing
// the daemon reads $HOME at load and would otherwise restore and supervise the developer's live
// sessions inside this test process.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty860-f2-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.PORT = '0';

const daemonModule = require('../daemon');

let daemon;
before(async () => { daemon = await startTestDaemon(); });
after(async () => { if (daemon) await daemon.stop(); });

// The audit writer batches, so the line is not on disk the instant the route answers.
async function auditLineFor(injectId) {
  return daemon.waitFor(async () => {
    const res = await daemon.request('/api/injects?limit=200');
    return (res.body.injects || []).find((l) => l.inject_id === injectId) || null;
  }, { timeoutMs: 4000, description: `audit line for ${injectId}` });
}

// ── The live door: a bootstrap-gated session parks, and neither the audit log nor the ledger may
//    say a delivery happened. ────────────────────────────────────────────────────────────────

test('#860 F2: a parked inject is audited `queued`, not `success` — zero bytes were written', async () => {
  const sid = createSessionId('f2-gated');
  // `claude` is a known AI CLI, so the session is bootstrap-GATED and not ready: an inject parks.
  // No owner socket is ever opened, which is the reproduced arrangement — scheduleBootstrapPromptPoll
  // returns early without one, so no timer is armed and nothing can move the record later either.
  const reg = await daemon.registerSession(sid, { command: 'claude' });
  assert.equal(reg.status, 201, `register failed: ${JSON.stringify(reg.body)}`);

  const inject = await daemon.request(`/api/sessions/${encodeURIComponent(sid)}/inject`, {
    method: 'POST', body: { prompt: 'REPORT: a task', from: 'orchestrator' },
  });
  assert.equal(inject.status, 200, `inject failed: ${JSON.stringify(inject.body)}`);
  assert.equal(inject.body.strategy, 'bootstrap_queue', 'precondition: this dispatch was parked, not written');
  assert.equal(inject.body.bootstrap_queued, true);

  const line = await auditLineFor(inject.body.inject_id);
  assert.equal(line.delivery_result, 'queued',
    'the audit log claimed a delivery for an operation whose measured byte count is zero');

  // And the ledger — the thing bin/dispatch-tracker.sh polls — states the park rather than leaving
  // `inject_accepted` standing, which is indistinguishable from a dispatch already on the wire.
  const obs = await daemon.request(`/api/inject-observations/${encodeURIComponent(inject.body.inject_id)}`);
  assert.equal(obs.status, 200);
  assert.equal(obs.body.tracking_state, 'tracked', 'a park is not terminal — it may not read as one');
  assert.equal(obs.body.observation.kind, 'inject_parked');
  assert.equal(obs.body.observation.trigger, 'bootstrap_queue');
  assert.equal(obs.body.observation.bytes_written, 0);
});

test('#860 F2: an unparked delivery still audits `success`', async () => {
  // The other half of the discrimination. A spawned shell is not a known AI CLI, so nothing gates
  // it and its PTY takes the write; this dispatch is a real delivery and its word is unchanged.
  const sid = createSessionId('f2-ungated');
  const spawned = await daemon.spawnSession(sid);
  assert.equal(spawned.status === 200 || spawned.status === 201, true, JSON.stringify(spawned.body));
  const inject = await daemon.request(`/api/sessions/${encodeURIComponent(sid)}/inject`, {
    method: 'POST', body: { prompt: 'a task', from: 'orchestrator' },
  });
  assert.equal(inject.status, 200, JSON.stringify(inject.body));
  assert.notEqual(inject.body.strategy, 'bootstrap_queue');

  const line = await auditLineFor(inject.body.inject_id);
  assert.equal(line.delivery_result, 'success');
});

test('#860 F2: `queued` is keyed on the strategy — a mailbox delivery also carries queued:true', () => {
  // The trap in the obvious fix. The mailbox path returns `{strategy:'mailbox', queued: ack.queued}`
  // for a body it has ALREADY written (mailboxDelivery.tick() runs synchronously before it
  // returns), so keying the audit word on `queued` alone would relabel real deliveries.
  const r = daemonModule.deliveryAuditResult;
  assert.equal(r({ success: true, strategy: 'bootstrap_queue', queued: true }), 'queued');
  assert.equal(r({ success: true, strategy: 'mailbox', queued: true, pending: 1 }), 'success');
  assert.equal(r({ success: true, strategy: 'mailbox', queued: false }), 'success');
  assert.equal(r({ success: true, strategy: 'direct_fallback' }), 'success');
  assert.equal(r(null), 'success');
});

// ── The three terminal queue outcomes, each driven through the production enqueue. ───────────

// A wrapped claude session as the daemon models one (the fixture shape test/claude-modal-inject-760
// established): the owner WebSocket is the real delivery leg, so nothing here stubs out the code
// under test. `failWrites` makes the leg refuse, which is what a dropped bridge looks like.
function claudeSession(ring, { ready = true, failAfter = Infinity } = {}) {
  const written = [];
  const ws = {
    readyState: 1,
    send: (msg) => {
      written.push(JSON.parse(msg).data);
      if (written.length >= failAfter) ws.readyState = 3;   // the bridge drops mid-delivery
    },
  };
  return {
    type: 'wrapped', command: 'claude', backend: 'pty', cmuxWorkspaceId: null,
    bootstrapReady: ready, bootstrapReadyReason: ready ? 'owner_alive' : null,
    outputRing: [ring], outputRingTotalBytes: ring.length,
    bracketedPasteCapable: true, ownerWs: ws, written,
  };
}

// A real claude AskUserQuestion surface — the modal shape #760 measured. Enough of it to satisfy
// the positional predicate; the full captured rings live in test/claude-modal-inject-760.test.js.
const MODAL_RING = '\n? Do you want to proceed?\n> 1. Yes\n  2. No, keep planning\n';
const CLEAR_RING = '';

// Open a tracked record the way the inject route does, then park through the production path —
// `deliverInjectionToSession` is the enqueue, exactly as the route calls it.
async function parkTracked(sessionId, session, injectId, opts = {}) {
  const begun = daemonModule.beginTrackedInjection({ injectId, sessionId, source: 'orchestrator', session });
  assert.equal(begun.ok, true);
  const delivery = await daemonModule.deliverInjectionToSession(sessionId, session, 'REPORT: stranded', {
    noEnter: true, from: 'orchestrator', injectId, ...opts,
  });
  assert.equal(delivery.queued, true, 'precondition: the op parked instead of being written');
  assert.equal(session.written.length, 0, 'precondition: zero bytes reached the surface');
  return delivery;
}

test('#860 F2: a park dropped at the modal TTL is aborted in the ledger, not only on the bus', async () => {
  const sid = 'f2-modal-ttl';
  const session = claudeSession(MODAL_RING);              // nobody ever answers the modal
  await parkTracked(sid, session, 'inj-modal-ttl');

  const outcome = await daemonModule.awaitModalParkDrain(sid, session, { timeoutMs: 120, pollIntervalMs: 20 });
  assert.equal(outcome.flushed, 1, 'precondition: the TTL flushed the parked op');

  const record = daemonModule.getTrackedInjection('inj-modal-ttl');
  assert.equal(record.tracking_state, 'aborted',
    'the op was discarded and the ledger still said the dispatch was in flight');
  assert.equal(record.last_observation.kind, 'inject_delivery_dropped');
  assert.equal(record.last_observation.trigger, 'surface_modal_park_timeout');
  assert.equal(record.last_observation.bytes_written, 0);
});

test('#860 F2: a park dropped at the bootstrap-ready timeout is aborted in the ledger', async () => {
  const sid = 'f2-boot-timeout';
  // Bootstrap-gated and not ready: the boot queue, not the modal park. Same FIFO, different cause.
  const session = claudeSession(CLEAR_RING, { ready: false });
  await parkTracked(sid, session, 'inj-boot-timeout');

  daemonModule.failBootstrapQueueOnTimeout(sid, session, { reason: 'bootstrap_ready_timeout' });
  assert.equal(session.bootstrapQueue.length, 0, 'precondition: the timeout flushed the queue');

  const record = daemonModule.getTrackedInjection('inj-boot-timeout');
  assert.equal(record.tracking_state, 'aborted');
  assert.equal(record.last_observation.kind, 'inject_delivery_dropped');
  assert.equal(record.last_observation.trigger, 'bootstrap_ready_timeout');
  assert.equal(record.last_observation.bytes_written, 0);
});

test('#860 F2: a drain whose write is refused is aborted in the ledger, with the bytes it measured', async () => {
  const sid = 'f2-drain-fail';
  const session = claudeSession(CLEAR_RING, { ready: false });
  await parkTracked(sid, session, 'inj-drain-fail');

  session.bootstrapReady = true;                           // the CLI comes up …
  session.ownerWs.readyState = 3;                          // … and the bridge is gone by the time it drains
  await daemonModule.drainBootstrapQueue(sid, session);

  const record = daemonModule.getTrackedInjection('inj-drain-fail');
  assert.equal(record.tracking_state, 'aborted');
  assert.equal(record.last_observation.kind, 'inject_delivery_refused',
    'the write was ATTEMPTED and refused — that is not the same measurement as never attempting it');
  assert.equal(record.last_observation.trigger, 'bootstrap_queue_failed');
  assert.equal(record.last_observation.delivery_code, 'DISCONNECTED');
  assert.equal(record.last_observation.bytes_written, 0);
});

test('#860 F2: a submit CR refused AFTER the body landed is not recorded as a delivery of nothing', async () => {
  // The trap inside the fix. The queue drain writes the body and the submit CR as two separate
  // writes; stamping `bytes_written: 0` on a CR failure would be a fresh instance of the defect
  // being closed — the body IS on the surface.
  const sid = 'f2-cr-fail';
  const session = claudeSession(CLEAR_RING, { ready: false, failAfter: 1 });
  await parkTracked(sid, session, 'inj-cr-fail', { noEnter: false });   // this one submits

  session.bootstrapReady = true;
  await daemonModule.drainBootstrapQueue(sid, session);

  const record = daemonModule.getTrackedInjection('inj-cr-fail');
  assert.equal(record.tracking_state, 'aborted');
  assert.equal(record.last_observation.kind, 'inject_delivery_refused');
  assert.equal(session.written.length, 1, 'precondition: the body landed, the CR did not');
  assert.equal(record.last_observation.bytes_written, Buffer.byteLength(session.written[0]),
    'the record must state what actually reached the surface, not a convenient zero');
});

test('#860 F2: an UNtracked inject through the same queue changes nothing', async () => {
  // multicast / broadcast / the bus route open no ledger record, so every consumer of the op's
  // inject_id has to no-op on its absence rather than throw inside a drain.
  const sid = 'f2-untracked';
  const session = claudeSession(MODAL_RING);
  const delivery = await daemonModule.deliverInjectionToSession(sid, session, 'no record', { noEnter: true });
  assert.equal(delivery.queued, true);
  const outcome = await daemonModule.awaitModalParkDrain(sid, session, { timeoutMs: 120, pollIntervalMs: 20 });
  assert.equal(outcome.flushed, 1, 'the flush must survive an op with no tracked record');
});
