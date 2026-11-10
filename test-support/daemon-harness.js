'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const projectRoot = path.resolve(__dirname, '..');

let sessionCounter = 0;

// Task 1215 CI609 (MEASUREMENT ONLY): opt-in exactly TELEPTY_CI_OBSERVE607=1; unset, every CI609 path is skipped. Records
// are JSONL under the fixed literal <repo>/ci-observe607/, one file per process, bounded. Labels come from closed sets;
// env values, headers, bodies, prompts and command lines are never recorded. Recording never changes an outcome.
const OBSERVE607 = process.env.TELEPTY_CI_OBSERVE607 === '1';
const OBSERVE607_DIR = path.join(projectRoot, 'ci-observe607');
const OBS_LABELS = { arm: /^[ABCD]$/.test(process.env.TELEPTY_CI_OBSERVE607_ARM || '') ? process.env.TELEPTY_CI_OBSERVE607_ARM : 'unknown',
  iter: /^[0-9]{1,2}$/.test(process.env.TELEPTY_CI_OBSERVE607_ITER || '') ? Number(process.env.TELEPTY_CI_OBSERVE607_ITER) : 'unknown' };
const OBS_MAX_LINES = 4000, OBS_MAX_BYTES = 4 * 1024 * 1024, obsState = { lines: 0, bytes: 0, dropped: 0 };
const OBS_SESSION = /^[A-Za-z0-9_.-]{1,128}$/, obsSession = (v) => (typeof v === 'string' && OBS_SESSION.test(v) ? v : null);
function observe607(role, record) {
  if (!OBSERVE607) return;
  try {
    const line = JSON.stringify({ schema: 'telepty.ci-observe607/v1', utc: new Date().toISOString(), t_ms: Date.now(), pid: process.pid,
      ...OBS_LABELS, dropped_before: obsState.dropped, ...record }) + '\n';
    if (obsState.lines >= OBS_MAX_LINES || obsState.bytes + Buffer.byteLength(line) > OBS_MAX_BYTES) { obsState.dropped++; return; }
    fs.mkdirSync(OBSERVE607_DIR, { recursive: true });
    fs.appendFileSync(path.join(OBSERVE607_DIR, `${role === 'test' ? 'test' : 'harness'}-${process.pid}.jsonl`), line);
    obsState.lines++; obsState.bytes += Buffer.byteLength(line);
  } catch { /* measurement only */ }
}
// Fixed-shape copy of a daemon [telepty-diag] JSON body: lower-case keys, numbers/booleans/null and code-shaped tokens only.
function obsSanitize(v, depth = 0) {
  if (v === null || typeof v === 'boolean' || Number.isFinite(v)) return v;
  if (typeof v === 'string') return diagToken(v);
  if (depth >= 3 || typeof v !== 'object') return null;
  if (Array.isArray(v)) return v.slice(0, 8).map((x) => obsSanitize(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v).slice(0, 48)) if (/^[a-z][a-z0-9_]{0,47}$/.test(k)) out[k] = obsSanitize(x, depth + 1);
  return out;
}
const obsRoute = (p) => p.split('/').map((s) => (s === '' || /^[a-z][A-Za-z_-]{0,40}$/.test(s) ? s : ':id')).join('/');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 50;
  const description = options.description ?? 'condition';
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error(`Timed out waiting for ${description}`);
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, '').replace(/\u001b\].*?\u0007/g, '');
}

