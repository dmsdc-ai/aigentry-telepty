'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  lookup,
  commandKey,
  isKnownAiCli,
  detectOutput,
  normalizeOutputForDetection,
  ENTRIES
} = require('../src/prompt-symbol-registry');

// ---------------------------------------------------------------------------
// Inline fixtures — captured 2026-04-26 from `cmux read-screen`.
// Verbatim shape: header text, U+2500 borders, prompt symbol line, status footer.
// Keeping fixtures in-source (not under test/fixtures/) keeps the patch tight
// and avoids a hidden binary-encoding axis on Windows checkouts.
// ---------------------------------------------------------------------------

const CLAUDE_IDLE = [
  '──────────────────────────────────────────────────',
  '❯                                                 ',
  '──────────────────────────────────────────────────',
  '  aigentry-architect | Opus 4.7 (1M context) | [█░░░░░░░░░░░░░░] 11% 113.4K/1.0M',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)         new task? /clear to save 113.5k tokens',
].join('\n');

// History echo + active idle prompt at bottom (disambiguation case).
const CLAUDE_HISTORY_ECHO = [
  '> ❯ TASK_COMPLETE: previous report body echoed in transcript',
  '  …',
  '──────────────────────────────────────────────────',
  '❯                                                 ',
  '──────────────────────────────────────────────────',
  '  status footer',
].join('\n');

// Welcome banner stage — symbol drawn but no border geometry yet.
const CLAUDE_BANNER_NO_BORDER = [
  ' ✻ Welcome to Claude Code',
  ' ',
  ' ❯ Tip: Press / to see commands',
  ' ',
  '   model: claude-opus-4-7',
].join('\n');

const CODEX_IDLE = [
  '',
  ' › Explain this codebase                            ',
  '',
  '  gpt-5.5 xhigh fast · ~/projects/aigentry-devkit',
].join('\n');

// Codex with no model footer — should NOT match (geometry sanity).
const CODEX_NO_FOOTER = [
  '',
  ' › some text',
  '',
  '  unrelated tail line',
].join('\n');

const GEMINI_EMPTY = [
  '▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
  ' *   Type your message or @path/to/file',
  '▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄',
  '  gemini · 2.5-pro',
].join('\n');

const GEMINI_MIDCONVO = [
  '▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
  ' *   user typed half a question here',
  '▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄',
].join('\n');

// Gemini-like line with no border bracketing → should NOT match.
const GEMINI_NO_BORDER = [
  ' *   Type your message',
  '  ordinary text',
].join('\n');

// ---------------------------------------------------------------------------
// lookup()
// ---------------------------------------------------------------------------

test('lookup returns claude entry for plain "claude"', () => {
  const e = lookup('claude');
  assert.equal(e?.symbol, '❯');
});

test('lookup normalizes path-prefixed command (/usr/local/bin/claude)', () => {
  const e = lookup('/usr/local/bin/claude');
  assert.equal(e?.symbol, '❯');
});

test('lookup normalizes path + args (/usr/local/bin/claude --resume)', () => {
  const e = lookup('/usr/local/bin/claude --resume');
  assert.equal(e?.symbol, '❯');
});

test('lookup matches subcmd-form ("codex resume") via first-token scan', () => {
  // The first token resolves to the bin name; subcommand is ignored.
  const e = lookup('codex resume');
  assert.equal(e?.symbol, '›');
});

test('lookup is case-insensitive', () => {
  assert.equal(lookup('CLAUDE')?.symbol, '❯');
  assert.equal(lookup('Codex')?.symbol, '›');
});

test('lookup returns null for unknown CLI', () => {
  assert.equal(lookup('bash'), null);
  assert.equal(lookup('zsh'), null);
  assert.equal(lookup('nano'), null);
});

test('lookup returns null for empty/whitespace/null input', () => {
  assert.equal(lookup(''), null);
  assert.equal(lookup('   '), null);
  assert.equal(lookup(null), null);
  assert.equal(lookup(undefined), null);
});

test('isKnownAiCli and commandKey classify registered AI CLIs only', () => {
  assert.equal(isKnownAiCli('/tmp/claude'), true);
  assert.equal(isKnownAiCli('codex resume'), true);
  assert.equal(isKnownAiCli('gemini'), true);
  assert.equal(isKnownAiCli('bash'), false);
  assert.equal(commandKey('/tmp/claude --resume'), 'claude');
});

test('detectOutput uses shared geometry rules for bridge readiness', () => {
  const raw = `\x1b[32m${CLAUDE_IDLE}\x1b[0m\r\n`;
  assert.equal(detectOutput('/tmp/claude', raw).found, true);
  assert.equal(detectOutput('/tmp/claude', CLAUDE_BANNER_NO_BORDER).found, false);
  assert.equal(detectOutput('bash', CLAUDE_IDLE).reason, 'unknown_cli');
});

