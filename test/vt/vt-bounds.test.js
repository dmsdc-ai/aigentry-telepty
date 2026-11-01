'use strict';

// G-BOUND — every explicit bound in contract §8 / coder REPORT §5, exercised against the REAL
// parser with DETERMINISTIC, BOUNDED fixtures (dispatch: "not unbounded memory pressure";
// "each expensive test bounded 30s / max 5 MiB input").
//
// Terminal: REAL @xterm/headless 6.0.0 (seam ACTUAL) throughout this file.

const test = require('node:test');
const assert = require('node:assert');

const H = require('./helpers/vt-harness');

const vt = H.loadVt();
const L = vt.VT_LIMITS;
const MAX_FIXTURE_BYTES = 5 * 1024 * 1024;

const real = () => H.realTerminalCtor();

function localScreen(cols, rows, sessionId) {
  return new vt.SessionScreen({
    sessionId,
    cause: 'stream_origin',
    localSource: true,
    geometrySource: 'local_pty',
    cols,
    rows,
    terminalFactory: real(),
  });
}

/** Guard every expensive fixture against the dispatch's own input bound. */
function assertFixtureBounded(str, label) {
  const bytes = Buffer.byteLength(str, 'utf8');
  assert.ok(bytes <= MAX_FIXTURE_BYTES,
    `${label}: fixture is ${bytes} bytes, over the 5 MiB test-input bound`);
  return bytes;
}

test('the bounds table is frozen and has the documented values', () => {
  assert.ok(Object.isFrozen(L));
  assert.deepStrictEqual({ ...L }, {
    VT_MIN_DIMENSION: 1,
    VT_MAX_DIMENSION: 1000,
    VT_SCROLLBACK: 0,
    VT_QUEUE_MAX_UNITS: 1048576,
    VT_QUEUE_MAX_OPS: 4096,
    VT_MAX_WRITE_CHUNK_UNITS: 65536,
    VT_MAX_ROW_CHARS_PER_COL: 8,
    VT_MAX_SNAPSHOT_BYTES: 262144,
    VT_CELL_AUDIT_INTERVAL_UNITS: 262144,
    VT_MAX_GRID_UNITS: 2097152,
    VT_DRAIN_WAIT_MS: 250,
    VT_DRAIN_WAIT_MAX_MS: 1000,
    VT_MAX_STREAM_ID_UNITS: 256,
    VT_OVERLAP_WINDOW_UNITS: 65536,
  });
});

// ---------------------------------------------------------------------------
// Geometry bounds
// ---------------------------------------------------------------------------

test('G-BOUND: geometry outside 1..1000 is invalid; the VT keeps its last VALID geometry', async () => {
  const screen = localScreen(40, 5, 'bound-geo');
  screen.noteOutput('keep me');
  await H.frameAfterDrain(screen);

  for (const bad of [
    { cols: 0, rows: 10 },
    { cols: 1001, rows: 10 },
    { cols: 5000, rows: 5000 },      // oversized geometry
    { cols: 10.5, rows: 10 },
    { cols: 'eighty', rows: 24 },
    { cols: -1, rows: -1 },
    { cols: NaN, rows: 10 },
    {},                              // empty geometry message
  ]) {
    screen.noteGeometry({ ...bad, source: 'local_pty', atUnits: null });
    // eslint-disable-next-line no-await-in-loop
    const frame = await H.frameAfterDrain(screen);
    assert.strictEqual(frame.cols, 40, `cols kept after ${JSON.stringify(bad)}`);
    assert.strictEqual(frame.rows, 5, `rows kept after ${JSON.stringify(bad)}`);
    assert.strictEqual(frame.geometry_source, 'invalid');
    H.assertReason(frame, 'geometry_invalid');
    assert.strictEqual(frame.observation_basis, 'vt_grid_degraded');
    assert.strictEqual(frame.rows_text[0], 'keep me', 'the grid itself is untouched');
  }
  screen.dispose();
});

test('G-BOUND: the extreme VALID geometries 1x1 and 1000x1000 are accepted', async () => {
  const tiny = localScreen(1, 1, 'bound-1x1');
  tiny.noteOutput('abc');
  let frame = await H.frameAfterDrain(tiny);
  assert.strictEqual(frame.cols, 1);
  assert.strictEqual(frame.rows, 1);
  assert.strictEqual(frame.rows_text.length, 1);
  assert.strictEqual(frame.observation_basis, 'vt_grid');
  tiny.dispose();

  const huge = localScreen(1000, 1000, 'bound-1000');
  huge.noteOutput('edge');
  frame = await H.frameAfterDrain(huge);
  assert.strictEqual(frame.cols, 1000);
  assert.strictEqual(frame.rows, 1000);
  assert.strictEqual(frame.rows_text.length, 1000);
  huge.dispose();
});

