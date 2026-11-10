'use strict';

// Issue #144 / Telesession issue16 — `client-profile-scope-v1` unit rows (contract564 §3 as amended by REVIEW569
// A1–A6/F7/F8/F10). No daemon, no listener, no network. Real-daemon enforcement rows live in
// test/client-profile-daemon.test.js. Every token, prefix and target here is synthetic.
//
// Rows: U1 target inside a namespace · U2 case-insensitive duplicate prefix · U4 strict conflict · U5 64 KiB bound ·
// U6 observation-record shape guard (#1273 ledger) · F7 digest reload / same-size rotation / failure → 503 ·
// A1 reserved segments + exact case-sensitive paths · A2 not_before freshness · A3 observation ownership ·
// A4 exact audit mode + since clamp · A5 raw-header carriers / loopback · W1 win32 refusal · CLI mint/check.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const profiles = require('../src/protocol/client-profiles');
const { createAuthMiddleware } = require('../src/protocol/http-auth');
const { createCredentialStore } = require('../src/session-store/session-credentials');
const { matchInjects, toMs } = require('../src/audit/inject-log');
const clientProfileCli = require('../src/cli/client-profile');

const ROOT = path.join(__dirname, '..');
const WIN = process.platform === 'win32';
const HOUR = 3600 * 1000;
// Absolute and normalized on every platform, so a win32 row reaches the platform refusal, not path_invalid.
const ABS = path.resolve(path.sep, 'abs', 'p.json');

function mintToken(generation = 1) {
  return `tpc1.${generation}.${crypto.randomBytes(32).toString('base64url')}`;
}
function verifierOf(token) {
  return `sha256:${crypto.createHash('sha256').update(token).digest('hex')}`;
}
function hex32() { return crypto.randomBytes(16).toString('hex'); }
function iso(ms) { return new Date(ms).toISOString(); }

function entry(name, prefix, targets, token, { generation = 1, notBefore = iso(Date.now() - HOUR) } = {}) {
  return { profile: name, inbox_prefix: prefix, targets, generation, token_verifier: verifierOf(token), not_before: notBefore };
}
function fileBytes(entries, extra = {}) {
  return Buffer.from(JSON.stringify({ schema: profiles.SCHEMA, profiles: entries, ...extra }));
}
function refusedReason(fn) {
  try { fn(); } catch (error) { return `${error.code}/${error.reason || ''}`; }
  return 'accepted';
}

// A two-profile world: A (exa) and B (exb), one shared target.
function world() {
  const tokA = mintToken(1), tokB = mintToken(3);
  const entries = [
    entry('example-a', 'exa', ['target-a', 'target-shared'], tokA),
    entry('example-b', 'exb', ['target-b', 'target-shared'], tokB, { generation: 3 }),
  ];
  let current = fileBytes(entries);
  let reads = 0;
  const registry = profiles.createClientProfileRegistry({ file: '/synthetic/profiles.json', readFile: () => { reads++; return current; } });
  const sessions = Object.create(null);
  const credentials = createCredentialStore();
  const gate = profiles.createClientProfileGate({ registry, sessions: () => sessions, credentials });
  function addSession(id, { createdAt = iso(Date.now()) } = {}) {
    const issued = credentials.issue(id);
    sessions[id] = { id, sessionEpoch: issued.epoch, credentialGeneration: 1, createdAt, type: 'aterm' };
    return issued.bearer;
  }
  return { tokA, tokB, entries, registry, sessions, credentials, gate, addSession,
    setFile: (bytes) => { current = bytes; }, reads: () => reads };
}

// A minimal Express-shaped request. `raw` overrides rawHeaders (duplicates / case variants).
function req({ method = 'GET', url = '/api/meta', headers = {}, raw = null, body, remote = '127.0.0.1' } = {}) {
  const at = url.indexOf('?');
  const pathname = at === -1 ? url : url.slice(0, at);
  const rawHeaders = raw || Object.entries(headers).flatMap(([k, v]) => [k, v]);
  const merged = {};
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const key = String(rawHeaders[i]).toLowerCase();
    merged[key] = merged[key] === undefined ? rawHeaders[i + 1] : `${merged[key]}, ${rawHeaders[i + 1]}`;
  }
  const query = {};
  for (const [k, v] of new URLSearchParams(at === -1 ? '' : url.slice(at + 1))) {
    query[k] = query[k] === undefined ? v : [].concat(query[k], v);
  }
  return { method, url, originalUrl: url, path: pathname, rawHeaders, headers: merged, query, body, socket: { remoteAddress: remote }, ip: remote };
}
const as = (token, extra = {}) => ({ 'x-telepty-client-token': token, ...extra });

// ── file validation (U1, U2, A1, A2, F7 bounds) ──────────────────────────────────────────────────────────────────

test('U-file: a valid two-profile file loads; verifiers are stored, tokens never', () => {
  const w = world();
  const snapshot = w.registry.load();
  assert.equal(snapshot.count, 2);
  const text = JSON.stringify(snapshot.summary);
  assert.ok(!text.includes(w.tokA) && !text.includes(w.tokB), 'no token material in the snapshot summary');
  assert.ok(!text.includes('sha256:'), 'the summary carries no verifier');
});

