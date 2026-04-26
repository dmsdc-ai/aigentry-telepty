const express = require('express');
const cors = require('cors');
const pty = require('node-pty');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { getConfig } = require('./auth');
const pkg = require('./package.json');
const { claimDaemonState, clearDaemonState } = require('./daemon-control');
const { checkEntitlement } = require('./entitlement');
const terminalBackend = require('./terminal-backend');
const { FileMailbox } = require('./src/mailbox/index');
const { DeliveryEngine } = require('./src/mailbox/delivery');
const { UnixSocketNotifier } = require('./src/mailbox/notifier');
const { SessionStateManager, STATE_DISPLAY, stripAnsi: stripAnsiState } = require('./session-state');
const { classifyReportPrompt, buildAutoSummary } = require('./src/report-enforcement');
const submitGate = require('./src/submit-gate');

const config = getConfig();
const EXPECTED_TOKEN = config.authToken;
const MACHINE_ID = process.env.TELEPTY_MACHINE_ID || os.hostname();
const net = require('net');
const fs = require('fs');
const SESSION_PERSIST_PATH = require('path').join(os.homedir(), '.config', 'aigentry-telepty', 'sessions.json');
const SESSION_STALE_SECONDS = Math.max(1, Number(process.env.TELEPTY_SESSION_STALE_SECONDS || 60));
const SESSION_CLEANUP_SECONDS = Math.max(SESSION_STALE_SECONDS, Number(process.env.TELEPTY_SESSION_CLEANUP_SECONDS || 300));
const DELIVERY_TIMEOUT_MS = Math.max(100, Number(process.env.TELEPTY_DELIVERY_TIMEOUT_MS || 5000));
const HEALTH_POLL_MS = Math.max(100, Number(process.env.TELEPTY_HEALTH_POLL_MS || 10000));

// Session state machine manager — auto-detects session state from PTY output
const sessionStateManager = new SessionStateManager({
  idle_timeout_ms:      Number(process.env.TELEPTY_STATE_IDLE_TIMEOUT_MS || 5000),
  error_repeat_count:   Number(process.env.TELEPTY_STATE_ERROR_REPEAT_COUNT || 3),
  error_window_ms:      Number(process.env.TELEPTY_STATE_ERROR_WINDOW_MS || 180000),
  thinking_timeout_ms:  Number(process.env.TELEPTY_STATE_THINKING_TIMEOUT_MS || 300000),
});

// Report enforcement config (0.2.0) — see specs/enforce-report-spec.md
const REPORT_AUTO_SUMMARY_ON_QUERY = (process.env.DELIBERATION_REPORT_AUTO_SUMMARY_ON_QUERY || 'true').toLowerCase() !== 'false';
const REPORT_AUTO_SUMMARY_LINES = Math.max(1, Number(process.env.DELIBERATION_REPORT_AUTO_SUMMARY_LINES || 40));
const REPORT_AUTO_SUMMARY_MAX_BYTES = Math.max(256, Number(process.env.DELIBERATION_REPORT_AUTO_SUMMARY_MAX_BYTES || 4096));
if (process.env.reportTimeoutSecs) {
  console.warn('[CONFIG] reportTimeoutSecs is deprecated (removed in 0.2.0) — ignored');
}

// Wrap buildAutoSummary with daemon config defaults
function buildAutoSummaryWithDefaults(session) {
  return buildAutoSummary(session, {
    maxLines: REPORT_AUTO_SUMMARY_LINES,
    maxBytes: REPORT_AUTO_SUMMARY_MAX_BYTES
  });
}

// Broadcast state transitions to the bus + fire enforcement events on idle/dead
sessionStateManager.onTransition((sessionId, from, to, detail) => {
  const session = sessions[sessionId];
  if (!session) return;
  broadcastSessionEvent('session_auto_state', sessionId, session, {
    extra: { auto_state: to, auto_state_from: from, auto_detail: detail }
  });

  // Fire TASK_IDLE_NO_REPORT on idle transition (for sessions with pendingReports).
  // Session still needs to self-inject a content REPORT — this event only observes.
  // Legacy TASK_COMPLETE text-inject is also fired for back-compat (0.2.x grandfather).
  if (to === 'idle' && pendingReports[sessionId]) {
    const pendingReport = pendingReports[sessionId];
    // Mark as idle-notified (but keep the entry — REPORT is still pending).
    // Entry is cleared when REPORT arrives (via inject endpoint) OR session dies.
    if (pendingReport.idleNotified) return; // only fire once
    pendingReport.idleNotified = true;
    pendingReport.idleAt = new Date().toISOString();

    const elapsed = ((Date.now() - new Date(pendingReport.injectedAt).getTime()) / 1000).toFixed(1);

    // New bus event: TASK_IDLE_NO_REPORT (richer observability)
    broadcastSessionEvent('TASK_IDLE_NO_REPORT', sessionId, session, {
      extra: {
        source: pendingReport.source,
        inject_id: pendingReport.injectId,
        elapsed_secs: Number(elapsed),
        injected_at: pendingReport.injectedAt
      }
    });
    console.log(`[ENFORCE-REPORT] ${sessionId} idle after ${elapsed}s — awaiting REPORT from ${pendingReport.source}`);

    // Legacy text-inject for back-compat (grandfather period 0.2.x)
    const reportMsg = `TASK_COMPLETE: ${sessionId} is now idle after processing inject (${elapsed}s)`;
    const srcId = resolveSessionAlias(pendingReport.source) || pendingReport.source;
    const srcSession = sessions[srcId];
    if (srcSession) {
      deliverInjectionToSession(srcId, srcSession, reportMsg, { noEnter: false, source: 'auto_report' });
      console.log(`[AUTO-REPORT] ${sessionId} → ${srcId}: idle after ${elapsed}s (legacy text-inject)`);
    }
  }

  // Fire TASK_DEAD_NO_REPORT when session dies with a pending report
  if (to === 'dead' && pendingReports[sessionId]) {
    const pendingReport = pendingReports[sessionId];
    delete pendingReports[sessionId];

    const autoSummary = buildAutoSummaryWithDefaults(session);
    const elapsed = ((Date.now() - new Date(pendingReport.injectedAt).getTime()) / 1000).toFixed(1);

    broadcastSessionEvent('TASK_DEAD_NO_REPORT', sessionId, session, {
      extra: {
        source: pendingReport.source,
        inject_id: pendingReport.injectId,
        elapsed_secs: Number(elapsed),
        injected_at: pendingReport.injectedAt,
        auto_summary: autoSummary,
        exit_detail: detail
      }
    });
    console.log(`[ENFORCE-REPORT] ${sessionId} died before REPORT after ${elapsed}s — auto_summary attached`);
  }
});

function persistSessions() {
  try {
    const data = {};
    for (const [id, s] of Object.entries(sessions)) {
      data[id] = {
        id,
        type: s.type,
        command: s.command,
        cwd: s.cwd,
        backend: s.backend || null,
        cmuxWorkspaceId: s.cmuxWorkspaceId || null,
        cmuxSurfaceId: s.cmuxSurfaceId || null,
        termProgram: s.termProgram || null,
        term: s.term || null,
        delivery: s.delivery || null,
        deliveryEndpoint: s.deliveryEndpoint || null,
        createdAt: s.createdAt,
        lastActivityAt: s.lastActivityAt || null,
        lastConnectedAt: s.lastConnectedAt || null,
        lastDisconnectedAt: s.lastDisconnectedAt || null,
        lastStateReportAt: s.lastStateReportAt || null,
        stateReport: s.stateReport || null
      };
    }
    fs.mkdirSync(require('path').dirname(SESSION_PERSIST_PATH), { recursive: true });
    fs.writeFileSync(SESSION_PERSIST_PATH, JSON.stringify(data, null, 2));
  } catch {}
}

function loadPersistedSessions() {
  try {
    if (!fs.existsSync(SESSION_PERSIST_PATH)) return {};
    return JSON.parse(fs.readFileSync(SESSION_PERSIST_PATH, 'utf8'));
  } catch { return {}; }
}

const app = express();
app.use(cors());
app.use(express.json());

// Peer allowlist: comma-separated IPs/CIDRs in TELEPTY_PEER_ALLOWLIST env
const PEER_ALLOWLIST = (process.env.TELEPTY_PEER_ALLOWLIST || '').split(',').map(s => s.trim()).filter(Boolean);

// Cross-machine bus relay: forward bus events to peer daemons
const RELAY_PEERS = (process.env.TELEPTY_RELAY_PEERS || '').split(',').map(s => s.trim()).filter(Boolean);
const RELAY_SEEN = new Set(); // dedup by message_id

