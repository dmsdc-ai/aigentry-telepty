'use strict';

// PR #108 round 2 shell-string class (C1–C5, C7, C8), ported onto Linux 9b80289 with the reviewed
// eec9a05 helpers (src/kitty-control.js, src/session-id.js, byte-exact) — task1207 resume2, P2/P3/P4.
// Source: eec9a05 test/shell-string-class-pr108-r2.test.js. Cases marked VERBATIM are byte-identical
// test bodies; RE-ANCHORED cases keep every assertion and change only how the real sink is reached,
// because 9b80289 moved it: the transport dependency set (persistSessions answers {ok, committed}),
// submitViaOsascript inside createSessionInspectionContext (execFileSync seam), and cross-machine's
// createPeerContext seam instead of patching child_process. Not ported here (recorded in the
// integration report): NB4 register / WS auto-register refusals (client-visible, not adopted) and N1
// (covered by the Linux delivery suites). Author-written in the source phase; NOT RUN here.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const childProcess = require('node:child_process');
const WebSocket = require('ws');

const { startTestDaemon, createSessionId, delay } = require('../test-support/daemon-harness');

// #879: t.skip() returns undefined, so the old guard never returned and the body still ran /bin/sh
// (measured ENOENT, reported as `not ok # SKIP`). The sinks are POSIX /bin/sh and kitty paths.
const posixOnly = (t) => (process.platform === 'win32' ? (t.skip('POSIX shell sinks'), true) : false);

let daemon;
before(async () => { daemon = await startTestDaemon(); });
after(async () => { if (daemon) await daemon.stop(); });

const destroy = (sid) => daemon.request(`/api/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' });
// $'\NNN' octal for every byte: survives type.toUpperCase() unchanged.
const oct = (s) => "$'" + [...Buffer.from(s)].map((b) => '\\' + b.toString(8).padStart(3, '0')).join('') + "'";

// ---------------------------------------------------------------------------------------- C1 (VERBATIM)

test('C1: a spawn `type` carrying shell syntax is refused before it reaches PS1', async (t) => {
  if (posixOnly(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-c1-'));
  const marker = path.join(dir, 'ran');
  const type = `USER$(${oct('touch')} ${oct(marker)})`;
  assert.equal(type.toUpperCase(), type);
  const sid = createSessionId('r2-c1');
  try {
    const res = await daemon.spawnSession(sid, { type });
    await delay(1500); // an unfixed interactive bash prints its prompt (expands PS1) in this window
    if (res.status === 201) await destroy(sid);
    assert.equal(fs.existsSync(marker), false, 'type was executed as a command via PS1');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INVALID_SESSION_TYPE');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('C1: USER, AGENT and an omitted type still spawn; anything else is a typed 400', async () => {
  for (const type of ['USER', 'AGENT', undefined]) {
    const sid = createSessionId('r2-c1-ok');
    const res = await daemon.spawnSession(sid, { type });
    assert.equal(res.status, 201, `type ${type}: ${JSON.stringify(res.body)}`);
    await destroy(sid);
  }
  for (const type of ['ADMIN', 'user ', 'USER\n', '']) {
    const res = await daemon.spawnSession(createSessionId('r2-c1-bad'), { type });
    assert.equal(res.status, 400, `type ${JSON.stringify(type)}`);
    assert.equal(res.body.code, 'INVALID_SESSION_TYPE');
  }
});


// ---------------------------------------------------------------------------------------- C2 (VERBATIM)

test('C2: spawn session_id is an allowlist — control chars, zsh % sequences, spaces and prototype names are a 400', async () => {
  const base = createSessionId('r2-c2');
  const bad = [
    `${base}\x1b]0;pwn\x07`, `${base}\r\n`, `${base}\x9b`, `${base}%F{red}`, `${base}%(x)`,
    `${base} x`, `${base};x`, `${base}'x`, '__proto__', 'constructor', 'prototype'
  ];
  for (const sid of bad) {
    const res = await daemon.spawnSession(sid);
    if (res.status === 201) await destroy(sid);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(sid)}, got ${res.status}`);
    assert.equal(res.body.code, 'INVALID_SESSION_ID');
  }
});


test('NB4: spawn refuses ids made only of dots (the mailbox dir is path.join(root, id))', async () => {
  const { isValidSessionId } = require('../src/session-id');
  for (const sid of ['.', '..', '...']) {
    const res = await daemon.spawnSession(sid);
    if (res.status === 201) await destroy(sid);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(sid)}, got ${res.status}`);
    assert.equal(res.body.code, 'INVALID_SESSION_ID');
    assert.equal(isValidSessionId(sid), false, JSON.stringify(sid));
  }
  assert.equal(isValidSessionId('a..b'), true);
  assert.equal(isValidSessionId('.a'), true);
});


