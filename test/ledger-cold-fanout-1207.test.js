'use strict';

// #1207 — ACCEPTANCE R5 (session fact fan-out over 1 hot + 2000 cold records) and R6 (cold index
// memory bound: controlled indexes over 64 MiB ⇒ named cold_offline, remaining identities readable,
// hot admission unchanged). Author-written; NOT RUN in this phase. Fixture bytes (the 2000-record
// session file, the 65 MiB index pair) are created ONLY under the future tester's private tmp.
//
// R5 drives the REAL `recordSessionFact` seam (src/routes/session-actions.js — the function the
// websocket transport calls once per lifecycle event) with records obtained through the REAL
// chunked `listForSession` protocol over the REAL client/worker. A second case reaches the same seam
// through the REAL websocket transport (installWebSocketTransport + an owner displacement), which
// requires a loopback HTTP listener and WebSocket clients in the tester's process — exactly what
// test/owner-displaced-observation-60.test.js does; reached-path counts are reported per case.
//
// R6 runs the owner IN-PROCESS (owner harness) so the index memory is measurable in this process:
// heap / external / RSS deltas are REPORTED separately from encoded index bytes and from the
// 64 B/record estimate; no memory bound is asserted (encoded caps bound resident encoded state only).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const F = require('../src/session-store/ledger-format');
const persistence = require('../src/session-store/persistence');
const H = require('./fixtures/ledger-1207/control-harness');
const { createOwnerHarness, tmpStore, sha256 } = require('./fixtures/ledger-1207/owner-harness');
const { writeLegacyLedger, makeHistoricalRecord } = require('./fixtures/ledger-1207/legacy-fixture');

const EVIDENCE = H.evidenceDir();
const R5 = Object.freeze({ cold: 2000, obsPerRecord: 3, sid: 'fan-1' });
const R6 = Object.freeze({ indexBytesTotal: 65 * 1048576, knownOffline: 10, newestColdRecords: 50 });
const nowIso = () => new Date().toISOString();

function makeSession(id) {
  const t = nowIso();
  return { id, type: 'wrapped', ptyProcess: null, ownerWs: null, command: 'synthetic-cli', cwd: '/synthetic', backend: 'cmux', cmuxWorkspaceId: null, cmuxSurfaceId: null, termProgram: null, term: null,
    createdAt: t, lastActivityAt: t, lastConnectedAt: null, lastDisconnectedAt: null, lastStateReportAt: null, stateReport: null, idleTtl: null, idleTtlMs: null, ownerPid: null, ptyPid: null,
    clients: new Set(), isClosing: false, outputRing: [], outputRingTotalBytes: 0, ready: true };
}
function seedFanSession(store) {
  const injections = {};
  for (let i = 0; i < R5.cold; i++) { const id = `fan-cold-${String(i).padStart(5, '0')}`; injections[id] = makeHistoricalRecord(id, R5.sid, R5.obsPerRecord, Date.parse('2026-10-01T00:00:00Z') + i * 1000); }
  const ledger = { schema_version: persistence.TRACKED_INJECTIONS_SCHEMA_VERSION, generation: 2, injections, interactions: { actions: {}, pending: {} } };
  return writeLegacyLedger(store.dir, { ledger });
}

async function withClientStore(name, fn) {
  const store = H.privateStore(`telepty-1207-${name}-`);
  const R = H.recorders(); const messages = { inbound: [], outbound: [] };
  const built = H.buildShared(store, R, { messages });
  let failed = true;
  try { const r = await fn({ store, R, messages, ...built }); failed = false; return r; } finally {
    await H.closeBounded(built.ledgerClient, 2000);
    if (failed) console.log(`[ledger-1207 R5] FAILED — private HOME preserved: ${store.home}`); else fs.rmSync(store.home, { recursive: true, force: true });
  }
}