test('U1/U2/A1: whole-file fail-closed validation rejects every ambiguous or escaping grant', () => {
  const t = mintToken(), u = mintToken();
  const ok = (entries) => refusedReason(() => profiles.parseClientProfiles(fileBytes(entries)));
  const nb = iso(Date.now());
  assert.equal(ok([entry('a', 'exa', ['t1'], t)]), 'accepted');
  assert.equal(ok([entry('a', 'exa', ['t1'], t), entry('b', 'EXA', ['t2'], u)]), 'CLIENT_PROFILES_UNAVAILABLE/inbox_prefix_duplicate', 'U2');
  assert.equal(ok([entry('a', 'exa', [`exb-i${hex32()}`], t), entry('b', 'exb', ['t2'], u)]), 'CLIENT_PROFILES_UNAVAILABLE/target_in_namespace', 'U1');
  assert.equal(ok([entry('a', 'exa', [`EXB-I${hex32().toUpperCase()}`], t), entry('b', 'exb', ['t2'], u)]), 'CLIENT_PROFILES_UNAVAILABLE/target_in_namespace', 'U1 case-insensitive');
  assert.equal(ok([entry('a', 'exa', [`exa-i${hex32()}`], t)]), 'CLIENT_PROFILES_UNAVAILABLE/target_in_namespace', 'own namespace too');
  for (const reserved of ['broadcast', 'Multicast', 'register', 'SPAWN', 'submit-all']) {
    assert.equal(ok([entry('a', 'exa', [reserved], t)]), 'CLIENT_PROFILES_UNAVAILABLE/target_reserved', `A1/D32 ${reserved}`);
  }
  assert.equal(ok([entry('a', 'exa', ['t1'], t), entry('a', 'exb', ['t2'], u)]), 'CLIENT_PROFILES_UNAVAILABLE/profile');
  assert.equal(ok([entry('a', 'exa', ['t1'], t), entry('b', 'exb', ['t2'], t)]), 'CLIENT_PROFILES_UNAVAILABLE/token_verifier');
  assert.equal(ok([entry('a', 'ex-a', ['t1'], t)]), 'CLIENT_PROFILES_UNAVAILABLE/inbox_prefix', 'no "-" in a prefix');
  assert.equal(ok([entry('A', 'exa', ['t1'], t)]), 'CLIENT_PROFILES_UNAVAILABLE/profile');
  assert.equal(ok([entry('a', 'exa', [], t)]), 'CLIENT_PROFILES_UNAVAILABLE/targets');
  assert.equal(ok([entry('a', 'exa', ['t1', 't1'], t)]), 'CLIENT_PROFILES_UNAVAILABLE/target');
  assert.equal(ok([entry('a', 'exa', ['bad id'], t)]), 'CLIENT_PROFILES_UNAVAILABLE/target');
  assert.equal(ok([entry('a', 'exa', ['x'.repeat(129)], t)]), 'CLIENT_PROFILES_UNAVAILABLE/target');
  assert.equal(ok([{ ...entry('a', 'exa', ['t1'], t), generation: 0 }]), 'CLIENT_PROFILES_UNAVAILABLE/generation');
  assert.equal(ok([{ ...entry('a', 'exa', ['t1'], t), generation: 1.5 }]), 'CLIENT_PROFILES_UNAVAILABLE/generation');
  assert.equal(ok([{ ...entry('a', 'exa', ['t1'], t), token_verifier: `sha256:${'A'.repeat(64)}` }]), 'CLIENT_PROFILES_UNAVAILABLE/token_verifier');
  for (const bad of ['2026-02-31T00:00:00Z', '2026-01-01T00:00:00+00:00', '2026-01-01', '', 7]) {
    assert.equal(ok([{ ...entry('a', 'exa', ['t1'], t), not_before: bad }]), 'CLIENT_PROFILES_UNAVAILABLE/not_before', `not_before ${bad}`);
  }
  assert.equal(ok([{ ...entry('a', 'exa', ['t1'], t), not_before: nb.replace(/\.\d{3}Z$/, 'Z') }]), 'accepted', 'whole seconds');
  assert.equal(ok([{ ...entry('a', 'exa', ['t1'], t), extra: 1 }]), 'CLIENT_PROFILES_UNAVAILABLE/entry_keys');
  const { not_before: _drop, ...missing } = entry('a', 'exa', ['t1'], t);
  assert.equal(ok([missing]), 'CLIENT_PROFILES_UNAVAILABLE/entry_keys', 'not_before is required (A2)');
  assert.equal(refusedReason(() => profiles.parseClientProfiles(fileBytes([], { extra: true }))), 'CLIENT_PROFILES_UNAVAILABLE/schema');
  assert.equal(refusedReason(() => profiles.parseClientProfiles(Buffer.from('{"schema":"telepty.client-profiles/v1","schema":"x","profiles":[]}'))),
    'CLIENT_PROFILES_UNAVAILABLE/not_unambiguous_json', 'duplicate keys refused');
  assert.equal(refusedReason(() => profiles.parseClientProfiles(Buffer.from(`{"schema":"${profiles.SCHEMA}","profiles":[{"__proto__":{}}]}`))),
    'CLIENT_PROFILES_UNAVAILABLE/entry_keys');
  assert.equal(refusedReason(() => profiles.parseClientProfiles(fileBytes([]))), 'accepted', 'an empty grant list is valid (everything 401)');
});

// ── startup policy (F8 refuse, U4, W1, Darwin reader) ────────────────────────────────────────────────────────────

