'use strict';
// Diagnostic for a known legacy lock defect. Always creates/removes its own temp
// tree; accepts no target path and never inspects a live mailbox or service.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {acquireLock,breakStaleLocks,ensureSessionDir}=require('../src/mailbox/storage');
if(process.argv.length!==2)throw Error('This diagnostic accepts no arguments');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'telepty-lock-aba-repro-'));
try {
 const dir=ensureSessionDir(root,'fixture'),file=path.join(dir,'.lock');
 const releaseFirst=acquireLock(dir),old=new Date(Date.now()-70000);fs.utimesSync(file,old,old);
 const broken=breakStaleLocks(root),releaseSuccessor=acquireLock(dir);releaseFirst();
 const survived=fs.existsSync(file);releaseSuccessor();
 console.log(JSON.stringify({diagnostic:'legacy-mailbox-lock-aba',aged_live_lock_broken:broken===1,
  successor_survived_old_release:survived,known_defect_reproduced:broken===1&&!survived}));
} finally {fs.rmSync(root,{recursive:true,force:true});}
