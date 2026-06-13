// src/child-cpu.js — wrapped-child CPU-time sampling for the #52 idle-unconfirmed recheck.
//
// codex quiet-thinking is TTY-silent but process-active: at settle-recheck time the
// daemon samples the wrapped child's cumulative CPU time and treats an advancing value
// as working evidence (screen idle && CPU advancing → re-settle instead of notifying).
//
// Constitution §1/§17: no new dependency — `ps -o time=` on POSIX (macOS/Linux), and a
// clean null fallback on win32 / missing pid / exec failure so callers keep the prior
// (#48) behavior whenever CPU is unobservable.
//
// Pure parse + DI exec/platform seams for unit tests.

'use strict';

// Parse a ps(1) TIME value into seconds. Accepted shapes:
//   macOS:  MM:SS.cc        (e.g. "0:01.23")
//   Linux:  [DD-]HH:MM:SS   (e.g. "00:00:05", "1-02:03:04")
// Returns null for anything unparseable.
function parsePsTimeSeconds(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  const dayMatch = s.match(/^(\d+)-(.+)$/);
  const days = dayMatch ? Number(dayMatch[1]) : 0;
  const rest = dayMatch ? dayMatch[2] : s;
  const parts = rest.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  if (parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  const nums = parts.map(Number);
  const seconds = parts.length === 3
    ? nums[0] * 3600 + nums[1] * 60 + nums[2]
    : nums[0] * 60 + nums[1];
  return days * 86400 + seconds;
}

// Sample the cumulative CPU time (seconds) of `pid`, or null when unobservable
// (no/invalid pid, win32, ps failure). Bounded: 500ms exec timeout.
function sampleChildCpuSeconds(pid, opts = {}) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return null;
  const platform = opts.platform || process.platform;
  if (platform === 'win32') return null;
  const execFileSync = opts.execFileSync || require('child_process').execFileSync;
  try {
    const out = execFileSync('ps', ['-o', 'time=', '-p', String(numericPid)], {
      timeout: 500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parsePsTimeSeconds(String(out));
  } catch (_err) {
    return null;
  }
}

module.exports = { parsePsTimeSeconds, sampleChildCpuSeconds };
