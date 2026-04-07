'use strict';

const net = require('net');

/**
 * UnixSocketNotifier — sends lightweight "wake" signals to aterm sessions
 * after mailbox enqueue, so they poll immediately instead of waiting for
 * their next delivery engine tick.
 *
 * Uses coalescing: multiple enqueues within `coalesceMs` result in a single notification.
 */
class UnixSocketNotifier {
  constructor(options = {}) {
    this.coalesceMs = options.coalesceMs || 25;
    this._pending = new Map(); // sessionId → timer
    this._socketResolver = options.socketResolver || null; // (sessionId) => socketPath | null
  }

  /**
   * Set the function that resolves a session ID to its UDS path.
   * Called by daemon after sessions are available.
   */
  setSocketResolver(fn) {
    this._socketResolver = fn;
  }

  /**
   * Schedule a wake notification for a session.
   * Coalesces multiple calls within coalesceMs into a single send.
   */
  notify(sessionId) {
    if (this._pending.has(sessionId)) return; // already scheduled

    const timer = setTimeout(() => {
      this._pending.delete(sessionId);
      this._sendWake(sessionId);
    }, this.coalesceMs);

    // Allow process to exit even if timer is pending
    if (timer.unref) timer.unref();
    this._pending.set(sessionId, timer);
  }

  /**
   * Send wake signal immediately (bypass coalesce).
   */
  notifyImmediate(sessionId) {
    const existing = this._pending.get(sessionId);
    if (existing) {
      clearTimeout(existing);
      this._pending.delete(sessionId);
    }
    this._sendWake(sessionId);
  }

  /**
   * Cancel pending notification for a session.
   */
  cancel(sessionId) {
    const timer = this._pending.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this._pending.delete(sessionId);
    }
  }

  /**
   * Cancel all pending notifications.
   */
  cancelAll() {
    for (const timer of this._pending.values()) {
      clearTimeout(timer);
    }
    this._pending.clear();
  }

  _sendWake(sessionId) {
    if (!this._socketResolver) return;

    const socketPath = this._socketResolver(sessionId);
    if (!socketPath) return;

    const payload = JSON.stringify({ action: 'MailboxWake', workspace: sessionId }) + '\n';

    const sock = net.connect(socketPath, () => {
      sock.end(payload);
    });

    sock.on('error', () => {
      // Socket unreachable — aterm may be down. Delivery engine will retry via polling.
    });

    // Prevent socket from keeping process alive
    sock.unref();

    // Timeout safety
    const timeout = setTimeout(() => sock.destroy(), 2000);
    if (timeout.unref) timeout.unref();
    sock.on('close', () => clearTimeout(timeout));
  }
}

module.exports = { UnixSocketNotifier };
