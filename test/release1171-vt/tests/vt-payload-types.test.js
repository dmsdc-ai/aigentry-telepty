'use strict';

// ---------------------------------------------------------------------------
// G-TYPE — frame payload TYPE validation   (vg1136am, controller-authorized)
// ---------------------------------------------------------------------------
//
// ORACLE-CORRECTION.md:
//
//   "String atUnits=\"0\" is a REAL strictnumeric defect: KEEP hard failing assertion.
//    vn1136an separatecoder fixes numeric offset coercion only. Add focused number-versus-
//    string/boolean/array/object cases for output/geometry/drop fields per original safeinteger+
//    payloadtype requirement. Optional absent/null behavior must remain unknown/unverified, not
//    proof of 0."
//
// Controller correction 2 (original): "All offsets are UTF16 code units. Validate safe integers
// AND frame payload types; bounds must also cover stream_id lengths, queued operation count and
// empty geometry/drop messages, not only queued string units."
//
// THE RULE UNDER TEST, stated once:
//
//   A numeric protocol field is valid ONLY when its JSON type is `number` AND its value is a safe
//   non-negative integer. `"0"`, `true`, `[0]`, `{}` are not numbers; they are malformed payloads.
//   A malformed payload may never produce a qualified observation, and — separately — may never be
//   silently COERCED into a different stream fact (a gap, an overlap, a boundary) that did not
//   occur. Reporting `"5"` as `overlap_unverifiable`, or `true` as a one-unit `gap`, is a
//   different lie from the one being told, not a fix.
//
//   ABSENT and null are NOT malformed: contract §6 says an old bridge simply sends neither field,
//   and §6's daemon rule is "either field absent => continuity: unverified". So absent/null must
//   read as unknown/unverified — never as a malformed-payload error, and never as proof of 0.
//
// SEAM: the REAL pinned @xterm/headless 6.0.0 Terminal throughout (seam ACTUAL). No fake.

const test = require('node:test');
const assert = require('node:assert');

const H = require('./helpers/vt-harness');

const vt = H.loadVt();

// Values that are NOT a JSON number. Each must be rejected as a payload-type violation.
const NON_NUMBERS = [
  ['string-zero', '0'],
  ['string-int', '5'],
  ['string-empty', ''],
  ['string-word', 'abc'],
  ['boolean-true', true],
  ['boolean-false', false],
  ['array-empty', []],
  ['array-int', [0]],
  ['object-empty', {}],
  ['object-valued', { value: 0 }],
];

// Values that ARE numbers but not safe non-negative integers.
const BAD_NUMBERS = [
  ['negative', -1],
  ['fractional', 1.5],
  ['nan', Number.NaN],
  ['infinity', Number.POSITIVE_INFINITY],
  ['unsafe', Number.MAX_SAFE_INTEGER + 2],
];

function bridgeScreen(sessionId) {
  return new vt.SessionScreen({
    sessionId, cause: 'stream_origin', streamId: 'sid-A', terminalFactory: H.realTerminalCtor(),
  });
}

function qualified(frame) {
  return frame.completeness === 'complete' && frame.observation_basis === 'vt_grid';
}

// ---------------------------------------------------------------------------
// geometry.at_units  (U1)
// ---------------------------------------------------------------------------

test('G-TYPE/geometry: a non-number at_units is a payload-type violation, never a qualified frame', async () => {
  const bad = [];
  for (const [label, value] of NON_NUMBERS) {
    const screen = bridgeScreen(`type-at-${label}`);
    screen.noteGeometry({ cols: 33, rows: 6, streamId: 'sid-A', atUnits: value, source: 'bridge_reported' });
    screen.noteOutput('HELLO', { stream_id: 'sid-A', stream_offset: 0 });
    // eslint-disable-next-line no-await-in-loop
    const f = await H.frameAfterDrain(screen);
    if (qualified(f)) {
      bad.push(`at_units=${JSON.stringify(value)} (${label}) => ${f.completeness}/${f.observation_basis}`);
    }
    screen.dispose();
  }
  assert.deepStrictEqual(bad, [],
    'a non-number at_units must never yield complete + vt_grid:\n  ' + bad.join('\n  '));
});

