'use strict';

// G-FRAME / G-SHORT / G-ALT / G-WIDE — the real parser, genuine ANSI, real grid.
//
// Contract §12: "the archived read-screen capture has already lost controls" — every fixture
// below is a GENUINE control sequence authored here, never a replay of dv1172ad.screen.txt.
//
// Terminal: REAL @xterm/headless 6.0.0 (seam ACTUAL, see helpers/vt-harness.js).

const test = require('node:test');
const assert = require('node:assert');

const H = require('./helpers/vt-harness');
const { ANSI } = H;
const { stripAnsiForScreen } = require(`${H.SOURCE_ROOT}/src/screen-ansi.js`);

const vt = H.loadVt();

/** A direct-spawn (local) screen: origin 0, first-hand geometry — the `complete` path. */
function localScreen(cols, rows, sessionId = 'g-frame') {
  return H.makeScreen(vt, {
    sessionId,
    cause: 'stream_origin',
    localSource: true,
    geometrySource: 'local_pty',
    cols,
    rows,
  });
}

// ---------------------------------------------------------------------------
// G-FRAME — the defect and the fix, measured side by side on the same bytes
// ---------------------------------------------------------------------------

test('G-FRAME: a CUP/ED repaint erases stale error+thinking text from the grid', async () => {
  const screen = localScreen(40, 6);

  // 1. History the operator should NOT still be shown: an error and a thinking block.
  const history = [
    'Error: ETIMEDOUT while contacting provider', ANSI.CRLF,
    '* Thinking about the failure...', ANSI.CRLF,
    'stack trace line 1', ANSI.CRLF,
    'stack trace line 2', ANSI.CRLF,
  ].join('');

  // 2. The CLI repaints its surface: clear screen, home, draw the live prompt.
  const repaint = [
    ANSI.HOME, ANSI.ED(2),
    'ready for input', ANSI.CRLF,
    '> ',
  ].join('');

  const raw = history + repaint;
  screen.noteOutput(raw);
  const frame = await H.frameAfterDrain(screen);

  const text = H.screenText(frame);

  // THE FIX: the grid shows the live surface.
  assert.match(text, /ready for input/);
  assert.match(text, /> /);
  // ...and the scrolled-away history is genuinely gone from it.
  assert.doesNotMatch(text, /Thinking/);
  assert.doesNotMatch(text, /ETIMEDOUT/);
  assert.doesNotMatch(text, /stack trace/);

  // THE DEFECT, on the identical bytes, through the UNTOUCHED /screen path. This is the
  // baseline the module exists to fix; asserting it here proves the two paths really differ
  // and that the fixture is a real repaint, not a trivially empty stream.
  const viaScreenEndpoint = stripAnsiForScreen(raw);
  assert.match(viaScreenEndpoint, /Thinking/, '/screen still returns the stale thinking block');
  assert.match(viaScreenEndpoint, /ETIMEDOUT/, '/screen still returns the stale error');

  assert.strictEqual(frame.observation_basis, 'vt_grid');
  assert.strictEqual(frame.completeness, 'complete');
  assert.strictEqual(frame.freshness, 'current');
  assert.strictEqual(frame.screen_kind, 'normal');
  screen.dispose();
});

test('G-FRAME: CR overwrites in place — a progress line reads as its LAST state', async () => {
  const screen = localScreen(30, 3);
  // The classic spinner/progress case. `stripAnsiForScreen` deletes \r outright.
  const raw = 'downloading  0%\rdownloading 50%\rdownloading 99%';
  screen.noteOutput(raw);
  const frame = await H.frameAfterDrain(screen);

  assert.strictEqual(frame.rows_text[0], 'downloading 99%');
  // Contrast: the endpoint concatenates all three states into one line.
  assert.strictEqual(stripAnsiForScreen(raw), 'downloading  0%downloading 50%downloading 99%');
  screen.dispose();
});

test('G-FRAME: CR overwrite is a partial overwrite, not a line reset', async () => {
  const screen = localScreen(20, 2);
  screen.noteOutput(`aaaa${ANSI.CR}bb`);
  const frame = await H.frameAfterDrain(screen);
  assert.strictEqual(frame.rows_text[0], 'bbaa', 'CR moves the cursor; it does not clear the row');
  screen.dispose();
});

