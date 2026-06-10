'use strict';

// #48: TASK_IDLE_UNCONFIRMED fired on the FIRST weak idle/ready snapshot right after an
// inject — almost always a transition-gap false positive (the bridge re-sends 'ready' on a
// TUI prompt-glyph redraw, or codex's silence+glyph flips real-idle mid-work) while the
// session was in fact processing the inject and flipped (or already was) working.
//
// The fix: settle-and-recheck. A would-be UNCONFIRMED notification is held for a settle
// window (TELEPTY_IDLE_UNCONFIRMED_SETTLE_SECONDS) and re-checked against the LIVE session:
//   - session classified working/thinking at recheck → suppress (idleNotified NOT consumed,
//     so a later genuine busy→idle transition re-enters the path);
//   - output advanced while still idle-classified → re-settle (bounded);
//   - still idle AND output stalled → notify (signal preserved — the original purpose).
// The label is pinned at arm time: a settled recheck can only emit UNCONFIRMED, never a
// TASK_COMPLETE promoted by elapsed growing past the floor (never a false complete).
//
// Unit tests drive fireAutoReport() via its deps DI seam (same pattern as
// test/enforce-submit-gate.test.js); integration tests reproduce the live #48 shape
// against a real daemon via test-support/daemon-harness.js (PORT=0).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionId, delay, startTestDaemon, waitFor } = require('../test-support/daemon-harness');

const daemon = require('../daemon');
const { fireAutoReport } = daemon;

// ---------------------------------------------------------------------------
// Unit: fireAutoReport settle-and-recheck via the deps DI seam
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000; // fixed clock origin

// Build a DI context around fireAutoReport: captured timers (flushed manually, advancing
// the injected clock), captured deliveries/broadcasts, and a mutable auto-state.
function makeGate({ elapsedSec = 0.2, pendingReportOverrides = {}, autoState = 'idle' } = {}) {
  const ctx = {
    nowMs: T0,
    autoState,
    timers: [],
    delivered: [],
    broadcasts: [],
    session: { id: 'worker-1', lastActivityAt: new Date(T0 - 60_000).toISOString() },
  };
  ctx.pendingReport = {
    source: 'orch',
    injectId: 'inj-48',
    injectedAt: new Date(T0 - elapsedSec * 1000).toISOString(),
    ...pendingReportOverrides,
  };
  ctx.deps = {
    now: () => ctx.nowMs,
    setTimeout: (fn, ms) => { ctx.timers.push({ fn, ms }); return ctx.timers.length; },
    broadcastSessionEvent: (type, sid, _s, opts) => ctx.broadcasts.push({ type, sid, opts }),
    resolveSessionAlias: (s) => s,
    sessions: { orch: { id: 'orch' }, 'worker-1': ctx.session },
    pendingReports: { 'worker-1': ctx.pendingReport },
    deliverInjectionToSession: (srcId, _s, msg) => ctx.delivered.push({ srcId, msg }),
    getAutoState: () => ctx.autoState,
  };
  ctx.fire = (trigger = 'ready-signal') =>
    fireAutoReport('worker-1', ctx.session, ctx.pendingReport, trigger, ctx.deps);
  // Run the currently-armed timers once (advancing the clock by each delay).
  ctx.flushTimers = () => {
    const due = ctx.timers.splice(0);
    for (const { fn, ms } of due) { ctx.nowMs += ms; fn(); }
  };
  return ctx;
}

test('#48 FP: ready-signal 0.2s after a plain inject does NOT notify immediately — settle armed', () => {
  const ctx = makeGate({ elapsedSec: 0.2 });
  ctx.fire();
  assert.equal(ctx.delivered.length, 0, 'no immediate UNCONFIRMED delivery');
  assert.equal(ctx.broadcasts.length, 0, 'no immediate TASK_IDLE_NO_REPORT broadcast');
  assert.equal(ctx.pendingReport.idleNotified, undefined, 'once-only guard not consumed');
  assert.equal(ctx.timers.length, 1, 'settle recheck timer armed');
});

test('#48 FP: session working at recheck → suppressed entirely, once-only guard not consumed', () => {
  const ctx = makeGate({ elapsedSec: 0.2 });
  ctx.fire();
  ctx.autoState = 'working'; // the transition gap closed during the settle window
  ctx.flushTimers();
  assert.equal(ctx.delivered.length, 0, 'suppressed — inject IS being processed');
  assert.equal(ctx.broadcasts.length, 0);
  assert.equal(ctx.pendingReport.idleNotified, undefined, 'a later busy→idle transition may still notify');
});

