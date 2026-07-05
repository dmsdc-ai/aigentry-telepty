const express = require('express');
const cors = require('cors');
const pty = require('node-pty');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { getConfig } = require('./auth');
const pkg = require('./package.json');
const { claimDaemonState, clearDaemonState, isProcessRunning } = require('./daemon-control');
const { checkEntitlement } = require('./entitlement');
const terminalBackend = require('./terminal-backend');
const { installWebSocketTransport, isOpenWebSocket } = require('./src/transport/websocket');
const { createPeerRelay, relayPeersFromEnv } = require('./src/transport/peer-relay');
const { createAuthMiddleware, createIsAllowedPeer, createVerifyJwt } = require('./src/protocol/http-auth');
const { detectTailnet, TAILNET_CIDR } = require('./src/net/tailnet');
const { FileMailbox } = require('./src/mailbox/index');
const { DeliveryEngine } = require('./src/mailbox/delivery');
const { UnixSocketNotifier } = require('./src/mailbox/notifier');
const { SessionStateManager, STATE_DISPLAY, stripAnsi: stripAnsiState } = require('./session-state');
const { classifyReportPrompt, buildAutoSummary } = require('./src/report-enforcement');
const submitGate = require('./src/submit-gate');
const { sampleChildCpuSeconds } = require('./src/child-cpu'); // #52: quiet-thinking CPU recheck
const readyRegistry = require('./src/prompt-symbol-registry');
const lifecycle = require('./src/lifecycle');
const { SURFACE_ORPHAN_SECONDS, SURFACE_MISMATCH_SECONDS, decideSurfaceGc, applySurfaceMismatchProbe } = lifecycle;
const { loadTeleptyConfig } = require('./src/config-file');
const sessionPersistence = require('./src/session-store/persistence');
const { createAuditWriter, readInjectLog } = require('./src/audit/inject-log');
const { mintSessionNonce, applyProvenance } = require('./src/audit/provenance');

const config = getConfig();
const EXPECTED_TOKEN = config.authToken;
const MACHINE_ID = process.env.TELEPTY_MACHINE_ID || os.hostname();
const net = require('net');
const fs = require('fs');
const SESSION_PERSIST_PATH = sessionPersistence.defaultSessionPersistPath();
const SESSION_STALE_SECONDS = Math.max(1, Number(process.env.TELEPTY_SESSION_STALE_SECONDS || 60));
const SESSION_CLEANUP_SECONDS = Math.max(SESSION_STALE_SECONDS, Number(process.env.TELEPTY_SESSION_CLEANUP_SECONDS || 300));
const DELIVERY_TIMEOUT_MS = Math.max(100, Number(process.env.TELEPTY_DELIVERY_TIMEOUT_MS || 5000));
const HEALTH_POLL_MS = Math.max(100, Number(process.env.TELEPTY_HEALTH_POLL_MS || 10000));
const IDLE_REAPER_POLL_MS = Math.max(100, Number(process.env.TELEPTY_IDLE_REAPER_POLL_MS || 60000));
const BOOTSTRAP_READY_TIMEOUT_MS = Math.max(500, Number(process.env.TELEPTY_BOOTSTRAP_READY_TIMEOUT_MS || 30000));
// Surface FOCUS is owned by the orchestrator's Workspace Host adapter (`wh_focus`), per the
// 2026-05-30 surface-ownership verdict — telepty no longer foregrounds surfaces.
const WRAPPED_SUBMIT_DELAY_MS = 500;

// #617 hold-and-redeliver — when an inject(--submit) is classified `queued` (busy
// recipient parked the CR'd body in its composer, no turn fired), the daemon holds the
// parked body and re-fires the CR on the recipient's next busy→idle transition so the
// dropped REPORT turn finally starts. Bounded + never-double-deliver. Kill-switch
// TELEPTY_REDELIVER=off restores the pre-0.6.5 detect-only behavior (back-compat).
const REDELIVER_ENABLED = String(process.env.TELEPTY_REDELIVER || '').toLowerCase() !== 'off';
const REDELIVER_MAX_ATTEMPTS = Math.max(1, Number(process.env.TELEPTY_REDELIVER_MAX_ATTEMPTS || 3));
const REDELIVER_TOTAL_TIMEOUT_MS = Math.max(1000, Number(process.env.TELEPTY_REDELIVER_TOTAL_TIMEOUT_MS || 600000));
const REDELIVER_IDLE_WAIT_MS = Math.max(1000, Number(process.env.TELEPTY_REDELIVER_IDLE_WAIT_MS || 120000));

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

  const transitionPendingReport = getPendingReport(sessionId);
  if ((to === 'working' || to === 'thinking') && transitionPendingReport) {
    const pendingReport = transitionPendingReport;
    if (!pendingReport.submitExpected || pendingReport.submitStartedAt) {
      pendingReport.sawWorkingAfterInject = true;
      pendingReport.workingAfterInjectAt = new Date().toISOString();
    }
    // #619: capture the durable early-consumption fact the instant a genuine fresh turn
    // fires, so the idle-gate (evaluated minutes later on a scrolled-off ring) reads the
    // stored fact instead of failing to re-derive it. since_ms is set at this transition.
    const consumedSinceMs = sessionStateManager.getState(sessionId)?.since_ms;
    maybeRecordInjectConsumption(pendingReport, from, to, consumedSinceMs);
  }

  // Fire TASK_IDLE_NO_REPORT on idle transition (for sessions with pendingReports).
  // Session still needs to self-inject a content REPORT — this event only observes.
  // Legacy TASK_COMPLETE text-inject is also fired for back-compat (0.2.x grandfather).
  if (to === 'idle' && pendingReports[sessionId]) {
    const pendingReport = pendingReports[sessionId];
    // Mark as idle-notified (but keep the entry — REPORT is still pending).
    // Entry is cleared when REPORT arrives (via inject endpoint) OR session dies.
    if (pendingReport.idleNotified) return; // only fire once
    // #545: only an OSC133-marked idle with the injected body consumed from the PTY outputRing
    // is trustworthy enough to report TASK_COMPLETE. A weak prompt-glyph / silence flip (the
    // residual WORKING case the THINKING-only state guard doesn't cover) stays
    // TASK_IDLE_UNCONFIRMED — never a false complete.
    const idleTrigger = detail && detail.detail ? detail.detail.trigger : null;
    const bodyText = pendingReport.injectedBodyPreview;
    const bodyVisible = bodyText
      ? submitGate.observeBodyVisibility(session, bodyText).visible === true
      : false;
    const idleEvidenceReliable = idleTrigger === 'osc_133_prompt' && !bodyVisible;
    // real-idle: the state manager observed a genuine busy→idle transition.
    fireAutoReport(sessionId, session, pendingReport, 'real-idle', { idleEvidenceReliable });
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
  sessionPersistence.savePersistedSessions(sessions, SESSION_PERSIST_PATH);
}

function loadPersistedSessions() {
  return sessionPersistence.loadPersistedSessions(SESSION_PERSIST_PATH);
}

const app = express();
app.use(cors());

// #42 broker MVP (W3/T5) — broker-mode HTTP surface (spec §2F, §5). DEFAULT-OFF:
// only when TELEPTY_BROKER_MODE is set does the daemon mount the broker-server at
// /broker/*. Mounted BEFORE express.json so the broker reads the raw request stream
// itself (it has its own per-node JWT gate); the existing /api/* auth path is untouched.
// Fail-fast (loud throw) if a required broker env is missing. The HTTPS listener that
// serves this handler is created in the boot block below (TLS mandatory, §4.4).
let brokerServer = null;
if (brokerEnv().mode) {
  brokerServer = mountBrokerMode(app);
}

app.use(express.json());

// Peer allowlist: comma-separated IPs/CIDRs in TELEPTY_PEER_ALLOWLIST env
const PEER_ALLOWLIST = (process.env.TELEPTY_PEER_ALLOWLIST || '').split(',').map(s => s.trim()).filter(Boolean);

// #672 tailnet auto (seamless cross-machine): detect the tailnet interface once at boot
// via a PURE live scan of os.networkInterfaces(). D1: the IP is discovered, never
// configured — used only in-memory for this run, never persisted, and re-detected every
// start so a Tailscale-reassigned IP is followed automatically. Broker mode has its own
// network posture (HTTPS + per-node JWT) and is excluded from auto-bind/auto-trust.
const TAILNET = brokerServer ? null : detectTailnet();
const TAILNET_IP = TAILNET ? TAILNET.ip : null;
const AUTO_TAILNET = isTailnetAuto(process.env, TAILNET_IP);
// Auto-trust the tailnet CIDR on the auto path — safe because the socket is bound to the
// tailnet interface only (§Q2). NEVER widen a manual allowlist: an operator's explicit
// TELEPTY_PEER_ALLOWLIST is passed through verbatim.
const effectivePeerAllowlist = resolveEffectivePeerAllowlist(PEER_ALLOWLIST, AUTO_TAILNET);

// #533 Phase 2 — peer-lane inject guardrail. The orchestrator sid(s) define the
// ORCH LANE (always allowed). Space-separated; default matches aigentry-orchestrator
// bin/ask.sh so both ends agree on "who is the orchestrator" from one config. If this
// resolves empty the guardrail fails OPEN (see classifyPeerLaneInject).
const ORCHESTRATOR_SIDS = (process.env.AIGENTRY_ORCHESTRATOR_SIDS || 'orchestrator aigentry-orchestrator-claude')
  .split(/\s+/).map(s => s.trim()).filter(Boolean);

// #45 — defense-in-depth blast-radius cap for operator-lane fan-out (broadcast/
// multicast). Even legitimate operator fan-out is bounded so a single compromised
// fan-out call cannot hit an unbounded number of sessions in one hop. Generous
// default (operator broadcasts hit only the live mesh); tune via env.
const FANOUT_MAX_TARGETS = Math.max(1, Number(process.env.TELEPTY_FANOUT_MAX_TARGETS || 100));

// #43 — inject audit spine (spec §5/§8). One JSONL line per delivery into
// ~/.telepty/logs/injects.jsonl (0600). Defaults locked (hash-only preview, 30d / 50MB × 5);
// env-overridable. The writer is off the delivery hot path: auditAppend() never blocks or
// throws into a handler. P1 records claimed_from only (verified_sender_sid wired in P2).
const AUDIT_LOG_PATH = path.join(os.homedir(), '.telepty', 'logs', 'injects.jsonl');
const auditWriter = createAuditWriter({
  path: AUDIT_LOG_PATH,
  preview: process.env.TELEPTY_AUDIT_PREVIEW === '1',
  previewBytes: Number(process.env.TELEPTY_AUDIT_PREVIEW_BYTES) || 200,
  flushMs: Number(process.env.TELEPTY_AUDIT_FLUSH_MS) || 250,
  queueMax: Number(process.env.TELEPTY_AUDIT_QUEUE_MAX) || 10000,
  maxBytes: Number(process.env.TELEPTY_AUDIT_MAX_BYTES) || 50 * 1024 * 1024,
  maxFiles: Number(process.env.TELEPTY_AUDIT_MAX_FILES) || 5,
  maxAgeDays: Number(process.env.TELEPTY_AUDIT_MAX_AGE_DAYS) || 30
});
// Overflow is visible, never silent: surface a single bus event per drop (spec §8 T4).
auditWriter.on('audit_overflow', (info) => {
  try {
    broadcastBusEvent({ type: 'audit_overflow', sender: 'daemon', dropped: info.dropped, queue_max: info.queueMax, timestamp: new Date().toISOString() });
  } catch { /* bus best-effort */ }
});
auditWriter.on('audit_error', (err) => {
  console.warn(`[AUDIT] write error: ${err && err.message ? err.message : err}`);
});
// Fire-and-forget append — swallow any sync error so the audit log can never break delivery.
function auditAppend(record) {
  try { auditWriter.append(record); } catch { /* audit must never throw into a handler */ }
}

// #43 P2 — per-session verified-sender tokens (spec §4, ADR D1). The daemon mints a random
// token at /api/sessions/register and maps token→sid; the `allow` wrapper carries it in the
// parent-hijack-protected env beside TELEPTY_SESSION_ID; `inject` presents x-telepty-session-token.
// `verified_sender_sid` = the mapped sid (the daemon's own truth) or null when unverifiable.
// Issuance is idempotent per sid so the periodic metadata re-register (cli.js
// updateDaemonProcessMetadata) does NOT rotate the token out from under the carried env.
const sessionTokens = new Map(); // token → sid
const sidTokens = new Map();     // sid → token
function mintSessionToken(sid) {
  const existing = sidTokens.get(sid);
  if (existing) return existing;
  const token = crypto.randomBytes(32).toString('base64url');
  sessionTokens.set(token, sid);
  sidTokens.set(sid, token);
  return token;
}

// #47 P4 — per-session provenance nonce (spec §6, ADR §3 D3). The daemon mints one nonce per
// sid at register and delivers it to the agent ONCE over the trusted bootstrap/onboarding channel
// (the protected env, not any deliverable payload). The receiving agent trusts a delivery's origin
// banner ONLY if it carries this nonce. Issuance is idempotent per sid so the periodic metadata
// re-register does not rotate the nonce out from under the carried env (matches the token above).
const sidNonces = new Map(); // sid → nonce
function ensureSessionNonce(sid) {
  const existing = sidNonces.get(sid);
  if (existing) return existing;
  const nonce = mintSessionNonce();
  sidNonces.set(sid, nonce);
  return nonce;
}
function resolveVerifiedSender(token) {
  if (!token) return null;
  return sessionTokens.get(token) || null;
}
// Extract the presented session token from an inject request (header only — never the body,
// which is attacker-controlled). Returns the daemon-verified sid or null.
function verifiedSenderFromReq(req) {
  return resolveVerifiedSender(req.headers && req.headers['x-telepty-session-token']);
}

// Cross-machine bus relay: forward bus events to peer daemons
const relayToPeers = createPeerRelay({
  relayPeers: relayPeersFromEnv(process.env),
  relaySeen: new Set(), // dedup by message_id
  machineId: MACHINE_ID,
  expectedToken: EXPECTED_TOKEN,
  getPort: () => PORT
});

// JWT auth: set TELEPTY_JWT_SECRET to enable. Tokens in Authorization: Bearer <token>
const JWT_SECRET = process.env.TELEPTY_JWT_SECRET || null;

const verifyJwt = createVerifyJwt(JWT_SECRET);
const isAllowedPeer = createIsAllowedPeer(effectivePeerAllowlist);

// Health check – no auth required
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: pkg.version });
});

// Authentication Middleware
app.use(createAuthMiddleware({ isAllowedPeer, expectedToken: EXPECTED_TOKEN, verifyJwt }));

const PORT = process.env.PORT || 3848;
// Actual bound port. Equals PORT for a fixed port; when PORT=0 the OS assigns an
// ephemeral port and this is resolved to the real value in the listen callback.
// Reported by /api/meta so callers (e.g. the test harness) can read it back.
let boundPort = Number(PORT);

// telepty#50: bind loopback by default — a fresh install must not expose the
// inject/control API to the local network. Network exposure is an explicit
// opt-in: TELEPTY_BIND=0.0.0.0 (preferred) or the legacy HOST override.
// BREAKING: cross-machine peers that dialed this daemon directly over LAN
// need the opt-in on the daemon host after a restart (see CHANGELOG).
// Truthy for an opt-out/flag env var: set and not a falsey literal ('', '0', 'false').
function isTruthyEnv(v) {
  return v != null && v !== '' && v !== '0' && String(v).toLowerCase() !== 'false';
}

// #672 tailnet auto: the zero-config tailnet path is active only when a tailnet IP was
// detected AND the operator set no manual bind override AND did not opt out.
function isTailnetAuto(env, tailnetIp) {
  return !!tailnetIp && !env.TELEPTY_BIND && !env.HOST && !isTruthyEnv(env.TELEPTY_NO_TAILNET_AUTO);
}

// #672: auto-trust the tailnet CIDR ONLY when on the auto path with no manual allowlist.
// A non-empty manual allowlist is respected verbatim (never widened to the whole /10).
function resolveEffectivePeerAllowlist(peerAllowlist, autoTailnet) {
  return (autoTailnet && peerAllowlist.length === 0) ? [TAILNET_CIDR] : peerAllowlist;
}

// telepty#50 + #672: loopback by default; explicit TELEPTY_BIND/HOST win; on a detected
// tailnet with no override, bind the LIVE tailnet IP (never 0.0.0.0). The tailnetIp arg
// is optional so legacy 1-arg callers keep the exact #50 behavior.
function resolveBindHost(env, tailnetIp) {
  if (env.TELEPTY_BIND) return env.TELEPTY_BIND;
  if (env.HOST) return env.HOST;
  if (isTailnetAuto(env, tailnetIp)) return tailnetIp;
  return '127.0.0.1';
}

