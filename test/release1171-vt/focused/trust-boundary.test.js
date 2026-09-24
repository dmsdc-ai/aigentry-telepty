'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../tests/helpers/vt-harness');
const vt = H.loadVt();

// FINAL-RETEST: authority comes from trusted localSource, never a caller source string.
for (const source of ['bridge_reported', 'local_pty']) {
  for (const boundary of ['absent', 'null']) {
    test(`F5 remote source=${source}, atUnits=${boundary} cannot attest origin`, async () => {
      const s = H.makeScreen(vt, { cause: 'stream_origin', streamId: 'sid-A' });
      try {
        const geo = { cols: 33, rows: 6, streamId: 'sid-A', source };
        if (boundary === 'null') geo.atUnits = null;
        s.noteGeometry(geo);
        s.noteOutput('HELLO', { stream_id: 'sid-A', stream_offset: 0 });
        const f = await H.frameAfterDrain(s);
        assert.notEqual(f.completeness, 'complete');
        assert.notEqual(f.observation_basis, 'vt_grid');
        assert.equal(f.geometry_source, 'unverified');
        assert.equal(f.dropped_units, 0);
        H.assertNoReason(f, 'geometry_at_units_invalid');
      } finally { s.dispose(); }
    });
  }
}
for (const boundary of ['absent', 'null']) {
  test(`F5 trusted local producer stamps ${boundary} boundary`, async () => {
    const s = H.makeScreen(vt, { cause: 'stream_origin', localSource: true,
      geometrySource: 'local_pty', cols: 20, rows: 4 });
    try {
      s.noteOutput('HELLO');
      const geo = { cols: 33, rows: 6, source: 'local_pty' };
      if (boundary === 'null') geo.atUnits = null;
      s.noteGeometry(geo);
      const f = await H.frameAfterDrain(s);
      assert.equal(f.cols, 33);
      assert.equal(f.rows, 6);
      assert.equal(f.completeness, 'complete');
      assert.equal(f.observation_basis, 'vt_grid');
      assert.equal(f.geometry_source, 'local_pty');
    } finally { s.dispose(); }
  });
}
test('F4 invalid stream output preserves grid, counters and generation without invented loss', async () => {
  const s = H.makeScreen(vt, { cause: 'stream_origin', streamId: 'sid-A' });
  try {
    s.noteGeometry({ cols: 20, rows: 4, streamId: 'sid-A', atUnits: 0, source: 'bridge_reported' });
    s.noteOutput('ALPHA', { stream_id: 'sid-A', stream_offset: 0 });
    const before = await H.frameAfterDrain(s);
    s.noteOutput('-INJECTED', { stream_id: 'B'.repeat(320), stream_offset: 5 });
    const after = await H.frameAfterDrain(s);
    for (const key of ['rows_text', 'observed_units', 'applied_units', 'dropped_units', 'vt_generation', 'stream_id']) {
      assert.deepEqual(after[key], before[key], key);
    }
    H.assertReason(after, 'invalid_stream_id');
    H.assertNoReason(after, 'gap');
    assert.notEqual(after.observation_basis, 'vt_grid');
  } finally { s.dispose(); }
});
test('OBSERVATION ONLY: invalid noteDropped streamId isolated evidence', async (t) => {
  const s = H.makeScreen(vt, { cause: 'stream_origin', streamId: 'sid-A' });
  try {
    s.noteGeometry({ cols: 20, rows: 4, streamId: 'sid-A', atUnits: 0, source: 'bridge_reported' });
    s.noteOutput('ALPHA', { stream_id: 'sid-A', stream_offset: 0 });
    const before = await H.frameAfterDrain(s);
    s.noteDropped({ streamId: 'B'.repeat(320), fromUnits: 5, toUnits: 12 });
    const after = await H.frameAfterDrain(s);
    t.diagnostic(JSON.stringify({ tree: H.SOURCE_ROOT, before, after }));
    // No acceptance oracle was authorized for this observation.
  } finally { s.dispose(); }
});

test('malformed noteDropped identities and bounds are inert', async () => {
  for (const streamId of ['B'.repeat(320), '', 42]) {
    for (const bounds of [
      { label: 'numeric', fromUnits: 5, toUnits: 12 },
      { label: 'invalid', fromUnits: -1, toUnits: 12 },
    ]) {
      const s = H.makeScreen(vt, { cause: 'stream_origin', streamId: 'sid-A' });
      try {
        s.noteGeometry({ cols: 20, rows: 4, streamId: 'sid-A', atUnits: 0, source: 'bridge_reported' });
        s.noteOutput('ALPHA', { stream_id: 'sid-A', stream_offset: 0 });
        const before = await H.frameAfterDrain(s);
        s.noteDropped({ streamId, ...bounds });
        const after = await H.frameAfterDrain(s);
        for (const key of [
          'rows_text', 'vt_generation', 'stream_id',
          'observed_units', 'applied_units', 'dropped_units',
        ]) {
          assert.deepEqual(after[key], before[key], key);
        }
        assert.equal(after.completeness, before.completeness);
        assert.notEqual(after.continuity, 'verified');
        assert.notEqual(after.observation_basis, 'vt_grid');
        assert.ok(after.degraded_reasons.includes('invalid_stream_id'));
        assert.ok(!after.degraded_reasons.includes('explicit_drop'));
        assert.ok(!after.degraded_reasons.includes('gap'));
      } finally { s.dispose(); }
    }
  }
});
