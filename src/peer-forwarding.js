'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const net = require('node:net');

const MAX_RECORDS = 512;
const MAX_PAYLOAD = 64 * 1024;
const MAX_RESPONSE = 16 * 1024;
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const text = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
function failure(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
function syncDir(dir) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// Persistent tombstones are deliberately never expired automatically: deleting an
// uncertain record would turn an old idempotency key into permission to send again.
function createForwardLedger(homeDir = os.homedir()) {
  const base = path.join(homeDir, '.telepty');
  const dir = path.join(base, 'forward-receipts');
  const active = new Set();
  function prepare() {
    for (const current of [base, dir]) {
      try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('FORWARD_STORAGE_UNAVAILABLE', 503);
    }
    fs.chmodSync(dir, 0o700);
  }
  function recordPath(key) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw failure('FORWARD_INVALID_REQUEST');
    return path.join(dir, `${key}.json`);
  }
  function read(key) {
    prepare();
    const file = recordPath(key);
    let fd;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) throw failure('FORWARD_STORAGE_UNAVAILABLE', 503);
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const bytes = Buffer.alloc(4097);
      const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
      if (size > 4096) throw failure('FORWARD_STORAGE_UNAVAILABLE', 503);
      const record = JSON.parse(bytes.subarray(0, size));
      if (record.receipt_id !== key || !/^[a-f0-9]{64}$/.test(record.fingerprint)
        || !['pending', 'accepted', 'failed', 'outcome_unknown'].includes(record.state)
        || !Number.isFinite(record.created_at)) throw failure('FORWARD_STORAGE_UNAVAILABLE', 503);
      return record;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  function all() {
    prepare();
    const names = fs.readdirSync(dir);
    if (names.length > MAX_RECORDS) throw failure('FORWARD_CAPACITY', 503);
    if (names.some((name) => !/^[a-f0-9]{64}\.json$/.test(name))) throw failure('FORWARD_STORAGE_UNAVAILABLE', 503);
    return names.map((name) => read(name.slice(0, -5)));
  }
  function write(record, first = false) {
    prepare();
    const bytes = JSON.stringify(record);
    if (Buffer.byteLength(bytes) > 4096) throw failure('FORWARD_STORAGE_UNAVAILABLE', 503);
    const target = recordPath(record.receipt_id);
    const temporary = first ? target : `${target}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      if (!first) fs.renameSync(temporary, target);
      syncDir(dir); syncDir(base); syncDir(homeDir);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (!first) { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    }
    return record;
  }
  function reserve(key, fingerprint, metadata) {
    const existing = read(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw failure('IDEMPOTENCY_CONFLICT', 409);
      return { record: existing, fresh: false };
    }
    if (all().length >= MAX_RECORDS) throw failure('FORWARD_CAPACITY', 503);
    const record = { receipt_id: key, fingerprint, created_at: Date.now(), state: 'pending', ...metadata };
    write(record, true);
    return { record, fresh: true };
  }
  function view(record) {
    const result = {};
    for (const field of ['receipt_id', 'fingerprint', 'created_at', 'direction', 'peer', 'session', 'expected_epoch',
      'remote_status', 'code', 'remote_inject_id', 'remote_queued', 'remote_receipt']) {
      if (own(record, field)) result[field] = record[field];
    }
    return { ...result, state: record.state === 'pending' && !active.has(record.receipt_id) ? 'outcome_unknown' : record.state,
      verified_foreign_identity: false };
  }
  return { read, all, write, reserve, view, active };
}

function canonicalEndpoint(peer) {
  if (!peer || peer.transport !== 'http' || !text(peer.host, 253) || !Number.isInteger(peer.port) || peer.port < 1 || peer.port > 65535
    || !text(peer.token, 4096)) throw failure('PEER_UNAVAILABLE', 403);
  const host = peer.host.startsWith('[') && peer.host.endsWith(']') ? peer.host.slice(1, -1) : peer.host;
  if (!net.isIP(host) && !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host)) throw failure('PEER_UNAVAILABLE', 403);
  const origin = `http://${net.isIP(host) === 6 ? `[${host}]` : host}:${peer.port}`;
  return new URL(origin).origin;
}
function validateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => !['prompt', 'no_enter', 'expected_epoch', 'idempotency_key', 'from', 'reply_to'].includes(key))
    || typeof body.prompt !== 'string' || Buffer.byteLength(body.prompt) > MAX_PAYLOAD
    || !text(body.expected_epoch, 128) || !/^[a-zA-Z0-9_-]{16,128}$/.test(body.idempotency_key || '')
    || (body.no_enter !== undefined && typeof body.no_enter !== 'boolean')
    || (body.from !== undefined && !text(body.from)) || (body.reply_to !== undefined && !text(body.reply_to))) throw failure('FORWARD_INVALID_REQUEST');
  return { prompt: body.prompt, no_enter: body.no_enter === true, expected_epoch: body.expected_epoch,
    ...(body.from ? { from: body.from } : {}), ...(body.reply_to ? { reply_to: body.reply_to } : {}) };
}
function grantFor(peer, sid, payloadBytes) {
  const grant = peer && peer.forwarding;
  if (!grant || grant.enabled !== true || !Array.isArray(grant.operations) || !grant.operations.includes('inject')
    || !Array.isArray(grant.sessions) || !grant.sessions.includes(sid) || grant.hop_limit !== 1
    || !Number.isInteger(grant.max_payload_bytes) || grant.max_payload_bytes < 1 || grant.max_payload_bytes > MAX_PAYLOAD
    || payloadBytes > grant.max_payload_bytes
    || !Number.isInteger(grant.max_requests) || grant.max_requests < 1 || grant.max_requests > 100
    || !Number.isInteger(grant.window_ms) || grant.window_ms < 1000 || grant.window_ms > 86400000
    || !Number.isInteger(grant.timeout_ms) || grant.timeout_ms < 100 || grant.timeout_ms > 10000) throw failure('FORWARD_DENIED', 403);
  return grant;
}
async function boundedJson(response) {
  if (!response.body) throw failure('PEER_INVALID_RECEIPT', 502);
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE) throw failure('PEER_INVALID_RECEIPT', 502);
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}
function receiptResponse(record) {
  return { ...record, success: record.state === 'accepted', verified_foreign_identity: false,
    ...(record.remote_inject_id ? { inject_id: record.remote_inject_id } : {}),
    routing_receipt: { peer: record.peer, session: record.session,
      remote_inject_id: record.remote_inject_id || null, verified_foreign_identity: false } };
}

