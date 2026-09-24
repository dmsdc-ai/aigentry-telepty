'use strict';

// G-GEN  — origin-0 => complete; attach / owner swap / record swap / reconnect / restore =>
//          correct cause and NEVER complete.
// G-GAP  — gap, duplicate/backward overlap, unverifiable overlap, explicit drop.
// G-STALE— disconnected owner is never `current`.
// G-OLD  — old daemon (no route) and old bridge (no U1/U2) degrade honestly.
//
// Contract §5, §6, §7, §9; controller corrections 3 and 4.
// Terminal: REAL @xterm/headless 6.0.0 (seam ACTUAL) throughout.

const test = require('node:test');
const assert = require('node:assert');

const H = require('./helpers/vt-harness');

const vt = H.loadVt();

const real = () => H.realTerminalCtor();

// ---------------------------------------------------------------------------
// G-GEN — the two real origin paths
// ---------------------------------------------------------------------------

test('G-GEN: direct spawn (origin 0, local_pty geometry) reaches complete + vt_grid', async () => {
  const screen = new vt.SessionScreen({
    sessionId: 'gen-local',
    cause: 'stream_origin',
    localSource: true,
    geometrySource: 'local_pty',
    cols: 80,
    rows: 24,
    terminalFactory: real(),
  });
  screen.noteOutput('$ ');
  const frame = await H.frameAfterDrain(screen);

  assert.strictEqual(frame.completeness, 'complete');
  assert.strictEqual(frame.generation_cause, 'stream_origin');
  assert.strictEqual(frame.geometry_source, 'local_pty');
  assert.strictEqual(frame.continuity, 'verified');
  assert.strictEqual(frame.freshness, 'current');
  assert.deepStrictEqual(frame.degraded_reasons, []);
  assert.strictEqual(frame.observation_basis, 'vt_grid');
  assert.strictEqual(frame.dropped_units, 0);
  screen.dispose();
});

test('G-GEN: wrapped bridge reaches complete only with geometry-at-0 AND offset-0', async () => {
  const screen = new vt.SessionScreen({
    sessionId: 'gen-bridge', cause: 'stream_origin', streamId: 'sid-1', terminalFactory: real(),
  });
  screen.noteGeometry({ cols: 100, rows: 30, streamId: 'sid-1', atUnits: 0, source: 'bridge_reported' });
  screen.noteOutput('first unit of this child', { stream_id: 'sid-1', stream_offset: 0 });
  const frame = await H.frameAfterDrain(screen);

  assert.strictEqual(frame.completeness, 'complete');
  assert.strictEqual(frame.geometry_source, 'bridge_reported');
  assert.strictEqual(frame.continuity, 'verified');
  assert.strictEqual(frame.observation_basis, 'vt_grid');
  assert.strictEqual(frame.cols, 100);
  screen.dispose();
});

test('G-GEN: attaching mid-stream is partial_since_attach, permanently', async () => {
  const screen = new vt.SessionScreen({
    sessionId: 'gen-attach', cause: 'attached_mid_stream', streamId: 'sid-2', terminalFactory: real(),
  });
  screen.noteGeometry({ cols: 80, rows: 24, streamId: 'sid-2', atUnits: 5000, source: 'bridge_reported' });
  screen.noteOutput('...mid-stream text', { stream_id: 'sid-2', stream_offset: 5000 });
  let frame = await H.frameAfterDrain(screen);
  assert.strictEqual(frame.completeness, 'partial_since_attach');
  assert.strictEqual(frame.observation_basis, 'vt_grid_degraded', 'a real grid, honestly qualified');

  // No amount of subsequent well-formed, contiguous, verified traffic manufactures completeness.
  let offset = 5000 + '...mid-stream text'.length;
  for (let i = 0; i < 5; i += 1) {
    const payload = `line ${i}\r\n`;
    screen.noteOutput(payload, { stream_id: 'sid-2', stream_offset: offset });
    offset += payload.length;
  }
  frame = await H.frameAfterDrain(screen);
  assert.strictEqual(frame.completeness, 'partial_since_attach', 'sticky for the life of the generation');
  assert.strictEqual(frame.continuity, 'verified', 'contiguity IS verifiable; completeness still is not');
  assert.strictEqual(frame.observation_basis, 'vt_grid_degraded');
  screen.dispose();
});

