'use strict';

// #1207 — the ledger lock (errata C1). One O_EXCL create by the daemon main thread; EEXIST fails
// closed. Nothing here ever renames, unlinks or overwrites a lock it did not create in this
// process with these exact contents: PID liveness, age and unreadability are not reasons to break
// it. Operator recovery is `telepty ledger unlock --confirm` (operatorUnlock below), on the
// operator's authority, and it is never invoked by the daemon.

const fs = require('node:fs');
const path = require('node:path');

function readLock(lockPath, fsImpl = fs) {
  try {
    const text = fsImpl.readFileSync(lockPath, 'utf8');
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { readable: true, contents: parsed, raw: text };
      return { readable: false, contents: 'unreadable', raw: text };
    } catch { return { readable: false, contents: 'unreadable', raw: text }; }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { readable: false, contents: 'absent', raw: null, error: 'ENOENT' };
    return { readable: false, contents: 'unreadable', raw: null, error: error && error.code };
  }
}

/**
 * Acquire with O_CREAT|O_EXCL|O_WRONLY 0600, writing `{pid, token, started_at}` and fsyncing.
 * Returns `{held:true, lockPath}` or `{held:false, reason:'lock_present'|'lock_error', contents, lockPath}`.
 */
function acquire(lockPath, { pid = process.pid, token, startedAt = new Date().toISOString() } = {}, fsImpl = fs) {
  if (typeof token !== 'string' || !token) throw new TypeError('ledger-lock: token required');
  let fd = null;
  try {
    fsImpl.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    fd = fsImpl.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fsImpl.writeSync(fd, JSON.stringify({ pid, token, started_at: startedAt }) + '\n');
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd); fd = null;
    return { held: true, lockPath, pid, token };
  } catch (error) {
    if (fd !== null) { try { fsImpl.closeSync(fd); } catch { /* best effort */ } }
    if (error && error.code === 'EEXIST') {
      const current = readLock(lockPath, fsImpl);
      return { held: false, reason: 'lock_present', lockPath, contents: current.readable ? current.contents : 'unreadable' };
    }
    return { held: false, reason: 'lock_error', lockPath, code: error && error.code, message: error && error.message };
  }
}

/** True iff the lock exists, is readable and names exactly this `{pid, token}`. */
function verify(lockPath, { pid = process.pid, token } = {}, fsImpl = fs) {
  const current = readLock(lockPath, fsImpl);
  return current.readable && Number(current.contents.pid) === Number(pid) && current.contents.token === token;
}

/** Unlink only when the contents still match; never touches a foreign lock. */
function release(lockPath, { pid = process.pid, token } = {}, fsImpl = fs) {
  if (!verify(lockPath, { pid, token }, fsImpl)) return { released: false, reason: 'lock_mismatch' };
  try { fsImpl.unlinkSync(lockPath); return { released: true }; } catch (error) {
    return { released: false, reason: 'unlink_failed', code: error && error.code };
  }
}

/**
 * Operator unlock (CLI only). Prints nothing itself; returns a decision the CLI renders.
 * Refuses unless `confirm === true`, and refuses while `daemon-state.json` names a live pid or the
 * configured port answers /api/health. `isProcessRunning` and `probeHealth` are injected so the
 * decision is testable without a process table or a socket.
 */
async function operatorUnlock(lockPath, { confirm = false, daemonState = null, isProcessRunning = () => false, probeHealth = async () => false } = {}, fsImpl = fs) {
  const current = readLock(lockPath, fsImpl);
  if (current.contents === 'absent') return { unlocked: false, reason: 'no_lock', lockPath, contents: null };
  if (!confirm) return { unlocked: false, reason: 'confirm_required', lockPath, contents: current.contents };
  const statePid = daemonState && Number(daemonState.pid);
  if (statePid && isProcessRunning(statePid)) return { unlocked: false, reason: 'daemon_state_pid_alive', pid: statePid, lockPath, contents: current.contents };
  let healthy = false;
  try { healthy = await probeHealth(); } catch { healthy = false; }
  if (healthy) return { unlocked: false, reason: 'health_answers', lockPath, contents: current.contents };
  const lockPid = current.readable ? Number(current.contents.pid) : null;
  if (lockPid && isProcessRunning(lockPid)) return { unlocked: false, reason: 'lock_pid_alive', pid: lockPid, lockPath, contents: current.contents };
  try { fsImpl.unlinkSync(lockPath); } catch (error) {
    return { unlocked: false, reason: 'unlink_failed', code: error && error.code, lockPath, contents: current.contents };
  }
  return { unlocked: true, lockPath, contents: current.contents };
}

module.exports = { acquire, verify, release, readLock, operatorUnlock };
