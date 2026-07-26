#!/usr/bin/env node
'use strict';
// #801 fixture capture — a real AI-CLI hitting a real transport error, real VT.
//
// Same two-artefact shape as #760's capture (screen.txt = what a human/read-screen sees,
// raw.bin = the PTY byte stream daemon.js's outputRing actually holds). The #760 lesson is
// the whole reason this exists: claude paints through Ink DIFFERENTIALLY, so a marker
// verified on a rendered snapshot can be absent from the bytes the predicate runs on.
//
// The error is produced by pointing the CLI's base URL at a local stub that answers every
// request with the status/body we want. No real API is touched, no token is spent, and the
// 529 shape is reproducible on demand (the live incident was not).
//
// Shapes:
//   claude-529  — ANTHROPIC_BASE_URL → stub 529 overloaded_error  (the 6x production case)
//   codex-400   — real API, --model gpt-5.6 → the r795cs-adr-review-sol error verbatim
//                 (codex ignores OPENAI_BASE_URL under ChatGPT auth; the real rejection is
//                  byte-identical to the incident, so the stub is not needed for this shape)
//   claude-ok / codex-ok — CONTROL: one real successful turn. The fixture that proves the
//                 discriminator does not fire on a genuine completion.
//
// usage: node capture-801-api-error.js <claude-529|codex-400|claude-ok|codex-ok> [HOLD_MS]

const { execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const WORK = '/tmp/c801-work';
const SOCKET = 'c801';
const CLAUDE = process.env.CLAUDE || `${process.env.HOME}/.local/bin/claude`;
const CODEX = process.env.CODEX || 'codex';
const HOLD_MS = Number(process.env.HOLD_MS || 20000);

const SHAPES = ['claude-529', 'codex-400', 'claude-ok', 'codex-ok'];
const requested = String(process.argv[2] || 'claude-529');
const SHAPE = SHAPES.find((s) => s === requested);
if (!SHAPE) throw new Error(`unknown shape: ${requested} (want ${SHAPES.join('|')})`);

const SESS = `c801-${SHAPE}`;
const OUT = path.join(WORK, SHAPE);
const DIR = path.join(WORK, 'trusted');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (...a) => execFileSync('tmux', ['-L', SOCKET, ...a], { encoding: 'utf8' });
const cap = () => { try { return tmux('capture-pane', '-p', '-t', SESS); } catch { return ''; } };
const log = (m) => process.stdout.write(m + '\n');

function typeText(str) {
  const hex = Buffer.from(str, 'utf8').toString('hex').match(/../g);
  tmux('send-keys', '-t', SESS, '-H', ...hex);
}

async function waitFor(pred, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred(cap())) return true;
    await sleep(400);
  }
  log(`[warn] timeout waiting for ${label} (${timeoutMs}ms) — screen was:`);
  log(cap().split('\n').filter((l) => l.trim()).map((l) => '  ? ' + l).join('\n'));
  return false;
}

// The stub. Answers EVERY route with the failure under test, so it does not matter which
// endpoint the CLI picks (/v1/messages, /responses, /models, …).
const BODIES = {
  'claude-ok': null,
  'codex-ok': null,
  'claude-529': {
    status: 529,
    body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
  },
  'codex-400': {
    status: 400,
    body: {
      type: 'error',
      status: 400,
      error: {
        type: 'invalid_request_error',
        message: "The 'gpt-5.6' model is not supported for this account.",
      },
    },
  },
};

function startStub() {
  if (!BODIES[SHAPE]) return Promise.resolve({ server: { close() {} }, port: 0 });
  const { status, body } = BODIES[SHAPE];
  const payload = JSON.stringify(body);
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(payload);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const READY = {
  'claude-529': (s) => /\[[█░]{5,}\]/.test(s),
  'claude-ok': (s) => /\[[█░]{5,}\]/.test(s),
  'codex-400': (s) => /gpt-\S+\s+\S+(\s+fast|\s*·)/.test(s),
  'codex-ok': (s) => /gpt-\S+\s+\S+(\s+fast|\s*·)/.test(s),
};
// TERMINAL error, not the mid-flight retry banner: claude retries 10x with backoff and
// repaints "✻ 529 Overloaded · Retrying in 8s · attempt 5/10" throughout. Only the state
// AFTER retries are exhausted — error text with no retry line — is the one that goes quiet
// and trips the idle detector.
const ERRORED = {
  'claude-529': (s) => /API Error/i.test(s) && !/Retrying in/.test(s),
  'codex-400': (s) => /invalid_request_error/.test(s),
  // controls: wait for the turn to FINISH successfully instead.
  'claude-ok': (s) => /⏺/.test(s) && !/esc to interrupt/.test(s),
  'codex-ok': (s) => /tokens used/i.test(s) || (/•/.test(s) && !/esc to interrupt/.test(s)),
};

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  try { tmux('kill-session', '-t', SESS); } catch {}
  try { fs.unlinkSync(`${OUT}.raw.bin`); } catch {}

  const { server, port } = await startStub();
  const base = `http://127.0.0.1:${port}`;
  log(`## capture-801 shape=${SHAPE} stub=${base} hold=${HOLD_MS}ms`);

  const CMDS = {
    'claude-529': `cd ${DIR} && ANTHROPIC_BASE_URL=${base} ANTHROPIC_API_KEY=stub-key ${CLAUDE} --model claude-haiku-4-5-20251001`,
    'claude-ok': `cd ${DIR} && ${CLAUDE} --model claude-haiku-4-5-20251001`,
    'codex-400': `cd ${DIR} && ${CODEX} --model gpt-5.6 --sandbox read-only`,
    'codex-ok': `cd ${DIR} && ${CODEX} --sandbox read-only`,
  };
  const cmd = CMDS[SHAPE];

  tmux('new-session', '-d', '-s', SESS, '-x', '120', '-y', '40', cmd);
  tmux('set-option', '-t', SESS, 'remain-on-exit', 'on');
  // -O = output only = exactly what outputRing accumulates.
  tmux('pipe-pane', '-O', '-t', SESS, `cat >> ${OUT}.raw.bin`);

  await waitFor(READY[SHAPE], 60000, 'composer');
  await sleep(1500);
  typeText('say hi');
  await sleep(700);
  tmux('send-keys', '-t', SESS, 'Enter');

  await waitFor(ERRORED[SHAPE], 180000, 'error banner');
  // Hold: the discriminator has to survive whatever the CLI repaints after the error
  // (composer + status footer tick). If a repaint buries the marker, this is where we see it.
  log(`[errored] holding ${HOLD_MS}ms`);
  await sleep(HOLD_MS);

  const screen = cap();
  fs.writeFileSync(`${OUT}.screen.txt`, screen);
  log(screen.split('\n').filter((l) => l.trim()).map((l) => '  | ' + l).join('\n'));
  log(`## captured -> ${OUT}.{screen.txt,raw.bin}`);

  server.close();
  if (process.env.KEEP !== '1') { try { tmux('kill-session', '-t', SESS); } catch {} }
  process.exit(0);
})().catch((e) => {
  log(`[ERROR] ${e.stack || e.message}`);
  try { tmux('kill-session', '-t', SESS); } catch {}
  process.exit(1);
});
