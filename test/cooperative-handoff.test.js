'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {startTestDaemon,waitFor}=require('../test-support/daemon-harness');
const {createSignedAssertion}=require('../src/principal/proof');
// Task 1215 cleanup130: ONE owned-resource teardown for each daemon-backed fixture, registered BEFORE anything is acquired.
// node:test stops at the first throwing t.after (hooks128: hook1 ran, hook2 never), and a HOME removed under a live
// daemon raced its mailbox writer (linux126: ENOTEMPTY, then live daemon/child/server until the 20 min cancel).
//
// Dependency order:
//   1. owned child processes, the fixture allow child first: SIGKILL, then OBSERVE 'close'. The listener is attached
//      at registration and before the signal, and the wait is bounded by CHILD_CLOSE_BOUND_MS.
//   2. the CURRENT daemon (restart() may replace it): harness stop(), which is bounded, idempotent and throws when
//      incomplete.
//   3. case-owned sockets/servers.
//   4. HOME last.
//
// Every step is attempted even after an earlier one fails. The FIRST error object is rethrown after all steps, with a
// bounded fixed-shape list of the failed steps appended (step label, error name, code token), so a failed cleanup is
// never a pass. Nothing that is not registered here is touched.
const CHILD_CLOSE_BOUND_MS=5000;
function ownedTeardown(){
 const children=[],resources=[];let currentDaemon=()=>null,home=null;
 const closeChild=({child,state})=>new Promise((resolve,reject)=>{if(state.closed||child.pid===undefined)return resolve();let timer=null;const done=()=>{clearTimeout(timer);resolve();};child.once('close',done);timer=setTimeout(()=>{child.off('close',done);reject(Object.assign(new Error('CLEANUP_CHILD_CLOSE_TIMEOUT'),{code:'CLEANUP_CHILD_CLOSE_TIMEOUT'}));},CHILD_CLOSE_BOUND_MS);try{child.kill('SIGKILL');}catch{/* already gone: close is still observed */}});
 const token=(v,re)=>typeof v==='string'&&re.test(v)?v:null;
 return {
  child(label,child){if(child){const state={closed:false};child.once('close',()=>{state.closed=true;});children.push({label,child,state});}return child;},
  daemon(getter){currentDaemon=getter;},
  resource(label,dispose){resources.push({label,dispose});},
  home(dir){home=dir;return dir;},
  async run(){
   const failed=[];const step=async(label,fn)=>{try{await fn();}catch(error){failed.push({label,error});}};
   for(const entry of children)await step(entry.label,()=>closeChild(entry));
   await step('daemon',async()=>{const d=currentDaemon();if(d)await d.stop();});
   for(const {label,dispose} of resources)await step(label,dispose);
   await step('home',()=>{if(home)fs.rmSync(home,{recursive:true,force:true});});
   if(failed.length===0)return;
   const first=failed[0].error instanceof Error?failed[0].error:new Error('non-Error teardown failure');
   first.message+=` | cleanup130 teardown failed steps ${JSON.stringify(failed.slice(0,8).map(({label,error})=>({step:label,name:token(error&&error.name,/^[A-Za-z]{1,32}$/)||'other',code:token(error&&error.code,/^[A-Z][A-Z0-9_]{1,63}$/)})))}${failed.length>8?` (+${failed.length-8} more)`:''}`;
   throw first;
  }
 };
}
// Task 1215 cleanup132: bounded CLOSURE of owned servers and sockets, for coordinator resource steps.
// - Each observer is attached BEFORE its close is triggered.
// - Sockets are closed first (ws: terminate, net: destroy), then servers (close(cb), plus closeAllConnections for
//   owned http servers).
// - The promise resolves only when every passed socket has emitted 'close' and every passed server has completed
//   close. An already closed socket, or a server that was never or is no longer running, counts as closed.
// - Bound RESOURCE_CLOSE_BOUND_MS 5000; on expiry it fails with the typed CLEANUP_RESOURCE_CLOSE_TIMEOUT plus the
//   pending counts.
// Only the resources passed in are touched.
const RESOURCE_CLOSE_BOUND_MS=5000;
function closeOwnedResources({servers=[],sockets=[]}={}){
 const pending={sockets:0,servers:0},waits=[];
 const track=(kind,promise)=>{pending[kind]++;waits.push(promise.then(()=>{pending[kind]--;}));};
 for(const socket of sockets){
  if(!socket)continue;
  if(typeof socket.terminate==='function'){if(socket.readyState===3)continue;track('sockets',new Promise(resolve=>socket.once('close',()=>resolve())));socket.terminate();}
  else{if(socket.closed)continue;track('sockets',new Promise(resolve=>socket.once('close',()=>resolve())));socket.destroy();}
 }
 for(const server of servers){
  if(!server)continue;
  track('servers',new Promise((resolve,reject)=>server.close(error=>{if(!error||error.code==='ERR_SERVER_NOT_RUNNING'||/not running/i.test(error.message))resolve();else reject(error);})));
  if(typeof server.closeAllConnections==='function')server.closeAllConnections();
 }
 let timer=null;
 const bound=new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error(`CLEANUP_RESOURCE_CLOSE_TIMEOUT pending ${JSON.stringify(pending)}`),{code:'CLEANUP_RESOURCE_CLOSE_TIMEOUT'})),RESOURCE_CLOSE_BOUND_MS);});
 return Promise.race([Promise.all(waits),bound]).finally(()=>clearTimeout(timer));
}
// Task 1215 handoff137 (fixture correctness, test-only):
// - The fixture child's bearer is `${epoch}.${secret}` (16- and 32-byte base64url; session-credentials.js:27-28,60-62).
//   The child now publishes it atomically (temp file + rename), and the fixture accepts it only when it is COMPLETE.
//   Source-reachable race: a poll that lands between the file's creation and its write reads '', giving epoch '' and
//   an empty session_epoch that createSignedAssertion rejects (proof.js:74) with the same "Invalid principal assertion
//   input" the Linux CI reported. CI recorded neither the bearer bytes nor the epoch, so the original CI cause is
//   UNCONFIRMED; this race is the source-derived candidate, not a measured one.
// - A request the fixture deliberately HOLDS (an aterm UDS delivery whose reply the case withholds) is bounded by the
//   product's own UDS DELIVERY_TIMEOUT_MS (daemon.js:370, default 5000; this fixture sets no TELEPTY_DELIVERY_TIMEOUT_MS).
//   That equals the harness default request budget (daemon-harness.js:114), so the harness abort can race and hide the
//   product's own answer (source-derived; CI measured only the harness timeout at 5000/5001 ms). Per the harness
//   contract (daemon-harness.js:109-117) such a request opts into its product
//   bound + HARNESS_OBSERVATION_MARGIN_MS. This observes the product outcome; it changes no deadline.
const COMPLETE_BEARER=/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
function completeBearer(text){return typeof text==='string'&&COMPLETE_BEARER.test(text)?text:null;}
const HELD_DELIVERY_OBSERVATION_MS=5000+2000;
async function fixture(t,ignore=false){
 let daemon=null,child=null;const teardown=ownedTeardown();teardown.daemon(()=>daemon);t.after(()=>teardown.run());
 const home=teardown.home(fs.mkdtempSync(path.join(os.tmpdir(),'cooperative-fixture-')));const pair=crypto.generateKeyPairSync('ed25519');const trust=path.join(home,'trust.json'),key=path.join(home,'key.pem');
 fs.writeFileSync(key,pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});fs.writeFileSync(trust,JSON.stringify({schema:'telepty.principals/v1',audience:'fixture',keys:[{key_id:'owner',principal_id:'owner',authority:'operator',public_key_spki:pair.publicKey.export({type:'spki',format:'pem'}),grants:['session.register','session.owner','session.inspect','session.takeover','session.inject','session.rename','session.destroy'].map(action=>({action,targets:['fixture','moved']}))}]}),{mode:0o600});
 const senderPair=crypto.generateKeyPairSync('ed25519');const trusted=JSON.parse(fs.readFileSync(trust,'utf8'));trusted.keys.push({key_id:'sender',principal_id:'sender',public_key_spki:senderPair.publicKey.export({type:'spki',format:'pem'}),grants:[{action:'session.inject',targets:['fixture']}]});fs.writeFileSync(trust,JSON.stringify(trusted),{mode:0o600});
 const env={TELEPTY_PRINCIPAL_MODE:'strict',TELEPTY_PRINCIPAL_TRUST_FILE:trust,TELEPTY_MACHINE_ID:'fixture',TELEPTY_SESSION_STALE_SECONDS:'1',TELEPTY_SESSION_CLEANUP_SECONDS:'1',TELEPTY_HEALTH_POLL_MS:'100'};daemon=await startTestDaemon({homeDir:home,env});
 const config=path.join(home,'client.json');fs.writeFileSync(config,JSON.stringify({schema:'telepty.principal-client/v1',daemon_url:`http://${daemon.host}:${daemon.port}`,principal_id:'owner',key_id:'owner',audience:'fixture',private_key_path:key}),{mode:0o600});
 const credential=path.join(home,'child-proof');const program=`const fs=require('fs');${ignore?"process.on('SIGTERM',()=>{});":''}fs.writeFileSync(${JSON.stringify(credential+'.tmp')},process.env.TELEPTY_SESSION_TOKEN,{mode:0o600});fs.renameSync(${JSON.stringify(credential+'.tmp')},${JSON.stringify(credential)});setInterval(()=>{},1000);`;
 child=teardown.child('fixture-child',require('child_process').spawn(process.execPath,['--require','./test-support/setup-env.js','cli.js','allow','--id','fixture',process.execPath,'-e',program],{cwd:path.resolve(__dirname,'..'),env:{...process.env,HOME:home,TELEPTY_HOST:daemon.host,TELEPTY_PORT:String(daemon.port),TELEPTY_PRINCIPAL_CLIENT_FILE:config,TELEPTY_COOPERATIVE_HANDOFF:'1'},stdio:['ignore','pipe','pipe']}));let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
 let bearer=null;await waitFor(()=>{if(child.exitCode!==null)throw new Error(logs);bearer=fs.existsSync(credential)?completeBearer(fs.readFileSync(credential,'utf8')):null;return bearer!==null;});let epoch=bearer.split('.')[0];
 async function request(method,target,body,extra={}){const challenge=(await daemon.request('/api/auth/challenge',{noAuth:true})).body.challenge;const proof=createSignedAssertion({privateKey:extra.sender?senderPair.privateKey:pair.privateKey,keyId:extra.sender?'sender':'owner',principalId:extra.sender?'sender':'owner',audience:'fixture',challenge,method,target,body,action:extra.action || (target.endsWith('/inject')?'session.inject':'session.takeover'),sessionEpoch:extra.epoch||epoch});return daemon.request(target,{method,...(body?{body}:{}),headers:{'x-telepty-principal':proof,...(extra.sender?{}:{'x-telepty-session-token':extra.bearer||bearer})},...(extra.timeoutMs?{timeoutMs:extra.timeoutMs}:{})});}
 const target='/api/sessions/fixture/handoff';const status=()=>request('GET',target);const intent=async()=>{const response=await status();assert.equal(response.status,200,JSON.stringify(response.body));const s=response.body;return {intent_id:crypto.randomUUID(),expected_epoch:epoch,credential_generation:s.credential_generation,owner_generation:s.owner_generation};};
 return {home,config,child,teardown,bearer,epoch,request,status,intent,target,origin:`http://${daemon.host}:${daemon.port}`,logs:()=>logs,restart:async()=>{const port=daemon.port;await daemon.kill();daemon=await startTestDaemon({homeDir:home,port,env});}};
}
test('actual cooperative handoff waits for owned child exit, atomically rotates, and never retries a recorded intent',{skip:process.platform!=='linux',timeout:15000},async t=>{
 const f=await fixture(t),body=await f.intent();const result=await f.request('POST',f.target,body);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.state,'committed');assert.notEqual(result.body.session_epoch,f.epoch);assert.equal(result.body.credential_generation,2);assert.ok(result.body.session_token);await waitFor(()=>f.child.exitCode!==null);
 assert.ok(!f.logs().includes(result.body.session_token));const stale=await f.status();assert.equal(stale.status,401);
 const again=await f.request('POST',f.target,body,{epoch:result.body.session_epoch,bearer:result.body.session_token});assert.equal(again.body.code,'HANDOFF_ALREADY_RECORDED');assert.ok(!again.body.session_token);
 const proofFile=path.join(f.home,'handoff-receipt.json');fs.writeFileSync(proofFile,JSON.stringify({schema:'telepty.handoff-credential/v1',session_id:'fixture',origin:f.origin,session_epoch:result.body.session_epoch,session_token:result.body.session_token,session_nonce:result.body.session_nonce,credential_generation:2}),{mode:0o600});
 const goodProof=JSON.parse(fs.readFileSync(proofFile,'utf8'));
 for(const [name,change,mode,envChange] of [
  ['wrong-sid',{session_id:'other'},0o600,{}],['wrong-origin',{origin:'http://127.0.0.1:1'},0o600,{}],
  ['stale-epoch',{session_epoch:f.epoch,session_token:f.bearer},0o600,{}],['public-file',{},0o644,{}],
  ['no-cooperative',{},0o600,{TELEPTY_COOPERATIVE_HANDOFF:''}],['no-principal',{},0o600,{TELEPTY_PRINCIPAL_CLIENT_FILE:''}]
 ]){
  const invalidFile=path.join(f.home,'negative-'+name+'.json'),negativeMarker=path.join(f.home,'child-'+name);fs.writeFileSync(invalidFile,JSON.stringify({...goodProof,...change}),{mode});
  const attempt=require('child_process').spawn(process.execPath,['--require','./test-support/setup-env.js','cli.js','allow','--id','fixture',process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(negativeMarker)},'unsafe')`],{cwd:path.resolve(__dirname,'..'),env:{...process.env,HOME:f.home,TELEPTY_HOST:new URL(f.origin).hostname,TELEPTY_PORT:new URL(f.origin).port,TELEPTY_PRINCIPAL_CLIENT_FILE:f.config,TELEPTY_COOPERATIVE_HANDOFF:'1',TELEPTY_HANDOFF_CREDENTIAL_FILE:invalidFile,...envChange},stdio:['ignore','pipe','pipe']});
  let diagnostic='';attempt.stdout.on('data',b=>diagnostic+=b);attempt.stderr.on('data',b=>diagnostic+=b);
  const code=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{attempt.kill('SIGKILL');reject(new Error('Negative launch timed out: '+name));},5000);attempt.once('error',reject);attempt.once('exit',code=>{clearTimeout(timeout);resolve(code);});});assert.notEqual(code,0,name);assert.equal(fs.existsSync(negativeMarker),false,name);assert.ok(!diagnostic.includes(result.body.session_token),name);
 }
 // An older owner ACK lacking the explicit feature must fail before child startup.
 const http=require('node:http'),WebSocket=require('ws');const proxy=http.createServer((req,res)=>{const upstream=http.request(f.origin+req.url,{method:req.method,headers:req.headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});upstream.on('error',()=>res.destroy());req.pipe(upstream);});
 const proxyWss=new WebSocket.WebSocketServer({noServer:true});const proxySockets=new Set();proxy.on('upgrade',(req,socket,head)=>proxyWss.handleUpgrade(req,socket,head,down=>{proxySockets.add(down);const up=new WebSocket(f.origin.replace(/^http/,'ws')+req.url,{headers:req.headers});proxySockets.add(up);up.on('message',bytes=>{const message=JSON.parse(bytes);delete message.cooperative_handoff;if(down.readyState===1)down.send(JSON.stringify(message));});down.on('message',bytes=>{if(up.readyState===1)up.send(bytes);});up.on('error',()=>down.terminate());down.on('error',()=>up.terminate());down.on('close',()=>up.terminate());up.on('close',()=>down.terminate());}));
 f.teardown.resource('proxy-server',()=>closeOwnedResources({sockets:[...proxySockets],servers:[proxyWss,proxy]})); // cleanup132: registered before listen; awaits real closure
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 const proxyOrigin=`http://127.0.0.1:${proxy.address().port}`,oldConfig=path.join(f.home,'old-daemon-client.json'),oldProof=path.join(f.home,'old-daemon-proof.json'),oldMarker=path.join(f.home,'old-daemon-child');const originalConfig=JSON.parse(fs.readFileSync(f.config));fs.writeFileSync(oldConfig,JSON.stringify({...originalConfig,daemon_url:proxyOrigin}),{mode:0o600});fs.writeFileSync(oldProof,JSON.stringify({...goodProof,origin:proxyOrigin}),{mode:0o600});
 const unsupported=require('child_process').spawn(process.execPath,['--require','./test-support/setup-env.js','cli.js','allow','--id','fixture',process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(oldMarker)},'unsafe')`],{cwd:path.resolve(__dirname,'..'),env:{...process.env,HOME:f.home,TELEPTY_HOST:'127.0.0.1',TELEPTY_PORT:String(proxy.address().port),TELEPTY_PRINCIPAL_CLIENT_FILE:oldConfig,TELEPTY_COOPERATIVE_HANDOFF:'1',TELEPTY_HANDOFF_CREDENTIAL_FILE:oldProof},stdio:['ignore','pipe','pipe']});unsupported.stdout.resume();unsupported.stderr.resume();f.teardown.child('unsupported-child',unsupported);await waitFor(()=>unsupported.exitCode!==null);assert.notEqual(unsupported.exitCode,0);assert.equal(fs.existsSync(oldMarker),false);
 const marker=path.join(f.home,'successor-started');const successor=require('child_process').spawn(process.execPath,['--require','./test-support/setup-env.js','cli.js','allow','--id','fixture',process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(marker)},'started');setInterval(()=>{},1000)`],{cwd:path.resolve(__dirname,'..'),env:{...process.env,HOME:f.home,TELEPTY_HOST:new URL(f.origin).hostname,TELEPTY_PORT:new URL(f.origin).port,TELEPTY_PRINCIPAL_CLIENT_FILE:f.config,TELEPTY_COOPERATIVE_HANDOFF:'1',TELEPTY_HANDOFF_CREDENTIAL_FILE:proofFile},stdio:['ignore','pipe','pipe']});let successorLogs='';successor.stdout.on('data',b=>successorLogs+=b);successor.stderr.on('data',b=>successorLogs+=b);f.teardown.child('successor-child',successor);
 await waitFor(()=>{if(successor.exitCode!==null)throw new Error(successorLogs);return fs.existsSync(marker);});assert.ok(!successorLogs.includes(result.body.session_token));successor.kill('SIGKILL');await waitFor(()=>successor.signalCode!==null);

 await f.restart();const restored=await f.request('GET',f.target,undefined,{epoch:result.body.session_epoch,bearer:result.body.session_token});assert.equal(restored.body.state,'committed');
});
test('missing child-exit ACK never rotates and durable uncertainty refuses writes/restart recovery',{skip:process.platform!=='linux',timeout:15000},async t=>{
 const f=await fixture(t,true),body=await f.intent();const pending=f.request('POST',f.target,body);await waitFor(async()=> (await f.status()).body.state==='awaiting_ack');
 for(const operation of [
  ['PATCH','/api/sessions/fixture',{new_id:'moved'},'session.rename'],
  ['DELETE','/api/sessions/fixture',undefined,'session.destroy'],
  ['POST','/api/sessions/fixture/kill',{},'session.destroy'],
  ['POST','/api/sessions/register',{session_id:'fixture',owner_pid:999999},'session.register']]) {
   const denied=await f.request(operation[0],operation[1],operation[2],{action:operation[3]});assert.equal(denied.status,409,JSON.stringify(denied.body));assert.equal(denied.body.code,'HANDOFF_FENCED');
 }
 const inject=await f.request('POST','/api/sessions/fixture/inject',{prompt:'must-not-write',expected_epoch:f.epoch,exact_target:true,no_enter:true});assert.equal(inject.status,409);
 const result=await pending;assert.equal(result.body.state,'outcome_unknown');assert.equal(result.body.session_epoch,f.epoch);assert.ok(!result.body.session_token);
 await f.restart();await new Promise(resolve=>setTimeout(resolve,1300));assert.equal((await f.status()).body.state,'outcome_unknown');assert.equal(f.child.exitCode,null);assert.equal((await f.request('POST',f.target,{...body,intent_id:crypto.randomUUID()})).body.code,'HANDOFF_FENCED');
});
const {createCredentialStore}=require('../src/session-store/session-credentials');
const {createSessionRecordContext}=require('../src/routes/session-records');
const {validateTrustConfiguration}=require('../src/principal/proof');
const {createPrincipalAuthentication}=require('../src/principal/http');
const {registerCooperativeHandoff,activeHandoff}=require('../src/principal/cooperative-handoff');
const persistence=require('../src/session-store/persistence');
function unit(t,options={}) {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'handoff-unit-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const file=path.join(home,'sessions.json'),credentials=createCredentialStore(),issued=credentials.issue('fixture'),pair=crypto.generateKeyPairSync('ed25519');
 const session={id:'fixture',type:'wrapped',cooperativeHandoffCapable:true,sessionEpoch:issued.epoch,credentialVerifier:issued.verifier,credentialGeneration:1,owningPrincipal:{id:'owner',source:'ed25519',audience:'fixture'},interactionOwnerGeneration:crypto.randomUUID(),strictOwnerConnected:true};
 const sessions={fixture:session},context=createSessionRecordContext({sessions,sessionCredentials:credentials,sidNonces:new Map(),sessionPersistPath:file});context.persistSessions();const save=context.persistSessions;let saves=0,slowed=false;const saveMs=[];/* Task 1215 native65 OBS-H (diagnostics only): duration of each existing wrapper call, injected failures included; ≤ 8 entries; read only by assertion messages */
 /* Task 1215 windows121: each save's role is read from the handoff state AT CALL TIME (awaiting_ack=intent, committed=authority commit, outcome_unknown/refused=fence), and fault(n,role) is evaluated once per call, so a fault can target the commit by role instead of by ordinal. slowIntentMs (fixture seam): blocks ONLY the first intent save, synchronously, before the real save runs. */
 context.persistSessions=()=>{const began=performance.now();const n=saves+1;const state=session.cooperativeHandoff?.state;const role=state==='awaiting_ack'?'intent':state==='committed'?'commit':state==='outcome_unknown'||state==='refused'?'fence':'other';const injected=options.fault?.(n,role)||null;try{saves++;if(role==='intent'&&options.slowIntentMs&&!slowed){slowed=true;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,options.slowIntentMs);}if(injected==='before')return{ok:false,committed:false};const result=save();return injected==='after'?{ok:false,committed:true}:result;}finally{if(saveMs.length<8)saveMs.push({save:n,role,ms:Math.round((performance.now()-began)*10)/10,injected});}};
 let handler,api,stopped=0,late,ackAccepted=null;let messages=[];/* Task 1215 windows123: ackAccepted records whether the product accepted the fixture's incumbent ACK (diagnostics + preconditions only) */
 const ws={readyState:1,send:text=>{const request=JSON.parse(text);late={...request,type:'handoff_ack',status:options.refused?'refused':'exited',exit_code:0,exit_signal:null};options.beforeAck?.({session,sessions,messages,request});if(!options.noAck)setImmediate(()=>{ackAccepted=api.acceptAck('fixture',session,ws,late);});},close:()=>stopped++};session.ownerWs=ws;
 const trust=validateTrustConfiguration({schema:'telepty.principals/v1',audience:'fixture',keys:[{key_id:'owner',principal_id:'owner',public_key_spki:pair.publicKey.export({type:'spki',format:'pem'}),grants:[{action:'session.takeover',targets:['fixture']}]}]});const auth=createPrincipalAuthentication({trust,sessions});
 api=registerCooperativeHandoff({get:()=>{},post:(_p,h)=>handler=h},{context,getMailbox:()=>({snapshotCustody:()=>messages,withCustodySnapshot:(_id,callback)=>callback(messages)}),hasUnsettled:()=>!!options.unsettled,...(options.productionDeadline?{}:{timeoutMs:40})});
 const body={intent_id:crypto.randomUUID(),expected_epoch:issued.epoch,credential_generation:1,owner_generation:session.interactionOwnerGeneration};
 async function run(){const req={method:'POST',originalUrl:'/api/sessions/fixture/handoff',params:{id:'fixture'},body,principalRawBody:Buffer.from(JSON.stringify(body)),headers:{'x-telepty-session-token':issued.bearer}};req.headers['x-telepty-principal']=createSignedAssertion({privateKey:pair.privateKey,keyId:'owner',principalId:'owner',audience:'fixture',challenge:auth.verifier.challenge,method:'POST',target:req.originalUrl,body,action:'session.takeover',sessionEpoch:issued.epoch});assert.equal(auth.authorize(req).ok,true);const response={statusCode:200,status(c){this.statusCode=c;return this;},json(b){this.body=b;return this;}};await handler(req,response);return response;}
 return{run,session,sessions,credentials,issued,file,ws,late:()=>late,ack:()=>api.acceptAck('fixture',session,ws,late),stopped:()=>stopped,saveMs:()=>saveMs,ackAccepted:()=>ackAccepted};
}
test('handoff refuses unsettled work before requesting a stop',async t=>{const f=unit(t,{unsettled:true});const r=await f.run();assert.equal(r.body.code,'HANDOFF_PENDING_OR_UNKNOWN');assert.equal(f.late(),undefined);assert.equal(f.session.sessionEpoch,f.issued.epoch);});
// Task 1215 windows123 time semantics. Cases whose purpose needs a TIMELY, accepted incumbent response (an ACK followed by
// new pending work, an ACK after a generation change, an explicit refusal, and the windows121 commit faults) use the
// production ACK deadline (productionDeadline: no 40 ms override). Acceptance is pinned as a precondition, so a slow intent
// save can never satisfy them through the late/absent-ACK branch. The 40 ms fixture deadline stays, explicitly, for the
// genuine late/absent-ACK case (`noAck` below). It also stays for the deadline-independent cases: unsettled work and
// intent-save failure both return before any stop is sent or timer armed.
test('new pending work after child ACK prevents rotation and remains fenced',async t=>{const f=unit(t,{beforeAck:({messages})=>messages.push({msg_id:'late'}),productionDeadline:true});const r=await f.run();const evidence=JSON.stringify({code:r.body?.code??null,state:r.body?.state??null,ack_accepted:f.ackAccepted(),save_ms:f.saveMs()});assert.equal(f.ackAccepted(),true,'PRECONDITION: the incumbent ACK was accepted in time '+evidence);assert.equal(r.body.code,'HANDOFF_PENDING_OR_UNKNOWN','PRECONDITION: the post-ACK custody re-check refused '+evidence);assert.equal(r.body.state,'outcome_unknown');assert.ok(activeHandoff(f.session));assert.ok(f.credentials.verify(f.issued.bearer));});
test('late ACK and ACK after generation change cannot rotate a successor',async t=>{const f=unit(t,{noAck:true});await f.run();assert.equal(f.ack(),false);assert.equal(f.session.sessionEpoch,f.issued.epoch);const g=unit(t,{beforeAck:({session})=>session.interactionOwnerGeneration=crypto.randomUUID(),productionDeadline:true});const result=await g.run();assert.equal(g.ackAccepted(),true,'PRECONDITION: the ACK after the generation change was accepted in time '+JSON.stringify({code:result.body?.code??null,save_ms:g.saveMs()}));assert.equal(result.body.code,'HANDOFF_INSTANCE_CHANGED');assert.ok(g.credentials.verify(g.issued.bearer));});
// Task 1215 windows121: the commit fault is aimed at the authority-commit save by role. These success-setup cases use the
// production ACK deadline (no 40 ms override; they do not test expiry), and the semantic save order is pinned BEFORE the
// status, so an ACK refused as late fails as a precondition, never as a wrong-branch status. The slow-intent variant
// blocks only the first intent save for 80 ms (> the old 40 ms window) and must still reach the commit-failure branch.
for(const fault of ['before','after'])for(const slowIntentMs of [0,80])test(`authority commit ${fault} rename discloses no new bearer${slowIntentMs?' after a slow intent save':''}`,async t=>{const f=unit(t,{fault:(_n,role)=>role==='commit'?fault:null,productionDeadline:true,slowIntentMs});const r=await f.run();const evidence=JSON.stringify({code:r.body?.code??null,state:r.body?.state??null,save_ms:f.saveMs()});
 assert.deepEqual(f.saveMs().map(s=>s.injected?`${s.role}-injected-${s.injected}`:s.role),fault==='before'?['intent','commit-injected-before','fence']:['intent','commit-injected-after'],'PRECONDITION: semantic save order of the authority-commit branch '+evidence);
 if(slowIntentMs)assert.ok(f.saveMs()[0].ms>40,'PRECONDITION: the delayed intent save outlasted the 40 ms fixture window '+evidence);
 assert.equal(r.statusCode,503,evidence);assert.ok(!r.body.session_token);assert.equal(!!f.credentials.verify(f.issued.bearer),fault==='before');if(fault==='after')assert.notEqual(persistence.loadPersistedSessions(f.file).fixture.sessionEpoch,f.issued.epoch);});
