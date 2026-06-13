'use strict';

// #617 — hold-and-redeliver: close the gap between #53 DETECTION (a busy recipient
// parks an inject(--submit)'s CR'd body in its composer → `queued`, no turn fires)
// and ACTION (re-fire the CR when the recipient goes idle so the parked REPORT turn
// finally starts). Before this, the daemon classified `queued` and did NOTHING — the
// worker's `telepty inject` does not read the consumption status and exits, so the
// REPORT was silently dropped (observed 5+ times on the live orchestrator).
//
// holdAndRedeliver is a pure, bounded loop driven entirely through DI seams
// (waitForIdle / isStillParked / fireCR / now), so the busy→queued→idle→redeliver
// path is reproduced deterministically with zero daemon coupling.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  holdAndRedeliver,
  classifyInjectConsumption,
} = require('../src/submit-gate');

const BODY = 'REPORT: 617-DONE | approach=hold-and-redeliver | files=2 | commit=abc1234 | tests pass';

// ---------------------------------------------------------------------------
// reproduce — the root-cause chain: a busy recipient yields `queued`, and that
// queued body is exactly what hold-and-redeliver must rescue.
// ---------------------------------------------------------------------------

test('#617 reproduce: a busy recipient parks the CR → queued (the dropped-report signal)', async () => {
  const submittedAtMs = 1000;
  let clock = submittedAtMs;
  const now = () => clock;
  const sleep = (ms) => { clock += ms; return Promise.resolve(); };
  const preFrames = ['› running prior turn…\n'];
  const postFrames = [`│ › ${BODY} │\n  Press up to edit queued messages\n`];
  const ring = [...preFrames, ...postFrames];
  const session = {
    outputRing: ring,
    outputRingTotalBytes: ring.reduce((s, d) => s + d.length, 0),
  };
  const sinceBytes = preFrames.reduce((s, d) => s + d.length, 0);

  const result = await classifyInjectConsumption(session, BODY, {
    submittedAtMs, sinceBytes, now, sleep,
    getState: () => ({ state: 'working', since_ms: 200 }), // busy BEFORE the CR
    timeoutMs: 1200, settleMs: 250,
  });

  assert.equal(result.status, 'queued', 'busy CR must classify as queued — the report is parked, not delivered');
});

// ---------------------------------------------------------------------------
// (a) fix — recipient goes idle, the re-fired CR is consumed → redelivered.
// ---------------------------------------------------------------------------

test('#617 (a): busy→idle, re-fired CR consumes the parked body → redelivered', async () => {
  let parked = true;
  let fireCalls = 0;
  const result = await holdAndRedeliver({
    waitForIdle: async () => ({ ready: true, reason: 'idle' }),
    isStillParked: () => parked,
    fireCR: async () => {
      fireCalls++;
      parked = false; // the CR fired the queued turn — body left the composer
      return { redelivered: true, reason: 'turn_started_working' };
    },
    maxAttempts: 3,
    now: () => 0,
  });

  assert.equal(result.status, 'redelivered');
  assert.equal(result.attempts, 1);
  assert.equal(fireCalls, 1, 'exactly one CR re-fire when the first one lands');
});

// ---------------------------------------------------------------------------
// (b) never-double-deliver — body already gone at entry: never fire a CR.
// ---------------------------------------------------------------------------

test('#617 (b): body already unparked at entry → already_consumed, CR never fired', async () => {
  let fireCalls = 0;
  const result = await holdAndRedeliver({
    waitForIdle: async () => ({ ready: true, reason: 'idle' }),
    isStillParked: () => false, // already consumed / user-submitted before we acted
    fireCR: async () => { fireCalls++; return { redelivered: true }; },
    now: () => 0,
  });

  assert.equal(result.status, 'already_consumed');
  assert.equal(result.reason, 'not_parked');
  assert.equal(fireCalls, 0, 'must never re-fire when the body is no longer parked');
});