function relayToPeers(msg) {
  if (RELAY_PEERS.length === 0) return;
  if (!msg.message_id) msg.message_id = crypto.randomUUID();
  if (RELAY_SEEN.has(msg.message_id)) return; // already relayed
  RELAY_SEEN.add(msg.message_id);
  // Prevent unbounded growth
  if (RELAY_SEEN.size > 10000) {
    const arr = [...RELAY_SEEN];
    arr.splice(0, 5000);
    RELAY_SEEN.clear();
    arr.forEach(id => RELAY_SEEN.add(id));
  }

  msg.source_host = msg.source_host || MACHINE_ID;
  msg._relayed_from = MACHINE_ID;

  for (const peer of RELAY_PEERS) {
    fetch(`http://${peer}:${PORT}/api/bus/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-telepty-token': EXPECTED_TOKEN },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(3000)
    }).catch(() => {}); // fire-and-forget
  }
}

// JWT auth: set TELEPTY_JWT_SECRET to enable. Tokens in Authorization: Bearer <token>
const JWT_SECRET = process.env.TELEPTY_JWT_SECRET || null;

function verifyJwt(token) {
  if (!JWT_SECRET || !token) return false;
  try {
    // Simple HS256 JWT verification (no external deps)
    const [headerB64, payloadB64, sigB64] = token.split('.');
    if (!headerB64 || !payloadB64 || !sigB64) return false;
    const expected = crypto.createHmac('sha256', JWT_SECRET)
      .update(`${headerB64}.${payloadB64}`).digest('base64url');
    if (sigB64 !== expected) return false;
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    if (payload.exp && Date.now() / 1000 > payload.exp) return false;
    return payload;
  } catch { return false; }
}

function isAllowedPeer(ip) {
  if (!ip) return false;
  const cleanIp = ip.replace('::ffff:', '');
  // Localhost always allowed (includes SSH tunnel traffic)
  if (cleanIp === '127.0.0.1' || ip === '::1') return true;
  // Peer allowlist
  if (PEER_ALLOWLIST.length > 0) return PEER_ALLOWLIST.includes(cleanIp);
  // No allowlist = allow all authenticated
  return true;
}

// Health check – no auth required
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: pkg.version });
});

// Authentication Middleware
app.use((req, res, next) => {
  const clientIp = req.ip;

  if (isAllowedPeer(clientIp)) {
    return next(); // Trust local and allowlisted peers (SSH tunnels arrive as localhost)
  }

  const token = req.headers['x-telepty-token'] || req.query.token;
  if (token === EXPECTED_TOKEN) {
    return next();
  }

  // JWT Bearer token
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ') && verifyJwt(authHeader.slice(7))) {
    return next();
  }

  console.warn(`[AUTH] Rejected unauthorized request from ${clientIp}`);
  res.status(401).json({ error: 'Unauthorized: Invalid or missing token.', code: 'PERMISSION_DENIED' });
});

const PORT = process.env.PORT || 3848;

const HOST = process.env.HOST || '0.0.0.0';
process.title = 'telepty-daemon';

const daemonClaim = claimDaemonState({ host: HOST, port: Number(PORT), version: pkg.version });
if (!daemonClaim.claimed) {
  const current = daemonClaim.current;
  console.log(`[DAEMON] telepty daemon already running (pid ${current.pid}, port ${current.port}). Exiting.`);
  process.exit(0);
}

const pendingReports = {}; // {targetSessionId: {source, injectedAt, injectId}}
const AUTO_REPORT_IDLE_SECONDS = Number(process.env.TELEPTY_AUTO_REPORT_IDLE_SECONDS) || 10;

const sessions = {};
const handoffs = {};
const threads = {};

function broadcastBusEvent(event) {
  const serialized = JSON.stringify(event);
  busClients.forEach((client) => {
    if (client.readyState === 1) client.send(serialized);
  });
}

function buildErrorBody(code, error, extra = {}) {
  return { success: false, code, error, ...extra };
}

function respondWithError(res, httpStatus, code, error, extra = {}) {
  return res.status(httpStatus).json(buildErrorBody(code, error, extra));
}

function isOpenWebSocket(ws) {
  return Boolean(ws && ws.readyState === 1);
}

function normalizeNullableText(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function getSessionDisconnectedMs(session, nowMs = Date.now()) {
  if (!session.lastDisconnectedAt) {
    return null;
  }

  return Math.max(0, nowMs - new Date(session.lastDisconnectedAt).getTime());
}

function getSessionHealthStatus(session, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const staleMs = (options.staleSeconds ?? SESSION_STALE_SECONDS) * 1000;
  const disconnectedMs = getSessionDisconnectedMs(session, nowMs);

  if (session.type === 'wrapped') {
    if (isOpenWebSocket(session.ownerWs)) {
      return 'CONNECTED';
    }
    if (disconnectedMs !== null && disconnectedMs >= staleMs) {
      return 'STALE';
    }
    return 'DISCONNECTED';
  }

  if (session.type === 'aterm') {
    const endpoint = session.deliveryEndpoint || (session.delivery && session.delivery.address);
    if (endpoint) {
      const isSocketPath = endpoint.startsWith('/');
      if (isSocketPath) {
        try {
          const stat = fs.statSync(endpoint);
          return stat.isSocket() ? 'CONNECTED' : 'DISCONNECTED';
        } catch {
          return 'DISCONNECTED';
        }
      }
      return 'CONNECTED';
    }
    if (disconnectedMs !== null && disconnectedMs >= staleMs) {
      return 'STALE';
    }
    return 'DISCONNECTED';
  }

  return session.ptyProcess && !session.ptyProcess.killed ? 'CONNECTED' : 'DISCONNECTED';
}

function getSessionHealthReason(session, healthStatus) {
  if (session.type === 'wrapped') {
    if (healthStatus === 'CONNECTED') return 'OWNER_CONNECTED';
    if (healthStatus === 'STALE') return 'OWNER_DISCONNECTED_STALE';
    return 'OWNER_DISCONNECTED';
  }

  if (session.type === 'aterm') {
    if (healthStatus === 'CONNECTED') return 'DELIVERY_ENDPOINT_AVAILABLE';
    if (healthStatus === 'STALE') return 'DELIVERY_ENDPOINT_STALE';
    return 'DELIVERY_ENDPOINT_MISSING';
  }

  return session.ptyProcess && !session.ptyProcess.killed ? 'PTY_RUNNING' : 'PTY_EXITED';
}

function buildSessionTransportBlock(session, options = {}) {
  if (!session) {
    return null;
  }

  const nowMs = options.nowMs ?? Date.now();
  const idleSeconds = session.lastActivityAt ? Math.floor((nowMs - new Date(session.lastActivityAt).getTime()) / 1000) : null;
  const disconnectedMs = getSessionDisconnectedMs(session, nowMs);
  const healthStatus = getSessionHealthStatus(session, { nowMs });
  const healthReason = getSessionHealthReason(session, healthStatus);

  return {
    health_status: healthStatus,
    health_reason: healthReason,
    type: session.type || 'spawned',
    backend: session.backend || 'kitty',
    terminal: getSessionTerminalLabel(session),
    active_clients: session.clients ? session.clients.size : 0,
    ready: session.ready || false,
    idle_seconds: idleSeconds,
    disconnected_seconds: disconnectedMs === null ? null : Math.floor(disconnectedMs / 1000),
    last_activity_at: session.lastActivityAt || null,
    last_connected_at: session.lastConnectedAt || null,
    last_disconnected_at: session.lastDisconnectedAt || null,
    last_inject_from: session.lastInjectFrom || null,
    last_reply_to: session.lastInjectReplyTo || null,
    last_thread_id: session.lastThreadId || null
  };
}

function buildSessionSemanticBlock(session) {
  if (!session || !session.stateReport) {
    return null;
  }

  const report = session.stateReport;
  return {
    phase: report.phase,
    current_task: report.current_task,
    blocker: report.blocker,
    needs_input: report.needs_input,
    thread_id: report.thread_id,
    source: report.source,
    seq: report.seq
  };
}

function buildSessionEvent(eventType, sessionId, session, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const timestamp = options.timestamp || new Date(nowMs).toISOString();
  return {
    type: eventType,
    event_type: eventType,
    sender: options.sender || 'daemon',
    session_id: sessionId,
    timestamp,
    transport: options.includeTransport === false ? null : buildSessionTransportBlock(session, { nowMs }),
    semantic: options.includeSemantic === false ? null : buildSessionSemanticBlock(session),
    ...(options.extra || {})
  };
}

function broadcastSessionEvent(eventType, sessionId, session, options = {}) {
  const event = buildSessionEvent(eventType, sessionId, session, options);
  broadcastBusEvent(event);
  return event;
}

function parseSessionStateReport(session, payload = {}) {
  if (!payload || typeof payload !== 'object') {
    return buildErrorBody('INVALID_REQUEST', 'state report payload must be a JSON object', { httpStatus: 400 });
  }

  const phase = normalizeNullableText(payload.phase || payload.task_phase);
  if (!phase) {
    return buildErrorBody('INVALID_REQUEST', 'phase is required', { httpStatus: 400 });
  }

  let seq;
  if (payload.seq === undefined || payload.seq === null || payload.seq === '') {
    seq = ((session && session.stateReport && session.stateReport.seq) || 0) + 1;
  } else {
    seq = Number(payload.seq);
    if (!Number.isInteger(seq) || seq < 0) {
      return buildErrorBody('INVALID_REQUEST', 'seq must be a non-negative integer', { httpStatus: 400 });
    }
  }

  if (payload.needs_input !== undefined && typeof payload.needs_input !== 'boolean') {
    return buildErrorBody('INVALID_REQUEST', 'needs_input must be a boolean', { httpStatus: 400 });
  }

  const source = normalizeNullableText(payload.source) || 'self_report';
  const timestamp = new Date().toISOString();
  return {
    success: true,
    report: {
      phase,
      current_task: normalizeNullableText(payload.current_task ?? payload.task),
      blocker: normalizeNullableText(payload.blocker),
      needs_input: payload.needs_input === true,
      thread_id: normalizeNullableText(payload.thread_id),
      source,
      seq,
      timestamp
    }
  };
}

function applySessionStateReport(sessionId, session, payload = {}) {
  const parsed = parseSessionStateReport(session, payload);
  if (!parsed.success) {
    return parsed;
  }

  session.stateReport = parsed.report;
  session.lastStateReportAt = parsed.report.timestamp;
  if (parsed.report.thread_id) {
    session.lastThreadId = parsed.report.thread_id;
  }

  const event = broadcastSessionEvent('session_state_report', sessionId, session, {
    timestamp: parsed.report.timestamp
  });
  return {
    success: true,
    event,
    semantic: buildSessionSemanticBlock(session),
    transport: buildSessionTransportBlock(session, { nowMs: Date.parse(parsed.report.timestamp) })
  };
}

function getInjectFailure(session, options = {}) {
  const healthStatus = getSessionHealthStatus(session, options);
  if (healthStatus === 'STALE') {
    return { httpStatus: 410, code: 'STALE', error: 'Session is stale and awaiting cleanup.' };
  }
  if (healthStatus === 'DISCONNECTED') {
    return { httpStatus: 503, code: 'DISCONNECTED', error: 'Session owner is disconnected.' };
  }
  return null;
}

function markSessionConnected(session, timestamp = new Date().toISOString()) {
  session.lastConnectedAt = timestamp;
  session.lastDisconnectedAt = null;
  session._staleEmitted = false;
}

function markSessionDisconnected(session, timestamp = new Date().toISOString()) {
  session.lastDisconnectedAt = timestamp;
  session.ready = false;
}

function emitSessionLifecycleEvent(type, sessionId, session, extra = {}) {
  const now = Date.now();
  broadcastSessionEvent(type, sessionId, session, {
    nowMs: now,
    extra: {
      healthStatus: getSessionHealthStatus(session, { nowMs: now }),
      healthReason: getSessionHealthReason(session, getSessionHealthStatus(session, { nowMs: now })),
      ...extra
    }
  });
}

function emitInjectFailureEvent(sessionId, code, error, extra = {}, session = null) {
  broadcastSessionEvent('inject_failed', sessionId, session, {
    extra: {
      target_agent: sessionId,
      code,
      error,
      ...extra
    }
  });
}

async function writeDataToSession(id, session, data) {
  if (session.type === 'aterm') {
    // UDS delivery via net.connect()
    if (session.delivery && session.delivery.transport === 'unix_socket' && session.delivery.address) {
      return new Promise((resolve) => {
        const payload = JSON.stringify({ action: "Inject", workspace: id, text: data }) + '\n';
        let responseBuf = '';
        const timeout = setTimeout(() => {
          sock.destroy();
          resolve(buildErrorBody('TIMEOUT', 'UDS delivery timed out.', { httpStatus: 504 }));
        }, DELIVERY_TIMEOUT_MS);
        const sock = net.connect(session.delivery.address, () => {
          sock.end(payload);
        });
        sock.on('data', (chunk) => { responseBuf += chunk.toString(); });
        sock.on('end', () => {
          clearTimeout(timeout);
          if (responseBuf) {
            try {
              const resp = JSON.parse(responseBuf.trim());
              if (resp.status === 'Error' || resp.success === false) {
                console.log(`[UDS] Delivery rejected by ${id}: ${resp.error || resp.message || 'unknown'}`);
                resolve(buildErrorBody('DELIVERY_REJECTED', resp.error || resp.message || 'Target rejected the payload.', {
                  httpStatus: 502,
                  detail: resp
                }));
                return;
              }
            } catch {
              // Non-JSON response — treat as success (legacy endpoints)
            }
          } else {
            console.log(`[UDS] Empty response from ${id} — delivery unconfirmed (aterm may not have processed)`);
          }
          resolve({ success: true });
        });
        sock.on('error', (err) => {
          clearTimeout(timeout);
          console.log(`[UDS] Connection error for ${id} at ${session.delivery.address}: ${err.message}`);
          markSessionDisconnected(session);
          resolve(buildErrorBody('DISCONNECTED', 'UDS endpoint is unreachable.', {
            httpStatus: 503,
            detail: err.message
          }));
        });
      });
    }

    // HTTP delivery (backward compat)
    if (!session.deliveryEndpoint) {
      return buildErrorBody('DISCONNECTED', 'Delivery endpoint is missing.', { httpStatus: 503 });
    }

    try {
      const response = await fetch(session.deliveryEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: data, session_id: id }),
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS)
      });

      if (!response.ok) {
        return buildErrorBody('DELIVERY_FAILED', `Delivery endpoint returned ${response.status}.`, {
          httpStatus: 502,
          deliveryStatus: response.status
        });
      }

      return { success: true };
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        return buildErrorBody('TIMEOUT', 'Delivery endpoint timed out.', { httpStatus: 504 });
      }
      return buildErrorBody('DISCONNECTED', 'Delivery endpoint is unreachable.', {
        httpStatus: 503,
        detail: error.message
      });
    }
  }

  if (session.type === 'wrapped') {
    if (!isOpenWebSocket(session.ownerWs)) {
      return buildErrorBody('DISCONNECTED', 'Session owner is disconnected.', { httpStatus: 503 });
    }
    session.ownerWs.send(JSON.stringify({ type: 'inject', data }));
    return { success: true };
  }

  if (!session.ptyProcess || session.ptyProcess.killed) {
    return buildErrorBody('DISCONNECTED', 'PTY process is not connected.', { httpStatus: 503 });
  }

  session.ptyProcess.write(data);
  return { success: true };
}

/**
 * Submit Enter to a session using terminal-level methods.
 * Used by POST /submit endpoint for explicit terminal-level submit.
 * Priority: kitty send-text → cmux send-key → PTY \r fallback.
 * Returns the strategy name or null on failure.
 */
function terminalLevelSubmit(id, session) {
  // Priority 1: kitty send-text (terminal-level, bypasses PTY raw mode quirks)
  if (session.type === 'wrapped' && sendViaKitty(id, '\r')) return 'kitty';
  // Priority 2: cmux send-key
  if (session.backend === 'cmux' && session.cmuxWorkspaceId && submitViaCmux(id)) return 'cmux';
  // Priority 3: PTY \r
  if (submitViaPty(session)) return 'pty_cr';
  return null;
}

async function deliverInjectionToSession(id, session, prompt, options = {}) {
  const now = Date.now();
  const injectFailure = getInjectFailure(session, { nowMs: now });
  if (injectFailure) {
    return { success: false, ...injectFailure };
  }

  // Mailbox payload is TEXT ONLY — CR is sent separately after a delay.
  // Reason: combining text+CR in one write triggers bracketed paste mode in modern
  // terminals. CLIs ignore \r inside paste brackets, so Enter never fires.
  const from = options.from || 'daemon';
  const msgId = `${from}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;

  try {
    const ack = mailbox.enqueue({
      msg_id: msgId,
      from,
      to: id,
      payload: prompt,
      created_at: Math.floor(now / 1000),
      attempt: 0,
    });

    // Notify aterm sessions immediately via UDS wake
    if (session.type === 'aterm') {
      mailboxNotifier.notify(id);
    }

    // Deliver text synchronously — ensures text is written before inject returns success.
    try {
      await mailboxDelivery.tick();
    } catch {}

    // Send CR separately after delay (outside paste brackets)
    if (!options.noEnter && session.type !== 'aterm') {
      const submitDelay = session.type === 'wrapped' ? 500 : 300;
      setTimeout(async () => {
        const submitResult = await writeDataToSession(id, session, '\r');
        if (!submitResult.success) {
          emitInjectFailureEvent(id, submitResult.code, submitResult.error, {
            phase: 'submit',
            source: options.source || 'inject'
          }, session);
        }
      }, submitDelay);
    }

    session.lastActivityAt = new Date(now).toISOString();
    return {
      success: true,
      msg_id: msgId,
      queued: ack.queued,
      pending: ack.pending,
      strategy: 'mailbox',
      submit: options.noEnter ? 'skipped' : 'deferred'
    };
  } catch (err) {
    console.error(`[MAILBOX] Enqueue failed for ${id}: ${err.message}`);
    // Fallback: direct delivery (backward compat during migration)
    const textResult = await writeDataToSession(id, session, prompt);
    if (!textResult.success) return textResult;

    if (!options.noEnter && session.type !== 'aterm') {
      const submitDelay = session.type === 'wrapped' ? 500 : 300;
      setTimeout(async () => {
        const submitResult = await writeDataToSession(id, session, '\r');
        if (!submitResult.success) {
          emitInjectFailureEvent(id, submitResult.code, submitResult.error, {
            phase: 'submit',
            source: options.source || 'inject'
          }, session);
        }
      }, submitDelay);
    }

    session.lastActivityAt = new Date(now).toISOString();
    return {
      success: true,
      strategy: 'direct_fallback',
      submit: options.noEnter ? 'skipped' : 'deferred'
    };
  }
}

function appendToOutputRing(session, data) {
  if (!session.outputRing) session.outputRing = [];
  session.outputRing.push(data);
  // Keep total data under ~200KB limit by trimming old entries
  let totalLen = session.outputRing.reduce((sum, d) => sum + d.length, 0);
  while (totalLen > 200000 && session.outputRing.length > 1) {
    totalLen -= session.outputRing[0].length;
    session.outputRing.shift();
  }
}

function getSessionTerminalLabel(session) {
  if (session.termProgram) {
    return session.termProgram;
  }

  const term = String(session.term || '').toLowerCase();
  if (term.includes('kitty')) return 'kitty';
  if (term.includes('ghostty')) return 'ghostty';
  if (term.includes('tmux')) return 'tmux';

  if (session.type === 'aterm') return 'aterm';
  if (session.backend === 'cmux') return 'cmux';
  if (session.backend === 'kitty') return 'kitty';
  if ((session.type || 'spawned') === 'spawned') return 'daemon-pty';

  return null;
}

function serializeSession(id, session, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const idleSeconds = session.lastActivityAt ? Math.floor((nowMs - new Date(session.lastActivityAt).getTime()) / 1000) : null;
  const projectId = session.cwd ? session.cwd.split('/').pop() : null;
  const healthStatus = getSessionHealthStatus(session, { nowMs });
  const healthReason = getSessionHealthReason(session, healthStatus);
  const disconnectedMs = getSessionDisconnectedMs(session, nowMs);
  const transport = buildSessionTransportBlock(session, { nowMs });
  const semantic = buildSessionSemanticBlock(session);
  const autoState = sessionStateManager.getState(id);

  return {
    id,
    locator: { machine_id: MACHINE_ID, session_id: id, project_id: projectId },
    type: session.type || 'spawned',
    command: session.command,
    cwd: session.cwd,
    backend: session.backend || 'kitty',
    terminal: getSessionTerminalLabel(session),
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
    delivery: session.delivery || null,
    deliveryEndpoint: session.deliveryEndpoint || null,
    healthStatus,
    healthReason,
    disconnectedSeconds: disconnectedMs === null ? null : Math.floor(disconnectedMs / 1000),
    lastStateReportAt: session.lastStateReportAt || null,
    transport,
    semantic,
    autoState: autoState ? {
      state: autoState.state,
      emoji: (STATE_DISPLAY[autoState.state] || {}).emoji || '?',
      since: autoState.since,
      confidence: autoState.confidence,
      detail: autoState.detail,
    } : null,
    mailbox: (() => {
      try {
        const pending = mailbox.peek(id).filter(m => m.state === 'pending' || m.state === 'in_flight');
        const deadLetter = mailbox.peekDeadLetter(id);
        return { pending: pending.length, dead_letter: deadLetter.length };
      } catch { return { pending: 0, dead_letter: 0 }; }
    })()
  };
}

// Detect terminal environment at daemon startup
const DETECTED_TERMINAL = terminalBackend.detectTerminal();
console.log(`[DAEMON] Terminal backend: ${DETECTED_TERMINAL}`);

// Restore persisted session metadata (wrapped sessions await reconnect)
const _persisted = loadPersistedSessions();
for (const [id, meta] of Object.entries(_persisted)) {
  if (meta.type === 'wrapped') {
    sessions[id] = {
      id, type: 'wrapped', ptyProcess: null, ownerWs: null,
      command: meta.command || 'wrapped', cwd: meta.cwd || process.cwd(),
      backend: meta.backend || 'kitty',
      cmuxWorkspaceId: meta.cmuxWorkspaceId || null,
      cmuxSurfaceId: meta.cmuxSurfaceId || null,
      termProgram: meta.termProgram || null,
      term: meta.term || null,
      createdAt: meta.createdAt || new Date().toISOString(),
      lastActivityAt: meta.lastActivityAt || new Date().toISOString(),
      lastConnectedAt: meta.lastConnectedAt || null,
      lastDisconnectedAt: meta.lastDisconnectedAt || meta.lastActivityAt || new Date().toISOString(),
      lastStateReportAt: meta.lastStateReportAt || null,
      stateReport: meta.stateReport || null,
      clients: new Set(), isClosing: false, outputRing: [], ready: true,     };
    console.log(`[PERSIST] Restored session ${id} (awaiting reconnect)`);
  }
}
const STRIPPED_SESSION_ENV_KEYS = [
  'CLAUDECODE',
  'CODEX_CI',
  'CODEX_THREAD_ID'
];

function buildSessionEnv(sessionId) {
  const env = {
    ...process.env,
    TERM: os.platform() === 'win32' ? undefined : 'xterm-256color',
    TELEPTY_SESSION_ID: sessionId
  };

  for (const key of STRIPPED_SESSION_ENV_KEYS) {
    delete env[key];
  }

  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDECODE_')) {
      delete env[key];
    }
  }

  return env;
}