test('G-GEN: an offset-0 claim on a NON origin-eligible cause never yields complete', async () => {
  for (const cause of ['owner_replaced', 'record_replaced', 'restored']) {
    const screen = new vt.SessionScreen({
      sessionId: `gen-${cause}`,
      cause,
      streamId: 'sid-x',
      cols: 80,
      rows: 24,
      geometrySource: 'bridge_reported',
      terminalFactory: real(),
    });
    // The bridge asserts a pristine origin. It is not believed.
    screen.noteOutput('pretend origin', { stream_id: 'sid-x', stream_offset: 0 });
    // eslint-disable-next-line no-await-in-loop
    const frame = await H.frameAfterDrain(screen);

    assert.strictEqual(frame.generation_cause, cause);
    assert.notStrictEqual(frame.completeness, 'complete', `${cause} must never be complete`);
    assert.notStrictEqual(frame.observation_basis, 'vt_grid');
    if (cause === 'restored') assert.strictEqual(frame.completeness, 'partial_since_restore');
    else assert.strictEqual(frame.completeness, 'partial_since_attach');
    screen.dispose();
  }
});

test('G-GEN: a new stream_id creates a generation and does NOT create an origin (correction 3)', async () => {
  const screen = new vt.SessionScreen({
    sessionId: 'gen-restart', cause: 'stream_origin', streamId: 'sid-old', terminalFactory: real(),
  });
  screen.noteGeometry({ cols: 40, rows: 5, streamId: 'sid-old', atUnits: 0, source: 'bridge_reported' });
  screen.noteOutput('old child output', { stream_id: 'sid-old', stream_offset: 0 });
  const before = await H.frameAfterDrain(screen);
  assert.strictEqual(before.completeness, 'complete');

  // Auto-restart respawn: a new stream_id, offset 0 — but NO geometry stated for the new child.
  screen.noteOutput('new child output', { stream_id: 'sid-new', stream_offset: 0 });
  const after = await H.frameAfterDrain(screen);

  assert.strictEqual(after.vt_generation, before.vt_generation + 1);
  assert.strictEqual(after.generation_cause, 'stream_changed');
  assert.strictEqual(after.stream_id, 'sid-new');
  assert.strictEqual(after.completeness, 'partial_since_attach',
    'offset 0 alone is not an origin: geometry was not known before the first unit');
  assert.strictEqual(after.observation_basis, 'vt_grid_degraded');
  assert.ok(!H.screenText(after).includes('old child'), 'the new generation starts from a fresh grid');
  screen.dispose();
});

test('G-GEN: a respawn that DOES state geometry before unit 0 is a genuine origin', async () => {
  const screen = new vt.SessionScreen({
    sessionId: 'gen-respawn', cause: 'stream_origin', streamId: 'sid-old', terminalFactory: real(),
  });
  screen.noteGeometry({ cols: 40, rows: 5, streamId: 'sid-old', atUnits: 0, source: 'bridge_reported' });
  screen.noteOutput('old', { stream_id: 'sid-old', stream_offset: 0 });
  await H.frameAfterDrain(screen);

  // cli.js spawnChild: new stream_id, stream_offset reset to 0, geometry emitted BEFORE onData.
  screen.noteGeometry({ cols: 90, rows: 20, streamId: 'sid-new', atUnits: 0, source: 'bridge_reported' });
  screen.noteOutput('brand new child', { stream_id: 'sid-new', stream_offset: 0 });
  const frame = await H.frameAfterDrain(screen);

  assert.strictEqual(frame.generation_cause, 'stream_changed');
  assert.strictEqual(frame.completeness, 'complete',
    'a positively attested origin-0 with geometry known first IS complete, whatever created the generation');
  assert.strictEqual(frame.observation_basis, 'vt_grid');
  assert.strictEqual(frame.cols, 90);
  screen.dispose();
});

