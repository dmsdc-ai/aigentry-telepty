#!/usr/bin/env node
'use strict';

// telepty #879 — CI-only per-file diagnostic runner for the Windows regression job.
//
// Why this exists: three Windows runs of `npm run test:ci` printed the same reporter failures and
// then produced NO output for ~18 minutes until the 20-minute job cap cancelled them. `node --test`
// runs files in parallel and buffers reporter output, so the last printed line does not identify
// the file (or the child process) that never terminated. This runner executes every file of the
// SAME inventory one `node --test` invocation per file, with its own deadline, and records for each:
//   start/end wall-clock, exit code + signal, the time the process EXITED versus the time its
//   stdout/stderr CLOSED (an exit without a close means an orphaned grandchild still holds the
//   inherited pipe — the #1 hypothesis), the TAP tally, and — on a deadline — the descendant
//   process tree at that moment (owned / excluded / unproven, by parent chain AND creation-time
//   chronology), before a bounded SIGKILL of the DIRECT child handle only — never of a numeric pid,
//   a tree or a process group — whose outcome is reported as verified / survivors / UNKNOWN.
//   Descendant cleanup is explicitly the disposable CI job's. Anything but a verified-clean,
//   complete, positive tally is a non-pass.
//
// Scope guard: this file is runner-only. It changes no product module, no package script and no
// test body. The inventory is read at runtime from scripts/test-suites.json, the same file that
// `npm run test:ci` / `test:ci:pty` execute through scripts/run-tests.mjs, so there is no second
// hand-maintained list to go stale. A timeout, a lost or unverified process, a
// spawn error, a stream that never closes or an incomplete tally is ALWAYS a non-zero exit — a
// bound is never reported as a pass.
//
// Coverage limits (recorded in summary.json too):
//   * the trailing `git diff --exit-code tests/snippet-protocol/v1/` gate of `test:ci` is NOT run;
//   * one file per `node --test` invocation does not reproduce the worker co-scheduling of the
//     original parallel run (same NODE_TEST_CONTEXT child semantics, different neighbours).
//
// Usage (from the repository root, or anywhere — paths resolve against this script):
//   node scripts/windows-ci-diagnostic.mjs --list
//   node scripts/windows-ci-diagnostic.mjs --phase all --out diag-879 [--concurrency 3]
//        [--timeout-ms 60000] [--budget-ms 600000] [--filter <substring>]
//
// Built-in modules only (no project imports). Node >= 20.

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, realpathSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const IS_WIN = process.platform === 'win32';

// ---------------------------------------------------------------------------------------------
// Bounds. Defaults come from the #879 dispatch: 60s per file, explicit evidence-based exceptions
// capped at 120s, concurrency <= 4, whole diagnostic <= 10 minutes (the job cap stays 15 min).
// ---------------------------------------------------------------------------------------------
const DEFAULT_FILE_TIMEOUT_MS = 60_000;
const MAX_FILE_TIMEOUT_MS = 120_000;
const MAX_CONCURRENCY = 4;
const DEFAULT_BUDGET_MS = 600_000;
const STREAM_CLOSE_GRACE_MS = 10_000;   // exit seen, streams not closed → 'exit-without-close'
const KILL_GRACE_MS = 10_000;           // after the handle SIGKILL, how long to wait for exit/close
const HELPER_TIMEOUT_MS = 5_000;        // bound on ONE process-table query
const KILL_SETTLE_MS = 1_000;           // between the handle SIGKILL and its verification snapshot
const CLEANUP_BUDGET_MS = 90_000;       // finite global budget for ALL snapshot helper time in one run
const HANDLE_DUMP_INTERVAL_MS = 15_000; // in-child active-handle dump cadence (unref'd timer)
// Worst case helper time per file: 2 snapshots × HELPER_TIMEOUT_MS = 10 s, and the GLOBAL budget
// caps the sum over all files at 90 s. Helpers are synchronous, so concurrency does not multiply
// them. On exhaustion the record says so and the disposable CI runner's job termination is the
// explicit remaining owner of any survivor. No helper ever signals a process.

// Per-file timeout exceptions. Evidence: sum of the top-level durations the spec reporter printed
// for the file in evidence/FINAL-WINDOWS.log (run 40492011728, Windows). Only files whose measured
// sum exceeded, or sat within contention distance of, the 60s default are listed:
//   test/cli.test.js     60,101 ms reported (30 tests, 4 of them 7–8 s PTY timeouts)
//   test/daemon.test.js  48,040 ms reported (50 tests, one 11.5 s auto-report wait)
// Nothing else in that log summed above 10 s. Values are clamped to MAX_FILE_TIMEOUT_MS.
const TIMEOUT_EXCEPTIONS_MS = {
  'test/cli.test.js': 120_000,
  'test/daemon.test.js': 120_000,
};

const COVERAGE_LIMITS = [
  'descendant processes left by a timed-out file are RECORDED, never signalled — the disposable CI job termination owns their cleanup (only the direct child handle is SIGKILLed)',
  'the trailing `git diff --exit-code tests/snippet-protocol/v1/` fixture gate of test:ci is NOT executed by this diagnostic',
  'one file per `node --test` invocation: NODE_TEST_CONTEXT child semantics match CI, but the worker co-scheduling of the original parallel run is not reproduced',
  'a file whose every test is skipped is classified `skipped`, never `pass`',
];