test('G-FRAME: cursor movement + erase-to-end-of-line truncates exactly at the cursor', async () => {
  const screen = localScreen(30, 2);
  screen.noteOutput('hello world');
  screen.noteOutput(ANSI.CUP(1, 7) + ANSI.EL(0));   // column 7 is the 'w'
  const frame = await H.frameAfterDrain(screen);
  // 'hello ' — six cells survive. The space at index 5 was WRITTEN by the child, so it is a real
  // space cell and trimRight keeps it; only the cells EL(0) erased are dropped. That distinction
  // is the point: the grid reports what the child put there, not a tidied-up version of it.
  assert.strictEqual(frame.rows_text[0], 'hello ');
  assert.deepStrictEqual(frame.cursor, { x: 6, y: 0 });
  screen.dispose();
});

test('G-FRAME: erase-to-start (EL 1) and erase-to-end-of-screen (ED 0)', async () => {
  const screen = localScreen(20, 4);
  screen.noteOutput(`ROW1${ANSI.CRLF}ROW2${ANSI.CRLF}ROW3${ANSI.CRLF}ROW4`);
  // EL 1 on row 2, cursor at col 3 -> erases columns 1..3 of that row.
  screen.noteOutput(ANSI.CUP(2, 3) + ANSI.EL(1));
  let frame = await H.frameAfterDrain(screen);
  assert.strictEqual(frame.rows_text[1], '   2');

  // ED 0 from row 3 col 1 -> everything from there to the end of the screen.
  screen.noteOutput(ANSI.CUP(3, 1) + ANSI.ED(0));
  frame = await H.frameAfterDrain(screen);
  assert.strictEqual(frame.rows_text[0], 'ROW1');
  assert.strictEqual(frame.rows_text[1], '   2');
  assert.strictEqual(frame.rows_text[2], '');
  assert.strictEqual(frame.rows_text[3], '');
  screen.dispose();
});

test('G-FRAME: scrollback 0 means the grid holds the CURRENT rows, never history', async () => {
  const screen = localScreen(20, 3);
  screen.noteOutput('L1\r\nL2\r\nL3\r\nL4\r\nL5');
  const frame = await H.frameAfterDrain(screen);

  assert.strictEqual(frame.rows_text.length, 3, 'exactly `rows` entries');
  assert.deepStrictEqual(frame.rows_text, ['L3', 'L4', 'L5']);
  assert.ok(!H.screenText(frame).includes('L1'), 'scrolled-off history is not retained');
  screen.dispose();
});

// ---------------------------------------------------------------------------
// G-SHORT — the 2-4 repaint prefix a freshly dispatched worker actually lives in
// ---------------------------------------------------------------------------

test('G-SHORT: a 3-repaint prefix reads correctly at every step', async () => {
  const screen = localScreen(32, 4);
  const repaints = [
    `${ANSI.HOME}${ANSI.ED(2)}frame one${ANSI.CRLF}> `,
    `${ANSI.HOME}${ANSI.ED(2)}frame two${ANSI.CRLF}> x`,
    `${ANSI.HOME}${ANSI.ED(2)}frame three${ANSI.CRLF}> xy`,
  ];
  const expected = [['frame one', '>'], ['frame two', '> x'], ['frame three', '> xy']];

  for (let i = 0; i < repaints.length; i += 1) {
    screen.noteOutput(repaints[i]);
    // eslint-disable-next-line no-await-in-loop
    const frame = await H.frameAfterDrain(screen);
    assert.deepStrictEqual(H.visibleRows(frame), expected[i], `after repaint ${i + 1}`);
    assert.strictEqual(frame.observation_basis, 'vt_grid', `basis after repaint ${i + 1}`);
  }
  screen.dispose();
});

// ---------------------------------------------------------------------------
// G-ALT — alternate screen entry/exit
// ---------------------------------------------------------------------------

test('G-ALT: entering and leaving the alternate buffer flips screen_kind and restores', async () => {
  const screen = localScreen(24, 3);
  screen.noteOutput('normal content');
  let frame = await H.frameAfterDrain(screen);
  assert.strictEqual(frame.screen_kind, 'normal');
  assert.strictEqual(frame.rows_text[0], 'normal content');

  screen.noteOutput(`${ANSI.ALT_ON}${ANSI.HOME}${ANSI.ED(2)}FULLSCREEN APP`);
  frame = await H.frameAfterDrain(screen);
  assert.strictEqual(frame.screen_kind, 'alternate');
  assert.strictEqual(frame.rows_text[0], 'FULLSCREEN APP');
  assert.ok(!H.screenText(frame).includes('normal content'), 'alt buffer is its own grid');

  screen.noteOutput(ANSI.ALT_OFF);
  frame = await H.frameAfterDrain(screen);
  assert.strictEqual(frame.screen_kind, 'normal');
  assert.strictEqual(frame.rows_text[0], 'normal content', 'normal buffer survived the excursion');
  assert.strictEqual(frame.observation_basis, 'vt_grid');
  screen.dispose();
});

