'use strict';
// @ts-check

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { spawn } = require('child_process');

const projectRoot = path.resolve(__dirname, '../..');
const host = '127.0.0.1';
/** @type {{ child: import('child_process').ChildProcess, homeDir: string }[]} */
const children = [];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-cli-daemon-'));
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host }, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected an ephemeral TCP port');
  }

  const { port } = address;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

function probeHttpAccept(port) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = http.request({
      hostname: host,
      port,
      method: 'GET',
      path: `/__telepty_bind_probe_${Date.now()}`,
      timeout: 250
    }, (res) => {
      res.resume();
      settle(true);
    });

    req.on('timeout', () => {
      req.destroy();
      settle(false);
    });
    req.on('error', () => settle(false));
    req.end();
  });
}

async function waitForHttpAccept(child, port, getLogs, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const { stdout, stderr } = getLogs();
      throw new Error(`CLI-launched daemon exited before binding port ${port}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }

    if (await probeHttpAccept(port)) {
      return;
    }

    await delay(50);
  }

  const { stdout, stderr } = getLogs();
  throw new Error(`Timed out waiting for CLI-launched daemon to bind port ${port}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;

  child.kill('SIGTERM');
  const exited = await Promise.race([
    once(child, 'exit').then(() => true),
    delay(2000).then(() => false)
  ]);

  if (!exited && child.exitCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit').catch(() => {});
  }
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(({ child, homeDir }) => stopChild(child)
    .finally(() => fs.rmSync(homeDir, { recursive: true, force: true }))));
});

test('real CLI daemon command binds an HTTP port', async () => {
  const port = await getFreePort();
  const homeDir = createTempHome();
  let stdout = '';
  let stderr = '';

  const child = spawn(process.execPath, ['cli.js', 'daemon'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      HOST: host,
      PORT: String(port),
      NO_UPDATE_NOTIFIER: '1',
      TELEPTY_DISABLE_UPDATE_NOTIFIER: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.push({ child, homeDir });

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  await waitForHttpAccept(child, port, () => ({ stdout, stderr }));

  assert.equal(child.exitCode, null);
});
