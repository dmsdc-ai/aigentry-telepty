'use strict';

const { execSync, execFileSync } = require('child_process');

// #17/#30/#31: validate a cmux id before it flows into a cmux invocation. cmux ids are
// UUIDs, typed short-refs (workspace:N / surface:N / pane:N / window:N / tab:N), or numeric
// indexes. New surface-lifecycle methods shell out via execFileSync (arg arrays, no shell),
// and this allowlist additionally rejects anything malformed.
const CMUX_REF_RE = /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|(?:workspace|surface|pane|window|tab):\d+|\d+)$/;
function isCmuxRef(id) {
  return typeof id === 'string' && CMUX_REF_RE.test(id);
}

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

// #17/#30: liveness of a session's cmux workspace surface (forced, cache-bypassing).
//   'unknown' — non-cmux backend, missing/invalid id, OR cmux itself unreachable. The last
//               case is the INV-17 gate: a cmux app-quit/restart makes ALL surfaces vanish at
//               once, so an unreachable cmux means INDETERMINATE → caller must PRESERVE (GC
//               nothing), preserving the #486/#488 survival guarantee.
//   'gone'    — cmux reachable but this session's workspace UUID is absent from the live list
//               (an explicit single-workspace close while the bridge survived).
//   'alive'   — cmux reachable and the workspace is present.
function isSurfaceAlive(session) {
  if (!session || session.backend !== 'cmux') return 'unknown';
  const wid = session.cmuxWorkspaceId;
  if (!isCmuxRef(wid)) return 'unknown';
  // INV-17 gate: cmux unreachable → INDETERMINATE.
  try {
    execFileSync('cmux', ['ping'], { timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return 'unknown';
  }
  // Enumerate live workspace UUIDs. A failure here (pinged OK but list errored) is still
  // treated as INDETERMINATE rather than 'gone', so a transient cmux hiccup never GCs.
  let listing;
  try {
    listing = execFileSync('cmux', ['--id-format', 'uuids', 'list-workspaces'], {
      timeout: 5000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch {
    return 'unknown';
  }
  const needle = String(wid).toLowerCase();
  const present = listing.split('\n').some(line => line.toLowerCase().includes(needle));
  return present ? 'alive' : 'gone';
}

// Terminal-surface CLOSE is owned by the orchestrator's Workspace Host adapter
// (workspace-host.sh `wh_close`), per the 2026-05-30 surface-ownership verdict — telepty
// probes liveness and emits `surface_orphaned`, it does not actuate surface close on the
// managed path. This function is a STANDALONE-ONLY fallback (orchestrator-absent): it stays a
// no-op unless AIGENTRY_TELEPTY_SELF_CLOSE_SURFACE=1, so a single-installed telepty can opt in
// to closing its own orphan tab. Default off → no managed-path double-close.
function closeSurface(session) {
  if (process.env.AIGENTRY_TELEPTY_SELF_CLOSE_SURFACE !== '1') return true; // managed default: no-op
  if (!session || session.backend !== 'cmux') return true; // kitty/headless: no-op
  const wid = session.cmuxWorkspaceId;
  if (!isCmuxRef(wid)) return true; // nothing addressable to close
  try {
    execFileSync('cmux', ['close-workspace', '--workspace', String(wid)], {
      timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
    });
    console.log(`[BACKEND] cmux close-workspace ${wid} (self-close opt-in)`);
    return true;
  } catch (err) {
    // Already-gone / transient: harmless no-op, never blocks the destroy.
    console.log(`[BACKEND] cmux close-workspace ${wid} no-op (${err.message})`);
    return true;
  }
}

module.exports = {
  detectTerminal,
  findSurface,
  cmuxSendText,
  cmuxSendEnter,
  refreshSurfaceCache,
  invalidateCache,
  clearCache,
  isSurfaceAlive,
  closeSurface
};