// ---------------------------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    phase: 'all', out: 'diag-879', concurrency: 3, timeoutMs: DEFAULT_FILE_TIMEOUT_MS,
    budgetMs: DEFAULT_BUDGET_MS, filter: '', list: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { i += 1; if (i >= argv.length) throw new Error(`missing value for ${a}`); return argv[i]; };
    switch (a) {
      case '--phase': opts.phase = next(); break;
      case '--out': opts.out = next(); break;
      case '--concurrency': opts.concurrency = Number(next()); break;
      case '--timeout-ms': opts.timeoutMs = Number(next()); break;
      case '--budget-ms': opts.budgetMs = Number(next()); break;
      case '--filter': opts.filter = next(); break;
      case '--list': opts.list = true; break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!['main', 'pty', 'all'].includes(opts.phase)) throw new Error(`--phase must be main|pty|all, got ${opts.phase}`);
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1 || opts.concurrency > MAX_CONCURRENCY) {
    throw new Error(`--concurrency must be an integer 1..${MAX_CONCURRENCY}, got ${opts.concurrency}`);
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 1_000 || opts.timeoutMs > MAX_FILE_TIMEOUT_MS) {
    throw new Error(`--timeout-ms must be 1000..${MAX_FILE_TIMEOUT_MS}, got ${opts.timeoutMs}`);
  }
  if (!Number.isFinite(opts.budgetMs) || opts.budgetMs < 10_000 || opts.budgetMs > DEFAULT_BUDGET_MS) {
    throw new Error(`--budget-ms must be 10000..${DEFAULT_BUDGET_MS}, got ${opts.budgetMs}`);
  }
  return opts;
}

// ---------------------------------------------------------------------------------------------
// Inventory — scripts/test-suites.json, the one list scripts/run-tests.mjs executes. package.json
// must invoke exactly these runner commands; any other script shape is refused, never parsed, so
// the wrapper's own filename can never be mistaken for a test file.
// ---------------------------------------------------------------------------------------------
const SUITES_SCHEMA = 'telepty-test-suites/v1';
const RUNNER_SCRIPTS = {
  'test:ci': 'node scripts/run-tests.mjs test:ci && git diff --exit-code tests/snippet-protocol/v1/',
  'test:ci:pty': 'node scripts/run-tests.mjs test:ci:pty',
};

function suiteFiles(suites, mode) {
  const suite = suites.modes && Object.hasOwn(suites.modes, mode) ? suites.modes[mode] : null;
  if (!suite || !Array.isArray(suite.files) || suite.files.length === 0) throw new Error(`${mode}: no test files in scripts/test-suites.json`);
  for (const f of suite.flags || []) {
    if (f !== '--test' && !f.startsWith('--test-reporter')) throw new Error(`${mode}: unrecognised node flag "${f}" — extend the parser deliberately`);
  }
  return suite.files;
}

function loadInventory() {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  for (const [name, expected] of Object.entries(RUNNER_SCRIPTS)) {
    if (pkg.scripts[name] !== expected) throw new Error(`${name}: expected package.json to run ${JSON.stringify(expected)}, got ${JSON.stringify(pkg.scripts[name])}`);
  }
  const suites = JSON.parse(readFileSync(join(SCRIPT_DIR, 'test-suites.json'), 'utf8'));
  if (suites.schema !== SUITES_SCHEMA) throw new Error(`scripts/test-suites.json: expected schema ${SUITES_SCHEMA}`);
  return {
    requires: suites.preload,
    main: suiteFiles(suites, 'test:ci').map((file, index) => ({ phase: 'main', index, file })),
    pty: suiteFiles(suites, 'test:ci:pty').map((file, index) => ({ phase: 'pty', index, file })),
    packageVersion: pkg.version,
  };
}

// ---------------------------------------------------------------------------------------------
// In-child instrumentation, generated at runtime into the output dir (never committed as a module).
// Passed with --require, so like setup-env.js it runs in the `node --test` parent AND in the test
// child it spawns (execArgv propagates). An unref'd interval cannot keep the loop alive by itself,
// so a dump that keeps appearing after the file's last test means something ELSE is holding the
// process open — and the dump names it: `process.getActiveResourcesInfo()` (public, names
// Timeout/TCPSocketWrap/ChildProcessStdio/...) plus `process._getActiveHandles()` (internal,
// guarded) for child pids, ports and addresses.
// ---------------------------------------------------------------------------------------------
export function preloadSource(intervalMs) {
  return `'use strict';
const t0 = Date.now();
const log = (line) => { try { process.stderr.write('[879-child pid=' + process.pid + ' +' + ((Date.now() - t0) / 1000).toFixed(1) + 's] ' + line + '\\n'); } catch {} };
log('preload: start argv=' + JSON.stringify(process.argv.slice(1)) + ' NODE_TEST_CONTEXT=' + JSON.stringify(process.env.NODE_TEST_CONTEXT || null));
function summarise() {
  const out = {};
  try {
    // Public API first (Node >= 17): names timers too, which _getActiveHandles does not.
    if (typeof process.getActiveResourcesInfo === 'function') {
      for (const r of process.getActiveResourcesInfo()) { const n = 'res:' + r; out[n] = (out[n] || 0) + 1; }
    }
    const handles = typeof process._getActiveHandles === 'function' ? process._getActiveHandles() : [];
    for (const h of handles) {
      let name = (h && h.constructor && h.constructor.name) || typeof h;
      if (name === 'ChildProcess' && h.pid) name += '(pid=' + h.pid + (h.exitCode === null && h.signalCode === null ? ',running' : ',exited') + ')';
      else if (name === 'Socket' && h.remotePort) name += '(' + (h.remoteAddress || '') + ':' + h.remotePort + ')';
      else if (name === 'Server' && typeof h.address === 'function') { try { const a = h.address(); name += '(' + (a && a.port) + ')'; } catch {} }
      else if (name === 'Timeout' && h._idleTimeout != null) name += '(' + h._idleTimeout + 'ms' + (typeof h.hasRef === 'function' && !h.hasRef() ? ',unref' : '') + ')';
      out[name] = (out[name] || 0) + 1;
    }
    const reqs = typeof process._getActiveRequests === 'function' ? process._getActiveRequests() : [];
    for (const r of reqs) { const n = 'req:' + ((r && r.constructor && r.constructor.name) || typeof r); out[n] = (out[n] || 0) + 1; }
  } catch (e) { out.error = String(e && e.message); }
  return out;
}
const timer = setInterval(() => log('active-handles ' + JSON.stringify(summarise())), ${intervalMs});
timer.unref();
// once: on a Windows pipe the stderr write below is asynchronous, so a persistent listener re-arms
// the loop and fires beforeExit forever (run 41173717097, session-durability-122: 307,169 lines).
process.once('beforeExit', (code) => log('beforeExit code=' + code + ' handles=' + JSON.stringify(summarise())));
process.on('exit', (code) => log('exit code=' + code));
`;
}

