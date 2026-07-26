'use strict';

// #757 — version-change restarts must not create a detached daemon when an OS
// supervisor is installed. Every process/supervisor operation here is injected.

process.env.TELEPTY_DISABLE_UPDATE_NOTIFIER = '1';
process.env.NO_UPDATE_NOTIFIER = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const pkg = require('../package.json');
const { restartDaemonGraceful } = require('../cli');
const {
  LAUNCHD_LABEL,
  SYSTEMD_SERVICE_NAME,
  WINDOWS_TASK_NAME,
  restartSupervisorDaemon
} = require('../src/supervisor');
const postinstall = require('../scripts/postinstall');

const launchd = () => ({ present: true, kind: 'launchd', detail: '/tmp/com.aigentry.telepty.plist' });
const absent = () => ({ present: false, kind: null, detail: null });

function logger() {
  const lines = [];
  return {
    lines,
    log: (msg) => lines.push(`log:${msg}`),
    warn: (msg) => lines.push(`warn:${msg}`)
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

test('restartSupervisorDaemon: launchd uses kickstart on the installed label', () => {
  const calls = [];
  const result = restartSupervisorDaemon(launchd(), {
    getuid: () => 501,
    execFileSync: (cmd, args) => { calls.push([cmd, args]); }
  });

  assert.equal(result.success, true);
  assert.deepEqual(calls, [
    ['launchctl', ['kickstart', '-k', `gui/501/${LAUNCHD_LABEL}`]]
  ]);
});

test('restartSupervisorDaemon: systemd variants and schtasks use their supervisors', () => {
  const calls = [];
  const execFileSync = (cmd, args) => { calls.push([cmd, args]); };

  assert.equal(restartSupervisorDaemon({ present: true, kind: 'systemd' }, { execFileSync }).success, true);
  assert.equal(restartSupervisorDaemon({ present: true, kind: 'systemd-user' }, { execFileSync }).success, true);
  assert.equal(restartSupervisorDaemon({ present: true, kind: 'schtasks' }, { execFileSync }).success, true);

  assert.deepEqual(calls, [
    ['systemctl', ['restart', SYSTEMD_SERVICE_NAME]],
    ['systemctl', ['--user', 'restart', SYSTEMD_SERVICE_NAME]],
    ['schtasks', ['/run', '/tn', WINDOWS_TASK_NAME]]
  ]);
});

test('restartDaemonGraceful: supervised restart uses supervisor and never starts detached (#757)', async () => {
  let detachedStarts = 0;
  let supervisorRestarts = 0;
  let healthCalls = 0;

  const result = await restartDaemonGraceful({
    maxAttempts: 1,
    _detectSupervisor: launchd,
    _cleanupDaemonProcesses: () => ({ stopped: [{ pid: 111 }], failed: [] }),
    _startDetachedDaemon: () => { detachedStarts += 1; },
    _restartSupervisorDaemon: () => { supervisorRestarts += 1; return { success: true }; },
    _waitForDaemonHealth: async () => {
      healthCalls += 1;
      return healthCalls === 1 ? null : { version: pkg.version, capabilities: [] };
    },
    _findPortOwnerPid: () => null,
    _findParentProcessInfo: () => null
  });

  assert.equal(result.success, true);
  assert.equal(result.supervisor, 'launchd');
  assert.equal(supervisorRestarts, 1);
  assert.equal(detachedStarts, 0);
});

test('restartDaemonGraceful: supervisor auto-restore is accepted without detached spawn', async () => {
  let detachedStarts = 0;
  let supervisorRestarts = 0;

  const result = await restartDaemonGraceful({
    maxAttempts: 1,
    _detectSupervisor: launchd,
    _cleanupDaemonProcesses: () => ({ stopped: [{ pid: 111 }], failed: [] }),
    _startDetachedDaemon: () => { detachedStarts += 1; },
    _restartSupervisorDaemon: () => { supervisorRestarts += 1; return { success: true }; },
    _waitForDaemonHealth: async () => ({ version: pkg.version, capabilities: [] }),
    _findPortOwnerPid: () => null,
    _findParentProcessInfo: () => null
  });

  assert.equal(result.success, true);
  assert.equal(supervisorRestarts, 0);
  assert.equal(detachedStarts, 0);
});

test('restartDaemonGraceful: supervised restart failure does not fall back to detached spawn', async () => {
  let detachedStarts = 0;
  const errors = captureConsoleError();
  try {
    const result = await restartDaemonGraceful({
      maxAttempts: 1,
      _detectSupervisor: launchd,
      _cleanupDaemonProcesses: () => ({ stopped: [], failed: [] }),
      _startDetachedDaemon: () => { detachedStarts += 1; },
      _restartSupervisorDaemon: () => ({ success: false, error: 'launchctl failed' }),
      _waitForDaemonHealth: async () => null,
      _findPortOwnerPid: () => null,
      _findParentProcessInfo: () => null
    });

    assert.equal(result.success, false);
    assert.equal(detachedStarts, 0);
    assert.match(result.diagnostic, /launchctl failed/);
    assert.match(errors.text(), /restart blocked/);
  } finally {
    errors.restore();
  }
});

test('postinstall: supervised stale daemon restarts through supervisor, not detached spawn', async () => {
  const log = logger();
  let detachedStarts = 0;
  let supervisorRestarts = 0;

  await postinstall.main({
    env: { npm_config_global: 'true' },
    logger: log,
    readDaemonState: () => ({ pid: 222, port: 49152, version: '0.0.1' }),
    detectSupervisor: launchd,
    cleanupDaemonProcesses: () => ({ stopped: [{ pid: 222 }], failed: [] }),
    restartSupervisorDaemon: () => { supervisorRestarts += 1; return { success: true }; },
    waitForDaemonVersion: async () => ({ pid: 333, version: pkg.version }),
    spawnDetachedDaemon: () => { detachedStarts += 1; }
  });

  assert.equal(supervisorRestarts, 1);
  assert.equal(detachedStarts, 0);
  assert.match(log.lines.join('\n'), /launchd started/);
});

test('postinstall: unsupervised stale daemon keeps detached fallback', async () => {
  const log = logger();
  let detachedStarts = 0;

  await postinstall.main({
    env: { npm_config_global: 'true' },
    logger: log,
    readDaemonState: () => ({ pid: 222, port: 49152, version: '0.0.1' }),
    detectSupervisor: absent,
    cleanupDaemonProcesses: () => ({ stopped: [{ pid: 222 }], failed: [] }),
    resolveTeleptyBin: () => 'telepty',
    spawnDetachedDaemon: () => { detachedStarts += 1; }
  });

  assert.equal(detachedStarts, 1);
  assert.match(log.lines.join('\n'), /spawned fresh/);
});
