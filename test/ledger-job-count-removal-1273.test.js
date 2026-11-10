'use strict';

// Task 1273 — the persistent tracked-job COUNT is not an admission prerequisite. Normal identified
// (`from`-tracked) injects continue past 512 / 576 / 1024 to ONE live destination with durable
// correlation, a bounded hot set and honest refusals for genuine resource / integrity failures.
//
// The real inject handler (registerInjectRoute), the real delivery runtime, the real ledger client
// and the real owner worker on a private HOME; the delivery boundary is a recorder. No daemon,
// listener, socket or PTY. Owner-level cases drive the owner in-process (test/fixtures harness).
// No manual retire / untrack / compact is used anywhere to make room.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const persistence = require('../src/session-store/persistence');
const F = require('../src/session-store/ledger-format');
const H = require('./fixtures/ledger-1207/control-harness');
const { createOwnerHarness, readFrames, segmentFiles, tmpStore } = require('./fixtures/ledger-1207/owner-harness');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function makeSession(id) {
  const t = new Date().toISOString();
  return { id, type: 'wrapped', ptyProcess: null, ownerWs: null, command: 'synthetic-cli', cwd: '/synthetic', backend: 'cmux',
    cmuxWorkspaceId: null, cmuxSurfaceId: null, termProgram: null, term: null, createdAt: t, lastActivityAt: t, lastConnectedAt: null,
    lastDisconnectedAt: null, lastStateReportAt: null, stateReport: null, idleTtl: null, idleTtlMs: null, ownerPid: null, ptyPid: null,
    clients: new Set(), isClosing: false, outputRing: [], outputRingTotalBytes: 0, ready: true };
}
function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-1273-'));
  const parent = path.join(home, '.config', 'aigentry-telepty'); fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  return { home, parent, dir: path.join(parent, 'tracked-injections.json'), lockPath: path.join(parent, 'tracked-injections.lock'), rm: () => fs.rmSync(home, { recursive: true, force: true }) };
}

// daemon.js-shaped shared state + the real runtime + the real actions, on a real ledger client: the existing shared
// ledger fixture (test/fixtures/ledger-1207/control-harness.js buildShared, unchanged) builds the wiring; this file only
// sets the recorders its assertions read. The runtime and actions read these fields at call time.
function buildShared(store, R, { live = ['w1'], clientOptions = {}, extraSessions = [] } = {}) {
  const built = H.buildShared(store, R, { clientOptions: { log: () => {}, ...clientOptions } });
  const { shared, runtime, actions, ledgerClient } = built;
  store.clients.push(ledgerClient);
  for (const sid of live) ledgerClient.live(sid, true);   // the daemon marks a registered session live (daemon.js ledgerClient.live)
  shared.sessions.w2 = makeSession('w2');
  // sessions present when the ledger opens are live by the production restore path (delivery-runtime
  // open liveSids = the known sessions); a session added later gets NO live hint unless a test sends one
  for (const id of extraSessions) shared.sessions[id] = makeSession(id);
  const busClient = { readyState: 1, send(serialized) { const m = JSON.parse(serialized); R.bus.push({ type: m.type, tracking_result: m.tracking_result || null, inject_id: m.inject_id || null, content_sha256: m.content_sha256 || null }); } };
  shared.busClients.splice(0, shared.busClients.length, busClient);
  // RECORDED EXTERNAL BOUNDARY. The committed-only read model holds the record ONLY after the owner's
  // fsynced commit ACK, so `durable` at this instant proves durable-before-delivery for every call.
  shared.deliverInjectionToSession = async (id, session, prompt, options) => {
    const injectId = (options && options.injectId) || null;
    const rec = injectId ? ledgerClient.readModel.getTrackedInjection(injectId) : null;
    R.delivery.push({ id, injectId, bodySha: sha(prompt), durable: !!(rec && rec.tracking_state === 'tracked' && rec.session_id === id) });
    return { success: true, strategy: 'recorder_delivery', submit: 'recorder' };
  };
  return { shared, runtime, actions, handler: built.injectHandler, ledgerClient };
}
const recorders = () => ({ audit: [], delivery: [], bus: [], unexpected: [] });
const makeReq = (id, prompt, from = 'orch') => ({ params: { id }, body: from === null ? { prompt } : { prompt, from }, headers: {} });   // null = no `from`
function makeRes() { const r = { statusCode: 200, body: null, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; } }; return r; }
async function inject(handler, id, prompt, from = 'orch') { const res = makeRes(); await handler(makeReq(id, prompt, from), res); return res; }

async function closeBounded(ledgerClient, ms = 2000) {
  let timer = null;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), ms + 500); });
  try { return await Promise.race([ledgerClient.close(ms), deadline]); } finally {
    clearTimeout(timer);
    const w = ledgerClient._internal && ledgerClient._internal.worker;
    if (w) { try { await w.terminate(); } catch { /* already gone */ } }
  }
}
async function withStore(fn) {
  const s = tmpHome(); s.clients = [];
  let failed = true;
  try { const r = await fn(s); failed = false; return r; } finally {
    for (const c of s.clients) { try { await closeBounded(c, 2000); } catch { /* reported by the body */ } }
    if (failed) console.log(`[ledger-1273] FAILED — private HOME preserved for diagnosis: ${s.home}`); else s.rm();
  }
}
function dirBytes(root) {
  let total = 0;
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) total += fs.statSync(p).size; } })(root);
  return total;
}
// The bus correlation basis: inject_written.content_sha256 keyed by inject_id == sha256 of the body the
// transport received for that inject_id (independent of the test's own prompt bookkeeping).
function assertBusCorrelation(R) {
  const written = new Map(R.bus.filter((b) => b.type === 'inject_written' && b.inject_id).map((b) => [b.inject_id, b.content_sha256]));
  let n = 0;
  for (const d of R.delivery) if (d.injectId) { assert.equal(written.get(d.injectId), d.bodySha, `bus inject_written.content_sha256 == transport body sha256 for ${d.injectId}`); n++; }
  return n;
}
function beginOnDisk(dir, injectId) {
  const frames = segmentFiles(dir).flatMap((f) => readFrames(f).frames.map((x) => x.obj));
  const b = frames.find((x) => x.t === 'begin' && x.id === injectId);
  return !!(b && frames.some((x) => x.t === 'commit' && x.epoch === b.epoch && x.seq_from <= b.seq && b.seq <= x.seq_to));
}

// ---------------------------------------------------------------------------------------------------
// T1 — the RED gate. On the exact baseline the 513th identified inject is refused by the persistent
// job count (503 TRACKING_CAPACITY tracking_capacity_exhausted) with the store healthy and nothing in
// flight. The contract: it is admitted, durable before delivery, delivered once.
// ---------------------------------------------------------------------------------------------------
test('1273 T1: the 513th identified tracked inject to ONE live destination is admitted (200), durable before delivery — the persistent job count is not an admission prerequisite', () => withStore(async (s) => {
  const R = recorders();
  const { shared, runtime, handler, ledgerClient } = buildShared(s, R);
  assert.equal((await runtime.restoreTrackedInjections()).ok, true);
  let res = null;
  for (let i = 1; i <= 513; i++) {
    res = await inject(handler, 'w1', `synthetic task ${i}`);
    assert.equal(res.statusCode, 200, `inject #${i}: ${res.statusCode} ${JSON.stringify(res.body)} healthy=${shared.trackedLedgerHealthy} inflight=${ledgerClient._internal.inflight.size} admitted_jobs=${ledgerClient.accounting.status().admitted_jobs}`);
  }
  assert.equal(R.delivery.length, 513);
  assert.ok(R.delivery.every((d) => d.durable), 'every delivery happened after its begin was ACKed durable');
  assert.equal(R.delivery[512].injectId, res.body.inject_id);
  assert.equal(beginOnDisk(s.dir, res.body.inject_id), true, 'the 513th begin is commit-framed on disk');
  assert.equal(shared.pendingReports.w1.injectId, res.body.inject_id, 'durable correlation: the pending report names the 513th inject');
  assert.deepEqual(R.unexpected, []);
}));

