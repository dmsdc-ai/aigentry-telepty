// src/win-kill-process.js — Windows process-kill helper.
//
// Fixes telepty#15 (port-owner fallback when stale daemon holds port 3848).
// On Windows `process.kill(pid, 'SIGTERM')` is unreliable for daemons spawned
// in a different console group; `taskkill /T /F` is the supported path.
//
// On POSIX this module is a no-op (callers fall back to native SIGTERM →
// SIGKILL grace inline in `daemon-control.js`).
//
// Exports:
//   buildTaskkillArgs(pid)        → ['/PID', '<pid>', '/T', '/F']
//   killWindowsProcess(pid, opts) → boolean — true on success
//
// Constraints honored:
//   - Constitution §1 lightweight: ≤80 lines, child_process only.
//   - Constitution §2 cross-platform: POSIX → returns false fast.
//   - Constitution §17 무의존: no new dependencies.

'use strict';

const { execFileSync } = require('child_process');

function buildTaskkillArgs(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error('telepty: buildTaskkillArgs requires a positive integer pid');
  }
  return ['/PID', String(pid), '/T', '/F'];
}

function killWindowsProcess(pid, opts) {
  const o = opts || {};
  const platform = o.platform || process.platform;
  if (platform !== 'win32') return false;

  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  const exec = o.execFileSync || execFileSync;
  try {
    exec('taskkill', buildTaskkillArgs(pid), { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  buildTaskkillArgs,
  killWindowsProcess
};
