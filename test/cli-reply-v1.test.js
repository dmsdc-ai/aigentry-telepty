'use strict';

// Task 1292 W4 — `telepty reply-v1` (SPEC §11; TEST-PLAN U17; HOLD-1 answers Q2–Q6).
//
// Written by the coder, NOT executed by the coder.
// Part 1 (in-process) drives the real src/cli/reply-v1.js with an injected fetchWithAuth, stdin and writers,
// and the real cli.js bootCapabilitiesLine. Part 2 (process) runs the real cli.js: once with env {PATH, HOME}
// and an empty HOME (no daemon needed: refused before any socket, no file written), and once against a REAL
// isolated daemon (test-support/daemon-harness) with a well-formed token the daemon never minted.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const cli = require(path.join(ROOT, 'cli.js'));
const replyV1 = require(path.join(ROOT, 'src', 'cli', 'reply-v1.js'));
const { RESULT_SCHEMA } = require(path.join(ROOT, 'src', 'reply-capability.js'));

const DAEMON_URL = 'http://127.0.0.1:3848';
const ROUTE_URL = `${DAEMON_URL}/api/reply-capability-v1`;

function makeToken() {
  const id = crypto.randomBytes(16).toString('base64url');
  const secret = crypto.randomBytes(32).toString('base64url');
  return { id, secret, token: `rc1.${id}.${secret}` };
}

function writer() {
  return { text: '', write(chunk) { this.text += String(chunk); return true; } };
}

function stdinOf(bytes) {
  const state = { read: false };
  const stream = new Readable({
    read() {
      state.read = true;
      if (bytes !== null) this.push(Buffer.from(bytes));
      this.push(null);
    },
  });
  return { stream, state };
}

function closed(fields) {
  return { schema: RESULT_SCHEMA, stage: 'refused', outcome: null, reason: null, capability_id: null,
    reply_inject_id: null, destination_session_id: null, replayed: false, retryable: false, ...fields };
}

function respond(status, body) {
  return () => Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
}

// Runs the verb once. `answer(url, options)` stands in for the network half of fetchWithAuth.
async function run({ argv, body = 'the reply text', answer = respond(200, closed({ stage: 'accepted' })),
  remoteHost = '127.0.0.1', timeoutMs } = {}) {
  const calls = [];
  const stdout = writer();
  const stderr = writer();
  const stdin = stdinOf(body);
  const fetchWithAuth = (url, options) => { calls.push({ url, options }); return answer(url, options); };
  const exit = await replyV1.runReplyV1(argv, { fetchWithAuth, daemonUrl: DAEMON_URL, remoteHost,
    stdin: stdin.stream, stdout, stderr, timeoutMs });
  const lines = stdout.text.split('\n').filter(Boolean);
  return { exit, calls, stdout: stdout.text, stderr: stderr.text, lines, result: lines.length ? JSON.parse(lines[0]) : null,
    stdinRead: stdin.state.read };
}

function assertTokenAbsent(t, out, label) {
  for (const text of [out.stdout, out.stderr]) {
    assert.equal(text.includes(t.token), false, `${label}: token printed`);
    assert.equal(text.includes(t.secret), false, `${label}: secret printed`);
  }
}

// ── Part 1: in-process ───────────────────────────────────────────────────────────────────────────────────────────

test('U17 boot-capabilities: reply-v1 is the last verb of the sealed line and the reference validator accepts it', () => {
  const doc = JSON.parse(cli.bootCapabilitiesLine());
  assert.deepEqual(doc.verbs, ['allow-create-v1', 'inject-bound-v1', 'clear-strand-v1', 'reply-v1']);
  const parsed = cli.parseBootCapabilities(`${cli.bootCapabilitiesLine()}\n`, 0);
  assert.equal(parsed.supported, true);
  assert.ok(parsed.verbs.includes('reply-v1'));
});

test('U17 request: exactly one POST to the local consume route, closed body, readOnlyAuth, JSON, 30 s signal', async () => {
  const t = makeToken();
  const out = await run({ argv: [t.token], body: 'hello reply' });
  assert.equal(out.exit, 0);
  assert.equal(out.calls.length, 1);
  const [{ url, options }] = out.calls;
  assert.equal(url, ROUTE_URL);
  assert.equal(options.method, 'POST');
  assert.equal(options.readOnlyAuth, true);
  assert.equal(options.redirect, 'error');
  assert.equal(new Headers(options.headers).get('content-type'), 'application/json');
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(options.body), { v: 1, capability: t.token, body: 'hello reply' });
  assert.deepEqual(Object.keys(JSON.parse(options.body)), ['v', 'capability', 'body']);
  assert.equal(replyV1.REQUEST_TIMEOUT_MS, 30000);
});

