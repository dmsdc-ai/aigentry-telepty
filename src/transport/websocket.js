'use strict';

const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const { createOriginGuard } = require('../protocol/http-auth');

function isOpenWebSocket(ws) {
  return Boolean(ws && ws.readyState === 1);
}

function installWebSocketTransport(deps) {
  const {
    server,
    tailnetServer,
    sessions,
    busClients,
    expectedToken,
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
    busAutoRoute,
    // #815 credential store — owner-claim gate below. Optional so a construction site that omits
    // it degrades to the pre-#815 open claim rather than throwing; the daemon always passes it.
    credentials,
    // #60 Stage A §3 — durable observation seam. Optional for the same reason: a test harness that
    // omits them gets the bus-only behaviour instead of a throw.
    recordObservation,
    listTrackedInjectionsForSession,
    // #826 — policy + audit for the viewer write path, so it matches POST /inject. Returns
    // whether the frame may be forwarded, and records the attempt either way. Optional, same
    // convention as above; the daemon always passes it.
    authorizeViewerInject
  } = deps;

  /**
   * #60 Stage A §3 "consumption of #815 owner lifecycle" — append an owner-lifecycle fact to
   * EVERY tracked inject assigned to this session, durably, then let recordObservation put it on
   * the bus. Owner replacement and owner death are transport facts the daemon knows with
   * certainty; neither is a task outcome, and both carry `completion_fact: null`.
   *
   * Returns the named results, one per record — never undefined, never a bare return.
   */
  function recordOwnerLifecycle(sessionId, session, cause, evidence) {
    if (typeof recordObservation !== 'function' || typeof listTrackedInjectionsForSession !== 'function') {
      // Named, not silent: a construction site without the ledger seam still emitted the bus
      // lifecycle event above, and this says exactly what did not happen.
      return ['observation_ledger_unavailable'];
    }
    const records = listTrackedInjectionsForSession(sessionId);
    if (records.length === 0) return ['no_tracked_inject'];
    const active = pendingReports[sessionId] || null;
    return records.map((record) => {
      // Reuse the LIVE pending report when this is the session's active inject, so its consumption
      // provenance survives; a superseded record gets a minimal stub, which classifies as
      // `no_consumption_evidence` — accurate, because nothing about consumption was measured here.
      const pendingReport = active && active.injectId === record.inject_id
        ? active
        : { injectId: record.inject_id, source: record.transport_source };
      return recordObservation({
        sessionId,
        session,
        pendingReport,
        // `destination: '*'` rows accept any destination; the internal FSM is NOT driven from
        // here, because the daemon has not measured what state the session is in — only that its
        // owner changed. Passing the last known state would be inventing a measurement.
        destination: null,
        cause,
        evidence,
        deliverToSource: true,
        trigger: 'owner_lifecycle',
      });
    });
  }

  // #843 B — the delivery adapters behind the ONE viewer-write gate.
  //
  // #826 put policy + audit on the wrapped viewer path and left the spawned one alone, because
  // the check was written INSIDE `if (type === 'wrapped')`. The `else` arm below it —
  // `activeSession.ptyProcess.write(data)` — is the same write with the same authority into a
  // session type that is real and viewer-reachable (daemon.js POST /api/sessions/spawn), and it
  // kept every property #826 removed: no `classifyPeerLaneInject`, no `ws-viewer` audit record,
  // no provenance. The comment one branch up still called the wrapped path "the one write path
  // with no accountability" while this one was.
  //
  // The shape is what prevents the recurrence: authorization is decided ONCE for every viewer
  // input frame, and only then does a session-type-specific adapter carry the bytes. A future
  // third session type gets an adapter, not another copy of the gate to forget.
  //
  // Returns null when there is nothing writable to deliver to — the pre-existing behaviour at
  // both doors (a wrapped viewer whose owner socket is closed was already dropped silently).
  // Checked BEFORE authorizing so the audit line's `forwarded` keeps meaning that the bytes were
  // actually handed over, rather than becoming a claim about a write that had no target.
  function viewerInputDeliverer(session) {
    if (session.type === 'wrapped') {
      const owner = session.ownerWs;
      if (!isOpenWebSocket(owner)) return null;
      return (data) => owner.send(JSON.stringify({ type: 'inject', data }));
    }
    if (session.ptyProcess) return (data) => session.ptyProcess.write(data);
    return null;
  }

  // Geometry, deliberately NOT behind the inject gate — see the resize note in the message
  // handler below.
  function viewerResizeDeliverer(session) {
    if (session.type === 'wrapped') {
      const owner = session.ownerWs;
      if (!isOpenWebSocket(owner)) return null;
      return (cols, rows) => owner.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
    if (session.ptyProcess) return (cols, rows) => session.ptyProcess.resize(cols, rows);
    return null;
  }

  // Same browser-drive-by guard as the HTTP middleware, and needed MORE here: a WS handshake
  // is not CORS-gated at all, so before this a visited page could open a socket to loopback and
  // read/write somebody's terminal. Default-deny when no allowlist is supplied.
  const isForbiddenOrigin = deps.isForbiddenOrigin || createOriginGuard(deps.allowedOrigins);

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
      // #754: take the CLI identity from the claim URL when the bridge states one. This path
      // used to hard-code `wrapped`, and a reconnect that reached the WS before its
      // re-register POST landed (cli.js connectDaemonWs swallows that failure) silently
      // replaced a known CLI name with a generic string — which turns OFF every
      // identity-gated feature at once: the bootstrap gate (isBootstrapGatedSession), the
      // #737/#760 modal gates (detectSurfaceModal/modalRemedy), the #730/#716 bracketed-paste
      // envelope, and the submit render-gate's registry lookup. No error is logged for any of
      // them; `isKnownAiCli('wrapped')` is just false. Absent param → the old fallback, so a
      // pre-#754 bridge is byte-identical.
      const claimedCommand = url.searchParams.get('command');
      const autoSession = {
        id: sessionId,
        type: 'wrapped',
        ptyProcess: null,
        ownerWs: ws,
        command: claimedCommand || 'wrapped',
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
      initializeBootstrapState(autoSession);
      sessions[sessionId] = autoSession;
      console.log(`[WS] Auto-registered wrapped session ${sessionId} on reconnect (command: ${autoSession.command})`);
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

    // #815: gate the owner claim. Before this, ANY local process could open ?owner=1 on ANY
    // session and take the PTY byte stream — last-writer-wins displaced the incumbent bridge with
    // close 4001. Hijacking a live terminal is at least as bad as the token disclosure #815 fixes,
    // and it is the same root cause: authority granted for naming an id.
    //
    // A session that HOLDS a credential now requires the matching bearer on the handshake. A
    // session that holds none is untouched — the WS auto-register path (a reconnect that beats its
    // own re-register POST) and any pre-#815 restored record still claim freely, so this closes
    // the hijack without breaking reconnect. Refusal is LOUD (4003, its own code) rather than a
    // silent downgrade to viewer, because a bridge that silently becomes a viewer drops every
    // 'output' frame and looks alive while being dead — the #732/#754 failure shape.
    const sessionHoldsCredential = Boolean(credentials && credentials.hasCredential(sessionId));
    const provedSessionCredential = sessionHoldsCredential
      && credentials.matches(sessionId, req.headers['x-telepty-session-token']);
    if (activeSession.type === 'wrapped' && isOwnerConnect
        && sessionHoldsCredential && !provedSessionCredential) {
      console.warn(`[WS] Refused unauthenticated owner claim for session ${sessionId}`);
      activeSession.clients.delete(ws);
      clearInterval(pingInterval);
      try { ws.close(4003, 'Owner claim unauthenticated'); } catch {}
      return;
    }

    // #843 — the gate above only fires on `?owner=1`, and the ASSIGNMENT below also fires on
    // `!activeSession.ownerWs`. Dropping the query parameter therefore took ownership of a
    // credentialed session without presenting its bearer at all, and the taker then received the
    // full body of every subsequent inject — the disclosure #815 exists to prevent, reached by not
    // asking for it. (Not introduced here: the gate is byte-identical at the base commit. But
    // #815's residual is written down as the first-claim race on an UNcredentialed session, and
    // this is a second, larger one on a credentialed one.)
    //
    // The refusal is deliberately NOT the loud 4003 above. This socket never claimed to be an
    // owner, so refusing the connection would break ordinary viewers attaching to a session whose
    // bridge has dropped. It is refused the AUTHORITY and attached as the viewer it asked to be.
    // The #815 note warning against a silent downgrade is about an explicit `?owner=1` bridge,
    // whose entire purpose is to own and which goes blind as a viewer; it does not apply here.
    const mayClaimOwnership = !sessionHoldsCredential || provedSessionCredential;
    if (!mayClaimOwnership && !activeSession.ownerWs) {
      console.warn(`[WS] Refused implicit ownership of credentialed session ${sessionId} — attached as viewer`);
    }

    // #60 Stage A §3 item 4 — the claim that got PAST the gate above proved it holds this
    // instance's credential, so `verify` names the exact epoch it proved. Record it: nothing else
    // in this transport ever set `session.sessionEpoch`, so every WS-owned session was filed in the
    // ledger as `session_epoch: null / no_815_epoch_fact` even when the claimant had just presented
    // a bearer that resolves to a precise instance (daemon.js beginTrackedInjection). This is the
    // ONLY thing that may set it: an open socket, a fresh owner_token, loopback origin or a
    // matching SID must never stand in for the credential — that substitution is the defect #815
    // removed. No credential presented, or none held, leaves it untouched and unavailable.
    // RESOLVED here, ASSIGNED below inside the ownership transfer — assigning it here would
    // overwrite the incumbent's epoch before the displacement block can capture it, and the
    // displaced epoch is precisely what the owner-replaced fact has to name.
    const claimedBearer = req.headers['x-telepty-session-token'];
    // Resolved ONCE per socket. #826 also needs it — for a VIEWER the principal is a different
    // session (whoever is typing), which is why the full principal is kept rather than only the
    // epoch of a self-claim.
    const presentedPrincipal = (credentials && claimedBearer && typeof credentials.verify === 'function')
      ? credentials.verify(claimedBearer)
      : null;
    const verifiedClaimEpoch = presentedPrincipal && presentedPrincipal.sid === sessionId
      ? presentedPrincipal.epoch
      : null;

    // For wrapped sessions, first connector OR explicit ?owner=1 claim becomes the owner.
    // ?owner=1 reclaim handles the stale-ownerWs bug: allow bridge reconnects but stale TCP
    // half-open connection still holds ownerWs slot → reconnect wrongly becomes a viewer.
    if (activeSession.type === 'wrapped' && (!activeSession.ownerWs || isOwnerConnect) && mayClaimOwnership) {
      const hadDisconnectedOwner = !isOpenWebSocket(activeSession.ownerWs) && activeSession.lastDisconnectedAt;
      // #815: was the incumbent owner ALIVE when it got displaced? That is the case that ends a
      // running agent — the displaced bridge reads close 4001 and exits the session (cli.js:534,
      // 1969-1971) — and it was emitting NOTHING. `hadDisconnectedOwner` is false here, so no
      // session_reconnect fires either; the record simply survives under the new socket while the
      // assignee is gone. Silence reads as continuity, which is the lie.
      const displacedLiveOwner = isOwnerConnect
        && isOpenWebSocket(activeSession.ownerWs)
        && activeSession.ownerWs !== ws;
      const displacedOwnerPid = displacedLiveOwner ? (activeSession.ownerPid || null) : null;
      // Captured BEFORE the claimant's epoch overwrites it — this is the epoch the tracked
      // injects were assigned to, and it is the evidence `owner_epoch_replaced` requires.
      const displacedSessionEpoch = activeSession.sessionEpoch || null;
      const displacedLiveOwnerSocket = displacedLiveOwner ? activeSession.ownerWs : null;
      if (isOwnerConnect && activeSession.ownerWs && activeSession.ownerWs !== ws) {
        // telepty#56 (durable last-writer-wins Replace): close the displaced owner with the
        // dedicated terminal code 4001 'Owner replaced' instead of a bare terminate(). A
        // terminate() is an abnormal 1006 close, which a bridge reads as a transient drop and
        // RECONNECTS — re-contending for the id and oscillating forever (Total flaps 1<->2,
        // injects dropped). 4001 is reason-independent (WS 4000-4999 = app-reserved), so the
        // displaced bridge exits without reconnecting even when the close reason is lost on a
        // half-open TCP socket. The session RECORD survives under the new owner; no shared-fate
        // cascade — the displaced bridge's now-stale ownerToken is suppressed by the #536 DELETE
        // guard. A fallback terminate() reaps a half-open socket that never ACKs the close.
        console.log(`[WS] Replacing stale ownerWs for session ${sessionId}`);
        const displaced = activeSession.ownerWs;
        try { displaced.close(4001, 'Owner replaced'); } catch {}
        setTimeout(() => {
          if (displaced.readyState !== 3) { try { displaced.terminate(); } catch {} }
        }, 1000);
      }
      activeSession.ownerWs = ws;
      // #60 Stage A §3 item 4/5 — the new owner's authenticated epoch, or NULL when it proved
      // none. Null is written deliberately rather than leaving the predecessor's value in place:
      // keeping a stale epoch would file the incoming owner's work under the displaced instance's
      // identity, which is the exact "verified, instance unknown" combination #815 forbids. A
      // legacy or unproven claim is authentication-unavailable, and that is recorded as absence.
      activeSession.sessionEpoch = verifiedClaimEpoch;
      // #860 F1 — and SEPARATELY, the fact that it was PROVED here. `sessionEpoch` alone cannot
      // carry that: the register route mints one before anyone has presented anything, and the
      // restore path reads one off disk, so a consumer keying "authenticated" on the epoch reports
      // both of those as measurements that were never made (daemon.js
      // sessionAuthenticationCapability). This assignment is the ONLY writer, it sits on the line
      // after the epoch it belongs to, and it is written on BOTH arms deliberately: an unproven
      // claim must CLEAR any predecessor's proof, exactly as the null epoch above does.
      activeSession.sessionEpochProved = verifiedClaimEpoch;
      // telepty#56 (kill-stick): capture the owner PID at claim time. The reconnect-register POST
      // only carries owner_pid on reconnect, so a first-connect owner would otherwise have a null
      // ownerPid and `kill --force` could not SIGKILL the owning process. The bridge passes its pid
      // on the ?owner=1 URL; record it so the kill path always has a process to signal.
      const claimOwnerPid = Number(url.searchParams.get('owner_pid'));
      if (Number.isInteger(claimOwnerPid) && claimOwnerPid > 0) {
        activeSession.ownerPid = claimOwnerPid;
      }
      // BUG-C: mint a fresh per-owner token on every claim/reclaim and push it to this owner.
      // The token is the exact "are-you-the-current-owner" discriminator the DELETE guard uses
      // to suppress a stale/displaced owner's teardown (shared-fate fix). Reclaim refreshes it,
      // so the live current owner always holds the current token while a displaced owner keeps a
      // stale one.
      activeSession.ownerToken = crypto.randomUUID();
      try { ws.send(JSON.stringify({ type: 'owner_token', token: activeSession.ownerToken })); } catch {}
      markSessionConnected(activeSession);
      initializeBootstrapState(activeSession);
      console.log(`[WS] Wrap owner ${isOwnerConnect && activeSession.clients.size > 1 ? 're-' : ''}connected for session ${sessionId} (Total: ${activeSession.clients.size})`);
      scheduleBootstrapPromptPoll(sessionId, activeSession);
      // #815: emit the honest lifecycle fact BEFORE any continuity claim. A live owner was
      // replaced — the daemon knows that for certain. It does NOT know whether the displaced
      // process then died, so this asserts only what was observed and never dresses a takeover up
      // as a reconnect. A consumer must treat this as "the assignee of this session may no longer
      // exist"; it is not interchangeable with session_reconnect.
      if (displacedLiveOwner) {
        emitSessionLifecycleEvent('session_owner_replaced', sessionId, activeSession, {
          reason: 'owner_claim_displaced_live_owner',
          displaced_owner_pid: displacedOwnerPid,
          claimant_owner_pid: activeSession.ownerPid || null,
          displaced_session_epoch: displacedSessionEpoch,
          // Was the claimant required to prove it holds this instance's credential? False means
          // the session had no credential to check against — the residual, stated per event.
          claim_was_credentialed: Boolean(credentials && credentials.hasCredential(sessionId))
        });
        // #60 Stage A §3 item 1 — and DURABLY, against every tracked inject assigned to the
        // displaced epoch. The bus event above is push-only: a subscriber that was not listening
        // at this instant, or a daemon restart, would leave those injects with no record that
        // their assignee was displaced. That gap is the whole reason the ledger exists.
        //
        // When the displaced owner never proved an epoch, `displaced_session_epoch` is null and
        // the mapper fails CLOSED to `unmapped_transition_cause` (missing required evidence). That
        // is the correct outcome and it is left to happen: the honest statement is "an owner was
        // replaced and we cannot bind it to an instance", never a synthesized epoch.
        const results = recordOwnerLifecycle(sessionId, activeSession, 'owner_epoch_replaced', {
          displaced_session_epoch: displacedSessionEpoch,
          displaced_owner_pid: displacedOwnerPid,
        });
        console.log(`[OBSERVE] ${sessionId} owner replaced — ${results.length} tracked inject(s): ${results.join(', ')}`);
        // #60 Stage A §3 item 3 — mark the displaced socket so its own close handler can report
        // the death. Once `ownerWs` moved, that handler takes the "client detached" branch and the
        // displaced bridge's exit becomes invisible; the bridge reads close 4001 as terminal and
        // exits WITHOUT necessarily driving markDead, so nothing else would ever say it died.
        if (displacedLiveOwnerSocket) {
          displacedLiveOwnerSocket.__teleptyDisplacedEpoch = displacedSessionEpoch;
          displacedLiveOwnerSocket.__teleptyDisplaced = true;
        }
      }
      if (hadDisconnectedOwner) {
        emitSessionLifecycleEvent('session_reconnect', sessionId, activeSession);
      }
      persistSessions();
    } else {
      console.log(`[WS] Client attached to session ${sessionId} (Total: ${activeSession.clients.size})`);
    }

    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message);
        const { type, data, cols, rows } = msg;

        // #732 (H5 guard): `activeSession` above is a snapshot taken once, at connect time.
        // If sessions[id] is ever replaced under a live owner — a delete+recreate through
        // DELETE /:id (daemon.js:3819) or the disconnect GC (daemon.js:4632) followed by the
        // bridge's re-register — the snapshot goes orphan: `ws === activeSession.ownerWs`
        // still holds, so every 'output' frame is appended to a record nobody reads, while
        // injects keep routing to the live record's ownerWs. That is a silent upstream death
        // with a working downstream, i.e. #732 again by a different route. Re-resolve the
        // live record on every frame so the snapshot can never become the routing authority.
        const activeSession = sessions[sessionId];
        if (!activeSession) return;   // record is gone — nothing to feed

        // An owner whose record was swapped re-adopts a FREE owner slot rather than silently
        // degrading into a viewer (the viewer branch drops 'output' entirely). Same
        // last-writer-wins rule as the connect-time claim: only an explicit ?owner=1 bridge,
        // and only when no other owner socket is open, so a live owner is never displaced.
        if (activeSession.type === 'wrapped' && isOwnerConnect
            && activeSession.ownerWs !== ws && !isOpenWebSocket(activeSession.ownerWs)) {
          activeSession.ownerWs = ws;
          activeSession.clients.add(ws);
          markSessionConnected(activeSession);
          console.log(`[WS] Re-adopted owner for session ${sessionId} (session record was replaced under a live owner)`);
        }

        if (activeSession.type === 'wrapped' && ws === activeSession.ownerWs) {
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
          } else if (type === 'heartbeat') {
            // #732: bridge-side liveness. It rides the exact same gate as an 'output'
            // frame (cli.js: wsReady && readyState === 1), so its arrival proves the
            // bridge→daemon leg works and any silence is the SESSION's, not the PIPE's.
            // Deliberately does NOT touch lastActivityAt: that field is already stamped
            // by the daemon's own delivery path (daemon.js:1119/2033/2061/4415), and
            // stamping it here too would re-hide what the heartbeat exists to reveal.
            activeSession.bridgeHeartbeatAt = new Date().toISOString();
            if (Number.isFinite(msg.pty_bytes)) activeSession.bridgePtyBytes = msg.pty_bytes;
            if (typeof msg.read_side === 'string') activeSession.bridgeReadSide = msg.read_side;
          } else if (type === 'ready') {
            if (isBootstrapGatedSession(activeSession)) {
              markBootstrapReady(sessionId, activeSession, 'bridge_ready');
            } else {
              activeSession.ready = true;
            }
            activeSession.lastActivityAt = new Date().toISOString();

            // #60 Stage A §3.7 — QUALIFY the frame. A `ready` frame is a transport fact about a
            // surface that looks able to RECEIVE an inject; it is not an outcome, and the two
            // detectors behind it are not equally strong. Only the two names the bridge is
            // allowed to assert are accepted; anything else — a 0.7.1 bridge's bare
            // `{type:"ready"}`, a garbled value, an unknown future kind — stays LEGACY and
            // unqualified, so it can never borrow a qualified observation's meaning.
            //
            // Assigned on EVERY frame, never left stale: a session that once matched a composer
            // surface and later sends a bare frame must fall back to legacy, not keep wearing
            // the stronger name from a measurement that is no longer being made.
            const QUALIFIED_READY_KINDS = ['composer_surface_observed', 'prompt_suffix_observed'];
            const qualified = QUALIFIED_READY_KINDS.includes(msg.ready_kind);
            activeSession.readyKind = qualified ? msg.ready_kind : 'legacy_unqualified_ready';
            activeSession.readyDetector = qualified && typeof msg.detector === 'string'
              ? msg.detector
              : 'unqualified';
            activeSession.readyCliKey = qualified && typeof msg.cli_key === 'string' ? msg.cli_key : null;

            console.log(`[READY] Session ${sessionId} surface is ready for inject (${activeSession.readyKind}, detector=${activeSession.readyDetector})`);
            // Broadcast readiness to bus (cmux/kitty paths now enabled for this session).
            // Carries the qualification so a subscriber can tell a known CLI's composer surface
            // from a regex hit on the current frame.
            const readyMsg = JSON.stringify({
              type: 'session_ready',
              session_id: sessionId,
              ready_kind: activeSession.readyKind,
              detector: activeSession.readyDetector,
              cli_key: activeSession.readyCliKey,
              timestamp: new Date().toISOString()
            });
            busClients.forEach(client => {
              if (client.readyState === 1) client.send(readyMsg);
            });

            // #60 Stage A: this used to be the "auto-report" path — it told the SOURCE that the
            // target "completed inject task" on the strength of a ready frame. A ready frame
            // measures a surface, not a turn, and the `!idleNotified` guard it rode on is gone
            // (that one-way bit was burned by a wrong-label emission and then dropped the later
            // genuine one). What remains emits ONE completion-absence observation: the frame is
            // reported as what it is, and no path in this file can produce a terminal claim.
            const pendingReport = pendingReports[sessionId];
            if (pendingReport) {
              fireAutoReport(sessionId, activeSession, pendingReport, 'ready-signal');
            }
          }
        } else {
          // EVERY remaining frame is a VIEWER frame — a wrapped session's non-owner client, or
          // any client of a spawned session (a spawned session has no owner bridge, so all of its
          // sockets are viewers). #843 B: these two used to be separate branches with separate
          // rules, which is how #826 came to cover one of them.
          if (type === 'input') {
            // This is a WRITE into somebody's terminal, and until #826 it was the one write path
            // with no accountability: it skipped `auditAppend` (#47 P5), `classifyPeerLaneInject`
            // (#533's hard block) and provenance labelling, all of which
            // `POST /api/sessions/:id/inject` applies. Equal authority, unequal accountability —
            // so #533 read as enforced while being one WS frame away from optional, and the
            // inject log read as a record of who typed while missing a whole door.
            //
            // It now takes the same rule as the HTTP path, at every session type: same policy
            // verdict, same audit schema, `source: 'ws-viewer'` so the doors stay tellable apart,
            // and the verified sender taken from the #815 bearer on the HANDSHAKE — never from
            // the frame, which is attacker-controlled exactly like `body.from`.
            //
            // Optional dep, per this file's convention: a construction site without it forwards
            // as before rather than throwing. The daemon always passes it.
            const deliver = viewerInputDeliverer(activeSession);
            if (deliver) {
              const allowed = typeof authorizeViewerInject === 'function'
                ? authorizeViewerInject({
                  sessionId,
                  session: activeSession,
                  data,
                  claimedFrom: typeof msg.from === 'string' ? msg.from : null,
                  principal: presentedPrincipal
                })
                : true;
              if (allowed) deliver(data);
            }
          } else if (type === 'resize') {
            // RESIZE IS DELIBERATELY NOT BEHIND THE INJECT GATE.
            //
            // A resize is a write into someone's terminal in the sense that it can disrupt a
            // running TUI — a reflow, a redraw, a truncated composer — so it is not harmless, and
            // it IS the last unaudited viewer write. It is still not an inject, and the argument
            // is the same one this release is built on: it writes no bytes into the PTY input
            // stream, so it cannot run a command; `classifyPeerLaneInject` is handed a prompt to
            // classify and there is no prompt here, so a verdict would be theatre; and recording
            // geometry as `kind: 'inject'` with a payload hash of the empty string would put a
            // PTY write in the audit log that never happened. That is this release's own defect
            // class, committed by the fix for it.
            //
            // Accountability for geometry, if it is wanted, needs its own record kind with its
            // own fields — a decision, not a side effect of tidying this branch.
            const resize = viewerResizeDeliverer(activeSession);
            if (resize) resize(cols, rows);
          }
        }
      } catch (e) {
        console.error('[WS] Invalid message format', e);
      }
    });

    ws.on('close', () => {
      clearInterval(pingInterval);
      // #732 (H5 guard): clean up the LIVE record for the same reason the message handler
      // re-resolves it — cleaning only the connect-time snapshot would leave a replaced
      // record holding a closed ownerWs forever. The `ws === ownerWs` check below still
      // guarantees a stale socket can never tear down an owner it does not own.
      const activeSession = sessions[sessionId];
      if (!activeSession) return;
      activeSession.clients.delete(ws);

      // #60 Stage A §3 item 3 — a DISPLACED owner closing is the assignee going away. It cannot
      // take the branch below (its `ownerWs` slot was reassigned at displacement), so without this
      // the detachment is reported as an ordinary viewer leaving and the tracked injects hear
      // nothing. The bridge treats close 4001 as terminal and exits, frequently without the PTY
      // child ever driving `sessionStateManager.markDead`, so this is emitted on the transport
      // fact alone — which is exactly what §8.3 item 10 requires.
      //
      // #843 A — and the transport fact is all it may claim. This used to emit
      // `owner_process_exited`, whose external kind was `session_process_exited`: a process-death
      // assertion built out of a socket close THIS DAEMON initiated 250 lines up (close 4001,
      // 'Owner replaced'). The displaced bridge does usually exit, but "usually" is not an
      // observation — and BUS_EVENT_SCHEMA.md's `session_owner_replaced` entry already stated the
      // rule correctly ("no process-exit observation is implied") while the code beside it
      // implied exactly that.
      if (ws.__teleptyDisplaced) {
        const results = recordOwnerLifecycle(sessionId, activeSession, 'owner_transport_detached', {
          detached_at: new Date().toISOString(),
          displaced_session_epoch: ws.__teleptyDisplacedEpoch || null,
        });
        console.log(`[OBSERVE] ${sessionId} displaced owner socket detached — ${results.length} tracked inject(s): ${results.join(', ')}`);
      }

      if (activeSession.type === 'wrapped' && ws === activeSession.ownerWs) {
        activeSession.ownerWs = null;
        // #29: cancel any pending owner-alive optimistic timer — the owner is gone, so the
        // floor must not flip a disconnected session ready (hygiene; the timer also re-guards
        // on isOpenWebSocket, but clearing avoids a dangling handle).
        if (activeSession.bootstrapOptimisticTimer) {
          clearTimeout(activeSession.bootstrapOptimisticTimer);
          activeSession.bootstrapOptimisticTimer = null;
        }
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
      } catch (e) {
        console.error('[BUS] Invalid message format', e);
      }
    });

    ws.on('close', () => {
      busClients.delete(ws);
      console.log('[BUS] Agent disconnected from event bus');
    });
  });

  // #835/#820 — a refusal must be readable AS a refusal.
  //
  // This used to be `socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy()`. The
  // destroy() races the write, so the client frequently saw ECONNRESET instead of the response:
  // in `ws` that surfaces as an `error` event plus close **1006**, which is byte-identical to what
  // a client sees when the daemon is not running at all. A bridge then reconnects forever, in
  // silence, against a daemon that is answering and declining. "Nothing is there" and "you were
  // refused" are different facts and a client has to be able to act on the difference.
  //
  // So: a COMPLETE response — status line, `Connection: close`, a JSON body with the same `code`
  // the HTTP middleware returns, and `Content-Length` so the client knows the body ended — then
  // `end()`, which flushes before the FIN. `ws` delivers that to `unexpected-response` with a
  // readable `res.statusCode`, and 1006 is left to mean only what it should: nothing answered.
  function refuseUpgrade(socket, status, reason, code, message) {
    const body = JSON.stringify({ error: message, code });
    // A socket that already went away must not throw out of an upgrade handler.
    socket.on('error', () => {});
    try {
      socket.end(
        `HTTP/1.1 ${status} ${reason}\r\n`
        + 'Connection: close\r\n'
        + 'Content-Type: application/json\r\n'
        + `Content-Length: ${Buffer.byteLength(body)}\r\n`
        + `X-Telepty-Refusal: ${code}\r\n`
        + '\r\n'
        + body
      );
    } catch { /* already destroyed — nothing to tell */ }
  }

  // Shared upgrade handler. Attached to every provided listener so a cross-host attach reaching
  // the additive tailnet socket (daemon.js:4225) upgrades exactly like loopback.
  //
  // #820/#823: the gate is now IDENTICAL to the HTTP middleware's, in the same order —
  // origin → peer reachability → credential. It used to be `isAllowedPeer(addr) || token || jwt`,
  // where a `true` from the peer policy ALONE opened the socket. On a default install that is
  // true for every address (empty allowlist) and for every tailnet device (#672 auto-trust
  // populates the list, and a MATCH returns true just as completely as an empty list does), so
  // an uncredentialed handshake — viewer socket and `/api/bus` alike — upgraded with 101.
  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://' + req.headers.host);
    // #843 — TWO named carriers for the daemon token, matching the HTTP door exactly:
    // `x-telepty-token` (header) and `?token=` (query). The HTTP middleware has always accepted
    // both (`src/protocol/http-auth.js`: `req.headers['x-telepty-token'] || req.query.token`);
    // this read only the query parameter, so the two entrances took different credentials while
    // #820's design asserted they were symmetric.
    //
    // That wrong spec reached another repo and was implemented there: aigentry-aterm puts the
    // token on its `/api/bus` upgrade as `x-telepty-token`, explicitly because the URL is logged —
    // which is the better choice, not the worse one. Without this, 0.8.0 answers that GUI's live
    // event stream with 401, and a 401 reads as a credential fault when the fault is which carrier
    // the transport happens to read. That confusion is the thing this release exists to remove.
    //
    // Not a widening: same secret, same comparison, same `expectedToken`. A WRONG token in either
    // carrier is refused exactly as before — this adds a way to PRESENT the credential, never a
    // way to skip it.
    const token = req.headers['x-telepty-token'] || url.searchParams.get('token');

    if (isForbiddenOrigin(req.headers['origin'])) {
      refuseUpgrade(socket, 403, 'Forbidden', 'ORIGIN_NOT_ALLOWED', 'Forbidden: browser origin not allowed.');
      return;
    }

    // Reachability only, and it can only narrow — never a credential.
    if (!isAllowedPeer(req.socket.remoteAddress)) {
      refuseUpgrade(socket, 403, 'Forbidden', 'PEER_NOT_ALLOWED',
        'Forbidden: this address is not in TELEPTY_PEER_ALLOWLIST.');
      return;
    }

    const wsAuthHeader = req.headers['authorization'] || '';
    const wsJwtValid = wsAuthHeader.startsWith('Bearer ') && verifyJwt(wsAuthHeader.slice(7));
    if (token !== expectedToken && !wsJwtValid) {
      refuseUpgrade(socket, 401, 'Unauthorized', 'PERMISSION_DENIED',
        'Unauthorized: Invalid or missing token.');
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
  }

  for (const listener of [server, tailnetServer]) {
    if (listener) listener.on('upgrade', handleUpgrade);
  }

  return { wss, busWss, handleUpgrade };
}

module.exports = {
  installWebSocketTransport,
  isOpenWebSocket
};
