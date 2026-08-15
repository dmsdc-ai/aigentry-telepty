'use strict';

// #820 + #823 — reachability is not authentication.
//
// The daemon has always minted an auth token, but the middleware short-circuited on the PEER
// POLICY answer before the token was ever consulted (`http-auth.js` `if (isAllowedPeer(ip))
// return next()`), and `isAllowedPeer` answers `true` for loopback unconditionally AND for every
// address when the allowlist is empty AND for any address that MATCHES a non-empty allowlist.
// So three different populations reached every route with no credential:
//
//   * any process on the box                       (loopback branch)
//   * every address on a network-bound daemon      (empty-allowlist branch)
//   * every tailnet device on the default config   (allowlist-MATCH branch, #672 auto-trust)
//
// The last one is the one that reads as safe and is not: an allowlist that matches returns `true`
// just as completely as an empty one, so `TELEPTY_PEER_ALLOWLIST` narrowed *reachability* while
// silently granting *authentication*.
//
// After this change `isAllowedPeer` can only NARROW — it is applied before the credential check
// and its failure is 403 — and the credential check then runs for EVERY address, loopback
// included. Order is unchanged: origin guard -> peer policy -> credential -> route, so #806's
// property (a stolen credential cannot buy a disallowed origin) still holds.
//
// Cases 1-6 and 14-16 are the refusals: RED against the base commit.
// Cases 7-13 and 17 are the anti-regression half: GREEN before and after. Their job is to fail
// if this over-tightens.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const express = require('express');
const WebSocket = require('ws');

const { startTestDaemon, createSessionId } = require('../test-support/daemon-harness');
const {
  createAuthMiddleware,
  createIsAllowedPeer,
  createOriginGuard,
  createVerifyJwt,
  isLoopbackAddress
} = require('../src/protocol/http-auth');
const { installWebSocketTransport } = require('../src/transport/websocket');

let daemon;
let TOKEN;
let base;

// Read the daemon's own secret the way any legitimate consumer does. Deliberately NOT taken from
// the harness: this file must run unchanged against the base commit, where the harness has no
// token plumbing at all.
function readDaemonToken(homeDir) {
  const cfg = path.join(homeDir, '.telepty', 'config.json');
  return JSON.parse(fs.readFileSync(cfg, 'utf8')).authToken;
}

function tokenHeader() {
  return { 'x-telepty-token': TOKEN };
}

async function raw(pathname, options = {}) {
  const res = await fetch(`${base}${pathname}`, options);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text };
}

// Open a socket and report WHICH of the three outcomes happened, because telling them apart is
// half of what this change buys: `refused` carries an HTTP status the daemon wrote deliberately,
// `error`/close 1006 is what a client sees when nothing is there.
function dialWs(pathname, options = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${daemon.host}:${daemon.port}${pathname}`, options);
    const settle = (r) => { try { ws.terminate(); } catch { /* already gone */ } resolve(r); };
    ws.on('open', () => resolve({ kind: 'open', ws }));
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (c) => { body += c.toString(); });
      res.on('end', () => settle({ kind: 'refused', status: res.statusCode, body, headers: res.headers }));
    });
    ws.on('error', (e) => settle({ kind: 'error', message: e.message }));
    setTimeout(() => settle({ kind: 'timeout' }), 4000);
  });
}

function nextFrame(ws, predicate, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { ws.off('message', onMessage); resolve(null); }, timeoutMs);
    function onMessage(buf) {
      let msg = null;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      if (!predicate(msg)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(msg);
    }
    ws.on('message', onMessage);
  });
}

// A credentialed owner bridge for `sid`, holding the #815 session bearer so its ?owner=1 claim is
// accepted. Returns the open socket.
async function openOwner(sid, bearer) {
  const url = `/api/sessions/${encodeURIComponent(sid)}?token=${encodeURIComponent(TOKEN)}&owner=1&owner_pid=${process.pid}&command=test-wrap`;
  const result = await dialWs(url, { headers: { 'x-telepty-session-token': bearer } });
  assert.equal(result.kind, 'open', `owner bridge must connect, got ${JSON.stringify(result)}`);
  return result.ws;
}

before(async () => {
  daemon = await startTestDaemon();
  TOKEN = readDaemonToken(daemon.homeDir);
  base = `http://${daemon.host}:${daemon.port}`;
});

after(async () => { if (daemon) await daemon.stop(); });

// ── 1-6: the refusals. RED on the base commit. ──────────────────────────────────────────

