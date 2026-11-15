'use strict';

// Task 1270 — a live owner/viewer WebSocket must stay bound to the session INSTANCE it was admitted
// to across a supported rename (PATCH /api/sessions/:id), and must never be steered into another
// instance that later takes the old name.
//
// Live signature: an owned session was renamed (same epoch, same PIDs, same owner socket); the
// daemon logged the rename, the old key disappeared, and from then on the heartbeat and output
// counters froze — every owner frame was looked up under the URL name the socket opened with and
// silently dropped. The same lookup made a record later filed under the old name the target of
// that socket's frames (and of the #732 H5 owner re-adoption).
//
// Real production seams: the connection/message/close handlers of installWebSocketTransport
// (src/transport/websocket.js), driven through its own `wss` 'connection' event, and the PATCH
// handler of registerSessionRenameRoute (src/routes/session-records.js), with the real credential
// store and bridge-stage receipt builder. No listener, no network and no TLS: each peer socket is an
// in-process EventEmitter (same pattern as test/pty-input-lifecycle-1215.test.js), so nothing is
// transmitted at all. Not exercised here: the HTTP upgrade gate (origin/peer/token), unchanged.
// Stand-ins: the peer sockets (this test plays the bridge and the viewer) and daemon callbacks that
// only record what they were handed. No PTY, provider or native terminal is involved; this proves
// daemon-side routing only.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { installWebSocketTransport } = require('../src/transport/websocket');
const { registerSessionRenameRoute } = require('../src/routes/session-records');
const { createCredentialStore } = require('../src/session-store/session-credentials');
const bridgeStage = require('../src/mailbox/bridge-stage');

const TOKEN = 'ws-rename-1270-token';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, description, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail(`timed out waiting for: ${description}`);
}

function record(id) {
  return {
    id, type: 'wrapped', ownerWs: null, clients: new Set(),
    outputRing: [], outputRingTotalBytes: 0, ready: true,
    createdAt: new Date().toISOString(), lastActivityAt: null, lastDisconnectedAt: null,
  };
}