// Bind-address banner so operators can see (and fix) their exposure posture at startup
// without reading docs. Multi-line for the tailnet/loopback cases (G2).
function formatBindHint(host, tailnet) {
  if (tailnet && host === tailnet.ip) {
    const rangeNote = tailnet.nameMatched
      ? ''
      : `\n   note: tailnet IP matched by CGNAT range only (iface "${tailnet.iface}" not Tailscale-named) — if this is ISP-CGNAT, set TELEPTY_NO_TAILNET_AUTO=1`;
    return `   bind: ${host} (tailnet auto) — reachable from your Tailnet only; LAN/public closed (loopback also served)${rangeNote}`;
  }
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
    return `   bind: ${host} (loopback only) — LAN peers cannot connect; opt in with TELEPTY_BIND=0.0.0.0`
      + `\n   cross-machine: zero-config needs Tailscale (auto-binds the tailnet); otherwise set TELEPTY_BIND + TELEPTY_PEER_ALLOWLIST`;
  }
  return `   bind: ${host} — reachable from the network (TELEPTY_BIND/HOST opt-in)`;
}

// G1 (win32 only): a correct tailnet bind is not enough on Windows — Defender Firewall
// blocks inbound on the tailnet iface by default. Detect the rule; auto-add if elevated,
// else print the exact one-time command. Never fatal. No-op on mac/Linux.
function maybeGuideWindowsFirewall(port) {
  if (process.platform !== 'win32') return;
  try {
    const { ensureInboundRule } = require('./src/net/win-firewall');
    const r = ensureInboundRule({ port });
    if (r.action === 'exists') {
      console.log(`   firewall: inbound rule "${r.ruleName}" present — tailnet peers can reach :${port}`);
    } else if (r.action === 'added') {
      console.log(`   firewall: added inbound allow rule "${r.ruleName}" for :${port} (TCP)`);
    } else {
      console.log(`   firewall: Windows blocks inbound on :${port} by default. Run once as Administrator:`);
      console.log(`     ${r.command}`);
    }
  } catch (e) {
    console.warn(`[FIREWALL] check skipped: ${e && e.message}`);
  }
}

const HOST = resolveBindHost(process.env, TAILNET_IP);
process.title = 'telepty-daemon';

// Singleton claim — guarded so a test require neither exits (when a daemon is running) nor
// overwrites a live daemon's on-disk state claim (when one is). Only the real daemon claims.
if (require.main === module) {
  const daemonClaim = claimDaemonState({ host: HOST, port: Number(PORT), version: pkg.version });
  if (!daemonClaim.claimed) {
    const current = daemonClaim.current;
    console.log(`[DAEMON] telepty daemon already running (pid ${current.pid}, port ${current.port}). Exiting.`);
    process.exit(0);
  }
}

const pendingReports = Object.create(null); // {targetSessionId: {source, injectedAt, injectId}}
const AUTO_REPORT_IDLE_SECONDS = Number(process.env.TELEPTY_AUTO_REPORT_IDLE_SECONDS) || 10;
// #32: a legacy auto-report can fire ~0.0s after the inject (silence-timeout / ready-signal)
// even when the inject never reached the target TUI — indistinguishable from a real completion
// by the recipient. Below this elapsed floor the idle is NOT trusted as a processed-inject
// completion; the text-inject is relabeled so a stuck/hung target is never reported as DONE.
const AUTO_REPORT_MIN_REAL_SECONDS = Number(process.env.TELEPTY_AUTO_REPORT_MIN_REAL_SECONDS) || 1.0;
// #48: a momentary idle/ready snapshot right after an inject (the bridge re-sends 'ready' on a
// TUI prompt-glyph redraw; codex's silence+glyph flips real-idle mid-work) is almost always a
// transition-gap false positive — the session is, or moments later is, working. Before emitting
// TASK_IDLE_UNCONFIRMED, hold for this settle window and recheck the LIVE session state.
const IDLE_UNCONFIRMED_SETTLE_SECONDS = Number(process.env.TELEPTY_IDLE_UNCONFIRMED_SETTLE_SECONDS) || 5;
// Output advanced during the settle window while still idle-classified (sparse TUI redraw) →
// re-settle, bounded so periodic idle redraws cannot starve the genuinely-unconsumed signal.
const IDLE_UNCONFIRMED_SETTLE_MAX_REARMS = Math.max(0, Number(process.env.TELEPTY_IDLE_UNCONFIRMED_SETTLE_MAX_REARMS) || 3);
// #52: codex quiet-thinking (no output, no spinner) outlasts the settle chain — the recheck
// consults the same screen classifier that produced the false idle. Auxiliary heuristic: a
// wrapped child whose CPU time advanced ≥ this delta across the settle window is working
// (quiet thinking) — re-settle instead of notifying, on its own (larger) bound so a long
// no-output stretch is survivable while a pathological always-busy child still signals.
const IDLE_UNCONFIRMED_CPU_DELTA_SECONDS = Number(process.env.TELEPTY_IDLE_UNCONFIRMED_CPU_DELTA_SECONDS) || 0.1;
const IDLE_UNCONFIRMED_CPU_MAX_REARMS = Math.max(0, Number(process.env.TELEPTY_IDLE_UNCONFIRMED_CPU_MAX_REARMS) || 24);

function pendingReportHasSubmitEvidence(pendingReport) {
  return !!(pendingReport && (
    pendingReport.submitConfirmedAt ||
    pendingReport.sawWorkingAfterInject ||
    (pendingReport.submitConfirm && pendingReport.submitConfirm.accepted === true)
  ));
}

// #619: persist inject-CONSUMPTION as a DURABLE FACT at consumption-time. The #52/#545 idle-
// gate re-derives consumption from the outputRing/OSC133 marks AT IDLE-TIME; on a long Claude
// turn (idle at T+13-23min) the injected body has scrolled off the ring, so the gate fails to
// re-derive a genuine completion → false TASK_IDLE_UNCONFIRMED. Recording the fact the instant
// the turn fires makes the idle-gate decay-proof (it reads the stored fact instead).
//
// never-false-complete (the #52 invariant) is preserved by recording ONLY the #615 `consumed`
// signal — a genuine FRESH turn that started at/after the inject CR:
//   - the transition must enter a turn (→ working/thinking) FROM a non-busy state (idle/waiting);
//     a `starting`→working startup flip (#537 pollution) and a working↔thinking mid-turn sub-
//     state flip (an already-running turn, NOT ours) are both excluded;
//   - the turn's since_ms must be ≥ the inject's submit-start (a turn that predates our CR is the
//     #617 busy-park case — never our consumption);
//   - a submit must have been attempted (submitStartedAt) — a non-submit text-inject records nothing.
// A never-consumed inject therefore never gets a fact and still signals UNCONFIRMED. Pure +
// idempotent (first genuine turn wins); mutates the passed pendingReport, returns whether it recorded.
function maybeRecordInjectConsumption(pendingReport, fromState, toState, transitionSinceMs) {
  if (!pendingReport || pendingReport.injectConsumedAt) return false;
  if (toState !== 'working' && toState !== 'thinking') return false;
  if (fromState !== 'idle' && fromState !== 'waiting') return false;
  if (!pendingReport.submitStartedAt) return false;
  const submitStartedMs = new Date(pendingReport.submitStartedAt).getTime();
  if (!Number.isFinite(submitStartedMs)) return false;
  if (!Number.isFinite(transitionSinceMs) || transitionSinceMs < submitStartedMs) return false;
  pendingReport.injectConsumedAt = new Date(transitionSinceMs).toISOString();
  pendingReport.injectConsumedSinceMs = transitionSinceMs;
  return true;
}

// #52: the TASK_IDLE_UNCONFIRMED semantic is "inject may NOT have been processed" — gate it
// on CONSUMPTION evidence the daemon already owns instead of screen idleness. Evidence:
//   - a screen-VERIFIED submit confirmation (body consumed from the composer, or a state
//     transition observed after the CR) — 'force'/ambiguous accepts are NOT verification;
//   - the injected body echoed in PTY frames appended after the inject (composer/transcript
//     redraw), matched conservatively (submit-gate observeInjectEcho).
// A definitively failed submit (accepted:false — body observed stuck in the composer /
// no-land) is positive NON-consumption and can never be overridden by echo, so the
// never-false-complete invariant of #48 holds: a genuinely unconsumed inject still signals.
function observeConsumptionEvidence(pendingReport, session) {
  // #619: a durable early-consumption fact (recorded at turn-start) is decay-proof — prefer it
  // over re-deriving from the possibly scrolled-off outputRing at idle-time. This also covers the
  // #48 settle re-entry path (where `confirmed` is force-false) as a suppression backstop.
  if (pendingReport.injectConsumedAt) {
    return { observed: true, reason: 'consumed_recorded' };
  }
  const confirm = pendingReport.submitConfirm;
  if (confirm && confirm.accepted === false) {
    return { observed: false, reason: 'submit_failed' };
  }
  if (confirm && confirm.accepted === true && !confirm.ambiguous
      && (confirm.reason === 'body_consumed' || /^state_(working|thinking)$/.test(String(confirm.reason)))) {
    return { observed: true, reason: `submit_${confirm.reason}` };
  }
  const echo = submitGate.observeInjectEcho(session, pendingReport.injectedBodyPreview, {
    sinceBytes: Number.isFinite(pendingReport.ringBytesAtInject) ? pendingReport.ringBytesAtInject : null,
    stripAnsi: stripAnsiState,
  });
  return { observed: echo.observed === true, reason: echo.reason };
}

function getPendingReport(sessionId, registry = pendingReports) {
  if (typeof sessionId !== 'string') return null;
  if (sessionId === '__proto__' || sessionId === 'prototype' || sessionId === 'constructor') return null;
  if (!registry || !Object.prototype.hasOwnProperty.call(registry, sessionId)) return null;
  return registry[sessionId];
}

function markPendingReportSubmitStarted(sessionId, bodyText) {
  const pendingReport = getPendingReport(sessionId);
  if (!pendingReport) return;
  pendingReport.submitExpected = true;
  pendingReport.submitInProgress = true;
  pendingReport.submitStartedAt = new Date().toISOString();
  if (typeof bodyText === 'string') {
    pendingReport.injectedBodyPreview = bodyText.slice(0, 500);
  }
}

function markPendingReportSubmitConfirmed(sessionId, confirm) {
  const pendingReport = getPendingReport(sessionId);
  if (!pendingReport) return;
  pendingReport.submitExpected = true;
  pendingReport.submitInProgress = false;
  pendingReport.submitFinishedAt = new Date().toISOString();
  pendingReport.submitConfirmedAt = pendingReport.submitFinishedAt;
  pendingReport.submitConfirm = {
    accepted: true,
    reason: confirm && confirm.reason ? confirm.reason : 'confirmed',
    attempts: confirm && confirm.attempts ? confirm.attempts : undefined,
    ambiguous: !!(confirm && confirm.ambiguous),
  };
}

function markPendingReportSubmitUnconfirmed(sessionId, confirm) {
  const pendingReport = getPendingReport(sessionId);
  if (!pendingReport) return;
  pendingReport.submitExpected = true;
  pendingReport.submitInProgress = false;
  pendingReport.submitFinishedAt = new Date().toISOString();
  pendingReport.submitUnconfirmedAt = pendingReport.submitFinishedAt;
  pendingReport.submitConfirm = {
    accepted: false,
    reason: confirm && confirm.reason ? confirm.reason : 'submit_unconfirmed',
    attempts: confirm && confirm.attempts ? confirm.attempts : undefined,
    retryable: !!(confirm && confirm.retryable),
  };
}

