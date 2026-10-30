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
const { createAuthMiddleware, createIsAllowedPeer, createOriginGuard, createVerifyJwt } = require('./src/protocol/http-auth');
const { detectTailnet, TAILNET_CIDR } = require('./src/net/tailnet');
const { FileMailbox } = require('./src/mailbox/index');
const { DeliveryEngine } = require('./src/mailbox/delivery');
const { UnixSocketNotifier } = require('./src/mailbox/notifier');
const { SessionStateManager, STATE_DISPLAY, OBSERVATION_DISPLAY, mapObservationCause, stripAnsi: stripAnsiState } = require('./session-state');
// #60 Stage A: `classifyReportPrompt` is GONE. 0.8.0 parses no text as a terminal report — the
// only consumer was resolveOutboundReportStatus, which mapped every reverse-routed payload
// (including a clarifying question) to `report_complete`. The validator returns in Stage B, once
// #816 supplies a private report channel and #817 supplies cross-machine sender identity.
const { buildAutoSummary } = require('./src/report-enforcement');
const completionObservation = require('./src/completion-observation');
const { CAPABILITY_STAGE_A, classifyConsumption, buildCompletionUnknown, formatCompletionUnknownText, shouldPushCompletionUnknown } = completionObservation;
const submitGate = require('./src/submit-gate');
const { stripAnsiForScreen } = require('./src/screen-ansi'); // #715: read-screen ANSI/VT stripper
const { sampleChildCpuSeconds } = require('./src/child-cpu'); // #52: quiet-thinking CPU recheck
const readyRegistry = require('./src/prompt-symbol-registry');
const lifecycle = require('./src/lifecycle');
const { SURFACE_ORPHAN_SECONDS, SURFACE_MISMATCH_SECONDS, decideSurfaceGc, decideSurfaceGcAction, applySurfaceMismatchProbe } = lifecycle;
const { loadTeleptyConfig } = require('./src/config-file');
const sessionPersistence = require('./src/session-store/persistence');
const interaction = require('./src/interaction');
const { createCredentialStore } = require('./src/session-store/session-credentials');
const { createAuditWriter } = require('./src/audit/inject-log');
const { createAuditReader, registerAuditQueryRoute } = require('./src/audit/query-reader');
const { applyProvenance } = require('./src/audit/provenance');
const { registerSpawnRoute, buildSessionEnv } = require('./src/routes/spawn');
const { createSessionRecordContext, registerSessionRegisterRoute, registerSessionRenameRoute } = require('./src/routes/session-records');
const { registerHandoffRoutes, registerThreadRoutes } = require('./src/routes/coordination');
const { createHttpApp, registerHealthAndAuth } = require('./src/protocol/http-app');
const { registerMailboxRoutes } = require('./src/routes/mailbox');
const { registerSharedReferenceRoutes } = require('./src/routes/shared-reference');
const { registerFanoutRoutes } = require('./src/routes/fanout');
const { createSessionDeliveryContext } = require('./src/mailbox/session-delivery');
const {
  parseOptionalIdleTtl, applyProcessMetadata, applyIdleTtlMetadata, applyTimestampMetadata,
  isBootstrapGatedSession, initializeBootstrapState, markSessionConnected
} = require('./src/session-store/route-metadata');

const { createSessionActions } = require('./src/routes/session-actions');
const sessionActions = createSessionActions({
  get AUTO_REPORT_MIN_REAL_SECONDS() { return AUTO_REPORT_MIN_REAL_SECONDS; },
  get CAPABILITY_STAGE_A() { return CAPABILITY_STAGE_A; },
  get FORCE_CR_GAP_DEFAULT_MS() { return FORCE_CR_GAP_DEFAULT_MS; },
  get IDLE_UNCONFIRMED_CPU_DELTA_SECONDS() { return IDLE_UNCONFIRMED_CPU_DELTA_SECONDS; },
  get IDLE_UNCONFIRMED_CPU_MAX_REARMS() { return IDLE_UNCONFIRMED_CPU_MAX_REARMS; },
  get IDLE_UNCONFIRMED_SETTLE_MAX_REARMS() { return IDLE_UNCONFIRMED_SETTLE_MAX_REARMS; },
  get IDLE_UNCONFIRMED_SETTLE_SECONDS() { return IDLE_UNCONFIRMED_SETTLE_SECONDS; },
  get LAUNCHER_CONSUMPTION_MIN_SECONDS() { return LAUNCHER_CONSUMPTION_MIN_SECONDS; },
  get MACHINE_ID() { return MACHINE_ID; },
  get NON_TERMINAL_GATE_REASONS() { return NON_TERMINAL_GATE_REASONS; },
  get ORCHESTRATOR_SIDS() { return ORCHESTRATOR_SIDS; },
  get REDELIVER_ENABLED() { return REDELIVER_ENABLED; },
  get REDELIVER_IDLE_WAIT_MS() { return REDELIVER_IDLE_WAIT_MS; },
  get REDELIVER_MAX_ATTEMPTS() { return REDELIVER_MAX_ATTEMPTS; },
  get REDELIVER_TOTAL_TIMEOUT_MS() { return REDELIVER_TOTAL_TIMEOUT_MS; },
  get REPORT_AUTO_SUMMARY_LINES() { return REPORT_AUTO_SUMMARY_LINES; },
  get REPORT_AUTO_SUMMARY_MAX_BYTES() { return REPORT_AUTO_SUMMARY_MAX_BYTES; },
  get SUBMIT_BUSY_DISPATCH_ENABLED() { return SUBMIT_BUSY_DISPATCH_ENABLED; },
  get SUBMIT_BUSY_GRACE_MS() { return SUBMIT_BUSY_GRACE_MS; },
  get abortTrackedInjection() { return abortTrackedInjection; },
  get auditAppend() { return auditAppend; },
  get beginTrackedInjection() { return beginTrackedInjection; },
  get bootstrapQueuedResponse() { return bootstrapQueuedResponse; },
  get broadcastSessionEvent() { return broadcastSessionEvent; },
  get buildAutoSummary() { return buildAutoSummary; },
  get buildCompletionUnknown() { return buildCompletionUnknown; },
  get buildErrorBody() { return buildErrorBody; },
  get buildSessionSemanticBlock() { return buildSessionSemanticBlock; },
  get buildSessionTransportBlock() { return buildSessionTransportBlock; },
  get buildSubmitVerify() { return buildSubmitVerify; },
  get busClients() { return busClients; },
  get cancelModalParkPoll() { return cancelModalParkPoll; },
  get classifyConsumption() { return classifyConsumption; },
  get classifyPeerLaneInject() { return classifyPeerLaneInject; },
  get commitTrackedInjections() { return commitTrackedInjections; },
  get completionObservation() { return completionObservation; },
  get confirmSubmitAfterDispatch() { return confirmSubmitAfterDispatch; },
  get crypto() { return crypto; },
  get deliverInjectionToSession() { return deliverInjectionToSession; },
  get deliveredAbsenceIdentities() { return deliveredAbsenceIdentities; },
  get deliveryAuditResult() { return deliveryAuditResult; },
  get drainBootstrapQueue() { return drainBootstrapQueue; },
  get emitInjectFailureEvent() { return emitInjectFailureEvent; },
  get enqueueBootstrapOperation() { return enqueueBootstrapOperation; },
  get formatCompletionUnknownText() { return formatCompletionUnknownText; },
  get gatedTerminalSubmit() { return gatedTerminalSubmit; },
  get getPendingReport() { return getPendingReport; },
  get getSessionHealthReason() { return getSessionHealthReason; },
  get getSessionHealthStatus() { return getSessionHealthStatus; },
  get getTrackedInjection() { return getTrackedInjection; },
  get hasBootstrapBacklog() { return hasBootstrapBacklog; },
  get isBootstrapGatedSession() { return isBootstrapGatedSession; },
  get isBootstrapReady() { return isBootstrapReady; },
  get isOpenWebSocket() { return isOpenWebSocket; },
  get isSurfaceBlockedByModal() { return isSurfaceBlockedByModal; },
  get lifecycle() { return lifecycle; },
  get mailbox() { return mailbox; },
  get mapObservationCause() { return mapObservationCause; },
  get markPendingReportSubmitConfirmed() { return markPendingReportSubmitConfirmed; },
  get markPendingReportSubmitStarted() { return markPendingReportSubmitStarted; },
  get markPendingReportSubmitUnconfirmed() { return markPendingReportSubmitUnconfirmed; },
  get maybeBracketedPaste() { return maybeBracketedPaste; },
  get modalDeliveryDecision() { return modalDeliveryDecision; },
  get modalRejectionResponse() { return modalRejectionResponse; },
  get parkOperationOnModal() { return parkOperationOnModal; },
  get parseSubmitRetryOptions() { return parseSubmitRetryOptions; },
  get pendingReports() { return pendingReports; },
  get persistSessions() { return persistSessions; },
  get readyRegistry() { return readyRegistry; },
  get resolveModalGate() { return resolveModalGate; },
  get resolveSessionAlias() { return resolveSessionAlias; },
  get resolveSessionForDestroy() { return resolveSessionForDestroy; },
  get respondWithError() { return respondWithError; },
  get revokeSessionCredential() { return revokeSessionCredential; },
  get sampleChildCpuSeconds() { return sampleChildCpuSeconds; },
  get scheduleModalParkDrain() { return scheduleModalParkDrain; },
  get sessionPersistence() { return sessionPersistence; },
  get sessionStateManager() { return sessionStateManager; },
  get sessions() { return sessions; },
  get shouldPushCompletionUnknown() { return shouldPushCompletionUnknown; },
  get stripAnsiState() { return stripAnsiState; },
  get submitGate() { return submitGate; },
  get terminalBackend() { return terminalBackend; },
  get terminalLevelSubmit() { return terminalLevelSubmit; },
  get verifiedPrincipalFromReq() { return verifiedPrincipalFromReq; },
  get verifiedSenderFields() { return verifiedSenderFields; },
  get waitForBootstrapSubmit() { return waitForBootstrapSubmit; },
});
const {
  buildAutoSummaryWithDefaults,
  observationIdentity,
  markAbsenceDeliveredToSource,
  recordObservation,
  pendingReportHasSubmitEvidence,
  maybeRecordInjectConsumption,
  maybeRecordLauncherConsumption,
  observeInjectEchoEvidence,
  detectIdleAfterError,
  fireAutoReport,
  normalizeNullableText,
  scheduleQueuedRedeliver,
  parseSessionStateReport,
  applySessionStateReport,
  emitSessionLifecycleEvent,
  forceSubmitDeliveredToSurface,
  isTerminalGateFailure,
  forceSubmitCrGapMs,
  teardownSessionById,
  describeSessionTeardown,
  busAutoRoute,
} = sessionActions;

const { createDeliveryRuntime } = require('./src/mailbox/delivery-runtime');
const deliveryRuntime = createDeliveryRuntime({
  get auditWriter() { return auditWriter; },
  get sessionCredentials() { return sessionCredentials; },
  get sessionPersistence() { return sessionPersistence; },
  get trackedInjections() { return trackedInjections; },
  get TRACKED_INJECTIONS_PATH() { return TRACKED_INJECTIONS_PATH; },
  get interactionCore() { return interactionCore; },
  get pendingReports() { return pendingReports; },
  get busClients() { return busClients; },
  get PEER_INJECT_KINDS() { return PEER_INJECT_KINDS; },
  get UPSTREAM_STALL_SECONDS() { return UPSTREAM_STALL_SECONDS; },
  get SESSION_STALE_SECONDS() { return SESSION_STALE_SECONDS; },
  get fs() { return fs; },
  get crypto() { return crypto; },
  get isBootstrapGatedSession() { return isBootstrapGatedSession; },
  get initializeBootstrapState() { return initializeBootstrapState; },
  get WRAPPED_SUBMIT_DELAY_MS() { return WRAPPED_SUBMIT_DELAY_MS; },
  get writeDataToSession() { return writeDataToSession; },
  get stripAnsiState() { return stripAnsiState; },
  get sessionStateManager() { return sessionStateManager; },
  get submitGate() { return submitGate; },
  get BOOTSTRAP_READY_TIMEOUT_MS() { return BOOTSTRAP_READY_TIMEOUT_MS; },
  get isProcessRunning() { return isProcessRunning; },
  get isOpenWebSocket() { return isOpenWebSocket; },
  get interaction() { return interaction; },
  get BRACKETED_PASTE_START() { return BRACKETED_PASTE_START; },
  get BRACKETED_PASTE_END() { return BRACKETED_PASTE_END; },
  get MODAL_RING_TAIL_BYTES() { return MODAL_RING_TAIL_BYTES; },
  get readyRegistry() { return readyRegistry; },
  get MODAL_REMEDIES() { return MODAL_REMEDIES; },
  get MODAL_REMEDY_BY_CLI() { return MODAL_REMEDY_BY_CLI; },
  get MODAL_REMEDY_DEFAULT() { return MODAL_REMEDY_DEFAULT; },
  get MODAL_HINT_BY_CLI() { return MODAL_HINT_BY_CLI; },
  get MODAL_HOLD_DEFAULT_MS() { return MODAL_HOLD_DEFAULT_MS; },
  get MODAL_PARK_TTL_DEFAULT_MS() { return MODAL_PARK_TTL_DEFAULT_MS; },
  get MODAL_PARK_POLL_MS() { return MODAL_PARK_POLL_MS; },
  get sessions() { return sessions; },
  get interactionWaiters() { return interactionWaiters; },
  get trackedLedgerHealthy() { return trackedLedgerHealthy; },
  get trackedLedgerUnavailableReason() { return trackedLedgerUnavailableReason; },
  get CAPABILITY_STAGE_A() { return CAPABILITY_STAGE_A; },
  set trackedInjections(value) { trackedInjections = value; },
  set trackedLedgerHealthy(value) { trackedLedgerHealthy = value; },
  set trackedLedgerUnavailableReason(value) { trackedLedgerUnavailableReason = value; },
});
const {
  auditAppend,
  verifiedPrincipalFromReq,
  verifiedSenderFields,
  commitTrackedInjections,
  interactionBinding,
  hasHeldInteraction,
  dispatchInteraction,
  restoreTrackedInjections,
  getTrackedInjection,
  sessionAuthenticationCapability,
  beginTrackedInjection,
  abortTrackedInjection,
  parkTrackedInjection,
  deliveryAuditResult,
  getPendingReport,
  markPendingReportSubmitStarted,
  markPendingReportSubmitConfirmed,
  markPendingReportSubmitUnconfirmed,
  broadcastBusEvent,
  buildErrorBody,
  respondWithError,
  classifyPeerLaneInject,
  getSessionDisconnectedMs,
  armUpstreamProbe,
  isUpstreamStalled,
  getSessionHealthStatus,
  getSessionHealthReason,
  sleep,
  isBootstrapReady,
  buildBootstrapBlock,
  shouldQueueBootstrapOperation,
  hasBootstrapBacklog,
  emitBootstrapEvent,
  enqueueBootstrapOperation,
  resolveBootstrapSubmit,
  bootstrapQueuedResponse,
  executeBootstrapInject,
  parseSubmitRetryOptions,
  buildSubmitVerify,
  buildSubmitConfirmOptions,
  confirmSubmitAfterDispatch,
  gatedTerminalSubmit,
  executeBootstrapSubmit,
  drainBootstrapQueue,
  markBootstrapReady,
  failBootstrapQueueOnTimeout,
  shouldApplyOwnerAliveFloor,
  scheduleBootstrapPromptPoll,
  waitForBootstrapSubmit,
  buildSessionTransportBlock,
  buildSessionSemanticBlock,
  buildSessionEvent,
  broadcastSessionEvent,
  getInjectFailure,
  markSessionDisconnected,
  emitInjectFailureEvent,
  terminalLevelSubmit,
  maybeBracketedPaste,
  readOutputRingTail,
  isSurfaceBlockedByModal,
  modalRemedy,
  modalDeliveryDecision,
  modalHoldMs,
  awaitSurfaceModalClear,
  resolveModalGate,
  modalRejectionResponse,
  modalParkTtlMs,
  flushModalParkQueue,
  awaitModalParkDrain,
  cancelModalParkPoll,
  scheduleModalParkDrain,
  parkOperationOnModal,
  modalParkResponse,
  getSessionTerminalLabel,
  submitViaPty,
} = deliveryRuntime;


