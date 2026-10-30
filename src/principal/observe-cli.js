'use strict';
const WebSocket = require('ws');
const { createPrincipalClient, loadPrincipalClientConfiguration } = require('./client');
const { parseUnambiguousJSON } = require('./encoding');
const failure=code=>Object.assign(new Error(code),{code});
async function runPrincipalObserver(parameters,{stdout=process.stdout,signal}={}) {
  if(parameters.length!==6 || parameters[0]!=='--config' || parameters[2]!=='--session' || parameters[4]!=='--epoch') throw failure('PRINCIPAL_OBSERVER_USAGE');
  const [,file,,id,,epoch]=parameters;
  if(typeof id!=='string' || !id || Buffer.byteLength(id)>128 || /[\/\\\x00-\x1f\x7f]/.test(id) || ['.','..'].includes(id)
    || typeof epoch!=='string' || !epoch || epoch.length>128) throw failure('PRINCIPAL_OBSERVER_TARGET_INVALID');
  if(signal?.aborted)throw failure('PRINCIPAL_OBSERVER_CANCELLED');
  const client=createPrincipalClient(loadPrincipalClientConfiguration(file));
  const target='/api/observe/sessions/'+encodeURIComponent(id);
  const proof=await client.assertion({method:'GET',target,body:{},action:'session.observe',sessionEpoch:epoch,transport:'websocket',signal});
  if(signal?.aborted)throw failure('PRINCIPAL_OBSERVER_CANCELLED');
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(client.daemonUrl.replace(/^http/,'ws')+target,{headers:{'x-telepty-principal':proof},handshakeTimeout:5000,maxPayload:65536,perMessageDeflate:false,followRedirects:false});
    let identity=false,finished=false,expires=Date.now()+60000;
    let timer=setTimeout(()=>finish(failure('PRINCIPAL_OBSERVER_EXPIRED')),60000);
    const abort=()=>finish(failure('PRINCIPAL_OBSERVER_CANCELLED'));
    function finish(error) { if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);stdout.off('error',outputError);ws.terminate();error?reject(error):resolve(); }
    const outputError=()=>finish(failure('PRINCIPAL_OBSERVER_OUTPUT_FAILED'));
    stdout.on('error',outputError);
    ws.on('error',()=>finish(failure('PRINCIPAL_OBSERVER_CHANNEL_FAILED')));
    ws.on('unexpected-response',(_req,res)=>{res.destroy();finish(failure('PRINCIPAL_OBSERVER_REFUSED'));});
    ws.on('close',()=>finish(identity?undefined:failure('PRINCIPAL_OBSERVER_IDENTITY_REQUIRED')));
    ws.on('message',(data,binary)=>{
      try {
        if(Date.now()>=expires)throw failure('PRINCIPAL_OBSERVER_EXPIRED');
        if(binary)throw failure('PRINCIPAL_OBSERVER_FRAME_INVALID');
        const frame=parseUnambiguousJSON(data);
        if(!identity) {
          if(frame.type!=='observer' || frame.schema!=='telepty.read-only-observer/v1' || frame.session_id!==id || frame.session_epoch!==epoch || frame.read_only!==true
            || !Number.isFinite(frame.expires_at) || frame.expires_at<=Date.now() || frame.expires_at>Date.now()+61000) throw failure('PRINCIPAL_OBSERVER_IDENTITY_INVALID');
          identity=true;expires=Math.min(expires,frame.expires_at);clearTimeout(timer);timer=setTimeout(()=>finish(failure('PRINCIPAL_OBSERVER_EXPIRED')),Math.max(1,expires-Date.now()));
        } else if(frame.type!=='output' || typeof frame.data!=='string' || Object.keys(frame).some(k=>!['type','data'].includes(k))) throw failure('PRINCIPAL_OBSERVER_FRAME_INVALID');
        if(!stdout.write(JSON.stringify(frame)+'\n'))throw failure('PRINCIPAL_OBSERVER_OUTPUT_BACKPRESSURE');
      } catch(error) {finish(error.code?error:failure('PRINCIPAL_OBSERVER_FRAME_INVALID'));}
    });
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
}
module.exports={runPrincipalObserver};
