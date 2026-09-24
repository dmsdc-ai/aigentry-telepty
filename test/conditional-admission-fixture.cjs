'use strict';
// Platform-only isolation. Admission, credentials, routing and queues are production code.
//
// it1170x adaptation over the frozen tr1170u2 fixture. EXACTLY three changes to pre-existing
// behaviour, all in fresh-fixture SETUP, none in any assertion:
//   (1) AIGENTRY_ORCHESTRATOR_SIDS is set to the fixture controller SID so the existing test
//       controller policy admits it. This is the existing env seam; production policy is untouched.
//   (2) setup() now calls the REAL authenticated POST /api/conditional-store/initialize with the
//       controller's verified bearer + host credential before any binding. Nothing is mocked: the
//       production route, principal check, canonical-intent check and persistence all run.
//   (3) both-missing-seed removes BOTH durable artifacts (ledger AND the independent
//       `<ledger>.initialized` marker), because the candidate no longer embeds the marker.
// Everything below that line is new `init-*`/`cli-init*` scenarios added alongside, not edits.
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { ServerResponse } = require('node:http');
const assert = require('node:assert/strict');
// tt1170aa PORTABILITY-4 (path resolution only; every scenario and assertion below unchanged):
// the production modules this fixture drives live at the REPOSITORY ROOT on the release branch,
// one level above `test/`. The former `../source` target belongs to the old nested staging layout
// and does not exist here, so the fixture would have loaded nothing.
const runtime = path.resolve(__dirname, '..');
const scenario = process.argv[2];
const home = process.env.FIXTURE_HOME || fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'conditional-home-'));
process.env.HOME = home;
process.env.TELEPTY_AUTH_TOKEN = 'isolated-test-host';
process.env.AIGENTRY_MAILBOX_DIR = path.join(home, 'mailbox');
// (1) existing test controller SID policy, set to the fixture's controller SID only.
process.env.AIGENTRY_ORCHESTRATOR_SIDS = 'controller';
// `init-denied` needs an unwritable store directory, so its ledger lives one level down.
const storeDir = scenario === 'init-denied' ? path.join(home, 'locked') : home;
process.env.TELEPTY_CONDITIONAL_ADMISSIONS_PATH = path.join(storeDir, 'conditional.json');
delete process.env.TELEPTY_DAEMON_PROCESS;
delete process.env.AIGENTRY_TELEPTY_DAEMON_MAIN;
const os = require('node:os');
os.homedir = () => home;
os.networkInterfaces = () => ({});
os.hostname = () => 'fixture';
const violations = [];
const blocked = name => () => { violations.push(name); throw new Error('FORBIDDEN_PLATFORM: ' + name); };
for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) require('node:child_process')[name] = blocked(name);
require('node:net').Socket.prototype.connect = blocked('socket.connect');
require('node:net').Server.prototype.listen = blocked('server.listen');
require('node:tls').connect = blocked('tls.connect');
require('node:dgram').createSocket = blocked('dgram');
global.fetch = blocked('fetch');
process.kill = blocked('process.kill');
const timers = [];
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
global.setTimeout = (fn, ms, ...args) => { const t = {fn: () => fn(...args), ms, unref() {}, ref() {}}; timers.push(t); return t; };
global.clearTimeout = t => { if(t) t.cancelled = true; };
global.setInterval = () => ({unref() {}});
global.clearInterval = () => {};
const wsServers = [];
class FakeServer extends EventEmitter { constructor() { super(); wsServers.push(this); } }
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(name, parent, main) {
  if(name === 'node-pty') return {spawn: blocked('pty.spawn')};
  if(name === 'ws') { const real = originalLoad.apply(this, arguments); return {...real, WebSocketServer: FakeServer}; }
  return originalLoad.apply(this, arguments);
};
const d = require(path.join(runtime, 'daemon.js'));
const persistence = require(path.join(runtime, 'src/session-store/persistence.js'));
const writes = [];
let pendingUds;

// --- durable-artifact observation helpers (read-only) -----------------------
const markerPath = () => persistence.conditionalInitializationPath(d.conditionalStore.path);
function artifacts() {
  let temps = [];
  try { temps = fs.readdirSync(path.dirname(d.conditionalStore.path)).filter(n => n.startsWith('.conditional-admissions.')); } catch {}
  return {
    ledger: fs.existsSync(d.conditionalStore.path),
    marker: fs.existsSync(markerPath()),
    temps,
    available: d.conditionalStore.available(),
  };
}
function markerId() {
  try { return JSON.parse(fs.readFileSync(markerPath(), 'utf8')).marker_id; } catch { return null; }
}

