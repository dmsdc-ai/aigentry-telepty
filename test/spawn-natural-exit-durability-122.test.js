'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {registerSpawnRoute}=require('../src/routes/spawn');
const persistence=require('../src/session-store/persistence');
function fixture(t){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'natural-exit-122-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const file=path.join(home,'sessions.json'),sessions=Object.create(null),events=[];let exit,handler,fault=null;
 const child={pid:12345,onData:()=>{},onExit:fn=>{exit=fn;},kill:()=>events.push('unexpected-kill')};
 const save=()=>{if(fault==='before')return{ok:false,committed:false};if(fault==='throw')throw Error('synthetic storage failure');const result=persistence.savePersistedSessions(sessions,file);return fault==='after'?{ok:false,committed:true}:result;};
 registerSpawnRoute({post:(_route,fn)=>{handler=fn;}},{sessions,sessionStateManager:{register:()=>{},feed:()=>{},markDead:()=>events.push('observed-exit'),unregister:()=>events.push('unregister')},pty:{spawn:()=>child},persistSessions:save,appendToOutputRing:()=>{},revokeSessionCredential:()=>events.push('revoke'),busClients:new Set(),os:{platform:()=>process.platform},buildSessionEnv:()=>({}),admission:{take:()=>({allowed:true})}});
 const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
 handler({body:{session_id:'fixture',command:process.execPath,args:[],cwd:home},headers:{}},res);assert.equal(res.statusCode,201);
 return{sessions,record:sessions.fixture,events,file,exit:()=>exit({exitCode:0,signal:0}),setFault:value=>{fault=value;}};
}
for(const fault of ['before','after','throw'])test(`natural exit keeps a fenced namespace until removal is durable (${fault})`,t=>{
 const f=fixture(t),original=fs.readFileSync(f.file,'utf8');f.setFault(fault);
 assert.doesNotThrow(f.exit);assert.equal(f.sessions.fixture,f.record);assert.equal(f.record.isClosing,true);assert.equal(f.record.ready,false);assert.equal(f.record.closeDurabilityPending,true);
 assert.equal(f.record.ptyProcess,null);assert.equal(f.record.ptyPid,null);
 assert.ok(!f.events.includes('revoke'));assert.ok(!f.events.includes('unregister'));assert.ok(!f.events.includes('unexpected-kill'));
 if(fault==='before'||fault==='throw')assert.equal(fs.readFileSync(f.file,'utf8'),original);
 f.setFault(null);assert.equal(f.record.retryNaturalExitCleanup(),true);
 assert.equal(f.sessions.fixture,undefined);assert.deepEqual(persistence.loadPersistedSessions(f.file),{});
 assert.equal(f.events.filter(x=>x==='revoke').length,1);assert.equal(f.events.filter(x=>x==='unregister').length,1);
 assert.equal(f.record.retryNaturalExitCleanup(),false);assert.equal(f.events.filter(x=>x==='revoke').length,1);
});
test('late exit/retry cannot remove a successor with the same textual SID',t=>{
 const f=fixture(t);f.setFault('before');f.exit();const retry=f.record.retryNaturalExitCleanup,successor={id:'fixture',type:'wrapped',command:'successor',clients:new Set()};f.sessions.fixture=successor;f.setFault(null);
 assert.equal(retry(),false);f.exit();assert.equal(f.sessions.fixture,successor);assert.ok(!f.events.includes('revoke'));
});
test('a failing client close does not abort the observed-exit persistence path',t=>{
 const f=fixture(t);f.record.clients.add({close:()=>{throw Error('synthetic client close failure');}});
 assert.doesNotThrow(f.exit);assert.equal(f.sessions.fixture,undefined);assert.deepEqual(persistence.loadPersistedSessions(f.file),{});assert.ok(f.events.includes('revoke'));
});
test('a later close cannot signal the retired native PID after observed exit',async t=>{
 const f=fixture(t);f.setFault('before');f.exit();const lifecycle=require('../src/lifecycle');assert.equal(lifecycle.getSessionPid(f.record),null);
 const result=await lifecycle.killSessionProcess(f.record,{timeoutMs:0,processKill:()=>assert.fail('retired process must never be signaled')});assert.equal(result.reason,'NO_PROCESS');
});
test('actual child exit retains the SID through unavailable storage and health sweep commits recovery',{skip:process.platform!=='linux',timeout:15000},async t=>{
 const {startTestDaemon,waitFor}=require('../test-support/daemon-harness');const h=await startTestDaemon({env:{TELEPTY_HEALTH_POLL_MS:'100'}});t.after(()=>h.stop());
 const ready=path.join(h.homeDir,'child-ready'),trigger=path.join(h.homeDir,'child-exit');
 const program=`const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{if(fs.existsSync(${JSON.stringify(trigger)}))process.exit(0);},10);`;
 const created=await h.request('/api/sessions/spawn',{method:'POST',body:{session_id:'natural-exit',command:process.execPath,args:['-e',program],cwd:h.homeDir}});assert.equal(created.status,201,JSON.stringify(created.body));await waitFor(()=>fs.existsSync(ready));
 const file=path.join(h.homeDir,'.config','aigentry-telepty','sessions.json'),backup=file+'.previous';fs.renameSync(file,backup);fs.mkdirSync(file);fs.writeFileSync(trigger,'exit');
 await waitFor(()=>h.getLogs().stderr.includes('namespace remains fenced'));
 assert.equal((await h.request('/api/sessions/natural-exit')).status,200);
 const reused=await h.request('/api/sessions/spawn',{method:'POST',body:{session_id:'natural-exit',command:process.execPath,args:[],cwd:h.homeDir}});assert.equal(reused.status,409);
 fs.rmdirSync(file);fs.renameSync(backup,file);
 await waitFor(async()=> (await h.request('/api/sessions/natural-exit')).status===404);
 assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(file,'utf8')),'natural-exit'),false);assert.equal(h.isAlive(),true);
});
