'use strict';

// PR #108 round 2 (task #2026101201): the independent review (ROUND2-REVIEW.md, table C1–C8) found
// that the ace25647 fix closed only one input of the class "caller data reaches a string a shell
// (or a terminal) interprets". Each test below feeds the crafted input to the real sink and is RED
// on 5ddcecb. C6 (Windows cmd.exe /c) is out of scope for this round.
//
//   C1  spawn `type` → PS1/PROMPT label (bash expands it on every prompt).
//   C2  spawn `session_id` → PS1/PROMPT: a denylist of `$ \` \\` left control characters and zsh
//       `%` sequences, and the null-prototype maps made `__proto__`/`constructor` creatable (N5).
//   C3  the WS session id → `kitty @ … set-tab-title '… ${id}'` run through /bin/sh by the daemon.
//   C4  the `/tmp/kitty-sock*` file name (any local user can create one) → the same shell strings.
//       Never creates a /tmp/kitty-sock* file: the transport and kitty-control seams take the
//       socket name, directory and exec function, and kitty is kept off PATH for the exec test.
//   C5  session id / cwd basename → AppleScript text → `osascript -e '…'` through /bin/sh.
//   C7  session id → OSC 0 terminal title written by the CLI (ESC/BEL in the id).
//   C8  session id → `ssh … telepty attach <id>`: ssh joins the trailing argv into a remote shell
//       command, unquoted.
//   N1  a destroyed session's pending text answered 504 DELIVERY_UNCERTAIN after the full wait.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const childProcess = require('node:child_process');
const WebSocket = require('ws');

const { startTestDaemon, createSessionId, delay } = require('../test-support/daemon-harness');

const posixOnly = (t) => (process.platform === 'win32' ? t.skip('POSIX shell sinks') : false);

let daemon;
before(async () => { daemon = await startTestDaemon(); });
after(async () => { if (daemon) await daemon.stop(); });

const destroy = (sid) => daemon.request(`/api/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' });
// $'\NNN' octal for every byte: survives type.toUpperCase() unchanged.
const oct = (s) => "$'" + [...Buffer.from(s)].map((b) => '\\' + b.toString(8).padStart(3, '0')).join('') + "'";

// ---------------------------------------------------------------------------------------- C1

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

// ---------------------------------------------------------------------------------------- C2

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

test('NB4: register refuses only ids unsafe for every producer; producer-shaped ids still register', async () => {
  const bad = ['.', '..', '...', 'a/b', '../x', 'a\\b', 'a\x01b', 'a\x1bb', 'a\x7fb', 'a\x9bb', '__proto__', 'constructor', 'prototype'];
  for (const sid of bad) {
    const res = await daemon.registerSession(sid);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(sid)}, got ${res.status}`);
    assert.equal(res.body.code, 'INVALID_SESSION_ID');
  }
  // `telepty allow` defaults to `${basename(cwd)}-${cli}`, and the owner WS URL is percent-encoded.
  const n = Date.now();
  for (const sid of [`my project-${n}-claude`, `프로젝트-${n}-claude`, `a+b-${n}`, `w:${n}`, `n-${n}@host`, `w%3A${n}`, `.a-${n}`]) {
    const res = await daemon.registerSession(sid);
    assert.ok(res.status === 200 || res.status === 201, `${sid}: ${res.status} ${JSON.stringify(res.body)}`);
    await destroy(sid);
  }
});

test('NB4: WS auto-register refuses unsafe ids without registering them', async () => {
  // `..`, `\` and control characters cannot survive URL parsing; these arrive as written.
  for (const sid of ['...', 'constructor', '__proto__']) {
    const ws = await daemon.connectSession(sid); // any connect to an unknown id auto-registers it
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('open'), 1500);
      ws.once('close', (c) => { clearTimeout(timer); resolve(c); });
    });
    if (code === 'open') ws.terminate();
    const listed = (await daemon.request('/api/sessions')).body.map((s) => s.id);
    assert.ok(!listed.includes(sid), `${sid} was auto-registered`);
    assert.equal(code, 4400, `${sid}: close code`);
  }
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

// A PATH with only `touch` on it: an unfixed shell string can run the injected `touch`, while no
// real `kitty` (installed on this host) is ever reached.
function restrictedPath(t) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-bin-'));
  fs.symlinkSync(childProcess.execFileSync('/bin/sh', ['-c', 'command -v touch'], { encoding: 'utf8' }).trim(), path.join(bin, 'touch'));
  const saved = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => { process.env.PATH = saved; fs.rmSync(bin, { recursive: true, force: true }); });
}

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
    persistSessions: () => {}, appendToOutputRing: () => {}, sessionStateManager: { feed: () => {} },
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

test('C5: osascript gets the search terms as run-handler arguments, never inside the script text', () => {
  const { submitViaOsascript } = require('../daemon');
  assert.equal(typeof submitViaOsascript, 'function', 'submitViaOsascript is exported for this test');
  const sid = `x' & do shell script "touch /tmp/never" & '`;
  const calls = [];
  const ok = submitViaOsascript(sid, 'cmd_enter', {
    execFileSync: (file, args, opts) => { calls.push({ file, args, shell: opts && opts.shell }); return Buffer.from('ok:win'); }
  });
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
  const { submitViaOsascript } = require('../daemon');
  const evil = `p" & (do shell script "touch never") & "`; // a basename: no "/"
  const calls = [];
  const ok = submitViaOsascript('w1', 'enter', {
    sessionMap: { w1: { cwd: `/home/u/${evil}`, command: 'claude' } },
    execFileSync: (file, args, opts) => { calls.push({ file, args, shell: opts && opts.shell }); return Buffer.from('ok:win'); }
  });
  assert.equal(ok, true);
  const [{ file, args, shell }] = calls;
  assert.equal(file, 'osascript');
  assert.equal(shell, undefined);
  assert.ok(!args[1].includes(evil) && !args[1].includes('touch'), 'cwd-derived text is part of the AppleScript source');
  assert.deepEqual(args.slice(2), ['w1', evil]);
});

