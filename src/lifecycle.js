'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { killWindowsProcess } = require('./win-kill-process');

// #17: grace window before a cmux session whose workspace was explicitly closed (bridge
// survived → headless zombie) is reclaimed. Shorter than the 300s disconnect-GC: the surface
// is confirmed gone (not merely disconnected). The window absorbs cmux transient hiccups.
const SURFACE_ORPHAN_SECONDS = Math.max(5, Number(process.env.TELEPTY_SURFACE_ORPHAN_SECONDS || 30));
const SURFACE_MISMATCH_SECONDS = Math.max(1, Number(process.env.TELEPTY_SURFACE_MISMATCH_SECONDS || 10));

const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/i;
const UNIT_MS = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000
};

function parseDuration(value, options = {}) {
  const fieldName = options.fieldName || 'duration';
  if (value == null || value === '') {
    throw new Error(`${fieldName} is required`);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${fieldName} must be a non-negative duration`);
    }
    return Math.floor(value);
  }

  const raw = String(value).trim().toLowerCase();
  if (raw === 'off') {
    return null;
  }

  const match = raw.match(DURATION_RE);
  if (!match) {
    throw new Error(`${fieldName} must be a duration like 30m, 1h, 2d, or off`);
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isSafeInteger(amount)) {
    throw new Error(`${fieldName} is too large`);
  }
  return amount * UNIT_MS[unit];
}

function computeIdleSeconds(lastActivityAt, nowMs = Date.now()) {
  if (!lastActivityAt) return null;
  const ts = new Date(lastActivityAt).getTime();
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.floor((nowMs - ts) / 1000));
}

function formatIdleDuration(seconds) {
  const totalMinutes = Math.max(0, Math.floor(Number(seconds || 0) / 60));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function getSessionPid(session) {
  if (!session) return null;
  const candidates = [
    session.ptyProcess && session.ptyProcess.pid,
    session.ptyPid,
    session.pty_pid,
    session.pid,
    session.ownerPid,
    session.owner_pid
  ];
  for (const pid of candidates) {
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

function isProcessAlive(pid, processKill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    processKill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendSignal(pid, signal, options = {}) {
  const platform = options.platform || process.platform;
  if (platform === 'win32') {
    if (signal === 'SIGKILL' || signal === 'SIGTERM') {
      return (options.killWindowsProcess || killWindowsProcess)(pid, options.windows || {});
    }
    return false;
  }

  const processKill = options.processKill || process.kill;
  try {
    processKill(pid, signal);
    return true;
  } catch (err) {
    if (err && err.code === 'ESRCH') return false;
    throw err;
  }
}

async function killSessionProcess(session, options = {}) {
  const pid = options.pid || getSessionPid(session);
  const timeoutMs = Math.max(0, Math.floor(options.timeoutMs ?? 5000));
  const force = options.force === true;
  const sleep = options.sleep || defaultSleep;
  const processKill = options.processKill || process.kill;
  const platform = options.platform || process.platform;

  if (!pid) {
    return { pid: null, signaled: false, escalated: false, reason: 'NO_PROCESS' };
  }

  if (force) {
    const killed = sendSignal(pid, 'SIGKILL', { ...options, platform, processKill });
    return { pid, signaled: killed, signal: 'SIGKILL', escalated: false, reason: killed ? null : 'NOT_RUNNING' };
  }

  const terminated = sendSignal(pid, 'SIGTERM', { ...options, platform, processKill });
  if (!terminated) {
    return { pid, signaled: false, signal: 'SIGTERM', escalated: false, reason: 'NOT_RUNNING' };
  }

  if (timeoutMs > 0) {
    await sleep(timeoutMs);
  }

  const alive = options.isAlive ? options.isAlive(pid) : isProcessAlive(pid, processKill);
  if (!alive) {
    return { pid, signaled: true, signal: 'SIGTERM', escalated: false, reason: null };
  }

  const killed = sendSignal(pid, 'SIGKILL', { ...options, platform, processKill });
  return { pid, signaled: true, signal: 'SIGTERM', escalated: killed, escalatedSignal: killed ? 'SIGKILL' : null, reason: killed ? null : 'ESCALATION_FAILED' };
}

function cleanupSessionArtifacts(sessionId, options = {}) {
  const sessionsRoot = options.sessionsRoot || process.env.TELEPTY_SESSIONS_DIR || path.join(os.homedir(), '.telepty', 'sessions');
  const sessionDir = path.join(sessionsRoot, sessionId);
  const removed = [];
  for (const filename of ['supervisor.sock', 'session.sock']) {
    const filePath = path.join(sessionDir, filename);
    try {
      fs.rmSync(filePath, { force: true });
      removed.push(filePath);
    } catch {}
  }
  return removed;
}

function effectiveIdleTtlMs(session, config = {}) {
  if (session && Object.prototype.hasOwnProperty.call(session, 'idleTtlMs')) {
    return session.idleTtlMs == null ? null : Number(session.idleTtlMs);
  }
  if (session && Object.prototype.hasOwnProperty.call(session, 'idle_ttl_ms')) {
    return session.idle_ttl_ms == null ? null : Number(session.idle_ttl_ms);
  }
  return config.idleTtlDefaultMs == null ? null : Number(config.idleTtlDefaultMs);
}

function selectIdleTtlVictims(sessions, config = {}, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const entries = sessions instanceof Map ? Array.from(sessions.entries()) : Object.entries(sessions || {});
  const victims = [];

  for (const [id, session] of entries) {
    const ttlMs = effectiveIdleTtlMs(session, config);
    if (!Number.isFinite(ttlMs) || ttlMs < 0) continue;
    const idleSeconds = computeIdleSeconds(session && session.lastActivityAt, nowMs);
    if (idleSeconds == null) continue;
    const idleMs = idleSeconds * 1000;
    if (idleMs > ttlMs) {
      victims.push({ id, session, idleMs, idleSeconds, ttlMs });
    }
  }

  return victims;
}

function selectCleanOlderThanTargets(sessions, options = {}) {
  const olderThanMs = options.olderThanMs;
  if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
    throw new Error('olderThanMs must be a non-negative duration');
  }

  const nowMs = options.nowMs ?? Date.now();
  const useIdle = options.idle === true;
  const entries = Array.isArray(sessions) ? sessions.map((s) => [s.id, s]) : Object.entries(sessions || {});
  const targets = [];

  for (const [id, session] of entries) {
    const timestamp = useIdle ? session.lastActivityAt : session.createdAt;
    if (!timestamp) continue;
    const ts = new Date(timestamp).getTime();
    if (!Number.isFinite(ts)) continue;
    const ageMs = Math.max(0, nowMs - ts);
    if (ageMs > olderThanMs) {
      targets.push({
        id,
        session,
        reference: useIdle ? 'lastActivityAt' : 'createdAt',
        ageMs,
        ageSeconds: Math.floor(ageMs / 1000)
      });
    }
  }

  return targets;
}

// #17: pure verdict→action mapping for the surface-liveness GC, exposed for unit-testing.
// Returns 'mark' (start the grace window), 'reclaim' (grace elapsed → teardown), 'recover'
// (surface returned within grace → clear), or 'skip'. INV-17: 'unknown' (cmux unreachable)
// always maps to 'skip' — GC nothing. Pure, no side effects; the caller performs the action.
function decideSurfaceGc(liveness, session, nowMs, graceSeconds = SURFACE_ORPHAN_SECONDS) {
  if (liveness === 'gone') {
    if (!session.surfaceGoneAt) return 'mark';
    const goneSeconds = Math.floor((nowMs - new Date(session.surfaceGoneAt).getTime()) / 1000);
    return goneSeconds >= graceSeconds ? 'reclaim' : 'skip';
  }
  if (liveness === 'alive' && session.surfaceGoneAt) return 'recover';
  return 'skip';
}

function clearSurfaceMismatchState(session) {
  if (!session) return;
  session.surfaceMismatchAt = null;
  session.surfaceMismatchObserved = null;
  session.surfaceMismatchEmitted = false;
}

function getExpectedPtyPidFromProbe(session, probe) {
  const candidates = [
    probe && probe.expectedPtyPid,
    session && session.ptyPid,
    session && session.pty_pid,
    session && session.ptyProcess && session.ptyProcess.pid,
    session && session.pid
  ];
  for (const pid of candidates) {
    const n = Number(pid);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

function buildSurfaceMismatchExtra(sessionId, session, probe, mismatchSeconds) {
  return {
    sid: sessionId,
    backend: 'cmux',
    cmuxWorkspaceId: session && session.cmuxWorkspaceId ? session.cmuxWorkspaceId : null,
    expectedPtyPid: getExpectedPtyPidFromProbe(session, probe),
    observedSurface: probe && probe.observedSurface ? probe.observedSurface : null,
    mismatchSeconds
  };
}

function getSurfaceMismatchObservedKey(probe) {
  if (!probe || typeof probe !== 'object') return null;
  return probe.observedSurfaceKey || probe.observedSurface || null;
}

function applySurfaceMismatchProbe(sessionId, session, probe, options = {}) {
  if (!session) return { action: 'skip', reason: 'missing_session' };
  const nowMs = options.nowMs ?? Date.now();
  const debounceSeconds = options.debounceSeconds ?? SURFACE_MISMATCH_SECONDS;

  if (!probe || probe.status !== 'mismatch') {
    const hadState = !!(session.surfaceMismatchAt || session.surfaceMismatchObserved || session.surfaceMismatchEmitted);
    clearSurfaceMismatchState(session);
    return { action: hadState ? 'recover' : 'skip', reason: (probe && (probe.reason || probe.status)) || 'not_mismatch' };
  }

  const observedKey = getSurfaceMismatchObservedKey(probe);
  if (!observedKey) {
    clearSurfaceMismatchState(session);
    return { action: 'skip', reason: 'observed_surface_unknown' };
  }

  if (!session.surfaceMismatchAt || session.surfaceMismatchObserved !== observedKey) {
    session.surfaceMismatchAt = new Date(nowMs).toISOString();
    session.surfaceMismatchObserved = observedKey;
    session.surfaceMismatchEmitted = false;
    return { action: 'mark', reason: probe.reason || 'mismatch', mismatchSeconds: 0 };
  }

  const startedMs = new Date(session.surfaceMismatchAt).getTime();
  if (!Number.isFinite(startedMs)) {
    session.surfaceMismatchAt = new Date(nowMs).toISOString();
    session.surfaceMismatchObserved = observedKey;
    session.surfaceMismatchEmitted = false;
    return { action: 'mark', reason: 'invalid_start_reset', mismatchSeconds: 0 };
  }

  const mismatchSeconds = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
  if (session.surfaceMismatchEmitted) {
    return { action: 'skip', reason: 'already_emitted', mismatchSeconds };
  }
  if (mismatchSeconds < debounceSeconds) {
    return { action: 'skip', reason: 'debouncing', mismatchSeconds };
  }

  const extra = buildSurfaceMismatchExtra(sessionId, session, probe, mismatchSeconds);
  let event = null;
  if (typeof options.emit === 'function') {
    event = options.emit(extra);
  }
  session.surfaceMismatchEmitted = true;
  return { action: 'emit', reason: probe.reason || 'mismatch', mismatchSeconds, extra, event };
}

module.exports = {
  SURFACE_ORPHAN_SECONDS,
  SURFACE_MISMATCH_SECONDS,
  parseDuration,
  computeIdleSeconds,
  formatIdleDuration,
  getSessionPid,
  isProcessAlive,
  killSessionProcess,
  cleanupSessionArtifacts,
  effectiveIdleTtlMs,
  selectIdleTtlVictims,
  selectCleanOlderThanTargets,
  decideSurfaceGc,
  clearSurfaceMismatchState,
  buildSurfaceMismatchExtra,
  applySurfaceMismatchProbe
};
