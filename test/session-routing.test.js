'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  formatHostLabel,
  groupSessionsByHost,
  parseSessionReference,
  pickSessionTarget
} = require('../session-routing');

test('formatHostLabel returns Local for localhost and preserves remote hosts', () => {
  assert.equal(formatHostLabel('127.0.0.1'), 'Local');
  assert.equal(formatHostLabel('100.70.64.60'), '100.70.64.60');
});

test('parseSessionReference supports plain ids and id@host syntax', () => {
  assert.deepEqual(parseSessionReference('alpha'), { id: 'alpha', host: null });
  assert.deepEqual(parseSessionReference('alpha@100.70.64.60'), { id: 'alpha', host: '100.70.64.60' });
});

test('groupSessionsByHost groups discovered sessions by host', () => {
  const grouped = groupSessionsByHost([
    { id: 'one', host: '127.0.0.1' },
    { id: 'two', host: '100.1.1.1' },
    { id: 'three', host: '100.1.1.1' }
  ]);

  assert.equal(grouped.get('127.0.0.1').length, 1);
  assert.equal(grouped.get('100.1.1.1').length, 2);
});

test('pickSessionTarget resolves unique sessions across discovered hosts', () => {
  const sessions = [
    { id: 'local', host: '127.0.0.1' },
    { id: 'remote', host: '100.70.64.60' }
  ];

  assert.deepEqual(pickSessionTarget('remote', sessions), { id: 'remote', host: '100.70.64.60' });
  assert.deepEqual(pickSessionTarget('remote@100.70.64.60', sessions), { id: 'remote', host: '100.70.64.60' });
  assert.deepEqual(pickSessionTarget('remote', sessions, '100.70.64.60'), { id: 'remote', host: '100.70.64.60' });
  assert.equal(pickSessionTarget('missing', sessions), null);
});

test('pickSessionTarget rejects ambiguous ids found on multiple hosts', () => {
  const sessions = [
    { id: 'shared', host: '100.70.64.60' },
    { id: 'shared', host: '100.72.155.21' }
  ];

  assert.throws(() => pickSessionTarget('shared', sessions), /multiple hosts/i);
});

test('pickSessionTarget matches `<id>@<peerName>` against session.peerName alias (#411)', () => {
  // Discovered SSH-peer session: host is `user@FQDN`, peerName is the
  // friendly alias from peers.json.
  const sessions = [
    { id: 'orchestrator-winsvr', host: 'Administrator@win.tail.ts.net', peerName: 'winserver', remote: true }
  ];

  // `<id>@<peerName>` syntax must match the alias rather than falling through
  // to a synthetic {host: 'winserver'} target.
  const resolved = pickSessionTarget('orchestrator-winsvr@winserver', sessions);
  assert.equal(resolved.id, 'orchestrator-winsvr');
  assert.equal(resolved.peerName, 'winserver');
  assert.equal(resolved.host, 'Administrator@win.tail.ts.net');
  assert.equal(resolved.remote, true);
});

// telepty#1288 — target resolution when every machine runs a session with the same id.
//
// Every CLI case below drives the real `cli.js` against a real local daemon (PORT=0, temp HOME).
// Peers are in-test HTTP servers registered in that temp HOME's peers.json; each counts the
// requests it receives, so "no peer was consulted" is a counter reading zero, not a stopwatch.
// The harness sets TELEPTY_HOST=127.0.0.1 for every CLI run, so the bare-id cases are also the
// FACT B case (an explicitly loopback TELEPTY_HOST). Nothing touches a production daemon or the
// real ~/.telepty.

const { after } = require('node:test');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { startTestDaemon, createSessionId } = require('../test-support/daemon-harness');
const { discoverSessions } = require('../cli');

const PEER_TOKEN = 'tp1288-fake-peer-token';
const NO_ENV_TOKEN = { TELEPTY_AUTH_TOKEN: '' };

let daemon;
const servers = [];

// Started by the first test that needs it, so the pure tests above never wait on a daemon.
async function ensureDaemon() {
  if (!daemon) daemon = await startTestDaemon({ env: { TELEPTY_AUTH_TOKEN: '' } });
  return daemon;
}
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
  if (daemon) await daemon.stop();
});

function peersPath() {
  return path.join(daemon.homeDir, '.telepty', 'peers.json');
}

function writePeers(peers) {
  fs.mkdirSync(path.dirname(peersPath()), { recursive: true });
  fs.writeFileSync(peersPath(), JSON.stringify({ peers }, null, 2));
}

