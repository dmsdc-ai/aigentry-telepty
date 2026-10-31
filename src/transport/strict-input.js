'use strict';
const { createStrictEffectTransport, backendOrigin } = require('./strict-effect');
function validInjectBody(body,epoch) {
  return !(!body || Array.isArray(body) || Object.keys(body).some(k=>!['prompt','expected_epoch','exact_target','no_enter','from','reply_to','external_approval'].includes(k))
          || typeof body.prompt!=='string' || Buffer.byteLength(body.prompt)>4096 || body.exact_target!==true || body.expected_epoch!==epoch || typeof body.no_enter!=='boolean'
          || ['from','reply_to'].some(k=>body[k]!==undefined && (typeof body[k]!=='string' || Buffer.byteLength(body[k])>256 || /[\x00-\x1f\x7f]/.test(body[k]))));
}
function projectInjectReceipt(response,remote,sessionId) {
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
  return {accepted,uncertain,safe};
}
const injectEffect={action:'session.inject',suffix:'inject',validate:validInjectBody,project:projectInjectReceipt};
function createStrictInputTransport(deps) {
  return createStrictEffectTransport(deps, {prefix:'/api/input/',authorize:(auth,req)=>auth.authorizeInput(req),
    codePrefix:'INPUT',refusalMessage:'Strict input refused.',namespace:'strict-input/v1',direction:'strict-input',
    receiptSchema:'telepty.input-receipt/v1',streamSchema:'telepty.input-stream/v1',mode:'signed-http-inject',
    defaultEffect:'inject',effects:{inject:injectEffect}});
}
module.exports={createStrictInputTransport,backendOrigin,injectEffect};