test('C2: ids in use across the ecosystem still spawn', async () => {
  const n = Date.now();
  for (const sid of [`tp-r2-108-${n}`, `kkoma-${n.toString(16)}`, `aigentry_orchestrator.claude-${n}`, `w:${n}`, `name-${n}@host`]) {
    const res = await daemon.spawnSession(sid);
    assert.equal(res.status, 201, `${sid}: ${JSON.stringify(res.body)}`);
    await destroy(sid);
  }
});


// ----------------------------------------------------------------------------------- C3 / C4

function restrictedPath(t) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-bin-'));
  fs.symlinkSync(childProcess.execFileSync('/bin/sh', ['-c', 'command -v touch'], { encoding: 'utf8' }).trim(), path.join(bin, 'touch'));
  const saved = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => { process.env.PATH = saved; fs.rmSync(bin, { recursive: true, force: true }); });
}

// RE-ANCHORED: the 9b80289 transport dependency set (as test/ws-owner-record-swap-732.test.js builds
// it); persistSessions answers the durable {ok, committed} shape this transport now reads.
async function autoRegisterThroughTransport(t, { sessionId, socketName }) {
  delete require.cache[require.resolve('../src/transport/websocket')];
  const { installWebSocketTransport } = require('../src/transport/websocket');
  const express = require('express');
  const server = http.createServer(express());
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const sessions = Object.create(null);
  installWebSocketTransport({
    server, tailnetServer: null, sessions, busClients: new Set(), expectedToken: 'r2-tok',
    verifyJwt: () => false, isAllowedPeer: () => true, initializeBootstrapState: () => {},
    findKittySocket: () => socketName,
    findKittyWindowId: () => 7,
    markSessionConnected: () => {}, scheduleBootstrapPromptPoll: () => {}, emitSessionLifecycleEvent: () => {},
    persistSessions: () => ({ ok: true, committed: true }), appendToOutputRing: () => {}, sessionStateManager: { feed: () => {} },
    isBootstrapGatedSession: () => false, markBootstrapReady: () => {}, pendingReports: {}, fireAutoReport: () => {},
    markSessionDisconnected: () => {}, resolveSessionAlias: (id) => id, applySessionStateReport: () => ({ success: false }),
    busAutoRoute: () => {}
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${sessionId}?token=r2-tok&owner=1&owner_pid=${process.pid}`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  t.after(() => { try { ws.terminate(); } catch {} server.close(); });
  await delay(1500); // the tab-title exec runs 1000 ms after auto-register
  return sessions;
}

// VERBATIM body; reaches the sink through the re-anchored transport helper above.
test('C3: a quote in the WS session id does not break out of the kitty set-tab-title command', async (t) => {
  if (posixOnly(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-c3-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, 'ran');
  process.env.R2_C3_MARK = marker;
  t.after(() => { delete process.env.R2_C3_MARK; });
  restrictedPath(t);
  const sessionId = "r2c3';touch$IFS$R2_C3_MARK;'";
  const sessions = await autoRegisterThroughTransport(t, { sessionId, socketName: path.join(dir, 'kitty-sock-x') });
  assert.ok(sessions[sessionId], 'auto-register path taken');
  assert.equal(fs.existsSync(marker), false, 'the session id ran as a shell command in the daemon');
});


// VERBATIM body; reaches the sink through the re-anchored transport helper above.
test('C4: a kitty socket file name cannot run a command in the daemon', async (t) => {
  if (posixOnly(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-c4-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, 'ran');
  restrictedPath(t);
  await autoRegisterThroughTransport(t, { sessionId: 'r2c4', socketName: `${dir}/kitty-sock;touch ${marker};#` });
  assert.equal(fs.existsSync(marker), false, 'the socket file name ran as a shell command in the daemon');
});


function kittyControl() { return require('../src/kitty-control'); }

// VERBATIM
test('C4: findKittySocket refuses a planted regular file and a symlink (real fs, temp dir)', (t) => {
  if (posixOnly(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-sock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'kitty-sock;touch x'), '');
  fs.symlinkSync(path.join(dir, 'kitty-sock;touch x'), path.join(dir, 'kitty-sock-a'));
  const { findKittySocket } = kittyControl();
  assert.equal(findKittySocket({ dir }), null);
  assert.equal(findKittySocket({ dir: path.join(dir, 'missing') }), null);
});


// VERBATIM
test('C4: findKittySocket accepts only a socket owned by the daemon uid (injected fs: this sandbox refuses unix listen)', () => {
  const uid = 1000;
  const entries = {
    'kitty-sock;touch x': { socket: true, symlink: false, uid },   // name check: refused before lstat
    'kitty-sock-link': { socket: false, symlink: true, uid },
    'kitty-sock-other': { socket: true, symlink: false, uid: uid + 1 },
    'kitty-sock-ok': { socket: true, symlink: false, uid },
    'unrelated': { socket: true, symlink: false, uid }
  };
  const lstated = [];
  const fakeFs = {
    readdirSync: () => Object.keys(entries),
    lstatSync: (p) => {
      lstated.push(p);
      const e = entries[path.basename(p)];
      return { isSocket: () => e.socket, isSymbolicLink: () => e.symlink, uid: e.uid };
    }
  };
  const { findKittySocket } = kittyControl();
  assert.equal(findKittySocket({ dir: '/d', fs: fakeFs, uid }), '/d/kitty-sock-ok');
  assert.ok(!lstated.includes('/d/kitty-sock;touch x'), 'a name outside the allowlist is never used');
  assert.equal(findKittySocket({ dir: '/d', fs: fakeFs, uid: uid + 2 }), null, 'no socket owned by this uid');
});


// VERBATIM
test('C4: findKittySocket does not follow a symlink to our socket and refuses our regular file (NB1)', () => {
  const uid = 1000;
  // lstat describes the entry itself, stat the link target; one entry per directory so a valid
  // socket next to it cannot mask the result.
  const oneEntryFs = (name, lstat, stat) => ({
    readdirSync: () => [name],
    lstatSync: () => ({ isSocket: () => lstat.socket, isSymbolicLink: () => lstat.symlink, uid: lstat.uid }),
    statSync: () => ({ isSocket: () => stat.socket, isSymbolicLink: () => false, uid: stat.uid })
  });
  const { findKittySocket } = kittyControl();
  const link = oneEntryFs('kitty-sock-link', { socket: false, symlink: true, uid }, { socket: true, uid });
  assert.equal(findKittySocket({ dir: '/d', fs: link, uid }), null, 'a symlink to a socket we own is followed');
  const file = { socket: false, symlink: false, uid };
  assert.equal(findKittySocket({ dir: '/d', fs: oneEntryFs('kitty-sock-1234', file, file), uid }), null, 'a regular file we own is used as a socket');
});


// VERBATIM
test('C4: real fs — a valid-name regular file we own and a valid-name symlink to our real socket are refused (Mac re-review)', async (t) => {
  if (posixOnly(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-realsock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { findKittySocket } = kittyControl();
  fs.writeFileSync(path.join(dir, 'kitty-sock-1'), '');
  assert.equal(findKittySocket({ dir }), null, 'an owned regular file with a valid name is used as a socket');
  fs.rmSync(path.join(dir, 'kitty-sock-1'));
  // A real socket under a name outside the allowlist, reached only through a valid-name symlink.
  const server = require('node:net').createServer();
  const listened = await new Promise((resolve) => {
    server.once('error', (e) => resolve(e.code));
    server.listen(path.join(dir, 'real.sock'), () => resolve(true));
  });
  if (listened !== true) return t.skip(`unix listen refused here (${listened}); the injected-fs NB1 test covers it`);
  t.after(() => server.close());
  fs.symlinkSync(path.join(dir, 'real.sock'), path.join(dir, 'kitty-sock-link'));
  assert.equal(findKittySocket({ dir }), null, 'a symlink to our socket is followed');
  fs.renameSync(path.join(dir, 'real.sock'), path.join(dir, 'kitty-sock-real'));
  fs.rmSync(path.join(dir, 'kitty-sock-link'));
  assert.equal(findKittySocket({ dir }), path.join(dir, 'kitty-sock-real'), 'positive control: our real socket is found');
});


// VERBATIM
test('C3/C4: every kitty @ call is an argv array (no shell)', () => {
  const { findKittyWindowId, setKittyTabTitle } = kittyControl();
  const calls = [];
  const sid = "x';touch y;'";
  const execFileSync = (file, args, opts) => {
    calls.push({ file, args, shell: opts && opts.shell });
    return JSON.stringify([{ tabs: [{ windows: [{ id: 42, foreground_processes: [{ cmdline: ['telepty', 'allow', '--id', sid, 'claude'] }] }] }] }]);
  };
  const sock = '/x/kitty-sock;touch y';
  assert.equal(findKittyWindowId(sock, sid, { execFileSync }), 42);
  setKittyTabTitle(sock, 42, sid, { execFileSync });
  assert.deepEqual(calls, [
    { file: 'kitty', args: ['@', '--to', `unix:${sock}`, 'ls'], shell: undefined },
    { file: 'kitty', args: ['@', '--to', `unix:${sock}`, 'set-tab-title', '--match', 'id:42', `⚡ telepty :: ${sid}`], shell: undefined }
  ]);
});


// ---------------------------------------------------------------------------------------- C5
// RE-ANCHORED: submitViaOsascript lives in createSessionInspectionContext (src/routes/session-inspection.js)
// with an execFileSync seam; the session map is the context's shared.sessions.
function osascriptContext(sessions, execFileSync) {
  const { createSessionInspectionContext } = require('../src/routes/session-inspection');
  return createSessionInspectionContext({ sessions }, { execFileSync });
}

test('C5: osascript gets the search terms as run-handler arguments, never inside the script text', () => {
  const sid = `x' & do shell script "touch /tmp/never" & '`;
  const calls = [];
  const { submitViaOsascript } = osascriptContext(Object.create(null),
    (file, args, opts) => { calls.push({ file, args, shell: opts && opts.shell }); return Buffer.from('ok:win'); });
  assert.equal(typeof submitViaOsascript, 'function', 'submitViaOsascript is exposed by the inspection context');
  const ok = submitViaOsascript(sid, 'cmd_enter');
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  const [{ file, args, shell }] = calls;
  assert.equal(file, 'osascript');
  assert.equal(shell, undefined);
  assert.equal(args[0], '-e');
  assert.ok(!args[1].includes(sid) && !args[1].includes('touch'), 'caller data is not part of the AppleScript source');
  assert.match(args[1], /on run argv/);
  assert.match(args[1], /key code 36 using command down/);
  assert.deepEqual(args.slice(2), [sid]);
});

test('C5: the cwd basename search term is a run-handler argument too (Mac re-review)', () => {
  const evil = `p" & (do shell script "touch never") & "`; // a basename: no "/"
  const calls = [];
  const { submitViaOsascript } = osascriptContext({ w1: { cwd: `/home/u/${evil}`, command: 'claude' } },
    (file, args, opts) => { calls.push({ file, args, shell: opts && opts.shell }); return Buffer.from('ok:win'); });
  const ok = submitViaOsascript('w1', 'enter');
  assert.equal(ok, true);
  const [{ file, args, shell }] = calls;
  assert.equal(file, 'osascript');
  assert.equal(shell, undefined);
  assert.ok(!args[1].includes(evil) && !args[1].includes('touch'), 'cwd-derived text is part of the AppleScript source');
  assert.deepEqual(args.slice(2), ['w1', evil]);
});

// ---------------------------------------------------------------------------------------- C7 (VERBATIM)

test('C7: terminal titles strip C0/C1 control characters from the id', () => {
  const { formatTerminalTitle } = require('../src/session-id');
  assert.equal(formatTerminalTitle('a\x1b]0;pwn\x07b\x9bc\r\n'), '\x1b]0;⚡ telepty :: a]0;pwnbc\x07');
  assert.equal(formatTerminalTitle('w1', ' @ host\x07x'), '\x1b]0;⚡ telepty :: w1 @ hostx\x07');
});


test('C7: cli.js writes no session-id title escape by hand', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'cli.js'), 'utf8');
  assert.deepEqual(src.match(/\\x1b\]0;⚡ telepty :: \$\{/g), null, 'raw OSC title with an interpolated id');
});


