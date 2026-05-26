'use strict';

// 0.3.3 — `inject --submit-force` and idempotent `--submit-retry` coverage.
// Spec: docs/superpowers/specs/2026-05-02-submit-force-and-retry.md
//
// Uses a mock HTTP daemon so the test fully controls /submit responses
// (programmable status + reason). The real daemon never returns a
// gated_dispatch_unconsumed 504 for a healthy session, so we cannot
// exercise the retry loop end-to-end against `startTestDaemon`.

const { afterEach, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const pkg = require(path.join(projectRoot, 'package.json'));

let counter = 0;

function createMockId(prefix = 'mock') {
  counter += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${counter}`;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => { buf += chunk; });
    req.on('end', () => {
      if (!buf) return resolve(null);
      try {
        resolve(JSON.parse(buf));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function startMockDaemon({ sessionId, submitHandler }) {
  const submitCalls = [];
  const injectCalls = [];

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url || '';
    const method = req.method || 'GET';

    if (method === 'GET' && url === '/api/meta') {
      res.statusCode = 200;
      res.end(JSON.stringify({ version: pkg.version, capabilities: [] }));
      return;
    }

    if (method === 'GET' && url.startsWith('/api/sessions') && !url.includes('/inject') && !url.includes('/submit') && !url.includes('/screen')) {
      res.statusCode = 200;
      res.end(JSON.stringify([{
        id: sessionId,
        host: '127.0.0.1',
        command: 'mock',
        cwd: '/tmp',
        pid: 1234,
        active_clients: 1,
        backend: 'pty',
      }]));
      return;
    }

    if (method === 'POST' && url.includes('/inject')) {
      const body = await readJsonBody(req).catch(() => null);
      injectCalls.push({ url, body });
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, written: true }));
      return;
    }

    if (method === 'POST' && url.includes('/submit')) {
      const body = await readJsonBody(req).catch(() => null);
      submitCalls.push({ url, body });
      const next = submitHandler(submitCalls.length, body);
      res.statusCode = next.status;
      res.end(JSON.stringify(next.payload));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found', url }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        submitCalls,
        injectCalls,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function createTempHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-flagtest-home-'));
  // Pre-bake auth config so cli.js's getConfig() doesn't bother writing one.
  fs.mkdirSync(path.join(homeDir, '.telepty'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(homeDir, '.telepty', 'config.json'),
    JSON.stringify({ authToken: 'mock-token-for-tests', createdAt: new Date().toISOString() }),
    { mode: 0o600 }
  );
  return homeDir;
}

function runCli(args, { homeDir, port, timeoutMs = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    const cli = spawn(process.execPath, ['cli.js', ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        TELEPTY_HOST: '127.0.0.1',
        TELEPTY_PORT: String(port),
        NO_UPDATE_NOTIFIER: '1',
        TELEPTY_DISABLE_UPDATE_NOTIFIER: '1',
        TELEPTY_SKIP_PACKAGE_UPDATE: '1',
        TELEPTY_SKIP_DAEMON_REPAIR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      cli.kill('SIGKILL');
    }, timeoutMs);

    cli.stdout.on('data', (c) => { stdout += c.toString(); });
    cli.stderr.on('data', (c) => { stderr += c.toString(); });
    cli.on('error', (e) => { clearTimeout(timer); reject(e); });
    cli.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`CLI timed out.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

let homeDir;

beforeEach(() => {
  homeDir = createTempHome();
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// --submit-force
// ---------------------------------------------------------------------------

test('telepty inject --submit --submit-force passes force=true to /submit', async () => {
  const sessionId = createMockId('force');
  const mock = await startMockDaemon({
    sessionId,
    submitHandler: () => ({
      status: 200,
      payload: {
        success: true,
        strategy: 'pty_cr',
        attempts: 1,
        gated: false,
        forced: true,
      },
    }),
  });

  try {
    const result = await runCli(
      ['inject', '--submit', '--submit-force', sessionId, 'forced-payload'],
      { homeDir, port: mock.port }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(mock.submitCalls.length, 1);
    assert.equal(mock.submitCalls[0].body.force, true);
    assert.equal(mock.submitCalls[0].body.injected_body, 'forced-payload');
    // Success line should reflect [forced] tag.
    assert.match(result.stdout, /Submitted via pty_cr/);
    assert.match(result.stdout, /\[forced\]/);
  } finally {
    await mock.close();
  }
});

test('telepty inject --submit (no force) does NOT include force in /submit body', async () => {
  // Env-resistant: TELEPTY_SUBMIT_FORCE_DEFAULT=1 in the host shell would
  // flip the CLI default to force and break this test's intent. Pin it off
  // for the test scope only.
  const priorForceDefault = process.env.TELEPTY_SUBMIT_FORCE_DEFAULT;
  process.env.TELEPTY_SUBMIT_FORCE_DEFAULT = '0';
  const sessionId = createMockId('noforce');
  const mock = await startMockDaemon({
    sessionId,
    submitHandler: () => ({
      status: 200,
      payload: {
        success: true,
        strategy: 'pty_cr',
        attempts: 1,
        gated: true,
        gate_wait_ms: 0,
      },
    }),
  });

  try {
    const result = await runCli(
      ['inject', '--submit', sessionId, 'plain-payload'],
      { homeDir, port: mock.port }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(mock.submitCalls.length, 1);
    assert.equal(mock.submitCalls[0].body.force, undefined);
  } finally {
    await mock.close();
    if (priorForceDefault === undefined) {
      delete process.env.TELEPTY_SUBMIT_FORCE_DEFAULT;
    } else {
      process.env.TELEPTY_SUBMIT_FORCE_DEFAULT = priorForceDefault;
    }
  }
});

// ---------------------------------------------------------------------------
// --submit-retry — idempotent retry on safe-reason 504
// ---------------------------------------------------------------------------

test('telepty inject --submit retries once by default on gated_dispatch_unconsumed 504', async () => {
  const sessionId = createMockId('retry-default');
  const mock = await startMockDaemon({
    sessionId,
    submitHandler: (callIndex) => {
      if (callIndex === 1) {
        return {
          status: 504,
          payload: {
            error: 'gate timeout',
            reason: 'gated_dispatch_unconsumed',
            last_state: 'idle',
            verify: { consumed: false },
          },
        };
      }
      return {
        status: 200,
        payload: { success: true, strategy: 'kitty_send_text', attempts: 1, gated: true, gate_wait_ms: 0 },
      };
    },
  });

  try {
    const result = await runCli(
      ['inject', '--submit', sessionId, 'recovers-on-retry'],
      { homeDir, port: mock.port }
    );
    assert.equal(result.code, 0, result.stderr);
    // Default --submit-retry is 1 → exactly 2 /submit calls.
    assert.equal(mock.submitCalls.length, 2);
    assert.match(result.stdout, /\[retry 1\/1\]/);
  } finally {
    await mock.close();
  }
});

test('telepty inject --submit-retry 2 retries up to 3 times then gives up cleanly', async () => {
  const sessionId = createMockId('retry-exhaust');
  const mock = await startMockDaemon({
    sessionId,
    submitHandler: () => ({
      status: 504,
      payload: {
        error: 'gate timeout',
        reason: 'gated_dispatch_unconsumed',
        last_state: 'idle',
        verify: { consumed: false },
      },
    }),
  });

  try {
    const result = await runCli(
      ['inject', '--submit', '--submit-retry', '2', sessionId, 'always-504'],
      { homeDir, port: mock.port }
    );
    // Soft failure: prints warning but exits 0.
    assert.equal(result.code, 0, result.stderr);
    assert.equal(mock.submitCalls.length, 3); // 1 initial + 2 retries
    assert.match(result.stdout, /Submit gated-timeout/);
    assert.match(result.stdout, /after 3 attempts/);
  } finally {
    await mock.close();
  }
});

test('telepty inject --submit-retry 0 does NOT retry on a safe-reason 504', async () => {
  const sessionId = createMockId('retry-zero');
  const mock = await startMockDaemon({
    sessionId,
    submitHandler: () => ({
      status: 504,
      payload: { reason: 'gated_dispatch_unconsumed', last_state: 'idle', verify: { consumed: false } },
    }),
  });

  try {
    const result = await runCli(
      ['inject', '--submit', '--submit-retry', '0', sessionId, 'no-retry'],
      { homeDir, port: mock.port }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(mock.submitCalls.length, 1);
    assert.match(result.stdout, /Submit gated-timeout/);
    assert.doesNotMatch(result.stdout, /\[retry/);
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// Hard-fail reasons must NOT trigger client-side retry
// ---------------------------------------------------------------------------

test('telepty inject --submit does NOT retry on session_dead 504', async () => {
  const sessionId = createMockId('hardfail-dead');
  const mock = await startMockDaemon({
    sessionId,
    submitHandler: () => ({
      status: 504,
      payload: { reason: 'session_dead', last_state: 'dead' },
    }),
  });

  try {
    const result = await runCli(
      ['inject', '--submit', '--submit-retry', '3', sessionId, 'dead-target'],
      { homeDir, port: mock.port }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(mock.submitCalls.length, 1);
    assert.match(result.stdout, /session_dead/);
  } finally {
    await mock.close();
  }
});

test('telepty inject --submit does NOT retry on no_state 504', async () => {
  const sessionId = createMockId('hardfail-nostate');
  const mock = await startMockDaemon({
    sessionId,
    submitHandler: () => ({
      status: 504,
      payload: { reason: 'no_state', last_state: null },
    }),
  });

  try {
    const result = await runCli(
      ['inject', '--submit', '--submit-retry', '3', sessionId, 'no-state-target'],
      { homeDir, port: mock.port }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(mock.submitCalls.length, 1);
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// Composability — --submit-force + --submit-retry
// ---------------------------------------------------------------------------

test('telepty inject --submit --submit-force --submit-retry preserves force on retries', async () => {
  const sessionId = createMockId('force-retry');
  const mock = await startMockDaemon({
    sessionId,
    submitHandler: (callIndex) => {
      if (callIndex === 1) {
        // Force never produces a gated 504 in real daemon, but the client
        // must not strip force on retry — verify by simulating a 504
        // (artificial) and asserting force=true on attempt 2.
        return {
          status: 504,
          payload: { reason: 'gated_dispatch_unconsumed', last_state: 'idle', verify: { consumed: false } },
        };
      }
      return { status: 200, payload: { success: true, strategy: 'pty_cr', attempts: 1, gated: false, forced: true } };
    },
  });

  try {
    const result = await runCli(
      ['inject', '--submit', '--submit-force', '--submit-retry', '2', sessionId, 'force-with-retry'],
      { homeDir, port: mock.port }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(mock.submitCalls.length, 2);
    assert.equal(mock.submitCalls[0].body.force, true);
    assert.equal(mock.submitCalls[1].body.force, true);
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// Non-504 errors are not retried
// ---------------------------------------------------------------------------

test('telepty inject --submit does NOT retry on 500 error', async () => {
  const sessionId = createMockId('500');
  const mock = await startMockDaemon({
    sessionId,
    submitHandler: () => ({
      status: 500,
      payload: { error: 'internal' },
    }),
  });

  try {
    const result = await runCli(
      ['inject', '--submit', '--submit-retry', '3', sessionId, 'server-error'],
      { homeDir, port: mock.port }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(mock.submitCalls.length, 1);
    assert.match(result.stderr, /Submit failed/);
  } finally {
    await mock.close();
  }
});