test('#48 FP: real-idle mid-work flip (codex ~4.8s) with unconfirmed submit → suppressed when working at recheck', () => {
  const ctx = makeGate({
    elapsedSec: 4.8,
    pendingReportOverrides: {
      submitExpected: true,
      submitConfirm: { accepted: false, reason: 'submit_unconfirmed' },
    },
  });
  ctx.fire('real-idle');
  ctx.autoState = 'working';
  ctx.flushTimers();
  assert.equal(ctx.delivered.length, 0);
  assert.equal(ctx.pendingReport.idleNotified, undefined);
});

test('#48 signal preserved: still idle + output stalled after settle → TASK_IDLE_UNCONFIRMED fires (format intact)', () => {
  const ctx = makeGate({ elapsedSec: 0.2 });
  ctx.fire();
  ctx.flushTimers(); // state stays idle, lastActivityAt unchanged
  assert.equal(ctx.delivered.length, 1, 'genuinely-unconsumed inject still notifies');
  assert.equal(ctx.delivered[0].srcId, 'orch');
  assert.match(
    ctx.delivered[0].msg,
    /^TASK_IDLE_UNCONFIRMED: worker-1 signaled idle \d+\.\ds after inject \(via ready-signal inject=inj-48\)/,
    'consumer-visible message format preserved'
  );
  assert.equal(ctx.pendingReport.idleNotified, true);
  assert.ok(ctx.broadcasts.some((b) => b.type === 'TASK_IDLE_NO_REPORT'), 'bus event fires with the notification');
});

test('#48 never-false-complete: elapsed crossing the floor during settle must NOT promote to TASK_COMPLETE', () => {
  // Armed at 0.2s (sub-floor); the settle window pushes fire-time elapsed past
  // AUTO_REPORT_MIN_REAL_SECONDS. The label is pinned at arm time — a genuinely
  // unconsumed inject must never be reported DONE because time passed.
  const ctx = makeGate({ elapsedSec: 0.2 });
  ctx.fire();
  ctx.flushTimers();
  assert.equal(ctx.delivered.length, 1);
  assert.match(ctx.delivered[0].msg, /^TASK_IDLE_UNCONFIRMED:/);
  assert.doesNotMatch(ctx.delivered[0].msg, /^TASK_COMPLETE:/);
});

test('#48: output advance while still idle-classified re-settles (bounded) before notifying', () => {
  const ctx = makeGate({ elapsedSec: 0.2 });
  ctx.fire();
  // Output advanced during the settle window (sparse TUI redraw) but state still idle.
  ctx.session.lastActivityAt = new Date(T0 + 100).toISOString();
  ctx.flushTimers();
  assert.equal(ctx.delivered.length, 0, 're-settled instead of firing');
  assert.equal(ctx.timers.length, 1, 'a fresh settle window is open');
  // Output now stalls → the next recheck fires.
  ctx.flushTimers();
  assert.equal(ctx.delivered.length, 1);
  assert.match(ctx.delivered[0].msg, /^TASK_IDLE_UNCONFIRMED:/);
});

test('#48: suppression keeps the door open — a later evidence-backed real-idle still reports TASK_COMPLETE', () => {
  const ctx = makeGate({ elapsedSec: 0.2 });
  ctx.fire();
  ctx.autoState = 'working';
  ctx.flushTimers(); // suppressed, idleNotified not consumed
  assert.equal(ctx.delivered.length, 0);

  // The worker finishes: a genuine busy→idle transition with processing evidence.
  ctx.pendingReport.sawWorkingAfterInject = true;
  ctx.nowMs = T0 + 30_000;
  ctx.autoState = 'idle';
  ctx.fire('real-idle');
  assert.equal(ctx.delivered.length, 1);
  assert.match(ctx.delivered[0].msg, /^TASK_COMPLETE:/, 'confirmed completions are never deferred');
});

test('#48: a second trigger while a settle window is open does not double-arm or notify', () => {
  const ctx = makeGate({ elapsedSec: 0.2 });
  ctx.fire();
  ctx.fire('real-idle'); // e.g. classifier idle flip lands while ready-signal settle is open
  assert.equal(ctx.timers.length, 1, 'single settle window');
  assert.equal(ctx.delivered.length, 0);
});

test('#48: settle recheck stands down when the pending report was cleared (REPORT arrived)', () => {
  const ctx = makeGate({ elapsedSec: 0.2 });
  ctx.fire();
  delete ctx.deps.pendingReports['worker-1']; // REPORT consumed the entry
  ctx.flushTimers();
  assert.equal(ctx.delivered.length, 0);
  assert.equal(ctx.broadcasts.length, 0);
});

// ---------------------------------------------------------------------------
// Integration: live #48 shape against a real daemon (headless harness, PORT=0)
// ---------------------------------------------------------------------------

