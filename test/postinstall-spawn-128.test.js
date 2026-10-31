'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const hook = require('../scripts/postinstall');

test('#128: installed CLI is launched via Node, independent of PATH shims', async () => {
  const calls = [];
  const child = new EventEmitter();
  child.unref = () => calls.push('unref');
  const pending = hook.spawnDetachedDaemon(process.execPath, { spawn: (...args) => { calls.push(args); return child; } });
  child.emit('spawn');
  await pending;
  assert.deepEqual(calls[0], [process.execPath, [path.resolve(__dirname, '../cli.js'), 'daemon'], { detached: true, stdio: 'ignore', windowsHide: true }]);
  assert.equal(calls[1], 'unref');
});

test('#128: async respawn failure is reported without success or rollback exception', async () => {
  const logs = [];
  await hook.main({
    env: { npm_config_global: 'true' },
    readDaemonState: () => ({ pid: 123, version: 'old' }),
    detectSupervisor: () => ({ present: false }),
    cleanupDaemonProcesses: () => ({ stopped: [123], failed: [] }),
    spawnDetachedDaemon: async () => { throw new Error('ENOENT'); },
    logger: { log: s => logs.push(s), warn: s => logs.push(s) }
  });
  assert.ok(logs.some(s => /respawn failed: ENOENT/.test(s)));
  assert.ok(!logs.some(s => /spawned fresh/.test(s)));
});

test('#128: actual asynchronous spawn error is handled by the hook helper', () => {
  const script = `require('./scripts/postinstall').spawnDetachedDaemon('/nonexistent/telepty-node').then(() => process.exitCode = 9, e => { console.error(e.code); });`;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /ENOENT/);
  assert.doesNotMatch(result.stderr, /Unhandled 'error'/);
});
