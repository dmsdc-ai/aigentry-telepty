'use strict';

// P2 acceptance test (dispatch §2.4): `telepty spawn → inject → output` works
// with daemon.js stopped. Drives the supervisor binary directly through
// supervisor-launcher + j3-shim — daemon.js is never started in this test
// process. If daemon is running on the host it is not touched (we use an
// isolated HOME).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SKIP_WIN = process.platform === 'win32';

let tmpHome;
let savedHome;
let savedSessionsDir;
let binAvailable = false;

before(() => {
  // Determine whether the supervisor binary is available *before* mutating
  // env, so the diagnostic message is consistent regardless.
  try {
    const launcher = require('../src/bridge/supervisor-launcher');
    launcher.resolveBinary();
    binAvailable = true;
  } catch {
    binAvailable = false;
  }

  // Use /tmp directly (not os.tmpdir()) on macOS to keep the UDS socket path
  // under the 104-char limit — os.tmpdir() returns the much longer
  // /var/folders/... path which would push supervisor.sock past the limit.
  const baseTmp = process.platform === 'darwin' && fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
  tmpHome = fs.mkdtempSync(path.join(baseTmp, 'tp-e2e-'));
  savedHome = process.env.HOME;
  savedSessionsDir = process.env.TELEPTY_SESSIONS_DIR;
  process.env.HOME = tmpHome;
  // Ensure j3-shim's sessionsRoot() resolves to the same place the supervisor
  // writes (manifest.rs::session_dir reads $HOME).
  delete process.env.TELEPTY_SESSIONS_DIR;
});

after(() => {
  if (savedHome !== undefined) process.env.HOME = savedHome;
  else delete process.env.HOME;
  if (savedSessionsDir !== undefined) process.env.TELEPTY_SESSIONS_DIR = savedSessionsDir;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

const SKIP_REASON = !binAvailable
  ? 'telepty-supervisor-bin not built — run `cargo build -p telepty-supervisor-bin --release`'
  : false;

test('E2E: spawn → inject → output via bridge alone (daemon.js never started)', {
  skip: SKIP_WIN ? 'UDS path is POSIX-only in P2 (Windows = P4 scope)' : SKIP_REASON,
}, async (t) => {
  const launcher = require('../src/bridge/supervisor-launcher');
  const shim = require('../src/bridge/j3-shim');

  const sid = `e2e-${Date.now()}`;
  // Long-lived shell that echoes each line it receives. Use `cat -u` so PTY
  // output flushes per-line — avoids buffer hangs at the read side.
  const handle = launcher.spawn({
    sid,
    argv: ['cat', '-u'],
    env: { ...process.env, HOME: tmpHome, RUST_LOG: 'error' },
  });

  // Surface stderr on failure for debugging.
  const stderrChunks = [];
  if (handle.child.stderr) {
    handle.child.stderr.on('data', (d) => stderrChunks.push(d));
  }

  t.after(async () => {
    try { handle.child.kill('SIGTERM'); } catch {}
    await new Promise((r) => setTimeout(r, 200));
    try { handle.child.kill('SIGKILL'); } catch {}
  });

  // Wait for manifest Ready
  try {
    await launcher.waitReady(sid, { timeoutMs: 4000 });
  } catch (err) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8');
    throw new Error(`waitReady failed: ${err.message}\nsupervisor stderr:\n${stderr}`);
  }

  // list() now surfaces the session
  const listed = shim.list();
  const found = listed.find((s) => s.id === sid);
  assert.ok(found, 'shim.list() should include the just-spawned session');
  assert.equal(found.transport, 'supervisor');
  assert.equal(found.status, 'ready');

  // Start subscribing to output BEFORE injecting so we don't miss the echo.
  const ac = new AbortController();
  const collected = [];
  const consumer = (async () => {
    for await (const chunk of shim.output(sid, { signal: ac.signal })) {
      if (chunk.exit) break;
      if (typeof chunk.data === 'string') collected.push(chunk.data);
      if (collected.join('').includes('ping-echo')) break;
    }
  })();

  // Give the subscribe a tick to register before the inject.
  await new Promise((r) => setTimeout(r, 50));

  const injectRes = await shim.inject(sid, 'ping-echo\n', { errorWindowMs: 80 });
  assert.equal(injectRes.success, true, `inject should succeed; got ${JSON.stringify(injectRes)}`);

  // Wait for the echo with a deadline.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !collected.join('').includes('ping-echo')) {
    await new Promise((r) => setTimeout(r, 25));
  }
  ac.abort();
  try { await consumer; } catch {}

  const text = collected.join('');
  assert.ok(
    text.includes('ping-echo'),
    `output stream should contain echoed payload; saw: ${JSON.stringify(text)}\nstderr: ${Buffer.concat(stderrChunks).toString('utf8')}`,
  );
});

test('E2E: launcher.resolveBinary respects TELEPTY_SUPERVISOR_BIN env', () => {
  const launcher = require('../src/bridge/supervisor-launcher');
  const prev = process.env.TELEPTY_SUPERVISOR_BIN;
  try {
    process.env.TELEPTY_SUPERVISOR_BIN = '/tmp/definitely-not-a-real-binary-xyz';
    assert.throws(
      () => launcher.resolveBinary(),
      (err) => err.code === 'ERR_BIN_NOT_FOUND',
    );
  } finally {
    if (prev === undefined) delete process.env.TELEPTY_SUPERVISOR_BIN;
    else process.env.TELEPTY_SUPERVISOR_BIN = prev;
  }
});

test('E2E: launcher.spawn validates arguments', () => {
  const launcher = require('../src/bridge/supervisor-launcher');
  assert.throws(() => launcher.spawn({ sid: '', argv: ['bash'] }), (err) => err.code === 'ERR_BAD_ARG');
  assert.throws(() => launcher.spawn({ sid: 'x', argv: [] }), (err) => err.code === 'ERR_BAD_ARG');
  assert.throws(() => launcher.spawn({ sid: 'x' }), (err) => err.code === 'ERR_BAD_ARG');
});

test('E2E: isAlive returns false for unknown / dead sessions', () => {
  const launcher = require('../src/bridge/supervisor-launcher');
  assert.equal(launcher.isAlive('phantom-no-manifest'), false);
});
