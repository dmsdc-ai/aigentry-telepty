const express = require('express');
const cors = require('cors');
const pty = require('node-pty');
const os = require('os');
const { WebSocketServer } = require('ws');
const { getConfig } = require('./auth');

const config = getConfig();
const EXPECTED_TOKEN = config.authToken;

const app = express();
app.use(cors());
app.use(express.json());

// Authentication Middleware
app.use((req, res, next) => {
  const isLocalhost = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
  const isTailscale = req.ip && req.ip.startsWith('100.');
  
  if (isLocalhost || isTailscale) {
    return next(); // Trust local and Tailscale networks
  }

  const token = req.headers['x-telepty-token'] || req.query.token;
  if (token === EXPECTED_TOKEN) {
    return next();
  }

  console.warn(`[AUTH] Rejected unauthorized request from ${req.ip}`);
  res.status(401).json({ error: 'Unauthorized: Invalid or missing token.' });
});

const PORT = process.env.PORT || 3848;

const HOST = process.env.HOST || '0.0.0.0';

const sessions = {};
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

app.post('/api/sessions/spawn', (req, res) => {
  const { session_id, command, args = [], cwd = process.cwd(), cols = 80, rows = 30, type = 'AGENT' } = req.body;
  if (!session_id) return res.status(400).json({ error: 'session_id is strictly required.' });
  if (sessions[session_id]) return res.status(409).json({ error: `Session ID '${session_id}' is already active.` });
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
      clients: new Set(),
      isClosing: false
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
    res.status(201).json({ session_id, command, cwd });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions/register', (req, res) => {
  const { session_id, command, cwd = process.cwd() } = req.body;
  if (!session_id) return res.status(400).json({ error: 'session_id is required' });
  if (sessions[session_id]) return res.status(409).json({ error: `Session ID '${session_id}' is already active.` });

  const sessionRecord = {
    id: session_id,
    type: 'wrapped',
    ptyProcess: null,
    ownerWs: null,
    command: command || 'wrapped',
    cwd,
    createdAt: new Date().toISOString(),
    clients: new Set(),
    isClosing: false
  };
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
  res.status(201).json({ session_id, type: 'wrapped', command: sessionRecord.command, cwd });
});

