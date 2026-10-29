'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { createUpdatePlan, assertUpdateCanRun, BLOCKED } = require('../src/update-plan');
const { createCliSecurityActions } = require('../src/cli/security-actions');

function scopedEnv(values, run) {
  const saved = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  try { for (const [key, value] of Object.entries(values)) { if (value === null) delete process.env[key]; else process.env[key] = value; } return run(); }
  finally { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
function runCli(args, home, command) {
  return new Promise(resolve => execFile(process.execPath, [path.resolve(__dirname, '../cli.js'), ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home, npm_config_prefix: home,
      TELEPTY_UPDATE_COMMAND: command, TELEPTY_SKIP_DAEMON_REPAIR: '1', TELEPTY_AUTH_TOKEN: 'synthetic-plan-private-token' },
    timeout: 5000
  }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));
}

test('Windows guard uses the real bounded plan and refuses npm/override/repair before touching an owned holder', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-update-131-'));
  const install = path.join(home, 'fixture-install'); fs.mkdirSync(install);
  fs.writeFileSync(path.join(install, 'package.json'), JSON.stringify({ name: '@dmsdc-ai/aigentry-telepty', version: '0.9.2', secret: 'synthetic-package-private' }));
  const holder = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: 'ignore' });
  await new Promise((resolve, reject) => { holder.once('spawn', resolve); holder.once('error', reject); });
  try {
    fs.mkdirSync(path.join(home, '.telepty'));
    const statePath = path.join(home, '.telepty', 'daemon-state.json');
    const original = JSON.stringify({ pid: holder.pid, port: 54321, version: '0.8.5', startedAt: '2026-10-29T00:00:00Z', token: 'synthetic-state-private' });
    fs.writeFileSync(statePath, original);
    const options = { platform: 'win32', homeDir: home, packageRoot: install, pid: process.pid };
    const plan = createUpdatePlan(options);
    assert.equal(plan.guard_blocks_update, true);
    assert.equal(plan.daemon.recorded_pid, holder.pid);
    assert.equal(plan.daemon.installation_verified, false);
    assert.equal(plan.service.ownership, 'unverified');
    assert.equal(plan.execution_supported, false);
    assert.deepEqual(plan.changes_performed, []);
    const encoded = JSON.stringify(plan);
    assert.equal(encoded.includes('synthetic-state-private'), false);
    assert.equal(encoded.includes('synthetic-package-private'), false);
    const calls = [];
    const update = createCliSecurityActions({ isMainModule: false }, { platform: 'win32',
      execFileSync: (...args) => calls.push(args), execSync: (...args) => calls.push(args),
      guardUpdate: settings => assertUpdateCanRun({ ...options, ...settings }) });
    for (const values of [
      { TELEPTY_SKIP_PACKAGE_UPDATE: null, TELEPTY_UPDATE_COMMAND: null },
      { TELEPTY_SKIP_PACKAGE_UPDATE: null, TELEPTY_UPDATE_COMMAND: 'synthetic-operator-override' },
      { TELEPTY_SKIP_PACKAGE_UPDATE: '1', TELEPTY_UPDATE_COMMAND: null }
    ]) scopedEnv(values, () => assert.throws(() => update.runUpdateInstall(), reason => reason.code === BLOCKED && reason.plan.read_only === true));
    assert.deepEqual(calls, []);
    assert.equal(holder.exitCode, null);
    assert.equal(holder.signalCode, null);
    assert.equal(fs.readFileSync(statePath, 'utf8'), original);
    assert.equal(fs.existsSync(path.join(home, '.telepty', 'config.json')), false);
    // An unreadable or oversized state remains unknown; it never becomes stop authority.
    fs.writeFileSync(statePath, 'x'.repeat(16 * 1024 + 1));
    assert.equal(createUpdatePlan(options).daemon.observation, 'unreadable');
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) {
      holder.kill(); await new Promise(resolve => holder.once('exit', resolve));
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('non-Windows npm producer remains unchanged under mocked commands', () => {
  const calls = [];
  const update = createCliSecurityActions({ isMainModule: false }, { platform: 'linux',
    execFileSync: (...args) => calls.push(args), execSync: () => assert.fail('unexpected shell') });
  scopedEnv({ TELEPTY_SKIP_PACKAGE_UPDATE: null, TELEPTY_UPDATE_COMMAND: null }, () => update.runUpdateInstall());
  assert.deepEqual(calls, [['npm', ['install', '-g', '@dmsdc-ai/aigentry-telepty@latest'], { stdio: 'inherit' }]]);
});

test('update --plan --json creates no credential, npm sentinel or installation change', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-update-plan-'));
  try {
    const sentinel = path.join(home, 'npm-was-not-run');
    const script = path.join(home, 'mock-npm.js');
    fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'unexpected');`);
    const result = await runCli(['update', '--plan', '--json'], home, `"${process.execPath}" "${script}"`);
    assert.equal(result.code, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.schema, 'telepty.update-plan/v1');
    assert.equal(plan.read_only, true);
    assert.deepEqual(plan.changes_performed, []);
    assert.equal(result.stdout.includes('synthetic-plan-private-token'), false);
    assert.equal(fs.existsSync(sentinel), false);
    assert.equal(fs.existsSync(path.join(home, '.telepty', 'config.json')), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('native Windows update refuses before the explicit mock override', { skip: process.platform !== 'win32' }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-update-native-'));
  try {
    const sentinel = path.join(home, 'must-not-run');
    const script = path.join(home, 'mock-npm.js');
    fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'unexpected');`);
    const result = await runCli(['update', '--json'], home, `"${process.execPath}" "${script}"`);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).guard_blocks_update, true);
    assert.equal(fs.existsSync(sentinel), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
