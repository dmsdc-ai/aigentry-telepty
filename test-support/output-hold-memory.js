'use strict';
const {createOutputHold}=require('../src/cli/output-hold');
if(typeof global.gc!=='function')throw new Error('GC fixture requires --expose-gc');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function collect(){for(let i=0;i<4;i++){await settle();global.gc();}}
(async()=>{
 await collect();const before=process.memoryUsage().heapUsed;
 const mode=process.argv[2] || 'oversized';
 const held=createOutputHold(mode==='consume'?{maxChars:32*1024*1024}:{});
 function source(){
   const input=Buffer.alloc(32*1024*1024,120).toString('utf8');
   held.push(mode==='borrowed'?input.slice(-256*1024):input);
   if(mode==='consume')held.consume(input.length-256*1024);
 }
 source();await collect();const retained=process.memoryUsage().heapUsed-before;
 const length=held.length;held.clear();await collect();
 console.log(JSON.stringify({retained,length,released:process.memoryUsage().heapUsed-before}));
})().catch(()=>{process.exitCode=1;});
