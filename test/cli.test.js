'use strict';

const { afterEach, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const pty = require('node-pty');
const { createSessionId, startTestDaemon, stripAnsi, waitFor } = require('../test-support/daemon-harness');

let harness;
const projectRoot = path.resolve(__dirname, '..');
const TERMINAL_CLEANUP_SEQUENCE = '\x1b[<u\x1b[>4;0m\x1b[?2004l';

function countOccurrences(value, pattern) {
  let count = 0;
  let index = 0;

  while (true) {
    index = value.indexOf(pattern, index);
    if (index === -1) {
      return count;
    }
    count += 1;
    index += pattern.length;
  }
}

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

test('telepty allow restores terminal keyboard modes after the child exits', async () => {
  const sessionId = createSessionId('cli-allow-cleanup');
  const cli = pty.spawn(process.execPath, [
    'cli.js',
    'allow',
    '--id',
    sessionId,
    process.execPath,
    '-e',
    'process.stdout.write("\\u001b[>1u\\u001b[>4;2m\\u001b[?2004h"); setTimeout(() => process.exit(0), 50);'
  ], {
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
    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timed out waiting for allow session exit'));
      }, 8000);

      cli.onExit((info) => {
        clearTimeout(timer);
        resolve(info);
      });
    });

    assert.equal(exit.exitCode, 0);
    assert.ok(countOccurrences(output, TERMINAL_CLEANUP_SEQUENCE) >= 1, output);

    await waitFor(async () => {
      const list = await harness.request('/api/sessions');
      return list.status === 200 && !list.body.some((session) => session.id === sessionId);
    }, { description: 'wrapped session cleanup after interactive allow exit' });
  } finally {
    cli.kill();
  }
});

test('interactive update returns to the TUI instead of exiting', async () => {
  const cli = pty.spawn(process.execPath, ['cli.js'], {
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
      TELEPTY_DISABLE_UPDATE_NOTIFIER: '1',
      TELEPTY_SKIP_PACKAGE_UPDATE: '1',
      TELEPTY_SKIP_DAEMON_REPAIR: '1'
    }
  });

  let output = '';
  cli.onData((chunk) => {
    output += chunk;
  });

  try {
    await waitFor(() => stripAnsi(output).includes('What would you like to do?'), {
      timeoutMs: 7000,
      description: 'interactive menu prompt'
    });
    const initialPromptCount = stripAnsi(output).split('What would you like to do?').length - 1;

    cli.write('\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\r');

    await waitFor(() => stripAnsi(output).includes('Update complete! Restarting daemon...'), {
      timeoutMs: 7000,
      description: 'update completion message'
    });

    await waitFor(() => {
      const promptCount = stripAnsi(output).split('What would you like to do?').length - 1;
      return promptCount >= initialPromptCount + 1;
    }, {
      timeoutMs: 7000,
      description: 'menu prompt after update'
    });
  } finally {
    cli.kill();
  }
});

test('interactive menu recovers from a terminal EIO instead of crashing', async () => {
  const cli = pty.spawn(process.execPath, ['cli.js'], {
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
      TELEPTY_DISABLE_UPDATE_NOTIFIER: '1',
      TELEPTY_TEST_TRIGGER_PROMPT_EIO_ONCE: '1'
    }
  });

  let output = '';
  cli.onData((chunk) => {
    output += chunk;
  });

  try {
    await waitFor(() => {
      const normalized = stripAnsi(output);
      return normalized.includes('Terminal input was interrupted. Returning to the telepty menu...')
        && normalized.split('What would you like to do?').length - 1 >= 1;
    }, {
      timeoutMs: 7000,
      description: 'menu recovery after terminal EIO'
    });
  } finally {
    cli.kill();
  }
});
