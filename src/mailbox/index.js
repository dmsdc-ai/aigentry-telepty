'use strict';

const path = require('path');
const fs = require('fs');
const {
  acquireLock,
  breakStaleLocks,
  ensureSessionDir,
  loadStates,
  appendState,
  loadMessages,
  countPending,
  compact,
  appendJsonl,
  readJsonl,
  writeJsonl,
  listSessionDirs,
} = require('./storage');
const { createConfig } = require('./config');
const { canonicalRoot, resolveSessionDir, rethrowBoundary, openFile } = require('./path-boundary');

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

/**
 * FileMailbox — JSONL-backed mailbox implementing MailboxProtocol.
 *
 * Per-session v2 advisory locks require cooperating writers on a local filesystem.
 * JSONL format is shared with Rust aigentry-mailbox; lock protocols must also
 * match before writers may concurrently share a root.
 */
class FileMailbox {
  constructor(overrides = {}) {
    this.config = createConfig(overrides);
    this.config.root = canonicalRoot(this.config.root);
  }

  _sessionDir(sessionId) {
    return resolveSessionDir(this.config.root, sessionId);
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
        ...(msg.cooperative_handoff ? {cooperative_handoff:msg.cooperative_handoff} : {}),
      });

      // Append state: pending
      if(msg.cooperative_handoff && (msg.attempt||0)===0)appendJsonl(path.join(sessionDir,'state.jsonl'),{msg_id:msg.msg_id,state:'pending',ts:now,never_attempted:true});
      else appendState(sessionDir,msg.msg_id,'pending',now);

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
      if (st && (st.state === 'acked' || st.state === 'dead_letter')) return;

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
   * Withdraw a message that has not been handed to a deliverer: only a `pending` message moves to
   * dead letter (with `reason`), so it can never be delivered afterwards. Returns true if it did;
   * false if the message is in flight, already delivered or already gone. The active
   * deliverer may opt into `inFlight` to reject text bound to a displaced session.
   */
  // Durably fence a non-idempotent write BEFORE crossing its effect boundary. A daemon
  // interruption after this point is unknown, never evidence that retry is safe.
  beginNonRetryableAttempt(sessionId, msgId) {
    const sessionDir = this._sessionDir(sessionId);
    if (!fs.existsSync(sessionDir)) return false;
    const release = acquireLock(sessionDir);
    try {
      const st = loadStates(sessionDir).get(msgId);
      if (!st || st.state !== 'in_flight') return false;
      if (st.non_retryable_attempt === true) return true;
      const fd = openFile(path.join(sessionDir, 'state.jsonl'), fs.constants.O_WRONLY | fs.constants.O_APPEND);
      try {
        fs.writeFileSync(fd, JSON.stringify({ msg_id: msgId, state: 'in_flight', ts: unixNow(), non_retryable_attempt: true }) + '\n');
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      return true;
    } finally { release(); }
  }

  withdraw(sessionId, msgId, reason, { inFlight = false, deliveryUncertain = false } = {}) {
    const sessionDir = this._sessionDir(sessionId);
    if (!fs.existsSync(sessionDir)) return false;

    const release = acquireLock(sessionDir);
    try {
      const st = loadStates(sessionDir).get(msgId);
      if (!st || (st.state !== 'pending' && !(inFlight && st.state === 'in_flight'))) return false;

      const msg = loadMessages(sessionDir)
        .filter(m => m.msg_id === msgId)
        .reduce((latest, m) => (!latest || (m.attempt || 0) > (latest.attempt || 0) ? m : latest), null);
      if (!msg) return false;

      const now = unixNow();
      appendJsonl(path.join(sessionDir, 'dead-letter.jsonl'), {
        msg_id: msg.msg_id,
        from: msg.from,
        to: msg.to,
        payload: msg.payload,
        reason: reason || 'withdrawn',
        ...(deliveryUncertain ? { delivery_uncertain: true, outcome: 'unknown', retryable: false } : {}),
        failed_at: now,
        attempts: msg.attempt || 0,
      });
      if (deliveryUncertain) {
        const fd = openFile(path.join(sessionDir, 'dead-letter.jsonl'), fs.constants.O_WRONLY);
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        appendJsonl(path.join(sessionDir, 'state.jsonl'), { msg_id: msgId, state: 'dead_letter', ts: now, delivery_uncertain: true, outcome: 'unknown', retryable: false });
        const stateFd = openFile(path.join(sessionDir, 'state.jsonl'), fs.constants.O_WRONLY);
        try { fs.fsyncSync(stateFd); } finally { fs.closeSync(stateFd); }
      } else appendState(sessionDir, msgId, 'dead_letter', now);
      return true;
    } finally {
      release();
    }
  }

  /**
   * Latest state of one message (`pending`, `in_flight`, `dead_letter`, …), or null when the
   * mailbox has no record of it (never enqueued, or purged with its session).
   */
  messageState(sessionId, msgId) {
    const sessionDir = this._sessionDir(sessionId);
    if (!fs.existsSync(sessionDir)) return null;

    const release = acquireLock(sessionDir);
    try {
      const st = loadStates(sessionDir).get(msgId);
      return st ? st.state : null;
    } finally {
      release();
    }
  }

  // Registration prepares custody before publishing its verifier. Never repair an existing
  // partial queue: missing files may represent lost messages rather than an unused mailbox.
  initializeCustody(sessionId) {
    const sessionDir = this._sessionDir(sessionId);
    let created = false;
    try { fs.mkdirSync(sessionDir, { mode: 0o700 }); created = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const release = acquireLock(sessionDir);
    try {
      if (created) {
        for (const leaf of ['inbox.jsonl', 'state.jsonl']) {
          const fd = openFile(path.join(sessionDir, leaf), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
          try { fs.writeFileSync(fd, ''); fs.fsyncSync(fd); }
          finally { fs.closeSync(fd); }
        }
      }
      require('./custody').strictCustodySnapshot(sessionDir, sessionId);
      // Flush existing valid custody too: a retry after an uncertain flush must establish
      // durability itself. No successful session ACK depends on a prior failed attempt.
      for (const leaf of ['inbox.jsonl', 'state.jsonl']) {
        const fd = openFile(path.join(sessionDir, leaf), fs.constants.O_RDONLY);
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
      if (process.platform !== 'win32') {
        // Include newly created root ancestors, not merely the queue's own entries.
        for (let directory = sessionDir; ; directory = path.dirname(directory)) {
          const fd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
          try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          if (path.dirname(directory) === directory) break;
        }
      }
    } finally { release(); }
  }

  snapshotCustody(sessionId) {
    return this.withCustodySnapshot(sessionId, snapshot => snapshot);
  }

  withAcknowledgedCustody(sessionId,event,callback){
    const sessionDir=this._sessionDir(sessionId),release=acquireLock(sessionDir);
    try{
      require('./custody').acknowledgedCustodySnapshot(sessionDir,sessionId,event);
      for(const leaf of ['inbox.jsonl','state.jsonl']){const fd=openFile(path.join(sessionDir,leaf),fs.constants.O_RDONLY);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
      if(process.platform!=='win32'){const fd=fs.openSync(sessionDir,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
      return callback();
    }finally{release();}
  }

  withNeverAttemptedCustody(sessionId,callback){
    const sessionDir=this._sessionDir(sessionId),release=acquireLock(sessionDir);
    try{
      const rows=require('./custody').neverAttemptedCustodySnapshot(sessionDir,sessionId);
      // Flush the immutable bytes before an authority record can claim durable custody.
      for(const leaf of ['inbox.jsonl','state.jsonl']){const fd=openFile(path.join(sessionDir,leaf),fs.constants.O_RDONLY);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
      if(process.platform!=='win32'){const fd=fs.openSync(sessionDir,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
      const result=callback(rows);if(result&&typeof result.then==='function')throw new Error('Custody callback must be synchronous');return result;
    }finally{release();}
  }

  withCustodySnapshot(sessionId, callback) {
    const sessionDir = this._sessionDir(sessionId);
    if (!fs.existsSync(sessionDir)) throw Object.assign(new Error('Mailbox custody is unavailable'), { code: 'MAILBOX_CUSTODY_UNAVAILABLE' });
    const release = acquireLock(sessionDir);
    try {
      const snapshot = require('./custody').strictCustodySnapshot(sessionDir, sessionId);
      const result = callback(snapshot);
      if(result && typeof result.then === 'function') throw new Error('Custody callback must be synchronous');
      return result;
    }
    finally { release(); }
  }

  /**
   * Peek at pending messages without dequeueing.
   */
  peek(sessionId, { includePayload = false } = {}) {
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
          ...(includePayload ? { payload: msg.payload, to: msg.to } : {}),
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
        try { writeJsonl(p, []); } catch (err) { rethrowBoundary(err); }
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
    const release = acquireLock(sessionDir);
    try { writeJsonl(path.join(sessionDir, 'dead-letter.jsonl'), []); }
    finally { release(); }
  }

  /**
   * Break stale lock files across all session directories.
   * Call at daemon startup before DeliveryEngine.start().
   * Returns count of broken locks.
   */
  breakStaleLocks() {
    const staleLockAgeMs = (this.config.staleLockAgeSecs || 60) * 1000;
    return breakStaleLocks(this.config.root, { staleLockAgeMs });
  }

  /**
   * List all session IDs that have a mailbox directory.
   */
  listSessions() {
    return listSessionDirs(this.config.root).map(d => d.sessionId);
  }

  /**
   * Recover timed-out in-flight messages: quarantine fenced attempts; retry legacy untouched entries.
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
          if (entry.non_retryable_attempt) {
            appendJsonl(path.join(sessionDir, 'dead-letter.jsonl'), { msg_id: msg.msg_id, from: msg.from, to: msg.to, payload: msg.payload,
              reason: 'delivery_outcome_unknown_after_interruption', delivery_uncertain: true, outcome: 'unknown', retryable: false, failed_at: now, attempts: msg.attempt || 0 });
            appendJsonl(path.join(sessionDir, 'state.jsonl'), { msg_id: msgId, state: 'dead_letter', ts: now, delivery_uncertain: true, outcome: 'unknown', retryable: false });
          } else if (attempt >= this.config.maxRetries) {
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