// ---------------------------------------------------------------------------------------------------
// T2 + T3 + T4 — 1536 injects to the same live destination (crosses 512 / 576 / 1024), then restart:
// first / middle / last keep identity, state and cursors; an older COLD record is updated; a cold
// TRACKED record of a non-live session reaches a terminal outcome; idempotent re-begin; no replay.
// ---------------------------------------------------------------------------------------------------
test('1273 T2-T4: 1536 identified injects to the SAME live destination all succeed on a healthy, byte-bounded ledger with a bounded hot set; after restart first/middle/last persist, a cold record is updated, terminal outcomes still commit, re-begin is idempotent, nothing is replayed', () => withStore(async (s) => {
  const N = 1536;
  const R = recorders();
  let { shared, runtime, handler, ledgerClient } = buildShared(s, R);
  assert.equal((await runtime.restoreTrackedInjections()).ok, true);
  // restore marks every known session live (delivery-runtime open liveSids); w2 then goes away the way
  // the daemon reports a removed session (ledgerClient.live(id, false)). Its one tracked inject stays
  // `tracked` (never superseded) and becomes demotion-eligible — the cold TRACKED record used by T4.
  ledgerClient.live('w2', false);
  const w2 = await inject(handler, 'w2', 'synthetic task for w2');
  assert.equal(w2.statusCode, 200);
  const ids = []; const bodies = new Map();
  const t0 = Date.now();
  for (let i = 1; i <= N; i++) {
    const prompt = `synthetic task ${i}`;
    const res = await inject(handler, 'w1', prompt);
    assert.equal(res.statusCode, 200, `inject #${i}: ${JSON.stringify(res.body)}`);
    ids.push(res.body.inject_id); bodies.set(res.body.inject_id, sha(prompt));
  }
  const elapsedMs = Date.now() - t0;
  assert.equal(R.delivery.length, N + 1, 'exactly one delivery per admitted inject');
  assert.ok(R.delivery.every((d) => d.durable), 'durable before delivery, every time');
  assert.equal(new Set(R.delivery.map((d) => d.injectId)).size, N + 1, 'no inject delivered twice');
  for (const d of R.delivery.slice(1)) assert.equal(d.bodySha, bodies.get(d.injectId), 'each delivery carries the body its inject_id names');
  assert.equal(assertBusCorrelation(R), N + 1, 'every delivery is correlated by the bus inject_written content hash');
  for (const k of [0, 511, 512, 575, 576, 1023, 1024, N - 1]) assert.equal(beginOnDisk(s.dir, ids[k]), true, `begin #${k + 1} durable on disk`);

  const client = ledgerClient.status();
  const owner = await ledgerClient.ownerStatus();
  assert.equal(shared.trackedLedgerHealthy, true); assert.equal(client.store, 'available'); assert.equal(owner.store, 'available');
  assert.equal(owner.counts.hot + owner.counts.cold, N + 1, 'every record is retained (hot + cold), none evicted');
  // one live destination: its superseded history is terminal, so relief keeps the hot set at the soft
  // target (a raised or renamed count cap would leave ~N records hot and fail here)
  assert.equal(owner.resident.soft_target_records, F.HOT_MAX_RECORDS); assert.equal('max_records' in owner.resident, false, 'the record count is not named a maximum');
  assert.ok(owner.resident.records <= owner.resident.soft_target_records, `hot set relieved to the soft target: ${owner.resident.records} <= ${owner.resident.soft_target_records}`);
  assert.ok(owner.resident.records <= 576, `literal contract bound (anti raised/renamed cap): ${owner.resident.records} <= 576`);
  assert.ok(owner.resident.bytes < owner.resident.max_bytes, 'hot encoded bytes below the byte bound');
  assert.ok(owner.cold_index_bytes < F.COLD_INDEX_MAX_BYTES, 'cold index below its byte bound');
  assert.ok(owner.checkpoint.n >= 2, 'residency was relieved by the existing checkpoint/demotion path');
  const acct = client.accounting;
  assert.ok(acct.admitted_jobs <= owner.resident.records, `job reservations bounded by unresolved hot records (${acct.admitted_jobs}), not by history (${N + 1})`);
  assert.equal(acct.job_count_limit, null, 'status names NO job-count limit');
  assert.equal('r_max' in acct, false); assert.equal('over_cap' in client, false);
  assert.equal(ledgerClient._internal.inflight.size, 0); assert.equal(client.unresolved_count, 0);
  const storeBytes = dirBytes(s.dir);
  console.log(`[ledger-1273] injects=${N + 1} elapsedMs=${elapsedMs} hot=${owner.counts.hot} cold=${owner.counts.cold} checkpoints=${owner.checkpoint.n} admitted_jobs=${acct.admitted_jobs} storeBytes=${storeBytes} hotBytes=${owner.resident.bytes} coldIndexBytes=${owner.cold_index_bytes} (reported)`);

  // first / middle / last before restart
  const pick = { first: ids[0], middle: ids[767], last: ids[N - 1] };
  const before = {};
  for (const [k, id] of Object.entries(pick)) before[k] = await ledgerClient.fetchTrackedInjection(id);
  assert.equal(before.first.tier, 'cold'); assert.equal(before.first.record.tracking_state, 'superseded');
  assert.equal(before.middle.tier, 'cold'); assert.equal(before.middle.record.tracking_state, 'superseded');
  assert.equal(before.last.tier, 'hot'); assert.equal(before.last.record.tracking_state, 'tracked');
  const w2Before = await ledgerClient.fetchTrackedInjection(w2.body.inject_id);
  // #1273 correction (review559 F2). Before (de92b71): routine hot-pressure relief demoted this tracked
  // record of a non-live session ('cold'). After: routine relief demotes TERMINAL records only, so it
  // stays hot until the existing close/threshold/manual checkpoint (demotionEligible, unchanged).
  assert.equal(w2Before.tier, 'hot'); assert.equal(w2Before.record.tracking_state, 'tracked', 'non-live tracked record kept hot by routine relief');

  // restart (a fresh client + runtime on the same store; the live destination registers again)
  const closed = await ledgerClient.close(2000);
  assert.equal(closed.lock.released, true);
  const R2 = recorders();
  ({ shared, runtime, handler, ledgerClient } = buildShared(s, R2));
  assert.equal((await runtime.restoreTrackedInjections()).ok, true);
  for (const [k, id] of Object.entries(pick)) {
    const after = await ledgerClient.fetchTrackedInjection(id);
    const b = before[k].record; const a = after.record;
    assert.ok(a, `${k} readable after restart`);
    for (const f of ['inject_id', 'session_id', 'created_at', 'tracking_state', 'transport_source']) assert.deepEqual(a[f], b[f], `${k}.${f} persists`);
    assert.deepEqual(a.observations.slice(0, b.observations.length), b.observations, `${k}: stored observations persist byte-for-byte`);
    assert.equal(a.observation_seq, b.observation_seq + 1, `${k}: cursor = stored + the restart fact overlay`);
  }
  // update an older COLD record after restart/compaction: reheat by a write, cursor continues
  const parked = await runtime.parkTrackedInjection(pick.first, 'synthetic_strategy', 'synthetic_reason');
  assert.equal(parked, 'tracking_parked');
  const firstAfter = await ledgerClient.fetchTrackedInjection(pick.first);
  assert.equal(firstAfter.tier, 'hot'); assert.equal(firstAfter.record.inject_id, pick.first); assert.equal(firstAfter.record.tracking_state, 'superseded');
  assert.equal(firstAfter.record.observation_seq, before.first.record.observation_seq + 2);
  assert.equal(firstAfter.record.last_observation.kind, 'inject_parked');
  // idempotent re-begin: an existing id is never a second delivery authorization
  const again = await runtime.beginTrackedInjection({ injectId: pick.first, sessionId: 'w1', source: 'orch', session: shared.sessions.w1 });
  assert.equal(again.ok, false); assert.equal(again.reason, 'already_exists');
  // future terminal outcomes beyond 512: the current record, and a cold TRACKED record of a non-live session
  assert.equal(await runtime.abortTrackedInjection(pick.last, 'w1', 'DELIVERY_FAILED', 'synthetic'), 'tracking_aborted');
  // a second terminal for the same id has no terminal unit left (released at the first terminal ACK, as
  // on the baseline): a named failure, never a second terminal and never a fake success.
  assert.equal(await runtime.abortTrackedInjection(pick.last, 'w1', 'DELIVERY_FAILED', 'synthetic'), 'tracking_persistence_failed');
  const lastRec = ledgerClient.readModel.getTrackedInjection(pick.last);
  assert.equal(lastRec.tracking_state, 'aborted');
  assert.equal(lastRec.observations.filter((o) => o.kind === 'inject_delivery_refused').length, 1, 'one terminal observation');
  // the close checkpoint (unchanged demotionEligible) demoted w2's non-live tracked record before restart
  assert.equal((await ledgerClient.fetchTrackedInjection(w2.body.inject_id)).tier, 'cold', 'close checkpoint demoted the non-live tracked record');
  assert.equal(await runtime.abortTrackedInjection(w2.body.inject_id, 'w2', 'DELIVERY_FAILED', 'synthetic'), 'tracking_aborted');
  assert.equal((await ledgerClient.fetchTrackedInjection(w2.body.inject_id)).record.tracking_state, 'aborted');
  // more injects after restart keep flowing
  const post = await inject(handler, 'w1', 'synthetic task after restart');
  assert.equal(post.statusCode, 200);
  assert.deepEqual(R2.delivery.map((d) => d.injectId), [post.body.inject_id], 'no replay of any earlier body across restart');
  assert.deepEqual([...R.unexpected, ...R2.unexpected], []);
}));

