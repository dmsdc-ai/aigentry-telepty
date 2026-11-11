'use strict';
// Issue #144 / Telesession issue16 — `client-profile-scope-v1` (opt-in, default OFF).
//
// Separates assistants that hold DIFFERENT credentials on one OS user: each profile gets its own inbox
// namespace (`<inbox_prefix>-i<32 lowercase hex>`), its own exact target list and its own token, and may use
// only meta / list / register / exact inject / audit / observation / owned delete inside that scope. It
// does NOT stop a same-uid process from reading another profile's token file, the profiles file or a process
// environment (docs/client-profiles.md, BOUNDARY.md).
//
// - Off unless TELEPTY_CLIENT_PROFILES_FILE (non-empty env wins) or the `clientProfilesFile` config key is set.
//   Off ⇒ nothing here is constructed and every response stays byte-identical to 0.10.1.
// - The file is read only through readAuthorityFile (private, same-owner, regular, nlink 1, no symlink walk,
//   64 KiB) and parsed with parseUnambiguousJSON. Only sha256 verifiers are stored — never a token.
// - Every profile request re-reads the file and hashes it; an equal digest reuses the frozen snapshot, a new
//   digest is validated and swapped in one assignment. The linearization point is the gate: a request admitted
//   before a replacement became visible completes; every gate that starts afterwards sees the new set.
// - Messages carry a fixed code and reason only — never the path, file contents, verifiers or tokens.

const crypto = require('node:crypto');
const path = require('node:path');
const { readAuthorityFile } = require('../principal/authority-file');
const { parseUnambiguousJSON } = require('../principal/encoding');
const { isValidSessionId } = require('../session-id');
const { isLoopbackAddress } = require('./http-auth');

const SCHEMA = 'telepty.client-profiles/v1';
const CAPABILITY = 'client-profile-scope-v1';
const ENV_KEY = 'TELEPTY_CLIENT_PROFILES_FILE';
const CONFIG_KEY = 'clientProfilesFile';
const MAX_FILE_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 4096;
const MAX_TARGET_BYTES = 128;
const CLIENT_TOKEN_HEADER = 'x-telepty-client-token';
const SESSION_TOKEN_HEADER = 'x-telepty-session-token';
// Every other credential/authority carrier this daemon reads. A profile request carries none of them.
const FORBIDDEN_CARRIERS = Object.freeze(['authorization', 'x-telepty-token', 'x-telepty-principal', 'x-telepty-owner-token',
  'x-telepty-input-policy-capability', 'x-telepty-bridge-capabilities', 'x-telepty-assertion']);
const FORBIDDEN_QUERY_KEYS = Object.freeze(['token', 'owner_token']);
// Static siblings of `/api/sessions/:id` — a profile target or path segment may never name one (REVIEW569 F1).
const RESERVED_SEGMENTS = new Set(['register', 'spawn', 'submit-all', 'multicast', 'broadcast']);
const PROFILE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PREFIX_RE = /^[A-Za-z0-9._]{1,48}$/;
const VERIFIER_RE = /^sha256:[0-9a-f]{64}$/;
const NOT_BEFORE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const TOKEN_RE = /^tpc1\.[1-9][0-9]{0,15}\.[A-Za-z0-9_-]{43}$/;
// Namespace parse: the prefix alphabet has no '-', so `<prefix>-i<hex>` splits in exactly one way.
const NAMESPACE_ID_RE = /^([A-Za-z0-9._]{1,48})-i([0-9a-f]{32})$/;
const NAMESPACE_ID_LOWER_RE = /^([a-z0-9._]{1,48})-i([0-9a-f]{32})$/;
const ENDPOINT_RE = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/[A-Za-z0-9_-]{43}$/;
const COMMAND_RE = /^[\x20-\x7e]{1,128}$/;
const ENTRY_KEYS = Object.freeze(['profile', 'inbox_prefix', 'targets', 'generation', 'token_verifier', 'not_before']);
const REGISTER_KEYS = new Set(['session_id', 'delivery_type', 'delivery_endpoint', 'command', 'create_only']);
const INJECT_KEYS = new Set(['prompt', 'from', 'reply_to', 'exact_target', 'expected_epoch']);
const AUDIT_KEYS = new Set(['to', 'from', 'since', 'until', 'limit', 'cursor']);

const MESSAGES = Object.freeze({
  CLIENT_PROFILES_UNAVAILABLE: 'the configured client profiles file is unavailable, unsafe or invalid',
  CLIENT_PROFILES_MODE_CONFLICT: 'client profiles cannot be combined with TELEPTY_PRINCIPAL_MODE=strict',
});

