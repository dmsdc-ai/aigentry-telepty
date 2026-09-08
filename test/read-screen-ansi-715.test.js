'use strict';

// #715 regression — `telepty read-screen` rendered codex/claude sessions as garbage.
// Root cause: the /screen CSI stripper matched only the classic `ESC [ params final`
// form, so CSI sequences carrying intermediate bytes (SPACE, `$`), the `< = >` private
// markers, or `:` sub-parameters failed to match and the fallback leaked their tail as
// literal text (DECSCUSR `ESC[0 q` -> `0 q`, kitty `ESC[>1u` -> `>1u`, DECRQM
// `ESC[?2026$p` -> `?2026$p`). Fixtures are the exact byte shapes captured live from
// codex v0.133.0 wrapped by `telepty allow`, plus the claude kitty fragments from the
// bug report. Inline (not a fixture file) to keep the patch tight and dodge a Windows
// binary-encoding axis — same convention as prompt-symbol-registry.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { stripAnsiForScreen } = require('../src/screen-ansi');

const E = '\x1b'; // ESC 0x1b
const BEL = '\x07';

// Fragments the bug produced — none of these may survive in rendered text.
const LEAK = /0 q|[<>]\d*u|<u|\d+:\d+m|\?\d+\$p|>\d+;\d+m/;

test('#715: CSI variants that used to leak are now fully consumed', () => {
  const cases = [
    ['DECSCUSR, SPACE intermediate', `${E}[0 q`],
    ['DECSCUSR, no param',           `${E}[ q`],
    ['kitty keyboard push',          `${E}[>1u`],
    ['kitty keyboard pop',           `${E}[<u`],
    ['kitty keyboard flags query',   `${E}[?1u`],
    ['colon SGR (curly underline)',  `${E}[4:2m`],
    ['DECRQM sync-output query',     `${E}[?2026$p`],
    ['DECSET/DECRST sync-output',    `${E}[?2026h${E}[?2026l`],
    ['xterm modifyOtherKeys / DA',   `${E}[>4;0m${E}[>7u`],
  ];
  for (const [name, seq] of cases) {
    assert.equal(stripAnsiForScreen(seq), '', `${name}: ${JSON.stringify(seq)} should strip to empty`);
    // and must not leak a tell-tale fragment even when wrapped in real text
    assert.doesNotMatch(stripAnsiForScreen(`x${seq}y`), LEAK, `${name}: leaked a fragment`);
    assert.equal(stripAnsiForScreen(`x${seq}y`), 'xy', `${name}: surrounding text must be preserved`);
  }
});

test('#715: classic CSI/OSC still stripped, printable text untouched', () => {
  assert.equal(stripAnsiForScreen(`${E}[1;31mRED${E}[0m`), 'RED');
  assert.equal(stripAnsiForScreen(`${E}[2J${E}[H${E}[31;2Hhi`), 'hi');
  assert.equal(stripAnsiForScreen(`${E}[38;2;231;231;231;49mgpt${E}[0m`), 'gpt'); // truecolor SGR
  assert.equal(stripAnsiForScreen(`${E}]0;window-title${BEL}text`), 'text');       // OSC + BEL
  // cursor-forward is preserved as whitespace (layout), not dropped
  assert.equal(stripAnsiForScreen(`a${E}[5Cb`), 'a     b');
  assert.equal(stripAnsiForScreen(`a${E}[Cb`), 'a b'); // ESC[C == forward 1
  // text lacking an ESC prefix is never eaten (the chars `[0 q` etc. are literal)
  assert.equal(stripAnsiForScreen('hello [0 q >1u 4:2m'), 'hello [0 q >1u 4:2m');
});

test('#715: realistic codex boot frame renders clean (no escape remnants)', () => {
  // The live-captured shape that produced `0 q0 q•Booting M0 q...` before the fix:
  // sync-output wrappers, cursor-style noise, truecolor status, composer prompt.
  const frame =
    `${E}[?2026h${E}[0 q${E}[>1u${E}[38;2;167;167;167;49m•Booting MCP server: codex_apps${E}[0m` +
    `${E}[?2026l${E}[ q${E}[K\r\n› Find and fix a bug in @filename\r\n  gpt-5.5 default fast`;
  const out = stripAnsiForScreen(frame);
  assert.doesNotMatch(out, LEAK, `escape remnants leaked: ${JSON.stringify(out)}`);
  assert.equal(out.includes(E), false, `residual ESC byte: ${JSON.stringify(out)}`);
  assert.match(out, /•Booting MCP server: codex_apps/);
  assert.match(out, /› Find and fix a bug in @filename/);
  assert.match(out, /gpt-5\.5 default fast/);
});

