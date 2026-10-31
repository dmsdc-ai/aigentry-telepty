'use strict';

// #1207 — F2 / R1 control-responsiveness EVIDENCE SOURCE (factory gate). The user's complaint is
// that bookkeeping must not block useful control work — during observation traffic (F2) and during
// recovery (R1). This file drives the REAL runtime, the REAL session actions and state manager, the
// REAL ledger client and its REAL owner worker over a seeded legacy tier migrated at open, with a
// 1 ms main-loop heartbeat running throughout, and RETAINS the measurements (N, wall, bytes,
// heartbeat distribution/max, latencies) as evidence files. Author-written; NOT RUN in this phase.
//
// What is and is not reached in-process:
//   • REAL: createDeliveryRuntime, createSessionActions (+ the real POST /api/sessions/:id/inject
//     handler captured through an in-process route registrar), SessionStateManager transitions →
//     recordObservation → ledger client → owner worker → fsynced segments; fetchTrackedInjection.
//   • NOT reached: the daemon.js GET /api/inject-observations/:inject_id handler BODY (registered
//     inline on the express app). Its data path is driven exactly as the frozen daemon.js evaluates
//     it (pollDataPath in the harness) and every such call is labelled a data-path call. An
//     in-process handler call is not HTTP, a real daemon or a PTY.
//
// Tiers: TELEPTY_LEDGER_1207_TIERS is an exact comma list of 1|8|64 (MiB). Default "1" ONLY.
// 8/64 are for a bounded independent verifier and are never exercised by default. When ≥ 2 tiers
// are selected in one run, same-run relative comparisons are recorded; with one tier the cross-tier
// gate is reported INCOMPLETE and comparison-ready evidence is emitted.
//
// Gates vs proposals: structural invariants are asserted (every flip durable and named; owner
// bytes per event independent of history; zero main-thread store writes; every poll answered with
// a named state; message sizes within the declared rules; cleanup bounded). The F2 "≤ 3× the 1 MiB
// values" and R1 "50 ms / heartbeat ≤ F2 1 MiB bound" figures are CONTRACT PROPOSALS: recorded as
// `proposed_gate` with the observed values, never asserted against a fabricated baseline.
//
// Metric limitation: `process.cpuUsage()` is PROCESS CPU (includes the owner worker thread) in
// Node 20. It is labelled `process_cpu`; main-thread CPU attribution is UNMEASURED here (no
// suitable supplied primitive; no profiler/native tool is acquired).
//
// Expected RED by code reading (product evidence, not edited): during the first open the frozen
// daemon.js keeps `trackedLedgerUnavailableReason = 'not_opened'`, so the poll data path names
// `not_opened` (contract: `recovering`) and a begin answers 500 TRACKING_PERSISTENCE_FAILED
// (contract: 503 recovering). The harness mirrors daemon.js; the assertions state the contract.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./fixtures/ledger-1207/control-harness');
// Task 1215 / #1207: bounded gap diagnostics on the F2/R1 WORKLOAD samplers only (controls stay uninstrumented, so they
// remain an uninstrumented same-process reference). Diagnostic evidence only; no assertion consumes it.
const GapDiag = require('./fixtures/ledger-1207/heartbeat-gap-diagnostics');
const gapDiagOptions = (messages) => (GapDiag.enabled() ? { diag: GapDiag.createGapDiagnostics({ messages }) } : {});
const compactGapDiag = (d) => (d ? { top_gaps: d.top_gaps, main_isolate_gc: d.main_isolate_gc, measured_phase_aggregate: d.measured_phase_aggregate } : null);

const TIERS = H.selectedTiers();
const EVIDENCE = H.evidenceDir();

// Fixed work counts (identical at every tier; declared, not tuned per run).
const F2 = Object.freeze({ warmupFlips: 4, measuredFlips: 32, spacingMs: 20, settleMs: 150 });
const R1 = Object.freeze({ pollsPerSecond: 50, pollIntervalMs: 20, beginDuringRecovery: 3, postOpenPolls: 50 });
const CHUNKS = Object.freeze({ busy: '\x1b[2K\r✻ Thinking… (esc to interrupt)\r\n', plain: (k) => `tool output line ${k}\r\n` });

const f2ByTier = new Map();
const r1ByTier = new Map();