// #835: the daemon is the process that must not be fooled. It freezes EXPECTED_TOKEN below and
// never re-reads it, while every CLI process re-reads the file — so a daemon that came up on a
// token nobody else has 401s every call for the rest of its life, and the operator sees a fleet
// of 401s with no cause anywhere. `console.warn` in whichever process read the file does not
// reach that operator; refusing to serve, with the reason on stderr where the service log keeps
// it, does. Same shape as the loadTeleptyConfig() guard further down.
// #823 — env-then-file, and the CLI (`cli.js getAuthToken`) plus the MCP server resolve it in the
// SAME order, so an operator cannot end up with one end reading the env and the other the file.
// Deliberately resolved HERE rather than inside `auth.js getConfig()`: getConfig() is also the
// first-run minting path and has two return points, so folding the override in there silently
// ignores the variable on a fresh machine.
//
// It requires a deliberate act to use: the daemon runs under launchd, whose plist supplies only
// PATH, so an operator who exports this in a shell but not for the daemon gets 401s. That is the
// documented hazard (BOUNDARY.md), not an accident to paper over. The value is still FROZEN at
// module load — see the note above; rotation is an explicit restart, by design.
//
// #843 C — resolved BEFORE `getConfig()`, and short-circuiting it. It used to be read eleven
// lines below a getConfig() whose failure is `process.exit(1)`, so "env then file" was true of
// the CLI and the MCP server and false of the daemon: with a corrupt config and a valid env
// token, the clients worked and the daemon died before reaching the check. That is exactly the
// state an operator is in while recovering from the corruption #835's fail-closed refusal
// reports — the documented escape hatch was unusable at the one end that most needed it. Two
// individually-correct changes (fail closed on an unreadable secret; honour the override)
// composing into a wrong whole.
//
// With the secret supplied out-of-band the token file is not read AT ALL, so it cannot refuse.
// Without it, nothing changes: the refusal below still stands, exactly as #835 wrote it.
const ENV_AUTH_TOKEN = process.env.TELEPTY_AUTH_TOKEN || null;
let config = null;
if (!ENV_AUTH_TOKEN) {
  try {
    config = getConfig();
  } catch (err) {
    console.error(`[AUTH] Failed to load telepty auth config: ${err.message}`);
    process.exit(1);
  }
}
const EXPECTED_TOKEN = ENV_AUTH_TOKEN || config.authToken;
const MACHINE_ID = process.env.TELEPTY_MACHINE_ID || os.hostname();
const principalAuthentication = require('./src/principal/http').createPrincipalAuthenticationFromEnvironment({ machineId: MACHINE_ID, sessions: () => sessions });
const net = require('net');
const fs = require('fs');
const SESSION_PERSIST_PATH = sessionPersistence.defaultSessionPersistPath();
const SESSION_STALE_SECONDS = Math.max(1, Number(process.env.TELEPTY_SESSION_STALE_SECONDS || 60));
const SESSION_CLEANUP_SECONDS = Math.max(SESSION_STALE_SECONDS, Number(process.env.TELEPTY_SESSION_CLEANUP_SECONDS || 300));
const DELIVERY_TIMEOUT_MS = Math.max(100, Number(process.env.TELEPTY_DELIVERY_TIMEOUT_MS || 5000));
const HEALTH_POLL_MS = Math.max(100, Number(process.env.TELEPTY_HEALTH_POLL_MS || 10000));
// #732: how long a wrapped session may return ZERO upstream bytes after the daemon has
// written to it before the output pipe is declared dead. An open owner socket proves the
// SOCKET is alive, not that the PIPE is — the #732 incident had a bridge that answered
// every 30s ping and wrote every inject into its PTY while its PTY→WS leg was silently
// gone for ~9h. A live CLI renders something (composer echo, prompt redraw) within
// seconds of a delivery, so this is ~10x the expected echo latency.
const UPSTREAM_STALL_SECONDS = Math.max(1, Number(process.env.TELEPTY_UPSTREAM_STALL_SECONDS || 30));
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
// #694: busy-dispatch fast-path — on a busy (mid-turn) recipient the render-gate (awaitReplReady)
// can never reach idle/waiting, so it burns the full gate timeout before best-effort dispatch.
// When enabled, a genuine ongoing turn (working/thinking held ≥ grace) dispatches after only the
// echo+micro-quiet settle instead of the full timeout. `off` restores the pure-idle-gate behavior.
const SUBMIT_BUSY_DISPATCH_ENABLED = String(process.env.TELEPTY_SUBMIT_BUSY_DISPATCH || '').toLowerCase() !== 'off';
// Grace floor separating a REAL ongoing turn from the transient `working` a target emits while
// echoing our OWN just-injected text (duration_ms ≈ 0). Default 250ms: above the echo transient,
// below any human-perceptible latency.
const SUBMIT_BUSY_GRACE_MS = Math.max(0, Number(process.env.TELEPTY_SUBMIT_BUSY_GRACE_MS || 250));

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

// #60 Stage A — every state transition is an OBSERVATION, and every eligible transition on a
// tracked inject routes through the total emitter. There is no branch here that can produce a
// terminal task outcome, because there is no terminal producer left in the daemon.
//
// The three things this listener used to do wrong:
//   1. it emitted the internal state name externally (`session_auto_state`/`auto_state:"idle"`),
//      which invited exactly the "the turn is over" reading the states cannot support;
//   2. it returned early on `pendingReport.idleNotified`, a one-way bit that a WRONG-label
//      emission burned and which then dropped the later genuine observation;
//   3. it handled only working/thinking, idle and dead — a waiting-pattern or repeated-error
//      entrance produced NOTHING at all, and both of those states are absorbing, so a dispatch
//      could park in one forever with no statement ever made about it.
sessionActions.registerStateObserver();



function loadPersistedSessions() {
  return sessionPersistence.loadPersistedSessions(SESSION_PERSIST_PATH);
}

const app = createHttpApp({ express, cors });
const { createEventLoopTelemetry, slowRequestObserver } = require('./src/diagnostics/event-loop');
const eventLoopTelemetry = createEventLoopTelemetry();
app.use(slowRequestObserver());
if (require.main === module || process.env.AIGENTRY_TELEPTY_DAEMON_MAIN === '1') eventLoopTelemetry.start();

// Peer allowlist: comma-separated IPs/CIDRs in TELEPTY_PEER_ALLOWLIST env
const PEER_ALLOWLIST = (process.env.TELEPTY_PEER_ALLOWLIST || '').split(',').map(s => s.trim()).filter(Boolean);

