const express = require('express');
const cors = require('cors');
const pty = require('node-pty');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { getConfig } = require('./auth');
const pkg = require('./package.json');
const { claimDaemonState, clearDaemonState } = require('./daemon-control');
const { checkEntitlement } = require('./entitlement');
const terminalBackend = require('./terminal-backend');

const config = getConfig();
const EXPECTED_TOKEN = config.authToken;
const MACHINE_ID = process.env.TELEPTY_MACHINE_ID || os.hostname();
const fs = require('fs');
const SESSION_PERSIST_PATH = require('path').join(os.homedir(), '.config', 'aigentry-telepty', 'sessions.json');

function persistSessions() {
  try {
    const data = {};
    for (const [id, s] of Object.entries(sessions)) {
      data[id] = { id, type: s.type, command: s.command, cwd: s.cwd, backend: s.backend || null, cmuxWorkspaceId: s.cmuxWorkspaceId || null, cmuxSurfaceId: s.cmuxSurfaceId || null, createdAt: s.createdAt, lastActivityAt: s.lastActivityAt || null };
    }
    fs.mkdirSync(require('path').dirname(SESSION_PERSIST_PATH), { recursive: true });
    fs.writeFileSync(SESSION_PERSIST_PATH, JSON.stringify(data, null, 2));
  } catch {}
}

function loadPersistedSessions() {
  try {
    if (!fs.existsSync(SESSION_PERSIST_PATH)) return {};
    return JSON.parse(fs.readFileSync(SESSION_PERSIST_PATH, 'utf8'));
  } catch { return {}; }
}

const app = express();
app.use(cors());
app.use(express.json());

// Peer allowlist: comma-separated IPs/CIDRs in TELEPTY_PEER_ALLOWLIST env
const PEER_ALLOWLIST = (process.env.TELEPTY_PEER_ALLOWLIST || '').split(',').map(s => s.trim()).filter(Boolean);

// Cross-machine bus relay: forward bus events to peer daemons
const RELAY_PEERS = (process.env.TELEPTY_RELAY_PEERS || '').split(',').map(s => s.trim()).filter(Boolean);
const RELAY_SEEN = new Set(); // dedup by message_id

