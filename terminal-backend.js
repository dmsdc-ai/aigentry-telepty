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

function getExpectedPtyPid(session) {
  if (!session) return null;
  const candidates = [
    session.ptyPid,
    session.pty_pid,
    session.ptyProcess && session.ptyProcess.pid,
    session.pid
  ];
  for (const pid of candidates) {
    const n = Number(pid);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

function isPtyPidAlive(pid, options = {}) {
  const processKill = options.processKill || process.kill;
  try {
    processKill(pid, 0);
    return true;
  } catch (err) {
    return !!(err && err.code === 'EPERM');
  }
}

function normalizeTty(value) {
  if (typeof value !== 'string') return null;
  const tty = value.trim().replace(/^\/dev\//, '');
  if (!tty || tty === '?' || tty === '??') return null;
  return tty.toLowerCase();
}

function readProcessTty(pid, options = {}) {
  if (typeof options.readProcessTty === 'function') {
    return normalizeTty(options.readProcessTty(pid));
  }
  const execFile = options.execFileSync || execFileSync;
  try {
    return normalizeTty(execFile('ps', ['-o', 'tty=', '-p', String(pid)], {
      timeout: 2000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
    }));
  } catch {
    return null;
  }
}

function asString(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return null;
}

function getObjectString(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    const value = asString(obj[key]);
    if (value) return value;
  }
  return null;
}

function lower(value) {
  return String(value || '').toLowerCase();
}

function stringMatchesRef(value, ref) {
  if (!value || !ref) return false;
  return lower(value) === lower(ref);
}

function collectObjects(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, out);
    return out;
  }
  out.push(value);
  for (const child of Object.values(value)) collectObjects(child, out);
  return out;
}

const WORKSPACE_REF_KEYS = [
  'workspaceId', 'workspace_id', 'workspaceRef', 'workspace_ref',
  'id', 'ref', 'uuid'
];
const SURFACE_REF_KEYS = [
  'surfaceId', 'surface_id', 'surfaceRef', 'surface_ref',
  'terminalSurfaceId', 'terminal_surface_id',
  'terminalSurfaceRef', 'terminal_surface_ref',
  'id', 'ref', 'uuid'
];
const TITLE_KEYS = ['title', 'name', 'label', 'tabTitle', 'tab_title'];

function objectType(obj) {
  return lower(getObjectString(obj, ['type', 'kind', 'nodeType', 'node_type']));
}

function getWorkspaceRef(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of WORKSPACE_REF_KEYS) {
    const value = asString(obj[key]);
    if (!value) continue;
    if (key.toLowerCase().includes('workspace') || lower(value).startsWith('workspace:') || objectType(obj).includes('workspace')) {
      return value;
    }
  }
  return null;
}

function getSurfaceRef(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of SURFACE_REF_KEYS) {
    const value = asString(obj[key]);
    if (!value) continue;
    if (key.toLowerCase().includes('surface') || lower(value).startsWith('surface:') || objectType(obj).includes('surface')) {
      return value;
    }
  }
  return null;
}

function getTitle(obj) {
  return getObjectString(obj, TITLE_KEYS);
}

function titleHasSessionMarker(title, sessionId) {
  if (!title || !sessionId) return false;
  const marker = `telepty :: ${sessionId}`;
  return title === sessionId || title.includes(marker);
}

function isWorkspaceCandidate(obj) {
  return objectType(obj).includes('workspace') || lower(getWorkspaceRef(obj)).startsWith('workspace:');
}

function isSurfaceCandidate(obj) {
  return objectType(obj).includes('surface') || lower(getSurfaceRef(obj)).startsWith('surface:');
}

function workspaceMatches(obj, session, sessionId) {
  const wid = session.cmuxWorkspaceId;
  if (wid) {
    for (const key of WORKSPACE_REF_KEYS) {
      if (stringMatchesRef(asString(obj[key]), wid)) return true;
    }
  }
  const title = getTitle(obj);
  return title === sessionId || title === `telepty :: ${sessionId}`;
}

function findWorkspace(tree, session, sessionId) {
  const matches = collectObjects(tree).filter((obj) => workspaceMatches(obj, session, sessionId));
  if (matches.length === 0) return null;
  return matches.find(isWorkspaceCandidate) || matches[0];
}

function isSelectedSurface(obj, selectedRef) {
  if (!obj || typeof obj !== 'object') return false;
  if (selectedRef && stringMatchesRef(getSurfaceRef(obj), selectedRef)) return true;
  if (obj.selected === true || obj.active === true || obj.focused === true || obj.isSelected === true) return true;
  const status = lower(getObjectString(obj, ['status', 'state']));
  if (status.includes('selected') || status.includes('active') || status.includes('focused')) return true;
  const title = getTitle(obj);
  return !!(title && title.includes('[selected]'));
}

function getSelectedSurfaceRef(workspace) {
  if (!workspace || typeof workspace !== 'object') return null;
  const selectedKeys = [
    'selectedSurface', 'selected_surface',
    'selectedSurfaceRef', 'selected_surface_ref',
    'activeSurface', 'active_surface',
    'activeSurfaceRef', 'active_surface_ref',
    'focusedSurface', 'focused_surface',
    'focusedSurfaceRef', 'focused_surface_ref',
    'terminalSurface', 'terminal_surface'
  ];
  for (const key of selectedKeys) {
    const value = workspace[key];
    if (value && typeof value === 'object') return getSurfaceRef(value);
    const stringValue = asString(value);
    if (stringValue) return stringValue;
  }
  return null;
}

function getSelectedSurfaceObject(workspace) {
  if (!workspace || typeof workspace !== 'object') return null;
  const selectedKeys = [
    'selectedSurface', 'selected_surface',
    'activeSurface', 'active_surface',
    'focusedSurface', 'focused_surface',
    'terminalSurface', 'terminal_surface'
  ];
  for (const key of selectedKeys) {
    const value = workspace[key];
    if (value && typeof value === 'object') return value;
  }
  return null;
}

