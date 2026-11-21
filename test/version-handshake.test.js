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

test('unparseable daemon version leaves the daemon running', () => {
  for (const version of ['dev', '1.2.3junk', '01.2.3', '1.2.3-01']) {
    const result = decideVersionAction({ daemonVersion: version, cliVersion: '1.2.3' });
    assert.deepEqual(result, { action: ACTIONS.NOOP, reason: 'version-unknown' });
  }
});

test('SemVer precedence includes prereleases and ignores build metadata', () => {
  const versions = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta',
    '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  for (let i = 1; i < versions.length; i++) {
    assert.equal(compareSemver(versions[i - 1], versions[i]), -1);
    assert.equal(compareSemver(versions[i], versions[i - 1]), 1);
  }
  assert.equal(compareSemver('1.0.0+old', '1.0.0+new'), 0);
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
