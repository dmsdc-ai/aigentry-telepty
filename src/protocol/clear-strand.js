'use strict';

// Task 1270 clear-strand-v1 — the CLOSED shapes and the PURE decisions of the operator clear.
//
// Frozen interface: CLEAR-INTERFACE-V1.md. This module is PURE in the same sense as
// src/protocol/bound-inject.js: no session, socket, store, clock, env or I/O, and therefore no way for it to
// have an effect. Both ends (the strict local `telepty clear-strand-v1` verb and
// POST /api/sessions/:id/clear-strand-v1) validate and build through here, so the wire shape cannot drift
// between them.
//
// What the clear IS: one synchronous in-memory deletion of ONE strand record for ONE exactly-named session
// instance, after a four-part identity pin and a loopback/host-token authority gate. What it is NOT: it never
// writes a byte, never sends a key, never touches a queue, a timer, a socket or a bridge frame, and it never
// observes the composer — `basis` is an operator CLAIM this daemon records and cannot check (CLEAR-DESIGN §2.1).
//
// Why a closed request object and a closed result object, as on the bound door: an old daemon ignores an
// unknown JSON field, so a body merely DECORATED with the identity fields would be accepted by a daemon that
// checked none of them. Admitting exactly six keys, and answering every refusal with the same 16-key object,
// is what makes the presence of this schema the proof that the pin was honoured.
//
// Dependencies are deliberately two: node:crypto for the timing-safe token comparison and the shipped
// inject-id predicate. Nothing from the routes, the session store or the session-delivery graph may be reached
// from here, and nothing here may reach a file, a clock or the environment.

const crypto = require('node:crypto');
const { validInjectId } = require('../diagnostics/correlation');

const REQUEST_SCHEMA = 'telepty.clear-strand/v1';
const RESULT_SCHEMA = 'telepty.clear-strand-result/v1';
// Exactly six keys, no more and no fewer (CLEAR-INTERFACE §3).
const REQUEST_KEYS = Object.freeze(['schema', 'from', 'expected_epoch', 'expected_owner_generation',
  'stranded_inject_id', 'basis']);
// TWO stages. There is deliberately no `outcome_unknown` on this door: the only effect is one synchronous
// in-memory deletion performed after every check, with no handoff and no remote party, so no state is ever
// unknown to the daemon. The one fallible step (the save) is reported in `persisted` instead.
const STAGES = Object.freeze(['refused', 'cleared']);
// The operator's asserted basis. Underscores, not hyphens; the argv value and the wire value are one string.
const BASES = Object.freeze(['composer_emptied_by_operator', 'child_replaced_observed']);
// The daemon's own observation about the child the stranded text was typed into. `unobservable` is the honest
// answer for a legacy bridge that announces no milestone, and for every answer given before step 4.
const CHILD_EVIDENCE = Object.freeze(['replaced', 'same_child', 'unobservable']);
// A CONSTANT on every answer, not a field a future receipt may quietly upgrade: the bridge keeps its own
// quarantine in a WeakSet of child objects this daemon cannot see (same convention as `consumption: 'unknown'`
// in telepty.bound-inject-result/v1).
const BRIDGE_STRAND = 'not_observable_by_daemon';
// The closed result key set, in the order CLEAR-INTERFACE §4 prints it.
const RESULT_KEYS = Object.freeze(['schema', 'stage', 'reason', 'session_id', 'session_epoch', 'owner_generation',
  'cleared_inject_id', 'cleared_strand_reason', 'cleared_strand_at', 'basis', 'child_evidence', 'bridge_strand',
  'persisted', 'persist_reason', 'pending_bootstrap_ops', 'body_custody']);