test('G-TYPE/geometry: a non-number at_units is named as a TYPE error, not as a stream anomaly', async () => {
  // The distinction matters: `overlap_unverifiable` and `gap` are statements ABOUT THE STREAM.
  // Emitting one for a malformed payload asserts a stream fact that was never observed.
  const STREAM_FACTS = ['gap', 'overlap_conflict', 'overlap_unverifiable', 'explicit_drop'];
  const wrong = [];
  for (const [label, value] of NON_NUMBERS) {
    const screen = bridgeScreen(`type-at-reason-${label}`);
    screen.noteGeometry({ cols: 33, rows: 6, streamId: 'sid-A', atUnits: value, source: 'bridge_reported' });
    screen.noteOutput('HELLO', { stream_id: 'sid-A', stream_offset: 0 });
    // eslint-disable-next-line no-await-in-loop
    const f = await H.frameAfterDrain(screen);
    const claimed = f.degraded_reasons.filter((r) => STREAM_FACTS.includes(r));
    if (claimed.length) {
      wrong.push(`at_units=${JSON.stringify(value)} (${label}) => claims ${JSON.stringify(claimed)}`);
    }
    screen.dispose();
  }
  assert.deepStrictEqual(wrong, [],
    'a malformed at_units must not be reported as an observed stream fact:\n  ' + wrong.join('\n  '));
});

test('G-TYPE/geometry: a number at_units that is not a safe non-negative integer is rejected', async () => {
  for (const [label, value] of BAD_NUMBERS) {
    const screen = bridgeScreen(`type-at-num-${label}`);
    screen.noteGeometry({ cols: 33, rows: 6, streamId: 'sid-A', atUnits: value, source: 'bridge_reported' });
    screen.noteOutput('HELLO', { stream_id: 'sid-A', stream_offset: 0 });
    // eslint-disable-next-line no-await-in-loop
    const f = await H.frameAfterDrain(screen);
    assert.ok(!qualified(f), `at_units=${label} must not qualify; got ${f.completeness}/${f.observation_basis}`);
    screen.dispose();
  }
});

// ---------------------------------------------------------------------------
// output.stream_offset  (U2)
// ---------------------------------------------------------------------------

test('G-TYPE/output: a non-number stream_offset is a payload-type violation, never a qualified frame', async () => {
  const bad = [];
  for (const [label, value] of NON_NUMBERS) {
    const screen = bridgeScreen(`type-off-${label}`);
    screen.noteGeometry({ cols: 33, rows: 6, streamId: 'sid-A', atUnits: 0, source: 'bridge_reported' });
    screen.noteOutput('HELLO', { stream_id: 'sid-A', stream_offset: value });
    // eslint-disable-next-line no-await-in-loop
    const f = await H.frameAfterDrain(screen);
    if (qualified(f)) {
      bad.push(`stream_offset=${JSON.stringify(value)} (${label}) => ${f.completeness}/${f.observation_basis}`);
    }
    screen.dispose();
  }
  assert.deepStrictEqual(bad, [],
    'a non-number stream_offset must never yield complete + vt_grid:\n  ' + bad.join('\n  '));
});

test('G-TYPE/output: a non-number stream_offset is never coerced into a gap or an overlap', async () => {
  const STREAM_FACTS = ['gap', 'overlap_conflict', 'overlap_unverifiable'];
  const wrong = [];
  for (const [label, value] of NON_NUMBERS) {
    const screen = bridgeScreen(`type-off-reason-${label}`);
    screen.noteGeometry({ cols: 33, rows: 6, streamId: 'sid-A', atUnits: 0, source: 'bridge_reported' });
    screen.noteOutput('HELLO', { stream_id: 'sid-A', stream_offset: value });
    // eslint-disable-next-line no-await-in-loop
    const f = await H.frameAfterDrain(screen);
    const claimed = f.degraded_reasons.filter((r) => STREAM_FACTS.includes(r));
    if (claimed.length || f.dropped_units > 0) {
      wrong.push(`stream_offset=${JSON.stringify(value)} (${label}) => reasons ${JSON.stringify(claimed)}`
        + `, dropped_units=${f.dropped_units}`);
    }
    screen.dispose();
  }
  assert.deepStrictEqual(wrong, [],
    'a malformed stream_offset must not manufacture loss that did not occur:\n  ' + wrong.join('\n  '));
});