test('U4/W1/F8: configured startup refuses on path, platform, strict mode and reader failures; unconfigured is off', () => {
  const good = fileBytes([entry('a', 'exa', ['t1'], mintToken())]);
  const start = (env, extra = {}) => refusedReason(() => profiles.createClientProfilesFromEnvironment({ env, config: null, readFile: () => good, ...extra }));
  assert.equal(profiles.createClientProfilesFromEnvironment({ env: {}, config: null }), null, 'absent ⇒ off');
  assert.equal(profiles.createClientProfilesFromEnvironment({ env: { TELEPTY_CLIENT_PROFILES_FILE: '' }, config: {} }), null, 'empty env ⇒ off');
  assert.equal(start({ TELEPTY_CLIENT_PROFILES_FILE: 'relative/p.json' }), 'CLIENT_PROFILES_UNAVAILABLE/path_invalid');
  assert.equal(start({ TELEPTY_CLIENT_PROFILES_FILE: '/a/../p.json' }), 'CLIENT_PROFILES_UNAVAILABLE/path_invalid');
  assert.equal(start({ TELEPTY_CLIENT_PROFILES_FILE: ABS }, { platform: 'win32' }), 'CLIENT_PROFILES_UNAVAILABLE/platform_unsupported', 'W1');
  assert.equal(start({ TELEPTY_CLIENT_PROFILES_FILE: ABS, TELEPTY_PRINCIPAL_MODE: 'strict' }, { platform: 'linux' }), 'CLIENT_PROFILES_MODE_CONFLICT/', 'U4');
  assert.equal(start({ TELEPTY_CLIENT_PROFILES_FILE: ABS }, { platform: 'darwin', readFile: () => {
    throw Object.assign(new Error('x'), { code: 'AUTHORITY_FILE_UNAVAILABLE', reason: 'darwin_native_reader_unavailable' }); } }),
  'CLIENT_PROFILES_UNAVAILABLE/darwin_native_reader_unavailable', 'Darwin without the bundled reader refuses, named');
  assert.equal(start({ TELEPTY_CLIENT_PROFILES_FILE: ABS }, { platform: 'linux', readFile: () => Buffer.from('{') }), 'CLIENT_PROFILES_UNAVAILABLE/not_unambiguous_json', 'D43 corrupt');
  // config key, env precedence
  assert.equal(profiles.resolveClientProfilesFile({ env: {}, config: { clientProfilesFile: '/c.json' } }).source, 'config');
  assert.equal(profiles.resolveClientProfilesFile({ env: { TELEPTY_CLIENT_PROFILES_FILE: '/e.json' }, config: { clientProfilesFile: 7 } }).file, '/e.json');
  assert.equal(refusedReason(() => profiles.createClientProfilesFromEnvironment({ env: {}, config: { clientProfilesFile: 7 } })), 'CLIENT_PROFILES_UNAVAILABLE/path_invalid');
  // messages never carry the path
  try { profiles.createClientProfilesFromEnvironment({ env: { TELEPTY_CLIENT_PROFILES_FILE: path.resolve(path.sep, 'secret-dir', 'p.json') }, platform: 'win32' }); }
  catch (error) { assert.ok(!error.message.includes('secret-dir')); }
});

// ── F7 reload ────────────────────────────────────────────────────────────────────────────────────────────────────

test('F7/D18/D19/D41: per-request digest reload — equal digest reuses, a same-size rotation is seen at once, failure is 503', () => {
  const w = world();
  const first = w.registry.load();
  assert.equal(w.registry.load(), first, 'equal digest ⇒ the frozen snapshot is reused');
  assert.equal(w.reads(), 2, 'but the file is re-read on every request');
  const meta = () => w.gate.authorize(req({ headers: as(w.tokA) }));
  assert.equal(meta().ok, true);
  // Same-size in-place rotation: verifier and generation are fixed width, so the byte length cannot change.
  const rotated = mintToken(2);
  const next = fileBytes([{ ...w.entries[0], token_verifier: verifierOf(rotated), generation: 2 }, w.entries[1]]);
  assert.equal(next.length, fileBytes(w.entries).length);
  w.setFile(next);
  assert.deepEqual(meta(), { ok: false, status: 401, code: 'PROFILE_CREDENTIAL_INVALID' }, 'D18/D41 old token refused on the next request');
  assert.equal(w.gate.authorize(req({ headers: as(rotated) })).ok, true, 'rotated token admitted');
  assert.equal(w.gate.authorize(req({ headers: as(rotated) })).caller.generation, 2);
  w.setFile(fileBytes([w.entries[1]]));
  assert.equal(w.gate.authorize(req({ headers: as(rotated) })).status, 401, 'D19 revoked');
  assert.equal(w.gate.authorize(req({ headers: as(w.tokB) })).ok, true, 'the other profile is undisturbed');
  w.setFile(Buffer.from('not json'));
  assert.deepEqual(w.gate.authorize(req({ headers: as(w.tokB) })), { ok: false, status: 503, code: 'PROFILE_REGISTRY_UNAVAILABLE' }, 'D21 no stale set');
  w.setFile(fileBytes(w.entries));
  assert.equal(w.gate.authorize(req({ headers: as(w.tokB) })).ok, true, 'D22 re-fixed without restart');
});

test('F2/A2: namespace reservation uses the live file, or the last good one while the file is unreadable', () => {
  const w = world();
  w.registry.load();
  assert.equal(w.registry.reservesSessionId(`exa-i${hex32()}`), true);
  assert.equal(w.registry.reservesSessionId(`exa-i${hex32().toUpperCase()}`), false, 'not a namespace id');
  assert.equal(w.registry.reservesSessionId(`exz-i${hex32()}`), false);
  assert.equal(w.registry.reservesSessionId('exa'), false);
  w.setFile(Buffer.from('{'));
  assert.equal(w.registry.reservesSessionId(`exb-i${hex32()}`), true, 'fail closed toward more reservation');
});

// ── the gate: carriers, loopback, credential (A5) ────────────────────────────────────────────────────────────────

