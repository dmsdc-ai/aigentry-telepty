'use strict';
// Regression for cross-host `telepty attach` failing with "Unexpected server response: 200".
//
// Root cause: the WS upgrade handler was installed on the loopback listener only. On the
// tailnet auto-bind path the daemon opens a SECOND socket (app.listen(PORT, TAILNET_IP)) with
// no upgrade handler, so a cross-host WS handshake fell through to Express GET /api/sessions/:id
// and returned HTTP 200 instead of 101. Fix: installWebSocketTransport attaches the SAME
// handler to both `server` and the new optional `tailnetServer`.
//
// This test binds two http listeners sharing one Express app (mirrors the dual-listener) and
// asserts BOTH upgrade to 101 — while an UNAUTHORIZED upgrade still rejects, so attach never
// gains broader reach than inject/read-screen (same isAllowedPeer||token||jwt check).

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const { installWebSocketTransport } = require('../src/transport/websocket');

const TOKEN = 'attachfix-test-token';
const SID = 's1';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Attempt a WS upgrade; resolve to a compact outcome regardless of success/failure.
function attempt(port, { token } = {}) {
  return new Promise((resolve) => {
    const q = token != null ? `?token=${encodeURIComponent(token)}` : '';
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${SID}${q}`);
    const done = (r) => { try { ws.terminate(); } catch {} resolve(r); };
    ws.on('open', () => done({ kind: 'open' }));
    ws.on('unexpected-response', (_req, res) => { res.resume(); done({ kind: 'http', status: res.statusCode }); });
    ws.on('error', (e) => done({ kind: 'error', message: e.message }));
    setTimeout(() => done({ kind: 'timeout' }), 3000);
  });
}

function buildApp() {
  const app = express();
  // Mirrors daemon.js:2465 — the plain GET the WS handshake fell through to (returns 200).
  app.get('/api/sessions/:id', (_req, res) => res.json({ id: SID, active_clients: 1 }));
  return app;
}

// Minimal deps: only the viewer-attach path runs after upgrade. isAllowedPeer=false forces
// token-based auth so we can exercise BOTH the accept (correct token) and reject (no token) paths.
function buildDeps(primary, secondary) {
  const sessions = {
    [SID]: { id: SID, type: 'wrapped', ownerWs: { readyState: 1 }, clients: new Set(), outputRing: [] }
  };
  return {
    server: primary,
    tailnetServer: secondary,
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
    appendToOutputRing: () => {},
    sessionStateManager: { feed: () => {} },
    isBootstrapGatedSession: () => false,
    markBootstrapReady: () => {},
    pendingReports: {},
    fireAutoReport: () => {},
    markSessionDisconnected: () => {},
    resolveSessionAlias: (id) => id,
    applySessionStateReport: () => ({ success: false }),
    relayToPeers: () => {},
    busAutoRoute: () => {},
  };
}

test('both loopback and tailnet listeners upgrade attach to WS (101), auth preserved', async () => {
  const app = buildApp();
  const primary = http.createServer(app);   // loopback (local attach)
  const secondary = http.createServer(app); // tailnet listener (cross-host attach)
  const primaryPort = await listen(primary);
  const secondaryPort = await listen(secondary);

  installWebSocketTransport(buildDeps(primary, secondary));

  after(() => { primary.close(); secondary.close(); });

  // Authorized: loopback upgrades (baseline — local attach byte-identical).
  const loopback = await attempt(primaryPort, { token: TOKEN });
  assert.equal(loopback.kind, 'open', `loopback attach should upgrade (101), got ${JSON.stringify(loopback)}`);

  // Authorized: tailnet listener ALSO upgrades (THE FIX — was HTTP 200 pre-fix).
  const tailnet = await attempt(secondaryPort, { token: TOKEN });
  assert.equal(tailnet.kind, 'open', `cross-host attach should upgrade (101), got ${JSON.stringify(tailnet)}`);

  // Security invariant: an UNAUTHORIZED cross-host upgrade still rejects (no widening vs inject).
  const unauth = await attempt(secondaryPort, { token: 'wrong' });
  assert.notEqual(unauth.kind, 'open', `unauthorized cross-host attach must NOT upgrade, got ${JSON.stringify(unauth)}`);
  assert.ok(
    unauth.kind === 'http' && unauth.status === 401 || unauth.kind === 'error',
    `unauthorized cross-host attach should be rejected (401/close), got ${JSON.stringify(unauth)}`
  );
});