function findSelectedSurface(workspace) {
  if (!workspace || typeof workspace !== 'object') return null;
  const direct = getSelectedSurfaceObject(workspace);
  if (direct) return direct;
  if (isSurfaceCandidate(workspace) && isSelectedSurface(workspace)) return workspace;
  const selectedRef = getSelectedSurfaceRef(workspace);
  const surfaces = collectObjects(workspace).filter(isSurfaceCandidate);
  const selected = surfaces.find((surface) => isSelectedSurface(surface, selectedRef));
  if (selected) return selected;
  if (selectedRef) return { ref: selectedRef };
  return surfaces.length === 1 ? surfaces[0] : null;
}

function findTtyValue(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const tty = findTtyValue(item);
      if (tty) return tty;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase().includes('tty')) {
      const tty = normalizeTty(asString(child));
      if (tty) return tty;
    }
    if (child && typeof child === 'object') {
      const nested = findTtyValue(child);
      if (nested) return nested;
    }
  }
  return null;
}

function formatObservedSurface(surface) {
  const ref = getSurfaceRef(surface);
  const title = getTitle(surface);
  const tty = findTtyValue(surface);
  const parts = [];
  if (ref) parts.push(ref);
  if (title) {
    const compact = title.length > 80 ? `${title.slice(0, 77)}...` : title;
    parts.push(`"${compact}"`);
  }
  if (tty) parts.push(`tty=${tty}`);
  return parts.length > 0 ? parts.join(' ') : null;
}

function readCmuxTree(options = {}) {
  const execFile = options.execFileSync || execFileSync;
  try {
    execFile('cmux', ['ping'], { timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return { ok: false, reason: 'cmux_unreachable' };
  }
  try {
    const raw = execFile('cmux', ['tree', '--json', '--all'], {
      timeout: 5000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
    });
    return { ok: true, tree: JSON.parse(raw) };
  } catch {
    return { ok: false, reason: 'cmux_tree_unavailable' };
  }
}

// cmux currently does not expose a direct "foreground PTY for selected surface" contract.
// Prefer any tty surfaced by metadata, and only fall back to the telepty title/ref marker
// proxy. Unknown observations stay unknown so INV-17 never emits on indeterminate state.
function detectSurfaceMismatch(session, options = {}) {
  const sessionId = options.sessionId || session?.id;
  if (!session || session.type !== 'wrapped' || session.backend !== 'cmux') {
    return { status: 'unknown', reason: 'not_wrapped_cmux' };
  }
  if (!isCmuxRef(session.cmuxWorkspaceId)) {
    return { status: 'unknown', reason: 'missing_workspace' };
  }
  const expectedPtyPid = getExpectedPtyPid(session);
  if (!expectedPtyPid) {
    return { status: 'unknown', reason: 'missing_expected_pty', expectedPtyPid: null };
  }
  if (!isPtyPidAlive(expectedPtyPid, options)) {
    return { status: 'unknown', reason: 'expected_pty_dead', expectedPtyPid };
  }
  const expectedTty = readProcessTty(expectedPtyPid, options);
  if (!expectedTty) {
    return { status: 'unknown', reason: 'expected_tty_unknown', expectedPtyPid };
  }

  const treeResult = readCmuxTree(options);
  if (!treeResult.ok) {
    return { status: 'unknown', reason: treeResult.reason, expectedPtyPid, expectedTty };
  }
  const workspace = findWorkspace(treeResult.tree, session, sessionId);
  if (!workspace) {
    return { status: 'unknown', reason: 'workspace_not_found', expectedPtyPid, expectedTty };
  }
  const surface = findSelectedSurface(workspace);
  if (!surface) {
    return { status: 'unknown', reason: 'selected_surface_not_found', expectedPtyPid, expectedTty };
  }

  const observedSurface = formatObservedSurface(surface);
  if (!observedSurface) {
    return { status: 'unknown', reason: 'observed_surface_unknown', expectedPtyPid, expectedTty };
  }
  const observedSurfaceRef = getSurfaceRef(surface);
  const observedSurfaceTitle = getTitle(surface);
  const observedSurfaceTty = findTtyValue(surface);
  const common = {
    expectedPtyPid,
    expectedTty,
    observedSurface,
    observedSurfaceRef: observedSurfaceRef || null,
    observedSurfaceTitle: observedSurfaceTitle || null,
    observedSurfaceTty: observedSurfaceTty || null
  };

  if (observedSurfaceTty) {
    if (observedSurfaceTty === expectedTty) {
      return { status: 'match', reason: 'tty_match', method: 'tty', ...common };
    }
    return { status: 'mismatch', reason: 'tty_mismatch', method: 'tty', ...common };
  }

  if (session.cmuxSurfaceId && observedSurfaceRef && !stringMatchesRef(observedSurfaceRef, session.cmuxSurfaceId)) {
    return { status: 'mismatch', reason: 'surface_ref_mismatch', method: 'title', ...common };
  }
  if (observedSurfaceTitle && !titleHasSessionMarker(observedSurfaceTitle, sessionId)) {
    return { status: 'mismatch', reason: 'title_marker_missing', method: 'title', ...common };
  }
  if (!observedSurfaceTitle && !observedSurfaceRef) {
    return { status: 'unknown', reason: 'title_fallback_unavailable', ...common };
  }
  return { status: 'match', reason: 'title_marker_match', method: 'title', ...common };
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
  refreshSurfaceCache,
  invalidateCache,
  clearCache,
  isSurfaceAlive,
  detectSurfaceMismatch,
  closeSurface
};
