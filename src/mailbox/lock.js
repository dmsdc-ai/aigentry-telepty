'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { resolveSessionDir } = require('./path-boundary');

const TICKET = /^([1-9][0-9]*)-([a-f0-9]{32})$/;
const MAX_CONTENDERS = 1024;
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
// #1215 G3/G5 diagnostics only (no behaviour change): fixed-key in-memory counters per acquisition,
// folded into per-process totals. Never per-poll I/O; no pid, path, name or raw error is recorded.
// A record is attached to an error acquireLock throws (`lock_diagnostic`) and lockDiagnostics()
// returns the totals. Cost: two performance.now() per 10 ms pause plus integer increments.
const PAUSE_REQUESTED_MS = 10;
const COUNTERS = ['doorway_rescans', 'admission_polls', 'pauses', 'pause_requested_ms', 'pause_actual_ms', 'pauses_over_2x',
  'blocked_unresolved', 'blocked_choosing', 'blocked_lower_number', 'blocked_tie_lower_name', 'blocked_self_owner',
  'eperm_marked_entry', 'eperm_relist_departed', 'eperm_relist_unresolved', 'eperm_relist_dir_gone',
  'eperm_unmarked_throw_entry_listed', 'eperm_unmarked_throw_entry_absent', 'eperm_read_departed', 'eperm_read_unresolved',
  'eperm_read_throw', 'dir_unresolved',
  // #1215 correction5: the nlink0 re-stat site (original :82) — re-stats taken and their EPERM outcomes.
  'restat_nlink0', 'eperm_restat_marked_entry', 'eperm_restat_relist_departed', 'eperm_restat_relist_unresolved',
  'eperm_restat_relist_dir_gone', 'eperm_restat_unmarked_throw_entry_listed', 'eperm_restat_unmarked_throw_entry_absent',
  // #1215 lock10: the read-site EPERM whose re-list shows the published `number` gone (departure final stage), and a
  // diagnostic split of the remaining throws (not `eperm_`-prefixed, so eperm_total is not double counted).
  'eperm_read_number_gone', 'read_throw_number_listed',
  // #1215 lock227: a REAP's own listing of the ticket directory (removeTicket's first listing / post-unlink re-list)
  // refused with EPERM; the cleanup is left pending for the remover finishing it (counted, never claimed removed).
  'eperm_reap_list_unresolved', 'eperm_reap_relist_unresolved',
  // #1215 lock525: a `number` descriptor reporting 0 links (win32 delete-pending) classified by the ticket's retirement state.
  'nlink0_departed', 'nlink0_unresolved', 'nlink0_throw'];
