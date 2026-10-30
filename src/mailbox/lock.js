'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { resolveSessionDir } = require('./path-boundary');

const TICKET = /^([1-9][0-9]*)-([a-f0-9]{32})$/;
const MAX_CONTENDERS = 1024;
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
function failure(code = 'MAILBOX_LOCK_STORAGE') {
  return Object.assign(new Error(code === 'MAILBOX_LOCK_LEGACY'
    ? 'Legacy mailbox lock requires quiesced migration; refusing automatic removal'
    : 'Unsafe or corrupt mailbox lock storage'), { code });
}
function statOptional(file) {
  try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; } // Unknown/permission failures never establish death.
}
function lockDirectory(sessionDir, create) {
  if (resolveSessionDir(path.dirname(sessionDir), path.basename(sessionDir)) !== sessionDir) throw failure();
  const dir = path.join(sessionDir, '.lock');
  if (create) {
    try { fs.mkdirSync(dir, {mode: 0o700}); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  const st = statOptional(dir);
  if (!st) return null;
  if (st.isFile() && st.nlink === 1) return {legacy: true, dir};
  if (!st.isDirectory() || st.isSymbolicLink()) throw failure('MAILBOX_UNSAFE_PATH');
  return {legacy: false, dir};
}
function entries(dir) {
  const names = fs.readdirSync(dir);
  if (names.length > MAX_CONTENDERS || names.some(name => !TICKET.test(name))) throw failure();
  return names;
}
function checkTicketFiles(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  for (const name of names) {
    if (name !== 'draft' && name !== 'number') throw failure();
    const file = path.join(dir, name), st = statOptional(file);
    // A concurrent owner can unlink after lookup but before stat captures nlink.
    if (st?.isFile() && st.nlink === 0 && !statOptional(file)) continue;
    if (st && (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 32)) throw failure('MAILBOX_UNSAFE_PATH');
  }
  return names;
}
function removeTicket(dir) {
  // Only this unique acquisition's directory is removed. Its name is never reused.
  const names = checkTicketFiles(dir);
  if (names === null) return;
  for (const name of names) {
    try { fs.unlinkSync(path.join(dir, name)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  try { fs.rmdirSync(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
function readTicket(parent, name, reap) {
  const match = TICKET.exec(name), dir = path.join(parent, name);
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid > 0x7fffffff) throw failure();
  const st = statOptional(dir);
  if (!st) return null;
  if (!st.isDirectory() || st.isSymbolicLink()) throw failure('MAILBOX_UNSAFE_PATH');
  if (reap && !isProcessAlive(pid)) { removeTicket(dir); return {removed: true}; }
  checkTicketFiles(dir);
  let fd;
  try {
    const file = path.join(dir, 'number'), before = statOptional(file);
    if (!before) return {name, number: 0}; // Choosing; publication has not completed.
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const opened = fs.fstatSync(fd);
    if (opened.nlink === 0 && !statOptional(file)) return null; // The unique ticket was released after open.
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > 32 || opened.dev !== before.dev || opened.ino !== before.ino) throw failure();
    const bytes = Buffer.alloc(33), count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const after = fs.fstatSync(fd);
    if (after.nlink === 0 && !statOptional(file)) return null;
    if (count !== opened.size || count > 32 || after.nlink !== 1 || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw failure();
    const value = bytes.subarray(0, count).toString('utf8');
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw failure();
    return {name, number: Number(value)};
  } catch (e) {
    if (e.code === 'ENOENT') return null; // This unique participant has left.
    throw e;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Lamport bakery doorway: announce choosing BEFORE scanning numbers. Publication
// is an atomic rename of an immutable number; admission waits for choosing peers.
// Assumes one local filesystem with coherent directory operations and one PID
// namespace. No lease expiry, shared-name unlink or live-owner eviction exists.
function acquireLock(sessionDir, options = {}) {
  const lock = lockDirectory(sessionDir, true);
  if (lock.legacy) throw failure('MAILBOX_LOCK_LEGACY');
  const deadline = performance.now() + (options.timeoutMs ?? 500);
  const name = `${process.pid}-${crypto.randomBytes(16).toString('hex')}`;
  const own = path.join(lock.dir, name);
  fs.mkdirSync(own, {mode: 0o700});
  let held = false;
  try {
    let highest = 0;
    for (const peer of entries(lock.dir)) {
      const ticket = readTicket(lock.dir, peer, true);
      if (ticket && !ticket.removed) highest = Math.max(highest, ticket.number);
    }
    if (highest >= Number.MAX_SAFE_INTEGER) throw failure();
    const number = highest + 1, draft = path.join(own, 'draft');
    let fd;
    try {
      fd = fs.openSync(draft, 'wx', 0o600); fs.writeFileSync(fd, String(number)); fs.fsyncSync(fd);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    fs.renameSync(draft, path.join(own, 'number'));
    while (performance.now() < deadline) {
      let blocked = false;
      for (const peer of entries(lock.dir)) {
        if (peer === name) continue;
        const ticket = readTicket(lock.dir, peer, true);
        if (ticket && !ticket.removed && (ticket.number === 0 || ticket.number < number
          || (ticket.number === number && peer < name))) { blocked = true; break; }
      }
      if (!blocked) {
        held = true;
        let released = false;
        return () => { if (!released) { removeTicket(own); released = true; } };
      }
      pause();
    }
    throw Object.assign(new Error(`Mailbox lock timeout for ${sessionDir}`), {code: 'MAILBOX_LOCK_TIMEOUT'});
  } finally { if (!held) removeTicket(own); }
}
function reapSessionLocks(sessionDir) {
  const lock = lockDirectory(sessionDir, false);
  if (!lock || lock.legacy) return 0;
  let count = 0;
  for (const name of entries(lock.dir)) {
    const ticket = readTicket(lock.dir, name, true);
    if (ticket && ticket.removed) count++;
  }
  return count;
}
module.exports = {acquireLock, reapSessionLocks, isProcessAlive};
