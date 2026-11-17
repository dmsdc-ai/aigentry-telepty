'use strict';

// Task 1270 phase A (RED) — the OPERATOR CLEAR for a stranded composer:
//   CLI    telepty clear-strand-v1 --from F --expected-epoch E --expected-owner-generation G \
//                                  --stranded-inject-id (UUID|none) --basis BASIS -- EXACT_SID
//   route  POST /api/sessions/:id/clear-strand-v1   (telepty.clear-strand/v1 -> telepty.clear-strand-result/v1)
//
// The frozen interface is CLEAR-INTERFACE-V1.md (names, argv, both closed schemas, the reason allow-list, the
// status map, the ORDER of checks, the records and the invariants). This file is the RED seal for it: it is
// authored and registered BEFORE any production line exists, so the implementation is measured against an
// independent, already-published expectation instead of being described after the fact.
//
// What the clear is: ONE synchronous in-memory deletion of ONE strand record for ONE exactly-named session
// instance, after a four-part identity pin (epoch + owner generation + the stranded inject id + an operator
// basis) and a loopback/host-token authority gate. What it is NOT, anywhere in this file: it never writes a
// byte, never sends a key, never touches a queue, a timer, a socket or a bridge frame, and it never claims the
// composer was empty — `basis` is a recorded CLAIM (CLEAR-DESIGN §2.1), and no mock can prove it was true.
//
// How the RED is made meaningful (TEST-PLAN "How RED is made meaningful"): every case that needs a surface the
// candidate does not have yet asserts that surface AS THE CONTRACT on its first line, so the failure is an
// ERR_ASSERTION at a named `CHECKPOINT:` — never a MODULE_NOT_FOUND, a TypeError, a missing fixture or a
// harness setup error. `PRECONDITION:` marks an invalid setup (not a product finding), the convention the
// 1270 green file already uses.
//
// Real production seams (no mirrored product logic): the same daemon composition the bound green file builds
// (createDeliveryRuntime + createSessionDeliveryContext + DeliveryEngine + FileMailbox + createSessionActions,
// claim order as websocket.js), cli.js's exported verb, src/protocol/clear-strand.js and src/cli/clear-strand-v1.js
// once they exist, the real src/audit/inject-log.js, src/session-store/persistence.js,
// src/transport/readiness-handshake.js, src/transport/websocket.js's viewer gate, src/routes/session-inspection.js's
// GUI submit arm and src/transport/session-events.js's APPROVED_TYPES.
// Declared fakes: owner-WS frame recorders (one arms a deterministic CR failure from inside its own write), a
// req/res pair in the /api/daemon/stop shape (socket.remoteAddress + principalRawBody + headers), an injected
// fetch recorder for the CLI, a swappable `persistSessions`, and a private ledger/mailbox/audit file under
// os.tmpdir(). No listener, network, daemon/bridge process, provider, native PTY or model.
//
// Deliberately NOT claimed here (TEST-PLAN §6, and no mock can ever prove them): the bridge's own
// `strandedChildren`, that a post-clear body+CR reaches the composer and submits, that (child_seq, pid) really
// tracks child replacement, the operator procedure at the bridge's terminal, and that a cleared session is
// "safe" in any sense beyond "the daemon no longer refuses its input".

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const load = rel => require(path.join(ROOT, rel));

// Modules that exist on the current candidate: required at module scope, as the green file does.
const registry = load('src/prompt-symbol-registry.js');
const { FileMailbox } = load('src/mailbox/index.js');
const runtimeModule = load('src/mailbox/delivery-runtime.js');
const readinessHandshake = load('src/transport/readiness-handshake');
const boundInject = load('src/protocol/bound-inject.js');
const injectBoundCli = load('src/cli/inject-bound-v1.js');
const auditLog = load('src/audit/inject-log.js');
const persistence = load('src/session-store/persistence.js');
const sessionEvents = load('src/transport/session-events.js');
const cooperativeHandoff = load('src/principal/cooperative-handoff.js');
const wsTransport = load('src/transport/websocket.js');
const principalHttp = load('src/principal/http.js');
const cli = load('cli.js');

// Modules phase B adds. Required through a guard so their ABSENCE is asserted as the contract instead of
// aborting the file at load time (the mechanism the TEST-PLAN mandates).
function tryLoad(rel) {
  try { return { ok: true, module: load(rel) }; }
  catch (error) { return { ok: false, error }; }
}
const clearProtocolLoad = tryLoad('src/protocol/clear-strand.js');
const clearCliLoad = tryLoad('src/cli/clear-strand-v1.js');

function clearProtocol(what) {
  assert.equal(clearProtocolLoad.ok, true,
    `CHECKPOINT: ${what} needs the pure module src/protocol/clear-strand.js (CLEAR-INTERFACE §8); require failed with: ${
      clearProtocolLoad.ok ? 'n/a' : String(clearProtocolLoad.error && clearProtocolLoad.error.message).slice(0, 160)}`);
  return clearProtocolLoad.module;
}
function clearProtocolFn(name, what) {
  const module = clearProtocol(what);
  assert.equal(typeof module[name], 'function',
    `CHECKPOINT: src/protocol/clear-strand.js must export ${name}() (CLEAR-INTERFACE §8), for ${what}`);
  return module[name];
}
// readiness-handshake's new export, guarded the same way: a case that needs the observed child asserts its
// existence first, so its absence is an ERR_ASSERTION and never a TypeError on an undefined function.
function observedChildFn(what) {
  assert.equal(typeof readinessHandshake.observedChild, 'function',
    `CHECKPOINT: ${what} needs src/transport/readiness-handshake.js to export observedChild(session) (CLEAR-INTERFACE §8)`);
  return readinessHandshake.observedChild;
}
function clearCliFn(name, what) {
  assert.equal(clearCliLoad.ok, true,
    `CHECKPOINT: ${what} needs src/cli/clear-strand-v1.js (WRITE-SET §1.2); require failed with: ${
      clearCliLoad.ok ? 'n/a' : String(clearCliLoad.error && clearCliLoad.error.message).slice(0, 160)}`);
  // The SHIPPED verb is what a caller runs, so the assertion is on cli.js's re-export, not on the module alone.
  assert.equal(typeof cli[name], 'function',
    `CHECKPOINT: cli.js must re-export ${name} from src/cli/clear-strand-v1.js (WRITE-SET §2.7), for ${what}`);
  return cli[name];
}

// ── the frozen vocabulary of CLEAR-INTERFACE-V1.md, restated here so a drift is a test failure ────────────────
const ROUTE = '/api/sessions/:id/clear-strand-v1';
const ROUTE_KEY = `POST ${ROUTE}`;
const VERB = 'clear-strand-v1';
const REQUEST_SCHEMA = 'telepty.clear-strand/v1';
const RESULT_SCHEMA = 'telepty.clear-strand-result/v1';
const BUS_EVENT = 'composer_strand_cleared';
const VIEW_KEY = 'last_strand_clear';
const AUDIT_KIND = 'operator-clear';
const AUDIT_SOURCE = 'clear-strand-v1';
const BOOT_VERBS = ['allow-create-v1', 'inject-bound-v1', 'clear-strand-v1'];
const REQUEST_KEYS = ['schema', 'from', 'expected_epoch', 'expected_owner_generation', 'stranded_inject_id', 'basis'];
const STAGES = ['refused', 'cleared'];
const BASES = ['composer_emptied_by_operator', 'child_replaced_observed'];
const CHILD_EVIDENCE = ['replaced', 'same_child', 'unobservable'];
// §4 — the one closed 16-key result object, on EVERY answer, sorted.
const RESULT_KEYS = ['basis', 'body_custody', 'bridge_strand', 'child_evidence', 'cleared_inject_id',
  'cleared_strand_at', 'cleared_strand_reason', 'owner_generation', 'pending_bootstrap_ops', 'persist_reason',
  'persisted', 'reason', 'schema', 'session_epoch', 'session_id', 'stage'];
// §8 — the exports of the pure module (the document enumerates these twelve names).
const PROTOCOL_EXPORTS = ['REQUEST_SCHEMA', 'RESULT_SCHEMA', 'REQUEST_KEYS', 'STAGES', 'BASES', 'REASONS',
  'hostTokenMatches', 'authorizeClearStrandTransport', 'validateClearRequest', 'clearResult',
  'classifyClearResponse', 'boundedClearReason'];
// §6 — the COMPLETE reason allow-list, in the document's own order.
const REASON_CODES = [
  'clear_local_only', 'clear_origin_refused', 'clear_content_type', 'clear_body_bytes', 'clear_auth_required',
  'clear_target_invalid',
  'request_not_object', 'request_keys', 'request_schema', 'from_invalid', 'expected_epoch_invalid',
  'expected_owner_generation_invalid', 'stranded_inject_id_invalid', 'basis_invalid',
  'session_not_found', 'session_closing', 'handoff_active', 'transport_not_applicable', 'not_stranded',
  'epoch_mismatch', 'owner_generation_unavailable', 'owner_generation_mismatch', 'owner_disconnected',
  'stranded_inject_id_mismatch', 'basis_contradicted',
  'refused',
  'session_store_write_failed', 'session_store_write_threw', 'not_attempted',
  'route_unsupported', 'response_unparseable', 'response_unavailable', 'non_canonical_daemon_host',
  'argv_invalid', 'separator_required', 'positional_count', 'flag_count', 'unknown_flag', 'duplicate_flag',
  'flag_value_missing', 'target_not_exact_sid'];
// §6 status mapping, as a table a case can assert a row of.
const STATUS_FOR = Object.freeze({
  clear_local_only: 403, clear_origin_refused: 403, clear_content_type: 415, clear_body_bytes: 413,
  clear_auth_required: 401, clear_target_invalid: 400,
  request_not_object: 400, request_keys: 400, request_schema: 400, from_invalid: 400,
  expected_epoch_invalid: 400, expected_owner_generation_invalid: 400, stranded_inject_id_invalid: 400,
  basis_invalid: 400,
  session_not_found: 404,
  session_closing: 409, handoff_active: 409, transport_not_applicable: 409, not_stranded: 409,
  epoch_mismatch: 409, owner_generation_unavailable: 409, owner_generation_mismatch: 409,
  owner_disconnected: 409, stranded_inject_id_mismatch: 409, basis_contradicted: 409, refused: 409,
});
// §7.1 — the audit line shape of the pre-change builder (src/audit/inject-log.js:40-64), in assignment order.
const AUDIT_BASE_KEYS = ['v', 'ts', 'inject_id', 'kind', 'source', 'claimed_from', 'verified_sender_sid',
  'verified_sender_epoch', 'verified_sender_generation', 'spoof_suspected', 'to', 'to_alias', 'origin',
  'origin_host', 'ref_path', 'payload_sha256', 'payload_bytes', 'payload_preview', 'delivery_result'];
const AUDIT_CLEAR_KEYS = ['clear_session_epoch', 'clear_owner_generation', 'clear_basis', 'clear_strand_reason',
  'clear_strand_at', 'clear_child_evidence', 'clear_persisted'];
// §7.2 — the bus event's extra field list.
const BUS_EXTRA_KEYS = ['target_agent', 'stranded_inject_id', 'strand_reason', 'strand_at', 'basis',
  'child_evidence', 'persisted', 'from', 'verified_sender_sid', 'verified_sender_epoch',
  'verified_sender_generation', 'spoof_suspected', 'origin'];
