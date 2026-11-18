'use strict';

// Release metadata identity for 0.11.1 (task 1270, re-base of the task 1272/ci708 0.11.0 check, which was itself
// a re-base of the task 1215 hotfix 0.10.1 check). The filename is kept so the re-base history stays one file.
// The coder did not execute it.
// RED on BASE (the 0.11.0 release tree): the version assertions below fail with '0.11.0' (files readable, not a setup failure).
// GREEN with the delta: package.json, both package-lock.json fields and the scripts/check-package.mjs pin all say 0.11.1,
// and each file is byte-identical to BASE once its version lines are put back, so no dependency, resolution, integrity,
// lockfileVersion or engines field moved. Pure file reads: no npm, no network, no product code.
// CHANGELOG/README identity stays owned by test/release-version-invariant-844.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RELEASE = '0.11.1';
const BASE_VERSION = '0.11.0';
// sha256 of the BASE files (the released 0.11.0 tree, LF bytes). No commit sha is recorded here because the
// re-base inputs did not carry the v0.11.0 commit id; these three files are the ones the 0.11.1 branch does not
// otherwise touch, so the pre-delta bytes ARE the 0.11.0 bytes.
const BASE_SHA256 = {
  'package.json': '66787c319f8d298c7d3fbde7f0bafa1e0f5729f78977dd2720101130414f4ba2',
  'package-lock.json': 'd6d896b9e5556237f59fdda1941c0be7cf673e5dbd2f77693462d0dbf850f56e',
  'scripts/check-package.mjs': 'd65efebe6e0347510f574f92f42bf6ed7e726c90fa76d9f29ac2816bc8da4b13',
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

test('hotfix 1215: package.json, both package-lock.json fields and the check-package pin all name 0.11.1', () => {
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
