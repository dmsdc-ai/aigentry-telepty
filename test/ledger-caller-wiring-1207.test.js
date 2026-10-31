'use strict';

// #1207 — factory gate: the REAL runtime/actions factories, the REAL inject handler captured from
// registerInjectRoute, the REAL ledger client with the REAL owner worker, private HOME, recorders
// at the delivery / bus / audit boundaries. No daemon, listener, socket or PTY. Covers the factory
// halves of ACCEPTANCE F1, F3, F4, F5, C2, N1, I5 (durable case), W1 (first half), X2, X3 and E5
// (pre-admission rejection, nothing persisted). Author-written; the 64 MiB tier is opt-in
// (TELEPTY_LEDGER_1207_TIER=64) and measured values are REPORTED, never asserted as bounds.
//
// Prerequisites: node:worker_threads; a writable temp dir; POSIX for X2/X3 errno recording.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const persistence = require('../src/session-store/persistence');
const completion = require('../src/completion-observation');
const interaction = require('../src/interaction');
const F = require('../src/session-store/ledger-format');
const { createLedgerClient } = require('../src/session-store/ledger-client');
const { createDeliveryRuntime } = require('../src/mailbox/delivery-runtime');
const { createSessionActions } = require('../src/routes/session-actions');
const { SessionStateManager, mapObservationCause, stripAnsi } = require('../session-state');
const { writeLegacyLedger } = require('./fixtures/ledger-1207/legacy-fixture');
const { readFrames, segmentFiles, sha256, shaTree } = require('./fixtures/ledger-1207/owner-harness');

const TIER_MIB = Number(process.env.TELEPTY_LEDGER_1207_TIER || 1);

function makeSession(id) {
  const t = new Date().toISOString();
  return { id, type: 'wrapped', ptyProcess: null, ownerWs: null, command: 'synthetic-cli', cwd: '/synthetic', backend: 'cmux',
    cmuxWorkspaceId: null, cmuxSurfaceId: null, termProgram: null, term: null, createdAt: t, lastActivityAt: t, lastConnectedAt: null,
    lastDisconnectedAt: null, lastStateReportAt: null, stateReport: null, idleTtl: null, idleTtlMs: null, ownerPid: null, ptyPid: null,
    clients: new Set(), isClosing: false, outputRing: [], outputRingTotalBytes: 0, ready: true };
}
function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-wiring-1207-'));
  const parent = path.join(home, '.config', 'aigentry-telepty'); fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  return { home, parent, dir: path.join(parent, 'tracked-injections.json'), lockPath: path.join(parent, 'tracked-injections.lock'), rm: () => fs.rmSync(home, { recursive: true, force: true }) };
}

