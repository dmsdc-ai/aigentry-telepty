'use strict';
const crypto = require('node:crypto');
const { readSessionCredential } = require('../src/session-credential-channel');
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
let last = -1;
function observe() {
  if (!process.env.TELEPTY_SESSION_CREDENTIAL_PATH) {
    if (last === -1) console.log('CREDENTIAL_WITNESS ' + JSON.stringify({ enabled: false, pid: process.pid }));
    last = 0;
    return;
  }
  try {
    const record = readSessionCredential();
    if (record.wrapper_pid !== process.ppid) throw new Error('wrong wrapper');
    if (record.sequence === last) return;
    last = record.sequence;
    // This fixture never prints a record or a bearer. Hashes permit comparison
    // with the test daemon's durable verifier without disclosing credentials.
    console.log('CREDENTIAL_WITNESS ' + JSON.stringify({ enabled: true, sequence: record.sequence,
      epoch: record.session_epoch, generation: record.credential_generation,
      verifier: hash(record.session_token), handle: hash(process.env.TELEPTY_SESSION_CREDENTIAL_PATH),
      instance: record.wrapper_instance, wrapper: record.wrapper_pid, pid: process.pid,
      ambientMatches: hash(process.env.TELEPTY_SESSION_TOKEN) === hash(record.session_token) }));
  } catch { console.log('CREDENTIAL_WITNESS_ERROR'); process.exitCode = 1; process.exit(); }
}
observe();
const timer = setInterval(observe, 100);
process.stdin.on('data', data => { if (String(data).includes('EXIT')) { clearInterval(timer); process.exit(0); } });