// ---------------------------------------------------------------------------------------- C8
// RE-ANCHORED: cross-machine.js exposes createPeerContext({ execFileSync, spawn, PEERS_PATH, CONTROL_DIR })
// in 9b80289, so the ssh runner is injected instead of patching child_process before require.

test('C8: telepty attach over ssh quotes the session id for the remote shell', async (t) => {
  if (posixOnly(t)) return;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-c8-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const spawned = [];
  const { createPeerContext } = require('../cross-machine');
  const peers = createPeerContext({
    execFileSync: () => '', // connect() runs ssh as argv
    spawn: (file, args) => { spawned.push({ file, args }); return {}; },
    PEERS_PATH: path.join(home, 'peers.json'), CONTROL_DIR: path.join(home, 'control'),
    getUsername: () => 'u',
  });
  const conn = await peers.connect('u@peerhost');
  assert.equal(conn.success, true, JSON.stringify(conn));
  const marker = path.join(home, 'ran');
  const sid = `w1;touch ${marker}`;
  peers.remoteAttach('peerhost', sid);
  assert.equal(spawned.length, 1);
  const { file, args } = spawned[0];
  assert.equal(file, 'ssh');
  const remote = args.slice(args.indexOf('u@peerhost') + 1).join(' '); // what ssh hands the remote shell
  const words = childProcess.execFileSync('/bin/sh', ['-c', `printf '%s\\n' ${remote}`], { encoding: 'utf8' });
  assert.equal(fs.existsSync(marker), false, 'the session id ran as a command in the remote shell');
  assert.deepEqual(words.split('\n').slice(0, -1), ['telepty', 'attach', sid]);
});
