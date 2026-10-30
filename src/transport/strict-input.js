'use strict';
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const { parseUnambiguousJSON, canonicalJSON, bodyDigest } = require('../principal/encoding');
const { storedOwningPrincipal } = require('../principal/http');
const { createForwardLedger } = require('../peer-forwarding');
const { localSocket } = require('./strict-owner');
const { readResponse } = require('../broker/http');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const validKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
function backendOrigin(server) {
  const address = server?.address();
  if (!address || typeof address === 'string') throw Error('INPUT_BACKEND_UNAVAILABLE');
  const host = ['127.0.0.1','0.0.0.0'].includes(address.address) ? '127.0.0.1'
    : ['::1','::'].includes(address.address) ? '[::1]' : null;
  if (!host) throw Error('INPUT_BACKEND_UNAVAILABLE');
  return `${server instanceof require('node:https').Server ? 'https' : 'http'}://${host}:${address.port}`;
}
// This is a signed HTTP inject adapter, never a raw PTY/viewer input ingress.
// The HTTP middleware remains the cryptographic/effect authority for every write.
function createStrictInputTransport({ authentication, sessions, server, refuse, forbiddenOrigin, allowedPeer,
  homeDir, fetch: send = globalThis.fetch }) {
  const wss = new WebSocketServer({ noServer:true, maxPayload:32768, perMessageDeflate:false });
  const ledger = createForwardLedger(homeDir), active = new Set(), counts = new Map();
  let stopped = false;
  function handle(req, socket, head) {
    if (!authentication || !req.url?.startsWith('/api/input/')) return false;
    const deny = (code,status=403) => { refuse(socket,status,'Forbidden',code,'Strict input refused.'); return true; };
    if (stopped) return deny('INPUT_SHUTDOWN',503);
    if (forbiddenOrigin(req.headers.origin)) return deny('ORIGIN_NOT_ALLOWED');
    if (!allowedPeer(req.socket.remoteAddress) || !localSocket(req.socket)) return deny('INPUT_SECURE_TRANSPORT_REQUIRED');
    const proof = authentication.authorizeInput(req);
    if (!proof.ok) return deny(proof.code,proof.status);
    let origin; try { origin=backendOrigin(server); } catch { return deny('INPUT_BACKEND_UNAVAILABLE',503); }
    const {session,sessionId,principal} = proof;
    const countKey=JSON.stringify([principal.keyId,sessionId]);
    if (active.size>=64 || (counts.get(countKey)||0)>=8) return deny('INPUT_CAPACITY',503);
    const epoch=session.sessionEpoch,generation=session.credentialGeneration,ownerWs=session.ownerWs,ownerGeneration=session.interactionOwnerGeneration;
    const owningPrincipal=JSON.stringify(storedOwningPrincipal(session.owningPrincipal));
    const expires=Math.min(proof.expiresAt,Date.now()+60000), connectionId=crypto.randomUUID();
    const target='/api/sessions/'+encodeURIComponent(sessionId)+'/inject';
    let ws,released=false,timer,expiry,sequence=0,frames=0,busy=false,operation;
    const record={close:()=>close()};active.add(record);counts.set(countKey,(counts.get(countKey)||0)+1);
    const current=()=>!released && !stopped && Date.now()<expires && Object.getOwnPropertyDescriptor(sessions,sessionId)?.value===session
      && !session.isClosing && session.sessionEpoch===epoch && session.credentialGeneration===generation && session.ownerWs===ownerWs
      && session.interactionOwnerGeneration===ownerGeneration && JSON.stringify(storedOwningPrincipal(session.owningPrincipal))===owningPrincipal;
    const release=()=>{if(released)return;released=true;clearInterval(timer);clearTimeout(expiry);operation?.abort();active.delete(record);
      const count=counts.get(countKey)-1;if(count)counts.set(countKey,count);else counts.delete(countKey);};
    const close=()=>{release();ws?.terminate();};
    const emit=body=>{if(!current() || ws.bufferedAmount>65536)return close();try{ws.send(JSON.stringify(body));}catch{close();}};
    const receiptKey=key=>hash(canonicalJSON(['strict-input/v1',principal.audience,principal.id,principal.keyId,sessionId,epoch,key]));
    const view=record=>({schema:'telepty.input-receipt/v1',receipt_id:record.receipt_id,state:ledger.view(record).state,
      session_id:sessionId,session_epoch:epoch,...(record.remote_receipt || {}),consumption:'unknown',reply:'unknown'});
    async function input(message) {
      let reserved;
      try {
        if (!message || !['inject','receipt'].includes(message.type) || message.connection_id!==connectionId
          || !Number.isSafeInteger(message.sequence) || message.sequence!==sequence+1 || ++frames>64 || busy || !current()
          || !validKey(message.idempotency_key)) return close();
        sequence=message.sequence;
        const key=receiptKey(message.idempotency_key);
        if(message.type==='receipt') {
          if(Object.keys(message).some(k=>!['type','connection_id','sequence','idempotency_key'].includes(k)))return close();
          const found=ledger.read(key);return emit(found?view(found):{schema:'telepty.input-receipt/v1',state:'not_found',session_id:sessionId,session_epoch:epoch});
        }
        if(Object.keys(message).some(k=>!['type','connection_id','sequence','idempotency_key','body','assertion'].includes(k)))return close();
        const body=message.body;
        if(!body || Array.isArray(body) || Object.keys(body).some(k=>!['prompt','expected_epoch','exact_target','no_enter','from','reply_to','external_approval'].includes(k))
          || typeof body.prompt!=='string' || Buffer.byteLength(body.prompt)>4096 || body.exact_target!==true || body.expected_epoch!==epoch || typeof body.no_enter!=='boolean'
          || ['from','reply_to'].some(k=>body[k]!==undefined && (typeof body[k]!=='string' || Buffer.byteLength(body[k])>256 || /[\x00-\x1f\x7f]/.test(body[k]))))return close();
        // Authenticate before any durable reservation. Inspect never consumes a nonce;
        // the actual HTTP middleware rechecks and consumes it before any effect.
        const checked=authentication.verifier.inspect(message.assertion,{method:'POST',target,bodySha256:bodyDigest(body),
          action:'session.inject',grantTarget:sessionId,transport:'http',sessionEpoch:epoch});
        if(!checked.ok || checked.principal.keyId!==principal.keyId || checked.principal.id!==principal.id) {
          return emit({schema:'telepty.input-receipt/v1',state:'refused',success:false,code:checked.ok?'INPUT_SIGNER_MISMATCH':checked.code,retryable:false,consumption:'unknown',reply:'unknown'});
        }
        const fingerprint=bodyDigest(body);
        reserved=ledger.reserve(key,fingerprint,{direction:'strict-input',session:sessionId,expected_epoch:epoch,actor:{id:principal.id,key_id:principal.keyId,audience:principal.audience,source:'ed25519'}});
        if(!reserved.fresh)return emit(view(reserved.record));
        busy=true;ledger.active.add(key);operation=new AbortController();
        let result;
        try {
          if(!current())throw Error('INPUT_INSTANCE_CHANGED');
          const signal=require('../broker/http').combineAbortSignals([operation.signal,AbortSignal.timeout(5000)]);
          const response=await send(origin+target,{method:'POST',redirect:'error',signal,headers:{'content-type':'application/json','x-telepty-principal':message.assertion},body:JSON.stringify(body)});
          const remote=await readResponse(response,16384);
          const valid=remote && typeof remote==='object' && !Array.isArray(remote);
          const accepted=response.ok && valid && remote.success===true && remote.session_id===sessionId && remote.exact_target===true
            && typeof remote.inject_id==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(remote.inject_id);
          const uncertain=response.status>=500 || !valid || remote.delivery_uncertain===true || (response.ok && !accepted);
          const safe={};
          if(valid)for(const field of ['success','inject_id','queued','bootstrap_queued','delivered','retryable']) {
            if(typeof remote[field]==='boolean' || (field==='inject_id' && typeof remote[field]==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(remote[field])))safe[field]=remote[field];
          }
          if(valid && /^[A-Z][A-Z0-9_]{0,95}$/.test(remote.code || ''))safe.code=remote.code;
          if(valid && (remote.bytes_written===null || (Number.isSafeInteger(remote.bytes_written) && remote.bytes_written>=0)))safe.bytes_written=remote.bytes_written;
          safe.success=accepted;safe.retryable=false;
          if(uncertain){delete safe.delivered;delete safe.queued;delete safe.bootstrap_queued;safe.success=false;safe.bytes_written=null;safe.delivery_uncertain=true;}
          result={...reserved.record,state:uncertain?'outcome_unknown':accepted?'accepted':'failed',remote_status:response.status,remote_receipt:safe};
        } catch {result={...reserved.record,state:'outcome_unknown',remote_receipt:{success:false,code:'INPUT_OUTCOME_UNKNOWN',retryable:false,bytes_written:null,delivery_uncertain:true}};}
        ledger.write(result);emit(view(result));
      } catch(error) {
        emit({schema:'telepty.input-receipt/v1',state:reserved?'outcome_unknown':'refused',success:false,
          code:error.code==='IDEMPOTENCY_CONFLICT'?'IDEMPOTENCY_CONFLICT':'INPUT_STORAGE_UNAVAILABLE',retryable:false,consumption:'unknown',reply:'unknown'});
      } finally {if(reserved?.fresh)ledger.active.delete(reserved.record.receipt_id);busy=false;operation=undefined;}
    }
    socket.once('close',release);socket.once('error',release);
    try {wss.handleUpgrade(req,socket,head,opened=>{
      ws=opened;ws.on('close',release);ws.on('error',close);ws.on('message',(bytes,binary)=>{if(binary)return close();let message;try{message=parseUnambiguousJSON(bytes);}catch{return close();}void input(message);});
      timer=setInterval(()=>{if(!current())close();},50);timer.unref();expiry=setTimeout(close,Math.max(1,expires-Date.now()));expiry.unref();
      emit({schema:'telepty.input-stream/v1',connection_id:connectionId,session_id:sessionId,session_epoch:epoch,expires_at:expires,mode:'signed-http-inject',max_frames:64});
    });}catch{close();socket.destroy();}
    return true;
  }
  const close=()=>{stopped=true;for(const record of [...active])record.close();};
  return{handle,close};
}
module.exports={createStrictInputTransport,backendOrigin};