// ---------------------------------------------------------------------------------------- C7

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

test('C8: telepty attach over ssh quotes the session id for the remote shell', (t) => {
  if (posixOnly(t)) return;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-c8-'));
  const savedHome = process.env.HOME;
  const savedExec = childProcess.execSync;
  const savedExecFile = childProcess.execFileSync;
  const savedSpawn = childProcess.spawn;
  const spawned = [];
  process.env.HOME = home;
  childProcess.execSync = () => '';
  childProcess.execFileSync = () => ''; // connect() runs ssh as argv (Snyk aadc4863 fix)
  childProcess.spawn = (file, args) => { spawned.push({ file, args }); return {}; };
  delete require.cache[require.resolve('../cross-machine')];
  let crossMachine;
  try {
    crossMachine = require('../cross-machine');
  } finally {
    childProcess.execSync = savedExec;
    childProcess.execFileSync = savedExecFile;
    childProcess.spawn = savedSpawn;
  }
  t.after(() => {
    process.env.HOME = savedHome;
    delete require.cache[require.resolve('../cross-machine')];
    fs.rmSync(home, { recursive: true, force: true });
  });

  return crossMachine.connect('u@peerhost').then((conn) => {
    assert.equal(conn.success, true, JSON.stringify(conn));
    const marker = path.join(home, 'ran');
    const sid = `w1;touch ${marker}`;
    crossMachine.remoteAttach('peerhost', sid);
    assert.equal(spawned.length, 1);
    const { file, args } = spawned[0];
    assert.equal(file, 'ssh');
    const remote = args.slice(args.indexOf('u@peerhost') + 1).join(' '); // what ssh hands the remote shell
    const words = childProcess.execFileSync('/bin/sh', ['-c', `printf '%s\\n' ${remote}`], { encoding: 'utf8' });
    assert.equal(fs.existsSync(marker), false, 'the session id ran as a command in the remote shell');
    assert.deepEqual(words.split('\n').slice(0, -1), ['telepty', 'attach', sid]);
  });
});

// ---------------------------------------------------------------------------------------- N1

test('N1: a session destroyed while its text is pending answers 410 SESSION_GONE, not DELIVERY_UNCERTAIN', async (t) => {
  const short = await startTestDaemon({ env: { TELEPTY_DELIVERY_TIMEOUT_MS: '500' } });
  t.after(() => short.stop());
  const slowServer = http.createServer((req, res) => { req.resume(); setTimeout(() => res.end('{}'), 2000); });
  await new Promise((resolve) => slowServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => slowServer.close(resolve)));
  const slow = createSessionId('r2-n1-slow');
  assert.equal((await short.registerSession(slow, { delivery_type: 'aterm', delivery_endpoint: `http://127.0.0.1:${slowServer.address().port}/d` })).status, 201);

  const sid = createSessionId('r2-n1');
  assert.ok([200, 201].includes((await short.registerSession(sid, { command: 'test-wrap' })).status));
  const ws = new WebSocket(
    `ws://${short.host}:${short.port}/api/sessions/${encodeURIComponent(sid)}`
    + `?owner=1&owner_pid=${process.pid}&command=test-wrap&token=${encodeURIComponent(short.authToken())}`,
    short.ownerAuth(sid));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  t.after(() => { try { ws.close(); } catch {} });

  const slowInject = short.request(`/api/sessions/${encodeURIComponent(slow)}/inject`, { method: 'POST', body: { prompt: 'busy' } });
  await delay(150); // the tick is now held by the slow endpoint
  const injected = short.request(`/api/sessions/${encodeURIComponent(sid)}/inject`, { method: 'POST', body: { prompt: 'never' } });
  await delay(200); // our text is pending in the mailbox
  assert.equal((await short.request(`/api/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' })).status, 200);
  const res = await injected;
  await slowInject;
  assert.equal(res.status, 410, JSON.stringify(res.body));
  assert.equal(res.body.code, 'SESSION_GONE');
});

test('N1: FileMailbox.messageState tells purged/unknown (null) from in flight and dead letter', () => {
  const { FileMailbox } = require('../src/mailbox/index');
  const mb = new FileMailbox({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'r2-n1-state-')) });
  const msg = { from: 'a', to: 's', payload: 'p', created_at: Math.floor(Date.now() / 1000) - 1, attempt: 0 };
  mb.enqueue({ ...msg, msg_id: 'm1' });
  mb.enqueue({ ...msg, msg_id: 'm2' });
  assert.equal(mb.messageState('s', 'm1'), 'pending');
  assert.equal(mb.dequeue('s').msg_id, 'm1');
  assert.equal(mb.messageState('s', 'm1'), 'in_flight');
  assert.equal(mb.withdraw('s', 'm2', 'test'), true);
  assert.equal(mb.messageState('s', 'm2'), 'dead_letter');
  assert.equal(mb.messageState('s', 'nope'), null);
  mb.purge('s');
  assert.equal(mb.messageState('s', 'm1'), null, 'a destroyed session leaves no record');
});