test('G-GEN: `restored` is sticky across every later generation on the record', async () => {
  const screen = new vt.SessionScreen({
    sessionId: 'gen-restored',
    cause: 'restored',
    restoredRecord: true,
    terminalFactory: real(),
  });
  let frame = await H.frameAfterDrain(screen);
  assert.strictEqual(frame.completeness, 'partial_since_restore');

  // A later owner really does attach, and later still a pristine-looking origin is claimed.
  screen.newGeneration('owner_replaced', { cols: 80, rows: 24, geometrySource: 'bridge_reported' });
  frame = await H.frameAfterDrain(screen);
  assert.strictEqual(frame.generation_cause, 'owner_replaced', 'the CAUSE stays accurate');
  assert.strictEqual(frame.completeness, 'partial_since_restore', 'the restore floor survives');

  screen.newGeneration('stream_origin', {
    cols: 80, rows: 24, geometrySource: 'local_pty', localSource: true, streamId: 'sid-z',
  });
  screen.noteOutput('looks pristine');
  frame = await H.frameAfterDrain(screen);
  assert.strictEqual(frame.completeness, 'partial_since_restore',
    'no VT state survived the restart; nothing may climb back to complete');
  assert.notStrictEqual(frame.observation_basis, 'vt_grid');
  screen.dispose();
});

test('G-GEN: a superseded generation`s callbacks update nothing', async () => {
  const screen = new vt.SessionScreen({
    sessionId: 'gen-fence',
    cause: 'stream_origin',
    localSource: true,
    geometrySource: 'local_pty',
    cols: 20,
    rows: 3,
    terminalFactory: real(),
  });
  // Enqueue a lot, then rotate before any of it can be acknowledged.
  for (let i = 0; i < 50; i += 1) screen.noteOutput(`stale-${i}\r\n`);
  screen.newGeneration('owner_replaced', { cols: 20, rows: 3, geometrySource: 'bridge_reported' });
  screen.noteOutput('fresh only');

  const frame = await H.frameAfterDrain(screen);
  assert.strictEqual(frame.generation_cause, 'owner_replaced');
  assert.strictEqual(frame.rows_text[0], 'fresh only');
  assert.strictEqual(frame.observed_units, 'fresh only'.length,
    'the superseded generation`s units did not leak into the live accounting');
  assert.strictEqual(frame.applied_units, 'fresh only'.length);
  assert.ok(!H.screenText(frame).includes('stale-'));
  screen.dispose();
});

// ---------------------------------------------------------------------------
// G-GAP
// ---------------------------------------------------------------------------

function bridgeScreen(sessionId, cols = 40, rows = 6) {
  const screen = new vt.SessionScreen({
    sessionId, cause: 'stream_origin', streamId: 'sid', terminalFactory: real(),
  });
  screen.noteGeometry({ cols, rows, streamId: 'sid', atUnits: 0, source: 'bridge_reported' });
  return screen;
}

test('G-GAP: a forward jump is a gap of exactly that many units, sticky', async () => {
  const screen = bridgeScreen('gap-forward');
  screen.noteOutput('0123456789', { stream_id: 'sid', stream_offset: 0 });
  let frame = await H.frameAfterDrain(screen);
  assert.strictEqual(frame.completeness, 'complete');
  assert.strictEqual(frame.dropped_units, 0);

  // Next frame claims offset 100; the queue is at 10. Exactly 90 units are known lost.
  screen.noteOutput('AFTER', { stream_id: 'sid', stream_offset: 100 });
  frame = await H.frameAfterDrain(screen);

  assert.strictEqual(frame.dropped_units, 90, 'the gap is measured, not estimated');
  assert.strictEqual(frame.completeness, 'partial_after_loss');
  H.assertReason(frame, 'gap');
  assert.strictEqual(frame.observation_basis, 'vt_grid_degraded');

  // Sticky: clean contiguous traffic afterwards does not heal it.
  screen.noteOutput('MORE', { stream_id: 'sid', stream_offset: 105 });
  frame = await H.frameAfterDrain(screen);
  assert.strictEqual(frame.completeness, 'partial_after_loss');
  assert.strictEqual(frame.dropped_units, 90);
  screen.dispose();
});

