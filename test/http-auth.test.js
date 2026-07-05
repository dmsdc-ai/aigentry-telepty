'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  createAuthMiddleware,
  createIsAllowedPeer,
  createVerifyJwt
} = require('../src/protocol/http-auth');

function signJwt(payload, secret) {
  const headerB64 = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sigB64 = crypto.createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

function runAuthMiddleware(middleware, reqOverrides = {}) {
  let nextCalled = false;
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
  const req = {
    ip: '203.0.113.10',
    headers: {},
    query: {},
    ...reqOverrides
  };

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    middleware(req, res, () => {
      nextCalled = true;
    });
  } finally {
    console.warn = originalWarn;
  }

  return { nextCalled, res };
}

test('auth middleware rejects unauthorized request with 401', () => {
  const middleware = createAuthMiddleware({
    isAllowedPeer: createIsAllowedPeer(['203.0.113.11']),
    expectedToken: 'expected-token',
    verifyJwt: createVerifyJwt('jwt-secret')
  });

  const result = runAuthMiddleware(middleware);

  assert.equal(result.nextCalled, false);
  assert.equal(result.res.statusCode, 401);
  assert.deepEqual(result.res.body, {
    error: 'Unauthorized: Invalid or missing token.',
    code: 'PERMISSION_DENIED'
  });
});

test('auth middleware accepts valid bearer JWT', () => {
  const secret = 'jwt-secret';
  const middleware = createAuthMiddleware({
    isAllowedPeer: createIsAllowedPeer(['203.0.113.11']),
    expectedToken: 'expected-token',
    verifyJwt: createVerifyJwt(secret)
  });
  const token = signJwt({ sub: 'test', exp: Math.floor(Date.now() / 1000) + 60 }, secret);

  const result = runAuthMiddleware(middleware, {
    headers: { authorization: `Bearer ${token}` }
  });

  assert.equal(result.nextCalled, true);
  assert.equal(result.res.statusCode, null);
  assert.equal(result.res.body, null);
});

test('peer outside allowlist is rejected without a valid credential', () => {
  const middleware = createAuthMiddleware({
    isAllowedPeer: createIsAllowedPeer(['203.0.113.11']),
    expectedToken: 'expected-token',
    verifyJwt: createVerifyJwt('jwt-secret')
  });

  const result = runAuthMiddleware(middleware, {
    ip: '203.0.113.12'
  });

  assert.equal(result.nextCalled, false);
  assert.equal(result.res.statusCode, 401);
  assert.deepEqual(result.res.body, {
    error: 'Unauthorized: Invalid or missing token.',
    code: 'PERMISSION_DENIED'
  });
});

test('allowlisted peer bypasses token checks', () => {
  const middleware = createAuthMiddleware({
    isAllowedPeer: createIsAllowedPeer(['203.0.113.12']),
    expectedToken: 'expected-token',
    verifyJwt: createVerifyJwt('jwt-secret')
  });

  const result = runAuthMiddleware(middleware, {
    ip: '::ffff:203.0.113.12'
  });

  assert.equal(result.nextCalled, true);
  assert.equal(result.res.statusCode, null);
});

// ── #672: CIDR-aware isAllowedPeer (net.BlockList) ──────────────────────────────

test('isAllowedPeer: CIDR entry matches in-range peer, rejects out-of-range', () => {
  const allowed = createIsAllowedPeer(['100.64.0.0/10']); // tailnet auto-trust CIDR
  assert.equal(allowed('100.72.155.21'), true);           // in /10
  assert.equal(allowed('::ffff:100.90.0.1'), true);       // v4-mapped in /10
  assert.equal(allowed('100.128.0.1'), false);            // just outside /10
  assert.equal(allowed('203.0.113.5'), false);            // unrelated LAN/public
});

test('isAllowedPeer: loopback always allowed regardless of allowlist (not tightened)', () => {
  const allowed = createIsAllowedPeer(['100.64.0.0/10']);
  assert.equal(allowed('127.0.0.1'), true);
  assert.equal(allowed('::1'), true);
});

test('isAllowedPeer: empty allowlist preserves "allow all authenticated" branch', () => {
  const allowed = createIsAllowedPeer([]);
  assert.equal(allowed('203.0.113.5'), true);
  assert.equal(allowed('100.72.0.1'), true);
});

test('isAllowedPeer: exact-IP entries keep exact-match semantics (no widening)', () => {
  const allowed = createIsAllowedPeer(['100.72.9.9']);
  assert.equal(allowed('100.72.9.9'), true);
  assert.equal(allowed('100.72.9.10'), false); // sibling not implied by an exact entry
});

test('isAllowedPeer: a malformed allowlist entry is skipped, never crashes', () => {
  const allowed = createIsAllowedPeer(['not-an-ip', '100.64.0.0/10']);
  assert.equal(allowed('100.72.0.1'), true);   // valid CIDR still enforced
  assert.equal(allowed('8.8.8.8'), false);
});
