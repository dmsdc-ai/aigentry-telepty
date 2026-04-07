'use strict';

/**
 * DeliveryEngine — polls mailbox for pending messages and delivers them.
 *
 * For each registered session, dequeues messages and calls the deliverFn callback.
 * On success: ack. On failure: nack (retry with backoff, then dead-letter).
 *
 * Also handles:
 * - In-flight timeout recovery (auto-nack stuck messages)
 * - TTL expiry (expire stale pending messages)
 */
class DeliveryEngine {
  /**
   * @param {FileMailbox} mailbox
   * @param {Object} options
   * @param {Function} options.deliverFn - async (sessionId, message) => { success: boolean, error?: string }
   * @param {Function} options.sessionResolver - () => string[] (list of active session IDs)
   * @param {number} options.pollMs - polling interval (default: 200ms)
   * @param {Function} options.onDelivery - optional callback (sessionId, msgId, result)
   */
  constructor(mailbox, options = {}) {
    this.mailbox = mailbox;
    this.deliverFn = options.deliverFn;
    this.sessionResolver = options.sessionResolver || (() => this.mailbox.listSessions());
    this.pollMs = options.pollMs || mailbox.config.deliveryPollMs || 200;
    this.onDelivery = options.onDelivery || null;
    this._timer = null;
    this._running = false;
    this._tickInProgress = false;
  }

  /**
   * Start the delivery engine polling loop.
   */
  start() {
    if (this._running) return;
    this._running = true;
    this._timer = setInterval(() => this._tick(), this.pollMs);
    if (this._timer.unref) this._timer.unref();
    console.log(`[MAILBOX] DeliveryEngine started (poll: ${this.pollMs}ms)`);
  }

  /**
   * Stop the delivery engine.
   */
  stop() {
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    console.log('[MAILBOX] DeliveryEngine stopped');
  }

  /**
   * Force a single delivery tick (for testing or immediate delivery after enqueue).
   */
  async tick() {
    return this._tick();
  }

  async _tick() {
    if (this._tickInProgress) return;
    this._tickInProgress = true;

    try {
      const sessionIds = this.sessionResolver();

      for (const sessionId of sessionIds) {
        // 1. Recover in-flight timeouts
        try {
          const recovered = this.mailbox.recoverInflight(sessionId);
          if (recovered > 0) {
            console.log(`[MAILBOX] Recovered ${recovered} in-flight message(s) for ${sessionId}`);
          }
        } catch (err) {
          console.error(`[MAILBOX] recoverInflight error for ${sessionId}: ${err.message}`);
        }

        // 2. Expire stale messages
        try {
          const expired = this.mailbox.expireStale(sessionId);
          if (expired > 0) {
            console.log(`[MAILBOX] Expired ${expired} stale message(s) for ${sessionId}`);
          }
        } catch (err) {
          console.error(`[MAILBOX] expireStale error for ${sessionId}: ${err.message}`);
        }

        // 3. Dequeue and deliver
        try {
          const msg = this.mailbox.dequeue(sessionId);
          if (!msg) continue;

          if (!this.deliverFn) {
            // No delivery function — auto-ack (testing mode)
            this.mailbox.ack(sessionId, msg.msg_id);
            continue;
          }

          let result;
          try {
            result = await this.deliverFn(sessionId, msg);
          } catch (err) {
            result = { success: false, error: err.message };
          }

          if (result && result.success) {
            this.mailbox.ack(sessionId, msg.msg_id);
            if (this.onDelivery) {
              this.onDelivery(sessionId, msg.msg_id, { success: true });
            }
          } else {
            const reason = (result && result.error) || 'delivery failed';
            this.mailbox.nack(sessionId, msg.msg_id, reason);
            console.log(`[MAILBOX] Delivery failed for ${sessionId}/${msg.msg_id}: ${reason} (attempt ${msg.attempt})`);
            if (this.onDelivery) {
              this.onDelivery(sessionId, msg.msg_id, { success: false, error: reason });
            }
          }
        } catch (err) {
          console.error(`[MAILBOX] Delivery loop error for ${sessionId}: ${err.message}`);
        }
      }
    } finally {
      this._tickInProgress = false;
    }
  }
}

module.exports = { DeliveryEngine };
