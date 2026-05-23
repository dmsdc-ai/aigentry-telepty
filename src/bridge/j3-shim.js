'use strict';

// J3 shim — 0.3.x daemon-shape requests (inject/output/list) translated to
// NDJSON Frames against the per-session Rust supervisor.
//
// Scope (P2 per dispatch §Goal): inject / output (stream) / list only. Spawn /
// kill / delete remain on daemon.js for the migration window. Reads
// ~/.telepty/sessions/<sid>/manifest.json directly to discover supervisor-
// managed sessions (mirrors the supervisor binary's `--list` mode but avoids
// the subprocess hop for cli.js call sites).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

const { connect } = require('./supervisor-ipc');

const READY_STATUSES = new Set(['ready', 'draining']);

// Resolved lazily so tests (and operators) can redirect via
// TELEPTY_SESSIONS_DIR without re-requiring the module.
function sessionsRoot() {
  return process.env.TELEPTY_SESSIONS_DIR || path.join(os.homedir(), '.telepty', 'sessions');
}

function sessionDir(sid) {
  return path.join(sessionsRoot(), sid);
}

function manifestPath(sid) {
  return path.join(sessionDir(sid), 'manifest.json');
}

function socketPath(sid) {
  return path.join(sessionDir(sid), 'supervisor.sock');
}

function readManifest(sid) {
  try {
    const raw = fs.readFileSync(manifestPath(sid), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.id !== sid) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Locate a usable supervisor manifest for the session. Returns null when no
 * manifest exists, the manifest is malformed, or the status is not in
 * {ready, draining} — the caller should then fall back to the daemon.js path.
 * @param {string} sid
 * @returns {?object}
 */
function findSupervisorManifest(sid) {
  const m = readManifest(sid);
  if (!m) return null;
  if (!m.ipc || typeof m.ipc.path !== 'string' || m.ipc.path.length === 0) return null;
  if (!READY_STATUSES.has(m.status)) return null;
  return m;
}

/**
 * Inject text into a supervisor-managed session via the bridge.
 *
 * Request shape (0.3.x compat): (sessionId, prompt, options) where options
 * carries optional `from`, `reply_to`, `reply_expected`, `idempotency_key`,
 * `trace_id`, `connectTimeoutMs`, `errorWindowMs`.
 *
 * Response shape: `{ success: true, trace_id }` or
 * `{ success: false, code, error, trace_id? }`. Inject is fire-and-forget on
 * the wire (per supervisor.rs dispatch_ingest), so success = no error frame
 * arrived within `errorWindowMs` (default 150ms — catches B3 trace_id /
 * duplicate-op / shutting-down rejections).
 *
 * @param {string} sessionId
 * @param {string} prompt
 * @param {object} [options]
 */
async function inject(sessionId, prompt, options = {}) {
  const manifest = findSupervisorManifest(sessionId);
  if (!manifest) {
    return {
      success: false,
      code: 'ERR_NO_SUPERVISOR',
      error: `no supervisor manifest for session '${sessionId}'`,
    };
  }

  let client;
  try {
    client = await connect(manifest.ipc.path, {
      connectTimeoutMs: options.connectTimeoutMs ?? 1500,
    });
  } catch (err) {
    return {
      success: false,
      code: err.code || 'ERR_NOT_REACHABLE',
      error: err.message,
    };
  }

  const trace_id = options.trace_id || randomUUID();
  const op_id = options.idempotency_key || trace_id;
  const data = String(prompt ?? '');

  const frame = {
    kind: 'inject',
    sid: sessionId,
    trace_id,
    op_id,
    data,
  };

  try {
    await client.send(frame);
  } catch (err) {
    try { await client.close(); } catch {}
    return {
      success: false,
      code: err.code || 'ERR_BAD_FRAME',
      error: err.message,
      trace_id,
    };
  }

  const errorWindowMs = options.errorWindowMs ?? 150;
  const earlyError = await waitForCorrelatedError(client, sessionId, trace_id, errorWindowMs);
  try { await client.close(); } catch {}

  if (earlyError) {
    return {
      success: false,
      code: earlyError.code || 'ERR_BAD_FRAME',
      error: earlyError.data || 'supervisor rejected inject',
      trace_id,
    };
  }
  return { success: true, trace_id };
}

async function waitForCorrelatedError(client, sessionId, trace_id, timeoutMs) {
  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), timeoutMs);
  let found = null;
  try {
    for await (const frame of client.subscribe({ sid: sessionId, signal: ac.signal })) {
      if (frame.kind === 'error' && frame.trace_id === trace_id) {
        found = frame;
        break;
      }
    }
  } finally {
    clearTimeout(tm);
  }
  return found;
}