async function harness(t, { viewerVerdict = () => true } = {}) {
  const sessions = {};
  const calls = { feed: [], receipts: [], lifecycle: [], disconnected: [], authorize: [] };
  const credentials = createCredentialStore();
  const routes = {};
  registerSessionRenameRoute({ patch: (route, handler) => { routes[route] = handler; } }, {
    context: {
      sessions, sessionCredentials: credentials, sidNonces: new Map(),
      resolveSessionAlias: (id) => (Object.hasOwn(sessions, id) ? id : null),
      persistSessions: () => ({ ok: true, committed: true }),
    },
    sessionStateManager: { register() {}, unregister() {} },
    busClients: new Set(),
  });
  const transport = installWebSocketTransport({
    server: new EventEmitter(), tailnetServer: null, sessions, busClients: new Set(), expectedToken: TOKEN,
    verifyJwt: () => false, isAllowedPeer: () => true, credentials,
    initializeBootstrapState: () => {}, findKittySocket: () => null, findKittyWindowId: () => null,
    markSessionConnected: () => {}, scheduleBootstrapPromptPoll: () => {},
    emitSessionLifecycleEvent: (type, id, session) => calls.lifecycle.push({ type, id, session }),
    persistSessions: () => ({ ok: true, committed: true }),
    appendToOutputRing: (session, data) => {
      session.outputRing.push(data);
      session.outputRingTotalBytes = (session.outputRingTotalBytes || 0) + data.length;
    },
    sessionStateManager: { feed: (id, data) => calls.feed.push({ id, data }) },
    isBootstrapGatedSession: () => false, markBootstrapReady: () => {},
    pendingReports: {}, fireAutoReport: () => {},
    markSessionDisconnected: (session) => calls.disconnected.push(session),
    resolveSessionAlias: (id) => id, applySessionStateReport: () => ({ success: false }), busAutoRoute: () => {},
    recordBridgeReceipt: (id, session, receipt) => { calls.receipts.push({ id, session, inject_id: receipt.inject_id }); return { ok: true }; },
    authorizeViewerInject: (args) => { calls.authorize.push(args); return viewerVerdict(args); },
  });
  const sockets = [];
  t.after(() => {
    // Closing runs the production close handler, which also clears its 30 s ping interval.
    for (const ws of sockets) ws.close();
    transport.closeObservers();
  });

  // In-process peer socket. `send` is daemon → peer (recorded); the peer talks to the daemon by
  // emitting 'message' (see `send` below the harness). close/terminate emit 'close' once.
  function connect(id, { owner = false, bearer = null } = {}) {
    const ws = new EventEmitter();
    ws.readyState = 1;
    ws.bufferedAmount = 0;
    ws.received = [];
    ws.closeCode = null;
    ws.send = (raw, done) => {
      if (ws.readyState !== 1) { if (done) done(new Error('socket not open')); return; }
      ws.received.push(JSON.parse(raw));
      if (done) done();
    };
    ws.close = (code = 1000) => {
      if (ws.readyState === 3) return;
      ws.readyState = 3;
      ws.closeCode = code;
      ws.emit('close', code);
    };
    ws.terminate = () => ws.close(1006);
    ws.ping = () => {};
    const query = owner ? `&owner=1&owner_pid=${process.pid}` : '';
    transport.wss.emit('connection', ws, {
      url: `/api/sessions/${encodeURIComponent(id)}?token=${TOKEN}${query}`,
      headers: { host: '127.0.0.1', ...(bearer ? { 'x-telepty-session-token': bearer } : {}) },
      socket: { remoteAddress: '127.0.0.1' },
    });
    sockets.push(ws);
    return ws;
  }

  // A credentialed wrapped instance with its owner bridge connected under `id`.
  async function addOwned(id) {
    const rec = record(id);
    sessions[id] = rec;
    const issued = credentials.issue(id);
    const owner = await connect(id, { owner: true, bearer: issued.bearer });
    await waitFor(() => owner.received.some((m) => m.type === 'owner_token'), `owner_token for ${id}`);
    assert.ok(rec.ownerWs && rec.ownerWs.readyState === 1, 'PRECONDITION: the owner claimed its record');
    return { rec, owner, bearer: issued.bearer };
  }

  // The real PATCH /api/sessions/:id handler, called with the request shape express would give it.
  function rename(from, to) {
    return new Promise((resolve, reject) => {
      const res = { statusCode: 200,
        status(code) { res.statusCode = code; return res; },
        json(body) { resolve({ status: res.statusCode, body }); return res; } };
      try {
        routes['/api/sessions/:id']({ params: { id: from }, body: { new_id: to }, headers: {} }, res);
      } catch (error) { reject(error); }
    });
  }

  async function renameOk(from, to, rec) {
    const r = await rename(from, to);
    assert.equal(r.status, 200, `PRECONDITION: supported rename accepted ${JSON.stringify(r.body)}`);
    assert.equal(sessions[to], rec, 'PRECONDITION: the same record object moved to the new key');
    assert.equal(Object.hasOwn(sessions, from), false, 'PRECONDITION: the old key is gone');
    assert.equal(rec.id, to, 'PRECONDITION: the record carries its new id');
  }

  return { sessions, calls, credentials, connect, addOwned, rename, renameOk };
}

// Peer → daemon: deliver one frame to the production message handler.
const send = (ws, frame) => ws.emit('message', JSON.stringify(frame));

test('1270 T1: the original stream feeds the admitted record', async (t) => {
  const h = await harness(t);
  const { rec, owner } = await h.addOwned('r1270-t1');
  send(owner, { type: 'output', data: 'before' });
  await waitFor(() => rec.outputRing.includes('before'), 'output in the admitted record');
  assert.deepEqual(h.calls.feed, [{ id: 'r1270-t1', data: 'before' }]);
});

