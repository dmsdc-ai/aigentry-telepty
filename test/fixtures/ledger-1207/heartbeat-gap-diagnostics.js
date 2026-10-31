'use strict';

// Task 1215 / #1207 — bounded heartbeat GAP diagnostics (test support only; never shipped). Opt-in hook for the
// existing 1 ms heartbeat sampler (control-harness startHeartbeat). It records only the K largest gaps
// (fixed buffers, no per-tick allocation) with signals that can discriminate WHY a main-loop gap happened.
// Nothing here asserts or changes any acceptance verdict.
//
// Per-gap signals, all on ONE clock (performance.now(), the same timeline as PerformanceObserver GC entries):
//   start_ms / end_ms        gap boundaries relative to this tracker's creation
//   phase / label_start/end  harness phase (warmup|measured|tail) and the last test-set operation label
//   idle_ms                  main event-loop IDLE time inside the gap (performance.nodeTiming.idleTime delta).
//                            idle ≈ gap ⇒ the loop was waiting (the timer did not fire: scheduling/timer coarseness);
//                            idle ≈ 0 ⇒ the main thread was busy (JS, GC, message deserialization) or descheduled mid-run
//   gc_ms / gc_count / gc_kinds  MAIN-ISOLATE GC time overlapping the gap (perf_hooks 'gc'; worker GC is NOT visible)
//   msgs / msg_bytes / max_msg_type / max_msg_bytes  worker→main messages handled inside the gap, from the harness's
//                            existing observed-worker record (JSON-size proxy; that proxy itself runs on the main thread)
// Phase aggregates (labelled as such, never per-gap): main-loop ELU, process CPU (WHOLE process incl. worker threads),
// process-wide voluntary/involuntary context switches, main-isolate GC totals.
// Blind spots: no per-thread CPU in Node 20 (main-thread descheduling vs busy JS cannot be separated per gap);
// worker-isolate GC and worker CPU are invisible per gap; labels are the last label set, not an exact call site.
// Disable with TELEPTY_LEDGER_1207_HB_DIAG=off (instrumentation-disabled comparison run).

const { performance, PerformanceObserver } = require('node:perf_hooks');

const DEFAULT_TOP_K = 8;
const GC_CAP = 512;
const KINDS = { 1: 'minor', 2: 'major', 4: 'incremental', 8: 'weakcb' };

function enabled(env = process.env) {
  return String(env.TELEPTY_LEDGER_1207_HB_DIAG || 'on').toLowerCase() !== 'off';
}

function snapshotAggregate() {
  const ru = process.resourceUsage();
  return { at_ms: performance.now(), elu: performance.eventLoopUtilization(), cpu: process.cpuUsage(),
    voluntary: ru.voluntaryContextSwitches, involuntary: ru.involuntaryContextSwitches };
}