test('G-BOUND: an invalid at_units on a geometry op is rejected without applying', async () => {
  const screen = new vt.SessionScreen({
    sessionId: 'bound-atunits', cause: 'stream_origin', streamId: 'sid', terminalFactory: real(),
  });
  screen.noteGeometry({ cols: 30, rows: 4, streamId: 'sid', atUnits: 0, source: 'bridge_reported' });
  screen.noteOutput('x', { stream_id: 'sid', stream_offset: 0 });
  await H.frameAfterDrain(screen);

  for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 2, 'later', NaN, Infinity]) {
    screen.noteGeometry({ cols: 55, rows: 9, streamId: 'sid', atUnits: bad, source: 'bridge_reported' });
    // eslint-disable-next-line no-await-in-loop
    const frame = await H.frameAfterDrain(screen);
    assert.strictEqual(frame.cols, 30, `cols kept after at_units=${String(bad)}`);
    assert.strictEqual(frame.geometry_source, 'unverified');
    H.assertReason(frame, 'geometry_at_units_invalid');
  }
  screen.dispose();
});

// ---------------------------------------------------------------------------
// Payload / identity / offset validation (correction 2)
// ---------------------------------------------------------------------------

test('G-BOUND: a non-string output payload is a malformed frame, never a measured length', async () => {
  for (const bad of [123, null, undefined, {}, [], Buffer.from('bytes'), true]) {
    const screen = localScreen(20, 2, 'bound-payload');
    screen.noteOutput('good');
    screen.noteOutput(bad);
    // eslint-disable-next-line no-await-in-loop
    const frame = await H.frameAfterDrain(screen);

    if (bad === null || bad === undefined) {
      // A null/undefined payload is still not a string.
      H.assertReason(frame, 'invalid_output_payload');
    } else {
      H.assertReason(frame, 'invalid_output_payload');
    }
    assert.strictEqual(frame.observed_units, 4, `only the real units were counted (${typeof bad})`);
    assert.strictEqual(frame.continuity, 'invalid');
    assert.strictEqual(frame.observation_basis, 'vt_grid_degraded');
    screen.dispose();
  }
});

test('G-BOUND: an empty output payload is a no-op, not a fault', async () => {
  const screen = localScreen(20, 2, 'bound-empty');
  screen.noteOutput('a');
  screen.noteOutput('');
  const frame = await H.frameAfterDrain(screen);
  assert.strictEqual(frame.observed_units, 1);
  assert.deepStrictEqual(frame.degraded_reasons, []);
  assert.strictEqual(frame.observation_basis, 'vt_grid');
  screen.dispose();
});

test('G-BOUND: stream_id length is bounded at 256 UTF-16 units', async () => {
  const ok = 'a'.repeat(L.VT_MAX_STREAM_ID_UNITS);
  const tooLong = 'a'.repeat(L.VT_MAX_STREAM_ID_UNITS + 1);

  const good = new vt.SessionScreen({
    sessionId: 'sid-ok', cause: 'stream_origin', streamId: ok, terminalFactory: real(),
  });
  good.noteGeometry({ cols: 20, rows: 2, streamId: ok, atUnits: 0, source: 'bridge_reported' });
  good.noteOutput('x', { stream_id: ok, stream_offset: 0 });
  let frame = await H.frameAfterDrain(good);
  assert.strictEqual(frame.stream_id, ok, '256 units is accepted');
  H.assertNoReason(frame, 'invalid_stream_id');
  good.dispose();

  const bad = new vt.SessionScreen({
    sessionId: 'sid-bad', cause: 'stream_origin', cols: 20, rows: 2,
    geometrySource: 'bridge_reported', terminalFactory: real(),
  });
  bad.noteOutput('x', { stream_id: tooLong, stream_offset: 0 });
  frame = await H.frameAfterDrain(bad);
  H.assertReason(frame, 'invalid_stream_id');
  assert.strictEqual(frame.continuity, 'invalid');
  assert.notStrictEqual(frame.completeness, 'complete');
  bad.dispose();

  // An empty-string stream_id is not an identity either.
  const empty = new vt.SessionScreen({
    sessionId: 'sid-empty', cause: 'stream_origin', cols: 20, rows: 2,
    geometrySource: 'bridge_reported', terminalFactory: real(),
  });
  empty.noteOutput('x', { stream_id: '', stream_offset: 0 });
  frame = await H.frameAfterDrain(empty);
  H.assertReason(frame, 'invalid_stream_id');
  empty.dispose();
});