// daemon.js-shaped shared state + the real runtime + the real actions, on a real ledger client.
function buildShared(store, R, clientOptions = {}) {
  const scheduler = { setInterval: () => ({ stub: true }), clearInterval: () => {} };
  const sessionStateManager = new SessionStateManager({ idle_timeout_ms: 5000, error_repeat_count: 3, error_window_ms: 180000, thinking_timeout_ms: 300000 }, scheduler);
  const busClient = { readyState: 1, send(serialized) { const m = JSON.parse(serialized); R.bus.push({ type: m.type, tracking_result: m.tracking_result || null, kind: m.observation && m.observation.kind, bytes: serialized.length }); } };
  const ledgerClient = createLedgerClient({ dir: store.dir, lockPath: store.lockPath, legacyPath: store.dir, ...clientOptions });
  if (Array.isArray(store.clients)) store.clients.push(ledgerClient);   // closed by withStore in finally
  const shared = {
    sessions: { w1: makeSession('w1'), orch: makeSession('orch') }, pendingReports: Object.create(null),
    trackedLedgerHealthy: false, trackedLedgerUnavailableReason: 'not_opened', TRACKED_INJECTIONS_PATH: store.dir,
    ledgerClient, sessionPersistence: persistence, CAPABILITY_STAGE_A: completion.CAPABILITY_STAGE_A, interaction, completionObservation: completion,
    classifyConsumption: completion.classifyConsumption, buildCompletionUnknown: completion.buildCompletionUnknown,
    shouldPushCompletionUnknown: completion.shouldPushCompletionUnknown, formatCompletionUnknownText: completion.formatCompletionUnknownText,
    mapObservationCause, stripAnsiState: stripAnsi, sessionStateManager,
    AUTO_REPORT_MIN_REAL_SECONDS: 1.0, LAUNCHER_CONSUMPTION_MIN_SECONDS: 30, REPORT_AUTO_SUMMARY_LINES: 40, REPORT_AUTO_SUMMARY_MAX_BYTES: 4096,
    IDLE_UNCONFIRMED_SETTLE_SECONDS: 0.05, IDLE_UNCONFIRMED_SETTLE_MAX_REARMS: 0, IDLE_UNCONFIRMED_CPU_DELTA_SECONDS: 0.1, IDLE_UNCONFIRMED_CPU_MAX_REARMS: 0,
    busClients: [busClient], crypto, fs, MACHINE_ID: 'synthetic-host', ORCHESTRATOR_SIDS: ['orch'],
    SESSION_STALE_SECONDS: 300, UPSTREAM_STALL_SECONDS: 120, interactionWaiters: new Map(), deliveredAbsenceIdentities: new WeakMap(),
    auditWriter: { append(r) { R.audit.push({ inject_id: r.inject_id, delivery_result: r.delivery_result, to: r.to }); } },
    sessionCredentials: { verify() { R.unexpected.push('verify'); throw new Error('unreached'); } },
    isOpenWebSocket: () => false, isBootstrapGatedSession: () => false, isProcessRunning: () => false,
    resolveSessionAlias: (id) => (Object.prototype.hasOwnProperty.call(shared.sessions, id) ? id : null),
    sampleChildCpuSeconds: () => null, buildAutoSummary: () => 'synthetic summary', submitGate: { observeBodyVisibility: () => ({ visible: false }) },
    readyRegistry: { observeInteraction: () => interaction.unavailableObservation() },
    // RECORDED EXTERNAL BOUNDARY: notes what the ACTIVE SEGMENT held at the instant of the call.
    deliverInjectionToSession: async (id, session, prompt, options) => {
      const injectId = options && options.injectId;
      const frames = segmentFiles(store.dir).flatMap((f) => readFrames(f).frames.map((x) => x.obj));
      const beginFrame = frames.find((x) => x.t === 'begin' && x.id === injectId);
      const covered = beginFrame && frames.some((x) => x.t === 'commit' && x.epoch === beginFrame.epoch && x.seq_from <= beginFrame.seq && beginFrame.seq <= x.seq_to);
      R.delivery.push({ id, injectId: injectId || null, promptBytes: Buffer.byteLength(prompt), beginOnDisk: !!beginFrame, commitCovers: !!covered, source: options && options.source });
      return { success: true, strategy: 'recorder_delivery', submit: 'recorder' };
    },
  };
  const runtime = createDeliveryRuntime(shared);
  Object.assign(shared, runtime);
  const actions = createSessionActions(shared, {});
  Object.assign(shared, { recordObservation: actions.recordObservation, fireAutoReport: actions.fireAutoReport });
  let handler = null;
  actions.registerInjectRoute({ post(route, fn) { if (route === '/api/sessions/:id/inject') handler = fn; } });
  assert.equal(typeof handler, 'function');
  shared.interactionCore = runtime.createInteractionRuntime();
  return { shared, runtime, actions, handler, ledgerClient };
}
const recorders = () => ({ audit: [], delivery: [], bus: [], unexpected: [] });
const makeReq = (prompt, from = 'orch') => ({ params: { id: 'w1' }, body: { prompt, from }, headers: {} });
function makeRes() { const r = { statusCode: 200, body: null, jsonCalls: 0, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; r.jsonCalls++; return r; } }; return r; }

