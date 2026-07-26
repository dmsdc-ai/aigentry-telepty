#!/usr/bin/env node
'use strict';
// #760 fixture capture — real Claude Code 2.1.220, real VT, real modals.
//
// Renders through tmux (own socket `c760`, never the operator's default server — #524) and
// captures BOTH artefacts the fix needs:
//   *.screen.txt — `capture-pane -p`, the rendered surface (readable fixture, what the
//                  #737 tests use for MODAL_SCREEN)
//   *.raw.bin    — `pipe-pane -O`, the raw PTY byte stream (what daemon.js's outputRing
//                  actually holds, and therefore what detectSurfaceModal must decide on)
//
// Shapes:
//   composer — control: the live composer, no modal. Free.
//   ask      — AskUserQuestion option list. Costs one haiku turn.
//   plan     — ExitPlanMode approval. Costs one haiku turn (--permission-mode plan).
//
// HOLD_MS: after the modal is up we sit on it for a while before the final capture. This is
// the load-bearing measurement, not padding — the positional rule only protects anything if
// the composer's watermark does NOT repaint underneath a parked modal. A plan approval can
// stay up for minutes (#760's actual incident), so a footer that ticks would defeat the gate.
//
// SAFETY: we never send Enter into a modal. The plan modal's pre-selected item is
// "1. Yes, auto-accept edits" — activating it would put a real claude into auto-accept and
// let it edit files. Each run captures, then kills its own pane.
//
// usage: node capture-760-claude-modals.js <composer|ask|plan>   [HOLD_MS=45000]

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WORK = '/tmp/c760-work';
const SOCKET = 'c760';
const CLAUDE = process.env.CLAUDE || `${process.env.HOME}/.local/bin/claude`;
const MODEL = process.env.MODEL || 'claude-haiku-4-5-20251001';
const HOLD_MS = Number(process.env.HOLD_MS || 45000);

// Resolve to the matching LITERAL from the whitelist rather than keeping the argv string:
// SHAPE goes into OUT/SESS, which are used as filesystem paths, so the value that reaches
// path.join must not be operator-controlled even in a harness.
const SHAPES = ['composer', 'ask', 'plan'];
const requestedShape = String(process.argv[2] || 'composer');
const SHAPE = SHAPES.find((s) => s === requestedShape);
if (!SHAPE) throw new Error(`unknown shape: ${requestedShape} (want ${SHAPES.join('|')})`);

const SESS = `c760-${SHAPE}`;
const OUT = path.join(WORK, SHAPE);
const DIR = path.join(WORK, 'trusted');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (...a) => execFileSync('tmux', ['-L', SOCKET, ...a], { encoding: 'utf8' });
const cap = () => { try { return tmux('capture-pane', '-p', '-t', SESS); } catch { return ''; } };
const log = (m) => process.stdout.write(m + '\n');
const rawSize = () => { try { return fs.statSync(`${OUT}.raw.bin`).size; } catch { return 0; } };

function typeText(str) {
  const hex = Buffer.from(str, 'utf8').toString('hex').match(/../g);
  tmux('send-keys', '-t', SESS, '-H', ...hex);
}

async function waitFor(pred, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred(cap())) return true;
    await sleep(300);
  }
  log(`[warn] timeout waiting for ${label} (${timeoutMs}ms)`);
  return false;
}

// "The modal is up", read off the RENDERED screen (ground truth — the raw stream is
// Ink-differential and unreadable by eye).
const READY = {
  composer: (s) => /\| \[[█░]+\]/.test(s),
  ask: (s) => /Enter to select/.test(s),
  plan: (s) => /Would you like to proceed\?/.test(s),
};

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  if (!fs.existsSync(path.join(DIR, 'README.md'))) {
    fs.writeFileSync(path.join(DIR, 'README.md'), '# demo\n\nA one-line README for the c760 harness.\n');
  }
  try { tmux('kill-session', '-t', SESS); } catch {}
  try { fs.unlinkSync(`${OUT}.raw.bin`); } catch {}

  const args = ['--model', MODEL];
  if (SHAPE === 'plan') args.push('--permission-mode', 'plan');
  tmux('new-session', '-d', '-s', SESS, '-x', '120', '-y', '40',
    `cd ${DIR} && ${CLAUDE} ${args.join(' ')}`);
  tmux('set-option', '-t', SESS, 'remain-on-exit', 'on');
  // -O = capture output only (what the CLI wrote) = exactly what outputRing accumulates.
  // Set ONCE, after the unlink: a second pipe-pane call would truncate what was captured.
  tmux('pipe-pane', '-O', '-t', SESS, `cat >> ${OUT}.raw.bin`);

  log(`## capture-760 shape=${SHAPE} dir=${DIR} hold=${HOLD_MS}ms`);

  await waitFor((s) => /\| \[[█░]+\]/.test(s), 60000, 'composer');
  if (SHAPE !== 'composer') {
    await sleep(2000);
    typeText(SHAPE === 'ask'
      ? 'Use the AskUserQuestion tool right now to ask me which colour I prefer, with options Red and Blue. Do not do anything else.'
      : 'Read README.md, then immediately call ExitPlanMode with a two-sentence plan to add one comment line to it. Do not ask me anything first.');
    await sleep(700);
    tmux('send-keys', '-t', SESS, 'Enter');
    await waitFor(READY[SHAPE], 180000, `${SHAPE} modal`);
  }

  // ── the measurement: does anything repaint underneath a parked modal? ──
  const atModal = rawSize();
  const screenAtModal = cap();
  log(`[modal-up] raw=${atModal}B — holding ${HOLD_MS}ms`);
  await sleep(HOLD_MS);
  const afterHold = rawSize();
  const screenAfterHold = cap();
  log(`[after-hold] raw=${afterHold}B (+${afterHold - atModal}B during the hold)`);
  log(`[after-hold] modal still up: ${READY[SHAPE](screenAfterHold)}`);

  fs.writeFileSync(`${OUT}.screen.txt`, screenAfterHold);
  fs.writeFileSync(`${OUT}.hold.json`, JSON.stringify({
    shape: SHAPE, holdMs: HOLD_MS,
    rawBytesAtModal: atModal, rawBytesAfterHold: afterHold, bytesDuringHold: afterHold - atModal,
    modalStillUp: READY[SHAPE](screenAfterHold),
    screenChangedDuringHold: screenAtModal !== screenAfterHold,
  }, null, 2));
  log(screenAfterHold.split('\n').filter((l) => l.trim()).map((l) => '  | ' + l).join('\n'));
  log(`## captured -> ${OUT}.{screen.txt,raw.bin,hold.json}`);

  if (process.env.KEEP !== '1') { try { tmux('kill-session', '-t', SESS); } catch {} }
  process.exit(0);
})().catch((e) => {
  log(`[ERROR] ${e.stack || e.message}`);
  try { tmux('kill-session', '-t', SESS); } catch {}
  process.exit(1);
});