// #32: single provenance-tagged auto-report path (was 3 byte-identical builders at the
// onTransition-idle / silence-timeout / ready-signal sites). `trigger` distinguishes the
// originating path; sub-floor elapsed is relabeled TASK_IDLE_UNCONFIRMED instead of TASK_COMPLETE.
// Caller is responsible for the `!pendingReport.idleNotified` once-only guard.
// `deps` is a thin DI seam (defaults = module globals) so the elapsed→label decision is
// unit-testable with an injected clock and a captured deliver fn — behavior is byte-identical
// for the production callers, which pass no deps.
function fireAutoReport(targetId, targetSession, pendingReport, trigger, deps = {}) {
  const _now = deps.now || Date.now;
  const _setTimeout = deps.setTimeout || setTimeout;
  const _broadcast = deps.broadcastSessionEvent || broadcastSessionEvent;
  const _resolveAlias = deps.resolveSessionAlias || resolveSessionAlias;
  const _sessions = deps.sessions || sessions;
  const _pendingReports = deps.pendingReports || pendingReports;
  const _deliver = deps.deliverInjectionToSession || deliverInjectionToSession;
  // #48: live auto-state lookup for the settle recheck (DI for unit tests).
  const _getAutoState = deps.getAutoState || ((sid) => {
    const st = sessionStateManager.getState(sid);
    return st && st.state ? st.state : null;
  });
  // #52: wrapped-child CPU sampler for the quiet-thinking recheck (DI for unit tests).
  const _sampleChildCpu = deps.sampleChildCpu || ((sess) =>
    sampleChildCpuSeconds(sess ? (sess.ptyPid || (sess.ptyProcess && sess.ptyProcess.pid) || null) : null));

  const elapsedNum = (_now() - new Date(pendingReport.injectedAt).getTime()) / 1000;
  const elapsed = elapsedNum.toFixed(1);
  const hasSubmitEvidence = pendingReportHasSubmitEvidence(pendingReport);

  if (trigger === 'ready-signal' && pendingReport.submitExpected) {
    if (hasSubmitEvidence) {
      console.log(`[AUTO-REPORT] ${targetId} ready-signal suppressed; submit already confirmed`);
      return;
    }

    const shouldWaitForSubmit = pendingReport.submitInProgress === true || elapsedNum < AUTO_REPORT_MIN_REAL_SECONDS;
    if (shouldWaitForSubmit) {
      if (!pendingReport.readySignalTimer) {
        const floorDelayMs = Math.max(50, Math.ceil((AUTO_REPORT_MIN_REAL_SECONDS - elapsedNum) * 1000));
        const delayMs = pendingReport.submitInProgress === true ? Math.min(250, Math.max(50, floorDelayMs)) : floorDelayMs;
        pendingReport.readySignalTimer = _setTimeout(() => {
          pendingReport.readySignalTimer = null;
          const currentPending = getPendingReport(targetId, _pendingReports);
          if (!currentPending || currentPending.idleNotified) return;
          if (pendingReportHasSubmitEvidence(currentPending)) {
            console.log(`[AUTO-REPORT] ${targetId} ready-signal dwell suppressed; submit confirmed`);
            return;
          }
          fireAutoReport(targetId, _sessions[targetId] || targetSession, currentPending, 'ready-signal', deps);
        }, delayMs);
      }
      console.log(`[AUTO-REPORT] ${targetId} ready-signal deferred; awaiting submit confirmation`);
      return;
    }
  }

  // #537 / Bug B: a never-started worker (transient submit failure → claude startup
  // busy→idle settle at ~4.5s) must NOT be reported TASK_COMPLETE. When a submit was
  // expected, the elapsed floor and startup-polluted sawWorkingAfterInject are NOT trusted
  // as proof of processing — require positive submit confirmation (screen-poll verify /
  // honest force / gate-off). Paths with no submit expected keep the legacy floor/work rule.
  const strongSubmitConfirmed = !!(
    // #619: a durable early-consumption fact (a genuine fresh turn fired by the inject) is
    // the strongest completion proof there is — stronger than a screen-derived submit confirm
    // and decay-proof at idle-time. Recorded conservatively (maybeRecordInjectConsumption), so
    // this never promotes a never-consumed inject.
    pendingReport.injectConsumedAt ||
    pendingReport.submitConfirmedAt ||
    (pendingReport.submitConfirm && pendingReport.submitConfirm.accepted === true)
  );
  // #545: a `real-idle` flip with weak evidence (no OSC133 REPL-done mark / injected body still
  // visible in the PTY outputRing) must NOT be reported TASK_COMPLETE — a still-busy worker that
  // merely paused output gets the honest TASK_IDLE_UNCONFIRMED. The caller (onTransition) sets
  // deps.idleEvidenceReliable; === false forces the downgrade. Scoped to submitExpected (the #545
  // symptom — a submit-confirmed worker still thinking), consistent with the BUG-B confirm gate;
  // plain non-submit injects keep their existing floor-based completion. Absent flag / other
  // triggers preserve prior behavior.
  // #619: a recorded early-consumption fact overrides the decayed at-idle evidence. The
  // `idleEvidenceReliable === false` downgrade exists because the screen-derived evidence is
  // weak; a stored consumption fact IS the (decay-proof) evidence, so the downgrade no longer
  // applies. Without a recorded fact, behavior is unchanged (#545/#52 conservative UNCONFIRMED).
  const idleEvidenceUnreliable = trigger === 'real-idle'
    && pendingReport.submitExpected
    && deps.idleEvidenceReliable === false
    && !pendingReport.injectConsumedAt;
  // #48: a settled recheck re-enters ONLY to emit the UNCONFIRMED label — pinned at arm time,
  // so elapsed growing past the floor during the settle window can never promote a stale idle
  // snapshot to TASK_COMPLETE (never a false complete).
  const confirmed = pendingReport.unconfirmedSettleDone
    ? false
    : trigger === 'ready-signal' && pendingReport.submitExpected
      ? false
      : idleEvidenceUnreliable
        ? false
        : pendingReport.submitExpected
          ? strongSubmitConfirmed
          : (elapsedNum >= AUTO_REPORT_MIN_REAL_SECONDS || hasSubmitEvidence);

  // #48: settle-and-recheck before any UNCONFIRMED notification. The first weak idle/ready
  // snapshot right after an inject is almost always a transition gap — the bridge re-sends
  // 'ready' on a TUI prompt-glyph redraw (with no state transition, no evidence flag is ever
  // set even though the session IS working), and codex's silence+glyph heuristic flips
  // real-idle mid-work. Hold the notification for a settle window and recheck the LIVE
  // session: notify only when it is still not working AND its output has not advanced.
  // Suppression does NOT consume the once-only idleNotified guard, so a later genuine
  // busy→idle transition re-enters this path (and an evidence-backed one reports COMPLETE).
  if (!confirmed && !pendingReport.unconfirmedSettleDone) {
    if (pendingReport.unconfirmedSettleTimer) return; // settle window already open
    const settleMs = Math.max(50, Math.round(IDLE_UNCONFIRMED_SETTLE_SECONDS * 1000));
    const armSettle = () => {
      const liveAtArm = _sessions[targetId] || targetSession;
      const activityAtArm = liveAtArm ? liveAtArm.lastActivityAt : null;
      const cpuAtArm = _sampleChildCpu(liveAtArm); // #52: null when unobservable
      pendingReport.unconfirmedSettleTimer = _setTimeout(() => {
        pendingReport.unconfirmedSettleTimer = null;
        const currentPending = getPendingReport(targetId, _pendingReports);
        // REPORT arrived / entry replaced / another path already notified — stand down.
        if (currentPending !== pendingReport || currentPending.idleNotified) return;
        const liveSession = _sessions[targetId] || targetSession;
        const autoState = _getAutoState(targetId);
        if (autoState === 'working' || autoState === 'thinking') {
          console.log(`[AUTO-REPORT] ${targetId} idle-unconfirmed suppressed after settle — session is ${autoState} (trigger=${trigger})`);
          return;
        }
        const activityNow = liveSession ? liveSession.lastActivityAt : null;
        if (activityNow !== activityAtArm
            && (pendingReport.unconfirmedSettleRearms || 0) < IDLE_UNCONFIRMED_SETTLE_MAX_REARMS) {
          pendingReport.unconfirmedSettleRearms = (pendingReport.unconfirmedSettleRearms || 0) + 1;
          console.log(`[AUTO-REPORT] ${targetId} output advanced during settle — re-settling (${pendingReport.unconfirmedSettleRearms}/${IDLE_UNCONFIRMED_SETTLE_MAX_REARMS})`);
          armSettle();
          return;
        }
        // #52: screen idle + output stalled, but the wrapped child's CPU time advanced
        // across the settle window → quiet thinking (codex no-spinner blind spot). Treat
        // as working: re-settle on its own bound instead of notifying.
        const cpuNow = _sampleChildCpu(liveSession);
        if (cpuAtArm != null && cpuNow != null
            && (cpuNow - cpuAtArm) >= IDLE_UNCONFIRMED_CPU_DELTA_SECONDS
            && (pendingReport.unconfirmedCpuRearms || 0) < IDLE_UNCONFIRMED_CPU_MAX_REARMS) {
          pendingReport.unconfirmedCpuRearms = (pendingReport.unconfirmedCpuRearms || 0) + 1;
          console.log(`[AUTO-REPORT] ${targetId} child CPU advanced ${(cpuNow - cpuAtArm).toFixed(2)}s during settle — quiet-thinking; re-settling (${pendingReport.unconfirmedCpuRearms}/${IDLE_UNCONFIRMED_CPU_MAX_REARMS})`);
          armSettle();
          return;
        }
        pendingReport.unconfirmedSettleDone = true;
        fireAutoReport(targetId, liveSession || targetSession, currentPending, trigger, deps);
      }, settleMs);
    };
    armSettle();
    console.log(`[AUTO-REPORT] ${targetId} idle unconfirmed at ${elapsed}s (trigger=${trigger}) — settling ${IDLE_UNCONFIRMED_SETTLE_SECONDS}s before notify`);
    return;
  }

  // #52: before emitting the unconfirmed-DELIVERY warning, check for inject-consumption
  // evidence (screen-verified submit / post-inject echo). Idle-looking + consumed is at
  // most a TASK_IDLE fact — not "inject may NOT have been processed". Suppression does not
  // consume the once-only idleNotified guard, so a later evidence-backed genuine busy→idle
  // transition can still report TASK_COMPLETE, and the pending entry stays armed until the
  // worker's content REPORT arrives. Confirmed completions (confirmed === true) are
  // untouched — this gate only ever silences a would-be false warning, never a signal that
  // a genuinely unconsumed inject produced (no echo + no verified submit ⇒ falls through).
  if (!confirmed) {
    const _observeConsumption = deps.observeConsumptionEvidence || observeConsumptionEvidence;
    const consumption = _observeConsumption(pendingReport, _sessions[targetId] || targetSession);
    if (consumption.observed) {
      console.log(`[AUTO-REPORT] ${targetId} idle-unconfirmed suppressed — inject consumption observed (${consumption.reason}, trigger=${trigger})`);
      return;
    }
  }

  pendingReport.idleNotified = true;
  pendingReport.idleAt = new Date(_now()).toISOString();

  // Richer bus event (observability) — now also carries the trigger provenance.
  _broadcast('TASK_IDLE_NO_REPORT', targetId, targetSession, {
    extra: {
      source: pendingReport.source,
      inject_id: pendingReport.injectId,
      elapsed_secs: Number(elapsed),
      injected_at: pendingReport.injectedAt,
      trigger
    }
  });
  console.log(`[ENFORCE-REPORT] ${targetId} idle after ${elapsed}s (trigger=${trigger}) — awaiting REPORT from ${pendingReport.source}`);

  const srcId = _resolveAlias(pendingReport.source) || pendingReport.source;
  const srcSession = _sessions[srcId];
  if (!srcSession) return;

  const injTag = pendingReport.injectId ? ` inject=${pendingReport.injectId}` : '';
  const reportMsg = confirmed
    ? `TASK_COMPLETE: ${targetId} is now idle after processing inject (${elapsed}s, via ${trigger}${injTag})`
    : `TASK_IDLE_UNCONFIRMED: ${targetId} signaled idle ${elapsed}s after inject (via ${trigger}${injTag}) — inject may NOT have been processed; verify before treating as done`;
  _deliver(srcId, srcSession, reportMsg, { noEnter: false, source: 'auto_report' });
  console.log(`[AUTO-REPORT] ${targetId} → ${srcId}: ${confirmed ? 'TASK_COMPLETE' : 'TASK_IDLE_UNCONFIRMED'} after ${elapsed}s (trigger=${trigger})`);
}

const sessions = {};
const handoffs = {};
const threads = {};
let teleptyConfig;
try {
  teleptyConfig = loadTeleptyConfig();
} catch (err) {
  console.error(`[CONFIG] Failed to load telepty config: ${err.message}`);
  process.exit(1);
}

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

// #533 Phase 2 — pure peer-lane inject policy verdict (self-contained; no parser
// dependency). The PEER LANE is sender ≠ orchestrator AND target ≠ orchestrator.
// On that lane the body MUST be a sanctioned compact-JSON envelope (the shape
// produced by aigentry-orchestrator bin/ask.sh build_envelope); anything else is
// out-of-policy peer→peer traffic (e.g. work-delegation) and is blocked.
// Returns { lane, decision, reason, kind, envelopePresent }:
//   lane ∈ 'orchestrator' | 'peer' | 'disabled'
//   decision ∈ 'allow' | 'block'
//   kind ∈ 'ask-request' | 'ask-reply' | null
const PEER_INJECT_KINDS = new Set(['ask-request', 'ask-reply']);

function classifyPeerLaneInject({ from, to, prompt, orchestratorSids } = {}) {
  const orchSet = Array.isArray(orchestratorSids) ? orchestratorSids : [];
  // Fail-OPEN: with no known orchestrator sid we cannot tell the orch lane apart
  // from the peer lane (every inject would look peer-lane), which would over-block
  // legitimate orchestrator traffic and brick the mesh. Degrade to allow + warn;
  // the Phase-1 orchestrator-side auditor still detects raw bypass (defense in depth).
  if (orchSet.length === 0) {
    return { lane: 'disabled', decision: 'allow', reason: 'orch-sid-unconfigured-fail-open', kind: null, envelopePresent: false };
  }
  // No sender → operator/CLI/multicast/broadcast, never peer-lane.
  if (!from) {
    return { lane: 'orchestrator', decision: 'allow', reason: 'no-sender', kind: null, envelopePresent: false };
  }
  // Orchestrator lane (either end is the orchestrator) → always allowed, untouched.
  if (orchSet.includes(from) || orchSet.includes(to)) {
    return { lane: 'orchestrator', decision: 'allow', reason: 'orch-lane', kind: null, envelopePresent: false };
  }

  // Peer lane: require a sanctioned envelope on the first non-empty line.
  let env = null;
  try {
    const firstLine = String(prompt || '').split(/\r?\n/).map(l => l.trim()).find(l => l.length > 0);
    if (firstLine) {
      const parsed = JSON.parse(firstLine);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) env = parsed;
    }
  } catch {
    env = null;
  }
  if (!env) {
    return { lane: 'peer', decision: 'block', reason: 'malformed-envelope', kind: null, envelopePresent: false };
  }
  if (!PEER_INJECT_KINDS.has(env.kind)) {
    return { lane: 'peer', decision: 'block', reason: 'wrong-kind', kind: null, envelopePresent: true };
  }
  // Common required fields + per-kind payload (matches ask.sh build_envelope).
  const nonEmptyStr = (v) => typeof v === 'string' && v.length > 0;
  const baseOk = nonEmptyStr(env.from) && nonEmptyStr(env.to) && nonEmptyStr(env.thread_id) && Number.isInteger(env.round);
  const payloadOk = env.kind === 'ask-request' ? nonEmptyStr(env.question) : nonEmptyStr(env.answer);
  if (!baseOk || !payloadOk) {
    return { lane: 'peer', decision: 'block', reason: 'invalid-field', kind: null, envelopePresent: true };
  }
  // Sender-consistency: the envelope's declared sender must match the inject's
  // from (cheap anti-spoof). `to` is NOT cross-checked — the route resolves aliases,
  // which would false-block legitimate aliased targets.
  if (env.from !== from) {
    return { lane: 'peer', decision: 'block', reason: 'from-mismatch', kind: null, envelopePresent: true };
  }
  return { lane: 'peer', decision: 'allow', reason: 'sanctioned-envelope', kind: env.kind, envelopePresent: true };
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

function parseOptionalIdleTtl(body) {
  if (!body || !Object.prototype.hasOwnProperty.call(body, 'idle_ttl')) {
    return { present: false };
  }
  try {
    return {
      present: true,
      raw: body.idle_ttl == null ? 'off' : String(body.idle_ttl),
      ms: lifecycle.parseDuration(body.idle_ttl == null ? 'off' : body.idle_ttl, { fieldName: 'idle_ttl' })
    };
  } catch (err) {
    return { present: true, error: err.message };
  }
}

function applyProcessMetadata(session, body) {
  if (!session || !body) return;
  const ownerPid = Number(body.owner_pid);
  const ptyPid = Number(body.pty_pid);
  if (Number.isInteger(ownerPid) && ownerPid > 0) {
    session.ownerPid = ownerPid;
  }
  if (Number.isInteger(ptyPid) && ptyPid > 0) {
    session.ptyPid = ptyPid;
  }
}

function applyIdleTtlMetadata(session, parsedIdleTtl) {
  if (!session || !parsedIdleTtl || !parsedIdleTtl.present || parsedIdleTtl.error) return;
  session.idleTtl = parsedIdleTtl.raw;
  session.idleTtlMs = parsedIdleTtl.ms;
}

