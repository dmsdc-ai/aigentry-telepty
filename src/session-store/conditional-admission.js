'use strict';

// ---------------------------------------------------------------------------
// T0 — conditional admission before orchestrator U1 (task 1170 / release 1171)
// ---------------------------------------------------------------------------
//
// One telepty unit: a host-authenticated, principal-bound inject to ONE pinned wrapped owner.
// Everything in this file is about refusing to deliver unless the destination is still exactly
// the destination that was bound, and about recording that refusal or that emission honestly.
//
// What this file deliberately is NOT:
//   - it is not an orchestrator, a worker sender, a launcher or a migration (contract ¶1);
//   - it does not decide that anything COMPLETED. Daemon acceptance, adapter emission, physical
//     PTY write, consumption and semantic ACK are five independent facts (¶44), and the only one
//     this module can ever observe is the second.
//
// The module is pure logic + a fail-closed durable ledger. It holds no socket, starts nothing,
// and takes its file I/O from ./persistence so the store stays in the existing session-store
// directory with the existing temp→fsync→rename→dir-fsync transaction (¶31).

const crypto = require('node:crypto');
const sessionPersistence = require('./persistence');

// ---------------------------------------------------------------------------
// ¶12 — types. Every one of these is a TOTAL predicate over `unknown`: a validator that throws
// on a hostile shape is a validator an attacker controls, so each returns false instead.
// ---------------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const EPOCH_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** `id` — ¶12. Note `typeof` first: `ID_RE.test(1)` would coerce, and ¶11 forbids coercion. */
function isId(v) { return typeof v === 'string' && ID_RE.test(v); }
/** `uuid` — lowercase UUIDv4 ONLY. An uppercase or v1 UUID is a different string and is refused. */
function isUuid(v) { return typeof v === 'string' && UUID_V4_RE.test(v); }
/** `hash` — 64 lowercase hex. */
function isHash(v) { return typeof v === 'string' && HASH_RE.test(v); }
/** `epoch` — nonempty base64url ≤128. */
function isEpoch(v) { return typeof v === 'string' && EPOCH_RE.test(v); }
/** `n` — positive safe integer. Rejects 0, negatives, floats, NaN, Infinity and numeric strings. */
function isPositiveInt(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}
/** `time` — n UTC milliseconds. Same shape as `n`; named separately because ¶12 names it. */
function isTime(v) { return isPositiveInt(v); }

/**
 * ¶21 — nonempty, well-formed UTF-8, ≤65536 BYTES (not characters).
 *
 * `isWellFormed` is what rejects a lone surrogate: JSON can carry "\ud800", `Buffer.byteLength`
 * will happily size it, and the bytes that reach the PTY would then be the replacement character
 * — i.e. NOT the bytes the caller hashed. A payload whose hash cannot be reproduced from the
 * payload is exactly what ¶21's "hash recomputed over exact prompt bytes" exists to prevent.
 */
const MAX_PROMPT_BYTES = 65536;
function isWellFormedPrompt(v) {
  if (typeof v !== 'string' || v.length === 0) return false;
  // Node 20 has String.prototype.isWellFormed; the manual scan is the fallback, not a shortcut.
  if (typeof v.isWellFormed === 'function') {
    if (!v.isWellFormed()) return false;
  } else if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/.test(v)) {
    return false;
  }
  const bytes = Buffer.byteLength(v, 'utf8');
  return bytes > 0 && bytes <= MAX_PROMPT_BYTES;
}

// ---------------------------------------------------------------------------
// ¶11 — canonical JSON.
// ---------------------------------------------------------------------------
//
// "Canonical compact UTF-8, fixed key order as written, exact keys, no duplicates/unknowns/
// coercion." Two halves, and they are enforced in two different places on purpose:
//
//   ORDER is produced, never sorted — each parser below rebuilds its object with the keys written
//   literally in contract order, and JSON.stringify preserves insertion order for string keys. A
//   sort would be a different canonical form than the one the contract spells out.
//
//   DUPLICATES cannot be seen after JSON.parse (last-wins, silently), so they are rejected on the
//   RAW TEXT by hasDuplicateKeys below. That is why every entry point into this module takes the
//   raw bytes where it can get them.

/** Canonical serialization of an already-canonical object: compact, no reordering. */
function canonicalJson(value) {
  return JSON.stringify(value);
}

// Compare bytes against the schema-rebuilt value. This also rejects whitespace,
// reordered/duplicate keys, alternate escapes/numbers, BOMs and invalid UTF-8.
function isCanonicalRequestBytes(raw, value) {
  return Buffer.isBuffer(raw) && raw.equals(Buffer.from(canonicalJson(value), 'utf8'));
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** Canonical digest of a canonical object — the ¶24 "entire canonical request digest". */
function canonicalDigest(value) {
  return sha256Hex(Buffer.from(canonicalJson(value), 'utf8'));
}

/**
 * Duplicate-key detection over raw JSON text. A minimal scanner rather than a parser: it walks
 * strings (honouring escapes) so a `"` or `{` INSIDE a value can never be mistaken for structure,
 * tracks object depth, and collects the key set per depth.
 *
 * Returns true when any object in the document names the same key twice. Unparseable input
 * returns false — it is not this function's job to decide that, and JSON.parse will refuse it a
 * moment later with a better error.
 */
function hasDuplicateKeys(text) {
  if (typeof text !== 'string') return false;
  const stack = [];
  let i = 0;
  let expectKey = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      let raw = '';
      while (j < text.length) {
        if (text[j] === '\\') { raw += text[j] + (text[j + 1] || ''); j += 2; continue; }
        if (text[j] === '"') break;
        raw += text[j];
        j += 1;
      }
      if (expectKey && stack.length > 0) {
        const seen = stack[stack.length - 1];
        if (seen !== null) {
          if (seen.has(raw)) return true;
          seen.add(raw);
        }
        expectKey = false;
      }
      i = j + 1;
      continue;
    }
    if (ch === '{') { stack.push(new Set()); expectKey = true; i += 1; continue; }
    if (ch === '[') { stack.push(null); expectKey = false; i += 1; continue; }
    if (ch === '}' || ch === ']') { stack.pop(); expectKey = false; i += 1; continue; }
    if (ch === ',') { expectKey = stack.length > 0 && stack[stack.length - 1] !== null; i += 1; continue; }
    i += 1;
  }
  return false;
}

