'use strict';
const WebSocket = require('ws');
const { createPrincipalClient, loadPrincipalClientConfiguration } = require('./client');
const { readAuthorityFile } = require('./authority-file');
const { parseUnambiguousJSON } = require('./encoding');
const failure=code=>Object.assign(new Error(code),{code});
async function runPrincipalInput(mode,parameters) {
  if(!['inject','receipt'].includes(mode) || parameters.length!==8 || parameters[0]!=='--config'
    || parameters[2]!=='--session' || parameters[4]!=='--epoch' || parameters[6]!== (mode==='inject'?'--request':'--key')) throw failure('PRINCIPAL_INPUT_USAGE');
  const [,file,,id,,epoch,,argument]=parameters;
  if(!id || Buffer.byteLength(id)>128 || /[\/\\\x00-\x1f\x7f]/.test(id) || ['.','..'].includes(id)
    || !epoch || epoch.length>128)throw failure('PRINCIPAL_INPUT_TARGET_INVALID');
  const client=createPrincipalClient(loadPrincipalClientConfiguration(file));
  const request=mode==='inject'?parseUnambiguousJSON(readAuthorityFile(argument,{maximum:16384,privateFile:true})):{idempotency_key:argument};
  if(!request || Array.isArray(request) || Object.keys(request).some(k=>!['idempotency_key','body'].includes(k))
    || typeof request.idempotency_key!=='string' || !/^[A-Za-z0-9_-]{16,128}$/.test(request.idempotency_key)
    || (mode==='inject' && (!request.body || request.body.exact_target!==true || request.body.expected_epoch!==epoch)))throw failure('PRINCIPAL_INPUT_REQUEST_INVALID');
  const target='/api/input/sessions/'+encodeURIComponent(id);
  const proof=await client.assertion({method:'GET',target,body:{},action:'session.input_stream',sessionEpoch:epoch,transport:'websocket'});
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(client.daemonUrl.replace(/^http/,'ws')+target,{headers:{'x-telepty-principal':proof},handshakeTimeout:5000,maxPayload:32768,perMessageDeflate:false,followRedirects:false});
    const cancel=new AbortController();let sent=false,finished=false,identity=false,expiresAt=Date.now()+15000;
    let timer=setTimeout(()=>finish(failure('PRINCIPAL_INPUT_TIMEOUT')),15000);
    function finish(error,result) {
      if(finished)return;finished=true;clearTimeout(timer);cancel.abort();ws.terminate();
      if(error && sent)return resolve({schema:'telepty.input-receipt/v1',state:'outcome_unknown',session_id:id,session_epoch:epoch,success:false,code:'INPUT_CHANNEL_OUTCOME_UNKNOWN',retryable:false,bytes_written:null,consumption:'unknown',reply:'unknown'});
      error?reject(error):resolve(result);
    }
    ws.on('error',()=>finish(failure('PRINCIPAL_INPUT_CHANNEL_FAILED')));
    ws.on('unexpected-response',(_req,res)=>{res.destroy();finish(failure('PRINCIPAL_INPUT_REFUSED'));});
    ws.on('close',()=>finish(failure('PRINCIPAL_INPUT_CHANNEL_CLOSED')));
    ws.on('message',(bytes,binary)=>{void receive(bytes,binary);});
    async function receive(bytes,binary) {
      try {
        if(binary || finished || Date.now()>=expiresAt)throw failure('PRINCIPAL_INPUT_FRAME_INVALID');
        const frame=parseUnambiguousJSON(bytes);
        if(!identity) {
          if(frame.schema!=='telepty.input-stream/v1' || frame.session_id!==id || frame.session_epoch!==epoch || frame.mode!=='signed-http-inject'
            || !/^[a-f0-9-]{36}$/.test(frame.connection_id || '') || !Number.isSafeInteger(frame.expires_at) || frame.expires_at<=Date.now() || frame.expires_at>Date.now()+61000)throw failure('PRINCIPAL_INPUT_IDENTITY_INVALID');
          identity=true;expiresAt=Math.min(expiresAt,frame.expires_at);clearTimeout(timer);timer=setTimeout(()=>finish(failure('PRINCIPAL_INPUT_TIMEOUT')),Math.max(1,expiresAt-Date.now()));
          const body=request.body;
          const assertion=mode==='inject'?await client.assertion({method:'POST',target:'/api/sessions/'+encodeURIComponent(id)+'/inject',body,action:'session.inject',sessionEpoch:epoch,signal:cancel.signal}):undefined;
          if(finished || ws.readyState!==1 || Date.now()>=frame.expires_at)return finish(failure('PRINCIPAL_INPUT_EXPIRED'));
          sent=true;ws.send(JSON.stringify({type:mode==='inject'?'inject':'receipt',connection_id:frame.connection_id,sequence:1,idempotency_key:request.idempotency_key,
            ...(mode==='inject'?{body,assertion}:{})}));
        } else {
          if(!sent || frame.schema!=='telepty.input-receipt/v1' || frame.session_id!==id || frame.session_epoch!==epoch
            || !['accepted','failed','outcome_unknown','pending','refused','not_found'].includes(frame.state))throw failure('PRINCIPAL_INPUT_FRAME_INVALID');
          const receipt={schema:frame.schema,state:frame.state,session_id:id,session_epoch:epoch,consumption:'unknown',reply:'unknown'};
          for(const field of ['success','queued','bootstrap_queued','delivered','retryable','delivery_uncertain'])if(typeof frame[field]==='boolean')receipt[field]=frame[field];
          if(/^[a-f0-9]{64}$/.test(frame.receipt_id || ''))receipt.receipt_id=frame.receipt_id;
          if(/^[A-Za-z0-9_-]{1,128}$/.test(frame.inject_id || ''))receipt.inject_id=frame.inject_id;
          if(/^[A-Z][A-Z0-9_]{0,95}$/.test(frame.code || ''))receipt.code=frame.code;
          if(frame.bytes_written===null || (Number.isSafeInteger(frame.bytes_written) && frame.bytes_written>=0))receipt.bytes_written=frame.bytes_written;
          finish(undefined,receipt);
        }
      }catch{finish(failure('PRINCIPAL_INPUT_REQUEST_OR_CHANNEL_FAILED'));}
    }
  });
}
module.exports={runPrincipalInput};