test('1270 T2: a supported rename keeps the same connected owner and every stream continuous', async (t) => {
  const h = await harness(t);
  const OLD = 'r1270-t2-old', NEW = 'r1270-t2-new';
  const { rec, owner } = await h.addOwned(OLD);
  const viewer = await h.connect(OLD);   // attached before the rename
  const ownerSocket = rec.ownerWs, generation = rec.interactionOwnerGeneration, epoch = rec.sessionEpoch, token = rec.ownerToken;

  await h.renameOk(OLD, NEW, rec);

  send(owner, { type: 'output', data: 'after-rename' });
  await waitFor(() => rec.outputRing.includes('after-rename'), 'owner output after rename reaches the renamed record');
  await waitFor(() => viewer.received.some((m) => m.type === 'output' && m.data === 'after-rename'), 'fan-out to the pre-rename viewer');
  assert.deepEqual(h.calls.feed.filter((f) => f.data === 'after-rename'), [{ id: NEW, data: 'after-rename' }],
    'state is fed under the name the rename registered');

  send(owner, { type: 'heartbeat', pty_bytes: 4242, read_side: 'flowing' });
  await waitFor(() => rec.bridgePtyBytes === 4242, 'heartbeat after rename');
  assert.equal(rec.bridgeReadSide, 'flowing');
  assert.ok(rec.bridgeHeartbeatAt, 'heartbeat timestamp observed, not invented');

  send(owner, { type: 'ready' });
  await waitFor(() => rec.readyKind === 'legacy_unqualified_ready', 'ready frame after rename');

  const injectId = crypto.randomUUID();
  owner.emit('message', bridgeStage.receiptFrame({ meta: bridgeStage.frameMeta({ inject_id: injectId, owner_generation: generation }),
    bridgeMsgId: null, stage: 'pty_written', certainty: 'written', bridgeSeq: 1, atMs: Date.now(), ownerGeneration: generation }));
  await waitFor(() => h.calls.receipts.some((r) => r.inject_id === injectId), 'bridge receipt after rename');
  const receipt = h.calls.receipts.find((r) => r.inject_id === injectId);
  assert.equal(receipt.id, NEW, 'the receipt is filed under the current name');
  assert.equal(receipt.session, rec);

  send(viewer, { type: 'input', data: 'typed-after-rename' });
  await waitFor(() => owner.received.some((m) => m.type === 'inject' && m.data === 'typed-after-rename'), 'viewer input reaches the same owner');
  const auth = h.calls.authorize.at(-1);
  assert.equal(auth.sessionId, NEW, 'viewer input is authorized against the current name');
  assert.equal(auth.session, rec);

  assert.equal(rec.ownerWs, ownerSocket, 'same owner socket — no reconnect, no displacement');
  assert.equal(rec.interactionOwnerGeneration, generation, 'owner generation unchanged');
  assert.equal(rec.sessionEpoch, epoch, 'epoch unchanged');
  assert.equal(rec.ownerToken, token, 'owner token unchanged');
  assert.equal(owner.closeCode, null, 'the owner was not closed');
  assert.equal(h.calls.lifecycle.some((e) => e.type === 'session_disconnect'), false);
});

test('1270 T3: an owner close after rename detaches only the admitted renamed record', async (t) => {
  const h = await harness(t);
  const OLD = 'r1270-t3-old', NEW = 'r1270-t3-new';
  const { rec, owner } = await h.addOwned(OLD);
  await h.renameOk(OLD, NEW, rec);
  owner.close();
  await waitFor(() => rec.ownerWs === null, 'owner slot of the renamed record cleared on close');
  assert.deepEqual(h.calls.disconnected, [rec]);
  const disconnect = h.calls.lifecycle.filter((e) => e.type === 'session_disconnect');
  assert.equal(disconnect.length, 1);
  assert.equal(disconnect[0].id, NEW);
  assert.equal(disconnect[0].session, rec);
  assert.equal(rec.clients.size, 0);
});

test('1270 T4: a different instance later filed under the old name never receives the renamed owner (ABA)', async (t) => {
  const h = await harness(t);
  const OLD = 'r1270-t4-old', NEW = 'r1270-t4-new';
  const { rec, owner } = await h.addOwned(OLD);
  await h.renameOk(OLD, NEW, rec);
  const other = record(OLD);   // another instance takes the freed name; it has no owner
  h.sessions[OLD] = other;

  send(owner, { type: 'output', data: 'aba' });
  await waitFor(() => rec.outputRing.includes('aba'), 'output stays with the renamed instance');
  assert.deepEqual(other.outputRing, [], 'nothing is written into the instance holding the old name');
  assert.equal(other.ownerWs, null, 'the renamed owner never re-adopts the other instance');
  assert.equal(other.clients.size, 0);

  owner.close();
  await waitFor(() => rec.ownerWs === null, 'close detaches the renamed instance');
  assert.equal(other.ownerWs, null);
  assert.equal(h.calls.disconnected.includes(other), false, 'the other instance is never marked disconnected');
});

