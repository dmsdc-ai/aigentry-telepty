'use strict';

// #910 — the production daemon never claims daemon-state.json.
//
// `daemon.js` guards its singleton claim on `require.main === module` ALONE. In production the
// launchd plist runs `telepty daemon` → cli.js → `require('./daemon.js')`, so `require.main` is
// cli.js and the claim never runs. Measured on the operator host: a live daemon (pid 98714) with
// no `~/.telepty/daemon-state.json` at all.
//
// #896 fixed exactly this guard for the process TITLE three lines above
// (`require.main === module || process.env.AIGENTRY_TELEPTY_DAEMON_MAIN === '1'`) and left the
// claim on the old one. cli.js sets that env flag immediately before the require (cli.js:1699),
// so it is the signal that separates "a real daemon is booting" from "a test wants the exports".
//
// Consequences of the claim never running, all of them live today:
//   • no singleton guard — a second daemon does not detect the first through the state file
//   • `scripts/postinstall.js` gates its upgrade on the state file, so `npm i -g` reports
//     "No running daemon detected — nothing to restart" and never upgrades a running daemon
//   • #902's D1.2 state-file port gate has nothing to read
//
// Isolation: every daemon here binds PORT=0 under its own temp HOME, and the only processes these
// tests signal are their own children.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const DAEMON_JS = path.join(projectRoot, 'daemon.js');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'telepty910-'));
}

function statePath(homeDir) {
  return path.join(homeDir, '.telepty', 'daemon-state.json');
}

// Boot daemon.js the way a caller does, in a child process with its own HOME.
//   asDaemonMain: true  → the PRODUCTION shape (cli.js sets the env flag, then requires)
//   asDaemonMain: false → a bare test require (#896's contract: claims nothing)
function bootDaemonChild(homeDir, { asDaemonMain }) {
  const script = asDaemonMain
    ? `process.env.AIGENTRY_TELEPTY_DAEMON_MAIN='1'; require(${JSON.stringify(DAEMON_JS)});`
    : `require(${JSON.stringify(DAEMON_JS)});`;

  return spawn(process.execPath, ['-e', script], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      PORT: '0',                    // OS-assigned: never the operator's 3848
      TELEPTY_NO_TAILNET_AUTO: '1',
    },
    stdio: 'ignore',
  });
}

async function waitFor(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test('#910: a daemon booted the way cli.js boots it claims daemon-state.json', async () => {
  const homeDir = tempHome();
  const child = bootDaemonChild(homeDir, { asDaemonMain: true });
  try {
    const claimed = await waitFor(() => fs.existsSync(statePath(homeDir)));
    assert.equal(
      claimed,
      true,
      'the production launch path (env flag set, require.main = cli.js) must write daemon-state.json'
    );

    const state = JSON.parse(fs.readFileSync(statePath(homeDir), 'utf8'));
    assert.equal(state.pid, child.pid, 'the claim records the daemon process that made it');
    assert.ok(state.version, 'the claim records the version postinstall compares against');
    assert.ok(Object.prototype.hasOwnProperty.call(state, 'port'), 'the claim records the port #902 D1.2 gates on');
  } finally {
    child.kill('SIGKILL');
  }
});

test('#910: a bare test require still claims nothing (#896 contract)', async () => {
  const homeDir = tempHome();
  const child = bootDaemonChild(homeDir, { asDaemonMain: false });
  try {
    // Give it the same budget the positive case gets, then assert the ABSENCE.
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(
      fs.existsSync(statePath(homeDir)),
      false,
      'requiring daemon.js for its exports must never overwrite a live daemon\'s claim'
    );
  } finally {
    child.kill('SIGKILL');
  }
});

// Guard (green both sides): postinstall's upgrade path is gated on the state file existing, so
// this is what #910 unblocks in production. Unit-level — no real install, every seam injected.
test('#910: postinstall reaches its upgrade path once a state file exists', async () => {
  const postinstall = require('../scripts/postinstall.js');
  const pkg = require('../package.json');
  const logs = [];
  let cleanupCalled = 0;

  await postinstall.main({
    env: { npm_config_global: 'true' }, // postinstall only acts on a GLOBAL install
    logger: { log: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    readDaemonState: () => ({ pid: 4242, port: 3848, version: '0.0.1-stale' }),
    detectSupervisor: () => ({ present: false, kind: null, detail: null }),
    cleanupDaemonProcesses: () => { cleanupCalled += 1; return { stopped: [], failed: [] }; },
    startDetachedDaemon: () => {},
    waitForDaemonVersion: async () => ({ version: pkg.version }),
  });

  assert.equal(cleanupCalled, 1, 'a stale running daemon is what postinstall exists to replace');
  assert.equal(
    logs.some((m) => /No running daemon detected/.test(m)),
    false,
    'that early return is the branch #910 stops production from taking every time'
  );
});