// ---------------------------------------------------------------------------------------------------
// T5 — bounded hot cache and honest refusals, owner in-process (small hotMaxRecords).
// ---------------------------------------------------------------------------------------------------
const nowIso = () => new Date().toISOString();
function beginRecord(id, sid) {
  const at = nowIso();
  const record = { inject_id: id, session_id: sid, session_epoch: null, session_epoch_reason: 'no_815_epoch_fact', transport_source: 'orch', created_at: at,
    observation_seq: 0, observations: [], last_observation: null, capability: { stage: 'A' }, tracking_state: 'tracked' };
  persistence.appendLedgerObservation(record, { kind: 'tracking_started', trigger: 'inject_accepted' }, at);
  return record;
}
const ownerBegin = (h, id, sid) => h.submit('begin', { id, sid, record: beginRecord(id, sid), at: nowIso() }, { cls: 'T' });
async function withOwnerStore(fn) {
  const s = tmpStore('telepty-1273-owner-'); const hs = [];
  let failed = true;
  try { await fn(s, hs); failed = false; } finally {
    for (const h of hs) { try { await h.close(); } catch { /* reported */ } try { h.release(); } catch { /* reported */ } }
    if (failed) console.log(`[ledger-1273] FAILED — store preserved: ${s.home}`); else s.rm();
  }
}

// #1273 correction (review559 F1/F2/F3) — before/after contract of T5a. Before (de92b71): with every
// resident the current tracked inject of a LIVE session, a begin past hotMaxRecords was refused
// `hot_capacity` (a persistent count gate), and a superseding begin as well. After: hotMaxRecords is a
// SOFT residency target — such begins are admitted; routine relief demotes only TERMINAL records and only
// a batch of at least 64 of them; the hard resident bound is the hot BYTE budget (T5d).
test('1273 T5a: the hot RECORD count is a soft target — with every resident a LIVE session\'s current tracked inject, new and self-superseding begins are admitted past it; terminal records are relieved in one batch, tracked records never by routine relief', () => withOwnerStore(async (s, hs) => {
  const h = createOwnerHarness({ dir: s.dir, hotMaxRecords: 3 }); hs.push(h);
  assert.equal(h.open(['w1', 'w2', 'w3', 'w4']).state, 'available');
  for (const [id, sid] of [['a', 'w1'], ['b', 'w2'], ['c', 'w3']]) assert.equal((await ownerBegin(h, id, sid)).type, 'ack');
  const n0 = h.read('status').items[0].checkpoint.n;
  const past = await ownerBegin(h, 'd', 'w4');
  assert.equal(past.type, 'ack', `admitted past the soft target: ${JSON.stringify(past)}`);
  const self = await ownerBegin(h, 'a2', 'w1');
  assert.equal(self.type, 'ack', `a self-superseding begin is admitted: ${JSON.stringify(self)}`);
  assert.equal(h.read('get', { id: 'a' }).items[0].tracking_state, 'superseded');
  assert.equal(h.read('get', { id: 'a' }).tier, 'hot', 'one terminal record is not a relief batch: no checkpoint');
  assert.equal(h.read('status').items[0].checkpoint.n, n0);
  // 70 more supersessions on w1: the terminal records reach one batch and are demoted together
  for (let i = 3; i <= 72; i++) assert.equal((await ownerBegin(h, `a${i}`, 'w1')).type, 'ack', `a${i}`);
  const demoted = h.ofType('demoted').flatMap((m) => m.ids);
  const reliefs = h.ofType('progress').filter((m) => m.reason === 'hot_pressure');
  assert.equal(reliefs.length, 1, `one relief for 70 supersessions: ${JSON.stringify(reliefs)}`);
  assert.ok(reliefs[0].demoted >= 64, `the relief demoted a batch: ${reliefs[0].demoted}`);
  assert.ok(demoted.includes('a'));
  for (const id of demoted) { const r = h.read('get', { id }); assert.equal(r.tier, 'cold'); assert.equal(r.items[0].tracking_state, 'superseded', `${id}: only terminal records are demoted by routine relief`); }
  for (const [id, sid] of [['b', 'w2'], ['c', 'w3'], ['d', 'w4'], ['a72', 'w1']]) { const r = h.read('get', { id }); assert.equal(r.tier, 'hot', `${id} stays hot`); assert.equal(r.items[0].tracking_state, 'tracked'); assert.equal(r.items[0].session_id, sid); }
  const st = h.read('status').items[0];
  assert.equal(st.store, 'available'); assert.equal(st.resident.soft_target_records, 3); assert.ok(st.resident.records > 3, 'residents beyond the soft target are admitted, not refused');
  assert.equal(h.ofType('nack').length, 0, 'no begin was refused');
}));

test('1273 T5b: a checkpoint failure BEFORE any in-memory change (cold file create) while relieving is an honest error (hot_demotion_failed + errno), never an ACK; the store stays available, nothing moved, and the next begin relieves once the fault clears', () => withOwnerStore(async (s, hs) => {
  let failCold = false;
  const faulty = Object.create(fs);
  faulty.openSync = (p, flags, ...rest) => {
    if (failCold && typeof p === 'string' && p.includes(`${path.sep}cold${path.sep}`) && flags === 'wx') { const e = new Error('synthetic EIO'); e.code = 'EIO'; throw e; }
    return fs.openSync(p, flags, ...rest);
  };
  const h = createOwnerHarness({ dir: s.dir, hotMaxRecords: 67, fsImpl: faulty }); hs.push(h);
  assert.equal(h.open([]).state, 'available');   // no live hints at all: tracked records must still never be relieved
  assert.equal((await ownerBegin(h, 'y', 's2')).type, 'ack');
  for (let i = 1; i <= 66; i++) assert.equal((await ownerBegin(h, `x${i}`, 's1')).type, 'ack', `x${i}`);
  failCold = true;
  const refused = await ownerBegin(h, 'x67', 's1');
  assert.equal(refused.type, 'nack'); assert.equal(refused.reason, 'hot_demotion_failed'); assert.equal(refused.code, 'EIO');
  assert.equal(h.read('get', { id: 'x67' }).items.length, 0, 'nothing persisted for the refused begin');
  assert.equal(h.read('get', { id: 'x1' }).tier, 'hot', 'no record left the hot set on a failed checkpoint');
  assert.equal(h.read('status').items[0].store, 'available', 'a pre-mutation failure leaves owner memory consistent: still serving');
  failCold = false;
  const ok = await ownerBegin(h, 'x67', 's1');
  assert.equal(ok.type, 'ack', JSON.stringify(ok));
  assert.equal(h.read('get', { id: 'x1' }).tier, 'cold');
  for (const id of ['y', 'x67']) { const r = h.read('get', { id }); assert.equal(r.tier, 'hot', `${id}: a tracked record (no live hint) is never demoted by routine relief`); assert.equal(r.items[0].tracking_state, 'tracked'); }
  assert.equal(h.read('status').items[0].store, 'available');
}));

