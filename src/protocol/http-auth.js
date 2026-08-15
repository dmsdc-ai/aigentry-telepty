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

// #820/#823 — is this address the machine itself? Both entrances need the IDENTICAL predicate,
// so it lives here and is exported rather than being spelled out twice.
//
// The forms a real socket reports differ by entrance: `req.ip` under Express, and
// `req.socket.remoteAddress` on a raw upgrade, which on a dual-stack listener hands back
// v4-mapped v6 (`::ffff:127.0.0.1`). All of 127.0.0.0/8 is loopback, not just 127.0.0.1 — a
// caller bound to 127.0.0.2 is every bit as local, and treating it as remote would be a
// difference the OS does not make.
function isLoopbackAddress(ip) {
  if (typeof ip !== 'string' || ip === '') return false;
  const clean = ip.replace(/^::ffff:/i, '');
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;
  return clean === '::1' || clean === '0:0:0:0:0:0:0:1';
}

// Build a net.BlockList from allowlist entries so the ":170 comment"-promised
// "IPs/CIDRs" actually work: `a.b.c.d/n` → subnet, plain IP → exact address (exact
// entries keep the prior includes() semantics). Native (Node v15+), zero-dep. A
// malformed entry is skipped, never fatal. Returns null when the list is empty so the
// caller can preserve the "empty = no IP restriction" branch.
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

// #823 — this answers ONE question: may this address open a connection at all? It is network
// REACHABILITY policy, and it is never a credential. Authentication is a separate, unconditional
// check that runs after it (see createAuthMiddleware). Every branch below therefore says "not
// restricted here", never "trusted".
//
// It was read as a credential for the whole of 0.7.x because the middleware returned `next()` on
// a `true` from here. All three true-branches granted full uncredentialed access: loopback, the
// empty list, and — the one that reads as safe and is not — an address that MATCHES a non-empty
// list. #672's tailnet auto-trust injects the tailnet CIDR into that list on the DEFAULT config,
// so on this host `curl http://<tailnet-ip>:3848/api/sessions` answered 200 with no token.
function createIsAllowedPeer(PEER_ALLOWLIST) {
  const blockList = buildAllowBlockList(PEER_ALLOWLIST);
  function isAllowedPeer(ip) {
    if (!ip) return false;
    const cleanIp = ip.replace('::ffff:', '');
    // Loopback is never narrowed away. FIRST, so auto-populating the allowlist cannot lock the
    // local CLI out of its own daemon. This is reachability only — a loopback caller still has to
    // present the token, which is the whole of #820.
    if (isLoopbackAddress(ip)) return true;
    // Empty allowlist = no IP restriction. NOT "allow all authenticated": this function does not
    // authenticate anything, and the call site that used to read it that way is what shipped the
    // hole. Authentication is enforced separately and unconditionally.
    if (!blockList) return true;
    // Peer allowlist — CIDR + exact match
    try {
      return blockList.check(cleanIp, net.isIPv6(cleanIp) ? 'ipv6' : 'ipv4');
    } catch { return false; }
  }

  return isAllowedPeer;
}

// #806. A page the user merely visits could `fetch('http://127.0.0.1:3848/api/…/inject',
// {method:'POST'})` and type into a live AI CLI session — the response is CORS-gated but the
// REQUEST EXECUTES, and a WebSocket handshake is not CORS-gated at all. Since #820 that page also
// needs the daemon token, which a cross-origin script cannot read; this guard remains the layer
// that stops the request from executing in the first place, and it is still worth having —
// defence in depth is the point, and a token can leak.
//
// Browsers ALWAYS attach `Origin` to a cross-origin fetch and to every WS handshake; curl, the
// telepty CLI, and cross-host peers never do. So: a request that CARRIES Origin must name an
// explicitly allowlisted origin (TELEPTY_ALLOWED_ORIGINS, default empty = no browser may call
// the API) — checked before the peer and credential branches, so a stolen credential cannot buy a
// disallowed origin past it. An origin-less caller takes exactly the path it took before.
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
const PEER_DENIED = {
  error: 'Forbidden: this address is not in TELEPTY_PEER_ALLOWLIST.',
  code: 'PEER_NOT_ALLOWED'
};
const CREDENTIAL_DENIED = { error: 'Unauthorized: Invalid or missing token.', code: 'PERMISSION_DENIED' };

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

    // #820/#823 — REACHABILITY, and it can only narrow. This used to be `if (isAllowedPeer(ip))
    // return next()`, i.e. the network's answer standing in for the caller's credential: any local
    // process, and on a network-bound or tailnet listener any reachable device, read and wrote
    // every PTY, enumerated every session, and POSTed /api/sessions/spawn with its own `command`
    // and `cwd`. Reachability is not authentication. A failure here is 403 (policy), distinct from
    // the 401 below (credential), so a caller can tell "you may not connect from there" from
    // "you did not prove who you are".
    if (!isAllowedPeer(clientIp)) {
      console.warn(`[AUTH] Rejected request from ${clientIp} — not in the peer allowlist`);
      return res.status(403).json(PEER_DENIED);
    }

    // ...and now the credential, for EVERY address including loopback. There is no branch above
    // this that reaches a route.
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
    res.status(401).json(CREDENTIAL_DENIED);
  };
}

module.exports = {
  createAuthMiddleware,
  createBrokerAcl,
  createIsAllowedPeer,
  createOriginGuard,
  createVerifyJwt,
  isLoopbackAddress,
  isRevokedNode,
  signNodeJwt
};