// resume4 — every ledger client a test builds is CLOSED in finally (deadline-raced, then the worker
// is terminated), on success and on a failed assertion alike, so a failure can never leave the
// owner worker alive and the runner hanging. Close is idempotent for a client already closed by the
// test body. The private HOME is preserved for diagnosis when the body threw.
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
  const s = tmpHome();
  s.clients = [];
  let failed = true;
  try { const r = await fn(s); failed = false; return r; } finally {
    for (const c of s.clients) { try { await closeBounded(c, 2000); } catch { /* reported by the test body */ } }
    if (failed) console.log(`[ledger-1207 caller] FAILED — private HOME preserved for diagnosis: ${s.home}`);
    else s.rm();
  }
}

test('F5: the real inject handler answers 200 only after the begin is commit-framed on disk; the recorder sees the durable frame BEFORE the transport is asked to write', () => withStore(async (s) => {
  const R = recorders();
  const { shared, runtime, handler, ledgerClient } = buildShared(s, R);
  const opened = await runtime.restoreTrackedInjections();
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(shared.trackedLedgerHealthy, true);
  const res = makeRes();
  await handler(makeReq('synthetic task body'), res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.success, true);
  assert.equal(R.delivery.length, 1);
  assert.deepEqual([R.delivery[0].beginOnDisk, R.delivery[0].commitCovers], [true, true], 'durable before delivery');
  assert.equal(R.delivery[0].injectId, res.body.inject_id);
  assert.deepEqual(R.audit, [{ inject_id: res.body.inject_id, delivery_result: 'success', to: 'w1' }]);
  assert.equal(shared.pendingReports.w1.injectId, res.body.inject_id);
  const hot = ledgerClient.readModel.getTrackedInjection(res.body.inject_id);
  assert.equal(hot.tracking_state, 'tracked'); assert.equal(hot.observations[0].kind, 'tracking_started');
  const fetched = await ledgerClient.fetchTrackedInjection(res.body.inject_id);
  assert.equal(fetched.record.observation_seq, 1);
  const closed = await ledgerClient.close(2000);
  assert.equal(closed.closed.clean, true); assert.equal(closed.lock.released, true);
  assert.equal(fs.existsSync(s.lockPath), false);
  assert.deepEqual(R.unexpected, []);
}));

