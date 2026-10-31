'use strict';

// #1207 — ACCEPTANCE C6 (inbound backlog bound) and the reservation / terminal controls that must
// survive it, measured against the REAL ledger client and the REAL owner worker. The owner is paused
// through a PRIVATE TEST BARRIER (test/fixtures/ledger-1207/paused-owner-fs.js: the worker blocks,
// bounded, inside its next segment fsync while a barrier file exists). While paused:
//   • every submission the client ADMITS is retained exactly once in its inflight set (sent − resolved);
//   • every submission the client REFUSES is a named `rejected_admission` resolved immediately, with
//     nothing queued or persisted (the worker never sees it);
//   • the per-job terminal unit and the job's reserved result units are still admitted;
//   • on release, acks arrive in owner `seq` order and the inflight set drains to zero.
// MEASURED PROXY: the client's inflight set (sent-but-unresolved submissions) is the observable
// bound on the owner's inbound MessagePort backlog; it is identical to that backlog only if the
// port delivered nothing to the paused owner, which JavaScript cannot inspect. This test reports
// the proxy under that name and never calls it a direct inspection of V8's hidden queue.
// Author-written; NOT RUN in this phase; the owner is the resume3 accounting + resume4 fixtures.
//
// Review item (recorded, unmeasured until run): the client admits BOTH `begin` and `state` as class
// T for one job; the one-terminal-unit rule can refuse an abort while the job's begin is inflight.
// The case below measures that interleaving directly through the client and records the actual
// outcome; by reading, no current real caller produces it (the inject route awaits the begin before
// any abort; the four queue-flush aborts run after the begin acked).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../src/session-store/ledger-format');
const H = require('./fixtures/ledger-1207/control-harness');
const { createBarrier } = require('./fixtures/ledger-1207/paused-owner-fs');

const PAUSED_FS = path.join(__dirname, 'fixtures', 'ledger-1207', 'paused-owner-fs.js');
const EVIDENCE = H.evidenceDir();
const FLOOD = Object.freeze({ O: 300, R_shared: 140, L: 70, releaseAfterMs: 300, barrierMaxWaitMs: 15000 });
const nowIso = () => new Date().toISOString();

function obsDelta(id, kind, trigger) { return { id, observation: { kind, trigger, at: nowIso(), emitted_via: 'transition' } }; }

async function withPausedStore(name, fn) {
  const store = H.privateStore(`telepty-1207-c6-${name}-`);
  const barrier = createBarrier(store.home);
  const prevBarrier = process.env.LEDGER_1207_BARRIER; const prevFaults = process.env.LEDGER_1207_FAULTS;
  process.env.LEDGER_1207_BARRIER = barrier.env({ maxWaitMs: FLOOD.barrierMaxWaitMs });
  delete process.env.LEDGER_1207_FAULTS;
  const R = H.recorders(); const messages = { inbound: [], outbound: [] };
  const built = H.buildShared(store, R, { messages, clientOptions: { fsImplPath: PAUSED_FS } });
  let failed = true;
  try { const r = await fn({ store, barrier, R, messages, ...built }); failed = false; return r; } finally {
    barrier.release();                                   // never leave the worker paused
    await H.closeBounded(built.ledgerClient, 2000);      // close the owned client on every path
    if (prevBarrier === undefined) delete process.env.LEDGER_1207_BARRIER; else process.env.LEDGER_1207_BARRIER = prevBarrier;
    if (prevFaults === undefined) delete process.env.LEDGER_1207_FAULTS; else process.env.LEDGER_1207_FAULTS = prevFaults;
    if (failed) console.log(`[ledger-1207 C6] FAILED — private HOME preserved: ${store.home}`); else fs.rmSync(store.home, { recursive: true, force: true });
  }
}

