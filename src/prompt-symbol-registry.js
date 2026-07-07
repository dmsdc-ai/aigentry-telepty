// src/prompt-symbol-registry.js — Per-CLI prompt-symbol detection (0.3.2)
// See docs/superpowers/specs/2026-04-26-prompt-symbol-render-gate.md
//
// Maps `session.command` (e.g. 'claude', 'codex', 'gemini') to a
//   { symbol, byteSeq, detect(screen) → { found, line_index?, col? } }
// entry. The detect() function takes the rendered screen text from
// `cmux read-screen` (already terminal-state-applied; no ANSI stripping
// needed) and returns the LAST occurrence (closest to the bottom) so
// transcript echoes earlier in the viewport do not produce false positives.
//
// Adding a new CLI: append a new entry + write a unit test against a
// captured `cmux read-screen` sample.

'use strict';

const ENTRIES = {
  // claude renders an empty input row as "❯" + spaces, sandwiched between
  // two horizontal-rule lines made of U+2500 ('─').
  // #679: on Windows/ConPTY the caret glyph falls back to ASCII '>' (0x3E) —
  // `❯` renders 0×, `>` renders instead — so the ❯-only matcher never fired,
  // bootstrap_ready never flipped, and gated injects parked in the mailbox
  // forever. Accept both carets; the full-line `\s*$` anchor + `─`-rule
  // adjacency guard still reject a stray '> markdown blockquote' in transcript.
  claude: {
    symbol: '❯',
    byteSeq: Buffer.from([0xE2, 0x9D, 0xAF]),
    detect(screen) {
      const lines = String(screen == null ? '' : screen).split('\n');
      for (let i = lines.length - 1; i >= 1; i--) {
        const line = lines[i];
        const m = /^([❯>])\s*$/.exec(line);
        if (!m) continue;
        const above = lines[i - 1] || '';
        const below = lines[i + 1] || '';
        if (above.includes('─') || below.includes('─')) {
          return { found: true, line_index: i, col: line.indexOf(m[1]) + 1 };
        }
      }
      return { found: false };
    },
  },
  // #472 (0.4.5): codex previously matched on a strict line-leading "^ › "
  // shape; on real cmux captures the '›' tail-renders on the same row as the
  // model-status footer and DECRQM/cursor-pos fragments leak in, so that
  // strict matcher misses. Multi-signal tolerant matcher: picker anti-pattern
  // first (resume-picker UI must NOT be considered ready), then a tolerant
  // (a + b) signal pair, then the legacy strict scan as a back-compat
  // fallback. Reason field surfaces which signal fired for log-attribution.
  codex: {
    symbol: '›',
    byteSeq: Buffer.from([0xE2, 0x80, 0xBA]),
    detect(screen) {
      const text = String(screen == null ? '' : screen);

      // Step 1: modal-UI anti-pattern. Resume picker, first-run directory
      // trust prompt, and generic "Press enter to continue" modals are all
      // pre-prompt UIs where Enter would not submit a user message. Treat
      // any of them as NOT ready.
      if (
        /Resume a previous session/.test(text) ||
        /^Filter:/m.test(text) ||
        /Do you trust the contents/i.test(text) ||
        /Press enter to continue/i.test(text)
      ) {
        return { found: false, reason: 'codex_modal_ui' };
      }

      // Step 2: multi-signal tolerant. The codex boot box contains
      // "OpenAI Codex (v<version>)" and the status row contains
      // "gpt-<ver> <profile>" followed by either " fast" (fast-inference mode)
      // or the " · <cwd>" separator. v0.142.5 omits "fast" when fast-mode is
      // off ("gpt-5.5 xhigh · /tmp/demo714"), so match either tail. Both
      // signals present anywhere → ready, regardless of where '›' rendered.
      if (/OpenAI Codex \(v/.test(text) && /gpt-[0-9.]+\s+\S+(\s+fast|\s*·)/.test(text)) {
        return { found: true, reason: 'codex_multi_signal' };
      }

      // Step 3: legacy strict line-leading scan — preserved for back-compat
      // on clean cmux captures where the original matcher already worked.
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        // v0.142.5 renders the composer '›' line-leading with no space; older
        // captures kept one leading space — accept both.
        if (!/^ ?› /.test(line)) continue;
        const footer = (lines[i + 1] || '') + '\n' + (lines[i + 2] || '');
        if (/gpt-\d/.test(footer)) {
          return { found: true, line_index: i, col: 2, reason: 'codex_strict_line' };
        }
      }
      return { found: false };
    },
  },
  // gemini empty input: " *   Type your message or @path/to/file"
  // gemini non-empty: " *   <user typed text>"
  // Geometry: bracketed by U+2580 ('▀') above and U+2584 ('▄') below.
  gemini: {
    symbol: '*',
    byteSeq: Buffer.from([0x2A]),
    detect(screen) {
      const lines = String(screen == null ? '' : screen).split('\n');
      for (let i = lines.length - 1; i >= 1; i--) {
        const line = lines[i];
        if (!/^ \* {2,}/.test(line)) continue;
        const above = lines[i - 1] || '';
        const below = lines[i + 1] || '';
        if (above.includes('▀') || below.includes('▄')) {
          return { found: true, line_index: i, col: 2 };
        }
      }
      return { found: false };
    },
  },
};

// Normalize: strip path and args
//   '/usr/local/bin/claude --resume' → 'claude'
//   'codex resume'                   → 'resume' (false negative — see note)
//
// The naive split/pop returns the LAST whitespace-or-slash-delimited token,
// which is correct for absolute paths but wrong for `<bin> <subcmd>` forms.
// We compensate by also trying the FIRST path-stripped token before falling
// back to the last token, matching whichever ENTRIES key exists.
function lookup(command) {
  if (!command) return null;
  const raw = String(command).trim();
  if (!raw) return null;
  const tokens = raw.split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    const base = tok.split('/').filter(Boolean).pop() || '';
    const key = base.toLowerCase();
    if (ENTRIES[key]) return ENTRIES[key];
  }
  return null;
}

function commandKey(command) {
  const entry = lookup(command);
  if (!entry) return null;
  for (const [key, value] of Object.entries(ENTRIES)) {
    if (value === entry) return key;
  }
  return null;
}

function isKnownAiCli(command) {
  return !!lookup(command);
}

// CSI branch = ECMA-48 CSI (see #715): params 0x30-0x3f (incl. < > = : used by
// kitty-keyboard/modifyOtherKeys), intermediates 0x20-0x2f, final 0x40-0x7e. The
// prior [0-9;?] param class leaked claude v2.1.198's ESC[<u/ESC[>1u/ESC[>4;2m (#713).
const ANSI_RE = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][AB012]|\x1b[>=<78DMEHcNOZ~}|]/g;

function stripAnsi(value) {
  return String(value == null ? '' : value).replace(ANSI_RE, '');
}

function normalizeOutputForDetection(output) {
  return stripAnsi(output)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{2,}/g, '\n');
}

function detectOutput(command, output) {
  const entry = lookup(command);
  if (!entry) {
    return { found: false, reason: 'unknown_cli' };
  }
  const screenLike = normalizeOutputForDetection(output);
  return entry.detect(screenLike);
}

module.exports = {
  lookup,
  commandKey,
  isKnownAiCli,
  detectOutput,
  normalizeOutputForDetection,
  ENTRIES,
};