test('G-GAP: an exact replay is discarded — the grid is NOT mutated twice', async () => {
  const screen = bridgeScreen('gap-replay', 20, 3);
  screen.noteOutput('abc', { stream_id: 'sid', stream_offset: 0 });
  const before = await H.frameAfterDrain(screen);
  assert.strictEqual(before.rows_text[0], 'abc');
  assert.strictEqual(before.observed_units, 3);

  screen.noteOutput('abc', { stream_id: 'sid', stream_offset: 0 });   // the same units again
  const after = await H.frameAfterDrain(screen);

  assert.strictEqual(after.rows_text[0], 'abc', 'not "abcabc" — the replay never reached the parser');
  assert.strictEqual(after.observed_units, 3, 'and it was not counted twice');
  assert.strictEqual(after.continuity, 'verified', 'a verified-equal replay is not a fault');
  assert.strictEqual(after.completeness, 'complete');
  screen.dispose();
});

test('G-GAP: a partial backward overlap discards only the overlapping prefix', async () => {
  const screen = bridgeScreen('gap-partial', 40, 3);
  screen.noteOutput('ABCDEFGHIJ', { stream_id: 'sid', stream_offset: 0 });
  await H.frameAfterDrain(screen);

  // Resent from offset 5: FGHIJ is a replay, KLMNO is new.
  screen.noteOutput('FGHIJKLMNO', { stream_id: 'sid', stream_offset: 5 });
  const frame = await H.frameAfterDrain(screen);

  assert.strictEqual(frame.rows_text[0], 'ABCDEFGHIJKLMNO', 'exactly once each, in order');
  assert.strictEqual(frame.observed_units, 15);
  assert.strictEqual(frame.continuity, 'verified');
  assert.strictEqual(frame.completeness, 'complete');
  screen.dispose();
});

test('G-GAP: a backward overlap that DISAGREES is conflicting and sticky (correction 4)', async () => {
  const screen = bridgeScreen('gap-conflict', 40, 3);
  screen.noteOutput('ABCDEFGHIJ', { stream_id: 'sid', stream_offset: 0 });
  await H.frameAfterDrain(screen);

  screen.noteOutput('XXXXXKLMNO', { stream_id: 'sid', stream_offset: 5 });   // FGHIJ != XXXXX
  const frame = await H.frameAfterDrain(screen);

  H.assertReason(frame, 'overlap_conflict');
  assert.strictEqual(frame.continuity, 'conflicting');
  assert.strictEqual(frame.completeness, 'partial_after_loss');
  assert.strictEqual(frame.observation_basis, 'vt_grid_degraded');

  // Sticky: a later well-formed contiguous frame does not restore `verified`.
  screen.noteOutput('ZZ', { stream_id: 'sid', stream_offset: 15 });
  const later = await H.frameAfterDrain(screen);
  assert.strictEqual(later.continuity, 'conflicting');
  assert.strictEqual(later.completeness, 'partial_after_loss');
  screen.dispose();
});

