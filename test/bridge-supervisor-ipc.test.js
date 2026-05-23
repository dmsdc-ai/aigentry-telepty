'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  connect,
  BridgeClient,
  BridgeClientError,
  WIRE_VERSION,
} = require('../src/bridge/supervisor-ipc');

// Tests use POSIX UDS. The Windows path is P4 scope (dispatch §2).
const SKIP_WIN = process.platform === 'win32';

function mkSockPath(label) {
  // Keep short to stay within macOS 104-char UDS limit.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-'));
  return path.join(dir, `${label}.sock`);
}

// Minimal fake supervisor server: on connect, the harness `onFrame(frame, send)`
// callback decides how to reply. `send(obj)` writes one NDJSON frame back.
function startFakeSupervisor(sockPath, handler) {
  const server = net.createServer((socket) => {
    const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });
    const send = (obj) => {
      socket.write(JSON.stringify(obj) + '\n');
    };
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

test('connect rejects with ERR_NOT_REACHABLE when socket missing', { skip: SKIP_WIN }, async () => {
  await assert.rejects(
    () => connect('/tmp/telepty-bridge-nonexistent-xyz.sock', { connectTimeoutMs: 200 }),
    (err) => {
      assert.ok(err instanceof BridgeClientError);
      assert.equal(err.code, 'ERR_NOT_REACHABLE');
      return true;
    },
  );
});

test('connect rejects ERR_BAD_FRAME when socketPath empty', async () => {
  await assert.rejects(
    () => connect('', { connectTimeoutMs: 100 }),
    (err) => err instanceof BridgeClientError && err.code === 'ERR_BAD_FRAME',
  );
});

test('send writes a frame with auto-filled wire version and trace_id (inject)', { skip: SKIP_WIN }, async () => {
  const sock = mkSockPath('ipc-send');
  const received = [];
  const server = await startFakeSupervisor(sock, (frame) => { received.push(frame); });
  try {
    const client = await connect(sock);
    const { trace_id } = await client.send({ kind: 'inject', sid: 'demo', data: 'hi' });
    assert.ok(typeof trace_id === 'string' && trace_id.length > 0, 'auto-fills trace_id');
    // Wait for server-side line delivery (small grace).
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(received.length, 1);
    assert.equal(received[0].v, WIRE_VERSION);
    assert.equal(received[0].kind, 'inject');
    assert.equal(received[0].sid, 'demo');
    assert.equal(received[0].trace_id, trace_id);
    assert.equal(received[0].data, 'hi');
    await client.close();
  } finally {
    await shutdownServer(server);
  }
});

test('send preserves caller-supplied trace_id', { skip: SKIP_WIN }, async () => {
  const sock = mkSockPath('ipc-trace');
  const received = [];
  const server = await startFakeSupervisor(sock, (frame) => { received.push(frame); });
  try {
    const client = await connect(sock);
    const { trace_id } = await client.send({ kind: 'inject', sid: 'demo', data: 'x', trace_id: 'fixed-trace-001' });
    assert.equal(trace_id, 'fixed-trace-001');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(received[0].trace_id, 'fixed-trace-001');
    await client.close();
  } finally {
    await shutdownServer(server);
  }
});

test('request correlates pong by trace_id', { skip: SKIP_WIN }, async () => {
  const sock = mkSockPath('ipc-pong');
  const server = await startFakeSupervisor(sock, (frame, send) => {
    if (frame.kind === 'ping') send({ v: WIRE_VERSION, kind: 'pong', trace_id: frame.trace_id });
  });
  try {
    const client = await connect(sock);
    const reply = await client.request({ kind: 'ping' }, { timeoutMs: 500 });
    assert.equal(reply.kind, 'pong');
    assert.ok(typeof reply.trace_id === 'string');
    await client.close();
  } finally {
    await shutdownServer(server);
  }
});

test('request rejects ERR_TIMEOUT when no correlated reply arrives', { skip: SKIP_WIN }, async () => {
  const sock = mkSockPath('ipc-tout');
  const server = await startFakeSupervisor(sock, () => { /* silent */ });
  try {
    const client = await connect(sock);
    await assert.rejects(
      () => client.request({ kind: 'ping' }, { timeoutMs: 75 }),
      (err) => err instanceof BridgeClientError && err.code === 'ERR_TIMEOUT',
    );
    await client.close();
  } finally {
    await shutdownServer(server);
  }
});

test('request rejects with supervisor ERR_* code when error frame returned', { skip: SKIP_WIN }, async () => {
  const sock = mkSockPath('ipc-err');
  const server = await startFakeSupervisor(sock, (frame, send) => {
    send({
      v: WIRE_VERSION,
      kind: 'error',
      code: 'ERR_PERMISSION_DENIED',
      data: 'denied',
      trace_id: frame.trace_id,
    });
  });
  try {
    const client = await connect(sock);
    await assert.rejects(
      () => client.request({ kind: 'inject', sid: 'demo', data: 'x' }, { timeoutMs: 500 }),
      (err) => {
        assert.equal(err.code, 'ERR_PERMISSION_DENIED');
        assert.match(err.message, /denied/);
        assert.ok(err.frame && err.frame.kind === 'error');
        return true;
      },
    );
    await client.close();
  } finally {
    await shutdownServer(server);
  }
});

test('subscribe yields multiple output frames in order', { skip: SKIP_WIN }, async () => {
  const sock = mkSockPath('ipc-sub');
  let sendBack;
  const server = await startFakeSupervisor(sock, (frame, send) => {
    sendBack = send;
    if (frame.kind === 'inject') {
      // Server emits two output frames after the inject lands.
      send({ v: WIRE_VERSION, kind: 'output', sid: frame.sid, data: 'first', seq: 1 });
      send({ v: WIRE_VERSION, kind: 'output', sid: frame.sid, data: 'second', seq: 2 });
    }
  });
  try {
    const client = await connect(sock);
    await client.send({ kind: 'inject', sid: 'demo', data: 'hi' });
    const iter = client.subscribe({ sid: 'demo' });
    const collected = [];
    for await (const f of iter) {
      if (f.kind === 'output') collected.push(f);
      if (collected.length >= 2) break;
    }
    assert.equal(collected.length, 2);
    assert.equal(collected[0].data, 'first');
    assert.equal(collected[1].data, 'second');
    assert.equal(collected[0].seq, 1);
    await client.close();
    assert.ok(sendBack, 'server saw the inject');
  } finally {
    await shutdownServer(server);
  }
});

test('subscribe filters by sid mismatch but passes through frames lacking sid', { skip: SKIP_WIN }, async () => {
  const sock = mkSockPath('ipc-flt');
  const server = await startFakeSupervisor(sock, (frame, send) => {
    if (frame.kind === 'ping') {
      send({ v: WIRE_VERSION, kind: 'output', sid: 'other', data: 'dropped', seq: 1 });
      send({ v: WIRE_VERSION, kind: 'output', sid: 'mine', data: 'kept', seq: 2 });
      // pong has no sid → should pass through any sid filter
      send({ v: WIRE_VERSION, kind: 'pong', trace_id: frame.trace_id });
    }
  });
  try {
    const client = await connect(sock);
    const iter = client.subscribe({ sid: 'mine' });
    await client.send({ kind: 'ping' });
    const seen = [];
    for await (const f of iter) {
      seen.push(f);
      if (seen.length >= 2) break;
    }
    assert.equal(seen.length, 2);
    assert.deepEqual(seen.map((f) => f.kind).sort(), ['output', 'pong']);
    assert.ok(seen.find((f) => f.kind === 'output').data === 'kept');
    await client.close();
  } finally {
    await shutdownServer(server);
  }
});

test('subscribe AbortSignal cancels the iterator cleanly', { skip: SKIP_WIN }, async () => {
  const sock = mkSockPath('ipc-abrt');
  const server = await startFakeSupervisor(sock, () => {});
  try {
    const client = await connect(sock);
    const ac = new AbortController();
    const iter = client.subscribe({ signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    const collected = [];
    for await (const f of iter) collected.push(f);
    assert.equal(collected.length, 0);
    await client.close();
  } finally {
    await shutdownServer(server);
  }
});

test('subscribe ends when supervisor closes the connection', { skip: SKIP_WIN }, async () => {
  const sock = mkSockPath('ipc-end');
  const server = await startFakeSupervisor(sock, (_frame, _send, socket) => {
    socket.end();
  });
  try {
    const client = await connect(sock);
    const iter = client.subscribe();
    await client.send({ kind: 'ping' });
    const start = Date.now();
    const collected = [];
    for await (const f of iter) collected.push(f);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1000, `iterator should exit fast on server close (took ${elapsed}ms)`);
    assert.ok(client.isClosed());
  } finally {
    await shutdownServer(server);
  }
});

test('close rejects pending requests with ERR_SUPERVISOR_GONE', { skip: SKIP_WIN }, async () => {
  const sock = mkSockPath('ipc-cls');
  const server = await startFakeSupervisor(sock, () => {});
  try {
    const client = await connect(sock);
    const pending = client.request({ kind: 'ping' }, { timeoutMs: 5000 });
    setTimeout(() => client.close(), 20);
    await assert.rejects(
      () => pending,
      (err) => err instanceof BridgeClientError && err.code === 'ERR_SUPERVISOR_GONE',
    );
  } finally {
    await shutdownServer(server);
  }
});

test('close is idempotent', { skip: SKIP_WIN }, async () => {
  const sock = mkSockPath('ipc-idem');
  const server = await startFakeSupervisor(sock, () => {});
  try {
    const client = await connect(sock);
    await client.close();
    await client.close();
    assert.ok(client.isClosed());
  } finally {
    await shutdownServer(server);
  }
});

test('send/request after close reject with ERR_SUPERVISOR_GONE', { skip: SKIP_WIN }, async () => {
  const sock = mkSockPath('ipc-after');
  const server = await startFakeSupervisor(sock, () => {});
  try {
    const client = await connect(sock);
    await client.close();
    await assert.rejects(
      () => client.send({ kind: 'ping' }),
      (err) => err instanceof BridgeClientError && err.code === 'ERR_SUPERVISOR_GONE',
    );
    await assert.rejects(
      () => client.request({ kind: 'ping' }),
      (err) => err instanceof BridgeClientError && err.code === 'ERR_SUPERVISOR_GONE',
    );
  } finally {
    await shutdownServer(server);
  }
});

test('malformed line from server surfaces as synthetic ERR_BAD_FRAME', { skip: SKIP_WIN }, async () => {
  const sock = mkSockPath('ipc-mal');
  const server = await startFakeSupervisor(sock, (_frame, _send, socket) => {
    socket.write('not-json-at-all\n');
  });
  try {
    const client = await connect(sock);
    const iter = client.subscribe();
    await client.send({ kind: 'ping' });
    const first = await iter.next();
    assert.equal(first.done, false);
    assert.equal(first.value.kind, 'error');
    assert.equal(first.value.code, 'ERR_BAD_FRAME');
    await iter.return();
    await client.close();
  } finally {
    await shutdownServer(server);
  }
});

test('signal/kill/delete kinds auto-fill trace_id (B3 enforcement parity)', { skip: SKIP_WIN }, async () => {
  const sock = mkSockPath('ipc-b3');
  const received = [];
  const server = await startFakeSupervisor(sock, (frame) => { received.push(frame); });
  try {
    const client = await connect(sock);
    await client.send({ kind: 'signal', sid: 'demo', signal: 'SIGTERM' });
    await client.send({ kind: 'kill', sid: 'demo' });
    await client.send({ kind: 'delete', sid: 'demo' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(received.length, 3);
    for (const f of received) {
      assert.ok(typeof f.trace_id === 'string' && f.trace_id.length > 0,
        `expected auto-filled trace_id on ${f.kind}`);
    }
    await client.close();
  } finally {
    await shutdownServer(server);
  }
});
