'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { storedOwningPrincipal } = require('../principal/http');
const { normalizeAuthorityAudit } = require('../principal/authority-audit');

function defaultSessionPersistPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.config', 'aigentry-telepty', 'sessions.json');
}

function serializePersistedSessions(sessions) {
  const data = {};
  for (const [id, s] of Object.entries(sessions)) {
    // Closing instances reserve their names in memory while process teardown awaits. Once the
    // removal is committed, unrelated saves must never reintroduce their credential verifiers.
    if (s.isClosing) continue;
    Object.defineProperty(data, id, { enumerable: true, writable: true, configurable: true, value: {
      id,
      ...(storedOwningPrincipal(s.owningPrincipal) ? { owningPrincipal: storedOwningPrincipal(s.owningPrincipal) } : {}),
      ...((s.authorityAuditInvalid === true || normalizeAuthorityAudit(s.authorityAudit) === null) ? { authorityAuditInvalid: true } : {}),
      ...(normalizeAuthorityAudit(s.authorityAudit)?.length ? { authorityAudit: normalizeAuthorityAudit(s.authorityAudit) } : {}),
      type: s.type,
      ...(s.externalApprovalPolicy ? { externalApprovalPolicy: s.externalApprovalPolicy } : {}),
      ...(s.requireOwnerProof === true ? { requireOwnerProof: true } : {}),
      command: s.command,
      ...(s.sshRemote ? { sshRemote: require('../ssh-session').validateSshMetadata(s.sshRemote) } : {}),
      cwd: s.cwd,
      backend: s.backend || null,
      cmuxWorkspaceId: s.cmuxWorkspaceId || null,
      cmuxSurfaceId: s.cmuxSurfaceId || null,
      termProgram: s.termProgram || null,
      term: s.term || null,
      delivery: s.delivery || null,
      deliveryEndpoint: s.deliveryEndpoint || null,
      ...(s.type === 'mailbox' ? { leaseExpiresAt: s.leaseExpiresAt || null } : {}),
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt || null,
      lastConnectedAt: s.lastConnectedAt || null,
      lastDisconnectedAt: s.lastDisconnectedAt || null,
      lastStateReportAt: s.lastStateReportAt || null,
      stateReport: s.stateReport || null,
      idleTtl: s.idleTtl || null,
      idleTtlMs: s.idleTtlMs == null ? null : s.idleTtlMs,
      ...(s.cooperativeHandoffCapable===true ? {cooperativeHandoffCapable:true} : {}),
      ...(Object.hasOwn(s,'cooperativeHandoff') ? {cooperativeHandoff:s.cooperativeHandoff} : {}),
      ...(s.cooperativeHandoffAudit ? {cooperativeHandoffAudit:s.cooperativeHandoffAudit} : {}),
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
    } });
  }
  return data;
}

// #815: credential verifiers require owner-only files. Each replacement is created private;
// legacy generations are tightened through their checked descriptor when loaded.
const SESSION_FILE_MODE = 0o600;

function unsafeSessionPath() {
  return Object.assign(new Error('Unsafe session storage path'), { code: 'SESSION_STORE_UNSAFE_PATH' });
}

// Reject link/reparse ancestors before mkdir or chmod can follow them. The final directory is
// daemon-private; ancestors may be shared (e.g. /tmp) and must never be chmod'ed here.
function checkSessionDirectory(dir, create) {
  const resolved = path.resolve(dir);
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let st;
    try { st = fs.lstatSync(current); } catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      try { fs.mkdirSync(current, { mode: 0o700 }); } catch (mkdirError) {
        if (mkdirError.code !== 'EEXIST') throw mkdirError;
      }
      st = fs.lstatSync(current);
    }
    if (!st.isDirectory() || st.isSymbolicLink()) throw unsafeSessionPath();
  }
  const st = fs.lstatSync(resolved);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw unsafeSessionPath();
  return resolved;
}

// macOS exposes /tmp and /var through system aliases. Resolve only the environment's
// trusted HOME/temp base, then reject any link beneath that base as usual.
function sessionStoragePath(persistPath) {
  const file = path.resolve(persistPath);
  for (const base of [os.homedir(), os.tmpdir()]) {
    const root = path.resolve(base);
    const relative = path.relative(root, file);
    if (relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) {
      try { return path.join(fs.realpathSync(root), relative); } catch { /* mkdir handles a missing home */ }
    }
  }
  return file;
}

function checkSessionLeaf(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1
        || (typeof process.getuid === 'function' && st.uid !== process.getuid())) throw unsafeSessionPath();
    return st;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// A failure before rename leaves the previous generation untouched. Once rename succeeds,
