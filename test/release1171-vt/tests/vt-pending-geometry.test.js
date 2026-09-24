'use strict';

// ---------------------------------------------------------------------------
// G-PEND — bounded pending / foreign-stream geometry   (vg1136am DELTA-2, new file)
// ---------------------------------------------------------------------------
//
// INDEPENDENTLY SPECIFIED FROM THE CONTRACT, NOT FROM ANY IMPLEMENTATION.
// Nothing in this file was derived by reading `src/vt/session-screen.js`; every expectation is
// written from contract §5 (completeness), §6 (U1/U2), §7 (single ordering authority, foreign
// geometry) and controller corrections 3 (origin is positively attested, a new stream_id is not
// itself proof), 4 (degrade rather than claim), 6 (bound retained state) and 2 (bounds cover
// metadata, not only queued string units), plus the vg1136am dispatch item 2:
//
//     "preserve active grid/dimensions/generation until a new stream is confirmed; legitimate
//      new child geometry-before-origin0 can still qualify when same stream output arrives;
//      different-stream output cannot borrow pending geometry. Lost/ambiguous geometry cannot
//      manufacture complete. Owner/record/restore/late callbacks and pending metadata bounds
//      remain covered."
//
// THE MODEL UNDER TEST (stated here so the oracle is readable without the implementation):
//
//   H1  A geometry op naming a stream_id other than the current generation's is NOT applied to
//       the current generation and does NOT by itself rotate it. The active generation keeps its
//       generation number, its cols/rows, its grid content and its completeness. (§7 "discarded,
//       not applied", strengthened by dispatch item 2 "preserve ... until a new stream is
//       confirmed".)
//   H2  It MAY be held as pending metadata for that stream_id. Holding is invisible in the frame
//       until the stream is confirmed.
//   H3  A stream is CONFIRMED only by OUTPUT bearing that stream_id. Geometry alone never
//       confirms one (correction 3).
//   H4  On confirmation by output at stream_offset 0, the pending geometry belongs to that new
//       generation and is applied to it — geometry was known before the generation's first output
//       unit, which is exactly §5's second condition.
//   H5  Output bearing a DIFFERENT stream_id may never adopt pending geometry held for another.
//   H6  If the pending geometry is absent, ambiguous, superseded, out of bounds or otherwise not
//       positively attested for that exact stream, the resulting generation MUST degrade. It may
//       never be `complete` and its basis may never be `vt_grid` (correction 4).
//   H7  Pending metadata is bounded — either by an explicit declared constant, or by eviction
//       that itself degrades rather than fabricates. Unbounded silent retention is a failure.
//
// SEAM: the REAL pinned @xterm/headless 6.0.0 Terminal throughout (seam ACTUAL); the ACTUAL+
// recording subclass where call order is asserted. No fake parses anything here.

const test = require('node:test');
const assert = require('node:assert');

const H = require('./helpers/vt-harness');

const vt = H.loadVt();

function real() { return H.realTerminalCtor(); }

/** An established, qualified, bridge-fed generation on `sid-A` showing ALPHA at 20x4. */
async function establishedOnA(sessionId = 'pend-A') {
  const screen = new vt.SessionScreen({
    sessionId, cause: 'stream_origin', streamId: 'sid-A', terminalFactory: real(),
  });
  screen.noteGeometry({ cols: 20, rows: 4, streamId: 'sid-A', atUnits: 0, source: 'bridge_reported' });
  screen.noteOutput('ALPHA', { stream_id: 'sid-A', stream_offset: 0 });
  const before = await H.frameAfterDrain(screen);
  // Precondition, asserted so no case below can be vacuous.
  assert.strictEqual(before.completeness, 'complete', 'precondition: the A generation is qualified');
  assert.strictEqual(before.observation_basis, 'vt_grid');
  assert.strictEqual(before.cols, 20);
  assert.strictEqual(before.rows_text[0], 'ALPHA');
  return { screen, before };
}

// ---------------------------------------------------------------------------
// H1 / H2 — the active generation is preserved until a new stream is CONFIRMED
// ---------------------------------------------------------------------------

test('G-PEND/H1: foreign-stream geometry preserves the active generation entirely', async () => {
  const { screen, before } = await establishedOnA('pend-h1');
  screen.noteGeometry({ cols: 77, rows: 9, streamId: 'sid-B', atUnits: 0, source: 'bridge_reported' });
  const after = await H.frameAfterDrain(screen);

  assert.strictEqual(after.vt_generation, before.vt_generation, 'no rotation: sid-B is not confirmed yet');
  assert.strictEqual(after.generation_cause, before.generation_cause);
  assert.strictEqual(after.stream_id, 'sid-A');
  assert.strictEqual(after.cols, 20, 'active dimensions preserved');
  assert.strictEqual(after.rows, 4);
  assert.strictEqual(after.rows_text[0], 'ALPHA', 'active grid preserved');
  assert.strictEqual(after.completeness, 'complete', 'an unconfirmed foreign op degrades nothing');
  screen.dispose();
});