test('intent save failure sends no stop, and explicit incumbent refusal does not rotate',async t=>{const f=unit(t,{fault:n=>n===1?'before':null});const r0=await f.run();assert.equal(r0.statusCode,503,JSON.stringify({code:r0.body?.code??null,state:r0.body?.state??null,save_ms:f.saveMs()}));assert.equal(f.late(),undefined);await refusal(t,0);});
// Task 1215 windows123: an explicit incumbent refusal needs a timely response. It uses the production ACK deadline; the
// accepted refusal and the save order [intent, fence (the refused record)] are pinned before the outcome. slowIntentMs 80
// blocks only the first intent save (> the 40 ms fixture window that made Windows 41268741202 report outcome_unknown).
async function refusal(t,slowIntentMs){const g=unit(t,{refused:true,productionDeadline:true,slowIntentMs});const r=await g.run();const evidence=JSON.stringify({code:r.body?.code??null,state:r.body?.state??null,ack_accepted:g.ackAccepted(),save_ms:g.saveMs()});
 assert.equal(g.ackAccepted(),true,'PRECONDITION: the incumbent refusal was accepted in time '+evidence);
 assert.deepEqual(g.saveMs().map(s=>s.injected?`${s.role}-injected-${s.injected}`:s.role),['intent','fence'],'PRECONDITION: semantic save order of the refusal branch '+evidence);
 if(slowIntentMs)assert.ok(g.saveMs()[0].ms>40,'PRECONDITION: the delayed intent save outlasted the 40 ms fixture window '+evidence);
 assert.equal(r.body.state,'refused',evidence);assert.equal(r.statusCode,409,evidence);assert.equal(r.body.code,'HANDOFF_INCUMBENT_REFUSED',evidence);assert.ok(!r.body.session_token);
 assert.equal(activeHandoff(g.session),false);assert.ok(g.credentials.verify(g.issued.bearer));assert.equal(g.session.sessionEpoch,g.issued.epoch);assert.equal(g.session.credentialGeneration,1);}
