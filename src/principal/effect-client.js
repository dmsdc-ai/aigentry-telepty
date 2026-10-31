'use strict';
const WebSocket = require('ws');
const {effectReceiptId}=require('./receipt-key');
const { createPrincipalClient, loadPrincipalClientConfiguration } = require('./client');
const { readAuthorityFile } = require('./authority-file');
const { parseUnambiguousJSON } = require('./encoding');
const uuidV4=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const failure=code=>Object.assign(new Error(code),{code});
async function runPrincipalEffect(profile,mode,parameters) {
  const code = suffix => `PRINCIPAL_${profile.code}_${suffix}`;
  const busReceipt = !profile.defaultEffect && mode === 'receipt';
  if(!['inject','receipt'].includes(mode) || parameters.length!==(busReceipt?10:8) || parameters[0]!=='--config'
    || parameters[2]!=='--session' || parameters[4]!=='--epoch'
    || (busReceipt ? parameters[6]!=='--effect' || parameters[8]!=='--key' : parameters[6]!== (mode==='inject'?'--request':'--key'))) throw failure(code('USAGE'));
  const [,file,,id,,epoch]=parameters, argument=parameters[busReceipt?9:7];
  if(!id || Buffer.byteLength(id)>128 || /[\/\\\x00-\x1f\x7f]/.test(id) || ['.','..'].includes(id)
    || !epoch || epoch.length>128)throw failure(code('TARGET_INVALID'));
  const configuration=loadPrincipalClientConfiguration(file);
  const client=createPrincipalClient(configuration);
  const request=mode==='inject'?parseUnambiguousJSON(readAuthorityFile(argument,{maximum:16384,privateFile:true})):{idempotency_key:argument,...(busReceipt?{effect:parameters[7]}:{})};
  if(!request || Array.isArray(request) || Object.keys(request).some(k=>!['idempotency_key','body',...(profile.defaultEffect?[]:['effect'])].includes(k))
    || typeof request.idempotency_key!=='string' || !/^[A-Za-z0-9_-]{16,128}$/.test(request.idempotency_key)
    || !Object.hasOwn(profile.effects,profile.defaultEffect || request.effect))throw failure(code('REQUEST_INVALID'));
  const effectName=profile.defaultEffect || request.effect, effect=profile.effects[effectName];
  const expectedReceipt=effectReceiptId(profile.namespace,profile.defaultEffect?undefined:effectName,
    {audience:configuration.principal.audience,id:configuration.principal.principal_id,keyId:configuration.principal.key_id},id,epoch,request.idempotency_key);
  if(mode==='inject' && (!request.body || typeof request.body!=='object' || Array.isArray(request.body)
    || (effect.kind==='inject' && request.body.exact_target!==true)
    || (effect.kind!=='state' && request.body.expected_epoch!==epoch)))throw failure(code('REQUEST_INVALID'));
  const target=profile.prefix+encodeURIComponent(id);
  const proof=await client.assertion({method:'GET',target,body:{},action:profile.action,sessionEpoch:epoch,transport:'websocket'});
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(client.daemonUrl.replace(/^http/,'ws')+target,{headers:{'x-telepty-principal':proof},handshakeTimeout:5000,maxPayload:32768,perMessageDeflate:false,followRedirects:false});
    const cancel=new AbortController();let sent=false,finished=false,identity=false,expiresAt=Date.now()+15000;
    let timer=setTimeout(()=>finish(failure(code('TIMEOUT'))),15000);
    function finish(error,result) {
      if(finished)return;finished=true;clearTimeout(timer);cancel.abort();ws.terminate();
      if(error && sent)return resolve({schema:profile.receiptSchema,state:'outcome_unknown',session_id:id,session_epoch:epoch,success:false,code:profile.code+'_CHANNEL_OUTCOME_UNKNOWN',retryable:false,bytes_written:null,consumption:'unknown',reply:'unknown',...(profile.defaultEffect?{}:{effect:effectName}),...(effect.kind==='publish'?{delivery_ack:false}:{})});
      error?reject(error):resolve(result);
    }
    ws.on('error',()=>finish(failure(code('CHANNEL_FAILED'))));
    ws.on('unexpected-response',(_req,res)=>{res.destroy();finish(failure(code('REFUSED')));});
    ws.on('close',()=>finish(failure(code('CHANNEL_CLOSED'))));
    ws.on('message',(bytes,binary)=>{void receive(bytes,binary);});
    async function receive(bytes,binary) {
      try {
        if(binary || finished || Date.now()>=expiresAt)throw failure(code('FRAME_INVALID'));
        const frame=parseUnambiguousJSON(bytes);
        if(!identity) {
          if(frame.schema!==profile.streamSchema || frame.session_id!==id || frame.session_epoch!==epoch || frame.mode!==profile.mode
            || !uuidV4.test(frame.connection_id || '') || !Number.isSafeInteger(frame.expires_at) || frame.expires_at<=Date.now() || frame.expires_at>Date.now()+61000)throw failure(code('IDENTITY_INVALID'));
          identity=true;expiresAt=Math.min(expiresAt,frame.expires_at);clearTimeout(timer);timer=setTimeout(()=>finish(failure(code('TIMEOUT'))),Math.max(1,expiresAt-Date.now()));
          const body=request.body;
          const assertion=mode==='inject'?await client.assertion({method:'POST',target:'/api/sessions/'+encodeURIComponent(id)+'/'+effect.suffix,body,action:effect.action,sessionEpoch:epoch,signal:cancel.signal}):undefined;
          if(finished || ws.readyState!==1 || Date.now()>=frame.expires_at)return finish(failure(code('EXPIRED')));
          sent=true;ws.send(JSON.stringify({type:mode==='inject'?effectName:'receipt',connection_id:frame.connection_id,sequence:1,idempotency_key:request.idempotency_key,
            ...(mode==='inject'?{body,assertion}:profile.defaultEffect?{}:{effect:effectName})}));
        } else {
          if(!sent || frame.schema!==profile.receiptSchema || frame.session_id!==id || frame.session_epoch!==epoch
            || !['accepted','failed','outcome_unknown','pending','refused','not_found'].includes(frame.state))throw failure(code('FRAME_INVALID'));
          if((frame.receipt_id!==undefined && frame.receipt_id!==expectedReceipt) || (frame.success===true && frame.state!=='accepted') || (frame.effect!==undefined && frame.effect!==effectName)
            || (frame.state==='accepted' && (frame.success!==true || frame.delivery_uncertain===true || !/^[a-f0-9]{64}$/.test(frame.receipt_id || '')
              || (!profile.defaultEffect && frame.effect!==effectName)
              || (effect.kind==='inject' && !/^[A-Za-z0-9_-]{1,128}$/.test(frame.inject_id || ''))
              || (effect.kind==='publish' && (!uuidV4.test(frame.publication_id || '') || !Number.isSafeInteger(frame.matched_socket_count) || frame.matched_socket_count<0 || frame.matched_socket_count>64 || frame.delivery_ack!==false)))))throw failure(code('FRAME_INVALID'));
          const receipt={schema:frame.schema,state:frame.state,session_id:id,session_epoch:epoch,consumption:'unknown',reply:'unknown',retryable:false,...(profile.defaultEffect?{}:{effect:effectName})};
          for(const field of ['success','queued','bootstrap_queued','delivered','delivery_uncertain'])if(typeof frame[field]==='boolean')receipt[field]=frame[field];
          if(/^[a-f0-9]{64}$/.test(frame.receipt_id || ''))receipt.receipt_id=frame.receipt_id;
          if(/^[A-Za-z0-9_-]{1,128}$/.test(frame.inject_id || ''))receipt.inject_id=frame.inject_id;
          if(/^[A-Z][A-Z0-9_]{0,95}$/.test(frame.code || ''))receipt.code=frame.code;
          if(frame.bytes_written===null || (Number.isSafeInteger(frame.bytes_written) && frame.bytes_written>=0))receipt.bytes_written=frame.bytes_written;
          if(effect.kind==='state' && Number.isSafeInteger(frame.seq) && frame.seq>=0)receipt.seq=frame.seq;
          if(effect.kind==='publish') {
            receipt.delivery_ack=false;
            if(uuidV4.test(frame.publication_id || ''))receipt.publication_id=frame.publication_id;
            if(Number.isSafeInteger(frame.matched_socket_count) && frame.matched_socket_count>=0 && frame.matched_socket_count<=64)receipt.matched_socket_count=frame.matched_socket_count;
          }
          if(frame.state==='outcome_unknown'){receipt.success=false;receipt.bytes_written=null;receipt.delivery_uncertain=true;delete receipt.delivered;delete receipt.queued;delete receipt.bootstrap_queued;}
          finish(undefined,receipt);
        }
      }catch{finish(failure(code('REQUEST_OR_CHANNEL_FAILED')));}
    }
  });
}
module.exports={runPrincipalEffect};
