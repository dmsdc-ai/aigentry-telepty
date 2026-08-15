'use strict';

// #861 — a test file may not exit its own process from a teardown hook.
//
// Four files ended with `test.after(() => { setImmediate(() => process.exit(0)); });`, on the
// stated premise that requiring `daemon.js` "left background handles open". Measured with
// `process.getActiveResourcesInfo()`, that premise was false for three of them (the only live
// handles were stdout and stderr) and wrong about the cause for the fourth (an un-cancelled
// `delay(2000)` in the test harness's own `stop()` race, since fixed).
//
// What the hook actually did was tear the process down before the TAP stream had flushed, so the
// runner counted fewer tests than had run and still printed `fail 0` / `exit 0`. Under suite-like
// load: 83 of 400 runs truncated, the worst reporting 3 of 9 tests as a clean pass. This repo had
// already retired `--test-force-exit` for precisely that behaviour; the hook was the same flag,
// hand-rolled per file, where no flag audit would find it.
//
// A green that omits tests is the defect class 0.8.0 exists to remove, sitting in the instrument
// the release's own evidence is measured with. Hence a lint rather than four one-time edits.
//
// WHAT THIS DETECTS: a teardown hook — `after`, `afterEach`, `test.after`, `test.afterEach` —
// whose body reaches `process.exit` in the test process itself.
//
// WHAT IT DOES NOT DETECT, named so its silence is not read as coverage:
//   - a `process.exit` reached INDIRECTLY, through a helper the hook calls;
//   - one registered on `process.on('exit')` or a signal handler;
//   - one in a `before`/`beforeEach` hook or at module scope;
//   - one inside a fixture the test WRITES to disk and spawns as a child process. That last is
//     legitimate and common here — test/cli.test.js, test/daemon.test.js and
//     test/lifecycle-surface-acceptance.test.js all build stub CLIs that exit — which is why
//     string literals are stripped before the scan instead of the file being refused outright.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

// Comments and string literals go first: a `process.exit` inside either is not a call this
// process will ever make. Order matters — comments are removed before strings, so an apostrophe
// in a comment cannot unbalance the string matcher.
function stripCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\n)[ \t]*\/\/[^\n]*/g, '$1')
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, '``')
    .replace(/'(?:\\.|[^\\'\n])*'/g, "''")
    .replace(/"(?:\\.|[^\\"\n])*"/g, '""');
}

// Return the source text of every teardown hook whose body reaches `process.exit`.
// Paren-balanced rather than regex-bounded, so a hook body of any size is read whole.
function hooksReachingExit(src) {
  const clean = stripCommentsAndStrings(src);
  const hook = /\b(?:test\.)?(?:after|afterEach)\s*\(/g;
  const found = [];
  let m;
  while ((m = hook.exec(clean))) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < clean.length && depth > 0) {
      if (clean[i] === '(') depth += 1;
      else if (clean[i] === ')') depth -= 1;
      i += 1;
    }
    const body = clean.slice(m.index, i);
    if (/\bprocess\s*\.\s*exit\s*\(/.test(body)) found.push(body.replace(/\s+/g, ' ').slice(0, 120));
  }
  return found;
}

test('#861: the detector fires on the shape it is meant to catch, and not on fixtures', () => {
  // A lint that cannot fail is the same defect it is guarding against, so it is exercised here
  // rather than trusted. If this test ever passes vacuously, the one below means nothing.
  assert.equal(
    hooksReachingExit('test.after(() => { setImmediate(() => process.exit(0)); });').length, 1,
    'the detector no longer recognises the exact hook #861 removed');
  assert.equal(
    hooksReachingExit('after(async () => { await harness.stop(); });').length, 0,
    'an ordinary teardown hook must not be flagged');
  // INSIDE the hook, and in all three quote forms `stripCommentsAndStrings` handles. It used to
  // sit before the `after(`, where the paren-balanced body never reached it — so the assertion
  // passed with the string branch removed entirely and proved nothing about the thing it names.
  // Disabling any one of the three now turns this red. The shape is real: test/cli.test.js and
  // test/lifecycle-surface-acceptance.test.js build stub CLIs that exit, from template literals.
  assert.equal(
    hooksReachingExit('after(() => { fs.writeFileSync(p, `process.exit(0)`); '
      + 'const a = "process.exit(1)"; const b = \'process.exit(2)\'; server.close(); });').length, 0,
    'a stub-CLI fixture written as a string literal inside the hook is legitimate and must not be flagged');
  assert.equal(
    hooksReachingExit('// after(() => process.exit(0)) used to live here\nafter(() => s.close());').length, 0,
    'a mention inside a comment must not be flagged');
});

test('#861: no test file exits its own process from a teardown hook', () => {
  const tracked = execFileSync('git', ['ls-files', 'test'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((f) => f.endsWith('.test.js'));
  assert.ok(tracked.length > 50, `expected the tracked test set, got ${tracked.length} files`);

  const offenders = [];
  for (const rel of tracked) {
    for (const body of hooksReachingExit(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) {
      offenders.push(`${rel}: ${body}`);
    }
  }

  assert.deepEqual(offenders, [],
    'a teardown hook that calls process.exit() exits before the TAP stream has flushed, so the '
    + 'runner reports fewer tests than ran and still prints "fail 0". If the process will not exit '
    + 'on its own, find the handle holding it open and close that — do not exit over it:\n  '
    + offenders.join('\n  ') + '\n');
});
