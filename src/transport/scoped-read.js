'use strict';
const { storedOwningPrincipal } = require('../principal/http');
const { WebSocketServer } = require('ws');
const { localSocket } = require('./strict-owner');
// Shared bounded reader lifecycle; each profile owns its separate publication map.
function createScopedReadTransport({ authentication, sessions, server, tailnetServer, refuse, forbiddenOrigin, allowedPeer }, profile) {
  const subscribers = profile.subscribers;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const active = new Set(), counts = new Map();
  let stopped = false;
  function handle(req, socket, head) {
    if (!authentication || !req.url?.startsWith(profile.prefix)) return false;
    const deny = (code, status = 403) => { refuse(socket, status, status === 401 ? 'Unauthorized' : 'Forbidden', code, profile.refusalMessage); return true; };
    if (stopped) return deny(`${profile.codePrefix}_SHUTDOWN`, 503);
    if (forbiddenOrigin(req.headers.origin)) return deny('ORIGIN_NOT_ALLOWED');
    if (!allowedPeer(req.socket.remoteAddress)) return deny('PEER_NOT_ALLOWED');
    if (profile.secureTransport && !localSocket(req.socket)) return deny(`${profile.codePrefix}_SECURE_TRANSPORT_REQUIRED`);
    const proof = profile.authorize(authentication,req);
    if (!proof.ok) return deny(proof.code, proof.status);
    const { session, sessionId, principal } = proof;
    const key = JSON.stringify([principal.audience, principal.id, sessionId]);
    if (active.size >= 64 || (counts.get(key) || 0) >= 8) return deny(`${profile.codePrefix}_CAPACITY`, 503);
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
      if (event.session_id !== sessionId) return false;
      if (!current()) { close(); return false; }
      const frame = JSON.stringify(event);
      if (Buffer.byteLength(frame) > profile.maxFrameBytes || record.ws.bufferedAmount + Buffer.byteLength(frame) > 131072) { close(); return false; }
      try { record.ws.send(frame, error => { if (error) close(); }); } catch { close(); return false; }
      return true;
    };
    socket.once('close', release); socket.once('error', release);
    try { wss.handleUpgrade(req, socket, head, ws => {
      record.ws = ws;
      ws.on('error', close); ws.on('close', release); ws.on('message', close);
      if (!current()) return close();
      timer = setInterval(() => { if (!current()) close(); }, 50); timer.unref();
      expiry = setTimeout(close, Math.max(1, expires - Date.now())); expiry.unref();
      ws.send(JSON.stringify({ type:profile.type, schema:profile.schema, session_id:sessionId, session_epoch:epoch, read_only:true, expires_at:expires }));
      if (!current()) return close();
      if (!subscribers.has(session)) subscribers.set(session,new Set()); subscribers.get(session).add(send);
    }); } catch { close(); socket.destroy(); }
    return true;
  }
  const close = () => { stopped = true; for (const record of [...active]) record.close(); };
  for (const listener of [server, tailnetServer]) listener?.once('close', close);
  return { handle, wss, close };
}
module.exports = { createScopedReadTransport };
