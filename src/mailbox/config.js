'use strict';

const path = require('path');
const os = require('os');

/**
 * MailboxConfig — default configuration for FileMailbox.
 * Override via AIGENTRY_MAILBOX_DIR env or constructor options.
 */

const DEFAULT_ROOT = path.join(os.homedir(), '.aigentry', 'mailbox');

const DEFAULTS = {
  /** Root directory for all mailbox storage. */
  root: process.env.AIGENTRY_MAILBOX_DIR || DEFAULT_ROOT,
  /** Max retry attempts before dead-lettering. */
  maxRetries: 3,
  /** Initial retry backoff in seconds. Doubles each attempt: 1s, 2s, 4s. */
  retryBackoffSecs: 1,
  /** Message TTL in seconds (24h). */
  ttlSecs: 86400,
  /** In-flight timeout: auto-nack if ACK not received within this window. */
  inflightTimeoutSecs: 30,
  /** Compact inbox.jsonl after this many acked entries. */
  compactionThreshold: 100,
  /** Delivery engine poll interval in ms. */
  deliveryPollMs: 200,
  /** Notification coalesce window in ms. */
  notifyCoalesceMs: 25,
  /** Lock age threshold in seconds — break locks older than this (handles PID recycling). */
  staleLockAgeSecs: 60,
  /** Force-break lock after this many consecutive lock timeout failures per session. */
  lockBreakAfterFailures: 3,
};

function createConfig(overrides = {}) {
  return { ...DEFAULTS, ...overrides };
}

module.exports = { createConfig, DEFAULTS };
