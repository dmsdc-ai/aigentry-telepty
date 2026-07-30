'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function defaultSessionPersistPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.config', 'aigentry-telepty', 'sessions.json');
}

function serializePersistedSessions(sessions) {
  const data = {};
  for (const [id, s] of Object.entries(sessions)) {
    data[id] = {
      id,
      type: s.type,
      command: s.command,
      cwd: s.cwd,
      backend: s.backend || null,
      cmuxWorkspaceId: s.cmuxWorkspaceId || null,
      cmuxSurfaceId: s.cmuxSurfaceId || null,
      termProgram: s.termProgram || null,
      term: s.term || null,
      delivery: s.delivery || null,
      deliveryEndpoint: s.deliveryEndpoint || null,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt || null,
      lastConnectedAt: s.lastConnectedAt || null,
      lastDisconnectedAt: s.lastDisconnectedAt || null,
      lastStateReportAt: s.lastStateReportAt || null,
      stateReport: s.stateReport || null,
      idleTtl: s.idleTtl || null,
      idleTtlMs: s.idleTtlMs == null ? null : s.idleTtlMs,
      ownerPid: s.ownerPid || null,
      ptyPid: s.ptyPid || null,
      // #815: the VERIFIER for the active credential epoch — never the bearer itself. This is
      // what keeps the already-running child's spawn-time bearer verifiable across a daemon
      // restart without reissuing anything (its environment cannot be updated from outside).
      // Omitted entirely for a session with no credential, so those serialize as before.
      ...(s.sessionEpoch && s.credentialVerifier
        ? {
          sessionEpoch: s.sessionEpoch,
          credentialVerifier: s.credentialVerifier,
          credentialGeneration: s.credentialGeneration || 1
        }
        : {}),
      // #730: the OBSERVED bracketed-paste capability (ESC[?2004h/l). Identity-based
      // capability is re-derived from `command` on restore, but an observation about a
      // CLI we have no identity rule for can never be re-learned — codex-style CLIs
      // advertise it once at startup and never again. Emitted ONLY when actually
      // observed, so a session that never saw the mode-set serializes byte-identically
      // to the pre-#730 format.
      ...(s.bracketedPasteCapable === undefined ? {} : { bracketedPasteCapable: s.bracketedPasteCapable })
    };
  }
  return data;
}

// #815: this file now carries credential verifiers, so it is owner-only (0600). The mode is
// passed to writeFileSync for the create case AND chmod'ed explicitly, because writeFileSync's
// mode applies only when it creates the file — an existing 0644 sessions.json written by an
// older daemon would otherwise keep its permissions forever.
const SESSION_FILE_MODE = 0o600;

function savePersistedSessions(sessions, persistPath = defaultSessionPersistPath()) {
  try {
    const data = serializePersistedSessions(sessions);
    fs.mkdirSync(path.dirname(persistPath), { recursive: true });
    fs.writeFileSync(persistPath, JSON.stringify(data, null, 2), { mode: SESSION_FILE_MODE });
    try { fs.chmodSync(persistPath, SESSION_FILE_MODE); } catch {}
  } catch {}
}

function loadPersistedSessions(persistPath = defaultSessionPersistPath()) {
  try {
    if (!fs.existsSync(persistPath)) return {};
    // Tighten on the way in too: a file left world-readable by a pre-#815 daemon must not stay
    // that way until the next write happens to land.
    try { fs.chmodSync(persistPath, SESSION_FILE_MODE); } catch {}
    return JSON.parse(fs.readFileSync(persistPath, 'utf8'));
  } catch { return {}; }
}

function buildRestoredWrappedSession(id, meta, options = {}) {
  if (meta.type !== 'wrapped') return null;

  const cwd = options.cwd || process.cwd();
  const nowIso = options.nowIso || (() => new Date().toISOString());
  return {
    id, type: 'wrapped', ptyProcess: null, ownerWs: null,
    command: meta.command || 'wrapped', cwd: meta.cwd || cwd,
    backend: meta.backend || 'kitty',
    cmuxWorkspaceId: meta.cmuxWorkspaceId || null,
    cmuxSurfaceId: meta.cmuxSurfaceId || null,
    termProgram: meta.termProgram || null,
    term: meta.term || null,
    createdAt: meta.createdAt || nowIso(),
    lastActivityAt: meta.lastActivityAt || nowIso(),
    lastConnectedAt: meta.lastConnectedAt || null,
    lastDisconnectedAt: meta.lastDisconnectedAt || meta.lastActivityAt || nowIso(),
    lastStateReportAt: meta.lastStateReportAt || null,
    stateReport: meta.stateReport || null,
    idleTtl: meta.idleTtl || null,
    idleTtlMs: meta.idleTtlMs == null ? null : meta.idleTtlMs,
    ownerPid: meta.ownerPid || null,
    ptyPid: meta.ptyPid || null,
    // #815: carry the credential epoch + verifier back onto the live record so the restored
    // instance keeps its identity. Both must be present or neither is restored — a half-record
    // would leave a session that looks credentialed but can never verify.
    ...(meta.sessionEpoch && meta.credentialVerifier
      ? {
        sessionEpoch: meta.sessionEpoch,
        credentialVerifier: meta.credentialVerifier,
        credentialGeneration: Number(meta.credentialGeneration) || 1
      }
      : {}),
    // #730: restore an OBSERVED capability. Absent (or a null from a hand-edited file)
    // must stay `undefined` so the session falls back to identity-based capability
    // rather than being pinned to a hard "not capable".
    ...(meta.bracketedPasteCapable === true || meta.bracketedPasteCapable === false
      ? { bracketedPasteCapable: meta.bracketedPasteCapable }
      : {}),
    clients: new Set(), isClosing: false, outputRing: [], ready: true,     };
}