function refusal(code, reason) {
  return Object.assign(new Error(`${MESSAGES[code]} (${code}${reason ? `: ${reason}` : ''})`), { code, ...(reason ? { reason } : {}) });
}
function invalid(reason) { throw refusal('CLIENT_PROFILES_UNAVAILABLE', reason); }

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exactKeys(value, keys) {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
function notBeforeMs(value) {
  if (typeof value !== 'string' || !NOT_BEFORE_RE.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  // Calendar-real only (no 2026-02-31): the canonical ISO form must round-trip.
  const canonical = value.length === 20 ? `${value.slice(0, 19)}.000Z` : value;
  return new Date(ms).toISOString() === canonical ? ms : null;
}

// bytes → frozen snapshot. Whole-file fail-closed: any violation rejects every profile. O(total size).
function parseClientProfiles(bytes) {
  let parsed;
  try { parsed = parseUnambiguousJSON(bytes); } catch { invalid('not_unambiguous_json'); }
  if (!plainObject(parsed) || !exactKeys(parsed, ['schema', 'profiles']) || parsed.schema !== SCHEMA) invalid('schema');
  if (!Array.isArray(parsed.profiles)) invalid('profiles');
  const entries = parsed.profiles;
  const names = new Set(), verifiers = new Set(), prefixesLower = new Set();
  // Pass 1: identities and prefixes (targets are checked against EVERY prefix, so they need the full set).
  for (const entry of entries) {
    if (!plainObject(entry) || !exactKeys(entry, ENTRY_KEYS)) invalid('entry_keys');
    if (typeof entry.profile !== 'string' || !PROFILE_RE.test(entry.profile) || names.has(entry.profile)) invalid('profile');
    names.add(entry.profile);
    if (typeof entry.inbox_prefix !== 'string' || !PREFIX_RE.test(entry.inbox_prefix)) invalid('inbox_prefix');
    const lower = entry.inbox_prefix.toLowerCase();
    if (prefixesLower.has(lower)) invalid('inbox_prefix_duplicate');
    prefixesLower.add(lower);
    if (!Number.isSafeInteger(entry.generation) || entry.generation < 1) invalid('generation');
    if (typeof entry.token_verifier !== 'string' || !VERIFIER_RE.test(entry.token_verifier) || verifiers.has(entry.token_verifier)) invalid('token_verifier');
    verifiers.add(entry.token_verifier);
    if (notBeforeMs(entry.not_before) === null) invalid('not_before');
  }
  const byVerifier = new Map(), prefixes = new Set();
  for (const entry of entries) {
    if (!Array.isArray(entry.targets) || entry.targets.length < 1) invalid('targets');
    const targets = new Set();
    for (const target of entry.targets) {
      if (!isValidSessionId(target) || Buffer.byteLength(target) > MAX_TARGET_BYTES || targets.has(target)) invalid('target');
      const lower = target.toLowerCase();
      if (RESERVED_SEGMENTS.has(lower)) invalid('target_reserved');
      const inNamespace = NAMESPACE_ID_LOWER_RE.exec(lower);
      if (inNamespace && prefixesLower.has(inNamespace[1])) invalid('target_in_namespace');
      targets.add(target);
    }
    const ms = notBeforeMs(entry.not_before);
    const profile = Object.freeze({
      profile: entry.profile,
      inbox_prefix: entry.inbox_prefix,
      targets: Object.freeze([...targets]),
      targetSet: targets,
      generation: entry.generation,
      not_before: entry.not_before,
      notBeforeMs: ms,
      verifier: Buffer.from(entry.token_verifier.slice(7), 'hex'),
    });
    byVerifier.set(entry.token_verifier, profile);
    prefixes.add(entry.inbox_prefix);
  }
  return Object.freeze({ byVerifier, prefixes, count: entries.length,
    summary: Object.freeze(entries.map((entry) => Object.freeze({ profile: entry.profile, inbox_prefix: entry.inbox_prefix,
      targets: entry.targets.length, generation: entry.generation, not_before: entry.not_before }))) });
}

function readClientProfilesFile(file, { platform = process.platform, readFile = readAuthorityFile } = {}) {
  let bytes;
  try { bytes = readFile(file, { privateFile: true, maximum: MAX_FILE_BYTES, platform }); }
  catch (error) {
    const reason = error && typeof error.reason === 'string' && /^[a-z_]{1,48}$/.test(error.reason) ? error.reason : 'file_unavailable';
    invalid(reason);
  }
  return { bytes, digest: crypto.createHash('sha256').update(bytes).digest('hex') };
}

// A persistent, re-read-per-request registry. `load()` throws a coded refusal; it never returns a stale set.
function createClientProfileRegistry({ file, platform = process.platform, readFile = readAuthorityFile } = {}) {
  let frozen = null;      // { digest, snapshot } of the last validated read
  let lastGood = null;    // snapshot used ONLY to keep namespaces reserved while the file is unreadable
  function load() {
    const { bytes, digest } = readClientProfilesFile(file, { platform, readFile });
    if (frozen && frozen.digest === digest) return frozen.snapshot;
    const snapshot = parseClientProfiles(bytes);
    frozen = { digest, snapshot };
    lastGood = snapshot;
    return snapshot;
  }
  // Fail closed toward MORE reservation: while the file cannot be read, the last good prefixes stay reserved.
  function reservesSessionId(id) {
    let snapshot;
    try { snapshot = load(); } catch { snapshot = lastGood; }
    const match = typeof id === 'string' ? NAMESPACE_ID_RE.exec(id) : null;
    return !!(match && snapshot && snapshot.prefixes.has(match[1]));
  }
  return Object.freeze({ load, reservesSessionId, capability: CAPABILITY });
}

function invalidPathReason(value) {
  if (typeof value !== 'string') return 'not_a_string';
  if (value === '') return 'empty';
  if (Buffer.byteLength(value) > MAX_PATH_BYTES) return 'too_long';
  if (/[\x00-\x1f\x7f]/.test(value)) return 'control_character';
  if (!path.isAbsolute(value)) return 'not_absolute';
  if (path.normalize(value) !== value) return 'not_normalized';
  return null;
}

// → { file, source: 'env' | 'config' | null }. `config` = an already-read operator config (or null/undefined).
function resolveClientProfilesFile({ env = process.env, config, loadConfig } = {}) {
  const fromEnv = env[ENV_KEY];
  if (typeof fromEnv === 'string' && fromEnv !== '') return { file: fromEnv, source: 'env' };
  const source = config === undefined && loadConfig ? loadConfig() : config;
  if (!plainObject(source) || !Object.prototype.hasOwnProperty.call(source, CONFIG_KEY)) return { file: null, source: null };
  return { file: source[CONFIG_KEY], source: 'config' };
}

// Daemon boot. Unconfigured ⇒ null (feature off). Configured but unusable ⇒ throws a coded refusal so the daemon
// does not start without the enforcement it was told to perform (dispatch F8 decision: refuse start).
// The registry the daemon-boot factory below last returned (null when off or refused). Read-only accessor for
// creation routes the daemon does not hand the registry to explicitly (issue #144 CF2: src/routes/spawn.js).
let activeRegistry = null;
function activeClientProfiles() { return activeRegistry; }

function createClientProfilesFromEnvironment({ env = process.env, config, loadConfig, platform = process.platform, readFile = readAuthorityFile } = {}) {
  activeRegistry = null;
  const { file } = resolveClientProfilesFile({ env, config, loadConfig });
  if (file === null) return null;
  const reason = invalidPathReason(file);
  if (reason) throw refusal('CLIENT_PROFILES_UNAVAILABLE', 'path_invalid');
  if (platform === 'win32') throw refusal('CLIENT_PROFILES_UNAVAILABLE', 'platform_unsupported');
  if (env.TELEPTY_PRINCIPAL_MODE === 'strict') throw refusal('CLIENT_PROFILES_MODE_CONFLICT');
  const registry = createClientProfileRegistry({ file, platform, readFile });
  registry.load();   // throws CLIENT_PROFILES_UNAVAILABLE/<reason> (incl. darwin_native_reader_unavailable)
  activeRegistry = registry;
  return registry;
}

// ── namespace / freshness predicates (shared by the gate and the scoped handlers) ─────────────────────────────

function ownsSessionId(caller, id) {
  const match = typeof id === 'string' ? NAMESPACE_ID_RE.exec(id) : null;
  return !!(match && caller && match[1] === caller.inbox_prefix);
}
function createdAtMs(value) {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
// A namespace record counts only if it was created at or after this grant's not_before (REVIEW569 A2).
function freshSince(caller, createdAt) {
  const ms = createdAtMs(createdAt);
  return ms !== null && ms >= caller.notBeforeMs;
}
function ownSession(sessions, id) {
  if (!sessions || typeof id !== 'string') return null;
  const descriptor = Object.getOwnPropertyDescriptor(sessions, id);
  const value = descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : null;
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function ownsFreshSession(caller, sessions, id) {
  if (!ownsSessionId(caller, id)) return false;
  const session = ownSession(sessions, id);
  return !!(session && freshSince(caller, session.createdAt));
}
// Observation ownership: the record's transport_source is a string in the caller's namespace AND the record was
// created at/after not_before. A missing field is foreign (fail closed; guards the #1273 ledger record shape).
function ownsObservationRecord(caller, record) {
  return !!(record && typeof record === 'object' && typeof record.transport_source === 'string'
    && ownsSessionId(caller, record.transport_source) && freshSince(caller, record.created_at));
}
// `[{id}]` — permitted targets that exist, plus own fresh namespace sessions. No other field ever leaves.
function listForCaller(caller, sessions) {
  const out = [];
  for (const id of Object.keys(sessions || {})) {
    if (caller.targetSet.has(id) || ownsFreshSession(caller, sessions, id)) out.push({ id });
  }
  return out;
}
// `since := max(since, not_before)`, with the same time coercion the audit filter applies (inject-log toMs).
function clampSince(since, caller, toMs) {
  const ms = since === undefined ? null : toMs(since);
  return ms === null || ms < caller.notBeforeMs ? new Date(caller.notBeforeMs).toISOString() : since;
}
function callerView(caller) {
  return caller
    ? { kind: 'client-profile', profile: caller.profile, generation: caller.generation, inbox_prefix: caller.inbox_prefix,
      targets: [...caller.targets], enforcement: 'server', shared_token: false }
    : { kind: 'shared-control', enforcement: 'none', shared_token: true };
}

// ── the gate ──────────────────────────────────────────────────────────────────────────────────────────────────

function rawHeaderCount(req, name) {
  const raw = req.rawHeaders || [];
  let count = 0;
  for (let index = 0; index < raw.length; index += 2) if (String(raw[index]).toLowerCase() === name) count++;
  return count;
}
function presentsClientToken(req) {
  return rawHeaderCount(req, CLIENT_TOKEN_HEADER) > 0;
}
function rawQuery(req) {
  const url = String(req.originalUrl || req.url || '');
  const at = url.indexOf('?');
  return new URLSearchParams(at === -1 ? '' : url.slice(at + 1));
}
function decodeSegment(segment) {
  let id;
  try { id = decodeURIComponent(segment); } catch { return null; }
  if (!id || id.includes('/') || RESERVED_SEGMENTS.has(segment.toLowerCase()) || RESERVED_SEGMENTS.has(id.toLowerCase())) return null;
  return id;
}
// Exact, case-sensitive shape of req.path. → { op, id? } or null (default deny).
function classify(method, pathname) {
  if (method === 'GET' && pathname === '/api/meta') return { op: 'meta' };
  if (method === 'GET' && pathname === '/api/sessions') return { op: 'list' };
  if (method === 'POST' && pathname === '/api/sessions/register') return { op: 'register' };
  if (method === 'GET' && pathname === '/api/injects') return { op: 'audit' };
  let match = /^\/api\/sessions\/([^/]+)\/inject$/.exec(pathname);
  if (method === 'POST' && match) return { op: 'inject', segment: match[1] };
  match = /^\/api\/inject-observations\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && match) return { op: 'observe', segment: match[1] };
  match = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
  if (method === 'DELETE' && match) return { op: 'delete', segment: match[1] };
  return null;
}

const deny = (status, code) => ({ ok: false, status, code });
const MESSAGES_HTTP = Object.freeze({
  CREDENTIAL_AMBIGUOUS: 'A client-profile request must carry exactly one credential carrier.',
  PROFILE_REMOTE_DENIED: 'Client-profile credentials are accepted only from a loopback socket.',
  PROFILE_REGISTRY_UNAVAILABLE: 'The client profile registry is unavailable; no profile request is admitted.',
  PROFILE_CREDENTIAL_INVALID: 'Unknown, stale or revoked client-profile credential.',
  PROFILE_ACTION_DENIED: 'This action is outside the client-profile scope.',
  PROFILE_NAMESPACE_DENIED: 'The session is outside this profile\'s namespace.',
  PROFILE_REQUEST_FIELD_DENIED: 'The request carries a field or value outside the client-profile scope.',
  PROFILE_TARGET_DENIED: 'The target is not granted to this profile.',
  PROFILE_SENDER_DENIED: 'The sender is not this profile\'s live, credentialed inbox.',
  PROFILE_READ_DENIED: 'The audit query is outside this profile\'s scope.',
  PROFILE_CREATE_DENIED: 'This grant is not yet in force (not_before is in the future); nothing was created.',
});

// Pure decision for one request (no effects). `sessions()` and `credentials` are the daemon's live maps.
// `now` is injectable for deterministic tests only; the daemon uses the default clock.
function createClientProfileGate({ registry, sessions, credentials, now = Date.now }) {
  if (!registry || typeof registry.load !== 'function' || typeof sessions !== 'function' || !credentials) {
    throw new Error('client profile gate requires registry, sessions() and credentials');
  }
  function authorize(req) {
    const method = req.method;
    const shape = classify(method, req.path);
    // 1. Carrier presence — raw headers, case-insensitive, an empty value counts (REVIEW569 A5).
    const query = rawQuery(req);
    const sessionTokens = rawHeaderCount(req, SESSION_TOKEN_HEADER);
    if (rawHeaderCount(req, CLIENT_TOKEN_HEADER) !== 1
        || sessionTokens > 1 || (sessionTokens === 1 && !(shape && (shape.op === 'inject' || shape.op === 'delete')))
        || FORBIDDEN_CARRIERS.some((name) => rawHeaderCount(req, name) > 0)
        || FORBIDDEN_QUERY_KEYS.some((key) => query.has(key))) return deny(400, 'CREDENTIAL_AMBIGUOUS');
    // 2. The real socket, not req.ip: the tailnet / TELEPTY_HOST listeners share this app.
    if (!isLoopbackAddress(req.socket && req.socket.remoteAddress)) return deny(403, 'PROFILE_REMOTE_DENIED');
    // 3. Registry (re-read per request; digest-equal reuse).
    let snapshot;
    try { snapshot = registry.load(); } catch { return deny(503, 'PROFILE_REGISTRY_UNAVAILABLE'); }
    // 4. Credential: shape first, then the sha256 verifier, compared in constant time.
    const token = req.headers && req.headers[CLIENT_TOKEN_HEADER];
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return deny(401, 'PROFILE_CREDENTIAL_INVALID');
    const digest = crypto.createHash('sha256').update(token).digest();
    const caller = snapshot.byVerifier.get(`sha256:${digest.toString('hex')}`);
    if (!caller || !crypto.timingSafeEqual(caller.verifier, digest)) return deny(401, 'PROFILE_CREDENTIAL_INVALID');
    // 5. Allow table (default deny), every check before any effect.
    if (!shape) return deny(403, 'PROFILE_ACTION_DENIED');
    const queryKeys = [...query.keys()];
    const body = req.body;
    switch (shape.op) {
      case 'meta':
      case 'list':
        if (queryKeys.length) return deny(403, 'PROFILE_ACTION_DENIED');
        return { ok: true, caller };
      case 'register': {
        if (queryKeys.length) return deny(403, 'PROFILE_ACTION_DENIED');
        if (!plainObject(body) || Object.keys(body).some((key) => !REGISTER_KEYS.has(key))) return deny(403, 'PROFILE_REQUEST_FIELD_DENIED');
        if (!ownsSessionId(caller, body.session_id)) return deny(403, 'PROFILE_NAMESPACE_DENIED');
        const endpoint = typeof body.delivery_endpoint === 'string' ? ENDPOINT_RE.exec(body.delivery_endpoint) : null;
        if (body.delivery_type !== 'aterm' || body.create_only !== true || !endpoint || Number(endpoint[1]) > 65535
            || (Object.prototype.hasOwnProperty.call(body, 'command') && (typeof body.command !== 'string' || !COMMAND_RE.test(body.command)))) {
          return deny(403, 'PROFILE_REQUEST_FIELD_DENIED');
        }
        // A grant that is not yet in force cannot create: an inbox created before not_before would be invisible to,
        // and undeletable by, its own profile (every own-namespace check requires createdAt >= not_before).
        if (now() < caller.notBeforeMs) return deny(403, 'PROFILE_CREATE_DENIED');
        return { ok: true, caller };
      }
      case 'inject': {
        if (queryKeys.length) return deny(403, 'PROFILE_ACTION_DENIED');
        const target = decodeSegment(shape.segment);
        if (target === null) return deny(403, 'PROFILE_ACTION_DENIED');
        if (!plainObject(body) || Object.keys(body).some((key) => !INJECT_KEYS.has(key)) || body.exact_target !== true) {
          return deny(403, 'PROFILE_REQUEST_FIELD_DENIED');
        }
        if (!caller.targetSet.has(target)) return deny(403, 'PROFILE_TARGET_DENIED');
        const from = body.from;
        if (!ownsSessionId(caller, from) || body.reply_to !== from || sessionTokens !== 1) return deny(403, 'PROFILE_SENDER_DENIED');
        // The bearer must be the CURRENT credential of the live `from` instance (credentials.verify checks only
        // the credential map — epoch and generation are checked against the record here, as poll-session does).
        const principal = credentials.verify(req.headers[SESSION_TOKEN_HEADER]);
        const sender = ownSession(sessions(), from);
        if (!principal || principal.sid !== from || !sender || sender.isClosing || typeof sender.sessionEpoch !== 'string'
            || principal.epoch !== sender.sessionEpoch || principal.generation !== (Number(sender.credentialGeneration) || 1)
            || !freshSince(caller, sender.createdAt)) return deny(403, 'PROFILE_SENDER_DENIED');
        return { ok: true, caller };
      }
      case 'audit': {
        const q = req.query || {};
        for (const key of Object.keys(q)) {
          if (!AUDIT_KEYS.has(key) || typeof q[key] !== 'string' || q[key] === '') return deny(403, 'PROFILE_READ_DENIED');
        }
        if (queryKeys.some((key) => !AUDIT_KEYS.has(key)) || queryKeys.length !== new Set(queryKeys).size) return deny(403, 'PROFILE_READ_DENIED');
        const permitted = ownsSessionId(caller, q.to)
          || (ownsSessionId(caller, q.from) && (q.to === undefined || caller.targetSet.has(q.to)));
        if (!permitted) return deny(403, 'PROFILE_READ_DENIED');
        // CF1: an own-namespace id that names a LIVE session created before this grant's not_before belongs to a
        // previous holder of the prefix. Its later rows (e.g. a late reply) are not this caller's history, so the
        // query is refused outright rather than only clamped by `since`. Missing createdAt ⇒ refused (fail closed).
        const live = sessions();
        for (const id of [q.to, q.from]) {
          if (ownsSessionId(caller, id) && ownSession(live, id) && !freshSince(caller, ownSession(live, id).createdAt)) {
            return deny(403, 'PROFILE_READ_DENIED');
          }
        }
        return { ok: true, caller };
      }
      case 'observe':
        if (queryKeys.length || decodeSegment(shape.segment) === null) return deny(403, 'PROFILE_ACTION_DENIED');
        return { ok: true, caller };
      case 'delete': {
        if (queryKeys.length !== 1 || query.get('owned') !== 'true' || query.getAll('owned').length !== 1) return deny(403, 'PROFILE_ACTION_DENIED');
        const id = decodeSegment(shape.segment);
        if (id === null) return deny(403, 'PROFILE_ACTION_DENIED');
        if (!ownsFreshSession(caller, sessions(), id)) return deny(403, 'PROFILE_NAMESPACE_DENIED');
        return { ok: true, caller };
      }
      default:
        return deny(403, 'PROFILE_ACTION_DENIED');
    }
  }
  // Express middleware arm. Never falls through to admin / principal / ordinary admission.
  function handle(req, res, next) {
    const result = authorize(req);
    if (!result.ok) {
      return res.status(result.status).json({ error: MESSAGES_HTTP[result.code] || 'Client-profile request refused.', code: result.code });
    }
    req.clientProfile = result.caller;
    return next();
  }
  return Object.freeze({ authorize, handle, presentsClientToken });
}

module.exports = {
  SCHEMA, CAPABILITY, ENV_KEY, CONFIG_KEY, MAX_FILE_BYTES, RESERVED_SEGMENTS, CLIENT_TOKEN_HEADER, FORBIDDEN_CARRIERS,
  TOKEN_RE, VERIFIER_RE, NOT_BEFORE_RE,
  parseClientProfiles, readClientProfilesFile, createClientProfileRegistry, resolveClientProfilesFile, createClientProfilesFromEnvironment,
  activeClientProfiles,
  invalidPathReason, notBeforeMs,
  createClientProfileGate, presentsClientToken, rawHeaderCount,
  ownsSessionId, ownsFreshSession, ownsObservationRecord, listForCaller, clampSince, callerView,
};
