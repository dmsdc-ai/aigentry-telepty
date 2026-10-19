'use strict';
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const expectedOperations = ["import-runtime","import-completion","factory","setup-original-1","original-1","setup-original-2","original-2","setup-original-3","original-3","setup-original-4","original-4","setup-own-setters","own-setters","setup-inherited-setters","inherited-setters","setup-first-throws","first-throws","setup-second-throws","second-throws","setup-inherited-fixed","inherited-fixed","setup-inherited-writable","inherited-writable","setup-default-time","default-time","setup-null","null","setup-primitive","primitive"];
const expectedCases = ["original-1","original-2","original-3","original-4","own-setters","inherited-setters","first-throws","second-throws","inherited-fixed","inherited-writable","default-time","null","primitive"];
// Real assignment helper only; no persistence, timer, process or full lifecycle execution.
nodeTest('disconnect-compatibility-681', { concurrency: false }, async t => {
  let opCount = 0;
  function step(id, fn) {
    assert.equal(expectedOperations[opCount], id);
    assert.ok(++opCount <= expectedOperations.length);
    return fn();
  }
  const events=[];
  const {createDeliveryRuntime}=step('import-runtime',()=>require('../src/mailbox/delivery-runtime'));
  const completion=step('import-completion',()=>require('../src/completion-observation'));
  const runtime=step('factory',()=>createDeliveryRuntime({CAPABILITY_STAGE_A:completion.CAPABILITY_STAGE_A}));
    const stamp='2026-01-01T00:00:00.000Z';
    const exercised=[];
    async function exercise(id,make,check,omit=false){
      assert.equal(expectedCases[exercised.length], id);
      await t.test('disconnect / ' + id, { concurrency: false }, () => {
        let record;
        step('setup-'+id,()=>{events.length=0;record=make();});
        const start=Date.now();let error=null,returned;
        step(id,()=>{
          try{returned=omit?runtime.markSessionDisconnected(record):runtime.markSessionDisconnected(record,stamp);}
          catch(e){error=e;}
          const end=Date.now();
          check(record,error,start,end);
          if(!error)assert.equal(returned,undefined);
        });
        exercised.push(id);
      });
    }
    await exercise('original-1',()=>({id:'ordinary',ready:true}),(r,e)=>{assert.equal(e,null);assert.deepEqual(r,{id:'ordinary',ready:false,lastDisconnectedAt:stamp});});
    await exercise('original-2',()=>Object.freeze({id:'frozen',lastDisconnectedAt:'before',ready:true}),(r,e)=>{assert.equal(e,null);assert.deepEqual(r,{id:'frozen',lastDisconnectedAt:'before',ready:true});});
    await exercise('original-3',()=>{const r={id:'fixed',ready:true};Object.defineProperty(r,'lastDisconnectedAt',{value:'before',enumerable:true,writable:false});return r;},
      (r,e)=>{assert.equal(e,null);assert.equal(r.lastDisconnectedAt,'before');assert.equal(r.ready,false);});
    await exercise('original-4',()=>Object.preventExtensions({id:'nonextensible',lastDisconnectedAt:'before'}),
      (r,e)=>{assert.equal(e,null);assert.equal(r.lastDisconnectedAt,stamp);assert.equal(Object.hasOwn(r,'ready'),false);});
    let receiver;
    function setterRecord(inherited=false){
      const descriptors={};
      for(const key of ['lastDisconnectedAt','ready'])descriptors[key]={configurable:true,enumerable:true,set(value){events.push({key,value,receiver:this===receiver});}};
      const owner=Object.defineProperties({},descriptors);
      receiver=inherited?Object.create(owner):owner;return receiver;
    }
    const checkSetters=(r,e)=>{assert.equal(e,null);assert.deepEqual(events,[{key:'lastDisconnectedAt',value:stamp,receiver:true},{key:'ready',value:false,receiver:true}]);};
    await exercise('own-setters',()=>setterRecord(),checkSetters);
    await exercise('inherited-setters',()=>setterRecord(true),checkSetters);
    const firstError=new Error('first setter deliberate'),secondError=new Error('second setter deliberate');
    await exercise('first-throws',()=>{receiver={set lastDisconnectedAt(v){events.push({key:'first',value:v,receiver:this===receiver});throw firstError;},set ready(v){events.push({key:'second',value:v});}};return receiver;},
      (r,e)=>{assert.equal(e,firstError);assert.deepEqual(events,[{key:'first',value:stamp,receiver:true}]);});
    await exercise('second-throws',()=>{receiver={lastDisconnectedAt:'before',set ready(v){events.push({key:'ready',value:v,receiver:this===receiver});throw secondError;}};return receiver;},
      (r,e)=>{assert.equal(e,secondError);assert.equal(r.lastDisconnectedAt,stamp);assert.deepEqual(events,[{key:'ready',value:false,receiver:true}]);});
    await exercise('inherited-fixed',()=>{const p=Object.defineProperty({},'lastDisconnectedAt',{value:'before',writable:false});return Object.assign(Object.create(p),{ready:true});},
      (r,e)=>{assert.equal(e,null);assert.equal(r.lastDisconnectedAt,'before');assert.equal(Object.hasOwn(r,'lastDisconnectedAt'),false);assert.equal(r.ready,false);});
    let parent;
    await exercise('inherited-writable',()=>{parent={lastDisconnectedAt:'before',ready:true};return Object.create(parent);},
      (r,e)=>{assert.equal(e,null);assert.deepEqual(parent,{lastDisconnectedAt:'before',ready:true});assert.deepEqual(Object.keys(r),['lastDisconnectedAt','ready']);assert.equal(r.lastDisconnectedAt,stamp);assert.equal(r.ready,false);});
    await exercise('default-time',()=>({ready:true}),(r,e,start,end)=>{assert.equal(e,null);const ms=Date.parse(r.lastDisconnectedAt);assert.ok(ms>=start&&ms<=end);assert.equal(r.ready,false);},true);
    await exercise('null',()=>null,(r,e)=>assert.ok(e instanceof TypeError));
    await exercise('primitive',()=>7,(r,e)=>assert.ok(e instanceof TypeError));
    assert.equal(opCount,29);
    assert.deepEqual(exercised, expectedCases);
});