// A peer daemon stand-in: lists `ids`, answers `/api/sessions/<id>` and a multicast for them, counts
// every request and records its method, path, Host header and token. `host` is the literal address
// it listens on; a failed listen rejects.
// `alsoOn` also listens on that second literal address with the same port and the same records;
// each request records which of the two it arrived on (`at`: `v4` or `v6`). If that second listen
// fails, the first keeps serving and `alsoOnError` holds the error (R6-4: the caller skips, with that
// reason, the cases that need the second address).
async function fakePeer(ids, { refuse = false, host = '127.0.0.1', alsoOn = null } = {}) {
  const state = { hits: 0, requests: [] };
  const handle = (req, res) => {
    state.hits += 1;
    const pathname = new URL(req.url, 'http://fake-peer').pathname;
    state.requests.push({ method: req.method, path: pathname, host: req.headers.host, token: req.headers['x-telepty-token'],
      at: req.socket.localFamily === 'IPv6' ? 'v6' : 'v4' });
    res.setHeader('content-type', 'application/json');
    if (refuse) { res.statusCode = 401; res.end(JSON.stringify({ error: 'fake peer refuses' })); return; }
    if (req.method === 'POST' && pathname === '/api/sessions/multicast/inject') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const requested = JSON.parse(body || '{}').session_ids || [];
        state.multicast = requested;
        res.end(JSON.stringify({ results: { successful: requested.filter((id) => ids.includes(id)), failed: [] } }));
      });
      return;
    }
    if (pathname === '/api/sessions') {
      res.end(JSON.stringify(ids.map((id) => ({ id, command: 'fake-peer', cwd: '/', active_clients: 0 }))));
      return;
    }
    const match = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
    if (match && ids.includes(decodeURIComponent(match[1]))) {
      res.end(JSON.stringify({ id: decodeURIComponent(match[1]), command: 'fake-peer' }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not on the fake peer' }));
  };
  const listen = async (address, port) => {
    const server = http.createServer(handle);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, address, resolve); });
    servers.push({ close: () => new Promise((resolve) => server.close(() => resolve())) });
    return server.address().port;
  };
  state.port = await listen(host, 0);
  if (alsoOn) await listen(alsoOn, state.port).catch((error) => { state.alsoOnError = error; });
  return state;
}

function peerEntry(peer, extra = {}) {
  return {
    transport: 'http', host: '127.0.0.1', port: peer.port, target: `127.0.0.1:${peer.port}`,
    machineId: `tp1288-peer-${peer.port}`, token: PEER_TOKEN, ...extra
  };
}

async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// A transparent recorder in front of the real local daemon, on 127.0.0.1 only. A CLI run with
// TELEPTY_PORT set to its port uses it as the local daemon, so every local request is recorded
// (method, path, token, body). `failList` answers `GET /api/sessions` itself with a 500, a failed local
// read; everything else (the version probe, session reads, deliveries) reaches the real daemon.
async function localRecorder({ failList = false } = {}) {
  const state = { requests: [] };
  const server = http.createServer((req, res) => {
    const entry = { method: req.method, path: new URL(req.url, 'http://local-recorder').pathname,
      token: req.headers['x-telepty-token'], body: '' };
    state.requests.push(entry);
    req.on('data', (chunk) => { entry.body += chunk; });
    if (failList && req.method === 'GET' && entry.path === '/api/sessions') {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'recorder list failure' }));
      return;
    }
    const upstream = http.request({ host: '127.0.0.1', port: daemon.port, method: req.method, path: req.url,
      headers: { ...req.headers, connection: 'close' }, agent: false }, (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.statusCode = 502; res.end(); });
    req.pipe(upstream);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = server.address().port;
  servers.push({ close: () => new Promise((resolve) => server.close(() => resolve())) });
  // The session routes only: the version probe before them is 0.11.3's ensureDaemonRunning.
  state.sessionRequests = () => state.requests.filter(({ path: p }) => p.startsWith('/api/sessions'))
    .map(({ method, path: p }) => `${method} ${p}`);
  return state;
}

async function cli(args, env = {}) {
  return daemon.runCli(args, { timeoutMs: 30000, env: { ...NO_ENV_TOKEN, ...env } });
}

async function registerLocal(prefix) {
  const sid = createSessionId(prefix);
  const reg = await daemon.registerSession(sid);
  assert.equal(reg.status, 201, `register failed: ${JSON.stringify(reg.body)}`);
  return sid;
}

test('#1288 D1/FACT A+B: session info on an exact local id asks only the local daemon, with its own credential', async () => {
  await ensureDaemon();
  const sid = await registerLocal('tp1288-d1-shared');
  // A registered peer that runs the same id (FACT A), and, separately, one that does not.
  const competing = await fakePeer([sid]);
  const other = await fakePeer([createSessionId('tp1288-d1-other')]);

  // R4-5: TELEPTY_HOST unset (`undefined` drops it from the CLI's environment) and exactly
  // 127.0.0.1 (FACT B). The recorder shows the local requests: the one 0.11.3 list read, then the
  // session read, and nothing else.
  for (const [peerLabel, peer] of [['same id on the peer', competing], ['id not on the peer', other]]) {
    writePeers({ 'peer-a': peerEntry(peer) });
    for (const hostSetting of [undefined, '127.0.0.1']) {
      const label = `${peerLabel}, TELEPTY_HOST=${hostSetting === undefined ? '(unset)' : hostSetting}`;
      const local = await localRecorder();
      const env = { TELEPTY_HOST: hostSetting, TELEPTY_PORT: String(local.port) };

      const info = await cli(['session', 'info', sid, '--json'], env);
      assert.equal(info.code, 0, `${label}: ${info.stderr}`);
      const doc = JSON.parse(info.stdout);
      assert.equal(doc.host, '127.0.0.1');
      assert.equal(doc.id, sid);
      assert.equal(peer.hits, 0, `${label}: a peer was consulted for an id the local daemon has`);

      const text = await cli(['session', 'info', sid], env);
      assert.equal(text.code, 0, text.stderr);
      assert.doesNotMatch(text.stderr, /multiple hosts/);
      // V4: the text block is the local session's, and nothing else is printed.
      assert.equal(text.stderr, '');
      assert.ok(text.stdout.startsWith(`\x1b[1mSession Info:\x1b[0m\n  - ID: \x1b[36m${sid}\x1b[0m\n    Host: Local\n`), text.stdout);
      assert.equal(peer.hits, 0);

      assert.deepEqual(local.sessionRequests(), ['GET /api/sessions', `GET /api/sessions/${sid}`,
        'GET /api/sessions', `GET /api/sessions/${sid}`], label);
      // Each session request carries the one credential the local daemon accepted, never a peer's.
      const tokens = new Set(local.requests.filter(({ path: p }) => p.startsWith('/api/sessions')).map(({ token }) => token));
      assert.equal(tokens.size, 1, `${label}: the local requests carried different credentials`);
      assert.ok(!tokens.has(PEER_TOKEN) && !tokens.has(undefined), label);
    }
  }
  // R6: `127.0.0.1:<port>` is not exactly `127.0.0.1`, so the 0.11.3 refusal stands (r5 resolved it locally).
  writePeers({ 'peer-a': peerEntry(competing) });
  const ported = await cli(['session', 'info', sid], { TELEPTY_HOST: `127.0.0.1:${daemon.port}`, TELEPTY_PORT: undefined });
  assert.deepEqual({ code: ported.code, stdout: ported.stdout, stderr: ported.stderr }, { code: 0, stdout: '',
    stderr: `❌ Session '${sid}' exists on multiple hosts: 127.0.0.1, 127.0.0.1:${competing.port}. Use <session_id>@<host> or set TELEPTY_HOST.\n` });
});

