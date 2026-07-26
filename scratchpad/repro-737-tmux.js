#!/usr/bin/env node
'use strict';
// #737 repro — real codex 0.144.1, real VT, "Update available" modal seeded.
//
// Seeds an ISOLATED CODEX_HOME whose version.json has dismissed_version < latest_version,
// which makes a fresh codex open its blocking update modal instead of the composer. Then
// replays the exact byte shape each telepty inject path writes, and records where the
// text and the CR actually went.
//
// Renders through tmux capture-pane (a real terminal emulator) rather than a regex ANSI
// stripper — proven in #730 that the stripper concatenates partial redraws and lies about
// composer state. Screen state here is ground truth. Own tmux socket (-L c737) so the
// operator's default tmux server is never touched (#524).
//
// SAFETY: the modal's DEFAULT (pre-selected) option is "1. Update now (runs
// `brew upgrade --cask codex`)". A real Enter here shell-executes brew and upgrades the
// operator's codex. PATH is therefore prefixed with a stub `brew` that logs the
// invocation and exits 0 — we capture the fact of the exec without performing it.
//
// env: MODAL=1|0 PATHSHAPE=force|plain|gated GAP_MS=<n> WRAP=1|0 KEEP=1
// usage: node repro-737-tmux.js <tag>

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WORK = '/tmp/c737-work';
const CODEX_HOME = `${WORK}/codex-home`;
const BREW_LOG = `${WORK}/brew-invocations.log`;
const SOCKET = 'c737';
const CODEX = process.env.CODEX || '/opt/homebrew/bin/codex';
const STUB_PORT = Number(process.env.STUB_PORT || 47411);

// Operator-supplied output tag. Reduce to a bare filename, strip anything not
// [A-Za-z0-9._-], then assert the joined path really is inside WORK before any write.
function safeOutPath(outDir, rawTag, fallback) {
  const base = path.basename(String(rawTag || fallback)).replace(/[^A-Za-z0-9._-]/g, '_') || fallback;
  const out = path.resolve(outDir, base);
  if (out !== path.join(path.resolve(outDir), base)) throw new Error(`unsafe output tag: ${rawTag}`);
  return out;
}

const TAG = path.basename(String(process.argv[2] || 'c737-repro')).replace(/[^A-Za-z0-9._-]/g, '_') || 'c737-repro';
const SESS = `c737-${TAG}`;
const OUT = safeOutPath(WORK, TAG, 'c737-repro');
const MODAL = process.env.MODAL !== '0';
const PATHSHAPE = process.env.PATHSHAPE || 'force';
const WRAP = process.env.WRAP !== '0';
// text->CR gap per path. force = daemon.js:3079-3091 (no gate, measured ~3ms end-to-end);
// plain = daemon.js:2021 deferred CR (500ms for a wrapped session); gated = render gate
// (awaitReplReady + awaitInputSettled) before the CR, ~1s+ on a live session.
const GAP_MS = Number(process.env.GAP_MS || ({ force: 5, plain: 500, gated: 1500 }[PATHSHAPE] ?? 5));

const BP_START = '\x1b[200~';
const BP_END = '\x1b[201~';
const BODY = process.env.BODY || 'C737MSG1 dispatch payload from telepty inject';

