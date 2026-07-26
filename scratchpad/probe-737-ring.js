#!/usr/bin/env node
'use strict';
// #737 predicate ground-truth probe.
//
// The modal predicate has to read the PTY outputRing, which is a raw BYTE STREAM, not a
// screen — so "the modal text appears in the tail" is NOT the same question as "the modal
// is on screen right now". This captures a real codex 0.144.1 ring across
// boot -> modal -> dismissed -> composer and reports what registry.detectOutput() says at
// each stage, over several tail windows.
//
// This is the false-positive risk that decides the fix's blast radius: the force path is
// production orchestrator dispatch, so a predicate that says "blocked" on a live composer
// would stall every dispatch.
//
// usage: node scratchpad/probe-737-ring.js

const fs = require('fs');
const path = require('path');
const pty = require('node-pty');

const ROOT = path.resolve(__dirname, '..');
const registry = require(path.join(ROOT, 'src', 'prompt-symbol-registry.js'));
const WORK = '/tmp/c737-work';
const CODEX_HOME = `${WORK}/codex-home`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const log = (m) => { out.push(m); process.stdout.write(m + '\n'); };

fs.mkdirSync(CODEX_HOME, { recursive: true });
if (!fs.existsSync(`${CODEX_HOME}/auth.json`)) fs.copyFileSync(`${process.env.HOME}/.codex/auth.json`, `${CODEX_HOME}/auth.json`);
fs.writeFileSync(`${CODEX_HOME}/version.json`, JSON.stringify({
  latest_version: '0.145.0', last_checked_at: '2126-01-01T00:00:00Z', dismissed_version: '0.140.0',
}) + '\n');
fs.writeFileSync(`${CODEX_HOME}/config.toml`,
  'model = "gpt-5.5"\napproval_policy = "never"\nsandbox_mode = "read-only"\n\n' +
  `[projects."${WORK}"]\ntrust_level = "trusted"\n\n[projects."/private${WORK}"]\ntrust_level = "trusted"\n`);

// Mirror daemon.js appendToOutputRing: array of chunks, tail read newest-first up to a
// byte budget (src/submit-gate.js readTail).
const ring = [];
function readTail(maxBytes) {
  let total = 0; const parts = [];
  for (let i = ring.length - 1; i >= 0 && total < maxBytes; i--) { parts.unshift(ring[i]); total += ring[i].length; }
  return parts.join('');
}

const report = (stage) => {
  const row = [`  ${stage.padEnd(24)}`];
  for (const win of [2000, 8000, 32000, 1e9]) {
    const r = registry.detectOutput('codex', readTail(win));
    row.push(`${win === 1e9 ? 'all' : win / 1000 + 'k'}=${r.found ? 'READY' : (r.reason || 'not-found')}`);
  }
  log(row.join('  '));
};

(async () => {
  const p = pty.spawn('/opt/homebrew/bin/codex', [
    '--sandbox', 'read-only', '--ask-for-approval', 'never',
    '-c', 'model_providers.stub={name="stub",base_url="http://127.0.0.1:47411/v1",wire_api="responses",request_max_retries=0,stream_max_retries=0}',
    '-c', 'model_provider="stub"',
  ], {
    name: 'xterm-256color', cols: 120, rows: 40, cwd: WORK,
    env: { ...process.env, CODEX_HOME, PATH: `${WORK}/bin:${process.env.PATH}` },
  });
  p.onData((d) => ring.push(d));

  log('## probe-737-ring — what detectOutput() sees in the PTY ring, per tail window');
  log('  stage                     tail windows');

  await sleep(6000);
  report('1 boot (modal up)');
  const ringAtModal = readTail(1e9);

  // Dismiss the SAFE way: move the selection down twice to "3. Skip until next version",
  // then Enter. Never Enter on the default — that is the brew-exec path (#737).
  p.write('\x1b[B'); await sleep(200);
  p.write('\x1b[B'); await sleep(200);
  p.write('\r');
  await sleep(6000);
  report('2 dismissed (composer)');
  const ringAfter = readTail(1e9);

  // Type + submit a message on the now-live composer, then look again: a real session
  // keeps accumulating, so the modal bytes recede but never disappear from a big window.
  p.write('\x1b[200~hello from the ring probe\x1b[201~'); await sleep(300); p.write('\r');
  await sleep(5000);
  report('3 after a real submit');

  log('');
  log(`  ring bytes: at-modal=${ringAtModal.length}  after-dismiss=${ringAfter.length}  final=${readTail(1e9).length}`);
  log(`  "Press enter to continue" occurrences in final ring: ${(readTail(1e9).match(/Press enter to continue/g) || []).length}`);
  const finalTail = readTail(1e9);
  const lastModal = finalTail.lastIndexOf('Press enter to continue');
  const lastComposer = finalTail.lastIndexOf('OpenAI Codex (v');
  log(`  last modal marker @${lastModal}  last composer marker @${lastComposer}  composerIsLater=${lastComposer > lastModal}`);

  fs.writeFileSync(`${WORK}/probe-737-ring.at-modal.txt`, ringAtModal);
  fs.writeFileSync(`${WORK}/probe-737-ring.final.txt`, finalTail);
  fs.writeFileSync(`${WORK}/probe-737-ring.log`, out.join('\n') + '\n');
  p.kill();
  process.exit(0);
})().catch((e) => { log(`[ERROR] ${e.stack || e.message}`); process.exit(1); });
