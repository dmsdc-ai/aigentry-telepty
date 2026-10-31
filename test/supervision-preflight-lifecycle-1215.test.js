'use strict';

// Task 1215 service36 — the supervision preflight runs BEFORE every lifecycle mutation, through the REAL production
// callers with injected recorders (nothing is stopped, unloaded, written, kickstarted, spawned or scheduled; no
// daemon or service manager is touched; no host service command runs):
//   T3 cli.js `service install|start|restart` (runServiceCommandVerb → the REAL src/service.js with a trapping world),
//      `daemon start` (runDaemonStart), `daemon restart` (runDaemonStopRestart), the menu start
//      (interactiveDaemonStart), update/repair (repairLocalDaemon), the automatic upgrade restart
//      (ensureDaemonRunning) — and install.js main()'s gate
//   T4 scripts/postinstall.js main(): an invalid setting + a stale daemon ⇒ no cleanup, no restart, no respawn
//   T8 refusal output names the code only     T9 plain uninstall keeps the key; --purge unchanged
// Every refusal case has a positive control (same caller, absent setting ⇒ it proceeds into its first mutation),
// so a refusal is never mistaken for a caller that simply did nothing.
// Expected on the ORIGINAL source (not executed here): every refusal case fails — the callers ignore the key and
// reach their first recorder, and runDaemonStart / install.js assertSupervisionPreflight do not exist. T9 and the
// positive controls are expected to hold on both.
// service46 S1: every caller is also driven with a VALID calling-process override (TELEPTY_SUPERVISION_TRUST_FILE) plus an
// invalid or unreadable persistent setting — what a service-managed replacement reads — and must refuse with every
// recorder empty; env valid + config absent is an added positive control. Expected on the service41 candidate: those
// refusal rows fail (the env decided and the config was never read), the new positive control holds.

process.env.TELEPTY_DISABLE_UPDATE_NOTIFIER = '1';
process.env.NO_UPDATE_NOTIFIER = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../cli');
const postinstall = require('../scripts/postinstall');
const install = require('../install');
const pkg = require('../package.json');

const SECRET = 's36-secret-trust';
const WIN = process.platform === 'win32';
const INVALID_VALUE = `relative/${SECRET}.json`;