test('1273 T5d: the hard resident bound is the hot BYTE budget — a begin that would exceed it with no relief batch is refused by name (hot_capacity, bound hot_bytes) and persists nothing', () => withOwnerStore(async (s, hs) => {
  const h = createOwnerHarness({ dir: s.dir, hotMaxBytes: 2048 }); hs.push(h);
  assert.equal(h.open(['z']).state, 'available');
  let refused = null; let admitted = 0;
  for (let i = 1; i <= 64 && !refused; i++) { const r = await ownerBegin(h, `z${i}`, `zs${i}`); if (r.type === 'ack') admitted++; else refused = { r, id: `z${i}` }; }
  assert.ok(refused, 'the byte budget bound was reached');
  assert.ok(admitted >= 1);
  assert.equal(refused.r.reason, 'hot_capacity'); assert.equal(refused.r.bound, 'hot_bytes', JSON.stringify(refused.r));
  assert.ok(refused.r.resident.bytes <= refused.r.resident.max_bytes);
  assert.equal(h.read('get', { id: refused.id }).items.length, 0, 'the refused begin persisted nothing');
  assert.equal(h.read('status').items[0].store, 'available');
}));

test('1273 T5c: genuine resource and availability refusals stay honest through the real handler (disk_full hint; unavailable store) — no delivery, no fake success', () => withStore(async (s) => {
  const R = recorders();
  const { runtime, handler, ledgerClient } = buildShared(s, R, { clientOptions: { freeSpaceHintBytes: Number.MAX_SAFE_INTEGER } });
  assert.equal((await runtime.restoreTrackedInjections()).ok, true);
  const res = await inject(handler, 'w1', 'synthetic');
  assert.equal(res.statusCode, 503); assert.equal(res.body.code, 'TRACKING_CAPACITY'); assert.equal(res.body.reason, 'disk_full');
  await ledgerClient.close(2000);
  const closed = await inject(handler, 'w1', 'synthetic');
  assert.ok([500, 503].includes(closed.statusCode)); assert.equal(closed.body.tracking_state, 'unavailable');
  assert.equal(R.delivery.length, 0, 'no task bytes delivered on any refusal');
}));

// ---------------------------------------------------------------------------------------------------
// T6 — no identity bypass: a reheated cold record still enforces the receipt identity predicate; an
// inject without `from` is not silently tracked (and a tracked one is never silently untracked).
// ---------------------------------------------------------------------------------------------------
test('1273 T6: beyond 512, identity checks stay: a bridge receipt for a reheated cold record with the wrong session or owner generation is refused; an inject without `from` stays untracked', () => withStore(async (s) => {
  const R = recorders();
  const { shared, runtime, handler, ledgerClient } = buildShared(s, R);
  assert.equal((await runtime.restoreTrackedInjections()).ok, true);
  const ids = [];
  for (let i = 0; i < 600; i++) { const r = await inject(handler, 'w1', `t${i}`); assert.equal(r.statusCode, 200, JSON.stringify(r.body)); ids.push(r.body.inject_id); }
  assert.equal((await ledgerClient.fetchTrackedInjection(ids[0])).tier, 'cold');
  const receipt = { inject_id: ids[0], stage: 'pty_written', part: 'body', certainty: 'observed', reason: null, daemon_msg_id: 'm', bridge_msg_id: 'b', bridge_seq: 1, at_ms: 1, clock: 'mono' };
  assert.equal(await runtime.recordBridgeReceipt('w2', shared.sessions.w2, receipt, undefined), 'receipt_identity_mismatch', 'wrong session');
  assert.equal(await runtime.recordBridgeReceipt('w1', shared.sessions.w1, receipt, 'gen-other'), 'receipt_identity_mismatch', 'wrong owner generation');
  const untracked = await inject(handler, 'w1', 'operator text', null);
  assert.equal(untracked.statusCode, 200, JSON.stringify(untracked.body));
  assert.equal(R.delivery[R.delivery.length - 1].injectId, null, 'untracked inject carries no tracked id');
  assert.equal(ledgerClient.readModel.getTrackedInjection(untracked.body.inject_id), null);
  assert.equal((await ledgerClient.fetchTrackedInjection(untracked.body.inject_id)).record, null);
}));

// ---------------------------------------------------------------------------------------------------
// T7 — concurrent mutations: waves of 128 concurrent identified injects over two live sessions (768
// in total, crossing 512 and 576), each wave with a concurrent result write on an older record. The
// in-flight frame pools (finite, released at each ACK) are the per-operation bound and are not the
// subject here; the persistent count of records is.
// ---------------------------------------------------------------------------------------------------
test('1273 T7: 6 waves of 128 CONCURRENT identified injects over two live destinations (768 > 512/576), interleaved with result writes on an older record, all settle 200 exactly once on a healthy store', () => withStore(async (s) => {
  const R = recorders();
  const { shared, runtime, handler, ledgerClient } = buildShared(s, R, { live: ['w1', 'w2'] });
  assert.equal((await runtime.restoreTrackedInjections()).ok, true);
  const seed = await inject(handler, 'w1', 'seed'); assert.equal(seed.statusCode, 200);
  const out = [];
  for (let w = 0; w < 6; w++) {
    const jobs = [];
    for (let i = 0; i < 128; i++) jobs.push(inject(handler, i % 2 ? 'w2' : 'w1', `c${w}-${i}`));
    jobs.splice(64, 0, runtime.parkTrackedInjection(seed.body.inject_id, 'synthetic_strategy', `r${w}`));
    out.push(...await Promise.all(jobs));
  }
  const responses = out.filter((x) => x && typeof x === 'object');
  const parks = out.filter((x) => typeof x === 'string');
  assert.equal(responses.length, 768); assert.equal(parks.length, 6);
  for (const r of responses) assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  for (const p of parks) assert.equal(p, 'tracking_parked', 'a result write racing residency relief still lands');
  assert.equal(R.delivery.length, 769); assert.equal(new Set(R.delivery.map((d) => d.injectId)).size, 769);
  assert.ok(R.delivery.every((d) => d.durable));
  const owner = await ledgerClient.ownerStatus();
  assert.equal(owner.store, 'available');
  // per-tier counts include a reheated record in both its immutable cold file and the hot set, so the
  // retention check is per id: every delivered inject is readable with its own identity.
  for (const d of R.delivery) { const r = await ledgerClient.fetchTrackedInjection(d.injectId); assert.ok(r.record && r.record.inject_id === d.injectId && r.record.session_id === d.id, d.injectId); }
  // two live destinations: their superseded history is terminal, so relief keeps the hot set at the soft target
  assert.ok(owner.resident.records <= owner.resident.soft_target_records, `${owner.resident.records}`);
  assert.equal(shared.trackedLedgerHealthy, true);
  assert.equal(ledgerClient._internal.inflight.size, 0);
}));

// ---------------------------------------------------------------------------------------------------
// Accounting unit contract: no count gate in reserveJob; in-flight pools still bound concurrent frames.
// ---------------------------------------------------------------------------------------------------
test('1273 accounting: reserveJob has no job-count gate (2048 jobs reserve); per-frame in-flight budgets still bind and refuse without mutation; status names no job-count limit', () => {
  const a = F.createAccounting({ now: () => 1000 });
  for (let i = 0; i < 2048; i++) assert.equal(a.reserveJob(`j${i}`).ok, true, `job ${i + 1}`);
  assert.equal(a.status().admitted_jobs, 2048);
  assert.equal(a.status().job_count_limit, null); assert.equal('r_max' in a.status(), false);
  assert.equal('R_MAX_JOBS' in F, false, 'no exported job-count constant');
  // the T in-flight pool (concurrent terminal/begin frames) still binds per operation
  for (let i = 0; i < F.POOLS.T.entries; i++) assert.equal(a.admit('T', F.POOLS.T.unit, { jobId: `j${i}` }).ok, true);
  const before = JSON.stringify(a.status().inflight);
  const over = a.admit('T', F.POOLS.T.unit, { jobId: `j${F.POOLS.T.entries}` });
  assert.equal(over.ok, false); assert.equal(over.detail, 'pool');
  assert.equal(JSON.stringify(a.status().inflight), before, 'refusal mutates nothing');
  a.release('T', F.POOLS.T.unit, { jobId: 'j0', reserved: true });
  assert.equal(a.admit('T', F.POOLS.T.unit, { jobId: `j${F.POOLS.T.entries}` }).ok, true, 'a finished operation returns its in-flight unit');
  assert.ok(a.check().ok);
});