// committed:true identifies the new visible generation even if directory fsync then fails;
// callers must not roll memory back to a generation the disk no longer contains.
function savePersistedSessions(sessions, persistPath = defaultSessionPersistPath()) {
  let fd = null, dirFd = null, tmp = null, committed = false;
  try {
    const body = JSON.stringify(serializePersistedSessions(sessions), null, 2);
    const file = sessionStoragePath(persistPath);
    const dir = checkSessionDirectory(path.dirname(file), true);
    checkSessionLeaf(file);
    // Do not tighten arbitrary caller-supplied shared directories.
    if (process.platform !== 'win32' && (fs.statSync(dir).mode & 0o077) !== 0
        && dir === path.dirname(sessionStoragePath(defaultSessionPersistPath()))) {
      fs.chmodSync(dir, 0o700);
    }
    // Windows chmod does not express DACL privacy; retain its existing mode request without
    // interpreting synthetic POSIX permission bits as a reason to reject every NTFS directory.
    if (process.platform !== 'win32' && (fs.statSync(dir).mode & 0o077) !== 0) {
      throw Object.assign(new Error('Session storage directory must be owner-private'), { code: 'SESSION_STORE_UNSAFE_PATH' });
    }
    tmp = path.join(dir, `.sessions.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`);
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0), SESSION_FILE_MODE);
    fs.fchmodSync(fd, SESSION_FILE_MODE);
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    // Windows does not support opening/fsync'ing a directory. File fsync + rename still
    // provide complete generations there; native NTFS/DACL crash guarantees need platform QA.
    if (process.platform !== 'win32') dirFd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
    checkSessionDirectory(dir, false);
    checkSessionLeaf(file);
    fs.renameSync(tmp, file); committed = true; tmp = null;
    if (dirFd !== null) fs.fsyncSync(dirFd);
    return { ok: true, committed: true };
  } catch (error) {
    return { ok: false, committed, reason: 'session_store_write_failed', error };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    if (dirFd !== null) { try { fs.closeSync(dirFd); } catch {} }
    if (tmp !== null) { try { fs.unlinkSync(tmp); } catch {} }
  }
}

function loadPersistedSessions(persistPath = defaultSessionPersistPath()) {
  let fd = null;
  try {
    const file = sessionStoragePath(persistPath);
    checkSessionDirectory(path.dirname(file), false);
    const st = checkSessionLeaf(file);
    if (!st) return {};
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== st.dev || opened.ino !== st.ino) throw unsafeSessionPath();
    fs.fchmodSync(fd, SESSION_FILE_MODE);
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch { return {}; }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }
}