/**
 * Exact-shape parser. `spec` is an ORDERED list of [key, predicate] pairs; the returned object is
 * rebuilt in that order, so the result is canonical by construction.
 *
 * Refuses: a non-object, an array, a missing key, a failing key, and ANY key not in the spec.
 * "No unknowns" is a security property here, not tidiness — an ignored extra key is how a future
 * flag (a `force`, a `ref`, a `no_enter`) gets smuggled into the closed branch ¶22 forbids.
 */
function parseExact(value, spec) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'not_an_object' };
  }
  const allowed = new Set(spec.map(([key]) => key));
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return { ok: false, reason: `unknown_key:${key}` };
  }
  const out = {};
  for (const [key, predicate] of spec) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      return { ok: false, reason: `missing_key:${key}` };
    }
    const raw = value[key];
    if (!predicate(raw)) return { ok: false, reason: `invalid_value:${key}` };
    out[key] = raw;
  }
  return { ok: true, value: out };
}

/** Literal `1` — the version discriminator. Not `"1"`, not `1.0`: ¶11 forbids coercion. */
function isVersion1(v) { return v === 1; }

// ---------------------------------------------------------------------------
// ¶13 — identity shapes. Key order below is the contract's order, verbatim.
// ---------------------------------------------------------------------------

const PRINCIPAL_SPEC = [
  ['sid', isId],
  ['epoch', isEpoch],
  ['generation', isPositiveInt],
];

const TARGET_SPEC = [
  ['sid', isId],
  ['session_epoch', isEpoch],
  ['credential_generation', isPositiveInt],
  ['delivery_generation', isUuid],
];

const KEY_SPEC = [
  ['task', isId],
  ['sid', isId],
  ['attempt', isUuid],
  ['operation_id', isId],
  ['revision', isPositiveInt],
];

function parsePrincipal(value) { return parseExact(value, PRINCIPAL_SPEC); }
function parseTarget(value) { return parseExact(value, TARGET_SPEC); }
function parseKey(value) { return parseExact(value, KEY_SPEC); }

/** Canonicalize a principal resolved from a bearer (¶9: never from body.from). */
function principalFromCredential(verified) {
  if (!verified) return null;
  const parsed = parsePrincipal({
    sid: verified.sid,
    epoch: verified.epoch,
    generation: verified.generation,
  });
  return parsed.ok ? parsed.value : null;
}

function principalEquals(a, b) {
  if (!a || !b) return false;
  return a.sid === b.sid && a.epoch === b.epoch && a.generation === b.generation;
}

function targetEquals(a, b) {
  if (!a || !b) return false;
  return a.sid === b.sid
    && a.session_epoch === b.session_epoch
    && a.credential_generation === b.credential_generation
    && a.delivery_generation === b.delivery_generation;
}

function keyEquals(a, b) {
  if (!a || !b) return false;
  return a.task === b.task && a.sid === b.sid && a.attempt === b.attempt
    && a.operation_id === b.operation_id && a.revision === b.revision;
}

// ---------------------------------------------------------------------------
// ¶14 — delivery_generation.
// ---------------------------------------------------------------------------
//
// A NON-SECRET pin discriminator, minted fresh on every event that makes the destination a
// different destination: owner claim, reclaim, readoption, a registration mutation that moves the
// credential, rename, restore. It is the field that makes "same sid, same epoch" insufficient —
// #815's epoch answers WHICH INSTANCE, and this answers WHICH OWNERSHIP OF THAT INSTANCE, which
// is the distinction a same-epoch owner replacement (AC2) turns on.
//
// It is a UUIDv4 and never a counter, because a counter invites the "≥ last seen" comparison, and
// pin validity is equality or nothing.
function mintDeliveryGeneration() {
  return crypto.randomUUID();
}

/**
 * ¶14 second sentence — "Never reuse credentialGeneration=1 as an owner generation."
 *
 * The live session record carries `credentialGeneration`, which is 1 for every session that has
 * never reissued. Using it as the owner discriminator would make every first-generation session
 * on the host interchangeable. This predicate is what a caller asks before treating a session's
 * own generation as a pin input; it exists so the mistake has a name instead of being an absence.
 */
function isUsableOwnerGeneration(generation) {
  return isPositiveInt(generation) && generation !== 1;
}

/**
 * Mint onto a live session record and return the new value. Single writer for the field, so
 * "invalidate before changing destination state" (¶14) is one call at each mutation site rather
 * than an assignment each site has to remember to make.
 */
function rotateDeliveryGeneration(session) {
  if (!session) return null;
  session.deliveryGeneration = mintDeliveryGeneration();
  return session.deliveryGeneration;
}