test('C6: with the owner paused, admitted submissions are retained once in the inflight set, refusals are named and immediate, terminal/reserved units stay admitted, and release drains in seq order', () => withPausedStore('backlog', async ({ store, barrier, R, messages, runtime, ledgerClient }) => {
  const evidence = { case: 'C6', started_at: nowIso(), flood: FLOOD, proxy: 'client inflight set (sent − resolved) as the bound on the owner inbound backlog; not a direct MessagePort inspection' };
  assert.equal((await runtime.restoreTrackedInjections()).ok, true);
  // one durable job BEFORE the pause (its begin acked), so T/R reservations exist
  const job = await runtime.beginTrackedInjection({ injectId: 'job-1', sessionId: 'w1', source: 'orch', session: null });
  assert.equal(job.ok, true, JSON.stringify(job));
  // a second job's begin will be the first message the paused owner cannot answer
  assert.equal(barrier.raise() !== null, true);
  const tRaise = Date.now();
  const sent = []; const rejected = []; const order = []; let resolvedCounter = 0;
  // beginTrackedInjection resolves the runtime's result object whose `outcome` is the client outcome;
  // direct client submits resolve the outcome itself — both are tracked by the same outcome shape.
  const unwrap = (r) => (r && r.outcome && typeof r.outcome === 'object' ? r.outcome : r);
  function track(label, cls, promise) {
    const e = { label, cls, sentAt: Date.now(), outcome: null, resolvedAt: null, seq: null, order: null };
    sent.push(e);
    const p = promise.then(unwrap);
    p.then((o) => { e.outcome = o.outcome; e.reason = o.reason || null; e.resolvedAt = Date.now(); e.seq = o.seq ?? null; e.order = ++resolvedCounter; if (o.outcome === 'rejected_admission') rejected.push(e); });
    return p;
  }
  // (a) a begin for a second job: admitted (its own reservation), retained inflight while paused
  const begin2 = track('begin job-2', 'T', runtime.beginTrackedInjection({ injectId: 'job-2', sessionId: 'w2', source: 'orch', session: null }));
  // (b) flood class O until the pool refuses pre-admission
  const oPromises = [];
  for (let i = 0; i < FLOOD.O; i++) oPromises.push(track(`O${i}`, 'O', ledgerClient.submit('obs', obsDelta('job-1', i % 2 ? 'output_observed' : 'busy_indicator_pattern_observed', `t${i}`), { class: 'O' })));
  // (c) the job's two reserved result units, then shared R until the shared pool refuses
  const rPromises = [];
  for (let i = 0; i < FLOOD.R_shared; i++) rPromises.push(track(`R${i}`, 'R', ledgerClient.submit('obs', { id: 'job-1', observation: { kind: 'inject_parked', trigger: `park${i}`, reason: null, bytes_written: 0, at: nowIso() } }, { class: 'R', jobId: 'job-1', result: true })));
  // (d) facts (class L) until the L pool refuses
  const lPromises = [];
  for (let i = 0; i < FLOOD.L; i++) lPromises.push(track(`L${i}`, 'L', ledgerClient.submit('fact', { scope: 'global', observation: { kind: 'daemon_restart_observed', trigger: `restart${i}`, at: nowIso() } }, { class: 'L' })));
  // (e) the job's TERMINAL: must still be admitted while O/R/L are exhausted (reserved unit)
  const terminal = track('state job-1 aborted', 'T', ledgerClient.submit('state', { id: 'job-1', tracking_state: 'aborted', observation: { kind: 'inject_delivery_refused', trigger: 'delivery_refused', delivery_code: 'X', bytes_written: 0, at: nowIso() } }, { class: 'T', jobId: 'job-1' }));
  await H.sleep(20);     // let immediate (rejected_admission) resolutions settle; the owner is paused
  const admitted = sent.filter((e) => e.outcome === null);
  const inflightWhilePaused = ledgerClient._internal.inflight.size;
  evidence.while_paused = { sent: sent.length, rejected_immediately: rejected.length, admitted_pending: admitted.length, inflight_proxy: inflightWhilePaused,
    rejected_by_class: ['O', 'R', 'L', 'T'].map((c) => [c, rejected.filter((e) => e.cls === c).length]), accounting: ledgerClient.accounting.status(), check: ledgerClient.accounting.check() };
  // ---- assertions while paused -----------------------------------------------------------------
  assert.ok(rejected.length > 0, 'the flood must exceed at least one pool so refusals are observed');
  assert.ok(rejected.filter((e) => e.cls === 'O').length > 0, 'class O refuses pre-admission once its pool is full');
  for (const e of rejected) { assert.ok(e.resolvedAt <= tRaise + FLOOD.releaseAfterMs, 'a refusal resolves immediately, before any work is retained'); assert.ok(['tracking_backpressure', 'tracking_capacity_result', 'tracking_capacity_exhausted'].includes(e.reason), `named refusal, got ${e.reason}`); }
  assert.equal(inflightWhilePaused, admitted.length, 'every admitted submission is retained exactly once in the inflight set (the backlog proxy)');
  assert.ok(inflightWhilePaused <= F.POOL_TOTALS.entries, `the retained set never exceeds the pool totals (${inflightWhilePaused} <= ${F.POOL_TOTALS.entries})`);
  assert.ok(evidence.while_paused.check.ok, `accounting inequalities hold under the flood: ${JSON.stringify(evidence.while_paused.check)}`);
  const term = sent.find((e) => e.label === 'state job-1 aborted');
  assert.equal(term.outcome, null, 'the reserved terminal unit was admitted (pending, not refused) while O/R/L were exhausted');
  assert.equal(sent.find((e) => e.label === 'begin job-2').outcome, null, 'the second begin was admitted on its own reservation');
  const reservedR = sent.filter((e) => e.cls === 'R' && e.outcome === null).length;
  assert.ok(reservedR >= F.POOLS.R.reservedPerJob, `the job's ${F.POOLS.R.reservedPerJob} reserved result units were admitted (${reservedR} R admitted)`);
  assert.equal(R.delivery.length, 0, 'nothing was delivered while paused');
  // ---- release and drain -----------------------------------------------------------------------
  await H.sleep(Math.max(0, FLOOD.releaseAfterMs - (Date.now() - tRaise)));
  barrier.release();
  const tRelease = Date.now();
  await Promise.all([begin2, terminal, ...oPromises, ...rPromises, ...lPromises]);
  const drainMs = Date.now() - tRelease;
  const acked = sent.filter((e) => e.outcome === 'ack'); const indeterminate = sent.filter((e) => e.outcome === 'indeterminate'); const nacked = sent.filter((e) => e.outcome === 'nack');
  evidence.after_release = { drain_ms: drainMs, acked: acked.length, nacked: nacked.length, indeterminate: indeterminate.length, rejected: rejected.length, unresolved: ledgerClient.status().unresolved_count, inflight_proxy: ledgerClient._internal.inflight.size,
    accounted: acked.length + nacked.length + indeterminate.length + rejected.length, messages: H.messageSizeReport(messages) };
  assert.equal(evidence.after_release.accounted, sent.length, 'every sent unit is accounted exactly once: acked + nacked + indeterminate + rejected == sent');
  assert.equal(ledgerClient._internal.inflight.size, 0, 'the inflight set drains to zero after release');
  assert.equal(indeterminate.length, 0, 'no persistence attempt failed in this run (a fault would be a different, named case)');
  // order: acks carry the owner's seq; among acked submissions seq order == resolution order
  const ackedWithSeq = acked.filter((e) => typeof e.seq === 'number').sort((a, b) => a.order - b.order);
  for (let i = 1; i < ackedWithSeq.length; i++) assert.ok(ackedWithSeq[i].seq >= ackedWithSeq[i - 1].seq, `acks resolve in seq order (${ackedWithSeq[i - 1].seq} then ${ackedWithSeq[i].seq})`);
  assert.equal(term.outcome, 'ack'); assert.equal(ledgerClient.readModel.getTrackedInjection('job-1').tracking_state, 'aborted', 'the terminal completed durably after release');
  assert.equal(ledgerClient.readModel.getTrackedInjection('job-2').tracking_state, 'tracked');
  const owner = await ledgerClient.ownerStatus();
  evidence.owner = { counts: owner.counts, io: owner.io, resident: owner.resident };
  // nothing refused is in any segment: the obs/fact/state frames on disk are exactly the acked
  // non-begin submissions (the two begins are `begin` frames, counted separately)
  const frames = fs.readdirSync(path.join(store.dir, 'segments')).flatMap((n) => require('./fixtures/ledger-1207/owner-harness').readFrames(path.join(store.dir, 'segments', n)).frames.map((x) => x.obj)).filter((x) => x.t !== 'commit');
  evidence.frames = { total_non_commit: frames.length, obs: frames.filter((x) => x.t === 'obs').length, fact: frames.filter((x) => x.t === 'fact').length, state: frames.filter((x) => x.t === 'state').length, begin: frames.filter((x) => x.t === 'begin').length };
  const ackedNonBegin = acked.filter((e) => !e.label.startsWith('begin')).length;
  assert.equal(evidence.frames.obs + evidence.frames.fact + evidence.frames.state, ackedNonBegin, 'exactly the acked obs/fact/state submissions are on disk — no refused unit was persisted');
  assert.equal(evidence.frames.begin, 2, 'the two begins (one before the pause, one during) are the only begin frames');
  const file = H.writeEvidence(EVIDENCE, 'C6-backlog.json', evidence);
  console.log(`[ledger-1207 C6] evidence=${file} paused=${JSON.stringify(evidence.while_paused.rejected_by_class)} inflight_proxy=${inflightWhilePaused} drain_ms=${drainMs}`);
}));

