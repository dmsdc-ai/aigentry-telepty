'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTaskkillArgs,
  killWindowsProcess
} = require('../src/win-kill-process');

test('buildTaskkillArgs: pid 1234 → /PID 1234 /T /F', () => {
  assert.deepEqual(buildTaskkillArgs(1234), ['/PID', '1234', '/T', '/F']);
});

test('buildTaskkillArgs: pid 1 → /PID 1 /T /F', () => {
  assert.deepEqual(buildTaskkillArgs(1), ['/PID', '1', '/T', '/F']);
});

test('buildTaskkillArgs: rejects 0', () => {
  assert.throws(() => buildTaskkillArgs(0), /positive integer/);
});

test('buildTaskkillArgs: rejects negative', () => {
  assert.throws(() => buildTaskkillArgs(-5), /positive integer/);
});

test('buildTaskkillArgs: rejects non-integer', () => {
  assert.throws(() => buildTaskkillArgs(1.5), /positive integer/);
});

test('buildTaskkillArgs: rejects string', () => {
  assert.throws(() => buildTaskkillArgs('1234'), /positive integer/);
});

test('killWindowsProcess: POSIX → returns false (no-op)', () => {
  let called = false;
  const result = killWindowsProcess(1234, {
    platform: 'linux',
    execFileSync: () => { called = true; }
  });
  assert.equal(result, false);
  assert.equal(called, false, 'execFileSync must not be invoked on POSIX');
});

test('killWindowsProcess: darwin → returns false', () => {
  const result = killWindowsProcess(1234, { platform: 'darwin', execFileSync: () => {} });
  assert.equal(result, false);
});

test('killWindowsProcess: win32 + valid pid → invokes taskkill with correct args', () => {
  let captured = null;
  const result = killWindowsProcess(2718, {
    platform: 'win32',
    execFileSync: (cmd, args) => { captured = { cmd, args }; }
  });
  assert.equal(result, true);
  assert.equal(captured.cmd, 'taskkill');
  assert.deepEqual(captured.args, ['/PID', '2718', '/T', '/F']);
});

test('killWindowsProcess: win32 + execFileSync throws → returns false', () => {
  const result = killWindowsProcess(2718, {
    platform: 'win32',
    execFileSync: () => { throw new Error('access denied'); }
  });
  assert.equal(result, false);
});

test('killWindowsProcess: win32 + invalid pid → returns false', () => {
  const result = killWindowsProcess(0, { platform: 'win32', execFileSync: () => {} });
  assert.equal(result, false);
});
