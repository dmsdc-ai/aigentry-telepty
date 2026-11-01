'use strict';
const { createSignedAssertion, validTarget } = require('./proof');
const { parseUnambiguousJSON } = require('./encoding');
const { readAuthorityFile } = require('./authority-file');
const { loadLocalPrincipal, validateProgrammaticPrincipal } = require('../broker/local-principal');
const { origin, readResponse, combineAbortSignals } = require('../broker/http');
const failure = code => Object.assign(new Error(code), {code});
function loadPrincipalClientConfiguration(file) {
  const config=parseUnambiguousJSON(readAuthorityFile(file,{maximum:16384,privateFile:true}));
  const fields=['schema','daemon_url','principal_id','key_id','audience','private_key_path'];
  if (!config || Array.isArray(config) || Object.keys(config).length!==fields.length || Object.keys(config).some(k=>!fields.includes(k)) || config.schema!=='telepty.principal-client/v1') throw failure('PRINCIPAL_CLIENT_CONFIG_INVALID');
  const daemonUrl=origin(config.daemon_url);
  const principal=loadLocalPrincipal({principal_id:config.principal_id,key_id:config.key_id,audience:config.audience,private_key_path:config.private_key_path});
  return {daemonUrl,principal};
}
function createPrincipalClient({daemonUrl,principal,fetch:send=globalThis.fetch}) {
  const base=origin(daemonUrl), signer=validateProgrammaticPrincipal(principal);
  async function assertion({method,target,body,action,sessionEpoch,transport='http',signal}) {
    if (!validTarget(target)) throw failure('PRINCIPAL_CLIENT_TARGET_INVALID');
    const deadline=combineAbortSignals([...(signal?[signal]:[]),AbortSignal.timeout(5000)]);
    const response=await send(base+'/api/auth/challenge',{redirect:'error',signal:deadline});
    if (!response.ok) throw failure('PRINCIPAL_CHALLENGE_REFUSED');
    let challenge;
    try { challenge=await readResponse(response,4096); } catch { throw failure('PRINCIPAL_CHALLENGE_INVALID'); }
    if (!challenge || challenge.schema!=='telepty.principal-challenge/v1' || challenge.audience!==signer.audience || challenge.transport!=='http'
      || challenge.max_lifetime_seconds!==60 || challenge.identity_source!=='configured-ed25519-key' || !/^[A-Za-z0-9_-]{16,128}$/.test(challenge.challenge || '')) throw failure('PRINCIPAL_CHALLENGE_INVALID');
    return createSignedAssertion({privateKey:signer.privateKey,keyId:signer.key_id,principalId:signer.principal_id,audience:signer.audience,challenge:challenge.challenge,method,target,body,action,sessionEpoch,transport});
  }
  async function request(binding) {
    const signal=combineAbortSignals([...(binding.signal?[binding.signal]:[]),AbortSignal.timeout(5000)]);
    const proof=await assertion({...binding,signal,transport:'http'});
    return send(base+binding.target,{method:binding.method,redirect:'error',signal,headers:{'content-type':'application/json','x-telepty-principal':proof},
      ...(!['GET','HEAD'].includes(binding.method)?{body:JSON.stringify(binding.body)}:{})});
  }
  return Object.freeze({daemonUrl:base,assertion,request});
}
module.exports={loadPrincipalClientConfiguration,createPrincipalClient};