function createSessionId(prefix = 'session') {
  sessionCounter += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${sessionCounter}`;
}

function getShellSpec() {
  if (process.platform === 'win32') {
    return { command: 'powershell', args: ['-NoLogo', '-NoProfile'] };
  }

  return { command: 'bash', args: ['--noprofile', '--norc'] };
}

// Spawn-env overrides that make `homeDir` the EFFECTIVE home of a child process. `os.homedir()`
// reads USERPROFILE on win32 and HOME elsewhere, so a fixture that overrides HOME alone is read
// by the product under its real profile on Windows (#879: measured in release-0.4.5-bugfixes and
// cross-machine-ssh-routing — seeded state invisible, token mismatch, "no daemon detected").
function homeEnv(homeDir) {
  return process.platform === 'win32'
    ? { HOME: homeDir, USERPROFILE: homeDir }
    : { HOME: homeDir };
}

function createTempHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-home-'));
  return { homeDir, env: homeEnv(homeDir) };
}

// Bounded shutdown of an owned daemon child (#879). Grace after kill() before escalating to
// SIGKILL, then a second bound after which the shutdown is reported as a FAILURE, not assumed.
const TERMINATE_GRACE_MS = 2000;
const TERMINATE_KILL_MS = 5000;

// Match the daemon's startup banner ("… listening on http://<host>:<port>") to
// read back the OS-assigned port when the daemon is launched with PORT=0.
const LISTENING_BANNER = /listening on https?:\/\/[^\s]+:(\d+)/;

async function parseResponse(response) {
  const text = await response.text();
  let body = null;

  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  return {
    response,
    status: response.status,
    headers: response.headers,
    text,
    body
  };
}

// Task 1215 harness129: a TEST-HARNESS bound on previously unbounded HTTP waits (not a product deadline, and not a
// claim that real responses must be faster). One deadline covers the response headers AND the body. A caller
// AbortSignal is optional. The deadline and an external abort are distinct typed outcomes (HARNESS_REQUEST_TIMEOUT /
// HARNESS_REQUEST_ABORTED) whose diagnostics carry only method, route without query, elapsed time and code. Any other
// failure is rethrown unchanged. The timer and listener are released on every path.
// Task 1215 harness133: the default is 5000 ms. An EXPLICIT per-call `timeoutMs` (finite and positive) may raise or
// lower it, hard-capped at HARNESS_REQUEST_MAX_MS, so it stays below the 60 s file kill. Callers whose product
// legitimately waits longer opt in with that request's own product bound + HARNESS_OBSERVATION_MARGIN_MS. This is an
// observation cap, never a product deadline. The fixture-level `requestTimeoutMs` stays lower-only.
const REQUEST_TIMEOUT_MS = 5000;
const HARNESS_REQUEST_MAX_MS = 30000;
const HARNESS_OBSERVATION_MARGIN_MS = 2000;
const STOP_CLEANUP_MS = 10000;
const lowered = (value, max) => (Number.isFinite(value) && value > 0 ? Math.min(value, max) : max);
function requestBudget(timeoutMs) {
  if (timeoutMs === undefined || timeoutMs === null) return REQUEST_TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw Object.assign(new TypeError('daemon-harness request timeoutMs must be a finite positive number (HARNESS_REQUEST_INVALID_TIMEOUT)'),
      { code: 'HARNESS_REQUEST_INVALID_TIMEOUT' });
  }
  return Math.min(timeoutMs, HARNESS_REQUEST_MAX_MS);
}

function harnessRequestError(code, method, route, elapsedMs) {
  const what = code === 'HARNESS_REQUEST_TIMEOUT' ? 'no complete response within the harness deadline' : 'aborted by the caller';
  return Object.assign(new Error(`daemon-harness ${method} ${route}: ${what} after ${elapsedMs}ms (${code})`),
    { code, method, route, elapsed_ms: elapsedMs });
}

// Task 1215 observe148 (failure-only diagnostics): fixed-shape pickers for the ONE bounded cleanup diagnostic episode.
// They copy only numeric, boolean and code-token fields that the routes already expose: /api/health {status},
// /api/meta event_loop (src/diagnostics/event-loop.js snapshot) and audit_writer (src/audit/inject-log.js status). They
// never copy ids, host/port/pid, timestamps, previews or bodies. Anything missing or malformed is 'unavailable'.
const DIAG_TOKEN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const diagNumber = (v) => (Number.isFinite(v) ? v : null);
const diagBool = (v) => (typeof v === 'boolean' ? v : null);
const diagToken = (v) => (typeof v === 'string' && DIAG_TOKEN.test(v) ? v : null);
function diagEventLoop(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'unavailable';
  const l = e.latest && typeof e.latest === 'object' ? e.latest : null;
  return { status: diagToken(e.status), freshness_ms: diagNumber(e.freshness_ms), stale: diagBool(e.stale),
    latest: l ? { window_ms: diagNumber(l.window_ms), count: diagNumber(l.count), p50_ms: diagNumber(l.p50_ms), p99_ms: diagNumber(l.p99_ms),
      max_ms: diagNumber(l.max_ms) } : null,
    last_stall_max_ms: e.last_stall && typeof e.last_stall === 'object' ? diagNumber(e.last_stall.max_ms) : null };
}
function diagAuditWriter(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return 'unavailable';
  const out = {};
  for (const k of ['queued', 'appended', 'written_lines', 'batches', 'dropped', 'errors', 'flush_ms', 'timer_armed_ms_ago', 'writing_for_ms',
    'last_write_ms', 'max_write_ms', 'last_write_end_ms_ago']) out[k] = diagNumber(a[k]);
  for (const k of ['closed', 'timer_armed', 'writing']) out[k] = diagBool(a[k]);
  out.last_error_code = diagToken(a.last_error_code); out.writing_stage = diagToken(a.writing_stage);
  return out;
}
// Task 1215 diag153 (failure-only): sanitized markers from the OWNED daemon's own captured output. Only these are kept,
// each list bounded to DIAG_LIST_MAX:
//   - whitelisted error class names that start a line;
//   - code tokens (E…, ERR_…, UND_ERR_…);
//   - stack-frame function names (never paths);
//   - fatal-marker booleans and counts of the daemon's fixed line prefixes.
// Never a message, path, prompt, id, token, body or command line. `scrub` removes caller-known secrets (the auth
// token) before scanning. The scan is limited to the last DIAG_LOG_WINDOW characters.
const DIAG_LOG_WINDOW = 65536, DIAG_LIST_MAX = 8, DIAG_JSON_MAX = 8192;
const DIAG_ERROR_NAMES = ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'AggregateError', 'AbortError', 'SystemError', 'EvalError', 'URIError'];
const DIAG_FATAL = [['uncaught_exception', /\buncaughtException\b|^Uncaught\b/m], ['unhandled_rejection', /\bunhandledRejection\b|UnhandledPromiseRejection/],
  ['fatal_error', /FATAL ERROR/], ['native_assertion', /Assertion failed/]];
const DIAG_LINE_PREFIXES = ['[KILL]', '[EXIT]', '[LEDGER]', '[AUDIT]', '[DAEMON]', '[CLEANUP]'];
function diagnosticLogMarkers(text, { scrub = [] } = {}) {
  let tail = typeof text === 'string' ? text.slice(-DIAG_LOG_WINDOW) : '';
  for (const secret of scrub) if (typeof secret === 'string' && secret) tail = tail.split(secret).join('');
  const lines = tail.split(/\r?\n/);
  const errorNames = [], errorCodes = [], stackFunctions = [];
  const add = (list, value) => { if (!list.includes(value) && list.length < DIAG_LIST_MAX) list.push(value); };
  for (const line of lines) {
    const named = /^\s*(?:Uncaught\s+)?([A-Z][A-Za-z]{0,31})(?=:|\s|$)/.exec(line);
    if (named && DIAG_ERROR_NAMES.includes(named[1])) add(errorNames, named[1]);
    for (const m of line.matchAll(/\b(E[A-Z]{2,15}|ERR_[A-Z0-9_]{2,48}|UND_ERR_[A-Z0-9_]{2,40})\b/g)) add(errorCodes, m[1]);
    const frame = /^\s+at (?:async )?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$<][\w$<>]*){0,3}) \(/.exec(line);
    if (frame && frame[1].length <= 64) add(stackFunctions, frame[1]);
  }
  const fatal = {};
  for (const [key, pattern] of DIAG_FATAL) fatal[key] = pattern.test(tail);
  const lineCounts = {};
  for (const prefix of DIAG_LINE_PREFIXES) lineCounts[prefix] = lines.filter((line) => line.startsWith(prefix)).length;
  return { window_bytes: tail.length, error_names: errorNames, error_codes: errorCodes, stack_functions: stackFunctions, fatal, line_prefix_counts: lineCounts };
}
// A cleanup failure on the TRANSPORT (refused/reset/socket), as opposed to a harness-typed outcome or an HTTP answer.
const DIAG_TRANSPORT_CODE = /^(E[A-Z]{2,15}|UND_ERR_[A-Z0-9_]{2,40})$/;
function transportCauseCode(error) {
  for (let e = error, depth = 0; e && typeof e === 'object' && depth < 4; e = e.cause, depth++) {
    if (typeof e.code === 'string' && DIAG_TRANSPORT_CODE.test(e.code)) return e.code;
  }
  return null;
}
function isTransportFailure(error) {
  if (!error || typeof error !== 'object') return false;
  if (typeof error.code === 'string' && error.code.startsWith('HARNESS_')) return false;
  return transportCauseCode(error) !== null || (error instanceof TypeError && error.cause !== undefined);
}

function diagProbeShape(p, pick) {
  if (!p.answered) return { answered: false, unavailable: p.unavailable, total_ms: p.total_ms };
  return { answered: true, http_status: p.http_status, headers_ms: p.headers_ms, total_ms: p.total_ms, ...pick(p.body) };
}

async function boundedRequest(url, init = {}, { timeoutMs, signal, observe } = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  const route = new URL(url).pathname;
  const budget = requestBudget(timeoutMs);
  const begun = Date.now();
  const controller = new AbortController();
  // observe148: `stage` says whether headers or the body were still pending, and `timerLateMs` how late this
  // process's own timer fired. Both are added to the ORIGINAL timeout error only.
  let outcome = null, stage = 'headers', timerLateMs = null;
  // CI609 (only when request() passes `observe`): the timeout is DECIDED at the unchanged instant, but the original
  // request is left running while `observe` records (bounded); it is then aborted and that ORIGINAL error is thrown.
  let decide = null, observedTimeout = null;
  const decision = observe ? new Promise((resolve) => { decide = resolve; }) : null;
  const onAbort = () => { if (!outcome) outcome = 'HARNESS_REQUEST_ABORTED'; controller.abort(); };
  const timer = setTimeout(() => {
    if (!outcome) { outcome = 'HARNESS_REQUEST_TIMEOUT'; timerLateMs = Math.max(0, Date.now() - begun - budget); }
    if (decide && outcome === 'HARNESS_REQUEST_TIMEOUT') decide(); else controller.abort();
  }, budget);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    if (decision) {
      const op = (async () => { const response = await fetch(url, { ...init, signal: controller.signal }); stage = 'body'; return parseResponse(response); })();
      const first = await Promise.race([op.then((value) => ({ value }), (error) => ({ error })), decision.then(() => null)]);
      if (first) { if ('value' in first) return first.value; throw first.error; }
      observedTimeout = Object.assign(harnessRequestError(outcome, method, route, Date.now() - begun),
        { budget_ms: budget, stage, timer_late_ms: timerLateMs });
      try { await observe(observedTimeout, op, begun); } catch { /* measurement only */ }
      controller.abort(); op.catch(() => {});
      throw observedTimeout;
    }
    const response = await fetch(url, { ...init, signal: controller.signal });
    stage = 'body';
    return await parseResponse(response);
  } catch (error) {
    if (observedTimeout && error === observedTimeout) throw error;
    if (outcome) {
      throw Object.assign(harnessRequestError(outcome, method, route, Date.now() - begun),
        outcome === 'HARNESS_REQUEST_TIMEOUT' ? { budget_ms: budget, stage, timer_late_ms: timerLateMs } : {});
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function startTestDaemon(options = {}) {
  // Bind an OS-assigned ephemeral port (PORT=0) unless the caller pins one. This is
  // collision-free: the daemon holds the socket continuously from the moment the kernel
  // assigns the port, so no other process or test can ever take it (unlike picking a
  // random/probed port, which leaves a TOCTOU window — the source of the CI EADDRINUSE
  // flake on ubuntu and the systematic EACCES on Windows reserved ranges). The actual
  // port is read back from the daemon's startup banner below.
  const requestedPort = options.port ?? 0;
  const host = options.host ?? '127.0.0.1';
  // Task 1215 harness129: focused fixture tests may only LOWER these bounds.
  const requestTimeoutMs = lowered(options.requestTimeoutMs, REQUEST_TIMEOUT_MS);
  const cleanupTimeoutMs = lowered(options.cleanupTimeoutMs, STOP_CLEANUP_MS);
  // Resolved to the real OS-assigned port after read-back when requestedPort === 0.
  let port = requestedPort;
  let portResolved = requestedPort !== 0;
  // A caller may supply its own HOME so two successive daemons can share one — the shape a
  // daemon-RESTART test needs (#815: a persisted credential verifier must survive it). When the
  // caller owns the directory, stop() must not delete it out from under the next daemon.
  const ownsHome = !options.homeDir;
  const { homeDir, env: homeDirEnv } = ownsHome
    ? createTempHome()
    : { homeDir: options.homeDir, env: homeEnv(options.homeDir) };
  const sharedEnv = {
    ...process.env,
    ...homeDirEnv,
    ...(options.env || {}),
    NO_UPDATE_NOTIFIER: '1',
    TELEPTY_DISABLE_UPDATE_NOTIFIER: '1'
  };
  const daemonEnv = {
    ...sharedEnv,
    PORT: String(requestedPort),
    HOST: host
  };

  let stdout = '';
  let stderr = '';

  const child = spawn(process.execPath, ['daemon.js'], {
    cwd: projectRoot,
    env: daemonEnv,
    // Task 1215 W3: the IPC channel is how a Windows normal stop reaches the daemon's own shutdown().
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });

  // CI609 (opt-in): receive time of each `[EXIT] Session <sid>` line (M2) and sanitized `[telepty-diag]` lines (M3).
  const exitLineAt = new Map(), lineTail = { stdout: '', stderr: '' };
  function observeLines(stream, chunk) {
    const lines = (lineTail[stream] + chunk).split(/\r?\n/), at = Date.now();
    lineTail[stream] = lines.pop().slice(-8192);
    for (const line of lines) {
      const exit = /^\[EXIT\] Session (\S{1,128}) exited with code/.exec(line), session = exit && obsSession(exit[1]);
      if (session && !exitLineAt.has(session)) exitLineAt.set(session, at);
      if (exit) observe607('harness', { stage: 'daemon_exit_line', session, received_ms: at });
      const diag = /^\[telepty-diag\] (submit_barrier|http_delivery) (\{.*\})$/.exec(line);
      if (!diag) continue;
      let fields; try { fields = obsSanitize(JSON.parse(diag[2])); } catch { fields = 'unparsed'; }
      observe607('harness', { stage: 'daemon_diag_line', stream, category: diag[1], received_ms: at, fields });
    }
  }

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    if (OBSERVE607) observeLines('stdout', chunk.toString());
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (OBSERVE607) observeLines('stderr', chunk.toString());
  });

  // #879 — exit is a FACT recorded from the 'exit' event, never inferred from `child.exitCode`.
  // `child.kill()` on Windows is TerminateProcess, which libuv reports as a SIGNAL exit: exitCode
  // stays null and signalCode becomes 'SIGTERM'. The old predicate `child.exitCode === null` read
  // a daemon killed that way as still alive, so the next kill()/stop() on the same handle waited
  // on an 'exit' event that had already been emitted — with no timer and no I/O behind it. That
  // is the measured restart hang (run 40500878932: session-token-issuance-815 and
  // observation-tracking-endpoint-60, pending test promise, only the suite daemon left as a handle).
  const exitState = { exited: false, code: null, signal: null };
  let exitAt = null; // Task 1215 diag153: failure-only relative exit time (kept off exitState, whose shape callers see)
  child.once('exit', (code, signal) => {
    exitAt = Date.now();
    exitState.exited = true;
    exitState.code = code;
    exitState.signal = signal;
  });

  // Resolve true when the child has exited (now or within timeoutMs), false otherwise. The check
  // and the listener attach happen in the same tick, so an exit already emitted is never missed
  // and an exit emitted later is always seen; the losing timer is cancelled (#861).
  function waitForExit(timeoutMs) {
    if (exitState.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer = null;
      const onExit = () => { clearTimeout(timer); resolve(true); };
      timer = setTimeout(() => { child.off('exit', onExit); resolve(false); }, timeoutMs);
      child.once('exit', onExit);
    });
  }

  // Bounded, idempotent shutdown of the owned child. Resolves with the recorded exit; throws when
  // the child has not exited within TERMINATE_GRACE_MS + TERMINATE_KILL_MS, so a cleanup that
  // did not complete is a failure the test reports rather than a silent return or an open wait.
  async function terminateOwnedChild(label) {
    if (exitState.exited) return exitState;
    // Task 1215 W3: on win32 a normal stop first asks the daemon, over the IPC channel this harness owns,
    // to run its own shutdown() (the path POSIX reaches with SIGTERM). Only if it has not exited within
    // the existing grace does the forced path below run — and that is a CRASH (no shutdown, ledger lock
    // left), recorded as such, never as a graceful stop.
    if (process.platform === 'win32' && child.connected) {
      try { child.send({ type: 'telepty.shutdown', v: 1 }); } catch { /* channel gone: forced path below */ }
      if (await waitForExit(TERMINATE_GRACE_MS)) { exitState.stop = 'graceful_ipc'; return exitState; }
      exitState.stop = 'forced_after_ipc_timeout';
      process.stderr.write(`[daemon-harness] ${label}: graceful IPC stop of pid ${child.pid} did not complete within `
        + `${TERMINATE_GRACE_MS}ms; forcing termination (crash semantics: no shutdown, ledger lock left)\n`);
    } else if (process.platform !== 'win32') {
      exitState.stop = 'signal';
    }
    child.kill(); // POSIX: SIGTERM, the daemon's own shutdown path; win32: TerminateProcess (crash)
    if (await waitForExit(TERMINATE_GRACE_MS)) return exitState;
    child.kill('SIGKILL');
    if (await waitForExit(TERMINATE_KILL_MS)) return exitState;
    throw new Error(
      `${label}: daemon child pid ${child.pid} did not exit within `
      + `${TERMINATE_GRACE_MS + TERMINATE_KILL_MS}ms after kill() and kill('SIGKILL')`
    );
  }

  // #820 — the daemon's own secret, resolved the same way every real consumer resolves it:
  // TELEPTY_AUTH_TOKEN if the caller pinned one in the spawn env, else the config.json this
  // daemon minted under its temp HOME. Read lazily and cached, because on the readiness path the
  // file does not exist until the daemon has booted far enough to write it.
  //
  // Deliberately NOT injected into the daemon's env by default: several suites seed their own
  // config.json with a known token before starting a daemon here, and an env token would silently
  // override the one they seeded.
  let cachedAuthToken = null;
  function authToken() {
    if (cachedAuthToken == null) {
      if (daemonEnv.TELEPTY_AUTH_TOKEN) {
        cachedAuthToken = daemonEnv.TELEPTY_AUTH_TOKEN;
      } else {
        try {
          // The daemon's EFFECTIVE home, not this harness's `homeDir`: a caller may override HOME
          // through `options.env` (test/release-0.4.5-bugfixes.test.js does), in which case the
          // config.json that matters is the one under the env's HOME.
          const effectiveHome = daemonEnv.HOME || daemonEnv.USERPROFILE || homeDir;
          cachedAuthToken = JSON.parse(
            fs.readFileSync(path.join(effectiveHome, '.telepty', 'config.json'), 'utf8')
          ).authToken;
        } catch { return null; } // not written yet — do not cache the miss
      }
    }
    return cachedAuthToken;
  }

  // Every request carries the daemon token, because since #820 loopback is no longer a
  // credential. A test that wants to BE an uncredentialed caller passes `noAuth: true` — an
  // explicit act, so the absence of a credential is always something a reader can see.
  async function request(pathname, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (!options.noAuth && headers['x-telepty-token'] === undefined) {
      const token = authToken();
      if (token) headers['x-telepty-token'] = token;
    }
    const init = {
      method: options.method || 'GET',
      headers
    };

    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    return boundedRequest(`http://${host}:${port}${pathname}`, init,
      { timeoutMs: options.timeoutMs ?? requestTimeoutMs, signal: options.signal,
        // CI609: only a signal-free POST is observed. A GET poll inside waitFor, or a cleanup request under its own signal,
        // keeps the unchanged abort, so a held request can never move a waitFor/cleanup deadline or re-type a failure.
        ...(OBSERVE607 && init.method === 'POST' && !options.signal
          ? { observe: (error, op, begun) => observeRequestTimeout(error, op, begun, pathname, init.method) } : {}) });
  }

  // CI609 (opt-in): fresh bounded probes at a request-timeout decision instant. /api/meta via the existing event_loop and
  // audit_writer pickers (M1). For a POST /api/sessions/:id/inject, also that session's pendingReports entry: present,
  // injected_at relative to the request start (the tracked begin commit), and tracking_state / last observation kind (M3).
  // The ORIGINAL request is observed for at most OBS_EVENTUAL_MS more (eventual status). Nothing is re-sent or retried.
  const OBS_PROBE_MS = 2000, OBS_EVENTUAL_MS = 12000;
  async function obsProbe(pathname) {
    const at = Date.now();
    try {
      const token = authToken();
      const r = await fetch(`http://${host}:${port}${pathname}`, { headers: token ? { 'x-telepty-token': token } : {}, signal: AbortSignal.timeout(OBS_PROBE_MS) });
      let body = null; try { body = JSON.parse(await r.text()); } catch { body = null; }
      return { http_status: r.status, ms: Date.now() - at, body };
    } catch (e) { return { unavailable: e && e.name === 'TimeoutError' ? 'probe_bound' : (diagToken(e && e.cause && e.cause.code) || 'error'), ms: Date.now() - at }; }
  }
  async function observeMeta() {
    const p = await obsProbe('/api/meta');
    return p.body ? { http_status: p.http_status, ms: p.ms, event_loop: diagEventLoop(p.body.event_loop), audit_writer: diagAuditWriter(p.body.audit_writer) }
      : { http_status: p.http_status ?? null, ms: p.ms, unavailable: p.unavailable || 'no_body' };
  }
  async function observeRequestTimeout(error, op, begun, pathname, method) {
    const decidedMs = Date.now() - begun;
    const inject = String(method || 'GET').toUpperCase() === 'POST' ? /^\/api\/sessions\/([^/?]{1,200})\/inject$/.exec(pathname) : null;
    let boundTimer = null;
    const eventual = Promise.race([op.then((r) => ({ outcome: 'answered', http_status: r.status, at_ms: Date.now() - begun }),
      (e) => ({ outcome: 'error', code: diagToken(e && (e.code || e.name)), at_ms: Date.now() - begun })),
    new Promise((resolve) => { boundTimer = setTimeout(() => resolve({ outcome: 'unsettled_at_bound', bound_ms: OBS_EVENTUAL_MS }), OBS_EVENTUAL_MS); })]);
    const pending = inject ? obsProbe(`/api/pendingReports/${inject[1]}`).then((p) => (p.body ? { http_status: p.http_status, ms: p.ms, present: p.http_status === 200,
      injected_at_ms: Number.isFinite(Date.parse(p.body.injected_at)) ? Date.parse(p.body.injected_at) - begun : null,
      tracking_state: diagToken(p.body.tracking_state), last_observation_kind: diagToken(p.body.last_observation && p.body.last_observation.kind) } : p)) : null;
    const [meta, pend, ev] = await Promise.all([observeMeta(), pending, eventual]);
    clearTimeout(boundTimer);
    let session = null; try { session = inject ? obsSession(decodeURIComponent(inject[1])) : null; } catch { session = null; }
    observe607('harness', { stage: 'request_timeout', method: diagToken(String(method || 'GET').toUpperCase()), route: obsRoute(pathname), session,
      decided_ms: decidedMs, budget_ms: error.budget_ms, http_stage: error.stage, timer_late_ms: error.timer_late_ms, meta, pending: pend, eventual: ev });
  }

  await waitFor(async () => {
    if (exitState.exited) {
      throw new Error(`Daemon exited early.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }

    if (!portResolved) {
      const match = stdout.match(LISTENING_BANNER);
      if (!match) {
        return false; // banner not printed yet — keep waiting
      }
      port = Number(match[1]);
      portResolved = true;
    }

    try {
      // #820: /api/health, not /api/sessions. Health is registered BEFORE the auth middleware
      // (daemon.js), so readiness no longer depends on holding a credential — which matters
      // because the credential is a file this daemon has not necessarily written yet.
      const health = await boundedRequest(`http://${host}:${port}/api/health`, {}, { timeoutMs: requestTimeoutMs });
      return health.response.ok;
    } catch {
      return false;
    }
  }, { timeoutMs: 7000, description: 'daemon start' });

  // #1207 — the tracked-injection store opens asynchronously, AFTER the listener is up, and a tracked
  // inject (`from` set) is refused `503 recovering` until it has. Tests written against the old
  // synchronous ledger send one right after start, so by default readiness also waits (bounded) until
  // the store has SETTLED — any state but `not_opened` / `recovering`; `lock_present` and the
  // unavailable states count as settled and are left for the test to assert. A status this harness
  // cannot read (non-200) is not waited on, and a timeout proceeds unchanged rather than adding a
  // failure. `awaitLedger: false` keeps the old readiness for tests that observe the recovery itself.
  if (options.awaitLedger !== false) {
    const deadline = Date.now() + (options.ledgerTimeoutMs ?? 10000);
    while (Date.now() < deadline && !exitState.exited) {
      let store = null;
      try {
        const status = await request('/api/ledger/status');
        if (status.status !== 200 || !status.body || !status.body.client) break;
        store = status.body.client.store;
      } catch { break; }
      if (store !== 'not_opened' && store !== 'recovering') break;
      await delay(25);
    }
  }

  // Task 1215 harness133: an exact 403 OWNED_DELETE_FORBIDDEN (session-actions.js owned/protected DELETE) is the
  // contract refusing a token-only delete. That listed session is counted, excluded from the drain predicate and left
  // to the owned-daemon termination. Not excused:
  //   - transport/timeout/abort errors (rethrown as-is);
  //   - every other non-2xx, including 404 "Exact session id required.", because this list supplied exact ids
  //     (HARNESS_CLEANUP_DELETE_FAILED);
  //   - a 2xx-deleted session still listed after the drain wait.
  // Task 1215 harness136: the one ALREADY-ABSENT answer is idempotent. A listed session can be removed by someone else
  // between this list and its DELETE: for example the `telepty allow` bridge's own exit DELETE
  // (src/cli/security-actions.js) racing a test's teardown (cli.test.js kills the bridge, then afterEach stop()). The
  // DELETE route answers exactly 404 { error: 'Session not found', requested: <the id> } when the record no longer
  // resolves (src/routes/session-actions.js). That exact body, for the exact listed id, is counted `absent`. The
  // session stays IN the drain predicate, so it must really be gone. Every other 404 (e.g. 'Exact session id
  // required.', or a different `requested`) still fails.
  // Returns a fixed-shape summary: counts plus status/code keys only, never ids, bodies or messages.
  const DIAG_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
  // Task 1215 observe148 (failure-only): when cleanup fails with HARNESS_REQUEST_TIMEOUT, run at most ONE extra bounded
  // diagnostic episode per daemon, then RETHROW THE ORIGINAL ERROR with `cleanup_diagnostic` attached:
  // - The episode is fresh: unauthenticated GET /api/health, then GET /api/meta, both direct fetch calls under one
  //   AbortController. They never go through request()/boundedRequest()/cleanupSessions(), so there is no recursion
  //   and no retry.
  // - Its total budget is min(2000 ms, remaining stop() cleanup budget - margin), so it cannot cross stop()'s own bound
  //   and re-type the failure. Abort closes pending bodies, and the timer and listener are released.
  // - It only says what the owned daemon answered. A non-answer is 'unavailable', never proof of an event-loop cause.
  // No diagnostic failure ever replaces, hides or passes the original error.
  const DIAG_EPISODE_MS = 2000, DIAG_EPISODE_MARGIN_MS = 100;
  let diagnosticEpisodeUsed = false;
  async function cleanupDiagnosticEpisode({ signal, remainingMs } = {}) {
    const daemonState = () => ({ exited: exitState.exited, exit_code: Number.isInteger(exitState.code) ? exitState.code : null,
      exit_signal: typeof exitState.signal === 'string' && /^SIG[A-Z0-9]{1,16}$/.test(exitState.signal) ? exitState.signal : null });
    if (diagnosticEpisodeUsed) return { episode: 'already_used', daemon: daemonState() };
    diagnosticEpisodeUsed = true;
    if (exitState.exited) return { episode: 'skipped_daemon_exited', daemon: daemonState() };
    const budget = Math.min(DIAG_EPISODE_MS, typeof remainingMs === 'function' ? remainingMs() - DIAG_EPISODE_MARGIN_MS : DIAG_EPISODE_MS);
    if (!(budget > 0) || (signal && signal.aborted)) return { episode: 'skipped_no_budget', daemon: daemonState() };
    const controller = new AbortController(), begun = Date.now();
    const timer = setTimeout(() => controller.abort(), budget);
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const probe = async (pathname, headers) => {
      const at = Date.now();
      try {
        const res = await fetch(`http://${host}:${port}${pathname}`, { headers, signal: controller.signal });
        const headersMs = Date.now() - at;
        let body;
        try { body = JSON.parse(await res.text()); } catch { body = undefined; }
        return { answered: true, http_status: res.status, headers_ms: headersMs, total_ms: Date.now() - at, body };
      } catch (error) {
        return { answered: false, unavailable: controller.signal.aborted ? 'episode_bound' : (diagToken(error && error.cause && error.cause.code) || 'error'),
          total_ms: Date.now() - at };
      }
    };
    try {
      const health = await probe('/api/health', {});
      let token = null; try { token = authToken(); } catch { token = null; }
      const meta = await probe('/api/meta', token ? { 'x-telepty-token': token } : {});
      return { episode: 'ran', budget_ms: budget, elapsed_ms: Date.now() - begun, daemon: daemonState(),
        health: diagProbeShape(health, (b) => ({ status: (b && diagToken(b.status)) || 'unavailable' })),
        meta: diagProbeShape(meta, (b) => ({ event_loop: diagEventLoop(b && b.event_loop), audit_writer: diagAuditWriter(b && b.audit_writer) })) };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }
  // Task 1215 diag153 (failure-only): a cleanup that failed on the TRANSPORT (not a harness-typed outcome) gets ONE
  // fixed-shape `cleanup_diagnostic` on the ORIGINAL error, which is rethrown unchanged. Contents:
  //   - the failure's whitelisted name and transport cause code, with its time from the cleanup start;
  //   - the owned child's exit facts (exited, code, signal, exit time relative to the cleanup start);
  //   - sanitized output markers (diagnosticLogMarkers, auth token scrubbed);
  //   - `probe`: the SAME at-most-once-per-daemon observe148 episode (skipped when the daemon has exited), so a
  //     timeout and a transport failure on one daemon never both probe.
  // No success-path traffic, no retry, no change to cleanup semantics.
  function transportDiagnostic(error, begun) {
    let token = null; try { token = authToken(); } catch { token = null; }
    const scrub = [token].filter(Boolean);
    const cause = error.cause && typeof error.cause === 'object' ? error.cause : null;
    return { trigger: 'transport',
      failure: { name: DIAG_ERROR_NAMES.includes(error.name) ? error.name : 'other', cause_name: cause && DIAG_ERROR_NAMES.includes(cause.name) ? cause.name : (cause ? 'other' : null),
        cause_code: transportCauseCode(error), at_ms: Date.now() - begun },
      daemon: { exited: exitState.exited, exit_code: Number.isInteger(exitState.code) ? exitState.code : null,
        exit_signal: typeof exitState.signal === 'string' && /^SIG[A-Z0-9]{1,16}$/.test(exitState.signal) ? exitState.signal : null,
        exited_at_ms: exitAt === null ? null : exitAt - begun },
      markers: { stderr: diagnosticLogMarkers(stderr, { scrub }), stdout: diagnosticLogMarkers(stdout, { scrub }) } };
  }
  async function cleanupSessions({ signal, remainingMs } = {}) {
    const begun = Date.now();
    try {
      return await cleanupSessionsObserved({ signal });
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'HARNESS_REQUEST_TIMEOUT' && Object.isExtensible(error)
        && !Object.hasOwn(error, 'cleanup_diagnostic')) {
        try { error.cleanup_diagnostic = await cleanupDiagnosticEpisode({ signal, remainingMs }); }
        catch { error.cleanup_diagnostic = { episode: 'unavailable' }; }
      } else if (isTransportFailure(error) && Object.isExtensible(error) && !Object.hasOwn(error, 'cleanup_diagnostic')) {
        try {
          const diagnostic = transportDiagnostic(error, begun);
          try { diagnostic.probe = await cleanupDiagnosticEpisode({ signal, remainingMs }); }
          catch { diagnostic.probe = { episode: 'unavailable' }; }
          error.cleanup_diagnostic = diagnostic;
        } catch { error.cleanup_diagnostic = { trigger: 'transport', episode: 'unavailable' }; }
      }
      // Task 1215 win158 (failure-only): the spec reporter prints nested error properties only to a fixed depth (CI run
      // 41281433751 showed the markers as `[Object]`). The SAME fixed-schema object is therefore also attached as bounded
      // JSON text. There is nothing new in it, and the original error, its code and its message are unchanged.
      if (error && typeof error === 'object' && Object.isExtensible(error) && Object.hasOwn(error, 'cleanup_diagnostic')
        && !Object.hasOwn(error, 'cleanup_diagnostic_json')) {
        try {
          const text = JSON.stringify(error.cleanup_diagnostic);
          if (typeof text === 'string') error.cleanup_diagnostic_json = text.length <= DIAG_JSON_MAX ? text : `${text.slice(0, DIAG_JSON_MAX)}…(truncated)`;
        } catch { /* the object stays attached; text is only a rendering */ }
      }
      throw error;
    }
  }
  async function cleanupSessionsObserved({ signal } = {}) {
    const summary = { listed: 0, deleted: 0, absent: 0, refused: 0, failed: 0, refused_codes: {}, failed_statuses: {} };
    const list = await request('/api/sessions', { signal });
    if (list.status !== 200 || !Array.isArray(list.body)) {
      return summary;
    }
    summary.listed = list.body.length;

    const outcomes = await Promise.allSettled(list.body.map(async (session) => ({ id: session.id,
      res: await request(`/api/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE', signal }) })));
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    if (rejected) throw rejected.reason;
    const refusedIds = new Set();
    for (const { value: { id, res } } of outcomes) {
      const code = res.body && typeof res.body.code === 'string' && DIAG_CODE.test(res.body.code) ? res.body.code : null;
      if (res.status >= 200 && res.status < 300) summary.deleted++;
      else if (res.status === 404 && res.body && res.body.error === 'Session not found' && res.body.requested === id) summary.absent++;
      else if (res.status === 403 && code === 'OWNED_DELETE_FORBIDDEN') {
        summary.refused++; refusedIds.add(id); summary.refused_codes[code] = (summary.refused_codes[code] || 0) + 1;
      } else {
        const key = code ? `${res.status}:${code}` : String(res.status);
        summary.failed++; summary.failed_statuses[key] = (summary.failed_statuses[key] || 0) + 1;
      }
    }
    if (summary.failed > 0) {
      throw Object.assign(new Error(`daemon-harness cleanupSessions: ${summary.failed} of ${summary.listed} DELETE(s) answered `
        + `non-2xx ${JSON.stringify(summary.failed_statuses)} (HARNESS_CLEANUP_DELETE_FAILED)`), { code: 'HARNESS_CLEANUP_DELETE_FAILED', summary });
    }

    await waitFor(async () => {
      const current = await request('/api/sessions', { signal });
      return current.status === 200 && Array.isArray(current.body) && current.body.every((session) => refusedIds.has(session.id));
    }, { description: 'session cleanup' }).catch((error) => {
      // harness136: the drain is the truth check for `deleted` and `absent`; its failure carries the counts.
      if (error && typeof error === 'object' && Object.isExtensible(error) && !Object.hasOwn(error, 'summary')) error.summary = summary;
      throw error;
    });
    return summary;
  }

  // Task 1215 harness129: stop()'s cleanup signal is INDEPENDENT and bounded (cleanupTimeoutMs). A still-live case
  // signal can end it earlier; an already-aborted one is ignored, so teardown still gets its bounded cleanup.
  function cleanupSignal(caseSignal) {
    const controller = new AbortController();
    let expired = false;
    const timer = setTimeout(() => { expired = true; controller.abort(); }, cleanupTimeoutMs);
    const endsAt = Date.now() + cleanupTimeoutMs; // observe148: lets the diagnostic episode stay inside this bound
    const onCaseAbort = () => controller.abort();
    const follow = caseSignal && !caseSignal.aborted;
    if (follow) caseSignal.addEventListener('abort', onCaseAbort, { once: true });
    return { signal: controller.signal, expired: () => expired, remainingMs: () => endsAt - Date.now(),
      dispose() { clearTimeout(timer); if (follow) caseSignal.removeEventListener('abort', onCaseAbort); } };
  }

  // Kill the daemon process WITHOUT the cleanupSessions() pass stop() does. A restart test needs
  // this: cleanupSessions DELETEs every session, and DELETE revokes credentials (#815), so
  // stopping politely would destroy the very state the restart is supposed to carry across.
  // Idempotent: a second kill() (or a stop()) after the child exited returns at once.
  //
  // Windows note (#879, unchanged product semantics): TerminateProcess runs none of the daemon's
  // shutdown handlers, so ConPTY shells of a kill()ed daemon are left to the job's termination.
  // The diagnostic runner records them as unattributed/unknown — never as clean.
  async function kill() {
    await terminateOwnedChild('kill()');
  }

  // Task 1215 harness129: termination of the owned child is reached in `finally` whatever the bounded cleanup did.
  // A cleanup failure is no longer swallowed: it is rethrown AFTER termination. A cleanup that ran out of its own
  // bound is typed HARNESS_STOP_CLEANUP_TIMEOUT, with the original error as `cause`. If termination fails too, both
  // errors are kept (AggregateError, cleanup error first).
  async function stop({ signal } = {}) {
    try {
      // A daemon that has already exited (kill() in a restart test, or a crash) has no sessions
      // to clean up and no process to signal: no HTTP to a dead port, no wait on a past 'exit'.
      if (!exitState.exited) {
        let cleanupError = null, terminateError = null, summary = null;
        const cleanup = cleanupSignal(signal);
        try {
          summary = await cleanupSessions({ signal: cleanup.signal, remainingMs: cleanup.remainingMs });
        } catch (error) {
          cleanupError = cleanup.expired()
            ? Object.assign(new Error(`daemon-harness stop(): session cleanup did not finish within ${cleanupTimeoutMs}ms `
              + '(HARNESS_STOP_CLEANUP_TIMEOUT)', { cause: error }), { code: 'HARNESS_STOP_CLEANUP_TIMEOUT' })
            : error;
        } finally {
          cleanup.dispose();
          try { await terminateOwnedChild('stop()'); } catch (error) { terminateError = error; }
        }
        if (cleanupError && terminateError) {
          throw new AggregateError([cleanupError, terminateError], 'stop(): session cleanup failed and the owned daemon did not exit');
        }
        if (cleanupError || terminateError) throw cleanupError || terminateError;
        // Task 1215 harness133: contractual refusals are reported (one fixed-shape line, counts only) and returned.
        if (summary && summary.refused > 0) {
          process.stderr.write(`[daemon-harness] stop(): ${summary.refused} of ${summary.listed} listed session(s) refused the `
            + 'token-only DELETE by contract (403 OWNED_DELETE_FORBIDDEN); ended by the owned-daemon termination\n');
        }
        return summary;
      }
    } finally {
      if (ownsHome) {
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    }
  }

  async function spawnSession(sessionId, overrides = {}) {
    const body = {
      session_id: sessionId,
      cwd: projectRoot,
      cols: 80,
      rows: 24,
      type: 'USER',
      ...getShellSpec(),
      ...overrides
    };

    return request('/api/sessions/spawn', { method: 'POST', body });
  }

  // #815: a session's bearer is issued exactly once, in the response to its FIRST registration.
  // Remember it per sid so a test that later claims ownership can prove it owns the session, which
  // is what the real bridge now does (cli.js sends it on the WS handshake). Without this a test
  // bridge is indistinguishable from an attacker and the daemon refuses its claim with 4003.
  const sessionBearers = new Map();

  async function registerSession(sessionId, overrides = {}) {
    const body = {
      session_id: sessionId,
      command: 'test-wrap',
      cwd: projectRoot,
      ...overrides
    };

    const result = await request('/api/sessions/register', { method: 'POST', body });
    if (result.body && result.body.session_token) {
      sessionBearers.set(sessionId, result.body.session_token);
    }
    return result;
  }

  // WebSocket options that authenticate an ?owner=1 claim for `sessionId`. Returns undefined when
  // no bearer is known, which is the correct shape for the auto-register path (no credential to
  // prove) and for a test deliberately claiming as an unauthenticated caller.
  function ownerAuth(sessionId) {
    const bearer = sessionBearers.get(sessionId);
    return bearer ? { headers: { 'x-telepty-session-token': bearer } } : undefined;
  }

  // #820: the upgrade needs the daemon token too. Appended unless the caller already put a
  // `token=` in the path (a test asserting the refusal) or passes `noAuth`.
  async function connectWebSocket(pathname, wsOptions, { noAuth = false } = {}) {
    let url = `ws://${host}:${port}${pathname}`;
    const token = authToken();
    if (!noAuth && token && !pathname.includes('token=')) {
      url += `${pathname.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
    }
    const ws = new WebSocket(url, wsOptions);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      // A refusal is an answer, and a harness that reported it as a connect error would hide the
      // one thing these tests exist to tell apart.
      ws.once('unexpected-response', (_req, res) => {
        res.resume();
        reject(new Error(`WS upgrade refused: HTTP ${res.statusCode}`));
      });
    });
    return ws;
  }

  async function runCli(args, options = {}) {
    const timeoutMs = options.timeoutMs ?? 5000;
    const cliEnv = {
      ...sharedEnv,
      TELEPTY_HOST: host,
      TELEPTY_PORT: String(port),
      ...(options.env || {})
    };

    return new Promise((resolve, reject) => {
      const cli = spawn(process.execPath, ['cli.js', ...args], {
        cwd: projectRoot,
        env: cliEnv,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let cliStdout = '';
      let cliStderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        cli.kill('SIGKILL');
      }, timeoutMs);

      cli.stdout.on('data', (chunk) => {
        cliStdout += chunk.toString();
      });

      cli.stderr.on('data', (chunk) => {
        cliStderr += chunk.toString();
      });

      cli.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });

      cli.on('close', (code, signal) => {
        clearTimeout(timer);

        if (timedOut) {
          reject(new Error(`CLI command timed out.\nstdout:\n${cliStdout}\nstderr:\n${cliStderr}`));
          return;
        }

        resolve({
          code,
          signal,
          stdout: cliStdout,
          stderr: cliStderr
        });
      });
    });
  }

  return {
    port,
    host,
    homeDir,
    // #820 — exposed so a cross-host test can hand the CLI the TARGET daemon's token, which is
    // the production fix (resolve the target's token, not the local one) expressed in-harness.
    authToken,
    request,
    spawnSession,
    registerSession,
    ownerAuth,
    cleanupSessions,
    connectBus: (options) => connectWebSocket('/api/bus', undefined, options),
    connectSession: (sessionId, wsOptions, options) =>
      connectWebSocket(`/api/sessions/${encodeURIComponent(sessionId)}`, wsOptions, options),
    runCli,
    stop,
    kill,
    waitFor,
    isAlive: () => !exitState.exited,
    getLogs: () => ({ stdout, stderr }),
    // CI609 (opt-in measurement reads; null / 'unavailable' when the opt-in is unset)
    observedExitLineAt: (sid) => (OBSERVE607 ? exitLineAt.get(sid) ?? null : null),
    observeMeta: () => (OBSERVE607 ? observeMeta() : Promise.resolve('unavailable'))
  };
}

module.exports = {
  OBSERVE607,
  observe607,
  HARNESS_OBSERVATION_MARGIN_MS,
  HARNESS_REQUEST_MAX_MS,
  boundedRequest,
  createSessionId,
  diagnosticLogMarkers,
  delay,
  homeEnv,
  startTestDaemon,
  stripAnsi,
  waitFor
};
