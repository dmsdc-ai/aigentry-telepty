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

test('surface mismatch debounce emits fixed payload after threshold and suppresses repeats', () => {
  const startedMs = Date.parse('2026-06-06T00:00:00.000Z');
  const session = {
    backend: 'cmux',
    cmuxWorkspaceId: 'workspace:7',
    ptyPid: 4242
  };
  const probe = {
    status: 'mismatch',
    reason: 'tty_mismatch',
    expectedPtyPid: 4242,
    observedSurface: 'surface:9 "stray shell" tty=ttys999'
  };
  const emitted = [];
  const emit = (extra) => {
    const event = { type: 'surface_mismatched', ...extra };
    emitted.push(event);
    return event;
  };

  assert.deepEqual(
    lifecycle.applySurfaceMismatchProbe('worker-codex', session, probe, {
      nowMs: startedMs,
      debounceSeconds: 10,
      emit
    }),
    { action: 'mark', reason: 'tty_mismatch', mismatchSeconds: 0 }
  );
  assert.equal(emitted.length, 0);

  const beforeThreshold = lifecycle.applySurfaceMismatchProbe('worker-codex', session, probe, {
    nowMs: startedMs + 9999,
    debounceSeconds: 10,
    emit
  });
  assert.equal(beforeThreshold.action, 'skip');
  assert.equal(beforeThreshold.reason, 'debouncing');
  assert.equal(emitted.length, 0);

  const atThreshold = lifecycle.applySurfaceMismatchProbe('worker-codex', session, probe, {
    nowMs: startedMs + 10000,
    debounceSeconds: 10,
    emit
  });
  assert.equal(atThreshold.action, 'emit');
  assert.deepEqual(atThreshold.extra, {
    sid: 'worker-codex',
    backend: 'cmux',
    cmuxWorkspaceId: 'workspace:7',
    expectedPtyPid: 4242,
    observedSurface: 'surface:9 "stray shell" tty=ttys999',
    mismatchSeconds: 10
  });
  assert.deepEqual(emitted, [{ type: 'surface_mismatched', ...atThreshold.extra }]);

  const repeat = lifecycle.applySurfaceMismatchProbe('worker-codex', session, probe, {
    nowMs: startedMs + 20000,
    debounceSeconds: 10,
    emit
  });
  assert.equal(repeat.action, 'skip');
  assert.equal(repeat.reason, 'already_emitted');
  assert.equal(emitted.length, 1);
});

test('surface mismatch debounce clears on match or unknown observations', () => {
  const nowMs = Date.parse('2026-06-06T00:00:00.000Z');
  const session = {
    backend: 'cmux',
    cmuxWorkspaceId: 'workspace:7',
    ptyPid: 4242
  };

  lifecycle.applySurfaceMismatchProbe('worker-codex', session, {
    status: 'mismatch',
    expectedPtyPid: 4242,
    observedSurface: 'surface:9 "stray shell"'
  }, { nowMs, debounceSeconds: 10 });

  const cleared = lifecycle.applySurfaceMismatchProbe('worker-codex', session, {
    status: 'unknown',
    reason: 'cmux_unreachable',
    expectedPtyPid: 4242
  }, { nowMs: nowMs + 1000, debounceSeconds: 10 });

  assert.equal(cleared.action, 'recover');
  assert.equal(session.surfaceMismatchAt, null);
  assert.equal(session.surfaceMismatchObserved, null);
  assert.equal(session.surfaceMismatchEmitted, false);
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