// Task 1215 W5 — same-process controls, consumed ONLY by heartbeatAcceptance (below) to validate the measurement. Each control is a SEPARATE
// instance of the exact harness sampler (H.startHeartbeat, 1 ms), run sequentially and never concurrently with
// the F2 sampler, so the measured window, its CPU/IO/latency and every existing assertion are untouched.
// idle_pre / idle_post bracket the workload (1500 ms total idle per tier ≤ 2000 ms); `block` is a deliberate
// ≤ 100 ms busy-wait confined to this test process, labelled separately, proving the sampler can see a stall.
const CONTROLS = Object.freeze({ idlePreMs: 750, idlePostMs: 750, blockLeadMs: 100, blockMs: 100, blockRecoveryMs: 300 });
async function heartbeatControl(label, { idleMs = 0, blockMs = 0 } = {}) {
  const hb = H.startHeartbeat({ periodMs: 1 });
  hb.mark('measured');
  const t0 = process.hrtime.bigint();
  let blockActualMs = null;
  if (blockMs > 0) {
    await H.sleep(CONTROLS.blockLeadMs);
    const b0 = process.hrtime.bigint(), end = b0 + BigInt(blockMs) * 1000000n;
    while (process.hrtime.bigint() < end) { /* deliberate main-thread stall (control only) */ }
    blockActualMs = H.ms(b0, process.hrtime.bigint());
    await H.sleep(CONTROLS.blockRecoveryMs);
  } else {
    await H.sleep(idleMs);
  }
  const wallMs = H.ms(t0, process.hrtime.bigint());
  const s = hb.stop();
  const m = s.measured;
  return { label, kind: blockMs > 0 ? 'deliberate_block' : 'idle', wall_ms: wallMs, period_ms: s.period_ms, n: m.n,
    mean_ms: m.n ? m.sum_ms / m.n : null, sum_ms: m.sum_ms, p50_ms: m.p50_ms, p90_ms: m.p90_ms, p99_ms: m.p99_ms, max_ms: m.max_ms,
    over_10ms: m.over_10ms, over_50ms: m.over_50ms, dropped: s.dropped, n_vs_half_wall: m.n >= Math.floor(wallMs / 2),
    ...(blockMs > 0 ? { block_requested_ms: blockMs, block_actual_ms: blockActualMs, stall_visible: m.max_ms != null && m.max_ms >= blockMs * 0.9 } : {}) };
}
const runtimeIdentity = () => ({ platform: process.platform, arch: process.arch, node: process.version, runtime: process.release && process.release.name });

// Task 1215 W5 — heartbeat ACCEPTANCE contract. It replaces the fixed-rate `n >= floor(wall / 2)` count. Measured fact:
// on the Windows runner the same-process IDLE controls themselves fail that count (CI 5971070 job 124536950446: idle
// n=73/751.8 ms and n=57/758.8 ms; workload n=247/2041.1 ms with max gap 27.3 ms; R1 n=252/open 529 ms with max gap
// 18.1 ms), which invalidates the fixed sampling-rate assumption. Host timer resolution and runner load are possible
// contributors to the low sample rate; neither was independently isolated as the cause.
// A heartbeat sample is the gap between two main-loop ticks, so the user-visible property ("bookkeeping must not
// block control work") is the LONGEST gap, plus proof that the sampler really covered the window.
// The bounds are FIXED here, identical on every platform, and evaluated before the workload result is consulted:
//   stallBoundMs 50 — a NEW explicit acceptance bound (a design decision for CI review, not a measured production
//     performance figure or a recovered original requirement): a main-loop gap >= 50 ms is a blocking regression. That is half of the 100 ms deliberate stall
//     the block control must show, and well above the worst idle gap measured on the runners (19.3 ms win32).
//     It is the same figure as the existing over_50ms heartbeat counter and the R1 50 ms poll-answer proposal.
//   coverage — the unsampled part of the window must stay below the stall bound (wall - sum < stallBoundMs), the same
//     >= 50 ms rule as a sampled gap. Otherwise sampling stopped or started late, and an unsampled stall at the end would be hidden.
//   minSamples 1 — zero or disabled sampling is never a pass.
// Controls first: both idle controls must be valid windows whose max gap stays below the bound, and the deliberate
// block must appear as a gap >= max(bound, 0.9 x requested). If not, the verdict is INCONCLUSIVE (asserted as a
// failure, never a pass, never a workload-derived baseline). Only then is the workload window judged.
const HEARTBEAT_CONTRACT = Object.freeze({ stallBoundMs: 50, minSamples: 1, blockDetectRatio: 0.9, sumOverWallToleranceMs: 1 });
function heartbeatAcceptance(workload, controls, contract = HEARTBEAT_CONTRACT) {
  const windowProblem = (label, w) => {
    if (!w || !Number.isFinite(w.wall_ms) || !(w.n >= contract.minSamples)) return `${label}: no heartbeat samples (zero or disabled sampling)`;
    if (!Number.isFinite(w.sum_ms) || w.wall_ms - w.sum_ms >= contract.stallBoundMs) return `${label}: samples cover ${w.sum_ms} of ${w.wall_ms} ms (uncovered >= ${contract.stallBoundMs} ms: incomplete phase coverage)`;
    if (w.sum_ms - w.wall_ms > contract.sumOverWallToleranceMs) return `${label}: sample sum ${w.sum_ms} ms exceeds its window ${w.wall_ms} ms (mis-measured window)`;
    return null;
  };
  const reasons = [];
  for (const label of ['idle_pre', 'idle_post']) {
    const c = controls && controls[label];
    const bad = windowProblem(label, c) || (!(c.max_ms < contract.stallBoundMs) ? `${label}: idle max gap ${c.max_ms} ms >= ${contract.stallBoundMs} ms (overloaded or invalid baseline)` : null);
    if (bad) reasons.push(bad);
  }
  const b = controls && controls.block;
  const blockBad = windowProblem('block', b)
    || (!(b.max_ms >= Math.max(contract.stallBoundMs, contract.blockDetectRatio * b.block_requested_ms)) ? `block: the deliberate ${b.block_requested_ms} ms stall is not visible (max gap ${b.max_ms} ms)` : null);
  if (blockBad) reasons.push(blockBad);
  if (reasons.length) return { verdict: 'inconclusive', reasons, contract };
  const workloadBad = windowProblem('workload', workload)
    || (!(workload.max_ms < contract.stallBoundMs) ? `workload: max main-loop gap ${workload.max_ms} ms >= ${contract.stallBoundMs} ms (blocking)` : null);
  return workloadBad ? { verdict: 'fail', reasons: [workloadBad], contract } : { verdict: 'pass', reasons: [], contract };
}

