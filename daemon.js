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

app.post('/api/sessions/spawn', (req, res) => {
  const { session_id, command, args = [], cwd = process.cwd(), cols = 80, rows = 30 } = req.body;
  if (!session_id) return res.status(400).json({ error: 'session_id is strictly required.' });
  if (sessions[session_id]) return res.status(409).json({ error: `Session ID '${session_id}' is already active.` });
  if (!command) return res.status(400).json({ error: 'command is required' });

  const isWin = os.platform() === 'win32';
  const shell = isWin ? (command === 'powershell' ? 'powershell.exe' : 'cmd.exe') : command;
  const shellArgs = isWin ? (command === 'powershell' || command === 'cmd' ? args : ['/c', command, ...args]) : args;

  try {
    console.log(`[SPAWN] Spawning ${shell} with args:`, shellArgs, "in cwd:", cwd);

    // Create a custom prompt for Linux/Mac so the user sees the session ID.
    // For bash/zsh, we can inject a custom PS1 variable.
    let customEnv = { ...process.env, TERM: isWin ? undefined : 'xterm-256color', TELEPTY_SESSION_ID: session_id };
    
    if (!isWin) {
      if (command.includes('bash')) {
        customEnv.PS1 = `\\[\\e[36m\\][telepty: ${session_id}]\\[\\e[0m\\] \\w \\$ `;
      } else if (command.includes('zsh')) {
        customEnv.PROMPT = `%F{cyan}[telepty: ${session_id}]%f %~ %# `;
      }
    }

    const ptyProcess = pty.spawn(shell, shellArgs, {
      name: isWin ? 'Windows Terminal' : 'xterm-256color',
      cols: parseInt(cols),
      rows: parseInt(rows),
      cwd,
      env: customEnv
    });

    sessions[session_id] = {
      ptyProcess,
      command,
      cwd,
      createdAt: new Date().toISOString(),
      clients: new Set()
    };

    ptyProcess.onData((data) => {
      sessions[session_id].clients.forEach(ws => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'output', data }));
      });
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      console.log(`[EXIT] Session ${session_id} exited with code ${exitCode}`);
      sessions[session_id].clients.forEach(ws => ws.close(1000, 'Session exited'));
      delete sessions[session_id];
    });

    console.log(`[SPAWN] Created session ${session_id} (${command})`);
    res.status(201).json({ session_id, command, cwd });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions', (req, res) => {
  const list = Object.entries(sessions).map(([id, session]) => ({
    id,
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
        session.ptyProcess.write(`${prompt}\r`);
        results.successful.push(id);
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
    try {
      sessions[id].ptyProcess.write(`${prompt}\r`);
      results.successful.push(id);
    } catch (err) {
      results.failed.push({ id, error: err.message });
    }
  });

  res.json({ success: true, results });
});

app.post('/api/sessions/:id/inject', (req, res) => {
  const { id } = req.params;
  const { prompt } = req.body;
  const session = sessions[id];
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });
  try {
    session.ptyProcess.write(`${prompt}\r`);
    console.log(`[INJECT] Wrote to session ${id}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sessions/:id', (req, res) => {
  const { id } = req.params;
  const session = sessions[id];
  if (!session) return res.status(404).json({ error: 'Session not found' });
  try {
    session.ptyProcess.kill();
    delete sessions[id];
    console.log(`[KILL] Session ${id} forcefully closed`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const server = app.listen(PORT, HOST, () => {
  console.log(`🚀 aigentry-telepty daemon listening on http://${HOST}:${PORT}`);
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const isLocalhost = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1' || req.socket.remoteAddress === '::ffff:127.0.0.1';
  const isTailscale = req.socket.remoteAddress && req.socket.remoteAddress.startsWith('100.');
  
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');

  if (!isLocalhost && !isTailscale && token !== EXPECTED_TOKEN) {
    console.warn(`[WS-AUTH] Rejected unauthorized WebSocket from ${req.socket.remoteAddress}`);
    ws.close(1008, 'Unauthorized');
    return;
  }

  const sessionId = url.pathname.split('/').pop();
  const session = sessions[sessionId];

  if (!session) {
    ws.close(1008, 'Session not found');
    return;
  }

  session.clients.add(ws);
  console.log(`[WS] Client attached to session ${sessionId} (Total: ${session.clients.size})`);

  ws.on('message', (message) => {
    try {
      const { type, data, cols, rows } = JSON.parse(message);
      if (type === 'input') {
        session.ptyProcess.write(data);
      } else if (type === 'resize') {
        session.ptyProcess.resize(cols, rows);
      }
    } catch (e) {
      console.error('[WS] Invalid message format', e);
    }
  });

  ws.on('close', () => {
    session.clients.delete(ws);
    console.log(`[WS] Client detached from session ${sessionId} (Total: ${session.clients.size})`);
  });
});
