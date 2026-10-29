'use strict';
const { randomUUID } = require('node:crypto');
const unknown = reason => ({ status: 'unknown', reason });
function timestamp(value, now, ttl = 15000) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms > now) return { observed_at: null, age_ms: null, freshness: 'unknown' };
  return { observed_at: new Date(ms).toISOString(), age_ms: now - ms, freshness: now - ms <= ttl ? 'fresh' : 'stale' };
}
function processPresence(pid, kill = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return unknown('pid_unavailable');
  try { kill(pid, 0); return { status: 'exists', source: 'signal_zero', reason: 'existence_does_not_establish_running_or_responsive' }; }
  catch (error) { return { status: error.code === 'ESRCH' ? 'absent' : 'unknown', source: 'signal_zero',
    reason: error.code === 'ESRCH' ? 'process_not_found' : error.code === 'EPERM' ? 'permission_denied' : 'inspection_unavailable' }; }
}
function createSessionDiagnostics({ now = Date.now, kill = process.kill, maxWindowMs = 60000 } = {}) {
  const samples = new WeakMap();
  return (session, { machineId, sessionId, eventLoop }) => {
    const at = now(), heartbeat = timestamp(session.bridgeHeartbeatAt, at);
    const ownerGeneration = session.interactionOwnerGeneration || null;
    let previous = samples.get(session);
    const sameTarget = previous && previous.machineId === machineId && previous.sessionId === sessionId;
    const epoch = session.sessionEpoch || (sameTarget ? previous.instance : null) || randomUUID();
    const counters = { bridge_pty_bytes: Number.isFinite(session.bridgePtyBytes) && session.bridgePtyBytes >= 0 ? session.bridgePtyBytes : null,
      daemon_output_code_units: Number.isFinite(session.outputRingTotalBytes) ? session.outputRingTotalBytes : null };
    const valid = sameTarget && previous.epoch === epoch && previous.ownerGeneration === ownerGeneration && at >= previous.at && at - previous.at <= maxWindowMs;
    const delta = {};
    for (const key of Object.keys(counters)) delta[key] = valid && counters[key] !== null && previous.counters[key] !== null && counters[key] >= previous.counters[key]
      ? counters[key] - previous.counters[key] : null;
    samples.set(session, { machineId, sessionId, instance: epoch, epoch, ownerGeneration, at, counters });
    const readSide = ['open', 'closed', 'ended', 'error', 'paused'].includes(session.bridgeReadSide) ? session.bridgeReadSide : null;
    return { schema_version: 1, observed_at: new Date(at).toISOString(), read_only: true,
      identity: { machine_id: machineId, session_id: sessionId, session_epoch: session.sessionEpoch || null,
        instance_id: epoch, owner_generation: ownerGeneration, credential_generation: session.credentialGeneration || null },
      sample: { source: 'daemon_session_record', window_ms: valid ? at - previous.at : null,
        previous_observed_at: valid ? new Date(previous.at).toISOString() : null,
        freshness: 'current_record', counter_deltas: delta, counters },
      layers: {
        host_network: unknown('server_cannot_independently_measure_client_network_path'),
        daemon_api: { status: 'responding', source: 'authenticated_diagnostic_handler', observed_at: new Date(at).toISOString() },
        registration: { status: 'registered', source: 'exact_session_record',
          epoch_proof: session.sessionEpoch && session.sessionEpochProved === session.sessionEpoch ? 'proved' : 'unknown', owner_connected: session.ownerWs ? session.ownerWs.readyState === 1 : null },
        bridge_heartbeat: { status: heartbeat.freshness === 'fresh' ? 'observed' : heartbeat.freshness === 'stale' ? 'stale' : 'unknown',
          source: 'bridge_heartbeat_frame', ...heartbeat, reason: 'heartbeat_does_not_verify_pty_forwarding' },
        pty: { status: 'unknown', source: 'bridge_report_and_daemon_output_counter', bridge_read_side: readSide,
          last_actual_output: timestamp(session.lastActualOutputAt, at), last_activity: timestamp(session.lastActivityAt, at),
          forwarding: unknown('no_end_to_end_forwarding_probe'), input_write: unknown('no_correlated_write_receipt'),
          reason: 'output_silence_cannot_distinguish_waiting_suspended_hung_or_blocked_forwarding' },
        wrapped_process: { presence: processPresence(session.ptyPid || session.ptyProcess?.pid, kill),
          scheduler_state: unknown('portable_process_state_inspection_unavailable'), responsiveness: unknown('no_agent_response_probe') }
      },
      messaging: { correlation: 'no_request_selected', request_accepted: unknown('no_correlated_request'), input_written: unknown('no_correlated_write_receipt'),
        acknowledgement: unknown('no_correlated_acknowledgement'), reply: unknown('no_correlated_reply'), completion_fact: null },
      event_loop: eventLoop || unknown('telemetry_unavailable'), measured_symptoms: heartbeat.freshness === 'stale' ? ['stale_bridge_heartbeat'] : [],
      hypotheses: [], confirmed_causes: [], next_read_only_observation: 'Repeat this exact machine/session/epoch diagnostic within 60s to compare counters; inspect owner-side process state with existing permissions if needed.',
      limits: ['No active probe was sent to the wrapped agent.', 'Process existence does not establish agent responsiveness.',
        'PTY read-side strings and counters are bridge-reported; no end-to-end forwarding verification.', 'Messaging stages require a separately correlated request.'] };
  };
}
function createDiagnosticsHandler({ sessions, machineId, inspect, eventLoop = () => null }) {
  return (req, res) => {
    if (req.query.machine_id !== machineId) return res.status(409).json({ error: 'Exact machine_id required', code: 'MACHINE_MISMATCH' });
    const session = Object.hasOwn(sessions, req.params.id) ? sessions[req.params.id] : null;
    if (!session) return res.status(404).json({ error: 'Exact session ID not registered', code: 'SESSION_NOT_FOUND' });
    if (req.query.session_epoch && req.query.session_epoch !== session.sessionEpoch) return res.status(409).json({ error: 'Session epoch changed', code: 'EPOCH_MISMATCH' });
    res.json(inspect(session, { machineId, sessionId: req.params.id, eventLoop: eventLoop() }));
  };
}
module.exports = { createSessionDiagnostics, createDiagnosticsHandler, processPresence, timestamp };
