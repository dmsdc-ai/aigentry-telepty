#!/usr/bin/env node
'use strict';
const args=process.argv.slice(2);
if(args.length!==2 || args[0]!=='--root' || !require('node:path').isAbsolute(args[1])) {
  console.error('Usage: node scripts/mailbox-preflight.js --root /absolute/mailbox/root (read-only; never authorizes migration)');
  process.exitCode=2;
} else {
  try {
    const report=require('../src/mailbox/compatibility').inspectMailboxCompatibility(args[1]);
    console.log(JSON.stringify(report,null,2));
    if(!report.complete)process.exitCode=1;
  } catch {
    console.error('Mailbox compatibility inspection refused: root is unavailable or unsafe; no migration performed.');
    process.exitCode=1;
  }
}