test('G-GAP: an overlap reaching before the retained window degrades, never claims equality', async () => {
  const window = vt.VT_LIMITS.VT_OVERLAP_WINDOW_UNITS;
  assert.strictEqual(window, 65536);

  const screen = bridgeScreen('gap-unverifiable', 20, 4);
  const bulk = 'x'.repeat(window + 4096);          // ~70 KiB units, well inside the 5 MiB bound
  screen.noteOutput(bulk, { stream_id: 'sid', stream_offset: 0 });
  await H.frameAfterDrain(screen);

  // Offset 0 is now older than the bounded retained tail, so equality CANNOT be checked.
  screen.noteOutput('xxxx', { stream_id: 'sid', stream_offset: 0 });
  const frame = await H.frameAfterDrain(screen);

  H.assertReason(frame, 'overlap_unverifiable');
  assert.strictEqual(frame.continuity, 'unverified');
  H.assertNoReason(frame, 'overlap_conflict');
  assert.strictEqual(frame.observation_basis, 'vt_grid_degraded');
  screen.dispose();
});

test('G-GAP: an explicit `dropped` op records the loss at its exact position', async () => {
  const screen = bridgeScreen('gap-explicit', 30, 3);
  screen.noteOutput('before', { stream_id: 'sid', stream_offset: 0 });
  await H.frameAfterDrain(screen);

  // The bridge's pre-connect hold overflowed and says so, rather than sending a contiguous lie.
  screen.noteDropped({ streamId: 'sid', fromUnits: 6, toUnits: 262150 });
  screen.noteOutput('after', { stream_id: 'sid', stream_offset: 262150 });
  const frame = await H.frameAfterDrain(screen);

  assert.strictEqual(frame.dropped_units, 262144, 'the stated range, exactly');
  H.assertReason(frame, 'explicit_drop');
  assert.strictEqual(frame.completeness, 'partial_after_loss');
  H.assertNoReason(frame, 'gap', 'an explicit drop is not ALSO counted as an inferred gap');
  assert.strictEqual(H.visibleRows(frame).join(''), 'beforeafter');
  screen.dispose();
});

test('G-GAP: a malformed drop message is still recorded as loss, not discarded', async () => {
  const screen = bridgeScreen('gap-baddrop', 20, 3);
  screen.noteOutput('x', { stream_id: 'sid', stream_offset: 0 });
  screen.noteDropped({ streamId: 'sid', fromUnits: 50, toUnits: 10 });    // to < from
  const frame = await H.frameAfterDrain(screen);

  H.assertReason(frame, 'drop_bounds_invalid');
  assert.strictEqual(frame.completeness, 'partial_after_loss');
  screen.dispose();
});

test('G-GAP: an empty drop message is a statement of loss of unknown size', async () => {
  const screen = bridgeScreen('gap-emptydrop', 20, 3);
  screen.noteOutput('x', { stream_id: 'sid', stream_offset: 0 });
  screen.noteDropped({});
  const frame = await H.frameAfterDrain(screen);
  H.assertReason(frame, 'drop_bounds_invalid');
  assert.strictEqual(frame.completeness, 'partial_after_loss');
  assert.strictEqual(frame.dropped_units, 0, 'unknown size is not invented as a number');
  screen.dispose();
});

// ---------------------------------------------------------------------------
// G-STALE
// ---------------------------------------------------------------------------

test('G-STALE: a disconnected owner is never `current`, however drained the queue is', async () => {
  const screen = bridgeScreen('stale', 20, 3);
  screen.noteOutput('all applied', { stream_id: 'sid', stream_offset: 0 });

  const live = await H.frameAfterDrain(screen);
  assert.strictEqual(live.freshness, 'current');
  assert.strictEqual(live.observation_basis, 'vt_grid');

  const stale = await screen.readFrame({ ownerDisconnected: true });
  assert.strictEqual(stale.lag_units, 0, 'the counters are equal...');
  assert.strictEqual(stale.freshness, 'stale_owner_disconnected', '...and it still is not current');
  assert.strictEqual(stale.observation_basis, 'vt_grid_degraded');
  assert.strictEqual(stale.rows_text[0], 'all applied', 'the grid is still returned, honestly qualified');
  screen.dispose();
});

// ---------------------------------------------------------------------------
// G-OLD
// ---------------------------------------------------------------------------

