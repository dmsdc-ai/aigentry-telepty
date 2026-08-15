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

// #60 Stage A: fireAutoReport no longer CHOOSES a label. It emits one literal statement that
// names the measured cause and says, in words, that no completion fact exists. `TASK_COMPLETE`
// (a claim it could not measure) and `TASK_IDLE_UNCONFIRMED` (which asserted the inject may not
// have been processed — also unmeasurable) are both gone, along with the elapsed-time floor that
// used to pick between them.
const COMPLETION_UNKNOWN_RE =
  /^TASK_COMPLETION_UNKNOWN: worker-1 inject=inj-48 — no completion fact observed; (\S+?)(?:=(\d+\.\d)s)?(?:; elapsed_since_inject=(\d+\.\d)s)?; consumption=(observed|not_established); outcome protocol unavailable$/;

const REMOVED_LABELS = [/TASK_COMPLETE:/, /TASK_IDLE_UNCONFIRMED:/, /TASK_COMPLETE_WITH_REPORT/];

// The observation kinds that describe a session having gone QUIET or a bridge claiming ready.
// Announcing one of these while the session is in fact working IS the #48 false positive.
const QUIET_OR_READY_KINDS = [
  'pty_quiet', 'prompt_suffix_after_quiet_observed', 'pty_quiet_after_osc_133_a_or_b_observed',
  'legacy_ready_observed', 'composer_surface_observed', 'prompt_suffix_observed',
];

function assertStatesAbsence(msg) {
  const m = COMPLETION_UNKNOWN_RE.exec(msg);
  assert.ok(m, `not the literal absence statement: ${msg}`);
  for (const re of REMOVED_LABELS) assert.doesNotMatch(msg, re);
  // #843: the kind's OWN measurement and the elapsed-since-inject qualifier are separate
  // segments now. They were one — whichever was present filled `<kind>=<n>s` — so a 3s quiet
  // 900s into a dispatch printed as `pty_quiet=900.0s`.
  return { kind: m[1], seconds: Number(m[2]), elapsedSeconds: Number(m[3]), consumption: m[4] };
}

function completionUnknownEvent(ctx) {
  const ev = ctx.broadcasts.find((b) => b.type === 'task_completion_unknown');
  assert.ok(ev, 'the bus always hears the absence');
  assert.equal(ev.opts.extra.completion_fact, null);
  assert.equal(ev.opts.extra.terminal, false);
  return ev.opts.extra;
}

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
  assert.equal(ctx.delivered.length, 0, 'no immediate follow-up delivery');
  assert.equal(ctx.broadcasts.length, 0, 'no immediate broadcast');
  // `idleNotified` is RETIRED — the once-only guard is now ledger identity dedup inside the
  // emitter. Asserting the old flag is undefined would be vacuous (nothing sets it), so the
  // live marker is asserted instead: the settle window is open and has not been marked done.
  assert.equal('idleNotified' in ctx.pendingReport, false, 'the retired once-only flag is not resurrected');
  assert.equal(ctx.pendingReport.unconfirmedSettleDone, undefined, 'settle not yet concluded');
  assert.ok(ctx.pendingReport.unconfirmedSettleTimer, 'settle window is open');
  assert.equal(ctx.timers.length, 1, 'settle recheck timer armed');
});

test('#48 FP: session working at recheck → suppressed entirely, once-only guard not consumed', () => {
  const ctx = makeGate({ elapsedSec: 0.2 });
  ctx.fire();
  ctx.autoState = 'working'; // the transition gap closed during the settle window
  ctx.flushTimers();
  assert.equal(ctx.delivered.length, 0, 'suppressed — inject IS being processed');
  assert.equal(ctx.broadcasts.length, 0);
  assert.equal(ctx.pendingReport.unconfirmedSettleDone, undefined,
    'suppression consumed nothing — a later busy→idle observation may still be stated');
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
  assert.equal(ctx.pendingReport.unconfirmedSettleDone, undefined);
});

test('#48 signal preserved: still idle + output stalled after settle → the absence is stated (format intact)', () => {
  const ctx = makeGate({ elapsedSec: 0.2 });
  ctx.fire();
  ctx.flushTimers(); // state stays idle, lastActivityAt unchanged
  assert.equal(ctx.delivered.length, 1, 'genuinely-unconsumed inject still notifies');
  assert.equal(ctx.delivered[0].srcId, 'orch');
  // RENAMED PRESENCE. The notification still fires, on the same path, after the same settle, to
  // the same source — #48's purpose is intact. What changed is what it is allowed to SAY: the old
  // text asserted "inject may NOT have been processed", which is not a measurement either.
  const stated = assertStatesAbsence(ctx.delivered[0].msg);
  assert.equal(stated.kind, 'legacy_ready_observed',
    'an unqualified bridge ready frame keeps its own name and cannot borrow a stronger one');
  assert.equal(stated.consumption, 'not_established');
  assert.equal(ctx.pendingReport.unconfirmedSettleDone, true, 'the settle concluded');
  const extra = completionUnknownEvent(ctx);
  assert.equal(extra.observation.kind, 'legacy_ready_observed');
});