test('F1/F3/F4 (1 MiB tier; 64 MiB opt-in): per-event owner bytes <= 16 KiB and independent of history; <= 1 fsync and 0 renames per event; main-thread store writes == 0; no-op controls write nothing', () => withStore(async (s) => {
  const seeded = writeLegacyLedger(s.dir, { targetBytes: TIER_MIB * 1048576, obsPerRecord: 12 });
  const R = recorders();
  const { shared, runtime, handler, actions, ledgerClient } = buildShared(s, R);
  const t0 = Date.now();
  const opened = await runtime.restoreTrackedInjections();
  const openMs = Date.now() - t0;
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(opened.counts.cold, seeded.count);
  // main-thread instrumentation AFTER open (the one legitimate main-thread write is the O_EXCL lock
  // at acquire): from here on, any write to the store from THIS thread is a defect.
  const realWrite = fs.writeSync; const realWriteFile = fs.writeFileSync; let mainWrites = 0;
  fs.writeSync = function (...a) { mainWrites++; return realWrite.apply(fs, a); };
  fs.writeFileSync = function (p, ...a) { if (typeof p === 'string' && p.startsWith(s.parent)) mainWrites++; return realWriteFile.call(fs, p, ...a); };
  try {
    const io0 = (await ledgerClient.ownerStatus()).io;
    // C0 control: a transition with no pending report → 0 submits, 0 owner writes
    actions.registerStateObserver();
    shared.sessionStateManager.register('w1');
    shared.sessionStateManager.feed('w1', 'tool output line\r\n');
    await new Promise((r) => setTimeout(r, 30));
    const ioC0 = (await ledgerClient.ownerStatus()).io;
    assert.deepEqual([ioC0.writes, ioC0.fsyncs], [io0.writes, io0.fsyncs], 'C0: no pending report ⇒ nothing written');
    // begin (the real handler)
    const res = makeRes(); await handler(makeReq('work'), res); assert.equal(res.statusCode, 200);
    const ioB = (await ledgerClient.ownerStatus()).io;
    const beginBytes = ioB.bytes - ioC0.bytes;
    // C2: 8 alternations busy/plain at 20 ms through the REAL state manager → recordObservation
    const samples = [];
    for (let k = 0; k < 8; k++) {
      const before = (await ledgerClient.ownerStatus()).io;
      shared.sessionStateManager.feed('w1', k % 2 === 0 ? '\x1b[2K\r✻ Thinking… (esc to interrupt)\r\n' : `tool output line ${k}\r\n`);
      await new Promise((r) => setTimeout(r, 20));
      await ledgerClient.ownerStatus();
      const after = (await ledgerClient.ownerStatus()).io;
      samples.push({ bytes: after.bytes - before.bytes, fsyncs: after.fsyncs - before.fsyncs, renames: after.renames - before.renames, writes: after.writes - before.writes });
    }
    const flips = samples.filter((x) => x.writes > 0);
    assert.ok(flips.length >= 2, `at least two alternations must have produced a durable write: ${JSON.stringify(samples)}`);
    for (const x of flips) { assert.ok(x.bytes <= 16384, `per-event bytes ${x.bytes} <= 16384 (history ${seeded.bytes} B)`); assert.ok(x.fsyncs <= 1 && x.renames === 0, JSON.stringify(x)); }
    // C1 control: a duplicate identity → owner no-op (no frame)
    const beforeDup = (await ledgerClient.ownerStatus()).io;
    const last = ledgerClient.readModel.getTrackedInjection(res.body.inject_id).last_observation;
    const dup = await actions.recordObservation({ sessionId: 'w1', session: shared.sessions.w1, pendingReport: shared.pendingReports.w1, destination: last.kind === 'output_observed' ? 'working' : 'thinking', cause: last.trigger, evidence: {}, trigger: 'transition' });
    assert.equal(dup, 'observation_duplicate');
    const afterDup = (await ledgerClient.ownerStatus()).io;
    assert.equal(afterDup.writes, beforeDup.writes, 'C1: duplicate ⇒ no frame, no write');
    assert.equal(mainWrites, 0, 'the main thread never writes to the store');
    // F6: ordering and retention
    const rec = (await ledgerClient.fetchTrackedInjection(res.body.inject_id)).record;
    assert.equal(rec.observations[0].kind, 'tracking_started');
    assert.ok(rec.observation_seq >= 1 + flips.length);
    assert.equal(sha256(fs.readFileSync(path.join(s.dir, 'legacy', 'tracked-injections.v3.json'))), seeded.sha256, 'legacy copy unchanged');
    const status = await ledgerClient.ownerStatus();
    assert.equal(status.counts.cold + status.counts.hot, seeded.count + 1);
    console.log(`[ledger-1207] tier=${TIER_MIB}MiB records=${seeded.count} openMs=${openMs} beginBytes=${beginBytes} perEvent=${JSON.stringify(samples)} rss=${process.memoryUsage().rss} (reported, not asserted)`);
    await ledgerClient.close(2000);
    assert.deepEqual(R.bus.filter((b) => b.type === 'task_completion_unknown').map((b) => b.tracking_result).filter((r) => !['observation_emitted', 'observation_duplicate'].includes(r)), [], 'every bus result is a durable one or a named duplicate');
  } finally { fs.writeSync = realWrite; fs.writeFileSync = realWriteFile; }
}));

// resume4 — the two refusal conditions below (R_MAX admitted jobs; sustained O exhaustion) were
// measured in ONE fixture: the retained R_MAX reservations made the later begin refuse with
// `tracking_capacity_exhausted` where `sustained_exhaustion` was under test. Both conditions held
// and production specifies no precedence between them, so each condition now has a fixture that
// isolates it; no assertion accepts "either reason".

