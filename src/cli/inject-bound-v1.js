'use strict';

// Task 1270 — the strict local `telepty inject-bound-v1` verb.
//
//   telepty inject-bound-v1 --from FROM --expected-epoch E --expected-owner-generation G -- EXACT_SID PROMPT
//
// Everything about this verb is deliberately NARROW, because the failures it exists to prevent all come from
// helpfulness in the ordinary inject path:
//   • no alias/prefix/`-N`-sibling/peer/registered-machine resolution — the SID is used VERBATIM against the
//     exact-own route (resolveSessionTarget's discovery and most-recent-sibling fallback are never called);
//   • no remote: fixed 127.0.0.1 plus the daemon port this CLI already selected, and a non-canonical
//     TELEPTY_HOST is refused BEFORE any socket is opened;
//   • no discovery, autostart, repair, retry, redelivery or fallback — exactly one POST, win or lose;
//   • duplicate and unknown flags are refused rather than ignored, because an old CLI silently turns an
//     unrecognised flag into prompt TEXT, and a caller cannot tell that from a bound send.
//
// The transport outcome is reported, never interpreted: `accepted` means the daemon handed both frames to the
// pinned owner bridge. It is NOT a PTY write, native queueing, auto-submit or model receipt.

const { REQUEST_SCHEMA, REQUIRE, TOKEN_MAX_BYTES, boundedToken, classifyBoundResponse } = require('../protocol/bound-inject');

const USAGE = 'Usage: telepty inject-bound-v1 --from FROM --expected-epoch E --expected-owner-generation G -- EXACT_SID PROMPT\n';
// Exit codes. 3 is its own code on purpose: `outcome_unknown` means input MAY have reached the composer, so
// the caller must HOLD that identity. A caller that cannot tell it from a refusal will retry and double-send.
const EXIT = Object.freeze({ accepted: 0, refused: 1, usage: 2, unknown: 3 });
const FLAGS = Object.freeze({ '--from': 'from', '--expected-epoch': 'expected_epoch', '--expected-owner-generation': 'expected_owner_generation' });

// A session id is used verbatim in the path, so it must be an exact own id and nothing that could re-address:
// no `@host` qualifier, no path separator, no whitespace, no control character.
function exactSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= TOKEN_MAX_BYTES
    && !/[@/\\\s\u0000-\u001f\u007f]/.test(value) && value !== '.' && value !== '..';
}

// Pure. → { ok: true, sid, request } or { ok: false, code } with a bounded code. No env, clock or I/O.
function parseBoundInjectArgv(argv) {
  if (!Array.isArray(argv)) return { ok: false, code: 'argv_invalid' };
  const separators = argv.reduce((count, token) => count + (token === '--' ? 1 : 0), 0);
  // Exactly one `--`: with none the prompt could absorb a flag, with two the payload is ambiguous.
  if (separators !== 1) return { ok: false, code: 'separator_required' };
  const at = argv.indexOf('--');
  const flags = argv.slice(0, at);
  const positional = argv.slice(at + 1);
  if (positional.length !== 2) return { ok: false, code: 'positional_count' };
  const [sid, prompt] = positional;
  if (!exactSessionId(sid)) return { ok: false, code: 'target_not_exact_sid' };
  if (typeof prompt !== 'string') return { ok: false, code: 'prompt_invalid' };
  // Space-separated flag/value pairs only. `--flag=value` is NOT silently accepted: one spelling, one parse.
  if (flags.length !== Object.keys(FLAGS).length * 2) return { ok: false, code: 'flag_count' };
  const seen = new Map();
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    const value = flags[index + 1];
    if (!Object.hasOwn(FLAGS, flag)) return { ok: false, code: 'unknown_flag' };
    if (seen.has(flag)) return { ok: false, code: 'duplicate_flag' };
    if (typeof value !== 'string' || value.startsWith('--')) return { ok: false, code: 'flag_value_missing' };
    seen.set(flag, value);
  }
  const request = { schema: REQUEST_SCHEMA, prompt, from: seen.get('--from'),
    expected_epoch: seen.get('--expected-epoch'), expected_owner_generation: seen.get('--expected-owner-generation'),
    require: [...REQUIRE] };
  // The same bounds the daemon applies, applied here too: a malformed identity never becomes a request.
  if (!boundedToken(request.from)) return { ok: false, code: 'from_invalid' };
  if (!boundedToken(request.expected_epoch)) return { ok: false, code: 'expected_epoch_invalid' };
  if (!boundedToken(request.expected_owner_generation)) return { ok: false, code: 'expected_owner_generation_invalid' };
  return { ok: true, sid, request };
}