const lines = [];
const log = (m) => { lines.push(m); process.stdout.write(m + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (...a) => execFileSync('tmux', ['-L', SOCKET, ...a], { encoding: 'utf8' });

// tmux send-keys -H takes hex byte literals, so the bracketed-paste envelope and the
// bare CR go in EXACTLY as telepty writes them.
function writeBytes(str) {
  const hex = Buffer.from(str, 'utf8').toString('hex').match(/../g);
  tmux('send-keys', '-t', SESS, '-H', ...hex);
}
const cap = () => { try { return tmux('capture-pane', '-p', '-t', SESS); } catch { return ''; } };
const composerRow = (screen) => (screen.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('›')).pop() || '');
const modalShowing = (screen) => /Press enter to continue/i.test(screen) && /Update available/i.test(screen);
const paneDead = () => {
  try { return tmux('list-panes', '-t', SESS, '-F', '#{pane_dead}').trim().split('\n')[0] === '1'; }
  catch { return true; }
};
const brewCalls = () => { try { return fs.readFileSync(BREW_LOG, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };

// Fresh CODEX_HOME state per run. MODAL=1 -> dismissed_version < latest_version (fresh
// codex opens the update modal). MODAL=0 -> equal (control: straight to the composer).
function seedCodexHome() {
  fs.mkdirSync(CODEX_HOME, { recursive: true });
  const auth = `${process.env.HOME}/.codex/auth.json`;
  if (!fs.existsSync(`${CODEX_HOME}/auth.json`)) {
    if (!fs.existsSync(auth)) throw new Error('no ~/.codex/auth.json — codex must be logged in');
    fs.copyFileSync(auth, `${CODEX_HOME}/auth.json`);
  }
  fs.writeFileSync(`${CODEX_HOME}/version.json`, JSON.stringify({
    latest_version: '0.145.0',
    last_checked_at: '2126-01-01T00:00:00Z',
    dismissed_version: MODAL ? '0.140.0' : '0.145.0',
  }) + '\n');
  fs.writeFileSync(`${CODEX_HOME}/config.toml`,
    'model = "gpt-5.5"\napproval_policy = "never"\nsandbox_mode = "read-only"\n\n' +
    `[projects."${WORK}"]\ntrust_level = "trusted"\n\n[projects."/private${WORK}"]\ntrust_level = "trusted"\n`);
}

// Stub `brew` — see SAFETY above. Never actually upgrades anything.
function seedBrewStub() {
  fs.mkdirSync(`${WORK}/bin`, { recursive: true });
  fs.writeFileSync(`${WORK}/bin/brew`,
    '#!/bin/sh\n# c737 harness stub — record the exec, never perform the upgrade.\n' +
    `echo "$(date -u +%FT%TZ) brew $*" >> ${BREW_LOG}\n` +
    'echo "c737 stub brew: refused to run \'$*\'"\nexit 0\n');
  fs.chmodSync(`${WORK}/bin/brew`, 0o755);
  try { fs.unlinkSync(BREW_LOG); } catch {}
}

const codexArgs = [
  '--sandbox', 'read-only', '--ask-for-approval', 'never',
  // Point the model provider at a dead loopback port with retries disabled: nothing
  // listens there, so any turn that does start fails instantly with connection-refused.
  // The repro never reaches a real model and costs nothing. #730's harness ran an actual
  // 400-serving stub; not needed here — #737 fires before a turn can ever begin.
  '-c', `model_providers.stub={name="stub",base_url="http://127.0.0.1:${STUB_PORT}/v1",wire_api="responses",request_max_retries=0,stream_max_retries=0}`,
  '-c', 'model_provider="stub"',
];

async function waitFor(pred, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred(cap())) return true;
    await sleep(150);
  }
  log(`[warn] timeout waiting for ${label} (${timeoutMs}ms)`);
  return false;
}

(async () => {
  seedCodexHome();
  seedBrewStub();
  try { tmux('kill-session', '-t', SESS); } catch {}
  tmux('new-session', '-d', '-s', SESS, '-x', '120', '-y', '40',
    `PATH=${WORK}/bin:$PATH CODEX_HOME=${CODEX_HOME} ${CODEX} ${codexArgs.map((a) => `'${a}'`).join(' ')}`);
  // Keep the pane after codex exits, so an exit caused by the modal is observable
  // instead of collapsing the session out from under capture-pane.
  tmux('set-option', '-t', SESS, 'remain-on-exit', 'on');

  log(`## repro-737-tmux tag=${TAG} MODAL=${MODAL ? 1 : 0} PATHSHAPE=${PATHSHAPE} WRAP=${WRAP ? 1 : 0} GAP_MS=${GAP_MS}`);

  const booted = await waitFor(
    (s) => (MODAL ? modalShowing(s) : /gpt-\S+/.test(s)),
    30000, MODAL ? 'update modal' : 'codex composer');
  const screenBoot = cap();
  log(`[boot] booted=${booted} modalShowing=${modalShowing(screenBoot)}`);
  log(`[boot] screen head:\n${screenBoot.split('\n').slice(0, 9).map((l) => '    | ' + l).join('\n')}`);

  // ── the inject ──────────────────────────────────────────────────────────────
  // Body first (bracketed-paste enveloped for a paste-capable CLI — codex is, per
  // src/prompt-symbol-registry.js PASTE_CAPABLE_CLIS), then a SEPARATE bare CR after
  // the per-path gap. Byte-for-byte what deliverInjectionToSession + terminalLevelSubmit
  // put on the wire.
  const tText = Date.now();
  writeBytes(WRAP ? BP_START + BODY + BP_END : BODY);
  await sleep(Math.min(GAP_MS, 400));
  const screenAfterText = cap();
  if (GAP_MS > 400) await sleep(GAP_MS - 400);
  writeBytes('\r');
  const tCr = Date.now();
  await sleep(4000);
  const screenAfterCr = cap();

  const verdict = {
    tag: TAG,
    modalSeeded: MODAL,
    pathShape: PATHSHAPE,
    wrapped: WRAP,
    textToCrMs: tCr - tText,
    modalAtBoot: modalShowing(screenBoot),
    // Did the body land anywhere visible? On the composer path it echoes into the '›'
    // row; absorbed by the modal it appears nowhere at all.
    bodyVisibleAfterText: screenAfterText.includes(BODY.slice(0, 20)),
    bodyVisibleAfterCr: screenAfterCr.includes(BODY.slice(0, 20)),
    composerAfterCr: composerRow(screenAfterCr),
    modalStillShowing: modalShowing(screenAfterCr),
    // THE #737 signature: modal gone, body nowhere, composer empty -> the CR was spent
    // dismissing/activating the modal and the message was never processed.
    messageLost: MODAL && !screenAfterCr.includes(BODY.slice(0, 20)),
    // Worse than "lost": the modal's default item shell-executes brew.
    brewInvocations: brewCalls(),
    codexExited: paneDead(),
  };
  log(`[after text] bodyVisible=${verdict.bodyVisibleAfterText} modalShowing=${modalShowing(screenAfterText)}`);
  log(`[after CR ] bodyVisible=${verdict.bodyVisibleAfterCr} modalShowing=${verdict.modalStillShowing} composer=${JSON.stringify(verdict.composerAfterCr)}`);
  log(`[after CR ] codexExited=${verdict.codexExited} brewInvocations=${verdict.brewInvocations.length}`);
  log(`## VERDICT ${JSON.stringify(verdict)}`);

  fs.writeFileSync(`${OUT}.verdict.json`, JSON.stringify(verdict, null, 2));
  fs.writeFileSync(`${OUT}.screens.txt`,
    `===== boot =====\n${screenBoot}\n\n===== after text (before CR) =====\n${screenAfterText}\n\n===== after CR =====\n${screenAfterCr}\n`);
  fs.writeFileSync(`${OUT}.log`, lines.join('\n') + '\n');

  if (process.env.KEEP !== '1') { try { tmux('kill-session', '-t', SESS); } catch {} }
  process.exit(0);
})().catch((e) => {
  log(`[ERROR] ${e.stack || e.message}`);
  try { tmux('kill-session', '-t', SESS); } catch {}
  process.exit(1);
});
