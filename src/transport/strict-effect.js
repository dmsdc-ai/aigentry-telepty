'use strict';
const crypto = require('node:crypto');
const {effectReceiptId}=require('../principal/receipt-key');
const { WebSocketServer } = require('ws');
const { parseUnambiguousJSON, bodyDigest } = require('../principal/encoding');
const { storedOwningPrincipal } = require('../principal/http');
const { createForwardLedger } = require('../peer-forwarding');
const { localSocket } = require('./strict-owner');
const { readResponse } = require('../broker/http');
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
    const receiptKey=(key,effect)=>effectReceiptId(adapter.namespace,adapter.defaultEffect?undefined:effect,principal,sessionId,epoch,key);
    const storageFailure=()=>{throw Object.assign(new Error('Stored effect receipt is inconsistent'),{code:'FORWARD_STORAGE_UNAVAILABLE'});};
    function view(record,effectName) {
      if(record.direction!==adapter.direction || record.session!==sessionId || record.expected_epoch!==epoch
        || (!adapter.defaultEffect && record.effect!==effectName))storageFailure();
      if(Object.hasOwn(record,'actor') && (!record.actor || typeof record.actor!=='object' || Array.isArray(record.actor) || record.actor.id!==principal.id || record.actor.key_id!==principal.keyId
        || record.actor.audience!==principal.audience || record.actor.source!=='ed25519'))storageFailure();
      const state=ledger.view(record).state,effect=adapter.effects[effectName],raw=record.remote_receipt;
      if(raw!==undefined && (!raw || typeof raw!=='object' || Array.isArray(raw)))storageFailure();
      const safe={};
      // Re-project only bounded result fields; persisted metadata cannot overwrite
      // the envelope, authoritative state, actor partition, or consumption facts.
      for(const field of ['success','queued','bootstrap_queued','delivered','retryable','delivery_uncertain','delivery_ack'])if(typeof raw?.[field]==='boolean')safe[field]=raw[field];
      if(typeof raw?.inject_id==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(raw.inject_id))safe.inject_id=raw.inject_id;
      if(typeof raw?.code==='string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(raw.code))safe.code=raw.code;
      if(raw?.bytes_written===null || (Number.isSafeInteger(raw?.bytes_written) && raw.bytes_written>=0))safe.bytes_written=raw.bytes_written;
      if(typeof raw?.publication_id==='string' && raw.publication_id.length<=128)safe.publication_id=raw.publication_id;
      if(Number.isSafeInteger(raw?.matched_socket_count) && raw.matched_socket_count>=0 && raw.matched_socket_count<=64)safe.matched_socket_count=raw.matched_socket_count;
      if(Number.isSafeInteger(raw?.seq) && raw.seq>=0)safe.seq=raw.seq;
      const projected=effect.project({ok:state==='accepted',status:state==='accepted'?200:['pending','outcome_unknown'].includes(state)?503:409},
        {...safe,session_id:sessionId,exact_target:true,semantic:{seq:safe.seq}},sessionId);
      if(state==='accepted' && (!projected.accepted || projected.uncertain))storageFailure();
      if(['pending','outcome_unknown'].includes(state)){projected.safe.success=false;projected.safe.retryable=false;delete projected.safe.delivered;delete projected.safe.queued;delete projected.safe.bootstrap_queued;}
      return {...projected.safe,schema:adapter.receiptSchema,receipt_id:record.receipt_id,state,
        ...(adapter.defaultEffect?{}:{effect:effectName}),session_id:sessionId,session_epoch:epoch,consumption:'unknown',reply:'unknown'};
    }
    async function processFrame(message) {
      let reserved,cacheSeen=false;
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
          const found=ledger.read(key);cacheSeen=!!found;return emit(found?view(found,effectName):{schema:adapter.receiptSchema,state:'not_found',session_id:sessionId,session_epoch:epoch});
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
        if(!reserved.fresh){cacheSeen=true;return emit(view(reserved.record,effectName));}
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
        ledger.write(result);emit(view(result,effectName));
      } catch(error) {
        emit({schema:adapter.receiptSchema,state:(reserved || cacheSeen)?'outcome_unknown':'refused',session_id:sessionId,session_epoch:epoch,success:false,...((reserved || cacheSeen)?{bytes_written:null,delivery_uncertain:true}:{}),
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