function relayToPeers(msg) {
  if (RELAY_PEERS.length === 0) return;
  if (!msg.message_id) msg.message_id = crypto.randomUUID();
  if (RELAY_SEEN.has(msg.message_id)) return; // already relayed
  RELAY_SEEN.add(msg.message_id);
  // Prevent unbounded growth
  if (RELAY_SEEN.size > 10000) {
    const arr = [...RELAY_SEEN];
    arr.splice(0, 5000);
    RELAY_SEEN.clear();
    arr.forEach(id => RELAY_SEEN.add(id));
  }

  msg.source_host = msg.source_host || MACHINE_ID;
  msg._relayed_from = MACHINE_ID;

  for (const peer of RELAY_PEERS) {
    fetch(`http://${peer}:${PORT}/api/bus/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-telepty-token': EXPECTED_TOKEN },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(3000)
    }).catch(() => {}); // fire-and-forget
  }
}

// JWT auth: set TELEPTY_JWT_SECRET to enable. Tokens in Authorization: Bearer <token>
const JWT_SECRET = process.env.TELEPTY_JWT_SECRET || null;

function verifyJwt(token) {
  if (!JWT_SECRET || !token) return false;
  try {
    // Simple HS256 JWT verification (no external deps)
    const [headerB64, payloadB64, sigB64] = token.split('.');
    if (!headerB64 || !payloadB64 || !sigB64) return false;
    const expected = crypto.createHmac('sha256', JWT_SECRET)
      .update(`${headerB64}.${payloadB64}`).digest('base64url');
    if (sigB64 !== expected) return false;
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    if (payload.exp && Date.now() / 1000 > payload.exp) return false;
    return payload;
  } catch { return false; }
}

function isAllowedPeer(ip) {
  if (!ip) return false;
  const cleanIp = ip.replace('::ffff:', '');
  // Localhost always allowed (includes SSH tunnel traffic)
  if (cleanIp === '127.0.0.1' || ip === '::1') return true;
  // Peer allowlist
  if (PEER_ALLOWLIST.length > 0) return PEER_ALLOWLIST.includes(cleanIp);
  // No allowlist = allow all authenticated
  return true;
}

// Authentication Middleware
app.use((req, res, next) => {
  const clientIp = req.ip;

  if (isAllowedPeer(clientIp)) {
    return next(); // Trust local and allowlisted peers (SSH tunnels arrive as localhost)
  }

  const token = req.headers['x-telepty-token'] || req.query.token;
  if (token === EXPECTED_TOKEN) {
    return next();
  }

  // JWT Bearer token
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ') && verifyJwt(authHeader.slice(7))) {
    return next();
  }

  console.warn(`[AUTH] Rejected unauthorized request from ${clientIp}`);
  res.status(401).json({ error: 'Unauthorized: Invalid or missing token.' });
});

const PORT = process.env.PORT || 3848;

const HOST = process.env.HOST || '0.0.0.0';
process.title = 'telepty-daemon';

const daemonClaim = claimDaemonState({ host: HOST, port: Number(PORT), version: pkg.version });
if (!daemonClaim.claimed) {
  const current = daemonClaim.current;
  console.log(`[DAEMON] telepty daemon already running (pid ${current.pid}, port ${current.port}). Exiting.`);
  process.exit(0);
}

const sessions = {};
const handoffs = {};
const threads = {};

function appendToOutputRing(session, data) {
  if (!session.outputRing) session.outputRing = [];
  session.outputRing.push(data);
  // Keep total data under ~200KB limit by trimming old entries
  let totalLen = session.outputRing.reduce((sum, d) => sum + d.length, 0);
  while (totalLen > 200000 && session.outputRing.length > 1) {
    totalLen -= session.outputRing[0].length;
    session.outputRing.shift();
  }
}

// Detect terminal environment at daemon startup
const DETECTED_TERMINAL = terminalBackend.detectTerminal();
console.log(`[DAEMON] Terminal backend: ${DETECTED_TERMINAL}`);

// Restore persisted session metadata (wrapped sessions await reconnect)
const _persisted = loadPersistedSessions();
for (const [id, meta] of Object.entries(_persisted)) {
  if (meta.type === 'wrapped') {
    sessions[id] = {
      id, type: 'wrapped', ptyProcess: null, ownerWs: null,
      command: meta.command || 'wrapped', cwd: meta.cwd || process.cwd(),
      createdAt: meta.createdAt || new Date().toISOString(),
      lastActivityAt: meta.lastActivityAt || new Date().toISOString(),
      clients: new Set(), isClosing: false, outputRing: [], ready: false,     };
    console.log(`[PERSIST] Restored session ${id} (awaiting reconnect)`);
  }
}
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

// Stable alias routing: resolve alias to latest session with matching prefix
function resolveSessionAlias(requestedId) {
  // Exact match first
  if (sessions[requestedId]) return requestedId;

  // Strip trailing version number to get base alias (e.g., "aigentry-dustcraw-002" → "aigentry-dustcraw")
  // Also handles bare alias like "aigentry-dustcraw"
  const baseAlias = requestedId.replace(/-\d+$/, '');

  // Find all sessions matching the base alias
  const candidates = Object.keys(sessions).filter(id => {
    const candidateBase = id.replace(/-\d+$/, '');
    return candidateBase === baseAlias;
  });

  if (candidates.length === 0) return null;

  // Return the most recently created session
  candidates.sort((a, b) => {
    const timeA = new Date(sessions[a].createdAt).getTime();
    const timeB = new Date(sessions[b].createdAt).getTime();
    return timeB - timeA;
  });
  return candidates[0];
}

app.post('/api/sessions/spawn', (req, res) => {
  const { session_id, command, args = [], cwd = process.cwd(), cols = 80, rows = 30, type = 'AGENT' } = req.body;
  if (!session_id) return res.status(400).json({ error: 'session_id is strictly required.' });
  if (sessions[session_id]) return res.status(409).json({ error: `Session ID '${session_id}' is already active.` });
  // Entitlement: check session limit
  const sessionCount = Object.keys(sessions).length;
  const ent = checkEntitlement({ feature: 'telepty.multi_session', currentUsage: sessionCount });
  if (!ent.allowed) {
    console.log(`[ENTITLEMENT] Session limit reached (${sessionCount}/${ent.limit?.max || '?'}), tier: ${ent.tier}`);
    return res.status(402).json({ error: ent.reason, upgrade_url: ent.upgrade_url, tier: ent.tier });
  }
  if (!command) return res.status(400).json({ error: 'command is required' });

  const isWin = os.platform() === 'win32';
  const shell = isWin ? (command === 'powershell' ? 'powershell.exe' : 'cmd.exe') : command;
  const shellArgs = isWin ? (command === 'powershell' || command === 'cmd' ? args : ['/c', command, ...args]) : args;

  try {
    console.log(`[SPAWN] Spawning ${shell} with args:`, shellArgs, "in cwd:", cwd);

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
      cols: parseInt(cols),
      rows: parseInt(rows),
      cwd,
      env: customEnv
    });

    const sessionRecord = {
      id: session_id,
      type: 'spawned',
      ptyProcess,
      command,
      cwd,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      clients: new Set(),
      isClosing: false,
      outputRing: [],
      ready: true,
          };
    sessions[session_id] = sessionRecord;

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

    ptyProcess.onData((data) => {
      const currentSession = sessions[sessionRecord.id];
      if (!currentSession || currentSession !== sessionRecord) {
        return;
      }

      appendToOutputRing(currentSession, data);

      // Send to direct WS clients
      currentSession.clients.forEach(ws => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'output', data }));
      });
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      const currentId = sessionRecord.id;
      console.log(`[EXIT] Session ${currentId} exited with code ${exitCode}`);
      sessionRecord.isClosing = true;
      sessionRecord.clients.forEach(ws => ws.close(1000, 'Session exited'));
      if (sessions[currentId] === sessionRecord) {
        delete sessions[currentId];
      }
    });

    console.log(`[SPAWN] Created session ${session_id} (${command})`);
    persistSessions();
    res.status(201).json({ session_id, command, cwd });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions/register', (req, res) => {
  const { session_id, command, cwd = process.cwd(), backend, cmux_workspace_id, cmux_surface_id } = req.body;
  if (!session_id) return res.status(400).json({ error: 'session_id is required' });
  // Entitlement: check session limit for new registrations
  if (!sessions[session_id]) {
    const sessionCount = Object.keys(sessions).length;
    const ent = checkEntitlement({ feature: 'telepty.multi_session', currentUsage: sessionCount });
    if (!ent.allowed) {
      console.log(`[ENTITLEMENT] Session limit reached (${sessionCount}/${ent.limit?.max || '?'}), tier: ${ent.tier}`);
      return res.status(402).json({ error: ent.reason, upgrade_url: ent.upgrade_url, tier: ent.tier });
    }
  }
  // Idempotent: allow re-registration (update command/cwd, keep clients)
  if (sessions[session_id]) {
    const existing = sessions[session_id];
    if (command) existing.command = command;
    if (cwd) existing.cwd = cwd;
    if (backend) existing.backend = backend;
    if (cmux_workspace_id) existing.cmuxWorkspaceId = cmux_workspace_id;
    if (cmux_surface_id) existing.cmuxSurfaceId = cmux_surface_id;
    console.log(`[REGISTER] Re-registered session ${session_id} (updated metadata)`);
    return res.status(200).json({ session_id, type: 'wrapped', command: existing.command, cwd: existing.cwd, reregistered: true });
  }

  const sessionRecord = {
    id: session_id,
    type: 'wrapped',
    ptyProcess: null,
    ownerWs: null,
    command: command || 'wrapped',
    cwd,
    backend: backend || 'kitty',
    cmuxWorkspaceId: cmux_workspace_id || null,
    cmuxSurfaceId: cmux_surface_id || null,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    clients: new Set(),
    isClosing: false,
    outputRing: [],
    ready: false,
      };
  // Check for existing session with same base alias and emit replaced event
  const baseAlias = session_id.replace(/-\d+$/, '');
  const replaced = Object.keys(sessions).find(id => {
    return id !== session_id && id.replace(/-\d+$/, '') === baseAlias;
  });
  if (replaced) {
    const replacedMsg = JSON.stringify({
      type: 'session.replaced',
      sender: 'daemon',
      old_id: replaced,
      new_id: session_id,
      alias: baseAlias,
      timestamp: new Date().toISOString()
    });
    busClients.forEach(client => {
      if (client.readyState === 1) client.send(replacedMsg);
    });
    console.log(`[ALIAS] Session '${replaced}' replaced by '${session_id}' (alias: ${baseAlias})`);
  }

  sessions[session_id] = sessionRecord;

  const busMsg = JSON.stringify({
    type: 'session_register',
    sender: 'daemon',
    session_id,
    command: sessionRecord.command,
    cwd,
    timestamp: new Date().toISOString()
  });
  busClients.forEach(client => {
    if (client.readyState === 1) client.send(busMsg);
  });

  console.log(`[REGISTER] Registered wrapped session ${session_id}`);
  persistSessions();
  res.status(201).json({ session_id, type: 'wrapped', command: sessionRecord.command, cwd });
});

app.get('/api/sessions', (req, res) => {
  const idleGt = req.query.idle_gt ? Number(req.query.idle_gt) : null;
  const now = Date.now();
  let list = Object.entries(sessions).map(([id, session]) => {
    const idleSeconds = session.lastActivityAt ? Math.floor((now - new Date(session.lastActivityAt).getTime()) / 1000) : null;
    const projectId = session.cwd ? session.cwd.split('/').pop() : null;
    return {
      id,
      locator: { machine_id: MACHINE_ID, session_id: id, project_id: projectId },
      type: session.type || 'spawned',
      command: session.command,
      cwd: session.cwd,
      backend: session.backend || 'kitty',
      cmuxWorkspaceId: session.cmuxWorkspaceId || null,
      cmuxSurfaceId: session.cmuxSurfaceId || null,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt || null,
      idleSeconds,
      active_clients: session.clients.size,
      ready: session.ready || false
    };
  });
  if (idleGt !== null) {
    list = list.filter(s => s.idleSeconds !== null && s.idleSeconds > idleGt);
  }
  res.json(list);
});

app.get('/api/sessions/:id', (req, res) => {
  const requestedId = req.params.id;
  const resolvedId = resolveSessionAlias(requestedId);
  if (!resolvedId) return res.status(404).json({ error: 'Session not found' });
  const session = sessions[resolvedId];
  const idleSeconds = session.lastActivityAt ? Math.floor((Date.now() - new Date(session.lastActivityAt).getTime()) / 1000) : null;
  const projectId = session.cwd ? session.cwd.split('/').pop() : null;
  res.json({
    id: resolvedId,
    locator: { machine_id: MACHINE_ID, session_id: resolvedId, project_id: projectId },
    alias: requestedId !== resolvedId ? requestedId : null,
    type: session.type || 'spawned',
    command: session.command,
    cwd: session.cwd,
    createdAt: session.createdAt,
    lastActivityAt: session.lastActivityAt || null,
    idleSeconds,
    active_clients: session.clients ? session.clients.size : 0,
    lastInjectFrom: session.lastInjectFrom || null,
    lastInjectReplyTo: session.lastInjectReplyTo || null
  });
});

app.get('/api/meta', (req, res) => {
  res.json({
    name: pkg.name,
    version: pkg.version,
    pid: process.pid,
    host: HOST,
    port: Number(PORT),
    machine_id: MACHINE_ID,
    terminal: DETECTED_TERMINAL,
    capabilities: ['sessions', 'wrapped-sessions', 'skill-installer', 'singleton-daemon', 'handoff-inbox', 'deliberation-threads', 'cross-machine']
  });
});

// Peer management endpoint (for cross-machine module)
app.get('/api/peers', (req, res) => {
  try {
    const crossMachine = require('./cross-machine');
    res.json({
      active: crossMachine.listActivePeers(),
      known: crossMachine.listKnownPeers()
    });
  } catch {
    res.json({ active: [], known: {} });
  }
});

app.post('/api/sessions/multicast/inject', (req, res) => {
  const { session_ids, prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });
  if (!Array.isArray(session_ids)) return res.status(400).json({ error: 'session_ids must be an array' });

  const results = { successful: [], failed: [] };

  session_ids.forEach(id => {
    const session = sessions[id];
    if (session) {
      try {
        // cmux per-session backend (text + enter)
        if (session.backend === 'cmux') {
          const ok = terminalBackend.cmuxSendText(id, prompt);
          if (ok) {
            setTimeout(() => terminalBackend.cmuxSendEnter(id), 300);
            results.successful.push({ id, strategy: 'cmux_auto' });
            // Broadcast injection to bus
            const busMsg = JSON.stringify({
              type: 'injection',
              sender: 'cli',
              target_agent: id,
              content: prompt,
              timestamp: new Date().toISOString()
            });
            busClients.forEach(client => {
              if (client.readyState === 1) client.send(busMsg);
            });
            return; // skip WS path for this session
          }
        }

        // Inject text first, then \r separately after delay
        if (session.type === 'wrapped') {
          if (session.ownerWs && session.ownerWs.readyState === 1) {
            session.ownerWs.send(JSON.stringify({ type: 'inject', data: prompt }));
            setTimeout(() => {
              if (session.backend === 'cmux' && session.cmuxWorkspaceId) {
                submitViaCmux(id);
              } else if (session.ownerWs && session.ownerWs.readyState === 1) {
                session.ownerWs.send(JSON.stringify({ type: 'inject', data: '\r' }));
              }
            }, 300);
            results.successful.push({ id, strategy: session.backend === 'cmux' ? 'cmux_split_cr' : 'split_cr' });
          } else {
            results.failed.push({ id, error: 'Wrap process not connected' });
          }
        } else {
          session.ptyProcess.write(prompt);
          setTimeout(() => session.ptyProcess.write('\r'), 300);
          results.successful.push({ id, strategy: 'split_cr' });
        }

        // Broadcast injection to bus
        const busMsg = JSON.stringify({
          type: 'injection',
          sender: 'cli',
          target_agent: id,
          content: prompt,
          timestamp: new Date().toISOString()
        });
        busClients.forEach(client => {
          if (client.readyState === 1) client.send(busMsg);
        });
      } catch (err) {
        results.failed.push({ id, error: err.message });
      }
    } else {
      results.failed.push({ id, error: 'Session not found' });
    }
  });

  res.json({ success: true, results });
});

app.post('/api/sessions/broadcast/inject', (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const results = { successful: [], failed: [] };

  Object.keys(sessions).forEach(id => {
    const session = sessions[id];
    try {
      // cmux per-session backend (text + enter)
      if (session.backend === 'cmux') {
        const ok = terminalBackend.cmuxSendText(id, prompt);
        if (ok) {
          setTimeout(() => terminalBackend.cmuxSendEnter(id), 300);
          results.successful.push({ id, strategy: 'cmux_auto' });
          return; // skip WS path for this session
        }
      }

      // Inject text first, then \r separately after delay
      if (session.type === 'wrapped') {
        if (session.ownerWs && session.ownerWs.readyState === 1) {
          session.ownerWs.send(JSON.stringify({ type: 'inject', data: prompt }));
          setTimeout(() => {
            if (session.backend === 'cmux' && session.cmuxWorkspaceId) {
              submitViaCmux(id);
            } else if (session.ownerWs && session.ownerWs.readyState === 1) {
              session.ownerWs.send(JSON.stringify({ type: 'inject', data: '\r' }));
            }
          }, 300);
          results.successful.push({ id, strategy: session.backend === 'cmux' ? 'cmux_split_cr' : 'split_cr' });
        } else {
          results.failed.push({ id, error: 'Wrap process not connected' });
        }
      } else {
        session.ptyProcess.write(prompt);
        setTimeout(() => session.ptyProcess.write('\r'), 300);
        results.successful.push({ id, strategy: 'split_cr' });
      }
    } catch (err) {
      results.failed.push({ id, error: err.message });
    }
  });

  // Send a single bus event for the entire broadcast (not per-session)
  if (results.successful.length > 0) {
    const busMsg = JSON.stringify({
      type: 'injection',
      sender: 'cli',
      target_agent: 'all',
      content: prompt,
      session_ids: results.successful,
      timestamp: new Date().toISOString()
    });
    busClients.forEach(client => {
      if (client.readyState === 1) client.send(busMsg);
    });
  }

  res.json({ success: true, results });
});

// CLI-specific submit strategies
// All CLIs submit via PTY \r when running inside telepty allow bridge
const SUBMIT_STRATEGIES = {
  claude: 'pty_cr',
  gemini: 'pty_cr',
  codex: 'pty_cr',
};

function getSubmitStrategy(command) {
  const base = command.split('/').pop().split(' ')[0]; // extract binary name
  return SUBMIT_STRATEGIES[base] || 'pty_cr'; // default to \r
}

function submitViaPty(session) {
  if (session.type === 'wrapped') {
    if (session.ownerWs && session.ownerWs.readyState === 1) {
      session.ownerWs.send(JSON.stringify({ type: 'inject', data: '\r' }));
      return true;
    }
    return false;
  } else {
    session.ptyProcess.write('\r');
    return true;
  }
}

// Send text directly to Kitty tab via remote control (bypasses allow bridge entirely)
function findKittySocket() {
  try {
    const files = require('fs').readdirSync('/tmp').filter(f => f.startsWith('kitty-sock'));
    return files.length > 0 ? '/tmp/' + files[0] : null;
  } catch { return null; }
}

function findKittyWindowId(socket, sessionId) {
  const { execSync } = require('child_process');
  try {
    const raw = execSync(`kitty @ --to unix:${socket} ls`, { timeout: 3000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const data = JSON.parse(raw);
    for (const osw of data) {
      for (const tab of osw.tabs) {
        for (const w of tab.windows) {
          // Only check process cmdlines for --id SESSION_ID pattern (not output text)
          for (const p of (w.foreground_processes || [])) {
            const cmd = (p.cmdline || []).join(' ');
            if (cmd.includes('--id ' + sessionId) || cmd.includes('--id=' + sessionId)) {
              return w.id;
            }
          }
        }
      }
    }
  } catch {}
  return null;
}

function sendViaKitty(sessionId, text) {
  const { execSync } = require('child_process');
  const socket = findKittySocket();
  if (!socket) return false;

  const windowId = findKittyWindowId(socket, sessionId);
  if (!windowId) {
    console.error(`[KITTY] No window found for ${sessionId}`);
    return false;
  }

  try {
    // Split text and CR — send-text for both (send-key corrupts keyboard protocol)
    const hasCr = text.endsWith('\r') || text.endsWith('\n');
    const textOnly = hasCr ? text.slice(0, -1) : text;
    if (textOnly.length > 0) {
      const escaped = textOnly.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
      execSync(`kitty @ --to unix:${socket} send-text --match id:${windowId} '${escaped}'`, {
        timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
      });
    }
    if (hasCr) {
      // Delay before sending Return — CLI needs time to process text input
      execSync('sleep 0.5', { timeout: 2000 });
      execSync(`kitty @ --to unix:${socket} send-text --match id:${windowId} $'\\r'`, {
        timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
      });
    }
    console.log(`[KITTY] Sent ${textOnly.length} chars${hasCr ? ' + Return' : ''} to ${sessionId} (window ${windowId})`);
    return true;
  } catch (err) {
    console.error(`[KITTY] Failed for ${sessionId}:`, err.message);
    return false;
  }
}

function submitViaOsascript(sessionId, keyCombo) {
  const { execSync } = require('child_process');
  const session = sessions[sessionId];
  // Build fallback search terms: session ID, project dir name, CLI-specific patterns
  const searchTerms = [sessionId];
  if (session) {
    // Extract project name from cwd (e.g., "aigentry-deliberation" from full path)
    const projectName = session.cwd.split('/').pop();
    if (projectName) searchTerms.push(projectName);
    // CLI-specific known window titles
    if (session.command === 'codex') {
      searchTerms.push('New agent conversation', 'codex');
    }
  }

  const keyAction = keyCombo === 'cmd_enter'
    ? 'key code 36 using command down'
    : 'key code 36';

  // Try each search term until we find a matching window
  const searchTermsStr = searchTerms.map(t => `"${t}"`).join(', ');
  const script = `
    tell application "System Events"
      tell process "stable"
        set searchList to {${searchTermsStr}}
        repeat with term in searchList
          repeat with w in windows
            if name of w contains (term as text) then
              perform action "AXRaise" of w
              delay 0.3
              ${keyAction}
              return "ok:" & (name of w)
            end if
          end repeat
        end repeat
        return "window_not_found"
      end tell
    end tell`;

  try {
    const result = execSync(`osascript -e '${script}'`, { timeout: 5000 }).toString().trim();
    const ok = result.startsWith('ok:');
    if (ok) console.log(`[SUBMIT] osascript matched: ${result}`);
    return ok;
  } catch (err) {
    console.error(`[SUBMIT] osascript failed for ${sessionId}:`, err.message);
    return false;
  }
}

function submitViaCmux(sessionId) {
  const { execSync } = require('child_process');
  const session = sessions[sessionId];
  if (!session || !session.cmuxWorkspaceId) return false;
  try {
    execSync(`cmux send-key --workspace ${session.cmuxWorkspaceId} return`, {
      timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
    });
    console.log(`[SUBMIT] cmux send-key return for ${sessionId} (workspace ${session.cmuxWorkspaceId})`);
    return true;
  } catch (err) {
    console.error(`[SUBMIT] cmux send-key failed for ${sessionId}:`, err.message);
    return false;
  }
}

// POST /api/sessions/:id/submit — CLI-aware submit
app.post('/api/sessions/:id/submit', (req, res) => {
  const requestedId = req.params.id;
  const resolvedId = resolveSessionAlias(requestedId);
  if (!resolvedId) return res.status(404).json({ error: 'Session not found', requested: requestedId });
  const session = sessions[resolvedId];
  const id = resolvedId;

  const strategy = getSubmitStrategy(session.command);
  console.log(`[SUBMIT] Session ${id} (${session.command}) using strategy: ${strategy}`);

  let success = false;
  // cmux per-session backend
  if (session.backend === 'cmux') {
    success = terminalBackend.cmuxSendEnter(id);
  }
  if (!success && session.backend === 'cmux' && session.cmuxWorkspaceId) {
    success = submitViaCmux(id);
  }
  if (!success) {
    if (strategy === 'pty_cr') {
      success = submitViaPty(session);
    } else if (strategy === 'osascript_cmd_enter') {
      success = submitViaOsascript(id, 'cmd_enter');
    } else {
      success = submitViaPty(session); // fallback
    }
  }

  if (success) {
    const busMsg = JSON.stringify({
      type: 'submit',
      sender: 'daemon',
      session_id: id,
      strategy,
      timestamp: new Date().toISOString()
    });
    busClients.forEach(client => {
      if (client.readyState === 1) client.send(busMsg);
    });
    res.json({ success: true, strategy });
  } else {
    res.status(503).json({ error: `Submit failed via ${strategy}`, strategy });
  }
});

// POST /api/sessions/submit-all — Submit all active sessions
app.post('/api/sessions/submit-all', (req, res) => {
  const results = { successful: [], failed: [] };

  for (const [id, session] of Object.entries(sessions)) {
    const strategy = getSubmitStrategy(session.command);
    let success = false;

    // cmux per-session backend
    if (session.backend === 'cmux') {
      success = terminalBackend.cmuxSendEnter(id);
    }
    if (!success && session.backend === 'cmux' && session.cmuxWorkspaceId) {
      success = submitViaCmux(id);
    }
    if (!success) {
      if (strategy === 'pty_cr') {
        success = submitViaPty(session);
      } else if (strategy === 'osascript_cmd_enter') {
        success = submitViaOsascript(id, 'cmd_enter');
      }
    }

    if (success) {
      results.successful.push({ id, strategy });
    } else {
      results.failed.push({ id, strategy, error: 'Submit failed' });
    }
  }

  res.json({ success: true, results });
});

app.post('/api/sessions/:id/inject', (req, res) => {
  const requestedId = req.params.id;
  const resolvedId = resolveSessionAlias(requestedId);
  if (!resolvedId) return res.status(404).json({ error: 'Session not found', requested: requestedId });
  const session = sessions[resolvedId];
  const id = resolvedId;
  const { prompt, no_enter, auto_submit, thread_id, reply_expected } = req.body;
  let { from, reply_to } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });
  // reply_to defaults to from when omitted
  if (from && !reply_to) reply_to = from;
  if (from) session.lastInjectFrom = from;
  if (reply_to) session.lastInjectReplyTo = reply_to;
  if (thread_id) session.lastThreadId = thread_id;
  session.lastActivityAt = new Date().toISOString();

  // Auto-prepend [from:] [reply-to:] header if from is set and not already in prompt
  let finalPrompt = prompt;
  if (from && !prompt.startsWith('[from:')) {
    finalPrompt = `[from: ${from}] [reply-to: ${reply_to}] ${prompt}`;
  }
  // Append reply guide when reply_to is set, UNLESS message contains termination signal
  const TERMINATION_SIGNALS = /no further reply needed|thread closed|closed on .+ side|ack received|ack-only|회신 불필요|스레드 종료/i;
  if (reply_to && reply_to !== id && !TERMINATION_SIGNALS.test(prompt)) {
    finalPrompt += `\n\n---\n[reply-to: ${reply_to}] 위 세션에 회신이 필요합니다. 답변 시 아래 명령을 실행하세요:\ntelepty inject --from ${id} ${reply_to} "답변 내용"\n---`;
  }
  const inject_id = crypto.randomUUID();
  try {
    // Always inject text WITHOUT \r first, then send \r separately after delay
    // This two-step approach works for ALL CLIs (claude, codex, gemini)
    function writeToSession(data) {
      if (session.type === 'wrapped') {
        if (session.ownerWs && session.ownerWs.readyState === 1) {
          session.ownerWs.send(JSON.stringify({ type: 'inject', data }));
          return true;
        }
        return false;
      } else {
        session.ptyProcess.write(data);
        return true;
      }
    }

    let submitResult = null;
    if (session.type === 'wrapped') {
      // For wrapped sessions: try cmux send (daemon-level auto-detect),
      // then kitty send-text (bypasses allow bridge queue),
      // then WS as fallback, then submit via consistent path for CR.
      //
      // When session is NOT ready (CLI hasn't shown prompt yet), skip cmux/kitty
      // because they bypass the allow-bridge's prompt-ready queue.
      // The WS path sends to the allow-bridge which queues until CLI is ready.
      const sock = session.ready ? findKittySocket() : null;
      if (sock && !session.kittyWindowId) session.kittyWindowId = findKittyWindowId(sock, id);
      const wid = session.ready ? session.kittyWindowId : null;

      let kittyOk = false;
      let cmuxOk = false;
      let deliveryPath = null; // 'cmux', 'kitty', 'ws'

      // cmux per-session backend: send text directly to surface (only when ready)
      if (session.ready && session.backend === 'cmux') {
        cmuxOk = terminalBackend.cmuxSendText(id, finalPrompt);
        if (cmuxOk) {
          deliveryPath = 'cmux';
          console.log(`[INJECT] cmux send for ${id}`);
        }
      }

      if (!cmuxOk && wid && sock) {
        // Kitty send-text primary (only when ready — bypasses allow bridge queue)
        try {
          const escaped = finalPrompt.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
          require('child_process').execSync(`kitty @ --to unix:${sock} send-text --match id:${wid} '${escaped}'`, {
            timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
          });
          kittyOk = true;
          deliveryPath = 'kitty';
          console.log(`[INJECT] Kitty send-text for ${id} (window ${wid})`);
        } catch {
          // Invalidate cached window ID — window may have changed or been closed
          session.kittyWindowId = null;
        }
      }
      if (!cmuxOk && !kittyOk) {
        // WS path: allow-bridge has its own prompt-ready queue
        const wsOk = writeToSession(finalPrompt);
        if (!wsOk) {
          return res.status(503).json({ error: 'Process not connected' });
        }
        deliveryPath = 'ws';
        if (!session.ready) {
          console.log(`[INJECT] WS (not ready, allow-bridge will queue) for ${id}`);
        } else {
          console.log(`[INJECT] WS fallback for ${id}`);
        }
      }

      if (!no_enter) {
        setTimeout(() => {
          let submitted = false;

          // Use the SAME path that delivered text for CR to guarantee ordering
          if (deliveryPath === 'cmux') {
            // cmux: send-key return via same surface
            if (session.backend === 'cmux') {
              submitted = terminalBackend.cmuxSendEnter(id);
              if (submitted) console.log(`[INJECT] cmux submit for ${id}`);
            }
            if (!submitted && session.backend === 'cmux' && session.cmuxWorkspaceId) {
              submitted = submitViaCmux(id);
              if (submitted) console.log(`[INJECT] cmux session-level submit for ${id}`);
            }
          } else if (deliveryPath === 'kitty') {
            // kitty: send-text CR via same window (not osascript!)
            if (wid && sock) {
              try {
                require('child_process').execSync(`kitty @ --to unix:${sock} send-text --match id:${wid} $'\\r'`, {
                  timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
                });
                submitted = true;
                console.log(`[INJECT] kitty submit for ${id} (window ${wid})`);
              } catch {
                session.kittyWindowId = null;
              }
            }
          }
          // deliveryPath === 'ws' or any fallback:
          // Try terminal-level submit first (bypasses PTY ICRNL which converts CR→LF)
          // This matters for cmux/kitty sessions where text went via WS but
          // the application expects CR(13) not LF(10) from Enter.
          if (!submitted && session.backend === 'cmux') {
            submitted = terminalBackend.cmuxSendEnter(id);
            if (submitted) console.log(`[INJECT] cmux submit (fallback) for ${id}`);
          }
          if (!submitted && session.backend === 'cmux' && session.cmuxWorkspaceId) {
            submitted = submitViaCmux(id);
            if (submitted) console.log(`[INJECT] cmux session-level submit (fallback) for ${id}`);
          }
          if (!submitted && wid && sock) {
            try {
              require('child_process').execSync(`kitty @ --to unix:${sock} send-text --match id:${wid} $'\\r'`, {
                timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
              });
              submitted = true;
              console.log(`[INJECT] kitty submit (fallback) for ${id}`);
            } catch {
              session.kittyWindowId = null;
            }
          }
          if (!submitted) {
            writeToSession('\r');
            console.log(`[INJECT] WS submit for ${id}`);
          }

          // Update tab title (kitty-specific, safe to fail)
          if (wid && sock) {
            try {
              require('child_process').execSync(`kitty @ --to unix:${sock} set-tab-title --match id:${wid} '⚡ telepty :: ${id}'`, {
                timeout: 2000, stdio: ['pipe', 'pipe', 'pipe']
              });
            } catch {}
          }
        }, 500);
        submitResult = { deferred: true, strategy: deliveryPath || 'ws' };
      }
    } else {
      // Spawned sessions: direct PTY write
      if (!writeToSession(finalPrompt)) {
        return res.status(503).json({ error: 'Process not connected' });
      }
      if (!no_enter) {
        setTimeout(() => {
          writeToSession('\r');
          console.log(`[INJECT+SUBMIT] PTY split_cr for ${id}`);
        }, 300);
        submitResult = { deferred: true, strategy: 'pty_split_cr' };
      }
    }

    console.log(`[INJECT] Wrote to session ${id} (inject_id: ${inject_id})`);

    const injectTimestamp = new Date().toISOString();
    const busMsg = JSON.stringify({
      type: 'inject_written',
      inject_id,
      sender: 'daemon',
      target_agent: id,
      content: prompt,
      from: from || null,
      reply_to: reply_to || null,
      thread_id: thread_id || null,
      reply_expected: !!reply_expected,
      timestamp: injectTimestamp
    });
    busClients.forEach(client => {
      if (client.readyState === 1) client.send(busMsg);
    });

    // Notify all attached viewers (telepty attach clients) about the inject
    // This enables aterm and other viewers to show inject events in real-time
    if (session.clients && session.clients.size > 0) {
      const viewerMsg = JSON.stringify({
        type: 'inject_notification',
        inject_id,
        session_id: id,
        from: from || null,
        content: prompt,
        timestamp: injectTimestamp
      });
      session.clients.forEach(client => {
        if (client !== session.ownerWs && client.readyState === 1) {
          client.send(viewerMsg);
        }
      });
    }

    if (requestedId !== resolvedId) {
      console.log(`[ALIAS] Resolved '${requestedId}' → '${resolvedId}'`);
    }

    if (from && reply_to) {
      const routedMsg = JSON.stringify({
        type: 'message_routed',
        message_id: inject_id,
        from,
        to: id,
        reply_to,
        inject_id,
        deliberation_session_id: req.body.deliberation_session_id || null,
        thread_id: req.body.thread_id || null,
        timestamp: new Date().toISOString()
      });
      busClients.forEach(client => {
        if (client.readyState === 1) client.send(routedMsg);
      });
    }

    res.json({ success: true, inject_id, submit: submitResult });
  } catch (err) {
    const busFailMsg = JSON.stringify({
      type: 'inject_write_failed',
      inject_id,
      sender: 'daemon',
      target_agent: id,
      error: err.message,
      timestamp: new Date().toISOString()
    });
    busClients.forEach(client => {
      if (client.readyState === 1) client.send(busFailMsg);
    });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/:id/screen — read current screen buffer
app.get('/api/sessions/:id/screen', (req, res) => {
  const requestedId = req.params.id;
  const resolvedId = resolveSessionAlias(requestedId);
  if (!resolvedId) return res.status(404).json({ error: 'Session not found', requested: requestedId });
  const session = sessions[resolvedId];

  const lines = parseInt(req.query.lines) || 50;
  const raw = req.query.raw === '1' || req.query.raw === 'true';

  if (!session.outputRing || session.outputRing.length === 0) {
    return res.json({ session_id: resolvedId, screen: '', lines: 0, raw: false });
  }

  // Join all buffered output
  const fullOutput = session.outputRing.join('');

  // Strip ANSI escape sequences for clean text
  function stripAnsi(str) {
    return str
      .replace(/[[0-9;]*[a-zA-Z]/g, '')      // CSI sequences
      .replace(/][^]*/g, '')          // OSC sequences (BEL terminated)
      .replace(/][^]*\\/g, '')  // OSC sequences (ST terminated)
      .replace(/[()][AB012]/g, '')              // Character set selection
      .replace(/[>=<]/g, '')                    // Keypad mode
      .replace(/[[?]?[0-9;]*[hlsurm]/g, '') // Mode set/reset
      .replace(/[[0-9;]*[ABCDHJ]/g, '')       // Cursor movement
      .replace(/[[0-9;]*[KG]/g, '')           // Line clearing
      .replace(/\r/g, '');                         // Carriage returns
  }

  const cleaned = raw ? fullOutput : stripAnsi(fullOutput);

  // Take last N lines
  const allLines = cleaned.split('\n');
  const lastLines = allLines.slice(-lines);
  const screen = lastLines.join('\n').trim();

  res.json({
    session_id: resolvedId,
    screen,
    lines: lastLines.length,
    total_lines: allLines.length,
    raw: !!raw
  });
});

app.patch('/api/sessions/:id', (req, res) => {
  const requestedId = req.params.id;
  const resolvedId = resolveSessionAlias(requestedId);
  if (!resolvedId) return res.status(404).json({ error: 'Session not found', requested: requestedId });
  const session = sessions[resolvedId];
  const id = resolvedId;
  const { new_id } = req.body;
  if (!new_id) return res.status(400).json({ error: 'new_id is required' });
  if (sessions[new_id]) return res.status(409).json({ error: `Session ID '${new_id}' is already in use.` });

  // Move session to new key
  sessions[new_id] = session;
  delete sessions[id];
  session.id = new_id;

  // Broadcast rename to bus
  const busMsg = JSON.stringify({
    type: 'session_rename',
    sender: 'daemon',
    old_id: id,
    new_id,
    timestamp: new Date().toISOString()
  });
  busClients.forEach(client => {
    if (client.readyState === 1) client.send(busMsg);
  });

  console.log(`[RENAME] Session '${id}' renamed to '${new_id}'`);
  res.json({ success: true, old_id: id, new_id });
});

app.delete('/api/sessions/:id', (req, res) => {
  const requestedId = req.params.id;
  const resolvedId = resolveSessionAlias(requestedId);
  if (!resolvedId) return res.status(404).json({ error: 'Session not found', requested: requestedId });
  const session = sessions[resolvedId];
  const id = resolvedId;
  if (session.isClosing) return res.json({ success: true, status: 'closing' });
  try {
    session.isClosing = true;
    if (session.type === 'wrapped') {
      session.clients.forEach(ws => ws.close(1000, 'Session destroyed'));
      delete sessions[id];
      console.log(`[KILL] Wrapped session ${id} removed`);
      persistSessions();
    } else {
      session.ptyProcess.kill();
      console.log(`[KILL] Session ${id} forcefully closed`);
      persistSessions();
    }
    res.json({ success: true, status: 'closing' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shared auto-router: handles turn_request events from any source (WS or HTTP)
function busAutoRoute(msg) {
  const eventType = msg.type || msg.kind;
  const isRoutable = (eventType === 'turn_request' || eventType === 'deliberation_route_turn') && (msg.target || msg.target_session_id);
  if (!isRoutable) {
    // Log all bus messages for debugging (excluding health checks)
    if (eventType && eventType !== 'session_health') {
      console.log(`[BUS] Event: ${eventType} (not routable)`);
    }
    return;
  }

  const rawTarget = (msg.target || msg.target_session_id).split('@')[0];
  const turnId = (msg.payload && msg.payload.turn_id) || null;
  console.log(`[BUS-ROUTE] ${eventType}: target=${rawTarget} turn=${turnId} msg_id=${msg.message_id || 'none'}`);
  const targetId = resolveSessionAlias(rawTarget);
  const targetSession = targetId ? sessions[targetId] : null;
  if (!targetSession) {
    console.log(`[BUS-ROUTE] Target ${rawTarget} not found among: ${Object.keys(sessions).join(', ')}`);
    return;
  }

  const prompt = (msg.payload && msg.payload.prompt) || msg.content || msg.prompt || JSON.stringify(msg);
  const inject_id = crypto.randomUUID();

  // Write to session (cmux auto-detect > kitty > session-level cmux > WS fallback)
  const sock = findKittySocket();
  if (!targetSession.kittyWindowId && sock) targetSession.kittyWindowId = findKittyWindowId(sock, targetId);
  const wid = targetSession.kittyWindowId;
  let delivered = false;

  // cmux per-session backend: send text + enter to surface
  if (!delivered && targetSession.backend === 'cmux') {
    const textOk = terminalBackend.cmuxSendText(targetId, prompt);
    if (textOk) {
      setTimeout(() => terminalBackend.cmuxSendEnter(targetId), 500);
      delivered = true;
    }
  }

  if (!delivered && wid && sock && targetSession.type === 'wrapped') {
    try {
      const escaped = prompt.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
      require('child_process').execSync(`kitty @ --to unix:${sock} send-text --match id:${wid} '${escaped}'`, {
        timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
      });
      setTimeout(() => {
        try {
          require('child_process').execSync(`kitty @ --to unix:${sock} send-text --match id:${wid} $'\\r'`, {
            timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
          });
        } catch {}
      }, 500);
      delivered = true;
    } catch {}
  }
  // Session-level cmux backend: use WS for text, cmux send-key for enter
  if (!delivered && targetSession.backend === 'cmux' && targetSession.cmuxWorkspaceId) {
    if (targetSession.type === 'wrapped' && targetSession.ownerWs && targetSession.ownerWs.readyState === 1) {
      targetSession.ownerWs.send(JSON.stringify({ type: 'inject', data: prompt }));
      setTimeout(() => submitViaCmux(targetId), 500);
      delivered = true;
    }
  }
  if (!delivered) {
    if (targetSession.type === 'wrapped' && targetSession.ownerWs && targetSession.ownerWs.readyState === 1) {
      targetSession.ownerWs.send(JSON.stringify({ type: 'inject', data: prompt }));
      setTimeout(() => {
        if (targetSession.ownerWs && targetSession.ownerWs.readyState === 1) {
          targetSession.ownerWs.send(JSON.stringify({ type: 'inject', data: '\r' }));
        }
      }, 300);
      delivered = true;
    } else if (targetSession.ptyProcess) {
      targetSession.ptyProcess.write(prompt);
      setTimeout(() => targetSession.ptyProcess.write('\r'), 300);
      delivered = true;
    }
  }

  // Emit inject_written ack
  const ackMsg = JSON.stringify({
    type: 'inject_written',
    inject_id,
    sender: 'daemon',
    source_host: MACHINE_ID,
    target_agent: targetId,
    source_type: 'bus_auto_route',
    turn_id: (msg.payload && msg.payload.turn_id) || null,
    original_message_id: msg.message_id || null,
    delivered,
    timestamp: new Date().toISOString()
  });
  busClients.forEach(client => {
    if (client.readyState === 1) client.send(ackMsg);
  });
  targetSession.lastActivityAt = new Date().toISOString();
  console.log(`[BUS-ROUTE] ${eventType} → ${targetId}: ${delivered ? 'delivered' : 'failed'}`);
}

app.post('/api/bus/publish', (req, res) => {
  const payload = req.body;

  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Payload must be a JSON object' });
  }

  let deliveredCount = 0;

  busClients.forEach(client => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(JSON.stringify(payload));
      deliveredCount++;
    }
  });

  // Auto-route if this is a turn_request
  busAutoRoute(payload);
  // Relay to peer daemons (dedup prevents loops)
  if (!payload._relayed_from) relayToPeers(payload);

  res.json({ success: true, delivered: deliveredCount });
});

app.post('/api/handoff', (req, res) => {
  const { source_session_id, deliberation_id, synthesis, auto_execute } = req.body;
  if (!synthesis) return res.status(400).json({ error: 'synthesis is required' });

  const handoff_id = crypto.randomUUID();
  const handoff = {
    id: handoff_id,
    source_session_id: source_session_id || null,
    deliberation_id: deliberation_id || null,
    synthesis,
    status: 'pending',
    auto_execute: !!auto_execute,
    claimed_by: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    progress: [],
    result: null
  };
  handoffs[handoff_id] = handoff;

  const busMsg = JSON.stringify({
    type: 'handoff.created',
    handoff_id,
    source_session_id: handoff.source_session_id,
    deliberation_id: handoff.deliberation_id,
    auto_execute: handoff.auto_execute,
    task_count: Array.isArray(synthesis.tasks) ? synthesis.tasks.length : 0,
    timestamp: handoff.created_at
  });
  busClients.forEach(client => {
    if (client.readyState === 1) client.send(busMsg);
  });

  console.log(`[HANDOFF] Created ${handoff_id} (${Array.isArray(synthesis.tasks) ? synthesis.tasks.length : 0} tasks)`);
  res.status(201).json({ handoff_id, status: 'pending' });
});

app.get('/api/handoff', (req, res) => {
  const status = req.query.status;
  const list = Object.values(handoffs)
    .filter(h => !status || h.status === status)
    .map(h => ({
      id: h.id,
      status: h.status,
      deliberation_id: h.deliberation_id,
      source_session_id: h.source_session_id,
      auto_execute: h.auto_execute,
      claimed_by: h.claimed_by,
      task_count: Array.isArray(h.synthesis.tasks) ? h.synthesis.tasks.length : 0,
      created_at: h.created_at,
      updated_at: h.updated_at
    }));
  res.json(list);
});

app.get('/api/handoff/:id', (req, res) => {
  const handoff = handoffs[req.params.id];
  if (!handoff) return res.status(404).json({ error: 'Handoff not found' });
  res.json(handoff);
});

app.post('/api/handoff/:id/claim', (req, res) => {
  const handoff = handoffs[req.params.id];
  if (!handoff) return res.status(404).json({ error: 'Handoff not found' });
  if (handoff.status !== 'pending') {
    return res.status(409).json({ error: `Handoff already ${handoff.status}`, claimed_by: handoff.claimed_by });
  }

  const { agent_session_id } = req.body;
  if (!agent_session_id) return res.status(400).json({ error: 'agent_session_id is required' });

  handoff.status = 'claimed';
  handoff.claimed_by = agent_session_id;
  handoff.updated_at = new Date().toISOString();

  const busMsg = JSON.stringify({
    type: 'handoff.claimed',
    handoff_id: handoff.id,
    agent_session_id,
    timestamp: handoff.updated_at
  });
  busClients.forEach(client => {
    if (client.readyState === 1) client.send(busMsg);
  });

  console.log(`[HANDOFF] ${handoff.id} claimed by ${agent_session_id}`);
  res.json({ success: true, handoff_id: handoff.id, status: 'claimed' });
});

app.patch('/api/handoff/:id', (req, res) => {
  const handoff = handoffs[req.params.id];
  if (!handoff) return res.status(404).json({ error: 'Handoff not found' });

  const { status, message, result } = req.body;
  const validTransitions = {
    pending: ['claimed'],
    claimed: ['executing', 'failed'],
    executing: ['completed', 'failed'],
  };

  if (status) {
    const allowed = validTransitions[handoff.status] || [];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `Invalid transition: ${handoff.status} -> ${status}` });
    }
    handoff.status = status;
  }

  if (message) {
    handoff.progress.push({ message, timestamp: new Date().toISOString() });
  }

  if (result) {
    handoff.result = result;
  }

  handoff.updated_at = new Date().toISOString();

  const busMsg = JSON.stringify({
    type: `handoff.${handoff.status}`,
    handoff_id: handoff.id,
    claimed_by: handoff.claimed_by,
    message: message || null,
    timestamp: handoff.updated_at
  });
  busClients.forEach(client => {
    if (client.readyState === 1) client.send(busMsg);
  });

  console.log(`[HANDOFF] ${handoff.id} -> ${handoff.status}${message ? ': ' + message : ''}`);
  res.json({ success: true, handoff_id: handoff.id, status: handoff.status });
});

// --- Deliberation Thread Tracking ---

app.post('/api/threads', (req, res) => {
  const { topic, orchestrator_session_id, participant_session_ids, context } = req.body;
  if (!topic) return res.status(400).json({ error: 'topic is required' });

  const thread_id = crypto.randomUUID();
  const thread = {
    id: thread_id,
    topic,
    orchestrator_session_id: orchestrator_session_id || null,
    participant_session_ids: participant_session_ids || [],
    context: context || null,
    status: 'active',
    message_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    closed_at: null
  };
  threads[thread_id] = thread;

  const busMsg = JSON.stringify({
    type: 'thread.opened',
    thread_id,
    topic,
    orchestrator_session_id: thread.orchestrator_session_id,
    participant_session_ids: thread.participant_session_ids,
    timestamp: thread.created_at
  });
  busClients.forEach(client => {
    if (client.readyState === 1) client.send(busMsg);
  });

  console.log(`[THREAD] Opened ${thread_id}: "${topic}" (${thread.participant_session_ids.length} participants)`);
  res.status(201).json({ thread_id, status: 'active' });
});

app.get('/api/threads', (req, res) => {
  const status = req.query.status;
  const list = Object.values(threads)
    .filter(t => !status || t.status === status)
    .map(t => ({
      id: t.id,
      topic: t.topic,
      status: t.status,
      orchestrator_session_id: t.orchestrator_session_id,
      participant_count: t.participant_session_ids.length,
      message_count: t.message_count,
      created_at: t.created_at,
      updated_at: t.updated_at
    }));
  res.json(list);
});

app.get('/api/threads/:id', (req, res) => {
  const thread = threads[req.params.id];
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  res.json(thread);
});

app.patch('/api/threads/:id', (req, res) => {
  const thread = threads[req.params.id];
  if (!thread) return res.status(404).json({ error: 'Thread not found' });

  const { status, message_count } = req.body;

  if (status === 'closed' && thread.status === 'active') {
    thread.status = 'closed';
    thread.closed_at = new Date().toISOString();
    thread.updated_at = thread.closed_at;

    const busMsg = JSON.stringify({
      type: 'thread.closed',
      thread_id: thread.id,
      topic: thread.topic,
      message_count: thread.message_count,
      timestamp: thread.closed_at
    });
    busClients.forEach(client => {
      if (client.readyState === 1) client.send(busMsg);
    });

    console.log(`[THREAD] Closed ${thread.id}: "${thread.topic}" (${thread.message_count} messages)`);
  }

  if (typeof message_count === 'number') {
    thread.message_count = message_count;
    thread.updated_at = new Date().toISOString();
  }

  res.json({ success: true, thread_id: thread.id, status: thread.status });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`🚀 aigentry-telepty daemon listening on http://${HOST}:${PORT}`);
});

const IDLE_THRESHOLD_SECONDS = 60;
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of Object.entries(sessions)) {
    const idleSeconds = session.lastActivityAt ? Math.floor((now - new Date(session.lastActivityAt).getTime()) / 1000) : null;
    const healthMsg = JSON.stringify({
      type: 'session_health',
      session_id: id,
      payload: {
        alive: session.type === 'wrapped' ? (session.ownerWs && session.ownerWs.readyState === 1) : (session.ptyProcess && !session.ptyProcess.killed),
        pid: session.ptyProcess?.pid || null,
        type: session.type,
        clients: session.clients ? session.clients.size : 0,
        idleSeconds
      },
      timestamp: new Date().toISOString()
    });
    busClients.forEach(client => {
      if (client.readyState === 1) client.send(healthMsg);
    });

    // Emit session.idle when idle exceeds threshold
    if (idleSeconds !== null && idleSeconds >= IDLE_THRESHOLD_SECONDS && !session._idleEmitted) {
      session._idleEmitted = true;
      const idleMsg = JSON.stringify({
        type: 'session.idle',
        session_id: id,
        idleSeconds,
        lastActivityAt: session.lastActivityAt,
        timestamp: new Date().toISOString()
      });
      busClients.forEach(client => {
        if (client.readyState === 1) client.send(idleMsg);
      });
      console.log(`[IDLE] Session ${id} idle for ${idleSeconds}s`);
    }
    // Reset idle flag when activity resumes
    if (idleSeconds !== null && idleSeconds < IDLE_THRESHOLD_SECONDS) {
      session._idleEmitted = false;
    }
  }
}, 10000);