// Stable alias routing: resolve alias to latest session with matching prefix
function resolveSessionAlias(requestedId) {
  // Exact match first
  if (sessions[requestedId]) return requestedId;

  // Strip trailing version number to get base alias (e.g., "aigentry-dustcraw-002" → "aigentry-dustcraw")
  // Also handles bare alias like "aigentry-dustcraw"
  const baseAlias = requestedId.replace(/-\d+$/, '');

  // Find all sessions matching the base alias
  const candidates = Object.keys(sessions).filter(id => {
    const candidateBase = id.replace(/-\d+$/, '');
    return candidateBase === baseAlias;
  });

  if (candidates.length === 0) return null;

  // Return the most recently created session
  candidates.sort((a, b) => {
    const timeA = new Date(sessions[a].createdAt).getTime();
    const timeB = new Date(sessions[b].createdAt).getTime();
    return timeB - timeA;
  });
  return candidates[0];
}

app.post('/api/sessions/spawn', (req, res) => {
  const { session_id, command, args = [], cwd = process.cwd(), cols = 80, rows = 30, type = 'AGENT' } = req.body;
  if (!session_id) return res.status(400).json({ error: 'session_id is strictly required.' });
  if (sessions[session_id]) return res.status(409).json({ error: `Session ID '${session_id}' is already active.` });
  if (!command) return res.status(400).json({ error: 'command is required' });

  const isWin = os.platform() === 'win32';
  const shell = isWin ? (command === 'powershell' ? 'powershell.exe' : 'cmd.exe') : command;
  const shellArgs = isWin ? (command === 'powershell' || command === 'cmd' ? args : ['/c', command, ...args]) : args;

  try {
    console.log(`[SPAWN] Spawning ${shell} with args:`, shellArgs, "in cwd:", cwd);

    const customEnv = buildSessionEnv(session_id);
    
    if (!isWin) {
      const label = type.toUpperCase();
      const colorCode = label === 'USER' ? '32' : '35'; // USER: Green (32), AGENT: Magenta (35)
      const zshColor = label === 'USER' ? 'green' : 'magenta';

      if (command.includes('bash')) {
        customEnv.PS1 = `\\[\\e[${colorCode}m\\][${label}: ${session_id}]\\[\\e[0m\\] \\w \\$ `;
      } else if (command.includes('zsh')) {
        customEnv.DISABLE_AUTO_TITLE = 'true';
        customEnv.PROMPT = `%F{${zshColor}}[${label}: ${session_id}]%f %~ %# `;
      }
    }

    const ptyProcess = pty.spawn(shell, shellArgs, {
      name: isWin ? 'Windows Terminal' : 'xterm-256color',
      cols: parseInt(cols),
      rows: parseInt(rows),
      cwd,
      env: customEnv
    });

    const sessionRecord = {
      id: session_id,
      type: 'spawned',
      ptyProcess,
      command,
      cwd,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      lastConnectedAt: new Date().toISOString(),
      lastDisconnectedAt: null,
      lastStateReportAt: null,
      stateReport: null,
      clients: new Set(),
      isClosing: false,
      outputRing: [],
      ready: true,
          };
    sessions[session_id] = sessionRecord;

    // Broadcast session creation to bus
    const spawnMsg = JSON.stringify({
      type: 'session_spawn',
      sender: 'daemon',
      session_id,
      command,
      cwd,
      timestamp: new Date().toISOString()
    });
    busClients.forEach(client => {
      if (client.readyState === 1) client.send(spawnMsg);
    });

    ptyProcess.onData((data) => {
      const currentSession = sessions[sessionRecord.id];
      if (!currentSession || currentSession !== sessionRecord) {
        return;
      }

      appendToOutputRing(currentSession, data);
      sessionStateManager.feed(sessionRecord.id, data);

      // Send to direct WS clients
      currentSession.clients.forEach(ws => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'output', data }));
      });
    });

    // Register session with state machine
    sessionStateManager.register(session_id);

    ptyProcess.onExit(({ exitCode, signal }) => {
      const currentId = sessionRecord.id;
      console.log(`[EXIT] Session ${currentId} exited with code ${exitCode}`);
      sessionStateManager.markDead(currentId, exitCode, signal);
      sessionRecord.isClosing = true;
      sessionRecord.clients.forEach(ws => ws.close(1000, 'Session exited'));
      if (sessions[currentId] === sessionRecord) {
        delete sessions[currentId];
        sessionStateManager.unregister(currentId);
      }
    });

    console.log(`[SPAWN] Created session ${session_id} (${command})`);
    persistSessions();
    res.status(201).json({ session_id, command, cwd });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions/register', (req, res) => {
  const { session_id, command, cwd = process.cwd(), backend, cmux_workspace_id, cmux_surface_id, term_program, term } = req.body;
  if (!session_id) return res.status(400).json({ error: 'session_id is required' });
  // Idempotent: allow re-registration (update command/cwd, keep clients)
  if (sessions[session_id]) {
    const existing = sessions[session_id];
    if (command) existing.command = command;
    if (cwd) existing.cwd = cwd;
    if (backend) existing.backend = backend;
    if (cmux_workspace_id) existing.cmuxWorkspaceId = cmux_workspace_id;
    if (cmux_surface_id) existing.cmuxSurfaceId = cmux_surface_id;
    if (Object.prototype.hasOwnProperty.call(req.body, 'term_program')) existing.termProgram = term_program || null;
    if (Object.prototype.hasOwnProperty.call(req.body, 'term')) existing.term = term || null;
    if (req.body.delivery_type) existing.type = req.body.delivery_type;
    if (req.body.delivery_endpoint) existing.deliveryEndpoint = req.body.delivery_endpoint;
    if (req.body.delivery) {
      existing.delivery = req.body.delivery;
      if (!existing.deliveryEndpoint && req.body.delivery.address) {
        existing.deliveryEndpoint = req.body.delivery.address;
      }
    }
    if (req.body.delivery_type === 'aterm') {
      existing.ready = true;
      markSessionConnected(existing);
    }
    console.log(`[REGISTER] Re-registered session ${session_id} (type: ${existing.type}, updated metadata)`);
    return res.status(200).json({ session_id, type: existing.type, command: existing.command, cwd: existing.cwd, reregistered: true });
  }

  const { delivery_type, delivery_endpoint, delivery } = req.body;
  const resolvedEndpoint = delivery_endpoint || (delivery && delivery.address) || null;
  const sessionRecord = {
    id: session_id,
    type: delivery_type || 'wrapped',
    ptyProcess: null,
    ownerWs: null,
    command: command || 'wrapped',
    cwd,
    backend: backend || 'kitty',
    cmuxWorkspaceId: cmux_workspace_id || null,
    cmuxSurfaceId: cmux_surface_id || null,
    termProgram: term_program || null,
    term: term || null,
    delivery: delivery || null,
    deliveryEndpoint: resolvedEndpoint,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    lastConnectedAt: delivery_type === 'aterm' ? new Date().toISOString() : null,
    lastDisconnectedAt: delivery_type === 'aterm' ? null : new Date().toISOString(),
    lastStateReportAt: null,
    stateReport: null,
    clients: new Set(),
    isClosing: false,
    outputRing: [],
    ready: true,  // all sessions are injectable once registered (#150)
      };
  // Check for existing session with same base alias and emit replaced event
  const baseAlias = session_id.replace(/-\d+$/, '');
  const replaced = Object.keys(sessions).find(id => {
    return id !== session_id && id.replace(/-\d+$/, '') === baseAlias;
  });
  if (replaced) {
    const replacedMsg = JSON.stringify({
      type: 'session.replaced',
      sender: 'daemon',
      old_id: replaced,
      new_id: session_id,
      alias: baseAlias,
      timestamp: new Date().toISOString()
    });
    busClients.forEach(client => {
      if (client.readyState === 1) client.send(replacedMsg);
    });
    console.log(`[ALIAS] Session '${replaced}' replaced by '${session_id}' (alias: ${baseAlias})`);
  }

  sessions[session_id] = sessionRecord;
  sessionStateManager.register(session_id);

  const busMsg = JSON.stringify({
    type: 'session_register',
    sender: 'daemon',
    session_id,
    command: sessionRecord.command,
    cwd,
    timestamp: new Date().toISOString()
  });
  busClients.forEach(client => {
    if (client.readyState === 1) client.send(busMsg);
  });

  console.log(`[REGISTER] Registered wrapped session ${session_id}`);
  persistSessions();
  res.status(201).json({ session_id, type: 'wrapped', command: sessionRecord.command, cwd });
});

