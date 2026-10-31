'use strict';

// Pure-core regressions: principal, observation and terminal seams are synthetic.
// These assertions do not establish authenticated HTTP or live provider behavior.
// Original row provenance is in the accompanying CASE-MAP.json, not runtime input.
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const I = require('../src/interaction');
const P = require('../src/session-store/persistence');
const R = require('../src/prompt-symbol-registry');
const { assertOwnerOnlyMode } = require('../test-support/platform-contract');

nodeTest('interaction-core-681 / baseline', { concurrency: false }, async t => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-interaction-681-baseline-'));
  const out = output;
  try {
const tests=[];const test=(id,fn)=>tests.push({id,fn});const copy=o=>JSON.parse(JSON.stringify(o));
const NOW=100000;const text='P942: 원문 😀 original task';
function request(id='a1') {return {schema_version:1,action_id:id,interaction_request_id:'request1',identity:{kind:'manual',sid:'s1'},expected:{sid:'s1',session_epoch:'epoch1',credential_generation:1,owner_generation:'owner1',input_generation:1,geometry_generation:1,prompt_revision:'r1',frame_digest:'a'.repeat(64),surface_id:'surface1',cols:80,rows:24,question_id:'q1'},operation:'key',value:'down',authority:{provenance:'controller-policy',reference:'scope1'},expires_at:NOW+10000};}
function observation(r=request()) {return {...r.expected,available:true,current_frame:true,provenance:'measured-provider',expires_at:NOW+20000,mode:'single_choice',routine:true,supported_operations:['key','text','select'],option_ids:['A','B','C']};}
function binding(r=request()){return {...r.expected};}
function frame(r){return {type:'interaction',request:r,request_digest:I.digest(r)};}
let fileNumber=0;
function store(){const file=path.join(output,`ledger-${++fileNumber}.json`);let ledger=P.emptyTrackedInjections(),commits=[],dispatches=[];return {file,commits,dispatches,get ledger(){return ledger;},commit(next){const saved=P.saveTrackedInjections(next,file);if(saved.ok){ledger=next;commits.push(copy(next));}return saved.ok;},read(){return ledger;}};}
function core(options={}){const s=store(),r=request();let clock=NOW;const c=I.createInteractionCore({readLedger:()=>s.read(),commitLedger:n=>s.commit(n),observe:()=>observation(r),binding:()=>binding(r),authorize:p=>p==='synthetic-controller',pendingTask:()=>null,dispatch:async f=>{s.dispatches.push(copy(f));return {stage:'written',bytes_written:3};},now:()=>clock,...options});return {c,s,setClock:n=>clock=n};}
function writer(options={}){let o=observation(),b=binding(),bytes=[];const w=I.createInteractionWriter({observe:()=>o,binding:()=>b,encode:()=> '\x1b[B',write:x=>bytes.push(x),now:()=>NOW,...options});return {w,bytes,setObservation:x=>o=x,setBinding:x=>b=x};}
function record(r,stage='written',bytes=3){return {action_id:r.action_id,request_digest:I.digest(r),interaction_request_id:r.interaction_request_id,sid:r.identity.sid,request:r,pending_inject_id:null,stage,reason:null,terminal:false,bytes_written:bytes,receipt_seq:1,updated_at:NOW};}
function loadCase(name,ledger){const file=path.join(output,`${name}.json`);fs.writeFileSync(file,JSON.stringify(ledger));const before=fs.readFileSync(file);const loaded=P.loadTrackedInjections(file);assert.deepEqual(fs.readFileSync(file),before,'load preserves disk evidence');return loaded;}
test('C1-fresh-positive',()=>{const x=writer(),a=request();assert.equal(x.w(frame(a)).stage,'written');const b=request('a2');b.expected.prompt_revision='r2';x.setObservation(observation(b));assert.equal(x.w(frame(b)).stage,'written');assert.equal(x.bytes.length,2);});
test('C1-exact-revision-refused',()=>{const x=writer();x.w(frame(request()));assert.equal(x.w(frame(request('a2'))).stage,'refused');assert.equal(x.bytes.length,1);});
test('C1-extra-expected-property-cannot-reuse-revision',()=>{const x=writer();x.w(frame(request()));const b=request('a2');b.expected.untrusted_extra='different';const result=x.w(frame(b));assert.equal(x.bytes.length,1,JSON.stringify({result,writeCount:x.bytes.length}));});
test('C2-null-array-scalars-oversize',()=>{for(const bad of [null,[],true,1,'x',{}, {...request(),value:null},{...request(),value:'x'.repeat(4097)},{...request(),operation:'exec'},{...request(),value:'constructor'},{...request(),operation:'text',value:'bad\ntext'},{...request(),expires_at:NOW+60001},{...request(),expires_at:NOW}])assert.notEqual(I.validateRequest(bad,NOW),null);});
test('C2-nested-array-rejected',()=>{const r=request();r.expected=Object.assign([],r.expected);assert.notEqual(I.validateRequest(r,NOW),null,'expected array must not validate');});
test('C2-nested-prototype-property-rejected',()=>{const r=request();r.expected=JSON.parse(JSON.stringify(r.expected).replace(/}$/,',"__proto__":{"marker":true}}'));assert.notEqual(I.validateRequest(r,NOW),null,'prototype-shaped extra expected property');assert.equal({}.marker,undefined);});
test('C2-inherited-required-field-rejected',()=>{const r=request();r.authority=Object.create(r.authority);assert.notEqual(I.validateRequest(r,NOW),null,'non-JSON inherited authority must not be accepted');});
test('C2-circular-input-typed-refusal',()=>{const r=request();r.expected.extra=r;const reason=I.validateRequest(r,NOW);assert.equal(typeof reason,'string');});
test('C2-denied-principal-no-dispatch-or-leak',async()=>{const x=core();await x.c.act(request(),'synthetic-controller');const denied=await x.c.act(request(),'denied');assert.equal(denied.reason,'authority_required');assert.equal(denied.action_id,undefined);assert.equal(x.s.dispatches.length,1);});
test('C2-task-binding-refusal',async()=>{const x=core();const r=request();r.identity={...r.identity,kind:'task',task_id:'942',sandbox_attempt:'attempt',dispatch_id:'d1'};r.pending_inject_id='P942';r.payload_digest=I.payloadDigest(text);assert.equal((await x.c.act(r,'synthetic-controller')).reason,'wrong_attempt');assert.equal(x.s.dispatches.length,0);});
test('C3-dedup-conflict-expired-privacy',async()=>{const x=core();const r=request();const first=await x.c.act(r,'synthetic-controller');assert.equal(first.stage,'written');assert.equal(first.terminal,false);assert.equal(first.request,undefined);assert.equal(first.authority,undefined);assert.equal(first.value,undefined);assert.deepEqual(x.c.lookup(r.action_id),first);assert.deepEqual(await x.c.act(copy(r),'synthetic-controller'),first);assert.equal((await x.c.act({...r,value:'up'},'synthetic-controller')).reason,'payload_conflict');x.setClock(NOW+20000);assert.deepEqual(await x.c.act(r,'synthetic-controller'),first);assert.equal(x.s.dispatches.length,1);assert.deepEqual(x.s.commits.map(l=>l.interactions.actions.a1.stage),['prepared','dispatched','written']);});
/* #1207: commits are awaited, so the first act reaches its dispatch a few turns later than the old synchronous core did. Wait (bounded) for that dispatch before the dedup assertion, and never await an act whose dispatch was not released. */
test('C3-serialized-competing-actions',async()=>{let release;const reached=async()=>{for(let i=0;i<200&&!release;i++)await new Promise(r=>setImmediate(r));return !!release;};const x=core({dispatch:()=>new Promise(resolve=>{release=resolve;})});const first=x.c.act(request(),'synthetic-controller');try{assert.equal(x.c.isBusy('s1'),true);assert.equal((await x.c.act(request('a2'),'synthetic-controller')).reason,'busy');assert.equal(await reached(),true,'the first act reached its dispatch');assert.equal((await x.c.act(request(),'synthetic-controller')).stage,'dispatched');}finally{if(await reached()){release({stage:'written',bytes_written:3});await first;}}assert.equal(x.c.isBusy('s1'),false);});
for(const field of I.FENCE_FIELDS.concat('question_id'))test(`C4-fence-${field}`,()=>{const x=writer();const o=observation();o[field]=typeof o[field]==='number'?o[field]+1:`${o[field]}-changed`;x.setObservation(o);assert.equal(x.w(frame(request())).stage,'refused');assert.equal(x.bytes.length,0);});
test('C4-binding-owner-changed',()=>{const x=writer();x.setBinding({...binding(),owner_generation:'owner2'});assert.equal(x.w(frame(request())).reason,'wrong_owner');assert.equal(x.bytes.length,0);});
test('C4-expiry-and-authority',()=>{for(const change of [{expires_at:NOW},{mode:'permission_trust'},{current_frame:false},{routine:false},{provenance:'quoted'}]){const x=writer({observe:()=>({...observation(),...change})});assert.equal(x.w(frame(request())).stage,'refused');assert.equal(x.bytes.length,0);}});
test('C5-write-throws-no-replay',()=>{let effects=0;const x=writer({write:()=>{effects++;throw Error('uncertain');}});const result=x.w(frame(request()));assert.equal(result.stage,'outcome_unknown');assert.equal(result.bytes_written,null);assert.deepEqual(x.w(frame(request())),result);assert.equal(effects,1);});
test('C5-dispatch-unknown-blocks',async()=>{const x=core({dispatch:async()=>{throw Error('receipt lost');}});const r=await x.c.act(request(),'synthetic-controller');assert.equal(r.stage,'outcome_unknown');assert.equal(r.bytes_written,null);assert.equal((await x.c.act(request('a2'),'synthetic-controller')).reason,'busy');const reloaded=P.loadTrackedInjections(x.s.file);assert.equal(reloaded.ok,true);assert.equal(reloaded.ledger.interactions.actions.a1.stage,'outcome_unknown');});
for(const failAt of [1,2,3])test(`C5-storage-failure-${failAt}`,async()=>{let saves=0,effects=0;const s=store();const x=core({readLedger:()=>s.read(),commitLedger:n=>++saves===failAt?false:s.commit(n),dispatch:async()=>{effects++;return {stage:'written',bytes_written:3};}});const r=await x.c.act(request(),'synthetic-controller');assert.equal(r.reason,'storage_unavailable');assert.equal(effects,failAt===3?1:0);assert.equal(r.stage,failAt===3?'outcome_unknown':'refused');assert.equal(r.bytes_written,failAt===3?null:0);});
test('C6-unavailable-observation-retains-original',async()=>{const r=request();r.pending_inject_id='P942';r.payload_digest=I.payloadDigest(text);const pending={inject_id:'P942',sid:'s1',payload:text,payload_digest:r.payload_digest,no_enter:false,fifo_seq:7,op_id:'op7'};const x=core({observe:()=>I.unavailableObservation(),pendingTask:()=>pending});const result=await x.c.act(r,'synthetic-controller');assert.equal(result.reason,'observation_unavailable');assert.equal(x.s.dispatches.length,0);const loaded=P.loadTrackedInjections(x.s.file);assert.equal(loaded.ok,true);const held=loaded.ledger.interactions.pending.P942;assert.equal(held.payload,text);assert.equal(held.payload_digest,I.payloadDigest(text));assert.equal(held.fifo_seq,7);assert.equal(held.op_id,'op7');assert.equal(held.no_enter,false);assert.deepEqual(held.identity,r.identity);assert.deepEqual(held.binding,binding());assert.equal(held.state,'held');});
test('C6-conflicting-payload-refused',async()=>{const r=request();r.pending_inject_id='P942';r.payload_digest=I.payloadDigest(text);const x=core({pendingTask:()=>({inject_id:'P942',sid:'s1',payload:'different',payload_digest:r.payload_digest})});assert.equal((await x.c.act(r,'synthetic-controller')).reason,'payload_conflict');assert.equal(x.s.dispatches.length,0);});
test('C7-v2-migration',()=>{const old={schema_version:2,generation:8,injections:{i1:{observations:[{state:'queued'}]}}};const result=loadCase('v2',old);assert.equal(result.ok,true);assert.equal(result.ledger.schema_version,3);assert.deepEqual(result.ledger.injections,old.injections);assert.deepEqual(result.ledger.interactions,{actions:{},pending:{}});});
test('C7-recovery-stages',()=>{const l=P.emptyTrackedInjections();for(const [id,stage,bytes] of [['p','prepared',0],['d','dispatched',null],['w','written',3]])l.interactions.actions[id]=record(request(id),stage,bytes);const result=loadCase('recovery',l);assert.equal(result.ok,true);assert.equal(result.ledger.interactions.actions.p.stage,'refused');assert.equal(result.ledger.interactions.actions.p.bytes_written,0);assert.equal(result.ledger.interactions.actions.d.stage,'outcome_unknown');assert.equal(result.ledger.interactions.actions.d.bytes_written,null);assert.equal(result.ledger.interactions.actions.w.stage,'written');});
for(const kind of ['action-id','request-null-shape','unknown-bytes','written-terminal','request-expiry'])test(`C7-malformed-${kind}`,()=>{const r=request(), rec=record(r);if(kind==='action-id'){rec.request.action_id='other';rec.request_digest=I.digest(rec.request);}if(kind==='request-null-shape'){rec.request={identity:{sid:'s1'}};rec.request_digest=I.digest(rec.request);}if(kind==='unknown-bytes'){rec.stage='outcome_unknown';rec.bytes_written=-7;}if(kind==='written-terminal')rec.terminal=true;if(kind==='request-expiry'){rec.request.expires_at='bad';rec.request_digest=I.digest(rec.request);}const l=P.emptyTrackedInjections();l.interactions.actions.a1=rec;const result=loadCase(`malformed-${kind}`,l);assert.equal(result.ok,false,JSON.stringify(result));});
test('C7-corrupt-future-maps',()=>{for(const [i,l] of [null,[],{schema_version:99,injections:{}},{schema_version:3,injections:{},interactions:{actions:[],pending:{}}}].entries())assert.equal(loadCase(`invalid-${i}`,l).ok,false);const f=path.join(output,'corrupt.json');fs.writeFileSync(f,'{bad');assert.equal(P.loadTrackedInjections(f).ok,false);assert.equal(fs.readFileSync(f,'utf8'),'{bad');});
test('C7-atomic-save-private-mode',async(t)=>{const s=store();assert.equal(s.commit(P.emptyTrackedInjections()),true);await assertOwnerOnlyMode(t,s.file,'private mode');/* #879: named subtest, skipped on win32; the mode line only */assert.equal(P.loadTrackedInjections(s.file).ok,true);});
test('C8-provider-disabled',()=>{for(const screen of ['', '› ', 'Press enter to continue','quoted historic prompt']){const result=R.observeInteraction({command:'codex',outputRing:[screen]});assert.equal(result.available,false);assert.deepEqual(result.supported_operations,[]);assert.equal(R.encodeInteraction(request(),result),null);}});

    for (const { id, fn } of tests) {
      await t.test('baseline / ' + id, { concurrency: false }, fn);
    }
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

nodeTest('interaction-core-681 / supplement', { concurrency: false }, async t => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-interaction-681-supplement-'));
  const out = output;
  try {
const tests=[];const test=(id,fn)=>tests.push({id,fn});const clone=o=>JSON.parse(JSON.stringify(o));const NOW=100000;
function req(){return {schema_version:1,action_id:'a1',interaction_request_id:'ir1',identity:{kind:'manual',sid:'s1'},expected:{sid:'s1',session_epoch:'e1',credential_generation:1,owner_generation:'o1',input_generation:1,geometry_generation:1,prompt_revision:'r1',frame_digest:'a'.repeat(64),surface_id:'surface1',cols:80,rows:24,question_id:'q1'},operation:'key',value:'down',authority:{provenance:'controller-policy',reference:'policy1'},expires_at:NOW+10000};}
function rec(r=req(),stage='written'){const defaults={prepared:[0,false,null],dispatched:[null,false,null],written:[3,false,null],refused:[0,true,'stale_prompt'],outcome_unknown:[null,true,'outcome_unknown']}[stage];return {action_id:r.action_id,request_digest:I.digest(r),interaction_request_id:r.interaction_request_id,sid:r.identity.sid,request:r,pending_inject_id:r.pending_inject_id||null,stage,bytes_written:defaults[0],terminal:defaults[1],reason:defaults[2],receipt_seq:1,updated_at:NOW};}
let files=0;
function loadRecord(record,pending={}){const file=path.join(out,`ledger-${++files}.json`);const ledger=P.emptyTrackedInjections();ledger.interactions.actions.a1=record;ledger.interactions.pending=pending;assert.equal(P.saveTrackedInjections(ledger,file).ok,true);const bytes=fs.readFileSync(file);const result=P.loadTrackedInjections(file);assert.deepEqual(fs.readFileSync(file),bytes,'loader must preserve evidence');return {result,file};}
function makeCore(dispatch,seed=P.emptyTrackedInjections(),clock=NOW){let ledger=seed;let calls=0;const file=path.join(out,`core-${++files}.json`);const r=req();const core=I.createInteractionCore({readLedger:()=>ledger,commitLedger:next=>{const saved=P.saveTrackedInjections(next,file);if(saved.ok)ledger=next;return saved.ok;},observe:()=>({...r.expected,available:true,current_frame:true,provenance:'measured-provider',expires_at:clock+10000,routine:true,mode:'single_choice',supported_operations:['key']}),binding:()=>({...r.expected}),authorize:p=>p==='synthetic',pendingTask:()=>null,dispatch:async f=>{calls++;return dispatch(f);},now:()=>clock});return {core,get calls(){return calls;},file};}
const containers=[['request',r=>r,'value'],['identity',r=>r.identity,'sid'],['expected',r=>r.expected,'prompt_revision'],['authority',r=>r.authority,'reference']];
for(const [label,get,key] of containers){
 test(`own-accessor-${label}`,()=>{const r=req();let reads=0;Object.defineProperty(get(r),key,{enumerable:true,get(){reads++;throw Error('getter executed');}});assert.notEqual(I.validateRequest(r,NOW),null);assert.equal(reads,0);});
 test(`symbol-${label}`,()=>{const r=req();get(r)[Symbol('extra')]=1;assert.notEqual(I.validateRequest(r,NOW),null);});
 test(`nonenumerable-${label}`,()=>{const r=req();Object.defineProperty(get(r),key,{value:get(r)[key],enumerable:false});assert.notEqual(I.validateRequest(r,NOW),null);});
 test(`extra-${label}`,()=>{const r=req();get(r).extra='unexpected';assert.notEqual(I.validateRequest(r,NOW),null);});
}
test('null-prototype-valid-control',async()=>{const r=req();for(const [,get]of containers)Object.setPrototypeOf(get(r),null);assert.equal(I.validateRequest(r,NOW),null);let writes=0;const w=I.createInteractionWriter({observe:()=>({...r.expected,available:true,current_frame:true,provenance:'measured-provider',expires_at:NOW+20000,mode:'single_choice',routine:true,supported_operations:['key']}),binding:()=>({...r.expected}),encode:()=> '\x1b[B',write:()=>{writes++;},now:()=>NOW});assert.equal(w({request:r,request_digest:I.digest(r)}).stage,'written');assert.equal(writes,1);});
test('historically-expired-load-dedup',async()=>{const r=req();r.expires_at=1;assert.equal(I.validateRequestStructure(r),null);assert.equal(I.validateRequest(r,NOW),'expired');const {result}=loadRecord(rec(r));assert.equal(result.ok,true);const x=makeCore(()=>{throw Error('must not dispatch');},result.ledger);const receipt=await x.core.act(r,'synthetic');assert.equal(receipt.stage,'written');assert.equal(receipt.request_digest,I.digest(r));assert.equal(x.calls,0);});
for(const stage of ['prepared','dispatched','written','refused','outcome_unknown']){
 test(`stage-valid-${stage}`,()=>{const {result}=loadRecord(rec(req(),stage));assert.equal(result.ok,true);assert.equal(result.ledger.interactions.actions.a1.stage,{prepared:'refused',dispatched:'outcome_unknown'}[stage]||stage);});
 for(const field of ['bytes_written','terminal','reason'])test(`stage-invalid-${stage}-${field}`,()=>{const record=rec(req(),stage);record[field]=field==='bytes_written'?(stage==='written'?8193:7):field==='terminal'?!record.terminal:'not_a_reason';assert.equal(loadRecord(record).result.ok,false);});
}
for(const field of ['action_id','interaction_request_id','sid','pending_inject_id','request_digest','updated_at','receipt_seq'])test(`record-mismatch-${field}`,()=>{const record=rec();record[field]=field==='updated_at'?-1:field==='receipt_seq'?Number.MAX_SAFE_INTEGER:'wrong';assert.equal(loadRecord(record).result.ok,false);});
test('pending-link-positive',()=>{const r=req();r.pending_inject_id='P942';r.payload_digest=I.payloadDigest('P942 original');const record=rec(r);const pending={P942:{inject_id:'P942',sid:'s1',state:'held',payload:'P942 original',payload_digest:r.payload_digest,identity:r.identity,binding:r.expected}};assert.equal(loadRecord(record,pending).result.ok,true);});
test('pending-link-missing-retained-payload',()=>{const r=req();r.pending_inject_id='P942';r.payload_digest=I.payloadDigest('P942 original');const result=loadRecord(rec(r)).result;assert.equal(result.ok,false,'receipt referencing lost retained payload must fail closed');});
const malformed=[['unknown-stage',{stage:'consumed',bytes_written:3}],['written-zero',{stage:'written',bytes_written:0}],['written-oversize',{stage:'written',bytes_written:8193}],['written-reason',{stage:'written',bytes_written:3,reason:'busy'}],['refused-nonzero',{stage:'refused',bytes_written:3,reason:'busy'}],['refused-missing-reason',{stage:'refused',bytes_written:0}],['null-result',null]];
for(const [name,result]of malformed)test(`dispatch-uncertain-${name}`,async()=>{const x=makeCore(()=>result);const receipt=await x.core.act(req(),'synthetic');assert.equal(receipt.stage,'outcome_unknown');assert.equal(receipt.bytes_written,null);assert.equal(x.core.isBusy('s1'),true);assert.equal(P.loadTrackedInjections(x.file).ok,true);});
test('dispatch-valid-written',async()=>{const x=makeCore(()=>({stage:'written',bytes_written:3,reason:null}));const receipt=await x.core.act(req(),'synthetic');assert.equal(receipt.stage,'written');assert.equal(receipt.terminal,false);assert.equal(P.loadTrackedInjections(x.file).ok,true);});
test('dispatch-valid-refused',async()=>{const x=makeCore(()=>({stage:'refused',bytes_written:0,reason:'stale_prompt'}));const receipt=await x.core.act(req(),'synthetic');assert.equal(receipt.stage,'refused');assert.equal(receipt.terminal,true);assert.equal(P.loadTrackedInjections(x.file).ok,true);});

    for (const { id, fn } of tests) {
      await t.test('supplement / ' + id, { concurrency: false }, fn);
    }
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

// #1207 — the core's commit is ASYNC and persists one interaction delta per stage through the
// ledger owner; a per-act reservation (class I) is taken BEFORE the first saveRecord. These cases
// pin the seams a synthetic commit can prove: reservation refusal is `busy` with no commit, an
// `'indeterminate'` commit is a refusal that NAMES the unknown storage outcome and never dispatches,
// and a promise-returning commit drives prepared → dispatched → written exactly once each.
nodeTest('interaction-core-681 / 1207-async-commit', { concurrency: false }, async t => {
  const NOW = 100000;
  function req(id = 'a1') { return { schema_version: 1, action_id: id, interaction_request_id: 'ir1', identity: { kind: 'manual', sid: 's1' }, expected: { sid: 's1', session_epoch: 'e1', credential_generation: 1, owner_generation: 'o1', input_generation: 1, geometry_generation: 1, prompt_revision: 'r1', frame_digest: 'a'.repeat(64), surface_id: 'surface1', cols: 80, rows: 24, question_id: 'q1' }, operation: 'key', value: 'down', authority: { provenance: 'controller-policy', reference: 'p1' }, expires_at: NOW + 10000 }; }
  function observation(r = req()) { return { ...r.expected, available: true, current_frame: true, provenance: 'measured-provider', expires_at: NOW + 20000, mode: 'single_choice', routine: true, supported_operations: ['key'] }; }
  function makeCore(commit, extra = {}) {
    let ledger = P.emptyTrackedInjections(); const commits = []; const dispatches = []; const acts = [];
    const core = I.createInteractionCore({
      readLedger: () => ledger,
      commitLedger: async (next, change) => { commits.push({ stage: change.record.stage, pending: change.pending }); const r = await commit(next, change, commits.length); if (r === true) ledger = next; return r; },
      observe: () => observation(), binding: () => ({ ...req().expected }), authorize: (p) => p === 'ctl', pendingTask: () => null,
      dispatch: async (f) => { dispatches.push(f); return { stage: 'written', bytes_written: 3, reason: null }; }, now: () => NOW,
      reserveAct: (sid) => { acts.push(['reserve', sid]); return extra.reserve === undefined ? true : extra.reserve; },
      releaseAct: (sid) => { acts.push(['release', sid]); },
      ...extra.deps,
    });
    return { core, commits, dispatches, acts, get ledger() { return ledger; } };
  }
  await t.test('async promise commit drives the three stages once each; reservation held for the act and released in finally', async () => {
    const x = makeCore(async () => true);
    const receipt = await x.core.act(req(), 'ctl');
    assert.equal(receipt.stage, 'written');
    assert.deepEqual(x.commits.map((c) => c.stage), ['prepared', 'dispatched', 'written']);
    assert.equal(x.dispatches.length, 1);
    assert.deepEqual(x.acts, [['reserve', 's1'], ['release', 's1']]);
    assert.equal(x.core.lookup('a1').stage, 'written');
  });
  await t.test('reservation refused ⇒ busy, before any commit or dispatch', async () => {
    const x = makeCore(async () => true, { reserve: false });
    const receipt = await x.core.act(req(), 'ctl');
    assert.equal(receipt.reason, 'busy');
    assert.deepEqual(x.commits, []); assert.deepEqual(x.dispatches, []);
    assert.deepEqual(x.acts, [['reserve', 's1']], 'nothing to release: the act never started');
  });
  await t.test('an indeterminate commit at prepared is a NAMED unknown storage outcome: refused, storage_outcome:indeterminate, no dispatch, not reported as persisted', async () => {
    const x = makeCore(async () => 'indeterminate');
    const receipt = await x.core.act(req(), 'ctl');
    assert.equal(receipt.stage, 'refused'); assert.equal(receipt.reason, 'storage_unavailable'); assert.equal(receipt.storage_outcome, 'indeterminate');
    assert.deepEqual(x.dispatches, []);
    assert.equal(x.core.lookup('a1'), null, 'the read model was never advanced on an unknown outcome');
    assert.deepEqual(x.acts, [['reserve', 's1'], ['release', 's1']]);
  });
  await t.test('an indeterminate FINAL commit after a dispatch keeps outcome_unknown and names the storage outcome; a false commit before dispatch refuses without dispatching', async () => {
    const x = makeCore(async (next, change, n) => (n === 3 ? 'indeterminate' : true));
    const receipt = await x.core.act(req(), 'ctl');
    assert.equal(receipt.stage, 'outcome_unknown'); assert.equal(receipt.bytes_written, null); assert.equal(receipt.storage_outcome, 'indeterminate'); assert.equal(receipt.action_id, 'a1');
    assert.equal(x.dispatches.length, 1);
    const y = makeCore(async (next, change, n) => n !== 2);
    const r2 = await y.core.act(req('a2'), 'ctl');
    assert.equal(r2.reason, 'storage_unavailable'); assert.equal(r2.storage_outcome, undefined); assert.deepEqual(y.dispatches, []);
  });
  await t.test('a construction site without reserve/release keeps the pre-#1207 behaviour (always admitted)', async () => {
    let ledger = P.emptyTrackedInjections();
    const core = I.createInteractionCore({ readLedger: () => ledger, commitLedger: (next) => { ledger = next; return true; }, observe: () => observation(), binding: () => ({ ...req().expected }), authorize: () => true, pendingTask: () => null, dispatch: async () => ({ stage: 'written', bytes_written: 3, reason: null }), now: () => NOW });
    assert.equal((await core.act(req(), 'x')).stage, 'written');
  });
});

nodeTest('interaction-core-681 / link-controls', { concurrency: false }, async t => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-interaction-681-links-'));
  try {
function fixture(id='P942') {
 const r={schema_version:1,action_id:'a1',interaction_request_id:'ir1',identity:{kind:'manual',sid:'s1'},expected:{sid:'s1',session_epoch:'e1',credential_generation:1,owner_generation:'o1',input_generation:1,geometry_generation:1,prompt_revision:'r1',frame_digest:'a'.repeat(64),surface_id:'surface1',cols:80,rows:24,question_id:'q1'},operation:'key',value:'down',authority:{provenance:'controller-policy',reference:'policy1'},expires_at:110000,pending_inject_id:id,payload_digest:I.payloadDigest('P942 original')};
 const ledger=P.emptyTrackedInjections();
 ledger.interactions.actions.a1={action_id:'a1',interaction_request_id:'ir1',sid:'s1',request:r,request_digest:I.digest(r),pending_inject_id:id,stage:'written',bytes_written:3,terminal:false,reason:null,receipt_seq:1,updated_at:100000};
 ledger.interactions.pending[id]={inject_id:id,sid:'s1',state:'held',payload:'P942 original',payload_digest:r.payload_digest,identity:{...r.identity},binding:{...r.expected}};
 return ledger;
}
const reference='invalid_interaction_pending_reference';
const cases=[
 ['matching-positive',()=>fixture(),true],
 ['missing-reference',()=>{const l=fixture();delete l.interactions.pending.P942;return l;},false,reference],
 ['inherited-constructor-not-own',()=>{const l=fixture('constructor');delete l.interactions.pending.constructor;return l;},false,reference],
 ['own-constructor-positive',()=>fixture('constructor'),true],
 ['retained-id-mismatch',()=>{const l=fixture();l.interactions.pending.P942.inject_id='other';return l;},false,'invalid_interaction_pending'],
 ['retained-sid-mismatch',()=>{const l=fixture(),p=l.interactions.pending.P942;p.sid=p.identity.sid=p.binding.sid='s2';return l;},false,reference],
 ['retained-identity-mismatch',()=>{const l=fixture();l.interactions.pending.P942.identity={kind:'task',sid:'s1',task_id:'942',sandbox_attempt:'attempt',dispatch_id:'d1'};return l;},false,reference],
 ['retained-digest-mismatch',()=>{const l=fixture(),p=l.interactions.pending.P942;p.payload='different';p.payload_digest=I.payloadDigest(p.payload);return l;},false,reference],
 ['canonical-identity-order-positive',()=>{const l=fixture();l.interactions.pending.P942.identity={sid:'s1',kind:'manual'};return l;},true],
 ['manual-no-reference',()=>{const l=fixture(),a=l.interactions.actions.a1;delete a.request.pending_inject_id;delete a.request.payload_digest;a.pending_inject_id=null;a.request_digest=I.digest(a.request);l.interactions.pending={};return l;},true],
 ['v2-history',()=>({schema_version:2,generation:8,injections:{old:{observations:[{state:'queued'}]}}}),true],
 ['expired-linked-history',()=>{const l=fixture(),a=l.interactions.actions.a1;a.request.expires_at=1;a.request_digest=I.digest(a.request);return l;},true]
];

    for (const [id, build, ok, detail = null] of cases) {
      await t.test('link-controls / ' + id, { concurrency: false }, () => {
        const file = path.join(out, id + '.json');
   // All stimuli cross genuine JSON on disk; no global prototype mutation.
   const ledger=JSON.parse(JSON.stringify(build()));
   if(ledger.schema_version===2)fs.writeFileSync(file,JSON.stringify(ledger));
   else if(!P.saveTrackedInjections(ledger,file).ok)throw Error('save failed');
   const raw=fs.readFileSync(file),loaded=P.loadTrackedInjections(file);
   const actual={ok:loaded.ok,detail:loaded.detail||null,unchanged:fs.readFileSync(file).equals(raw)};
   const expected={ok,detail,unchanged:true};
   if(ok){actual.injections=loaded.ledger.injections;expected.injections=ledger.injections;actual.schema=loaded.ledger.schema_version;expected.schema=3;
    actual.interactions=loaded.ledger.interactions;expected.interactions=ledger.schema_version===2?{actions:{},pending:{}}:ledger.interactions;}
   assert.deepEqual(actual,expected); // One concrete compound assertion per named case: 12 total.

      });
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
