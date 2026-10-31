'use strict';
// Migrated measured oracle; repository runtime and exact security scan pending.
// Named groups include setup/imports, not exclusively product test cases.
const {test:nodeTest}=require('node:test');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),os=require('node:os');
const assert=require('node:assert/strict');
nodeTest('cli security regression 681', {concurrency:false}, async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'telepty-cli-681-')));
 const fixture=path.join(root,'fixture');
 // #879: spawnChild always runs the production buildPtySpawnTarget, whose win32 PATH x PATHEXT walk cannot
 // resolve the synthetic bare name. On win32 the tool is an absolute .exe path (never executed: spawnPty is
 // captured) outside the inventoried trees, so the real builder's direct-.exe argv path is what gets asserted.
 const spawnTool=process.platform==='win32'?path.join(root,'win-bin','generic-tool.exe'):'generic-tool';
 if(process.platform==='win32'){fs.mkdirSync(path.dirname(spawnTool),{recursive:true});fs.writeFileSync(spawnTool,'synthetic');}
 const privateEnv={HOME:path.join(root,'private','home'),USERPROFILE:path.join(root,'private','home'),XDG_CONFIG_HOME:path.join(root,'private','config'),XDG_DATA_HOME:path.join(root,'private','data'),TMPDIR:path.join(root,'private','tmp')};
 const fixtureEnv=["TELEPTY_SKIP_PACKAGE_UPDATE", "TELEPTY_UPDATE_COMMAND", "TELEPTY_AUTH_TOKEN", "TELEPTY_SESSION_ID", "TELEPTY_SESSION_TOKEN", "TELEPTY_SESSION_NONCE", "TELEPTY_AVAILABLE"];
 const keys=[...Object.keys(privateEnv),...fixtureEnv],saved=new Map(keys.map(k=>[k,process.env[k]]));
 const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
 const effects=[],plan={"operations":["fixture-root","import-providers","config-mint","peer-factory","peer-file-input","cli-factory","help-table","auth-cache","auth-target-peer","auth-target-local","auth-target-refusal","auth-env-override","parser-explicit","parser-help","parser-default","parser-exit","update-skip","update-default","update-override","update-throws","credential-factory","state-factory","record-factory","http-factory","http-jwt-factory","http-peer-factory","http-origin-factory","http-auth-register","http-record-register","actual-registration","streams-input","terminal-attach","backend-provider","allow-factory","actual-spawn-metadata","bridge-factory","prompt-registry-negative","prompt-registry-positive","interaction-writer-factory","interaction-invalid-frame","enqueue-positive","recover-positive","flush-positive","callback-positive","invalid-target-input","recover-invalid","enqueue-fallback","empty-flush-invalid","dequeue-target-input","enqueue-dequeue","corrupt-dequeue-leaf","recover-unsafe","flush-dequeue-refusal","filter-target-input","seed-old","seed-same-a","seed-same-b","recover-filter","flush-filter","callback-filter","ack-target-input","enqueue-ack","flush-ack","corrupt-ack-leaf","callback-ack-refusal","throw-target-input","enqueue-throw","flush-throw","callback-throw","close-target-input","enqueue-close","flush-close","schedule-idle","cleanup-timer-inputs","close-preserve","close-idempotent","callback-after-close","harness-timer-cleanup","second-terminal-attach","second-allow-factory","enqueue-destroy","close-destroy","closed-enqueue","closed-flush","closed-schedule","closed-recover","shared-flag-reset-input","old-context-after-reset","queue-context-setup","queue-enqueue","queue-schedule","queue-close","queue-stale-callback","idle-stale-callback","queue-repeated-close","replace-before-setup","replace-before-enqueue","replace-before-flush","replace-before-input","replace-before-callback","replace-before-close","replace-before-stale","close-on-send-setup","close-on-send-enqueue","close-on-send-flush","close-on-send-input","close-on-send-callback","close-on-send-close","close-on-send-stale","close-on-write-setup","close-on-write-enqueue","close-on-write-flush","close-on-write-input","close-on-write-callback","close-on-write-close","close-on-write-stale","replace-on-send-setup","replace-on-send-enqueue","replace-on-send-flush","replace-on-send-input","replace-on-send-callback","replace-on-send-close","replace-on-send-stale","replace-on-write-setup","replace-on-write-enqueue","replace-on-write-flush","replace-on-write-input","replace-on-write-callback","replace-on-write-close","replace-on-write-stale"],"weights":{"import-providers":18,"fixture-root":2,"config-mint":2,"backend-provider":2,"actual-registration":6,"terminal-attach":2,"prompt-registry-negative":2,"second-terminal-attach":3,"cleanup-timer-inputs":2,"actual-spawn-metadata":6,"http-auth-register":2,"old-context-after-reset":5,"queue-context-setup":4,"replace-before-setup":4,"close-on-send-setup":4,"close-on-write-setup":4,"replace-on-send-setup":4,"replace-on-write-setup":4,"close-on-send-callback":2,"close-on-write-callback":2}};
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
const {EventEmitter}=require('node:events'),http=require('node:http'),{Duplex}=require('node:stream');
const envInputs=['TELEPTY_SKIP_PACKAGE_UPDATE','TELEPTY_UPDATE_COMMAND','TELEPTY_AUTH_TOKEN','TELEPTY_SESSION_ID','TELEPTY_SESSION_TOKEN','TELEPTY_SESSION_NONCE'];
async function scopedEnv(values,fn){
 for(const k of Object.keys(values))assert.ok(envInputs.includes(k));
 const before={...process.env};
 try{for(const [k,v] of Object.entries(values)){if(v===null)delete process.env[k];else process.env[k]=v;}return await fn();}
 finally{
  const mutable=[...envInputs,'TELEPTY_AVAILABLE']; // product-generated output; later grant must expressly admit restoration
  for(const k of new Set([...Object.keys(process.env),...Object.keys(before)]))
   if(!mutable.includes(k))assert.equal(process.env[k],before[k]);
  for(const k of mutable){if(Object.hasOwn(before,k))process.env[k]=before[k];else delete process.env[k];}
  assert.deepEqual({...process.env},before);
 }
}
let httpCalls=0,wireBytes=0,callbackAdvances=0,processCaptures=0;
const httpRecords=[],pendingHTTP=[],timeouts=new Map(),intervals=new Map(),stateHandles=new Map(),callbackArchive=new Map();
let handle=0;
const scheduler={
 setTimeout(fn,ms){const id=++handle;assert.ok(id<=128);timeouts.set(id,{fn,ms});callbackArchive.set(id,{fn,ms});return id;},
 clearTimeout(id){timeouts.delete(id);},
 setInterval(fn,ms){const id=++handle;assert.ok(id<=128);intervals.set(id,{fn,ms});callbackArchive.set(id,{fn,ms});return id;},
 clearInterval(id){intervals.delete(id);}
};
function advanceOne(){
 assert.ok(++callbackAdvances<=64);const [id,t]=timeouts.entries().next().value||[];
 assert.ok(id);timeouts.delete(id);effects.push({kind:'callback',id,delay:t.ms});return t.fn();
}
function advanceArchived(id){
 assert.ok(++callbackAdvances<=64);const t=callbackArchive.get(id);assert.ok(t);
 effects.push({kind:'archived-callback',id,delay:t.ms});return t.fn();
}
function journal(target,name='state.jsonl'){
 const p=path.join(fixture,'bridge',target,name);
 const st=fs.lstatSync(p);assert.ok(st.isFile()&&!st.isSymbolicLink());
 return fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}
