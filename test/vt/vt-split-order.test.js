'use strict';

// G-SPLIT — chunk-boundary reassembly by the REAL parser.
// G-ORDER — one FIFO for output AND resize; a resize lands at its stream boundary.
//
// Contract §4 ("only chunk-boundary splits are reassembled, and only that is tested"),
// §7 (single ordering authority).
//
// Terminal: REAL @xterm/headless 6.0.0 (seam ACTUAL). Callback-ORDERING pathologies that a real
// parser cannot be made to exhibit on demand live in vt-failure-timing.test.js (seam FAKE).

const test = require('node:test');
const assert = require('node:assert');

const H = require('./helpers/vt-harness');
const { ANSI } = H;

const vt = H.loadVt();

function localScreen(cols, rows, sessionId = 'g-split') {
  return H.makeScreen(vt, {
    sessionId, cause: 'stream_origin', localSource: true, geometrySource: 'local_pty', cols, rows,
  });
}

// ---------------------------------------------------------------------------
// G-SPLIT
// ---------------------------------------------------------------------------
//
// Each case calls noteOutput twice SYNCHRONOUSLY. The module dispatches the first op to
// `write()` immediately and marks the generation `writing`, so the second op cannot be coalesced
// into that write — it becomes a separate `write()`. The parser therefore really does see the
// sequence severed at the frame boundary, which is what G-SPLIT is about. The first sub-test
// asserts that seam explicitly rather than assuming it.

test('G-SPLIT/seam: two synchronous noteOutput calls reach the parser as two separate writes', async () => {
  const record = {};
  const screen = H.makeScreen(vt, {
    sessionId: 'g-split-seam',
    cause: 'stream_origin',
    localSource: true,
    geometrySource: 'local_pty',
    cols: 20,
    rows: 2,
    terminalFactory: H.instrumentedTerminalCtor(record),   // seam ACTUAL+ : real parser, recorded
  });

  screen.noteOutput('\u001b[');
  screen.noteOutput('2J');
  await H.frameAfterDrain(screen);

  assert.deepStrictEqual(record.writes, ['\u001b[', '2J'],
    'the escape sequence genuinely crossed a write boundary — not pre-joined by the harness');
  screen.dispose();
});

test('G-SPLIT: an ESC sequence split across two frames still executes', async () => {
  const screen = localScreen(24, 3);
  screen.noteOutput('stale banner text');
  await H.frameAfterDrain(screen);

  // ESC [ 2 J split between "ESC[" and "2J".
  screen.noteOutput(`${ANSI.HOME}\u001b[`);
  screen.noteOutput('2Jclean');
  const frame = await H.frameAfterDrain(screen);

  assert.strictEqual(frame.rows_text[0], 'clean');
  assert.ok(!H.screenText(frame).includes('stale banner'),
    'the split ED(2) really cleared the screen; it was not leaked as literal text');
  screen.dispose();
});

test('G-SPLIT: a CUP sequence split mid-parameter still addresses the right cell', async () => {
  const screen = localScreen(20, 4);
  screen.noteOutput('\u001b[3;');    // half of CUP(3,5)
  screen.noteOutput('5HX');
  const frame = await H.frameAfterDrain(screen);
  assert.strictEqual(frame.rows_text[2], '    X');
  assert.deepStrictEqual(frame.cursor, { x: 5, y: 2 });
  screen.dispose();
});

test('G-SPLIT: a surrogate pair split across two frames reassembles into one code point', async () => {
  const screen = localScreen(20, 2);
  const emoji = '\u{1F600}';
  screen.noteOutput(emoji[0]);       // lone high surrogate \uD83D
  screen.noteOutput(emoji[1]);       // lone low surrogate  \uDE00
  const frame = await H.frameAfterDrain(screen);

  assert.strictEqual(frame.rows_text[0], emoji, 'the pair was rejoined, not rendered as two U+FFFD');
  assert.strictEqual(frame.observed_units, 2, 'both halves counted as UTF-16 units');
  assert.strictEqual(frame.applied_units, 2);
  screen.dispose();
});

