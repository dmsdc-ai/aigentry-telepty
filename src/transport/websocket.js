'use strict';

const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

function isOpenWebSocket(ws) {
  return Boolean(ws && ws.readyState === 1);
}

function installWebSocketTransport(deps) {
  const {
    server,
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
    relayToPeers,
    busAutoRoute
  } = deps;

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
      initializeBootstrapState(autoSession);
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

  if (server) server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://' + req.headers.host);
    const token = url.searchParams.get('token');

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
  });

  return { wss, busWss };
}

module.exports = {
  installWebSocketTransport,
  isOpenWebSocket
};
