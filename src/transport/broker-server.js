'use strict';

// Broker-side HTTP surface (spec §2(B) + §3.1 + §4). Mounted only in broker mode;
// the daemon (W3/T5) wires the returned `handler` onto its TLS server. This module
// is a self-contained Node `http` request handler — no framework, no external dep
// (§17). It REUSES the W1 primitives verbatim:
//   - src/transport/broker-protocol.js : envelope build, SSE frame, ack shape, seq, dedup
//   - src/protocol/http-auth.js        : createVerifyJwt, signNodeJwt, createBrokerAcl,
//                                        isRevokedNode (no reimplementation here)

const crypto = require('crypto');

const {
  buildInjectEnvelope,
  buildSseInjectFrame,
  createSseSequencer,
  parseLastEventId,
} = require('./broker-protocol');

const {
  createBrokerAcl,
  createVerifyJwt,
  isRevokedNode,
  signNodeJwt,
} = require('../protocol/http-auth');

const DAY_SECONDS = 24 * 60 * 60;

// Constant-time secret compare (§4.6a). Hash both sides to a fixed length first so
// neither the timing nor the length of the comparison leaks the secret.
function constantTimeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a == null ? '' : a)).digest();
  const hb = crypto.createHash('sha256').update(String(b == null ? '' : b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function getClientIp(req) {
  const raw = (req.socket && req.socket.remoteAddress) || '';
  return raw.replace('::ffff:', '');
}

function extractBearer(req) {
  const auth = req.headers['authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

function readJsonBody(req, { limit = 1 << 20 } = {}) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > limit) {
        aborted = true;
        resolve({ tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({ value: {} });
      try {
        resolve({ value: JSON.parse(raw) });
      } catch {
        resolve({ invalid: true });
      }
    });
    req.on('error', () => resolve({ invalid: true }));
  });
}

function sendJson(res, status, body) {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function createBrokerServer(options = {}) {
  const {
    jwtSecret,
    enrollSecret,
    fleet = 'default',
    broadcastBusEvent = () => {},
    // §4.5/§4.6b abuse controls
    enrollRatePerMin = 5,
    maxNodes = Number(process.env.TELEPTY_ENROLL_MAX_NODES) || 256,
    jwtTtlSeconds = 30 * DAY_SECONDS,
    // §3.1/§3.3 delivery
    injectTimeoutMs = 15000,
    maxQueue = 100,
    heartbeatMs = 22000,
    replayBufferMax = 100,
    // TLS gate (§3.0 / §4.4): when the broker is TLS-configured, reject plaintext.
    requireTls = false,
    // injectable for determinism / wiring
    now = () => Date.now(),
    randomUUID = () => crypto.randomUUID(),
    onAudit = null,
    // #47 P5 — cross-machine delivery audit seam (spec §9). The broker is pure (no fs), so it
    // delegates to a daemon-supplied sink that funnels the record through the SAME inject-log
    // buildAuditLine + writer as local deliveries. Default null = no emission (no #42 redesign).
    onInjectAudit = null,
  } = options;

  if (!jwtSecret) throw new Error('createBrokerServer requires jwtSecret');
  if (!enrollSecret) throw new Error('createBrokerServer requires enrollSecret');

  // Mutable so the daemon / `telepty broker allow|deny|revoke` admin commands and
  // tests can grant/revoke at runtime. ACL defaults to empty → default-deny (§4.1).
  const aclTable = options.aclTable || {};
  const revokedNodes = options.revokedNodes || new Set();
  const acl = createBrokerAcl(aclTable);
  const verifyJwt = createVerifyJwt(jwtSecret);

  // Broker state ----------------------------------------------------------------
  const nodes = new Map(); // name -> node state
  const pending = new Map(); // inject_id -> held /broker/inject response
  const enrollWindows = new Map(); // ip -> [timestamps]
  const auditLog = [];
  let closed = false;

  function nodeState(name) {
    let node = nodes.get(name);
    if (!node) {
      node = {
        name,
        sub: name,
        sessions: [],
        lastSeen: now(),
        stream: null,
        heartbeatTimer: null,
        seq: createSseSequencer(),
        replay: [], // [{ seq, frame }]
        inflight: [], // inject_ids awaiting ack (bounded by maxQueue)
      };
      nodes.set(name, node);
    }
    return node;
  }

  function audit(entry) {
    const record = { timestamp: new Date(now()).toISOString(), ...entry };
    auditLog.push(record);
    if (typeof onAudit === 'function') {
      try { onAudit(record); } catch { /* audit sink must never break enroll */ }
    }
    // §4.6b — emit a broker_enroll bus event (reuse the daemon bus broadcaster).
    try {
      broadcastBusEvent({
        type: 'broker_enroll',
        node: entry.node,
        source_host: entry.ip,
        result: entry.result,
        timestamp: record.timestamp,
      });
    } catch { /* bus broadcast is best-effort */ }
  }

  // Auth gate for every /broker/* except enroll: verify node-JWT + revocation set.
  function authNode(req, res) {
    const token = extractBearer(req);
    if (!token) {
      sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', error: 'Missing node JWT' });
      return null;
    }
    const decoded = verifyJwt(token);
    if (!decoded) {
      sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', error: 'Invalid or expired node JWT' });
      return null;
    }
    if (isRevokedNode(revokedNodes, decoded)) {
      sendJson(res, 401, { ok: false, code: 'REVOKED', error: 'Node JWT has been revoked' });
      return null;
    }
    return decoded;
  }

  // Per-IP sliding-window rate limit for /broker/enroll (§4.6b).
  function enrollRateExceeded(ip) {
    const ts = now();
    const windowStart = ts - 60_000;
    const hits = (enrollWindows.get(ip) || []).filter((t) => t > windowStart);
    if (hits.length >= enrollRatePerMin) {
      enrollWindows.set(ip, hits);
      return true;
    }
    hits.push(ts);
    enrollWindows.set(ip, hits);
    return false;
  }

  function settlePending(injectId, status, ackBody) {
    const held = pending.get(injectId);
    if (!held || held.settled) return;
    held.settled = true;
    clearTimeout(held.timer);
    pending.delete(injectId);
    const node = nodes.get(held.toNode);
    if (node) {
      const idx = node.inflight.indexOf(injectId);
      if (idx !== -1) node.inflight.splice(idx, 1);
    }
    const body = {
      ok: status === 'ack',
      status,
      inject_id: injectId,
    };
    if (ackBody) {
      body.success = ackBody.success === true;
      body.code = ackBody.code || null;
      body.error = ackBody.error || null;
    }
    sendJson(held.res, 200, body);
  }

  function pushReplay(node, seq, frame) {
    node.replay.push({ seq, frame });
    if (node.replay.length > replayBufferMax) node.replay.shift();
  }

  // Endpoint handlers -----------------------------------------------------------

  async function handleEnroll(req, res) {
    const ip = getClientIp(req);

    // Rate-limit BEFORE any work so spam can never reach name processing (§4.6b).
    if (enrollRateExceeded(ip)) {
      audit({ node: null, ip, result: 'rate_limited' });
      return sendJson(res, 429, { ok: false, code: 'RATE_LIMITED', error: 'Enroll rate limit exceeded' });
    }

    const parsed = await readJsonBody(req);
    if (parsed.tooLarge) return sendJson(res, 413, { ok: false, code: 'PAYLOAD_TOO_LARGE', error: 'Body too large' });
    if (parsed.invalid) return sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', error: 'Invalid JSON body' });

    const body = parsed.value || {};
    const node = typeof body.node === 'string' ? body.node.trim() : '';
    if (!node) {
      audit({ node: null, ip, result: 'bad_request' });
      return sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', error: 'Missing node name' });
    }

    // Ownership / rotation path (§4.6a, §4.6c): a re-enroll carrying the current
    // valid JWT for this name proves ownership — no enroll-secret needed.
    const bearer = extractBearer(req);
    const bearerClaims = bearer ? verifyJwt(bearer) : false;
    const isOwner = !!bearerClaims
      && bearerClaims.sub === node
      && !isRevokedNode(revokedNodes, bearerClaims);

    if (!isOwner && !constantTimeEqual(enrollSecret, req.headers['x-telepty-enroll'])) {
      audit({ node, ip, result: 'unauthorized' });
      return sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', error: 'Invalid enroll secret' });
    }

    const existing = nodes.has(node);

    // Anti-squat (§4.6a): an existing name can only be re-claimed by its owner.
    if (existing && !isOwner) {
      audit({ node, ip, result: 'duplicate' });
      return sendJson(res, 409, { ok: false, code: 'NAME_TAKEN', error: 'Node name already enrolled' });
    }

    // Global fleet cap (§4.6b) — only new identities count against it.
    if (!existing && nodes.size >= maxNodes) {
      audit({ node, ip, result: 'capped' });
      return sendJson(res, 429, { ok: false, code: 'ENROLL_CAP', error: 'Fleet enroll cap reached' });
    }

    const iat = Math.floor(now() / 1000);
    const exp = iat + jwtTtlSeconds;
    const jwt = signNodeJwt(jwtSecret, { sub: node, fleet, iat, exp });

    // Register identity + write an EMPTY ACL entry → default-deny: enrolled ≠
    // authorized (§4.6 core safety argument). Only on first enroll.
    nodeState(node);
    if (!Array.isArray(aclTable[node])) aclTable[node] = [];

    audit({ node, ip, result: existing ? 'rotated' : 'enrolled' });
    return sendJson(res, 200, { ok: true, node, jwt, exp, fleet });
  }

  async function handleRegister(req, res) {
    const decoded = authNode(req, res);
    if (!decoded) return;
    const parsed = await readJsonBody(req);
    if (parsed.invalid) return sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', error: 'Invalid JSON body' });
    const node = nodeState(decoded.sub);
    const sessions = Array.isArray(parsed.value && parsed.value.sessions) ? parsed.value.sessions : [];
    node.sessions = sessions;
    node.lastSeen = now();
    return sendJson(res, 200, { ok: true, node: decoded.sub, since: node.lastSeen });
  }

  function handleStream(req, res) {
    const decoded = authNode(req, res);
    if (!decoded) return;
    const node = nodeState(decoded.sub);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    node.stream = res;
    node.lastSeen = now();

    // Reconnect replay (§3.3, at-least-once): redeliver buffered frames after the
    // given Last-Event-ID; the receiving node dedups by message_id.
    const lastEventId = parseLastEventId(req.headers['last-event-id']);
    if (lastEventId !== null) {
      for (const buffered of node.replay) {
        if (buffered.seq > lastEventId) res.write(buffered.frame);
      }
    }

    // Heartbeat comment so EDR/proxies keep the chunked stream open (§3.3).
    node.heartbeatTimer = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, heartbeatMs);
    if (node.heartbeatTimer.unref) node.heartbeatTimer.unref();

    const cleanup = () => {
      if (node.heartbeatTimer) {
        clearInterval(node.heartbeatTimer);
        node.heartbeatTimer = null;
      }
      if (node.stream === res) node.stream = null;
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
  }

  async function handleInject(req, res) {
    const decoded = authNode(req, res);
    if (!decoded) return;
    const fromNode = decoded.sub;

    const parsed = await readJsonBody(req);
    if (parsed.invalid) return sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', error: 'Invalid JSON body' });
    const body = parsed.value || {};
    const toNode = typeof body.to_node === 'string' ? body.to_node : '';
    const toSession = typeof body.to_session === 'string' ? body.to_session : '';
    if (!toNode || !toSession) {
      return sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', error: 'Missing to_node/to_session' });
    }

    // Authorize: default-deny ACL (§4.1). A stolen token reaches only granted
    // targets — closes T2 fleet-wide escalation.
    if (!acl.canInject(fromNode, toNode)) {
      return sendJson(res, 403, { ok: false, code: 'FORBIDDEN', status: 'forbidden', error: `Not authorized to inject ${toNode}` });
    }

    const target = nodes.get(toNode);
    if (!target || !target.stream || target.stream.writableEnded) {
      return sendJson(res, 200, { ok: false, status: 'unreachable', error: `Target node ${toNode} not connected` });
    }

    const messageId = typeof body.message_id === 'string' && body.message_id ? body.message_id : randomUUID();
    const injectId = typeof body.inject_id === 'string' && body.inject_id ? body.inject_id : randomUUID();

    let envelope;
    try {
      envelope = buildInjectEnvelope({
        message_id: messageId,
        inject_id: injectId,
        to_node: toNode,
        to_session: toSession,
        from_node: fromNode,
        target: body.target,
        source_host: fromNode,
        payload: body.payload || {},
      });
    } catch (err) {
      return sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', error: err.message });
    }

    // Backpressure (§3.3): bounded per-node in-flight queue. On overflow drop the
    // oldest held inject (resolve it node_backlogged) so the new one can be served
    // — request/reply parity means the originator is never silently dropped.
    while (target.inflight.length >= maxQueue) {
      const oldest = target.inflight.shift();
      settlePending(oldest, 'node_backlogged');
    }

    const seq = target.seq.next();
    const frame = buildSseInjectFrame(seq, envelope);
    pushReplay(target, seq, frame);
    target.stream.write(frame);

    // #47 P5 — emit a shared-schema audit line for this cross-machine delivery (spec §9). The
    // sender is broker-verified by JWT `sub` regardless of the spoofable payload `from`, so
    // verified_sender_sid = node:<sub> and origin = untrusted-remote. The sink must never break
    // delivery.
    if (typeof onInjectAudit === 'function') {
      try {
        onInjectAudit({
          inject_id: injectId,
          kind: 'inject',
          source: 'broker',
          claimed_from: (body.payload && body.payload.from) || null,
          verified_sender_sid: `node:${fromNode}`,
          to: toSession,
          to_alias: typeof body.target === 'string' ? body.target : null,
          origin: 'untrusted-remote',
          origin_host: fromNode,
          payload: (body.payload && body.payload.prompt) || '',
          delivery_result: 'success',
        });
      } catch { /* audit sink must never break broker delivery */ }
    }

    // Hold the response until the target acks or the 15s timeout (§3.1 sync parity).
    const timer = setTimeout(() => settlePending(injectId, 'timeout'), injectTimeoutMs);
    if (timer.unref) timer.unref();
    pending.set(injectId, { res, timer, toNode, settled: false });
    target.inflight.push(injectId);
  }

  async function handleAck(req, res) {
    const decoded = authNode(req, res);
    if (!decoded) return;
    const parsed = await readJsonBody(req);
    if (parsed.invalid) return sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', error: 'Invalid JSON body' });
    const body = parsed.value || {};
    const injectId = typeof body.inject_id === 'string' ? body.inject_id : '';
    if (!injectId) return sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', error: 'Missing inject_id' });

    settlePending(injectId, body.success === true ? 'ack' : 'failed', {
      success: body.success,
      code: body.code,
      error: body.error,
    });
    return sendJson(res, 200, { ok: true, inject_id: injectId });
  }

  async function handleHeartbeat(req, res) {
    const decoded = authNode(req, res);
    if (!decoded) return;
    const parsed = await readJsonBody(req);
    const node = nodeState(decoded.sub);
    node.lastSeen = now();
    if (parsed.value && Array.isArray(parsed.value.sessions)) node.sessions = parsed.value.sessions;
    return sendJson(res, 200, { ok: true, node: decoded.sub, ts: node.lastSeen });
  }

  function handleSessions(req, res) {
    const decoded = authNode(req, res);
    if (!decoded) return;
    const aggregate = [];
    for (const node of nodes.values()) {
      for (const session of node.sessions) {
        const base = (session && typeof session === 'object') ? session : { id: session };
        aggregate.push({ ...base, peerName: node.name, host: node.name });
      }
    }
    return sendJson(res, 200, { ok: true, sessions: aggregate });
  }

  // Router ----------------------------------------------------------------------
  function handler(req, res) {
    if (closed) return sendJson(res, 503, { ok: false, code: 'CLOSED', error: 'Broker shutting down' });

    // Reject plaintext when TLS is configured (§4.4) — the daemon mounts this on an
    // HTTPS server; a request that is not encrypted is rejected outright.
    if (requireTls && !(req.socket && req.socket.encrypted)) {
      return sendJson(res, 400, { ok: false, code: 'TLS_REQUIRED', error: 'TLS is required for /broker/*' });
    }

    const url = (req.url || '').split('?')[0];
    const method = req.method;

    try {
      if (url === '/broker/enroll' && method === 'POST') return handleEnroll(req, res);
      if (url === '/broker/register' && method === 'POST') return handleRegister(req, res);
      if (url === '/broker/stream' && method === 'GET') return handleStream(req, res);
      if (url === '/broker/inject' && method === 'POST') return handleInject(req, res);
      if (url === '/broker/ack' && method === 'POST') return handleAck(req, res);
      if (url === '/broker/heartbeat' && method === 'POST') return handleHeartbeat(req, res);
      if (url === '/broker/sessions' && method === 'GET') return handleSessions(req, res);
    } catch (err) {
      return sendJson(res, 500, { ok: false, code: 'INTERNAL', error: err.message });
    }

    return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: 'Unknown broker route' });
  }

  function close() {
    closed = true;
    for (const held of pending.values()) {
      clearTimeout(held.timer);
      if (!held.res.writableEnded) {
        try { sendJson(held.res, 200, { ok: false, status: 'shutdown' }); } catch { /* ignore */ }
      }
    }
    pending.clear();
    for (const node of nodes.values()) {
      if (node.heartbeatTimer) clearInterval(node.heartbeatTimer);
      if (node.stream && !node.stream.writableEnded) {
        try { node.stream.end(); } catch { /* ignore */ }
      }
    }
  }

  return {
    handler,
    close,
    // exposed for the daemon wiring (W3/T5) + tests
    aclTable,
    revokedNodes,
    auditLog,
    nodes,
    grant(fromNode, toNode) {
      if (!Array.isArray(aclTable[fromNode])) aclTable[fromNode] = [];
      if (!aclTable[fromNode].includes(toNode)) aclTable[fromNode].push(toNode);
    },
  };
}

module.exports = { createBrokerServer };