app.get('/api/sessions', (req, res) => {
  const idleGt = req.query.idle_gt ? Number(req.query.idle_gt) : null;
  const now = Date.now();
  let list = Object.entries(sessions).map(([id, session]) => serializeSession(id, session, { nowMs: now }));
  if (idleGt !== null) {
    list = list.filter(s => s.idleSeconds !== null && s.idleSeconds > idleGt);
  }
  res.json(list);
});

app.get('/api/sessions/:id', (req, res) => {
  const requestedId = req.params.id;
  const resolvedId = resolveSessionAlias(requestedId);
  if (!resolvedId) return res.status(404).json({ error: 'Session not found' });
  const session = sessions[resolvedId];
  res.json({
    ...serializeSession(resolvedId, session),
    alias: requestedId !== resolvedId ? requestedId : null,
    lastInjectFrom: session.lastInjectFrom || null,
    lastInjectReplyTo: session.lastInjectReplyTo || null
  });
});

// Auto-detected session state (from PTY output pattern analysis)
app.get('/api/sessions/:id/state', (req, res) => {
  const requestedId = req.params.id;
  const resolvedId = resolveSessionAlias(requestedId);
  if (!resolvedId) return respondWithError(res, 404, 'SESSION_NOT_FOUND', 'Session not found', { requested: requestedId });
  if (!sessions[resolvedId]) return respondWithError(res, 404, 'SESSION_NOT_FOUND', 'Session not found', { requested: requestedId });

  const autoState = sessionStateManager.getState(resolvedId);
  const session = sessions[resolvedId];
  const semantic = buildSessionSemanticBlock(session);

  res.json({
    session_id: resolvedId,
    auto: autoState
      ? { ...autoState, emoji: (STATE_DISPLAY[autoState.state] || {}).emoji || '?' }
      : { state: 'unknown', emoji: '?', detail: 'no state machine registered' },
    self_report: semantic,
    last_state_report_at: session.lastStateReportAt || null,
  });
});

// Self-reported session state (explicit POST from session)
app.post('/api/sessions/:id/state', (req, res) => {
  const requestedId = req.params.id;
  const resolvedId = resolveSessionAlias(requestedId);
  if (!resolvedId) return respondWithError(res, 404, 'SESSION_NOT_FOUND', 'Session not found', { requested: requestedId });
  const session = sessions[resolvedId];
  const applied = applySessionStateReport(resolvedId, session, req.body);
  if (!applied.success) {
    return respondWithError(res, applied.httpStatus || 400, applied.code || 'INVALID_REQUEST', applied.error);
  }

  persistSessions();
  res.json({
    success: true,
    session_id: resolvedId,
    transport: applied.transport,
    semantic: applied.semantic
  });
});

app.get('/api/meta', (req, res) => {
  res.json({
    name: pkg.name,
    version: pkg.version,
    pid: process.pid,
    host: HOST,
    port: Number(PORT),
    machine_id: MACHINE_ID,
    terminal: DETECTED_TERMINAL,
    capabilities: ['sessions', 'wrapped-sessions', 'skill-installer', 'singleton-daemon', 'handoff-inbox', 'deliberation-threads', 'cross-machine', 'mailbox']
  });
});

// --- Mailbox API endpoints ---