test('C6 (review item): a terminal submitted while the SAME job\'s begin is still inflight — measured outcome recorded; the two T admissions share one terminal unit under the resume3 rule', () => withPausedStore('interleave', async ({ store, barrier, runtime, ledgerClient }) => {
  assert.equal((await runtime.restoreTrackedInjections()).ok, true);
  barrier.raise();
  const begin = runtime.beginTrackedInjection({ injectId: 'ij-1', sessionId: 'w1', source: 'orch', session: null });   // pending: owner paused
  await H.sleep(20);
  assert.ok(ledgerClient.accounting.hasJob('ij-1'), 'the job reservation exists while its begin is inflight');
  const abortDuring = await ledgerClient.submit('state', { id: 'ij-1', tracking_state: 'aborted', observation: { kind: 'inject_delivery_refused', trigger: 'delivery_refused', delivery_code: 'X', bytes_written: 0, at: nowIso() } }, { class: 'T', jobId: 'ij-1' });
  const observed = { outcome: abortDuring.outcome, reason: abortDuring.reason || null, detail: abortDuring.detail || null };
  // Not a contract assertion: the contract does not specify this interleaving. The outcome must be
  // one of the four named outcomes, nothing may be persisted for a refused unit, and the begin must
  // still complete durably after release.
  assert.ok(['rejected_admission', 'ack', 'nack', 'indeterminate'].includes(observed.outcome), JSON.stringify(observed));
  if (observed.outcome === 'rejected_admission') assert.equal(observed.reason, 'tracking_capacity_exhausted', 'the resume3 one-terminal-unit rule refuses by name (expected by reading: detail terminal_unit_inflight)');
  barrier.release();
  const begun = await begin;
  assert.equal(begun.ok, true, 'the begin completes durably after release');
  // after the begin acked, the job's terminal unit is free again: the same abort is admitted and durable
  const abortAfter = await runtime.abortTrackedInjection('ij-1', 'w1', 'DELIVERY_FAILED', 'after begin');
  assert.equal(abortAfter, 'tracking_aborted');
  const file = H.writeEvidence(EVIDENCE, 'C6-begin-state-interleave.json', { observed_while_begin_inflight: observed, after_release: abortAfter,
    real_caller_reach_by_reading: 'none: POST /api/sessions/:id/inject awaits beginTrackedInjection before any abortTrackedInjection; the four queue-flush aborts run only after the begin acked (a park requires a 200 response). Measured here through the client directly.' });
  console.log(`[ledger-1207 C6 interleave] ${file} ${JSON.stringify(observed)}`);
}));
