#!/usr/bin/env node
'use strict';
// #760 probe — which claude signals survive POSITIONALLY on the append-only PTY ring?
//
// #737 proved presence-checks are wrong here: the ring keeps every frame ever painted, so
// "did a modal string ever appear" is true forever. The only usable question is "did the
// modal paint AFTER the last live-composer paint". This probe measures, for each captured
// raw stream, the last index of every candidate modal marker and every candidate composer
// counter-signal — over several tail windows, because the delivery path reads a BOUNDED
// tail (daemon.js MODAL_RING_TAIL_BYTES) and a signal that only survives on the full
// stream would be useless there.
//
// usage: node probe-760-signals.js

const fs = require('fs');
const path = require('path');
const registry = require('../src/prompt-symbol-registry');

const WORK = '/tmp/c760-work';
const SHAPES = ['composer', 'ask', 'plan'];

// Candidate MODAL markers — the footer/label each blocking claude surface paints.
//
// EVERY pattern is whitespace-TOLERANT (`\s*` between tokens, never a literal space). That
// is not cosmetic: claude's Ink renderer paints differentially, emitting ESC[<n>C cursor
// jumps instead of runs of spaces, so after stripAnsi the stream reads
// "Entertoselect·↑/↓tonavigate·Esctocancel". A literal-space pattern matches the rendered
// screen and MISSES the byte stream the delivery path actually reads. Measured: grep -F
// "Enter to select" over ask.raw.bin => 0 hits, while the screen shows it plainly.
const MODAL_CANDIDATES = {
  select_footer: /Enter\s*to\s*select/,
  esc_to_cancel: /Esc\s*to\s*(cancel|skip)/,
  plan_ready: /Ready\s*to\s*code\?/,
  plan_header: /Here\s*is\s*Claude's\s*plan/,
  plan_proceed: /Would\s*you\s*like\s*to\s*proceed\?/,
  plan_accept: /Yes,\s*auto-accept\s*edits/,
  trust_confirm: /Yes,\s*I\s*trust\s*this\s*folder/,
  onboard_theme: /Choose\s*the\s*text\s*style/,
  onboard_login: /Select\s*login\s*method/,
};

// Candidate COMPOSER counter-signals — what only a live, injectable composer paints.
const COMPOSER_CANDIDATES = {
  ctx_meter: /\|\s*\[[█░\s]*\]\s*\d+%/,
  ctx_tokens: /\d+(\.\d+)?K?\s*\/\s*\d+(\.\d+)?K/,
  mode_line: /(⏸|▶)\s*\S[^\n]*mode\s*on/,
  composer_frame: /─{10,}\n[❯>][^\n]*\n─{10,}/,
};

function lastIdx(text, re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let last = -1, m;
  while ((m = g.exec(text)) !== null) { last = m.index; if (m.index === g.lastIndex) g.lastIndex++; }
  return last;
}

for (const shape of SHAPES) {
  const p = path.join(WORK, `${shape}.raw.bin`);
  if (!fs.existsSync(p)) { console.log(`\n## ${shape}: MISSING ${p}`); continue; }
  const full = fs.readFileSync(p, 'utf8');
  console.log(`\n## ${shape}  raw=${full.length}B`);
  for (const win of [8192, 32768, 65536, full.length]) {
    const text = registry.normalizeOutputForDetection(full.slice(-win));
    const modal = Object.entries(MODAL_CANDIDATES)
      .map(([k, re]) => [k, lastIdx(text, re)]).filter(([, i]) => i >= 0);
    const comp = Object.entries(COMPOSER_CANDIDATES)
      .map(([k, re]) => [k, lastIdx(text, re)]).filter(([, i]) => i >= 0);
    const modalAt = modal.reduce((a, [, i]) => Math.max(a, i), -1);
    const compAt = comp.reduce((a, [, i]) => Math.max(a, i), -1);
    const verdict = modalAt === -1 ? 'NO-MODAL' : (modalAt > compAt ? 'BLOCKED' : 'clear');
    console.log(`  win=${String(win).padStart(7)} norm=${String(text.length).padStart(6)}B  ${verdict.padEnd(9)}`
      + ` modalAt=${String(modalAt).padStart(6)} composerAt=${String(compAt).padStart(6)}`);
    if (win === 65536) {
      console.log(`      modal hits    : ${modal.map(([k, i]) => `${k}@${i}`).join(' ') || '(none)'}`);
      console.log(`      composer hits : ${comp.map(([k, i]) => `${k}@${i}`).join(' ') || '(none)'}`);
    }
  }
}