test('G-TYPE/output: a number stream_offset that is not a safe non-negative integer is rejected', async () => {
  for (const [label, value] of BAD_NUMBERS) {
    const screen = bridgeScreen(`type-off-num-${label}`);
    screen.noteGeometry({ cols: 33, rows: 6, streamId: 'sid-A', atUnits: 0, source: 'bridge_reported' });
    screen.noteOutput('HELLO', { stream_id: 'sid-A', stream_offset: value });
    // eslint-disable-next-line no-await-in-loop
    const f = await H.frameAfterDrain(screen);
    assert.ok(!qualified(f), `stream_offset=${label} must not qualify; got ${f.completeness}/${f.observation_basis}`);
    screen.dispose();
  }
});

// ---------------------------------------------------------------------------
// dropped.from_units / to_units
// ---------------------------------------------------------------------------

test('G-TYPE/drop: non-number drop bounds are rejected and never qualify', async () => {
  const bad = [];
  for (const [label, value] of NON_NUMBERS) {
    for (const field of ['fromUnits', 'toUnits']) {
      const screen = bridgeScreen(`type-drop-${field}-${label}`);
      screen.noteGeometry({ cols: 33, rows: 6, streamId: 'sid-A', atUnits: 0, source: 'bridge_reported' });
      screen.noteOutput('HELLO', { stream_id: 'sid-A', stream_offset: 0 });
      const drop = { streamId: 'sid-A', fromUnits: 5, toUnits: 12 };
      drop[field] = value;
      screen.noteDropped(drop);
      // eslint-disable-next-line no-await-in-loop
      const f = await H.frameAfterDrain(screen);
      // A drop is a declaration of LOSS. A malformed one must degrade — it may never leave the
      // observation qualified, because the honest answer is "loss of unknown extent".
      if (qualified(f)) {
        bad.push(`${field}=${JSON.stringify(value)} (${label}) => ${f.completeness}/${f.observation_basis}`);
      }
      screen.dispose();
    }
  }
  assert.deepStrictEqual(bad, [],
    'a malformed drop declaration must never leave the frame qualified:\n  ' + bad.join('\n  '));
});

test('G-TYPE/drop: a well-formed drop still degrades, so the malformed cases are not vacuous', async () => {
  const screen = bridgeScreen('type-drop-control');
  screen.noteGeometry({ cols: 33, rows: 6, streamId: 'sid-A', atUnits: 0, source: 'bridge_reported' });
  screen.noteOutput('HELLO', { stream_id: 'sid-A', stream_offset: 0 });
  screen.noteDropped({ streamId: 'sid-A', fromUnits: 5, toUnits: 12 });
  const f = await H.frameAfterDrain(screen);

  assert.strictEqual(f.completeness, 'partial_after_loss', 'declared loss is recorded as loss');
  assert.ok(f.degraded_reasons.length > 0, 'and it is named');
  screen.dispose();
});

// ---------------------------------------------------------------------------
// ABSENT / null — unknown, NOT malformed, and NOT proof of 0
// ---------------------------------------------------------------------------

test('G-TYPE/absent: omitted U2 fields read as unverified — never verified, never a fabricated origin', async () => {
  // Contract §6: an old bridge sends neither field; "either field absent => continuity:
  // unverified". This is the G-OLD path and must stay exactly that — not a type error.
  const screen = bridgeScreen('type-absent');
  screen.noteGeometry({ cols: 33, rows: 6, streamId: 'sid-A', atUnits: 0, source: 'bridge_reported' });
  screen.noteOutput('HELLO');                       // no meta at all
  const f = await H.frameAfterDrain(screen);

  assert.strictEqual(f.continuity, 'unverified', 'absent U2 is unknown, not verified');
  assert.notStrictEqual(f.completeness, 'complete', 'absence is not proof of offset 0');
  assert.notStrictEqual(f.observation_basis, 'vt_grid');
  // It is unknown, not malformed: the invalid-payload reasons must NOT fire.
  for (const r of ['invalid_stream_offset', 'invalid_stream_id', 'invalid_output_payload']) {
    H.assertNoReason(f, r);
  }
  screen.dispose();
});