function root(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'telepty-1215-s36l-'));
  fs.mkdirSync(path.join(dir, '.telepty'), { mode: 0o700 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// A HOME whose operator config carries `settings` (string ⇒ raw bytes).
function homeWith(t, settings) {
  const home = root(t);
  const file = path.join(home, '.telepty', 'config.json');
  fs.writeFileSync(file, typeof settings === 'string' ? settings : JSON.stringify({ authToken: `s36-${crypto.randomUUID()}`, ...settings }), { mode: 0o600 });
  return { home, configPath: file };
}
// service46 S1: a valid private trust file for the calling-process env override (telepty.principals/v1, Ed25519 operator).
function validTrustFile(t) {
  const dir = root(t);   // mkdtemp ⇒ 0700 under the realpath temp dir (the authority-file walk refuses symlinked ancestors)
  const file = path.join(dir, 'trust.json');
  const pair = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(file, JSON.stringify({ schema: 'telepty.principals/v1', audience: 'telepty-1215-s46', keys: [{ key_id: 'operator-key',
    principal_id: 'operator', authority: 'operator', public_key_spki: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    grants: [{ action: 'session.register', targets: ['s46-orchestrator'] }] }] }), { mode: 0o600, flag: 'wx' });
  fs.chmodSync(file, 0o600);
  return file;
}
// The refusal fixtures every caller is driven with (real preflight; only its env/config source is injected).
function refusalCases(t) {
  const invalid = homeWith(t, { supervisionTrustFile: INVALID_VALUE });
  const unreadable = homeWith(t, '{"authToken":"s36-REAL-SECR');
  const envTrust = validTrustFile(t);
  const winKey = homeWith(t, { supervisionTrustFile: path.resolve(fs.realpathSync(os.tmpdir()), `${SECRET}.json`) });
  return [
    ['invalid key', { env: {}, configPath: invalid.configPath }, 'SUPERVISION_CONFIG_INVALID'],
    ['unreadable config', { env: {}, configPath: unreadable.configPath }, 'SUPERVISION_CONFIG_UNREADABLE'],
    ['strict-mode conflict', { env: { TELEPTY_SUPERVISION_TRUST_FILE: path.resolve(fs.realpathSync(os.tmpdir()), `${SECRET}.json`), TELEPTY_PRINCIPAL_MODE: 'strict' },
      configPath: invalid.configPath }, 'SUPERVISION_MODE_CONFLICT'],
    ['win32 platform', { env: {}, configPath: winKey.configPath, platform: 'win32' }, 'SUPERVISION_UNSUPPORTED_PLATFORM'],
    // service46 S1: a valid calling-process override does not hide the persistent setting a service-managed replacement
    // reads. (win32: the calling view refuses first — the authority-file reader has no Windows backend.)
    ['env valid + config invalid', { env: { TELEPTY_SUPERVISION_TRUST_FILE: envTrust }, configPath: invalid.configPath },
      WIN ? 'SUPERVISION_UNSUPPORTED_PLATFORM' : 'SUPERVISION_CONFIG_INVALID'],
    ['env valid + config unreadable', { env: { TELEPTY_SUPERVISION_TRUST_FILE: envTrust }, configPath: unreadable.configPath },
      WIN ? 'SUPERVISION_UNSUPPORTED_PLATFORM' : 'SUPERVISION_CONFIG_UNREADABLE'],
  ];
}
function absentSupervision(t) { return { env: {}, configPath: path.join(root(t), '.telepty', 'absent.json') }; }
// Positive controls: [label, supervision, proceeds]. service46 S1 adds env valid + config absent, which must still proceed
// (a service-managed replacement would run guarded, exactly as before); on win32 it is the explicit platform refusal.
function positiveControls(t) {
  return [['absent', absentSupervision(t), true],
    ['env valid + config absent', { env: { TELEPTY_SUPERVISION_TRUST_FILE: validTrustFile(t) }, configPath: path.join(root(t), '.telepty', 'absent.json') }, !WIN]];
}

function recorder() {
  const events = [];
  const fn = (name, ret) => (...args) => { events.push(name); return typeof ret === 'function' ? ret(...args) : ret; };
  return { events, fn };
}
// A world in which ANY touch is recorded and fails — fs (every property), exec, probes, graceful stop.
function trappingServiceDeps(events) {
  const trap = (name) => () => { events.push(name); throw new Error(`unexpected ${name}`); };
  const fsTrap = new Proxy({}, { get: (_target, prop) => trap(`fs.${String(prop)}`) });
  return { platform: 'linux', homedir: '/home/s36-tester', uid: 501, user: 's36-tester', env: {}, packageRoot: '/opt/s36/pkg', nodeBin: '/opt/s36/node',
    port: 3848, probe: false, sleep: async () => {}, waitMs: 0, fs: fsTrap, execFileSync: trap('execFileSync'), execSync: trap('execSync'),
    getDaemonMeta: trap('getDaemonMeta'), readDaemonState: trap('readDaemonState'), gracefulStop: trap('gracefulStop') };
}
async function captured(fn) {
  const out = [];
  const saved = { log: console.log, error: console.error, warn: console.warn, write: process.stderr.write };
  console.log = (...a) => { out.push(a.join(' ')); };
  console.error = (...a) => { out.push(a.join(' ')); };
  console.warn = (...a) => { out.push(a.join(' ')); };
  process.stderr.write = (chunk) => { out.push(String(chunk)); return true; };
  const exitCode = process.exitCode;
  try {
    const result = await fn();
    return { result, text: out.join('\n'), exitCode: process.exitCode };
  } finally {
    Object.assign(console, { log: saved.log, error: saved.error, warn: saved.warn });
    process.stderr.write = saved.write;
    process.exitCode = exitCode;
  }
}
function assertRefusalText(text, code, label) {
  assert.match(text, new RegExp(code), `${label}: the code is reported`);
  for (const secret of [SECRET, 's36-REAL-SECR', os.tmpdir()]) assert.ok(!text.includes(secret), `${label}: no path or config content (T8)`);
}
function withEnv(names, fn) {
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  const restore = () => { for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; } };
  return Promise.resolve().then(fn).finally(restore);
}

// ── T3 `telepty service install|start|restart` ────────────────────────────────────────────────────────────────

test('T3 service install|start|restart: refused before the REAL service verb touches fs, exec, probes or the graceful stop', async (t) => {
  for (const [label, supervision, code] of refusalCases(t)) {
    for (const sub of ['install', 'start', 'restart']) {
      for (const platform of ['linux', 'win32']) {   // win32 = the scheduled-task graceful-first route
        const events = [];
        const { result, text } = await captured(() => cli.runServiceCommandVerb(sub, { yes: true, isTTY: false },
          { serviceDeps: trappingServiceDeps(events), platform, supervision, gracefulStop: () => { events.push('gracefulStop'); return { ok: true }; } }));
        assert.deepEqual(events, [], `${label} / ${sub} / ${platform}: nothing touched`);
        assert.equal(result.exitCode, 1, `${label} / ${sub}: exit 1`);
        assert.equal(result.supervisionRefused, code, `${label} / ${sub}`);
        assertRefusalText(text, code, `${label} / ${sub}`);
      }
    }
  }
});

test('T3 service verbs: an absent setting proceeds to the service verb; stop/uninstall and dry runs are never refused', async (t) => {
  for (const [control, supervision, proceeds] of positiveControls(t)) {
    for (const sub of ['install', 'start', 'restart']) {
      const r = recorder();
      await captured(() => cli.runServiceCommandVerb(sub, { yes: true, isTTY: false }, { platform: 'linux', serviceDeps: {}, supervision,
        runServiceVerb: r.fn('runServiceVerb', { exitCode: 0 }) }));
      assert.deepEqual(r.events, proceeds ? ['runServiceVerb'] : [], `${sub}: positive control (${control})`);
    }
  }
  const invalid = refusalCases(t)[0][1];
  for (const [sub, flags] of [['stop', {}], ['uninstall', {}], ['install', { dryRun: true }]]) {
    const r = recorder();
    await captured(() => cli.runServiceCommandVerb(sub, { yes: true, isTTY: false, ...flags }, { platform: 'linux', serviceDeps: {}, supervision: invalid,
      runServiceVerb: r.fn('runServiceVerb', { exitCode: 0 }) }));
    assert.deepEqual(r.events, ['runServiceVerb'], `${sub}${flags.dryRun ? ' --dry-run' : ''}: a bad setting never blocks this`);
  }
});

// ── T3 `telepty daemon start|restart` ─────────────────────────────────────────────────────────────────────────

function daemonDeps(r, supervision, extra = {}) {
  return { platform: 'linux', port: 39036, supervision, detectSupervisor: r.fn('detectSupervisor', { present: false }),
    runSupervisedDaemonVerb: r.fn('runSupervisedDaemonVerb', { exitCode: 0 }), gracefulStop: r.fn('gracefulStop', { ok: true, startReplacement: true, stopped: [] }),
    signalStop: r.fn('signalStop', { stopped: [], failed: [] }), startDetachedDaemon: r.fn('startDetachedDaemon', { pid: 4242 }),
    logDaemonRestartEvent: r.fn('logDaemonRestartEvent'), ...extra };
}

test('T3 daemon start|restart: refused before routing, stop or spawn, exit 1', async (t) => {
  for (const [label, supervision, code] of refusalCases(t)) {
    for (const platform of ['linux', 'win32']) {
      const start = recorder();
      const s = await captured(() => cli.runDaemonStart(daemonDeps(start, supervision, { platform })));
      assert.deepEqual(start.events, [], `${label} / start / ${platform}`);
      assert.equal(s.exitCode, 1);
      assert.equal(s.result.supervisionRefused, code);
      assertRefusalText(s.text, code, `${label} / start`);

      const restart = recorder();
      const rs = await captured(() => cli.runDaemonStopRestart('restart', daemonDeps(restart, supervision, { platform })));
      assert.deepEqual(restart.events, [], `${label} / restart / ${platform}`);
      assert.equal(rs.exitCode, 1);
      assert.equal(rs.result.supervisionRefused, code);
      assertRefusalText(rs.text, code, `${label} / restart`);
    }
  }
});

test('T3 daemon start|restart: absent setting proceeds; `daemon stop` is never blocked by a bad setting', async (t) => {
  for (const [control, supervision, proceeds] of positiveControls(t)) {
    const start = recorder();
    await captured(() => cli.runDaemonStart(daemonDeps(start, supervision)));
    assert.deepEqual(start.events, proceeds ? ['detectSupervisor', 'startDetachedDaemon'] : [], `start positive control (${control})`);
    const restart = recorder();
    await captured(() => cli.runDaemonStopRestart('restart', daemonDeps(restart, supervision)));
    assert.equal(restart.events.includes('signalStop') && restart.events.includes('startDetachedDaemon'), proceeds, `restart positive control (${control})`);
  }
  const stop = recorder();
  await captured(() => cli.runDaemonStopRestart('stop', daemonDeps(stop, refusalCases(t)[0][1])));
  assert.ok(stop.events.includes('signalStop'), 'stop with an invalid setting still stops');
});

test('T3 daemon start: the production default (no seam) reads THIS process env + HOME config', async (t) => {
  const { home } = homeWith(t, { supervisionTrustFile: INVALID_VALUE });
  await withEnv(['HOME', 'USERPROFILE', 'TELEPTY_SUPERVISION_TRUST_FILE', 'TELEPTY_PRINCIPAL_MODE'], async () => {
    process.env.HOME = home; process.env.USERPROFILE = home;
    const r = recorder();
    const deps = daemonDeps(r, undefined);
    delete deps.supervision;
    const { result, text } = await captured(() => cli.runDaemonStart(deps));
    assert.deepEqual(r.events, []);
    assert.equal(result.supervisionRefused, 'SUPERVISION_CONFIG_INVALID');
    assertRefusalText(text, 'SUPERVISION_CONFIG_INVALID', 'default path');
    // service46 S1: a valid override exported in THIS shell does not carry the invalid persistent key past the gate.
    process.env.TELEPTY_SUPERVISION_TRUST_FILE = validTrustFile(t);
    const r2 = recorder();
    const deps2 = daemonDeps(r2, undefined);
    delete deps2.supervision;
    const expected = WIN ? 'SUPERVISION_UNSUPPORTED_PLATFORM' : 'SUPERVISION_CONFIG_INVALID';
    const second = await captured(() => cli.runDaemonStart(deps2));
    assert.deepEqual(r2.events, [], 'default path, env valid + config invalid');
    assert.equal(second.result.supervisionRefused, expected);
    assertRefusalText(second.text, expected, 'default path, env valid');
  });
});

// ── T3 menu start, update/repair, automatic upgrade restart ───────────────────────────────────────────────────

test('T3 menu daemon start: refused before the stop and the start', async (t) => {
  for (const [label, supervision, code] of refusalCases(t)) {
    for (const platform of ['linux', 'win32']) {
      const r = recorder();
      const { result, text } = await captured(() => cli.interactiveDaemonStart({ platform, supervision, cleanupDaemonProcesses: r.fn('cleanupDaemonProcesses'),
        gracefulStop: r.fn('gracefulStop', { startReplacement: true }), startDetachedDaemon: r.fn('startDetachedDaemon'), logDaemonRestartEvent: r.fn('log') }));
      assert.equal(result, false, label);
      assert.deepEqual(r.events, [], `${label} / ${platform}`);
      assertRefusalText(text, code, `menu ${label}`);
    }
  }
  for (const [control, supervision, proceeds] of positiveControls(t)) {
    const ok = recorder();
    await captured(() => cli.interactiveDaemonStart({ platform: 'linux', supervision, cleanupDaemonProcesses: ok.fn('cleanupDaemonProcesses'),
      startDetachedDaemon: ok.fn('startDetachedDaemon'), logDaemonRestartEvent: ok.fn('log') }));
    assert.deepEqual(ok.events, proceeds ? ['log', 'cleanupDaemonProcesses', 'startDetachedDaemon'] : [], `positive control (${control})`);
  }
});

test('T3 update/repair: refused before the stop; the old daemon keeps running', async (t) => {
  const cases = refusalCases(t);
  const controls = positiveControls(t);
  const home = root(t);   // the positive control's restart-log line (real logDaemonRestartEvent) lands in a private HOME
  await withEnv(['TELEPTY_SKIP_DAEMON_REPAIR', 'TELEPTY_CLIENT_RESTART', 'HOME', 'USERPROFILE'], async () => {
    process.env.HOME = home; process.env.USERPROFILE = home;
    for (const [label, supervision, code] of cases) {
      const r = recorder();
      const { result, text } = await captured(() => cli.repairLocalDaemon({ restart: true, _supervision: supervision, _detectSupervisor: () => ({ present: false }),
        _stopDaemon: r.fn('stop', { stopped: [], failed: [] }), _restartDaemonGraceful: r.fn('restart', { success: true, meta: null }) }));
      assert.deepEqual(r.events, [], label);
      assert.equal(result.supervisionRefused, code);
      assert.equal(cli.updateRestartSucceeded(result), false, 'update reports the refusal, not a success');
      assertRefusalText(text, code, `repair ${label}`);
    }
    for (const [control, supervision, proceeds] of controls) {
      const ok = recorder();
      await captured(() => cli.repairLocalDaemon({ restart: true, _supervision: supervision, _detectSupervisor: () => ({ present: false }),
        _stopDaemon: ok.fn('stop', { stopped: [], failed: [] }), _restartDaemonGraceful: ok.fn('restart', { success: true, meta: null }) }));
      assert.deepEqual(ok.events, proceeds ? ['stop', 'restart'] : [], `positive control (${control})`);
    }
  });
});

test('T3 automatic upgrade restart (ensureDaemonRunning): an outdated answering daemon is NOT replaced on a refusal', async (t) => {
  const options = (r, supervision) => ({
    port: 39037, _supervision: supervision, _probe: { attempts: 1, backoffMs: 0 }, _detectSupervisor: () => ({ present: false }),
    _getDaemonMeta: async () => ({ version: '0.0.1', pid: 4242, capabilities: [] }),
    _fetchWithAuth: async () => { throw new Error('not reached'); }, _probeDaemonHealth: async () => true,
    _restartDaemonGraceful: r.fn('restartDaemonGraceful', { success: true }), _findPortOwnerPid: () => 4242,
    _readRestartFailureMarker: () => null, _writeRestartFailureMarker: r.fn('writeMarker'), _clearRestartFailureMarker: r.fn('clearMarker'),
  });
  assert.notEqual(pkg.version, '0.0.1', 'PRECONDITION: the fixture daemon is outdated');
  await withEnv(['TELEPTY_CLIENT_RESTART'], async () => {
    for (const [label, supervision, code] of refusalCases(t)) {
      const r = recorder();
      const { result, text } = await captured(() => cli.ensureDaemonRunning(options(r, supervision)));
      assert.deepEqual(r.events, [], `${label}: the running daemon is left alone`);
      assert.equal(result.success, false);
      assert.equal(result.supervisionRefused, code);
      assertRefusalText(text, code, `ensure ${label}`);
    }
    for (const [control, supervision, proceeds] of positiveControls(t)) {
      const ok = recorder();
      await captured(() => cli.ensureDaemonRunning(options(ok, supervision)));
      assert.equal(ok.events.includes('restartDaemonGraceful'), proceeds, `positive control (${control}): the upgrade restart still happens`);
    }
  });
});

// ── T3 install.js ─────────────────────────────────────────────────────────────────────────────────────────────

test('T3 install.js: the gate refuses with the code only, and main() runs it before every unload/stop/cleanup/write', async (t) => {
  for (const [label, supervision, code] of refusalCases(t)) {
    let error = null;
    try { install.assertSupervisionPreflight(supervision); } catch (e) { error = e; }
    assert.ok(error, label);
    assert.equal(error.code, code);
    assertRefusalText(error.message, code, `install ${label}`);
  }
  assert.deepEqual(install.assertSupervisionPreflight(absentSupervision(t)), { configured: false, source: null, service_persistence: 'not_configured' }, 'positive control');
  const [, envAbsent, envProceeds] = positiveControls(t)[1];
  if (envProceeds) {
    assert.deepEqual(install.assertSupervisionPreflight(envAbsent), { configured: true, source: 'env', service_persistence: 'not_configured' },
      'positive control: env valid + config absent');
  } else {
    assert.throws(() => install.assertSupervisionPreflight(envAbsent), { code: 'SUPERVISION_UNSUPPORTED_PLATFORM' });
  }
  // main() needs a real global npm install, so its ORDER is asserted on its source text: the gate is its first
  // statement after the entry-point check, ahead of each mutation in step 4.
  const source = fs.readFileSync(path.join(__dirname, '..', 'install.js'), 'utf8');
  const main = source.slice(source.indexOf('async function main()'));
  const gate = main.indexOf('assertSupervisionPreflight();');
  assert.ok(gate > main.indexOf('Cannot find daemon entrypoint'), 'after the entry-point check');
  for (const mutation of ['cleanupLocalDaemons()', 'launchctl unload', 'systemctl stop', 'fs.writeFileSync(', 'buildWindowsAutostartCommand(', 'spawn(']) {
    const at = main.indexOf(mutation);
    assert.ok(at > gate, `${mutation} must come after the gate`);
  }
});

// ── T4 postinstall ────────────────────────────────────────────────────────────────────────────────────────────

test('T4 postinstall: an invalid setting + a stale daemon ⇒ no cleanup, restart or respawn; the code is warned', async (t) => {
  // service46 S1: `extraEnv` carries the calling (npm) process override; those runs use the host platform, because the
  // trust reader follows the actual host.
  const run = async (r, home, supervisor, extraEnv = null) => {
    const lines = [];
    const logger = { log: (m) => lines.push(m), warn: (m) => lines.push(m) };
    await postinstall.main({ env: { npm_config_global: 'true', ...(extraEnv || {}) }, logger, homeDir: home, platform: extraEnv ? process.platform : 'linux',
      diagnoseBinOwnership: () => null,
      detectSupervisor: () => supervisor, readDaemonState: () => ({ pid: 4242, version: '0.0.1', port: 3848 }),
      cleanupDaemonProcesses: r.fn('cleanupDaemonProcesses', { stopped: [{ pid: 4242 }], failed: [] }),
      restartSupervisorDaemon: r.fn('restartSupervisorDaemon', { success: true }), spawnDetachedDaemon: r.fn('spawnDetachedDaemon', {}),
      waitForDaemonVersion: r.fn('waitForDaemonVersion', null), waitTimeoutMs: 1 });
    return lines.join('\n');
  };
  const invalid = homeWith(t, { supervisionTrustFile: INVALID_VALUE });
  const unreadable = homeWith(t, '{"authToken":"s36-REAL-SECR');
  const envOverride = { TELEPTY_SUPERVISION_TRUST_FILE: validTrustFile(t) };
  for (const supervisor of [{ present: true, kind: 'launchd' }, { present: false }]) {
    for (const [label, home, code, extraEnv] of [['invalid', invalid.home, 'SUPERVISION_CONFIG_INVALID', null],
      ['unreadable', unreadable.home, 'SUPERVISION_CONFIG_UNREADABLE', null],
      ['env valid + config invalid', invalid.home, WIN ? 'SUPERVISION_UNSUPPORTED_PLATFORM' : 'SUPERVISION_CONFIG_INVALID', envOverride],
      ['env valid + config unreadable', unreadable.home, WIN ? 'SUPERVISION_UNSUPPORTED_PLATFORM' : 'SUPERVISION_CONFIG_UNREADABLE', envOverride]]) {
      const r = recorder();
      const text = await run(r, home, supervisor, extraEnv);
      assert.deepEqual(r.events, [], `${label} / supervised=${supervisor.present}: the old daemon keeps running`);
      assertRefusalText(text, code, `postinstall ${label}`);
    }
    const ok = recorder();
    await run(ok, root(t), supervisor);
    assert.equal(ok.events[0], 'cleanupDaemonProcesses', `positive control supervised=${supervisor.present}`);
    const envOk = recorder();
    await run(envOk, root(t), supervisor, envOverride);
    assert.equal(envOk.events[0], WIN ? undefined : 'cleanupDaemonProcesses', `positive control env valid + config absent supervised=${supervisor.present}`);
  }
});

// ── T9 uninstall ──────────────────────────────────────────────────────────────────────────────────────────────

test('T9 plain uninstall keeps ~/.telepty and the key; --purge behaviour is unchanged', async (t) => {
  const { home, configPath } = homeWith(t, { supervisionTrustFile: INVALID_VALUE });
  const before = fs.readFileSync(configPath);
  const removals = [];
  const fsView = { existsSync: (p) => fs.existsSync(p), readFileSync: (...a) => fs.readFileSync(...a), rmSync: (p) => { removals.push(p); } };
  const uninstallOptions = { platform: 'darwin', homedir: home, fs: fsView, execFileSync: () => {}, cleanupDaemonProcesses: () => ({ stopped: [], failed: [] }) };
  const plain = await captured(() => cli.runUninstallCommand({ purge: false }, { platform: 'linux', uninstallOptions }));
  assert.deepEqual(removals, [], 'plain uninstall removes no state');
  assert.ok(plain.result.stateDirs.some((d) => d.path === path.join(home, '.telepty') && d.exists && !d.purged));
  assert.deepEqual(fs.readFileSync(configPath), before, 'the config and its key are untouched');
  await captured(() => cli.runUninstallCommand({ purge: true }, { platform: 'linux', uninstallOptions }));
  assert.ok(removals.includes(path.join(home, '.telepty')), '--purge still removes ~/.telepty (recorded, not executed)');
});