// §7.3 — the transport-view block.
const VIEW_KEYS = ['at', 'basis', 'stranded_inject_id', 'child_evidence', 'by'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = /^[a-z0-9_]{1,64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const HEADER_BOUND = 'input-transport-ready-v1, immediate-submit-v1, busy-input-v1';
const WORKING = 'Working (12s • esc to interrupt)\r\n';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
const builtLine = record => JSON.parse(auditLog.buildAuditLine(record));

// A code-shape assertion must read CODE, not prose: an implementation comment that says "no await here" is not
// an await. Block and line comments are removed first (a `//` preceded by `:` is left alone, so a URL survives).
function sourceWithoutComments(value) {
  return String(value)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map(line => line.replace(/(^|[^:\\])\/\/.*$/, '$1'))
    .join('\n');
}

// Every answer of the route is the ONE closed object of §4 — asserted on refusals, on the clear, and on the
// thrown-exception path alike, because a caller parses one shape and never guesses.
function assertClosedResult(body, sid, { beforeStep4 = false } = {}) {
  assert.equal(!!body && typeof body === 'object' && !Array.isArray(body), true,
    `CHECKPOINT: the answer is the closed result object (got ${JSON.stringify(body)})`);
  assert.deepEqual(Object.keys(body).sort(), RESULT_KEYS,
    `CHECKPOINT: the frozen 16-key result set on every answer ${JSON.stringify(Object.keys(body).sort())}`);
  assert.equal(body.schema, RESULT_SCHEMA, 'CHECKPOINT: the exact result schema string');
  assert.equal(body.session_id, sid, 'CHECKPOINT: the REQUESTED id is echoed verbatim');
  assert.ok(STAGES.includes(body.stage), `CHECKPOINT: stage is one of exactly two values (${body.stage})`);
  assert.equal(body.bridge_strand, 'not_observable_by_daemon',
    'CHECKPOINT: the bridge half is a constant "not observable by this daemon" on every answer');
  assert.ok(body.reason === null || CODE.test(body.reason), `CHECKPOINT: bounded reason ${JSON.stringify(body.reason)}`);
  assert.ok(CHILD_EVIDENCE.includes(body.child_evidence), `CHECKPOINT: child_evidence vocabulary (${body.child_evidence})`);
  assert.ok(body.basis === null || BASES.includes(body.basis), `CHECKPOINT: basis vocabulary (${body.basis})`);
  assert.ok(Number.isSafeInteger(body.pending_bootstrap_ops) && body.pending_bootstrap_ops >= 0,
    `CHECKPOINT: pending_bootstrap_ops is a non-negative integer (${body.pending_bootstrap_ops})`);
  assert.ok(Number.isSafeInteger(body.body_custody) && body.body_custody >= 0,
    `CHECKPOINT: body_custody is a non-negative integer (${body.body_custody})`);
  assert.equal(typeof body.persisted, 'boolean', `CHECKPOINT: persisted is a boolean (${body.persisted})`);
  if (body.stage === 'refused') {
    assert.deepEqual([body.persisted, body.persist_reason], [false, 'not_attempted'],
      `CHECKPOINT: a refusal never attempted a save ${JSON.stringify(body)}`);
    assert.deepEqual([body.cleared_inject_id, body.cleared_strand_reason, body.cleared_strand_at], [null, null, null],
      `CHECKPOINT: nothing was removed, so every cleared_* field is null ${JSON.stringify(body)}`);
  }
  if (beforeStep4) {
    assert.deepEqual({ epoch: body.session_epoch, generation: body.owner_generation, evidence: body.child_evidence,
      basis: body.basis },
    { epoch: null, generation: null, evidence: 'unobservable', basis: null },
    `CHECKPOINT: an answer produced before the credential/target checks passed names no identity at all ${JSON.stringify(body)}`);
  }
}

// ── Part 1: RED-A — the surfaces that must exist ──────────────────────────────────────────────────────────────

test('A1 boot capabilities: the sealed document advertises clear-strand-v1 as a third unique verb, shape unchanged', () => {
  const line = cli.bootCapabilitiesLine();
  const doc = JSON.parse(line);
  assert.deepEqual(doc.verbs, BOOT_VERBS,
    `CHECKPOINT: the verbs array grows by exactly this one string, in this order ${JSON.stringify(doc.verbs)}`);
  assert.deepEqual(Object.keys(doc), ['schema', 'verbs', 'viewer_detach'],
    `CHECKPOINT: the document's key set and order are unchanged ${JSON.stringify(Object.keys(doc))}`);
  assert.equal(doc.schema, 'telepty-boot-capabilities-v1', 'CHECKPOINT: the schema string is untouched');
  assert.equal(doc.viewer_detach, 'nondeleting-v1', 'CHECKPOINT: viewer_detach is untouched');
  assert.equal(new Set(doc.verbs).size, doc.verbs.length, 'CHECKPOINT: no duplicate verb');
  const parsed = cli.parseBootCapabilities(`${line}\n`, 0);
  assert.equal(parsed.supported, true, `CHECKPOINT: the reference validator accepts the three-verb line ${JSON.stringify(parsed)}`);
  assert.deepEqual(parsed.verbs, BOOT_VERBS, 'CHECKPOINT: and reports all three verbs to the Orchestrator writer');
  assert.equal(cli.parseBootCapabilities(`${line}\n`, 1).supported, false,
    'CHECKPOINT: an old CLI answering help with exit 0 is still never support — the exit rule is unchanged');
});

test('A2 argv: the verb accepts exactly one argv shape and builds the closed 6-key request from it', () => {
  const parse = clearCliFn('parseClearStrandArgv', 'the exact argv shape');
  const injectId = crypto.randomUUID();
  const argv = ['--from', 'E-operator', '--expected-epoch', 'EPOCH-1', '--expected-owner-generation', 'GEN-1',
    '--stranded-inject-id', injectId, '--basis', 'composer_emptied_by_operator', '--', 'E-target'];
  const parsed = parse(argv);
  assert.equal(parsed.ok, true, `CHECKPOINT: the exact shape parses ${JSON.stringify(parsed)}`);
  assert.equal(parsed.sid, 'E-target', 'CHECKPOINT: the sid is taken VERBATIM — no alias/sibling/peer resolution');
  assert.deepEqual(parsed.request, { schema: REQUEST_SCHEMA, from: 'E-operator', expected_epoch: 'EPOCH-1',
    expected_owner_generation: 'GEN-1', stranded_inject_id: injectId, basis: 'composer_emptied_by_operator' },
  `CHECKPOINT: exactly the six closed keys of §3 ${JSON.stringify(parsed.request)}`);
  assert.deepEqual(Object.keys(parsed.request).sort(), [...REQUEST_KEYS].sort(),
    'CHECKPOINT: no seventh key and no missing key is ever built');
  // `none` is the ONLY spelling of "that strand had no inject id", and it becomes JSON null on the wire.
  const noneArgv = ['--from', 'E-operator', '--expected-epoch', 'E1', '--expected-owner-generation', 'G1',
    '--stranded-inject-id', 'none', '--basis', 'child_replaced_observed', '--', 'E-target'];
  const none = parse(noneArgv);
  assert.equal(none.ok, true, `CHECKPOINT: the literal none parses ${JSON.stringify(none)}`);
  assert.equal(none.request.stranded_inject_id, null, 'CHECKPOINT: none maps to JSON null, never to the string "none"');
  assert.equal(none.request.basis, 'child_replaced_observed', 'CHECKPOINT: the second basis is the identical wire string');
  // Flag order is not part of the contract; the built request is.
  const reordered = parse(['--basis', 'composer_emptied_by_operator', '--stranded-inject-id', injectId,
    '--expected-owner-generation', 'GEN-1', '--expected-epoch', 'EPOCH-1', '--from', 'E-operator', '--', 'E-target']);
  assert.deepEqual(reordered, parsed, 'CHECKPOINT: flag order is irrelevant and the request is identical');
  // §2.1.5 — the id check is the SHIPPED exactSessionId, not a copy, so the CLI and the daemon bound the same
  // things the same way.
  assert.equal(typeof injectBoundCli.exactSessionId, 'function',
    'PRECONDITION: the shipped exact-sid predicate is exported (src/cli/inject-bound-v1.js:32)');
  const source = sourceWithoutComments(String(clearCliLoad.module.parseClearStrandArgv));
  assert.ok(source.includes('exactSessionId'),
    'CHECKPOINT: the CLI REUSES the exported exactSessionId rather than re-deriving the rule');
});

test('A2 refusals: every other argv shape is refused with a bounded code and builds no request', () => {
  const parse = clearCliFn('parseClearStrandArgv', 'the argv refusal table');
  const base = ['--from', 'E-operator', '--expected-epoch', 'E1', '--expected-owner-generation', 'G1',
    '--stranded-inject-id', 'none', '--basis', 'composer_emptied_by_operator'];
  const variants = {
    separator_required: [[...base, 'E-target'], [...base, '--', 'E-target', '--', 'x']],
    positional_count: [[...base, '--'], [...base, '--', 'E-target', 'extra']],
    flag_count: [['--from', 'E-operator', '--expected-epoch', 'E1', '--', 'E-target'],
      [...base, '--basis-extra', 'x', '--', 'E-target']],
    unknown_flag: [['--force', 'yes', '--expected-epoch', 'E1', '--expected-owner-generation', 'G1',
      '--stranded-inject-id', 'none', '--basis', 'composer_emptied_by_operator', '--', 'E-target'],
    ['--submit-force', 'yes', '--expected-epoch', 'E1', '--expected-owner-generation', 'G1',
      '--stranded-inject-id', 'none', '--basis', 'composer_emptied_by_operator', '--', 'E-target']],
    duplicate_flag: [['--from', 'E-operator', '--from', 'E-other', '--expected-owner-generation', 'G1',
      '--stranded-inject-id', 'none', '--basis', 'composer_emptied_by_operator', '--', 'E-target']],
    flag_value_missing: [['--from', '--basis', '--expected-epoch', 'E1', '--expected-owner-generation', 'G1',
      '--stranded-inject-id', 'none', '--basis', 'composer_emptied_by_operator', '--', 'E-target']],
    target_not_exact_sid: [[...base, '--', 'E-target@10.0.0.4'], [...base, '--', 'api/sessions/E-target'],
      [...base, '--', ''], [...base, '--', '..'], [...base, '--', 'E target']],
    from_invalid: [['--from', '', '--expected-epoch', 'E1', '--expected-owner-generation', 'G1',
      '--stranded-inject-id', 'none', '--basis', 'composer_emptied_by_operator', '--', 'E-target'],
    ['--from', 'E\u0000x', '--expected-epoch', 'E1', '--expected-owner-generation', 'G1',
      '--stranded-inject-id', 'none', '--basis', 'composer_emptied_by_operator', '--', 'E-target']],
    expected_epoch_invalid: [['--from', 'E-operator', '--expected-epoch', 'E\u0001', '--expected-owner-generation', 'G1',
      '--stranded-inject-id', 'none', '--basis', 'composer_emptied_by_operator', '--', 'E-target']],
    expected_owner_generation_invalid: [['--from', 'E-operator', '--expected-epoch', 'E1',
      '--expected-owner-generation', 'G'.repeat(257), '--stranded-inject-id', 'none',
      '--basis', 'composer_emptied_by_operator', '--', 'E-target']],
    stranded_inject_id_invalid: [['--from', 'E-operator', '--expected-epoch', 'E1', '--expected-owner-generation', 'G1',
      '--stranded-inject-id', 'null', '--basis', 'composer_emptied_by_operator', '--', 'E-target'],
    ['--from', 'E-operator', '--expected-epoch', 'E1', '--expected-owner-generation', 'G1',
      '--stranded-inject-id', '-', '--basis', 'composer_emptied_by_operator', '--', 'E-target'],
    ['--from', 'E-operator', '--expected-epoch', 'E1', '--expected-owner-generation', 'G1',
      '--stranded-inject-id', `${crypto.randomUUID()}\n`, '--basis', 'composer_emptied_by_operator', '--', 'E-target']],
    basis_invalid: [['--from', 'E-operator', '--expected-epoch', 'E1', '--expected-owner-generation', 'G1',
      '--stranded-inject-id', 'none', '--basis', 'composer-emptied-by-operator', '--', 'E-target'],
    ['--from', 'E-operator', '--expected-epoch', 'E1', '--expected-owner-generation', 'G1',
      '--stranded-inject-id', 'none', '--basis', 'force', '--', 'E-target'],
    ['--from', 'E-operator', '--expected-epoch', 'E1', '--expected-owner-generation', 'G1',
      '--stranded-inject-id', 'none', '--basis', '', '--', 'E-target']],
  };
  for (const [code, shapes] of Object.entries(variants)) {
    for (const argv of shapes) {
      const parsed = parse(argv);
      assert.equal(parsed.ok, false, `CHECKPOINT: ${code} shape is refused ${JSON.stringify(argv)}`);
      assert.equal(parsed.code, code, `CHECKPOINT: ${JSON.stringify(argv)} is refused as ${code}, not ${parsed.code}`);
      assert.equal(parsed.request, undefined, `CHECKPOINT: a refused argv builds no request object (${code})`);
      assert.ok(REASON_CODES.includes(parsed.code), `CHECKPOINT: ${parsed.code} is in the §6 allow-list`);
    }
  }
  // Refused, with a bounded code that this file deliberately does not pin: `--flag=value` satisfies §2.1.4
  // (unknown_flag) and §2.1.3 (flag_count) at once — one token short of ten — and the shipped bound verb leaves
  // the same overlap unpinned. What matters is that no spelling of a flag is ever silently accepted.
  for (const argv of [['--help'], ['--version'], [], null, 'string',
    ['--from=E-operator', '--expected-epoch', 'E1', '--expected-owner-generation', 'G1',
      '--stranded-inject-id', 'none', '--basis', 'composer_emptied_by_operator', '--', 'E-target'],
    ['--from', 'E-operator', '--expected-epoch=E1', '--expected-owner-generation', 'G1',
      '--stranded-inject-id', 'none', '--basis', 'composer_emptied_by_operator', '--', 'E-target']]) {
    const parsed = parse(argv);
    assert.equal(parsed.ok, false, `CHECKPOINT: ${JSON.stringify(argv)} is refused, never treated as a clear`);
    assert.ok(CODE.test(String(parsed.code)), `CHECKPOINT: bounded refusal code ${JSON.stringify(parsed.code)}`);
    assert.ok(REASON_CODES.includes(parsed.code), `CHECKPOINT: and it is in the §6 allow-list (${parsed.code})`);
  }
});

test('A2 transport: ONE post, the canonical host only, and five outcomes with their own exit codes and no retry', async () => {
  const run = clearCliFn('runClearStrandV1', 'the one-POST transport');
  const refusal = clearCliFn('clearTargetRefusal', 'the pre-socket host gate');
  const sid = 'E-target';
  const injectId = crypto.randomUUID();
  const argv = ['--from', 'E-operator', '--expected-epoch', 'E1', '--expected-owner-generation', 'G1',
    '--stranded-inject-id', injectId, '--basis', 'composer_emptied_by_operator', '--', sid];

  assert.equal(refusal('127.0.0.1'), null, 'CHECKPOINT: the canonical local daemon is the only target');
  assert.equal(refusal('10.0.0.4'),
    'clear-strand-v1 refuses non-canonical daemon host "10.0.0.4"; only 127.0.0.1 is supported. No request was sent and no strand was cleared.',
    'CHECKPOINT: the §2.2 refusal text names this command and states that nothing was sent and nothing cleared');
  for (const host of ['localhost', '::1', '127.0.0.2', 'example.test', '', null, undefined]) {
    assert.match(String(refusal(host)), /No request was sent and no strand was cleared\./,
      `CHECKPOINT: ${JSON.stringify(host)} is refused before any socket`);
  }

  const result = extra => ({ schema: RESULT_SCHEMA, stage: 'cleared', reason: null, session_id: sid,
    session_epoch: 'E1', owner_generation: 'G1', cleared_inject_id: injectId,
    cleared_strand_reason: 'submit_outcome_unknown', cleared_strand_at: '2026-11-17T09:00:00.000Z',
    basis: 'composer_emptied_by_operator', child_evidence: 'same_child',
    bridge_strand: 'not_observable_by_daemon', persisted: true, persist_reason: null,
    pending_bootstrap_ops: 0, body_custody: 0, ...extra });
  const json = (status, body) => () => Promise.resolve({ status, ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body) });
  const invoke = async (responder, { host = '127.0.0.1', args = argv } = {}) => {
    const calls = []; const out = []; const err = [];
    const code = await run(args, {
      remoteHost: host, daemonUrl: 'http://127.0.0.1:3848',
      fetchWithAuth: (url, options) => { calls.push({ url, options }); return responder(); },
      stdout: { write: text => { out.push(String(text)); return true; } },
      stderr: { write: text => { err.push(String(text)); return true; } },
    });
    return { code, calls, lines: out.map(text => JSON.parse(text)), err: err.join('') };
  };

  const cleared = await invoke(json(200, result()));
  assert.deepEqual([cleared.code, cleared.calls.length], [0, 1],
    `CHECKPOINT: a cleared answer exits 0 after EXACTLY one request ${JSON.stringify(cleared.lines)}`);
  assert.equal(cleared.calls[0].url, `http://127.0.0.1:3848/api/sessions/${sid}/${VERB}`,
    'CHECKPOINT: the exact versioned loopback path, the sid unresolved and encoded');
  assert.equal(cleared.calls[0].options.method, 'POST', 'CHECKPOINT: one POST');
  assert.equal(cleared.calls[0].options.redirect, 'error', 'CHECKPOINT: a redirect is never followed');
  assert.match(String(cleared.calls[0].options.headers['Content-Type']), /^application\/json/,
    'CHECKPOINT: the JSON content type the route requires');
  assert.deepEqual(JSON.parse(cleared.calls[0].options.body), { schema: REQUEST_SCHEMA, from: 'E-operator',
    expected_epoch: 'E1', expected_owner_generation: 'G1', stranded_inject_id: injectId,
    basis: 'composer_emptied_by_operator' }, 'CHECKPOINT: the closed request object goes on the wire verbatim');
  assert.deepEqual([cleared.lines.length, cleared.lines[0].transport, cleared.lines[0].reason,
    cleared.lines[0].http_status, cleared.lines[0].result.stage], [1, 'cleared', null, 200, 'cleared'],
  `CHECKPOINT: exactly one JSON line carrying the daemon's closed object ${JSON.stringify(cleared.lines)}`);

  const refused = await invoke(json(409, result({ stage: 'refused', reason: 'not_stranded', persisted: false,
    persist_reason: 'not_attempted', cleared_inject_id: null, cleared_strand_reason: null, cleared_strand_at: null })));
  assert.deepEqual([refused.code, refused.calls.length, refused.lines[0].transport, refused.lines[0].reason],
    [1, 1, 'refused', 'not_stranded'], `CHECKPOINT: a refusal exits 1, once ${JSON.stringify(refused.lines)}`);

  // The ONE 404 that proves nothing happened: an old daemon that does not know this route.
  const old = await invoke(json(404, { error: 'Not found' }));
  assert.deepEqual([old.code, old.calls.length, old.lines[0].transport, old.lines[0].reason],
    [1, 1, 'unsupported', 'route_unsupported'],
    `CHECKPOINT: a schema-less 404 is unsupported — refused, never retried, never read as a clear ${JSON.stringify(old.lines)}`);
  const notFound = await invoke(json(404, result({ stage: 'refused', reason: 'session_not_found', persisted: false,
    persist_reason: 'not_attempted', cleared_inject_id: null, cleared_strand_reason: null, cleared_strand_at: null })));
  assert.deepEqual([notFound.code, notFound.lines[0].transport], [1, 'refused'],
    'CHECKPOINT: a 404 that DOES carry the closed schema is the route\'s own refusal');

  const lost = await invoke(() => Promise.reject(new Error('socket hang up')));
  assert.deepEqual([lost.code, lost.calls.length, lost.lines[0].transport], [3, 1, 'outcome_unknown'],
    `CHECKPOINT: a lost response is unknown with no replay ${JSON.stringify(lost.lines)}`);
  assert.match(lost.err, /re-read the session view; do not re-run this command blindly\./,
    'CHECKPOINT: exit 3 tells the operator to re-read the view instead of re-running');
  const garbage = await invoke(json(200, { ok: true }));
  assert.deepEqual([garbage.code, garbage.lines[0].transport, garbage.lines[0].reason],
    [3, 'outcome_unknown', 'response_unparseable'], 'CHECKPOINT: a non-schema 200 is unknown, never a clear');

  const badArgv = await invoke(json(200, result()), { args: ['--help'] });
  assert.deepEqual([badArgv.code, badArgv.calls.length, badArgv.lines[0].transport], [2, 0, 'refused_locally'],
    `CHECKPOINT: a usage refusal opens no socket and exits 2 ${JSON.stringify(badArgv.lines)}`);
  assert.match(badArgv.err, new RegExp(`Usage: telepty ${VERB} `),
    'CHECKPOINT: usage goes to stderr, and the verb never prints global help on its way there');
  const remote = await invoke(json(200, result()), { host: '10.0.0.4' });
  assert.deepEqual([remote.code, remote.calls.length, remote.lines[0].reason], [2, 0, 'non_canonical_daemon_host'],
    'CHECKPOINT: a non-canonical host opens no socket');
});

test('A3 registrar: the clear route is registered exactly once, at exactly one path, with no alias twin', () => {
  assert.equal(typeof H.actions.registerClearStrandV1Route, 'function',
    'CHECKPOINT: createSessionActions must expose the clear registrar (CLEAR-INTERFACE §8)');
  const made = H.makeClear();
  assert.deepEqual(made.registered, [{ method: 'POST', route: ROUTE }],
    `CHECKPOINT: ONE registration, the exact versioned path, no forwarded/alias/query-parameter twin ${JSON.stringify(made.registered)}`);
  assert.equal(made.error, null, `CHECKPOINT: the registrar accepts { verifyHostToken } ${made.error && made.error.message}`);
  assert.equal(typeof made.handler, 'function', 'CHECKPOINT: and the registered handler is a function');
  assert.equal(made.handler.constructor.name, 'Function',
    'CHECKPOINT: the handler is NOT async — the one effect is synchronous (CLEAR-INTERFACE §8)');
  // A custom routePath is the documented second option, and it still registers exactly one route.
  const custom = H.makeClear({}, { registrar: { verifyHostToken: () => true, routePath: '/api/sessions/:id/clear-strand-v1-alt' } });
  assert.deepEqual(custom.registered, [{ method: 'POST', route: '/api/sessions/:id/clear-strand-v1-alt' }],
    'CHECKPOINT: routePath is honoured and still adds exactly one route');
});

test('A4 construction: a registrar that cannot authenticate throws and registers nothing', () => {
  assert.equal(typeof H.actions.registerClearStrandV1Route, 'function',
    'CHECKPOINT: createSessionActions must expose the clear registrar (CLEAR-INTERFACE §8)');
  for (const options of [{}, { verifyHostToken: 'x' }, { verifyHostToken: null }, undefined]) {
    const made = H.makeClear({}, { registrar: options });
    assert.ok(made.error instanceof Error,
      `CHECKPOINT: ${JSON.stringify(options)} throws at construction — a route that cannot authenticate must not exist`);
    assert.deepEqual(made.registered, [], `CHECKPOINT: and nothing was registered on the app ${JSON.stringify(made.registered)}`);
  }
});

test('A5 pure module: the §8 exports exist and the module is pure (no clock, env, randomness or I/O)', () => {
  const module = clearProtocol('the pure protocol module');
  for (const name of PROTOCOL_EXPORTS) {
    assert.ok(Object.hasOwn(module, name), `CHECKPOINT: src/protocol/clear-strand.js exports ${name} (CLEAR-INTERFACE §8)`);
  }
  assert.equal(module.REQUEST_SCHEMA, REQUEST_SCHEMA, 'CHECKPOINT: the request schema string');
  assert.equal(module.RESULT_SCHEMA, RESULT_SCHEMA, 'CHECKPOINT: the result schema string');
  assert.deepEqual([...module.REQUEST_KEYS], REQUEST_KEYS, 'CHECKPOINT: the six request keys, in the document\'s order');
  assert.deepEqual([...module.STAGES].sort(), [...STAGES].sort(), 'CHECKPOINT: exactly two stages — there is no outcome_unknown');
  assert.deepEqual([...module.BASES], BASES, 'CHECKPOINT: exactly the two bases, underscored');
  // Purity as a source property: the module may require only node:crypto and the correlation helper, and may not
  // read a clock, the environment, randomness or the filesystem (WRITE-SET §1.1; asserting a `fs` spy over the
  // require would depend on monkey-patching a builtin, which is not a property of the product).
  const source = fs.readFileSync(path.join(ROOT, 'src/protocol/clear-strand.js'), 'utf8');
  const requires = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1]);
  for (const target of requires) {
    assert.ok(['crypto', 'node:crypto', '../diagnostics/correlation', '../diagnostics/correlation.js'].includes(target),
      `CHECKPOINT: the pure module requires only node:crypto and the correlation helper (found ${target})`);
  }
  const stripped = sourceWithoutComments(source);
  for (const needle of ['new Date(', 'Date.now(', 'Math.random(', 'process.env', 'readFileSync', 'writeFileSync',
    'require(\'fs\')', 'require("fs")', 'require(\'node:fs\')']) {
    assert.equal(stripped.includes(needle), false,
      `CHECKPOINT: the pure module has no ${needle} — no clock, env, randomness or I/O`);
  }
});

test('A5 reasons: boundedClearReason is an ALLOW-LIST over the complete §6 list, not a normaliser', () => {
  const bounded = clearProtocolFn('boundedClearReason', 'the reason allow-list');
  const module = clearProtocol('the reason allow-list');
  for (const code of REASON_CODES) {
    assert.equal(bounded(code), code, `CHECKPOINT: ${code} is in the allow-list and travels unchanged`);
    assert.ok(CODE.test(code), `PRECONDITION: ${code} matches the frozen code pattern`);
    const set = module.REASONS;
    const has = set instanceof Set ? set.has(code) : Array.isArray(set) ? set.includes(code) : false;
    assert.equal(has, true, `CHECKPOINT: REASONS contains ${code}`);
  }
  assert.equal(bounded(null), null, 'CHECKPOINT: a cleared answer has no reason at all');
  for (const dirty of ['ENOENT: no such file or directory, open /Users/me/secret.txt',
    'Session epoch 3f2ad963 of /home/op/.telepty/config.json', 'composer_stranded_but_invented',
    'CLEAR_LOCAL_ONLY!!', 42, {}, 'prompt text the operator typed']) {
    assert.equal(bounded(dirty), 'refused',
      `CHECKPOINT: ${JSON.stringify(dirty)} degrades to the generic code — no path, payload or exception text can reach this field`);
  }
});

test('A5 result builder: clearResult is the one closed builder, and §4\'s null/constant rules are its own', () => {
  const clearResult = clearProtocolFn('clearResult', 'the closed result builder');
  const refused = clearResult({ stage: 'refused', reason: 'not_stranded', sessionId: 'c1270-builder' });
  assert.deepEqual(Object.keys(refused).sort(), RESULT_KEYS, `CHECKPOINT: one closed key set ${JSON.stringify(refused)}`);
  assert.deepEqual({ schema: refused.schema, stage: refused.stage, reason: refused.reason, id: refused.session_id,
    epoch: refused.session_epoch, generation: refused.owner_generation, evidence: refused.child_evidence,
    bridge: refused.bridge_strand, persisted: refused.persisted, persistReason: refused.persist_reason,
    basis: refused.basis, ops: refused.pending_bootstrap_ops, custody: refused.body_custody },
  { schema: RESULT_SCHEMA, stage: 'refused', reason: 'not_stranded', id: 'c1270-builder', epoch: null,
    generation: null, evidence: 'unobservable', bridge: 'not_observable_by_daemon', persisted: false,
    persistReason: 'not_attempted', basis: null, ops: 0, custody: 0 },
  `CHECKPOINT: a refusal's defaults are the §4 rules ${JSON.stringify(refused)}`);
  const cleared = clearResult({ stage: 'cleared', sessionId: 'c1270-builder', sessionEpoch: 'E1',
    ownerGeneration: 'G1', clearedInjectId: null, clearedStrandReason: 'submit_outcome_unknown',
    clearedStrandAt: '2026-11-17T09:00:00.000Z', basis: 'composer_emptied_by_operator',
    childEvidence: 'same_child', persisted: true, pendingBootstrapOps: 2, bodyCustody: 1 });
  assert.deepEqual(Object.keys(cleared).sort(), RESULT_KEYS, 'CHECKPOINT: the identical key set on a clear');
  assert.deepEqual({ reason: cleared.reason, persisted: cleared.persisted, persistReason: cleared.persist_reason,
    ops: cleared.pending_bootstrap_ops, custody: cleared.body_custody, bridge: cleared.bridge_strand },
  { reason: null, persisted: true, persistReason: null, ops: 2, custody: 1, bridge: 'not_observable_by_daemon' },
  `CHECKPOINT: a clear reports reason null and the queues it did not touch ${JSON.stringify(cleared)}`);
  assert.throws(() => clearResult({ stage: 'outcome_unknown', sessionId: 'c1270-builder' }), /stage/,
    'CHECKPOINT: there is no outcome_unknown stage on this door and it cannot be built');
  assert.equal(clearResult({ stage: 'refused', reason: '/Users/me/secret.txt threw: ENOENT',
    sessionId: 'c1270-builder' }).reason, 'refused',
  'CHECKPOINT: the builder bounds the reason through the allow-list, so raw text cannot travel');
});

test('A5 classify: classifyClearResponse is the mirror of the bound classifier, with the clear\'s schema and stages', () => {
  const classify = clearProtocolFn('classifyClearResponse', 'the CLI response classifier');
  const closed = stage => ({ schema: RESULT_SCHEMA, stage, reason: stage === 'cleared' ? null : 'not_stranded',
    session_id: 's', session_epoch: null, owner_generation: null, cleared_inject_id: null,
    cleared_strand_reason: null, cleared_strand_at: null, basis: null, child_evidence: 'unobservable',
    bridge_strand: 'not_observable_by_daemon', persisted: false, persist_reason: 'not_attempted',
    pending_bootstrap_ops: 0, body_custody: 0 });
  assert.deepEqual(classify(200, closed('cleared')), { outcome: 'cleared', reason: null, result: closed('cleared') },
    'CHECKPOINT: a closed cleared object is classified on the BODY, not the status');
  assert.equal(classify(409, closed('refused')).outcome, 'refused', 'CHECKPOINT: a closed refusal is a refusal');
  assert.equal(classify(500, closed('refused')).outcome, 'refused',
    'CHECKPOINT: the CLI classifies on the body — even a status this route never sends cannot change the verdict');
  assert.deepEqual(classify(404, { error: 'Not found' }), { outcome: 'unsupported', reason: 'route_unsupported', result: null },
    'CHECKPOINT: the schema-less 404 is the ONE proven "nothing happened"');
  assert.equal(classify(404, { schema: 'something.else/v1' }).outcome, 'outcome_unknown',
    'CHECKPOINT: a 404 carrying some other schema is NOT read as unsupported');
  for (const body of [null, undefined, 'text', [], { ok: true }, { schema: RESULT_SCHEMA, stage: 'invented' }]) {
    assert.deepEqual(classify(200, body), { outcome: 'outcome_unknown', reason: 'response_unparseable', result: null },
      `CHECKPOINT: ${JSON.stringify(body)} at 200 is unknown and never retried`);
  }
});