// ------------------------------------------------------------------------------------------------
// F2 — main-thread blocking during sustained observation traffic, one tier at a time
// ------------------------------------------------------------------------------------------------
for (const tier of TIERS) {
  test(`F2 [${tier} MiB]: a 1 ms heartbeat during ${F2.measuredFlips} measured flips through the genuine observation path; main-thread store writes == 0; per-event owner bytes bounded; every flip durable and named`, async () => {
    const store = H.privateStore(`telepty-1207-f2-${tier}MiB-`);
    const seeded = H.seedTier(store, tier);
    const R = H.recorders();
    const messages = { inbound: [], outbound: [] };
    const { shared, runtime, actions, injectHandler, ledgerClient, sessionStateManager } = H.buildShared(store, R, { messages });
    const controlPre = await heartbeatControl('idle_pre', { idleMs: CONTROLS.idlePreMs });   // W5 diagnostic, before the F2 sampler starts
    const hb = H.startHeartbeat({ periodMs: 1, ...gapDiagOptions(messages) });
    let failed = true;
    const evidence = { case: 'F2', tier_mib: tier, seeded: { records: seeded.count, bytes: seeded.bytes, sha256: seeded.sha256 }, counts: F2, started_at: new Date().toISOString(), node: process.version, platform: process.platform };
    evidence.heartbeat_controls = { identity: runtimeIdentity(), limits: CONTROLS, idle_pre: controlPre, idle_post: null, block: null };
    // main-thread instrumentation: installed AFTER open (the one legitimate main-thread write is the O_EXCL lock)
    const realWrite = fs.writeSync; const realWriteFile = fs.writeFileSync; let mainWrites = 0;
    try {
      const cpu0 = H.cpuMark(); const tOpen0 = process.hrtime.bigint();
      const opened = await runtime.restoreTrackedInjections();
      evidence.open = { ok: opened.ok, state: opened.state || null, reason: opened.reason || null, wall_ms: H.ms(tOpen0, process.hrtime.bigint()), counts: opened.counts || null, process_cpu: H.cpuDelta(cpu0) };
      assert.equal(opened.ok, true, `the seeded ${tier} MiB tier must migrate and open: ${JSON.stringify(opened)}`);
      assert.equal(opened.counts.cold, seeded.count, 'every seeded record is retained (cold tier)');
      fs.writeSync = function (...a) { mainWrites++; return realWrite.apply(fs, a); };
      fs.writeFileSync = function (p, ...a) { if (typeof p === 'string' && p.startsWith(store.parent)) mainWrites++; return realWriteFile.call(fs, p, ...a); };

      // the genuine route: real inject handler → begin durable → pendingReport → state-manager flips
      actions.registerStateObserver();
      sessionStateManager.register('w1');
      const res = H.makeRes();
      const tBegin0 = process.hrtime.bigint();
      await injectHandler(H.makeReq('control-load work'), res);
      evidence.begin = { status: res.statusCode, wall_ms: H.ms(tBegin0, process.hrtime.bigint()), inject_id: res.body && res.body.inject_id };
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(R.delivery.length, 1);
      const injectId = res.body.inject_id;

      // C0 control: a transition with no new identity change must not write (recorded, asserted)
      const io0 = (await ledgerClient.ownerStatus()).io;

      // warm-up flips (recorded separately) then measured flips, each: feed → transition →
      // recordObservation → owner ack → bus event. Per flip: owner io delta, time to the bus event.
      const flips = [];
      let k = 0;
      async function flip(phase) {
        hb.label('flip-status-before');
        const before = (await ledgerClient.ownerStatus()).io;
        const busBefore = R.bus.length;
        const t0 = process.hrtime.bigint();
        hb.label('flip-feed');
        sessionStateManager.feed('w1', k % 2 === 0 ? CHUNKS.busy : CHUNKS.plain(k));
        k++;
        hb.label('flip-wait');
        await H.sleep(F2.spacingMs);
        hb.label('flip-status-after');
        const after = (await ledgerClient.ownerStatus()).io;
        const events = R.bus.slice(busBefore).filter((b) => b.type === 'task_completion_unknown');
        flips.push({ phase, k, writes: after.writes - before.writes, bytes: after.bytes - before.bytes, fsyncs: after.fsyncs - before.fsyncs, renames: after.renames - before.renames,
          bus_results: events.map((e) => e.tracking_result), ack_visible_ms: events.length ? H.ms(t0, events[0].at) : null });
      }
      hb.mark('warmup');
      for (let i = 0; i < F2.warmupFlips; i++) await flip('warmup');
      const cpuM = H.cpuMark(); const tM0 = process.hrtime.bigint();
      hb.mark('measured');
      for (let i = 0; i < F2.measuredFlips; i++) await flip('measured');
      hb.label('settle');
      await H.sleep(F2.settleMs);
      hb.mark('tail');
      const measuredWall = H.ms(tM0, process.hrtime.bigint());
      evidence.process_cpu_measured = H.cpuDelta(cpuM);
      evidence.measured_wall_ms = measuredWall;
      evidence.flips = flips;
      const heartbeat = hb.stop();
      evidence.heartbeat = heartbeat;
      evidence.main_thread_store_writes = mainWrites;
      const ioEnd = (await ledgerClient.ownerStatus()).io;
      evidence.owner_io_total = { writes: ioEnd.writes - io0.writes, bytes: ioEnd.bytes - io0.bytes, fsyncs: ioEnd.fsyncs - io0.fsyncs, renames: ioEnd.renames - io0.renames };
      evidence.messages = H.messageSizeReport(messages);
      // W5 diagnostic controls AFTER every workload metric above is captured and BEFORE any assertion, so they are
      // retained in the evidence file even when an assertion below fails. Not consumed by any assertion.
      evidence.heartbeat_controls.idle_post = await heartbeatControl('idle_post', { idleMs: CONTROLS.idlePostMs });
      evidence.heartbeat_controls.block = await heartbeatControl('block', { blockMs: CONTROLS.blockMs });
      evidence.heartbeat_controls.measured_reference = { n: heartbeat.measured.n, wall_ms: measuredWall, mean_ms: heartbeat.measured.n ? heartbeat.measured.sum_ms / heartbeat.measured.n : null,
        p50_ms: heartbeat.measured.p50_ms, p90_ms: heartbeat.measured.p90_ms, p99_ms: heartbeat.measured.p99_ms, max_ms: heartbeat.measured.max_ms, n_vs_half_wall: heartbeat.measured.n >= Math.floor(measuredWall / 2) };
      // W5 acceptance (contract above), recorded in the evidence BEFORE any assertion so it survives a failure.
      evidence.heartbeat_acceptance = heartbeatAcceptance({ wall_ms: measuredWall, n: heartbeat.measured.n, sum_ms: heartbeat.measured.sum_ms, max_ms: heartbeat.measured.max_ms }, evidence.heartbeat_controls);

      // ---- structural assertions (not baselines) --------------------------------------------
      const measured = flips.filter((f) => f.phase === 'measured');
      const durable = measured.filter((f) => f.writes > 0);
      assert.ok(durable.length >= Math.floor(F2.measuredFlips / 2), `at least half of the alternations must have produced a durable write (got ${durable.length}/${measured.length}); the state machine must actually flip`);
      for (const f of durable) {
        assert.ok(f.bytes <= 16384, `per-event owner bytes ${f.bytes} must be <= 16384 regardless of the ${seeded.bytes}-byte history (F1 invariant)`);
        assert.ok(f.fsyncs <= 1 && f.renames === 0, `one fsync per group, no rename per event: ${JSON.stringify(f)}`);
      }
      for (const f of measured) {
        for (const r of f.bus_results) assert.ok(['observation_emitted', 'observation_duplicate'].includes(r), `every bus result during traffic is a durable outcome or a named duplicate, got ${r}`);
      }
      assert.equal(mainWrites, 0, 'the main thread never writes to the store during observation traffic');
      assert.equal(evidence.heartbeat_acceptance.verdict, 'pass', `heartbeat acceptance (sampled the whole measured interval, no main-loop gap >= ${HEARTBEAT_CONTRACT.stallBoundMs} ms, valid same-process controls): ${JSON.stringify(evidence.heartbeat_acceptance)}`);
      assert.deepEqual(evidence.messages.over_64KiB_outside_exceptions, [], 'no main-thread message above 64 KiB outside ack.entry/submit.delta');
      assert.deepEqual(evidence.messages.over_frame_cap, [], 'no message above the largest frame cap');
      const rec = await ledgerClient.fetchTrackedInjection(injectId);
      assert.equal(rec.record.observations[0].kind, 'tracking_started');
      assert.ok(rec.record.observation_seq >= 1 + durable.length, 'ordering and retention: every durable flip is in the record');
      const status = await ledgerClient.ownerStatus();
      assert.equal(status.counts.cold + status.counts.hot, seeded.count + 1, 'retained history + the new record');
      evidence.record = { observation_seq: rec.record.observation_seq, kinds: rec.record.observations.map((o) => o.kind) };
      evidence.rss_bytes_end = process.memoryUsage().rss;
      failed = false;
      f2ByTier.set(tier, evidence);
    } finally {
      fs.writeSync = realWrite; fs.writeFileSync = realWriteFile;
      try { const late = hb.stop(); if (!evidence.heartbeat) evidence.heartbeat_on_early_failure = late; } catch { /* already stopped */ }
      evidence.closed = await H.closeBounded(ledgerClient, 2000);
      evidence.finished_at = new Date().toISOString(); evidence.failed = failed;
      const file = H.writeEvidence(EVIDENCE, `F2-${tier}MiB.json`, evidence);
      console.log(`[ledger-1207 F2 ${tier} MiB] evidence=${file} heartbeat.measured=${JSON.stringify(evidence.heartbeat && evidence.heartbeat.measured)} process_cpu=${JSON.stringify(evidence.process_cpu_measured)} mainWrites=${evidence.main_thread_store_writes}`);
      // W5: raw control summaries on every outcome (identity, phases, counts, gap stats only — no paths or payloads).
      console.log(`[ledger-1207 F2 ${tier} MiB] heartbeat_controls=${JSON.stringify(evidence.heartbeat_controls)}`);
      console.log(`[ledger-1207 F2 ${tier} MiB] heartbeat_gap_diagnostics=${JSON.stringify(compactGapDiag((evidence.heartbeat || evidence.heartbeat_on_early_failure || {}).diagnostics))}`);
      console.log(`[ledger-1207 F2 ${tier} MiB] heartbeat_acceptance=${JSON.stringify(evidence.heartbeat_acceptance || null)}`);
      if (failed) console.log(`[ledger-1207 F2 ${tier} MiB] FAILED — private HOME preserved for diagnosis: ${store.home}`);
      else fs.rmSync(store.home, { recursive: true, force: true });
    }
  });
}