function corrupt(target,leaf){
 const p=path.join(fixture,'bridge',target,leaf);
 fs.renameSync(p,p+'.retained');fs.symlinkSync(path.join(fixture,'sentinel'),p);
}
function terminalStreams(){
 const input=new EventEmitter(),output=new EventEmitter();
 input.isTTY=true;input.setRawMode=v=>effects.push({kind:'raw',value:v});
 input.resume=()=>effects.push({kind:'resume'});input.pause=()=>effects.push({kind:'pause'});
 output.columns=91;output.rows=33;output.write=data=>effects.push({kind:'stdout',data});
 return {input,output};
}
async function realHttp(app,url,options){
 assert.ok(++httpCalls<=48);const u=new URL(url);assert.ok(['localhost','127.0.0.1'].includes(u.hostname));
 const bytes=Buffer.from(options.body||'');assert.ok(bytes.length<=1024);
 const transport=new Duplex({read(){},write(c,e,cb){cb();},autoDestroy:false});transport.remoteAddress='127.0.0.1';
 const chunks=[];let size=0,fed=false;
 const sink=new Duplex({read(){},write(c,e,cb){size+=c.length;wireBytes+=c.length;if(size>65536||wireBytes>1048576)return cb(Error('wire budget'));chunks.push(Buffer.from(c));cb();},autoDestroy:false});
 const req=new http.IncomingMessage(transport);req.method=options.method||'GET';req.url=u.pathname+u.search;req.httpVersion='1.1';req.httpVersionMajor=1;req.httpVersionMinor=1;
 req.headers=Object.fromEntries(Object.entries(options.headers||{}).map(([k,v])=>[k.toLowerCase(),v]));req.headers['content-length']=String(bytes.length);req.headers.connection='close';req.rawHeaders=Object.entries(req.headers).flat();
 req._read=function(){if(fed)return;fed=true;this.push(bytes);this.complete=true;this.push(null);};
 const res=new http.ServerResponse(req);res.shouldKeepAlive=false;res.assignSocket(sink);
 const objects=[req,res,sink,transport];
 let err=null,timer;
 try{
 await new Promise((resolve,reject)=>{
  timer=setTimeout(()=>reject(Error('HTTP diagnostic timeout')),2000);
  objects.forEach(o=>o.once('error',reject));res.once('finish',()=>setImmediate(resolve));
  try{app.handle(req,res);}catch(e){reject(e);}
 });
 }catch(e){err=e;}
 finally{
  clearTimeout(timer);
  await Promise.all(objects.map(o=>new Promise(resolve=>{if(o.closed)return resolve();o.once('close',resolve);o.destroy();})));
  objects.forEach(o=>o.removeAllListeners());
 }
 const raw=Buffer.concat(chunks).toString('utf8'),body=raw.slice(raw.indexOf('\r\n\r\n')+4);
 const wire={request:{url,method:req.method,headers:req.headers,body:bytes.toString()},status:res.statusCode,rawSha256:sha(raw),raw,body,disposed:objects.every(o=>o.destroyed),listeners:objects.reduce((n,o)=>n+o.eventNames().length,0),error:err?{message:err.message,stack:err.stack}:null};
 httpRecords.push(wire);assert.ok(wire.disposed);assert.equal(wire.listeners,0);if(err)throw err;
 return {ok:res.statusCode>=200&&res.statusCode<300,status:res.statusCode,json:async()=>JSON.parse(body),text:async()=>body};
}

