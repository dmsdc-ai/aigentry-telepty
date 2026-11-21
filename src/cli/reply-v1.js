'use strict';

// Task 1292 W4 — `telepty reply-v1 <token> [--file <path>]` (SPEC §11, reply-capability-v1).
//
// Spends ONE daemon-issued reply capability: the reply body comes from --file, else stdin, and goes to the
// local daemon's consume route POST /api/reply-capability-v1. The capability is the authority; the host token
// is only the existing admission, read the same way every loopback verb reads it (fetchWithAuth, here with
// readOnlyAuth so a missing ~/.telepty/config.json is a refusal and is never minted).
//
//   • The token is never printed, logged or placed in an error message. Every stderr text below is fixed.
//   • Only 127.0.0.1: a non-canonical TELEPTY_HOST is refused before any body read or socket.
//   • Exactly one POST and no retry of any kind. An unknown outcome is reported, never resent.
//   • Writes no file and keeps no state.
//
// Exit codes (SPEC §11, HOLD-1 Q2/Q4/Q5):
//   0 accepted · 2 refused, nothing written by this call · 3 outcome unknown, do not send another body ·
//   4 no usable response, running the SAME command again is safe (the daemon replays or answers IN_FLIGHT).

const fs = require('node:fs');
const { RESULT_SCHEMA, TOKEN_RE, REPLY_BODY_MAX_BYTES, REQUEST_MAX_BYTES, buildResult } = require('../reply-capability');

const ROUTE = '/api/reply-capability-v1';
const RESPONSE_MAX_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 30000;
const EXIT = Object.freeze({ accepted: 0, refused: 2, unknown: 3, noResponse: 4 });
const LOCAL = Object.freeze({
  USAGE: 'REPLY_CLI_USAGE',
  TOKEN_INVALID: 'REPLY_CLI_TOKEN_INVALID',
  BODY_EMPTY: 'REPLY_CLI_BODY_EMPTY',
  BODY_TOO_LARGE: 'REPLY_CLI_BODY_TOO_LARGE',
  BODY_INVALID: 'REPLY_CLI_BODY_INVALID',
  REMOTE_HOST_REFUSED: 'REPLY_CLI_REMOTE_HOST_REFUSED',
  HOST_TOKEN_UNAVAILABLE: 'REPLY_CLI_HOST_TOKEN_UNAVAILABLE',
  NO_RESPONSE: 'REPLY_CLI_NO_RESPONSE',
  RESPONSE_UNRECOGNIZED: 'REPLY_CLI_RESPONSE_UNRECOGNIZED',
});
const USAGE = 'Usage: telepty reply-v1 <token> [--file <path>]   (the reply body is read from --file, else from stdin)\n';
// Fixed texts only: nothing derived from argv, the body, the environment or an exception reaches stderr.
const STDERR = Object.freeze({
  [LOCAL.USAGE]: USAGE,
  [LOCAL.TOKEN_INVALID]: 'reply-v1: the capability argument is not a well-formed reply token. Nothing was sent.\n',
  [LOCAL.BODY_EMPTY]: 'reply-v1: the reply body is empty. Nothing was sent.\n',
  [LOCAL.BODY_TOO_LARGE]: `reply-v1: the reply body exceeds ${REPLY_BODY_MAX_BYTES} bytes. Nothing was sent.\n`,
  [LOCAL.BODY_INVALID]: 'reply-v1: the reply body could not be read, or is not valid UTF-8 without NUL. Nothing was sent.\n',
  [LOCAL.REMOTE_HOST_REFUSED]: 'reply-v1: only the local daemon at 127.0.0.1 is supported. Nothing was sent.\n',
  [LOCAL.HOST_TOKEN_UNAVAILABLE]: 'reply-v1: the daemon host token could not be read (TELEPTY_AUTH_TOKEN or ~/.telepty/config.json). Nothing was sent.\n',
});
const RETRY_SAME_HINT = 'reply-v1: no usable response from the local daemon. Running the SAME command again is safe; do not change the body.\n';
const DO_NOT_RESEND_HINT = 'reply-v1: the reply outcome is unknown; do not resend. Check the requester\'s audit.\n';
const UNRECOGNIZED_REFUSAL_HINT = 'reply-v1: the daemon refused the request without a reply-capability result (it may not support reply-capability-v1). Nothing was written.\n';

const RESULT_KEYS = Object.freeze(['schema', 'stage', 'outcome', 'reason', 'capability_id', 'reply_inject_id',
  'destination_session_id', 'replayed', 'retryable']);
// The one additive key the frozen W3 route adds (REPLY_CAPABILITY_UNKNOWN only).
const OPTIONAL_RESULT_KEYS = Object.freeze(['daemon_started_at']);

