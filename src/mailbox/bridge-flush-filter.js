'use strict';

// #720 — bridge mailbox flush-path protections.
//
// When the bridge promptReady gate stays closed for a long window, every inject
// PARKS in the bridge mailbox with a UNIQUE msg_id, so the mailbox's own msg_id
// dedup can't collapse identical content. On gate-open, flushBridgeMailbox
// dequeues the whole batch — without these filters it delivers stale copies and
// every consecutive duplicate (observed live: same question answered 3×).
//
// Pure functions (no I/O) so the flush logic is unit-testable in isolation.

const DEFAULT_TTL_SECS = 600; // 10 min

/**
 * Resolve the bridge-flush inject TTL (seconds) from env.
 * Distinct from the mailbox's 24h ttlSecs (daemon delivery) — this is a
 * bridge-flush-local staleness bound. Invalid / non-positive → default.
 */
function bridgeInjectTtlSecs(env = process.env) {
  const raw = env.TELEPTY_BRIDGE_INJECT_TTL_SECS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_SECS;
}

/**
 * Filter a dequeued bridge batch (oldest-first) into what to deliver vs drop.
 *
 * Single ordered pass:
 *   1. TTL — nowSecs - created_at > ttlSecs → drop, reason 'stale'.
 *   2. Dedup — payload identical to the last DELIVERED payload → drop, reason
 *      'duplicate'. Consecutive-only: a re-ask after a different message
 *      (Q,R,Q) survives, and a stale drop does not reset the anchor so
 *      Q,Q(stale),Q still collapses the trailing duplicate.
 *
 * @returns {{ deliver: object[], dropped: {msg: object, reason: string}[] }}
 */
function filterBridgeBatch(batch, { ttlSecs, nowSecs }) {
  const deliver = [];
  const dropped = [];
  let lastDeliveredPayload;
  let haveDelivered = false;
  for (const msg of batch) {
    if (nowSecs - msg.created_at > ttlSecs) {
      dropped.push({ msg, reason: 'stale' });
      continue;
    }
    if (haveDelivered && msg.payload === lastDeliveredPayload) {
      dropped.push({ msg, reason: 'duplicate' });
      continue;
    }
    deliver.push(msg);
    lastDeliveredPayload = msg.payload;
    haveDelivered = true;
  }
  return { deliver, dropped };
}

module.exports = { filterBridgeBatch, bridgeInjectTtlSecs, DEFAULT_TTL_SECS };