test('C2: reject BEFORE accept — at R_MAX the real handler answers 503 TRACKING_CAPACITY tracking_capacity_exhausted with 0 deliveries; the reserved terminal of an existing job still commits', () => withStore(async (s) => {
  const R = recorders();
  const { runtime, handler, ledgerClient } = buildShared(s, R);
  assert.equal((await runtime.restoreTrackedInjections()).ok, true);
  const first = makeRes(); await handler(makeReq('first'), first); assert.equal(first.statusCode, 200);
  // fill the admitted-jobs cap with reservations (the accounting is the real one)
  for (let i = ledgerClient.accounting.status().admitted_jobs; i < F.R_MAX_JOBS; i++) assert.equal(ledgerClient.accounting.reserveJob(`cap-${i}`).ok, true);
  const res = makeRes(); await handler(makeReq('one too many'), res);
  assert.equal(res.statusCode, 503); assert.equal(res.body.code, 'TRACKING_CAPACITY'); assert.equal(res.body.reason, 'tracking_capacity_exhausted'); assert.equal(res.body.tracking_state, 'unavailable');
  assert.equal(R.delivery.length, 1, 'no delivery for the refused inject');
  assert.deepEqual(R.audit.map((a) => a.delivery_result), ['success']);
  assert.ok(R.bus.some((b) => b.type === 'inject_failed'), 'bus hears the refusal');
  // the first job's terminal still commits on its reserved unit
  const aborted = await runtime.abortTrackedInjection(first.body.inject_id, 'w1', 'DELIVERY_FAILED', 'x'.repeat(2048));
  assert.equal(aborted, 'tracking_aborted');
  const rec = ledgerClient.readModel.getTrackedInjection(first.body.inject_id);
  assert.equal(rec.tracking_state, 'aborted'); assert.equal(rec.last_observation.delivery_error_truncated, true); assert.equal(Buffer.byteLength(rec.last_observation.delivery_error), 1024);
  // only the R_MAX condition held here: releasing the cap reservations restores begins
  for (let i = 0; i < F.R_MAX_JOBS; i++) ledgerClient.accounting.releaseJob(`cap-${i}`);
  const after = makeRes(); await handler(makeReq('after release'), after);
  assert.equal(after.statusCode, 200, JSON.stringify(after.body));
  await ledgerClient.close(2000);
}));

test('E5: a full O pool rejects transition observations pre-admission (named on the bus, nothing persisted, nothing queued); sustained exhaustion refuses new begins with sustained_exhaustion; begins resume after room for 5 s; no suppression frame exists', () => withStore(async (s) => {
  let now = 1_000_000;
  const R = recorders();
  const { shared, runtime, handler, actions, ledgerClient } = buildShared(s, R, { now: () => now });
  assert.equal((await runtime.restoreTrackedInjections()).ok, true);
  // the only job reservation in this fixture is the one begin below: R_MAX cannot be the refusal reason
  // E5: fill the O pool to its exact entry/byte capacity (each unit reserves the 16 KiB frame cap,
  // so the byte bound binds first) WITHOUT a rejection yet; a transition observation is then
  // rejected pre-admission, nothing persisted
  let filled = 0;
  for (;;) {
    const st = ledgerClient.accounting.status().inflight.O;
    if (st.entries + 1 > F.POOLS.O.entries || st.bytes + 16384 > F.POOLS.O.bytes) break;
    assert.equal(ledgerClient.accounting.admit('O', 16384).ok, true); filled++;
  }
  assert.ok(filled >= 256, `O pool holds at least 256 cap-sized units (${filled})`);
  const second = makeRes(); await handler(makeReq('second'), second);
  // a begin while O is full but not yet "sustained" is still admitted (T+R are reserved separately)
  assert.equal(second.statusCode, 200);
  const ioBefore = (await ledgerClient.ownerStatus()).io;
  const result = await actions.recordObservation({ sessionId: 'w1', session: shared.sessions.w1, pendingReport: shared.pendingReports.w1, destination: 'working', cause: 'output_received', evidence: {}, trigger: 'transition' });
  assert.equal(result, 'tracking_backpressure');
  assert.equal(R.bus.filter((b) => b.tracking_result === 'tracking_backpressure').length, 1, 'named on the bus');
  const ioAfter = (await ledgerClient.ownerStatus()).io;
  assert.equal(ioAfter.writes, ioBefore.writes, 'nothing persisted, nothing queued');
  assert.equal(ledgerClient._internal.inflight.size, 0, 'no retained main-thread queue');
  // sustained: the pool rejected within 5 s and is still full ⇒ begin refused with sustained_exhaustion
  now += 100;
  assert.ok(ledgerClient.accounting.status().admitted_jobs < F.R_MAX_JOBS, 'fixture isolation: the admitted-jobs cap is NOT reached, so only the sustained condition can refuse');
  const third = makeRes(); await handler(makeReq('third'), third);
  assert.equal(third.statusCode, 503); assert.equal(third.body.code, 'TRACKING_CAPACITY'); assert.equal(third.body.reason, 'sustained_exhaustion');
  assert.equal(R.delivery.length, 1, 'the refused begin delivered nothing');
  // room returns and 5 s pass ⇒ begins resume
  for (let i = 0; i < filled; i++) ledgerClient.accounting.release('O', 16384);
  now += 6000;
  ledgerClient.accounting.sustainedExhaustion(now);
  const fourth = makeRes(); await handler(makeReq('fourth'), fourth);
  assert.equal(fourth.statusCode, 200);
  // grep every segment: no suppression record anywhere, accepted == persisted
  const kinds = segmentFiles(s.dir).flatMap((f) => readFrames(f).frames.map((x) => x.obj.t === 'obs' ? x.obj.observation.kind : null)).filter(Boolean);
  assert.equal(kinds.includes('observations_suppressed'), false);
  await ledgerClient.close(2000);
}));