function applyTimestampMetadata(session, body) {
  if (!session || !body) return;
  for (const [field, prop] of [
    ['created_at', 'createdAt'],
    ['last_activity_at', 'lastActivityAt']
  ]) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    const value = body[field] == null ? null : String(body[field]);
    if (value && Number.isFinite(new Date(value).getTime())) {
      session[prop] = value;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBootstrapGatedSession(session) {
  return !!(session && session.type === 'wrapped' && readyRegistry.isKnownAiCli(session.command));
}

function initializeBootstrapState(session) {
  if (!session) return session;
  if (!Array.isArray(session.bootstrapQueue)) {
    session.bootstrapQueue = [];
  }
  session.bootstrapDraining = session.bootstrapDraining === true;
  session.bootstrapDrainPromise = session.bootstrapDrainPromise || null;
  session.bootstrapPromptPoll = session.bootstrapPromptPoll || null;

  if (isBootstrapGatedSession(session)) {
    session.bootstrapReady = session.bootstrapReady === true;
    session.bootstrapReadyAt = session.bootstrapReadyAt || null;
    session.bootstrapReadyReason = session.bootstrapReadyReason || null;
    session.ready = session.bootstrapReady === true;
  } else {
    session.bootstrapReady = true;
    session.bootstrapReadyAt = session.bootstrapReadyAt || new Date().toISOString();
    session.bootstrapReadyReason = session.bootstrapReadyReason || 'generic_command_compat';
    session.ready = true;
  }
  return session;
}

function isBootstrapReady(session) {
  return !isBootstrapGatedSession(session) || session.bootstrapReady === true;
}

function buildBootstrapBlock(session) {
  return {
    gated: isBootstrapGatedSession(session),
    ready: isBootstrapReady(session),
    ready_at: session.bootstrapReadyAt || null,
    reason: session.bootstrapReadyReason || null,
    queued: Array.isArray(session.bootstrapQueue) ? session.bootstrapQueue.length : 0,
    draining: session.bootstrapDraining === true
  };
}

function shouldQueueBootstrapOperation(session) {
  return isBootstrapGatedSession(session) && !isBootstrapReady(session);
}

function hasBootstrapBacklog(session) {
  return !!(session && Array.isArray(session.bootstrapQueue) && session.bootstrapQueue.length > 0);
}

function emitBootstrapEvent(eventType, sessionId, session, extra = {}) {
  broadcastSessionEvent(eventType, sessionId, session, {
    extra: {
      bootstrap: buildBootstrapBlock(session),
      ...extra
    }
  });
}

function enqueueBootstrapOperation(sessionId, session, operation) {
  initializeBootstrapState(session);
  const op = {
    op_id: crypto.randomUUID(),
    queued_at: new Date().toISOString(),
    ...operation
  };

  if (op.type === 'submit') {
    op.promise = new Promise((resolve) => {
      op.resolve = resolve;
    });
  }

  session.bootstrapQueue.push(op);
  emitBootstrapEvent('bootstrap_queue_queued', sessionId, session, {
    op_id: op.op_id,
    operation: op.type,
    depth: session.bootstrapQueue.length
  });
  scheduleBootstrapPromptPoll(sessionId, session);
  return op;
}

function resolveBootstrapSubmit(op, result) {
  if (op && typeof op.resolve === 'function') {
    op.resolve(result);
    op.resolve = null;
  }
}

function bootstrapQueuedResponse(op, extra = {}) {
  return {
    success: true,
    strategy: 'bootstrap_queue',
    queued: true,
    bootstrap_queued: true,
    bootstrap_op_id: op.op_id,
    ...extra
  };
}

async function executeBootstrapInject(sessionId, session, op) {
  const prompt = typeof op.prompt === 'string' ? op.prompt : '';
  const textResult = await writeDataToSession(sessionId, session, prompt);
  if (!textResult.success) return textResult;

  if (!op.noEnter) {
    await sleep(WRAPPED_SUBMIT_DELAY_MS);
    const submitResult = await writeDataToSession(sessionId, session, '\r');
    if (!submitResult.success) return submitResult;
  }

  session.lastActivityAt = new Date().toISOString();
  return {
    success: true,
    strategy: 'bootstrap_direct',
    submit: op.noEnter ? 'skipped' : 'sent'
  };
}

function parseSubmitRetryOptions(body = {}, injectedBody = null) {
  const hasExplicitRetries = body && body.retries !== undefined && body.retries !== null;
  // #568: raise the retry-budget ceiling so a momentarily-busy CLI still gets a
  // render-gated CR before we return 504 (each retry re-gates on input-ready, so
  // more attempts = more quiet-window chances to land). Ceilings only — the
  // default stays 1 for the injected case (behavior-preserving common path);
  // heavier callers opt into the bigger budget via retries/retry_delay_ms/
  // verify_timeout_ms. Total worst-case budget stays bounded (~10 attempts).
  const retries = Math.min(Math.max(Number(hasExplicitRetries ? body.retries : (injectedBody ? 1 : 0)) || 0, 0), 10);
  const retryDelayMs = Math.min(Math.max(Number(body?.retry_delay_ms) || 500, 100), 3000);
  const verifyTimeoutMs = Math.min(Math.max(Number(body?.verify_timeout_ms) || 1500, 200), 8000);
  return { retries, retryDelayMs, verifyTimeoutMs };
}

function buildSubmitVerify(confirm) {
  if (!confirm) return null;
  return {
    consumed: confirm.accepted === true,
    waited_ms: confirm.waited_ms || 0,
    reason: confirm.reason || null,
    source: confirm.visibility && confirm.visibility.source ? confirm.visibility.source : undefined,
    ambiguous: confirm.ambiguous === true || undefined,
    retryable: confirm.retryable === true || undefined,
  };
}

function buildSubmitConfirmOptions(id, session, submittedAtMs, verifyTimeoutMs) {
  return {
    timeoutMs: verifyTimeoutMs,
    intervalMs: 50,
    submittedAtMs,
    stripAnsi: stripAnsiState,
    getState: () => sessionStateManager.getState(id),
  };
}

async function confirmSubmitAfterDispatch(id, session, injectedBody, submittedAtMs, verifyTimeoutMs) {
  if (!injectedBody || injectedBody.length === 0) {
    return null;
  }
  return submitGate.confirmSubmitAccepted(session, injectedBody, buildSubmitConfirmOptions(id, session, submittedAtMs, verifyTimeoutMs));
}

// #568 — render-gate the submit CR. Before writing the bare 0x0D, wait (bounded)
// until the injected body is echoed in the PTY outputRing AND the render has gone
// quiet, so the CR does not land mid-render and get dropped (FM1; same gate before
// each retry CR, FM2). Best-effort + bounded: on timeout / no body / no ring we
// fall through and still write the CR — never worse than the pre-gate behavior.
// pty_cr stays the ONLY write path (terminalLevelSubmit); this only times WHEN.
// Per-request opt-out via `input_settle_gate: false` (rollback/parity escape hatch).
async function gatedTerminalSubmit(id, session, injectedBody, settleEnabled) {
  if (injectedBody && injectedBody.length > 0 && settleEnabled !== false) {
    const settle = await submitGate.awaitInputSettled(session, injectedBody, {
      timeoutMs: 1200,
      quietWindowMs: 100,
      echoGraceMs: 400,
      pollIntervalMs: 30,
      stripAnsi: stripAnsiState,
    });
    if (!settle.ready) {
      console.log(`[SUBMIT] input-settle gate timed out for ${id} (${settle.waited_ms}ms, echoed=${settle.echoed}) — sending CR best-effort`);
    }
  }
  return terminalLevelSubmit(id, session);
}

// #617 — detached hold-and-redeliver for a `queued` inject. The /submit response has
// already returned (the worker's `telepty inject` got consumption='queued' / a plain
// force success and EXITS), so the daemon owns delivery from here: it re-classifies
// when the status is unknown (the force path skips the synchronous classify), and if
// `queued`, runs the bounded submitGate.holdAndRedeliver loop — watching the recipient's
// auto-state for busy→idle (awaitReplReady) and re-firing the bare CR (the body is still
// parked in the composer) until it is consumed as a fresh turn. Fire-and-forget: never
// awaited by the handler, so it cannot affect the response or block the caller.
function scheduleQueuedRedeliver(id, session, injectedBody, opts = {}) {
  if (!REDELIVER_ENABLED) return;
  if (!injectedBody || injectedBody.length === 0) return;
  if (!session) return;
  // One in-flight redeliver per session — never stack idle-watchers for the same composer.
  if (session._redeliverInFlight) return;
  session._redeliverInFlight = true;

  const emitSubmitBus = typeof opts.emitSubmitBus === 'function' ? opts.emitSubmitBus : () => {};
  const knownConsumption = opts.knownConsumption || null;

  const isParked = () =>
    submitGate.observeBodyVisibility(session, injectedBody, { stripAnsi: stripAnsiState }).visible === true;

  // Re-fire a bare CR (body already parked) then re-classify against a FRESH watermark:
  // the recipient is now idle, so a genuine idle→working/thinking turn is observable as
  // `consumed` (#53). A still-`queued` result means the CR did not fire the composer — retry.
  const fireCR = async () => {
    const strategy = await gatedTerminalSubmit(id, session, injectedBody, true);
    if (!strategy) return { redelivered: false, reason: 'strategy_failed' };
    const submittedAtMs = Date.now();
    const sinceBytes = session.outputRingTotalBytes || 0;
    const c = await submitGate.classifyInjectConsumption(session, injectedBody, {
      submittedAtMs,
      sinceBytes,
      getState: () => sessionStateManager.getState(id),
      stripAnsi: stripAnsiState,
    });
    return { redelivered: c.status === 'consumed', reason: c.reason };
  };

  const waitForIdle = (remainingMs) =>
    submitGate.awaitReplReady(id, sessionStateManager, {
      timeoutMs: Math.min(remainingMs, REDELIVER_IDLE_WAIT_MS),
    });

  const run = async () => {
    // Force path skips the synchronous classify — establish the `queued` precondition here
    // before holding an idle-watcher. Only a busy-parked body needs rescue.
    if (knownConsumption !== 'queued') {
      if (Number.isFinite(opts.submittedAtMs)) {
        const c = await submitGate.classifyInjectConsumption(session, injectedBody, {
          submittedAtMs: opts.submittedAtMs,
          sinceBytes: Number.isFinite(opts.ringBytesAtSubmit) ? opts.ringBytesAtSubmit : (session.outputRingTotalBytes || 0),
          getState: () => sessionStateManager.getState(id),
          stripAnsi: stripAnsiState,
        });
        if (c.status !== 'queued') return; // consumed / unknown — nothing to redeliver
      } else {
        return; // no watermark to classify against — cannot safely redeliver
      }
    }

    console.log(`[REDELIVER] ${id} inject queued on busy recipient — holding for idle to re-fire`);
    const result = await submitGate.holdAndRedeliver({
      waitForIdle,
      isStillParked: isParked,
      fireCR,
      maxAttempts: REDELIVER_MAX_ATTEMPTS,
      totalTimeoutMs: REDELIVER_TOTAL_TIMEOUT_MS,
      onAttempt: ({ attempt }) =>
        console.log(`[REDELIVER] ${id} idle — re-firing queued inject (attempt ${attempt}/${REDELIVER_MAX_ATTEMPTS})`),
      onExhausted: ({ reason, attempts }) => {
        console.log(`[REDELIVER] ${id} redeliver-exhausted (${reason}, attempts=${attempts})`);
        emitSubmitBus({ redeliver: 'exhausted', redeliver_reason: reason, redeliver_attempts: attempts });
      },
    });

    if (result.status === 'redelivered') {
      console.log(`[REDELIVER] ${id} queued inject redelivered after ${result.attempts} attempt(s)`);
      markPendingReportSubmitConfirmed(id, { reason: 'redelivered', attempts: result.attempts });
      emitSubmitBus({ redeliver: 'redelivered', redeliver_attempts: result.attempts });
    } else if (result.status === 'already_consumed') {
      console.log(`[REDELIVER] ${id} queued inject already consumed (${result.reason}) — no re-fire`);
    }
  };

  Promise.resolve()
    .then(run)
    .catch((err) => console.log(`[REDELIVER] ${id} redeliver error: ${err && err.message}`))
    .finally(() => { session._redeliverInFlight = false; });
}

async function executeBootstrapSubmit(sessionId, session, op) {
  const body = op.body || {};
  const injectedBody = typeof body.injected_body === 'string' ? body.injected_body : null;
  const { retries, retryDelayMs, verifyTimeoutMs } = parseSubmitRetryOptions(body, injectedBody);
  if (injectedBody) {
    markPendingReportSubmitStarted(sessionId, injectedBody);
  }

  const settleEnabled = body.input_settle_gate !== false;
  let strategy = await gatedTerminalSubmit(sessionId, session, injectedBody, settleEnabled);
  const submittedAtMs = Date.now();
  if (!strategy) {
    if (injectedBody) {
      markPendingReportSubmitUnconfirmed(sessionId, { reason: 'strategy_failed', attempts: 0, retryable: false });
    }
    return {
      status: 503,
      body: {
        error: 'Submit failed via all strategies (kitty/cmux/pty)',
        strategy: 'none',
        attempts: 0,
        gated: false,
        bootstrap_queued: true
      }
    };
  }
  let attempts = 1;
  let confirm = await confirmSubmitAfterDispatch(sessionId, session, injectedBody, submittedAtMs, verifyTimeoutMs);
  while (confirm && !confirm.accepted && confirm.retryable && attempts <= retries) {
    await sleep(retryDelayMs);
    const retryStrategy = await gatedTerminalSubmit(sessionId, session, injectedBody, settleEnabled);
    const retrySubmittedAtMs = Date.now();
    if (!retryStrategy) break;
    strategy = retryStrategy;
    attempts++;
    confirm = await confirmSubmitAfterDispatch(sessionId, session, injectedBody, retrySubmittedAtMs, verifyTimeoutMs);
  }

  if (confirm && !confirm.accepted) {
    markPendingReportSubmitUnconfirmed(sessionId, { ...confirm, attempts });
    return {
      status: 504,
      body: {
        error: 'Submit body still visible after bounded confirmation retry',
        reason: 'submit_unconfirmed',
        strategy,
        attempts,
        gated: false,
        verify: buildSubmitVerify(confirm),
        confirm,
        bootstrap_queued: true
      }
    };
  }

  if (injectedBody) {
    markPendingReportSubmitConfirmed(sessionId, { ...(confirm || { reason: 'empty_body' }), attempts });
  }
  return {
    status: 200,
    body: {
      success: true,
      strategy,
      attempts,
      gated: false,
      verify: buildSubmitVerify(confirm),
      confirm,
      bootstrap_queued: true
    }
  };
}

async function drainBootstrapQueue(sessionId, session) {
  if (!session || session.bootstrapDraining) {
    return session ? session.bootstrapDrainPromise : null;
  }
  if (!isBootstrapReady(session)) {
    return null;
  }

  session.bootstrapDraining = true;
  session.bootstrapDrainPromise = (async () => {
    while (hasBootstrapBacklog(session)) {
      const op = session.bootstrapQueue.shift();
      try {
        if (op.cancelled) {
          continue;
        }
        if (op.type === 'inject') {
          const result = await executeBootstrapInject(sessionId, session, op);
          if (!result.success) {
            emitBootstrapEvent('bootstrap_queue_failed', sessionId, session, {
              op_id: op.op_id,
              operation: op.type,
              code: result.code || 'DELIVERY_FAILED',
              error: result.error || 'bootstrap delivery failed'
            });
          }
        } else if (op.type === 'submit') {
          const result = await executeBootstrapSubmit(sessionId, session, op);
          resolveBootstrapSubmit(op, result);
          if (result.status >= 400) {
            emitBootstrapEvent('bootstrap_queue_failed', sessionId, session, {
              op_id: op.op_id,
              operation: op.type,
              code: result.body.code || 'SUBMIT_FAILED',
              error: result.body.error || 'bootstrap submit failed'
            });
          }
        }
      } catch (error) {
        if (op.type === 'submit') {
          resolveBootstrapSubmit(op, {
            status: 500,
            body: {
              error: error.message || 'bootstrap submit failed',
              strategy: 'none',
              attempts: 0,
              gated: false,
              bootstrap_queued: true
            }
          });
        }
        emitBootstrapEvent('bootstrap_queue_failed', sessionId, session, {
          op_id: op.op_id,
          operation: op.type,
          code: 'BOOTSTRAP_DRAIN_FAILED',
          error: error.message || 'bootstrap drain failed'
        });
      }
    }

    emitBootstrapEvent('bootstrap_queue_drained', sessionId, session);
  })().finally(() => {
    session.bootstrapDraining = false;
    session.bootstrapDrainPromise = null;
  });

  return session.bootstrapDrainPromise;
}

function markBootstrapReady(sessionId, session, reason) {
  if (!session) return false;
  initializeBootstrapState(session);
  if (!isBootstrapGatedSession(session)) {
    return false;
  }
  if (session.bootstrapReady === true) {
    return false;
  }

  session.bootstrapReady = true;
  session.bootstrapReadyAt = new Date().toISOString();
  session.bootstrapReadyReason = reason || 'ready';
  session.ready = true;
  emitBootstrapEvent('bootstrap_ready', sessionId, session, { reason: session.bootstrapReadyReason });
  drainBootstrapQueue(sessionId, session);
  return true;
}

// #31 (AC-31.4): a session stuck past the bootstrap timeout must surface an ACTIONABLE error
// and stop queuing forever. Emit an actionable bootstrap_ready_timeout (hint + dropped count)
// and FLUSH the queue: submit ops resolve 504, inject ops fail — instead of silently
// accumulating until the process is killed. The caller can re-inject if the target recovers.
function failBootstrapQueueOnTimeout(sessionId, session, detail = {}) {
  const queued = Array.isArray(session.bootstrapQueue) ? session.bootstrapQueue.length : 0;
  emitBootstrapEvent('bootstrap_ready_timeout', sessionId, session, {
    ...detail,
    actionable: true,
    queued_dropped: queued,
    hint: `Session '${sessionId}' did not become inject-ready within ${BOOTSTRAP_READY_TIMEOUT_MS}ms — the target CLI (e.g. codex MCP init) may be hung. Inspect the surface and re-spawn if needed; queued injects were flushed.`
  });
  if (queued === 0) return;
  const drained = session.bootstrapQueue.splice(0, queued);
  for (const op of drained) {
    if (op.type === 'submit') {
      resolveBootstrapSubmit(op, {
        status: 504,
        body: {
          error: `bootstrap_ready_timeout — '${sessionId}' not ready within ${BOOTSTRAP_READY_TIMEOUT_MS}ms`,
          reason: detail.reason || 'bootstrap_ready_timeout',
          strategy: 'none',
          attempts: 0,
          gated: true,
          bootstrap_queued: false,
          bootstrap: buildBootstrapBlock(session)
        }
      });
    }
    emitBootstrapEvent('bootstrap_queue_failed', sessionId, session, {
      op_id: op.op_id,
      operation: op.type,
      code: 'BOOTSTRAP_READY_TIMEOUT',
      error: `target '${sessionId}' not ready within ${BOOTSTRAP_READY_TIMEOUT_MS}ms`
    });
  }
}

// #29: pure decision for the non-cmux owner-alive optimistic floor — returns true iff the
// armed timer should flip bootstrapReady (not already ready; owner PID valid + alive; owner WS
// open). `deps` injects the liveness predicates for unit-testing (defaults = module globals),
// mirroring submit-gate.js's opts DI seam. No side effects — pure predicate.
function shouldApplyOwnerAliveFloor(session, deps = {}) {
  const _isBootstrapReady = deps.isBootstrapReady || isBootstrapReady;
  const _isProcessRunning = deps.isProcessRunning || isProcessRunning;
  const _isOpenWebSocket = deps.isOpenWebSocket || isOpenWebSocket;
  if (_isBootstrapReady(session)) return false;          // bridge_ready already won
  const ownerPid = Number(session.ownerPid);
  if (!Number.isInteger(ownerPid) || ownerPid <= 0 || !_isProcessRunning(ownerPid)) return false;
  if (!_isOpenWebSocket(session.ownerWs)) return false;
  return true;
}

function scheduleBootstrapPromptPoll(sessionId, session, deps = {}) {
  const _setTimeout = deps.setTimeout || setTimeout;
  if (!session || !isBootstrapGatedSession(session) || isBootstrapReady(session)) return;
  if (!isOpenWebSocket(session.ownerWs)) return;

  // cmux: rendered-screen prompt poll (the cmux-only read-screen primitive). Unchanged,
  // including the #31 actionable bootstrap-timeout on miss/error.
  if (session.backend === 'cmux' && session.cmuxWorkspaceId) {
    if (session.bootstrapPromptPoll) return;
    session.bootstrapPromptPoll = submitGate.awaitPromptSymbol(session, {
      timeoutMs: BOOTSTRAP_READY_TIMEOUT_MS
    }).then((result) => {
      session.bootstrapPromptPoll = null;
      if (result && result.ready && isOpenWebSocket(session.ownerWs)) {
        markBootstrapReady(sessionId, session, 'cmux_prompt_symbol');
      } else if (result && result.reason) {
        failBootstrapQueueOnTimeout(sessionId, session, {
          reason: result.reason,
          waited_ms: result.waited_ms || 0
        });
      }
    }).catch((error) => {
      session.bootstrapPromptPoll = null;
      failBootstrapQueueOnTimeout(sessionId, session, {
        reason: 'prompt_symbol_error',
        error: error.message || String(error)
      });
    });
    return;
  }

  // #29: non-cmux (warp/pty/kitty) has NO rendered-screen read primitive, so the cmux poll
  // would early-return and bootstrapReady could stay false forever (inject queues forever on
  // Warp). The fast path stays the bridge 'ready' frame; this arms an idempotent owner-alive
  // optimistic FLOOR — byte-for-byte the shipped runStartupBootstrapRestore precedent
  // (markBootstrapReady('startup_owner_alive') ~daemon.js:2997) — applied at the LIVE owner
  // WS-connect path. markBootstrapReady is idempotent, so a late timer after bridge_ready is a
  // harmless no-op. submit-gate.js read-screen guard stays cmux-only (untouched).
  if (session.bootstrapOptimisticTimer) return;
  session.bootstrapOptimisticTimer = _setTimeout(() => {
    session.bootstrapOptimisticTimer = null;
    if (!shouldApplyOwnerAliveFloor(session, deps)) return;
    markBootstrapReady(sessionId, session, 'owner_alive');
    console.log(`[BOOTSTRAP] Optimistic ready for ${sessionId} (ownerPid=${Number(session.ownerPid)}, backend=${session.backend || 'unknown'})`);
  }, BOOTSTRAP_READY_TIMEOUT_MS);
}

async function waitForBootstrapSubmit(op, session, timeoutMs) {
  const timeout = sleep(timeoutMs).then(() => {
    op.cancelled = true;
    return {
      status: 504,
      body: {
        error: 'Submit bootstrap-timeout — target CLI did not become ready',
        reason: 'bootstrap_not_ready',
        last_state: sessionStateManager.getState(session.id)?.state || null,
        strategy: 'none',
        attempts: 0,
        gated: true,
        bootstrap_queued: true,
        bootstrap_op_id: op.op_id,
        bootstrap: buildBootstrapBlock(session)
      }
    };
  });
  return Promise.race([op.promise, timeout]);
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
    last_thread_id: session.lastThreadId || null,
    bootstrap: buildBootstrapBlock(session)
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
 * Submit Enter to a session via the PTY/context layer.
 * Used by POST /submit endpoint for explicit terminal-level submit.
 *
 * Submit is a CONTEXT operation (telepty-owned), not a SURFACE operation
 * (cmux/kitty adaptor-owned). Deliver the submit Enter via the PTY only — a bare
 * 0x0D into the CLI's innermost node-pty. The former kitty `send-text` (P1) and
 * `cmux send-key` (P2) branches were SURFACE ops on a flaky side channel (75×
 * "Failed to write to socket" vs 0× for pty_cr in a 222k-line run; live
 * 2026-06-07 confirmed pty-only works 3/3). The `submitViaCmux`/`sendViaKitty`
 * defs were since removed (#544/#546 — submit-all also migrated to PTY, leaving
 * zero cmux send-key in the submit path). See
 * docs/adr/2026-06-07-submit-via-pty-context-layer.md.
 *
 * Returns the strategy name ('pty_cr') or null on failure.
 */
function terminalLevelSubmit(id, session) {
  if (submitViaPty(session)) return 'pty_cr';
  return null;
}

// #544 / #537 / Bug B: with PTY-native submit (terminalLevelSubmit → pty_cr only),
// a successful pty_cr IS real delivery on every backend — the bare 0x0D reaches the
// CLI's innermost node-pty directly (live 2026-06-07: pty-only delivered 3/3 even
// when cmux send-key failed). The honest "was it accepted?" signal is the
// PTY-derived confirm (confirmSubmitAccepted: state∈{working,thinking} since≥
// submittedAt, or body consumed from outputRing) — NOT the strategy name. We no
// longer special-case pty_cr-on-cmux as undelivered; that false-negative was the
// direct cause of the BUG B bogus UNCONFIRMED reports + worker re-send loops.
// Pure + exported so the decision is unit-testable.
// See docs/adr/2026-06-07-submit-via-pty-context-layer.md.
function forceSubmitDeliveredToSurface(session, strategy) {
  return !!strategy;
}

async function deliverInjectionToSession(id, session, prompt, options = {}) {
  const now = Date.now();
  if (!options.bypassBootstrapQueue && shouldQueueBootstrapOperation(session)) {
    const healthStatus = getSessionHealthStatus(session, { nowMs: now });
    if (healthStatus === 'STALE') {
      return { success: false, httpStatus: 410, code: 'STALE', error: 'Session is stale and awaiting cleanup.' };
    }
    const op = enqueueBootstrapOperation(id, session, {
      type: 'inject',
      prompt,
      noEnter: !!options.noEnter,
      options: {
        source: options.source || 'inject',
        from: options.from || 'daemon'
      }
    });
    session.lastActivityAt = new Date(now).toISOString();
    return bootstrapQueuedResponse(op, {
      msg_id: op.op_id,
      pending: session.bootstrapQueue.length,
      submit: options.noEnter ? 'skipped' : 'queued'
    });
  }

  const injectFailure = getInjectFailure(session, { nowMs: now });
  if (injectFailure) {
    return { success: false, ...injectFailure };
  }

  // Mailbox payload is TEXT ONLY — CR is sent separately after a delay.
  // Reason: combining text+CR in one write triggers bracketed paste mode in modern
  // terminals. CLIs ignore \r inside paste brackets, so Enter never fires.
  const from = options.from || 'daemon';
  const msgId = `${from}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;

  // #47 P4 — capability-gated delivery provenance banner (spec §6). Default-OFF: only sessions
  // that registered as provenance-capable (and have a minted nonce) get the nonce-gated banner;
  // legacy/byte-exact-sensitive sessions receive `prompt` byte-for-byte (regression guard). The
  // audit log below still hashes the RAW `prompt`, not the banner — provenance is a delivery
  // wrapper, not a content change. `from`='daemon'/'inject' are routing sentinels, not real
  // claimed senders, so they are not surfaced as a `claimed:` label.
  const claimedSender = (from && from !== 'daemon' && from !== 'inject') ? from : null;
  const deliveredPrompt = applyProvenance(prompt, {
    capable: !!(session && session.provenanceCapable),
    nonce: session && session.provenanceNonce,
    verified: options.verifiedSenderSid || null,
    claimed: claimedSender,
    origin: options.origin
  }).payload;

  try {
    const ack = mailbox.enqueue({
      msg_id: msgId,
      from,
      to: id,
      payload: deliveredPrompt,
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
    const textResult = await writeDataToSession(id, session, deliveredPrompt);
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
  // #52: monotonic byte counter — the inject-time watermark that scopes echo-evidence
  // matching to frames appended AFTER the inject (survives ring trimming below).
  session.outputRingTotalBytes = (session.outputRingTotalBytes || 0) + data.length;
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
    idleTtl: session.idleTtl || null,
    idleTtlMs: session.idleTtlMs == null ? null : session.idleTtlMs,
    effectiveIdleTtlMs: lifecycle.effectiveIdleTtlMs(session, teleptyConfig),
    ownerPid: session.ownerPid || null,
    ptyPid: session.ptyPid || (session.ptyProcess && session.ptyProcess.pid) || null,
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

async function teardownSessionById(id, options = {}) {
  const session = sessions[id];
  if (!session) {
    return { success: false, httpStatus: 404, error: 'Session not found' };
  }

  const timeoutMs = Math.max(0, Number(options.timeoutMs ?? 5000));
  const force = options.force === true;
  const reason = options.reason || (force ? 'manual_force' : 'manual');
  session.isClosing = true;

  const kill = await lifecycle.killSessionProcess(session, { timeoutMs, force });
  emitSessionLifecycleEvent('session_closed', id, session, {
    reason,
    force,
    pid: kill.pid,
    signal: kill.signal || null,
    escalated: kill.escalated === true,
    source: options.source || 'daemon'
  });

  if (session.clients) {
    session.clients.forEach(ws => {
      try { ws.close(1000, 'Session destroyed'); } catch {}
    });
  }
  if (session.ownerWs) {
    try { session.ownerWs.close(1000, 'Session destroyed'); } catch {}
  }

  // Surface close is the orchestrator's job (Workspace Host adapter), per the 2026-05-30
  // verdict — this call is a NO-OP on the managed path. It actuates only for a standalone
  // telepty that opted in via AIGENTRY_TELEPTY_SELF_CLOSE_SURFACE=1 (gate lives in closeSurface).
  try { terminalBackend.closeSurface(session); } catch {}

  delete sessions[id];
  sessionStateManager.unregister(id);
  try { mailbox.purge(id); } catch {}
  lifecycle.cleanupSessionArtifacts(id);
  persistSessions();

  return {
    success: true,
    session_id: id,
    status: 'closed',
    reason,
    force,
    timeout_ms: timeoutMs,
    kill
  };
}

// Detect terminal environment at daemon startup
const DETECTED_TERMINAL = terminalBackend.detectTerminal();
console.log(`[DAEMON] Terminal backend: ${DETECTED_TERMINAL}`);

// Restore persisted session metadata (wrapped sessions await reconnect)
const _persisted = loadPersistedSessions();
for (const [id, meta] of Object.entries(_persisted)) {
  const restored = sessionPersistence.buildRestoredWrappedSession(id, meta, { cwd: process.cwd() });
  if (!restored) continue;
  sessions[id] = restored;
  initializeBootstrapState(sessions[id]);
  console.log(`[PERSIST] Restored session ${id} (awaiting reconnect)`);
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

// #548 (alias-cascade shared-fate): resolveSessionAlias' most-recent-wins fuzzy match is correct for
// READ/inject ("talk to the current `coder`"), but DESTRUCTIVE ops (DELETE / kill) must NEVER cascade
// across distinct sids that merely share an alias. The incident: cleaning an already-gone `coder-532`
// fuzzy-fell-through to its live sibling `coder-533` (same `coder` track) and KILLED it. Distinct sids
// = distinct lifecycles. This resolver enforces "destroy exactly the session you named":
//   - exact sid match → that sid;
//   - a fully-qualified sid (ends in `-<digits>`) with no exact match → null (a stale/duplicate DELETE
//     of a gone sid must NOT fall through to a sibling — this is the exact #548 cascade);
//   - a bare alias → resolve ONLY when a single session carries it (unambiguous); multiple siblings → null
//     (refuse rather than silently pick most-recent and kill the wrong one).
function resolveSessionForDestroy(requestedId) {
  if (sessions[requestedId]) return requestedId;
  if (/-\d+$/.test(requestedId)) return null;
  const baseAlias = requestedId.replace(/-\d+$/, '');
  const candidates = Object.keys(sessions).filter(id => id.replace(/-\d+$/, '') === baseAlias);
  return candidates.length === 1 ? candidates[0] : null;
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
      ptyPid: ptyProcess.pid || null,
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
  const parsedIdleTtl = parseOptionalIdleTtl(req.body);
  if (parsedIdleTtl.error) {
    return res.status(400).json({ error: parsedIdleTtl.error, code: 'INVALID_IDLE_TTL' });
  }
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
    applyProcessMetadata(existing, req.body);
    applyIdleTtlMetadata(existing, parsedIdleTtl);
    applyTimestampMetadata(existing, req.body);
    initializeBootstrapState(existing);
    // #47 P4 — provenance capability is opt-in (default-OFF). Only flip it ON; never silently OFF
    // on a metadata re-register, or a session's delivered bytes would change mid-flight.
    if (req.body.provenance_capable === true) existing.provenanceCapable = true;
    existing.provenanceNonce = ensureSessionNonce(session_id);
    console.log(`[REGISTER] Re-registered session ${session_id} (type: ${existing.type}, updated metadata)`);
    return res.status(200).json({ session_id, type: existing.type, command: existing.command, cwd: existing.cwd, reregistered: true, session_token: mintSessionToken(session_id), session_nonce: existing.provenanceNonce, provenance_capable: !!existing.provenanceCapable });
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
    idleTtl: parsedIdleTtl.present ? parsedIdleTtl.raw : null,
    idleTtlMs: parsedIdleTtl.present ? parsedIdleTtl.ms : null,
    ownerPid: Number.isInteger(Number(req.body.owner_pid)) && Number(req.body.owner_pid) > 0 ? Number(req.body.owner_pid) : null,
    ptyPid: Number.isInteger(Number(req.body.pty_pid)) && Number(req.body.pty_pid) > 0 ? Number(req.body.pty_pid) : null,
    clients: new Set(),
    isClosing: false,
    outputRing: [],
    ready: true,  // unknown commands remain injectable once registered (#150)
    // #47 P4 — provenance banner is opt-in per session (default-OFF, spec §6 rollout). A nonce is
    // always minted (cheap) but the capability-gated banner only wraps deliveries when capable.
    provenanceCapable: req.body.provenance_capable === true,
    provenanceNonce: ensureSessionNonce(session_id),
  };
  initializeBootstrapState(sessionRecord);
  applyTimestampMetadata(sessionRecord, req.body);
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
  res.status(201).json({ session_id, type: 'wrapped', command: sessionRecord.command, cwd, session_token: mintSessionToken(session_id), session_nonce: sessionRecord.provenanceNonce, provenance_capable: sessionRecord.provenanceCapable });
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

// #43 P3 — token-gated historical inject audit query (spec §7). Behind the SAME shared auth
// middleware as every /api/* route (app.use(createAuthMiddleware) above), so it is 401 for an
// unauthorized non-local request and open to localhost/allowlisted peers. Filters: since/until,
// to (alias-resolved), from (claimed OR verified), spoof; pagination via limit/cursor (newest
// first). Reads the live injects.jsonl (one write path, file-backed) — separate lifecycle from
// the ephemeral /api/events live bus, so the two are not conflated.
app.get('/api/injects', (req, res) => {
  const q = req.query || {};
  const to = q.to ? (resolveSessionAlias(q.to) || q.to) : undefined;
  const result = readInjectLog(AUDIT_LOG_PATH, {
    since: q.since,
    until: q.until,
    to,
    from: q.from,
    spoof: q.spoof === '1' || q.spoof === 'true',
    limit: q.limit,
    cursor: q.cursor
  });
  res.json(result);
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
    port: boundPort,
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

// #45 — fan-out (broadcast/multicast) is OPERATOR/ORCHESTRATOR-ONLY. The single-inject
// path hard-blocks off-policy peer→peer traffic via classifyPeerLaneInject; fan-out
// one→many is strictly more dangerous (a worm/fan-out primitive), so the peer lane is
// blocked OUTRIGHT here — even a sanctioned ask-envelope may not fan out. We reuse the
// SAME classifier (DRY, no second policy) and gate on the LANE, not the per-target
// decision: classify by SENDER (`to: null`) so the verdict is the sender's lane,
// independent of any individual target. This is what makes broadcast all-or-nothing on
// the lane — a peer cannot earn fan-out rights by listing the orchestrator as one
// target. Operator lane (no `from`, or `from` ∈ orchestrator sids) and the fail-open
// `disabled` lane proceed to delivery, exactly as single-inject allows them. #533 Phase 2.
function isPeerLaneFanout(from, prompt) {
  return classifyPeerLaneInject({ from, to: null, prompt, orchestratorSids: ORCHESTRATOR_SIDS });
}

// Reject a peer-lane fan-out: emit a per-target peer_inject_blocked bus event for every
// intended target (mirrors the single-inject block event for reporting parity) and return
// the same 403 PEER_INJECT_BLOCKED shape, reaching ZERO sessions. `targetIds` is the full
// intended target set (broadcast = all sessions, multicast = requested session_ids).
function rejectPeerLaneFanout(res, { from, reason, targetIds, source, verifiedSenderSid = null, prompt = '' }) {
  const inject_id = crypto.randomUUID();
  const failed = [];
  for (const id of targetIds) {
    broadcastSessionEvent('peer_inject_blocked', id, sessions[id] || null, {
      extra: {
        target_agent: id,
        from: from || null,
        reason,
        source,
        inject_id
      }
    });
    // #47 P5 — one shared-schema audit line per blocked target (mirrors the success per-target
    // fan-out audit), so a blocked fan-out's blast-radius is queryable just like a delivered one.
    auditAppend({
      ts: new Date().toISOString(), inject_id, kind: source, source,
      claimed_from: from || null, verified_sender_sid: verifiedSenderSid,
      to: id, to_alias: null, origin: 'trusted-local', origin_host: MACHINE_ID,
      payload: prompt, delivery_result: `blocked:${reason}`
    });
    failed.push({ id, code: 'PEER_INJECT_BLOCKED', error: 'Peer-lane fan-out blocked' });
  }
  console.warn(`[PEER-GUARD] blocked peer-lane ${source} from ${from || '(none)'} → ${targetIds.length} target(s) (${reason})`);
  return respondWithError(res, 403, 'PEER_INJECT_BLOCKED',
    'Peer-lane fan-out blocked: broadcast/multicast is operator-only. Use bin/ask.sh for peer→peer.',
    { reason, sanctioned_channel: 'bin/ask.sh', results: { successful: [], failed } });
}

app.post('/api/sessions/multicast/inject', async (req, res) => {
  const { session_ids, prompt, from } = req.body;
  if (typeof prompt !== 'string' || prompt.length === 0) return respondWithError(res, 400, 'INVALID_REQUEST', 'prompt is required');
  if (!Array.isArray(session_ids)) return res.status(400).json({ error: 'session_ids must be an array' });

  // #45 — operator-only fan-out gate (peer lane blocked outright, before any delivery).
  const verdict = isPeerLaneFanout(from, prompt);
  if (verdict.lane === 'peer') {
    return rejectPeerLaneFanout(res, { from, reason: verdict.reason, targetIds: session_ids, source: 'multicast', verifiedSenderSid: verifiedSenderFromReq(req), prompt });
  }
  // #45 — defense-in-depth blast-radius cap (operator lane too).
  if (session_ids.length > FANOUT_MAX_TARGETS) {
    return respondWithError(res, 429, 'FANOUT_TARGET_CAP',
      `multicast target count ${session_ids.length} exceeds cap ${FANOUT_MAX_TARGETS}`,
      { cap: FANOUT_MAX_TARGETS, requested: session_ids.length });
  }

  const results = { successful: [], failed: [] };
  // #43 — one inject_id for the whole fan-out; one audit line per target (group by inject_id).
  const inject_id = crypto.randomUUID();
  const verifiedSenderSid = verifiedSenderFromReq(req);

  for (const id of session_ids) {
    const session = sessions[id];
    if (session) {
      try {
        const delivery = await deliverInjectionToSession(id, session, prompt, {
          source: 'multicast',
          from: from || 'inject',
          verifiedSenderSid // #47 P4 — label the provenance banner with the verified sender
        });
        if (!delivery.success) {
          results.failed.push({ id, code: delivery.code, error: delivery.error });
          auditMulticastTarget(inject_id, 'multicast', from, verifiedSenderSid, id, prompt, `failed:${delivery.code || 'DELIVERY_FAILED'}`);
          continue;
        }

        results.successful.push({ id, strategy: delivery.strategy });
        auditMulticastTarget(inject_id, 'multicast', from, verifiedSenderSid, id, prompt, 'success');

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
        auditMulticastTarget(inject_id, 'multicast', from, verifiedSenderSid, id, prompt, 'failed:DELIVERY_FAILED');
      }
    } else {
      results.failed.push({ id, code: 'SESSION_NOT_FOUND', error: 'Session not found' });
      auditMulticastTarget(inject_id, 'multicast', from, verifiedSenderSid, id, prompt, 'failed:SESSION_NOT_FOUND');
    }
  }

  res.json({ success: true, results });
});

// #43 — shared per-target audit helper for the fan-out handlers (multicast/broadcast). One
// JSONL line per target so blast-radius is queryable per session; all share `inject_id`.
function auditMulticastTarget(inject_id, kind, from, verifiedSenderSid, id, prompt, delivery_result) {
  auditAppend({
    ts: new Date().toISOString(), inject_id, kind, source: kind,
    claimed_from: from || null, verified_sender_sid: verifiedSenderSid,
    to: id, to_alias: null, origin: 'trusted-local', origin_host: MACHINE_ID,
    payload: prompt, delivery_result
  });
}

app.post('/api/sessions/broadcast/inject', async (req, res) => {
  const { prompt, from } = req.body;
  if (typeof prompt !== 'string' || prompt.length === 0) return respondWithError(res, 400, 'INVALID_REQUEST', 'prompt is required');

  // #45 — operator-only fan-out gate (peer lane blocked outright, before any delivery).
  // Broadcast is all-or-nothing on the lane: a peer-lane sender reaches ZERO sessions.
  const targetIds = Object.keys(sessions);
  const verdict = isPeerLaneFanout(from, prompt);
  if (verdict.lane === 'peer') {
    return rejectPeerLaneFanout(res, { from, reason: verdict.reason, targetIds, source: 'broadcast', verifiedSenderSid: verifiedSenderFromReq(req), prompt });
  }
  // #45 — defense-in-depth blast-radius cap (operator lane too).
  if (targetIds.length > FANOUT_MAX_TARGETS) {
    return respondWithError(res, 429, 'FANOUT_TARGET_CAP',
      `broadcast target count ${targetIds.length} exceeds cap ${FANOUT_MAX_TARGETS}`,
      { cap: FANOUT_MAX_TARGETS, requested: targetIds.length });
  }

  const results = { successful: [], failed: [] };
  // #43 — one inject_id for the whole broadcast; one audit line per target.
  const inject_id = crypto.randomUUID();
  const verifiedSenderSid = verifiedSenderFromReq(req);

  for (const id of targetIds) {
    const session = sessions[id];
    try {
      const delivery = await deliverInjectionToSession(id, session, prompt, {
        source: 'broadcast',
        from: from || 'inject',
        verifiedSenderSid // #47 P4 — label the provenance banner with the verified sender
      });
      if (!delivery.success) {
        results.failed.push({ id, code: delivery.code, error: delivery.error });
        auditMulticastTarget(inject_id, 'broadcast', from, verifiedSenderSid, id, prompt, `failed:${delivery.code || 'DELIVERY_FAILED'}`);
        continue;
      }

      results.successful.push({ id, strategy: delivery.strategy });
      auditMulticastTarget(inject_id, 'broadcast', from, verifiedSenderSid, id, prompt, 'success');
    } catch (err) {
      results.failed.push({ id, code: 'DELIVERY_FAILED', error: err.message });
      auditMulticastTarget(inject_id, 'broadcast', from, verifiedSenderSid, id, prompt, 'failed:DELIVERY_FAILED');
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

  const preDelayMs = Math.min(Math.max(Number(req.body?.pre_delay_ms) || 0, 0), 1000);
  // Default raised 5000 → 10000 (0.3.1) to cover empirical claude REPL
  // ready window (3-6s on fresh spawn) with margin. Upper clamp raised
  // 15000 → 30000 for the rare extreme-cold case.
  const gateTimeoutMs = Math.min(Math.max(Number(req.body?.gate_timeout_ms) || 10000, 500), 30000);
  const injectedBody = typeof req.body?.injected_body === 'string' ? req.body.injected_body : null;
  const { retries, retryDelayMs, verifyTimeoutMs } = parseSubmitRetryOptions(req.body || {}, injectedBody);
  const minConfidence = req.body?.min_confidence != null
    ? Math.min(Math.max(Number(req.body.min_confidence), 0), 1)
    : undefined;
  // Per-request bypass for manual overrides (`telepty send-key`). Skips gate +
  // verify and dispatches once via the existing terminal-level chain.
  const force = req.body?.force === true;

  const gateOff = String(process.env.TELEPTY_SUBMIT_GATE || '').toLowerCase() === 'off';

  console.log(`[SUBMIT] Session ${id} (${session.command})${retries > 0 ? `, retries: ${retries}, pre_delay: ${preDelayMs}ms` : ''}${gateOff ? ' [gate=off]' : ''}`);

  if (injectedBody) {
    markPendingReportSubmitStarted(id, injectedBody);
  }

  // #471 (0.4.5): force=true must bypass the bootstrap gate. Without `!force`
  // here the per-request escape hatch (cli.js --submit-force) is enqueued and
  // 504s before the force-bypass block below ever runs.
  if (!force && isBootstrapGatedSession(session) && (!isBootstrapReady(session) || hasBootstrapBacklog(session) || session.bootstrapDraining)) {
    const op = enqueueBootstrapOperation(id, session, {
      type: 'submit',
      body: { ...(req.body || {}) }
    });
    if (isBootstrapReady(session)) {
      drainBootstrapQueue(id, session);
    }
    const queuedSubmit = await waitForBootstrapSubmit(op, session, gateTimeoutMs);
    if (queuedSubmit.status >= 400 && injectedBody) {
      markPendingReportSubmitUnconfirmed(id, {
        reason: queuedSubmit.body && queuedSubmit.body.reason ? queuedSubmit.body.reason : 'bootstrap_submit_failed',
        attempts: queuedSubmit.body && queuedSubmit.body.attempts ? queuedSubmit.body.attempts : 0,
        retryable: false
      });
    }
    return res.status(queuedSubmit.status).json(queuedSubmit.body);
  }

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
    if (injectedBody) {
      markPendingReportSubmitStarted(id, injectedBody);
    }
    const forceRingBytesAtSubmit = session.outputRingTotalBytes || 0;
    const strategy = terminalLevelSubmit(id, session);
    const forceSubmittedAtMs = Date.now();
    if (strategy) {
      // #537 / Bug B: force-confirm must reflect ACTUAL delivery. A pty_cr fallback on a
      // cmux surface means cmux send-key failed and Enter never reached the CLI — record
      // UNCONFIRMED so the ENFORCE-REPORT gate never labels a never-delivered inject DONE.
      const deliveredToSurface = forceSubmitDeliveredToSurface(session, strategy);
      if (injectedBody) {
        if (deliveredToSurface) {
          markPendingReportSubmitConfirmed(id, { reason: 'force', attempts: 1 });
        } else {
          markPendingReportSubmitUnconfirmed(id, { reason: 'cmux_send_failed', attempts: 1, retryable: true });
        }
      }
      // #617: the force path skips the synchronous consumption classify, so a busy-parked
      // body would silently drop (this IS the worker's `--submit-force` REPORT path). Hand it
      // to the detached redeliver — it classifies against the CR watermark and only re-fires
      // if `queued`. No-op when the body was consumed/unknown or absent.
      if (injectedBody && deliveredToSurface) {
        scheduleQueuedRedeliver(id, session, injectedBody, {
          submittedAtMs: forceSubmittedAtMs,
          ringBytesAtSubmit: forceRingBytesAtSubmit,
          emitSubmitBus,
        });
      }
      emitSubmitBus({ strategy, attempts: 1, gated: false, forced: true, submit_confirmed: deliveredToSurface });
      return res.json({ success: true, strategy, attempts: 1, gated: false, forced: true, submit_confirmed: deliveredToSurface });
    }
    if (injectedBody) {
      markPendingReportSubmitUnconfirmed(id, { reason: 'strategy_failed', attempts: 0, retryable: false });
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
    if (injectedBody) {
      markPendingReportSubmitStarted(id, injectedBody);
    }
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
      if (injectedBody) {
        markPendingReportSubmitConfirmed(id, { reason: 'gate_off', attempts: legacyAttempts });
      }
      emitSubmitBus({ strategy: legacyStrategy, attempts: legacyAttempts, gated: false });
      return res.json({ success: true, strategy: legacyStrategy, attempts: legacyAttempts, gated: false });
    }
    if (injectedBody) {
      markPendingReportSubmitUnconfirmed(id, { reason: 'strategy_failed', attempts: legacyAttempts, retryable: false });
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

  // Step 2: dispatch Enter via the PTY/context path, render-gated (#568).
  if (injectedBody) {
    markPendingReportSubmitStarted(id, injectedBody);
  }
  const settleEnabled = req.body?.input_settle_gate !== false;
  let strategy = await gatedTerminalSubmit(id, session, injectedBody, settleEnabled);
  let submittedAtMs = Date.now();
  // #53: outputRing watermark at the CR — scopes consumption-evidence matching to frames
  // appended AFTER this submit (composer redraw / new-turn render), surviving ring trimming.
  let ringBytesAtSubmit = session.outputRingTotalBytes || 0;
  let attempts = strategy ? 1 : 0;
  if (!strategy) {
    if (injectedBody) {
      markPendingReportSubmitUnconfirmed(id, { reason: 'strategy_failed', attempts: 0, retryable: false });
    }
    return res.status(503).json({
      error: 'Submit failed via all strategies (kitty/cmux/pty)',
      strategy: 'none',
      attempts: 0,
      gated: true,
      gate_wait_ms: gateResult.waited_ms,
      ...(promptSymbol ? { prompt_symbol: promptSymbol } : {}),
    });
  }

  // Step 3: confirm the submit was accepted (only when caller provided body).
  // Without `injected_body`, this is a bare Enter press (`telepty enter` or
  // `telepty send-key` without force) — there is nothing to confirm and one
  // shot is enough. A retry is idempotent only when the body is still visible.
  let verify = null;
  let confirm = null;
  let consumption = null;        // #53: 'consumed' | 'queued' | 'unknown'
  let consumptionReason = null;
  if (injectedBody && injectedBody.length > 0) {
    confirm = await confirmSubmitAfterDispatch(id, session, injectedBody, submittedAtMs, verifyTimeoutMs);
    while (confirm && !confirm.accepted && confirm.retryable && attempts <= retries) {
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      const retryStrategy = await gatedTerminalSubmit(id, session, injectedBody, settleEnabled);
      submittedAtMs = Date.now();
      ringBytesAtSubmit = session.outputRingTotalBytes || 0;
      if (!retryStrategy) break;
      strategy = retryStrategy;
      attempts++;
      confirm = await confirmSubmitAfterDispatch(id, session, injectedBody, submittedAtMs, verifyTimeoutMs);
    }
    verify = buildSubmitVerify(confirm);

    // #53: consumption-evidence on the DELIVERY path. `confirm.accepted` can read a BUSY
    // recipient's mid-turn output as success (the isAcceptedSubmitState last_output_at leak),
    // so additionally classify whether the body was CONSUMED as a fresh turn vs QUEUED in a
    // busy composer vs UNKNOWN — and surface it to the caller. Advisory + additive: it does
    // NOT change accepted/retryable (back-compat); it only tells the sender what telepty can
    // actually observe past the PTY layer. Conservative (never-false-consumed).
    const consumptionResult = await submitGate.classifyInjectConsumption(session, injectedBody, {
      submittedAtMs,
      sinceBytes: ringBytesAtSubmit,
      getState: () => sessionStateManager.getState(id),
      stripAnsi: stripAnsiState,
    });
    consumption = consumptionResult.status;
    consumptionReason = consumptionResult.reason;
    if (verify) {
      verify.consumption = consumptionResult.status;
      verify.consumption_reason = consumptionResult.reason;
    }

    // #617: a `queued` body was parked on a busy recipient and will never fire on its own.
    // Hand it to the detached hold-and-redeliver loop (re-fires the CR on busy→idle). This
    // runs independent of whether the handler returns 200 or 504 below — delivery is the
    // daemon's responsibility now that the worker no longer needs to poll the status.
    if (consumption === 'queued') {
      scheduleQueuedRedeliver(id, session, injectedBody, {
        knownConsumption: 'queued',
        submittedAtMs,
        ringBytesAtSubmit,
        emitSubmitBus,
      });
    }

    if (confirm && !confirm.accepted) {
      const reason = gatedDispatchAfterTimeout ? 'gated_dispatch_unconsumed' : 'submit_unconfirmed';
      const failBody = {
        error: gatedDispatchAfterTimeout
          ? 'Submit gated-timeout and body not consumed after best-effort dispatch'
          : 'Submit body still visible after bounded confirmation retry',
        reason,
        last_state: gateResult.last_state,
        strategy,
        attempts,
        gated: true,
        gate_wait_ms: gateResult.waited_ms,
        verify,
        confirm,
        ...(consumption ? { consumption, consumption_reason: consumptionReason } : {}),
        gated_dispatch_after_timeout: true,
        ...(promptSymbol ? { prompt_symbol: promptSymbol } : {}),
      };
      if (!gatedDispatchAfterTimeout) {
        delete failBody.gated_dispatch_after_timeout;
      }
      markPendingReportSubmitUnconfirmed(id, { ...confirm, attempts });
      emitSubmitBus(failBody);
      return res.status(504).json(failBody);
    }

    markPendingReportSubmitConfirmed(id, { ...(confirm || { reason: 'empty_body' }), attempts });
  }

  const responseBody = {
    success: true,
    strategy,
    attempts,
    gated: true,
    gate_wait_ms: gateResult.waited_ms,
    verify,
    confirm,
    ...(consumption ? { consumption, consumption_reason: consumptionReason } : {}),
    ...(gatedDispatchAfterTimeout ? { gated_dispatch_after_timeout: true } : {}),
    ...(promptSymbol ? { prompt_symbol: promptSymbol } : {}),
  };
  emitSubmitBus(responseBody);
  return res.json(responseBody);
});

// Submit Enter to every active session. #546: submit is a PTY/context op (bare 0x0D) for every
// wrapped + spawned backend INCLUDING cmux — the path validated 3/3 live for per-session submit
// (#544). The cmux `send-key --surface return` surface op is removed (ZERO cmux send-key);
// osascript Cmd+Enter remains only for app-window sessions with no PTY bridge. Exported (pure
// over the passed sessions map) so the dispatch is unit-testable without starting the daemon.
function runSubmitAll(sessionsMap) {
  const results = { successful: [], failed: [] };

  for (const [id, session] of Object.entries(sessionsMap)) {
    const strategy = getSubmitStrategy(session.command);
    let success = false;

    if (strategy === 'pty_cr') {
      success = submitViaPty(session);
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

// POST /api/sessions/submit-all — Submit all active sessions
app.post('/api/sessions/submit-all', (req, res) => {
  res.json({ success: true, results: runSubmitAll(sessions) });
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
  // #43 P2 — daemon-verified sender identity (from the presented token, never body.from).
  const verifiedSenderSid = verifiedSenderFromReq(req);

  // #533 Phase 2 — peer-lane inject guardrail (in-band hard block, before delivery).
  // Out-of-policy peer→peer injects (no sanctioned ask-request/ask-reply envelope)
  // are blocked here so raw work-delegation bypass is prevented, not just detected.
  // Orchestrator↔peer, broadcast/multicast (no `from`), and existing kinds are untouched.
  const peerVerdict = classifyPeerLaneInject({ from, to: requestedId, prompt, orchestratorSids: ORCHESTRATOR_SIDS });
  if (peerVerdict.decision === 'block') {
    broadcastSessionEvent('peer_inject_blocked', id, session, {
      extra: {
        target_agent: id,
        from: from || null,
        reason: peerVerdict.reason,
        attempted_kind: peerVerdict.kind,
        envelope_present: peerVerdict.envelopePresent,
        inject_id
      }
    });
    console.warn(`[PEER-GUARD] blocked peer inject ${from} → ${id} (${peerVerdict.reason})`);
    // #47 P5 — a blocked bypass attempt is auditable too, not just successful deliveries (spec
    // §5/§9). One shared-schema line with delivery_result:"blocked:<reason>" — the #45 gate logic
    // itself is unchanged; this only records the attempt.
    auditAppend({
      ts: new Date().toISOString(), inject_id, kind: 'inject', source: 'inject',
      claimed_from: from || null, verified_sender_sid: verifiedSenderSid,
      to: id, to_alias: requestedId !== resolvedId ? requestedId : null,
      origin: 'trusted-local', origin_host: MACHINE_ID, ref_path: req.body.ref_path || null,
      payload: finalPrompt, delivery_result: `blocked:${peerVerdict.reason}`
    });
    return respondWithError(res, 403, 'PEER_INJECT_BLOCKED',
      'Peer-lane inject blocked: not a sanctioned ask-request/ask-reply envelope. Use bin/ask.sh.',
      { reason: peerVerdict.reason, sanctioned_channel: 'bin/ask.sh' });
  }
  if (peerVerdict.lane === 'disabled') {
    console.warn('[PEER-GUARD] orchestrator sid unconfigured (AIGENTRY_ORCHESTRATOR_SIDS empty) — peer guardrail disabled (fail-open)');
  }

  try {
    const delivery = await deliverInjectionToSession(id, session, finalPrompt, {
      noEnter: !!no_enter,
      source: 'inject',
      from: from || 'inject',
      // #47 P4 — the daemon-verified sender (never body.from) labels the provenance banner.
      verifiedSenderSid
    });
    if (!delivery.success) {
      emitInjectFailureEvent(id, delivery.code, delivery.error, {
        inject_id,
        from: from || null,
        reply_to: reply_to || null
      }, session);
      auditAppend({
        ts: new Date().toISOString(), inject_id, kind: 'inject', source: 'inject',
        claimed_from: from || null, verified_sender_sid: verifiedSenderSid,
        to: id, to_alias: requestedId !== resolvedId ? requestedId : null,
        origin: 'trusted-local', origin_host: MACHINE_ID, ref_path: req.body.ref_path || null,
        payload: finalPrompt, delivery_result: `failed:${delivery.code || 'DELIVERY_FAILED'}`
      });
      return respondWithError(res, delivery.httpStatus || 500, delivery.code || 'DELIVERY_FAILED', delivery.error);
    }

    if (from) session.lastInjectFrom = from;
    if (reply_to) session.lastInjectReplyTo = reply_to;
    if (thread_id) session.lastThreadId = thread_id;

    console.log(`[INJECT] Wrote to session ${id} (inject_id: ${inject_id})`);

    const injectTimestamp = new Date().toISOString();
    // #43 P1/P2 — one audit line per delivery (claimed + daemon-verified sender, hash-only).
    auditAppend({
      ts: injectTimestamp, inject_id, kind: 'inject', source: 'inject',
      claimed_from: from || null, verified_sender_sid: verifiedSenderSid,
      to: id, to_alias: requestedId !== resolvedId ? requestedId : null,
      origin: 'trusted-local', origin_host: MACHINE_ID, ref_path: req.body.ref_path || null,
      payload: finalPrompt, delivery_result: 'success'
    });
    broadcastSessionEvent('inject_written', id, session, {
      timestamp: injectTimestamp,
      extra: {
        inject_id,
        target_agent: id,
        content: prompt,
        from: from || null,
        // #43 — live bus event enriched with daemon-verified provenance (spec §7).
        verified_sender_sid: verifiedSenderSid,
        spoof_suspected: !!(from && verifiedSenderSid && from !== verifiedSenderSid),
        origin: 'trusted-local',
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
            sessionStateManager.markIdle(senderAlias, 1.0, {
              trigger: 'report_inject',
              report_inject_id: inject_id,
              report_status: classification,
              source: senderPending.source
            });
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
        submitExpected: !!no_enter,
        noEnter: !!no_enter,
        injectedBodyPreview: prompt.slice(0, 500),
        // #52: echo-evidence watermark — only frames appended after this inject count.
        ringBytesAtInject: session.outputRingTotalBytes || 0,
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

    res.json({
      success: true,
      inject_id,
      strategy: delivery.strategy,
      submit: delivery.submit,
      ...(delivery.bootstrap_queued ? {
        bootstrap_queued: true,
        bootstrap_op_id: delivery.bootstrap_op_id || delivery.msg_id,
        pending: delivery.pending
      } : {})
    });
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
    submit_expected: !!entry.submitExpected,
    submit_in_progress: !!entry.submitInProgress,
    submit_confirmed_at: entry.submitConfirmedAt || null,
    submit_unconfirmed_at: entry.submitUnconfirmedAt || null,
    saw_working_after_inject: !!entry.sawWorkingAfterInject,
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

app.post('/api/sessions/:id/kill', async (req, res) => {
  const requestedId = req.params.id;
  // #548: destructive op — must not cascade across alias-sharing siblings.
  const resolvedId = resolveSessionForDestroy(requestedId);
  if (!resolvedId) return res.status(404).json({ error: 'Session not found', requested: requestedId });

  try {
    const timeoutSeconds = req.body && req.body.timeout != null
      ? Number(req.body.timeout)
      : (req.body && req.body.timeout_sec != null ? Number(req.body.timeout_sec) : 5);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
      return res.status(400).json({ error: 'timeout must be a non-negative number of seconds', code: 'INVALID_TIMEOUT' });
    }

    const result = await teardownSessionById(resolvedId, {
      force: req.body && req.body.force === true,
      timeoutMs: Math.floor(timeoutSeconds * 1000),
      reason: req.body && req.body.reason ? String(req.body.reason) : 'manual',
      source: req.body && req.body.source ? String(req.body.source) : 'api'
    });
    if (!result.success) {
      return res.status(result.httpStatus || 500).json({ error: result.error || 'Failed to kill session' });
    }
    console.log(`[KILL] Session ${resolvedId} closed (reason=${result.reason}, force=${result.force}, pid=${result.kill.pid || 'none'})`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to kill session' });
  }
});

app.delete('/api/sessions/:id', (req, res) => {
  const requestedId = req.params.id;
  // #548: destructive op — must not cascade across alias-sharing siblings.
  const resolvedId = resolveSessionForDestroy(requestedId);
  if (!resolvedId) return res.status(404).json({ error: 'Session not found', requested: requestedId });
  const session = sessions[resolvedId];
  const id = resolvedId;
  if (session.isClosing) return res.json({ success: true, status: 'closing' });
  // BUG-C (shared-fate): a wrapped session can be co-bound by a stale/displaced owner bridge
  // (duplicate --id). A DELETE carrying a token that is NOT the current owner's, while a live
  // owner ws is still open, is that stale bridge exiting — it must NOT tear down the live owner.
  // Detach-only (no-op): leave the record and every client untouched. Tokenless callers
  // (operator `telepty delete`, ghost clean) and matching-token current-owner exits are
  // unaffected. Forceful kills go through POST /:id/kill (teardownSessionById), not here.
  const ownerToken = req.query.owner_token;
  if (session.type === 'wrapped'
      && ownerToken && session.ownerToken && ownerToken !== session.ownerToken
      && isOpenWebSocket(session.ownerWs)) {
    return res.json({ success: true, status: 'stale-detached' });
  }
  try {
    session.isClosing = true;
    if (session.type === 'wrapped') {
      if (session.clients) session.clients.forEach(ws => ws.close(1000, 'Session destroyed'));
    } else if (session.ptyProcess) {
      session.ptyProcess.kill();
    }
    // Surface close is the orchestrator's job (Workspace Host adapter), per the 2026-05-30
    // verdict — NO-OP on the managed path. The orchestrator's session-cleanup.sh closes the
    // surface on this normal CLI-exit (CLEANUP_REQUEST→wh_close). Actuates only for a standalone
    // telepty with AIGENTRY_TELEPTY_SELF_CLOSE_SURFACE=1 (gate lives in closeSurface).
    try { terminalBackend.closeSurface(session); } catch {}
    delete sessions[id];
    sessionStateManager.unregister(id);
    try { mailbox.purge(id); } catch {}
    lifecycle.cleanupSessionArtifacts(id);
    console.log(`[KILL] Session ${id} removed`);
    persistSessions();
    res.json({ success: true, status: 'closing' });
  } catch (err) {
    // Even if kill fails, remove from registry
    delete sessions[id];
    sessionStateManager.unregister(id);
    try { mailbox.purge(id); } catch {}
    lifecycle.cleanupSessionArtifacts(id);
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

// === #42 broker MVP (W3/T5) — broker wiring helpers (spec §2F, §4.3, §5) =========
// Additive + default-OFF. Factored as DI-seamed helpers (deps override factories /
// env / readFile) so the wiring is unit-testable without booting the daemon or
// touching the network. The broker-server / broker-client factories are REUSED
// verbatim — no reimplementation here.

// Resolve broker config from the environment (all knobs default-OFF when absent).
function brokerEnv(env = process.env) {
  const home = os.homedir();
  return {
    mode: env.TELEPTY_BROKER_MODE === '1' || env.TELEPTY_BROKER_MODE === 'true',
    jwtSecret: env.TELEPTY_JWT_SECRET || null,
    enrollSecret: env.TELEPTY_ENROLL_SECRET || null,
    tlsCert: env.TELEPTY_TLS_CERT || null,
    tlsKey: env.TELEPTY_TLS_KEY || null,
    aclPath: env.TELEPTY_BROKER_ACL || path.join(home, '.telepty', 'broker-acl.json'),
    revokedPath: env.TELEPTY_BROKER_REVOKED || path.join(home, '.telepty', 'broker-revoked.json'),
    configPath: env.TELEPTY_BROKER_CONFIG || path.join(home, '.telepty', 'broker.json'),
    maxNodes: Number(env.TELEPTY_ENROLL_MAX_NODES) || 256,
    url: env.TELEPTY_BROKER_URL || null,
    jwt: env.TELEPTY_BROKER_JWT || null,
    node: env.TELEPTY_BROKER_NODE || null,
    pin: env.TELEPTY_BROKER_PIN || null,
  };
}

function readJsonFileSafe(filePath, readFile = fs.readFileSync) {
  try {
    return JSON.parse(readFile(filePath, 'utf8'));
  } catch {
    return null; // missing/invalid file ⇒ default (caller decides)
  }
}

// Broker host: mount createBrokerServer at /broker/* (spec §2F-i). Loads the ACL +
// revocation tables from disk (the broker-server is pure — the daemon owns the file
// I/O and the TLS listener, per the module contract). Fail-fast loud if a required
// broker env is missing (§5). Returns the broker instance (handler/close).
function mountBrokerMode(app, deps = {}) {
  const env = deps.env || brokerEnv();
  const createServer = deps.createBrokerServer
    || require('./src/transport/broker-server').createBrokerServer;
  const readFile = deps.readFile || fs.readFileSync;
  const bus = deps.broadcastBusEvent || broadcastBusEvent;
  const requireTls = deps.requireTls !== undefined ? deps.requireTls : true;

  const missing = [];
  if (!env.jwtSecret) missing.push('TELEPTY_JWT_SECRET');
  if (!env.enrollSecret) missing.push('TELEPTY_ENROLL_SECRET');
  if (!env.tlsCert) missing.push('TELEPTY_TLS_CERT');
  if (!env.tlsKey) missing.push('TELEPTY_TLS_KEY');
  if (missing.length) {
    throw new Error(`[BROKER] broker mode requires env: ${missing.join(', ')}`);
  }

  const aclTable = readJsonFileSafe(env.aclPath, readFile) || {};
  const revokedRaw = readJsonFileSafe(env.revokedPath, readFile);
  const revokedNodes = new Set(
    Array.isArray(revokedRaw) ? revokedRaw : (revokedRaw && revokedRaw.revoked) || []
  );

  const broker = createServer({
    jwtSecret: env.jwtSecret,
    enrollSecret: env.enrollSecret,
    aclTable,
    revokedNodes,
    maxNodes: env.maxNodes,
    requireTls,
    broadcastBusEvent: bus,
    // #47 P5 — funnel cross-machine deliveries through the SAME inject audit writer as local
    // ones (one schema, one file, three producers: local deliver, #45 block, broker). The
    // broker owns no fs (pure); the daemon owns the writer.
    onInjectAudit: deps.auditAppend || auditAppend,
  });

  // Mount the raw handler at /broker/* (full path preserved so the broker router
  // matches, spec §3.0). Placed before express.json/auth by the call site above.
  app.use((req, res, next) => {
    if ((req.url || '').split('?')[0].startsWith('/broker/')) return broker.handler(req, res);
    return next();
  });
  return broker;
}

// Node side: resolve broker connection config. Env (TELEPTY_BROKER_URL +
// TELEPTY_BROKER_JWT) wins; else ~/.telepty/broker.json; else null (default-OFF).
function loadNodeBrokerConfig(deps = {}) {
  const env = deps.env || brokerEnv();
  const readFile = deps.readFile || fs.readFileSync;
  if (env.url && env.jwt) {
    return { url: env.url, jwt: env.jwt, node: env.node || MACHINE_ID, pin: env.pin || null, accept_from: null };
  }
  const cfg = readJsonFileSafe(env.configPath, readFile);
  if (cfg && cfg.url && cfg.jwt) {
    return {
      url: cfg.url,
      jwt: cfg.jwt,
      node: cfg.node || MACHINE_ID,
      pin: cfg.pin || null,
      accept_from: cfg.accept_from === undefined ? null : cfg.accept_from,
    };
  }
  return null;
}

// Node side: start the broker-client when broker config is present (spec §2F-ii).
// No config ⇒ returns null and starts nothing (§5 default-OFF, zero new behavior).
// CREDENTIAL BOUNDARY (§4.3): delivery is in-process via deliverInjectionToSession —
// the local daemon token (EXPECTED_TOKEN) is NEVER passed to the client / on the wire.
function startNodeBrokerClient(deps = {}) {
  const cfg = deps.config || loadNodeBrokerConfig(deps);
  if (!cfg) return null;
  const createClient = deps.createBrokerClient
    || require('./src/transport/broker-client').createBrokerClient;
  const deliver = deps.deliver || deliverInjectionToSession;
  const sessionMap = deps.sessions || sessions;

  const client = createClient({
    url: cfg.url,
    node: cfg.node || MACHINE_ID,
    nodeJwt: cfg.jwt,
    pin: cfg.pin || null,
    acceptFrom: cfg.accept_from,
    deliver, // in-process delivery — §4.3 (no daemon token on the wire)
    getSession: (id) => sessionMap[id] || null,
    getSessions: () => Object.keys(sessionMap).map((id) => ({ id, peerName: MACHINE_ID, host: MACHINE_ID })),
  });

  if (deps.autostart !== false && typeof client.start === 'function') {
    Promise.resolve(client.start()).catch((err) => {
      console.error(`[BROKER] node-mode client start failed: ${err && err.message ? err.message : err}`);
    });
  }
  return client;
}

// Bind the port when launched as the daemon. A test can `require('./daemon.js')` to reach the
// exported decision functions WITHOUT starting the daemon — it just must not set the env below.
// The production CLI reaches daemon.js via require() (cli.js `cmd==='daemon'`), so require.main is
// cli.js, never this module — hence the explicit AIGENTRY_TELEPTY_DAEMON_MAIN signal. Guarding on
// require.main ALONE (0.5.0 regression) meant app.listen never ran in production → daemon exited 0.
let server;
let nodeBrokerClient = null;
if (require.main === module || process.env.AIGENTRY_TELEPTY_DAEMON_MAIN === '1') {
  if (brokerServer) {
    // Broker mode (§4.4): TLS mandatory — serve the express app (with /broker/*
    // mounted) over HTTPS using the configured self-signed cert/key.
    const https = require('https');
    const benv = brokerEnv();
    const tlsOptions = { cert: fs.readFileSync(benv.tlsCert), key: fs.readFileSync(benv.tlsKey) };
    server = https.createServer(tlsOptions, app).listen(PORT, HOST, () => {
      const address = server.address();
      boundPort = (address && address.port) || Number(PORT);
      console.log(`🔐 aigentry-telepty broker listening on https://${HOST}:${boundPort} (/broker/*)`);
      console.log(formatBindHint(HOST)); // telepty#50
      runStartupBootstrapRestore();
    });
  } else if (AUTO_TAILNET) {
    // #672 tailnet auto path: bind loopback as the PRIMARY (drives bootstrap/boundPort
    // and effectively never fails), then add an additive best-effort listener on the
    // live tailnet IP so tailnet peers reach :3848 — LAN/public sockets stay closed. An
    // IP flap between detect and listen degrades to loopback-only (logged), never a
    // crash. ponytail: no auto-rebind on flap — a restart re-detects; add a re-detect
    // loop only if flaps prove real in the field.
    server = app.listen(PORT, '127.0.0.1', () => {
      const address = server.address();
      boundPort = (address && address.port) || Number(PORT);
      console.log(`🚀 aigentry-telepty daemon listening on http://${HOST}:${boundPort}`);
      console.log(formatBindHint(HOST, TAILNET));
      maybeGuideWindowsFirewall(boundPort); // G1: Windows inbound-rule guide/auto-add
      runStartupBootstrapRestore();
      nodeBrokerClient = startNodeBrokerClient();
    });
    // Additive tailnet listener — same HTTP posture as the loopback primary (the daemon
    // is HTTP by design; TLS is broker-mode only, and tailnet transport is already
    // WireGuard-encrypted). app.listen() returns a fresh server, so this is a second
    // socket on the same app. ponytail: fixed-PORT production shares one port on both
    // listeners; a PORT=0 ephemeral run would split ports, but the auto path is never
    // taken under PORT=0 in the suite (TELEPTY_NO_TAILNET_AUTO=1 default in setup-env.js).
    const tailnetServer = app.listen(Number(PORT), TAILNET_IP);
    tailnetServer.on('error', (e) => {
      console.warn(`[BIND] tailnet listener ${TAILNET_IP}:${Number(PORT)} unavailable (staying loopback-only): ${e && e.message}`);
    });
  } else {
    server = app.listen(PORT, HOST, () => {
      const address = server.address();
      boundPort = (address && address.port) || Number(PORT);
      console.log(`🚀 aigentry-telepty daemon listening on http://${HOST}:${boundPort}`);
      console.log(formatBindHint(HOST)); // telepty#50
      runStartupBootstrapRestore();
      // #42 node-mode (§2F-ii): start the broker-client if broker config is present.
      // Absent ⇒ no-op (default-OFF). Started after listen so sessions/delivery are live.
      nodeBrokerClient = startNodeBrokerClient();
    });
  }
}

