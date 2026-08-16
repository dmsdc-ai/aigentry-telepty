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
const { CAPABILITY_STAGE_A, classifyConsumption, buildCompletionUnknown, formatCompletionUnknownText } = completionObservation;
const submitGate = require('./src/submit-gate');
const { stripAnsiForScreen } = require('./src/screen-ansi'); // #715: read-screen ANSI/VT stripper
const { sampleChildCpuSeconds } = require('./src/child-cpu'); // #52: quiet-thinking CPU recheck
const readyRegistry = require('./src/prompt-symbol-registry');
const lifecycle = require('./src/lifecycle');
const { SURFACE_ORPHAN_SECONDS, SURFACE_MISMATCH_SECONDS, decideSurfaceGc, decideSurfaceGcAction, applySurfaceMismatchProbe } = lifecycle;
const { loadTeleptyConfig } = require('./src/config-file');
const sessionPersistence = require('./src/session-store/persistence');
const { createCredentialStore } = require('./src/session-store/session-credentials');
const { createAuditWriter, readInjectLog } = require('./src/audit/inject-log');
const { mintSessionNonce, applyProvenance } = require('./src/audit/provenance');

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
function buildAutoSummaryWithDefaults(session) {
  return buildAutoSummary(session, {
    maxLines: REPORT_AUTO_SUMMARY_LINES,
    maxBytes: REPORT_AUTO_SUMMARY_MAX_BYTES
  });
}

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
sessionStateManager.onTransition((sessionId, from, to, detail) => {
  const session = sessions[sessionId];
  if (!session) return;
  const cause = detail && detail.detail ? detail.detail.trigger : null;
  const evidence = { ...(detail && detail.detail ? detail.detail : {}), confidence: detail ? detail.confidence : undefined };

  // External activity vocabulary (§2.3/§3.8). The internal 8-state FSM is unchanged — submit and
  // readiness code branches on it (src/submit-gate.js:21-46, :498-508) — but what leaves this
  // process is the measured cause, never the state name.
  const mapped = mapObservationCause({ destination: to, cause, evidence });
  broadcastSessionEvent('session_activity_observation', sessionId, session, {
    extra: {
      schema_version: 2,
      observation: { kind: mapped.kind, trigger: mapped.cause, ...mapped.fields },
      from_observation_state: from,
      completion_fact: null,
      terminal: false,
    }
  });

  const pendingReport = getPendingReport(sessionId);
  if (!pendingReport) return;

  if (to === 'working' || to === 'thinking') {
    if (!pendingReport.submitExpected || pendingReport.submitStartedAt) {
      pendingReport.sawWorkingAfterInject = true;
      pendingReport.workingAfterInjectAt = new Date().toISOString();
    }
    // #619 lineage: capture the fresh-turn edge the instant it fires, because the outputRing it
    // would otherwise be re-derived from has scrolled off by the time a long turn goes quiet.
    // Stage A records it as a CANDIDATE only — see maybeRecordInjectConsumption for why the
    // submit-confirmation conjuncts cannot be evaluated at this point.
    maybeRecordInjectConsumption(pendingReport, from, to, sessionStateManager.getState(sessionId)?.since_ms);
    recordObservation({ sessionId, session, pendingReport, destination: to, cause, evidence, trigger: 'transition' });
    return;
  }

  if (to === 'idle') {
    // #545: reliability of the idle evidence is still computed, and is still worth recording —
    // it is now a FIELD on the observation rather than an input to a promotion decision. Note
    // both OSC-133 causes count: the raw marker and quiet-after-a-recent-marker are different
    // measurements, and the old code compared against the single overloaded `osc_133_prompt`.
    const bodyText = pendingReport.injectedBodyPreview;
    const bodyVisible = bodyText
      ? submitGate.observeBodyVisibility(session, bodyText).visible === true
      : false;
    const idleEvidenceReliable = (cause === 'osc_133_a_or_b_received' || cause === 'quiet_after_recent_osc_133_a_or_b')
      && !bodyVisible;
    return fireAutoReport(sessionId, session, pendingReport, 'real-idle', {
      idleEvidenceReliable,
      observationCause: cause,
      observationEvidence: evidence,
      silenceMs: evidence.silence_ms,
    });
  }

  // §3.4 / §7 items 4 and 5: the entrances that used to produce nothing. Each emits IMMEDIATELY
  // (no settle debounce) because there is no ambiguity to settle — a waiting pattern matched, or
  // an error fingerprint repeated, or a thinking classification timed out. Each keeps its own
  // name and its own fields, and each carries completion_fact:null. A repeated-error entrance is
  // NOT the same measurement as a thinking timeout, and neither is a task failure.
  if (to === 'waiting' || to === 'error' || to === 'restarting' || to === 'starting') {
    return recordObservation({
      sessionId, session, pendingReport, destination: to, cause, evidence,
      deliverToSource: to === 'waiting' || to === 'error', trigger: 'transition',
    });
  }

  if (to === 'dead') {
    // The pending entry is released, but the ledger record is NOT: it stays queryable so a poll
    // after the process is gone still gets a named observation instead of a 404.
    delete pendingReports[sessionId];
    return recordObservation({
      // #843 — no `|| 'process_exit'` fallback. A transition that arrived at `dead` without a
      // measured cause is not evidence of a process exit; substituting the strongest name in the
      // table for a missing measurement is the defect this release removes, in one line. With no
      // cause the mapper fails closed to `unmapped_transition_cause`, which is the honest answer.
      sessionId, session, pendingReport, destination: 'dead', cause,
      evidence: { ...evidence, auto_summary: buildAutoSummaryWithDefaults(session) },
      deliverToSource: true, trigger: 'transition',
    });
  }

  return recordObservation({ sessionId, session, pendingReport, destination: to, cause, evidence, trigger: 'transition' });
});

function persistSessions() {
  sessionPersistence.savePersistedSessions(sessions, SESSION_PERSIST_PATH);
}

function loadPersistedSessions() {
  return sessionPersistence.loadPersistedSessions(SESSION_PERSIST_PATH);
}

const app = express();
app.use(cors());

app.use(express.json());

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

// Mint the credential + nonce for a NEW instance of `sid`. The bearer and nonce it returns are
// handed to exactly one caller, exactly once, and are never recoverable afterwards.
function issueSessionCredential(sid) {
  const credential = sessionCredentials.issue(sid);
  const nonce = mintSessionNonce();
  sidNonces.set(sid, nonce);
  return { ...credential, nonce };
}

// Called from EVERY destroy path before the id can be reused.
function revokeSessionCredential(sid) {
  sessionCredentials.revoke(sid);
  sidNonces.delete(sid);
}

// Resolve the presented bearer to the full principal (header only — never the body, which is
// attacker-controlled). Fail closed: unparseable, unknown, stale or revoked yields null, never a
// fallback to the name the caller claimed.
function verifiedPrincipalFromReq(req) {
  const bearer = req.headers && req.headers['x-telepty-session-token'];
  if (!bearer) return null;
  return sessionCredentials.verify(bearer);
}
// Back-compat shorthand for the call sites that only need the sid half of the principal.
function verifiedSenderFromReq(req) {
  const principal = verifiedPrincipalFromReq(req);
  return principal ? principal.sid : null;
}
// The three audit/bus fields for a principal, emitted TOGETHER so a consumer never sees a
// verified sid beside a null epoch — that combination would read as "verified, instance unknown",
// which is not a state this daemon can be in. All three are null, or all three are set.
function verifiedSenderFields(principal) {
  return {
    verified_sender_sid: principal ? principal.sid : null,
    verified_sender_epoch: principal ? principal.epoch : null,
    verified_sender_generation: principal ? principal.generation : null
  };
}

// JWT auth: set TELEPTY_JWT_SECRET to enable. Tokens in Authorization: Bearer <token>
const JWT_SECRET = process.env.TELEPTY_JWT_SECRET || null;

const verifyJwt = createVerifyJwt(JWT_SECRET);
const isAllowedPeer = createIsAllowedPeer(effectivePeerAllowlist);
// One guard instance shared by the HTTP middleware and the WS upgrade handler — the two
// entrances a browser can reach.
const isForbiddenOrigin = createOriginGuard(ALLOWED_ORIGINS);

// Health check – no auth required
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: pkg.version });
});

// Authentication Middleware
app.use(createAuthMiddleware({ isAllowedPeer, expectedToken: EXPECTED_TOKEN, verifyJwt, isForbiddenOrigin }));

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

function commitTrackedInjections() {
  return sessionPersistence.saveTrackedInjections(trackedInjections, TRACKED_INJECTIONS_PATH);
}

// Restore BEFORE HTTP/WS readiness. A restored record gets `daemon_restart_observed` appended: a
// dispatch that was in flight across a restart is still explicitly unknown, and a missing record
// can never settle, delete or suspend it.
function restoreTrackedInjections() {
  const loaded = sessionPersistence.loadTrackedInjections(TRACKED_INJECTIONS_PATH);
  if (!loaded.ok) {
    trackedLedgerHealthy = false;
    trackedLedgerUnavailableReason = loaded.reason;
    console.warn(`[OBSERVE] tracked-injection store unavailable (${loaded.reason}${loaded.detail ? `: ${loaded.detail}` : ''}) — every poll answers tracking_state=unavailable`);
    return;
  }
  trackedInjections = loaded.ledger;
  const nowIso = new Date().toISOString();
  let restored = 0;
  for (const record of Object.values(trackedInjections.injections)) {
    sessionPersistence.appendLedgerObservation(record, { kind: 'daemon_restart_observed', trigger: 'daemon_restart' }, nowIso);
    restored++;
  }
  if (restored > 0) {
    commitTrackedInjections();
    console.log(`[OBSERVE] restored ${restored} tracked injection(s) — all still completion-unknown`);
  }
}

function getTrackedInjection(injectId) {
  if (typeof injectId !== 'string' || !injectId) return null;
  if (injectId === '__proto__' || injectId === 'prototype' || injectId === 'constructor') return null;
  const store = trackedInjections.injections;
  if (!Object.prototype.hasOwnProperty.call(store, injectId)) return null;
  return store[injectId];
}

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
function sessionAuthenticationCapability(session) {
  if (!session || !session.sessionEpoch) return {};
  if (session.sessionEpochProved && session.sessionEpochProved === session.sessionEpoch) {
    return { session_authentication: 'observed', session_authentication_reason: null };
  }
  return { session_authentication: 'unavailable', session_authentication_reason: 'no_815_bearer_presented' };
}

/**
 * Create the durable transport-observation record for a tracked inject. MUST complete before the
 * bytes are handed to the target (§3 Stage A item 1): a delivered task that no record answers for
 * is the silence this release exists to remove.
 *
 * Returns {ok:true, record} or {ok:false, reason} — on failure the caller must NOT deliver.
 */