// ------------------------------------------------------------------------------------------------
// R1 — recovery under control load: open/migrate while a 1 ms heartbeat runs and 50 polls/s hit
// the poll handler's data path; begin while recovering; message-size observations
// ------------------------------------------------------------------------------------------------
for (const tier of TIERS) {
  test(`R1 [${tier} MiB]: open while a 1 ms heartbeat runs and ${R1.pollsPerSecond} polls/s drive the poll data path; begin while recovering is refused by name; every poll answered; no message > 64 KiB`, async () => {
    const store = H.privateStore(`telepty-1207-r1-${tier}MiB-`);
    const seeded = H.seedTier(store, tier);
    const R = H.recorders();
    const messages = { inbound: [], outbound: [] };
    const { shared, runtime, injectHandler, ledgerClient } = H.buildShared(store, R, { messages });
    // W5: R1's OWN same-process controls (never borrowed from F2). idle_pre runs before the R1 sampler and before the
    // open; idle_post + block run after every workload metric is captured. Same budget as F2: 1500 ms idle + 100 ms block.
    const controlPre = await heartbeatControl('idle_pre', { idleMs: CONTROLS.idlePreMs });
    const hb = H.startHeartbeat({ periodMs: 1, ...gapDiagOptions(messages) });
    let failed = true; let pollTimer = null;
    const evidence = { case: 'R1', tier_mib: tier, seeded: { records: seeded.count, bytes: seeded.bytes, sha256: seeded.sha256 }, counts: R1, started_at: new Date().toISOString(), node: process.version, platform: process.platform,
      handler_reach: 'poll handler BODY not reachable in-process (inline on the express app); its data path is driven as daemon.js evaluates it; the inject handler is the real one' };
    evidence.heartbeat_controls = { identity: runtimeIdentity(), limits: CONTROLS, idle_pre: controlPre, idle_post: null, block: null };
    const polls = [];
    const begins = [];
    try {
      hb.mark('measured');
      const tPhase0 = process.hrtime.bigint();   // W5: the sampled window is the whole measured phase (open ⊂ phase)
      const cpu0 = H.cpuMark(); const tOpen0 = process.hrtime.bigint();
      const sampleIds = seeded.ids.slice(0, 5);
      let pollIndex = 0;
      pollTimer = setInterval(() => {
        const id = sampleIds[pollIndex++ % sampleIds.length];
        const issued = process.hrtime.bigint();
        H.pollDataPath(shared, id).then((p) => polls.push({ ...p, issued_ms_after_open_start: H.ms(tOpen0, issued), during: shared.trackedLedgerHealthy ? 'available' : 'recovering' }))
          .catch((error) => polls.push({ arm: 'threw', error: error && error.message, issued_ms_after_open_start: H.ms(tOpen0, issued) }));
      }, R1.pollIntervalMs);
      // begins issued while the store is recovering (the open is in flight on the owner thread)
      hb.label('open-inflight');
      const openPromise = runtime.restoreTrackedInjections();
      for (let i = 0; i < R1.beginDuringRecovery; i++) {
        hb.label('begin-during-open');
        const res = H.makeRes(); const t0 = process.hrtime.bigint();
        await injectHandler(H.makeReq(`begin while recovering ${i}`), res);
        begins.push({ status: res.statusCode, code: res.body && res.body.code, reason: res.body && res.body.reason, wall_ms: H.ms(t0, process.hrtime.bigint()), store: ledgerClient.state, healthy: shared.trackedLedgerHealthy });
      }
      hb.label('open-await');
      const opened = await openPromise;
      hb.label('post-open-polls');
      const openWall = H.ms(tOpen0, process.hrtime.bigint());
      evidence.open = { ok: opened.ok, state: opened.state || null, reason: opened.reason || null, wall_ms: openWall, counts: opened.counts || null, process_cpu: H.cpuDelta(cpu0) };
      assert.equal(opened.ok, true, JSON.stringify(opened));
      // keep polling for a fixed count after the open so the available arm is measured too
      const target = polls.length + R1.postOpenPolls;
      const deadline = Date.now() + 15000;
      while (polls.length < target && Date.now() < deadline) await H.sleep(R1.pollIntervalMs);
      clearInterval(pollTimer); pollTimer = null;
      hb.label('drain');
      await H.sleep(100);
      hb.mark('tail');
      const phaseWall = H.ms(tPhase0, process.hrtime.bigint());
      const heartbeat = hb.stop();
      evidence.heartbeat = heartbeat;
      evidence.measured_phase_wall_ms = phaseWall;
      evidence.messages = H.messageSizeReport(messages);
      const during = polls.filter((p) => p.during === 'recovering');
      const after = polls.filter((p) => p.during === 'available');
      evidence.polls = { total: polls.length, during_recovery: during.length, after_open: after.length,
        during_latency: H.summarize(during.map((p) => p.latency_ms || 0)), after_latency: H.summarize(after.map((p) => p.latency_ms || 0)),
        during_reasons: [...new Set(during.map((p) => p.reason))], after_arms: [...new Set(after.map((p) => p.arm))], sample: polls.slice(0, 8) };
      evidence.begins_during_recovery = begins;
      evidence.proposed_gates = {
        poll_answer_within_50ms: { proposed_bound_ms: 50, observed_max_during_recovery_ms: evidence.polls.during_latency.max_ms, note: 'contract proposal (ACCEPTANCE R1), recorded not asserted' },
        heartbeat_max_vs_F2_1MiB: { proposed: 'heartbeat max <= F2 1 MiB bound', observed_heartbeat_max_ms: heartbeat.measured.max_ms, f2_1mib_measured_max_ms: f2ByTier.has(1) ? f2ByTier.get(1).heartbeat.measured.max_ms : null, status: f2ByTier.has(1) ? 'comparison_recorded' : 'incomplete (F2 1 MiB not in this run)' },
      };
      // W5: R1's own post-workload controls, after every workload metric above and before any assertion.
      evidence.heartbeat_controls.idle_post = await heartbeatControl('idle_post', { idleMs: CONTROLS.idlePostMs });
      evidence.heartbeat_controls.block = await heartbeatControl('block', { blockMs: CONTROLS.blockMs });
      evidence.heartbeat_acceptance = heartbeatAcceptance({ wall_ms: phaseWall, n: heartbeat.measured.n, sum_ms: heartbeat.measured.sum_ms, max_ms: heartbeat.measured.max_ms }, evidence.heartbeat_controls);

      // ---- structural assertions ---------------------------------------------------------------
      assert.ok(polls.length >= R1.postOpenPolls, `the poll driver must have run (${polls.length} polls)`);
      assert.equal(polls.filter((p) => p.arm === 'threw').length, 0, 'every poll is answered, never thrown');
      for (const p of during) {
        assert.equal(p.tracking_state, 'unavailable', 'a poll during recovery is unavailable, never a record and never a 404-shaped absence');
        assert.equal(p.reason, 'recovering', `contract (ACCEPTANCE R1): a poll during recovery names \`recovering\`; observed \`${p.reason}\` (if \`not_opened\`: the frozen daemon.js initial reason — product evidence)`);
      }
      for (const p of after) assert.ok(p.arm === 'record', `after open, polls for seeded ids are served from the store (arm=${p.arm}, reason=${p.reason})`);
      for (const b of begins) {
        assert.equal(b.healthy, false, 'the begin was issued while the store was still opening');
        assert.equal(b.status, 503, `contract (ACCEPTANCE R1): begin while recovering is 503 TRACKING_CAPACITY; observed ${b.status} ${b.code} ${b.reason} (500 tracking_persistence_failed with reason not_opened is the frozen daemon.js behaviour by code reading — product evidence)`);
        assert.equal(b.reason, 'recovering');
      }
      assert.equal(R.delivery.length, 0, 'no begin issued during recovery delivered anything');
      assert.deepEqual(evidence.messages.over_64KiB_outside_exceptions, [], 'no main-thread message above 64 KiB outside ack.entry/submit.delta (snapshot/read chunks are bounded)');
      assert.equal(evidence.heartbeat_acceptance.verdict, 'pass', `heartbeat acceptance (sampled the whole measured phase incl. the ${openWall.toFixed(0)} ms open, no main-loop gap >= ${HEARTBEAT_CONTRACT.stallBoundMs} ms, valid same-process controls): ${JSON.stringify(evidence.heartbeat_acceptance)}`);
      failed = false;
      r1ByTier.set(tier, evidence);
    } finally {
      if (pollTimer) clearInterval(pollTimer);
      try { const late = hb.stop(); if (!evidence.heartbeat) evidence.heartbeat_on_early_failure = late; } catch { /* already stopped */ }
      evidence.closed = await H.closeBounded(ledgerClient, 2000);
      evidence.finished_at = new Date().toISOString(); evidence.failed = failed;
      const file = H.writeEvidence(EVIDENCE, `R1-${tier}MiB.json`, evidence);
      console.log(`[ledger-1207 R1 ${tier} MiB] evidence=${file} open_ms=${evidence.open && evidence.open.wall_ms} polls=${JSON.stringify(evidence.polls && { total: evidence.polls.total, during: evidence.polls.during_recovery })} heartbeat.measured=${JSON.stringify(evidence.heartbeat && evidence.heartbeat.measured)}`);
      console.log(`[ledger-1207 R1 ${tier} MiB] heartbeat_controls=${JSON.stringify(evidence.heartbeat_controls)} heartbeat_acceptance=${JSON.stringify(evidence.heartbeat_acceptance || null)}`);
      console.log(`[ledger-1207 R1 ${tier} MiB] heartbeat_gap_diagnostics=${JSON.stringify(compactGapDiag((evidence.heartbeat || evidence.heartbeat_on_early_failure || {}).diagnostics))}`);
      if (failed) console.log(`[ledger-1207 R1 ${tier} MiB] FAILED — private HOME preserved for diagnosis: ${store.home}`);
      else fs.rmSync(store.home, { recursive: true, force: true });
    }
  });
}