test('A5 host token: hostTokenMatches is timing-safe, equal-length only, and never throws', () => {
  const matches = clearProtocolFn('hostTokenMatches', 'the host-token comparison');
  const expected = crypto.randomBytes(24).toString('base64url');
  assert.equal(matches(expected, expected), true, 'CHECKPOINT: the exact token matches');
  assert.equal(matches(`${expected.slice(0, -1)}X`, expected), false, 'CHECKPOINT: one byte wrong does not match');
  assert.equal(matches(`${expected}x`, expected), false, 'CHECKPOINT: a longer token is refused without throwing');
  assert.equal(matches(expected.slice(0, -1), expected), false, 'CHECKPOINT: a shorter token is refused without throwing');
  for (const supplied of [undefined, null, 42, {}, [], Buffer.from(expected)]) {
    assert.equal(matches(supplied, expected), false, `CHECKPOINT: ${JSON.stringify(supplied)} is not a token`);
  }
  for (const other of ['', null, undefined, 42]) {
    assert.equal(matches(expected, other), false, `CHECKPOINT: an absent/odd EXPECTED token authorises nothing (${JSON.stringify(other)})`);
  }
  // The timing property is a source property of the comparison, asserted as text (the /api/daemon/stop body).
  const source = sourceWithoutComments(String(matches));
  assert.ok(source.includes('timingSafeEqual'),
    'CHECKPOINT: the comparison is crypto.timingSafeEqual, not === or a compare that short-circuits');
  assert.ok(/length/.test(source),
    'CHECKPOINT: with an equal-length guard, so timingSafeEqual can never be called with unequal buffers');
});

test('A6 strand record: strandComposer writes owner_generation and the observed child beside the existing four fields', () => {
  const observedChild = observedChildFn('the strand record');
  const sid = 'c1270-a6-record';
  const session = H.registerSession(sid);
  assert.deepEqual(observedChild(session), { child_seq: 1, pid: 4242 },
    'CHECKPOINT: the accepted process_started milestone of the CURRENT generation is the observed child');
  const injectId = crypto.randomUUID();
  const strand = runtimeModule.strandComposer(session, { epoch: session.sessionEpoch, injectId, reason: 'submit_outcome_unknown' });
  assert.deepEqual(Object.keys(strand).sort(), ['at', 'child', 'epoch', 'inject_id', 'owner_generation', 'reason'],
    `CHECKPOINT: the record gains exactly owner_generation and child ${JSON.stringify(strand)}`);
  assert.deepEqual({ epoch: strand.epoch, inject_id: strand.inject_id, reason: strand.reason, at: ISO.test(String(strand.at)) },
    { epoch: session.sessionEpoch, inject_id: injectId, reason: 'submit_outcome_unknown', at: true },
    `CHECKPOINT: the existing four fields are unchanged ${JSON.stringify(strand)}`);
  assert.equal(strand.owner_generation, session.interactionOwnerGeneration,
    'CHECKPOINT: the record names the owner generation that held the composer');
  assert.deepEqual(strand.child, { child_seq: 1, pid: 4242 },
    `CHECKPOINT: and the child it was typed into ${JSON.stringify(strand.child)}`);
  // No milestone of this generation → child is null, never invented.
  const bare = { id: 'c1270-a6-bare', sessionEpoch: 'epoch-bare' };
  const bareStrand = runtimeModule.strandComposer(bare, { epoch: 'epoch-bare', injectId: null, reason: 'cr_outcome_unknown' });
  assert.deepEqual([bareStrand.owner_generation, bareStrand.child], [null, null],
    `CHECKPOINT: a session with no generation and no accepted milestone records two nulls ${JSON.stringify(bareStrand)}`);
  assert.equal(observedChild(bare), null, 'CHECKPOINT: observedChild invents nothing');
  // Idempotence per epoch is unchanged: a second call returns the existing record untouched.
  assert.deepEqual(runtimeModule.strandComposer(session, { epoch: session.sessionEpoch, injectId: crypto.randomUUID(),
    reason: 'cr_outcome_unknown' }), strand, 'CHECKPOINT: one record per epoch, unchanged by a second call');
});

test('A7 strand round-trip: the two new fields survive serialize/restore, and a malformed half is dropped', () => {
  observedChildFn('the persisted strand record');
  const epoch = crypto.randomUUID();
  const injectId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const record = { id: 'c1270-a7', type: 'wrapped', command: 'claude', cwd: '/tmp/c1270',
    sessionEpoch: epoch, credentialVerifier: 'opaque-verifier', credentialGeneration: 1,
    interactionOwnerGeneration: 'GEN-A7', createdAt: nowIso, lastActivityAt: nowIso, clients: new Set(),
    transportReadiness: { owner_generation: 'GEN-A7', capable: true, nonce: 'n'.repeat(22),
      process_started: { child_seq: 3, pid: 777, exec: 'unverified', observed_at: nowIso },
      input_transport_ready: null, retired_child_seq: 0, cleared_reason: null } };
  runtimeModule.strandComposer(record, { epoch, injectId, reason: 'submit_outcome_unknown' });
  assert.deepEqual(record.strandedComposer.child, { child_seq: 3, pid: 777 },
    'CHECKPOINT: the in-memory record must carry the observed child before a round-trip can preserve it (A6)');

  const meta = persistence.serializePersistedSessions({ [record.id]: record })[record.id];
  assert.deepEqual(meta.strandedComposer, { epoch, inject_id: injectId, reason: 'submit_outcome_unknown',
    at: record.strandedComposer.at, owner_generation: 'GEN-A7', child: { child_seq: 3, pid: 777 } },
  `CHECKPOINT: six bounded fields are written, with the epoch they key on ${JSON.stringify(meta.strandedComposer)}`);
  const restored = persistence.buildRestoredWrappedSession(record.id, meta);
  assert.deepEqual({ owner_generation: restored.strandedComposer.owner_generation, child: restored.strandedComposer.child },
    { owner_generation: 'GEN-A7', child: { child_seq: 3, pid: 777 } },
    `CHECKPOINT: and both survive the restore ${JSON.stringify(restored.strandedComposer)}`);
  assert.ok(runtimeModule.strandedComposer(restored), 'CHECKPOINT: the restored instance is still stranded');

  // sessions.json is a plain file a human can edit: a malformed half is dropped entirely, never partially adopted.
  for (const child of [{ child_seq: 1.5, pid: 2 }, { child_seq: 1 }, { pid: 2 }, { child_seq: 0, pid: 2 },
    { child_seq: 1, pid: -1 }, { child_seq: Number.MAX_SAFE_INTEGER + 2, pid: 2 }, 'child', 7, [], null]) {
    const tampered = { ...meta, strandedComposer: { ...meta.strandedComposer, child } };
    const out = persistence.buildRestoredWrappedSession(record.id, tampered);
    assert.equal(out.strandedComposer.child, null,
      `CHECKPOINT: a malformed child restores as null, the rest intact ${JSON.stringify(child)}`);
    assert.equal(out.strandedComposer.epoch, epoch, 'CHECKPOINT: and the strand itself is still adopted');
  }
  const badGeneration = { ...meta, strandedComposer: { ...meta.strandedComposer, owner_generation: 'G\u0000' } };
  assert.equal(persistence.buildRestoredWrappedSession(record.id, badGeneration).strandedComposer.owner_generation, null,
    'CHECKPOINT: a control character in a stored generation token is dropped, not carried into a log or a view');
});

test('A8 audit line: the operator-clear block adds exactly the seven clear_* keys and carries no payload', () => {
  const ts = '2026-11-17T09:00:00.000Z';
  const strandAt = '2026-11-17T08:59:00.000Z';
  const injectId = crypto.randomUUID();
  const line = builtLine({ ts, inject_id: injectId, kind: AUDIT_KIND, source: AUDIT_SOURCE,
    claimed_from: 'E-operator', verified_sender_sid: null, to: 'c1270-a8', origin: 'trusted-local',
    origin_host: 'c1270-machine', payload: '', delivery_result: 'cleared',
    clear: { session_epoch: 'E-A8', owner_generation: 'G-A8', basis: 'composer_emptied_by_operator',
      strand_reason: 'submit_outcome_unknown', strand_at: strandAt, child_evidence: 'same_child', persisted: true } });
  assert.deepEqual(Object.keys(line), [...AUDIT_BASE_KEYS, ...AUDIT_CLEAR_KEYS],
    `CHECKPOINT: the existing keys, then exactly the seven clear_* keys ${JSON.stringify(Object.keys(line))}`);
  assert.deepEqual({ epoch: line.clear_session_epoch, generation: line.clear_owner_generation,
    basis: line.clear_basis, reason: line.clear_strand_reason, at: line.clear_strand_at,
    evidence: line.clear_child_evidence, persisted: line.clear_persisted },
  { epoch: 'E-A8', generation: 'G-A8', basis: 'composer_emptied_by_operator', reason: 'submit_outcome_unknown',
    at: strandAt, evidence: 'same_child', persisted: true },
  `CHECKPOINT: every value is a bounded code, an opaque token, an ISO timestamp or a boolean ${JSON.stringify(line)}`);
  assert.deepEqual({ kind: line.kind, source: line.source, from: line.claimed_from, to: line.to,
    result: line.delivery_result, inject: line.inject_id, sha: line.payload_sha256, bytes: line.payload_bytes,
    preview: line.payload_preview },
  { kind: AUDIT_KIND, source: AUDIT_SOURCE, from: 'E-operator', to: 'c1270-a8', result: 'cleared',
    inject: injectId, sha: sha256(''), bytes: 0, preview: null },
  `CHECKPOINT: there is no payload on this door — the empty digest, zero bytes and no preview ${JSON.stringify(line)}`);
  // Even with previews enabled there is nothing to preview, because the payload IS the empty string.
  const previewed = builtLine({ ts, kind: AUDIT_KIND, source: AUDIT_SOURCE, to: 'c1270-a8', payload: '',
    preview: true, delivery_result: 'cleared',
    clear: { session_epoch: 'E-A8', owner_generation: 'G-A8', basis: 'child_replaced_observed',
      strand_reason: 'cr_outcome_unknown', strand_at: strandAt, child_evidence: 'replaced', persisted: false } });
  assert.ok(previewed.payload_preview === null || previewed.payload_preview === '',
    `CHECKPOINT: no prompt, screen or free text can appear in a clear line even with previews on ${JSON.stringify(previewed.payload_preview)}`);
  assert.equal(JSON.stringify(previewed).includes('\n'), false, 'CHECKPOINT: one line, no embedded newline');
  // A refusal from step 4 onward names the reason in the existing vocabulary.
  const refusedLine = builtLine({ ts, kind: AUDIT_KIND, source: AUDIT_SOURCE, to: 'c1270-a8', payload: '',
    delivery_result: 'refused:not_stranded',
    clear: { session_epoch: 'E-A8', owner_generation: 'G-A8', basis: 'composer_emptied_by_operator',
      strand_reason: null, strand_at: null, child_evidence: 'same_child', persisted: false } });
  assert.equal(refusedLine.delivery_result, 'refused:not_stranded',
    'CHECKPOINT: a refusal is auditable as refused:<reason>');
  assert.deepEqual([refusedLine.clear_strand_reason, refusedLine.clear_strand_at], [null, null],
    'CHECKPOINT: with nulls where there was no removed record');
});

test('A9 audit neutrality: a plain inject line and the broker line are byte-identical, with no clear_* key', () => {
  // Gate: neutrality is only meaningful once the conditional block exists; until then this case is RED for the
  // same missing block as A8, which is what keeps an UNCONDITIONAL implementation from passing here.
  const probe = builtLine({ kind: AUDIT_KIND, source: AUDIT_SOURCE, payload: '', delivery_result: 'cleared',
    clear: { session_epoch: 'E', owner_generation: 'G', basis: 'composer_emptied_by_operator',
      strand_reason: null, strand_at: null, child_evidence: 'unobservable', persisted: true } });
  assert.deepEqual(Object.keys(probe).filter(key => key.startsWith('clear_')), AUDIT_CLEAR_KEYS,
    'CHECKPOINT: the operator-clear block must exist before its neutrality can be asserted (A8)');

  const ts = '2026-11-17T09:00:00.000Z';
  const injectId = crypto.randomUUID();
  const plain = builtLine({ ts, inject_id: injectId, kind: 'inject', source: 'inject-bound-v1',
    claimed_from: 'audited-sender', to: 'c1270-a9', origin: 'trusted-local', origin_host: 'c1270-machine',
    payload: 'hello composer', delivery_result: 'forwarded' });
  assert.deepEqual(plain, { v: 1, ts, inject_id: injectId, kind: 'inject', source: 'inject-bound-v1',
    claimed_from: 'audited-sender', verified_sender_sid: null, verified_sender_epoch: null,
    verified_sender_generation: null, spoof_suspected: false, to: 'c1270-a9', to_alias: null,
    origin: 'trusted-local', origin_host: 'c1270-machine', ref_path: null,
    payload_sha256: sha256('hello composer'), payload_bytes: Buffer.byteLength('hello composer'),
    payload_preview: null, delivery_result: 'forwarded' },
  `CHECKPOINT: an ordinary inject line is exactly the pre-change line ${JSON.stringify(plain)}`);
  assert.deepEqual(Object.keys(plain), AUDIT_BASE_KEYS,
    'CHECKPOINT: same keys, same order — the new block is inside a kind guard');
  // A record that names the kind but carries no `clear` block is not a clear line either.
  const kindOnly = builtLine({ ts, kind: AUDIT_KIND, source: AUDIT_SOURCE, to: 'c1270-a9', payload: '',
    delivery_result: 'cleared' });
  assert.deepEqual(Object.keys(kindOnly), AUDIT_BASE_KEYS,
    'CHECKPOINT: `kind` alone does not add the block — the guard is kind AND clear');
  // The broker fixture: a different conditional block, untouched by this change.
  const broker = builtLine({ ts, kind: 'broker', payload: 'remote', delivery_result: 'queued',
    broker: { payload_sha256: sha256('remote'), payload_bytes: 6, event: 'inject', target_sid: 'c1270-a9',
      target_node: 'node-b', node: 'node-a', key: 'key-1', request_sha256: sha256('request'),
      receipt_id: 'r-1', state: 'accepted', status: 202, code: 'OK' } });
  assert.deepEqual(Object.keys(broker).filter(key => key.startsWith('clear_')), [],
    `CHECKPOINT: the broker line gains no clear_* key ${JSON.stringify(Object.keys(broker))}`);
  assert.deepEqual(Object.keys(broker).sort(), [...AUDIT_BASE_KEYS, 'authenticated_identity_scope',
    'authenticated_node_id', 'authenticated_node_key_id', 'broker_code', 'broker_event', 'broker_http_status',
    'broker_receipt_id', 'broker_request_sha256', 'broker_state', 'broker_target_node',
    'foreign_session_identity_verified'].sort(),
  `CHECKPOINT: the broker key set is unchanged ${JSON.stringify(Object.keys(broker).sort())}`);
});

test('A10 view: transport.last_strand_clear is emitted only when a clear happened, with exactly its five keys', () => {
  const sid = 'c1270-a10-view';
  const session = H.registerSession(sid);
  const nowMs = Date.parse('2026-11-17T09:00:00.000Z');
  const before = H.runtime.buildSessionTransportBlock(session, { nowMs });
  assert.equal(Object.hasOwn(before, VIEW_KEY), false,
    `CHECKPOINT: no ${VIEW_KEY} key for a session that was never cleared ${JSON.stringify(Object.keys(before))}`);
  const baseline = JSON.stringify(before);
  // The block is read twice at the same pinned `nowMs` first: byte-identity is only a meaningful assertion if
  // this session's block is deterministic to begin with, and an unstable field would be an invalid setup here.
  assert.equal(JSON.stringify(H.runtime.buildSessionTransportBlock(session, { nowMs })), baseline,
    'PRECONDITION: the transport block of this fixture is deterministic at a pinned clock');

  session.lastStrandClear = { at: '2026-11-17T09:00:00.000Z', basis: 'composer_emptied_by_operator',
    stranded_inject_id: crypto.randomUUID(), child_evidence: 'same_child', by: 'E-operator' };
  const after = H.runtime.buildSessionTransportBlock(session, { nowMs });
  assert.equal(Object.hasOwn(after, VIEW_KEY), true,
    `CHECKPOINT: an operator can see that somebody already cleared this instance (${VIEW_KEY})`);
  assert.deepEqual(Object.keys(after[VIEW_KEY]).sort(), [...VIEW_KEYS].sort(),
    `CHECKPOINT: exactly the five keys of §7.3 ${JSON.stringify(after[VIEW_KEY])}`);
  assert.deepEqual(after[VIEW_KEY], session.lastStrandClear,
    'CHECKPOINT: reported as recorded — the VERIFIED sender in `by`, never the claimed `from`');
  const withoutNewKey = { ...after };
  delete withoutNewKey[VIEW_KEY];
  assert.equal(JSON.stringify(withoutNewKey), baseline,
    'CHECKPOINT: the rest of the block is byte-identical — the new key is a conditional spread, nothing else moved');
  delete session.lastStrandClear;
  assert.equal(JSON.stringify(H.runtime.buildSessionTransportBlock(session, { nowMs })), baseline,
    'CHECKPOINT: and removing the record returns the block to its pre-change bytes');
});

test('A11 persistence neutrality: lastStrandClear is memory-only and never reaches sessions.json', () => {
  assert.equal(typeof runtimeModule.clearStrandedComposer, 'function',
    'CHECKPOINT: delivery-runtime must export clearStrandedComposer (CLEAR-INTERFACE §8) before its record can be neutral');
  const nowIso = new Date().toISOString();
  const epoch = crypto.randomUUID();
  const session = { id: 'c1270-a11', type: 'wrapped', command: 'claude', cwd: '/tmp/c1270',
    sessionEpoch: epoch, credentialVerifier: 'opaque-verifier', credentialGeneration: 1,
    createdAt: nowIso, lastActivityAt: nowIso, clients: new Set() };
  const clean = JSON.stringify(persistence.serializePersistedSessions({ [session.id]: session }));
  session.lastStrandClear = { at: nowIso, basis: 'composer_emptied_by_operator', stranded_inject_id: null,
    child_evidence: 'unobservable', by: null };
  const withRecord = persistence.serializePersistedSessions({ [session.id]: session });
  assert.equal(JSON.stringify(withRecord), clean,
    `CHECKPOINT: the serialized bytes are identical — lastStrandClear is NOT in the whitelist ${JSON.stringify(withRecord)}`);
  assert.equal(Object.hasOwn(withRecord[session.id], 'lastStrandClear'), false,
    'CHECKPOINT: and it must never survive a restart');
  const restored = persistence.buildRestoredWrappedSession(session.id, withRecord[session.id]);
  assert.equal(restored.lastStrandClear, undefined, 'CHECKPOINT: a restored session has no clear record');
});

// ── the daemon harness ────────────────────────────────────────────────────────────────────────────────────────
// The composition of test/inject-bound-v1-green-1270.test.js:226-384 (itself the sealed phase-A compose(), from
// test/immediate-submit-1215.test.js:356-503), with these ADDITIVE differences, all of them seams this unit needs:
//   • `persistSessions` is a swappable shared seam (the clear's one fallible step, §5.4);
//   • the audit writer is the REAL createAuditWriter against a private file, and also captures the records;
//   • the credential store is exposed, so a REAL session bearer can be presented (B12/B14);
//   • `makeClear()` builds the clear registrar on a fresh recording app (A3/A4/D20), and the generic
//     register*Route loop SKIPS the clear registrar, because that one requires `verifyHostToken`;
//   • `milestone()` drives one readiness frame so a child replacement (and a REFUSED frame) is real.
let H = null;
function isOpenWebSocket(ws) { return Boolean(ws && ws.readyState === 1); }

