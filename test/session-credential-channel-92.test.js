'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { createSessionCredentialChannel, readSessionCredential } = require('../src/session-credential-channel');
const linux = { skip: process.platform !== 'linux' };
function issued(number) {
  const epoch = Buffer.alloc(16, number).toString('base64url');
  return { session_id: 'fixture', session_epoch: epoch, credential_generation: 1,
    session_token: `${epoch}.${Buffer.alloc(32, number).toString('base64url')}` };
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-channel-test-'));
  const channel = createSessionCredentialChannel({ sessionId: 'fixture', root });
  return { root, channel, options: { credentialPath: channel.credentialPath, instance: channel.instance, sessionId: 'fixture' },
    cleanup() { channel.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
function binding(data) { return { sid: data.session_id, session_epoch: data.session_epoch, credential_generation: data.credential_generation }; }
function bind(channel, data) {
  channel.stageRegistration({ ok: true }, data);
  const attempt = channel.beginAttempt(data.session_token);
  return channel.acknowledgeOwner({ attempt, bearer: data.session_token, ownerToken: 'fixture-owner', binding: binding(data) });
}

test('requested unsupported platforms refuse before filesystem publication', () => {
  for (const platform of ['darwin', 'win32']) {
    assert.throws(() => createSessionCredentialChannel({ sessionId: 'fixture', platform }), { code: 'CREDENTIAL_CHANNEL_UNSUPPORTED' });
  }
});

test('Linux anchored rename is atomic, private, fsynced, and preserves an already-open old snapshot', linux, () => {
  const f = fixture();
  let oldFile;
  try {
    const calls = [];
    const original = fs.fsyncSync;
    fs.fsyncSync = fd => { calls.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file'); return original(fd); };
    try { assert.equal(bind(f.channel, issued(1)), true); } finally { fs.fsyncSync = original; }
    assert.deepEqual(calls, ['file', 'directory']);
    assert.equal(fs.statSync(path.dirname(f.channel.credentialPath)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(f.channel.credentialPath).mode & 0o777, 0o600);
    oldFile = fs.openSync(f.channel.credentialPath, 'r');
    bind(f.channel, issued(2));
    const old = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
    const current = readSessionCredential(f.options);
    assert.equal(old.session_epoch, issued(1).session_epoch);
    assert.equal(current.session_epoch, issued(2).session_epoch);
    assert.equal(current.sequence, 2);
    assert.ok(!Object.hasOwn(current, 'session_nonce'));
    assert.deepEqual(fs.readdirSync(path.dirname(f.channel.credentialPath)), ['credential.json']);
    assert.throws(() => readSessionCredential({ ...f.options, epoch: old.session_epoch }), { code: 'CREDENTIAL_CHANNEL_STALE_PRINCIPAL' });
  } finally { if (oldFile !== undefined) fs.closeSync(oldFile); f.cleanup(); }
});

test('only successful issuance and the current attempt/bearer owner acknowledgment can publish', linux, () => {
  const f = fixture();
  try {
    const first = issued(3), next = issued(4);
    assert.equal(f.channel.stageRegistration({ ok: false }, first), false);
    assert.equal(fs.existsSync(f.channel.credentialPath), false);
    f.channel.stageRegistration({ ok: true }, first);
    const oldAttempt = f.channel.beginAttempt(first.session_token);
    f.channel.stageRegistration({ ok: true }, next);
    const attempt = f.channel.beginAttempt(next.session_token);
    for (const ack of [
      { attempt: oldAttempt, bearer: first.session_token, ownerToken: 'old-owner' },
      { attempt, bearer: first.session_token, ownerToken: 'wrong-bearer' },
      { attempt, bearer: next.session_token, ownerToken: '' },
      { attempt, bearer: next.session_token, ownerToken: 'mismatched-epoch', binding: binding(first) },
      { attempt, bearer: next.session_token, ownerToken: 'mismatched-generation', binding: { ...binding(next), credential_generation: 2 } }
    ]) assert.equal(f.channel.acknowledgeOwner(ack), false);
    assert.equal(fs.existsSync(f.channel.credentialPath), false);
    assert.equal(f.channel.acknowledgeOwner({ attempt, bearer: next.session_token, ownerToken: 'current-owner', binding: binding(next) }), true);
    assert.equal(readSessionCredential(f.options).session_epoch, next.session_epoch);
    assert.equal(f.channel.acknowledgeOwner({ attempt, bearer: next.session_token, ownerToken: 'duplicate', binding: binding(next) }), false);
    assert.equal(readSessionCredential(f.options).sequence, 1);
  } finally { f.cleanup(); }
});

test('same-name old wrapper refusal cleans only its random instance', linux, () => {
  const first = fixture();
  const successor = createSessionCredentialChannel({ sessionId: 'fixture', root: first.root });
  try {
    bind(first.channel, issued(5)); bind(successor, issued(6));
    assert.notEqual(first.channel.credentialPath, successor.credentialPath);
    assert.equal(first.channel.close(), true);
    assert.equal(fs.existsSync(first.channel.credentialPath), false);
    assert.equal(readSessionCredential({ credentialPath: successor.credentialPath, instance: successor.instance, sessionId: 'fixture' }).session_epoch, issued(6).session_epoch);
    assert.equal(first.channel.acknowledgeOwner({}), false);
  } finally { successor.close(); first.cleanup(); }
});

test('Linux file links, path escapes, instance mismatches and stale wrapper birth are rejected', linux, () => {
  for (const kind of ['symlink', 'hardlink', 'birth', 'mode']) {
    const f = fixture();
    try {
      bind(f.channel, issued(7));
      if (kind === 'birth') {
        const record = readSessionCredential(f.options);
        record.wrapper_birth.start_ticks = String(BigInt(record.wrapper_birth.start_ticks) + 1n);
        fs.writeFileSync(f.channel.credentialPath, JSON.stringify(record));
      } else if (kind === 'mode') fs.chmodSync(f.channel.credentialPath, 0o644);
      else {
        const outside = path.join(f.root, 'outside.json');
        fs.writeFileSync(outside, 'synthetic outside sentinel', { mode: 0o600 });
        fs.unlinkSync(f.channel.credentialPath);
        fs[kind === 'symlink' ? 'symlinkSync' : 'linkSync'](outside, f.channel.credentialPath);
        assert.throws(() => bind(f.channel, issued(8)), /Credential refresh refused/);
        assert.equal(fs.readFileSync(outside, 'utf8'), 'synthetic outside sentinel');
      }
      assert.throws(() => readSessionCredential(f.options), /Credential refresh refused/);
    } finally { f.cleanup(); }
  }
  const f = fixture();
  try {
    bind(f.channel, issued(9));
    assert.throws(() => readSessionCredential({ ...f.options, instance: '0'.repeat(32) }), /Credential refresh refused/);
    const credentialPath = path.join(path.dirname(f.channel.credentialPath), '..', path.basename(path.dirname(f.channel.credentialPath)), 'credential.json');
    const unnormalized = credentialPath.replace('/credential.json', '/../' + path.basename(path.dirname(credentialPath)) + '/credential.json');
    assert.throws(() => readSessionCredential({ ...f.options, credentialPath: unnormalized }), /Credential refresh refused/);
  } finally { f.cleanup(); }
});

test('Linux directory swap cannot redirect anchored publication or cleanup into an incumbent', linux, () => {
  const f = fixture();
  const directory = path.dirname(f.channel.credentialPath);
  const displaced = path.join(f.root, 'displaced');
  const incumbent = path.join(f.root, 'incumbent');
  try {
    bind(f.channel, issued(10));
    fs.mkdirSync(incumbent, { mode: 0o700 });
    const sentinel = path.join(incumbent, 'credential.json');
    fs.writeFileSync(sentinel, 'incumbent sentinel', { mode: 0o600 });
    fs.renameSync(directory, displaced);
    fs.symlinkSync(incumbent, directory);
    assert.throws(() => bind(f.channel, issued(11)), /Credential refresh refused/);
    assert.equal(f.channel.close(), false);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'incumbent sentinel');
    assert.equal(JSON.parse(fs.readFileSync(path.join(displaced, 'credential.json'), 'utf8')).sequence, 1);
  } finally { f.cleanup(); }
});

test('already-running isolated child reads the refreshed record through its inherited stable handle', { ...linux, timeout: 15000 }, async () => {
  const f = fixture();
  let child;
  try {
    bind(f.channel, issued(12));
    child = fork(path.join(__dirname, '../test-support/credential-reader-92.js'), [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      execArgv: ['--require', path.join(__dirname, '../test-support/setup-env.js')],
      env: { HOME: process.env.HOME, PATH: process.env.PATH, TELEPTY_SESSION_TOKEN: issued(12).session_token, TELEPTY_SESSION_ID: 'fixture', TELEPTY_SESSION_CREDENTIAL_PATH: f.channel.credentialPath, TELEPTY_SESSION_CREDENTIAL_INSTANCE: f.channel.instance }
    });
    let output = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    const response = message => new Promise((resolve, reject) => {
      child.once('message', resolve); child.once('error', reject); child.send(message);
    });
    assert.equal((await response({ epoch: issued(12).session_epoch, initialEpoch: issued(12).session_epoch })).matches, true);
    bind(f.channel, issued(13));
    const result = await response({ epoch: issued(13).session_epoch, initialEpoch: issued(12).session_epoch });
    assert.equal(result.matches, true); assert.equal(result.sequence, 2);
    assert.equal(result.environmentUnchanged, true);
    assert.equal(output, '');
    await new Promise(resolve => { child.once('exit', resolve); child.send({ exit: true }); });
  } finally { if (child && child.exitCode === null) child.kill(); f.cleanup(); }
});

test('production refused-owner cleanup removes only the old bridge channel and preserves incumbent state', linux, () => {
  const { createAllowSecurityContext } = require('../src/cli/security-actions');
  const f = fixture();
  const incumbent = createSessionCredentialChannel({ sessionId: 'fixture', root: f.root });
  try {
    bind(f.channel, issued(14)); bind(incumbent, issued(15));
    const shared = {
      credentialChannel: f.channel, allowSessionClosed: false,
      cleanupTerminal() {}, daemonWs: { close() {} }, allowSignalHandlers: new Map(),
      bridgeMailbox: { purge() { throw new Error('incumbent queue must not be purged'); } },
      fetchWithAuth() { throw new Error('incumbent session must not be deleted'); }
    };
    const context = createAllowSecurityContext(shared, { getStdout: () => ({ write() {} }) });
    assert.equal(context.closeAllowSession({ destroySession: false }), true);
    assert.equal(fs.existsSync(f.channel.credentialPath), false);
    assert.equal(readSessionCredential({ credentialPath: incumbent.credentialPath, instance: incumbent.instance, sessionId: 'fixture' }).session_epoch, issued(15).session_epoch);
  } finally { incumbent.close(); f.cleanup(); }
});

test('Linux rejects unsafe or linked ancestors and accepts private directories with spaces', linux, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-channel-ancestor-'));
  let channel;
  try {
    const unsafe = path.join(root, 'unsafe');
    fs.mkdirSync(unsafe); fs.chmodSync(unsafe, 0o777);
    assert.throws(() => createSessionCredentialChannel({ sessionId: 'fixture', root: unsafe }), /Credential refresh refused/);
    assert.deepEqual(fs.readdirSync(unsafe), []);
    const owned = path.join(root, 'private with spaces');
    fs.mkdirSync(owned, { mode: 0o700 });
    const link = path.join(root, 'linked');
    fs.symlinkSync(owned, link);
    assert.throws(() => createSessionCredentialChannel({ sessionId: 'fixture', root: link }), /Credential refresh refused/);
    channel = createSessionCredentialChannel({ sessionId: 'fixture', root: owned });
    bind(channel, issued(16));
    assert.equal(readSessionCredential({ credentialPath: channel.credentialPath, instance: channel.instance, sessionId: 'fixture' }).sequence, 1);
  } finally { channel?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
