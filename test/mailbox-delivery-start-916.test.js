'use strict';

// #916 block 3 — the mailbox delivery loop has never run in production.
//
// `daemon.js` calls `mailbox.breakStaleLocks()` and `mailboxDelivery.start()` under
// `require.main === module` ALONE, which is false in production (launchd → `telepty daemon` →
// cli.js → `require('./daemon.js')`). Measured on the operator host: `DeliveryEngine.start()`
// logs unconditionally, and `[MAILBOX] DeliveryEngine started` appears **0 times in 47,771 lines**
// of the production daemon log, across many boots.
//
// What still worked without it: `mailboxDelivery.tick()` is invoked synchronously on the inject
// path, so first-attempt delivery happens. What was lost is the BACKGROUND leg — in-flight
// recovery, stale expiry, and retry of a message whose first attempt failed.
//
// Why enabling is safe here (measured 2026-08-16, before the change):
//   • `sessionResolver: () => Object.keys(sessions)` — the loop iterates LIVE sessions only, so
//     the 777 stale mailbox directories under ~/.aigentry/mailbox are never touched.
//   • Every message for every live session is already `acked`: PENDING = 0 across all five. There
//     is no backlog to flush into a live session on start.
//
// Isolation: the daemon binds PORT=0 under its own temp HOME, so it has its own mailbox root and
// its own empty session list.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const DAEMON_JS = path.join(projectRoot, 'daemon.js');

const STARTED_MARKER = /\[MAILBOX\] DeliveryEngine started/;

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'telepty916m-'));
}

// Boot daemon.js the way cli.js does, capturing stdout. Readiness is the LISTEN banner: the
// mailbox start sits mid-module and app.listen is after it, so the banner proves we are past it
// (the lesson from block 1, where waiting on an early artifact raced module load).
function bootDaemonChild(homeDir, { asDaemonMain }) {
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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.out = '';
  child.stdout.on('data', (c) => { child.out += c.toString(); });
  child.stderr.on('data', () => {});
  child.ready = new Promise((resolve) => {
    const check = () => { if (/listening on http:\/\//.test(child.out)) resolve(true); };
    child.stdout.on('data', check);
    setTimeout(() => resolve(false), 15000);
  });
  child.done = new Promise((resolve) => child.once('exit', resolve));
  return child;
}

test('#916.3: the daemon starts its mailbox delivery engine on the production launch path', async () => {
  const homeDir = tempHome();
  const child = bootDaemonChild(homeDir, { asDaemonMain: true });
  try {
    assert.equal(await child.ready, true, 'daemon must reach its LISTEN banner');
    // The banner is emitted after the mailbox block, so by now it has either run or never will.
    assert.match(
      child.out,
      STARTED_MARKER,
      'DeliveryEngine.start() logs unconditionally — its absence is what 47,771 lines of the '
      + 'production log recorded, and is the defect this block fixes'
    );
  } finally {
    child.kill('SIGKILL');
  }
});

test('#916.3: a bare test require still starts no delivery loop and breaks no locks', async () => {
  const homeDir = tempHome();
  const child = bootDaemonChild(homeDir, { asDaemonMain: false });
  await child.done;

  assert.doesNotMatch(
    child.out,
    STARTED_MARKER,
    'requiring daemon.js for its exports must not start a background loop in someone else\'s process'
  );
  assert.doesNotMatch(child.out, /Startup sweep: broke/, 'nor break on-disk mailbox locks');
});
