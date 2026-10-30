'use strict';
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const { storedOwningPrincipal } = require('../principal/http');
const OWNER_FRAMES = new Set(['output', 'heartbeat', 'ready', 'session_died', 'session_restarted',
  'handoff_ack', 'interaction_provider', 'interaction_receipt', 'interaction_invalidated', 'ssh_state', 'ssh_write_receipt']);
const localSocket = socket => socket?.encrypted === true || ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(socket?.remoteAddress);
function createStrictOwnerTransport({ authentication, credentials, sessions, wss, refuse, forbiddenOrigin, allowedPeer }) {
  const ownerWss = new WebSocketServer({ noServer:true, maxPayload:131072, perMessageDeflate:false });
  const contexts = new WeakMap(); const active = new Set(); let stopped = false;
  function handle(req, socket, head) {
    if (!authentication || !req.url?.startsWith('/api/owner/')) return false;
    const deny = (code, status=403) => { refuse(socket,status,'Forbidden',code,'Strict owner refused.'); return true; };
    if (stopped) return deny('OWNER_SHUTDOWN',503);
    if (forbiddenOrigin(req.headers.origin)) return deny('ORIGIN_NOT_ALLOWED');
    if (!allowedPeer(req.socket.remoteAddress) || !localSocket(req.socket)) return deny('OWNER_SECURE_TRANSPORT_REQUIRED');
    if (active.size >= 64) return deny('OWNER_CAPACITY',503);
    const proof = authentication.authorizeOwner(req);
    if (!proof.ok) return deny(proof.code,proof.status);
    if (!credentials?.hasCredential(proof.sessionId) || !credentials.matches(proof.sessionId,req.headers['x-telepty-session-token'])) return deny('OWNER_BEARER_REQUIRED',401);
    const verified = credentials.verify(req.headers['x-telepty-session-token']);
    if (verified?.sid !== proof.sessionId || verified.epoch !== proof.session.sessionEpoch) return deny('OWNER_BEARER_REQUIRED',401);
    const session = proof.session, epoch=session.sessionEpoch, generation=session.credentialGeneration;
    const principal=JSON.stringify(storedOwningPrincipal(session.owningPrincipal));
    const expires=Math.min(proof.expiresAt,Date.now()+60000), connectionId=crypto.randomUUID();
    let ws, timer, expiry, bound=false, ownerGeneration, sequence=0, outboundSequence=0;
    const record={ close:()=>ws?.terminate() };active.add(record);
    const release=()=>{active.delete(record);clearInterval(timer);clearTimeout(expiry);};
    socket.once('close',release);socket.once('error',release);
    const current=()=>!stopped && Date.now()<expires && Object.getOwnPropertyDescriptor(sessions,proof.sessionId)?.value===session
      && !session.isClosing && session.sessionEpoch===epoch && session.credentialGeneration===generation
      && JSON.stringify(storedOwningPrincipal(session.owningPrincipal))===principal
      && (!bound || (session.ownerWs===ws && session.interactionOwnerGeneration===ownerGeneration));
    const close=()=>{release();ws?.terminate();};record.close=close;
    const context={session,sessionId:proof.sessionId,connectionId,current,
      bind(socketOwner){ if(!current() || session.ownerWs!==socketOwner)return false; bound=true;ownerGeneration=session.interactionOwnerGeneration;return true; },
      accept(msg){if(!bound || !current() || !msg || !OWNER_FRAMES.has(msg.type) || msg.connection_id!==connectionId
        || !Number.isSafeInteger(msg.sequence) || msg.sequence!==sequence+1 || (msg.type==='output' && (typeof msg.data!=='string' || Buffer.byteLength(msg.data)>65536))) {close();return false;}
        sequence=msg.sequence;return true;}};
    contexts.set(req,context);
    try {ownerWss.handleUpgrade(req,socket,head,socketOwner=>{
      ws=socketOwner;ws.on('close',release);ws.on('error',close);
      const send=ws.send.bind(ws);
      ws.send=(data,options,callback)=>{
        const reject=()=>{close();const error=Object.assign(new Error('STRICT_OWNER_SEND_REFUSED'),{code:'STRICT_OWNER_SEND_REFUSED'});
          const done=typeof options==='function'?options:callback;if(typeof done==='function'){done(error);return;}throw error;};
        if(!current() || ws.bufferedAmount>262144 || typeof data!=='string' || Buffer.byteLength(data)>131072)return reject();
        let frame;try{frame=JSON.parse(data);}catch{return reject();}
        if(require('../principal/cooperative-handoff').activeHandoff(session) && ['inject','resize','interaction','ssh_inject'].includes(frame.type))return reject();
        if(!bound && frame.type!=='owner_token')return reject();
        const encoded=JSON.stringify({...frame,connection_id:connectionId,sequence:outboundSequence+1,expires_at:expires});
        if(Buffer.byteLength(encoded)>131072)return reject();
        send(encoded,options,callback);outboundSequence++;
      };
      timer=setInterval(()=>{if(!current())close();},50);timer.unref();expiry=setTimeout(close,Math.max(1,expires-Date.now()));expiry.unref();
      wss.emit('connection',ws,req);
    });}catch{close();socket.destroy();}
    return true;
  }
  return {handle,context:req=>contexts.get(req),close:()=>{stopped=true;for(const record of [...active])record.close();}};
}
module.exports={createStrictOwnerTransport,localSocket};