server.on('error', (error) => {
  clearDaemonState(process.pid);

  if (error && error.code === 'EADDRINUSE') {
    console.error(`[DAEMON] Port ${PORT} is already in use. Another process is blocking telepty.`);
    process.exit(1);
  }

  throw error;
});


const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://' + req.headers.host);
  const sessionId = url.pathname.split('/').pop();
  const session = sessions[sessionId];
  // ?owner=1 indicates the allow bridge (PTY owner), not an attach viewer
  const isOwnerConnect = url.searchParams.get('owner') === '1';

  // Ping/pong heartbeat — detect and terminate stale TCP half-open connections (30s interval)
  let isAlive = true;
  ws.on('pong', () => { isAlive = true; });
  const pingInterval = setInterval(() => {
    if (!isAlive) {
      console.log(`[WS] Terminating stale connection (no pong) for ${sessionId}`);
      ws.terminate();
      return;
    }
    isAlive = false;
    ws.ping();
  }, 30000);

  if (!session) {
    // Auto-register wrapped session on WS connect (supports reconnect after daemon restart)
    const autoSession = {
      id: sessionId,
      type: 'wrapped',
      ptyProcess: null,
      ownerWs: ws,
      command: 'wrapped',
      cwd: process.cwd(),
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      clients: new Set([ws]),
      isClosing: false,
      outputRing: [],
      ready: false,
          };
    sessions[sessionId] = autoSession;
    console.log(`[WS] Auto-registered wrapped session ${sessionId} on reconnect`);
    // Set tab title via kitty (no \x0c redraw — it causes flickering on multi-session reconnect)
    setTimeout(() => {
      const sock = findKittySocket();
      const wid = findKittyWindowId(sock, sessionId);
      if (sock && wid) {
        try {
          require('child_process').execSync(`kitty @ --to unix:${sock} set-tab-title --match id:${wid} '⚡ telepty :: ${sessionId}'`, {
            timeout: 2000, stdio: ['pipe', 'pipe', 'pipe']
          });
        } catch {}
      }
    }, 1000);
  } else {
    session.clients.add(ws);
  }

  const activeSession = sessions[sessionId];

  // For wrapped sessions, first connector OR explicit ?owner=1 claim becomes the owner.
  // ?owner=1 reclaim handles the stale-ownerWs bug: allow bridge reconnects but stale TCP
  // half-open connection still holds ownerWs slot → reconnect wrongly becomes a viewer.
  if (activeSession.type === 'wrapped' && (!activeSession.ownerWs || isOwnerConnect)) {
    if (isOwnerConnect && activeSession.ownerWs && activeSession.ownerWs !== ws) {
      // Terminate the stale owner connection before claiming ownership
      console.log(`[WS] Replacing stale ownerWs for session ${sessionId}`);
      activeSession.ownerWs.terminate();
    }
    activeSession.ownerWs = ws;
    console.log(`[WS] Wrap owner ${isOwnerConnect && activeSession.clients.size > 1 ? 're-' : ''}connected for session ${sessionId} (Total: ${activeSession.clients.size})`);
  } else {
    console.log(`[WS] Client attached to session ${sessionId} (Total: ${activeSession.clients.size})`);
  }

  ws.on('message', (message) => {
    try {
      const { type, data, cols, rows } = JSON.parse(message);

      if (activeSession.type === 'wrapped') {
        if (ws === activeSession.ownerWs) {
          // Owner sending output -> broadcast to other clients + update activity
          if (type === 'output') {
            activeSession.lastActivityAt = new Date().toISOString();
            appendToOutputRing(activeSession, data);
            activeSession.clients.forEach(client => {
              if (client !== ws && client.readyState === 1) {
                client.send(JSON.stringify({ type: 'output', data }));
              }
            });
          } else if (type === 'ready') {
            activeSession.ready = true;
            activeSession.lastActivityAt = new Date().toISOString();
            console.log(`[READY] Session ${sessionId} CLI is ready for inject`);
            // Broadcast readiness to bus (cmux/kitty paths now enabled for this session)
            const readyMsg = JSON.stringify({
              type: 'session_ready',
              session_id: sessionId,
              timestamp: new Date().toISOString()
            });
            busClients.forEach(client => {
              if (client.readyState === 1) client.send(readyMsg);
            });
          }
        } else {
          // Non-owner client input -> forward to owner as inject
          if (type === 'input' && activeSession.ownerWs && activeSession.ownerWs.readyState === 1) {
            activeSession.ownerWs.send(JSON.stringify({ type: 'inject', data }));
          } else if (type === 'resize' && activeSession.ownerWs && activeSession.ownerWs.readyState === 1) {
            activeSession.ownerWs.send(JSON.stringify({ type: 'resize', cols, rows }));
          }
        }
      } else {
        // Existing spawned session logic
        if (type === 'input') {
          activeSession.ptyProcess.write(data);
        } else if (type === 'resize') {
          activeSession.ptyProcess.resize(cols, rows);
        }
      }
    } catch (e) {
      console.error('[WS] Invalid message format', e);
    }
  });

  ws.on('close', () => {
    clearInterval(pingInterval);
    activeSession.clients.delete(ws);
    if (activeSession.type === 'wrapped' && ws === activeSession.ownerWs) {
      activeSession.ownerWs = null;
      console.log(`[WS] Wrap owner disconnected from session ${sessionId} (Total: ${activeSession.clients.size})`);
      // Clean up wrapped session when owner disconnects and no other clients
      if (activeSession.clients.size === 0 && !activeSession.isClosing) {
        delete sessions[sessionId];
        console.log(`[CLEANUP] Wrapped session ${sessionId} removed (owner disconnected)`);
      }
    } else {
      console.log(`[WS] Client detached from session ${sessionId} (Total: ${activeSession.clients.size})`);
    }
  });
});

