'use strict';
// Migrated measured oracle; repository runtime and exact security scan pending.
// Named groups include setup/imports, not exclusively product test cases.
const {test:nodeTest}=require('node:test');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),os=require('node:os');
const assert=require('node:assert/strict');
nodeTest('ssh security regression 681', {concurrency:false}, async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'telepty-ssh-681-'));
 const fixture=path.join(root,'fixture');
 const privateEnv={HOME:path.join(root,'private','home'),USERPROFILE:path.join(root,'private','home'),XDG_CONFIG_HOME:path.join(root,'private','config'),XDG_DATA_HOME:path.join(root,'private','data'),TMPDIR:path.join(root,'private','tmp')};
 const fixtureEnv=[];
 const keys=[...Object.keys(privateEnv),...fixtureEnv],saved=new Map(keys.map(k=>[k,process.env[k]]));
 const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
 const effects=[],plan={"operations":["fixture-root","import-peer","factory","file-seed","unknown-disconnect","file-only-remove","connect-literal","duplicate","remote-list","disconnect","startup-failure","availability-failure","connect-one","connect-two","disconnect-all","known-peers","active-empty","valid-literal-path-connect","valid-duplicate","valid-remote-list","valid-transport-refusal","valid-remote-refusal","valid-disconnect","validation-factory","reject-null","reject-number","reject-object","reject-array","reject-empty","reject-empty-user","reject-empty-host","reject-multiple-at","reject-leading-option","reject-user-option","reject-space","reject-tab","reject-nul","reject-c1","reject-del","reject-terminal-newline","reject-semicolon","reject-quote","reject-slash","reject-backslash","reject-uri","reject-port","reject-zone","reject-bracket-zone","username-input-empty","username-reject-empty","username-input-option","username-reject-option","username-input-newline","username-reject-newline","username-valid-input","accept-alias","disconnect-alias","accept-ipv4","disconnect-ipv4","accept-ipv6","disconnect-ipv6","accept-bracket-ipv6","disconnect-bracket-ipv6","accept-user","disconnect-user","accept-dollar-user","disconnect-dollar-user","accept-user-ipv6","disconnect-user-ipv6","persisted-malformed-input","persisted-list-bad","persisted-list-missing","persisted-inject-refusal","persisted-shared-refusal"],"weights":{}};
 let operations=0,countedOperations=0,extraSnapshot=()=>({});
 async function op(id,fn){
  assert.equal(plan.operations[operations],id);
  operations++;countedOperations+=plan.weights[id]||1;
  let failed=false,value;
  await t.test(id,async()=>{
   try{value=await fn();}
   catch{failed=true;throw new Error('Regression assertion failed in '+id+'; private values suppressed');}
  });
  if(failed)throw new Error('Dependent sequence stopped after '+id);
  return value;
 }