test('explicit incumbent refusal after a slow intent save is truthful and rotates nothing',async t=>{await refusal(t,80);});

test('present corrupt handoff fields and malformed committed reports restore a durable unknown fence',()=>{
 const base={type:'wrapped',command:'node',sessionEpoch:'a'.repeat(22),credentialGeneration:1};
 for(const bad of [false,0,'',null,{}, {state:'committed',id:crypto.randomUUID(),next_epoch:base.sessionEpoch,generation:0}]){
  const serialized=persistence.serializePersistedSessions({fixture:{id:'fixture',...base,cooperativeHandoff:bad}}).fixture;
  const restored=persistence.buildRestoredWrappedSession('fixture',serialized);assert.equal(activeHandoff(restored),true);assert.equal(restored.cooperativeHandoff.invalid,true);
  const again=persistence.serializePersistedSessions({fixture:restored}).fixture;assert.equal(activeHandoff(persistence.buildRestoredWrappedSession('fixture',again)),true);
 }
 const corruptAudit=persistence.buildRestoredWrappedSession('fixture',{...base,cooperativeHandoffAudit:[{state:'committed'}]});assert.equal(activeHandoff(corruptAudit),true);
 assert.equal(activeHandoff(persistence.buildRestoredWrappedSession('fixture',base)),false);
});
test('custody transaction holds the mailbox lock through its synchronous commit callback',t=>{
 const {FileMailbox}=require('../src/mailbox');const root=fs.mkdtempSync(path.join(os.tmpdir(),'handoff-lock-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const mailbox=new FileMailbox({root});mailbox.initializeCustody('fixture');
 mailbox.withCustodySnapshot('fixture',snapshot=>{assert.equal(snapshot.length,0);assert.throws(()=>mailbox.enqueue({msg_id:'blocked',from:'sender',to:'fixture',payload:'synthetic',created_at:1}),/lock timeout/i);});
 const created=Math.floor(Date.now()/1000);mailbox.enqueue({msg_id:'after',from:'original-sender',to:'fixture',payload:'synthetic',created_at:created});const rows=mailbox.snapshotCustody('fixture');assert.equal(rows[0].from,'original-sender');assert.equal(rows[0].created_at,created);
});
test('pending handoff fences retained bridge write timers while child-exit callbacks remain active',()=>{
 const {createAllowSecurityContext}=require('../src/cli/security-actions');let writes=0,acks=0,exits=0,exitCallback;const timers=[];
 const child={write:()=>writes++,onData:()=>{},onExit:callback=>exitCallback=callback};let delivered=false;
 const shared={child,handoffPending:null,allowSessionClosed:false,bridgePendingCount:1,bridgeTarget:'fixture',bridgeInjectTtlSecs:()=>300,
  filterBridgeBatch:batch=>({deliver:batch,dropped:[]}),bridgeMailbox:{dequeue:()=>{if(delivered)return null;delivered=true;return{msg_id:'one',payload:'must-not-write',created_at:1};},ack:()=>acks++,snapshotCustody:()=>[]}};
 const context=createAllowSecurityContext(shared,{setTimeout:callback=>{timers.push(callback);return callback;}});context.subscribeChild(child,()=>{},()=>exits++);
 context.flushBridgeMailbox();assert.equal(timers.length,1);assert.equal(context.cooperativeQueueEmpty(),false);shared.handoffPending={child};timers[0]();assert.equal(writes,0);assert.equal(acks,0);exitCallback({exitCode:0});assert.equal(exits,1);
});
for(const restart of [false,true])test(`explicit sender+owner pending consent preserves bytes and dispatches once${restart?' after private restart':''}`,{skip:process.platform!=='linux',timeout:16000},async t=>{
 const f=await fixture(t),net=require('node:net');const sockets=new Set();let held;const socketPath=path.join(f.home,'hold.sock');
 const server=net.createServer({allowHalfOpen:true},socket=>{sockets.add(socket);socket.on('data',()=>{held=socket;});socket.on('error',()=>{});});f.teardown.resource('case-socket-server',()=>closeOwnedResources({sockets:[...sockets],servers:[server]}));await new Promise(resolve=>server.listen(socketPath,resolve));
 const registered=await f.request('POST','/api/sessions/register',{session_id:'moved',command:'fixture',delivery_type:'aterm',delivery:{transport:'unix_socket',address:socketPath}},{action:'session.register'});assert.equal(registered.status,201,JSON.stringify(registered.body));
 const heldAt=Date.now();const blocking=f.request('POST','/api/sessions/moved/inject',{prompt:'hold-other-session',no_enter:true,exact_target:true,expected_epoch:registered.body.session_epoch},{action:'session.inject',epoch:registered.body.session_epoch,timeoutMs:HELD_DELIVERY_OBSERVATION_MS});await waitFor(()=>held);
 // handoff137: record when and how the held delivery ended (fixed fields only: ms since issue, HTTP status, code token)
 let blockingSettled=null;const codeToken=v=>typeof v==='string'&&/^[A-Z][A-Z0-9_]{1,63}$/.test(v)?v:null;blocking.then(r=>{blockingSettled={ms:Date.now()-heldAt,status:r.status,code:codeToken(r.body&&r.body.code)};},e=>{blockingSettled={ms:Date.now()-heldAt,status:null,code:codeToken(e&&e.code)||'other'};});
 const payload='pending-byte-exact-中😀';const response=await f.request('POST','/api/sessions/fixture/inject',{prompt:payload,no_enter:true,exact_target:true,expected_epoch:f.epoch,allow_cooperative_handoff:true},{sender:true});assert.equal(response.status,200,JSON.stringify(response.body));
 const secondPayload='second-pending-😀';assert.equal((await f.request('POST','/api/sessions/fixture/inject',{prompt:secondPayload,no_enter:true,exact_target:true,expected_epoch:f.epoch,allow_cooperative_handoff:true},{sender:true})).status,200);
 const {FileMailbox}=require('../src/mailbox');const mailbox=new FileMailbox({root:path.join(f.home,'.aigentry','mailbox')});const directory=path.join(f.home,'.aigentry','mailbox','fixture'),rows=mailbox.withNeverAttemptedCustody('fixture',rows=>rows);assert.equal(rows.length,2);assert.equal(rows[0].payload,payload);assert.equal(rows[0].from,'inject');assert.equal(rows[0].cooperative_handoff.sender.id,'sender');assert.equal(rows[0].cooperative_handoff.recipient.id,'owner');const before=['inbox.jsonl','state.jsonl'].map(leaf=>fs.readFileSync(path.join(directory,leaf),'utf8'));
 const body={...await f.intent(),pending_policy:'never-attempted'};const handed=await f.request('POST',f.target,body);
 // handoff137 PRECONDITION: the fixture premise is that the held moved delivery keeps the single-flight delivery tick busy
 // (delivery.js:81-83) until the handoff has answered. If the product's UDS bound ended the hold first, the pending rows
 // were no longer protected, and the outcome below would not be what this case tests.
 assert.equal(blockingSettled,null,'PRECONDITION: the held moved delivery outlasted the handoff (product UDS bound DELIVERY_TIMEOUT_MS 5000) '+JSON.stringify({handoff_answered_ms:Date.now()-heldAt,held_delivery:blockingSettled}));
 assert.equal(handed.status,200,JSON.stringify(handed.body));assert.equal(handed.body.pending_count,2);assert.match(handed.body.pending_digest,/^[a-f0-9]{64}$/);assert.deepEqual(['inbox.jsonl','state.jsonl'].map(leaf=>fs.readFileSync(path.join(directory,leaf),'utf8')),before);await waitFor(()=>f.child.exitCode!==null);
 held.end('{"success":true}\n');await blocking;if(restart)await f.restart();
 const receipt=path.join(f.home,'pending-successor.json'),output=path.join(f.home,'pending-child-output');fs.writeFileSync(receipt,JSON.stringify({schema:'telepty.handoff-credential/v1',session_id:'fixture',origin:f.origin,session_epoch:handed.body.session_epoch,session_token:handed.body.session_token,session_nonce:handed.body.session_nonce,credential_generation:2}),{mode:0o600});
 const successor=require('child_process').spawn(process.execPath,['--require','./test-support/setup-env.js','cli.js','allow','--id','fixture',process.execPath,'-e',`const fs=require('fs');process.stdin.setRawMode(true);process.stdin.on('data',data=>{fs.appendFileSync(${JSON.stringify(output)},data);process.stdout.write('> ');});process.stdin.resume();process.stdout.write('> ');setInterval(()=>{},1000)`],{cwd:path.resolve(__dirname,'..'),env:{...process.env,HOME:f.home,TELEPTY_HOST:new URL(f.origin).hostname,TELEPTY_PORT:new URL(f.origin).port,TELEPTY_PRINCIPAL_CLIENT_FILE:f.config,TELEPTY_COOPERATIVE_HANDOFF:'1',TELEPTY_HANDOFF_CREDENTIAL_FILE:receipt},stdio:['ignore','pipe','pipe']});let logs='';successor.stdout.on('data',b=>logs+=b);successor.stderr.on('data',b=>logs+=b);f.teardown.child('successor-child',successor);
 try{await waitFor(()=>{if(successor.exitCode!==null)throw new Error(logs);return fs.existsSync(output) && fs.readFileSync(output,'utf8')===payload+secondPayload;});}catch(error){throw new Error(JSON.stringify({error:error.message,logs,state:mailbox.messageState('fixture',rows[0].msg_id),dead:mailbox.peekDeadLetter('fixture').map(row=>({reason:row.reason,outcome:row.outcome})),event:JSON.parse(fs.readFileSync(path.join(f.home,'.config','aigentry-telepty','sessions.json'),'utf8')).fixture.cooperativeHandoff}));}assert.equal(fs.readFileSync(output,'utf8'),payload+secondPayload);await waitFor(()=>rows.every(row=>mailbox.messageState('fixture',row.msg_id)==='acked'));
 // Old message bytes cannot be reused as another transfer dispatch after compaction.
 require('../src/mailbox/storage').compact(directory,1);mailbox.enqueue(rows[0]);await waitFor(()=>mailbox.messageState('fixture',rows[0].msg_id)==='dead_letter');assert.equal(fs.readFileSync(output,'utf8'),payload+secondPayload);
});
test('an unconsented ordinary HTTP pending message cannot cross an owner epoch',{skip:process.platform!=='linux',timeout:12000},async t=>{
 const f=await fixture(t),net=require('node:net');let held;const socketPath=path.join(f.home,'unconsented.sock'),sockets=new Set();const server=net.createServer({allowHalfOpen:true},socket=>{sockets.add(socket);socket.on('data',()=>held=socket);socket.on('error',()=>{});});f.teardown.resource('case-socket-server',()=>closeOwnedResources({sockets:[...sockets],servers:[server]}));await new Promise(resolve=>server.listen(socketPath,resolve));
 const created=await f.request('POST','/api/sessions/register',{session_id:'moved',command:'fixture',delivery_type:'aterm',delivery:{transport:'unix_socket',address:socketPath}},{action:'session.register'});const blocker=f.request('POST','/api/sessions/moved/inject',{prompt:'block',no_enter:true,exact_target:true,expected_epoch:created.body.session_epoch},{action:'session.inject',epoch:created.body.session_epoch,timeoutMs:HELD_DELIVERY_OBSERVATION_MS});await waitFor(()=>held);
 assert.equal((await f.request('POST','/api/sessions/fixture/inject',{prompt:'unconsented',no_enter:true,exact_target:true,expected_epoch:f.epoch})).status,200);
 const result=await f.request('POST',f.target,{...await f.intent(),pending_policy:'never-attempted'});assert.equal(result.body.code,'HANDOFF_PENDING_OR_UNKNOWN');assert.equal(f.child.exitCode,null);held.end('{"success":true}\n');await blocker;
});
// Task 1215 cleanup130: deterministic regression of the ACTUAL ownedTeardown coordinator (no daemon, all platforms). It
// uses a real owned child and a real HOME. The CURRENT daemon's stop fails on purpose. Every later step must still run,
// the child must be closed before the daemon step, a replaced daemon must not be stopped, HOME must be removed last,
// and the original error object must be what run() rethrows.
// Task 1215 cleanup132: it also closes a REAL owned TCP server and its sockets through an ASYNC resource disposer
// (closeOwnedResources). The server's own 'close' event must be observed while HOME still exists and before the next
// resource step runs, so the coordinator provably awaited real closure. This exercises closure ordering only; it does
// not reproduce the whole Linux CI hang.
test('owned teardown attempts every step after a cleanup failure, removes HOME last, and keeps the first error',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'cooperative-teardown-'));fs.writeFileSync(path.join(home,'marker'),'x');
 const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','pipe','pipe']});child.stdout.resume();child.stderr.resume();
 let server=null,client=null;const accepted=new Set();
 t.after(()=>{try{child.kill('SIGKILL');}catch{}try{client&&client.destroy();}catch{}for(const socket of accepted){try{socket.destroy();}catch{}}try{server&&server.close();}catch{}fs.rmSync(home,{recursive:true,force:true});}); // safety net only; the coordinator under test owns all of these
 server=require('node:net').createServer(socket=>{accepted.add(socket);socket.on('error',()=>{});});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const connected=new Promise(resolve=>server.once('connection',()=>resolve()));client=require('node:net').connect(server.address().port,'127.0.0.1');client.on('error',()=>{});await connected;
 let childClosed=false;child.once('close',()=>{childClosed=true;});
 const order=[];const controlled=Object.assign(new Error('controlled daemon stop failure'),{code:'CONTROLLED_STOP_FAILURE'});
 const teardown=ownedTeardown();teardown.home(home);teardown.child('fixture-child',child);
 let daemon={stop:async()=>{order.push({step:'replaced-daemon'});}};teardown.daemon(()=>daemon);
 daemon={stop:async()=>{order.push({step:'daemon',child_closed:childClosed,home_present:fs.existsSync(home)});throw controlled;}}; // as restart() replaces it
 teardown.resource('server-a',()=>{order.push({step:'server-a',home_present:fs.existsSync(home)});throw new TypeError('second failure');});
 server.once('close',()=>{order.push({step:'owned-server-closed',home_present:fs.existsSync(home)});});
 teardown.resource('owned-server',()=>closeOwnedResources({sockets:[client,...accepted],servers:[server]}));
 teardown.resource('server-b',()=>{order.push({step:'server-b',home_present:fs.existsSync(home)});});
 let thrown=null;try{await teardown.run();}catch(error){thrown=error;}
 assert.equal(thrown,controlled,'the FIRST cleanup failure object is rethrown after every step');
 assert.ok(thrown.message.endsWith(` | cleanup130 teardown failed steps ${JSON.stringify([{step:'daemon',name:'Error',code:'CONTROLLED_STOP_FAILURE'},{step:'server-a',name:'TypeError',code:null}])}`),thrown.message);
 assert.deepEqual(order,[{step:'daemon',child_closed:true,home_present:true},{step:'server-a',home_present:true},{step:'owned-server-closed',home_present:true},{step:'server-b',home_present:true}],'child closed before the CURRENT daemon step; the async owned-server step was awaited to real closure before the next step; every later step ran with HOME still present');
 assert.equal(server.listening,false,'the owned server is closed');assert.ok(client.closed&&[...accepted].every(socket=>socket.closed),'every owned socket emitted close');
 assert.ok(child.exitCode!==null||child.signalCode!==null,'the owned child was terminated, not only signalled');
 assert.equal(fs.existsSync(home),false,'HOME was removed, and last');
});
// Task 1215 handoff137: deterministic regression of the fixture's credential acceptance (no daemon, all platforms). An
// EMPTY read of the child's credential file is a source-reachable race that reproduces the Linux CI error: epoch ''
// becomes session_epoch '', which the real proof constructor refuses. CI did not record the bearer bytes or epoch, so
// the original CI cause remains unconfirmed. The fixture must reject every empty or partial read and accept only the
// complete bearer.
test('fixture accepts only a complete published session bearer, never the empty or partial read that broke the Linux case',()=>{
 const epochPart='A'.repeat(22),secretPart='b'.repeat(43),full=`${epochPart}.${secretPart}`;
 for(const partial of ['',epochPart.slice(0,10),epochPart,`${epochPart}.`,`${epochPart}.${secretPart.slice(0,20)}`,`${full}\n`,` ${full}`])assert.equal(completeBearer(partial),null,`rejects a ${partial.length}-char partial read`);
 assert.equal(completeBearer(undefined),null);assert.equal(completeBearer(full),full);
 const sign=sessionEpoch=>createSignedAssertion({privateKey:crypto.generateKeyPairSync('ed25519').privateKey,keyId:'owner',principalId:'owner',audience:'fixture',challenge:'c'.repeat(32),method:'POST',target:'/api/sessions/register',body:{session_id:'moved'},action:'session.register',sessionEpoch});
 assert.throws(()=>sign(''.split('.')[0]),/Invalid principal assertion input/,'the empty read reproduces the exact CI error');
 assert.doesNotThrow(()=>sign(full.split('.')[0]),'the complete bearer epoch is a valid session_epoch for the same request');
});
