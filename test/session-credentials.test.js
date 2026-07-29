'use strict';

// #815 — unit coverage for the credential store. The daemon runs as a subprocess in the
// integration tests, so the branch-level behavior (malformed bearers, cross-instance bleed,
// revoke/rename) is pinned here where it can be exercised directly.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCredentialStore, verifierFor } = require('../src/session-store/session-credentials');

test('issue mints a distinct instance per call, even for the same sid', () => {
  const store = createCredentialStore();
  const a = store.issue('sid-1');
  const b = store.issue('sid-1');   // a respawn of the same textual id
  assert.notEqual(a.epoch, b.epoch);
  assert.notEqual(a.bearer, b.bearer);
  // Both resolve while both are live; revocation (not issuance) is what retires the predecessor.
  assert.equal(store.verify(a.bearer).epoch, a.epoch);
  assert.equal(store.verify(b.bearer).epoch, b.epoch);
});

test('verify returns the full principal', () => {
  const store = createCredentialStore();
  const issued = store.issue('sid-1');
  assert.deepEqual(store.verify(issued.bearer), {
    sid: 'sid-1', epoch: issued.epoch, generation: 1
  });
});

test('verify fails closed on anything that is not a live bearer', () => {
  const store = createCredentialStore();
  const issued = store.issue('sid-1');
  for (const bad of [
    undefined, null, '', 'garbage', 'no-dot-here',
    '.leading-dot', 'trailing-dot.',
    `${issued.epoch}.wrong-secret`,           // right instance, wrong secret
    `unknown-epoch.${issued.bearer.split('.')[1]}`, // right secret, wrong instance
    issued.bearer.slice(0, -1)                // truncated
  ]) {
    assert.equal(store.verify(bad), null, `must not verify: ${String(bad)}`);
  }
  // The genuine article still works after all that.
  assert.equal(store.verify(issued.bearer).sid, 'sid-1');
});

test('matches is sid-scoped — a valid bearer does not authenticate a different session', () => {
  const store = createCredentialStore();
  const a = store.issue('sid-a');
  store.issue('sid-b');
  assert.equal(store.matches('sid-a', a.bearer), true);
  assert.equal(store.matches('sid-b', a.bearer), false);
});

test('revoke kills every epoch of a sid and cannot be resurrected by re-issuing', () => {
  const store = createCredentialStore();
  const dead = store.issue('sid-1');
  assert.equal(store.hasCredential('sid-1'), true);

  store.revoke('sid-1');
  assert.equal(store.verify(dead.bearer), null, 'predecessor bearer is dead');
  assert.equal(store.hasCredential('sid-1'), false);

  const reborn = store.issue('sid-1');   // same textual id, new instance
  assert.equal(store.verify(dead.bearer), null, 'and STAYS dead after the id is reused');
  assert.equal(store.verify(reborn.bearer).sid, 'sid-1');
  assert.notEqual(reborn.epoch, dead.epoch);
});

test('adopt re-indexes a persisted verifier so the same bearer survives a restart', () => {
  const minted = createCredentialStore().issue('sid-1');

  // A fresh store, as after a daemon restart — it never saw the bearer, only what went to disk.
  const restarted = createCredentialStore();
  restarted.adopt('sid-1', {
    sessionEpoch: minted.epoch,
    credentialVerifier: verifierFor(minted.bearer),
    credentialGeneration: 1
  });

  assert.deepEqual(restarted.verify(minted.bearer), {
    sid: 'sid-1', epoch: minted.epoch, generation: 1
  });
});

test('adopt ignores a half or malformed persisted record rather than half-crediting a session', () => {
  const store = createCredentialStore();
  assert.equal(store.adopt('sid-1', { sessionEpoch: 'e' }), false);              // no verifier
  assert.equal(store.adopt('sid-1', { credentialVerifier: 'v' }), false);        // no epoch
  assert.equal(store.adopt('sid-1', {}), false);
  assert.equal(store.adopt('sid-1', null), false);
  assert.equal(store.hasCredential('sid-1'), false);
});

test('a hand-edited verifier of the wrong length fails closed instead of throwing', () => {
  const store = createCredentialStore();
  const issued = createCredentialStore().issue('sid-1');
  store.adopt('sid-1', { sessionEpoch: issued.epoch, credentialVerifier: 'deadbeef' });
  assert.equal(store.verify(issued.bearer), null);
});

test('rename moves the live instance without revoking it — same epoch, new canonical sid', () => {
  const store = createCredentialStore();
  const issued = store.issue('old-name');
  store.rename('old-name', 'new-name');

  const principal = store.verify(issued.bearer);
  assert.equal(principal.sid, 'new-name', 'principal follows the instance');
  assert.equal(principal.epoch, issued.epoch, 'and it is still the SAME instance');
  assert.equal(store.matches('new-name', issued.bearer), true);
  assert.equal(store.matches('old-name', issued.bearer), false);
});
