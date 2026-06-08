'use strict';

// #568 — render-gate the PTY-0x0D submit + state-primary confirm + adaptive retry.
//
// Reproduce-first harness for the intermittent "Enter doesn't land" failure:
//   FM1 busy-render race — the CR is written into a mid-render TUI and dropped
//                          because nothing waits for the input to settle.
//   FM2 retry-hits-busy  — the retry re-fires the CR without re-gating.
//   FM3 alt-screen confirm — codex renders the body off the outputRing tail, so
//                          the body-absence short-circuit ACCEPTS a dropped CR.
//
// Fully hermetic: no daemon spawn, no PTY, no network. The session is a plain
// object with a scriptable `outputRing` + `getState`, driven by a fake clock.
// See dispatch telepty #568 and docs/adr/2026-06-07-submit-via-pty-context-layer.md.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  awaitInputSettled,
  confirmSubmitAccepted,
} = require('../src/submit-gate');

// ---------------------------------------------------------------------------
// Fake clock — same shape as submit-gate.test.js (poll-per-advance).
// ---------------------------------------------------------------------------

function makeFakeClock() {
  let now = 1_000_000;
  const pending = [];
  return {
    now: () => now,
    sleep: (ms) =>
      new Promise((resolve) => {
        pending.push({ at: now + ms, resolve });
      }),
    advance: async (ms) => {
      now += ms;
      const due = pending.filter((p) => p.at <= now);
      for (const p of due) {
        const idx = pending.indexOf(p);
        if (idx !== -1) pending.splice(idx, 1);
        p.resolve();
        await Promise.resolve();
      }
    },
  };
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

// ===========================================================================
// awaitInputSettled — the render gate (highest leverage, FM1/FM2)
// ===========================================================================

test('awaitInputSettled: empty body resolves ready immediately (nothing to gate)', async () => {
  const r = await awaitInputSettled({ outputRing: ['anything'] }, '', { timeoutMs: 500 });
  assert.equal(r.ready, true);
  assert.equal(r.reason, 'empty_body');
  assert.equal(r.waited_ms, 0);
});

test('awaitInputSettled: missing outputRing resolves ready (cannot gate → optimistic, never blocks)', async () => {
  const r = await awaitInputSettled({}, 'some body', { timeoutMs: 500 });
  assert.equal(r.ready, true);
  assert.equal(r.reason, 'no_ring');
  assert.equal(r.waited_ms, 0);
});

test('FM1: CR is NOT released while the render is busy; settles only after echo + quiet-window', async () => {
  const clock = makeFakeClock();
  const body = 'REPORT: broker W4 done';
  // Body is echoed into the input line from the start, but a spinner keeps
  // redrawing the tail (busy render) for ~90ms, then goes quiet.
  const session = { outputRing: [`> ${body}`, 'frame-0'] };
  const promise = awaitInputSettled(session, body, {
    timeoutMs: 2000,
    quietWindowMs: 100,
    pollIntervalMs: 30,
    stripAnsi,
    now: clock.now,
    sleep: clock.sleep,
  });

  // Busy: mutate the tail before each of the first 3 polls → never quiet.
  session.outputRing.push('frame-1'); await clock.advance(30); // t=30
  session.outputRing.push('frame-2'); await clock.advance(30); // t=60
  session.outputRing.push('frame-3'); await clock.advance(30); // t=90
  // Now quiet — stop mutating. Needs a full 100ms of no change.
  await clock.advance(30);  // t=120  (30ms quiet)
  await clock.advance(30);  // t=150  (60ms quiet)
  await clock.advance(30);  // t=180  (90ms quiet)
  await clock.advance(30);  // t=210  (120ms quiet ≥ 100 → settle)

  const r = await promise;
  assert.equal(r.ready, true);
  assert.equal(r.reason, 'settled');
  assert.equal(r.echoed, true);
  // Settled only AFTER the busy render ended (last change ~t=90) + quiet window.
  assert.ok(r.waited_ms >= 180, `expected settle after busy+quiet, waited_ms=${r.waited_ms}`);
});

test('awaitInputSettled: already-echoed + already-quiet settles within one quiet-window (common fast case preserved)', async () => {
  const clock = makeFakeClock();
  const body = 'hello world';
  const session = { outputRing: [`> ${body}`] }; // static, no further output
  const promise = awaitInputSettled(session, body, {
    timeoutMs: 2000, quietWindowMs: 100, pollIntervalMs: 30, stripAnsi,
    now: clock.now, sleep: clock.sleep,
  });
  await clock.advance(30);
  await clock.advance(30);
  await clock.advance(30);
  await clock.advance(30); // t=120 ≥ quietWindow
  const r = await promise;
  assert.equal(r.ready, true);
  assert.equal(r.reason, 'settled');
  assert.equal(r.echoed, true);
});

test('FM3-gate: body never echoes into the tail (alt-screen) but render is quiet → settles via quiet alone after echo-grace', async () => {
  const clock = makeFakeClock();
  // codex alt-screen: body is rendered off-ring; the tail is a static frame.
  const session = { outputRing: ['gpt-5.5 ·  ~/proj   (alt-screen, body not in tail)'] };
  const promise = awaitInputSettled(session, 'unblock W1 now', {
    timeoutMs: 2000, quietWindowMs: 100, echoGraceMs: 300, pollIntervalMs: 30, stripAnsi,
    now: clock.now, sleep: clock.sleep,
  });
  for (let t = 0; t < 360; t += 30) await clock.advance(30);
  const r = await promise;
  assert.equal(r.ready, true);
  assert.equal(r.reason, 'settled_no_echo');
  assert.equal(r.echoed, false);
  // Must not settle before the echo-grace elapsed.
  assert.ok(r.waited_ms >= 300, `settled before echo-grace, waited_ms=${r.waited_ms}`);
});

test('FM2-gate: a render that never goes quiet (continuous spinner) times out best-effort (ready:false, bounded)', async () => {
  const clock = makeFakeClock();
  const body = 'sustained busy body';
  const session = { outputRing: [`> ${body}`, 'spin-0'] };
  const promise = awaitInputSettled(session, body, {
    timeoutMs: 200, quietWindowMs: 100, pollIntervalMs: 30, stripAnsi,
    now: clock.now, sleep: clock.sleep,
  });
  // Mutate on EVERY poll → never quiet → bounded timeout.
  for (let i = 0; i < 10; i++) { session.outputRing.push(`spin-${i + 1}`); await clock.advance(30); }
  const r = await promise;
  assert.equal(r.ready, false);
  assert.equal(r.reason, 'timeout');
  assert.equal(r.echoed, true); // body was visible; just never settled
  assert.ok(r.waited_ms >= 200);
});

// ===========================================================================
// confirmSubmitAccepted — state-primary; no false-accept on alt-screen (FM3)
// ===========================================================================

test('FM3: dropped CR on codex alt-screen (body absent, state never transitions) is NOT accepted → retryable no_land', async () => {
  const clock = makeFakeClock();
  const submittedAtMs = clock.now();
  const session = { backend: 'cmux', cmuxWorkspaceId: 'ws:1', outputRing: ['gpt-5.5 ·  ~/proj  (body off-ring)'] };
  const stuckIdle = { state: 'idle', confidence: 0.6, since_ms: submittedAtMs - 500 };
  const promise = confirmSubmitAccepted(session, 'unblock W1 now', {
    submittedAtMs, timeoutMs: 150, intervalMs: 30, stripAnsi,
    getState: () => stuckIdle, now: clock.now, sleep: clock.sleep,
  });
  for (let t = 0; t < 180; t += 30) await clock.advance(30);
  const r = await promise;
  assert.equal(r.accepted, false, 'a dropped CR must NOT be reported accepted');
  assert.equal(r.retryable, true);
  assert.equal(r.reason, 'no_land');
});

test('codex confirm: alt-screen body absent but state→working (via #558 markers) → accepted via STATE, not absence', async () => {
  const clock = makeFakeClock();
  const submittedAtMs = clock.now();
  const session = { backend: 'cmux', cmuxWorkspaceId: 'ws:1', outputRing: ['gpt-5.5 ·  ~/proj  (body off-ring)'] };
  let state = { state: 'idle', confidence: 0.6, since_ms: submittedAtMs - 500 };
  const promise = confirmSubmitAccepted(session, 'unblock W1 now', {
    submittedAtMs, timeoutMs: 400, intervalMs: 30, stripAnsi,
    getState: () => state, now: clock.now, sleep: clock.sleep,
  });
  await clock.advance(30); // first poll: body absent, state idle → keeps waiting (no false body_absent)
  state = { state: 'working', confidence: 0.9, since_ms: clock.now() };
  await clock.advance(30);
  await clock.advance(30);
  const r = await promise;
  assert.equal(r.accepted, true);
  assert.equal(r.reason, 'state_working');
});

test('claude confirm: body echoed then consumed → accepted via body_consumed (body secondary, corroborating)', async () => {
  const clock = makeFakeClock();
  const submittedAtMs = clock.now();
  const body = 'REPORT: T9 broker landed';
  const session = { backend: 'cmux', outputRing: [`❯ ${body}`] };
  const idle = { state: 'idle', confidence: 0.6, since_ms: submittedAtMs - 500 };
  const promise = confirmSubmitAccepted(session, body, {
    submittedAtMs, timeoutMs: 400, intervalMs: 30, stripAnsi,
    getState: () => idle, now: clock.now, sleep: clock.sleep,
  });
  await clock.advance(30); // poll1: body visible → everVisible
  session.outputRing[0] = '❯ '; // Enter consumed the input line
  await clock.advance(30); // poll2: body gone → consumed
  const r = await promise;
  assert.equal(r.accepted, true);
  assert.equal(r.reason, 'body_consumed');
});

test('gemini confirm: body echoed + state→working → accepted via STATE (primary)', async () => {
  const clock = makeFakeClock();
  const submittedAtMs = clock.now();
  const body = 'run the suite';
  const session = { backend: 'cmux', outputRing: [`│ > ${body}`] };
  let state = { state: 'idle', confidence: 0.6, since_ms: submittedAtMs - 500 };
  const promise = confirmSubmitAccepted(session, body, {
    submittedAtMs, timeoutMs: 400, intervalMs: 30, stripAnsi,
    getState: () => state, now: clock.now, sleep: clock.sleep,
  });
  await clock.advance(30);
  state = { state: 'working', confidence: 0.9, since_ms: clock.now() };
  await clock.advance(30);
  const r = await promise;
  assert.equal(r.accepted, true);
  assert.equal(r.reason, 'state_working');
});

test('back-compat: confirm WITHOUT a state probe keeps the optimistic body-absent accept (no behavior change)', async () => {
  const session = { outputRing: ['codex prompt ›'] };
  const r = await confirmSubmitAccepted(session, 'a body that is not present', {
    timeoutMs: 200, intervalMs: 20,
  });
  assert.equal(r.accepted, true);
  assert.equal(r.retryable, false);
  assert.equal(r.reason, 'body_absent');
});

// ===========================================================================
// Submit-loop harness — render-gate + adaptive retry end-to-end (mirrors the
// daemon executeBootstrapSubmit wiring: gate → CR → confirm → re-gate → retry).
// ===========================================================================

// A scriptable fake CLI: the CR only "lands" (drives state→working + consumes
// the body) when it is written during a READY window. While busy, a written CR
// is dropped — exactly the FM1 race.
function makeFakeCli({ busyUntil, lands = true }) {
  const session = { backend: 'cmux', outputRing: [`> the body`] };
  let landed = false;
  let workingSince = null;
  return {
    session,
    getState(now) {
      if (workingSince != null) return { state: 'working', confidence: 0.9, since_ms: workingSince };
      return { state: 'idle', confidence: 0.6, since_ms: now - 1000 };
    },
    // tail is "busy" (changing) until busyUntil; quiet afterwards
    tickOutput(now) {
      if (now < busyUntil) session.outputRing.push(`f-${now}`);
    },
    writeCR(now) {
      // CR dropped if written while busy, or if this CLI never lands.
      if (!lands) return;
      if (now >= busyUntil && !landed) {
        landed = true;
        workingSince = now;
        session.outputRing[0] = '> '; // body consumed
      }
    },
  };
}

async function runSubmitLoop(cli, { retries = 6, retryDelayMs = 120, gate = true }, clock) {
  const body = 'the body';
  let attempts = 0;
  let confirm = null;
  for (let i = 0; i <= retries; i++) {
    if (gate) {
      await awaitInputSettled(cli.session, body, {
        timeoutMs: 1000, quietWindowMs: 60, pollIntervalMs: 20, stripAnsi,
        now: clock.now, sleep: clock.sleep,
      });
    }
    const submittedAtMs = clock.now();
    cli.writeCR(clock.now());
    attempts++;
    confirm = await confirmSubmitAccepted(cli.session, body, {
      submittedAtMs, timeoutMs: 120, intervalMs: 20, stripAnsi,
      getState: () => cli.getState(clock.now()), now: clock.now, sleep: clock.sleep,
    });
    if (confirm.accepted || !confirm.retryable) break;
    await clock.sleep(retryDelayMs);
  }
  return { attempts, confirm };
}

test('busy-then-ready: the render gate makes the CR land on the FIRST attempt once quiet', async () => {
  const clock = makeFakeClock();
  // Busy for 80ms then ready. Gate must hold the CR until quiet, so it lands ×1.
  const cli = makeFakeCli({ busyUntil: 1_000_080 });
  const driver = runSubmitLoop(cli, { gate: true }, clock);
  // Pump the clock forward enough for gate + confirm to resolve.
  for (let i = 0; i < 60; i++) { cli.tickOutput(clock.now()); await clock.advance(20); }
  const { attempts, confirm } = await driver;
  assert.equal(confirm.accepted, true);
  assert.equal(attempts, 1, 'render-gated CR landed first try (no wasted retries)');
});

test('genuine no-land: a CR that never lands + state never transitions → truthful failure (retryable, bounded attempts)', async () => {
  const clock = makeFakeClock();
  const cli = makeFakeCli({ busyUntil: 0, lands: false }); // CR always dropped
  const driver = runSubmitLoop(cli, { retries: 4, gate: true }, clock);
  for (let i = 0; i < 200; i++) { await clock.advance(20); }
  const { attempts, confirm } = await driver;
  assert.equal(confirm.accepted, false, 'never claim success on an unsent CR');
  assert.equal(confirm.retryable, true);
  assert.equal(attempts, 5, 'exhausted the bounded retry budget (1 + 4 retries)');
});
