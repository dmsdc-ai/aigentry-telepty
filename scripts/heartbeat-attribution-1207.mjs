#!/usr/bin/env node
// Task 1215 / #1207 native55 — DIAGNOSTIC-ONLY paired heartbeat-attribution probe. NOT a test gate, NOT release acceptance.
//
// What it does, per OS (one invocation): 20 arms in a FIXED alternating order CONTENDED, SOLO, CONTENDED, ... (N = 10 per
// arm, fixed here, not configurable). Each arm runs the UNCHANGED frozen test file
// test/ledger-control-responsiveness-1207.test.js with its full own workload, selecting only the 1 MiB F2 and R1 cases
// by exact name pattern (every other case is reported as UNSELECTED, never as passing), plus an idle sibling sampler
// process in BOTH arms. CONTENDED additionally runs a fixed, finite neighbour group of test files in two lanes; SOLO runs
// none. The arms differ ONLY in the presence of those competing test files — never in the product workload.
//
// Neighbour group (CONTENDED): the files that overlapped main#183 (this test file) in the supplied 7fd99db
// windows-ci-diagnostic receipt (concurrency 3 on a 4-cpu runner; up to two neighbours at a time), in their observed lane
// order. It is a CONTROLLED group started together with the target, NOT a replay of full CI (in CI they were mid-file and the
// main suite's own scheduling differs per OS).
//
// Evidence kept per arm: every child's exit code/signal/close, timeout/overflow/cleanup flags and raw stdout/stderr (bounded);
// the selected cases' TAP outcome and the test's OWN evidence files (verdict incl. inconclusive, controls, top gaps with the
// opt-in absolute timestamps and whole-process CPU deltas from heartbeat-gap-diagnostics TELEPTY_LEDGER_1207_HB_ATTRIB=on);
// the sibling's gaps; per-gap sibling overlap. Owner-worker ELU is UNAVAILABLE in this scope and is reported as such.
//
// Completion vs success: the probe exits 0 when the EXPERIMENT completed (all 20 arms ran, no timeout/overflow/cleanup failure,
// every artifact parsed) whatever the tests returned, and 2 when it is INCOMPLETE. A test failure, an inconclusive verdict or
// a control failure is data, never a retry trigger; nothing is trimmed, re-run or skipped. The primary test verdict remains
// the unchanged test in the regular CI and is authoritative. Labels are HYPOTHESES (review54), never blame decisions.
//
// Usage: node scripts/heartbeat-attribution-1207.mjs --out <dir> [--expect-node v20.20.0]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = 'telepty.ledger-1207.heartbeat-attribution-probe/v1';
const N_PER_ARM = 10;   // fixed in advance (dispatch); deliberately not a CLI option
const ARMS = Array.from({ length: 2 * N_PER_ARM }, (_, i) => ({ index: i + 1, kind: i % 2 === 0 ? 'CONTENDED' : 'SOLO', pair: Math.floor(i / 2) + 1 }));
const TARGET = 'test/ledger-control-responsiveness-1207.test.js';
const NAME_PATTERN = '^(F2|R1) \\[1 MiB\\]: ';
const SELECTED = [
  { id: 'F2', prefix: 'F2 [1 MiB]: ', evidence: 'F2-1MiB.json' },
  { id: 'R1', prefix: 'R1 [1 MiB]: ', evidence: 'R1-1MiB.json' },
];
const NEIGHBOUR_SOURCE = 'supplied windows-ci-diagnostic receipt for 7fd99db (7fdDiag.log): files overlapping main#183 22:14:00.110Z-22:14:11.162Z';
const NEIGHBOUR_LANES = [
  ['test/telesession-capabilities-1215.test.js', 'test/ledger-dir-flush-portability-1207.test.js', 'test/shell-string-class-pr108-port.test.js', 'test/integration/ledger-daemon-1207.test.js'],
  ['test/ledger-cold-fanout-1207.test.js', 'test/ledger-restore-lifecycle-1207.test.js', 'test/linux-ledger-integration-1207.test.js'],
];
const PRELOAD = './test-support/setup-env.js';   // scripts/test-suites.json "preload" (the test:ci caller shape)
const STALL_BOUND_MS = 50;      // the frozen contract value, used ONLY to choose which intervals get a label; never a gate here
const SIBLING_OVERLAP_MIN_GAP_MS = 20;
const WIN32_CPU_QUANTUM_MS = 15.625;   // probe66: documented coarse win32 process-CPU accounting quantum (limit tag only)
const LIMITS = Object.freeze({
  childTimeoutMs: 120000, armTimeoutMs: 240000, budgetMs: 20 * 60000, streamCapBytes: 4 * 1024 * 1024, closeWaitMs: 5000,
  siblingMaxMs: 300000, siblingReadyMs: 10000, siblingStopMs: 5000,
});
// probe66 RW4: the WORST-CASE wall time one arm can take, reserved BEFORE it starts: sibling ready wait + arm deadline + the
// post-kill drain (2 x closeWait) + graceful sibling stop (siblingStop + closeWait) + the post-kill sibling wait (closeWait).
// An arm starts only if elapsed + ARM_RESERVE_MS <= budgetMs, so the last arm can never run past the 20 min budget (and the
// unchanged 25 min job keeps >= 5 min for checkout, npm ci, the summary and the artifact upload).
const ARM_RESERVE_MS = LIMITS.siblingReadyMs + LIMITS.armTimeoutMs + 2 * LIMITS.closeWaitMs + LIMITS.siblingStopMs + 2 * LIMITS.closeWaitMs;
const ATTRIB_ENV = { TELEPTY_LEDGER_1207_TIERS: '1', TELEPTY_LEDGER_1207_HB_DIAG: 'on', TELEPTY_LEDGER_1207_HB_ATTRIB: 'on' };
const EXPERIMENT_ENV_KEYS = [...Object.keys(ATTRIB_ENV), 'TELEPTY_LEDGER_1207_EVIDENCE_DIR'];