const MAXIMA = ['pause_actual_max_ms', 'peers_seen_max'];
const counters = () => Object.fromEntries([...COUNTERS, ...MAXIMA].map(key => [key, 0]));
const totals = {acquired: 0, timeouts: 0, errors: 0, wait_ms_total: 0, wait_ms_max: 0, ...counters()};
let active = null; // the running acquisition's counters (acquireLock is synchronous and not re-entered)
function note(key) { if (active) active[key]++; }
function noteMax(key, value) { if (active && value > active[key]) active[key] = value; }
function timedPause() {
  const begun = performance.now(); pause();
  if (!active) return;
  const actual = performance.now() - begun;
  active.pauses++; active.pause_requested_ms += PAUSE_REQUESTED_MS; active.pause_actual_ms += actual;
  if (actual > 2 * PAUSE_REQUESTED_MS) active.pauses_over_2x++;
  noteMax('pause_actual_max_ms', actual);
}
function noteBlock(phase, ticket, peer, number) {
  if (!active) return;
  const reason = ticket.unresolved ? 'unresolved' : ticket.number === 0 ? 'choosing'
    : ticket.number < number ? 'lower_number' : 'tie_lower_name'; // the admission condition guarantees one of the four
  const self = Number(TICKET.exec(peer)[1]) === process.pid;
  active[`blocked_${reason}`]++; if (self) active.blocked_self_owner++;
  active.last_block = {phase, reason, self_owner: self};
}
const round = value => Math.round(value * 10) / 10;
function snapshot(record) {
  const out = {};
  for (const key of [...COUNTERS, ...MAXIMA]) out[key] = round(record[key]);
  out.eperm_total = COUNTERS.filter(key => key.startsWith('eperm_')).reduce((sum, key) => sum + record[key], 0);
  return out;
}
function lockDiagnostics() {
  return {acquired: totals.acquired, timeouts: totals.timeouts, errors: totals.errors,
    wait_ms_total: round(totals.wait_ms_total), wait_ms_max: round(totals.wait_ms_max), ...snapshot(totals)};
}
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
// Departure marker. Created (O_EXCL) before any ticket file is unlinked and removed only
// once it is the last entry, so it spans the whole Windows delete-pending lifetime of an
// unlinked file a peer still has open (still listed; lstat/open give EPERM). Readers
// only ever see it through readdir and never open or stat it.
const DEPARTED = 'departed';
function ticketNames(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (names.some(name => name !== 'draft' && name !== 'number' && name !== DEPARTED)) throw failure();
  return names;
}
function departed(dir) {
  const names = ticketNames(dir);
  return names === null || names.includes(DEPARTED);
}
// EPERM reading a peer ticket DIRECTORY itself (e.g. Windows delete-pending directory) is
// unresolved metadata: never a departure (only ENOENT is), never admission; callers block.
const UNRESOLVED = Symbol('unresolved');
const SKIP_ENTRY = Symbol('skip-entry'); // checkTicketFiles: continue with the next entry
function dirState(read) {
  try { return read(); } catch (e) { if (e.code === 'EPERM') { note('dir_unresolved'); return UNRESOLVED; } throw e; }
}
function deletePending(file) { // An entry lstat cannot read (EPERM) or that is already gone.
  try { return statOptional(file) === null; } catch (e) { if (e.code === 'EPERM') return true; throw e; }
}
function checkTicketFiles(dir, names = ticketNames(dir)) {
  if (names === null) return null;
  const marked = names.includes(DEPARTED);
  // One EPERM rule for the first stat and the nlink0 re-stat (#1215 correction5). Returns SKIP_ENTRY or
  // {value} for checkTicketFiles to return; any other outcome rethrows the original error.
  const onEperm = (e, name, prefix) => {
    if (e.code !== 'EPERM') throw e;
    if (marked) { note(`${prefix}marked_entry`); return SKIP_ENTRY; } // Delete-pending entry of a departing ticket; stat-able entries are still validated.
    // An unmarked EPERM is a departure only when a re-list proves it; any other EPERM is storage failure.
    const again = dirState(() => ticketNames(dir));
    if (again === UNRESOLVED || again === null) { note(again === null ? `${prefix}relist_dir_gone` : `${prefix}relist_unresolved`); return {value: again}; }
    if (again.includes(DEPARTED)) { note(`${prefix}relist_departed`); return {value: checkTicketFiles(dir, again)}; }
    note(again.includes(name) ? `${prefix}unmarked_throw_entry_listed` : `${prefix}unmarked_throw_entry_absent`); // diagnostic split only
    throw e;
  };
  for (const name of names) {
    if (name === DEPARTED) continue; // The marker is never opened or stat'ed by readers.
    const file = path.join(dir, name);
    let st;
    try { st = statOptional(file); } catch (e) {
      const decided = onEperm(e, name, 'eperm_');
      if (decided === SKIP_ENTRY) continue;
      return decided.value;
    }
    // A concurrent owner can unlink after lookup but before stat captures nlink.
    if (st?.isFile() && st.nlink === 0) {
      note('restat_nlink0');
      // #1215 correction5: the re-stat of a just-unlinked file can itself report EPERM (measured on win32 at
      // original :82:44); it follows the same marked/re-list/refusal rule as the first stat.
      let again;
      try { again = statOptional(file); } catch (e) {
        const decided = onEperm(e, name, 'eperm_restat_');
        if (decided === SKIP_ENTRY) continue;
        return decided.value;
      }
      if (!again) continue;
    }
    if (st && (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 32)) throw failure('MAILBOX_UNSAFE_PATH');
  }
  return names;
}
function removeTicket(dir, reap = false) {
  // Only this unique acquisition's directory is removed. Its name is never reused.
  // #1215 lock227: only readTicket's departed/dead-owner REAP passes reap (never the owner's release or abort). A reap
  // reads this directory's listing through dirState: EPERM there (a delete-pending directory another remover is
  // finishing) leaves the cleanup pending and returns UNRESOLVED. Entry stat/unlink refusals are unchanged.
  const listed = reap ? dirState(() => ticketNames(dir)) : ticketNames(dir);
  if (listed === UNRESOLVED) { note('eperm_reap_list_unresolved'); return UNRESOLVED; }
  const names = checkTicketFiles(dir, listed);
  if (names === null) return;
  if (names === UNRESOLVED) throw failure();
  let marked = names.includes(DEPARTED);
  if (!marked) {
    // Departure linearization point: the marker exists before any ticket file is unlinked.
    try { fs.closeSync(fs.openSync(path.join(dir, DEPARTED), 'wx', 0o600)); }
    catch (e) { if (e.code === 'ENOENT') return; if (e.code !== 'EEXIST') throw e; marked = true; }
  }
  for (const name of names) {
    if (name === DEPARTED) continue;
    // EPERM is tolerated only on a later pass, and only for an entry lstat also cannot read:
    // an earlier pass already left it delete-pending. A stat-able entry (e.g. a directory) throws.
    const file = path.join(dir, name);
    try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT' && !(marked && e.code === 'EPERM' && deletePending(file))) throw e; }
  }
  // A peer still holding a ticket file keeps it listed (Windows delete-pending). The marker
  // then stays, the ticket reads as departed, and a later owner or dead-owner pass finishes it.
  const rest = reap ? dirState(() => ticketNames(dir)) : ticketNames(dir);
  if (rest === UNRESOLVED) { note('eperm_reap_relist_unresolved'); return UNRESOLVED; }
  if (rest === null || rest.length !== 1 || rest[0] !== DEPARTED) return;
  const marker = path.join(dir, DEPARTED);
  try { fs.unlinkSync(marker); }
  catch (e) { if (e.code === 'ENOENT' || (marked && e.code === 'EPERM' && deletePending(marker))) return; throw e; }
  try { fs.rmdirSync(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
// #1215 lock525: ONE retirement rule for a ticket whose `number` this read can no longer trust, from its CURRENT listing
// (ticketNames: unknown entries refused; dirState: directory EPERM = UNRESOLVED, never absence). Departed = listing gone or
// the DEPARTED marker present; lock10 = a published number now unlisted without marker. Anything else proves nothing.
function retirement(dir, published) {
  const again = dirState(() => ticketNames(dir));
  if (again === UNRESOLVED) return UNRESOLVED;
  if (again === null || again.includes(DEPARTED)) return 'departed';
  if (published && !again.includes('number')) return 'number_gone';
  return again.includes('number') ? 'listed' : 'absent';
}
function readTicket(parent, name, reap) {
  const match = TICKET.exec(name), dir = path.join(parent, name);
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid > 0x7fffffff) throw failure();
  const unresolved = {name, unresolved: true};
  const st = dirState(() => statOptional(dir));
  if (st === UNRESOLVED) return unresolved;
  if (!st) return null;
  if (!st.isDirectory() || st.isSymbolicLink()) throw failure('MAILBOX_UNSAFE_PATH');
  const listed = dirState(() => ticketNames(dir));
  const names = listed === UNRESOLVED ? listed : checkTicketFiles(dir, listed);
  if (names === UNRESOLVED) return unresolved;
  if (names === null) return null; // This unique participant has left.
  if (names.includes(DEPARTED)) { // Departed, not a stale lock: only its owner or a dead-owner reap finishes it.
    if (reap && (pid === process.pid || !isProcessAlive(pid))) removeTicket(dir, true);
    return null;
  }
  // #1215 lock227: an unresolved dead-owner reap is not counted as removed (the dead owner blocks nothing either way).
  if (reap && !isProcessAlive(pid)) return removeTicket(dir, true) === UNRESOLVED ? null : {removed: true};
  const published = names.includes('number'); // #1215 lock10: this read listed (and stat-validated) a published number
  let fd;
  try {
    const file = path.join(dir, 'number'), before = statOptional(file);
    if (!before) { // Choosing unless the ticket has departed; publication has not completed.
      const gone = dirState(() => departed(dir));
      return gone === UNRESOLVED ? unresolved : gone ? null : {name, number: 0};
    }
    // #1215 lock525 (win32 native524): a delete-pending `number` stays lstat-able while its descriptor reports 0 links. Only
    // when that is the ONLY failed predicate does the retirement rule decide; otherwise the refusal below stands unchanged.
    const retired = intact => {
      if (!intact) return undefined;
      const state = retirement(dir, published);
      if (state === UNRESOLVED) { note('nlink0_unresolved'); return unresolved; }
      if (state === 'departed' || state === 'number_gone') { note('nlink0_departed'); return null; }
      note('nlink0_throw'); return undefined;
    };
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const opened = fs.fstatSync(fd);
    if (opened.nlink === 0 && !statOptional(file)) return null; // The unique ticket was released after open.
    if (opened.nlink === 0) {
      const r = retired(opened.isFile() && opened.size <= 32 && opened.dev === before.dev && opened.ino === before.ino);
      if (r !== undefined) return r;
    }
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > 32 || opened.dev !== before.dev || opened.ino !== before.ino) throw failure();
    const bytes = Buffer.alloc(33), count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const after = fs.fstatSync(fd);
    if (after.nlink === 0 && !statOptional(file)) return null;
    if (after.nlink === 0) {
      const r = retired(count === opened.size && count <= 32 && after.size === opened.size
        && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs);
      if (r !== undefined) return r;
    }
    if (count !== opened.size || count > 32 || after.nlink !== 1 || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw failure();
    const value = bytes.subarray(0, count).toString('utf8');
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw failure();
    return {name, number: Number(value)};
  } catch (e) {
    if (e.code === 'ENOENT') return null; // This unique participant has left.
    if (e.code === 'EPERM') { // Windows delete-pending number of a departure; an unmarked EPERM still throws.
      const again = dirState(() => ticketNames(dir)); // departed(dir), with the listing kept for the rule below
      if (again === UNRESOLVED) { note('eperm_read_unresolved'); return unresolved; }
      if (again === null || again.includes(DEPARTED)) { note('eperm_read_departed'); return null; }
      // #1215 lock10 (win32 8a0219b diagnostic job, lock.js:200 `before` lstat → eperm_read_throw): `number` is created
      // only by the publication rename and unlinked only by removeTicket AFTER its O_EXCL marker; the marker is
      // unlinked only once it is the last entry, then the directory is removed. A number this read saw published that
      // is now unlisted, with no marker, is therefore that departure between its marker unlink and its rmdir. A
      // choosing ticket never lists `number` (published is false), and a still-listed unmarked number keeps throwing.
      if (published && !again.includes('number')) { note('eperm_read_number_gone'); return null; }
      if (again.includes('number')) note('read_throw_number_listed');
      note('eperm_read_throw');
    }
    throw e;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Lamport bakery doorway: announce choosing BEFORE scanning numbers. Publication
// is an atomic rename of an immutable number; admission waits for choosing peers.
// Assumes one local filesystem with coherent directory operations and one PID
// namespace. No lease expiry, shared-name unlink or live-owner eviction exists.
function acquireLock(sessionDir, options = {}) { // #1215 diagnostics wrapper: return/throw unchanged
  const record = active = {...counters(), last_block: null}, begun = performance.now();
  let outcome = 'error';
  try {
    const release = acquireLockObserved(sessionDir, options);
    outcome = 'acquired';
    return release;
  } catch (e) {
    if (e && e.code === 'MAILBOX_LOCK_TIMEOUT') outcome = 'timeout';
    if (e && typeof e === 'object' && Object.isExtensible(e) && !Object.hasOwn(e, 'lock_diagnostic')) {
      const last = record.last_block || {};
      e.lock_diagnostic = {outcome, elapsed_ms: round(performance.now() - begun), deadline_ms: options.timeoutMs ?? 500,
        last_block_phase: last.phase || null, last_block_reason: last.reason || null, last_block_self_owner: last.self_owner ?? null,
        ...snapshot(record)};
    }
    throw e;
  } finally {
    active = null;
    const waited = performance.now() - begun;
    if (outcome === 'acquired') totals.acquired++; else if (outcome === 'timeout') totals.timeouts++; else totals.errors++;
    totals.wait_ms_total += waited; if (waited > totals.wait_ms_max) totals.wait_ms_max = waited;
    for (const key of COUNTERS) totals[key] += record[key];
    for (const key of MAXIMA) if (record[key] > totals[key]) totals[key] = record[key];
  }
}
function acquireLockObserved(sessionDir, options) {
  const lock = lockDirectory(sessionDir, true);
  if (lock.legacy) throw failure('MAILBOX_LOCK_LEGACY');
  const deadline = performance.now() + (options.timeoutMs ?? 500);
  const name = `${process.pid}-${crypto.randomBytes(16).toString('hex')}`;
  const own = path.join(lock.dir, name);
  fs.mkdirSync(own, {mode: 0o700});
  let held = false;
  const timeout = () => Object.assign(new Error(`Mailbox lock timeout for ${sessionDir}`), {code: 'MAILBOX_LOCK_TIMEOUT'});
  try {
    let highest = 0;
    // Retry boundary: no number is chosen from a scan with an unresolved peer; the whole
    // doorway scan restarts (still announced as choosing) until every peer resolves.
    for (let unresolved = true; unresolved;) {
      unresolved = false; highest = 0;
      const peers = entries(lock.dir); noteMax('peers_seen_max', peers.length);
      for (const peer of peers) {
        const ticket = readTicket(lock.dir, peer, true);
        if (ticket?.unresolved) { noteBlock('doorway', ticket, peer, 0); unresolved = true; break; }
        if (ticket && !ticket.removed) highest = Math.max(highest, ticket.number);
      }
      if (unresolved) { note('doorway_rescans'); if (performance.now() >= deadline) throw timeout(); timedPause(); }
    }
    if (highest >= Number.MAX_SAFE_INTEGER) throw failure();
    const number = highest + 1, draft = path.join(own, 'draft');
    let fd;
    try {
      fd = fs.openSync(draft, 'wx', 0o600); fs.writeFileSync(fd, String(number)); fs.fsyncSync(fd);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    fs.renameSync(draft, path.join(own, 'number'));
    // #1215 L1: the first admission scan after publication always runs, even when preparation (doorway, draft
    // fsync, rename) already consumed the budget; later scans keep check-before-scan. A late first scan that is
    // blocked throws at once (no pause). Predicate, numbering, FIFO and reap are unchanged.
    for (let first = true; first || performance.now() < deadline; first = false) {
      const late = first && performance.now() >= deadline;
      let blocked = false;
      const peers = entries(lock.dir); noteMax('peers_seen_max', peers.length);
      for (const peer of peers) {
        if (peer === name) continue;
        const ticket = readTicket(lock.dir, peer, true);
        if (ticket && !ticket.removed && (ticket.unresolved || ticket.number === 0 || ticket.number < number
          || (ticket.number === number && peer < name))) { noteBlock('admission', ticket, peer, number); blocked = true; break; }
      }
      if (!blocked) {
        held = true;
        let released = false;
        return () => { if (!released) { removeTicket(own); released = true; } };
      }
      note('admission_polls'); if (late) break; timedPause();
    }
    throw timeout();
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
module.exports = {acquireLock, reapSessionLocks, isProcessAlive, lockDiagnostics};
