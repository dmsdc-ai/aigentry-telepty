'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const dc = require('../daemon-control');

// telepty#44 — daemon restart never stops the old daemon on macOS/Linux.
//
// Root cause: the running daemon renames itself `process.title = 'telepty-daemon'`
// (daemon.js:188). On macOS/Linux that REPLACES the command field `ps -axo command=`
// returns, so the daemon appears literally as `telepty-daemon` (hyphen). The stop
// heuristic `isLikelyTeleptyDaemon` only matched `'telepty daemon'` (space), so the
// process-scan source AND the port-owner confirmation (`pidMatchesTeleptyCmdline`)
// were both blind to the daemon's own production title.
//
// The prior fixtures (daemon-control-port-owner.test.js) injected a synthetic
// `node cli.js daemon` command line and a stubbed `pidMatchesTeleptyCmdline`, which
// is exactly why this slipped through. These tests use the REAL production title.

// The exact value the daemon sets at runtime (daemon.js:188). Kept as a literal so a
// future rename of process.title forces an intentional update here.
const PRODUCTION_TITLE = 'telepty-daemon';

test('isLikelyTeleptyDaemon recognizes the real production process.title', () => {
  assert.equal(
    dc.isLikelyTeleptyDaemon(PRODUCTION_TITLE),
    true,
    "the daemon's own process.title ('telepty-daemon') must be recognized as a telepty daemon"
  );
});

test('isLikelyTeleptyDaemon still matches the pre-existing tokens (no regression)', () => {
  // Windows path: Win32_Process.CommandLine is unaffected by process.title, so the
  // real launch command line is still seen — must keep matching.
  assert.equal(dc.isLikelyTeleptyDaemon('node /usr/lib/node_modules/@dmsdc-ai/aigentry-telepty/cli.js daemon'), true);
  assert.equal(dc.isLikelyTeleptyDaemon('telepty daemon'), true);
  assert.equal(dc.isLikelyTeleptyDaemon('node /opt/aigentry-telepty/daemon.js'), true);
});

test('isLikelyTeleptyDaemon rejects unrelated processes', () => {
  assert.equal(dc.isLikelyTeleptyDaemon(''), false);
  assert.equal(dc.isLikelyTeleptyDaemon(null), false);
  assert.equal(dc.isLikelyTeleptyDaemon('node server.js'), false);
  assert.equal(dc.isLikelyTeleptyDaemon('/Applications/Foo.app/Contents/MacOS/Foo'), false);
});

// Faithful end-to-end fixture: spawn a REAL throwaway process whose process.title is
// the exact production value, then drive the REAL identity functions against it.
// No daemon, no port, no state file — just the title, so the live port-3848 daemon is
// never touched. The child is the only process we ever kill.
function spawnTitledChild() {
  // -e program sets process.title then idles; stdio ignored so it stays detached-clean.
  return spawn(process.execPath, ['-e', `process.title=${JSON.stringify(PRODUCTION_TITLE)}; setTimeout(()=>{}, 10000)`], {
    stdio: 'ignore'
  });
}

function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('pidMatchesTeleptyCmdline confirms a process whose real title is telepty-daemon', async () => {
  if (process.platform === 'win32') return; // title-replacement bug is Unix-only
  const child = spawnTitledChild();
  try {
    await waitMs(700); // let ps observe the renamed title
    assert.equal(
      dc.pidMatchesTeleptyCmdline(child.pid),
      true,
      'port-owner confirmation must recognize the real telepty-daemon title'
    );
  } finally {
    child.kill('SIGKILL');
  }
});

test('listDaemonProcesses includes a process whose real title is telepty-daemon', async () => {
  if (process.platform === 'win32') return;
  const child = spawnTitledChild();
  try {
    await waitMs(700);
    const list = dc.listDaemonProcesses();
    assert.ok(
      list.some((p) => p.pid === child.pid),
      'process-scan must surface the real telepty-daemon title as a daemon candidate'
    );
  } finally {
    child.kill('SIGKILL');
  }
});

// Restart stop-decision against the REAL title via the port-owner fallback path
// (the path that matters when the state file is missing/stale). We inject the killer
// so NOTHING is actually signalled, and inject findPortOwnerPid to point at our own
// throwaway child — but the confirmation runs through the REAL pidMatchesTeleptyCmdline
// against the REAL 'telepty-daemon' title. state-file / process-scan sources are stubbed
// empty so only the port-owner+title path is exercised.
test('cleanupDaemonProcesses selects a real telepty-daemon-titled port owner for stop', async () => {
  if (process.platform === 'win32') return;
  const child = spawnTitledChild();
  try {
    await waitMs(700);
    const killed = [];
    const result = dc.cleanupDaemonProcesses({
      readDaemonState: () => null,
      listDaemonProcesses: () => [],
      findPortOwnerPid: () => child.pid, // pretend our titled child owns the port
      // NOTE: pidMatchesTeleptyCmdline intentionally NOT injected → real confirmation runs.
      stopDaemonProcess: (pid) => { killed.push(pid); return true; }, // never really kill
      includePortOwner: true
    });

    assert.deepEqual(killed, [child.pid], 'the real telepty-daemon-titled port owner must be selected for stop');
    assert.equal(result.stopped.length, 1);
    assert.equal(result.stopped[0].source, 'port-owner');
    assert.equal(result.stopped[0].pid, child.pid);
  } finally {
    child.kill('SIGKILL');
  }
});