// ---------------------------------------------------------------------------
// G-WIDE — default width behaviour WITHOUT @xterm/addon-unicode11 (contract §2)
// ---------------------------------------------------------------------------
//
// vg1136am DELTA-3 (declared, comments only — every measurement below is unchanged).
// SCOPE OF EVERY WIDTH NUMBER IN THIS SECTION: it is the width the PINNED @xterm/headless 6.0.0
// parser assigns, measured in this phase, with no addon and nothing mocked. NO host terminal,
// PTY or terminal emulator was launched or measured in this phase, so nothing here establishes
// what any real terminal does. The vt1136ak comments that asserted a universal host behaviour
// ("diverges from every real terminal, which renders it 2") were an unmeasured claim and are
// corrected to conditionals. The host-side half of G-WIDE belongs to G-PTY / G-OS and is UNRUN.

test('G-WIDE: Korean/CJK cells occupy two columns by default', async () => {
  const screen = localScreen(20, 2);
  screen.noteOutput('가나다');
  const frame = await H.frameAfterDrain(screen);
  assert.strictEqual(frame.rows_text[0], '가나다', 'wide text round-trips through the grid');
  assert.deepStrictEqual(
    frame.cursor, { x: 6, y: 0 },
    'three wide glyphs advance the cursor six columns in the pinned headless parser, with no unicode11 addon'
  );
  screen.dispose();
});

test('G-WIDE: a wide glyph wraps as a unit rather than being split across the boundary', async () => {
  const screen = localScreen(5, 3);
  screen.noteOutput('ab가나');   // a b = 2 cols, 가 = 2 (cols 3-4), 나 does not fit in col 5
  const frame = await H.frameAfterDrain(screen);
  assert.strictEqual(frame.rows_text[0], 'ab가', 'the wide glyph that did not fit moved down whole');
  assert.strictEqual(frame.rows_text[1], '나');
  screen.dispose();
});

test('G-WIDE: a combining sequence is ONE cell carrying MANY code units', async () => {
  const screen = localScreen(10, 2);
  screen.noteOutput('\u0065\u0301x');   // e + COMBINING ACUTE, then x
  const frame = await H.frameAfterDrain(screen);

  assert.strictEqual(frame.rows_text[0], '\u0065\u0301x');
  assert.strictEqual(frame.rows_text[0].length, 3, 'three UTF-16 units...');
  assert.deepStrictEqual(frame.cursor, { x: 2, y: 0 }, '...in two cells — cell != character');
  screen.dispose();
});

test('G-WIDE: emoji and ZWJ runs round-trip intact through the grid', async () => {
  const screen = localScreen(20, 2);
  const emoji = '\u{1F600}';                  // GRINNING FACE, one astral code point (2 units)
  const zwj = '\u{1F469}‍\u{1F4BB}';     // WOMAN TECHNOLOGIST, a ZWJ run (5 units)
  screen.noteOutput(`${emoji}|${zwj}|`);
  const frame = await H.frameAfterDrain(screen);

  const row = frame.rows_text[0];
  assert.ok(row.includes(emoji), 'astral emoji survives the grid round-trip intact');
  assert.ok(row.includes(zwj), 'ZWJ run is preserved whole, joiner included');
  assert.strictEqual(row, `${emoji}|${zwj}|`, 'no unit is lost or reordered');
  screen.dispose();
});