test('A5/D38/D26: carrier presence is counted on raw headers; every mixed or duplicate carrier is 400 before admission', () => {
  const w = world();
  const cases = [
    ['duplicate client token', { raw: ['x-telepty-client-token', w.tokA, 'X-Telepty-Client-Token', w.tokA] }],
    ['empty x-telepty-token', { raw: ['x-telepty-client-token', w.tokA, 'x-telepty-token', ''] }],
    ['root token alongside', { raw: ['x-telepty-client-token', w.tokA, 'X-TELEPTY-TOKEN', 'root'] }],
    ['authorization', { raw: ['x-telepty-client-token', w.tokA, 'Authorization', 'Bearer x'] }],
    ['principal', { raw: ['x-telepty-client-token', w.tokA, 'x-telepty-principal', 'p'] }],
    ['owner token', { raw: ['x-telepty-client-token', w.tokA, 'x-telepty-owner-token', 'o'] }],
    ['input policy capability', { raw: ['x-telepty-client-token', w.tokA, 'x-telepty-input-policy-capability', 'c'] }],
    ['bridge capabilities', { raw: ['x-telepty-client-token', w.tokA, 'x-telepty-bridge-capabilities', 'c'] }],
    ['assertion', { raw: ['x-telepty-client-token', w.tokA, 'x-telepty-assertion', 'a'] }],
    ['session token on meta', { raw: ['x-telepty-client-token', w.tokA, 'x-telepty-session-token', 'e.s'] }],
    ['?token=', { url: '/api/meta?token=', headers: as(w.tokA) }],
    ['?owner_token=x', { url: '/api/meta?owner_token=x', headers: as(w.tokA) }],
  ];
  for (const [label, shape] of cases) {
    assert.deepEqual(w.gate.authorize(req(shape)), { ok: false, status: 400, code: 'CREDENTIAL_AMBIGUOUS' }, label);
  }
  const twoBearers = req({ method: 'POST', url: '/api/sessions/target-a/inject', body: {},
    raw: ['x-telepty-client-token', w.tokA, 'x-telepty-session-token', 'a.b', 'X-Telepty-Session-Token', 'a.b'] });
  assert.equal(w.gate.authorize(twoBearers).code, 'CREDENTIAL_AMBIGUOUS');
});

test('A5/D40: only a loopback socket may present a profile credential; unknown/forged tokens are 401', () => {
  const w = world();
  assert.deepEqual(w.gate.authorize(req({ headers: as(w.tokA), remote: '100.64.0.7' })), { ok: false, status: 403, code: 'PROFILE_REMOTE_DENIED' });
  assert.equal(w.gate.authorize(req({ headers: as(w.tokA), remote: '::ffff:127.0.0.1' })).ok, true);
  assert.equal(w.gate.authorize(req({ headers: as(w.tokA), remote: '::1' })).ok, true);
  const secret = w.tokA.split('.')[2];
  for (const forged of ['', 'x', `tpc1.9.${secret}`, `tpc1.1.${secret}x`, `tpc2.1.${secret}`, w.tokA.toUpperCase(), mintToken()]) {
    assert.deepEqual(w.gate.authorize(req({ headers: as(forged) })), { ok: false, status: 401, code: 'PROFILE_CREDENTIAL_INVALID' }, `D20 ${forged.slice(0, 8)}`);
  }
});

// ── the allow table (A1) ─────────────────────────────────────────────────────────────────────────────────────────

test('A1/D23/D33: default deny with exact, case-sensitive paths; every alternate route and fan-out is 403', () => {
  const w = world();
  const denied = [
    ['HEAD', '/api/meta'], ['GET', '/API/META'], ['GET', '/api/meta/'], ['GET', '/api/meta?x=1'], ['GET', '/api/sessions?idle_gt=1'],
    ['POST', '/api/sessions/spawn'], ['POST', '/api/sessions/target-a/kill'], ['PATCH', '/api/sessions/target-a'],
    ['POST', '/api/sessions/target-a/submit'], ['GET', '/api/sessions/target-a/screen'], ['GET', '/api/sessions/target-a/diagnostics'],
    ['GET', '/api/sessions/target-a/mailbox'], ['GET', '/api/sessions/target-a'], ['GET', '/api/sessions/target-a/state'],
    ['GET', '/api/peers'], ['POST', '/api/forwarded/sessions/target-a/inject'], ['POST', '/api/sessions/multicast/inject'],
    ['POST', '/api/sessions/broadcast/inject'], ['POST', '/api/sessions/Broadcast/inject'], ['POST', '/api/sessions/BROADCAST/inject'],
    ['POST', '/api/sessions/submit-all'], ['POST', '/api/peers/p/sessions/target-a/inject'], ['POST', '/api/bus/publish'],
    ['GET', '/api/sessions/target-a/interaction'], ['GET', '/api/ledger/status'], ['POST', '/api/daemon/stop'],
    ['POST', '/api/sessions/target-a/approval-challenge'], ['GET', '/api/pendingReports/target-a'], ['DELETE', '/api/pendingReports/target-a'],
    ['POST', '/api/sessions/target-a/inject/'], ['POST', '/API/sessions/target-a/inject'], ['DELETE', '/api/sessions/target-a'],
    ['DELETE', '/api/sessions/register?owned=true'], ['GET', '/api/inject-observations/x/y'], ['POST', '/api/handoff'],
  ];
  for (const [method, url] of denied) {
    const result = w.gate.authorize(req({ method, url, headers: as(w.tokA), body: { prompt: 'p', exact_target: true } }));
    assert.equal(result.ok, false, `${method} ${url}`);
    assert.equal(result.status, 403, `${method} ${url}`);
    assert.ok(['PROFILE_ACTION_DENIED', 'PROFILE_NAMESPACE_DENIED'].includes(result.code), `${method} ${url} → ${result.code}`);
  }
  assert.equal(w.gate.authorize(req({ url: '/api/meta', headers: as(w.tokA) })).ok, true);
  assert.equal(w.gate.authorize(req({ url: '/api/sessions', headers: as(w.tokA) })).ok, true);
});

