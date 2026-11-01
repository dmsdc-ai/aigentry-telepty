'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const {validateTrustConfiguration,createSignedAssertion}=require('../src/principal/proof');
const {createPrincipalAuthentication}=require('../src/principal/http');
function fixture(authority='principal') {
 const pair=crypto.generateKeyPairSync('ed25519');const session={type:'wrapped',sessionEpoch:'epoch',credentialGeneration:1,owningPrincipal:{id:'owner',source:'ed25519',audience:'fixture'}};
 const trust=validateTrustConfiguration({schema:'telepty.principals/v1',audience:'fixture',keys:[{key_id:'owner',principal_id:'owner',authority,public_key_spki:pair.publicKey.export({type:'spki',format:'pem'}),grants:[{action:'session.owner',targets:['mine']}]}]});
 const auth=createPrincipalAuthentication({trust,sessions:{mine:session}});const sign=extra=>createSignedAssertion({privateKey:pair.privateKey,keyId:'owner',principalId:'owner',audience:'fixture',challenge:auth.verifier.challenge,method:'GET',target:'/api/owner/sessions/mine',body:{},action:'session.owner',sessionEpoch:'epoch',transport:'websocket',...extra});
 const req=extra=>({method:'GET',url:'/api/owner/sessions/mine',headers:{'x-telepty-principal':sign()},rawHeaders:[],...extra});return{auth,session,sign,req};
}
test('strict owner requires exact epoch/current stored principal, even for operator',()=>{
 for(const authority of ['principal','operator']) {const f=fixture(authority);assert.equal(f.auth.authorizeOwner(f.req()).ok,true);f.session.owningPrincipal.id='foreign';assert.equal(f.auth.authorizeOwner(f.req()).ok,false);}
 const f=fixture();for(const extra of [{sessionEpoch:'old'},{transport:'http'},{target:'/api/owner/sessions/mine?owner=1'}])assert.equal(f.auth.authorizeOwner(f.req({headers:{'x-telepty-principal':f.sign(extra)}})).ok,false);
});
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const WebSocket=require('ws');
const {startTestDaemon,waitFor}=require('../test-support/daemon-harness');
function connect(url,headers){return new Promise(resolve=>{const ws=new WebSocket(url,{headers});const frames=[];ws.on('message',b=>frames.push(JSON.parse(b)));ws.on('error',()=>{});ws.once('open',()=>resolve({ws,frames}));ws.once('unexpected-response',(_r,res)=>{res.resume();ws.terminate();resolve({status:res.statusCode});});});}
async function daemonFixture(t){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'strict-owner-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const pair=crypto.generateKeyPairSync('ed25519');const trust=path.join(home,'trust.json');
 fs.writeFileSync(trust,JSON.stringify({schema:'telepty.principals/v1',audience:'fixture',keys:[{key_id:'owner',principal_id:'owner',authority:'operator',public_key_spki:pair.publicKey.export({type:'spki',format:'pem'}),grants:['session.register','session.owner','session.inspect','session.destroy'].map(action=>({action,targets:['mine']}))}]}),{mode:0o600});
 const daemon=await startTestDaemon({homeDir:home,env:{TELEPTY_PRINCIPAL_MODE:'strict',TELEPTY_PRINCIPAL_TRUST_FILE:trust,TELEPTY_MACHINE_ID:'fixture'}});t.after(()=>daemon.stop());
 const challenge=(await daemon.request('/api/auth/challenge',{noAuth:true})).body.challenge;
 const sign=extra=>createSignedAssertion({privateKey:pair.privateKey,keyId:'owner',principalId:'owner',audience:'fixture',challenge,method:'GET',target:'/api/owner/sessions/mine',body:{},action:'session.owner',transport:'websocket',...extra});
 return{home,pair,daemon,sign};
}
test('actual strict daemon owner claim is bearer-bound, sequenced and rejects viewer writes/replay', {skip:process.platform!=='linux',timeout:10000},async t=>{
 const f=await daemonFixture(t);const body={session_id:'mine',command:'node',require_owner_proof:true};
 const created=await f.daemon.request('/api/sessions/register',{method:'POST',body,headers:{'x-telepty-principal':f.sign({method:'POST',target:'/api/sessions/register',body,action:'session.register',transport:'http'})}});assert.equal(created.status,201);
 const bearer=created.body.session_token,epoch=created.body.session_epoch,url=`ws://${f.daemon.host}:${f.daemon.port}/api/owner/sessions/mine`;
 const headers=()=>({'x-telepty-principal':f.sign({sessionEpoch:epoch}),'x-telepty-session-token':bearer});
 assert.equal((await connect(url,{'x-telepty-principal':f.sign({sessionEpoch:epoch})})).status,401);
 assert.equal((await connect(url,{...headers(),'x-telepty-session-token':'wrong'})).status,401);
 assert.equal((await connect(url,{'x-telepty-principal':f.sign({sessionEpoch:'old'}),'x-telepty-session-token':bearer})).status,401);
 const inspect=async()=>f.daemon.request('/api/sessions/mine/screen',{headers:{'x-telepty-principal':f.sign({method:'GET',target:'/api/sessions/mine/screen',body:undefined,action:'session.inspect',transport:'http'})}});
 const claim=async()=>{const c=await connect(url,headers());assert.ok(c.ws);t.after(()=>c.ws.terminate());await waitFor(()=>c.frames.some(m=>m.type==='owner_token'));return c;};
 let c=await claim();let ack=c.frames[0];assert.equal(ack.sequence,1);assert.ok(ack.connection_id);assert.equal(ack.interaction_binding.session_epoch,epoch);
 c.ws.send(JSON.stringify({type:'output',data:'bounded-owner-output',connection_id:ack.connection_id,sequence:1}));
 await waitFor(async()=>JSON.stringify((await inspect()).body).includes('bounded-owner-output'));
 c.ws.send(JSON.stringify({type:'output',data:'replayed-owner-output',connection_id:ack.connection_id,sequence:1}));await waitFor(()=>c.ws.readyState===3);
 assert.ok(!JSON.stringify((await inspect()).body).includes('replayed-owner-output'));
 for(const type of ['input','resize','subscribe','session_state_report']){c=await claim();ack=c.frames[0];c.ws.send(JSON.stringify({type,data:'forbidden',connection_id:ack.connection_id,sequence:1}));await waitFor(()=>c.ws.readyState===3);}
 c=await claim();ack=c.frames[0];c.ws.send(JSON.stringify({type:'output',data:'wrong-connection',connection_id:crypto.randomUUID(),sequence:1}));await waitFor(()=>c.ws.readyState===3);
 c=await claim();const short=await connect(url,{'x-telepty-principal':f.sign({sessionEpoch:epoch,ttlSeconds:1}),'x-telepty-session-token':bearer});t.after(()=>short.ws?.terminate());await waitFor(()=>short.ws.readyState===3);
 const incumbent=await claim();const destroyProof=()=>f.sign({method:'DELETE',target:'/api/sessions/mine',body:undefined,action:'session.destroy',transport:'http',sessionEpoch:epoch});
 const stale=await f.daemon.request('/api/sessions/mine',{method:'DELETE',headers:{'x-telepty-principal':destroyProof(),'x-telepty-session-token':bearer,'x-telepty-owner-token':'stale-owner'}});
 assert.equal(stale.body.status,'stale-detached');assert.equal(incumbent.ws.readyState,1);
 const duplicate=await new Promise((resolve,reject)=>{const req=http.request({hostname:f.daemon.host,port:f.daemon.port,path:'/api/sessions/mine',method:'DELETE',headers:{'x-telepty-principal':destroyProof(),'x-telepty-session-token':bearer,'x-telepty-owner-token':['first','second']}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});assert.equal(duplicate,400);assert.equal(incumbent.ws.readyState,1);

});
test('actual allow CLI uses checked signer and owner ACK before its owned synthetic child starts', {skip:process.platform!=='linux',timeout:12000},async t=>{
 const f=await daemonFixture(t);const key=path.join(f.home,'signer.pem');fs.writeFileSync(key,f.pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
 const config=path.join(f.home,'client.json');fs.writeFileSync(config,JSON.stringify({schema:'telepty.principal-client/v1',daemon_url:`http://${f.daemon.host}:${f.daemon.port}`,principal_id:'owner',key_id:'owner',audience:'fixture',private_key_path:key}),{mode:0o600});
 const result=path.join(f.home,'child-result'),trigger=path.join(f.home,'emit-buffer'),written=path.join(f.home,'buffer-written');const {spawn}=require('node:child_process');const child=spawn(process.execPath,['--require','./test-support/setup-env.js','cli.js','allow','--id','mine',process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(result)},JSON.stringify({started:true,signerConfigInherited:!!process.env.TELEPTY_PRINCIPAL_CLIENT_FILE}));const timer=setInterval(()=>{if(require('fs').existsSync(${JSON.stringify(trigger)})){require('fs').writeSync(1,'中'.repeat(90000)+'BUFFER_END');require('fs').writeFileSync(${JSON.stringify(written)},'done');clearInterval(timer);}},20);setTimeout(()=>{},10000)`],{cwd:path.resolve(__dirname,'..'),env:{...process.env,HOME:f.home,TELEPTY_HOST:f.daemon.host,TELEPTY_PORT:String(f.daemon.port),TELEPTY_PRINCIPAL_CLIENT_FILE:config,TELEPTY_NO_SUPERVISOR_DEFER:'1'},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);t.after(async()=>{child.kill('SIGTERM');await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(()=>{child.kill('SIGKILL');r();},1000).unref();});});
 await waitFor(()=>{if(child.exitCode!==null)throw new Error('allow exited: '+output);return fs.existsSync(result);},{timeoutMs:7000});
 assert.deepEqual(JSON.parse(fs.readFileSync(result)),{started:true,signerConfigInherited:false});assert.ok(!output.includes(f.pair.privateKey.export({type:'pkcs8',format:'pem'})));
 const port=f.daemon.port;await f.daemon.kill();fs.writeFileSync(trigger,'go');await waitFor(()=>fs.existsSync(written));await new Promise(r=>setTimeout(r,200));
 const restored=await startTestDaemon({homeDir:f.home,port,env:{TELEPTY_PRINCIPAL_MODE:'strict',TELEPTY_PRINCIPAL_TRUST_FILE:path.join(f.home,'trust.json'),TELEPTY_MACHINE_ID:'fixture'}});t.after(()=>restored.stop());
 const {createPrincipalClient,loadPrincipalClientConfiguration}=require('../src/principal/client');const client=createPrincipalClient(loadPrincipalClientConfiguration(config));
 await waitFor(async()=>{const response=await client.request({method:'GET',target:'/api/sessions/mine/screen',action:'session.inspect'});return JSON.stringify(await response.json()).includes('BUFFER_END');},{timeoutMs:6000});

});
const http=require('node:http');const {WebSocketServer}=require('ws');const {createStrictOwnerTransport,localSocket}=require('../src/transport/strict-owner');
test('strict duplex transport requires literal socket loopback or actual TLS, not forwarded headers',()=>{
 for(const socket of [{remoteAddress:'127.0.0.1'},{remoteAddress:'::1'},{remoteAddress:'::ffff:127.0.0.1'},{remoteAddress:'192.0.2.1',encrypted:true}])assert.equal(localSocket(socket),true);
 for(const socket of [{remoteAddress:'192.0.2.1'},{remoteAddress:'127.0.0.2'},{remoteAddress:'localhost'},{remoteAddress:'192.0.2.1',headers:{'x-forwarded-for':'127.0.0.1','x-forwarded-proto':'https'}}])assert.equal(localSocket(socket),false);
});
test('strict owner fences record/epoch/credential/owner changes before inbound or outbound mutation',async t=>{
 const f=fixture(),sessions={mine:f.session};const server=http.createServer(),wss=new WebSocketServer({noServer:true});const contexts=[];
 const transport=createStrictOwnerTransport({authentication:f.auth,credentials:{hasCredential:()=>true,matches:(_id,b)=>b==='synthetic',verify:()=>({sid:'mine',epoch:'epoch'})},sessions,wss,
   refuse:(s,status)=>s.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`),forbiddenOrigin:()=>false,allowedPeer:()=>true});
 server.on('upgrade',(r,s,h)=>transport.handle(r,s,h));wss.on('connection',(ws,req)=>{const context=transport.context(req);f.session.ownerWs=ws;f.session.interactionOwnerGeneration=crypto.randomUUID();assert.equal(context.bind(ws),true);contexts.push({ws,context});ws.on('message',b=>context.accept(JSON.parse(b)));ws.send(JSON.stringify({type:'owner_token',token:'synthetic-owner'}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{transport.close();server.close();});
 const url=`ws://127.0.0.1:${server.address().port}/api/owner/sessions/mine`;
 for(const change of [()=>{sessions.mine={...f.session};},()=>{f.session.sessionEpoch='changed';},()=>{f.session.credentialGeneration++;},()=>{f.session.ownerWs={};},()=>{f.session.interactionOwnerGeneration='changed';},()=>{f.session.isClosing=true;},()=>{f.session.owningPrincipal={id:'foreign',source:'ed25519',audience:'fixture'};}]){
  sessions.mine=f.session;f.session.sessionEpoch='epoch';f.session.credentialGeneration=1;delete f.session.isClosing;f.session.owningPrincipal={id:'owner',source:'ed25519',audience:'fixture'};
  const c=await connect(url,{'x-telepty-principal':f.sign(),'x-telepty-session-token':'synthetic'});await waitFor(()=>c.frames.length);change();assert.throws(()=>contexts.at(-1).ws.send(JSON.stringify({type:'inject',data:'must-not-write'})),/STRICT_OWNER_SEND_REFUSED/);await waitFor(()=>c.ws.readyState===3);assert.ok(!c.frames.some(m=>m.data==='must-not-write'));
 }
 transport.close();assert.equal((await connect(url,{'x-telepty-principal':f.sign(),'x-telepty-session-token':'synthetic'})).status,503);
});
const {bindStrictOwnerClient}=require('../src/cli/strict-owner-client');
test('strict client splits large CJK/surrogate buffered and live output without losing offsets or order',()=>{
 const frames=[];let terminated=false;const ws={bufferedAmount:0,send:data=>frames.push(JSON.parse(data)),terminate:()=>{terminated=true;}};
 const wire=bindStrictOwnerClient(ws),id=crypto.randomUUID();assert.equal(wire.accept({type:'owner_token',connection_id:id,sequence:1,expires_at:Date.now()+59000}),true);
 const text=('中'.repeat(8191)+'😀').repeat(30);ws.send(JSON.stringify({type:'output',data:text,stream_id:'fixture-stream',stream_offset:37}));
 assert.equal(frames.map(f=>f.data).join(''),text);assert.ok(frames.length>30);let offset=37;
 for(let i=0;i<frames.length;i++){const frame=frames[i];assert.equal(frame.sequence,i+1);assert.equal(frame.stream_offset,offset);assert.ok(Buffer.byteLength(frame.data)<=32768);assert.ok(Buffer.byteLength(JSON.stringify(frame))<=65536);assert.ok(!/[\uD800-\uDBFF]$/.test(frame.data));offset+=frame.data.length;}
 ws.bufferedAmount=262145;assert.throws(()=>ws.send(JSON.stringify({type:'output',data:'retain-me'})),/STRICT_OWNER_BACKPRESSURE/);assert.equal(terminated,true);
});

test('strict client freezes first expiry and closes locally even without another frame',async()=>{
 let closed=0;const ws={bufferedAmount:0,send:()=>{},terminate:()=>closed++};const wire=bindStrictOwnerClient(ws),id=crypto.randomUUID(),expiry=Date.now()+50;
 assert.equal(wire.accept({type:'owner_token',connection_id:id,sequence:1,expires_at:expiry}),true);
 assert.equal(wire.accept({type:'inject',connection_id:id,sequence:2,expires_at:expiry+1000}),false);
 await new Promise(r=>setTimeout(r,70));assert.ok(closed>=1);assert.throws(()=>ws.send(JSON.stringify({type:'heartbeat'})),/NOT_BOUND/);
});
