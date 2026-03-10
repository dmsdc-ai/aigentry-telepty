const express = require('express');
const cors = require('cors');
const pty = require('node-pty');
const os = require('os');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3848;
const HOST = process.env.HOST || '0.0.0.0';

const sessions = {};

app.post('/api/sessions/spawn', (req, res) => {
  const { session_id, command, args = [], cwd = process.cwd() } = req.body;
  if (!session_id) return res.status(400).json({ error: 'session_id is strictly required. Auto-generation is disabled to enforce deterministic routing.' });
  if (sessions[session_id]) return res.status(409).json({ error: `Session ID '${session_id}' is already actively running.` });
  if (!command) return res.status(400).json({ error: 'command is required' });
  const shell = os.platform() === 'win32' ? 'cmd.exe' : command;
  const shellArgs = os.platform() === 'win32' ? ['/c', command, ...args] : args;
  try {
    const ptyProcess = pty.spawn(shell, shellArgs, { name: 'xterm-color', cols: 80, rows: 30, cwd, env: process.env });
    ptyProcess.onExit(({ exitCode }) => { console.log(`Session ${session_id} exited`); delete sessions[session_id]; });
    sessions[session_id] = { ptyProcess, command, cwd, createdAt: new Date().toISOString() };
    console.log(`[SPAWN] Created session ${session_id}`);
    res.status(201).json({ session_id, command, cwd });
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
