'use strict';

const path = require('path');
const fs = require('fs');
const {
  acquireLock,
  ensureSessionDir,
  loadStates,
  appendState,
  loadMessages,
  countPending,
  compact,
  appendJsonl,
  readJsonl,
  listSessionDirs,
} = require('./storage');
const { createConfig } = require('./config');

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

/**
 * FileMailbox — JSONL-backed mailbox implementing MailboxProtocol.
 *
 * Thread-safe via per-session advisory file locks.
 * Interoperable with Rust aigentry-mailbox crate (shared JSONL format).
 */
class FileMailbox {
  constructor(overrides = {}) {
    this.config = createConfig(overrides);
    fs.mkdirSync(this.config.root, { recursive: true, mode: 0o700 });
  }

  _sessionDir(sessionId) {
    return path.join(this.config.root, sessionId);
  }

  /**
   * Enqueue a message to a target session's inbox.
   * Idempotent: re-enqueueing the same msg_id is a no-op (returns queued: false).
   */
  enqueue(msg) {
    const sessionDir = ensureSessionDir(this.config.root, msg.to);
    const release = acquireLock(sessionDir);
    try {
      // Idempotency check
      const states = loadStates(sessionDir);
      if (states.has(msg.msg_id)) {
        const pending = countPending(sessionDir, unixNow());
        return { msg_id: msg.msg_id, queued: false, pending };
      }

      // TTL check — reject already-expired messages
      const now = unixNow();
      if (msg.created_at + this.config.ttlSecs < now) {
        throw new Error(`Message ${msg.msg_id} already expired (created_at: ${msg.created_at}, ttl: ${this.config.ttlSecs}s)`);
      }

      // Append to inbox.jsonl
      appendJsonl(path.join(sessionDir, 'inbox.jsonl'), {
        msg_id: msg.msg_id,
        from: msg.from,
        to: msg.to,
        payload: msg.payload,
        created_at: msg.created_at,
        attempt: msg.attempt || 0,
      });

      // Append state: pending
      appendState(sessionDir, msg.msg_id, 'pending', now);

      const pending = countPending(sessionDir, now);
      return { msg_id: msg.msg_id, queued: true, pending };
    } finally {
      release();
    }
  }

  /**
   * Dequeue the next pending message for a session.
   * Transitions it to in_flight. Returns null if no pending messages.
   */
  dequeue(sessionId) {
    const sessionDir = this._sessionDir(sessionId);
    if (!fs.existsSync(sessionDir)) return null;

    const release = acquireLock(sessionDir);
    try {
      const states = loadStates(sessionDir);
      const rawMessages = loadMessages(sessionDir);
      const now = unixNow();

      // Deduplicate by msg_id — keep highest attempt entry
      const latest = new Map();
      for (const msg of rawMessages) {
        const existing = latest.get(msg.msg_id);
        if (!existing || (msg.attempt || 0) > (existing.attempt || 0)) {
          latest.set(msg.msg_id, msg);
        }
      }

      // Find oldest pending message that is past its scheduled time
      let next = null;
      for (const msg of latest.values()) {
        const st = states.get(msg.msg_id);
        if (!st || st.state !== 'pending') continue;
        // For retried messages, created_at may be set to a future time (backoff)
        if (msg.created_at > now) continue;
        if (!next || msg.created_at < next.created_at) {
          next = msg;
        }
      }

      if (!next) return null;

      // Transition to in_flight
      appendState(sessionDir, next.msg_id, 'in_flight', now);
      return next;
    } finally {
      release();
    }
  }

  /**
   * Acknowledge successful delivery of a message.
   */
  ack(sessionId, msgId) {
    const sessionDir = this._sessionDir(sessionId);
    if (!fs.existsSync(sessionDir)) return;

    const release = acquireLock(sessionDir);
    try {
      const states = loadStates(sessionDir);
      const st = states.get(msgId);
      // Idempotent: already acked → no-op
      if (st && st.state === 'acked') return;

      appendState(sessionDir, msgId, 'acked', unixNow());
      compact(sessionDir, this.config.compactionThreshold);
    } finally {
      release();
    }
  }

  /**
   * Negative acknowledge — mark message as failed. Retry or dead-letter.
   */
  nack(sessionId, msgId, reason) {
    const sessionDir = this._sessionDir(sessionId);
    if (!fs.existsSync(sessionDir)) return;

    const release = acquireLock(sessionDir);
    try {
      const states = loadStates(sessionDir);
      const st = states.get(msgId);
      // Idempotent: already dead_letter → no-op
      if (st && st.state === 'dead_letter') return;

      const messages = loadMessages(sessionDir);
      // Find the LATEST entry for this msg_id (highest attempt number)
      const candidates = messages.filter(m => m.msg_id === msgId);
      const msg = candidates.reduce((latest, m) => {
        if (!latest) return m;
        return (m.attempt || 0) > (latest.attempt || 0) ? m : latest;
      }, null);
      if (!msg) return;

      const now = unixNow();
      const attempt = (msg.attempt || 0) + 1;

      if (attempt >= this.config.maxRetries) {
        // Dead letter
        appendJsonl(path.join(sessionDir, 'dead-letter.jsonl'), {
          msg_id: msg.msg_id,
          from: msg.from,
          to: msg.to,
          payload: msg.payload,
          reason: reason || 'max_retries exhausted',
          failed_at: now,
          attempts: attempt,
        });
        appendState(sessionDir, msgId, 'dead_letter', now);
      } else {
        // Re-enqueue with incremented attempt and backoff delay
        const backoff = this.config.retryBackoffSecs * (1 << (attempt - 1));
        appendState(sessionDir, msgId, 'nacked', now);

        // Re-enqueue with future created_at for backoff scheduling
        appendJsonl(path.join(sessionDir, 'inbox.jsonl'), {
          msg_id: msg.msg_id,
          from: msg.from,
          to: msg.to,
          payload: msg.payload,
          created_at: now + backoff,
          attempt,
        });
        appendState(sessionDir, msg.msg_id, 'pending', now);
      }
    } finally {
      release();
    }
  }