test('G-TYPE/absent: a null stream_offset is unknown, not zero and not a type error', async () => {
  const screen = bridgeScreen('type-null-off');
  screen.noteGeometry({ cols: 33, rows: 6, streamId: 'sid-A', atUnits: 0, source: 'bridge_reported' });
  screen.noteOutput('HELLO', { stream_id: 'sid-A', stream_offset: null });
  const f = await H.frameAfterDrain(screen);

  assert.strictEqual(f.continuity, 'unverified', 'null is absent, so continuity is unverified');
  assert.notStrictEqual(f.completeness, 'complete', 'null may never be read as a proven origin at 0');
  assert.notStrictEqual(f.observation_basis, 'vt_grid');
  H.assertNoReason(f, 'invalid_stream_offset');
  assert.strictEqual(f.dropped_units, 0, 'and it manufactures no loss');
  screen.dispose();
});

test('G-TYPE/absent: a BRIDGE-reported geometry with no at_units is unverified, never a self-stamped origin (F5)', async () => {
  // ORACLE-CORRECTION.md: "Optional absent/null behavior must remain unknown/unverified, not
  // proof of 0."
  //
  // `atUnits: null` is documented as the LOCAL producer stamping its own boundary — the daemon
  // issued that resize, so it genuinely knows the stream position. A `bridge_reported` geometry
  // is the opposite case: contract §6 defines `at_units` as "the bridge's stream offset at the
  // moment it applied the resize", and §7 requires that boundary to be CHECKED against the
  // queue. If the bridge did not state it, the daemon did not observe it, and §6's own rule for a
  // field the bridge omitted is `unverified` — not a boundary the daemon invents for it.
  for (const [label, geo] of [
    ['null', { cols: 33, rows: 6, streamId: 'sid-A', atUnits: null, source: 'bridge_reported' }],
    ['absent', { cols: 33, rows: 6, streamId: 'sid-A', source: 'bridge_reported' }],
  ]) {
    const screen = bridgeScreen(`type-bridge-noat-${label}`);
    screen.noteGeometry(geo);
    screen.noteOutput('HELLO', { stream_id: 'sid-A', stream_offset: 0 });
    // eslint-disable-next-line no-await-in-loop
    const f = await H.frameAfterDrain(screen);

    assert.ok(!qualified(f),
      `at_units ${label} on a bridge_reported geometry must not qualify the frame; `
      + `got ${f.completeness}/${f.observation_basis} geometry_source=${f.geometry_source}`);
    assert.notStrictEqual(f.completeness, 'complete',
      'an unstated bridge boundary is unknown, never proof of 0');
    screen.dispose();
  }
});

test('G-TYPE/absent: a null geometry at_units is the local-producer self-stamp, not a malformed payload', async () => {
  // The module's own API documents `atUnits: null` as "the module stamps the boundary itself
  // (local producer)". That path must stay valid and must not be confused with a type error.
  const screen = new vt.SessionScreen({
    sessionId: 'type-null-at',
    cause: 'stream_origin',
    localSource: true,
    geometrySource: 'local_pty',
    cols: 80,
    rows: 24,
    terminalFactory: H.realTerminalCtor(),
  });
  screen.noteOutput('$ ');
  screen.noteGeometry({ cols: 100, rows: 30, atUnits: null, source: 'local_pty' });
  const f = await H.frameAfterDrain(screen);

  assert.strictEqual(f.cols, 100, 'the local producer self-stamps its own boundary');
  assert.strictEqual(f.rows, 30);
  assert.strictEqual(f.geometry_source, 'local_pty');
  H.assertNoReason(f, 'geometry_at_units_invalid');
  screen.dispose();
});
