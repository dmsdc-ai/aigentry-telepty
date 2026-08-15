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
    // #823: `isAllowedPeer` is now a reachability PRECONDITION that can only narrow, not an
    // alternative to the credential. `false` here would mean "this address may not connect at
    // all" (403) and no token would buy past it; the token in the URL is what authenticates.
    isAllowedPeer: () => true,
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

// --- #60 Stage A §3.7: ready-frame qualification -----------------------------------------
//
// A `ready` frame says a surface looks able to RECEIVE an inject. It has never said a turn ended,
// but it used to arrive as an anonymous `{type:"ready"}` and the daemon fired the "auto-report"
// path off it — telling the source the target "completed inject task". Two different detectors
// produce that frame and they are not equally strong: a registry-tail match sees a known CLI's
// composer surface, while the generic path is a regex on the current frame that `cat` of a shell
// script satisfies. Stage A qualifies them and keeps the legacy bare frame DISTINCT, so a 0.7.1
// bridge can never borrow a qualified name.

async function readyFrameLands(frame) {
  const app = express();
  const server = http.createServer(app);
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const sessions = { [SID]: newRecord() };
  installWebSocketTransport(buildDeps(server, sessions));

  const ws = await connectOwner(port);
  ws.send(JSON.stringify({ type: 'ready', ...frame }));
  await delay(150);
  try { ws.terminate(); } catch { /* already gone */ }
  server.close();
  return sessions[SID];
}

test('#60 §3.7: a registry-tail match is recorded as a qualified composer surface', async () => {
  const session = await readyFrameLands({
    ready_kind: 'composer_surface_observed', detector: 'claude_composer_marker', cli_key: 'claude',
  });
  assert.equal(session.readyKind, 'composer_surface_observed');
  assert.equal(session.readyDetector, 'claude_composer_marker',
    'the detector is REQUIRED evidence for this observation row — without it the cause maps unmapped');
  assert.equal(session.readyCliKey, 'claude');
});

test('#60 §3.7: a generic current-frame match stays the weaker prompt-suffix observation', async () => {
  const session = await readyFrameLands({
    ready_kind: 'prompt_suffix_observed', detector: 'generic_prompt_suffix', cli_key: null,
  });
  assert.equal(session.readyKind, 'prompt_suffix_observed');
  assert.equal(session.readyDetector, 'generic_prompt_suffix');
  assert.equal(session.readyCliKey, null, 'no known CLI was identified, so no key is claimed');
});

test('#60 §3.7: a legacy bare ready frame cannot borrow a qualified name', async () => {
  // Exactly what a 0.7.1 bridge sends, including after a daemon restart replays it (§ deployment
  // step 5). It measured something, so it is not discarded — it is just not allowed to present
  // itself as the stronger observation.
  const session = await readyFrameLands({});
  assert.equal(session.readyKind, 'legacy_unqualified_ready');
  assert.equal(session.readyDetector, 'unqualified');
  assert.equal(session.readyCliKey, null);
});

test('#60 §3.7: an unrecognised ready_kind is refused, not passed through', async () => {
  // The frame is bridge-supplied input. A kind this daemon does not know — a future name, a typo,
  // or a crafted one — must fail CLOSED to legacy rather than being written onto the session and
  // handed to the cause mapper as if the bridge had authority to name observations.
  const session = await readyFrameLands({
    ready_kind: 'task_completed_observed', detector: 'made_up', cli_key: 'claude',
  });
  assert.equal(session.readyKind, 'legacy_unqualified_ready',
    'an unknown kind must not be stored — the bridge does not get to name observations');
  assert.equal(session.readyDetector, 'unqualified');
  assert.equal(session.readyCliKey, null);
});

test('#60 §3.7: a later bare frame clears an earlier qualification instead of keeping it stale', async () => {
  const app = express();
  const server = http.createServer(app);
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const sessions = { [SID]: newRecord() };
  installWebSocketTransport(buildDeps(server, sessions));

  const ws = await connectOwner(port);
  ws.send(JSON.stringify({
    type: 'ready', ready_kind: 'composer_surface_observed', detector: 'claude_composer_marker', cli_key: 'claude',
  }));
  await delay(120);
  assert.equal(sessions[SID].readyKind, 'composer_surface_observed', 'baseline: the qualified frame landed');

  // A reconnecting or downgraded bridge now sends the bare frame. Keeping the earlier, stronger
  // name would let a session keep wearing a measurement nobody is making any more.
  ws.send(JSON.stringify({ type: 'ready' }));
  await delay(120);
  after(() => { try { ws.terminate(); } catch { /* already gone */ } server.close(); });

  assert.equal(sessions[SID].readyKind, 'legacy_unqualified_ready',
    'the qualification must not survive a frame that no longer carries it');
  assert.equal(sessions[SID].readyCliKey, null);
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
