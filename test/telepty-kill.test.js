'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const lifecycle = require('../src/lifecycle');
const { createSessionId, startTestDaemon, stripAnsi, waitFor } = require('../test-support/daemon-harness');

test('killSessionProcess sends SIGTERM then SIGKILL when the process stays alive', async () => {
  const signals = [];
  const result = await lifecycle.killSessionProcess({ ptyPid: 4242 }, {
    timeoutMs: 25,
    sleep: async (ms) => { signals.push(`sleep:${ms}`); },
    processKill: (pid, signal) => { signals.push(`${pid}:${signal}`); },
    isAlive: () => true,
    platform: 'linux'
  });

  assert.deepEqual(signals, ['4242:SIGTERM', 'sleep:25', '4242:SIGKILL']);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.escalated, true);
  assert.equal(result.escalatedSignal, 'SIGKILL');
});

test('killSessionProcess --force sends SIGKILL immediately', async () => {
  const signals = [];
  const result = await lifecycle.killSessionProcess({ ptyPid: 5252 }, {
    force: true,
    timeoutMs: 5000,
    sleep: async () => { signals.push('sleep'); },
    processKill: (pid, signal) => { signals.push(`${pid}:${signal}`); },
    platform: 'linux'
  });

  assert.deepEqual(signals, ['5252:SIGKILL']);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.escalated, false);
});

test('killSessionProcess honors custom timeout before escalation', async () => {
  let slept = null;
  await lifecycle.killSessionProcess({ ptyPid: 6262 }, {
    timeoutMs: 1234,
    sleep: async (ms) => { slept = ms; },
    processKill: () => {},
    isAlive: () => false,
    platform: 'linux'
  });

  assert.equal(slept, 1234);
});

test('killSessionProcess uses Windows taskkill path on win32', async () => {
  const calls = [];
  const result = await lifecycle.killSessionProcess({ ptyPid: 7373 }, {
    force: true,
    platform: 'win32',
    killWindowsProcess: (pid) => {
      calls.push(pid);
      return true;
    }
  });

  assert.deepEqual(calls, [7373]);
  assert.equal(result.signaled, true);
});

test('telepty kill returns a clear error for a missing session', async () => {
  const harness = await startTestDaemon();
  try {
    const missing = createSessionId('missing-kill');
    const result = await harness.runCli(['kill', missing, '--timeout', '0']);
    assert.notEqual(result.code, 0);
    const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
    assert.match(output, /not found|Session .*not found/i);
  } finally {
    await harness.stop();
  }
});

test('telepty kill --force removes a live session from the registry', async () => {
  const harness = await startTestDaemon();
  try {
    const sessionId = createSessionId('kill-live');
    const spawn = await harness.spawnSession(sessionId, {
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000);']
    });
    assert.equal(spawn.status, 201);

    const before = await harness.request('/api/sessions');
    const session = before.body.find((item) => item.id === sessionId);
    assert.ok(session && session.ptyPid, 'spawned session should expose ptyPid');

    const result = await harness.runCli(['kill', sessionId, '--force', '--timeout', '0']);
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);

    await waitFor(async () => {
      const list = await harness.request('/api/sessions');
      return list.body.every((item) => item.id !== sessionId);
    }, { timeoutMs: 5000, description: 'killed session removal' });
  } finally {
    await harness.stop();
  }
});