test('G-SPLIT: a combining mark split from its base still attaches to the same cell', async () => {
  const screen = localScreen(20, 2);
  // Explicit escapes: a literal decomposed sequence in a source file is a normalization hazard.
  screen.noteOutput('\u0065');
  screen.noteOutput('\u0301');       // COMBINING ACUTE, arriving in the next frame
  const frame = await H.frameAfterDrain(screen);

  assert.strictEqual(frame.rows_text[0], '\u0065\u0301');
  assert.deepStrictEqual(frame.cursor, { x: 1, y: 0 }, 'still ONE cell');
  screen.dispose();
});

test('G-SPLIT: a wide (CJK) character split across two frames is not duplicated or dropped', async () => {
  const screen = localScreen(20, 2);
  screen.noteOutput('ab');
  screen.noteOutput('가나');
  const frame = await H.frameAfterDrain(screen);
  assert.strictEqual(frame.rows_text[0], 'ab가나');
  assert.deepStrictEqual(frame.cursor, { x: 6, y: 0 });
  screen.dispose();
});

test('G-SPLIT: an OSC sequence split across frames is consumed, never leaked as text', async () => {
  const screen = localScreen(30, 2);
  screen.noteOutput('\u001b]0;some-ti');
  screen.noteOutput('tle\u0007visible');
  const frame = await H.frameAfterDrain(screen);

  assert.strictEqual(frame.rows_text[0], 'visible');
  assert.ok(!H.screenText(frame).includes('some-title'),
    'the OSC payload was parsed as a control, not printed into the grid');
  screen.dispose();
});

test('G-SPLIT: a sequence split into ONE code unit per frame still executes', async () => {
  const screen = localScreen(20, 3);
  screen.noteOutput('dirty');
  await H.frameAfterDrain(screen);

  for (const unit of `${ANSI.HOME}${ANSI.ED(2)}ok`) screen.noteOutput(unit);
  const frame = await H.frameAfterDrain(screen);

  assert.strictEqual(frame.rows_text[0], 'ok');
  assert.ok(!H.screenText(frame).includes('dirty'));
  screen.dispose();
});

// ---------------------------------------------------------------------------
// G-ORDER — the resize applies at its boundary, not on arrival
// ---------------------------------------------------------------------------

test('G-ORDER: a resize enqueued between two output chunks applies BETWEEN them', async () => {
  // Bridge-fed generation, so the boundary is cross-checked against `at_units` (§7).
  const screen = H.makeScreen(vt, {
    sessionId: 'g-order', cause: 'stream_origin', streamId: 'sid-order',
  });

  const chunk1 = `${ANSI.HOME}${ANSI.ED(2)}${'A'.repeat(15)}`;   // at cols=10 this wraps 10 + 5
  const chunk2 = `${ANSI.CUP(5, 1)}${'B'.repeat(25)}`;           // 25 B's on row 5

  screen.noteGeometry({ cols: 10, rows: 6, streamId: 'sid-order', atUnits: 0, source: 'bridge_reported' });
  screen.noteOutput(chunk1, { stream_id: 'sid-order', stream_offset: 0 });
  screen.noteGeometry({
    cols: 40, rows: 6, streamId: 'sid-order', atUnits: chunk1.length, source: 'bridge_reported',
  });
  screen.noteOutput(chunk2, { stream_id: 'sid-order', stream_offset: chunk1.length });

  const frame = await H.frameAfterDrain(screen);

  assert.strictEqual(frame.cols, 40);
  assert.strictEqual(frame.rows, 6);
  // If the resize had landed AFTER chunk2, chunk2 would have been laid out at cols=10 and the
  // 25 B's would occupy three wrapped rows. It landed at its boundary, so they are on one row.
  assert.strictEqual(frame.rows_text[4], 'B'.repeat(25),
    '25 B\'s on ONE row => the resize to 40 cols was applied before chunk2 was parsed');
  assert.strictEqual(frame.rows_text[5], '');
  assert.strictEqual(frame.geometry_source, 'bridge_reported');
  screen.dispose();
});