/**
 * Build E for a live session, or return the named reason it has none.
 *
 * ¶8 — supported target is WRAPPED with a currently bearer-proved open owner. Each refusal below
 * is a separate reason rather than one boolean because the GET route reports them differently:
 * an unsupported type is permanent, an unproved owner is a race the caller can lose and retry.
 */
function describeConditionalTarget(sid, session, deps = {}) {
  const isOpen = deps.isOpenWebSocket || ((ws) => Boolean(ws && ws.readyState === 1));
  if (!session) return { ok: false, code: REFUSAL.TARGET_NOT_FOUND, reason: 'session_not_found' };
  if (session.type !== 'wrapped') {
    return { ok: false, code: REFUSAL.UNSUPPORTED_TARGET, reason: `unsupported_type:${session.type || 'unknown'}` };
  }
  if (!isOpen(session.ownerWs)) {
    return { ok: false, code: REFUSAL.UNBOUND_TARGET, reason: 'owner_socket_not_open' };
  }
  // ¶8/¶15 — PROVED, not merely present. `sessionEpochProved` is written only at a verified owner
  // claim (websocket.js); `sessionEpoch` alone is minted by register and restored off disk, and
  // treating it as proof is the #815 substitution.
  if (!session.sessionEpoch || session.sessionEpochProved !== session.sessionEpoch) {
    return { ok: false, code: REFUSAL.UNBOUND_TARGET, reason: 'no_proved_owner_bearer' };
  }
  if (!session.deliveryGeneration) {
    return { ok: false, code: REFUSAL.UNBOUND_TARGET, reason: 'no_delivery_generation' };
  }
  const parsed = parseTarget({
    sid,
    session_epoch: session.sessionEpoch,
    credential_generation: Number(session.credentialGeneration) || 1,
    delivery_generation: session.deliveryGeneration,
  });
  if (!parsed.ok) {
    return { ok: false, code: REFUSAL.UNSUPPORTED_TARGET, reason: `target_shape:${parsed.reason}` };
  }
  return { ok: true, target: parsed.value };
}

// ---------------------------------------------------------------------------
// ¶29 — refusals.
// ---------------------------------------------------------------------------

const REFUSAL = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  PRINCIPAL_REQUIRED: 'PRINCIPAL_REQUIRED',
  PRINCIPAL_MISMATCH: 'PRINCIPAL_MISMATCH',
  POLICY_DENIED: 'POLICY_DENIED',
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  STALE_TARGET: 'STALE_TARGET',
  CONFLICT: 'CONFLICT',
  UNBOUND_TARGET: 'UNBOUND_TARGET',
  UNSUPPORTED_TARGET: 'UNSUPPORTED_TARGET',
  EXPIRED: 'EXPIRED',
  STORE_UNAVAILABLE: 'STORE_UNAVAILABLE',
};

const REFUSAL_STATUS = {
  INVALID_REQUEST: 400,
  PRINCIPAL_REQUIRED: 401,
  PRINCIPAL_MISMATCH: 403,
  POLICY_DENIED: 403,
  TARGET_NOT_FOUND: 404,
  STALE_TARGET: 409,
  CONFLICT: 409,
  UNBOUND_TARGET: 409,
  UNSUPPORTED_TARGET: 409,
  EXPIRED: 410,
  STORE_UNAVAILABLE: 503,
};

function refusalStatus(code) {
  return REFUSAL_STATUS[code] || 400;
}

/** ¶29 — the error body is exactly {version,acceptance,code}. No detail field, by construction. */
function refusalBody(code) {
  return { version: 1, acceptance: 'refused', code };
}

/**
 * The refusal envelope every route returns. `reason` rides OUTSIDE the wire body: it is for the
 * daemon's own log, and putting it on the response would leak which of several checks failed to
 * a caller that failed the first one (¶16 "no secret returned").
 */
function refuse(code, reason) {
  return { ok: false, status: refusalStatus(code), code, reason: reason || null, body: refusalBody(code) };
}

// ---------------------------------------------------------------------------
// ¶25 — the admission record A, and its phases.
// ---------------------------------------------------------------------------

const PHASES = ['pending', 'claimed', 'emitted', 'held'];
const TRANSPORTS = ['queued', 'written', 'failed', 'unknown'];
const CONSUMPTIONS = ['unknown', 'queued', 'consumed'];

function isPhase(v) { return PHASES.includes(v); }
function isTransport(v) { return TRANSPORTS.includes(v); }

/**
 * Project the ¶25 keys, in ¶25 order, out of a stored record.
 *
 * The stored record carries auxiliary bookkeeping beside these (the body digest of ¶36, the
 * mailbox id, timestamps, an observation trail). Those are daemon-internal; A as the contract
 * writes it is this projection, and it is what gets digested and what the response is built from.
 */
function canonicalAdmission(record) {
  return {
    request: record.request,
    request_sha256: record.request_sha256,
    principal: record.principal,
    target: record.target,
    binding_id: record.binding_id,
    inject_id: record.inject_id,
    body_phase: record.body_phase,
    cr_phase: record.cr_phase,
    transport: record.transport,
    consumption: record.consumption,
    semantic_ack: record.semantic_ack,
  };
}

/**
 * ¶26 — the acceptance receipt.
 *
 * Note what is NOT here: no `success`, no `delivered`, no `completed`. ¶27 is explicit that
 * transport="written" means ADAPTER EMISSION ONLY, including the wrapped WS handoff, and that the
 * physical PTY write and the worker's consumption are separately unmeasured. A boolean would be
 * read as the thing this whole release exists to stop asserting.
 */