// ---------------------------------------------------------------------------------------------
// Process-table snapshot (Windows and POSIX) and the bounded termination of the DIRECT child
// handle. Every helper is spawnSync with shell:false, a short timeout, and is charged against a
// finite GLOBAL cleanup budget. A failed or skipped snapshot is reported as UNKNOWN — never as
// "nothing there". Nothing in this section signals a numeric pid, a tree or a process group:
// taskkill /T re-expands past any filtered set and a reused pid is somebody else's process.
// ---------------------------------------------------------------------------------------------
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Global accounting for helper time. `charge` reserves a slot or refuses once the budget is spent.
const cleanupLedger = { spentMs: 0, calls: 0, refused: 0, budgetMs: CLEANUP_BUDGET_MS };
function helperAllowed() { return cleanupLedger.spentMs < cleanupLedger.budgetMs; }
function runHelper(cmd, args, maxBuffer) {
  if (!helperAllowed()) { cleanupLedger.refused += 1; return { refused: true }; }
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: HELPER_TIMEOUT_MS, windowsHide: true, shell: false, maxBuffer: maxBuffer || 1024 * 1024 });
  cleanupLedger.spentMs += Date.now() - t0;
  cleanupLedger.calls += 1;
  return { refused: false, r };
}

// Process creation time is part of every snapshot row (`startedAt`, ms since epoch, or null when
// the table did not report one). A ppid alone is NOT ownership: run 40500878932's final leftover
// check attributed csrss.exe, winlogon.exe, fontdrvhost.exe and dwm.exe to a tracked child pid
// (6856) that had exited — those system processes were created long before it, and the number
// matched only because pids are reused. Ownership below requires parent chronology too.
const CHRONOLOGY_TOLERANCE_MS = 2_500; // 1 s table resolution on POSIX (etime) + clock jitter

function parseWinCreationDate(v) {
  if (v == null) return null;
  const m = String(v).match(/\/?Date\((-?\d+)\)/); // ConvertTo-Json serialises CIM datetimes as "\/Date(ms)\/"
  if (m) return Number(m[1]);
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

function parsePosixEtime(v, takenAt) {
  const m = String(v || '').match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/); // [[dd-]hh:]mm:ss
  if (!m) return null;
  const secs = (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3]) * 60) + Number(m[4]);
  return takenAt - secs * 1000;
}

function snapshotProcesses() {
  try {
    const takenAt = Date.now();
    const h = IS_WIN
      ? runHelper('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ConvertTo-Json -Compress'], 64 * 1024 * 1024)
      : runHelper('ps', ['-axo', 'pid=,ppid=,etime=,command='], 64 * 1024 * 1024);
    if (h.refused) return { ok: false, error: 'cleanup budget exhausted — snapshot not taken', rows: [] };
    const r = h.r;
    if (r.error || r.status !== 0) return { ok: false, error: String(r.error || r.stderr || `status ${r.status}`).slice(0, 300), rows: [] };
    const rows = [];
    if (IS_WIN) {
      let parsed = JSON.parse(r.stdout || '[]');
      if (!Array.isArray(parsed)) parsed = [parsed];
      for (const p of parsed) rows.push({ pid: Number(p.ProcessId), ppid: Number(p.ParentProcessId), name: String(p.Name || ''), cmd: String(p.CommandLine || '').slice(0, 200), startedAt: parseWinCreationDate(p.CreationDate) });
    } else {
      for (const line of r.stdout.split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
        if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[4].split(/\s+/)[0].split('/').pop(), cmd: m[4].slice(0, 200), startedAt: parsePosixEtime(m[3], takenAt) });
      }
    }
    return { ok: true, error: null, rows, takenAt };
  } catch (e) {
    return { ok: false, error: String(e && e.message).slice(0, 300), rows: [] };
  }
}

// Processes OWNED by the tracked child rootPid: the parent chain leads to rootPid AND every link
// is chronologically possible — a child was created no earlier than its parent, and a direct
// child of a root that has already exited was created inside the root's lifetime. A row that
// PROVABLY fails the chronology (created before its recorded parent, or after that parent exited)
// is a reused pid, not a descendant: it goes to `excluded` with the reason and is not evidence of
// an owned leftover. A row whose creation time (or whose parent's) is unknown goes to `unproven`:
// it is not counted as clean. Neither subtree is walked. Nothing returned here is ever signalled.
// Works when rootPid itself is gone, because a dead parent's pid stays recorded as ppid on Windows
// and on POSIX until re-parenting.
// `lineage` is the runner's own record of the root: { startedAt, exitAt } in ms (exitAt null while
// it runs). `exclude` removes the diagnostic's own helper processes: anything whose parent is THIS
// runner but is not a tracked per-file child (the snapshot helper and its conhost), plus subtrees.
function descendantsOf(rootPid, rows, exclude, lineage, sorted) {
  const byParent = new Map();
  for (const r of rows) {
    if (!byParent.has(r.ppid)) byParent.set(r.ppid, []);
    byParent.get(r.ppid).push(r);
  }
  const rootRow = rows.find((r) => r.pid === rootPid) || null;
  const out = [];
  const seen = new Set([rootPid]);
  const queue = [[rootPid, 0, lineage ? lineage.startedAt : (rootRow ? rootRow.startedAt : null), lineage ? lineage.exitAt : null]];
  while (queue.length) {
    const [p, depth, parentStartedAt, parentExitAt] = queue.shift();
    for (const child of byParent.get(p) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      if (exclude && exclude(child)) continue;
      let bucket = null, reason = null;
      if (child.startedAt == null) { bucket = 'unproven'; reason = 'child creation time unknown'; }
      else if (parentStartedAt == null) { bucket = 'unproven'; reason = 'parent creation time unknown'; }
      else if (child.startedAt < parentStartedAt - CHRONOLOGY_TOLERANCE_MS) { bucket = 'excluded'; reason = `pre-existing: created ${parentStartedAt - child.startedAt}ms BEFORE its recorded parent — ppid ${p} is a reused number`; }
      else if (parentExitAt != null && child.startedAt > parentExitAt + CHRONOLOGY_TOLERANCE_MS) { bucket = 'excluded'; reason = `reused pid: created ${child.startedAt - parentExitAt}ms AFTER parent ${p} exited`; }
      if (bucket) { if (sorted && sorted[bucket]) sorted[bucket].push({ ...child, depth: depth + 1, reason }); continue; }
      out.push({ ...child, depth: depth + 1 });
      queue.push([child.pid, depth + 1, child.startedAt, null]);
    }
  }
  return out;
}

