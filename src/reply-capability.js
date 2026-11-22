'use strict';

// Task 1292 W1 — reply-capability-v1: the in-memory capability store (SPEC §1, §2.2 record, §3.3 C3–C6 and
// C11, §4 settlement, §5 state machine, §8 refusal budget, §9 limits).
//
// Pure module. It does no file I/O and logs nothing. It starts no timer unless startSweeper() is called, and
// that interval is unref()'d. The wall clock, the monotonic clock, the RNG and the timers can all be injected.
// The routes (W2 mint, W3 consume) own every check that needs the sessions map, the request or the auth
// context. This module owns the record and its transitions. Each call is synchronous, so a route can run
// C1–C11 without an await between the check and the issued → in_flight transition (SPEC §3.3).
//
// Only the token's verifier, sha256(token) hex, is kept (same rule as session-credentials.js:14-19).
// mint() returns the token to its one caller, which needs it for the trailer. The token is never stored
// here and never logged.

const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { verifierFor, verifierMatches } = require('./session-store/session-credentials');

const CAPABILITY = 'reply-capability-v1';
const RESULT_SCHEMA = 'telepty.reply-capability-result/v1';
const SENDER_PROOF = 'reply-capability-v1';

const ID_BYTES = 16;
const SECRET_BYTES = 32;
const TOKEN_RE = /^rc1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const TOKEN_LENGTH = 70;

const MIN_TTL_MS = 30000;
const MAX_TTL_MS = 3600000;
const RETENTION_MS = 60000;
const MAX_LIVE_GLOBAL = 4096;
const MAX_LIVE_PER_RESPONDER = 64;
const MAX_LIVE_PER_REQUESTER = 64;
const MAX_ATTEMPTS = 3;
const REPLY_PREFIX_MAX_BYTES = 256;
const REPLY_BODY_MAX_BYTES = 65536;
const REQUEST_MAX_BYTES = 70 * 1024;
const REFUSAL_LINES_PER_ID = 8;
const ANON_REFUSAL_LINES = 10;
const ANON_REFUSAL_WINDOW_MS = 60000;
const SWEEP_INTERVAL_MS = 60000;

// Same bound and the same operator override as session-delivery.js:231-234. Recomputed here the same way
// delivery-runtime.js:37-40 does, because that value is local to the delivery closure (Root amendment Q2).
const SUBMIT_QUEUE_TIMEOUT_MS = (() => {
  const configured = Number(process.env.TELEPTY_SUBMIT_QUEUE_TIMEOUT_MS || 10000);
  return Number.isFinite(configured) && configured > 0 ? configured : 10000;
})();
const ACCEPT_MARGIN_MS = Math.max(15000, SUBMIT_QUEUE_TIMEOUT_MS + 5000);

const LIMITS = Object.freeze({
  maxLiveGlobal: MAX_LIVE_GLOBAL,
  maxLivePerResponder: MAX_LIVE_PER_RESPONDER,
  maxLivePerRequester: MAX_LIVE_PER_REQUESTER,
  minTtlMs: MIN_TTL_MS,
  maxTtlMs: MAX_TTL_MS,
  retentionMs: RETENTION_MS,
  maxAttempts: MAX_ATTEMPTS,
  acceptMarginMs: ACCEPT_MARGIN_MS,
  refusalLinesPerId: REFUSAL_LINES_PER_ID,
  anonRefusalLines: ANON_REFUSAL_LINES,
  anonRefusalWindowMs: ANON_REFUSAL_WINDOW_MS,
  sweepIntervalMs: SWEEP_INTERVAL_MS
});

const STATES = Object.freeze({
  ISSUED: 'issued', IN_FLIGHT: 'in_flight', CONSUMED: 'consumed', UNKNOWN: 'unknown',
  EXPIRED: 'expired', REVOKED: 'revoked', SUPERSEDED: 'superseded', VOID: 'void'
});