test('G-WIDE FINDING: default (Unicode 6) widths give emoji ONE column — records the exact fixture', async () => {
  // Contract §2: "@xterm/addon-unicode11 is NOT adopted. Default width behaviour is measured by
  // G-WIDE; if it fails, the exact failing fixture is reported back before any dependency is
  // added." This test IS that fixture. It asserts the MEASURED behaviour of the pinned library so
  // the divergence is pinned and visible, and so an upstream change breaks loudly.
  //
  // MEASURED IN THIS PHASE — @xterm/headless 6.0.0 only, no addon, allowProposedApi:true,
  // headless parser only, NO host terminal measured (vg1136am DELTA-3):
  //     '가'  (U+AC00)  -> 2 columns   (Unicode 6 East Asian Wide)
  //     '😀'  (U+1F600) -> 1 column
  //     '👩‍💻' ZWJ run   -> 2 columns   (two 1-column cells, not one 2-column cell)
  //
  // MECHANISM (from the library's own width data, not from a host comparison): xterm's default
  // width provider implements Unicode 6 East Asian Width, under which these emoji code points are
  // Neutral (width 1). They were reclassified Wide in Unicode 9.
  //
  // CONSEQUENCE, conditional because the antecedent is UNMEASURED here: *if* the child's terminal
  // uses Unicode >= 9 widths and advances two columns per emoji, then every column position AFTER
  // an emoji on that row is off by one in this grid. Absolute cursor addressing (CUP)
  // re-synchronises the row, so a full CUP/ED repaint recovers; relative movement (CUF/CUB) and
  // CR-overwrite progress lines on an emoji-bearing row do not. Whether any terminal telepty
  // actually runs under behaves that way was NOT measured in this phase — it needs a real-PTY
  // comparison against a host terminal and belongs to G-PTY / G-OS (builder-owned, UNRUN).
  const screen = localScreen(20, 2);
  screen.noteOutput('\u{1F600}');
  let frame = await H.frameAfterDrain(screen);
  assert.deepStrictEqual(frame.cursor, { x: 1, y: 0 },
    'MEASURED: emoji advances the cursor ONE column under the default width provider');
  screen.dispose();

  const wide = localScreen(20, 2, 'g-wide-cjk');
  wide.noteOutput('가');
  frame = await H.frameAfterDrain(wide);
  assert.deepStrictEqual(frame.cursor, { x: 2, y: 0 },
    'MEASURED: CJK is correctly two columns — the divergence is emoji-specific');
  wide.dispose();

  const zwjScreen = localScreen(20, 2, 'g-wide-zwj');
  zwjScreen.noteOutput('\u{1F469}‍\u{1F4BB}');
  frame = await H.frameAfterDrain(zwjScreen);
  assert.deepStrictEqual(frame.cursor, { x: 2, y: 0 },
    'MEASURED: the ZWJ run occupies two columns');
  zwjScreen.dispose();
});

// ---------------------------------------------------------------------------
// Frame shape — every §9 field present, with the declared unit
// ---------------------------------------------------------------------------

test('§9: the frame carries exactly the declared field set and unit', async () => {
  const screen = localScreen(10, 2);
  screen.noteOutput('x');
  const frame = await H.frameAfterDrain(screen);

  assert.deepStrictEqual(Object.keys(frame).sort(), [
    'applied_units', 'cols', 'completeness', 'continuity', 'cursor', 'degraded_reasons',
    'dropped_units', 'frame_seq', 'freshness', 'generation_cause', 'geometry_source',
    'lag_units', 'observation_basis', 'observed_units', 'rows', 'rows_text', 'screen_kind',
    'session_id', 'snapshot_bytes', 'snapshot_truncated', 'stream_id', 'unit', 'vt_generation',
  ]);
  assert.strictEqual(frame.unit, 'utf16_code_unit');
  // §9: `actuation_qualified` was removed — a frame qualifies an observation and nothing else.
  assert.ok(!('actuation_qualified' in frame));
  assert.strictEqual(frame.applied_units, 1);
  assert.strictEqual(frame.observed_units, 1);
  assert.strictEqual(frame.lag_units, 0);
  screen.dispose();
});

test('§4: counters are UTF-16 code units, not UTF-8 bytes', async () => {
  const screen = localScreen(40, 2);
  const payload = '가나다';               // 3 chars, 3 UTF-16 units, 9 UTF-8 bytes
  screen.noteOutput(payload);
  const frame = await H.frameAfterDrain(screen);

  assert.strictEqual(payload.length, 3);
  assert.strictEqual(Buffer.byteLength(payload, 'utf8'), 9);
  assert.strictEqual(frame.observed_units, 3, 'observed_units counts UTF-16 units, not bytes');
  assert.strictEqual(frame.applied_units, 3);
  // The only byte-named field is the snapshot bound, and it really is UTF-8 bytes.
  assert.strictEqual(frame.snapshot_bytes, Buffer.byteLength('가나다', 'utf8') + 1 + 1);
  screen.dispose();
});

test('reads never mutate the grid or the queue: repeated reads are stable', async () => {
  const screen = localScreen(20, 2);
  screen.noteOutput('stable');
  const a = await H.frameAfterDrain(screen);
  const b = await H.frameAfterDrain(screen);
  assert.deepStrictEqual(a.rows_text, b.rows_text);
  assert.strictEqual(a.applied_units, b.applied_units);
  assert.strictEqual(a.observed_units, b.observed_units);
  assert.ok(b.frame_seq > a.frame_seq, 'only frame_seq advances');
  screen.dispose();
});
