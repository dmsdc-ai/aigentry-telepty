'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {WebSocketServer}=require('ws');const {runPrincipalInput}=require('../src/principal/input-client');
// #879: every client case reads its config/key/request through readAuthorityFile — a Linux-only contract
// (src/principal/authority-file.js:15). Off Linux the refusal case at the end runs the same clients instead.
const {linuxOnly,nonLinuxOnly,assertStrictDaemonRefused}=require('../test-support/windows-879/linux-authority');
async function fixture(t,receipt,effect='inject') {
 const bus=effect!=='inject';
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'principal-effect-client-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const pair=crypto.generateKeyPairSync('ed25519'),challenge=crypto.randomBytes(32).toString('base64url');
 const server=http.createServer((_req,res)=>res.end(JSON.stringify({schema:'telepty.principal-challenge/v1',audience:'fixture',challenge,max_lifetime_seconds:60,transport:'http',identity_source:'configured-ed25519-key'})));
 const tuple=bus?['strict-bus/v1',effect,'fixture','writer','writer','mine','epoch','input-client-contract-0001']:['strict-input/v1','fixture','writer','writer','mine','epoch','input-client-contract-0001'];
 if(receipt.receipt_id==='fixture-key')receipt={...receipt,receipt_id:crypto.createHash('sha256').update(JSON.stringify(tuple)).digest('hex')};
 const wss=new WebSocketServer({server});wss.on('connection',ws=>{ws.send(JSON.stringify({schema:bus?'telepty.bus-effect-stream/v1':'telepty.input-stream/v1',connection_id:crypto.randomUUID(),session_id:'mine',session_epoch:'epoch',expires_at:Date.now()+59000,mode:bus?'signed-http-session-effects':'signed-http-inject',max_frames:64}));ws.on('message',()=>ws.send(JSON.stringify(receipt)));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{for(const ws of wss.clients)ws.terminate();wss.close();server.closeAllConnections();server.close();});
 const key=path.join(home,'key'),config=path.join(home,'config'),request=path.join(home,'request');fs.writeFileSync(key,pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
 fs.writeFileSync(config,JSON.stringify({schema:'telepty.principal-client/v1',daemon_url:`http://127.0.0.1:${server.address().port}`,principal_id:'writer',key_id:'writer',audience:'fixture',private_key_path:key}),{mode:0o600});
 const body=effect==='state_report'?{phase:'working',seq:1}:effect==='app_publish'?{expected_epoch:'epoch',topic:'app/example',data:{text:'PRIVATE_REQUEST'}}:{prompt:'PRIVATE_REQUEST',expected_epoch:'epoch',exact_target:true,no_enter:true};
 fs.writeFileSync(request,JSON.stringify({idempotency_key:'input-client-contract-0001',...(bus?{effect}:{}),body}),{mode:0o600});
 return['--config',config,'--session','mine','--epoch','epoch','--request',request];
}
test('an internally inconsistent accepted receipt never becomes client success',{skip:linuxOnly},async t=>{
 const args=await fixture(t,{schema:'telepty.input-receipt/v1',session_id:'mine',session_epoch:'epoch',state:'accepted',success:false,receipt_id:'a'.repeat(64),inject_id:'inject-id'});
 const result=await runPrincipalInput('inject',args);assert.equal(result.state,'outcome_unknown');assert.equal(result.success,false);assert.equal(result.bytes_written,null);assert.equal(result.retryable,false);
});
test('accepted input without durable receipt identity remains unknown',{skip:linuxOnly},async t=>{
 const args=await fixture(t,{schema:'telepty.input-receipt/v1',session_id:'mine',session_epoch:'epoch',state:'accepted',success:true,inject_id:'inject-id'});
 assert.equal((await runPrincipalInput('inject',args)).state,'outcome_unknown');
});
const {runPrincipalBus}=require('../src/principal/bus-client');
test('bus receipt cannot acknowledge a different effect',{skip:linuxOnly},async t=>{
 const args=await fixture(t,{schema:'telepty.bus-effect-receipt/v1',effect:'routed_turn',session_id:'mine',session_epoch:'epoch',state:'accepted',success:true,receipt_id:'a'.repeat(64),inject_id:'inject-id'},'state_report');
 assert.equal((await runPrincipalBus('inject',args)).state,'outcome_unknown');
});
test('application publication never promotes an ACK claim or raw response payload',{skip:linuxOnly},async t=>{
 const base={schema:'telepty.bus-effect-receipt/v1',effect:'app_publish',session_id:'mine',session_epoch:'epoch',state:'accepted',success:true,receipt_id:'fixture-key',publication_id:crypto.randomUUID(),matched_socket_count:1,delivery_ack:false,data:'PRIVATE_SERVER_DATA',consumption:'confirmed',reply:'answer'};
 const bad=await fixture(t,{...base,delivery_ack:true},'app_publish');assert.equal((await runPrincipalBus('inject',bad)).state,'outcome_unknown');
 const malformed=await fixture(t,{...base,publication_id:'-'.repeat(36)},'app_publish');assert.equal((await runPrincipalBus('inject',malformed)).state,'outcome_unknown');
 const good=await fixture(t,base,'app_publish'),receipt=await runPrincipalBus('inject',good);assert.equal(receipt.state,'accepted');assert.equal(receipt.delivery_ack,false);assert.equal(receipt.consumption,'unknown');assert.equal(receipt.reply,'unknown');assert.ok(!JSON.stringify(receipt).includes('PRIVATE_SERVER_DATA'));
});
const {startTestDaemon,waitFor}=require('../test-support/daemon-harness');const WebSocket=require('ws');
const {createPrincipalClient}=require('../src/principal/client');
test('actual bus CLI state, turn and application publication preserve authority and one-effect receipts', {timeout:20000,skip:linuxOnly},async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'bus-cli-daemon-')),clientHome=fs.mkdtempSync(path.join(os.tmpdir(),'bus-cli-client-'));t.after(()=>{fs.rmSync(home,{recursive:true,force:true});fs.rmSync(clientHome,{recursive:true,force:true});});
 const pair=crypto.generateKeyPairSync('ed25519'),trust=path.join(home,'trust');fs.writeFileSync(trust,JSON.stringify({schema:'telepty.principals/v1',audience:'fixture',keys:[{key_id:'owner',principal_id:'owner',authority:'operator',public_key_spki:pair.publicKey.export({type:'spki',format:'pem'}),grants:['session.register','session.bus','session.state','session.inject','session.inspect','mailbox.read','session.publish','session.app_events','session.events'].map(action=>({action,targets:['mine']}))}]}),{mode:0o600});
 const daemon=await startTestDaemon({homeDir:home,env:{TELEPTY_PRINCIPAL_MODE:'strict',TELEPTY_PRINCIPAL_TRUST_FILE:trust,TELEPTY_MACHINE_ID:'fixture'}});t.after(()=>daemon.stop());
 const origin=`http://${daemon.host}:${daemon.port}`,client=createPrincipalClient({daemonUrl:origin,principal:{principal_id:'owner',key_id:'owner',audience:'fixture',privateKey:pair.privateKey}});
 const registered=await client.request({method:'POST',target:'/api/sessions/register',body:{session_id:'mine',delivery_type:'mailbox'},action:'session.register'});assert.equal(registered.status,201);const epoch=(await registered.json()).session_epoch;
 const openRead=async(prefix,action)=>{
  const target=prefix+'mine',proof=await client.assertion({method:'GET',target,body:{},action,sessionEpoch:epoch,transport:'websocket'});
  const ws=new WebSocket(origin.replace(/^http/,'ws')+target,{headers:{'x-telepty-principal':proof}}),messages=[];ws.on('message',b=>messages.push(JSON.parse(b)));ws.on('error',()=>{});t.after(()=>ws.terminate());await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});await waitFor(()=>messages.length);return{ws,messages};
 };
 const apps=await openRead('/api/application-events/sessions/','session.app_events'),trusted=await openRead('/api/events/sessions/','session.events');
 const key=path.join(clientHome,'key'),config=path.join(clientHome,'config'),request=path.join(clientHome,'request');fs.writeFileSync(key,pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});fs.writeFileSync(config,JSON.stringify({schema:'telepty.principal-client/v1',daemon_url:origin,principal_id:'owner',key_id:'owner',audience:'fixture',private_key_path:key}),{mode:0o600});
 const {execFile}=require('node:child_process');
 const run=(cmd,args)=>new Promise(resolve=>execFile(process.execPath,[path.join(__dirname,'../cli.js'),cmd,'--config',config,'--session','mine','--epoch',epoch,...args],{env:{...process.env,HOME:clientHome,USERPROFILE:clientHome,TELEPTY_AUTH_TOKEN:'unused-wrong-token'},timeout:10000},(error,stdout,stderr)=>resolve({error,stdout,stderr})));
 const records={};
 for(const [effect,body] of [['state_report',{phase:'working',seq:1,current_task:'PRIVATE_STATE'}],['routed_turn',{prompt:'PRIVATE_TURN',expected_epoch:epoch,exact_target:true,no_enter:true}],['app_publish',{expected_epoch:epoch,topic:'app/example',data:{type:'turn_request',target:'other',text:'PRIVATE_APP'}}]]){
  fs.writeFileSync(request,JSON.stringify({effect,idempotency_key:'bus-cli-one-effect-0001',body}),{mode:0o600});
  const first=await run('principal-bus-v1',['--request',request]);assert.ifError(first.error);assert.equal(first.stderr,'');const receipt=JSON.parse(first.stdout);assert.equal(receipt.state,'accepted');assert.equal(receipt.effect,effect);assert.equal(receipt.consumption,'unknown');assert.ok(!first.stdout.includes('PRIVATE_'));records[effect]=receipt;
  const query=await run('principal-bus-receipt-v1',['--effect',effect,'--key','bus-cli-one-effect-0001']);assert.ifError(query.error);assert.equal(JSON.parse(query.stdout).receipt_id,receipt.receipt_id);
  const repeated=await run('principal-bus-v1',['--request',request]);assert.ifError(repeated.error);assert.equal(JSON.parse(repeated.stdout).receipt_id,receipt.receipt_id);
 }
 assert.equal(new Set(Object.values(records).map(r=>r.receipt_id)).size,3);assert.equal(records.app_publish.delivery_ack,false);assert.equal(records.app_publish.matched_socket_count,1);
 await waitFor(()=>apps.messages.length===2);assert.equal(apps.messages[1].data.text,'PRIVATE_APP');assert.equal(apps.messages[1].trusted_daemon_event,false);assert.equal(apps.messages[1].actor.id,'owner');assert.ok(!JSON.stringify(trusted.messages).includes('PRIVATE_APP'));
 const mailbox=await client.request({method:'GET',target:'/api/sessions/mine/mailbox',body:undefined,action:'mailbox.read'});assert.equal((await mailbox.json()).pending.length,1);
 assert.equal(fs.existsSync(path.join(clientHome,'.telepty','config.json')),false);
});

