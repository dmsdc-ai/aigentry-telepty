'use strict';

// Task 1215 service41 — ONE shared allow admission (src/cli/allow-admission.js admitAllowInvocation), used by the real
// `telepty allow` and by the local, NON-MUTATING `telepty allow-check --input-policy user-supervised`.
//   TA1 a valid operator client + key: exit 0 and exactly one whitelisted JSON line; no effect of any kind
//   TA2 every refusal (nested session, strict valid/invalid, handoff, cooperative, credential refresh, client unset,
//       and every client-file/key rule) ⇒ exit 1, no ok line, no effect
//   TA3 any other argv (including --help) ⇒ exit 2, usage, no effect
//   TA4 the same fixtures through the REAL `telepty allow … --input-policy user-supervised` refuse with today's texts
//       BEFORE ensureDaemonRunning / registration; both commands call the one admitAllowInvocation
//   TA5 a refused real allow creates no credential channel
// Every run is the real `node cli.js` (so eager CLI startup is inside the measurement) under a preload that RECORDS
// AND BLOCKS every file write/mkdir, network connect/fetch/DNS, listener and child process, plus a before/after
// snapshot of the child's private HOME and TMPDIR. No daemon, service or network is reachable; nothing is skipped.
// Expected on the ORIGINAL source (not executed here): TA1/TA2/TA3 fail (`allow-check` is an unknown command: global
// help, exit 0); TA4 nested/strict/handoff/cooperative/supervision texts hold but the static pin fails (no shared
// module); TA5 fails on Linux (the channel's mkdir runs before admission).
// Windows: the authority-file reader has no backend, so the valid fixture is asserted as SUPERVISION_CLIENT_INVALID.

process.env.TELEPTY_DISABLE_UPDATE_NOTIFIER = '1';
process.env.NO_UPDATE_NOTIFIER = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'cli.js');
const pkg = require('../package.json');
const WIN = process.platform === 'win32';
const PORT = '39041';
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SCHEMA = 'telepty.allow-admission/v1';
const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
// Today's refusal texts, pinned here (not imported) so a changed text is a failure.
const TEXT = {
  ALLOW_PRINCIPAL_CLIENT_INVALID: 'Strict allow requires a checked principal client configuration for this local daemon and a local child.',
  ALLOW_HANDOFF_CREDENTIAL_INVALID: 'Invalid or unsafe cooperative handoff credential file.',
  ALLOW_COOPERATIVE_REQUIRES_STRICT: 'Cooperative handoff requires an explicit strict principal client.',
  SUPERVISION_STRICT_CONFLICT: 'TELEPTY_SUPERVISION_CLIENT_FILE cannot be combined with TELEPTY_PRINCIPAL_CLIENT_FILE (strict mode signs every request itself). Nothing was started.',
  SUPERVISION_POLICY_MISMATCH: 'TELEPTY_SUPERVISION_CLIENT_FILE is used only with --input-policy user-supervised. Nothing was started.',
  SUPERVISION_CLIENT_INVALID: 'Supervision requires a checked operator client configuration (TELEPTY_SUPERVISION_CLIENT_FILE) for this local daemon and a local child. Nothing was started.',
};
const NESTED_TEXT = '--input-policy user-supervised is only for a host launch, not from inside a telepty session.';