// ---------------------------------------------------------------------------------------------------
// T7b — the write/demotion race made deterministic: a record leaves the hot set (owner checkpoint) and
// a write for it arrives without a fresh ensureHot(). The owner nacks `record_cold` before persisting
// anything; the client reheats through ensureHot() and lands the SAME observation once.
// ---------------------------------------------------------------------------------------------------
test('1273 T7b: a write for a record demoted under it (owner nack record_cold, nothing persisted) is reheated and lands exactly once; a missing record stays an honest nack', () => withStore(async (s) => {
  const R = recorders();
  const { runtime, handler, ledgerClient } = buildShared(s, R);
  assert.equal((await runtime.restoreTrackedInjections()).ok, true);
  const a = await inject(handler, 'w1', 'a'); const b = await inject(handler, 'w1', 'b');
  assert.equal(a.statusCode, 200); assert.equal(b.statusCode, 200);
  const compacted = await ledgerClient.compact();
  assert.ok(compacted.demoted >= 1, JSON.stringify(compacted));
  assert.equal(ledgerClient.readModel.getTrackedInjection(a.body.inject_id), null, 'a (superseded) left the hot set');
  const before = (await ledgerClient.fetchTrackedInjection(a.body.inject_id)).record.observation_seq;
  const o = await ledgerClient.submit('obs', { id: a.body.inject_id, observation: { kind: 'bridge_receipt', trigger: 'pty_written:body', at: new Date().toISOString() } }, { jobId: a.body.inject_id });
  assert.equal(o.outcome, 'ack', JSON.stringify(o));
  const after = await ledgerClient.fetchTrackedInjection(a.body.inject_id);
  assert.equal(after.tier, 'hot'); assert.equal(after.record.observation_seq, before + 1, 'exactly one observation landed');
  assert.equal(after.record.observations.filter((x) => x.kind === 'bridge_receipt').length, 1);
  const missing = await ledgerClient.submit('obs', { id: 'no-such-inject', observation: { kind: 'bridge_receipt', trigger: 'x', at: new Date().toISOString() } }, { jobId: 'no-such-inject' });
  assert.equal(missing.outcome, 'nack'); assert.equal(missing.reason, 'record_missing');
}));

// ===================================================================================================
// #1273 correction (review559 F1–F4). Real inject handler / delivery runtime / ledger client / owner
// worker with the PRODUCTION constants (HOT_MAX_RECORDS 576, 64 MiB hot bytes); the transport and the
// bus are recorders. Owner-only fault cases drive the real owner in-process.
// ===================================================================================================
const RELIEF_MIN_BATCH = 64;   // the dispatch's minimum terminal batch (literal: the tests also run on de92b71)

test('1273 F1: more than 576 distinct LIVE destinations each hold a current tracked inject and identified injects are still admitted — a self-superseding begin and 1536 more injects to one live target — durable, correlated, hot bytes below the byte bound', () => withStore(async (s) => {
  const R = recorders();
  const D = Array.from({ length: 600 }, (_, i) => `d${i}`);
  const { shared, runtime, handler, ledgerClient } = buildShared(s, R, { extraSessions: D });
  assert.equal((await runtime.restoreTrackedInjections()).ok, true);
  const current = new Map();
  for (const [i, sid] of D.entries()) {
    const res = await inject(handler, sid, `synthetic task for ${sid}`);
    assert.equal(res.statusCode, 200, `distinct live destination #${i + 1} (${sid}): ${res.statusCode} ${JSON.stringify(res.body)} healthy=${shared.trackedLedgerHealthy}`);
    current.set(sid, res.body.inject_id);
  }
  let owner = await ledgerClient.ownerStatus();
  assert.ok(owner.resident.records >= D.length && D.length > F.HOT_MAX_RECORDS, `${owner.resident.records} live current records resident (> ${F.HOT_MAX_RECORDS})`);
  assert.ok(owner.resident.bytes < F.HOT_MAX_ENCODED_BYTES);
  for (const [sid, id] of current) { const r = ledgerClient.readModel.getTrackedInjection(id); assert.ok(r && r.tracking_state === 'tracked' && r.session_id === sid, `${sid}: current record hot and tracked`); }
  // a begin that supersedes the session's own record, with the hot set beyond the target
  const self = await inject(handler, 'd0', 'second task for d0');
  assert.equal(self.statusCode, 200, `self-superseding begin: ${JSON.stringify(self.body)}`);
  assert.equal((await ledgerClient.fetchTrackedInjection(current.get('d0'))).record.tracking_state, 'superseded');
  // continued admission to the same live target
  const burst = [];
  for (let i = 1; i <= 1536; i++) {
    const res = await inject(handler, 'd1', `burst ${i} for d1`);
    assert.equal(res.statusCode, 200, `burst #${i} to d1: ${res.statusCode} ${JSON.stringify(res.body)}`);
    burst.push(res.body.inject_id);
  }
  const total = D.length + 1 + 1536;
  assert.equal(R.delivery.length, total, 'exactly one delivery per admitted inject');
  assert.ok(R.delivery.every((d) => d.durable), 'durable before delivery, every time');
  assert.equal(new Set(R.delivery.map((d) => d.injectId)).size, total, 'no inject delivered twice');
  assert.equal(assertBusCorrelation(R), total);
  for (const id of [burst[0], burst[767], burst[1535]]) assert.equal(beginOnDisk(s.dir, id), true);
  owner = await ledgerClient.ownerStatus();
  assert.equal(owner.store, 'available'); assert.equal(shared.trackedLedgerHealthy, true);
  assert.ok(owner.resident.records > F.HOT_MAX_RECORDS, `the record count is a soft target: ${owner.resident.records} resident`);
  assert.ok(owner.resident.bytes < F.HOT_MAX_ENCODED_BYTES, 'hot bytes below the hard byte bound');
  for (const sid of D.slice(2)) { const r = ledgerClient.readModel.getTrackedInjection(current.get(sid)); assert.ok(r && r.tracking_state === 'tracked', `${sid}: a live session's current record is never demoted by relief`); }
  assert.equal(ledgerClient._internal.inflight.size, 0); assert.equal(ledgerClient.status().unresolved_count, 0);
  console.log(`[ledger-1273 F1] live_destinations=${D.length} injects=${total} hot_records=${owner.resident.records} soft_target=${F.HOT_MAX_RECORDS} hot_bytes=${owner.resident.bytes} max_bytes=${F.HOT_MAX_ENCODED_BYTES} cold=${owner.counts.cold} checkpoint_n=${owner.checkpoint.n} (reported)`);
  assert.deepEqual(R.unexpected, []);
}));

