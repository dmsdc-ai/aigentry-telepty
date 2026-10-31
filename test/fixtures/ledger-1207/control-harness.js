'use strict';

// #1207 control-responsiveness harness (F2 / R1 evidence source). Test support only; never shipped.
//
// Builds the REAL runtime (createDeliveryRuntime), the REAL session actions (createSessionActions,
// including the real `POST /api/sessions/:id/inject` handler captured through an in-process route
// registrar), the REAL SessionStateManager and the REAL ledger client with its REAL owner worker,
// on a private HOME whose ledger is a seeded 0.9.1 legacy file migrated at open. Recorders sit only
// at the external boundaries (delivery, bus, audit). An in-process handler call is NOT HTTP, a real
// daemon or a PTY; the daemon.js poll handler body is registered inline on the express app and is
// not reachable here — only its data path (`shared.trackedLedgerHealthy`, `ledgerClient.state`,
// `fetchTrackedInjection`) is, and the test says so wherever it drives it.
//
// Metric honesty: `process.cpuUsage()` measures the whole PROCESS including worker threads in
// Node 20; it is labelled `process_cpu` everywhere and is never presented as main-thread CPU.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');

const persistence = require('../../../src/session-store/persistence');
const completion = require('../../../src/completion-observation');
const interaction = require('../../../src/interaction');
const { createLedgerClient } = require('../../../src/session-store/ledger-client');
const { createDeliveryRuntime } = require('../../../src/mailbox/delivery-runtime');
const { createSessionActions } = require('../../../src/routes/session-actions');
const { SessionStateManager, mapObservationCause, stripAnsi } = require('../../../session-state');
const { writeLegacyLedger } = require('./legacy-fixture');

const MiB = 1048576;
const MESSAGE_MAX_BYTES = 65536;          // PROTOCOL.json size_rules.max_message_bytes
const FRAME_CAP_LARGE = 1056768;          // iact cap: the largest allowed ack.entry / submit.delta

// ---- tier selection -------------------------------------------------------------------------
// Exact environment option. Default is 1 MiB ONLY; 8 and 64 are selected explicitly, never implied.
function selectedTiers(env = process.env) {
  const raw = (env.TELEPTY_LEDGER_1207_TIERS || '1').trim();
  const tiers = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const allowed = new Set(['1', '8', '64']);
  for (const t of tiers) if (!allowed.has(t)) throw new Error(`TELEPTY_LEDGER_1207_TIERS: unknown tier "${t}" (allowed: 1,8,64 MiB)`);
  return [...new Set(tiers)].map(Number);
}

// ---- private HOME / store ----------------------------------------------------------------------
function privateStore(prefix) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const parent = path.join(home, '.config', 'aigentry-telepty');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  return { home, parent, dir: path.join(parent, 'tracked-injections.json'), lockPath: path.join(parent, 'tracked-injections.lock') };
}
function seedTier(store, tierMiB, obsPerRecord = 12) {
  return writeLegacyLedger(store.dir, { targetBytes: tierMiB * MiB, obsPerRecord, prefix: `hist-${tierMiB}MiB` });
}

// ---- heartbeat sampler (1 ms main-loop timer) ------------------------------------------------------
// Gap = time between consecutive timer callbacks minus the 1 ms period; a blocked main loop shows up
// as large gaps. Samples are split at `mark()` boundaries so warm-up and measurement are separate.
function startHeartbeat({ periodMs = 1, cap = 100000 } = {}) {
  const phases = { warmup: [], measured: [], tail: [] };
  let phase = 'warmup';
  let last = process.hrtime.bigint();
  let dropped = 0;
  const timer = setInterval(() => {
    const now = process.hrtime.bigint();
    const gapMs = Number(now - last) / 1e6;
    last = now;
    const arr = phases[phase];
    if (arr.length < cap) arr.push(gapMs); else dropped++;
  }, periodMs);
  return {
    mark(next) { phase = next; last = process.hrtime.bigint(); },
    stop() { clearInterval(timer); return { ...summarizeAll(phases), dropped, period_ms: periodMs }; },
  };
}
function percentile(sorted, p) { if (!sorted.length) return null; const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1)); return sorted[i]; }
function summarize(samples) {
  const s = samples.slice().sort((a, b) => a - b);
  return { n: s.length, max_ms: s.length ? s[s.length - 1] : null, p50_ms: percentile(s, 0.5), p90_ms: percentile(s, 0.9), p99_ms: percentile(s, 0.99),
    over_10ms: s.filter((x) => x > 10).length, over_50ms: s.filter((x) => x > 50).length, sum_ms: s.reduce((a, b) => a + b, 0) };
}
function summarizeAll(phases) { const out = {}; for (const k of Object.keys(phases)) out[k] = summarize(phases[k]); return out; }

