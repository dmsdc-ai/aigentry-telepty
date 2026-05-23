'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SKIP_WIN = process.platform === 'win32';

let tmpSessionsRoot;

before(() => {
  tmpSessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-sessions-'));
  process.env.TELEPTY_SESSIONS_DIR = tmpSessionsRoot;
});

after(() => {
  try { fs.rmSync(tmpSessionsRoot, { recursive: true, force: true }); } catch {}
  delete process.env.TELEPTY_SESSIONS_DIR;
});

// Require AFTER env is set so any cached resolution stays consistent.
// j3-shim resolves sessionsRoot() lazily so this also works pre-require.
const shim = require('../src/bridge/j3-shim');

function writeManifest(sid, overrides = {}) {
  const dir = shim.sessionDir(sid);
  fs.mkdirSync(dir, { recursive: true });
  const sockPath = path.join(dir, `${sid}.sock`);
  const manifest = {
    schema_version: 1,
    id: sid,
    pid: process.pid,
    ipc: { kind: 'uds', path: sockPath },
    status: 'ready',
    restart_count: 0,
    created_at: new Date().toISOString(),
    kill_gate: { graceful_grace_ms: 3000, parent_death_grace_ms: 15000, restart_policy: 'respawn' },
    ...overrides,
  };
  fs.writeFileSync(shim.manifestPath(sid), JSON.stringify(manifest));
  return { dir, sockPath, manifest };
}

function startFakeSupervisor(sockPath, handler) {
  const server = net.createServer((socket) => {
    const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });
    const send = (obj) => socket.write(JSON.stringify(obj) + '\n');
    rl.on('line', (line) => {
      if (!line) return;
      let frame;
      try { frame = JSON.parse(line); }
      catch { return; }
      handler(frame, send, socket);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => resolve(server));
  });
}

function shutdownServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function cleanupSession(sid) {
  try { fs.rmSync(shim.sessionDir(sid), { recursive: true, force: true }); } catch {}
}

test('list returns [] when sessions dir does not exist', () => {
  const prev = process.env.TELEPTY_SESSIONS_DIR;
  process.env.TELEPTY_SESSIONS_DIR = path.join(tmpSessionsRoot, 'nonexistent-xyz');
  try {
    assert.deepEqual(shim.list(), []);
  } finally {
    process.env.TELEPTY_SESSIONS_DIR = prev;
  }
});

test('list filters out manifests with non-ready status', { skip: SKIP_WIN }, () => {
  writeManifest('alpha', { status: 'ready' });
  writeManifest('beta', { status: 'stopped' });
  writeManifest('gamma', { status: 'draining' });
  // Write a garbage dir without manifest
  fs.mkdirSync(shim.sessionDir('orphan'), { recursive: true });
  try {
    const ids = shim.list().map((s) => s.id).sort();
    assert.deepEqual(ids, ['alpha', 'gamma']);
    const alpha = shim.list().find((s) => s.id === 'alpha');
    assert.equal(alpha.transport, 'supervisor');
    assert.equal(alpha.host, '127.0.0.1');
    assert.equal(alpha.status, 'ready');
  } finally {
    cleanupSession('alpha');
    cleanupSession('beta');
    cleanupSession('gamma');
    cleanupSession('orphan');
  }
});

test('findSupervisorManifest returns null when manifest missing or malformed', () => {
  assert.equal(shim.findSupervisorManifest('does-not-exist'), null);
  // Write a manifest with id mismatch
  writeManifest('mismatch', { id: 'wrong-id', status: 'ready' });
  try {
    assert.equal(shim.findSupervisorManifest('mismatch'), null);
  } finally {
    cleanupSession('mismatch');
  }
});

test('findSupervisorManifest returns manifest for ready/draining sessions only', () => {
  writeManifest('ready-1', { status: 'ready' });
  writeManifest('drain-1', { status: 'draining' });
  writeManifest('stop-1', { status: 'stopped' });
  try {
    assert.ok(shim.findSupervisorManifest('ready-1'));
    assert.ok(shim.findSupervisorManifest('drain-1'));
    assert.equal(shim.findSupervisorManifest('stop-1'), null);
  } finally {
    cleanupSession('ready-1');
    cleanupSession('drain-1');
    cleanupSession('stop-1');
  }
});

test('inject returns ERR_NO_SUPERVISOR when no manifest exists', async () => {
  const res = await shim.inject('phantom', 'hello');
  assert.equal(res.success, false);
  assert.equal(res.code, 'ERR_NO_SUPERVISOR');
});

test('inject sends a Frame and resolves success when no error frame arrives', { skip: SKIP_WIN }, async () => {
  const { sockPath } = writeManifest('ok-1');
  const received = [];
  const server = await startFakeSupervisor(sockPath, (frame) => { received.push(frame); });
  try {
    const res = await shim.inject('ok-1', 'hello world', { errorWindowMs: 60 });
    assert.equal(res.success, true);
    assert.ok(typeof res.trace_id === 'string' && res.trace_id.length > 0);
    assert.equal(received.length, 1);
    assert.equal(received[0].kind, 'inject');
    assert.equal(received[0].sid, 'ok-1');
    assert.equal(received[0].data, 'hello world');
    assert.equal(received[0].trace_id, res.trace_id);
    assert.equal(received[0].op_id, res.trace_id, 'op_id defaults to trace_id when idempotency_key absent');
  } finally {
    await shutdownServer(server);
    cleanupSession('ok-1');
  }
});

