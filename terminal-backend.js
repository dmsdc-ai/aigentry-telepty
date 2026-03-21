'use strict';

const { execSync } = require('child_process');

// Detect terminal environment at daemon level
function detectTerminal() {
  // 1. cmux: check env var or cmux ping
  if (process.env.CMUX_WORKSPACE_ID) {
    try {
      execSync('cmux ping', { timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] });
      return 'cmux';
    } catch {}
  }

  // 2. kitty: check for socket
  try {
    const files = require('fs').readdirSync('/tmp').filter(f => f.startsWith('kitty-sock'));
    if (files.length > 0) return 'kitty';
  } catch {}

  // 3. headless fallback
  return 'headless';
}

// Cache: sessionId -> surfaceRef
const surfaceCache = new Map();
let lastCacheRefresh = 0;
const CACHE_TTL = 30000; // 30 seconds

// Build session -> cmux surface mapping from tab titles
function refreshSurfaceCache() {
  const now = Date.now();
  if (now - lastCacheRefresh < CACHE_TTL && surfaceCache.size > 0) return;

  try {
    // Find number of workspaces from list-windows
    const windowsOutput = execSync('cmux list-windows', { timeout: 5000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const workspacesMatch = windowsOutput.match(/workspaces=(\d+)/);
    const workspaceCount = workspacesMatch ? parseInt(workspacesMatch[1]) : 10;

    surfaceCache.clear();
    for (let i = 1; i <= workspaceCount; i++) {
      try {
        const output = execSync(`cmux list-pane-surfaces --workspace workspace:${i}`, {
          timeout: 3000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
        });
        // Parse: "* surface:1  ⚡ telepty :: aigentry-orchestrator-claude  [selected]"
        const lines = output.split('\n').filter(l => l.trim());
        for (const line of lines) {
          const surfaceMatch = line.match(/surface:(\d+)/);
          const sessionMatch = line.match(/telepty\s*::\s*(\S+)/);
          if (surfaceMatch && sessionMatch) {
            surfaceCache.set(sessionMatch[1], `surface:${surfaceMatch[1]}`);
          }
        }
      } catch {}
    }
    lastCacheRefresh = now;
    console.log(`[BACKEND] Refreshed cmux surface cache: ${surfaceCache.size} sessions mapped`);
  } catch (err) {
    console.error(`[BACKEND] Failed to refresh surface cache:`, err.message);
  }
}

// Find cmux surface ref for a session
function findSurface(sessionId) {
  refreshSurfaceCache();

  // Direct match
  if (surfaceCache.has(sessionId)) return surfaceCache.get(sessionId);

  // Prefix match (e.g., "aigentry-orchestrator" matches "aigentry-orchestrator-claude")
  for (const [id, ref] of surfaceCache.entries()) {
    if (id.startsWith(sessionId) || sessionId.startsWith(id)) return ref;
  }

  return null;
}

// Send text to a cmux surface
function cmuxSendText(sessionId, text) {
  const surface = findSurface(sessionId);
  if (!surface) return false;

  try {
    // Escape single quotes for shell
    const escaped = text.replace(/'/g, "'\\''");
    execSync(`cmux send --surface ${surface} '${escaped}'`, {
      timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
    });
    console.log(`[BACKEND] cmux send text to ${sessionId} (${surface})`);
    return true;
  } catch (err) {
    console.error(`[BACKEND] cmux send failed for ${sessionId}:`, err.message);
    // Invalidate cache entry
    surfaceCache.delete(sessionId);
    return false;
  }
}

// Send enter key to a cmux surface
function cmuxSendEnter(sessionId) {
  const surface = findSurface(sessionId);
  if (!surface) return false;

  try {
    execSync(`cmux send-key --surface ${surface} return`, {
      timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
    });
    console.log(`[BACKEND] cmux send-key return to ${sessionId} (${surface})`);
    return true;
  } catch (err) {
    console.error(`[BACKEND] cmux send-key failed for ${sessionId}:`, err.message);
    surfaceCache.delete(sessionId);
    return false;
  }
}

// Invalidate cache for a session (e.g., when surface changes)
function invalidateCache(sessionId) {
  surfaceCache.delete(sessionId);
}

function clearCache() {
  surfaceCache.clear();
  lastCacheRefresh = 0;
}

module.exports = {
  detectTerminal,
  findSurface,
  cmuxSendText,
  cmuxSendEnter,
  refreshSurfaceCache,
  invalidateCache,
  clearCache
};