async function compose() {
  const { createDeliveryRuntime } = runtimeModule;
  const { createSessionDeliveryContext } = load('src/mailbox/session-delivery.js');
  const { createSessionActions } = load('src/routes/session-actions.js');
  const inputPolicy = load('src/mailbox/input-policy.js');
  const sessionPersistence = load('src/session-store/persistence.js');
  const metadata = load('src/session-store/route-metadata.js');
  const { createCredentialStore } = load('src/session-store/session-credentials.js');
  const { DeliveryEngine } = load('src/mailbox/delivery.js');
  const { applyProvenance } = load('src/audit/provenance.js');
  const { SessionStateManager, stripAnsi } = load('session-state.js');
  const { createLedgerClient } = load('src/session-store/ledger-client.js');
  const interaction = load('src/interaction.js');
  const submitGate = load('src/submit-gate.js');
  const { CAPABILITY_STAGE_A } = load('src/completion-observation.js');
  const { isProcessRunning } = load('daemon-control.js');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-1270-clear-'));
  const ledgerDir = path.join(root, 'tracked-injections.json');
  const ledgerClient = createLedgerClient({ dir: ledgerDir, lockPath: path.join(root, 'tracked-injections.lock'), legacyPath: ledgerDir });
  const sessions = Object.create(null);
  const pendingReports = Object.create(null);
  const busEvents = [];
  const busClients = new Set([{ readyState: 1, send(raw) { try { busEvents.push(JSON.parse(raw)); } catch { busEvents.push({ unparsed: raw }); } } }]);
  const sessionStateManager = new SessionStateManager();
  const sessionCredentials = createCredentialStore();
  // The REAL audit writer, against a private file: E13 reads the lines back off disk instead of trusting a stub.
  const auditFile = path.join(root, 'logs', 'injects.jsonl');
  const auditWriter = auditLog.createAuditWriter({ path: auditFile, flushMs: 5 });
  const auditLines = [];
  const orchestratorSids = [];
  // The clear's one fallible step. `{ ok: true }` by default; D19/D20 swap in a failure, a throw and no seam.
  let persistBehaviour = () => ({ ok: true });
  const persistCalls = [];
  const persistSessions = (...args) => { persistCalls.push(args); return persistBehaviour(...args); };

  const rshared = {
    sessions, crypto, fs, sessionPersistence, sessionCredentials,
    auditWriter: { append(record) { auditLines.push(record); auditWriter.append(record); } },
    ledgerClient, trackedLedgerHealthy: false, trackedLedgerUnavailableReason: 'not_opened',
    TRACKED_INJECTIONS_PATH: ledgerDir, pendingReports, busClients,
    interaction, interactionWaiters: new Map(), readyRegistry: registry, sessionStateManager,
    stripAnsiState: stripAnsi, submitGate, CAPABILITY_STAGE_A,
    isBootstrapGatedSession: metadata.isBootstrapGatedSession,
    initializeBootstrapState: metadata.initializeBootstrapState,
    isOpenWebSocket, isProcessRunning, PEER_INJECT_KINDS: new Set(['ask-request', 'ask-reply']),
    UPSTREAM_STALL_SECONDS: 30, SESSION_STALE_SECONDS: 60, WRAPPED_SUBMIT_DELAY_MS: 500,
    BOOTSTRAP_READY_TIMEOUT_MS: 30000,
    BRACKETED_PASTE_START: '\x1b[200~', BRACKETED_PASTE_END: '\x1b[201~',
    MODAL_RING_TAIL_BYTES: 65536, MODAL_REMEDIES: new Set(['hold', 'park', 'reject', 'off']),
    MODAL_REMEDY_BY_CLI: { claude: 'park' }, MODAL_REMEDY_DEFAULT: 'hold',
    MODAL_HINT_BY_CLI: { claude: 'Answer the blocking modal.', codex: 'Dismiss the update modal.' },
    MODAL_HOLD_DEFAULT_MS: 30000, MODAL_PARK_TTL_DEFAULT_MS: 600000, MODAL_PARK_POLL_MS: 500,
    persistSessions,
  };
  const runtime = createDeliveryRuntime(rshared);
  rshared.interactionCore = runtime.createInteractionRuntime();
  const opened = await runtime.restoreTrackedInjections();
  assert.equal(opened && opened.ok, true, `PRECONDITION: private ledger opens ${JSON.stringify(opened)}`);
  const mailbox = new FileMailbox({ root: path.join(root, 'mailbox') });
  let engine;
  const context = createSessionDeliveryContext({ ...runtime, sessions, crypto, applyProvenance, interaction,
    isOpenWebSocket, DELIVERY_TIMEOUT_MS: 1000,
    getMailbox: () => mailbox, getMailboxDelivery: () => engine,
    getMailboxNotifier: () => ({ notify() { throw new Error('PRECONDITION: wrapped fixture must not notify UDS'); } }) });
  rshared.writeDataToSession = context.writeDataToSession;
  engine = new DeliveryEngine(mailbox, context.mailboxDeliveryOptions);

  const ashared = {
    ...runtime,
    sessions, pendingReports, busClients, crypto, ledgerClient, sessionStateManager, stripAnsiState: stripAnsi,
    submitGate, readyRegistry: registry, sessionPersistence, persistSessions,
    deliverInjectionToSession: context.deliverInjectionToSession,
    isBootstrapGatedSession: metadata.isBootstrapGatedSession,
    isOpenWebSocket,
    resolveSessionAlias: id => (typeof id === 'string' && Object.hasOwn(sessions, id) ? id : null),
    ORCHESTRATOR_SIDS: orchestratorSids, MACHINE_ID: 'c1270-clear-machine',
    NON_TERMINAL_GATE_REASONS: new Set(['timeout', 'no_state', 'no_state_manager', 'busy_settled']),
    SUBMIT_BUSY_DISPATCH_ENABLED: true, SUBMIT_BUSY_GRACE_MS: 250,
    REDELIVER_ENABLED: true, REDELIVER_MAX_ATTEMPTS: 3, REDELIVER_TOTAL_TIMEOUT_MS: 600000, REDELIVER_IDLE_WAIT_MS: 120000,
    CAPABILITY_STAGE_A, deliveredAbsenceIdentities: new WeakMap(),
  };

  // The host token this daemon expects. The route never receives it: step 1.5 is the injected verifyHostToken,
  // exactly as daemon.js wires it, so the secret never enters the routes module.
  const TOKEN = `c1270-${crypto.randomBytes(18).toString('base64url')}`;
  function verifyHostToken(req) {
    const supplied = req && req.headers ? req.headers['x-telepty-token'] : undefined;
    if (clearProtocolLoad.ok && typeof clearProtocolLoad.module.hostTokenMatches === 'function') {
      return clearProtocolLoad.module.hostTokenMatches(supplied, TOKEN);
    }
    // Declared fake, used only while the pure module does not exist yet (the RED run registers no route at all).
    if (typeof supplied !== 'string') return false;
    const a = Buffer.from(supplied); const b = Buffer.from(TOKEN);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  const actions = createSessionActions(ashared, {});
  const routes = Object.create(null);
  const app = { use() {} };
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    app[method] = (route, ...handlers) => { routes[`${method.toUpperCase()} ${route}`] = handlers[handlers.length - 1]; };
  }
  for (const [name, fn] of Object.entries(actions)) {
    // The clear registrar takes required options (verifyHostToken) and MUST throw without them (A4), so it is
    // registered explicitly below instead of through this loop.
    if (name === 'registerClearStrandV1Route') continue;
    if (/^register\w*Route$/.test(name) && typeof fn === 'function') fn(app);
  }
  assert.equal(typeof routes['POST /api/sessions/:id/inject-bound-v1'], 'function',
    'PRECONDITION: the bound route is registered (this file drives it to produce a REAL strand)');
  if (typeof actions.registerClearStrandV1Route === 'function') {
    actions.registerClearStrandV1Route(app, { verifyHostToken });
  }

  function makeClear(sharedOverrides = {}, options = {}) {
    const localActions = createSessionActions({ ...ashared, ...sharedOverrides }, {});
    const localRoutes = Object.create(null);
    const registered = [];
    const localApp = { use() {} };
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      localApp[method] = (route, ...handlers) => {
        registered.push({ method: method.toUpperCase(), route });
        localRoutes[`${method.toUpperCase()} ${route}`] = handlers[handlers.length - 1];
      };
    }
    let error = null;
    if (typeof localActions.registerClearStrandV1Route === 'function') {
      const registrarOptions = Object.hasOwn(options, 'registrar') ? options.registrar : { verifyHostToken };
      try { localActions.registerClearStrandV1Route(localApp, registrarOptions); }
      catch (thrown) { error = thrown; }
    }
    const key = registered.length === 1 ? `${registered[0].method} ${registered[0].route}` : ROUTE_KEY;
    return { actions: localActions, routes: localRoutes, registered, error, handler: localRoutes[key] };
  }

  function ownerSocket(onSend) {
    const ws = { readyState: 1, frames: [], send(raw) { ws.frames.push(JSON.parse(raw)); if (onSend) onSend(ws, ws.frames.at(-1)); } };
    return ws;
  }
  function claimOwner(session, ws, { supervised = true } = {}) {
    if (supervised) {
      const capability = inputPolicy.mintInputPolicyCapability(session);
      inputPolicy.requestInputPolicy(session, 'user-supervised', 'operator_principal_registration', new Date(), { origin: 'new_instance' });
      session.ownerWs = ws; session.clients.add(ws);
      session.interactionOwnerGeneration = crypto.randomUUID();
      inputPolicy.bindInputPolicy(session, new Date(), { capability });
      assert.equal(inputPolicy.userSupervised(session), true, 'PRECONDITION: supervised for this owner generation');
    } else {
      session.ownerWs = ws; session.clients.add(ws);
      session.interactionOwnerGeneration = crypto.randomUUID();
    }
  }
  function negotiate(session, { capable = true, header = HEADER_BOUND } = {}) {
    readinessHandshake.beginOwnerGeneration(session, { capable });
    runtimeModule.bindImmediateSubmitCapability(session, header);
  }
  // One readiness frame, returned so a REFUSED frame can be asserted as refused (D17).
  function milestone(session, { type = 'process_started', childSeq = 1, pid = 4242, nonce = null, epoch = undefined } = {}) {
    const state = session.transportReadiness || {};
    const frame = { schema: 1, session_id: session.id,
      session_epoch: epoch === undefined ? session.sessionEpoch : epoch,
      owner_generation: session.interactionOwnerGeneration,
      readiness_nonce: nonce === null ? state.nonce : nonce, child_seq: childSeq,
      ...(type === 'process_started' ? { pid, exec: 'unverified' } : { input_loop: 'attached' }) };
    return readinessHandshake.acceptMilestone(session.id, session, { type, ...frame });
  }
  function transportReady(session, { childSeq = 1, pid = 4242 } = {}) {
    const started = milestone(session, { type: 'process_started', childSeq, pid });
    const ready = milestone(session, { type: 'input_transport_ready', childSeq });
    assert.deepEqual([started.ok, ready.ok], [true, true], `PRECONDITION: milestones accepted ${JSON.stringify([started, ready])}`);
    runtime.markBootstrapReady(session.id, session, 'input_transport_ready');
  }
  function registerSession(sid, { command = 'claude', supervised = true, capable = true, header = HEADER_BOUND,
    ready = true, onSend = null } = {}) {
    const ws = ownerSocket(onSend);
    const epoch = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const session = { id: sid, type: 'wrapped', command, clients: new Set(), ownerWs: null,
      sessionEpoch: epoch, sessionEpochProved: epoch, credentialGeneration: 1,
      outputRing: [], outputRingTotalBytes: 0, createdAt: nowIso, lastActivityAt: nowIso, lastConnectedAt: nowIso };
    sessions[sid] = session;
    claimOwner(session, ws, { supervised });
    negotiate(session, { capable, header });
    metadata.initializeBootstrapState(session);
    sessionStateManager.register(sid);
    if (capable && ready) transportReady(session);
    return session;
  }
  // A session with a LIVE strand, produced through the exported boundary (the green file's own unit technique).
  // D1-D3/E1-E3 instead drive a REAL bound delivery whose CR is withheld.
  function strandedFixture(sid, { reason = 'submit_outcome_unknown', injectId = crypto.randomUUID(), options = {} } = {}) {
    const session = registerSession(sid, options);
    const strand = runtimeModule.strandComposer(session, { epoch: session.sessionEpoch, injectId, reason });
    assert.ok(strand, `PRECONDITION: ${sid} is stranded ${JSON.stringify(strand)}`);
    return { session, strand };
  }
  function clearBody(session, overrides = {}) {
    const strand = runtimeModule.strandedComposer(session);
    return { schema: REQUEST_SCHEMA, from: 'E-operator',
      expected_epoch: session.sessionEpoch,
      expected_owner_generation: session.interactionOwnerGeneration,
      stranded_inject_id: strand ? strand.inject_id : null,
      basis: 'composer_emptied_by_operator', ...overrides };
  }
  // The req shape of the /api/daemon/stop guard: a loopback socket peer, the host token in the HEADER, the JSON
  // content type and the raw body bytes. Nothing here consults a forwarded header, and there is no query token.
  function clearReq(sid, body, options = {}) {
    const req = {
      method: 'POST', params: { id: sid }, body, query: {},
      url: `/api/sessions/${typeof sid === 'string' ? sid : ''}/${VERB}`,
      headers: { 'content-type': 'application/json', 'x-telepty-token': TOKEN },
      socket: { remoteAddress: '127.0.0.1' },
      principalRawBody: Buffer.from(JSON.stringify(body === undefined ? null : body), 'utf8'),
    };
    if (options.headers) Object.assign(req.headers, options.headers);
    for (const header of options.dropHeaders || []) delete req.headers[header];
    if (options.socket) Object.assign(req.socket, options.socket);
    if (Object.hasOwn(options, 'principalRawBody')) req.principalRawBody = options.principalRawBody;
    if (Object.hasOwn(options, 'query')) req.query = options.query;
    return req;
  }
  function call(key, sid, body) {
    return new Promise((resolve, reject) => {
      const res = { statusCode: 200, status(code) { res.statusCode = code; return res; },
        json(payload) { resolve({ status: res.statusCode, body: payload }); return res; } };
      Promise.resolve(routes[key]({ params: { id: sid }, body, headers: {}, query: {} }, res)).catch(reject);
    });
  }
  async function dispose() {
    try { engine.stop(); } catch {}
    for (const [id, session] of Object.entries(sessions)) {
      try { runtime.cancelModalParkPoll(session); } catch {}
      if (session.bootstrapOptimisticTimer) { clearTimeout(session.bootstrapOptimisticTimer); session.bootstrapOptimisticTimer = null; }
      if (session.inputTransportTimer) { clearTimeout(session.inputTransportTimer); session.inputTransportTimer = null; }
      try { sessionStateManager.unregister(id); } catch {}
    }
    try { sessionStateManager.destroyAll(); } catch {}
    try { await auditWriter.close(); } catch {}
    try { await ledgerClient.close(2000); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }

  return { sessions, runtime, routes, actions, app, makeClear, TOKEN, verifyHostToken,
    registerSession, strandedFixture, claimOwner, negotiate, transportReady, milestone, ownerSocket,
    clearBody, clearReq, call, dispose, sessionStateManager, sessionCredentials, auditLines, auditFile,
    auditWriter, busEvents, orchestratorSids, persistCalls,
    setPersist: behaviour => { persistBehaviour = behaviour; },
    writeDataToSession: context.writeDataToSession,
    deliverInjectionToSession: context.deliverInjectionToSession,
    clearHandler: typeof actions.registerClearStrandV1Route === 'function' ? routes[ROUTE_KEY] : undefined,
  };
}

before(async () => { H = await compose(); }, { timeout: 30000 });
after(async () => { if (H) await H.dispose(); }, { timeout: 30000 });

// ── shared drivers for the route cases ────────────────────────────────────────────────────────────────────────
function clearHandler(what) {
  assert.equal(typeof H.clearHandler, 'function',
    `CHECKPOINT: POST ${ROUTE} must be registered for ${what} (CLEAR-INTERFACE §1) — createSessionActions exposes no clear registrar yet`);
  return H.clearHandler;
}
function invokeClear(req, { handler = null, what = 'the clear' } = {}) {
  const fn = handler || clearHandler(what);
  const captured = { status: 200, body: undefined, calls: 0 };
  const res = { statusCode: 200,
    status(code) { captured.status = code; res.statusCode = code; return res; },
    json(payload) { captured.calls += 1; captured.body = payload; return res; } };
  const returned = fn(req, res);
  assert.equal(!!returned && typeof returned.then === 'function', false,
    'CHECKPOINT: the handler is synchronous — no promise is returned, so no await can sit between the checks and the delete');
  assert.equal(captured.calls, 1, `CHECKPOINT: exactly one answer was sent (${captured.calls})`);
  return { status: captured.status, body: captured.body };
}
// One refusal row: the status/reason of the §6 map, the closed object, no effect, no record.
function assertRefusal(session, strandBefore, answer, reason, { beforeStep4 = false, sid = null } = {}) {
  assert.deepEqual({ status: answer.status, stage: answer.body && answer.body.stage, reason: answer.body && answer.body.reason },
    { status: STATUS_FOR[reason], stage: 'refused', reason },
    `CHECKPOINT: ${reason} is answered ${STATUS_FOR[reason]} with stage refused ${JSON.stringify(answer)}`);
  assertClosedResult(answer.body, sid === null ? (session ? session.id : null) : sid, { beforeStep4 });
  if (session && strandBefore) {
    assert.equal(session.strandedComposer, strandBefore,
      'CHECKPOINT: the SAME strand record object is still in place — the refusal happened before any effect');
    assert.ok(runtimeModule.strandedComposer(session), 'CHECKPOINT: and the instance is still stranded');
  }
}

// ── Part 2: RED-B — transport authority (pure fakes, no listener) ─────────────────────────────────────────────