test('#1288 D1: a bare id absent locally still reaches the single peer that has it', async () => {
  await ensureDaemon();
  const rid = createSessionId('tp1288-d1-remote-only');
  const peer = await fakePeer([rid]);
  writePeers({ 'peer-a': peerEntry(peer) });

  const info = await cli(['session', 'info', rid, '--json']);
  assert.equal(info.code, 0, info.stderr);
  assert.equal(JSON.parse(info.stdout).host, `127.0.0.1:${peer.port}`);
  assert.ok(peer.hits > 0);
  // V4: an absent id takes the 0.11.3 path, so the peer sees the 0.11.3 sequence: the discovery
  // list, then the session read (info) or the delivery (multicast).
  const multicast = await cli(['multicast', rid, 'tp1288 absent probe']);
  assert.deepEqual({ code: multicast.code, stdout: multicast.stdout, stderr: multicast.stderr },
    { code: 0, stdout: '✅ Context multicasted successfully to 1 session(s).\n', stderr: '' });
  assert.deepEqual(peer.requests.map(({ method, path: requestPath }) => `${method} ${requestPath}`),
    ['GET /api/sessions', `GET /api/sessions/${rid}`, 'GET /api/sessions', 'POST /api/sessions/multicast/inject']);
});

test('#1288 D1/V4: an id absent everywhere keeps the 0.11.3 fan-out and not-found output', async () => {
  await ensureDaemon();
  const missing = createSessionId('tp1288-d1-absent');
  const peer = await fakePeer([]);
  writePeers({ 'peer-a': peerEntry(peer) });
  const notFound = `❌ Session '${missing}' was not found on any discovered host.\n`;

  const info = await cli(['session', 'info', missing, '--json']);
  assert.deepEqual({ code: info.code, stdout: info.stdout, stderr: info.stderr }, { code: 1, stdout: '', stderr: notFound });
  const multicast = await cli(['multicast', missing, 'hello']);
  assert.deepEqual({ code: multicast.code, stdout: multicast.stdout, stderr: multicast.stderr }, { code: 0, stdout: '', stderr: notFound });
  assert.deepEqual(peer.requests.map(({ method, path: requestPath }) => `${method} ${requestPath}`),
    ['GET /api/sessions', 'GET /api/sessions'], 'each command fans out exactly once, as in 0.11.3');
});

test('#1288 D3: cross-host ambiguity is a JSON refusal under --json, and unchanged text otherwise', async () => {
  await ensureDaemon();
  const did = createSessionId('tp1288-d3-dup');
  const peerA = await fakePeer([did]);
  const peerB = await fakePeer([did]);
  writePeers({ 'peer-a': peerEntry(peerA), 'peer-b': peerEntry(peerB) });

  for (const args of [['session', 'info', did, '--json'], ['read-screen', did, '--json']]) {
    const result = await cli(args);
    assert.equal(result.code, 1, `${args[0]}: a refusal did not exit 1 under --json`);
    const doc = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(doc), ['success', 'code', 'error']);
    assert.equal(doc.success, false);
    assert.equal(doc.code, 'AMBIGUOUS_SESSION');
    assert.match(doc.error, new RegExp(`Session '${did}' exists on multiple hosts`));
    assert.equal(result.stderr, `❌ ${doc.error}\n`, 'the human diagnostic stays on stderr');
  }

  // Text mode keeps its 0.11.3 bytes and exit code (session info never set a failure status here).
  const text = await cli(['session', 'info', did]);
  assert.equal(text.stdout, '');
  const hosts = [`127.0.0.1:${peerA.port}`, `127.0.0.1:${peerB.port}`].sort().join(', ');
  assert.equal(text.stderr, `❌ Session '${did}' exists on multiple hosts: ${hosts}. Use <session_id>@<host> or set TELEPTY_HOST.\n`);
  assert.equal(text.code, 0);
});

