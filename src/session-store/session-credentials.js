'use strict';

// #815 — per-session sender credentials bound to a session INSTANCE, not to a name.
//
// The principal is (sid, epoch, generation). A bare sid is never a principal: a textual session
// id is routinely destroyed and recreated (worker cleanup, track reuse), and the successor must
// not inherit its predecessor's authority.
//
// Shape: bearer = "<epoch>.<secret>". Self-describing on purpose — a presented bearer NAMES the
// instance it claims, so a stale one resolves to a dead epoch (an explicit miss we can fail
// closed on) rather than silently failing to match some other session's verifier. It also makes
// a pre-#815 token, which has no epoch part, rejected by shape alone.
//
// What is kept, and where: the daemon stores only `verifier = sha256(bearer)`, and persists it
// (never the bearer) in sessions.json. That is what lets the SAME bearer stay verifiable across a
// daemon restart with no reissuance — which matters because the wrapped child carries the bearer
// in its spawn-time environment and the environment of a running process cannot be changed from
// outside. No salt: the bearer is 48 bytes of CSPRNG output, so a plain SHA-256 preimage search
// is infeasible; salting defends low-entropy secrets, which this is not.
//
// This authenticates against confused-deputy, remote-over-tunnel, and stale-instance senders. It
// does NOT defend against a same-uid process that reads the bearer out of the owner's process
// environment — see BOUNDARY.md.

const crypto = require('node:crypto');

const EPOCH_BYTES = 16;
const SECRET_BYTES = 32;

function verifierFor(bearer) {
  return crypto.createHash('sha256').update(String(bearer)).digest('hex');
}

// Constant-time verifier comparison. Length is checked first because timingSafeEqual throws on a
// length mismatch, and a hand-edited or truncated sessions.json must fail closed, never crash.
function verifierMatches(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

function splitBearer(bearer) {
  if (typeof bearer !== 'string') return null;
  const dot = bearer.indexOf('.');
  if (dot <= 0 || dot === bearer.length - 1) return null;
  return { epoch: bearer.slice(0, dot) };
}

function createCredentialStore() {
  // epoch → { sid, verifier, generation }. Keyed by epoch, not by a hash of the bearer, so the
  // instance identity is the index key and revocation is "drop the epoch".
  const byEpoch = new Map();

  // Mint a credential for a NEW instance of `sid`. Called at first registration of an id the
  // daemon does not currently hold — the one and only issuance point (consumer item 2/3).
  function issue(sid) {
    const epoch = crypto.randomBytes(EPOCH_BYTES).toString('base64url');
    const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
    const bearer = `${epoch}.${secret}`;
    const record = { sid, verifier: verifierFor(bearer), generation: 1 };
    byEpoch.set(epoch, record);
    // The bearer is returned to exactly one caller, once, and never stored in this map.
    return { epoch, bearer, verifier: record.verifier, generation: record.generation };
  }

  // Re-index an instance whose verifier came off disk (daemon restart). No bearer involved —
  // that is the whole point: the child's spawn-time bearer stays verifiable without reissuance.
  function adopt(sid, meta) {
    if (!sid || !meta || !meta.sessionEpoch || !meta.credentialVerifier) return false;
    byEpoch.set(meta.sessionEpoch, {
      sid,
      verifier: meta.credentialVerifier,
      generation: Number(meta.credentialGeneration) || 1
    });
    return true;
  }

  // Resolve a presented bearer to the full principal, or null. Fail closed: an unparseable,
  // unknown, revoked, or non-matching bearer yields NO principal — never a fallback to any name
  // the caller claimed.
  function verify(bearer) {
    const parts = splitBearer(bearer);
    if (!parts) return null;
    const record = byEpoch.get(parts.epoch);
    if (!record) return null;
    if (!verifierMatches(record.verifier, verifierFor(bearer))) return null;
    return { sid: record.sid, epoch: parts.epoch, generation: record.generation };
  }

  // "Is this bearer the current credential of THIS sid?" — the re-register and owner-claim gate.
  function matches(sid, bearer) {
    const principal = verify(bearer);
    return Boolean(principal && principal.sid === sid);
  }

  function hasCredential(sid) {
    for (const record of byEpoch.values()) {
      if (record.sid === sid) return true;
    }
    return false;
  }

  // Every destroy path calls this BEFORE the id can be reused, so a recreated textual sid gets a
  // fresh epoch and the predecessor's bearer can never resolve to the new instance.
  function revoke(sid) {
    let revoked = 0;
    for (const [epoch, record] of byEpoch) {
      if (record.sid === sid) {
        byEpoch.delete(epoch);
        revoked += 1;
      }
    }
    return revoked;
  }

  // A rename moves one live instance to a new name — same PTY, same owner, same epoch. The
  // credential follows the instance rather than being revoked, so the running child stays
  // authenticated; only `canonical_sid` in the principal changes.
  function rename(oldSid, newSid) {
    for (const record of byEpoch.values()) {
      if (record.sid === oldSid) record.sid = newSid;
    }
  }

  return { issue, adopt, verify, matches, hasCredential, revoke, rename, size: () => byEpoch.size };
}

module.exports = { createCredentialStore, verifierFor };