test('B1/B2/B3 locality: a tailnet peer, a mapped private address and a FORWARDED loopback are all refused 403', () => {
  const { session, strand } = H.strandedFixture('c1270-b-locality');
  const authorize = clearProtocolFn('authorizeClearStrandTransport', 'the pure locality gate');
  const rows = {
    'tailnet peer': { remoteAddress: '100.72.155.21' },
    'mapped private v6': { remoteAddress: '::ffff:10.0.0.9' },
    'public peer': { remoteAddress: '203.0.113.7' },
    'no peer at all': { remoteAddress: undefined },
  };
  for (const [label, socket] of Object.entries(rows)) {
    const audits = H.auditLines.length; const events = H.busEvents.length;
    const req = H.clearReq(session.id, H.clearBody(session), { socket });
    assert.deepEqual(authorize(req), { status: 403, reason: 'clear_local_only' },
      `CHECKPOINT: the pure gate refuses ${label} (${JSON.stringify(socket)})`);
    assertRefusal(session, strand, invokeClear(req), 'clear_local_only', { beforeStep4: true });
    assert.deepEqual([H.auditLines.length - audits, H.busEvents.length - events], [0, 0],
      `CHECKPOINT: ${label} writes no audit line and no bus event`);
  }
  // Loopback in a FORWARDED header only: the socket peer is the only thing that counts.
  const forged = H.clearReq(session.id, H.clearBody(session), {
    socket: { remoteAddress: '203.0.113.7' },
    headers: { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', forwarded: 'for=127.0.0.1' } });
  assert.deepEqual(authorize(forged), { status: 403, reason: 'clear_local_only' },
    'CHECKPOINT: a forwarded header never makes a request local');
  assertRefusal(session, strand, invokeClear(forged), 'clear_local_only', { beforeStep4: true });
  // The loopback forms that ARE accepted reach a later check instead of being refused here.
  for (const remoteAddress of ['127.0.0.1', '127.0.0.53', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']) {
    assert.equal(authorize(H.clearReq(session.id, H.clearBody(session), { socket: { remoteAddress } })), null,
      `CHECKPOINT: ${remoteAddress} is a loopback peer and passes step 1.1`);
  }
});

test('B4/B5 origin: any Origin header at all is refused 403, including the daemon\'s own origin', () => {
  const { session, strand } = H.strandedFixture('c1270-b-origin');
  const authorize = clearProtocolFn('authorizeClearStrandTransport', 'the pure Origin gate');
  for (const origin of ['http://evil.test', 'http://127.0.0.1:3848', 'null', '']) {
    const audits = H.auditLines.length;
    const req = H.clearReq(session.id, H.clearBody(session), { headers: { origin } });
    assert.deepEqual(authorize(req), { status: 403, reason: 'clear_origin_refused' },
      `CHECKPOINT: Origin ${JSON.stringify(origin)} is refused — a browser can never reach this door`);
    assertRefusal(session, strand, invokeClear(req), 'clear_origin_refused', { beforeStep4: true });
    assert.equal(H.auditLines.length - audits, 0, 'CHECKPOINT: and nothing is recorded');
  }
});

test('B6/B7/B8 content type and body bounds: a non-JSON type is 415 and an absent/oversize raw body is 413', () => {
  const { session, strand } = H.strandedFixture('c1270-b-bounds');
  const authorize = clearProtocolFn('authorizeClearStrandTransport', 'the pure content/bounds gate');
  for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'application/octet-stream', '', undefined]) {
    const req = H.clearReq(session.id, H.clearBody(session),
      contentType === undefined ? { dropHeaders: ['content-type'] } : { headers: { 'content-type': contentType } });
    assert.deepEqual(authorize(req), { status: 415, reason: 'clear_content_type' },
      `CHECKPOINT: content-type ${JSON.stringify(contentType)} is refused 415`);
    assertRefusal(session, strand, invokeClear(req), 'clear_content_type', { beforeStep4: true });
  }
  // The rule of CLEAR-INTERFACE §5 step 1.3 is a lower-cased PREFIX test, exactly as the /api/daemon/stop
  // guard's is, so a parameterised JSON type is accepted — and so is a type that merely starts that way. The
  // bound is not the discriminator here: the body still has to BE the closed object (step 2).
  for (const contentType of ['application/json', 'APPLICATION/JSON; charset=utf-8', 'application/json;charset=utf-8',
    'application/jsonx']) {
    assert.equal(authorize(H.clearReq(session.id, H.clearBody(session), { headers: { 'content-type': contentType } })), null,
      `CHECKPOINT: ${contentType} starts with application/json, which is the rule this door states`);
  }
  const body = H.clearBody(session);
  const padded = `${JSON.stringify(body)}${' '.repeat(600)}`;
  for (const [label, raw] of Object.entries({
    'oversize but valid JSON': Buffer.from(padded, 'utf8'),
    'exactly one byte over': Buffer.alloc(513, 0x20),
    empty: Buffer.alloc(0),
    absent: undefined,
    'not a Buffer': JSON.stringify(body),
    'a string of the right length': 'x'.repeat(100),
  })) {
    const req = H.clearReq(session.id, body, { principalRawBody: raw });
    assert.deepEqual(authorize(req), { status: 413, reason: 'clear_body_bytes' },
      `CHECKPOINT: a raw body that is ${label} is refused 413 before anything parses it`);
    assertRefusal(session, strand, invokeClear(req), 'clear_body_bytes', { beforeStep4: true });
  }
  assert.equal(authorize(H.clearReq(session.id, body, { principalRawBody: Buffer.alloc(512, 0x20) })), null,
    'CHECKPOINT: 512 bytes is the bound, not one less');
  assert.equal(authorize(H.clearReq(session.id, body, { principalRawBody: Buffer.alloc(1, 0x20) })), null,
    'CHECKPOINT: and one byte is enough to pass the bound (the shape check comes later)');
});

test('B9/B10/B11/B12/B13 credential: only the host token in the HEADER authorises — not a query token, a JWT, a session bearer or a profile carrier', () => {
  const { session, strand } = H.strandedFixture('c1270-b-credential');
  const body = H.clearBody(session);
  const jwt = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: 'operator' })).toString('base64url')}.sig`;
  const bearer = H.sessionCredentials.issue('E-peer-session').bearer;
  const profileToken = `tpc1.1.${crypto.randomBytes(32).toString('base64url')}`;
  const rows = {
    'query token only': { dropHeaders: ['x-telepty-token'], query: { token: H.TOKEN } },
    'no token at all': { dropHeaders: ['x-telepty-token'] },
    'one byte wrong': { headers: { 'x-telepty-token': `${H.TOKEN.slice(0, -1)}X` } },
    'a different length': { headers: { 'x-telepty-token': `${H.TOKEN}extra` } },
    'empty token': { headers: { 'x-telepty-token': '' } },
    'array token': { headers: { 'x-telepty-token': [H.TOKEN] } },
    'JWT instead': { dropHeaders: ['x-telepty-token'], headers: { authorization: `Bearer ${jwt}` } },
    'session bearer instead': { dropHeaders: ['x-telepty-token'], headers: { 'x-telepty-session-token': bearer } },
    'client-profile carrier instead': { dropHeaders: ['x-telepty-token'], headers: { 'x-telepty-client-token': profileToken } },
  };
  for (const [label, options] of Object.entries(rows)) {
    const audits = H.auditLines.length; const events = H.busEvents.length;
    const answer = invokeClear(H.clearReq(session.id, body, options));
    assertRefusal(session, strand, answer, 'clear_auth_required', { beforeStep4: true });
    assert.deepEqual([H.auditLines.length - audits, H.busEvents.length - events], [0, 0],
      `CHECKPOINT: ${label} writes no record`);
  }
  // The pure transport gate never sees the token at all: step 1.5 is the injected verifyHostToken.
  const authorize = clearProtocolFn('authorizeClearStrandTransport', 'the token-free transport gate');
  assert.equal(authorize(H.clearReq(session.id, body, { dropHeaders: ['x-telepty-token'] })), null,
    'CHECKPOINT: authorizeClearStrandTransport performs steps 1.1-1.4 only — the secret never enters the routes module');
  const source = sourceWithoutComments(String(authorize));
  assert.equal(source.includes('x-telepty-token'), false,
    'CHECKPOINT: and it does not even name the token header');
});

test('B14 recorded, not refused: a valid host token plus a session bearer clears, and the audit line names the verified sender', () => {
  const { session } = H.strandedFixture('c1270-b-bearer');
  const issued = H.sessionCredentials.issue('E-operator-session');
  const audits = H.auditLines.length;
  H.setPersist(() => ({ ok: true }));
  const answer = invokeClear(H.clearReq(session.id, H.clearBody(session, { from: 'E-claims-to-be-someone-else' }),
    { headers: { 'x-telepty-session-token': issued.bearer } }));
  assert.deepEqual([answer.status, answer.body.stage], [200, 'cleared'],
    `CHECKPOINT: a request that also carries a session bearer is NOT refused by step 1 ${JSON.stringify(answer.body)}`);
  const records = H.auditLines.slice(audits);
  assert.equal(records.length, 1, `CHECKPOINT: exactly one audit line ${JSON.stringify(records)}`);
  const line = builtLine(records[0]);
  assert.deepEqual({ kind: line.kind, source: line.source, claimed: line.claimed_from, verified: line.verified_sender_sid,
    spoof: line.spoof_suspected, to: line.to, result: line.delivery_result },
  { kind: AUDIT_KIND, source: AUDIT_SOURCE, claimed: 'E-claims-to-be-someone-else', verified: 'E-operator-session',
    spoof: true, to: session.id, result: 'cleared' },
  `CHECKPOINT: the claim is recorded next to the VERIFIED sender, and the disagreement is flagged ${JSON.stringify(line)}`);
  assert.equal(line.verified_sender_epoch, issued.epoch, 'CHECKPOINT: with the instance the bearer belongs to');
});

test('B15 ordering: locality is decided before the credential, so a remote caller with a wrong token learns only that', () => {
  const { session, strand } = H.strandedFixture('c1270-b-order');
  const req = H.clearReq(session.id, H.clearBody(session), {
    socket: { remoteAddress: '100.72.155.21' }, headers: { 'x-telepty-token': 'not-the-token' } });
  assertRefusal(session, strand, invokeClear(req), 'clear_local_only', { beforeStep4: true });
  // And the Origin check sits between them: a loopback browser POST with a wrong token is still the Origin refusal.
  const browser = H.clearReq(session.id, H.clearBody(session), {
    headers: { origin: 'http://127.0.0.1:3848', 'x-telepty-token': 'not-the-token' } });
  assertRefusal(session, strand, invokeClear(browser), 'clear_origin_refused', { beforeStep4: true });
  // A wrong content type with a wrong token is the content-type refusal: the order of §5 step 1 is total.
  const typed = H.clearReq(session.id, H.clearBody(session), {
    headers: { 'content-type': 'text/plain', 'x-telepty-token': 'not-the-token' } });
  assertRefusal(session, strand, invokeClear(typed), 'clear_content_type', { beforeStep4: true });
});

test('B16 timing: the host-token comparison is length-guarded and timing-safe, and a wrong token never reaches step 2', () => {
  const matches = clearProtocolFn('hostTokenMatches', 'the timing-safe comparison');
  // A shape-invalid BODY with a wrong TOKEN must still answer the credential refusal: the body is never parsed
  // for an unauthenticated caller, which is what makes the 401 the only thing such a caller can learn.
  const { session, strand } = H.strandedFixture('c1270-b-timing');
  const answer = invokeClear(H.clearReq(session.id, { schema: 'nonsense' },
    { headers: { 'x-telepty-token': 'wrong' } }));
  assertRefusal(session, strand, answer, 'clear_auth_required', { beforeStep4: true });
  assert.equal(matches('wrong', H.TOKEN), false, 'CHECKPOINT: an unequal-length token is false, never a throw');
  assert.doesNotThrow(() => matches('x', H.TOKEN), 'CHECKPOINT: no length can make the comparison throw');
});

// ── Part 3: RED-C — the closed request schema ─────────────────────────────────────────────────────────────────

test('C1/C2/C3/C4 shape: a non-object, an extra key, a missing key and a wrong schema are refused 400 before any effect', () => {
  const validate = clearProtocolFn('validateClearRequest', 'the closed request schema');
  const { session, strand } = H.strandedFixture('c1270-c-shape');
  const valid = H.clearBody(session);
  assert.equal(validate(valid), null, `PRECONDITION: the fixture body IS the closed request ${JSON.stringify(valid)}`);
  const rows = [
    ['request_not_object', null], ['request_not_object', undefined], ['request_not_object', 'telepty.clear-strand/v1'],
    ['request_not_object', 42], ['request_not_object', [valid]], ['request_not_object', true],
    ['request_keys', { ...valid, extra: 1 }], ['request_keys', { ...valid, prompt: 'type this for me' }],
    ['request_keys', { ...valid, force: true }],
    ['request_keys', (() => { const copy = { ...valid }; delete copy.basis; return copy; })()],
    ['request_keys', (() => { const copy = { ...valid }; delete copy.schema; return copy; })()],
    ['request_keys', { schema: REQUEST_SCHEMA, from: 'E-operator', expected_epoch: 'E', expected_owner_generation: 'G',
      stranded_inject_id: null, bas1s: 'composer_emptied_by_operator' }],
    ['request_schema', { ...valid, schema: 'telepty.clear-strand/v2' }],
    ['request_schema', { ...valid, schema: 'telepty.bound-inject/v1' }],
    ['request_schema', { ...valid, schema: '' }], ['request_schema', { ...valid, schema: 1 }],
  ];
  for (const [reason, body] of rows) {
    assert.equal(validate(body), reason, `CHECKPOINT: ${JSON.stringify(body)} is ${reason}`);
    const audits = H.auditLines.length;
    assertRefusal(session, strand, invokeClear(H.clearReq(session.id, body)), reason, { beforeStep4: true });
    assert.equal(H.auditLines.length - audits, 0, `CHECKPOINT: ${reason} writes no audit line`);
  }
  // A seventh key hidden in the prototype chain is not a key of this object, and must not be adopted either.
  const planted = JSON.parse(`{"schema":${JSON.stringify(REQUEST_SCHEMA)},"from":"E-operator","expected_epoch":${
    JSON.stringify(session.sessionEpoch)},"expected_owner_generation":${JSON.stringify(session.interactionOwnerGeneration)
  },"stranded_inject_id":${JSON.stringify(valid.stranded_inject_id)},"basis":"composer_emptied_by_operator","__proto__":{"basis":"force"}}`);
  assert.ok(['request_keys', null].includes(validate(planted)),
    `CHECKPOINT: a __proto__ payload is either a seventh key or inert — never a basis override (${validate(planted)})`);
});

test('C5/C6/C7/C8/C9 fields: each identity field has its own code, and nothing is ever coerced', () => {
  const validate = clearProtocolFn('validateClearRequest', 'the per-field refusals');
  const { session, strand } = H.strandedFixture('c1270-c-fields');
  const valid = H.clearBody(session);
  const rows = [
    // C5 — `from` is bounded in BYTES (the r1-m3 rule), non-empty, control-char free.
    ['from_invalid', { from: '' }], ['from_invalid', { from: 'x'.repeat(257) }],
    ['from_invalid', { from: 'あ'.repeat(100) }], ['from_invalid', { from: 'E-operator\n' }],
    ['from_invalid', { from: 'E\u0000operator' }], ['from_invalid', { from: null }], ['from_invalid', { from: 42 }],
    ['from_invalid', { from: ['E-operator'] }],
    // C6 — expected_epoch
    ['expected_epoch_invalid', { expected_epoch: '' }], ['expected_epoch_invalid', { expected_epoch: 1 }],
    ['expected_epoch_invalid', { expected_epoch: 'E'.repeat(257) }],
    ['expected_epoch_invalid', { expected_epoch: null }],
    ['expected_epoch_invalid', { expected_epoch: 'E\u001b[0m' }],
    // C7 — a NUMBER that stringifies to the current generation is a different claim, never a conversion.
    ['expected_owner_generation_invalid', { expected_owner_generation: 7 }],
    ['expected_owner_generation_invalid', { expected_owner_generation: '' }],
    ['expected_owner_generation_invalid', { expected_owner_generation: ['G'] }],
    ['expected_owner_generation_invalid', { expected_owner_generation: 'G'.repeat(257) }],
    // C8 — stranded_inject_id is `null` or a real inject id. No other spelling of absence exists.
    ['stranded_inject_id_invalid', { stranded_inject_id: '' }],
    ['stranded_inject_id_invalid', { stranded_inject_id: 'null' }],
    ['stranded_inject_id_invalid', { stranded_inject_id: 'none' }],
    ['stranded_inject_id_invalid', { stranded_inject_id: '-' }],
    ['stranded_inject_id_invalid', { stranded_inject_id: 'not-a-uuid' }],
    ['stranded_inject_id_invalid', { stranded_inject_id: `${crypto.randomUUID()}\n` }],
    ['stranded_inject_id_invalid', { stranded_inject_id: false }],
    // C9 — basis is exactly one of two strings.
    ['basis_invalid', { basis: 'composer-emptied-by-operator' }], ['basis_invalid', { basis: 'force' }],
    ['basis_invalid', { basis: true }], ['basis_invalid', { basis: '' }], ['basis_invalid', { basis: null }],
    ['basis_invalid', { basis: ['composer_emptied_by_operator'] }],
    ['basis_invalid', { basis: 'COMPOSER_EMPTIED_BY_OPERATOR' }],
  ];
  for (const [reason, override] of rows) {
    const body = { ...valid, ...override };
    assert.equal(validate(body), reason, `CHECKPOINT: ${JSON.stringify(override)} is ${reason}`);
    assertRefusal(session, strand, invokeClear(H.clearReq(session.id, body)), reason, { beforeStep4: true });
  }
  // The accepted edges of the same bounds.
  for (const override of [{ from: 'x'.repeat(256) }, { from: 'あ'.repeat(80) },
    { stranded_inject_id: null }, { basis: 'child_replaced_observed' }]) {
    assert.equal(validate({ ...valid, ...override }), null,
      `CHECKPOINT: ${JSON.stringify(override)} is inside the bound and validates`);
  }
  assert.equal(validate({ ...valid, stranded_inject_id: String(valid.stranded_inject_id).toUpperCase() }), null,
    'CHECKPOINT: an uppercase inject id is well-FORMED (it is step 4.10 that refuses it as a mismatch)');
});

test('C10 duplicate JSON keys: the surviving value is the one validated, and never both', () => {
  const validate = clearProtocolFn('validateClearRequest', 'the parser collapse rule');
  const { session, strand } = H.strandedFixture('c1270-c-duplicates');
  const epoch = JSON.stringify(session.sessionEpoch);
  const generation = JSON.stringify(session.interactionOwnerGeneration);
  const strandId = JSON.stringify(runtimeModule.strandedComposer(session).inject_id);
  // The LAST `basis` wins in every JSON parser; the request is then refused or accepted on that one value.
  const refusedRaw = `{"schema":${JSON.stringify(REQUEST_SCHEMA)},"from":"E-operator","expected_epoch":${epoch},`
    + `"expected_owner_generation":${generation},"stranded_inject_id":${strandId},`
    + '"basis":"composer_emptied_by_operator","basis":"force"}';
  const refusedBody = JSON.parse(refusedRaw);
  assert.deepEqual(Object.keys(refusedBody).sort(), [...REQUEST_KEYS].sort(),
    'PRECONDITION: the duplicate collapsed in the parser — six keys reach the validator');
  assert.equal(refusedBody.basis, 'force', 'PRECONDITION: the surviving value is the last one');
  assert.equal(validate(refusedBody), 'basis_invalid', 'CHECKPOINT: validated on the surviving value');
  assertRefusal(session, strand, invokeClear(H.clearReq(session.id, refusedBody,
    { principalRawBody: Buffer.from(refusedRaw, 'utf8') })), 'basis_invalid');
  // The mirror: a duplicate whose survivor is valid is accepted on that value alone, not on both.
  const acceptedRaw = `{"schema":${JSON.stringify(REQUEST_SCHEMA)},"from":"E-operator","expected_epoch":${epoch},`
    + `"expected_owner_generation":${generation},"stranded_inject_id":${strandId},`
    + '"basis":"force","basis":"composer_emptied_by_operator"}';
  const acceptedBody = JSON.parse(acceptedRaw);
  assert.equal(validate(acceptedBody), null, 'CHECKPOINT: and a surviving VALID value validates');
  H.setPersist(() => ({ ok: true }));
  const answer = invokeClear(H.clearReq(session.id, acceptedBody, { principalRawBody: Buffer.from(acceptedRaw, 'utf8') }));
  assert.deepEqual([answer.status, answer.body.stage, answer.body.basis],
    [200, 'cleared', 'composer_emptied_by_operator'],
    `CHECKPOINT: the clear acts on exactly one basis ${JSON.stringify(answer.body)}`);
});

// ── Part 4: RED-D — target, state, identity and basis, against the real composition ───────────────────────────

const BOUND_ROUTE_KEY = 'POST /api/sessions/:id/inject-bound-v1';
function boundRequest(session, prompt) {
  return { schema: 'telepty.bound-inject/v1', prompt, from: 'fixture-sender', expected_epoch: session.sessionEpoch,
    expected_owner_generation: session.interactionOwnerGeneration, require: ['immediate-submit-v1', 'busy-input-v1'] };
}
// A REAL strand, through the real bound route: the body is handed to the owner bridge and the CR is then
// withheld because the admission gate closed from INSIDE the body write (the green file's #737 technique). No
// timer and no sleep — and, unlike closing the socket, the owner stays OPEN, so the clear's own step 4.9 is
// satisfied by the same fixture that produced the strand.
async function strandByDelivery(sid) {
  const hook = { session: null };
  const session = H.registerSession(sid, { onSend: (ws, frame) => {
    if (frame.part === 'body' && hook.session) hook.session.bootstrapDraining = true;
  } });
  hook.session = session;
  H.sessionStateManager.feed(sid, WORKING);
  const response = await H.call(BOUND_ROUTE_KEY, sid, boundRequest(session, `${sid} unsubmitted text`));
  assert.deepEqual({ stage: response.body.stage, reason: response.body.reason, body: response.body.body_stage,
    submit: response.body.submit_stage, bytes: response.body.bytes_written },
  { stage: 'outcome_unknown', reason: 'admission_changed_after_body', body: 'sent_to_bridge', submit: 'not_sent', bytes: null },
  `PRECONDITION: the fixture delivery handed a body and withheld its CR ${JSON.stringify(response.body)}`);
  assert.deepEqual(session.ownerWs.frames.filter(frame => frame.type === 'inject').map(frame => frame.part), ['body'],
    'PRECONDITION: exactly one frame — the body, never an Enter');
  const strand = runtimeModule.strandedComposer(session);
  assert.ok(strand, 'PRECONDITION: the instance IS stranded by the real delivery');
  assert.equal(strand.inject_id, response.body.inject_id, 'PRECONDITION: the strand names the delivery\'s own inject id');
  session.bootstrapDraining = false;   // the fixture's gate, not the strand, is released here
  return { session, strand, response, hook };
}
function injects(ws) { return ws.frames.filter(frame => frame.type === 'inject'); }
function inspectionContext(sessions, execFileSync) {
  const { createSessionInspectionContext } = load('src/routes/session-inspection.js');
  return createSessionInspectionContext({ sessions, submitViaPty: H.runtime.submitViaPty,
    SUBMIT_STRATEGIES: { claude: 'pty_cr', stable: 'osascript_cmd_enter' } }, { execFileSync });
}

test('D1 happy path: a real strand is removed once, and the answer names exactly the record that was removed', { timeout: 30000 }, async () => {
  const { session, strand } = await strandByDelivery('c1270-d1-happy');
  H.setPersist(() => ({ ok: true }));
  const audits = H.auditLines.length; const events = H.busEvents.length;
  const answer = invokeClear(H.clearReq(session.id, H.clearBody(session)));
  assert.deepEqual([answer.status, answer.body.stage, answer.body.reason], [200, 'cleared', null],
    `CHECKPOINT: 200 cleared with no reason ${JSON.stringify(answer.body)}`);
  assertClosedResult(answer.body, session.id);
  assert.deepEqual({ inject: answer.body.cleared_inject_id, reason: answer.body.cleared_strand_reason,
    at: answer.body.cleared_strand_at, basis: answer.body.basis, evidence: answer.body.child_evidence,
    bridge: answer.body.bridge_strand, persisted: answer.body.persisted, persistReason: answer.body.persist_reason },
  { inject: strand.inject_id, reason: strand.reason, at: strand.at, basis: 'composer_emptied_by_operator',
    evidence: 'same_child', bridge: 'not_observable_by_daemon', persisted: true, persistReason: null },
  `CHECKPOINT: the cleared_* fields come from the REMOVED record, and the basis is echoed ${JSON.stringify(answer.body)}`);
  assert.deepEqual({ epoch: answer.body.session_epoch, generation: answer.body.owner_generation },
    { epoch: session.sessionEpoch, generation: session.interactionOwnerGeneration },
    'CHECKPOINT: the daemon\'s OWN current identity is reported, never the request\'s');
  assert.equal(session.strandedComposer, undefined,
    'CHECKPOINT: the record is gone from the session — one synchronous in-memory deletion');
  assert.equal(runtimeModule.strandedComposer(session), null, 'CHECKPOINT: and the instance is no longer stranded');
  assert.equal(H.persistCalls.length > 0, true, 'CHECKPOINT: the save was attempted');
  assert.deepEqual([H.auditLines.length - audits, H.busEvents.length - events], [1, 1],
    'CHECKPOINT: exactly one audit line and one bus event for the clear');
});

test('D2 the gates reopen: after the clear all seven producers admit input again, and only after it', { timeout: 30000 }, async () => {
  const { session } = await strandByDelivery('c1270-d2-gates');
  // Before: every producer the strand exists for refuses. These are the gates the clear is FOR.
  assert.ok(runtimeModule.strandedComposer(session), 'PRECONDITION: stranded');
  assert.equal(runtimeModule.strandedInputFailure(session).code, 'COMPOSER_STRANDED', 'PRECONDITION: the shared refusal fires');
  assert.equal(H.runtime.boundAdmissionRefusal(session), 'composer_stranded', 'PRECONDITION: the bound door refuses');
  assert.equal(H.runtime.submitViaPty(session), false, 'PRECONDITION: every bare CR is refused');
  assert.equal(wsTransport.viewerInputDeliverer(session), null, 'PRECONDITION: viewer input has no writer');
  const osaSid = 'c1270-d2-osa';
  const osa = { id: osaSid, type: 'wrapped', command: 'stable', cwd: '/tmp/c1270',
    sessionEpoch: 'osa-epoch-d2', clients: new Set(), ownerWs: { readyState: 1, frames: [], send() {} },
    interactionOwnerGeneration: crypto.randomUUID() };
  const osaStrand = runtimeModule.strandComposer(osa, { epoch: 'osa-epoch-d2', injectId: crypto.randomUUID(),
    reason: 'cr_outcome_unknown' });
  const calls = [];
  const localSessions = Object.create(null);
  localSessions[osaSid] = osa;
  const { submitViaOsascript, runSubmitAll } = inspectionContext(localSessions,
    (file, args) => { calls.push({ file, args }); return Buffer.from('ok:window'); });
  assert.equal(submitViaOsascript(osaSid, 'cmd_enter'), false, 'PRECONDITION: the GUI arm refuses a stranded identity');
  assert.deepEqual(runSubmitAll(localSessions).failed.map(entry => entry.code), ['COMPOSER_STRANDED'],
    'PRECONDITION: and so does the batch submit');
  const legacyBefore = await H.deliverInjectionToSession(session.id, session, 'c1270-d2 legacy', { from: 'fixture-sender' });
  assert.deepEqual([legacyBefore.success, legacyBefore.code], [false, 'COMPOSER_STRANDED'],
    'PRECONDITION: the legacy inject door refuses at the door');

  H.setPersist(() => ({ ok: true }));
  const answer = invokeClear(H.clearReq(session.id, H.clearBody(session)));
  assert.equal(answer.body.stage, 'cleared', `PRECONDITION: the clear succeeded ${JSON.stringify(answer.body)}`);
  const osaAnswer = invokeClear(H.clearReq(osaSid, { schema: REQUEST_SCHEMA, from: 'E-operator',
    expected_epoch: 'osa-epoch-d2', expected_owner_generation: osa.interactionOwnerGeneration,
    stranded_inject_id: osaStrand.inject_id, basis: 'composer_emptied_by_operator' }));
  assert.equal(osaAnswer.body.stage, 'cleared', `PRECONDITION: the GUI-strategy record was cleared too ${JSON.stringify(osaAnswer.body)}`);

  assert.equal(runtimeModule.strandedComposer(session), null, 'CHECKPOINT: 1/7 the strand boundary is clear');
  assert.equal(runtimeModule.strandedInputFailure(session), null, 'CHECKPOINT: 2/7 the shared input refusal is gone');
  assert.equal(H.runtime.boundAdmissionRefusal(session), null,
    `CHECKPOINT: 3/7 the bound door admits again (${H.runtime.boundAdmissionRefusal(session)})`);
  assert.equal(H.runtime.submitViaPty(session), true, 'CHECKPOINT: 4/7 the shared CR boundary writes again');
  assert.equal(typeof wsTransport.viewerInputDeliverer(session), 'function', 'CHECKPOINT: 5/7 viewer input has a writer again');
  assert.equal(submitViaOsascript(osaSid, 'cmd_enter'), true, 'CHECKPOINT: 6/7 the GUI arm presses Return again');
  assert.deepEqual(runSubmitAll(localSessions).failed.map(entry => entry.code), [],
    'CHECKPOINT: 7/7 the batch submit no longer reports COMPOSER_STRANDED');
  const legacyAfter = await H.deliverInjectionToSession(session.id, session, 'c1270-d2 legacy after', { from: 'fixture-sender' });
  assert.notEqual(legacyAfter.code, 'COMPOSER_STRANDED',
    `CHECKPOINT: and the legacy door no longer refuses at the door ${JSON.stringify(legacyAfter)}`);
});

test('D3 nothing else moved: the clear touches no queue, no custody, no socket and no timer', { timeout: 30000 }, async () => {
  const { session } = await strandByDelivery('c1270-d3-untouched');
  session.bootstrapQueue = [{ type: 'inject', op_id: 'op-1', prompt: 'queued work', injectId: crypto.randomUUID(),
    queued_at: new Date().toISOString() }];
  session.lastInjectFrom = 'fixture-sender';
  const foreign = new Promise(() => {});
  session.pendingSubmit = foreign;
  const before = {
    frames: injects(session.ownerWs).length,
    custody: session.bodyCustody instanceof Map ? session.bodyCustody.size : 0,
    queue: JSON.stringify(session.bootstrapQueue),
    readiness: JSON.stringify(session.transportReadiness),
    pairs: JSON.stringify(session.submitPairs === undefined ? null : session.submitPairs),
    from: session.lastInjectFrom, ready: session.ready, activity: session.lastActivityAt,
    owner: session.ownerWs, generation: session.interactionOwnerGeneration, epoch: session.sessionEpoch,
  };
  H.setPersist(() => ({ ok: true }));
  const answer = invokeClear(H.clearReq(session.id, H.clearBody(session)));
  assert.equal(answer.body.stage, 'cleared', `PRECONDITION: the clear succeeded ${JSON.stringify(answer.body)}`);
  assert.deepEqual({
    frames: injects(session.ownerWs).length,
    custody: session.bodyCustody instanceof Map ? session.bodyCustody.size : 0,
    queue: JSON.stringify(session.bootstrapQueue),
    readiness: JSON.stringify(session.transportReadiness),
    pairs: JSON.stringify(session.submitPairs === undefined ? null : session.submitPairs),
    from: session.lastInjectFrom, ready: session.ready, activity: session.lastActivityAt,
    owner: session.ownerWs, generation: session.interactionOwnerGeneration, epoch: session.sessionEpoch,
  }, before, 'CHECKPOINT: every other field of the session is byte-identical after the clear');
  assert.equal(session.pendingSubmit, foreign, 'CHECKPOINT: a foreign submit barrier is left exactly where it was');
  assert.equal(answer.body.pending_bootstrap_ops, 1,
    `CHECKPOINT: the queued op is REPORTED, never dropped ${JSON.stringify(answer.body)}`);
  assert.equal(answer.body.body_custody, before.custody, 'CHECKPOINT: and body custody is reported, not settled');
  session.pendingSubmit = null;
  session.bootstrapQueue = [];
});

test('D4 unknown id: an id this daemon does not hold is 404, including every prototype key', () => {
  for (const sid of ['c1270-no-such-session', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const body = { schema: REQUEST_SCHEMA, from: 'E-operator', expected_epoch: 'E1',
      expected_owner_generation: 'G1', stranded_inject_id: null, basis: 'composer_emptied_by_operator' };
    const audits = H.auditLines.length;
    const answer = invokeClear(H.clearReq(sid, body));
    assertRefusal(null, null, answer, 'session_not_found', { beforeStep4: true, sid });
    assert.equal(H.auditLines.length - audits, 0,
      `CHECKPOINT: a request naming a session that does not exist appends nothing to the log (${sid})`);
  }
  // An invalid TARGET SHAPE is a different refusal, and it is decided before the lookup.
  for (const sid of ['', 'x'.repeat(257), 'E\u0000target', 42, null]) {
    const answer = invokeClear(H.clearReq(sid, { schema: REQUEST_SCHEMA, from: 'E-operator', expected_epoch: 'E1',
      expected_owner_generation: 'G1', stranded_inject_id: null, basis: 'composer_emptied_by_operator' }));
    assert.deepEqual([answer.status, answer.body.stage, answer.body.reason], [400, 'refused', 'clear_target_invalid'],
      `CHECKPOINT: ${JSON.stringify(sid)} is a target-shape refusal ${JSON.stringify(answer.body)}`);
  }
});

test('D5/D6/D7 state: a closing record, an active cooperative handoff and a non-wrapped transport are each refused 409', () => {
  const closing = H.strandedFixture('c1270-d5-closing');
  const closingBody = H.clearBody(closing.session);
  closing.session.isClosing = true;
  assertRefusal(closing.session, closing.strand, invokeClear(H.clearReq(closing.session.id, closingBody)), 'session_closing');
  delete closing.session.isClosing;

  const handoff = H.strandedFixture('c1270-d6-handoff');
  handoff.session.cooperativeHandoff = { id: crypto.randomUUID(), state: 'pending' };
  assert.equal(cooperativeHandoff.activeHandoff(handoff.session), true,
    'PRECONDITION: the real predicate reports an active handoff');
  assertRefusal(handoff.session, handoff.strand, invokeClear(H.clearReq(handoff.session.id, H.clearBody(handoff.session))),
    'handoff_active');
  handoff.session.cooperativeHandoff = { id: handoff.session.cooperativeHandoff.id, state: 'committed' };
  assert.equal(cooperativeHandoff.activeHandoff(handoff.session), false, 'PRECONDITION: a committed handoff is not active');

  // Three records with no owner bridge to clear a composer for.
  const epoch = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  for (const [label, overrides] of Object.entries({
    mailbox: { type: 'mailbox' }, spawned: { type: 'spawned' }, 'ssh remote': { type: 'wrapped', sshRemote: { host: 'h' } },
  })) {
    const sid = `c1270-d7-${label.replace(/\s/g, '-')}`;
    const session = { id: sid, command: 'claude', clients: new Set(), ownerWs: { readyState: 1, frames: [], send() {} },
      sessionEpoch: epoch, interactionOwnerGeneration: 'GEN-D7', outputRing: [], outputRingTotalBytes: 0,
      createdAt: nowIso, lastActivityAt: nowIso, ...overrides };
    H.sessions[sid] = session;
    const strand = runtimeModule.strandComposer(session, { epoch, injectId: crypto.randomUUID(), reason: 'submit_outcome_unknown' });
    const answer = invokeClear(H.clearReq(sid, { schema: REQUEST_SCHEMA, from: 'E-operator', expected_epoch: epoch,
      expected_owner_generation: 'GEN-D7', stranded_inject_id: strand.inject_id, basis: 'composer_emptied_by_operator' }));
    assertRefusal(session, strand, answer, 'transport_not_applicable');
    delete H.sessions[sid];
  }
});

test('D8/D9 not stranded: a healthy session and an INERT record of a superseded epoch are both not_stranded, and neither is removed', () => {
  const session = H.registerSession('c1270-d8-healthy');
  const body = H.clearBody(session, { stranded_inject_id: crypto.randomUUID() });
  const answer = invokeClear(H.clearReq(session.id, body));
  assert.deepEqual([answer.status, answer.body.stage, answer.body.reason], [409, 'refused', 'not_stranded'],
    `CHECKPOINT: a session with nothing to clear is refused ${JSON.stringify(answer.body)}`);
  assertClosedResult(answer.body, session.id);
  assert.deepEqual({ inject: answer.body.cleared_inject_id, reason: answer.body.cleared_strand_reason,
    at: answer.body.cleared_strand_at }, { inject: null, reason: null, at: null },
  'CHECKPOINT: with every cleared_* field null');
  assert.deepEqual({ epoch: answer.body.session_epoch, generation: answer.body.owner_generation },
    { epoch: session.sessionEpoch, generation: session.interactionOwnerGeneration },
    'CHECKPOINT: a step-4 answer DOES name the daemon\'s current identity');
  assert.equal(session.strandedComposer, undefined, 'CHECKPOINT: and nothing was invented on the record');

  // D9 — a record whose epoch has been superseded is already inert: `strandedComposer` returns null, so the
  // clear refuses at 4.5 and, crucially, does NOT remove the record (a later restore of that epoch must still
  // find it). This is the frozen order of §5: 4.5 is decided before the epoch comparison at 4.6.
  const superseded = H.strandedFixture('c1270-d9-superseded');
  const oldEpoch = superseded.session.sessionEpoch;
  const pinned = H.clearBody(superseded.session);
  superseded.session.sessionEpoch = crypto.randomUUID();
  assert.equal(runtimeModule.strandedComposer(superseded.session), null, 'PRECONDITION: the record is inert for the new epoch');
  const stale = invokeClear(H.clearReq(superseded.session.id, pinned));
  assert.deepEqual([stale.status, stale.body.reason], [409, 'not_stranded'],
    `CHECKPOINT: an inert record is not_stranded, not epoch_mismatch — 4.5 precedes 4.6 ${JSON.stringify(stale.body)}`);
  assert.equal(superseded.session.strandedComposer, superseded.strand,
    'CHECKPOINT: the inert record is still present — the clear removed nothing it was not pinned to');
  superseded.session.sessionEpoch = oldEpoch;
  assert.ok(runtimeModule.strandedComposer(superseded.session),
    'CHECKPOINT: and the old instance is still stranded, exactly as before the attempt');
});

test('D10/D11/D12/D13 identity: a wrong epoch, an absent or wrong generation and a disconnected owner are each refused 409', () => {
  const epochCase = H.strandedFixture('c1270-d10-epoch');
  assertRefusal(epochCase.session, epochCase.strand,
    invokeClear(H.clearReq(epochCase.session.id, H.clearBody(epochCase.session, { expected_epoch: crypto.randomUUID() }))),
    'epoch_mismatch');

  // D11 — a restored session that was never re-claimed has no owner generation at all. The body still carries a
  // well-formed token (otherwise step 2 would answer first), so this is the daemon's own state being reported.
  const absent = H.strandedFixture('c1270-d11-generation-absent');
  const absentBody = H.clearBody(absent.session);
  delete absent.session.interactionOwnerGeneration;
  assertRefusal(absent.session, absent.strand, invokeClear(H.clearReq(absent.session.id, absentBody)),
    'owner_generation_unavailable');
  for (const value of [null, 42, '', {}]) {
    absent.session.interactionOwnerGeneration = value;
    assertRefusal(absent.session, absent.strand, invokeClear(H.clearReq(absent.session.id, absentBody)),
      'owner_generation_unavailable');
  }

  const wrong = H.strandedFixture('c1270-d12-generation-wrong');
  assertRefusal(wrong.session, wrong.strand,
    invokeClear(H.clearReq(wrong.session.id, H.clearBody(wrong.session, { expected_owner_generation: crypto.randomUUID() }))),
    'owner_generation_mismatch');

  // D13 — the owner that holds the composer is gone: there is nobody whose composer this would be.
  const disconnected = H.strandedFixture('c1270-d13-owner-gone');
  const disconnectedBody = H.clearBody(disconnected.session);
  disconnected.session.ownerWs.readyState = 3;
  assert.equal(isOpenWebSocket(disconnected.session.ownerWs), false, 'PRECONDITION: the owner socket is closed');
  assertRefusal(disconnected.session, disconnected.strand,
    invokeClear(H.clearReq(disconnected.session.id, disconnectedBody)), 'owner_disconnected');
});

test('D14 inject id: a wrong, absent, surplus or case-folded stranded_inject_id is a mismatch, never an equivalence', () => {
  const withId = H.strandedFixture('c1270-d14-with-id');
  const stored = withId.strand.inject_id;
  assert.ok(UUID.test(String(stored)), `PRECONDITION: the stored id is a lowercase uuid (${stored})`);
  for (const [label, value] of Object.entries({
    'a different id': crypto.randomUUID(),
    'null against a non-null record': null,
    'the same id upper-cased': String(stored).toUpperCase(),
  })) {
    assertRefusal(withId.session, withId.strand,
      invokeClear(H.clearReq(withId.session.id, H.clearBody(withId.session, { stranded_inject_id: value }))),
      'stranded_inject_id_mismatch');
    assert.equal(withId.session.strandedComposer, withId.strand,
      `CHECKPOINT: ${label} removed nothing — the comparison is strict ===, with no case folding or regex equivalence`);
  }
  // The mirror: a non-null id against a record that has none. `null === null` is the only match for that record.
  const withoutId = H.strandedFixture('c1270-d14-without-id', { injectId: null });
  assert.equal(withoutId.strand.inject_id, null, 'PRECONDITION: the record has no inject id');
  assertRefusal(withoutId.session, withoutId.strand,
    invokeClear(H.clearReq(withoutId.session.id, H.clearBody(withoutId.session, { stranded_inject_id: crypto.randomUUID() }))),
    'stranded_inject_id_mismatch');
  H.setPersist(() => ({ ok: true }));
  const matched = invokeClear(H.clearReq(withoutId.session.id, H.clearBody(withoutId.session)));
  assert.deepEqual([matched.status, matched.body.stage, matched.body.cleared_inject_id], [200, 'cleared', null],
    `CHECKPOINT: null === null IS the match for an id-less record ${JSON.stringify(matched.body)}`);
});

test('D15/D16/D17/D18 basis: child_replaced_observed is CHECKED, and only an accepted new milestone corroborates it', () => {
  // D15 — the child is demonstrably the same one: the claim contradicts the daemon's own observation.
  const observedChild = observedChildFn('the checkable basis');
  const same = H.strandedFixture('c1270-d15-same-child');
  assert.deepEqual(same.strand.child, { child_seq: 1, pid: 4242 },
    'CHECKPOINT: the strand must record the child it was typed into, or no basis can be checked against it (A6)');
  assertRefusal(same.session, same.strand,
    invokeClear(H.clearReq(same.session.id, H.clearBody(same.session, { basis: 'child_replaced_observed' }))),
    'basis_contradicted');

  // D16 — a REAL accepted process_started for a new child: now the claim is corroborated.
  const replaced = H.strandedFixture('c1270-d16-replaced');
  const accepted = H.milestone(replaced.session, { type: 'process_started', childSeq: 2, pid: 222 });
  assert.equal(accepted.ok, true, `PRECONDITION: the new milestone was accepted ${JSON.stringify(accepted)}`);
  assert.deepEqual(observedChild(replaced.session), { child_seq: 2, pid: 222 },
    'PRECONDITION: the daemon now observes a different child');
  H.setPersist(() => ({ ok: true }));
  const answer = invokeClear(H.clearReq(replaced.session.id, H.clearBody(replaced.session, { basis: 'child_replaced_observed' })));
  assert.deepEqual([answer.status, answer.body.stage, answer.body.child_evidence, answer.body.basis],
    [200, 'cleared', 'replaced', 'child_replaced_observed'],
    `CHECKPOINT: a corroborated replacement clears and says so ${JSON.stringify(answer.body)}`);

  // D17 — a REFUSED milestone frame has no effect at all, so it cannot corroborate anything.
  const refusedFrame = H.strandedFixture('c1270-d17-refused-frame');
  const wrongNonce = H.milestone(refusedFrame.session, { type: 'process_started', childSeq: 3, pid: 333, nonce: 'z'.repeat(22) });
  const staleSeq = H.milestone(refusedFrame.session, { type: 'process_started', childSeq: 1, pid: 444 });
  assert.deepEqual([wrongNonce.ok, staleSeq.ok], [false, false],
    `PRECONDITION: both frames were refused ${JSON.stringify([wrongNonce, staleSeq])}`);
  assert.deepEqual(observedChild(refusedFrame.session), { child_seq: 1, pid: 4242 },
    'PRECONDITION: the observed child is unchanged by a refused frame');
  assertRefusal(refusedFrame.session, refusedFrame.strand,
    invokeClear(H.clearReq(refusedFrame.session.id, H.clearBody(refusedFrame.session, { basis: 'child_replaced_observed' }))),
    'basis_contradicted');

  // D18 — a legacy bridge announces no milestone at all: the operator basis still works, the checkable one cannot.
  const legacy = H.strandedFixture('c1270-d18-legacy', { options: { capable: false, header: '' } });
  assert.equal(observedChild(legacy.session), null,
    'CHECKPOINT: a legacy bridge announces no milestone, so there is no observed child');
  assert.equal(legacy.strand.child, null, 'CHECKPOINT: and the strand recorded none for it');
  assertRefusal(legacy.session, legacy.strand,
    invokeClear(H.clearReq(legacy.session.id, H.clearBody(legacy.session, { basis: 'child_replaced_observed' }))),
    'basis_contradicted');
  H.setPersist(() => ({ ok: true }));
  const operator = invokeClear(H.clearReq(legacy.session.id, H.clearBody(legacy.session)));
  assert.deepEqual([operator.status, operator.body.stage, operator.body.child_evidence],
    [200, 'cleared', 'unobservable'],
    `CHECKPOINT: a legacy bridge is clearable on the operator's own assertion, reported as unobservable ${JSON.stringify(operator.body)}`);
});