// ---- observed Worker: main-thread message sizes (JSON-serialized size PROXY, not structured-clone bytes)
function makeObservedWorker(record) {
  return class ObservedWorker extends Worker {
    on(event, fn) {
      if (event !== 'message') return super.on(event, fn);
      return super.on('message', (m) => { record.inbound.push(sizeOf(m, m && m.type)); fn(m); });
    }
    postMessage(m, ...rest) { record.outbound.push(sizeOf(m, m && m.type)); return super.postMessage(m, ...rest); }
  };
}
function sizeOf(m, type) { let bytes = 0; try { bytes = Buffer.byteLength(JSON.stringify(m), 'utf8'); } catch { bytes = -1; } return { type: type || null, bytes }; }
function messageSizeReport(record) {
  const all = record.inbound.concat(record.outbound);
  const exceptions = new Set(['ack', 'submit']);       // ack.entry / submit.delta may reach the frame cap
  const over = all.filter((x) => x.bytes > MESSAGE_MAX_BYTES);
  return {
    unit: 'bytes of JSON.stringify(message) — a serialization proxy, not structured-clone size',
    inbound: record.inbound.length, outbound: record.outbound.length,
    max_inbound: Math.max(0, ...record.inbound.map((x) => x.bytes)), max_outbound: Math.max(0, ...record.outbound.map((x) => x.bytes)),
    over_64KiB: over.map((x) => ({ type: x.type, bytes: x.bytes })),
    over_64KiB_outside_exceptions: over.filter((x) => !exceptions.has(x.type)).map((x) => ({ type: x.type, bytes: x.bytes })),
    over_frame_cap: all.filter((x) => x.bytes > FRAME_CAP_LARGE).map((x) => ({ type: x.type, bytes: x.bytes })),
  };
}

// ---- process CPU (labelled; includes worker threads) ----------------------------------------------
function cpuMark() { return process.cpuUsage(); }
function cpuDelta(from) { const d = process.cpuUsage(from); return { user_ms: d.user / 1000, system_ms: d.system / 1000, label: 'process_cpu (whole process incl. worker threads; NOT main-thread CPU)' }; }

// ---- shared daemon-shaped state + real factories -----------------------------------------------------
function makeSession(id) {
  const t = new Date().toISOString();
  return { id, type: 'wrapped', ptyProcess: null, ownerWs: null, command: 'synthetic-cli', cwd: '/synthetic', backend: 'cmux',
    cmuxWorkspaceId: null, cmuxSurfaceId: null, termProgram: null, term: null, createdAt: t, lastActivityAt: t, lastConnectedAt: null,
    lastDisconnectedAt: null, lastStateReportAt: null, stateReport: null, idleTtl: null, idleTtlMs: null, ownerPid: null, ptyPid: null,
    clients: new Set(), isClosing: false, outputRing: [], outputRingTotalBytes: 0, ready: true };
}

/**
 * buildShared(store, R, { messages }) — daemon.js-shaped shared state. Mirrors daemon.js initial
 * values exactly (`trackedLedgerHealthy:false`, `trackedLedgerUnavailableReason:'not_opened'`) so
 * what the handlers answer during `recovering` is what the daemon would answer.
 */
