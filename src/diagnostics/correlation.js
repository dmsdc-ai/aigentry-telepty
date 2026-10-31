'use strict';
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const unknown = reason => ({ status: 'unknown', reason });
function correlationError(code, status) { return Object.assign(new Error(code), { code, status }); }
function correlateRequest(record, { injectId, sessionId, sessionEpoch, ownerGeneration, now }) {
  if (!ID.test(injectId)) throw correlationError('INVALID_INJECT_ID', 400);
  if (!record) throw correlationError('INJECT_NOT_OBSERVED', 404);
  if (record.inject_id !== injectId || record.session_id !== sessionId) throw correlationError('INJECT_TARGET_MISMATCH', 409);
  if (!record.session_epoch || record.session_epoch !== sessionEpoch) throw correlationError('INJECT_EPOCH_MISMATCH', 409);
  if (record.owner_generation && record.owner_generation !== ownerGeneration) throw correlationError('INJECT_OWNER_MISMATCH', 409);
  const scopedOwner = !!record.owner_generation;
  const rows = Array.isArray(record.observations) ? record.observations.slice(-50) : [];
  const observed = (row, status = 'observed') => {
    const at = Date.parse(row.at);
    if (!Number.isFinite(at) || at > now) return unknown('invalid_observation_timestamp');
    return { status, source: 'persistent_inject_observation_ledger', observed_at: new Date(at).toISOString(),
      age_ms: now - at, freshness: now - at <= 60000 ? 'fresh' : 'historical' };
  };
  const refused = rows.findLast(row => row.kind === 'inject_delivery_refused');
  const parked = rows.findLast(row => row.kind === 'inject_parked');
  const consumed = scopedOwner && !refused && rows.findLast(row => row.consumption_status === 'observed');
  // #137 — bridge stage receipts (owner- and generation-bound at the transport). They speak only
  // about the bridge queue and the PTY master write; consumption above is never derived from them.
  const bridge = rows.filter(row => row.kind === 'bridge_receipt');
  const written = part => bridge.findLast(row => row.stage === 'pty_written' && row.part === part && row.certainty === 'written');
  const bodyWritten = written('body'), submitWritten = written('submit');
  const bridgeQueued = bridge.findLast(row => row.stage === 'queued' || row.stage === 'withheld');
  const bridgeStopped = bridge.findLast(row => row.stage === 'quarantined' || row.stage === 'refused');
  const ptyWrite = row => ({ ...observed(row), stage_source: 'bridge_receipt', certainty: 'written', meaning: 'pty_master_write_only' });
  return { correlation: scopedOwner ? 'exact_instance_and_owner' : 'exact_epoch_owner_unavailable', inject_id: injectId,
    request_accepted: observed({ at: record.created_at }),
    input_written: refused?.bytes_written === 0 ? { ...observed(refused, 'not_written'), bytes_written: 0 }
      : bodyWritten ? ptyWrite(bodyWritten) : unknown('no_inject_payload_write_receipt'),
    submit_written: submitWritten ? ptyWrite(submitWritten) : unknown('no_submit_write_receipt'),
    acknowledgement: unknown('no_correlated_agent_acknowledgement_fact'),
    // Task 1215: needs a message-bound application/provider acknowledgement; PTY write, Enter and the
    // owner handshake are not one, so this stays unknown until a provider supplies it.
    instruction_received: unknown('no_message_bound_provider_acknowledgement'),
    consumption: consumed ? observed(consumed) : unknown(refused ? 'delivery_refusal_observed' : scopedOwner ? 'no_correlated_consumption_fact' : 'legacy_record_owner_generation_unrecorded'),
    reply: unknown('no_correlated_reply_fact'),
    rejection: refused ? observed(refused, 'rejected')
      : bridgeStopped ? { ...observed(bridgeStopped, 'bridge_' + bridgeStopped.stage), certainty: bridgeStopped.certainty, reason: bridgeStopped.reason || null }
      : unknown('no_delivery_rejection_observed'),
    queue: parked ? observed(parked, 'parked_observed')
      : bridgeQueued ? { ...observed(bridgeQueued, 'bridge_' + bridgeQueued.stage), reason: bridgeQueued.reason || null }
      : unknown('no_queue_observation'),
    tracking_state: ['tracked', 'aborted', 'superseded'].includes(record.tracking_state) ? record.tracking_state : 'unknown',
    completion_fact: null, limits: ['Accepted tracking is not a PTY write, agent acknowledgement, reply, or task completion.',
      'A bridge pty_written receipt is a PTY master write, not model consumption, turn acceptance or completion.',
      'Absence from bounded observation history does not establish an event never happened.'] };
}
module.exports = { correlateRequest, correlationError, validInjectId: value => typeof value === 'string' && ID.test(value) };