test('G-BOUND: stream_offset must be a safe non-negative integer', async () => {
  for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 2, NaN, Infinity, 'soon', {}]) {
    const screen = new vt.SessionScreen({
      sessionId: 'bound-offset', cause: 'stream_origin', cols: 20, rows: 2,
      geometrySource: 'bridge_reported', terminalFactory: real(),
    });
    screen.noteOutput('x', { stream_id: 'sid', stream_offset: bad });
    // eslint-disable-next-line no-await-in-loop
    const frame = await H.frameAfterDrain(screen);
    H.assertReason(frame, 'invalid_stream_offset');
    assert.strictEqual(frame.continuity, 'invalid');
    assert.notStrictEqual(frame.completeness, 'complete', `offset ${String(bad)} must not qualify`);
    screen.dispose();
  }
});

// ---------------------------------------------------------------------------
// Queue bounds — units AND op count (correction 2)
// ---------------------------------------------------------------------------

test('G-BOUND: the queued OP COUNT is bounded — a flood of tiny frames costs a fixed amount', async () => {
  const screen = localScreen(20, 3, 'bound-ops');
  // Synchronous flood: the first op goes straight to write(), the rest queue behind it.
  const floodSize = L.VT_QUEUE_MAX_OPS + 1000;
  for (let i = 0; i < floodSize; i += 1) screen.noteOutput('.');
  assertFixtureBounded('.'.repeat(floodSize), 'op flood');

  const frame = await H.frameAfterDrain(screen);
  H.assertReason(frame, 'queue_overflow');
  assert.strictEqual(frame.completeness, 'partial_after_loss');
  assert.ok(frame.dropped_units > 0, 'the loss is COUNTED, not silent');
  assert.ok(frame.observed_units < floodSize,
    'units past the bound were refused, not accepted-then-forgotten');
  assert.strictEqual(frame.observed_units + frame.dropped_units, floodSize,
    'every offered unit is accounted for as either observed or dropped');
  screen.dispose();
});

test('G-BOUND: the queued UNIT COUNT is bounded at 1 MiB units', async () => {
  const block = 'y'.repeat(600000);
  assertFixtureBounded(block.repeat(2), 'unit flood');

  const screen = localScreen(80, 24, 'bound-units');
  screen.noteOutput(block);     // sliced: 65536 written, the rest stays queued
  screen.noteOutput(block);     // pushes queued units past 1 048 576
  const frame = await H.frameAfterDrain(screen);

  H.assertReason(frame, 'queue_overflow');
  assert.strictEqual(frame.completeness, 'partial_after_loss');
  assert.strictEqual(frame.dropped_units, 600000, 'the whole refused op is counted as lost');
  assert.strictEqual(frame.observed_units, 600000);
  screen.dispose();
});

test('G-BOUND: a single write to the parser never exceeds VT_MAX_WRITE_CHUNK_UNITS', async () => {
  const record = {};
  const screen = new vt.SessionScreen({
    sessionId: 'bound-chunk',
    cause: 'stream_origin',
    localSource: true,
    geometrySource: 'local_pty',
    cols: 80,
    rows: 24,
    terminalFactory: H.instrumentedTerminalCtor(record),
  });
  const payload = 'z'.repeat(200000);
  assertFixtureBounded(payload, 'chunk bound');
  screen.noteOutput(payload);
  const frame = await H.frameAfterDrain(screen);

  assert.ok(record.writes.length >= 4, 'the payload was sliced into several writes');
  for (const w of record.writes) {
    assert.ok(w.length <= L.VT_MAX_WRITE_CHUNK_UNITS,
      `a write of ${w.length} units exceeds the ${L.VT_MAX_WRITE_CHUNK_UNITS} bound`);
  }
  assert.strictEqual(record.writes.join('').length, payload.length, 'nothing lost in the slicing');
  assert.strictEqual(frame.applied_units, payload.length, 'accounting stayed exact across slices');
  assert.strictEqual(frame.observed_units, payload.length);
  screen.dispose();
});

