'use strict';

// Task 1270 — the strict local `telepty clear-strand-v1` verb.
//
//   telepty clear-strand-v1 --from FROM --expected-epoch E --expected-owner-generation G \
//       --stranded-inject-id (UUID|none) --basis BASIS -- EXACT_SID
//
// This verb removes ONE stranded-composer record for ONE exactly-named session instance. It sends no text and
// presses no key: it is the operator's statement "I have dealt with the half-written line in that composer, so
// stop refusing input to that instance". Everything about it is deliberately NARROW, because every failure it
// exists to prevent comes from helpfulness:
//   • no alias/prefix/`-N`-sibling/peer/registered-machine resolution — the SID is used VERBATIM against the
//     exact-own route, so a clear can never land on a session the operator did not name;
//   • no `--all`, no wildcard, no "clear whatever is stranded here": the four identity values are REQUIRED and
//     are compared by the daemon against its own current state;
//   • no remote: fixed 127.0.0.1 plus the daemon port this CLI already selected, and a non-canonical
//     TELEPTY_HOST is refused BEFORE any socket is opened;
//   • no discovery, autostart, repair, retry, redelivery or fallback — exactly one POST, win or lose;
//   • duplicate and unknown flags are refused rather than ignored: an old CLI turns an unrecognised flag into
//     text, and a caller cannot tell that from a bound clear.
//
// Exit 3 means the clear MAY or may not have happened — the operator must re-read the session view rather than
// re-run the command, because a blind re-run cannot tell "already cleared" from "never cleared".

const { boundedToken } = require('../protocol/bound-inject');
// The SAME exact-id predicate the bound verb ships, reused rather than re-derived, so the CLI and the daemon
// bound the id identically.
const { exactSessionId } = require('./inject-bound-v1');
const { REQUEST_SCHEMA, BASES, classifyClearResponse } = require('../protocol/clear-strand');
const { validInjectId } = require('../diagnostics/correlation');

const USAGE = 'Usage: telepty clear-strand-v1 --from FROM --expected-epoch E --expected-owner-generation G'
  + ' --stranded-inject-id (UUID|none) --basis (composer_emptied_by_operator|child_replaced_observed) -- EXACT_SID\n';
// Exit codes. 3 is its own code on purpose: an unknown outcome must be HELD and read back, never retried.
const EXIT = Object.freeze({ cleared: 0, refused: 1, usage: 2, unknown: 3 });
const FLAGS = Object.freeze({
  '--from': 'from',
  '--expected-epoch': 'expected_epoch',
  '--expected-owner-generation': 'expected_owner_generation',
  '--stranded-inject-id': 'stranded_inject_id',
  '--basis': 'basis',
});
// The literal that spells "that strand carried no inject id". It becomes JSON null on the wire; no other
// spelling of null is accepted, so `null`, `""` and `-` are refusals rather than guesses.
const NONE = 'none';
const HOLD_HINT = 're-read the session view; do not re-run this command blindly.\n';

// Pure. → { ok: true, sid, request } or { ok: false, code } with a bounded code. No env, clock or I/O.
function parseClearStrandArgv(argv) {
  if (!Array.isArray(argv)) return { ok: false, code: 'argv_invalid' };
  const separators = argv.reduce((count, token) => count + (token === '--' ? 1 : 0), 0);
  // Exactly one `--`: with none a flag could be read as the target, with two the argv is ambiguous.
  if (separators !== 1) return { ok: false, code: 'separator_required' };
  const at = argv.indexOf('--');
  const flags = argv.slice(0, at);
  const positional = argv.slice(at + 1);
  // Exactly ONE positional: this verb takes one target and no payload. There is nothing to type.
  if (positional.length !== 1) return { ok: false, code: 'positional_count' };
  const [sid] = positional;
  // Space-separated flag/value pairs only. `--flag=value` is NOT silently accepted: one spelling, one parse.
  //
  // r2 erratum (review finding CSR-m5): the flag rules are evaluated BEFORE the exact-sid check, so an argv
  // that is wrong in both ways reports the flag code — the order of §2.1's numbered list (rule 3 and rule 4
  // precede rule 5). Both outcomes are usage + exit 2 with no request built and no socket opened, so only the
  // reported code differs; it now matches the code a reader of the list would pin.
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
  if (!exactSessionId(sid)) return { ok: false, code: 'target_not_exact_sid' };
  const from = seen.get('--from');
  const expectedEpoch = seen.get('--expected-epoch');
  const expectedOwnerGeneration = seen.get('--expected-owner-generation');
  const strandedInjectId = seen.get('--stranded-inject-id');
  const basis = seen.get('--basis');
  // The same bounds the daemon applies, applied here too: a malformed identity never becomes a request.
  if (!boundedToken(from)) return { ok: false, code: 'from_invalid' };
  if (!boundedToken(expectedEpoch)) return { ok: false, code: 'expected_epoch_invalid' };
  if (!boundedToken(expectedOwnerGeneration)) return { ok: false, code: 'expected_owner_generation_invalid' };
  if (strandedInjectId !== NONE && !validInjectId(strandedInjectId)) {
    return { ok: false, code: 'stranded_inject_id_invalid' };
  }
  // Underscores, not hyphens, and exactly one of the two: the argv value and the wire value are one string.
  if (!BASES.includes(basis)) return { ok: false, code: 'basis_invalid' };
  // Built only after every check above passed.
  return {
    ok: true,
    sid,
    request: {
      schema: REQUEST_SCHEMA,
      from,
      expected_epoch: expectedEpoch,
      expected_owner_generation: expectedOwnerGeneration,
      stranded_inject_id: strandedInjectId === NONE ? null : strandedInjectId,
      basis,
    },
  };
}

