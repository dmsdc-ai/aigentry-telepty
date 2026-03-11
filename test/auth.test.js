'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Use a temp directory to isolate tests from the real ~/.telepty config.
// We patch os.homedir() before requiring auth.js so the module-level
// constants (CONFIG_DIR, CONFIG_FILE) resolve to the temp dir.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-test-'));
const originalHomedir = os.homedir.bind(os);

before(() => {
  os.homedir = () => tmpDir;
  // Ensure auth.js is loaded fresh with the patched homedir
  delete require.cache[require.resolve('../auth.js')];
});

after(() => {
  os.homedir = originalHomedir;
  delete require.cache[require.resolve('../auth.js')];
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('getConfig() returns an object with authToken property', () => {
  const { getConfig } = require('../auth.js');
  const config = getConfig();
  assert.ok(config !== null && typeof config === 'object', 'config should be an object');
  assert.ok('authToken' in config, 'config should have authToken property');
  assert.equal(typeof config.authToken, 'string', 'authToken should be a string');
});

test('authToken is a valid UUID v4 format', () => {
  const { getConfig } = require('../auth.js');
  const config = getConfig();
  const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert.match(config.authToken, uuidV4Regex, 'authToken should be a valid UUID v4');
});

test('config object has createdAt field', () => {
  const { getConfig } = require('../auth.js');
  const config = getConfig();
  assert.ok('createdAt' in config, 'config should have createdAt property');
  const date = new Date(config.createdAt);
  assert.ok(!isNaN(date.getTime()), 'createdAt should be a valid ISO date string');
});

test('calling getConfig() twice returns the same token (persistence)', () => {
  const { getConfig } = require('../auth.js');
  const config1 = getConfig();
  const config2 = getConfig();
  assert.equal(config1.authToken, config2.authToken, 'authToken should be identical across calls');
  assert.equal(config1.createdAt, config2.createdAt, 'createdAt should be identical across calls');
});