app.get('/api/sessions/:id/mailbox', (req, res) => {
  const id = resolveSessionAlias(req.params.id);
  if (!id || !sessions[id]) return res.status(404).json({ error: 'Session not found' });
  try {
    const pending = mailbox.peek(id);
    const deadLetter = mailbox.peekDeadLetter(id);
    res.json({ session_id: id, pending, dead_letter: deadLetter });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions/:id/mailbox/ack', (req, res) => {
  const id = resolveSessionAlias(req.params.id);
  if (!id || !sessions[id]) return res.status(404).json({ error: 'Session not found' });
  const { msg_id } = req.body;
  if (!msg_id) return res.status(400).json({ error: 'msg_id is required' });
  try {
    mailbox.ack(id, msg_id);
    res.json({ success: true, msg_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sessions/:id/mailbox', (req, res) => {
  const id = resolveSessionAlias(req.params.id);
  if (!id || !sessions[id]) return res.status(404).json({ error: 'Session not found' });
  try {
    mailbox.purge(id);
    res.json({ success: true, session_id: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sessions/:id/mailbox/dead-letter', (req, res) => {
  const id = resolveSessionAlias(req.params.id);
  if (!id || !sessions[id]) return res.status(404).json({ error: 'Session not found' });
  try {
    mailbox.purgeDeadLetter(id);
    res.json({ success: true, session_id: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Peer management endpoint (for cross-machine module)
app.get('/api/peers', (req, res) => {
  try {
    const crossMachine = require('./cross-machine');
    res.json({
      active: crossMachine.listActivePeers(),
      known: crossMachine.listKnownPeers()
    });
  } catch {
    res.json({ active: [], known: {} });
  }
});

app.post('/api/sessions/multicast/inject', async (req, res) => {
  const { session_ids, prompt } = req.body;
  if (typeof prompt !== 'string' || prompt.length === 0) return respondWithError(res, 400, 'INVALID_REQUEST', 'prompt is required');
  if (!Array.isArray(session_ids)) return res.status(400).json({ error: 'session_ids must be an array' });

  const results = { successful: [], failed: [] };

  for (const id of session_ids) {
    const session = sessions[id];
    if (session) {
      try {
        const delivery = await deliverInjectionToSession(id, session, prompt, {
          source: 'multicast'
        });
        if (!delivery.success) {
          results.failed.push({ id, code: delivery.code, error: delivery.error });
          continue;
        }

        results.successful.push({ id, strategy: delivery.strategy });

        // Broadcast injection to bus
        broadcastBusEvent({
          type: 'injection',
          sender: 'cli',
          target_agent: id,
          content: prompt,
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        results.failed.push({ id, code: 'DELIVERY_FAILED', error: err.message });
      }
    } else {
      results.failed.push({ id, code: 'SESSION_NOT_FOUND', error: 'Session not found' });
    }
  }

  res.json({ success: true, results });
});

app.post('/api/sessions/broadcast/inject', async (req, res) => {
  const { prompt } = req.body;
  if (typeof prompt !== 'string' || prompt.length === 0) return respondWithError(res, 400, 'INVALID_REQUEST', 'prompt is required');

  const results = { successful: [], failed: [] };

  for (const id of Object.keys(sessions)) {
    const session = sessions[id];
    try {
      const delivery = await deliverInjectionToSession(id, session, prompt, {
        source: 'broadcast'
      });
      if (!delivery.success) {
        results.failed.push({ id, code: delivery.code, error: delivery.error });
        continue;
      }

      results.successful.push({ id, strategy: delivery.strategy });
    } catch (err) {
      results.failed.push({ id, code: 'DELIVERY_FAILED', error: err.message });
    }
  }

  // Send a single bus event for the entire broadcast (not per-session)
  if (results.successful.length > 0) {
    const busMsg = JSON.stringify({
      type: 'injection',
      sender: 'cli',
      target_agent: 'all',
      content: prompt,
      session_ids: results.successful,
      timestamp: new Date().toISOString()
    });
    busClients.forEach(client => {
      if (client.readyState === 1) client.send(busMsg);
    });
  }

  res.json({ success: true, results });
});

// CLI-specific submit strategies
// All CLIs submit via PTY \r when running inside telepty allow bridge
const SUBMIT_STRATEGIES = {
  claude: 'pty_cr',
  gemini: 'pty_cr',
  codex: 'pty_cr',
};

function getSubmitStrategy(command) {
  const base = command.split('/').pop().split(' ')[0]; // extract binary name
  return SUBMIT_STRATEGIES[base] || 'pty_cr'; // default to \r
}

function submitViaPty(session) {
  if (session.type === 'wrapped') {
    if (session.ownerWs && session.ownerWs.readyState === 1) {
      session.ownerWs.send(JSON.stringify({ type: 'inject', data: '\r' }));
      return true;
    }
    return false;
  } else {
    session.ptyProcess.write('\r');
    return true;
  }
}

// Send text directly to Kitty tab via remote control (bypasses allow bridge entirely)
function findKittySocket() {
  try {
    const files = require('fs').readdirSync('/tmp').filter(f => f.startsWith('kitty-sock'));
    return files.length > 0 ? '/tmp/' + files[0] : null;
  } catch { return null; }
}

function findKittyWindowId(socket, sessionId) {
  const { execSync } = require('child_process');
  try {
    const raw = execSync(`kitty @ --to unix:${socket} ls`, { timeout: 3000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const data = JSON.parse(raw);
    for (const osw of data) {
      for (const tab of osw.tabs) {
        for (const w of tab.windows) {
          // Only check process cmdlines for --id SESSION_ID pattern (not output text)
          for (const p of (w.foreground_processes || [])) {
            const cmd = (p.cmdline || []).join(' ');
            if (cmd.includes('--id ' + sessionId) || cmd.includes('--id=' + sessionId)) {
              return w.id;
            }
          }
        }
      }
    }
  } catch {}
  return null;
}

function sendViaKitty(sessionId, text) {
  const { execSync } = require('child_process');
  const socket = findKittySocket();
  if (!socket) return false;

  const windowId = findKittyWindowId(socket, sessionId);
  if (!windowId) {
    console.error(`[KITTY] No window found for ${sessionId}`);
    return false;
  }

  try {
    // Split text and CR — send-text for both (send-key corrupts keyboard protocol)
    const hasCr = text.endsWith('\r') || text.endsWith('\n');
    const textOnly = hasCr ? text.slice(0, -1) : text;
    if (textOnly.length > 0) {
      const escaped = textOnly.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
      execSync(`kitty @ --to unix:${socket} send-text --match id:${windowId} '${escaped}'`, {
        timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
      });
    }
    if (hasCr) {
      // Delay before sending Return — only when text was sent in the same call
      // (when CR-only, text was already delivered via a different path)
      if (textOnly.length > 0) {
        execSync('sleep 0.5', { timeout: 2000 });
      }
      execSync(`kitty @ --to unix:${socket} send-text --match id:${windowId} $'\\r'`, {
        timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
      });
    }
    console.log(`[KITTY] Sent ${textOnly.length} chars${hasCr ? ' + Return' : ''} to ${sessionId} (window ${windowId})`);
    return true;
  } catch (err) {
    console.error(`[KITTY] Failed for ${sessionId}:`, err.message);
    return false;
  }
}

function submitViaOsascript(sessionId, keyCombo) {
  const { execSync } = require('child_process');
  const session = sessions[sessionId];
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

function submitViaCmux(sessionId) {
  const { execSync } = require('child_process');
  const session = sessions[sessionId];
  if (!session || !session.cmuxWorkspaceId) return false;
  try {
    execSync(`cmux send-key --workspace ${session.cmuxWorkspaceId} return`, {
      timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
    });
    console.log(`[SUBMIT] cmux send-key return for ${sessionId} (workspace ${session.cmuxWorkspaceId})`);
    return true;
  } catch (err) {
    console.error(`[SUBMIT] cmux send-key failed for ${sessionId}:`, err.message);
    return false;
  }
}

// POST /api/sessions/:id/submit — render-gated CLI-aware submit
//
// Default behavior (0.3.0+): wait for the target REPL to be ready (sessionStateManager
// reports `idle`/`waiting` with confidence ≥ 0.85) before firing Enter. When the
// caller passes `injected_body`, also verify the body has been consumed (i.e.
// disappeared from the input box) by polling the session output ring; if still
// visible, perform one bounded retry.
//
// Why HTTP 504 (not 503 or 408)?
//   - 503 already used by this endpoint to mean "all dispatch strategies failed"
//     (kitty/cmux/PTY couldn't even fire Enter). Reusing 503 would conflate
//     "we never attempted" with "we attempted and failed".
//   - 408 (Request Timeout) describes a timeout on the *request itself*; here
//     the request was processed in time, but the *upstream* (target REPL) did
//     not become ready. 504 (Gateway Timeout) precisely describes "we acted as
//     a gateway/proxy to the REPL, and the upstream did not respond in time".
//   - This is an additive change to existing endpoint semantics — minor bump.
//
// Legacy (blind retry) path is preserved as an escape hatch via the
// TELEPTY_SUBMIT_GATE=off env var, for parity testing and rollback.
//
// See: docs/superpowers/specs/2026-04-26-inject-submit-enter-reliability.md
app.post('/api/sessions/:id/submit', async (req, res) => {
  const requestedId = req.params.id;
  const resolvedId = resolveSessionAlias(requestedId);
  if (!resolvedId) return res.status(404).json({ error: 'Session not found', requested: requestedId });
  const session = sessions[resolvedId];
  const id = resolvedId;

  const retries = Math.min(Math.max(Number(req.body?.retries) || 0, 0), 3);
  const retryDelayMs = Math.min(Math.max(Number(req.body?.retry_delay_ms) || 500, 100), 2000);
  const preDelayMs = Math.min(Math.max(Number(req.body?.pre_delay_ms) || 0, 0), 1000);
  // Default raised 5000 → 10000 (0.3.1) to cover empirical claude REPL
  // ready window (3-6s on fresh spawn) with margin. Upper clamp raised
  // 15000 → 30000 for the rare extreme-cold case.
  const gateTimeoutMs = Math.min(Math.max(Number(req.body?.gate_timeout_ms) || 10000, 500), 30000);
  const verifyTimeoutMs = Math.min(Math.max(Number(req.body?.verify_timeout_ms) || 1500, 200), 5000);
  const injectedBody = typeof req.body?.injected_body === 'string' ? req.body.injected_body : null;
  const minConfidence = req.body?.min_confidence != null
    ? Math.min(Math.max(Number(req.body.min_confidence), 0), 1)
    : undefined;
  // Per-request bypass for manual overrides (`telepty send-key`). Skips gate +
  // verify and dispatches once via the existing terminal-level chain.
  const force = req.body?.force === true;

  const gateOff = String(process.env.TELEPTY_SUBMIT_GATE || '').toLowerCase() === 'off';

  console.log(`[SUBMIT] Session ${id} (${session.command})${retries > 0 ? `, retries: ${retries}, pre_delay: ${preDelayMs}ms` : ''}${gateOff ? ' [gate=off]' : ''}`);

  function emitSubmitBus(payload) {
    const busMsg = JSON.stringify({
      type: 'submit',
      sender: 'daemon',
      session_id: id,
      timestamp: new Date().toISOString(),
      ...payload,
    });
    busClients.forEach(client => {
      if (client.readyState === 1) client.send(busMsg);
    });
  }

  // ── Per-request bypass: { force: true } skips gate + verify (0.3.1+) ──
  // Used by `telepty send-key` (manual override). Mirrors the env-var
  // escape-hatch but at request scope.
  // See: docs/superpowers/specs/2026-04-26-submit-gate-fixes-v2.md §3.1
  if (force) {
    const strategy = terminalLevelSubmit(id, session);
    if (strategy) {
      emitSubmitBus({ strategy, attempts: 1, gated: false, forced: true });
      return res.json({ success: true, strategy, attempts: 1, gated: false, forced: true });
    }
    return res.status(503).json({
      error: 'Submit failed via all strategies (kitty/cmux/pty)',
      strategy: 'none',
      attempts: 0,
      gated: false,
      forced: true,
    });
  }

  // ── Legacy escape-hatch path: blind pre-delay + retries (0.2.x behavior) ──
  if (gateOff) {
    if (preDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, preDelayMs));
    }
    let legacyStrategy = terminalLevelSubmit(id, session);
    let legacyAttempts = legacyStrategy ? 1 : 0;
    for (let i = 0; i < retries && legacyStrategy; i++) {
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      terminalLevelSubmit(id, session);
      legacyAttempts++;
    }
    if (legacyStrategy) {
      emitSubmitBus({ strategy: legacyStrategy, attempts: legacyAttempts, gated: false });
      return res.json({ success: true, strategy: legacyStrategy, attempts: legacyAttempts, gated: false });
    }
    return res.status(503).json({
      error: 'Submit failed via all strategies (kitty/cmux/pty)',
      strategy: 'none',
      attempts: legacyAttempts,
      gated: false,
    });
  }

  // ── Gated path (default, 0.3.0+; best-effort dispatch on timeout in 0.3.1+) ──

  // Step 0 (Layer 3, 0.3.2+): prompt-symbol render gate — strictly additive.
  // Polls `cmux read-screen` for the per-CLI prompt symbol and resolves only
  // when the symbol is stably rendered. Skips cleanly on non-cmux backends
  // (`no_screen_primitive`) and unknown CLIs (`unknown_cli`); on
  // `no_prompt_symbol_seen` (timeout) falls through to Layer 1 — never emits
  // its own 504. Per-request opt-out via `prompt_symbol_gate: false`.
  // See: docs/superpowers/specs/2026-04-26-prompt-symbol-render-gate.md
  const promptSymbolGate = req.body?.prompt_symbol_gate !== false;
  const promptSymbolTimeoutMs = Math.min(
    Math.max(Number(req.body?.prompt_symbol_timeout_ms) || 8000, 500),
    30000
  );
  let promptSymbol = null;
  if (promptSymbolGate) {
    const psResult = await submitGate.awaitPromptSymbol(session, {
      timeoutMs: promptSymbolTimeoutMs,
    });
    promptSymbol = {
      found: !!psResult.ready,
      waited_ms: psResult.waited_ms || 0,
      ...(psResult.reason ? { reason: psResult.reason } : {}),
      ...(psResult.last_seen_at != null ? { last_seen_at: psResult.last_seen_at } : {}),
    };
    if (psResult.reason === 'no_prompt_symbol_seen') {
      console.log(`[SUBMIT] Layer 3 timeout for ${id} after ${psResult.waited_ms}ms — falling through to Layer 1`);
    } else if (psResult.ready) {
      console.log(`[SUBMIT] Layer 3 ready for ${id} after ${psResult.waited_ms}ms`);
    }
  }

  // Step 1: wait for REPL readiness — best-effort, proceed on plain `timeout`.
  // Hard-fail reasons (session_dead/error/restarting/no_state/no_state_manager)
  // still short-circuit to 504 because dispatching to a dead/missing PTY is
  // pointless. See spec §1.3 / §3.3.
  const gateResult = await submitGate.awaitReplReady(id, sessionStateManager, {
    timeoutMs: gateTimeoutMs,
    ...(minConfidence !== undefined ? { minConfidence } : {}),
  });
  const gatedDispatchAfterTimeout = !gateResult.ready;
  if (gatedDispatchAfterTimeout && gateResult.reason && gateResult.reason !== 'timeout') {
    console.log(`[SUBMIT] gate hard-fail ${id}: ${gateResult.reason} (last_state=${gateResult.last_state})`);
    return res.status(504).json({
      error: 'Submit gated-timeout — target REPL not in a dispatchable state',
      reason: gateResult.reason,
      last_state: gateResult.last_state,
      strategy: 'none',
      attempts: 0,
      gated: true,
      gate_wait_ms: gateResult.waited_ms,
      ...(promptSymbol ? { prompt_symbol: promptSymbol } : {}),
    });
  }
  if (gatedDispatchAfterTimeout) {
    console.log(`[SUBMIT] gate timeout ${id}: dispatching anyway (last_state=${gateResult.last_state})`);
  }

  // Step 2: dispatch Enter via existing kitty → cmux → PTY chain.
  let strategy = terminalLevelSubmit(id, session);
  let attempts = strategy ? 1 : 0;
  if (!strategy) {
    return res.status(503).json({
      error: 'Submit failed via all strategies (kitty/cmux/pty)',
      strategy: 'none',
      attempts: 0,
      gated: true,
      gate_wait_ms: gateResult.waited_ms,
      ...(promptSymbol ? { prompt_symbol: promptSymbol } : {}),
    });
  }

  // Step 3: verify body consumption (only when the caller provided the body).
  // Without `injected_body`, this is a bare Enter press (`telepty enter` or
  // `telepty send-key` without force) — there is nothing to verify and one
  // shot is enough.
  let verify = null;
  if (injectedBody && injectedBody.length > 0) {
    verify = await submitGate.verifyBodyConsumed(session, injectedBody, {
      timeoutMs: verifyTimeoutMs,
      stripAnsi: stripAnsiState,
    });
    if (!verify.consumed) {
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      const retryStrategy = terminalLevelSubmit(id, session);
      if (retryStrategy) {
        strategy = retryStrategy;
        attempts++;
        verify = await submitGate.verifyBodyConsumed(session, injectedBody, {
          timeoutMs: verifyTimeoutMs,
          stripAnsi: stripAnsiState,
        });
      }
    }
    // Honest 504: gate timed out AND the body never left the input box even
    // after the best-effort dispatch + verify. Distinguishable from the legacy
    // `gate_timeout` reason (which dropped dispatch entirely).
    if (gatedDispatchAfterTimeout && !verify.consumed) {
      const failBody = {
        error: 'Submit gated-timeout and body not consumed after best-effort dispatch',
        reason: 'gated_dispatch_unconsumed',
        last_state: gateResult.last_state,
        strategy,
        attempts,
        gated: true,
        gate_wait_ms: gateResult.waited_ms,
        verify,
        gated_dispatch_after_timeout: true,
        ...(promptSymbol ? { prompt_symbol: promptSymbol } : {}),
      };
      emitSubmitBus(failBody);
      return res.status(504).json(failBody);
    }
  }

  const responseBody = {
    success: true,
    strategy,
    attempts,
    gated: true,
    gate_wait_ms: gateResult.waited_ms,
    verify,
    ...(gatedDispatchAfterTimeout ? { gated_dispatch_after_timeout: true } : {}),
    ...(promptSymbol ? { prompt_symbol: promptSymbol } : {}),
  };
  emitSubmitBus(responseBody);
  return res.json(responseBody);
});

// POST /api/sessions/submit-all — Submit all active sessions
app.post('/api/sessions/submit-all', (req, res) => {
  const results = { successful: [], failed: [] };

  for (const [id, session] of Object.entries(sessions)) {
    const strategy = getSubmitStrategy(session.command);
    let success = false;

    // cmux per-session backend
    if (session.backend === 'cmux') {
      success = terminalBackend.cmuxSendEnter(id);
    }
    if (!success && session.backend === 'cmux' && session.cmuxWorkspaceId) {
      success = submitViaCmux(id);
    }
    if (!success) {
      if (strategy === 'pty_cr') {
        success = submitViaPty(session);
      } else if (strategy === 'osascript_cmd_enter') {
        success = submitViaOsascript(id, 'cmd_enter');
      }
    }

    if (success) {
      results.successful.push({ id, strategy });
    } else {
      results.failed.push({ id, strategy, error: 'Submit failed' });
    }
  }

  res.json({ success: true, results });
});

app.post('/api/sessions/:id/inject', async (req, res) => {
  const requestedId = req.params.id;
  const resolvedId = resolveSessionAlias(requestedId);
  if (!resolvedId) return respondWithError(res, 404, 'SESSION_NOT_FOUND', 'Session not found', { requested: requestedId });
  const session = sessions[resolvedId];
  const id = resolvedId;
  const { prompt, no_enter, auto_submit, thread_id, reply_expected } = req.body;
  let { from, reply_to } = req.body;
  if (typeof prompt !== 'string') return respondWithError(res, 400, 'INVALID_REQUEST', 'prompt is required');
  // reply_to defaults to from when omitted
  if (from && !reply_to) reply_to = from;

  // Routing metadata stays in session/bus state, not in the visible prompt text.
  const finalPrompt = prompt;
  const inject_id = crypto.randomUUID();
  try {
    const delivery = await deliverInjectionToSession(id, session, finalPrompt, {
      noEnter: !!no_enter,
      source: 'inject',
      from: from || 'inject'
    });
    if (!delivery.success) {
      emitInjectFailureEvent(id, delivery.code, delivery.error, {
        inject_id,
        from: from || null,
        reply_to: reply_to || null
      }, session);
      return respondWithError(res, delivery.httpStatus || 500, delivery.code || 'DELIVERY_FAILED', delivery.error);
    }

    if (from) session.lastInjectFrom = from;
    if (reply_to) session.lastInjectReplyTo = reply_to;
    if (thread_id) session.lastThreadId = thread_id;

    console.log(`[INJECT] Wrote to session ${id} (inject_id: ${inject_id})`);

    const injectTimestamp = new Date().toISOString();
    broadcastSessionEvent('inject_written', id, session, {
      timestamp: injectTimestamp,
      extra: {
        inject_id,
        target_agent: id,
        content: prompt,
        from: from || null,
        reply_to: reply_to || null,
        thread_id: thread_id || null,
        reply_expected: !!reply_expected
      }
    });

    // Reverse-match for REPORT detection:
    // If this inject is FROM a session with a pending report whose source is
    // the current recipient, and the prompt matches a REPORT prefix, then
    // this is a content REPORT satisfying enforcement for the sender.
    if (from) {
      const senderAlias = resolveSessionAlias(from) || from;
      const senderPending = pendingReports[senderAlias];
      const recipientAlias = resolveSessionAlias(id) || id;
      if (senderPending) {
        const pendingSourceAlias = resolveSessionAlias(senderPending.source) || senderPending.source;
        if (pendingSourceAlias === recipientAlias) {
          const classification = classifyReportPrompt(prompt);
          if (classification) {
            delete pendingReports[senderAlias];
            const elapsedSecs = Number(((Date.now() - new Date(senderPending.injectedAt).getTime()) / 1000).toFixed(1));
            const senderSession = sessions[senderAlias];
            const eventType =
              classification === 'report_blocked' ? 'TASK_BLOCKED_WITH_REASON' :
              classification === 'report_dismissed' ? 'TASK_DISMISSED' :
              classification === 'report_error' ? 'TASK_COMPLETE_WITH_REPORT' :
              'TASK_COMPLETE_WITH_REPORT';
            broadcastSessionEvent(eventType, senderAlias, senderSession, {
              extra: {
                source: senderPending.source,
                inject_id: senderPending.injectId,
                report_inject_id: inject_id,
                elapsed_secs: elapsedSecs,
                injected_at: senderPending.injectedAt,
                report_status: classification,
                report_summary: prompt.slice(0, 500)
              }
            });
            console.log(`[ENFORCE-REPORT] ${eventType} from ${senderAlias} → ${recipientAlias} (${classification}, ${elapsedSecs}s)`);
          }
        }
      }
    }

    // Auto-report: track pending inject for idle notification back to source.
    // Overwrite warning: if an entry already exists, log for observability.
    if (from) {
      if (pendingReports[id]) {
        console.warn(`[AUTO-REPORT] overwritten pending report for ${id} (previous source: ${pendingReports[id].source}, new source: ${from})`);
      }
      pendingReports[id] = {
        source: from,
        injectedAt: injectTimestamp,
        injectId: inject_id,
        awaitingReport: true,
        idleNotified: false
      };
    }

    // Notify all attached viewers (telepty attach clients) about the inject
    // This enables aterm and other viewers to show inject events in real-time
    if (session.clients && session.clients.size > 0) {
      const viewerMsg = JSON.stringify({
        type: 'inject_notification',
        inject_id,
        session_id: id,
        from: from || null,
        content: prompt,
        timestamp: injectTimestamp
      });
      session.clients.forEach(client => {
        if (client !== session.ownerWs && client.readyState === 1) {
          client.send(viewerMsg);
        }
      });
    }

    if (requestedId !== resolvedId) {
      console.log(`[ALIAS] Resolved '${requestedId}' → '${resolvedId}'`);
    }

    if (from && reply_to) {
      const routedMsg = JSON.stringify({
        type: 'message_routed',
        message_id: inject_id,
        from,
        to: id,
        reply_to,
        inject_id,
        deliberation_session_id: req.body.deliberation_session_id || null,
        thread_id: req.body.thread_id || null,
        timestamp: new Date().toISOString()
      });
      busClients.forEach(client => {
        if (client.readyState === 1) client.send(routedMsg);
      });
    }

    res.json({ success: true, inject_id, strategy: delivery.strategy, submit: delivery.submit });
  } catch (err) {
    emitInjectFailureEvent(id, 'DELIVERY_FAILED', err.message, { inject_id }, session);
    res.status(500).json(buildErrorBody('DELIVERY_FAILED', err.message));
  }
});

// GET /api/pendingReports/:id — inspect pending report entry + optional auto_summary
app.get('/api/pendingReports/:id', (req, res) => {
  const requestedId = req.params.id;
  const resolvedId = resolveSessionAlias(requestedId) || requestedId;
  const entry = pendingReports[resolvedId];
  if (!entry) {
    return res.status(404).json({ error: 'No pending report', requested: requestedId });
  }
  const session = sessions[resolvedId];
  const autoSummary = REPORT_AUTO_SUMMARY_ON_QUERY && session ? buildAutoSummaryWithDefaults(session) : null;
  res.json({
    session_id: resolvedId,
    source: entry.source,
    inject_id: entry.injectId,
    injected_at: entry.injectedAt,
    idle_notified: !!entry.idleNotified,
    idle_at: entry.idleAt || null,
    awaiting_report: !!entry.awaitingReport,
    auto_summary: autoSummary
  });
});

// DELETE /api/pendingReports/:id — orchestrator-side dismissal
app.delete('/api/pendingReports/:id', (req, res) => {
  const requestedId = req.params.id;
  const resolvedId = resolveSessionAlias(requestedId) || requestedId;
  const entry = pendingReports[resolvedId];
  if (!entry) {
    return res.status(404).json({ error: 'No pending report', requested: requestedId });
  }
  delete pendingReports[resolvedId];
  const session = sessions[resolvedId];
  broadcastSessionEvent('TASK_DISMISSED', resolvedId, session, {
    extra: {
      source: entry.source,
      inject_id: entry.injectId,
      dismissed_by: 'orchestrator',
      injected_at: entry.injectedAt
    }
  });
  console.log(`[ENFORCE-REPORT] ${resolvedId} pending report dismissed by orchestrator`);
  res.json({ success: true, session_id: resolvedId });
});

// GET /api/sessions/:id/screen — read current screen buffer
app.get('/api/sessions/:id/screen', (req, res) => {
  const requestedId = req.params.id;
  const resolvedId = resolveSessionAlias(requestedId);
  if (!resolvedId) return res.status(404).json({ error: 'Session not found', requested: requestedId });
  const session = sessions[resolvedId];

  const lines = parseInt(req.query.lines) || 50;
  const raw = req.query.raw === '1' || req.query.raw === 'true';

  if (!session.outputRing || session.outputRing.length === 0) {
    return res.json({ session_id: resolvedId, screen: '', lines: 0, raw: false });
  }

  // Join all buffered output
  const fullOutput = session.outputRing.join('');

  // Strip ANSI escape sequences for clean text
  function stripAnsi(str) {
    return str
      // Replace cursor-forward (ESC[NC, ESC[C) with N spaces to preserve whitespace
      .replace(/\[(\d*)C/g, (_, n) => ' '.repeat(Number(n) || 1))
      // CSI sequences: ESC [ ? (optional) params final_byte
      .replace(/\[\??[0-9;]*[a-zA-Z@`]/g, '')
      // OSC sequences: ESC ] ... BEL
      .replace(/\][^]*/g, '')
      // OSC sequences: ESC ] ... ST (ESC \)
      .replace(/\][^]*\\/g, '')
      // Character set selection: ESC ( / ) + charset
      .replace(/[()][AB012]/g, '')
      // Keypad and other 2-char ESC sequences
      .replace(/[>=<78DMEHcNOZ~}|]/g, '')
      // DCS / PM / APC sequences
      .replace(/[P^_][^]*\\/g, '')
      // Any remaining bare ESC + single char
      .replace(/./g, '')
      // Carriage returns
      .replace(/\r/g, '');
  }

  const cleaned = raw ? fullOutput : stripAnsi(fullOutput);

  // Take last N lines
  const allLines = cleaned.split('\n');
  const lastLines = allLines.slice(-lines);
  const screen = lastLines.join('\n').trim();

  res.json({
    session_id: resolvedId,
    screen,
    lines: lastLines.length,
    total_lines: allLines.length,
    raw: !!raw
  });
});

app.patch('/api/sessions/:id', (req, res) => {
  const requestedId = req.params.id;
  const resolvedId = resolveSessionAlias(requestedId);
  if (!resolvedId) return res.status(404).json({ error: 'Session not found', requested: requestedId });
  const session = sessions[resolvedId];
  const id = resolvedId;
  const { new_id } = req.body;
  if (!new_id) return res.status(400).json({ error: 'new_id is required' });
  if (sessions[new_id]) return res.status(409).json({ error: `Session ID '${new_id}' is already in use.` });

  // Move session to new key (including state machine)
  sessions[new_id] = session;
  delete sessions[id];
  sessionStateManager.unregister(id);
  sessionStateManager.register(new_id);
  session.id = new_id;

  // Broadcast rename to bus
  const busMsg = JSON.stringify({
    type: 'session_rename',
    sender: 'daemon',
    old_id: id,
    new_id,
    timestamp: new Date().toISOString()
  });
  busClients.forEach(client => {
    if (client.readyState === 1) client.send(busMsg);
  });

  console.log(`[RENAME] Session '${id}' renamed to '${new_id}'`);
  res.json({ success: true, old_id: id, new_id });
});

app.delete('/api/sessions/:id', (req, res) => {
  const requestedId = req.params.id;
  const resolvedId = resolveSessionAlias(requestedId);
  if (!resolvedId) return res.status(404).json({ error: 'Session not found', requested: requestedId });
  const session = sessions[resolvedId];
  const id = resolvedId;
  if (session.isClosing) return res.json({ success: true, status: 'closing' });
  try {
    session.isClosing = true;
    if (session.type === 'wrapped') {
      if (session.clients) session.clients.forEach(ws => ws.close(1000, 'Session destroyed'));
    } else if (session.ptyProcess) {
      session.ptyProcess.kill();
    }
    delete sessions[id];
    sessionStateManager.unregister(id);
    try { mailbox.purge(id); } catch {}
    console.log(`[KILL] Session ${id} removed`);
    persistSessions();
    res.json({ success: true, status: 'closing' });
  } catch (err) {
    // Even if kill fails, remove from registry
    delete sessions[id];
    sessionStateManager.unregister(id);
    try { mailbox.purge(id); } catch {}
    persistSessions();
    console.log(`[KILL] Session ${id} force-removed (process cleanup error: ${err.message})`);
    res.json({ success: true, status: 'force-removed' });
  }
});

// Shared auto-router: handles turn_request events from any source (WS or HTTP)
async function busAutoRoute(msg) {
  const eventType = msg.type || msg.kind;
  const isRoutable = (eventType === 'turn_request' || eventType === 'deliberation_route_turn') && (msg.target || msg.target_session_id);
  if (!isRoutable) {
    // Log all bus messages for debugging (excluding health checks)
    if (eventType && eventType !== 'session_health') {
      console.log(`[BUS] Event: ${eventType} (not routable)`);
    }
    return;
  }

  const rawTarget = (msg.target || msg.target_session_id).split('@')[0];
  const turnId = (msg.payload && msg.payload.turn_id) || null;
  console.log(`[BUS-ROUTE] ${eventType}: target=${rawTarget} turn=${turnId} msg_id=${msg.message_id || 'none'}`);
  const targetId = resolveSessionAlias(rawTarget);
  const targetSession = targetId ? sessions[targetId] : null;
  if (!targetSession) {
    console.log(`[BUS-ROUTE] Target ${rawTarget} not found among: ${Object.keys(sessions).join(', ')}`);
    emitInjectFailureEvent(rawTarget, 'SESSION_NOT_FOUND', 'Target session was not found.', {
      source: 'bus_auto_route',
      turn_id: turnId,
      original_message_id: msg.message_id || null
    });
    return;
  }

  const prompt = (msg.payload && msg.payload.prompt) || msg.content || msg.prompt || JSON.stringify(msg);
  const inject_id = crypto.randomUUID();
  const delivery = await deliverInjectionToSession(targetId, targetSession, prompt, {
    source: 'bus_auto_route'
  });
  const delivered = delivery.success === true;
  if (!delivered) {
    emitInjectFailureEvent(targetId, delivery.code, delivery.error, {
      source: 'bus_auto_route',
      turn_id: turnId,
      original_message_id: msg.message_id || null
    }, targetSession);
  }

  // Emit inject_written ack
  broadcastSessionEvent('inject_written', targetId, targetSession, {
    extra: {
      inject_id,
      source_host: MACHINE_ID,
      target_agent: targetId,
      source_type: 'bus_auto_route',
      turn_id: (msg.payload && msg.payload.turn_id) || null,
      original_message_id: msg.message_id || null,
      delivered,
      code: delivered ? null : delivery.code,
      error: delivered ? null : delivery.error
    }
  });
  console.log(`[BUS-ROUTE] ${eventType} → ${targetId}: ${delivered ? 'delivered' : 'failed'}`);
}

app.post('/api/bus/publish', (req, res) => {
  const payload = req.body;

  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Payload must be a JSON object' });
  }

  if (payload.type === 'session_state_report') {
    const resolvedId = resolveSessionAlias(payload.session_id || '');
    if (!resolvedId || !sessions[resolvedId]) {
      return respondWithError(res, 404, 'SESSION_NOT_FOUND', 'Session not found', { requested: payload.session_id || null });
    }

    const applied = applySessionStateReport(resolvedId, sessions[resolvedId], payload);
    if (!applied.success) {
      return respondWithError(res, applied.httpStatus || 400, applied.code || 'INVALID_REQUEST', applied.error);
    }

    if (!payload._relayed_from) relayToPeers(applied.event);
    persistSessions();
    return res.json({ success: true, delivered: busClients.size, event: applied.event });
  }

  let deliveredCount = 0;

  busClients.forEach(client => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(JSON.stringify(payload));
      deliveredCount++;
    }
  });

  // Auto-route if this is a turn_request
  busAutoRoute(payload);
  // Relay to peer daemons (dedup prevents loops)
  if (!payload._relayed_from) relayToPeers(payload);

  res.json({ success: true, delivered: deliveredCount });
});

app.post('/api/handoff', (req, res) => {
  const { source_session_id, deliberation_id, synthesis, auto_execute } = req.body;
  if (!synthesis) return res.status(400).json({ error: 'synthesis is required' });

  const handoff_id = crypto.randomUUID();
  const handoff = {
    id: handoff_id,
    source_session_id: source_session_id || null,
    deliberation_id: deliberation_id || null,
    synthesis,
    status: 'pending',
    auto_execute: !!auto_execute,
    claimed_by: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    progress: [],
    result: null
  };
  handoffs[handoff_id] = handoff;

  const busMsg = JSON.stringify({
    type: 'handoff.created',
    handoff_id,
    source_session_id: handoff.source_session_id,
    deliberation_id: handoff.deliberation_id,
    auto_execute: handoff.auto_execute,
    task_count: Array.isArray(synthesis.tasks) ? synthesis.tasks.length : 0,
    timestamp: handoff.created_at
  });
  busClients.forEach(client => {
    if (client.readyState === 1) client.send(busMsg);
  });

  console.log(`[HANDOFF] Created ${handoff_id} (${Array.isArray(synthesis.tasks) ? synthesis.tasks.length : 0} tasks)`);
  res.status(201).json({ handoff_id, status: 'pending' });
});

app.get('/api/handoff', (req, res) => {
  const status = req.query.status;
  const list = Object.values(handoffs)
    .filter(h => !status || h.status === status)
    .map(h => ({
      id: h.id,
      status: h.status,
      deliberation_id: h.deliberation_id,
      source_session_id: h.source_session_id,
      auto_execute: h.auto_execute,
      claimed_by: h.claimed_by,
      task_count: Array.isArray(h.synthesis.tasks) ? h.synthesis.tasks.length : 0,
      created_at: h.created_at,
      updated_at: h.updated_at
    }));
  res.json(list);
});

app.get('/api/handoff/:id', (req, res) => {
  const handoff = handoffs[req.params.id];
  if (!handoff) return res.status(404).json({ error: 'Handoff not found' });
  res.json(handoff);
});

app.post('/api/handoff/:id/claim', (req, res) => {
  const handoff = handoffs[req.params.id];
  if (!handoff) return res.status(404).json({ error: 'Handoff not found' });
  if (handoff.status !== 'pending') {
    return res.status(409).json({ error: `Handoff already ${handoff.status}`, claimed_by: handoff.claimed_by });
  }

  const { agent_session_id } = req.body;
  if (!agent_session_id) return res.status(400).json({ error: 'agent_session_id is required' });

  handoff.status = 'claimed';
  handoff.claimed_by = agent_session_id;
  handoff.updated_at = new Date().toISOString();

  const busMsg = JSON.stringify({
    type: 'handoff.claimed',
    handoff_id: handoff.id,
    agent_session_id,
    timestamp: handoff.updated_at
  });
  busClients.forEach(client => {
    if (client.readyState === 1) client.send(busMsg);
  });

  console.log(`[HANDOFF] ${handoff.id} claimed by ${agent_session_id}`);
  res.json({ success: true, handoff_id: handoff.id, status: 'claimed' });
});

app.patch('/api/handoff/:id', (req, res) => {
  const handoff = handoffs[req.params.id];
  if (!handoff) return res.status(404).json({ error: 'Handoff not found' });

  const { status, message, result } = req.body;
  const validTransitions = {
    pending: ['claimed'],
    claimed: ['executing', 'failed'],
    executing: ['completed', 'failed'],
  };

  if (status) {
    const allowed = validTransitions[handoff.status] || [];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `Invalid transition: ${handoff.status} -> ${status}` });
    }
    handoff.status = status;
  }

  if (message) {
    handoff.progress.push({ message, timestamp: new Date().toISOString() });
  }

  if (result) {
    handoff.result = result;
  }

  handoff.updated_at = new Date().toISOString();

  const busMsg = JSON.stringify({
    type: `handoff.${handoff.status}`,
    handoff_id: handoff.id,
    claimed_by: handoff.claimed_by,
    message: message || null,
    timestamp: handoff.updated_at
  });
  busClients.forEach(client => {
    if (client.readyState === 1) client.send(busMsg);
  });

  console.log(`[HANDOFF] ${handoff.id} -> ${handoff.status}${message ? ': ' + message : ''}`);
  res.json({ success: true, handoff_id: handoff.id, status: handoff.status });
});

// --- Deliberation Thread Tracking ---

app.post('/api/threads', (req, res) => {
  const { topic, orchestrator_session_id, participant_session_ids, context } = req.body;
  if (!topic) return res.status(400).json({ error: 'topic is required' });

  const thread_id = crypto.randomUUID();
  const thread = {
    id: thread_id,
    topic,
    orchestrator_session_id: orchestrator_session_id || null,
    participant_session_ids: participant_session_ids || [],
    context: context || null,
    status: 'active',
    message_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    closed_at: null
  };
  threads[thread_id] = thread;

  const busMsg = JSON.stringify({
    type: 'thread.opened',
    thread_id,
    topic,
    orchestrator_session_id: thread.orchestrator_session_id,
    participant_session_ids: thread.participant_session_ids,
    timestamp: thread.created_at
  });
  busClients.forEach(client => {
    if (client.readyState === 1) client.send(busMsg);
  });

  console.log(`[THREAD] Opened ${thread_id}: "${topic}" (${thread.participant_session_ids.length} participants)`);
  res.status(201).json({ thread_id, status: 'active' });
});

app.get('/api/threads', (req, res) => {
  const status = req.query.status;
  const list = Object.values(threads)
    .filter(t => !status || t.status === status)
    .map(t => ({
      id: t.id,
      topic: t.topic,
      status: t.status,
      orchestrator_session_id: t.orchestrator_session_id,
      participant_count: t.participant_session_ids.length,
      message_count: t.message_count,
      created_at: t.created_at,
      updated_at: t.updated_at
    }));
  res.json(list);
});

app.get('/api/threads/:id', (req, res) => {
  const thread = threads[req.params.id];
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  res.json(thread);
});

app.patch('/api/threads/:id', (req, res) => {
  const thread = threads[req.params.id];
  if (!thread) return res.status(404).json({ error: 'Thread not found' });

  const { status, message_count } = req.body;

  if (status === 'closed' && thread.status === 'active') {
    thread.status = 'closed';
    thread.closed_at = new Date().toISOString();
    thread.updated_at = thread.closed_at;

    const busMsg = JSON.stringify({
      type: 'thread.closed',
      thread_id: thread.id,
      topic: thread.topic,
      message_count: thread.message_count,
      timestamp: thread.closed_at
    });
    busClients.forEach(client => {
      if (client.readyState === 1) client.send(busMsg);
    });

    console.log(`[THREAD] Closed ${thread.id}: "${thread.topic}" (${thread.message_count} messages)`);
  }

  if (typeof message_count === 'number') {
    thread.message_count = message_count;
    thread.updated_at = new Date().toISOString();
  }

  res.json({ success: true, thread_id: thread.id, status: thread.status });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`🚀 aigentry-telepty daemon listening on http://${HOST}:${PORT}`);
});

// --- Mailbox system initialization ---
const mailbox = new FileMailbox();
const mailboxNotifier = new UnixSocketNotifier({ coalesceMs: 25 });

// Resolve aterm UDS socket path for a session
mailboxNotifier.setSocketResolver((sessionId) => {
  const session = sessions[sessionId];
  if (!session || session.type !== 'aterm') return null;
  return (session.delivery && session.delivery.transport === 'unix_socket' && session.delivery.address) || null;
});

// Delivery engine: dequeue → writeDataToSession → ack/nack
const mailboxDelivery = new DeliveryEngine(mailbox, {
  pollMs: 200,
  sessionResolver: () => Object.keys(sessions),
  deliverFn: async (sessionId, msg) => {
    const session = sessions[sessionId];
    if (!session) return { success: false, error: 'Session not found' };
    const result = await writeDataToSession(sessionId, session, msg.payload);
    if (result.success) {
      session.lastActivityAt = new Date().toISOString();
    }
    return result;
  },
  onDelivery: (sessionId, msgId, result) => {
    const session = sessions[sessionId];
    if (!session) return;
    if (result.success) {
      broadcastSessionEvent('mailbox_delivered', sessionId, session, {
        extra: { msg_id: msgId }
      });
    } else {
      broadcastSessionEvent('mailbox_delivery_failed', sessionId, session, {
        extra: { msg_id: msgId, error: result.error }
      });
    }
  },
});
// Startup sweep: break stale lock files before starting delivery
const staleBroken = mailbox.breakStaleLocks();
if (staleBroken > 0) {
  console.log(`[MAILBOX] Startup sweep: broke ${staleBroken} stale lock(s)`);
}
mailboxDelivery.start();

const IDLE_THRESHOLD_SECONDS = 60;
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of Object.entries(sessions)) {
    const idleSeconds = session.lastActivityAt ? Math.floor((now - new Date(session.lastActivityAt).getTime()) / 1000) : null;
    const healthStatus = getSessionHealthStatus(session, { nowMs: now });
    const healthReason = getSessionHealthReason(session, healthStatus);
    const disconnectedSeconds = session.lastDisconnectedAt
      ? Math.floor((now - new Date(session.lastDisconnectedAt).getTime()) / 1000)
      : null;

    broadcastSessionEvent('session_health', id, session, {
      nowMs: now,
      extra: {
        payload: {
          alive: healthStatus === 'CONNECTED',
          pid: session.ptyProcess?.pid || null,
          type: session.type,
          clients: session.clients ? session.clients.size : 0,
          idleSeconds,
          healthStatus,
          healthReason,
          disconnectedSeconds
        }
      }
    });

    // Emit session.idle when idle exceeds threshold
    if (idleSeconds !== null && idleSeconds >= IDLE_THRESHOLD_SECONDS && !session._idleEmitted) {
      session._idleEmitted = true;
      const idleMsg = JSON.stringify({
        type: 'session.idle',
        session_id: id,
        idleSeconds,
        lastActivityAt: session.lastActivityAt,
        timestamp: new Date().toISOString()
      });
      busClients.forEach(client => {
        if (client.readyState === 1) client.send(idleMsg);
      });
      console.log(`[IDLE] Session ${id} idle for ${idleSeconds}s`);
    }
    // Auto-report fallback for non-wrapped sessions (legacy threshold path).
    // Skip if onTransition already fired the idle notification.
    const pendingRpt = pendingReports[id];
    if (pendingRpt && !pendingRpt.idleNotified && session.type !== 'wrapped' && idleSeconds !== null && idleSeconds >= AUTO_REPORT_IDLE_SECONDS) {
      pendingRpt.idleNotified = true;
      pendingRpt.idleAt = new Date().toISOString();
      const elapsed = ((Date.now() - new Date(pendingRpt.injectedAt).getTime()) / 1000).toFixed(1);
      // Fire new bus event + legacy text-inject
      broadcastSessionEvent('TASK_IDLE_NO_REPORT', id, session, {
        extra: {
          source: pendingRpt.source,
          inject_id: pendingRpt.injectId,
          elapsed_secs: Number(elapsed),
          injected_at: pendingRpt.injectedAt
        }
      });
      const reportMsg = `TASK_COMPLETE: ${id} is now idle after processing inject (${elapsed}s)`;
      const srcId = resolveSessionAlias(pendingRpt.source) || pendingRpt.source;
      const srcSession = sessions[srcId];
      if (srcSession) {
        deliverInjectionToSession(srcId, srcSession, reportMsg, { noEnter: false, source: 'auto_report' });
        console.log(`[AUTO-REPORT] ${id} → ${srcId}: idle after ${elapsed}s (threshold)`);
      }
    }
    // Reset idle flag when activity resumes
    if (idleSeconds !== null && idleSeconds < IDLE_THRESHOLD_SECONDS) {
      session._idleEmitted = false;
    }

    // Periodically verify aterm socket existence — triggers health transition
    // NOTE: Do NOT nullify delivery address here. The address is preserved so that
    // if aterm restarts and the socket reappears, health check recovers automatically.
    if (session.type === 'aterm') {
      const atermEndpoint = session.deliveryEndpoint || (session.delivery && session.delivery.address);
      if (atermEndpoint && atermEndpoint.startsWith('/')) {
        let socketAlive = false;
        try {
          const stat = fs.statSync(atermEndpoint);
          socketAlive = stat.isSocket();
        } catch {
          socketAlive = false;
        }
        if (!socketAlive && !session.lastDisconnectedAt) {
          markSessionDisconnected(session);
          console.log(`[SWEEP] aterm socket gone for ${id}: ${atermEndpoint}`);
        } else if (socketAlive && session.lastDisconnectedAt) {
          markSessionConnected(session);
          console.log(`[SWEEP] aterm socket recovered for ${id}: ${atermEndpoint}`);
        }
      }
    }

    if (healthStatus === 'STALE' && !session._staleEmitted) {
      session._staleEmitted = true;
      emitSessionLifecycleEvent('session_stale', id, session, {
        disconnectedSeconds
      });
    }

    const shouldCleanupDisconnected = (session.type === 'wrapped' || session.type === 'aterm')
      && !isOpenWebSocket(session.ownerWs)
      && (!session.clients || session.clients.size === 0)
      && disconnectedSeconds !== null
      && disconnectedSeconds >= SESSION_CLEANUP_SECONDS;

    if (shouldCleanupDisconnected) {
      emitSessionLifecycleEvent('session_cleanup', id, session, {
        reason: 'STALE_DISCONNECTED',
        disconnectedSeconds
      });
      delete sessions[id];
      sessionStateManager.unregister(id);
      console.log(`[CLEANUP] Removed stale session ${id} after ${disconnectedSeconds}s disconnected`);
      persistSessions();
    }
  }
}, HEALTH_POLL_MS);

server.on('error', async (error) => {
  clearDaemonState(process.pid);

  if (error && error.code === 'EADDRINUSE') {
    // Probe health to determine if it's a telepty daemon on this port
    try {
      const probe = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      const data = await probe.json();
      if (data && data.status === 'ok') {
        console.log(`[DAEMON] telepty daemon already running on port ${PORT} (v${data.version}). Exiting.`);
        process.exit(0);
      }
    } catch {}
    console.error(`[DAEMON] Port ${PORT} is already in use by another process.`);
    process.exit(1);
  }

  throw error;
});


const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://' + req.headers.host);
  const sessionId = url.pathname.split('/').pop();
  const session = sessions[sessionId];
  // ?owner=1 indicates the allow bridge (PTY owner), not an attach viewer
  const isOwnerConnect = url.searchParams.get('owner') === '1';

  // Ping/pong heartbeat — detect and terminate stale TCP half-open connections (30s interval)
  let isAlive = true;
  ws.on('pong', () => { isAlive = true; });
  const pingInterval = setInterval(() => {
    if (!isAlive) {
      console.log(`[WS] Terminating stale connection (no pong) for ${sessionId}`);
      ws.terminate();
      return;
    }
    isAlive = false;
    ws.ping();
  }, 30000);

  if (!session) {
    const connectedAt = new Date().toISOString();
    // Auto-register wrapped session on WS connect (supports reconnect after daemon restart)
    const autoSession = {
      id: sessionId,
      type: 'wrapped',
      ptyProcess: null,
      ownerWs: ws,
      command: 'wrapped',
      cwd: process.cwd(),
      createdAt: connectedAt,
      lastActivityAt: connectedAt,
      lastConnectedAt: connectedAt,
      lastDisconnectedAt: null,
      clients: new Set([ws]),
      isClosing: false,
      outputRing: [],
      ready: true,
          };
    sessions[sessionId] = autoSession;
    console.log(`[WS] Auto-registered wrapped session ${sessionId} on reconnect`);
    // Set tab title via kitty (no \x0c redraw — it causes flickering on multi-session reconnect)
    setTimeout(() => {
      const sock = findKittySocket();
      const wid = findKittyWindowId(sock, sessionId);
      if (sock && wid) {
        try {
          require('child_process').execSync(`kitty @ --to unix:${sock} set-tab-title --match id:${wid} '⚡ telepty :: ${sessionId}'`, {
            timeout: 2000, stdio: ['pipe', 'pipe', 'pipe']
          });
        } catch {}
      }
    }, 1000);
  } else {
    session.clients.add(ws);
  }

  const activeSession = sessions[sessionId];

  // For wrapped sessions, first connector OR explicit ?owner=1 claim becomes the owner.
  // ?owner=1 reclaim handles the stale-ownerWs bug: allow bridge reconnects but stale TCP
  // half-open connection still holds ownerWs slot → reconnect wrongly becomes a viewer.
  if (activeSession.type === 'wrapped' && (!activeSession.ownerWs || isOwnerConnect)) {
    const hadDisconnectedOwner = !isOpenWebSocket(activeSession.ownerWs) && activeSession.lastDisconnectedAt;
    if (isOwnerConnect && activeSession.ownerWs && activeSession.ownerWs !== ws) {
      // Terminate the stale owner connection before claiming ownership
      console.log(`[WS] Replacing stale ownerWs for session ${sessionId}`);
      activeSession.ownerWs.terminate();
    }
    activeSession.ownerWs = ws;
    markSessionConnected(activeSession);
    console.log(`[WS] Wrap owner ${isOwnerConnect && activeSession.clients.size > 1 ? 're-' : ''}connected for session ${sessionId} (Total: ${activeSession.clients.size})`);
    if (hadDisconnectedOwner) {
      emitSessionLifecycleEvent('session_reconnect', sessionId, activeSession);
    }
    persistSessions();
  } else {
    console.log(`[WS] Client attached to session ${sessionId} (Total: ${activeSession.clients.size})`);
  }

  ws.on('message', (message) => {
    try {
      const { type, data, cols, rows } = JSON.parse(message);

      if (activeSession.type === 'wrapped') {
        if (ws === activeSession.ownerWs) {
          // Owner sending output -> broadcast to other clients + update activity
          if (type === 'output') {
            activeSession.lastActivityAt = new Date().toISOString();
            appendToOutputRing(activeSession, data);
            sessionStateManager.feed(sessionId, data);
            activeSession.clients.forEach(client => {
              if (client !== ws && client.readyState === 1) {
                client.send(JSON.stringify({ type: 'output', data }));
              }
            });
          } else if (type === 'ready') {
            activeSession.ready = true;
            activeSession.lastActivityAt = new Date().toISOString();
            console.log(`[READY] Session ${sessionId} CLI is ready for inject`);
            // Broadcast readiness to bus (cmux/kitty paths now enabled for this session)
            const readyMsg = JSON.stringify({
              type: 'session_ready',
              session_id: sessionId,
              timestamp: new Date().toISOString()
            });
            busClients.forEach(client => {
              if (client.readyState === 1) client.send(readyMsg);
            });
            // Auto-report: notify source that target completed inject task
            // Legacy ready-signal auto-report path. Skip if onTransition already
            // fired (pendingReports[sessionId].idleNotified === true).
            const pendingReport = pendingReports[sessionId];
            if (pendingReport && !pendingReport.idleNotified) {
              pendingReport.idleNotified = true;
              pendingReport.idleAt = new Date().toISOString();
              const elapsed = ((Date.now() - new Date(pendingReport.injectedAt).getTime()) / 1000).toFixed(1);
              // Fire new bus event + legacy text-inject
              broadcastSessionEvent('TASK_IDLE_NO_REPORT', sessionId, activeSession, {
                extra: {
                  source: pendingReport.source,
                  inject_id: pendingReport.injectId,
                  elapsed_secs: Number(elapsed),
                  injected_at: pendingReport.injectedAt
                }
              });
              const reportMsg = `TASK_COMPLETE: ${sessionId} is now idle after processing inject (${elapsed}s)`;
              const srcId = resolveSessionAlias(pendingReport.source) || pendingReport.source;
              const srcSession = sessions[srcId];
              if (srcSession) {
                deliverInjectionToSession(srcId, srcSession, reportMsg, { noEnter: false, source: 'auto_report' });
                console.log(`[AUTO-REPORT] ${sessionId} → ${srcId}: idle after ${elapsed}s (ready signal)`);
              }
            }
          }
        } else {
          // Non-owner client input -> forward to owner as inject
          if (type === 'input' && activeSession.ownerWs && activeSession.ownerWs.readyState === 1) {
            activeSession.ownerWs.send(JSON.stringify({ type: 'inject', data }));
          } else if (type === 'resize' && activeSession.ownerWs && activeSession.ownerWs.readyState === 1) {
            activeSession.ownerWs.send(JSON.stringify({ type: 'resize', cols, rows }));
          }
        }
      } else {
        // Existing spawned session logic
        if (type === 'input') {
          activeSession.ptyProcess.write(data);
        } else if (type === 'resize') {
          activeSession.ptyProcess.resize(cols, rows);
        }
      }
    } catch (e) {
      console.error('[WS] Invalid message format', e);
    }
  });

  ws.on('close', () => {
    clearInterval(pingInterval);
    activeSession.clients.delete(ws);
    if (activeSession.type === 'wrapped' && ws === activeSession.ownerWs) {
      activeSession.ownerWs = null;
      markSessionDisconnected(activeSession);
      console.log(`[WS] Wrap owner disconnected from session ${sessionId} (Total: ${activeSession.clients.size})`);
      emitSessionLifecycleEvent('session_disconnect', sessionId, activeSession, {
        clients: activeSession.clients.size
      });
      persistSessions();
    } else {
      console.log(`[WS] Client detached from session ${sessionId} (Total: ${activeSession.clients.size})`);
    }
  });
});

const busWss = new WebSocketServer({ noServer: true });
const busClients = new Set();

busWss.on('connection', (ws, req) => {
  busClients.add(ws);
  console.log('[BUS] New agent connected to event bus');

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);
      if (msg.type === 'session_state_report') {
        const resolvedId = resolveSessionAlias(msg.session_id || '');
        if (!resolvedId || !sessions[resolvedId]) {
          return;
        }

        const applied = applySessionStateReport(resolvedId, sessions[resolvedId], msg);
        if (!applied.success) {
          return;
        }

        if (!msg._relayed_from) relayToPeers(applied.event);
        persistSessions();
        return;
      }

      // Broadcast to all other bus clients
      busClients.forEach(client => {
        if (client !== ws && client.readyState === 1) {
          client.send(JSON.stringify(msg));
        }
      });

      // Auto-route turn_request events (shared logic with HTTP publish)
      busAutoRoute(msg);
      // Relay to peer daemons (dedup prevents loops)
      if (!msg._relayed_from) relayToPeers(msg);
    } catch (e) {
      console.error('[BUS] Invalid message format', e);
    }
  });

  ws.on('close', () => {
    busClients.delete(ws);
    console.log('[BUS] Agent disconnected from event bus');
  });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://' + req.headers.host);
  const token = url.searchParams.get('token');
  
  const wsAuthHeader = req.headers['authorization'] || '';
  const wsJwtValid = wsAuthHeader.startsWith('Bearer ') && verifyJwt(wsAuthHeader.slice(7));
  if (!isAllowedPeer(req.socket.remoteAddress) && token !== EXPECTED_TOKEN && !wsJwtValid) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  if (url.pathname.startsWith('/api/sessions/')) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else if (url.pathname === '/api/bus') {
    busWss.handleUpgrade(req, socket, head, (ws) => {
      busWss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

function shutdown(code) {
  mailboxDelivery.stop();
  mailboxNotifier.cancelAll();
  clearDaemonState(process.pid);
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => {
  clearDaemonState(process.pid);
});
