'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPrincipalClient, loadPrincipalClientConfiguration } = require('../src/principal/client');
const { validateTrustConfiguration, createPrincipalVerifier } = require('../src/principal/proof');
const { bodyDigest } = require('../src/principal/encoding');
function fixture() {
  const pair=crypto.generateKeyPairSync('ed25519');
  const principal={principal_id:'reader',key_id:'reader',audience:'fixture',privateKey:pair.privateKey};
  const trust=validateTrustConfiguration({schema:'telepty.principals/v1',audience:'fixture',keys:[{key_id:'reader',principal_id:'reader',public_key_spki:pair.publicKey.export({type:'spki',format:'pem'}),grants:[{action:'session.observe',targets:['mine']}]}]});
  const verifier=createPrincipalVerifier({trust});
  return {principal,verifier,document:{schema:'telepty.principal-challenge/v1',audience:'fixture',challenge:verifier.challenge,max_lifetime_seconds:60,transport:'http',identity_source:'configured-ed25519-key'}};
}
test('client signs fresh exact observer proof without any legacy credential carrier', async()=>{
  const f=fixture(),calls=[];
  const client=createPrincipalClient({daemonUrl:'http://127.0.0.1:1234',principal:f.principal,fetch:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(f.document));}});
  const binding={method:'GET',target:'/api/observe/sessions/mine',body:{},action:'session.observe',sessionEpoch:'epoch',transport:'websocket'};
  const a=await client.assertion(binding),b=await client.assertion(binding);
  assert.notEqual(a,b); assert.equal(calls.length,2);
  assert.equal(f.verifier.verify(a,{...binding,bodySha256:bodyDigest({}),grantTarget:'mine'}).ok,true);
  assert.equal(calls[0].url,'http://127.0.0.1:1234/api/auth/challenge');
  assert.equal(calls[0].options.redirect,'error'); assert.equal(calls[0].options.headers,undefined);
});
test('client refuses insecure origins and mismatched challenge; never sends signed second request',async()=>{
  const f=fixture();
  for(const daemonUrl of ['http://example.test','http://localhost','http://127.0.0.1/path','https://user:secret@example.test','https://example.test?token=secret']) assert.throws(()=>createPrincipalClient({daemonUrl,principal:f.principal}));
  for(const change of [{audience:'foreign'},{transport:'websocket'},{max_lifetime_seconds:61},{challenge:'short'}]) {
    let calls=0;const client=createPrincipalClient({daemonUrl:'https://example.test',principal:f.principal,fetch:async()=>{calls++;return new Response(JSON.stringify({...f.document,...change}));}});
    await assert.rejects(client.assertion({method:'GET',target:'/api/meta',body:{},action:'daemon.inspect'}),{code:'PRINCIPAL_CHALLENGE_INVALID'});assert.equal(calls,1);
  }
});
test('checked client configuration rejects unknown fields, weak key files and symlinks',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'telepty-principal-client-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const f=fixture(),key=path.join(dir,'key.pem'),file=path.join(dir,'config.json');
  fs.writeFileSync(key,f.principal.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  const config={schema:'telepty.principal-client/v1',daemon_url:'http://127.0.0.1:1234',principal_id:'reader',key_id:'reader',audience:'fixture',private_key_path:key};
  fs.writeFileSync(file,JSON.stringify(config),{mode:0o600});assert.equal(loadPrincipalClientConfiguration(file).daemonUrl,config.daemon_url);
  fs.chmodSync(key,0o644);assert.throws(()=>loadPrincipalClientConfiguration(file));fs.chmodSync(key,0o600);
  fs.writeFileSync(file,JSON.stringify({...config,token:'no'}));assert.throws(()=>loadPrincipalClientConfiguration(file));
  const link=path.join(dir,'link');fs.symlinkSync(file,link);assert.throws(()=>loadPrincipalClientConfiguration(link));
});
const http=require('node:http');
const { PassThrough }=require('node:stream');
const { createObserverTransport,publishSessionOutput }=require('../src/transport/observer');
const { createPrincipalAuthentication }=require('../src/principal/http');
const { runPrincipalObserver }=require('../src/principal/observe-cli');
test('observer CLI uses checked config, proves exact epoch, emits JSON and closes without a token file',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'telepty-observe-client-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const pair=crypto.generateKeyPairSync('ed25519');
  const trust=validateTrustConfiguration({schema:'telepty.principals/v1',audience:'fixture',keys:[{key_id:'reader',principal_id:'reader',public_key_spki:pair.publicKey.export({type:'spki',format:'pem'}),grants:[{action:'session.observe',targets:['mine']}]}]});
  const session={sessionEpoch:'epoch',owningPrincipal:{id:'reader',source:'ed25519',audience:'fixture'},outputRing:['fixture output']};
  const authentication=createPrincipalAuthentication({trust,sessions:{mine:session}});
  const server=http.createServer((req,res)=>{assert.equal(req.url,'/api/auth/challenge');assert.equal(req.headers['x-telepty-token'],undefined);res.end(JSON.stringify(authentication.challengeDocument()));});
  const transport=createObserverTransport({authentication,sessions:{mine:session},server,refuse:(s,status)=>s.end(`HTTP/1.1 ${status} Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`),forbiddenOrigin:()=>false,allowedPeer:()=>true});
  server.on('upgrade',(req,s,h)=>transport.handle(req,s,h));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{transport.close();server.close();server.closeAllConnections();});
  const key=path.join(dir,'key'),config=path.join(dir,'config');fs.writeFileSync(key,pair.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});
  fs.writeFileSync(config,JSON.stringify({schema:'telepty.principal-client/v1',daemon_url:`http://127.0.0.1:${server.address().port}`,principal_id:'reader',key_id:'reader',audience:'fixture',private_key_path:key}),{mode:0o600});
  const {execFile}=require('node:child_process');
  const refused=await new Promise(resolve=>execFile(process.execPath,[path.join(__dirname,'../cli.js'),'principal-observe-v1','--config',config,'--session','mine','--epoch','stale'],{env:{...process.env,HOME:dir,USERPROFILE:dir,TELEPTY_AUTH_TOKEN:'unused-legacy'},timeout:10000},(error,stdout,stderr)=>resolve({error,stdout,stderr})));
  assert.equal(refused.error?.code,1);assert.equal(refused.stdout,'');assert.match(refused.stderr,/PRINCIPAL_OBSERVER_REFUSED/);
  assert.equal(fs.existsSync(path.join(dir,'.telepty','config.json')),false);
  const stdout=new PassThrough();let output='';stdout.on('data',data=>{output+=data;const frames=output.trim().split('\n').map(s=>JSON.parse(s));if(frames.some(f=>f.type==='output'))transport.close();});
  await runPrincipalObserver(['--config',config,'--session','mine','--epoch','epoch'],{stdout});
  const frames=output.trim().split('\n').map(s=>JSON.parse(s));assert.equal(frames[0].read_only,true);assert.equal(frames[1].data,'fixture output');
  assert.equal(fs.existsSync(path.join(dir,'.telepty','config.json')),false);
});
test('caller cancellation never replaces the finite request deadline',async t=>{
  const f=fixture(),caller=new AbortController(),timeout=new AbortController();let duration;
  t.mock.method(AbortSignal,'timeout',ms=>{duration=ms;return timeout.signal;});
  const client=createPrincipalClient({daemonUrl:'http://127.0.0.1:1234',principal:f.principal,fetch:async(_url,options)=>new Promise((_resolve,reject)=>{
    assert.notEqual(options.signal,caller.signal);options.signal.addEventListener('abort',()=>reject(new Error('bounded deadline')),{once:true});
  })});
  const pending=client.assertion({method:'GET',target:'/api/meta',body:undefined,action:'daemon.inspect',signal:caller.signal});
  timeout.abort();await assert.rejects(pending,/bounded deadline/);assert.equal(duration,5000);assert.equal(caller.signal.aborted,false);
});
test('already cancelled observer refuses before opening a WebSocket',async()=>{
  const signal=AbortSignal.abort();await assert.rejects(runPrincipalObserver(['--config','/unused','--session','mine','--epoch','epoch'],{signal}),{code:'PRINCIPAL_OBSERVER_CANCELLED'});
});
test('observer enforces advertised expiry even if a server keeps the socket open',async t=>{
  const f=fixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'telepty-expiry-client-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const server=http.createServer((_req,res)=>res.end(JSON.stringify(f.document)));
  const {WebSocketServer}=require('ws');const wss=new WebSocketServer({server});
  const timers=[];wss.on('connection',ws=>{
    ws.send(JSON.stringify({type:'observer',schema:'telepty.read-only-observer/v1',session_id:'mine',session_epoch:'epoch',read_only:true,expires_at:Date.now()+50}));
    timers.push(setTimeout(()=>{if(ws.readyState===1)ws.send(JSON.stringify({type:'output',data:'too late'}));},100));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{timers.forEach(clearTimeout);for(const ws of wss.clients)ws.terminate();wss.close();server.close();server.closeAllConnections();});
  const key=path.join(dir,'key'),config=path.join(dir,'config');fs.writeFileSync(key,f.principal.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  fs.writeFileSync(config,JSON.stringify({schema:'telepty.principal-client/v1',daemon_url:`http://127.0.0.1:${server.address().port}`,principal_id:'reader',key_id:'reader',audience:'fixture',private_key_path:key}),{mode:0o600});
  const stdout=new PassThrough();let output='';stdout.on('data',data=>{output+=data;});
  await assert.rejects(runPrincipalObserver(['--config',config,'--session','mine','--epoch','epoch'],{stdout}),{code:'PRINCIPAL_OBSERVER_EXPIRED'});
  assert.ok(!output.includes('too late'));
});