test('G-BOUND: slicing never severs a surrogate pair', async () => {
  const record = {};
  const screen = new vt.SessionScreen({
    sessionId: 'bound-surrogate',
    cause: 'stream_origin',
    localSource: true,
    geometrySource: 'local_pty',
    cols: 80,
    rows: 24,
    terminalFactory: H.instrumentedTerminalCtor(record),
  });
  // An all-astral payload: every odd index is a high surrogate, so a naive cut at 65536 would
  // split a pair. 40 000 emoji = 80 000 units.
  const payload = '\u{1F600}'.repeat(40000);
  assertFixtureBounded(payload, 'surrogate slicing');
  screen.noteOutput(payload);
  await H.frameAfterDrain(screen);

  for (const w of record.writes) {
    const first = w.charCodeAt(0);
    const last = w.charCodeAt(w.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), 'no write ENDS on a high surrogate');
    assert.ok(!(first >= 0xdc00 && first <= 0xdfff), 'no write STARTS on a low surrogate');
  }
  assert.strictEqual(record.writes.join(''), payload);
  screen.dispose();
});

// ---------------------------------------------------------------------------
// Row and snapshot bounds
// ---------------------------------------------------------------------------

test('G-BOUND: a row exceeding 8 x cols code units is truncated and SAID so', async () => {
  const cols = 10;
  const screen = localScreen(cols, 2, 'bound-row');
  // ONE cell carrying 201 UTF-16 units: a cell is not a character.
  const payload = `a${'\u0301'.repeat(200)}`;
  assertFixtureBounded(payload, 'row truncation');
  screen.noteOutput(payload);
  const frame = await H.frameAfterDrain(screen);

  H.assertReason(frame, 'row_truncated');
  assert.strictEqual(frame.rows_text[0].length, cols * L.VT_MAX_ROW_CHARS_PER_COL,
    'the row is cut at exactly 8 x cols units');
  assert.strictEqual(frame.observation_basis, 'vt_grid_degraded', 'truncation is never silent');
  screen.dispose();
});

test('G-BOUND: the snapshot is bounded in UTF-8 BYTES, dropping trailing rows loudly', async () => {
  const cols = 1000;
  const rows = 300;
  const screen = localScreen(cols, rows, 'bound-snapshot');

  const line = 'a'.repeat(cols);
  const payload = new Array(rows).fill(line).join('\r\n');
  assertFixtureBounded(payload, 'snapshot truncation');
  screen.noteOutput(payload);
  const frame = await H.frameAfterDrain(screen);

  assert.strictEqual(frame.snapshot_truncated, true);
  H.assertReason(frame, 'snapshot_truncated');
  assert.ok(frame.snapshot_bytes <= L.VT_MAX_SNAPSHOT_BYTES,
    `snapshot_bytes ${frame.snapshot_bytes} must stay within ${L.VT_MAX_SNAPSHOT_BYTES}`);
  assert.ok(frame.rows_text.length < rows, 'trailing rows were dropped');
  assert.ok(frame.rows_text.length > 200, 'but most of the screen is still returned');
  assert.strictEqual(frame.observation_basis, 'vt_grid_degraded',
    'contract §8: a truncated snapshot is reported as degraded, LOUDLY');
  screen.dispose();
});

test('G-BOUND: snapshot_bytes really is UTF-8 bytes of rows_text, not units', async () => {
  const screen = localScreen(20, 3, 'bound-bytes');
  screen.noteOutput('가나다\r\nabc');
  const frame = await H.frameAfterDrain(screen);

  const expected = frame.rows_text
    .reduce((acc, r) => acc + Buffer.byteLength(r, 'utf8') + 1, 0);
  assert.strictEqual(frame.snapshot_bytes, expected);
  assert.notStrictEqual(frame.snapshot_bytes, H.screenText(frame).length,
    'bytes and units genuinely differ for this fixture');
  screen.dispose();
});

// ---------------------------------------------------------------------------
// Retained cell growth (correction 6) — the bound that snapshot truncation does NOT provide
// ---------------------------------------------------------------------------