test('G-PEND/H3: repeated foreign geometry never confirms a stream on its own', async () => {
  const { screen, before } = await establishedOnA('pend-h3');
  for (let i = 0; i < 25; i += 1) {
    screen.noteGeometry({
      cols: 30 + i, rows: 8, streamId: 'sid-B', atUnits: 0, source: 'bridge_reported',
    });
  }
  const after = await H.frameAfterDrain(screen);

  assert.strictEqual(after.vt_generation, before.vt_generation,
    'geometry is not output; 25 geometry ops confirm nothing (correction 3)');
  assert.strictEqual(after.stream_id, 'sid-A');
  assert.strictEqual(after.cols, 20);
  assert.strictEqual(after.rows_text[0], 'ALPHA');
  screen.dispose();
});

test('G-PEND/H1: the active generation keeps serving reads while a foreign geometry is pending', async () => {
  const { screen } = await establishedOnA('pend-h1b');
  screen.noteGeometry({ cols: 77, rows: 9, streamId: 'sid-B', atUnits: 0, source: 'bridge_reported' });
  // Contiguous traffic on the ACTIVE stream keeps flowing and stays verified and complete.
  screen.noteOutput('-BETA', { stream_id: 'sid-A', stream_offset: 5 });
  const after = await H.frameAfterDrain(screen);

  assert.strictEqual(after.stream_id, 'sid-A');
  assert.strictEqual(after.continuity, 'verified');
  assert.strictEqual(after.completeness, 'complete');
  assert.strictEqual(after.observation_basis, 'vt_grid');
  assert.strictEqual(after.rows_text[0], 'ALPHA-BETA');
  assert.strictEqual(after.cols, 20, 'still never resized by the pending op');
  screen.dispose();
});

// ---------------------------------------------------------------------------
// H4 — a legitimate new child: geometry before its origin-0 output
// ---------------------------------------------------------------------------
//
// *** CONTROLLER RULING REQUESTED — see vg1136am HOLD, item Q1. ***
// Two readings of the contract survive reading, and they differ on ONE field of this one case:
//   R2 (asserted here): the confirmed new child reaches `completeness: "complete"`. Basis: §5's
//      bridge row — "offset 0 for a stream_id is the origin" — plus §5's second condition
//      (geometry known before the generation's first output unit), which the pending op supplies;
//      plus the retained G-GEN assertion in vt-generation-continuity.test.js, which gives the
//      REASON a bare respawn is not complete as "geometry was not known before the first unit",
//      implying that supplying it changes the answer; plus dispatch item 2's "can still qualify".
//   R1 (alternative): it reaches only `partial_since_attach`. Basis: §5's sentence "A new
//      stream_id ... creates a new generation but never manufactures completeness."
// Everything else in this test holds identically under both readings and is asserted first.
// If the controller rules R1, the single `completeness`/`observation_basis` pair below flips and
// nothing else in this file changes.

test('G-PEND/H4: geometry-before-origin0 for a new stream is applied when that stream produces output', async () => {
  const { screen, before } = await establishedOnA('pend-h4');

  // The bridge announces the respawned child's geometry BEFORE its first unit (cli.js emits U1 at
  // spawn before the relay attaches — contract §6).
  screen.noteGeometry({ cols: 60, rows: 7, streamId: 'sid-B', atUnits: 0, source: 'bridge_reported' });
  // ...then that same child's first unit arrives.
  screen.noteOutput('BRAVO', { stream_id: 'sid-B', stream_offset: 0 });
  const after = await H.frameAfterDrain(screen);

  // --- holds under BOTH readings ---------------------------------------------------------------
  assert.strictEqual(after.vt_generation, before.vt_generation + 1, 'confirmed stream rotates once');
  assert.strictEqual(after.generation_cause, 'stream_changed');
  assert.strictEqual(after.stream_id, 'sid-B');
  assert.strictEqual(after.cols, 60, 'the pending geometry belonged to THIS stream and was applied');
  assert.strictEqual(after.rows, 7);
  assert.strictEqual(after.geometry_source, 'bridge_reported',
    'positively attested for this exact stream — not unverified, not invalid');
  assert.strictEqual(after.continuity, 'verified');
  assert.strictEqual(after.rows_text[0], 'BRAVO');
  assert.ok(!H.screenText(after).includes('ALPHA'), 'the new child starts from a fresh grid');
  assert.deepStrictEqual(after.degraded_reasons, [],
    'a legitimate, fully attested new child carries no degraded reason');

  // --- the one field the two readings differ on (R2 asserted; see header) ----------------------
  assert.strictEqual(after.completeness, 'complete',
    'R2: geometry known before origin-0 of a confirmed new stream qualifies (vg1136am HOLD Q1)');
  assert.strictEqual(after.observation_basis, 'vt_grid');
  screen.dispose();
});

