'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSessionId, startTestDaemon, stripAnsi, waitFor } = require('../test-support/daemon-harness');

test('telepty clean --older-than --idle --dry-run lists old idle sessions without removing them', async () => {
  const harness = await startTestDaemon();
  try {
    const oldIdle = createSessionId('clean-old-idle');
    const freshIdle = createSessionId('clean-fresh-idle');
    await harness.registerSession(oldIdle, {
      last_activity_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    });
    await harness.registerSession(freshIdle, {
      last_activity_at: new Date().toISOString()
    });

    const result = await harness.runCli(['clean', '--older-than', '1h', '--idle', '--dry-run']);
    assert.equal(result.code, 0, result.stderr);
    const output = stripAnsi(result.stdout);
    assert.match(output, new RegExp(`Would remove: ${oldIdle}`));
    assert.doesNotMatch(output, new RegExp(freshIdle));

    const list = await harness.request('/api/sessions');
    assert.ok(list.body.some((session) => session.id === oldIdle));
  } finally {
    await harness.stop();
  }
});

test('telepty clean --older-than --idle filters by lastActivityAt', async () => {
  const harness = await startTestDaemon();
  try {
    const oldStartedFreshActivity = createSessionId('clean-old-started');
    const oldIdle = createSessionId('clean-old-idle-filter');
    const oldCreated = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await harness.registerSession(oldStartedFreshActivity, {
      created_at: oldCreated,
      last_activity_at: new Date().toISOString()
    });
    await harness.registerSession(oldIdle, {
      created_at: oldCreated,
      last_activity_at: oldCreated
    });

    const result = await harness.runCli(['clean', '--older-than', '1h', '--idle']);
    assert.equal(result.code, 0, result.stderr);

    await waitFor(async () => {
      const list = await harness.request('/api/sessions');
      const ids = list.body.map((session) => session.id);
      return ids.includes(oldStartedFreshActivity) && !ids.includes(oldIdle);
    }, { timeoutMs: 5000, description: 'idle clean filtering' });
  } finally {
    await harness.stop();
  }
});

test('telepty clean --older-than without --idle filters by createdAt', async () => {
  const harness = await startTestDaemon();
  try {
    const oldStarted = createSessionId('clean-old-created');
    await harness.registerSession(oldStarted, {
      created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      last_activity_at: new Date().toISOString()
    });

    const result = await harness.runCli(['clean', '--older-than', '1h']);
    assert.equal(result.code, 0, result.stderr);

    await waitFor(async () => {
      const list = await harness.request('/api/sessions');
      return list.body.every((session) => session.id !== oldStarted);
    }, { timeoutMs: 5000, description: 'createdAt clean' });
  } finally {
    await harness.stop();
  }
});

test('telepty clean keeps default ghost-only behavior without --older-than', async () => {
  const harness = await startTestDaemon();
  try {
    const ghost = createSessionId('clean-ghost');
    await harness.registerSession(ghost);

    const result = await harness.runCli(['clean']);
    assert.equal(result.code, 0, result.stderr);
    const output = stripAnsi(result.stdout);
    assert.match(output, /Removed ghost/);

    await waitFor(async () => {
      const list = await harness.request('/api/sessions');
      return list.body.every((session) => session.id !== ghost);
    }, { timeoutMs: 5000, description: 'ghost cleanup' });
  } finally {
    await harness.stop();
  }
});

test('telepty clean --older-than handles headless and cmux-backed fixtures through the same daemon path', async () => {
  const harness = await startTestDaemon();
  try {
    const headless = createSessionId('clean-headless');
    const cmux = createSessionId('clean-cmux');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await harness.registerSession(headless, {
      backend: 'pty',
      created_at: old,
      last_activity_at: old
    });
    await harness.registerSession(cmux, {
      backend: 'cmux',
      cmux_workspace_id: 'workspace-123',
      created_at: old,
      last_activity_at: old
    });

    const result = await harness.runCli(['clean', '--older-than', '1h']);
    assert.equal(result.code, 0, result.stderr);

    await waitFor(async () => {
      const list = await harness.request('/api/sessions');
      const ids = list.body.map((session) => session.id);
      return !ids.includes(headless) && !ids.includes(cmux);
    }, { timeoutMs: 5000, description: 'multi-host clean' });
  } finally {
    await harness.stop();
  }
});
