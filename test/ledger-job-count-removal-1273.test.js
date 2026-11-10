'use strict';

// Task 1273 — the persistent tracked-job COUNT is not an admission prerequisite. Normal identified
// (`from`-tracked) injects continue past 512 / 576 / 1024 to ONE live destination with durable
// correlation, a bounded hot set and honest refusals for genuine resource / integrity failures.
//
// The real inject handler (registerInjectRoute), the real delivery runtime, the real ledger client
// and the real owner worker on a private HOME; the delivery boundary is a recorder. No daemon,
// listener, socket or PTY. Owner-level cases drive the owner in-process (test/fixtures harness).
// No manual retire / untrack / compact is used anywhere to make room.
//
// Split590 (test-only): F1, F3 and T6/F2/F4/TH1/TH2 moved to the three test/ledger-job-count-removal-1273-*.test.js
// files so that each file stays within the per-file deadline (the 16 tests are unchanged).
// The test bodies are moved verbatim; the shared helpers live in test/fixtures/ledger-1207/job-count-removal-1273.js.
// Each test runs on its own private HOME or owner store, so the four 1273 files share no ledger, lock or owner worker.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const F = require('../src/session-store/ledger-format');
const { createOwnerHarness } = require('./fixtures/ledger-1207/owner-harness');
const { sha, buildShared, recorders, inject, withStore, dirBytes, assertBusCorrelation, beginOnDisk, ownerBegin, withOwnerStore } = require('./fixtures/ledger-1207/job-count-removal-1273');

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