function buildRestoredWrappedSession(id, meta, options = {}) {
  if (!['wrapped', 'mailbox'].includes(meta.type)) return null;

  let sshRemote;
  try { sshRemote = require('../ssh-session').validateSshMetadata(meta.sshRemote); }
  catch { return null; }
  const cwd = options.cwd || process.cwd();
  const nowIso = options.nowIso || (() => new Date().toISOString());
  return {
    id, type: meta.type,
    ...(meta.externalApprovalPolicy ? { externalApprovalPolicy: meta.externalApprovalPolicy, requireOwnerProof: true } : {}),
    ...(meta.requireOwnerProof === true ? { requireOwnerProof: true } : {}),
    ptyProcess: null, ownerWs: null,
    ...(storedOwningPrincipal(meta.owningPrincipal) ? { owningPrincipal: storedOwningPrincipal(meta.owningPrincipal) } : {}),
    ...((meta.authorityAuditInvalid === true || normalizeAuthorityAudit(meta.authorityAudit) === null) ? { authorityAuditInvalid: true } : {}),
    ...(normalizeAuthorityAudit(meta.authorityAudit)?.length ? { authorityAudit: normalizeAuthorityAudit(meta.authorityAudit) } : {}),
    ...(meta.type === 'mailbox' ? { leaseExpiresAt: Number.isFinite(meta.leaseExpiresAt) ? meta.leaseExpiresAt : null } : {}),
    command: meta.command || 'wrapped', cwd: meta.cwd || cwd,
    ...(sshRemote ? { sshRemote } : {}),
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
    ...require('../principal/cooperative-handoff').restoreHandoffRecord(meta),
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
// Like the session store, the ledger uses: same-directory temp file →
// fsync the file → atomic rename → fsync the directory. A crash therefore leaves either the
// complete old generation or the complete new one, never an empty or half-written file. That
// matters because this write is the thing that has to happen BEFORE bytes reach the target.

const TRACKED_INJECTIONS_SCHEMA_VERSION = 3;
const LEDGER_FILE_MODE = 0o600;
// Bounded history per record: enough to see the sequence, capped so a long-lived session cannot
// grow the file without limit. ponytail: a flat cap, not a retention policy — revisit if anyone
// actually needs the older entries.
const MAX_OBSERVATIONS_PER_RECORD = 50;

function defaultTrackedInjectionsPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.config', 'aigentry-telepty', 'tracked-injections.json');
}

function emptyTrackedInjections() {
  return { schema_version: TRACKED_INJECTIONS_SCHEMA_VERSION, generation: 0, injections: {},
    interactions: { actions: {}, pending: {} } };
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
    if (![2, TRACKED_INJECTIONS_SCHEMA_VERSION].includes(Number(parsed.schema_version))) {
      // A pre-v2 or future file is not silently migrated: an inject recorded under a schema this
      // daemon does not understand is explicitly unavailable, never absent.
      return { ok: false, reason: 'observation_store_unavailable', detail: `schema_version=${parsed.schema_version}` };
    }
    if (!parsed.injections || typeof parsed.injections !== 'object' || Array.isArray(parsed.injections)) {
      return { ok: false, reason: 'observation_store_unavailable', detail: 'injections_not_an_object' };
    }
    // v2 has no interaction effects to recover. v3 must carry both maps; corruption must
    // not erase deduplication or original task content by silently creating empty maps.
    const interactions = Number(parsed.schema_version) === 2 ? { actions: {}, pending: {} } : parsed.interactions;
    if (!interactions || ['actions', 'pending'].some(k => !interactions[k]
        || typeof interactions[k] !== 'object' || Array.isArray(interactions[k]))) {
      return { ok: false, reason: 'observation_store_unavailable', detail: 'invalid_interactions' };
    }
    for (const [id, record] of Object.entries(interactions.actions)) {
      const interaction = require('../interaction');
      // Validate structure before hashing, but not admission against today's clock: expired
      // historical requests must retain their exact dedup identity after restart.
      if (!record || typeof record !== 'object' || Array.isArray(record)
          || !interaction.validId(id) || record.action_id !== id
          || interaction.validateRequestStructure(record.request) !== null
          || record.request.action_id !== id
          || record.request.interaction_request_id !== record.interaction_request_id
          || record.request.identity.sid !== record.sid
          || record.pending_inject_id !== (Object.prototype.hasOwnProperty.call(record.request, 'pending_inject_id')
            ? record.request.pending_inject_id : null)
          || interaction.digest(record.request) !== record.request_digest
          || !Number.isSafeInteger(record.receipt_seq) || record.receipt_seq < 1
          || record.receipt_seq >= Number.MAX_SAFE_INTEGER
          || !Number.isSafeInteger(record.updated_at) || record.updated_at < 0) {
        return { ok: false, reason: 'observation_store_unavailable', detail: 'invalid_interaction_receipt' };
      }
      const validStage = (
        (record.stage === 'prepared' && record.bytes_written === 0 && record.terminal === false && record.reason === null)
        || (record.stage === 'dispatched' && record.bytes_written === null && record.terminal === false && record.reason === null)
        || (record.stage === 'written' && Number.isSafeInteger(record.bytes_written) && record.bytes_written > 0
          && record.bytes_written <= 8192 && record.terminal === false && record.reason === null)
        || (record.stage === 'refused' && record.bytes_written === 0 && record.terminal === true
          && interaction.REFUSALS.includes(record.reason))
        || (record.stage === 'outcome_unknown' && record.bytes_written === null && record.terminal === true
          && record.reason === 'outcome_unknown')
      );
      if (!validStage) {
        return { ok: false, reason: 'observation_store_unavailable', detail: 'invalid_interaction_receipt' };
      }
      // Never re-dispatch after restart. Prepared has not crossed the transport boundary;
      // dispatched may have reached the PTY. Written remains written, never consumed.
      if (record.stage === 'prepared' || record.stage === 'dispatched') {
        const dispatched = record.stage === 'dispatched';
        Object.assign(record, { stage: dispatched ? 'outcome_unknown' : 'refused',
          reason: dispatched ? 'outcome_unknown' : 'stale_prompt', terminal: true,
          bytes_written: dispatched ? null : 0, receipt_seq: (record.receipt_seq || 0) + 1 });
      }
    }
    for (const [id, pending] of Object.entries(interactions.pending)) {
      const interaction = require('../interaction');
      if (!pending || !interaction.validId(id) || pending.inject_id !== id || pending.state !== 'held'
          || typeof pending.payload !== 'string' || interaction.payloadDigest(pending.payload) !== pending.payload_digest
          || pending.identity?.sid !== pending.sid || pending.binding?.sid !== pending.sid
          || typeof pending.binding?.session_epoch !== 'string') {
        return { ok: false, reason: 'observation_store_unavailable', detail: 'invalid_interaction_pending' };
      }
    }
    for (const record of Object.values(interactions.actions)) {
      if (record.pending_inject_id === null) continue;
      const interaction = require('../interaction');
      const id = record.pending_inject_id;
      const pending = interactions.pending[id];
      // A durable action reference must retain its original content in this same ledger.
      if (!Object.prototype.hasOwnProperty.call(interactions.pending, id)
          || pending.inject_id !== id || pending.sid !== record.sid
          || interaction.digest(pending.identity) !== interaction.digest(record.request.identity)
          || pending.payload_digest !== record.request.payload_digest) {
        return { ok: false, reason: 'observation_store_unavailable', detail: 'invalid_interaction_pending_reference' };
      }
    }
    return { ok: true, ledger: { ...emptyTrackedInjections(), ...parsed,
      schema_version: TRACKED_INJECTIONS_SCHEMA_VERSION, interactions } };
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
