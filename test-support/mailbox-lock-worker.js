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
    // Task 1215 win164 (diagnostics only): a time split the 50-iteration `sweep` lines lack. Every 10 iterations, one
    // `sweep_tick` line: elapsed, time inside breakStaleLocks (total/max/last) vs time actually spent in the
    // wait(1) sleep. It tells a gradually slower sweep from one stalled call: lines stop with a small elapsed,
    // or the last tick shows a long single call. A `sweep_done` line before the final message tells "finished but
    // the message never arrived" from "still running". Fixed numeric fields, at most SWEEP_TICK_LINES lines on
    // their own budget (the emitDiag cap and the existing `sweep` lines are unchanged). Neither kind is a progress
    // milestone for a contender; since fix664 the parent's sweep guard (test guardFor) re-arms only on an advancing `sweep_tick`.
    const SWEEP_TICK_EVERY = 10, SWEEP_TICK_LINES = 40;
    let tickLines = 0, sweepMs = 0, sweepMaxMs = 0, lastSweepMs = 0, waitMs = 0;
    const tick = (kind, i) => {
      if (tickLines >= SWEEP_TICK_LINES) return; tickLines++;
      const r = (v) => Math.round(v * 10) / 10;
      try {
        fs.writeSync(2, `lock-diag ${JSON.stringify({kind, iteration: i, since_start_ms: Math.round(performance.now() - begun),
          sweep_ms_total: r(sweepMs), sweep_ms_max: r(sweepMaxMs), sweep_ms_last: r(lastSweepMs), wait_ms_total: r(waitMs), removed})}\n`);
      } catch { /* a full pipe drops the line */ }
    };
    for (let i = 0; i < Number(count); i++) {
      const s0 = performance.now();
      removed += breakStaleLocks(path.dirname(dir));
      const s1 = performance.now(); wait(1); const s2 = performance.now();
      lastSweepMs = s1 - s0; sweepMs += lastSweepMs; if (lastSweepMs > sweepMaxMs) sweepMaxMs = lastSweepMs; waitMs += s2 - s1;
      // Task 1215 native65 OBS-M1 (diagnostics only): after iterations 49, 99, …, 349 (≤ 7 lines through the existing
      // emitDiag cap) — the actual sweep rate. kind 'sweep' is not a progress milestone: the parent guard ignores it.
      if ((i + 1) % 50 === 0) emitDiag('sweep', {iteration: i, since_start_ms: Math.round(performance.now() - begun), removed});
      if ((i + 1) % SWEEP_TICK_EVERY === 0) tick('sweep_tick', i);
    }
    tick('sweep_done', Number(count) - 1);
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
