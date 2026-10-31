'use strict';

// Task 1215 F2 — explicit spawn-readiness milestones for EVERY role (supervised and guarded).
//
//   process_started        node-pty returned a child for this bridge (creation only). A PID is not
//                          execution or application readiness and nothing here says otherwise.
//   input_transport_ready  that child exists, its output/exit subscription is attached and the
//                          bridge's owner inject loop is live, announced by the CURRENT owner.
//
// Both are bridge -> daemon frames on the owner socket, bound to the session id, instance epoch,
// owner generation and a per-generation readiness nonce the daemon sent in `owner_token`. They are
// session milestones, never per-message receipts: a PTY write, Enter, or this handshake is not
// instruction receipt or consumption. Screen, model, glyph, VT or prompt text never sets them.
//
// A bridge declares support with the WS handshake header below. An owner that does not is LEGACY:
// its milestones are reported unknown and the pre-1215 bootstrap behavior is left unchanged.

const crypto = require('node:crypto');

const CAPABILITY = 'input-transport-ready-v1';
const CAPABILITY_HEADER = 'x-telepty-bridge-capabilities';
const SCHEMA = 1;
const FRAME_MAX_BYTES = 512;
const MILESTONES = ['process_started', 'input_transport_ready'];
const NONCE = /^[A-Za-z0-9_-]{22,64}$/;

function declaresCapability(headerValue) {
  if (typeof headerValue !== 'string' || headerValue.length > 256) return false;
  return headerValue.split(',').map(part => part.trim()).includes(CAPABILITY);
}

// Daemon: called at every owner claim, right after the new owner generation is minted. Any
// previous generation's milestones are gone with it. Child sequences are scoped to one owner
// generation (a new bridge process restarts at 1); cross-generation replay is stopped by the
// fresh nonce, in-generation replay by retired_child_seq.
function beginOwnerGeneration(session, { capable }) {
  session.transportReadiness = {
    owner_generation: session.interactionOwnerGeneration, capable: capable === true,
    nonce: crypto.randomBytes(16).toString('base64url'),
    process_started: null, input_transport_ready: null, retired_child_seq: 0, cleared_reason: null,
  };
  return session.transportReadiness;
}

function current(session) {
  const state = session && session.transportReadiness;
  return state && state.owner_generation === session.interactionOwnerGeneration ? state : null;
}

// Child exit / restart / owner disconnect. A cleared child_seq can never be re-announced.
function clearReadiness(session, reason) {
  const state = current(session);
  if (!state) return false;
  const seq = Math.max(state.process_started ? state.process_started.child_seq : 0,
    state.input_transport_ready ? state.input_transport_ready.child_seq : 0);
  state.retired_child_seq = Math.max(state.retired_child_seq, seq);
  state.process_started = null;
  state.input_transport_ready = null;
  state.cleared_reason = typeof reason === 'string' ? reason : 'cleared';
  return true;
}

function isOpen(ws) { return !!(ws && ws.readyState === 1); }