test('D19/D20 persistence: a failed, a throwing and an absent save are reported — and never roll the clear back', () => {
  const failing = H.strandedFixture('c1270-d19-save-fails');
  H.setPersist(() => ({ ok: false }));
  const failed = invokeClear(H.clearReq(failing.session.id, H.clearBody(failing.session)));
  assert.deepEqual([failed.status, failed.body.stage, failed.body.persisted, failed.body.persist_reason],
    [200, 'cleared', false, 'session_store_write_failed'],
    `CHECKPOINT: a failed save is REPORTED on a cleared answer ${JSON.stringify(failed.body)}`);
  assert.equal(failing.session.strandedComposer, undefined,
    'CHECKPOINT: the in-memory clear is NOT rolled back — the operator is told the truth instead');

  const throwing = H.strandedFixture('c1270-d19-save-throws');
  H.setPersist(() => { throw new Error('ENOSPC: no space left on device, open \'/home/op/.config/sessions.json\''); });
  const threw = invokeClear(H.clearReq(throwing.session.id, H.clearBody(throwing.session)));
  assert.deepEqual([threw.status, threw.body.stage, threw.body.persisted, threw.body.persist_reason],
    [200, 'cleared', false, 'session_store_write_threw'],
    `CHECKPOINT: a THROWING save cannot throw into the handler ${JSON.stringify(threw.body)}`);
  assert.equal(JSON.stringify(threw.body).includes('/home/op'), false,
    'CHECKPOINT: and no host path from the exception reaches the caller');
  assert.equal(throwing.session.strandedComposer, undefined, 'CHECKPOINT: the clear still happened');

  // D20 — a composition with NO persistSessions seam at all: still a clear, still honest, still no throw.
  const none = H.strandedFixture('c1270-d20-no-seam');
  const withoutSeam = H.makeClear({ persistSessions: undefined });
  assert.equal(typeof withoutSeam.handler, 'function',
    'CHECKPOINT: the route is registrable without a persistence seam');
  const answer = invokeClear(H.clearReq(none.session.id, H.clearBody(none.session)), { handler: withoutSeam.handler });
  assert.deepEqual([answer.status, answer.body.stage, answer.body.persisted],
    [200, 'cleared', false], `CHECKPOINT: no seam means persisted:false, never a claim ${JSON.stringify(answer.body)}`);
  assert.ok(answer.body.persist_reason === null || CODE.test(answer.body.persist_reason),
    `CHECKPOINT: with a bounded persist_reason ${JSON.stringify(answer.body.persist_reason)}`);
  H.setPersist(() => ({ ok: true }));
});

