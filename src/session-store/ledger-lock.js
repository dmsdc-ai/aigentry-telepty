'use strict';

// #1207 — the ledger lock (errata C1). One O_EXCL create by the daemon main thread; EEXIST fails
// closed. Nothing here ever renames, unlinks or overwrites a lock it did not create in this
// process with these exact contents: PID liveness, age and unreadability are not reasons to break
// it. Operator recovery is `telepty ledger unlock --confirm` (operatorUnlock below), on the
// operator's authority, and it is never invoked by the daemon.

const fs = require('node:fs');
const path = require('node:path');

function lockFromText(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { readable: true, contents: parsed, raw: text };
    return { readable: false, contents: 'unreadable', raw: text };
  } catch { return { readable: false, contents: 'unreadable', raw: text }; }
}
function lockFromReadError(error) {
  if (error && error.code === 'ENOENT') return { readable: false, contents: 'absent', raw: null, error: 'ENOENT' };
  return { readable: false, contents: 'unreadable', raw: null, error: error && error.code };
}

function readLock(lockPath, fsImpl = fs) {
  let text;
  try { text = fsImpl.readFileSync(lockPath, 'utf8'); } catch (error) { return lockFromReadError(error); }
  return lockFromText(text);
}

/**
 * Acquire with O_CREAT|O_EXCL|O_WRONLY 0600, writing `{pid, token, started_at}` and fsyncing.
 * Returns `{held:true, lockPath}`, `{held:false, reason:'lock_present', step:'create', contents, lockPath}`
 * or `{held:false, reason:'lock_error', step:'lock_dir'|'create'|'write', code, message, lockPath}`.
 *
 * Each syscall step is classified where it is observed. ONLY an O_EXCL create answering EEXIST means
 * something already occupies the lock path (`lock_present`). A failure to make the lock's directory is
 * a `lock_error` whatever its errno: a recursive mkdir throws EEXIST when that path exists as a
 * NON-directory (measured, Linux CI job 124456824562), and no lock can exist beneath it.
 */
function lockFailure(lockPath, step, error, extra = {}) {
  return { held: false, reason: 'lock_error', step, lockPath, code: error && error.code, message: error && error.message, ...extra };
}

// #1215 native44 — the synchronous EXCLUSIVE step of acquire() (acquireDurable reaches it only through its
// sync-API fallback to acquire(); lock152 moved acquireDurable's own create off the calling thread): the lock
// directory and the O_EXCL create, classified exactly as before. Returns a failure result, or
// `{ fd, body }` once this call has created the lock file (exclusivity is decided here, before return).
function createExclusive(lockPath, { pid, token, startedAt }, fsImpl) {
  if (typeof token !== 'string' || !token) throw new TypeError('ledger-lock: token required');
  try { fsImpl.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 }); } catch (error) {
    return lockFailure(lockPath, 'lock_dir', error, error && error.code === 'EEXIST' ? { detail: 'lock_dir_not_directory' } : {});
  }
  let fd;
  try { fd = fsImpl.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600); } catch (error) {
    if (error && error.code === 'EEXIST') {
      const current = readLock(lockPath, fsImpl);
      return { held: false, reason: 'lock_present', step: 'create', lockPath, contents: current.readable ? current.contents : 'unreadable' };
    }
    return lockFailure(lockPath, 'create', error);
  }
  return { fd, body: JSON.stringify({ pid, token, started_at: startedAt }) + '\n' };
}

function acquire(lockPath, { pid = process.pid, token, startedAt = new Date().toISOString() } = {}, fsImpl = fs) {
  const created = createExclusive(lockPath, { pid, token, startedAt }, fsImpl);
  if (!('fd' in created)) return created;
  const { fd } = created;
  try {
    fsImpl.writeSync(fd, created.body);
    fsImpl.fsyncSync(fd);
  } catch (error) {
    // The file was created by this call but its contents are not durable. It is left in place (never
    // unlinked here), so the next acquisition fails closed as `lock_present` until an operator unlock.
    try { fsImpl.closeSync(fd); } catch { /* best effort */ }
    return lockFailure(lockPath, 'write', error);
  }
  try { fsImpl.closeSync(fd); } catch (error) { return lockFailure(lockPath, 'write', error); }
  return { held: true, lockPath, pid, token };
}

