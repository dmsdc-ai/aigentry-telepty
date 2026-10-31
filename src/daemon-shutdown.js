'use strict';

// Task 1215 W3B — production graceful daemon stop (used on Windows, where every signal-based stop is a
// forced termination that never runs the daemon's shutdown() and so never releases the ledger lock).
//
// Daemon side: createGracefulStopHandler serves POST /api/daemon/stop (registered after the existing auth
// middleware). It accepts ONLY a loopback socket peer (forwarded headers are never consulted), no Origin
// header, the existing local administrative token in the `x-telepty-token` HEADER (timing-safe; never a
// query token, JWT, session bearer or principal), a JSON body of at most 256 bytes that is exactly
// {pid, instance_id}, and only when that pid and per-process instance id are THIS daemon's. Every refusal
// happens before any effect. An accepted request answers 202 and then calls the existing idempotent
// shutdown() once; a duplicate answers 202 without a second call.
//
// CLI side: requestGracefulStop identifies the target through the authenticated /api/meta (pid +
// instance_id), confirms that pid is a telepty daemon by command line, sends the bound stop request and
// waits — bounded — for the actual process exit and for the port to stop answering. It then checks that
// no ledger lock still names that pid. It never kills anything: a timeout or refusal is reported as such.
// Task 1215 W3 (F4): an optional `signRequest(binding)` (the existing principal client) adds x-telepty-principal to
// the identity read (`daemon.inspect`) and the stop (`daemon.stop`, operator-only, explicit grant) for strict
// principal mode; the header token, loopback, Origin and exact-instance checks stay exactly as above. A proof
// that cannot be produced is an explicit refusal before anything is sent.

const crypto = require('crypto');

const STOP_PATH = '/api/daemon/stop';
const MAX_BODY_BYTES = 256;
const INSTANCE_ID = /^[A-Za-z0-9_-]{16,64}$/;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const DEFAULT_STOP_DEADLINE_MS = 10000;
const DEFAULT_POLL_MS = 100;

function newInstanceId() {
  return crypto.randomBytes(18).toString('base64url');
}

function refuse(status, code) {
  return { ok: false, status, code };
}