test('N1: the interaction core on the owner — I reservation before saveRecord; prepared/dispatched/final each durable before the next stage; lookup from the read model; busy on a concurrent act', () => withStore(async (s) => {
  const R = recorders();
  const { shared, runtime, ledgerClient } = buildShared(s, R);
  assert.equal((await runtime.restoreTrackedInjections()).ok, true);
  const NOW = Date.now();
  const r = { schema_version: 1, action_id: 'a1', interaction_request_id: 'ir1', identity: { kind: 'manual', sid: 'w1' },
    expected: { sid: 'w1', session_epoch: 'e1', credential_generation: 1, owner_generation: 'o1', input_generation: 1, geometry_generation: 1, prompt_revision: 'r1', frame_digest: 'a'.repeat(64), surface_id: 'surface1', cols: 80, rows: 24, question_id: 'q1' },
    operation: 'key', value: 'down', authority: { provenance: 'controller-policy', reference: 'p1' }, expires_at: NOW + 10000 };
  const observation = { ...r.expected, available: true, current_frame: true, provenance: 'measured-provider', expires_at: NOW + 20000, mode: 'single_choice', routine: true, supported_operations: ['key'] };
  const stages = [];
  let release;
  const core = interaction.createInteractionCore({
    readLedger: () => ({ interactions: ledgerClient.readModel.interactionsView() }),
    commitLedger: async (next, change) => { const o = await ledgerClient.submit('iact', { action: change.record, pending: change.pending || null }, { class: 'I' }); stages.push([change.record.stage, o.outcome]); return o.outcome === 'ack'; },
    observe: () => observation, binding: () => ({ ...r.expected }), authorize: (p) => p === 'ctl', pendingTask: () => null,
    dispatch: () => new Promise((resolve) => { release = resolve; }),
    reserveAct: (sid) => ledgerClient.accounting.reserveAct(sid), releaseAct: (sid) => ledgerClient.accounting.releaseAct(sid),
  });
  const acting = core.act(r, 'ctl');
  await new Promise((res) => setTimeout(res, 60));
  assert.deepEqual(stages, [['prepared', 'ack'], ['dispatched', 'ack']], 'each stage acked (durable) before the next');
  assert.equal(ledgerClient.readModel.actionCount(), 1);
  assert.equal(core.lookup('a1').stage, 'dispatched');
  assert.equal(ledgerClient.accounting.status().acts, 1, 'the I reservation is held for the act');
  assert.equal((await core.act({ ...r, action_id: 'a2' }, 'ctl')).reason, 'busy');
  release({ stage: 'written', bytes_written: 3, reason: null });
  const receipt = await acting;
  assert.equal(receipt.stage, 'written');
  assert.equal(stages.length, 3);
  assert.equal(ledgerClient.accounting.status().acts, 0, 'released in finally');
  assert.equal(ledgerClient.readModel.hasHeldInteraction('w1'), false);
  await ledgerClient.close(2000);
  // the receipt survives a reopen through the hot checkpoint
  const again = createLedgerClient({ dir: s.dir, lockPath: s.lockPath });
  s.clients.push(again);   // closed by withStore in finally even if an assertion below fails
  assert.equal((await again.open()).ok, true);
  assert.equal(again.readModel.interactionsView().actions.a1.stage, 'written');
  await again.close(2000);
}));