// #470 (0.4.5): when the daemon restarts under existing telepty allow workers,
// persisted sessions are restored at daemon.js:1244 but bootstrapReady stays
// false until the owner WS reconnects — leaving every survivor session stuck
// at ready:false indefinitely. Re-probe on startup: for cmux sessions whose
// owner PID is still alive, run the WS-independent prompt-symbol probe; for
// non-cmux survivors, optimistically mark ready (the underlying CLI is alive
// and no probe primitive is available).
function runStartupBootstrapRestore() {
  for (const [id, session] of Object.entries(sessions)) {
    if (!isBootstrapGatedSession(session) || isBootstrapReady(session)) continue;
    const ownerPid = Number(session.ownerPid);
    if (!Number.isInteger(ownerPid) || ownerPid <= 0 || !isProcessRunning(ownerPid)) {
      continue;
    }
    if (session.backend === 'cmux' && session.cmuxWorkspaceId) {
      submitGate.awaitPromptSymbol(session, { timeoutMs: 5000 })
        .then((result) => {
          if (result && result.ready) {
            markBootstrapReady(id, session, 'startup_restore');
          } else {
            markBootstrapReady(id, session, 'startup_owner_alive');
            console.log(`[BOOTSTRAP] Optimistic ready for ${id} (ownerPid=${ownerPid}, probe=${result?.reason || 'timeout'})`);
          }
        })
        .catch(() => {
          markBootstrapReady(id, session, 'startup_owner_alive');
          console.log(`[BOOTSTRAP] Optimistic ready for ${id} (ownerPid=${ownerPid}, probe=error)`);
        });
    } else {
      markBootstrapReady(id, session, 'startup_owner_alive');
      console.log(`[BOOTSTRAP] Optimistic ready for ${id} (ownerPid=${ownerPid}, backend=${session.backend || 'unknown'})`);
    }
  }
}

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
// Startup sweep: break stale lock files before starting delivery. Guarded so a test require
// of this module neither breaks on-disk locks nor starts the delivery loop.
if (require.main === module) {
  const staleBroken = mailbox.breakStaleLocks();
  if (staleBroken > 0) {
    console.log(`[MAILBOX] Startup sweep: broke ${staleBroken} stale lock(s)`);
  }
  mailboxDelivery.start();
}

