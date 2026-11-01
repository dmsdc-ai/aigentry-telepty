'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSharedContextDescriptor } = require('../shared-context');
const { commitSharedReference } = require('../src/shared-reference-transfer');
const { registerSharedReferenceRoutes } = require('../src/routes/shared-reference');

// Same-process filesystem interception, confined to synchronous calls over a
// private fixture; no production environment flags or product test hooks.
test('shared reference receipts require file fsync and POSIX directory fsync', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-ref-durability-'));
  const originalFsync = fs.fsyncSync;
  const descriptor = createSharedContextDescriptor('Synthetic durability reference');
  const body = { hash: descriptor.hash, fileName: descriptor.fileName,
    content_base64: Buffer.from(descriptor.content).toString('base64') };
  const filePath = path.join(fixture, '.telepty', 'shared', descriptor.fileName);
  const calls = [];
  let rejectKind = null;
  let handler;
  registerSharedReferenceRoutes({ post(route, callback) {
    assert.equal(route, '/api/shared'); handler = callback;
  } });
  const originalHome = os.homedir;
  function response() {
    return { statusCode: 200, payload: null,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.payload = value; return this; } };
  }
  try {
    os.homedir = () => fixture;
    fs.fsyncSync = (fd) => {
      const kind = fs.fstatSync(fd).isDirectory() ? 'directory' : 'file';
      calls.push(kind);
      if (rejectKind === kind) { const error = new Error('synthetic flush failure'); error.code = 'EIO'; throw error; }
      return originalFsync(fd);
    };
    if (process.platform !== 'win32') {
      rejectKind = 'directory';
      const failed = response();
      handler({ body }, failed);
      assert.equal(failed.statusCode, 503);
      assert.equal(failed.payload.success, false);
      assert.equal(failed.payload.code, 'SHARED_REF_STORAGE_UNAVAILABLE');
      assert.equal(fs.existsSync(filePath), true, 'published file survives a failed directory flush');
      assert.deepEqual(fs.readdirSync(path.dirname(filePath)), [descriptor.fileName]);
    }
    rejectKind = null;
    const committed = commitSharedReference(body, { homeDir: fixture });
    assert.equal(committed.success, true);
    const inode = fs.statSync(filePath).ino;
    calls.length = 0;
    rejectKind = 'file';
    const failedExisting = response();
    handler({ body }, failedExisting);
    assert.equal(failedExisting.statusCode, 503);
    assert.equal(failedExisting.payload.success, false);
    assert.deepEqual(calls, ['file']);
    assert.equal(fs.statSync(filePath).ino, inode);
    rejectKind = null;
    calls.length = 0;
    const retried = response();
    handler({ body }, retried);
    assert.equal(retried.statusCode, 200);
    assert.equal(retried.payload.success, true);
    assert.equal(retried.payload.created, false);
    assert.deepEqual(calls, process.platform === 'win32' ? ['file'] : ['file', 'directory', 'directory', 'directory']);
  } finally {
    fs.fsyncSync = originalFsync;
    os.homedir = originalHome;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
