'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const persistence = require('../src/session-store/persistence');

test('persisted session save/load preserves the legacy sessions.json bytes', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-session-store-'));
  try {
    const persistPath = path.join(tmpDir, 'sessions.json');
    const sessions = {
      alpha: {
        type: 'wrapped',
        command: 'claude',
        cwd: '/work/alpha',
        backend: 'cmux',
        cmuxWorkspaceId: 'workspace-1',
        cmuxSurfaceId: 'surface-1',
        termProgram: 'kitty',
        term: 'xterm-kitty',
        delivery: { transport: 'unix_socket', address: '/tmp/alpha.sock' },
        deliveryEndpoint: '/tmp/alpha.sock',
        createdAt: '2026-05-30T01:02:03.000Z',
        lastActivityAt: '2026-05-30T01:03:03.000Z',
        lastConnectedAt: '2026-05-30T01:04:03.000Z',
        lastDisconnectedAt: '',
        lastStateReportAt: '2026-05-30T01:05:03.000Z',
        stateReport: { phase: 'implementing', current_task: 'extract persistence', seq: 7 },
        idleTtl: '30m',
        idleTtlMs: 1800000,
        ownerPid: 1234,
        ptyPid: 5678
      },
      beta: {
        type: 'spawned',
        command: 'bash',
        cwd: '/work/beta',
        createdAt: '2026-05-30T02:02:03.000Z',
        lastActivityAt: null,
        idleTtlMs: null,
        ownerPid: 0,
        ptyPid: 4321
      }
    };
    const expected = {
      alpha: {
        id: 'alpha',
        type: 'wrapped',
        command: 'claude',
        cwd: '/work/alpha',
        backend: 'cmux',
        cmuxWorkspaceId: 'workspace-1',
        cmuxSurfaceId: 'surface-1',
        termProgram: 'kitty',
        term: 'xterm-kitty',
        delivery: { transport: 'unix_socket', address: '/tmp/alpha.sock' },
        deliveryEndpoint: '/tmp/alpha.sock',
        createdAt: '2026-05-30T01:02:03.000Z',
        lastActivityAt: '2026-05-30T01:03:03.000Z',
        lastConnectedAt: '2026-05-30T01:04:03.000Z',
        lastDisconnectedAt: null,
        lastStateReportAt: '2026-05-30T01:05:03.000Z',
        stateReport: { phase: 'implementing', current_task: 'extract persistence', seq: 7 },
        idleTtl: '30m',
        idleTtlMs: 1800000,
        ownerPid: 1234,
        ptyPid: 5678
      },
      beta: {
        id: 'beta',
        type: 'spawned',
        command: 'bash',
        cwd: '/work/beta',
        backend: null,
        cmuxWorkspaceId: null,
        cmuxSurfaceId: null,
        termProgram: null,
        term: null,
        delivery: null,
        deliveryEndpoint: null,
        createdAt: '2026-05-30T02:02:03.000Z',
        lastActivityAt: null,
        lastConnectedAt: null,
        lastDisconnectedAt: null,
        lastStateReportAt: null,
        stateReport: null,
        idleTtl: null,
        idleTtlMs: null,
        ownerPid: null,
        ptyPid: 4321
      }
    };

    persistence.savePersistedSessions(sessions, persistPath);

    assert.equal(fs.readFileSync(persistPath, 'utf8'), JSON.stringify(expected, null, 2));
    assert.deepEqual(persistence.loadPersistedSessions(persistPath), expected);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('persisted wrapped-session restore keeps awaiting-reconnect shape', () => {
  const meta = {
    id: 'alpha',
    type: 'wrapped',
    command: 'claude',
    cwd: '/work/alpha',
    backend: 'cmux',
    cmuxWorkspaceId: 'workspace-1',
    cmuxSurfaceId: 'surface-1',
    termProgram: 'kitty',
    term: 'xterm-kitty',
    createdAt: '2026-05-30T01:02:03.000Z',
    lastActivityAt: '2026-05-30T01:03:03.000Z',
    lastConnectedAt: '2026-05-30T01:04:03.000Z',
    lastDisconnectedAt: '2026-05-30T01:05:03.000Z',
    lastStateReportAt: '2026-05-30T01:06:03.000Z',
    stateReport: { phase: 'implementing', seq: 7 },
    idleTtl: '30m',
    idleTtlMs: 1800000,
    ownerPid: 1234,
    ptyPid: 5678
  };

  const restored = persistence.buildRestoredWrappedSession('alpha', meta, { cwd: '/fallback' });

  assert.deepEqual(restored, {
    id: 'alpha', type: 'wrapped', ptyProcess: null, ownerWs: null,
    command: 'claude', cwd: '/work/alpha',
    backend: 'cmux',
    cmuxWorkspaceId: 'workspace-1',
    cmuxSurfaceId: 'surface-1',
    termProgram: 'kitty',
    term: 'xterm-kitty',
    createdAt: '2026-05-30T01:02:03.000Z',
    lastActivityAt: '2026-05-30T01:03:03.000Z',
    lastConnectedAt: '2026-05-30T01:04:03.000Z',
    lastDisconnectedAt: '2026-05-30T01:05:03.000Z',
    lastStateReportAt: '2026-05-30T01:06:03.000Z',
    stateReport: { phase: 'implementing', seq: 7 },
    idleTtl: '30m',
    idleTtlMs: 1800000,
    ownerPid: 1234,
    ptyPid: 5678,
    clients: new Set(), isClosing: false, outputRing: [], ready: true,     });
  assert.equal(persistence.buildRestoredWrappedSession('beta', { type: 'spawned' }), null);
});

// ---------------------------------------------------------------------------
// #1207 (G1) — an unavailable tracked-injection ledger must not authorize new tracked work,
// re-targeted at the DIRECTORY STORE owned by the ledger worker.
// ---------------------------------------------------------------------------
//
// Real modules only: `persistence`, `createLedgerClient` (real owner worker_thread on a real private
// filesystem), `createDeliveryRuntime` and `createSessionActions`, with the actual
// `POST /api/sessions/:id/inject` handler captured from `registerInjectRoute`. Shared state is
// assembled the way daemon.js does it: a ledger client created before `restoreTrackedInjections`
// (the owner's open) runs, `trackedLedgerHealthy` false until that open succeeds.
//
// RECORDED EXTERNAL BOUNDARY: `deliverInjectionToSession` is the transport. Here it is a recorder
// that notes it was called and what the ACTIVE SEGMENT held at that instant (a begin frame covered by
// a commit frame); it writes nothing to any session. No daemon, listener, socket or PTY.
//
// The guard's eight behaviours (unreadable store authorizes nothing; health only via a successful
// open; begin refused before any in-memory mutation; a failed write on a healthy store is distinct)
// are asserted against two unreadable-store categories the directory store can present: an
// unsupported MANIFEST format carrying a marker, and a corrupted committed frame.

const crypto = require('node:crypto');
const completion = require('../src/completion-observation');
const interaction = require('../src/interaction');
const { createDeliveryRuntime } = require('../src/mailbox/delivery-runtime');
const { createSessionActions } = require('../src/routes/session-actions');
const { createLedgerClient } = require('../src/session-store/ledger-client');
const { readFrames, segmentFiles, shaTree } = require('./fixtures/ledger-1207/owner-harness');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const FAULT_FS = path.join(__dirname, 'fixtures', 'ledger-1207', 'fault-fs.js');

function makeSession(id) {
  const t = new Date().toISOString();
  return { id, type: 'wrapped', ptyProcess: null, ownerWs: null, command: 'synthetic-cli', cwd: '/synthetic',
    backend: 'cmux', cmuxWorkspaceId: null, cmuxSurfaceId: null, termProgram: null, term: null,
    createdAt: t, lastActivityAt: t, lastConnectedAt: null, lastDisconnectedAt: null, lastStateReportAt: null,
    stateReport: null, idleTtl: null, idleTtlMs: null, ownerPid: null, ptyPid: null,
    clients: new Set(), isClosing: false, outputRing: [], outputRingTotalBytes: 0, ready: true };
}
function makeRecorders() { return { audit: [], delivery: [], routes: [], unexpected: [] }; }

// daemon.js-shaped shared state + the real runtime factory + the real actions factory + a real client.
function buildShared(store, recorders, clientOptions = {}) {
  const ledgerClient = createLedgerClient({ dir: store.dir, lockPath: store.lockPath, legacyPath: store.dir, ...clientOptions });
  const shared = {
    sessions: { w1: makeSession('w1') },
    pendingReports: {},
    // daemon.js — not healthy until the owner's open succeeds; no in-memory mirror exists.
    ledgerClient, trackedLedgerHealthy: false, trackedLedgerUnavailableReason: 'not_opened',
    TRACKED_INJECTIONS_PATH: store.dir,
    sessionPersistence: persistence,
    CAPABILITY_STAGE_A: completion.CAPABILITY_STAGE_A,
    interaction,
    busClients: [], crypto, fs,
    MACHINE_ID: 'synthetic-host', ORCHESTRATOR_SIDS: ['orch'],
    SESSION_STALE_SECONDS: 300, UPSTREAM_STALL_SECONDS: 120,
    interactionWaiters: new Map(), deliveredAbsenceIdentities: new WeakMap(),
    readyRegistry: { observeInteraction: () => interaction.unavailableObservation() },
    auditWriter: { append(r) { recorders.audit.push({ inject_id: r.inject_id, delivery_result: r.delivery_result, to: r.to }); } },
    sessionCredentials: { verify() { recorders.unexpected.push('sessionCredentials.verify'); throw new Error('unreached: no bearer header'); } },
    isOpenWebSocket: () => false,
    isBootstrapGatedSession: () => false,
    isProcessRunning: () => { recorders.unexpected.push('isProcessRunning'); return false; },
    resolveSessionAlias: (id) => (Object.prototype.hasOwnProperty.call(shared.sessions, id) ? id : null),
    // RECORDED EXTERNAL BOUNDARY (see header). Reads the active segment at call time so a test can
    // prove the record was durable (commit-framed) BEFORE the transport was asked to write.
    deliverInjectionToSession: async (id, session, prompt, options) => {
      const injectId = options && options.injectId;
      const frames = segmentFiles(store.dir).flatMap((f) => readFrames(f).frames.map((x) => x.obj));
      const begin = frames.find((x) => x.t === 'begin' && x.id === injectId);
      const covered = !!begin && frames.some((x) => x.t === 'commit' && x.epoch === begin.epoch && x.seq_from <= begin.seq && begin.seq <= x.seq_to);
      recorders.delivery.push({ id, promptBytes: Buffer.byteLength(prompt), injectId: injectId || null,
        healthyAtCall: shared.trackedLedgerHealthy, recordOnDiskAtCall: !!begin, commitCoversAtCall: covered });
      return { success: true, strategy: 'recorder_delivery', submit: options && options.noEnter ? 'skipped' : 'recorder' };
    },
  };
  const runtime = createDeliveryRuntime(shared);
  Object.assign(shared, runtime);
  const actions = createSessionActions(shared, {});
  let handler = null;
  const registrar = { post(route, fn) { recorders.routes.push(route); if (route === '/api/sessions/:id/inject') handler = fn; } };
  actions.registerInjectRoute(registrar);
  assert.equal(typeof handler, 'function', 'the real inject handler must be captured');
  shared.interactionCore = runtime.createInteractionRuntime();
  return { shared, runtime, actions, handler, ledgerClient };
}

function makeReq(prompt) { return { params: { id: 'w1' }, body: { prompt, from: 'orch' }, headers: {} }; }
function makeRes() {
  const r = { statusCode: 200, statusCalls: [], body: null, jsonCalls: 0,
    status(c) { r.statusCode = c; r.statusCalls.push(c); return r; },
    json(b) { r.body = b; r.jsonCalls++; return r; } };
  return r;
}
function tmpStore() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-ledger-1207-'));
  const parent = path.join(home, '.config', 'aigentry-telepty'); fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  return { home, parent, dir: path.join(parent, 'tracked-injections.json'), lockPath: path.join(parent, 'tracked-injections.lock') };
}
async function withLedgerDir(fn) {
  const store = tmpStore();
  const clients = [];
  try { return await fn(store, clients); } finally {
    for (const c of clients) { try { await c.close(500); } catch { /* best effort */ } }
    fs.rmSync(store.home, { recursive: true, force: true });
  }
}

// A known-valid directory store produced by the REAL write path: two tracked records for two
// sessions, written through the real client → owner → segments, then closed cleanly.
async function seedValidStore(store, clients) {
  const recorders = makeRecorders();
  const { shared, runtime, ledgerClient } = buildShared(store, recorders);
  clients.push(ledgerClient);
  const opened = await runtime.restoreTrackedInjections();            // fresh → published, healthy
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(shared.trackedLedgerHealthy, true);
  const ids = ['hist-1', 'hist-2'];
  for (const id of ids) {
    const begun = await runtime.beginTrackedInjection({ injectId: id, sessionId: `hist-session-${id}`, source: 'orch', session: null });
    assert.equal(begun.ok, true, `seed begin ${id} must succeed`);
  }
  await ledgerClient.close(2000);
  clients.pop();
  return { ids, tree: shaTree(store.dir) };
}

const UNAVAILABLE = 'observation_store_unavailable';

// Two unreadable-store categories: an unsupported MANIFEST format carrying a marker string that must
// survive byte-for-byte, and a corrupted committed frame (one flipped byte inside fsynced history).
const invalidInputs = {
  schema99: (store) => {
    const marker = `TASK-1207-UNSUPPORTED-FORMAT-${crypto.randomBytes(8).toString('hex')}`;
    const p = path.join(store.dir, 'MANIFEST.json');
    const obj = { ...JSON.parse(fs.readFileSync(p, 'utf8')), format: 99, marker };
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
    return { marker, markerFile: p, reason: UNAVAILABLE };
  },
  corruptFrame: (store) => {
    const seg = segmentFiles(store.dir)[0];
    const bytes = Buffer.from(fs.readFileSync(seg)); bytes[12] ^= 0x01;   // inside the first (begin) frame's json
    fs.writeFileSync(seg, bytes);
    return { marker: null, markerFile: null, reason: UNAVAILABLE };
  },
};

async function prepareUnavailable(store, clients, category) {
  const valid = await seedValidStore(store, clients);
  const bad = invalidInputs[category](store);
  const badTree = shaTree(store.dir);
  const recorders = makeRecorders();
  const built = buildShared(store, recorders);
  clients.push(built.ledgerClient);
  const opened = await built.runtime.restoreTrackedInjections();
  assert.equal(opened.ok, false, `${category}: the open must fail`);
  assert.equal(opened.state, 'unavailable_read', `${category}: an unreadable store is unavailable_read`);
  assert.equal(built.shared.trackedLedgerHealthy, false, `${category}: restore must mark the ledger unavailable`);
  assert.equal(built.shared.trackedLedgerUnavailableReason, UNAVAILABLE);
  assert.deepEqual(shaTree(store.dir), badTree, `${category}: restore must preserve the bad bytes`);
  assert.equal(built.ledgerClient.readModel.size(), 0, 'the read model stays empty');
  return { ...built, recorders, store, valid, bad, badTree };
}

function assertUntouched(ctx, label) {
  assert.deepEqual(shaTree(ctx.store.dir), ctx.badTree, `${label}: bad bytes must survive byte-for-byte`);
  if (ctx.bad.marker) assert.equal(fs.readFileSync(ctx.bad.markerFile, 'utf8').includes(ctx.bad.marker), true, `${label}: marker must survive`);
  assert.equal(ctx.shared.trackedLedgerHealthy, false, `${label}: health must not flip to true`);
  assert.equal(ctx.shared.trackedLedgerUnavailableReason, UNAVAILABLE, `${label}: unavailable reason retained`);
  assert.equal(ctx.ledgerClient.readModel.size(), 0, `${label}: no in-memory record was inserted`);
  assert.deepEqual(ctx.shared.pendingReports, {}, `${label}: no pending report registered`);
  assert.deepEqual(ctx.recorders.delivery, [], `${label}: the transport boundary was never reached`);
  assert.deepEqual(ctx.recorders.unexpected, []);
}

test('#1207 healthy control: valid store → real open → real inject handler → begin commit-framed on disk before the transport is called', () => withLedgerDir(async (store, clients) => {
  const valid = await seedValidStore(store, clients);
  const recorders = makeRecorders();
  const { shared, runtime, handler, ledgerClient } = buildShared(store, recorders);
  clients.push(ledgerClient);
  const opened = await runtime.restoreTrackedInjections();
  assert.equal(opened.ok, true);
  assert.equal(shared.trackedLedgerHealthy, true);
  assert.equal(shared.trackedLedgerUnavailableReason, null);
  // the seeded records are retained (hot or cold) and the restart fact overlays them in log order
  for (const id of valid.ids) {
    const r = await ledgerClient.fetchTrackedInjection(id);
    assert.equal(r.record.tracking_state, 'tracked');
    assert.deepEqual(r.record.observations.map((o) => o.kind), ['tracking_started', 'daemon_restart_observed']);
  }
  const prompt = 'synthetic task body H';
  const req = makeReq(prompt); const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  const injectId = res.body.inject_id;
  assert.equal(typeof injectId, 'string');
  assert.equal(recorders.delivery.length, 1, 'transport boundary reached exactly once');
  assert.deepEqual(recorders.delivery[0], { id: 'w1', promptBytes: Buffer.byteLength(prompt), injectId,
    healthyAtCall: true, recordOnDiskAtCall: true, commitCoversAtCall: true });
  const fetched = await ledgerClient.fetchTrackedInjection(injectId);
  assert.equal(fetched.record.tracking_state, 'tracked');
  assert.equal(fetched.record.observations[0].kind, 'tracking_started');
  assert.equal(shared.pendingReports.w1.injectId, injectId);
  assert.deepEqual(recorders.audit, [{ inject_id: injectId, delivery_result: 'success', to: 'w1' }]);
  assert.equal(shared.trackedLedgerHealthy, true);
  assert.deepEqual(recorders.unexpected, []);
}));

for (const category of Object.keys(invalidInputs)) {
  test(`#1207 ${category} store: direct beginTrackedInjection is refused, repeatedly, without touching the store`, () => withLedgerDir(async (store, clients) => {
    const ctx = await prepareUnavailable(store, clients, category);
    for (let i = 1; i <= 3; i++) {
      const begun = await ctx.runtime.beginTrackedInjection({ injectId: `inj-${category}-${i}`, sessionId: 'w1', source: 'orch', session: ctx.shared.sessions.w1 });
      assert.equal(begun.ok, false, `${category}: begin #${i} must refuse`);
      assert.equal(begun.reason, 'tracking_persistence_failed', `${category}: begin #${i} returns the existing failure result`);
      assertUntouched(ctx, `${category} begin #${i}`);
    }
  }));

  test(`#1207 ${category} store: the actual inject handler answers 500 TRACKING_PERSISTENCE_FAILED and delivers nothing`, () => withLedgerDir(async (store, clients) => {
    const ctx = await prepareUnavailable(store, clients, category);
    for (let i = 1; i <= 2; i++) {
      const req = makeReq(`synthetic task body ${category} ${i}`); const res = makeRes();
      await ctx.handler(req, res);
      assert.equal(res.statusCode, 500, `${category}: handler call #${i} must refuse`);
      assert.equal(res.jsonCalls, 1);
      assert.equal(res.body.success, false);
      assert.equal(res.body.code, 'TRACKING_PERSISTENCE_FAILED');
      assert.equal(res.body.tracking_state, 'unavailable');
      assert.equal(res.body.reason, 'tracking_persistence_failed');
      assert.equal(typeof res.body.inject_id, 'string');
      assertUntouched(ctx, `${category} handler #${i}`);
      assert.deepEqual(ctx.recorders.audit, [], `${category}: no delivery audit line, because nothing was delivered`);
    }
  }));
}

test('#1207 other ledger writers under an unavailable store refuse at the submit boundary without touching the store', () => withLedgerDir(async (store, clients) => {
  const ctx = await prepareUnavailable(store, clients, 'schema99');
  assert.deepEqual(ctx.runtime.ledgerUnavailable(), { ok: false, reason: UNAVAILABLE });
  // every submit is a NACK naming the unreadable store; nothing is written
  const outcome = await ctx.ledgerClient.submit('obs', { id: 'inj-x', observation: { kind: 'k', trigger: 't', at: new Date().toISOString() } });
  assert.equal(outcome.outcome, 'nack'); assert.equal(outcome.reason, 'unavailable_read');
  assertUntouched(ctx, 'submit');
  assert.equal(await ctx.runtime.abortTrackedInjection('inj-x', 'w1', 'DELIVERY_FAILED', 'synthetic'), 'tracking_unavailable');
  assert.equal(await ctx.runtime.parkTrackedInjection('inj-x', 'bootstrap_queue', 'bootstrap_not_ready'), 'tracking_unavailable');
  assert.equal(await ctx.runtime.parkTrackedInjection(null, 'bootstrap_queue', 'bootstrap_not_ready'), 'no_tracked_inject');
  assertUntouched(ctx, 'abort/park');
  // the historical ids are in the store, not in the read model — never invented from an unreadable store
  for (const id of ctx.valid.ids) assert.equal(ctx.runtime.getTrackedInjection(id), null);
  const core = ctx.runtime.createInteractionRuntime();
  assert.equal(core.lookup('a1').reason, 'storage_unavailable');
  assert.equal(core.isBusy('w1'), false);
  const request = { schema_version: 1, action_id: 'a1', interaction_request_id: 'request1',
    identity: { kind: 'manual', sid: 'w1' },
    expected: { sid: 'w1', session_epoch: 'epoch1', credential_generation: 1, owner_generation: 'owner1',
      input_generation: 1, geometry_generation: 1, prompt_revision: 'r1', frame_digest: 'a'.repeat(64),
      surface_id: 'surface1', cols: 80, rows: 24, question_id: 'q1' },
    operation: 'key', value: 'down', authority: { provenance: 'controller-policy', reference: 'scope1' },
    expires_at: Date.now() + 30000 };
  const receipt = await core.act(request, 'authenticated-host-controller');
  assert.equal(receipt.stage, 'refused');
  assert.equal(receipt.reason, 'storage_unavailable');
  assert.equal(receipt.bytes_written, 0);
  assertUntouched(ctx, 'interaction');
}));

test('#1207 explicit valid re-open re-establishes health; refused work then proceeds (no blanket shutdown)', () => withLedgerDir(async (store, clients) => {
  const ctx = await prepareUnavailable(store, clients, 'corruptFrame');
  const before = await ctx.runtime.beginTrackedInjection({ injectId: 'inj-before', sessionId: 'w1', source: 'orch', session: ctx.shared.sessions.w1 });
  assert.equal(before.ok, false);
  assertUntouched(ctx, 'before explicit re-open');
  // The known-valid bytes are put back from OUTSIDE the daemon — no repair path exists — and the
  // existing restore path (the owner's open) is run explicitly.
  const seg = segmentFiles(store.dir)[0];
  const bytes = Buffer.from(fs.readFileSync(seg)); bytes[12] ^= 0x01; fs.writeFileSync(seg, bytes);
  const reopened = await ctx.runtime.restoreTrackedInjections();
  assert.equal(reopened.ok, true, JSON.stringify(reopened));
  assert.equal(ctx.shared.trackedLedgerHealthy, true, 'a valid explicit open is the transition back to healthy');
  assert.equal(ctx.shared.trackedLedgerUnavailableReason, null);
  for (const id of ctx.valid.ids) assert.equal((await ctx.ledgerClient.fetchTrackedInjection(id)).record.inject_id, id);
  const begun = await ctx.runtime.beginTrackedInjection({ injectId: 'inj-after', sessionId: 'direct-session', source: 'orch', session: null });
  assert.equal(begun.ok, true);
  assert.equal(begun.record.tracking_state, 'tracked');
  const req = makeReq('synthetic task body after re-open'); const res = makeRes();
  await ctx.handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(ctx.recorders.delivery.length, 1);
  assert.equal(ctx.recorders.delivery[0].recordOnDiskAtCall, true);
  assert.equal(ctx.recorders.delivery[0].commitCoversAtCall, true);
  assert.equal((await ctx.ledgerClient.fetchTrackedInjection('inj-before')).record, null, 'the refused inject never became a record');
  assert.equal(ctx.shared.trackedLedgerHealthy, true);
  assert.deepEqual(ctx.recorders.unexpected, []);
}));

test('#1207 a failed healthy write is not an unavailable store: one fsync fault is retried in a new segment (200, health untouched); two faults leave the inject INDETERMINATE (500, no delivery, never described as persisted) and the store unavailable_write, still readable', () => withLedgerDir(async (store, clients) => {
  // (1) one injected EIO on a segment fsync → retry file → ack, retried:true
  // `skip: 1` lets recovery's own re-fsync of the last group (one segment fsync at every open of a
  // store with history) through; the fault lands on the first group written by the handler.
  process.env.LEDGER_1207_FAULTS = JSON.stringify({ fsyncSync: { code: 'EIO', times: 1, skip: 1, pathIncludes: `${path.sep}segments${path.sep}` } });
  let recorders = makeRecorders();
  let built = buildShared(store, recorders, { fsImplPath: FAULT_FS });
  clients.push(built.ledgerClient);
  assert.equal((await built.runtime.restoreTrackedInjections()).ok, true);
  let res = makeRes(); await built.handler(makeReq('one fault'), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(built.shared.trackedLedgerHealthy, true, 'a retried write on a healthy store does not mark it unavailable');
  assert.equal(segmentFiles(store.dir).length, 2, 'the retry went to a new segment file');
  assert.equal(recorders.delivery.length, 1); assert.equal(recorders.delivery[0].commitCoversAtCall, true);
  await built.ledgerClient.close(2000); clients.pop();
  // (2) two injected EIOs → indeterminate: a third outcome, never success, never failure
  process.env.LEDGER_1207_FAULTS = JSON.stringify({ fsyncSync: { code: 'EIO', times: 2, skip: 1, pathIncludes: `${path.sep}segments${path.sep}` } });
  recorders = makeRecorders();
  built = buildShared(store, recorders, { fsImplPath: FAULT_FS });
  clients.push(built.ledgerClient);
  assert.equal((await built.runtime.restoreTrackedInjections()).ok, true);
  const treeBefore = shaTree(store.dir);
  res = makeRes(); await built.handler(makeReq('two faults'), res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, 'TRACKING_PERSISTENCE_FAILED');
  assert.equal(res.body.reason, 'tracking_outcome_indeterminate');
  assert.equal(res.body.tracking_state, 'unavailable');
  assert.deepEqual(recorders.delivery, [], 'nothing delivered');
  assert.deepEqual(recorders.audit, []);
  assert.deepEqual(built.shared.pendingReports, {});
  assert.equal(built.shared.trackedLedgerHealthy, true, 'readability is untouched by a write-side outage');
  assert.equal(built.ledgerClient.state, 'unavailable_write');
  assert.equal(built.ledgerClient.status().unresolved_count, 1, 'the txn is held for resolution, never retried');
  const poll = await built.ledgerClient.fetchTrackedInjection(res.body.inject_id);
  assert.equal(poll.record, null, 'a possibly-durable record is never served from the committed projection');
  // the next begin is refused as capacity (503 arm), and no frame is appended after indeterminate
  res = makeRes(); await built.handler(makeReq('after indeterminate'), res);
  assert.equal(res.statusCode, 503); assert.equal(res.body.code, 'TRACKING_CAPACITY'); assert.equal(res.body.reason, 'unavailable_write');
  const treeAfter = shaTree(store.dir);
  const changed = Object.keys(treeAfter).filter((k) => treeAfter[k] !== treeBefore[k] || !(k in treeBefore));
  assert.deepEqual(changed.filter((k) => !k.startsWith('segments/')), [], 'only the segment files written by the (unknown) attempt differ');
  delete process.env.LEDGER_1207_FAULTS;
}));

