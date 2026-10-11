'use strict';

// task 1215 (S1 §1b) — the test-owned SENDER that runs INSIDE a real `telepty allow` PTY.
//
// Its one job is to hold the bearer the daemon minted at FIRST registration exactly the way a real
// wrapped CLI does: cli.js puts TELEPTY_SESSION_TOKEN into the child's spawn-time environment
// (cli.js:2498,2511), and nothing outside this process can ever update it. It is read ONCE below
// and then presented on every inject, so a daemon restart, a GC + fresh re-registration, or a
// dropped verifier is observed against the credential the child really has — never a fresh copy.
//
// Secret hygiene: the bearer and the daemon token are never printed, logged or written anywhere.
// Output is booleans, the caller-chosen tag and an HTTP status only. The test that drives this
// process never sees the bearer either; it reads the daemon's audit rows instead.
//
// Commands, one per PTY line (delivered by an operator inject into this session, CR-submitted):
//   RCSEND  <target> <tag>          → POST inject {prompt:"rc1215-payload <tag>", from:<own sid>}
//   RCREPLY <target> <nonce> <tag>  → POST inject {prompt:"REPLY <nonce> <tag>",   from:<own sid>}
// Anything else is ignored. After every line it prints a `rc1215> ` prompt, because the bridge
// only writes injected text into the PTY promptly once the output ends in a prompt character
// (cli.js promptPattern / isIdle); without it each delivery waits for the 5 s fallback flush.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SPAWN_BEARER = process.env.TELEPTY_SESSION_TOKEN || null;
const SID = process.env.TELEPTY_SESSION_ID || null;
const HOST = process.env.TELEPTY_HOST || '127.0.0.1';
const PORT = Number(process.env.TELEPTY_PORT);
const PRODUCTION_PORT = 3848;
const REQUEST_TIMEOUT_MS = 10000;
// Bounded lifetime: a fixture child that outlives its test must not linger. The owning bridge
// normally takes it down first (PTY hangup), this is the backstop.
const MAX_LIFETIME_MS = 10 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const PROMPT = 'rc1215> ';

function say(line) {
  process.stdout.write(`${line}\n${PROMPT}`);
}

// Loopback fixture daemons only: never the production port, never a non-loopback host.
if (!['127.0.0.1', 'localhost'].includes(HOST) || !Number.isInteger(PORT) || PORT < 1 || PORT > 65535
    || PORT === PRODUCTION_PORT) {
  say('RC-CHILD-REFUSED endpoint_not_a_loopback_fixture');
  process.exit(2);
}

setTimeout(() => process.exit(0), MAX_LIFETIME_MS).unref();

// The daemon (HTTP auth) token, re-read per request the way the CLI resolves it: env first, then
// the isolated HOME's config.json. Never cached, never printed.
function daemonToken() {
  if (process.env.TELEPTY_AUTH_TOKEN) return process.env.TELEPTY_AUTH_TOKEN;
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.telepty', 'config.json'), 'utf8')).authToken || null;
  } catch {
    return null;
  }
}

async function postInject(target, prompt) {
  const headers = { 'Content-Type': 'application/json' };
  const token = daemonToken();
  if (token) headers['x-telepty-token'] = token;
  if (SPAWN_BEARER) headers['x-telepty-session-token'] = SPAWN_BEARER;
  const res = await fetch(`http://${HOST}:${PORT}/api/sessions/${encodeURIComponent(target)}/inject`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt, from: SID }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  await res.arrayBuffer().catch(() => {});
  return res.status;
}

async function report(tag, send) {
  try {
    say(`RC-SENT ${tag} status=${await send()}`);
  } catch (err) {
    const code = (err && err.cause && err.cause.code) || (err && err.name) || 'error';
    say(`RC-SEND-ERROR ${tag} ${code}`);
  }
}

async function handle(line) {
  const parts = line.trim().split(/\s+/);
  if (parts[0] === 'RCSEND' && parts.length === 3 && ID_RE.test(parts[1]) && ID_RE.test(parts[2])) {
    const [, target, tag] = parts;
    await report(tag, () => postInject(target, `rc1215-payload ${tag}`));
    return;
  }
  if (parts[0] === 'RCREPLY' && parts.length === 4 && ID_RE.test(parts[1]) && NONCE_RE.test(parts[2])
      && ID_RE.test(parts[3])) {
    const [, target, nonce, tag] = parts;
    await report(tag, () => postInject(target, `REPLY ${nonce} ${tag}`));
    return;
  }
  process.stdout.write(PROMPT);
}

// Line framing by hand rather than readline: CR, LF and CRLF all end a line, so the outcome does
// not depend on whether the PTY line discipline translated the submit CR.
let pending = '';
let chain = Promise.resolve();
process.stdin.on('data', (chunk) => {
  pending += chunk.toString('utf8');
  const lines = pending.split(/\r\n|\r|\n/);
  pending = lines.pop();
  for (const line of lines) {
    if (line.trim() === '') continue;
    chain = chain.then(() => handle(line));
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));

say(`RC-CHILD-READY has_sid=${Boolean(SID)} has_bearer=${Boolean(SPAWN_BEARER)} `
  + `bearer_shape=${typeof SPAWN_BEARER === 'string' && /^[^.\s]+\.[^.\s]+$/.test(SPAWN_BEARER)}`);
