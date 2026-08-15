'use strict';
// P0 SECURITY — any website the user merely visits can drive their AI CLI sessions.
//
// The daemon listens on loopback and `isAllowedPeer` USED TO short-circuit the middleware for
// 127.0.0.1/::1, before any token check (#820 closed that; the credential is now required for
// every address). So a page in the user's browser could
// `fetch('http://127.0.0.1:3848/api/sessions/<sid>/inject', {method:'POST', ...})` and type
// into a live AI CLI session with no token and no interaction. The response is CORS-gated
// (and this daemon answers `Access-Control-Allow-Origin: *`, so not even that) — but the
// REQUEST EXECUTES, which is the whole attack. A WebSocket handshake is not CORS-gated at
// all, so `new WebSocket('ws://127.0.0.1:3848/api/sessions/<sid>')` was full read/write on
// somebody's terminal.
//
// Guard: browsers ALWAYS attach `Origin` to a cross-origin fetch and to every WS handshake;
// curl, the telepty CLI, and SSH-tunnelled peers never do. A request carrying `Origin` must
// name an explicitly allowlisted origin (TELEPTY_ALLOWED_ORIGINS, default empty) or it is
// refused before the loopback branch. Origin-less callers keep the exact old path.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const { createAuthMiddleware, createIsAllowedPeer } = require('../src/protocol/http-auth');
const { installWebSocketTransport } = require('../src/transport/websocket');

const EVIL = 'https://evil.example';
const SID = 's1';

// ── HTTP: the drive-by inject vector ────────────────────────────────────────────

// Mirrors daemon.js: cors() → auth middleware → routes, with the REAL loopback-trusting
// isAllowedPeer (empty allowlist = the default install). Listening on 127.0.0.1 makes every
// request in this file a genuine loopback caller, exactly like the attacking page's fetch.
function buildHttpApp(allowedOrigins) {
  const injects = [];
  const app = express();
  app.use(require('cors')());
  app.use(createAuthMiddleware({
    isAllowedPeer: createIsAllowedPeer([]),
    expectedToken: 'sekret',
    verifyJwt: () => false,
    allowedOrigins
  }));
  app.post('/api/sessions/:id/inject', (req, res) => { injects.push(req.params.id); res.json({ ok: true }); });
  app.get('/api/sessions', (_req, res) => res.json({ sessions: [{ id: SID, cwd: '/Users/victim/secret-project' }] }));
  return { app, injects };
}

async function serve(app) {
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('drive-by: a loopback POST carrying Origin is refused and never reaches the route', async () => {
  const { app, injects } = buildHttpApp([]);
  const base = await serve(app);

  const res = await fetch(`${base}/api/sessions/${SID}/inject`, {
    method: 'POST',
    headers: { origin: EVIL, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'rm -rf ~' })
  });

  assert.equal(res.status, 403, 'a browser-originated inject must be refused');
  assert.equal((await res.json()).code, 'ORIGIN_NOT_ALLOWED');
  assert.deepEqual(injects, [], 'the route handler must never run for a drive-by request');
});

