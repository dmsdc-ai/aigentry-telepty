'use strict';

// telepty#15 — when daemon-state.json is absent (older bundled daemon predates it),
// the CLI used to fail restart 3 times with backoff and repeat the full mismatch +
// failure banner on EVERY command, despite sessions working fine through the old
// daemon. Covered here:
//   - findParentProcessInfo: PPID + parent command discovery (mocked exec)
//   - formatDaemonStopDiagnostic: actionable "owned by parent Y" diagnostic
//   - restartDaemonGraceful: fail-FAST when the port owner survives cleanup
//     (no meaningless 3-attempt retry loop)
//   - ensureDaemonRunning: identical blocked state warns once, then stays silent
//     (restart-failure marker), and a successful restart clears the marker
//
// SAFETY: every process/port/daemon interaction is injected — no real daemon,
// process table, or ~/.telepty file is touched.

// Disable the update notifier before requiring cli.js so requiring it stays inert.
process.env.TELEPTY_DISABLE_UPDATE_NOTIFIER = '1';
process.env.NO_UPDATE_NOTIFIER = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pkg = require('../package.json');
const {
  findParentProcessInfo,
  readRestartFailureMarker,
  writeRestartFailureMarker,
  clearRestartFailureMarker
} = require('../daemon-control');
const { ensureDaemonRunning, formatDaemonStopDiagnostic, restartDaemonGraceful } = require('../cli');

function captureStderr() {
  const chunks = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  return {
    text: () => chunks.join(''),
    restore: () => { process.stderr.write = original; }
  };
}

function captureConsoleError() {
  const chunks = [];
  const original = console.error;
  console.error = (...parts) => { chunks.push(parts.join(' ')); };
  return {
    text: () => chunks.join('\n'),
    restore: () => { console.error = original; }
  };
}

// ── findParentProcessInfo (mocked exec) ─────────────────────────────────────────

test('findParentProcessInfo: resolves ppid + parent command on posix', () => {
  const calls = [];
  const exec = (command) => {
    calls.push(command);
    if (command.includes('-o ppid=')) return ' 10823\n';
    if (command.includes('-o comm=')) return '/Applications/aterm.app/Contents/MacOS/aterm\n';
    throw new Error(`unexpected exec: ${command}`);
  };
  const info = findParentProcessInfo(10861, { platform: 'darwin', execSync: exec });
  assert.deepEqual(info, { ppid: 10823, command: '/Applications/aterm.app/Contents/MacOS/aterm' });
  assert.ok(calls[0].includes('ps -p 10861'), 'first query targets the daemon pid');
  assert.ok(calls[1].includes('ps -p 10823'), 'second query targets the parent pid');
});

test('findParentProcessInfo: null on exec failure / bad pid', () => {
  const failing = () => { throw new Error('ps failed'); };
  assert.equal(findParentProcessInfo(123, { platform: 'linux', execSync: failing }), null);
  assert.equal(findParentProcessInfo(0, { platform: 'linux' }), null);
  assert.equal(findParentProcessInfo(-5, { platform: 'linux' }), null);
});

test('findParentProcessInfo: parses windows "ppid|name" output', () => {
  const exec = () => '10823|aterm.exe\n';
  const info = findParentProcessInfo(10861, { platform: 'win32', execSync: exec });
  assert.deepEqual(info, { ppid: 10823, command: 'aterm.exe' });
});

// ── formatDaemonStopDiagnostic ──────────────────────────────────────────────────

test('formatDaemonStopDiagnostic: names the parent app and gives the kill command', () => {
  const text = formatDaemonStopDiagnostic({ pid: 10861, parent: { ppid: 10823, command: 'aterm' } });
  assert.match(text, /Daemon \(PID 10861\) is owned by parent aterm \(pid 10823\)/);
  assert.match(text, /restart that app/);
  assert.match(text, /kill 10861 && telepty daemon/);
});

test('formatDaemonStopDiagnostic: still actionable without parent info', () => {
  const text = formatDaemonStopDiagnostic({ pid: 4242, parent: null });
  assert.match(text, /Daemon \(PID 4242\) could not be stopped/);
  assert.match(text, /kill 4242 && telepty daemon/);
});

// ── restartDaemonGraceful: blocked → fail fast, no 3-attempt noise ─────────────

test('restartDaemonGraceful: surviving port owner → ONE attempt, no daemon start, diagnostic', async () => {
  let starts = 0;
  let cleanups = 0;
  const errors = captureConsoleError();
  try {
    const result = await restartDaemonGraceful({
      _cleanupDaemonProcesses: () => { cleanups += 1; return { stopped: [], failed: [{ pid: 777, source: 'state-file' }] }; },
      _startDetachedDaemon: () => { starts += 1; },
      _waitForDaemonHealth: async () => null,
      _findPortOwnerPid: () => 777,
      _findParentProcessInfo: () => ({ ppid: 555, command: 'aterm' })
    });
    assert.equal(result.success, false);
    assert.equal(result.blockedPid, 777);
    assert.equal(result.attempt, 1, 'must fail fast — the old 3-attempt backoff loop was pure noise');
    assert.equal(cleanups, 1, 'cleanup runs exactly once');
    assert.equal(starts, 0, 'a new daemon must not be started when the port can never be bound');
    assert.match(result.diagnostic, /owned by parent aterm \(pid 555\)/);
    assert.match(errors.text(), /Daemon restart blocked/);
  } finally {
    errors.restore();
  }
});