// Loaded with --require BEFORE cli.js, so every reference cli.js and its modules take is already the blocking one.
const PRELOAD = `'use strict';
const fs = require('fs');
const append = fs.appendFileSync.bind(fs);
const LOG = process.env.S41_EFFECT_LOG;
function record(kind, detail) { try { append(LOG, JSON.stringify({ kind, detail: String(detail).slice(0, 160) }) + '\\n'); } catch {} }
function block(kind) { return function blocked(first) { record(kind, first); throw Object.assign(new Error('S41 blocked ' + kind), { code: 'S41_BLOCKED' }); }; }
for (const n of ['mkdirSync', 'mkdtempSync', 'writeFileSync', 'appendFileSync', 'rmSync', 'rmdirSync', 'renameSync', 'linkSync', 'symlinkSync',
  'unlinkSync', 'copyFileSync', 'truncateSync', 'chmodSync', 'chownSync', 'createWriteStream', 'mkdir', 'mkdtemp', 'writeFile', 'appendFile',
  'rm', 'rename', 'unlink', 'copyFile']) fs[n] = block('fs.' + n);
for (const n of ['mkdir', 'mkdtemp', 'writeFile', 'appendFile', 'rm', 'rename', 'unlink', 'open', 'copyFile']) fs.promises[n] = block('fs.promises.' + n);
const openSync = fs.openSync.bind(fs), C = fs.constants;
const WRITE_BITS = C.O_WRONLY | C.O_RDWR | C.O_CREAT | C.O_TRUNC | C.O_APPEND;
fs.openSync = function (p, flags, ...rest) {
  const writes = typeof flags === 'number' ? (flags & WRITE_BITS) !== 0 : (flags !== undefined && flags !== 'r' && flags !== 'rs');
  if (writes) { record('fs.openSync(write)', p); throw Object.assign(new Error('S41 blocked open for write'), { code: 'S41_BLOCKED' }); }
  return openSync(p, flags, ...rest);
};
globalThis.fetch = block('fetch');
const net = require('net');
net.connect = net.createConnection = block('net.connect');
net.Socket.prototype.connect = block('net.Socket.connect');
net.Server.prototype.listen = block('net.Server.listen');
for (const m of ['http', 'https']) { const mod = require(m); mod.request = block(m + '.request'); mod.get = block(m + '.get'); }
const dns = require('dns'); dns.lookup = block('dns.lookup'); dns.promises.lookup = block('dns.promises.lookup');
require('dgram').createSocket = block('dgram.createSocket');
const cp = require('child_process');
for (const n of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[n] = block('child_process.' + n);
`;

