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
      //
      // #860 F1: `sessionEpochProved` is deliberately NOT in this list and must not be added. It
      // records that a bearer was presented to THIS daemon and verified; a process that read the
      // fact out of a file has verified nothing, and restoring it would let a daemon restart
      // manufacture an authentication nobody performed. A restored session is epoch-carrying and
      // proof-less until its bridge re-claims, which is the honest state and the one it gets.
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
    // #1136 §5/§9 — `outputRing: []` right here is the whole statement: NO VT STATE SURVIVES A
    // DAEMON RESTART. A restored record therefore carries a permanent mark rather than a
    // reconstructed grid, and `src/vt/session-screen.js` floors every generation on a marked
    // record at `partial_since_restore` — it can never reach `complete`, whatever a bridge goes
    // on to assert about offsets afterwards. No VT is constructed here: a restored record that
    // is never reattached should cost nothing, and a frame read against it is honestly
    // `unavailable` until an owner connects.
    vtRestored: true,
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

// ---------------------------------------------------------------------------
// T0 (#1170) — scoped conditional-admission store (schema v1, durable, fail-closed)
// ---------------------------------------------------------------------------
//
// ¶31/¶32: its own strict versioned file in the SAME session-store directory, holding the
// bindings (B), admissions (A), message tombstones and the permanent per-session fences. The
// existing sessions/observation/mailbox formats are untouched — this store is the authority for
// scoped admission and nothing else reads or writes it.
//
// The transaction is the same one the #60 ledger above uses (temp → file fsync → rename →
// directory fsync), and for the same reason: this write is the thing that has to happen BEFORE
// bytes reach the target. It is a separate pair of functions rather than a parameterisation of
// saveTrackedInjections because the two files have different schemas, different versions and
// different failure consequences, and collapsing them would let a schema bump to one silently
// disable the other.
//
// #815's 0600 applies here too and matters more: the store names task/attempt/manifest identities.

const CONDITIONAL_ADMISSIONS_SCHEMA_VERSION = 1;

function defaultConditionalAdmissionsPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.config', 'aigentry-telepty', 'conditional-admissions.json');
}

function emptyConditionalAdmissions() {
  return {
    schema_version: CONDITIONAL_ADMISSIONS_SCHEMA_VERSION,
    generation: 0,
    // ¶33 — written before the first admission is enabled; a marker/store mismatch is fail-closed.
    marker: null,
    bindings: {},
    admissions: {},
    // ¶33 — retained INDEFINITELY in T0. A future retention policy must not reopen replay, which
    // is why the tombstone is a separate map from the admission it outlives.
    tombstones: {},
    // ¶19/¶39 — permanent, per session record. No unfence path exists in T0.
    fenced_sessions: {},
  };
}

/**
 * Durable atomic write. Returns {ok:true} or {ok:false, reason, error} — NEVER throws and never
 * silently succeeds. ¶31 "propagate every error": on {ok:false} the caller must disable scoped
 * admission, not continue with a memory state the disk does not share.
 */
function writeConditionalAdmissions(ledger, persistPath) {
  const dir = path.dirname(persistPath);
  const tmp = path.join(dir, `.conditional-admissions.${process.pid}.${Date.now()}.tmp`);
  let fd = null;
  let createdTmp = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const body = JSON.stringify({
      ...ledger,
      schema_version: CONDITIONAL_ADMISSIONS_SCHEMA_VERSION,
      generation: (Number(ledger && ledger.generation) || 0) + 1,
    }, null, 2);
    fd = fs.openSync(tmp, 'wx', LEDGER_FILE_MODE);
    createdTmp = true;
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, persistPath);
    // ¶31 requires the DIRECTORY fsync, and unlike the #60 ledger above it is NOT swallowed here:
    // without it the rename can be lost by a crash even though the file contents survived, which
    // for this store means an admission the daemon believes it committed and the disk never saw.
    // ¶29 "No OS support claim beyond tested fsync semantics" cuts the other way too — where the
    // platform refuses the call we report it rather than assert durability we did not get.
    const dirFd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    return { ok: true };
  } catch (error) {
    if (fd != null) { try { fs.closeSync(fd); } catch {} }
    if (createdTmp) { try { fs.unlinkSync(tmp); } catch {} }
    return { ok: false, reason: 'conditional_store_write_failed', error };
  }
}

/**
 * Load the store. ¶32: missing-after-initialization, corruption, unsupported schema and
 * unavailable storage are all FAIL-CLOSED and named; nothing is ever reset or migrated.
 *
 * Absence is not evidence of a new installation. Only the explicit authenticated first-init
 * caller may create a new pair; loading and ordinary commits never create either artifact.
 */