function tokenMatches(supplied, expected) {
  if (typeof expected !== 'string' || !expected || typeof supplied !== 'string') return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Pure decision over the request; no effect.
function authorizeGracefulStop(req, { expectedToken, pid, instanceId }) {
  const headers = (req && req.headers) || {};
  const remote = req && req.socket ? req.socket.remoteAddress : null;
  if (!LOOPBACK.has(remote)) return refuse(403, 'STOP_LOCAL_ONLY');
  if (headers.origin !== undefined) return refuse(403, 'STOP_ORIGIN_REFUSED');
  if (!tokenMatches(headers['x-telepty-token'], expectedToken)) return refuse(401, 'STOP_AUTH_REQUIRED');
  const contentType = typeof headers['content-type'] === 'string' ? headers['content-type'].toLowerCase() : '';
  if (!contentType.startsWith('application/json')) return refuse(415, 'STOP_BODY_INVALID');
  const raw = req.principalRawBody;
  if (!Buffer.isBuffer(raw) || raw.length < 1 || raw.length > MAX_BODY_BYTES) return refuse(413, 'STOP_BODY_INVALID');
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return refuse(400, 'STOP_BODY_INVALID'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse(400, 'STOP_BODY_INVALID');
  const keys = Object.keys(body).sort();
  if (keys.length !== 2 || keys[0] !== 'instance_id' || keys[1] !== 'pid'
      || !Number.isSafeInteger(body.pid) || body.pid <= 0 || typeof body.instance_id !== 'string' || !INSTANCE_ID.test(body.instance_id)) {
    return refuse(400, 'STOP_BODY_INVALID');
  }
  if (body.pid !== pid || body.instance_id !== instanceId) return refuse(409, 'STOP_INSTANCE_MISMATCH');
  return { ok: true };
}

// `shutdown` is the daemon's existing idempotent shutdown(code); `isDaemonMain` gates the effect exactly
// like the signal handlers (a test that requires daemon.js never exits its own process).
function createGracefulStopHandler({ expectedToken, pid, instanceId, isDaemonMain, shutdown, defer = setImmediate }) {
  let requested = false;
  return (req, res) => {
    const decision = authorizeGracefulStop(req, { expectedToken: typeof expectedToken === 'function' ? expectedToken() : expectedToken, pid, instanceId });
    if (!decision.ok) return res.status(decision.status).json({ success: false, code: decision.code });
    if (!isDaemonMain) return res.status(503).json({ success: false, code: 'STOP_UNAVAILABLE' });
    const already = requested;
    requested = true;
    res.status(202).json({ success: true, accepted: true, pid, instance_id: instanceId, already_stopping: already });
    if (!already) defer(() => shutdown(0));
    return undefined;
  };
}

async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}

// CLI side. Every dependency is injected so the decision logic is testable without a daemon.
async function requestGracefulStop({ port, token, fetchImpl, isProcessRunning, confirmCmdline, probeHealth, readLockPid,
  deadlineMs = DEFAULT_STOP_DEADLINE_MS, pollMs = DEFAULT_POLL_MS, now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), signRequest = null }) {
  if (!Number.isInteger(port) || port <= 0) return { status: 'unidentified', reason: 'no_port' };
  if (typeof token !== 'string' || !token) return { status: 'unidentified', reason: 'no_local_token' };
  const base = `http://127.0.0.1:${port}`;
  const proof = async (binding) => (signRequest ? { 'x-telepty-principal': await signRequest(binding) } : {});
  let metaProof;
  try { metaProof = await proof({ method: 'GET', target: '/api/meta', body: undefined, action: 'daemon.inspect' }); }
  catch { return { status: 'unidentified', reason: 'principal_proof_unavailable' }; }
  let meta;
  try {
    meta = await fetchImpl(`${base}/api/meta`, { headers: { 'x-telepty-token': token, ...metaProof }, signal: AbortSignal.timeout(2000) });
  } catch {
    return { status: 'no_answer' };
  }
  if (meta.status === 401 || meta.status === 403) return { status: 'unidentified', reason: 'meta_refused' };
  if (meta.status !== 200) return { status: 'unidentified', reason: 'meta_status' };
  const identity = await readJson(meta);
  const pid = identity && identity.pid;
  const instanceId = identity && identity.instance_id;
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: 'unidentified', reason: 'meta_without_pid' };
  if (typeof instanceId !== 'string' || !INSTANCE_ID.test(instanceId)) return { status: 'unsupported', pid, reason: 'daemon_without_graceful_stop' };
  if (!confirmCmdline(pid)) return { status: 'unidentified', pid, reason: 'pid_not_telepty' };
  const stopBody = { pid, instance_id: instanceId };
  let stopProof;
  try { stopProof = await proof({ method: 'POST', target: STOP_PATH, body: stopBody, action: 'daemon.stop' }); }
  catch { return { status: 'unidentified', pid, reason: 'principal_proof_unavailable' }; }
  let stop;
  try {
    stop = await fetchImpl(`${base}${STOP_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telepty-token': token, ...stopProof },
      body: JSON.stringify(stopBody), signal: AbortSignal.timeout(2000) });
  } catch {
    return { status: 'unknown', pid, reason: 'stop_request_failed' };
  }
  const answer = await readJson(stop);
  if (stop.status !== 202 || !answer || answer.accepted !== true || answer.pid !== pid || answer.instance_id !== instanceId) {
    return { status: 'refused', pid, code: answer && typeof answer.code === 'string' ? answer.code : null, httpStatus: stop.status };
  }
  const deadline = now() + deadlineMs;
  for (;;) {
    const exited = !isProcessRunning(pid);
    const silent = exited ? !(await probeHealth()) : false;
    if (exited && silent) {
      const lockPid = readLockPid();
      return { status: 'stopped', pid, lockRetained: lockPid === pid };
    }
    if (now() >= deadline) return { status: 'timeout', pid, exited };
    await sleep(pollMs);
  }
}

// Maps a graceful-stop result (+ the surgical dry-run targets, consulted only when nothing answered) to
// what `daemon stop` / `daemon restart` may do. Never authorizes a forced kill; restart only when the old
// owned daemon is positively gone with its cleanup done, or when there was no daemon at all.
function decideStopOutcome(result, dryRunTargets = []) {
  if (result.status === 'stopped' && !result.lockRetained) {
    return { ok: true, stopped: [result.pid], startReplacement: true, exitCode: 0, message: `Stopped telepty daemon (pid ${result.pid}).` };
  }
  if (result.status === 'stopped') {
    return { ok: false, stopped: [], startReplacement: false, exitCode: 1,
      message: `telepty daemon pid ${result.pid} exited but its ledger lock is still held (cleanup not confirmed); not forcing anything.` };
  }
  if (result.status === 'no_answer' && dryRunTargets.length === 0) {
    return { ok: true, stopped: [], startReplacement: true, exitCode: 0, message: 'No telepty daemon running.' };
  }
  const who = result.pid ? `pid ${result.pid}` : (dryRunTargets.length ? dryRunTargets.map((t) => `pid ${t.pid}`).join(', ') : 'the daemon');
  return { ok: false, stopped: [], startReplacement: false, exitCode: 1,
    message: `Graceful stop of ${who} was not confirmed (${result.status}${result.code ? `: ${result.code}` : result.reason ? `: ${result.reason}` : ''}); `
      + 'nothing was forced and no replacement was started. Forcing is a separate explicit operator action: '
      + '`telepty cleanup-daemons` stops EVERY telepty daemon on this machine with crash semantics (the ledger lock '
      + 'is left for `telepty ledger unlock --confirm`).' };
}

module.exports = { STOP_PATH, MAX_BODY_BYTES, DEFAULT_STOP_DEADLINE_MS, newInstanceId, authorizeGracefulStop,
  createGracefulStopHandler, requestGracefulStop, decideStopOutcome };