function acceptanceBody(record, duplicate) {
  return {
    version: 1,
    acceptance: 'accepted',
    duplicate: Boolean(duplicate),
    msg_id: record.request.msg_id,
    inject_id: record.inject_id,
    transport: record.transport,
    consumption: record.consumption,
    semantic_ack: record.semantic_ack,
  };
}

/** ¶24 — durable primary key (P, msg_id). Hashed so the ledger key is opaque and fixed-width. */
function admissionPrimaryKey(principal, msgId) {
  return sha256Hex(Buffer.from(canonicalJson([principal, msgId]), 'utf8'));
}

// ---------------------------------------------------------------------------
// ¶17/¶21 — wire request shapes.
// ---------------------------------------------------------------------------

const BINDING_REQUEST_SPEC = [
  ['version', isVersion1],
  ['target', (v) => parseTarget(v).ok],
  ['task', isId],
  ['attempt', isUuid],
  ['manifest_sha256', isHash],
  ['expires_at', isTime],
];

const INJECT_REQUEST_SPEC = [
  ['version', isVersion1],
  ['binding_id', isUuid],
  ['key', (v) => parseKey(v).ok],
  ['msg_id', isUuid],
  ['payload_sha256', isHash],
  ['prompt', isWellFormedPrompt],
];

const MAX_BINDING_LIFETIME_MS = 24 * 60 * 60 * 1000;

const FIRST_INITIALIZATION_GUIDANCE = 'For a verified new store only, run '
  + 'telepty conditional-store-init --new-store from an authenticated controller session. '
  + 'If initialized state was lost, preserve the remaining files and recover the matching '
  + 'ledger and .initialized marker from a verified backup; first initialization is not recovery. '
  + 'No automatic reset, migration or --force recovery is available.';

function parseInitializationRequest(value) {
  return parseExact(value, [['version', isVersion1], ['intent', v => v === 'new-store']]);
}

/**
 * ¶17 — parse a binding request and rebuild it canonically (nested `target` too, so a caller that
 * wrote E's keys in a different order cannot produce a different digest for the same binding).
 */
function parseBindingRequest(value) {
  const outer = parseExact(value, BINDING_REQUEST_SPEC);
  if (!outer.ok) return outer;
  const target = parseTarget(value.target);
  if (!target.ok) return { ok: false, reason: `target:${target.reason}` };
  return {
    ok: true,
    value: {
      version: 1,
      target: target.value,
      task: outer.value.task,
      attempt: outer.value.attempt,
      manifest_sha256: outer.value.manifest_sha256,
      expires_at: outer.value.expires_at,
    },
  };
}

/** ¶17 — expiry window. Both ends matter: a past expiry is dead on arrival, a far-future one is
 *  an unbounded pin. Equality with `now` is NOT future. */
function checkBindingExpiry(expiresAt, nowMs) {
  if (!isTime(expiresAt)) return 'expires_at_invalid';
  if (expiresAt <= nowMs) return 'expires_at_not_future';
  if (expiresAt - nowMs > MAX_BINDING_LIFETIME_MS) return 'expires_at_beyond_24h';
  return null;
}

/** ¶21 — parse a conditional inject request, rebuilding `key` canonically for the same reason. */
function parseInjectRequest(value) {
  const outer = parseExact(value, INJECT_REQUEST_SPEC);
  if (!outer.ok) return outer;
  const key = parseKey(value.key);
  if (!key.ok) return { ok: false, reason: `key:${key.reason}` };
  return {
    ok: true,
    value: {
      version: 1,
      binding_id: outer.value.binding_id,
      key: key.value,
      msg_id: outer.value.msg_id,
      payload_sha256: outer.value.payload_sha256,
      prompt: outer.value.prompt,
    },
  };
}

/**
 * ¶22 — is this request FOR the conditional branch?
 *
 * Selected by `binding_id` or `version` presence, and the selection happens on the RAW body
 * before any validation. That ordering is the point: a malformed partial envelope — `{version:1}`
 * with nothing else, a `binding_id` and no key — must be REFUSED by this branch, never fall
 * through to the legacy `prompt`-only path where none of these checks exist. Falling through is
 * how a closed branch becomes an open one.
 */
function isConditionalInjectBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  return Object.prototype.hasOwnProperty.call(body, 'binding_id')
    || Object.prototype.hasOwnProperty.call(body, 'version');
}

// ---------------------------------------------------------------------------
// ¶31–33 — the scoped ledger.
// ---------------------------------------------------------------------------
//
// Fail-closed, and the failure modes are distinguishable by construction:
//
//   unavailable — could not read, corrupt, unsupported schema, marker/store mismatch, fsync
//                 error. Scoped admission AND scoped delivery are disabled. Never reset, never
//                 migrated (¶32).
//   empty       — read fine, nothing admitted yet.
//
// The two must not look alike: one means "nothing was tracked", the other means "do not trust
// what you are about to read". This is the same distinction persistence.js already draws for the
// #60 observation ledger, and it is drawn the same way here on purpose.

class ConditionalAdmissionStore {
  /**
   * @param {Object} options
   * @param {string} [options.path] - ledger path; defaults to the session-store directory.
   * @param {Function} [options.now] - clock seam (¶49 controlled clock).
   * @param {Object} [options.persistence] - file I/O seam; defaults to ./persistence.
   */
  constructor(options = {}) {
    this.persistence = options.persistence || sessionPersistence;
    this.path = options.path || this.persistence.defaultConditionalAdmissionsPath();
    this.now = options.now || (() => Date.now());
    this.ledger = null;
    // `unavailable` until initialize() proves otherwise. A store that has not been read cannot
    // admit anything, so the pre-initialization state is the refusing one.
    this.state = 'unavailable';
    this.reason = 'not_initialized';
  }