test('G-PEND/H4: the new stream\'s terminal HAD its geometry before it parsed the first unit', async () => {
  // vg1136am ORACLE-CORRECTION item 2 (controller-specified, supersedes vt1136ak and my OC2):
  //
  //   "ordering can be established by constructor dimensions OR resize before first write, tied
  //    to THAT terminal instance. Contract requires dimensions before parsing, not a resize()
  //    call. Instrument actual constructor+write with real headless parser and prove BRAVO
  //    layout, not merely mutable frame metadata."
  //
  // So: find the REAL Terminal instance that actually parsed BRAVO; require that instance to have
  // reached 60x7 before its own first write, by either mechanism; and prove the layout from the
  // PARSER's own buffer — text that wraps at 80 but not at 60 — rather than from `frame.cols`,
  // which is metadata the module could set independently of what the parser did.
  const record = {};
  const screen = new vt.SessionScreen({
    sessionId: 'pend-h4-seam',
    cause: 'stream_origin',
    streamId: 'sid-A',
    terminalFactory: H.instrumentedTerminalCtor(record),   // seam ACTUAL+ : real parser, recorded
  });
  screen.noteGeometry({ cols: 20, rows: 4, streamId: 'sid-A', atUnits: 0, source: 'bridge_reported' });
  screen.noteOutput('ALPHA', { stream_id: 'sid-A', stream_offset: 0 });
  await H.frameAfterDrain(screen);

  // 70 B's: at cols=60 this wraps to 60 + 10; at the 80-col default it would sit on ONE row.
  // The wrap point is produced by the real parser, so it cannot be faked by frame metadata.
  const BRAVO = `BRAVO${'B'.repeat(70)}`;
  screen.noteGeometry({ cols: 60, rows: 7, streamId: 'sid-B', atUnits: 0, source: 'bridge_reported' });
  screen.noteOutput(BRAVO, { stream_id: 'sid-B', stream_offset: 0 });
  const frame = await H.frameAfterDrain(screen);

  // --- 1. the instance that actually parsed BRAVO --------------------------------------------
  const parsing = (record.instances || []).filter((i) => i.writes.some((w) => w.includes('BRAVO')));
  assert.strictEqual(parsing.length, 1,
    `exactly one real Terminal instance parsed BRAVO; instances=${JSON.stringify(
      (record.instances || []).map((i) => ({ cols: i.cols, rows: i.rows, writes: i.writes.length })))}`);
  const inst = parsing[0];

  // --- 2. that instance had 60x7 BEFORE its own first write, by either mechanism ---------------
  const bornSized = inst.cols === 60 && inst.rows === 7;
  const firstWriteIdx = inst.writes.findIndex((w) => w.includes('BRAVO'));
  const resizedFirst = inst.resizes.some((r) => r.cols === 60 && r.rows === 7 && r.afterWrites <= firstWriteIdx);
  assert.ok(bornSized || resizedFirst,
    'the terminal that parsed BRAVO must have reached 60x7 before parsing it — by constructor '
    + `dimensions or by a resize before its first write. constructedWith=${JSON.stringify(inst.constructedWith)} `
    + `resizes=${JSON.stringify(inst.resizes)} firstWriteIdx=${firstWriteIdx}`);

  // Applied once, on that instance, by exactly one of the two mechanisms — never both.
  assert.strictEqual(Number(bornSized) + Number(inst.resizes.filter((r) => r.cols === 60 && r.rows === 7).length), 1,
    'the pending geometry was applied exactly once to that instance');

  // --- 3. the REAL PARSER'S layout, read off its own buffer, not off frame metadata ------------
  const buf = inst.terminal.buffer.active;
  const row0 = buf.getLine(0).translateToString(true);
  const row1 = buf.getLine(1).translateToString(true);
  assert.strictEqual(row0.length, 60,
    `row 0 is exactly 60 cells wide => the parser laid BRAVO out at 60 cols, not the 80 default (got ${row0.length})`);
  assert.strictEqual(row0, BRAVO.slice(0, 60), 'row 0 is the first 60 units of BRAVO');
  assert.strictEqual(row1, BRAVO.slice(60), 'the remainder wrapped onto row 1 at the 60-col boundary');

  // The frame metadata must AGREE with the parser — asserted after, and as agreement, not as the
  // evidence itself.
  assert.strictEqual(frame.cols, 60, 'frame metadata agrees with the parser');
  assert.strictEqual(frame.rows, 7);
  screen.dispose();
});