function beginTrackedInjection({ injectId, sessionId, source, session }) {
  const nowIso = new Date().toISOString();
  // Supersession: a second tracked dispatch for the same session retains the OLD record and
  // appends `tracking_superseded` before the active pointer moves. The previous code only logged
  // a warning and destructively overwrote a SID-keyed entry, so the old inject_id became
  // unqueryable — and an inject_id nobody can query is indistinguishable from one that never
  // existed.
  for (const record of Object.values(trackedInjections.injections)) {
    if (record.session_id === sessionId && record.tracking_state === 'tracked') {
      record.tracking_state = 'superseded';
      sessionPersistence.appendLedgerObservation(record, {
        kind: 'tracking_superseded', trigger: 'superseded_by_new_tracked_inject', superseded_by: injectId,
      }, nowIso);
    }
  }

  const record = {
    inject_id: injectId,
    session_id: sessionId,
    // #815 gives an epoch only where a session actually proved one. Stage A records the absence
    // with a reason rather than inventing availability from a bare SID or an open socket.
    session_epoch: (session && session.sessionEpoch) || null,
    session_epoch_reason: (session && session.sessionEpoch) ? null : 'no_815_epoch_fact',
    transport_source: source || null,
    created_at: nowIso,
    observation_seq: 0,
    observations: [],
    last_observation: null,
    // #843 — the capability block must not contradict the record it is stamped on.
    // `CAPABILITY_STAGE_A` is frozen with `session_authentication_reason: 'no_815_epoch_fact'` and
    // was spread onto EVERY record, including records whose own `session_epoch` two lines up holds
    // the epoch the session PROVED on its #815 handshake. One response body then carried both the
    // epoch and a reason denying any epoch fact was measured, leaving a reader to pick which half
    // of one object to believe. §A4 requires gaps to be explicit; it does not license reporting a
    // gap that was measured shut. #860 F1: nor does it license the opposite — see
    // sessionAuthenticationCapability, which is what decides the three cases.
    capability: {
      ...CAPABILITY_STAGE_A,
      ...sessionAuthenticationCapability(session),
    },
    tracking_state: 'tracked',
  };
  trackedInjections.injections[injectId] = record;
  sessionPersistence.appendLedgerObservation(record, { kind: 'tracking_started', trigger: 'inject_accepted' }, nowIso);

  const committed = commitTrackedInjections();
  if (!committed.ok) {
    delete trackedInjections.injections[injectId];
    console.error(`[OBSERVE] tracking persistence FAILED for ${injectId} — refusing delivery (${committed.reason})`);
    return { ok: false, reason: 'tracking_persistence_failed' };
  }
  trackedLedgerHealthy = true;
  trackedLedgerUnavailableReason = null;
  return { ok: true, record };
}

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
function abortTrackedInjection(injectId, sessionId, deliveryCode, deliveryError, cause = {}) {
  const record = getTrackedInjection(injectId);
  if (!record) return 'tracking_unavailable';
  record.tracking_state = 'aborted';
  sessionPersistence.appendLedgerObservation(record, {
    kind: cause.kind || 'inject_delivery_refused',
    trigger: cause.trigger || 'delivery_refused',
    delivery_code: deliveryCode || 'DELIVERY_FAILED',
    delivery_error: deliveryError || null,
    // Omitting `bytesWritten` means the caller MEASURED zero (the synchronous refusal arm: the
    // route never handed a byte over). An explicit `null` means it could not measure — a throw
    // mid-drain can land on either side of the body write — and null is recorded rather than a
    // guessed zero.
    bytes_written: cause.bytesWritten === undefined ? 0 : cause.bytesWritten,
  }, new Date().toISOString());
  // The pending entry goes too. It is what makes the session look like it is awaiting a turn, and
  // it belongs to an inject whose bytes were never delivered — every later observation on this
  // session would otherwise be filed against it.
  if (sessionId && pendingReports[sessionId] && pendingReports[sessionId].injectId === injectId) {
    delete pendingReports[sessionId];
  }
  const committed = commitTrackedInjections();
  if (!committed.ok) {
    console.error(`[OBSERVE] abort commit FAILED for ${injectId} (${committed.reason})`);
    return 'tracking_persistence_failed';
  }
  return 'tracking_aborted';
}

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
function parkTrackedInjection(injectId, strategy, reason) {
  if (!injectId) return 'no_tracked_inject';
  const record = getTrackedInjection(injectId);
  if (!record) return 'tracking_unavailable';
  sessionPersistence.appendLedgerObservation(record, {
    kind: 'inject_parked',
    trigger: strategy,
    reason: reason || null,
    bytes_written: 0,
  }, new Date().toISOString());
  const committed = commitTrackedInjections();
  if (!committed.ok) {
    console.error(`[OBSERVE] park commit FAILED for ${injectId} (${committed.reason})`);
    return 'tracking_persistence_failed';
  }
  return 'tracking_parked';
}

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
function deliveryAuditResult(delivery) {
  return delivery && delivery.queued === true && delivery.strategy === 'bootstrap_queue' ? 'queued' : 'success';
}

// Observation identity. Dedup is keyed on WHAT WAS MEASURED, not on a one-way "already notified"
// bit. That distinction is the whole repair: `idleNotified` was burned by a wrong-label emission
// and then dropped the later genuine one, and because it was a single bit it could never
// distinguish "we already said this" from "we are no longer allowed to speak".
function observationIdentity(kind, cause) {
  return `${kind}|${cause == null ? '' : cause}`;
}

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
function markAbsenceDeliveredToSource(record, identity) {
  let delivered = deliveredAbsenceIdentities.get(record);
  if (!delivered) {
    delivered = new Set();
    deliveredAbsenceIdentities.set(record, delivered);
  }
  if (delivered.has(identity)) return true;
  delivered.add(identity);
  return false;
}

/**
 * THE TOTAL EMITTER. Every observation entry point routes through here, and every eligible
 * invocation RETURNS a named result — never `undefined`, never a bare `return`.
 *
 * Named results: observation_emitted · observation_duplicate · unmapped_transition_cause ·
 * tracking_superseded · tracking_unavailable · observation_deferred · tracking_persistence_failed
 */