test('R5: one session with 1 hot + 2000 cold records — the real recordSessionFact seam writes ONE fact frame; 2001 named results and 2001 bus events; chunked listForSession observed through the real protocol (<= 64 KiB, chunk_ack flow)', () => withClientStore('r5', async ({ store, R, messages, shared, runtime, actions, injectHandler, ledgerClient }) => {
  const seeded = seedFanSession(store);
  assert.equal(seeded.count, R5.cold);
  shared.sessions[R5.sid] = makeSession(R5.sid);
  const opened = await runtime.restoreTrackedInjections();
  assert.equal(opened.ok, true, JSON.stringify(opened)); assert.equal(opened.counts.cold, R5.cold);
  // the hot record: a real begin through the real inject handler
  const res = H.makeRes(); await injectHandler(H.makeReq('fan work', 'orch', R5.sid), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const hotId = res.body.inject_id;
  // list the session through the real chunked protocol and observe the flow
  const inboundBefore = messages.inbound.length; const outboundBefore = messages.outbound.length;
  const records = await ledgerClient.listForSession(R5.sid);
  const readChunks = messages.inbound.slice(inboundBefore).filter((m) => m.type === 'read_chunk');
  const chunkAcks = messages.outbound.slice(outboundBefore).filter((m) => m.type === 'chunk_ack');
  assert.equal(records.length, R5.cold + 1, 'hot + cold records of the session, all identities');
  assert.ok(readChunks.length > 1, `2001 minimal records cannot fit one 64 KiB message: ${readChunks.length} chunks`);
  assert.equal(chunkAcks.length, readChunks.length - 1, 'one chunk_ack per non-final chunk (one chunk in flight)');
  for (const c of readChunks) assert.ok(c.bytes <= H.MESSAGE_MAX_BYTES, `read_chunk ${c.bytes} B <= 64 KiB (JSON proxy)`);
  const ids = new Set(records.map((r) => r.inject_id));
  assert.equal(ids.size, R5.cold + 1); assert.ok(ids.has(hotId));
  // the fan-out: ONE fact frame, 2001 results, 2001 bus events
  const framesBefore = countFrames(store.dir);
  const busBefore = R.bus.length;
  const results = await actions.recordSessionFact({ sessionId: R5.sid, session: shared.sessions[R5.sid], cause: 'owner_epoch_replaced', evidence: { displaced_session_epoch: 'epoch-A', displaced_owner_pid: 4242 }, records, trigger: 'owner_lifecycle' });
  const framesAfter = countFrames(store.dir);
  assert.equal(results.length, R5.cold + 1, 'one named result per record');
  assert.ok(results.every((r) => r === 'observation_emitted'), `every result is the durable outcome: ${[...new Set(results)].join(',')}`);
  assert.equal(framesAfter.fact - framesBefore.fact, 1, 'exactly ONE fact frame was written for 2001 records');
  assert.equal(framesAfter.obs - framesBefore.obs, 0, 'no per-record obs frame');
  const busEvents = R.bus.slice(busBefore).filter((b) => b.type === 'task_completion_unknown');
  assert.equal(busEvents.length, R5.cold + 1, 'per-record bus behaviour retained (2001 events)');
  assert.ok(busEvents.every((b) => b.tracking_result === 'observation_emitted' && b.kind === 'owner_replaced_observed'));
  // the fact is visible on hot and cold records alike, in log order, with its fields
  const hot = await ledgerClient.fetchTrackedInjection(hotId);
  assert.equal(hot.record.last_observation.kind, 'owner_replaced_observed'); assert.equal(hot.record.last_observation.displaced_session_epoch, 'epoch-A');
  // cold records: stored tail (3) + the global daemon_restart_observed fact the open appended (the
  // store had records) + this session fact, overlaid in log order ⇒ seq 5, lifecycle fact last
  for (const id of [seeded.ids[0], seeded.ids[999], seeded.ids[R5.cold - 1]]) {
    const cold = await ledgerClient.fetchTrackedInjection(id);
    assert.equal(cold.record.observation_seq, R5.obsPerRecord + 2, 'stored tail + restart fact + the overlaid session fact');
    assert.deepEqual(cold.record.observations.slice(-2).map((o) => o.kind), ['daemon_restart_observed', 'owner_replaced_observed'], 'facts overlay in log order');
  }
  // source delivery is per record and only after the ack (process-fact kind ⇒ pushed)
  assert.ok(R.delivery.length >= 1, 'the source hears the fact');
  const evidence = { case: 'R5', records: records.length, read_chunks: readChunks.length, chunk_acks: chunkAcks.length, max_chunk_bytes: Math.max(...readChunks.map((c) => c.bytes)), frames_before: framesBefore, frames_after: framesAfter, results: results.length, bus_events: busEvents.length, deliveries: R.delivery.length, reached_path: 'recordSessionFact (real session-actions seam) via listForSession (real chunked protocol)' };
  const file = H.writeEvidence(EVIDENCE, 'R5-fanout.json', evidence);
  console.log(`[ledger-1207 R5] ${file} chunks=${readChunks.length} fact_frames=+${framesAfter.fact - framesBefore.fact} results=${results.length}`);
}));

test('R5 (real transport): an authenticated owner displacement through installWebSocketTransport reaches the same one-fact seam for the 2001-record session — requires a loopback listener and WebSocket clients in this process', () => withClientStore('r5-ws', async ({ store, R, shared, runtime, actions, injectHandler, ledgerClient }) => {
  const http = require('http'); const express = require('express'); const WebSocket = require('ws');
  const { installWebSocketTransport } = require('../src/transport/websocket');
  const { createCredentialStore } = require('../src/session-store/session-credentials');
  seedFanSession(store);
  const session = { ...makeSession(R5.sid), ownerWs: null, clients: new Set() };
  shared.sessions[R5.sid] = session;
  assert.equal((await runtime.restoreTrackedInjections()).ok, true);
  const res = H.makeRes(); await injectHandler(H.makeReq('fan work', 'orch', R5.sid), res); assert.equal(res.statusCode, 200);
  const app = express(); const server = http.createServer(app);
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const credentials = createCredentialStore(); const issued = credentials.issue(R5.sid);
  const TOKEN = 'r5-token';
  const sockets = [];
  try {
    installWebSocketTransport({ server, tailnetServer: null, sessions: shared.sessions, busClients: new Set(), expectedToken: TOKEN, verifyJwt: () => false, isAllowedPeer: () => true,
      initializeBootstrapState: () => {}, findKittySocket: () => null, findKittyWindowId: () => null, markSessionConnected: () => {}, scheduleBootstrapPromptPoll: () => {}, emitSessionLifecycleEvent: () => {},
      persistSessions: () => {}, appendToOutputRing: () => {}, sessionStateManager: { feed: () => {}, markDead: () => { throw new Error('markDead must not be required'); } }, isBootstrapGatedSession: () => false, markBootstrapReady: () => {},
      pendingReports: shared.pendingReports, fireAutoReport: () => { throw new Error('owner lifecycle must not route through fireAutoReport'); }, markSessionDisconnected: () => {}, resolveSessionAlias: (id) => id, applySessionStateReport: () => ({ success: false }), busAutoRoute: () => {},
      credentials, recordObservation: actions.recordObservation, recordSessionFact: actions.recordSessionFact, listTrackedInjectionsForSession: (sid) => ledgerClient.listForSession(sid), ledgerLive: (sid, on) => ledgerClient.live(sid, on) });
    const connect = () => new Promise((resolve, reject) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${R5.sid}?token=${TOKEN}&owner=1&owner_pid=${process.pid}`, { headers: { 'x-telepty-session-token': issued.bearer } }); sockets.push(ws); ws.once('open', () => resolve(ws)); ws.once('error', reject); });
    await connect(); await H.sleep(150);
    assert.equal(session.sessionEpoch, issued.epoch);
    const framesBefore = countFrames(store.dir); const busBefore = R.bus.length;
    await connect();                                         // the displacement → one session fact
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && countFrames(store.dir).fact === framesBefore.fact) await H.sleep(25);
    await H.sleep(200);
    const framesAfter = countFrames(store.dir);
    assert.equal(framesAfter.fact - framesBefore.fact, 1, 'the real transport wrote exactly one fact frame for 2001 records');
    const busEvents = R.bus.slice(busBefore).filter((b) => b.type === 'task_completion_unknown' && b.kind === 'owner_replaced_observed');
    assert.equal(busEvents.length, R5.cold + 1, 'per-record bus events retained');
    const file = H.writeEvidence(EVIDENCE, 'R5-transport.json', { case: 'R5-transport', reached_path: 'installWebSocketTransport → recordOwnerLifecycle → recordSessionFact (real seam) with a loopback listener', fact_frames_added: framesAfter.fact - framesBefore.fact, bus_events: busEvents.length });
    console.log(`[ledger-1207 R5-transport] ${file}`);
  } finally {
    for (const ws of sockets) { try { ws.terminate(); } catch { /* gone */ } }
    await new Promise((r) => server.close(() => r()));
  }
}));

function countFrames(dir) {
  const { readFrames } = require('./fixtures/ledger-1207/owner-harness');
  const out = { fact: 0, obs: 0, begin: 0, state: 0 };
  const d = path.join(dir, 'segments');
  for (const n of fs.existsSync(d) ? fs.readdirSync(d) : []) for (const f of readFrames(path.join(d, n)).frames) if (out[f.obj.t] !== undefined) out[f.obj.t]++;
  return out;
}

// ------------------------------------------------------------------------------------------------
// R6 — cold index memory bound (in-process owner)
// ------------------------------------------------------------------------------------------------
// Fabricates cold file n=0 (the OLDEST) whose two indexes total exactly R6.indexBytesTotal (65 MiB):
// bulk entries with sequential 16-byte keys (sorted by construction) plus R6.knownOffline real ids
// whose sha256 prefixes sort after the bulk range. The newest cold file (n=1) is the real migrated
// one, so its identities must stay readable while the oldest file goes offline by name.
function fabricateOfflineIndex(storeDir, knownIds) {
  const entries = Math.floor(R6.indexBytesTotal / (2 * F.INDEX_ENTRY_BYTES));          // 64 B/record across id+sid indexes
  const bulk = entries - knownIds.length;
  const coldDir = path.join(storeDir, 'cold');
  const jsonlLines = knownIds.map((id) => JSON.stringify({ inject_id: id, session_id: 'offline-sid', tracking_state: 'tracked', observation_seq: 1, observations: [{ kind: 'tracking_started', trigger: 'inject_accepted', seq: 1, at: 't' }], last_observation: { kind: 'tracking_started', trigger: 'inject_accepted', seq: 1, at: 't' }, materialized_through: { epoch: 0, seq: 0 } }));
  const jsonl = Buffer.from(jsonlLines.join('\n') + '\n');
  const offsets = []; let off = 0; for (const l of jsonlLines) { offsets.push([off, Buffer.byteLength(l)]); off += Buffer.byteLength(l) + 1; }
  function buildIdx(keyFor) {
    const buf = Buffer.alloc(entries * F.INDEX_ENTRY_BYTES);
    for (let i = 0; i < bulk; i++) { const key = Buffer.alloc(16); key.writeUInt32BE(i, 12); F.encodeIndexEntry({ key, file: 0, offset: 0, len: 1, flags: 1 }).copy(buf, i * F.INDEX_ENTRY_BYTES); }
    const real = knownIds.map((id, i) => ({ key: keyFor(id), file: 0, offset: offsets[i][0], len: offsets[i][1], flags: 1 })).sort((a, b) => Buffer.compare(a.key, b.key));
    real.forEach((e, i) => F.encodeIndexEntry(e).copy(buf, (bulk + i) * F.INDEX_ENTRY_BYTES));
    return buf;
  }
  const idIdx = buildIdx((id) => F.keyPrefix(id)); const sidIdx = buildIdx(() => F.keyPrefix('offline-sid'));
  fs.writeFileSync(path.join(coldDir, '0.jsonl'), jsonl, { mode: 0o400 });
  fs.writeFileSync(path.join(coldDir, '0.id.idx'), idIdx, { mode: 0o400 });
  fs.writeFileSync(path.join(coldDir, '0.sid.idx'), sidIdx, { mode: 0o400 });
  const manifestPath = path.join(storeDir, 'MANIFEST.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.cold = [{ n: 0, records: entries, bytes: jsonl.length }, ...manifest.cold];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { entries, indexBytes: idIdx.length + sidIdx.length, estimateBytesPerRecord: 2 * F.INDEX_ENTRY_BYTES, sha: { id: sha256(idIdx), sid: sha256(sidIdx), jsonl: sha256(jsonl) } };
}

test('R6: cold indexes totalling 65 MiB over the 64 MiB resident cap — the oldest cold file goes offline BY NAME (cold_offline), the newest cold identities stay readable, hot admission is unchanged, no bytes are dropped; index heap/RSS REPORTED separately from encoded bytes and the 64 B/record estimate', async () => {
  const s = tmpStore('telepty-1207-r6-');
  let h = null; let failed = true;
  try {
    const legacy = writeLegacyLedger(s.dir, { count: R6.newestColdRecords, obsPerRecord: 3 });
    h = createOwnerHarness({ dir: s.dir }); assert.equal(h.open().state, 'available'); await h.close(); h.release(); h = null;
    const knownIds = Array.from({ length: R6.knownOffline }, (_, i) => `off-${String(i).padStart(4, '0')}`);
    const fab = fabricateOfflineIndex(s.dir, knownIds);
    assert.equal(fab.indexBytes, R6.indexBytesTotal, 'fixture: exactly 65 MiB of index bytes');
    assert.ok(fab.indexBytes > F.COLD_INDEX_MAX_BYTES, 'fixture exceeds the 64 MiB resident cap');
    const before = process.memoryUsage();
    const t0 = Date.now();
    h = createOwnerHarness({ dir: s.dir });
    const o = h.open();
    const openMs = Date.now() - t0;
    const after = process.memoryUsage();
    assert.equal(o.state, 'available', JSON.stringify(o.stateMessage));
    assert.equal(o.stateMessage.counts.cold_offline, 1, 'exactly the oldest cold file is offline');
    const status = h.read('status').items[0];
    assert.ok(status.cold_index_bytes <= F.COLD_INDEX_MAX_BYTES, `resident index bytes ${status.cold_index_bytes} <= cap`);
    // named behaviour for the offline identities; readable identities unchanged
    for (const id of knownIds) { const r = h.read('get', { id }); assert.deepEqual(r.items, []); assert.equal(r.reason, 'cold_offline', `offline id ${id} answers cold_offline, never not_observed`); }
    for (const id of [legacy.ids[0], legacy.ids[R6.newestColdRecords - 1]]) { const r = h.read('get', { id }); assert.equal(r.items.length, 1, `newest cold file identity ${id} stays readable`); assert.equal(r.tier, 'cold'); }
    // a write to an offline record is refused by name (reheat impossible), nothing invented
    const offObs = await h.submit('obs', { id: knownIds[0], observation: { kind: 'k', trigger: 't', at: nowIso() } });
    assert.equal(offObs.type, 'nack'); assert.equal(offObs.reason, 'cold_offline');
    // hot admission unchanged
    const rec = { inject_id: 'hot-1', session_id: 'w', session_epoch: null, session_epoch_reason: 'no_815_epoch_fact', transport_source: 'orch', created_at: nowIso(), observation_seq: 0, observations: [], last_observation: null, capability: {}, tracking_state: 'tracked' };
    persistence.appendLedgerObservation(rec, { kind: 'tracking_started', trigger: 'inject_accepted' }, nowIso());
    const begun = await h.submit('begin', { id: 'hot-1', sid: 'w', record: rec, at: nowIso() }, { cls: 'T' });
    assert.equal(begun.type, 'ack', 'hot admission is unaffected by the offline cold file');
    assert.equal(h.read('status').items[0].resident.records, 1);
    // nothing dropped: the fabricated files and the real cold file are byte-identical after the open
    assert.equal(sha256(fs.readFileSync(path.join(s.dir, 'cold', '0.id.idx'))), fab.sha.id);
    assert.equal(sha256(fs.readFileSync(path.join(s.dir, 'cold', '0.sid.idx'))), fab.sha.sid);
    assert.equal(sha256(fs.readFileSync(path.join(s.dir, 'cold', '0.jsonl'))), fab.sha.jsonl);
    const manifest = JSON.parse(fs.readFileSync(path.join(s.dir, 'MANIFEST.json'), 'utf8'));
    assert.ok(manifest.cold.some((c) => c.n === 0), 'the offline file stays listed in the MANIFEST (retained, not evicted)');
    const evidence = { case: 'R6', fixture: { entries: fab.entries, index_bytes: fab.indexBytes, estimate_bytes_per_record: fab.estimateBytesPerRecord, estimate_total_bytes: fab.entries * fab.estimateBytesPerRecord }, open_ms: openMs,
      memory_delta_reported_not_asserted: { heapUsed: after.heapUsed - before.heapUsed, external: after.external - before.external, arrayBuffers: after.arrayBuffers - before.arrayBuffers, rss: after.rss - before.rss, note: 'in-process owner; the candidate reads every index file at open and keeps the offline buffers referenced (not freed) — measured here, not inferred' },
      resident_index_bytes: status.cold_index_bytes, cap: F.COLD_INDEX_MAX_BYTES, offline_files: o.stateMessage.counts.cold_offline };
    const file = H.writeEvidence(EVIDENCE, 'R6-cold-offline.json', evidence);
    console.log(`[ledger-1207 R6] ${file} open_ms=${openMs} mem=${JSON.stringify(evidence.memory_delta_reported_not_asserted)}`);
    await h.close(); h.release(); h = null;
    failed = false;
  } finally {
    if (h) { try { await h.close(); } catch { /* best effort */ } try { h.release(); } catch { /* best effort */ } }
    if (failed) console.log(`[ledger-1207 R6] FAILED — private store preserved: ${s.home}`); else s.rm();
  }
});