  /**
   * ¶33 — read the store and reconcile it with its persisted initialization marker.
   *
   * This is a load-only operation. The persisted pair must already exist and match; absence
   * never authorizes creation. First creation is a separate authenticated operator action.
   */
  initialize() {
    // A failed store cannot be reset by another initialize() in this process.
    if (this.state === 'unavailable' && this.reason !== 'not_initialized') {
      return { ok: false, reason: this.reason };
    }
    const loaded = this.persistence.loadConditionalAdmissions(this.path);
    if (!loaded.ok) {
      this.state = 'unavailable';
      this.reason = loaded.detail ? `${loaded.reason}:${loaded.detail}` : loaded.reason;
      return { ok: false, reason: this.reason };
    }
    const ledger = loaded.ledger;
    if (this.ledger && (!ledger.marker
      || ledger.marker.marker_id !== this.ledger.marker.marker_id
      || ['fenced_sessions', 'bindings', 'admissions', 'tombstones'].some(section =>
        Object.keys(this.ledger[section]).some(key =>
          !Object.prototype.hasOwnProperty.call(ledger[section], key))))) {
      this.state = 'unavailable';
      this.reason = 'initialized_store_history_missing';
      return { ok: false, reason: this.reason };
    }
    if (!ledger.marker || !isUuid(ledger.marker.marker_id)) {
      this.state = 'unavailable';
      this.reason = 'marker_malformed';
      return { ok: false, reason: this.reason };
    }
    this.ledger = ledger;
    this.state = 'ready';
    this.reason = null;
    return { ok: true, marker_id: ledger.marker.marker_id };
  }

  // Called only by the host-authenticated controller route after its explicit intent check.
  // A known ledger or any failure other than pristine absence can never become a new store.
  initializeNewStore() {
    if (this.available()) return refuse(REFUSAL.CONFLICT, 'store_already_initialized');
    if (this.reason === 'not_initialized') this.initialize();
    if (this.ledger || this.reason !== 'conditional_store_not_initialized') {
      return refuse(REFUSAL.STORE_UNAVAILABLE, this.reason);
    }
    const ledger = this.persistence.emptyConditionalAdmissions();
    ledger.marker = {
      marker_id: crypto.randomUUID(),
      initialized_at: new Date(this.now()).toISOString(),
    };
    const saved = this.persistence.initializeConditionalAdmissions(ledger, this.path);
    if (!saved.ok) {
      this.reason = `first_initialization_failed:${saved.reason}`;
      return refuse(REFUSAL.STORE_UNAVAILABLE, this.reason);
    }
    // Read back the durable pair before enabling any writes. No old receipts are resumed.
    this.reason = 'not_initialized';
    const loaded = this.initialize();
    if (!loaded.ok) return refuse(REFUSAL.STORE_UNAVAILABLE, loaded.reason);
    return { ok: true, marker_id: loaded.marker_id };
  }

  available() { return this.state === 'ready' && this.ledger !== null; }

  /**
   * Commit the in-memory ledger durably. EVERY caller checks the result — ¶31 "propagate every
   * error", and a failed commit permanently marks the store unavailable rather than leaving RAM
   * ahead of disk. Memory that is ahead of the durable record is precisely how a restart
   * resurrects an admission nobody can answer for.
   */
  commit() {
    if (!this.available()) return { ok: false, reason: this.reason || 'store_unavailable' };
    const saved = this.persistence.saveConditionalAdmissions(this.ledger, this.path);
    if (!saved.ok) {
      this.state = 'unavailable';
      this.reason = `commit_failed:${saved.reason}`;
      return { ok: false, reason: this.reason };
    }
    return { ok: true };
  }

  // --- ¶19 fencing -------------------------------------------------------
  //
  // PERMANENT, per session record, and durable. Once a session has been bound, no unbound daemon
  // write may reach it again — not an inject, not a /submit, not a fanout, not a bus broadcast,
  // not a WS viewer frame (¶39). "Permanently" is the contract's word and it is meant literally:
  // there is no unfence path in T0, because an unfence is a destination change that no principal
  // has authorized.

  isFenced(sid) {
    // Unknown history is not proof of never having been bound. All callers,
    // including delayed physical writes, must refuse while the store is down.
    if (!this.available()) return true;
    return Object.prototype.hasOwnProperty.call(this.ledger.fenced_sessions, sid);
  }

  fenceSession(sid, bindingId) {
    if (!this.available()) return { ok: false, reason: this.reason || 'store_unavailable' };
    if (!this.ledger.fenced_sessions[sid]) {
      this.ledger.fenced_sessions[sid] = {
        sid,
        first_binding_id: bindingId,
        fenced_at: new Date(this.now()).toISOString(),
      };
    }
    return { ok: true };
  }

  // --- ¶19/¶20 bindings --------------------------------------------------

  getBinding(bindingId) {
    if (!this.available()) return null;
    return this.ledger.bindings[bindingId] || null;
  }

