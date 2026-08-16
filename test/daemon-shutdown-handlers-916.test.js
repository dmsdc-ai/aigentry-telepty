'use strict';

// #916 block 1 — the daemon has no graceful shutdown in production.
//
// `daemon.js` registers SIGINT/SIGTERM → shutdown(0) and an `exit` → clearDaemonState handler
// under `require.main === module` ALONE. Production runs `telepty daemon` → cli.js →
// `require('./daemon.js')`, so `require.main` is cli.js and none of it was ever registered:
// every real daemon has died on the default SIGTERM disposition, with no `mailboxDelivery.stop()`,
// no `mailboxNotifier.cancelAll()` and no `clearDaemonState()`.
//
// This is the same guard #896 fixed for the process title and #910 fixed for the singleton claim.
// It is block 1 of #916 because it is the other half of #910: #910 makes the daemon WRITE
// daemon-state.json, and this makes it CLEAR it on the way out. Without both, a state file
// outlives the daemon that wrote it.
//
// Corroboration from the field: during #902's incident `launchctl` recorded `last exit -15` for
// the daemon job. A registered SIGTERM handler calling `shutdown(0)` would have exited 0.
//
// Isolation: the daemon here binds PORT=0 under its own temp HOME, and the only process these
// tests signal is their own child.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const DAEMON_JS = path.join(projectRoot, 'daemon.js');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'telepty916-'));
}

function statePath(homeDir) {
  return path.join(homeDir, '.telepty', 'daemon-state.json');
}

// Boot daemon.js exactly the way cli.js does: set the env flag, then require. `require.main` is
// this `-e` script, never daemon.js — which is the whole point.
function bootDaemonChild(homeDir) {
  const child = spawn(process.execPath, ['-e', `process.env.AIGENTRY_TELEPTY_DAEMON_MAIN='1'; require(${JSON.stringify(DAEMON_JS)});`], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      PORT: '0',
      TELEPTY_NO_TAILNET_AUTO: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Readiness must be the LISTEN banner, not the state file. claimDaemonState runs near the top
  // of daemon.js and the signal handlers are registered at the very bottom, so a test that
  // signals on the state file alone races module load and kills the daemon before the handlers
  // it is testing exist. The banner is emitted after app.listen, past both.
  child.ready = new Promise((resolve) => {
    let buf = '';
    child.stdout.on('data', (c) => {
      buf += c.toString();
      if (/listening on http:\/\//.test(buf)) resolve(true);
    });
    child.stderr.on('data', () => {}); // drain: an unread pipe stalls the child
    setTimeout(() => resolve(false), 15000);
  });

  return child;
}

async function waitFor(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function waitExit(child, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    child.once('exit', (code, signal) => finish({ code, signal }));
    setTimeout(() => finish({ code: null, signal: 'TIMEOUT' }), timeoutMs);
  });
}

test('#916.1: SIGTERM runs the daemon shutdown path — exit 0, state file cleared', async () => {
  if (process.platform === 'win32') return; // POSIX signal semantics
  const homeDir = tempHome();
  const child = bootDaemonChild(homeDir);
  try {
    assert.equal(await child.ready, true, 'the daemon must reach its LISTEN banner — past the handler registration');
    assert.equal(
      await waitFor(() => fs.existsSync(statePath(homeDir))), true,
      '#910 must have claimed the state file before this test means anything'
    );

    child.kill('SIGTERM');
    const exit = await waitExit(child);

    assert.deepEqual(
      exit,
      { code: 0, signal: null },
      'a SIGTERM handler calling shutdown(0) exits 0; the default disposition dies by signal — '
      + 'which is exactly what launchctl recorded as "last exit -15" during #902'
    );
    assert.equal(
      fs.existsSync(statePath(homeDir)),
      false,
      'shutdown() must clear the claim it made — otherwise a state file outlives its daemon'
    );
  } finally {
    child.kill('SIGKILL');
  }
});

test('#916.1: SIGINT takes the same path', async () => {
  if (process.platform === 'win32') return;
  const homeDir = tempHome();
  const child = bootDaemonChild(homeDir);
  try {
    assert.equal(await child.ready, true, 'daemon must be fully up before signalling');
    assert.equal(await waitFor(() => fs.existsSync(statePath(homeDir))), true);

    child.kill('SIGINT');
    const exit = await waitExit(child);

    assert.deepEqual(exit, { code: 0, signal: null }, 'SIGINT is handled identically to SIGTERM');
    assert.equal(fs.existsSync(statePath(homeDir)), false);
  } finally {
    child.kill('SIGKILL');
  }
});

test('#916.1: a bare test require registers nothing (the guard still discriminates)', async () => {
  if (process.platform === 'win32') return;
  // No env flag: this is the "somebody required daemon.js for its exports" case. It must neither
  // claim state (#910/#896's contract) nor install process-wide signal handlers.
  const homeDir = tempHome();
  const child = spawn(process.execPath, ['-e',
    `require(${JSON.stringify(DAEMON_JS)});`
    // daemon.js logs on require (persistence restore etc), so carry the answer in a marker
    // rather than assuming stdout is ours alone.
    + `setTimeout(()=>{ process.stdout.write('<<SIGTERM_LISTENERS=' + process.listenerCount('SIGTERM') + '>>'); process.exit(0); }, 300);`
  ], {
    cwd: projectRoot,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, PORT: '0', TELEPTY_NO_TAILNET_AUTO: '1' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  let out = '';
  child.stdout.on('data', (c) => { out += c.toString(); });
  await waitExit(child);

  const marker = out.match(/<<SIGTERM_LISTENERS=(\d+)>>/);
  assert.ok(marker, `child did not report its listener count; output was: ${out.slice(-200)}`);
  assert.equal(marker[1], '0', 'a plain require must not install SIGTERM handlers in someone else\'s process');
  assert.equal(fs.existsSync(statePath(homeDir)), false, 'and must not claim the state file');
});
