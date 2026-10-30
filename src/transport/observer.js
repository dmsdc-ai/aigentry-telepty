'use strict';
const { storedOwningPrincipal } = require('../principal/http');
const { WebSocketServer } = require('ws');
// A separate, output-only fanout. Observers never enter session.clients or an owner protocol.
const subscribers = new WeakMap();
function publishSessionOutput(session, data) {
  for (const send of subscribers.get(session) || []) send(data);
}
function createObserverTransport({ authentication, sessions, server, tailnetServer, refuse, forbiddenOrigin, allowedPeer }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const active = new Set(), counts = new Map();
  let stopped = false;
  function handle(req, socket, head) {
    if (!authentication || !req.url?.startsWith('/api/observe/')) return false;
    const deny = (code, status = 403) => { refuse(socket, status, status === 401 ? 'Unauthorized' : 'Forbidden', code, 'Read-only observer refused.'); return true; };
    if (stopped) return deny('OBSERVER_SHUTDOWN', 503);
    if (forbiddenOrigin(req.headers.origin)) return deny('ORIGIN_NOT_ALLOWED');
    if (!allowedPeer(req.socket.remoteAddress)) return deny('PEER_NOT_ALLOWED');
    const proof = authentication.authorizeObserver(req);
    if (!proof.ok) return deny(proof.code, proof.status);
    const { session, sessionId, principal } = proof;
    const key = JSON.stringify([principal.audience, principal.id, sessionId]);
    if (active.size >= 64 || (counts.get(key) || 0) >= 8) return deny('OBSERVER_CAPACITY', 503);
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
    const send = data => {
      if (!current()) return close();
      if (typeof data !== 'string' || Buffer.byteLength(data) > 65536 || record.ws.bufferedAmount > 131072) return close();
      const frame = JSON.stringify({ type: 'output', data });
      if (Buffer.byteLength(frame) > 65536) return close();
      try { record.ws.send(frame, error => { if (error) close(); }); } catch { close(); }
    };
    socket.once('close', release); socket.once('error', release);
    try { wss.handleUpgrade(req, socket, head, ws => {
      record.ws = ws;
      ws.on('error', close); ws.on('close', release); ws.on('message', close);
      if (!current()) return close();
      timer = setInterval(() => { if (!current()) close(); }, 50); timer.unref();
      expiry = setTimeout(close, Math.max(1, expires - Date.now())); expiry.unref();
      ws.send(JSON.stringify({ type:'observer', schema:'telepty.read-only-observer/v1', session_id:sessionId, session_epoch:epoch, read_only:true, expires_at:expires }));
      let replay = '', bytes = 0;
      for (let i=(session.outputRing?.length || 0)-1, scanned=0;i>=0 && scanned<1024;i--,scanned++) {
        const chunk=session.outputRing[i]; if(typeof chunk !== 'string' || (bytes += Buffer.byteLength(chunk)) > 65536) break;
        replay=chunk+replay;
      }
      if (replay) send(replay);
      if (!current()) return close();
      if (!subscribers.has(session)) subscribers.set(session,new Set()); subscribers.get(session).add(send);
    }); } catch { close(); socket.destroy(); }
    return true;
  }
  const close = () => { stopped = true; for (const record of [...active]) record.close(); };
  for (const listener of [server, tailnetServer]) listener?.once('close', close);
  return { handle, wss, close };
}
module.exports = { createObserverTransport, publishSessionOutput };