// ---------------------------------------------------------------------------
// H5 — a different stream cannot borrow pending geometry
// ---------------------------------------------------------------------------

test('G-PEND/H5: output from a THIRD stream cannot borrow geometry pending for another', async () => {
  const { screen } = await establishedOnA('pend-h5');

  screen.noteGeometry({ cols: 60, rows: 7, streamId: 'sid-B', atUnits: 0, source: 'bridge_reported' });
  // sid-C confirms itself, but no geometry was ever stated for sid-C.
  screen.noteOutput('CHARLIE', { stream_id: 'sid-C', stream_offset: 0 });
  const after = await H.frameAfterDrain(screen);

  assert.strictEqual(after.stream_id, 'sid-C');
  assert.notStrictEqual(after.cols, 60, 'sid-C must NOT inherit the 60 cols pending for sid-B');
  assert.notStrictEqual(after.rows, 7);
  assert.notStrictEqual(after.geometry_source, 'bridge_reported',
    'no geometry was attested for sid-C, so none may be claimed for it');
  assert.notStrictEqual(after.completeness, 'complete',
    'geometry was not known before this generation\'s first unit (§5)');
  assert.notStrictEqual(after.observation_basis, 'vt_grid');
  screen.dispose();
});

test('G-PEND/H5: with TWO streams pending, a confirmation gets its OWN geometry or degrades — never another stream\'s', async () => {
  // vg1136am ORACLE-CORRECTION item 3 (controller-specified, supersedes vt1136ak and my OC3):
  //
  //   "H5 B-then-C pending metadata: bounded single-slot eviction is permitted by original scope.
  //    If B geometry retained it must be B's 60x7; if evicted/ambiguous, B must degrade and never
  //    borrow C's 31x3 or claim complete. Do not require two slots or unbounded retention."
  //
  // Exactly two outcomes are permitted, and both are asserted in full below. Borrowing the other
  // stream's geometry, or claiming `complete` without an attested one, fails under either.
  for (const confirm of ['sid-B', 'sid-C']) {
    const { screen } = await establishedOnA(`pend-h5b-${confirm}`);
    const own = confirm === 'sid-B' ? { cols: 60, rows: 7 } : { cols: 31, rows: 3 };
    const other = confirm === 'sid-B' ? { cols: 31, rows: 3 } : { cols: 60, rows: 7 };

    screen.noteGeometry({ cols: 60, rows: 7, streamId: 'sid-B', atUnits: 0, source: 'bridge_reported' });
    screen.noteGeometry({ cols: 31, rows: 3, streamId: 'sid-C', atUnits: 0, source: 'bridge_reported' });
    screen.noteOutput('HELLO', { stream_id: confirm, stream_offset: 0 });
    // eslint-disable-next-line no-await-in-loop
    const after = await H.frameAfterDrain(screen);

    assert.strictEqual(after.stream_id, confirm);
    // FORBIDDEN under any reading: wearing the other stream's attested geometry.
    assert.ok(!(after.cols === other.cols && after.rows === other.rows),
      `${confirm} must never adopt geometry attested for the other stream (${other.cols}x${other.rows})`);

    const tookOwn = after.cols === own.cols && after.rows === own.rows;
    if (tookOwn) {
      assert.strictEqual(after.geometry_source, 'bridge_reported',
        'geometry that WAS adopted must be reported as bridge-attested');
    } else {
      // Refused the ambiguous pending set — acceptable, but it must say so and must not qualify.
      assert.notStrictEqual(after.geometry_source, 'bridge_reported',
        'geometry that was NOT adopted may not still be reported as bridge-attested');
      assert.notStrictEqual(after.completeness, 'complete',
        'a generation with no attested origin geometry may never be complete');
      assert.notStrictEqual(after.observation_basis, 'vt_grid');
    }
    screen.dispose();
  }
});

// ---------------------------------------------------------------------------
// H6 — lost / ambiguous / out-of-bounds geometry cannot manufacture complete
// ---------------------------------------------------------------------------

