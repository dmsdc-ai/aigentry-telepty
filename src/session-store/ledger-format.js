'use strict';

// #1207 — pure ledger format: frames, log positions, record application, lazy-fact overlay,
// 32-byte index entries, class/capacity accounting. No filesystem access anywhere in this file;
// the owner worker (ledger-owner.js) and the main-thread client (ledger-client.js) share it so
// both sides apply exactly the same deterministic function to the same frame.
//
// Ordering is by durable log position `pos = (epoch, seq)`, never by wall-clock `at` (errata C3).

const crypto = require('node:crypto');

const STORE_FORMAT_VERSION = 4;
const MAX_OBSERVATIONS_PER_RECORD = 50;           // persistence.js cap, unchanged
const FRAME_HASH_CHARS = 16;

// Frame caps (bytes of one encoded frame). Proposed until measured (DECISION §10).
const FRAME_CAPS = Object.freeze({
  obs: 16384, state: 16384, begin: 16384, fact: 16384, reheat: 1048576, iact: 1056768,
});
// Group soft caps and segment roll (proposed).
const GROUP = Object.freeze({ frames: 64, bytes: 262144, ms: 5 });
const SEGMENT_ROLL_BYTES = 8388608;
const COMPACT_FRAMES = 20000;
const RECEIPTS_MAX = 40000;
const MESSAGE_MAX_BYTES = 65536;
const COLD_INDEX_MAX_BYTES = 67108864;
const FREE_SPACE_HINT_BYTES = 67108864;

// Capacity (errata C5/C6, CONTRACT-PATCH capacity.*). All proposed until measured.
const R_MAX_JOBS = 512;
const HOT_MAX_RECORDS = 576;
const HOT_MAX_ENCODED_BYTES = 67108864;
const POOLS = Object.freeze({
  T: { entries: 512, bytes: 8388608, unit: 16384 },                 // 1 per admitted job (reserved at begin)
  R: { entries: 2 * 512 + 128, bytes: 18874368, unit: 16384, reservedPerJob: 2, shared: 128 },
  L: { entries: 64, bytes: 4194304, unit: 16384 },
  O: { entries: 1024, bytes: 4194304, unit: 16384 },
  I: { entries: 12, bytes: 4259840, perAct: { entries: 3, bytes: 1064960 }, concurrentActs: 4 },
});
const POOL_TOTALS = Object.freeze({ entries: 2764, bytes: 39911424 });
const SUSTAINED_EXHAUSTION_MS = 5000;

function sha256Hex(text) { return crypto.createHash('sha256').update(text, 'utf8').digest('hex'); }
function frameHash(json) { return sha256Hex(json).slice(0, FRAME_HASH_CHARS); }

/** `<json>\t<sha256(json)[0:16]>\n` as a Buffer. */
function encodeFrame(obj) {
  const json = JSON.stringify(obj);
  return Buffer.from(json + '\t' + frameHash(json) + '\n', 'utf8');
}
function frameBytes(obj) { return encodeFrame(obj).length; }

/**
 * Decode a segment buffer. Returns `{ frames: [{obj, offset, length}], tail }` where `tail` is
 * `null` when every byte parsed, else `{ offset, bytes, reason }` naming the first byte that could
 * not be applied (no newline, bad hash, unparseable). Nothing after a bad frame is applied — a
 * later valid line cannot prove the earlier gap was benign — but nothing is removed either.
 */
function decodeFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset < buf.length) {
    const nl = buf.indexOf(0x0a, offset);
    if (nl === -1) return { frames, tail: { offset, bytes: buf.length - offset, reason: 'no_newline' } };
    const line = buf.subarray(offset, nl).toString('utf8');
    const tab = line.lastIndexOf('\t');
    if (tab === -1) return { frames, tail: { offset, bytes: buf.length - offset, reason: 'no_hash' } };
    const json = line.slice(0, tab);
    const hash = line.slice(tab + 1);
    if (hash.length !== FRAME_HASH_CHARS || frameHash(json) !== hash) {
      return { frames, tail: { offset, bytes: buf.length - offset, reason: 'hash_mismatch' } };
    }
    let obj;
    try { obj = JSON.parse(json); } catch { return { frames, tail: { offset, bytes: buf.length - offset, reason: 'unparseable' } }; }
    frames.push({ obj, offset, length: nl + 1 - offset, hash });
    offset = nl + 1;
  }
  return { frames, tail: null };
}

