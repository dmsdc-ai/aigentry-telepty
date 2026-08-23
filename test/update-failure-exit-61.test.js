'use strict';

// gh#61 defect 1 — `telepty update` must not report success when it did not succeed.
//
// `repairLocalDaemon` RETURNS the restart verdict (`{versionMatch:false}`); it does not throw.
// The update branch ignored the return value entirely, so this sequence was possible:
//
//   ✅ Update complete! Restarting daemon...
//   ❌ Daemon restart failed after 3 supervisor attempt(s). ...
//   🎉 You are now using the latest version.     ← printed anyway, exit 0
//
// The reporter read that banner while six live sessions were already unreachable, and only found
// out from a later `telepty list`. Same family as the #941 help guards: a command that reports a
// success it can observe it did not get.
//
// SAFETY — this suite exercises the UPDATE command, so every escape route out of the process is
// closed before it runs:
//   * TELEPTY_UPDATE_COMMAND redirects the install to a sentinel script; the real
//     `npm install -g` is never executed.
//   * npm_config_prefix points under a temp dir, so even a fallthrough could not write to the
//     user's global node.
//   * TELEPTY_PORT never names 3848. The failure fixture uses an OS-assigned ephemeral port held
//     by a separate helper process; the success fixture uses a dead port plus
//     TELEPTY_SKIP_DAEMON_REPAIR=1.
//   * The daemon repair therefore addresses a port the live daemon does not own. `supervisorFor`
//     (cli.js) returns `{present:false}` unless the addressed port equals the SUPERVISED job's
//     port, so `launchctl kickstart` is unreachable from here; and the telepty#15 port-owner
//     fail-fast returns before `startDetachedDaemon()`, so no daemon process is spawned either.
//   * The port holder is a separate child, not the test runner, so even a misdirected kill could
//     not take down this suite.

process.env.TELEPTY_DISABLE_UPDATE_NOTIFIER = '1';
process.env.NO_UPDATE_NOTIFIER = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const { updateRestartSucceeded } = require('../cli');

const projectRoot = path.resolve(__dirname, '..');
const cliPath = path.join(projectRoot, 'cli.js');
// Deliberately NOT prefixed "telepty-": nothing in this suite's paths should be able to look
// like a telepty process to a cmdline-confirmation step.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tp941b-'));

function makeUpdateSentinel(name) {
  const sentinel = path.join(tempHome, `${name}.ran`);
  const script = path.join(tempHome, `${name}.js`);
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran');\n`);
  return { sentinel, command: `"${process.execPath}" "${script}"` };
}

function runUpdate(extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, 'update'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOME: tempHome,
        USERPROFILE: tempHome,
        npm_config_prefix: tempHome,
        ...extraEnv
      },
      timeout: 60000
    }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// A foreign listener on an OS-assigned port, in its OWN process. `stopDaemon` only kills a port
// owner whose cmdline confirms as telepty, so this survives the repair's cleanup pass and makes
// telepty#15's port-owner fail-fast fire on attempt 1 — a real restart failure, in ~no time, with
// no daemon spawned and nothing retried.
function startPortHolder() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '-e',
      "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>console.log(s.address().port));setInterval(()=>{},1<<30);"
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => reject(new Error('port holder did not report a port')), 10000);
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      const match = out.match(/(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ port: Number(match[1]), stop: () => child.kill('SIGKILL') });
      }
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

// ── the decision, as a pure function ──────────────────────────────────────────

test('updateRestartSucceeded: a restart that reported success is a success', () => {
  assert.equal(updateRestartSucceeded({ versionMatch: true }), true);
});

test('updateRestartSucceeded: a restart that reported failure is NOT a success', () => {
  assert.equal(updateRestartSucceeded({ versionMatch: false }), false);
});

test('updateRestartSucceeded: a SKIPPED repair is not a failure', () => {
  // TELEPTY_SKIP_DAEMON_REPAIR=1 means the operator turned the repair off. There is no verdict
  // to report and nothing was claimed, so this must not be reported as a dead daemon.
  assert.equal(updateRestartSucceeded({ stopped: 0, failed: 0, meta: null, skipped: true }), true);
});

test('updateRestartSucceeded: an unknown or absent verdict fails closed', () => {
  assert.equal(updateRestartSucceeded(undefined), false);
  assert.equal(updateRestartSucceeded(null), false);
  assert.equal(updateRestartSucceeded({}), false);
});

// ── end to end ────────────────────────────────────────────────────────────────

test('control: an update whose daemon repair is SKIPPED still reports success and exits 0', async () => {
  // Proves the success path is reachable in this fixture. Without it, the failure assertions
  // below could pass because `telepty update` never succeeds here for some unrelated reason.
  const { sentinel, command } = makeUpdateSentinel('control-skip');
  const result = await runUpdate({
    TELEPTY_UPDATE_COMMAND: command,
    TELEPTY_SKIP_DAEMON_REPAIR: '1',
    TELEPTY_HOST: '127.0.0.42',
    TELEPTY_PORT: '9'
  });

  assert.equal(fs.existsSync(sentinel), true, 'the update command did not run — fixture is broken');
  assert.equal(result.code, 0, `expected exit 0 on success, got ${result.code}. stderr:\n${result.stderr}`);
  assert.match(result.stdout, /You are now using the latest version/);
});

test('update whose daemon restart FAILS exits non-zero and does not claim success (gh#61)', async () => {
  const holder = await startPortHolder();
  try {
    const { sentinel, command } = makeUpdateSentinel('blocked-restart');
    const result = await runUpdate({
      TELEPTY_UPDATE_COMMAND: command,
      TELEPTY_HOST: '127.0.0.1',
      TELEPTY_PORT: String(holder.port)
    });

    // The install half genuinely ran; only the daemon restart failed. That is precisely the
    // reported situation — a successful install with a dead daemon behind it.
    assert.equal(fs.existsSync(sentinel), true, 'the update command did not run — fixture is broken');

    const all = `${result.stdout}\n${result.stderr}`;
    assert.match(all, /Daemon restart blocked|Daemon restart failed/,
      'fixture did not actually fail the restart');
    assert.notEqual(result.code, 0,
      '`telepty update` exited 0 after the daemon restart failed (gh#61 defect 1)');
    assert.doesNotMatch(result.stdout, /You are now using the latest version/,
      'the celebration line printed after a failed restart (gh#61 defect 1)');
  } finally {
    holder.stop();
  }
});

test('a failed restart says the daemon is down and what to do about it', async () => {
  // The report asked for this explicitly: the consequence users care about is that existing
  // sessions are now disconnected, and the original output never said so.
  const holder = await startPortHolder();
  try {
    const { command } = makeUpdateSentinel('blocked-message');
    const result = await runUpdate({
      TELEPTY_UPDATE_COMMAND: command,
      TELEPTY_HOST: '127.0.0.1',
      TELEPTY_PORT: String(holder.port)
    });

    const all = `${result.stdout}\n${result.stderr}`;
    assert.match(all, /sessions are disconnected/i);
    assert.match(all, /telepty daemon restart/);
  } finally {
    holder.stop();
  }
});
