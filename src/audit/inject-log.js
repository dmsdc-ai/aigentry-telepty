'use strict';

// #43 P1 — inject audit spine.
//
// Component A in the spec (docs/specs/2026-06-09-inject-audit-provenance.md §3, §5, §8).
// Three concerns, pure Node only (§17 무의존 — `crypto`/`fs`/`events`, no external deps):
//   1. buildAuditLine(record)        — pure builder for the JSONL schema v1 (one line/delivery).
//   2. createAuditWriter({...})       — bounded async append, size+age rotation, 0700 dir / 0600
//                                       file, overflow→drop-oldest+event, NEVER fsync-block delivery.
//   3. readInjectLog(path, filters)   — read/filter/paginate helper backing the P3 GET /api/injects.
//
// This is an AUDIT log, not a transactional ledger: no per-line fsync, bounded loss of the last
// in-flight batch on hard crash is accepted (spec §8). Rotation/prune is best-effort and never
// blocks the delivery hot path (append() is fire-and-forget; the writer drains on a timer).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const SCHEMA_VERSION = 1;
const DEFAULT_PREVIEW_BYTES = 200;
const DEFAULT_QUEUE_MAX = 10000;
const DEFAULT_FLUSH_MS = 250;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const DEFAULT_MAX_FILES = 5;
const DEFAULT_MAX_AGE_DAYS = 30;

// Build one compact JSON line for a single delivery (schema v1, spec §5). Pure: the only
// inputs are `record` fields; sha256/byte-length/spoof_suspected are derived here so the
// builder is the single testable source of truth. Redaction default = hash-only: payload
// content is NEVER written unless `record.preview === true`, and then only truncated.
function buildAuditLine(record = {}) {
  const payload = typeof record.payload === 'string' ? record.payload : '';
  const claimed = record.claimed_from != null ? record.claimed_from : null;
  const verified = record.verified_sender_sid != null ? record.verified_sender_sid : null;
  const previewOn = record.preview === true;
  const previewBytes = Number.isFinite(record.previewBytes) ? record.previewBytes : DEFAULT_PREVIEW_BYTES;

  const line = {
    v: SCHEMA_VERSION,
    ts: record.ts || new Date().toISOString(),
    inject_id: record.inject_id != null ? record.inject_id : null,
    kind: record.kind || 'inject',
    source: record.source || record.kind || 'inject',
    claimed_from: claimed,
    verified_sender_sid: verified,
    // #815: the principal is (sid, epoch, generation) — a bare sid is not an identity, because a
    // textual sid is destroyed and recreated routinely. The epoch is what tells a consumer that
    // two lines naming the same sid came from the same INSTANCE. Null whenever the sender is
    // unverified, so an absent epoch never reads as "verified, epoch unknown".
    verified_sender_epoch: verified && record.verified_sender_epoch != null ? record.verified_sender_epoch : null,
    verified_sender_generation: verified && record.verified_sender_generation != null ? record.verified_sender_generation : null,
    spoof_suspected: !!(claimed && verified && claimed !== verified),
    to: record.to != null ? record.to : null,
    to_alias: record.to_alias != null ? record.to_alias : null,
    origin: record.origin || 'trusted-local',
    origin_host: record.origin_host != null ? record.origin_host : null,
    ref_path: record.ref_path != null ? record.ref_path : null,
    payload_sha256: crypto.createHash('sha256').update(payload).digest('hex'),
    payload_bytes: Buffer.byteLength(payload),
    payload_preview: previewOn ? truncatePreview(payload, previewBytes) : null,
    delivery_result: record.delivery_result || 'success'
  };
  if (record.claimed_return && typeof record.claimed_return.locator === 'string') {
    line.claimed_return_locator = record.claimed_return.locator;
    line.return_locator_verification = 'unverified';
    line.claimed_cross_host = record.claimed_return.claimed_cross_host === true;
  }
  // Broker adapters prehash before enqueueing so even an enabled preview setting cannot
  // retain remote payloads. Node authentication never becomes a foreign session identity.
  if (record.kind === 'broker' && record.broker) {
    const broker = record.broker;
    line.payload_sha256 = broker.payload_sha256;
    line.payload_bytes = broker.payload_bytes;
    line.payload_preview = null;
    line.claimed_from = null;
    line.verified_sender_sid = null;
    line.verified_sender_epoch = null;
    line.verified_sender_generation = null;
    line.spoof_suspected = false;
    line.origin = 'untrusted-remote';
    line.broker_event = broker.event;
    line.to = broker.target_sid;
    line.broker_target_node = broker.target_node;
    line.authenticated_node_id = broker.node;
    line.authenticated_node_key_id = broker.key;
    line.authenticated_identity_scope = 'broker-node';
    line.foreign_session_identity_verified = false;
    line.broker_request_sha256 = broker.request_sha256;
    line.broker_receipt_id = broker.receipt_id;
    line.broker_state = broker.state;
    line.broker_http_status = broker.status;
    line.broker_code = broker.code;
    line.delivery_result = 'not-a-physical-delivery-receipt';
  }
  return JSON.stringify(line);
}

