'use strict';
// A strict, bounded read used only at an explicit authority transfer. Normal delivery retains
// its existing tolerant readers; a custody receipt must not turn corruption into an empty queue.
const fs = require('node:fs');
const path = require('node:path');
const { openFile } = require('./path-boundary');
const { parseUnambiguousJSON } = require('../principal/encoding');
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 20000;
function invalid() { throw Object.assign(new Error('Mailbox custody is unavailable'), { code: 'MAILBOX_CUSTODY_UNAVAILABLE' }); }
function readStrict(file) {
  const fd = openFile(file, fs.constants.O_RDONLY);
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size > MAX_FILE_BYTES) invalid();
    const bytes = Buffer.alloc(stat.size + 1);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const after = fs.fstatSync(fd);
    if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) invalid();
    const text = bytes.subarray(0, count).toString('utf8');
    if (!Buffer.from(text).equals(bytes.subarray(0, count)) || (text && !text.endsWith('\n'))) invalid();
    const lines = text.split('\n').filter(line => line.trim());
    if (lines.length > MAX_ROWS) invalid();
    return lines.map(line => parseUnambiguousJSON(line));
  } finally { fs.closeSync(fd); }
}
function boundedId(value) { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 128 && !/[\x00-\x1f\x7f]/.test(value); }
function strictCustodySnapshot(directory, sessionId) {
  // Both files must exist, even for an initialized empty queue. A missing component cannot
  // establish that a queue was empty rather than partly lost or never initialized.
  const inbox = readStrict(path.join(directory, 'inbox.jsonl'));
  const journal = readStrict(path.join(directory, 'state.jsonl'));
  const messages = new Map(), states = new Map();
  for (const row of inbox) {
    if (!row || !boundedId(row.msg_id) || row.to !== sessionId || typeof row.payload !== 'string'
        || !Number.isSafeInteger(row.created_at) || row.created_at < 0
        || (row.from != null && (typeof row.from !== 'string' || Buffer.byteLength(row.from) > 512))
        || !Number.isSafeInteger(row.attempt) || row.attempt < 0
        || Object.keys(row).some(key => !['msg_id', 'to', 'from', 'payload', 'created_at', 'attempt'].includes(key))) invalid();
    const previous = messages.get(row.msg_id);
    if (previous && (previous.payload !== row.payload || previous.from !== row.from || previous.created_at !== row.created_at)) invalid();
    if (!previous || row.attempt >= previous.attempt) messages.set(row.msg_id, row);
  }
  for (const row of journal) {
    if (!row || !boundedId(row.msg_id) || !['pending', 'in_flight', 'acked', 'nacked', 'expired', 'dead_letter'].includes(row.state)
        || !Number.isSafeInteger(row.ts) || row.ts < 0 || !messages.has(row.msg_id)
        || Object.keys(row).some(key => !['msg_id', 'state', 'ts', 'attempt'].includes(key))) invalid();
    states.set(row.msg_id, row);
  }
  const pending = [];
  for (const [id, message] of messages) {
    const state = states.get(id);
    if (!state || state.state === 'nacked') invalid();
    if (['pending', 'in_flight'].includes(state.state)) pending.push({ msg_id: id, from: message.from || null,
      created_at: message.created_at, state: state.state, attempt: message.attempt });
  }
  return pending;
}
module.exports = { strictCustodySnapshot, MAX_FILE_BYTES, MAX_ROWS };