const IDLE_THRESHOLD_SECONDS = 60;
async function runIdleTtlSweep(nowMs = Date.now()) {
  const victims = lifecycle.selectIdleTtlVictims(sessions, teleptyConfig, { nowMs });
  for (const victim of victims) {
    const session = sessions[victim.id];
    if (!session || session._idleTtlKilling) continue;
    session._idleTtlKilling = true;
    broadcastSessionEvent('tracing', victim.id, session, {
      nowMs,
      extra: {
        action: 'idle_ttl_auto_kill',
        reason: 'IDLE_TTL',
        idle_duration: victim.idleSeconds,
        idle_duration_seconds: victim.idleSeconds,
        idle_ttl_ms: victim.ttlMs
      }
    });
    try {
      await teardownSessionById(victim.id, {
        force: false,
        timeoutMs: 5000,
        reason: 'IDLE_TTL',
        source: 'idle_reaper'
      });
      console.log(`[REAPER] Auto-killed ${victim.id} after ${victim.idleSeconds}s idle (ttl=${victim.ttlMs}ms)`);
    } catch (err) {
      session._idleTtlKilling = false;
      console.error(`[REAPER] Failed to auto-kill ${victim.id}: ${err.message}`);
    }
  }
}

// Guarded: timers must not run (and keep the event loop alive) on a test require.
if (require.main === module) setInterval(() => {
  runIdleTtlSweep().catch((err) => {
    console.error(`[REAPER] Idle TTL sweep failed: ${err.message}`);
  });
}, IDLE_REAPER_POLL_MS);