// The canonical-host gate, decided BEFORE any socket — the same rule the bound verb and the allow-create-v1
// gate apply, spelled with this command's own name and this command's own effect, so the refusal an operator
// reads names what did NOT happen. `host:port`/`http://host:port` forms have already collapsed to a host.
function clearTargetRefusal(remoteHost) {
  if (remoteHost === '127.0.0.1') return null;
  return `clear-strand-v1 refuses non-canonical daemon host ${JSON.stringify(String(remoteHost ?? ''))}; `
    + 'only 127.0.0.1 is supported. No request was sent and no strand was cleared.';
}

// One bounded JSON line, so a caller scrapes instead of parsing prose. `transport` is this CLI's own
// classification of the answer; `result` is the daemon's closed object verbatim when it sent one.
//
// r2 erratum (review finding CSR-m6): ONE shape, always four keys. The locally-decided lines (a usage
// refusal, a non-canonical host, a transport that threw) now carry `http_status: null` rather than omitting
// the key, so a consumer reading `line.http_status` gets `null` — "there was no HTTP answer" — instead of
// `undefined`, which is indistinguishable from "this consumer misread the shape".
function line(payload) { return `${JSON.stringify(payload)}\n`; }

// `deps`: { fetchWithAuth, daemonUrl, remoteHost, timeoutMs, stdout, stderr }. No default daemon URL and no
// default fetch: the caller supplies the one canonical local base and the one existing authenticated fetch.
async function runClearStrandV1(argv, deps) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const parsed = parseClearStrandArgv(argv);
  if (!parsed.ok) {
    stderr.write(USAGE);
    stdout.write(line({ transport: 'refused_locally', reason: parsed.code, http_status: null, result: null }));
    return EXIT.usage;
  }
  // Decided BEFORE the network: a non-loopback TELEPTY_HOST means this operation is not addressed here at all.
  const refusal = clearTargetRefusal(deps.remoteHost);
  if (refusal) {
    stderr.write(`${refusal}\n`);
    stdout.write(line({ transport: 'refused_locally', reason: 'non_canonical_daemon_host', http_status: null, result: null }));
    return EXIT.usage;
  }
  const url = `${deps.daemonUrl}/api/sessions/${encodeURIComponent(parsed.sid)}/clear-strand-v1`;
  let status = null;
  let body = null;
  try {
    // EXACTLY ONE request, with the existing auth carrier and middleware. No retry on any outcome, and no
    // second request of any kind — not even a view read: the operator supplies the pinned values.
    const response = await deps.fetchWithAuth(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
      body: JSON.stringify(parsed.request),
      signal: AbortSignal.timeout(Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : 15000),
    });
    status = response.status;
    try { body = await response.json(); } catch { body = null; }
  } catch {
    // A lost response is NOT evidence that nothing was cleared. Unknown, held, never replayed.
    stderr.write(HOLD_HINT);
    stdout.write(line({ transport: 'outcome_unknown', reason: 'response_unavailable', http_status: null, result: null }));
    return EXIT.unknown;
  }
  const verdict = classifyClearResponse(status, body);
  stdout.write(line({ transport: verdict.outcome, reason: verdict.reason, http_status: status, result: verdict.result }));
  if (verdict.outcome === 'cleared') return EXIT.cleared;
  // `unsupported` is the one 404 that proves nothing happened (this daemon does not know the route); every
  // other unparseable answer stays unknown. Neither is ever retried, and neither is a clear.
  if (verdict.outcome === 'refused' || verdict.outcome === 'unsupported') return EXIT.refused;
  stderr.write(HOLD_HINT);
  return EXIT.unknown;
}

module.exports = { USAGE, EXIT, FLAGS, BASES, NONE, parseClearStrandArgv, clearTargetRefusal, runClearStrandV1 };