test('register: own namespace only, exact field set, loopback receiver path, bounded command (D7/D15/D16/D27)', () => {
  const w = world();
  const id = `exa-i${hex32()}`;
  const good = { session_id: id, delivery_type: 'aterm', delivery_endpoint: `http://127.0.0.1:43123/${crypto.randomBytes(32).toString('base64url')}`,
    command: 'telesession-inbox', create_only: true };
  const register = (body, token = w.tokA) => w.gate.authorize(req({ method: 'POST', url: '/api/sessions/register', headers: as(token), body }));
  assert.equal(register(good).ok, true, 'D1 shape');
  assert.equal(register(good, w.tokB).code, 'PROFILE_NAMESPACE_DENIED', 'D7 B cannot create in A');
  assert.equal(register({ ...good, session_id: `exb-i${hex32()}` }).code, 'PROFILE_NAMESPACE_DENIED');
  assert.equal(register({ ...good, session_id: `exa-i${hex32().toUpperCase()}` }).code, 'PROFILE_NAMESPACE_DENIED', 'D16 uppercase hex');
  assert.equal(register({ ...good, session_id: `exa-i${hex32()}-2` }).code, 'PROFILE_NAMESPACE_DENIED', 'D16 sibling');
  const third = profiles.createClientProfileGate({ registry: profiles.createClientProfileRegistry({ file: '/x', readFile: () =>
    fileBytes([entry('c', 'ex', ['t'], 'tpc1.1.' + 'A'.repeat(43))]) }), sessions: () => ({}), credentials: w.credentials });
  assert.equal(third.authorize(req({ method: 'POST', url: '/api/sessions/register', headers: as('tpc1.1.' + 'A'.repeat(43)), body: good })).code,
    'PROFILE_NAMESPACE_DENIED', 'D15 prefix ex cannot claim exa-i…');
  for (const [label, body] of [
    ['no create_only', (({ create_only: _c, ...rest }) => rest)(good)], ['create_only false', { ...good, create_only: false }],
    ['delivery object', { ...good, delivery: { unix_socket: '/tmp/x' } }], ['input_policy', { ...good, input_policy: 'user-supervised' }],
    ['ssh_remote', { ...good, ssh_remote: { host: 'h' } }], ['non-loopback endpoint', { ...good, delivery_endpoint: 'http://10.0.0.1:1/' + 'a'.repeat(43) }],
    ['localhost endpoint', { ...good, delivery_endpoint: 'http://localhost:1/' + 'a'.repeat(43) }], ['port 0', { ...good, delivery_endpoint: 'http://127.0.0.1:0/' + 'a'.repeat(43) }],
    ['port 99999', { ...good, delivery_endpoint: 'http://127.0.0.1:99999/' + 'a'.repeat(43) }], ['short path', { ...good, delivery_endpoint: 'http://127.0.0.1:1/abc' }],
    ['mailbox type', { ...good, delivery_type: 'mailbox' }], ['command control char', { ...good, command: 'a\nb' }],
    ['command too long', { ...good, command: 'x'.repeat(129) }], ['command non-string', { ...good, command: 7 }],
    ['cwd', { ...good, cwd: '/' }], ['array body', [good]],
  ]) assert.equal(register(body).code, 'PROFILE_REQUEST_FIELD_DENIED', `D27 ${label}`);
  assert.equal(w.gate.authorize(req({ method: 'POST', url: '/api/sessions/register?x=1', headers: as(w.tokA), body: good })).code, 'PROFILE_ACTION_DENIED');
});

test('inject: granted target, own fresh live sender, exact_target, bearer epoch+generation (D9/D12–D14/D16/D17)', () => {
  const w = world();
  const inboxA = `exa-i${hex32()}`, inboxB = `exb-i${hex32()}`;
  const bearerA = w.addSession(inboxA), bearerB = w.addSession(inboxB);
  const inject = (target, body, { token = w.tokA, bearer = bearerA } = {}) => w.gate.authorize(req({ method: 'POST',
    url: `/api/sessions/${target}/inject`, headers: as(token, bearer ? { 'x-telepty-session-token': bearer } : {}), body }));
  const body = { prompt: 'hello', from: inboxA, reply_to: inboxA, exact_target: true };
  assert.equal(inject('target-a', body).ok, true, 'D3');
  assert.equal(inject('target-shared', { ...body, expected_epoch: 'e' }).ok, true);
  assert.equal(inject('target-b', body).code, 'PROFILE_TARGET_DENIED', 'D9 B-only target');
  assert.equal(inject(inboxB, body).code, 'PROFILE_TARGET_DENIED', 'D9 B inbox');
  assert.equal(inject('target-a-2', body).code, 'PROFILE_TARGET_DENIED', 'D16 sibling');
  assert.equal(inject('target-a%2Fx', body).code, 'PROFILE_ACTION_DENIED', 'D16 %2F');
  assert.equal(inject('%E0%A4%A', body).code, 'PROFILE_ACTION_DENIED', 'undecodable');
  assert.equal(inject('TARGET-A', body).code, 'PROFILE_TARGET_DENIED', 'exact case');
  assert.equal(inject('target-a', { ...body, exact_target: false }).code, 'PROFILE_REQUEST_FIELD_DENIED', 'D17');
  assert.equal(inject('target-a', (({ exact_target: _e, ...rest }) => rest)(body)).code, 'PROFILE_REQUEST_FIELD_DENIED', 'D17 absent');
  assert.equal(inject('target-a', { ...body, no_enter: true }).code, 'PROFILE_REQUEST_FIELD_DENIED');
  assert.equal(inject('target-a', { ...body, forwarding: true }).code, 'PROFILE_REQUEST_FIELD_DENIED');
  assert.equal(inject('target-a', { ...body, from: inboxB, reply_to: inboxB }, { bearer: bearerB }).code, 'PROFILE_SENDER_DENIED', 'D12');
  assert.equal(inject('target-a', { ...body, reply_to: 'elsewhere' }).code, 'PROFILE_SENDER_DENIED', 'D13');
  assert.equal(inject('target-a', { ...body, reply_to: undefined }).code, 'PROFILE_SENDER_DENIED');
  assert.equal(inject('target-a', body, { bearer: bearerB }).code, 'PROFILE_SENDER_DENIED', 'D14 B bearer with A token');
  assert.equal(inject('target-a', body, { bearer: null }).code, 'PROFILE_SENDER_DENIED', 'no bearer');
  assert.equal(inject('target-shared', { ...body, from: inboxB, reply_to: inboxB }, { token: w.tokB, bearer: bearerB }).ok, true, 'B own');
  // Live instance checks: epoch, generation, closing, freshness.
  w.sessions[inboxA].credentialGeneration = 2;
  assert.equal(inject('target-a', body).code, 'PROFILE_SENDER_DENIED', 'stale generation');
  w.sessions[inboxA].credentialGeneration = 1;
  w.sessions[inboxA].isClosing = true;
  assert.equal(inject('target-a', body).code, 'PROFILE_SENDER_DENIED', 'closing');
  w.sessions[inboxA].isClosing = false;
  w.sessions[inboxA].createdAt = iso(Date.now() - 2 * HOUR);
  assert.equal(inject('target-a', body).code, 'PROFILE_SENDER_DENIED', 'A2 pre-not_before sender');
});

