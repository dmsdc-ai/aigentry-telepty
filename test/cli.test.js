'use strict';

const { afterEach, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const pty = require('node-pty');
const { createSessionId, startTestDaemon, stripAnsi, waitFor } = require('../test-support/daemon-harness');

let harness;
const projectRoot = path.resolve(__dirname, '..');

function collectJsonMessages(ws) {
  const messages = [];
  ws.on('message', (chunk) => {
    try {
      messages.push(JSON.parse(chunk.toString()));
    } catch {
      // Ignore malformed payloads in tests.
    }
  });
  return messages;
}

beforeEach(async () => {
  harness = await startTestDaemon();
});

afterEach(async () => {
  await harness.stop();
});

test('telepty list prints active sessions from the configured host and port', async () => {
  const sessionId = createSessionId('cli-list');
  await harness.spawnSession(sessionId);

  const result = await harness.runCli(['list']);
  assert.equal(result.code, 0, result.stderr);

  const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
  assert.match(output, new RegExp(sessionId));
  assert.match(output, /Active Sessions/i);
});

test('telepty inject forwards input to the target PTY session', async () => {
  const sessionId = createSessionId('cli-inject');
  await harness.spawnSession(sessionId);

  const ws = await harness.connectSession(sessionId);
  const outputs = collectJsonMessages(ws);
  const token = createSessionId('cli-token');

  const result = await harness.runCli(['inject', sessionId, `echo ${token}`]);
  assert.equal(result.code, 0, result.stderr);

  await waitFor(() => outputs.some((message) => (
    message.type === 'output' && String(message.data).includes(token)
  )), { timeoutMs: 7000, description: 'CLI inject output' });

  ws.close();
});

test('telepty attach resumes stdin after session selection and forwards room input', async () => {
  const sessionId = createSessionId('cli-attach');
  await harness.spawnSession(sessionId);

  const cli = pty.spawn(process.execPath, ['cli.js', 'attach'], {
    cwd: projectRoot,
    cols: 80,
    rows: 24,
    name: process.platform === 'win32' ? 'xterm' : 'xterm-256color',
    env: {
      ...process.env,
      HOME: harness.homeDir,
      USERPROFILE: harness.homeDir,
      TELEPTY_HOST: harness.host,
      TELEPTY_PORT: String(harness.port),
      NO_UPDATE_NOTIFIER: '1',
      TELEPTY_DISABLE_UPDATE_NOTIFIER: '1'
    }
  });

  let output = '';
  cli.onData((chunk) => {
    output += chunk;
  });

  try {
    await waitFor(() => stripAnsi(output).includes('Select a session number to attach:'), {
      timeoutMs: 7000,
      description: 'attach selection prompt'
    });

    cli.write('1\r');

    await waitFor(() => stripAnsi(output).includes(`Entered room '${sessionId}'`), {
      timeoutMs: 7000,
      description: 'attach room entry'
    });

    const token = createSessionId('attach-token');
    cli.write(`echo ${token}\r`);

    await waitFor(() => stripAnsi(output).includes(token), {
      timeoutMs: 7000,
      description: 'attach input echoed through room'
    });
  } finally {
    cli.kill();
  }
});

test('telepty allow works without a TTY by using fallback terminal dimensions', async () => {
  const sessionId = createSessionId('cli-allow-no-tty');
  const result = await harness.runCli([
    'allow',
    '--id',
    sessionId,
    process.execPath,
    '-e',
    'console.log("allow-ok")'
  ], {
    env: {
      COLUMNS: '120',
      LINES: '40'
    },
    timeoutMs: 8000
  });

  assert.equal(result.code, 0, result.stderr);
  const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
  assert.match(output, /allow-ok/);

  await waitFor(async () => {
    const list = await harness.request('/api/sessions');
    return list.status === 200 && !list.body.some((session) => session.id === sessionId);
  }, { description: 'wrapped session cleanup after non-interactive allow' });
});