test('1) an uncredentialed viewer is refused the upgrade and never observes the PTY bytes', async () => {
  const sid = createSessionId('canary');
  const reg = await raw(`/api/sessions/register`, {
    method: 'POST',
    headers: { ...tokenHeader(), 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: sid, command: 'test-wrap', cwd: process.cwd() })
  });
  assert.ok([200, 201].includes(reg.status), `register: ${reg.status} ${reg.text}`);
  const owner = await openOwner(sid, reg.body.session_token);

  const attacker = await dialWs(`/api/sessions/${encodeURIComponent(sid)}`);
  assert.notEqual(attacker.kind, 'open',
    `an uncredentialed socket must not attach to a terminal, got ${JSON.stringify(attacker)}`);
  assert.equal(attacker.kind, 'refused', `expected a deliberate HTTP refusal, got ${JSON.stringify(attacker)}`);
  assert.equal(attacker.status, 401);

  // The refusal is the mechanism; non-observation is the property. Assert both — a socket held
  // open by some other route would still be a leak.
  const CANARY = `canary-${Date.now()}-do-not-leak`;
  owner.send(JSON.stringify({ type: 'output', data: CANARY }));
  const screen = await raw(`/api/sessions/${encodeURIComponent(sid)}/screen?lines=50`, { headers: tokenHeader() });
  assert.equal(screen.status, 200);
  assert.ok(String(screen.body.screen || '').includes(CANARY), 'the owner leg itself must still work');

  owner.close();
});

test('2) an uncredentialed {type:"input"} never reaches the owner as an inject', async () => {
  const sid = createSessionId('nowrite');
  const reg = await raw(`/api/sessions/register`, {
    method: 'POST',
    headers: { ...tokenHeader(), 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: sid, command: 'test-wrap', cwd: process.cwd() })
  });
  const owner = await openOwner(sid, reg.body.session_token);

  const attacker = await dialWs(`/api/sessions/${encodeURIComponent(sid)}`);
  assert.notEqual(attacker.kind, 'open', `uncredentialed write socket must be refused, got ${JSON.stringify(attacker)}`);

  // Even if a socket were somehow held, the owner must see no inject frame.
  const injected = await nextFrame(owner, (m) => m.type === 'inject', 800);
  assert.equal(injected, null, `owner received an inject from an uncredentialed viewer: ${JSON.stringify(injected)}`);
  owner.close();
});

test('3) GET /screen without a credential is 401 and carries no PTY bytes', async () => {
  const sid = createSessionId('screen');
  await daemon.request('/api/sessions/spawn', {
    method: 'POST',
    headers: tokenHeader(),
    body: { session_id: sid, cwd: process.cwd(), cols: 80, rows: 24, type: 'USER', command: 'bash', args: ['--noprofile', '--norc'] }
  });

  const res = await raw(`/api/sessions/${encodeURIComponent(sid)}/screen?lines=50`);
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'PERMISSION_DENIED');
  assert.equal(Object.prototype.hasOwnProperty.call(res.body, 'screen'), false,
    'a refusal must not carry the screen it refused');
});

