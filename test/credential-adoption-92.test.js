'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { adoptRegistrationCredential } = require('../src/cli/security-actions');

test('new registration updates wrapper and future spawn copy without rewriting running child', () => {
  const env = { TELEPTY_SESSION_TOKEN: 'old-epoch.fixture-old-secret' };
  const spawnEnv = { ...env };
  const runningChildEnv = { ...spawnEnv };
  assert.equal(adoptRegistrationCredential({ ok: true }, { session_token: 'new-epoch.fixture-new-secret' }, env, spawnEnv), true);
  assert.equal(env.TELEPTY_SESSION_TOKEN, 'new-epoch.fixture-new-secret');
  assert.equal(spawnEnv.TELEPTY_SESSION_TOKEN, env.TELEPTY_SESSION_TOKEN);
  assert.equal(runningChildEnv.TELEPTY_SESSION_TOKEN, 'old-epoch.fixture-old-secret');
});
test('failed registration and missing issuance never replace either credential copy', () => {
  for (const [response, data] of [
    [{ ok: false }, { session_token: 'untrusted-error.fixture-token' }],
    [{ ok: true }, {}], [{ ok: true }, null],
    [{ ok: true }, { session_token: '' }], [{ ok: true }, { session_token: 42 }]
  ]) {
    const env = { TELEPTY_SESSION_TOKEN: 'incumbent.fixture-secret' };
    const spawnEnv = { ...env };
    assert.equal(adoptRegistrationCredential(response, data, env, spawnEnv), false);
    assert.deepEqual(env, { TELEPTY_SESSION_TOKEN: 'incumbent.fixture-secret' });
    assert.deepEqual(spawnEnv, env);
  }
});
