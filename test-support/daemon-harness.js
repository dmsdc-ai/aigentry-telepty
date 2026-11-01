'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const projectRoot = path.resolve(__dirname, '..');

let sessionCounter = 0;

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

async function boundedRequest(url, init = {}, { timeoutMs, signal } = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  const route = new URL(url).pathname;
  const budget = requestBudget(timeoutMs);
  const begun = Date.now();
  const controller = new AbortController();
  let outcome = null;
  const onAbort = () => { if (!outcome) outcome = 'HARNESS_REQUEST_ABORTED'; controller.abort(); };
  const timer = setTimeout(() => { if (!outcome) outcome = 'HARNESS_REQUEST_TIMEOUT'; controller.abort(); }, budget);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await parseResponse(await fetch(url, { ...init, signal: controller.signal }));
  } catch (error) {
    if (outcome) throw harnessRequestError(outcome, method, route, Date.now() - begun);
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

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  // #879 — exit is a FACT recorded from the 'exit' event, never inferred from `child.exitCode`.
  // `child.kill()` on Windows is TerminateProcess, which libuv reports as a SIGNAL exit: exitCode
  // stays null and signalCode becomes 'SIGTERM'. The old predicate `child.exitCode === null` read
  // a daemon killed that way as still alive, so the next kill()/stop() on the same handle waited
  // on an 'exit' event that had already been emitted — with no timer and no I/O behind it. That
  // is the measured restart hang (run 40500878932: session-token-issuance-815 and
  // observation-tracking-endpoint-60, pending test promise, only the suite daemon left as a handle).
  const exitState = { exited: false, code: null, signal: null };
  child.once('exit', (code, signal) => {
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
      { timeoutMs: options.timeoutMs ?? requestTimeoutMs, signal: options.signal });
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
  // Returns a fixed-shape summary: counts plus status/code keys only, never ids, bodies or messages.
  const DIAG_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
  async function cleanupSessions({ signal } = {}) {
    const summary = { listed: 0, deleted: 0, refused: 0, failed: 0, refused_codes: {}, failed_statuses: {} };
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
    }, { description: 'session cleanup' });
    return summary;
  }

  // Task 1215 harness129: stop()'s cleanup signal is INDEPENDENT and bounded (cleanupTimeoutMs). A still-live case
  // signal can end it earlier; an already-aborted one is ignored, so teardown still gets its bounded cleanup.
  function cleanupSignal(caseSignal) {
    const controller = new AbortController();
    let expired = false;
    const timer = setTimeout(() => { expired = true; controller.abort(); }, cleanupTimeoutMs);
    const onCaseAbort = () => controller.abort();
    const follow = caseSignal && !caseSignal.aborted;
    if (follow) caseSignal.addEventListener('abort', onCaseAbort, { once: true });
    return { signal: controller.signal, expired: () => expired,
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
          summary = await cleanupSessions({ signal: cleanup.signal });
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
    getLogs: () => ({ stdout, stderr })
  };
}

module.exports = {
  HARNESS_OBSERVATION_MARGIN_MS,
  HARNESS_REQUEST_MAX_MS,
  boundedRequest,
  createSessionId,
  delay,
  homeEnv,
  startTestDaemon,
  stripAnsi,
  waitFor
};