test('G-ORDER/seam: the real Terminal saw resize() strictly between the two writes', async () => {
  const record = {};
  const screen = H.makeScreen(vt, {
    sessionId: 'g-order-seam',
    cause: 'stream_origin',
    streamId: 'sid',
    terminalFactory: H.instrumentedTerminalCtor(record),   // real parser, calls recorded
  });

  screen.noteGeometry({ cols: 10, rows: 4, streamId: 'sid', atUnits: 0, source: 'bridge_reported' });
  screen.noteOutput('first', { stream_id: 'sid', stream_offset: 0 });
  screen.noteGeometry({ cols: 30, rows: 4, streamId: 'sid', atUnits: 5, source: 'bridge_reported' });
  screen.noteOutput('second', { stream_id: 'sid', stream_offset: 5 });
  await H.frameAfterDrain(screen);

  assert.deepStrictEqual(record.writes, ['first', 'second']);
  const resizeTo30 = record.resizes.filter((r) => r.cols === 30);
  assert.strictEqual(resizeTo30.length, 1);
  assert.strictEqual(resizeTo30[0].afterWrites, 1,
    'resize(30,..) was issued after exactly one write — between the two chunks, not on arrival');
  screen.dispose();
});

test('G-ORDER: output ops are coalesced only up to the next non-output op', async () => {
  const record = {};
  const screen = H.makeScreen(vt, {
    sessionId: 'g-order-coalesce',
    cause: 'stream_origin',
    streamId: 'sid',
    terminalFactory: H.instrumentedTerminalCtor(record),
  });

  screen.noteGeometry({ cols: 20, rows: 4, streamId: 'sid', atUnits: 0, source: 'bridge_reported' });
  // Enqueue behind the first in-flight write: a,b then a resize boundary then c,d.
  screen.noteOutput('a', { stream_id: 'sid', stream_offset: 0 });
  screen.noteOutput('b', { stream_id: 'sid', stream_offset: 1 });
  screen.noteOutput('c', { stream_id: 'sid', stream_offset: 2 });
  screen.noteGeometry({ cols: 30, rows: 4, streamId: 'sid', atUnits: 3, source: 'bridge_reported' });
  screen.noteOutput('d', { stream_id: 'sid', stream_offset: 3 });
  screen.noteOutput('e', { stream_id: 'sid', stream_offset: 4 });
  await H.frameAfterDrain(screen);

  // 'a' went out alone (it triggered the first write); 'b','c' coalesced up to the boundary;
  // 'd','e' coalesced after it. What matters is that NO write spans the resize boundary.
  assert.ok(record.writes.every((w) => !(w.includes('c') && w.includes('d'))),
    `no write may span the resize boundary; writes were ${JSON.stringify(record.writes)}`);
  assert.strictEqual(record.writes.join(''), 'abcde', 'nothing lost or reordered');
  const boundary = record.resizes.find((r) => r.cols === 30);
  assert.strictEqual(record.writes.slice(0, boundary.afterWrites).join(''), 'abc',
    'exactly a,b,c were parsed before the resize');
  screen.dispose();
});

test('G-ORDER: a resize whose at_units misses the queue boundary applies NOTHING and degrades', async () => {
  const screen = H.makeScreen(vt, {
    sessionId: 'g-order-mismatch', cause: 'stream_origin', streamId: 'sid',
  });

  screen.noteGeometry({ cols: 20, rows: 4, streamId: 'sid', atUnits: 0, source: 'bridge_reported' });
  screen.noteOutput('hello', { stream_id: 'sid', stream_offset: 0 });
  // The producer claims it resized at unit 999; this queue is at unit 5.
  screen.noteGeometry({ cols: 60, rows: 8, streamId: 'sid', atUnits: 999, source: 'bridge_reported' });
  const frame = await H.frameAfterDrain(screen);

  assert.strictEqual(frame.cols, 20, 'the VT kept its last VALID geometry');
  assert.strictEqual(frame.rows, 4);
  assert.strictEqual(frame.geometry_source, 'unverified');
  H.assertReason(frame, 'geometry_boundary_mismatch');
  assert.strictEqual(frame.observation_basis, 'vt_grid_degraded');
  screen.dispose();
});

