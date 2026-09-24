'use strict';

// ---------------------------------------------------------------------------
// SEAM: FAKE. This file is the ONLY place a stub stands in for the parser.
// ---------------------------------------------------------------------------
//
// Dispatch: "Fake constructor allowed ONLY failure/timing controls explicitly separated from
// actual parser tests." Nothing here asserts parsed screen CONTENT. Every case is either
//   (a) a failure a real, correct parser cannot be asked to produce on demand
//       (construct/write/resize/buffer throwing), or
//   (b) a callback-timing control (a write that never completes, a callback delivered late or
//       twice, a generation rotated with a write in flight).
//
// All grid/parser/width/split/alt-screen behaviour lives in the ACTUAL-seam files:
//   vt-frame-grid.test.js, vt-split-order.test.js, vt-generation-continuity.test.js,
//   vt-bounds.test.js, vt-reply-security.test.js.

const test = require('node:test');
const assert = require('node:assert');

const H = require('./helpers/vt-harness');

const vt = H.loadVt();

/** A minimal Terminal stand-in with explicit, per-instance failure and timing controls. */
class FakeTerminal {
  constructor(options) {
    this.options = options;
    this.cols = options.cols;
    this.rows = options.rows;
    this.pending = [];           // held write callbacks — the timing control
    this.written = [];
    this.resizes = [];
    this.disposed = false;
    this.failWrite = FakeTerminal.failWrite;
    this.failResize = FakeTerminal.failResize;
    this.failBuffer = FakeTerminal.failBuffer;
    this.autoComplete = FakeTerminal.autoComplete !== false;
    FakeTerminal.instances.push(this);
  }

  get buffer() {
    if (this.failBuffer) throw new Error('fake buffer failure');
    const self = this;
    return {
      active: {
        type: 'normal',
        baseY: 0,
        cursorX: 0,
        cursorY: 0,
        length: self.rows,
        getLine: () => ({ translateToString: () => '' }),
      },
    };
  }

  write(data, cb) {
    if (this.failWrite) throw new Error('fake write failure');
    this.written.push(data);
    if (this.autoComplete) setImmediate(cb);
    else this.pending.push(cb);
  }

  resize(cols, rows) {
    if (this.failResize) throw new Error('fake resize failure');
    this.resizes.push({ cols, rows });
    this.cols = cols;
    this.rows = rows;
  }

  dispose() { this.disposed = true; }

  /** Timing control: complete the Nth in-flight write. */
  complete(index = 0) {
    const cb = this.pending[index];
    assert.ok(cb, `no pending write at index ${index}`);
    cb();
  }
}

function resetFake() {
  FakeTerminal.instances = [];
  FakeTerminal.failWrite = false;
  FakeTerminal.failResize = false;
  FakeTerminal.failBuffer = false;
  FakeTerminal.autoComplete = true;
}
resetFake();

function fakeScreen(overrides = {}) {
  resetFake();
  Object.assign(FakeTerminal, overrides.fakeFlags || {});
  return new vt.SessionScreen({
    sessionId: overrides.sessionId || 'fake',
    cause: 'stream_origin',
    localSource: true,
    geometrySource: 'local_pty',
    cols: 20,
    rows: 4,
    terminalFactory: FakeTerminal,
    ...overrides.screen,
  });
}

// ---------------------------------------------------------------------------
// (a) Failure injection
// ---------------------------------------------------------------------------

