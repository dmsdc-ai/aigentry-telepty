const { buildPtySpawnTarget } = require('../win-spawn-target');
const os = require('os');
const { defaultSpawnAdmission } = require('../spawn-admission');

const STRIPPED_SESSION_ENV_KEYS = [
  'CLAUDECODE',
  'CODEX_CI',
  'CODEX_THREAD_ID'
];

function buildSessionEnv(sessionId) {
  const env = {
    ...process.env,
    TERM: os.platform() === 'win32' ? undefined : 'xterm-256color',
    TELEPTY_SESSION_ID: sessionId
  };

  for (const key of STRIPPED_SESSION_ENV_KEYS) {
    delete env[key];
  }

  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDECODE_')) {
      delete env[key];
    }
  }

  return env;
}

function registerSpawnRoute(app, {
  sessions, sessionStateManager, pty, persistSessions, appendToOutputRing,
  revokeSessionCredential, busClients, os, buildSessionEnv, admission = defaultSpawnAdmission
}) {
  app.post('/api/sessions/spawn', (req, res) => {
    const invalid = field => res.status(400).json({ error: `Invalid ${field}.` });
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(body))) return invalid('body');
    if ('external_approval_policy' in body || 'require_owner_proof' in body) return invalid('unsupported protected spawn policy; use register');
    const values = Object.create(null);
    for (const field of ['session_id', 'command', 'args', 'cwd', 'cols', 'rows', 'type']) {
      const descriptor = Object.getOwnPropertyDescriptor(body, field);
      if (descriptor) {
        if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) return invalid(field);
        values[field] = descriptor.value;
      } else if (field in body) {
        return invalid(field);
      }
    }
    const { session_id, command } = values;
    if (typeof session_id !== 'string' || !session_id || Buffer.byteLength(session_id, 'utf8') > 128
        || /[\x00-\x1f\x7f-\x9f]/.test(session_id)) return invalid('session_id');
    if (typeof command !== 'string' || !command || command.includes('\0')) return invalid('command');
    for (const field of ['cwd', 'type']) {
      if (field in values && (typeof values[field] !== 'string' || !values[field]
          || values[field].includes('\0'))) return invalid(field);
    }
    const args = [];
    if ('args' in values) {
      if (!Array.isArray(values.args)) return invalid('args');
      const length = Object.getOwnPropertyDescriptor(values.args, 'length').value;
      for (let i = 0; i < length; i++) {
        const item = Object.getOwnPropertyDescriptor(values.args, String(i));
        if (!item || !Object.prototype.hasOwnProperty.call(item, 'value')
            || typeof item.value !== 'string' || item.value.includes('\0')) return invalid('args');
        args.push(item.value);
      }
    }
    for (const [field, fallback] of [['cols', 80], ['rows', 30]]) {
      let value = field in values ? values[field] : fallback;
      if (typeof value === 'string' && value.length > 0 && !/[^0-9]/.test(value)) value = Number(value);
      if (!Number.isSafeInteger(value) || value <= 0 || value > 10000) return invalid(field);
      values[field] = value;
    }
    const { cols, rows } = values;
    const cwd = 'cwd' in values ? values.cwd : process.cwd();
    const type = 'type' in values ? values.type : 'AGENT';
    if (Object.prototype.hasOwnProperty.call(sessions, session_id)) {
      return res.status(409).json({ error: `Session ID '${session_id}' is already active.` });
    }
    if (['__proto__', 'constructor', 'prototype'].includes(session_id) || session_id in sessions) {
      return invalid('session_id');
    }

    const admitted = admission.take();
    if (!admitted.allowed) {
      if (admitted.reason === 'rate_limited') {
        res.setHeader('Retry-After', String(admitted.retryAfter));
        return res.status(429).json({ error: 'Spawn rate limit exceeded.', code: 'SPAWN_RATE_LIMITED' });
      }
      return res.status(503).json({ error: 'Spawn admission unavailable.', code: 'SPAWN_ADMISSION_UNAVAILABLE' });
    }

    const isWin = os.platform() === 'win32';

    try {
      const { file: shell, args: shellArgs } = buildPtySpawnTarget(command, args, process.env, { platform: isWin ? 'win32' : process.platform });
      console.log('[SPAWN] Spawning %s with args: %o in cwd: %s', shell, shellArgs, cwd);

      const customEnv = buildSessionEnv(session_id);

      if (!isWin) {
        const label = type.toUpperCase();
        const colorCode = label === 'USER' ? '32' : '35'; // USER: Green (32), AGENT: Magenta (35)
        const zshColor = label === 'USER' ? 'green' : 'magenta';

        if (command.includes('bash')) {
          customEnv.PS1 = `\\[\\e[${colorCode}m\\][${label}: ${session_id}]\\[\\e[0m\\] \\w \\$ `;
        } else if (command.includes('zsh')) {
          customEnv.DISABLE_AUTO_TITLE = 'true';
          customEnv.PROMPT = `%F{${zshColor}}[${label}: ${session_id}]%f %~ %# `;
        }
      }

      const ptyProcess = pty.spawn(shell, shellArgs, {
        name: isWin ? 'Windows Terminal' : 'xterm-256color',
        cols,
        rows,
        cwd,
        env: customEnv
      });

      const sessionRecord = {
        id: session_id,
        type: 'spawned',
        ptyProcess,
        ptyPid: ptyProcess.pid || null,
        command,
        cwd,
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        lastConnectedAt: new Date().toISOString(),
        lastDisconnectedAt: null,
        lastStateReportAt: null,
        stateReport: null,
        clients: new Set(),
        isClosing: false,
        outputRing: [],
        ready: true,
            };
      sessions[session_id] = sessionRecord;
      const saved = persistSessions();
      if (!saved || !saved.ok) {
        if (!saved || !saved.committed) {
          delete sessions[session_id];
          // This process was created by this request and has not been published to clients.
          try { ptyProcess.kill(); } catch (error) { console.error('[SPAWN] Rollback kill failed:', error.message); }
        }
        if (!saved || !saved.committed) return res.status(503).json({ error: 'Session store write failed', code: 'SESSION_STORE_WRITE_FAILED' });
      }

      ptyProcess.onData((data) => {
        const currentSession = sessions[sessionRecord.id];
        if (!currentSession || currentSession.isClosing || currentSession !== sessionRecord) {
          return;
        }

        appendToOutputRing(currentSession, data);
        sessionStateManager.feed(sessionRecord.id, data);

        // Send to direct WS clients
        currentSession.clients.forEach(ws => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'output', data }));
        });
      });

      // Register session with state machine
      sessionStateManager.register(session_id);

      ptyProcess.onExit(({ exitCode, signal }) => {
        const currentId = sessionRecord.id;
        console.log('[EXIT] Session %s exited with code %s', currentId, exitCode);
        if (sessions[currentId] !== sessionRecord) return;
        sessionStateManager.markDead(currentId, exitCode, signal);
        sessionRecord.isClosing = true;
        sessionRecord.clients.forEach(ws => ws.close(1000, 'Session exited'));
        if (sessions[currentId] === sessionRecord) {
          delete sessions[currentId];
          revokeSessionCredential(currentId);   // #815: PTY exit — the instance is gone
          sessionStateManager.unregister(currentId);
          const saved = persistSessions();
          if (!saved || !saved.ok) console.error('[EXIT] Session removal was not durably saved:', currentId);
        }
      });

      if (!saved.ok) return res.status(503).json({ error: 'Session store write failed', code: 'SESSION_STORE_WRITE_FAILED' });
      console.log('[SPAWN] Created session %s (%s)', session_id, command);
      // Broadcast session creation to bus
      const spawnMsg = JSON.stringify({
        type: 'session_spawn',
        sender: 'daemon',
        session_id,
        command,
        cwd,
        timestamp: new Date().toISOString()
      });
      busClients.forEach(client => {
        if (client.readyState === 1) client.send(spawnMsg);
      });

      res.status(201).json({ session_id, command, cwd });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerSpawnRoute, buildSessionEnv };
