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

async function startTestDaemon(options = {}) {
  // Bind an OS-assigned ephemeral port (PORT=0) unless the caller pins one. This is
  // collision-free: the daemon holds the socket continuously from the moment the kernel
  // assigns the port, so no other process or test can ever take it (unlike picking a
  // random/probed port, which leaves a TOCTOU window — the source of the CI EADDRINUSE
  // flake on ubuntu and the systematic EACCES on Windows reserved ranges). The actual
  // port is read back from the daemon's startup banner below.
  const requestedPort = options.port ?? 0;
  const host = options.host ?? '127.0.0.1';
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
    stdio: ['ignore', 'pipe', 'pipe']
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
    child.kill(); // POSIX: SIGTERM, the daemon's own shutdown path; win32: TerminateProcess
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

    const response = await fetch(`http://${host}:${port}${pathname}`, init);
    return parseResponse(response);
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
      const response = await fetch(`http://${host}:${port}/api/health`);
      return response.ok;
    } catch {
      return false;
    }
  }, { timeoutMs: 7000, description: 'daemon start' });

  async function cleanupSessions() {
    const list = await request('/api/sessions');
    if (list.status !== 200 || !Array.isArray(list.body)) {
      return;
    }

    await Promise.all(list.body.map((session) => request(`/api/sessions/${encodeURIComponent(session.id)}`, {
      method: 'DELETE'
    })));

    await waitFor(async () => {
      const current = await request('/api/sessions');
      return current.status === 200 && Array.isArray(current.body) && current.body.length === 0;
    }, { description: 'session cleanup' });
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

  async function stop() {
    try {
      // A daemon that has already exited (kill() in a restart test, or a crash) has no sessions
      // to clean up and no process to signal: no HTTP to a dead port, no wait on a past 'exit'.
      if (!exitState.exited) {
        try {
          await cleanupSessions();
        } catch {
          // Ignore cleanup failures during shutdown and force-stop the daemon below.
        }
        await terminateOwnedChild('stop()');
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
  createSessionId,
  delay,
  homeEnv,
  startTestDaemon,
  stripAnsi,
  waitFor
};