test('U17 --file: the body comes from the file and stdin is not read; the file is left unchanged', async () => {
  const t = makeToken();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-v1-file-'));
  try {
    const file = path.join(dir, 'reply.txt');
    fs.writeFileSync(file, 'from the file\n');
    const before = fs.statSync(file);
    const out = await run({ argv: [t.token, '--file', file], body: 'from stdin' });
    assert.equal(out.exit, 0);
    assert.equal(out.stdinRead, false);
    assert.equal(JSON.parse(out.calls[0].options.body).body, 'from the file\n');
    assert.deepEqual(fs.readdirSync(dir), ['reply.txt']);
    assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
    const missing = await run({ argv: [t.token, '--file', path.join(dir, 'absent.txt')] });
    assert.equal(missing.exit, 2);
    assert.equal(missing.result.reason, 'REPLY_CLI_BODY_INVALID');
    assert.equal(missing.calls.length, 0);
    assertTokenAbsent(t, missing, 'missing file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('U17 argv: usage and malformed tokens are refused locally (exit 2, closed shape, no request, token never echoed)', async () => {
  const t = makeToken();
  const cases = [
    { argv: [], reason: 'REPLY_CLI_USAGE' },
    { argv: ['--help'], reason: 'REPLY_CLI_USAGE' },
    { argv: [t.token, '--help'], reason: 'REPLY_CLI_USAGE' },
    { argv: ['--help', t.token], reason: 'REPLY_CLI_USAGE' },
    { argv: [t.token, t.token], reason: 'REPLY_CLI_USAGE' },
    { argv: [t.token, '--file'], reason: 'REPLY_CLI_USAGE' },
    { argv: [t.token, '--host', 'example.com'], reason: 'REPLY_CLI_USAGE' },
    { argv: ['--file', 'reply.txt', t.token], reason: 'REPLY_CLI_USAGE' },
    { argv: [`${t.token}x`], reason: 'REPLY_CLI_TOKEN_INVALID' },
    { argv: [t.token.slice(0, -1)], reason: 'REPLY_CLI_TOKEN_INVALID' },
    { argv: [t.token.replace('rc1.', 'rc2.')], reason: 'REPLY_CLI_TOKEN_INVALID' },
    { argv: [`${t.token}\n`], reason: 'REPLY_CLI_TOKEN_INVALID' },
    { argv: [`${t.token.slice(0, 30)}+${t.token.slice(31)}`], reason: 'REPLY_CLI_TOKEN_INVALID' },
  ];
  for (const c of cases) {
    const out = await run({ argv: c.argv });
    assert.equal(out.exit, 2, JSON.stringify(c.reason));
    assert.equal(out.calls.length, 0, `${c.reason}: no request`);
    assert.equal(out.lines.length, 1);
    assert.deepEqual(out.result, closed({ reason: c.reason }));
    assert.ok(out.stderr.length > 0);
    assertTokenAbsent(t, out, c.reason);
  }
});

test('U17 remote host: a non-canonical TELEPTY_HOST is refused before stdin is read and before any request', async () => {
  const t = makeToken();
  for (const remoteHost of ['example.com', 'localhost', '10.0.0.5', '', null]) {
    const out = await run({ argv: [t.token], remoteHost });
    assert.equal(out.exit, 2);
    assert.equal(out.calls.length, 0);
    assert.equal(out.stdinRead, false);
    assert.deepEqual(out.result, closed({ reason: 'REPLY_CLI_REMOTE_HOST_REFUSED' }));
    assertTokenAbsent(t, out, 'remote host');
  }
});

test('U17 body bounds: empty, > 64 KiB, invalid UTF-8 and NUL are refused locally; exactly 64 KiB is sent', async () => {
  const t = makeToken();
  const refusals = [
    { body: '', reason: 'REPLY_CLI_BODY_EMPTY' },
    { body: null, reason: 'REPLY_CLI_BODY_EMPTY' },
    { body: Buffer.alloc(65537, 0x61), reason: 'REPLY_CLI_BODY_TOO_LARGE' },
    { body: Buffer.alloc(1024 * 1024, 0x61), reason: 'REPLY_CLI_BODY_TOO_LARGE' },
    { body: Buffer.from([0x68, 0xff, 0x69]), reason: 'REPLY_CLI_BODY_INVALID' },
    { body: 'a\0b', reason: 'REPLY_CLI_BODY_INVALID' },
    { body: Buffer.alloc(65536, 0x01), reason: 'REPLY_CLI_BODY_TOO_LARGE' },
  ];
  for (const c of refusals) {
    const out = await run({ argv: [t.token], body: c.body });
    assert.equal(out.exit, 2, c.reason);
    assert.equal(out.calls.length, 0, `${c.reason}: no request`);
    assert.deepEqual(out.result, closed({ reason: c.reason }));
    assertTokenAbsent(t, out, c.reason);
  }
  const max = await run({ argv: [t.token], body: Buffer.alloc(65536, 0x61) });
  assert.equal(max.exit, 0);
  assert.equal(max.calls.length, 1);
  assert.equal(Buffer.byteLength(JSON.parse(max.calls[0].options.body).body), 65536);
});

test('U17 exit codes: every closed answer maps by stage and is printed verbatim', async () => {
  const t = makeToken();
  const accepted = closed({ stage: 'accepted', outcome: 'delivered', capability_id: t.id,
    reply_inject_id: crypto.randomUUID(), destination_session_id: 'ts-inbox-1' });
  const rows = [
    { status: 200, body: accepted, exit: 0 },
    { status: 200, body: { ...accepted, outcome: 'queued' }, exit: 0 },
    { status: 200, body: { ...accepted, replayed: true }, exit: 0 },
    { status: 404, body: { ...closed({ reason: 'REPLY_CAPABILITY_UNKNOWN' }), daemon_started_at: '2026-11-21T00:00:00.000Z' }, exit: 2 },
    { status: 400, body: closed({ reason: 'REPLY_REQUEST_INVALID' }), exit: 2 },
    { status: 403, body: closed({ reason: 'REPLY_TRANSPORT_REFUSED' }), exit: 2 },
    { status: 403, body: closed({ reason: 'REPLY_SENDER_MISMATCH', capability_id: t.id }), exit: 2 },
    { status: 403, body: closed({ reason: 'PEER_INJECT_BLOCKED', capability_id: t.id }), exit: 2 },
    { status: 409, body: closed({ reason: 'REPLY_CAPABILITY_IN_FLIGHT', capability_id: t.id, retryable: true }), exit: 2 },
    { status: 409, body: closed({ reason: 'REPLY_CAPABILITY_CONSUMED', capability_id: t.id }), exit: 2 },
    { status: 410, body: closed({ reason: 'REPLY_CAPABILITY_EXPIRED', capability_id: t.id }), exit: 2 },
    { status: 410, body: closed({ reason: 'REPLY_CAPABILITY_SUPERSEDED', capability_id: t.id }), exit: 2 },
    { status: 410, body: closed({ reason: 'REPLY_DESTINATION_GONE', capability_id: t.id }), exit: 2 },
    { status: 410, body: closed({ reason: 'REPLY_CAPABILITY_VOID', capability_id: t.id }), exit: 2 },
    { status: 503, body: closed({ reason: 'REPLY_CAPABILITY_UNAVAILABLE' }), exit: 2 },
    { status: 503, body: closed({ reason: 'BODY_CUSTODY_FULL', capability_id: t.id, retryable: true }), exit: 2 },
    { status: 500, body: closed({ stage: 'outcome_unknown', capability_id: t.id, reply_inject_id: crypto.randomUUID() }), exit: 3 },
    { status: 500, body: closed({ stage: 'outcome_unknown', capability_id: t.id, replayed: true }), exit: 3 },
  ];
  for (const row of rows) {
    const out = await run({ argv: [t.token], answer: respond(row.status, row.body) });
    const label = `${row.status} ${row.body.stage} ${row.body.reason}`;
    assert.equal(out.exit, row.exit, label);
    assert.equal(out.calls.length, 1, `${label}: exactly one request, no retry`);
    assert.equal(out.lines.length, 1);
    assert.equal(out.lines[0], JSON.stringify(row.body), `${label}: printed verbatim`);
    if (row.exit === 3) assert.match(out.stderr, /do not resend/);
    assertTokenAbsent(t, out, label);
  }
});

test('U17 exit codes: answers without the closed object, and status/stage mismatches (HOLD-1 Q2)', async () => {
  const t = makeToken();
  const rows = [
    { status: 404, body: '<!DOCTYPE html><pre>Cannot POST /api/reply-capability-v1</pre>', exit: 2, stage: 'refused' },
    // GB-05: an unstructured 4xx that is not a positively identified pre-route answer may follow a delivery → exit 3.
    { status: 401, body: { error: 'credential required' }, exit: 3, stage: 'outcome_unknown' },
    { status: 403, body: { error: 'origin denied' }, exit: 3, stage: 'outcome_unknown' },
    { status: 413, body: '', exit: 3, stage: 'outcome_unknown' },
    { status: 200, body: { success: true }, exit: 3, stage: 'outcome_unknown' },
    { status: 500, body: { error: 'Internal Server Error' }, exit: 3, stage: 'outcome_unknown' },
    { status: 200, body: closed({ stage: 'refused', reason: 'REPLY_CAPABILITY_CONSUMED' }), exit: 3, stage: 'outcome_unknown' },
    { status: 409, body: closed({ stage: 'accepted', outcome: 'delivered' }), exit: 3, stage: 'outcome_unknown' },
    { status: 200, body: closed({ stage: 'outcome_unknown' }), exit: 3, stage: 'outcome_unknown' },
    { status: 200, body: { ...closed({ stage: 'accepted' }), token: 'x' }, exit: 3, stage: 'outcome_unknown' },
    { status: 409, body: { ...closed({ reason: 'X' }), retryable: 'yes' }, exit: 3, stage: 'outcome_unknown' },
    { status: 200, body: 'not json', exit: 4, stage: 'outcome_unknown' },
    { status: 502, body: '<html>bad gateway</html>', exit: 4, stage: 'outcome_unknown' },
  ];
  for (const row of rows) {
    const out = await run({ argv: [t.token], answer: respond(row.status, row.body) });
    const label = `${row.status} ${JSON.stringify(row.body).slice(0, 60)}`;
    assert.equal(out.exit, row.exit, label);
    assert.equal(out.calls.length, 1, `${label}: no retry`);
    assert.deepEqual(out.result, { ...closed({ stage: row.stage, reason: 'REPLY_CLI_RESPONSE_UNRECOGNIZED',
      retryable: row.exit === 4 }), http_status: row.status }, label);
    assertTokenAbsent(t, out, label);
  }
});

// GB-05: exit 2 is reserved for a closed result or an answer the stock daemon provably gives before the consume route
// runs. The stock pre-route bodies are exact (src/protocol/http-auth.js:153-158,220); every other 4xx is exit 3.
test('GB-05 an unstructured 4xx is exit 3 (outcome unknown) unless it is a positively identified pre-route answer', async () => {
  const t = makeToken();
  const rows = [
    { status: 403, body: { error: 'Forbidden: browser origin not allowed.', code: 'ORIGIN_NOT_ALLOWED' }, exit: 2 },
    { status: 403, body: { error: 'Forbidden: this address is not in TELEPTY_PEER_ALLOWLIST.', code: 'PEER_NOT_ALLOWED' }, exit: 2 },
    { status: 401, body: { error: 'Unauthorized: Invalid or missing token.', code: 'PERMISSION_DENIED' }, exit: 2 },
    { status: 401, body: { error: 'Principal request refused', code: 'PRINCIPAL_PROOF_INVALID' }, exit: 2 },
    { status: 404, body: '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot POST /api/reply-capability-v1</pre>\n</body>\n</html>\n', exit: 2 },
    // Same status, any other shape: not provably before the route.
    { status: 401, body: { error: 'Unauthorized: Invalid or missing token.', code: 'PERMISSION_DENIED', extra: 1 }, exit: 3 },
    { status: 403, body: { error: 'Forbidden: browser origin not allowed.', code: 'PEER_NOT_ALLOWED' }, exit: 3 },
    { status: 409, body: { error: 'Principal request refused', code: 'PRINCIPAL_PROOF_INVALID' }, exit: 3 },
    { status: 400, body: '<!DOCTYPE html><pre>Bad Request</pre>', exit: 3 },
    { status: 404, body: '<!DOCTYPE html><pre>Not Found</pre>', exit: 3 },
    { status: 404, body: { error: 'not here' }, exit: 3 },
    { status: 429, body: '', exit: 3 },
    { status: 499, body: 'proxy closed', exit: 3 },
  ];
  for (const row of rows) {
    const out = await run({ argv: [t.token], answer: respond(row.status, row.body) });
    const label = `${row.status} ${JSON.stringify(row.body).slice(0, 60)}`;
    assert.equal(out.exit, row.exit, label);
    assert.equal(out.calls.length, 1, `${label}: no retry`);
    assert.deepEqual(out.result, { ...closed({ stage: row.exit === 2 ? 'refused' : 'outcome_unknown',
      reason: 'REPLY_CLI_RESPONSE_UNRECOGNIZED' }), http_status: row.status }, label);
    if (row.exit === 3) assert.match(out.stderr, /do not resend/, label);
    else assert.match(out.stderr, /Nothing was written/, label);
    assertTokenAbsent(t, out, label);
  }
});

// GB-07: one deadline bounds reading the source and the request. A source that never ends is a local refusal, nothing sent.
test('GB-07 a stdin that never ends is refused at the deadline: exit 2, no request, the stream is destroyed, no timer left', { timeout: 10000 }, async () => {
  const t = makeToken();
  const stdout = writer();
  const stderr = writer();
  const endless = new Readable({ read() {} });   // never pushes, never ends
  let calls = 0;
  const liveTimers = () => process.getActiveResourcesInfo().filter(name => name === 'Timeout').length;
  const before = liveTimers();
  const exit = await replyV1.runReplyV1([t.token], {
    fetchWithAuth: () => { calls += 1; return Promise.resolve(new Response('{}', { status: 200 })); },
    daemonUrl: DAEMON_URL, remoteHost: '127.0.0.1', stdin: endless, stdout, stderr, timeoutMs: 50,
  });
  assert.equal(exit, 2);
  assert.equal(calls, 0);
  assert.deepEqual(JSON.parse(stdout.text), closed({ reason: 'REPLY_CLI_BODY_TIMEOUT' }));
  assert.match(stderr.text, /Nothing was sent/);
  assert.equal(endless.destroyed, true);
  assert.equal(liveTimers(), before, 'the deadline timer is cleared');
  assertTokenAbsent(t, { stdout: stdout.text, stderr: stderr.text }, 'endless stdin');
});

test('GB-07 a stdin that trickles past the deadline is refused; one that ends in time is sent with the time left', { timeout: 10000 }, async () => {
  const t = makeToken();
  const trickle = new Readable({ read() {} });
  const timer = setInterval(() => trickle.push('x'), 5);
  try {
    const stdout = writer();
    let calls = 0;
    const exit = await replyV1.runReplyV1([t.token], {
      fetchWithAuth: () => { calls += 1; return Promise.resolve(new Response('{}', { status: 200 })); },
      daemonUrl: DAEMON_URL, remoteHost: '127.0.0.1', stdin: trickle, stdout, stderr: writer(), timeoutMs: 60,
    });
    assert.equal(exit, 2);
    assert.equal(calls, 0);
    assert.equal(JSON.parse(stdout.text).reason, 'REPLY_CLI_BODY_TIMEOUT');
  } finally {
    clearInterval(timer);
  }
  const ok = await run({ argv: [t.token], body: 'in time', timeoutMs: 5000 });
  assert.equal(ok.exit, 0);
  assert.equal(ok.calls.length, 1);
});

test('GB-07 --file reads only a regular file: a directory is refused locally before any request', async () => {
  const t = makeToken();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-v1-dir-'));
  try {
    const out = await run({ argv: [t.token, '--file', dir] });
    assert.equal(out.exit, 2);
    assert.equal(out.calls.length, 0);
    assert.equal(out.result.reason, 'REPLY_CLI_BODY_INVALID');
    assert.equal(out.stdinRead, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('U17 no response: a rejected fetch, a timeout, headers then a body read error, and an oversized body are exit 4 (never 2)', async () => {
  const t = makeToken();
  const enc = new TextEncoder();
  const failingBody = status => () => Promise.resolve(new Response(new ReadableStream({
    start(controller) { controller.enqueue(enc.encode('{"schema":"telepty.reply')); controller.error(new Error(`reset ${t.token}`)); },
  }), { status }));
  const rows = [
    { label: 'rejected', answer: () => Promise.reject(new Error(`ECONNREFUSED ${t.token}`)), http: null },
    { label: 'timeout', timeoutMs: 20, http: null,
      answer: (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason))) },
    { label: 'body error after 409 headers', answer: failingBody(409), http: 409 },
    { label: 'body error after 200 headers', answer: failingBody(200), http: 200 },
    { label: 'oversized 404', answer: respond(404, JSON.stringify({ ...closed({ reason: 'REPLY_CAPABILITY_UNKNOWN' }), pad: 'p'.repeat(16 * 1024) })), http: 404 },
    { label: 'oversized 200', answer: respond(200, 'x'.repeat(16 * 1024 + 1)), http: 200 },
  ];
  for (const row of rows) {
    const out = await run({ argv: [t.token], answer: row.answer, timeoutMs: row.timeoutMs });
    assert.equal(out.exit, 4, row.label);
    assert.equal(out.calls.length, 1, `${row.label}: no retry`);
    assert.deepEqual(out.result, { ...closed({ stage: 'outcome_unknown', reason: 'REPLY_CLI_NO_RESPONSE', retryable: true }),
      http_status: row.http }, row.label);
    assert.match(out.stderr, /SAME command again is safe/);
    assertTokenAbsent(t, out, row.label);
  }
  const atCap = closed({ reason: 'REPLY_CAPABILITY_UNKNOWN' });
  const padded = JSON.stringify(atCap);
  const exact = padded + ' '.repeat(16 * 1024 - Buffer.byteLength(padded));
  const capOut = await run({ argv: [t.token], answer: respond(404, exact) });
  assert.equal(capOut.exit, 2, 'a response of exactly 16 KiB is read');
});

// task1292 rc-fix2: the deadline is the CLI's own. Neither fake below holds a handle or honours the abort, so only the
// CLI's timer can end the call; with an unref'd timer the event loop empties and the call never settles.
test('U17 deadline: a fetch that never settles and a body that never ends are exit 4 at the deadline; no timer outlives a call', async () => {
  const t = makeToken();
  const rows = [
    { label: 'fetch never settles, signal ignored', answer: () => new Promise(() => {}), http: null },
    { label: '200 headers, then a body that never ends and ignores cancel', http: 200,
      answer: () => Promise.resolve(new Response(new ReadableStream({
        pull() { return new Promise(() => {}); }, cancel() { return new Promise(() => {}); },
      }), { status: 200 })) },
  ];
  for (const row of rows) {
    const out = await run({ argv: [t.token], answer: row.answer, timeoutMs: 20 });
    assert.equal(out.exit, 4, row.label);
    assert.equal(out.calls.length, 1, `${row.label}: no retry`);
    assert.deepEqual(out.result, { ...closed({ stage: 'outcome_unknown', reason: 'REPLY_CLI_NO_RESPONSE', retryable: true }),
      http_status: row.http }, row.label);
    assert.match(out.stderr, /SAME command again is safe/);
    assertTokenAbsent(t, out, row.label);
  }
  const liveTimers = () => process.getActiveResourcesInfo().filter(name => name === 'Timeout').length;
  const before = liveTimers();
  assert.equal((await run({ argv: [t.token] })).exit, 0);
  assert.equal((await run({ argv: [t.token], answer: () => { throw new Error('no host token'); } })).exit, 2);
  assert.equal((await run({ argv: [t.token], answer: () => new Promise(() => {}), timeoutMs: 20 })).exit, 4);
  assert.equal(liveTimers(), before, 'the deadline timer is cleared on every return path');
});

test('U17 host token: a synchronous fetchWithAuth throw (no token) is exit 2 HOST_TOKEN_UNAVAILABLE before any socket', async () => {
  const t = makeToken();
  const stdout = writer();
  const stderr = writer();
  let calls = 0;
  const exit = await replyV1.runReplyV1([t.token], {
    fetchWithAuth: () => { calls += 1; throw new Error(`config unreadable ${t.token}`); },
    daemonUrl: DAEMON_URL, remoteHost: '127.0.0.1', stdin: stdinOf('reply').stream, stdout, stderr,
  });
  assert.equal(exit, 2);
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(stdout.text), closed({ reason: 'REPLY_CLI_HOST_TOKEN_UNAVAILABLE' }));
  assertTokenAbsent(t, { stdout: stdout.text, stderr: stderr.text }, 'host token');
});

// ── Part 2: process ──────────────────────────────────────────────────────────────────────────────────────────────

function minimalEnv(home, extra = {}) {
  const env = { PATH: process.env.PATH, HOME: home, ...extra };
  if (process.platform === 'win32') { env.USERPROFILE = home; env.SystemRoot = process.env.SystemRoot; }
  return env;
}

function runCliProcess(argv, env, stdinText, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['cli.js', ...argv], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`reply-v1 did not exit within ${timeoutMs} ms`)); }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    // 'close', not 'exit': at 'exit' the child's stdout may still hold unread data (Node child_process docs).
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(stdinText);
  });
}