// --- foreign-stream_id geometry ----------------------------------------------------------------
//
// vg1136am DELTA-1 (declared). Two changes to what the vt1136ak suite did here:
//
//   (a) The contract §7 assertion below is an ORDINARY HARD FAILURE. It carries no `todo` and no
//       `skip`. A violation of the governing contract is a failing test; encoding it as `todo`
//       made the suite exit 0 while acceptance was in fact blocked, which is the defect this
//       phase exists to repair. The suite must report red until §7 is satisfied or amended.
//
//   (b) The vt1136ak test that pinned the OBSERVED rotation (`cols === 77`, grid destroyed) is
//       retained but REHOMED as a BASELINE OBSERVATION. It is explicitly NOT an oracle for the
//       candidate: nothing here requires a corrected module to keep rotating. It therefore
//       asserts only what must hold under EITHER resolution of F2 — the pre-state, and the one
//       invariant the rotation did preserve (no completeness is manufactured) — and it RECORDS,
//       without requiring, which of the two behaviours the tree under test exhibits.
//       Pinning observed-bad behaviour as a required expectation would make the suite enforce
//       the defect; that is what is being corrected.

async function foreignGeometryScreen() {
  const screen = H.makeScreen(vt, {
    sessionId: 'g-order-foreign', cause: 'stream_origin', streamId: 'sid-A',
  });
  screen.noteGeometry({ cols: 20, rows: 4, streamId: 'sid-A', atUnits: 0, source: 'bridge_reported' });
  screen.noteOutput('ALPHA', { stream_id: 'sid-A', stream_offset: 0 });
  const before = await H.frameAfterDrain(screen);

  // A geometry op naming a stream this generation is NOT observing.
  screen.noteGeometry({ cols: 77, rows: 9, streamId: 'sid-B', atUnits: 0, source: 'bridge_reported' });
  const after = await H.frameAfterDrain(screen);
  return { screen, before, after };
}

test('BASELINE OBSERVATION (not a candidate oracle): what this tree does with foreign-stream_id geometry', async () => {
  const { screen, before, after } = await foreignGeometryScreen();
  try {
    // --- pre-state: required under either resolution of F2 -------------------------------------
    assert.strictEqual(before.cols, 20);
    assert.strictEqual(before.rows_text[0], 'ALPHA');

    // --- the invariant that must hold whichever way F2 is resolved -----------------------------
    // vg1136am ORACLE-CORRECTION item 4 (controller-specified): "preserving alreadycomplete sidA
    // is NOT manufacturing a newcomplete origin ... Baseline badbehavior must be recorded only,
    // not enforced as candidate oracle."
    //
    // So the enforced invariant is narrow and holds under both resolutions: a foreign geometry op
    // may never mint a NEW qualified generation. If it rotates, the generation it created must not
    // be complete. If it is discarded, the pre-existing generation keeps exactly what it had
    // already earned — that is preservation, not manufacture.
    const rotatedGen = after.vt_generation !== before.vt_generation;
    if (rotatedGen) {
      assert.notStrictEqual(after.completeness, 'complete',
        'a generation created BY a foreign geometry op may never be complete');
    } else {
      assert.strictEqual(after.completeness, before.completeness,
        'a discarded foreign geometry op may not change the active generation\'s completeness');
      assert.strictEqual(after.rows_text[0], before.rows_text[0],
        'nor may it alter the observed grid');
    }

    // --- recorded, NOT required ---------------------------------------------------------------
    // Both shapes are printed so the evidence file states plainly which one was measured. The
    // vt1136ak suite asserted the `rotated` shape; asserting it would force the candidate to keep
    // the §7 violation, so it is recorded here and enforced only by the hard §7 test below.
    const rotated = after.vt_generation === before.vt_generation + 1;
    const shape = rotated
      ? `ROTATED  gen ${before.vt_generation}->${after.vt_generation} cause=${after.generation_cause} `
        + `cols=${after.cols} rows=${after.rows} stream_id=${after.stream_id} `
        + `grid=${JSON.stringify(after.rows_text.join(''))}`
      : `DISCARDED gen ${after.vt_generation} cause=${after.generation_cause} `
        + `cols=${after.cols} rows=${after.rows} stream_id=${after.stream_id} `
        + `reasons=${JSON.stringify(after.degraded_reasons)}`;
    console.log(`    [F2 observation] ${shape}`);

    // Guard against a third, unclassifiable outcome quietly passing as "observed".
    assert.ok(rotated || after.vt_generation === before.vt_generation,
      `generation moved by more than one step: ${before.vt_generation} -> ${after.vt_generation}`);
  } finally {
    screen.dispose();
  }
});