// ------------------------------------------------------------------------------------------------
// Cross-tier comparison: recorded when ≥ 2 tiers ran in this process; otherwise marked incomplete.
// The 3× figure is the F2 contract PROPOSAL; it is recorded against observed ratios, not asserted.
// ------------------------------------------------------------------------------------------------
test('F2/R1 cross-tier comparison (same run): ratios recorded against the proposed 3x gate; incomplete when one tier is selected', () => {
  const summary = { tiers_selected: TIERS, f2_tiers_measured: [...f2ByTier.keys()], r1_tiers_measured: [...r1ByTier.keys()], generated_at: new Date().toISOString(),
    metric_limits: ['process_cpu is whole-process CPU incl. the owner worker thread (Node 20 process.cpuUsage); main-thread CPU attribution UNMEASURED', 'message sizes are a JSON serialization proxy, not structured-clone bytes', 'poll latency is the handler DATA PATH, not the HTTP handler'] };
  if (TIERS.length < 2 || !f2ByTier.has(1)) {
    summary.cross_tier_gate = 'INCOMPLETE: one tier selected (default 1 MiB) or the 1 MiB reference did not complete; comparison-ready evidence emitted per tier (F2-<tier>MiB.json, R1-<tier>MiB.json)';
  } else {
    const ref = f2ByTier.get(1);
    summary.f2_ratios_vs_1MiB = {};
    for (const [tier, ev] of f2ByTier) {
      if (tier === 1) continue;
      summary.f2_ratios_vs_1MiB[`${tier}MiB`] = {
        heartbeat_max_ratio: ev.heartbeat.measured.max_ms / Math.max(ref.heartbeat.measured.max_ms, 0.001),
        heartbeat_p99_ratio: ev.heartbeat.measured.p99_ms / Math.max(ref.heartbeat.measured.p99_ms, 0.001),
        process_cpu_user_per_flip_ratio: (ev.process_cpu_measured.user_ms / F2.measuredFlips) / Math.max(ref.process_cpu_measured.user_ms / F2.measuredFlips, 0.001),
        proposed_gate: '<= 3 (contract proposal, recorded not asserted)',
      };
    }
    summary.cross_tier_gate = 'RECORDED (same run)';
  }
  const file = H.writeEvidence(EVIDENCE, 'CROSS-TIER.json', summary);
  console.log(`[ledger-1207 cross-tier] ${file} ${summary.cross_tier_gate}`);
  assert.ok(fs.existsSync(file), 'the comparison evidence file is written');
});

