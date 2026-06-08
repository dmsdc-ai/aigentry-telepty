'use strict';

const crypto = require('node:crypto');
const https = require('node:https');
const net = require('node:net');

const {
  buildAck,
  buildInjectEnvelope,
  createMessageIdDeduper,
  parseInjectEnvelope,
  parseSseFrame,
} = require('./broker-protocol');

function createBrokerClient(options) {
  return new BrokerClient(options);
}

class BrokerClient {
  constructor(options = {}) {
    this.url = new URL(requireString(options.url, 'url'));
    if (this.url.protocol !== 'https:') {
      throw new Error('Broker URL must use https');
    }

    this.node = requireString(options.node || options.nodeName, 'node');
    this.nodeJwt = requireString(options.nodeJwt || options.jwt, 'nodeJwt');
    this.pin = normalizePin(options.pin || null);
    this.deliver = requireFunction(options.deliver, 'deliver');
    this.getSession = typeof options.getSession === 'function'
      ? options.getSession
      : createSessionGetter(options.sessions);
    this.getSessions = typeof options.getSessions === 'function'
      ? options.getSessions
      : createSessionsGetter(options.sessions);
    this.acceptFrom = options.acceptFrom === undefined ? options.accept_from : options.acceptFrom;

    this.heartbeatMs = numberOr(options.heartbeatMs, 23000);
    this.reconnect = options.reconnect !== false;
    this.reconnectInitialMs = numberOr(options.reconnectInitialMs, 500);
    this.reconnectMaxMs = numberOr(options.reconnectMaxMs, 10000);
    this.reconnectJitterMs = numberOr(options.reconnectJitterMs, 250);
    this.requestTimeoutMs = numberOr(options.requestTimeoutMs, 10000);
    this.random = typeof options.random === 'function' ? options.random : Math.random;
    this.agent = options.agent || new https.Agent({ keepAlive: false, maxCachedSessions: 0 });

    this.lastEventId = options.lastEventId === undefined || options.lastEventId === null
      ? null
      : String(options.lastEventId);
    this.deduper = options.deduper || createMessageIdDeduper(options.deduperOptions);
    this.processing = Promise.resolve();
    this.started = false;
    this.stopped = true;
    this.currentRequest = null;
    this.currentStream = null;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.reconnectDelayMs = this.reconnectInitialMs;
    this.lastError = null;
  }

  async start() {
    if (this.started) return this;
    this.started = true;
    this.stopped = false;
    this.startHeartbeat();

    try {
      await this.connectStream();
      this.reconnectDelayMs = this.reconnectInitialMs;
      return this;
    } catch (error) {
      this.lastError = error;
      this.scheduleReconnect();
      throw error;
    }
  }

  stop() {
    this.started = false;
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    if (this.currentRequest) this.currentRequest.destroy();
    if (this.currentStream) this.currentStream.destroy();
    this.currentRequest = null;
    this.currentStream = null;
    return this;
  }

  async inject(input) {
    const envelope = buildInjectEnvelope(input);
    const response = await this.postJson('/broker/inject', envelope);
    return response.body;
  }

  async register() {
    return this.postJson('/broker/register', {
      node: this.node,
      sessions: normalizeSessions(this.getSessions()),
      last_event_id: this.lastEventId,
    });
  }

  async heartbeat() {
    return this.postJson('/broker/heartbeat', {
      node: this.node,
      sessions: normalizeSessions(this.getSessions()),
      last_event_id: this.lastEventId,
    });
  }