// SPEC §7: every code with its HTTP status. Delivery codes keep the delivery's own status (§4).
const ERROR_STATUS = Object.freeze({
  REPLY_CAPABILITY_UNAVAILABLE: 503,
  REPLY_CAPABILITY_REQUEST_INVALID: 400,
  REPLY_CAPABILITY_SENDER_UNVERIFIED: 403,
  REPLY_CAPABILITY_REQUESTER_STALE: 409,
  REPLY_CAPABILITY_TARGET_UNSUPPORTED: 409,
  REPLY_CAPABILITY_REQUESTER_UNSUPPORTED: 409,
  REPLY_CAPABILITY_DEADLINE_INVALID: 400,
  REPLY_CAPABILITY_CAPACITY: 503,
  REPLY_TRANSPORT_REFUSED: 403,
  REPLY_REQUEST_INVALID: 400,
  REPLY_CAPABILITY_UNKNOWN: 404,
  REPLY_CAPABILITY_IN_FLIGHT: 409,
  REPLY_CAPABILITY_CONSUMED: 409,
  REPLY_CAPABILITY_EXPIRED: 410,
  REPLY_CAPABILITY_SUPERSEDED: 410,
  REPLY_SENDER_MISMATCH: 403,
  REPLY_DESTINATION_GONE: 410,
  REPLY_CAPABILITY_VOID: 410,
  PEER_INJECT_BLOCKED: 403
});

// C5: the refusal a non-issued, non-replayable state answers with.
const STATE_REFUSAL = Object.freeze({
  revoked: 'REPLY_DESTINATION_GONE',
  superseded: 'REPLY_CAPABILITY_SUPERSEDED',
  expired: 'REPLY_CAPABILITY_EXPIRED',
  void: 'REPLY_CAPABILITY_VOID'
});

const REVOKE_REASONS = new Set(['inbound_refused', 'requester_gone']);
const STAGES = new Set(['accepted', 'refused', 'outcome_unknown']);

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// §3.4: the closed result object, keys in SPEC order.
function buildResult({ stage, outcome = null, reason = null, capability_id = null, reply_inject_id = null,
  destination_session_id = null, replayed = false, retryable = false }) {
  if (!STAGES.has(stage)) throw new TypeError('reply-capability: unknown result stage');
  return {
    schema: RESULT_SCHEMA,
    stage,
    outcome: stage === 'accepted' ? outcome : null,
    reason,
    capability_id,
    reply_inject_id,
    destination_session_id: stage === 'accepted' ? destination_session_id : null,
    replayed: replayed === true,
    retryable: retryable === true
  };
}

// A refusal answer for any code of §7. capability_id is null when C3/C4 failed (§3.4).
function refusalAnswer(code, { capability_id = null, reply_inject_id = null, status, retryable } = {}) {
  const httpStatus = Number.isInteger(status) ? status : ERROR_STATUS[code];
  if (!Number.isInteger(httpStatus)) throw new TypeError('reply-capability: refusal code has no status');
  return {
    status: httpStatus,
    result: buildResult({ stage: 'refused', reason: code, capability_id, reply_inject_id,
      retryable: retryable === undefined ? code === 'REPLY_CAPABILITY_IN_FLIGHT' : retryable })
  };
}

// §1: returns { id } for a well-formed token, else null. The secret is never split out or returned.
function parseToken(token) {
  if (typeof token !== 'string' || token.length !== TOKEN_LENGTH || !TOKEN_RE.test(token)) return null;
  return { id: token.slice(4, 26) };
}

// §2.1 reply_prefix: 1..256 bytes, printable ASCII, at most one '\n', which must be the last byte.
function validReplyPrefix(prefix) {
  if (typeof prefix !== 'string' || prefix.length < 1 || prefix.length > REPLY_PREFIX_MAX_BYTES) return false;
  const nl = prefix.indexOf('\n');
  if (nl !== -1 && nl !== prefix.length - 1) return false;
  const head = nl === -1 ? prefix : prefix.slice(0, -1);
  return /^[\x20-\x7E]*$/.test(head);
}