test('CLI path unchanged: the same loopback POST without Origin still succeeds', async () => {
  const { app, injects } = buildHttpApp([]);
  const base = await serve(app);

  // #820: the token is what makes this the CLI path now. Before, an origin-less loopback POST
  // succeeded with NO credential — this assertion encoded that as intended behaviour. The Origin
  // half of the contract (#806) is untouched: an origin-less caller still takes the old path.
  const res = await fetch(`${base}/api/sessions/${SID}/inject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telepty-token': 'sekret' },
    body: JSON.stringify({ prompt: 'hello' })
  });

  assert.equal(res.status, 200, 'every existing CLI/tunnel caller is origin-less and must be untouched');
  assert.deepEqual(injects, [SID]);
});

test('drive-by: reads are guarded too — GET /api/sessions with Origin is refused', async () => {
  // Not just writes: this route discloses session ids and cwd paths, /screen discloses the
  // terminal itself, and cors() answers `*` — so a page really can read the body back.
  const { app } = buildHttpApp([]);
  const base = await serve(app);

  const blocked = await fetch(`${base}/api/sessions`, { headers: { origin: EVIL } });
  assert.equal(blocked.status, 403);

  const cli = await fetch(`${base}/api/sessions`, { headers: { 'x-telepty-token': 'sekret' } });
  assert.equal(cli.status, 200, 'origin-less CREDENTIALED read stays open');
});

test('drive-by: a stolen token does not buy a disallowed origin past the guard', async () => {
  const { app } = buildHttpApp([]);
  const base = await serve(app);

  const res = await fetch(`${base}/api/sessions`, { headers: { origin: EVIL, 'x-telepty-token': 'sekret' } });
  assert.equal(res.status, 403, 'the origin gate is absolute — credentials are checked after it');
});

test('drive-by: Origin: null (sandboxed iframe, file://) is refused, not treated as absent', async () => {
  const { app } = buildHttpApp([]);
  const base = await serve(app);

  const res = await fetch(`${base}/api/sessions`, { headers: { origin: 'null' } });
  assert.equal(res.status, 403);
});

test('an explicitly allowlisted origin is let through (opt-in escape hatch)', async () => {
  const { app, injects } = buildHttpApp(['https://ui.example']);
  const base = await serve(app);

  const ok = await fetch(`${base}/api/sessions/${SID}/inject`, {
    method: 'POST',
    headers: { origin: 'https://ui.example', 'content-type': 'application/json', 'x-telepty-token': 'sekret' },
    body: JSON.stringify({ prompt: 'hi' })
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(injects, [SID]);

  const still = await fetch(`${base}/api/sessions`, { headers: { origin: EVIL } });
  assert.equal(still.status, 403, 'allowlisting one origin must not open the rest');
});

// ── WebSocket: the worse half of the same vector (no CORS at all) ────────────────

function attachWs(port, opts = {}, query = '') {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${SID}${query}`, opts);
    const done = (r) => { try { ws.terminate(); } catch {} resolve(r); };
    ws.on('open', () => done({ kind: 'open' }));
    ws.on('unexpected-response', (_req, res) => { res.resume(); done({ kind: 'http', status: res.statusCode }); });
    ws.on('error', (e) => done({ kind: 'error', message: e.message }));
    setTimeout(() => done({ kind: 'timeout' }), 3000);
  });
}

// Same minimal dep set as attach-crosshost-upgrade.test.js, but with the REAL loopback-trusting
// isAllowedPeer — that trust is precisely what the browser was riding.
function buildWsDeps(server, allowedOrigins) {
  return {
    server,
    sessions: { [SID]: { id: SID, type: 'wrapped', ownerWs: { readyState: 1 }, clients: new Set(), outputRing: [] } },
    busClients: new Set(),
    expectedToken: 'sekret',
    verifyJwt: () => false,
    isAllowedPeer: createIsAllowedPeer([]),
    allowedOrigins,
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
    busAutoRoute: () => {}
  };
}

test('drive-by: a browser WebSocket handshake carrying Origin is refused, an Origin-less one upgrades', async () => {
  const server = http.createServer(express());
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  after(() => server.close());
  installWebSocketTransport(buildWsDeps(server, []));

  const evil = await attachWs(port, { origin: EVIL });
  assert.notEqual(evil.kind, 'open', `a page must not attach to a terminal, got ${JSON.stringify(evil)}`);
  // #820 tightened this from "403 or some error" to "403, specifically": the refusal is now a
  // complete HTTP response written with end() rather than a raced write+destroy, so the client
  // reliably reads the status instead of an ECONNRESET that looks like a dead daemon.
  assert.equal(evil.kind, 'http', `browser WS handshake should be refused with a readable status, got ${JSON.stringify(evil)}`);
  assert.equal(evil.status, 403);

  // #820: an origin-less upgrade must now carry the token as well. Before, this asserted that an
  // uncredentialed loopback handshake OPENS — the defect, recorded as the contract.
  const cli = await attachWs(port, { headers: { authorization: '' } }, '?token=sekret');
  assert.equal(cli.kind, 'open', `telepty attach (no Origin, with the token) must still upgrade, got ${JSON.stringify(cli)}`);

  const tokenless = await attachWs(port);
  assert.equal(tokenless.kind, 'http', `an origin-less UNCREDENTIALED handshake must be refused, got ${JSON.stringify(tokenless)}`);
  assert.equal(tokenless.status, 401);
});