function owner(sid, token, viewer = false) {
  const socket = new EventEmitter(); socket.readyState = 1;
  socket.send = raw => { const frame = JSON.parse(raw); if(frame.type === 'inject') writes.push({sid, data: frame.data}); };
  socket.close = () => { socket.readyState = 3; };
  socket.ping = () => {}; socket.terminate = socket.close;
  wsServers[0].emit('connection', socket, {url: '/api/sessions/'+sid+(viewer?'':'?owner=1'), headers:{host:'fixture','x-telepty-session-token':token}, socket:{remoteAddress:'127.0.0.1'}});
  return socket;
}
function request(method, url, body, token, host = true, raw) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? '' : (raw || JSON.stringify(body));
    const req = Readable.from(bytes ? [Buffer.from(bytes)] : []);
    req.method = method; req.url = url;
    req.headers = {host:'fixture', ...(host?{'x-telepty-token':process.env.TELEPTY_AUTH_TOKEN}:{}), ...(token?{'x-telepty-session-token':token}:{}), ...(bytes?{'content-type':'application/json','content-length':Buffer.byteLength(bytes)}:{})};
    req.socket = {remoteAddress:'127.0.0.1'};
    const res = new ServerResponse(req);
    res.end = chunk => { try { resolve({status:res.statusCode, body:chunk?JSON.parse(String(chunk)):null}); } catch(e) { reject(e); } return res; };
    d.app.handle(req, res, err => reject(err || new Error('unhandled '+url)));
  });
}
// (2) the real authenticated first-initialization call. No mocked success anywhere.
function initializeStore(token, options = {}) {
  const {host = true, body, raw} = options;
  return request('POST','/api/conditional-store/initialize',
    body === undefined ? {version:1,intent:'new-store'} : body, token, host, raw);
}
async function register(sid) {
  const r = await request('POST','/api/sessions/register',{session_id:sid,command:'fixture-shell',backend:'fixture',provenance_capable:!(sid==='worker' && scenario==='mutation-provenance_capable')});
  assert.equal(r.status,201,JSON.stringify(r));
  owner(sid,r.body.session_token);
  return r.body.session_token;
}
async function cr() { for(const t of timers.splice(0)) if(!t.cancelled && t.ms===500) await t.fn(); }
async function setup() {
  const token = await register('controller');
  // (2) explicit authenticated first initialization, before any binding exists.
  const initialization = await initializeStore(token);
  assert.equal(initialization.status,201,JSON.stringify(initialization));
  assert.equal(initialization.body.initialization,'created',JSON.stringify(initialization));
  const targetToken = await register('worker');
  const target = await request('GET','/api/sessions/worker/conditional-target',undefined,token);
  assert.equal(target.status,200,JSON.stringify(target));
  const bindingRequest = {version:1,target:target.body.target,task:'task1170',attempt:require('node:crypto').randomUUID(),manifest_sha256:'a'.repeat(64),expires_at:Date.now()+60000};
  if (scenario === 'delayed-unbound-cr') {
    const unbound = await request('POST','/api/sessions/worker/inject',{prompt:'before binding'},token);
    assert.equal(unbound.status,200,JSON.stringify(unbound));
    assert.ok(writes.length > 0);
    writes.length = 0;
  }
  if(scenario === 'delayed-unbound-uds') {
    d.sessions.worker.type='aterm';
    d.sessions.worker.delivery={transport:'unix_socket',address:'/synthetic-no-socket'};
    const net=require('node:net');
    net.connect=(address,callback)=>{
      assert.equal(address,'/synthetic-no-socket');
      const socket=new EventEmitter();
      socket.end=data=>writes.push({sid:'worker',data});
      socket.destroy=()=>{};
      pendingUds={callback,socket};
      return socket;
    };
    d.mailbox.enqueue({msg_id:'pending-unbound',from:'controller',to:'worker',payload:'pending',created_at:Math.floor(Date.now()/1000),attempt:0});
    const tick=d.mailboxDelivery.tick();
    assert.ok(pendingUds,'UDS adapter must have parked at connect');
    pendingUds.tick=tick;
    d.sessions.worker.type='wrapped';
  }
  const binding = await request('POST','/api/sessions/worker/conditional-binding',bindingRequest,token);
  assert.equal(binding.status,201,JSON.stringify(binding));
  const envelope = {version:1,binding_id:binding.body.binding.binding_id,key:{task:'task1170',sid:'worker',attempt:bindingRequest.attempt,operation_id:'operation',revision:1},msg_id:require('node:crypto').randomUUID(),payload_sha256:d.conditionalAdmission.sha256Hex(Buffer.from('fixture payload')),prompt:'fixture payload'};
  return {token,targetToken,binding,bindingRequest,envelope,initialization};
}

