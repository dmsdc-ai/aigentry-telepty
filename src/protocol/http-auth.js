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

// Loopback trust is not authentication against a browser. The daemon listens on loopback and
// isAllowedPeer trusts 127.0.0.1/::1 unconditionally and first, so a page the user merely
// visits could `fetch('http://127.0.0.1:3848/api/…/inject', {method:'POST'})` and type into a
// live AI CLI session — the response is CORS-gated but the REQUEST EXECUTES, and a WebSocket
// handshake is not CORS-gated at all.
//
// Browsers ALWAYS attach `Origin` to a cross-origin fetch and to every WS handshake; curl, the
// telepty CLI, and SSH-tunnelled peers never do. So: a request that CARRIES Origin must name an
// explicitly allowlisted origin (TELEPTY_ALLOWED_ORIGINS, default empty = no browser may call
// the API) — checked before the loopback/token branches, so a stolen credential cannot buy a
// disallowed origin past it. An origin-less caller takes exactly the path it took before, which
// is every CLI/tunnel/peer flow that exists today.
//
// `Origin: null` (sandboxed iframe, file://) is a value, not an absence — it stays blocked.
function createOriginGuard(allowedOrigins) {
  const allowed = new Set((allowedOrigins || []).map((o) => String(o).trim()).filter(Boolean));
  return function isForbiddenOrigin(origin) {
    if (!origin) return false; // not a browser — pre-existing behavior, byte-identical
    return !allowed.has(origin);
  };
}

const ORIGIN_DENIED = { error: 'Forbidden: browser origin not allowed.', code: 'ORIGIN_NOT_ALLOWED' };

function createAuthMiddleware(options) {
  const EXPECTED_TOKEN = options.expectedToken;
  const isAllowedPeer = options.isAllowedPeer;
  const verifyJwt = options.verifyJwt;
  // Default-deny when the caller passes no allowlist: a construction site that forgets this
  // option must fail closed on the browser vector, never fall back to the old open behavior.
  const isForbiddenOrigin = options.isForbiddenOrigin || createOriginGuard(options.allowedOrigins);

  return (req, res, next) => {
    const clientIp = req.ip;

    if (isForbiddenOrigin(req.headers && req.headers['origin'])) {
      console.warn(`[AUTH] Rejected browser-originated request from ${clientIp} (origin: ${req.headers['origin']})`);
      return res.status(403).json(ORIGIN_DENIED);
    }

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
  createOriginGuard,
  createVerifyJwt,
  isRevokedNode,
  signNodeJwt
};