// The identity tokens are OPAQUE: the daemon compares them to its own current values as strings and never
// parses, normalises or interprets them. The bound door's rule, measured in BYTES, restated here rather than
// imported so this module keeps its two-dependency surface (bound-inject.js:35 is the same rule; a control
// character in an identity token is never legitimate and would travel into logs and frames).
const TOKEN_MAX_BYTES = 256;
// The raw request body bound of the /api/daemon/stop guard, scaled to this larger closed object.
//
// r2 erratum (review finding CSR-m4): 1100, not 512. §3 declares three 1..256-BYTE identity fields, and at
// that declared maximum the serialised request is 964 bytes — so with a 512-byte gate the upper half of every
// declared field range was unsendable, and the caller got 413 `clear_body_bytes` with no indication of WHICH
// field was too long. 1100 admits every field at its declared maximum in ESCAPE-FREE form (964 bytes measured,
// with the longer of the two basis literals; 136 bytes of headroom) while staying two orders of magnitude
// below express.json's 100 kB default, so it is still a tight smuggling bound: there is no payload on this
// door and nothing legitimate to put in the slack.
//
// The caveat, recorded rather than fixed (r5, review finding CSR2-m2): `boundedToken` bans control characters
// but admits `"` and `\`, and `JSON.stringify` doubles each of them, so a request whose fields are declared-
// legal can still serialise past 1100 and be refused 413 BEFORE the schema step — three fields of 256 quotes
// are 1732 bytes (measured). Making the whole declared range sendable would mean a 1732-byte bound, which is a
// deliberate decision and not a round number; Root's decision for this round is that the bound stays at 1100
// and the claim is stated accurately here instead.
const BODY_MAX_BYTES = 1100;
// r2 erratum (review finding CSR-m2), tightened in r5 (review finding CSR2-m1): step 1.3 is an EXACT
// media-type test. A prefix test admitted `application/jsonx`, and its safety then rested on an unstated
// coupling in another module — `express.json()` is installed with no `type` option
// (src/protocol/http-app.js:8), so its exact-match default never parses such a request, `principalRawBody` is
// never assigned and step 1.4 refuses it instead. That is a safe outcome for the wrong reason: widen
// `express.json`'s `type`, or add a raw-body middleware for all types, and `application/jsonx` would silently
// become a working content type on this door.
//
// The rule, verbatim: the lower-cased header value must be `application/json`, then optional HTTP OWS
// (SP/HTAB only — NOT JS `\s`, which also matches CR, LF, NBSP and the BOM), then either the end of the string
// or `;` and the parameters. So `application/json`, `application/json ` and `application/json; charset=utf-8`
// are the door's type, while `application/json bogus` and `application/json\tbogus` are 415: the r2 form was
// unanchored after the separator class, which admitted any remainder.
const JSON_MEDIA_TYPE_RE = /^application\/json[ \t]*(?:;|$)/;
const REASON_RE = /^[a-z0-9_]{1,64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
// Loopback SOCKET PEERS only (CLEAR-INTERFACE §5 step 1.1). Forwarded headers are never consulted anywhere in
// this module: a header cannot make a request local.
const LOOPBACK_V4_RE = /^127\.\d+\.\d+\.\d+$/;
const MAPPED_V4_RE = /^::ffff:(.+)$/i;

// EVERY reason code this unit can emit (CLEAR-INTERFACE §6), as an ALLOW-LIST. Not a normaliser: the bound
// module's r1 finding m2 showed that lowercasing and substituting separators satisfies the bounded-code pattern
// for almost any string, so an exception message would survive as its first 64 characters. Here an unlisted
// value degrades to the generic `refused` and nothing else travels.
const REASONS = Object.freeze(new Set([
  // transport authority and target shape (step 1, step 3)
  'clear_local_only', 'clear_origin_refused', 'clear_content_type', 'clear_body_bytes', 'clear_auth_required',
  'clear_target_invalid',
  // request shape (validateClearRequest, step 2)
  'request_not_object', 'request_keys', 'request_schema', 'from_invalid', 'expected_epoch_invalid',
  'expected_owner_generation_invalid', 'stranded_inject_id_invalid', 'basis_invalid',
  // target identity, state and basis (step 4)
  'session_not_found', 'session_closing', 'handoff_active', 'transport_not_applicable', 'not_stranded',
  'epoch_mismatch', 'owner_generation_unavailable', 'owner_generation_mismatch', 'owner_disconnected',
  'stranded_inject_id_mismatch', 'basis_contradicted',
  // the generic refusal a caught exception degrades to (there is no 5xx on this route)
  'refused',
  // persist_reason only
  'session_store_write_failed', 'session_store_write_threw', 'not_attempted',
  // the CLI's own classification of a response and of its argv; never emitted by the daemon
  'route_unsupported', 'response_unparseable', 'response_unavailable', 'non_canonical_daemon_host',
  'argv_invalid', 'separator_required', 'positional_count', 'flag_count', 'unknown_flag', 'duplicate_flag',
  'flag_value_missing', 'target_not_exact_sid',
]));

// → the code itself when it is in the allow-list, `null` for "no reason at all" (a cleared answer), and the
// generic `refused` for everything else. No exception text, host path or payload fragment can reach this field.
function boundedClearReason(reason) {
  if (reason === null || reason === undefined) return null;
  if (typeof reason !== 'string') return 'refused';
  return REASONS.has(reason) ? reason : 'refused';
}

// A bounded identity token: a non-empty string of at most 256 BYTES with no control characters.
function boundedToken(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= TOKEN_MAX_BYTES
    && !/[\u0000-\u001f\u007f]/.test(value);
}

// A code that came from ANOTHER unit's vocabulary (the strand record's own `reason`, written by the bound
// delivery's allow-list) is reported verbatim when it is a bounded code, and dropped otherwise. It is NOT run
// through boundedClearReason: that allow-list is this door's own, and degrading a real `submit_*` code to
// `refused` would destroy the one fact the operator needs — WHY the composer was stranded.
function foreignCode(value) {
  return typeof value === 'string' && REASON_RE.test(value) ? value : null;
}

function isLoopbackPeer(remote) {
  if (typeof remote !== 'string' || remote.length === 0) return false;
  if (LOOPBACK_V4_RE.test(remote)) return true;
  if (remote === '::1' || remote === '0:0:0:0:0:0:0:1') return true;
  const mapped = MAPPED_V4_RE.exec(remote);
  return !!mapped && LOOPBACK_V4_RE.test(mapped[1]);
}

// Steps 1.1-1.4 of CLEAR-INTERFACE §5, in that exact order, as a pure decision over the request.
// → null when the transport is authorised so far, else { status, reason }.
//
// This function MUST NOT see the token: step 1.5 is performed by the route's injected `verifyHostToken`, so the
// expected secret never enters this module or the routes module. It also never reads a query parameter — a
// token in a URL lands in shell history, process lists and proxy logs, which is why this door takes one only
// from the header.
function authorizeClearStrandTransport(req) {
  const headers = (req && req.headers) || {};
  const remote = req && req.socket ? req.socket.remoteAddress : null;
  if (!isLoopbackPeer(remote)) return { status: 403, reason: 'clear_local_only' };
  // Any Origin at all: a browser that can reach loopback must not be able to drive this door, and a legitimate
  // caller (the CLI) never sends one.
  if (headers.origin !== undefined) return { status: 403, reason: 'clear_origin_refused' };
  const contentType = String(headers['content-type']).toLowerCase();
  if (!JSON_MEDIA_TYPE_RE.test(contentType)) return { status: 415, reason: 'clear_content_type' };
  const raw = req ? req.principalRawBody : null;
  if (!Buffer.isBuffer(raw) || raw.length < 1 || raw.length > BODY_MAX_BYTES) {
    return { status: 413, reason: 'clear_body_bytes' };
  }
  return null;
}

// → null when the body IS exactly telepty.clear-strand/v1, otherwise the bounded refusal code of §3.
// Key-count plus membership admits no extra and no missing key. No coercion anywhere: a number, a boolean or a
// one-element array is a refusal, never a conversion — a number that stringifies to the current generation is a
// different KIND of claim and may not be read as that generation.
function validateClearRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'request_not_object';
  const keys = Object.keys(body);
  if (keys.length !== REQUEST_KEYS.length || keys.some(key => !REQUEST_KEYS.includes(key))) return 'request_keys';
  if (body.schema !== REQUEST_SCHEMA) return 'request_schema';
  if (!boundedToken(body.from)) return 'from_invalid';
  if (!boundedToken(body.expected_epoch)) return 'expected_epoch_invalid';
  if (!boundedToken(body.expected_owner_generation)) return 'expected_owner_generation_invalid';
  // Exactly `null` or a real inject id. No other spelling of absence exists on the wire: the CLI's `none`
  // becomes JSON null there, and the strings 'null', 'none', '-' and '' are refusals here.
  if (body.stranded_inject_id !== null && !validInjectId(body.stranded_inject_id)) {
    return 'stranded_inject_id_invalid';
  }
  if (!BASES.includes(body.basis)) return 'basis_invalid';
  return null;
}

