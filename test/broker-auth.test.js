'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createBrokerAcl,
  createVerifyJwt,
  isRevokedNode,
  signNodeJwt,
} = require('../src/protocol/http-auth');

test('createBrokerAcl allows explicitly listed targets', () => {
  const acl = createBrokerAcl({
    nodeA: ['nodeB', 'nodeC'],
    nodeB: ['nodeA'],
  });

  assert.equal(acl.canInject('nodeA', 'nodeB'), true);
  assert.equal(acl.canInject('nodeB', 'nodeA'), true);
});

test('createBrokerAcl default-denies absent nodes and unlisted targets', () => {
  const acl = createBrokerAcl({
    nodeA: ['nodeB'],
  });

  assert.equal(acl.canInject('nodeZ', 'nodeA'), false);
  assert.equal(acl.canInject('nodeA', 'nodeC'), false);
});

test('signNodeJwt mints a token accepted by createVerifyJwt', () => {
  const secret = 'broker-secret';
  const claims = { sub: 'nodeA', fleet: 'fleet-1', iat: 1_800_000_000, exp: 1_900_000_000 };
  const token = signNodeJwt(secret, claims);

  assert.deepEqual(createVerifyJwt(secret)(token), claims);
});

test('createVerifyJwt rejects expired and wrong-signature node JWTs', () => {
  const validSecret = 'broker-secret';
  const claims = { sub: 'nodeA', fleet: 'fleet-1', iat: 1, exp: 2 };
  const token = signNodeJwt(validSecret, claims);

  assert.equal(createVerifyJwt(validSecret)(token), false);
  assert.equal(createVerifyJwt('wrong-secret')(token), false);
});

test('revocation helper checks decoded JWT sub against array or Set input', () => {
  assert.equal(isRevokedNode(['nodeA'], { sub: 'nodeA' }), true);
  assert.equal(isRevokedNode(new Set(['nodeB']), 'nodeB'), true);
  assert.equal(isRevokedNode(['nodeA'], { sub: 'nodeB' }), false);
  assert.equal(isRevokedNode(null, { sub: 'nodeA' }), false);
});
