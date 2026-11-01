#!/usr/bin/env node
// Task 1215 / #879 — DIAGNOSTIC-ONLY Windows load observer for ONE main-CI regression invocation.
//
// It observes; it never decides. The workflow runs the UNCHANGED `npm run test:ci` step between `start` and `stop`,
// so the test's own exit is the step's exit and nothing here can turn a failure green. Measurements only — no claim
// about overhead or about what caused any pressure.
//
// Per probe set (at most one per 10 s; sets never overlap; the probes inside a set run one after another):
//   - UTC timestamp and monotonic elapsed time;
//   - os.cpus() time deltas summed over all logical CPUs since the previous set (capacity = cpus × interval);
//   - this process's event-loop timer delay (a 100 ms interval's lateness) over the window;
//   - three process-start probes, each an ASYNCHRONOUS child (no spawnSync/execSync), bounded to 30 s, output
//     counted but never kept, killed through its own handle on timeout and awaited for closure (≤ 5 s):
//       node      : <this node> -e 0
//       powershell: powershell.exe -NoLogo -NoProfile -NonInteractive -Command exit
//       schtasks  : schtasks.exe /query /tn <deliberately nonexistent task>   (a nonzero exit is the EXPECTED result)
// Never recorded: environment values, any process command line, host or user names, probe output bytes.
//
// Ownership and cleanup limits, stated honestly (task 1215 windows103):
//   - A probe child is terminated ONLY through its own ChildProcess handle, during this observer's lifetime. If its
//     closure is not observed within 5 s after exit or kill, the observer does NOT forget it: the incomplete probe is
//     written, no further probe starts, the interrupted set is kept, and the observation ends as FAILED. A missing
//     closure is never treated as proof of exit; such a child may outlive the observer and is left to the runner's
//     job teardown.
//   - `stop` never signals any process. It writes a private stop request, then accepts only a final state written by
//     the SAME observer instance (pid + private instance nonce). Anything else is an explicit diagnostic failure that
//     claims no cleanup.
//   - `start` that sees no readiness terminates only the child it spawned, through that child's handle, and reports
//     whether an exit was observed. The lifetime bound (`--max-ms`) makes a running observer finalize itself; a
//     runner/job kill can still end it without a final record.
//
// Usage (Windows only):
//   node scripts/windows-load-observer-879.mjs start --out <dir> [--max-ms <ms>]   start detached, wait for readiness
//   node scripts/windows-load-observer-879.mjs stop  --out <dir>                     request stop, verify the final state
// Evidence: <dir>/observations.jsonl (bounded), state.json, start.json, stop.json. Built-in modules only.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const SCHEMA = 'telepty.windows-load-observer-879/v2';
const SET_PERIOD_MS = 10000;
const PROBE_TIMEOUT_MS = 30000;
const CLOSURE_MS = 5000;
const LOOP_TICK_MS = 100;
const STOP_POLL_MS = 250;
const MAX_LINES = 2000;
const MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_MS = 18 * 60 * 1000;   // inside the job's 20-minute timeout
const CAP_MAX_MS = 19 * 60 * 1000;
const READY_WAIT_MS = 15000;
const START_EXIT_WAIT_MS = 5000;
// stop: one probe can still be running when the request lands (≤ 30 s timeout + ≤ 5 s closure) before the loop finalizes
const STOP_WAIT_MS = PROBE_TIMEOUT_MS + CLOSURE_MS + 10000;
const MISSING_TASK = '\\telepty-879-observer-nonexistent-task';
const INSTANCE = /^[0-9a-f]{32}$/;
const SELF = fileURLToPath(import.meta.url);

function usage(message) {
  process.stderr.write(`windows-load-observer-879: ${message}\nusage: node ${path.basename(SELF)} start|stop --out <dir> [--max-ms <ms>]\n`);
  process.exit(2);
}

function parse(argv) {
  const [cmd, ...rest] = argv;
  const o = { cmd, out: null, maxMs: DEFAULT_MAX_MS, instance: null };
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i], v = rest[i + 1];
    if (v === undefined) usage(`missing value for ${k}`);
    if (k === '--out') o.out = path.resolve(v);
    else if (k === '--max-ms') { o.maxMs = Number(v); if (!Number.isSafeInteger(o.maxMs) || o.maxMs < 60000 || o.maxMs > CAP_MAX_MS) usage(`--max-ms must be 60000..${CAP_MAX_MS}`); }
    else if (k === '--instance' && cmd === 'run') { if (!INSTANCE.test(v)) usage('bad --instance'); o.instance = v; }
    else usage(`unknown argument ${k}`);
  }
  if (!['start', 'stop', 'run'].includes(cmd)) usage('missing or unknown command');
  if (!o.out) usage('missing --out');
  if (cmd === 'run' && !o.instance) usage('missing --instance');
  return o;
}