/**
 * #1215 native44 + lock152 — acquire() with BOTH its exclusive step and its durability step off the
 * calling thread. Measured on the daemon main thread inside the ledger open (Windows CI): a 258 ms
 * fsyncSync (native44, df4cb86), then a 158.61 ms O_EXCL openSync of this lock (lock152, run 41279221489).
 *
 * The exclusive step is the SAME mkdir (recursive, 0700) and the SAME kernel O_CREAT|O_EXCL|O_WRONLY 0600
 * create as createExclusive(), issued through fs's callback API (libuv threadpool) and classified exactly
 * as there: only an EEXIST from the create is `lock_present` (with the present lock read, never taken);
 * a directory failure is `lock_error` step lock_dir; any other create errno is `lock_error` step create.
 * Exclusivity is still decided by the kernel create, so two acquirers can never both create.
 *
 * Returns a promise that never rejects and settles to exactly what acquire() returns:
 * `{ held: true, lockPath, pid, token }` after create + write + fsync + close, or acquire()'s refusal
 * shapes. A write-step failure leaves the created file in place, never unlinked. Until it settles held the
 * lock is NOT created-and-durable, and a caller must not spawn an owner, serve the store or report it
 * available. An invalid token still throws synchronously, as before.
 *
 * An injected fsImpl without the full callback API (mkdir/open/readFile/write/fsync/close) is driven
 * through acquire() — that path blocks the caller exactly like acquire(); production passes node:fs.
 */
const ASYNC_LOCK_API = Object.freeze(['mkdir', 'open', 'readFile', 'write', 'fsync', 'close']);
function hasAsyncLockApi(fsImpl) { return ASYNC_LOCK_API.every((name) => typeof fsImpl[name] === 'function'); }
function acquireDurable(lockPath, { pid = process.pid, token, startedAt = new Date().toISOString() } = {}, fsImpl = fs) {
  if (typeof token !== 'string' || !token) throw new TypeError('ledger-lock: token required');
  if (!hasAsyncLockApi(fsImpl)) return Promise.resolve(acquire(lockPath, { pid, token, startedAt }, fsImpl));
  const call = (name, ...args) => new Promise((resolve, reject) => {
    try { fsImpl[name](...args, (error, value) => (error ? reject(error) : resolve(value))); } catch (error) { reject(error); }
  });
  return (async () => {
    try { await call('mkdir', path.dirname(lockPath), { recursive: true, mode: 0o700 }); } catch (error) {
      return lockFailure(lockPath, 'lock_dir', error, error && error.code === 'EEXIST' ? { detail: 'lock_dir_not_directory' } : {});
    }
    let fd;
    try { fd = await call('open', lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600); } catch (error) {
      if (error && error.code === 'EEXIST') {
        let current;
        try { current = lockFromText(await call('readFile', lockPath, 'utf8')); } catch (readError) { current = lockFromReadError(readError); }
        return { held: false, reason: 'lock_present', step: 'create', lockPath, contents: current.readable ? current.contents : 'unreadable' };
      }
      return lockFailure(lockPath, 'create', error);
    }
    const body = JSON.stringify({ pid, token, started_at: startedAt }) + '\n';
    try {
      await call('write', fd, body);
      await call('fsync', fd);
    } catch (error) {
      // Same as acquire(): created by this call, contents not durable, left in place for the operator.
      try { await call('close', fd); } catch { /* best effort */ }
      return lockFailure(lockPath, 'write', error);
    }
    try { await call('close', fd); } catch (error) { return lockFailure(lockPath, 'write', error); }
    return { held: true, lockPath, pid, token };
  })();
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

module.exports = { acquire, acquireDurable, hasAsyncLockApi, verify, release, readLock, operatorUnlock };
