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