test('I5 / W1: a resubmitted begin for a durable inject_id is already_exists (idempotency, not retry); worker.terminate() makes inflight work indeterminate owner_failed and respawns once, after the exit event', () => withStore(async (s) => {
  const R = recorders();
  let now = 5_000_000;
  const { runtime, ledgerClient } = buildShared(s, R, { now: () => now, respawnPolicy: { maxPerWindow: 1, windowMs: 60000 } });
  assert.equal((await runtime.restoreTrackedInjections()).ok, true);
  const first = await runtime.beginTrackedInjection({ injectId: 'dup-1', sessionId: 'w1', source: 'orch', session: null });
  assert.equal(first.ok, true);
  const dup = await runtime.beginTrackedInjection({ injectId: 'dup-1', sessionId: 'w1', source: 'orch', session: null });
  assert.equal(dup.ok, false); assert.equal(dup.reason, 'already_exists');
  // W1: terminate mid-group
  const worker = ledgerClient._internal.worker;
  const gen0 = ledgerClient._internal.workerGen;
  const pending = ledgerClient.submit('obs', { id: 'dup-1', observation: { kind: 'output_observed', trigger: 'output_received', at: new Date().toISOString() } }, { class: 'O' });
  await worker.terminate();
  const outcome = await pending;
  assert.equal(outcome.outcome, 'indeterminate'); assert.equal(outcome.reason, 'owner_failed');
  assert.equal(ledgerClient.status().unresolved_count, 1);
  // respawn happened once, after exit; the read model is rebuilt from a chunked snapshot
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(ledgerClient._internal.workerGen, gen0 + 1);
  await new Promise((resolve) => { const t = setInterval(() => { if (ledgerClient.state === 'available') { clearInterval(t); resolve(); } }, 20); });
  assert.equal(ledgerClient.readModel.getTrackedInjection('dup-1').tracking_state, 'tracked');
  // the owner settled the txn from receipts or unapplied lists — or left it unresolved; never by inference
  const u = ledgerClient.status().unresolved[0];
  assert.ok(['committed', 'not_applied', 'unresolved', undefined].includes(u.settled));
  // second failure inside the window stays unavailable (no loop)
  await ledgerClient._internal.worker.terminate();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(ledgerClient.state, 'unavailable'); assert.equal(ledgerClient.reason, 'owner_failed');
  const refused = await runtime.beginTrackedInjection({ injectId: 'after', sessionId: 'w1', source: 'orch', session: null });
  assert.equal(refused.ok, false); assert.equal(refused.capacity, true); assert.equal(refused.reason, 'owner_failed');
  await ledgerClient.close(500);
}));