const files = (out) => ({ jsonl: path.join(out, 'observations.jsonl'), state: path.join(out, 'state.json'),
  stopRequest: path.join(out, 'stop.request'), start: path.join(out, 'start.json'), stop: path.join(out, 'stop.json') });
const nowRec = (t0) => ({ utc: new Date().toISOString(), mono_ms: Math.round((performance.now() - t0) * 1000) / 1000 });
function writeAtomic(file, data) { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(data) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms3 = (v) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------- run (the detached observer) ----------------------
async function run(o) {
  const f = files(o.out);
  const t0 = performance.now();
  let lines = 0, bytes = 0, truncated = 0, stopping = null, inflight = null, sets = 0;
  const unclosed = [];   // owned probe children whose closure was NOT observed (kept, never forgotten)
  const emit = (rec) => {
    const line = JSON.stringify({ schema: SCHEMA, ...rec }) + '\n';
    if (lines >= MAX_LINES - 1 || bytes + Buffer.byteLength(line) > MAX_BYTES - 512) { truncated++; return; }
    fs.appendFileSync(f.jsonl, line); lines++; bytes += Buffer.byteLength(line);
  };
  const state = (phase, extra = {}) => writeAtomic(f.state, { schema: SCHEMA, pid: process.pid, instance: o.instance, phase, ...nowRec(t0), ...extra });

  // event-loop timer delay: lateness of a 100 ms interval, aggregated per probe-set window
  let loop = { n: 0, max_ms: 0, sum_ms: 0 }, expected = performance.now() + LOOP_TICK_MS;
  const loopTimer = setInterval(() => {
    const t = performance.now(), late = Math.max(0, t - expected);
    loop.n++; loop.sum_ms += late; if (late > loop.max_ms) loop.max_ms = late; expected = t + LOOP_TICK_MS;
  }, LOOP_TICK_MS);

  const cpuTotals = () => os.cpus().reduce((a, c) => { for (const k of Object.keys(a)) a[k] += c.times[k] || 0; return a; },
    { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 });
  let prevCpu = cpuTotals(), prevCpuAt = performance.now();

  // Resolves with the probe record. closure_confirmed is true only when 'close' was observed (or nothing was spawned).
  // On closure expiry the record is resolved with closure_confirmed:false and the child stays listed in `unclosed`.
  function probe(label, file, args) {
    return new Promise((resolve) => {
      const r = { label, timeout_ms: PROBE_TIMEOUT_MS, spawned: false, spawn_error: null, errors: [], exit_code: null, signal: null,
        exit_ms: null, close_ms: null, timed_out: false, killed: null, stdout_bytes: 0, stderr_bytes: 0,
        closure_wait_expired: false, closure_confirmed: false };
      const started = performance.now();
      let child, settled = false, timer = null, closureTimer = null;
      const settle = () => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(closureTimer); inflight = null; resolve(r); };
      const killOwn = (why) => { if (!r.killed) r.killed = why; try { child.kill(); } catch { /* the handle reports it gone */ } armClosure(); };
      const armClosure = () => {
        if (closureTimer || settled) return;
        closureTimer = setTimeout(() => {
          r.closure_wait_expired = true;   // NOT proof of exit: the owned child may still be running
          unclosed.push({ label, spawned: r.spawned, exit_code: r.exit_code, signal: r.signal, killed: r.killed, handle: child });
          settle();
        }, CLOSURE_MS);
      };
      try {
        child = spawn(file, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) { r.spawn_error = typeof e?.code === 'string' ? e.code.slice(0, 32) : 'spawn_throw'; r.closure_confirmed = true; settle(); return; }
      inflight = { kill: killOwn };
      child.on('spawn', () => { r.spawned = true; });
      child.on('error', (e) => {
        const code = typeof e?.code === 'string' ? e.code.slice(0, 32) : 'error';
        if (!r.spawned && r.exit_code === null) { r.spawn_error = code; r.closure_confirmed = true; settle(); return; }   // never started
        r.errors.push(code); armClosure();   // a started child: keep waiting (bounded) for its closure, never forget it
      });
      child.stdout.on('data', (d) => { r.stdout_bytes += d.length; });   // counted, never kept
      child.stderr.on('data', (d) => { r.stderr_bytes += d.length; });
      child.on('exit', (code, signal) => { r.exit_code = code; r.signal = signal; r.exit_ms = ms3(performance.now() - started); armClosure(); });
      child.on('close', () => { r.close_ms = ms3(performance.now() - started); r.closure_confirmed = true; settle(); });
      timer = setTimeout(() => { r.timed_out = true; killOwn('timeout'); }, PROBE_TIMEOUT_MS);
    });
  }

  const PROBES = [
    ['node', process.execPath, ['-e', '0']],
    ['powershell', 'powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit']],
    ['schtasks', 'schtasks.exe', ['/query', '/tn', MISSING_TASK]],
  ];

  // External triggers only REQUEST the end; the loop below finalizes, so an interrupted set is written first.
  const requestStop = (reason) => { if (stopping) return; stopping = reason; if (inflight) inflight.kill('stop'); };
  const stopPoll = setInterval(() => { if (fs.existsSync(f.stopRequest)) requestStop('stop_request'); }, STOP_POLL_MS);
  const lifetime = setTimeout(() => requestStop('max_ms'), o.maxMs);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) { try { process.on(sig, () => requestStop(`signal_${sig}`)); } catch { /* unsupported */ } }

  let finalized = false;
  const finalize = (reason, failure) => {
    if (finalized) return; finalized = true;
    clearInterval(loopTimer); clearInterval(stopPoll); clearTimeout(lifetime);
    // Direct-owned handles only, within this lifetime: one more termination request for children never seen closing.
    for (const u of unclosed) { try { u.handle.kill(); u.final_kill_requested = true; } catch { u.final_kill_requested = false; } }
    const owned = unclosed.map(({ handle, ...rest }) => rest);
    const failed = failure || unclosed.length > 0;
    emit({ type: 'stop', ...nowRec(t0), reason, failed, failure: failed ? (failure || 'probe_closure_unconfirmed') : null, sets,
      lines_truncated: truncated, owned_children_closure_unconfirmed: owned,
      cleanup_claim: unclosed.length ? 'none: owned child closure unconfirmed; it may outlive this observer (runner job teardown)' : 'all probe children closed' });
    state(failed ? 'failed' : 'stopped', { final: true, reason, failure: failed ? (failure || 'probe_closure_unconfirmed') : null, sets,
      lines_written: lines, lines_truncated: truncated, owned_children_closure_unconfirmed: owned.length });
    process.exit(failed ? 1 : 0);
  };
  process.on('uncaughtException', (e) => {
    try { emit({ type: 'error', ...nowRec(t0), error: e && e.name ? String(e.name).slice(0, 64) : 'error' }); } catch { /* bounded best effort */ }
    finalize('observer_error', 'observer_error');
  });

  emit({ type: 'start', ...nowRec(t0), node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length,
    set_period_ms: SET_PERIOD_MS, probe_timeout_ms: PROBE_TIMEOUT_MS, closure_ms: CLOSURE_MS, loop_tick_ms: LOOP_TICK_MS, max_ms: o.maxMs,
    probes: PROBES.map((p) => p[0]), missing_task_expected_nonzero: true });
  state('running', { final: false });

  for (;;) {
    if (stopping) return finalize(stopping, null);
    const setStart = performance.now();
    const set = { type: 'set', n: ++sets, ...nowRec(t0), probes: [], interrupted: null };
    for (const [label, file, args] of PROBES) {
      if (stopping) { set.interrupted = stopping; break; }
      const r = await probe(label, file, args);
      if (label === 'schtasks') r.missing_task_result = r.exit_code === null ? null : (r.exit_code !== 0 ? 'nonzero_expected' : 'zero_unexpected');
      set.probes.push(r);   // every probe record is kept, including an incomplete one
      if (!r.closure_confirmed) { set.interrupted = 'probe_closure_unconfirmed'; break; }
      if (stopping) { set.interrupted = stopping; break; }
    }
    const cpuNow = cpuTotals(), cpuAt = performance.now();
    const d = {}; for (const k of Object.keys(cpuNow)) d[k] = cpuNow[k] - prevCpu[k];
    const total = Object.values(d).reduce((a, b) => a + b, 0);
    set.cpu = { logical_cpus: os.cpus().length, interval_ms: Math.round(cpuAt - prevCpuAt), ticks_ms: d, total_ms: total,
      busy_fraction: total > 0 ? Math.round(((total - d.idle) / total) * 10000) / 10000 : null,
      denominator: 'sum over all logical CPUs of os.cpus() time deltas; capacity ~= logical_cpus x interval_ms' };
    prevCpu = cpuNow; prevCpuAt = cpuAt;
    set.loop_timer_delay = { tick_ms: LOOP_TICK_MS, n: loop.n, max_ms: ms3(loop.max_ms), mean_ms: loop.n ? ms3(loop.sum_ms / loop.n) : null };
    loop = { n: 0, max_ms: 0, sum_ms: 0 };
    set.set_elapsed_ms = Math.round(performance.now() - setStart);
    emit(set);   // a complete or an interrupted set is always written before any finalization
    if (unclosed.length) return finalize(stopping || 'probe_closure_unconfirmed', 'probe_closure_unconfirmed');   // no further probes
    if (stopping) return finalize(stopping, null);
    const until = setStart + SET_PERIOD_MS;
    while (!stopping && performance.now() < until) await sleep(Math.min(STOP_POLL_MS, until - performance.now()));
  }
}