test('G-BOUND: retained combining-cell growth is measured and STOPS the generation', async (t) => {
  // Correction 6, verbatim: "Snapshot truncation alone does not bound an xterm cell growing
  // across many combining-character writes." This test drives exactly that growth with a
  // deterministic, bounded fixture — never unbounded memory pressure.
  //
  // Fixture arithmetic, stated so the bound is reproducible:
  //   grid 1000 x 1000  -> a BLANK grid already measures 1 000 000 units (translateToString(false)
  //                        returns full width), leaving ~1.1 M units of headroom under the
  //                        2 097 152 bound.
  //   each written cell -> 'a' + 2 combining marks = 3 units, i.e. +2 over the blank cell.
  //   700 cells/row x 1000 rows x 2 extra units = 1 400 000 extra units -> total ~2.4 M > bound.
  const cols = 1000;
  const rows = 1000;
  const cellsPerRow = 700;

  const cell = 'a\u0301\u0301';
  const line = cell.repeat(cellsPerRow);
  const payload = new Array(rows).fill(line).join('\r\n');
  const bytes = assertFixtureBounded(payload, 'cell growth');
  t.diagnostic(`cell-growth fixture: ${payload.length} units / ${bytes} bytes`);

  const started = Date.now();
  const screen = localScreen(cols, rows, 'bound-cellgrowth');

  // Fed in DRAINED batches. A single 2.1 M-unit op would trip VT_QUEUE_MAX_UNITS (1 MiB) first
  // and never reach the parser, which would measure the queue bound instead of the grid bound.
  // Draining between batches is what a real producer does anyway: the daemon hands over one PTY
  // chunk at a time.
  const ROWS_PER_BATCH = 100;
  let frame = null;
  for (let start = 0; start < rows; start += ROWS_PER_BATCH) {
    const batch = new Array(Math.min(ROWS_PER_BATCH, rows - start)).fill(line).join('\r\n')
      + (start + ROWS_PER_BATCH < rows ? '\r\n' : '');
    assert.ok(batch.length < L.VT_QUEUE_MAX_UNITS, 'each batch stays inside the queue bound');
    screen.noteOutput(batch);
    // eslint-disable-next-line no-await-in-loop
    frame = await H.frameAfterDrain(screen, { deadlineMs: 25000 });
    if (frame.degraded_reasons.includes('cell_growth_bound_exceeded')) break;
  }
  const elapsed = Date.now() - started;
  t.diagnostic(`cell-growth elapsed: ${elapsed} ms`);

  assert.ok(elapsed < 30000, `expensive test must stay under 30 s; took ${elapsed} ms`);

  H.assertReason(frame, 'cell_growth_bound_exceeded');
  assert.strictEqual(frame.completeness, 'partial_after_loss', 'sticky degraded reason');
  assert.strictEqual(frame.observation_basis, 'unavailable',
    'the generation is STOPPED, not silently reset to complete');
  assert.deepStrictEqual(frame.rows_text, [], 'the terminal was disposed');
  assert.notStrictEqual(frame.freshness, 'current');

  // And it never climbs back: further output cannot resurrect the stopped generation.
  screen.noteOutput('more');
  const after = await H.frameAfterDrain(screen);
  assert.strictEqual(after.observation_basis, 'unavailable');
  H.assertReason(after, 'cell_growth_bound_exceeded');
  assert.notStrictEqual(after.completeness, 'complete');
  screen.dispose();
});

test('G-BOUND: ordinary combining use stays well inside the grid bound', async () => {
  // The counterpart to the test above: the bound must not fire on normal accented text.
  const screen = localScreen(80, 24, 'bound-normal-combining');
  const payload = new Array(24).fill(`Cáfé résumé ${'nã'.repeat(20)}`).join('\r\n');
  assertFixtureBounded(payload, 'normal combining');
  screen.noteOutput(payload);
  const frame = await H.frameAfterDrain(screen);

  H.assertNoReason(frame, 'cell_growth_bound_exceeded');
  H.assertNoReason(frame, 'row_truncated');
  H.assertNoReason(frame, 'snapshot_truncated');
  assert.strictEqual(frame.observation_basis, 'vt_grid');
  screen.dispose();
});

test('dispose() is idempotent and releases the terminal', async () => {
  const screen = localScreen(20, 2, 'bound-dispose');
  screen.noteOutput('x');
  await H.frameAfterDrain(screen);

  screen.dispose();
  screen.dispose();      // must not throw

  const frame = screen.readFrameSync();
  assert.strictEqual(frame.observation_basis, 'unavailable');
  H.assertReason(frame, 'vt_disposed');
  assert.deepStrictEqual(frame.rows_text, []);

  // Producers after disposal are inert.
  assert.doesNotThrow(() => screen.noteOutput('ignored'));
  assert.doesNotThrow(() => screen.noteGeometry({ cols: 10, rows: 10 }));
  assert.doesNotThrow(() => screen.noteDropped({ fromUnits: 0, toUnits: 1 }));
  assert.strictEqual(screen.newGeneration('stream_origin'), null);
});
