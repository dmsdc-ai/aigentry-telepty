'use strict';

// Task 1270 bound-inject-v1 — the two CLOSED schemas of the bound busy-input transport, and nothing else.
// Frozen interface: controller/BOUND-INJECT-V1-CONTRACT-20261116.md. This module is PURE: no session, socket,
// store, clock, env or I/O. Both ends (the strict local CLI verb and POST /api/sessions/:id/inject-bound-v1)
// validate and build through here, so the wire shape cannot drift between them.
//
// Why a closed request object and not "the usual inject body plus two fields": an old daemon ignores an unknown
// JSON field, so a body that is merely DECORATED with expected_epoch/expected_owner_generation is accepted by a
// daemon that never checked either of them, and the caller cannot tell that from a real binding. Admitting
// exactly six keys, and refusing every extra/missing/coerced one before any effect, is what makes the presence
// of this schema itself the proof that the binding was honoured.

const REQUEST_SCHEMA = 'telepty.bound-inject/v1';
const RESULT_SCHEMA = 'telepty.bound-inject-result/v1';
// Exact, ordered, no duplicate: BOTH guarantees or no delivery. Not a set membership test — an incomplete,
// reordered, duplicated or stringified list is a different (unverified) request, not this one.
const REQUIRE = Object.freeze(['immediate-submit-v1', 'busy-input-v1']);
const REQUEST_KEYS = Object.freeze(['schema', 'prompt', 'from', 'expected_epoch', 'expected_owner_generation', 'require']);
// stage: the daemon's own knowledge of this request. `accepted` means both frames were handed to the pinned
// owner — never a PTY write, native queueing, auto-submit or model consumption.
const STAGES = Object.freeze(['refused', 'accepted', 'outcome_unknown']);
// Per-frame progress. `pty_written` exists for a future bridge receipt; this daemon never claims it itself.
const FRAME_STAGES = Object.freeze(['not_sent', 'queued', 'sent_to_bridge', 'pty_written', 'unknown']);
// expected_epoch / expected_owner_generation are OPAQUE bounded tokens: the daemon compares them to its own
// current values and never parses, normalizes or interprets them. 256 matches the bridge-capability header bound.
const TOKEN_MAX_BYTES = 256;
const REASON_RE = /^[a-z0-9_]{1,64}$/;

function boundedToken(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= TOKEN_MAX_BYTES
    // A control character in an identity token is never legitimate and would travel into logs/frames.
    && !/[\u0000-\u001f\u007f]/.test(value);
}

// A reason code is a bounded machine code, never an error message: it must not be able to carry a host path,
// payload fragment or raw exception text into the caller's hands.
function boundedReason(reason) {
  if (reason === null || reason === undefined) return null;
  const text = String(reason).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
  return REASON_RE.test(text) ? text : 'refused';
}

// → null when the request IS exactly telepty.bound-inject/v1, otherwise the bounded refusal code.
// Key-count plus membership admits no extra and no missing key; JSON duplicate keys have already collapsed in
// the parser, which is why the CLI rejects duplicate FLAGS on its own side before it ever builds this object.
function validateBoundRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'request_not_object';
  const keys = Object.keys(body);
  if (keys.length !== REQUEST_KEYS.length || keys.some(key => !REQUEST_KEYS.includes(key))) return 'request_keys';
  if (body.schema !== REQUEST_SCHEMA) return 'request_schema';
  // The existing inject prompt rule, unchanged: a string. No new arbitrary size cap is introduced here.
  if (typeof body.prompt !== 'string') return 'prompt_invalid';
  if (typeof body.from !== 'string' || body.from.length === 0 || body.from.length > TOKEN_MAX_BYTES) return 'from_invalid';
  if (!boundedToken(body.expected_epoch)) return 'expected_epoch_invalid';
  // Opaque STRING: the actual daemon getter is session.interactionOwnerGeneration. A number that happens to
  // stringify to the current generation is a different type of claim and is refused, never coerced.
  if (!boundedToken(body.expected_owner_generation)) return 'expected_owner_generation_invalid';
  if (!Array.isArray(body.require) || body.require.length !== REQUIRE.length
      || REQUIRE.some((capability, index) => body.require[index] !== capability)) return 'require_invalid';
  return null;
}

// The ONE builder for telepty.bound-inject-result/v1. Every response of the route — refusal, acceptance and
// outcome_unknown — is this exact closed key set, so a caller can parse one shape and never guess.
//
// bytes_written is 0 ONLY where zero is authoritative: before any enqueue/handoff, or after a PROVEN unsent
// cancellation. It is null the moment a body may exist anywhere downstream. It is never derived from a
// timeout, a lost response or a queued frame, and the daemon never reports a positive count it cannot prove.
function boundResult({
  stage, reason = null, sessionId, sessionEpoch = null, ownerGeneration = null, injectId = null,
  bodyStage = 'not_sent', submitStage = 'not_sent', bytesWritten = 0,
}) {
  if (!STAGES.includes(stage)) throw new TypeError(`bound-inject result stage ${JSON.stringify(stage)}`);
  if (!FRAME_STAGES.includes(bodyStage) || !FRAME_STAGES.includes(submitStage)) {
    throw new TypeError('bound-inject result frame stage');
  }
  return {
    schema: RESULT_SCHEMA,
    stage,
    reason: boundedReason(reason),
    session_id: sessionId,
    session_epoch: sessionEpoch === undefined ? null : sessionEpoch,
    owner_generation: ownerGeneration === undefined ? null : ownerGeneration,
    inject_id: injectId === undefined ? null : injectId,
    body_stage: bodyStage,
    submit_stage: submitStage,
    bytes_written: bytesWritten === 0 ? 0 : null,
    // No provider acknowledges a specific message, so consumption is structurally unknown on this path.
    // It is a constant, not a field a future receipt may quietly upgrade.
    consumption: 'unknown',
  };
}

// The caller's own classification of a RESPONSE, used by the strict CLI verb. A daemon that does not know this
// route answers a schema-less 404: that is proven "unsupported, nothing was sent" — it is the ONLY 404 that
// may be read that way, and a generic/odd 404 (or any other unparseable answer) stays `unknown` with no replay.
function classifyBoundResponse(status, body) {
  const closed = !!body && typeof body === 'object' && !Array.isArray(body) && body.schema === RESULT_SCHEMA
    && STAGES.includes(body.stage);
  if (closed) return { outcome: body.stage, reason: boundedReason(body.reason), result: body };
  if (status === 404 && (body === null || body === undefined || typeof body !== 'object' || !('schema' in body))) {
    return { outcome: 'unsupported', reason: 'route_unsupported', result: null };
  }
  // Lost, truncated, malformed or non-schema: the request may have had an effect. Never retried.
  return { outcome: 'outcome_unknown', reason: 'response_unparseable', result: null };
}

module.exports = {
  REQUEST_SCHEMA, RESULT_SCHEMA, REQUIRE, REQUEST_KEYS, STAGES, FRAME_STAGES, TOKEN_MAX_BYTES,
  boundedToken, boundedReason, validateBoundRequest, boundResult, classifyBoundResponse,
};
