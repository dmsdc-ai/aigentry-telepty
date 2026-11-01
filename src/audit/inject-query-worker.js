'use strict';
// Fixed worker entry point. File identity/budgets come only from the daemon-owned reader.
const fs = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');
const { matchInjects } = require('./inject-log');

function failure(code, reason) { return { ok: false, code, reason }; }
function query() {
  const { path, filters, budgets } = workerData;
  let fd;
  try {
    try { fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
    catch (error) {
      return error.code === 'ENOENT' ? { ok: true, json: '{"injects":[],"next_cursor":null}' }
        : failure('AUDIT_QUERY_UNAVAILABLE', 'file_unavailable');
    }
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return failure('AUDIT_QUERY_UNAVAILABLE', 'not_regular_file');
    if (stat.size > budgets.fileBytes) return failure('AUDIT_QUERY_BUDGET_EXCEEDED', 'file_bytes');
    const limit = Math.min(Math.max(Number(filters.limit) || 200, 1), 1000);
    const cursor = Number(filters.cursor) > 0 ? Number(filters.cursor) : 0;
    // Match Array.slice's scalar coercion, including fractional legacy cursors/limits.
    const start = Math.trunc(cursor), end = Math.trunc(cursor + limit);
    if (!Number.isFinite(cursor)) return { ok: true, json: '{"injects":[],"next_cursor":null}' };
    const page = []; let matched = 0, replyBytes = 64, next = null, done = false;
    let position = stat.size, carry = Buffer.alloc(0);
    const buffer = Buffer.allocUnsafe(budgets.chunkBytes);
    function row(bytes) {
      if (bytes.length > budgets.lineBytes) throw Object.assign(new Error(), { budget: 'line_bytes' });
      if (!bytes.length) return;
      let record;
      try { record = JSON.parse(bytes.toString('utf8')); } catch { return; }
      if (!record || !matchInjects([record], filters).length) return;
      const index = matched++;
      if (index >= start && index < end) {
        // All JSON serialization stays off the request thread as well as parsing/filtering.
        const encoded = JSON.stringify(record);
        replyBytes += Buffer.byteLength(encoded) + 1;
        if (replyBytes > budgets.replyBytes) throw Object.assign(new Error(), { budget: 'reply_bytes' });
        page.push(encoded);
      }
      if (matched > cursor + limit) { next = cursor + limit; done = true; }
    }
    while (position > 0 && !done) {
      const size = Math.min(buffer.length, position); position -= size;
      const read = fs.readSync(fd, buffer, 0, size, position);
      if (read !== size) return failure('AUDIT_QUERY_UNAVAILABLE', 'file_changed_during_read');
      const bytes = Buffer.concat([buffer.subarray(0, read), carry]);
      let endAt = bytes.length;
      for (let i = bytes.length - 1; i >= 0; i--) {
        if (bytes[i] !== 10) continue;
        row(bytes.subarray(i + 1, endAt)); endAt = i;
        if (done) break;
      }
      if (!done) {
        if (endAt > budgets.lineBytes) return failure('AUDIT_QUERY_BUDGET_EXCEEDED', 'line_bytes');
        carry = bytes.subarray(0, endAt);
      }
    }
    if (!done) row(carry);
    const json = `{"injects":[${page.join(',')}],"next_cursor":${next === null ? 'null' : JSON.stringify(next)}}`;
    if (Buffer.byteLength(json) > budgets.replyBytes) return failure('AUDIT_QUERY_BUDGET_EXCEEDED', 'reply_bytes');
    return { ok: true, json };
  } catch (error) {
    return error.budget ? failure('AUDIT_QUERY_BUDGET_EXCEEDED', error.budget)
      : failure('AUDIT_QUERY_UNAVAILABLE', 'read_failed');
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}
parentPort.postMessage(query());