// ---------------------------------------------------------------------------
// (c) never-double-deliver — the ending turn auto-consumed the parked body just
//     as it went idle: re-check after idle and stop without firing.
// ---------------------------------------------------------------------------

test('#617 (c): parked at entry but consumed on idle → already_consumed, CR never fired', async () => {
  let fireCalls = 0;
  let checks = 0;
  const result = await holdAndRedeliver({
    waitForIdle: async () => ({ ready: true, reason: 'idle' }),
    // first check (pre-wait) parked, second check (post-idle) unparked
    isStillParked: () => { checks++; return checks === 1; },
    fireCR: async () => { fireCalls++; return { redelivered: true }; },
    now: () => 0,
  });

  assert.equal(result.status, 'already_consumed');
  assert.equal(result.reason, 'consumed_on_idle');
  assert.equal(fireCalls, 0, 'a turn that auto-fired the queue must not get a double CR');
});

// ---------------------------------------------------------------------------
// (d) bounded — recipient never goes idle within the window → exhausted.
// ---------------------------------------------------------------------------

test('#617 (d): recipient never idles → exhausted(idle_timeout) + onExhausted signalled', async () => {
  let exhausted = null;
  const result = await holdAndRedeliver({
    waitForIdle: async () => ({ ready: false, reason: 'timeout' }),
    isStillParked: () => true,
    fireCR: async () => ({ redelivered: true }),
    onExhausted: (info) => { exhausted = info; },
    now: () => 0,
  });

  assert.equal(result.status, 'exhausted');
  assert.equal(result.reason, 'idle_timeout');
  assert.ok(exhausted, 'redeliver-exhausted must be signalled to telemetry');
});

// ---------------------------------------------------------------------------
// (e) bounded — idle+parked but the CR never consumes: cap at maxAttempts.
// ---------------------------------------------------------------------------

test('#617 (e): CR never consumes → bounded at maxAttempts, never an infinite loop', async () => {
  let fireCalls = 0;
  let exhausted = null;
  const result = await holdAndRedeliver({
    waitForIdle: async () => ({ ready: true, reason: 'idle' }),
    isStillParked: () => true,
    fireCR: async () => { fireCalls++; return { redelivered: false, reason: 'queued' }; },
    maxAttempts: 3,
    onExhausted: (info) => { exhausted = info; },
    now: () => 0,
  });

  assert.equal(result.status, 'exhausted');
  assert.equal(result.reason, 'max_attempts');
  assert.equal(result.attempts, 3);
  assert.equal(fireCalls, 3, 'CR re-fires are capped at maxAttempts');
  assert.ok(exhausted);
});

// ---------------------------------------------------------------------------
// (f) bounded — a total deadline caps wall-clock even if idle windows keep coming.
// ---------------------------------------------------------------------------

test('#617 (f): total deadline caps the redeliver lifetime', async () => {
  let clock = 0;
  const result = await holdAndRedeliver({
    // each idle wait "consumes" 400ms of the budget without ever consuming the body
    waitForIdle: async () => { clock += 400; return { ready: true, reason: 'idle' }; },
    isStillParked: () => true,
    fireCR: async () => ({ redelivered: false, reason: 'queued' }),
    maxAttempts: 100,        // not the binding cap here — the deadline is
    totalTimeoutMs: 1000,
    now: () => clock,
  });

  assert.equal(result.status, 'exhausted');
  assert.equal(result.reason, 'deadline');
  assert.ok(result.attempts < 100, 'deadline must bound attempts below maxAttempts');
});

// ---------------------------------------------------------------------------
// (g) guard — missing DI deps resolve to a no-op exhausted, never throw.
// ---------------------------------------------------------------------------

test('#617 (g): absent waitForIdle/fireCR → exhausted(no_dependencies), no throw', async () => {
  const result = await holdAndRedeliver({ now: () => 0 });
  assert.equal(result.status, 'exhausted');
  assert.equal(result.reason, 'no_dependencies');
});
