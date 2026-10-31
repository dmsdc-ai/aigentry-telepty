'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [dir, mode, count] = process.argv.slice(2);
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
if (mode === 'choose') {
  const rename = fs.renameSync;
  fs.renameSync = function(from, to) {
    if (path.basename(to) === 'number' && from.startsWith(path.join(dir, '.lock') + path.sep)) {
      process.send({choosing: true}); wait(30000);
    }
    return rename.apply(this, arguments);
  };
}
const { acquireLock, breakStaleLocks } = require('../src/mailbox/storage');
const { lockDiagnostics } = require('../src/mailbox/lock');
// #1215 G3 diagnostics only: CPU time (not wall time) and the lock module's fixed-key totals. Milestone lines go to
// stderr synchronously (the contend loop never yields), at most DIAG_LINES per worker; the parent shows them only in
// its existing timeout/exit failure text. No pid, path or ticket name is written.
const DIAG_LINES = 16, SLOW_ACQUIRE_MS = 1000;
let diagLines = 0;
const cpu = () => { const u = process.cpuUsage(); return {cpu_user_ms: Math.round(u.user / 1000), cpu_system_ms: Math.round(u.system / 1000)}; };
function emitDiag(kind, extra) {
  if (diagLines >= DIAG_LINES) return; diagLines++;
  try { fs.writeSync(2, `lock-diag ${JSON.stringify({kind, ...extra, ...cpu(), lock: lockDiagnostics()})}\n`); } catch { /* a full pipe drops the line */ }
}
process.once('message', () => {
  // Diagnostics only (#1215 mac a41): in-memory counters returned on the existing single message.
  const begun = performance.now(), bootMs = Math.round(begun);
  if (mode === 'sweep') {
    let removed = 0;
    for (let i = 0; i < Number(count); i++) {
      removed += breakStaleLocks(path.dirname(dir)); wait(1);
      // Task 1215 native65 OBS-M1 (diagnostics only): after iterations 49, 99, …, 349 (≤ 7 lines through the existing
      // emitDiag cap) — the actual sweep rate. kind 'sweep' is not a progress milestone: the parent guard ignores it.
      if ((i + 1) % 50 === 0) emitDiag('sweep', {iteration: i, since_start_ms: Math.round(performance.now() - begun), removed});
    }
    process.send({removed, stats: {bootMs, ms: Math.round(performance.now() - begun), ...cpu(), lock: lockDiagnostics()}}, () => process.disconnect()); return;
  }
  if (mode !== 'contend') {
    const release = acquireLock(dir); process.send({held: true});
    process.on('message', () => { release(); process.send({released: true}); });
    return;
  }
  let timeouts = 0, worst = 0;
  for (let i = 0; i < Number(count); i++) {
    let release, failed = 0; const acquireBegun = performance.now();
    for (let retry = 0; retry < 20 && !release; retry++) {
      try { release = acquireLock(dir); } catch (e) {
        if (!/lock timeout/i.test(e.message)) { emitDiag('error', {iteration: i, code: typeof e.code === 'string' ? e.code : null, attempt: e.lock_diagnostic || null}); throw e; }
        failed++;
      }
    }
    timeouts += failed; worst = Math.max(worst, failed);
    const acquireMs = Math.round(performance.now() - acquireBegun);
    if (!release) { emitDiag('unresolved', {iteration: i, acquire_ms: acquireMs, timeouts}); throw Error(`contention never resolved (iteration ${i}, timeouts ${timeouts})`); }
    const guard = path.join(dir, 'critical');
    try {
      const fd = fs.openSync(guard, 'wx'); fs.closeSync(fd);
      const value = Number(fs.readFileSync(path.join(dir, 'counter'), 'utf8')); wait(2);
      fs.writeFileSync(path.join(dir, 'counter'), String(value + 1)); fs.unlinkSync(guard);
    } finally { release(); }
    // After release: the line is never written while this worker holds the lock.
    if ((i + 1) % 10 === 0 || acquireMs > SLOW_ACQUIRE_MS) emitDiag('progress', {iteration: i, acquire_ms: acquireMs, since_start_ms: Math.round(performance.now() - begun), timeouts});
  }
  process.send({done: Number(count), stats: {bootMs, ms: Math.round(performance.now() - begun), timeouts, worst, ...cpu(), lock: lockDiagnostics()}}, () => process.disconnect());
});
