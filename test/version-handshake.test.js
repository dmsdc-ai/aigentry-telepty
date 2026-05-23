'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ACTIONS,
  decideVersionAction,
  compareSemver,
  parseSemver
} = require('../src/version-handshake');

// Decision matrix: daemonVersion × cliVersion → action

test('daemon unreachable → start', () => {
  const r = decideVersionAction({ daemonVersion: null, cliVersion: '0.4.3' });
  assert.equal(r.action, ACTIONS.START);
  assert.equal(r.reason, 'daemon-unreachable');
});

test('daemon undefined → start', () => {
  const r = decideVersionAction({ daemonVersion: undefined, cliVersion: '0.4.3' });
  assert.equal(r.action, ACTIONS.START);
});

test('cli version missing → noop (degrade safe, do not clobber)', () => {
  const r = decideVersionAction({ daemonVersion: '0.4.3', cliVersion: null });
  assert.equal(r.action, ACTIONS.NOOP);
  assert.equal(r.reason, 'cli-version-missing');
});

test('versions equal → noop', () => {
  const r = decideVersionAction({ daemonVersion: '0.4.3', cliVersion: '0.4.3' });
  assert.equal(r.action, ACTIONS.NOOP);
  assert.equal(r.reason, 'versions-equal');
});

test('daemon older patch → restart (newer-wins)', () => {
  const r = decideVersionAction({ daemonVersion: '0.4.2', cliVersion: '0.4.3' });
  assert.equal(r.action, ACTIONS.RESTART);
  assert.equal(r.reason, 'daemon-older');
});

test('daemon older minor → restart', () => {
  const r = decideVersionAction({ daemonVersion: '0.3.5', cliVersion: '0.4.3' });
  assert.equal(r.action, ACTIONS.RESTART);
});

test('daemon older major → restart', () => {
  const r = decideVersionAction({ daemonVersion: '0.4.3', cliVersion: '1.0.0' });
  assert.equal(r.action, ACTIONS.RESTART);
});

test('daemon newer → noop (respect newer daemon, no clobber)', () => {
  const r = decideVersionAction({ daemonVersion: '0.4.4', cliVersion: '0.4.3' });
  assert.equal(r.action, ACTIONS.NOOP);
  assert.equal(r.reason, 'daemon-newer');
});

test('daemon newer minor → noop', () => {
  const r = decideVersionAction({ daemonVersion: '0.5.0', cliVersion: '0.4.3' });
  assert.equal(r.action, ACTIONS.NOOP);
});

test('non-semver equal strings → noop', () => {
  const r = decideVersionAction({ daemonVersion: 'dev', cliVersion: 'dev' });
  assert.equal(r.action, ACTIONS.NOOP);
  assert.equal(r.reason, 'versions-equal-nonsemver');
});

test('non-semver differing strings → restart', () => {
  const r = decideVersionAction({ daemonVersion: 'dev', cliVersion: 'prod' });
  assert.equal(r.action, ACTIONS.RESTART);
  assert.equal(r.reason, 'version-mismatch-nonsemver');
});

test('semver with prerelease tag ignores suffix (truncates to numeric core)', () => {
  // parseSemver only reads leading x.y.z; this is sufficient for telepty#15
  // because npm version always emits canonical x.y.z without suffix.
  const r = decideVersionAction({ daemonVersion: '0.4.3-rc.1', cliVersion: '0.4.3' });
  assert.equal(r.action, ACTIONS.NOOP);
});

test('parseSemver: valid', () => {
  assert.deepEqual(parseSemver('1.2.3'), [1, 2, 3]);
});

test('parseSemver: garbage', () => {
  assert.equal(parseSemver('not-a-version'), null);
  assert.equal(parseSemver(null), null);
  assert.equal(parseSemver(42), null);
});

test('compareSemver: ordering', () => {
  assert.equal(compareSemver('1.0.0', '2.0.0'), -1);
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  assert.equal(compareSemver('2.0.0', '1.0.0'), 1);
  assert.equal(compareSemver('0.4.2', '0.4.3'), -1);
  assert.equal(compareSemver('0.4.10', '0.4.2'), 1);
});

test('compareSemver: invalid returns null', () => {
  assert.equal(compareSemver('foo', '1.0.0'), null);
});
