'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {EventEmitter}=require('node:events');
const {installWebSocketTransport}=require('../src/transport/websocket');
function fixture(t) {
 const sent=[],authorized=[],replies=[];let writes=0;
 const owner={readyState:1,send:frame=>{writes++;sent.push(JSON.parse(frame));}};
 const session={id:'fixture',type:'wrapped',clients:new Set(),ownerWs:owner,outputRing:[]};const sessions={fixture:session};
 const transport=installWebSocketTransport({server:new EventEmitter(),sessions,busClients:new Set(),expectedToken:'synthetic',verifyJwt:()=>false,isAllowedPeer:()=>true,credentials:{hasCredential:()=>true,matches:()=>false},pendingReports:{},authorizeViewerInject:({data,principal})=>{authorized.push({data,principal});return true;}});
 const ws=new EventEmitter();ws.readyState=1;ws.send=frame=>replies.push(JSON.parse(frame));ws.close=()=>ws.emit('close');ws.terminate=ws.close;
 transport.wss.emit('connection',ws,{url:'/api/sessions/fixture',headers:{host:'127.0.0.1'},socket:{remoteAddress:'127.0.0.1'}});t.after(()=>ws.emit('close'));
 return {sent,authorized,replies,session,sessions,input:data=>ws.emit('message',JSON.stringify({type:'input',data})),writes:()=>writes};
}
test('malformed raw viewer input never reaches policy/audit or physical writer',t=>{
 const f=fixture(t);
 for(const data of [undefined,null,{},[],42,true])f.input(data);
 assert.equal(f.authorized.length,0);assert.equal(f.writes(),0);assert.equal(f.replies.length,6);
 assert.ok(f.replies.every(r=>r.type==='input_refused'&&r.bytes_written===0&&r.code==='INVALID_INPUT_FRAME'));
});
test('raw viewer payload uses a64KiB UTF8 ceiling before policy, preserving exact accepted bytes',t=>{
 const f=fixture(t),boundary='中'.repeat(21845)+'x';assert.equal(Buffer.byteLength(boundary),65536);
 f.input(boundary);assert.equal(f.authorized[0].data,boundary);assert.equal(f.sent[0].data,boundary);
 f.input(boundary+'x');assert.equal(f.authorized.length,1);assert.equal(f.writes(),1);assert.equal(f.replies.at(-1).code,'INPUT_FRAME_TOO_LARGE');
 f.input('');assert.equal(f.authorized.at(-1).data,'');assert.equal(f.sent.at(-1).data,'');
});