// Truncate a preview to at most `previewBytes` characters — never the full payload. Slicing
// by character (not raw bytes) avoids splitting a multibyte sequence into invalid UTF-8.
function truncatePreview(payload, previewBytes) {
  if (payload.length <= previewBytes) return payload;
  return payload.slice(0, previewBytes);
}

// Bounded async writer. append() pushes onto an in-memory FIFO and returns immediately; a
// timer drains the batch with a single appendFile (spec §8). Overflow drops the OLDEST and
// emits `audit_overflow` (silent truncation forbidden). Rotation/prune runs inside the drain,
// off the delivery hot path. Returns an EventEmitter-like object ({ append, flush, close, on }).
function createAuditWriter(options = {}) {
  const filePath = options.path;
  if (!filePath) throw new Error('createAuditWriter requires a path');
  const queueMax = Number.isFinite(options.queueMax) ? options.queueMax : DEFAULT_QUEUE_MAX;
  const flushMs = Number.isFinite(options.flushMs) ? options.flushMs : DEFAULT_FLUSH_MS;
  const preview = options.preview === true;
  const previewBytes = Number.isFinite(options.previewBytes) ? options.previewBytes : DEFAULT_PREVIEW_BYTES;
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : DEFAULT_MAX_BYTES;
  const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : DEFAULT_MAX_FILES;
  const maxAgeDays = Number.isFinite(options.maxAgeDays) ? options.maxAgeDays : DEFAULT_MAX_AGE_DAYS;

  const emitter = new EventEmitter();
  let queue = [];
  let timer = null;
  let writing = null;
  let closed = false;
  let droppedTotal = 0;

  ensureDir();

  function ensureDir() {
    if (options.storage) return;
    const dir = path.dirname(filePath);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700); // tighten even if the dir pre-existed with a looser mode
    } catch { /* best-effort; surfaced as audit_error at first write if truly broken */ }
  }

  // Fire-and-forget: NEVER returns a promise to the caller — the delivery path must not await.
  function append(record) {
    if (closed) return;
    if (queue.length >= queueMax) {
      queue.shift(); // drop oldest
      droppedTotal += 1;
      emitter.emit('audit_overflow', { dropped: droppedTotal, queueMax });
    }
    queue.push({
      ...record,
      preview: record.preview != null ? record.preview : preview,
      previewBytes: record.previewBytes != null ? record.previewBytes : previewBytes
    });
    scheduleFlush();
  }

  function scheduleFlush() {
    if (closed || timer || writing || queue.length === 0) return;
    timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, flushMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function flush() {
    if (writing) await writing;
    if (queue.length === 0) return;
    writing = writeBatch();
    await writing;
  }

  async function writeBatch() {
    const batch = queue;
    queue = [];
    try {
      const data = batch.map((r) => buildAuditLine(r)).join('\n') + '\n';
      if (options.storage) {
        await options.storage.writeBatch(data, { maxBytes, maxFiles, maxAgeDays });
        return;
      }
      await rotateIfNeeded();
      await fs.promises.appendFile(filePath, data, { mode: 0o600 });
      // appendFile's mode only applies on create — chmod each flush so a pre-existing file
      // (or umask-loosened create) is forced to 0600 (the file may carry preview content).
      try { await fs.promises.chmod(filePath, 0o600); } catch { /* best-effort */ }
    } catch (err) {
      emitter.emit('audit_error', err);
    } finally {
      writing = null;
      if (queue.length > 0) scheduleFlush();
    }
  }

  async function rotateIfNeeded() {
    let size = 0;
    try { size = (await fs.promises.stat(filePath)).size; } catch { size = 0; }
    if (size >= maxBytes) {
      // Shift .{maxFiles-1}→.{maxFiles} … .1→.2, dropping the oldest beyond maxFiles, then
      // active→.1. rename overwrites, so the file falling off the top is discarded.
      for (let i = maxFiles - 1; i >= 1; i--) {
        try { await fs.promises.rename(`${filePath}.${i}`, `${filePath}.${i + 1}`); } catch { /* gap */ }
      }
      try { await fs.promises.rename(filePath, `${filePath}.1`); } catch { /* nothing to rotate */ }
    }
    await pruneByAge();
  }

  async function pruneByAge() {
    if (!(maxAgeDays > 0)) return;
    const cutoff = Date.now() - maxAgeDays * 86400000;
    for (let i = 1; i <= maxFiles; i++) {
      const rotated = `${filePath}.${i}`;
      try {
        const st = await fs.promises.stat(rotated);
        if (st.mtimeMs < cutoff) await fs.promises.unlink(rotated);
      } catch { /* absent or busy — best-effort */ }
    }
  }

  async function close() {
    closed = true;
    if (timer) { clearTimeout(timer); timer = null; }
    do { await flush(); } while (writing || queue.length > 0);
  }

  return {
    append,
    flush,
    close,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter)
  };
}

