'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  awaitReplReady,
  verifyBodyConsumed,
  isReady,
  isFailed,
  READY_STATES,
  FAIL_STATES,
} = require('../src/submit-gate');

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeStateManager(initial = {}) {
  const states = new Map(Object.entries(initial));
  const listeners = [];
  return {
    states,
    listeners,
    getState(id) {
      return states.has(id) ? states.get(id) : null;
    },
    onTransition(cb) {
      listeners.push(cb);
    },
    setState(id, state, confidence = 0.95) {
      const prev = states.get(id);
      const next = { state, confidence };
      states.set(id, next);
      const fromState = prev ? prev.state : 'starting';
      for (const cb of listeners) cb(id, fromState, state, {});
    },
  };
}

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
      // Fire any timers whose time has come.
      const due = pending.filter((p) => p.at <= now);
      for (const p of due) {
        const idx = pending.indexOf(p);
        if (idx !== -1) pending.splice(idx, 1);
        p.resolve();
        // Yield so awaited code runs.
        await Promise.resolve();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// isReady / isFailed
// ---------------------------------------------------------------------------

test('READY_STATES and FAIL_STATES are disjoint', () => {
  for (const s of READY_STATES) {
    assert.equal(FAIL_STATES.has(s), false, `state ${s} appears in both sets`);
  }
});

test('isReady returns true for idle with high confidence', () => {
  assert.equal(isReady({ state: 'idle', confidence: 0.95 }, 0.85), true);
  assert.equal(isReady({ state: 'waiting', confidence: 0.9 }, 0.85), true);
});

test('isReady rejects low confidence', () => {
  assert.equal(isReady({ state: 'idle', confidence: 0.6 }, 0.85), false);
});

test('isReady rejects non-ready states regardless of confidence', () => {
  assert.equal(isReady({ state: 'working', confidence: 1.0 }, 0.85), false);
  assert.equal(isReady({ state: 'starting', confidence: 1.0 }, 0.85), false);
});

test('isFailed flags terminal/error states', () => {
  assert.equal(isFailed({ state: 'dead' }), true);
  assert.equal(isFailed({ state: 'error' }), true);
  assert.equal(isFailed({ state: 'restarting' }), true);
  assert.equal(isFailed({ state: 'idle' }), false);
});

// ---------------------------------------------------------------------------
// awaitReplReady — fast paths
// ---------------------------------------------------------------------------

test('awaitReplReady fast-paths when already idle (i: state-gated submit happy path)', async () => {
  const sm = makeStateManager({ s1: { state: 'idle', confidence: 0.95 } });
  const result = await awaitReplReady('s1', sm, { timeoutMs: 1000 });
  assert.deepEqual(
    { ready: result.ready, last_state: result.last_state },
    { ready: true, last_state: 'idle' }
  );
  assert.equal(result.waited_ms, 0);
});

test('awaitReplReady fast-paths when already waiting', async () => {
  const sm = makeStateManager({ s1: { state: 'waiting', confidence: 0.9 } });
  const result = await awaitReplReady('s1', sm, { timeoutMs: 1000 });
  assert.equal(result.ready, true);
  assert.equal(result.last_state, 'waiting');
});

test('awaitReplReady returns reason=session_dead immediately for dead session', async () => {
  const sm = makeStateManager({ s1: { state: 'dead', confidence: 1.0 } });
  const result = await awaitReplReady('s1', sm, { timeoutMs: 1000 });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'session_dead');
});

test('awaitReplReady returns reason=no_state for unknown session', async () => {
  const sm = makeStateManager();
  const result = await awaitReplReady('missing', sm, { timeoutMs: 1000 });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'no_state');
});

test('awaitReplReady returns reason=no_state_manager when manager missing', async () => {
  const result = await awaitReplReady('s1', null, { timeoutMs: 1000 });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'no_state_manager');
});

// ---------------------------------------------------------------------------
// awaitReplReady — transition path
// ---------------------------------------------------------------------------

test('awaitReplReady resolves on transition working → idle', async () => {
  const sm = makeStateManager({ s1: { state: 'working', confidence: 0.9 } });
  const promise = awaitReplReady('s1', sm, { timeoutMs: 1000 });
  // Immediate transition; waited_ms should be tiny.
  setImmediate(() => sm.setState('s1', 'idle', 0.95));
  const result = await promise;
  assert.equal(result.ready, true);
  assert.equal(result.last_state, 'idle');
  assert.ok(result.waited_ms < 200, `waited_ms ${result.waited_ms} unexpectedly large`);
});

test('awaitReplReady ignores transitions for other sessions', async () => {
  const sm = makeStateManager({
    s1: { state: 'working', confidence: 0.9 },
    s2: { state: 'working', confidence: 0.9 },
  });
  const promise = awaitReplReady('s1', sm, { timeoutMs: 200 });
  // Other session reaches idle; should NOT settle s1.
  setImmediate(() => sm.setState('s2', 'idle', 0.95));
  const result = await promise;
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'timeout');
});