function tree(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    out.push(path.relative(dir, full));
    if (entry.isDirectory()) out.push(...tree(full).map(p => path.join(entry.name, p)));
  }
  return out.sort();
}

test('U17 process: env {PATH, HOME} with no host token → exit 2 HOST_TOKEN_UNAVAILABLE, and no file is written', async () => {
  const t = makeToken();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-v1-home-'));
  try {
    const r = await runCliProcess(['reply-v1', t.token], minimalEnv(home), 'a reply');
    assert.equal(r.code, 2, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), closed({ reason: 'REPLY_CLI_HOST_TOKEN_UNAVAILABLE' }));
    assert.deepEqual(tree(home), [], 'HOME stays empty: no ~/.telepty, no config.json minted');
    assert.equal(r.stdout.includes(t.secret) || r.stderr.includes(t.secret), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// GB-07: a FIFO with no writer used to block the synchronous open forever (the token stays in argv). It is now refused
// locally at once. POSIX only: mkfifo has no Windows equivalent reachable from a path (a named pipe needs a live server).
test('GB-07 process: --file naming a FIFO with no writer is refused at once (exit 2, nothing sent)', {
  skip: process.platform === 'win32' ? 'mkfifo is POSIX-only' : false, timeout: 30000,
}, async () => {
  const t = makeToken();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-v1-fifo-'));
  try {
    const fifo = path.join(home, 'reply.fifo');
    const made = require('node:child_process').spawnSync('mkfifo', [fifo]);
    assert.equal(made.status, 0, 'PRECONDITION: mkfifo');
    const r = await runCliProcess(['reply-v1', t.token, '--file', fifo], minimalEnv(home), '', 15000);
    assert.equal(r.code, 2, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), closed({ reason: 'REPLY_CLI_BODY_INVALID' }));
    assert.equal(r.stdout.includes(t.secret) || r.stderr.includes(t.secret), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// GB-06: the command the daemon prints must run as printed in every shell: no `<` redirection, and its argv is exactly the
// verb's --file form.
test('GB-06 the trailer\'s printed command uses --file (no input redirection) and parses as the verb\'s argv', () => {
  const t = makeToken();
  const trailer = require(path.join(ROOT, 'src', 'reply-capability.js')).replyCapabilityTrailer({ id: t.id, token: t.token, not_after_ms: 1795262400000 });
  const lines = trailer.split('\n').filter(line => line.trimStart().startsWith('telepty reply-v1 '));
  assert.equal(lines.length, 1);
  assert.equal(/[<>|]/.test(lines[0]), false, 'no shell redirection or pipe in the printed command');
  const argv = lines[0].trim().split(/\s+/).slice(2);
  assert.deepEqual(argv, [t.token, '--file', 'reply.txt']);
  assert.deepEqual(replyV1.parseReplyArgv(argv), { ok: true, token: t.token, file: 'reply.txt' });
});

test('U17 process: env {PATH, HOME} plus the daemon port, real daemon → host token from config.json, closed UNKNOWN answer, exit 2', async () => {
  const { startTestDaemon } = require('../test-support/daemon-harness');
  const daemon = await startTestDaemon();
  try {
    const t = makeToken();
    const r = await runCliProcess(['reply-v1', t.token], minimalEnv(daemon.homeDir, { TELEPTY_PORT: String(daemon.port) }), 'a reply');
    assert.equal(r.code, 2, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.schema, RESULT_SCHEMA);
    assert.equal(result.stage, 'refused');
    assert.equal(result.reason, 'REPLY_CAPABILITY_UNKNOWN');
    assert.equal(result.capability_id, null);
    assert.equal(typeof result.daemon_started_at, 'string');
    assert.equal(r.stdout.split('\n').filter(Boolean).length, 1);
    assert.equal(r.stdout.includes(t.secret) || r.stderr.includes(t.secret), false);
  } finally {
    await daemon.stop();
  }
});
