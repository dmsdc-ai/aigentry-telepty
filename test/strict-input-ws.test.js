'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const {createPrincipalAuthentication}=require('../src/principal/http');const {validateTrustConfiguration,createSignedAssertion}=require('../src/principal/proof');
function fixture(){
 const key=crypto.generateKeyPairSync('ed25519'),other=crypto.generateKeyPairSync('ed25519');
 const entry=(id,pair,grants)=>({key_id:id,principal_id:id,public_key_spki:pair.publicKey.export({type:'spki',format:'pem'}),grants});
 const trust=validateTrustConfiguration({schema:'telepty.principals/v1',audience:'fixture',keys:[entry('writer',key,[{action:'session.input_stream',targets:['mine']},{action:'session.inject',targets:['mine']}]),entry('other',other,[{action:'session.inject',targets:['mine']}])]});
 const session={sessionEpoch:'epoch',credentialGeneration:1,owningPrincipal:{id:'owner',source:'ed25519',audience:'fixture'}};
 const authentication=createPrincipalAuthentication({trust,sessions:{mine:session}});
 const sign=extra=>createSignedAssertion({privateKey:key.privateKey,keyId:'writer',principalId:'writer',audience:'fixture',challenge:authentication.verifier.challenge,method:'GET',target:'/api/input/sessions/mine',body:{},action:'session.input_stream',transport:'websocket',sessionEpoch:'epoch',...extra});
 return{key,other,trust,session,authentication,sign};
}
test('input stream has exact independent grant and epoch, without inheriting observation or ownership',()=>{
 const f=fixture(),req=proof=>({method:'GET',url:'/api/input/sessions/mine',headers:{'x-telepty-principal':proof},rawHeaders:[]});
 assert.equal(f.authentication.authorizeInput(req(f.sign())).ok,true);
 assert.equal(f.authentication.authorizeInput(req(f.sign({sessionEpoch:'old'}))).ok,false);
 assert.equal(f.authentication.authorizeInput(req(f.sign({action:'session.inject'}))).ok,false);
 assert.equal(f.authentication.authorizeInput({...req(f.sign()),url:'/api/input/sessions/mine?token=secret'}).ok,false);
 const body={prompt:'one'},proof=f.sign({method:'POST',target:'/api/sessions/mine/inject',action:'session.inject',transport:'http',body});
 const binding={method:'POST',target:'/api/sessions/mine/inject',action:'session.inject',grantTarget:'mine',transport:'http',bodySha256:require('../src/principal/encoding').bodyDigest(body)};
 assert.equal(f.authentication.verifier.inspect(proof,binding).ok,true);assert.equal(f.authentication.verifier.inspect(proof,binding).ok,true);
 assert.equal(f.authentication.verifier.verify(proof,binding).ok,true);assert.equal(f.authentication.verifier.inspect(proof,binding).code,'PRINCIPAL_REPLAY');
});
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),WebSocket=require('ws');
const {startTestDaemon,waitFor}=require('../test-support/daemon-harness');
// #879: the strict daemon trust file and the client config/key/request files are read through readAuthorityFile —
// a Linux-only contract (src/principal/authority-file.js:15). Off Linux the refusal case at the end runs instead.
const {linuxOnly,nonLinuxOnly,assertStrictDaemonRefused}=require('../test-support/windows-879/linux-authority');
function open(url,proof){return new Promise(resolve=>{const ws=new WebSocket(url,{headers:{'x-telepty-principal':proof}}),messages=[];ws.on('message',b=>messages.push(JSON.parse(b)));ws.on('error',()=>{});ws.on('open',()=>resolve({ws,messages}));ws.on('unexpected-response',(_r,res)=>{res.resume();ws.terminate();resolve({status:res.statusCode});});});}
async function daemonFixture(t){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'strict-input-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const f=fixture(),owner=crypto.generateKeyPairSync('ed25519'),streamOnly=crypto.generateKeyPairSync('ed25519'),trustFile=path.join(home,'trust');
 fs.writeFileSync(trustFile,JSON.stringify({schema:'telepty.principals/v1',audience:'fixture',keys:[
  {key_id:'owner',principal_id:'owner',authority:'operator',public_key_spki:owner.publicKey.export({type:'spki',format:'pem'}),grants:['session.register','mailbox.read'].map(action=>({action,targets:['mine','protected']}))},
  {key_id:'writer',principal_id:'writer',public_key_spki:f.key.publicKey.export({type:'spki',format:'pem'}),grants:['session.input_stream','session.inject'].map(action=>({action,targets:['mine','protected']}))},
  {key_id:'stream-only',principal_id:'stream-only',public_key_spki:streamOnly.publicKey.export({type:'spki',format:'pem'}),grants:[{action:'session.input_stream',targets:['mine']}]},
  {key_id:'other',principal_id:'other',public_key_spki:f.other.publicKey.export({type:'spki',format:'pem'}),grants:[{action:'session.inject',targets:['mine']}]}
 ]}),{mode:0o600});
 const daemon=await startTestDaemon({homeDir:home,env:{TELEPTY_PRINCIPAL_MODE:'strict',TELEPTY_PRINCIPAL_TRUST_FILE:trustFile,TELEPTY_MACHINE_ID:'fixture'}});t.after(()=>daemon.stop());
 const challenge=(await daemon.request('/api/auth/challenge',{noAuth:true})).body.challenge;
 const sign=extra=>createSignedAssertion({privateKey:f.key.privateKey,keyId:'writer',principalId:'writer',audience:'fixture',challenge,method:'GET',target:'/api/input/sessions/mine',body:{},action:'session.input_stream',transport:'websocket',...extra});
 const ownerRequest=(method,target,body)=>daemon.request(target,{method,...(body?{body}:{}),headers:{'x-telepty-principal':sign({privateKey:owner.privateKey,keyId:'owner',principalId:'owner',method,target,body,action:method==='POST'?'session.register':'mailbox.read',transport:'http'})}});
 const registered=await ownerRequest('POST','/api/sessions/register',{session_id:'mine',delivery_type:'mailbox'});assert.equal(registered.status,201);
 return{...f,owner,streamOnly,home,daemon,sign,ownerRequest,epoch:registered.body.session_epoch};
}
test('actual strict input goes through signed inject and exact durable dedup without token fallback', {timeout:15000,skip:linuxOnly},async t=>{
 const f=await daemonFixture(t),target='/api/sessions/mine/inject',c=await open(`ws://${f.daemon.host}:${f.daemon.port}/api/input/sessions/mine`,f.sign({sessionEpoch:f.epoch}));assert.ok(c.ws,JSON.stringify(c));t.after(()=>c.ws.terminate());await waitFor(()=>c.messages.length);
 const identity=c.messages[0],body={prompt:'SYNTHETIC_INPUT',expected_epoch:f.epoch,exact_target:true,no_enter:true};
 const frame=(sequence,key,bodyArg=body,extra={})=>({type:'inject',connection_id:identity.connection_id,sequence,idempotency_key:key,body:bodyArg,assertion:f.sign({method:'POST',target,body:bodyArg,action:'session.inject',transport:'http',sessionEpoch:f.epoch,...extra})});
 const key='input-idempotency-0001';c.ws.send(JSON.stringify(frame(1,key)));await waitFor(()=>c.messages.length===2);assert.equal(c.messages[1].state,'accepted');assert.equal(c.messages[1].consumption,'unknown');assert.equal(c.messages[1].reply,'unknown');
 c.ws.send(JSON.stringify(frame(2,key)));await waitFor(()=>c.messages.length===3);assert.equal(c.messages[2].receipt_id,c.messages[1].receipt_id);
 const pending=(await f.ownerRequest('GET','/api/sessions/mine/mailbox')).body.pending;assert.equal(pending.length,1);assert.equal(pending[0].payload,'SYNTHETIC_INPUT');
 c.ws.send(JSON.stringify(frame(3,key,{...body,prompt:'conflict'})));await waitFor(()=>c.messages.length===4);assert.equal(c.messages[3].code,'IDEMPOTENCY_CONFLICT');
 c.ws.send(JSON.stringify(frame(4,'input-key-foreign-0002',body,{privateKey:f.other.privateKey,keyId:'other',principalId:'other'})));await waitFor(()=>c.messages.length===5);assert.equal(c.messages[4].code,'INPUT_SIGNER_MISMATCH');
 c.ws.send(JSON.stringify(frame(5,'input-forged-signature-0003',body,{privateKey:f.other.privateKey})));await waitFor(()=>c.messages.length===6);assert.equal(c.messages[5].state,'refused');
 const unprivileged=await open(`ws://${f.daemon.host}:${f.daemon.port}/api/input/sessions/mine`,f.sign({privateKey:f.streamOnly.privateKey,keyId:'stream-only',principalId:'stream-only',sessionEpoch:f.epoch}));t.after(()=>unprivileged.ws.terminate());await waitFor(()=>unprivileged.messages.length);
 unprivileged.ws.send(JSON.stringify({...frame(1,'input-no-grant-00004',body,{privateKey:f.streamOnly.privateKey,keyId:'stream-only',principalId:'stream-only'}),connection_id:unprivileged.messages[0].connection_id}));await waitFor(()=>unprivileged.messages.length===2);assert.equal(unprivileged.messages[1].code,'PRINCIPAL_GRANT_DENIED');
 assert.equal((await f.ownerRequest('GET','/api/sessions/mine/mailbox')).body.pending.length,1);
 const files=fs.readdirSync(path.join(f.home,'.telepty','forward-receipts'));assert.equal(files.length,1);const stored=fs.readFileSync(path.join(f.home,'.telepty','forward-receipts',files[0]),'utf8');assert.ok(!stored.includes('SYNTHETIC_INPUT'));assert.equal(JSON.parse(stored).actor.id,'writer');
});
const http=require('node:http');const {createStrictInputTransport,backendOrigin}=require('../src/transport/strict-input');
async function transportFixture(t,mode='ok') {
 const f=fixture(),home=fs.mkdtempSync(path.join(os.tmpdir(),'strict-input-wire-')),sessions={mine:f.session};let effects=0,transport;
 const server=http.createServer((req,res)=>{if(req.url==='/api/auth/challenge'){res.end(JSON.stringify(f.authentication.challengeDocument()));return;}const chunks=[];req.on('data',b=>chunks.push(b));req.on('end',()=>{
  req.principalRawBody=Buffer.concat(chunks);req.body=JSON.parse(req.principalRawBody);const auth=f.authentication.authorize(req);
  if(!auth.ok){res.writeHead(auth.status);res.end(JSON.stringify({success:false,code:auth.code}));return;}
  assert.equal(req.headers['x-telepty-token'],undefined);assert.ok(req.headers.host.startsWith('127.0.0.1:'));effects++;
  if(mode==='close-channel'){transport.close();return req.socket.destroy();}
  if(mode==='lost')return req.socket.destroy();
  res.writeHead(mode==='error'?503:200);res.end(mode==='invalid'?'bad JSON':JSON.stringify({success:true,session_id:'mine',exact_target:true,inject_id:crypto.randomUUID(),queued:true}));
 });});
 const install=()=>{transport=createStrictInputTransport({authentication:f.authentication,sessions,server,homeDir:home,refuse:(s,status)=>s.end(`HTTP/1.1 ${status} Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`),forbiddenOrigin:()=>false,allowedPeer:()=>true});};install();
 server.on('upgrade',(r,s,h)=>transport.handle(r,s,h));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{transport.close();server.closeAllConnections();server.close();fs.rmSync(home,{recursive:true,force:true});});
 const connect=async()=>{const c=await open(`ws://127.0.0.1:${server.address().port}/api/input/sessions/mine`,f.sign());assert.ok(c.ws);t.after(()=>c.ws.terminate());await waitFor(()=>c.messages.length);return c;};
 const frame=(c,seq,key,body={prompt:'PRIVATE_FIXTURE',expected_epoch:'epoch',exact_target:true,no_enter:true})=>({type:'inject',connection_id:c.messages[0].connection_id,sequence:seq,idempotency_key:key,body,assertion:f.sign({method:'POST',target:'/api/sessions/mine/inject',body,action:'session.inject',transport:'http'})});
 return{...f,sessions,home,server,connect,frame,effects:()=>effects,restart:()=>{transport.close();install();}};
}
for(const mode of ['lost','error','invalid'])test(`input ${mode} response stays unknown across reconnect and adapter restart`,{timeout:10000},async t=>{
 const f=await transportFixture(t,mode);let c=await f.connect();const key='input-unknown-'+mode+'-0001';c.ws.send(JSON.stringify(f.frame(c,1,key)));await waitFor(()=>c.messages.length===2);
 assert.equal(c.messages[1].state,'outcome_unknown');assert.equal(c.messages[1].bytes_written,null);assert.equal(c.messages[1].retryable,false);assert.equal(c.messages[1].success,false);assert.equal(c.messages[1].queued,undefined);
 f.restart();c=await f.connect();c.ws.send(JSON.stringify(f.frame(c,1,key)));await waitFor(()=>c.messages.length===2);assert.equal(c.messages[1].state,'outcome_unknown');assert.equal(f.effects(),1);
 c.ws.send(JSON.stringify({type:'receipt',sequence:2,connection_id:c.messages[0].connection_id,idempotency_key:key}));await waitFor(()=>c.messages.length===3);assert.equal(c.messages[2].state,'outcome_unknown');
 const stored=fs.readdirSync(path.join(f.home,'.telepty','forward-receipts')).map(file=>fs.readFileSync(path.join(f.home,'.telepty','forward-receipts',file),'utf8')).join('');assert.ok(!stored.includes('PRIVATE_FIXTURE'));
});
test('input rejects stale identity, protocol frames and caller-selected backend locations',async t=>{
 const f=await transportFixture(t);const c=await f.connect();f.session.credentialGeneration++;
 c.ws.send(JSON.stringify(f.frame(c,1,'input-stale-instance-0001')));await waitFor(()=>c.ws.readyState===3);assert.equal(f.effects(),0);
 const d=await f.connect();d.ws.send(JSON.stringify({type:'input',data:'raw bypass',sequence:1,connection_id:d.messages[0].connection_id,idempotency_key:'input-raw-bypass-00001'}));await waitFor(()=>d.ws.readyState===3);assert.equal(f.effects(),0);
 for(const address of [null,'/tmp/foreign.sock',{address:'192.0.2.1',port:1234}])assert.throws(()=>backendOrigin({address:()=>address}),/INPUT_BACKEND_UNAVAILABLE/);
});
test('actual input CLI and receipt query preserve one write and never create or use a shared client token', {timeout:15000,skip:linuxOnly},async t=>{
 const f=await daemonFixture(t),clientHome=fs.mkdtempSync(path.join(os.tmpdir(),'strict-input-cli-'));t.after(()=>fs.rmSync(clientHome,{recursive:true,force:true}));
 const key=path.join(clientHome,'key'),config=path.join(clientHome,'config'),request=path.join(clientHome,'request');
 fs.writeFileSync(key,f.key.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
 fs.writeFileSync(config,JSON.stringify({schema:'telepty.principal-client/v1',daemon_url:`http://${f.daemon.host}:${f.daemon.port}`,principal_id:'writer',key_id:'writer',audience:'fixture',private_key_path:key}),{mode:0o600});
 const body={prompt:'CLI_SYNTHETIC_INPUT',expected_epoch:f.epoch,exact_target:true,no_enter:true},idempotency_key='input-cli-idempotency-0001';fs.writeFileSync(request,JSON.stringify({idempotency_key,body}),{mode:0o600});
 const {execFile}=require('node:child_process');
 const run=(mode,args)=>new Promise(resolve=>execFile(process.execPath,[path.join(__dirname,'../cli.js'),mode,'--config',config,'--session','mine','--epoch',f.epoch,...args],{env:{...process.env,HOME:clientHome,USERPROFILE:clientHome,TELEPTY_AUTH_TOKEN:'unused-wrong-token'},timeout:10000},(error,stdout,stderr)=>resolve({error,stdout,stderr})));
 const first=await run('principal-input-v1',['--request',request]);assert.ifError(first.error);const receipt=JSON.parse(first.stdout);assert.equal(receipt.state,'accepted');assert.equal(receipt.consumption,'unknown');assert.ok(!first.stdout.includes('CLI_SYNTHETIC_INPUT'));assert.equal(first.stderr,'');
 const queried=await run('principal-input-receipt-v1',['--key',idempotency_key]);assert.ifError(queried.error);assert.equal(JSON.parse(queried.stdout).receipt_id,receipt.receipt_id);
 const repeated=await run('principal-input-v1',['--request',request]);assert.ifError(repeated.error);assert.equal(JSON.parse(repeated.stdout).receipt_id,receipt.receipt_id);
 assert.equal((await f.ownerRequest('GET','/api/sessions/mine/mailbox')).body.pending.length,1);assert.equal(fs.existsSync(path.join(clientHome,'.telepty','config.json')),false);
 await f.daemon.stop();
 const restarted=await startTestDaemon({homeDir:f.home,env:{TELEPTY_PRINCIPAL_MODE:'strict',TELEPTY_PRINCIPAL_TRUST_FILE:path.join(f.home,'trust'),TELEPTY_MACHINE_ID:'fixture'}});
 try {
  const updated=JSON.parse(fs.readFileSync(config));updated.daemon_url=`http://${restarted.host}:${restarted.port}`;fs.writeFileSync(config,JSON.stringify(updated));
  const afterRestart=await run('principal-input-v1',['--request',request]);assert.ifError(afterRestart.error);assert.equal(JSON.parse(afterRestart.stdout).receipt_id,receipt.receipt_id);
  const challenge=(await restarted.request('/api/auth/challenge',{noAuth:true})).body.challenge;
  const target='/api/sessions/mine/mailbox';const proof=createSignedAssertion({privateKey:f.owner.privateKey,keyId:'owner',principalId:'owner',audience:'fixture',challenge,method:'GET',target,body:undefined,action:'mailbox.read'});
  assert.equal((await restarted.request(target,{headers:{'x-telepty-principal':proof}})).body.pending.length,1);
 } finally {await restarted.stop();}
 fs.chmodSync(request,0o644);const unsafe=await run('principal-input-v1',['--request',request]);assert.equal(unsafe.error.code,1);assert.equal(unsafe.stdout,'');assert.match(unsafe.stderr,/AUTHORITY_FILE_UNAVAILABLE/);
});
test('input client treats channel loss after send as unknown and can query without a second write',{skip:linuxOnly},async t=>{
 const f=await transportFixture(t,'close-channel'),key=path.join(f.home,'key'),config=path.join(f.home,'config'),file=path.join(f.home,'request');
 fs.writeFileSync(key,f.key.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});fs.writeFileSync(config,JSON.stringify({schema:'telepty.principal-client/v1',daemon_url:`http://127.0.0.1:${f.server.address().port}`,principal_id:'writer',key_id:'writer',audience:'fixture',private_key_path:key}),{mode:0o600});
 const idempotency_key='input-client-lost-channel-0001';fs.writeFileSync(file,JSON.stringify({idempotency_key,body:{prompt:'CLIENT_PRIVATE_BODY',expected_epoch:'epoch',exact_target:true,no_enter:true}}),{mode:0o600});
 const {runPrincipalInput}=require('../src/principal/input-client'),base=['--config',config,'--session','mine','--epoch','epoch'];
 const unknown=await runPrincipalInput('inject',[...base,'--request',file]);assert.equal(unknown.state,'outcome_unknown');assert.equal(unknown.code,'INPUT_CHANNEL_OUTCOME_UNKNOWN');assert.equal(unknown.bytes_written,null);
 await waitFor(()=>fs.readdirSync(path.join(f.home,'.telepty','forward-receipts')).some(name=>JSON.parse(fs.readFileSync(path.join(f.home,'.telepty','forward-receipts',name))).state==='outcome_unknown'));
 f.restart();const queried=await runPrincipalInput('receipt',[...base,'--key',idempotency_key]);assert.equal(queried.state,'outcome_unknown');assert.equal(f.effects(),1);assert.ok(!JSON.stringify(queried).includes('CLIENT_PRIVATE_BODY'));
});
test('strict input preserves external approval refusal without inserting mailbox bytes',{skip:linuxOnly},async t=>{
 const f=await daemonFixture(t);
 const registered=await f.ownerRequest('POST','/api/sessions/register',{session_id:'protected',delivery_type:'mailbox',external_approval_policy:{public_key_spki:f.key.publicKey.export({type:'spki',format:'pem'})}});assert.equal(registered.status,201);
 const epoch=registered.body.session_epoch,c=await open(`ws://${f.daemon.host}:${f.daemon.port}/api/input/sessions/protected`,f.sign({target:'/api/input/sessions/protected',sessionEpoch:epoch}));assert.ok(c.ws);t.after(()=>c.ws.terminate());await waitFor(()=>c.messages.length);
 const body={prompt:'APPROVAL_MUST_NOT_BYPASS',expected_epoch:epoch,exact_target:true,no_enter:true};
 c.ws.send(JSON.stringify({type:'inject',connection_id:c.messages[0].connection_id,sequence:1,idempotency_key:'input-protected-deny-0001',body,assertion:f.sign({method:'POST',target:'/api/sessions/protected/inject',body,action:'session.inject',transport:'http',sessionEpoch:epoch})}));await waitFor(()=>c.messages.length===2);
 assert.equal(c.messages[1].state,'failed');assert.equal(c.messages[1].code,'EXTERNAL_APPROVAL_REQUIRED');assert.equal((await f.ownerRequest('GET','/api/sessions/protected/mailbox')).body.pending.length,0);
});
test('cached receipt metadata cannot override the authoritative operation identity or unknown state',async t=>{
 const f=await transportFixture(t,'lost');let c=await f.connect();const key='input-cache-envelope-0001';c.ws.send(JSON.stringify(f.frame(c,1,key)));await waitFor(()=>c.messages.length===2);const original=c.messages[1];assert.equal(original.state,'outcome_unknown');
 const directory=path.join(f.home,'.telepty','forward-receipts'),file=path.join(directory,fs.readdirSync(directory)[0]),record=JSON.parse(fs.readFileSync(file));
 record.remote_receipt={...record.remote_receipt,state:'accepted',receipt_id:'0'.repeat(64),session_id:'foreign',session_epoch:'foreign',effect:'app_publish',consumption:'confirmed',data:'PRIVATE_DAMAGED_METADATA'};fs.writeFileSync(file,JSON.stringify(record));
 f.restart();c=await f.connect();c.ws.send(JSON.stringify({type:'receipt',sequence:1,connection_id:c.messages[0].connection_id,idempotency_key:key}));await waitFor(()=>c.messages.length===2);
 assert.equal(c.messages[1].state,'outcome_unknown');assert.equal(c.messages[1].receipt_id,original.receipt_id);assert.equal(c.messages[1].session_id,'mine');assert.equal(c.messages[1].session_epoch,'epoch');assert.equal(c.messages[1].consumption,'unknown');assert.ok(!JSON.stringify(c.messages[1]).includes('PRIVATE_DAMAGED_METADATA'));assert.equal(f.effects(),1);
 record.direction='wrong-namespace';fs.writeFileSync(file,JSON.stringify(record));f.restart();c=await f.connect();
 c.ws.send(JSON.stringify({type:'receipt',sequence:1,connection_id:c.messages[0].connection_id,idempotency_key:key}));await waitFor(()=>c.messages.length===2);assert.equal(c.messages[1].state,'outcome_unknown');assert.equal(c.messages[1].bytes_written,null);assert.equal(c.messages[1].code,'INPUT_STORAGE_UNAVAILABLE');
 c.ws.send(JSON.stringify(f.frame(c,2,key)));await waitFor(()=>c.messages.length===3);assert.equal(c.messages[2].state,'outcome_unknown');assert.equal(f.effects(),1);
});