function recordObservation({
  sessionId,
  session,
  pendingReport,
  destination,
  cause,
  evidence,
  deliverToSource = false,
  trigger,
  deps = {},
}) {
  const _broadcast = deps.broadcastSessionEvent || broadcastSessionEvent;
  const _sessions = deps.sessions || sessions;
  const _resolveAlias = deps.resolveSessionAlias || resolveSessionAlias;
  const _deliver = deps.deliverInjectionToSession || deliverInjectionToSession;
  const nowIso = new Date().toISOString();

  const mapped = mapObservationCause({ destination, cause, evidence });
  const observation = { kind: mapped.kind, trigger: mapped.cause, ...mapped.fields };
  if (trigger) observation.emitted_via = trigger;

  // #801 output marker, attached HERE rather than by widening mapObservationCause's evidence
  // whitelist. The whitelist is a contract — a name may not travel with evidence its cause row
  // did not require — and widening it would let every unrelated field leak into every row. This
  // is the one sanctioned exception, so it is made at the call site where it is visible.
  //
  // What these two fields say: a known error banner was MATCHED IN THE OUTPUT BYTES of this
  // turn, by detectIdleAfterError, scoped past the inject watermark. That is a measured fact
  // about output — the text was there. What they do NOT say, and must never be read as: that
  // the session failed, that the task failed, or that the inject went unprocessed. Those are
  // outcome claims and remain unmeasurable; this envelope still carries completion_fact:null
  // and terminal:false alongside them, and the observation's KIND is unchanged — a marker
  // cannot rename the measurement it rode in on.
  //
  // Without this, a CLI dying on a 529 and an unmeasured CLI printing the same banner emit
  // byte-identical observations: the daemon measured the difference and then discarded it,
  // which is the inverse of this release's thesis rather than an instance of it (§A4 —
  // capability gaps are reported, not erased).
  if (evidence && evidence.error_marker) {
    observation.error_marker = evidence.error_marker;
    if (evidence.error_detail) observation.error_detail = evidence.error_detail;
  }

  const injectId = pendingReport ? pendingReport.injectId : null;
  const record = injectId ? getTrackedInjection(injectId) : null;

  const consumption = pendingReport
    ? classifyConsumption(pendingReport, {
      echoObserved: deps.echoObserved === true,
      echoReason: deps.echoReason || null,
    })
    : { status: 'not_established', basis: 'no_tracked_inject' };

  // Duplicate suppression by observation identity. It suppresses the repeat NOTIFICATION; it is
  // not an authority gate, and it can never prevent a future genuine observation of a different
  // kind from being recorded.
  let result = 'observation_emitted';
  if (record) {
    const identity = observationIdentity(mapped.kind, mapped.cause);
    if (record.last_observation && observationIdentity(record.last_observation.kind, record.last_observation.trigger) === identity) {
      result = 'observation_duplicate';
    } else {
      // #843 — snapshot BEFORE the in-memory append, because the append is speculative until the
      // commit lands. Two defects rode on its absence, and they compounded:
      //   1. the failed-commit branch below used to `return` HERE, ahead of the broadcast, so a
      //      store that could not be written emitted NOTHING — no bus event, no source delivery.
      //      That is §A2 ("absence is emitted, never silence") violated inside the emitter written
      //      to enforce §A2, on the one condition an operator most needs to hear about;
      //   2. `appendLedgerObservation` had already moved `last_observation`, so the identity dedup
      //      then suppressed every RETRY of that same measurement as a duplicate of an append that
      //      never reached disk. The first attempt was silent and it silenced all the rest.
      // The rollback is what makes the retry meaningful; falling through to the broadcast is what
      // makes the failure audible. Neither alone is enough.
      const priorSeq = record.observation_seq;
      const priorLast = record.last_observation;
      const priorObservations = Array.isArray(record.observations) ? record.observations.slice() : [];
      const priorCapability = record.capability;
      sessionPersistence.appendLedgerObservation(record, { ...observation, consumption_status: consumption.status }, nowIso);
      record.capability = { ...CAPABILITY_STAGE_A, ...(record.capability || {}) };
      const committed = commitTrackedInjections();
      if (!committed.ok) {
        record.observation_seq = priorSeq;
        record.last_observation = priorLast;
        record.observations = priorObservations;
        record.capability = priorCapability;
        result = 'tracking_persistence_failed';
        console.error(`[OBSERVE] ledger commit FAILED for ${injectId} (${committed.reason}) — `
          + `${observation.kind} was emitted on the bus but is NOT durable`);
      } else if (record.tracking_state === 'superseded') {
        result = 'tracking_superseded';
      }
    }
  } else if (injectId) {
    // A tracked inject whose record we cannot find (pre-v2, another daemon epoch, corrupt store).
    // Explicit, named, never silence.
    result = 'tracking_unavailable';
  }

  if (mapped.kind === 'unmapped_transition_cause') result = 'unmapped_transition_cause';

  const envelope = buildCompletionUnknown({
    sessionId,
    injectId,
    observation,
    consumption,
    capability: record ? record.capability : CAPABILITY_STAGE_A,
    observationSeq: record ? record.observation_seq : undefined,
  });

  // The bus always hears the absence, even when the ledger deduped or is unavailable — a
  // subscriber must never have to infer from silence.
  _broadcast('task_completion_unknown', sessionId, session, {
    timestamp: nowIso,
    extra: { ...envelope, tracking_result: result, source: pendingReport ? pendingReport.source : null },
  });

  if (deliverToSource && pendingReport && result !== 'observation_duplicate') {
    // #914: the source hears each DISTINCT absence once per inject. The bus above is
    // unconditional and the ledger below already recorded this observation — only the
    // notification is suppressed, and only for an identity this inject already sent.
    if (record && markAbsenceDeliveredToSource(record, observationIdentity(mapped.kind, mapped.cause))) {
      console.log(`[OBSERVE] ${sessionId}: ${observation.kind} already delivered for ${injectId} — not re-notifying source`);
      return result;
    }
    const srcId = _resolveAlias(pendingReport.source) || pendingReport.source;
    const srcSession = _sessions[srcId];
    if (srcSession) {
      _deliver(srcId, srcSession, formatCompletionUnknownText(envelope), { noEnter: false, source: 'auto_report' });
      console.log(`[OBSERVE] ${sessionId} → ${srcId}: ${observation.kind} (${result}, via ${trigger || mapped.cause})`);
    }
  }
  return result;
}

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
function maybeRecordInjectConsumption(pendingReport, fromState, toState, transitionSinceMs) {
  if (!pendingReport || pendingReport.injectConsumptionCandidate) return false;
  const candidate = {
    from: fromState,
    to: toState,
    sinceMs: transitionSinceMs,
    at: Number.isFinite(transitionSinceMs) ? new Date(transitionSinceMs).toISOString() : null,
  };
  if (!completionObservation.isFreshBusyEdge(candidate, pendingReport.submitStartedAt)) return false;
  pendingReport.injectConsumptionCandidate = candidate;
  return true;
}

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
function maybeRecordLauncherConsumption(session, pendingReport, elapsedSinceInjectSec, nowMs) {
  if (!pendingReport || pendingReport.launcherWatermarkAt) return false;
  if (!session || session.type !== 'wrapped') return false;
  if (!pendingReport.submitExpected || !pendingReport.submitStartedAt) return false;
  const confirm = pendingReport.submitConfirm;
  if (!(confirm && confirm.accepted === true)) return false;
  const ringNow = Number.isFinite(session.outputRingTotalBytes) ? session.outputRingTotalBytes : 0;
  const ringAtInject = Number.isFinite(pendingReport.ringBytesAtInject) ? pendingReport.ringBytesAtInject : 0;
  if (ringNow <= ringAtInject) return false;
  if (!(elapsedSinceInjectSec >= LAUNCHER_CONSUMPTION_MIN_SECONDS)) return false;
  pendingReport.launcherWatermarkAt = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();
  pendingReport.launcherRingBytesDelta = ringNow - ringAtInject;
  pendingReport.launcherElapsedMs = Math.round(elapsedSinceInjectSec * 1000);
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
// #60 Stage A: `observeConsumptionEvidence` is GONE. It was a GATE — its caller used it to decide
// whether to stay silent (daemon.js:803-810, a bare `return` that emitted nothing and set
// nothing). Consumption is now a FIELD on the observation, computed by
// src/completion-observation.js#classifyConsumption, which is total and has rejection precedence.
// This helper only gathers the one piece of evidence that needs the session's output ring.
function observeInjectEchoEvidence(pendingReport, session) {
  const echo = submitGate.observeInjectEcho(session, pendingReport.injectedBodyPreview, {
    sinceBytes: Number.isFinite(pendingReport.ringBytesAtInject) ? pendingReport.ringBytesAtInject : null,
    stripAnsi: stripAnsiState,
  });
  return { observed: echo.observed === true, reason: echo.reason };
}

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
function detectIdleAfterError(session, pendingReport) {
  if (!session || !pendingReport) return null;
  if (!Array.isArray(session.outputRing) || session.outputRing.length === 0) return null;
  if (!Number.isFinite(session.outputRingTotalBytes)) return null;
  if (!Number.isFinite(pendingReport.ringBytesAtInject)) return null;
  const appended = Math.max(0, session.outputRingTotalBytes - pendingReport.ringBytesAtInject);
  if (appended === 0) return null;
  const all = session.outputRing.join('');
  const verdict = readyRegistry.detectSurfaceError(session.command, all.slice(Math.max(0, all.length - appended)));
  return verdict.errored === true ? verdict : null;
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
function fireAutoReport(targetId, targetSession, pendingReport, trigger, deps = {}) {
  const _now = deps.now || Date.now;
  const _setTimeout = deps.setTimeout || setTimeout;
  const _sessions = deps.sessions || sessions;
  const _pendingReports = deps.pendingReports || pendingReports;
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
  const liveSession = () => _sessions[targetId] || targetSession;

  // Resolve the measured cause for this entrance. The caller passes the state machine's own
  // normalized cause where it has one (deps.observationCause); otherwise the trigger names it.
  // Nothing here infers a cause from the destination state.
  const resolveCause = () => {
    if (deps.observationCause) return deps.observationCause;
    if (trigger === 'ready-signal') {
      const sess = liveSession();
      const kind = sess && sess.readyKind ? sess.readyKind : 'legacy_unqualified_ready';
      if (kind === 'composer_surface_observed') return 'ready_frame_composer_surface';
      if (kind === 'prompt_suffix_observed') return 'ready_frame_prompt_suffix';
      return 'ready_frame_legacy_unqualified';
    }
    return 'silence_timeout';
  };

  const emit = (extraEvidence = {}, extraDeps = {}) => {
    const sess = liveSession();
    const cause = resolveCause();
    const evidence = {
      elapsed_ms: Math.round(elapsedNum * 1000),
      silence_ms: Number.isFinite(deps.silenceMs) ? deps.silenceMs : Math.round(elapsedNum * 1000),
      ...(deps.observationEvidence || {}),
      ...extraEvidence,
    };
    if (cause.startsWith('ready_frame_')) {
      evidence.detector = (sess && sess.readyDetector) || 'unqualified';
      evidence.cli_key = (sess && sess.readyCliKey) || null;
    }
    // #545 reliability is no longer a promotion input — nothing here promotes. It is computed and
    // then DELIBERATELY NOT CARRIED on the emitted observation: §2.3 fixes each row's payload to
    // the fields that row requires, plus last_output_at and confidence, and mapObservationCause
    // drops everything else. Do not read the assignment below as "it becomes a field" — an earlier
    // version of this comment claimed exactly that, and the claim was false, which is the same
    // defect this release exists to remove.
    //
    // It stays computed because it is a real input to the local decisions above and is useful in
    // the log line, and because OSC 133 has never fired on real traffic (zero hits across 9 live
    // PTY captures and 15 fixtures) — so as an emitted field it would be permanently false, which
    // is noise rather than information.
    //
    // #801's surface-error verdict is the deliberate exception and IS carried; see recordObservation,
    // where it is attached explicitly rather than by widening the §2.3 whitelist. Neither signal may
    // change the observation's NAME — that is fixed by the measured cause.
    if (deps.idleEvidenceReliable !== undefined) evidence.idle_evidence_reliable = deps.idleEvidenceReliable;
    const _detectIdleAfterError = deps.detectIdleAfterError || detectIdleAfterError;
    const errorVerdict = _detectIdleAfterError(sess, pendingReport);
    if (errorVerdict) {
      evidence.error_marker = errorVerdict.reason;
      evidence.error_detail = errorVerdict.detail;
    }
    const echo = sess ? observeInjectEchoEvidence(pendingReport, sess) : { observed: false, reason: null };
    return recordObservation({
      sessionId: targetId,
      session: sess,
      pendingReport,
      destination: 'idle',
      cause,
      evidence,
      deliverToSource: true,
      trigger,
      deps: { ...deps, echoObserved: echo.observed, echoReason: echo.reason, ...extraDeps },
    });
  };

  // --- ready-signal dwell (#32): wait for the submit verdict before speaking ---------------
  if (trigger === 'ready-signal' && pendingReport.submitExpected) {
    if (pendingReportHasSubmitEvidence(pendingReport)) {
      // Submit already answered — the ready frame adds no new measurement. Named, not silent.
      return 'observation_duplicate';
    }
    const shouldWaitForSubmit = pendingReport.submitInProgress === true || elapsedNum < AUTO_REPORT_MIN_REAL_SECONDS;
    if (shouldWaitForSubmit) {
      if (!pendingReport.readySignalTimer) {
        const floorDelayMs = Math.max(50, Math.ceil((AUTO_REPORT_MIN_REAL_SECONDS - elapsedNum) * 1000));
        const delayMs = pendingReport.submitInProgress === true ? Math.min(250, Math.max(50, floorDelayMs)) : floorDelayMs;
        pendingReport.readySignalTimer = _setTimeout(() => {
          pendingReport.readySignalTimer = null;
          const currentPending = getPendingReport(targetId, _pendingReports);
          if (!currentPending) return;
          fireAutoReport(targetId, liveSession(), currentPending, 'ready-signal', deps);
        }, delayMs);
      }
      console.log(`[OBSERVE] ${targetId} ready-frame observation deferred; awaiting submit verdict`);
      return 'observation_deferred';
    }
  }

  // --- #721 launcher watermark: telemetry only, never consumption --------------------------
  if (trigger === 'real-idle') {
    maybeRecordLauncherConsumption(liveSession(), pendingReport, elapsedNum, _now());
  }

  // --- #48/#52 settle debounce (follow-ups only; the initial unknown is already durable) ---
  if (!pendingReport.unconfirmedSettleDone) {
    if (pendingReport.unconfirmedSettleTimer) return 'observation_deferred'; // window already open
    const settleMs = Math.max(50, Math.round(IDLE_UNCONFIRMED_SETTLE_SECONDS * 1000));
    const armSettle = () => {
      const liveAtArm = liveSession();
      const activityAtArm = liveAtArm ? liveAtArm.lastActivityAt : null;
      const cpuAtArm = _sampleChildCpu(liveAtArm); // #52: null when unobservable
      pendingReport.unconfirmedSettleTimer = _setTimeout(() => {
        pendingReport.unconfirmedSettleTimer = null;
        const currentPending = getPendingReport(targetId, _pendingReports);
        if (currentPending !== pendingReport) return;
        const autoState = _getAutoState(targetId);
        if (autoState === 'working' || autoState === 'thinking') {
          // Still busy: the quiet we were about to describe is gone. Nothing to state.
          console.log(`[OBSERVE] ${targetId} quiet observation dropped after settle — session is ${autoState}`);
          return;
        }
        const activityNow = liveSession() ? liveSession().lastActivityAt : null;
        if (activityNow !== activityAtArm
            && (pendingReport.unconfirmedSettleRearms || 0) < IDLE_UNCONFIRMED_SETTLE_MAX_REARMS) {
          pendingReport.unconfirmedSettleRearms = (pendingReport.unconfirmedSettleRearms || 0) + 1;
          armSettle();
          return;
        }
        const cpuNow = _sampleChildCpu(liveSession());
        if (cpuAtArm != null && cpuNow != null
            && (cpuNow - cpuAtArm) >= IDLE_UNCONFIRMED_CPU_DELTA_SECONDS
            && (pendingReport.unconfirmedCpuRearms || 0) < IDLE_UNCONFIRMED_CPU_MAX_REARMS) {
          pendingReport.unconfirmedCpuRearms = (pendingReport.unconfirmedCpuRearms || 0) + 1;
          armSettle();
          return;
        }
        pendingReport.unconfirmedSettleDone = true;
        fireAutoReport(targetId, liveSession() || targetSession, currentPending, trigger, deps);
      }, settleMs);
    };
    armSettle();
    console.log(`[OBSERVE] ${targetId} quiet at ${elapsed}s (trigger=${trigger}) — settling ${IDLE_UNCONFIRMED_SETTLE_SECONDS}s before the follow-up observation`);
    return 'observation_deferred';
  }

  // --- emit. Consumption is a FIELD here, never a gate. -----------------------------------
  return emit();
}

const sessions = {};
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

// #732 — upstream-liveness probe. The daemon already keeps a monotonic upstream-only byte
// counter (`outputRingTotalBytes`, stamped in appendToOutputRing and nothing else). Arming a
// probe records "at this instant I wrote downstream, and the counter stood here"; if the
// counter has not moved since, not one byte has come back from the PTY.
//
// The probe is armed only when no UNANSWERED probe is already aging — otherwise a stream of
// injects would keep resetting the clock and a dead pipe would never trip the threshold.
// It self-clears: any upstream byte pushes the counter past the watermark.
function armUpstreamProbe(session, nowMs = Date.now()) {
  if (!session || session.type !== 'wrapped') return;
  const watermark = session.outputRingTotalBytes || 0;
  // `!= null`, not falsiness: a probe armed at epoch 0 is a real probe.
  if (session.upstreamProbeAt != null && watermark <= (session.upstreamProbeWatermark || 0)) {
    return;
  }
  session.upstreamProbeAt = nowMs;
  session.upstreamProbeWatermark = watermark;
}

// Pure predicate — exported for unit testing. "Socket alive but pipe dead."
function isUpstreamStalled(session, nowMs = Date.now(), options = {}) {
  if (!session || session.type !== 'wrapped') return false;
  if (session.upstreamProbeAt == null) return false;
  if ((session.outputRingTotalBytes || 0) > (session.upstreamProbeWatermark || 0)) return false;
  const stallMs = (options.stallSeconds ?? UPSTREAM_STALL_SECONDS) * 1000;
  return nowMs - session.upstreamProbeAt >= stallMs;
}

function getSessionHealthStatus(session, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const staleMs = (options.staleSeconds ?? SESSION_STALE_SECONDS) * 1000;
  const disconnectedMs = getSessionDisconnectedMs(session, nowMs);

  if (session.type === 'wrapped') {
    if (isOpenWebSocket(session.ownerWs)) {
      // #732: an open owner socket is necessary, not sufficient. A session that has
      // returned nothing since we last wrote to it is unobservable, not healthy.
      return isUpstreamStalled(session, nowMs, options) ? 'UPSTREAM_STALLED' : 'CONNECTED';
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
    // #732: the owner socket is open and answering pings; the output pipe behind it is not.
    if (healthStatus === 'UPSTREAM_STALLED') return 'OWNER_CONNECTED_UPSTREAM_STALLED';
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
  // #760: this is the ONLY inject path that wrote the body un-enveloped — the mailbox path
  // has wrapped it since #716/#730, and #730 measured that the un-enveloped MULTI-LINE shape
  // is exactly what swallows the following CR (still 1/7 at a 127ms gap; the envelope was
  // 0/9). Harmless while this queue only carried boot-time injects; load-bearing now that a
  // modal park routes worker REPORTs — multi-line by definition — through it. Fixed here
  // rather than in the park branch so the boot caller stops rolling the same dice.
  const body = maybeBracketedPaste(prompt, session);
  const textResult = await writeDataToSession(sessionId, session, body);
  // #860 F2 — a failure here is reported back with the byte count that actually landed, because
  // the caller records it in the ledger. The two arms differ: nothing was written when the BODY
  // was refused, but the body is on the surface by the time the submit CR can fail, and an abort
  // that stamped `bytes_written: 0` on that one would be the same defect it exists to close.
  if (!textResult.success) return { ...textResult, bytes_written: 0 };

  if (!op.noEnter) {
    await sleep(WRAPPED_SUBMIT_DELAY_MS);
    const submitResult = await writeDataToSession(sessionId, session, '\r');
    if (!submitResult.success) return { ...submitResult, bytes_written: Buffer.byteLength(body) };
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
      // #760: the drain writes straight to the surface (executeBootstrapInject /
      // executeBootstrapSubmit), so it has to ask the modal gate itself — markBootstrapReady
      // reaches it without ever consulting one. Checked BEFORE the shift so the op stays
      // parked rather than being consumed into a modal, and re-armed so the park poll picks
      // it up again. Also covers a modal that appears part-way through a drain.
      //
      // Asked through modalDeliveryDecision, not the raw predicate, so that
      // TELEPTY_MODAL_REMEDY=off stays a COMPLETE rollback: with the gate off the drain
      // writes into the modal exactly as it did before this change.
      if (modalDeliveryDecision(session).action !== 'deliver') {
        scheduleModalParkDrain(sessionId, session);
        break;
      }
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
            // #860 F2 — and durably. The event above is push-only; this is a TERMINAL outcome for
            // a dispatch whose record has said `tracked` since the route accepted it.
            abortTrackedInjection(op.injectId, sessionId, result.code || 'DELIVERY_FAILED', result.error, {
              trigger: 'bootstrap_queue_failed',
              bytesWritten: result.bytes_written,
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
        // #860 F2 — the same terminal outcome as the arm above, reached by a throw. `bytesWritten:
        // null` because a throw can land on either side of the body write, and this is the one
        // path that cannot say which.
        abortTrackedInjection(op.injectId, sessionId, 'BOOTSTRAP_DRAIN_FAILED', error.message || 'bootstrap drain failed', {
          trigger: 'bootstrap_drain_failed',
          bytesWritten: null,
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
    // #860 F2 — DROPPED, not refused: this op was accepted, parked, and discarded without the
    // daemon ever attempting a write. Zero bytes is a measurement here, not an assumption.
    abortTrackedInjection(op.injectId, sessionId, 'BOOTSTRAP_READY_TIMEOUT',
      `target '${sessionId}' not ready within ${BOOTSTRAP_READY_TIMEOUT_MS}ms`,
      { kind: 'inject_delivery_dropped', trigger: 'bootstrap_ready_timeout' });
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
    // #732 upstream diagnosis. `upstream_silent_seconds` counts from the oldest delivery
    // that has not produced a single byte back. The bridge_* fields come from the bridge's
    // own heartbeat and split the two failure shapes apart: a heartbeat that keeps arriving
    // while `bridge_pty_bytes` is frozen means the PTY read side died inside the bridge; a
    // heartbeat that stopped means the bridge→daemon leg itself is gone.
    upstream_silent_seconds: session.upstreamProbeAt != null && (session.outputRingTotalBytes || 0) <= (session.upstreamProbeWatermark || 0)
      ? Math.floor((nowMs - session.upstreamProbeAt) / 1000)
      : null,
    upstream_bytes: session.outputRingTotalBytes || 0,
    bridge_heartbeat_at: session.bridgeHeartbeatAt || null,
    bridge_pty_bytes: session.bridgePtyBytes ?? null,
    bridge_read_side: session.bridgeReadSide || null,
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
  // #732: bytes would physically reach the PTY, but nothing the session produces can be
  // read back — every reply, echo and REPORT would be invisible. Reporting that as a plain
  // success is what kept the live incident undetected for ~9h, so fail it loudly instead.
  if (healthStatus === 'UPSTREAM_STALLED') {
    return {
      httpStatus: 503,
      code: 'UPSTREAM_STALLED',
      error: 'Session output pipe is dead: the owner is connected but has returned no output since the last delivery.'
    };
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
    // #732: every wrapped delivery doubles as an upstream probe — a live PTY answers with
    // at least an echo. See armUpstreamProbe (no-op while an earlier probe is unanswered).
    armUpstreamProbe(session);
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
function isTerminalGateFailure(gateResult) {
  return !!(
    gateResult &&
    gateResult.ready !== true &&
    gateResult.reason &&
    !NON_TERMINAL_GATE_REASONS.has(gateResult.reason)
  );
}

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
function maybeBracketedPaste(text, session) {
  if (!text) return text;
  if (!session) return text;
  const capable = session.bracketedPasteCapable === undefined
    ? readyRegistry.isPasteCapableCli(session.command)
    : session.bracketedPasteCapable;
  if (!capable) return text;
  return BRACKETED_PASTE_START + text + BRACKETED_PASTE_END;
}

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
function forceSubmitCrGapMs(injectedBody, session, env = process.env) {
  if (!injectedBody || !injectedBody.includes('\n')) return 0;
  if (maybeBracketedPaste(injectedBody, session) !== injectedBody) return 0; // enveloped → immune
  // An UNSET or blank var must fall back to the default, never to 0 — `Number('')` is 0,
  // so a bare `TELEPTY_FORCE_CR_GAP_MS=` in an env file would silently disable the floor.
  const raw = String(env.TELEPTY_FORCE_CR_GAP_MS ?? '').trim();
  if (!raw) return FORCE_CR_GAP_DEFAULT_MS;
  const configured = Number(raw);
  return Number.isFinite(configured) && configured >= 0 ? configured : FORCE_CR_GAP_DEFAULT_MS;
}

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
function readOutputRingTail(session, maxBytes = MODAL_RING_TAIL_BYTES) {
  if (!session || !Array.isArray(session.outputRing) || session.outputRing.length === 0) return '';
  let total = 0;
  const parts = [];
  for (let i = session.outputRing.length - 1; i >= 0 && total < maxBytes; i--) {
    parts.unshift(session.outputRing[i]);
    total += session.outputRing[i].length;
  }
  return parts.join('');
}

// FAIL-OPEN by construction: no ring, no codex, or no modal evidence => false => deliver,
// byte-identical to pre-#737. The force path is production orchestrator dispatch, so a false
// positive here would stall every dispatch; only positive modal evidence may block.
function isSurfaceBlockedByModal(session) {
  if (!session) return false;
  const tail = readOutputRingTail(session);
  if (!tail) return false;
  return readyRegistry.detectSurfaceModal(session.command, tail).blocked === true;
}

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
function modalRemedy(env = process.env, session = null) {
  const raw = String(env.TELEPTY_MODAL_REMEDY ?? '').trim().toLowerCase();
  if (MODAL_REMEDIES.has(raw)) return raw;
  const cli = session ? readyRegistry.commandKey(session.command) : null;
  return MODAL_REMEDY_BY_CLI[cli] || MODAL_REMEDY_DEFAULT;
}

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
function modalDeliveryDecision(session, options = {}, env = process.env) {
  const remedy = modalRemedy(env, session);
  if (remedy === 'off') return { action: 'deliver', reason: 'modal_gate_off' };
  if (!isSurfaceBlockedByModal(session)) return { action: 'deliver', reason: 'surface_clear' };
  const cli = readyRegistry.commandKey(session && session.command) || 'codex';
  return {
    action: remedy,
    reason: `${cli}_modal_ui`,
    path: options.force === true ? 'force' : 'gated',
    hint: MODAL_HINT_BY_CLI[cli] || MODAL_HINT_BY_CLI.codex,
  };
}

// A's bound. The modal does NOT clear by itself — it needs a keystroke from whoever owns
// the surface — so the hold must expire into C rather than wait forever. 30s mirrors
// BOOTSTRAP_READY_TIMEOUT_MS, the existing "how long we wait for a surface to become
// injectable" budget. Only ever paid when a modal is genuinely up.
const MODAL_HOLD_DEFAULT_MS = 30000;
function modalHoldMs(env = process.env) {
  // An UNSET or blank var must fall back to the default, never to 0 — `Number('')` is 0,
  // so a bare `TELEPTY_MODAL_HOLD_MS=` in an env file would silently disable the hold.
  const raw = String(env.TELEPTY_MODAL_HOLD_MS ?? '').trim();
  if (!raw) return MODAL_HOLD_DEFAULT_MS;
  const configured = Number(raw);
  return Number.isFinite(configured) && configured >= 0 ? configured : MODAL_HOLD_DEFAULT_MS;
}

// Park until the surface leaves the modal. Polls the same fail-open predicate, so a
// surface that was never modal returns immediately with waited_ms 0.
async function awaitSurfaceModalClear(session, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : modalHoldMs();
  const pollIntervalMs = Number.isFinite(opts.pollIntervalMs) ? opts.pollIntervalMs : 150;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const sleepFn = typeof opts.sleep === 'function' ? opts.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const start = now();
  while (isSurfaceBlockedByModal(session)) {
    if (now() - start >= timeoutMs) return { cleared: false, waited_ms: now() - start };
    await sleepFn(pollIntervalMs);
  }
  return { cleared: true, waited_ms: now() - start };
}

// The single gate every write path awaits. Resolves to null when the write may proceed, or
// to a rejection decision when it must not. `hold` degrades to `reject` on timeout — that
// is the approved A-with-C-as-its-timeout-branch shape, in one place so force, gated and
// plain cannot drift apart.
async function resolveModalGate(id, session, options = {}, holdOpts = {}) {
  const decision = modalDeliveryDecision(session, options);
  if (decision.action === 'deliver') return null;
  if (decision.action !== 'hold') return decision;
  const held = await awaitSurfaceModalClear(session, holdOpts);
  if (held.cleared) {
    console.log(`[MODAL] ${id} surface cleared after ${held.waited_ms}ms — delivering`);
    return null;
  }
  console.log(`[MODAL] ${id} still modal after ${held.waited_ms}ms — refusing (hold timed out)`);
  return { ...decision, action: 'reject', held_ms: held.waited_ms };
}

function modalRejectionResponse(decision) {
  return {
    error: `${decision.reason} — delivery refused: ${decision.hint}`,
    reason: decision.reason,
    code: 'SURFACE_MODAL',
    hint: decision.hint,
  };
}

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
function modalParkTtlMs(env = process.env) {
  // An UNSET or blank var must fall back to the default, never to 0 — `Number('')` is 0, so
  // a bare `TELEPTY_MODAL_PARK_TTL_MS=` in an env file would silently disable the park.
  const raw = String(env.TELEPTY_MODAL_PARK_TTL_MS ?? '').trim();
  if (!raw) return MODAL_PARK_TTL_DEFAULT_MS;
  const configured = Number(raw);
  return Number.isFinite(configured) && configured > 0 ? configured : MODAL_PARK_TTL_DEFAULT_MS;
}

// Mirrors failBootstrapQueueOnTimeout: a park that outlives its TTL must surface an
// ACTIONABLE event and flush, never accumulate silently. Silence is the #760 bug itself.
function flushModalParkQueue(sessionId, session, waitedMs) {
  const queued = Array.isArray(session.bootstrapQueue) ? session.bootstrapQueue.length : 0;
  if (queued === 0) return 0;
  const drained = session.bootstrapQueue.splice(0, queued);
  for (const op of drained) {
    if (op.type === 'submit') {
      resolveBootstrapSubmit(op, {
        status: 504,
        body: {
          error: 'Submit parked behind a surface modal that never cleared',
          reason: 'surface_modal_park_timeout',
          strategy: 'none', attempts: 0, gated: true, bootstrap_queued: true, bootstrap_op_id: op.op_id,
        },
      });
    }
    // #860 F2 — the third terminal path. A submit op answers its caller on the open HTTP request
    // above; an inject op's caller left long ago, and the ledger is the only thing that can still
    // tell it the body never reached the surface.
    abortTrackedInjection(op.injectId, sessionId, 'SURFACE_MODAL_PARK_TIMEOUT',
      `parked behind a surface modal that did not clear within ${waitedMs}ms`,
      { kind: 'inject_delivery_dropped', trigger: 'surface_modal_park_timeout' });
  }
  emitBootstrapEvent('modal_park_timeout', sessionId, session, {
    actionable: true,
    queued_dropped: queued,
    waited_ms: waitedMs,
    hint: `Session '${sessionId}' has been showing a blocking modal for ${Math.round(waitedMs / 1000)}s — `
      + `${queued} parked inject(s) were flushed. Answer or dismiss the prompt on the surface, then re-inject.`,
  });
  console.log(`[MODAL] ${sessionId} park TTL expired after ${waitedMs}ms — flushed ${queued} op(s)`);
  return queued;
}

// Awaitable form: poll until the surface clears (then drain in order) or the TTL expires
// (then flush). Same fail-open predicate as the hold, so a surface that was never modal
// returns immediately having paid nothing.
async function awaitModalParkDrain(sessionId, session, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : modalParkTtlMs();
  const pollIntervalMs = Number.isFinite(opts.pollIntervalMs) ? opts.pollIntervalMs : MODAL_PARK_POLL_MS;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const sleepFn = typeof opts.sleep === 'function' ? opts.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  cancelModalParkPoll(session);   // this call supersedes any background poll
  const start = now();
  while (isSurfaceBlockedByModal(session)) {
    if (now() - start >= timeoutMs) {
      const waited = now() - start;
      return { cleared: false, waited_ms: waited, flushed: flushModalParkQueue(sessionId, session, waited) };
    }
    await sleepFn(pollIntervalMs);
  }
  const waited = now() - start;
  await drainBootstrapQueue(sessionId, session);
  return { cleared: true, waited_ms: waited, flushed: 0 };
}

function cancelModalParkPoll(session) {
  if (session && session.modalParkPoll) {
    clearTimeout(session.modalParkPoll);
    session.modalParkPoll = null;
  }
}

// Fire-and-forget form, used by the request paths: single-flight per session, and unref'd so
// a parked session can never hold the process open. Measured on real claude 2.1.220: a
// surface sitting on a modal emits ZERO bytes for as long as it is up (+0B over 45s on both
// the AskUserQuestion and ExitPlanMode captures), so there is no output event to re-arm on —
// polling is the only way to notice the clear.
function scheduleModalParkDrain(sessionId, session) {
  if (!session || session.modalParkPoll) return;
  const deadline = Date.now() + modalParkTtlMs();
  const tick = () => {
    session.modalParkPoll = null;
    if (!isSurfaceBlockedByModal(session)) {
      const depth = Array.isArray(session.bootstrapQueue) ? session.bootstrapQueue.length : 0;
      console.log(`[MODAL] ${sessionId} surface cleared — draining ${depth} parked op(s)`);
      drainBootstrapQueue(sessionId, session);
      return;
    }
    if (Date.now() >= deadline) {
      flushModalParkQueue(sessionId, session, modalParkTtlMs());
      return;
    }
    session.modalParkPoll = setTimeout(tick, MODAL_PARK_POLL_MS);
    if (session.modalParkPoll.unref) session.modalParkPoll.unref();
  };
  session.modalParkPoll = setTimeout(tick, MODAL_PARK_POLL_MS);
  if (session.modalParkPoll.unref) session.modalParkPoll.unref();
}

// Push one op onto the park and start (or keep) the poll. Returns the queued op so each
// caller can shape its own ack — inject and submit answer on different response schemas.
function parkOperationOnModal(sessionId, session, operation, decision) {
  const op = enqueueBootstrapOperation(sessionId, session, operation);
  scheduleModalParkDrain(sessionId, session);
  console.log(`[MODAL] ${sessionId} ${operation.type} parked — ${decision.reason} `
    + `(depth ${session.bootstrapQueue.length})`);
  return op;
}

function modalParkResponse(op, decision, extra = {}) {
  return bootstrapQueuedResponse(op, {
    parked: 'surface_modal',
    reason: decision.reason,
    hint: decision.hint,
    ...extra,
  });
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
      // #860 F2: the tracked record's id rides ON THE OP, because the queue is where the dispatch
      // and the ledger part company — the route returns, and whatever this queue eventually does
      // with the op is the only thing left that can answer for it.
      injectId: options.injectId || null,
      options: {
        source: options.source || 'inject',
        from: options.from || 'daemon'
      }
    });
    parkTrackedInjection(options.injectId, 'bootstrap_queue', 'bootstrap_not_ready');
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

  // #737: never write into a surface whose Enter key is wired to something other than
  // "submit my message". This is the TEXT path — bypass #4 in the evidence: it consulted
  // only the bootstrapReady boolean, which a blind timer flips without ever looking at the
  // screen (shouldApplyOwnerAliveFloor).
  const modalDecision = await resolveModalGate(id, session, options);

  // #760: ORDER. Once anything is parked for this session, everything behind it parks too —
  // including after the modal clears, until the drain has actually caught up. Without this
  // the second dispatch sees a clear surface, goes straight down the mailbox path, and
  // overtakes the first one that is still sitting in the queue mid-drain. Same guard the
  // gated /submit path already uses for the bootstrap queue.
  const parkBehindBacklog = !modalDecision
    && modalRemedy(process.env, session) === 'park'
    && (hasBootstrapBacklog(session) || session.bootstrapDraining === true);
  const injectParkDecision = modalDecision || (parkBehindBacklog
    ? { action: 'park', reason: 'modal_park_backlog', hint: 'Queued behind an inject parked by a surface modal.' }
    : null);

  if (injectParkDecision) {
    // `park` acks the queue position instead of refusing. A refusal is what makes the caller
    // re-inject, and re-injecting into a modal that is still up is how #743 turned one
    // blocked REPORT into three lost ones.
    if (injectParkDecision.action === 'park') {
      const op = parkOperationOnModal(id, session, {
        type: 'inject',
        prompt,
        noEnter: !!options.noEnter,
        injectId: options.injectId || null,     // #860 F2 — see the bootstrap-queue push above
        options: { source: options.source || 'inject', from: options.from || 'daemon' },
      }, injectParkDecision);
      parkTrackedInjection(options.injectId, 'bootstrap_queue', injectParkDecision.reason);
      session.lastActivityAt = new Date(now).toISOString();
      return modalParkResponse(op, injectParkDecision, {
        msg_id: op.op_id,
        pending: session.bootstrapQueue.length,
        submit: options.noEnter ? 'skipped' : 'queued',
      });
    }
    console.log(`[INJECT] ${id} refused — ${injectParkDecision.reason}`);
    return { success: false, httpStatus: 409, ...modalRejectionResponse(injectParkDecision) };
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

  // #716: wrap the delivered text in bracketed paste for paste-capable CLIs so the
  // deferred/gated submit CR (written separately, outside the 200~/201~ envelope)
  // reliably fires instead of being swallowed into the paste burst. No-op otherwise.
  const deliveredBody = maybeBracketedPaste(deliveredPrompt, session);

  try {
    const ack = mailbox.enqueue({
      msg_id: msgId,
      from,
      to: id,
      payload: deliveredBody,
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
    const textResult = await writeDataToSession(id, session, deliveredBody);
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
  // #716: track bracketed-paste capability from the CLI's own mode-set output so
  // injects are wrapped (maybeBracketedPaste) only for paste-capable composers —
  // codex/claude emit ESC[?2004h. Last h/l in the chunk wins.
  const bpOn = data.lastIndexOf('\x1b[?2004h');
  const bpOff = data.lastIndexOf('\x1b[?2004l');
  if (bpOn !== -1 || bpOff !== -1) session.bracketedPasteCapable = bpOn > bpOff;
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
    // #60 Stage A / §3.8 — BREAKING: `autoState.state:"idle"` is gone from the external surface.
    // It exported an internal FSM value that consumers read as "the turn is over", and the
    // sidebar rendered it as a GREEN sleeping pill, i.e. task success. What ships now is the
    // measured observation (named by cause, neutrally styled) and a SEPARATE completion block
    // whose fields are permanently null/false in 0.8.0. Consumers must read the two apart.
    activityObservation: autoState ? (() => {
      const cause = autoState.detail ? autoState.detail.trigger : null;
      const mapped = mapObservationCause({
        destination: autoState.state,
        cause,
        evidence: { ...(autoState.detail || {}), confidence: autoState.confidence },
      });
      const display = OBSERVATION_DISPLAY[mapped.kind] || OBSERVATION_DISPLAY.unmapped_transition_cause;
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
      capability: { ...CAPABILITY_STAGE_A },
    },
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

  cancelModalParkPoll(session);   // #760: a destroyed session must not keep polling its surface

  delete sessions[id];
  revokeSessionCredential(id);    // #815: kill path — the epoch dies with the instance
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
        revokeSessionCredential(currentId);   // #815: PTY exit — the instance is gone
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
    // #815: does this caller hold the session's CURRENT credential? A re-register never mints,
    // recovers or discloses credential material either way — this only decides whether the
    // caller may redirect where the session's injects are delivered (below).
    // Keyed off the RESOLVED record's own id (daemon-owned state), never the raw body string —
    // identical here since we are inside `if (sessions[session_id])`, but it keeps
    // attacker-controlled text out of the credential path entirely.
    const credentialed = sessionCredentials.matches(existing.id, req.headers['x-telepty-session-token']);
    if (command) existing.command = command;
    if (cwd) existing.cwd = cwd;
    if (backend) existing.backend = backend;
    if (cmux_workspace_id) existing.cmuxWorkspaceId = cmux_workspace_id;
    if (cmux_surface_id) existing.cmuxSurfaceId = cmux_surface_id;
    if (Object.prototype.hasOwnProperty.call(req.body, 'term_program')) existing.termProgram = term_program || null;
    if (Object.prototype.hasOwnProperty.call(req.body, 'term')) existing.term = term || null;
    if (req.body.delivery_type) existing.type = req.body.delivery_type;
    // #815: the delivery endpoint is where this session's injects are WRITTEN. An uncredentialed
    // re-register that could rewrite it would redirect a live session's traffic to an attacker —
    // the same "keyed to a name" flaw as the token disclosure, on the same endpoint. A session
    // that has no credential at all (aterm/external registrants) is unchanged: nothing to prove
    // against, so those registrations keep working exactly as before.
    const mayRedirectDelivery = credentialed || !sessionCredentials.hasCredential(existing.id);
    if (mayRedirectDelivery) {
      if (req.body.delivery_endpoint) existing.deliveryEndpoint = req.body.delivery_endpoint;
      if (req.body.delivery) {
        existing.delivery = req.body.delivery;
        if (!existing.deliveryEndpoint && req.body.delivery.address) {
          existing.deliveryEndpoint = req.body.delivery.address;
        }
      }
    } else if (req.body.delivery_endpoint || req.body.delivery) {
      console.warn(`[REGISTER] Ignored uncredentialed delivery-endpoint change for session ${session_id}`);
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
    // #678: a bridge reconnecting to an already-known session (e.g. one restored across a
    // daemon restart, or a re-`allow` of the same id) must still end up with a render-state
    // machine. register() is idempotent (returns the existing machine untouched), so this is
    // safe for the normal re-register too — and it is the ONLY thing that recreates the
    // machine for a same-id reconnect, since a daemon restart is not required to reach here.
    sessionStateManager.register(session_id);
    console.log(`[REGISTER] Re-registered session ${session_id} (type: ${existing.type}, updated metadata)`);
    // #815: NO credential material in a re-register response — not the bearer, not the nonce, not
    // even to a caller that proved it holds the current one. This was the disclosure: the branch
    // used to return `mintSessionToken(session_id)` to whoever named an already-registered id.
    // The legitimate holder does not need a copy back: the bridge carries the bearer in its env
    // (cli.js) and the child got its copy at spawn. `session_epoch` is a non-secret instance
    // discriminator — it identifies WHICH instance answered, and proves nothing on its own.
    return res.status(200).json({ session_id, type: existing.type, command: existing.command, cwd: existing.cwd, reregistered: true, session_epoch: existing.sessionEpoch || null, provenance_capable: !!existing.provenanceCapable });
  }

  const { delivery_type, delivery_endpoint, delivery } = req.body;
  const resolvedEndpoint = delivery_endpoint || (delivery && delivery.address) || null;
  // #815 — THE issuance point, and the only one. This branch runs exactly when the daemon does
  // not currently hold `session_id`, so every credential belongs to a fresh instance: a recreated
  // textual sid gets a new epoch and its predecessor's bearer can never resolve to it.
  const issued = issueSessionCredential(session_id);
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
    provenanceNonce: issued.nonce,
    // #815: the VERIFIER is what lives on the record and goes to disk — the bearer never does.
    sessionEpoch: issued.epoch,
    credentialVerifier: issued.verifier,
    credentialGeneration: issued.generation,
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

  console.log(`[REGISTER] Registered wrapped session ${session_id} (epoch: ${issued.epoch})`);
  // #815: persist the verifier BEFORE acknowledging. persistSessions() is synchronous, so once
  // this response is on the wire the credential is already durable — a daemon that dies between
  // the two can never leave a bearer in a child's env with no verifier on disk to match it.
  persistSessions();
  // The bearer and nonce cross the wire HERE and only here, once, to this one caller.
  res.status(201).json({ session_id, type: 'wrapped', command: sessionRecord.command, cwd, session_token: issued.bearer, session_epoch: issued.epoch, credential_generation: issued.generation, session_nonce: sessionRecord.provenanceNonce, provenance_capable: sessionRecord.provenanceCapable });
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
// middleware as every /api/* route (app.use(createAuthMiddleware) above), so it is 401 for ANY
// caller without the token — #820: loopback and an allowlist match are no longer credentials, so
// "open to localhost/allowlisted peers" is no longer true of this or any other route. Filters:
// since/until,
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
function rejectPeerLaneFanout(res, { from, reason, targetIds, source, verifiedSender = null, prompt = '' }) {
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
      claimed_from: from || null, ...verifiedSender,
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
    return rejectPeerLaneFanout(res, { from, reason: verdict.reason, targetIds: session_ids, source: 'multicast', verifiedSender: verifiedSenderFields(verifiedPrincipalFromReq(req)), prompt });
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
  const verifiedPrincipal = verifiedPrincipalFromReq(req);
  const verifiedSenderSid = verifiedPrincipal ? verifiedPrincipal.sid : null;
  const verifiedSender = verifiedSenderFields(verifiedPrincipal);   // #815 audit fields

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
          auditMulticastTarget(inject_id, 'multicast', from, verifiedSender, id, prompt, `failed:${delivery.code || 'DELIVERY_FAILED'}`);
          continue;
        }

        results.successful.push({ id, strategy: delivery.strategy });
        // #860 F2 — a fan-out target that parked the op wrote nothing; same three-value rule as
        // the single-target route.
        auditMulticastTarget(inject_id, 'multicast', from, verifiedSender, id, prompt, deliveryAuditResult(delivery));

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
        auditMulticastTarget(inject_id, 'multicast', from, verifiedSender, id, prompt, 'failed:DELIVERY_FAILED');
      }
    } else {
      results.failed.push({ id, code: 'SESSION_NOT_FOUND', error: 'Session not found' });
      auditMulticastTarget(inject_id, 'multicast', from, verifiedSender, id, prompt, 'failed:SESSION_NOT_FOUND');
    }
  }

  res.json({ success: true, results });
});

// #43 — shared per-target audit helper for the fan-out handlers (multicast/broadcast). One
// JSONL line per target so blast-radius is queryable per session; all share `inject_id`.
// #815: takes the full principal fields (verifiedSenderFields) rather than a bare sid, so a
// fan-out line carries the same instance identity a single inject does.
function auditMulticastTarget(inject_id, kind, from, verifiedSender, id, prompt, delivery_result) {
  auditAppend({
    ts: new Date().toISOString(), inject_id, kind, source: kind,
    claimed_from: from || null, ...verifiedSender,
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
    return rejectPeerLaneFanout(res, { from, reason: verdict.reason, targetIds, source: 'broadcast', verifiedSender: verifiedSenderFields(verifiedPrincipalFromReq(req)), prompt });
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
  const verifiedPrincipal = verifiedPrincipalFromReq(req);
  const verifiedSenderSid = verifiedPrincipal ? verifiedPrincipal.sid : null;
  const verifiedSender = verifiedSenderFields(verifiedPrincipal);   // #815 audit fields

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
        auditMulticastTarget(inject_id, 'broadcast', from, verifiedSender, id, prompt, `failed:${delivery.code || 'DELIVERY_FAILED'}`);
        continue;
      }

      results.successful.push({ id, strategy: delivery.strategy });
      auditMulticastTarget(inject_id, 'broadcast', from, verifiedSender, id, prompt, deliveryAuditResult(delivery));  // #860 F2
    } catch (err) {
      results.failed.push({ id, code: 'DELIVERY_FAILED', error: err.message });
      auditMulticastTarget(inject_id, 'broadcast', from, verifiedSender, id, prompt, 'failed:DELIVERY_FAILED');
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
      armUpstreamProbe(session);   // #732: a submit is a delivery too — probe with it
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
    // #760: this branch is also how the CR half of `telepty inject --submit` reaches the
    // queue after its body was modal-parked (hasBootstrapBacklog above). Awaiting it would
    // 504 at gateTimeoutMs and CANCEL the op, dropping the CR while the body sits parked —
    // half a message, which is worse than none. Ack the queue position; the park drain runs
    // both ops in order once the surface clears.
    if (isSurfaceBlockedByModal(session)) {
      scheduleModalParkDrain(id, session);
      console.log(`[SUBMIT] ${id} parked behind a surface modal (depth ${session.bootstrapQueue.length})`);
      return res.json(bootstrapQueuedResponse(op, {
        parked: 'surface_modal',
        reason: modalDeliveryDecision(session, { force: false }).reason,
        pending: session.bootstrapQueue.length,
      }));
    }
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
    // #737: the force path is the one that kills sessions — it skips the bootstrap gate
    // (above) and returns before Layer 3 (below), so this is the ONLY place it can be asked.
    // A bare CR into the update modal activates "1. Update now" and codex exits.
    const forceModalDecision = await resolveModalGate(id, session, { force: true });
    if (forceModalDecision) {
      // #760: `--submit-force` IS the worker REPORT path, and its body was parked by the
      // /inject request a moment earlier. Park the CR behind it so the pair replays in
      // order; refusing here would strand the body on the queue with no Enter behind it.
      if (forceModalDecision.action === 'park') {
        const op = parkOperationOnModal(id, session, {
          type: 'submit',
          body: { ...(req.body || {}) },
        }, forceModalDecision);
        emitSubmitBus({
          strategy: 'none', attempts: 0, gated: false, forced: true,
          submit_confirmed: false, reason: forceModalDecision.reason, parked: 'surface_modal',
        });
        return res.json(bootstrapQueuedResponse(op, {
          parked: 'surface_modal',
          reason: forceModalDecision.reason,
          hint: forceModalDecision.hint,
          pending: session.bootstrapQueue.length,
          forced: true,
        }));
      }
      console.log(`[SUBMIT] force refused for ${id} — ${forceModalDecision.reason}`);
      if (injectedBody) {
        markPendingReportSubmitUnconfirmed(id, { reason: 'codex_modal_ui', attempts: 0, retryable: true });
      }
      emitSubmitBus({ strategy: 'none', attempts: 0, gated: false, forced: true, submit_confirmed: false, reason: 'codex_modal_ui' });
      return res.status(409).json({
        ...modalRejectionResponse(forceModalDecision),
        strategy: 'none',
        attempts: 0,
        gated: false,
        forced: true,
      });
    }
    if (injectedBody) {
      markPendingReportSubmitStarted(id, injectedBody);
    }
    const forceRingBytesAtSubmit = session.outputRingTotalBytes || 0;
    // #730: hold the CR clear of the composer's paste-burst window for the one shape that
    // needs it (un-enveloped + multi-line). 0ms — byte-identical to before — otherwise.
    const forceCrGapMs = forceSubmitCrGapMs(injectedBody, session);
    if (forceCrGapMs > 0) {
      console.log(`[SUBMIT] force CR gap ${forceCrGapMs}ms for ${id} (un-enveloped multi-line body)`);
      await new Promise((resolve) => setTimeout(resolve, forceCrGapMs));
    }
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

  // #737: every remaining submit path (gateOff escape hatch + the gated path) converges
  // here. Layer 3 already knows about `codex_modal_ui` but is cmux-only AND advisory
  // (`no_prompt_symbol_seen` falls through and submits anyway), so it protects nothing on a
  // wrapped session — measured: the gated path fired its CR into the modal at +3ms.
  const submitModalDecision = await resolveModalGate(id, session, { force: false });
  if (submitModalDecision) {
    // #760: same park as the force path. Reached when the modal came up between the /inject
    // and the /submit, so the queue was still empty at the bootstrap branch above.
    if (submitModalDecision.action === 'park') {
      const op = parkOperationOnModal(id, session, {
        type: 'submit',
        body: { ...(req.body || {}) },
      }, submitModalDecision);
      emitSubmitBus({
        strategy: 'none', attempts: 0, gated: true, forced: false,
        submit_confirmed: false, reason: submitModalDecision.reason, parked: 'surface_modal',
      });
      return res.json(bootstrapQueuedResponse(op, {
        parked: 'surface_modal',
        reason: submitModalDecision.reason,
        hint: submitModalDecision.hint,
        pending: session.bootstrapQueue.length,
      }));
    }
    console.log(`[SUBMIT] refused for ${id} — ${submitModalDecision.reason}`);
    if (injectedBody) {
      markPendingReportSubmitUnconfirmed(id, { reason: 'codex_modal_ui', attempts: 0, retryable: true });
    }
    emitSubmitBus({ strategy: 'none', attempts: 0, gated: true, forced: false, submit_confirmed: false, reason: 'codex_modal_ui' });
    return res.status(409).json({
      ...modalRejectionResponse(submitModalDecision),
      strategy: 'none',
      attempts: 0,
      gated: true,
      forced: false,
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
  //
  // #694 busy-dispatch fast-path: a BUSY (mid-turn) recipient sits in working/thinking — neither
  // is a READY_STATE — so awaitReplReady can never pass mid-turn and would burn the FULL
  // gateTimeoutMs (up to 10s) before best-effort dispatch. When the target is a GENUINE ongoing
  // turn (isBusyDispatchState: working/thinking held ≥ SUBMIT_BUSY_GRACE_MS, which excludes the
  // transient `working` from echoing our OWN just-injected text, duration_ms ≈ 0), wait ONLY for
  // the input to settle (body echoed + micro-quiet, via awaitInputSettled) and dispatch
  // best-effort — the same downstream path as a gate timeout, but in ~hundreds of ms. idle/waiting
  // never match isBusyDispatchState, so the idle path is byte-unchanged. gatedTerminalSubmit below
  // still runs its OWN echo+quiet gate before the \r (never fires blindly), and a CR into a busy
  // composer merely queues → #617 redeliver fires it on idle. Rollback: TELEPTY_SUBMIT_BUSY_DISPATCH=off.
  let gateResult = null;
  if (injectedBody && SUBMIT_BUSY_DISPATCH_ENABLED) {
    const cur = sessionStateManager.getState(id);
    if (submitGate.isBusyDispatchState(cur, SUBMIT_BUSY_GRACE_MS)) {
      const settle = await submitGate.awaitInputSettled(session, injectedBody, {
        timeoutMs: 1200,
        quietWindowMs: 100,
        echoGraceMs: 400,
        pollIntervalMs: 30,
        stripAnsi: stripAnsiState,
      });
      gateResult = { ready: false, reason: 'busy_settled', last_state: cur.state, waited_ms: settle.waited_ms };
      console.log(`[SUBMIT] busy-dispatch fast-path ${id}: state=${cur.state} (${cur.duration_ms}ms) settle=${settle.reason} (${settle.waited_ms}ms) — dispatching without idle-gate burn`);
    }
  }
  if (!gateResult) {
    gateResult = await submitGate.awaitReplReady(id, sessionStateManager, {
      timeoutMs: gateTimeoutMs,
      ...(minConfidence !== undefined ? { minConfidence } : {}),
    });
  }
  const gatedDispatchAfterTimeout = !gateResult.ready;
  if (isTerminalGateFailure(gateResult)) {
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
    // #678: `no_state`/`no_state_manager` join `timeout` here — dispatch the CR best-effort
    // rather than hard-fail, so a live-bridge session with no render-state machine still submits.
    console.log(`[SUBMIT] gate ${gateResult.reason || 'not-ready'} ${id}: dispatching anyway (last_state=${gateResult.last_state})`);
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
  // #43 P2 / #815 — daemon-verified sender identity (from the presented bearer, never body.from).
  // The full principal (sid, epoch, generation) so a consumer can tell WHICH INSTANCE of a sid
  // sent this; `verifiedSender` spreads the epoch/generation onto every audit line below.
  const verifiedPrincipal = verifiedPrincipalFromReq(req);
  const verifiedSenderSid = verifiedPrincipal ? verifiedPrincipal.sid : null;
  const verifiedSender = verifiedSenderFields(verifiedPrincipal);

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
      claimed_from: from || null, ...verifiedSender,
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

  // #60 Stage A / §3 item 1 — DURABLY RECORD ABSENCE BEFORE DELIVERY.
  //
  // This used to run after the delivery call, as a best-effort in-memory assignment. That
  // ordering is what made silence possible: bytes reached a worker, the daemon restarted, and
  // nothing anywhere could answer for the dispatch — the orchestrator's poll then got a 404 and
  // read it as a task-state signal. The commit is transactional (temp → fsync → rename → dir
  // fsync) and its failure ABORTS the delivery: refusing to deliver is honest, delivering and
  // then forgetting is not.
  //
  // Scoped to tracked injects (`from` present) — an untracked operator inject is unaffected.
  let trackedRecord = null;
  if (from) {
    const begun = beginTrackedInjection({ injectId: inject_id, sessionId: id, source: from, session });
    if (!begun.ok) {
      emitInjectFailureEvent(id, 'TRACKING_PERSISTENCE_FAILED',
        'Observation tracking could not be persisted; no task bytes were delivered.',
        { inject_id, from: from || null }, session);
      return respondWithError(res, 500, 'TRACKING_PERSISTENCE_FAILED',
        'Observation tracking could not be persisted; no task bytes were delivered.',
        { inject_id, tracking_state: 'unavailable', reason: 'tracking_persistence_failed' });
    }
    trackedRecord = begun.record;
    pendingReports[id] = {
      source: from,
      injectedAt: new Date().toISOString(),
      injectId: inject_id,
      submitExpected: !!no_enter,
      noEnter: !!no_enter,
      injectedBodyPreview: prompt.slice(0, 500),
      // #52: echo-evidence watermark — only frames appended after this inject count.
      ringBytesAtInject: session.outputRingTotalBytes || 0,
      awaitingReport: true
      // NOTE: no `idleNotified`. The one-way "already spoke" bit is gone; duplicate suppression
      // is keyed on observation identity in the ledger, where it cannot become an authority gate.
    };
  }

  try {
    const delivery = await deliverInjectionToSession(id, session, finalPrompt, {
      noEnter: !!no_enter,
      source: 'inject',
      from: from || 'inject',
      // #860 F2 — carried so that a park keeps its link to the write-ahead record. Null for an
      // untracked operator inject (no `from`), and every consumer of it no-ops on null.
      injectId: trackedRecord ? inject_id : null,
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
        claimed_from: from || null, ...verifiedSender,
        to: id, to_alias: requestedId !== resolvedId ? requestedId : null,
        origin: 'trusted-local', origin_host: MACHINE_ID, ref_path: req.body.ref_path || null,
        payload: finalPrompt, delivery_result: `failed:${delivery.code || 'DELIVERY_FAILED'}`
      });
      // #843 — close the write-ahead record. Without this the refusal is recorded in the AUDIT log
      // (above) and contradicted in the OBSERVATION ledger, which keeps saying `tracked` /
      // `inject_accepted` for a dispatch that delivered nothing. `inject_id` rides on the error
      // body for the same reason: a caller told its dispatch was refused must be able to poll the
      // record that says so.
      const aborted = trackedRecord
        ? abortTrackedInjection(inject_id, id, delivery.code, delivery.error)
        : 'no_tracked_inject';
      return respondWithError(res, delivery.httpStatus || 500, delivery.code || 'DELIVERY_FAILED', delivery.error,
        { inject_id, tracking_state: aborted === 'tracking_aborted' ? 'aborted' : 'unavailable' });
    }

    if (from) session.lastInjectFrom = from;
    if (reply_to) session.lastInjectReplyTo = reply_to;
    if (thread_id) session.lastThreadId = thread_id;

    // #860 F2 — the service log gets the same distinction the audit line does. "Wrote" was printed
    // for a queue push too, so an operator grepping the log for a delivery found one that had not
    // happened.
    console.log(`[INJECT] ${deliveryAuditResult(delivery) === 'queued' ? 'Queued for' : 'Wrote to'} session ${id} (inject_id: ${inject_id})`);

    const injectTimestamp = new Date().toISOString();
    // #43 P1/P2 — one audit line per delivery (claimed + daemon-verified sender, hash-only).
    auditAppend({
      ts: injectTimestamp, inject_id, kind: 'inject', source: 'inject',
      claimed_from: from || null, ...verifiedSender,
      to: id, to_alias: requestedId !== resolvedId ? requestedId : null,
      origin: 'trusted-local', origin_host: MACHINE_ID, ref_path: req.body.ref_path || null,
      // #860 F2 — `queued` when the delivery was parked on the bootstrap / modal queue with zero
      // bytes written, `success` only for a delivery the machinery reported as written.
      payload: finalPrompt, delivery_result: deliveryAuditResult(delivery)
    });
    broadcastSessionEvent('inject_written', id, session, {
      timestamp: injectTimestamp,
      extra: {
        inject_id,
        target_agent: id,
        // #815: the prompt is NO LONGER rebroadcast verbatim. Any local socket may subscribe to
        // the bus with no token and no Origin, so `content: prompt` published the full text of
        // every dispatch to any local process — a disclosure in its own right, and the harvest
        // that hands an adversary the correlation identifiers carried inside dispatches. Only
        // non-secret transport metadata now: enough to correlate and to verify integrity against
        // a payload you already hold, and nothing to read if you do not.
        content_sha256: crypto.createHash('sha256').update(prompt).digest('hex'),
        content_length: Buffer.byteLength(prompt),
        from: from || null,
        // #43 — live bus event enriched with daemon-verified provenance (spec §7).
        ...verifiedSender,
        spoof_suspected: !!(from && verifiedSenderSid && from !== verifiedSenderSid),
        origin: 'trusted-local',
        reply_to: reply_to || null,
        thread_id: thread_id || null,
        reply_expected: !!reply_expected
      }
    });

    // #60 Stage A / §3.6: the reverse-text REPORT path is DELETED, not adapted.
    //
    // It used to look at any inject a session routed back to its own pending-report source and
    // call it a completion — `resolveOutboundReportStatus` mapped every payload that was not a
    // recognised prefix to `report_complete`, so "Can you clarify the requirement?" was recorded
    // as that worker reporting its task done. It also marked the sender idle from that text and
    // broadcast TASK_COMPLETE_WITH_REPORT.
    //
    // No text can authenticate its sender or correlate itself to a dispatch, so no text may
    // settle one. In 0.8.0 a reverse-routed inject is an ordinary message and the sender's
    // tracked record stays completion-unknown. The authenticated, correlated report protocol is
    // Stage B, and it will not consult pendingReports, the observation ledger, PTY state, or
    // reverse-route matching (§V2/§7 item 10).

    // The tracked record and the pending entry were both created BEFORE this delivery (see the
    // begin-tracking block above), so there is nothing to register here. Supersession of a prior
    // record for the same session is handled there too: the old inject_id keeps its history and
    // gains `tracking_superseded`, instead of being destructively overwritten.

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
// Returns whether the frame may be forwarded. Records the attempt either way.
function authorizeViewerInject({ sessionId, session, data, claimedFrom, principal }) {
  const inject_id = crypto.randomUUID();
  const payload = typeof data === 'string' ? data : '';
  const verdict = classifyPeerLaneInject({
    from: claimedFrom, to: sessionId, prompt: payload, orchestratorSids: ORCHESTRATOR_SIDS
  });
  const blocked = verdict.decision === 'block';

  if (blocked) {
    broadcastSessionEvent('peer_inject_blocked', sessionId, session, {
      extra: {
        target_agent: sessionId,
        from: claimedFrom || null,
        reason: verdict.reason,
        attempted_kind: verdict.kind,
        envelope_present: verdict.envelopePresent,
        inject_id
      }
    });
    console.warn(`[PEER-GUARD] blocked ws-viewer inject ${claimedFrom} → ${sessionId} (${verdict.reason})`);
  }

  auditAppend({
    ts: new Date().toISOString(), inject_id, kind: 'inject', source: 'ws-viewer',
    claimed_from: claimedFrom || null, ...verifiedSenderFields(principal),
    to: sessionId, to_alias: null,
    origin: 'trusted-local', origin_host: MACHINE_ID, ref_path: null,
    payload,
    // `forwarded`, not `success`. The HTTP route's `success` means its delivery machinery
    // reported success; all this path can measure is that the frame was written to the owner
    // socket. Two different measurements must not wear the same word — that substitution is the
    // defect class this release exists to remove.
    delivery_result: blocked ? `blocked:${verdict.reason}` : 'forwarded'
  });

  return !blocked;
}

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

  const cleaned = raw ? fullOutput : stripAnsiForScreen(fullOutput);

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
  // #815: a rename moves ONE LIVE INSTANCE to a new name — same PTY, same owner, same epoch. The
  // credential follows the instance rather than being revoked, or the running child (which holds
  // the bearer in an environment nobody can update) would silently lose its identity. Only
  // canonical_sid changes in the principal; the epoch still says "same instance".
  sessionCredentials.rename(id, new_id);
  const renamedNonce = sidNonces.get(id);
  if (renamedNonce !== undefined) {
    sidNonces.delete(id);
    sidNonces.set(new_id, renamedNonce);
  }
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
function describeSessionTeardown(killError) {
  if (!killError) return { httpStatus: 200, body: { success: true, status: 'closing' } };
  return {
    httpStatus: 500,
    body: {
      success: false,
      code: 'KILL_FAILED',
      status: 'registry-removed-kill-unconfirmed',
      error: `Session teardown failed: ${killError.message || String(killError)}. `
        + 'The registry record was removed, so this process is no longer tracked by the daemon '
        + 'and may still be running.',
      registry_removed: true,
    },
  };
}

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
  // #843 A — the kill outcome is MEASURED, not inferred from which block ran. The two arms used
  // to be a `try` returning `{success:true, status:'closing'}` and a `catch` returning
  // `{success:true, status:'force-removed'}`: a kill that THREW answered success. The process may
  // still be running, the registry record is gone, so nothing tracks it any more — and
  // `bin/session-cleanup.sh`, the operator entrance here, read that success as "the worker is
  // gone". Capturing the error as a value collapses the duplicated teardown into one path and
  // makes "a failed kill does not report success" structural rather than a thing to remember.
  let killError = null;
  try {
    session.isClosing = true;
    if (session.type === 'wrapped') {
      if (session.clients) session.clients.forEach(ws => ws.close(1000, 'Session destroyed'));
    } else if (session.ptyProcess) {
      session.ptyProcess.kill();
    }
  } catch (err) {
    killError = err;
  }
  // Surface close is the orchestrator's job (Workspace Host adapter), per the 2026-05-30
  // verdict — NO-OP on the managed path. The orchestrator's session-cleanup.sh closes the
  // surface on this normal CLI-exit (CLEANUP_REQUEST→wh_close). Actuates only for a standalone
  // telepty with AIGENTRY_TELEPTY_SELF_CLOSE_SURFACE=1 (gate lives in closeSurface).
  try { terminalBackend.closeSurface(session); } catch {}
  // #60 Stage A §A2 (F1) — OBSERVE THE END BEFORE THE RECORD DISAPPEARS.
  //
  // This used to `delete sessions[id]` first and mark nothing at all. The PTY kill's onExit fires
  // asynchronously, by which point the record is gone, so the transition listener's
  // `if (!session) return` guard bailed and the end was emitted on NO channel. Silence is the one
  // output Stage A forbids, and this is the entrance operator tooling uses, so every cleaned-up
  // session was saying nothing about its own end while the natural-exit path said it correctly.
  //
  // #843 A — and it is `markTerminationRequested`, not `markDead`. The A2 repair above was right
  // to leave exit code and signal null (no exit status was observed at this instant, and
  // inventing one would be a measurement we did not make) and then routed through the one method
  // whose external name is `session_process_exited`. Honest fields under a name that contradicted
  // them. The mark runs synchronously, so the observation is emitted while `sessions[id]` is still
  // live; unregister then destroys the machine, which also makes the later onExit markDead a no-op
  // (its `if (sm)` guard) rather than a second, differently-named statement about one ending.
  sessionStateManager.markTerminationRequested(id, 'operator_delete', killError && killError.message);
  sessionStateManager.unregister(id);
  delete sessions[id];
  revokeSessionCredential(id);    // #815: DELETE — revoke before the id can be reused
  try { mailbox.purge(id); } catch {}
  lifecycle.cleanupSessionArtifacts(id);
  persistSessions();
  const teardown = describeSessionTeardown(killError);
  console.log(killError
    ? `[KILL] Session ${id} registry-removed but the kill was NOT confirmed: ${killError.message}`
    : `[KILL] Session ${id} removed`);
  res.status(teardown.httpStatus).json(teardown.body);
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

  // #843 B — the THIRD write door, and until now the only one with no accountability at all.
  //
  // This writes into any session's PTY with exactly the authority of
  // `POST /api/sessions/:id/inject`, and it applied neither of that route's two rules: no
  // `classifyPeerLaneInject` verdict and no `auditAppend` line. Reproduced against one daemon:
  // the HTTP door refuses `from:'aigentry-coder-a' → victim` with 403 PEER_INJECT_BLOCKED and
  // records the attempt; the identical payload re-addressed to `POST /api/bus/publish` returned
  // 200, landed in the PTY, and left the audit log unchanged. A guardrail enforced at two doors
  // of three is not a guardrail — it is the false confidence this release exists to remove, and
  // #826 shipped believing there were two doors.
  //
  // The claimed sender is read ONLY from fields that name a session id. `msg.from` is the direct
  // analogue of `body.from`. `msg.source` is accepted only when it carries no `:` — the bus
  // envelope defines `source` as `project:session_id` (BUS_EVENT_SCHEMA.md), which is a different
  // namespace, and mapping it into the sid namespace would invent an identity and false-block
  // legitimate deliberation routing. An event that names no sender resolves to `null`, which
  // classifies as `no-sender` and is ALLOWED — deliberately the same answer the HTTP door gives a
  // body with no `from`. This is accountability parity, not a new restriction: the unattributed
  // bus route keeps working, and now it leaves a record.
  const busSource = typeof msg.source === 'string' && !msg.source.includes(':') ? msg.source : null;
  const claimedFrom = (typeof msg.from === 'string' && msg.from) || busSource || null;
  const peerVerdict = classifyPeerLaneInject({
    from: claimedFrom, to: targetId, prompt, orchestratorSids: ORCHESTRATOR_SIDS
  });
  const auditBusWrite = (deliveryResult) => auditAppend({
    ts: new Date().toISOString(), inject_id, kind: 'inject', source: 'bus',
    claimed_from: claimedFrom,
    // The bus is not an authorization boundary — any local socket may publish to it with no
    // credential — so nothing arriving here is a verified identity. Absence, stated as absence.
    ...verifiedSenderFields(null),
    to: targetId, to_alias: rawTarget !== targetId ? rawTarget : null,
    origin: 'trusted-local', origin_host: MACHINE_ID, ref_path: null,
    payload: prompt, delivery_result: deliveryResult
  });

  if (peerVerdict.decision === 'block') {
    broadcastSessionEvent('peer_inject_blocked', targetId, targetSession, {
      extra: {
        target_agent: targetId, from: claimedFrom, reason: peerVerdict.reason,
        attempted_kind: peerVerdict.kind, envelope_present: peerVerdict.envelopePresent,
        inject_id, source: 'bus_auto_route', turn_id: turnId
      }
    });
    auditBusWrite(`blocked:${peerVerdict.reason}`);
    console.warn(`[PEER-GUARD] blocked bus-route inject ${claimedFrom} → ${targetId} (${peerVerdict.reason})`);
    emitInjectFailureEvent(targetId, 'PEER_INJECT_BLOCKED', `Peer-lane inject blocked: ${peerVerdict.reason}`, {
      source: 'bus_auto_route', turn_id: turnId, original_message_id: msg.message_id || null
    }, targetSession);
    return;
  }

  const delivery = await deliverInjectionToSession(targetId, targetSession, prompt, {
    source: 'bus_auto_route'
  });
  const delivered = delivery.success === true;
  // #860 F2 — `queued` for an op parked on the bootstrap / modal queue: this route audits the bus
  // door, and a door that recorded a write which never happened is the gap #826 opened this log to
  // close.
  auditBusWrite(delivered ? deliveryAuditResult(delivery) : `failed:${delivery.code || 'DELIVERY_FAILED'}`);
  if (!delivered) {
    emitInjectFailureEvent(targetId, delivery.code, delivery.error, {
      source: 'bus_auto_route',
      turn_id: turnId,
      original_message_id: msg.message_id || null
    }, targetSession);
  }

  // #861 — `delivered` means BYTES WERE WRITTEN, and a park writes none.
  //
  // `bootstrapQueuedResponse` returns `success: true` for an op parked on the bootstrap /
  // surface-modal queue, so `delivery.success` cannot carry this field on its own. #860 made the
  // audit log say `queued` for exactly that case and this event went on saying `delivered: true`
  // about the same inject — and the asymmetry ran the wrong way: `injects.jsonl` is token-gated
  // while any local process may subscribe to the bus with no credential, so the honest record sat
  // behind the credential and the false one was in the open.
  //
  // Asked THROUGH `deliveryAuditResult` rather than re-expressed here. It is the same question the
  // audit line two lines up asks, and two writers of one predicate — with nothing binding them — is
  // the shape every drift defect in this release has: the answers agree until someone edits one.
  // The keying (strategy as well as flag) and its reason live there, at the single writer.
  const parked = deliveryAuditResult(delivery) === 'queued';
  const wrote = delivered && !parked;

  // Emit inject_written ack
  broadcastSessionEvent('inject_written', targetId, targetSession, {
    extra: {
      inject_id,
      source_host: MACHINE_ID,
      target_agent: targetId,
      source_type: 'bus_auto_route',
      turn_id: (msg.payload && msg.payload.turn_id) || null,
      original_message_id: msg.message_id || null,
      delivered: wrote,
      // The audit log's own vocabulary, carried on the UNGUARDED surface too, so a subscriber can
      // tell "accepted and parked" from "refused" without opening a log it may hold no token for.
      // A park is not a failure: `code`/`error` stay null below, because nothing went wrong.
      delivery_result: wrote ? 'success' : parked ? 'queued' : `failed:${delivery.code || 'DELIVERY_FAILED'}`,
      code: delivered ? null : delivery.code,
      error: delivered ? null : delivery.error
    }
  });
  console.log(`[BUS-ROUTE] ${eventType} → ${targetId}: ${wrote ? 'delivered' : parked ? 'queued (parked, 0 bytes)' : 'failed'}`);
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
      emitSessionLifecycleEvent('session_cleanup', id, session, {
        reason: 'STALE_DISCONNECTED',
        disconnectedSeconds
      });
      delete sessions[id];
      revokeSessionCredential(id);  // #815: TTL/GC is the routine reuse path — revoke here too
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
  authorizeViewerInject
});

function shutdown(code) {
  mailboxDelivery.stop();
  mailboxNotifier.cancelAll();
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
  detectIdleAfterError,           // #801: turn-scoped error-death verdict (TASK_ERROR vs TASK_COMPLETE)
  maybeRecordInjectConsumption,   // #60 Stage A: records the fresh-busy-edge CANDIDATE (see the fn comment)
  maybeRecordLauncherConsumption, // #60 Stage A: launcher watermark telemetry — never consumption
  recordObservation,              // #60 Stage A: the TOTAL observation emitter (named result on every path)
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
  resolveBindHost,                // telepty#50 + #672: pure bind-address policy (loopback default, env opt-in, tailnet auto)
  formatBindHint,                 // telepty#50 + #672: startup bind/exposure banner line
  isTailnetAuto,                  // #672: pure predicate — is the zero-config tailnet path active
  resolveEffectivePeerAllowlist,  // #672: pure allowlist policy — auto-trust tailnet without widening a manual set
};
