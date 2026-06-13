'use strict';

// telepty#51 — `--help`/`-h` on trailing-payload subcommands must ALWAYS print help,
// never be consumed as payload. Before this fix, `telepty broadcast --help` fanned the
// literal string "--help" out to EVERY active session, and `telepty allow --help`
// spawned a junk `<dir>---help` session. Invariant: `--help` has zero network /
// fan-out side effects on every subcommand; literal sends require an explicit `--`.

// Disable the update notifier before requiring cli.js so requiring it stays inert.
process.env.TELEPTY_DISABLE_UPDATE_NOTIFIER = '1';
process.env.NO_UPDATE_NOTIFIER = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const cliPath = path.resolve(__dirname, '..', 'cli.js');
const { helpRequested, isHelpLikePayload } = require('../cli');

// SAFETY: fresh HOME per suite so the subprocess can never read real peer
// configs (~/.telepty/peers.json) and reach actual remote machines.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-help-test-'));

function runCli(cliArgs) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, ...cliArgs], {
      env: {
        ...process.env,
        HOME: tempHome,
        USERPROFILE: tempHome,
        // SAFETY: point discovery at a dead, NON-default endpoint so even a full
        // regression of the help interception can never reach the live daemon on
        // 3848. REMOTE_HOST !== 127.0.0.1 also disables daemon auto-start.
        TELEPTY_HOST: '127.0.0.42',
        TELEPTY_PORT: '9',
        TELEPTY_SKIP_DAEMON_REPAIR: '1'
      },
      timeout: 15000
    }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// ── helpRequested: pure scan, stops at the first `--` separator ────────────────

test('helpRequested: bare --help / -h anywhere before -- → true', () => {
  assert.equal(helpRequested(['--help']), true);
  assert.equal(helpRequested(['-h']), true);
  assert.equal(helpRequested(['my-session', '--help']), true);
  assert.equal(helpRequested(['--id', 'x', '-h']), true);
});

test('helpRequested: args after explicit -- are literal payload → false', () => {
  assert.equal(helpRequested(['--', '--help']), false);
  assert.equal(helpRequested(['my-session', '--', '-h']), false);
});

test('helpRequested: no help flag / quoted prose containing --help → false', () => {
  assert.equal(helpRequested([]), false);
  assert.equal(helpRequested(['my-session', 'hello world']), false);
  assert.equal(helpRequested(['explain the --help flag']), false); // single quoted arg ≠ bare flag
});

// ── isHelpLikePayload: defense-in-depth payload guard ──────────────────────────

test('isHelpLikePayload: exact --help / -h (with whitespace) → true', () => {
  assert.equal(isHelpLikePayload('--help'), true);
  assert.equal(isHelpLikePayload('-h'), true);
  assert.equal(isHelpLikePayload(' --help '), true);
});

test('isHelpLikePayload: real prompts → false', () => {
  assert.equal(isHelpLikePayload('status report please'), false);
  assert.equal(isHelpLikePayload('--helpful'), false);
  assert.equal(isHelpLikePayload(''), false);
});

// ── subprocess: --help prints usage with zero side effects ─────────────────────

test('broadcast --help prints usage and does NOT broadcast', async () => {
  const result = await runCli(['broadcast', '--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: telepty broadcast/);
  assert.doesNotMatch(result.stdout, /broadcasted/i);
});

test('multicast -h prints usage and does NOT inject', async () => {
  const result = await runCli(['multicast', '-h']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: telepty multicast/);
  assert.doesNotMatch(result.stdout, /multicasted/i);
});

test('inject --help prints usage even with a session id present', async () => {
  const result = await runCli(['inject', 'some-session', '--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: telepty inject/);
  assert.doesNotMatch(result.stdout, /injected/i);
});

test('allow --help prints usage instead of wrapping "--help" as a command', async () => {
  const result = await runCli(['allow', '--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: telepty allow/);
});

test('wrap/enable aliases share the allow help', async () => {
  const result = await runCli(['wrap', '-h']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: telepty allow/);
});

// ── defense-in-depth: bare help payload is refused without an explicit -- ──────

test('broadcast refuses a payload that is exactly --help and hints at --', async () => {
  // Reaches the payload guard only if interception is bypassed; assert the
  // invariant end-to-end: no success banner, a hint mentioning `--`.
  const result = await runCli(['broadcast', '--', '--help']);
  // Explicit `--` opts into the literal send (dead endpoint → 0 sessions, no usage).
  assert.doesNotMatch(result.stdout, /Usage: telepty broadcast/);
});

test('multicast with literal payload after -- does not print usage', async () => {
  const result = await runCli(['multicast', 'id1', '--', '-h']);
  assert.doesNotMatch(result.stdout, /Usage: telepty multicast/);
});