// Pure. → { ok:true, token, file } (file null ⇒ stdin) or { ok:false, code }. The token never leaves this
// object except as the request's `capability` field.
function parseReplyArgv(argv) {
  if (!Array.isArray(argv)) return { ok: false, code: LOCAL.USAGE };
  let file = null;
  if (argv.length === 3 && argv[1] === '--file') {
    file = argv[2];
    if (typeof file !== 'string' || file === '' || file.startsWith('--')) return { ok: false, code: LOCAL.USAGE };
  } else if (argv.length !== 1) {
    return { ok: false, code: LOCAL.USAGE };
  }
  const token = argv[0];
  if (typeof token !== 'string' || token.startsWith('-')) return { ok: false, code: LOCAL.USAGE };
  if (token.length !== 70 || !TOKEN_RE.test(token)) return { ok: false, code: LOCAL.TOKEN_INVALID };
  return { ok: true, token, file };
}

function remoteHostRefusal(remoteHost) {
  return remoteHost === '127.0.0.1' ? null : LOCAL.REMOTE_HOST_REFUSED;
}

// Reads at most `max + 1` bytes, so an oversized source is detected without reading it whole.
function readFileCapped(file, max) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(max + 1);
    let total = 0;
    for (;;) {
      const n = fs.readSync(fd, buffer, total, buffer.length - total, null);
      if (n === 0) break;
      total += n;
      if (total > max) return { ok: false, code: LOCAL.BODY_TOO_LARGE };
    }
    return { ok: true, bytes: buffer.subarray(0, total) };
  } catch {
    return { ok: false, code: LOCAL.BODY_INVALID };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* read-only descriptor */ } }
  }
}

async function readStreamCapped(stream, max) {
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      // Leaving the loop early destroys the stream; the remainder is never read.
      if (total > max) return { ok: false, code: LOCAL.BODY_TOO_LARGE };
      chunks.push(bytes);
    }
  } catch {
    return { ok: false, code: LOCAL.BODY_INVALID };
  }
  return { ok: true, bytes: Buffer.concat(chunks) };
}

// The route's own body rule (SPEC §3.2), applied before any socket: 1..65536 bytes, UTF-8 that round-trips,
// no NUL. → { ok:true, text } or { ok:false, code }.
function validateBody(bytes) {
  if (bytes.length === 0) return { ok: false, code: LOCAL.BODY_EMPTY };
  if (bytes.length > REPLY_BODY_MAX_BYTES) return { ok: false, code: LOCAL.BODY_TOO_LARGE };
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes) || text.includes('\0')) return { ok: false, code: LOCAL.BODY_INVALID };
  return { ok: true, text };
}

// → { ok:true, bytes } or { ok:false } (read error, abort/timeout, missing reader, or more than `max` bytes).
async function readResponseCapped(response, max) {
  const body = response.body;
  if (body === null) return { ok: true, bytes: Buffer.alloc(0) };
  if (!body || typeof body.getReader !== 'function') return { ok: false };
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        reader.cancel().catch(() => {});
        return { ok: false };
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    return { ok: false };
  }
  return { ok: true, bytes: Buffer.concat(chunks) };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const stringOrNull = value => value === null || typeof value === 'string';

// The closed §3.4 object, as the frozen W1/W3 schema produces it.
function isClosedResult(doc) {
  if (!isPlainObject(doc) || doc.schema !== RESULT_SCHEMA) return false;
  const keys = Object.keys(doc);
  if (!RESULT_KEYS.every(key => Object.hasOwn(doc, key))) return false;
  if (!keys.every(key => RESULT_KEYS.includes(key) || OPTIONAL_RESULT_KEYS.includes(key))) return false;
  if (Object.hasOwn(doc, 'daemon_started_at') && typeof doc.daemon_started_at !== 'string') return false;
  return ['accepted', 'refused', 'outcome_unknown'].includes(doc.stage)
    && [null, 'delivered', 'queued'].includes(doc.outcome)
    && stringOrNull(doc.reason) && stringOrNull(doc.capability_id) && stringOrNull(doc.reply_inject_id)
    && stringOrNull(doc.destination_session_id)
    && typeof doc.replayed === 'boolean' && typeof doc.retryable === 'boolean';
}

// Status class per stage: 200 accepted; 500 outcome_unknown; refused carries its ERROR_STATUS or the
// delivery's own status (W1 settle: an integer 400–599).
function stageAgreesWithStatus(stage, status) {
  if (stage === 'accepted') return status === 200;
  if (stage === 'outcome_unknown') return status === 500;
  return Number.isInteger(status) && status >= 400 && status <= 599;
}