// ---------------------------------------------------------------------------
// #1099 — read-screen went permanently empty on sessions whose TUI emits string
// sequences into a 200 KB output ring. `/screen` joins the whole ring and strips,
// so ONE unbounded match wipes the buffer. The OSC-BEL arm's payload class
// excluded only BEL, so it spanned ESC and \n from an `ESC ]` to ANY later BEL —
// 198 KB of answer text -> ''. (The APC arm's `[^ESC]*` was already bounded; the
// bug report's greedy `[^]*` reading was a `cat` artefact of the literal ESC bytes
// stored in the source.) Both arms now carry the same bounded rule: a payload that
// excludes BOTH terminator lead-bytes, and a REQUIRED terminator.
// Invariant: a strip that can eat the whole ring can eat the next frame too.

const APC = `${E}_Ga=d,d=i,i=1,q=2${E}\\`; // kitty graphics image-DELETE, the frame grok floods

test('#1099: no string sequence may eat the ring — a 200 KB span survives', () => {
  const text = 'IMPORTANT ANSWER TEXT '.repeat(9000); // ~198 KB, no newlines (grok emits none)
  // (i) ST-terminated OSC, then text, then a BEL-terminated OSC far away: the BEL arm
  // used to swallow everything between the first `ESC ]` and that trailing BEL.
  assert.equal(stripAnsiForScreen(`${E}]0;grok${E}\\${text}${E}]0;t${BEL}`), text);
  // and the dispatch's APC shape, which the bounded `[^ESC]*` already handled
  assert.equal(stripAnsiForScreen(`${APC}${text}${APC}`), text);
});

test('#1099: one sequence is consumed at a time, not first..last', () => {
  assert.equal(stripAnsiForScreen(`abc${APC}def`), 'abcdef');          // single frame mid-line
  assert.equal(stripAnsiForScreen(`abc${APC}${APC}def`), 'abcdef');    // adjacent frames
  assert.equal(stripAnsiForScreen(`a${APC}b${APC}c`), 'abc');          // text between frames kept
  assert.equal(stripAnsiForScreen(`a${E}]0;t${BEL}b${E}]0;t${BEL}c`), 'abc'); // same for OSC
});

test('#1099: DCS / PM / APC accept both terminators (ST and BEL)', () => {
  for (const [name, opener] of [['DCS', 'P'], ['PM', '^'], ['APC', '_']]) {
    assert.equal(stripAnsiForScreen(`x${E}${opener}payload${E}\\y`), 'xy', `${name} + ST`);
    assert.equal(stripAnsiForScreen(`x${E}${opener}payload${BEL}y`), 'xy', `${name} + BEL`);
  }
  // the OSC arm keeps both terminators too (it is now the same rule)
  assert.equal(stripAnsiForScreen(`x${E}]0;title${BEL}y`), 'xy');
  assert.equal(stripAnsiForScreen(`x${E}]8;;http://e.x${E}\\y`), 'xy');
});

test('#1099: a sequence the ring boundary cut leaks its payload, never wipes', () => {
  // PINNED DECISION: the terminator is REQUIRED. An opener whose terminator fell off
  // the end of the ring does not match, so the 2-byte opener is dropped by the bare-ESC
  // arm and ~12 bytes of payload leak as literal text. A bounded leak beats an empty
  // screen — this is exactly the boundary that produced #1099.
  assert.equal(stripAnsiForScreen(`visible text${E}_Ga=d,d=i`), 'visible textGa=d,d=i');
  assert.equal(stripAnsiForScreen(`visible text${E}]0;win-title`), 'visible text0;win-title');
  // a frame whose OPENER fell off the front leaks too: with nothing to anchor on, only
  // the orphaned `ESC \\` goes, and the payload stays literal. Bounded either way.
  assert.equal(stripAnsiForScreen(`a=d,d=i${E}\\visible text`), 'a=d,d=ivisible text');
});
