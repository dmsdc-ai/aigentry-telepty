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

// #737: the pre-prompt UIs codex's detect() step 1 rejects, hoisted so the delivery-path
// modal predicate (detectSurfaceModal, below) scans for EXACTLY the same shapes and the two
// cannot drift apart. Flags are per-pattern and deliberate — the first two are
// case-SENSITIVE; do not "normalize" them.
const CODEX_MODAL_PATTERNS = [
  /Resume a previous session/,
  /^Filter:/m,
  /Do you trust the contents/i,
  /Press enter to continue/i,
];

// #737: live-composer watermark — the model/status footer that detect() step 2 keys on
// ("gpt-5.5 xhigh fast" / "gpt-5.5 default · /path"). It repaints on every composer frame
// and is absent while a modal owns the screen, so its LAST position is reliable evidence
// that the composer was alive after that point in the stream.
const CODEX_COMPOSER_FOOTER = /gpt-\S+\s+\S+(\s+fast|\s*·)/;

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
      if (CODEX_MODAL_PATTERNS.some((re) => re.test(text))) {
        return { found: false, reason: 'codex_modal_ui' };
      }

      // Step 2: multi-signal tolerant. The codex boot box contains
      // "OpenAI Codex (v<version>)" and the status row contains
      // "gpt-<ver> <profile>" followed by either " fast" (fast-inference mode)
      // or the " · <cwd>" separator. v0.142.5 omits "fast" when fast-mode is
      // off ("gpt-5.5 xhigh · /tmp/demo714"), so match either tail. Both
      // signals present anywhere → ready, regardless of where '›' rendered.
      // Model token is `gpt-\S+` not `gpt-[0-9.]+`: codex now ships suffixed
      // names ("gpt-5.6-sol"), where `[0-9.]+` stopped at "5.6" and the `\s`
      // never reached past the "-sol". `\S+` cannot cross whitespace, so the
      // trailing `\s+\S+(\s+fast|\s*·)` profile/tail signal is preserved.
      if (/OpenAI Codex \(v/.test(text) && /gpt-\S+\s+\S+(\s+fast|\s*·)/.test(text)) {
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

// #730 — CLIs whose composer is known to run bracketed-paste + paste-burst detection,
// so an injected body must be wrapped in ESC[200~/ESC[201~ for the separately-written
// submit CR to survive (#716). Kept deliberately CONSERVATIVE: only CLIs we have
// verified on a real binary. gemini is NOT listed — it never advertised ?2004h.
//
// This exists because the observed signal is one-shot and easy to miss: codex 0.144.1
// emits ESC[?2004h exactly once, inside its first ~1.4KB, and never again — so a
// session whose output capture attached late (or came back from a daemon restart)
// could never learn it. Identity does not expire; the observation does.
const PASTE_CAPABLE_CLIS = new Set(['codex', 'claude']);

function isPasteCapableCli(command) {
  return PASTE_CAPABLE_CLIS.has(commandKey(command));
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

// #737 — surface-modal detection for the DELIVERY path.
//
// detect() answers "is this screen ready?" about a cmux `read-screen` SNAPSHOT, and there
// step 1 is exactly right: a dismissed modal is simply not on the screen any more. The
// delivery path has no screen primitive — only the PTY outputRing, an append-only BYTE
// STREAM in which the boot modal stays present for the rest of the session. Running
// detect() over that stream therefore reports `codex_modal_ui` forever after a dismissal
// (measured: scratchpad/probe-737-ring.js — 8k/32k/full tails all say modal, on a live
// composer), which would park every dispatch on a healthy session.
//
// So this decides by POSITION — which is what the header of this file already claims the
// detectors do ("returns the LAST occurrence (closest to the bottom) so transcript echoes
// earlier in the viewport do not produce false positives"): last modal marker vs last
// live-composer marker, later wins. Verified window-insensitive at 2k/8k/32k/200k tails
// (scratchpad/probe-737-latch.js), so a bounded ring read cannot flip the verdict.
//
// Scoped to codex: it is the only CLI with modal patterns, so claude/gemini always get
// `not_applicable` and their delivery is byte-identical.
function lastMatchIndex(text, pattern) {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  let last = -1;
  let m;
  while ((m = re.exec(text)) !== null) {
    last = m.index;
    if (m.index === re.lastIndex) re.lastIndex++; // zero-width match guard
  }
  return last;
}

function detectSurfaceModal(command, output) {
  if (commandKey(command) !== 'codex') return { blocked: false, reason: 'not_applicable' };
  const text = normalizeOutputForDetection(output);
  const modalAt = CODEX_MODAL_PATTERNS.reduce((max, p) => Math.max(max, lastMatchIndex(text, p)), -1);
  if (modalAt === -1) return { blocked: false, reason: 'no_modal_seen' };
  const readyAt = lastMatchIndex(text, CODEX_COMPOSER_FOOTER);
  return modalAt > readyAt
    ? { blocked: true, reason: 'codex_modal_ui', modal_at: modalAt, ready_at: readyAt }
    : { blocked: false, reason: 'composer_after_modal', modal_at: modalAt, ready_at: readyAt };
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
  isPasteCapableCli,   // #730: identity-based bracketed-paste capability (codex/claude)
  detectSurfaceModal,  // #737: positional modal check for the byte-stream delivery path
  detectOutput,
  normalizeOutputForDetection,
  ENTRIES,
};