/**
 * Enumerate supervisor-managed sessions by scanning manifest files. Mirrors
 * the binary's `--list` output but as in-process Node — avoids the subprocess
 * hop for cli.js list path.
 * @returns {Array<object>}
 */
function list() {
  let entries;
  try {
    entries = fs.readdirSync(sessionsRoot(), { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    return [];
  }
  const sessions = [];
  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue;
    const manifest = readManifest(dirent.name);
    if (!manifest) continue;
    // Surface only live sessions — tombstones (status: stopped|error) lack a
    // usable IPC socket and would mislead callers using this for inject
    // routing. Operators still see them via `telepty-supervisor-bin --list`.
    if (!READY_STATUSES.has(manifest.status)) continue;
    sessions.push(toSessionInfo(manifest));
  }
  return sessions;
}

function toSessionInfo(manifest) {
  const info = {
    id: manifest.id,
    host: '127.0.0.1',
    transport: 'supervisor',
    supervisor_pid: manifest.pid,
    status: manifest.status,
    ipc: manifest.ipc,
    createdAt: manifest.created_at,
  };
  if (manifest.exit_reason) info.exit_reason = manifest.exit_reason;
  if (manifest.exit_code != null) info.exit_code = manifest.exit_code;
  if (manifest.exit_signal) info.exit_signal = manifest.exit_signal;
  return info;
}

/**
 * Live PTY output stream for a supervisor-managed session.
 *
 * Returns an async generator yielding `{ data, seq }` per Frame::output (and
 * a final `{ exit, ... }` on shutdown_drain). Consumer cancellation:
 * `for await (...) { ...; break; }` or `signal.abort()` both unwind cleanly.
 *
 * Optional `fromSeq` triggers an A5 Resume frame so the supervisor replays
 * log.jsonl entries with seq > fromSeq before live broadcast — useful when
 * the caller reconnects after a brief disconnect.
 *
 * @param {string} sessionId
 * @param {{fromSeq?: ?number, signal?: AbortSignal|null, connectTimeoutMs?: number}} [options]
 */
async function* output(sessionId, options = {}) {
  const manifest = findSupervisorManifest(sessionId);
  if (!manifest) {
    const err = new Error(`no supervisor manifest for session '${sessionId}'`);
    err.code = 'ERR_NO_SUPERVISOR';
    throw err;
  }
  const { fromSeq = null, signal = null, connectTimeoutMs = 1500 } = options;
  const client = await connect(manifest.ipc.path, { connectTimeoutMs });
  try {
    if (fromSeq != null) {
      await client.send({ kind: 'resume', sid: sessionId, from_seq: fromSeq });
    }
    for await (const frame of client.subscribe({ sid: sessionId, signal })) {
      if (frame.kind === 'output' && typeof frame.data === 'string') {
        yield { data: frame.data, seq: typeof frame.seq === 'number' ? frame.seq : null };
      } else if (frame.kind === 'shutdown_drain') {
        yield {
          data: '',
          seq: null,
          exit: {
            reason: frame.exit_reason || null,
            code: typeof frame.exit_code === 'number' ? frame.exit_code : null,
            escalated: frame.escalated === true,
          },
        };
        break;
      }
    }
  } finally {
    try { await client.close(); } catch {}
  }
}

module.exports = {
  inject,
  output,
  list,
  findSupervisorManifest,
  readManifest,
  toSessionInfo,
  sessionDir,
  manifestPath,
  socketPath,
  sessionsRoot,
};