// ------------------------------------------------------------------------------------------------
// W5 — deterministic negative controls for the heartbeat acceptance predicate (pure; no I/O, no timing).
// The "measured" windows are the exact Windows CI 5971070 / job 124536950446 values (sum_ms = mean_ms × n where the
// log only printed the mean); every other window is a synthetic counterexample.
// ------------------------------------------------------------------------------------------------
test('W5 heartbeat acceptance predicate: rejects zero sampling, stalls, incomplete coverage and invalid baselines; accepts the measured win32 idle-timer windows', () => {
  const ciControls = Object.freeze({
    idle_pre: { n: 73, wall_ms: 751.822, sum_ms: 73 * 10.295071232876714, max_ms: 19.2604 },
    idle_post: { n: 57, wall_ms: 758.8164, sum_ms: 57 * 13.311759649122807, max_ms: 16.0523 },
    block: { n: 33, wall_ms: 521.8245, sum_ms: 33 * 15.809027272727272, max_ms: 100.2268, block_requested_ms: 100 },
  });
  const ciF2 = Object.freeze({ n: 247, wall_ms: 2041.1315, sum_ms: 2041.079399999999, max_ms: 27.3317 });
  const ciR1 = Object.freeze({ n: 252, wall_ms: 2192.4456, sum_ms: 2192.4456000000005, max_ms: 18.1287 });  // R1 phase wall not logged by the old file: sum used as wall
  const with_ = (base, patch) => ({ ...base, ...patch });
  const verdictOf = (w, c = ciControls) => heartbeatAcceptance(w, c).verdict;
  const oldRule = (w) => w.n >= Math.floor(w.wall_ms / 2);
  const observed = {
    // the false positive removed: the old count rejects even IDLE on win32; the new contract accepts these windows
    old_rule_on_ci: { idle_pre: oldRule(ciControls.idle_pre), idle_post: oldRule(ciControls.idle_post), f2: oldRule(ciF2), r1_open: 252 >= Math.floor(529.345 / 2) },
    ci_f2: verdictOf(ciF2),
    ci_r1: verdictOf(ciR1),
    // workload rejections (controls valid)
    zero_samples: verdictOf({ n: 0, wall_ms: 2041.1315, sum_ms: 0, max_ms: null }),
    disabled_sampler: verdictOf(null),
    large_stall: verdictOf(with_(ciF2, { max_ms: 100.2268 })),
    stall_at_bound: verdictOf(with_(ciF2, { max_ms: 50 })),
    unsampled_tail_stall: verdictOf(with_(ciF2, { sum_ms: ciF2.wall_ms - 120 })),
    unsampled_tail_at_bound: verdictOf({ n: 247, wall_ms: 2048, sum_ms: 1998, max_ms: 27.3317 }),  // exactly 50 ms unsampled (integers: exact in binary)
    incomplete_phase_coverage: verdictOf({ n: 40, wall_ms: 2041.1315, sum_ms: 640, max_ms: 16.2 }),
    sum_exceeds_window: verdictOf(with_(ciF2, { sum_ms: ciF2.wall_ms + 25 })),
    // invalid baselines: never a pass, even with a perfect workload window
    idle_overloaded: verdictOf(ciF2, with_(ciControls, { idle_pre: with_(ciControls.idle_pre, { max_ms: 60 }) })),
    idle_zero_samples: verdictOf(ciF2, with_(ciControls, { idle_post: { n: 0, wall_ms: 758.8164, sum_ms: 0, max_ms: null } })),
    idle_missing: verdictOf(ciF2, with_(ciControls, { idle_pre: null })),
    block_not_visible: verdictOf(ciF2, with_(ciControls, { block: with_(ciControls.block, { max_ms: 16.2 }) })),
    block_missing_request: verdictOf(ciF2, with_(ciControls, { block: with_(ciControls.block, { block_requested_ms: undefined }) })),
  };
  assert.deepEqual(observed, {
    old_rule_on_ci: { idle_pre: false, idle_post: false, f2: false, r1_open: false },
    ci_f2: 'pass', ci_r1: 'pass',
    zero_samples: 'fail', disabled_sampler: 'fail', large_stall: 'fail', stall_at_bound: 'fail', unsampled_tail_stall: 'fail', unsampled_tail_at_bound: 'fail',
    incomplete_phase_coverage: 'fail', sum_exceeds_window: 'fail',
    idle_overloaded: 'inconclusive', idle_zero_samples: 'inconclusive', idle_missing: 'inconclusive', block_not_visible: 'inconclusive', block_missing_request: 'inconclusive',
  }, JSON.stringify(observed));
});