/**
 * Split decoded frames into groups closed by a valid commit frame. Frames after the last commit
 * frame are returned as `open` (never applied, never deleted).
 */
function groupFrames(frames) {
  const groups = [];
  let current = [];
  for (const f of frames) {
    if (f.obj && f.obj.t === 'commit') {
      const n = Number(f.obj.n);
      if (current.length !== n) {
        // A commit frame that does not describe the frames before it is not a valid commit.
        return { groups, open: current.concat([f]), invalidCommit: { offset: f.offset, expected: n, actual: current.length } };
      }
      groups.push({ frames: current, commit: f });
      current = [];
    } else {
      current.push(f);
    }
  }
  return { groups, open: current, invalidCommit: null };
}

// ---------------------------------------------------------------------------
// Log positions
// ---------------------------------------------------------------------------
function pos(epoch, seq) { return { epoch: Number(epoch) || 0, seq: Number(seq) || 0 }; }
function comparePos(a, b) {
  const ae = a ? Number(a.epoch) || 0 : 0; const be = b ? Number(b.epoch) || 0 : 0;
  if (ae !== be) return ae < be ? -1 : 1;
  const as = a ? Number(a.seq) || 0 : 0; const bs = b ? Number(b.seq) || 0 : 0;
  if (as !== bs) return as < bs ? -1 : 1;
  return 0;
}
function posKey(p) { return `${p.epoch}:${p.seq}`; }

// ---------------------------------------------------------------------------
// Observations and records
// ---------------------------------------------------------------------------
function observationIdentity(kind, trigger) { return `${kind}|${trigger == null ? '' : trigger}`; }

function capObservations(arr) {
  const out = arr.slice();
  while (out.length > MAX_OBSERVATIONS_PER_RECORD) out.shift();
  return out;
}

/**
 * The persistence.js:295-304 rule, non-mutating: returns `{ record, entry }`.
 * `observation.at` is REQUIRED (the client stamps it); `seq` is assigned here.
 */
function appendObservation(record, observation) {
  const seq = (Number(record.observation_seq) || 0) + 1;
  const { at, ...rest } = observation;
  const entry = { ...rest, seq, at: at || null };
  const observations = capObservations([...(Array.isArray(record.observations) ? record.observations : []), entry]);
  return { record: { ...record, observation_seq: seq, last_observation: entry, observations }, entry };
}

function factApplies(fact, record) {
  if (!fact || !record) return false;
  if (fact.scope === 'global') return true;
  return fact.scope === 'session' && fact.sid === record.session_id;
}

/**
 * Facts applicable to `record` with `pos > record.materialized_through` (and `< upto` when given),
 * in log order. `facts` must already be sorted by pos (the owner keeps them so).
 */
function pendingFactsFor(record, facts, upto) {
  const through = record.materialized_through || pos(0, 0);
  const out = [];
  for (const fact of facts) {
    if (comparePos(fact.pos, through) <= 0) continue;
    if (upto && comparePos(fact.pos, upto) >= 0) break;
    if (factApplies(fact, record)) out.push(fact);
  }
  return out;
}

/**
 * Fold facts into a record (materialization). Deterministic given the same record and the same
 * ordered facts; used identically by the owner (at reheat / per-record write) and by replay.
 * Returns the record with `materialized_through` advanced to `through` (a pos).
 */
function materialize(record, facts, through) {
  let current = record;
  for (const fact of facts) current = appendObservation(current, fact.observation).record;
  return { ...current, materialized_through: through };
}

/** Externally visible view: stored tail + pending facts, seq continuing, cap applied. */
function overlay(record, facts) {
  if (!record) return null;
  const pending = pendingFactsFor(record, facts);
  if (pending.length === 0) return record;
  let current = record;
  for (const fact of pending) current = appendObservation(current, fact.observation).record;
  return current;
}

// ---------------------------------------------------------------------------
// Delta application (owner apply == replay apply == client read-model apply)
// ---------------------------------------------------------------------------
const TERMINAL_STATES = Object.freeze(['aborted', 'superseded']);

/**
 * Apply one frame to a projection. `ctx` is `{ get(id), set(id, record), facts }` — the owner
 * passes its group overlay, replay passes the committed projection, the client passes its read
 * model. Returns `{ effects: [{id, entry, tracking_state}], record? }` or throws on a frame that
 * cannot be applied (the caller decides nack / unavailable_read).
 */
