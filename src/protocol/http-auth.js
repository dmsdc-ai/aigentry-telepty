'use strict';

const crypto = require('crypto');
const net = require('net');

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

// Build a net.BlockList from allowlist entries so the ":170 comment"-promised
// "IPs/CIDRs" actually work: `a.b.c.d/n` → subnet, plain IP → exact address (exact
// entries keep the prior includes() semantics). Native (Node v15+), zero-dep. A
// malformed entry is skipped, never fatal. Returns null when the list is empty so the
// caller can preserve the "empty = allow all authenticated" branch.
function buildAllowBlockList(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const bl = new net.BlockList();
  for (const raw of entries) {
    const entry = String(raw).trim();
    if (!entry) continue;
    try {
      const slash = entry.indexOf('/');
      if (slash !== -1) {
        const addr = entry.slice(0, slash);
        const prefix = Number(entry.slice(slash + 1));
        const type = net.isIPv6(addr) ? 'ipv6' : 'ipv4';
        bl.addSubnet(addr, prefix, type);
      } else {
        const type = net.isIPv6(entry) ? 'ipv6' : 'ipv4';
        bl.addAddress(entry, type);
      }
    } catch { /* skip a malformed allowlist entry — never crash the daemon */ }
  }
  return bl;
}

function createIsAllowedPeer(PEER_ALLOWLIST) {
  const blockList = buildAllowBlockList(PEER_ALLOWLIST);
  function isAllowedPeer(ip) {
    if (!ip) return false;
    const cleanIp = ip.replace('::ffff:', '');
    // Localhost always allowed (includes SSH tunnel traffic). FIRST — auto-populating
    // the allowlist can never tighten loopback.
    if (cleanIp === '127.0.0.1' || ip === '::1') return true;
    // No allowlist = allow all authenticated (preserved)
    if (!blockList) return true;
    // Peer allowlist — CIDR + exact match
    try {
      return blockList.check(cleanIp, net.isIPv6(cleanIp) ? 'ipv6' : 'ipv4');
    } catch { return false; }
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
