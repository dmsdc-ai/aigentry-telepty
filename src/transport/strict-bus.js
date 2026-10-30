'use strict';
const { createStrictEffectTransport } = require('./strict-effect');
const { storedOwningPrincipal } = require('../principal/http');
const { injectEffect } = require('./strict-input');
function validStateBody(body) {
  return !!body && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).every(key => ['phase','current_task','blocker','needs_input','seq'].includes(key))
    && typeof body.phase === 'string' && body.phase.trim().length > 0 && Buffer.byteLength(body.phase) <= 128
    && ['current_task','blocker'].every(key => body[key] === undefined || body[key] === null || (typeof body[key] === 'string' && Buffer.byteLength(body[key]) <= 4096))
    && (body.needs_input === undefined || typeof body.needs_input === 'boolean')
    && (body.seq === undefined || (Number.isSafeInteger(body.seq) && body.seq >= 0));
}
function projectStateReceipt(response,remote,sessionId) {
  const valid=remote && typeof remote==='object' && !Array.isArray(remote);
  const accepted=response.ok && valid && remote.success===true && remote.session_id===sessionId;
  const uncertain=response.status>=500 || !valid || (response.ok && !accepted);
  const safe={success:accepted,retryable:false};
  if(accepted && Number.isSafeInteger(remote.semantic?.seq) && remote.semantic.seq>=0)safe.seq=remote.semantic.seq;
  if(valid && /^[A-Z][A-Z0-9_]{0,95}$/.test(remote.code || ''))safe.code=remote.code;
  if(uncertain){safe.success=false;safe.delivery_uncertain=true;}
  return {accepted,uncertain,safe};
}
function createStrictBusTransport(deps) {
  return createStrictEffectTransport(deps,{prefix:'/api/bus/',authorize:(auth,req)=>auth.authorizeBus(req),
    codePrefix:'BUS',refusalMessage:'Strict bus effects refused.',namespace:'strict-bus/v1',direction:'strict-bus',
    receiptSchema:'telepty.bus-effect-receipt/v1',streamSchema:'telepty.bus-effect-stream/v1',mode:'signed-http-session-effects',
    effects:{state_report:{action:'session.state',suffix:'state',validate:validStateBody,project:projectStateReceipt,
      preflight:(session,principal)=>{const owner=storedOwningPrincipal(session.owningPrincipal);
        return owner && owner.id===principal.id && owner.audience===principal.audience ? null : 'PRINCIPAL_SESSION_OWNER_REQUIRED';}},
      routed_turn:{...injectEffect,validate:(body,epoch)=>injectEffect.validate(body,epoch) && body.from===undefined && body.reply_to===undefined}}});
}
module.exports={createStrictBusTransport,validStateBody};
