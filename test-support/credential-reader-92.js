'use strict';
const { readSessionCredential } = require('../src/session-credential-channel');
// The harness strips ambient session ids; this isolated fixture deliberately
// supplies its synthetic identity while preserving its spawn-time path handle.
process.on('message', message => {
  if (message.exit) return process.exit(0);
  try {
    const record = readSessionCredential({ sessionId: 'fixture' });
    process.send({ matches: record.session_epoch === message.epoch, sequence: record.sequence, environmentUnchanged: process.env.TELEPTY_SESSION_TOKEN?.split('.')[0] === message.initialEpoch });
  } catch { process.send({ matches: false }); }
});