// The timing-safe host-token comparison of the /api/daemon/stop guard (src/daemon-shutdown.js:40-45), kept
// local to this pure module rather than refactored out of that #1215 guard (Rule 29; a hotfix does not reopen
// an unrelated security check). Equal-length buffers only — `crypto.timingSafeEqual` THROWS on a length
// mismatch, and a throw here would be both a 5xx and a length oracle.
function hostTokenMatches(supplied, expected) {
  if (typeof expected !== 'string' || !expected || typeof supplied !== 'string') return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

// THE ONE builder for telepty.clear-strand-result/v1. Every answer of the route — every refusal, the clear, and
// the caught-exception path — is this exact closed key set, so a caller parses one shape and never guesses.
//
// `session_epoch` and `owner_generation` are the DAEMON's own current values, never the request's, and stay
// null on every answer produced before the credential check passed and whenever no such session exists.
// `cleared_*` are populated from the record that was REMOVED, so they are null on every refusal — a refusal
// removed nothing and may not describe anything as removed.
function clearResult({
  stage, reason = null, sessionId = null, sessionEpoch = null, ownerGeneration = null,
  clearedInjectId = null, clearedStrandReason = null, clearedStrandAt = null,
  basis = null, childEvidence = 'unobservable', persisted = false, persistReason = null,
  pendingBootstrapOps = 0, bodyCustody = 0,
} = {}) {
  if (!STAGES.includes(stage)) throw new TypeError(`clear-strand result stage ${JSON.stringify(stage)}`);
  if (!CHILD_EVIDENCE.includes(childEvidence)) {
    throw new TypeError(`clear-strand result child_evidence ${JSON.stringify(childEvidence)}`);
  }
  const cleared = stage === 'cleared';
  const saved = cleared && persisted === true;
  return {
    schema: RESULT_SCHEMA,
    stage,
    reason: boundedClearReason(reason),
    session_id: sessionId === undefined ? null : sessionId,
    session_epoch: sessionEpoch === undefined ? null : sessionEpoch,
    owner_generation: ownerGeneration === undefined ? null : ownerGeneration,
    cleared_inject_id: cleared && validInjectId(clearedInjectId) ? clearedInjectId : null,
    cleared_strand_reason: cleared ? foreignCode(clearedStrandReason) : null,
    cleared_strand_at: cleared && ISO_RE.test(String(clearedStrandAt)) ? clearedStrandAt : null,
    basis: BASES.includes(basis) ? basis : null,
    child_evidence: childEvidence,
    bridge_strand: BRIDGE_STRAND,
    persisted: saved,
    // A refusal never attempted a save. A clear that could not be saved says which way it failed, and the
    // in-memory clear is NOT rolled back — an honest report beats a silent re-strand.
    persist_reason: saved ? null : (cleared ? (boundedClearReason(persistReason) || 'session_store_write_failed') : 'not_attempted'),
    // Reported, never dropped and never acted on: the clear owns no queue and settles no custody.
    pending_bootstrap_ops: nonNegativeInteger(pendingBootstrapOps),
    body_custody: nonNegativeInteger(bodyCustody),
  };
}

// The CALLER's own classification of a RESPONSE, used by the strict CLI verb; the mirror of
// classifyBoundResponse (bound-inject.js:136-144) with this door's schema and stages. A daemon that does not
// know this route answers a schema-LESS 404: that is the ONE answer that proves nothing happened. Every other
// unparseable answer stays unknown, and neither is ever retried.
function classifyClearResponse(status, body) {
  const closed = !!body && typeof body === 'object' && !Array.isArray(body) && body.schema === RESULT_SCHEMA
    && STAGES.includes(body.stage);
  if (closed) return { outcome: body.stage, reason: boundedClearReason(body.reason), result: body };
  if (status === 404 && (body === null || body === undefined || typeof body !== 'object' || !('schema' in body))) {
    return { outcome: 'unsupported', reason: 'route_unsupported', result: null };
  }
  // r2 erratum (review finding CSR-m1): a 401/403 that is NOT this route's closed object came from the shared
  // auth middleware, which is installed BEFORE this route (daemon.js) and answers
  // `{error, code: 'PERMISSION_DENIED'}`. Such an answer never reached the handler, so NOTHING happened — and
  // an operator must not be told to hold an identity and re-read a view for a provable no-effect. It is a
  // refusal with the no-effect exit code.
  //
  // This is the ONE place where the status, not the body, decides, and §2.4's "classifies on the body" rule is
  // amended for exactly this case: a 401/403 can only be produced before the effect (the route's own 401/403
  // carries the closed object and is handled above), so the inference is sound in both directions. The line
  // still reports `http_status`, so nothing about the answer is hidden from the caller.
  if (status === 401 || status === 403) {
    return { outcome: 'refused', reason: 'clear_auth_required', result: null };
  }
  return { outcome: 'outcome_unknown', reason: 'response_unparseable', result: null };
}

module.exports = {
  REQUEST_SCHEMA, RESULT_SCHEMA, REQUEST_KEYS, RESULT_KEYS, STAGES, BASES, CHILD_EVIDENCE, BRIDGE_STRAND,
  REASONS, TOKEN_MAX_BYTES, BODY_MAX_BYTES,
  boundedClearReason, boundedToken, hostTokenMatches, isLoopbackPeer,
  authorizeClearStrandTransport, validateClearRequest, clearResult, classifyClearResponse,
};
