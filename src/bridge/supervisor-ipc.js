'use strict';

// Node↔Rust supervisor bridge — NDJSON over a per-session UDS.
//
// Wire schema mirror: crates/telepty-supervisor-core/src/wire.rs (v=1).
// Per synthesis ADR §6.2 (B3): inject/output/signal/kill/delete frames MUST
// carry a non-empty trace_id; the supervisor rejects with ERR_BAD_FRAME
// otherwise. This client auto-fills trace_id for those kinds if the caller
// omits it. Pong reflects trace_id back so request() correlates by trace_id.
//
// Stdlib only (Constitution §17). NDJSON parsing via readline.

const net = require('node:net');
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');

const WIRE_VERSION = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 3000;
const DEFAULT_CONNECT_TIMEOUT_MS = 1500;
const KINDS_REQUIRING_TRACE_ID = new Set(['inject', 'output', 'signal', 'kill', 'delete']);
const CORRELATED_RESPONSE_KINDS = new Set(['pong', 'error']);

class BridgeClientError extends Error {
  constructor(code, message, frame = null) {
    super(message);
    this.code = code;
    this.frame = frame;
    this.name = 'BridgeClientError';
  }
}

class BridgeClient {
  constructor(socket) {
    this._socket = socket;
    this._pending = new Map();
    this._subscribers = new Set();
    this._closed = false;
    this._closePromise = null;

    const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });
    rl.on('line', (line) => this._handleLine(line));
    socket.once('close', () => this._handleClose(null));
    socket.once('error', (err) => this._handleError(err));
    this._rl = rl;
  }

  /** @returns {boolean} */
  isClosed() {
    return this._closed;
  }

  /**
   * Send a frame without awaiting a correlated reply. Resolves once the bytes
   * are flushed to the OS write buffer. Auto-fills wire version and trace_id
   * for kinds where the supervisor mandates trace_id (B3).
   * @param {object} frame
   * @returns {Promise<{trace_id: ?string}>}
   */
  send(frame) {
    if (this._closed) {
      return Promise.reject(new BridgeClientError('ERR_SUPERVISOR_GONE', 'client closed'));
    }
    const out = this._prepareFrame(frame);
    const line = JSON.stringify(out) + '\n';
    return new Promise((resolve, reject) => {
      this._socket.write(line, (err) => {
        if (err) reject(new BridgeClientError('ERR_NOT_REACHABLE', err.message));
        else resolve({ trace_id: out.trace_id || null });
      });
    });
  }

  /**
   * Send a frame and await a correlated response (pong | error) carrying the
   * same trace_id. Rejects with ERR_TIMEOUT on drift beyond `timeoutMs`. Error
   * frames reject with the supervisor's ERR_* code preserved.
   * @param {object} frame
   * @param {{timeoutMs?: number}} [options]
   * @returns {Promise<object>}
   */
  request(frame, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    if (this._closed) {
      return Promise.reject(new BridgeClientError('ERR_SUPERVISOR_GONE', 'client closed'));
    }
    const out = this._prepareFrame(frame);
    if (!out.trace_id) {
      out.trace_id = randomUUID();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending.delete(out.trace_id)) {
          reject(new BridgeClientError(
            'ERR_TIMEOUT',
            `no response within ${timeoutMs}ms (trace_id=${out.trace_id})`,
          ));
        }
      }, timeoutMs);
      this._pending.set(out.trace_id, { resolve, reject, timer });
      const line = JSON.stringify(out) + '\n';
      this._socket.write(line, (err) => {
        if (err && this._pending.delete(out.trace_id)) {
          clearTimeout(timer);
          reject(new BridgeClientError('ERR_NOT_REACHABLE', err.message));
        }
      });
    });
  }

  /**
   * Subscribe to incoming frames. Returns an AsyncIterator yielding every
   * frame the supervisor emits (output broadcast, shutdown_drain, error,
   * pong) optionally filtered by `sid`. Frames lacking a sid (error, pong)
   * always pass through so callers can observe rejections.
   *
   * Cancellation: pass an AbortSignal, call `iterator.return()`, or `break`
   * the for-await loop — all cleanly remove the subscription.
   *
   * @param {{sid?: string|null, signal?: AbortSignal|null}} [options]
   */
  subscribe({ sid = null, signal = null } = {}) {
    const queue = [];
    const waiters = [];
    let ended = false;

    const sub = {
      push: (frame) => {
        if (ended) return;
        if (sid && frame.sid != null && frame.sid !== sid) return;
        const waiter = waiters.shift();
        if (waiter) {
          waiter({ value: frame, done: false });
        } else {
          queue.push(frame);
        }
      },
      end: () => {
        if (ended) return;
        ended = true;
        while (waiters.length > 0) {
          waiters.shift()({ value: undefined, done: true });
        }
      },
    };

    this._subscribers.add(sub);

    const cleanup = () => {
      this._subscribers.delete(sub);
      sub.end();
    };

    if (signal) {
      if (signal.aborted) {
        cleanup();
      } else {
        const onAbort = () => cleanup();
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    const iter = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        if (queue.length > 0) {
          return Promise.resolve({ value: queue.shift(), done: false });
        }
        if (ended) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          waiters.push(resolve);
        });
      },
      return() {
        cleanup();
        return Promise.resolve({ value: undefined, done: true });
      },
      throw(err) {
        cleanup();
        return Promise.reject(err);
      },
    };
    return iter;
  }

  /**
   * Close the socket and reject any pending requests with ERR_SUPERVISOR_GONE.
   * Idempotent.
   * @returns {Promise<void>}
   */
  close() {
    if (this._closePromise) return this._closePromise;
    this._closePromise = new Promise((resolve) => {
      if (this._closed) {
        resolve();
        return;
      }
      const finalize = () => {
        resolve();
      };
      this._socket.once('close', finalize);
      try {
        this._socket.end();
      } catch {
        // already destroyed
      }
      const grace = setTimeout(() => {
        if (!this._closed) {
          try { this._socket.destroy(); } catch {}
        }
      }, 200);
      grace.unref();
    });
    return this._closePromise;
  }

  _handleLine(line) {
    if (!line) return;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      // Protocol violation on incoming line — surface as a synthetic error to
      // subscribers; do not tear down the connection (supervisor may still
      // emit valid frames after malformed garbage in a misbehaving client).
      const err = {
        v: WIRE_VERSION,
        kind: 'error',
        code: 'ERR_BAD_FRAME',
        data: 'client_parse_error',
      };
      for (const sub of this._subscribers) sub.push(err);
      return;
    }
    if (!frame || typeof frame !== 'object' || typeof frame.kind !== 'string') return;

    if (frame.trace_id && CORRELATED_RESPONSE_KINDS.has(frame.kind) && this._pending.has(frame.trace_id)) {
      const pending = this._pending.get(frame.trace_id);
      this._pending.delete(frame.trace_id);
      clearTimeout(pending.timer);
      if (frame.kind === 'error') {
        pending.reject(new BridgeClientError(
          frame.code || 'ERR_BAD_FRAME',
          frame.data || 'supervisor error',
          frame,
        ));
      } else {
        pending.resolve(frame);
      }
    }

    for (const sub of this._subscribers) sub.push(frame);
  }

  _handleClose(_err) {
    if (this._closed) return;
    this._closed = true;
    const goneErr = new BridgeClientError('ERR_SUPERVISOR_GONE', 'supervisor socket closed');
    for (const [, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.reject(goneErr);
    }
    this._pending.clear();
    for (const sub of this._subscribers) sub.end();
    this._subscribers.clear();
    this._rl.close();
  }

  _handleError(_err) {
    if (!this._closed) {
      try { this._socket.destroy(); } catch {}
    }
  }

  _prepareFrame(frame) {
    const out = { v: WIRE_VERSION, ...frame };
    if (KINDS_REQUIRING_TRACE_ID.has(out.kind) && !out.trace_id) {
      out.trace_id = randomUUID();
    }
    return out;
  }
}

/**
 * Connect to the per-session supervisor UDS socket.
 * @param {string} socketPath
 * @param {{connectTimeoutMs?: number}} [options]
 * @returns {Promise<BridgeClient>}
 */
function connect(socketPath, { connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof socketPath !== 'string' || socketPath.length === 0) {
      reject(new BridgeClientError('ERR_BAD_FRAME', 'socketPath required'));
      return;
    }
    const socket = net.createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new BridgeClientError(
        'ERR_NOT_REACHABLE',
        `connect timeout ${connectTimeoutMs}ms (${socketPath})`,
      ));
    }, connectTimeoutMs);

    const onConnect = () => {
      clearTimeout(timer);
      socket.removeListener('error', onError);
      resolve(new BridgeClient(socket));
    };
    const onError = (err) => {
      clearTimeout(timer);
      socket.removeListener('connect', onConnect);
      try { socket.destroy(); } catch {}
      reject(new BridgeClientError('ERR_NOT_REACHABLE', err.message));
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

module.exports = {
  connect,
  BridgeClient,
  BridgeClientError,
  WIRE_VERSION,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_CONNECT_TIMEOUT_MS,
};
