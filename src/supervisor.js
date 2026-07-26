// src/supervisor.js — #738: "is this host's telepty daemon owned by an OS service supervisor?"
//
// Why this exists: `launchctl kickstart -k` (and any supervisor restart) kills the daemon
// and relaunches it, leaving a few-hundred-ms window with no listener. A telepty CLI that
// runs in that window concludes "no daemon" and spawns its own detached one, which grabs
// the port first; the supervisor's instance then hits EADDRINUSE and exits 0
// (daemon.js:4643-4651). The survivor is an orphan outside the supervisor — logs unwired,
// and a fresh peer in the #733 self-update wars.
//
// Design (constitution §2 — same behavior on every OS):
//   DETECTION is per-OS, because the install surfaces differ (install.js:340-410).
//   POLICY is uniform and lives in cli.js ensureDaemonRunning: supervisor present ⇒ wait
//   for it, bounded; supervisor absent ⇒ byte-identical to the pre-#738 spawn path.
//
// Detection is LAZY — cli.js only calls it when it is about to spawn a daemon (i.e. when
// nothing answered on the port), never on the healthy fast path. So the one shell-out this
// needs on Windows costs nothing in normal operation. It is additionally memoized per
// process.
//
// §17 무의존: no new dependencies — fs/os/path/child_process only.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

// The daemon profile's install surfaces, verbatim from install.js:256-263 + 340-410.
const LAUNCHD_PLIST_NAME = 'com.aigentry.telepty.plist';   // ~/Library/LaunchAgents/
const SYSTEMD_UNIT_PATH = '/etc/systemd/system/telepty.service';
const WINDOWS_TASK_NAME = 'telepty-daemon';

const ABSENT = Object.freeze({ present: false, kind: null, detail: null });

// A supervisor that failed to produce a daemon must not cost every later command the full
// wait. Mirrors daemon-control.js's restart-failure marker (telepty#15), with a TTL so a
// supervisor that is fixed/re-enabled is picked up again without manual cleanup.
const DEFER_MARKER_TTL_MS = 5 * 60 * 1000;
const DEFER_MARKER_FILE = path.join(os.homedir(), '.telepty', 'supervisor-defer.json');

function detectSupervisorUncached(deps = {}) {
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const existsSync = deps.existsSync || fs.existsSync;
  const homedir = deps.homedir || os.homedir;
  const exec = deps.execSync || execSync;

  // Operator kill-switch: forces the pre-#738 behavior on any platform.
  if (env.TELEPTY_NO_SUPERVISOR_DEFER === '1') {
    return { present: false, kind: null, detail: 'disabled-by-env' };
  }

  if (platform === 'darwin') {
    const plistPath = path.join(homedir(), 'Library', 'LaunchAgents', LAUNCHD_PLIST_NAME);
    return existsSync(plistPath)
      ? { present: true, kind: 'launchd', detail: plistPath }
      : ABSENT;
  }

  if (platform === 'win32') {
    // No file to stat — the scheduled task is registry-side, so this is the one platform
    // that needs a probe. Guarded by the lazy call site above.
    try {
      exec(`schtasks /query /tn "${WINDOWS_TASK_NAME}" /fo LIST`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      return { present: true, kind: 'schtasks', detail: WINDOWS_TASK_NAME };
    } catch {
      return ABSENT; // non-zero exit ⇒ task not registered
    }
  }

  // Linux and everything else. install.js only writes the systemd unit when running as
  // root (install.js:388-402); a non-root Linux install has no supervisor at all, and
  // correctly detects as absent → unchanged behavior.
  return existsSync(SYSTEMD_UNIT_PATH)
    ? { present: true, kind: 'systemd', detail: SYSTEMD_UNIT_PATH }
    : ABSENT;
}

let cachedDetection = null;

// Memoized per process. Passing `deps` bypasses the cache entirely (unit tests inject
// platform/env/fs seams and must never see, or poison, another case's result).
function detectSupervisor(deps) {
  if (deps) return detectSupervisorUncached(deps);
  if (!cachedDetection) cachedDetection = detectSupervisorUncached();
  return cachedDetection;
}

// Pure: is `marker` a still-valid "this supervisor did not deliver" verdict for `signature`?
function isDeferMarkerFresh(marker, signature, nowMs = Date.now()) {
  if (!marker || marker.signature !== signature || !marker.recordedAt) return false;
  const recordedAt = Date.parse(marker.recordedAt);
  if (!Number.isFinite(recordedAt)) return false;
  const age = nowMs - recordedAt;
  return age >= 0 && age < DEFER_MARKER_TTL_MS;
}

function readSupervisorDeferMarker(opts) {
  const file = (opts && opts.file) || DEFER_MARKER_FILE;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeSupervisorDeferMarker(marker, opts) {
  const file = (opts && opts.file) || DEFER_MARKER_FILE;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(marker, null, 2), { mode: 0o600 });
  } catch {
    // Best-effort: losing the marker only costs one extra wait, never a failure.
  }
}

function clearSupervisorDeferMarker(opts) {
  const file = (opts && opts.file) || DEFER_MARKER_FILE;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Best-effort (see writeSupervisorDeferMarker).
  }
}

module.exports = {
  DEFER_MARKER_FILE,
  DEFER_MARKER_TTL_MS,
  LAUNCHD_PLIST_NAME,
  SYSTEMD_UNIT_PATH,
  WINDOWS_TASK_NAME,
  clearSupervisorDeferMarker,
  detectSupervisor,
  isDeferMarkerFresh,
  readSupervisorDeferMarker,
  writeSupervisorDeferMarker
};
