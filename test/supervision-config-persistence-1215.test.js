'use strict';

// Task 1215 service36 — the PERSISTENT supervision trust setting: `supervisionTrustFile` in ~/.telepty/config.json,
// with a non-empty TELEPTY_SUPERVISION_TRUST_FILE taking precedence (src/principal/supervision-config.js).
//   T1 resolve (absent / valid / every invalid shape; unreadable config is not absence)
//   T2 preflight (real loadPrincipalTrust: valid private fixture, missing, unsafe mode, audience, strict, win32)
//   T5 descriptors byte-identical with and without the key
//   T6 the REAL daemon.js boot (test-support/daemon-harness.js, private ephemeral loopback port): config-only key ⇒
//      challenge 200; invalid key ⇒ no boot with the code; absent ⇒ guarded 404; #843 C recovery boots guarded
//   T7 env precedence (resolver and real daemon)   T8 no trust path / config content in messages, logs or status
// Hermetic: private temp roots only; no service manager, no host service command, no live config.
// Expected on the ORIGINAL source (not executed here): the file fails at the require of the new module; and with
// that module alone, T6 config-only / invalid cases still fail because the original daemon.js ignores the key.
// Windows: the authority-file reader has no backend there, so valid fixtures are asserted as explicit refusals.
// service46 S1: lifecycle preflight also checks the persistent (service) selection when the env decides this process;
// errors carry `scope` (calling_process | service_persistence). The daemon's own env-wins resolution is unchanged.
// "PRECONDITION:" = fixture setup (a failure is INVALID, not a product RED).

process.env.TELEPTY_DISABLE_UPDATE_NOTIFIER = '1';
process.env.NO_UPDATE_NOTIFIER = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const supervision = require('../src/principal/supervision-config');
const { createSupervisionAuthenticationFromEnvironment } = require('../src/principal/http');
const { buildLaunchdPlist, buildSystemdService, buildWindowsAutostartCommand, resolveServiceProfile } = require('../install');
const { startTestDaemon } = require('../test-support/daemon-harness');

const WIN = process.platform === 'win32';
const AUDIENCE = 'telepty-1215-service36';
const ABS = path.resolve(fs.realpathSync(os.tmpdir()), 's36-trust.json');