function applyFrame(frame, ctx) {
  const at = pos(frame.epoch, frame.seq);
  const effects = [];
  switch (frame.t) {
    case 'begin': {
      if (ctx.get(frame.id)) throw new Error('already_exists');
      for (const s of frame.supersede || []) {
        const prior = ctx.get(s.id);
        if (!prior) continue;
        const folded = materialize(prior, pendingFactsFor(prior, ctx.facts, at), at);
        const { record, entry } = appendObservation({ ...folded, tracking_state: 'superseded' }, s.entry);
        ctx.set(s.id, record);
        effects.push({ id: s.id, entry, tracking_state: 'superseded' });
      }
      const record = { ...frame.record, materialized_through: at };
      ctx.set(frame.id, record);
      effects.push({ id: frame.id, entry: record.last_observation || null, tracking_state: record.tracking_state, record });
      return { effects, record };
    }
    case 'obs': {
      const prior = ctx.get(frame.id);
      if (!prior) throw new Error('record_missing');
      const folded = materialize(prior, pendingFactsFor(prior, ctx.facts, at), at);
      const { record, entry } = appendObservation(folded, frame.observation);
      ctx.set(frame.id, record);
      effects.push({ id: frame.id, entry, tracking_state: record.tracking_state });
      return { effects, record };
    }
    case 'state': {
      const prior = ctx.get(frame.id);
      if (!prior) throw new Error('record_missing');
      if (prior.tracking_state !== 'tracked') throw new Error('record_terminal');
      if (!TERMINAL_STATES.includes(frame.tracking_state)) throw new Error('invalid');
      const folded = materialize(prior, pendingFactsFor(prior, ctx.facts, at), at);
      const { record, entry } = appendObservation({ ...folded, tracking_state: frame.tracking_state }, frame.observation);
      ctx.set(frame.id, record);
      effects.push({ id: frame.id, entry, tracking_state: record.tracking_state });
      return { effects, record };
    }
    case 'reheat': {
      const record = { ...frame.record, materialized_through: at };
      ctx.set(frame.id, record);
      effects.push({ id: frame.id, entry: record.last_observation || null, tracking_state: record.tracking_state, record });
      return { effects, record };
    }
    case 'fact': {
      const fact = { pos: at, scope: frame.scope, sid: frame.sid || null, observation: frame.observation };
      ctx.facts.push(fact);
      return { effects, fact };
    }
    case 'iact': {
      if (typeof ctx.setAction === 'function') ctx.setAction(frame.action, frame.pending || null);
      return { effects };
    }
    default:
      throw new Error('invalid');
  }
}