function toMs(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n < 1e12 ? n * 1000 : n;
  }
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : parsed;
}

// Filter an array of parsed records (spec §7). `from` matches claimed_from OR
// verified_sender_sid; `to` matches the resolved sid OR the pre-resolution alias.
function matchInjects(records, filters = {}) {
  let out = records;
  const since = toMs(filters.since);
  const until = toMs(filters.until);
  if (since != null) out = out.filter((r) => { const t = toMs(r.ts); return t != null && t >= since; });
  if (until != null) out = out.filter((r) => { const t = toMs(r.ts); return t != null && t <= until; });
  if (filters.to) out = out.filter((r) => r.to === filters.to || r.to_alias === filters.to);
  if (filters.from) out = out.filter((r) => r.claimed_from === filters.from || r.verified_sender_sid === filters.from);
  if (filters.spoof) out = out.filter((r) => r.spoof_suspected === true);
  return out;
}

// Read the jsonl, filter, return newest-first, paginate by cursor (line offset into the
// filtered newest-first list). Bounded by `limit` (default 200). Absent file → empty result.
function readInjectLog(filePath, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 200, 1), 1000);
  const cursor = Number(options.cursor) > 0 ? Number(options.cursor) : 0;
  let raw = '';
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return { injects: [], next_cursor: null }; }

  const records = raw.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  const filtered = matchInjects(records, options);
  filtered.reverse(); // newest first
  const page = filtered.slice(cursor, cursor + limit);
  const next = cursor + limit < filtered.length ? cursor + limit : null;
  return { injects: page, next_cursor: next };
}

module.exports = {
  buildAuditLine,
  createAuditWriter,
  readInjectLog,
  matchInjects
};