// §2.3: the exact trailer appended to the responder's delivered text. GB-06: the printed command uses --file, not
// `<` input redirection, so the same line runs in POSIX shells, cmd.exe and PowerShell (which has no `<`).
function replyCapabilityTrailer({ id, token, not_after_ms }) {
  const exp = new Date(not_after_ms).toISOString();
  return `\n\n⟦telepty:reply-capability v=1 id=${id} expires=${exp}⟧\n`
    + 'To reply to this request once, write the reply text to reply.txt and run on this machine:\n'
    + `  telepty reply-v1 ${token} --file reply.txt\n`
    + '(or pipe the reply text to the same command without --file). The reply goes only to the requester and only once.\n'
    + `⟦telepty:end reply-capability id=${id}⟧`;
}

// Task 1292 GB-01/GB-02/GB-03 — the support matrix (SUPPORT-MATRIX.md). A reply is written only where the requester-
// instance check and the deadline check run at the last synchronous point before the daemon's final write and nothing
// can stay pending in a queue or composer: an aterm session reached over its unix socket (one UDS write per attempt,
// no daemon-side deferred CR). Every other requester state is refused: at mint (M7a) and again at delivery entry.
// rc-fix6 (maintainer decision 2026-11-22): two more states, each guarded at its own final write.
//   wrapped — only while the CURRENT owner generation's bridge declared BRIDGE_REPLY_GUARD_CAPABILITY on its owner-WS
//             handshake (bound by bindImmediateSubmitCapability) and its started child is known (the child_seq the
//             bridge re-checks). A bridge that did not declare it never receives a capability reply (fail closed).
//   spawned — the daemon-owned PTY: body write guarded with deadline + headroom, deferred CR guarded with deadline.
const BRIDGE_REPLY_GUARD_CAPABILITY = 'reply-guard-v1';
function replyDeliverySupported(session) {
  if (!session || typeof session !== 'object' || session.sshRemote) return false;
  if (session.type === 'spawned') return true;
  if (session.type === 'wrapped') {
    return typeof session.replyGuardGeneration === 'string' && session.replyGuardGeneration === session.interactionOwnerGeneration
      && !!require('./transport/readiness-handshake').observedChild(session);
  }
  return session.type === 'aterm'
    && !!session.delivery && session.delivery.transport === 'unix_socket' && !!session.delivery.address;
}

function checkPrincipal(p, label) {
  if (!p || typeof p !== 'object' || typeof p.sid !== 'string' || p.sid.length === 0
    || typeof p.epoch !== 'string' || p.epoch.length === 0
    || !Number.isSafeInteger(p.generation) || p.generation < 1) {
    throw new TypeError(`reply-capability: invalid ${label} instance`);
  }
  return { sid: p.sid, epoch: p.epoch, generation: p.generation };
}

function instanceKey(p) {
  return JSON.stringify([p.sid, p.epoch, p.generation]);
}

function createReplyCapabilityStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const monoNow = typeof options.monoNow === 'function' ? options.monoNow : () => performance.now();
  const randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes;
  const randomUUID = typeof options.randomUUID === 'function' ? options.randomUUID : crypto.randomUUID;
  const timers = options.timers || { setInterval, clearInterval };
  const overrides = options.limits || {};
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(LIMITS, key)) throw new TypeError(`reply-capability: unknown limit ${key}`);
  }
  const L = Object.freeze({ ...LIMITS, ...overrides });
  const daemonInstanceId = options.daemonInstanceId === undefined ? null : options.daemonInstanceId;
  const daemonStartedAt = options.daemonStartedAt === undefined ? null : options.daemonStartedAt;

  const records = new Map();          // id -> record (internal, mutable)
  const byResponder = new Map();      // instanceKey -> held record count
  const byRequester = new Map();
  let order = [];                     // ids sorted by not_after_ms (ascending)
  let head = 0;                       // order[0..head) has been deleted or moved to `overdue`
  const overdue = new Set();          // ids past retention but still in_flight
  let anonTokens = L.anonRefusalLines;
  let anonLast = monoNow();
  let suppressed = 0;
  let sweeper = null;

  function bump(map, key, delta) {
    const next = (map.get(key) || 0) + delta;
    if (next <= 0) map.delete(key); else map.set(key, next);
  }

  function remove(rec) {
    if (!records.delete(rec.id)) return;
    bump(byResponder, instanceKey(rec.responder), -1);
    bump(byRequester, instanceKey(rec.requester), -1);
    overdue.delete(rec.id);
  }

  function insertOrdered(rec) {
    let lo = head, hi = order.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const other = records.get(order[mid]);
      if (other && other.not_after_ms <= rec.not_after_ms) lo = mid + 1; else hi = mid;
    }
    order.splice(lo, 0, rec.id);
  }

  function snapshot(rec) {
    return rec ? structuredClone(rec) : null;
  }

  // C6: both clocks, with the accept margin.
  function withinDeadline(rec) {
    return now() <= rec.not_after_ms - L.acceptMarginMs && monoNow() <= rec.deadline_mono_ms - L.acceptMarginMs;
  }

  // §9 sweep. Deletes every record past retention, except an in_flight one, which waits in `overdue` until it
  // settles. Expires every issued record in the not_after-ordered prefix whose wall-clock half of C6 has
  // failed. The cost is the number of entries in that prefix, i.e. the expired ones. With isInstanceLive (Root
  // amendment Q6), it also checks every issued record: responder gone -> superseded, requester gone -> revoked.
  function sweep({ isInstanceLive } = {}) {
    const t = now();
    let visited = 0, deleted = 0, expired = 0, superseded = 0, revoked = 0;
    for (const id of overdue) {
      const rec = records.get(id);
      if (!rec) { overdue.delete(id); continue; }
      if (rec.state !== STATES.IN_FLIGHT) { remove(rec); deleted += 1; }
    }
    while (head < order.length) {
      const rec = records.get(order[head]);
      if (rec && t < rec.retain_until_ms) break;
      visited += 1;
      if (rec) {
        if (rec.state === STATES.IN_FLIGHT) overdue.add(rec.id);
        else { remove(rec); deleted += 1; }
      }
      head += 1;
    }
    for (let i = head; i < order.length; i += 1) {
      const rec = records.get(order[i]);
      if (!rec) continue;
      if (t <= rec.not_after_ms - L.acceptMarginMs) break;
      visited += 1;
      if (rec.state === STATES.ISSUED) { rec.state = STATES.EXPIRED; expired += 1; }
    }
    if (head > 1024 && head * 2 > order.length) { order = order.slice(head); head = 0; }
    if (typeof isInstanceLive === 'function') {
      for (const rec of records.values()) {
        if (rec.state !== STATES.ISSUED) continue;
        if (!isInstanceLive({ ...rec.responder })) { rec.state = STATES.SUPERSEDED; superseded += 1; }
        else if (!isInstanceLive({ ...rec.requester })) {
          rec.state = STATES.REVOKED; rec.revoked_reason = 'requester_gone'; revoked += 1;
        }
      }
    }
    return { visited, deleted, expired, superseded, revoked };
  }

  // M8: the deadline window, on this store's wall clock.
  function deadlineRefusal(notAfterMs) {
    const t = now();
    if (!Number.isSafeInteger(notAfterMs) || notAfterMs < t + L.minTtlMs || notAfterMs > t + L.maxTtlMs) {
      return 'REPLY_CAPABILITY_DEADLINE_INVALID';
    }
    return null;
  }

  // M9: capacity after a lazy sweep. Every held record counts, terminal ones included, until retention ends
  // (Root amendment Q4).
  function capacityRefusal(responder, requester) {
    const r = checkPrincipal(responder, 'responder');
    const q = checkPrincipal(requester, 'requester');
    sweep();
    if (records.size >= L.maxLiveGlobal
      || (byResponder.get(instanceKey(r)) || 0) >= L.maxLivePerResponder
      || (byRequester.get(instanceKey(q)) || 0) >= L.maxLivePerRequester) {
      return 'REPLY_CAPABILITY_CAPACITY';
    }
    return null;
  }

  function freshToken() {
    for (let i = 0; i < 8; i += 1) {
      const id = Buffer.from(randomBytes(ID_BYTES)).toString('base64url');
      const secret = Buffer.from(randomBytes(SECRET_BYTES)).toString('base64url');
      const token = `rc1.${id}.${secret}`;
      if (!TOKEN_RE.test(token)) throw new Error('reply-capability: RNG returned the wrong length');
      if (!records.has(id)) return { id, token };
    }
    throw new Error('reply-capability: could not draw an unused id');
  }

  // §2.2 mint. Refusals (M8, M9) come back as { ok:false, code } with no effect. The token is returned once
  // and is not kept.
  function mint({ responder, requester, inbound_inject_id, reply_prefix, not_after_ms } = {}) {
    const r = checkPrincipal(responder, 'responder');
    const q = checkPrincipal(requester, 'requester');
    if (typeof inbound_inject_id !== 'string' || inbound_inject_id.length === 0) {
      throw new TypeError('reply-capability: inbound_inject_id is required');
    }
    if (!validReplyPrefix(reply_prefix)) throw new TypeError('reply-capability: invalid reply_prefix');
    const deadlineCode = deadlineRefusal(not_after_ms);
    if (deadlineCode) return { ok: false, code: deadlineCode };
    const capacityCode = capacityRefusal(r, q);
    if (capacityCode) return { ok: false, code: capacityCode };
    const { id, token } = freshToken();
    const mintedWall = now();
    const rec = {
      id,
      verifier: verifierFor(token),
      state: STATES.ISSUED,
      responder: r,
      requester: q,
      inbound_inject_id,
      reply_prefix,
      not_after_ms,
      minted_wall_ms: mintedWall,
      deadline_mono_ms: monoNow() + (not_after_ms - mintedWall),
      attempts: 0,
      refusal_lines: 0,
      body_sha256: null,
      outcome: null,
      reply_inject_id: null,
      retain_until_ms: not_after_ms + L.retentionMs,
      revoked_reason: null
    };
    records.set(id, rec);
    bump(byResponder, instanceKey(r), 1);
    bump(byRequester, instanceKey(q), 1);
    insertOrdered(rec);
    return { ok: true, id, token, not_after_ms, responder: { ...r } };
  }

  // §2.5: the requester's response field. It never contains the secret.
  function publicView(id) {
    const rec = records.get(id);
    if (!rec) return null;
    return { v: 1, id: rec.id, not_after_ms: rec.not_after_ms,
      responder: { session_id: rec.responder.sid, epoch: rec.responder.epoch, generation: rec.responder.generation } };
  }

  // C3 (token regex) and C4. An unknown id and a wrong secret give the same answer. parsed_id is the id of a
  // well-formed token, for the audit row only. Runs the lazy sweep.
  function resolve(token) {
    sweep();
    const parsed = parseToken(token);
    if (!parsed) return { ok: false, code: 'REPLY_REQUEST_INVALID', parsed_id: null };
    const presented = verifierFor(token);
    const rec = records.get(parsed.id);
    if (!rec || !verifierMatches(rec.verifier, presented)) {
      return { ok: false, code: 'REPLY_CAPABILITY_UNKNOWN', parsed_id: parsed.id };
    }
    return { ok: true, id: rec.id };
  }

  function terminalAnswer(rec, replayed) {
    if (rec.state === STATES.CONSUMED) {
      return { status: 200, result: buildResult({ stage: 'accepted', outcome: rec.outcome, capability_id: rec.id,
        reply_inject_id: rec.reply_inject_id, destination_session_id: rec.requester.sid, replayed }) };
    }
    return { status: 500, result: buildResult({ stage: 'outcome_unknown', capability_id: rec.id,
      reply_inject_id: rec.reply_inject_id, replayed }) };
  }

  // C5 and C6. Returns { ok:true } if the record is issued and inside its deadline. Otherwise returns
  // { ok:false, code, replayed, answer }. A C6 failure moves issued -> expired.
  function checkState(id, body) {
    const rec = records.get(id);
    if (!rec) return { ok: false, code: 'REPLY_CAPABILITY_UNKNOWN', replayed: false, answer: refusalAnswer('REPLY_CAPABILITY_UNKNOWN') };
    if (rec.state === STATES.IN_FLIGHT) {
      return { ok: false, code: 'REPLY_CAPABILITY_IN_FLIGHT', replayed: false,
        answer: refusalAnswer('REPLY_CAPABILITY_IN_FLIGHT', { capability_id: rec.id }) };
    }
    if (rec.state === STATES.CONSUMED || rec.state === STATES.UNKNOWN) {
      if (typeof body === 'string' && rec.body_sha256 !== null && sha256Hex(body) === rec.body_sha256) {
        return { ok: false, code: null, replayed: true, answer: terminalAnswer(rec, true) };
      }
      return { ok: false, code: 'REPLY_CAPABILITY_CONSUMED', replayed: false,
        answer: refusalAnswer('REPLY_CAPABILITY_CONSUMED', { capability_id: rec.id }) };
    }
    if (rec.state !== STATES.ISSUED) {
      const code = STATE_REFUSAL[rec.state];
      return { ok: false, code, replayed: false, answer: refusalAnswer(code, { capability_id: rec.id }) };
    }
    if (!withinDeadline(rec)) {
      rec.state = STATES.EXPIRED;
      return { ok: false, code: 'REPLY_CAPABILITY_EXPIRED', replayed: false,
        answer: refusalAnswer('REPLY_CAPABILITY_EXPIRED', { capability_id: rec.id }) };
    }
    return { ok: true };
  }

  // C7: the responder instance was replaced. issued -> superseded.
  function supersede(id) {
    const rec = records.get(id);
    if (!rec || rec.state !== STATES.ISSUED) return false;
    rec.state = STATES.SUPERSEDED;
    return true;
  }

  // §2.2 / §2.4 inbound refusal and C9 destination gone. issued -> revoked.
  function revoke(id, reason) {
    if (!REVOKE_REASONS.has(reason)) throw new TypeError('reply-capability: unknown revoke reason');
    const rec = records.get(id);
    if (!rec || rec.state !== STATES.ISSUED) return false;
    rec.state = STATES.REVOKED;
    rec.revoked_reason = reason;
    return true;
  }

  // C11: issued -> in_flight. Must run in the same synchronous turn as C3–C10.
  function begin(id, body) {
    const rec = records.get(id);
    if (!rec || rec.state !== STATES.ISSUED || typeof body !== 'string') return { ok: false };
    rec.state = STATES.IN_FLIGHT;
    rec.attempts += 1;
    rec.body_sha256 = sha256Hex(body);
    rec.reply_inject_id = randomUUID();
    return {
      ok: true,
      capability_id: rec.id,
      reply_inject_id: rec.reply_inject_id,
      attempt: rec.attempts,
      responder: { ...rec.responder },
      requester: { ...rec.requester },
      inbound_inject_id: rec.inbound_inject_id,
      reply_prefix: rec.reply_prefix,
      not_after_ms: rec.not_after_ms,
      delivered_text: rec.reply_prefix + body
    };
  }

  function settled(rec, answer) {
    return { ok: true, state: rec.state, attempt: rec.attempts, answer };
  }

  // §4: settle an in_flight record with the result of deliverInjectionToSession. `queued` is the route's
  // `deliveryAuditResult(delivery) === 'queued'`.
  function settle(id, delivery, { queued = false } = {}) {
    const rec = records.get(id);
    if (!rec || rec.state !== STATES.IN_FLIGHT) return { ok: false };
    const d = delivery && typeof delivery === 'object' ? delivery : {};
    const ids = { capability_id: rec.id, reply_inject_id: rec.reply_inject_id };
    if (d.success === true) {
      rec.state = STATES.CONSUMED;
      rec.outcome = queued === true ? 'queued' : 'delivered';
      return settled(rec, terminalAnswer(rec, false));
    }
    if (d.delivery_uncertain === true || d.bytes_written === null) {
      rec.state = STATES.UNKNOWN;
      return settled(rec, terminalAnswer(rec, false));
    }
    if (d.code === 'SESSION_GONE' || d.code === 'SESSION_CLOSING') {
      rec.state = STATES.REVOKED;
      rec.revoked_reason = 'requester_gone';
      return settled(rec, refusalAnswer('REPLY_DESTINATION_GONE', ids));
    }
    if (d.code === 'REPLY_DEADLINE_PASSED') {
      rec.state = STATES.EXPIRED;
      return settled(rec, refusalAnswer('REPLY_CAPABILITY_EXPIRED', ids));
    }
    if (d.bytes_written !== undefined && d.bytes_written !== 0) {
      // Not a zero-byte refusal: a write may have happened, so the record is terminal (ADR §4.3).
      rec.state = STATES.UNKNOWN;
      return settled(rec, terminalAnswer(rec, false));
    }
    const code = typeof d.code === 'string' && d.code.length > 0 ? d.code : 'DELIVERY_FAILED';
    const status = Number.isInteger(d.httpStatus) && d.httpStatus >= 400 && d.httpStatus <= 599 ? d.httpStatus : 503;
    const rearm = rec.attempts < L.maxAttempts;
    if (rearm) {
      rec.state = STATES.ISSUED;
      rec.body_sha256 = null;
    } else {
      rec.state = STATES.VOID;
    }
    return settled(rec, refusalAnswer(code, { ...ids, status, retryable: rearm }));
  }

  // §4 "delivery threw": in_flight -> unknown.
  function settleThrown(id) {
    const rec = records.get(id);
    if (!rec || rec.state !== STATES.IN_FLIGHT) return { ok: false };
    rec.state = STATES.UNKNOWN;
    return settled(rec, terminalAnswer(rec, false));
  }

  // §8 refusal budget: 8 lines per held id, then a shared bucket of 10 lines per 60 s (continuous refill on the
  // monotonic clock) for refusals with no held record. Anything over budget goes into one daemon-wide counter,
  // which the next emitted refusal line reports and resets (Root amendment Q5).
  function chargeRefusal(id) {
    const rec = typeof id === 'string' ? records.get(id) : undefined;
    let allowed;
    if (rec) {
      allowed = rec.refusal_lines < L.refusalLinesPerId;
      if (allowed) rec.refusal_lines += 1;
    } else {
      const m = monoNow();
      const elapsed = Math.max(0, m - anonLast);
      anonLast = m;
      anonTokens = Math.min(L.anonRefusalLines, anonTokens + (elapsed * L.anonRefusalLines) / L.anonRefusalWindowMs);
      allowed = anonTokens >= 1;
      if (allowed) anonTokens -= 1;
    }
    if (!allowed) { suppressed += 1; return { emit: false, suppressed_count: 0 }; }
    const count = suppressed;
    suppressed = 0;
    return { emit: true, suppressed_count: count };
  }

  function startSweeper({ isInstanceLive } = {}) {
    if (sweeper) return stopSweeper;
    const handle = timers.setInterval(() => {
      try { sweep({ isInstanceLive }); } catch { /* a throwing predicate must not crash the daemon; next tick retries */ }
    }, L.sweepIntervalMs);
    if (handle && typeof handle.unref === 'function') handle.unref();
    sweeper = handle;
    return stopSweeper;
  }

  function stopSweeper() {
    if (!sweeper) return;
    timers.clearInterval(sweeper);
    sweeper = null;
  }

  return {
    limits: L,
    daemonInstanceId,
    daemonStartedAt,
    deadlineRefusal,
    capacityRefusal,
    mint,
    publicView,
    resolve,
    checkState,
    supersede,
    revoke,
    begin,
    settle,
    settleThrown,
    chargeRefusal,
    sweep,
    startSweeper,
    stopSweeper,
    get: (id) => snapshot(records.get(id)),
    size: () => records.size
  };
}

module.exports = {
  CAPABILITY, RESULT_SCHEMA, SENDER_PROOF, TOKEN_RE, LIMITS, STATES, ERROR_STATUS,
  SUBMIT_QUEUE_TIMEOUT_MS, ACCEPT_MARGIN_MS, REPLY_PREFIX_MAX_BYTES, REPLY_BODY_MAX_BYTES, REQUEST_MAX_BYTES,
  createReplyCapabilityStore, parseToken, validReplyPrefix, replyCapabilityTrailer, buildResult, refusalAnswer,
  replyDeliverySupported, BRIDGE_REPLY_GUARD_CAPABILITY, bodySha256: sha256Hex
};
