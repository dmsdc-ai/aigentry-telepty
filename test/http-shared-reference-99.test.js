'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSharedContextDescriptor, getSharedContextDir } = require('../shared-context');
const { MAX_SHARED_REFERENCE_BYTES } = require('../src/shared-reference-transfer');
const { startTestDaemon, waitFor } = require('../test-support/daemon-harness');

function bodyFor(content) {
  const { hash, fileName } = createSharedContextDescriptor(content);
  return { hash, fileName, content_base64: Buffer.from(content).toString('base64') };
}

test('HTTP ref transfer commits private verified content before inject and fails closed on refusal', async () => {
  const sender = await startTestDaemon({ env: { TELEPTY_AUTH_TOKEN: '' } });
  const receiver = await startTestDaemon({ env: { TELEPTY_AUTH_TOKEN: '' } });
  let owner;
  try {
    assert.notEqual(sender.authToken(), receiver.authToken());
    const peersPath = path.join(sender.homeDir, '.telepty', 'peers.json');
    fs.writeFileSync(peersPath, JSON.stringify({ peers: { destination: {
      transport: 'http', host: receiver.host, port: receiver.port,
      machineId: 'receiver', token: receiver.authToken()
    } } }));
    const upload = (body, extra = {}) => receiver.request('/api/shared', { method: 'POST', body, ...extra });
    const content = 'Synthetic destination-only reference\nUnicode: 한글\n';
    const descriptor = createSharedContextDescriptor(content);
    const filePath = path.join(getSharedContextDir(receiver.homeDir), descriptor.fileName);
    assert.equal((await upload(bodyFor(content), { noAuth: true })).status, 401);
    assert.equal(fs.existsSync(filePath), false);
    await receiver.registerSession('ref-worker');
    owner = await receiver.connectSession('ref-worker', receiver.ownerAuth('ref-worker'));
    const injections = [];
    owner.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'inject' && String(message.data).includes('[context-ref]')) injections.push({ message,
        committed: fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === content });
    });
    const result = await sender.runCli(['inject', '--ref', 'ref-worker@receiver', content], {
      env: { TELEPTY_AUTH_TOKEN: '' }, timeoutMs: 8000
    });
    assert.equal(result.code, 0, result.stderr);
    await waitFor(() => injections.length === 1, { description: 'reference pointer delivery' });
    assert.equal(injections[0].committed, true);
    assert.equal(injections[0].message.data.includes(descriptor.promptPath), true);
    assert.equal(injections[0].message.data.includes(content), false);
    assert.equal(fs.existsSync(path.join(getSharedContextDir(sender.homeDir), descriptor.fileName)), false);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700);
    }
    const sourceFile = path.join(sender.homeDir, 'synthetic-source.md');
    fs.writeFileSync(sourceFile, content);
    const fileResult = await sender.runCli(['inject', '--ref', sourceFile, 'ref-worker@receiver', 'Synthetic instruction'], {
      env: { TELEPTY_AUTH_TOKEN: '' }
    });
    assert.equal(fileResult.code, 0, fileResult.stderr);
    await waitFor(() => injections.length === 2, { description: 'file reference pointer delivery' });
    assert.equal(injections[1].message.data.includes('Synthetic instruction'), true);
    const broadcastContent = 'Synthetic HTTP broadcast reference';
    const broadcastDescriptor = createSharedContextDescriptor(broadcastContent);
    const broadcast = await sender.runCli(['broadcast', '--ref', broadcastContent], { env: { TELEPTY_AUTH_TOKEN: '' } });
    assert.equal(broadcast.code, 0, broadcast.stderr);
    assert.equal(broadcast.stdout.includes(broadcastDescriptor.promptPath), true);
    await waitFor(() => injections.length === 3, { description: 'broadcast reference pointer' });
    assert.equal(fs.readFileSync(path.join(path.dirname(filePath), broadcastDescriptor.fileName), 'utf8'), broadcastContent);
    const inode = fs.statSync(filePath).ino;
    const repeated = await upload(bodyFor(content));
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.created, false);
    assert.equal(fs.statSync(filePath).ino, inode);
    assert.equal((await upload({ ...bodyFor(content), hash: '0'.repeat(64), fileName: `${'0'.repeat(64)}.md` })).status, 409);
    assert.equal((await upload({ ...bodyFor(content), fileName: '../escape.md' })).status, 400);
    assert.equal((await upload({ ...bodyFor(content), source_path: '/private/source' })).status, 400);
    assert.equal((await upload({ ...bodyFor(content), content_base64: '%%%invalid%%%' })).status, 400);
    assert.equal((await upload({ ...bodyFor(content), content_base64: '/w==' })).status, 400);
    assert.equal((await upload({ ...bodyFor(content), destination_url: 'http://127.0.0.1/' })).status, 400);
    assert.equal((await upload(bodyFor('x'.repeat(MAX_SHARED_REFERENCE_BYTES + 1)))).status, 413);
    const corrupted = 'x'.repeat(Buffer.byteLength(content));
    fs.writeFileSync(filePath, corrupted);
    const before = injections.length;
    const failed = await sender.runCli(['inject', '--ref', 'ref-worker@receiver', content], { env: { TELEPTY_AUTH_TOKEN: '' } });
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /Shared reference upload failed.*nothing injected/);
    assert.equal(injections.length, before);
    assert.equal(fs.readFileSync(filePath, 'utf8'), corrupted);
    assert.equal(fs.readdirSync(path.dirname(filePath)).some((name) => name.endsWith('.tmp')), false);

    // A content-addressed filename must not follow a link to any other file.
    const linkedContent = 'Synthetic linked reference';
    const linked = bodyFor(linkedContent);
    const outside = path.join(receiver.homeDir, 'outside-synthetic.txt');
    fs.writeFileSync(outside, linkedContent);
    const linkPath = path.join(path.dirname(filePath), linked.fileName);
    fs.linkSync(outside, linkPath);
    assert.equal((await upload(linked)).status, 409);
    assert.equal(fs.readFileSync(outside, 'utf8'), linkedContent);
    fs.unlinkSync(linkPath);
    if (process.platform !== 'win32') {
      fs.symlinkSync(outside, linkPath);
      assert.equal((await upload(linked)).status, 409);
      assert.equal(fs.readFileSync(outside, 'utf8'), linkedContent);
      const sharedDir = path.dirname(filePath);
      const savedDir = `${sharedDir}.saved`;
      const outsideDir = path.join(receiver.homeDir, 'outside-shared');
      fs.mkdirSync(outsideDir);
      fs.renameSync(sharedDir, savedDir);
      try {
        fs.symlinkSync(outsideDir, sharedDir);
        assert.equal((await upload(bodyFor('Synthetic directory guard'))).status, 409);
        assert.deepEqual(fs.readdirSync(outsideDir), []);
      } finally {
        fs.unlinkSync(sharedDir);
        fs.renameSync(savedDir, sharedDir);
      }
    }
  } finally {
    if (owner) owner.close();
    await Promise.all([sender.stop(), receiver.stop()]);
  }
});