// The owned subtree of a tracked root for the record, with the rows that were excluded as proven
// non-owners (documented, not evidence) and the rows that could not be attributed (never clean).
function ownedTree(rootPid, rows, ctx) {
  const sorted = { excluded: [], unproven: [] };
  const owned = descendantsOf(rootPid, rows, ctx.isHelperProcess, ctx.trackedPids.get(rootPid), sorted);
  return { owned, excluded: sorted.excluded, unproven: sorted.unproven };
}

// Is the row that carries a tracked pid still OUR child? 'yes' while our child has not exited and
// the table's creation time (when it has one) matches the spawn time; 'reused' when it provably
// differs or our child already exited; 'unknown' when the table gives no creation time.
function rootIdentity(rootRow, lineage) {
  if (!rootRow) return 'absent';
  if (!lineage || lineage.exitAt != null) return 'reused';
  if (rootRow.startedAt == null) return 'unknown';
  return Math.abs(rootRow.startedAt - lineage.startedAt) <= CHRONOLOGY_TOLERANCE_MS ? 'yes' : 'reused';
}

// Bounded termination of the DIRECT child handle on a deadline. The only signal this runner ever
// sends is `child.kill('SIGKILL')` on the ChildProcess object it spawned — the kernel resolves that
// handle to the process it created, so pid reuse cannot redirect it. Descendants (daemons, ConPTY
// shells) are NEVER signalled here: taskkill /T re-expands beyond any filtered set and process
// groups cannot be proven on Windows. They are RECORDED (owned / excluded / unproven, before and
// after), and their cleanup is explicitly the disposable CI job's. Returns { status, ... } with:
//   'verified-clean'  both snapshots succeeded, our child is gone and nothing owned or unproven remains
//   'survivors'       a snapshot succeeded and owned processes (or our live child) remain
//   'unknown'         a snapshot failed/was refused, or rows could not be attributed
// Never 'verified-clean' on a failed snapshot. Never a pass in any case — the caller's file is
// already classified timeout / exit-without-close.
function terminateDirectChild(rootPid, child, ctx) {
  const before = snapshotProcesses();
  const beforeTree = before.ok ? ownedTree(rootPid, before.rows, ctx) : null;
  let handleKill;
  try {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); handleKill = 'SIGKILL sent to the direct ChildProcess handle'; }
    else handleKill = 'handle already exited — nothing sent';
  } catch (e) { handleKill = `handle kill failed: ${String(e && (e.code || e.message))}`; }
  sleepSync(KILL_SETTLE_MS);
  const after = snapshotProcesses();
  const afterTree = after.ok ? ownedTree(rootPid, after.rows, ctx) : null;
  const rootAfter = after.ok ? after.rows.find((r) => r.pid === rootPid) : null;
  const identity = after.ok ? rootIdentity(rootAfter, ctx.trackedPids.get(rootPid)) : 'unknown';
  const survivors = afterTree ? afterTree.owned.concat(identity === 'yes' ? [rootAfter] : []) : [];
  const unproven = afterTree ? afterTree.unproven.concat(identity === 'unknown' ? [{ ...rootAfter, depth: 0, reason: 'tracked pid present, creation time unknown' }] : []) : [];
  const excluded = afterTree ? afterTree.excluded.concat(identity === 'reused' ? [{ ...rootAfter, depth: 0, reason: 'tracked pid present but held by another process (reused number)' }] : []) : [];
  let status;
  if (!before.ok || !after.ok) status = 'unknown';
  else if (survivors.length > 0) status = 'survivors';
  else if (unproven.length > 0) status = 'unknown';
  else status = 'verified-clean';
  const pick = (rows) => rows.map((r) => ({ pid: r.pid, ppid: r.ppid, name: r.name, depth: r.depth, startedAt: r.startedAt, reason: r.reason }));
  return {
    status, handleKill,
    beforeSnapshot: before.ok ? 'ok' : `FAILED: ${before.error}`, afterSnapshot: after.ok ? 'ok' : `FAILED: ${after.error}`,
    ownedBefore: beforeTree ? pick(beforeTree.owned) : null,
    survivors: pick(survivors), unproven: pick(unproven), excluded: pick(excluded),
    remainingOwner: status === 'verified-clean' ? null : 'disposable CI runner job termination (descendants are never signalled by this diagnostic)',
  };
}

