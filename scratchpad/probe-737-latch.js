#!/usr/bin/env node
'use strict';
// #737 predicate design validation, round 2.
//
// probe-737-ring.js proved a ring-TAIL scan is unusable: after the modal is dismissed the
// 8k/32k/full tails still report `codex_modal_ui`, so the predicate would stall every
// dispatch on any codex session that ever showed the modal (and the force path is
// production dispatch).
//
// This probe compares the two candidate rules on the same live session. Result (measured,
// see the run output at the bottom of this file's log):
//
//   A. PER-CHUNK LATCH — REJECTED. Arms correctly on the modal chunk, but never clears:
//      only 1 of 74 chunks carries any signal at all, because codex paints the composer
//      banner incrementally and no single chunk holds both step-2 markers. A hold-remedy
//      built on this would stall forever.
//   B. POSITIONAL LAST-SIGNAL-WINS — CHOSEN. Normalize the tail, take the LAST modal
//      marker and the LAST composer-footer marker, and let position decide. This is what
//      the registry header already says its detectors do ("returns the LAST occurrence
//      ... so transcript echoes earlier in the viewport do not produce false positives");
//      detect() step 1 simply does not honour it, which is why a whole-ring detectOutput()
//      reports codex_modal_ui forever after a dismissal. Window-insensitive: same verdict
//      at 2k / 8k / 32k / full tails.
//
// usage: node scratchpad/probe-737-latch.js

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

// ── candidate A: per-chunk latch, as it would live in appendToOutputRing ─────────────
// Mirrors the shape appendToOutputRing already uses for bracketed-paste capability
// (ESC[?2004h / ?2004l, "last h/l in the chunk wins").
let latch;                                   // undefined = never observed either signal
const MODAL_MARK = /Resume a previous session|^Filter:|Do you trust the contents|Press enter to continue/im;
function classify(chunk) {
  const text = registry.normalizeOutputForDetection(chunk);
  const m = text.search(MODAL_MARK);
  const ready = registry.detectOutput('codex', text).found ? text.length : -1;
  return { modalAt: m, readyAt: ready };
}
function feed(chunk) {
  const { modalAt, readyAt } = classify(chunk);
  if (modalAt === -1 && readyAt === -1) return null;      // no signal — leave latch alone
  latch = modalAt !== -1 && (readyAt === -1 || modalAt > readyAt);
  return { modalAt, readyAt, latch };
}

// ── candidate B: positional last-signal-wins over the ring tail (the chosen rule) ────
const MODAL_G = /Resume a previous session|^Filter:|Do you trust the contents|Press enter to continue/gim;
const FOOTER_G = /gpt-\S+\s+\S+(\s+fast|\s*·)/g;
function lastIdx(text, re) {
  re.lastIndex = 0;
  let last = -1, m;
  while ((m = re.exec(text)) !== null) { last = m.index; if (m.index === re.lastIndex) re.lastIndex++; }
  return last;
}
function positional(ringText) {
  const text = registry.normalizeOutputForDetection(ringText);
  const modalAt = lastIdx(text, MODAL_G);
  const readyAt = lastIdx(text, FOOTER_G);
  return { modalAt, readyAt, blocked: modalAt !== -1 && modalAt > readyAt };
}

const ring = [];
const chunks = [];
(async () => {
  const p = pty.spawn('/opt/homebrew/bin/codex', [
    '--sandbox', 'read-only', '--ask-for-approval', 'never',
    '-c', 'model_providers.stub={name="stub",base_url="http://127.0.0.1:47411/v1",wire_api="responses",request_max_retries=0,stream_max_retries=0}',
    '-c', 'model_provider="stub"',
  ], {
    name: 'xterm-256color', cols: 120, rows: 40, cwd: WORK,
    env: { ...process.env, CODEX_HOME, PATH: `${WORK}/bin:${process.env.PATH}` },
  });
  let stage = '1 boot';
  p.onData((d) => {
    ring.push(d);
    const before = latch;
    const hit = feed(d);
    chunks.push({ stage, len: d.length, hit, latchBefore: before, latchAfter: latch });
  });

  const show = (label, expect) => {
    const p2 = positional(ring.join(''));
    log(`  [${label}]`.padEnd(20) + `latch(A)=${String(latch).padEnd(9)} positional(B)=${String(p2.blocked).padEnd(6)} ` +
        `(modalAt=${p2.modalAt} readyAt=${p2.readyAt})   expect ${expect}`);
  };

  log('## probe-737-latch — per-chunk latch (A) vs positional last-signal-wins (B)');

  await sleep(6000);
  show('1 boot', 'true — modal is up');

  stage = '2 dismiss';
  // Dismiss SAFELY: down twice to "3. Skip until next version", then Enter. Never Enter on
  // the pre-selected default — that is #737's brew-exec-and-exit path.
  p.write('\x1b[B'); await sleep(200);
  p.write('\x1b[B'); await sleep(200);
  p.write('\r');
  await sleep(6000);
  show('2 dismissed', 'false — composer is live');

  stage = '3 submit';
  p.write('\x1b[200~hello from the latch probe\x1b[201~'); await sleep(300); p.write('\r');
  await sleep(6000);
  show('3 after submit', 'false — must never re-arm');

  // B must be window-insensitive: the daemon reads a bounded ring tail, so the verdict
  // cannot depend on how much tail it happened to read.
  log('');
  log('  positional(B) across tail windows (must all agree with stage 3):');
  const full = ring.join('');
  for (const w of [2000, 8000, 32000, 200000]) {
    const p2 = positional(full.slice(-w));
    log(`    tail=${String(w).padStart(6)}  blocked=${p2.blocked}  (modalAt=${p2.modalAt} readyAt=${p2.readyAt})`);
  }

  log('');
  log('  chunks that moved the latch:');
  for (const c of chunks) {
    if (c.hit && c.latchBefore !== c.latchAfter) {
      log(`    ${c.stage.padEnd(10)} len=${String(c.len).padStart(6)}  modalAt=${String(c.hit.modalAt).padStart(6)} readyAt=${String(c.hit.readyAt).padStart(6)}  ${c.latchBefore} -> ${c.latchAfter}`);
    }
  }
  const armedAfterDismiss = chunks.filter((c) => c.stage !== '1 boot' && c.latchAfter === true);
  log('');
  log(`  chunks re-arming the latch after boot: ${armedAfterDismiss.length} (must be 0 once dismissed)`);
  log(`  total chunks=${chunks.length}  signal-bearing=${chunks.filter((c) => c.hit).length}`);

  fs.writeFileSync(`${WORK}/probe-737-latch.log`, out.join('\n') + '\n');
  p.kill();
  process.exit(0);
})().catch((e) => { log(`[ERROR] ${e.stack || e.message}`); process.exit(1); });