if (require.main === module) setInterval(() => {
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
      // silence-timeout: session has been quiet past the threshold without a REPORT.
      fireAutoReport(id, session, pendingRpt, 'silence-timeout');
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

    // #17: CONNECTED-zombie GC via cmux surface-liveness. Post-08cd796 a wrapped cmux bridge
    // SURVIVES its terminal app's death, so ownerWs stays OPEN and the 300s disconnect-GC
    // (below) never fires. If the workspace was EXPLICITLY closed while cmux itself is alive,
    // the session is a headless zombie → reclaim it after a grace window. INV-17: isSurfaceAlive
    // returns 'unknown' when cmux is unreachable (app-quit/restart vanishes ALL surfaces at
    // once), so this GCs NOTHING in that case — preserving the #486/#488 survival guarantee.
    if (session.type === 'wrapped' && session.backend === 'cmux' && session.cmuxWorkspaceId
        && isOpenWebSocket(session.ownerWs)) {
      const mismatchProbe = terminalBackend.detectSurfaceMismatch(session, { sessionId: id });
      const mismatchAction = applySurfaceMismatchProbe(id, session, mismatchProbe, {
        nowMs: now,
        emit: (extra) => broadcastSessionEvent('surface_mismatched', id, session, { nowMs: now, extra })
      });
      if (mismatchAction.action === 'mark') {
        console.log(`[SURFACE-MISMATCH] mismatch candidate for ${id} (${mismatchProbe.observedSurface}) — ${SURFACE_MISMATCH_SECONDS}s debounce started`);
      } else if (mismatchAction.action === 'emit') {
        console.log(`[SURFACE-MISMATCH] emitted surface_mismatched for ${id}: ${mismatchProbe.observedSurface} (${mismatchAction.mismatchSeconds}s)`);
      } else if (mismatchAction.action === 'recover') {
        console.log(`[SURFACE-MISMATCH] ${id} recovered/indeterminate — clearing mismatch debounce`);
      }

      const liveness = terminalBackend.isSurfaceAlive(session);
      const gcAction = decideSurfaceGc(liveness, session, now);
      if (gcAction === 'mark') {
        session.surfaceGoneAt = new Date().toISOString();
        console.log(`[SURFACE-GC] cmux workspace gone for ${id} (${session.cmuxWorkspaceId}) — ${SURFACE_ORPHAN_SECONDS}s grace started`);
      } else if (gcAction === 'reclaim') {
        const goneSeconds = Math.floor((now - new Date(session.surfaceGoneAt).getTime()) / 1000);
        console.log(`[SURFACE-GC] Reclaiming headless cmux zombie ${id} after ${goneSeconds}s surface-gone`);
        emitSessionLifecycleEvent('session_cleanup', id, session, {
          reason: 'SURFACE_GONE',
          surfaceGoneSeconds: goneSeconds
        });
        // Surface-ownership verdict (2026-05-30): telepty reclaims the zombie SESSION but does
        // NOT close the surface. Emit the orphan SIGNAL so the orchestrator's reconciler closes
        // the surface (wh_close). telepty signals; the orchestrator actuates.
        broadcastSessionEvent('surface_orphaned', id, session, {
          extra: {
            sid: id,
            backend: session.backend || null,
            cmuxWorkspaceId: session.cmuxWorkspaceId || null,
            surfaceGoneSeconds: goneSeconds,
            livenessVerdict: liveness
          }
        });
        teardownSessionById(id, { force: true, timeoutMs: 5000, reason: 'SURFACE_GONE', source: 'surface_gc' })
          .catch(err => console.error(`[SURFACE-GC] teardown failed for ${id}: ${err.message}`));
        continue; // being destroyed — skip remaining checks for this session this tick
      } else if (gcAction === 'recover') {
        // Recovery within the grace window (mirrors the aterm socket-recover above).
        console.log(`[SURFACE-GC] cmux workspace recovered for ${id} — clearing grace window`);
        session.surfaceGoneAt = null;
      }
      // 'skip' (incl. 'unknown' — INV-17 gate) → leave surfaceGoneAt unchanged, GC nothing.
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

if (server) server.on('error', async (error) => {
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

const busClients = new Set();

installWebSocketTransport({
  server,
  sessions,
  busClients,
  expectedToken: EXPECTED_TOKEN,
  verifyJwt,
  isAllowedPeer,
  initializeBootstrapState,
  findKittySocket,
  findKittyWindowId,
  markSessionConnected,
  scheduleBootstrapPromptPoll,
  emitSessionLifecycleEvent,
  persistSessions,
  appendToOutputRing,
  sessionStateManager,
  isBootstrapGatedSession,
  markBootstrapReady,
  pendingReports,
  fireAutoReport,
  markSessionDisconnected,
  resolveSessionAlias,
  applySessionStateReport,
  relayToPeers,
  busAutoRoute
});

function shutdown(code) {
  mailboxDelivery.stop();
  mailboxNotifier.cancelAll();
  // #42: stop the node-mode broker-client (closes the held SSE) + the broker-server.
  if (nodeBrokerClient && typeof nodeBrokerClient.stop === 'function') {
    try { nodeBrokerClient.stop(); } catch { /* best-effort */ }
  }
  if (brokerServer && typeof brokerServer.close === 'function') {
    try { brokerServer.close(); } catch { /* best-effort */ }
  }
  clearDaemonState(process.pid);
  process.exit(code);
}

// Daemon-lifecycle signal/exit handlers — only when run as the daemon, so a test require does
// not register them (and does not clear on-disk daemon-state at the test process's exit).
if (require.main === module) {
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('exit', () => {
    clearDaemonState(process.pid);
  });
}

// Minimal test surface (no logic change): expose the pure lifecycle decisions + DI-seamed
// helpers so the daemon ACs are unit-testable without starting the daemon. Behavior for the
// production call sites is unchanged. NOT a public API — internal/test use only.
module.exports = {
  fireAutoReport,                 // #32: provenance-tagged auto-report (deps DI: now/deliver/...)
  maybeRecordInjectConsumption,   // #619: durable early-consumption fact capture (idle-gate decay-proofing)
  forceSubmitDeliveredToSurface,  // #544/#537/Bug B: PTY-native force-confirm (pty_cr = delivered)
  terminalLevelSubmit,            // #544: PTY-only submit path (pty_cr | null)
  submitViaPty,                   // #544: bare-0x0D submit into the innermost node-pty
  runSubmitAll,                   // #546: submit-all via PTY for every backend (no cmux send-key)
  failBootstrapQueueOnTimeout,    // #31: actionable bootstrap-timeout queue flush
  shouldApplyOwnerAliveFloor,     // #29: owner-alive optimistic-floor decision (deps DI: isProcessRunning/...)
  scheduleBootstrapPromptPoll,    // #29: arms the floor timer (deps DI: setTimeout/...)
  decideSurfaceGc,                // #17: surface-liveness verdict→action (incl. INV-17 unknown→skip)
  applySurfaceMismatchProbe,      // surface_mismatched debounce + payload helper (deps DI: emit/clock)
  classifyPeerLaneInject,         // #533 Phase 2: pure peer-lane inject policy verdict
  // #42 broker MVP (W3/T5): DI-seamed broker wiring (deps override factories/env/readFile).
  brokerEnv,                      // env→broker config resolver (default-OFF when absent)
  mountBrokerMode,                // broker-mode: mount createBrokerServer at /broker/* + fail-fast
  loadNodeBrokerConfig,           // node-mode: resolve broker.json / env config (or null)
  startNodeBrokerClient,          // node-mode: start createBrokerClient (default-OFF; in-process deliver)
  deliverInjectionToSession,      // §4.3: the in-process delivery wired into the broker-client
  resolveBindHost,                // telepty#50 + #672: pure bind-address policy (loopback default, env opt-in, tailnet auto)
  formatBindHint,                 // telepty#50 + #672: startup bind/exposure banner line
  isTailnetAuto,                  // #672: pure predicate — is the zero-config tailnet path active
  resolveEffectivePeerAllowlist,  // #672: pure allowlist policy — auto-trust tailnet without widening a manual set
};
