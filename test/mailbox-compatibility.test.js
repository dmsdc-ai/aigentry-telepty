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
