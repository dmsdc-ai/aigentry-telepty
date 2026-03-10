const express = require('express');
const cors = require('cors');
const pty = require('node-pty');
const os = require('os');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3848;
const HOST = process.env.HOST || '0.0.0.0';

const sessions = {};

function generateId() { return crypto.randomBytes(4).toString('hex'); }

app.post('/api/sessions/spawn', (req, res) => {
  const { command, args = [], cwd = process.cwd() } = req.body;
  if (!command) return res.status(400).json({ error: 'command is required' });
  const sessionId = generateId();
  const shell = os.platform() === 'win32' ? 'cmd.exe' : command;
  const shellArgs = os.platform() === 'win32' ? ['/c', command, ...args] : args;
  try {
    const ptyProcess = pty.spawn(shell, shellArgs, { name: 'xterm-color', cols: 80, rows: 30, cwd, env: process.env });
    ptyProcess.onExit(({ exitCode }) => { console.log(`Session ${sessionId} exited`); delete sessions[sessionId]; });
    sessions[sessionId] = { ptyProcess, command, cwd, createdAt: new Date().toISOString() };
    console.log(`[SPAWN] Created session ${sessionId}`);
    res.status(201).json({ sessionId, command, cwd });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions', (req, res) => {
  const list = Object.entries(sessions).map(([id, session]) => ({ id, command: session.command, cwd: session.cwd, createdAt: session.createdAt }));
  res.json(list);
});

app.post('/api/sessions/:id/inject', (req, res) => {
  const { id } = req.params; const { prompt } = req.body;
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

app.listen(PORT, HOST, () => { console.log(`🚀 aigentry-telepty daemon listening on http://${HOST}:${PORT}`); });
