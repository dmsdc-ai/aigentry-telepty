'use strict';

// #1207 — the ledger OWNER: the one long-lived worker_thread that opens any file under the
// directory store at the legacy path. The main thread (ledger-client.js) submits small ordered
// deltas; this file serializes them into hash-framed JSONL segments, group-commits with one fsync,
// and acknowledges only after that fsync returned 0. It never rewrites history on an observation,
// never truncates or deletes a segment, and never acknowledges, rejects or rolls back a write
// whose durability it cannot establish — such work is `indeterminate` until actual recovery.
//
// Contract: contract/revision1 (DECISION/PROTOCOL/CUTOVER) under revision2 errata C1–C6 and the
// four binding controller corrections (IMPLEMENTATION-ADMISSION.json). Every filesystem call goes
// through `fsImpl` so acceptance tests can inject faults at named points; production passes none.
//
// Not a module the daemon requires directly: ledger-client spawns it as a Worker. `createStore` is
// exported so the pure/fake-IO tests can drive the owner in-process without worker_threads.

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const F = require('./ledger-format');
const lock = require('./ledger-lock');

const LEGACY_FILE_NAME = 'tracked-injections.v3.json';
const MIGRATING_PREFIX = 'tracked-injections.json.migrating.';
const ASIDE_PREFIX = 'tracked-injections.json.pre-0.10.';
// #1215 F-A — the staging children moved into a claimed L, in this order (MANIFEST.json last).
const PUBLICATION_CHILDREN = ['legacy', 'cold', 'hot', 'facts', 'segments', 'MIGRATION.json', 'MANIFEST.json'];
const COPY_CHUNK = 1048576;
const MAX_EXAMPLES = 16;
const UNAVAILABLE_READ = 'unavailable_read';
// ACCEPTANCE T4 — an orphan MANIFEST temporary is a REGULAR file in the store root named exactly as
// writeAtomic() names it for MANIFEST.json: `MANIFEST.json.<pid>.<ms>.tmp`. Listed (never deleted).
const ORPHAN_MANIFEST_TEMP_RE = /^MANIFEST\.json\.\d+\.\d+\.tmp$/;
const ORPHAN_MANIFEST_TEMPS_MAX = 32;

function nowIso() { return new Date().toISOString(); }
function randomToken() { return crypto.randomBytes(16).toString('hex'); }
function isObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

/**
 * createStore({ dir, lockPath, token, pid, fsImpl, post, liveSids, persistence })
 *   post(message) — owner→client messages (PROTOCOL.json owner_to_client)
 *   handle(message) — client→owner messages
 */