test('#1288 D3: an unregistered peer qualifier is a JSON refusal under --json, text unchanged', async () => {
  await ensureDaemon();
  const sid = await registerLocal('tp1288-d3-unreg');
  const peer = await fakePeer([]);
  writePeers({ 'peer-a': peerEntry(peer, { machineId: 'tp1288-peer-a' }) });
  const host = 'tp1288-unregistered.invalid';
  const message = `No peer registered with machine id or address '${host}'; known: tp1288-peer-a. `
    + 'Use telepty connect-http or telepty connect to register it.';

  for (const args of [['session', 'info', `${sid}@${host}`, '--json'], ['read-screen', `${sid}@${host}`, '--json']]) {
    const result = await cli(args);
    assert.equal(result.code, 1, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { success: false, code: 'PEER_NOT_REGISTERED', error: message });
    assert.equal(result.stderr, `❌ ${message}\n`);
  }
  const text = await cli(['session', 'info', `${sid}@${host}`]);
  assert.equal(text.code, 1);
  assert.equal(text.stdout, '');
  assert.equal(text.stderr, `❌ ${message}\n`);
});

test('#1288 R1/R8: an explicit host token goes to the typed address; a registered peer gets its stored token', async () => {
  await ensureDaemon();
  const rid = createSessionId('tp1288-token');
  const peer = await fakePeer([rid]);
  const ENV_TOKEN = 'tp1288-env-token';
  // V4: a competing registration (restored). Another peer, registered under its own literal address,
  // lists the same id. Nothing here depends on how a host name resolves (S7).
  const twin = await fakePeer([rid]);
  writePeers({ 'peer-twin': peerEntry(twin, { machineId: 'tp1288-peer-twin' }) });
  const typed = `127.0.0.1:${peer.port}`;

  // TELEPTY_AUTH_TOKEN set: 0.11.3 dials the typed address directly with that token. The request for
  // the session must carry the typed authority and must not go to the competing registration.
  // TELEPTY_HOST is non-local and the CLI port closed (as in F3 below), so the local daemon, which does
  // not share ENV_TOKEN, is neither auto-started nor asked.
  const direct = await cli(['session', 'info', `${rid}@${typed}`, '--json'],
    { TELEPTY_HOST: '0.0.0.0', TELEPTY_PORT: String(await closedPort()), TELEPTY_AUTH_TOKEN: ENV_TOKEN });
  assert.equal(JSON.parse(direct.stdout).host, typed, direct.stderr);
  const sessionRequests = () => peer.requests.filter((request) => request.path === `/api/sessions/${rid}`);
  assert.deepEqual(sessionRequests().map(({ host, token }) => ({ host, token })), [{ host: typed, token: ENV_TOKEN }]);
  assert.deepEqual(twin.requests.filter((request) => request.path === `/api/sessions/${rid}`), [],
    'the session read went to the competing registration');

  // No env token, the peer's registered name: its registered endpoint with its stored token.
  writePeers({ 'peer-a': peerEntry(peer, { machineId: 'tp1288-peer-a' }) });
  peer.requests.length = 0;
  const registered = await cli(['session', 'info', `${rid}@peer-a`, '--json']);
  assert.equal(registered.code, 0, registered.stderr);
  assert.equal(JSON.parse(registered.stdout).host, typed);
  assert.deepEqual(sessionRequests().map(({ host, token }) => ({ host, token })), [{ host: typed, token: PEER_TOKEN }]);
});