test('X2 / X3: the frozen 0.9.1 bodies (unguarded 2657ac73 and guard d7789bd1) cannot write a directory store — restore unhealthy, the real inject handler answers 500 three times, zero deliveries, directory unchanged', { skip: process.platform === 'win32' && 'errno recorded on POSIX; Windows unsupported for cutover until measured' }, () => withStore(async (s) => {
  // the directory store, published by the current owner
  const R0 = recorders();
  const { runtime: cur, ledgerClient } = buildShared(s, R0);
  assert.equal((await cur.restoreTrackedInjections()).ok, true);
  assert.equal((await cur.beginTrackedInjection({ injectId: 'kept', sessionId: 'w1', source: 'orch', session: null })).ok, true);
  await ledgerClient.close(2000);
  const inventory = require('./fixtures/0.9.1/INVENTORY.json');
  for (const f of inventory.files) assert.equal(sha256(fs.readFileSync(path.join(__dirname, 'fixtures/0.9.1', f.path))), f.sha256, `${f.path} frozen byte-exact`);
  const installedPersistence = require('./fixtures/0.9.1/src/session-store/persistence');
  const installedInteraction = require('./fixtures/0.9.1/src/interaction');
  const installedCompletion = require('./fixtures/0.9.1/src/completion-observation');
  const { createSessionActions: installedActions } = require('./fixtures/0.9.1/src/routes/session-actions');
  for (const variant of ['src/mailbox/delivery-runtime.js', 'guard/src/mailbox/delivery-runtime.js']) {
    const { createDeliveryRuntime: installedRuntime } = require(path.join(__dirname, 'fixtures/0.9.1', variant));
    const before = shaTree(s.dir);
    const R = recorders();
    const shared = {
      sessions: { w1: makeSession('w1') }, pendingReports: {}, trackedInjections: installedPersistence.emptyTrackedInjections(), trackedLedgerHealthy: true, trackedLedgerUnavailableReason: null,
      TRACKED_INJECTIONS_PATH: s.dir, sessionPersistence: installedPersistence, CAPABILITY_STAGE_A: installedCompletion.CAPABILITY_STAGE_A, interaction: installedInteraction,
      busClients: [], crypto, fs, MACHINE_ID: 'h', ORCHESTRATOR_SIDS: ['orch'], SESSION_STALE_SECONDS: 300, UPSTREAM_STALL_SECONDS: 120, interactionWaiters: new Map(), deliveredAbsenceIdentities: new WeakMap(),
      auditWriter: { append(r) { R.audit.push(r.delivery_result); } }, sessionCredentials: { verify() { throw new Error('unreached'); } }, isOpenWebSocket: () => false, isBootstrapGatedSession: () => false, isProcessRunning: () => false,
      resolveSessionAlias: (id) => (id === 'w1' ? id : null),
      deliverInjectionToSession: async () => { R.delivery.push('CALLED'); return { success: true }; },
    };
    const rt = installedRuntime(shared); Object.assign(shared, rt);
    const acts = installedActions(shared, {}); let handler = null; acts.registerInjectRoute({ post(route, fn) { if (route === '/api/sessions/:id/inject') handler = fn; } });
    rt.restoreTrackedInjections();
    assert.equal(shared.trackedLedgerHealthy, false, `${variant}: a directory at the path is an unreadable store for 0.9.1`);
    for (let i = 0; i < 3; i++) {
      const res = makeRes(); await handler(makeReq(`body ${i}`), res);
      assert.equal(res.statusCode, 500, `${variant} #${i}`); assert.equal(res.body.code, 'TRACKING_PERSISTENCE_FAILED');
    }
    assert.deepEqual(R.delivery, [], `${variant}: zero delivery calls`);
    assert.deepEqual(R.audit, [], `${variant}: no audit success`);
    assert.deepEqual(shared.pendingReports, {});
    assert.equal(shared.trackedLedgerHealthy, false, 'healthy stays false');
    assert.deepEqual(shaTree(s.dir), before, `${variant}: the directory store is unchanged`);
    if (variant.startsWith('guard')) assert.deepEqual(rt.commitTrackedInjections(), { ok: false, reason: 'observation_store_unavailable' });
    const probe = installedPersistence.saveTrackedInjections(installedPersistence.emptyTrackedInjections(), s.dir);
    assert.equal(probe.ok, false);
    console.log(`[ledger-1207] X1 errno on ${process.platform}: ${probe.error && probe.error.code}`);
  }
}));
