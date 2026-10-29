'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { canonicalJSON, parseUnambiguousJSON, bodyDigest } = require('../src/principal/encoding');
const { validateTrustConfiguration, createPrincipalVerifier, createSignedAssertion } = require('../src/principal/proof');
const NOW = 1700000000000;
function fixture({ capacity = 4, authority = 'principal' } = {}) {
  const pair = crypto.generateKeyPairSync('ed25519');
  const configuration = { schema: 'telepty.principals/v1', audience: 'node-a', keys: [{
    key_id: 'alice-key', principal_id: 'alice', public_key_spki: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    authority, grants: [{ action: 'session.inject', targets: ['worker'] }]
  }] };
  const trust = validateTrustConfiguration(configuration, { audience: 'node-a' });
  let now = NOW;
  const verifier = createPrincipalVerifier({ trust, challenge: 'fixed-fixture-challenge', now: () => now, replayCapacity: capacity });
  const request = { method: 'POST', target: '/api/sessions/worker/inject?no_enter=true', action: 'session.inject',
    bodySha256: bodyDigest({ prompt: 'hello' }), grantTarget: 'worker', transport: 'http' };
  const document = { privateKey: pair.privateKey, keyId: 'alice-key', principalId: 'alice', audience: 'node-a',
    challenge: verifier.challenge, method: request.method, target: request.target, action: request.action,
    body: { prompt: 'hello' }, issuedAt: NOW / 1000, nonce: 'nonce-fixture-00000000000001' };
  return { pair, configuration, trust, verifier, request, document,
    sign: extra => createSignedAssertion({ ...document, ...extra }), setNow: value => { now = value; } };
}

test('canonical JSON matches parsed route semantics and rejects duplicate members/accessors/nonfinite values', () => {
  assert.equal(canonicalJSON({ z: 2, a: [null, true, 'x'] }), '{"a":[null,true,"x"],"z":2}');
  assert.deepEqual(parseUnambiguousJSON('{"b":2,"a":1}'), { a: 1, b: 2 });
  for (const input of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":1e999}', '[1,]', '{"x":undefined}']) {
    assert.throws(() => parseUnambiguousJSON(input));
  }
  assert.throws(() => canonicalJSON({ get value() { throw new Error('must not call accessor'); } }));
  assert.throws(() => canonicalJSON({ value: Infinity }));
  assert.equal(bodyDigest({ a: 1, b: 2 }), bodyDigest({ b: 2, a: 1 }));
  assert.notEqual(bodyDigest(undefined), bodyDigest(null));
});

test('valid Ed25519 proof establishes configured identity and exact grant then refuses replay', () => {
  const f = fixture();
  const proof = f.sign();
  const verified = f.verifier.verify(proof, f.request);
  assert.equal(verified.ok, true);
  assert.equal(verified.principal.id, 'alice');
  assert.equal(verified.principal.authority, 'principal');
  assert.equal(verified.principal.source, 'ed25519');
  assert.equal(f.verifier.verify(proof, f.request).code, 'PRINCIPAL_REPLAY');
});

for (const [name, changedProof, changedRequest] of [
  ['audience', { audience: 'other-node' }], ['principal', { principalId: 'operator' }],
  ['challenge', { challenge: 'previous-startup' }], ['path', { target: '/api/sessions/worker/inject?no_enter=false' }],
  ['method', { method: 'DELETE' }], ['body', { body: { prompt: 'different' } }], ['action', { action: 'session.destroy' }],
  ['epoch', { sessionEpoch: 'old' }, { sessionEpoch: 'current' }]
]) test(`proof refuses mismatched ${name}`, () => {
  const f = fixture();
  assert.equal(f.verifier.verify(f.sign(changedProof), { ...f.request, ...changedRequest }).ok, false);
});

test('untrusted key, malformed assertion and unsigned caller-sub are never principals', () => {
  const f = fixture();
  const wrong = crypto.generateKeyPairSync('ed25519');
  for (const proof of ['', 'Bearer user-sub', 'v1.%%%bad.%%%bad', f.sign({ privateKey: wrong.privateKey }), f.sign({ keyId: 'other-key' })]) {
    assert.equal(f.verifier.verify(proof, f.request).ok, false);
  }
});

test('proof lifetime is at most 60 seconds, future timestamps and expired assertions refuse', () => {
  const f = fixture();
  assert.throws(() => f.sign({ ttlSeconds: 61 }));
  assert.equal(f.verifier.verify(f.sign({ issuedAt: NOW / 1000 + 1 }), f.request).ok, false);
  f.setNow(NOW + 60000);
  assert.equal(f.verifier.verify(f.sign(), f.request).ok, false);
});

test('bounded replay cache fails closed at capacity without evicting live nonces and recovers after expiry', () => {
  const f = fixture({ capacity: 1 });
  const first = f.sign();
  assert.equal(f.verifier.verify(first, f.request).ok, true);
  assert.equal(f.verifier.verify(f.sign({ nonce: 'nonce-fixture-00000000000002' }), f.request).code, 'PRINCIPAL_REPLAY_CAPACITY');
  assert.equal(f.verifier.verify(first, f.request).code, 'PRINCIPAL_REPLAY');
  f.setNow(NOW + 61000);
  assert.equal(f.verifier.verify(f.sign({ issuedAt: (NOW + 61000) / 1000, nonce: 'nonce-fixture-00000000000003' }), f.request).ok, true);
});

test('grant names and targets are explicit; operator claims cannot manufacture configured authority', () => {
  const f = fixture();
  assert.equal(f.verifier.verify(f.sign(), { ...f.request, grantTarget: 'other' }).code, 'PRINCIPAL_GRANT_DENIED');
  const invalid = structuredClone(f.configuration);
  invalid.keys[0].grants[0].action = 'unknown.action';
  assert.throws(() => validateTrustConfiguration(invalid, { audience: 'node-a' }));
  const privateConfiguration = structuredClone(f.configuration);
  privateConfiguration.keys[0].public_key_spki = f.pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.throws(() => validateTrustConfiguration(privateConfiguration, { audience: 'node-a' }));
});

test('clock rollback after pruning cannot reopen an expired nonce window', () => {
  const f = fixture();
  assert.equal(f.verifier.verify(f.sign(), f.request).ok, true);
  f.setNow(NOW + 61000);
  assert.equal(f.verifier.verify(f.sign({ issuedAt: NOW / 1000 + 61, nonce: 'nonce-future-00000000000001' }), f.request).ok, true);
  f.setNow(NOW);
  assert.equal(f.verifier.verify(f.sign(), f.request).code, 'PRINCIPAL_CLOCK_UNSAFE');
});