test('G-PEND/H6: a confirmed new stream with NO pending geometry is never complete', async () => {
  const { screen } = await establishedOnA('pend-h6a');
  screen.noteOutput('BRAVO', { stream_id: 'sid-B', stream_offset: 0 });
  const after = await H.frameAfterDrain(screen);

  assert.strictEqual(after.stream_id, 'sid-B');
  assert.notStrictEqual(after.completeness, 'complete',
    'offset 0 alone is not an origin: geometry was not known before the first unit');
  assert.notStrictEqual(after.observation_basis, 'vt_grid');
  screen.dispose();
});

test('G-PEND/H6: AMBIGUOUS pending geometry (two disagreeing ops for one stream) cannot yield complete', async () => {
  const { screen } = await establishedOnA('pend-h6b');

  // Two geometry ops for sid-B, both claiming to be the state at unit 0, disagreeing. The module
  // cannot know which the child actually had at its origin, so it may not claim it knew.
  screen.noteGeometry({ cols: 60, rows: 7, streamId: 'sid-B', atUnits: 0, source: 'bridge_reported' });
  screen.noteGeometry({ cols: 44, rows: 12, streamId: 'sid-B', atUnits: 0, source: 'bridge_reported' });
  screen.noteOutput('BRAVO', { stream_id: 'sid-B', stream_offset: 0 });
  const after = await H.frameAfterDrain(screen);

  assert.strictEqual(after.stream_id, 'sid-B');
  assert.notStrictEqual(after.completeness, 'complete',
    'ambiguous origin geometry must degrade, never claim a known origin (correction 4)');
  assert.notStrictEqual(after.observation_basis, 'vt_grid');
  assert.ok(after.degraded_reasons.length > 0, 'the degradation is named, not silent');
  screen.dispose();
});

test('G-PEND/H6: OUT-OF-BOUNDS pending geometry is never applied and never yields complete', async () => {
  for (const geo of [{ cols: 0, rows: 7 }, { cols: 5000, rows: 5000 }, { cols: 60, rows: -1 }]) {
    const { screen } = await establishedOnA(`pend-h6c-${geo.cols}x${geo.rows}`);
    screen.noteGeometry({ ...geo, streamId: 'sid-B', atUnits: 0, source: 'bridge_reported' });
    screen.noteOutput('BRAVO', { stream_id: 'sid-B', stream_offset: 0 });
    // eslint-disable-next-line no-await-in-loop
    const after = await H.frameAfterDrain(screen);

    assert.notStrictEqual(after.cols, geo.cols, `${geo.cols}x${geo.rows}: out-of-range cols never applied`);
    assert.notStrictEqual(after.completeness, 'complete',
      `${geo.cols}x${geo.rows}: invalid geometry cannot attest an origin`);
    assert.notStrictEqual(after.observation_basis, 'vt_grid');
    screen.dispose();
  }
});

test('G-PEND/H6: a pending stream confirmed at a NON-zero offset is never complete', async () => {
  const { screen } = await establishedOnA('pend-h6d');
  screen.noteGeometry({ cols: 60, rows: 7, streamId: 'sid-B', atUnits: 0, source: 'bridge_reported' });
  // The child's first observed unit is 4096, not 0: this is an attach, not an origin.
  screen.noteOutput('BRAVO', { stream_id: 'sid-B', stream_offset: 4096 });
  const after = await H.frameAfterDrain(screen);

  assert.strictEqual(after.stream_id, 'sid-B');
  // Which degraded value is correct is genuinely open — `partial_since_attach` (the generation
  // began mid-stream) and `partial_after_loss` (units 0..4095 are missing) are both defensible
  // readings of §5, and the contract does not rank them. The oracle is that it is NOT complete.
  assert.notStrictEqual(after.completeness, 'complete',
    'geometry known first does not substitute for an origin at offset 0 (§5)');
  assert.ok(['partial_since_attach', 'partial_after_loss'].includes(after.completeness),
    `expected a named partial_*; got ${after.completeness}`);
  assert.notStrictEqual(after.observation_basis, 'vt_grid');
  screen.dispose();
});

