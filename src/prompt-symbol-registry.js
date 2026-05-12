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
  claude: {
    symbol: '❯',
    byteSeq: Buffer.from([0xE2, 0x9D, 0xAF]),
    detect(screen) {
      const lines = String(screen == null ? '' : screen).split('\n');
      for (let i = lines.length - 1; i >= 1; i--) {
        const line = lines[i];
        if (!/^❯\s*$/.test(line)) continue;
        const above = lines[i - 1] || '';
        const below = lines[i + 1] || '';
        if (above.includes('─') || below.includes('─')) {
          return { found: true, line_index: i, col: line.indexOf('❯') + 1 };
        }
      }
      return { found: false };
    },
  },
  // codex renders idle as " › <placeholder>" (column 2). Status footer
  // ("gpt-5.5 …" or "gpt-5 …") sits 1–2 lines below.
  codex: {
    symbol: '›',
    byteSeq: Buffer.from([0xE2, 0x80, 0xBA]),
    detect(screen) {
      const lines = String(screen == null ? '' : screen).split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!/^ › /.test(line)) continue;
        const footer = (lines[i + 1] || '') + '\n' + (lines[i + 2] || '');
        if (/gpt-\d/.test(footer)) {
          return { found: true, line_index: i, col: 2 };
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

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][AB012]|\x1b[>=<78DMEHcNOZ~}|]/g;

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
