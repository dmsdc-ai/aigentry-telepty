'use strict';
const registry = require('./prompt-symbol-registry');
const { remoteAgentCommand } = require('./ssh-session');

const MAX_WAIT_MS = 30000;

// Ephemeral owner observations: never persist socket references or export credentials.
const evidence = new WeakMap();
function recordReadyEvidence(session, nowMs = Date.now()) {
  evidence.set(session, { epoch: session.sessionEpoch, owner: session.ownerWs,
    generation: session.interactionOwnerGeneration, input: session.interactionInputGeneration || 0,
    geometry: session.interactionGeometryGeneration || 0, kind: session.readyKind,
    detector: session.readyDetector, cli: session.readyCliKey, sshGeneration: session.sshState?.generation, observedAt: nowMs });
}

function outputTail(session) {
  let tail = '';
  const ring = session.outputRing || [];
  // Empty/tiny output chunks must not turn a bounded tail into an unbounded scan.
  for (let i = ring.length - 1, scanned = 0; i >= 0 && tail.length < 20000 && scanned < 1024; i--, scanned++) {
    tail = String(ring[i]).slice(-(20000 - tail.length)) + tail;
  }
  return tail;
}

function readinessSnapshot(session, { nowMs = Date.now(), machineId = null } = {}) {
  const result = { schema: 'telepty.readiness/v1', session_id: session?.id || null,
    machine_id: machineId, session_epoch: session?.sessionEpoch || null,
    owner_generation: session?.interactionOwnerGeneration || null,
    ready: false, status: 'unknown', reason: 'no_current_composer_evidence',
    observed_at: null, sampled_at: new Date(nowMs).toISOString(),
    source: null, completion_fact: null, terminal: false };
  if (!session) return { ...result, status: 'not_found', reason: 'exact_session_not_found' };
  const command = remoteAgentCommand(session);
  const cli = registry.commandKey(command);
  if (session.type !== 'wrapped' || !cli) {
    return { ...result, status: 'unsupported', reason: 'qualified_composer_unavailable',
      compatibility_ready: session.ready === true };
  }
  if (session.sshRemote && session.sshState?.phase !== 'ready') return { ...result,
    status: session.sshState?.phase === 'blocked' ? 'blocked' : 'unknown', reason: session.sshState?.reason || 'ssh_waiting_for_composer' };
  if (session.isClosing) return { ...result, status: 'disconnected', reason: 'session_closing' };
  if (session.bridgeReadSide === 'destroyed') return { ...result, reason: 'pty_read_side_unavailable' };
  if (!session.ownerWs || session.ownerWs.readyState !== 1) {
    return { ...result, status: 'disconnected', reason: 'owner_disconnected' };
  }
  const modal = registry.detectSurfaceModal(command, outputTail(session));
  if (modal.blocked) return { ...result, status: 'blocked', reason: modal.reason };
  const seen = evidence.get(session);
  if (!seen) return result;
  const current = seen.epoch && seen.epoch === session.sessionEpoch
    && seen.owner === session.ownerWs && seen.generation && seen.generation === session.interactionOwnerGeneration
    && seen.input === (session.interactionInputGeneration || 0)
    && seen.geometry === (session.interactionGeometryGeneration || 0)
    && seen.sshGeneration === session.sshState?.generation;
  if (!current) return { ...result, reason: 'composer_evidence_invalidated' };
  if (seen.kind !== 'composer_surface_observed' || seen.cli !== cli || !seen.detector) {
    return { ...result, reason: 'unqualified_ready_frame' };
  }
  return { ...result, ready: true, status: 'ready', reason: 'qualified_composer_observed',
    source: 'owner_bridge', detector: seen.detector, cli_key: seen.cli,
    observed_at: new Date(seen.observedAt).toISOString() };
}

async function waitForReadiness(getSession, { timeoutMs = 0, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), machineId = null,
  expectedEpoch = null, signal } = {}) {
  const start = now();
  const initial = getSession();
  const epoch = initial?.sessionEpoch;
  const owner = initial?.ownerWs;
  const generation = initial?.interactionOwnerGeneration;
  function finish(value) { return { ...value, waited_ms: Math.max(0, now() - start) }; }
  for (;;) {
    const current = getSession();
    const snapshot = readinessSnapshot(current, { nowMs: now(), machineId });
    if (signal?.aborted) return finish({ ...snapshot, ready: false, status: 'cancelled', reason: 'request_closed' });
    if (current && ((expectedEpoch && current.sessionEpoch !== expectedEpoch)
        || current !== initial || current.sessionEpoch !== epoch || current.ownerWs !== owner
        || current.interactionOwnerGeneration !== generation)) {
      return finish({ ...snapshot, ready: false, status: 'changed', reason: 'session_instance_changed' });
    }
    if (snapshot.ready || timeoutMs === 0 || ['not_found', 'unsupported', 'blocked', 'disconnected'].includes(snapshot.status)) {
      return finish(snapshot);
    }
    const remaining = timeoutMs - (now() - start);
    if (remaining <= 0) return finish({ ...snapshot, status: 'timeout', reason: 'composer_wait_timed_out', last_reason: snapshot.reason });
    await sleep(Math.min(100, remaining));
  }
}

function registerReadinessRoute(app, { sessions, machineId }) {
  let activeWaits = 0;
  app.get('/api/sessions/:id/handshake', async (req, res) => {
    const raw = req.query.timeout_ms;
    if (raw !== undefined && (typeof raw !== 'string' || !/^\d+$/.test(raw) || Number(raw) > MAX_WAIT_MS)) {
      return res.status(400).json({ ready: false, status: 'invalid_request', reason: 'timeout_ms_must_be_0_to_30000' });
    }
    const timeoutMs = Number(raw || 0);
    const expectedEpoch = req.query.session_epoch;
    if (expectedEpoch !== undefined && (typeof expectedEpoch !== 'string' || !expectedEpoch || expectedEpoch.length > 256)) {
      return res.status(400).json({ ready: false, status: 'invalid_request', reason: 'invalid_session_epoch' });
    }
    if (timeoutMs > 0 && activeWaits >= 32) {
      return res.status(429).json({ ready: false, status: 'busy', reason: 'readiness_wait_capacity' });
    }
    const controller = new AbortController();
    const closed = () => controller.abort();
    res.once?.('close', closed);
    if (timeoutMs > 0) activeWaits++;
    try {
      const getSession = () => {
        const d = Object.getOwnPropertyDescriptor(sessions, req.params.id);
        return d && 'value' in d && d.value && typeof d.value === 'object' && !Array.isArray(d.value) ? d.value : null;
      };
      const result = await waitForReadiness(getSession, { timeoutMs, machineId, expectedEpoch, signal: controller.signal });
      if (controller.signal.aborted) return;
      const code = result.status === 'not_found' ? 404 : result.status === 'changed' ? 409
        : result.status === 'timeout' ? 408
          : timeoutMs > 0 && !result.ready ? 422 : 200;
      return res.status(code).json(result);
    } finally {
      if (timeoutMs > 0) activeWaits--;
      res.removeListener?.('close', closed);
    }
  });
}
module.exports = { outputTail, MAX_WAIT_MS, recordReadyEvidence, readinessSnapshot, waitForReadiness, registerReadinessRoute };