test('G-PEND/H6: a pending geometry with a malformed at_units cannot attest an origin', async () => {
  for (const atUnits of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, '0']) {
    const { screen } = await establishedOnA(`pend-h6e-${String(atUnits)}`);
    screen.noteGeometry({ cols: 60, rows: 7, streamId: 'sid-B', atUnits, source: 'bridge_reported' });
    screen.noteOutput('BRAVO', { stream_id: 'sid-B', stream_offset: 0 });
    // eslint-disable-next-line no-await-in-loop
    const after = await H.frameAfterDrain(screen);

    assert.notStrictEqual(after.completeness, 'complete',
      `at_units=${String(atUnits)} is not a valid attestation of the origin boundary`);
    assert.notStrictEqual(after.observation_basis, 'vt_grid');
    screen.dispose();
  }
});

test('G-PEND/H6: an explicit drop on the pending stream before its origin blocks complete', async () => {
  const { screen } = await establishedOnA('pend-h6f');
  screen.noteGeometry({ cols: 60, rows: 7, streamId: 'sid-B', atUnits: 0, source: 'bridge_reported' });
  // The bridge states, explicitly, that it lost the first 12 units of sid-B.
  screen.noteDropped({ streamId: 'sid-B', fromUnits: 0, toUnits: 12 });
  screen.noteOutput('BRAVO', { stream_id: 'sid-B', stream_offset: 12 });
  const after = await H.frameAfterDrain(screen);

  assert.notStrictEqual(after.completeness, 'complete',
    'declared loss at the origin cannot be observed away');
  assert.notStrictEqual(after.observation_basis, 'vt_grid');
  screen.dispose();
});

// ---------------------------------------------------------------------------
// H6 — owner / record / restore rotations do not consume pending geometry into completeness
// ---------------------------------------------------------------------------

test('G-PEND/H6: owner_replaced / record_replaced / restored never become complete off pending geometry', async () => {
  for (const cause of ['owner_replaced', 'record_replaced', 'restored']) {
    const { screen } = await establishedOnA(`pend-rot-${cause}`);
    // Geometry for the stream the NEW generation will carry, stated before the rotation.
    screen.noteGeometry({ cols: 60, rows: 7, streamId: 'sid-B', atUnits: 0, source: 'bridge_reported' });
    screen.newGeneration(cause, { streamId: 'sid-B' });
    screen.noteOutput('BRAVO', { stream_id: 'sid-B', stream_offset: 0 });
    // eslint-disable-next-line no-await-in-loop
    const after = await H.frameAfterDrain(screen);

    assert.strictEqual(after.generation_cause, cause);
    assert.notStrictEqual(after.completeness, 'complete',
      `${cause} is an identity change, not a child origin — pending geometry cannot rescue it`);
    assert.notStrictEqual(after.observation_basis, 'vt_grid');
    if (cause === 'restored') {
      assert.strictEqual(after.completeness, 'partial_since_restore', 'the restore floor holds');
    }
    screen.dispose();
  }
});

test('G-PEND/H6: the restore floor survives a later fully-attested pending-geometry origin', async () => {
  const screen = new vt.SessionScreen({
    sessionId: 'pend-restore-floor',
    cause: 'restored',
    restoredRecord: true,
    streamId: 'sid-A',
    terminalFactory: real(),
  });
  screen.noteOutput('after restart', { stream_id: 'sid-A', stream_offset: 0 });
  let frame = await H.frameAfterDrain(screen);
  assert.strictEqual(frame.completeness, 'partial_since_restore');

  // A textbook-perfect new child on this restored record still cannot climb back to complete.
  screen.noteGeometry({ cols: 60, rows: 7, streamId: 'sid-B', atUnits: 0, source: 'bridge_reported' });
  screen.noteOutput('BRAVO', { stream_id: 'sid-B', stream_offset: 0 });
  frame = await H.frameAfterDrain(screen);

  assert.strictEqual(frame.completeness, 'partial_since_restore',
    'partial_since_restore is a floor for the life of the record, not of one generation');
  assert.notStrictEqual(frame.observation_basis, 'vt_grid');
  screen.dispose();
});

// ---------------------------------------------------------------------------
// Late callbacks — a pending-geometry rotation must fence in-flight work
// ---------------------------------------------------------------------------

test('G-PEND: output in flight on the OLD stream cannot land on the newly confirmed generation', async () => {
  const { screen } = await establishedOnA('pend-fence');

  // Enqueue A traffic, then confirm B in the same synchronous turn, so A work is genuinely
  // in flight across the rotation.
  screen.noteOutput('-MORE-A-TEXT', { stream_id: 'sid-A', stream_offset: 5 });
  screen.noteGeometry({ cols: 60, rows: 7, streamId: 'sid-B', atUnits: 0, source: 'bridge_reported' });
  screen.noteOutput('BRAVO', { stream_id: 'sid-B', stream_offset: 0 });
  const after = await H.frameAfterDrain(screen);

  assert.strictEqual(after.stream_id, 'sid-B');
  assert.strictEqual(after.rows_text[0], 'BRAVO');
  assert.ok(!H.screenText(after).includes('MORE-A-TEXT'),
    'a superseded generation\'s output may not appear on the new grid');
  assert.ok(!H.screenText(after).includes('ALPHA'));
  screen.dispose();
});

