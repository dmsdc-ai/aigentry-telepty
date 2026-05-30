'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const persistence = require('../src/session-store/persistence');

test('persisted session save/load preserves the legacy sessions.json bytes', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-session-store-'));
  try {
    const persistPath = path.join(tmpDir, 'sessions.json');
    const sessions = {
      alpha: {
        type: 'wrapped',
        command: 'claude',
        cwd: '/work/alpha',
        backend: 'cmux',
        cmuxWorkspaceId: 'workspace-1',
        cmuxSurfaceId: 'surface-1',
        termProgram: 'kitty',
        term: 'xterm-kitty',
        delivery: { transport: 'unix_socket', address: '/tmp/alpha.sock' },
        deliveryEndpoint: '/tmp/alpha.sock',
        createdAt: '2026-05-30T01:02:03.000Z',
        lastActivityAt: '2026-05-30T01:03:03.000Z',
        lastConnectedAt: '2026-05-30T01:04:03.000Z',
        lastDisconnectedAt: '',
        lastStateReportAt: '2026-05-30T01:05:03.000Z',
        stateReport: { phase: 'implementing', current_task: 'extract persistence', seq: 7 },
        idleTtl: '30m',
        idleTtlMs: 1800000,
        ownerPid: 1234,
        ptyPid: 5678
      },
      beta: {
        type: 'spawned',
        command: 'bash',
        cwd: '/work/beta',
        createdAt: '2026-05-30T02:02:03.000Z',
        lastActivityAt: null,
        idleTtlMs: null,
        ownerPid: 0,
        ptyPid: 4321
      }
    };
    const expected = {
      alpha: {
        id: 'alpha',
        type: 'wrapped',
        command: 'claude',
        cwd: '/work/alpha',
        backend: 'cmux',
        cmuxWorkspaceId: 'workspace-1',
        cmuxSurfaceId: 'surface-1',
        termProgram: 'kitty',
        term: 'xterm-kitty',
        delivery: { transport: 'unix_socket', address: '/tmp/alpha.sock' },
        deliveryEndpoint: '/tmp/alpha.sock',
        createdAt: '2026-05-30T01:02:03.000Z',
        lastActivityAt: '2026-05-30T01:03:03.000Z',
        lastConnectedAt: '2026-05-30T01:04:03.000Z',
        lastDisconnectedAt: null,
        lastStateReportAt: '2026-05-30T01:05:03.000Z',
        stateReport: { phase: 'implementing', current_task: 'extract persistence', seq: 7 },
        idleTtl: '30m',
        idleTtlMs: 1800000,
        ownerPid: 1234,
        ptyPid: 5678
      },
      beta: {
        id: 'beta',
        type: 'spawned',
        command: 'bash',
        cwd: '/work/beta',
        backend: null,
        cmuxWorkspaceId: null,
        cmuxSurfaceId: null,
        termProgram: null,
        term: null,
        delivery: null,
        deliveryEndpoint: null,
        createdAt: '2026-05-30T02:02:03.000Z',
        lastActivityAt: null,
        lastConnectedAt: null,
        lastDisconnectedAt: null,
        lastStateReportAt: null,
        stateReport: null,
        idleTtl: null,
        idleTtlMs: null,
        ownerPid: null,
        ptyPid: 4321
      }
    };

    persistence.savePersistedSessions(sessions, persistPath);

    assert.equal(fs.readFileSync(persistPath, 'utf8'), JSON.stringify(expected, null, 2));
    assert.deepEqual(persistence.loadPersistedSessions(persistPath), expected);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('persisted wrapped-session restore keeps awaiting-reconnect shape', () => {
  const meta = {
    id: 'alpha',
    type: 'wrapped',
    command: 'claude',
    cwd: '/work/alpha',
    backend: 'cmux',
    cmuxWorkspaceId: 'workspace-1',
    cmuxSurfaceId: 'surface-1',
    termProgram: 'kitty',
    term: 'xterm-kitty',
    createdAt: '2026-05-30T01:02:03.000Z',
    lastActivityAt: '2026-05-30T01:03:03.000Z',
    lastConnectedAt: '2026-05-30T01:04:03.000Z',
    lastDisconnectedAt: '2026-05-30T01:05:03.000Z',
    lastStateReportAt: '2026-05-30T01:06:03.000Z',
    stateReport: { phase: 'implementing', seq: 7 },
    idleTtl: '30m',
    idleTtlMs: 1800000,
    ownerPid: 1234,
    ptyPid: 5678
  };

  const restored = persistence.buildRestoredWrappedSession('alpha', meta, { cwd: '/fallback' });

  assert.deepEqual(restored, {
    id: 'alpha', type: 'wrapped', ptyProcess: null, ownerWs: null,
    command: 'claude', cwd: '/work/alpha',
    backend: 'cmux',
    cmuxWorkspaceId: 'workspace-1',
    cmuxSurfaceId: 'surface-1',
    termProgram: 'kitty',
    term: 'xterm-kitty',
    createdAt: '2026-05-30T01:02:03.000Z',
    lastActivityAt: '2026-05-30T01:03:03.000Z',
    lastConnectedAt: '2026-05-30T01:04:03.000Z',
    lastDisconnectedAt: '2026-05-30T01:05:03.000Z',
    lastStateReportAt: '2026-05-30T01:06:03.000Z',
    stateReport: { phase: 'implementing', seq: 7 },
    idleTtl: '30m',
    idleTtlMs: 1800000,
    ownerPid: 1234,
    ptyPid: 5678,
    clients: new Set(), isClosing: false, outputRing: [], ready: true,     });
  assert.equal(persistence.buildRestoredWrappedSession('beta', { type: 'spawned' }), null);
});
