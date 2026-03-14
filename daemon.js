const express = require('express');
const cors = require('cors');
const pty = require('node-pty');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { getConfig } = require('./auth');
const pkg = require('./package.json');
const { claimDaemonState, clearDaemonState } = require('./daemon-control');

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

app.get('/api/sessions/:id', (req, res) => {
  const requestedId = req.params.id;
  const resolvedId = resolveSessionAlias(requestedId);
  if (!resolvedId) return res.status(404).json({ error: 'Session not found' });
  const session = sessions[resolvedId];
  res.json({
    id: resolvedId,
    alias: requestedId !== resolvedId ? requestedId : null,
    type: session.type || 'spawned',
    command: session.command,
    cwd: session.cwd,
    createdAt: session.createdAt,
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
    capabilities: ['sessions', 'wrapped-sessions', 'skill-installer', 'singleton-daemon', 'handoff-inbox', 'deliberation-threads']
  });
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
        // Inject text first, then \r separately after delay
        if (session.type === 'wrapped') {
          if (session.ownerWs && session.ownerWs.readyState === 1) {
            session.ownerWs.send(JSON.stringify({ type: 'inject', data: prompt }));
            setTimeout(() => {
              if (session.ownerWs && session.ownerWs.readyState === 1) {
                session.ownerWs.send(JSON.stringify({ type: 'inject', data: '\r' }));
              }
            }, 300);
            results.successful.push({ id, strategy: 'split_cr' });
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
      // Inject text first, then \r separately after delay
      if (session.type === 'wrapped') {
        if (session.ownerWs && session.ownerWs.readyState === 1) {
          session.ownerWs.send(JSON.stringify({ type: 'inject', data: prompt }));
          setTimeout(() => {
            if (session.ownerWs && session.ownerWs.readyState === 1) {
              session.ownerWs.send(JSON.stringify({ type: 'inject', data: '\r' }));
            }
          }, 300);
          results.successful.push({ id, strategy: 'split_cr' });
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
function sendViaKitty(sessionId, text) {
  const { execSync } = require('child_process');
  const socketPaths = ['/tmp/kitty-sock', `/tmp/kitty-${process.getuid()}`];
  let socket = null;
  for (const p of socketPaths) {
    try {
      require('fs').accessSync(p);
      socket = p;
      break;
    } catch { /* skip */ }
  }
  if (!socket) return false;

  try {
    // Match by tab title containing session ID
    const escaped = text.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
    execSync(`kitty @ --to unix:${socket} send-text --match title:${sessionId} '${escaped}'`, {
      timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
    });
    console.log(`[KITTY] Sent ${text.length} chars to ${sessionId}`);
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
  if (strategy === 'pty_cr') {
    success = submitViaPty(session);
  } else if (strategy === 'osascript_cmd_enter') {
    success = submitViaOsascript(id, 'cmd_enter');
  } else {
    success = submitViaPty(session); // fallback
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

    if (strategy === 'pty_cr') {
      success = submitViaPty(session);
    } else if (strategy === 'osascript_cmd_enter') {
      success = submitViaOsascript(id, 'cmd_enter');
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

  // Auto-prepend [from:] [reply-to:] header if from is set and not already in prompt
  let finalPrompt = prompt;
  if (from && !prompt.startsWith('[from:')) {
    finalPrompt = `[from: ${from}] [reply-to: ${reply_to}] ${prompt}`;
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
    if (session.type === 'wrapped' && !no_enter) {
      // Wrapped sessions: try kitty remote control first (bypasses allow bridge entirely)
      const kittyPayload = finalPrompt + '\r';
      const kittyOk = sendViaKitty(id, kittyPayload);
      if (kittyOk) {
        submitResult = { strategy: 'kitty_remote' };
        console.log(`[INJECT+SUBMIT] Kitty remote for ${id}`);
      } else {
        // Fallback: WS text + osascript/WS Enter
        if (!writeToSession(finalPrompt)) {
          return res.status(503).json({ error: 'Wrap process is not connected' });
        }
        setTimeout(() => {
          const osascriptOk = submitViaOsascript(id, 'enter');
          if (!osascriptOk) {
            writeToSession('\r');
            console.log(`[INJECT+SUBMIT] WS \\r last-resort for ${id}`);
          }
        }, 500);
        submitResult = { deferred: true, strategy: 'osascript_fallback' };
      }
    } else if (session.type === 'wrapped') {
      // no_enter=true for wrapped
      const kittyOk = sendViaKitty(id, finalPrompt);
      if (!kittyOk) {
        if (!writeToSession(finalPrompt)) {
          return res.status(503).json({ error: 'Wrap process is not connected' });
        }
      }
      submitResult = { strategy: kittyOk ? 'kitty_remote_no_enter' : 'ws_no_enter' };
    } else {
      if (!writeToSession(finalPrompt)) {
        return res.status(503).json({ error: 'Wrap process is not connected' });
      }

      if (!no_enter) {
        // Spawned sessions: send \r separately after delay (proven split_cr strategy)
        setTimeout(() => {
          const ok = writeToSession('\r');
          console.log(`[INJECT+SUBMIT] Split \\r for ${id}: ${ok ? 'success' : 'failed'}`);
        }, 300);
        submitResult = { deferred: true, strategy: 'split_cr' };
      }
    }

    console.log(`[INJECT] Wrote to session ${id} (inject_id: ${inject_id})`);

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
      timestamp: new Date().toISOString()
    });
    busClients.forEach(client => {
      if (client.readyState === 1) client.send(busMsg);
    });

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

setInterval(() => {
  for (const [id, session] of Object.entries(sessions)) {
    const healthMsg = JSON.stringify({
      type: 'session_health',
      session_id: id,
      payload: {
        alive: session.type === 'wrapped' ? (session.ownerWs && session.ownerWs.readyState === 1) : (session.ptyProcess && !session.ptyProcess.killed),
        pid: session.ptyProcess?.pid || null,
        type: session.type,
        clients: session.clients ? session.clients.size : 0
      },
      timestamp: new Date().toISOString()
    });
    busClients.forEach(client => {
      if (client.readyState === 1) client.send(healthMsg);
    });
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
      clients: new Set([ws]),
      isClosing: false
    };
    sessions[sessionId] = autoSession;
    console.log(`[WS] Auto-registered wrapped session ${sessionId} on reconnect`);
    // Skip to message/close handlers below (ownerWs already set)
  } else {
    session.clients.add(ws);
  }

  const activeSession = sessions[sessionId];

  // For wrapped sessions, first connector becomes the owner
  if (activeSession.type === 'wrapped' && !activeSession.ownerWs) {
    activeSession.ownerWs = ws;
    console.log(`[WS] Wrap owner connected for session ${sessionId} (Total: ${activeSession.clients.size})`);
  } else {
    console.log(`[WS] Client attached to session ${sessionId} (Total: ${activeSession.clients.size})`);
  }

  ws.on('message', (message) => {
    try {
      const { type, data, cols, rows } = JSON.parse(message);

      if (activeSession.type === 'wrapped') {
        if (ws === activeSession.ownerWs) {
          // Owner sending output -> broadcast to other clients
          if (type === 'output') {
            activeSession.clients.forEach(client => {
              if (client !== ws && client.readyState === 1) {
                client.send(JSON.stringify({ type: 'output', data }));
              }
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

function shutdown(code) {
  clearDaemonState(process.pid);
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => {
  clearDaemonState(process.pid);
});