test('audit: scoped selectors only, single non-empty strings, no spoof (D8/D28, A4)', () => {
  const w = world();
  const inboxA = `exa-i${hex32()}`, inboxB = `exb-i${hex32()}`;
  const read = (q, token = w.tokA) => w.gate.authorize(req({ url: `/api/injects?${q}`, headers: as(token) }));
  assert.equal(read(`to=${inboxA}`).ok, true);
  assert.equal(read(`to=${inboxA}&from=anyone&since=1&until=2&limit=5&cursor=0`).ok, true);
  assert.equal(read(`from=${inboxA}`).ok, true);
  assert.equal(read(`from=${inboxA}&to=target-a`).ok, true);
  for (const [label, q] of [['B inbox', `to=${inboxB}`], ['B sender', `from=${inboxB}`], ['B target', `from=${inboxA}&to=target-b`],
    ['no selector', 'limit=1'], ['target only', 'to=target-a'], ['spoof', `to=${inboxA}&spoof=1`], ['empty to', `to=&from=${inboxA}`],
    ['array', `to=${inboxA}&to=${inboxA}`], ['unknown key', `to=${inboxA}&exact=0`]]) {
    assert.deepEqual(read(q), { ok: false, status: 403, code: 'PROFILE_READ_DENIED' }, label);
  }
  // Exact mode: no to_alias, no claimed attribution (A4/D37).
  const rows = [
    { ts: iso(Date.now()), to: inboxA, verified_sender_sid: 'x' },
    { ts: iso(Date.now()), to: 'other', to_alias: inboxA },
    { ts: iso(Date.now()), to: 'target-a', claimed_from: inboxA, verified_sender_sid: null },
    { ts: iso(Date.now()), to: 'target-a', claimed_from: inboxA, verified_sender_sid: inboxA },
  ];
  assert.equal(matchInjects(rows, { to: inboxA, exact: true }).length, 1);
  assert.equal(matchInjects(rows, { to: inboxA }).length, 2, 'legacy unchanged');
  assert.equal(matchInjects(rows, { from: inboxA, exact: true }).length, 1);
  assert.equal(matchInjects(rows, { from: inboxA }).length, 2, 'legacy unchanged');
  // since clamp: max(since, not_before) with the audit filter's own coercion.
  const caller = w.registry.load().byVerifier.get(verifierOf(w.tokA));
  assert.equal(profiles.clampSince(undefined, caller, toMs), iso(caller.notBeforeMs), 'absent since ⇒ not_before');
  assert.equal(profiles.clampSince('1', caller, toMs), iso(caller.notBeforeMs));
  assert.equal(profiles.clampSince('garbage', caller, toMs), iso(caller.notBeforeMs));
  const later = iso(caller.notBeforeMs + 1000);
  assert.equal(profiles.clampSince(later, caller, toMs), later);
});

test('delete/observe/list helpers: own fresh namespace only; observation shape fails closed (D10/D11/D34, A3)', () => {
  const w = world();
  const inboxA = `exa-i${hex32()}`, inboxB = `exb-i${hex32()}`, stale = `exa-i${hex32()}`;
  w.addSession(inboxA); w.addSession(inboxB); w.addSession(stale, { createdAt: iso(Date.now() - 2 * HOUR) });
  w.sessions['target-a'] = { createdAt: iso(Date.now()) };
  w.sessions['unrelated'] = { createdAt: iso(Date.now()) };
  const del = (id, q = 'owned=true') => w.gate.authorize(req({ method: 'DELETE', url: `/api/sessions/${id}?${q}`, headers: as(w.tokA) }));
  assert.equal(del(inboxA).ok, true, 'D6 gate');
  assert.equal(del(inboxB).code, 'PROFILE_NAMESPACE_DENIED', 'D10');
  assert.equal(del(stale).code, 'PROFILE_NAMESPACE_DENIED', 'D34 leftover');
  assert.equal(del(`exa-i${hex32()}`).code, 'PROFILE_NAMESPACE_DENIED', 'absent id');
  assert.equal(del(inboxA, '').code, 'PROFILE_ACTION_DENIED', 'plain delete');
  assert.equal(del(inboxA, 'owned=true&owned=true').code, 'PROFILE_ACTION_DENIED');
  assert.equal(del(inboxA, 'owned=1').code, 'PROFILE_ACTION_DENIED');
  const caller = w.registry.load().byVerifier.get(verifierOf(w.tokA));
  assert.deepEqual(profiles.listForCaller(caller, w.sessions).map((s) => s.id).sort(), [inboxA, 'target-a'].sort(), 'D2 list');
  const record = { inject_id: 'i', transport_source: inboxA, created_at: iso(Date.now()) };
  assert.equal(profiles.ownsObservationRecord(caller, record), true);
  assert.equal(profiles.ownsObservationRecord(caller, { ...record, transport_source: inboxB }), false, 'D11');
  assert.equal(profiles.ownsObservationRecord(caller, { ...record, created_at: iso(Date.now() - 2 * HOUR) }), false, 'D34');
  assert.equal(profiles.ownsObservationRecord(caller, { inject_id: 'i', created_at: iso(Date.now()) }), false, 'U6 missing transport_source');
  assert.equal(profiles.ownsObservationRecord(caller, { inject_id: 'i', transport_source: inboxA }), false, 'U6 missing created_at');
  assert.deepEqual(profiles.callerView(caller), { kind: 'client-profile', profile: 'example-a', generation: 1, inbox_prefix: 'exa',
    targets: ['target-a', 'target-shared'], enforcement: 'server', shared_token: false });
  assert.deepEqual(profiles.callerView(null), { kind: 'shared-control', enforcement: 'none', shared_token: true });
});

