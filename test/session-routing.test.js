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
const { isLocalMachineName, registeredPeerUsesName } = require('../session-routing');
const { createPeerContext } = require('../cross-machine');

const LOCAL_MACHINE = 'tp1288-local-machine';
const PEER_TOKEN = 'tp1288-fake-peer-token';
const NO_ENV_TOKEN = { TELEPTY_AUTH_TOKEN: '' };

let daemon;
const servers = [];

// Started by the first test that needs it, so the pure tests above never wait on a daemon.
async function ensureDaemon() {
  if (!daemon) daemon = await startTestDaemon({ env: { TELEPTY_AUTH_TOKEN: '', TELEPTY_MACHINE_ID: LOCAL_MACHINE } });
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
// every request and records its method, path, Host header and token.
async function fakePeer(ids, { refuse = false } = {}) {
  const state = { hits: 0, requests: [] };
  const server = http.createServer((req, res) => {
    state.hits += 1;
    const pathname = new URL(req.url, 'http://fake-peer').pathname;
    state.requests.push({ method: req.method, path: pathname, host: req.headers.host, token: req.headers['x-telepty-token'] });
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
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = server.address().port;
  state.close = () => new Promise((resolve) => server.close(() => resolve()));
  servers.push(state);
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

async function cli(args, env = {}) {
  return daemon.runCli(args, { timeoutMs: 30000, env: { ...NO_ENV_TOKEN, ...env } });
}

async function registerLocal(prefix) {
  const sid = createSessionId(prefix);
  const reg = await daemon.registerSession(sid);
  assert.equal(reg.status, 201, `register failed: ${JSON.stringify(reg.body)}`);
  return sid;
}

test('#1288 D1/FACT A+B: an id on the local daemon resolves locally and no peer is consulted', async () => {
  await ensureDaemon();
  const sid = await registerLocal('tp1288-d1-shared');
  const peer = await fakePeer([sid]);
  writePeers({ 'peer-a': peerEntry(peer) });

  const info = await cli(['session', 'info', sid, '--json']);
  assert.equal(info.code, 0, info.stderr);
  const doc = JSON.parse(info.stdout);
  assert.equal(doc.host, '127.0.0.1');
  assert.equal(doc.id, sid);
  assert.equal(peer.hits, 0, 'a peer was consulted for an id the local daemon has');

  const text = await cli(['session', 'info', sid]);
  assert.equal(text.code, 0, text.stderr);
  assert.doesNotMatch(text.stderr, /multiple hosts/);
  assert.equal(peer.hits, 0);

  const multicast = await cli(['multicast', sid, 'tp1288 exact probe']);
  assert.doesNotMatch(multicast.stderr, /multiple hosts|was not found/);
  assert.match(multicast.stdout, /^✅ Context multicasted successfully to /);
  assert.equal(peer.hits, 0, 'multicast consulted a peer for an id the local daemon has');
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
});

test('#1288 D3: cross-host ambiguity is a JSON refusal under --json, and unchanged text otherwise', async () => {
  await ensureDaemon();
  const did = createSessionId('tp1288-d3-dup');
  const peerA = await fakePeer([did]);
  const peerB = await fakePeer([did]);
  writePeers({ 'peer-a': peerEntry(peerA), 'peer-b': peerEntry(peerB) });

  for (const args of [['session', 'info', did, '--json'], ['read-screen', did, '--json']]) {
    const result = await cli(args);
    assert.notEqual(result.code, 0, `${args[0]}: a refusal exited 0 under --json`);
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

test('#1288 R1/R2/FACT D: an address qualifier never selects a peer registered by host name; the refusal lists the known peers', async () => {
  await ensureDaemon();
  const rid = createSessionId('tp1288-factd');
  const peer = await fakePeer([rid]);
  // Registered by NAME at the very endpoint the qualifier spells by address. `localhost` resolves to
  // 127.0.0.1 on every CI OS, so a resolver that looked names up would match it; routing must not.
  writePeers({ 'peer-dns': peerEntry(peer, { host: 'localhost', target: `localhost:${peer.port}`, machineId: 'peer-dns' }) });
  const host = `127.0.0.1:${peer.port}`;
  const message = `No peer registered with machine id or address '${host}'; known: peer-dns. `
    + 'Use telepty connect-http or telepty connect to register it.';

  const json = await cli(['read-screen', `${rid}@${host}`, '--json']);
  assert.equal(json.code, 1, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), { success: false, code: 'PEER_NOT_REGISTERED', error: message });
  assert.equal(json.stderr, `❌ ${message}\n`);
  const text = await cli(['read-screen', `${rid}@${host}`]);
  assert.deepEqual({ code: text.code, stdout: text.stdout, stderr: text.stderr }, { code: 1, stdout: '', stderr: `❌ ${message}\n` });
  assert.equal(peer.hits, 0, 'the address was resolved to the peer registered by host name');
});

test('#1288 R1/R8: an explicit host token goes to the typed address; a registered peer gets its stored token', async () => {
  await ensureDaemon();
  const rid = createSessionId('tp1288-token');
  const peer = await fakePeer([rid]);
  const ENV_TOKEN = 'tp1288-env-token';
  writePeers({ 'peer-dns': peerEntry(peer, { host: 'localhost', target: `localhost:${peer.port}`, machineId: 'peer-dns' }) });
  const typed = `127.0.0.1:${peer.port}`;

  // TELEPTY_AUTH_TOKEN set: 0.11.3 dials the typed address directly with that token. The request for
  // the session must carry the typed authority, never the registered peer's `localhost:<port>`.
  // TELEPTY_HOST is non-local and the CLI port closed (as in F3 below), so the local daemon, which does
  // not share ENV_TOKEN, is neither auto-started nor asked.
  const direct = await cli(['session', 'info', `${rid}@${typed}`, '--json'],
    { TELEPTY_HOST: '0.0.0.0', TELEPTY_PORT: String(await closedPort()), TELEPTY_AUTH_TOKEN: ENV_TOKEN });
  assert.equal(JSON.parse(direct.stdout).host, typed, direct.stderr);
  const sessionRequests = () => peer.requests.filter((request) => request.path === `/api/sessions/${rid}`);
  assert.deepEqual(sessionRequests().map(({ host, token }) => ({ host, token })), [{ host: typed, token: ENV_TOKEN }]);

  // No env token, the peer's registered name: its registered endpoint with its stored token.
  writePeers({ 'peer-a': peerEntry(peer, { machineId: 'tp1288-peer-a' }) });
  peer.requests.length = 0;
  const registered = await cli(['session', 'info', `${rid}@peer-a`, '--json']);
  assert.equal(registered.code, 0, registered.stderr);
  assert.equal(JSON.parse(registered.stdout).host, typed);
  assert.deepEqual(sessionRequests().map(({ host, token }) => ({ host, token })), [{ host: typed, token: PEER_TOKEN }]);
});

test('#1288 R3: TELEPTY_HOST=localhost, ::1 and [::1] are this machine; an exact local id consults no peer', async () => {
  await ensureDaemon();
  const sid = await registerLocal('tp1288-r3-origin');
  const peer = await fakePeer([sid]);
  writePeers({ 'peer-a': peerEntry(peer) });

  for (const host of ['localhost', '::1', '[::1]']) {
    for (const args of [['session', 'info', sid, '--json'], ['read-screen', sid, '--json'], ['multicast', sid, 'tp1288 origin probe']]) {
      const result = await cli(args, { TELEPTY_HOST: host });
      assert.doesNotMatch(result.stderr, /INCOMPLETE|multiple hosts/, `${host} ${args[0]}`);
      // Whether this runner's daemon answers on that spelling is not under test; when it does, the
      // target is the one 0.11.3 built for it: the TELEPTY_HOST spelling, not 127.0.0.1.
      if (args[0] === 'session' && result.stdout.trim()) {
        assert.equal(JSON.parse(result.stdout).host, host.replace(/^\[|\]$/g, ''));
      }
    }
  }
  assert.equal(peer.hits, 0, 'a loopback TELEPTY_HOST spelling fanned out to a peer');
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

test('#1288 D2/F10: <id>@<this machine name> is the local daemon when no peer uses the name', async () => {
  await ensureDaemon();
  const sid = await registerLocal('tp1288-d2-own');
  const peer = await fakePeer([sid]);
  writePeers({ 'peer-a': peerEntry(peer, { machineId: 'tp1288-peer-a' }) });

  const byHostname = await cli(['session', 'info', `${sid}@${os.hostname()}`, '--json']);
  assert.equal(byHostname.code, 0, byHostname.stderr);
  assert.equal(JSON.parse(byHostname.stdout).host, '127.0.0.1');

  // F10: the CLI does not know TELEPTY_MACHINE_ID; the daemon reports it on /api/meta.
  for (const name of [LOCAL_MACHINE, LOCAL_MACHINE.toUpperCase()]) {
    const byMachineId = await cli(['session', 'info', `${sid}@${name}`, '--json'], { TELEPTY_MACHINE_ID: '' });
    assert.equal(byMachineId.code, 0, byMachineId.stderr);
    assert.equal(JSON.parse(byMachineId.stdout).host, '127.0.0.1');
  }
  assert.deepEqual(peer.requests.filter((request) => request.path === `/api/sessions/${sid}`), [],
    'a request for the local session reached the peer');
});

test('#1288 F5: a registered peer always wins over the local-name alias, and is never silently replaced', async () => {
  await ensureDaemon();
  const sid = await registerLocal('tp1288-f5-shadow');
  const peer = await fakePeer([sid]);

  writePeers({ [os.hostname()]: peerEntry(peer, { machineId: 'tp1288-peer-a' }) });
  const byName = await cli(['session', 'info', `${sid}@${os.hostname()}`, '--json']);
  assert.equal(byName.code, 0, byName.stderr);
  assert.equal(JSON.parse(byName.stdout).host, `127.0.0.1:${peer.port}`, 'a peer named like this host was replaced by the local daemon');

  writePeers({ 'tp1288-other': peerEntry(peer, { machineId: LOCAL_MACHINE }) });
  const byMachineId = await cli(['session', 'info', `${sid}@${LOCAL_MACHINE}`, '--json'], { TELEPTY_MACHINE_ID: '' });
  assert.equal(byMachineId.code, 0, byMachineId.stderr);
  assert.equal(JSON.parse(byMachineId.stdout).host, `127.0.0.1:${peer.port}`);

  // A peer that uses the name in another case is not matched as a peer (aliases are exact), and the
  // local alias does not take its place either: the qualifier is refused.
  writePeers({ 'tp1288-other': peerEntry(peer, { machineId: LOCAL_MACHINE.toUpperCase() }) });
  const caseVariant = await cli(['session', 'info', `${sid}@${LOCAL_MACHINE}`, '--json'], { TELEPTY_MACHINE_ID: '' });
  assert.equal(caseVariant.code, 1);
  assert.equal(JSON.parse(caseVariant.stdout).code, 'PEER_NOT_REGISTERED');
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

test('#1288 local-name predicates are exact and case-insensitive', () => {
  assert.equal(isLocalMachineName('MAC-MINI', ['mac-mini', undefined]), true);
  assert.equal(isLocalMachineName('mac', ['mac-mini']), false);
  assert.equal(isLocalMachineName('', ['']), false);
  assert.equal(registeredPeerUsesName('Ubuntu', { other: { machineId: 'ubuntu' } }), true);
  assert.equal(registeredPeerUsesName('UBUNTU', { ubuntu: {} }), true);
  assert.equal(registeredPeerUsesName('ubuntu', { other: { host: 'other.example' } }), false);
});

test('#1288 D3/FACT E: connect-http names an IP peer after the whole address and keeps legacy keys', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-1288-http-names-'));
  let onHealth = null;
  const server = http.createServer((req, res) => {
    if (req.url === '/api/health' && onHealth) { onHealth(); onHealth = null; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/meta' ? { machine_id: 'tp1288-meta-id' } : { ok: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { port } = server.address();
  const peersFile = path.join(dir, 'peers.json');
  const context = () => createPeerContext({ PEERS_PATH: peersFile, CONTROL_DIR: dir });

  const fresh = await context().connectHttp(`127.0.0.1:${port}`);
  assert.equal(fresh.success, true, fresh.error);
  assert.equal(fresh.name, '127.0.0.1', 'an IP address was cut at its first dot');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(peersFile, 'utf8')).peers), ['127.0.0.1']);

  // F9: a legacy fragment key for the same endpoint is reused, never duplicated.
  fs.writeFileSync(peersFile, JSON.stringify({ peers: { 127: { transport: 'http', host: '127.0.0.1', port, target: `127.0.0.1:${port}`, machineId: 'old' } } }));
  const legacy = await context().connectHttp(`127.0.0.1:${port}`);
  assert.equal(legacy.success, true, legacy.error);
  assert.equal(legacy.name, '127');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(peersFile, 'utf8')).peers), ['127']);

  // A different endpoint already holding the IP name is refused, not overwritten.
  const taken = JSON.stringify({ peers: { '127.0.0.1': { transport: 'http', host: '127.0.0.1', port: port + 1, target: `127.0.0.1:${port + 1}`, machineId: 'other' } } });
  fs.writeFileSync(peersFile, taken);
  const collision = await context().connectHttp(`127.0.0.1:${port}`);
  assert.equal(collision.success, false);
  assert.match(collision.error, /already registered for a different endpoint; pass --name/);
  assert.equal(fs.readFileSync(peersFile, 'utf8'), taken);

  const named = await context().connectHttp(`127.0.0.1:${port}`, { name: 'explicit' });
  assert.equal(named.name, 'explicit');

  // R7: the collision check reads peers.json in the write step — an entry written while the health
  // and meta probes ran is seen, and the registration is refused instead of overwriting it.
  fs.writeFileSync(peersFile, JSON.stringify({ peers: {} }));
  onHealth = () => fs.writeFileSync(peersFile, taken);
  const raced = await context().connectHttp(`127.0.0.1:${port}`);
  assert.equal(raced.success, false);
  assert.match(raced.error, /already registered for a different endpoint; pass --name/);
  assert.equal(fs.readFileSync(peersFile, 'utf8'), taken);

  // R7: an explicit second name for an endpoint that already has an entry reuses that entry's key, and
  // re-registering under the same name is idempotent: one entry, same key.
  fs.writeFileSync(peersFile, JSON.stringify({ peers: { first: { transport: 'http', host: '127.0.0.1', port, target: `127.0.0.1:${port}`, machineId: 'old' } } }));
  const second = await context().connectHttp(`127.0.0.1:${port}`, { name: 'second' });
  assert.equal(second.success, true, second.error);
  assert.equal(second.name, 'first');
  const again = await context().connectHttp(`127.0.0.1:${port}`, { name: 'first' });
  assert.equal(again.name, 'first');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(peersFile, 'utf8')).peers), ['first']);
});

test('#1288 D3/FACT E: connect (SSH) names an IP peer after the whole address and keeps legacy keys', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-1288-ssh-names-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const peersFile = path.join(dir, 'peers.json');
  const context = () => createPeerContext({
    PEERS_PATH: peersFile, CONTROL_DIR: dir, getUsername: () => 'worker', execFileSync: () => ''
  });

  const one = context();
  assert.equal((await one.connect('192.0.2.3')).name, '192.0.2.3');
  const second = await one.connect('192.0.2.4');
  assert.equal(second.success, true, second.error);
  assert.equal(second.name, '192.0.2.4', 'two IP peers collided on their first label');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(peersFile, 'utf8')).peers).sort(), ['192.0.2.3', '192.0.2.4']);
  assert.equal((await one.connect('build-box.example')).name, 'build-box', 'host names keep their 0.11.3 default');

  fs.writeFileSync(peersFile, JSON.stringify({ peers: { 192: { target: 'worker@192.0.2.5', machineId: 'old' } } }));
  assert.equal((await context().connect('192.0.2.5')).name, '192');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(peersFile, 'utf8')).peers), ['192']);

  // R7: an explicit second name for a target that already has an entry reuses that entry's key.
  assert.equal((await context().connect('192.0.2.5', { name: 'other-name' })).name, '192');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(peersFile, 'utf8')).peers), ['192']);
});
