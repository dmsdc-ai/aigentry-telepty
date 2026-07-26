'use strict';

// #732 (H5 guard) — the owner connection must never route through a stale session record.
//
// `installWebSocketTransport` takes `const activeSession = sessions[sessionId]` ONCE, at
// connect time, and every later frame was judged against that snapshot. If sessions[id] is
// replaced under a live owner — a delete+recreate via DELETE /:id (daemon.js) or the
// disconnect GC followed by the bridge's re-register — the snapshot goes orphan:
// `ws === activeSession.ownerWs` still holds, so 'output' frames are appended to a record
// nobody reads, while injects keep routing to the LIVE record's ownerWs. That is #732's
// asymmetry (upstream dead, downstream alive) reached by a second route, and it is silent.
//
// No current daemon path produces the swap (DELETE closes every client first, and the GC
// requires a closed owner), so this is defense in depth: the guard is driven through the
// transport's own DI seam by swapping the record the way a future caller could.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const { installWebSocketTransport } = require('../src/transport/websocket');

const TOKEN = 'ws-swap-732-token';
const SID = 'swap-732';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function newRecord() {
  return {
    id: SID, type: 'wrapped', ownerWs: null, clients: new Set(),
    outputRing: [], outputRingTotalBytes: 0, ready: true,
    createdAt: new Date().toISOString(), lastActivityAt: null, lastDisconnectedAt: null
  };
}

function buildDeps(server, sessions) {
  return {
    server,
    tailnetServer: null,
    sessions,
    busClients: new Set(),
    expectedToken: TOKEN,
    verifyJwt: () => false,
    isAllowedPeer: () => false,
    initializeBootstrapState: () => {},
    findKittySocket: () => null,
    findKittyWindowId: () => null,
    markSessionConnected: () => {},
    scheduleBootstrapPromptPoll: () => {},
    emitSessionLifecycleEvent: () => {},
    persistSessions: () => {},
    // Mirrors the real appendToOutputRing closely enough to prove WHICH record was fed.
    appendToOutputRing: (session, data) => {
      session.outputRing.push(data);
      session.outputRingTotalBytes = (session.outputRingTotalBytes || 0) + data.length;
    },
    sessionStateManager: { feed: () => {} },
    isBootstrapGatedSession: () => false,
    markBootstrapReady: () => {},
    pendingReports: {},
    fireAutoReport: () => {},
    markSessionDisconnected: () => {},
    resolveSessionAlias: (id) => id,
    applySessionStateReport: () => ({ success: false }),
    busAutoRoute: () => {},
  };
}

async function connectOwner(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${SID}?token=${TOKEN}&owner=1&owner_pid=${process.pid}`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return ws;
}

test('#732 H5: output frames follow the LIVE session record after it is replaced under the owner', async () => {
  const app = express();
  const server = http.createServer(app);
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

  const original = newRecord();
  const sessions = { [SID]: original };
  installWebSocketTransport(buildDeps(server, sessions));

  const ws = await connectOwner(port);
  after(() => { try { ws.terminate(); } catch { /* already gone */ } server.close(); });

  ws.send(JSON.stringify({ type: 'output', data: 'before-swap' }));
  await delay(200);
  assert.deepEqual(original.outputRing, ['before-swap'], 'baseline: the owner feeds its record');

  // The swap: sessions[SID] now points at a different object, exactly as a
  // delete-then-re-register would leave it. The socket is untouched and still open.
  const replacement = newRecord();
  sessions[SID] = replacement;

  ws.send(JSON.stringify({ type: 'output', data: 'after-swap' }));
  await delay(200);

  assert.deepEqual(replacement.outputRing, ['after-swap'],
    'the frame must land in the record that read-screen/attach actually serve');
  // (identity is against the SERVER-side socket, not the client handle above)
  assert.ok(replacement.ownerWs && replacement.ownerWs.readyState === 1,
    'the owner socket re-adopts the free owner slot instead of silently degrading to a viewer');
  assert.ok(replacement.clients.has(replacement.ownerWs),
    'and rejoins the client set, so attach viewers still receive the fan-out');
  assert.deepEqual(original.outputRing, ['before-swap'],
    'and nothing keeps writing into the orphaned record');
});

test('#732 H5: re-adoption never displaces a live owner', async () => {
  const app = express();
  const server = http.createServer(app);
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

  const sessions = { [SID]: newRecord() };
  installWebSocketTransport(buildDeps(server, sessions));

  const first = await connectOwner(port);
  await delay(150);
  const replacement = newRecord();
  // A DIFFERENT, open owner already holds the slot on the replacement record.
  const liveOwner = { readyState: 1, send: () => {} };
  replacement.ownerWs = liveOwner;
  sessions[SID] = replacement;

  first.send(JSON.stringify({ type: 'output', data: 'from-displaced' }));
  await delay(200);

  after(() => { try { first.terminate(); } catch { /* already gone */ } server.close(); });

  assert.equal(replacement.ownerWs, liveOwner,
    'an open owner is never displaced — same last-writer-wins rule as the connect-time claim');
  assert.deepEqual(replacement.outputRing, [],
    'and the non-owner socket stays a viewer');
});