test('1273 F2: routine hot-pressure relief never demotes the CURRENT tracked record of a session registered without a live hint (register-route shape) — it stays hot for submit correlation and its next inject supersedes it', () => withStore(async (s) => {
  const R = recorders();
  const { shared, runtime, handler, ledgerClient } = buildShared(s, R);
  assert.equal((await runtime.restoreTrackedInjections()).ok, true);
  // added AFTER the ledger opened, as POST /api/sessions/register does: no ledgerClient.live() call
  shared.sessions.late = makeSession('late');
  const first = await inject(handler, 'late', 'task for a session registered without a live hint');
  assert.equal(first.statusCode, 200, JSON.stringify(first.body));
  const n0 = (await ledgerClient.ownerStatus()).checkpoint.n;
  for (let i = 1; i <= 700; i++) { const r = await inject(handler, 'w1', `pressure ${i}`); assert.equal(r.statusCode, 200, `pressure #${i}: ${JSON.stringify(r.body)}`); }
  const owner = await ledgerClient.ownerStatus();
  assert.ok(owner.checkpoint.n > n0, `hot-pressure relief ran (${n0} -> ${owner.checkpoint.n})`);
  const rec = runtime.getTrackedInjection(first.body.inject_id);   // the hot read model submitCorrelationId reads
  assert.ok(rec, 'the current record of the hint-less session is still in the hot read model after relief');
  assert.equal(rec.tracking_state, 'tracked'); assert.equal(rec.session_id, 'late');
  assert.equal((await ledgerClient.fetchTrackedInjection(first.body.inject_id)).tier, 'hot');
  const second = await inject(handler, 'late', 'second task for the same session');
  assert.equal(second.statusCode, 200, JSON.stringify(second.body));
  assert.equal((await ledgerClient.fetchTrackedInjection(first.body.inject_id)).record.tracking_state, 'superseded', 'the next inject supersedes it (supersession reads the hot tier)');
  assert.equal(runtime.getTrackedInjection(second.body.inject_id).tracking_state, 'tracked');
  assertBusCorrelation(R);
  assert.deepEqual(R.unexpected, []);
}));

function storeInventory(dir) {
  const count = (sub) => { try { return fs.readdirSync(path.join(dir, sub)).length; } catch { return 0; } };
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8'));
  return { hot: count('hot'), cold: count('cold'), facts: count('facts'), files: count('hot') + count('cold') + count('facts'), manifest_bytes: fs.statSync(path.join(dir, 'MANIFEST.json')).size, manifest_cold: (m.cold || []).length, last_checkpoint: m.last_checkpoint || null };
}

test('1273 F3: near the soft target (575 live current records) 1536 same-live injects are relieved in batches of >= 64 terminal records, never a checkpoint per begin; checkpoint / file / MANIFEST growth is measured per event', () => withStore(async (s) => {
  const R = recorders();
  const D = Array.from({ length: 574 }, (_, i) => `n${i}`);
  const { runtime, handler, ledgerClient } = buildShared(s, R, { extraSessions: D });
  assert.equal((await runtime.restoreTrackedInjections()).ok, true);
  for (const sid of [...D, 'w1']) { const r = await inject(handler, sid, `seed ${sid}`); assert.equal(r.statusCode, 200, `${sid}: ${JSON.stringify(r.body)}`); }
  const st0 = await ledgerClient.ownerStatus();
  assert.equal(st0.resident.records, 575, 'near-saturated live set');
  const n0 = st0.checkpoint.n; const inv0 = storeInventory(s.dir); const io0 = st0.io;
  const EVENTS = 1536; let maxHot = 0; let lastN = n0; const reliefs = [];
  for (let i = 1; i <= EVENTS; i++) {
    const r = await inject(handler, 'w1', `burst ${i}`);
    assert.equal(r.statusCode, 200, `burst #${i}: ${JSON.stringify(r.body)}`);
    const st = await ledgerClient.ownerStatus();
    maxHot = Math.max(maxHot, st.resident.records);
    const checkpoints = st.checkpoint.n - n0;
    assert.ok(checkpoints <= Math.ceil(i / RELIEF_MIN_BATCH), `relief checkpoints bounded by batches: ${checkpoints} checkpoints after ${i} events (bound ${Math.ceil(i / RELIEF_MIN_BATCH)})`);
    if (st.checkpoint.n !== lastN) {
      const lc = storeInventory(s.dir).last_checkpoint;
      reliefs.push({ at_event: i, n: lc && lc.n, reason: lc && lc.reason, demoted: lc && lc.demoted });
      assert.equal(lc.reason, 'hot_pressure'); assert.ok(lc.demoted >= RELIEF_MIN_BATCH, `relief demoted a batch: ${JSON.stringify(lc)}`);
      lastN = st.checkpoint.n;
    }
  }
  const st1 = await ledgerClient.ownerStatus(); const inv1 = storeInventory(s.dir);
  assert.equal(st1.store, 'available');
  assert.ok(st1.resident.bytes < F.HOT_MAX_ENCODED_BYTES);
  assert.ok(reliefs.length >= 1 && reliefs.length <= Math.ceil(EVENTS / RELIEF_MIN_BATCH), `${reliefs.length} reliefs for ${EVENTS} events`);
  assert.equal(inv1.files - inv0.files, reliefs.length * 7, 'each relief adds exactly one checkpoint generation (4 hot/facts files) + one cold generation (3 files)');
  assert.equal(inv1.manifest_cold - inv0.manifest_cold, reliefs.length, 'MANIFEST cold[] grows by one entry per relief, not per event');
  for (const sid of D) { const id = (await ledgerClient.listForSession(sid))[0].inject_id; assert.equal(ledgerClient.readModel.getTrackedInjection(id).tracking_state, 'tracked', `${sid} current record hot`); }
  const measured = { events: EVENTS, live_records: 575, reliefs: reliefs.length, events_per_relief: +(EVENTS / reliefs.length).toFixed(1), max_hot_records: maxHot, files_added: inv1.files - inv0.files, files_per_event: +((inv1.files - inv0.files) / EVENTS).toFixed(4), manifest_bytes: [inv0.manifest_bytes, inv1.manifest_bytes], manifest_cold_entries: [inv0.manifest_cold, inv1.manifest_cold], fsyncs_per_event: +((st1.io.fsyncs - io0.fsyncs) / EVENTS).toFixed(2), bytes_written_per_event: Math.round((st1.io.bytes - io0.bytes) / EVENTS), store_bytes: dirBytes(s.dir), relief_events: reliefs.map((x) => `${x.at_event}:${x.demoted}`).join(',') };
  console.log(`[ledger-1273 F3] ${JSON.stringify(measured)} (reported)`);
  assert.deepEqual(R.unexpected, []);
}));

