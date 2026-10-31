'use strict';

// Task 1215 native55 — IDLE SIBLING SAMPLER for the diagnostic-only paired probe (scripts/heartbeat-attribution-1207.mjs).
// Test support only; never shipped; never required by any test. A separate Node process that runs NOTHING but the same
// 1 ms setInterval heartbeat as control-harness startHeartbeat, so a co-timed gap in this process and in the workload
// process shows a SHARED scheduling/timer condition on the host. It does NOT prove an external-host cause: the shared
// source may be the workload process's own threads, the neighbour test files, or the host (review54 correction).
//
// Usage: node heartbeat-sibling-sampler.js <out.json> <maxMs>
//   - prints exactly one line `ready <abs_ms>` on stdout once sampling has started;
//   - stops when its stdin ENDS (the probe closes it), or at <maxMs>, whichever is first, then writes <out.json>
//     (exclusive create) and exits 0; stop_reason says which.
// Recorded: every inter-tick gap >= RECORD_MS with absolute start/end (performance.timeOrigin + performance.now, epoch ms)
// and the main-loop idle delta (performance.nodeTiming.idleTime) across it; summary over ALL gaps (n, max, p50/p90/p99,
// over_10ms, over_50ms). Bounded: <= RECORD_CAP recorded gaps (rest counted as dropped), <= SAMPLE_CAP gap samples kept for
// the distribution (rest counted). No environment values, paths of other processes or payloads are written.

const fs = require('node:fs');
const { performance } = require('node:perf_hooks');

const RECORD_MS = 10, RECORD_CAP = 20000, SAMPLE_CAP = 400000, PERIOD_MS = 1;
const [, , outFile, maxMsArg] = process.argv;
const maxMs = Number(maxMsArg);
if (!outFile || !Number.isFinite(maxMs) || maxMs <= 0) { process.stderr.write('usage: heartbeat-sibling-sampler.js <out.json> <maxMs>\n'); process.exit(2); }

const abs = (t) => performance.timeOrigin + t;
const samples = []; let samplesDropped = 0;
const gaps = []; let gapsDropped = 0;
let prev = performance.now(); let prevIdle = performance.nodeTiming.idleTime;
const startedAt = prev;
const timer = setInterval(() => {
  const now = performance.now(); const idleNow = performance.nodeTiming.idleTime;
  const g = now - prev;
  if (samples.length < SAMPLE_CAP) samples.push(g); else samplesDropped++;
  if (g >= RECORD_MS) {
    if (gaps.length < RECORD_CAP) gaps.push({ abs_start_ms: abs(prev), abs_end_ms: abs(now), gap_ms: g, idle_ms: idleNow - prevIdle });
    else gapsDropped++;
  }
  prev = now; prevIdle = idleNow;
}, PERIOD_MS);

let finished = false;
function finish(reason) {
  if (finished) return;
  finished = true;
  clearInterval(timer); clearTimeout(deadline);
  const sorted = Float64Array.from(samples).sort();
  const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] : null);
  const out = {
    schema: 'telepty.ledger-1207.heartbeat-sibling-sampler/v1', pid: process.pid, node: process.version, platform: process.platform,
    period_ms: PERIOD_MS, record_ms: RECORD_MS, stop_reason: reason,
    abs_start_ms: abs(startedAt), abs_end_ms: abs(performance.now()), time_origin_ms: performance.timeOrigin,
    summary: { n: samples.length, n_dropped: samplesDropped, max_ms: sorted.length ? sorted[sorted.length - 1] : null,
      p50_ms: pct(0.5), p90_ms: pct(0.9), p99_ms: pct(0.99),
      over_10ms: samples.filter((g) => g >= 10).length, over_50ms: samples.filter((g) => g >= 50).length },
    gaps, gaps_dropped: gapsDropped,
    limits: ['abs_* align with the workload process only to wall-clock accuracy (~ms)', 'a co-gap shows a shared condition, not its source'],
  };
  fs.writeFileSync(outFile, JSON.stringify(out) + '\n', { flag: 'wx', mode: 0o600 });
  process.exit(0);
}
const deadline = setTimeout(() => finish('max_ms'), maxMs);
process.stdin.on('end', () => finish('stdin_end'));
process.stdin.on('error', () => finish('stdin_error'));
process.stdin.resume();
process.stdout.write(`ready ${abs(performance.now())}\n`);
