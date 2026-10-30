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
function open(url,proof){return new Promise(resolve=>{const ws=new WebSocket(url,{headers:{'x-telepty-principal':proof}}),messages=[];ws.on('message',b=>messages.push(JSON.parse(b)));ws.on('error',()=>{});ws.on('open',()=>resolve({ws,messages}));ws.on('unexpected-response',(_r,res)=>{res.resume();ws.terminate();resolve({status:res.statusCode});});});}
async function daemonFixture(t){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'strict-input-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const f=fixture(),owner=crypto.generateKeyPairSync('ed25519'),streamOnly=crypto.generateKeyPairSync('ed25519'),trustFile=path.join(home,'trust');
 fs.writeFileSync(trustFile,JSON.stringify({schema:'telepty.principals/v1',audience:'fixture',keys:[
  {key_id:'owner',principal_id:'owner',public_key_spki:owner.publicKey.export({type:'spki',format:'pem'}),grants:['session.register','mailbox.read'].map(action=>({action,targets:['mine','protected']}))},
  {key_id:'writer',principal_id:'writer',public_key_spki:f.key.publicKey.export({type:'spki',format:'pem'}),grants:['session.input_stream','session.inject'].map(action=>({action,targets:['mine','protected']}))},
  {key_id:'stream-only',principal_id:'stream-only',public_key_spki:streamOnly.publicKey.export({type:'spki',format:'pem'}),grants:[{action:'session.input_stream',targets:['mine']}]},
  {key_id:'other',principal_id:'other',public_key_spki:f.other.publicKey.export({type:'spki',format:'pem'}),grants:[{action:'session.inject',targets:['mine']}]}
 ]}),{mode:0o600});
 const daemon=await startTestDaemon({homeDir:home,env:{TELEPTY_PRINCIPAL_MODE:'strict',TELEPTY_PRINCIPAL_TRUST_FILE:trustFile,TELEPTY_MACHINE_ID:'fixture'}});t.after(()=>daemon.stop());
 const challenge=(await daemon.request('/api/auth/challenge',{noAuth:true})).body.challenge;
 const sign=extra=>createSignedAssertion({privateKey:f.key.privateKey,keyId:'writer',principalId:'writer',audience:'fixture',challenge,method:'GET',target:'/api/input/sessions/mine',body:{},action:'session.input_stream',transport:'websocket',...extra});
 const ownerRequest=(method,target,body)=>daemon.request(target,{method,...(body?{body}:{}),headers:{'x-telepty-principal':sign({privateKey:owner.privateKey,keyId:'owner',principalId:'owner',method,target,body,action:method==='POST'?'session.register':'mailbox.read',transport:'http'})}});
 const registered=await ownerRequest('POST','/api/sessions/register',{session_id:'mine',delivery_type:'mailbox'});assert.equal(registered.status,201);
 return{...f,streamOnly,home,daemon,sign,ownerRequest,epoch:registered.body.session_epoch};
}
test('actual strict input goes through signed inject and exact durable dedup without token fallback', {timeout:15000},async t=>{
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
 const server=http.createServer((req,res)=>{const chunks=[];req.on('data',b=>chunks.push(b));req.on('end',()=>{
  req.principalRawBody=Buffer.concat(chunks);req.body=JSON.parse(req.principalRawBody);const auth=f.authentication.authorize(req);
  if(!auth.ok){res.writeHead(auth.status);res.end(JSON.stringify({success:false,code:auth.code}));return;}
  assert.equal(req.headers['x-telepty-token'],undefined);assert.ok(req.headers.host.startsWith('127.0.0.1:'));effects++;
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