// Browser origin allowlist: comma-separated origins in TELEPTY_ALLOWED_ORIGINS. Empty by
// default — no web page may call this API, because loopback trust alone let any site the user
// visited drive their AI CLI sessions. See createOriginGuard in src/protocol/http-auth.js.
const ALLOWED_ORIGINS = (process.env.TELEPTY_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

// #672 tailnet auto (seamless cross-machine): detect the tailnet interface once at boot
// via a PURE live scan of os.networkInterfaces(). D1: the IP is discovered, never
// configured — used only in-memory for this run, never persisted, and re-detected every
// start so a Tailscale-reassigned IP is followed automatically.
const TAILNET = detectTailnet();
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
const auditReader = createAuditReader({ path: AUDIT_LOG_PATH });
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


// #43 P2 / #815 — per-session verified-sender credentials. The principal is
// (sid, epoch, generation), NOT a bare sid: an id is routinely destroyed and recreated here
// (worker cleanup, track reuse), and the successor must not inherit its predecessor's authority.
//
// #815 closed three composing defects. Issuance used to be keyed to a NAME and was idempotent per
// sid, so re-registering an already-registered id handed its live token to whoever asked; loopback
// callers pass the auth middleware before any token check; and tokens were never revoked. Together
// that let any local process obtain any session's token and speak as it — including as the
// orchestrator. Now: issuance happens exactly once, at first registration of an id the daemon does
// not hold; a re-register discloses nothing; and every destroy path revokes.
//
// The daemon keeps only sha256(bearer) and PERSISTS that verifier (never the bearer), so the same
// bearer stays verifiable across a daemon restart with no reissuance — which matters because the
// wrapped child carries it in its spawn-time env and that env cannot be updated from outside.
const sessionCredentials = createCredentialStore();

// #47 P4 — per-session provenance nonce (spec §6, ADR §3 D3). The receiving agent trusts a
// delivery's origin banner ONLY if it carries this nonce, so the nonce is bearer material and had
// the IDENTICAL #815 defect: idempotent per sid, returned on every re-register to any caller, and
// never revoked. It now shares the credential's lifecycle exactly — minted once per instance,
// disclosed only at that first registration, revoked with the epoch.
const sidNonces = new Map(); // sid → nonce



// Resolve the presented bearer to the full principal (header only — never the body, which is
// attacker-controlled). Fail closed: unparseable, unknown, stale or revoked yields null, never a
// fallback to the name the caller claimed.

// Back-compat shorthand for the call sites that only need the sid half of the principal.
function verifiedSenderFromReq(req) {
  const principal = verifiedPrincipalFromReq(req);
  return principal ? principal.sid : null;
}
// The three audit/bus fields for a principal, emitted TOGETHER so a consumer never sees a
// verified sid beside a null epoch — that combination would read as "verified, instance unknown",
// which is not a state this daemon can be in. All three are null, or all three are set.


// JWT auth: set TELEPTY_JWT_SECRET to enable. Tokens in Authorization: Bearer <token>
const JWT_SECRET = process.env.TELEPTY_JWT_SECRET || null;

const verifyJwt = createVerifyJwt(JWT_SECRET);
const isAllowedPeer = createIsAllowedPeer(effectivePeerAllowlist);
// One guard instance shared by the HTTP middleware and the WS upgrade handler — the two
// entrances a browser can reach.
const isForbiddenOrigin = createOriginGuard(ALLOWED_ORIGINS);

registerHealthAndAuth(app, { pkg, createAuthMiddleware, isAllowedPeer, EXPECTED_TOKEN, verifyJwt, isForbiddenOrigin, principalAuthentication,
  authorizeSessionRequest: req => require('./src/mailbox/poll-session').authorizeMailboxRequest(req, sessions, sessionCredentials) });

const { resolveBindPort } = require('./src/bind-port');
const PORT = resolveBindPort(process.env);
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

// #896: the title is an IDENTITY CLAIM, so only the process that is actually the daemon may make
// it. On macOS/Linux `process.title` REPLACES what `ps -axo command=` reports, and that string is
// the primary way the stop path finds a daemon (telepty#44 — isLikelyTeleptyDaemon,
// daemon-control.js:109). Set unconditionally at module load, it was claimed by every process that
// merely `require`d this file for its exported pure seams — 22 test files do exactly that. Those
// processes then read as `telepty-daemon` in the process table, so any concurrent
// cleanupDaemonProcesses() sweep SIGTERMed them mid-run. Measured during #850: one baseline run
// lost two whole test FILES to `signal: 'SIGTERM'` plus two daemons mid-test, and the same sweep
// reaches the OPERATOR'S production daemon, which is why test-support/kickstart-race-738-racer.js
// has to stub the sweep out by hand.
//
// The guard is the one this file already uses for the other real-daemon-only side effect, the
// app.listen block at the bottom — NOT `require.main === module` alone, which is false in
// production (the launchd plist runs `telepty daemon` → cli.js → require('./daemon.js'), so
// require.main is cli.js). cli.js sets AIGENTRY_TELEPTY_DAEMON_MAIN before that require, so a real
// daemon still gets its title and the stop path still finds it: no production behaviour changes.
if (require.main === module || process.env.AIGENTRY_TELEPTY_DAEMON_MAIN === '1') {
  process.title = 'telepty-daemon';
}

// Singleton claim — guarded so a test require neither exits (when a daemon is running) nor
// overwrites a live daemon's on-disk state claim (when one is). Only the real daemon claims.
//
// #910: the guard is the one #896 established three lines above, NOT `require.main === module`
// alone — that is false in production, where the launchd plist runs `telepty daemon` → cli.js →
// `require('./daemon.js')` (cli.js sets AIGENTRY_TELEPTY_DAEMON_MAIN immediately before it). So
// the claim never ran on any real daemon: measured on the operator host as a live daemon with no
// ~/.telepty/daemon-state.json at all. Three things were silently dead as a result — the
// singleton guard, postinstall's daemon upgrade (it gates on the state file), and #902's
// state-file port gate, which had nothing to read.
if (require.main === module || process.env.AIGENTRY_TELEPTY_DAEMON_MAIN === '1') {
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
// #721 FIX 1: elapsed floor (seconds since inject) below which a worker-launcher (wrapped)
// real-idle is NOT credited as a genuine turn completion. Sits an order of magnitude above the
// ~4.5s claude startup-settle (the #537 never-started flip) and well below the real 800-1400s
// misfires — the load-bearing guard that lets ambiguous/force launcher confirms count as
// consumption without re-opening BUG-B. See maybeRecordLauncherConsumption.
const LAUNCHER_CONSUMPTION_MIN_SECONDS = Number(process.env.TELEPTY_LAUNCHER_CONSUMPTION_MIN_SECONDS) || 30;

// ---------------------------------------------------------------------------
// #60 Stage A — the tracked-injection observation ledger + the TOTAL emitter
// ---------------------------------------------------------------------------

const TRACKED_INJECTIONS_PATH = process.env.TELEPTY_TRACKED_INJECTIONS_PATH
  || sessionPersistence.defaultTrackedInjectionsPath();

// In-memory mirror of the durable ledger. `trackedLedgerHealthy` is false when the store could
// not be read: the endpoint then answers `tracking_state:"unavailable"` with a named reason
// instead of pretending nothing was ever tracked.
let trackedInjections = sessionPersistence.emptyTrackedInjections();
let trackedLedgerHealthy = true;
let trackedLedgerUnavailableReason = null;



// Partial interaction core: existing host credential only, no report/worker principal grant.
// Task identity is deliberately unavailable until a trusted controller binding is wired.
const interactionWaiters = new Map();


function acceptInteractionReceipt(sid, session, ws, message) {
  const waiting = interactionWaiters.get(message.action_id);
  if (!waiting || waiting.sid !== sid || waiting.owner !== ws || sessions[sid] !== session
      || session.ownerWs !== ws || message.request_digest !== waiting.digest) return;
  const result = message.receipt;
  if (!result || result.action_id !== message.action_id || result.request_digest !== waiting.digest) return;
  if (result.stage === 'refused' && result.bytes_written !== 0) return;
  if (result.stage === 'written' && (!Number.isSafeInteger(result.bytes_written) || result.bytes_written <= 0)) return;
  waiting.finish(result);
}

const interactionCore = deliveryRuntime.createInteractionRuntime();

function requireInteractionController(req, res, next) {
  // General middleware permits JWTs too; this opt-in path deliberately requires the existing
  // host token header, not a query token, sender bearer, or a claimed authority in JSON.
  const supplied = req.headers['x-telepty-token'];
  if (typeof EXPECTED_TOKEN !== 'string' || !EXPECTED_TOKEN || typeof supplied !== 'string'
      || Buffer.byteLength(supplied) !== Buffer.byteLength(EXPECTED_TOKEN)
      || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(EXPECTED_TOKEN))) {
    return res.status(403).json(interaction.refusal('authority_required'));
  }
  next();
}
app.get('/api/sessions/:id/interaction', requireInteractionController, (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json(interaction.refusal('wrong_owner'));
  res.json({ ...readyRegistry.observeInteraction(s), identity: interactionBinding(req.params.id),
    protocol_version: 1, live_adapter: !!s.interactionProvider, task_binding_available: false,
    retained_pending: Object.values(trackedInjections.interactions?.pending || {})
      .filter(p => p.sid === req.params.id).map(p => ({ inject_id: p.inject_id, payload_digest: p.payload_digest, state: p.state })) });
});
app.get('/api/sessions/:id/interaction/receipts/:action', requireInteractionController, (req, res) => {
  const receipt = interactionCore.lookup(req.params.action);
  if (!receipt || (receipt.sid && receipt.sid !== req.params.id)) return res.status(404).json(interaction.refusal('wrong_owner'));
  res.status(receipt.reason === 'storage_unavailable' ? 503 : 200).json(receipt);
});
app.post('/api/sessions/:id/interaction', requireInteractionController, async (req, res) => {
  if (req.body?.identity?.sid !== req.params.id) return res.status(409).json(interaction.refusal('wrong_owner'));
  try {
    const receipt = await interactionCore.act(req.body, 'authenticated-host-controller');
    res.status(receipt.stage === 'refused' ? 409 : receipt.stage === 'outcome_unknown' ? 202 : 200).json(receipt);
  } catch { res.status(503).json(interaction.refusal('storage_unavailable', { bytes_written: null })); }
});

// Restore BEFORE HTTP/WS readiness. A restored record gets `daemon_restart_observed` appended: a
// dispatch that was in flight across a restart is still explicitly unknown, and a missing record
// can never settle, delete or suspend it.




/**
 * Every tracked inject assigned to a session. #60 Stage A §3 "consumption of #815 owner
 * lifecycle" needs it: an owner-replacement fact must be appended to EVERY inject assigned to the
 * displaced epoch, not just the session's active one — supersession deliberately retains the
 * older records, and an inject nobody can answer for is the silence this release removes.
 *
 * Superseded records are included: they remain queryable by `inject_id` and an owner replacement
 * is exactly the kind of fact their reader still needs. Ordered by creation so the caller emits
 * oldest-first.
 */
function listTrackedInjectionsForSession(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return [];
  return Object.values(trackedInjections.injections)
    .filter((record) => record && record.session_id === sessionId)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

/**
 * #860 F1 — what `capability.session_authentication: "observed"` is allowed to mean.
 *
 * `observed` is the word this release reserves for a MEASUREMENT, and #843 keyed it on
 * `session.sessionEpoch` alone. Three writers set that field and only ONE of them measured
 * anything:
 *
 *   src/transport/websocket.js  — an owner claim whose bearer `credentials.verify()` resolved to
 *                                 THIS sid. A proof was presented and checked.       PROOF
 *   POST /api/sessions/register — issuance. The epoch is minted here, before any caller has
 *                                 presented anything at all.                         no proof
 *   session-store/persistence   — restored off disk on daemon start. This daemon has verified
 *                                 nothing; it read a file.                           no proof
 *
 * So the predicate answered "did this daemon mint or restore an epoch for this id", and the field
 * reported that as an authentication. An orchestrator reading it concluded the target session
 * instance had authenticated itself — for an aterm session, which never opens a WebSocket, nothing
 * ever can. That is the substitution #815 removed, re-committed by the release that removed it.
 *
 * The proof is therefore carried by its own field, `session.sessionEpochProved`, written ONLY at
 * the verified claim. It holds the epoch VALUE rather than a flag: a later writer that moves
 * `sessionEpoch` without proving it (register on a recreated sid, a displaced-owner claim that
 * proved nothing) must not inherit the old proof, and comparing the two is what makes that
 * impossible to get wrong by omission.
 *
 * Three cases, three honest answers:
 *   no epoch at all  → unavailable / no_815_epoch_fact       (the frozen default, unchanged)
 *   epoch, no proof  → unavailable / no_815_bearer_presented (minted or restored — see above)
 *   epoch + proof    → observed / null
 *
 * Returns the OVERLAY onto CAPABILITY_STAGE_A, so the no-epoch case returns {} and leaves the
 * frozen default exactly as it was.
 */


/**
 * Create the durable transport-observation record for a tracked inject. MUST complete before the
 * bytes are handed to the target (§3 Stage A item 1): a delivered task that no record answers for
 * is the silence this release exists to remove.
 *
 * Returns {ok:true, record} or {ok:false, reason} — on failure the caller must NOT deliver.
 */


/**
 * #843 — the write-ahead record's ABORT. The record is opened before the bytes are handed over
 * (§3 item 1) because a delivered task no record answers for is silence. It had no way back: when
 * the delivery was then REFUSED, the ledger kept `tracking_state:"tracked"` with `inject_accepted`
 * forever and an orchestrator polling it saw a dispatch that looks in flight and will never move.
 *
 * The daemon measured that zero bytes were written — it returned that measurement to the HTTP
 * caller as a 503 — and then discarded it everywhere else. Recording it is the same rule the rest
 * of this release follows: state what was measured, including when the measurement is a negative.
 *
 * #860 F2 — it had exactly ONE call site: the synchronous `!delivery.success` arm of the inject
 * route. `deliverInjectionToSession` has a THIRD outcome that is neither success nor refusal — the
 * op is pushed onto the bootstrap / modal-park queue and the route is handed
 * `{success: true, strategy: 'bootstrap_queue', queued: true}` with zero bytes written. Every
 * terminal outcome of that queue (drain failure, bootstrap-ready timeout, modal-park TTL) emitted
 * a bus event and nothing durable, so the ledger kept saying `tracked` / `inject_accepted` forever
 * for a dispatch that delivered nothing — the same push-only gap websocket.js:346-349 argues
 * against in this release. Those three paths now end here.
 *
 * `cause` names WHICH terminal outcome, because they are not the same measurement:
 *   inject_delivery_refused — the write was ATTEMPTED and the transport refused it. `bytes_written`
 *                             is what actually landed first, which is not always zero: the queue
 *                             drain writes the body and the submit CR separately, and a CR that
 *                             fails after the body landed must not be recorded as a delivery of
 *                             nothing.
 *   inject_delivery_dropped — the write was NEVER attempted. The op was accepted, parked, and
 *                             discarded by a queue timeout or TTL. `bytes_written` is 0, measured.
 *
 * Returns a named result, never undefined.
 */


/**
 * #860 F2 — record the PARK itself, at the moment it happens.
 *
 * The abort above closes the queue's terminal outcomes, but the reproduced arrangement has no
 * terminal outcome to close: `scheduleBootstrapPromptPoll` returns early when there is no open
 * owner socket, so no timer is ever armed and the record cannot move at any later time. Left at
 * `tracking_started` / `inject_accepted`, the one thing `bin/dispatch-tracker.sh` polls is
 * indistinguishable from a dispatch whose bytes are on the wire.
 *
 * The record therefore states what was measured when it was measured: accepted, parked, zero bytes
 * written. `tracking_state` stays `tracked` — a park is not terminal, and claiming it were would be
 * the same defect pointed the other way.
 *
 * No-ops for an untracked inject (multicast / broadcast / bus route open no record).
 */


/**
 * #860 F2 — the audit log's `delivery_result` for a delivery that has not been written.
 *
 * `deliverInjectionToSession` returns `success: true` for the queue push as well as for a real
 * write, so all four audited inject doors (HTTP route, multicast, broadcast, bus auto-route) wrote
 * `delivery_result: "success"` for an operation whose measured byte count is zero. BOUNDARY.md
 * enumerates that field as two values with two meanings and says they "deliberately do not share a
 * word"; a third state wearing the strongest of the two is the defect this release exists to
 * remove. `queued` is that third state: accepted and parked, nothing written, terminal outcome in
 * the observation ledger rather than here.
 *
 * Keyed on the STRATEGY as well as the flag, because `queued` alone does not mean what it looks
 * like: the mailbox path returns `{strategy: 'mailbox', queued: ack.queued}` for a delivery it has
 * already written synchronously (`mailboxDelivery.tick()`), and that one is a write.
 */


// Observation identity. Dedup is keyed on WHAT WAS MEASURED, not on a one-way "already notified"
// bit. That distinction is the whole repair: `idleNotified` was burned by a wrong-label emission
// and then dropped the later genuine one, and because it was a single bit it could never
// distinguish "we already said this" from "we are no longer allowed to speak".

// #914: source-delivery dedup — the SET of absence identities this inject has already told its
// source about.
//
// The ledger's rule compares one entry (`record.last_observation`). That is the right rule for
// "did the measurement change?" and the wrong one for "have we already said this?". An idle
// session cycles causes (silence_timeout → prompt_suffix_after_quiet → thinking_timeout → …), so
// no observation ever equals the one immediately before it, the duplicate branch never fires, and
// the source was re-notified every settle tick — measured at ~70 orchestrator turns in one night
// for a single idle worker. The debounce this file claims for follow-up observations was real for
// the ledger and absent on the delivery leg.
//
// Keyed on the record OBJECT, so this costs the ledger nothing: no new persisted field, no shape
// change, no commit, and the set is collected with the record it belongs to. A daemon restart
// rebuilds records and therefore starts a fresh set — deliberate: a new epoch has not told anyone
// anything yet.
const deliveredAbsenceIdentities = new WeakMap();

// Returns true when `identity` has already been delivered to the source for this record; records
// it as delivered otherwise. Deliberately NOT a pure predicate — the claim and the check must be
// one step, or two observations in the same tick both see "not yet delivered".

/**
 * THE TOTAL EMITTER. Every observation entry point routes through here, and every eligible
 * invocation RETURNS a named result — never `undefined`, never a bare `return`.
 *
 * Named results: observation_emitted · observation_duplicate · unmapped_transition_cause ·
 * tracking_superseded · tracking_unavailable · observation_deferred · tracking_persistence_failed
 */


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
// #60 Stage A: this now records a CANDIDATE edge, not a consumption verdict.
//
// §3.10 requires `consumption.status:"observed"` to also carry `submitConfirm.accepted === true`,
// `ambiguous === false` and a screen-derived reason. That predicate CANNOT be evaluated here:
// `submitConfirm` is written when confirmSubmitAccepted resolves, and its strongest accept reason
// — `state_working` — is produced BY this very transition (src/submit-gate.js:218-227 polls the
// state machine). Applying the conjuncts at this call site would make `observed` unreachable in
// production while every test that seeds the field stayed green: an assertion that cannot be
// true, shipping green, which is the exact defect class this release removes.
//
// So the edge gate stays here (it is the only place the edge is visible) and the confirmation
// conjuncts move to classifyConsumption, which runs when the confirmation actually exists. Same
// conjuncts, correct evaluation point. Provenance for both halves is recorded so a reader can see
// why a verdict was reached and where.

// #60 Stage A / §7 item 10: `resolveOutboundReportStatus` is GONE, and with it the entire
// reverse-text report path. It mapped EVERY reverse-routed payload to `report_complete` — a
// clarifying question from a worker was recorded as that worker reporting its task complete, and
// CHANGELOG.md:122-125 recorded the mislabel as accepted behaviour.
//
// In 0.8.0 an ordinary reverse-routed inject is an ordinary message. There is no text a session
// can emit that telepty will treat as a terminal report, because no text can authenticate its
// sender or correlate to a dispatch. That capability is Stage B and is blocked on #816 (a private
// capability/report channel) and #817 (cross-machine sender identity).

// #721 FIX 1 (root cause b): a worker-launcher (wrapped) session never rides a clean idle→working
// edge — its continuously-active child stays `working`, so the inject's CR produces only
// starting→working / working↔thinking mid-turn flips, all excluded by maybeRecordInjectConsumption's
// fromState guard. #619's durable fact is therefore NEVER recorded for launchers (0 `consumed_recorded`
// suppressions in production), so every long launcher completion decays to the weak-idle signal and
// cries wolf. This re-derives the consumption verdict at idle-gate time from DECAY-PROOF signals
// (durable submit flags + the monotonic outputRing byte counter + elapsed — none of which age out like
// echo/OSC133), SCOPED to wrapped sessions so non-wrapped sessions keep strict #619/#545 semantics.
//
// never-false-complete (BUG-B / #537) is held by four conjuncts:
//   (a) submitStartedAt set — at/after the CR (never records before the CR);
//   (b) submitConfirm.accepted === true — the CR was accepted. Excludes the classic #537
//       (accepted:false) AND the undefined-confirm never-started shape (enforce-submit-gate /
//       submit-via-pty). For a launcher this is the ambiguous/force/no_observable accept, which is
//       intentionally allowed HERE (unlike observeConsumptionEvidence) because (c)+(d) below add the
//       real-work + long-elapsed evidence a bare force-confirm lacks;
//   (c) the outputRing advanced past the inject watermark — real post-CR output, not a no-op flip;
//   (d) elapsed ≥ LAUNCHER_CONSUMPTION_MIN_SECONDS — an order of magnitude above the ~4.5s
//       startup-settle, the load-bearing guard vs a #544-era never-started startup flip.
// Recording here (rather than a decay-proof early fact) is required because (d) can only be judged
// at idle-time — a #537 startup flip and a genuine turn are identical at the working transition.
//
// KNOWN BOUNDED RISK (accepted, #721 FIX-phase decision): a never-started wrapped worker whose stale
// pending report RE-FIRES real-idle > floor later (no fresh inject cycle) can satisfy (a–d) and
// false-complete. Rare (requires a spurious late idle with no new task); the elapsed floor makes the
// common ~4.5s settle safe. Documented rather than plumbed away (a submit-baselined watermark was
// weighed and dropped as higher blast-radius for marginal gain).
// #60 Stage A / §3.10: the CALCULATION is preserved verbatim; only its false NAME is removed.
//
// This heuristic never measured consumption. The comment block above says so itself — a
// never-started wrapped worker whose stale pending report re-fires real-idle past the floor
// satisfies (a-d) and would false-complete — and daemon.js's own note at the launcher watermark
// admits a never-started worker can satisfy it. So it no longer writes `injectConsumedAt` and no
// longer flows through `consumed_recorded`. It records `submit_accepted_and_output_advanced`
// telemetry (acceptance basis, ring-byte delta, elapsed) and consumption stays
// `not_established`. Stage D may delete the calculation; Stage A only stops it lying.

// #52: the TASK_IDLE_UNCONFIRMED semantic is "inject may NOT have been processed" — gate it
// on CONSUMPTION evidence the daemon already owns instead of screen idleness. Evidence:
//   - a screen-VERIFIED submit confirmation (body consumed from the composer, or a state
//     transition observed after the CR) — 'force'/ambiguous accepts are NOT verification;
//   - the injected body echoed in PTY frames appended after the inject (composer/transcript
//     redraw), matched conservatively (submit-gate observeInjectEcho).
// A definitively failed submit (accepted:false — body observed stuck in the composer /
// no-land) is positive NON-consumption and can never be overridden by echo, so the
// never-false-complete invariant of #48 holds: a genuinely unconsumed inject still signals.
// #60 Stage A: `observeConsumptionEvidence` is GONE. It was a GATE — its caller used it to decide
// whether to stay silent (daemon.js:803-810, a bare `return` that emitted nothing and set
// nothing). Consumption is now a FIELD on the observation, computed by
// src/completion-observation.js#classifyConsumption, which is total and has rejection precedence.
// This helper only gathers the one piece of evidence that needs the session's output ring.

// #801 — TASK_COMPLETE vs error-death. A wrapped session whose CLI dies on an API/transport
// error goes quiet, so the idle detector fires and the auto-report asserts the worker "is now
// idle after processing inject". It processed nothing: it printed an error banner and returned
// to its prompt. Observed 6× on 2026-07-26 (claude `API Error: 529 Overloaded` ×5 at
// 204-330s; codex `invalid_request_error` ×1 at 10.8s), and indistinguishable from a genuine
// completion without reading the screen — which is the one thing the signal exists to avoid.
//
// Scoped to the TURN, not the session: only ring bytes appended past the inject watermark are
// scanned, using the same split observeInjectEcho does. An error from an earlier turn was
// already reported when it happened and must not poison this turn's verdict.
//
// FAIL-OPEN by construction — no watermark, no ring, no per-CLI rule, or no marker => null =>
// the caller emits exactly what it emits today. Only positive error evidence may relabel, so a
// genuine TASK_COMPLETE can never be suppressed by an unrecognised screen.









// #32 lineage: this was the single provenance-tagged AUTO-REPORT path, and its job was to decide
// TASK_COMPLETE vs TASK_IDLE_UNCONFIRMED from elapsed time, submit flags and a prompt glyph.
//
// #60 Stage A removed that decision entirely. There is no `confirmed` any more, no label, and no
// terminal message: this path now emits ONE `task_completion_unknown` observation through the
// total emitter and delivers the literal absence text to the source. The name is kept because it
// is the seam every caller and the design's §8.1 refer to; it no longer auto-reports anything.
//
// What survives from the compensation stack (#32/#48/#52/#537/#545/#619/#721), deliberately, per
// the Stage-A/Stage-D split:
//   - the ready-signal dwell still waits for submit confirmation before speaking;
//   - the #48 settle window and the #52 CPU re-arm still DEBOUNCE follow-up observations;
//   - #545's idle-evidence reliability and #721's launcher watermark are still computed.
// None of them can gate a completion claim, because there is none. Critically, the debounce is
// not silence: the durable `tracking_started` observation was already committed before the bytes
// were handed over, so the absence exists and is pollable the whole time this function is
// deferring. Debouncing a follow-up is not the same thing as withholding a first statement, and
// getting those two confused is what killed three design rounds.
//
// `deps` remains the DI seam (clock, setTimeout, bus, deliver, live state, CPU sampler).
// Returns a NAMED result on every path — never undefined, never a bare return.

const sessions = {};
const busClients = new Set();
const sessionRecordContext = createSessionRecordContext({
  sessions, sessionCredentials, sidNonces, sessionPersistPath: SESSION_PERSIST_PATH
});
const { persistSessions, issueSessionCredential, revokeSessionCredential,
  resolveSessionAlias, resolveSessionForDestroy } = sessionRecordContext;
const handoffs = {};
const threads = {};
let teleptyConfig;
try {
  teleptyConfig = loadTeleptyConfig();
} catch (err) {
  // #843 C — the SECOND read of `~/.telepty/config.json`. Skipping the token read above without
  // this one is the same defect one layer out: the daemon would clear the auth gate on the env
  // token and then die here, on the same unparseable bytes, having been told the secret already.
  //
  // What this file supplies at this point is optional settings (`idle_ttl_default`) whose absence
  // has a defined default, so with the secret in hand the honest answer is to come up and say what
  // could not be read — §A4, a capability gap reported as a gap — rather than to refuse. The
  // refusal is unchanged when no env token was supplied: there, an unreadable config is still a
  // condition the daemon must not boot through.
  if (!ENV_AUTH_TOKEN) {
    console.error(`[CONFIG] Failed to load telepty config: ${err.message}`);
    process.exit(1);
  }
  console.error(`[CONFIG] ${err.message}`);
  console.error('[CONFIG] TELEPTY_AUTH_TOKEN supplied the secret, so the daemon is starting without '
    + 'this file. Settings in it are UNAVAILABLE, not absent — idle_ttl_default falls back to "off".');
  teleptyConfig = loadTeleptyConfig({ paths: [] });
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






// #732 — upstream-liveness probe. The daemon already keeps a monotonic upstream-only byte
// counter (`outputRingTotalBytes`, stamped in appendToOutputRing and nothing else). Arming a
// probe records "at this instant I wrote downstream, and the counter stood here"; if the
// counter has not moved since, not one byte has come back from the PTY.
//
// The probe is armed only when no UNANSWERED probe is already aging — otherwise a stream of
// injects would keep resetting the clock and a dead pipe would never trip the threshold.
// It self-clears: any upstream byte pushes the counter past the watermark.


// Pure predicate — exported for unit testing. "Socket alive but pipe dead."














































// #568 — render-gate the submit CR. Before writing the bare 0x0D, wait (bounded)
// until the injected body is echoed in the PTY outputRing AND the render has gone
// quiet, so the CR does not land mid-render and get dropped (FM1; same gate before
// each retry CR, FM2). Best-effort + bounded: on timeout / no body / no ring we
// fall through and still write the CR — never worse than the pre-gate behavior.
// pty_cr stays the ONLY write path (terminalLevelSubmit); this only times WHEN.
// Per-request opt-out via `input_settle_gate: false` (rollback/parity escape hatch).


// #617 — detached hold-and-redeliver for a `queued` inject. The /submit response has
// already returned (the worker's `telepty inject` got consumption='queued' / a plain
// force success and EXITS), so the daemon owns delivery from here: it re-classifies
// when the status is unknown (the force path skips the synchronous classify), and if
// `queued`, runs the bounded submitGate.holdAndRedeliver loop — watching the recipient's
// auto-state for busy→idle (awaitReplReady) and re-firing the bare CR (the body is still
// parked in the composer) until it is consumed as a fresh turn. Fire-and-forget: never
// awaited by the handler, so it cannot affect the response or block the caller.







// #31 (AC-31.4): a session stuck past the bootstrap timeout must surface an ACTIONABLE error
// and stop queuing forever. Emit an actionable bootstrap_ready_timeout (hint + dropped count)
// and FLUSH the queue: submit ops resolve 504, inject ops fail — instead of silently
// accumulating until the process is killed. The caller can re-inject if the target recovers.


// #29: pure decision for the non-cmux owner-alive optimistic floor — returns true iff the
// armed timer should flip bootstrapReady (not already ready; owner PID valid + alive; owner WS
// open). `deps` injects the liveness predicates for unit-testing (defaults = module globals),
// mirroring submit-gate.js's opts DI seam. No side effects — pure predicate.

























const sessionDeliveryContext = createSessionDeliveryContext({
  hasHeldInteraction,
  interaction,
  buildErrorBody,
  DELIVERY_TIMEOUT_MS,
  markSessionDisconnected,
  isOpenWebSocket,
  armUpstreamProbe,
  shouldQueueBootstrapOperation,
  getSessionHealthStatus,
  enqueueBootstrapOperation,
  parkTrackedInjection,
  bootstrapQueuedResponse,
  getInjectFailure,
  resolveModalGate,
  modalRemedy,
  hasBootstrapBacklog,
  parkOperationOnModal,
  modalParkResponse,
  modalRejectionResponse,
  crypto,
  applyProvenance,
  maybeBracketedPaste,
  emitInjectFailureEvent,
  sessions,
  broadcastSessionEvent,
  persistSessions,
  getMailbox: () => mailbox,
  getMailboxNotifier: () => mailboxNotifier,
  getMailboxDelivery: () => mailboxDelivery,
  net
});
const { writeDataToSession, deliverInjectionToSession } = sessionDeliveryContext;

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

// #678: which submit render-gate outcomes are TERMINAL (hard-fail 504, never dispatch the CR)
// vs best-effort DISPATCH (fire the CR anyway). A missing render-state — `no_state` (no state
// machine registered for the session) or `no_state_manager` — is NOT terminal: it says nothing
// about PTY/ownerWs liveness. A wrapped session restored across a daemon restart has no machine
// yet a perfectly live bridge/PTY, so we dispatch best-effort exactly like `timeout` (and if the
// PTY/ownerWs really is gone, submitViaPty returns false → a clean 503, not a false success).
// Only genuinely-terminal PTY states — session_dead / session_error / session_restarting — still
// short-circuit, because writing a CR to a dead/errored/restarting PTY is pointless.
// #694: `busy_settled` (busy-dispatch fast-path) joins the best-effort DISPATCH set — the target is
// alive and mid-turn, so firing the CR is correct (it queues + #617 redelivers), never a hard-fail.
const NON_TERMINAL_GATE_REASONS = new Set(['timeout', 'no_state', 'no_state_manager', 'busy_settled']);

// #716: bracketed-paste submit envelope. codex/claude composers swallow a submit CR
// that arrives coalesced with the injected text burst (paste-burst / coalesced read).
// For a session the CLI marked paste-capable (it emitted ESC[?2004h — tracked in
// appendToOutputRing), wrap the injected TEXT in bracketed-paste markers so the burst
// is an explicit, delimited paste; the submit CR is written SEPARATELY and OUTSIDE
// this envelope, so it is an unambiguous keystroke regardless of inter-write timing.
// Non-paste-capable sessions (legacy claude/gemini/agy that never advertised ?2004h)
// are byte-identical. An empty body is never wrapped.
//
// #730: capability is now decided by CLI IDENTITY first, with the observed mode-set as
// an override in BOTH directions. Observation alone was not enough: codex 0.144.1 emits
// ESC[?2004h exactly once in its first ~1.4KB, so a wrapped session whose owner bridge
// attached after that chunk — or any session restored across a daemon restart — never
// learned it and silently fell back to a raw body, which real codex swallows the CR of.
//   true      → observed ?2004h  → wrap (unchanged)
//   false     → observed ?2004l  → do NOT wrap, even for a known CLI (disable override)
//   undefined → not observed     → wrap iff the CLI is known paste-capable (codex/claude)
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';


// #730 — defense-in-depth floor on the FORCE submit path only. `force` skips the render
// gate and fires the CR immediately (measured ~3ms text→CR end-to-end), which lands inside
// codex 0.144.1's paste-burst window: an un-enveloped MULTI-LINE body swallows the CR
// (10/11 runs at a 16ms gap; still 1/7 at 127ms — it is a probability, not a threshold).
//
// Deliberately SCOPED, not global: an enveloped body is already immune (0/9 swallowed), and
// a single-line body is immune too (0/5), so the common path pays no latency tax. Only the
// exact failing shape — no envelope AND embedded newlines — waits.
// Pure + exported so the policy is unit-testable without booting the daemon.
const FORCE_CR_GAP_DEFAULT_MS = 250;

// #737 — a codex booted with `dismissed_version` < `latest_version` opens a BLOCKING
// "Update available … Press enter to continue" modal whose PRE-SELECTED item is
// "1. Update now (runs `brew upgrade --cask codex`)". Our inject shape — bracketed-paste
// body (#716/#730) + a separately-written CR — moves no selection, so the CR ACTIVATES that
// default: codex shell-execs brew and exits. The message is lost AND the session dies.
// Measured deterministic on real codex 0.144.1 at 19/515/1523ms text->CR (a STATE, not
// #730's paste-burst race). See scratchpad/EVIDENCE-737.md.
//
// The registry already classified that screen as `codex_modal_ui`, but nothing on the
// delivery path consulted it: its only consumer (submit-gate.awaitPromptSymbol) is cmux-only
// AND advisory, force returns before Layer 3 runs, and this function never asked at all.
// These two seams are what every write path now asks first.
const MODAL_RING_TAIL_BYTES = 65536;

// Bounded, newest-first read of the PTY ring — same shape as submit-gate's readTail. The
// positional rule in detectSurfaceModal is window-insensitive, so this budget is about cost,
// not correctness.


// FAIL-OPEN by construction: no ring, no codex, or no modal evidence => false => deliver,
// byte-identical to pre-#737. The force path is production orchestrator dispatch, so a false
// positive here would stall every dispatch; only positive modal evidence may block.


// Remedy selector. `hold` (A) is the default: park the body until the surface leaves the
// modal, then deliver — and fall back to `reject` if it never does (C is A's timeout
// branch, resolveModalGate below). `reject` alone refuses immediately, which is the
// smaller, C-only behavior. `off` is the rollback lever — same shape as
// TELEPTY_SUBMIT_BUSY_DISPATCH=off. Nothing is ever written into a modal in any mode but
// `off`.
//
// #760 adds `park` and makes the DEFAULT per-CLI, because the two CLIs' modals have
// different lifetimes and only the lifetime matters here:
//   codex  — the update/resume modal is transient and machine-owned. 30s of hold clears it
//            or nothing will. Unchanged.
//   claude — an AskUserQuestion list or an ExitPlanMode approval waits on a HUMAN and
//            routinely stays up for minutes (#743: 3 REPORTs lost across one plan window).
//            `hold` cannot work there: `telepty inject` is a plain undici fetch (cli.js
//            fetchWithAuth) with a 300s headers timeout, so a long hold hands the caller a
//            network error while the daemon delivers anyway — a lost ack AND a duplicate.
//            `park` acks immediately and lets the queue do the waiting.
// The env var still overrides both, in either direction.
const MODAL_REMEDY_DEFAULT = 'hold';
const MODAL_REMEDIES = new Set(['hold', 'park', 'reject', 'off']);
const MODAL_REMEDY_BY_CLI = { claude: 'park' };


// Per-CLI remediation copy. The gate is generic; what the operator has to DO to clear the
// surface is not, so the hint names the actual modal and the actual key.
const MODAL_HINT_BY_CLI = {
  codex: 'Target codex is showing a blocking modal (e.g. "Update available … Press enter to '
    + 'continue"); an Enter there would activate its default item, not submit your message. '
    + 'Dismiss it on the surface, or clear it by setting dismissed_version to latest_version '
    + 'in $CODEX_HOME/version.json and respawning.',
  claude: 'Target claude is showing a blocking modal (AskUserQuestion option list, '
    + 'ExitPlanMode plan approval, tool-permission or trust dialog); an Enter there would '
    + 'select the highlighted option — on a plan approval that is "Yes, auto-accept edits" — '
    + 'not submit your message. Answer or Esc the prompt on the surface; parked injects are '
    + 'delivered in order as soon as it clears.',
};

// The single decision every write path consults. `options` is accepted and deliberately NOT
// branched on: force, gated and plain all lose the message identically (measured — all three
// wrote body+CR into the modal), so they must all get the same answer. It stays in the
// signature as the attribution seam for logging and for any future per-path divergence.


// A's bound. The modal does NOT clear by itself — it needs a keystroke from whoever owns
// the surface — so the hold must expire into C rather than wait forever. 30s mirrors
// BOOTSTRAP_READY_TIMEOUT_MS, the existing "how long we wait for a surface to become
// injectable" budget. Only ever paid when a modal is genuinely up.
const MODAL_HOLD_DEFAULT_MS = 30000;


// Park until the surface leaves the modal. Polls the same fail-open predicate, so a
// surface that was never modal returns immediately with waited_ms 0.


// The single gate every write path awaits. Resolves to null when the write may proceed, or
// to a rejection decision when it must not. `hold` degrades to `reject` on timeout — that
// is the approved A-with-C-as-its-timeout-branch shape, in one place so force, gated and
// plain cannot drift apart.




// ── #760: the `park` remedy ────────────────────────────────────────────────────────────
//
// Contract: not lost, delivered after the modal clears, order preserved. `hold` gives the
// first two only for a modal short enough to fit inside one HTTP request, and gives the
// third to nobody — two concurrent holds poll independently and race. A queue gives all
// three, and this daemon already has exactly the right one: session.bootstrapQueue is a
// per-session FIFO of "ops that may not touch the surface yet", with a drain that replays
// them in order (drainBootstrapQueue) and bus events for depth/failure. Boot uses it while
// the CLI is still starting; a modal is the same predicate with a different cause, so the
// park reuses the queue outright rather than growing a second one beside it.
//
// The re-entry point differs: a parked op is drained by executeBootstrapInject /
// executeBootstrapSubmit, exactly as a boot-parked op is — so it does NOT re-enter the
// mailbox path, and does not carry the #47 provenance banner a non-parked inject gets.
// (Pre-existing property of this queue, called out rather than widened here.) It DOES now
// carry the #716/#730 bracketed-paste envelope: that one was not cosmetic, and the fix went
// into executeBootstrapInject so the boot caller stops rolling the same dice.
//
// TTL rather than "forever": a modal nobody ever answers must not accumulate injects for the
// life of the session. 600s matches the bridge mailbox's park budget
// (TELEPTY_BRIDGE_INJECT_TTL_SECS, #720) so the two places that hold a message have one
// number. Only ever paid when a modal is genuinely up.
const MODAL_PARK_TTL_DEFAULT_MS = 600000;
const MODAL_PARK_POLL_MS = 500;


// Mirrors failBootstrapQueueOnTimeout: a park that outlives its TTL must surface an
// ACTIONABLE event and flush, never accumulate silently. Silence is the #760 bug itself.


// Awaitable form: poll until the surface clears (then drain in order) or the TTL expires
// (then flush). Same fail-open predicate as the hold, so a surface that was never modal
// returns immediately having paid nothing.




// Fire-and-forget form, used by the request paths: single-flight per session, and unref'd so
// a parked session can never hold the process open. Measured on real claude 2.1.220: a
// surface sitting on a modal emits ZERO bytes for as long as it is up (+0B over 45s on both
// the AskUserQuestion and ExitPlanMode captures), so there is no output event to re-arm on —
// polling is the only way to notice the clear.


// Push one op onto the park and start (or keep) the poll. Returns the queued op so each
// caller can shape its own ack — inject and submit answer on different response schemas.






function appendToOutputRing(session, data) {
  require('./src/transport/observer').publishSessionOutput(session, data);
  if (!session.outputRing) session.outputRing = [];
  // #716: track bracketed-paste capability from the CLI's own mode-set output so
  // injects are wrapped (maybeBracketedPaste) only for paste-capable composers —
  // codex/claude emit ESC[?2004h. Last h/l in the chunk wins.
  const bpOn = data.lastIndexOf('\x1b[?2004h');
  const bpOff = data.lastIndexOf('\x1b[?2004l');
  if (bpOn !== -1 || bpOff !== -1) session.bracketedPasteCapable = bpOn > bpOff;
  // #52: monotonic byte counter — the inject-time watermark that scopes echo-evidence
  // matching to frames appended AFTER the inject (survives ring trimming below).
  session.outputRingTotalBytes = (session.outputRingTotalBytes || 0) + data.length;
  if (data.length > 0) session.lastActualOutputAt = new Date().toISOString();
  session.outputRing.push(data);
  // Keep total data under ~200KB limit by trimming old entries
  let totalLen = session.outputRing.reduce((sum, d) => sum + d.length, 0);
  while (totalLen > 200000 && session.outputRing.length > 1) {
    totalLen -= session.outputRing[0].length;
    session.outputRing.shift();
    session.outputRingRollover = (session.outputRingRollover || 0) + 1;
  }
}



const { createSessionInspectionContext } = require('./src/routes/session-inspection');
const sessionInspection = createSessionInspectionContext({
  get getSessionHealthStatus() { return getSessionHealthStatus; },
  get getSessionHealthReason() { return getSessionHealthReason; },
  get getSessionDisconnectedMs() { return getSessionDisconnectedMs; },
  get buildSessionTransportBlock() { return buildSessionTransportBlock; },
  get buildSessionSemanticBlock() { return buildSessionSemanticBlock; },
  get sessionStateManager() { return sessionStateManager; },
  get MACHINE_ID() { return MACHINE_ID; },
  get getSessionTerminalLabel() { return getSessionTerminalLabel; },
  get lifecycle() { return lifecycle; },
  get teleptyConfig() { return teleptyConfig; },
  get mapObservationCause() { return mapObservationCause; },
  get OBSERVATION_DISPLAY() { return OBSERVATION_DISPLAY; },
  get CAPABILITY_STAGE_A() { return CAPABILITY_STAGE_A; },
  get mailbox() { return mailbox; },
  get sessions() { return sessions; },
  get resolveSessionAlias() { return resolveSessionAlias; },
  get submitViaPty() { return submitViaPty; },
  get SUBMIT_STRATEGIES() { return SUBMIT_STRATEGIES; },
});
const { serializeSession, getSubmitStrategy, submitViaOsascript, runSubmitAll } = sessionInspection;


// Detect terminal environment at daemon startup
const DETECTED_TERMINAL = terminalBackend.detectTerminal();
console.log(`[DAEMON] Terminal backend: ${DETECTED_TERMINAL}`);

// #60 Stage A: restore the observation ledger BEFORE HTTP/WS readiness, so the first poll after
// a restart is answered from durable state rather than from an empty map. A restored record
// gains `daemon_restart_observed` and stays completion-unknown; it can never settle a dispatch.
restoreTrackedInjections();

// Restore persisted session metadata (wrapped sessions await reconnect)
const _persisted = loadPersistedSessions();
for (const [id, meta] of Object.entries(_persisted)) {
  const restored = sessionPersistence.buildRestoredWrappedSession(id, meta, { cwd: process.cwd() });
  if (!restored) continue;
  sessions[id] = restored;
  // #815: re-index the persisted VERIFIER so the bearer the wrapped child already carries in its
  // spawn-time environment keeps verifying across this restart, with nothing reissued. Without
  // this, every restored session silently becomes an unauthenticated sender — the child's env
  // cannot be updated from outside, so a fresh credential would never reach it.
  sessionCredentials.adopt(id, meta);
  initializeBootstrapState(sessions[id]);
  // #678: a session restored across a daemon restart must get a render-state machine,
  // else the submit gate reads getState()=null → no_state and never fires the CR. The
  // machine is otherwise created only at first register(), which the reconnecting bridge's
  // idempotent re-register skips (see the /api/sessions/register early-return below).
  sessionStateManager.register(id);
  console.log(`[PERSIST] Restored session ${id} (awaiting reconnect)`);
}




registerSpawnRoute(app, {
  sessions, sessionStateManager, pty, persistSessions, appendToOutputRing,
  revokeSessionCredential, busClients, os, buildSessionEnv
});

registerSessionRegisterRoute(app, { context: sessionRecordContext, sessionStateManager, busClients, getMailbox: () => mailbox });
require('./src/routes/external-approval').registerExternalApprovalRoutes(app, { sessions });

sessionInspection.registerListRoute(app);

// #43 P3 — token-gated historical inject audit query (spec §7). Behind the SAME shared auth
// middleware as every /api/* route (app.use(createAuthMiddleware) above), so it is 401 for ANY
// caller without the token — #820: loopback and an allowlist match are no longer credentials, so
// "open to localhost/allowlisted peers" is no longer true of this or any other route. Filters:
// since/until,
// to (alias-resolved), from (claimed OR verified), spoof; pagination via limit/cursor (newest
// first). Reads the live injects.jsonl (one write path, file-backed) — separate lifecycle from
// the ephemeral /api/events live bus, so the two are not conflated.
registerAuditQueryRoute(app, { reader: auditReader, resolveSessionAlias });

sessionInspection.registerGetRoute(app);
require('./src/readiness').registerReadinessRoute(app, { sessions, machineId: MACHINE_ID });

// Auto-detected session state (from PTY output pattern analysis)
app.get('/api/sessions/:id/state', (req, res) => {
  const requestedId = req.params.id;
  const resolvedId = resolveSessionAlias(requestedId);
  if (!resolvedId) return respondWithError(res, 404, 'SESSION_NOT_FOUND', 'Session not found', { requested: requestedId });
  if (!sessions[resolvedId]) return respondWithError(res, 404, 'SESSION_NOT_FOUND', 'Session not found', { requested: requestedId });

  const autoState = sessionStateManager.getState(resolvedId);
  const session = sessions[resolvedId];
  const semantic = buildSessionSemanticBlock(session);

  // #60 §3.8: `auto` is renamed to `activity_observation` and names the measured cause, not the
  // internal state. The completion block is separate and permanently unknown in 0.8.0.
  const mapped = autoState
    ? mapObservationCause({
      destination: autoState.state,
      cause: autoState.detail ? autoState.detail.trigger : null,
      evidence: { ...(autoState.detail || {}), confidence: autoState.confidence },
    })
    : null;
  res.json({
    session_id: resolvedId,
    activity_observation: mapped
      ? {
        kind: mapped.kind,
        cause: mapped.cause,
        emoji: (OBSERVATION_DISPLAY[mapped.kind] || OBSERVATION_DISPLAY.unmapped_transition_cause).emoji,
        tone: (OBSERVATION_DISPLAY[mapped.kind] || OBSERVATION_DISPLAY.unmapped_transition_cause).tone,
        since: autoState.since,
        since_ms: autoState.since_ms,
        duration_ms: autoState.duration_ms,
        confidence: autoState.confidence,
        last_output_at: autoState.last_output_at,
        last_output_preview: autoState.last_output_preview,
        fields: mapped.fields,
      }
      : { kind: 'tracking_unavailable', cause: null, emoji: '?', tone: 'neutral', fields: { reason: 'no_state_machine_registered' } },
    completion: { completion_fact: null, terminal: false, capability: { ...CAPABILITY_STAGE_A } },
    self_report: semantic,
    last_state_report_at: session.lastStateReportAt || null,
  });
});

// Self-reported session state (explicit POST from session)
sessionActions.registerStateRoute(app);

const { createSessionDiagnostics, createDiagnosticsHandler } = require('./src/diagnostics/session');
app.get('/api/sessions/:id/diagnostics', createDiagnosticsHandler({
  sessions, machineId: MACHINE_ID, inspect: createSessionDiagnostics(), eventLoop: () => eventLoopTelemetry.snapshot(),
  readTracked: getTrackedInjection, ledgerAvailable: () => trackedLedgerHealthy
}));

app.get('/api/meta', (req, res) => {
  res.json({
    name: pkg.name,
    version: pkg.version,
    pid: process.pid,
    host: HOST,
    port: boundPort,
    machine_id: MACHINE_ID,
    event_loop: eventLoopTelemetry.snapshot(),
    terminal: DETECTED_TERMINAL,
    capabilities: ['ssh-child-write-receipts-v1', 'sessions', 'wrapped-sessions', 'skill-installer', 'singleton-daemon', 'handoff-inbox', 'deliberation-threads', 'cross-machine', 'mailbox', 'inject-exact-target', 'register-create-only', 'delete-owned-session']
  });
});

// --- Mailbox API endpoints ---

registerMailboxRoutes(app, { sessions, resolveSessionAlias, getMailbox: () => mailbox, sessionCredentials, persistSessions });
const cooperativeHandoff = require('./src/principal/cooperative-handoff').registerCooperativeHandoff(app,{context:sessionRecordContext,getMailbox:()=>mailbox,
  hasUnsettled:(id,s)=>!!pendingReports[id] || !!s.pendingSubmit || !!s.bootstrapDraining || hasBootstrapBacklog(s) || hasHeldInteraction(s)
    || Object.values(trackedInjections.interactions?.actions || {}).some(r=>r.sid===id && ['dispatched','outcome_unknown'].includes(r.stage))});
require('./src/principal/takeover').registerMailboxTakeoverRoute(app, { context: sessionRecordContext, getMailbox: () => mailbox, broadcastSessionEvent });
registerSharedReferenceRoutes(app);

// Peer management endpoint (for cross-machine module)
app.get('/api/peers', (req, res) => {
  try {
    const crossMachine = require('./cross-machine');
    res.json({
      active: crossMachine.listActivePeers(),
      known: crossMachine.listPublicKnownPeers()
    });
  } catch {
    res.json({ active: [], known: {} });
  }
});

registerFanoutRoutes(app, {
  classifyPeerLaneInject,
  ORCHESTRATOR_SIDS,
  crypto,
  sessions,
  broadcastSessionEvent,
  auditAppend,
  MACHINE_ID,
  respondWithError,
  FANOUT_MAX_TARGETS,
  verifiedSenderFields,
  verifiedPrincipalFromReq,
  deliverInjectionToSession,
  deliveryAuditResult,
  broadcastBusEvent,
  busClients
});

// CLI-specific submit strategies
// All CLIs submit via PTY \r when running inside telepty allow bridge
const SUBMIT_STRATEGIES = {
  claude: 'pty_cr',
  gemini: 'pty_cr',
  codex: 'pty_cr',
};





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



// POST /api/sessions/:id/submit — render-gated CLI-aware submit
//
// Default behavior (0.3.0+): wait for the target REPL to be ready (sessionStateManager
// reports `idle`/`waiting` with confidence ≥ 0.5, the awaitReplReady default) before firing
// Enter. #694: a BUSY recipient (working/thinking) is never idle/waiting, so the busy-dispatch
// fast-path below dispatches best-effort after an echo+quiet settle instead of burning the gate
// timeout. When the caller passes `injected_body`, also verify the body has been consumed (i.e.
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
sessionActions.registerSubmitRoute(app);

// Submit Enter to every active session. #546: submit is a PTY/context op (bare 0x0D) for every
// wrapped + spawned backend INCLUDING cmux — the path validated 3/3 live for per-session submit
// (#544). The cmux `send-key --surface return` surface op is removed (ZERO cmux send-key);
// osascript Cmd+Enter remains only for app-window sessions with no PTY bridge. Exported (pure
// over the passed sessions map) so the dispatch is unit-testable without starting the daemon.


// POST /api/sessions/submit-all — Submit all active sessions
sessionInspection.registerSubmitAllRoute(app);

require('./src/peer-forwarding').registerPeerForwardRoutes(app, {
  sessions, loadPeers: () => require('./cross-machine').loadPeers()
});
sessionActions.registerInjectRoute(app, '/api/forwarded/sessions/:id/inject');
sessionActions.registerInjectRoute(app);

// #826 — the OTHER write path, kept next to the route above because they are twins and were
// diverging silently.
//
// `src/transport/websocket.js` forwards an attached viewer's `{type:'input'}` to the PTY owner as
// `{type:'inject'}`. That is a write into somebody's terminal with exactly the authority of the
// route above, and until now it applied none of the route's accountability: no `auditAppend`
// (#47 P5), no `classifyPeerLaneInject` (#533's hard block), no provenance labelling.
//
// That gap only became DANGEROUS with #820/#823. Before them the audit log was obviously
// incomplete — anything on the box could write with no credential, so nobody could read the log
// as a record of anything. Once every writer is authenticated an operator will reasonably read
// the inject log as THE record of who typed into a session, and #533 as THE enforcement point.
// Both would then claim more than they measure. The security fix is what creates the false
// confidence, which is why this ships in the same release.
//
// Held to the SAME rule as the HTTP path, deliberately no stricter: the policy verdict is keyed
// on a CLAIMED sender at both doors (so #533 remains a policy guardrail, not an authentication
// boundary), while `verified_sender_*` comes from the #815 bearer presented on the handshake and
// never from the frame — the same split as `body.from` vs `x-telepty-session-token`.
//
// Records admission before the attempt, and returns a completion hook so transport
// dispatch is recorded only after its callback (or native write return).
const authorizeViewerInject = require('./src/audit/viewer-input').createViewerInputAuthorization({
  classify: classifyPeerLaneInject, audit: auditAppend, broadcast: broadcastSessionEvent,
  verifiedSenderFields, machineId: MACHINE_ID, orchestratorSids: ORCHESTRATOR_SIDS,
  randomUUID: () => crypto.randomUUID()
});

// GET /api/inject-observations/:inject_id — #60 Stage A, the orchestrator's poll target.
//
// ALWAYS 200 with a discriminated schema-v2 body. Schema v2 never uses 404 as a task-state
// signal: "the daemon has no record of this inject" and "the task is finished" are different
// statements, and a status code cannot tell them apart. An absent, pre-v2 or corrupt record is
// `tracking_state:"unavailable"` with a NAMED reason.
//
// Contract notes for consumers:
//   - `reason` is TOP-LEVEL on the unavailable arm (bin/dispatch-tracker.sh reads it there).
//   - `observation` is always an object and `observation.kind` always a string.
//   - `completion_fact` is always null and `terminal` always false in 0.8.0. There is no code
//     path in this release that can set either to anything else.
//   - An UNAUTHENTICATED caller never reaches this handler: the HTTP auth middleware answers
//     401/403 first, with no body of this schema. A 401 therefore means "prove who you are",
//     NOT "this endpoint is absent" and NOT "nothing is tracked" — a consumer that folds it into
//     an absence reason is making exactly the overclaim this release removes. Send the daemon
//     token (`x-telepty-token`).
app.get('/api/inject-observations/:inject_id', (req, res) => {
  const injectId = req.params.inject_id;

  const unavailable = (reason, extra = {}) => res.status(200).json({
    type: 'task_completion_unknown',
    schema_version: 2,
    inject_id: injectId,
    completion_fact: null,
    terminal: false,
    tracking_state: 'unavailable',
    reason,
    observation: { kind: 'tracking_unavailable', trigger: reason },
    consumption: { status: 'not_established', basis: 'no_tracked_inject' },
    capability: { ...CAPABILITY_STAGE_A },
    ...extra,
  });

  if (!trackedLedgerHealthy) {
    return unavailable(trackedLedgerUnavailableReason || 'observation_store_unavailable');
  }
  const record = getTrackedInjection(injectId);
  if (!record) {
    // Either it was never tracked here, or it predates this daemon's schema-v2 store. Both are
    // "this daemon epoch did not observe it" — explicitly, not by omission.
    return unavailable('not_observed_by_daemon_epoch');
  }

  // #843 — the consumption block must be measured FOR THE INJECT BEING POLLED. This read
  // `getPendingReport(record.session_id)` — whichever inject currently owns that session's pending
  // slot — with no check that it is the same one. `GET /api/inject-observations/A` therefore
  // changed its answer when an unrelated inject B arrived and became byte-identical to `GET B`
  // while A was marked superseded: one inject's evidence served under another inject's id. That is
  // the same substitution this release removes everywhere else, at the endpoint an orchestrator
  // polls to decide what happened to a specific dispatch.
  //
  // When the slot belongs to someone else, the honest answer is that this inject has no
  // consumption evidence of its own — named, not borrowed.
  const activePendingReport = getPendingReport(record.session_id);
  const pendingReport = activePendingReport && activePendingReport.injectId === record.inject_id
    ? activePendingReport
    : null;
  const consumption = pendingReport
    ? classifyConsumption(pendingReport)
    : {
      status: 'not_established',
      basis: activePendingReport ? 'pending_report_belongs_to_other_inject' : 'no_active_pending_report',
      ...(activePendingReport ? { active_inject_id: activePendingReport.injectId || null } : {}),
    };
  const last = record.last_observation || { kind: 'tracking_started', trigger: 'inject_accepted' };

  return res.status(200).json({
    type: 'task_completion_unknown',
    schema_version: 2,
    session_id: record.session_id,
    inject_id: record.inject_id,
    completion_fact: null,
    terminal: false,
    // #843 — `aborted` travels too. Collapsing it into `tracked` would put a dispatch that
    // delivered zero bytes back into the in-flight bucket the abort exists to take it out of.
    tracking_state: ['superseded', 'aborted'].includes(record.tracking_state) ? record.tracking_state : 'tracked',
    observation: last,
    observation_seq: record.observation_seq,
    observations: record.observations || [],
    consumption,
    session_epoch: record.session_epoch,
    session_epoch_reason: record.session_epoch_reason,
    transport_source: record.transport_source,
    created_at: record.created_at,
    capability: record.capability || { ...CAPABILITY_STAGE_A },
  });
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
    // #60 Stage A: `idle_notified` is GONE from this response. It was the PTY-derived false
    // authority — a consumer that read it as "the worker finished" was reading a debounce bit.
    // The honest replacement is the observation itself, from the ledger.
    tracking_state: (() => {
      const rec = getTrackedInjection(entry.injectId);
      return rec ? rec.tracking_state : 'unavailable';
    })(),
    last_observation: (() => {
      const rec = getTrackedInjection(entry.injectId);
      return rec ? rec.last_observation : null;
    })(),
    completion_fact: null,
    terminal: false,
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
app.get('/api/sessions/:id/screen', require('./src/routes/session-screen').createScreenHandler({ sessions, resolveSessionAlias }));

registerSessionRenameRoute(app, { context: sessionRecordContext, sessionStateManager, busClients,getMailbox:()=>mailbox });

sessionActions.registerKillRoute(app);

/**
 * #843 A — the DELETE teardown response, as a value. PURE.
 *
 * Two different things happened and they must not answer with the same word. `killError === null`
 * means the teardown call returned; a non-null one means it threw, the registry record was removed
 * anyway (leaving a half-torn record would be worse), and therefore the daemon can no longer
 * observe or signal a process that may still be running. That is a condition to report, not a
 * `status` string tacked onto a success.
 *
 * Pure and exported because the branch is otherwise unreachable from a test: node-pty's `kill()`
 * swallows ESRCH on a reaped child, so nothing an integration test can arrange makes the real call
 * throw — and an unreachable branch that returns success is precisely what shipped.
 */

sessionActions.registerDeleteRoute(app);

// Shared auto-router: handles turn_request events from any source (WS or HTTP)

sessionActions.registerBusPublishRoute(app);
require('./src/routes/application-events').registerApplicationEventRoute(app,{sessions});

registerHandoffRoutes(app, { handoffs, crypto, busClients });

// --- Deliberation Thread Tracking ---

registerThreadRoutes(app, { threads, crypto, busClients });

// Bind the port when launched as the daemon. A test can `require('./daemon.js')` to reach the
// exported decision functions WITHOUT starting the daemon — it just must not set the env below.
// The production CLI reaches daemon.js via require() (cli.js `cmd==='daemon'`), so require.main is
// cli.js, never this module — hence the explicit AIGENTRY_TELEPTY_DAEMON_MAIN signal. Guarding on
// require.main ALONE (0.5.0 regression) meant app.listen never ran in production → daemon exited 0.
let server;
let tailnetServer; // additive tailnet listener (AUTO_TAILNET path); needs the WS upgrade handler too
if (require.main === module || process.env.AIGENTRY_TELEPTY_DAEMON_MAIN === '1') {
  if (AUTO_TAILNET) {
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
    });
    // Additive tailnet listener — same HTTP posture as the loopback primary (the daemon
    // is HTTP by design, and tailnet transport is already
    // WireGuard-encrypted). app.listen() returns a fresh server, so this is a second
    // socket on the same app. ponytail: fixed-PORT production shares one port on both
    // listeners; a PORT=0 ephemeral run would split ports, but the auto path is never
    // taken under PORT=0 in the suite (TELEPTY_NO_TAILNET_AUTO=1 default in setup-env.js).
    tailnetServer = app.listen(Number(PORT), TAILNET_IP);
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
mailboxNotifier.setSocketResolver(sessionDeliveryContext.resolveMailboxSocket);

// Delivery engine: dequeue → writeDataToSession → ack/nack
const mailboxDelivery = new DeliveryEngine(mailbox, sessionDeliveryContext.mailboxDeliveryOptions);
// Startup sweep: break stale lock files before starting delivery. Guarded so a test require
// of this module neither breaks on-disk locks nor starts the delivery loop.
//
// #916 block 3: the guard is the one #896 (title), #910 (singleton claim) and #916.1 (shutdown)
// already use. `require.main === module` alone is false in production, so this loop has NEVER
// run on a real daemon — `DeliveryEngine.start()` logs unconditionally and `[MAILBOX]
// DeliveryEngine started` appears 0 times in 47,771 lines of the operator's daemon log.
//
// First-attempt delivery was never lost: `mailboxDelivery.tick()` is called synchronously on the
// inject path. What was missing is the BACKGROUND leg — in-flight recovery, stale expiry, and
// retry of a first attempt that failed (the daemon log's "Delivery failed … (attempt 0/1/2)"
// lines had no loop to carry them further).
//
// Enabling is safe by measurement, not assumption (2026-08-16, before this change):
// `sessionResolver` is `() => Object.keys(sessions)`, so the loop only ever touches LIVE sessions
// — the 777 stale mailbox directories on that host are unreachable to it — and every message for
// every live session was already `acked` (PENDING = 0). There is no backlog to flush.
if (require.main === module || process.env.AIGENTRY_TELEPTY_DAEMON_MAIN === '1') {
  const staleBroken = mailbox.breakStaleLocks();
  if (staleBroken > 0) {
    console.log(`[MAILBOX] Startup sweep: broke ${staleBroken} stale lock(s)`);
  }
  mailboxDelivery.start();
}

const IDLE_THRESHOLD_SECONDS = 60;
const { BUS_KIND: SUSTAINED_IDLE_KIND, idleObservationConfig, createSustainedIdleObserver } = require('./src/sustained-idle-observation');
const sustainedIdleObserver = createSustainedIdleObserver(idleObservationConfig());
// #916 block 4: the idle-TTL reaper's mode. `enforce` is the pre-#916 behaviour (auto-kill);
// `warn` computes exactly the same victim list and LOGS what it would reap without touching it;
// `off` does not arm the sweep at all.
//
// Default is `warn`, deliberately. This sweep has NEVER run on a real daemon — it was guarded on
// `require.main === module`, false in production — so `idle_ttl` is a feature no operator's config
// has ever actually exercised. Arming it and enforcing in the same change would turn a silently
// inert setting into a session-killer at one restart, with no chance to read what it was about to
// do. Warn first; the operator flips `enforce` after reading the log.
const IDLE_TTL_MODE = (() => {
  const raw = String(process.env.TELEPTY_IDLE_TTL_MODE || 'warn').trim().toLowerCase();
  return ['off', 'warn', 'enforce'].includes(raw) ? raw : 'warn';
})();

// `deps` follows this file's existing DI idiom (fireAutoReport, recordObservation,
// ensureDaemonRunning) so warn-vs-enforce is unit-testable without live sessions.
async function runIdleTtlSweep(nowMs = Date.now(), deps = {}) {
  const _sessions = deps.sessions || sessions;
  const _config = deps.config || teleptyConfig;
  const _teardown = deps.teardownSessionById || teardownSessionById;
  const _broadcast = deps.broadcastSessionEvent || broadcastSessionEvent;
  const _log = deps.log || console.log;
  const mode = deps.mode || IDLE_TTL_MODE;

  const victims = lifecycle.selectIdleTtlVictims(_sessions, _config, { nowMs });

  // WARN-ONLY: say precisely what enforce would have destroyed, and destroy nothing. No
  // `tracing`/`idle_ttl_auto_kill` broadcast here — that event asserts a kill happened, and
  // emitting it for a session still running would be a false statement on the bus.
  if (mode !== 'enforce') {
    for (const victim of victims) {
      _log(`[REAPER] WARN-ONLY: would auto-kill ${victim.id} after ${victim.idleSeconds}s idle `
        + `(ttl=${victim.ttlMs}ms). Nothing was killed — set TELEPTY_IDLE_TTL_MODE=enforce to act on this.`);
    }
    return { mode, victims: victims.map((v) => v.id), killed: [] };
  }

  const killed = [];
  for (const victim of victims) {
    const session = _sessions[victim.id];
    if (!session || session._idleTtlKilling) continue;
    session._idleTtlKilling = true;
    _broadcast('tracing', victim.id, session, {
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
      await _teardown(victim.id, {
        force: false,
        timeoutMs: 5000,
        reason: 'IDLE_TTL',
        source: 'idle_reaper'
      });
      killed.push(victim.id);
      _log(`[REAPER] Auto-killed ${victim.id} after ${victim.idleSeconds}s idle (ttl=${victim.ttlMs}ms)`);
    } catch (err) {
      session._idleTtlKilling = false;
      console.error(`[REAPER] Failed to auto-kill ${victim.id}: ${err.message}`);
    }
  }
  return { mode, victims: victims.map((v) => v.id), killed };
}

// Guarded: timers must not run (and keep the event loop alive) on a test require.
//
// #916 block 4: the guard is the one #896/#910/#916.1/#916.3 use — `require.main === module` alone
// is false in production, so this sweep has never run on a real daemon. It arms in `warn` and
// `enforce`; `off` does not arm it at all. The startup line states the mode out loud, because an
// operator reading a log needs to know whether this daemon would kill or only report.
if (IDLE_TTL_MODE !== 'off' && (require.main === module || process.env.AIGENTRY_TELEPTY_DAEMON_MAIN === '1')) {
  console.log(`[REAPER] idle-TTL sweep armed (mode=${IDLE_TTL_MODE}, poll=${IDLE_REAPER_POLL_MS}ms)`);
  setInterval(() => {
    runIdleTtlSweep().catch((err) => {
      console.error(`[REAPER] Idle TTL sweep failed: ${err.message}`);
    });
  }, IDLE_REAPER_POLL_MS);
}

// #916 block 2, the last of the four. Same guard as #896 (title), #910 (singleton claim),
// #916.1 (shutdown) and #916.4 (idle reaper): `require.main === module` alone is false in
// production, so this sweep has never run on a real daemon.
//
// It is NOT only telemetry, which is why it was held for an explicit owner decision. Every
// HEALTH_POLL_MS this loop:
//   • broadcasts `session_health` per session, and `session.idle` past IDLE_THRESHOLD_SECONDS
//   • fires the legacy `silence-timeout` auto-report for NON-wrapped sessions with a pending
//     report (no-op for an all-wrapped host)
//   • re-checks aterm socket liveness and cmux surface liveness
//   • and DELETES sessions: a wrapped/aterm session with no owner socket, no clients, and
//     `disconnectedSeconds >= SESSION_CLEANUP_SECONDS` is removed and its credential revoked
//
// That last one is the reason for the deployment gate. At a restart, persisted sessions are
// restored with `ownerWs` null and `clients` 0, so a bridge that never reconnects becomes
// eligible — which is #905's failure mode. The threshold is operator-set:
// `SESSION_CLEANUP_SECONDS` (line 82) reads TELEPTY_SESSION_CLEANUP_SECONDS at boot, and this
// host's launchd plist carries 86400, so the GC needs a full day of absence rather than 5
// minutes. The startup line below states the effective value out loud, because "is the knob
// actually in effect?" must be answerable from the log rather than inferred.
if (require.main === module || process.env.AIGENTRY_TELEPTY_DAEMON_MAIN === '1') {
  console.log(`[HEALTH] session sweep armed (poll=${HEALTH_POLL_MS}ms, stale-disconnect cleanup after ${SESSION_CLEANUP_SECONDS}s)`);
  setInterval(() => {
  const now = Date.now();
  for (const [id, session] of Object.entries(sessions)) {
    const quietObservation = sustainedIdleObserver.observe(id, session, { nowMs: now, machineId: MACHINE_ID, activityState: sessionStateManager.getState(id) });
    if (quietObservation) broadcastSessionEvent(SUSTAINED_IDLE_KIND, id, session, { nowMs: now, includeTransport: false, includeSemantic: false,
      extra: { kind: SUSTAINED_IDLE_KIND, version: 1, message_id: crypto.randomUUID(), source: `telepty:${id}`,
        source_host: MACHINE_ID, target: null, ts: quietObservation.observed_at, observation: quietObservation, completion_fact: null, terminal: false } });
    if (session.isClosing) {
      // Retrying an observed natural exit only commits metadata; its process
      // handles/PIDs were retired at the exit callback, so no signal is sent.
      const retry = Object.getOwnPropertyDescriptor(session, 'retryNaturalExitCleanup')?.value;
      if (typeof retry === 'function') retry();
      continue;
    }
    const idleSeconds = session.lastActivityAt ? Math.floor((now - new Date(session.lastActivityAt).getTime()) / 1000) : null;
    const healthStatus = getSessionHealthStatus(session, { nowMs: now });
    const healthReason = getSessionHealthReason(session, healthStatus);
    if(require('./src/principal/cooperative-handoff').activeHandoff(session) || (session.cooperativeHandoff?.state==='committed' && session.cooperativeHandoff.pending_count>0))continue;
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
    // #60 Stage A: the `!idleNotified` once-only guard is gone — repeat observations are deduped
    // by identity inside the emitter, which returns `observation_duplicate` instead of silently
    // dropping a later genuine measurement.
    if (pendingRpt && session.type !== 'wrapped' && idleSeconds !== null && idleSeconds >= AUTO_REPORT_IDLE_SECONDS) {
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

    // #17: CONNECTED-zombie detection via cmux surface-liveness. Post-08cd796 a wrapped cmux
    // bridge SURVIVES its terminal app's death, so ownerWs stays OPEN and the 300s disconnect-GC
    // (below) never fires. If the workspace was EXPLICITLY closed while cmux itself is alive, the
    // session is a headless-zombie CANDIDATE.
    //
    // #844: it is a candidate, and this block no longer reclaims one. What INV-17 actually
    // establishes is narrower than it read: `isSurfaceAlive` returns 'unknown' when cmux is
    // unreachable or answers with something that is not a parseable listing, so those cases GC
    // nothing — but "the uuid was missing from a listing we could parse" is still a statement
    // about ANOTHER TOOL'S STDOUT, and this block only ever runs for sessions whose owner socket
    // is OPEN. That socket is this daemon's own, first-hand, present-tense measurement that the
    // session is alive, and it outranks the parsed absence rather than merely gating the look at
    // it. So the outcome here is the `surface_orphaned` SIGNAL, once, and nothing else. The
    // #486/#488 survival guarantee is preserved by construction now, not only in the
    // unreachable-cmux case.
    //
    // Stated so nobody has to assume it: NO consumer reclaims the session on that signal today.
    // The orchestrator's always-on `wh_alive` sweep closes the SURFACE; its event-driven consumer
    // for this event reads a state file no bus→file bridge writes, so it is dormant (orchestrator
    // task #847). A session whose workspace is gone while its owner socket stays open therefore
    // persists here until the disconnect-GC or an explicit cleanup. That is the intended trade —
    // the alternative was destroying it on evidence weaker than the socket being overridden.
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
      // #844: the verdict, then what it is allowed to actuate. This block is entered ONLY when the
      // owner socket is open, so the pre-#844 code used "a uuid did not appear in cmux's stdout"
      // to override "this session is connected right now" — the weaker measurement overriding the
      // stronger, first-hand one. The open socket blocks the kill; the `surface_orphaned` signal
      // still goes out, once. See the block comment above for what does and does not consume it.
      const gcAction = decideSurfaceGcAction(decideSurfaceGc(liveness, session, now), {
        ownerConnected: true,
        alreadySignalled: Boolean(session.surfaceOrphanSignalledAt)
      });
      if (gcAction === 'mark') {
        session.surfaceGoneAt = new Date().toISOString();
        console.log(`[SURFACE-GC] cmux workspace gone for ${id} (${session.cmuxWorkspaceId}) — ${SURFACE_ORPHAN_SECONDS}s grace started`);
      } else if (gcAction === 'signal') {
        const goneSeconds = Math.floor((now - new Date(session.surfaceGoneAt).getTime()) / 1000);
        console.log(`[SURFACE-GC] cmux workspace still absent for ${id} after ${goneSeconds}s — signalling surface_orphaned; the owner socket is OPEN so this session is NOT reclaimed here`);
        // Surface-ownership verdict (2026-05-30): telepty does NOT close the surface — it emits
        // the orphan SIGNAL and the orchestrator's sweep closes it. #844 extends the same split to
        // the SESSION: a workspace uuid missing from another tool's stdout does not outrank this
        // daemon's own open socket to the session, so the signal is the whole action here. Note
        // the asymmetry, because it is load-bearing: the surface half HAS an always-on consumer,
        // the session half does not yet (orchestrator #847), so this session stays until the
        // disconnect-GC or an explicit cleanup.
        broadcastSessionEvent('surface_orphaned', id, session, {
          extra: {
            sid: id,
            backend: session.backend || null,
            cmuxWorkspaceId: session.cmuxWorkspaceId || null,
            surfaceGoneSeconds: goneSeconds,
            livenessVerdict: liveness,
            ownerSocketOpen: true,
            reclaimed: false
          }
        });
        session.surfaceOrphanSignalledAt = new Date().toISOString(); // once, not once per tick
      } else if (gcAction === 'recover') {
        // Recovery within the grace window (mirrors the aterm socket-recover above).
        console.log(`[SURFACE-GC] cmux workspace recovered for ${id} — clearing grace window`);
        session.surfaceGoneAt = null;
        session.surfaceOrphanSignalledAt = null; // #844: a later genuine absence signals again
      }
      // 'skip' (incl. 'unknown' — INV-17 gate) → leave surfaceGoneAt unchanged, GC nothing.
    }

    if (healthStatus === 'STALE' && !session._staleEmitted) {
      session._staleEmitted = true;
      emitSessionLifecycleEvent('session_stale', id, session, {
        disconnectedSeconds
      });
    }

    // #732: surface the socket-alive/pipe-dead transition exactly once per stall, and
    // re-arm when upstream bytes resume. Without this the break is only visible to
    // whoever next reads the screen — which in the live incident was ~9h later.
    if (healthStatus === 'UPSTREAM_STALLED' && !session._upstreamStallEmitted) {
      session._upstreamStallEmitted = true;
      console.warn(`[UPSTREAM] Session ${id} output pipe is dead — owner connected, 0 bytes back since ${new Date(session.upstreamProbeAt).toISOString()}`);
      emitSessionLifecycleEvent('session_upstream_stalled', id, session, {
        silentSeconds: Math.floor((now - session.upstreamProbeAt) / 1000),
        bridgeHeartbeatAt: session.bridgeHeartbeatAt || null,
        bridgeReadSide: session.bridgeReadSide || null
      });
    } else if (healthStatus !== 'UPSTREAM_STALLED' && session._upstreamStallEmitted) {
      session._upstreamStallEmitted = false;
      console.log(`[UPSTREAM] Session ${id} output pipe recovered`);
      emitSessionLifecycleEvent('session_upstream_recovered', id, session);
    }

    const shouldCleanupDisconnected = (session.type === 'wrapped' || session.type === 'aterm')
      && !isOpenWebSocket(session.ownerWs)
      && (!session.clients || session.clients.size === 0)
      && disconnectedSeconds !== null
      && disconnectedSeconds >= SESSION_CLEANUP_SECONDS;

    if (shouldCleanupDisconnected) {
      // Commit the removal before revoking authority or publishing a lifecycle transition.
      delete sessions[id];
      const saved = persistSessions();
      if (!saved || !saved.ok) {
        if (!saved || !saved.committed) {
          Object.defineProperty(sessions, id, { value: session, enumerable: true, writable: true, configurable: true });
        } else {
          revokeSessionCredential(id);
          sessionStateManager.unregister(id);
        }
        console.error('[CLEANUP] Session removal was not durably saved:', id);
        continue;
      }
      revokeSessionCredential(id);
      sessionStateManager.unregister(id);
      emitSessionLifecycleEvent('session_cleanup', id, session, {
        reason: 'STALE_DISCONNECTED', disconnectedSeconds
      });
      console.log(`[CLEANUP] Removed stale session ${id} after ${disconnectedSeconds}s disconnected`);
    }
  }
  }, HEALTH_POLL_MS);
}

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


const websocketTransport = installWebSocketTransport({
  principalAuthentication,
  server,
  tailnetServer,
  sessions,
  busClients,
  credentials: sessionCredentials,   // #815 — owner-claim gate
  expectedToken: EXPECTED_TOKEN,
  verifyJwt,
  isAllowedPeer,
  isForbiddenOrigin,
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
  busAutoRoute,
  // #60 Stage A §3 — the total observation emitter and the per-session ledger query, so the
  // transport can persist #815's owner-replaced / owner-death facts against every tracked inject
  // instead of only announcing them on the bus. fireAutoReport is NOT usable for these: it falls
  // into the #48/#52 settle window and drops the emission when the session is busy, and an owner
  // replacement is a hard fact the daemon knows with certainty.
  recordObservation,
  listTrackedInjectionsForSession,
  // #826 — the viewer write path gets the same policy verdict and the same audit line as
  // POST /api/sessions/:id/inject. See authorizeViewerInject.
  authorizeViewerInject,
  acceptInteractionReceipt,
  acceptHandoffAck:cooperativeHandoff.acceptAck
});

let shuttingDown = false;
async function shutdown(code) {
  websocketTransport.closeObservers();
  if (shuttingDown) return;
  shuttingDown = true;
  eventLoopTelemetry.stop();
  mailboxDelivery.stop();
  mailboxNotifier.cancelAll();
  if (server) server.close();
  await auditReader.close();
  try { await auditWriter.close(); } catch (error) { console.error('[AUDIT] Shutdown flush failed:', error.message); }
  clearDaemonState(process.pid);
  process.exit(code);
}

// Daemon-lifecycle signal/exit handlers — only when run as the daemon, so a test require does
// not register them (and does not clear on-disk daemon-state at the test process's exit).
//
// #916 block 1: the guard is the one #896 (title) and #910 (singleton claim) already use.
// `require.main === module` alone is false in production — launchd runs `telepty daemon` →
// cli.js → `require('./daemon.js')` — so NO real daemon has ever had a shutdown path: every one
// died on the default SIGTERM disposition, with no mailboxDelivery.stop(), no
// mailboxNotifier.cancelAll(), and no clearDaemonState(). #902's incident recorded the
// signature: `launchctl … last exit -15`, where a handled signal would have exited 0.
//
// This is the other half of #910. #910 makes the daemon WRITE daemon-state.json; without this
// nothing ever clears it, so a state file outlives the daemon that wrote it.
if (require.main === module || process.env.AIGENTRY_TELEPTY_DAEMON_MAIN === '1') {
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
  detectIdleAfterError,           // #801: turn-scoped error-death verdict (TASK_ERROR vs TASK_COMPLETE)
  maybeRecordInjectConsumption,   // #60 Stage A: records the fresh-busy-edge CANDIDATE (see the fn comment)
  maybeRecordLauncherConsumption, // #60 Stage A: launcher watermark telemetry — never consumption
  recordObservation,              // #60 Stage A: the TOTAL observation emitter (named result on every path)
  SESSION_CLEANUP_SECONDS,        // #916.2: stale-disconnect GC threshold (TELEPTY_SESSION_CLEANUP_SECONDS)
  runIdleTtlSweep,                // #916.4: idle-TTL sweep (deps DI: sessions/config/teardown/mode)
  IDLE_TTL_MODE,                  // #916.4: 'off' | 'warn' (default) | 'enforce'
  describeSessionTeardown,        // #843: DELETE teardown response — a failed kill never reports success
  beginTrackedInjection,          // #60 Stage A: durable write-before-delivery tracking record
  sessionAuthenticationCapability, // #860 F1: "observed" requires a bearer that was PRESENTED and verified
  deliveryAuditResult,            // #860 F2: audit `delivery_result` — `queued` is not `success`
  getTrackedInjection,            // #60 Stage A: ledger read by inject_id
  listTrackedInjectionsForSession, // #60 Stage A: ledger read by session (owner-lifecycle fan-out)
  restoreTrackedInjections,       // #60 Stage A: restore + daemon_restart_observed, before readiness
  observeInjectEchoEvidence,      // #60 Stage A: ring-scoped echo evidence (a field, no longer a gate)
  forceSubmitDeliveredToSurface,  // #544/#537/Bug B: PTY-native force-confirm (pty_cr = delivered)
  isTerminalGateFailure,          // #678: submit-gate disposition — no_state is best-effort dispatch, not hard-fail
  terminalLevelSubmit,            // #544: PTY-only submit path (pty_cr | null)
  submitViaPty,                   // #544: bare-0x0D submit into the innermost node-pty
  runSubmitAll,                   // #546: submit-all via PTY for every backend (no cmux send-key)
  failBootstrapQueueOnTimeout,    // #31: actionable bootstrap-timeout queue flush
  shouldApplyOwnerAliveFloor,     // #29: owner-alive optimistic-floor decision (deps DI: isProcessRunning/...)
  scheduleBootstrapPromptPoll,    // #29: arms the floor timer (deps DI: setTimeout/...)
  isUpstreamStalled,              // #732: pure "socket alive, pipe dead" predicate
  armUpstreamProbe,               // #732: arms the upstream watermark probe on a delivery
  decideSurfaceGc,                // #17: surface-liveness verdict→action (incl. INV-17 unknown→skip)
  applySurfaceMismatchProbe,      // surface_mismatched debounce + payload helper (deps DI: emit/clock)
  classifyPeerLaneInject,         // #533 Phase 2: pure peer-lane inject policy verdict
  appendToOutputRing,             // #716: seam that tracks bracketed-paste capability (?2004h)
  maybeBracketedPaste,            // #716/#730: identity+observation-gated bracketed-paste wrap
  forceSubmitCrGapMs,             // #730: scoped force-path text→CR floor (un-enveloped multi-line only)
  isSurfaceBlockedByModal,        // #737: fail-open modal predicate over the PTY output ring
  modalDeliveryDecision,          // #737: the one decision every write path consults
  modalRemedy,                    // #737/#760: TELEPTY_MODAL_REMEDY selector, per-CLI default
  modalHoldMs,                    // #737: TELEPTY_MODAL_HOLD_MS bound on the hold remedy
  awaitSurfaceModalClear,         // #737: A — park until the surface leaves the modal
  resolveModalGate,               // #737: the awaited gate every write path shares
  readOutputRingTail,             // #737: bounded newest-first ring read (predicate input)
  modalParkTtlMs,                 // #760: TELEPTY_MODAL_PARK_TTL_MS bound on the park remedy
  awaitModalParkDrain,            // #760: poll → drain in order, or flush on TTL
  drainBootstrapQueue,            // #760: modal-guarded FIFO drain (also the boot drain)
  deliverInjectionToSession,      // #760: park-vs-deliver decision at the text path
  resolveBindPort,                // #1124: TELEPTY_PORT first, shared with service descriptors
  resolveBindHost,                // telepty#50 + #672: pure bind-address policy (loopback default, env opt-in, tailnet auto)
  formatBindHint,                 // telepty#50 + #672: startup bind/exposure banner line
  isTailnetAuto,                  // #672: pure predicate — is the zero-config tailnet path active
  resolveEffectivePeerAllowlist,  // #672: pure allowlist policy — auto-trust tailnet without widening a manual set
};