test('1273 F4: a MANIFEST failure AFTER the relief checkpoint changed owner memory fails the store CLOSED (unavailable_write + errno, published before the nack, before any further write); restart recovers the previous MANIFEST with every record, preserves the orphans and replays nothing', () => withOwnerStore(async (s, hs) => {
  let armed = false; const fired = [];
  const faulty = Object.create(fs);
  faulty.renameSync = (from, to) => {
    if (armed && String(to) === path.join(s.dir, 'MANIFEST.json')) { fired.push(String(from)); const e = new Error('synthetic EIO'); e.code = 'EIO'; throw e; }
    return fs.renameSync(from, to);
  };
  const h = createOwnerHarness({ dir: s.dir, hotMaxRecords: 70, fsImpl: faulty }); hs.push(h);
  assert.equal(h.open(['w']).state, 'available');
  for (let i = 1; i <= 70; i++) assert.equal((await ownerBegin(h, `p${i}`, 'w')).type, 'ack', `p${i}`);
  const manifestBefore = fs.readFileSync(path.join(s.dir, 'MANIFEST.json'));
  const prev = JSON.parse(manifestBefore.toString('utf8'));
  const segBytes = () => segmentFiles(s.dir).reduce((n, f) => n + fs.statSync(f).size, 0);
  armed = true;
  const relief = await ownerBegin(h, 'p71', 'w');   // 71 > 70 with 69 terminal residents: relief checkpoint
  armed = false;
  assert.equal(fired.length, 1, 'positive hook witness: the relief checkpoint reached the MANIFEST rename (after its in-memory changes)');
  assert.equal(relief.type, 'nack'); assert.equal(relief.reason, 'hot_demotion_failed'); assert.equal(relief.code, 'EIO');
  const closedState = h.ofType('state').find((m) => m.store === 'unavailable_write');
  assert.ok(closedState, `the owner failed closed: ${JSON.stringify(h.ofType('state').map((m) => [m.store, m.reason]))}`);
  assert.ok(closedState._seq < relief._seq, 'unavailable_write is published BEFORE the nack');
  assert.match(String(closedState.reason), /EIO/); assert.equal(closedState.code, 'EIO');
  assert.equal(h.read('status').items[0].store, 'unavailable_write');
  assert.ok(fs.readFileSync(path.join(s.dir, 'MANIFEST.json')).equals(manifestBefore), 'the previous MANIFEST is still the published one');
  const seg0 = segBytes();
  const next = await ownerBegin(h, 'p72', 'w');
  assert.equal(next.type, 'nack'); assert.equal(next.reason, 'unavailable_write');
  const o = await h.submit('obs', { id: 'p70', observation: { kind: 'output_observed', trigger: 'after_fault', at: nowIso() } });
  assert.equal(o.type, 'nack'); assert.equal(o.reason, 'unavailable_write');
  assert.equal(segBytes(), seg0, 'no write was accepted from the diverged state');
  // orphans of the unpublished checkpoint (+ the MANIFEST temporary) are left in place
  const orphanTmp = fs.readdirSync(s.dir).filter((n) => n.startsWith('MANIFEST.json.') && n.endsWith('.tmp'));
  assert.equal(orphanTmp.length, 1);
  const orphanManifest = JSON.parse(fs.readFileSync(path.join(s.dir, orphanTmp[0]), 'utf8'));
  const orphanFiles = [orphanTmp[0], `hot/${orphanManifest.hot.n}.jsonl`, `hot/${orphanManifest.hot.n}.receipts.jsonl`, `facts/${orphanManifest.hot.n}.jsonl`, `facts/${orphanManifest.hot.n}.sid.idx`]
    .concat((orphanManifest.cold || []).filter((c) => !(prev.cold || []).some((p) => p.n === c.n)).flatMap((c) => [`cold/${c.n}.jsonl`, `cold/${c.n}.id.idx`, `cold/${c.n}.sid.idx`]));
  assert.ok(orphanFiles.some((f) => f.startsWith('cold/')), 'the failed relief left its cold generation');
  const orphanSha = Object.fromEntries(orphanFiles.map((f) => [f, sha(fs.readFileSync(path.join(s.dir, f)))]));
  await h.close(); h.release(); hs.splice(hs.indexOf(h), 1);
  // restart on the real fs
  const h2 = createOwnerHarness({ dir: s.dir, hotMaxRecords: 70 }); hs.push(h2);
  const re = h2.open(['w']);
  assert.equal(re.state, 'available', JSON.stringify(re.stateMessage));
  const st = h2.read('status').items[0];
  assert.equal(st.checkpoint.n, prev.hot.n, 'recovered from the previous checkpoint, not the unpublished one');
  assert.equal(st.recovery.unapplied_count, 0, 'nothing unknown to replay');
  for (let i = 1; i <= 70; i++) { const r = h2.read('get', { id: `p${i}` }); assert.equal(r.items.length, 1, `p${i} retained`); assert.equal(r.items[0].tracking_state, i === 70 ? 'tracked' : 'superseded'); }
  for (const id of ['p71', 'p72']) assert.equal(h2.read('get', { id }).items.length, 0, `${id}: refused, never persisted, not replayed`);
  const begins = segmentFiles(s.dir).flatMap((f) => readFrames(f).frames.map((x) => x.obj)).filter((x) => x.t === 'begin').map((x) => x.id);
  assert.deepEqual([...new Set(begins)].sort(), Array.from({ length: 70 }, (_, i) => `p${i + 1}`).sort(), 'segments hold exactly the 70 acked begins');
  for (const [f, h0] of Object.entries(orphanSha)) assert.equal(sha(fs.readFileSync(path.join(s.dir, f))), h0, `orphan preserved byte-for-byte: ${f}`);
  assert.equal((await ownerBegin(h2, 'p71', 'w')).type, 'ack', 'the recovered store serves new begins');
}));

// ===================================================================================================
// #1273 correction570 (review566 F4-threshold). The THRESHOLD checkpoint that a group flush runs
// (flushGroup, framesSinceCheckpoint >= compactFrames) changes owner memory before its MANIFEST publishes,
// exactly like the relief checkpoint. A MANIFEST failure there must fail the store CLOSED as well — on the
// plain write path (TH1, real client + owner worker) and when the flush is the relief path's own (TH2).
// ===================================================================================================
const FAULT_FS = path.join(__dirname, 'fixtures', 'ledger-1207', 'fault-fs.js');
const manifestTmps = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith('MANIFEST.json.') && n.endsWith('.tmp'));
const segBytesOf = (dir) => segmentFiles(dir).reduce((n, f) => n + fs.statSync(f).size, 0);
function orphanSet(dir, prevManifest) {
  const tmps = manifestTmps(dir);
  const m = JSON.parse(fs.readFileSync(path.join(dir, tmps[0]), 'utf8'));
  const files = [tmps[0], `hot/${m.hot.n}.jsonl`, `hot/${m.hot.n}.receipts.jsonl`, `facts/${m.hot.n}.jsonl`, `facts/${m.hot.n}.sid.idx`]
    .concat((m.cold || []).filter((c) => !(prevManifest.cold || []).some((p) => p.n === c.n)).flatMap((c) => [`cold/${c.n}.jsonl`, `cold/${c.n}.id.idx`, `cold/${c.n}.sid.idx`]));
  return { manifest: m, sha: Object.fromEntries(files.map((f) => [f, sha(fs.readFileSync(path.join(dir, f)))])) };
}
const coreOf = (r) => ({ inject_id: r.inject_id, session_id: r.session_id, created_at: r.created_at, transport_source: r.transport_source, tracking_state: r.tracking_state,
  observations: (r.observations || []).filter((o) => o.kind !== 'daemon_restart_observed') });

