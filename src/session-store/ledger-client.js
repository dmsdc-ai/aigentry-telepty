'use strict';

// #1207 — the main-thread ledger CLIENT. Holds the O_EXCL lock, spawns and supervises the single
// owner worker, keeps a committed-only read model (updated only from acks in seq order, swapped
// atomically from a chunked snapshot after every owner open), and performs admission accounting
// before anything is submitted. Outcomes are explicit and exactly four:
//   ack                — the group's commit frame was fsynced (durable)
//   nack               — invalidity established BEFORE any persistence attempt
//   indeterminate      — a write/fsync attempt happened and its durability is unknown
//   rejected_admission — reservation failed; nothing queued, nothing persisted
// Nothing is retained in an unbounded main-thread queue, nothing is coalesced lossily, and no
// indeterminate or unresolved operation is ever retried automatically (errata C4/C5).

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const F = require('./ledger-format');
const lock = require('./ledger-lock');

const DEFAULT_RESOURCE_LIMITS = Object.freeze({ maxOldGenerationSizeMb: 1024 });
const DEFAULT_RESPAWN = Object.freeze({ maxPerWindow: 1, windowMs: 60000 });
const OPEN_STATES = new Set(['available', 'unavailable_write']);

function createLedgerClient(options = {}) {
  const dir = options.dir;
  if (typeof dir !== 'string' || !dir) throw new TypeError('ledger-client: dir required');
  const parent = path.dirname(dir);
  const lockPath = options.lockPath || path.join(parent, 'tracked-injections.lock');
  const legacyPath = options.legacyPath || dir;
  const fs = options.fs || nodeFs;
  const now = options.now || Date.now;
  const setTimer = options.setTimeout || globalThis.setTimeout;
  const clearTimer = options.clearTimeout || globalThis.clearTimeout;
  const workerPath = options.workerPath || path.join(__dirname, 'ledger-owner.js');
  const resourceLimits = { ...DEFAULT_RESOURCE_LIMITS, ...(options.resourceLimits || {}) };
  const respawnPolicy = { ...DEFAULT_RESPAWN, ...(options.respawnPolicy || {}) };
  const WorkerCtor = options.Worker || require('node:worker_threads').Worker;
  const log = options.log || ((...a) => console.log(...a));
  const warn = options.warn || ((...a) => console.warn(...a));
  const freeSpaceHintBytes = options.freeSpaceHintBytes == null ? F.FREE_SPACE_HINT_BYTES : options.freeSpaceHintBytes;

  const C = {
    pid: process.pid, token: null, lockHeld: false, lockInfo: null,
    worker: null, workerGen: 0, state: 'not_opened', reason: null, reasonDetail: null, epoch: 0, counts: null, resident: null, recovery: null,
    openedOnce: false, opening: null, closing: false, pendingAvailable: false,
    readModel: emptyModel(), nextModel: null,
    inflight: new Map(), reads: new Map(), unresolved: new Map(), resolved: new Map(),
    respawns: [], liveSids: new Set(), lastIndeterminate: null, ownerStatus: null,
  };
  const accounting = F.createAccounting({ now });

  // Lifecycle notifications across the client/runtime boundary (#1207, measured first-open recovery):
  // a listener hears `recovering`, `available` (ONLY once the snapshot has been swapped in),
  // `unavailable` / `unavailable_read` / `unavailable_write`, and `closed`. Listeners never throw
  // into the client and nothing here retries, resets a budget or changes an outcome.
  const listeners = new Set();
  function onStateChange(fn) { if (typeof fn !== 'function') return () => {}; listeners.add(fn); return () => { listeners.delete(fn); }; }
  function notify(kind) {
    if (!listeners.size) return;
    const ev = { kind, state: C.state, reason: C.reason, counts: C.counts, epoch: C.epoch, healthy: isHealthy() };
    for (const fn of [...listeners]) { try { fn(ev); } catch (error) { warn(`[LEDGER] state listener threw (${kind}): ${error && error.message}`); } }
  }

  // `identities` holds one stable object per resident inject id: read-model records are replaced
  // immutably on every ack, so anything keyed on record identity (the #914 once-per-inject source
  // notification) keys on this object instead. Lifetime == residency (dropped on demotion / swap).
  function emptyModel() { return { records: new Map(), bySession: new Map(), actions: new Map(), pending: new Map(), identities: new Map() }; }
  function isHealthy() { return C.openedOnce && OPEN_STATES.has(C.state); }
  function isAvailable() { return C.state === 'available' && !C.closing; }

  // ---- lock ------------------------------------------------------------------------------------
  function acquireLock() {
    if (C.lockHeld) return { held: true, lockPath, token: C.token };
    C.token = crypto.randomBytes(16).toString('hex');
    const result = lock.acquire(lockPath, { pid: C.pid, token: C.token }, fs);
    C.lockInfo = result;
    if (result.held) { C.lockHeld = true; return result; }
    C.state = result.reason === 'lock_present' ? 'lock_present' : 'unavailable';
    C.reason = result.reason; C.reasonDetail = { lockPath, contents: result.contents || null, code: result.code || null };
    return result;
  }
  function releaseLock() {
    if (!C.lockHeld) return { released: false, reason: 'not_held' };
    const r = lock.release(lockPath, { pid: C.pid, token: C.token }, fs);
    if (r.released) C.lockHeld = false;
    return r;
  }

  // ---- worker lifecycle --------------------------------------------------------------------------
  function spawnWorker() {
    const gen = ++C.workerGen;
    const worker = new WorkerCtor(workerPath, {
      workerData: { ledgerOwner: true, dir, lockPath, token: C.token, pid: C.pid, liveSids: [...C.liveSids], fsImplPath: options.fsImplPath || null,
        group: options.group || null, compactFrames: options.compactFrames || null, hotMaxRecords: options.hotMaxRecords || null, hotMaxBytes: options.hotMaxBytes || null, coldIndexMaxBytes: options.coldIndexMaxBytes || null },
      resourceLimits,
    });
    worker.on('message', (m) => { if (gen === C.workerGen) onMessage(m); });
    worker.on('error', (error) => { if (gen === C.workerGen) onWorkerFailure('error', error); });
    worker.on('exit', (code) => { if (gen === C.workerGen) onWorkerExit(code); });
    if (options.unrefWorker === true && typeof worker.unref === 'function') worker.unref();
    C.worker = worker;
    return worker;
  }
  function postToOwner(m) { if (C.worker) C.worker.postMessage(m); }

  function open(opts = {}) {
    if (C.opening) return C.opening;
    if (!C.lockHeld) {
      const r = acquireLock();
      if (!r.held) return Promise.resolve({ ok: false, state: C.state, reason: C.reason, lock: r });
    }
    if (Array.isArray(opts.liveSids)) for (const s of opts.liveSids) C.liveSids.add(s);
    C.closing = false;
    C.opening = (async () => {
      // An explicit re-open (e.g. after an unreadable store was repaired from outside) must never
      // leave two owners alive: the inert previous worker is terminated first, its handlers
      // detached by the generation bump so its exit is not mistaken for a failure.
      if (C.worker) {
        const old = C.worker; C.worker = null; C.workerGen++;
        for (const [txn, inflight] of C.inflight) resolveIndeterminate(txn, inflight, 'owner_replaced');
        for (const [, read] of C.reads) read.resolve({ items: [], reason: 'owner_replaced' });
        C.reads.clear();
        try { await old.terminate(); } catch { /* already gone */ }
      }
      return new Promise((resolve) => {
        C.openResolve = resolve;
        C.nextModel = emptyModel();
        C.state = 'recovering'; C.reason = null; C.pendingAvailable = false;
        spawnWorker();
        postToOwner({ type: 'open', dir, lockPath, token: C.token, live_sids: [...C.liveSids], req: 'snapshot' });
        notify('recovering');
      });
    })().finally(() => { C.opening = null; });
    return C.opening;
  }
  function settleOpen(result) {
    if (C.openResolve) { const r = C.openResolve; C.openResolve = null; r(result); }
  }

  function onWorkerExit(code) {
    const wasClosing = C.closing;
    C.worker = null;
    for (const [txn, inflight] of C.inflight) resolveIndeterminate(txn, inflight, wasClosing ? 'shutting_down' : 'owner_failed');
    for (const [, read] of C.reads) read.resolve({ items: [], reason: wasClosing ? 'shutting_down' : 'owner_failed', last: true });
    C.reads.clear();
    if (wasClosing) { C.state = 'closed'; settleOpen({ ok: false, state: 'closed', reason: 'closed' }); return; }
    C.state = 'unavailable'; C.reason = 'owner_failed'; C.reasonDetail = { exit_code: code }; C.pendingAvailable = false;
    const pending = C.opening;            // the open this owner was serving, if it is still being finalized
    settleOpen({ ok: false, state: C.state, reason: C.reason });
    notify('unavailable');
    // Same-daemon replacement reuses the still-held acquisition only after the old worker's exit
    // event (errata C1 rule 3), bounded by the respawn policy (≤ 1 per 60 s) — and, measured (#1207),
    // only after the failed open has FINALIZED: open() returns the pending opening-promise until its
    // finally has run, so a respawn scheduled synchronously here constructed no owner while the
    // budget was spent. The budget is charged at the actual attempt. A client that was closed in the
    // meantime, or that already has an owner or an open in flight (an explicit re-open raced the
    // exit), is left alone: never two owners, never a resurrected closed client.
    const respawn = () => {
      if (C.closing || C.state === 'closed' || C.worker || C.opening) return;
      const t = now();
      C.respawns = C.respawns.filter((x) => t - x < respawnPolicy.windowMs);
      if (C.respawns.length >= respawnPolicy.maxPerWindow) { warn(`[LEDGER] owner exited (code ${code}); respawn budget exhausted — store stays unavailable (owner_failed)`); notify('unavailable'); return; }
      C.respawns.push(t);
      warn(`[LEDGER] owner exited (code ${code}); respawning once (epoch advances; inflight work is indeterminate until resolve)`);
      open().catch(() => {});
    };
    if (pending) pending.then(respawn, respawn); else respawn();
  }
  function onWorkerFailure(kind, error) {
    warn(`[LEDGER] owner ${kind}: ${error && error.message}`);
    // The exit event follows; indeterminate resolution happens there, once.
  }

  // ---- messages from the owner -------------------------------------------------------------------
  function onMessage(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'state': return onState(m);
      case 'snapshot_chunk': return onSnapshotChunk(m);
      case 'ack': return onAck(m);
      case 'nack': return onNack(m);
      case 'indeterminate': return onIndeterminate(m);
      case 'read_chunk': case 'resolve_chunk': return onReadChunk(m);
      case 'demoted': return onDemoted(m);
      case 'progress': return undefined;
      case 'closed': return onClosed(m);
      default: return undefined;
    }
  }
  function onState(m) {
    C.reason = m.reason || null; C.epoch = m.epoch || C.epoch; C.counts = m.counts || C.counts; C.resident = m.resident || C.resident;
    if (m.recovery) C.recovery = m.recovery;
    C.reasonDetail = { detail: m.detail || null, retained: m.retained || null, staging: m.staging || null, lockPath: m.lockPath || null, group: m.group || null, code: m.code || null, message: m.message || null };
    if (m.store === 'available') {
      // The owner posts `available` and THEN the snapshot chunks. While an open is pending the state is
      // held (`recovering`) and becomes `available` in onSnapshotChunk, at the swap — the point
      // settleOpen(ok) already uses — so `state`/isAvailable() never report a usable store over an
      // incomplete read model (measured: a client-only `available` is not a recovered store).
      if (C.openResolve) { C.pendingAvailable = true; return; }
      C.state = 'available'; C.openedOnce = true; notify('available'); return;
    }
    C.state = m.store; C.pendingAvailable = false;
    if (['unavailable', 'unavailable_read'].includes(m.store)) {
      // A failed open authorizes nothing (guard semantics). Health is NOT flipped true here.
      settleOpen({ ok: false, state: m.store, reason: m.reason, detail: C.reasonDetail });
    }
    notify(m.store);
  }
  function onSnapshotChunk(m) {
    const model = C.nextModel || (C.nextModel = emptyModel());
    for (const item of m.items || []) {
      if (item.kind === 'record') setModelRecord(model, item.record);
      else if (item.kind === 'action') model.actions.set(item.action.action_id, item.action);
      else if (item.kind === 'pending') model.pending.set(item.pending.inject_id, item.pending);
    }
    if (!m.last) return postToOwner({ type: 'chunk_ack', req: m.req });
    // Atomic swap: a concurrent poll sees either the old model or the complete new one.
    C.readModel = model; C.nextModel = null;
    rebuildAdmittedJobs();
    if (C.pendingAvailable) { C.pendingAvailable = false; C.state = 'available'; C.openedOnce = true; }
    settleOpen({ ok: true, state: C.state, counts: C.counts, recovery: C.recovery });
    notify('available');
    if (C.unresolved.size) sendResolve([...C.unresolved.keys()]).catch(() => {});
    return undefined;
  }
  function setModelRecord(model, record) {
    const prior = model.records.get(record.inject_id);
    if (prior && prior.session_id !== record.session_id) { const s = model.bySession.get(prior.session_id); if (s) s.delete(record.inject_id); }
    model.records.set(record.inject_id, record);
    if (!model.identities.has(record.inject_id)) model.identities.set(record.inject_id, { inject_id: record.inject_id });
    if (!model.bySession.has(record.session_id)) model.bySession.set(record.session_id, new Set());
    model.bySession.get(record.session_id).add(record.inject_id);
  }
  function onDemoted(m) {
    for (const id of m.ids || []) {
      const rec = C.readModel.records.get(id);
      if (rec) { const s = C.readModel.bySession.get(rec.session_id); if (s) { s.delete(id); if (!s.size) C.readModel.bySession.delete(rec.session_id); } }
      C.readModel.records.delete(id); C.readModel.identities.delete(id);
      // Residency release is the durable tier transition (errata C6): a tracked job that left the
      // hot set with no live session releases its T+R reservation here; terminals released at ACK.
      accounting.releaseJob(id);
    }
  }
  function rebuildAdmittedJobs() {
    // admitted_jobs = hot tracked records; existing reservations for ids no longer hot are kept
    // (their terminal may still be inflight / unresolved). Over-cap keeps everything and refuses
    // new begins until below cap (status names over_cap).
    for (const r of C.readModel.records.values()) if (r.tracking_state === 'tracked') accounting.reserveJob(r.inject_id);
  }
  function applyEffects(effects) {
    const model = C.readModel;
    for (const e of effects || []) {
      if (e.record) { setModelRecord(model, e.record); continue; }
      const rec = model.records.get(e.id);
      if (!rec || !e.entry) continue;
      const observations = F.capObservations([...(rec.observations || []), e.entry]);
      setModelRecord(model, { ...rec, observation_seq: e.entry.seq, last_observation: e.entry, observations, tracking_state: e.tracking_state || rec.tracking_state });
    }
  }
  function onAck(m) {
    const inflight = C.inflight.get(m.txn);
    if (!inflight) return;
    C.inflight.delete(m.txn);
    accounting.release(inflight.class, inflight.bytes, { jobId: inflight.jobId, reserved: inflight.reserved });
    if (m.basis === 'written') {
      applyEffects(m.effects);
      if (inflight.kind === 'iact' && inflight.delta) { C.readModel.actions.set(inflight.delta.action.action_id, inflight.delta.action); if (inflight.delta.pending) C.readModel.pending.set(inflight.delta.pending.inject_id, inflight.delta.pending); }
      if (inflight.kind === 'state') accounting.releaseJob(inflight.id);
    }
    if (m.result === 'already_terminal' && inflight.kind === 'state') accounting.releaseJob(inflight.id);
    inflight.resolve({ outcome: 'ack', txn: m.txn, seq: m.seq, epoch: m.epoch, result: m.result, basis: m.basis, entry: m.entry || null, record_state: m.record_state || null,
      superseded: m.superseded || [], effects: m.effects || [], depends_on_pos: m.depends_on_pos || null, retried: m.retried === true, duplicate_txn: m.duplicate_txn === true });
  }
  function onNack(m) {
    const inflight = C.inflight.get(m.txn);
    if (!inflight) return;
    C.inflight.delete(m.txn);
    accounting.release(inflight.class, inflight.bytes, { jobId: inflight.jobId, reserved: inflight.reserved });
    if (['hot_capacity', 'tracking_capacity_exhausted'].includes(m.reason)) {
      inflight.resolve({ outcome: 'rejected_admission', txn: m.txn, class: inflight.class, reason: m.reason, resident: m.resident || null, owner: true });
      return;
    }
    inflight.resolve({ outcome: 'nack', txn: m.txn, reason: m.reason, code: m.code || null, tracking_state: m.tracking_state || null });
  }
  function resolveIndeterminate(txn, inflight, reason, group = null) {
    C.inflight.delete(txn);
    accounting.release(inflight.class, inflight.bytes, { jobId: inflight.jobId, reserved: inflight.reserved });
    // Job reservations are RETAINED: the terminal may or may not be durable.
    if (C.unresolved.size < F.POOL_TOTALS.entries) C.unresolved.set(txn, { kind: inflight.kind, id: inflight.id, reason, group, at: now(), outcome: 'indeterminate' });
    inflight.resolve({ outcome: 'indeterminate', txn, reason, group, kind: inflight.kind, id: inflight.id });
  }
  function onIndeterminate(m) {
    C.lastIndeterminate = { at: now(), group: m.group, reason: m.reason, txns: (m.txns || []).length };
    for (const txn of m.txns || []) { const inflight = C.inflight.get(txn); if (inflight) resolveIndeterminate(txn, inflight, m.reason || 'write_error', m.group); }
  }
  function onReadChunk(m) {
    const read = C.reads.get(m.req);
    if (!read) return;
    for (const item of m.items || []) read.items.push(item);
    if (m.reason && !read.reason) read.reason = m.reason;
    if (m.tier) read.tier = m.tier;
    if (!m.last) return postToOwner({ type: 'chunk_ack', req: m.req });
    C.reads.delete(m.req);
    read.resolve({ items: read.items, reason: read.reason || null, tier: read.tier || null });
    return undefined;
  }
  function onClosed(m) {
    C.closedInfo = m;
    if (C.closedResolve) { const r = C.closedResolve; C.closedResolve = null; r(m); }
  }

  // ---- submission --------------------------------------------------------------------------------
  function unavailableOutcome(txn) {
    const reason = C.state === 'lock_present' ? 'lock_present' : C.state === 'recovering' ? 'recovering' : C.state === 'unavailable_read' ? 'unavailable_read'
      : C.state === 'unavailable_write' ? 'unavailable_write' : C.closing ? 'shutting_down' : (C.reason === 'owner_failed' ? 'owner_failed' : (C.reason || 'unavailable'));
    return { outcome: 'nack', txn, reason, code: C.reason || null, state: C.state };
  }
  /**
   * submit(kind, delta, { class?, jobId?, result? }) → Promise<outcome>
   * Admission happens here (reserve before accept); the owner validates and persists.
   */
  function submit(kind, delta, opts = {}) {
    const txn = crypto.randomUUID();
    if (!isAvailable()) return Promise.resolve(unavailableOutcome(txn));
    const bytes = F.frameBytes({ t: kind, epoch: 0, seq: 0, txn, ...delta });
    const cap = F.FRAME_CAPS[kind] || F.FRAME_CAPS.obs;
    if (bytes > cap) return Promise.resolve({ outcome: 'nack', txn, reason: 'frame_too_large', bytes, cap });
    const cls = opts.class || F.classify(kind, delta && delta.observation, { result: opts.result === true });
    const jobId = opts.jobId || (kind === 'begin' || kind === 'state' || kind === 'obs' || kind === 'reheat' ? delta.id : null);
    let admitted;
    if (kind === 'begin') {
      if (!accounting.hasJob(jobId)) return Promise.resolve({ outcome: 'rejected_admission', txn, class: 'T', reason: 'tracking_capacity_exhausted', detail: 'reserve_job_first' });
      admitted = accounting.admit('T', bytes, { jobId });
    } else {
      const reserveBytes = cls === 'L' || cls === 'I' ? bytes : Math.max(bytes, (F.POOLS[cls] && F.POOLS[cls].unit) || bytes);
      admitted = accounting.admit(cls, reserveBytes, { jobId });
      if (admitted.ok) admitted.bytes = reserveBytes;
    }
    if (!admitted.ok) return Promise.resolve({ outcome: 'rejected_admission', txn, class: admitted.class || cls, reason: admitted.reason, detail: admitted.detail || null });
    return new Promise((resolve) => {
      C.inflight.set(txn, { kind, class: admitted.class || cls, bytes: admitted.bytes || bytes, jobId, reserved: admitted.reserved === true, resolve, id: delta.id || null, startedAt: now(), delta });
      postToOwner({ type: 'submit', txn, class: admitted.class || cls, kind, delta, bytes });
    });
  }
  function reserveJob(id) {
    if (!isAvailable()) return { ok: false, reason: unavailableOutcome(null).reason };
    if (freeSpaceHintBytes > 0 && !freeSpaceOk()) return { ok: false, reason: 'disk_full' };
    return accounting.reserveJob(id);
  }
  function releaseJob(id) { return accounting.releaseJob(id); }
  function freeSpaceOk() {
    try { const s = fs.statfsSync(parent); return s.bavail * s.bsize >= freeSpaceHintBytes; } catch { return true; }
  }

  /** Make `id` hot (reheat) if it is cold. Resolves `{ ok, outcome }`. Reads never reheat; this is a write path helper. */
  async function ensureHot(id) {
    if (C.readModel.records.has(id)) return { ok: true, hot: true };
    const fetched = await fetchTrackedInjection(id);
    if (!fetched.record) return { ok: false, reason: fetched.reason || 'record_missing' };
    let jobReserved = false;
    if (fetched.record.tracking_state === 'tracked') {
      const r = reserveJob(id);
      if (!r.ok) return { ok: false, reason: r.reason, outcome: { outcome: 'rejected_admission', class: 'T', reason: r.reason } };
      jobReserved = true;
    }
    const outcome = await submit('reheat', { id, job_reserved: jobReserved }, { class: 'L' });
    if (outcome.outcome === 'ack') return { ok: true, hot: true, reheated: true, outcome };
    if (outcome.outcome === 'ack' || (outcome.outcome === 'nack' && outcome.reason === 'already_hot')) return { ok: true, hot: true, outcome };
    if (jobReserved && outcome.outcome !== 'indeterminate') accounting.releaseJob(id);
    return { ok: false, reason: outcome.reason || outcome.outcome, outcome };
  }

  // ---- reads -----------------------------------------------------------------------------------------
  function readRequest(message) {
    if (!C.worker || C.state === 'not_opened' || C.state === 'lock_present' || C.state === 'closed') return Promise.resolve({ items: [], reason: unavailableOutcome(null).reason });
    const req = crypto.randomUUID();
    return new Promise((resolve) => { C.reads.set(req, { items: [], resolve }); postToOwner({ ...message, req }); });
  }
  async function fetchTrackedInjection(id) {
    const r = await readRequest({ type: 'read', op: 'get', id });
    return { record: r.items[0] || null, reason: r.items[0] ? null : (r.reason || 'not_observed_by_daemon_epoch'), tier: r.tier || null };
  }
  async function listForSession(sid) { const r = await readRequest({ type: 'read', op: 'listSession', sid }); return r.items; }
  async function ownerStatus() { const r = await readRequest({ type: 'read', op: 'status' }); C.ownerStatus = r.items[0] || null; return C.ownerStatus; }
  async function exportV3(out) { const r = await readRequest({ type: 'read', op: 'exportV3', out }); return r.items[0] || { ok: false, reason: r.reason || 'export_failed' }; }
  async function compact() { const r = await readRequest({ type: 'compact' }); return r.items[0] || { ok: false, reason: r.reason }; }
  async function sendResolve(txns) {
    const r = await readRequest({ type: 'resolve', txns });
    for (const item of r.items) {
      const u = C.unresolved.get(item.txn);
      if (!u) continue;
      u.settled = item.outcome; u.pos = item.pos || null; u.segment = item.segment || null; u.offset = item.offset == null ? null : item.offset;
      if (item.outcome !== 'unresolved') { C.resolved.set(item.txn, { ...u }); }
      // `unresolved` stays unresolved for the process lifetime; never upgraded by inference.
    }
    return r.items;
  }
  function live(sid, on) { if (on) C.liveSids.add(sid); else C.liveSids.delete(sid); postToOwner({ type: 'live', sid, on: !!on }); }

  // ---- read model (sync, committed only) ------------------------------------------------------------------
  const readModel = {
    getTrackedInjection(id) {
      if (typeof id !== 'string' || !id || id === '__proto__' || id === 'prototype' || id === 'constructor') return null;
      return C.readModel.records.get(id) || null;
    },
    hasHeldInteraction(sid) {
      for (const a of C.readModel.actions.values()) if (a.sid === sid && ['dispatched', 'outcome_unknown'].includes(a.stage)) return true;
      for (const p of C.readModel.pending.values()) if (p.sid === sid && p.state === 'held') return true;
      return false;
    },
    listHotForSession(sid) {
      const ids = C.readModel.bySession.get(sid) || new Set();
      return [...ids].map((id) => C.readModel.records.get(id)).filter(Boolean).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    },
    retainedPending(sid) { return [...C.readModel.pending.values()].filter((p) => p.sid === sid); },
    identityOf(id) { return C.readModel.identities.get(id) || null; },
    actionCount() { return C.readModel.actions.size; },
    interactionsView() { return { actions: Object.fromEntries(C.readModel.actions), pending: Object.fromEntries(C.readModel.pending) }; },
    size() { return C.readModel.records.size; },
  };

  // ---- status / close ------------------------------------------------------------------------------------
  function status() {
    const acct = accounting.status();
    return { store: C.state, reason: C.reason, detail: C.reasonDetail, epoch: C.epoch, healthy: isHealthy(), lock: { path: lockPath, held: C.lockHeld, pid: C.pid, contents: C.lockInfo && C.lockInfo.contents ? C.lockInfo.contents : null },
      counts: C.counts, resident: C.resident, recovery: C.recovery, read_model: { records: C.readModel.records.size, actions: C.readModel.actions.size, pending: C.readModel.pending.size },
      inflight: C.inflight.size, accounting: acct, over_cap: acct.admitted_jobs > F.R_MAX_JOBS, unresolved: [...C.unresolved.entries()].slice(0, 64).map(([txn, u]) => ({ txn, ...u })), unresolved_count: C.unresolved.size,
      resolved_count: C.resolved.size, last_indeterminate: C.lastIndeterminate, respawns: C.respawns.length, dir, legacyPath };
  }
  function close(deadlineMs = 2000) {
    if (C.closing && C.closePromise) return C.closePromise;
    C.closing = true;
    C.closePromise = (async () => {
      let closed = null;
      if (C.worker) {
        closed = await new Promise((resolve) => {
          let timer = null;
          C.closedResolve = (m) => { if (timer) clearTimer(timer); resolve(m); };
          timer = setTimer(() => { C.closedResolve = null; resolve(null); }, deadlineMs);
          postToOwner({ type: 'close', deadline_ms: deadlineMs });
        });
        const worker = C.worker; C.worker = null; C.workerGen++;
        for (const [txn, inflight] of C.inflight) resolveIndeterminate(txn, inflight, 'shutting_down');
        for (const [, read] of C.reads) read.resolve({ items: [], reason: 'shutting_down' });
        C.reads.clear();
        try { await worker.terminate(); } catch { /* already gone */ }
      }
      C.state = 'closed'; C.pendingAvailable = false;
      const released = releaseLock();
      notify('closed');
      return { closed: closed || { clean: false, unresolved: C.unresolved.size, deadline: true }, lock: released };
    })();
    return C.closePromise;
  }

  return { acquireLock, releaseLock, open, submit, reserveJob, releaseJob, ensureHot, fetchTrackedInjection, listForSession, live, resolve: sendResolve, exportV3, compact, ownerStatus, status, close,
    onStateChange, readModel, isHealthy, isAvailable, get state() { return C.state; }, get reason() { return C.reason; }, get lockPath() { return lockPath; }, get dir() { return dir; }, accounting, _internal: C };
}

module.exports = { createLedgerClient, DEFAULT_RESOURCE_LIMITS, DEFAULT_RESPAWN };