  /**
   * Peek at pending messages without dequeueing.
   */
  peek(sessionId) {
    const sessionDir = this._sessionDir(sessionId);
    if (!fs.existsSync(sessionDir)) return [];

    const release = acquireLock(sessionDir);
    try {
      const states = loadStates(sessionDir);
      const messages = loadMessages(sessionDir);
      const results = [];

      for (const msg of messages) {
        const st = states.get(msg.msg_id);
        if (!st) continue;
        results.push({
          msg_id: msg.msg_id,
          from: msg.from,
          created_at: msg.created_at,
          attempt: msg.attempt || 0,
          state: st.state,
        });
      }

      // Deduplicate by msg_id (keep latest attempt)
      const seen = new Map();
      for (const entry of results) {
        const existing = seen.get(entry.msg_id);
        if (!existing || entry.attempt > existing.attempt) {
          seen.set(entry.msg_id, entry);
        }
      }
      return Array.from(seen.values());
    } finally {
      release();
    }
  }

  /**
   * Purge all messages for a session.
   */
  purge(sessionId) {
    const sessionDir = this._sessionDir(sessionId);
    if (!fs.existsSync(sessionDir)) return;

    const release = acquireLock(sessionDir);
    try {
      for (const file of ['inbox.jsonl', 'state.jsonl']) {
        const p = path.join(sessionDir, file);
        try { fs.writeFileSync(p, ''); } catch {}
      }
    } finally {
      release();
    }
  }

  /**
   * Peek at dead letter entries.
   */
  peekDeadLetter(sessionId) {
    const sessionDir = this._sessionDir(sessionId);
    if (!fs.existsSync(sessionDir)) return [];
    return readJsonl(path.join(sessionDir, 'dead-letter.jsonl'));
  }

  /**
   * Purge dead letter entries.
   */
  purgeDeadLetter(sessionId) {
    const sessionDir = this._sessionDir(sessionId);
    if (!fs.existsSync(sessionDir)) return;
    const p = path.join(sessionDir, 'dead-letter.jsonl');
    try { fs.writeFileSync(p, ''); } catch {}
  }

  /**
   * List all session IDs that have a mailbox directory.
   */
  listSessions() {
    return listSessionDirs(this.config.root).map(d => d.sessionId);
  }

  /**
   * Recover in-flight messages that timed out → auto-nack.
   * Called by DeliveryEngine.
   */
  recoverInflight(sessionId) {
    const sessionDir = this._sessionDir(sessionId);
    if (!fs.existsSync(sessionDir)) return 0;

    const release = acquireLock(sessionDir);
    try {
      const states = loadStates(sessionDir);
      const now = unixNow();
      let recovered = 0;

      for (const [msgId, entry] of states) {
        if (entry.state === 'in_flight' && (now - entry.ts) >= this.config.inflightTimeoutSecs) {
          // Release lock, nack externally (nack acquires its own lock)
          // Instead, inline the nack logic to avoid deadlock
          const messages = loadMessages(sessionDir);
          // Find latest entry for this msg_id (highest attempt)
          const candidates = messages.filter(m => m.msg_id === msgId);
          const msg = candidates.reduce((latest, m) => {
            if (!latest) return m;
            return (m.attempt || 0) > (latest.attempt || 0) ? m : latest;
          }, null);
          if (!msg) continue;

          const attempt = (msg.attempt || 0) + 1;
          if (attempt >= this.config.maxRetries) {
            appendJsonl(path.join(sessionDir, 'dead-letter.jsonl'), {
              msg_id: msg.msg_id,
              from: msg.from,
              to: msg.to,
              payload: msg.payload,
              reason: 'inflight_timeout',
              failed_at: now,
              attempts: attempt,
            });
            appendState(sessionDir, msgId, 'dead_letter', now);
          } else {
            const backoff = this.config.retryBackoffSecs * (1 << (attempt - 1));
            appendState(sessionDir, msgId, 'nacked', now);
            appendJsonl(path.join(sessionDir, 'inbox.jsonl'), {
              msg_id: msg.msg_id,
              from: msg.from,
              to: msg.to,
              payload: msg.payload,
              created_at: now + backoff,
              attempt,
            });
            appendState(sessionDir, msg.msg_id, 'pending', now);
          }
          recovered++;
        }
      }
      return recovered;
    } finally {
      release();
    }
  }

  /**
   * Expire pending messages past TTL.
   * Called by DeliveryEngine.
   */
  expireStale(sessionId) {
    const sessionDir = this._sessionDir(sessionId);
    if (!fs.existsSync(sessionDir)) return 0;

    const release = acquireLock(sessionDir);
    try {
      const states = loadStates(sessionDir);
      const messages = loadMessages(sessionDir);
      const now = unixNow();
      let expired = 0;

      for (const msg of messages) {
        const st = states.get(msg.msg_id);
        if (!st) continue;
        if ((st.state === 'pending' || st.state === 'in_flight') &&
            (msg.created_at + this.config.ttlSecs < now)) {
          appendState(sessionDir, msg.msg_id, 'expired', now);
          expired++;
        }
      }

      if (expired > 0) {
        compact(sessionDir, this.config.compactionThreshold);
      }
      return expired;
    } finally {
      release();
    }
  }
}

module.exports = { FileMailbox };