  /**
   * ¶20 — idempotent create.
   *
   * Three outcomes, and the middle one is the one worth naming: an IDENTICAL principal + body
   * returns the SAME B with 200, so a controller that retried a lost response does not mint a
   * second pin for the same worker boundary. A CONFLICTING one on the same owner refuses — it is
   * a different intent wearing the same destination, and ¶20 forbids silently renewing or
   * rebinding.
   */
  createBinding({ principal, request, nowMs }) {
    if (!this.available()) return refuse(REFUSAL.STORE_UNAVAILABLE, this.reason);
    const requestDigest = canonicalDigest(request);
    for (const existing of Object.values(this.ledger.bindings)) {
      if (existing.request_sha256 === requestDigest && principalEquals(existing.binding.principal, principal)) {
        // Exact duplicate — same pin, same intent, same principal.
        return { ok: true, status: 200, duplicate: true, binding: existing.binding };
      }
      // Same owner (same E), different intent or different principal → CONFLICT. Checked against
      // the TARGET rather than the sid: a later owner generation is a different destination and
      // gets its own binding, which is exactly what ¶14's pin discriminator is for.
      if (targetEquals(existing.binding.target, request.target)) {
        if (!principalEquals(existing.binding.principal, principal)) {
          return refuse(REFUSAL.PRINCIPAL_MISMATCH, 'binding_held_by_other_principal');
        }
        if (existing.binding.task !== request.task
          || existing.binding.attempt !== request.attempt
          || existing.binding.manifest_sha256 !== request.manifest_sha256
          || existing.binding.expires_at !== request.expires_at) {
          return refuse(REFUSAL.CONFLICT, 'binding_conflict_on_owner');
        }
      }
    }
    // ¶19 key order, verbatim.
    const binding = {
      binding_id: crypto.randomUUID(),
      principal,
      target: request.target,
      task: request.task,
      attempt: request.attempt,
      manifest_sha256: request.manifest_sha256,
      expires_at: request.expires_at,
    };
    this.ledger.bindings[binding.binding_id] = {
      binding,
      request_sha256: requestDigest,
      created_at: new Date(nowMs).toISOString(),
    };
    const fenced = this.fenceSession(request.target.sid, binding.binding_id);
    if (!fenced.ok) return refuse(REFUSAL.STORE_UNAVAILABLE, fenced.reason);
    const committed = this.commit();
    if (!committed.ok) {
      // Roll the in-memory state back so a failed commit leaves no phantom binding that this
      // process would honour and the next process would not.
      delete this.ledger.bindings[binding.binding_id];
      return refuse(REFUSAL.STORE_UNAVAILABLE, committed.reason);
    }
    return { ok: true, status: 201, duplicate: false, binding };
  }

  // --- ¶24/¶25 admissions ------------------------------------------------

  getAdmissionByKey(primaryKey) {
    if (!this.available()) return null;
    return this.ledger.admissions[primaryKey] || null;
  }

  getAdmissionByInjectId(injectId) {
    if (!this.available()) return null;
    for (const record of Object.values(this.ledger.admissions)) {
      if (record.inject_id === injectId) return record;
    }
    return null;
  }

  /** ¶36 — the mailbox id → A reverse lookup. Format is fixed by ¶35. */
  getAdmissionByMailboxId(mailboxMsgId) {
    if (!this.available()) return null;
    const match = /^conditional:([0-9a-f-]{36}):body$/.exec(String(mailboxMsgId || ''));
    if (!match) return null;
    const record = this.getAdmissionByInjectId(match[1]);
    // A forged id that happens to name a real inject_id still has to match the record's OWN
    // mailbox id — ¶57: "Forged conditional mailbox id without matching A never writes."
    if (!record || record.mailbox_msg_id !== mailboxMsgId) return null;
    return record;
  }

  /**
   * ¶25 — commit A BEFORE any enqueue or write, and ¶24 — (P, msg_id) is the durable primary key.
   *
   * The duplicate rule is the sharp one. Same msg_id + byte-identical canonical request → the
   * SAME record, returned as a duplicate with zero new enqueue/write/CR (¶28). Same msg_id + ANY
   * change to target/K/body → CONFLICT, and specifically NOT a fresh id (¶24). Minting a new id
   * for a changed body under a reserved msg_id is how a caller gets two deliveries while
   * believing it made one request.
   */
  admit({ principal, target, binding, request, nowMs }) {
    if (!this.available()) return refuse(REFUSAL.STORE_UNAVAILABLE, this.reason);
    const primaryKey = admissionPrimaryKey(principal, request.msg_id);
    const requestDigest = canonicalDigest(request);

    const existing = this.ledger.admissions[primaryKey];
    if (existing) {
      if (existing.request_sha256 !== requestDigest) {
        return refuse(REFUSAL.CONFLICT, 'msg_id_reused_with_changed_request');
      }
      // ¶28 — the same receipt, even after target replacement, expiry or restart. Deliberately
      // NOT re-validated against the CURRENT owner: a receipt describes what was admitted then,
      // and retargeting it to whoever holds the sid now is the replay this contract forbids.
      return { ok: true, status: 200, duplicate: true, record: existing };
    }
    // ¶33 — a tombstone outlives its record. A msg_id that was ever used cannot be reused, even
    // if the admission itself were ever pruned by a future retention policy.
    const tombstone = this.ledger.tombstones[primaryKey];
    if (tombstone && tombstone.request_sha256 !== requestDigest) {
      return refuse(REFUSAL.CONFLICT, 'msg_id_tombstoned_with_changed_request');
    }

    const record = {
      // ¶25 core, in order.
      request,
      request_sha256: requestDigest,
      principal,
      target,
      binding_id: binding.binding_id,
      inject_id: crypto.randomUUID(),
      body_phase: 'pending',
      cr_phase: 'pending',
      transport: 'unknown',
      consumption: 'unknown',
      semantic_ack: 'pending',
      // Auxiliary, daemon-internal. Never part of the canonical A projection.
      primary_key: primaryKey,
      key: request.key,
      mailbox_msg_id: null,
      body_bytes_sha256: null,
      created_at: new Date(nowMs).toISOString(),
      observations: [],
    };
    record.mailbox_msg_id = `conditional:${record.inject_id}:body`;

    this.ledger.admissions[primaryKey] = record;
    this.ledger.tombstones[primaryKey] = {
      primary_key: primaryKey,
      msg_id: request.msg_id,
      inject_id: record.inject_id,
      request_sha256: requestDigest,
      created_at: record.created_at,
    };
    const committed = this.commit();
    if (!committed.ok) {
      delete this.ledger.admissions[primaryKey];
      delete this.ledger.tombstones[primaryKey];
      return refuse(REFUSAL.STORE_UNAVAILABLE, committed.reason);
    }
    return { ok: true, status: 202, duplicate: false, record };
  }

