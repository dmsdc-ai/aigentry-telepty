'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {createViewerInputAuthorization,dispatchViewerInput}=require('../src/audit/viewer-input');
function fixture(block=false){
 const rows=[],classified=[],broadcast=[];
 const authorize=createViewerInputAuthorization({classify:value=>{classified.push(value);return{decision:block?'block':'allow',reason:'fixture'};},audit:row=>rows.push(row),broadcast:(...args)=>broadcast.push(args),
  verifiedSenderFields:()=>({verified_sender_sid:'sender',verified_sender_epoch:'epoch',verified_sender_generation:2}),machineId:'fixture',orchestratorSids:['orchestrator'],randomUUID:()=> 'inject-id',warn:()=>{}});
 return{rows,classified,broadcast,authorization:authorize({sessionId:'target',session:{},data:'exact bytes\r',claimedFrom:'claimed',principal:{}})};
}
test('viewer audit distinguishes admission from asynchronous failed or successful dispatch',()=>{
 for(const failure of [true,false]){
  const f=fixture();let done,invalidated=0,refused=0;
  dispatchViewerInput({authorization:f.authorization,invalidate:()=>invalidated++,deliver:callback=>{done=callback;},onFailure:()=>refused++});
  assert.equal(f.rows.length,1);assert.equal(f.rows[0].source,'ws-viewer-admission');assert.equal(f.rows[0].delivery_result,'authorized');
  done(failure?new Error('possibly partial'):undefined);done();assert.equal(f.rows.length,2);assert.equal(f.rows[1].source,'ws-viewer');assert.equal(f.rows[1].delivery_result,failure?'outcome_unknown':'forwarded');
  assert.equal(f.rows[1].payload,f.classified[0].prompt);assert.equal(f.rows[1].payload,'exact bytes\r');assert.equal(f.rows[1].inject_id,f.rows[0].inject_id);assert.equal(invalidated,1);assert.equal(refused,failure?1:0);
 }
});
test('synchronous writer failure remains unknown; blocked authorization never attempts a write',()=>{
 const f=fixture();dispatchViewerInput({authorization:f.authorization,invalidate:()=>{},deliver:()=>{throw Error('writer failed after possible effect');}});assert.equal(f.rows[1].delivery_result,'outcome_unknown');
 const denied=fixture(true);let writes=0;assert.equal(dispatchViewerInput({authorization:denied.authorization,invalidate:()=>writes++,deliver:()=>writes++}),false);assert.equal(writes,0);assert.equal(denied.rows.length,1);assert.equal(denied.rows[0].delivery_result,'blocked:fixture');
});
test('attach refusal messages expose byte limits and uncertainty without printing server payload or claiming safe retry',()=>{
 const {viewerInputRefusal}=require('../src/cli/viewer-input');
 assert.equal(viewerInputRefusal({type:'input_refused',code:'INPUT_FRAME_TOO_LARGE',bytes_written:0}),'Input was refused: text exceeds 64 KiB.');
 assert.equal(viewerInputRefusal({type:'input_refused',code:'INPUT_WRITE_OUTCOME_UNKNOWN',bytes_written:null}),'Input outcome is unknown. Check the receiver before retrying.');
 assert.equal(viewerInputRefusal({type:'input_refused',code:'EXTERNAL_APPROVAL_REQUIRED'}),'Input was refused: external approval is required.');
 assert.equal(viewerInputRefusal({type:'input_refused',error:'PRIVATE\x1b[2J',code:'PRIVATE'}),'Input was refused.');
 assert.equal(viewerInputRefusal({type:'output',data:'terminal output'}),'');
});