test('1273 TH1: a MANIFEST failure in the THRESHOLD checkpoint of a group flush fails the store CLOSED (real client + owner worker): the next inject is refused with no delivery and no segment growth; restart recovers exactly the acknowledged records, preserves the orphans and replays nothing', () => withStore(async (s) => {
  // prepare a published store with history (no fault): one live destination, superseded predecessors
  const R0 = recorders();
  const a = buildShared(s, R0);
  assert.equal((await a.runtime.restoreTrackedInjections()).ok, true);
  const prep = [];
  for (let i = 1; i <= 3; i++) { const r = await inject(a.handler, 'w1', `prep ${i}`); assert.equal(r.statusCode, 200); prep.push(r.body.inject_id); }
  assert.equal((await a.ledgerClient.close(2000)).lock.released, true);
  // reopen with the fault facade in the owner WORKER (read at spawn): the reopen writes one MANIFEST (skipped),
  // the next MANIFEST tmp->rename — the first threshold checkpoint — fails EIO once
  const prevFaults = process.env.LEDGER_1207_FAULTS;
  process.env.LEDGER_1207_FAULTS = JSON.stringify({ renameSync: { code: 'EIO', times: 1, skip: 1, pathIncludes: 'MANIFEST.json.' } });
  const R = recorders();
  let b;
  try {
    b = buildShared(s, R, { clientOptions: { fsImplPath: FAULT_FS, compactFrames: 24 } });
    assert.equal((await b.runtime.restoreTrackedInjections()).ok, true);
  } finally { if (prevFaults === undefined) delete process.env.LEDGER_1207_FAULTS; else process.env.LEDGER_1207_FAULTS = prevFaults; }
  const prevManifest = JSON.parse(fs.readFileSync(path.join(s.dir, 'MANIFEST.json'), 'utf8'));
  assert.equal(manifestTmps(s.dir).length, 0, 'setup: the reopen published normally');
  const acked = []; let trigger = null;
  for (let i = 1; i <= 200 && !trigger; i++) {
    const r = await inject(b.handler, 'w1', `threshold task ${i}`);
    if (manifestTmps(s.dir).length) trigger = { i, status: r.statusCode, id: r.body.inject_id };
    else { assert.equal(r.statusCode, 200, `inject #${i} before the threshold: ${JSON.stringify(r.body)}`); acked.push(r.body.inject_id); }
  }
  assert.ok(trigger, 'setup: a threshold checkpoint reached the MANIFEST rename and the fault fired');
  // The flush that crossed compactFrames is either this inject's own begin group (begin acked durable BEFORE the
  // checkpoint ⇒ delivered, 200) or an earlier inject's follow-up write (⇒ this begin already meets the closed
  // store: refused by name, nothing delivered, nothing persisted).
  const refusedIds = [];
  if (trigger.status === 200) acked.push(trigger.id);
  else {
    assert.equal(trigger.status, 503, `named refusal: ${JSON.stringify(trigger)}`);
    assert.equal(R.delivery.some((d) => d.injectId === trigger.id), false, 'the refused trigger inject was not delivered');
    refusedIds.push(trigger.id);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.dir, 'MANIFEST.json'), 'utf8')), prevManifest, 'the threshold checkpoint did not publish: the MANIFEST on disk is the previous one');
  const lastBefore = new Map();
  for (const id of [...prep, ...acked]) lastBefore.set(id, coreOf((await b.ledgerClient.fetchTrackedInjection(id)).record));
  const seg0 = segBytesOf(s.dir); const delivered0 = R.delivery.length;
  // fail-closed: no further write from the diverged owner memory
  const refused = await inject(b.handler, 'w1', 'after the threshold failure');
  assert.notEqual(refused.statusCode, 200, `the store must not admit from diverged state: ${JSON.stringify(refused.body)} client=${b.ledgerClient.state}`);
  assert.equal(b.ledgerClient.state, 'unavailable_write');
  const owner = await b.ledgerClient.ownerStatus();
  assert.equal(owner.store, 'unavailable_write'); assert.match(String(owner.reason), /EIO/);
  assert.notEqual(await b.runtime.parkTrackedInjection(acked[acked.length - 1], 'synthetic_strategy', 'after_fault'), 'tracking_parked', 'no observation is acked either');
  assert.equal(R.delivery.length, delivered0, 'no delivery after the failure');
  assert.equal(segBytesOf(s.dir), seg0, 'no segment growth after the failure');
  assert.equal(R.delivery.length, acked.length, 'exactly one delivery per acknowledged inject');
  assert.ok(R.delivery.every((d) => d.durable), 'durable before delivery');
  const orphans = orphanSet(s.dir, prevManifest);
  await closeBounded(b.ledgerClient, 2000);
  // restart without the fault
  const R2 = recorders();
  const c = buildShared(s, R2);
  assert.equal((await c.runtime.restoreTrackedInjections()).ok, true);
  const st = await c.ledgerClient.ownerStatus();
  assert.equal(st.store, 'available');
  assert.equal(st.checkpoint.n, prevManifest.hot.n, 'the rename failed: restart recovers the previous MANIFEST (segments replay the acknowledged work)');
  assert.equal(st.recovery.unapplied_count, 0, 'no unknown effect');
  for (const id of [...prep, ...acked]) assert.deepEqual(coreOf((await c.ledgerClient.fetchTrackedInjection(id)).record), lastBefore.get(id), `${id}: identity, state and observations recovered`);
  assert.equal(lastBefore.get(acked[acked.length - 1]).tracking_state, 'tracked');
  for (const id of [...refusedIds, refused.body.inject_id]) assert.equal((await c.ledgerClient.fetchTrackedInjection(id)).record, null, `${id}: the refused inject persisted nothing`);
  for (const [f, h0] of Object.entries(orphans.sha)) assert.equal(sha(fs.readFileSync(path.join(s.dir, f))), h0, `orphan preserved byte-for-byte: ${f}`);
  assert.deepEqual(R2.delivery, [], 'nothing replayed across the restart');
  const after = await inject(c.handler, 'w1', 'after restart');
  assert.equal(after.statusCode, 200, JSON.stringify(after.body));
  console.log(`[ledger-1273 TH1] acked=${acked.length} trigger_inject=${trigger.i}:${trigger.status} refused=${refused.statusCode}/${refused.body.reason} owner=${owner.store}:${owner.reason} recovered_checkpoint=${st.checkpoint.n} orphans=${Object.keys(orphans.sha).length} (reported)`);
  assert.deepEqual([...R0.unexpected, ...R.unexpected, ...R2.unexpected], []);
}));

test('1273 TH2: a threshold checkpoint NESTED in the relief path\'s group flush that fails at the MANIFEST fails the store CLOSED before the relieving begin is answered (unavailable_write, no later ack, no segment growth); restart recovers all acknowledged records', () => withOwnerStore(async (s, hs) => {
  let armed = false; const fired = [];
  const faulty = Object.create(fs);
  faulty.renameSync = (from, to) => {
    if (armed && String(to) === path.join(s.dir, 'MANIFEST.json')) { armed = false; fired.push(String(from)); const e = new Error('synthetic EIO'); e.code = 'EIO'; throw e; }
    return fs.renameSync(from, to);
  };
  const h = createOwnerHarness({ dir: s.dir, hotMaxRecords: 70, compactFrames: 71, fsImpl: faulty }); hs.push(h);
  assert.equal(h.open(['w']).state, 'available');
  for (let i = 1; i <= 70; i++) assert.equal((await ownerBegin(h, `p${i}`, 'w')).type, 'ack', `p${i}`);
  assert.equal(h.read('status').items[0].frames_since_checkpoint, 70, 'setup: one frame below the threshold');
  const prevManifest = JSON.parse(fs.readFileSync(path.join(s.dir, 'MANIFEST.json'), 'utf8'));
  armed = true;
  // an open group (one observation frame), then a begin past the soft target with a relief batch resident:
  // relief flushes the group first, the flush crosses compactFrames and runs the threshold checkpoint
  const obsP = h.submit('obs', { id: 'p70', observation: { kind: 'output_observed', trigger: 'nested_threshold', at: nowIso() } });
  const beginP = ownerBegin(h, 'p71', 'w');
  const [o, b] = await Promise.all([obsP, beginP]);
  assert.equal(fired.length, 1, 'positive hook witness: the threshold checkpoint reached its MANIFEST rename');
  assert.equal(o.type, 'ack', 'the flushed observation is durable and acked');
  const closed = h.ofType('state').find((m) => m.store === 'unavailable_write');
  assert.ok(closed, `the owner failed closed: ${JSON.stringify(h.ofType('state').map((m) => [m.store, m.reason]))}`);
  assert.equal(closed.stage, 'checkpoint_manifest'); assert.equal(closed.code, 'EIO');
  assert.ok(o._seq < closed._seq, 'the acked group precedes the state change');
  assert.equal(b.type, 'nack', `the relieving begin is not admitted from diverged state: ${JSON.stringify(b)}`); assert.equal(b.reason, 'unavailable_write');
  assert.ok(closed._seq < b._seq);
  assert.equal(h.messages.filter((m) => m.type === 'ack' && m._seq > closed._seq).length, 0, 'no ack after the state change');
  const seg0 = segBytesOf(s.dir);
  const later = await h.submit('obs', { id: 'p70', observation: { kind: 'output_observed', trigger: 'after_fault', at: nowIso() } });
  assert.equal(later.type, 'nack'); assert.equal(later.reason, 'unavailable_write');
  assert.equal(segBytesOf(s.dir), seg0, 'no segment growth after the failure');
  const orphans = orphanSet(s.dir, prevManifest);
  await h.close(); h.release(); hs.splice(hs.indexOf(h), 1);
  const h2 = createOwnerHarness({ dir: s.dir, hotMaxRecords: 70, compactFrames: 71 }); hs.push(h2);
  assert.equal(h2.open(['w']).state, 'available');
  const st = h2.read('status').items[0];
  assert.equal(st.checkpoint.n, prevManifest.hot.n, 'previous MANIFEST (the rename failed)'); assert.equal(st.recovery.unapplied_count, 0);
  for (let i = 1; i <= 70; i++) { const r = h2.read('get', { id: `p${i}` }); assert.equal(r.items.length, 1, `p${i}`); assert.equal(r.items[0].tracking_state, i === 70 ? 'tracked' : 'superseded'); }
  assert.deepEqual(h2.read('get', { id: 'p70' }).items[0].observations.map((x) => x.trigger).filter((t) => t === 'nested_threshold' || t === 'after_fault'), ['nested_threshold'], 'the acked observation persists, the refused one does not');
  assert.equal(h2.read('get', { id: 'p71' }).items.length, 0, 'the refused begin persisted nothing');
  for (const [f, h0] of Object.entries(orphans.sha)) assert.equal(sha(fs.readFileSync(path.join(s.dir, f))), h0, `orphan preserved: ${f}`);
}));