  startHeartbeat() {
    if (!this.heartbeatMs || this.heartbeatMs < 1) return;
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.heartbeat();
      } catch (error) {
        this.lastError = error;
      }
      this.startHeartbeat();
    };
    this.heartbeatTimer = setTimeout(tick, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  async connectStream() {
    await this.register();
    if (this.stopped) return;

    return new Promise((resolve, reject) => {
      let settled = false;
      let disconnected = false;
      let buffer = '';
      const headers = this.authHeaders({ accept: 'text/event-stream' });
      if (this.lastEventId !== null) {
        headers['last-event-id'] = this.lastEventId;
      }
      const req = this.createRequest('GET', '/broker/stream', headers, (res) => {
        if (res.statusCode !== 200) {
          collectResponse(res).then((body) => {
            rejectOnce(httpError('Broker stream failed', res.statusCode, body));
          }, rejectOnce);
          return;
        }

        this.currentStream = res;
        resolveOnce();
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          buffer = this.consumeSseBuffer(buffer);
        });
        res.on('end', () => disconnectOnce());
        res.on('close', () => disconnectOnce());
      });

      this.currentRequest = req;
      req.on('error', (error) => {
        if (settled) {
          disconnectOnce(error);
        } else {
          rejectOnce(error);
        }
      });
      req.end();

      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const rejectOnce = (error) => {
        if (settled) return;
        settled = true;
        this.currentRequest = null;
        reject(error);
      };
      const disconnectOnce = (error) => {
        if (disconnected || this.stopped) return;
        disconnected = true;
        this.currentRequest = null;
        this.currentStream = null;
        if (error) this.lastError = error;
        this.scheduleReconnect();
      };
    });
  }

  consumeSseBuffer(buffer) {
    let remaining = buffer;
    for (;;) {
      const boundary = findFrameBoundary(remaining);
      if (!boundary) return remaining;
      const rawFrame = remaining.slice(0, boundary.index);
      remaining = remaining.slice(boundary.index + boundary.length);
      if (!rawFrame.trim()) continue;
      const frame = parseSseFrame(rawFrame);
      if (frame.id !== null && frame.id !== undefined && frame.id !== '') {
        this.lastEventId = String(frame.id);
      }
      this.enqueueFrame(frame);
    }
  }

  enqueueFrame(frame) {
    this.processing = this.processing
      .then(() => this.handleFrame(frame))
      .catch((error) => {
        this.lastError = error;
      });
    return this.processing;
  }

  async handleFrame(frame) {
    if (frame.event !== 'inject') return;
    const envelope = parseInjectEnvelope(frame.data);
    await this.handleInjectEnvelope(envelope);
  }

  async handleInjectEnvelope(envelope) {
    if (!this.deduper.accept(envelope)) {
      await this.ack({ inject_id: envelope.inject_id, success: true });
      return;
    }

    if (!acceptsFrom(this.acceptFrom, envelope.from_node, envelope)) {
      await this.ack({
        inject_id: envelope.inject_id,
        success: false,
        code: 'ACCEPT_FROM_DENIED',
        error: `Broker inject from ${envelope.from_node} denied by accept_from`,
      });
      return;
    }

    const session = this.getSession(envelope.to_session, envelope);
    if (!session) {
      await this.ack({
        inject_id: envelope.inject_id,
        success: false,
        code: 'SESSION_NOT_FOUND',
        error: `Session not found: ${envelope.to_session}`,
      });
      return;
    }

    const payload = envelope.payload || {};
    if (typeof payload.prompt !== 'string') {
      await this.ack({
        inject_id: envelope.inject_id,
        success: false,
        code: 'INVALID_REQUEST',
        error: 'prompt is required',
      });
      return;
    }

    const delivery = await this.callDeliver(envelope, session, payload);
    await this.ack({
      inject_id: envelope.inject_id,
      success: delivery.success === true,
      code: delivery.success === true ? null : delivery.code || 'DELIVERY_FAILED',
      error: delivery.success === true ? null : delivery.error || 'Broker inject delivery failed',
    });
  }

  async callDeliver(envelope, session, payload) {
    const options = {
      noEnter: payload.no_enter === true,
      source: 'broker',
      from: payload.from || envelope.from_node || 'broker',
    };
    if (payload.reply_to) options.replyTo = payload.reply_to;

    try {
      return await this.deliver(envelope.to_session, session, payload.prompt, options);
    } catch (error) {
      return {
        success: false,
        code: 'DELIVERY_ERROR',
        error: error && error.message ? error.message : String(error),
      };
    }
  }

  async ack(input) {
    try {
      await this.postJson('/broker/ack', buildAck(input));
    } catch (error) {
      this.lastError = error;
    }
  }

  scheduleReconnect() {
    if (this.stopped || !this.reconnect || this.reconnectTimer) return;
    const delay = this.nextReconnectDelay();
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      try {
        await this.connectStream();
        this.reconnectDelayMs = this.reconnectInitialMs;
      } catch (error) {
        this.lastError = error;
        this.scheduleReconnect();
      }
    }, delay);
    this.reconnectTimer.unref?.();
  }

  nextReconnectDelay() {
    const jitter = this.reconnectJitterMs > 0 ? Math.floor(this.random() * this.reconnectJitterMs) : 0;
    const delay = Math.min(this.reconnectDelayMs, this.reconnectMaxMs) + jitter;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.reconnectMaxMs);
    return delay;
  }

  async postJson(path, body) {
    const payload = JSON.stringify(body || {});
    const headers = this.authHeaders({
      accept: 'application/json',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    });

    return new Promise((resolve, reject) => {
      const req = this.createRequest('POST', path, headers, (res) => {
        collectResponse(res).then((rawBody) => {
          const parsedBody = parseJsonBody(rawBody);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(httpError('Broker request failed', res.statusCode, parsedBody));
            return;
          }
          resolve({ statusCode: res.statusCode, headers: res.headers, body: parsedBody });
        }, reject);
      });
      req.setTimeout(this.requestTimeoutMs, () => {
        req.destroy(new Error('Broker request timed out'));
      });
      req.on('error', reject);
      req.end(payload);
    });
  }

  createRequest(method, path, headers, onResponse) {
    const requestUrl = new URL(path, this.url);
    const req = https.request({
      protocol: requestUrl.protocol,
      hostname: requestUrl.hostname,
      port: requestUrl.port,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      method,
      headers,
      servername: net.isIP(requestUrl.hostname) ? undefined : requestUrl.hostname,
      rejectUnauthorized: this.pin ? false : true,
      agent: this.agent,
    }, onResponse);

    if (this.pin) {
      req.on('socket', (socket) => {
        socket.once('secureConnect', () => {
          const cert = socket.getPeerCertificate(true);
          const actualPin = certificateFingerprint(cert);
          if (actualPin !== this.pin) {
            req.destroy(new Error('TLS pin mismatch'));
          }
        });
      });
    }

    return req;
  }

  authHeaders(extra = {}) {
    return {
      ...extra,
      authorization: `Bearer ${this.nodeJwt}`,
    };
  }
}