async function main(){
 let state,allow,cli,shared,top,records,credentials,recordContext,app,issued,providers;
 let syntheticNow=Date.now(),throwWrite=false,throwUpdate=false,cleanupTerminal,streams,writer;
 let staleCloseTimer,onCapturedWrite=null,onCapturedSend=null;
 const terminalChild={pid:null,write(data){effects.push({kind:'pty-write',data,closed:shared.allowSessionClosed,generation:shared.interactionBinding.input_generation});if(onCapturedWrite)onCapturedWrite();if(throwWrite)throw Error('captured terminal throw');},resize(c,r){effects.push({kind:'resize',cols:c,rows:r});},kill(){throw Error('native termination not selected');}};
 const capture=(kind,args)=>{assert.ok(++processCaptures<=32);effects.push({kind,args});if(throwUpdate)throw Error('captured update failure');};
 const local=p=>p.startsWith('node_modules/')?require(p.slice('node_modules/'.length)):require('../'+p);
 try{
await op('fixture-root',async()=>{fs.mkdirSync(fixture,{mode:0o700});fs.writeFileSync(path.join(fixture,'sentinel'),'private sentinel',{flag:'wx',mode:0o600});});
await op('import-providers',async()=>{assert.equal(require.cache[require.resolve('../auth.js')],undefined,'auth must first load inside private HOME');providers={
 security:local('src/cli/security-actions.js'),auth:local('auth.js'),cross:local('cross-machine.js'),
 lifecycle:local('src/lifecycle.js'),view:local('src/cli/session-view.js'),windows:local('src/win-resolve-executable.js'),
 terminal:local('interactive-terminal.js'),mailbox:local('src/mailbox/index.js'),
 filter:local('src/mailbox/bridge-flush-filter.js'),ready:local('src/prompt-symbol-registry.js'),
 interaction:local('src/interaction.js'),state:local('session-state.js'),
 records:local('src/routes/session-records.js'),credentials:local('src/session-store/session-credentials.js'),
 httpApp:local('src/protocol/http-app.js'),httpAuth:local('src/protocol/http-auth.js'),
 express:local('node_modules/express'),cors:local('node_modules/cors')};});
await op('config-mint',async()=>{const value=providers.auth.getConfig();assert.equal(typeof value.authToken,'string');assert.ok(value.authToken);assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.telepty/config.json'))).authToken,value.authToken);top={cachedAuthToken:null,cachedPeerTokens:null,getConfig:providers.auth.getConfig,path,lifecycle:providers.lifecycle,PORT:3848,isMainModule:false};return value;});
await op('peer-factory',async()=>{top.crossMachine=providers.cross.createPeerContext({PEERS_PATH:path.join(fixture,'peers.json'),CONTROL_DIR:path.join(fixture,'ssh'),getUsername:()=> 'finite-user',execFileSync(){throw Error('SSH not selected in CLI');},spawnSync(){throw Error('SSH not selected');},spawn(){throw Error('SSH not selected');}});});
await op('peer-file-input',async()=>{fs.writeFileSync(path.join(fixture,'peers.json'),JSON.stringify({peers:{private:{transport:'http',host:'peer.invalid',port:3848,token:'synthetic-peer-token'}}}),{flag:'wx',mode:0o600});});
await op('cli-factory',async()=>{cli=providers.security.createCliSecurityActions(top,{platform:'linux',
 execSync(...a){capture('execSync',a);},execFileSync(...a){capture('execFileSync',a);},
 exit(code){const e=Error('captured exit');e.name='CapturedExit';e.code=code;throw e;},
 fetch(url,options){
  if(options.method==='DELETE'){effects.push({kind:'delete-request',url,options});return Promise.reject(Object.assign(Error('deliberate DELETE transport refusal'),{code:'PRIVATE_REJECTION'}));}
  assert.equal(new URL(url).pathname,'/api/sessions/register');
  const p=realHttp(app,url,options);pendingHTTP.push(p);return p;
 }});});
await op('help-table',async()=>{top.TRAILING_PAYLOAD_HELP=cli.createTrailingPayloadHelp();assert.match(top.TRAILING_PAYLOAD_HELP.allow[0],/^Usage: telepty allow/);});
await op('auth-cache',async()=>{const token=cli.getAuthToken();assert.equal(token,JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.telepty/config.json'))).authToken);assert.equal(top.cachedAuthToken,token);return {token};});
await op('auth-target-peer',async()=>{assert.equal(cli.resolveTargetToken('http://peer.invalid:3848/api/sessions'),'synthetic-peer-token');});
await op('auth-target-local',async()=>{assert.equal(cli.resolveTargetToken('http://127.0.0.1:3848/api/sessions'),top.cachedAuthToken);});
await op('auth-target-refusal',async()=>{assert.throws(()=>cli.resolveTargetToken('http://missing.invalid:3848/x'),e=>e.code==='NO_TARGET_CREDENTIAL');});
await op('auth-env-override',async()=>{await scopedEnv({TELEPTY_AUTH_TOKEN:'synthetic-override'},()=>{assert.equal(cli.resolveTargetToken('http://peer.invalid:3848/x'),'synthetic-override');});});
await op('parser-explicit',async()=>{await scopedEnv({TELEPTY_SESSION_ID:'parent',TELEPTY_SESSION_TOKEN:'parent-token',TELEPTY_SESSION_NONCE:'parent-nonce',TELEPTY_UPDATE_COMMAND:'literal update; data'},()=>{
 const r=cli.parseAllowInvocation('allow',['allow','--id','owned-cli','--idle-ttl','2m','--auto-restart','--','generic-tool','--flag']);
 assert.deepEqual(r,{sessionId:'owned-cli',command:'generic-tool',cmdArgs:['--flag'],idleTtl:'2m',autoRestart:true});
 assert.equal(process.env.TELEPTY_SESSION_ID,'owned-cli');assert.equal(process.env.TELEPTY_SESSION_TOKEN,undefined);assert.equal(process.env.TELEPTY_SESSION_NONCE,undefined);assert.equal(process.env.TELEPTY_AVAILABLE,'true');assert.equal(process.env.TELEPTY_UPDATE_COMMAND,'literal update; data');});});
await op('parser-help',async()=>{await scopedEnv({},()=>{assert.equal(cli.parseAllowInvocation('allow',['allow','--help']),undefined);});});
await op('parser-default',async()=>{await scopedEnv({},()=>{const r=cli.parseAllowInvocation('allow',['allow','--','generic-tool','--help']);assert.equal(r.sessionId,path.basename(process.cwd())+'-generic-tool');assert.deepEqual(r.cmdArgs,['--help']);});});
await op('parser-exit',async()=>{await scopedEnv({},()=>{assert.throws(()=>cli.parseAllowInvocation('allow',['allow','--idle-ttl','bad','tool']),e=>e.name==='CapturedExit'&&e.code===1);});});
await op('update-skip',async()=>{await scopedEnv({TELEPTY_SKIP_PACKAGE_UPDATE:'1'},()=>{const n=effects.length;cli.runUpdateInstall();assert.equal(effects.length,n);});});
await op('update-default',async()=>{await scopedEnv({TELEPTY_SKIP_PACKAGE_UPDATE:null,TELEPTY_UPDATE_COMMAND:null},()=>{cli.runUpdateInstall();assert.deepEqual(effects.at(-1),{kind:'execFileSync',args:['npm',['install','-g','@dmsdc-ai/aigentry-telepty@latest'],{stdio:'inherit'}]});});});
await op('update-override',async()=>{await scopedEnv({TELEPTY_UPDATE_COMMAND:'literal-command --arg "space"; marker'},()=>{cli.runUpdateInstall();assert.deepEqual(effects.at(-1),{kind:'execSync',args:['literal-command --arg "space"; marker',{stdio:'inherit'}]});});});
await op('update-throws',async()=>{await scopedEnv({TELEPTY_UPDATE_COMMAND:null},()=>{throwUpdate=true;try{assert.throws(()=>cli.runUpdateInstall(),/captured update failure/);}finally{throwUpdate=false;}});});
await op('credential-factory',async()=>{credentials=providers.credentials.createCredentialStore();});
await op('state-factory',async()=>{state=new providers.state.SessionStateManager({}, {setInterval(fn,ms){const id=++handle;stateHandles.set(id,{fn,ms});return id;},clearInterval(id){assert.ok(stateHandles.delete(id));}});});
await op('record-factory',async()=>{recordContext=providers.records.createSessionRecordContext({sessions:Object.create(null),sessionCredentials:credentials,sidNonces:new Map(),sessionPersistPath:path.join(fixture,'sessions.json')});});
await op('http-factory',async()=>{app=providers.httpApp.createHttpApp({express:providers.express,cors:providers.cors});});
await op('http-jwt-factory',async()=>{top.verifyJwt=providers.httpAuth.createVerifyJwt('private-test-jwt');});
await op('http-peer-factory',async()=>{top.isAllowedPeer=providers.httpAuth.createIsAllowedPeer([]);});
await op('http-origin-factory',async()=>{top.isForbiddenOrigin=providers.httpAuth.createOriginGuard([]);});
await op('http-auth-register',async()=>{providers.httpApp.registerHealthAndAuth(app,{pkg:local('package.json'),createAuthMiddleware:providers.httpAuth.createAuthMiddleware,EXPECTED_TOKEN:top.cachedAuthToken,verifyJwt:top.verifyJwt,isAllowedPeer:top.isAllowedPeer,isForbiddenOrigin:top.isForbiddenOrigin});});
await op('http-record-register',async()=>{providers.records.registerSessionRegisterRoute(app,{context:recordContext,sessionStateManager:state,busClients:new Set()});});
await op('actual-registration',async()=>{const response=await cli.fetchWithAuth('http://127.0.0.1:3848/api/sessions/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:'owned-cli',command:'generic-tool',cwd:fixture})});assert.equal(response.status,201);issued=await response.json();assert.equal(credentials.verify(issued.session_token).sid,'owned-cli');assert.ok(issued.session_nonce);return issued;});
await op('streams-input',async()=>{streams=terminalStreams();});
await op('terminal-attach',async()=>{cleanupTerminal=providers.terminal.attachInteractiveTerminal(streams.input,streams.output,{onData:data=>effects.push({kind:'input',data}),onResize:()=>effects.push({kind:'terminal-resize',size:providers.terminal.getTerminalSize(streams.output)})});assert.equal(streams.input.listenerCount('data'),1);assert.equal(streams.output.listenerCount('resize'),1);});
await op('backend-provider',async()=>{const backend=cli.classifyBackend({TERM_PROGRAM:'WarpTerminal'},()=>{throw Error('kitty probe not selected');});shared={sessionId:'owned-cli',command:spawnTool,cmdArgs:['--literal','space arg'],detectedBackend:backend,terminalProgram:providers.view.detectTerminalProgram(process.env),terminalType:process.env.TERM,child:null,idleTtl:'2m',DAEMON_URL:'http://127.0.0.1:3848',fetchWithAuth:cli.fetchWithAuth,resolveWindowsExecutable:process.platform==='win32'?(command=>command):providers.windows.resolveWindowsExecutable,/* #879: 'generic-tool' is synthetic; the real win32 PATH×PATHEXT walk throws for it (covered by test/win-resolve-executable.test.js) */sessionCwd:fixture,sessionEnv:{...process.env},bridgeTarget:'positive',bridgeMsgSeq:0,bridgePendingCount:0,promptReady:false,lastUserInputTime:0,IDLE_THRESHOLD:100,knownAiCli:false,outputTail:'',readyRegistry:providers.ready,promptPattern:/> $/,firstReadyObserved:false,queueFlushTimer:null,idleCheckTimer:null,filterBridgeBatch:providers.filter.filterBridgeBatch,bridgeInjectTtlSecs:providers.filter.bridgeInjectTtlSecs,interactionBinding:{input_generation:0,geometry_generation:0,owner_generation:'private'},wsReady:true,daemonWs:{readyState:1,send(text){effects.push({kind:'ws-send',body:JSON.parse(text)});if(onCapturedSend)onCapturedSend();},close(){effects.push({kind:'ws-close'});}},getTerminalSize:providers.terminal.getTerminalSize,allowSessionClosed:false,cleanupTerminal,currentOwnerToken:'private-owner-token',allowSignalHandlers:new Map([['SIGINT',()=>{}]]),FileMailbox:providers.mailbox.FileMailbox,path,os:require('node:os')};
extraSnapshot=()=>({sequence:shared.bridgeMsgSeq,pending:shared.bridgePendingCount,generation:{...shared.interactionBinding},closed:shared.allowSessionClosed,timeouts:[...timeouts.keys()],intervals:[...intervals.keys()]});});
await op('allow-factory',async()=>{allow=providers.security.createAllowSecurityContext(shared,{...scheduler,now:()=>syntheticNow,getStdout:()=>streams.output,bridgeRoot:path.join(fixture,'bridge'),removeSignalHandler(signal){effects.push({kind:'signal-off',signal});},spawnPty(command,args,options){capture('spawnPty',[command,args,options]);return terminalChild;}});});
await op('actual-spawn-metadata',async()=>{await scopedEnv({TELEPTY_SESSION_ID:'owned-cli',TELEPTY_SESSION_TOKEN:issued.session_token,TELEPTY_SESSION_NONCE:issued.session_nonce},async()=>{const child=allow.spawnChild();assert.equal(child,terminalChild);await Promise.all(pendingHTTP);const response=httpRecords.at(-1);assert.equal(response.status,200);assert.equal(JSON.parse(response.body).reregistered,true);assert.equal(recordContext.sessions['owned-cli'].ownerPid,process.pid);assert.equal(recordContext.sessions['owned-cli'].backend,'warp');assert.equal(response.request.headers['x-telepty-session-token'],issued.session_token);const e=effects.findLast(x=>x.kind==='spawnPty');assert.deepEqual(e.args.slice(0,2),[spawnTool,['--literal','space arg']]);assert.equal(e.args[2].cwd,fixture);assert.equal(e.args[2].cols,91);assert.equal(e.args[2].rows,33);});});
await op('bridge-factory',async()=>{shared.bridgeMailbox=allow.createBridgeMailbox();});
await op('prompt-registry-negative',async()=>{shared.command='codex';shared.knownAiCli=providers.ready.isKnownAiCli(shared.command);assert.equal(allow.observePromptReady('Resume a previous session'),false);});
await op('prompt-registry-positive',async()=>{shared.outputTail='';assert.equal(allow.observePromptReady('OpenAI Codex (v1)\ngpt-5.5 high fast'),true);assert.equal(shared.readyQualification.cli_key,'codex');shared.promptReady=true;});
await op('interaction-writer-factory',async()=>{writer=providers.interaction.createInteractionWriter({observe:()=>providers.ready.observeInteraction(recordContext.sessions['owned-cli']),binding:()=>shared.interactionBinding,encode:providers.ready.encodeInteraction,write:data=>terminalChild.write(data),now:()=>syntheticNow});});
await op('interaction-invalid-frame',async()=>{const n=effects.length;const r=writer({});assert.equal(effects.length,n);assert.ok(r.reason);return r;});
await op('enqueue-positive',async()=>{allow.enqueueBridgeMessage('한글\r\n');assert.equal(shared.bridgeMsgSeq,1);assert.equal(shared.bridgePendingCount,1);});
await op('recover-positive',async()=>{shared.bridgePendingCount=0;allow.recoverBridgeMailbox();assert.equal(shared.bridgePendingCount,1);});
await op('flush-positive',async()=>{allow.flushBridgeMailbox();assert.equal(shared.bridgePendingCount,0);assert.equal(timeouts.size,1);assert.equal(journal('positive').at(-1).state,'in_flight');});
await op('callback-positive',async()=>{const gen=shared.interactionBinding.input_generation;advanceOne();assert.equal(shared.interactionBinding.input_generation,gen+1);assert.equal(effects.findLast(x=>x.kind==='pty-write').data,'한글\r\n');assert.equal(journal('positive').at(-1).state,'acked');});
await op('invalid-target-input',async()=>{shared.bridgeTarget='../sentinel';shared.bridgePendingCount=7;});
await op('recover-invalid',async()=>{allow.recoverBridgeMailbox();assert.equal(shared.bridgePendingCount,7);});
await op('enqueue-fallback',async()=>{const seq=shared.bridgeMsgSeq,gen=shared.interactionBinding.input_generation;allow.enqueueBridgeMessage('fallback\r');assert.equal(shared.bridgeMsgSeq,seq+1);assert.equal(shared.bridgePendingCount,7);assert.equal(shared.interactionBinding.input_generation,gen+1);assert.equal(effects.findLast(x=>x.kind==='pty-write').data,'fallback\r');});
await op('empty-flush-invalid',async()=>{shared.bridgePendingCount=0;allow.flushBridgeMailbox();assert.equal(shared.bridgePendingCount,0);});
await op('dequeue-target-input',async()=>{shared.bridgeTarget='dequeue';shared.bridgePendingCount=0;});
await op('enqueue-dequeue',async()=>{allow.enqueueBridgeMessage('dequeue-refusal');});
await op('corrupt-dequeue-leaf',async()=>{corrupt('dequeue','inbox.jsonl');});
await op('recover-unsafe',async()=>{const n=shared.bridgePendingCount;allow.recoverBridgeMailbox();assert.equal(shared.bridgePendingCount,n);});
await op('flush-dequeue-refusal',async()=>{const gen=shared.interactionBinding.input_generation,n=effects.length;assert.throws(()=>allow.flushBridgeMailbox(),e=>e.code==='MAILBOX_UNSAFE_PATH');assert.equal(shared.bridgePendingCount,1);assert.equal(effects.length,n);assert.equal(shared.interactionBinding.input_generation,gen);});
await op('filter-target-input',async()=>{shared.bridgeTarget='filter';shared.bridgePendingCount=0;});
// #136 F4: records of a PREVIOUS bridge are quarantined, never replayed (bridge-recovery-quarantine-136), so
// the filter group seeds through THIS context; recovery keeps its own records queued. Dropped records are
// dead-lettered with their payload, never relabelled acked.
const filterIds=()=>{const rows=journal('filter','inbox.jsonl');return {old:rows.find(x=>x.payload==='expired').msg_id,sameB:rows.filter(x=>x.payload==='same')[1].msg_id};};
await op('seed-old',async()=>{syntheticNow=Date.now()-601000;allow.enqueueBridgeMessage('expired');});
await op('seed-same-a',async()=>{syntheticNow=Date.now();allow.enqueueBridgeMessage('same');});
await op('seed-same-b',async()=>{allow.enqueueBridgeMessage('same');});
await op('recover-filter',async()=>{allow.recoverBridgeMailbox();assert.equal(shared.bridgePendingCount,3);});
await op('flush-filter',async()=>{syntheticNow=Date.now();allow.flushBridgeMailbox();assert.equal(timeouts.size,1);const rows=journal('filter'),ids=filterIds();for(const id of [ids.old,ids.sameB]){assert.ok(rows.some(x=>x.msg_id===id&&x.state==='dead_letter'));assert.ok(!rows.some(x=>x.msg_id===id&&x.state==='acked'));}assert.deepEqual(journal('filter','dead-letter.jsonl').map(x=>[x.payload,x.reason]),[['expired','expired_unwritten'],['same','bridge_duplicate']]);});
await op('callback-filter',async()=>{advanceOne();assert.equal(effects.findLast(x=>x.kind==='pty-write').data,'same');assert.equal(journal('filter').at(-1).state,'acked');});
await op('ack-target-input',async()=>{shared.bridgeTarget='ack';shared.bridgePendingCount=0;});
await op('enqueue-ack',async()=>{allow.enqueueBridgeMessage('ack\r\n');});
await op('flush-ack',async()=>{allow.flushBridgeMailbox();assert.equal(timeouts.size,1);});
await op('corrupt-ack-leaf',async()=>{corrupt('ack','state.jsonl');});
await op('callback-ack-refusal',async()=>{const gen=shared.interactionBinding.input_generation;advanceOne();assert.equal(shared.interactionBinding.input_generation,gen+1);assert.equal(effects.findLast(x=>x.kind==='pty-write').data,'ack\r\n');assert.equal(journal('ack','state.jsonl.retained').at(-1).state,'in_flight');assert.equal(fs.readFileSync(path.join(fixture,'sentinel'),'utf8'),'private sentinel');});
await op('throw-target-input',async()=>{shared.bridgeTarget='throw';shared.bridgePendingCount=0;});
await op('enqueue-throw',async()=>{allow.enqueueBridgeMessage('throw\r');});
await op('flush-throw',async()=>{allow.flushBridgeMailbox();});
await op('callback-throw',async()=>{const gen=shared.interactionBinding.input_generation;throwWrite=true;try{assert.throws(()=>advanceOne(),/captured terminal throw/);}finally{throwWrite=false;}assert.equal(shared.interactionBinding.input_generation,gen+1);assert.equal(journal('throw').at(-1).state,'in_flight');});
await op('close-target-input',async()=>{shared.bridgeTarget='close';shared.bridgePendingCount=0;});
await op('enqueue-close',async()=>{allow.enqueueBridgeMessage('after-close');});
await op('flush-close',async()=>{allow.flushBridgeMailbox();assert.equal(timeouts.size,1);staleCloseTimer=timeouts.keys().next().value;});
await op('schedule-idle',async()=>{allow.scheduleIdleFlush();assert.ok(shared.idleCheckTimer);});
await op('cleanup-timer-inputs',async()=>{shared.reconnectTimer=scheduler.setTimeout(()=>{throw Error('reconnect callback outside selection');},5000);shared.heartbeatTimer=scheduler.setInterval(()=>{throw Error('heartbeat callback outside selection');},1000);});
await op('close-preserve',async()=>{const beforeFiles=inventory(),beforeHTTP=httpRecords.length,n=effects.length;assert.equal(allow.closeAllowSession({destroySession:false}),true);assert.equal(shared.allowSessionClosed,true);assert.equal(httpRecords.length,beforeHTTP);assert.equal(streams.input.listenerCount('data'),0);assert.equal(streams.output.listenerCount('resize'),0);assert.ok(effects.slice(n).some(x=>x.kind==='stdout'&&x.data===providers.terminal.TERMINAL_CLEANUP_SEQUENCE));assert.equal(timeouts.size,0);assert.equal(intervals.size,0);assert.deepEqual(inventory(),beforeFiles);for(const k of ['queueFlushTimer','idleCheckTimer','reconnectTimer','heartbeatTimer'])assert.equal(shared[k],null);assert.equal(journal('close').at(-1).state,'in_flight');assert.ok(!timeouts.has(shared.reconnectTimer));assert.ok(!intervals.has(shared.heartbeatTimer));assert.ok(effects.slice(n).some(x=>x.kind==='signal-off'&&x.signal==='SIGINT'));assert.ok(effects.slice(n).some(x=>x.kind==='ws-close'));});
await op('close-idempotent',async()=>{const n=effects.length;assert.equal(allow.closeAllowSession({destroySession:false}),false);assert.equal(effects.length,n);});
await op('callback-after-close',async()=>{const before=inventory(),gen=shared.interactionBinding.input_generation,n=effects.length;advanceArchived(staleCloseTimer);assert.equal(effects.length,n+1);assert.equal(shared.interactionBinding.input_generation,gen);assert.deepEqual(inventory(),before);assert.equal(journal('close').at(-1).state,'in_flight');return {safety:'cancelled genuine callback guarded; no write or ACK'};});
await op('harness-timer-cleanup',async()=>{const retained={timeouts:[...timeouts.keys()],intervals:[...intervals.keys()]};assert.deepEqual(retained,{timeouts:[],intervals:[]});timeouts.clear();intervals.clear();shared.queueFlushTimer=null;shared.idleCheckTimer=null;return {harnessOnly:retained};});
await op('second-terminal-attach',async()=>{streams=terminalStreams();shared.cleanupTerminal=providers.terminal.attachInteractiveTerminal(streams.input,streams.output,{onData:data=>effects.push({kind:'input',data}),onResize:()=>{}});shared.allowSessionClosed=false;shared.bridgeTarget='destroy';shared.bridgePendingCount=0;});
await op('second-allow-factory',async()=>{allow=providers.security.createAllowSecurityContext(shared,{...scheduler,now:()=>syntheticNow,getStdout:()=>streams.output,bridgeRoot:path.join(fixture,'bridge'),removeSignalHandler(signal){effects.push({kind:'signal-off',signal});},spawnPty(){throw Error('no second spawn');}});});
await op('enqueue-destroy',async()=>{allow.enqueueBridgeMessage('purge-selected');});
await op('close-destroy',async()=>{await scopedEnv({TELEPTY_SESSION_TOKEN:issued.session_token},async()=>{assert.equal(allow.closeAllowSession({destroySession:true}),true);await Promise.resolve();const req=effects.findLast(x=>x.kind==='delete-request');assert.match(req.url,/owner_token=private-owner-token$/);assert.equal(req.options.headers['x-telepty-token'],top.cachedAuthToken);assert.equal(req.options.headers['x-telepty-session-token'],issued.session_token);assert.deepEqual(journal('destroy'),[]);assert.deepEqual(journal('destroy','inbox.jsonl'),[]);});});

// Additional finite inputs/calls, after all 82 original groups in original order.
function frozenState(){return {files:inventory(),sequence:shared.bridgeMsgSeq,pending:shared.bridgePendingCount,generation:{...shared.interactionBinding},timeouts:[...timeouts.keys()],intervals:[...intervals.keys()],effects:effects.length};}
function assertNoEffects(before){assert.deepEqual(frozenState(),before);}
await op('closed-enqueue',()=>{const b=frozenState();allow.enqueueBridgeMessage('closed-input');assertNoEffects(b);});
await op('closed-flush',()=>{const b=frozenState();allow.flushBridgeMailbox();assertNoEffects(b);});
await op('closed-schedule',()=>{const b=frozenState();allow.scheduleIdleFlush();assertNoEffects(b);});
await op('closed-recover',()=>{const b=frozenState();allow.recoverBridgeMailbox();assertNoEffects(b);});
await op('shared-flag-reset-input',()=>{shared.allowSessionClosed=false;});
await op('old-context-after-reset',()=>{const b=frozenState();allow.enqueueBridgeMessage('reset-input');allow.flushBridgeMailbox();allow.scheduleIdleFlush();allow.recoverBridgeMailbox();assert.equal(allow.closeAllowSession({destroySession:false}),false);assertNoEffects(b);});
let retainedQueue,retainedIdle,scenarioTimer;
function newContext(target){
 streams=terminalStreams();
 shared.cleanupTerminal=providers.terminal.attachInteractiveTerminal(streams.input,streams.output,{onData:data=>effects.push({kind:'input',data}),onResize:()=>{}});
 shared.allowSessionClosed=false;shared.bridgeTarget=target;shared.bridgePendingCount=0;shared.child=terminalChild;
 shared.knownAiCli=false;shared.queueFlushTimer=null;shared.idleCheckTimer=null;shared.reconnectTimer=null;shared.heartbeatTimer=null;
 onCapturedWrite=null;onCapturedSend=null;
 allow=providers.security.createAllowSecurityContext(shared,{...scheduler,now:()=>syntheticNow,getStdout:()=>streams.output,bridgeRoot:path.join(fixture,'bridge'),removeSignalHandler(signal){effects.push({kind:'signal-off',signal});},spawnPty(){throw Error('additional native spawn unselected');}});
}
await op('queue-context-setup',()=>newContext('queue-close'));
await op('queue-enqueue',()=>allow.enqueueBridgeMessage('pending-at-close'));
await op('queue-schedule',()=>{allow.scheduleIdleFlush();retainedQueue=shared.queueFlushTimer;retainedIdle=shared.idleCheckTimer;assert.ok(timeouts.has(retainedQueue)&&intervals.has(retainedIdle));});
await op('queue-close',()=>{const files=inventory();assert.equal(allow.closeAllowSession({destroySession:false}),true);assert.equal(timeouts.size,0);assert.equal(intervals.size,0);for(const k of ['queueFlushTimer','idleCheckTimer','reconnectTimer','heartbeatTimer'])assert.equal(shared[k],null);assert.deepEqual(inventory(),files);assert.equal(journal('queue-close').at(-1).state,'pending');});
await op('queue-stale-callback',()=>{const b=frozenState();advanceArchived(retainedQueue);const a=frozenState();assert.equal(a.effects,b.effects+1);a.effects=b.effects;assert.deepEqual(a,b);});
await op('idle-stale-callback',()=>{const b=frozenState();advanceArchived(retainedIdle);const a=frozenState();assert.equal(a.effects,b.effects+1);a.effects=b.effects;assert.deepEqual(a,b);});
await op('queue-repeated-close',()=>{const b=frozenState();assert.equal(allow.closeAllowSession({destroySession:true}),false);assertNoEffects(b);});
const replacementChild={pid:null,write(data){effects.push({kind:'replacement-write',data});},resize(){},kill(){throw Error('native kill unselected');}};
const scenarios=['replace-before','close-on-send','close-on-write','replace-on-send','replace-on-write'];
for(const scenario of scenarios){
 await op(scenario+'-setup',()=>newContext(scenario));
 await op(scenario+'-enqueue',()=>allow.enqueueBridgeMessage('guard-'+scenario));
 await op(scenario+'-flush',()=>{allow.flushBridgeMailbox();assert.equal(timeouts.size,1);scenarioTimer=timeouts.keys().next().value;assert.equal(journal(scenario).at(-1).state,'in_flight');});
 await op(scenario+'-input',()=>{
  if(scenario==='replace-before')shared.child=replacementChild;
  if(scenario==='close-on-send')onCapturedSend=()=>{onCapturedSend=null;assert.equal(allow.closeAllowSession({destroySession:false}),true);};
  if(scenario==='close-on-write')onCapturedWrite=()=>{onCapturedWrite=null;assert.equal(allow.closeAllowSession({destroySession:false}),true);};
  if(scenario==='replace-on-send')onCapturedSend=()=>{onCapturedSend=null;shared.child=replacementChild;};
  if(scenario==='replace-on-write')onCapturedWrite=()=>{onCapturedWrite=null;shared.child=replacementChild;};
 });
 await op(scenario+'-callback',()=>{
  const before=inventory(),gen=shared.interactionBinding.input_generation,n=effects.length;
  advanceOne();
  const effectsAfter=effects.slice(n),writes=effectsAfter.filter(e=>e.kind==='pty-write');
  assert.equal(effectsAfter.filter(e=>e.kind==='replacement-write').length,0);
  assert.equal(writes.length,scenario.endsWith('on-write')?1:0);
  assert.equal(shared.interactionBinding.input_generation,gen+(scenario==='replace-before'?0:1));
  assert.deepEqual(inventory(),before);
  assert.equal(journal(scenario).at(-1).state,'in_flight');
  assert.equal(timeouts.size,0);
 });
 await op(scenario+'-close',()=>{const files=inventory();const already=scenario.startsWith('close-');assert.equal(allow.closeAllowSession({destroySession:false}),!already);assert.deepEqual(inventory(),files);assert.equal(timeouts.size,0);assert.equal(intervals.size,0);});
 await op(scenario+'-stale',()=>{const b=frozenState();advanceArchived(scenarioTimer);const a=frozenState();assert.equal(a.effects,b.effects+1);a.effects=b.effects;assert.deepEqual(a,b);assert.equal(journal(scenario).at(-1).state,'in_flight');});
}


 assert.equal(operations,130);
 assert.equal(httpCalls,2);assert.equal(callbackAdvances,17);assert.equal(processCaptures,4);
 assert.deepEqual(httpRecords.map(r=>r.status),[201,200]);
 assert.ok(httpRecords.every(r=>r.disposed&&r.listeners===0&&!r.error));
 assert.equal(timeouts.size,0);assert.equal(intervals.size,0); // Before harness cleanup.
 }finally{
  // Each independent cleanup is attempted even if a preceding cleanup fails.
  const cleanupErrors=[];
  const clean=async fn=>{try{await fn();}catch{cleanupErrors.push('cleanup failed');}};
  await clean(()=>Promise.allSettled(pendingHTTP));
  await clean(()=>{if(shared&&shared.cleanupTerminal)shared.cleanupTerminal();});
  await clean(()=>{if(cleanupTerminal)cleanupTerminal();});
  timeouts.clear();intervals.clear();callbackArchive.clear();
  await clean(()=>{if(state){countedOperations++;state.destroyAll();}});
  await clean(()=>assert.equal(stateHandles.size,0));
  if(cleanupErrors.length)throw new Error('Private resource cleanup failed');
 }
 assert.equal(countedOperations,191);
}

  await main();
 }finally{
  try{for(const [k,v] of saved){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
  finally{fs.rmSync(root,{recursive:true,force:true});}
 }
});
