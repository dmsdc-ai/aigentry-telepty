'use strict';

const fs = require('fs');
const path = require('path');
const { resolveSessionDir, checkRoot, checkFile, openFile, readFile, writeFile } = require('./path-boundary');

// Versioned local-filesystem locking. Legacy PID files are never auto-unlinked.
const { acquireLock, reapSessionLocks, isProcessAlive } = require('./lock');
function breakStaleLocks(root) {
  return listSessionDirs(root).reduce((count, {dir}) => count + reapSessionLocks(dir), 0);
}

// --- JSONL read/write ---

function readJsonl(filePath) {
  if (!checkFile(filePath)) return [];
  const content = readFile(filePath);
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
  writeFile(filePath, JSON.stringify(obj) + '\n', true);
}

function writeJsonl(filePath, objects) {
  const content = objects.map(o => JSON.stringify(o)).join('\n') + (objects.length > 0 ? '\n' : '');
  writeFile(filePath, content);
}

// --- Session directory helpers ---

function ensureSessionDir(root, sessionId) {
  const dir = resolveSessionDir(root, sessionId);
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  return resolveSessionDir(root, sessionId);
}

function listSessionDirs(root) {
  checkRoot(root);
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() || d.isSymbolicLink())
    .map(d => ({ sessionId: d.name, dir: resolveSessionDir(root, d.name) }));
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
  breakStaleLocks,
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
  isProcessAlive,
};