test('FAILURE: a missing @xterm/headless degrades to `unavailable`, it does not crash', async (t) => {
  // The rollout order puts the bridge before the daemon, so the module MUST load and degrade in
  // an environment where the dependency is absent. This is the coder REPORT §8 "unmeasured"
  // degradation path — measured here.
  vt.__setTerminalCtorForTest(null);
  t.after(() => vt.__setTerminalCtorForTest(undefined));   // restore the real lazy require

  const screen = new vt.SessionScreen({
    sessionId: 'no-lib',
    cause: 'stream_origin',
    localSource: true,
    geometrySource: 'local_pty',
    cols: 20,
    rows: 4,
  });
  assert.doesNotThrow(() => screen.noteOutput('output while the library is absent'));
  assert.doesNotThrow(() => screen.noteGeometry({ cols: 30, rows: 5, atUnits: null, source: 'local_pty' }));

  const frame = await H.keepAlive(() => screen.readFrame({ drainWaitMs: 50 }));
  H.assertReason(frame, 'vt_library_unavailable');
  assert.strictEqual(frame.observation_basis, 'unavailable');
  assert.deepStrictEqual(frame.rows_text, []);
  assert.notStrictEqual(frame.freshness, 'current');
  // MEASURED, and deliberately asserted rather than assumed: `completeness` stays 'complete'
  // here. It describes the STREAM's provenance (origin-0, geometry known first, nothing lost),
  // which all still holds -- the units are pending, not lost. The honest top-level answer is
  // carried by `observation_basis: 'unavailable'`, which is what §9 tells consumers to key off.
  // Recorded in REPORT.md as observation O-1; a consumer reading `completeness` ALONE would be
  // misled, so this pins the field combination rather than leaving it undocumented.
  assert.strictEqual(frame.completeness, 'complete');
  assert.ok(frame.degraded_reasons.length > 0, 'the reason is always stated');
  // The units are still honestly accounted as observed-but-not-applied.
  assert.ok(frame.observed_units > 0);
  assert.strictEqual(frame.applied_units, 0);
  assert.strictEqual(frame.lag_units, frame.observed_units);
  screen.dispose();
});

test('FAILURE: the real lazy require is restored after the absent-library case', async () => {
  // Guards the test seam itself: a leaked null cache would silently turn every later ACTUAL-seam
  // test into a fake-library test.
  const screen = new vt.SessionScreen({
    sessionId: 'lib-restored',
    cause: 'stream_origin',
    localSource: true,
    geometrySource: 'local_pty',
    cols: 20,
    rows: 2,
  });
  screen.noteOutput('real');
  const frame = await H.frameAfterDrain(screen);
  assert.strictEqual(frame.rows_text[0], 'real');
  assert.strictEqual(frame.observation_basis, 'vt_grid');
  screen.dispose();
});

test('FAILURE: a Terminal constructor that throws degrades to `unavailable`', async () => {
  const Exploding = function Exploding() { throw new Error('fake construct failure'); };
  const screen = new vt.SessionScreen({
    sessionId: 'ctor-fail',
    cause: 'stream_origin',
    localSource: true,
    geometrySource: 'local_pty',
    cols: 20,
    rows: 4,
    terminalFactory: Exploding,
  });
  screen.noteOutput('x');
  const frame = await H.keepAlive(() => screen.readFrame({ drainWaitMs: 50 }));

  H.assertReason(frame, 'vt_construct_failed');
  assert.strictEqual(frame.observation_basis, 'unavailable');
  assert.notStrictEqual(frame.freshness, 'current');
  assert.strictEqual(frame.rows_text.length, 0);
  screen.dispose();
});

test('FAILURE: a write() that throws counts the chunk as LOST and says why', async () => {
  const screen = fakeScreen({ sessionId: 'write-fail', fakeFlags: { failWrite: true } });
  screen.noteOutput('twelve chars');
  const frame = await H.keepAlive(() => screen.readFrame({ drainWaitMs: 50 }));

  H.assertReason(frame, 'vt_write_failed');
  assert.strictEqual(frame.completeness, 'partial_after_loss', 'a failed write is real loss');
  assert.strictEqual(frame.dropped_units, 12);
  assert.strictEqual(frame.observation_basis, 'vt_grid_degraded');
  screen.dispose();
  resetFake();
});

test('FAILURE: a resize() that throws leaves geometry unverified, not silently applied', async () => {
  const screen = fakeScreen({ sessionId: 'resize-fail' });
  screen.noteOutput('x');
  await H.frameAfterDrain(screen);

  FakeTerminal.instances[0].failResize = true;
  screen.noteGeometry({ cols: 90, rows: 30, atUnits: null, source: 'local_pty' });
  const frame = await H.frameAfterDrain(screen);

  H.assertReason(frame, 'vt_resize_failed');
  assert.strictEqual(frame.geometry_source, 'unverified');
  assert.strictEqual(frame.observation_basis, 'vt_grid_degraded');
  screen.dispose();
  resetFake();
});

