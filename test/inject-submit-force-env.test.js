'use strict';

// TELEPTY_SUBMIT_FORCE_DEFAULT coverage for task #453.
// Uses a mock HTTP daemon so the CLI-side flag/env parsing is isolated from
// daemon submit-gate behavior.

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
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-envtest-home-'));
  fs.mkdirSync(path.join(homeDir, '.telepty'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(homeDir, '.telepty', 'config.json'),
    JSON.stringify({ authToken: 'mock-token-for-tests', createdAt: new Date().toISOString() }),
    { mode: 0o600 }
  );
  return homeDir;
}

function runCli(args, { homeDir, port, env = {}, timeoutMs = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      TELEPTY_HOST: '127.0.0.1',
      TELEPTY_PORT: String(port),
      NO_UPDATE_NOTIFIER: '1',
      TELEPTY_DISABLE_UPDATE_NOTIFIER: '1',
      TELEPTY_SKIP_PACKAGE_UPDATE: '1',
      TELEPTY_SKIP_DAEMON_REPAIR: '1',
      ...env,
    };
    if (!Object.prototype.hasOwnProperty.call(env, 'TELEPTY_SUBMIT_FORCE_DEFAULT')) {
      delete childEnv.TELEPTY_SUBMIT_FORCE_DEFAULT;
    }

    const cli = spawn(process.execPath, ['cli.js', ...args], {
      cwd: projectRoot,
      env: childEnv,
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

async function runSubmitCase({ envValue, args = [], payload = 'payload', submitHandler }) {
  const sessionId = createMockId('env-force');
  const mock = await startMockDaemon({
    sessionId,
    submitHandler: submitHandler || (() => ({
      status: 200,
      payload: { success: true, strategy: 'pty_cr', attempts: 1, gated: false, forced: true },
    })),
  });

  try {
    const env = {};
    if (envValue !== undefined) {
      env.TELEPTY_SUBMIT_FORCE_DEFAULT = envValue;
    }
    const result = await runCli(
      ['inject', '--submit', ...args, sessionId, payload],
      { homeDir, port: mock.port, env }
    );
    return { result, mock };
  } catch (error) {
    await mock.close();
    throw error;
  }
}

let homeDir;

beforeEach(() => {
  homeDir = createTempHome();
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

test('TELEPTY_SUBMIT_FORCE_DEFAULT unset/0/off preserves gated submit behavior', async () => {
  for (const envValue of [undefined, '0', 'off']) {
    const { result, mock } = await runSubmitCase({
      envValue,
      payload: `plain-${envValue || 'unset'}`,
      submitHandler: () => ({
        status: 504,
        payload: { reason: 'bootstrap_not_ready', last_state: 'working' },
      }),
    });

    try {
      assert.equal(result.code, 0, result.stderr);
      assert.equal(mock.submitCalls.length, 1);
      assert.equal(mock.submitCalls[0].body.force, undefined);
      assert.match(result.stdout, /Submit gated-timeout/);
      assert.match(result.stdout, /--submit-force/);
      assert.doesNotMatch(result.stderr, /submit-force=env-default/);
    } finally {
      await mock.close();
    }
  }
});

test('TELEPTY_SUBMIT_FORCE_DEFAULT=1 applies force without --submit-force', async () => {
  const { result, mock } = await runSubmitCase({ envValue: '1', payload: 'env-forced' });

  try {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(mock.submitCalls.length, 1);
    assert.equal(mock.submitCalls[0].body.force, true);
    assert.equal(mock.submitCalls[0].body.injected_body, 'env-forced');
    assert.match(result.stderr, /\[telepty inject\] submit-force=env-default \(TELEPTY_SUBMIT_FORCE_DEFAULT=1\)/);
  } finally {
    await mock.close();
  }
});

test('TELEPTY_SUBMIT_FORCE_DEFAULT=1 with --no-submit-force preserves gated behavior', async () => {
  const { result, mock } = await runSubmitCase({
    envValue: '1',
    args: ['--no-submit-force'],
    payload: 'no-force',
    submitHandler: () => ({
      status: 504,
      payload: { reason: 'bootstrap_not_ready', last_state: 'working' },
    }),
  });

  try {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(mock.submitCalls.length, 1);
    assert.equal(mock.submitCalls[0].body.force, undefined);
    assert.match(result.stdout, /Submit gated-timeout/);
    assert.match(result.stdout, /--submit-force/);
    assert.doesNotMatch(result.stderr, /submit-force=env-default/);
  } finally {
    await mock.close();
  }
});

test('TELEPTY_SUBMIT_FORCE_DEFAULT=1 with explicit --submit-force remains forced', async () => {
  const { result, mock } = await runSubmitCase({
    envValue: '1',
    args: ['--submit-force'],
    payload: 'explicit-force',
  });

  try {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(mock.submitCalls.length, 1);
    assert.equal(mock.submitCalls[0].body.force, true);
    assert.doesNotMatch(result.stderr, /submit-force=env-default/);
  } finally {
    await mock.close();
  }
});

test('TELEPTY_SUBMIT_FORCE_DEFAULT normalization is safe for TRUE/yes/2', async () => {
  for (const [envValue, expectedForce] of [['TRUE', true], ['yes', true], ['2', false]]) {
    const { result, mock } = await runSubmitCase({
      envValue,
      payload: `normalized-${envValue}`,
      submitHandler: () => ({
        status: 200,
        payload: { success: true, strategy: 'pty_cr', attempts: 1, gated: !expectedForce, forced: expectedForce },
      }),
    });

    try {
      assert.equal(result.code, 0, result.stderr);
      assert.equal(mock.submitCalls.length, 1);
      assert.equal(mock.submitCalls[0].body.force, expectedForce ? true : undefined);
    } finally {
      await mock.close();
    }
  }
});
