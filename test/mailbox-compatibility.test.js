'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
function fixture(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mailbox-compat-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('read-only compatibility inventory never grants migration or exposes lock/message contents',t=>{
 const root=fixture(t),legacy=path.join(root,'legacy'),idle=path.join(root,'idle'),fresh=path.join(root,'fresh');
 for(const dir of [legacy,idle,fresh])fs.mkdirSync(dir);
 fs.writeFileSync(path.join(legacy,'.lock'),'accidental-secret');fs.writeFileSync(path.join(legacy,'inbox.jsonl'),'private-payload');
 fs.mkdirSync(path.join(idle,'.lock'));
 const old=fs.lstatSync(path.join(legacy,'.lock'));
 const {inspectMailboxCompatibility}=require('../src/mailbox/compatibility');
 const report=inspectMailboxCompatibility(root);
 assert.equal(report.migration_permitted,false);assert.equal(report.writer_quiescence,'unverified');assert.equal(report.external_client_compatibility,'unverified');assert.equal(report.mutated,false);
 assert.deepEqual(report.sessions.map(s=>[s.session_id,s.lock_format]),[['fresh','absent'],['idle','v2_directory_observed'],['legacy','legacy_file']]);
 assert.equal(report.sessions[1].holder_state,'unknown');assert.equal(report.sessions[1].acquisition_entries,0);
 assert.ok(!JSON.stringify(report).includes('accidental-secret'));assert.ok(!JSON.stringify(report).includes('private-payload'));
 assert.equal(fs.readFileSync(path.join(legacy,'.lock'),'utf8'),'accidental-secret');assert.equal(fs.lstatSync(path.join(legacy,'.lock')).mtimeMs,old.mtimeMs);
 assert.equal(fs.existsSync(path.join(fresh,'.lock')),false);
});
test('observed acquisition entries do not establish a holder or remove dead-looking tickets',t=>{
 const root=fixture(t),dir=path.join(root,'s','.lock');fs.mkdirSync(dir,{recursive:true});const name='999999-'.concat('a'.repeat(32));fs.mkdirSync(path.join(dir,name));
 const {inspectMailboxCompatibility}=require('../src/mailbox/compatibility');const report=inspectMailboxCompatibility(root);
 assert.equal(report.sessions[0].acquisition_entries,1);assert.equal(report.sessions[0].holder_state,'unknown');assert.ok(fs.existsSync(path.join(dir,name)));assert.ok(!JSON.stringify(report).includes(name));
});
test('missing roots are refused without initialization and symlinks are never inventoried', {skip:process.platform==='win32'},t=>{
 const root=fixture(t),missing=path.join(root,'missing');const {inspectMailboxCompatibility}=require('../src/mailbox/compatibility');
 assert.throws(()=>inspectMailboxCompatibility(missing),{code:'MAILBOX_UNSAFE_PATH'});assert.equal(fs.existsSync(missing),false);
 const external=path.join(root,'outside');fs.mkdirSync(external);fs.writeFileSync(path.join(external,'keep'),'untouched');
 const dir=path.join(root,'s');fs.mkdirSync(dir);fs.symlinkSync(external,path.join(dir,'.lock'),'dir');
 const row=inspectMailboxCompatibility(root).sessions.find(s=>s.session_id==='s');assert.equal(row.lock_format,'unsafe');assert.equal(fs.readFileSync(path.join(external,'keep'),'utf8'),'untouched');
});
test('bounded scans report partial state rather than treating unvisited entries as empty',t=>{
 const root=fixture(t);for(const name of ['a','b','c'])fs.mkdirSync(path.join(root,name));
 const {inspectMailboxCompatibility}=require('../src/mailbox/compatibility');const report=inspectMailboxCompatibility(root,{entryBudget:2});
 assert.equal(report.complete,false);assert.equal(report.migration_permitted,false);assert.equal(report.reason,'entry_budget');
});
test('preflight CLI requires an explicit root and rejects mutating or unknown switches',t=>{
 const root=fixture(t),script=path.join(__dirname,'../scripts/mailbox-preflight.js');
 for(const args of [[],['--force',root],['--root',root,'--migrate']]){const r=spawnSync(process.execPath,[script,...args],{encoding:'utf8'});assert.equal(r.status,2);assert.ok(!r.stdout.includes('migration_permitted'));}
 const r=spawnSync(process.execPath,[script,'--root',root],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).migration_permitted,false);
});
test('directory changes during inspection produce a partial observation',t=>{
 const root=fixture(t),original=fs.opendirSync;fs.mkdirSync(path.join(root,'s'));
 let changed=false;t.mock.method(fs,'opendirSync',function(...args){const opened=original.apply(fs,args);if(!changed){changed=true;fs.mkdirSync(path.join(root,'concurrent'));}return opened;});
 const {inspectMailboxCompatibility}=require('../src/mailbox/compatibility');const report=inspectMailboxCompatibility(root);
 assert.equal(report.complete,false);assert.equal(report.reason,'changed_during_inspection');assert.equal(report.migration_permitted,false);
});
// #1215 diagnostics12 — durable-enqueue CHARACTERIZATION (source-reachable path; not the observed native cause and not a
// correction). FileMailbox.enqueue appends the inbox row and its `pending` state row, then releases its own lock ticket.
// If that release's own-ticket rmdir is refused (ENOTEMPTY: e.g. an entry still delete-pending), enqueue throws AFTER the
// message is durable. These cases pin persistence/ownership: the SAME error propagates, the rows are retained, only this
// acquisition's own ticket is left, and nothing else is touched. Only that one owned rmdir is mocked, once; t.mock restores
// it at test end and the private fixture root is removed by fixture().
function enqueueFixture(t,sid){
 const root=fixture(t),{FileMailbox}=require('../src/mailbox'),mailbox=new FileMailbox({root});
 const sessionDir=path.join(mailbox.config.root,sid),lockDir=path.join(sessionDir,'.lock');
 const msg=id=>({msg_id:id,from:'orch',to:sid,payload:'characterization-payload',created_at:Math.floor(Date.now()/1000),attempt:0});
 const rows=file=>{try{return fs.readFileSync(path.join(sessionDir,file),'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));}catch(e){if(e.code==='ENOENT')return [];throw e;}};
 return {mailbox,sessionDir,lockDir,msg,rows};
}
function refuseOwnTicketRmdir(t,lockDir,makeError){
 const original=fs.rmdirSync,seen={calls:0,thrown:undefined};
 t.mock.method(fs,'rmdirSync',function(p,...rest){
  if(seen.calls===0&&path.dirname(p)===lockDir&&path.basename(p).startsWith(`${process.pid}-`)){seen.calls++;seen.thrown=makeError(p);throw seen.thrown;}
  return original.call(fs,p,...rest);
 });
 return seen;
}
test('#1215 characterization: an own-release rmdir ENOTEMPTY after the durable append rethrows that same error and keeps the inbox/pending rows',t=>{
 const {mailbox,lockDir,msg,rows}=enqueueFixture(t,'s');
 const seen=refuseOwnTicketRmdir(t,lockDir,p=>Object.assign(new Error(`ENOTEMPTY: directory not empty, rmdir '${p}'`),{code:'ENOTEMPTY',syscall:'rmdir',path:p}));
 let caught,threw=false;try{mailbox.enqueue(msg('m-durable'));}catch(e){threw=true;caught=e;}assert.equal(threw,true,'enqueue threw');
 assert.equal(seen.calls,1,'exactly the one owned ticket rmdir was refused');
 assert.equal(caught,seen.thrown,'the SAME error object propagates (not wrapped or replaced)');
 assert.equal(caught.code,'ENOTEMPTY');assert.equal(caught.syscall,'rmdir');
 assert.equal(caught.mailbox_step,'release','diagnostic step names the release');
 assert.deepEqual(rows('inbox.jsonl').map(r=>r.msg_id),['m-durable'],'the inbox row is durable despite the throw');
 assert.deepEqual(rows('state.jsonl').filter(r=>r.msg_id==='m-durable').map(r=>r.state),['pending'],'and so is its pending state row');
 const left=fs.readdirSync(lockDir);
 assert.equal(left.length,1,'only this acquisition\'s ticket remains');assert.ok(left[0].startsWith(`${process.pid}-`));
 assert.deepEqual(fs.readdirSync(path.join(lockDir,left[0])),[],'its number and departure marker were removed before the refused rmdir');
});
test('#1215 characterization control: a normal enqueue is queued, durable and releases its lock',t=>{
 const {mailbox,lockDir,msg,rows}=enqueueFixture(t,'s');
 const ack=mailbox.enqueue(msg('m-normal'));
 assert.equal(ack.queued,true);assert.equal(ack.msg_id,'m-normal');
 assert.deepEqual(rows('inbox.jsonl').map(r=>r.msg_id),['m-normal']);
 assert.deepEqual(rows('state.jsonl').filter(r=>r.msg_id==='m-normal').map(r=>r.state),['pending']);
 assert.deepEqual(fs.readdirSync(lockDir),[],'the lock ticket was released');
 assert.equal(mailbox.enqueue(msg('m-normal')).queued,false,'a second acquisition succeeds and the re-enqueue stays idempotent');
 assert.deepEqual(fs.readdirSync(lockDir),[]);
});
test('#1215 characterization control: a protected or non-object thrown value is rethrown unchanged and never annotated',t=>{
 for(const [sid,make] of [['frozen',p=>Object.freeze(Object.assign(new Error(`ENOTEMPTY: rmdir '${p}'`),{code:'ENOTEMPTY'}))],['primitive',()=>'rmdir-refused']]){
  const {mailbox,lockDir,msg,rows}=enqueueFixture(t,sid);
  const seen=refuseOwnTicketRmdir(t,lockDir,make);
  let caught,threw=false;try{mailbox.enqueue(msg(`m-${sid}`));}catch(e){threw=true;caught=e;}assert.equal(threw,true,`${sid}: enqueue threw`);
  assert.equal(seen.calls,1);assert.equal(caught,seen.thrown,`${sid}: the same value propagates`);
  if(sid==='frozen'){assert.ok(Object.isFrozen(caught));assert.equal(Object.prototype.hasOwnProperty.call(caught,'mailbox_step'),false,'a frozen error is never annotated');assert.equal(caught.code,'ENOTEMPTY');}
  assert.deepEqual(rows('inbox.jsonl').map(r=>r.msg_id),[`m-${sid}`],`${sid}: the row is still durable`);
  t.mock.restoreAll();
 }
});
// #1215 correction41 (windows40 N1) — ADMISSION-phase read-site EPERM, CHARACTERIZATION through the real acquireLock.
// Windows main job 124625652428 (8a0219b): a contend worker's ADMISSION scan (lock.js acquireLockObserved) read a peer
// ticket whose `before` lstat succeeded, then openSync(number) raised EPERM and the re-list showed no marker
// (eperm_read_throw). Its re-list state was NOT measured. These cases drive the same read site through the real lock path
// with narrow owned mocks; they do not establish the native re-list state. The phase is observed, not assumed: the
// successor's own draft->number publication rename ends its doorway, so the holder's number open after it is the
// admission read. Only the holder's ticket paths are intercepted; every other file operation is real.
const LOCK_KEYS=['eperm_read_number_gone','read_throw_number_listed','eperm_read_throw','eperm_read_departed'];
function lockCounts(){const d=require('../src/mailbox/lock').lockDiagnostics();return Object.fromEntries(LOCK_KEYS.map(k=>[k,Number.isSafeInteger(d[k])?d[k]:null]));}
function lockDelta(a){const b=lockCounts();return Object.fromEntries(LOCK_KEYS.map(k=>[k,a[k]===null||b[k]===null?null:b[k]-a[k]]));}
function admissionFixture(t){
 const {acquireLock,ensureSessionDir}=require('../src/mailbox/storage');
 const dir=ensureSessionDir(fixture(t),'s'),lockDir=path.join(dir,'.lock'),release=acquireLock(dir);
 const name=fs.readdirSync(lockDir)[0],ticket=path.join(lockDir,name),number=path.join(ticket,'number');
 const seam={phase:'doorway',stage:'armed'},rename=fs.renameSync;
 t.mock.method(fs,'renameSync',function(from,to,...rest){
  const out=rename.call(fs,from,to,...rest);
  if(path.basename(to)==='number'&&path.dirname(path.dirname(to))===lockDir&&path.dirname(to)!==ticket)seam.phase='admission'; // the successor published
  return out;
 });
 const epermOpen=file=>Object.assign(new Error(`EPERM: operation not permitted, open '${file}'`),{code:'EPERM',syscall:'open',path:file});
 return {acquireLock,dir,lockDir,release,name,ticket,number,seam,epermOpen};
}
test('#1215 characterization: ADMISSION-phase EPERM on openSync of a published peer number whose departure has removed its marker (empty ticket before rmdir) is a departure; the successor acquires and stays exclusive',t=>{
 const f=admissionFixture(t),open=fs.openSync,readdir=fs.readdirSync,rmdir=fs.rmdirSync;
 t.mock.method(fs,'rmdirSync',function(p,...rest){if(p===f.ticket&&f.seam.stage==='releasing'){f.seam.stage='rmdir_deferred';return undefined;}return rmdir.call(fs,p,...rest);});
 t.mock.method(fs,'openSync',function(p,...rest){
  if(p===f.number&&f.seam.phase==='admission'&&f.seam.stage==='armed'){ // the admission read: the holder departs inside this open
   f.seam.stage='releasing';f.release();
   f.seam.emptied=f.seam.stage==='rmdir_deferred'&&readdir.call(fs,f.ticket).length===0;
   f.seam.stage='emptied';throw f.epermOpen(p);
  }
  return open.call(fs,p,...rest);
 });
 t.mock.method(fs,'readdirSync',function(p,...rest){const listed=readdir.call(fs,p,...rest);if(p===f.ticket&&f.seam.stage==='emptied'){f.seam.stage='relisted';rmdir.call(fs,f.ticket);}return listed;});
 const before=lockCounts();let successor,refused;
 try{successor=f.acquireLock(f.dir);}catch(e){refused=e;} // ORIGINAL 8a0219b: this EPERM is rethrown. lock10: departure recognised.
 const evidence=()=>JSON.stringify({phase:f.seam.phase,stage:f.seam.stage,emptied:f.seam.emptied??null,code:refused?.code??null,syscall:refused?.syscall??null,counters:lockDelta(before)});
 try{
  assert.equal(refused,undefined,`admission departure was refused: ${evidence()}`);
  assert.deepEqual([f.seam.phase,f.seam.stage,f.seam.emptied],['admission','relisted',true],`the EPERM was the admission read and the re-list saw the emptied ticket: ${evidence()}`);
  assert.deepEqual(lockDelta(before),{eperm_read_number_gone:1,read_throw_number_listed:0,eperm_read_throw:0,eperm_read_departed:0},evidence());
  assert.equal(fs.readdirSync(f.lockDir).length,1,'only the successor ticket remains');
  f.release(); // the old release is a no-op
  assert.throws(()=>f.acquireLock(f.dir),/lock timeout/i); // safety: the successor stays exclusive
 }finally{if(successor)successor();}
 assert.deepEqual(fs.readdirSync(f.lockDir),[]);
});
test('#1215 characterization control: ADMISSION-phase EPERM on openSync of a LIVE peer number that the re-list still shows (no marker) fails closed and the ticket is retained',t=>{
 const f=admissionFixture(t),open=fs.openSync,body=fs.readFileSync(f.number,'utf8');
 t.mock.method(fs,'openSync',function(p,...rest){if(p===f.number&&f.seam.phase==='admission'&&f.seam.stage==='armed'){f.seam.stage='refused_open';throw f.epermOpen(p);}return open.call(fs,p,...rest);});
 const before=lockCounts();let refused;
 try{
  try{f.acquireLock(f.dir);}catch(e){refused=e;}
  const counters=lockDelta(before),evidence=JSON.stringify({phase:f.seam.phase,stage:f.seam.stage,code:refused?.code??null,syscall:refused?.syscall??null,counters});
  assert.deepEqual([refused?.code,refused?.syscall],['EPERM','open'],`the original read-site EPERM is rethrown, not substituted: ${evidence}`);
  assert.deepEqual([f.seam.phase,f.seam.stage],['admission','refused_open'],evidence);
  assert.equal(counters.eperm_read_throw,1,evidence);
  assert.equal(counters.eperm_read_number_gone??0,0,`never classified as a departure: ${evidence}`); // null where the counter does not exist (8a)
  assert.ok(counters.read_throw_number_listed===null||counters.read_throw_number_listed===1,`still-listed classification (lock10 only): ${evidence}`);
  assert.deepEqual(fs.readdirSync(f.lockDir),[f.name],'the live holder ticket is retained; the refused acquirer removed its own');
  assert.deepEqual(fs.readdirSync(f.ticket),['number']);assert.equal(fs.readFileSync(f.number,'utf8'),body);
 }finally{f.release();}
 assert.deepEqual(fs.readdirSync(f.lockDir),[]);
});
