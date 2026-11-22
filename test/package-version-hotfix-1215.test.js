'use strict';

// Task 1288 advances the release identity check for the session routing patch.
// BASE_SHA256 pins the supplied unmodified 0.11.3 release metadata.
// CHANGELOG/README identity stays owned by test/release-version-invariant-844.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RELEASE = '0.11.4';
const BASE_VERSION = '0.11.3';
const BASE_SHA256 = {
  'package.json': '2a1ebd0d87c78a56a9400630629c7935be6bf78a8c23721df874c0ac05e61867',
  'package-lock.json': '3a855f5f9d0311ec7af684dc0a8d0cc525ef7697c42c76c4d2622984b7ff6c75',
  'scripts/check-package.mjs': 'ebbce915d1ad09f60d7af724b8cd62b67315eee9f75f3a1a9d1ba010e8171e0c',
};
// The only lines the release delta may change (0-based), each with its exact BASE and release text.
const VERSION_LINES = {
  'package.json': [[2, '  "version": "%s",']],
  'package-lock.json': [[2, '  "version": "%s",'], [8, '      "version": "%s",']],
  'scripts/check-package.mjs': [[71, "assert.equal(pkg.version, '%s');"]],
};

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const fill = (template, version) => template.replace('%s', version);

// The same identity rule for real and synthetic inputs: every field names one version.
function releaseVersions({ pkg, lock, checkScript }) {
  const pin = /assert\.equal\(pkg\.version, '(\d+\.\d+\.\d+)'\)/.exec(checkScript);
  return { pkg: pkg.version, lockRoot: lock.version, lockPackage: lock.packages && lock.packages[''] && lock.packages[''].version,
    checkPin: pin ? pin[1] : null };
}
function assertOneRelease(versions, expected) {
  assert.deepEqual(versions, { pkg: expected, lockRoot: expected, lockPackage: expected, checkPin: expected });
}

test('hotfix 1215: package.json, both package-lock.json fields and the check-package pin all name 0.11.4', () => {
  const versions = releaseVersions({ pkg: JSON.parse(read('package.json')), lock: JSON.parse(read('package-lock.json')),
    checkScript: read('scripts/check-package.mjs') });
  assertOneRelease(versions, RELEASE);
});

test('hotfix 1215: only the version lines differ from BASE (dependencies, resolutions, integrities, lockfile format untouched)', () => {
  const result = {};
  for (const [rel, lines] of Object.entries(VERSION_LINES)) {
    // 507 C6: a Windows autocrlf checkout reads CRLF; compare the LF bytes the BASE hashes were taken over.
    const text = read(rel).replace(/\r\n/g, '\n').split('\n');
    const atRelease = lines.every(([index, template]) => text[index] === fill(template, RELEASE));
    for (const [index, template] of lines) if (text[index] === fill(template, RELEASE)) text[index] = fill(template, BASE_VERSION);
    result[rel] = { atRelease, restoredMatchesBase: sha256(text.join('\n')) === BASE_SHA256[rel] };
  }
  assert.deepEqual(result, Object.fromEntries(Object.keys(VERSION_LINES).map(rel => [rel, { atRelease: true, restoredMatchesBase: true }])));
});

test('hotfix 1215: lockfile format and root dependency declarations still agree with package.json', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.name, pkg.name);
  assert.deepEqual(lock.packages[''].dependencies || {}, pkg.dependencies || {});
});

test('hotfix 1215 control: a stale or mixed version set is refused by the same rule', () => {
  const good = { pkg: { version: RELEASE }, lock: { version: RELEASE, packages: { '': { version: RELEASE } } },
    checkScript: `assert.equal(pkg.version, '${RELEASE}');` };
  assert.doesNotThrow(() => assertOneRelease(releaseVersions(good), RELEASE));
  const mixed = [
    { ...good, pkg: { version: BASE_VERSION } },
    { ...good, lock: { version: BASE_VERSION, packages: { '': { version: RELEASE } } } },
    { ...good, lock: { version: RELEASE, packages: { '': { version: BASE_VERSION } } } },
    { ...good, checkScript: `assert.equal(pkg.version, '${BASE_VERSION}');` },
    { ...good, checkScript: '// pin removed' },
  ];
  for (const variant of mixed) {
    assert.throws(() => assertOneRelease(releaseVersions(variant), RELEASE), { code: 'ERR_ASSERTION' });
  }
});