test('G-OLD: an old bridge (no U1/U2 fields) is permanently unverified, never complete', async () => {
  const screen = new vt.SessionScreen({
    sessionId: 'old-bridge',
    cause: 'stream_origin',
    cols: 80,
    rows: 24,
    geometrySource: 'bridge_reported',
    terminalFactory: real(),
  });
  // relayPtyOutput as it exists today: `{type:'output', data}` and nothing else.
  screen.noteOutput('legacy bridge output');
  screen.noteOutput(' more legacy output');
  const frame = await H.frameAfterDrain(screen);

  assert.strictEqual(frame.continuity, 'unverified');
  assert.notStrictEqual(frame.completeness, 'complete');
  assert.strictEqual(frame.observation_basis, 'vt_grid_degraded',
    'a real grid is still served — degraded, never a fabricated complete');
  assert.match(H.screenText(frame), /legacy bridge output more legacy output/);
  screen.dispose();
});

test('G-OLD: a record with no VT at all reads as `unavailable`, never null and never a throw', async () => {
  const frame = await vt.readSessionFrame({ id: 'no-vt' });
  assert.strictEqual(frame.observation_basis, 'unavailable');
  assert.deepStrictEqual(frame.degraded_reasons, ['no_vt_observation']);
  assert.strictEqual(frame.completeness, 'partial_since_attach');
  assert.strictEqual(frame.rows_text.length, 0);
  assert.strictEqual(frame.cols, null);
  assert.strictEqual(frame.unit, 'utf16_code_unit');

  // Nothing synthesises a state from an absent frame.
  assert.notStrictEqual(frame.completeness, 'complete');
  assert.notStrictEqual(frame.freshness, 'current');
});

test('G-OLD: a restored record with no VT says BOTH why it is unavailable and that it was restored', async () => {
  const frame = await vt.readSessionFrame({ id: 'restored-no-vt', vtRestored: true });
  assert.strictEqual(frame.observation_basis, 'unavailable');
  assert.deepStrictEqual(frame.degraded_reasons, ['no_vt_observation', 'restored_no_vt_state']);
  assert.strictEqual(frame.completeness, 'partial_since_restore');
  assert.strictEqual(frame.generation_cause, 'restored');
});

test('§5: record helpers read the restore fact off the RECORD, so no call site can forget it', async () => {
  const session = { id: 'rec-1', vtRestored: true };
  vt.ensureSessionScreen(session, {
    cause: 'stream_origin', localSource: true, geometrySource: 'local_pty', cols: 80, rows: 24,
  });
  vt.noteSessionOutput(session, 'text');
  const frame = await vt.readSessionFrame(session);

  assert.strictEqual(frame.completeness, 'partial_since_restore',
    'the caller asked for a pristine origin; the record overrode it');
  assert.notStrictEqual(frame.observation_basis, 'vt_grid');
  vt.disposeSessionScreen(session);
  assert.strictEqual(session.vtScreen, null);
});

test('record helpers are TOTAL: they never throw into the terminal path', async () => {
  // Every one of these is a call site mistake; none may propagate.
  assert.doesNotThrow(() => vt.noteSessionOutput(null, 'x'));
  assert.doesNotThrow(() => vt.noteSessionGeometry(undefined, { cols: 1, rows: 1 }));
  assert.doesNotThrow(() => vt.noteSessionDropped({}, { fromUnits: 0, toUnits: 1 }));
  assert.doesNotThrow(() => vt.disposeSessionScreen(null));
  assert.strictEqual(vt.ensureSessionScreen(null), null);
  assert.strictEqual(vt.rotateSessionScreen(undefined, 'restored'), null);

  const session = { id: 'total' };
  vt.ensureSessionScreen(session, { cols: 10, rows: 2, geometrySource: 'local_pty', localSource: true });
  assert.doesNotThrow(() => vt.noteSessionOutput(session, { not: 'a string' }));
  const frame = await vt.readSessionFrame(session);
  H.assertReason(frame, 'invalid_output_payload');
  vt.disposeSessionScreen(session);
});