test('FAILURE: a buffer read that throws at snapshot time is reported, not propagated', async () => {
  const screen = fakeScreen({ sessionId: 'snapshot-fail' });
  screen.noteOutput('x');
  await H.frameAfterDrain(screen);

  FakeTerminal.instances[0].failBuffer = true;
  const frame = await H.frameAfterDrain(screen);

  H.assertReason(frame, 'snapshot_failed');
  assert.deepStrictEqual(frame.rows_text, []);
  assert.strictEqual(frame.cursor, null);
  assert.strictEqual(frame.observation_basis, 'vt_grid_degraded');
  screen.dispose();
  resetFake();
});

test('FAILURE: a buffer read that throws during the CELL AUDIT is reported, not fatal', async () => {
  const interval = vt.VT_LIMITS.VT_CELL_AUDIT_INTERVAL_UNITS;
  const screen = fakeScreen({ sessionId: 'audit-fail' });
  screen.noteOutput('x');
  await H.frameAfterDrain(screen);
  FakeTerminal.instances[0].failBuffer = true;

  // Push past the audit interval so `_auditCellGrowth` runs.
  screen.noteOutput('a'.repeat(interval));
  const frame = await H.frameAfterDrain(screen);

  H.assertReason(frame, 'cell_audit_failed');
  // Failing to MEASURE growth is not the same as measuring a breach: the generation keeps going,
  // degraded, rather than being stopped on an unproven basis.
  H.assertNoReason(frame, 'cell_growth_bound_exceeded');
  screen.dispose();
  resetFake();
});

test('FAILURE: a dispose() that throws does not propagate', () => {
  const Throwing = class {
    constructor(o) { this.cols = o.cols; this.rows = o.rows; }

    get buffer() { return { active: { type: 'normal', baseY: 0, cursorX: 0, cursorY: 0, getLine: () => null } }; }

    write(d, cb) { setImmediate(cb); }

    resize() {}

    dispose() { throw new Error('fake dispose failure'); }
  };
  const screen = new vt.SessionScreen({
    sessionId: 'dispose-fail',
    cause: 'stream_origin',
    localSource: true,
    geometrySource: 'local_pty',
    cols: 10,
    rows: 2,
    terminalFactory: Throwing,
  });
  assert.doesNotThrow(() => screen.dispose());
  assert.strictEqual(screen.readFrameSync().observation_basis, 'unavailable');
});

// ---------------------------------------------------------------------------
// (b) Timing / callback-ordering controls
// ---------------------------------------------------------------------------

test('TIMING: a write that never completes yields `lagging` with the MEASURED lag, bounded', async () => {
  const screen = fakeScreen({ sessionId: 'never-drains', fakeFlags: { autoComplete: false } });
  screen.noteOutput('0123456789');

  const t0 = Date.now();
  const frame = await H.keepAlive(() => screen.readFrame({ drainWaitMs: 120 }));
  const elapsed = Date.now() - t0;

  assert.ok(elapsed >= 100, `the read really waited (${elapsed} ms)`);
  assert.ok(elapsed < 1500, `and it returned anyway (${elapsed} ms) — never blocks indefinitely`);
  assert.strictEqual(frame.freshness, 'lagging');
  assert.strictEqual(frame.observed_units, 10);
  assert.strictEqual(frame.applied_units, 0);
  assert.strictEqual(frame.lag_units, 10, 'lag_units = observed - applied, measured not guessed');
  assert.strictEqual(frame.observation_basis, 'vt_grid_degraded');
  screen.dispose();
  resetFake();
});

test('TIMING: the drain wait is hard-clamped to VT_DRAIN_WAIT_MAX_MS even when asked for more', async () => {
  const screen = fakeScreen({ sessionId: 'clamp', fakeFlags: { autoComplete: false } });
  screen.noteOutput('x');

  const t0 = Date.now();
  const frame = await H.keepAlive(() => screen.readFrame({ drainWaitMs: 30000 }));
  const elapsed = Date.now() - t0;

  assert.ok(elapsed < 2000,
    `a 30 s request must be clamped to ${vt.VT_LIMITS.VT_DRAIN_WAIT_MAX_MS} ms; waited ${elapsed} ms`);
  assert.ok(elapsed >= 900, `and it did use the clamped maximum (${elapsed} ms)`);
  assert.strictEqual(frame.freshness, 'lagging');
  screen.dispose();
  resetFake();
});

