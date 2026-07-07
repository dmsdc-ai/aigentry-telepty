'use strict';

// #715 — telepty read-screen rendered codex/claude sessions as garbage. The /screen
// endpoint has no VT emulator: it concatenates the raw PTY output ring and strips ANSI
// by regex. The classic CSI matcher only handled `ESC [ params final`, so CSI sequences
// with intermediate bytes (SPACE, $), the < = > private markers, or : sub-parameters
// failed to match and the fallback leaked their tail as literal text. This is the
// screen-render ANSI stripper; kept pure + standalone so it is unit-testable without
// booting the daemon. (Parser-only fix; the submit/gate path is a separate concern.)
function stripAnsiForScreen(str) {
  return str
    // Replace cursor-forward (ESC[NC, ESC[C) with N spaces to preserve whitespace
    .replace(/\[(\d*)C/g, (_, n) => ' '.repeat(Number(n) || 1))
    // CSI (ECMA-48): ESC [ params(0x30-3F incl : ; < = > ?) intermediates(0x20-2F) final(0x40-7E).
    // #715: the classic /\x1b[\??[0-9;]*.../ form dropped intermediates, the < = >
    // private markers and colon sub-params, so a partial match leaked the tail as
    // literal text (DECSCUSR ESC[0 q -> `0 q`, kitty ESC[>1u -> `>1u`, etc.).
    .replace(/\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '')
    // OSC sequences: ESC ] ... BEL
    .replace(/\][^]*/g, '')
    // OSC sequences: ESC ] ... ST (ESC \)
    .replace(/\][^]*\\/g, '')
    // Character set selection: ESC ( / ) + charset
    .replace(/[()][AB012]/g, '')
    // Keypad and other 2-char ESC sequences
    .replace(/[>=<78DMEHcNOZ~}|]/g, '')
    // DCS / PM / APC sequences
    .replace(/[P^_][^]*\\/g, '')
    // Any remaining bare ESC + single char
    .replace(/./g, '')
    // Carriage returns
    .replace(/\r/g, '');
}

module.exports = { stripAnsiForScreen };