// Pure. (HTTP status, complete response bytes) → { exit, line, hint }.
function classifyReplyResponse(status, bytes) {
  let doc;
  let json = true;
  try { doc = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { json = false; }
  if (json && isPlainObject(doc) && doc.schema === RESULT_SCHEMA) {
    if (isClosedResult(doc) && stageAgreesWithStatus(doc.stage, status)) {
      const exit = doc.stage === 'accepted' ? EXIT.accepted : doc.stage === 'refused' ? EXIT.refused : EXIT.unknown;
      return { exit, line: doc, hint: exit === EXIT.unknown ? DO_NOT_RESEND_HINT : null };
    }
    return { exit: EXIT.unknown, line: localResult('outcome_unknown', LOCAL.RESPONSE_UNRECOGNIZED, status), hint: DO_NOT_RESEND_HINT };
  }
  // Earlier middleware (401/403/413, profile gate) or a daemon without the route (plain 404): the consume
  // handler never ran, so nothing was written.
  if (Number.isInteger(status) && status >= 400 && status <= 499) {
    return { exit: EXIT.refused, line: localResult('refused', LOCAL.RESPONSE_UNRECOGNIZED, status), hint: UNRECOGNIZED_REFUSAL_HINT };
  }
  if (!json) {
    return { exit: EXIT.noResponse, line: localResult('outcome_unknown', LOCAL.RESPONSE_UNRECOGNIZED, status, true), hint: RETRY_SAME_HINT };
  }
  return { exit: EXIT.unknown, line: localResult('outcome_unknown', LOCAL.RESPONSE_UNRECOGNIZED, status), hint: DO_NOT_RESEND_HINT };
}

// The closed shape for an answer decided by this CLI. `httpStatus` is present (possibly null) only once a
// request was attempted.
function localResult(stage, reason, httpStatus, retryable = false) {
  const result = buildResult({ stage, reason, retryable });
  if (httpStatus !== undefined) result.http_status = httpStatus;
  return result;
}

function jsonLine(value) { return `${JSON.stringify(value)}\n`; }

// `deps`: { fetchWithAuth, daemonUrl, remoteHost, stdin, stdout, stderr, timeoutMs }. No default daemon URL
// and no default fetch: the caller supplies the canonical local base and the existing authenticated fetch.
async function runReplyV1(argv, deps) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const refuseLocally = code => {
    stderr.write(STDERR[code]);
    stdout.write(jsonLine(localResult('refused', code)));
    return EXIT.refused;
  };
  const parsed = parseReplyArgv(argv);
  if (!parsed.ok) return refuseLocally(parsed.code);
  const hostRefusal = remoteHostRefusal(deps.remoteHost);
  if (hostRefusal) return refuseLocally(hostRefusal);

  const source = parsed.file !== null
    ? readFileCapped(parsed.file, REPLY_BODY_MAX_BYTES)
    : await readStreamCapped(deps.stdin || process.stdin, REPLY_BODY_MAX_BYTES);
  if (!source.ok) return refuseLocally(source.code);
  const body = validateBody(source.bytes);
  if (!body.ok) return refuseLocally(body.code);
  const payload = JSON.stringify({ v: 1, capability: parsed.token, body: body.text });
  if (Buffer.byteLength(payload) > REQUEST_MAX_BYTES) return refuseLocally(LOCAL.BODY_TOO_LARGE);

  const signal = AbortSignal.timeout(Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : REQUEST_TIMEOUT_MS);
  let pending;
  try {
    // A synchronous throw happens before any socket: the host token could not be resolved.
    pending = deps.fetchWithAuth(`${deps.daemonUrl}${ROUTE}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
      readOnlyAuth: true, body: payload, signal,
    });
  } catch {
    return refuseLocally(LOCAL.HOST_TOKEN_UNAVAILABLE);
  }
  let response;
  try {
    response = await pending;
  } catch {
    stderr.write(RETRY_SAME_HINT);
    stdout.write(jsonLine(localResult('outcome_unknown', LOCAL.NO_RESPONSE, null, true)));
    return EXIT.noResponse;
  }
  const status = response.status;
  const read = await readResponseCapped(response, RESPONSE_MAX_BYTES);
  if (!read.ok) {
    stderr.write(RETRY_SAME_HINT);
    stdout.write(jsonLine(localResult('outcome_unknown', LOCAL.NO_RESPONSE, status, true)));
    return EXIT.noResponse;
  }
  const verdict = classifyReplyResponse(status, read.bytes);
  if (verdict.hint) stderr.write(verdict.hint);
  stdout.write(jsonLine(verdict.line));
  return verdict.exit;
}

module.exports = {
  ROUTE, RESPONSE_MAX_BYTES, REQUEST_TIMEOUT_MS, EXIT, LOCAL, USAGE,
  parseReplyArgv, remoteHostRefusal, validateBody, isClosedResult, classifyReplyResponse, runReplyV1,
};