// Daemon: validate one milestone frame from the current owner socket. Returns
// { ok, milestone? , reason? }. Stale, replayed, wrong-owner and malformed frames are refused.
function acceptMilestone(sessionId, session, msg) {
  if (!msg || !MILESTONES.includes(msg.type) || msg.schema !== SCHEMA) return { ok: false, reason: 'shape' };
  // Strict-owner wire fields are transport framing, not part of the milestone.
  const { connection_id: _c, sequence: _s, expires_at: _e, ...frame } = msg;
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(frame), 'utf8'); } catch { return { ok: false, reason: 'shape' }; }
  if (bytes > FRAME_MAX_BYTES) return { ok: false, reason: 'oversize' };
  const state = current(session);
  if (!state || !state.capable) return { ok: false, reason: 'not_negotiated' };
  if (msg.owner_generation !== session.interactionOwnerGeneration) return { ok: false, reason: 'owner_generation' };
  if (typeof msg.readiness_nonce !== 'string' || !NONCE.test(msg.readiness_nonce) || msg.readiness_nonce !== state.nonce) return { ok: false, reason: 'nonce' };
  if (msg.session_id !== sessionId || session.id !== sessionId) return { ok: false, reason: 'session_id' };
  if ((session.sessionEpoch || null) !== (msg.session_epoch ?? null)) return { ok: false, reason: 'session_epoch' };
  if (!Number.isSafeInteger(msg.child_seq) || msg.child_seq <= state.retired_child_seq) return { ok: false, reason: 'child_seq' };
  if (Object.hasOwn(msg, 'data') || Object.hasOwn(msg, 'payload')) return { ok: false, reason: 'payload_key' };
  if (!isOpen(session.ownerWs)) return { ok: false, reason: 'owner_transport' };
  const at = new Date().toISOString();
  if (msg.type === 'process_started') {
    if (state.process_started && state.process_started.child_seq >= msg.child_seq) return { ok: false, reason: 'replay' };
    if (!Number.isSafeInteger(msg.pid) || msg.pid <= 0 || msg.exec !== 'unverified') return { ok: false, reason: 'field' };
    // A new child supersedes any readiness of the previous one.
    if (state.process_started) state.retired_child_seq = Math.max(state.retired_child_seq, state.process_started.child_seq);
    state.process_started = { child_seq: msg.child_seq, pid: msg.pid, exec: 'unverified', observed_at: at };
    state.input_transport_ready = null;
    state.cleared_reason = null;
    return { ok: true, milestone: 'process_started' };
  }
  if (!state.process_started || state.process_started.child_seq !== msg.child_seq) return { ok: false, reason: 'process_not_started' };
  if (state.input_transport_ready) return { ok: false, reason: 'replay' };
  if (msg.input_loop !== 'attached') return { ok: false, reason: 'field' };
  state.input_transport_ready = { child_seq: msg.child_seq, observed_at: at };
  return { ok: true, milestone: 'input_transport_ready' };
}

// Daemon gating. `negotiated` = the current owner generation speaks the handshake.
function negotiated(session) { const state = current(session); return !!(state && state.capable); }
function inputTransportReady(session) {
  const state = current(session);
  return !!(state && state.capable && state.input_transport_ready && isOpen(session.ownerWs));
}
// Only an OPEN negotiated owner that has not completed the handshake makes deliveries wait; a
// disconnected owner keeps the existing disconnected/stale failure semantics.
function awaitingInputTransport(session) {
  const state = current(session);
  return !!(state && state.capable && !state.input_transport_ready && isOpen(session.ownerWs));
}

function view(session) {
  if (!session || session.type !== 'wrapped') return { capability: 'not_applicable' };
  const state = current(session);
  if (!state || !state.capable) {
    return { capability: 'legacy_bridge_no_handshake', process_started: { status: 'unknown', reason: 'legacy_bridge_no_handshake' },
      input_transport_ready: { status: 'unknown', reason: 'legacy_bridge_no_handshake' } };
  }
  const milestone = (value, missing) => value
    ? { status: 'observed', source: 'current_owner_handshake', child_seq: value.child_seq, observed_at: value.observed_at,
      ...(value.pid ? { pid: value.pid, exec: value.exec } : {}) }
    : { status: 'not_observed', reason: state.cleared_reason || missing };
  return { capability: CAPABILITY, owner_generation: state.owner_generation,
    owner_connected: isOpen(session.ownerWs),
    process_started: milestone(state.process_started, 'awaiting_process_started'),
    input_transport_ready: milestone(state.input_transport_ready, 'awaiting_input_transport_ready'),
    meaning: 'transport_only_not_instruction_receipt' };
}

// Bridge side: the frame for one milestone, or null when the binding is incomplete.
function milestoneFrame(type, { sessionId, binding, nonce, childSeq, pid }) {
  if (!MILESTONES.includes(type) || !binding || typeof binding.owner_generation !== 'string'
      || typeof nonce !== 'string' || !Number.isSafeInteger(childSeq) || childSeq <= 0) return null;
  const frame = { type, schema: SCHEMA, session_id: sessionId, session_epoch: binding.session_epoch ?? null,
    owner_generation: binding.owner_generation, readiness_nonce: nonce, child_seq: childSeq,
    ...(type === 'process_started' ? { pid, exec: 'unverified' } : { input_loop: 'attached' }) };
  if (type === 'process_started' && (!Number.isSafeInteger(pid) || pid <= 0)) return null;
  const raw = JSON.stringify(frame);
  return Buffer.byteLength(raw, 'utf8') <= FRAME_MAX_BYTES ? raw : null;
}

module.exports = { CAPABILITY, CAPABILITY_HEADER, SCHEMA, MILESTONES, declaresCapability, beginOwnerGeneration, clearReadiness,
  acceptMilestone, negotiated, inputTransportReady, awaitingInputTransport, view, milestoneFrame };