function loadConditionalAdmissions(persistPath = defaultConditionalAdmissionsPath()) {
  try {
    const ledgerStat = conditionalArtifactStat(persistPath);
    const markerPath = conditionalInitializationPath(persistPath);
    const markerStat = conditionalArtifactStat(markerPath);
    if (!ledgerStat && !markerStat) {
      return { ok: false, reason: 'conditional_store_not_initialized' };
    }
    if (!ledgerStat || !markerStat || !ledgerStat.isFile() || !markerStat.isFile()) {
      return { ok: false, reason: 'conditional_store_unavailable', detail: 'marker_store_mismatch' };
    }
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    const parsed = JSON.parse(fs.readFileSync(persistPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'conditional_store_unavailable', detail: 'not_an_object' };
    }
    if (parsed.schema_version !== CONDITIONAL_ADMISSIONS_SCHEMA_VERSION) {
      return {
        ok: false,
        reason: 'conditional_store_unavailable',
        detail: `schema_version=${parsed.schema_version}`,
      };
    }
    const keys = ['schema_version', 'generation', 'marker', 'bindings', 'admissions', 'tombstones', 'fenced_sessions'];
    if (Object.keys(parsed).length !== keys.length || keys.some(key => !Object.hasOwn(parsed, key))
      || !Number.isSafeInteger(parsed.generation) || parsed.generation < 1) {
      return { ok: false, reason: 'conditional_store_unavailable', detail: 'invalid_store_shape' };
    }
    for (const section of ['bindings', 'admissions', 'tombstones', 'fenced_sessions']) {
      const value = parsed[section];
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, reason: 'conditional_store_unavailable', detail: `${section}_not_an_object` };
      }
    }
    if (!validConditionalMarker(marker) || !validConditionalMarker(parsed.marker)
      || marker.marker_id !== parsed.marker.marker_id || marker.initialized_at !== parsed.marker.initialized_at) {
      return { ok: false, reason: 'conditional_store_unavailable', detail: 'marker_store_mismatch' };
    }
    return { ok: true, ledger: parsed };
  } catch (error) {
    return { ok: false, reason: 'conditional_store_unavailable', detail: 'unparseable', error };
  }
}

function conditionalInitializationPath(persistPath = defaultConditionalAdmissionsPath()) {
  return `${persistPath}.initialized`;
}

function conditionalArtifactStat(filePath) {
  try { return fs.lstatSync(filePath); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function validConditionalMarker(marker) {
  return marker && typeof marker === 'object' && !Array.isArray(marker)
    && Object.keys(marker).length === 2
    && typeof marker.marker_id === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(marker.marker_id)
    && typeof marker.initialized_at === 'string'
    && Number.isFinite(Date.parse(marker.initialized_at))
    && new Date(marker.initialized_at).toISOString() === marker.initialized_at;
}

function saveConditionalAdmissions(ledger, persistPath = defaultConditionalAdmissionsPath()) {
  const loaded = loadConditionalAdmissions(persistPath);
  if (!loaded.ok) return loaded;
  if (!validConditionalMarker(ledger.marker)
    || ledger.marker.marker_id !== loaded.ledger.marker.marker_id
    || ledger.marker.initialized_at !== loaded.ledger.marker.initialized_at) {
    return { ok: false, reason: 'conditional_store_marker_changed' };
  }
  return writeConditionalAdmissions(ledger, persistPath);
}

// Explicit first creation only. The exclusive marker is also the cross-process claim. Neither
// partial files nor the marker are removed on failure: uncertain initialization needs recovery.
function initializeConditionalAdmissions(ledger, persistPath = defaultConditionalAdmissionsPath()) {
  const dir = path.dirname(persistPath);
  const markerPath = conditionalInitializationPath(persistPath);
  let fd = null;
  try {
    if (!validConditionalMarker(ledger.marker) || ledger.generation !== 0
      || ['bindings', 'admissions', 'tombstones', 'fenced_sessions'].some(key =>
        !ledger[key] || Object.keys(ledger[key]).length !== 0)) {
      return { ok: false, reason: 'conditional_initialization_not_empty' };
    }
    fs.mkdirSync(dir, { recursive: true });
    if (conditionalArtifactStat(persistPath) || conditionalArtifactStat(markerPath)
      || fs.readdirSync(dir).some(name => name.startsWith('.conditional-admissions.'))) {
      return { ok: false, reason: 'conditional_initialization_evidence_exists' };
    }
    fd = fs.openSync(markerPath, 'wx', LEDGER_FILE_MODE);
    fs.writeFileSync(fd, JSON.stringify(ledger.marker));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    const dirFd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    // Reserve the ledger without replacing any file that appeared after the absence check.
    fd = fs.openSync(persistPath, 'wx', LEDGER_FILE_MODE);
    fs.closeSync(fd);
    fd = null;
    return writeConditionalAdmissions(ledger, persistPath);
  } catch (error) {
    if (fd != null) { try { fs.closeSync(fd); } catch {} }
    return { ok: false, reason: 'conditional_initialization_failed', error };
  }
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
  appendLedgerObservation,
  // T0 (#1170) scoped conditional-admission store
  CONDITIONAL_ADMISSIONS_SCHEMA_VERSION,
  defaultConditionalAdmissionsPath,
  emptyConditionalAdmissions,
  conditionalInitializationPath,
  initializeConditionalAdmissions,
  saveConditionalAdmissions,
  loadConditionalAdmissions
};