test('U6 guard: the #1273 ledger record shape still carries transport_source and created_at on hot, legacy and minimal records', () => {
  const runtime = fs.readFileSync(path.join(ROOT, 'src', 'mailbox', 'delivery-runtime.js'), 'utf8');
  assert.match(runtime, /transport_source: source \|\| null,\s*\n\s*created_at: nowIso,/, 'hot begin record');
  const owner = fs.readFileSync(path.join(ROOT, 'src', 'session-store', 'ledger-owner.js'), 'utf8');
  const minimal = /function minimal\(r\) \{ return \{([^}]*)\}; \}/.exec(owner);
  assert.ok(minimal, 'ledger-owner minimal() present');
  assert.match(minimal[1], /transport_source: r\.transport_source/);
  assert.match(minimal[1], /created_at: r\.created_at/);
  const { toLegacyRecord } = require('../src/session-store/ledger-format');
  const legacy = toLegacyRecord({ inject_id: 'i', transport_source: 'exa-i0', created_at: 'now', materialized_through: 1 });
  assert.equal(legacy.transport_source, 'exa-i0');
  assert.equal(legacy.created_at, 'now');
});

// ── middleware composition: the profile branch never reaches admin admission ────────────────────────────────────

test('A5: createAuthMiddleware sends a profile-carrier request only to the gate; feature off is the legacy path', () => {
  const w = world();
  function run(options, request) {
    let status = null, body = null, nexted = false;
    const res = { status(code) { status = code; return this; }, json(value) { body = value; return this; } };
    createAuthMiddleware({ isAllowedPeer: () => true, expectedToken: 'root', verifyJwt: () => false, allowedOrigins: [], ...options })(request, res, () => { nexted = true; });
    return { status, body, nexted, request };
  }
  // Configured: the root token cannot rescue an ambiguous profile request, and a profile request is never admin.
  const mixed = run({ clientProfileGate: w.gate }, req({ raw: ['x-telepty-client-token', w.tokA, 'x-telepty-token', 'root'] }));
  assert.deepEqual([mixed.status, mixed.body.code, mixed.nexted], [400, 'CREDENTIAL_AMBIGUOUS', false]);
  const unknown = run({ clientProfileGate: w.gate, authorizeSessionRequest: () => true }, req({ headers: as(mintToken()) }));
  assert.deepEqual([unknown.status, unknown.body.code, unknown.nexted], [401, 'PROFILE_CREDENTIAL_INVALID', false], 'no E3 fallthrough');
  const ok = run({ clientProfileGate: w.gate }, req({ headers: as(w.tokA) }));
  assert.equal(ok.nexted, true);
  assert.equal(ok.request.clientProfile.profile, 'example-a');
  const root = run({ clientProfileGate: w.gate }, req({ headers: { 'x-telepty-token': 'root' } }));
  assert.equal(root.nexted, true);
  assert.equal(root.request.clientProfile, undefined, 'a legacy caller is not a profile caller');
  // Feature off: the header means nothing (U3) — root token admitted, profile-only refused with the legacy 401.
  const off = run({}, req({ raw: ['x-telepty-client-token', w.tokA, 'x-telepty-token', 'root'] }));
  assert.equal(off.nexted, true);
  const offProfile = run({}, req({ headers: as(w.tokA) }));
  assert.deepEqual([offProfile.status, offProfile.body.code], [401, 'PERMISSION_DENIED']);
  // Origin and peer reachability still run first.
  const origin = run({ clientProfileGate: w.gate }, req({ headers: { ...as(w.tokA), origin: 'https://evil.example' } }));
  assert.equal(origin.body.code, 'ORIGIN_NOT_ALLOWED');
});

test('audit reader: exact mode is daemon-set only and reaches the worker filters', async () => {
  const { createAuditReader } = require('../src/audit/query-reader');
  const seen = [];
  const reader = createAuditReader({ path: '/synthetic/injects.jsonl', workerFactory: (_file, options) => {
    seen.push(options.workerData.filters);
    const { EventEmitter } = require('node:events');
    const worker = new EventEmitter();
    worker.unref = () => {}; worker.terminate = () => { setImmediate(() => worker.emit('exit', 0)); return Promise.resolve(); };
    setImmediate(() => worker.emit('message', { ok: true, json: '{"injects":[],"next_cursor":null}' }));
    return worker;
  } });
  await reader.read({ to: 'a', exact: true });
  await reader.read({ to: 'a', exact: 'true' });
  await reader.read({ to: 'a' });
  assert.equal(seen[0].exact, true);
  assert.equal(seen[1].exact, undefined, 'only the boolean the daemon sets');
  assert.equal(seen[2].exact, undefined);
});

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function privateDir(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'telepty-cp-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function capture() {
  let text = '';
  return { stream: { write: (chunk) => { text += chunk; return true; } }, text: () => text };
}