function buildShared(store, R, { messages = null, clientOptions = {} } = {}) {
  const scheduler = { setInterval: () => ({ stub: true }), clearInterval: () => {} };
  const sessionStateManager = new SessionStateManager({ idle_timeout_ms: 5000, error_repeat_count: 3, error_window_ms: 180000, thinking_timeout_ms: 300000 }, scheduler);
  const busClient = { readyState: 1, send(serialized) { const m = JSON.parse(serialized); R.bus.push({ at: process.hrtime.bigint(), type: m.type, tracking_result: m.tracking_result || null, kind: m.observation && m.observation.kind, bytes: serialized.length }); } };
  const ledgerClient = createLedgerClient({ dir: store.dir, lockPath: store.lockPath, legacyPath: store.dir, ...(messages ? { Worker: makeObservedWorker(messages) } : {}), ...clientOptions });
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
    deliverInjectionToSession: async (id, session, prompt, options) => { R.delivery.push({ at: process.hrtime.bigint(), id, injectId: (options && options.injectId) || null, promptBytes: Buffer.byteLength(prompt) }); return { success: true, strategy: 'recorder_delivery', submit: 'recorder' }; },
  };
  const runtime = createDeliveryRuntime(shared);
  Object.assign(shared, runtime);
  const actions = createSessionActions(shared, {});
  Object.assign(shared, { recordObservation: actions.recordObservation, fireAutoReport: actions.fireAutoReport });
  let injectHandler = null;
  actions.registerInjectRoute({ post(route, fn) { if (route === '/api/sessions/:id/inject') injectHandler = fn; } });
  assert.equal(typeof injectHandler, 'function', 'the real inject handler must be captured through the in-process registrar');
  shared.interactionCore = runtime.createInteractionRuntime();
  return { shared, runtime, actions, injectHandler, ledgerClient, sessionStateManager };
}
const recorders = () => ({ audit: [], delivery: [], bus: [], unexpected: [] });
const makeReq = (prompt, from = 'orch', id = 'w1') => ({ params: { id }, body: { prompt, from }, headers: {} });
function makeRes() { const r = { statusCode: 200, body: null, jsonCalls: 0, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; r.jsonCalls++; return r; } }; return r; }

/**
 * The poll handler's DATA PATH, as daemon.js GET /api/inject-observations/:inject_id evaluates it
 * (see the frozen daemon.js: `if (!trackedLedgerHealthy) return unavailable(reason || (state ===
 * 'recovering' ? 'recovering' : …)); const fetched = await fetchTrackedInjection(id)`). This is NOT
 * the handler itself (it is inline on the express app and not reachable in-process); the JSON
 * shaping is not exercised here. Returns the decision and its latency.
 */
async function pollDataPath(shared, injectId) {
  const t0 = process.hrtime.bigint();
  if (!shared.trackedLedgerHealthy) {
    const reason = shared.trackedLedgerUnavailableReason || (shared.ledgerClient.state === 'recovering' ? 'recovering' : 'observation_store_unavailable');
    return { arm: 'unhealthy', tracking_state: 'unavailable', reason, latency_ms: Number(process.hrtime.bigint() - t0) / 1e6, store: shared.ledgerClient.state };
  }
  const fetched = await shared.fetchTrackedInjection(injectId);
  return { arm: fetched.record ? 'record' : 'unavailable', tracking_state: fetched.record ? fetched.record.tracking_state : 'unavailable', reason: fetched.record ? null : fetched.reason, latency_ms: Number(process.hrtime.bigint() - t0) / 1e6, store: shared.ledgerClient.state };
}

// ---- bounded cleanup (always from finally) ---------------------------------------------------------------
async function closeBounded(ledgerClient, ms = 2000) {
  let timer = null;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), ms + 500); });
  try { return await Promise.race([ledgerClient.close(ms), deadline]); } finally {
    clearTimeout(timer);
    const w = ledgerClient._internal && ledgerClient._internal.worker;
    if (w) { try { await w.terminate(); } catch { /* already gone */ } }
  }
}

// ---- evidence sink -------------------------------------------------------------------------------------------
function evidenceDir(env = process.env) {
  const d = env.TELEPTY_LEDGER_1207_EVIDENCE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-ledger-1207-evidence-'));
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}
function writeEvidence(dir, name, data) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(data, (k, v) => (typeof v === 'bigint' ? Number(v) : v), 2) + '\n', { mode: 0o600 });
  return file;
}
const ms = (a, b) => Number(b - a) / 1e6;
const sleep = (t) => new Promise((r) => setTimeout(r, t));

module.exports = { MiB, MESSAGE_MAX_BYTES, FRAME_CAP_LARGE, selectedTiers, privateStore, seedTier, startHeartbeat, summarize, percentile,
  makeObservedWorker, messageSizeReport, cpuMark, cpuDelta, buildShared, recorders, makeReq, makeRes, pollDataPath, closeBounded, evidenceDir, writeEvidence, ms, sleep };