// ---------------------------------------------------------------------------
// 32-byte index entries: 16 B key prefix | 2 B file | 6 B offset | 4 B len | 4 B flags
// ---------------------------------------------------------------------------
const INDEX_ENTRY_BYTES = 32;
function keyPrefix(text) { return crypto.createHash('sha256').update(String(text), 'utf8').digest().subarray(0, 16); }
function encodeIndexEntry({ key, file, offset, len, flags = 0 }) {
  const buf = Buffer.alloc(INDEX_ENTRY_BYTES);
  (Buffer.isBuffer(key) ? key : keyPrefix(key)).copy(buf, 0, 0, 16);
  buf.writeUInt16BE(file & 0xffff, 16);
  buf.writeUIntBE(offset, 18, 6);
  buf.writeUInt32BE(len >>> 0, 24);
  buf.writeUInt32BE(flags >>> 0, 28);
  return buf;
}
function decodeIndexEntry(buf, at = 0) {
  return {
    key: Buffer.from(buf.subarray(at, at + 16)),
    file: buf.readUInt16BE(at + 16),
    offset: buf.readUIntBE(at + 18, 6),
    len: buf.readUInt32BE(at + 24),
    flags: buf.readUInt32BE(at + 28),
  };
}
/** Sort entries by key (Buffer compare) and concatenate. */
function buildIndex(entries) {
  const sorted = entries.slice().sort((a, b) => Buffer.compare(a.key, b.key));
  return Buffer.concat(sorted.map((e) => encodeIndexEntry(e)));
}
/** Binary search for the first entry whose key equals `key`; returns the entry index or -1. */
function findIndexEntry(indexBuf, key) {
  const k = Buffer.isBuffer(key) ? key : keyPrefix(key);
  let lo = 0; let hi = indexBuf.length / INDEX_ENTRY_BYTES - 1; let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = Buffer.compare(indexBuf.subarray(mid * INDEX_ENTRY_BYTES, mid * INDEX_ENTRY_BYTES + 16), k);
    if (c === 0) { found = mid; hi = mid - 1; } else if (c < 0) lo = mid + 1; else hi = mid - 1;
  }
  return found;
}
/** All entries whose key equals `key` (contiguous in a sorted index). */
function findIndexEntries(indexBuf, key) {
  const k = Buffer.isBuffer(key) ? key : keyPrefix(key);
  const first = findIndexEntry(indexBuf, k);
  if (first === -1) return [];
  const out = [];
  for (let i = first; i * INDEX_ENTRY_BYTES < indexBuf.length; i++) {
    const e = decodeIndexEntry(indexBuf, i * INDEX_ENTRY_BYTES);
    if (!e.key.equals(k)) break;
    out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Classes and accounting
// ---------------------------------------------------------------------------
const RESULT_KINDS = new Set(['inject_parked', 'session_process_exited', 'session_dead',
  'idle_quiet_observed', 'task_idle_unconfirmed', 'ready_frame_observed']);

/** T | R | L | O | I for one submitted delta. `result` marks a result-class observation. */
function classify(kind, observation, opts = {}) {
  if (kind === 'state') return 'T';
  if (kind === 'fact' || kind === 'reheat') return 'L';
  if (kind === 'iact') return 'I';
  if (kind === 'begin') return 'T';
  if (kind === 'obs') {
    if (opts.result === true) return 'R';
    const k = observation && observation.kind;
    if (observation && observation.emitted_via && observation.emitted_via !== 'transition') return 'R';
    if (RESULT_KINDS.has(k) || (observation && observation.kind === 'inject_parked')) return 'R';
    return 'O';
  }
  return 'O';
}

/**
 * Pure admission accounting (errata C5/C6): per-class entries/bytes, per-job T+2R reservation,
 * per-act I reservation, sustained-exhaustion gate. No queue, nothing retained.
 *
 * #1207 resume3 — measured defect (C5 walk, step 210: `inequality violated for I`): the original
 * I branch counted admissions but never bounded them; the T branch had no per-job unit or pool
 * bound; the shared-R check subtracted CONSUMED reservations from a count that releases had
 * already lowered, so it undercounted. Every admission branch is now coupled to the declared
 * budgets AND to the reservation it rides on, and every refusal returns before any counter moves:
 *   T  — exactly one terminal unit per admitted job, inflight at most once at a time, <= unit bytes
 *   R  — reserved units: <= reservedPerJob per job, consumed (never returned by release);
 *        shared units: tracked separately, <= shared entries and <= shared * unit bytes
 *   I  — <= perAct.entries / perAct.bytes per RESERVED act, and <= the pool (12 / 4259840)
 *   L/O — pool entries and bytes
 * `check()` additionally verifies the shared-R sub-budget. Serialization, recovery and index
 * formats are untouched by this correction.
 */
function createAccounting({ now = Date.now, pools = POOLS, rMax = R_MAX_JOBS } = {}) {
  const inflight = { T: { entries: 0, bytes: 0 }, R: { entries: 0, bytes: 0 }, L: { entries: 0, bytes: 0 }, O: { entries: 0, bytes: 0 }, I: { entries: 0, bytes: 0 } };
  const shared = { entries: 0, bytes: 0 };   // the R sub-pool not covered by job reservations
  const jobs = new Map();          // id -> { tUsed:bool (terminal unit inflight), rUsed:number (reserved results consumed) }
  const acts = new Map();          // sid -> true
  const lastRejection = { O: 0, R: 0, L: 0 };
  const lastRoom = { O: 0, R: 0, L: 0 };

  function validBytes(bytes) { return Number.isFinite(bytes) && bytes >= 0; }
  function room(c, entries, bytes) {
    const p = pools[c];
    return inflight[c].entries + entries <= p.entries && inflight[c].bytes + bytes <= p.bytes;
  }
  // "Full" for the sustained-exhaustion rule: the budget a NEW admission of that class would draw
  // on — the shared sub-pool for R (job reservations are never exhausted by traffic), the pool for O/L.
  function poolFull(c) {
    if (c === 'R') return shared.entries + 1 > pools.R.shared || shared.bytes + pools.R.unit > pools.R.shared * pools.R.unit;
    return !room(c, 1, pools[c].unit);
  }
  function sustainedExhaustion(t = now()) {
    for (const c of ['O', 'R', 'L']) {
      const full = poolFull(c);
      if (!full) lastRoom[c] = t;
      if (lastRejection[c] && t - lastRejection[c] <= SUSTAINED_EXHAUSTION_MS && full) return c;
      if (lastRejection[c] && full && t - lastRoom[c] >= SUSTAINED_EXHAUSTION_MS) return c;
    }
    return null;
  }
  /** Reserve 1 T + 2 R units for a job. Reservations are counted against the pools once (no double count with inflight). */
  function reserveJob(id, t = now()) {
    if (jobs.has(id)) return { ok: true, already: true };
    if (jobs.size + 1 > rMax) return { ok: false, reason: 'tracking_capacity_exhausted' };
    const sustained = sustainedExhaustion(t);
    if (sustained) return { ok: false, reason: 'sustained_exhaustion', class: sustained };
    const pT = pools.T; const pR = pools.R;
    if (jobs.size + 1 > pT.entries || (jobs.size + 1) * pT.unit > pT.bytes) return { ok: false, reason: 'tracking_capacity_exhausted' };
    if ((jobs.size + 1) * pR.reservedPerJob > pR.entries - pR.shared || (jobs.size + 1) * pR.reservedPerJob * pR.unit > pR.bytes - pR.shared * pR.unit) return { ok: false, reason: 'tracking_capacity_exhausted' };
    jobs.set(id, { rUsed: 0, tUsed: false });
    return { ok: true };
  }
  function releaseJob(id) { return jobs.delete(id); }
  function hasJob(id) { return jobs.has(id); }
  /** Admit one delta of class `c` with `bytes`; `jobId` lets R/T draw on the job's reservation. Refusals mutate nothing. */
  function admit(c, bytes, { jobId = null, t = now() } = {}) {
    const p = pools[c];
    if (!p) return { ok: false, reason: 'invalid_class', class: c || null };
    if (!validBytes(bytes)) return { ok: false, reason: 'invalid_bytes', class: c };
    const job = jobId ? jobs.get(jobId) : null;
    if (c === 'T') {
      if (!job) return { ok: false, reason: 'tracking_capacity_exhausted', class: 'T', detail: 'no_job_reservation' };
      if (job.tUsed) return { ok: false, reason: 'tracking_capacity_exhausted', class: 'T', detail: 'terminal_unit_inflight' };
      if (bytes > p.unit) return { ok: false, reason: 'tracking_capacity_exhausted', class: 'T', detail: 'above_reserved_unit' };
      if (!room('T', 1, bytes)) return { ok: false, reason: 'tracking_capacity_exhausted', class: 'T', detail: 'pool' };
      job.tUsed = true; inflight.T.entries += 1; inflight.T.bytes += bytes;
      return { ok: true, class: 'T', reserved: true };
    }
    if (c === 'R') {
      if (job && job.rUsed < p.reservedPerJob && bytes <= p.unit && room('R', 1, bytes)) {
        job.rUsed += 1; inflight.R.entries += 1; inflight.R.bytes += bytes;
        return { ok: true, class: 'R', reserved: true };
      }
      const sharedBytes = p.shared * p.unit;
      if (shared.entries + 1 > p.shared || shared.bytes + bytes > sharedBytes || !room('R', 1, bytes)) {
        lastRejection.R = t; return { ok: false, reason: 'tracking_capacity_result', class: 'R' };
      }
      lastRoom.R = t;
      shared.entries += 1; shared.bytes += bytes; inflight.R.entries += 1; inflight.R.bytes += bytes;
      return { ok: true, class: 'R', reserved: false };
    }
    if (c === 'I') {
      const perAct = p.perAct;
      const maxEntries = Math.min(p.entries, acts.size * perAct.entries);
      const maxBytes = Math.min(p.bytes, acts.size * perAct.bytes);
      if (acts.size === 0) return { ok: false, reason: 'tracking_capacity_exhausted', class: 'I', detail: 'no_act_reservation' };
      if (inflight.I.entries + 1 > maxEntries || inflight.I.bytes + bytes > maxBytes) return { ok: false, reason: 'tracking_capacity_exhausted', class: 'I', detail: 'act_reservation_or_pool' };
      inflight.I.entries += 1; inflight.I.bytes += bytes;
      return { ok: true, class: 'I', reserved: true };
    }
    if (!room(c, 1, bytes)) {
      lastRejection[c] = t;
      return { ok: false, reason: 'tracking_backpressure', class: c };
    }
    lastRoom[c] = t;
    inflight[c].entries += 1; inflight[c].bytes += bytes;
    return { ok: true, class: c, reserved: false };
  }
  /** Release one previously ADMITTED unit. Returns false (and mutates nothing) for an unknown class or invalid bytes. */
  function release(c, bytes, { jobId = null, reserved = false } = {}) {
    if (!pools[c] || !validBytes(bytes)) return false;
    inflight[c].entries = Math.max(0, inflight[c].entries - 1);
    inflight[c].bytes = Math.max(0, inflight[c].bytes - bytes);
    if (c === 'T' && reserved && jobId && jobs.has(jobId)) jobs.get(jobId).tUsed = false;   // the terminal unit is returned to its job
    if (c === 'R' && !reserved) { shared.entries = Math.max(0, shared.entries - 1); shared.bytes = Math.max(0, shared.bytes - bytes); }
    // A job's RESERVED result unit is consumed, not returned: a persisted result stays accounted
    // against the job until its terminal ACK (or demotion) releases the job.
    return true;
  }
  function reserveAct(sid) {
    if (acts.has(sid)) return false;
    if (acts.size + 1 > pools.I.concurrentActs) return false;
    acts.set(sid, true); return true;
  }
  function releaseAct(sid) { return acts.delete(sid); }
  function check() {
    const violations = [];
    for (const c of Object.keys(inflight)) {
      if (inflight[c].entries > pools[c].entries || inflight[c].bytes > pools[c].bytes) violations.push(c);
    }
    if (shared.entries > pools.R.shared || shared.bytes > pools.R.shared * pools.R.unit) violations.push('R_shared');
    const totalEntries = Object.values(inflight).reduce((s, x) => s + x.entries, 0);
    const totalBytes = Object.values(inflight).reduce((s, x) => s + x.bytes, 0);
    if (totalEntries > POOL_TOTALS.entries || totalBytes > POOL_TOTALS.bytes) violations.push('totals');
    return { ok: violations.length === 0, violations, totalEntries, totalBytes };
  }
  function status() {
    return { inflight: JSON.parse(JSON.stringify(inflight)), shared_r: { ...shared }, admitted_jobs: jobs.size, acts: acts.size,
      terminal_units_inflight: [...jobs.values()].filter((j) => j.tUsed).length,
      r_max: rMax, pools: { T: pools.T.entries, R: pools.R.entries, L: pools.L.entries, O: pools.O.entries, I: pools.I.entries },
      sustained_exhaustion: sustainedExhaustion(), last_rejection: { ...lastRejection } };
  }
  return { reserveJob, releaseJob, hasJob, admit, release, reserveAct, releaseAct, sustainedExhaustion, check, status, jobs };
}

/** The legacy record shape for exportV3 / loaders; strips owner-only fields. */
function toLegacyRecord(record) {
  if (!record) return record;
  const { materialized_through, ...rest } = record;
  return rest;
}

module.exports = {
  STORE_FORMAT_VERSION, MAX_OBSERVATIONS_PER_RECORD, FRAME_CAPS, GROUP, SEGMENT_ROLL_BYTES, COMPACT_FRAMES,
  RECEIPTS_MAX, MESSAGE_MAX_BYTES, COLD_INDEX_MAX_BYTES, FREE_SPACE_HINT_BYTES, R_MAX_JOBS, HOT_MAX_RECORDS,
  HOT_MAX_ENCODED_BYTES, POOLS, POOL_TOTALS, SUSTAINED_EXHAUSTION_MS, TERMINAL_STATES, INDEX_ENTRY_BYTES,
  sha256Hex, frameHash, encodeFrame, frameBytes, decodeFrames, groupFrames,
  pos, comparePos, posKey,
  observationIdentity, capObservations, appendObservation, factApplies, pendingFactsFor, materialize, overlay,
  applyFrame,
  keyPrefix, encodeIndexEntry, decodeIndexEntry, buildIndex, findIndexEntry, findIndexEntries,
  classify, createAccounting, toLegacyRecord,
};
