'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createCredentialStore}=require('../src/session-store/session-credentials');
const {createSessionRecordContext,registerSessionRegisterRoute}=require('../src/routes/session-records');
function fixture(t,existing){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'handoff-adoption-cas-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const sessions=Object.create(null),credentials=createCredentialStore(),issued=credentials.issue('fixture');let registrations=0,handler;
 if(existing)sessions.fixture={id:'fixture',type:'wrapped',command:'original',sessionEpoch:issued.epoch,credentialVerifier:issued.verifier,credentialGeneration:issued.generation,requireOwnerProof:true,clients:new Set()};
 else credentials.revoke('fixture');
 const context=createSessionRecordContext({sessions,sessionCredentials:credentials,sidNonces:new Map(),sessionPersistPath:path.join(home,'sessions.json')});
 registerSessionRegisterRoute({post:(_path,fn)=>{handler=fn;}},{context,sessionStateManager:{register:()=>registrations++},busClients:new Set(),getMailbox:()=>{throw Error('No mailbox initialization permitted in this fixture');}});
 const request=body=>{const response={statusCode:200,status(code){this.statusCode=code;return this;},json(value){this.body=value;return this;}};handler({body,headers:{'x-telepty-session-token':issued.bearer}},response);return response;};
 return{sessions,credentials,issued,request,registrations:()=>registrations,home};
}
test('explicit adoption of an absent SID refuses before credential or namespace creation',t=>{
 const f=fixture(t,false),r=f.request({session_id:'fixture',expected_epoch:f.issued.epoch,expected_credential_generation:1});
 assert.equal(r.statusCode,409);assert.equal(r.body.code,'REGISTRATION_INSTANCE_CHANGED');assert.deepEqual(Object.keys(f.sessions),[]);assert.equal(f.credentials.size(),0);assert.equal(f.registrations(),0);assert.equal(fs.existsSync(path.join(f.home,'sessions.json')),false);
});
test('stale adoption epoch or generation cannot update the current instance',t=>{
 for(const stale of ['epoch','generation']){const f=fixture(t,true),record=f.sessions.fixture;const r=f.request({session_id:'fixture',command:'replacement',expected_epoch:stale==='epoch'?'x'.repeat(22):f.issued.epoch,expected_credential_generation:stale==='generation'?2:1});
 assert.equal(r.statusCode,409,stale);assert.equal(r.body.code,'REGISTRATION_INSTANCE_CHANGED');assert.equal(record.command,'original');assert.equal(f.sessions.fixture,record);assert.ok(f.credentials.verify(f.issued.bearer));assert.equal(f.registrations(),0);}
});
test('matching adoption reports the applied precondition without minting new credentials',t=>{
 const f=fixture(t,true),r=f.request({session_id:'fixture',command:'successor',expected_epoch:f.issued.epoch,expected_credential_generation:1});
 assert.equal(r.statusCode,200);assert.equal(r.body.registration_instance_matched,true);assert.equal(r.body.credential_generation,1);assert.equal(r.body.session_epoch,f.issued.epoch);assert.equal(r.body.session_token,undefined);assert.equal(f.sessions.fixture.command,'successor');assert.ok(f.credentials.verify(f.issued.bearer));
});
test('partial or malformed adoption preconditions refuse instead of falling back to create',t=>{
 for(const conditions of [{expected_epoch:'x'.repeat(22)},{expected_credential_generation:1},{expected_epoch:'bad',expected_credential_generation:1},{expected_epoch:'x'.repeat(22),expected_credential_generation:0}]){const f=fixture(t,false),r=f.request({session_id:'fixture',...conditions});assert.equal(r.statusCode,400);assert.equal(r.body.code,'REGISTRATION_PRECONDITION_INVALID');assert.deepEqual(Object.keys(f.sessions),[]);assert.equal(f.credentials.size(),0);}
});
test('ordinary registration without an adoption precondition retains create behavior',t=>{
 const f=fixture(t,false),r=f.request({session_id:'fixture',command:'normal'});assert.equal(r.statusCode,201);assert.equal(typeof r.body.session_token,'string');assert.equal(f.registrations(),1);
});