test('restartDaemonGraceful: port freed by cleanup → starts the new daemon and succeeds', async () => {
  let starts = 0;
  const result = await restartDaemonGraceful({
    _cleanupDaemonProcesses: () => ({ stopped: [], failed: [] }),
    _startDetachedDaemon: () => { starts += 1; },
    _waitForDaemonHealth: async () => ({ version: pkg.version, capabilities: [] }),
    _findPortOwnerPid: () => null,
    _findParentProcessInfo: () => null
  });
  assert.equal(result.success, true);
  assert.equal(starts, 1);
});

// ── restart-failure marker: file helpers (injected path — never ~/.telepty) ────

test('restart-failure marker: write → read → clear roundtrip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-marker-'));
  const file = path.join(dir, 'restart-failure.json');
  assert.equal(readRestartFailureMarker({ file }), null);
  writeRestartFailureMarker({ signature: 'sig-1', diagnostic: 'd', warnedAt: 'now' }, { file });
  assert.equal(readRestartFailureMarker({ file }).signature, 'sig-1');
  clearRestartFailureMarker({ file });
  assert.equal(readRestartFailureMarker({ file }), null);
});

// ── ensureDaemonRunning: same blocked mismatch warns once per state ────────────

function blockedEnsureOptions(overrides = {}) {
  return {
    _getDaemonMeta: async () => ({ version: '0.1.98', capabilities: [] }),
    _fetchWithAuth: async () => ({ ok: true, json: async () => [] }),
    _findPortOwnerPid: () => 10861,
    _probe: { attempts: 1, backoffMs: 0 },
    ...overrides
  };
}

test('ensureDaemonRunning: first blocked restart warns and records the marker', async () => {
  const written = [];
  const restarts = [];
  const stderr = captureStderr();
  try {
    await ensureDaemonRunning(blockedEnsureOptions({
      _restartDaemonGraceful: async (opts) => {
        restarts.push(opts);
        return { success: false, blockedPid: 10861, diagnostic: 'Daemon (PID 10861) is owned by parent aterm' };
      },
      _readRestartFailureMarker: () => null,
      _writeRestartFailureMarker: (marker) => written.push(marker),
      _clearRestartFailureMarker: () => {}
    }));
    assert.equal(restarts.length, 1, 'first sighting must attempt the restart');
    assert.match(stderr.text(), /version mismatch/);
    assert.equal(written.length, 1, 'blocked failure must be recorded');
    assert.match(written[0].signature, /pid10861/);
  } finally {
    stderr.restore();
  }
});

test('ensureDaemonRunning: identical blocked state again → silent, no restart attempt', async () => {
  const restarts = [];
  const stderr = captureStderr();
  try {
    // Recompute what ensureDaemonRunning will derive for this state, by running the
    // recording pass first (above test shape), then replay with that marker present.
    let recorded = null;
    await ensureDaemonRunning(blockedEnsureOptions({
      _restartDaemonGraceful: async () => ({ success: false, blockedPid: 10861, diagnostic: 'x' }),
      _readRestartFailureMarker: () => null,
      _writeRestartFailureMarker: (marker) => { recorded = marker; },
      _clearRestartFailureMarker: () => {}
    }));
    assert.ok(recorded, 'precondition: marker recorded on first pass');

    const silent = captureStderr();
    try {
      await ensureDaemonRunning(blockedEnsureOptions({
        _restartDaemonGraceful: async (opts) => { restarts.push(opts); return { success: true }; },
        _readRestartFailureMarker: () => recorded,
        _writeRestartFailureMarker: () => { throw new Error('must not re-record'); },
        _clearRestartFailureMarker: () => {}
      }));
      assert.equal(restarts.length, 0, 'identical blocked state must not retry the restart');
      assert.equal(silent.text(), '', 'identical blocked state must not re-warn');
    } finally {
      silent.restore();
    }
  } finally {
    stderr.restore();
  }
});

test('ensureDaemonRunning: signature change (new pid) → warns and retries again', async () => {
  const restarts = [];
  const stderr = captureStderr();
  try {
    await ensureDaemonRunning(blockedEnsureOptions({
      _findPortOwnerPid: () => 20999, // blocking daemon was replaced — different pid
      _restartDaemonGraceful: async (opts) => { restarts.push(opts); return { success: true }; },
      _readRestartFailureMarker: () => ({ signature: `version-mismatch-or-other:0.1.98->${pkg.version}:pid10861` }),
      _writeRestartFailureMarker: () => {},
      _clearRestartFailureMarker: () => {}
    }));
    assert.equal(restarts.length, 1, 'a different blocked pid is a new state — retry');
    assert.match(stderr.text(), /version mismatch/);
  } finally {
    stderr.restore();
  }
});

test('ensureDaemonRunning: successful restart clears the failure marker', async () => {
  let cleared = 0;
  const stderr = captureStderr();
  try {
    await ensureDaemonRunning(blockedEnsureOptions({
      _restartDaemonGraceful: async () => ({ success: true, meta: { version: pkg.version } }),
      _readRestartFailureMarker: () => null,
      _writeRestartFailureMarker: () => { throw new Error('must not record on success'); },
      _clearRestartFailureMarker: () => { cleared += 1; }
    }));
    assert.equal(cleared, 1, 'success must clear any stale marker');
  } finally {
    stderr.restore();
  }
});
