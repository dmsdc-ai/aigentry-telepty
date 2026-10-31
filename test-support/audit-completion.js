'use strict';

// Task 1215 audit44 (#879, root disposition D1) — audit COMPLETION observation for an already-accepted request.
//
// Contract (docs/specs/2026-06-09-inject-audit-provenance.md §8): the audit log is asynchronous and off the delivery hot
// path, FIFO, no fsync, with NO visibility-latency promise. A fixed visibility wait (the former 4000/5000 ms) is therefore not
// the contract. What the daemon does expose is a completion fact, the /api/meta `audit_writer` counters:
//   - every exercised route appends its audit line(s) before it responds (src/routes/session-actions.js:1592 before :1684;
//     src/routes/fanout.js:102/:109/:121/:125 before :129), and append counts synchronously (src/audit/inject-log.js:145-159);
//   - the writer drains its queue in FIFO batches and adds to `written_lines` only after appendFile resolves (:175-207);
//     a failed batch adds to `errors`, an overflow adds to `dropped`, and a closed writer counts nothing more.
// So for a counter read taken AFTER the response, `written_lines >= appended` (the watermark), with no new error/drop since
// a read taken BEFORE the request and the writer still open, means every line this request appended has been written.
// A new error or drop, or a closed writer, may concern this request's own line, so each FAILS; none is ever treated as
// complete. A completed write whose row is then absent also FAILS.
//
// Bounds: the caller's case signal (node:test `t.signal`; the case declares `{ timeout: 60000 }`) is the only deadline. There is
// no wait before the first observation, at most one meta request in flight (sequential, signal-bound), and an abort-aware pause
// between observations. Diagnostics are counters only (no payload, path or token).

const { setTimeout: pause } = require('node:timers/promises');

const POLL_MS = 50;
const COUNTERS = ['appended', 'written_lines', 'errors', 'dropped'];

class AuditCompletionError extends Error {
  constructor(reason, detail) {
    super(`audit completion ${reason} ${JSON.stringify(detail)}`);
    this.name = 'AuditCompletionError';
    this.code = `AUDIT_COMPLETION_${reason.toUpperCase()}`;
    this.reason = reason;
    this.detail = detail;
  }
}

// The validated, payload-free subset of an /api/meta `audit_writer` object, or null when it is not one.
function counters(status) {
  if (!status || typeof status !== 'object') return null;
  for (const key of COUNTERS) if (!Number.isSafeInteger(status[key]) || status[key] < 0) return null;
  if (typeof status.closed !== 'boolean') return null;
  return { appended: status.appended, written_lines: status.written_lines, errors: status.errors, dropped: status.dropped,
    closed: status.closed, writing_stage: typeof status.writing_stage === 'string' ? status.writing_stage.slice(0, 16) : null,
    writing_for_ms: Number.isSafeInteger(status.writing_for_ms) ? status.writing_for_ms : null };
}

// Pure classification of ONE observation against the before-request baseline and the after-response watermark.
function classify(before, watermark, status) {
  const s = counters(status);
  if (!s) return { state: 'failed', reason: 'meta_invalid', s: null };
  if (s.closed) return { state: 'failed', reason: 'writer_closed', s };
  if (s.errors > before.errors) return { state: 'failed', reason: 'writer_error', s };
  if (s.dropped > before.dropped) return { state: 'failed', reason: 'writer_dropped', s };
  if (s.written_lines >= watermark) return { state: 'complete', s };
  return { state: 'pending', s };
}

// One signal-bound /api/meta read of a test-support/daemon-harness.js daemon (harness.request forwards no signal, and the
// harness is not modified here). Same auth header as harness.request.
function daemonAuditObserver(daemon) {
  return async (signal) => {
    const response = await fetch(`http://${daemon.host}:${daemon.port}/api/meta`, { headers: { 'x-telepty-token': daemon.authToken() }, signal });
    if (response.status !== 200) {
      try { await response.body?.cancel(); } catch { /* released either way */ }
      throw Object.assign(new Error(`meta status ${response.status}`), { code: `HTTP_${response.status}` });
    }
    const body = await response.json();
    return body ? body.audit_writer : undefined;
  };
}

// Take the before-request baseline. Call it BEFORE sending the request whose audit line is awaited.
async function beginAuditCompletion(daemon, signal, options = {}) {
  const observe = options.observe || daemonAuditObserver(daemon);
  const pollMs = Number.isSafeInteger(options.pollMs) && options.pollMs >= 0 ? options.pollMs : POLL_MS;
  const sleep = options.sleep || ((ms, sig) => pause(ms, undefined, { signal: sig }));
  if (!signal || typeof signal.aborted !== 'boolean') throw new TypeError('beginAuditCompletion requires the case AbortSignal');
  if (signal.aborted) throw new AuditCompletionError('aborted', { phase: 'before' });
  let status;
  try { status = await observe(signal); }
  catch (error) {
    if (signal.aborted) throw new AuditCompletionError('aborted', { phase: 'before' });
    throw new AuditCompletionError('meta_unavailable', { phase: 'before', error_code: String((error && error.code) || 'error').slice(0, 32) });
  }
  const before = counters(status);
  if (!before) throw new AuditCompletionError('meta_invalid', { phase: 'before' });
  if (before.closed) throw new AuditCompletionError('writer_closed', { phase: 'before', before });

  // Observe until a terminal writer state. The first observation after the accepted response sets the watermark.
  async function settled() {
    let watermark = null, observations = 0, last = null;
    const fail = (reason, extra = {}) => new AuditCompletionError(reason, { phase: 'settle', observations, watermark, before, last, ...extra });
    for (;;) {
      if (signal.aborted) throw fail('aborted');
      let observed;
      try { observed = await observe(signal); }
      catch (error) {
        if (signal.aborted) throw fail('aborted');
        throw fail('meta_unavailable', { error_code: String((error && error.code) || 'error').slice(0, 32) });
      }
      observations += 1;
      if (watermark === null) {
        const first = counters(observed);
        if (!first) throw fail('meta_invalid');
        watermark = first.appended;
      }
      const verdict = classify(before, watermark, observed);
      last = verdict.s;
      if (verdict.state === 'complete') return { observations, watermark, before, last };
      if (verdict.state === 'failed') throw fail(verdict.reason);
      try { await sleep(pollMs, signal); }
      catch (error) { if (signal.aborted) throw fail('aborted'); throw error; }
    }
  }

  // Completion, then exactly ONE read of the audited rows; a completed write without a matching row fails.
  async function settledRows({ read, match }) {
    const completion = await settled();
    const rows = await read(signal);
    if (!Array.isArray(rows)) throw new AuditCompletionError('completed_read_invalid', { phase: 'read', completion });
    if (!rows.some(match)) throw new AuditCompletionError('completed_row_missing', { phase: 'read', rows: rows.length, completion });
    return rows;
  }

  return { before, settled, settledRows };
}

module.exports = { beginAuditCompletion, classify, counters, daemonAuditObserver, AuditCompletionError, POLL_MS };