test('CONTRACT §7 (HARD): geometry carrying a different stream_id is DISCARDED, not applied', async () => {
  // Contract §7, verbatim: "Geometry carrying a different `stream_id` than the current
  // generation is discarded, not applied."
  //
  // vg1136am DELTA-1: this is an ordinary assertion. No `todo`, no `skip`, no conditional. On the
  // vt1136ak baseline candidate it FAILS, and the suite exits non-zero — which is the correct
  // report for a live, unresolved contract violation (vt1136ak-F2).
  //
  // Measured baseline behaviour: `noteGeometry` rotates to a new generation BEFORE the boundary
  // check, so the foreign geometry is applied to a fresh VT and the previously observed grid is
  // destroyed; `geometry_stream_mismatch` is unreachable from this path.
  //
  // Minimal repro: the `foreignGeometryScreen()` helper directly above.
  const { screen, after } = await foreignGeometryScreen();
  try {
    assert.strictEqual(after.cols, 20, 'contract §7: geometry for another stream must not resize this one');
    assert.strictEqual(after.rows, 4, 'contract §7: the observed generation keeps its own geometry');
    assert.strictEqual(after.rows_text[0], 'ALPHA', 'contract §7: the observed grid must survive');
  } finally {
    screen.dispose();
  }
});

test('§7: a read MAY wait for drain but never blocks indefinitely; the wait is hard-clamped', async () => {
  const screen = localScreen(20, 2, 'g-drain');
  assert.strictEqual(vt.VT_LIMITS.VT_DRAIN_WAIT_MS, 250);
  assert.strictEqual(vt.VT_LIMITS.VT_DRAIN_WAIT_MAX_MS, 1000);

  screen.noteOutput('drain me');
  const t0 = Date.now();
  // Ask for a 60-second wait: it must be clamped to 1000 ms, and in fact returns as soon as the
  // queue drains, which is immediately.
  const frame = await screen.readFrame({ drainWaitMs: 60000 });
  const elapsed = Date.now() - t0;

  assert.ok(elapsed < 1500, `read returned in ${elapsed}ms — the 60s request was clamped`);
  assert.strictEqual(frame.freshness, 'current');
  assert.strictEqual(frame.lag_units, 0);
  screen.dispose();
});

test('§7: readFrameSync does not wait, and reports the lag it actually measured', async () => {
  const screen = localScreen(20, 2, 'g-sync');
  screen.noteOutput('pending');
  const immediate = screen.readFrameSync();

  assert.strictEqual(immediate.observed_units, 7);
  assert.strictEqual(immediate.applied_units, 0, 'the write has not been acknowledged yet');
  assert.strictEqual(immediate.lag_units, 7);
  assert.strictEqual(immediate.freshness, 'lagging');
  assert.strictEqual(immediate.observation_basis, 'vt_grid_degraded',
    'a lagging frame is never vt_grid, however complete it otherwise is');

  const settled = await H.frameAfterDrain(screen);
  assert.strictEqual(settled.freshness, 'current');
  assert.strictEqual(settled.lag_units, 0);
  screen.dispose();
});