function createStore(options) {
  const dir = options.dir;
  const parent = path.dirname(dir);
  const lockPath = options.lockPath || path.join(parent, 'tracked-injections.lock');
  const token = options.token;
  const pid = options.pid == null ? process.pid : options.pid;
  const fs = options.fsImpl || nodeFs;
  const post = typeof options.post === 'function' ? options.post : () => {};
  const persistence = options.persistence || require('./persistence');
  const setTimer = options.setTimeout || globalThis.setTimeout;
  const clearTimer = options.clearTimeout || globalThis.clearTimeout;
  const groupCaps = { ...F.GROUP, ...(options.group || {}) };
  const compactFrames = options.compactFrames || F.COMPACT_FRAMES;
  const hotMaxRecords = options.hotMaxRecords || F.HOT_MAX_RECORDS;
  const hotMaxBytes = options.hotMaxBytes || F.HOT_MAX_ENCODED_BYTES;
  const coldIndexMaxBytes = options.coldIndexMaxBytes || F.COLD_INDEX_MAX_BYTES;
  const platform = options.platform || process.platform;   // #1207 WIN-1: injectable for the in-process regression only

  // ---- state -------------------------------------------------------------------------------
  const S = {
    state: 'closed', reason: null, epoch: 0, seqNext: 1, seqCommitted: 0,
    manifest: null, published: false,
    hot: new Map(), hotBySession: new Map(), hotBytes: 0,
    actions: new Map(), pending: new Map(),
    facts: [],                      // sorted by pos; { pos, scope, sid, observation }
    receipts: new Map(),            // txn -> { pos, kind, id, ckpt }
    receiptCkpts: [],               // checkpoint numbers whose receipts are resident (last two)
    appliedPos: new Set(), txnHash: new Map(),
    cold: [],                       // [{ n, file, idIdx, sidIdx, records, bytes, offline }]
    coldIndexBytes: 0,
    unapplied: [], unappliedTxns: new Map(), // txn -> { segment, offset }
    segments: [],                   // [{ name, epoch, n, closed, bytes }]
    seg: null,                      // { name, fd, bytes, epoch, n }
    framesSinceCheckpoint: 0, checkpointN: 0, checkpointPos: F.pos(0, 0),
    alloc: { hot: 0, cold: 0 },     // #1207 high-water of OCCUPIED generations (allocation only; checkpointN/receiptCkpts/cold stay the PUBLISHED pointers)
    group: null, groupTimer: null,
    liveSids: new Set(options.liveSids || []),
    legacy: null, recovery: null, migration: null,
    closing: false, possiblyDurable: null,
    chunkQueues: new Map(),         // req -> [chunks]
    io: { writes: 0, bytes: 0, fsyncs: 0, renames: 0, dir_flush_unsupported: 0 },
    // #1207 WIN-1 — what this owner can actually promise: file data is fsynced before every ACK on
    // every platform; directory entries are explicitly flushed where the OS supports it.
    durability: { platform, file_flush: 'fsync', dir_flush: 'not_attempted', dir_flush_code: null },
  };

  // ---- fs helpers --------------------------------------------------------------------------
  // #1207 WIN-1 — a DIRECTORY flush is a platform capability, not an I/O result. On win32 libuv
  // opens the directory (FILE_FLAG_BACKUP_SEMANTICS) but FlushFileBuffers on that read-only handle
  // fails ERROR_ACCESS_DENIED → EPERM (measured, Windows CI run 41169574692: every store open failed
  // `open_failed` EPERM fsync). That one shape — the directory opened, its flush refused with EPERM,
  // on win32 — is recorded as `dir_flush: unsupported` and the operation continues. Everything else
  // still throws and fails closed: a directory that cannot be OPENED, any other errno, every errno on
  // other platforms, and every FILE fsync (segments, checkpoint members, MANIFEST temporaries, the
  // migration copy), which is what the ACK depends on. Rename atomicity is unchanged. What is LOST on
  // win32 is only the explicit flush of directory entries (a newly created segment's name, a rename):
  // their persistence across power loss is left to the file system's own metadata handling and is
  // not promised by this owner. status().durability names that mode instead of hiding it.
  function fsyncDir(p) {
    let fd = null;
    try {
      fd = fs.openSync(p, 'r');
      try { fs.fsyncSync(fd); S.io.fsyncs++; if (S.durability.dir_flush !== 'unsupported') S.durability.dir_flush = 'flushed'; }
      catch (error) {
        if (!(platform === 'win32' && error && error.code === 'EPERM')) throw error;
        S.durability.dir_flush = 'unsupported'; S.durability.dir_flush_code = error.code; S.io.dir_flush_unsupported++;
      }
    } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
  }
  function writeFileDurable(file, buf, mode = 0o600, flags = 'w') {
    const fd = fs.openSync(file, flags, mode);
    try { fs.writeSync(fd, buf); fs.fsyncSync(fd); S.io.writes++; S.io.bytes += buf.length; S.io.fsyncs++; } finally { fs.closeSync(fd); }
  }
  // #1207 — immutable checkpoint members (hot snapshot, receipts, facts, facts index, cold file + indexes)
  // are CREATED exclusively ('wx'): an already-occupied path fails EEXIST with its bytes untouched and the
  // error propagates to the checkpoint caller. This is the last no-clobber safeguard behind the generation
  // counters below; nothing is deleted, chmod-ed or adopted on a collision.
  function createFileDurable(file, buf, mode = 0o600) { return writeFileDurable(file, buf, mode, 'wx'); }
  function writeAtomic(file, buf, mode = 0o600) {
    const tmp = `${file}.${pid}.${Date.now()}.tmp`;
    writeFileDurable(tmp, buf, mode);
    fs.renameSync(tmp, file); S.io.renames++;
    fsyncDir(path.dirname(file));
  }
  function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  function statOrNull(p) { try { return fs.lstatSync(p); } catch { return null; } }
  function listDir(p) { try { return fs.readdirSync(p); } catch { return []; } }
  // ACCEPTANCE T4 diagnostic: one bounded inventory of orphan MANIFEST temporaries in the store root,
  // collected once at recovery and cached on S.recovery.orphan_manifest_temps. Entries are classified
  // by lstat (symlinks and directories excluded WITHOUT following); nothing is read, deleted or
  // imported. `paths` keeps at most ORPHAN_MANIFEST_TEMPS_MAX names in byte order (a bounded sorted
  // selection maintained while counting — never an unbounded list sliced afterwards); `count` is every
  // matching regular name; `truncated` ⇔ count > paths.length; `scan_error` is null only when the scan
  // completed — a failed readdir or an unclassifiable candidate is reported, never presented as a
  // complete (or empty-and-complete) inventory. Not routed through listDir/statOrNull: those swallow
  // errors, which would fabricate a complete scan.
  function scanOrphanManifestTemps() {
    const paths = []; let count = 0; let scanError = null;
    const errorCode = (e) => (e && typeof e.code === 'string' && e.code) || (e && typeof e.name === 'string' && e.name) || 'SCAN_FAILED';
    let names;
    try { names = fs.readdirSync(dir); } catch (error) { return { paths, count, truncated: false, scan_error: errorCode(error) }; }
    for (const name of names) {
      if (typeof name !== 'string' || !ORPHAN_MANIFEST_TEMP_RE.test(name)) continue;
      let st;
      try { st = fs.lstatSync(path.join(dir, name)); } catch (error) { if (scanError === null) scanError = errorCode(error); continue; }
      if (!st.isFile()) continue;
      count++;
      // bounded insertion: keep the ORPHAN_MANIFEST_TEMPS_MAX smallest names (ASCII-only by the regex,
      // so string comparison is byte order); skip names past the current bound.
      if (paths.length === ORPHAN_MANIFEST_TEMPS_MAX && !(name < paths[paths.length - 1])) continue;
      let lo = 0; let hi = paths.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (paths[mid] < name) lo = mid + 1; else hi = mid; }
      paths.splice(lo, 0, name);
      if (paths.length > ORPHAN_MANIFEST_TEMPS_MAX) paths.pop();
    }
    return { paths, count, truncated: count > paths.length, scan_error: scanError };
  }
  function hashFileStreamed(file) {
    const h = crypto.createHash('sha256'); const buf = Buffer.alloc(COPY_CHUNK);
    const fd = fs.openSync(file, 'r'); let bytes = 0;
    try { for (;;) { const n = fs.readSync(fd, buf, 0, COPY_CHUNK, null); if (!n) break; h.update(buf.subarray(0, n)); bytes += n; } } finally { fs.closeSync(fd); }
    return { sha256: h.digest('hex'), bytes };
  }
  function copyFileStreamed(src, dst, mode) {
    const buf = Buffer.alloc(COPY_CHUNK); const h = crypto.createHash('sha256');
    const inFd = fs.openSync(src, 'r'); const outFd = fs.openSync(dst, 'w', mode); let bytes = 0;
    try {
      for (;;) { const n = fs.readSync(inFd, buf, 0, COPY_CHUNK, null); if (!n) break; fs.writeSync(outFd, buf, 0, n); h.update(buf.subarray(0, n)); bytes += n; }
      fs.fsyncSync(outFd); S.io.fsyncs++;
    } finally { fs.closeSync(inFd); fs.closeSync(outFd); }
    try { fs.chmodSync(dst, mode); } catch { /* best effort */ }
    return { sha256: h.digest('hex'), bytes };
  }
  function readLines(file) {
    const out = []; const buf = fs.readFileSync(file); let off = 0;
    while (off < buf.length) {
      const nl = buf.indexOf(0x0a, off); const end = nl === -1 ? buf.length : nl;
      const line = buf.subarray(off, end);
      if (line.length) out.push({ offset: off, len: end - off, text: line.toString('utf8') });
      if (nl === -1) break; off = nl + 1;
    }
    return out;
  }

  // ---- posting -----------------------------------------------------------------------------
  function postState(state, reason = null, extra = {}) {
    S.state = state; S.reason = reason;
    post({ type: 'state', store: state, reason, epoch: S.epoch, counts: counts(), resident: resident(), ...extra });
  }
  function counts() {
    return { hot: S.hot.size, cold: S.cold.reduce((s, c) => s + c.records, 0), facts: S.facts.length,
      actions: S.actions.size, pending: S.pending.size, segments: S.segments.length, unapplied: S.unapplied.length,
      cold_offline: S.cold.filter((c) => c.offline).length };
  }
  function resident() { return { records: S.hot.size, bytes: S.hotBytes, max_records: hotMaxRecords, max_bytes: hotMaxBytes }; }
  function encodedBytes(record) { return Buffer.byteLength(JSON.stringify(record), 'utf8'); }
  function sendChunks(req, type, items, extra = {}) {
    const chunks = []; let cur = []; let bytes = 2;
    for (const item of items) {
      const b = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
      if (cur.length && bytes + b > F.MESSAGE_MAX_BYTES - 256) { chunks.push(cur); cur = []; bytes = 2; }
      cur.push(item); bytes += b;
    }
    chunks.push(cur);
    S.chunkQueues.set(req, { type, chunks, extra, i: 0 });
    sendNextChunk(req);
  }
  function sendNextChunk(req) {
    const q = S.chunkQueues.get(req);
    if (!q) return;
    const last = q.i === q.chunks.length - 1;
    // One array, under the canonical `items` (consumers: client onSnapshotChunk / onReadChunk, the
    // owner harness). The former `records` alias had no consumer and doubled every chunk's payload
    // (measured: 130 517 B of JSON for a 64 KiB budget). The chunker bounds the items' JSON to
    // MESSAGE_MAX_BYTES − 256 and this envelope fits the remainder; JSON size is a proxy — the
    // structured-clone wire size of a postMessage is not measured by it.
    post({ type: q.type, req, items: q.chunks[q.i], last, ...q.extra });
    q.i++;
    if (last) S.chunkQueues.delete(req);
  }

  // ---- hot set bookkeeping -----------------------------------------------------------------
  function setHot(id, record) {
    const prior = S.hot.get(id);
    if (prior) { S.hotBytes -= encodedBytes(prior); const set = S.hotBySession.get(prior.session_id); if (set) set.delete(id); }
    S.hot.set(id, record); S.hotBytes += encodedBytes(record);
    if (!S.hotBySession.has(record.session_id)) S.hotBySession.set(record.session_id, new Set());
    S.hotBySession.get(record.session_id).add(id);
  }
  function removeHot(id) {
    const prior = S.hot.get(id); if (!prior) return;
    S.hotBytes -= encodedBytes(prior); S.hot.delete(id);
    const set = S.hotBySession.get(prior.session_id); if (set) { set.delete(id); if (!set.size) S.hotBySession.delete(prior.session_id); }
  }
  function coldLookup(id) {
    const key = F.keyPrefix(id);
    for (let i = S.cold.length - 1; i >= 0; i--) {
      const c = S.cold[i];
      if (c.offline) continue;
      for (const e of F.findIndexEntries(c.idIdx, key)) {
        const rec = readColdRecord(c, e);
        if (rec && rec.inject_id === id) return { record: rec, file: c };
      }
    }
    return null;
  }
  function coldOfflineHas(id) {
    const key = F.keyPrefix(id);
    return S.cold.some((c) => c.offline && F.findIndexEntry(c.idIdx, key) !== -1);
  }
  function readColdRecord(c, e) {
    const buf = Buffer.alloc(e.len); let fd = null;
    try { fd = fs.openSync(c.file, 'r'); fs.readSync(fd, buf, 0, e.len, e.offset); } finally { if (fd !== null) fs.closeSync(fd); }
    try { return JSON.parse(buf.toString('utf8')); } catch { return null; }
  }
  function coldIdsForSession(sid) {
    const key = F.keyPrefix(sid); const out = [];
    for (const c of S.cold) {
      if (c.offline) continue;
      for (const e of F.findIndexEntries(c.sidIdx, key)) { const rec = readColdRecord(c, e); if (rec && rec.session_id === sid) out.push(rec); }
    }
    return out;
  }

  // ---- P: classification (CUTOVER §4 P + errata C2 + binding correction 1) ----------------
  function classifyPath() {
    const st = statOrNull(dir);
    const staging = listDir(parent).filter((n) => n.startsWith(MIGRATING_PREFIX));
    const asides = listDir(parent).filter((n) => n.startsWith(ASIDE_PREFIX));
    // Correction 1: an existing PUBLISHED directory store is recognized FIRST. A retained aside or
    // staging directory from a completed migration must not block every restart.
    if (st && st.isDirectory()) {
      let manifest = null;
      try { manifest = readJson(path.join(dir, 'MANIFEST.json')); } catch (error) {
        const interrupted = error && error.code === 'ENOENT' ? interruptedPublication(staging, asides) : null;
        if (interrupted) return interrupted;
        return { kind: 'unavailable_read', reason: 'manifest_unreadable', detail: error && error.code };
      }
      if (!isObject(manifest) || Number(manifest.format) !== F.STORE_FORMAT_VERSION) return { kind: 'unavailable_read', reason: 'manifest_format', detail: String(manifest && manifest.format) };
      if (manifest.published === true) return { kind: 'published', manifest, staging, asides };
      // published:false — resume at M7 only when its aside matches the manifest's capture hash.
      const tok = manifest.token;
      const aside = path.join(parent, ASIDE_PREFIX + tok);
      if (!manifest.legacy) return { kind: 'resume_m7', manifest, staging, asides }; // fresh store interrupted before publish
      if (!statOrNull(aside)) return { kind: 'conflict', reason: 'migration_conflict', detail: 'unpublished_store_without_aside', staging, asides };
      const h = hashFileStreamed(aside).sha256;
      if (h !== manifest.legacy.sha256) return { kind: 'conflict', reason: 'migration_conflict', detail: 'original_modified', staging, asides, aside };
      return { kind: 'resume_m7', manifest, staging, asides };
    }
    if (st && !st.isFile()) return { kind: 'precondition', reason: 'migration_precondition', detail: 'legacy_path_type' };
    // Not a published store. Genuinely pending migration identities are resolved BEFORE any
    // "absent ⇒ fresh" decision (errata C2 rule 1).
    if (staging.length || asides.length) {
      if (!st) {
        // L absent: exactly S{step>=6a} + its matching aside may resume at M6b.
        const candidates = staging.map((n) => {
          const s = path.join(parent, n); let mig = null; let man = null;
          try { mig = readJson(path.join(s, 'MIGRATION.json')); } catch { mig = null; }
          try { man = readJson(path.join(s, 'MANIFEST.json')); } catch { man = null; }
          return { s, n, tok: n.slice(MIGRATING_PREFIX.length), mig, man };
        }).filter((c) => c.mig && ['5', '6a'].includes(String(c.mig.step)) && c.man && c.man.legacy);
        if (candidates.length === 1) {
          const c = candidates[0]; const aside = path.join(parent, ASIDE_PREFIX + c.tok);
          if (!statOrNull(aside)) return { kind: 'conflict', reason: 'migration_conflict', detail: 'aside_missing', staging, asides };
          const h = hashFileStreamed(aside).sha256;
          if (h !== c.man.legacy.sha256) return { kind: 'conflict', reason: 'migration_conflict', detail: 'original_modified', staging, asides, aside };
          return { kind: 'resume_m6b', staging: c.s, tok: c.tok, manifest: c.man, aside };
        }
        return { kind: 'conflict', reason: 'migration_conflict', detail: 'pending_identity_ambiguous', staging, asides };
      }
      // L is a regular file with leftovers beside it: ≥2 staging dirs is abandoned_staging; one
      // abandoned staging dir plus an aside from an earlier completed/rolled-back migration is
      // tolerated (a new token is minted; nothing is deleted).
      if (staging.length >= 2) return { kind: 'precondition', reason: 'migration_precondition', detail: 'abandoned_staging', staging };
      // A staging dir that already passed M6a means L was moved aside once and the file now at L
      // was written by someone else afterwards (legacy_recreated). Never migrate over that
      // automatically: the operator decides which original is the original.
      for (const n of staging) {
        let mig = null; try { mig = readJson(path.join(parent, n, 'MIGRATION.json')); } catch { mig = null; }
        if (mig && String(mig.step) === '6a') return { kind: 'conflict', reason: 'migration_conflict', detail: 'legacy_recreated', staging, asides };
      }
    }
    if (!st) return { kind: 'fresh' };
    return { kind: 'migrate', staging, asides };
  }
  // #1215 F-A crash recovery: L is a claimed directory without MANIFEST.json. It is resumed only as
  // this owner's unambiguous interrupted fill; anything else stays fail-closed (null ⇒ manifest_unreadable).
  function interruptedPublication(staging, asides) {
    let present;
    try { present = fs.readdirSync(dir); } catch { return null; }
    if (!present.every((n) => PUBLICATION_CHILDREN.includes(n))) return null;
    const candidates = staging.map((n) => {
      const s = path.join(parent, n); let man = null;
      try { man = readJson(path.join(s, 'MANIFEST.json')); } catch { man = null; }
      return { s, tok: n.slice(MIGRATING_PREFIX.length), man };
    }).filter((c) => isObject(c.man) && c.man.published === false && c.man.token === c.tok && Number(c.man.format) === F.STORE_FORMAT_VERSION);
    if (!candidates.length) return null;
    if (candidates.length > 1) return { kind: 'conflict', reason: 'migration_conflict', detail: 'pending_identity_ambiguous', staging, asides };
    const c = candidates[0];
    if (present.some((n) => statOrNull(path.join(c.s, n)))) return { kind: 'conflict', reason: 'migration_conflict', detail: 'publication_overlap', staging, asides };
    if (!c.man.legacy) return { kind: 'resume_publish', staging: c.s, manifest: c.man };
    const aside = path.join(parent, ASIDE_PREFIX + c.tok);
    if (!statOrNull(aside)) return { kind: 'conflict', reason: 'migration_conflict', detail: 'aside_missing', staging, asides };
    if (hashFileStreamed(aside).sha256 !== c.man.legacy.sha256) return { kind: 'conflict', reason: 'migration_conflict', detail: 'original_modified', staging, asides, aside };
    return { kind: 'resume_publish', staging: c.s, manifest: c.man, aside };
  }

  // ---- migration (CUTOVER §4 M1–M7, errata C2, binding correction 2) -----------------------
  function migrationRecord(s, data) {
    writeAtomic(path.join(s, 'MIGRATION.json'), Buffer.from(JSON.stringify({ tok: data.tok, ...data, at: nowIso() }) + '\n'));
  }
  function importLegacyInto(s, legacyCopy, tok, h1, b1) {
    // M4 — parse the COPY with the 0.9.1 loader rules verbatim; fail closed on anything invalid.
    const loaded = persistence.loadTrackedInjections(legacyCopy);
    if (!loaded.ok) {
      const err = new Error(`legacy_unparseable:${loaded.reason}:${loaded.detail || ''}`); err.code = 'LEGACY_UNPARSEABLE'; err.reason = loaded.reason; err.detail = loaded.detail; throw err;
    }
    const ledger = loaded.ledger;
    for (const sub of ['legacy', 'cold', 'hot', 'facts', 'segments']) fs.mkdirSync(path.join(s, sub), { recursive: true, mode: 0o700 });
    // cold/1.jsonl + indexes
    const idEntries = []; const sidEntries = []; const parts = []; let offset = 0; let records = 0;
    for (const [id, rec] of Object.entries(ledger.injections)) {
      const record = { ...rec, inject_id: rec.inject_id || id, materialized_through: F.pos(0, 0) };
      const line = Buffer.from(JSON.stringify(record) + '\n', 'utf8');
      idEntries.push({ key: F.keyPrefix(record.inject_id), file: 1, offset, len: line.length - 1, flags: record.tracking_state === 'tracked' ? 1 : 0 });
      sidEntries.push({ key: F.keyPrefix(String(record.session_id)), file: 1, offset, len: line.length - 1, flags: 0 });
      parts.push(line); offset += line.length; records++;
    }
    const coldBuf = Buffer.concat(parts);
    writeFileDurable(path.join(s, 'cold', '1.jsonl'), coldBuf, 0o400);
    writeFileDurable(path.join(s, 'cold', '1.id.idx'), F.buildIndex(idEntries), 0o400);
    writeFileDurable(path.join(s, 'cold', '1.sid.idx'), F.buildIndex(sidEntries), 0o400);
    // hot/1.jsonl — interactions only; no hot records at import (legacy tracked records are cold).
    const hotLines = [];
    for (const action of Object.values(ledger.interactions.actions)) hotLines.push(JSON.stringify({ t: 'action', action }));
    for (const pending of Object.values(ledger.interactions.pending)) hotLines.push(JSON.stringify({ t: 'pending', pending }));
    writeFileDurable(path.join(s, 'hot', '1.jsonl'), Buffer.from(hotLines.length ? hotLines.join('\n') + '\n' : ''));
    writeFileDurable(path.join(s, 'hot', '1.receipts.jsonl'), Buffer.alloc(0));
    writeFileDurable(path.join(s, 'facts', '1.jsonl'), Buffer.alloc(0));
    migrationRecord(s, { tok, step: 4 });
    return { records, coldBytes: coldBuf.length, idIndexBytes: idEntries.length * F.INDEX_ENTRY_BYTES + sidEntries.length * F.INDEX_ENTRY_BYTES, generation: Number(ledger.generation) || 0, actions: Object.keys(ledger.interactions.actions).length, pending: Object.keys(ledger.interactions.pending).length };
  }
  function freshManifest(tok, legacy, extra = {}) {
    return { format: F.STORE_FORMAT_VERSION, epoch: 0, seq_committed: 0, published: false, token: tok, created_at: nowIso(),
      checkpoint: { epoch: 0, seq: 0 }, hot: { n: 1 }, receipts: { n: 1 }, cold: legacy ? [{ n: 1, records: extra.records || 0, bytes: extra.coldBytes || 0 }] : [],
      facts: { n: 1 }, segments: [], legacy, recovery: null, clean_close: true, ...extra.manifest };
  }
  function durablePublicationOrder(s) {
    // errata C2 rule 4: every file fsynced at write; then each created child directory; then S.
    for (const sub of ['legacy', 'cold', 'hot', 'facts', 'segments']) { if (statOrNull(path.join(s, sub))) fsyncDir(path.join(s, sub)); }
    fsyncDir(s);
  }
  // #1215 F-A — non-destructive publication of a staging directory S at L. A replacement-capable
  // rename (Node/libuv on win32 replaces an existing FILE target) is never aimed at L, where an old
  // writer may recreate the legacy file at any time. L is CLAIMED with an exclusive, non-recursive
  // mkdir — the portable no-replace creation of a directory name: any occupant ⇒ EEXIST, left
  // untouched — and S's children are then moved INTO the claimed directory, MANIFEST.json
  // (published:false) last, so an interrupted fill is classified `resume_publish`. This is not an
  // atomic publication (Node exposes no no-replace directory rename); after the claim an old writer's
  // write/rename to L targets a directory and fails, so its bytes stay in its own file.
  function claimStorePath() {
    fs.mkdirSync(dir, { mode: 0o700 });
    fsyncDir(parent);
  }
  function fillClaimedStore(s) {
    for (const name of PUBLICATION_CHILDREN) {
      const from = path.join(s, name);
      try { fs.lstatSync(from); } catch (error) { if (error && error.code === 'ENOENT') continue; throw error; } // not produced, or moved by an interrupted fill
      fs.renameSync(from, path.join(dir, name)); S.io.renames++;
    }
    fsyncDir(dir);
    // rmdir removes only an EMPTY directory; on any failure the emptied S is retained, and no
    // classification treats it as pending once L holds a MANIFEST.
    try { fs.rmdirSync(s); } catch { /* retained */ }
    fsyncDir(parent);
  }
  function migrateFromFile(info) {
    const tok = randomToken();
    const s = path.join(parent, MIGRATING_PREFIX + tok);
    const aside = path.join(parent, ASIDE_PREFIX + tok);
    S.migration = { tok, staging: s, aside, steps: [] };
    const step = (name, data = {}) => { S.migration.steps.push(name); post({ type: 'progress', phase: 'migrate', step: name, done: S.migration.steps.length, total: 9, ...data }); };
    // M1 — unique staging directory; EEXIST is an error, never a resume signal.
    fs.mkdirSync(s, { mode: 0o700 });
    migrationRecord(s, { tok, step: 1 }); step('M1');
    // M2 — FIRST read of L (the lock was verified before this function was reached).
    const { sha256: h1, bytes: b1 } = hashFileStreamed(dir);
    migrationRecord(s, { tok, step: 2, h1, b1 }); step('M2', { h1, b1 });
    // M3 — copy, fsync, 0400, re-hash == h1 (one redo).
    fs.mkdirSync(path.join(s, 'legacy'), { recursive: true, mode: 0o700 });
    const legacyCopy = path.join(s, 'legacy', LEGACY_FILE_NAME);
    let copied = copyFileStreamed(dir, legacyCopy, 0o400);
    if (copied.sha256 !== h1) { copied = copyFileStreamed(dir, legacyCopy, 0o400); }
    if (copied.sha256 !== h1) { const e = new Error('migration_failed:copy_mismatch'); e.code = 'COPY_MISMATCH'; throw e; }
    migrationRecord(s, { tok, step: 3 }); step('M3');
    // M4 — parse the copy, stream records to cold/1 and interactions to hot/1.
    const imported = importLegacyInto(s, legacyCopy, tok, h1, b1); step('M4', imported);
    // M5 — S/MANIFEST.json published:false, child-dir fsyncs, S fsync.
    const legacy = { sha256: h1, bytes: b1, generation: imported.generation };
    const manifest = freshManifest(tok, legacy, { records: imported.records, coldBytes: imported.coldBytes });
    durablePublicationOrder(s);
    writeAtomic(path.join(s, 'MANIFEST.json'), Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
    fsyncDir(s);
    migrationRecord(s, { tok, step: 5 }); step('M5');
    // M6a — re-hash L; an old writer during M2–M5 ⇒ legacy_modified (L untouched, S kept).
    const h2 = hashFileStreamed(dir).sha256;
    if (h2 !== h1) { const e = new Error('migration_conflict:legacy_modified'); e.code = 'MIGRATION_CONFLICT'; e.detail = 'legacy_modified'; throw e; }
    fs.renameSync(dir, aside); S.io.renames++; fsyncDir(parent);
    migrationRecord(s, { tok, step: '6a' }); step('M6a');
    // Capture verification on the aside artifact itself (errata C2 rule 2). On mismatch EVERYTHING
    // stays in place: aside, staging and any file that reappeared at L. Binding correction 2: the
    // aside is NOT renamed back after an absent-path check — that check races an old writer.
    const h3 = hashFileStreamed(aside).sha256;
    if (h3 !== h1) {
      const e = new Error('migration_conflict:original_modified_after_capture'); e.code = 'MIGRATION_CONFLICT'; e.detail = 'original_modified_after_capture';
      e.retained = { aside, staging: s, legacy_reappeared: !!statOrNull(dir) }; throw e;
    }
    // M6b — publish the directory at L; a reappeared file ⇒ legacy_recreated, all three retained.
    try { claimStorePath(); } catch (error) {
      if (error && ['ENOTDIR', 'EEXIST', 'ENOTEMPTY', 'EISDIR'].includes(error.code)) {
        const e = new Error('migration_conflict:legacy_recreated'); e.code = 'MIGRATION_CONFLICT'; e.detail = 'legacy_recreated'; e.errno_code = error.code;
        e.retained = { aside, staging: s, legacy_reappeared: true }; throw e;
      }
      throw error;
    }
    fillClaimedStore(s); step('M6b');
    publishM7(manifest); step('M7');
    return manifest;
  }
  function publishM7(manifest) {
    const published = { ...manifest, published: true, published_at: nowIso() };
    writeAtomic(path.join(dir, 'MANIFEST.json'), Buffer.from(JSON.stringify(published, null, 2) + '\n'));
    fsyncDir(dir);
    try { fs.unlinkSync(path.join(dir, 'MIGRATION.json')); } catch { /* absent after a resumed M7 */ }
    return published;
  }
  function createFresh() {
    const tok = randomToken();
    const s = path.join(parent, MIGRATING_PREFIX + tok);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    fs.mkdirSync(s, { mode: 0o700 });
    for (const sub of ['legacy', 'cold', 'hot', 'facts', 'segments']) fs.mkdirSync(path.join(s, sub), { recursive: true, mode: 0o700 });
    writeFileDurable(path.join(s, 'hot', '1.jsonl'), Buffer.alloc(0));
    writeFileDurable(path.join(s, 'hot', '1.receipts.jsonl'), Buffer.alloc(0));
    writeFileDurable(path.join(s, 'facts', '1.jsonl'), Buffer.alloc(0));
    const manifest = freshManifest(tok, null);
    durablePublicationOrder(s);
    writeAtomic(path.join(s, 'MANIFEST.json'), Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
    fsyncDir(s);
    try { claimStorePath(); } catch (error) {
      if (error && ['ENOTDIR', 'EEXIST', 'ENOTEMPTY', 'EISDIR'].includes(error.code)) {
        const e = new Error('migration_conflict:legacy_recreated'); e.code = 'MIGRATION_CONFLICT'; e.detail = 'legacy_recreated'; e.retained = { staging: s }; throw e;
      }
      throw error;
    }
    fillClaimedStore(s);
    return publishM7(manifest);
  }

  // ---- recovery ----------------------------------------------------------------------------
  function loadCheckpoint(manifest) {
    const hotN = manifest.hot && manifest.hot.n ? manifest.hot.n : 1;
    const hotFile = path.join(dir, 'hot', `${hotN}.jsonl`);
    if (statOrNull(hotFile)) {
      for (const { text } of readLines(hotFile)) {
        const obj = JSON.parse(text);
        if (obj.t === 'rec') setHot(obj.record.inject_id, obj.record);
        else if (obj.t === 'action') S.actions.set(obj.action.action_id, obj.action);
        else if (obj.t === 'pending') S.pending.set(obj.pending.inject_id, obj.pending);
      }
    }
    for (const n of [manifest.receipts && manifest.receipts.prev, manifest.receipts && manifest.receipts.n].filter(Boolean)) {
      const f = path.join(dir, 'hot', `${n}.receipts.jsonl`);
      if (!statOrNull(f)) continue;
      for (const { text } of readLines(f)) { const r = JSON.parse(text); S.receipts.set(r.txn, { pos: r.pos, kind: r.kind, id: r.id, ckpt: n }); }
      S.receiptCkpts.push(n);
    }
    S.checkpointN = hotN;
    const factsN = manifest.facts && manifest.facts.n ? manifest.facts.n : 1;
    const factsFile = path.join(dir, 'facts', `${factsN}.jsonl`);
    if (statOrNull(factsFile)) for (const { text } of readLines(factsFile)) S.facts.push(JSON.parse(text));
    S.facts.sort((a, b) => F.comparePos(a.pos, b.pos));
    // Cold indexes: newest first stays resident until the cap; older files are offline (named).
    const cold = (manifest.cold || []).slice().sort((a, b) => a.n - b.n);
    let budget = coldIndexMaxBytes; const loaded = [];
    for (let i = cold.length - 1; i >= 0; i--) {
      const c = cold[i]; const file = path.join(dir, 'cold', `${c.n}.jsonl`);
      const idIdx = fs.readFileSync(path.join(dir, 'cold', `${c.n}.id.idx`));
      const sidIdx = fs.readFileSync(path.join(dir, 'cold', `${c.n}.sid.idx`));
      const bytes = idIdx.length + sidIdx.length;
      const offline = bytes > budget;
      if (!offline) budget -= bytes;
      loaded.unshift({ n: c.n, file, idIdx, sidIdx, records: c.records || idIdx.length / F.INDEX_ENTRY_BYTES, bytes: c.bytes || 0, offline });
    }
    S.cold = loaded; S.coldIndexBytes = coldIndexMaxBytes - budget;
  }
  // #1207 — generation allocation. A checkpoint generation n names hot/<n>.jsonl, hot/<n>.receipts.jsonl,
  // facts/<n>.jsonl and facts/<n>.sid.idx; a cold generation n names cold/<n>.jsonl, cold/<n>.id.idx and
  // cold/<n>.sid.idx. A generation is OCCUPIED as soon as any entry of that directory carries it as its
  // leading decimal run — published or not, complete or partial, regular file, directory or link alike
  // (classified by NAME only: nothing is stat-ed, read or followed). The high-water marks in S.alloc are
  // recovered once per open here (owner thread, during recovery — never on an observation or a status
  // read) and advanced by reserveGeneration() BEFORE a checkpoint's first write, so a failed attempt in
  // this owner leaves a gap rather than a reuse. Gaps are valid. These are allocation counters only:
  // S.checkpointN, S.receiptCkpts and S.cold remain the PUBLISHED pointers written to the MANIFEST
  // (hot.n, receipts.n / receipts.prev, facts.n, cold[].n), and receipts.prev keeps naming the actual
  // previous receipt checkpoint, never n-1. Invalid or unsafe values fail explicitly — never a silent reuse.
  const GENERATION_NAME_RE = /^(\d+)(?:\.|$)/;
  function unsafeGeneration(where, value) {
    const e = new Error(`generation_unsafe:${where}:${String(value)}`); e.code = 'GENERATION_UNSAFE'; e.where = where; e.value = String(value); return e;
  }
  function generationOf(where, value) {
    if (value === undefined || value === null) return 0;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw unsafeGeneration(where, value);
    return value;
  }
  function occupiedHighWater(sub) {
    let names;
    try { names = fs.readdirSync(path.join(dir, sub)); } catch (error) {
      if (error && error.code === 'ENOENT') return 0;   // no such tier directory yet: nothing occupied
      const e = new Error(`generation_scan_failed:${sub}:${(error && error.code) || 'unknown'}`); e.code = 'GENERATION_SCAN_FAILED'; e.where = sub; e.errno_code = (error && error.code) || null; throw e;
    }
    let high = 0;
    for (const name of names) {
      const m = typeof name === 'string' ? GENERATION_NAME_RE.exec(name) : null;
      if (!m) continue;
      const n = Number(m[1]);
      if (!Number.isSafeInteger(n)) throw unsafeGeneration(`${sub}/${name}`, m[1]);
      if (n > high) high = n;
    }
    return high;
  }
  function recoverGenerations(manifest) {
    let hot = Math.max(occupiedHighWater('hot'), occupiedHighWater('facts'));
    for (const [where, value] of [
      ['manifest.hot.n', manifest.hot && manifest.hot.n], ['manifest.receipts.n', manifest.receipts && manifest.receipts.n],
      ['manifest.receipts.prev', manifest.receipts && manifest.receipts.prev], ['manifest.facts.n', manifest.facts && manifest.facts.n],
      ['manifest.last_checkpoint.n', manifest.last_checkpoint && manifest.last_checkpoint.n],
    ]) hot = Math.max(hot, generationOf(where, value));
    let cold = occupiedHighWater('cold');
    for (const c of manifest.cold || []) cold = Math.max(cold, generationOf('manifest.cold[].n', c && c.n));
    S.alloc = { hot, cold };
  }
  function reserveGeneration(family) {
    const published = family === 'hot' ? S.checkpointN : S.cold.reduce((m, c) => Math.max(m, c.n), 0);
    const n = Math.max(S.alloc[family], published) + 1;
    if (!Number.isSafeInteger(n)) throw unsafeGeneration(`${family}.next`, n);
    S.alloc[family] = n;   // reserved before the first write; never released, so a failed attempt cannot be reused
    return n;
  }
  function segmentFiles() {
    return listDir(path.join(dir, 'segments')).map((name) => {
      const m = /^(\d+)-(\d+)\.jsonl$/.exec(name); return m ? { name, epoch: Number(m[1]), n: Number(m[2]) } : null;
    }).filter(Boolean).sort((a, b) => a.epoch - b.epoch || a.n - b.n);
  }
  function replayCtx() {
    return { get: (id) => S.hot.get(id) || null, set: (id, r) => setHot(id, r), facts: S.facts,
      setAction: (action, pending) => { S.actions.set(action.action_id, action); if (pending) S.pending.set(pending.inject_id, pending); } };
  }
  function replaySegments(manifest) {
    const summary = { applied_groups: 0, applied_frames: 0, skipped_duplicates: 0, unapplied: [], examples: [] };
    const files = segmentFiles();
    let lastGroupBytes = null; let lastGroup = null;
    for (const f of files) {
      const full = path.join(dir, 'segments', f.name);
      const buf = fs.readFileSync(full);
      const { frames, tail } = F.decodeFrames(buf);
      // A torn or missing newline at the END is a crash tail (preserved, listed). A frame that fails
      // its hash with VALID commit-framed bytes after it in the same file is media corruption of
      // fsynced history: fail closed (unavailable_read), no repair, nothing touched.
      if (tail && tail.reason !== 'no_newline') {
        const rest = buf.subarray(tail.offset); const nl = rest.indexOf(0x0a);
        if (nl !== -1 && F.decodeFrames(rest.subarray(nl + 1)).frames.some((x) => x.obj && x.obj.t === 'commit')) {
          const e = new Error('corrupt_committed_frame'); e.code = 'CORRUPT'; e.segment = f.name; e.offset = tail.offset; throw e;
        }
      }
      const { groups, open, invalidCommit } = F.groupFrames(frames);
      for (const g of groups) {
        for (const fr of g.frames) {
          const p = F.pos(fr.obj.epoch, fr.obj.seq); const key = F.posKey(p);
          const txn = fr.obj.txn;
          if (S.appliedPos.has(key) || (txn && S.txnHash.has(txn))) {
            const priorHash = S.txnHash.get(txn) || S.txnHash.get(key);
            if (priorHash && priorHash !== fr.hash) { const e = new Error('duplicate_frame_conflict'); e.code = 'DUP_CONFLICT'; e.segment = f.name; e.offset = fr.offset; throw e; }
            summary.skipped_duplicates++; continue;
          }
          if (F.comparePos(p, S.checkpointPos) <= 0) { S.appliedPos.add(key); if (txn) S.txnHash.set(txn, fr.hash); S.txnHash.set(key, fr.hash); continue; }
          try { F.applyFrame(fr.obj, replayCtx()); } catch (error) {
            const e = new Error(`replay_apply_failed:${error.message}`); e.code = 'REPLAY_FAILED'; e.segment = f.name; e.offset = fr.offset; throw e;
          }
          S.appliedPos.add(key); if (txn) { S.txnHash.set(txn, fr.hash); S.receipts.set(txn, { pos: p, kind: fr.obj.t, id: fr.obj.id || null, ckpt: 'replay' }); }
          S.txnHash.set(key, fr.hash);
          if (F.comparePos(p, S.checkpointPos) > 0) S.framesSinceCheckpoint++;
          if (p.epoch > S.epoch || (p.epoch === S.epoch && p.seq >= S.seqNext)) { /* epoch handled below */ }
          summary.applied_frames++;
          S.seqCommitted = Math.max(S.seqCommitted, p.epoch === manifest.epoch ? p.seq : S.seqCommitted);
        }
        summary.applied_groups++;
        lastGroup = g; lastGroupBytes = buf.subarray(g.frames.length ? g.frames[0].offset : g.commit.offset, g.commit.offset + g.commit.length);
      }
      const openFrames = open.length ? open : [];
      const firstBad = openFrames.length ? openFrames[0].offset : (tail ? tail.offset : null);
      if (firstBad !== null) {
        const txns = openFrames.map((x) => x.obj && x.obj.txn).filter(Boolean);
        const entry = { segment: f.name, offset: firstBad, frames: openFrames.length, tail_bytes: tail ? tail.bytes : 0, tail_reason: tail ? tail.reason : (invalidCommit ? 'invalid_commit' : null), txns: txns.slice(0, MAX_EXAMPLES), txn_count: txns.length };
        summary.unapplied.push(entry);
        for (const t of txns) S.unappliedTxns.set(t, { segment: f.name, offset: firstBad });
      }
      S.segments.push({ name: f.name, epoch: f.epoch, n: f.n, closed: true, bytes: buf.length });
    }
    S.unapplied = summary.unapplied;
    return { summary, lastGroupBytes, lastGroup };
  }
  function openSegment(epoch, n) {
    const name = `${epoch}-${n}.jsonl`;
    const file = path.join(dir, 'segments', name);
    const fd = fs.openSync(file, 'a', 0o600);
    S.seg = { name, file, fd, bytes: 0, epoch, n };
    S.segments.push({ name, epoch, n, closed: false, bytes: 0 });
    fsyncDir(path.join(dir, 'segments'));
    return S.seg;
  }
  function closeSegment() {
    if (!S.seg) return;
    try { fs.closeSync(S.seg.fd); } catch { /* ignore */ }
    const meta = S.segments.find((x) => x.name === S.seg.name); if (meta) { meta.closed = true; meta.bytes = S.seg.bytes; }
    S.seg = null;
  }
  function nextSegmentN() { return S.segments.filter((x) => x.epoch === S.epoch).reduce((m, x) => Math.max(m, x.n), 0) + 1; }

  function recover(manifest) {
    S.manifest = manifest; S.legacy = manifest.legacy || null; S.published = manifest.published === true;
    S.checkpointPos = manifest.checkpoint || F.pos(0, 0);
    loadCheckpoint(manifest);
    recoverGenerations(manifest);
    const { summary, lastGroupBytes } = replaySegments(manifest);
    S.epoch = (Number(manifest.epoch) || 0) + 1; S.seqNext = 1; S.seqCommitted = 0;
    fs.mkdirSync(path.join(dir, 'segments'), { recursive: true, mode: 0o700 });
    openSegment(S.epoch, 1);
    // The last group of the last segment is re-copied into the new epoch's first segment and
    // freshly fsynced, so its durability is established by a fsync that cannot have inherited a
    // prior error (DECISION §7 step 3). Dedup by (epoch, seq)+hash makes the copy idempotent.
    if (lastGroupBytes && lastGroupBytes.length) {
      fs.writeSync(S.seg.fd, lastGroupBytes); S.io.writes++; S.io.bytes += lastGroupBytes.length;
      fs.fsyncSync(S.seg.fd); S.io.fsyncs++; S.seg.bytes += lastGroupBytes.length;
      summary.refsynced_bytes = lastGroupBytes.length;
    }
    // ACCEPTANCE T4: inventory the orphan MANIFEST temporaries once, here, before this recovery's own
    // MANIFEST write; the cached object is what every later `status` read returns for this recovery.
    const orphan_manifest_temps = scanOrphanManifestTemps();
    S.recovery = { at: nowIso(), epoch: S.epoch, ...summary, unapplied: summary.unapplied.slice(0, MAX_EXAMPLES), unapplied_count: summary.unapplied.length, orphan_manifest_temps };
    writeManifest({ clean_close: false });
  }
  function writeManifest(extra = {}) {
    const manifest = {
      ...(S.manifest || {}), format: F.STORE_FORMAT_VERSION, epoch: S.epoch, seq_committed: S.seqCommitted, published: true, token: S.manifest ? S.manifest.token : randomToken(),
      checkpoint: S.checkpointPos, hot: { n: S.checkpointN, records: S.hot.size, bytes: S.hotBytes },
      receipts: { n: S.checkpointN, prev: S.receiptCkpts.length > 1 ? S.receiptCkpts[S.receiptCkpts.length - 2] : null },
      cold: S.cold.map((c) => ({ n: c.n, records: c.records, bytes: c.bytes })),
      facts: { n: S.checkpointN, count: S.facts.length },
      segments: S.segments.map((s) => ({ name: s.name, epoch: s.epoch, n: s.n, closed: s.closed })),
      legacy: S.legacy, recovery: S.recovery, counts: counts(), updated_at: nowIso(), ...extra,
    };
    writeAtomic(path.join(dir, 'MANIFEST.json'), Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
    S.manifest = manifest;
    return manifest;
  }

  // ---- open --------------------------------------------------------------------------------
  function open(msg = {}) {
    if (Array.isArray(msg.live_sids)) for (const sid of msg.live_sids) S.liveSids.add(sid);
    postState('recovering', null);
    try {
      // errata C1 rule 2: re-read the lock before opening any store file.
      if (!lock.verify(lockPath, { pid, token }, fs)) { postState('unavailable', 'lock_mismatch', { lockPath }); return; }
      const info = classifyPath();
      let manifest;
      switch (info.kind) {
        case 'unavailable_read': postState(UNAVAILABLE_READ, info.reason, { detail: info.detail || null }); return;
        case 'precondition': postState('unavailable', info.reason, { detail: info.detail, staging: info.staging || null }); return;
        case 'conflict': postState('unavailable', info.reason, { detail: info.detail, staging: info.staging || null, asides: info.asides || null }); return;
        case 'published': manifest = info.manifest; break;
        case 'resume_m7': manifest = publishM7(info.manifest); break;
        case 'resume_m6b': {
          try { claimStorePath(); } catch (error) {
            if (error && ['ENOTDIR', 'EEXIST', 'ENOTEMPTY', 'EISDIR'].includes(error.code)) { postState('unavailable', 'migration_conflict', { detail: 'legacy_recreated', staging: info.staging, aside: info.aside }); return; }
            throw error;
          }
          fillClaimedStore(info.staging); manifest = publishM7(info.manifest); break;
        }
        case 'resume_publish': fillClaimedStore(info.staging); manifest = publishM7(info.manifest); break;
        case 'fresh': manifest = createFresh(); break;
        case 'migrate': manifest = migrateFromFile(info); break;
        default: postState('unavailable', 'classify_failed'); return;
      }
      recover(manifest);
    } catch (error) {
      const code = error && error.code;
      if (code === 'MIGRATION_CONFLICT') { postState('unavailable', 'migration_conflict', { detail: error.detail, retained: error.retained || null, errno: error.errno_code || null }); return; }
      if (code === 'LEGACY_UNPARSEABLE') { postState(UNAVAILABLE_READ, 'observation_store_unavailable', { detail: error.detail || error.reason, staging: S.migration && S.migration.staging }); return; }
      if (code === 'COPY_MISMATCH') { postState('unavailable', 'migration_failed', { detail: 'copy_mismatch' }); return; }
      if (code === 'DUP_CONFLICT' || code === 'REPLAY_FAILED' || code === 'CORRUPT') { postState(UNAVAILABLE_READ, code === 'DUP_CONFLICT' ? 'duplicate_frame_conflict' : code === 'CORRUPT' ? 'corrupt_committed_frame' : 'replay_failed', { segment: error.segment, offset: error.offset, message: error.message }); return; }
      postState('unavailable', `open_failed`, { code: code || null, message: error && error.message, step: S.migration ? S.migration.steps.slice(-1)[0] || null : null });
      return;
    }
    postState('available', null, { recovery: S.recovery, legacy: S.legacy });
    const req = msg.req || 'snapshot';
    const items = [];
    for (const record of S.hot.values()) items.push({ kind: 'record', record });
    for (const action of S.actions.values()) items.push({ kind: 'action', action });
    for (const pending of S.pending.values()) items.push({ kind: 'pending', pending });
    sendChunks(req, 'snapshot_chunk', items, { counts: counts() });
  }

  // ---- group machinery ---------------------------------------------------------------------
  function newGroup() {
    return { frames: [], buffers: [], bytes: 0, members: [], noops: [], overlay: new Map(), facts: S.facts.slice(), actions: [], seqFrom: null, seqTo: null, touched: new Set(), touchedSids: new Set(), factsAdded: 0 };
  }
  function groupCtx(g) {
    return { get: (id) => (g.overlay.has(id) ? g.overlay.get(id) : S.hot.get(id) || null), set: (id, r) => { g.overlay.set(id, r); g.touched.add(id); }, facts: g.facts,
      setAction: (action, pending) => g.actions.push({ action, pending }) };
  }
  function scheduleFlush() {
    if (S.groupTimer) return;
    S.groupTimer = setTimer(() => { S.groupTimer = null; flushGroup(); }, groupCaps.ms);
  }
  function nack(txn, reason, extra = {}) { post({ type: 'nack', txn, reason, ...extra }); }

  function submit(msg) {
    const { txn, kind, delta } = msg;
    if (!txn || !kind || !delta) return nack(txn, 'invalid', { code: 'malformed_submit' });
    if (S.state === 'recovering') return nack(txn, 'recovering');
    if (S.state === UNAVAILABLE_READ) return nack(txn, UNAVAILABLE_READ, { code: S.reason });
    if (S.state === 'unavailable_write') return nack(txn, 'unavailable_write');
    if (S.state !== 'available' || S.closing) return nack(txn, S.closing ? 'shutting_down' : 'unavailable', { code: S.reason });
    if (S.receipts.has(txn)) { const r = S.receipts.get(txn); return post({ type: 'ack', txn, seq: r.pos.seq, epoch: r.pos.epoch, result: 'committed', basis: 'committed', duplicate_txn: true }); }
    const g = S.group || (S.group = newGroup());
    const at = F.pos(S.epoch, S.seqNext);
    const ctx = groupCtx(g);
    let frame;
    try {
      switch (kind) {
        case 'begin': {
          const id = delta.id; const sid = delta.sid; const record = delta.record;
          if (!id || !sid || !isObject(record) || record.inject_id !== id || record.session_id !== sid) return nack(txn, 'invalid', { code: 'begin_shape' });
          if (ctx.get(id)) return noopVerdict(g, txn, 'already_exists', g.touched.has(id), at);
          if (coldLookup(id)) return noopVerdict(g, txn, 'already_exists', false, at);   // durable in the cold tier: idempotent by key
          if (S.hot.size + 1 > hotMaxRecords || S.hotBytes + encodedBytes(record) > hotMaxBytes) return nack(txn, 'hot_capacity', { resident: resident() });
          const supersede = [];
          for (const hid of S.hotBySession.get(sid) || []) {
            const r = ctx.get(hid);
            if (r && r.tracking_state === 'tracked' && hid !== id) supersede.push({ id: hid, entry: { kind: 'tracking_superseded', trigger: 'superseded_by_new_tracked_inject', superseded_by: id, at: delta.at || nowIso() } });
          }
          for (const [oid, r] of g.overlay) if (r.session_id === sid && r.tracking_state === 'tracked' && oid !== id && !supersede.some((s) => s.id === oid)) supersede.push({ id: oid, entry: { kind: 'tracking_superseded', trigger: 'superseded_by_new_tracked_inject', superseded_by: id, at: delta.at || nowIso() } });
          frame = { t: 'begin', epoch: at.epoch, seq: at.seq, txn, id, sid, record, supersede };
          break;
        }
        case 'obs': {
          const id = delta.id; const observation = delta.observation;
          if (!id || !isObject(observation) || typeof observation.kind !== 'string') return nack(txn, 'invalid', { code: 'obs_shape' });
          const current = ctx.get(id);
          if (!current) return coldLookup(id) ? nack(txn, 'record_cold') : (coldOfflineHas(id) ? nack(txn, 'cold_offline') : nack(txn, 'record_missing'));
          const view = F.overlay(current, g.facts);
          const last = view.last_observation;
          if (last && F.observationIdentity(last.kind, last.trigger) === F.observationIdentity(observation.kind, observation.trigger)) {
            const pendingBasis = g.touched.has(id) || g.factsAdded > 0;
            return noopVerdict(g, txn, 'observation_duplicate', pendingBasis, at);
          }
          frame = { t: 'obs', epoch: at.epoch, seq: at.seq, txn, id, observation };
          break;
        }
        case 'state': {
          const id = delta.id; const observation = delta.observation; const ts = delta.tracking_state;
          if (!id || !isObject(observation) || !F.TERMINAL_STATES.includes(ts)) return nack(txn, 'invalid', { code: 'state_shape' });
          const current = ctx.get(id);
          if (!current) return coldLookup(id) ? nack(txn, 'record_cold') : nack(txn, 'record_missing');
          if (current.tracking_state === ts) return noopVerdict(g, txn, 'already_terminal', g.touched.has(id), at);
          if (current.tracking_state !== 'tracked') return nack(txn, 'record_terminal', { tracking_state: current.tracking_state });
          frame = { t: 'state', epoch: at.epoch, seq: at.seq, txn, id, tracking_state: ts, observation };
          break;
        }
        case 'fact': {
          if (!['global', 'session'].includes(delta.scope) || !isObject(delta.observation) || (delta.scope === 'session' && !delta.sid)) return nack(txn, 'invalid', { code: 'fact_shape' });
          frame = { t: 'fact', epoch: at.epoch, seq: at.seq, txn, scope: delta.scope, sid: delta.scope === 'session' ? delta.sid : null, observation: delta.observation };
          break;
        }
        case 'reheat': {
          const id = delta.id;
          if (!id) return nack(txn, 'invalid', { code: 'reheat_shape' });
          if (ctx.get(id)) return noopVerdict(g, txn, 'already_hot', g.touched.has(id), at);
          const found = coldLookup(id);
          if (!found) return coldOfflineHas(id) ? nack(txn, 'cold_offline') : nack(txn, 'record_missing');
          const cold = found.record;
          if (cold.tracking_state === 'tracked' && delta.job_reserved !== true) return nack(txn, 'tracking_capacity_exhausted', { code: 'reheat_requires_job_reservation' });
          const record = F.materialize(cold, F.pendingFactsFor(cold, g.facts, at), at);
          if (S.hot.size + 1 > hotMaxRecords || S.hotBytes + encodedBytes(record) > hotMaxBytes) return nack(txn, 'hot_capacity', { resident: resident() });
          frame = { t: 'reheat', epoch: at.epoch, seq: at.seq, txn, id, record };
          break;
        }
        case 'iact': {
          if (!isObject(delta.action) || !delta.action.action_id) return nack(txn, 'invalid', { code: 'iact_shape' });
          frame = { t: 'iact', epoch: at.epoch, seq: at.seq, txn, action: delta.action, pending: delta.pending || null };
          break;
        }
        default: return nack(txn, 'invalid', { code: 'unknown_kind' });
      }
    } catch (error) { return nack(txn, 'invalid', { code: error && error.message }); }
    const buf = F.encodeFrame(frame);
    const cap = F.FRAME_CAPS[kind] || F.FRAME_CAPS.obs;
    if (buf.length > cap) return nack(txn, 'frame_too_large', { bytes: buf.length, cap });
    // One-large-frame policy: a frame above the soft byte cap forms its own group.
    if (buf.length > groupCaps.bytes && g.frames.length) { flushGroup(); return submit(msg); }
    let applied;
    try { applied = F.applyFrame(frame, ctx); } catch (error) { return nack(txn, error.message === 'already_exists' ? 'invalid' : error.message, { code: error.message }); }
    if (kind === 'fact') g.factsAdded++;
    S.seqNext++;
    if (g.seqFrom === null) g.seqFrom = at.seq;
    g.seqTo = at.seq;
    g.frames.push(frame); g.buffers.push(buf); g.bytes += buf.length;
    g.members.push({ txn, kind, id: frame.id || null, pos: at, effects: applied.effects, bytes: buf.length, hash: F.frameHash(JSON.stringify(frame)) });
    if (buf.length > groupCaps.bytes || g.frames.length >= groupCaps.frames || g.bytes >= groupCaps.bytes) flushGroup(); else scheduleFlush();
    return undefined;
  }
  function noopVerdict(g, txn, result, pendingBasis, at) {
    if (!pendingBasis) {
      post({ type: 'ack', txn, seq: null, epoch: S.epoch, result, basis: 'committed', depends_on_pos: F.pos(S.epoch, S.seqCommitted) });
      if (!S.group || (!S.group.frames.length && !S.group.noops.length)) S.group = null;
      return undefined;
    }
    g.noops.push({ txn, result, group: { epoch: at.epoch, seq_from: g.seqFrom } });
    scheduleFlush();
    return undefined;
  }

  function flushGroup() {
    if (S.groupTimer) { clearTimer(S.groupTimer); S.groupTimer = null; }
    const g = S.group; S.group = null;
    if (!g) return;
    if (!g.frames.length) { for (const n of g.noops) post({ type: 'ack', txn: n.txn, seq: null, epoch: S.epoch, result: n.result, basis: 'committed' }); return; }
    const commit = { t: 'commit', epoch: S.epoch, seq_from: g.seqFrom, seq_to: g.seqTo, n: g.frames.length };
    const bytes = Buffer.concat([...g.buffers, F.encodeFrame(commit)]);
    let segment = S.seg && S.seg.name;
    let outcome = tryWrite(bytes);
    if (!outcome.ok) {
      // Retry once in a NEW segment file (DECISION §7 step 1): same bytes, fsync file, fsync dir.
      const firstError = outcome.error;
      try { closeSegment(); openSegment(S.epoch, nextSegmentN()); segment = S.seg.name; outcome = tryWrite(bytes); outcome.retried = true; outcome.firstError = firstError; } catch (error) { outcome = { ok: false, error, retried: true, firstError }; }
    }
    if (!outcome.ok) {
      // Second failure ⇒ indeterminate (a third outcome). Overlay kept unmerged and unserved.
      S.possiblyDurable = { group: { epoch: S.epoch, seq_from: g.seqFrom, seq_to: g.seqTo, segment }, overlay: g.overlay, txns: g.members.map((m) => m.txn) };
      // The store's `unavailable_write` transition is published BEFORE the group's indeterminate
      // completion on the same ordered message path (measured, #1207 / ACCEPTANCE I2): the client
      // resolves each member's promise on the `indeterminate` message, and a caller's continuation
      // can run before the next message is processed — it must already observe the write-side
      // outage (new begins refused by name) when it learns its outcome is indeterminate. Same
      // reason, group and metadata as before; nothing is acked, released or retried.
      postState('unavailable_write', classifyIoError(outcome.error), { group: S.possiblyDurable.group });
      post({ type: 'indeterminate', txns: g.members.map((m) => m.txn).concat(g.noops.map((n) => n.txn)), group: { epoch: S.epoch, seq_from: g.seqFrom, seq_to: g.seqTo, segment }, reason: classifyIoError(outcome.error), first_error: codeOf(outcome.firstError), second_error: codeOf(outcome.error) });
      return;
    }
    // Durable: merge the overlay into committed, post acks in seq order.
    for (const [id, record] of g.overlay) setHot(id, record);
    S.facts = g.facts;
    for (const { action, pending } of g.actions) { S.actions.set(action.action_id, action); if (pending) S.pending.set(pending.inject_id, pending); }
    S.seqCommitted = g.seqTo;
    S.framesSinceCheckpoint += g.frames.length;
    for (const m of g.members) {
      S.appliedPos.add(F.posKey(m.pos)); S.txnHash.set(m.txn, m.hash); S.txnHash.set(F.posKey(m.pos), m.hash);
      S.receipts.set(m.txn, { pos: m.pos, kind: m.kind, id: m.id, ckpt: 'open' });
      const primary = m.effects.find((e) => e.id === m.id) || m.effects[0] || null;
      post({ type: 'ack', txn: m.txn, seq: m.pos.seq, epoch: m.pos.epoch, result: 'committed', basis: 'written', entry: primary ? primary.entry : null,
        record_state: primary ? primary.tracking_state : null, superseded: m.kind === 'begin' ? m.effects.filter((e) => e.id !== m.id).map((e) => e.id) : undefined,
        effects: m.effects.map((e) => ({ id: e.id, entry: e.entry, tracking_state: e.tracking_state, record: e.record || undefined })), segment, bytes: m.bytes, retried: outcome.retried === true });
    }
    for (const n of g.noops) post({ type: 'ack', txn: n.txn, seq: null, epoch: S.epoch, result: n.result, basis: 'pending', group: n.group });
    if (S.receipts.size > F.RECEIPTS_MAX * 2) trimReceipts();
    if (S.framesSinceCheckpoint >= compactFrames) { try { checkpoint('threshold'); } catch (error) { post({ type: 'progress', phase: 'compact', error: codeOf(error) }); } }
    if (S.seg && S.seg.bytes >= F.SEGMENT_ROLL_BYTES) { try { closeSegment(); openSegment(S.epoch, nextSegmentN()); } catch { /* next write retries a new segment */ } }
  }
  function tryWrite(bytes) {
    try {
      if (!S.seg) openSegment(S.epoch, nextSegmentN());
      fs.writeSync(S.seg.fd, bytes); S.io.writes++; S.io.bytes += bytes.length;
      fs.fsyncSync(S.seg.fd); S.io.fsyncs++;
      S.seg.bytes += bytes.length;
      return { ok: true };
    } catch (error) { return { ok: false, error }; }
  }
  function codeOf(e) { return e ? (e.code || e.message || String(e)) : null; }
  function classifyIoError(e) { const c = codeOf(e); return c === 'ENOSPC' || c === 'EIO' || c === 'EROFS' || c === 'EPERM' ? `write_error:${c}` : `write_error:${c || 'unknown'}`; }
  function trimReceipts() {
    // Keep receipts of the last two checkpoints plus the open epoch (errata C4 rule 2).
    const keep = new Set(S.receiptCkpts.slice(-2).concat(['open', 'replay']));
    for (const [txn, r] of S.receipts) if (!keep.has(r.ckpt)) S.receipts.delete(txn);
  }

  // ---- checkpoint / compaction (hot rewrite, cold demotion, facts fold, receipts) -----------
  function demotionEligible(record) {
    if (F.TERMINAL_STATES.includes(record.tracking_state)) return true;
    if (record.tracking_state === 'tracked' && !S.liveSids.has(record.session_id)) {
      for (const a of S.actions.values()) if (a.sid === record.session_id && !a.terminal) return false;
      for (const p of S.pending.values()) if (p.sid === record.session_id && p.state === 'held') return false;
      return true;
    }
    return false;
  }
  function checkpoint(reason = 'manual') {
    if (S.group && S.group.frames.length) flushGroup();
    const n = reserveGeneration('hot');   // #1207 never S.checkpointN + 1: that reuses an unpublished generation after recovery
    const hotDir = path.join(dir, 'hot'); const coldDir = path.join(dir, 'cold'); const factsDir = path.join(dir, 'facts');
    for (const d of [hotDir, coldDir, factsDir]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    // 1. demote eligible hot records into a new immutable cold file (+ indexes)
    const demote = [...S.hot.values()].filter(demotionEligible);
    let coldMeta = null;
    if (demote.length) {
      const coldN = reserveGeneration('cold');   // #1207 never max(published cold)+1
      const parts = []; const idEntries = []; const sidEntries = []; let offset = 0;
      for (const record of demote) {
        const line = Buffer.from(JSON.stringify(record) + '\n', 'utf8');
        idEntries.push({ key: F.keyPrefix(record.inject_id), file: coldN, offset, len: line.length - 1, flags: record.tracking_state === 'tracked' ? 1 : 0 });
        sidEntries.push({ key: F.keyPrefix(String(record.session_id)), file: coldN, offset, len: line.length - 1, flags: 0 });
        parts.push(line); offset += line.length;
      }
      const buf = Buffer.concat(parts); const idIdx = F.buildIndex(idEntries); const sidIdx = F.buildIndex(sidEntries);
      createFileDurable(path.join(coldDir, `${coldN}.jsonl`), buf, 0o400);
      createFileDurable(path.join(coldDir, `${coldN}.id.idx`), idIdx, 0o400);
      createFileDurable(path.join(coldDir, `${coldN}.sid.idx`), sidIdx, 0o400);
      fsyncDir(coldDir);
      coldMeta = { n: coldN, file: path.join(coldDir, `${coldN}.jsonl`), idIdx, sidIdx, records: demote.length, bytes: buf.length, offline: false };
    }
    // 2. hot checkpoint (remaining records + interactions), receipts, facts
    const hotLines = [];
    for (const record of S.hot.values()) if (!demote.includes(record)) hotLines.push(JSON.stringify({ t: 'rec', record }));
    for (const action of S.actions.values()) hotLines.push(JSON.stringify({ t: 'action', action }));
    for (const pending of S.pending.values()) hotLines.push(JSON.stringify({ t: 'pending', pending }));
    createFileDurable(path.join(hotDir, `${n}.jsonl`), Buffer.from(hotLines.length ? hotLines.join('\n') + '\n' : ''));
    const receiptLines = [];
    for (const [txn, r] of S.receipts) if (r.ckpt === 'open' || r.ckpt === 'replay') { receiptLines.push(JSON.stringify({ txn, pos: r.pos, kind: r.kind, id: r.id })); r.ckpt = n; }
    createFileDurable(path.join(hotDir, `${n}.receipts.jsonl`), Buffer.from(receiptLines.length ? receiptLines.join('\n') + '\n' : ''));
    createFileDurable(path.join(factsDir, `${n}.jsonl`), Buffer.from(S.facts.length ? S.facts.map((f) => JSON.stringify(f)).join('\n') + '\n' : ''));
    const sidFactEntries = S.facts.map((f, i) => ({ key: F.keyPrefix(f.scope === 'session' ? String(f.sid) : '*global*'), file: n, offset: i, len: 0, flags: f.scope === 'global' ? 1 : 0 }));
    createFileDurable(path.join(factsDir, `${n}.sid.idx`), F.buildIndex(sidFactEntries));
    fsyncDir(hotDir); fsyncDir(factsDir);
    // 3. MANIFEST referencing them — only now does residency release (errata C6 rule 2).
    if (coldMeta) { S.cold.push(coldMeta); S.coldIndexBytes += coldMeta.idIdx.length + coldMeta.sidIdx.length; }
    for (const record of demote) removeHot(record.inject_id);
    S.receiptCkpts.push(n); if (S.receiptCkpts.length > 2) S.receiptCkpts = S.receiptCkpts.slice(-2);
    trimReceipts();
    S.checkpointN = n; S.checkpointPos = F.pos(S.epoch, S.seqCommitted); S.framesSinceCheckpoint = 0;
    for (const s of S.segments) if (s.closed) s.checkpointed = true;
    S.appliedPos.clear(); for (const [k] of S.txnHash) if (k.includes(':')) S.txnHash.delete(k);
    writeManifest({ clean_close: false, last_checkpoint: { n, reason, at: nowIso(), demoted: demote.length } });
    // The client mirrors residency: demoted ids leave its read model (reads go to the cold tier).
    if (demote.length) post({ type: 'demoted', ids: demote.map((r) => r.inject_id), checkpoint: n });
    post({ type: 'progress', phase: 'compact', done: n, total: null, demoted: demote.length, reason });
    return { n, demoted: demote.length };
  }

  // ---- reads -------------------------------------------------------------------------------
  function getRecord(id) {
    if (typeof id !== 'string' || !id) return { record: null, reason: 'invalid_id' };
    const hot = S.hot.get(id);
    if (hot) return { record: F.overlay(hot, S.facts), tier: 'hot' };
    const found = coldLookup(id);
    if (found) return { record: F.overlay(found.record, S.facts), tier: 'cold' };
    if (coldOfflineHas(id)) return { record: null, reason: 'cold_offline' };
    return { record: null, reason: 'not_observed_by_daemon_epoch' };
  }
  function read(msg) {
    const { req, op } = msg;
    if (!req) return;
    if (S.state === 'recovering') return post({ type: 'read_chunk', req, items: [], last: true, reason: 'recovering' });
    if (S.state === UNAVAILABLE_READ) return post({ type: 'read_chunk', req, items: [], last: true, reason: S.reason || UNAVAILABLE_READ });
    try {
      if (op === 'get') { const r = getRecord(msg.id); return post({ type: 'read_chunk', req, items: r.record ? [F.toLegacyRecord(r.record)] : [], last: true, reason: r.record ? null : r.reason, tier: r.tier || null }); }
      if (op === 'listSession') {
        const sid = msg.sid; const seen = new Set(); const items = [];
        for (const id of S.hotBySession.get(sid) || []) { const r = S.hot.get(id); if (r) { seen.add(id); items.push(minimal(F.overlay(r, S.facts))); } }
        for (const r of coldIdsForSession(sid)) if (!seen.has(r.inject_id)) items.push(minimal(F.overlay(r, S.facts)));
        items.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
        return sendChunks(req, 'read_chunk', items);
      }
      if (op === 'status') return post({ type: 'read_chunk', req, items: [status()], last: true });
      if (op === 'exportV3') { const r = exportV3(msg.out); return post({ type: 'read_chunk', req, items: [r], last: true, reason: r.ok ? null : r.reason }); }
      return post({ type: 'read_chunk', req, items: [], last: true, reason: 'unknown_op' });
    } catch (error) { return post({ type: 'read_chunk', req, items: [], last: true, reason: `read_failed:${codeOf(error)}` }); }
  }
  function minimal(r) { return { inject_id: r.inject_id, session_id: r.session_id, transport_source: r.transport_source, tracking_state: r.tracking_state, created_at: r.created_at, observation_seq: r.observation_seq, last_observation: r.last_observation }; }
  function status() {
    return { store: S.state, reason: S.reason, epoch: S.epoch, seq_committed: S.seqCommitted, seq_next: S.seqNext, counts: counts(), resident: resident(),
      recovery: S.recovery, unapplied: S.unapplied.slice(0, MAX_EXAMPLES), possibly_durable: S.possiblyDurable ? S.possiblyDurable.group : null,
      legacy: S.legacy, segments: S.segments.map((s) => ({ name: s.name, closed: s.closed, bytes: s.bytes })), frames_since_checkpoint: S.framesSinceCheckpoint,
      checkpoint: { n: S.checkpointN, pos: S.checkpointPos }, cold_index_bytes: S.coldIndexBytes, io: { ...S.io }, durability: { ...S.durability }, live_sids: S.liveSids.size, dir, lockPath };
  }
  function exportV3(out) {
    if (typeof out !== 'string' || !path.isAbsolute(out)) return { ok: false, reason: 'export_path_invalid' };
    const injections = {};
    for (const c of S.cold) {
      if (c.offline) continue;
      for (const { text } of readLines(c.file)) { const r = JSON.parse(text); injections[r.inject_id] = F.toLegacyRecord(F.overlay(r, S.facts)); }
    }
    for (const r of S.hot.values()) injections[r.inject_id] = F.toLegacyRecord(F.overlay(r, S.facts));
    const ledger = { schema_version: persistence.TRACKED_INJECTIONS_SCHEMA_VERSION, generation: (S.legacy && S.legacy.generation) || 0,
      injections, interactions: { actions: Object.fromEntries(S.actions), pending: Object.fromEntries(S.pending) } };
    const saved = persistence.saveTrackedInjections(ledger, out);
    return saved.ok ? { ok: true, out, records: Object.keys(injections).length, offline_cold_files: S.cold.filter((c) => c.offline).length } : { ok: false, reason: saved.reason, code: saved.error && saved.error.code };
  }
  function resolve(msg) {
    const { req, txns } = msg;
    const items = (Array.isArray(txns) ? txns : []).slice(0, F.POOL_TOTALS.entries).map((txn) => {
      const r = S.receipts.get(txn);
      if (r) return { txn, outcome: 'committed', pos: r.pos, kind: r.kind, id: r.id };
      const u = S.unappliedTxns.get(txn);
      if (u) return { txn, outcome: 'not_applied', segment: u.segment, offset: u.offset };
      return { txn, outcome: 'unresolved' };
    });
    sendChunks(req, 'resolve_chunk', items);
  }

  // ---- close -------------------------------------------------------------------------------
  function close(msg = {}) {
    S.closing = true;
    let clean = false; let unresolved = 0;
    try {
      if (S.state === 'available') { flushGroup(); if (S.state === 'available') { checkpoint('close'); writeManifest({ clean_close: true }); clean = true; } }
      if (S.possiblyDurable) unresolved = S.possiblyDurable.txns.length;
    } catch (error) { post({ type: 'progress', phase: 'close', error: codeOf(error) }); }
    closeSegment();
    postState('closed', null);
    post({ type: 'closed', clean, unresolved, deadline_ms: msg.deadline_ms || null });
  }

  // ---- dispatcher --------------------------------------------------------------------------
  function handle(msg) {
    if (!isObject(msg)) return;
    switch (msg.type) {
      case 'open': return open(msg);
      case 'submit': return submit(msg);
      case 'read': return read(msg);
      case 'live': { if (msg.on) S.liveSids.add(msg.sid); else S.liveSids.delete(msg.sid); return undefined; }
      case 'chunk_ack': return sendNextChunk(msg.req);
      case 'compact': { try { const r = checkpoint('requested'); post({ type: 'read_chunk', req: msg.req, items: [r], last: true }); } catch (error) { post({ type: 'read_chunk', req: msg.req, items: [], last: true, reason: `compact_failed:${codeOf(error)}` }); } return undefined; }
      case 'resolve': return resolve(msg);
      case 'close': return close(msg);
      case 'flush': return flushGroup();      // tests only: force the open group out
      default: return undefined;
    }
  }

  return { handle, open, close, flushGroup, checkpoint, status, getRecord, state: S, classifyPath };
}

// ---- worker entry ------------------------------------------------------------------------------
let wt = null;
try { wt = require('node:worker_threads'); } catch { wt = null; }
if (wt && !wt.isMainThread && wt.workerData && wt.workerData.ledgerOwner === true) {
  const wd = wt.workerData;
  const fsImpl = wd.fsImplPath ? require(wd.fsImplPath) : nodeFs;
  const store = createStore({ dir: wd.dir, lockPath: wd.lockPath, token: wd.token, pid: wd.pid, fsImpl, liveSids: wd.liveSids,
    post: (m) => wt.parentPort.postMessage(m), group: wd.group, compactFrames: wd.compactFrames, hotMaxRecords: wd.hotMaxRecords, hotMaxBytes: wd.hotMaxBytes, coldIndexMaxBytes: wd.coldIndexMaxBytes });
  wt.parentPort.on('message', (m) => { try { store.handle(m); } catch (error) { wt.parentPort.postMessage({ type: 'state', store: 'unavailable', reason: 'owner_exception', message: error && error.message, code: error && error.code }); } });
}

module.exports = { createStore, LEGACY_FILE_NAME, MIGRATING_PREFIX, ASIDE_PREFIX };