// ---------------------------------------------------------------------------
// #60 Stage A — tracked-injection observation ledger (schema v2, durable)
// ---------------------------------------------------------------------------
//
// `pendingReports` is process memory (daemon.js:384) and this file used to serialize sessions
// only, so a daemon restart erased every trace that a dispatch was ever delivered — the
// orchestrator then polled and got a 404 it read as a task-state signal. The ledger fixes the
// telepty half: it is durable, versioned, and describes TRANSPORT OBSERVATIONS ONLY. It contains
// no outcome field, by construction, so there is nothing in it for a future reader to mistake
// for one.
//
// The write is transactional, unlike savePersistedSessions above: same-directory temp file →
// fsync the file → atomic rename → fsync the directory. A crash therefore leaves either the
// complete old generation or the complete new one, never an empty or half-written file. That
// matters because this write is the thing that has to happen BEFORE bytes reach the target.

const TRACKED_INJECTIONS_SCHEMA_VERSION = 2;
const LEDGER_FILE_MODE = 0o600;
// Bounded history per record: enough to see the sequence, capped so a long-lived session cannot
// grow the file without limit. ponytail: a flat cap, not a retention policy — revisit if anyone
// actually needs the older entries.
const MAX_OBSERVATIONS_PER_RECORD = 50;

function defaultTrackedInjectionsPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.config', 'aigentry-telepty', 'tracked-injections.json');
}

function emptyTrackedInjections() {
  return { schema_version: TRACKED_INJECTIONS_SCHEMA_VERSION, generation: 0, injections: {} };
}

/**
 * Durable atomic write. Returns {ok:true} or {ok:false, reason, error} — NEVER throws, and never
 * silently succeeds. The caller must not deliver task bytes on {ok:false}.
 */
function saveTrackedInjections(ledger, persistPath = defaultTrackedInjectionsPath()) {
  const dir = path.dirname(persistPath);
  const tmp = path.join(dir, `.tracked-injections.${process.pid}.${Date.now()}.tmp`);
  let fd = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const body = JSON.stringify({
      ...ledger,
      schema_version: TRACKED_INJECTIONS_SCHEMA_VERSION,
      generation: (Number(ledger && ledger.generation) || 0) + 1,
    }, null, 2);
    fd = fs.openSync(tmp, 'w', LEDGER_FILE_MODE);
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, persistPath);
    try {
      const dirFd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch { /* directory fsync is unavailable on some filesystems; the rename is still atomic */ }
    return { ok: true };
  } catch (error) {
    if (fd != null) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, reason: 'observation_store_write_failed', error };
  }
}

/**
 * Load the ledger. Corruption is FAIL-CLOSED and named: it returns {ok:false} and preserves the
 * bytes, rather than the `catch { return {} }` shape used for sessions above. An empty ledger and
 * a corrupt one must not look alike — one means "nothing tracked", the other means "do not trust
 * what you are about to read".
 */
function loadTrackedInjections(persistPath = defaultTrackedInjectionsPath()) {
  try {
    if (!fs.existsSync(persistPath)) return { ok: true, ledger: emptyTrackedInjections() };
    const parsed = JSON.parse(fs.readFileSync(persistPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'observation_store_unavailable', detail: 'not_an_object' };
    }
    if (Number(parsed.schema_version) !== TRACKED_INJECTIONS_SCHEMA_VERSION) {
      // A pre-v2 or future file is not silently migrated: an inject recorded under a schema this
      // daemon does not understand is explicitly unavailable, never absent.
      return { ok: false, reason: 'observation_store_unavailable', detail: `schema_version=${parsed.schema_version}` };
    }
    if (!parsed.injections || typeof parsed.injections !== 'object' || Array.isArray(parsed.injections)) {
      return { ok: false, reason: 'observation_store_unavailable', detail: 'injections_not_an_object' };
    }
    return { ok: true, ledger: { ...emptyTrackedInjections(), ...parsed } };
  } catch (error) {
    return { ok: false, reason: 'observation_store_unavailable', detail: 'unparseable', error };
  }
}

/** Append an observation to a record in place, bounding the history. Pure-ish: mutates `record`. */
function appendLedgerObservation(record, observation, nowIso) {
  if (!record) return null;
  record.observation_seq = (Number(record.observation_seq) || 0) + 1;
  const entry = { ...observation, seq: record.observation_seq, at: nowIso };
  record.last_observation = entry;
  if (!Array.isArray(record.observations)) record.observations = [];
  record.observations.push(entry);
  while (record.observations.length > MAX_OBSERVATIONS_PER_RECORD) record.observations.shift();
  return entry;
}

module.exports = {
  defaultSessionPersistPath,
  serializePersistedSessions,
  savePersistedSessions,
  loadPersistedSessions,
  buildRestoredWrappedSession,
  // #60 Stage A ledger
  TRACKED_INJECTIONS_SCHEMA_VERSION,
  MAX_OBSERVATIONS_PER_RECORD,
  defaultTrackedInjectionsPath,
  emptyTrackedInjections,
  saveTrackedInjections,
  loadTrackedInjections,
  appendLedgerObservation
};