test('inject returns supervisor error when error frame arrives in window', { skip: SKIP_WIN }, async () => {
  const { sockPath } = writeManifest('reject-1');
  const server = await startFakeSupervisor(sockPath, (frame, send) => {
    if (frame.kind === 'inject') {
      send({
        v: 1,
        kind: 'error',
        code: 'ERR_DUPLICATE_OP',
        data: 'duplicate_inject',
        trace_id: frame.trace_id,
      });
    }
  });
  try {
    const res = await shim.inject('reject-1', 'hi', { errorWindowMs: 200 });
    assert.equal(res.success, false);
    assert.equal(res.code, 'ERR_DUPLICATE_OP');
    assert.match(res.error, /duplicate_inject/);
  } finally {
    await shutdownServer(server);
    cleanupSession('reject-1');
  }
});

test('inject preserves caller-supplied idempotency_key as op_id', { skip: SKIP_WIN }, async () => {
  const { sockPath } = writeManifest('idem-1');
  const received = [];
  const server = await startFakeSupervisor(sockPath, (frame) => { received.push(frame); });
  try {
    const res = await shim.inject('idem-1', 'x', { idempotency_key: 'my-op-key-42', errorWindowMs: 40 });
    assert.equal(res.success, true);
    assert.equal(received[0].op_id, 'my-op-key-42');
  } finally {
    await shutdownServer(server);
    cleanupSession('idem-1');
  }
});

test('output throws ERR_NO_SUPERVISOR when manifest missing', async () => {
  await assert.rejects(
    async () => {
      const gen = shim.output('phantom-out');
      await gen.next();
    },
    (err) => err && err.code === 'ERR_NO_SUPERVISOR',
  );
});

test('output yields output frames and breaks on shutdown_drain', { skip: SKIP_WIN }, async () => {
  const { sockPath } = writeManifest('out-1');
  const server = await startFakeSupervisor(sockPath, (_frame, send) => {
    // Send a burst of output then shutdown_drain
    send({ v: 1, kind: 'output', sid: 'out-1', data: 'line-a', seq: 1 });
    send({ v: 1, kind: 'output', sid: 'out-1', data: 'line-b', seq: 2 });
    send({
      v: 1,
      kind: 'shutdown_drain',
      sid: 'out-1',
      exit_reason: 'normal',
      exit_code: 0,
      escalated: false,
    });
  });
  try {
    // Kick off the stream — but we need to send something so the server reacts.
    // The server-side handler runs on incoming line, so trigger by posting a no-op
    // ping via a separate connection (j3-shim output opens its own connection but
    // doesn't send a line unless fromSeq is set). Use fromSeq=0 to trigger.
    const gen = shim.output('out-1', { fromSeq: 0 });
    const collected = [];
    for await (const item of gen) collected.push(item);
    // Expect 2 output items + 1 exit-marker item
    assert.equal(collected.length, 3);
    assert.equal(collected[0].data, 'line-a');
    assert.equal(collected[0].seq, 1);
    assert.equal(collected[1].data, 'line-b');
    assert.equal(collected[2].exit.reason, 'normal');
    assert.equal(collected[2].exit.code, 0);
  } finally {
    await shutdownServer(server);
    cleanupSession('out-1');
  }
});

test('output supports AbortSignal cancellation', { skip: SKIP_WIN }, async () => {
  const { sockPath } = writeManifest('cancel-1');
  // Server emits output frames continuously until socket close
  const server = await startFakeSupervisor(sockPath, (_frame, send, socket) => {
    let i = 0;
    const id = setInterval(() => {
      try { send({ v: 1, kind: 'output', sid: 'cancel-1', data: `chunk-${i++}`, seq: i }); }
      catch { clearInterval(id); }
    }, 5);
    socket.once('close', () => clearInterval(id));
  });
  try {
    const ac = new AbortController();
    const gen = shim.output('cancel-1', { fromSeq: 0, signal: ac.signal });
    const collected = [];
    setTimeout(() => ac.abort(), 30);
    for await (const item of gen) collected.push(item);
    // We expect *some* chunks to have arrived before abort.
    assert.ok(collected.length >= 1, 'received at least one chunk before abort');
  } finally {
    await shutdownServer(server);
    cleanupSession('cancel-1');
  }
});

test('toSessionInfo includes exit fields only when present', () => {
  const ready = shim.toSessionInfo({
    id: 's1',
    pid: 1234,
    ipc: { kind: 'uds', path: '/tmp/x.sock' },
    status: 'ready',
    created_at: '2026-05-23T00:00:00Z',
  });
  assert.equal(ready.exit_reason, undefined);
  assert.equal(ready.exit_code, undefined);

  const tomb = shim.toSessionInfo({
    id: 's2',
    pid: 1234,
    ipc: { kind: 'uds', path: '/tmp/y.sock' },
    status: 'error',
    created_at: '2026-05-23T00:00:00Z',
    exit_reason: 'crashed',
    exit_code: 137,
    exit_signal: 'SIGKILL',
  });
  assert.equal(tomb.exit_reason, 'crashed');
  assert.equal(tomb.exit_code, 137);
  assert.equal(tomb.exit_signal, 'SIGKILL');
});