function collectJsonMessages(ws) {
  const messages = [];
  ws.on('message', (chunk) => {
    try { messages.push(JSON.parse(chunk.toString())); } catch { /* ignore */ }
  });
  return messages;
}

let harness;

before(async () => {
  harness = await startTestDaemon({
    env: {
      TELEPTY_IDLE_UNCONFIRMED_SETTLE_SECONDS: '0.4', // fast settle for tests
      AIGENTRY_ORCHESTRATOR_SIDS: 'orchestrator orch',
    },
  });
});

after(async () => {
  await harness.stop();
});

// Register a wrapped codex-like session, connect its owner bridge, and pass bootstrap.
async function bootWrappedSession(sessionId) {
  await harness.registerSession(sessionId, { command: 'codex', backend: 'pty' });
  const ownerWs = await harness.connectSession(sessionId);
  ownerWs.send(JSON.stringify({ type: 'ready' }));
  await waitFor(async () => {
    const detail = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}`);
    return detail.body && detail.body.transport && detail.body.transport.bootstrap.ready;
  }, { timeoutMs: 5000, description: `${sessionId} bootstrap ready` });
  return ownerWs;
}

test('#48 integration FP: ready-signal right after inject into an already-working TUI → no false notification', async () => {
  const sessionId = createSessionId('idle-fp');
  const ownerWs = await bootWrappedSession(sessionId);
  const orchWs = await bootWrappedSession('orch');
  const orchMessages = collectJsonMessages(orchWs);
  const bus = await harness.connectBus();
  const busMessages = collectJsonMessages(bus);

  // The live #48 shape: the TUI is already classified WORKING when the inject lands, so the
  // post-inject echo causes no state transition and no processing-evidence flag is ever set.
  ownerWs.send(JSON.stringify({ type: 'output', data: 'compiling project output\n' }));
  await delay(50);

  const inject = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
    method: 'POST',
    body: { prompt: 'ACK status please', from: 'orch' },
  });
  assert.equal(inject.status, 200);

  // Bridge behavior after an inject (cli.js): echo the redraw, then re-send 'ready' on the
  // prompt-glyph render — ~0.0s after the inject, while the session keeps working.
  ownerWs.send(JSON.stringify({ type: 'output', data: 'still compiling, more output\n' }));
  ownerWs.send(JSON.stringify({ type: 'ready' }));

  await delay(150); // pre-fix the false positive fired right here
  assert.equal(
    busMessages.some((m) => m.type === 'TASK_IDLE_NO_REPORT' && m.session_id === sessionId),
    false,
    'no immediate idle notification — settle window open'
  );

  // Still working through the settle recheck (0.4s) — the snapshot must be discarded.
  ownerWs.send(JSON.stringify({ type: 'output', data: 'work continues, esc to interrupt\n' }));
  await delay(900);
  assert.equal(
    busMessages.some((m) => m.type === 'TASK_IDLE_NO_REPORT' && m.session_id === sessionId),
    false,
    'suppressed after recheck — the session was processing the inject'
  );
  assert.equal(
    orchMessages.some((m) => m.type === 'inject' && /TASK_IDLE_UNCONFIRMED/.test(String(m.data))),
    false,
    'no false TASK_IDLE_UNCONFIRMED text reaches the injecting side'
  );

  bus.close();
  ownerWs.close();
  orchWs.close();
});

test('#48 integration signal preserved: genuinely unconsumed inject still notifies after the settle window', async () => {
  const sessionId = createSessionId('idle-real');
  const ownerWs = await bootWrappedSession(sessionId);
  const orchWs = await bootWrappedSession('orch2-' + Date.now());
  void orchWs; // distinct source session not required for the bus assertion below

  const bus = await harness.connectBus();
  const busMessages = collectJsonMessages(bus);

  const inject = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
    method: 'POST',
    body: { prompt: 'do the thing', from: 'orch' },
  });
  assert.equal(inject.status, 200);

  // The bridge re-sends 'ready' but the session produces NO output and never starts working —
  // the inject genuinely was not consumed. After the settle window the warning MUST fire.
  ownerWs.send(JSON.stringify({ type: 'ready' }));

  await waitFor(
    () => busMessages.some((m) => m.type === 'TASK_IDLE_NO_REPORT' && m.session_id === sessionId),
    { timeoutMs: 4000, description: 'TASK_IDLE_NO_REPORT after settle for an unconsumed inject' }
  );
  const event = busMessages.find((m) => m.type === 'TASK_IDLE_NO_REPORT' && m.session_id === sessionId);
  assert.equal(event.source, 'orch');

  bus.close();
  ownerWs.close();
  orchWs.close();
});

// Requiring daemon.js loads persisted sessions for read-only inspection; ensure the test
// process exits even if module-load left background handles open.
test.after(() => { setImmediate(() => process.exit(0)); });