// --- new: raw canonical-intent mutations ------------------------------------
function initRawBytes(variant) {
  const value = {version:1,intent:'new-store'};
  let raw = JSON.stringify(value);
  if(variant === 'duplicate') raw = raw.replace('"version":1','"version":1,"version":1');
  if(variant === 'escaped') raw = raw.replace('"version":1','"version":1,"\\u0076ersion":1');
  if(variant === 'order') raw = JSON.stringify({intent:'new-store',version:1});
  if(variant === 'unknown') raw = JSON.stringify({...value,unknown:true});
  if(variant === 'schema') raw = JSON.stringify({...value,version:'1'});
  if(variant === 'partial') raw = '{"version":1}';
  if(variant === 'intent') raw = JSON.stringify({version:1,intent:'reset'});
  if(variant === 'force') raw = JSON.stringify({version:1,intent:'new-store',force:true});
  if(variant === 'pretty') raw = JSON.stringify(value,null,2);
  if(variant === 'utf8') {
    // An invalid raw byte inside a valid JSON string is not canonical UTF-8.
    const canonical = Buffer.from(JSON.stringify({version:1,intent:'�'}));
    const at = canonical.indexOf(Buffer.from('�'));
    raw = Buffer.concat([canonical.subarray(0,at),Buffer.from([0xff]),canonical.subarray(at+3)]);
  }
  return raw;
}

// --- new: in-process CLI driver ---------------------------------------------
async function runCli(argv, fetchImpl) {
  process.env.TELEPTY_SESSION_TOKEN = process.env.TELEPTY_SESSION_TOKEN || '';
  process.argv = [process.execPath, path.join(runtime,'cli.js'), ...argv];
  const out = []; const err = [];
  const realLog = console.log; const realError = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  let requests = 0;
  global.fetch = async (...args) => { requests++; return fetchImpl(...args); };
  try {
    const mod = new Module(process.argv[1],null);
    mod.filename = process.argv[1];
    mod.paths = Module._nodeModulePaths(runtime);
    process.mainModule = mod;
    mod._compile(fs.readFileSync(mod.filename,'utf8'), mod.filename);
    await new Promise(resolve => realSetTimeout(resolve, 50));
  } finally { console.log = realLog; console.error = realError; }
  const cliExit = process.exitCode || 0; process.exitCode = 0;
  // The daemon runs IN-PROCESS here and shares this console; its own `[TAG] ...` lines are not
  // CLI output and would never appear on a real CLI process's stdout. Separate, never discard.
  const daemonLog = l => /^\[[A-Z][A-Z-]*\]/.test(l);
  return {cliExit, requests, stdout: out.filter(l => !daemonLog(l)), daemonStdout: out.filter(daemonLog),
    stderr: err.filter(l => !daemonLog(l)), daemonStderr: err.filter(daemonLog)};
}
// Routes a CLI fetch into the production app handlers (no socket, no listen).
async function cliFetchToApp(url, options) {
  const r = await request(options.method, new URL(url).pathname,
    options.body === undefined ? undefined : JSON.parse(options.body),
    options.headers['X-Telepty-Session-Token'] || options.headers['x-telepty-session-token'],
    Boolean(options.headers['X-Telepty-Token'] || options.headers['x-telepty-token']),
    options.body);
  return {ok: r.status < 300, status: r.status, json: async () => r.body};
}

// --- new: deterministic fsync fault injection -------------------------------
// Fails the Nth fsyncSync call (1 = marker file, 2 = marker directory,
// 3 = ledger temp file — i.e. after the ledger reservation already exists).
function failFsyncAt(index) {
  const original = fs.fsyncSync;
  let seen = 0;
  fs.fsyncSync = fd => {
    seen += 1;
    if (seen === index) { const e = new Error('fixture EIO'); e.code = 'EIO'; throw e; }
    return original(fd);
  };
  return () => { fs.fsyncSync = original; return seen; };
}

