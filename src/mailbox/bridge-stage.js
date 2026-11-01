'use strict';

// #136/#137 (task 1215) — bridge stage receipts: the ONE vocabulary both ends share, the bridge-side
// frame builders and the daemon-side validators. A receipt is a transport fact about the bridge's
// own queue and PTY write. `pty_written` means child.write() returned for that record; it is not
// model consumption, turn acceptance, completion or a semantic ACK, and nothing here can say so.
// Receipts carry no payload: ids, stage, reason and certainty only, at most 512 B serialized.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CAPABILITY = 'bridge-stage-receipts-v1';
const SCHEMA = 1;
const RECEIPT_MAX_BYTES = 512;
const QUEUE_MAX_BYTES = 1024;
const ID_MAX_UNITS = 128;

// stage -> the PTY certainties it may carry. `written` exists only for pty_written.
const STAGE_CERTAINTY = Object.freeze({
  queued: ['not_written'],
  withheld: ['not_written'],
  pty_written: ['written'],
  quarantined: ['not_written', 'unknown'],
  refused: ['not_written'],
  unknown: ['unknown'],
});
const PARTS = ['body', 'submit'];
const PHASES = ['open', 'waiting', 'stalled', 'draining'];
const READY_SOURCES = ['tail', 'vt_frame'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TOKEN = /^[a-z0-9_.:-]{1,64}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const FRAME_META_KEYS = ['daemon_msg_id', 'inject_id', 'part', 'pair', 'owner_generation'];
// Files hashed into bridge_code_digest, read once at bridge start ('files_at_bridge_start').
const DIGEST_FILES = ['cli.js', 'src/cli/security-actions.js', 'src/prompt-symbol-registry.js', 'src/mailbox/index.js'];

function boundedId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= ID_MAX_UNITS && !/[\x00-\x1f\x7f]/.test(value);
}
function nullableId(value) { return value === null || value === undefined ? null : (boundedId(value) ? value : undefined); }
function frameBytes(msg) {
  // Strict-owner wire fields are transport framing, not part of the receipt.
  const { connection_id: _c, sequence: _s, expires_at: _e, ...frame } = msg;
  return Buffer.byteLength(JSON.stringify(frame), 'utf8');
}

// Daemon -> bridge: the ids an `inject` frame carries. Unknown or malformed values are dropped,
// never invented; an old daemon sends none and the bridge then reports null ids.
function frameMeta(source) {
  const meta = {};
  if (!source || typeof source !== 'object') return meta;
  for (const key of FRAME_META_KEYS) {
    const value = source[key];
    if (key === 'part' ? PARTS.includes(value) : boundedId(value)) meta[key] = value;
  }
  return meta;
}

function receiptFrame({ meta = {}, bridgeMsgId = null, stage, reason = null, certainty, bridgeSeq, atMs, ownerGeneration = null }) {
  const frame = {
    type: 'bridge_receipt', schema: SCHEMA,
    daemon_msg_id: boundedId(meta.daemon_msg_id) ? meta.daemon_msg_id : null,
    inject_id: boundedId(meta.inject_id) ? meta.inject_id : null,
    part: PARTS.includes(meta.part) ? meta.part : null,
    bridge_msg_id: boundedId(bridgeMsgId) ? bridgeMsgId : null,
    stage, reason: reason || null, certainty, bridge_seq: bridgeSeq, at_ms: atMs, clock: 'bridge_wall',
    owner_generation: ownerGeneration,
  };
  let raw = JSON.stringify(frame);
  if (Buffer.byteLength(raw, 'utf8') > RECEIPT_MAX_BYTES) { frame.bridge_msg_id = null; raw = JSON.stringify(frame); }
  return Buffer.byteLength(raw, 'utf8') <= RECEIPT_MAX_BYTES ? raw : null;
}

function validateBridgeReceipt(msg, ownerGeneration) {
  if (!msg || msg.type !== 'bridge_receipt' || msg.schema !== SCHEMA) return { ok: false, reason: 'shape' };
  if (frameBytes(msg) > RECEIPT_MAX_BYTES) return { ok: false, reason: 'oversize' };
  if (typeof ownerGeneration !== 'string' || msg.owner_generation !== ownerGeneration) return { ok: false, reason: 'owner_generation' };
  if (Object.hasOwn(msg, 'payload') || Object.hasOwn(msg, 'data')) return { ok: false, reason: 'payload_key' };
  const allowed = STAGE_CERTAINTY[msg.stage];
  if (!allowed || !allowed.includes(msg.certainty)) return { ok: false, reason: 'stage' };
  if (msg.part !== null && msg.part !== undefined && !PARTS.includes(msg.part)) return { ok: false, reason: 'part' };
  if (msg.inject_id !== null && msg.inject_id !== undefined && !(typeof msg.inject_id === 'string' && UUID.test(msg.inject_id))) return { ok: false, reason: 'inject_id' };
  const daemonMsgId = nullableId(msg.daemon_msg_id); const bridgeMsgId = nullableId(msg.bridge_msg_id);
  if (daemonMsgId === undefined || bridgeMsgId === undefined) return { ok: false, reason: 'id' };
  if (msg.reason !== null && msg.reason !== undefined && !(typeof msg.reason === 'string' && TOKEN.test(msg.reason))) return { ok: false, reason: 'reason' };
  if (!Number.isSafeInteger(msg.bridge_seq) || msg.bridge_seq < 0 || !Number.isSafeInteger(msg.at_ms) || msg.at_ms < 0
    || msg.clock !== 'bridge_wall') return { ok: false, reason: 'sequence' };
  return { ok: true, receipt: { inject_id: msg.inject_id || null, daemon_msg_id: daemonMsgId, part: msg.part || null,
    bridge_msg_id: bridgeMsgId, stage: msg.stage, reason: msg.reason || null, certainty: msg.certainty,
    bridge_seq: msg.bridge_seq, at_ms: msg.at_ms, clock: 'bridge_wall' } };
}