// Task 1270: the canonical-host gate, decided BEFORE any socket — the same rule the existing allow-create-v1
// gate applies (only 127.0.0.1), spelled with this verb's own name so the refusal an operator reads names the
// command they ran. `host:port`/`http://host:port` forms have already collapsed to a host by parseHostSpec.
function boundTargetRefusal(remoteHost) {
  if (remoteHost === '127.0.0.1') return null;
  return `inject-bound-v1 refuses non-canonical daemon host ${JSON.stringify(String(remoteHost ?? ''))}; only 127.0.0.1 is supported. No request was sent and no input was delivered.`;
}

// One bounded JSON line, so a caller scrapes instead of parsing prose. `transport` is this CLI's own
// classification of the answer; `result` is the daemon's closed object verbatim when it sent one.
function line(payload) { return `${JSON.stringify(payload)}\n`; }

// `deps`: { fetchWithAuth, daemonUrl, remoteHost, timeoutMs, stdout, stderr }. No default daemon URL and no
// default fetch: the caller supplies the one canonical local base and the one existing authenticated fetch.
async function runInjectBoundV1(argv, deps) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const parsed = parseBoundInjectArgv(argv);
  if (!parsed.ok) {
    stderr.write(USAGE);
    stdout.write(line({ transport: 'refused_locally', reason: parsed.code, result: null }));
    return EXIT.usage;
  }
  // Decided BEFORE the network: a non-loopback TELEPTY_HOST means this operation is not addressed here at all.
  const refusal = boundTargetRefusal(deps.remoteHost);
  if (refusal) {
    stderr.write(`${refusal}\n`);
    stdout.write(line({ transport: 'refused_locally', reason: 'non_canonical_daemon_host', result: null }));
    return EXIT.usage;
  }
  const url = `${deps.daemonUrl}/api/sessions/${encodeURIComponent(parsed.sid)}/inject-bound-v1`;
  let status = null;
  let body = null;
  try {
    // EXACTLY ONE request, with the existing auth carrier and middleware. No retry on any outcome: a second
    // attempt could double-deliver a body whose first attempt's outcome is unknown.
    const response = await deps.fetchWithAuth(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
      body: JSON.stringify(parsed.request),
      signal: AbortSignal.timeout(Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : 15000),
    });
    status = response.status;
    try { body = await response.json(); } catch { body = null; }
  } catch {
    // A lost response is NOT evidence that nothing was written. Unknown, held, never replayed.
    stdout.write(line({ transport: 'outcome_unknown', reason: 'response_unavailable', result: null }));
    return EXIT.unknown;
  }
  const verdict = classifyBoundResponse(status, body);
  stdout.write(line({ transport: verdict.outcome, reason: verdict.reason, http_status: status, result: verdict.result }));
  if (verdict.outcome === 'accepted') return EXIT.accepted;
  // `unsupported` is the one 404 that proves nothing was sent (this daemon does not know the route); every
  // other unparseable answer stays unknown. Neither is ever retried, and neither is a success.
  if (verdict.outcome === 'refused' || verdict.outcome === 'unsupported') return EXIT.refused;
  return EXIT.unknown;
}

module.exports = { USAGE, EXIT, FLAGS, exactSessionId, boundTargetRefusal, parseBoundInjectArgv, runInjectBoundV1 };