app.get('/api/sessions', (req, res) => {
  const list = Object.entries(sessions).map(([id, session]) => ({
    id,
    type: session.type || 'spawned',
    command: session.command,
    cwd: session.cwd,
    createdAt: session.createdAt,
    active_clients: session.clients.size
  }));
  res.json(list);
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
        const injectData = `${prompt}\r`;
        if (session.type === 'wrapped') {
          if (session.ownerWs && session.ownerWs.readyState === 1) {
            session.ownerWs.send(JSON.stringify({ type: 'inject', data: injectData }));
            results.successful.push(id);
          } else {
            results.failed.push({ id, error: 'Wrap process not connected' });
          }
        } else {
          session.ptyProcess.write(injectData);
          results.successful.push(id);
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
      const injectData = `${prompt}\r`;
      if (session.type === 'wrapped') {
        if (session.ownerWs && session.ownerWs.readyState === 1) {
          session.ownerWs.send(JSON.stringify({ type: 'inject', data: injectData }));
          results.successful.push(id);
        } else {
          results.failed.push({ id, error: 'Wrap process not connected' });
        }
      } else {
        session.ptyProcess.write(injectData);
        results.successful.push(id);
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

app.post('/api/sessions/:id/inject', (req, res) => {
  const { id } = req.params;
  const { prompt, no_enter } = req.body;
  const session = sessions[id];
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });
  try {
    const injectData = no_enter ? prompt : `${prompt}\r`;
    if (session.type === 'wrapped') {
      if (session.ownerWs && session.ownerWs.readyState === 1) {
        session.ownerWs.send(JSON.stringify({ type: 'inject', data: injectData }));
      } else {
        return res.status(503).json({ error: 'Wrap process is not connected' });
      }
    } else {
      session.ptyProcess.write(injectData);
    }
    console.log(`[INJECT] Wrote to session ${id}`);

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

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/sessions/:id', (req, res) => {
  const { id } = req.params;
  const { new_id } = req.body;
  const session = sessions[id];
  if (!session) return res.status(404).json({ error: 'Session not found' });
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
  const { id } = req.params;
  const session = sessions[id];
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.isClosing) return res.json({ success: true, status: 'closing' });
  try {
    session.isClosing = true;
    if (session.type === 'wrapped') {
      session.clients.forEach(ws => ws.close(1000, 'Session destroyed'));
      delete sessions[id];
      console.log(`[KILL] Wrapped session ${id} removed`);
    } else {
      session.ptyProcess.kill();
      console.log(`[KILL] Session ${id} forcefully closed`);
    }
    res.json({ success: true, status: 'closing' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

  res.json({ success: true, delivered: deliveredCount });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`🚀 aigentry-telepty daemon listening on http://${HOST}:${PORT}`);
});


const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://' + req.headers.host);
  const sessionId = url.pathname.split('/').pop();
  const session = sessions[sessionId];

  if (!session) {
    ws.close(1008, 'Session not found');
    return;
  }

  session.clients.add(ws);

  // For wrapped sessions, first connector becomes the owner
  if (session.type === 'wrapped' && !session.ownerWs) {
    session.ownerWs = ws;
    console.log(`[WS] Wrap owner connected for session ${sessionId} (Total: ${session.clients.size})`);
  } else {
    console.log(`[WS] Client attached to session ${sessionId} (Total: ${session.clients.size})`);
  }

  ws.on('message', (message) => {
    try {
      const { type, data, cols, rows } = JSON.parse(message);

      if (session.type === 'wrapped') {
        if (ws === session.ownerWs) {
          // Owner sending output -> broadcast to other clients
          if (type === 'output') {
            session.clients.forEach(client => {
              if (client !== ws && client.readyState === 1) {
                client.send(JSON.stringify({ type: 'output', data }));
              }
            });
          }
        } else {
          // Non-owner client input -> forward to owner as inject
          if (type === 'input' && session.ownerWs && session.ownerWs.readyState === 1) {
            session.ownerWs.send(JSON.stringify({ type: 'inject', data }));
          } else if (type === 'resize' && session.ownerWs && session.ownerWs.readyState === 1) {
            session.ownerWs.send(JSON.stringify({ type: 'resize', cols, rows }));
          }
        }
      } else {
        // Existing spawned session logic
        if (type === 'input') {
          session.ptyProcess.write(data);
        } else if (type === 'resize') {
          session.ptyProcess.resize(cols, rows);
        }
      }
    } catch (e) {
      console.error('[WS] Invalid message format', e);
    }
  });

  ws.on('close', () => {
    session.clients.delete(ws);
    if (session.type === 'wrapped' && ws === session.ownerWs) {
      session.ownerWs = null;
      console.log(`[WS] Wrap owner disconnected from session ${sessionId} (Total: ${session.clients.size})`);
      // Clean up wrapped session when owner disconnects and no other clients
      if (session.clients.size === 0 && !session.isClosing) {
        delete sessions[sessionId];
        console.log(`[CLEANUP] Wrapped session ${sessionId} removed (owner disconnected)`);
      }
    } else {
      console.log(`[WS] Client detached from session ${sessionId} (Total: ${session.clients.size})`);
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
      // For MVP, simply broadcast any valid JSON message to all other bus clients
      busClients.forEach(client => {
        if (client !== ws && client.readyState === 1) {
          client.send(JSON.stringify(msg));
        }
      });
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
  
  const isLocalhost = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1' || req.socket.remoteAddress === '::ffff:127.0.0.1';
  const isTailscale = req.socket.remoteAddress && req.socket.remoteAddress.startsWith('100.');
  
  if (!isLocalhost && !isTailscale && token !== EXPECTED_TOKEN) {
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
