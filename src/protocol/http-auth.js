'use strict';

const crypto = require('crypto');

function createVerifyJwt(JWT_SECRET) {
  function verifyJwt(token) {
    if (!JWT_SECRET || !token) return false;
    try {
      // Simple HS256 JWT verification (no external deps)
      const [headerB64, payloadB64, sigB64] = token.split('.');
      if (!headerB64 || !payloadB64 || !sigB64) return false;
      const expected = crypto.createHmac('sha256', JWT_SECRET)
        .update(`${headerB64}.${payloadB64}`).digest('base64url');
      if (sigB64 !== expected) return false;
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
      if (payload.exp && Date.now() / 1000 > payload.exp) return false;
      return payload;
    } catch { return false; }
  }

  return verifyJwt;
}

function createBrokerAcl(aclTable = {}) {
  return {
    canInject(fromNode, toNode) {
      if (!fromNode || !toNode) return false;
      const allowedTargets = aclTable[fromNode];
      if (Array.isArray(allowedTargets)) return allowedTargets.includes(toNode);
      if (allowedTargets instanceof Set) return allowedTargets.has(toNode);
      return false;
    }
  };
}

function signNodeJwt(secret, claims) {
  if (!secret) throw new Error('JWT secret is required');
  if (!claims || typeof claims !== 'object') throw new Error('JWT claims are required');

  const headerB64 = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sigB64 = crypto.createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

function isRevokedNode(revokedNodes, decodedJwtOrSub) {
  const sub = typeof decodedJwtOrSub === 'string' ? decodedJwtOrSub : decodedJwtOrSub && decodedJwtOrSub.sub;
  if (!sub || !revokedNodes) return false;
  if (Array.isArray(revokedNodes)) return revokedNodes.includes(sub);
  if (revokedNodes instanceof Set) return revokedNodes.has(sub);
  return false;
}

function createIsAllowedPeer(PEER_ALLOWLIST) {
  function isAllowedPeer(ip) {
    if (!ip) return false;
    const cleanIp = ip.replace('::ffff:', '');
    // Localhost always allowed (includes SSH tunnel traffic)
    if (cleanIp === '127.0.0.1' || ip === '::1') return true;
    // Peer allowlist
    if (PEER_ALLOWLIST.length > 0) return PEER_ALLOWLIST.includes(cleanIp);
    // No allowlist = allow all authenticated
    return true;
  }

  return isAllowedPeer;
}

function createAuthMiddleware(options) {
  const EXPECTED_TOKEN = options.expectedToken;
  const isAllowedPeer = options.isAllowedPeer;
  const verifyJwt = options.verifyJwt;

  return (req, res, next) => {
    const clientIp = req.ip;

    if (isAllowedPeer(clientIp)) {
      return next(); // Trust local and allowlisted peers (SSH tunnels arrive as localhost)
    }

    const token = req.headers['x-telepty-token'] || req.query.token;
    if (token === EXPECTED_TOKEN) {
      return next();
    }

    // JWT Bearer token
    const authHeader = req.headers['authorization'] || '';
    if (authHeader.startsWith('Bearer ') && verifyJwt(authHeader.slice(7))) {
      return next();
    }

    console.warn(`[AUTH] Rejected unauthorized request from ${clientIp}`);
    res.status(401).json({ error: 'Unauthorized: Invalid or missing token.', code: 'PERMISSION_DENIED' });
  };
}

module.exports = {
  createAuthMiddleware,
  createBrokerAcl,
  createIsAllowedPeer,
  createVerifyJwt,
  isRevokedNode,
  signNodeJwt
};