const busWss = new WebSocketServer({ noServer: true });
const busClients = new Set();

busWss.on('connection', (ws, req) => {
  busClients.add(ws);
  console.log('[BUS] New agent connected to event bus');

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);
      // Broadcast to all other bus clients
      busClients.forEach(client => {
        if (client !== ws && client.readyState === 1) {
          client.send(JSON.stringify(msg));
        }
      });

      // Auto-route turn_request events (shared logic with HTTP publish)
      busAutoRoute(msg);
      // Relay to peer daemons (dedup prevents loops)
      if (!msg._relayed_from) relayToPeers(msg);
    } catch (e) {
      console.error('[BUS] Invalid message format', e);
    }
  });

  ws.on('close', () => {
    busClients.delete(ws);
    console.log('[BUS] Agent disconnected from event bus');
  });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://' + req.headers.host);
  const token = url.searchParams.get('token');
  
  const wsAuthHeader = req.headers['authorization'] || '';
  const wsJwtValid = wsAuthHeader.startsWith('Bearer ') && verifyJwt(wsAuthHeader.slice(7));
  if (!isAllowedPeer(req.socket.remoteAddress) && token !== EXPECTED_TOKEN && !wsJwtValid) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  if (url.pathname.startsWith('/api/sessions/')) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else if (url.pathname === '/api/bus') {
    busWss.handleUpgrade(req, socket, head, (ws) => {
      busWss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

function shutdown(code) {
  clearDaemonState(process.pid);
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => {
  clearDaemonState(process.pid);
});
