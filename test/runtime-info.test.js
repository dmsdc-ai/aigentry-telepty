'use strict';

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { formatTimestamp, getRuntimeInfo } = require('../runtime-info');

const cleanupDirs = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    fs.rmSync(cleanupDirs.pop(), { recursive: true, force: true });
  }
});

test('formatTimestamp renders a stable local timestamp with offset', () => {
  const date = new Date('2026-03-12T01:02:03.000Z');
  const label = formatTimestamp(date);
  assert.match(label, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/);
});

test('getRuntimeInfo returns version and package timestamp', () => {
  const packageRoot = makeTempDir('telepty-runtime-info-');
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const timestamp = new Date('2026-03-12T10:11:12.000Z');

  fs.writeFileSync(packageJsonPath, JSON.stringify({ version: '9.9.9' }, null, 2));
  fs.utimesSync(packageJsonPath, timestamp, timestamp);

  const info = getRuntimeInfo(packageRoot);
  assert.equal(info.version, '9.9.9');
  assert.equal(info.updatedAt.getTime(), timestamp.getTime());
  assert.match(info.updatedAtLabel, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/);
});
