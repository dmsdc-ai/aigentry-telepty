'use strict';
const { createHash } = require('node:crypto');
const { readinessSnapshot, outputTail } = require('./readiness');
const { processState } = require('./diagnostics/process-state');
const BUS_KIND = 'session_sustained_idle_observation';
function boundedInteger(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new Error(`${name} must be ${min}..${max}`);
  return Number(value);
}
function idleObservationConfig(env = process.env) {
  return { enabled: !['0','off','false'].includes(String(env.TELEPTY_SUSTAINED_IDLE || '').toLowerCase()),
    thresholdMs: boundedInteger(env.TELEPTY_SUSTAINED_IDLE_THRESHOLD_MS, 60000, 100, 86400000, 'TELEPTY_SUSTAINED_IDLE_THRESHOLD_MS'),
    debounceMs: boundedInteger(env.TELEPTY_SUSTAINED_IDLE_DEBOUNCE_MS, 3000, 0, 60000, 'TELEPTY_SUSTAINED_IDLE_DEBOUNCE_MS'),
    freshnessMs: boundedInteger(env.TELEPTY_SUSTAINED_IDLE_FRESHNESS_MS, 300000, 100, 86400000, 'TELEPTY_SUSTAINED_IDLE_FRESHNESS_MS'),
    maxPerSweep: boundedInteger(env.TELEPTY_SUSTAINED_IDLE_MAX_PER_SWEEP, 64, 1, 256, 'TELEPTY_SUSTAINED_IDLE_MAX_PER_SWEEP') };
}
function time(value, now) { const ms = Date.parse(value); return Number.isFinite(ms) && ms <= now ? ms : null; }
function boundedTailHash(session) {
  const bytes = Buffer.from(outputTail(session), 'utf8').subarray(-16384);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    source: 'daemon_output_ring_text_tail_utf8', rendered_screen: false };
}
function classifyQuiet(session, { nowMs, freshnessMs, activityState, ready, process }) {
  const fresh = value => { const ms = time(value, nowMs); return ms !== null && nowMs - ms <= freshnessMs; };
  const connectedAt = time(session.lastConnectedAt, nowMs);
  const currentOwner = value => { const ms = time(value, nowMs); return ms !== null && (connectedAt === null || ms >= connectedAt); };
  const evidence = [];
  const result = (classification, reason) => {
    for (const fact of evidence) {
      const at = time(fact.observed_at, nowMs); fact.age_ms = at === null ? null : nowMs - at;
      fact.freshness = at === null ? 'unknown' : nowMs - at <= freshnessMs ? 'fresh' : 'stale';
    }
    return { classification, reason, evidence };
  };
  if (session.type === 'wrapped' && (!session.ownerWs || session.ownerWs.readyState !== 1)) {
    evidence.push({ source: 'daemon_owner_socket', observed_at: new Date(nowMs).toISOString(), state: 'not_open' });
    return result('transport_unavailable', 'owner_transport_not_open_observed');
  }
  if (session.bridgeReadSide === 'destroyed' && fresh(session.bridgeHeartbeatAt) && currentOwner(session.bridgeHeartbeatAt)) {
    evidence.push({ source: 'authenticated_owner_heartbeat', observed_at: session.bridgeHeartbeatAt, state: 'pty_read_stream_destroyed' });
    return result('transport_unavailable', 'pty_read_stream_destroyed_reported');
  }
  if (activityState?.detail?.trigger === 'process_exit' && fresh(activityState.detail.exit_observed_at) && currentOwner(activityState.detail.exit_observed_at)) {
    evidence.push({ source: 'pty_exit_callback', observed_at: activityState.detail.exit_observed_at, state: 'exit_observed' });
    return result('transport_unavailable', 'process_exit_observed');
  }
  if (process?.status === 'observed' && ['stopped','tracing_stop','zombie','dead'].includes(process.state) && fresh(process.observed_at)) {
    evidence.push({ source: 'linux_proc_stat', observed_at: process.observed_at, state: process.state, identity: 'pid_only_not_process_start_identity' });
    return result('transport_unavailable', 'process_scheduler_unavailable_observed');
  }
  if (ready?.status === 'blocked' && ['codex_modal_ui','claude_modal_ui'].includes(ready.reason)
      && fresh(session.lastActualOutputAt) && currentOwner(session.lastActualOutputAt)) {
    evidence.push({ source: 'known_modal_registry_over_output_text_tail', observed_at: session.lastActualOutputAt, reason: ready.reason });
    return result('awaiting_input', 'fresh_known_modal_observed');
  }
  if (['working','thinking','starting'].includes(activityState?.state)) {
    evidence.push({ source: 'session_activity_state_machine', state: activityState.state,
      observed_at: time(activityState.since, nowMs) === null ? null : activityState.since });
    return result('unknown', 'activity_state_does_not_establish_idle_or_completion');
  }
  if (ready?.ready === true && ready.reason === 'qualified_composer_observed' && fresh(ready.observed_at)
      && ready.session_epoch === session.sessionEpoch && ready.owner_generation === session.interactionOwnerGeneration) {
    evidence.push({ source: 'qualified_owner_composer_evidence', observed_at: ready.observed_at });
    return result('composer_ready', 'qualified_composer_observed_completion_unknown');
  }
  return result('unknown', 'quiet_output_is_insufficient_evidence');
}
function createSustainedIdleObserver({ enabled = true, thresholdMs = 60000, debounceMs = 3000, freshnessMs = 300000,
  maxPerSweep = 64, readiness = readinessSnapshot, inspectProcess = session => processState(session.ptyPid || session.ptyProcess?.pid) } = {}) {
  thresholdMs = boundedInteger(thresholdMs, 60000, 100, 86400000, 'thresholdMs'); debounceMs = boundedInteger(debounceMs, 3000, 0, 60000, 'debounceMs');
  freshnessMs = boundedInteger(freshnessMs, 300000, 100, 86400000, 'freshnessMs'); maxPerSweep = boundedInteger(maxPerSweep, 64, 1, 256, 'maxPerSweep');
  const states = new WeakMap(); let sweepAt = null, classified = 0;
  return { observe(id, session, { nowMs = Date.now(), machineId = null, activityState = null } = {}) {
    if (!enabled || !session) return null;
    if (sweepAt !== nowMs) { sweepAt = nowMs; classified = 0; }
    const lastOutput = time(session.lastActualOutputAt, nowMs);
    const input = Number.isSafeInteger(session.interactionInputGeneration) ? session.interactionInputGeneration : null;
    const output = Number.isFinite(session.outputRingTotalBytes) ? session.outputRingTotalBytes : null;
    const busy = ['working','thinking'].includes(activityState?.state) ? `${activityState.state}:${activityState.since || ''}` : null;
    let prior = states.get(session);
    const rebound = prior && (prior.id !== id || prior.epoch !== session.sessionEpoch || prior.owner !== session.ownerWs || prior.generation !== session.interactionOwnerGeneration);
    if (!prior || rebound) {
      prior = { id, epoch: session.sessionEpoch, owner: session.ownerWs, generation: session.interactionOwnerGeneration,
        quietSince: rebound ? nowMs : lastOutput ?? time(session.lastActivityAt, nowMs) ?? time(session.createdAt, nowMs) ?? nowMs,
        input, output, lastOutput, busy, candidate: null, fired: false };
      states.set(session, prior);
    } else if ((lastOutput !== null && lastOutput !== prior.lastOutput) || input !== prior.input || output !== prior.output || (busy && busy !== prior.busy)) {
      prior.quietSince = nowMs; prior.candidate = null; prior.fired = false;
    }
    prior.input = input; prior.output = output; prior.lastOutput = lastOutput; prior.busy = busy;
    if (nowMs < prior.quietSince) { prior.quietSince = nowMs; prior.candidate = null; }
    if (prior.fired || nowMs - prior.quietSince < thresholdMs || classified >= maxPerSweep) return null;
    classified++;
    const ready = readiness(session, { nowMs, machineId });
    const observation = classifyQuiet(session, { nowMs, freshnessMs, activityState, ready, process: inspectProcess(session) });
    const key = `${observation.classification}:${observation.reason}`;
    if (!prior.candidate || prior.candidate.key !== key) prior.candidate = { key, at: nowMs };
    if (nowMs - prior.candidate.at < debounceMs) return null;
    prior.fired = true;
    return { schema: 'telepty.sustained-idle-observation/v1', ...observation,
      identity: { machine_id: machineId, session_id: id, session_epoch: session.sessionEpoch || null, owner_generation: session.interactionOwnerGeneration || null },
      observed_at: new Date(nowMs).toISOString(), quiet_since: new Date(prior.quietSince).toISOString(), quiet_ms: nowMs - prior.quietSince,
      threshold_ms: thresholdMs, debounce_ms: debounceMs, evidence_freshness_ms: freshnessMs,
      activity_basis: 'output_or_input_generation_or_working_transition', output_tail_hash: boundedTailHash(session),
      completion_fact: null, terminal: false, recommended_action: 'read_only_inspection',
      limits: ['Silence and an unchanged output tail do not establish free, stalled, hung, or completed work.',
        'Composer readiness is not completion; modal matching uses bounded output text rather than a rendered VT screen.',
        'Process scheduler observations identify a PID, not a provider outcome or a process-start identity.'] };
  } };
}
module.exports = { BUS_KIND, idleObservationConfig, createSustainedIdleObserver, classifyQuiet, boundedTailHash };
