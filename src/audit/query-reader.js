'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const WORKER_FILE = path.join(__dirname, 'inject-query-worker.js');
const BUDGETS = Object.freeze({ fileBytes: 64*1024*1024, chunkBytes: 64*1024,
  lineBytes: 256*1024, replyBytes: 2*1024*1024 });
const WORKER_CODES = new Set(['AUDIT_QUERY_UNAVAILABLE', 'AUDIT_QUERY_BUDGET_EXCEEDED']);
const reasons = new Set(['file_unavailable','not_regular_file','file_bytes','line_bytes','reply_bytes','file_changed_during_read','read_failed']);
const result = (code, status = 503, reason = 'query_unavailable') => ({ ok: false, code, status,
  error: 'Inject audit query unavailable; no empty result was substituted.', reason });

function scalarFilters(options) {
  const filters = {};
  for (const key of ['since','until','to','from','spoof','limit','cursor']) {
    const value = options[key];
    if (value === undefined || value === null) continue;
    if (!['string','number','boolean'].includes(typeof value) || String(value).length > 4096) return null;
    filters[key] = value;
  }
  return filters;
}

function createAuditReader({ path: auditPath, timeoutMs = 10000,
  workerFactory = (file, options) => new Worker(file, options),
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof auditPath !== 'string' || !auditPath) throw new Error('Audit reader requires a daemon-owned path.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) throw new Error('Invalid audit query timeout.');
  const active = new Set(); let closed = false;
  function read(options = {}) {
    if (closed) return Promise.resolve(result('AUDIT_QUERY_CLOSED'));
    const filters = scalarFilters(options);
    if (!filters) return Promise.resolve(result('AUDIT_QUERY_INVALID_FILTER', 400, 'scalar_filters_required'));
    if (active.size >= 2) return Promise.resolve(result('AUDIT_QUERY_BUSY', 429, 'worker_capacity'));
    return new Promise(resolve => {
      let worker;
      try { worker = workerFactory(WORKER_FILE, { workerData: { path: auditPath, filters, budgets: BUDGETS }, trackUnmanagedFds: true,
        resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 4, stackSizeMb: 2 } }); }
      catch { resolve(result('AUDIT_QUERY_FAILED')); return; }
      const job = { worker, settled: false, timer: null, stop: null };
      active.add(job); worker.unref();
      function release() {
        active.delete(job);
        if (job.timer !== null) clearTimer(job.timer);
        worker.removeListener('message', message); worker.removeListener('error', error); worker.removeListener('exit', exit);
      }
      function stop() {
        try { Promise.resolve(worker.terminate()).then(release, () => {}); } catch { /* stays capacity-bound until exit */ }
      }
      function finish(value) {
        if (job.settled) return;
        job.settled = true;
        if (job.timer !== null) clearTimer(job.timer);
        resolve(value); stop();
      }
      job.stop = () => finish(result('AUDIT_QUERY_CLOSED'));
      function message(value) {
        if (value && value.ok === true && typeof value.json === 'string' && Buffer.byteLength(value.json) <= BUDGETS.replyBytes) {
          finish({ ok: true, json: value.json });
        } else if (value && value.ok === false && WORKER_CODES.has(value.code) && reasons.has(value.reason)) {
          finish(result(value.code, 503, value.reason));
        } else finish(result('AUDIT_QUERY_FAILED'));
      }
      function error() { finish(result('AUDIT_QUERY_FAILED')); }
      function exit() { if (!job.settled) finish(result('AUDIT_QUERY_FAILED')); release(); }
      worker.on('message', message); worker.on('error', error); worker.on('exit', exit);
      job.timer = setTimer(() => finish(result('AUDIT_QUERY_TIMEOUT', 503, 'wall_timeout')), timeoutMs);
    });
  }
  async function close() {
    closed = true;
    for (const job of active) job.stop();
    // Native workers are unreferenced and termination has been requested. Do not let an
    // uninterruptible filesystem syscall prevent the daemon's audit-writer shutdown flush.
  }
  return { read, close };
}

function registerAuditQueryRoute(app, { reader, resolveSessionAlias }) {
  app.get('/api/injects', async (req, res) => {
    const q = req.query || {};
    const filters = scalarFilters(q);
    if (!filters) return res.status(400).json(result('AUDIT_QUERY_INVALID_FILTER', 400, 'scalar_filters_required'));
    if (filters.to) filters.to = resolveSessionAlias(filters.to) || filters.to;
    const query = await reader.read({ ...filters, spoof: q.spoof === '1' || q.spoof === 'true' });
    if (!query.ok) return res.status(query.status).json({ success: false, code: query.code, error: query.error, reason: query.reason });
    // The bounded result was serialized in the worker. Never JSON.parse/stringify it here.
    res.type('application/json').send(query.json);
  });
}
module.exports = { createAuditReader, registerAuditQueryRoute };