// realpath: the authority-file walk refuses symlinked ancestors (macOS /var -> /private/var).
function privateRoot(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'telepty-1215-s36-'));
  fs.chmodSync(root, 0o700);
  for (const part of ['home', 'keys']) fs.mkdirSync(path.join(root, part), { mode: 0o700 });
  fs.mkdirSync(path.join(root, 'home', '.telepty'), { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function writePrivate(file, content, mode = 0o600) { fs.writeFileSync(file, content, { mode, flag: 'wx' }); fs.chmodSync(file, mode); }
function trustFile(root, { name = 'trust.json', audience = AUDIENCE, omitAudience = false, mode = 0o600, schema = 'telepty.principals/v1' } = {}) {
  const pair = crypto.generateKeyPairSync('ed25519');
  const file = path.join(root, 'keys', name);
  writePrivate(file, JSON.stringify({ schema, ...(omitAudience ? {} : { audience }), keys: [
    { key_id: 'operator-key', principal_id: 'operator', authority: 'operator', public_key_spki: pair.publicKey.export({ type: 'spki', format: 'pem' }),
      grants: [{ action: 'session.register', targets: ['s36-orchestrator'] }] }] }), mode);
  return file;
}
function configFile(root, settings) {
  const file = path.join(root, 'home', '.telepty', 'config.json');
  writePrivate(file, typeof settings === 'string' ? settings : JSON.stringify({ authToken: `s36-${crypto.randomUUID()}`, ...settings }));
  return file;
}
function thrown(fn) { try { fn(); } catch (error) { return error; } return null; }
function outcome(fn) { try { fn(); return 'ok'; } catch { return 'refused'; } }
function assertNoLeak(text, secrets, label) {
  for (const secret of secrets.filter(Boolean)) assert.ok(!String(text).includes(secret), `${label}: must not contain a path or config content`);
}

// ── T1 resolve ────────────────────────────────────────────────────────────────────────────────────────────────

test('T1 resolve: absent is off — no config, no key, empty env', () => {
  assert.deepEqual(supervision.resolveSupervisionTrustFile({ env: {}, config: null }), { file: null, source: null });
  assert.deepEqual(supervision.resolveSupervisionTrustFile({ env: {}, config: { authToken: 'x', idle_ttl_default: 'off' } }), { file: null, source: null });
  assert.deepEqual(supervision.resolveSupervisionTrustFile({ env: { TELEPTY_SUPERVISION_TRUST_FILE: '' }, config: {} }), { file: null, source: null },
    'an empty env value is unset, exactly as the daemon factory treats it');
});

test('T1 resolve: a valid absolute normalized key selects the config source', () => {
  assert.deepEqual(supervision.resolveSupervisionTrustFile({ env: {}, config: { supervisionTrustFile: ABS } }), { file: ABS, source: 'config' });
});

test('T1 resolve: every invalid shape is SUPERVISION_CONFIG_INVALID with a reason and no path', () => {
  const sep = path.sep, dir = path.dirname(ABS);
  const cases = [
    [null, 'not_a_string'], [7, 'not_a_string'], [true, 'not_a_string'], [[ABS], 'not_a_string'], [{ path: ABS }, 'not_a_string'],
    ['', 'empty'],
    [`relative${sep}s36-trust.json`, 'not_absolute'],
    [`${dir}${sep}x${sep}..${sep}s36-trust.json`, 'not_normalized'],
    [`${dir}${sep}${sep}s36-trust.json`, 'not_normalized'],
    [`${ABS}\u0001`, 'control_character'], [`${ABS}\n`, 'control_character'], [`${ABS}\u0000`, 'control_character'], [`${ABS}\u007f`, 'control_character'],
    [`${dir}${sep}${'a'.repeat(4097)}`, 'too_long'],
  ];
  for (const [value, reason] of cases) {
    const error = thrown(() => supervision.resolveSupervisionTrustFile({ env: {}, config: { supervisionTrustFile: value } }));
    assert.ok(error, `${reason}: must be refused, never ignored`);
    assert.equal(error.code, 'SUPERVISION_CONFIG_INVALID', reason);
    assert.equal(error.reason, reason);
    assertNoLeak(error.message, [typeof value === 'string' ? value : null, dir], reason);
  }
});

test('T1 config read: missing is absent; an unreadable or malformed config is NOT absence', (t) => {
  const root = privateRoot(t);
  assert.equal(supervision.readOperatorConfig({ configPath: path.join(root, 'home', '.telepty', 'missing.json') }), null, 'ENOENT ⇒ absent');
  const bad = [['{"authToken":"s36-REAL-SECR', 'not_json'], ['[]', 'not_an_object'], ['null', 'not_an_object'], ['"text"', 'not_an_object']];
  for (const [content, reason] of bad) {
    const file = path.join(root, 'home', '.telepty', `cfg-${reason}-${crypto.randomUUID()}.json`);
    writePrivate(file, content);
    const error = thrown(() => supervision.readOperatorConfig({ configPath: file }));
    assert.equal(error && error.code, 'SUPERVISION_CONFIG_UNREADABLE', content);
    assert.equal(error.reason, reason);
    assertNoLeak(error.message, [file, 's36-REAL-SECR'], content);
    // and a resolver that must read it refuses rather than reporting "off"
    assert.equal(thrown(() => supervision.resolveSupervisionTrustFile({ env: {}, loadConfig: () => supervision.readOperatorConfig({ configPath: file }) })).code,
      'SUPERVISION_CONFIG_UNREADABLE');
  }
  const dirError = thrown(() => supervision.readOperatorConfig({ configPath: path.join(root, 'home', '.telepty') }));
  assert.equal(dirError && dirError.code, 'SUPERVISION_CONFIG_UNREADABLE', 'a config path that is a directory');
  assert.equal(dirError.reason, 'read_failed');
});

// ── T7 env precedence (resolver) ──────────────────────────────────────────────────────────────────────────────

test('T7 env precedence: a non-empty env value wins and the config is not even read', () => {
  const neverRead = () => { throw new Error('the config must not be read when the env value decides'); };
  assert.deepEqual(supervision.resolveSupervisionTrustFile({ env: { TELEPTY_SUPERVISION_TRUST_FILE: ABS }, loadConfig: neverRead }), { file: ABS, source: 'env' });
  assert.deepEqual(supervision.resolveSupervisionTrustFile({ env: { TELEPTY_SUPERVISION_TRUST_FILE: ABS }, config: { supervisionTrustFile: 7 } }),
    { file: ABS, source: 'env' }, 'over an invalid key');
  // Existing env deployments keep their exact semantics: the env value is handed to the existing loader unvalidated.
  assert.deepEqual(supervision.resolveSupervisionTrustFile({ env: { TELEPTY_SUPERVISION_TRUST_FILE: 'relative-env.json' }, config: null }),
    { file: 'relative-env.json', source: 'env' });
  assert.deepEqual(supervision.resolveSupervisionTrustFile({ env: { TELEPTY_SUPERVISION_TRUST_FILE: '' }, config: { supervisionTrustFile: ABS } }),
    { file: ABS, source: 'config' }, 'an empty env value does not mask the config');
});

// ── T2 preflight ──────────────────────────────────────────────────────────────────────────────────────────────

test('T2 preflight: a valid private trust fixture passes (config and env source); Windows is an explicit refusal', (t) => {
  const root = privateRoot(t);
  const file = trustFile(root);
  const configPath = configFile(root, { supervisionTrustFile: file });
  const fromConfig = () => supervision.preflightSupervision({ env: {}, configPath, machineId: AUDIENCE });
  const fromEnv = () => supervision.preflightSupervision({ env: { TELEPTY_SUPERVISION_TRUST_FILE: file }, configPath: path.join(root, 'absent.json'), machineId: AUDIENCE });
  if (WIN) {
    assert.equal(thrown(fromConfig).code, 'SUPERVISION_UNSUPPORTED_PLATFORM');
    assert.equal(thrown(fromEnv).code, 'SUPERVISION_UNSUPPORTED_PLATFORM');
    return;
  }
  assert.deepEqual(fromConfig(), { configured: true, source: 'config', service_persistence: 'configured' });
  assert.deepEqual(fromEnv(), { configured: true, source: 'env', service_persistence: 'not_configured' },
    'service46 S1 positive control: env valid + config absent proceeds (a service-managed replacement would run guarded)');
});

test('T2 preflight: absent is not configured on every platform, including an injected win32', (t) => {
  const root = privateRoot(t);
  const configPath = configFile(root, {});
  for (const platform of [process.platform, 'win32']) {
    assert.deepEqual(supervision.preflightSupervision({ env: {}, configPath, platform }), { configured: false, source: null, service_persistence: 'not_configured' });
    assert.deepEqual(supervision.preflightSupervision({ env: {}, configPath: path.join(root, 'absent.json'), platform }),
      { configured: false, source: null, service_persistence: 'not_configured' });
  }
});

test('T2 preflight: missing, unsafe-mode and invalid trust files are PRINCIPAL_TRUST_UNAVAILABLE, with no path', (t) => {
  const root = privateRoot(t);
  const missing = path.join(root, 'keys', 'missing.json');
  const unsafe = trustFile(root, { name: 'unsafe.json', mode: 0o622 });   // group/other-writable
  const wrongSchema = trustFile(root, { name: 'schema.json', schema: 'telepty.principals/v0' });
  for (const file of [missing, unsafe, wrongSchema]) {
    const configPath = path.join(root, 'home', '.telepty', `cfg-${path.basename(file)}`);
    writePrivate(configPath, JSON.stringify({ authToken: 'x', supervisionTrustFile: file }));
    const error = thrown(() => supervision.preflightSupervision({ env: {}, configPath, machineId: AUDIENCE }));
    assert.ok(error, `${path.basename(file)} must be refused`);
    assert.equal(error.code, WIN ? 'SUPERVISION_UNSUPPORTED_PLATFORM' : 'PRINCIPAL_TRUST_UNAVAILABLE', path.basename(file));
    assertNoLeak(error.message, [file, root], path.basename(file));
  }
});

test('T2 preflight: strict mode is SUPERVISION_MODE_CONFLICT; an injected win32 is SUPERVISION_UNSUPPORTED_PLATFORM', (t) => {
  const root = privateRoot(t);
  const file = trustFile(root);
  const configPath = configFile(root, { supervisionTrustFile: file });
  assert.equal(thrown(() => supervision.preflightSupervision({ env: { TELEPTY_PRINCIPAL_MODE: 'strict' }, configPath, machineId: AUDIENCE })).code,
    'SUPERVISION_MODE_CONFLICT');
  const win = thrown(() => supervision.preflightSupervision({ env: {}, configPath, machineId: AUDIENCE, platform: 'win32' }));
  assert.equal(win.code, 'SUPERVISION_UNSUPPORTED_PLATFORM', 'refused before the trust file is read');
  assertNoLeak(win.message, [file], 'win32');
});

test('T2 preflight: an unreadable config refuses with SUPERVISION_CONFIG_UNREADABLE — also when a valid env value decides this process', (t) => {
  const root = privateRoot(t);
  const configPath = configFile(root, '{"authToken":"s36-REAL-SECR');
  const error = thrown(() => supervision.preflightSupervision({ env: {}, configPath }));
  assert.equal(error.code, 'SUPERVISION_CONFIG_UNREADABLE');
  assert.equal(error.scope, 'service_persistence');
  assertNoLeak(error.message, [configPath, 's36-REAL-SECR'], 'unreadable');
  if (WIN) return;
  const file = trustFile(root);
  // service46 S1: the env value decides only THIS process; a service-managed replacement reads this config.
  const withEnv = thrown(() => supervision.preflightSupervision({ env: { TELEPTY_SUPERVISION_TRUST_FILE: file }, configPath, machineId: AUDIENCE }));
  assert.equal(withEnv && withEnv.code, 'SUPERVISION_CONFIG_UNREADABLE', 'S1: a valid env override no longer hides an unreadable persistent config');
  assert.equal(withEnv.scope, 'service_persistence');
  assertNoLeak(withEnv.message, [configPath, file, 's36-REAL-SECR'], 'unreadable with env');
});

// service46 S1 — a valid calling-process override must not carry an invalid PERSISTENT setting into a stop: whenever the
// env decides this process, the config-only selection a service-managed replacement resolves gets the identical checks.
test('T2 S1 preflight: env valid + persistent setting invalid ⇒ refused with scope service_persistence; env valid + absent ⇒ proceeds', (t) => {
  const root = privateRoot(t);
  const envFile = trustFile(root, { name: 'env-trust.json' });
  const env = { TELEPTY_SUPERVISION_TRUST_FILE: envFile };
  const write = (name, settings) => {
    const file = path.join(root, 'home', '.telepty', `${name}.json`);
    writePrivate(file, JSON.stringify({ authToken: 'x', ...settings }));
    return file;
  };
  const refused = [
    ['relative key', write('relative', { supervisionTrustFile: 'relative/s36-secret-trust.json' }), 'SUPERVISION_CONFIG_INVALID'],
    ['non-string key', write('number', { supervisionTrustFile: 7 }), 'SUPERVISION_CONFIG_INVALID'],
    ['missing trust file', write('missing', { supervisionTrustFile: path.join(root, 'keys', 'missing.json') }), 'PRINCIPAL_TRUST_UNAVAILABLE'],
    ['unsafe trust file', write('unsafe', { supervisionTrustFile: trustFile(root, { name: 'unsafe.json', mode: 0o622 }) }), 'PRINCIPAL_TRUST_UNAVAILABLE'],
  ];
  for (const [label, configPath, code] of refused) {
    const error = thrown(() => supervision.preflightSupervision({ env, configPath, machineId: AUDIENCE }));
    assert.ok(error, `${label}: must be refused`);
    if (WIN) { assert.equal(error.code, 'SUPERVISION_UNSUPPORTED_PLATFORM', `${label} (win32: the calling view refuses first)`); continue; }
    assert.equal(error.code, code, label);
    assert.equal(error.scope, 'service_persistence', `${label}: the diagnostic names the persistent setting, not this process`);
    assertNoLeak(error.message, [envFile, root, 's36-secret-trust'], label);
  }
  if (WIN) return;
  const validKey = write('valid', { supervisionTrustFile: trustFile(root, { name: 'service-trust.json' }) });
  assert.deepEqual(supervision.preflightSupervision({ env, configPath: validKey, machineId: AUDIENCE }),
    { configured: true, source: 'env', service_persistence: 'configured' }, 'env valid + persistent valid');
  assert.deepEqual(supervision.preflightSupervision({ env, configPath: path.join(root, 'absent.json'), machineId: AUDIENCE }),
    { configured: true, source: 'env', service_persistence: 'not_configured' }, 'positive control: env valid + config absent');
  assert.deepEqual(supervision.preflightSupervision({ env, configPath: write('nokey', {}), machineId: AUDIENCE }),
    { configured: true, source: 'env', service_persistence: 'not_configured' }, 'positive control: env valid + config without the key');
  // A bad env value is still this process's own refusal, and the daemon's own resolution keeps env precedence.
  const envBad = thrown(() => supervision.preflightSupervision({ env: { TELEPTY_SUPERVISION_TRUST_FILE: path.join(root, 'keys', 'nope.json') },
    configPath: validKey, machineId: AUDIENCE }));
  assert.equal(envBad.code, 'PRINCIPAL_TRUST_UNAVAILABLE');
  assert.equal(envBad.scope, 'calling_process');
  assert.deepEqual(supervision.resolveSupervisionTrustFile({ env, config: { supervisionTrustFile: 'relative/x' } }), { file: envFile, source: 'env' },
    'daemon boot resolution is unchanged: env wins and the config is not validated there');
});

// The audience is decided by the existing loader (validateTrustConfiguration): preflight must agree with the daemon's
// own factory in every case, never be a stricter or looser copy. (A file's own `audience`, when present, is used by
// both; recorded in REVIEW.md as a plan-vs-source note.)
test('T2 audience: preflight decides exactly as the daemon factory does', (t) => {
  const root = privateRoot(t);
  const absent = path.join(root, 'absent.json');   // service46: hermetic — the service view would otherwise read the default config
  const cases = [
    ['matching audience', trustFile(root, { name: 'a1.json' }), AUDIENCE],
    ['other audience in file', trustFile(root, { name: 'a2.json', audience: 'another-host' }), AUDIENCE],
    ['no audience, valid machine id', trustFile(root, { name: 'a3.json', omitAudience: true }), AUDIENCE],
    ['no audience, invalid machine id', trustFile(root, { name: 'a4.json', omitAudience: true }), 'not an audience'],
  ];
  for (const [label, file, machineId] of cases) {
    const env = { TELEPTY_SUPERVISION_TRUST_FILE: file };
    const pre = outcome(() => supervision.preflightSupervision({ env, machineId, configPath: absent }));
    const daemon = outcome(() => createSupervisionAuthenticationFromEnvironment({ env, machineId, sessions: () => ({}) }));
    assert.equal(pre, daemon, `${label}: preflight and the daemon factory must agree`);
  }
  if (!WIN) {
    assert.equal(outcome(() => supervision.preflightSupervision({ env: { TELEPTY_SUPERVISION_TRUST_FILE: cases[0][1] }, machineId: AUDIENCE, configPath: absent })), 'ok');
    assert.equal(outcome(() => supervision.preflightSupervision({ env: { TELEPTY_SUPERVISION_TRUST_FILE: cases[3][1] }, machineId: 'not an audience', configPath: absent })), 'refused');
  }
});

// ── T8 status view ────────────────────────────────────────────────────────────────────────────────────────────

test('T8 status view: configured/source/preflight only, daemon effective policy unmeasured, no path', (t) => {
  const root = privateRoot(t);
  const file = trustFile(root);
  const valid = configFile(root, { supervisionTrustFile: file });
  const invalidPath = path.join(root, 'home', '.telepty', 'invalid.json');
  writePrivate(invalidPath, JSON.stringify({ authToken: 'x', supervisionTrustFile: 'relative/s36-secret.json' }));
  const unreadable = path.join(root, 'home', '.telepty', 'unreadable.json');
  writePrivate(unreadable, '{"authToken":"s36-REAL-SECR');
  const views = {
    valid: supervision.describeSupervision({ env: {}, configPath: valid, machineId: AUDIENCE }),
    invalid: supervision.describeSupervision({ env: {}, configPath: invalidPath }),
    unreadable: supervision.describeSupervision({ env: {}, configPath: unreadable }),
    absent: supervision.describeSupervision({ env: {}, configPath: path.join(root, 'absent.json') }),
  };
  assert.deepEqual(views.valid, { configured: true, source: 'config', preflight: WIN ? 'SUPERVISION_UNSUPPORTED_PLATFORM' : 'ok',
    failed_scope: WIN ? 'service_persistence' : null, service_persistence: 'configured', daemon_effective: 'unmeasured' });
  assert.deepEqual(views.invalid, { configured: true, source: 'config', preflight: 'SUPERVISION_CONFIG_INVALID', failed_scope: 'service_persistence',
    service_persistence: 'invalid', daemon_effective: 'unmeasured' });
  assert.deepEqual(views.unreadable, { configured: null, source: null, preflight: 'SUPERVISION_CONFIG_UNREADABLE', failed_scope: 'service_persistence',
    service_persistence: 'unreadable', daemon_effective: 'unmeasured' });
  assert.deepEqual(views.absent, { configured: false, source: null, preflight: 'not_configured', failed_scope: null, service_persistence: 'not_configured',
    daemon_effective: 'unmeasured' });
  // service46 S1: env valid + persistent invalid is reported as a refusal of the PERSISTENT setting, env valid + absent as ok/guarded.
  views.envInvalidKey = supervision.describeSupervision({ env: { TELEPTY_SUPERVISION_TRUST_FILE: file }, configPath: invalidPath, machineId: AUDIENCE });
  views.envAbsentKey = supervision.describeSupervision({ env: { TELEPTY_SUPERVISION_TRUST_FILE: file }, configPath: path.join(root, 'absent.json'), machineId: AUDIENCE });
  assert.deepEqual(views.envInvalidKey, { configured: true, source: 'env', preflight: WIN ? 'SUPERVISION_UNSUPPORTED_PLATFORM' : 'SUPERVISION_CONFIG_INVALID',
    failed_scope: WIN ? 'calling_process' : 'service_persistence', service_persistence: 'invalid', daemon_effective: 'unmeasured' });
  assert.deepEqual(views.envAbsentKey, { configured: true, source: 'env', preflight: WIN ? 'SUPERVISION_UNSUPPORTED_PLATFORM' : 'ok',
    failed_scope: WIN ? 'calling_process' : null, service_persistence: 'not_configured', daemon_effective: 'unmeasured' });
  assertNoLeak(JSON.stringify(views), [file, root, 's36-secret', 's36-REAL-SECR'], 'status');
});

// ── T5 descriptors ────────────────────────────────────────────────────────────────────────────────────────────

test('T5 descriptors: plist, unit and schtasks string are byte-identical with and without the key and never carry it', (t) => {
  const root = privateRoot(t);
  const file = path.join(root, 'keys', 'trust.json');
  const profile = resolveServiceProfile();
  const launch = { nodeBin: '/opt/s36/bin/node', cliJs: '/opt/s36/pkg/cli.js', logDir: '/home/s36/.telepty/logs' };
  const build = () => [
    buildLaunchdPlist({ ...launch, label: profile.launchdLabel, command: profile.command, extraEnv: profile.extraEnv }),
    buildSystemdService({ ...launch, wantedBy: 'default.target', command: profile.command, description: profile.description, extraEnv: profile.extraEnv }),
    buildWindowsAutostartCommand({ ...launch, taskName: profile.windowsTask, command: profile.command }),
  ];
  const without = build();
  configFile(root, { supervisionTrustFile: file });
  const saved = process.env.TELEPTY_SUPERVISION_TRUST_FILE;
  process.env.TELEPTY_SUPERVISION_TRUST_FILE = file;
  let withKey;
  try { withKey = build(); } finally {
    if (saved === undefined) delete process.env.TELEPTY_SUPERVISION_TRUST_FILE; else process.env.TELEPTY_SUPERVISION_TRUST_FILE = saved;
  }
  assert.deepEqual(withKey, without, 'the setting is never written into a descriptor');
  assert.deepEqual(profile.extraEnv, {}, 'the service profile forwards no environment');
  for (const text of withKey) assertNoLeak(text, [file, 'supervisionTrustFile', 'TELEPTY_SUPERVISION'], 'descriptor');
});

// ── T6 / T7 / T8 the real daemon boot ─────────────────────────────────────────────────────────────────────────

function daemonEnv(extra = {}) {
  // '' is "unset" for both the resolver and the daemon factories, and overrides anything inherited.
  return { TELEPTY_MACHINE_ID: AUDIENCE, TELEPTY_SUPERVISION_TRUST_FILE: '', TELEPTY_PRINCIPAL_MODE: '', TELEPTY_NO_TAILNET_AUTO: '1',
    TELEPTY_NO_SUPERVISOR_DEFER: '1', ...extra };
}
async function bootDaemon(homeDir, env) {
  try { return { daemon: await startTestDaemon({ homeDir, env }), error: null }; } catch (error) { return { daemon: null, error }; }
}
function logsOf(daemon, error) {
  if (daemon) { const { stdout, stderr } = daemon.getLogs(); return `${stdout}\n${stderr}`; }
  return String(error && error.message);
}

test('T6 daemon boot: a config-only key is loaded by the real daemon (challenge 200); Windows refuses explicitly', { timeout: 60000 }, async (t) => {
  const root = privateRoot(t);
  const file = trustFile(root);
  configFile(root, { supervisionTrustFile: file });
  const { daemon, error } = await bootDaemon(path.join(root, 'home'), daemonEnv());
  try {
    assertNoLeak(logsOf(daemon, error), [file], 'daemon logs');
    if (WIN) {
      assert.ok(error, 'win32: the configured setting must stop the boot, not be ignored');
      assert.match(error.message, /PRINCIPAL_TRUST_UNAVAILABLE/);
      return;
    }
    assert.ifError(error);
    const challenge = await daemon.request('/api/auth/challenge');
    assert.equal(challenge.status, 200, 'the persistent key turned combined-mode supervision on');
    assert.equal(challenge.body.audience, AUDIENCE);
  } finally { if (daemon) await daemon.stop(); }
});

test('T6 daemon boot: an invalid key stops the boot with SUPERVISION_CONFIG_INVALID and no value in the output', { timeout: 60000 }, async (t) => {
  const root = privateRoot(t);
  configFile(root, { supervisionTrustFile: 'relative/s36-secret-trust.json' });
  const { daemon, error } = await bootDaemon(path.join(root, 'home'), daemonEnv());
  try {
    assert.equal(daemon, null, 'a present invalid value must never boot with supervision silently off');
    assert.match(error.message, /SUPERVISION_CONFIG_INVALID/);
    assertNoLeak(error.message, ['s36-secret-trust'], 'daemon stderr');
  } finally { if (daemon) await daemon.stop(); }
});

test('T6 daemon boot: absent key and env stay guarded (challenge 404)', { timeout: 60000 }, async (t) => {
  const root = privateRoot(t);
  configFile(root, {});
  const { daemon, error } = await bootDaemon(path.join(root, 'home'), daemonEnv());
  try {
    assert.ifError(error);
    assert.equal((await daemon.request('/api/auth/challenge')).status, 404);
  } finally { if (daemon) await daemon.stop(); }
});

test('T7 daemon boot: a non-empty env value wins over an invalid config key', { timeout: 60000 }, async (t) => {
  const root = privateRoot(t);
  const file = trustFile(root);
  configFile(root, { supervisionTrustFile: 7 });
  const { daemon, error } = await bootDaemon(path.join(root, 'home'), daemonEnv({ TELEPTY_SUPERVISION_TRUST_FILE: file }));
  try {
    if (WIN) { assert.ok(error); assert.match(error.message, /PRINCIPAL_TRUST_UNAVAILABLE/); return; }
    assert.ifError(error);
    assert.equal((await daemon.request('/api/auth/challenge')).status, 200);
  } finally { if (daemon) await daemon.stop(); }
});

test('T6 daemon boot: #843 C recovery — env token + unreadable config boots GUARDED and says the setting is UNAVAILABLE', { timeout: 60000 }, async (t) => {
  const root = privateRoot(t);
  const configPath = configFile(root, '{"authToken":"s36-REAL-SECR');
  const before = fs.readFileSync(configPath);
  const token = `s36-env-${crypto.randomUUID()}`;
  const { daemon, error } = await bootDaemon(path.join(root, 'home'), daemonEnv({ TELEPTY_AUTH_TOKEN: token }));
  try {
    assert.ifError(error);
    const logs = logsOf(daemon, error);
    assert.match(logs, /\[SUPERVISION\][^\n]*UNAVAILABLE/, 'unavailable, not absent — said where a service log keeps it');
    assert.equal((await daemon.request('/api/auth/challenge')).status, 404, 'guarded');
    // Only the new [SUPERVISION] line is this change's output (the pre-existing [CONFIG] line is #843 C's, unchanged).
    assertNoLeak(logs.split('\n').filter((line) => line.includes('[SUPERVISION]')).join('\n'), ['s36-REAL-SECR', configPath], '[SUPERVISION] log');
    assert.deepEqual(fs.readFileSync(configPath), before, 'the unreadable config is never rewritten');
  } finally { if (daemon) await daemon.stop(); }
});