test('G-PEND: a stale geometry op for a SUPERSEDED stream does not disturb the current generation', async () => {
  const { screen } = await establishedOnA('pend-stale');
  screen.noteGeometry({ cols: 60, rows: 7, streamId: 'sid-B', atUnits: 0, source: 'bridge_reported' });
  screen.noteOutput('BRAVO', { stream_id: 'sid-B', stream_offset: 0 });
  const confirmed = await H.frameAfterDrain(screen);

  // sid-A is gone. A late, reordered U1 for it arrives.
  screen.noteGeometry({ cols: 12, rows: 2, streamId: 'sid-A', atUnits: 0, source: 'bridge_reported' });
  const after = await H.frameAfterDrain(screen);

  assert.strictEqual(after.vt_generation, confirmed.vt_generation, 'no rotation back to a dead stream');
  assert.strictEqual(after.stream_id, 'sid-B');
  assert.strictEqual(after.cols, 60, 'the live generation keeps its own geometry');
  assert.strictEqual(after.rows_text[0], 'BRAVO');
  screen.dispose();
});

// ---------------------------------------------------------------------------
// H7 — pending metadata is BOUNDED
// ---------------------------------------------------------------------------

test('G-PEND/H7: pending geometry metadata is bounded — by a declared constant or by honest eviction', async () => {
  const FLOOD = 2000;                       // bounded fixture: 2000 ops, all tiny, well under 5 MiB
  const streamIdUnits = 'sid-flood-0000'.length;
  assert.ok(FLOOD * (streamIdUnits + 16) < 5 * 1024 * 1024, 'fixture stays bounded (contract §12 policy)');

  const { screen, before } = await establishedOnA('pend-h7');

  for (let i = 0; i < FLOOD; i += 1) {
    screen.noteGeometry({
      cols: 40, rows: 10, streamId: `sid-flood-${String(i).padStart(4, '0')}`,
      atUnits: 0, source: 'bridge_reported',
    });
  }
  const during = await H.frameAfterDrain(screen);
  assert.strictEqual(during.vt_generation, before.vt_generation, 'the flood confirmed nothing');
  assert.strictEqual(during.cols, 20, 'the flood resized nothing');
  assert.strictEqual(during.rows_text[0], 'ALPHA', 'the flood destroyed nothing');

  // Now confirm the very FIRST flooded stream — the one most likely to have been evicted.
  screen.noteOutput('FLOOD0', { stream_id: 'sid-flood-0000', stream_offset: 0 });
  const after = await H.frameAfterDrain(screen);
  assert.strictEqual(after.stream_id, 'sid-flood-0000');

  const declaredBound = Object.entries(vt.VT_LIMITS || {})
    .filter(([k, v]) => /PENDING/i.test(k) && Number.isInteger(v) && v > 0);
  const retained = after.cols === 40 && after.geometry_source === 'bridge_reported';

  if (retained) {
    // Retention is only acceptable if the retention itself is explicitly bounded.
    assert.ok(declaredBound.length > 0,
      'pending geometry was retained across 2000 distinct streams with no declared bound in '
      + `VT_LIMITS (keys: ${Object.keys(vt.VT_LIMITS || {}).join(', ')}) — correction 6 requires `
      + 'retained state to be bounded by a conservative explicit named constant');
    assert.ok(FLOOD <= declaredBound[0][1],
      `retention is bounded at ${declaredBound[0][0]}=${declaredBound[0][1]} yet entry 0 of ${FLOOD} survived`);
  } else {
    // Eviction is acceptable — but it must DEGRADE, never fabricate. This is correction 4.
    assert.notStrictEqual(after.completeness, 'complete',
      'an evicted pending geometry must degrade, never be replaced by an invented origin');
    assert.notStrictEqual(after.observation_basis, 'vt_grid');
    assert.notStrictEqual(after.geometry_source, 'bridge_reported',
      'geometry that is no longer held may not still be reported as bridge-attested');
  }
  screen.dispose();
});

