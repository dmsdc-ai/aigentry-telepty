'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const lifecycle = require('../src/lifecycle');

test('surface GC marks a newly gone cmux surface', () => {
  assert.equal(lifecycle.decideSurfaceGc('gone', {}, Date.now(), 30), 'mark');
});

test('surface GC skips a gone cmux surface still inside the grace window', () => {
  const nowMs = Date.now();
  const session = {
    surfaceGoneAt: new Date(nowMs - 29 * 1000).toISOString()
  };

  assert.equal(lifecycle.decideSurfaceGc('gone', session, nowMs, 30), 'skip');
});

test('surface GC reclaims a gone cmux surface after the grace window', () => {
  const nowMs = Date.now();
  const session = {
    surfaceGoneAt: new Date(nowMs - 30 * 1000).toISOString()
  };

  assert.equal(lifecycle.decideSurfaceGc('gone', session, nowMs, 30), 'reclaim');
});

test('surface GC recovers when a previously gone cmux surface returns', () => {
  const nowMs = Date.now();
  const session = {
    surfaceGoneAt: new Date(nowMs - 5 * 1000).toISOString()
  };

  assert.equal(lifecycle.decideSurfaceGc('alive', session, nowMs, 30), 'recover');
});

test('surface GC skips unknown liveness to preserve INV-17', () => {
  const nowMs = Date.now();
  const session = {
    surfaceGoneAt: new Date(nowMs - 60 * 1000).toISOString()
  };

  assert.equal(lifecycle.decideSurfaceGc('unknown', session, nowMs, 30), 'skip');
});

test('idle TTL victim selection is independent of workspace host metadata', () => {
  const nowMs = Date.now();
  const old = new Date(nowMs - 2 * 60 * 60 * 1000).toISOString();
  const sessions = {
    headless: {
      id: 'headless',
      backend: 'pty',
      lastActivityAt: old
    },
    cmux: {
      id: 'cmux',
      backend: 'cmux',
      cmuxWorkspaceId: 'cmux-workspace',
      lastActivityAt: old
    }
  };

  const victims = lifecycle.selectIdleTtlVictims(sessions, { idleTtlDefaultMs: 60 * 60 * 1000 }, { nowMs });
  assert.deepEqual(victims.map((victim) => victim.id).sort(), ['cmux', 'headless']);
});

test('clean older-than target selection handles headless and cmux sessions identically', () => {
  const nowMs = Date.now();
  const old = new Date(nowMs - 2 * 60 * 60 * 1000).toISOString();
  const sessions = [
    { id: 'headless', backend: 'pty', createdAt: old, lastActivityAt: old },
    { id: 'cmux', backend: 'cmux', cmuxWorkspaceId: 'cmux-workspace', createdAt: old, lastActivityAt: old }
  ];

  const targets = lifecycle.selectCleanOlderThanTargets(sessions, {
    olderThanMs: 60 * 60 * 1000,
    nowMs
  });
  assert.deepEqual(targets.map((target) => target.id).sort(), ['cmux', 'headless']);
});

test('killSessionProcess uses process signals and never invokes workspace-host commands', async () => {
  const signals = [];
  const session = {
    id: 'cmux-backed',
    backend: 'cmux',
    cmuxWorkspaceId: 'cmux-workspace',
    ptyPid: 8181
  };

  const result = await lifecycle.killSessionProcess(session, {
    force: true,
    platform: 'linux',
    processKill: (pid, signal) => signals.push({ pid, signal })
  });

  assert.deepEqual(signals, [{ pid: 8181, signal: 'SIGKILL' }]);
  assert.equal(result.signaled, true);
});
