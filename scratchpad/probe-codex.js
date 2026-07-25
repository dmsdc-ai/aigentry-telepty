#!/usr/bin/env node
'use strict';
// #730 exploration probe: spawn REAL codex under node-pty, capture raw PTY bytes,
// then replay the exact byte sequence telepty's --submit --submit-force path writes.
// Read-only w.r.t. product code. Usage: node probe-codex.js <out-prefix>
const pty = require('node-pty');
const fs = require('fs');

const path = require('path');

// Operator-supplied output tag. Reduce to a bare filename, strip anything that is not
// [A-Za-z0-9._-], then assert the joined path really is inside OUTDIR before any write.
function safeOutPath(outDir, rawTag, fallback) {
  const base = path.basename(String(rawTag || fallback)).replace(/[^A-Za-z0-9._-]/g, '_') || fallback;
  const out = path.resolve(outDir, base);
  if (out !== path.join(path.resolve(outDir), base)) throw new Error(`unsafe output tag: ${rawTag}`);
  return out;
}

const OUTDIR = '/tmp/c730-work';
const OUT = safeOutPath(OUTDIR, process.argv[2], 'probe');
const raw = fs.createWriteStream(OUT + '.raw');
const log = (m) => { process.stdout.write(m + '\n'); fs.appendFileSync(OUT + '.log', m + '\n'); };

const p = pty.spawn('/opt/homebrew/bin/codex', ['--sandbox', 'read-only', '--ask-for-approval', 'never'], {
  name: 'xterm-256color', cols: 120, rows: 40, cwd: '/tmp/c730-work',
  env: { ...process.env, TERM: 'xterm-256color' },
});

let all = '';
p.onData((d) => { all += d; raw.write(d); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await sleep(6000);
  log(`[boot] bytes=${all.length}`);
  log(`[boot] emits ESC[?2004h : ${all.includes('\x1b[?2004h')}`);
  log(`[boot] emits ESC[?2004l : ${all.includes('\x1b[?2004l')}`);
  log(`[boot] last 2004h idx=${all.lastIndexOf('\x1b[?2004h')} last 2004l idx=${all.lastIndexOf('\x1b[?2004l')}`);
  fs.writeFileSync(OUT + '.boot.raw', all);

  // Replay the FORCE path byte sequence: body write, then bare CR after `gap` ms.
  const gap = Number(process.env.GAP_MS || 10);
  const wrap = process.env.WRAP === '1';
  const body = 'MSG-ONE-730';
  const payload = wrap ? '\x1b[200~' + body + '\x1b[201~' : body;
  log(`[write] wrap=${wrap} gap=${gap}ms body=${JSON.stringify(body)}`);
  const mark1 = all.length;
  p.write(payload);
  await sleep(gap);
  p.write('\r');
  await sleep(3000);
  fs.writeFileSync(OUT + '.after1.raw', all.slice(mark1));
  log(`[after1] newbytes=${all.length - mark1}`);

  // Second message — the accumulation symptom is visible on msg 2.
  const mark2 = all.length;
  const body2 = 'MSG-TWO-730';
  p.write(wrap ? '\x1b[200~' + body2 + '\x1b[201~' : body2);
  await sleep(gap);
  p.write('\r');
  await sleep(3000);
  fs.writeFileSync(OUT + '.after2.raw', all.slice(mark2));
  log(`[after2] newbytes=${all.length - mark2}`);

  // Manual enter — does it flush the accumulated blob?
  const mark3 = all.length;
  p.write('\r');
  await sleep(3000);
  fs.writeFileSync(OUT + '.afterEnter.raw', all.slice(mark3));
  log(`[afterEnter] newbytes=${all.length - mark3}`);

  fs.writeFileSync(OUT + '.all.raw', all);
  p.kill();
  await sleep(300);
  process.exit(0);
})();
