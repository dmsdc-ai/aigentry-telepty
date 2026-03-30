'use strict';

const { afterEach, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const pty = require('node-pty');
const { buildSharedContextPrompt, createSharedContextDescriptor, getSharedContextDir } = require('../shared-context');
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

function createSubmitCaptureScript() {
  return [
    "process.stdin.setEncoding('utf8');",
    "let buffer='';",
    "process.stdin.resume();",
    "process.stdout.write('> ');",
    "process.stdin.on('data', (chunk) => {",
    "  for (const ch of chunk) {",
    "    if (ch === '\\r' || ch === '\\n') {",
    "      process.stdout.write(`\\nSUBMIT:${buffer}\\n`);",
    "      process.exit(0);",
    "      return;",
    "    }",
    "    buffer += ch;",
    "  }",
    "});"
  ].join(' ');
}

beforeEach(async () => {
  harness = await startTestDaemon();
});

afterEach(async () => {
  await harness.stop();
});

test('telepty list prints active sessions from the configured host and port', async () => {
  const sessionId = createSessionId('cli-list');
  await harness.registerSession(sessionId, {
    term_program: 'kitty',
    term: 'xterm-kitty'
  });

  const result = await harness.runCli(['list']);
  assert.equal(result.code, 0, result.stderr);

  const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
  assert.match(output, new RegExp(sessionId));
  assert.match(output, /Active Sessions/i);
  assert.match(output, /Status: DISCONNECTED \(OWNER_DISCONNECTED\)/i);
  assert.match(output, /Terminal: kitty \(xterm-kitty\)/i);
});

test('telepty list --json includes terminal metadata', async () => {
  const sessionId = createSessionId('cli-list-json');
  await harness.registerSession(sessionId, {
    term_program: 'ghostty',
    term: 'xterm-256color'
  });

  const result = await harness.runCli(['list', '--json']);
  assert.equal(result.code, 0, result.stderr);

  const parsed = JSON.parse(result.stdout);
  const session = parsed.find((item) => item.id === sessionId);
  assert.equal(session.termProgram, 'ghostty');
  assert.equal(session.term, 'xterm-256color');
  assert.equal(session.terminal, 'ghostty');
  assert.equal(session.healthStatus, 'DISCONNECTED');
  assert.equal(session.healthReason, 'OWNER_DISCONNECTED');
  assert.equal(session.transport.health_status, 'DISCONNECTED');
  assert.equal(session.semantic, null);
});

test('telepty session info prints terminal metadata', async () => {
  const sessionId = createSessionId('cli-session-info');
  await harness.registerSession(sessionId, {
    term_program: 'Apple_Terminal',
    term: 'xterm-256color'
  });

  const result = await harness.runCli(['session', 'info', sessionId]);
  assert.equal(result.code, 0, result.stderr);

  const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
  assert.match(output, /Session Info/i);
  assert.match(output, /Status: DISCONNECTED \(OWNER_DISCONNECTED\)/i);
  assert.match(output, /Terminal: Apple_Terminal/i);
  assert.match(output, /TERM: xterm-256color/i);
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

test('telepty inject accepts an explicit empty string and submits enter only', async () => {
  const sessionId = createSessionId('cli-inject-empty');
  await harness.spawnSession(sessionId, {
    command: process.execPath,
    args: ['-e', createSubmitCaptureScript()]
  });

  const ws = await harness.connectSession(sessionId);
  const outputs = collectJsonMessages(ws);

  const result = await harness.runCli(['inject', sessionId, ''], { timeoutMs: 8000 });
  assert.equal(result.code, 0, result.stderr);

  await waitFor(() => outputs.some((message) => (
    message.type === 'output' && String(message.data).includes('SUBMIT:')
  )), { timeoutMs: 7000, description: 'CLI empty inject submit output' });

  const normalized = outputs
    .filter((message) => message.type === 'output')
    .map((message) => String(message.data))
    .join('');
  assert.equal(countOccurrences(normalized, 'SUBMIT:'), 1);

  ws.close();
});

test('telepty inject rejects --no-enter and points users to telepty enter', async () => {
  const sessionId = createSessionId('cli-inject-no-enter');
  await harness.spawnSession(sessionId);

  const result = await harness.runCli(['inject', '--no-enter', sessionId, 'echo blocked']);
  assert.equal(result.code, 1);

  const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
  assert.match(output, /always submits after text/i);
  assert.match(output, /telepty enter/i);
});

test('telepty enter sends an enter-only submission to the target session', async () => {
  const sessionId = createSessionId('cli-enter');
  await harness.spawnSession(sessionId, {
    command: process.execPath,
    args: ['-e', createSubmitCaptureScript()]
  });

  const ws = await harness.connectSession(sessionId);
  const outputs = collectJsonMessages(ws);

  const result = await harness.runCli(['enter', sessionId], { timeoutMs: 8000 });
  assert.equal(result.code, 0, result.stderr);

  await waitFor(() => outputs.some((message) => (
    message.type === 'output' && String(message.data).includes('SUBMIT:')
  )), { timeoutMs: 7000, description: 'CLI enter submit output' });

  const normalized = outputs
    .filter((message) => message.type === 'output')
    .map((message) => String(message.data))
    .join('');
  assert.equal(countOccurrences(normalized, 'SUBMIT:'), 1);

  ws.close();
});

test('telepty inject --ref stores the payload in shared context and injects only the pointer prompt', async () => {
  const sessionId = createSessionId('cli-inject-ref');
  await harness.spawnSession(sessionId, {
    command: process.execPath,
    args: ['-e', createSubmitCaptureScript()]
  });

  const ws = await harness.connectSession(sessionId);
  const outputs = collectJsonMessages(ws);
  const rawToken = createSessionId('ref-payload');
  const context = `## Context\n\n${rawToken}\n\nKeep this out of stdin.`;
  const descriptor = createSharedContextDescriptor(context);
  const expectedPrompt = buildSharedContextPrompt(descriptor);
  const sharedPath = path.join(getSharedContextDir(harness.homeDir), descriptor.fileName);

  const result = await harness.runCli(['inject', '--ref', sessionId, context], { timeoutMs: 8000 });
  assert.equal(result.code, 0, result.stderr);

  await waitFor(() => outputs.some((message) => (
    message.type === 'output' && String(message.data).includes(`SUBMIT:${expectedPrompt}`)
  )), { timeoutMs: 7000, description: 'CLI inject ref output' });

  const combinedOutput = outputs
    .filter((message) => message.type === 'output')
    .map((message) => String(message.data))
    .join('');

  assert.equal(combinedOutput.includes(rawToken), false);
  assert.equal(fs.readFileSync(sharedPath, 'utf8'), context);

  ws.close();
});

test('telepty inject --ref <file> stores file contents and appends the message after the pointer', async () => {
  const sessionId = createSessionId('cli-inject-ref-file');
  await harness.spawnSession(sessionId, {
    command: process.execPath,
    args: ['-e', createSubmitCaptureScript()]
  });

  const ws = await harness.connectSession(sessionId);
  const outputs = collectJsonMessages(ws);
  const rawToken = createSessionId('file-ref-payload');
  const fileContent = `# Spec\n\n${rawToken}\n\nUse this file as the source context.\n`;
  const filePath = path.join(harness.homeDir, 'spec.md');
  const message = 'Implement from this shared spec.';
  fs.writeFileSync(filePath, fileContent);

  const descriptor = createSharedContextDescriptor(fileContent);
  const expectedPrompt = `${buildSharedContextPrompt(descriptor)} ${message}`;
  const sharedPath = path.join(getSharedContextDir(harness.homeDir), descriptor.fileName);

  const result = await harness.runCli(['inject', '--ref', filePath, '--from', 'orch', sessionId, message], { timeoutMs: 8000 });
  assert.equal(result.code, 0, result.stderr);

  await waitFor(() => outputs.some((messageChunk) => (
    messageChunk.type === 'output' && String(messageChunk.data).includes(`SUBMIT:${expectedPrompt}`)
  )), { timeoutMs: 7000, description: 'CLI inject ref file output' });

  const combinedOutput = outputs
    .filter((messageChunk) => messageChunk.type === 'output')
    .map((messageChunk) => String(messageChunk.data))
    .join('');

  assert.equal(combinedOutput.includes(rawToken), false);
  assert.equal(fs.readFileSync(sharedPath, 'utf8'), fileContent);

  ws.close();
});

test('telepty broadcast --ref reuses one shared context file for all local sessions', async () => {
  const sessionIdA = createSessionId('cli-broadcast-ref-a');
  const sessionIdB = createSessionId('cli-broadcast-ref-b');
  const childArgs = ['-e', createSubmitCaptureScript()];
  await harness.spawnSession(sessionIdA, { command: process.execPath, args: childArgs });
  await harness.spawnSession(sessionIdB, { command: process.execPath, args: childArgs });

  const wsA = await harness.connectSession(sessionIdA);
  const wsB = await harness.connectSession(sessionIdB);
  const outputsA = collectJsonMessages(wsA);
  const outputsB = collectJsonMessages(wsB);
  const rawToken = createSessionId('broadcast-ref-payload');
  const context = `Shared context ${rawToken}\nSecond line`;
  const descriptor = createSharedContextDescriptor(context);
  const expectedPrompt = buildSharedContextPrompt(descriptor);
  const sharedDir = getSharedContextDir(harness.homeDir);
  const sharedPath = path.join(sharedDir, descriptor.fileName);

  const result = await harness.runCli(['broadcast', '--ref', context], { timeoutMs: 8000 });
  assert.equal(result.code, 0, result.stderr);

  await waitFor(() => outputsA.some((message) => (
    message.type === 'output' && String(message.data).includes(`SUBMIT:${expectedPrompt}`)
  )), { timeoutMs: 7000, description: 'broadcast ref output A' });

  await waitFor(() => outputsB.some((message) => (
    message.type === 'output' && String(message.data).includes(`SUBMIT:${expectedPrompt}`)
  )), { timeoutMs: 7000, description: 'broadcast ref output B' });

  const combinedA = outputsA.filter((message) => message.type === 'output').map((message) => String(message.data)).join('');
  const combinedB = outputsB.filter((message) => message.type === 'output').map((message) => String(message.data)).join('');
  assert.equal(combinedA.includes(rawToken), false);
  assert.equal(combinedB.includes(rawToken), false);
  assert.equal(fs.readFileSync(sharedPath, 'utf8'), context);
  assert.deepEqual(fs.readdirSync(sharedDir).filter((name) => name.endsWith('.md')).sort(), [descriptor.fileName]);

  wsA.close();
  wsB.close();
});

test('telepty broadcast --ref <file> reuses one shared file and appends the message for every local session', async () => {
  const sessionIdA = createSessionId('cli-broadcast-ref-file-a');
  const sessionIdB = createSessionId('cli-broadcast-ref-file-b');
  const childArgs = ['-e', createSubmitCaptureScript()];
  await harness.spawnSession(sessionIdA, { command: process.execPath, args: childArgs });
  await harness.spawnSession(sessionIdB, { command: process.execPath, args: childArgs });

  const wsA = await harness.connectSession(sessionIdA);
  const wsB = await harness.connectSession(sessionIdB);
  const outputsA = collectJsonMessages(wsA);
  const outputsB = collectJsonMessages(wsB);
  const rawToken = createSessionId('broadcast-file-ref-payload');
  const fileContent = `Shared file context ${rawToken}\nLine 2\n`;
  const filePath = path.join(harness.homeDir, 'broadcast-spec.md');
  const message = 'Review using the shared file reference.';
  fs.writeFileSync(filePath, fileContent);

  const descriptor = createSharedContextDescriptor(fileContent);
  const expectedPrompt = `${buildSharedContextPrompt(descriptor)} ${message}`;
  const sharedDir = getSharedContextDir(harness.homeDir);
  const sharedPath = path.join(sharedDir, descriptor.fileName);

  const result = await harness.runCli(['broadcast', '--ref', filePath, message], { timeoutMs: 8000 });
  assert.equal(result.code, 0, result.stderr);

  await waitFor(() => outputsA.some((messageChunk) => (
    messageChunk.type === 'output' && String(messageChunk.data).includes(`SUBMIT:${expectedPrompt}`)
  )), { timeoutMs: 7000, description: 'broadcast ref file output A' });

  await waitFor(() => outputsB.some((messageChunk) => (
    messageChunk.type === 'output' && String(messageChunk.data).includes(`SUBMIT:${expectedPrompt}`)
  )), { timeoutMs: 7000, description: 'broadcast ref file output B' });

  const combinedA = outputsA.filter((messageChunk) => messageChunk.type === 'output').map((messageChunk) => String(messageChunk.data)).join('');
  const combinedB = outputsB.filter((messageChunk) => messageChunk.type === 'output').map((messageChunk) => String(messageChunk.data)).join('');
  assert.equal(combinedA.includes(rawToken), false);
  assert.equal(combinedB.includes(rawToken), false);
  assert.equal(fs.readFileSync(sharedPath, 'utf8'), fileContent);
  assert.deepEqual(fs.readdirSync(sharedDir).filter((name) => name.endsWith('.md')).sort(), [descriptor.fileName]);

  wsA.close();
  wsB.close();
});

test('telepty status-report publishes a semantic self-report for the current session', async () => {
  const sessionId = createSessionId('cli-status-report');
  await harness.registerSession(sessionId);

  const result = await harness.runCli([
    'status-report',
    '--phase', 'implementing',
    '--task', 'wire observer schema',
    '--blocker', 'awaiting review',
    '--needs-input',
    '--thread-id', 'thread-telepty'
  ], {
    env: {
      TELEPTY_SESSION_ID: sessionId
    }
  });
  assert.equal(result.code, 0, result.stderr);

  const detail = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.semantic, {
    phase: 'implementing',
    current_task: 'wire observer schema',
    blocker: 'awaiting review',
    needs_input: true,
    thread_id: 'thread-telepty',
    source: 'self_report',
    seq: 1
  });

  const info = await harness.runCli(['session', 'info', sessionId]);
  assert.equal(info.code, 0, info.stderr);
  const output = stripAnsi(`${info.stdout}\n${info.stderr}`);
  assert.match(output, /Phase: implementing/i);
  assert.match(output, /Current Task: wire observer schema/i);
  assert.match(output, /Blocker: awaiting review/i);
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

test('telepty allow inject submits once without exposing routing metadata', async () => {
  const sessionId = createSessionId('cli-allow-inject');
  const childScript = createSubmitCaptureScript();

  const cli = pty.spawn(process.execPath, [
    'cli.js',
    'allow',
    '--id',
    sessionId,
    process.execPath,
    '-e',
    childScript
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
    await waitFor(() => stripAnsi(output).includes('Inject allowed.'), {
      timeoutMs: 7000,
      description: 'allow bridge ready'
    });

    const inject = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
      method: 'POST',
      body: { prompt: 'hello-once', from: 'orch', reply_to: 'orch' }
    });
    assert.equal(inject.status, 200);

    await waitFor(() => stripAnsi(output).includes('SUBMIT:hello-once'), {
      timeoutMs: 7000,
      description: 'single submitted inject payload'
    });

    const normalized = stripAnsi(output);
    assert.equal(countOccurrences(normalized, 'SUBMIT:'), 1);
    assert.equal(normalized.includes('[from:'), false);
    assert.equal(normalized.includes('reply-to:'), false);
    assert.equal(normalized.includes('telepty inject --from'), false);
  } finally {
    cli.kill();
  }
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

test('telepty inject --submit uses terminal-level submit after text injection', async () => {
  const sessionId = createSessionId('cli-inject-submit');
  await harness.spawnSession(sessionId, {
    command: process.execPath,
    args: ['-e', createSubmitCaptureScript()]
  });

  const ws = await harness.connectSession(sessionId);
  const outputs = collectJsonMessages(ws);

  const result = await harness.runCli(['inject', '--submit', sessionId, 'hello-submit'], { timeoutMs: 10000 });
  assert.equal(result.code, 0, result.stderr);

  await waitFor(() => outputs.some((message) => (
    message.type === 'output' && String(message.data).includes('SUBMIT:')
  )), { timeoutMs: 7000, description: 'CLI inject --submit output' });

  const normalized = outputs
    .filter((message) => message.type === 'output')
    .map((message) => String(message.data))
    .join('');
  assert.ok(normalized.includes('SUBMIT:hello-submit'));
  assert.equal(countOccurrences(normalized, 'SUBMIT:'), 1);

  ws.close();
});

test('telepty send-key sends terminal-level enter to the target session', async () => {
  const sessionId = createSessionId('cli-send-key');
  await harness.spawnSession(sessionId, {
    command: process.execPath,
    args: ['-e', createSubmitCaptureScript()]
  });

  const ws = await harness.connectSession(sessionId);
  const outputs = collectJsonMessages(ws);

  // Inject text without submit (via HTTP API with no_enter)
  await harness.request(`/api/sessions/${sessionId}/inject`, {
    method: 'POST',
    body: { prompt: 'key-payload', no_enter: true }
  });

  // Wait for text to be written to PTY
  await new Promise(resolve => setTimeout(resolve, 500));

  // Send enter via send-key command
  const result = await harness.runCli(['send-key', sessionId, 'enter'], { timeoutMs: 8000 });
  assert.equal(result.code, 0, result.stderr);

  await waitFor(() => outputs.some((message) => (
    message.type === 'output' && String(message.data).includes('SUBMIT:')
  )), { timeoutMs: 7000, description: 'CLI send-key enter output' });

  ws.close();
});