test('#48 never-false-complete: elapsed crossing the floor during settle cannot promote to an outcome', () => {
  // Armed at 0.2s (sub-floor); the settle window pushes fire-time elapsed past
  // AUTO_REPORT_MIN_REAL_SECONDS. The old code CHOSE its label from elapsed time, so this test
  // pinned that the label was fixed at arm time. Stage A removes the choice outright: elapsed is
  // a FIELD on the observation and never a threshold, so there is no label for time to promote.
  const ctx = makeGate({ elapsedSec: 0.2 });
  ctx.fire();
  ctx.flushTimers();
  assert.equal(ctx.delivered.length, 1);
  const stated = assertStatesAbsence(ctx.delivered[0].msg);
  const extra = completionUnknownEvent(ctx);
  // Non-vacuous: elapsed really did cross the old floor — that is the exact input that used to
  // flip the verdict — and it is carried as evidence while claiming nothing.
  assert.ok(stated.elapsedSeconds >= 5,
    `expected elapsed past the old floor, got ${stated.elapsedSeconds}s`);
  assert.ok(extra.observation.elapsed_ms >= 5000);
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
  assertStatesAbsence(ctx.delivered[0].msg);
});

test('#48: suppression keeps the door open — a later real-idle still states the absence', () => {
  const ctx = makeGate({ elapsedSec: 0.2 });
  ctx.fire();
  ctx.autoState = 'working';
  ctx.flushTimers(); // suppressed; the settle is NOT marked done, so the path stays open
  assert.equal(ctx.delivered.length, 0);
  assert.equal(ctx.pendingReport.unconfirmedSettleDone, undefined, 'suppression consumed nothing');

  // The worker finishes: a genuine busy→idle transition with processing evidence.
  ctx.pendingReport.sawWorkingAfterInject = true;
  ctx.nowMs = T0 + 30_000;
  ctx.autoState = 'idle';
  ctx.fire('real-idle');

  // The old assertion was that THIS fire promoted straight to TASK_COMPLETE — "confirmed
  // completions are never deferred". There are no confirmed completions left to fast-path, so
  // the later quiet goes through the same settle debounce as any other. That is not silence: the
  // durable tracking_started record was committed before the bytes were ever handed over, so the
  // absence has been pollable since delivery. What this test still guards is the door-open
  // property — suppression must not have consumed the session's right to be described later.
  assert.equal(ctx.delivered.length, 0, 'the later observation debounces like any other');
  ctx.flushTimers();
  assert.equal(ctx.delivered.length, 1, 'the door stayed open — the later quiet is still stated');
  const stated = assertStatesAbsence(ctx.delivered[0].msg);
  assert.equal(stated.kind, 'pty_quiet', 'a real-idle entrance with no cause supplied is silence, named as such');
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
  const ownerWs = await harness.connectSession(sessionId, harness.ownerAuth(sessionId));
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

  // The #48 false positive, restated in Stage A vocabulary. Asserting that TASK_IDLE_NO_REPORT is
  // absent would now be vacuous — nothing produces that name any more. The FP that must stay
  // fixed is announcing a QUIET or READY observation for a session that is in fact working, so
  // that is what is pinned. Note this cannot be "no task_completion_unknown at all": the working
  // transitions legitimately emit `output_observed` ones, and demanding silence there would be
  // asking for exactly the absence-by-omission this release removes.
  const quietClaim = () => busMessages.find((m) => m.type === 'task_completion_unknown'
    && m.session_id === sessionId
    && QUIET_OR_READY_KINDS.includes(m.observation && m.observation.kind));

  await delay(150); // pre-fix the false positive fired right here
  assert.equal(quietClaim(), undefined, 'no immediate quiet observation — settle window open');

  // Still working through the settle recheck (0.4s) — the snapshot must be discarded.
  ownerWs.send(JSON.stringify({ type: 'output', data: 'work continues, esc to interrupt\n' }));
  await delay(900);
  assert.equal(quietClaim(), undefined,
    'suppressed after recheck — the session was processing the inject');
  assert.equal(
    orchMessages.some((m) => m.type === 'inject'
      && /TASK_IDLE_UNCONFIRMED|TASK_COMPLETION_UNKNOWN/.test(String(m.data))),
    false,
    'no false quiet text reaches the injecting side, under either the old or the new spelling'
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

  // Renamed presence: the post-settle notification still fires for a genuinely unconsumed
  // inject, carrying the same `source`. Only its claim changed.
  const quietClaim = () => busMessages.find((m) => m.type === 'task_completion_unknown'
    && m.session_id === sessionId
    && QUIET_OR_READY_KINDS.includes(m.observation && m.observation.kind));

  await waitFor(quietClaim,
    { timeoutMs: 4000, description: 'task_completion_unknown after settle for an unconsumed inject' }
  );
  const event = quietClaim();
  assert.equal(event.source, 'orch');
  assert.equal(event.completion_fact, null);
  assert.equal(event.terminal, false);
  assert.equal(event.consumption.status, 'not_established',
    'nothing was consumed, and the observation says so as a FIELD rather than as a gate');
  assert.equal(event.capability.outcome_protocol, 'unavailable');

  bus.close();
  ownerWs.close();
  orchWs.close();
});

// Requiring daemon.js loads persisted sessions for read-only inspection; ensure the test
// process exits even if module-load left background handles open.
test.after(() => { setImmediate(() => process.exit(0)); });
