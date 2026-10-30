'use strict';
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const { createBrokerAudit } = require('./audit');
const { createPrincipalVerifier, validateTrustConfiguration } = require('../principal/proof');
const { createForwardLedger } = require('../peer-forwarding');
const { createBrokerDispatch } = require('./dispatch');
const { createBrokerRouting } = require('./routing');
const { canonicalJSON } = require('../principal/encoding');
const { id, error, readBody, json, verify } = require('./http');
const ACTIONS = ['broker.stream', 'broker.inject', 'broker.receipt', 'broker.result', 'broker.envelope', 'broker.broadcast', 'broker.reply_context', 'broker.reply'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function createBrokerHub({ config, privateKey, homeDir, tls, audit } = {}) {
  if (!config || config.schema !== 'telepty.broker-hub/v1' || !id(config.principal_id) || !id(config.key_id)
    || !config.nodes || typeof config.nodes !== 'object' || Array.isArray(config.nodes)
    || Object.keys(config.nodes).length < 1 || Object.keys(config.nodes).length > 64
    || !config.limits || typeof config.limits !== 'object' || Array.isArray(config.limits)
    || !Number.isInteger(config.stream_ms) || config.stream_ms < 1000 || config.stream_ms > 3600000) throw error('BROKER_CONFIG_INVALID');
  const trust = validateTrustConfiguration(config.trust, { audience: config.audience, allowedActions: ACTIONS });
  const verifier = createPrincipalVerifier({ trust });
  const signingKey = privateKey && privateKey.type === 'private' ? privateKey : crypto.createPrivateKey(privateKey);
  if (signingKey.asymmetricKeyType !== 'ed25519') throw error('BROKER_KEY_INVALID');
  const hubPublic = crypto.createPublicKey(signingKey).export({ type: 'spki', format: 'der' });
  for (const key of trust.keys.values()) {
    if (key.publicKey.export({ type: 'spki', format: 'der' }).equals(hubPublic)) throw error('BROKER_KEYS_MUST_BE_SEPARATE');
  }
  for (const [node, entry] of Object.entries(config.nodes)) {
    const limit = config.limits[node];
    if (!id(node) || !entry || typeof entry.audience !== 'string' || !entry.audience
      || Buffer.byteLength(entry.audience) > 256 || /[\x00-\x20\x7f]/.test(entry.audience) || !limit
      || !Number.isInteger(limit.max_payload_bytes) || limit.max_payload_bytes < 1 || limit.max_payload_bytes > 65536
      || !Number.isInteger(limit.max_requests) || limit.max_requests < 1 || limit.max_requests > 100
      || !Number.isInteger(limit.window_ms) || limit.window_ms < 1000 || limit.window_ms > 86400000
      || !Number.isInteger(limit.timeout_ms) || limit.timeout_ms < 100 || limit.timeout_ms > 10000
      || !Number.isInteger(limit.max_pending) || limit.max_pending < 1 || limit.max_pending > 16) throw error('BROKER_CONFIG_INVALID');
  }
  const ledger = createForwardLedger(homeDir);
  const streams = new Map(), timers = new Map();
  const auditLog = audit || createBrokerAudit({ path: path.join(homeDir || os.homedir(), '.telepty', 'logs', 'broker.jsonl') });
  function view(record) {
    return { receipt_id: record.receipt_id, source_node: record.source_node, target_node: record.target_node,
      session: record.session, expected_epoch: record.expected_epoch,
      state: record.state === 'pending' && !ledger.active.has(record.receipt_id) ? 'outcome_unknown' : record.state,
      code: record.code || null, remote_inject_id: record.remote_inject_id || null,
      remote_queued: record.remote_queued === true, ...(record.in_reply_to ? { in_reply_to: record.in_reply_to } : {}), foreign_session_identity_verified: false };
  }
  function finish(record, update) {
    const next = { ...record, ...update };
    ledger.write(next);
    auditLog.record({ event: 'receipt_outcome', receiptId: next.receipt_id, state: next.state });
    ledger.active.delete(record.receipt_id);
    clearTimeout(timers.get(record.receipt_id)); timers.delete(record.receipt_id);
    return next;
  }
  const dispatch = createBrokerDispatch({ config, signingKey, ledger, streams, timers, auditLog, finish, view });
  const routing = createBrokerRouting({ config, trust, ledger, dispatch, view });
  async function handler(req, res) {
    const requestAudit = { event: 'request', requestTarget: req.url };
    let challengeRequest = false;
    res.once('finish', () => { if (!challengeRequest) auditLog.record({ ...requestAudit, status: res.statusCode }); });
    function authenticate(body, action, target, epoch) {
      const principal = verify(verifier, req, body, action, target, epoch);
      requestAudit.principal = principal;
      return principal;
    }
    try {
      if (req.method === 'GET' && req.url === '/v1/challenge') { challengeRequest = true; return json(res, 200, {
        schema: 'telepty.broker-challenge/v1', audience: verifier.audience, challenge: verifier.challenge }); }
      const body = await readBody(req);
      requestAudit.payload = body && typeof body.prompt === 'string' ? body.prompt : undefined;
      const streamMatch = req.url.match(/^\/v1\/nodes\/([A-Za-z0-9._-]+)\/stream$/);
      const injectMatch = req.url.match(/^\/v1\/nodes\/([A-Za-z0-9._-]+)\/to\/([A-Za-z0-9._-]+)\/sessions\/([^/?]+)\/inject$/);
      const receiptMatch = req.url.match(/^\/v1\/nodes\/([A-Za-z0-9._-]+)\/receipts\/([A-Za-z0-9_-]{16,128})$/);
      const resultMatch = req.url.match(/^\/v1\/nodes\/([A-Za-z0-9._-]+)\/results\/([a-f0-9]{64})$/);
      const routed = routing({ req, body, authenticate });
      if (routed) return json(res, routed.status, routed.body);
      if (req.method === 'POST' && streamMatch) {
        const node = streamMatch[1];
        const principal = authenticate(body, 'broker.stream', node);
        if (principal.id !== node || !own(config.nodes, node) || !body || Object.keys(body).join() !== 'challenge'
          || !/^[A-Za-z0-9_-]{16,128}$/.test(body.challenge || '')) throw error('BROKER_NODE_DENIED', 403);
        if (streams.has(node)) throw error('BROKER_NODE_ALREADY_CONNECTED', 409);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
        res.write(': connected\n\n');
        const entry = { response: res, challenge: body.challenge };
        streams.set(node, entry);
        const heartbeat = setInterval(() => { if (!res.destroyed && res.writableLength < 128 * 1024) res.write(': heartbeat\n\n'); else res.destroy(); }, 15000);
        const lifetime = setTimeout(() => res.end(), config.stream_ms);
        res.on('close', () => {
          clearInterval(heartbeat); clearTimeout(lifetime);
          if (streams.get(node) === entry) streams.delete(node);
          let records;
          try { records = ledger.all(); } catch { return; }
          for (const record of records) {
            if (record.direction === 'broker' && record.target_node === node && ledger.active.has(record.receipt_id)) {
              try { finish(record, { state: 'outcome_unknown', code: 'BROKER_STREAM_LOST' }); } catch { ledger.active.delete(record.receipt_id); }
            }
          }
        });
        return;
      }
      if (req.method === 'POST' && injectMatch) {
        const [, source, target, encodedSid] = injectMatch;
        const sid = decodeURIComponent(encodedSid);
        const principal = authenticate(body, 'broker.inject', `${target}/${sid}`, body.expected_epoch);
        if (principal.id !== source || !own(config.nodes, source) || !own(config.nodes, target)) throw error('BROKER_NODE_DENIED', 403);
        const result = dispatch.inject(dispatch.plan(source, target, sid, body, principal));
        return json(res, result.status, result.body);
      }
      if (req.method === 'GET' && receiptMatch) {
        const [, source, key] = receiptMatch;
        if (authenticate(body, 'broker.receipt', source).id !== source) throw error('BROKER_NODE_DENIED', 403);
        const record = ledger.read(hash(`broker:${source}:${key}`));
        if (!record || record.source_node !== source) throw error('BROKER_RECEIPT_NOT_FOUND', 404);
        return json(res, 200, view(record));
      }
      if (req.method === 'POST' && resultMatch) {
        const [, node, key] = resultMatch;
        if (authenticate(body, 'broker.result', node).id !== node) throw error('BROKER_NODE_DENIED', 403);
        const record = ledger.read(key);
        if (!record || record.target_node !== node) throw error('BROKER_RECEIPT_NOT_FOUND', 404);
        if (!body || Object.keys(body).some(field => !['state', 'inject_id', 'queued', 'code'].includes(field))
          || !['accepted', 'failed', 'outcome_unknown'].includes(body.state)
          || (body.state === 'accepted' && (typeof body.inject_id !== 'string' || body.inject_id.length > 128 || !body.inject_id))
          || (body.code !== undefined && !/^[A-Z0-9_]{1,64}$/.test(body.code))) throw error('BROKER_RESULT_INVALID');
        const resultFingerprint = hash(canonicalJSON(body));
        if (record.result_fingerprint) {
          if (record.result_fingerprint !== resultFingerprint) throw error('IDEMPOTENCY_CONFLICT', 409);
          return json(res, 200, view(record));
        }
        const completed = finish(record, { state: body.state, result_fingerprint: resultFingerprint,
          ...(body.state === 'accepted' ? { remote_inject_id: body.inject_id, remote_queued: body.queued === true } : { code: body.code || 'BROKER_DESTINATION_UNKNOWN' }) });
        return json(res, 200, view(completed));
      }
      throw error('BROKER_ROUTE_NOT_FOUND', 404);
    } catch (reason) {
      requestAudit.code = reason.status ? reason.code : 'BROKER_STORAGE_UNAVAILABLE';
      if (!res.headersSent) return json(res, reason.status || 503, { success: false, code: reason.status ? reason.code : 'BROKER_STORAGE_UNAVAILABLE' });
      res.destroy();
    }
  }
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.maxHeadersCount = 32; server.maxConnections = 128;
  let closing;
  return { server, challenge: verifier.challenge, auditStats: () => auditLog.stats(),
    listen({ host = '127.0.0.1', port = 0 } = {}) {
      if (!tls && !['127.0.0.1', '::1'].includes(host)) throw error('BROKER_TLS_REQUIRED');
      return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(server.address())); });
    },
    close() {
      if (!closing) closing = (async () => {
        for (const stream of streams.values()) stream.response.end();
        for (const timer of timers.values()) clearTimeout(timer);
        await new Promise((resolve) => server.close(resolve));
        await auditLog.close();
      })();
      return closing;
    }
  };
}
module.exports = { ACTIONS, createBrokerHub };