function count(value) { return Number.isSafeInteger(value) && value >= 0 && value <= 1000000; }
function validateBridgeQueue(msg, ownerGeneration) {
  if (!msg || typeof msg !== 'object' || msg.schema !== SCHEMA) return { ok: false, reason: 'shape' };
  if (frameBytes(msg) > QUEUE_MAX_BYTES) return { ok: false, reason: 'oversize' };
  if (typeof ownerGeneration !== 'string' || msg.owner_generation !== ownerGeneration) return { ok: false, reason: 'owner_generation' };
  if (!count(msg.pending) || !count(msg.in_flight) || !PHASES.includes(msg.phase)
    || !(msg.oldest_age_ms === null || (Number.isSafeInteger(msg.oldest_age_ms) && msg.oldest_age_ms >= 0))
    || !(msg.reason === null || (typeof msg.reason === 'string' && TOKEN.test(msg.reason)))
    || typeof msg.first_ready_observed !== 'boolean'
    || !(msg.ready_source === null || READY_SOURCES.includes(msg.ready_source))
    || !(typeof msg.vt === 'string' && TOKEN.test(msg.vt))
    || !(msg.bridge_version === null || (typeof msg.bridge_version === 'string' && TOKEN.test(msg.bridge_version)))
    || !(msg.bridge_code_digest === null || (typeof msg.bridge_code_digest === 'string' && DIGEST.test(msg.bridge_code_digest)))
    || !(msg.input_policy === undefined || msg.input_policy === 'user-supervised' || msg.input_policy === 'guarded')) {
    return { ok: false, reason: 'field' };
  }
  return { ok: true, queue: { pending: msg.pending, in_flight: msg.in_flight, oldest_age_ms: msg.oldest_age_ms, phase: msg.phase,
    reason: msg.reason, first_ready_observed: msg.first_ready_observed, ready_source: msg.ready_source, vt: msg.vt,
    bridge_version: msg.bridge_version, bridge_code_digest: msg.bridge_code_digest,
    ...(msg.input_policy ? { bridge_input_policy: msg.input_policy } : {}) } };
}

// Daemon side. A bridge that has not reported in the CURRENT owner generation is an old bridge as
// far as this daemon can tell: explicitly unsupported, never inferred to have delivered anything.
function bridgeReceiptSupport(session) {
  if (!session || session.type !== 'wrapped') return 'not_applicable';
  return session.bridgeStageGeneration && session.bridgeStageGeneration === session.interactionOwnerGeneration
    ? 'supported' : 'unsupported_by_bridge';
}
function applyBridgeQueue(session, report) {
  const checked = validateBridgeQueue(report, session && session.interactionOwnerGeneration);
  if (!checked.ok) return false;
  session.bridgeQueue = { ...checked.queue, source: 'bridge_report', observed_at: new Date().toISOString() };
  session.bridgeStageGeneration = session.interactionOwnerGeneration;
  return true;
}
function bridgeQueueView(session) {
  return session && session.bridgeQueue && session.bridgeStageGeneration === session.interactionOwnerGeneration
    ? session.bridgeQueue : null;
}

// Read once at bridge start. A file that cannot be read yields a null digest, never a guess.
function bridgeIdentity(rootDir, version) {
  let digest = null;
  try {
    const hash = crypto.createHash('sha256');
    for (const rel of DIGEST_FILES) {
      const bytes = fs.readFileSync(path.join(rootDir, rel));
      hash.update(rel).update('\0').update(String(bytes.length)).update('\0').update(bytes);
    }
    digest = hash.digest('hex');
  } catch { digest = null; }
  return { bridge_version: typeof version === 'string' && TOKEN.test(version) ? version : null,
    bridge_code_digest: digest, digest_basis: 'files_at_bridge_start' };
}

module.exports = { CAPABILITY, SCHEMA, RECEIPT_MAX_BYTES, QUEUE_MAX_BYTES, STAGE_CERTAINTY, DIGEST_FILES,
  frameMeta, receiptFrame, validateBridgeReceipt, validateBridgeQueue, bridgeIdentity,
  bridgeReceiptSupport, applyBridgeQueue, bridgeQueueView };
