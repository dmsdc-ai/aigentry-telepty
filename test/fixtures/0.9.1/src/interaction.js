'use strict';

// Provider boundary: only a local, measured adapter may supply observations. Neither HTTP
// request bodies nor output-ring text implement this interface. There is no enabled adapter yet.
const crypto = require('node:crypto');
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const KEYS = Object.freeze({ up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C',
  tab: '\t', 'shift-tab': '\x1b[Z', space: ' ', enter: '\r', escape: '\x1b',
  home: '\x1b[H', end: '\x1b[F', backspace: '\x7f', delete: '\x1b[3~' });
const FENCE_FIELDS = ['sid', 'session_epoch', 'credential_generation', 'owner_generation',
  'input_generation', 'geometry_generation', 'prompt_revision', 'frame_digest', 'surface_id', 'cols', 'rows'];
const REFUSALS = Object.freeze(['unsupported_capability', 'stale_prompt', 'wrong_owner',
  'wrong_attempt', 'authority_required', 'payload_conflict', 'busy', 'cancelled', 'expired',
  'observation_unavailable', 'write_failed', 'outcome_unknown', 'invalid_request', 'storage_unavailable']);

function refusal(reason, extra = {}) {
  return { schema_version: 1, stage: 'refused', reason, terminal: true, bytes_written: 0, ...extra };
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}
function digest(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function payloadDigest(text) { return crypto.createHash('sha256').update(text, 'utf8').digest('hex'); }
function validId(id) { return typeof id === 'string' && ID.test(id); }

// Inspect only own data descriptors before reading fields or serializing. JSON cannot carry
// cycles/accessors/inheritance, but the exported construction seam can. Reject those shapes
// without traversing unknown values. This does not promise side-effect-free Proxy inspection.
function schemaContainer(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length > required.length + optional.length) return false;
  if (keys.some(k => typeof k !== 'string' || (!required.includes(k) && !optional.includes(k)))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return required.every(k => own(descriptors, k)) && keys.every(k => {
    const d = descriptors[k];
    return own(d, 'value') && d.enumerable === true;
  });
}

function validateRequestStructure(r) {
  try {
    if (!schemaContainer(r, ['schema_version', 'action_id', 'interaction_request_id', 'identity',
      'expected', 'operation', 'value', 'authority', 'expires_at'], ['pending_inject_id', 'payload_digest'])) return 'invalid_request';
    if (!schemaContainer(r.identity, ['kind', 'sid'], ['task_id', 'sandbox_attempt', 'dispatch_id'])
        || !schemaContainer(r.expected, [...FENCE_FIELDS, 'question_id'])
        || !schemaContainer(r.authority, ['provenance', 'reference'])) return 'invalid_request';
    if (r.schema_version !== 1 || !validId(r.action_id) || !validId(r.interaction_request_id)
        || !validId(r.identity.sid) || !['manual', 'task'].includes(r.identity.kind)) return 'invalid_request';
    if (r.identity.kind === 'task' && (['task_id', 'sandbox_attempt', 'dispatch_id'].some(k => !own(r.identity, k) || !validId(r.identity[k]))
        || !own(r, 'pending_inject_id') || !validId(r.pending_inject_id))) return 'wrong_attempt';
    if (r.identity.kind === 'manual' && ['task_id', 'sandbox_attempt', 'dispatch_id'].some(k => own(r.identity, k))) return 'wrong_attempt';
    if (own(r, 'pending_inject_id') !== own(r, 'payload_digest')) return 'invalid_request';
    if (own(r, 'pending_inject_id') && (!validId(r.pending_inject_id) || typeof r.payload_digest !== 'string'
        || !/^[a-f0-9]{64}$/.test(r.payload_digest))) return 'invalid_request';
    if (!['controller-policy', 'actual-human-decision'].includes(r.authority.provenance)
        || !validId(r.authority.reference)) return 'authority_required';
    if (!['key', 'text', 'select', 'toggle', 'confirm', 'cancel', 'next', 'back'].includes(r.operation)) return 'unsupported_capability';
    if (typeof r.value !== 'string' || Buffer.byteLength(r.value) > 4096) return 'invalid_request';
    if (r.operation === 'text' && /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(r.value)) return 'unsupported_capability';
    if (r.operation === 'key' && !own(KEYS, r.value)) return 'unsupported_capability';
    for (const k of ['session_epoch', 'owner_generation', 'surface_id']) {
      if (typeof r.expected[k] !== 'string' || !r.expected[k].length || r.expected[k].length > 256) return 'invalid_request';
    }
    const revision = r.expected.prompt_revision;
    if (!(typeof revision === 'string' && revision.length > 0 && revision.length <= 256)
        && !(Number.isSafeInteger(revision) && revision >= 0)) return 'invalid_request';
    if (r.expected.sid !== r.identity.sid || !validId(r.expected.question_id)
        || typeof r.expected.frame_digest !== 'string' || !/^[a-f0-9]{64}$/.test(r.expected.frame_digest)) return 'invalid_request';
    if (['credential_generation', 'input_generation', 'geometry_generation', 'cols', 'rows']
      .some(k => !Number.isSafeInteger(r.expected[k]) || r.expected[k] < 0)) return 'invalid_request';
    if (r.expected.cols < 1 || r.expected.rows < 1 || r.expected.cols > 1000 || r.expected.rows > 1000) return 'invalid_request';
    if (!Number.isSafeInteger(r.expires_at) || r.expires_at < 0) return 'invalid_request';
    // Every admitted field is now a primitive or one of three closed containers. Canonical
    // encoding does not invoke toJSON; no unsupported structure reaches serialization here.
    if (Buffer.byteLength(canonical(r)) > 16384) return 'invalid_request';
    return null;
  } catch { return 'invalid_request'; }
}

function validateRequest(r, now = Date.now()) {
  const error = validateRequestStructure(r);
  if (error) return error;
  return r.expires_at <= now || r.expires_at > now + 60000 ? 'expired' : null;
}

function unavailableObservation() {
  return { schema_version: 1, mode: 'unknown', available: false,
    reason: 'observation_unavailable', supported_operations: [], evidence: 'no_measured_current_frame_provider' };
}

// Equality is necessary but insufficient: provider provenance, expiry, authority and question
// are checked separately. No timestamp-only freshness and no inferred task binding.
function validateObservation(r, observation, binding, now = Date.now()) {
  if (!binding || binding.sid !== r.identity.sid || !binding.session_epoch
      || binding.session_epoch !== r.expected.session_epoch) return 'wrong_owner';
  if (r.identity.kind === 'task') {
    for (const k of ['task_id', 'sandbox_attempt', 'dispatch_id']) {
      if (!binding[k] || binding[k] !== r.identity[k]) return 'wrong_attempt';
    }
  }
  if (!observation || observation.available !== true || observation.current_frame !== true
      || observation.provenance !== 'measured-provider') return 'observation_unavailable';
  if (!Number.isSafeInteger(observation.expires_at) || observation.expires_at <= now) return 'expired';
  if (FENCE_FIELDS.some(k => observation[k] !== r.expected[k])) return 'stale_prompt';
  if (['sid', 'session_epoch', 'credential_generation', 'owner_generation', 'input_generation',
    'geometry_generation', 'surface_id', 'cols', 'rows'].some(k => binding[k] !== observation[k])) return 'wrong_owner';
  if (observation.question_id !== r.expected.question_id) return 'stale_prompt';
  if (!Array.isArray(observation.supported_operations) || !observation.supported_operations.includes(r.operation)) return 'unsupported_capability';
  if (['permission_trust', 'authentication_bootstrap_failure', 'unknown', 'running'].includes(observation.mode)) return 'authority_required';
  // Even a host credential does not turn a request's claim of human approval into evidence.
  if (observation.routine !== true || r.authority.provenance !== 'controller-policy') return 'authority_required';
  if (r.operation === 'text' && observation.mode !== 'text_response') return 'unsupported_capability';
  if (['select', 'toggle'].includes(r.operation)
      && (!Array.isArray(observation.option_ids) || !observation.option_ids.includes(r.value))) return 'stale_prompt';
  return null;
}

function publicReceipt(record) {
  const { action_id, request_digest, interaction_request_id, sid, stage, reason, terminal,
    bytes_written, receipt_seq, pending_inject_id, updated_at } = record;
  return { schema_version: 1, action_id, request_digest, interaction_request_id, sid, stage,
    reason, terminal, bytes_written, receipt_seq, pending_inject_id, updated_at };
}

// This is an extension of the existing ledger, not another store or delivery queue. The
// injected commit replaces the shared in-memory ledger only after its atomic save succeeds.
function createInteractionCore({ readLedger, commitLedger, observe, binding, authorize, pendingTask,
  dispatch, now = Date.now }) {
  const active = new Set();
  function uncertain(sid) {
    return Object.values(readLedger()?.interactions?.actions || {}).some(record => record.sid === sid
      && ['dispatched', 'outcome_unknown'].includes(record.stage));
  }
  function saveRecord(record, pending) {
    const ledger = readLedger();
    if (!ledger) return false;
    const interactions = ledger.interactions || { actions: {}, pending: {} };
    const next = { ...ledger, interactions: { ...interactions,
      actions: { ...interactions.actions, [record.action_id]: record },
      pending: { ...interactions.pending, ...(pending ? { [pending.inject_id]: pending } : {}) } } };
    return commitLedger(next) === true;
  }
  function lookup(id) {
    const ledger = readLedger();
    if (!ledger) return refusal('storage_unavailable');
    const actions = ledger.interactions?.actions || {};
    return own(actions, id) ? publicReceipt(actions[id]) : null;
  }
  function transition(record, stage, extra = {}) {
    const next = { ...record, stage, ...extra, receipt_seq: record.receipt_seq + 1, updated_at: now() };
    return saveRecord(next) ? next : null;
  }
  async function act(r, principal) {
    const error = validateRequest(r, now());
    // Dedup ignores expiry only for a structurally valid, previously accepted exact request.
    if (error && error !== 'expired') return refusal(error);
    if (!authorize(principal, r)) return refusal('authority_required');
    const ledger = readLedger();
    if (!ledger) return refusal('storage_unavailable');
    const hash = digest(r);
    const actions = ledger.interactions?.actions || {};
    if (own(actions, r.action_id)) return actions[r.action_id].request_digest === hash
      ? publicReceipt(actions[r.action_id]) : refusal('payload_conflict');
    if (error) return refusal(error);
    if (Object.keys(actions).length >= 10000) return refusal('busy');
    const sid = r.identity.sid;
    if (active.has(sid) || uncertain(sid)) return refusal('busy');
    active.add(sid);
    let record;
    try {
      const current = binding(sid);
      if (!current || current.sid !== sid || current.session_epoch !== r.expected.session_epoch) return refusal('wrong_owner');
      if (r.identity.kind === 'task' && ['task_id', 'sandbox_attempt', 'dispatch_id'].some(k => current[k] !== r.identity[k])) return refusal('wrong_attempt');
      let pending = null;
      if (own(r, 'pending_inject_id')) {
        pending = pendingTask(sid, r.pending_inject_id);
        if (!pending || pending.payload_digest !== r.payload_digest) return refusal('payload_conflict');
        if (typeof pending.payload !== 'string' || Buffer.byteLength(pending.payload) > 1048576
            || payloadDigest(pending.payload) !== r.payload_digest) return refusal('payload_conflict');
        pending = { ...pending, identity: r.identity, binding: { ...current }, state: 'held', retained_at: now() };
        const retained = ledger.interactions?.pending || {};
        if (own(retained, r.pending_inject_id)) {
          const prior = retained[r.pending_inject_id];
          if (prior.payload_digest !== pending.payload_digest || digest(prior.identity) !== digest(r.identity)
              || prior.binding?.session_epoch !== current.session_epoch) return refusal('payload_conflict');
          pending = prior;
        }
      }
      record = { action_id: r.action_id, request_digest: hash, interaction_request_id: r.interaction_request_id,
        sid, request: r, pending_inject_id: own(r, 'pending_inject_id') ? r.pending_inject_id : null, stage: 'prepared',
        reason: null, terminal: false, bytes_written: 0, receipt_seq: 1, updated_at: now() };
      if (!saveRecord(record, pending)) return refusal('storage_unavailable');
      const observation = observe(sid);
      const invalid = validateObservation(r, observation, binding(sid), now());
      if (invalid) {
        const refused = transition(record, 'refused', { reason: invalid, terminal: true });
        return refused ? publicReceipt(refused) : refusal('storage_unavailable');
      }
      record = transition(record, 'dispatched', { bytes_written: null });
      if (!record) return refusal('storage_unavailable');
      // Persist BEFORE crossing the write boundary. A send is not a write receipt.
      let result;
      try { result = await dispatch({ type: 'interaction', request: r, request_digest: hash }); }
      catch { result = { stage: 'outcome_unknown', reason: 'outcome_unknown', bytes_written: null }; }
      const known = result && ((result.stage === 'refused' && result.bytes_written === 0 && REFUSALS.includes(result.reason))
        || (result.stage === 'written' && Number.isSafeInteger(result.bytes_written) && result.bytes_written > 0
          && result.bytes_written <= 8192 && result.reason == null));
      const stage = known ? result.stage : 'outcome_unknown';
      const finished = transition(record, stage, { reason: known ? result.reason || null : 'outcome_unknown',
        bytes_written: known ? result.bytes_written : null, terminal: stage !== 'written' });
      return finished ? publicReceipt(finished) : refusal('storage_unavailable', {
        stage: 'outcome_unknown', bytes_written: null, action_id: r.action_id });
    } finally { active.delete(sid); }
  }
  return { act, lookup, isBusy: sid => active.has(sid) || uncertain(sid) };
}

// Synchronous final writer: no await between re-observation, fencing and write. The transport
// authenticates the owner first. A lost receipt is never permission to repeat a physical effect.
function createInteractionWriter({ observe, binding, encode, write, now = Date.now }) {
  const receipts = new Map();
  let consumedRevision = null;
  return function handle(frame) {
    const r = frame?.request;
    const error = validateRequest(r, now());
    if (error && error !== 'expired') return refusal(error);
    const hash = digest(r);
    if (hash !== frame.request_digest) return refusal('payload_conflict');
    if (receipts.has(r.action_id)) {
      const prior = receipts.get(r.action_id);
      return prior.request_digest === hash ? prior : refusal('payload_conflict');
    }
    if (error) return refusal(error);
    if (receipts.size >= 10000) return refusal('busy');
    const observation = observe();
    const invalid = validateObservation(r, observation, binding(), now());
    if (invalid) return refusal(invalid);
    // Use only the validated provider identity. Request metadata must never mint another
    // consumable revision for the same observed prompt.
    const revision = digest(Object.fromEntries([...FENCE_FIELDS, 'question_id'].map(k => [k, observation[k]])));
    if (consumedRevision === revision) return refusal('stale_prompt');
    const bytes = encode(r, observation);
    if (typeof bytes !== 'string' || !bytes.length || Buffer.byteLength(bytes) > 8192) return refusal('unsupported_capability');
    const result = { schema_version: 1, action_id: r.action_id, request_digest: hash,
      stage: 'outcome_unknown', reason: 'outcome_unknown', bytes_written: null, terminal: true };
    receipts.set(r.action_id, result);
    consumedRevision = revision;
    try {
      write(bytes);
      Object.assign(result, { stage: 'written', reason: null, bytes_written: Buffer.byteLength(bytes), terminal: false });
    } catch { /* write may have partially succeeded; never guess zero */ }
    return result;
  };
}

function invalidateInteraction(session, reason) {
  if (!session) return;
  session.interactionInputGeneration = (session.interactionInputGeneration || 0) + 1;
  if (reason === 'resize') session.interactionGeometryGeneration = (session.interactionGeometryGeneration || 0) + 1;
  session.interactionInvalidation = reason;
}

module.exports = { REFUSALS, KEYS, FENCE_FIELDS, refusal, digest, payloadDigest, validId,
  validateRequest, validateRequestStructure, validateObservation, unavailableObservation, publicReceipt,
  createInteractionCore, createInteractionWriter, invalidateInteraction };
