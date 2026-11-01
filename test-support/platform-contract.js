'use strict';

// telepty #879 — platform-contract helpers for the test suite. Test-support only: no product
// module is required from here, and nothing here changes what a POSIX run asserts.
//
// Two things the Windows runs measured (run 40500878932, job 122177958261) that are NOT product
// defects but test-fixture assumptions about the host:
//
//   1. POSIX mode bits. `fs.statSync(file).mode & 0o777` is 0o666 for every writable file on
//      win32 (libuv maps the read-only attribute, nothing else). An "owner-only" (0600) assertion
//      cannot measure the Windows ACL, so on win32 it is SKIPPED WITH A STATED REASON — announced
//      through the TAP stream, never returned out of silently, and never read as "secure". The
//      Windows ACL contract is UNMEASURED by this suite; owner #577 (Windows-native runtime).
//
//   2. `#!/usr/bin/env node` fake executables. Windows cannot execute a shebang text file by path,
//      so a fake `claude`/`cmux` stub never starts and the behaviour under test (a bridge that
//      connects, a listing that parses) is never reached. `writeFakeCli` writes the same script
//      as a `.js` body plus a `.cmd` shim on win32 and returns the bare command name together
//      with a PATH that resolves it — the shape `telepty allow <name>` takes in production (#25:
//      PATH × PATHEXT walk, src/win-resolve-executable.js). POSIX keeps the shebang file.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const IS_WIN = process.platform === 'win32';

const WIN32_MODE_REASON =
  'win32: POSIX mode bits are not the Windows ACL (fs.stat reports 0o666 for any writable file); '
  + 'owner-only (0600) contract is UNMEASURED on Windows — owner #577, test-harness note #879';

// `{ skip }` option value for a whole test that exists only to assert a POSIX mode.
function posixModeSkip() {
  return IS_WIN ? WIN32_MODE_REASON : false;
}

// One owner-only assertion inside a test that otherwise stays live, expressed as a NAMED SUBTEST
// of `t` so the TAP tally carries it: on win32 the subtest is `skipped` with the reason (never a
// pass, never a diagnostic that leaves the count unchanged); everywhere else it asserts exactly
// what the inline line asserted. Returns the subtest promise — callers MUST await it.
function assertOwnerOnlyMode(t, filePath, message) {
  const name = `${message || 'owner-only mode'} [${path.basename(filePath)} is 0600]`;
  return t.test(name, { skip: posixModeSkip() }, () => {
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600, message);
  });
}

// Name of the PATH variable as it exists in this process's environment. On win32 the real key is
// usually `Path`; setting a second `PATH` key alongside it makes the child's PATH ambiguous.
function pathEnvKey(env = process.env) {
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
}

// Write a fake CLI named `name` into `dir`. `body` is the script source WITHOUT a shebang line.
// Returns { command, env, file }:
//   command — what to hand to the product (POSIX: absolute path of the shebang file, unchanged
//             from the original fixtures; win32: the bare name, resolved through PATH)
//   env     — spawn-env overrides needed for `command` to resolve ({} on POSIX)
//   file    — the script file that actually runs (for a caller that wants to read it back)
function writeFakeCli(dir, name, body) {
  if (!IS_WIN) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/usr/bin/env node\n${body}`, 'utf8');
    fs.chmodSync(file, 0o755);
    return { command: file, env: {}, file };
  }
  const file = path.join(dir, `${name}.js`);
  fs.writeFileSync(file, body, 'utf8');
  // `%~dp0` is the shim's own directory; the shim runs the SAME node that runs the suite.
  fs.writeFileSync(
    path.join(dir, `${name}.cmd`),
    `@echo off\r\n"${process.execPath}" "%~dp0${name}.js" %*\r\n`,
    'utf8'
  );
  const key = pathEnvKey();
  return { command: name, env: { [key]: `${dir}${path.delimiter}${process.env[key] || ''}` }, file };
}

module.exports = {
  IS_WIN,
  WIN32_MODE_REASON,
  posixModeSkip,
  assertOwnerOnlyMode,
  pathEnvKey,
  writeFakeCli
};
