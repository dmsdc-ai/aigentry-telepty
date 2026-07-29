'use strict';

const { once } = require('events');
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

function createTempHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-home-'));
  return {
    homeDir,
    env: process.platform === 'win32'
      ? { HOME: homeDir, USERPROFILE: homeDir }
      : { HOME: homeDir }
  };
}

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
  const { homeDir, env: homeEnv } = ownsHome
    ? createTempHome()
    : {
      homeDir: options.homeDir,
      env: process.platform === 'win32'
        ? { HOME: options.homeDir, USERPROFILE: options.homeDir }
        : { HOME: options.homeDir }
    };
  const sharedEnv = {
    ...process.env,
    ...homeEnv,
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

  async function request(pathname, options = {}) {
    const headers = { ...(options.headers || {}) };
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
    if (child.exitCode !== null) {
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
      const response = await fetch(`http://${host}:${port}/api/sessions`);
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
  async function kill() {
    if (child.exitCode === null) {
      child.kill();
      const exited = await Promise.race([
        once(child, 'exit').then(() => true),
        delay(2000).then(() => false)
      ]);
      if (!exited && child.exitCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit').catch(() => {});
      }
    }
  }

  async function stop() {
    try {
      await cleanupSessions();
    } catch {
      // Ignore cleanup failures during shutdown and force-stop the daemon below.
    }

    if (child.exitCode === null) {
      child.kill();

      const exited = await Promise.race([
        once(child, 'exit').then(() => true),
        delay(2000).then(() => false)
      ]);

      if (!exited && child.exitCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit').catch(() => {});
      }
    }

    if (ownsHome) {
      fs.rmSync(homeDir, { recursive: true, force: true });
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

  async function connectWebSocket(pathname, wsOptions) {
    const ws = new WebSocket(`ws://${host}:${port}${pathname}`, wsOptions);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
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
    request,
    spawnSession,
    registerSession,
    ownerAuth,
    cleanupSessions,
    connectBus: () => connectWebSocket('/api/bus'),
    connectSession: (sessionId) => connectWebSocket(`/api/sessions/${encodeURIComponent(sessionId)}`),
    runCli,
    stop,
    kill,
    waitFor,
    isAlive: () => child.exitCode === null,
    getLogs: () => ({ stdout, stderr })
  };
}

module.exports = {
  createSessionId,
  delay,
  startTestDaemon,
  stripAnsi,
  waitFor
};
