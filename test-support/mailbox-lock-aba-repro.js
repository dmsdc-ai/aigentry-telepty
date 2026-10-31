'use strict';
// Regression diagnostic for the repaired legacy lock defect. Always creates/removes its own temp
// tree; accepts no target path and never inspects a live mailbox or service.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {acquireLock,breakStaleLocks,ensureSessionDir}=require('../src/mailbox/storage');
if(process.argv.length!==2)throw Error('This diagnostic accepts no arguments');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'telepty-lock-aba-repro-'));
try {
 const dir=ensureSessionDir(root,'fixture'),file=path.join(dir,'.lock');
 const releaseFirst=acquireLock(dir),old=new Date(Date.now()-70000);fs.utimesSync(file,old,old);
 const broken=breakStaleLocks(root);
 if(broken!==0)throw Error('A live owner was reaped');
 let refused=false;try{acquireLock(dir);}catch(error){if(error.code==='MAILBOX_LOCK_TIMEOUT')refused=true;else throw error;}
 if(!refused)throw Error('A live lock was bypassed');
 releaseFirst();const releaseSuccessor=acquireLock(dir);releaseFirst();
 let successorHeld=false;try{acquireLock(dir);}catch(error){if(error.code==='MAILBOX_LOCK_TIMEOUT')successorHeld=true;else throw error;}
 releaseSuccessor();if(!successorHeld)throw Error('Old release removed successor');
 console.log(JSON.stringify({diagnostic:'mailbox-lock-aba-regression',aged_live_lock_broken:false,
  successor_survived_old_release:successorHeld,known_defect_reproduced:false}));
} finally {fs.rmSync(root,{recursive:true,force:true});}