test('CLI mint: O_EXCL 0600 bare token, verifier + fresh not_before printed, never the token; refuses existing/unsafe/win32', { skip: WIN ? 'win32: refusal only (W2 row below)' : false }, (t) => {
  const root = privateDir(t);
  const file = path.join(root, 'a.token');
  const out = capture(), err = capture();
  const code = clientProfileCli.runClientProfileCommand(['mint', '--profile', 'example-a', '--generation', '4', '--token-file', file], { stdout: out.stream, stderr: err.stream });
  assert.equal(code, 0, err.text());
  const token = fs.readFileSync(file, 'utf8');
  assert.match(token, profiles.TOKEN_RE);
  assert.ok(token.startsWith('tpc1.4.') && !token.endsWith('\n'), 'bare token');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const printed = JSON.parse(out.text());
  assert.deepEqual(Object.keys(printed).sort(), ['generation', 'not_before', 'profile', 'token_verifier']);
  assert.equal(printed.token_verifier, verifierOf(token));
  assert.ok(!out.text().includes(token.split('.')[2]), 'the token is never printed');
  assert.notEqual(profiles.notBeforeMs(printed.not_before), null);
  assert.equal(clientProfileCli.runClientProfileCommand(['mint', '--profile', 'example-a', '--generation', '4', '--token-file', file], { stdout: capture().stream, stderr: capture().stream }), 1, 'exists');
  const open = path.join(root, 'open'); fs.mkdirSync(open, { mode: 0o700 }); fs.chmodSync(open, 0o777);
  assert.equal(clientProfileCli.runClientProfileCommand(['mint', '--profile', 'a', '--generation', '1', '--token-file', path.join(open, 't')], { stdout: capture().stream, stderr: capture().stream }), 1, 'unsafe parent');
  assert.equal(clientProfileCli.runClientProfileCommand(['mint', '--profile', 'a', '--generation', '0', '--token-file', path.join(root, 'z')], { stdout: capture().stream, stderr: capture().stream }), 2);
  assert.equal(clientProfileCli.runClientProfileCommand(['mint', '--profile', 'a', '--generation', '1', '--token-file', 'rel'], { stdout: capture().stream, stderr: capture().stream }), 2);
  assert.throws(() => clientProfileCli.mint(['--profile', 'a', '--generation', '1', '--token-file', path.join(root, 'w')], { platform: 'win32' }), { code: 'CLIENT_PROFILES_UNAVAILABLE' });
});

test('CLI check: daemon validator, names/prefixes/counts only; U5 64 KiB bound', { skip: WIN ? 'win32: refusal only (W2 row below)' : false }, (t) => {
  const root = privateDir(t);
  const tok = mintToken();
  const file = path.join(root, 'profiles.json');
  fs.writeFileSync(file, fileBytes([entry('example-a', 'exa', ['t1', 't2'], tok)]), { mode: 0o600 });
  const out = capture();
  assert.equal(clientProfileCli.runClientProfileCommand(['check', '--file', file], { stdout: out.stream, stderr: capture().stream }), 0);
  const report = JSON.parse(out.text());
  assert.equal(report.profiles[0].targets, 2);
  assert.ok(!out.text().includes('sha256:') && !out.text().includes(tok), 'no verifier, no token');
  // U5: a large but legal file loads; one byte over the bound is refused by the authority reader.
  const many = [];
  for (let i = 0; JSON.stringify({ schema: profiles.SCHEMA, profiles: many }).length < 60 * 1024; i++) {
    many.push(entry(`p${i}`, `p${i}`, [`t${i}`], mintToken()));
  }
  const big = fileBytes(many);
  const padded = Buffer.concat([big.subarray(0, big.length - 1), Buffer.alloc(profiles.MAX_FILE_BYTES - big.length, 0x20), big.subarray(big.length - 1)]);
  assert.equal(padded.length, 65536);
  const atLimit = path.join(root, 'limit.json');
  fs.writeFileSync(atLimit, padded, { mode: 0o600 });
  assert.equal(clientProfileCli.check(['--file', atLimit]).profiles.length, many.length, 'U5 64 KiB loads');
  const over = path.join(root, 'over.json');
  fs.writeFileSync(over, Buffer.concat([padded, Buffer.from(' ')]), { mode: 0o600 });
  assert.throws(() => clientProfileCli.check(['--file', over]), { code: 'CLIENT_PROFILES_UNAVAILABLE' }, 'U5 65537 B refused');
  fs.chmodSync(file, 0o640);
  assert.throws(() => clientProfileCli.check(['--file', file]), { code: 'CLIENT_PROFILES_UNAVAILABLE' }, 'group-readable refused');
  assert.deepEqual(clientProfileCli.check([], { env: {}, readOperatorConfig: () => null }), { configured: false });
});

test('W2 (server CLI): client-profile check and mint refuse on win32', () => {
  assert.throws(() => clientProfileCli.check(['--file', ABS], { platform: 'win32' }), { code: 'CLIENT_PROFILES_UNAVAILABLE', reason: 'platform_unsupported' });
  assert.throws(() => clientProfileCli.mint(['--profile', 'a', '--generation', '1', '--token-file', path.resolve(path.sep, 'abs', 't')], { platform: 'win32' }), { code: 'CLIENT_PROFILES_UNAVAILABLE', reason: 'platform_unsupported' });
});