test('#1288 R4-1/R4-2: with TELEPTY_HOST=localhost, ::1 or [::1] both commands keep the 0.11.3 path and add no request', async (t) => {
  await ensureDaemon();
  const sid = createSessionId('tp1288-alt-loopback');
  const sid2 = createSessionId('tp1288-alt-loopback-b');
  const rid = createSessionId('tp1288-alt-loopback-remote');
  const peer = await fakePeer([sid, rid]);
  writePeers({ 'peer-a': peerEntry(peer, { machineId: 'tp1288-peer-a' }) });
  // A local stand-in on 127.0.0.1 AND ::1 (one port, one record), so the result does not depend on
  // the family `localhost` resolves to. 0.11.3 reads the list from 127.0.0.1 only, so a request that
  // arrives on ::1 before the operation is one 0.11.3 never sends (r4's probe).
  // R6-4: `localhost` always runs. Every case that needs ::1 is its own subtest, and on a runner
  // where ::1 cannot be bound each of them is skipped with that reason in TAP (not failed, not passed).
  const local = await fakePeer([sid, sid2], { alsoOn: '::1' });
  const noV6 = local.alsoOnError
    ? `::1 cannot be bound on this runner (${local.alsoOnError.code || local.alsoOnError.message})` : false;
  const seen = (requests) => requests.map(({ method, path: requestPath }) => `${method} ${requestPath}`);
  const onV6 = () => seen(local.requests.filter(({ at }) => at === 'v6'));
  const reset = () => { peer.requests.length = 0; local.requests.length = 0; };

  for (const setting of ['localhost', '::1', '[::1]']) {
    await t.test(`TELEPTY_HOST=${setting}`, { skip: setting === 'localhost' ? false : noV6 }, async () => {
      reset();
      const env = { TELEPTY_HOST: setting, TELEPTY_PORT: String(local.port) };
      // 0.11.3: discovery reads 127.0.0.1 and lists the peer (which has the same id); a bare id
      // resolves to the configured host, without an ambiguity refusal.
      const info = await cli(['session', 'info', sid, '--json'], env);
      assert.deepEqual({ code: info.code, stderr: info.stderr }, { code: 0, stderr: '' }, setting);
      assert.deepEqual(JSON.parse(info.stdout), { host: setting === 'localhost' ? 'localhost' : '::1', id: sid, command: 'fake-peer' }, setting);
      const multicast = await cli(['multicast', sid, 'tp1288 alternate loopback'], env);
      assert.deepEqual({ code: multicast.code, stdout: multicast.stdout, stderr: multicast.stderr },
        { code: 0, stdout: '✅ Context multicasted successfully to 1 session(s).\n', stderr: '' }, setting);
      // One peer listing per command, as in 0.11.3 (r4 asked no peer: its probe hit).
      assert.deepEqual(seen(peer.requests), ['GET /api/sessions', 'GET /api/sessions'], `${setting}: peer requests`);
      assert.deepEqual(seen(local.requests), ['GET /api/sessions', `GET /api/sessions/${sid}`, 'GET /api/sessions',
        'POST /api/sessions/multicast/inject'], `${setting}: local requests`);
      if (setting !== 'localhost') {
        assert.deepEqual(onV6(), [`GET /api/sessions/${sid}`, 'POST /api/sessions/multicast/inject'], `${setting}: requests to ::1`);
      }
    });
  }

  // R4-1: TELEPTY_HOST=[::1]:<port>, a qualified id of a registered HTTP peer, no env token. 0.11.3
  // reaches the peer with its stored token and sends nothing to ::1; r4 first sent ::1 a list probe
  // carrying the local daemon token.
  reset();
  const qualified = await cli(['session', 'info', `${rid}@peer-a`, '--json'], { TELEPTY_HOST: `[::1]:${local.port}`, TELEPTY_PORT: undefined });
  assert.equal(qualified.code, 0, qualified.stderr);
  assert.equal(JSON.parse(qualified.stdout).host, `127.0.0.1:${peer.port}`);
  assert.deepEqual(peer.requests.filter(({ path: requestPath }) => requestPath === `/api/sessions/${rid}`).map(({ token }) => token), [PEER_TOKEN]);
  assert.deepEqual(onV6(), [], 'a qualified peer read sent a request to the configured address');

  // R4-2: TELEPTY_HOST=::1, a bare id with a second id qualified @[::1], then an empty list. 0.11.3's
  // first connection to ::1 is the delivery itself, after discovery; r4 opened one before discovery.
  // It continues R4-1's records (no reset); it delivers to ::1, so it is skipped without ::1.
  await t.test('R4-2: TELEPTY_HOST=::1, mixed and empty multicast lists', { skip: noV6 }, async () => {
    const env = { TELEPTY_HOST: '::1', TELEPTY_PORT: String(local.port) };
    const mixed = await cli(['multicast', `${sid},${sid2}@[::1]`, 'tp1288 mixed loopback'], env);
    assert.deepEqual({ code: mixed.code, stdout: mixed.stdout, stderr: mixed.stderr },
      { code: 0, stdout: '✅ Context multicasted successfully to 2 session(s).\n', stderr: '' });
    const empty = await cli(['multicast', ',', 'tp1288 empty loopback'], env);
    assert.deepEqual({ code: empty.code, stdout: empty.stdout, stderr: empty.stderr },
      { code: 0, stdout: '✅ Context multicasted successfully to 0 session(s).\n', stderr: '' });
    assert.deepEqual(onV6(), ['POST /api/sessions/multicast/inject', 'POST /api/sessions/multicast/inject'],
      'the configured address received a request other than the deliveries');
    assert.deepEqual(seen(peer.requests), ['GET /api/sessions', `GET /api/sessions/${rid}`, 'GET /api/sessions', 'GET /api/sessions']);
  });
});

// V2 with TELEPTY_HOST unset or 127.0.0.1: the D1 check reads discovery's own local read, so a
// failure of that read is classified by the 0.11.3 code and the check never runs. In-process, with
// the exported seams (no daemon is started or stopped).
test('#1288 V2: on 127.0.0.1 the D1 check never sees a failed local read and never adds one', async () => {
  const answer = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fails = {
    timeout: async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); },
    http500: answer(500, { error: 'boom' })
  };
  for (const [name, fetchFail] of Object.entries(fails)) {
    const base = await discoverSessions({ silent: true, _ensureDaemonRunning: async () => {}, _fetchWithAuth: fetchFail })
      .then(() => null, (error) => error.message);
    let reads = 0;
    let checks = 0;
    const withCheck = await discoverSessions({ silent: true, _ensureDaemonRunning: async () => {},
      _fetchWithAuth: (...args) => { reads += 1; return fetchFail(...args); }, exactLocal: () => { checks += 1; return true; } })
      .then(() => null, (error) => error.message);
    assert.ok(base, `${name}: the 0.11.3 read did not fail`);
    assert.equal(withCheck, base, `${name}: the failure changed`);
    assert.deepEqual({ reads, checks }, { reads: 1, checks: 0 }, name);
  }

  // A hit ends discovery on that one read; the check receives the local list, tagged as 0.11.3 tags it.
  let reads = 0;
  let given;
  const hit = await discoverSessions({ silent: true, _ensureDaemonRunning: async () => {},
    _fetchWithAuth: async () => { reads += 1; return answer(200, [{ id: 'tp1288-seam' }])(); },
    exactLocal: (list) => { given = list; return true; } });
  assert.deepEqual(given, [{ host: '127.0.0.1', id: 'tp1288-seam' }]);
  assert.deepEqual(hit, [{ host: '127.0.0.1', id: 'tp1288-seam' }]);
  assert.equal(reads, 1);

  // R4-5: a refused connection is 0.11.3's empty local list, so the check sees [] and no reference
  // can hit. (The check returns true here only to stop before this process's own peers.)
  let refusedList;
  await discoverSessions({ silent: true, _ensureDaemonRunning: async () => {},
    _fetchWithAuth: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); },
    exactLocal: (list) => { refusedList = list; return true; } });
  assert.deepEqual(refusedList, []);
});