async function main() {
  if(scenario==='legacy') {
    global.setTimeout=realSetTimeout;global.clearTimeout=realClearTimeout;
    for(const file of ['http-auth','provenance','peer-inject-validator','inject-redeliver','inject-consumption-evidence','session-credentials']) require(path.join(runtime,'test',file+'.test.js'));
    return {legacyLoaded:true};
  }
  if(scenario==='restart-read') {
    const saved=JSON.parse(fs.readFileSync(path.join(home,'restart.json'),'utf8'));
    owner('worker',saved.targetToken);
    const response=await request('POST','/api/sessions/worker/inject',saved.corrupt?{prompt:'UNBOUND',no_enter:true}:saved.envelope,saved.token);
    await d.mailboxDelivery.tick(); await cr();
    return {response,writes,fenced:d.isConditionallyFenced('worker'),original:saved.original};
  }
  if(scenario === 'both-missing-read') {
    const saved=JSON.parse(fs.readFileSync(path.join(home,'restart.json'),'utf8'));
    owner('worker',saved.targetToken);
    const response=await request('POST','/api/sessions/worker/inject',{prompt:'UNBOUND',no_enter:true},saved.token);
    await d.mailboxDelivery.tick(); await cr();
    return {response,writes,fenced:d.isConditionallyFenced('worker'),available:d.conditionalStore.available()};
  }

  // ---------------------------------------------------------------------
  // New explicit-first-initialization scenarios.
  // ---------------------------------------------------------------------
  if(scenario === 'init-fresh-startup') {
    // A fresh daemon process must mint no authority and create no files at all.
    const before = artifacts();
    const token = await register('controller');
    const targetToken = await register('worker');
    const response = await request('POST','/api/sessions/worker/inject',{prompt:'UNBOUND',no_enter:true},token);
    await d.mailboxDelivery.tick(); await cr();
    // ¶16 E is an identity, not a secret, so the snapshot itself is not authority. The authority
    // is the binding — that is what must be refused while no store has been initialized.
    const target = await request('GET','/api/sessions/worker/conditional-target',undefined,token);
    const bindingRequest = {version:1,
      target: target.status===200 ? target.body.target
        : {sid:'worker',session_epoch:'synthetic',credential_generation:1,delivery_generation:require('node:crypto').randomUUID()},
      task:'task1170',attempt:require('node:crypto').randomUUID(),
      manifest_sha256:'a'.repeat(64),expires_at:Date.now()+60000};
    const binding = await request('POST','/api/sessions/worker/conditional-binding',bindingRequest,token);
    return {before,after:artifacts(),response,target,binding,writes,
      fenced:d.isConditionallyFenced('worker'),targetRegistered:Boolean(targetToken)};
  }
  if(scenario === 'init-restart-read') {
    const saved=JSON.parse(fs.readFileSync(path.join(home,'restart.json'),'utf8'));
    owner('worker',saved.targetToken);
    const state = artifacts();
    const duplicate = await request('POST','/api/sessions/worker/inject',saved.envelope,saved.token);
    await d.mailboxDelivery.tick(); await cr();
    // A store that is already initialized must refuse a second explicit initialization.
    const reinit = await initializeStore(saved.token);
    return {state,duplicate,reinit,writes,original:saved.original,
      markerId:markerId(),savedMarkerId:saved.markerId,after:artifacts()};
  }
  if(scenario && (scenario.startsWith('init-') || scenario.startsWith('cli-init'))) {
    const token = await register('controller');

    if(scenario === 'init-unauthenticated') {
      const response = await initializeStore(undefined,{host:false});
      return {response,artifacts:artifacts(),writes};
    }
    if(scenario === 'init-host-only') {
      const response = await initializeStore(undefined,{host:true});
      return {response,artifacts:artifacts(),writes};
    }
    if(scenario === 'init-worker-bearer' || scenario === 'init-spoofed-principal') {
      const workerToken = await register('worker');
      const response = await initializeStore(workerToken, scenario === 'init-spoofed-principal'
        ? {body:{version:1,intent:'new-store',from:'controller'}} : {});
      return {response,artifacts:artifacts(),writes};
    }
    if(scenario === 'init-revoked-principal') {
      const deleted = await request('DELETE','/api/sessions/controller',undefined,token);
      assert.equal(deleted.status,200,JSON.stringify(deleted));
      const response = await initializeStore(token);
      return {response,artifacts:artifacts(),writes};
    }
    if(scenario.startsWith('init-raw-')) {
      const raw = initRawBytes(scenario.slice(9));
      const response = await initializeStore(token,{body:{version:1,intent:'new-store'},raw});
      return {response,artifacts:artifacts(),writes};
    }
    if(scenario === 'init-existing' || scenario === 'init-repeat') {
      const first = await initializeStore(token);
      assert.equal(first.status,201,JSON.stringify(first));
      const afterFirst = artifacts();
      const id = markerId();
      const second = await initializeStore(token);
      const third = await initializeStore(token);
      return {first,second,third,afterFirst,markerId:id,markerAfter:markerId(),after:artifacts()};
    }
    if(scenario === 'init-concurrent') {
      const responses = await Promise.all([initializeStore(token),initializeStore(token)]);
      return {responses,after:artifacts(),markerId:markerId()};
    }
    if(scenario === 'init-partial-marker' || scenario === 'init-partial-ledger'
      || scenario === 'init-corrupt' || scenario === 'init-unsupported'
      || scenario === 'init-orphan-temp') {
      const marker = {marker_id:require('node:crypto').randomUUID(),initialized_at:new Date().toISOString()};
      if(scenario === 'init-partial-marker') fs.writeFileSync(markerPath(),JSON.stringify(marker));
      if(scenario === 'init-partial-ledger') {
        fs.writeFileSync(d.conditionalStore.path,JSON.stringify({...persistence.emptyConditionalAdmissions(),marker,generation:1,schema_version:persistence.CONDITIONAL_ADMISSIONS_SCHEMA_VERSION}));
      }
      if(scenario === 'init-corrupt') {
        fs.writeFileSync(markerPath(),JSON.stringify(marker));
        fs.writeFileSync(d.conditionalStore.path,'{corrupt');
      }
      if(scenario === 'init-unsupported') {
        fs.writeFileSync(markerPath(),JSON.stringify(marker));
        fs.writeFileSync(d.conditionalStore.path,JSON.stringify({...persistence.emptyConditionalAdmissions(),marker,generation:1,schema_version:999}));
      }
      if(scenario === 'init-orphan-temp') {
        fs.writeFileSync(path.join(path.dirname(d.conditionalStore.path),'.conditional-admissions.1.1.tmp'),'{}');
      }
      const before = artifacts();
      const beforeBytes = before.ledger ? fs.readFileSync(d.conditionalStore.path,'utf8') : null;
      const response = await initializeStore(token);
      const after = artifacts();
      return {before,response,after,
        ledgerUnchanged: beforeBytes === (after.ledger ? fs.readFileSync(d.conditionalStore.path,'utf8') : null)};
    }
    if(scenario === 'init-denied') {
      fs.mkdirSync(storeDir,{recursive:true});
      fs.chmodSync(storeDir,0o500);
      let response;
      try { response = await initializeStore(token); } finally { fs.chmodSync(storeDir,0o700); }
      return {response,after:artifacts()};
    }
    if(scenario.startsWith('init-fault-')) {
      const index = {'marker-fsync':1,'dir-fsync':2,'post-reservation':3}[scenario.slice(11)];
      assert.ok(index,'unknown fault '+scenario);
      const restore = failFsyncAt(index);
      const response = await initializeStore(token);
      const seen = restore();
      const afterFault = artifacts();
      // Uncertain initialization must stay uncertain: no silent retry-to-success.
      const retry = await initializeStore(token);
      return {response,afterFault,retry,after:artifacts(),fsyncCalls:seen};
    }
    if(scenario === 'init-legacy-traffic') {
      const initialization = await initializeStore(token);
      assert.equal(initialization.status,201,JSON.stringify(initialization));
      await register('worker');
      const response = await request('POST','/api/sessions/worker/inject',{prompt:'ordinary legacy'},token);
      await d.mailboxDelivery.tick(); await cr();
      return {initialization,response,writes,fenced:d.isConditionallyFenced('worker'),after:artifacts()};
    }
    if(scenario === 'init-restart-seed') {
      const initialization = await initializeStore(token);
      assert.equal(initialization.status,201,JSON.stringify(initialization));
      const targetToken = await register('worker');
      const target = await request('GET','/api/sessions/worker/conditional-target',undefined,token);
      const bindingRequest = {version:1,target:target.body.target,task:'task1170',attempt:require('node:crypto').randomUUID(),manifest_sha256:'a'.repeat(64),expires_at:Date.now()+60000};
      const binding = await request('POST','/api/sessions/worker/conditional-binding',bindingRequest,token);
      assert.equal(binding.status,201,JSON.stringify(binding));
      const envelope = {version:1,binding_id:binding.body.binding.binding_id,key:{task:'task1170',sid:'worker',attempt:bindingRequest.attempt,operation_id:'operation',revision:1},msg_id:require('node:crypto').randomUUID(),payload_sha256:d.conditionalAdmission.sha256Hex(Buffer.from('fixture payload')),prompt:'fixture payload'};
      const result = await request('POST','/api/sessions/worker/inject',envelope,token);
      assert.equal(result.status,202,JSON.stringify(result));
      await d.mailboxDelivery.tick(); await cr();
      fs.writeFileSync(path.join(home,'restart.json'),JSON.stringify({token,targetToken,envelope,original:result.body.inject_id,markerId:markerId()}));
      return {home,writes,markerId:markerId()};
    }

    // --- real production CLI ------------------------------------------------
    if(scenario === 'cli-init') {
      process.env.TELEPTY_SESSION_TOKEN = token;
      const r = await runCli(['conditional-store-init','--new-store'], cliFetchToApp);
      return {...r,after:artifacts(),markerId:markerId(),writes};
    }
    if(scenario.startsWith('cli-init-args-')) {
      process.env.TELEPTY_SESSION_TOKEN = token;
      const argv = {
        missing: ['conditional-store-init'],
        extra: ['conditional-store-init','--new-store','extra'],
        force: ['conditional-store-init','--force'],
        both: ['conditional-store-init','--new-store','--force'],
        reset: ['conditional-store-init','--reset'],
      }[scenario.slice(14)];
      assert.ok(argv,'unknown cli arg variant '+scenario);
      const r = await runCli(argv, async () => { throw new Error('invalid CLI invocation reached transport'); });
      return {...r,after:artifacts(),writes};
    }
    if(scenario === 'cli-init-unknown') {
      process.env.TELEPTY_SESSION_TOKEN = token;
      // A response the CLI cannot recognise must become a nonzero HOLD, never a success claim.
      const r = await runCli(['conditional-store-init','--new-store'],
        async () => ({ok:true,status:200,json:async()=>({version:1,initialization:'maybe'})}));
      return {...r,after:artifacts(),writes};
    }
    throw new Error('unhandled initialization scenario '+scenario);
  }

  const s = await setup();
  const inject = body => request('POST','/api/sessions/worker/inject',body || s.envelope,s.token);
  let result;
  if(scenario === 'both-missing-seed') {
    fs.writeFileSync(path.join(home,'restart.json'),JSON.stringify(s));
    // (3) the candidate keeps an INDEPENDENT marker beside the ledger; remove both.
    fs.unlinkSync(d.conditionalStore.path);
    fs.unlinkSync(markerPath());
    return {home};
  }
  if(scenario === 'delayed-unbound-cr') { await cr(); return {writes}; }
  if(scenario === 'delayed-unbound-uds') {
    pendingUds.callback(); await pendingUds.tick; return {writes};
  }
  if(scenario.startsWith('reload-')) {
    const section=scenario.slice(7);
    if(section === 'admissions' || section === 'tombstones') { const r=await inject(); assert.equal(r.status,202); }
    const beforeFault=writes.length;
    const ledger=JSON.parse(fs.readFileSync(d.conditionalStore.path,'utf8'));
    if(section === 'marker') ledger.marker=null;
    else if(section === 'missing') fs.unlinkSync(d.conditionalStore.path);
    else ledger[section]={};
    if(section !== 'missing') fs.writeFileSync(d.conditionalStore.path,JSON.stringify(ledger));
    const reloaded=d.conditionalStore.initialize();
    const second=d.conditionalStore.initialize();
    const response=await request('POST','/api/sessions/worker/inject',{prompt:'UNBOUND',no_enter:true},s.token);
    await d.mailboxDelivery.tick(); await cr();
    return {reloaded,second,response,beforeFault,writes:writes.slice(beforeFault),fenced:d.isConditionallyFenced('worker')};
  }
  if(scenario.startsWith('raw-') || scenario.startsWith('cli-raw-')) {
    const [route,variant] = scenario.replace(/^cli-/, '').slice(4).split('-');
    const value = route === 'binding' ? s.bindingRequest : s.envelope;
    let raw = JSON.stringify(value);
    if(variant === 'duplicate') raw = raw.replace('"version":1','"version":1,"version":1');
    if(variant === 'escaped') raw = raw.replace('"version":1','"version":1,"\\u0076ersion":1');
    if(variant === 'order') { const {version,...rest}=value; raw=JSON.stringify({...rest,version}); }
    if(variant === 'nested') {
      const key=route === 'binding'?'target':'key';
      const entries=Object.entries(value[key]).reverse();
      raw=JSON.stringify({...value,[key]:Object.fromEntries(entries)});
    }
    if(variant === 'unknown') raw=JSON.stringify({...value,unknown:true});
    if(variant === 'schema') raw=JSON.stringify({...value,version:'1'});
    if(variant === 'partial') raw='{"version":1}';
    if(variant === 'utf8') {
      // An invalid raw byte inside a valid JSON string is not canonical UTF-8.
      const key=route === 'binding'?'task':'prompt';
      const marker=JSON.stringify(value[key]);
      const offset=raw.indexOf(marker,raw.indexOf('"'+key+'"'))+1;
      raw=Buffer.concat([Buffer.from(raw.slice(0,offset)),Buffer.from([0xff]),Buffer.from(raw.slice(offset))]);
      if(route === 'inject') {
        // Keep the decoded schema AND payload hash valid: only original bytes are invalid.
        const decoded={...value,prompt:'�',payload_sha256:d.conditionalAdmission.sha256Hex(Buffer.from('�'))};
        const canonical=Buffer.from(JSON.stringify(decoded));
        const at=canonical.indexOf(Buffer.from('�'));
        raw=Buffer.concat([canonical.subarray(0,at),Buffer.from([0xff]),canonical.subarray(at+3)]);
        assert.deepEqual(JSON.parse(raw.toString('utf8')),decoded);
      }
    }
    if(scenario.startsWith('cli-')) {
      process.env.TELEPTY_SESSION_TOKEN=s.token;
      const file=path.join(home,'invalid-request.json');fs.writeFileSync(file,raw);
      process.argv=[process.execPath,path.join(runtime,'cli.js'),...(route==='binding'?['target-binding','worker','--request',file]:['inject','worker','--conditional-request',file])];
      let requests=0;
      global.fetch=async()=>{requests++;throw new Error('invalid CLI request reached transport');};
      const mod=new Module(process.argv[1],null);mod.filename=process.argv[1];mod.paths=Module._nodeModulePaths(runtime);process.mainModule=mod;mod._compile(fs.readFileSync(mod.filename,'utf8'),mod.filename);
      await new Promise(resolve=>realSetTimeout(resolve,25));
      const cliExit=process.exitCode || 0;process.exitCode=0;
      return {cliExit,requests,writes};
    }
    const response=await request('POST','/api/sessions/worker/'+(route==='binding'?'conditional-binding':'inject'),value,s.token,true,raw);
    await d.mailboxDelivery.tick(); await cr();
    return {response,writes};
  }
  if(scenario.startsWith('mutation-')) {
    const key=scenario.slice(9);
    const values={provenance_capable:true,command:'new-command',cwd:'/synthetic',backend:'new-backend',cmux_workspace_id:'w2',cmux_surface_id:'s2',term_program:'new-term',term:'xterm',owner_pid:999999,pty_pid:999998,delivery_type:'aterm',delivery_endpoint:'synthetic',delivery:{transport:'unix_socket',address:'/synthetic'}};
    const before=d.sessions.worker.deliveryGeneration;
    const changed=await request('POST','/api/sessions/register',{session_id:'worker',[key]:values[key]},s.targetToken);
    const after=d.sessions.worker.deliveryGeneration;
    return {changed,before,after,response:await inject(),writes};
  }
  if(scenario === 'rename') {
    const before=d.sessions.worker.deliveryGeneration;
    const renamed=await request('PATCH','/api/sessions/worker',{new_id:'renamed'},s.targetToken);
    return {renamed,before,after:d.sessions.renamed.deliveryGeneration,response:await inject(),writes};
  }
  if(scenario === 'owner-close') {
    const socket=d.sessions.worker.ownerWs;
    const before=d.sessions.worker.deliveryGeneration;
    socket.readyState=3; socket.emit('close');
    return {before,after:d.sessions.worker.deliveryGeneration,response:await inject(),writes};
  }
  if(scenario === 'readopt-valid' || scenario === 'readopt-revoked') {
    const socket=d.sessions.worker.ownerWs;
    if(scenario === 'readopt-revoked') {
      const deleted=await request('DELETE','/api/sessions/worker',undefined,s.targetToken);
      assert.equal(deleted.status,200);
      const registered=await request('POST','/api/sessions/register',{session_id:'worker',command:'fixture-shell',backend:'fixture'});
      assert.equal(registered.status,201);
    } else {
      d.sessions.worker={...d.sessions.worker,ownerWs:null,clients:new Set()};
    }
    const before=d.sessions.worker.deliveryGeneration;
    socket.emit('message',Buffer.from(JSON.stringify({type:'output',data:'readoption'})));
    const target=await request('GET','/api/sessions/worker/conditional-target',undefined,s.token);
    return {before,after:d.sessions.worker.deliveryGeneration,target,response:await inject(),writes,proved:d.sessions.worker.sessionEpochProved};
  }
  if(scenario.startsWith('fence')) {
    assert.equal(d.isConditionallyFenced('worker'),true);
    if(scenario.includes('fault')) {
      const original = fs.fsyncSync;
      fs.fsyncSync = fd => { if(scenario.includes('dir') && !fs.fstatSync(fd).isDirectory()) return original(fd); const e=new Error('fixture EIO');e.code='EIO';throw e; };
      result = d.conditionalStore.commit(); fs.fsyncSync = original;
      assert.equal(result.ok,false);
    }
    if(scenario.includes('restart')) {
      fs.writeFileSync(d.conditionalStore.path,'{corrupt');
      d.restoreConditionalAdmissions();
      assert.equal(d.conditionalStore.available(),false);
    }
    const before = writes.length;
    if(scenario.endsWith('submit')) result=d.submitViaPty(d.sessions.worker);
    else if(scenario.endsWith('submitroute')) result=await request('POST','/api/sessions/worker/submit',{force:true},s.token);
    else if(scenario.endsWith('submitall')) result=d.runSubmitAll({worker:d.sessions.worker});
    else if(scenario.endsWith('multicast')) result=await request('POST','/api/sessions/multicast/inject',{session_ids:['worker'],prompt:'UNBOUND'},s.token);
    else if(scenario.endsWith('broadcast')) result=await request('POST','/api/sessions/broadcast/inject',{prompt:'UNBOUND'},s.token);
    else if(scenario.endsWith('viewer')) { const v=owner('worker',s.targetToken,true); v.emit('message',Buffer.from(JSON.stringify({type:'input',data:'UNBOUND'}))); }
    else result = await request('POST','/api/sessions/worker/inject',{prompt:'UNBOUND',no_enter:true},s.token);
    return {result,writes:writes.slice(before).filter(w=>w.sid==='worker'),fenced:d.isConditionallyFenced('worker')};
  }
  if(scenario==='auth') {
    return {missingHost:await request('POST','/api/sessions/worker/inject',s.envelope,s.token,false),missingBearer:await request('POST','/api/sessions/worker/inject',s.envelope),spoof:await inject({...s.envelope,from:'attacker'}),writes};
  }
  if(scenario==='forged') {
    d.mailbox.enqueue({msg_id:'conditional:'+require('node:crypto').randomUUID()+':body',from:'controller',to:'worker',payload:'forged',created_at:Math.floor(Date.now()/1000),attempt:0});
    await d.mailboxDelivery.tick(); return {writes};
  }
  if(scenario==='stale-before') { owner('worker',s.targetToken); return {response:await inject(),writes}; }
  if(scenario==='expired') {const now=Date.now();Date.now=()=>now+120000;return {response:await inject(),writes};}
  if(scenario==='noncanonical') return {response:await request('POST','/api/sessions/worker/inject',s.envelope,s.token,true,JSON.stringify(s.envelope,null,2)),writes};
  if(scenario==='concurrent') {const responses=await Promise.all([inject(),inject()]);await d.mailboxDelivery.tick();await cr();return {responses,writes};}
  if(scenario==='bootstrap') {d.sessions.worker.command='claude';d.sessions.worker.bootstrapReady=false;d.sessions.worker.ready=false;}
  if(scenario==='modal' || scenario==='modal-replace') {
    d.sessions.worker.command='claude';
    d.sessions.worker.outputRing=['Claudehaswrittenupaplanandisreadytoexecute.Wouldyouliketoproceed?\n❯1.Yes,auto-acceptedits\n2.Yes,manuallyapproveedits\n3.No,refinewithUltraplanonClaudeCodeontheweb\n4.TellClaudewhattochange\nshift+tabtoapprovewiththisfeedback\n'];
    assert.equal(d.isSurfaceBlockedByModal(d.sessions.worker),true);
  }
  if(scenario==='registration-mutation') {
    await request('POST','/api/sessions/register',{session_id:'worker',backend:'changed-backend'},s.targetToken);
    return {response:await inject(),writes};
  }
  if(scenario==='restart-corrupt-seed') {
    fs.writeFileSync(path.join(home,'restart.json'),JSON.stringify({...s,corrupt:true}));
    fs.writeFileSync(d.conditionalStore.path,'{corrupt');
    return {home,writes};
  }
  if(scenario==='cli' || scenario==='cli-binding') {
    process.env.TELEPTY_SESSION_TOKEN=s.token;
    const file=path.join(home,'request.json');fs.writeFileSync(file,JSON.stringify(scenario==='cli-binding'?s.bindingRequest:s.envelope));
    process.argv=[process.execPath,path.join(runtime,'cli.js'),...(scenario==='cli-binding'?['target-binding','worker','--request',file]:['inject','worker','--conditional-request',file])];
    let requests=0;
    const response=await new Promise((resolve,reject)=>{
      global.fetch=async (url,options)=>{
        requests++;
        try { const r=await request(options.method,new URL(url).pathname,JSON.parse(options.body),options.headers['X-Telepty-Session-Token'] || options.headers['x-telepty-session-token'],Boolean(options.headers['X-Telepty-Token'] || options.headers['x-telepty-token']));resolve(r);return {ok:r.status<300,status:r.status,json:async()=>r.body}; } catch(e){reject(e);throw e;}
      };
      const mod=new Module(process.argv[1],null);mod.filename=process.argv[1];mod.paths=Module._nodeModulePaths(runtime);process.mainModule=mod;mod._compile(fs.readFileSync(mod.filename,'utf8'),mod.filename);
    });
    await d.mailboxDelivery.tick();await cr();return {response,requests,writes};
  }
  result = await inject();
  assert.equal(result.status,202,JSON.stringify(result));
  if(scenario==='bootstrap') {assert.equal(writes.length,0);assert.equal(d.sessions.worker.bootstrapQueue.length,1);d.sessions.worker.bootstrapReady=true;d.sessions.worker.ready=true;await d.drainBootstrapQueue('worker',d.sessions.worker);}
  if(scenario==='modal' || scenario==='modal-replace') {
    assert.equal(writes.length,0);assert.equal(d.sessions.worker.bootstrapQueue.length,1);
    if(scenario==='modal-replace') owner('worker',s.targetToken);
    d.sessions.worker.outputRing=[];
    await d.drainBootstrapQueue('worker',d.sessions.worker);
  }
  if(scenario==='restart-seed') {
    fs.writeFileSync(path.join(home,'restart.json'),JSON.stringify({...s,original:result.body.inject_id}));
    return {home,writes};
  }
  await d.mailboxDelivery.tick();
  if(scenario==='replace-cr') owner('worker',s.targetToken);
  if(scenario==='revoke-cr') {
    const deleted=await request('DELETE','/api/sessions/controller',undefined,s.token);
    assert.equal(deleted.status,200,JSON.stringify(deleted));
    await register('controller');
  }
  await cr();
  const duplicate=await inject();
  const conflict=await inject({...s.envelope,key:{...s.envelope.key,revision:2}});
  return {response:result,duplicate,conflict,writes,record:d.conditionalStore.getAdmissionByInjectId(result.body.inject_id)};
}
main().then(result => { assert.deepEqual(violations,[]); console.log('FIXTURE_RESULT '+JSON.stringify(result)); }, error => {console.error(error.stack);process.exitCode=1;});
