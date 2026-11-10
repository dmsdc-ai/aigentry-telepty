'use strict';

// #1273 shared helpers of the four test/ledger-job-count-removal-1273*.test.js files (split590). Test support only; never
// shipped. The definitions are moved VERBATIM from test/ledger-job-count-removal-1273.test.js: only the require paths
// and the FAULT_FS path expression (same file) changed. No mutable module state: every test gets its own private HOME
// (withStore) or owner store (withOwnerStore), so the files share no ledger, lock or owner worker.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const persistence = require('../../../src/session-store/persistence');
const H = require('./control-harness');
const { readFrames, segmentFiles, tmpStore } = require('./owner-harness');

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

const RELIEF_MIN_BATCH = 64;   // the dispatch's minimum terminal batch (literal: the tests also run on de92b71)

function storeInventory(dir) {
  const count = (sub) => { try { return fs.readdirSync(path.join(dir, sub)).length; } catch { return 0; } };
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8'));
  return { hot: count('hot'), cold: count('cold'), facts: count('facts'), files: count('hot') + count('cold') + count('facts'), manifest_bytes: fs.statSync(path.join(dir, 'MANIFEST.json')).size, manifest_cold: (m.cold || []).length, last_checkpoint: m.last_checkpoint || null };
}

const FAULT_FS = path.join(__dirname, 'fault-fs.js');   // the same file as before the move: test/fixtures/ledger-1207/fault-fs.js
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

module.exports = { sha, makeSession, tmpHome, buildShared, recorders, makeReq, makeRes, inject, closeBounded, withStore, dirBytes, assertBusCorrelation, beginOnDisk,
  nowIso, beginRecord, ownerBegin, withOwnerStore, RELIEF_MIN_BATCH, storeInventory, FAULT_FS, manifestTmps, segBytesOf, orphanSet, coreOf };