// R4-5 through the real CLI: with TELEPTY_HOST unset or 127.0.0.1, a local list read that fails
// (HTTP 500) is classified by the 0.11.3 code: the command fails with its message and exit 1, and no
// peer is asked. A refused connection cannot be driven through the CLI here without the 0.11.3
// auto-start starting a daemon; the in-process test above covers it, with the timeout and the 500.
test('#1288 R4-5: on 127.0.0.1 a failed local read fails both commands as in 0.11.3 and asks no peer', async () => {
  await ensureDaemon();
  const sid = await registerLocal('tp1288-read-fails');
  const peer = await fakePeer([sid]);
  writePeers({ 'peer-a': peerEntry(peer) });
  const local = await localRecorder({ failList: true });
  const expected = { code: 1, stdout: '',
    stderr: `❌ Local telepty daemon (port ${local.port}) answered /api/sessions with HTTP 500 — running, but not serving. This is not an empty result.\n` };

  for (const hostSetting of [undefined, '127.0.0.1']) {
    const env = { TELEPTY_HOST: hostSetting, TELEPTY_PORT: String(local.port) };
    for (const args of [['session', 'info', sid, '--json'], ['session', 'info', sid], ['multicast', sid, 'tp1288 failed read']]) {
      const result = await cli(args, env);
      assert.deepEqual({ code: result.code, stdout: result.stdout, stderr: result.stderr }, expected,
        `TELEPTY_HOST=${hostSetting === undefined ? '(unset)' : hostSetting} ${args.join(' ')}`);
    }
  }
  assert.deepEqual(local.sessionRequests(), Array(6).fill('GET /api/sessions'), 'one local read per command, never retried');
  assert.equal(peer.hits, 0, 'a peer was asked after a failed local read');
});

test('#1288 V1: <id>@<this machine hostname> behaves as in 0.11.3 and never selects a peer', async (t) => {
  const own = os.hostname();
  if (!own || own === 'localhost' || own.includes('@')) { t.skip(`host name '${own}' is not a plain non-loopback name`); return; }
  await ensureDaemon();
  // The review's V1 fixture: the id is not on the local daemon, and a peer registered under the alias
  // `127.0.0.1` has it. 0.11.3 refuses the qualifier; r3 rewrote it to `<id>@127.0.0.1`, which
  // matched that peer's alias and read (or delivered to) the remote session.
  const rid = createSessionId('tp1288-v1-own-name');
  const peer = await fakePeer([rid]);
  writePeers({ '127.0.0.1': peerEntry(peer, { machineId: 'tp1288-v1-peer' }) });
  const message = `No peer registered with machine id or address '${own}'; known: tp1288-v1-peer. `
    + 'Use telepty connect-http or telepty connect to register it.';
  const ref = `${rid}@${own}`;
  const seen = () => peer.requests.map(({ method, path: requestPath }) => `${method} ${requestPath}`);

  // read-screen refuses before any request (0.11.3); session info lists peers first, then refuses.
  for (const json of [true, false]) {
    const screen = await cli(['read-screen', ref, ...(json ? ['--json'] : [])]);
    assert.deepEqual({ code: screen.code, stdout: screen.stdout, stderr: screen.stderr }, { code: 1,
      stdout: json ? `${JSON.stringify({ success: false, code: 'PEER_NOT_REGISTERED', error: message })}\n` : '',
      stderr: `❌ ${message}\n` });
  }
  assert.deepEqual(seen(), [], 'read-screen asked a peer for an own-name qualifier');

  const info = await cli(['session', 'info', ref]);
  assert.deepEqual({ code: info.code, stdout: info.stdout, stderr: info.stderr }, { code: 1, stdout: '', stderr: `❌ ${message}\n` });
  assert.deepEqual(seen(), ['GET /api/sessions'], 'session info did more than its 0.11.3 discovery');
});

test('#1288 R5: an ambiguous peer identity is a JSON refusal under --json, text unchanged', async () => {
  await ensureDaemon();
  const peer = await fakePeer([]);
  writePeers({ 'peer-a': peerEntry(peer, { machineId: 'tp1288-twin' }), 'peer-b': peerEntry(peer, { machineId: 'tp1288-twin' }) });
  const ref = 'tp1288-any@tp1288-twin';
  const message = "Peer 'tp1288-twin' is ambiguous: peer-a, peer-b. Use a registered address:port.";

  for (const args of [['session', 'info', ref, '--json'], ['read-screen', ref, '--json']]) {
    const result = await cli(args);
    assert.equal(result.code, 1, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { success: false, code: 'AMBIGUOUS_PEER', error: message });
    assert.equal(result.stderr, `❌ ${message}\n`);
  }
  const text = await cli(['session', 'info', ref]);
  assert.deepEqual({ code: text.code, stdout: text.stdout, stderr: text.stderr }, { code: 1, stdout: '', stderr: `❌ ${message}\n` });
});