// ---------------------------------------------------------------------------------------------
// Tally from the `node --test --test-reporter=tap` output. A pass needs a COMPLETE summary block
// (tests/pass/fail/cancelled/skipped/todo all present), a positive pass count, zero fail and zero
// cancelled, and the counts must reconcile. Anything less is not a pass.
// ---------------------------------------------------------------------------------------------
function tallyTap(stdout) {
  const tally = { tests: null, pass: null, fail: null, skipped: null, todo: null, cancelled: null, notOk: [], complete: false, reconciled: false };
  for (const line of stdout.split(/\r?\n/)) {
    let m;
    if ((m = line.match(/^# (tests|pass|fail|skipped|todo|cancelled) (\d+)\s*$/))) { tally[m[1]] = Number(m[2]); continue; }
    if ((m = line.match(/^\s*not ok \d+ - (.*?)(?: # (?:SKIP|TODO).*)?$/))) { tally.notOk.push(m[1].slice(0, 160)); continue; }
  }
  tally.complete = ['tests', 'pass', 'fail', 'skipped', 'todo', 'cancelled'].every((k) => tally[k] !== null);
  tally.reconciled = tally.complete && tally.tests === tally.pass + tally.fail + tally.cancelled + tally.skipped + tally.todo;
  return tally;
}

function classifyCleanExit(exitCode, tap) {
  if (!tap.complete) return exitCode === 0 ? 'unknown-tally' : 'fail';
  if (!tap.reconciled) return 'unknown-tally';
  if (exitCode !== 0) return 'fail';
  if (tap.fail > 0 || tap.cancelled > 0) return 'unknown-tally'; // exit 0 contradicts the tally
  if (tap.pass > 0) return 'pass';
  if (tap.tests > 0 && tap.skipped === tap.tests) return 'skipped';
  return 'unknown-tally'; // zero executed tests
}

// ---------------------------------------------------------------------------------------------
// Run one file. The record lives in ctx.records from the START (classification 'running') so a
// runner abort still leaves it behind; every state change is persisted through ctx.flush().
// ---------------------------------------------------------------------------------------------
function safeName(entry) {
  return `${entry.phase}-${String(entry.index).padStart(3, '0')}-${entry.file.replace(/^test\//, '').replace(/[\\/]/g, '_').replace(/\.test\.js$/, '')}`;
}

function runOne(entry, ctx) {
  const timeoutMs = Math.min(TIMEOUT_EXCEPTIONS_MS[entry.file] ?? ctx.timeoutMs, MAX_FILE_TIMEOUT_MS);
  const base = join(ctx.logDir, safeName(entry));
  const result = ctx.records.get(`${entry.phase}#${entry.index}`);
  Object.assign(result, {
    timeoutMs, startedAt: new Date().toISOString(), endedAt: null, durationMs: null,
    pid: null, exitCode: null, signal: null, exitAt: null, closeAt: null, spawnError: null,
    classification: 'running', stdoutBytes: 0, stderrBytes: 0, stdoutLog: `${base}.stdout.log`, stderrLog: `${base}.stderr.log`,
    tap: null, descendantsAtDeadline: null, kill: null, notes: [],
  });
  return new Promise((resolveRun) => {
    const started = Date.now();
    const deadlineAt = Math.min(started + timeoutMs, ctx.budgetEndsAt);
    // Same caller shape as test:ci — `node --require … --test <file>` — so NODE_TEST_CONTEXT and the
    // child-test process semantics match CI. Only the reporter differs (tap, machine-readable).
    const args = [...ctx.requires.flatMap((r) => ['--require', r]), '--require', ctx.preloadPath, '--test', '--test-reporter=tap', '--test-reporter-destination=stdout', entry.file];
    const outStream = createWriteStream(result.stdoutLog);
    const errStream = createWriteStream(result.stderrLog);
    let stdoutBuf = '';
    let child = null;
    let finished = false;
    let exited = false;
    let closed = false;
    let deadlineTimer = null;
    let closeGraceTimer = null;

    function finish() {
      if (finished) return;
      finished = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (closeGraceTimer) clearTimeout(closeGraceTimer);
      if (result.kill) {
        if (result.kill.status === 'survivors') {
          result.classification = 'lost-process';
          result.notes.push(`${result.kill.survivors.length} owned process(es) remain after the direct-handle SIGKILL (never signalled by this runner): ${result.kill.survivors.map((s) => `${s.name}:${s.pid}`).join(', ')}; remaining owner: ${result.kill.remainingOwner}`);
        } else if (result.kill.status !== 'verified-clean') {
          result.classification = 'cleanup-unknown';
          result.notes.push(`termination verification ${result.kill.status}; remaining owner: ${result.kill.remainingOwner}`);
        }
      }
      // Release this runner's references to the child after the record is written: streams
      // destroyed, handle unref'd, so a survivor cannot hold the runner open past its budget.
      if (child) { try { child.stdout.destroy(); child.stderr.destroy(); child.unref(); } catch {} }
      if (result.tap === null) result.tap = tallyTap(stdoutBuf);
      result.endedAt = new Date().toISOString();
      result.durationMs = Date.now() - started;
      outStream.end(); errStream.end();
      ctx.log(`END   ${entry.phase}#${entry.index} ${entry.file} class=${result.classification} exit=${result.exitCode} signal=${result.signal} dur=${result.durationMs}ms exitAt=${result.exitAt} closeAt=${result.closeAt} tap(tests=${result.tap.tests},pass=${result.tap.pass},fail=${result.tap.fail},skip=${result.tap.skipped},complete=${result.tap.complete})`);
      ctx.flush();
      resolveRun(result);
    }

    try {
      // POSIX only: own process group so the bounded kill can reach re-parented grandchildren.
      // Never on Windows — `detached` there means a separate console, which would change the
      // very conditions (shared console, ConPTY) under diagnosis.
      child = spawn(process.execPath, args, {
        cwd: REPO_ROOT, env: { ...process.env, TELEPTY_DIAG_879: '1' }, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: !IS_WIN,
      });
    } catch (e) {
      result.spawnError = String(e && e.message);
      result.classification = 'spawn-error';
      finish();
      return;
    }
    result.pid = child.pid ?? null;
    // Lineage record: WHEN this pid was ours (startedAt) and until when (exitAt, set on 'exit').
    // Ownership of anything found later under this number is decided against these two times.
    if (result.pid) ctx.trackedPids.set(result.pid, { startedAt: Date.now(), exitAt: null });
    ctx.log(`START ${entry.phase}#${entry.index} ${entry.file} pid=${result.pid} timeout=${timeoutMs}ms at=${result.startedAt}`);
    ctx.flush();

    child.stdout.on('data', (chunk) => { result.stdoutBytes += chunk.length; stdoutBuf += chunk.toString('utf8'); outStream.write(chunk); });
    child.stderr.on('data', (chunk) => { result.stderrBytes += chunk.length; errStream.write(chunk); });
    child.on('error', (err) => {
      result.spawnError = String(err && err.message);
      result.notes.push(`child error event: ${result.spawnError}`);
      if (!exited && !finished) { result.classification = 'spawn-error'; finish(); }
    });
    child.on('exit', (code, signal) => {
      exited = true;
      result.exitCode = code; result.signal = signal; result.exitAt = new Date().toISOString();
      const lineage = result.pid ? ctx.trackedPids.get(result.pid) : null;
      if (lineage) lineage.exitAt = Date.now();
      if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
      if (finished || closed) return;
      // Exit observed. Streams must now close; if they do not, something inherited the pipe.
      closeGraceTimer = setTimeout(() => {
        if (closed || finished) return;
        result.notes.push(`exit observed at ${result.exitAt} but stdout/stderr not closed within ${STREAM_CLOSE_GRACE_MS}ms`);
        result.classification = 'exit-without-close';
        const snap = snapshotProcesses();
        const closeTree = snap.ok ? ownedTree(result.pid, snap.rows, ctx) : null;
        result.descendantsAtDeadline = { takenAt: new Date().toISOString(), ok: snap.ok, error: snap.error, rows: closeTree ? closeTree.owned : null, unproven: closeTree ? closeTree.unproven : null };
        result.kill = terminateDirectChild(result.pid, child, ctx);
        finish();
      }, STREAM_CLOSE_GRACE_MS);
    });
    child.on('close', (code, signal) => {
      closed = true;
      result.closeAt = new Date().toISOString();
      if (closeGraceTimer) { clearTimeout(closeGraceTimer); closeGraceTimer = null; }
      if (finished) return;
      if (result.exitCode === null && code !== null) result.exitCode = code;
      if (result.signal === null && signal) result.signal = signal;
      result.tap = tallyTap(stdoutBuf);
      if (result.classification === 'running') {
        if (result.spawnError) result.classification = 'spawn-error';
        else if (result.signal) result.classification = 'killed';
        else result.classification = classifyCleanExit(result.exitCode, result.tap);
      }
      finish();
    });

    deadlineTimer = setTimeout(() => {
      if (finished || exited) return;
      const budgetCut = (started + timeoutMs) > ctx.budgetEndsAt;
      result.classification = budgetCut ? 'budget-timeout' : 'timeout';
      result.notes.push(`${result.classification}: no exit after ${Date.now() - started}ms (limit ${deadlineAt - started}ms)`);
      const snap = snapshotProcesses();
      const deadlineTree = snap.ok ? ownedTree(result.pid, snap.rows, ctx) : null;
      result.descendantsAtDeadline = { takenAt: new Date().toISOString(), ok: snap.ok, error: snap.error, rows: deadlineTree ? deadlineTree.owned : null, unproven: deadlineTree ? deadlineTree.unproven : null };
      result.tap = tallyTap(stdoutBuf);
      result.kill = terminateDirectChild(result.pid, child, ctx);
      // Give exit/close a bounded chance to arrive so the record carries them; then finish regardless.
      setTimeout(() => { if (!finished) finish(); }, KILL_GRACE_MS).unref();
    }, Math.max(0, deadlineAt - started));
  });
}

// ---------------------------------------------------------------------------------------------
// Phase scheduler: bounded concurrency, shared wall-clock budget, 'notrun' stays for whatever is
// never started (records were initialised as notrun before the phase began).
// ---------------------------------------------------------------------------------------------
async function runPhase(entries, concurrency, ctx) {
  let next = 0;
  async function worker() {
    while (next < entries.length) {
      const i = next++;
      const entry = entries[i];
      if (Date.now() >= ctx.budgetEndsAt) {
        const rec = ctx.records.get(`${entry.phase}#${entry.index}`);
        rec.notes.push('diagnostic budget exhausted before start');
        ctx.log(`NOTRUN ${entry.phase}#${entry.index} ${entry.file} (budget exhausted)`);
        ctx.flush();
        continue;
      }
      await runOne(entry, ctx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
}

// ---------------------------------------------------------------------------------------------
// Summary (JSON + Markdown), written incrementally and on every exit path. Only 'pass' is a pass;
// 'skipped' is accounted but never executed-pass; anything in flight, not run, unverified or
// leftover forces allPassed=false.
// ---------------------------------------------------------------------------------------------
function writeSummary(ctx, extra) {
  const results = [...ctx.records.values()];
  const counts = {};
  for (const r of results) counts[r.classification] = (counts[r.classification] || 0) + 1;
  const leftover = extra && extra.leftoverCheck;
  const cleanupVerified = results.every((r) => !r.kill || r.kill.status === 'verified-clean') && (!leftover || (leftover.status === 'verified-clean'));
  const allPassed = results.length > 0 && results.every((r) => r.classification === 'pass') && cleanupVerified && !(extra && extra.runnerError);
  const allAccounted = results.length > 0 && results.every((r) => r.classification === 'pass' || r.classification === 'skipped') && cleanupVerified && !(extra && extra.runnerError);
  const summary = {
    task: 879, generatedAt: new Date().toISOString(), finalized: Boolean(extra && extra.finalized),
    host: { platform: process.platform, release: os.release(), arch: process.arch, cpus: os.cpus().length, node: process.version },
    options: ctx.options, budgetStartedAt: ctx.budgetStartedAtIso,
    inventory: { requires: ctx.requires, main: ctx.inventory.main.length, pty: ctx.inventory.pty.length, selected: results.length, packageVersion: ctx.inventory.packageVersion, timeoutExceptionsMs: TIMEOUT_EXCEPTIONS_MS },
    coverageLimits: COVERAGE_LIMITS,
    counts, allPassed, allAccounted, cleanupVerified, cleanupLedger: { ...cleanupLedger },
    skippedFiles: results.filter((r) => r.classification === 'skipped').map((r) => r.file),
    ...extra, results,
  };
  writeFileSync(join(ctx.outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const lines = [];
  lines.push(`# Windows CI diagnostic #879 — ${summary.generatedAt}${summary.finalized ? '' : ' (IN PROGRESS / NOT FINALIZED)'}`, '');
  lines.push(`Node ${process.version} on ${process.platform} ${os.release()} (${os.cpus().length} cpus). Concurrency ${ctx.options.concurrency}, file timeout ${ctx.options.timeoutMs} ms (exceptions ≤ ${MAX_FILE_TIMEOUT_MS} ms), budget ${ctx.options.budgetMs} ms. Per file: \`node --require … --test --test-reporter=tap <file>\`.`, '');
  if (extra && extra.runnerError) lines.push(`**RUNNER ERROR:** ${esc(extra.runnerError)}`, '');
  lines.push(`Counts: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'} — allPassed=${allPassed} allAccounted(pass|skipped)=${allAccounted} cleanupVerified=${cleanupVerified} helperTime=${cleanupLedger.spentMs}ms/${cleanupLedger.budgetMs}ms refused=${cleanupLedger.refused}`, '');
  lines.push(`Coverage limits: ${COVERAGE_LIMITS.map(esc).join(' · ')}`, '');
  if (leftover) lines.push(`Leftover owned processes after the run: status=${leftover.status}${leftover.error ? ` (${esc(leftover.error)})` : ''}${leftover.rows && leftover.rows.length ? ' — owned: ' + esc(leftover.rows.map((p) => `${p.name}:${p.pid}`).join(', ')) : ''}${leftover.unattributed && leftover.unattributed.length ? ' — unattributed (recorded, not signalled): ' + esc(leftover.unattributed.map((p) => `${p.name}:${p.pid} (${p.reason})`).join('; ')) : ''}`, '');
  const attention = results.filter((r) => r.classification !== 'pass');
  lines.push(`## Files needing attention (${attention.length})`, '');
  lines.push('| phase | file | class | exit | signal | dur ms | exitAt | closeAt | tally (tests/pass/fail/skip, first not-ok) | descendants at deadline | kill | notes |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of attention) {
    const desc = r.descendantsAtDeadline ? (r.descendantsAtDeadline.ok ? r.descendantsAtDeadline.rows.map((d) => `${d.name}:${d.pid}`).join(' ') : `UNKNOWN: ${r.descendantsAtDeadline.error}`) : '';
    const t = r.tap ? `${r.tap.tests ?? '?'}/${r.tap.pass ?? '?'}/${r.tap.fail ?? '?'}/${r.tap.skipped ?? '?'}${r.tap.complete ? '' : ' INCOMPLETE'}${r.tap.notOk.length ? ' (' + r.tap.notOk.slice(0, 3).join('; ') + ')' : ''}` : '';
    lines.push(`| ${r.phase} | ${r.file} | **${r.classification}** | ${r.exitCode} | ${r.signal} | ${r.durationMs ?? ''} | ${r.exitAt ? r.exitAt.slice(11, 23) : ''} | ${r.closeAt ? r.closeAt.slice(11, 23) : ''} | ${esc(t)} | ${esc(desc)} | ${r.kill ? r.kill.status : ''} | ${esc((r.notes || []).join('; '))} |`);
  }
  lines.push('', '## All files', '');
  lines.push('| phase | # | file | class | exit | dur ms | tally tests/pass/fail/skip |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of results) lines.push(`| ${r.phase} | ${r.index} | ${r.file} | ${r.classification} | ${r.exitCode ?? ''} | ${r.durationMs ?? ''} | ${r.tap ? `${r.tap.tests ?? '?'}/${r.tap.pass ?? '?'}/${r.tap.fail ?? '?'}/${r.tap.skipped ?? '?'}` : ''} |`);
  const md = lines.join('\n') + '\n';
  writeFileSync(join(ctx.outDir, 'summary.md'), md);
  if (summary.finalized && process.env.GITHUB_STEP_SUMMARY) { try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, md); } catch {} }
  return summary;
}

// ---------------------------------------------------------------------------------------------
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('node scripts/windows-ci-diagnostic.mjs [--list] [--phase main|pty|all] [--out DIR] [--concurrency 1..4] [--timeout-ms N] [--budget-ms N] [--filter SUBSTR]\n');
    return 0;
  }
  const inventory = loadInventory();
  const selected = (list) => list.filter((e) => !options.filter || e.file.includes(options.filter));
  const mainEntries = options.phase === 'pty' ? [] : selected(inventory.main);
  const ptyEntries = options.phase === 'main' ? [] : selected(inventory.pty);

  if (options.list) {
    process.stdout.write(JSON.stringify({ requires: inventory.requires, main: mainEntries.map((e) => e.file), pty: ptyEntries.map((e) => e.file), timeoutExceptionsMs: TIMEOUT_EXCEPTIONS_MS, coverageLimits: COVERAGE_LIMITS }, null, 2) + '\n');
    return 0;
  }
  if (mainEntries.length + ptyEntries.length === 0) {
    process.stderr.write(`no test files selected (phase=${options.phase}, filter=${JSON.stringify(options.filter)})\n`);
    return 2;
  }

  const outDir = resolve(process.cwd(), options.out);
  const logDir = join(outDir, 'logs');
  mkdirSync(logDir, { recursive: true });
  const runnerLog = createWriteStream(join(outDir, 'runner.log'), { flags: 'a' });
  const log = (line) => { const s = `[879 ${new Date().toISOString()}] ${line}`; process.stdout.write(s + '\n'); runnerLog.write(s + '\n'); };
  const preloadPath = join(outDir, 'preload-879-handles.cjs');
  writeFileSync(preloadPath, preloadSource(HANDLE_DUMP_INTERVAL_MS));

  const budgetStartedAt = Date.now();
  // Every selected file has a record from the start — 'notrun' until it starts, 'running' while
  // in flight — so an aborted run still reports exactly what was and was not covered.
  const records = new Map();
  for (const e of [...mainEntries, ...ptyEntries]) {
    records.set(`${e.phase}#${e.index}`, { phase: e.phase, index: e.index, file: e.file, classification: 'notrun', startedAt: null, endedAt: null, durationMs: null, pid: null, exitCode: null, signal: null, exitAt: null, closeAt: null, tap: null, descendantsAtDeadline: null, kill: null, notes: [] });
  }
  const trackedPids = new Map(); // pid → { startedAt, exitAt } lineage of every per-file child
  const ctx = {
    options, inventory, requires: inventory.requires, preloadPath, outDir, logDir, log, records, trackedPids,
    timeoutMs: options.timeoutMs, budgetEndsAt: budgetStartedAt + options.budgetMs, budgetStartedAtIso: new Date(budgetStartedAt).toISOString(),
    // The diagnostic's own helpers (snapshot powershell/ps, taskkill and their conhost) are direct
    // children of this runner that are NOT tracked per-file children. Exclude them and their subtrees.
    isHelperProcess: (row) => row.ppid === process.pid && !trackedPids.has(row.pid),
    flush: null,
  };
  let runnerError = null;
  ctx.flush = (extra) => { try { writeSummary(ctx, { runnerError, ...(extra || {}) }); } catch (e) { process.stderr.write(`summary write failed: ${e && e.stack}\n`); } };
  log(`runner start node=${process.version} platform=${process.platform} release=${os.release()} cpus=${os.cpus().length} main=${mainEntries.length} pty=${ptyEntries.length} concurrency=${options.concurrency} timeout=${options.timeoutMs}ms budget=${options.budgetMs}ms cleanupBudget=${CLEANUP_BUDGET_MS}ms out=${outDir}`);
  log(`inventory requires=${JSON.stringify(inventory.requires)} exceptions=${JSON.stringify(TIMEOUT_EXCEPTIONS_MS)}`);
  ctx.flush();

  // Abort paths: mark in-flight records, persist, exit non-zero. Process cleanup of anything still
  // running then belongs to the job termination — stated in the record, not assumed.
  const abort = (reason) => {
    runnerError = reason;
    for (const r of records.values()) if (r.classification === 'running') { r.classification = 'aborted'; r.notes.push(`runner aborted while this file was in flight: ${reason}`); }
    log(reason);
    ctx.flush({ finalized: true, abortedBy: reason, leftoverCheck: { status: 'unknown', error: 'runner aborted — no final snapshot; job termination is the remaining owner', rows: null } });
    process.exit(3);
  };
  process.on('uncaughtException', (e) => abort(`uncaughtException: ${e && e.stack}`));
  process.on('unhandledRejection', (e) => abort(`unhandledRejection: ${e && (e.stack || e)}`));
  process.on('SIGINT', () => abort('SIGINT'));
  process.on('SIGTERM', () => abort('SIGTERM'));

  try {
    if (mainEntries.length) {
      log(`phase main: ${mainEntries.length} files, concurrency ${options.concurrency}`);
      await runPhase(mainEntries, options.concurrency, ctx);
      ctx.flush({ phase: 'main-complete' });
    }
    if (ptyEntries.length) {
      log(`phase pty: ${ptyEntries.length} file(s), serialized (concurrency 1)`);
      await runPhase(ptyEntries, 1, ctx);
    }
  } catch (e) {
    runnerError = `runner exception: ${e && e.stack}`;
    log(runnerError);
  }
  // Final leftover check: only processes PROVEN to descend from a tracked per-file child count
  // (parent chain + creation-time chronology against the child's recorded lifetime). A tracked pid
  // that is still in the table counts only while it is proven to be our child. Provably
  // pre-existing / reused-pid rows are `excluded` with their reason (documented; not evidence of an
  // owned leftover). Rows that cannot be attributed either way are `unattributed` and make the
  // check UNKNOWN — never clean. A failed or refused snapshot is UNKNOWN and blocks allPassed;
  // nothing is matched by name; nothing here is signalled.
  const after = snapshotProcesses();
  let leftoverCheck;
  if (!after.ok) leftoverCheck = { status: 'unknown', error: after.error, rows: null, unattributed: null, excluded: null, remainingOwner: 'disposable CI runner job termination' };
  else {
    const rows = [];
    const unattributed = [];
    const excluded = [];
    const pick = (r, pid, reason) => ({ pid: r.pid, ppid: r.ppid, name: r.name, cmd: r.cmd, startedAt: r.startedAt, root: pid, ...(reason ? { reason } : {}) });
    for (const [pid, lineage] of trackedPids) {
      const tree = ownedTree(pid, after.rows, ctx);
      for (const d of tree.owned) rows.push(pick(d, pid));
      for (const u of tree.unproven) unattributed.push(pick(u, pid, u.reason));
      for (const x of tree.excluded) excluded.push(pick(x, pid, x.reason));
      const row = after.rows.find((r) => r.pid === pid);
      const identity = rootIdentity(row, lineage);
      if (identity === 'yes') rows.push(pick(row, pid));
      else if (identity === 'unknown') unattributed.push(pick(row, pid, 'tracked pid present, creation time unknown'));
      else if (identity === 'reused') excluded.push(pick(row, pid, `tracked child ${pid} ${lineage.exitAt != null ? `exited at ${new Date(lineage.exitAt).toISOString()}` : 'has a different creation time'}; this number is held by another process`));
    }
    const status = rows.length > 0 ? 'survivors' : (unattributed.length > 0 ? 'unknown' : 'verified-clean');
    leftoverCheck = { status, error: null, rows, unattributed, excluded, remainingOwner: status === 'verified-clean' ? null : 'disposable CI runner job termination' };
  }
  const summary = writeSummary(ctx, { runnerError, finalized: true, leftoverCheck });
  log(`done: ${JSON.stringify(summary.counts)} allPassed=${summary.allPassed} allAccounted=${summary.allAccounted} cleanupVerified=${summary.cleanupVerified} leftover=${leftoverCheck.status} helperTime=${cleanupLedger.spentMs}ms elapsed=${Date.now() - budgetStartedAt}ms`);
  runnerLog.end();
  if (runnerError) return 3;
  return summary.allAccounted ? 0 : 1;
}

// Entry point only, so test/test-runner-manifest.test.js can import preloadSource without a run.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`${e && e.stack}\n`); process.exitCode = 2; });
}