test('normalizeOutputForDetection strips ANSI and converts CR to LF', () => {
  assert.equal(normalizeOutputForDetection('\x1b[31mhello\x1b[0m\rworld'), 'hello\nworld');
});

// ---------------------------------------------------------------------------
// claude.detect()
// ---------------------------------------------------------------------------

test('claude.detect finds idle prompt with border geometry (col=1)', () => {
  const r = ENTRIES.claude.detect(CLAUDE_IDLE);
  assert.equal(r.found, true);
  assert.equal(r.col, 1);
});

test('claude.detect rejects banner-stage symbol with no border geometry', () => {
  const r = ENTRIES.claude.detect(CLAUDE_BANNER_NO_BORDER);
  assert.equal(r.found, false);
});

test('claude.detect picks LAST occurrence (history-echo disambiguation)', () => {
  const r = ENTRIES.claude.detect(CLAUDE_HISTORY_ECHO);
  assert.equal(r.found, true);
  // The active idle prompt sits in the bottom-half of the fixture (line 3).
  // The transcript-echoed `> ❯ TASK_COMPLETE...` line at index 0 must NOT
  // be matched (line content has trailing text, fails ^❯\s*$ anchor).
  const lines = CLAUDE_HISTORY_ECHO.split('\n');
  assert.equal(lines[r.line_index].trimEnd(), '❯');
});

test('claude.detect returns false on empty screen', () => {
  assert.equal(ENTRIES.claude.detect('').found, false);
  assert.equal(ENTRIES.claude.detect(null).found, false);
  assert.equal(ENTRIES.claude.detect(undefined).found, false);
});

// ---------------------------------------------------------------------------
// codex.detect()
// ---------------------------------------------------------------------------

test('codex.detect finds idle prompt with model footer (col=2)', () => {
  const r = ENTRIES.codex.detect(CODEX_IDLE);
  assert.equal(r.found, true);
  assert.equal(r.col, 2);
});

test('codex.detect rejects line without gpt-N footer', () => {
  const r = ENTRIES.codex.detect(CODEX_NO_FOOTER);
  assert.equal(r.found, false);
});

test('codex.detect handles gpt-4 / gpt-5 / gpt-5.5 footer variants', () => {
  for (const tag of ['gpt-4', 'gpt-5', 'gpt-5.5']) {
    const screen = ` › prompt\n\n  ${tag} · ~/proj`;
    assert.equal(ENTRIES.codex.detect(screen).found, true, `tag=${tag} should match`);
  }
});

test('codex.detect returns false on empty screen', () => {
  assert.equal(ENTRIES.codex.detect('').found, false);
});

// ---------------------------------------------------------------------------
// gemini.detect()
// ---------------------------------------------------------------------------

test('gemini.detect finds empty input with U+2580/U+2584 box geometry', () => {
  const r = ENTRIES.gemini.detect(GEMINI_EMPTY);
  assert.equal(r.found, true);
  assert.equal(r.col, 2);
});

test('gemini.detect finds mid-conversation prompt with box geometry', () => {
  const r = ENTRIES.gemini.detect(GEMINI_MIDCONVO);
  assert.equal(r.found, true);
});

test('gemini.detect rejects symbol line without bracketing borders', () => {
  const r = ENTRIES.gemini.detect(GEMINI_NO_BORDER);
  assert.equal(r.found, false);
});

test('gemini.detect returns false on empty screen', () => {
  assert.equal(ENTRIES.gemini.detect('').found, false);
});

// ---------------------------------------------------------------------------
// Cross-CLI invariants
// ---------------------------------------------------------------------------

test('all registered entries expose {symbol, byteSeq, detect}', () => {
  for (const [key, entry] of Object.entries(ENTRIES)) {
    assert.equal(typeof entry.symbol, 'string', `${key}: symbol`);
    assert.ok(Buffer.isBuffer(entry.byteSeq), `${key}: byteSeq is Buffer`);
    assert.equal(typeof entry.detect, 'function', `${key}: detect`);
  }
});

test('byteSeq matches the symbol UTF-8 encoding', () => {
  for (const [key, entry] of Object.entries(ENTRIES)) {
    const expected = Buffer.from(entry.symbol, 'utf8');
    assert.equal(
      entry.byteSeq.equals(expected),
      true,
      `${key}: byteSeq ${entry.byteSeq.toString('hex')} ≠ expected ${expected.toString('hex')}`
    );
  }
});
