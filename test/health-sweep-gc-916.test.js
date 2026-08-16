'use strict';

// #916 block 2 — the session health sweep, including the stale-disconnect GC.
//
// `setInterval(…, HEALTH_POLL_MS)` was guarded on `require.main === module` alone, false in
// production (launchd → `telepty daemon` → cli.js → `require('./daemon.js')`), so this sweep has
// never run on a real daemon. It is the last of the four blocks in #916 and the one that was held
// for an explicit owner decision, because it is not only telemetry: at the end of every pass it
// DELETES sessions —
//
//   (wrapped|aterm) && no owner socket && no clients && disconnectedSeconds >= SESSION_CLEANUP_SECONDS
//     ⇒ delete sessions[id]; revokeSessionCredential(id); sessionStateManager.unregister(id)
//
// The deployment gate the owner chose is the threshold itself: `SESSION_CLEANUP_SECONDS` reads
// `TELEPTY_SESSION_CLEANUP_SECONDS` at boot (default 300s, floored at SESSION_STALE_SECONDS), and
// this host's launchd plist now carries 86400 — so a bridge has a full day to come back rather
// than five minutes. These tests pin both halves: that the sweep is armed on the launch path
// production uses, and that the threshold is the operator's value rather than the default.
//
// Isolation: every daemon binds PORT=0 under its own temp HOME. Nothing here touches :3848.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const DAEMON_JS = path.join(projectRoot, 'daemon.js');

const ARMED_RE = /\[HEALTH\] session sweep armed \(poll=(\d+)ms, stale-disconnect cleanup after (\d+)s\)/;

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'telepty916h-'));
}

// Boot daemon.js the way cli.js does. Readiness is the LISTEN banner, which is emitted after this
// block, so by then the sweep has either armed or never will.
function bootDaemonChild(homeDir, env = {}, { asDaemonMain = true } = {}) {
  const script = asDaemonMain
    ? `process.env.AIGENTRY_TELEPTY_DAEMON_MAIN='1'; require(${JSON.stringify(DAEMON_JS)});`
    : `require(${JSON.stringify(DAEMON_JS)}); setTimeout(()=>process.exit(0), 1200);`;

  const child = spawn(process.execPath, ['-e', script], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      PORT: '0',
      TELEPTY_NO_TAILNET_AUTO: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.out = '';
  child.stdout.on('data', (c) => { child.out += c.toString(); });
  child.stderr.on('data', () => {});
  child.ready = new Promise((resolve) => {
    child.stdout.on('data', () => { if (/listening on http:\/\//.test(child.out)) resolve(true); });
    setTimeout(() => resolve(false), 15000);
  });
  child.done = new Promise((resolve) => child.once('exit', resolve));
  return child;
}

test('#916.2: the health/GC sweep is armed on the production launch path', async () => {
  const homeDir = tempHome();
  const child = bootDaemonChild(homeDir);
  try {
    assert.equal(await child.ready, true, 'daemon must reach its LISTEN banner');
    assert.match(
      child.out,
      ARMED_RE,
      'the sweep must arm on the launch path production actually uses — this is the block that '
      + 'never ran on a real daemon'
    );
  } finally {
    child.kill('SIGKILL');
  }
});

test('#916.2: the cleanup threshold honours TELEPTY_SESSION_CLEANUP_SECONDS', async () => {
  const homeDir = tempHome();
  const child = bootDaemonChild(homeDir, { TELEPTY_SESSION_CLEANUP_SECONDS: '86400' });
  try {
    assert.equal(await child.ready, true);
    const m = child.out.match(ARMED_RE);
    assert.ok(m, `armed line missing; tail was: ${child.out.slice(-300)}`);
    assert.equal(
      m[2],
      '86400',
      'the daemon must read the operator knob at boot — this is the gate the plist relies on'
    );
  } finally {
    child.kill('SIGKILL');
  }
});

test('#916.2: without the knob the threshold is the 300s default', async () => {
  const homeDir = tempHome();
  // Explicitly clear it: the parent test process may inherit the operator's value.
  const child = bootDaemonChild(homeDir, { TELEPTY_SESSION_CLEANUP_SECONDS: '' });
  try {
    assert.equal(await child.ready, true);
    const m = child.out.match(ARMED_RE);
    assert.ok(m, 'armed line missing');
    assert.equal(m[2], '300', 'the documented default is unchanged by this block');
  } finally {
    child.kill('SIGKILL');
  }
});

test('#916.2: the threshold is floored at SESSION_STALE_SECONDS, not taken raw', async () => {
  // SESSION_CLEANUP_SECONDS = max(SESSION_STALE_SECONDS, env||300). A tiny value must not let the
  // GC outrun the staleness definition it depends on.
  const homeDir = tempHome();
  const child = bootDaemonChild(homeDir, {
    TELEPTY_SESSION_CLEANUP_SECONDS: '1',
    TELEPTY_SESSION_STALE_SECONDS: '45',
  });
  try {
    assert.equal(await child.ready, true);
    const m = child.out.match(ARMED_RE);
    assert.ok(m, 'armed line missing');
    assert.equal(m[2], '45', 'a below-floor knob is raised to SESSION_STALE_SECONDS');
  } finally {
    child.kill('SIGKILL');
  }
});

test('#916.2: a bare test require arms no sweep (the guard still discriminates)', async () => {
  const homeDir = tempHome();
  const child = bootDaemonChild(homeDir, {}, { asDaemonMain: false });
  await child.done;

  assert.doesNotMatch(
    child.out,
    ARMED_RE,
    'requiring daemon.js for its exports must not start a session-deleting timer in someone '
    + 'else\'s process'
  );
});
