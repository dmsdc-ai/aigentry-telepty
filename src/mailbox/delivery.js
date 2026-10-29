'use strict';

const fs = require('fs');
const path = require('path');

/**
 * DeliveryEngine — polls mailbox for pending messages and delivers them.
 *
 * For each registered session, dequeues messages and calls the deliverFn callback.
 * On success: ack. Definite failures nack; uncertain outcomes are quarantined without retry.
 *
 * Also handles:
 * - In-flight recovery (fenced attempts stay unknown; untouched legacy entries can retry)
 * - TTL expiry (expire stale pending messages)
 * - Stale lock detection: consecutive failure tracking + exponential backoff
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
    this._setInterval = options.setInterval || setInterval;
    this._clearInterval = options.clearInterval || clearInterval;
    this._timer = null;
    this._running = false;
    this._tickInProgress = false;
    // Fix 4: Per-session consecutive lock failure count
    this._lockFailures = new Map();  // sessionId → count
    // Fix 5: Per-session skip-until timestamp for backoff
    this._skipUntil = new Map();     // sessionId → timestamp
  }

  /**
   * Start the delivery engine polling loop.
   */
  start() {
    if (this._running) return;
    this._running = true;
    this._timer = this._setInterval(() => this._tick(), this.pollMs);
    if (this._timer.unref) this._timer.unref();
    console.log(`[MAILBOX] DeliveryEngine started (poll: ${this.pollMs}ms)`);
  }

  /**
   * Stop the delivery engine.
   */
  stop() {
    this._running = false;
    if (this._timer) {
      this._clearInterval(this._timer);
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
      const lockBreakThreshold = this.mailbox.config.lockBreakAfterFailures || 3;

      for (const sessionId of sessionIds) {
        // Fix 5: Skip sessions in backoff
        const skipUntil = this._skipUntil.get(sessionId) || 0;
        if (Date.now() < skipUntil) continue;

        let lockFailed = false;

        // 1. Recover in-flight timeouts
        try {
          const recovered = this.mailbox.recoverInflight(sessionId);
          if (recovered > 0) {
            console.log(`[MAILBOX] Recovered ${recovered} in-flight message(s) for ${sessionId}`);
          }
        } catch (err) {
          if (err.message.includes('lock timeout')) {
            lockFailed = true;
          } else {
            console.error(`[MAILBOX] recoverInflight error for ${sessionId}: ${err.message}`);
          }
        }

        // 2. Expire stale messages
        if (!lockFailed) {
          try {
            const expired = this.mailbox.expireStale(sessionId);
            if (expired > 0) {
              console.log(`[MAILBOX] Expired ${expired} stale message(s) for ${sessionId}`);
            }
          } catch (err) {
            if (err.message.includes('lock timeout')) {
              lockFailed = true;
            } else {
              console.error(`[MAILBOX] expireStale error for ${sessionId}: ${err.message}`);
            }
          }
        }

        // 3. Dequeue and deliver
        if (!lockFailed) {
          try {
            const msg = this.mailbox.dequeue(sessionId);
            if (!msg) {
              // Success path (no message but lock acquired OK)
              this._lockFailures.delete(sessionId);
              this._skipUntil.delete(sessionId);
              continue;
            }

            if (!this.deliverFn) {
              // No delivery function — auto-ack (testing mode)
              this.mailbox.ack(sessionId, msg.msg_id);
              this._lockFailures.delete(sessionId);
              this._skipUntil.delete(sessionId);
              continue;
            }

            let result, fenced = false;
            try { fenced = this.mailbox.beginNonRetryableAttempt(sessionId, msg.msg_id); }
            catch { /* Fail before entering an effectful callback if durability is unavailable. */ }
            if (!fenced) result = { success: false, code: 'TRACKING_PERSISTENCE_FAILED', bytes_written: 0,
              error: 'Delivery attempt fence unavailable; callback was not invoked.' };
            else {
              try { result = await this.deliverFn(sessionId, msg); }
              catch { result = { success: false, code: 'DELIVERY_UNCERTAIN', delivery_uncertain: true, bytes_written: null,
                error: 'Delivery callback threw; physical outcome is unknown.' }; }
            }

            if (result && result.success) {
              this.mailbox.ack(sessionId, msg.msg_id);
              if (this.onDelivery) {
                this.onDelivery(sessionId, msg.msg_id, { success: true });
              }
            } else if (result && result.delivery_uncertain === true) {
              let quarantined = false;
              try { quarantined = this.mailbox.withdraw(sessionId, msg.msg_id, 'delivery_outcome_unknown', { inFlight: true, deliveryUncertain: true }); }
              catch { /* The fsynced attempt fence still prevents restart recovery from retrying. */ }
              if (this.onDelivery) this.onDelivery(sessionId, msg.msg_id, { ...result, success: false, outcome: 'unknown', retryable: false, quarantined });
              console.warn(`[MAILBOX] Delivery outcome unknown for ${sessionId}/${msg.msg_id}; automatic retry disabled`);
            } else {
              const reason = (result && result.error) || 'delivery failed';
              this.mailbox.nack(sessionId, msg.msg_id, reason);
              console.log(`[MAILBOX] Delivery failed for ${sessionId}/${msg.msg_id}: ${reason} (attempt ${msg.attempt})`);
              if (this.onDelivery) {
                this.onDelivery(sessionId, msg.msg_id, { ...result, success: false, error: reason });
              }
            }

            // Success path (lock was acquired)
            this._lockFailures.delete(sessionId);
            this._skipUntil.delete(sessionId);
          } catch (err) {
            if (err.message.includes('lock timeout')) {
              lockFailed = true;
            } else {
              console.error(`[MAILBOX] Delivery loop error for ${sessionId}: ${err.message}`);
            }
          }
        }

        // Fix 4 & 5: Handle lock failure — track, force-break, backoff
        if (lockFailed) {
          const failCount = (this._lockFailures.get(sessionId) || 0) + 1;
          this._lockFailures.set(sessionId, failCount);

          // Fix 4: Force-break after N consecutive failures
          if (failCount >= lockBreakThreshold) {
            const lockPath = path.join(this.mailbox._sessionDir(sessionId), '.lock');
            try { fs.unlinkSync(lockPath); } catch {}
            console.warn(`[MAILBOX] Force-broke stale lock for ${sessionId} after ${failCount} consecutive failures`);
            this._lockFailures.delete(sessionId);
            this._skipUntil.delete(sessionId);
          } else {
            // Fix 5: Exponential backoff — skip this session for increasing intervals
            const backoffMs = Math.min(this.pollMs * (1 << failCount), 30000);
            this._skipUntil.set(sessionId, Date.now() + backoffMs);
          }
        }
      }
    } finally {
      this._tickInProgress = false;
    }
  }
}

module.exports = { DeliveryEngine };