  /**
   * Per-phase commit. Synchronous by contract (¶34): the caller must not await between the check
   * that justified the transition and this call.
   *
   * `patch` carries only the fields a phase transition may move. A failed durable write reverts
   * the in-memory record, so a phase this daemon believes in is always one the disk believes in.
   */
  commitPhase(record, patch, observation) {
    if (!this.available()) return { ok: false, reason: this.reason || 'store_unavailable' };
    const before = {};
    for (const field of Object.keys(patch)) before[field] = record[field];
    Object.assign(record, patch);
    if (observation) {
      record.observations.push({ ...observation, at: new Date(this.now()).toISOString() });
      // Bounded, same rationale as the #60 ledger's cap: a long-lived record must not grow the
      // file without limit. A flat cap, not a retention policy.
      while (record.observations.length > MAX_OBSERVATIONS_PER_ADMISSION) record.observations.shift();
    }
    const committed = this.commit();
    if (!committed.ok) {
      Object.assign(record, before);
      return { ok: false, reason: committed.reason };
    }
    return { ok: true };
  }
}

const MAX_OBSERVATIONS_PER_ADMISSION = 50;

// ---------------------------------------------------------------------------
// ¶23/¶37 — the destination recheck.
// ---------------------------------------------------------------------------

/**
 * THE check. Called before admission, and again before EVERY scoped body or CR, and again
 * immediately before the captured ownerWs.send — ¶37 "Any await requires a fresh check".
 *
 * It re-resolves the session from the live map rather than trusting a captured reference, because
 * a captured reference is exactly what survives a delete/recreate while naming a record nobody
 * reads (the #732 orphan shape). Everything it compares is an identity, not a liveness heuristic:
 * PID, socket openness and "the sid still exists" are all true of a successor.
 *
 * Returns {ok:true, session, ownerWs} or a refusal. The ownerWs it returns is the socket the
 * caller must capture and send on — resolving it again afterwards would reopen the gap this
 * closes.
 */
function recheckDestination({ sessions, record, binding, nowMs, verifyPrincipal, isOpenWebSocket }) {
  const isOpen = isOpenWebSocket || ((ws) => Boolean(ws && ws.readyState === 1));
  const sid = record.target.sid;

  // ¶23 — binding expiry first. An expired pin is not a stale target; it is a pin that no longer
  // authorizes anything, and ¶20 forbids silently renewing it.
  if (!binding || binding.expires_at <= nowMs) {
    return refuse(REFUSAL.EXPIRED, 'binding_expired');
  }
  if (binding.binding_id !== record.binding_id) {
    return refuse(REFUSAL.CONFLICT, 'binding_id_mismatch');
  }

  const session = sessions[sid];
  if (!session) return refuse(REFUSAL.TARGET_NOT_FOUND, 'session_gone');

  // ¶23 — the principal must STILL verify. A revoked or reissued credential invalidates the lane
  // mid-flight; carrying on because it verified at admission is what makes a revocation advisory.
  if (typeof verifyPrincipal === 'function') {
    const stillValid = verifyPrincipal(record.principal);
    if (!stillValid) return refuse(REFUSAL.PRINCIPAL_MISMATCH, 'principal_no_longer_verifies');
  }

  // ¶23 — E must match the CURRENT owner, every field. `delivery_generation` is what catches the
  // same-epoch owner replacement of AC2: sid, epoch and credential generation are all unchanged
  // across it, and the socket is open — the pin discriminator is the only thing that moved.
  const current = describeConditionalTarget(sid, session, { isOpenWebSocket: isOpen });
  if (!current.ok) return refuse(current.code, current.reason);
  if (!targetEquals(current.target, record.target)) {
    return refuse(REFUSAL.STALE_TARGET, 'owner_replaced');
  }

  const ownerWs = session.ownerWs;
  if (!isOpen(ownerWs)) return refuse(REFUSAL.UNBOUND_TARGET, 'owner_socket_closed');
  return { ok: true, session, ownerWs };
}

/**
 * ¶34/¶38 — the guarded synchronous writer.
 *
 * "No await between checking E/P/B and committing claim, or between final destination recheck and
 * invoking captured ownerWs.send." This function is the shape that makes that inspectable: recheck
 * → commit claimed → send on the CAPTURED socket → commit emitted, with no `await` anywhere in the
 * body. It is a plain synchronous function precisely so that the absence of an await is a property
 * of the code rather than a promise a comment makes.
 *
 * ¶41 — a missing post-send commit is UNKNOWN, never a retry. If `send` throws, or if the
 * post-send commit fails, the phase becomes `held` with transport `unknown`: the daemon cannot
 * tell whether the bytes left, and guessing in either direction is a lie. There is no
 * direct-fallback path out of this function, by design.
 */
