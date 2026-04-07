'use strict';

const fs = require('fs');
const path = require('path');

// --- Advisory file locking (PID-based, per-session) ---

const LOCK_POLL_MS = 10;
const LOCK_TIMEOUT_MS = 500;

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Acquire an advisory lock for a session directory.
 * Returns a release function. Throws on timeout.
 */
function acquireLock(sessionDir) {
  const lockPath = path.join(sessionDir, '.lock');
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try { fs.unlinkSync(lockPath); } catch {}
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      // Lock file exists — check for stale PID
      try {
        const content = fs.readFileSync(lockPath, 'utf8').trim();
        const pid = Number(content);
        if (pid > 0 && !isProcessAlive(pid)) {
          // Stale lock — remove and retry
          try { fs.unlinkSync(lockPath); } catch {}
          continue;
        }
      } catch {
        // Can't read lock file — remove and retry
        try { fs.unlinkSync(lockPath); } catch {}
        continue;
      }

      // Lock is held by a live process — wait
      const buffer = new SharedArrayBuffer(4);
      const view = new Int32Array(buffer);
      Atomics.wait(view, 0, 0, LOCK_POLL_MS);
    }
  }

  throw new Error(`Mailbox lock timeout for ${sessionDir}`);
}

// --- JSONL read/write ---

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  const results = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      results.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines
    }
  }
  return results;
}

function appendJsonl(filePath, obj) {
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
}

function writeJsonl(filePath, objects) {
  const content = objects.map(o => JSON.stringify(o)).join('\n') + (objects.length > 0 ? '\n' : '');
  fs.writeFileSync(filePath, content);
}

// --- Session directory helpers ---

function ensureSessionDir(root, sessionId) {
  const dir = path.join(root, sessionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function listSessionDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => ({ sessionId: d.name, dir: path.join(root, d.name) }));
}

// --- State helpers ---

/**
 * Load the latest state for each msg_id from state.jsonl.
 * Returns Map<msg_id, { state, ts, attempt? }>
 */
function loadStates(sessionDir) {
  const entries = readJsonl(path.join(sessionDir, 'state.jsonl'));
  const states = new Map();
  for (const entry of entries) {
    states.set(entry.msg_id, entry);
  }
  return states;
}

function appendState(sessionDir, msgId, state, ts) {
  appendJsonl(path.join(sessionDir, 'state.jsonl'), { msg_id: msgId, state, ts });
}

/**
 * Load all messages from inbox.jsonl.
 */
function loadMessages(sessionDir) {
  return readJsonl(path.join(sessionDir, 'inbox.jsonl'));
}

/**
 * Count pending messages (state === 'pending' and not yet past scheduled delivery time).
 */
function countPending(sessionDir, nowSecs) {
  const states = loadStates(sessionDir);
  let count = 0;
  for (const entry of states.values()) {
    if (entry.state === 'pending') count++;
  }
  return count;
}

/**
 * Compact inbox.jsonl and state.jsonl — remove acked/expired/dead_letter entries.
 */
function compact(sessionDir, threshold) {
  const states = loadStates(sessionDir);
  const terminalStates = new Set(['acked', 'expired', 'dead_letter']);
  let terminalCount = 0;
  for (const entry of states.values()) {
    if (terminalStates.has(entry.state)) terminalCount++;
  }

  if (terminalCount < threshold) return;

  const messages = loadMessages(sessionDir);
  const activeMessages = messages.filter(m => {
    const st = states.get(m.msg_id);
    return !st || !terminalStates.has(st.state);
  });
  writeJsonl(path.join(sessionDir, 'inbox.jsonl'), activeMessages);

  const activeStates = [];
  for (const entry of states.values()) {
    if (!terminalStates.has(entry.state)) {
      activeStates.push(entry);
    }
  }
  writeJsonl(path.join(sessionDir, 'state.jsonl'), activeStates);
}

module.exports = {
  acquireLock,
  readJsonl,
  appendJsonl,
  writeJsonl,
  ensureSessionDir,
  listSessionDirs,
  loadStates,
  appendState,
  loadMessages,
  countPending,
  compact,
};
