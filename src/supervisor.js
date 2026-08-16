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
//   POLICY is uniform and lives in cli.js ensureDaemonRunning / restartDaemonGraceful:
//   supervisor present ⇒ let the supervisor own daemon start/restart; supervisor absent ⇒
//   byte-identical to the pre-#738 spawn path.
//
// Detection is LAZY — cli.js only calls it when it is about to start or restart a daemon,
// never on the healthy fast path. postinstall calls it only during a stale global upgrade.
// So the one shell-out this needs on Windows costs nothing in normal operation. It is
// additionally memoized per process.
//
// §17 무의존: no new dependencies — fs/os/path/child_process only.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

// The daemon profile's install surfaces, verbatim from install.js:256-263 + 340-410.
const LAUNCHD_LABEL = 'com.aigentry.telepty';
const LAUNCHD_PLIST_NAME = 'com.aigentry.telepty.plist';   // ~/Library/LaunchAgents/
const SYSTEMD_SERVICE_NAME = 'telepty';
const SYSTEMD_UNIT_PATH = '/etc/systemd/system/telepty.service';
const SYSTEMD_USER_UNIT_NAME = 'telepty.service';
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

  // Linux and everything else. install.js writes either a root unit or a user unit.
  if (existsSync(SYSTEMD_UNIT_PATH)) {
    return { present: true, kind: 'systemd', detail: SYSTEMD_UNIT_PATH };
  }

  const userUnitPath = path.join(homedir(), '.config', 'systemd', 'user', SYSTEMD_USER_UNIT_NAME);
  return existsSync(userUnitPath)
    ? { present: true, kind: 'systemd-user', detail: userUnitPath }
    : ABSENT;
}

// #902: which port does the supervised job actually serve?
//
// A supervisor restart is LABEL-scoped (`launchctl kickstart -k gui/<uid>/<label>`), so it kills
// the supervised daemon whatever port the CLI is addressing — that is one of the two ways a CLI
// configured for :52209 destroyed the daemon on :3848. The gate in cli.js needs to compare the
// addressed port against the supervised one, and the descriptor this module already returns
// (`detail` = plist / unit path) is where that port is written: install.js templates the daemon's
// PORT into the service's environment block.
//
// Returns the port when the descriptor NAMES one, else null — "I could not determine it" is not
// the same statement as "it is the default", so the fallback is the caller's policy decision
// (cli.js), consistent with this module's split: detection here, policy there.
function supervisedPort(supervisor, deps = {}) {
  const readFileSync = deps.readFileSync || fs.readFileSync;
  if (!supervisor || !supervisor.present || !supervisor.detail) return null;

  // schtasks is registry-side: `detail` is a task NAME, not a readable descriptor.
  if (supervisor.kind === 'schtasks') return null;

  let text;
  try {
    text = String(readFileSync(supervisor.detail, 'utf8'));
  } catch {
    return null; // unreadable/absent descriptor ⇒ undetermined, never a guess
  }

  const match = supervisor.kind === 'launchd'
    // <key>PORT</key><string>4000</string> inside EnvironmentVariables (install.js:115).
    ? text.match(/<key>\s*PORT\s*<\/key>\s*<string>\s*(\d+)\s*<\/string>/)
    // systemd: Environment=PORT=4000, optionally quoted.
    : text.match(/^\s*Environment\s*=\s*"?PORT=(\d+)"?/m);
  if (!match) return null;

  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
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

function restartSupervisorDaemon(supervisor, deps = {}) {
  if (!supervisor || !supervisor.present) {
    return { success: false, error: 'no supervisor detected' };
  }

  const execFile = deps.execFileSync || execFileSync;
  const getuid = deps.getuid || (() => (typeof process.getuid === 'function' ? process.getuid() : null));

  try {
    if (supervisor.kind === 'launchd') {
      const uid = getuid();
      if (!Number.isInteger(uid) || uid < 0) {
        return { success: false, error: 'cannot resolve uid for launchd kickstart' };
      }
      execFile('launchctl', ['kickstart', '-k', `gui/${uid}/${LAUNCHD_LABEL}`], {
        stdio: ['ignore', 'ignore', 'ignore']
      });
      return { success: true, kind: supervisor.kind };
    }

    if (supervisor.kind === 'systemd') {
      execFile('systemctl', ['restart', SYSTEMD_SERVICE_NAME], {
        stdio: ['ignore', 'ignore', 'ignore']
      });
      return { success: true, kind: supervisor.kind };
    }

    if (supervisor.kind === 'systemd-user') {
      execFile('systemctl', ['--user', 'restart', SYSTEMD_SERVICE_NAME], {
        stdio: ['ignore', 'ignore', 'ignore']
      });
      return { success: true, kind: supervisor.kind };
    }

    if (supervisor.kind === 'schtasks') {
      execFile('schtasks', ['/run', '/tn', WINDOWS_TASK_NAME], {
        stdio: ['ignore', 'ignore', 'ignore']
      });
      return { success: true, kind: supervisor.kind };
    }

    return { success: false, error: `unsupported supervisor kind: ${supervisor.kind}` };
  } catch (err) {
    return { success: false, kind: supervisor.kind, error: err.message };
  }
}

module.exports = {
  DEFER_MARKER_FILE,
  DEFER_MARKER_TTL_MS,
  LAUNCHD_LABEL,
  LAUNCHD_PLIST_NAME,
  SYSTEMD_SERVICE_NAME,
  SYSTEMD_UNIT_PATH,
  SYSTEMD_USER_UNIT_NAME,
  WINDOWS_TASK_NAME,
  clearSupervisorDeferMarker,
  detectSupervisor,
  isDeferMarkerFresh,
  readSupervisorDeferMarker,
  restartSupervisorDaemon,
  supervisedPort,
  writeSupervisorDeferMarker
};
