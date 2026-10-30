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
// Shared signed HTTP effect adapter, never a raw PTY/viewer input ingress.
// The HTTP middleware remains the cryptographic/effect authority for every write.
function createStrictEffectTransport({ authentication, sessions, server, refuse, forbiddenOrigin, allowedPeer,
  homeDir, fetch: send = globalThis.fetch }, adapter) {
  const code = suffix => `${adapter.codePrefix}_${suffix}`;
  const wss = new WebSocketServer({ noServer:true, maxPayload:32768, perMessageDeflate:false });
  const ledger = createForwardLedger(homeDir), active = new Set(), counts = new Map();
  let stopped = false;
  function handle(req, socket, head) {
    if (!authentication || !req.url?.startsWith(adapter.prefix)) return false;
    const deny = (code,status=403) => { refuse(socket,status,'Forbidden',code,adapter.refusalMessage); return true; };
    if (stopped) return deny(code('SHUTDOWN'),503);
    if (forbiddenOrigin(req.headers.origin)) return deny('ORIGIN_NOT_ALLOWED');
    if (!allowedPeer(req.socket.remoteAddress) || !localSocket(req.socket)) return deny(code('SECURE_TRANSPORT_REQUIRED'));
    const proof = adapter.authorize(authentication, req);
    if (!proof.ok) return deny(proof.code,proof.status);
    let origin; try { origin=backendOrigin(server); } catch { return deny(code('BACKEND_UNAVAILABLE'),503); }
    const {session,sessionId,principal} = proof;
    const countKey=JSON.stringify([principal.keyId,sessionId]);
    if (active.size>=64 || (counts.get(countKey)||0)>=8) return deny(code('CAPACITY'),503);
    const epoch=session.sessionEpoch,generation=session.credentialGeneration,ownerWs=session.ownerWs,ownerGeneration=session.interactionOwnerGeneration;
    const owningPrincipal=JSON.stringify(storedOwningPrincipal(session.owningPrincipal));
    const expires=Math.min(proof.expiresAt,Date.now()+60000), connectionId=crypto.randomUUID();

    let ws,released=false,timer,expiry,sequence=0,frames=0,busy=false,operation;
    const record={close:()=>close()};active.add(record);counts.set(countKey,(counts.get(countKey)||0)+1);
    const current=()=>!released && !stopped && Date.now()<expires && Object.getOwnPropertyDescriptor(sessions,sessionId)?.value===session
      && !session.isClosing && session.sessionEpoch===epoch && session.credentialGeneration===generation && session.ownerWs===ownerWs
      && session.interactionOwnerGeneration===ownerGeneration && JSON.stringify(storedOwningPrincipal(session.owningPrincipal))===owningPrincipal;
    const release=()=>{if(released)return;released=true;clearInterval(timer);clearTimeout(expiry);operation?.abort();active.delete(record);
      const count=counts.get(countKey)-1;if(count)counts.set(countKey,count);else counts.delete(countKey);};
    const close=()=>{release();ws?.terminate();};
    const emit=body=>{if(!current() || ws.bufferedAmount>65536)return close();try{ws.send(JSON.stringify(body));}catch{close();}};
    const receiptKey=(key,effect)=>hash(canonicalJSON([adapter.namespace,...(adapter.defaultEffect ? [] : [effect]),principal.audience,principal.id,principal.keyId,sessionId,epoch,key]));
    const view=record=>({schema:adapter.receiptSchema,receipt_id:record.receipt_id,state:ledger.view(record).state,
      ...(adapter.defaultEffect ? {} : { effect:record.effect }),
      session_id:sessionId,session_epoch:epoch,...(record.remote_receipt || {}),consumption:'unknown',reply:'unknown'});
    async function processFrame(message) {
      let reserved;
      try {
        const effectName = message?.type === 'receipt' ? (adapter.defaultEffect || message.effect) : message?.type;
        const effect = adapter.effects[effectName];
        if (!message || !Object.hasOwn(adapter.effects, effectName) || message.connection_id!==connectionId
          || !Number.isSafeInteger(message.sequence) || message.sequence!==sequence+1 || ++frames>64 || busy || !current()
          || !validKey(message.idempotency_key)) return close();
        sequence=message.sequence;
        const key=receiptKey(message.idempotency_key,effectName);
        if(message.type==='receipt') {
          if(Object.keys(message).some(k=>!['type','connection_id','sequence','idempotency_key',...(adapter.defaultEffect ? [] : ['effect'])].includes(k)))return close();
          const found=ledger.read(key);return emit(found?view(found):{schema:adapter.receiptSchema,state:'not_found',session_id:sessionId,session_epoch:epoch});
        }
        if(Object.keys(message).some(k=>!['type','connection_id','sequence','idempotency_key','body','assertion'].includes(k)))return close();
        const body=message.body;
        if (!effect.validate(body,epoch)) return close();
        const target='/api/sessions/'+encodeURIComponent(sessionId)+'/'+effect.suffix;
        // Authenticate before any durable reservation. Inspect never consumes a nonce;
        // the actual HTTP middleware rechecks and consumes it before any effect.
        const checked=authentication.verifier.inspect(message.assertion,{method:'POST',target,bodySha256:bodyDigest(body),
          action:effect.action,grantTarget:sessionId,transport:'http',sessionEpoch:epoch});
        if(!checked.ok || checked.principal.keyId!==principal.keyId || checked.principal.id!==principal.id || checked.principal.audience!==principal.audience) {
          return emit({schema:adapter.receiptSchema,state:'refused',session_id:sessionId,session_epoch:epoch,success:false,code:checked.ok?code('SIGNER_MISMATCH'):checked.code,retryable:false,consumption:'unknown',reply:'unknown'});
        }
        const policyCode=effect.preflight?.(session,principal);
        if(policyCode)return emit({schema:adapter.receiptSchema,state:'refused',session_id:sessionId,session_epoch:epoch,
          success:false,code:policyCode,retryable:false,consumption:'unknown',reply:'unknown'});
        const fingerprint=adapter.defaultEffect ? bodyDigest(body) : bodyDigest({effect:effectName,target,body});
        reserved=ledger.reserve(key,fingerprint,{direction:adapter.direction,...(adapter.defaultEffect ? {} : { effect:effectName }),session:sessionId,expected_epoch:epoch,actor:{id:principal.id,key_id:principal.keyId,audience:principal.audience,source:'ed25519'}});
        if(!reserved.fresh)return emit(view(reserved.record));
        busy=true;ledger.active.add(key);operation=new AbortController();
        let result;
        try {
          if(!current())throw Error(code('INSTANCE_CHANGED'));
          const signal=require('../broker/http').combineAbortSignals([operation.signal,AbortSignal.timeout(5000)]);
          const response=await send(origin+target,{method:'POST',redirect:'error',signal,headers:{'content-type':'application/json','x-telepty-principal':message.assertion},body:JSON.stringify(body)});
          const remote=await readResponse(response,16384);
          const { accepted, uncertain, safe } = effect.project(response,remote,sessionId);
          result={...reserved.record,state:uncertain?'outcome_unknown':accepted?'accepted':'failed',remote_status:response.status,remote_receipt:safe};
        } catch {result={...reserved.record,state:'outcome_unknown',remote_receipt:{success:false,code:code('OUTCOME_UNKNOWN'),retryable:false,bytes_written:null,delivery_uncertain:true}};}
        ledger.write(result);emit(view(result));
      } catch(error) {
        emit({schema:adapter.receiptSchema,state:reserved?'outcome_unknown':'refused',session_id:sessionId,session_epoch:epoch,success:false,
          code:error.code==='IDEMPOTENCY_CONFLICT'?'IDEMPOTENCY_CONFLICT':code('STORAGE_UNAVAILABLE'),retryable:false,consumption:'unknown',reply:'unknown'});
      } finally {if(reserved?.fresh)ledger.active.delete(reserved.record.receipt_id);busy=false;operation=undefined;}
    }
    socket.once('close',release);socket.once('error',release);
    try {wss.handleUpgrade(req,socket,head,opened=>{
      ws=opened;ws.on('close',release);ws.on('error',close);ws.on('message',(bytes,binary)=>{if(binary)return close();let message;try{message=parseUnambiguousJSON(bytes);}catch{return close();}void processFrame(message);});
      timer=setInterval(()=>{if(!current())close();},50);timer.unref();expiry=setTimeout(close,Math.max(1,expires-Date.now()));expiry.unref();
      emit({schema:adapter.streamSchema,connection_id:connectionId,session_id:sessionId,session_epoch:epoch,expires_at:expires,mode:adapter.mode,max_frames:64});
    });}catch{close();socket.destroy();}
    return true;
  }
  const close=()=>{stopped=true;for(const record of [...active])record.close();};
  return{handle,close};
}
module.exports={createStrictEffectTransport,backendOrigin};
