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
    credentials
  } = deps;

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
    if (activeSession.type === 'wrapped' && isOwnerConnect
        && credentials && credentials.hasCredential(sessionId)
        && !credentials.matches(sessionId, req.headers['x-telepty-session-token'])) {
      console.warn(`[WS] Refused unauthenticated owner claim for session ${sessionId}`);
      activeSession.clients.delete(ws);
      clearInterval(pingInterval);
      try { ws.close(4003, 'Owner claim unauthenticated'); } catch {}
      return;
    }

    // For wrapped sessions, first connector OR explicit ?owner=1 claim becomes the owner.
    // ?owner=1 reclaim handles the stale-ownerWs bug: allow bridge reconnects but stale TCP
    // half-open connection still holds ownerWs slot → reconnect wrongly becomes a viewer.
    if (activeSession.type === 'wrapped' && (!activeSession.ownerWs || isOwnerConnect)) {
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
          // Was the claimant required to prove it holds this instance's credential? False means
          // the session had no credential to check against — the residual, stated per event.
          claim_was_credentialed: Boolean(credentials && credentials.hasCredential(sessionId))
        });
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
                // ready-signal: cli.js bridge emitted a 'ready' WS frame.
                fireAutoReport(sessionId, activeSession, pendingReport, 'ready-signal');
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
      // #732 (H5 guard): clean up the LIVE record for the same reason the message handler
      // re-resolves it — cleaning only the connect-time snapshot would leave a replaced
      // record holding a closed ownerWs forever. The `ws === ownerWs` check below still
      // guarantees a stale socket can never tear down an owner it does not own.
      const activeSession = sessions[sessionId];
      if (!activeSession) return;
      activeSession.clients.delete(ws);
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

  // Shared upgrade handler. Attached to every provided listener so a cross-host attach reaching
  // the additive tailnet socket (daemon.js:4225) upgrades exactly like loopback — the auth check
  // (isAllowedPeer || token || jwt) is identical to the inject/read-screen HTTP path, so attach
  // gains no reach those already lack. Was bound to loopback only → tailnet WS fell through to
  // Express GET /api/sessions/:id → HTTP 200 ("Unexpected server response: 200").
  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://' + req.headers.host);
    const token = url.searchParams.get('token');

    if (isForbiddenOrigin(req.headers['origin'])) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const wsAuthHeader = req.headers['authorization'] || '';
    const wsJwtValid = wsAuthHeader.startsWith('Bearer ') && verifyJwt(wsAuthHeader.slice(7));
    if (!isAllowedPeer(req.socket.remoteAddress) && token !== expectedToken && !wsJwtValid) {
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
