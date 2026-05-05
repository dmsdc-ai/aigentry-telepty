'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const cliPath = path.join(projectRoot, 'cli.js');

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