test('#1288 5a/5b: for session info and multicast a local prefix keeps the 0.11.3 path, so a peer exact id still wins', async () => {
  await ensureDaemon();
  const base = createSessionId('tp1288-pfx');
  const reg = await daemon.registerSession(`${base}-001`);
  assert.equal(reg.status, 201, `register failed: ${JSON.stringify(reg.body)}`);
  const peer = await fakePeer([base]);
  writePeers({ 'peer-a': peerEntry(peer) });

  const info = await cli(['session', 'info', base, '--json']);
  assert.equal(info.code, 0, info.stderr);
  const doc = JSON.parse(info.stdout);
  assert.equal(doc.id, base);
  assert.equal(doc.host, `127.0.0.1:${peer.port}`);

  const multicast = await cli(['multicast', base, 'tp1288 prefix probe']);
  assert.equal(multicast.code, 0, multicast.stderr);
  assert.equal(multicast.stdout, '✅ Context multicasted successfully to 1 session(s).\n');
  assert.deepEqual(peer.multicast, [base], 'multicast did not deliver to the peer exact id');
  // V4: the peer saw exactly the 0.11.3 sequence (one discovery per command, then the operation).
  assert.deepEqual(peer.requests.map(({ method, path: requestPath }) => `${method} ${requestPath}`),
    ['GET /api/sessions', `GET /api/sessions/${base}`, 'GET /api/sessions', 'POST /api/sessions/multicast/inject']);
});

// R5-1: multicast is 0.11.3's. An id the local daemon and a peer both run is refused, alone or beside a
// peer-only id; nothing is delivered and the peer gets only its list read. Fails on r5 (it delivered).
test('#1288 R5-1: multicast keeps the 0.11.3 refusal for an id a peer also runs and delivers nothing', async () => {
  await ensureDaemon();
  const sid = await registerLocal('tp1288-r5-1-shared');
  const rid = createSessionId('tp1288-r5-1-remote');
  const peer = await fakePeer([sid, rid]);
  writePeers({ 'peer-a': peerEntry(peer) });
  const refusal = `❌ Session '${sid}' exists on multiple hosts: 127.0.0.1, 127.0.0.1:${peer.port}. `
    + 'Use <session_id>@<host> or set TELEPTY_HOST.\n';

  for (const hostSetting of [undefined, '127.0.0.1']) {
    const local = await localRecorder();
    const env = { TELEPTY_HOST: hostSetting, TELEPTY_PORT: String(local.port) };
    for (const list of [sid, `${sid},${rid}`]) {
      const label = `TELEPTY_HOST=${hostSetting === undefined ? '(unset)' : hostSetting} multicast ${list}`;
      peer.requests.length = 0;
      const result = await cli(['multicast', list, 'tp1288 r5-1 probe'], env);
      assert.deepEqual({ code: result.code, stdout: result.stdout, stderr: result.stderr }, { code: 0, stdout: '', stderr: refusal }, label);
      assert.deepEqual(peer.requests.map(({ method, path: p, token }) => `${method} ${p} ${token}`),
        [`GET /api/sessions ${PEER_TOKEN}`], `${label}: the peer received more than its 0.11.3 list read`);
    }
    assert.deepEqual(local.sessionRequests(), ['GET /api/sessions', 'GET /api/sessions'], 'the local daemon received a delivery');
  }
});

// R5-4 compatibility fixture (0.11.3 path): registered-peer precedence sends `<id>@localhost` to the peer
// registered under the alias `localhost` although the local daemon has the id. R6-5: the peer is the in-test
// HTTP stand-in the neighbouring tests use, so no system `ssh` runs and the result does not depend on the
// runner's SSH setup; an SSH registration of the same alias is checked on the resolver itself.
test('#1288 R5-4: <id>@localhost goes to a registered peer named localhost, as in 0.11.3', async () => {
  await ensureDaemon();
  const sid = await registerLocal('tp1288-alias-localhost');
  const { resolveRegisteredPeerTarget } = require('../session-routing');
  const target = 'tp1288@tp1288-ssh-alias.invalid';
  assert.deepEqual(resolveRegisteredPeerTarget(`${sid}@localhost`, { localhost: { transport: 'ssh', target, machineId: 'tp1288-ssh-local' } }),
    { id: sid, host: target, peerName: 'localhost', remote: true });

  const alias = await fakePeer([sid]);
  writePeers({ localhost: peerEntry(alias, { machineId: 'tp1288-alias-local' }) });
  const local = await localRecorder();
  const env = { TELEPTY_PORT: String(local.port) };
  const seen = () => alias.requests.map(({ method, path: requestPath, token }) => `${method} ${requestPath} ${token}`);

  // session info lists every host, then reads the session at the registered peer with its stored token.
  const info = await cli(['session', 'info', `${sid}@localhost`, '--json'], env);
  assert.deepEqual({ code: info.code, stdout: info.stdout, stderr: info.stderr }, { code: 0,
    stdout: `${JSON.stringify({ host: `127.0.0.1:${alias.port}`, id: sid, command: 'fake-peer' }, null, 2)}\n`, stderr: '' });
  assert.deepEqual(seen(), [`GET /api/sessions ${PEER_TOKEN}`, `GET /api/sessions/${sid} ${PEER_TOKEN}`]);
  // read-screen resolves the registered peer without listing; the stand-in has no screen route (404).
  alias.requests.length = 0;
  const screen = await cli(['read-screen', `${sid}@localhost`], env);
  assert.deepEqual({ code: screen.code, stdout: screen.stdout, stderr: screen.stderr }, { code: 1, stdout: '', stderr: '❌ not on the fake peer\n' });
  assert.deepEqual(seen(), [`GET /api/sessions/${sid}/screen ${PEER_TOKEN}`]);
  assert.deepEqual(local.sessionRequests(), ['GET /api/sessions'], 'the local session was read for <id>@localhost');
});