test('awaitReplReady times out (iii: bounded retry exhaustion → fallback)', async () => {
  const sm = makeStateManager({ s1: { state: 'working', confidence: 0.9 } });
  const t0 = Date.now();
  const result = await awaitReplReady('s1', sm, { timeoutMs: 80 });
  const elapsed = Date.now() - t0;
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'timeout');
  assert.equal(result.last_state, 'working');
  assert.ok(elapsed >= 70, `expected ≥70ms elapsed, got ${elapsed}`);
});

test('awaitReplReady resolves to fail when transitioning to dead mid-wait', async () => {
  const sm = makeStateManager({ s1: { state: 'working', confidence: 0.9 } });
  const promise = awaitReplReady('s1', sm, { timeoutMs: 1000 });
  setImmediate(() => sm.setState('s1', 'dead', 1.0));
  const result = await promise;
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'session_dead');
});

test('awaitReplReady rejects ready transition with low confidence and falls through to timeout', async () => {
  const sm = makeStateManager({ s1: { state: 'working', confidence: 0.9 } });
  const promise = awaitReplReady('s1', sm, { timeoutMs: 80, minConfidence: 0.85 });
  // idle but with low confidence — should NOT settle.
  setImmediate(() => sm.setState('s1', 'idle', 0.6));
  const result = await promise;
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'timeout');
});

// ---------------------------------------------------------------------------
// verifyBodyConsumed — happy path + edge cases
// ---------------------------------------------------------------------------

test('verifyBodyConsumed returns consumed=true when body never visible (ii: optimistic)', async () => {
  const session = { outputRing: ['some shell prompt $\n'] };
  const result = await verifyBodyConsumed(session, 'unrelated body', { timeoutMs: 50, intervalMs: 10 });
  assert.equal(result.consumed, true);
  assert.equal(result.reason, 'never_visible');
});

test('verifyBodyConsumed returns consumed=true when body disappears (ii: happy path)', async () => {
  const session = { outputRing: ['> hello world\n'] };
  const promise = verifyBodyConsumed(session, 'hello world', { timeoutMs: 500, intervalMs: 20 });
  // Simulate Enter consuming the body — input box clears, prompt re-renders.
  setTimeout(() => {
    session.outputRing.push('\n> ');
    // Drop the original entry to simulate the screen "scrolling away" or
    // the input line being cleared. Push a long blank tail to be safe.
    session.outputRing[0] = '\n\n\n';
  }, 30);
  const result = await promise;
  assert.equal(result.consumed, true);
  // Could be 'consumed' (everSeen first) or 'never_visible' depending on race;
  // we accept either — what matters is consumed===true.
  assert.ok(['consumed', 'never_visible'].includes(result.reason));
});

test('verifyBodyConsumed returns still_visible on timeout', async () => {
  const session = { outputRing: ['> stuck body still here'] };
  const result = await verifyBodyConsumed(session, 'stuck body', { timeoutMs: 60, intervalMs: 15 });
  assert.equal(result.consumed, false);
  assert.equal(result.reason, 'still_visible');
});

test('verifyBodyConsumed handles empty body as consumed', async () => {
  const session = { outputRing: ['some output'] };
  const result = await verifyBodyConsumed(session, '', { timeoutMs: 50 });
  assert.equal(result.consumed, true);
  assert.equal(result.reason, 'empty_body');
});

test('verifyBodyConsumed handles missing outputRing gracefully', async () => {
  const session = {};
  const result = await verifyBodyConsumed(session, 'something', { timeoutMs: 50 });
  assert.equal(result.consumed, false);
  assert.equal(result.reason, 'no_ring');
});

test('verifyBodyConsumed normalizes whitespace when matching', async () => {
  // Body has multi-line whitespace; outputRing has same body collapsed.
  const session = { outputRing: ['> some\n  body\ntext'] };
  const result = await verifyBodyConsumed(session, 'some  body  text', { timeoutMs: 60, intervalMs: 15 });
  assert.equal(result.consumed, false);
  assert.equal(result.reason, 'still_visible');
});

test('verifyBodyConsumed strips ANSI before matching when stripAnsi provided', async () => {
  const session = { outputRing: ['\x1b[1m> hello\x1b[0m world'] };
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  const result = await verifyBodyConsumed(session, 'hello world', {
    timeoutMs: 60,
    intervalMs: 15,
    stripAnsi,
  });
  assert.equal(result.consumed, false);
  assert.equal(result.reason, 'still_visible');
});

test('verifyBodyConsumed honors injectable now/sleep for deterministic timing (iv: 504 path test surface)', async () => {
  const clock = makeFakeClock();
  const session = { outputRing: ['> stuck body still here'] };
  const promise = verifyBodyConsumed(session, 'stuck body', {
    timeoutMs: 100,
    intervalMs: 20,
    now: clock.now,
    sleep: clock.sleep,
  });
  // Advance past the timeout in chunks; body never disappears.
  await clock.advance(20);
  await clock.advance(40);
  await clock.advance(40);
  await clock.advance(40); // exceed timeout
  const result = await promise;
  assert.equal(result.consumed, false);
  assert.equal(result.reason, 'still_visible');
  assert.ok(result.waited_ms >= 100);
});