test('G-PEND/H7: an over-long pending stream_id is not retained, and creates no rotation or origin', async () => {
  // vg1136am ORACLE-CORRECTION item 4 (controller-specified, supersedes my earlier assertion):
  //
  //   "preserving alreadycomplete sidA is NOT manufacturing a newcomplete origin. Assert invalid
  //    ID isn't retained, no rotation/foreign geometry/neworigin; compare prior generation /
  //    current grid. For new validstream without validgeometry, continue requiring notcomplete."
  //
  // My earlier `completeness !== 'complete'` was therefore WRONG here: sid-A had already earned
  // `complete` before the invalid op arrived, and keeping it is correct. What is asserted instead
  // is that the invalid identity buys nothing: no rotation, no geometry, no new origin.
  const { screen, before } = await establishedOnA('pend-h7b');
  const max = (vt.VT_LIMITS && vt.VT_LIMITS.VT_MAX_STREAM_ID_UNITS) || 256;
  const huge = 'B'.repeat(max + 64);

  screen.noteGeometry({ cols: 60, rows: 7, streamId: huge, atUnits: 0, source: 'bridge_reported' });
  const during = await H.frameAfterDrain(screen);
  assert.strictEqual(during.vt_generation, before.vt_generation, 'no rotation off an invalid identity');
  assert.strictEqual(during.cols, 20, 'an out-of-bounds stream_id resized nothing');
  assert.strictEqual(during.rows, 4);
  assert.strictEqual(during.stream_id, 'sid-A', 'the invalid id did not become the generation identity');

  screen.noteOutput('HUGE', { stream_id: huge, stream_offset: 0 });
  const after = await H.frameAfterDrain(screen);

  // The invalid id is not retained as a pending slot and produces no new generation or origin.
  assert.strictEqual(after.vt_generation, before.vt_generation,
    'output under an invalid stream_id may not create a generation');
  assert.strictEqual(after.stream_id, 'sid-A');
  assert.strictEqual(after.cols, 20, 'the pending geometry offered under an invalid id was not retained');
  assert.strictEqual(after.rows, 4);
  assert.strictEqual(after.generation_cause, before.generation_cause, 'no new origin was minted');
  screen.dispose();
});

test('G-PEND/H7: output under an INVALID stream_id may not alter the observed grid (F4)', async () => {
  // vg1136am ORACLE-CORRECTION item 4, technical correction (controller, follow-up):
  //
  //   "your newly documented invalid-stream OUTPUT contamination is a real separate issue;
  //    preserve a hard assertion that invalid-origin data cannot alter grid or create origin.
  //    Preserving prior complete alone is not the defect. Do not discard that evidence."
  //
  // This is that hard assertion. Contract §7 fences a generation on its identity; units whose
  // claimed origin is unusable are not units of this generation, so they may not be parsed into
  // its grid. Measured on BOTH trees: they are.
  const { screen, before } = await establishedOnA('pend-h7-contam');
  const max = (vt.VT_LIMITS && vt.VT_LIMITS.VT_MAX_STREAM_ID_UNITS) || 256;
  const huge = 'B'.repeat(max + 64);

  assert.strictEqual(before.rows_text[0], 'ALPHA', 'precondition: a qualified grid showing ALPHA');

  screen.noteOutput('-INJECTED', { stream_id: huge, stream_offset: 5 });
  const after = await H.frameAfterDrain(screen);

  assert.strictEqual(after.rows_text[0], 'ALPHA',
    'invalid-origin data must not be parsed into the observed grid');
  assert.ok(!H.screenText(after).includes('INJECTED'),
    `no unit of an unusable-origin op may appear anywhere on the grid; got ${JSON.stringify(after.rows_text)}`);
  assert.strictEqual(after.vt_generation, before.vt_generation, 'and it creates no origin');
  screen.dispose();
});

test('G-PEND/H7: an empty geometry message is recorded as invalid, never as an attestation', async () => {
  const { screen, before } = await establishedOnA('pend-h7c');
  for (const geo of [{}, { streamId: 'sid-B' }, { cols: 60, streamId: 'sid-B' }, { rows: 7, streamId: 'sid-B' }]) {
    screen.noteGeometry({ atUnits: 0, source: 'bridge_reported', ...geo });
  }
  const during = await H.frameAfterDrain(screen);
  assert.strictEqual(during.vt_generation, before.vt_generation);
  assert.strictEqual(during.cols, 20);
  assert.strictEqual(during.rows_text[0], 'ALPHA');

  screen.noteOutput('BRAVO', { stream_id: 'sid-B', stream_offset: 0 });
  const after = await H.frameAfterDrain(screen);
  assert.notStrictEqual(after.completeness, 'complete',
    'an incomplete geometry message attests nothing (correction 2)');
  screen.dispose();
});