test('1270 T5: renamed and then removed — frames and close are inert everywhere', async (t) => {
  const h = await harness(t);
  const OLD = 'r1270-t5-old', NEW = 'r1270-t5-new';
  const { rec, owner } = await h.addOwned(OLD);
  await h.renameOk(OLD, NEW, rec);
  delete h.sessions[NEW];
  const other = record(OLD);
  h.sessions[OLD] = other;

  send(owner, { type: 'output', data: 'gone' });
  send(owner, { type: 'heartbeat', pty_bytes: 7 });
  await delay(250);
  assert.equal(rec.outputRing.includes('gone'), false, 'the removed record is not written');
  assert.deepEqual(other.outputRing, [], 'the old-name instance is not written');
  assert.equal(other.ownerWs, null, 'the old-name instance is not adopted');
  assert.equal(other.bridgePtyBytes, undefined);

  owner.close();
  await delay(250);
  assert.equal(other.ownerWs, null);
  assert.deepEqual(h.calls.disconnected, [], 'no record is marked disconnected by an inert socket');
});

test('1270 T6: viewer input after rename obeys the existing authorization verdict', async (t) => {
  const h = await harness(t, { viewerVerdict: ({ data }) => data !== 'deny-me' });
  const OLD = 'r1270-t6-old', NEW = 'r1270-t6-new';
  const { rec, owner } = await h.addOwned(OLD);
  const viewer = await h.connect(OLD);
  await h.renameOk(OLD, NEW, rec);

  send(viewer, { type: 'input', data: 'deny-me' });
  send(viewer, { type: 'input', data: 'allow-me' });
  await waitFor(() => owner.received.some((m) => m.type === 'inject' && m.data === 'allow-me'), 'authorized input delivered');
  assert.equal(owner.received.some((m) => m.type === 'inject' && m.data === 'deny-me'), false, 'refused input is never delivered');
  assert.deepEqual(h.calls.authorize.map((a) => [a.sessionId, a.data]), [[NEW, 'deny-me'], [NEW, 'allow-me']]);
  assert.ok(h.calls.authorize.every((a) => a.session === rec && a.principal === null),
    'the viewer keeps its own (absent) principal; no owner authority is borrowed');
});

test('1270 T7: the credential follows the rename; an unauthenticated owner claim on the new name is refused', async (t) => {
  const h = await harness(t);
  const OLD = 'r1270-t7-old', NEW = 'r1270-t7-new';
  const { rec, owner } = await h.addOwned(OLD);
  await h.renameOk(OLD, NEW, rec);
  const thief = await h.connect(NEW, { owner: true });
  await waitFor(() => thief.closeCode !== null, 'unauthenticated owner claim closed');
  assert.equal(thief.closeCode, 4003);
  assert.equal(rec.ownerWs && rec.ownerWs.readyState, 1, 'the admitted owner keeps the slot');
  send(owner, { type: 'output', data: 'still-owner' });
  await waitFor(() => rec.outputRing.includes('still-owner'), 'admitted owner still feeds the record');
});

test('1270 T8: an unrelated unrenamed session is unaffected', async (t) => {
  const h = await harness(t);
  const { rec: other, owner: otherOwner } = await h.addOwned('r1270-t8-other');
  const { rec } = await h.addOwned('r1270-t8-old');
  await h.renameOk('r1270-t8-old', 'r1270-t8-new', rec);
  send(otherOwner, { type: 'output', data: 'other-output' });
  await waitFor(() => other.outputRing.includes('other-output'), 'unrelated session output');
  assert.equal(other.id, 'r1270-t8-other');
  assert.equal(h.sessions['r1270-t8-other'], other);
  assert.deepEqual(h.calls.feed.filter((f) => f.data === 'other-output'), [{ id: 'r1270-t8-other', data: 'other-output' }]);
  assert.equal(rec.outputRing.includes('other-output'), false);
});
