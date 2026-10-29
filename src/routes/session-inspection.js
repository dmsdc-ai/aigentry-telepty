// Production session inspection and batch-submit operations.
// Deliberately retains the daemon's non-strict execution semantics.
const { defaultSubmitAdmission } = require('../submit-admission');
const { readinessSnapshot } = require('../readiness');

function createSessionInspectionContext(shared, { execSync: nativeExecSync, admission = defaultSubmitAdmission } = {}) {
function serializeSession(id, session, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const idleSeconds = session.lastActivityAt ? Math.floor((nowMs - new Date(session.lastActivityAt).getTime()) / 1000) : null;
  const projectId = session.cwd ? session.cwd.split('/').pop() : null;
  const healthStatus = (0, shared.getSessionHealthStatus)(session, { nowMs });
  const healthReason = (0, shared.getSessionHealthReason)(session, healthStatus);
  const disconnectedMs = (0, shared.getSessionDisconnectedMs)(session, nowMs);
  const transport = (0, shared.buildSessionTransportBlock)(session, { nowMs });
  const semantic = (0, shared.buildSessionSemanticBlock)(session);
  const autoState = shared.sessionStateManager.getState(id);

  return {
    id,
    locator: { machine_id: shared.MACHINE_ID, session_id: id, project_id: projectId },
    type: session.type || 'spawned',
    ...(session.type === 'mailbox' ? { lease_expires_at: session.leaseExpiresAt || null } : {}),
    command: session.command,
    cwd: session.cwd,
    backend: session.backend || 'kitty',
    terminal: (0, shared.getSessionTerminalLabel)(session),
    termProgram: session.termProgram || null,
    term: session.term || null,
    cmuxWorkspaceId: session.cmuxWorkspaceId || null,
    cmuxSurfaceId: session.cmuxSurfaceId || null,
    createdAt: session.createdAt,
    lastActivityAt: session.lastActivityAt || null,
    lastConnectedAt: session.lastConnectedAt || null,
    lastDisconnectedAt: session.lastDisconnectedAt || null,
    idleSeconds,
    active_clients: session.clients ? session.clients.size : 0,
    ready: session.ready || false,
    handshake: readinessSnapshot(session, { nowMs, machineId: shared.MACHINE_ID }),
    delivery: session.delivery || null,
    deliveryEndpoint: session.deliveryEndpoint || null,
    healthStatus,
    healthReason,
    disconnectedSeconds: disconnectedMs === null ? null : Math.floor(disconnectedMs / 1000),
    lastStateReportAt: session.lastStateReportAt || null,
    idleTtl: session.idleTtl || null,
    idleTtlMs: session.idleTtlMs == null ? null : session.idleTtlMs,
    effectiveIdleTtlMs: shared.lifecycle.effectiveIdleTtlMs(session, shared.teleptyConfig),
    ownerPid: session.ownerPid || null,
    ptyPid: session.ptyPid || (session.ptyProcess && session.ptyProcess.pid) || null,
    transport,
    semantic,
    // #60 Stage A / §3.8 — BREAKING: `autoState.state:"idle"` is gone from the external surface.
    // It exported an internal FSM value that consumers read as "the turn is over", and the
    // sidebar rendered it as a GREEN sleeping pill, i.e. task success. What ships now is the
    // measured observation (named by cause, neutrally styled) and a SEPARATE completion block
    // whose fields are permanently null/false in 0.8.0. Consumers must read the two apart.
    activityObservation: autoState ? (() => {
      const cause = autoState.detail ? autoState.detail.trigger : null;
      const mapped = (0, shared.mapObservationCause)({
        destination: autoState.state,
        cause,
        evidence: { ...(autoState.detail || {}), confidence: autoState.confidence },
      });
      const display = shared.OBSERVATION_DISPLAY[mapped.kind] || shared.OBSERVATION_DISPLAY.unmapped_transition_cause;
      return {
        kind: mapped.kind,
        cause: mapped.cause,
        emoji: display.emoji,
        tone: display.tone,
        since: autoState.since,
        confidence: autoState.confidence,
        fields: mapped.fields,
      };
    })() : null,
    completion: {
      completion_fact: null,
      terminal: false,
      capability: { ...shared.CAPABILITY_STAGE_A },
    },
    mailbox: (() => {
      try {
        const pending = shared.mailbox.peek(id).filter(m => m.state === 'pending' || m.state === 'in_flight');
        const deadLetter = shared.mailbox.peekDeadLetter(id);
        return { pending: pending.length, dead_letter: deadLetter.length };
      } catch { return { pending: 0, dead_letter: 0 }; }
    })()
  };
}

function getSubmitStrategy(command) {
  const base = command.split('/').pop().split(' ')[0]; // extract binary name
  return shared.SUBMIT_STRATEGIES[base] || 'pty_cr'; // default to \r
}

function submitViaOsascript(sessionId, keyCombo) {
  const execSync = nativeExecSync === undefined ? require('child_process').execSync : nativeExecSync;
  const session = shared.sessions[sessionId];
  // Build fallback search terms: session ID, project dir name, CLI-specific patterns
  const searchTerms = [sessionId];
  if (session) {
    // Extract project name from cwd (e.g., "aigentry-deliberation" from full path)
    const projectName = session.cwd.split('/').pop();
    if (projectName) searchTerms.push(projectName);
    // CLI-specific known window titles
    if (session.command === 'codex') {
      searchTerms.push('New agent conversation', 'codex');
    }
  }

  const keyAction = keyCombo === 'cmd_enter'
    ? 'key code 36 using command down'
    : 'key code 36';

  // Try each search term until we find a matching window
  const searchTermsStr = searchTerms.map(t => `"${t}"`).join(', ');
  const script = `
    tell application "System Events"
      tell process "stable"
        set searchList to {${searchTermsStr}}
        repeat with term in searchList
          repeat with w in windows
            if name of w contains (term as text) then
              perform action "AXRaise" of w
              delay 0.3
              ${keyAction}
              return "ok:" & (name of w)
            end if
          end repeat
        end repeat
        return "window_not_found"
      end tell
    end tell`;

  try {
    const result = execSync(`osascript -e '${script}'`, { timeout: 5000 }).toString().trim();
    const ok = result.startsWith('ok:');
    if (ok) console.log(`[SUBMIT] osascript matched: ${result}`);
    return ok;
  } catch (err) {
    console.error(`[SUBMIT] osascript failed for ${sessionId}:`, err.message);
    return false;
  }
}

function runSubmitAll(sessionsMap) {
  const results = { successful: [], failed: [] };

  for (const [id, session] of Object.entries(sessionsMap)) {
    const strategy = getSubmitStrategy(session.command);
    let success = false;

    if (strategy === 'pty_cr') {
      success = (0, shared.submitViaPty)(session);
    } else if (strategy === 'osascript_cmd_enter') {
      success = submitViaOsascript(id, 'cmd_enter');
    }

    if (success) {
      results.successful.push({ id, strategy });
    } else {
      results.failed.push({ id, strategy, error: 'Submit failed' });
    }
  }

  return results;
}

function registerListRoute(app) {
app.get('/api/sessions', (req, res) => {
  const idleGt = req.query.idle_gt ? Number(req.query.idle_gt) : null;
  const now = Date.now();
  let list = Object.entries(shared.sessions).map(([id, session]) => serializeSession(id, session, { nowMs: now }));
  if (idleGt !== null) {
    list = list.filter(s => s.idleSeconds !== null && s.idleSeconds > idleGt);
  }
  res.json(list);
});
}

function registerGetRoute(app) {
app.get('/api/sessions/:id', (req, res) => {
  const requestedId = req.params.id;
  const resolvedId = (0, shared.resolveSessionAlias)(requestedId);
  if (!resolvedId) return res.status(404).json({ error: 'Session not found' });
  const session = shared.sessions[resolvedId];
  res.json({
    ...serializeSession(resolvedId, session),
    alias: requestedId !== resolvedId ? requestedId : null,
    lastInjectFrom: session.lastInjectFrom || null,
    lastInjectReplyTo: session.lastInjectReplyTo || null
  });
});
}

function registerSubmitAllRoute(app) {
app.post('/api/sessions/submit-all', (req, res) => {
  const sessionsMap = shared.sessions;
  if (Object.keys(sessionsMap).length === 0) {
    return res.json({ success: true, results: { successful: [], failed: [] } });
  }
  const admitted = admission.take();
  if (!admitted.allowed) {
    if (admitted.reason === 'rate_limited') {
      res.setHeader('Retry-After', String(admitted.retryAfter));
      return res.status(429).json({ error: 'Submit rate limit exceeded.', code: 'RATE_LIMITED' });
    }
    return res.status(503).json({ error: 'Submit admission unavailable.', code: 'SUBMIT_ADMISSION_UNAVAILABLE' });
  }
  res.json({ success: true, results: runSubmitAll(sessionsMap) });
});
}

return {
  serializeSession,
  getSubmitStrategy,
  submitViaOsascript,
  runSubmitAll,
  registerListRoute,
  registerGetRoute,
  registerSubmitAllRoute
};
}

module.exports = { createSessionInspectionContext };