test('D21 no 5xx: a throwing session getter is answered in the closed shape, and no input of B/C/D is ever a 5xx', () => {
  const sid = 'c1270-d21-throwing-getter';
  const session = H.registerSession(sid);
  const strand = runtimeModule.strandComposer(session, { epoch: session.sessionEpoch,
    injectId: crypto.randomUUID(), reason: 'submit_outcome_unknown' });
  const body = H.clearBody(session);
  Object.defineProperty(session, 'bootstrapQueue', {
    configurable: true, get() { throw new Error('bootstrapQueue getter exploded'); } });
  H.setPersist(() => ({ ok: true }));
  const answer = invokeClear(H.clearReq(sid, body));
  assert.ok(answer.status < 500,
    `CHECKPOINT: no 5xx exists on this route, even when reading the session throws (${answer.status})`);
  assertClosedResult(answer.body, sid);
  assert.ok(['cleared', 'refused'].includes(answer.body.stage),
    `CHECKPOINT: the answer is one of the two stages ${JSON.stringify(answer.body)}`);
  if (answer.body.stage === 'refused') {
    assert.equal(answer.status, 409, 'CHECKPOINT: a caught exception is answered 409 refused');
    assert.equal(answer.body.reason, 'refused', 'CHECKPOINT: with the generic bounded code, carrying no exception text');
    assert.equal(session.strandedComposer, strand, 'CHECKPOINT: and the refusal means the record is still there');
  }
  Object.defineProperty(session, 'bootstrapQueue', { configurable: true, writable: true, value: [] });

  // The sweep: one request of every refusal class, plus a clear, and not one of them is a 5xx.
  const sweepTargets = [
    ['remote peer', H.strandedFixture('c1270-d21-sweep-a'), { socket: { remoteAddress: '203.0.113.9' } }, null],
    ['origin', H.strandedFixture('c1270-d21-sweep-b'), { headers: { origin: 'http://evil.test' } }, null],
    ['content type', H.strandedFixture('c1270-d21-sweep-c'), { headers: { 'content-type': 'text/plain' } }, null],
    ['raw body', H.strandedFixture('c1270-d21-sweep-d'), { principalRawBody: Buffer.alloc(0) }, null],
    ['token', H.strandedFixture('c1270-d21-sweep-e'), { dropHeaders: ['x-telepty-token'] }, null],
    ['schema', H.strandedFixture('c1270-d21-sweep-f'), {}, { schema: 'telepty.clear-strand/v2' }],
    ['basis', H.strandedFixture('c1270-d21-sweep-g'), {}, { basis: 'force' }],
    ['epoch', H.strandedFixture('c1270-d21-sweep-h'), {}, { expected_epoch: crypto.randomUUID() }],
    ['inject id', H.strandedFixture('c1270-d21-sweep-i'), {}, { stranded_inject_id: crypto.randomUUID() }],
    ['cleared', H.strandedFixture('c1270-d21-sweep-j'), {}, {}],
  ];
  for (const [label, fixture, options, overrides] of sweepTargets) {
    const answerSweep = invokeClear(H.clearReq(fixture.session.id,
      H.clearBody(fixture.session, overrides || {}), options));
    assert.ok(answerSweep.status >= 200 && answerSweep.status < 500,
      `CHECKPOINT: ${label} is answered 2xx/4xx (${answerSweep.status})`);
    assertClosedResult(answerSweep.body, fixture.session.id);
  }
});

test('D22 closed result: every answer carries the frozen key set, and identity is null before the target is known', () => {
  const { session } = H.strandedFixture('c1270-d22-closed');
  const body = H.clearBody(session);
  const beforeStep4 = [
    ['clear_local_only', { socket: { remoteAddress: '203.0.113.10' } }, body],
    ['clear_origin_refused', { headers: { origin: 'http://evil.test' } }, body],
    ['clear_content_type', { headers: { 'content-type': 'text/plain' } }, body],
    ['clear_body_bytes', { principalRawBody: Buffer.alloc(0) }, body],
    ['clear_auth_required', { dropHeaders: ['x-telepty-token'] }, body],
    ['request_keys', {}, { ...body, extra: 1 }],
    ['basis_invalid', {}, { ...body, basis: 'force' }],
  ];
  for (const [reason, options, requestBody] of beforeStep4) {
    const answer = invokeClear(H.clearReq(session.id, requestBody, options));
    assert.equal(answer.body.reason, reason, `PRECONDITION: the row produces ${reason} ${JSON.stringify(answer.body)}`);
    assertClosedResult(answer.body, session.id, { beforeStep4: true });
  }
  // From step 4 on, the identity IS reported — the daemon's own, never the request's.
  const fromStep4 = invokeClear(H.clearReq(session.id, { ...body, expected_epoch: crypto.randomUUID() }));
  assert.deepEqual({ reason: fromStep4.body.reason, epoch: fromStep4.body.session_epoch,
    generation: fromStep4.body.owner_generation, basis: fromStep4.body.basis },
  { reason: 'epoch_mismatch', epoch: session.sessionEpoch, generation: session.interactionOwnerGeneration,
    basis: 'composer_emptied_by_operator' },
  `CHECKPOINT: a step-4 refusal names the daemon's identity and echoes the validated basis ${JSON.stringify(fromStep4.body)}`);
  assertClosedResult(fromStep4.body, session.id);
});

// ── Part 5: RED-E — races, replay and the wrongful clear (the cases that matter most) ─────────────────────────

test('E1 clear mid-pair: a clear issued between a body and its CR cannot un-strand the pair being handed', { timeout: 30000 }, async () => {
  const sid = 'c1270-e1-mid-pair';
  // The handler is resolved BEFORE the delivery runs. Inside the owner-WS hook below, an assertion failure
  // would be swallowed by the delivery's own try/catch (it would be reported as a throwing socket), so the
  // absence of the route is asserted here, where it can fail as itself, and any error raised inside the hook is
  // carried out and re-thrown verbatim afterwards.
  const handler = clearHandler('the mid-pair clear');
  const observed = { answer: null, error: null };
  const hook = { session: null };
  const session = H.registerSession(sid, { onSend: (ws, frame) => {
    if (frame.part !== 'body' || !hook.session) return;
    // Exactly the window a preflight-only check misses: the body has been handed, the CR has not, and no strand
    // record exists yet. A clear issued here must not be able to declare the composer clean.
    try {
      observed.answer = invokeClear(H.clearReq(sid, H.clearBody(hook.session, { stranded_inject_id: null })),
        { handler, what: 'the mid-pair clear' });
    } catch (error) {
      observed.error = error;
    }
    hook.session.bootstrapDraining = true;   // and the CR that follows cannot be handed
  } });
  hook.session = session;
  H.sessionStateManager.feed(sid, WORKING);
  const response = await H.call(BOUND_ROUTE_KEY, sid, boundRequest(session, 'c1270-e1 unsubmitted text'));
  session.bootstrapDraining = false;
  if (observed.error) throw observed.error;   // the real assertion, not a precondition about the harness
  assert.ok(observed.answer, 'PRECONDITION: the clear really ran inside the delivery\'s own write');
  assert.deepEqual([observed.answer.status, observed.answer.body.stage, observed.answer.body.reason],
    [409, 'refused', 'not_stranded'],
    `CHECKPOINT: at that instant there is no strand to clear, so the clear refuses ${JSON.stringify(observed.answer.body)}`);
  assert.equal(observed.answer.body.cleared_inject_id, null, 'CHECKPOINT: and it claims to have removed nothing');
  assert.equal(response.body.stage, 'outcome_unknown',
    `PRECONDITION: the delivery still ends as an honest unknown ${JSON.stringify(response.body)}`);
  const strand = runtimeModule.strandedComposer(session);
  assert.ok(strand, 'CHECKPOINT: the FINAL state is stranded — the mid-flight clear did not pre-empt the strand');
  assert.equal(strand.inject_id, response.body.inject_id, 'CHECKPOINT: and it names the delivery that lost its CR');
  assert.deepEqual(injects(session.ownerWs).map(frame => frame.part), ['body'],
    'CHECKPOINT: exactly one frame reached the owner — the clear added no Enter');
});

test('E2 clear while the delivery unwinds: the clear succeeds, the delivery stays unknown, and the strand does not reappear', { timeout: 30000 }, async () => {
  const { session, response, strand } = await strandByDelivery('c1270-e2-unwinding');
  H.setPersist(() => ({ ok: true }));
  // No sleep between the delivery's answer and the clear: the delivery's own continuations have not all run.
  const answer = invokeClear(H.clearReq(session.id, H.clearBody(session)));
  assert.deepEqual([answer.status, answer.body.stage, answer.body.cleared_inject_id],
    [200, 'cleared', strand.inject_id], `CHECKPOINT: the clear removes the record it was pinned to ${JSON.stringify(answer.body)}`);
  assert.deepEqual({ stage: response.body.stage, inject: response.body.inject_id },
    { stage: 'outcome_unknown', inject: strand.inject_id },
    'CHECKPOINT: the delivery\'s own answer is unchanged — a clear never converts an unknown into a success');
  await sleep(300);
  assert.equal(runtimeModule.strandedComposer(session), null,
    'CHECKPOINT: and nothing in the delivery\'s unwinding re-created the strand');
  assert.deepEqual(injects(session.ownerWs).map(frame => frame.part), ['body'],
    'CHECKPOINT: still exactly one frame — no late CR was released by the clear');
});

test('E3 a second delivery after a clear: it is admitted, and a new loss strands a NEW inject id', { timeout: 30000 }, async () => {
  const { session, strand: first } = await strandByDelivery('c1270-e3-second');
  H.setPersist(() => ({ ok: true }));
  const firstBody = H.clearBody(session);
  const cleared = invokeClear(H.clearReq(session.id, firstBody));
  assert.equal(cleared.body.stage, 'cleared', `PRECONDITION: the first strand was cleared ${JSON.stringify(cleared.body)}`);
  assert.notEqual(H.runtime.boundAdmissionRefusal(session), 'composer_stranded',
    'CHECKPOINT: the bound door no longer refuses this instance for a stranded composer');
  assert.equal(H.runtime.boundAdmissionRefusal(session), null,
    `PRECONDITION: and nothing else is holding the door ${H.runtime.boundAdmissionRefusal(session)}`);

  const second = await H.call(BOUND_ROUTE_KEY, session.id, boundRequest(session, 'c1270-e3 second unsubmitted text'));
  session.bootstrapDraining = false;
  assert.equal(second.body.stage, 'outcome_unknown',
    `CHECKPOINT: the second delivery was ADMITTED and lost its CR in its own right ${JSON.stringify(second.body)}`);
  const reStrand = runtimeModule.strandedComposer(session);
  assert.ok(reStrand, 'CHECKPOINT: the instance is stranded again — a clear is not immunity');
  assert.notEqual(reStrand.inject_id, first.inject_id, 'CHECKPOINT: with a NEW inject id');
  assert.equal(reStrand.inject_id, second.body.inject_id, 'CHECKPOINT: the second delivery\'s own id');
  const replayed = invokeClear(H.clearReq(session.id, firstBody));
  assert.deepEqual([replayed.status, replayed.body.reason], [409, 'stranded_inject_id_mismatch'],
    `CHECKPOINT: the OLD clear body is now a mismatch — it cannot clear a strand it never saw ${JSON.stringify(replayed.body)}`);
  assert.equal(session.strandedComposer, reStrand, 'CHECKPOINT: and the new strand survives that attempt');
  const current = invokeClear(H.clearReq(session.id, H.clearBody(session)));
  assert.equal(current.body.stage, 'cleared', `CHECKPOINT: the body naming the NEW id clears it ${JSON.stringify(current.body)}`);
});

test('E4 replay: the identical valid body twice clears once and then refuses — the result is deliberately not idempotent', () => {
  const { session, strand } = H.strandedFixture('c1270-e4-replay');
  H.setPersist(() => ({ ok: true }));
  const body = H.clearBody(session);
  const req = () => H.clearReq(session.id, body);
  const first = invokeClear(req());
  assert.deepEqual([first.status, first.body.stage, first.body.cleared_inject_id], [200, 'cleared', strand.inject_id],
    `CHECKPOINT: the first POST clears ${JSON.stringify(first.body)}`);
  const second = invokeClear(req());
  assert.deepEqual([second.status, second.body.stage, second.body.reason], [409, 'refused', 'not_stranded'],
    `CHECKPOINT: the replay is refused, not silently re-confirmed ${JSON.stringify(second.body)}`);
  assert.deepEqual([second.body.cleared_inject_id, second.body.cleared_strand_reason, second.body.cleared_strand_at],
    [null, null, null], 'CHECKPOINT: and the replay claims no removal of its own');
  assert.equal(session.strandedComposer, undefined, 'CHECKPOINT: removed exactly once');
  const third = invokeClear(req());
  assert.equal(third.body.reason, 'not_stranded', 'CHECKPOINT: and every further replay says the same thing');
});

test('E5 reclaim between the view and the clear: the pinned generation is refused, the new one succeeds', () => {
  const { session, strand } = H.strandedFixture('c1270-e5-reclaim');
  const operatorRead = H.clearBody(session);   // what the operator read out of the view
  const newWs = H.ownerSocket();
  H.claimOwner(session, newWs, { supervised: true });
  H.negotiate(session, { capable: true, header: HEADER_BOUND });
  H.transportReady(session);
  assert.notEqual(session.interactionOwnerGeneration, operatorRead.expected_owner_generation,
    'PRECONDITION: the reclaim minted a new owner generation');
  assertRefusal(session, strand, invokeClear(H.clearReq(session.id, operatorRead)), 'owner_generation_mismatch');
  assert.ok(runtimeModule.strandedComposer(session),
    'CHECKPOINT: the strand survives a stale clear — it is the same child and the same composer');
  H.setPersist(() => ({ ok: true }));
  const fresh = invokeClear(H.clearReq(session.id, H.clearBody(session)));
  assert.deepEqual([fresh.status, fresh.body.stage, fresh.body.owner_generation],
    [200, 'cleared', session.interactionOwnerGeneration],
    `CHECKPOINT: a clear that pins the CURRENT generation succeeds ${JSON.stringify(fresh.body)}`);
});

test('E6 destroy/recreate ABA: a clear pinned to the old instance never touches the new one', () => {
  // (a) The recreated instance is a NEW composer with no strand: by the frozen order of §5 (4.5 before 4.6) the
  //     answer is `not_stranded`. TEST-PLAN E6 predicts `epoch_mismatch`, which is unreachable for an
  //     un-stranded record — the normative order decides it, and (b) below covers the epoch_mismatch reading.
  const { session, strand } = H.strandedFixture('c1270-e6-aba');
  const pinned = H.clearBody(session);
  const recreatedWs = H.ownerSocket();
  const recreated = { ...session, ownerWs: recreatedWs, clients: new Set([recreatedWs]),
    sessionEpoch: crypto.randomUUID(), interactionOwnerGeneration: crypto.randomUUID() };
  delete recreated.strandedComposer;
  H.sessions[session.id] = recreated;
  assert.notEqual(H.sessions[session.id], session, 'PRECONDITION: sessions[id] is a different object');
  const stale = invokeClear(H.clearReq(session.id, pinned));
  assert.deepEqual([stale.status, stale.body.reason], [409, 'not_stranded'],
    `CHECKPOINT: a clear pinned to the destroyed instance is refused ${JSON.stringify(stale.body)}`);
  assert.equal(recreated.strandedComposer, undefined,
    'CHECKPOINT: the new instance was never stranded, and nothing was cleared for it');
  assert.equal(runtimeModule.strandedInputFailure(recreated), null, 'CHECKPOINT: and it admits input, as it always did');

  // (b) The recreated instance has a strand of its OWN: now the stale epoch is what the answer names, and the
  //     new strand is not removed by a body that pinned the old one.
  const ownStrand = runtimeModule.strandComposer(recreated, { epoch: recreated.sessionEpoch,
    injectId: crypto.randomUUID(), reason: 'cr_outcome_unknown' });
  const mismatch = invokeClear(H.clearReq(session.id, pinned));
  assert.deepEqual([mismatch.status, mismatch.body.reason], [409, 'epoch_mismatch'],
    `CHECKPOINT: a live strand plus a stale pinned epoch is epoch_mismatch ${JSON.stringify(mismatch.body)}`);
  assert.equal(recreated.strandedComposer, ownStrand, 'CHECKPOINT: and the new instance\'s own strand survives');
  H.sessions[session.id] = session;   // leave the fixture's own record for dispose()
});

test('E7 two clears in one tick: exactly one clears and the other is refused', () => {
  const { session, strand } = H.strandedFixture('c1270-e7-concurrent');
  H.setPersist(() => ({ ok: true }));
  const body = H.clearBody(session);
  // The handler is synchronous, so "concurrent" is the strongest thing a caller can do: both requests are
  // issued before any microtask runs. One of them must lose.
  const answers = [invokeClear(H.clearReq(session.id, body)), invokeClear(H.clearReq(session.id, body))];
  const stages = answers.map(answer => answer.body.stage);
  assert.deepEqual(stages, ['cleared', 'refused'],
    `CHECKPOINT: one clear, one refusal ${JSON.stringify(answers.map(answer => answer.body))}`);
  assert.deepEqual(answers.map(answer => answer.status), [200, 409], 'CHECKPOINT: with their own statuses');
  assert.equal(answers[0].body.cleared_inject_id, strand.inject_id, 'CHECKPOINT: the winner names the removed record');
  assert.deepEqual([answers[1].body.reason, answers[1].body.cleared_inject_id], ['not_stranded', null],
    'CHECKPOINT: the loser removes nothing and claims nothing');
  assert.equal(session.strandedComposer, undefined, 'CHECKPOINT: the record was removed exactly once');
});

