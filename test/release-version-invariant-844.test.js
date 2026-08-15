'use strict';

// #844 BLOCKER D — the release artifact must not lie about which release it is.
//
// 0.8.0 was finished and green while `package.json:3`, `package-lock.json:3` and
// `package-lock.json:9` all said `0.7.1` — the version ALREADY PUBLISHED on npm. The suite did
// not notice, because the only version assertion it had (`enforce-report.test.js`, "package.json
// version is semver-shaped") measures the SHAPE of the string and never what it names. `0.7.1`
// satisfies `^\d+\.\d+\.\d+$` perfectly while being the wrong answer.
//
// The consequence is not cosmetic. `/api/meta` reports this exact string, and
// `decideDaemonAction` (cli.js) treats a version-EQUAL daemon as healthy while most
// `ensureDaemonRunning()` callers pass no required capabilities — so a new CLI meeting a
// still-running old daemon would call it correct and keep talking to it across wire semantics
// this release changed. Shipping would also have collided with the published 0.7.1.
//
// So the invariant here is about IDENTITY, not shape:
//
//   1. the two manifests agree with each other (three fields, one number)
//   2. the release notes are filed under exactly the version the package claims
//   3. that version is not one this project has already shipped
//
// (2) is the load-bearing one. Notes accumulated under a `## Unreleased` heading are what let
// the package version and the release it describes drift apart in the first place: the notes
// said 0.8.0 in their prose while the manifest said 0.7.1, and nothing compared them. A version
// number is a claim to BE a release; this file makes the release notes the thing that has to
// agree with it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'));
const changelog = fs.readFileSync(path.join(projectRoot, 'CHANGELOG.md'), 'utf8');

// `## 0.8.0 — 2026-08-15`, `## 0.6.11] - ...` (the older bracketed style), or a bare `## 0.8.0`.
// Anything after the version is free text: the date is filled in at publish time.
const VERSION_HEADING = /^##\s+\[?(\d+\.\d+\.\d+)\]?(?:\s|$)/;

function versionHeadings() {
  return changelog.split('\n')
    .map((line) => VERSION_HEADING.exec(line))
    .filter(Boolean)
    .map((m) => m[1]);
}

// Every `## ` heading, version-shaped or not — `## Unreleased` has to be visible to be refused.
function allSectionHeadings() {
  return changelog.split('\n').filter((line) => /^##\s+\S/.test(line));
}

test('package-lock.json carries the same version as package.json, in both of its fields', () => {
  // Three fields, one number. npm writes the root `version` and `packages[""].version`
  // together, so a hand-edited package.json leaves both behind — which is exactly what
  // happened here.
  assert.equal(lock.version, pkg.version,
    'package-lock.json:3 disagrees with package.json — run `npm install` after a version bump');
  assert.equal(lock.packages[''].version, pkg.version,
    'package-lock.json packages[""].version disagrees with package.json');
});

test('CHANGELOG.md files its newest section under exactly the version package.json claims', () => {
  const headings = allSectionHeadings();
  assert.ok(headings.length > 0, 'CHANGELOG.md has no `## ` sections at all');

  const newest = headings[0];
  const match = VERSION_HEADING.exec(newest);
  assert.ok(match,
    `the newest CHANGELOG section is "${newest.trim()}" — a version number in package.json is a `
    + `claim to BE that release, so the notes for it must be filed under "## ${pkg.version}", not `
    + 'under a placeholder heading that can never disagree with anything');
  assert.equal(match[1], pkg.version,
    `CHANGELOG.md's newest section describes ${match[1]} but package.json says ${pkg.version}`);
});

test('the claimed version is not one already shipped — no version has two sections', () => {
  // The 0.7.1 defect stated as a property: a version that already has release notes has already
  // been published, so re-claiming it means publishing over it.
  const seen = new Map();
  for (const version of versionHeadings()) {
    seen.set(version, (seen.get(version) || 0) + 1);
  }
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([v]) => v);
  assert.deepEqual(duplicates, [],
    `these versions have more than one CHANGELOG section: ${duplicates.join(', ')}`);
  assert.equal(seen.get(pkg.version), 1,
    `package.json claims ${pkg.version}; CHANGELOG.md has ${seen.get(pkg.version) || 0} sections for it`);
});

test('the newest section is the highest version in the file', () => {
  // Ordering, so a bump BACKWARDS (or a section filed in the wrong place) is caught as well as a
  // bump that never happened.
  const versions = versionHeadings();
  const rank = (v) => v.split('.').map(Number);
  const isGreater = (a, b) => {
    const [x, y] = [rank(a), rank(b)];
    for (let i = 0; i < 3; i++) {
      if (x[i] !== y[i]) return x[i] > y[i];
    }
    return false;
  };
  for (const older of versions.slice(1)) {
    assert.ok(isGreater(versions[0], older),
      `CHANGELOG.md's newest section ${versions[0]} is not newer than ${older} below it`);
  }
});
