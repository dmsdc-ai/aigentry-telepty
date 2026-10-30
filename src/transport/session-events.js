'use strict';
const { storedOwningPrincipal } = require('../principal/http');
const { WebSocketServer } = require('ws');
// A trusted daemon-only fanout. Never enroll sockets in legacy busClients or session.clients.
const APPROVED_TYPES = new Set(['session_connect', 'session_reconnect', 'session_disconnect', 'session_health',
  'session_state_report', 'session_takeover', 'session.idle', 'inject_failed', 'peer_inject_blocked',
  'mailbox_delivered', 'mailbox_delivery_failed', 'mailbox_delivery_unknown']);
function projectSessionEvent(session, sessionId, eventType, event) {
  if (!session || typeof session.sessionEpoch !== 'string' || !APPROVED_TYPES.has(eventType)) return null;
  const result = { schema: 'telepty.session-event/v1', type: eventType, session_id: sessionId,
    session_epoch: session.sessionEpoch, timestamp: new Date().toISOString(), observation_only: true,
    foreign_session_identity_verified: false };
  if (eventType === 'session_health' && ['CONNECTED', 'STALE', 'DISCONNECTED', 'UPSTREAM_STALLED'].includes(event?.transport?.health_status)) {
    result.health_status = event.transport.health_status;
  }
  return result;
}
const subscribers = new WeakMap();
function publishTrustedSessionEvent(session, sessionId, eventType, event) {
  const projected = projectSessionEvent(session, sessionId, eventType, event);
  if (!projected) return;
  for (const send of subscribers.get(session) || []) send(projected);
}
function createSessionEventTransport({ authentication, sessions, server, tailnetServer, refuse, forbiddenOrigin, allowedPeer }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const active = new Set(), counts = new Map();
  let stopped = false;
  function handle(req, socket, head) {
    if (!authentication || !req.url?.startsWith('/api/events/')) return false;
    const deny = (code, status = 403) => { refuse(socket, status, status === 401 ? 'Unauthorized' : 'Forbidden', code, 'Read-only session events refused.'); return true; };
    if (stopped) return deny('SESSION_EVENTS_SHUTDOWN', 503);
    if (forbiddenOrigin(req.headers.origin)) return deny('ORIGIN_NOT_ALLOWED');
    if (!allowedPeer(req.socket.remoteAddress)) return deny('PEER_NOT_ALLOWED');
    const proof = authentication.authorizeEvents(req);
    if (!proof.ok) return deny(proof.code, proof.status);
    const { session, sessionId, principal } = proof;
    const key = JSON.stringify([principal.audience, principal.id, sessionId]);
    if (active.size >= 64 || (counts.get(key) || 0) >= 8) return deny('SESSION_EVENTS_CAPACITY', 503);
    const record = { ws: null }; active.add(record); counts.set(key, (counts.get(key) || 0) + 1);
    const owningPrincipal = JSON.stringify(storedOwningPrincipal(session.owningPrincipal));
    const epoch = session.sessionEpoch, generation = session.credentialGeneration, owner = session.interactionOwnerGeneration, ownerWs = session.ownerWs;
    const expires = Math.min(proof.expiresAt, Date.now() + 60000);
    let released = false, timer, expiry;
    const current = () => !released && Date.now() < expires && Object.getOwnPropertyDescriptor(sessions, sessionId)?.value === session
      && !session.isClosing && JSON.stringify(storedOwningPrincipal(session.owningPrincipal)) === owningPrincipal && session.sessionEpoch === epoch && session.credentialGeneration === generation
      && session.interactionOwnerGeneration === owner && session.ownerWs === ownerWs;
    const release = () => { if (released) return; released = true; clearInterval(timer); clearTimeout(expiry); active.delete(record);
      const n = counts.get(key) - 1; if (n) counts.set(key,n); else counts.delete(key); subscribers.get(session)?.delete(send); };
    const close = () => { release(); record.ws?.terminate(); };
    record.close = close;
    const send = event => {
      if (event.session_id !== sessionId) return;
      if (!current()) return close();
      const frame = JSON.stringify(event);
      if (Buffer.byteLength(frame) > 4096 || record.ws.bufferedAmount + Buffer.byteLength(frame) > 131072) return close();
      try { record.ws.send(frame, error => { if (error) close(); }); } catch { close(); }
    };
    socket.once('close', release); socket.once('error', release);
    try { wss.handleUpgrade(req, socket, head, ws => {
      record.ws = ws;
      ws.on('error', close); ws.on('close', release); ws.on('message', close);
      if (!current()) return close();
      timer = setInterval(() => { if (!current()) close(); }, 50); timer.unref();
      expiry = setTimeout(close, Math.max(1, expires - Date.now())); expiry.unref();
      ws.send(JSON.stringify({ type:'session_events', schema:'telepty.read-only-session-events/v1', session_id:sessionId, session_epoch:epoch, read_only:true, expires_at:expires }));
      if (!current()) return close();
      if (!subscribers.has(session)) subscribers.set(session,new Set()); subscribers.get(session).add(send);
    }); } catch { close(); socket.destroy(); }
    return true;
  }
  const close = () => { stopped = true; for (const record of [...active]) record.close(); };
  for (const listener of [server, tailnetServer]) listener?.once('close', close);
  return { handle, wss, close };
}
module.exports = { createSessionEventTransport, publishTrustedSessionEvent, projectSessionEvent };