function privateRoot(t) {
  // realpath: the authority-file walk refuses symlinked ancestors (macOS /var -> /private/var).
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'telepty-1215-s41-'));
  fs.chmodSync(root, 0o700);
  for (const part of ['home', 'tmp', 'keys', 'open']) fs.mkdirSync(path.join(root, part), { mode: 0o700 });
  fs.chmodSync(path.join(root, 'open'), 0o777);   // a world-writable, NON-sticky ancestor
  fs.writeFileSync(path.join(root, 'preload.js'), PRELOAD, { mode: 0o600 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function writePrivate(file, content, mode = 0o600) { fs.writeFileSync(file, content, { mode, flag: 'wx' }); fs.chmodSync(file, mode); }
function keyFile(root, name, { type = 'ed25519', mode = 0o600 } = {}) {
  const file = path.join(root, 'keys', `${name}.pem`);
  writePrivate(file, crypto.generateKeyPairSync(type).privateKey.export({ type: 'pkcs8', format: 'pem' }), mode);
  return file;
}
function clientFile(root, name, { dir = 'keys', key, mode = 0o600, overrides = {}, extra = {}, pad = 0 } = {}) {
  const file = path.join(root, dir, `${name}.json`);
  const body = { schema: 'telepty.principal-client/v1', daemon_url: ORIGIN, principal_id: 'operator', key_id: 'operator-key',
    audience: 'telepty-1215-s41', private_key_path: key, ...overrides, ...extra };
  writePrivate(file, JSON.stringify(body) + ' '.repeat(pad), mode);
  return file;
}
function snapshot(dir) {
  const out = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(`${e.isDirectory() ? 'd' : 'f'} ${r}`);
      if (e.isDirectory()) walk(path.join(d, e.name), r);
    }
  })(dir, '');
  return out;
}
function childEnv(root, extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('TELEPTY_') || key.startsWith('AIGENTRY_TELEPTY_') || PROXY_KEYS.includes(key)
    || ['NODE_OPTIONS', 'PORT', 'HOST', 'NODE_TEST_CONTEXT'].includes(key)) delete env[key];
  const home = path.join(root, 'home'), tmp = path.join(root, 'tmp');
  return { ...env, HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp, TELEPTY_PORT: PORT, TELEPTY_NO_TAILNET_AUTO: '1',
    TELEPTY_DISABLE_UPDATE_NOTIFIER: '1', NO_UPDATE_NOTIFIER: '1', S41_EFFECT_LOG: path.join(root, 'effects.log'), ...extra };
}
// One real CLI process; → { status, signal, stdout, stderr, effects, unchanged }.
function runCli(root, argv, extra = {}) {
  const watched = [path.join(root, 'home'), path.join(root, 'tmp')];
  const before = watched.map(snapshot);
  try { fs.rmSync(path.join(root, 'effects.log'), { force: true }); } catch {}
  const r = spawnSync(process.execPath, ['--require', path.join(root, 'preload.js'), CLI, ...argv], { cwd: ROOT, env: childEnv(root, extra),
    encoding: 'utf8', shell: false, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.ifError(r.error);
  let effects = [];
  try { effects = fs.readFileSync(path.join(root, 'effects.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, effects, unchanged: JSON.stringify(watched.map(snapshot)) === JSON.stringify(before) };
}
function assertNoEffect(r, root, label) {
  assert.deepEqual(r.effects, [], `${label}: no write, network, listener or child process`);
  assert.equal(r.unchanged, true, `${label}: HOME and TMPDIR unchanged (no config minted, no channel, no state)`);
  assert.equal(r.signal, null, label);
  for (const text of [r.stdout, r.stderr]) {
    assert.ok(!text.includes(root), `${label}: no path in output`);
    assert.ok(!/PRIVATE KEY|at .*\.js:\d+/.test(text), `${label}: no key bytes or stack`);
  }
}
function refusalLine(r, label) {
  assert.equal(r.status, 1, `${label}: exit 1`);
  assert.ok(r.stdout.endsWith('\n') && !r.stdout.slice(0, -1).includes('\n'), `${label}: exactly one stdout line`);
  const parsed = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(parsed), ['schema', 'ok', 'code'], label);
  assert.equal(parsed.schema, SCHEMA);
  assert.equal(parsed.ok, false);
  return parsed.code;
}
const CHECK = ['allow-check', '--input-policy', 'user-supervised'];
const REAL_ALLOW = (policy = 'user-supervised') => ['allow', '--id', 's41-real', '--input-policy', policy, '--', process.execPath, '-e', '0'];

// The refusal fixtures, built once per test root. → [label, env, expected checker code | {stderr}, real-allow expectation].
function fixtures(root) {
  const key = keyFile(root, 'operator');
  const valid = clientFile(root, 'valid', { key });
  const strict = clientFile(root, 'strict', { key: keyFile(root, 'strict') });
  const handoff = path.join(root, 'keys', 'handoff.json');
  writePrivate(handoff, JSON.stringify({ schema: 'telepty.handoff-credential/v1' }));
  const fileCase = (label, file) => [label, { TELEPTY_SUPERVISION_CLIENT_FILE: file }, 'SUPERVISION_CLIENT_INVALID', 'SUPERVISION_CLIENT_INVALID'];
  const cases = [
    ['nested TELEPTY_SESSION_ID', { TELEPTY_SUPERVISION_CLIENT_FILE: valid, TELEPTY_SESSION_ID: 'outer' }, { stderr: NESTED_TEXT }, { stderr: NESTED_TEXT }],
    ['nested TELEPTY_SESSION_TOKEN', { TELEPTY_SUPERVISION_CLIENT_FILE: valid, TELEPTY_SESSION_TOKEN: 'outer.token' }, { stderr: NESTED_TEXT }, { stderr: NESTED_TEXT }],
    ['strict client valid + supervision', { TELEPTY_SUPERVISION_CLIENT_FILE: valid, TELEPTY_PRINCIPAL_CLIENT_FILE: strict },
      WIN ? 'ALLOW_PRINCIPAL_CLIENT_INVALID' : 'SUPERVISION_STRICT_CONFLICT', WIN ? 'ALLOW_PRINCIPAL_CLIENT_INVALID' : 'SUPERVISION_STRICT_CONFLICT'],
    ['strict client invalid', { TELEPTY_SUPERVISION_CLIENT_FILE: valid, TELEPTY_PRINCIPAL_CLIENT_FILE: path.join(root, 'keys', 'absent.json') },
      'ALLOW_PRINCIPAL_CLIENT_INVALID', 'ALLOW_PRINCIPAL_CLIENT_INVALID'],
    ['handoff credential without strict', { TELEPTY_SUPERVISION_CLIENT_FILE: valid, TELEPTY_HANDOFF_CREDENTIAL_FILE: handoff },
      'ALLOW_HANDOFF_CREDENTIAL_INVALID', 'ALLOW_HANDOFF_CREDENTIAL_INVALID'],
    ['cooperative without strict', { TELEPTY_SUPERVISION_CLIENT_FILE: valid, TELEPTY_COOPERATIVE_HANDOFF: '1' },
      'ALLOW_COOPERATIVE_REQUIRES_STRICT', 'ALLOW_COOPERATIVE_REQUIRES_STRICT'],
    ['credential refresh', { TELEPTY_SUPERVISION_CLIENT_FILE: valid, TELEPTY_SESSION_CREDENTIAL_REFRESH: '1' }, 'ALLOW_CHECK_CREDENTIAL_REFRESH_UNSUPPORTED', null],
    ['client unset', {}, 'ALLOW_CHECK_SUPERVISION_CLIENT_REQUIRED', null],
    fileCase('client file missing', path.join(root, 'keys', 'missing.json')),
    fileCase('client file > 16384 B', clientFile(root, 'oversize', { key, pad: 16500 })),
    fileCase('world-writable non-sticky ancestor', clientFile(root, 'ancestor', { key, dir: 'open' })),
    fileCase('group-readable client file', clientFile(root, 'grouped', { key, mode: 0o640 })),
    fileCase('wrong schema', clientFile(root, 'schema', { key, overrides: { schema: 'telepty.principal-client/v0' } })),
    fileCase('extra field', clientFile(root, 'extra', { key, extra: { note: 'x' } })),
    fileCase('daemon_url is not the local origin', clientFile(root, 'origin', { key, overrides: { daemon_url: 'http://127.0.0.1:39999' } })),
    fileCase('key missing', clientFile(root, 'keymissing', { key: path.join(root, 'keys', 'nokey.pem') })),
    fileCase('key unsafe mode', clientFile(root, 'keyunsafe', { key: keyFile(root, 'unsafe', { mode: 0o644 }) })),
    fileCase('key not ed25519', clientFile(root, 'keytype', { key: keyFile(root, 'x25519', { type: 'x25519' }) })),
  ];
  if (!WIN) {
    const link = path.join(root, 'keys', 'symlink.json');
    fs.symlinkSync(valid, link);
    cases.push(fileCase('client file is a symlink', link));
  }
  return { valid, cases };
}

test('TA1 allow-check: a valid operator client + key ⇒ exit 0 and exactly one whitelisted JSON line, with no effect', { timeout: 60000 }, (t) => {
  const root = privateRoot(t);
  const { valid } = fixtures(root);
  const r = runCli(root, CHECK, { TELEPTY_SUPERVISION_CLIENT_FILE: valid });
  assertNoEffect(r, root, 'TA1');
  if (WIN) { assert.equal(refusalLine(r, 'TA1 win32'), 'SUPERVISION_CLIENT_INVALID', 'win32 has no authority-file backend'); return; }
  assert.equal(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  assert.equal(r.stderr, '');
  assert.ok(r.stdout.endsWith('\n') && !r.stdout.slice(0, -1).includes('\n'), 'exactly one line');
  assert.ok(Buffer.byteLength(r.stdout) <= 1024, '≤ 1 KiB');
  const parsed = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(parsed), ['schema', 'ok', 'telepty_version', 'input_policy', 'supervision_client', 'daemon_origin'], 'whitelisted fields only');
  assert.deepEqual(parsed, { schema: SCHEMA, ok: true, telepty_version: pkg.version, input_policy: 'user-supervised', supervision_client: 'loaded', daemon_origin: ORIGIN });
});

test('TA2 allow-check: every refusal ⇒ exit 1, no ok line, no effect', { timeout: 120000 }, (t) => {
  const root = privateRoot(t);
  for (const [label, env, expected] of fixtures(root).cases) {
    const r = runCli(root, CHECK, env);
    assertNoEffect(r, root, label);
    assert.ok(!r.stdout.includes('"ok":true'), `${label}: never an ok line`);
    if (expected && typeof expected === 'object') {
      assert.equal(r.status, 1, label);
      assert.equal(r.stdout, '', `${label}: parse refusal keeps its stderr text only`);
      assert.ok(r.stderr.includes(expected.stderr), label);
    } else {
      assert.equal(refusalLine(r, label), expected, label);
    }
  }
});

test('TA3 allow-check: any other argv (including --help) ⇒ exit 2, usage, no effect', { timeout: 60000 }, (t) => {
  const root = privateRoot(t);
  const { valid } = fixtures(root);
  const argvs = [[], ['--input-policy'], ['--input-policy', 'guarded'], ['--input-policy', 'user-supervised', 'extra'], ['--help'], ['-h'],
    ['--input-policy', 'user-supervised', '--help'], ['user-supervised', '--input-policy'], ['--input-policy=user-supervised'],
    ['--id', 'x', '--input-policy', 'user-supervised'], ['--', '--input-policy', 'user-supervised']];
  for (const extra of argvs) {
    const r = runCli(root, ['allow-check', ...extra], { TELEPTY_SUPERVISION_CLIENT_FILE: valid });
    const label = JSON.stringify(extra);
    assertNoEffect(r, root, label);
    assert.equal(r.status, 2, `${label}: exit 2`);
    assert.equal(r.stdout, '', label);
    assert.match(r.stderr, /Usage: telepty allow-check --input-policy user-supervised/, label);
  }
});

test('TA4 real allow: the same fixtures refuse with today\'s texts BEFORE ensureDaemonRunning or registration', { timeout: 120000 }, (t) => {
  const root = privateRoot(t);
  const { valid, cases } = fixtures(root);
  const realCases = cases.filter(([, , , real]) => real !== null)
    .concat([['policy mismatch (guarded + supervision client)', { TELEPTY_SUPERVISION_CLIENT_FILE: valid }, null, 'SUPERVISION_POLICY_MISMATCH', 'guarded']]);
  for (const [label, env, , expected, policy] of realCases) {
    const r = runCli(root, REAL_ALLOW(policy), env);
    assertNoEffect(r, root, `real allow ${label}`);   // ensureDaemonRunning would fetch/spawn; registration would fetch
    assert.equal(r.status, 1, `real allow ${label}: exit 1`);
    assert.ok(r.stderr.includes(typeof expected === 'object' ? expected.stderr : TEXT[expected]), `real allow ${label}: today's text`);
  }
  // The shared pin, on the shipped sources: one definition, called by both commands; no second copy of any refusal.
  const cliSource = fs.readFileSync(CLI, 'utf8');
  const helper = fs.readFileSync(path.join(ROOT, 'src', 'cli', 'allow-admission.js'), 'utf8');
  assert.equal((helper.match(/function admitAllowInvocation\(/g) || []).length, 1);
  assert.equal((cliSource.match(/\.admitAllowInvocation\(/g) || []).length, 2, 'allow and allow-check both call it');
  assert.equal((cliSource.match(/require\('\.\/src\/cli\/allow-admission'\)/g) || []).length, 2);
  for (const text of Object.values(TEXT)) assert.ok(!cliSource.includes(text), 'no refusal text duplicated in cli.js');
  for (const text of Object.values(TEXT)) assert.ok(helper.includes(text), 'every refusal text lives in the shared helper');
});

test('TA5 a refused real allow creates no credential channel', { timeout: 60000 }, (t) => {
  const root = privateRoot(t);
  const { cases } = fixtures(root);
  const refusing = [cases.find(([label]) => label === 'cooperative without strict'), cases.find(([label]) => label === 'client file missing')];
  for (const [label, env, , expected] of refusing) {
    const r = runCli(root, REAL_ALLOW(), { ...env, TELEPTY_SESSION_CREDENTIAL_REFRESH: '1' });
    assertNoEffect(r, root, `refresh + ${label}`);   // the channel's mkdir under TMPDIR would be recorded and blocked
    assert.ok(!r.effects.some((e) => /telepty-credential-/.test(e.detail)), 'no channel directory attempted');
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes(TEXT[expected]), `${label}: the admission refusal, not a channel error`);
  }
});
