'use strict';

// Check the 0.11.3 release metadata against the supplied 0.11.2 release bytes.
// CHANGELOG/README identity stays owned by test/release-version-invariant-844.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RELEASE = '0.11.3';
const BASE_VERSION = '0.11.2';
const BASE_SHA256 = {
  'package.json': 'c223d3638be5739c42e0e39ab317736f7d5406cf3966a9d0c044d3bfc3685338',
  'package-lock.json': 'd84fdcf818f3cb4e3771631aed9e4aef3a9ac9c0d09993bf52e891dced662281',
  'scripts/check-package.mjs': '7375c2a917e36918127d19af43385e5c4d67f6d031f6ff13cc94745267700c1d',
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

test('hotfix 1215: package.json, both package-lock.json fields and the check-package pin all name 0.11.3', () => {
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