function parseArgs(argv) {
  const o = { out: null, expectNode: 'v20.20.0' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') o.out = argv[++i];
    else if (argv[i] === '--expect-node') o.expectNode = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!o.out) throw new Error('--out <dir> is required');
  return o;
}

const absNow = () => performance.timeOrigin + performance.now();
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
function pctl(values, p) { const s = values.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return null; return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]; }
const dist = (values) => { const v = values.filter(Number.isFinite); return { n: v.length, min: v.length ? Math.min(...v) : null, p50: pctl(v, 0.5), p90: pctl(v, 0.9), max: v.length ? Math.max(...v) : null }; };

// One bounded child. Never retried. Streams go to files (bounded); every lifecycle event is recorded with its absolute time.
// probe66 RW2: ALL SEVEN lifecycle events (spawn, exit, childClose, stdoutEOF, stderrEOF, stdoutClose, stderrClose) are
// mandatory; any missing one makes the record lifecycle-incomplete. RW1: every forced termination goes through kill() and
// is recorded in `forced_kill`; closure observed here covers the direct child and pipe-inheriting descendants only — it is
// NEVER evidence that detached descendants (e.g. daemons a test spawned without these pipes) have exited.
const LIFECYCLE = ['spawn', 'exit', 'childClose', 'stdoutEOF', 'stderrEOF', 'stdoutClose', 'stderrClose'];
function runChild({ label, args, env, dir, timeoutMs, stdinPipe = false, onStdoutLine = null }) {
  const rec = { label, argv: [path.basename(process.execPath), ...args], events: [], exit_code: null, signal: null, close_code: null,
    timed_out: false, overflow: { stdout: false, stderr: false }, bytes: { stdout: 0, stderr: 0 }, cleanup_failed: false, spawn_error: null,
    forced_kill: null, lifecycle_complete: false, stdout_file: `${label}.stdout.log`, stderr_file: `${label}.stderr.log` };
  const files = { stdout: fs.openSync(path.join(dir, rec.stdout_file), 'wx', 0o600), stderr: fs.openSync(path.join(dir, rec.stderr_file), 'wx', 0o600) };
  const ev = (name, extra = {}) => rec.events.push({ ev: name, abs_ms: absNow(), ...extra });
  let child;
  const done = new Promise((resolve) => {
    let finished = false, killTimer = null, closeTimer = null;
    const seen = new Set();
    const finish = (force) => {
      if (finished) return;
      if (!force && !['exit', 'childClose', 'stdoutClose', 'stderrClose'].every((e) => seen.has(e))) return;
      finished = true; clearTimeout(killTimer); clearTimeout(closeTimer);
      for (const k of ['stdout', 'stderr']) { try { fs.closeSync(files[k]); } catch { /* already closed */ } }
      rec.missing_events = LIFECYCLE.filter((e) => !seen.has(e));
      if (rec.missing_events.some((e) => ['exit', 'childClose', 'stdoutClose', 'stderrClose'].includes(e))) rec.cleanup_failed = true;
      rec.lifecycle_complete = rec.missing_events.length === 0;   // RW2: a missing EOF counts too (a stream may be truncated)
      if (seen.has('closure_wait_expired')) rec.cleanup_failed = true;
      resolve(rec);
    };
    const mark = (name, extra) => { seen.add(name); ev(name, extra); };
    try {
      child = spawn(process.execPath, args, { cwd: ROOT, env, shell: false, windowsHide: true, stdio: [stdinPipe ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    } catch (error) { rec.spawn_error = String(error && error.code || error); finish(true); return; }
    let lineBuf = '';
    const take = (key, buf) => {
      const room = LIMITS.streamCapBytes - rec.bytes[key];
      if (room <= 0) { rec.overflow[key] = true; return; }
      const part = buf.length > room ? buf.subarray(0, room) : buf;
      if (part.length < buf.length) rec.overflow[key] = true;
      fs.writeSync(files[key], part); rec.bytes[key] += part.length;
      if (key === 'stdout' && onStdoutLine) {
        lineBuf += part.toString('utf8'); let i;
        while ((i = lineBuf.indexOf('\n')) !== -1) { onStdoutLine(lineBuf.slice(0, i).replace(/\r$/, '')); lineBuf = lineBuf.slice(i + 1); }
      }
    };
    child.on('spawn', () => mark('spawn', { pid: child.pid }));
    child.on('error', (error) => { rec.spawn_error = String(error && error.code || error); mark('error'); finish(true); });
    child.stdout.on('data', (b) => take('stdout', b));
    child.stderr.on('data', (b) => take('stderr', b));
    child.stdout.on('end', () => mark('stdoutEOF')); child.stderr.on('end', () => mark('stderrEOF'));
    child.stdout.on('close', () => { mark('stdoutClose'); finish(false); });
    child.stderr.on('close', () => { mark('stderrClose'); finish(false); });
    child.on('exit', (code, signal) => {
      rec.exit_code = code; rec.signal = signal; mark('exit', { code, signal });
      closeTimer = setTimeout(() => { mark('closure_wait_expired'); finish(true); }, LIMITS.closeWaitMs);
      finish(false);
    });
    child.on('close', (code) => { rec.close_code = code; mark('childClose', { code }); finish(false); });
    killTimer = setTimeout(() => { rec.timed_out = true; mark('timeout'); forceKill('child_timeout'); }, timeoutMs);
  });
  // The ONLY place a child is force-terminated. Direct child only (no process-group/tree kill, no host privileges): RW1 makes
  // ANY forced termination end the experiment's measurements, so a surviving descendant can never contaminate a later arm.
  function forceKill(reason) {
    if (!rec.forced_kill) rec.forced_kill = reason;
    rec.events.push({ ev: 'forced_kill', abs_ms: absNow(), reason });
    try { if (child) child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  return { done, get child() { return child; }, rec, kill: forceKill };
}

// Balanced-JSON extraction for `key={...}` occurrences inside one console line of the frozen test.
function extractJson(line, key) {
  const at = line.indexOf(`${key}=`); if (at === -1) return undefined;
  const start = at + key.length + 1; if (line[start] !== '{') return undefined;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < line.length; i++) {
    const c = line[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(line.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

// TAP (node --test-reporter=tap): top-level test points. Non-selected names are SKIPPED by the name pattern ⇒ "unselected".
function parseTap(text) {
  const points = [];
  let summary = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^(not )?ok \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/);
    if (m) points.push({ name: m[2].replace(/\\#/g, '#'), ok: !m[1], directive: m[3] || null });
    const s = raw.match(/^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) (\S+)$/);
    if (s) summary[s[1]] = Number(s[2]);
  }
  return { points, summary, complete: ['tests', 'pass', 'fail', 'cancelled', 'skipped'].every((k) => Number.isFinite(summary[k])) };
}

function overlapFraction(gap, siblingGaps) {
  if (!Number.isFinite(gap.abs_start_ms) || !Number.isFinite(gap.abs_end_ms)) return null;
  const len = gap.abs_end_ms - gap.abs_start_ms; if (!(len > 0)) return null;
  let best = 0;
  for (const s of siblingGaps) {
    if (!(s.gap_ms >= SIBLING_OVERLAP_MIN_GAP_MS)) continue;
    const ov = Math.min(gap.abs_end_ms, s.abs_end_ms) - Math.max(gap.abs_start_ms, s.abs_start_ms);
    if (ov > 0) best = Math.max(best, ov / len);
  }
  return best;
}

// review54-corrected HYPOTHESIS labels for one measured-phase interval >= the stall bound. Never a cause or blame decision.
function labelInterval(g, overlap) {
  const idleFrac = g.gap_ms > 0 ? g.idle_ms / g.gap_ms : null;
  const cpu = Number.isFinite(g.process_cpu_user_ms) ? g.process_cpu_user_ms + g.process_cpu_system_ms : null;
  let label;
  if (idleFrac !== null && idleFrac >= 0.9) label = 'H-WAIT: main loop idle-waiting while a 1 ms timer was due (timer delivery / scheduling); source unresolved';
  else if (g.busy_or_descheduled_ms >= 0.5 * g.gap_ms && cpu !== null && cpu >= 0.5 * g.gap_ms) label = 'H-INPROC: main loop non-idle with in-process CPU — candidate in-process, thread unresolved (process CPU is whole-process)';
  else if (g.busy_or_descheduled_ms >= 0.5 * g.gap_ms) label = 'H-NONIDLE-NOCPU: main loop non-idle without matching whole-process CPU — descheduled while running, or unmeasured';
  else label = 'H-MIXED: neither idle-dominated nor non-idle-dominated';
  const tags = [];
  if (overlap !== null && overlap >= 0.5) tags.push('SHARED: co-timed sibling gap — a shared scheduling/timer condition; its source may be this process, the neighbour files or the host (not proof of an external cause)');
  if (overlap === null) tags.push('SIBLING-OVERLAP-UNAVAILABLE');
  // probe66 factual limit: win32 process CPU advances in ~15.6 ms quanta, so a CPU-based split within one quantum of the
  // 0.5 x gap threshold is not separable from quantization.
  if (process.platform === 'win32' && cpu !== null && Math.abs(cpu - 0.5 * g.gap_ms) < WIN32_CPU_QUANTUM_MS) tags.push('CPU-QUANTUM-BOUNDARY');
  tags.push('OWNER-WORKER-ELU-UNAVAILABLE');
  return { label, tags, idle_fraction: idleFrac, process_cpu_ms: cpu, sibling_overlap_fraction: overlap };
}

async function runArm(arm, outDir, ctx) {
  const dir = path.join(outDir, `arm-${String(arm.index).padStart(2, '0')}-${arm.kind}`);
  fs.mkdirSync(dir, { mode: 0o700 });                    // fresh per arm: fails if it already exists
  const evidenceDir = path.join(dir, 'evidence');
  fs.mkdirSync(evidenceDir, { mode: 0o700 });
  const result = { ...arm, dir: path.basename(dir), abs_start_ms: absNow(), incomplete_reasons: [], children: [] };
  const baseEnv = { ...process.env };
  for (const k of EXPERIMENT_ENV_KEYS) delete baseEnv[k];   // neighbours see the ordinary CI environment

  // 1. idle sibling sampler (both arms)
  let ready = false;
  // perf89: coverage is decided on ONE clock (this harness's absNow) from the causal order the harness enforces, never by
  // comparing two processes' performance.timeOrigin clocks (run 41254607100: harness-vs-sibling offset >= 57 ms, growing).
  let readyRecvAbs = null;     // harness clock when the `ready` line arrived
  let siblingReadyAbs = null;  // sibling clock printed on that line (data only)
  const sibling = runChild({ label: 'sibling', args: [path.join('test', 'fixtures', 'ledger-1207', 'heartbeat-sibling-sampler.js'), path.join(dir, 'sibling.json'), String(LIMITS.siblingMaxMs)],
    env: baseEnv, dir, timeoutMs: LIMITS.siblingMaxMs + 30000, stdinPipe: true,
    onStdoutLine: (l) => { if (l.startsWith('ready ') && !ready) { ready = true; readyRecvAbs = absNow(); siblingReadyAbs = Number(l.slice(6)); } } });
  const readyBy = Date.now() + LIMITS.siblingReadyMs;
  while (!ready && Date.now() < readyBy && !sibling.rec.events.some((e) => e.ev === 'exit')) await new Promise((r) => setTimeout(r, 20));
  if (!ready) result.incomplete_reasons.push('sibling_not_ready');
  // Snapshot BEFORE the target is spawned: a `ready` that arrives later must not count as start coverage.
  const readyBeforeSpawn = ready;

  // 2. target (both arms) + neighbour lanes (CONTENDED only), started together. Every workload child is tracked so an arm
  //    timeout kills ALL of them before the next arm starts (no cross-arm contamination).
  const active = new Set();
  const track = (h) => { active.add(h); h.done.then(() => active.delete(h)); return h; };
  const targetEnv = { ...baseEnv, ...ATTRIB_ENV, TELEPTY_LEDGER_1207_EVIDENCE_DIR: evidenceDir };
  const target = track(runChild({ label: 'target', dir, env: targetEnv, timeoutMs: LIMITS.childTimeoutMs,
    args: ['--require', PRELOAD, '--test', '--test-reporter=tap', `--test-name-pattern=${NAME_PATTERN}`, TARGET] }));
  let targetDone = false;
  const targetPromise = target.done.then((r) => { targetDone = true; return r; });
  const lanes = arm.kind === 'CONTENDED' ? NEIGHBOUR_LANES.map(async (files, li) => {
    const out = [];
    for (let fi = 0; fi < files.length; fi++) {
      // no NEW neighbour file starts after the target finished; a running one completes on its own
      if (targetDone) { out.push({ file: files[fi], started: false, reason: 'target_finished_before_start' }); continue; }
      const n = track(runChild({ label: `lane${li + 1}-${fi + 1}`, dir, env: baseEnv, timeoutMs: LIMITS.childTimeoutMs,
        args: ['--require', PRELOAD, '--test', '--test-reporter=tap', files[fi]] }));
      out.push({ file: files[fi], started: true, record: await n.done });
    }
    return out;
  }) : [];
  let armTimer = null;
  const armDeadline = new Promise((r) => { armTimer = setTimeout(() => r('arm_timeout'), LIMITS.armTimeoutMs); });
  const settled = await Promise.race([Promise.all([targetPromise, ...lanes]).then(() => 'ok'), armDeadline]);
  clearTimeout(armTimer);
  if (settled === 'arm_timeout') {
    result.incomplete_reasons.push('arm_timeout');
    for (const h of active) h.kill('arm_timeout');   // recorded as forced_kill ⇒ the experiment stops after this arm (RW1)
  }
  let closeTimer = null;
  const drained = await Promise.race([Promise.all([targetPromise, ...lanes]).then(() => 'ok'),
    new Promise((r) => { closeTimer = setTimeout(() => r('stuck'), 2 * LIMITS.closeWaitMs); })]);
  clearTimeout(closeTimer);
  if (drained !== 'ok') result.incomplete_reasons.push('workload_children_not_closed_after_kill');
  const targetRec = target.rec;
  if (!targetDone) result.incomplete_reasons.push('target_not_finished');
  const laneResults = drained === 'ok' ? await Promise.all(lanes) : [];

  // 3. stop the sibling (stdin end), bounded
  try { if (sibling.child && sibling.child.stdin) sibling.child.stdin.end(); } catch { /* gone */ }
  let siblingTimer = null;
  const siblingRec = await Promise.race([sibling.done, new Promise((r) => { siblingTimer = setTimeout(() => r(null), LIMITS.siblingStopMs + LIMITS.closeWaitMs); })]);
  clearTimeout(siblingTimer);
  if (!siblingRec) {
    // graceful stdin-end stop failed: forced kill (recorded) ⇒ the experiment stops after this arm (RW1); wait boundedly for closure
    result.incomplete_reasons.push('sibling_not_stopped');
    sibling.kill('sibling_not_stopped');
    let t2 = null;
    const late = await Promise.race([sibling.done, new Promise((r) => { t2 = setTimeout(() => r(null), LIMITS.closeWaitMs); })]);
    clearTimeout(t2);
    if (!late) result.incomplete_reasons.push('sibling_not_closed_after_kill');
  }
  let siblingData = null;
  try { siblingData = JSON.parse(fs.readFileSync(path.join(dir, 'sibling.json'), 'utf8')); } catch { result.incomplete_reasons.push('sibling_output_missing'); }
  result.abs_end_ms = absNow();

  // 4. child bookkeeping (every exit kept). The sibling's record is taken from the handle even when it had to be killed.
  const siblingFinal = siblingRec || sibling.rec;
  const startedLaneRecs = laneResults.flat().filter((x) => x.started).map((x) => x.record);
  // children still unaccounted for (lanes not drained): their handles' records, so a kill or a missing event is still visible
  const unaccounted = drained === 'ok' ? [] : [...active].map((h) => h.rec).filter((r) => r !== targetRec);
  const allRecs = [targetRec, siblingFinal, ...startedLaneRecs, ...unaccounted];
  for (const r of allRecs) {
    result.children.push({ label: r.label, exit_code: r.exit_code, signal: r.signal, close_code: r.close_code, timed_out: r.timed_out, overflow: r.overflow,
      cleanup_failed: r.cleanup_failed, spawn_error: r.spawn_error, forced_kill: r.forced_kill, lifecycle_complete: r.lifecycle_complete,
      missing_events: r.missing_events || LIFECYCLE.slice(), stdout_file: r.stdout_file, stderr_file: r.stderr_file, bytes: r.bytes });
    if (r.timed_out) result.incomplete_reasons.push(`timeout:${r.label}`);
    if (r.overflow.stdout || r.overflow.stderr) result.incomplete_reasons.push(`overflow:${r.label}`);
    if (r.cleanup_failed) result.incomplete_reasons.push(`cleanup_failed:${r.label}`);
    if (r.spawn_error) result.incomplete_reasons.push(`spawn_error:${r.label}`);
    if (!r.lifecycle_complete) result.incomplete_reasons.push(`lifecycle_missing:${r.label}:${(r.missing_events || LIFECYCLE).join('|')}`);   // RW2
  }
  // RW1: any forced termination, or closure that could not be confirmed, stops every later arm (no post-kill measurement).
  result.forced_kills = allRecs.filter((r) => r.forced_kill).map((r) => ({ label: r.label, reason: r.forced_kill }));
  result.closure_uncertain = drained !== 'ok' || allRecs.some((r) => r.cleanup_failed || !r.lifecycle_complete)
    || result.incomplete_reasons.includes('sibling_not_closed_after_kill');
  result.stop_experiment = result.forced_kills.length > 0 || result.closure_uncertain;
  result.descendant_closure = 'unverified: closure covers the direct child and pipe-inheriting descendants only; detached descendants are not observable';
  result.neighbours = laneResults.map((lane, i) => ({ lane: i + 1, files: lane.map((x) => ({ file: x.file, started: x.started, reason: x.reason || null,
    exit_code: x.record ? x.record.exit_code : null, timed_out: x.record ? x.record.timed_out : null })) }));

  // 5. target cases: TAP outcome + the test's own evidence files
  const tap = parseTap(fs.readFileSync(path.join(dir, targetRec.stdout_file), 'utf8'));
  if (!tap.complete) result.incomplete_reasons.push('target_tap_summary_incomplete');
  result.target = { exit_code: targetRec.exit_code, tap_summary: tap.summary,
    unselected: tap.points.filter((p) => !SELECTED.some((s) => p.name.startsWith(s.prefix))).map((p) => ({ name: p.name, directive: p.directive, reported_as: 'unselected' })) };
  // RW3: overlap is computed ONLY from a sibling that stopped by stdin end, dropped no gaps and covered the target's whole
  // spawn→exit window; otherwise every interval's overlap is null (SIBLING-OVERLAP-UNAVAILABLE) and the arm is incomplete.
  const evAt = (name) => { const e = targetRec.events.find((x) => x.ev === name); return e ? e.abs_ms : null; };
  const targetWindow = { start_ms: evAt('spawn'), end_ms: evAt('exit') };
  const sibExit = (siblingFinal.events || []).find((x) => x.ev === 'exit');
  const siblingExitAbs = sibExit ? sibExit.abs_ms : null;   // harness clock, same as targetWindow
  const siblingWhy = !siblingData ? 'no_sibling_output'
    : siblingData.stop_reason !== 'stdin_end' ? `stop_reason_${siblingData.stop_reason}`
      : siblingData.gaps_dropped !== 0 ? `gaps_dropped_${siblingData.gaps_dropped}`
        : !(Number.isFinite(targetWindow.start_ms) && Number.isFinite(targetWindow.end_ms)) ? 'target_window_unknown'
          // start: sampling began before `ready` (sampler source) and `ready` reached this harness before the target spawned
          : !(readyBeforeSpawn && Number.isFinite(readyRecvAbs) && readyRecvAbs <= targetWindow.start_ms) ? 'sibling_not_ready_before_target_spawn'
            // end: the sibling stopped (stdin end, sent only after the target settled) and exited after the target exited
            : !(Number.isFinite(siblingExitAbs) && siblingExitAbs >= targetWindow.end_ms) ? 'sibling_exited_before_target_exit' : null;
  result.sibling_overlap_valid = siblingWhy === null;
  result.target_window = targetWindow;
  // The four harness-clock instants the coverage rule used, persisted so the verdict can be re-checked from arm.json alone.
  result.sibling_coverage_harness_clock = { ready_received_before_spawn: readyBeforeSpawn, ready_recv_ms: readyRecvAbs,
    target_spawn_ms: targetWindow.start_ms, target_exit_ms: targetWindow.end_ms, sibling_exit_ms: siblingExitAbs };
  // Data only, never a verdict: the former cross-process comparison, and a LOWER BOUND on (sibling clock - harness clock)
  // implied by `ready` preceding the spawn (positive values prove the sibling clock reads ahead by at least that much).
  result.cross_process_clock = siblingData ? {
    sibling_abs_start_minus_target_spawn_ms: Number.isFinite(siblingData.abs_start_ms) && Number.isFinite(targetWindow.start_ms) ? siblingData.abs_start_ms - targetWindow.start_ms : null,
    sibling_abs_end_minus_target_exit_ms: Number.isFinite(siblingData.abs_end_ms) && Number.isFinite(targetWindow.end_ms) ? siblingData.abs_end_ms - targetWindow.end_ms : null,
    sibling_ahead_lower_bound_ms: Number.isFinite(siblingReadyAbs) && Number.isFinite(targetWindow.start_ms) ? siblingReadyAbs - targetWindow.start_ms : null,
  } : null;
  if (siblingWhy) result.incomplete_reasons.push(`sibling_overlap_invalid:${siblingWhy}`);
  const siblingGaps = siblingWhy === null ? siblingData.gaps : null;
  result.cases = SELECTED.map((s) => {
    const pts = tap.points.filter((p) => p.name.startsWith(s.prefix));
    const c = { id: s.id, tap: pts.length === 1 ? (pts[0].directive ? `unexpected_${pts[0].directive}` : (pts[0].ok ? 'assertions_passed' : 'assertions_failed')) : `found_${pts.length}` };
    if (pts.length !== 1 || pts[0].directive) result.incomplete_reasons.push(`case_${s.id}_not_run_exactly_once`);
    let ev = null;
    try { ev = JSON.parse(fs.readFileSync(path.join(evidenceDir, s.evidence), 'utf8')); } catch { result.incomplete_reasons.push(`case_${s.id}_evidence_missing`); }
    if (ev) {
      const hb = ev.heartbeat || ev.heartbeat_on_early_failure || null;
      const acc = ev.heartbeat_acceptance || null;
      const ctl = ev.heartbeat_controls || {};
      c.verdict = acc ? acc.verdict : 'missing';
      c.verdict_reasons = acc ? acc.reasons : null;
      c.workload = hb && hb.measured ? { n: hb.measured.n, max_ms: hb.measured.max_ms, over_50ms: hb.measured.over_50ms, p99_ms: hb.measured.p99_ms } : null;
      c.controls = { idle_pre_max_ms: ctl.idle_pre ? ctl.idle_pre.max_ms : null, idle_post_max_ms: ctl.idle_post ? ctl.idle_post.max_ms : null, block_max_ms: ctl.block ? ctl.block.max_ms : null };
      const diag = hb && hb.diagnostics ? hb.diagnostics : null;
      c.attribution_fields_present = !!(diag && diag.attribution);
      if (!c.attribution_fields_present) result.incomplete_reasons.push(`case_${s.id}_attribution_fields_missing`);
      c.aggregate = diag ? diag.measured_phase_aggregate : null;
      c.intervals = (diag ? diag.top_gaps : []).filter((g) => g.phase === 'measured' && g.gap_ms >= STALL_BOUND_MS).map((g) => ({
        gap_ms: g.gap_ms, abs_start_ms: g.abs_start_ms ?? null, abs_end_ms: g.abs_end_ms ?? null, label_start: g.label_start, label_end: g.label_end,
        idle_ms: g.idle_ms, busy_or_descheduled_ms: g.busy_or_descheduled_ms, gc_ms: g.gc_ms, msgs: g.msgs, max_msg_bytes: g.max_msg_bytes,
        process_cpu_user_ms: g.process_cpu_user_ms ?? null, process_cpu_system_ms: g.process_cpu_system_ms ?? null,
        ...labelInterval(g, siblingGaps ? overlapFraction(g, siblingGaps) : null) }));
    }
    return c;
  });
  result.sibling = siblingData ? { stop_reason: siblingData.stop_reason, summary: siblingData.summary, gaps_recorded: siblingData.gaps.length, gaps_dropped: siblingData.gaps_dropped } : null;
  result.incomplete = result.incomplete_reasons.length > 0;
  writeJson(path.join(dir, 'arm.json'), result);
  ctx.log(`arm ${arm.index}/${ARMS.length} ${arm.kind}: target exit=${targetRec.exit_code} ${result.cases.map((c) => `${c.id}:${c.verdict || 'missing'}/${c.tap}`).join(' ')} incomplete=${result.incomplete}`);
  return result;
}

function summarize(arms) {
  const byCase = {};
  for (const s of SELECTED) {
    byCase[s.id] = {};
    for (const kind of ['CONTENDED', 'SOLO']) {
      const cs = arms.filter((a) => a.kind === kind).map((a) => (a.cases || []).find((c) => c.id === s.id)).filter(Boolean);
      const count = (pred) => cs.filter(pred).length;
      const intervals = cs.flatMap((c) => c.intervals || []);
      const labels = {}; for (const iv of intervals) { const k = iv.label.split(':')[0]; labels[k] = (labels[k] || 0) + 1; }
      const shared = intervals.filter((iv) => iv.tags.some((t) => t.startsWith('SHARED'))).length;
      byCase[s.id][kind] = {
        arms_planned: N_PER_ARM, arms_with_case: cs.length,
        verdict: { pass: count((c) => c.verdict === 'pass'), fail: count((c) => c.verdict === 'fail'), inconclusive: count((c) => c.verdict === 'inconclusive'), missing: count((c) => !c.verdict || c.verdict === 'missing') },
        tap: { assertions_passed: count((c) => c.tap === 'assertions_passed'), assertions_failed: count((c) => c.tap === 'assertions_failed'), other: count((c) => !['assertions_passed', 'assertions_failed'].includes(c.tap)) },
        workload_max_ms: dist(cs.map((c) => c.workload && c.workload.max_ms)),
        idle_pre_max_ms: dist(cs.map((c) => c.controls && c.controls.idle_pre_max_ms)), idle_post_max_ms: dist(cs.map((c) => c.controls && c.controls.idle_post_max_ms)),
        intervals_ge_50ms: intervals.length, interval_labels: labels, intervals_with_shared_sibling_gap: shared,
        // probe66: top-K-bounded interval count above vs the harness all-gap counter (which counts > 50, not >= 50)
        intervals_ge_50ms_scope: 'diagnostics top-K (8) gaps per case and arm only',
        harness_over_50ms_total: cs.reduce((n, c) => n + (c.workload && Number.isFinite(c.workload.over_50ms) ? c.workload.over_50ms : 0), 0),
        intervals_overlap_unavailable: intervals.filter((iv) => iv.sibling_overlap_fraction === null).length,
        idle_fraction: dist(intervals.map((iv) => iv.idle_fraction)), sibling_overlap_fraction: dist(intervals.map((iv) => iv.sibling_overlap_fraction)),
      };
    }
  }
  const siblingMax = (kind) => dist(arms.filter((a) => a.kind === kind && a.sibling).map((a) => a.sibling.summary.max_ms));
  const hypotheses = [];
  for (const s of SELECTED) {
    const c = byCase[s.id], solo = c.SOLO, cont = c.CONTENDED;
    if (solo.verdict.fail > 0 && (solo.interval_labels['H-INPROC'] || 0) > 0) hypotheses.push(`${s.id}: SOLO-arm failures with in-process-CPU intervals — candidate product responsiveness defect; thread unresolved; requires review (not a verdict)`);
    else if (solo.verdict.fail > 0) hypotheses.push(`${s.id}: SOLO-arm failures without in-process-CPU intervals — present without competing files; source unresolved (not a verdict)`);
    if (cont.verdict.fail > 0 && solo.verdict.fail === 0) hypotheses.push(`${s.id}: failures only in CONTENDED — consistent with a property of this controlled contention configuration, not a full-CI replay (not a verdict)`);
    if (solo.verdict.inconclusive + cont.verdict.inconclusive > 0) hypotheses.push(`${s.id}: ${solo.verdict.inconclusive + cont.verdict.inconclusive} inconclusive arm(s) — invalid same-process control baseline; neither a measured workload failure nor a PASS`);
    if (solo.verdict.fail + cont.verdict.fail === 0) hypotheses.push(`${s.id}: no workload failure in these 20 arms — not evidence of a fix and not a PASS of the primary test`);
  }
  return { by_case: byCase, sibling_max_gap_ms: { CONTENDED: siblingMax('CONTENDED'), SOLO: siblingMax('SOLO') }, hypotheses,
    owner_worker_elu: 'unavailable in this scope (no owner-Worker handle without editing the frozen test or control-harness.js); hypotheses needing it are not evaluated' };
}

let fatalPersist = null;   // probe66 RW4: set by main() once the summary writer exists; used by the fatal handler
// probe66: factual limits recorded in experiment.json (no causal or blame claim is derived from any of them).
const REPORTED_LIMITS = [
  'Node: this probe pins 20.20.0 (expected_node); the historical hosted main CI ran v20.20.2 (setup-node `20`) — not an exact reproduction',
  'reporter: the target runs with --test-reporter=tap (parsed here); test:ci uses --test-reporter=spec — output format differs, workload does not',
  'process CPU (process.cpuUsage) is WHOLE-process (main + owner worker + threadpool); Node 20 has no per-thread CPU, so no interval is assigned to a thread',
  'win32 process CPU is coarse (~15.625 ms quanta); intervals whose CPU lies within one quantum of the 0.5 x gap split are tagged CPU-QUANTUM-BOUNDARY',
  'intervals_ge_50ms counts only the diagnostics top-K (8) gaps per case and arm; harness_over_50ms_total is the all-gap count but uses > 50 ms while the contract bound is >= 50 ms',
  'owner-worker ELU is unavailable (no owner-Worker handle without editing the frozen test or control-harness.js); hypotheses needing it are not evaluated',
  'arm 1 is a cold CONTENDED arm and CONTENDED leads every pair; N = 10 per arm can show only large differences — no significance claim',
  'descendant closure is unverified: closure observed covers the direct child and pipe-inheriting descendants only; therefore ANY forced kill or uncertain closure stops all later arms',
];

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(opts.out);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const logLines = [];
  const ctx = { log: (m) => { const l = `[hb-attrib ${new Date().toISOString()}] ${m}`; logLines.push(l); process.stdout.write(l + '\n'); } };
  const started = Date.now();
  const header = { schema: SCHEMA, node: process.version, expected_node: opts.expectNode, platform: process.platform, arch: process.arch, os_release: os.release(),
    cpus: os.cpus().length, available_parallelism: typeof os.availableParallelism === 'function' ? os.availableParallelism() : null,
    n_per_arm: N_PER_ARM, arm_order: ARMS.map((a) => a.kind), target: TARGET, name_pattern: NAME_PATTERN, selected: SELECTED.map((s) => s.prefix.trim()),
    neighbour_group: { source: NEIGHBOUR_SOURCE, lanes: NEIGHBOUR_LANES, concurrency: 1 + NEIGHBOUR_LANES.length, note: 'controlled group started with the target; not a full-CI replay' },
    experiment_env_names: EXPERIMENT_ENV_KEYS, limits: LIMITS, arm_reserve_ms: ARM_RESERVE_MS, stall_bound_ms_reference_only: STALL_BOUND_MS,
    reported_limits: REPORTED_LIMITS, started_at: new Date(started).toISOString() };
  writeJson(path.join(outDir, 'experiment.json'), header);
  const state = { arms: [], incomplete: [], phase: 'running', stopReason: null };
  if (process.version !== opts.expectNode) state.incomplete.push(`node_version_mismatch:${process.version}`);

  // probe66 RW4: the summary is persisted (atomically: tmp + rename) after every arm, at the end, and on every controlled
  // failure/termination path, so a cancelled or failed job still leaves a summary that names what did and did not run.
  const summaryOf = (final) => {
    const ran = state.arms.filter((a) => !a.not_run);
    return { schema: SCHEMA, final, phase: state.phase, experiment_complete: final && state.incomplete.length === 0 && state.arms.length === ARMS.length && ran.length === ARMS.length,
      incomplete_reasons: state.incomplete, stop_reason: state.stopReason,
      meaning: 'experiment_complete describes the PROBE, not the tests. Test outcomes are data. The primary test verdict in the regular CI is authoritative and unchanged; nothing here is release acceptance.',
      arms_planned: ARMS.length, arms_run: ran.length, arms_not_run: state.arms.filter((a) => a.not_run).length,
      arms_never_reached: ARMS.length - state.arms.length, ...summarize(ran),
      arms: state.arms.map((a) => ({ index: a.index, kind: a.kind, dir: a.dir || null, not_run: !!a.not_run, not_run_reason: a.not_run_reason || null,
        incomplete: !!a.incomplete, stop_experiment: !!a.stop_experiment,
        cases: (a.cases || []).map((c) => ({ id: c.id, verdict: c.verdict || 'missing', tap: c.tap, workload_max_ms: c.workload ? c.workload.max_ms : null })) })),
      written_at: new Date().toISOString() };
  };
  const persist = (final) => {
    try {
      const tmp = path.join(outDir, `summary.json.tmp-${process.pid}`);
      fs.writeFileSync(tmp, JSON.stringify(summaryOf(final), null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, path.join(outDir, 'summary.json'));
      fs.writeFileSync(path.join(outDir, 'probe.log'), logLines.join('\n') + '\n', { mode: 0o600 });
    } catch (error) { process.stderr.write(`[hb-attrib] summary write failed: ${error && error.code}\n`); }
  };
  ctx.persist = persist; ctx.state = state;
  fatalPersist = (error) => { state.phase = 'fatal'; state.incomplete.push(`fatal:${String(error && error.message).slice(0, 200)}`); persist(false); };
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => { state.phase = `terminated_by_${sig}`; state.incomplete.push(`terminated_by_${sig}`); persist(false); process.exit(2); });
  }
  persist(false);

  for (const arm of ARMS) {
    // RW1: after a forced kill or uncertain closure, no further arm is measured (honestly recorded as not_run)
    if (state.stopReason) { state.arms.push({ ...arm, not_run: true, not_run_reason: state.stopReason }); continue; }
    // RW4: reserve the worst-case arm before starting it
    if (Date.now() - started + ARM_RESERVE_MS > LIMITS.budgetMs) {
      state.incomplete.push(`budget_reserve_insufficient_before_arm_${arm.index}`);
      state.arms.push({ ...arm, not_run: true, not_run_reason: 'budget_reserve_insufficient' });
      continue;
    }
    let r;
    try { r = await runArm(arm, outDir, ctx); } catch (error) {
      r = { ...arm, incomplete: true, stop_experiment: true, incomplete_reasons: [`arm_error:${String(error && error.message).slice(0, 200)}`] };
    }
    state.arms.push(r);
    if (r.incomplete) state.incomplete.push(`arm_${arm.index}:${r.incomplete_reasons.join(',')}`);
    if (r.stop_experiment) {
      state.stopReason = r.forced_kills && r.forced_kills.length ? 'aborted_after_kill' : 'aborted_after_uncertain_closure';
      state.incomplete.push(`${state.stopReason}:arm_${arm.index}`);
      ctx.log(`arm ${arm.index}: ${state.stopReason} — all later arms are recorded not_run`);
    }
    persist(false);
  }
  state.phase = 'finished';
  const summary = summaryOf(true);
  persist(true);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [`### heartbeat attribution probe (#1207) — DIAGNOSTIC ONLY`, '', `experiment_complete: **${summary.experiment_complete}** (probe completion, NOT a test result)`, '',
      '| case | arm | pass | fail | inconclusive | missing | intervals >= 50 ms |', '|---|---|---|---|---|---|---|'];
    for (const [id, k] of Object.entries(summary.by_case)) for (const kind of ['CONTENDED', 'SOLO']) { const v = k[kind]; lines.push(`| ${id} | ${kind} | ${v.verdict.pass} | ${v.verdict.fail} | ${v.verdict.inconclusive} | ${v.verdict.missing} | ${v.intervals_ge_50ms} |`); }
    lines.push('', `arms run: ${summary.arms_run}/${ARMS.length}; not run: ${summary.arms_not_run}${summary.stop_reason ? ` (${summary.stop_reason})` : ''}`);
    lines.push('', 'Labels are hypotheses (review54), not blame decisions. The primary test verdict is unchanged and authoritative.');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }
  ctx.log(`experiment_complete=${summary.experiment_complete} arms_run=${summary.arms_run}/${ARMS.length}`);
  persist(true);   // includes the final log line
  process.exitCode = summary.experiment_complete ? 0 : 2;
}

main().catch((error) => {
  process.stderr.write(`[hb-attrib] fatal: ${error && error.stack || error}\n`);
  try { if (fatalPersist) fatalPersist(error); } catch { /* best effort: stderr above carries the cause */ }
  process.exitCode = 2;
});
