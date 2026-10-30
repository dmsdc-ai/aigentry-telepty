'use strict';
// Admission and transport dispatch are different observations. Neither is child
// write, agent consumption or a reply. Keep an admission if the process dies
// before the socket callback; never pre-label that attempt as forwarded.
function createViewerInputAuthorization({ classify, audit, broadcast, verifiedSenderFields,
  machineId, orchestratorSids, randomUUID, warn = console.warn }) {
  return function authorize({ sessionId, session, data, claimedFrom, principal }) {
    if(typeof data!=='string')return false;
    const injectId=randomUUID();
    const verdict=classify({from:claimedFrom,to:sessionId,prompt:data,orchestratorSids});
    const base={ts:new Date().toISOString(),inject_id:injectId,kind:'inject',source:'ws-viewer',
      claimed_from:claimedFrom || null,...verifiedSenderFields(principal),to:sessionId,to_alias:null,
      origin:'trusted-local',origin_host:machineId,ref_path:null,payload:data};
    if(verdict.decision==='block') {
      broadcast('peer_inject_blocked',sessionId,session,{extra:{target_agent:sessionId,from:claimedFrom || null,
        reason:verdict.reason,attempted_kind:verdict.kind,envelope_present:verdict.envelopePresent,inject_id:injectId}});
      warn(`[PEER-GUARD] blocked ws-viewer inject ${claimedFrom} → ${sessionId} (${verdict.reason})`);
      audit({...base,delivery_result:`blocked:${verdict.reason}`});return false;
    }
    audit({...base,source:'ws-viewer-admission',delivery_result:'authorized'});
    let finished=false;
    return {allowed:true,complete(error) {
      if(finished)return;finished=true;
      audit({...base,ts:new Date().toISOString(),delivery_result:error?'outcome_unknown':'forwarded'});
    }};
  };
}
// Boolean authorizers remain supported for existing transport construction sites.
function dispatchViewerInput({ authorization, deliver, invalidate, onFailure }) {
  if(!(authorization===true || (authorization && authorization.allowed===true)))return false;
  let finished=false;
  const complete=error=>{if(finished)return;finished=true;
    let failed=!!error;
    try{authorization.complete?.(error);}catch{failed=true;}
    if(failed){try{onFailure?.();}catch{}}
  };
  try{invalidate();deliver(complete);}catch(error){complete(error);}
  return true;
}
module.exports={createViewerInputAuthorization,dispatchViewerInput};