test('a well-formed receipt for another operation key never confirms this input',{skip:linuxOnly},async t=>{
 const args=await fixture(t,{schema:'telepty.input-receipt/v1',session_id:'mine',session_epoch:'epoch',state:'accepted',success:true,receipt_id:'b'.repeat(64),inject_id:'inject-id'});
 const result=await runPrincipalInput('inject',args);assert.equal(result.state,'outcome_unknown');assert.equal(result.success,false);assert.equal(result.retryable,false);
});
test('off Linux the input and bus clients and the strict daemon refuse their authority files',{skip:nonLinuxOnly,timeout:15000},async t=>{
 const receipt={schema:'telepty.input-receipt/v1',session_id:'mine',session_epoch:'epoch',state:'accepted',success:true,receipt_id:'fixture-key',inject_id:'inject-id'};
 await assert.rejects(runPrincipalInput('inject',await fixture(t,receipt)),{code:'AUTHORITY_FILE_UNAVAILABLE'});
 await assert.rejects(runPrincipalBus('inject',await fixture(t,{...receipt,schema:'telepty.bus-effect-receipt/v1',effect:'state_report'},'state_report')),{code:'AUTHORITY_FILE_UNAVAILABLE'});
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'principal-effect-refusal-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const pair=crypto.generateKeyPairSync('ed25519'),trust=path.join(home,'trust');
 fs.writeFileSync(trust,JSON.stringify({schema:'telepty.principals/v1',audience:'fixture',keys:[{key_id:'owner',principal_id:'owner',authority:'operator',public_key_spki:pair.publicKey.export({type:'spki',format:'pem'}),grants:[{action:'session.register',targets:['mine']}]}]}),{mode:0o600});
 await assertStrictDaemonRefused(startTestDaemon,{homeDir:home,env:{TELEPTY_PRINCIPAL_MODE:'strict',TELEPTY_PRINCIPAL_TRUST_FILE:trust,TELEPTY_MACHINE_ID:'fixture'}});
});