function createSessionGetter(sessions) {
  return (id) => {
    if (!sessions) return null;
    if (sessions instanceof Map) return sessions.get(id) || null;
    return sessions[id] || null;
  };
}

function createSessionsGetter(sessions) {
  return () => sessions || [];
}

function normalizeSessions(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (value instanceof Map) return [...value.values()];
  if (typeof value === 'object') return Object.values(value);
  return [];
}

function acceptsFrom(acceptFrom, fromNode, envelope) {
  if (acceptFrom === null || acceptFrom === undefined) return true;
  if (typeof acceptFrom === 'function') return acceptFrom(fromNode, envelope) === true;
  if (Array.isArray(acceptFrom) || acceptFrom instanceof Set) {
    return listHas(acceptFrom, fromNode);
  }
  if (typeof acceptFrom !== 'object') return true;

  const deny = acceptFrom.deny || acceptFrom.deny_list || acceptFrom.denylist;
  if (deny && listHas(deny, fromNode)) return false;
  const allow = acceptFrom.allow || acceptFrom.allow_list || acceptFrom.allowlist;
  if (allow) return listHas(allow, fromNode);
  return true;
}

function listHas(list, value) {
  if (list instanceof Set) return list.has(value) || list.has('*');
  if (!Array.isArray(list)) return false;
  return list.includes(value) || list.includes('*');
}

function findFrameBoundary(buffer) {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return null;
  if (lf !== -1 && (crlf === -1 || lf < crlf)) return { index: lf, length: 2 };
  return { index: crlf, length: 4 };
}

function collectResponse(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

function parseJsonBody(rawBody) {
  if (!rawBody) return null;
  try {
    return JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
}

function normalizePin(pin) {
  if (!pin) return null;
  let value = String(pin).trim().toLowerCase();
  if (value.startsWith('sha256:')) value = value.slice('sha256:'.length);
  value = value.replace(/:/g, '');
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('Invalid broker TLS pin');
  }
  return value;
}

function certificateFingerprint(cert) {
  if (!cert) return false;
  return cert.fingerprint256
    ? cert.fingerprint256.toLowerCase().replace(/:/g, '')
    : cert.raw && crypto.createHash('sha256').update(cert.raw).digest('hex');
}

function httpError(message, statusCode, body) {
  const error = new Error(`${message}: ${statusCode}`);
  error.statusCode = statusCode;
  error.body = body;
  return error;
}

function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function requireFunction(value, name) {
  if (typeof value !== 'function') {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

module.exports = {
  createBrokerClient,
};