function registerPeerForwardRoutes(app, { sessions, loadPeers, homeDir = os.homedir(), fetch: fetchPeer = globalThis.fetch } = {}) {
  const ledger = createForwardLedger(homeDir);
  function sendError(res, error) { return res.status(error.status || 503).json({ success: false, code: error.code && error.status ? error.code : 'FORWARD_STORAGE_UNAVAILABLE' }); }
  app.get('/api/peers/forward-receipts/:key', (req, res) => {
    try {
      if (!/^[a-zA-Z0-9_-]{16,128}$/.test(req.params.key)) throw failure('FORWARD_INVALID_REQUEST');
      const record = ledger.read(hash(`outbound:${req.params.key}`));
      if (!record || record.direction !== 'outbound') throw failure('RECEIPT_NOT_FOUND', 404);
      return res.json(receiptResponse(ledger.view(record)));
    } catch (error) { return sendError(res, error); }
  });
  app.post('/api/peers/:peer/sessions/:sid/inject', async (req, res) => {
    let pending;
    try {
      if (!text(req.params.peer, 128) || !text(req.params.sid, 256)) throw failure('FORWARD_INVALID_REQUEST');
      const body = validateBody(req.body);
      const peers = loadPeers().peers || {};
      if (!own(peers, req.params.peer)) throw failure('PEER_UNKNOWN', 404);
      const peer = peers[req.params.peer];
      const grant = grantFor(peer, req.params.sid, Buffer.byteLength(body.prompt));
      const origin = canonicalEndpoint(peer);
      const key = hash(`outbound:${req.body.idempotency_key}`);
      const fingerprint = hash(JSON.stringify({ peer: req.params.peer, endpoint: origin, sid: req.params.sid, body }));
      const existing = ledger.read(key);
      if (!existing && ledger.all().filter((item) => item.direction === 'outbound' && item.peer === req.params.peer
        && item.created_at >= Date.now() - grant.window_ms).length >= grant.max_requests) throw failure('FORWARD_BUDGET_EXCEEDED', 429);
      const reserved = ledger.reserve(key, fingerprint, { direction: 'outbound', peer: req.params.peer,
        session: req.params.sid, expected_epoch: body.expected_epoch });
      if (!reserved.fresh) {
        const record = ledger.view(reserved.record);
        return res.status(['pending', 'outcome_unknown'].includes(record.state) ? 202 : record.remote_status || 200).json(receiptResponse(record));
      }
      pending = reserved.record;
      ledger.active.add(key);
      let record;
      try {
        const response = await fetchPeer(`${origin}/api/forwarded/sessions/${encodeURIComponent(req.params.sid)}/inject`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(grant.timeout_ms),
          headers: { 'content-type': 'application/json', 'x-telepty-token': peer.token },
          body: JSON.stringify({ ...body, exact_target: true, claimed_cross_host: true, forwarding: { hop: 1, key } })
        });
        const remote = await boundedJson(response);
        if (response.ok && (remote.success !== true || !text(remote.inject_id, 128)
          || remote.session_id !== req.params.sid || remote.exact_target !== true)) throw failure('PEER_INVALID_RECEIPT', 502);
        const code = response.status === 404 ? 'SESSION_NOT_FOUND'
          : response.status === 409 && remote.code === 'TARGET_EPOCH_MISMATCH' ? 'TARGET_EPOCH_MISMATCH'
          : response.status === 401 || response.status === 403 ? 'PEER_AUTH_REFUSED' : 'REMOTE_REFUSED';
        record = { ...pending, state: response.status >= 500 ? 'outcome_unknown' : response.ok ? 'accepted' : 'failed', remote_status: response.status,
          ...(response.ok ? { remote_inject_id: remote.inject_id,
            remote_queued: remote.queued === true || remote.bootstrap_queued === true } : { code }) };
      } catch (error) {
        record = error.cause && error.cause.code === 'ECONNREFUSED'
          ? { ...pending, state: 'failed', remote_status: 503, code: 'PEER_OFFLINE' }
          : { ...pending, state: 'outcome_unknown', code: 'PEER_OUTCOME_UNKNOWN' };
      }
      try { ledger.write(record); }
      catch { return res.status(202).json(receiptResponse({ ...pending, state: 'outcome_unknown', code: 'FORWARD_STORAGE_UNAVAILABLE' })); }
      return res.status(record.state === 'outcome_unknown' ? 202 : record.remote_status).json(receiptResponse(ledger.view(record)));
    } catch (error) { return sendError(res, error); }
    finally { if (pending) ledger.active.delete(pending.receipt_id); }
  });

  // Exact-local destination ingress. This never performs another forwarding hop.
  app.post('/api/forwarded/sessions/:id/inject', (req, res, next) => {
    try {
      if (!req.body || !own(req.body, 'forwarding')) throw failure('FORWARD_INVALID_REQUEST');
      const forward = req.body.forwarding;
      if (!forward || forward.hop !== 1 || !/^[a-f0-9]{64}$/.test(forward.key || '')
        || Object.keys(forward).some((key) => !['hop', 'key'].includes(key))
        || req.body.exact_target !== true || !text(req.body.expected_epoch, 128)
        || typeof req.body.prompt !== 'string' || Buffer.byteLength(req.body.prompt) > MAX_PAYLOAD) throw failure('FORWARD_INVALID_REQUEST');
      const session = own(sessions, req.params.id) ? sessions[req.params.id] : null;
      if (!session) throw failure('SESSION_NOT_FOUND', 404);
      if (!session.sessionEpoch || session.sessionEpoch !== req.body.expected_epoch) throw failure('TARGET_EPOCH_MISMATCH', 409);
      const key = hash(`inbound:${forward.key}`);
      const fingerprint = hash(JSON.stringify({ session: req.params.id, expected_epoch: req.body.expected_epoch,
        prompt: req.body.prompt, no_enter: req.body.no_enter === true, from: req.body.from || null,
        reply_to: req.body.reply_to || null, key: forward.key }));
      const reserved = ledger.reserve(key, fingerprint, { direction: 'inbound', session: req.params.id,
        expected_epoch: req.body.expected_epoch });
      if (!reserved.fresh) {
        const record = ledger.view(reserved.record);
        return res.status(record.remote_status || 202).json(record.remote_receipt || { success: false, code: 'FORWARD_OUTCOME_UNKNOWN' });
      }
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        const safe = {};
        for (const field of ['success', 'inject_id', 'session_id', 'exact_target', 'queued', 'bootstrap_queued', 'delivered', 'code', 'delivery_uncertain', 'retryable']) {
          if (['string', 'boolean', 'number'].includes(typeof body[field])) safe[field] = body[field];
        }
        if (body.bytes_written === null || (Number.isFinite(body.bytes_written) && body.bytes_written >= 0)) {
          safe.bytes_written = body.bytes_written;
        }
        if (body.submit === 'skipped') safe.submit = 'skipped';
        const uncertain = body.delivery_uncertain === true || body.code === 'DELIVERY_UNCERTAIN' || res.statusCode >= 500;
        try { ledger.write({ ...reserved.record, state: uncertain ? 'outcome_unknown' : body.success === true ? 'accepted' : 'failed',
          remote_status: res.statusCode, remote_receipt: safe }); }
        catch { res.status(503); return originalJson({ success: false, code: 'FORWARD_STORAGE_UNAVAILABLE' }); }
        return originalJson(body);
      };
      return next();
    } catch (error) { return sendError(res, error); }
  });
}

module.exports = { createForwardLedger, registerPeerForwardRoutes, validateForwardBody: validateBody };