test('TIMING: a negative or non-numeric drain wait falls back to the default, never to forever', async () => {
  for (const bad of [-5, 'soon', NaN, undefined]) {
    const screen = fakeScreen({ sessionId: 'clamp-bad', fakeFlags: { autoComplete: false } });
    screen.noteOutput('x');
    const t0 = Date.now();
    // eslint-disable-next-line no-await-in-loop
    const frame = await H.keepAlive(() => screen.readFrame({ drainWaitMs: bad }));
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1500, `drainWaitMs=${String(bad)} must not wait forever (${elapsed} ms)`);
    assert.strictEqual(frame.freshness, 'lagging');
    screen.dispose();
    resetFake();
  }
});

test('TIMING: a duplicated/late write callback can never REGRESS applied_units', async () => {
  const screen = fakeScreen({ sessionId: 'no-regress', fakeFlags: { autoComplete: false } });
  screen.noteOutput('aaaa');          // dispatched immediately, callback held
  screen.noteOutput('bbbbbb');        // queued behind it

  const term = FakeTerminal.instances[0];
  assert.deepStrictEqual(term.written, ['aaaa']);

  term.complete(0);                   // ack write #1 -> applied 4, write #2 dispatched
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(term.written, ['aaaa', 'bbbbbb']);

  term.complete(1);                   // ack write #2 -> applied 10
  await new Promise((r) => setImmediate(r));
  let frame = screen.readFrameSync();
  assert.strictEqual(frame.applied_units, 10);

  // Now deliver the FIRST callback again, out of order and late. `max(applied, watermark)` must
  // hold the line: 4 must not overwrite 10.
  term.complete(0);
  await new Promise((r) => setImmediate(r));
  frame = screen.readFrameSync();
  assert.strictEqual(frame.applied_units, 10, 'an out-of-order callback cannot regress the watermark');
  assert.strictEqual(frame.lag_units, 0);
  screen.dispose();
  resetFake();
});

test('TIMING: a callback from a SUPERSEDED generation updates nothing (generation fencing)', async () => {
  const screen = fakeScreen({ sessionId: 'fencing', fakeFlags: { autoComplete: false } });
  screen.noteOutput('old-units');           // in flight, callback held
  const oldTerm = FakeTerminal.instances[0];

  screen.newGeneration('owner_replaced', { cols: 20, rows: 4, geometrySource: 'bridge_reported' });
  screen.noteOutput('new');                 // in flight in the NEW generation
  const newTerm = FakeTerminal.instances[1];
  assert.notStrictEqual(oldTerm, newTerm);
  assert.strictEqual(oldTerm.disposed, true, 'the superseded terminal was disposed');

  // The dead generation's callback arrives late. It must change nothing.
  oldTerm.complete(0);
  await new Promise((r) => setImmediate(r));

  let frame = screen.readFrameSync();
  assert.strictEqual(frame.generation_cause, 'owner_replaced');
  assert.strictEqual(frame.observed_units, 3, 'only the live generation`s units are counted');
  assert.strictEqual(frame.applied_units, 0, 'the stale callback did not advance the live watermark');

  newTerm.complete(0);
  await new Promise((r) => setImmediate(r));
  frame = screen.readFrameSync();
  assert.strictEqual(frame.applied_units, 3);
  assert.strictEqual(frame.freshness, 'current');
  screen.dispose();
  resetFake();
});

test('TIMING: a callback arriving after dispose() updates nothing and does not throw', async () => {
  const screen = fakeScreen({ sessionId: 'post-dispose', fakeFlags: { autoComplete: false } });
  screen.noteOutput('inflight');
  const term = FakeTerminal.instances[0];

  screen.dispose();
  assert.doesNotThrow(() => term.complete(0), 'a late callback must not throw into the runtime');

  const frame = screen.readFrameSync();
  assert.strictEqual(frame.observation_basis, 'unavailable');
  H.assertReason(frame, 'vt_disposed');
  assert.strictEqual(frame.applied_units, 0);
  resetFake();
});

test('TIMING: a read that finds the queue already drained does not wait at all', async () => {
  const screen = fakeScreen({ sessionId: 'no-wait' });
  screen.noteOutput('x');
  await H.frameAfterDrain(screen);

  const t0 = Date.now();
  const frame = await H.keepAlive(() => screen.readFrame({ drainWaitMs: 1000 }));
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 50, `an already-drained queue returns immediately (${elapsed} ms)`);
  assert.strictEqual(frame.freshness, 'current');
  screen.dispose();
  resetFake();
});
