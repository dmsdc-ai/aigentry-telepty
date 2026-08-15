'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { cleanupDaemonProcesses } = require('../daemon-control');

// telepty#15 — port-owner fallback attribution.
// Each test injects state-file/process-scan/port-owner sources via opts so the
// host's real ps/lsof output and ~/.telepty/daemon-state.json do not leak in.

function killerOk(captured) {
  return (pid) => {
    captured.push(pid);
    return true;
  };
}

test('cleanup: only state-file source → stopped attributed to state-file', () => {
  const killed = [];
  const result = cleanupDaemonProcesses({
    readDaemonState: () => ({ pid: 4242, host: '127.0.0.1', port: 3848, version: '0.3.5' }),
    listDaemonProcesses: () => [],
    findPortOwnerPid: () => null,
    // #844: the state-file source now confirms identity like the other two, so this stub has to
    // answer for the pid it is asked about. This test is about ATTRIBUTION, not about whether an
    // unconfirmed pid is killed — that property is asserted in positive-evidence-844.test.js.
    pidMatchesTeleptyCmdline: (pid) => pid === 4242,
    stopDaemonProcess: killerOk(killed)
  });

  assert.equal(result.stopped.length, 1);
  assert.equal(result.stopped[0].source, 'state-file');
  assert.equal(result.stopped[0].pid, 4242);
  assert.equal(result.failed.length, 0);
  assert.deepEqual(killed, [4242]);
});

test('cleanup: process-scan only → stopped attributed to process-scan', () => {
  const killed = [];
  const result = cleanupDaemonProcesses({
    readDaemonState: () => null,
    listDaemonProcesses: () => [{ pid: 5151, commandLine: 'node cli.js daemon' }],
    findPortOwnerPid: () => null,
    pidMatchesTeleptyCmdline: () => false,
    stopDaemonProcess: killerOk(killed)
  });

  assert.equal(result.stopped.length, 1);
  assert.equal(result.stopped[0].source, 'process-scan');
  assert.equal(result.stopped[0].pid, 5151);
  assert.equal(result.stopped[0].commandLine, 'node cli.js daemon');
  assert.deepEqual(killed, [5151]);
});

test('cleanup: port-owner is confirmed telepty → added with port-owner source', () => {
  const killed = [];
  const result = cleanupDaemonProcesses({
    readDaemonState: () => null,
    listDaemonProcesses: () => [],
    findPortOwnerPid: () => 6262,
    pidMatchesTeleptyCmdline: (pid) => pid === 6262,
    stopDaemonProcess: killerOk(killed)
  });

  assert.equal(result.stopped.length, 1);
  assert.equal(result.stopped[0].source, 'port-owner');
  assert.equal(result.stopped[0].pid, 6262);
  assert.deepEqual(killed, [6262]);
});

test('cleanup: port-owner present but NOT confirmed → no kill (safety)', () => {
  const killed = [];
  const result = cleanupDaemonProcesses({
    readDaemonState: () => null,
    listDaemonProcesses: () => [],
    findPortOwnerPid: () => 7373,
    pidMatchesTeleptyCmdline: () => false,
    stopDaemonProcess: killerOk(killed)
  });

  assert.equal(result.stopped.length, 0, 'unconfirmed port-owner must never be killed');
  assert.equal(result.failed.length, 0);
  assert.deepEqual(killed, []);
});

test('cleanup: port-owner = current process → ignored', () => {
  const killed = [];
  const result = cleanupDaemonProcesses({
    readDaemonState: () => null,
    listDaemonProcesses: () => [],
    findPortOwnerPid: () => process.pid,
    pidMatchesTeleptyCmdline: () => true,
    stopDaemonProcess: killerOk(killed)
  });

  assert.equal(result.stopped.length, 0);
  assert.deepEqual(killed, []);
});

test('cleanup: state-file pid wins over port-owner when overlapping', () => {
  // Same PID surfaced via two sources — first source (state-file) sticks.
  const killed = [];
  const result = cleanupDaemonProcesses({
    readDaemonState: () => ({ pid: 8484 }),
    listDaemonProcesses: () => [],
    findPortOwnerPid: () => 8484,
    pidMatchesTeleptyCmdline: () => true,
    stopDaemonProcess: killerOk(killed)
  });

  assert.equal(result.stopped.length, 1);
  assert.equal(result.stopped[0].source, 'state-file');
  assert.deepEqual(killed, [8484]);
});

test('cleanup: includePortOwner=false → skips port-owner branch entirely', () => {
  let portOwnerCalled = false;
  const result = cleanupDaemonProcesses({
    readDaemonState: () => null,
    listDaemonProcesses: () => [],
    findPortOwnerPid: () => { portOwnerCalled = true; return 9999; },
    pidMatchesTeleptyCmdline: () => true,
    stopDaemonProcess: killerOk([]),
    includePortOwner: false
  });
  assert.equal(portOwnerCalled, false);
  assert.equal(result.stopped.length, 0);
});

test('cleanup: kill failure → entry in failed not stopped', () => {
  const result = cleanupDaemonProcesses({
    readDaemonState: () => ({ pid: 1111 }),
    listDaemonProcesses: () => [],
    findPortOwnerPid: () => null,
    pidMatchesTeleptyCmdline: (pid) => pid === 1111, // #844: the state-file source confirms too
    stopDaemonProcess: () => false
  });
  assert.equal(result.stopped.length, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].source, 'state-file');
});

test('cleanup: state-file pid equals current process → ignored (don\'t self-kill)', () => {
  const killed = [];
  const result = cleanupDaemonProcesses({
    readDaemonState: () => ({ pid: process.pid }),
    listDaemonProcesses: () => [],
    findPortOwnerPid: () => null,
    pidMatchesTeleptyCmdline: () => false,
    stopDaemonProcess: killerOk(killed)
  });
  assert.equal(result.stopped.length, 0);
  assert.deepEqual(killed, []);
});
