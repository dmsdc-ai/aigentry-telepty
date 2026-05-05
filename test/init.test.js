'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const cliPath = path.join(projectRoot, 'cli.js');
const targets = ['claude', 'agents', 'gemini'];

function countMatches(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

async function readJsonRecords(target = 'all') {
  const result = await runTelepty(['init', '--print-snippet', '--target', target, '--format', 'json']);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trimEnd().split('\n').map((line) => JSON.parse(line));
}

function runTelepty(args, options = {}) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-init-home-'));
  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    NO_UPDATE_NOTIFIER: '1',
    TELEPTY_DISABLE_UPDATE_NOTIFIER: '1',
    ...(options.env || {})
  };

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: projectRoot,
      env,
      stdio: options.stdio || ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      fs.rmSync(homeDir, { recursive: true, force: true });
      resolve({ code, signal, stdout, stderr });
    });

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    }
  });
}

test('markdown output for claude includes target and 8-char sha256 envelope', async () => {
  const result = await runTelepty(['init', '--print-snippet', '--target', 'claude', '--format', 'markdown']);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^<!-- telepty-snippet\/v1 BEGIN target=claude sha256=[0-9a-f]{8} -->\n/);
  assert.match(result.stdout, /\n<!-- telepty-snippet\/v1 END target=claude -->\n$/);
});

test('markdown output for agents includes target and 8-char sha256 envelope', async () => {
  const result = await runTelepty(['init', '--print-snippet', '--target', 'agents', '--format', 'markdown']);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^<!-- telepty-snippet\/v1 BEGIN target=agents sha256=[0-9a-f]{8} -->\n/);
  assert.match(result.stdout, /\n<!-- telepty-snippet\/v1 END target=agents -->\n$/);
});

test('markdown output for gemini includes target and 8-char sha256 envelope', async () => {
  const result = await runTelepty(['init', '--print-snippet', '--target', 'gemini', '--format', 'markdown']);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^<!-- telepty-snippet\/v1 BEGIN target=gemini sha256=[0-9a-f]{8} -->\n/);
  assert.match(result.stdout, /\n<!-- telepty-snippet\/v1 END target=gemini -->\n$/);
});

test('markdown output for all emits three envelopes in target order with empty separators', async () => {
  const result = await runTelepty(['init', '--print-snippet', '--target', 'all', '--format', 'markdown']);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(countMatches(result.stdout, /<!-- telepty-snippet\/v1 BEGIN target=/g), 3);
  assert.equal(countMatches(result.stdout, /<!-- telepty-snippet\/v1 END target=/g), 3);
  assert.deepEqual(
    [...result.stdout.matchAll(/BEGIN target=(claude|agents|gemini) /g)].map((match) => match[1]),
    targets
  );
  assert.match(result.stdout, /END target=claude -->\n\n<!-- telepty-snippet\/v1 BEGIN target=agents/);
  assert.match(result.stdout, /END target=agents -->\n\n<!-- telepty-snippet\/v1 BEGIN target=gemini/);
});

test('json output for all emits three typed NDJSON records', async () => {
  const result = await runTelepty(['init', '--print-snippet', '--target', 'all', '--format', 'json']);

  assert.equal(result.code, 0, result.stderr);
  const lines = result.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 3);

  lines.forEach((line, index) => {
    const parsed = JSON.parse(line);
    assert.deepEqual(Object.keys(parsed), ['version', 'target', 'sha256', 'body']);
    assert.equal(parsed.version, 'telepty-snippet/v1');
    assert.equal(parsed.target, targets[index]);
    assert.match(parsed.sha256, /^[0-9a-f]{64}$/);
    assert.equal(typeof parsed.body, 'string');
  });
});

test('snippet bodies contain no shell-substitution hazards', async () => {
  const records = await readJsonRecords();

  records.forEach(({ body }) => {
    assert.equal(body.includes('$HOME'), false);
    assert.equal(body.includes('$('), false);
    assert.equal(body.includes('~'), false);
    for (const inlineCode of body.matchAll(/`([^`\n]+)`/g)) {
      assert.doesNotMatch(inlineCode[1], /[$;|&]/);
    }
  });
});

test('snippet bodies are LF-only', async () => {
  const records = await readJsonRecords();

  records.forEach(({ body }) => {
    assert.equal(body.includes('\r'), false);
  });
});

test('snippet output is byte-identical across sequential invocations', async () => {
  for (const target of targets) {
    const first = await runTelepty(['init', '--print-snippet', '--target', target]);
    const second = await runTelepty(['init', '--print-snippet', '--target', target]);

    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(first.stdout, second.stdout);
  }
});