// `messages` is the harness's existing { inbound: [{type, bytes}], outbound: [...] } record (or null).
function createGapDiagnostics({ topK = DEFAULT_TOP_K, messages = null } = {}) {
  const K = Math.max(1, Math.min(32, topK | 0));
  const t0 = performance.now();
  // fixed top-K buffers
  const gap = new Float64Array(K).fill(-1), start = new Float64Array(K), end = new Float64Array(K), idle = new Float64Array(K);
  const msgs = new Int32Array(K), msgBytes = new Float64Array(K), maxBytes = new Float64Array(K);
  const phaseAt = new Array(K).fill(null), labelStart = new Array(K).fill(null), labelEnd = new Array(K).fill(null), maxType = new Array(K).fill(null);
  let minIdx = 0, ticks = 0, label = null, lastLabel = null;
  let prevNow = t0, prevIdle = performance.nodeTiming.idleTime, prevMsg = messages ? messages.inbound.length : 0;
  // main-isolate GC ring
  const gcStart = new Float64Array(GC_CAP), gcDur = new Float64Array(GC_CAP), gcKind = new Int8Array(GC_CAP);
  let gcN = 0, gcDropped = 0, gcTotalMs = 0, gcTotal = 0;
  const takeGc = (entries) => {
    for (const e of entries) {
      gcTotal++; gcTotalMs += e.duration;
      if (gcN < GC_CAP) { gcStart[gcN] = e.startTime; gcDur[gcN] = e.duration; gcKind[gcN] = (e.detail && e.detail.kind) || 0; gcN++; } else gcDropped++;
    }
  };
  const observer = new PerformanceObserver((list) => takeGc(list.getEntries()));
  try { observer.observe({ entryTypes: ['gc'] }); } catch { /* gc entries unavailable: reported as such */ }
  const aggregates = { begin: snapshotAggregate(), phases: {} };

  function tick(phase) {
    const now = performance.now(), idleNow = performance.nodeTiming.idleTime;
    const g = now - prevNow;
    ticks++;
    if (g > gap[minIdx]) {
      // worker messages handled inside this gap (only scanned for a top-K candidate; usually 0-2 entries)
      let n = 0, bytes = 0, mBytes = 0, mType = null;
      if (messages) {
        const inbound = messages.inbound;
        for (let i = prevMsg; i < inbound.length; i++) { const b = inbound[i].bytes; n++; bytes += b; if (b > mBytes) { mBytes = b; mType = inbound[i].type; } }
      }
      gap[minIdx] = g; start[minIdx] = prevNow - t0; end[minIdx] = now - t0; idle[minIdx] = idleNow - prevIdle;
      msgs[minIdx] = n; msgBytes[minIdx] = bytes; maxBytes[minIdx] = mBytes; maxType[minIdx] = mType;
      phaseAt[minIdx] = phase; labelStart[minIdx] = lastLabel; labelEnd[minIdx] = label;
      minIdx = 0; for (let i = 1; i < K; i++) if (gap[i] < gap[minIdx]) minIdx = i;
    }
    prevNow = now; prevIdle = idleNow; prevMsg = messages ? messages.inbound.length : 0; lastLabel = label;
  }
  function mark(phase) {
    // a phase boundary resets the gap origin exactly like the harness does for its own samples
    prevNow = performance.now(); prevIdle = performance.nodeTiming.idleTime; prevMsg = messages ? messages.inbound.length : 0;
    aggregates.phases[phase] = snapshotAggregate();
  }
  function setLabel(next) { label = next; }
  let reported = null;
  function report() {
    if (reported) return reported;   // idempotent: the harness may stop() twice (try + finally)
    try { if (typeof observer.takeRecords === 'function') takeGc(observer.takeRecords()); } catch { /* none buffered */ }
    try { observer.disconnect(); } catch { /* already */ }
    const endAgg = snapshotAggregate();
    const gaps = [];
    for (let i = 0; i < K; i++) {
      if (gap[i] < 0) continue;
      const s = start[i] + t0, e = end[i] + t0;
      let gcMs = 0, gcCount = 0; const kinds = {};
      for (let j = 0; j < gcN; j++) {
        const gs = gcStart[j], ge = gs + gcDur[j];
        const overlap = Math.min(e, ge) - Math.max(s, gs);
        if (overlap > 0) { gcMs += overlap; gcCount++; const k = KINDS[gcKind[j]] || 'other'; kinds[k] = (kinds[k] || 0) + 1; }
      }
      gaps.push({ gap_ms: gap[i], start_ms: start[i], end_ms: end[i], phase: phaseAt[i], label_start: labelStart[i], label_end: labelEnd[i],
        idle_ms: idle[i], busy_or_descheduled_ms: Math.max(0, gap[i] - idle[i]), gc_ms: gcMs, gc_count: gcCount, gc_kinds: kinds,
        msgs: msgs[i], msg_bytes: msgBytes[i], max_msg_type: maxType[i], max_msg_bytes: maxBytes[i] });
    }
    gaps.sort((a, b) => b.gap_ms - a.gap_ms);
    const phaseAgg = (from, to) => (from && to ? {
      wall_ms: to.at_ms - from.at_ms,
      main_loop_elu: performance.eventLoopUtilization(to.elu, from.elu),
      process_cpu_ms: { user: (to.cpu.user - from.cpu.user) / 1000, system: (to.cpu.system - from.cpu.system) / 1000, scope: 'whole process incl. worker threads' },
      context_switches: { voluntary: to.voluntary - from.voluntary, involuntary: to.involuntary - from.involuntary, scope: 'process-wide (all threads)' },
    } : null);
    reported = {
      schema: 'telepty.ledger-1207.heartbeat-gap-diagnostics/v1', clock: 'performance.now (ms, relative to tracker start)',
      top_k: K, ticks, top_gaps: gaps,
      main_isolate_gc: { observed: gcTotal, total_ms: gcTotalMs, retained: gcN, dropped: gcDropped, scope: 'main isolate only (worker GC not visible)' },
      measured_phase_aggregate: phaseAgg(aggregates.phases.measured, aggregates.phases.tail || endAgg),
      whole_tracker_aggregate: phaseAgg(aggregates.begin, endAgg),
      blind_spots: ['no per-thread CPU (Node 20): busy JS vs descheduling cannot be separated per gap',
        'worker-isolate GC/CPU not attributable per gap', 'labels are the last test-set label, not exact call sites',
        'message bytes are the harness JSON-size proxy (computed on the main thread)'],
    };
    return reported;
  }
  return { tick, mark, setLabel, report };
}

module.exports = { createGapDiagnostics, enabled, DEFAULT_TOP_K };