// ---------------------------------------------------------------- start / stop (the workflow's callers) -------------
async function start(o) {
  if (process.platform !== 'win32') usage('Windows only');
  const f = files(o.out);
  fs.mkdirSync(o.out, { recursive: true });
  for (const p of Object.values(f)) if (fs.existsSync(p)) usage(`refusing to reuse existing evidence: ${path.basename(p)}`);
  const instance = crypto.randomBytes(16).toString('hex');
  const child = spawn(process.execPath, [SELF, 'run', '--out', o.out, '--max-ms', String(o.maxMs), '--instance', instance],
    { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  child.on('error', () => { exited = exited || { code: null, signal: null, spawn_error: true }; });
  const matches = (st) => st && st.pid === child.pid && st.instance === instance;
  const deadline = Date.now() + READY_WAIT_MS;
  let st = null;
  while (Date.now() < deadline && !exited) { st = readJson(f.state); if (matches(st) && st.phase === 'running') break; await sleep(100); }
  if (!(matches(st) && st.phase === 'running')) {
    // Only the child spawned here, only through its handle; report whether its exit was observed — never assume it.
    let killRequested = false;
    if (!exited) { try { killRequested = child.kill(); } catch { killRequested = false; } }
    const until = Date.now() + START_EXIT_WAIT_MS;
    while (!exited && Date.now() < until) await sleep(100);
    writeAtomic(path.join(o.out, 'start-failed.json'), { schema: SCHEMA, reason: 'not_ready', ready_wait_ms: READY_WAIT_MS,
      kill_requested_via_handle: killRequested, exit_observed: !!exited, exit: exited,
      cleanup_claim: exited ? 'spawned observer exited' : 'none: exit not observed; runner job teardown applies' });
    process.stdout.write(`::warning::windows-load-observer-879 did not become ready within ${READY_WAIT_MS} ms (exit observed: ${!!exited}); diagnostic only, the test step is unaffected\n`);
    process.exit(1);
  }
  writeAtomic(f.start, { schema: SCHEMA, pid: child.pid, instance, started_utc: new Date().toISOString(), max_ms: o.maxMs });
  child.unref();
  process.stdout.write(`windows-load-observer-879 running (pid ${child.pid}); evidence ${o.out}\n`);
}

async function stop(o) {
  const f = files(o.out);
  const owned = readJson(f.start);
  if (!owned || !Number.isSafeInteger(owned.pid) || !INSTANCE.test(String(owned.instance || ''))) {
    writeAtomic(f.stop, { schema: SCHEMA, verified: false, reason: 'no_started_observer_recorded', cleanup_claim: 'none' });
    process.stdout.write('::warning::windows-load-observer-879: no started observer recorded; nothing was signalled (diagnostic only)\n');
    process.exit(1);
  }
  fs.writeFileSync(f.stopRequest, new Date().toISOString() + '\n', { flag: 'w', mode: 0o600 });   // private request, never a signal
  const deadline = Date.now() + STOP_WAIT_MS;
  let st = null;
  const isFinal = (s) => s && s.pid === owned.pid && s.instance === owned.instance && s.final === true && (s.phase === 'stopped' || s.phase === 'failed');
  while (Date.now() < deadline) { st = readJson(f.state); if (isFinal(st)) break; await sleep(200); }
  const final = isFinal(st);
  const clean = final && st.phase === 'stopped';
  writeAtomic(f.stop, { schema: SCHEMA, pid: owned.pid, instance_matched: final, verified: clean, final_phase: final ? st.phase : null,
    failure: final ? st.failure : 'final_state_not_observed', wait_ms: STOP_WAIT_MS,
    exit_verification: 'by the same instance\'s final state only; no PID liveness check or signal is used (PIDs can be reused)',
    cleanup_claim: clean ? 'observer reported a clean stop' : 'none: runner job teardown applies' });
  if (!clean) {
    process.stdout.write(`::error::windows-load-observer-879 stop not confirmed (final=${final}, phase=${final ? st.phase : 'none'}); diagnostic only, nothing was signalled, no cleanup is claimed\n`);
    process.exit(1);
  }
  process.stdout.write(`windows-load-observer-879 stopped (pid ${owned.pid}); evidence ${o.out}\n`);
}

const opts = parse(process.argv.slice(2));
if (opts.cmd === 'run') run(opts).catch(() => process.exit(1));
else if (opts.cmd === 'start') start(opts).catch(() => process.exit(1));
else stop(opts).catch(() => process.exit(1));
