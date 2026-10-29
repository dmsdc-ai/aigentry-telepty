'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadConfiguration } = require('../src/broker/main');
const { readAuthorityFile } = require('../src/principal/authority-file');

test('broker configuration and signing keys require checked Linux authority paths', { skip: process.platform !== 'linux' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-authority-'));
  const key = path.join(root, 'key.pem'), config = path.join(root, 'config.json');
  const pair = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(key, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const original = JSON.stringify({ private_key_path: key, marker: 'original' });
  fs.writeFileSync(config, original, { mode: 0o600 });
  try {
    assert.equal(loadConfiguration(config).config.marker, 'original');
    fs.chmodSync(config, 0o666);
    assert.throws(() => loadConfiguration(config), { code: 'BROKER_FILE_UNSAFE' });
    fs.chmodSync(config, 0o600);
    fs.chmodSync(root, 0o777);
    assert.throws(() => loadConfiguration(config), { code: 'BROKER_FILE_UNSAFE' });
    fs.chmodSync(root, 0o700);
    const alias = path.join(root, 'alias'); fs.symlinkSync(config, alias);
    assert.throws(() => loadConfiguration(alias), { code: 'BROKER_FILE_UNSAFE' });
    const hard = path.join(root, 'hard'); fs.linkSync(config, hard);
    assert.throws(() => loadConfiguration(config), { code: 'BROKER_FILE_UNSAFE' }); fs.unlinkSync(hard);
    fs.chmodSync(key, 0o644);
    assert.throws(() => loadConfiguration(config), { code: 'BROKER_FILE_UNSAFE' }); fs.chmodSync(key, 0o600);
    const keyAlias = path.join(root, 'key-alias'); fs.symlinkSync(key, keyAlias);
    fs.writeFileSync(config, JSON.stringify({ private_key_path: keyAlias }));
    assert.throws(() => loadConfiguration(config), { code: 'BROKER_FILE_UNSAFE' });
    const dirAlias = path.join(root, 'dir-alias'); fs.symlinkSync(root, dirAlias);
    assert.throws(() => readAuthorityFile(path.join(dirAlias, 'key.pem')), { code: 'AUTHORITY_FILE_UNAVAILABLE' });
    assert.throws(() => readAuthorityFile(key, { platform: 'win32' }), { code: 'AUTHORITY_FILE_UNAVAILABLE' });
    assert.throws(() => readAuthorityFile(key, { platform: 'darwin' }), { code: 'AUTHORITY_FILE_UNAVAILABLE' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('configuration replacement after open never changes the bytes being authorized', { skip: process.platform !== 'linux' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-swap-'));
  const config = path.join(root, 'config.json'), replacement = path.join(root, 'replacement');
  fs.writeFileSync(config, 'original', { mode: 0o600 });
  fs.writeFileSync(replacement, 'replacement', { mode: 0o666 });
  const read = fs.readSync;
  try {
    fs.readSync = function(fd, ...args) {
      if (fs.readlinkSync(`/proc/self/fd/${fd}`) === config) fs.renameSync(replacement, config);
      return read.call(fs, fd, ...args);
    };
    // Unlinking the opened inode changes ctime; either refuse the swap or return only
    // the checked original bytes, never the substituted writable authority document.
    try { assert.equal(readAuthorityFile(config).toString(), 'original'); }
    catch (reason) { assert.equal(reason.code, 'AUTHORITY_FILE_UNAVAILABLE'); }
  } finally { fs.readSync = read; fs.rmSync(root, { recursive: true, force: true }); }
});

test('TLS certificate and private key authority are checked before hub startup', { skip: process.platform !== 'linux' }, async () => {
  const { runBrokerCommand } = require('../src/broker/main');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-tls-authority-'));
  const key = path.join(root, 'key.pem'), cert = path.join(root, 'cert.pem'), config = path.join(root, 'config.json');
  const pair = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(key, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(cert, 'synthetic certificate', { mode: 0o666 });
  const document = { private_key_path: key, listen: { host: '127.0.0.1', port: 0, tls: { key_path: key, cert_path: cert } } };
  fs.writeFileSync(config, JSON.stringify(document), { mode: 0o600 });
  try {
    fs.chmodSync(cert, 0o666);
    await assert.rejects(runBrokerCommand('hub', config), { code: 'BROKER_FILE_UNSAFE' });
    fs.chmodSync(cert, 0o600);
    const linkedKey = path.join(root, 'linked-key'); fs.linkSync(key, linkedKey);
    await assert.rejects(runBrokerCommand('hub', config), { code: 'BROKER_FILE_UNSAFE' });
    fs.unlinkSync(linkedKey);
    const tlsKey = path.join(root, 'tls-key'); fs.writeFileSync(tlsKey, 'synthetic key', { mode: 0o644 });
    document.listen.tls.key_path = tlsKey; fs.writeFileSync(config, JSON.stringify(document));
    await assert.rejects(runBrokerCommand('hub', config), { code: 'BROKER_FILE_UNSAFE' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