function claimAndSend({ store, record, phase, sessions, binding, nowMs, verifyPrincipal, isOpenWebSocket, payload, frame }) {
  const phaseField = phase === 'cr' ? 'cr_phase' : 'body_phase';

  // ¶37 — pending may commit claimed then emit; anything else has already had its physical
  // attempt and ¶41 prohibits another one.
  if (record[phaseField] !== 'pending') {
    return { ok: false, code: REFUSAL.CONFLICT, reason: `phase_not_pending:${record[phaseField]}` };
  }

  const check = recheckDestination({ sessions, record, binding, nowMs, verifyPrincipal, isOpenWebSocket });
  if (!check.ok) return { ok: false, code: check.code, reason: check.reason };
  const ownerWs = check.ownerWs;

  // --- no await from here to the send ---
  const claimed = store.commitPhase(record, { [phaseField]: 'claimed' }, { kind: `${phase}_claimed` });
  if (!claimed.ok) {
    return { ok: false, code: REFUSAL.STORE_UNAVAILABLE, reason: claimed.reason };
  }

  let sent = false;
  try {
    ownerWs.send(frame != null ? frame : JSON.stringify({ type: 'inject', data: payload }));
    sent = true;
  } catch (error) {
    // The send itself threw: nothing was handed to the adapter. `failed` is a MEASURED fact here,
    // unlike the unknown below, because the throw happened before any handoff.
    store.commitPhase(record, { [phaseField]: 'held', transport: 'failed' }, {
      kind: `${phase}_send_threw`, detail: String(error && error.message),
    });
    return { ok: false, code: REFUSAL.UNBOUND_TARGET, reason: 'owner_send_threw' };
  }

  const emitted = store.commitPhase(record, {
    [phaseField]: 'emitted',
    // ¶27 — "written" is ADAPTER EMISSION, including the wrapped WS handoff. Not a PTY write.
    transport: 'written',
  }, { kind: `${phase}_emitted` });
  if (!emitted.ok) {
    // ¶41 — claim-before-send plus a missing post-send commit is UNKNOWN. The bytes may well have
    // gone; the durable record cannot say. `held` + `unknown` is the honest pair, and no retry is
    // scheduled from here.
    record[phaseField] = 'held';
    record.transport = 'unknown';
    return { ok: false, code: REFUSAL.STORE_UNAVAILABLE, reason: 'post_send_commit_failed', sent, unknown: true };
  }
  return { ok: true, sent };
}

// ---------------------------------------------------------------------------
// ¶43 — restart.
// ---------------------------------------------------------------------------

/**
 * Restore receipts; send nothing.
 *
 * Every record that was mid-flight becomes `held` with transport `unknown` unless durable
 * evidence already proved otherwise. The in-memory queue did not survive, and a `pending` or
 * `claimed` phase across a restart is the definition of "we do not know" — ¶43. An `emitted`
 * phase IS durable evidence and keeps its transport.
 *
 * Pins are invalidated wholesale on restart: `delivery_generation` is minted per owner claim, and
 * no owner has claimed yet in this process, so every stored E names a generation that cannot
 * currently be matched. That is the correct outcome — the contract's "changed delivery_generation
 * invalidates pins" — and it is why this function never resends.
 */
function restoreAdmissions(store) {
  if (!store.available()) return { ok: false, reason: store.reason || 'store_unavailable' };
  const held = [];
  for (const record of Object.values(store.ledger.admissions)) {
    for (const field of ['body_phase', 'cr_phase']) {
      if (record[field] === 'pending' || record[field] === 'claimed') {
        record[field] = 'held';
        held.push({ inject_id: record.inject_id, field });
      }
    }
    if (record.transport === 'queued' || record.transport === 'unknown') {
      record.transport = 'unknown';
    }
    record.observations.push({
      kind: 'daemon_restart_observed',
      at: new Date(store.now()).toISOString(),
    });
    while (record.observations.length > MAX_OBSERVATIONS_PER_ADMISSION) record.observations.shift();
  }
  const committed = store.commit();
  if (!committed.ok) return { ok: false, reason: committed.reason };
  return { ok: true, held };
}

module.exports = {
  // ¶12 types
  ID_RE, UUID_V4_RE, HASH_RE, EPOCH_RE, MAX_PROMPT_BYTES,
  isId, isUuid, isHash, isEpoch, isPositiveInt, isTime, isVersion1, isWellFormedPrompt,
  // ¶11 canonical form
  canonicalJson, isCanonicalRequestBytes, canonicalDigest, sha256Hex, hasDuplicateKeys, parseExact,
  // ¶13 identities
  parsePrincipal, parseTarget, parseKey,
  principalFromCredential, principalEquals, targetEquals, keyEquals,
  // ¶14 pin discriminator
  mintDeliveryGeneration, rotateDeliveryGeneration, isUsableOwnerGeneration,
  describeConditionalTarget,
  // ¶17/¶21 wire shapes
  parseBindingRequest, parseInjectRequest, isConditionalInjectBody,
  parseInitializationRequest, FIRST_INITIALIZATION_GUIDANCE,
  checkBindingExpiry, MAX_BINDING_LIFETIME_MS,
  // ¶25/¶26 records and receipts
  PHASES, TRANSPORTS, CONSUMPTIONS, isPhase, isTransport,
  canonicalAdmission, acceptanceBody, admissionPrimaryKey,
  // ¶29 refusals
  REFUSAL, REFUSAL_STATUS, refusalStatus, refusalBody, refuse,
  // ¶31 store
  ConditionalAdmissionStore, MAX_OBSERVATIONS_PER_ADMISSION,
  // ¶34/¶37 the guarded paths
  recheckDestination, claimAndSend,
  // ¶43 restart
  restoreAdmissions,
};
