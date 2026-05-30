'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function defaultSessionPersistPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.config', 'aigentry-telepty', 'sessions.json');
}

function serializePersistedSessions(sessions) {
  const data = {};
  for (const [id, s] of Object.entries(sessions)) {
    data[id] = {
      id,
      type: s.type,
      command: s.command,
      cwd: s.cwd,
      backend: s.backend || null,
      cmuxWorkspaceId: s.cmuxWorkspaceId || null,
      cmuxSurfaceId: s.cmuxSurfaceId || null,
      termProgram: s.termProgram || null,
      term: s.term || null,
      delivery: s.delivery || null,
      deliveryEndpoint: s.deliveryEndpoint || null,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt || null,
      lastConnectedAt: s.lastConnectedAt || null,
      lastDisconnectedAt: s.lastDisconnectedAt || null,
      lastStateReportAt: s.lastStateReportAt || null,
      stateReport: s.stateReport || null,
      idleTtl: s.idleTtl || null,
      idleTtlMs: s.idleTtlMs == null ? null : s.idleTtlMs,
      ownerPid: s.ownerPid || null,
      ptyPid: s.ptyPid || null
    };
  }
  return data;
}

function savePersistedSessions(sessions, persistPath = defaultSessionPersistPath()) {
  try {
    const data = serializePersistedSessions(sessions);
    fs.mkdirSync(path.dirname(persistPath), { recursive: true });
    fs.writeFileSync(persistPath, JSON.stringify(data, null, 2));
  } catch {}
}

function loadPersistedSessions(persistPath = defaultSessionPersistPath()) {
  try {
    if (!fs.existsSync(persistPath)) return {};
    return JSON.parse(fs.readFileSync(persistPath, 'utf8'));
  } catch { return {}; }
}

function buildRestoredWrappedSession(id, meta, options = {}) {
  if (meta.type !== 'wrapped') return null;

  const cwd = options.cwd || process.cwd();
  const nowIso = options.nowIso || (() => new Date().toISOString());
  return {
    id, type: 'wrapped', ptyProcess: null, ownerWs: null,
    command: meta.command || 'wrapped', cwd: meta.cwd || cwd,
    backend: meta.backend || 'kitty',
    cmuxWorkspaceId: meta.cmuxWorkspaceId || null,
    cmuxSurfaceId: meta.cmuxSurfaceId || null,
    termProgram: meta.termProgram || null,
    term: meta.term || null,
    createdAt: meta.createdAt || nowIso(),
    lastActivityAt: meta.lastActivityAt || nowIso(),
    lastConnectedAt: meta.lastConnectedAt || null,
    lastDisconnectedAt: meta.lastDisconnectedAt || meta.lastActivityAt || nowIso(),
    lastStateReportAt: meta.lastStateReportAt || null,
    stateReport: meta.stateReport || null,
    idleTtl: meta.idleTtl || null,
    idleTtlMs: meta.idleTtlMs == null ? null : meta.idleTtlMs,
    ownerPid: meta.ownerPid || null,
    ptyPid: meta.ptyPid || null,
    clients: new Set(), isClosing: false, outputRing: [], ready: true,     };
}

module.exports = {
  defaultSessionPersistPath,
  serializePersistedSessions,
  savePersistedSessions,
  loadPersistedSessions,
  buildRestoredWrappedSession
};
