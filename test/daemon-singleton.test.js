'use strict';

const { afterEach, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('events');
const path = require('path');
const { spawn } = require('child_process');

const { delay, startTestDaemon } = require('../test-support/daemon-harness');

const projectRoot = path.resolve(__dirname, '..');

let harness;

beforeEach(async () => {
  harness = await startTestDaemon();
});

afterEach(async () => {
  await harness.stop();
});

test('daemon exits when another local telepty daemon already owns the singleton lock', async () => {
  const secondPort = harness.port + 1;
  const child = spawn(process.execPath, ['daemon.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: harness.homeDir,
      USERPROFILE: harness.homeDir,
      PORT: String(secondPort),
      HOST: harness.host,
      NO_UPDATE_NOTIFIER: '1',
      TELEPTY_DISABLE_UPDATE_NOTIFIER: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const exit = await Promise.race([
    once(child, 'exit'),
    delay(5000).then(() => {
      throw new Error(`Second daemon did not exit.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    })
  ]);

  assert.match(`${stdout}\n${stderr}`, /already running/i);
  assert.equal(harness.isAlive(), true, harness.getLogs().stderr || harness.getLogs().stdout);

  const meta = await harness.request('/api/meta');
  assert.equal(meta.status, 200);
  assert.equal(meta.body.port, harness.port);
});
