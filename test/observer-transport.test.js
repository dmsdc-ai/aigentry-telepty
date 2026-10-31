'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createPrincipalAuthentication } = require('../src/principal/http');
const { validateTrustConfiguration, createSignedAssertion } = require('../src/principal/proof');
function fixture() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const trust = validateTrustConfiguration({schema:'telepty.principals/v1',audience:'fixture',keys:[{key_id:'reader',principal_id:'reader',public_key_spki:pair.publicKey.export({type:'spki',format:'pem'}),grants:[{action:'session.observe',targets:['mine']}]}]});
  const session = { sessionEpoch:'epoch', owningPrincipal:{id:'reader',source:'ed25519',audience:'fixture'} };
  const auth = createPrincipalAuthentication({trust,sessions:{mine:session}});
  const sign = extra => createSignedAssertion({privateKey:pair.privateKey,keyId:'reader',principalId:'reader',audience:'fixture',challenge:auth.verifier.challenge,method:'GET',target:'/api/observe/sessions/mine',body:{},action:'session.observe',transport:'websocket',sessionEpoch:'epoch',...extra});
  const req = proof => ({method:'GET',url:'/api/observe/sessions/mine',headers:{'x-telepty-principal':proof},rawHeaders:[]});
  return {auth,sign,req,session};
}
test('observer proof is exact, epoch and transport bound, shared replay protected, and owner scoped', () => {
  const f=fixture(); const proof=f.sign();
  const result=f.auth.authorizeObserver(f.req(proof)); assert.equal(result.ok,true); assert.ok(result.expiresAt>Date.now());
  assert.equal(f.auth.authorizeObserver(f.req(proof)).ok,false);
  for(const extra of [{transport:'http'},{sessionEpoch:'old'},{target:'/api/observe/sessions/mine?proof=x'}]) assert.equal(f.auth.authorizeObserver(f.req(f.sign(extra))).ok,false);
  f.session.owningPrincipal.id='other'; assert.equal(f.auth.authorizeObserver(f.req(f.sign())).ok,false);
});
const http = require('node:http');
const WebSocket = require('ws');
const { createObserverTransport, publishSessionOutput } = require('../src/transport/observer');
function open(url, proof, extra={}) { return new Promise((resolve,reject) => {
  const ws=new WebSocket(url,{headers:{'x-telepty-principal':proof,...extra}}); const messages=[];
  ws.on('message',b=>messages.push(JSON.parse(b))); ws.on('error',()=>{});
  ws.once('unexpected-response',(_r,res)=>{res.resume();ws.terminate();resolve({status:res.statusCode});});
  ws.once('open',()=>resolve({ws,messages}));
}); }
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('dedicated real WebSocket bounds observers and closes before changed-identity output', async t => {
  const f=fixture(), sessions={mine:f.session}; f.session.outputRing=['replay'];
  let peerAllowed=true; const server=http.createServer(); const transport=createObserverTransport({authentication:f.auth,sessions,server,
    refuse:(s,status)=>s.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`),forbiddenOrigin:o=>!!o,allowedPeer:()=>peerAllowed});
  server.on('upgrade',(req,s,h)=>transport.handle(req,s,h)); await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{for(const ws of transport.wss.clients)ws.terminate();server.close();});
  const url=`ws://127.0.0.1:${server.address().port}/api/observe/sessions/mine`;
  const clients=[];for(let i=0;i<8;i++)clients.push(await open(url,f.sign()));
  assert.equal((await open(url,f.sign())).status,503);
  assert.equal((await open(url,f.sign(),{origin:'https://foreign.invalid'})).status,403);
  peerAllowed=false;assert.equal((await open(url,f.sign())).status,403);peerAllowed=true;
  await pause(20);assert.equal(clients[0].messages[0].read_only,true);assert.equal(clients[0].messages[1].data,'replay');
  publishSessionOutput(f.session,'live');await pause(20);assert.equal(clients[0].messages.at(-1).data,'live');
  clients[0].ws.send(JSON.stringify({type:'input',data:'no'}));await pause(30);assert.equal(clients[0].ws.readyState,3);
  f.session.credentialGeneration=2;publishSessionOutput(f.session,'must-not-leak');await pause(20);
  for(const c of clients)assert.ok(!c.messages.some(m=>m.data==='must-not-leak'));
  const short=await open(url,f.sign({ttlSeconds:1}));await pause(1100);assert.equal(short.ws.readyState,3);
});
test('actual strict daemon serves only signed read-only output from an owned spawned fixture', {skip:process.platform!=='linux',timeout:15000}, async t => {
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const {startTestDaemon,waitFor}=require('../test-support/daemon-harness');
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'observe-daemon-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const pair=crypto.generateKeyPairSync('ed25519');const file=path.join(home,'trust.json');
  fs.writeFileSync(file,JSON.stringify({schema:'telepty.principals/v1',audience:'observe-fixture',keys:[{key_id:'operator',principal_id:'operator',authority:'operator',public_key_spki:pair.publicKey.export({type:'spki',format:'pem'}),grants:[{action:'session.create',targets:['mine']},{action:'session.observe',targets:['mine']}]}]}),{mode:0o600});
  const daemon=await startTestDaemon({homeDir:home,env:{TELEPTY_PRINCIPAL_MODE:'strict',TELEPTY_PRINCIPAL_TRUST_FILE:file,TELEPTY_MACHINE_ID:'observe-fixture'}});t.after(()=>daemon.stop());
  const challenge=(await daemon.request('/api/auth/challenge',{noAuth:true})).body.challenge;
  const sign=extra=>createSignedAssertion({privateKey:pair.privateKey,keyId:'operator',principalId:'operator',audience:'observe-fixture',challenge,method:'GET',target:'/api/observe/sessions/mine',body:{},action:'session.observe',transport:'websocket',...extra});
  const body={session_id:'mine',command:process.execPath,args:['-e',"setInterval(()=>process.stdout.write('observer-fixture-output\\n'),100);process.stdin.on('data',()=>process.stdout.write('unexpected-input'))"]};
  const created=await daemon.request('/api/sessions/spawn',{method:'POST',body,headers:{'x-telepty-principal':sign({method:'POST',target:'/api/sessions/spawn',body,action:'session.create',transport:'http'})}});assert.equal(created.status,201);
  const epoch=created.body.session_epoch || created.body.sessionEpoch;
  // Spawn response exposes the durable epoch through its session object in current API.
  const sidEpoch=epoch || created.body.session?.sessionEpoch;assert.ok(sidEpoch,JSON.stringify(Object.keys(created.body)));
  const url=`ws://${daemon.host}:${daemon.port}/api/observe/sessions/mine`;
  const proof=sign({sessionEpoch:sidEpoch});const client=await open(url,proof);assert.ok(client.ws);t.after(()=>client.ws.terminate());
  await waitFor(()=>client.messages.some(m=>m.type==='output'&&m.data.includes('observer-fixture-output')));
  assert.ok(client.messages.every(m=>['observer','output'].includes(m.type)));
  assert.equal((await open(url,proof)).status,409);
  assert.equal((await open(url,sign({sessionEpoch:'stale'}))).status,401);
  assert.equal((await open(url,sign({sessionEpoch:sidEpoch,transport:'http'}))).status,401);
  assert.equal((await open(url+'?token=legacy',sign({sessionEpoch:sidEpoch}))).status,403);
  for(const frame of [{type:'input',data:'no'},{type:'resize',cols:1,rows:1},{type:'owner'},{type:'subscribe'}]) {
    const c=await open(url,sign({sessionEpoch:sidEpoch}));c.ws.send(JSON.stringify(frame));await waitFor(()=>c.ws.readyState===3);
  }
  assert.ok(!client.messages.some(m=>m.data?.includes('unexpected-input')));
});
test('observer transport rejects replaced/closing epochs, oversized output, backpressure and all application frames', async t => {
  const f=fixture(),sessions={mine:f.session};const server=http.createServer();
  const transport=createObserverTransport({authentication:f.auth,sessions,server,refuse:(s,status)=>s.end(`HTTP/1.1 ${status} Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`),forbiddenOrigin:()=>false,allowedPeer:()=>true});
  server.on('upgrade',(r,s,h)=>transport.handle(r,s,h));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{transport.close();server.close();});const url=`ws://127.0.0.1:${server.address().port}/api/observe/sessions/mine`;
  for(const change of [()=>{sessions.mine={...f.session};},()=>{f.session.sessionEpoch='new';},()=>{f.session.interactionOwnerGeneration=2;},()=>{f.session.ownerWs={};},()=>{f.session.owningPrincipal={id:'other',source:'ed25519',audience:'fixture'};},()=>{f.session.isClosing=true;}]) {
    sessions.mine=f.session;f.session.sessionEpoch='epoch';delete f.session.interactionOwnerGeneration;delete f.session.ownerWs;delete f.session.isClosing;f.session.owningPrincipal={id:'reader',source:'ed25519',audience:'fixture'};
    const c=await open(url,f.sign());change();publishSessionOutput(f.session,'secret-after-change');await pause(20);assert.equal(c.ws.readyState,3);assert.ok(!c.messages.some(m=>m.data==='secret-after-change'));
  }
  delete f.session.isClosing;const oversized=await open(url,f.sign());publishSessionOutput(f.session,'x'.repeat(65537));await pause(20);assert.equal(oversized.ws.readyState,3);
  const blocked=await open(url,f.sign());const serverWs=[...transport.wss.clients][0];Object.defineProperty(serverWs,'bufferedAmount',{value:131073});publishSessionOutput(f.session,'bounded');await pause(20);assert.equal(blocked.ws.readyState,3);
  const shutdown=await open(url,f.sign());transport.close();await pause(20);assert.equal(shutdown.ws.readyState,3);
});
test('observer authorization has no fallback, wildcard, query, body, owner or grant inference', () => {
  const f=fixture();
  for(const req of [f.req(undefined),{...f.req(f.sign()),headers:{'x-telepty-token':'legacy',authorization:'Bearer jwt'}},
    {...f.req(f.sign()),url:'/api/observe/sessions/mine?proof=x'},
    {...f.req(f.sign()),url:'/api/observe/sessions/mine/extra'},
    {...f.req(f.sign()),headers:{'x-telepty-principal':f.sign(),'content-length':'2'}},
    {...f.req(f.sign()),rawHeaders:['X-Telepty-Principal','one','x-telepty-principal','two']},
    {...f.req(f.sign()),url:'/api/observe/sessions/%2fescape'},
    f.req(f.sign({action:'session.inspect'})), f.req(f.sign({privateKey:crypto.generateKeyPairSync('ed25519').privateKey}))]) assert.equal(f.auth.authorizeObserver(req).ok,false);
  const pair=crypto.generateKeyPairSync('ed25519');
  const configuration=authority=>({schema:'telepty.principals/v1',audience:'fixture',keys:[{key_id:'reader',principal_id:'reader',authority,public_key_spki:pair.publicKey.export({type:'spki',format:'pem'}),grants:[{action:'session.observe',targets:['mine']}]}]});
  for(const authority of ['principal','operator']) {
    const auth=createPrincipalAuthentication({trust:validateTrustConfiguration(configuration(authority)),sessions:{mine:{sessionEpoch:'epoch',owningPrincipal:{id:'other',audience:'fixture',source:'ed25519'}}}});
    const proof=createSignedAssertion({privateKey:pair.privateKey,keyId:'reader',principalId:'reader',audience:'fixture',challenge:auth.verifier.challenge,method:'GET',target:'/api/observe/sessions/mine',body:{},action:'session.observe',transport:'websocket',sessionEpoch:'epoch'});
    assert.equal(auth.authorizeObserver(f.req(proof)).ok,authority==='operator');
  }
  const wildcard=configuration('operator');wildcard.keys[0].grants[0].targets=['*'];assert.throws(()=>validateTrustConfiguration(wildcard));
});
test('global64 admission budget releases sockets after shutdown and error closes', async t => {
  const pair=crypto.generateKeyPairSync('ed25519'),sessions={};for(let i=0;i<9;i++)sessions['s'+i]={sessionEpoch:'epoch',owningPrincipal:{id:'reader',source:'ed25519',audience:'fixture'}};
  const trust=validateTrustConfiguration({schema:'telepty.principals/v1',audience:'fixture',keys:[{key_id:'reader',principal_id:'reader',public_key_spki:pair.publicKey.export({type:'spki',format:'pem'}),grants:[{action:'session.observe',targets:Object.keys(sessions)}]}]});
  const auth=createPrincipalAuthentication({trust,sessions}),server=http.createServer();
  const transport=createObserverTransport({authentication:auth,sessions,server,refuse:(s,status)=>s.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`),forbiddenOrigin:()=>false,allowedPeer:()=>true});server.on('upgrade',(r,s,h)=>transport.handle(r,s,h));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{transport.close();server.close();});
  const connect=id=>{const target='/api/observe/sessions/'+id;return open(`ws://127.0.0.1:${server.address().port}${target}`,createSignedAssertion({privateKey:pair.privateKey,keyId:'reader',principalId:'reader',audience:'fixture',challenge:auth.verifier.challenge,method:'GET',target,body:{},action:'session.observe',transport:'websocket',sessionEpoch:'epoch'}));};
  const clients=[];for(let i=0;i<64;i++)clients.push(await connect('s'+Math.floor(i/8)));assert.equal((await connect('s8')).status,503);
  clients[0].ws.terminate();await pause(30);const freed=await connect('s8');assert.ok(freed.ws);transport.close();await pause(30);assert.equal(freed.ws.readyState,3);
  assert.equal((await connect('s8')).status,503);
});

test('observer replay scans at most1024 recent chunks even with an unbounded empty ring', async t => {
  const f=fixture(), sessions={mine:f.session};let reads=0;
  f.session.outputRing=new Proxy({length:10000000}, {get(target,key) {
    if(key==='length')return target.length;
    if(/^[0-9]+$/.test(String(key))){reads++;return Number(key)===target.length-1?'recent-output':'';}
    return target[key];
  }});
  const server=http.createServer();const transport=createObserverTransport({authentication:f.auth,sessions,server,
    refuse:(s,status)=>s.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`),forbiddenOrigin:()=>false,allowedPeer:()=>true});
  server.on('upgrade',(r,s,h)=>transport.handle(r,s,h));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{transport.close();server.close();});
  const c=await open(`ws://127.0.0.1:${server.address().port}/api/observe/sessions/mine`,f.sign());
  await pause(20);assert.equal(reads,1024);assert.equal(c.messages.find(m=>m.type==='output').data,'recent-output');
});