test('E8 clear vs restart: the reported persisted flag means what it says, in both directions', () => {
  const nowIso = new Date().toISOString();
  const build = sid => {
    const epoch = crypto.randomUUID();
    const session = { id: sid, type: 'wrapped', command: 'claude', cwd: '/tmp/c1270',
      sessionEpoch: epoch, sessionEpochProved: epoch, credentialVerifier: 'opaque-verifier', credentialGeneration: 1,
      interactionOwnerGeneration: crypto.randomUUID(), clients: new Set(),
      ownerWs: { readyState: 1, frames: [], send() {} }, createdAt: nowIso, lastActivityAt: nowIso,
      outputRing: [], outputRingTotalBytes: 0 };
    H.sessions[sid] = session;
    const strand = runtimeModule.strandComposer(session, { epoch, injectId: crypto.randomUUID(),
      reason: 'submit_outcome_unknown' });
    return { session, strand, preClear: persistence.serializePersistedSessions({ [sid]: session })[sid] };
  };
  const body = session => ({ schema: REQUEST_SCHEMA, from: 'E-operator', expected_epoch: session.sessionEpoch,
    expected_owner_generation: session.interactionOwnerGeneration,
    stranded_inject_id: runtimeModule.strandedComposer(session).inject_id, basis: 'composer_emptied_by_operator' });

  // persisted:true — the file the daemon would have written no longer carries the strand.
  const saved = build('c1270-e8-saved');
  assert.ok(saved.preClear.strandedComposer, 'PRECONDITION: the pre-clear bytes carry the strand');
  H.setPersist(() => ({ ok: true }));
  const savedAnswer = invokeClear(H.clearReq(saved.session.id, body(saved.session)));
  assert.deepEqual([savedAnswer.body.stage, savedAnswer.body.persisted], ['cleared', true],
    `PRECONDITION: cleared and persisted ${JSON.stringify(savedAnswer.body)}`);
  const afterSave = persistence.serializePersistedSessions({ [saved.session.id]: saved.session })[saved.session.id];
  assert.equal(afterSave.strandedComposer, undefined, 'CHECKPOINT: the post-clear bytes carry no strand');
  const restoredClean = persistence.buildRestoredWrappedSession(saved.session.id, afterSave);
  assert.equal(runtimeModule.strandedComposer(restoredClean), null,
    'CHECKPOINT: a restart after a persisted clear brings the instance back UN-stranded');

  // persisted:false — the clear stands in memory, and the operator is told the restart will undo it.
  const unsaved = build('c1270-e8-unsaved');
  H.setPersist(() => ({ ok: false }));
  const unsavedAnswer = invokeClear(H.clearReq(unsaved.session.id, body(unsaved.session)));
  assert.deepEqual([unsavedAnswer.body.stage, unsavedAnswer.body.persisted, unsavedAnswer.body.persist_reason],
    ['cleared', false, 'session_store_write_failed'], `PRECONDITION: cleared, not persisted ${JSON.stringify(unsavedAnswer.body)}`);
  assert.equal(runtimeModule.strandedComposer(unsaved.session), null, 'CHECKPOINT: in memory it IS cleared');
  const restoredStranded = persistence.buildRestoredWrappedSession(unsaved.session.id, unsaved.preClear);
  assert.ok(runtimeModule.strandedComposer(restoredStranded),
    'CHECKPOINT: but a restart from the un-updated file brings the strand back — which is exactly what persisted:false says');
  H.setPersist(() => ({ ok: true }));
  delete H.sessions['c1270-e8-saved'];
  delete H.sessions['c1270-e8-unsaved'];
});

test('E9 a hand-planted strand: the previously permanent denial is now recoverable', () => {
  const sid = 'c1270-e9-planted';
  const epoch = crypto.randomUUID();
  const injectId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  // The API-MAP §8 tampering case: an edited sessions.json whose strandedComposer.epoch equals its sessionEpoch.
  const meta = { id: sid, type: 'wrapped', command: 'claude', cwd: '/tmp/c1270', backend: null,
    sessionEpoch: epoch, credentialVerifier: 'opaque-verifier', credentialGeneration: 1,
    createdAt: nowIso, lastActivityAt: nowIso,
    strandedComposer: { epoch, inject_id: injectId, reason: 'submit_outcome_unknown', at: nowIso,
      owner_generation: 'GEN-PLANTED', child: { child_seq: 1, pid: 4242 } } };
  const session = persistence.buildRestoredWrappedSession(sid, meta);
  assert.ok(runtimeModule.strandedComposer(session), 'PRECONDITION: the planted record restores as a live strand');
  assert.equal(runtimeModule.strandedInputFailure(session).code, 'COMPOSER_STRANDED',
    'PRECONDITION: so every input path refuses this instance');
  // A restored session is proof-less until its bridge re-claims; the operator's clear needs a live owner.
  session.clients = session.clients instanceof Set ? session.clients : new Set();
  const ws = H.ownerSocket();
  H.claimOwner(session, ws, { supervised: false });
  H.sessions[sid] = session;
  H.setPersist(() => ({ ok: true }));
  const answer = invokeClear(H.clearReq(sid, { schema: REQUEST_SCHEMA, from: 'E-operator', expected_epoch: epoch,
    expected_owner_generation: session.interactionOwnerGeneration, stranded_inject_id: injectId,
    basis: 'composer_emptied_by_operator' }));
  assert.deepEqual([answer.status, answer.body.stage, answer.body.cleared_inject_id], [200, 'cleared', injectId],
    `CHECKPOINT: the operator can remove a restored strand — the denial is no longer permanent ${JSON.stringify(answer.body)}`);
  assert.equal(runtimeModule.strandedInputFailure(session), null, 'CHECKPOINT: and the instance admits input again');
  assert.equal(injects(ws).length, 0, 'CHECKPOINT: with nothing written to get there');
  delete H.sessions[sid];
});

test('E10 synchrony and silence: the handler\'s own source has no await, no timer and no key or byte anywhere', () => {
  assert.equal(typeof H.actions.registerClearStrandV1Route, 'function',
    'CHECKPOINT: createSessionActions must expose the clear registrar (CLEAR-INTERFACE §8)');
  const source = sourceWithoutComments(String(H.actions.registerClearStrandV1Route));
  for (const needle of ['await ', 'await(', '.then(', 'setTimeout', 'setInterval', 'setImmediate',
    'process.nextTick', 'queueMicrotask', 'async ']) {
    assert.equal(source.includes(needle), false,
      `CHECKPOINT: the clear's code contains no ${JSON.stringify(needle)} — nothing may run between the strand read and the delete`);
  }
  for (const needle of ['\\r', '\\u0003', '\\u0015', '\\u001b', 'key code', 'send-key', 'ownerWs.send', 'write(']) {
    assert.equal(source.includes(needle), false,
      `CHECKPOINT: the clear's code contains no ${JSON.stringify(needle)} — this door never types, submits or interrupts`);
  }
  assert.ok(source.includes('clearStrandedComposer'),
    'CHECKPOINT: the one effect is the shared keyed delete, not an inline `delete session.strandedComposer`');
  assert.equal(source.includes('delete session.strandedComposer'), false,
    'CHECKPOINT: and the route never deletes the record itself, bypassing the key check');
  // The keyed delete itself: it may only remove the record it was given the key for.
  assert.equal(typeof runtimeModule.clearStrandedComposer, 'function',
    'CHECKPOINT: delivery-runtime must export clearStrandedComposer (CLEAR-INTERFACE §8)');
  const probe = { id: 'c1270-e10-probe', sessionEpoch: 'epoch-A' };
  const injectId = crypto.randomUUID();
  const record = runtimeModule.strandComposer(probe, { epoch: 'epoch-A', injectId, reason: 'submit_outcome_unknown' });
  for (const [label, args] of Object.entries({
    'no key at all': undefined, 'empty options': {}, 'epoch only': { epoch: 'epoch-A' },
    'a wrong epoch': { epoch: 'epoch-B', injectId }, 'a wrong inject id': { epoch: 'epoch-A', injectId: crypto.randomUUID() },
    'a null id against a non-null record': { epoch: 'epoch-A', injectId: null },
    'a non-string epoch': { epoch: 42, injectId },
  })) {
    assert.equal(runtimeModule.clearStrandedComposer(probe, args), null,
      `CHECKPOINT: a call with ${label} removes nothing and returns null`);
    assert.equal(probe.strandedComposer, record, `CHECKPOINT: and the record is untouched after ${label}`);
  }
  assert.equal(runtimeModule.clearStrandedComposer(probe, { epoch: 'epoch-A', injectId }), record,
    'CHECKPOINT: the exactly-keyed call returns the removed record');
  assert.equal(probe.strandedComposer, undefined, 'CHECKPOINT: and that is the only thing that removes it');
  assert.equal(runtimeModule.clearStrandedComposer(probe, { epoch: 'epoch-A', injectId }), null,
    'CHECKPOINT: a second keyed call has nothing to remove');
  // An INERT record (epoch moved on) is not removable either: it belongs to an instance this call does not name.
  const inert = { id: 'c1270-e10-inert', sessionEpoch: 'epoch-A' };
  const inertRecord = runtimeModule.strandComposer(inert, { epoch: 'epoch-A', injectId, reason: 'cr_outcome_unknown' });
  inert.sessionEpoch = 'epoch-B';
  assert.equal(runtimeModule.clearStrandedComposer(inert, { epoch: 'epoch-A', injectId }), null,
    'CHECKPOINT: a record that does not apply to the live epoch is not removed');
  assert.equal(inert.strandedComposer, inertRecord, 'CHECKPOINT: it is left exactly where it was');
});

test('E11 no keys, no bytes: across the whole run the owner sockets, the PTY and the GUI arm see nothing', () => {
  const frameCounts = new Map();
  for (const [id, session] of Object.entries(H.sessions)) {
    frameCounts.set(id, session.ownerWs && Array.isArray(session.ownerWs.frames) ? session.ownerWs.frames.length : 0);
  }
  // A spawned record with a real PTY write spy, and the GUI submit arm with an execFileSync spy.
  const wrote = [];
  const spawnedSid = 'c1270-e11-spawned';
  const spawnedEpoch = crypto.randomUUID();
  const spawned = { id: spawnedSid, type: 'spawned', command: 'claude', clients: new Set(),
    sessionEpoch: spawnedEpoch, interactionOwnerGeneration: crypto.randomUUID(),
    ptyProcess: { write: data => wrote.push(data) }, createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(), outputRing: [], outputRingTotalBytes: 0 };
  H.sessions[spawnedSid] = spawned;
  const spawnedStrand = runtimeModule.strandComposer(spawned, { epoch: spawnedEpoch,
    injectId: crypto.randomUUID(), reason: 'submit_outcome_unknown' });
  const osaCalls = [];
  inspectionContext(H.sessions, (file, args) => { osaCalls.push({ file, args }); return Buffer.from('ok:window'); });

  const { session, strand } = H.strandedFixture('c1270-e11-witness');
  H.setPersist(() => ({ ok: true }));
  const sweep = [
    invokeClear(H.clearReq(session.id, H.clearBody(session), { socket: { remoteAddress: '203.0.113.11' } })),
    invokeClear(H.clearReq(session.id, H.clearBody(session), { dropHeaders: ['x-telepty-token'] })),
    invokeClear(H.clearReq(session.id, H.clearBody(session, { basis: 'force' }))),
    invokeClear(H.clearReq(session.id, H.clearBody(session, { expected_epoch: crypto.randomUUID() }))),
    invokeClear(H.clearReq(spawnedSid, { schema: REQUEST_SCHEMA, from: 'E-operator', expected_epoch: spawnedEpoch,
      expected_owner_generation: spawned.interactionOwnerGeneration, stranded_inject_id: spawnedStrand.inject_id,
      basis: 'composer_emptied_by_operator' })),
    invokeClear(H.clearReq(session.id, H.clearBody(session))),
  ];
  assert.deepEqual(sweep.map(answer => answer.body.stage),
    ['refused', 'refused', 'refused', 'refused', 'refused', 'cleared'],
    `PRECONDITION: five refusals and one clear were exercised ${JSON.stringify(sweep.map(a => a.body.reason))}`);
  assert.deepEqual(wrote, [], 'CHECKPOINT: not one byte was written to a PTY by any of them');
  assert.deepEqual(osaCalls, [], 'CHECKPOINT: no osascript process was spawned — no window raised, no Return pressed');
  for (const [id, before] of frameCounts) {
    const current = H.sessions[id] && H.sessions[id].ownerWs && Array.isArray(H.sessions[id].ownerWs.frames)
      ? H.sessions[id].ownerWs.frames.length : before;
    assert.equal(current, before, `CHECKPOINT: no frame of any kind reached ${id}'s owner socket during the clears`);
  }
  assert.equal(injects(session.ownerWs).length, 0, 'CHECKPOINT: and the witness session was never written to at all');
  assert.ok(strand, 'PRECONDITION: the witness really had a strand to clear');
  delete H.sessions[spawnedSid];
});

test('E12 silence before step 4: no authority or schema refusal writes an audit line or a bus event', () => {
  const { session, strand } = H.strandedFixture('c1270-e12-silence');
  const body = H.clearBody(session);
  const rows = [
    ['clear_local_only', { socket: { remoteAddress: '203.0.113.12' } }, body],
    ['clear_origin_refused', { headers: { origin: 'http://evil.test' } }, body],
    ['clear_content_type', { headers: { 'content-type': 'text/plain' } }, body],
    ['clear_body_bytes', { principalRawBody: Buffer.alloc(600, 0x20) }, body],
    ['clear_auth_required', { dropHeaders: ['x-telepty-token'] }, body],
    ['request_not_object', {}, null],
    ['request_keys', {}, { ...body, extra: 1 }],
    ['request_schema', {}, { ...body, schema: 'telepty.clear-strand/v2' }],
    ['from_invalid', {}, { ...body, from: '' }],
    ['basis_invalid', {}, { ...body, basis: 'force' }],
    ['clear_target_invalid', {}, body],
  ];
  const audits = H.auditLines.length;
  const events = H.busEvents.length;
  for (const [reason, options, requestBody] of rows) {
    const sid = reason === 'clear_target_invalid' ? 'x'.repeat(257) : session.id;
    const answer = invokeClear(H.clearReq(sid, requestBody, options));
    assert.equal(answer.body.reason, reason,
      `PRECONDITION: the row produces ${reason} (got ${answer.body.reason})`);
  }
  assert.deepEqual([H.auditLines.length - audits, H.busEvents.length - events], [0, 0],
    `CHECKPOINT: eleven refusals before step 4 wrote nothing at all ${JSON.stringify(H.auditLines.slice(audits))}`);
  assert.equal(session.strandedComposer, strand, 'CHECKPOINT: and none of them had any effect');
});

test('E13 one audit line per outcome: the real writer records the clear and each step-4 refusal, with no text', { timeout: 30000 }, async () => {
  const { session, strand } = H.strandedFixture('c1270-e13-audit');
  const body = H.clearBody(session);
  const before = H.auditLines.length;
  const refusals = [
    ['epoch_mismatch', { ...body, expected_epoch: crypto.randomUUID() }],
    ['owner_generation_mismatch', { ...body, expected_owner_generation: crypto.randomUUID() }],
    ['stranded_inject_id_mismatch', { ...body, stranded_inject_id: crypto.randomUUID() }],
    ['basis_contradicted', { ...body, basis: 'child_replaced_observed' }],
  ];
  for (const [reason, requestBody] of refusals) {
    const answer = invokeClear(H.clearReq(session.id, requestBody));
    assert.equal(answer.body.reason, reason, `PRECONDITION: the row produces ${reason} (got ${answer.body.reason})`);
  }
  H.setPersist(() => ({ ok: true }));
  const cleared = invokeClear(H.clearReq(session.id, body));
  assert.equal(cleared.body.stage, 'cleared', `PRECONDITION: the clear succeeded ${JSON.stringify(cleared.body)}`);

  const records = H.auditLines.slice(before);
  assert.equal(records.length, refusals.length + 1,
    `CHECKPOINT: exactly one line per outcome from step 4 onward ${JSON.stringify(records.map(r => r.delivery_result))}`);
  assert.deepEqual(records.map(record => record.delivery_result),
    [...refusals.map(([reason]) => `refused:${reason}`), 'cleared'],
    'CHECKPOINT: each refusal is refused:<reason> and the clear is `cleared`');

  // Read back off the REAL private log file, through the real writer and the real reader.
  await H.auditWriter.flush();
  const read = auditLog.readInjectLog(H.auditFile, { to: session.id, limit: 50 });
  const lines = read.injects.filter(line => line.kind === AUDIT_KIND).reverse();
  assert.equal(lines.length, refusals.length + 1,
    `CHECKPOINT: the same five lines are on disk ${JSON.stringify(lines.map(line => line.delivery_result))}`);
  for (const line of lines) {
    assert.deepEqual(Object.keys(line), [...AUDIT_BASE_KEYS, ...AUDIT_CLEAR_KEYS],
      `CHECKPOINT: the persisted line is the §7.1 shape ${JSON.stringify(Object.keys(line))}`);
    assert.deepEqual({ kind: line.kind, source: line.source, to: line.to, origin: line.origin,
      host: line.origin_host, bytes: line.payload_bytes, preview: line.payload_preview, sha: line.payload_sha256 },
    { kind: AUDIT_KIND, source: AUDIT_SOURCE, to: session.id, origin: 'trusted-local',
      host: 'c1270-clear-machine', bytes: 0, preview: null, sha: sha256('') },
    `CHECKPOINT: zero payload bytes and no preview — there is no payload on this door ${JSON.stringify(line)}`);
    assert.ok(line.clear_basis === null || BASES.includes(line.clear_basis),
      `CHECKPOINT: clear_basis is a bounded code ${JSON.stringify(line.clear_basis)}`);
    assert.ok(CHILD_EVIDENCE.includes(line.clear_child_evidence),
      `CHECKPOINT: clear_child_evidence is a bounded code ${JSON.stringify(line.clear_child_evidence)}`);
    assert.equal(typeof line.clear_persisted, 'boolean', 'CHECKPOINT: clear_persisted is a boolean');
    assert.ok(line.clear_strand_at === null || ISO.test(String(line.clear_strand_at)),
      `CHECKPOINT: clear_strand_at is an ISO timestamp or null ${JSON.stringify(line.clear_strand_at)}`);
    assert.ok(line.clear_strand_reason === null || CODE.test(String(line.clear_strand_reason)),
      `CHECKPOINT: clear_strand_reason is a bounded code or null ${JSON.stringify(line.clear_strand_reason)}`);
    const text = JSON.stringify(line);
    for (const forbidden of ['unsubmitted text', 'Working (12s', 'esc to interrupt', '\\u001b']) {
      assert.equal(text.includes(forbidden), false,
        `CHECKPOINT: no prompt, screen or escape text in an audit line (${forbidden})`);
    }
  }
  const clearedLine = lines[lines.length - 1];
  assert.deepEqual({ inject: clearedLine.inject_id, reason: clearedLine.clear_strand_reason,
    at: clearedLine.clear_strand_at, persisted: clearedLine.clear_persisted },
  { inject: strand.inject_id, reason: strand.reason, at: strand.at, persisted: true },
  `CHECKPOINT: the cleared line names the removed record and the save outcome ${JSON.stringify(clearedLine)}`);
});

test('E14 bus event: composer_strand_cleared carries the §7.2 fields, shadows no envelope block, and is not an approved type', () => {
  const { session, strand } = H.strandedFixture('c1270-e14-bus');
  H.setPersist(() => ({ ok: true }));
  const before = H.busEvents.length;
  const answer = invokeClear(H.clearReq(session.id, H.clearBody(session, { from: 'E-operator-claim' })));
  assert.equal(answer.body.stage, 'cleared', `PRECONDITION: the clear succeeded ${JSON.stringify(answer.body)}`);
  const events = H.busEvents.slice(before).filter(event => event.type === BUS_EVENT);
  assert.equal(events.length, 1,
    `CHECKPOINT: exactly one ${BUS_EVENT} event ${JSON.stringify(H.busEvents.slice(before).map(event => event.type))}`);
  const event = events[0];
  for (const key of BUS_EXTRA_KEYS) {
    assert.ok(Object.hasOwn(event, key), `CHECKPOINT: the event carries ${key} (§7.2)`);
  }
  assert.deepEqual({ target: event.target_agent, inject: event.stranded_inject_id, reason: event.strand_reason,
    at: event.strand_at, basis: event.basis, evidence: event.child_evidence, persisted: event.persisted,
    from: event.from, origin: event.origin },
  { target: session.id, inject: strand.inject_id, reason: strand.reason, at: strand.at,
    basis: 'composer_emptied_by_operator', evidence: 'same_child', persisted: true, from: 'E-operator-claim',
    origin: 'trusted-local' }, `CHECKPOINT: with the values of the clear that happened ${JSON.stringify(event)}`);
  assert.equal(JSON.stringify(event).includes('unsubmitted text'), false,
    'CHECKPOINT: correlatable metadata only — never the prompt text (#815)');
  // The envelope's own transport block must NOT be shadowed by `extra` (the defect recorded for inject_written).
  assert.equal(event.transport !== null && typeof event.transport === 'object', true,
    `CHECKPOINT: the envelope's transport block survives — extra contains no key named transport ${JSON.stringify(event.transport)}`);
  assert.equal(typeof event.transport.health_status, 'string',
    'CHECKPOINT: and it is the real transport block, not a value `extra` put there');
  // The scoped read-only session-event transport deliberately does not carry this type.
  assert.equal(sessionEvents.projectSessionEvent(session, session.id, BUS_EVENT, event), null,
    `CHECKPOINT: ${BUS_EVENT} is not in APPROVED_TYPES — the read-only transport does not carry it`);
  // And strict principal mode still has no action for this path, so the route is fail-closed there.
  assert.equal(principalHttp.resolveAction({ method: 'POST', url: `/api/sessions/${session.id}/${VERB}` }), null,
    'CHECKPOINT: strict mode resolves no action for the clear path — PRINCIPAL_ACTION_DENIED, never an unchecked clear');
});