test('#1288 S4: a multicast list with no ids keeps the 0.11.3 fan-out, warning and exit status', async () => {
  await ensureDaemon();
  const refusing = await fakePeer([], { refuse: true });
  writePeers({ refusing: peerEntry(refusing) });

  const result = await cli(['multicast', ',', 'tp1288 empty list']);
  assert.equal(result.stdout, '✅ Context multicasted successfully to 0 session(s).\n');
  assert.match(result.stderr, /INCOMPLETE/);
  assert.equal(result.code, 1, 'the incomplete fan-out no longer fails the command');
  assert.equal(refusing.hits, 1);
});

test('#1288 F1: list --json keeps printing the session array when a peer refuses; the warning is stderr only', async () => {
  await ensureDaemon();
  const sid = await registerLocal('tp1288-f1-list');
  const refusing = await fakePeer([], { refuse: true });
  writePeers({ refusing: peerEntry(refusing) });

  const list = await cli(['list', '--json']);
  const sessions = JSON.parse(list.stdout);
  assert.ok(Array.isArray(sessions), `list --json printed a non-array: ${list.stdout}`);
  assert.ok(sessions.some((session) => session.id === sid && session.host === '127.0.0.1'));
  assert.match(list.stderr, /INCOMPLETE/);
  assert.equal(list.code, 1, 'an incomplete list still exits non-zero (#835)');

  // The consumer of FACT A: probing its own local session is not affected by the refusing peer.
  const info = await cli(['session', 'info', sid, '--json']);
  assert.equal(info.code, 0, info.stderr);
  assert.equal(JSON.parse(info.stdout).id, sid);
});

test('#1288 F2: readiness and wait-ready keep the documented daemon statuses', async () => {
  await ensureDaemon();
  writePeers({});
  const missing = createSessionId('tp1288-f2-missing');
  for (const verb of ['readiness', 'wait-ready']) {
    const result = await cli([verb, missing, '--json', '--timeout-ms', '0']);
    assert.equal(result.code, 1);
    const doc = JSON.parse(result.stdout);
    assert.equal(doc.status, 'not_found', `${verb} replaced the daemon status: ${result.stdout}`);
    assert.equal(doc.reason, 'exact_session_not_found');
    assert.equal(doc.ready, false);
  }
});

test('#1288 F3: an unrelated peer whose host name does not resolve never blocks a direct target', async () => {
  await ensureDaemon();
  const port = await closedPort();
  writePeers({ 'old-box': { transport: 'http', host: 'tp1288-old-box.invalid', port, target: `tp1288-old-box.invalid:${port}`, machineId: 'old-box' } });
  const env = { TELEPTY_HOST: '0.0.0.0', TELEPTY_PORT: String(port), TELEPTY_AUTH_TOKEN: 'not-the-point' };

  for (const ref of ['no-such-session', `no-such-session@0.0.0.0:${port}`]) {
    const result = await cli(['inject', ref, 'hello'], env);
    assert.match(result.stderr, new RegExp(`0\\.0\\.0\\.0:${port}`),
      `${ref}: the direct target was not attempted: ${JSON.stringify(result.stderr)}`);
    assert.doesNotMatch(result.stderr, /No peer registered|ambiguous|Could not match/);
    assert.notEqual(result.code, 0);
  }
});

test('#1288 golden: with no registered peers the resolving commands print what 0.11.3 printed', async () => {
  await ensureDaemon();
  fs.rmSync(peersPath(), { force: true });
  const sid = await registerLocal('tp1288-golden');
  const missing = createSessionId('tp1288-golden-missing');
  const notFound = `❌ Session '${missing}' was not found on any discovered host.\n`;
  const unregistered = "❌ No peer registered with machine id or address 'tp1288-nowhere.invalid'; known: (none). "
    + 'Use telepty connect-http or telepty connect to register it.\n';
  const cases = [
    [['session', 'info', missing], { code: 1, stdout: '', stderr: notFound }],
    [['session', 'info', missing, '--json'], { code: 1, stdout: '', stderr: notFound }],
    [['session', 'info', `${sid}@tp1288-nowhere.invalid`], { code: 1, stdout: '', stderr: unregistered }],
    [['read-screen', missing], { code: 1, stdout: '', stderr: notFound }],
    [['read-screen', missing, '--json'], { code: 1, stdout: '', stderr: notFound }],
    [['read-screen', `${sid}@tp1288-nowhere.invalid`], { code: 1, stdout: '', stderr: unregistered }],
    [['multicast', missing, 'hello'], { code: 0, stdout: '', stderr: notFound }]
  ];
  for (const [args, expected] of cases) {
    const result = await cli(args);
    assert.deepEqual({ code: result.code, stdout: result.stdout, stderr: result.stderr }, expected, args.join(' '));
  }

  const info = await cli(['session', 'info', sid, '--json']);
  assert.equal(info.code, 0, info.stderr);
  assert.equal(info.stderr, '');
  const doc = JSON.parse(info.stdout);
  assert.equal(info.stdout, `${JSON.stringify(doc, null, 2)}\n`);
  assert.equal(Object.keys(doc)[0], 'host');
  assert.equal(doc.host, '127.0.0.1');
  assert.equal(doc.id, sid);

  const list = await cli(['list', '--json']);
  assert.equal(list.code, 0, list.stderr);
  assert.equal(list.stderr, '');
  assert.ok(JSON.parse(list.stdout).some((session) => session.id === sid));
});
