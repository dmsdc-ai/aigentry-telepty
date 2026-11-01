'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {createOutputHold}=require('../src/cli/output-hold');
test('held output bounds a single oversize callback and preserves complete Unicode pairs',()=>{
 const held=createOutputHold({maxChars:8,maxChunks:3});held.push('earlier');held.push('x'.repeat(1000)+'😀abcdefg');
 assert.equal(held.snapshot(),'abcdefg');assert.equal(held.length,7);assert.ok(held.chunks<=3);
 held.clear();held.push('x'.repeat(1000)+'😀abcdef');assert.equal(held.snapshot(),'😀abcdef');assert.equal(held.length,8);
});
test('held output ignores empty callbacks and bounds chunk metadata while retaining newest output',()=>{
 const held=createOutputHold({maxChars:100,maxChunks:3});for(let i=0;i<100000;i++)held.push('');assert.equal(held.chunks,0);
 for(const data of ['one','two','three','four'])held.push(data);assert.equal(held.snapshot(),'twothreefour');assert.equal(held.chunks,3);
});
test('partial send consumes only its prefix and future suffix remains ordered and bounded',()=>{
 const held=createOutputHold({maxChars:12,maxChunks:4});held.push('abcdefgh');held.push('ijklmnop');assert.equal(held.snapshot(),'efghijklmnop');
 held.consume(5);assert.equal(held.snapshot(),'jklmnop');held.push('QRST');assert.equal(held.snapshot(),'jklmnopQRST');
 held.consume(held.length);assert.equal(held.snapshot(),'');assert.equal(held.chunks,0);
});
test('production defaults cap retained text and metadata with recent bytes intact',()=>{
 const held=createOutputHold();held.push('old');held.push('x'.repeat(1024*1024)+'RECENT');assert.equal(held.length,256*1024);assert.ok(held.snapshot().endsWith('RECENT'));
 held.clear();for(let i=0;i<2000;i++)held.push('x');assert.equal(held.chunks,1024);assert.equal(held.length,1024);
});
test('overflow at a surrogate pair split across callbacks retains no dangling low surrogate',()=>{
 const held=createOutputHold({maxChars:3,maxChunks:4});held.push('ab\uD83D');held.push('\uDE00cd');assert.equal(held.snapshot(),'cd');
 assert.throws(()=>held.consume(3),/Invalid output hold prefix/);assert.equal(held.snapshot(),'cd');
});
for(const mode of ['oversized','borrowed','consume'])test(`retained ${mode} output owns bounded backing storage`,()=>{
 const {spawnSync}=require('node:child_process'),path=require('node:path');
 const result=spawnSync(process.execPath,['--require',path.resolve(__dirname,'../test-support/setup-env.js'),'--expose-gc',path.resolve(__dirname,'../test-support/output-hold-memory.js'),mode],{encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr);const memory=JSON.parse(result.stdout.trim());assert.equal(memory.length,256*1024);
 // A32MiB input must not survive behind a256Ki-unit suffix. Allow8MiB for V8/GC noise.
 assert.ok(memory.retained<8*1024*1024,JSON.stringify(memory));
});
test('owned copies preserve exact UTF16 code units including lone surrogates',()=>{
 const held=createOutputHold();const input='\uD800x\uDC00';held.push(input);assert.equal(held.snapshot(),input);held.consume(1);assert.equal(held.snapshot(),'x\uDC00');
});