function inventory(){
 const result=[];let total=0;
 for(const start of [fixture,path.join(root,'private','home')]){
 if(!fs.existsSync(start))continue;
 function visit(dir){for(const n of fs.readdirSync(dir).sort()){const p=path.join(dir,n),s=fs.lstatSync(p);
 const row={path:path.relative(root,p),mode:s.mode&0o777,ino:s.ino,nlink:s.nlink};
 if(s.isSymbolicLink()){const target=fs.readlinkSync(p);assert.ok(path.resolve(path.dirname(p),target).startsWith(fixture+path.sep));result.push({...row,type:'link',target});}
 else if(s.isDirectory()){result.push({...row,type:'directory'});visit(p);}
 else{assert.ok(s.isFile()&&s.size<=65536);const b=fs.readFileSync(p);total+=b.length;assert.ok(total<=524288);result.push({...row,type:'file',size:s.size,mtimeMs:s.mtimeMs,sha256:sha(b)});}
 assert.ok(result.length<=240);
 }}visit(start);
 }return result;
}

 try{
  for(const dir of new Set(Object.values(privateEnv)))fs.mkdirSync(dir,{recursive:true,mode:0o700});
  for(const [k,v] of Object.entries(privateEnv))process.env[k]=v;
  for(const k of fixtureEnv)delete process.env[k];
async function main(){
 let peer,phase='normal',processCaptures=0,userCalls=0,validationPeer,username='finite-user',spawnMode='normal';
 const capture=(kind,args)=>{assert.ok(++processCaptures<=64);effects.push({kind,args});};
 const seams={
  execFileSync(command,args,options){
   capture('execFileSync',[command,args,options]);assert.equal(command,'ssh');assert.ok(Array.isArray(args));assert.ok(!options.shell);
   if(phase==='startup-failure'&&args.includes('-N'))throw Error('captured startup failure');
   if(phase==='availability-failure'&&args.at(-1)==='telepty list --json')throw Error('captured availability failure');
   if(args.at(-1)==='hostname')return '  fixture-machine  \n';
   return 'ignored availability output, not JSON';
  },
  spawnSync(command,args,options){
   capture('spawnSync',[command,args,options]);assert.equal(command,'ssh');
   if(spawnMode==='transport')return {status:255,stdout:'',stderr:'fixture transport refusal'};
   if(spawnMode==='remote-refusal')return {status:1,stdout:'',stderr:'fixture remote refusal'};
   return {status:0,stdout:'[{"id":"remote-input"}]',stderr:''};
  },
  spawn(...args){capture('spawn',args);throw Error('remoteAttach unselected');}
 };
 try{
 await op('fixture-root',()=>fs.mkdirSync(fixture,{mode:0o700}));
 await op('import-peer',()=>{require('../cross-machine.js');});
 const {createPeerContext}=require('../cross-machine.js');
 const peersPath=path.join(fixture,'peers.json'),controlDir=path.join(fixture,'control root;literal');
 await op('factory',()=>{peer=createPeerContext({...seams,PEERS_PATH:peersPath,CONTROL_DIR:controlDir,getUsername:()=>{userCalls++;return 'finite-user';}});});
 await op('file-seed',()=>fs.writeFileSync(peersPath,JSON.stringify({peers:{seed:{target:'seed@literal',machineId:'seed-input'}}}),{flag:'wx',mode:0o600}));
 await op('unknown-disconnect',()=>{const n=processCaptures,r=peer.disconnect('unknown');assert.deepEqual(r,{success:false,error:'Not connected to unknown'});assert.equal(processCaptures,n);return r;});
 await op('file-only-remove',()=>{const n=processCaptures,r=peer.removePeer('seed');assert.deepEqual(r,{success:true});assert.deepEqual(JSON.parse(fs.readFileSync(peersPath)),{peers:{}});assert.equal(processCaptures,n);return r;});
 const target='fixture@host name;literal';
 await op('connect-literal',async()=>{const before=inventory(),n=processCaptures,u=userCalls;const r=await peer.connect(target,{name:'literal'});assert.deepEqual(r,{success:false,error:'Invalid SSH target.'});assert.equal(processCaptures,n);assert.equal(userCalls,u);assert.equal(fs.existsSync(controlDir),false);assert.deepEqual(inventory(),before);return r;});
 await op('duplicate',async()=>{const n=processCaptures,r=await peer.connect(target,{name:'literal'});assert.deepEqual(r,{success:false,error:'Invalid SSH target.'});assert.equal(processCaptures,n);return r;});
 await op('remote-list',()=>{const n=processCaptures,r=peer.listRemoteSessions('literal');assert.deepEqual(r,[]);assert.equal(processCaptures,n);return r;});
 await op('disconnect',()=>{const n=processCaptures,r=peer.disconnect('literal');assert.deepEqual(r,{success:false,error:'Not connected to literal'});assert.equal(processCaptures,n);assert.equal(JSON.parse(fs.readFileSync(peersPath)).peers.literal,undefined);return r;});
 await op('startup-failure',async()=>{phase='startup-failure';const n=effects.length,r=await peer.connect('startup.invalid',{name:'failed-start'});assert.equal(r.success,false);assert.match(r.error,/captured startup failure/);assert.equal(effects.length-n,1);assert.ok(!JSON.parse(fs.readFileSync(peersPath)).peers['failed-start']);return r;});
 await op('availability-failure',async()=>{phase='availability-failure';const n=effects.length,r=await peer.connect('availability.invalid',{name:'failed-availability'});assert.equal(r.success,false);assert.match(r.error,/captured availability failure/);assert.equal(effects.length-n,4);assert.deepEqual(effects.at(-1).args[1],['-O','exit','-S',path.join(controlDir,'ctrl-finite-user@availability.invalid'),'finite-user@availability.invalid']);assert.deepEqual(effects.at(-1).args[2],{stdio:'pipe'});return r;});
 await op('connect-one',async()=>{phase='normal';const r=await peer.connect('one.invalid',{name:'one'});assert.equal(r.success,true);assert.equal(JSON.parse(fs.readFileSync(peersPath)).peers.one.target,'finite-user@one.invalid');return r;});
 await op('connect-two',async()=>{const r=await peer.connect('two.invalid',{name:'two'});assert.equal(r.success,true);return r;});
 await op('disconnect-all',()=>{const n=effects.length,r=peer.disconnectAll();assert.deepEqual(r,{disconnected:['one','two']});assert.equal(effects.length-n,2);return r;});
 await op('known-peers',()=>{const r=peer.listKnownPeers();assert.deepEqual(Object.keys(r),['one','two']);return r;});
 await op('active-empty',()=>{assert.deepEqual(peer.listActivePeers(),[]);});

 const valid='fixture@host-name',ctrl=path.join(controlDir,'ctrl-'+valid);
 await op('valid-literal-path-connect',async()=>{const n=effects.length,r=await peer.connect(valid,{name:'valid'});assert.deepEqual(r,{success:true,name:'valid',machineId:'fixture-machine'});
 assert.deepEqual(effects.slice(n).map(e=>e.args),[
 ['ssh',['-o','ControlMaster=auto','-S',ctrl,'-o','ControlPersist=600','-o','ConnectTimeout=10','-o','ServerAliveInterval=30','-o','ServerAliveCountMax=3','-o','StrictHostKeyChecking=accept-new','-N','-f',valid],{timeout:15000,stdio:['pipe','pipe','pipe']}],
 ['ssh',['-S',ctrl,valid,'hostname'],{timeout:5000,encoding:'utf8',stdio:['pipe','pipe','pipe']}],
 ['ssh',['-S',ctrl,valid,'telepty list --json'],{timeout:10000,encoding:'utf8',stdio:['pipe','pipe','pipe']}]
 ]);assert.equal(JSON.parse(fs.readFileSync(peersPath)).peers.valid.target,valid);return r;});
 await op('valid-duplicate',async()=>{const n=effects.length;assert.deepEqual(await peer.connect(valid,{name:'valid'}),{success:false,error:'Already connected to valid'});assert.equal(effects.length,n);});
 await op('valid-remote-list',()=>{assert.deepEqual(peer.listRemoteSessions('valid'),[{id:'remote-input',host:valid,peerName:'valid',remote:true}]);assert.deepEqual(effects.at(-1).args,['ssh',['-S',ctrl,valid,'telepty list --json'],{timeout:10000,encoding:'utf8',input:undefined,stdio:['pipe','pipe','pipe']}]);});
 await op('valid-transport-refusal',()=>{spawnMode='transport';try{assert.deepEqual(peer.listRemoteSessions('valid'),[]);}finally{spawnMode='normal';}});
 await op('valid-remote-refusal',()=>{spawnMode='remote-refusal';try{assert.throws(()=>peer.listRemoteSessions('valid'),e=>e.name==='PeerResponseError'&&e.peer==='valid');}finally{spawnMode='normal';}});
 await op('valid-disconnect',()=>{assert.deepEqual(peer.disconnect('valid'),{success:true,name:'valid'});assert.deepEqual(effects.at(-1).args,['ssh',['-O','exit','-S',ctrl,valid],{timeout:5000,stdio:['pipe','pipe','pipe']}]);assert.ok(JSON.parse(fs.readFileSync(peersPath)).peers.valid);});
 const validationDir=path.join(fixture,'validation control;root'),validationPath=path.join(fixture,'validation-peers.json');
 await op('validation-factory',()=>{validationPeer=createPeerContext({...seams,PEERS_PATH:validationPath,CONTROL_DIR:validationDir,getUsername:()=>{userCalls++;return username;}});});
 const invalidTargets=[["null",null],["number",7],["object",{}],["array",[]],["empty",""],["empty-user","@host"],["empty-host","user@"],["multiple-at","a@b@c"],["leading-option","-host"],["user-option","-user@host"],["space","bad host"],["tab","bad\thost"],["nul","bad\u0000host"],["c1","badhost"],["del","badhost"],["terminal-newline","host\n"],["semicolon","host;literal"],["quote","host'quote"],["slash","host/path"],["backslash","host\\path"],["uri","ssh://host"],["port","host:22"],["zone","fe80::1%en0"],["bracket-zone","[fe80::1%en0]"]];
 for(const [id,value] of invalidTargets)await op('reject-'+id,async()=>{const before=inventory(),n=processCaptures,u=userCalls;assert.deepEqual(await validationPeer.connect(value,{name:'invalid'}),{success:false,error:'Invalid SSH target.'});assert.equal(processCaptures,n);assert.equal(userCalls,u);assert.equal(fs.existsSync(validationDir),false);assert.deepEqual(inventory(),before);});
 for(const [id,value] of [['empty',''],['option','-user'],['newline','user\n']]){
  await op('username-input-'+id,()=>{username=value;});
  await op('username-reject-'+id,async()=>{const before=inventory(),n=processCaptures,u=userCalls;assert.deepEqual(await validationPeer.connect('valid-host',{name:'invalid-user'}),{success:false,error:'Invalid SSH target.'});assert.equal(processCaptures,n);assert.equal(userCalls,u+1);assert.equal(fs.existsSync(validationDir),false);assert.deepEqual(inventory(),before);});
 }
 await op('username-valid-input',()=>{username='finite-user';});
 for(const [id,value] of [["alias","_host-name.example"],["ipv4","127.0.0.1"],["ipv6","::1"],["bracket-ipv6","[2001:db8::1]"],["user","user.name-1@host"],["dollar-user","user$@host"],["user-ipv6","_user@[::1]"]]){
  await op('accept-'+id,async()=>{const n=effects.length;assert.equal((await validationPeer.connect(value,{name:id})).success,true);const operand=value.includes('@')?value:'finite-user@'+value;assert.equal(effects.length-n,3);assert.equal(effects[n].args[1].at(-1),operand);assert.equal(JSON.parse(fs.readFileSync(validationPath)).peers[id].target,operand);});
  await op('disconnect-'+id,()=>{assert.deepEqual(validationPeer.disconnect(id),{success:true,name:id});});
 }
 await op('persisted-malformed-input',()=>{const data=JSON.parse(fs.readFileSync(validationPath));data.peers.bad={target:'-option',transport:'ssh'};data.peers.missing={transport:'ssh'};fs.writeFileSync(validationPath,JSON.stringify(data));});
 for(const name of ['bad','missing']){
  await op('persisted-list-'+name,()=>{const n=effects.length,b=inventory();assert.throws(()=>validationPeer.listRemoteSessions(name),e=>e.code==='INVALID_SSH_TARGET');assert.equal(effects.length,n);assert.deepEqual(inventory(),b);});
 }
 await op('persisted-inject-refusal',()=>{const n=effects.length;assert.deepEqual(validationPeer.remoteInject('bad','sid','literal'),{success:false,error:'Invalid SSH target.'});assert.equal(effects.length,n);});
 await op('persisted-shared-refusal',()=>{const n=effects.length;assert.deepEqual(validationPeer.remoteEnsureSharedContext('bad',{fileName:'unused',content:'literal'}),{success:false,error:'Invalid SSH target.'});assert.equal(effects.length,n);});
 }finally{
  // Terminal seams are inert; remove only this test's owned tree in outer finally.
 }
 assert.equal(operations,74);assert.equal(countedOperations,74);assert.equal(processCaptures,48);
}

  await main();
 }finally{
  try{for(const [k,v] of saved){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
  finally{fs.rmSync(root,{recursive:true,force:true});}
 }
});