test('4) POST /inject without a credential is 401 and the delivery path never runs', async () => {
  const sid = createSessionId('noinject');
  const reg = await raw(`/api/sessions/register`, {
    method: 'POST',
    headers: { ...tokenHeader(), 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: sid, command: 'test-wrap', cwd: process.cwd() })
  });
  const owner = await openOwner(sid, reg.body.session_token);

  const res = await raw(`/api/sessions/${encodeURIComponent(sid)}/inject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'rm -rf ~' })
  });
  assert.equal(res.status, 401);

  const delivered = await nextFrame(owner, (m) => m.type === 'inject', 800);
  assert.equal(delivered, null, 'an uncredentialed inject reached the PTY owner');
  owner.close();
});

test('5) GET /api/sessions without a credential is 401 — ids, command and cwd are disclosure', async () => {
  const res = await raw('/api/sessions');
  assert.equal(res.status, 401);
  assert.equal(Array.isArray(res.body), false, 'a refusal must not answer with a session list');
});

test('6) POST /api/sessions/spawn without a credential is 401 and spawns nothing', async () => {
  // The highest-severity instance of the same enabler: `command` and `cwd` are caller-chosen, so
  // an accepted spawn is arbitrary code execution. If a later refactor re-opens loopback, this is
  // the assertion that screams.
  const sid = createSessionId('rce');
  const res = await raw('/api/sessions/spawn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: sid, cwd: process.cwd(), cols: 80, rows: 24, type: 'USER',
      command: 'bash', args: ['--noprofile', '--norc']
    })
  });
  assert.equal(res.status, 401);

  const list = await raw('/api/sessions', { headers: tokenHeader() });
  assert.equal(list.status, 200);
  assert.equal(list.body.some((s) => s.id === sid), false, 'an uncredentialed spawn created a session');
});

// ── 7-13: the anti-regression half. GREEN before AND after. ─────────────────────────────

test('7) attach with the token upgrades and receives the owner output frames', async () => {
  const sid = createSessionId('attach-ok');
  const reg = await raw(`/api/sessions/register`, {
    method: 'POST',
    headers: { ...tokenHeader(), 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: sid, command: 'test-wrap', cwd: process.cwd() })
  });
  const owner = await openOwner(sid, reg.body.session_token);

  const viewer = await dialWs(`/api/sessions/${encodeURIComponent(sid)}?token=${encodeURIComponent(TOKEN)}`);
  assert.equal(viewer.kind, 'open', `credentialed attach must still work, got ${JSON.stringify(viewer)}`);

  const MARK = `mark-${Date.now()}`;
  const seen = nextFrame(viewer.ws, (m) => m.type === 'output' && String(m.data || '').includes(MARK), 3000);
  owner.send(JSON.stringify({ type: 'output', data: MARK }));
  assert.ok(await seen, 'a credentialed viewer must still read the stream');

  viewer.ws.close();
  owner.close();
});

test('8) read-screen with the token header is 200 with content', async () => {
  const sid = createSessionId('read-ok');
  const reg = await raw(`/api/sessions/register`, {
    method: 'POST',
    headers: { ...tokenHeader(), 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: sid, command: 'test-wrap', cwd: process.cwd() })
  });
  const owner = await openOwner(sid, reg.body.session_token);
  const MARK = `screen-${Date.now()}`;
  owner.send(JSON.stringify({ type: 'output', data: MARK }));

  const res = await daemon.waitFor(async () => {
    const r = await raw(`/api/sessions/${encodeURIComponent(sid)}/screen?lines=50`, { headers: tokenHeader() });
    return r.status === 200 && String(r.body.screen || '').includes(MARK) ? r : null;
  }, { timeoutMs: 3000, description: 'credentialed read-screen' });
  assert.equal(res.status, 200);
  owner.close();
});

test('9) orchestrator polling with the token header keeps working', async () => {
  const sid = createSessionId('poll');
  await daemon.request('/api/sessions/spawn', {
    method: 'POST',
    headers: tokenHeader(),
    body: { session_id: sid, cwd: process.cwd(), cols: 80, rows: 24, type: 'USER', command: 'bash', args: ['--noprofile', '--norc'] }
  });

  const list = await raw('/api/sessions', { headers: tokenHeader() });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body));

  // 404 is a legitimate answer here (no pending report); 401 is not.
  const pending = await raw(`/api/pendingReports/${encodeURIComponent(sid)}`, { headers: tokenHeader() });
  assert.notEqual(pending.status, 401, 'a credentialed poll must never be refused');
});

test('10) #815 is undisturbed: a wrong session bearer still gets close 4003 on the owner claim', async () => {
  const sid = createSessionId('claim-gate');
  await raw(`/api/sessions/register`, {
    method: 'POST',
    headers: { ...tokenHeader(), 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: sid, command: 'test-wrap', cwd: process.cwd() })
  });

  const url = `/api/sessions/${encodeURIComponent(sid)}?token=${encodeURIComponent(TOKEN)}&owner=1`;
  const bad = await dialWs(url, { headers: { 'x-telepty-session-token': 'not-the-bearer' } });
  assert.equal(bad.kind, 'open', 'the DAEMON token is valid, so the upgrade itself must succeed');

  const closeCode = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 3000);
    bad.ws.on('close', (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(closeCode, 4003, '#815 owner-claim gate must still fire, after the transport gate');
});

test('11) /api/bus rides the same gate: no credential is refused, the token opens it', async () => {
  const refused = await dialWs('/api/bus');
  assert.notEqual(refused.kind, 'open', `the event bus must not be open to an uncredentialed socket, got ${JSON.stringify(refused)}`);

  const ok = await dialWs(`/api/bus?token=${encodeURIComponent(TOKEN)}`);
  assert.equal(ok.kind, 'open', `a credentialed bus subscriber must still connect, got ${JSON.stringify(ok)}`);
  ok.ws.close();
});

test('12) /api/health stays unauthenticated — daemon-control and connect-http depend on it', async () => {
  const res = await raw('/api/health');
  assert.equal(res.status, 200, '/api/health is registered before the auth middleware, deliberately');
  assert.equal(res.body.status, 'ok');
  assert.equal(typeof res.body.version, 'string', 'aterm detects the daemon version from this field');
});

test('13) #806 ordering unbroken: a disallowed Origin is 403 even with a valid token', async () => {
  const res = await raw('/api/sessions', {
    headers: { ...tokenHeader(), origin: 'https://evil.example' }
  });
  assert.equal(res.status, 403, 'the origin gate is absolute — credentials are checked after it');
  assert.equal(res.body.code, 'ORIGIN_NOT_ALLOWED');
});

// ── 14-16: the peer allowlist stops being a credential (#823). ──────────────────────────
//
// Unit-level on the middleware with a synthetic `req.ip`, in the style of http-auth.test.js —
// asserting the branch, not a second physical host.

function runMiddleware(middleware, reqOverrides = {}) {
  let nextCalled = false;
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  const req = { ip: '203.0.113.10', headers: {}, query: {}, ...reqOverrides };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    middleware(req, res, () => { nextCalled = true; });
  } finally {
    console.warn = originalWarn;
  }
  return { nextCalled, status: res.statusCode, body: res.body };
}

function middlewareWith(allowlist) {
  return createAuthMiddleware({
    isAllowedPeer: createIsAllowedPeer(allowlist),
    expectedToken: 'expected-token',
    verifyJwt: createVerifyJwt('jwt-secret'),
    allowedOrigins: []
  });
}

test('14) empty allowlist: a non-loopback caller with no credential is 401, not 200', async () => {
  const r = runMiddleware(middlewareWith([]), { ip: '203.0.113.10' });
  assert.equal(r.nextCalled, false, 'an empty allowlist means NO IP RESTRICTION, never "no authentication"');
  assert.equal(r.status, 401);
});

test('14b) allowlist MATCH is not a credential either — the tailnet default config', async () => {
  // This is the branch that was live on the default install: #672 auto-trust injects the tailnet
  // CIDR, so the list is NON-empty and MATCHES, and a matching isAllowedPeer returned `true` just
  // as completely as an empty one. Measured before this change: HTTP 200 with no token from any
  // tailnet device.
  const r = runMiddleware(middlewareWith(['100.64.0.0/10']), { ip: '100.72.155.21' });
  assert.equal(r.nextCalled, false, 'a matching allowlist entry must grant REACHABILITY, never authentication');
  assert.equal(r.status, 401);
});

test('14c) loopback is not a credential either — the same rule, the same branch', async () => {
  const r = runMiddleware(middlewareWith([]), { ip: '127.0.0.1' });
  assert.equal(r.nextCalled, false);
  assert.equal(r.status, 401);
});

test('15) the same non-loopback caller WITH the token passes', async () => {
  const r = runMiddleware(middlewareWith([]), {
    ip: '203.0.113.10',
    headers: { 'x-telepty-token': 'expected-token' }
  });
  assert.equal(r.nextCalled, true);
  assert.equal(r.status, null);
});

test('15b) an allowlisted tailnet peer WITH the token passes — reachability + credential', async () => {
  const r = runMiddleware(middlewareWith(['100.64.0.0/10']), {
    ip: '100.72.155.21',
    headers: { 'x-telepty-token': 'expected-token' }
  });
  assert.equal(r.nextCalled, true);
  assert.equal(r.status, null);
});

test('16) an address OUTSIDE a non-empty allowlist is 403 even with a valid token', async () => {
  // Reachability narrows and never widens: the policy answer comes first, and no credential can
  // buy past it. Before this change the peer check was a bypass, so a valid token reached the
  // route from anywhere.
  const r = runMiddleware(middlewareWith(['100.64.0.0/10']), {
    ip: '203.0.113.10',
    headers: { 'x-telepty-token': 'expected-token' }
  });
  assert.equal(r.nextCalled, false);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'PEER_NOT_ALLOWED');
});

test('16b) loopback is never narrowed away by a non-empty allowlist', async () => {
  // The local CLI must keep working on a daemon whose operator set TELEPTY_PEER_ALLOWLIST.
  const r = runMiddleware(middlewareWith(['100.64.0.0/10']), {
    ip: '127.0.0.1',
    headers: { 'x-telepty-token': 'expected-token' }
  });
  assert.equal(r.nextCalled, true);
  assert.equal(r.status, null);
});

test('16c) the origin guard still runs BEFORE the peer policy', async () => {
  const r = runMiddleware(middlewareWith(['100.64.0.0/10']), {
    ip: '203.0.113.10',
    headers: { origin: 'https://evil.example', 'x-telepty-token': 'expected-token' }
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'ORIGIN_NOT_ALLOWED', 'origin is checked first — #806 ordering');
});

test('isLoopbackAddress normalises the forms a socket actually reports', () => {
  for (const ip of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1']) {
    assert.equal(isLoopbackAddress(ip), true, `${ip} is loopback`);
  }
  for (const ip of ['100.72.155.21', '203.0.113.10', '::ffff:203.0.113.10', '', null, undefined, '128.0.0.1']) {
    assert.equal(isLoopbackAddress(ip), false, `${ip} is not loopback`);
  }
});

// ── 17: the upgrade refusal must be distinguishable from a dead daemon. ─────────────────

// A socket complete enough for `ws` to run a REAL handshake on. That completeness is the point:
// against the base commit the upgrade is accepted, `wss.handleUpgrade` runs, and this captures the
// `101 Switching Protocols` it writes — so the failure text names the defect ("it upgraded")
// instead of an incidental TypeError from a stub that was too thin to get that far.
class FakeUpgradeSocket extends EventEmitter {
  constructor(remoteAddress = '127.0.0.1') {
    super();
    this.written = [];
    this.destroyed = false;
    this.ended = false;
    this.readable = true;
    this.writable = true;
    this.remoteAddress = remoteAddress;
  }
  write(chunk) { this.written.push(String(chunk)); return true; }
  end(chunk) { if (chunk != null) this.written.push(String(chunk)); this.ended = true; }
  destroy() { this.destroyed = true; }
  setTimeout() { return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  cork() {}
  uncork() {}
  resume() { return this; }
  pause() { return this; }
  text() { return this.written.join(''); }
}

// A handshake the `ws` server will actually accept, so nothing short-circuits at 400.
const WS_HANDSHAKE_HEADERS = {
  host: 'x',
  upgrade: 'websocket',
  connection: 'Upgrade',
  'sec-websocket-key': Buffer.alloc(16, 7).toString('base64'),
  'sec-websocket-version': '13'
};

function upgradeHarness(allowlist) {
  const server = http.createServer(express());
  const { handleUpgrade } = installWebSocketTransport({
    server,
    sessions: {},
    busClients: new Set(),
    expectedToken: 'sekret',
    verifyJwt: () => false,
    isAllowedPeer: createIsAllowedPeer(allowlist),
    isForbiddenOrigin: createOriginGuard([]),
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
  });
  return { handleUpgrade, close: () => server.close() };
}

function refuseUpgradeWith({ allowlist = [], url = '/api/sessions/s1', remoteAddress = '127.0.0.1', headers = {} } = {}) {
  const h = upgradeHarness(allowlist);
  const socket = new FakeUpgradeSocket(remoteAddress);
  h.handleUpgrade({ method: 'GET', url, headers: { ...WS_HANDSHAKE_HEADERS, ...headers }, socket }, socket, Buffer.alloc(0));
  h.close();
  return socket.text();
}

test('17) a refused upgrade writes a COMPLETE http response, so a client can tell it from a dead port', () => {
  // The raw `HTTP/1.1 401\r\n\r\n` + immediate destroy() surfaced in `ws` as an error plus close
  // 1006 — byte-identical to what a client sees when the daemon is not running. A bridge then
  // reconnects forever in silence. A refusal must be readable AS a refusal.
  const response = refuseUpgradeWith({});
  assert.match(response, /^HTTP\/1\.1 401 Unauthorized\r\n/);
  assert.match(response, /\r\nConnection: close\r\n/i);
  assert.match(response, /\r\nContent-Length: \d+\r\n/i);
  assert.match(response, /\r\nX-Telepty-Refusal: PERMISSION_DENIED\r\n/i);
  const body = response.slice(response.indexOf('\r\n\r\n') + 4);
  assert.equal(JSON.parse(body).code, 'PERMISSION_DENIED');
});

test('17b) an out-of-allowlist upgrade is refused 403, with its own code', () => {
  const response = refuseUpgradeWith({
    allowlist: ['100.64.0.0/10'],
    remoteAddress: '203.0.113.10',
    url: '/api/sessions/s1?token=sekret'
  });
  assert.match(response, /^HTTP\/1\.1 403 Forbidden\r\n/);
  assert.match(response, /PEER_NOT_ALLOWED/);
});

test('17c) an uncredentialed /api/bus upgrade is refused too', () => {
  const response = refuseUpgradeWith({ url: '/api/bus' });
  assert.match(response, /^HTTP\/1\.1 401 Unauthorized\r\n/);
});