test('inconsistent accepted cache is unknown rather than a success or a new write',async t=>{
 const f=await transportFixture(t,'ok');let c=await f.connect();const key='input-cache-inconsistent-0001';c.ws.send(JSON.stringify(f.frame(c,1,key)));await waitFor(()=>c.messages.length===2);assert.equal(c.messages[1].state,'accepted');
 const dir=path.join(f.home,'.telepty','forward-receipts'),file=path.join(dir,fs.readdirSync(dir)[0]),record=JSON.parse(fs.readFileSync(file));record.remote_receipt.success=false;fs.writeFileSync(file,JSON.stringify(record));
 f.restart();c=await f.connect();c.ws.send(JSON.stringify({type:'receipt',sequence:1,connection_id:c.messages[0].connection_id,idempotency_key:key}));await waitFor(()=>c.messages.length===2);assert.equal(c.messages[1].state,'outcome_unknown');assert.equal(c.messages[1].bytes_written,null);assert.equal(f.effects(),1);
});
test('off Linux the strict daemon and the input client refuse their authority files before any write',{skip:nonLinuxOnly,timeout:15000},async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'strict-input-refusal-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const f=fixture(),trustFile=path.join(home,'trust');
 fs.writeFileSync(trustFile,JSON.stringify({schema:'telepty.principals/v1',audience:'fixture',keys:[{key_id:'writer',principal_id:'writer',public_key_spki:f.key.publicKey.export({type:'spki',format:'pem'}),grants:[{action:'session.inject',targets:['mine']}]}]}),{mode:0o600});
 await assertStrictDaemonRefused(startTestDaemon,{homeDir:home,env:{TELEPTY_PRINCIPAL_MODE:'strict',TELEPTY_PRINCIPAL_TRUST_FILE:trustFile,TELEPTY_MACHINE_ID:'fixture'}});
 let requests=0;const server=require('node:http').createServer((_req,res)=>{requests++;res.end('{}');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.close();server.closeAllConnections();});
 const key=path.join(home,'key'),config=path.join(home,'config'),file=path.join(home,'request');
 fs.writeFileSync(key,f.key.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
 fs.writeFileSync(config,JSON.stringify({schema:'telepty.principal-client/v1',daemon_url:`http://127.0.0.1:${server.address().port}`,principal_id:'writer',key_id:'writer',audience:'fixture',private_key_path:key}),{mode:0o600});
 fs.writeFileSync(file,JSON.stringify({idempotency_key:'input-refusal-879-0001',body:{prompt:'REFUSED_PRIVATE_BODY',expected_epoch:'epoch',exact_target:true,no_enter:true}}),{mode:0o600});
 const {runPrincipalInput}=require('../src/principal/input-client');
 await assert.rejects(runPrincipalInput('inject',['--config',config,'--session','mine','--epoch','epoch','--request',file]),{code:'AUTHORITY_FILE_UNAVAILABLE'});
 assert.equal(requests,0,'a refused client configuration never reaches the daemon');
});
