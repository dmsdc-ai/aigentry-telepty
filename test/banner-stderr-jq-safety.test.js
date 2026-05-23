'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Regression: task #400 / telepty#15
// Daemon-related banners must emit to process.stderr (not stdout) so that
// commands like `telepty list --json` never contaminate jq's stdin.
//
// Static lint over cli.js: every "Daemon"/"daemon" banner with the ⚙️/⚠️ ANSI
// glyphs must reach `process.stderr.write(...)`, not `process.stdout.write`.

const CLI_PATH = path.resolve(__dirname, '..', 'cli.js');
const cliSource = fs.readFileSync(CLI_PATH, 'utf8');

// Each entry is a substring uniquely identifying a banner line. The test
// asserts the line containing that substring uses process.stderr.write.
const BANNER_SUBSTRINGS = [
  'Daemon version mismatch (running v',     // cli.js:585 — primary root cause
  'Daemon restart attempt',                  // cli.js:429 — retry warning
  'Found an older local telepty daemon',     // cli.js:592
  'Found a local telepty daemon without',    // cli.js:594
  'Auto-starting local telepty daemon'       // cli.js:600
];

function findLineContaining(source, needle) {
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(needle)) return { lineNo: i + 1, line: lines[i] };
  }
  return null;
}

for (const needle of BANNER_SUBSTRINGS) {
  test(`banner emits to stderr (jq-safety): "${needle}"`, () => {
    const found = findLineContaining(cliSource, needle);
    assert.ok(found, `expected to find banner containing "${needle}" in cli.js`);
    assert.match(
      found.line,
      /process\.stderr\.write/,
      `cli.js:${found.lineNo} banner must use process.stderr.write to keep stdout clean for --json piping (task #400)`
    );
    assert.doesNotMatch(
      found.line,
      /process\.stdout\.write/,
      `cli.js:${found.lineNo} must NOT use process.stdout.write for this banner`
    );
  });
}

test('no daemon banner regresses back to process.stdout.write in cli.js', () => {
  // Catch-all: any future daemon banner with the ⚙️ glyph should also go to stderr.
  const lines = cliSource.split('\n');
  const offenders = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.includes('process.stdout.write') && /(⚙️|⚠️).*([Dd]aemon|telepty daemon)/.test(line)) {
      offenders.push({ lineNo: i + 1, line: line.trim() });
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `daemon banners on stdout regress task #400 jq-safety:\n${offenders.map(o => `  cli.js:${o.lineNo}: ${o.line}`).join('\n')}`
  );
});
