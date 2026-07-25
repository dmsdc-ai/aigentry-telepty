#!/usr/bin/env node
'use strict';
// #730 repro — real codex 0.144.1, real VT.
//
// Renders through tmux (`capture-pane` is a real terminal emulator) instead of the
// regex ANSI stripper: the stripper concatenates partial redraws, so "last '›' line
// in the byte stream" is NOT the current composer row and silently lies about
// accumulation. Screen state here is ground truth.
//
// Replays the byte sequence telepty's `inject --submit --submit-force` path writes:
//   POST /inject {noEnter:true} -> mailboxDelivery.tick() -> write(maybeBracketedPaste(text))
//   POST /submit {force:true}   -> terminalLevelSubmit -> submitViaPty -> write('\r')
// with NO min text->CR gap and NO settle gate on the force path (daemon.js:3045).
//
// env: WRAP=1|0 GAP_MS=<n> BUSY=1|0 STUB_DELAY_MS=<n> KEEP=1
// usage: node repro-730-tmux.js <tag>

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const path = require('path');

// Operator-supplied output tag. Reduce to a bare filename, strip anything that is not
// [A-Za-z0-9._-], then assert the joined path really is inside OUTDIR before any write.
function safeOutPath(outDir, rawTag, fallback) {
  const base = path.basename(String(rawTag || fallback)).replace(/[^A-Za-z0-9._-]/g, '_') || fallback;
  const out = path.resolve(outDir, base);
  if (out !== path.join(path.resolve(outDir), base)) throw new Error(`unsafe output tag: ${rawTag}`);
  return out;
}

const TAG = path.basename(String(process.argv[2] || 'c730-repro')).replace(/[^A-Za-z0-9._-]/g, '_') || 'c730-repro';
const SESS = `c730-${TAG}`;
const WRAP = process.env.WRAP !== '0';
const GAP_MS = Number(process.env.GAP_MS || 10);
const BUSY = process.env.BUSY === '1';
const STUB_DELAY_MS = Number(process.env.STUB_DELAY_MS || 0);
const STUB_PORT = Number(process.env.STUB_PORT || 47311);
const CODEX = process.env.CODEX || '/opt/homebrew/bin/codex';
const CWD = '/tmp/c730-work';
const OUT = safeOutPath(CWD, TAG, 'c730-repro');

const BP_START = '\x1b[200~';
const BP_END = '\x1b[201~';

const lines = [];
const log = (m) => { lines.push(m); process.stdout.write(m + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (...a) => execFileSync('tmux', a, { encoding: 'utf8' });

// Raw-byte write into the pane. tmux send-keys -H takes hex byte literals, so the
// bracketed-paste envelope and the bare CR go in EXACTLY as telepty writes them.
function writeBytes(str) {
  const hex = Buffer.from(str, 'utf8').toString('hex').match(/../g);
  tmux('send-keys', '-t', SESS, '-H', ...hex);
}
const cap = () => tmux('capture-pane', '-p', '-t', SESS);
// The composer is the '›'-led input row; empty renders the rotating placeholder hint.
const composerRow = (screen) => (screen.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('›')).pop() || '');
const isBusy = (screen) => /esc to interrupt/.test(screen);

// Stub provider. delayMs>0 holds the response open so codex stays deterministically
// BUSY for that long — the state the field reports say triggers accumulation. 400 on
// release ends the turn at once (an unreachable host would retry-storm instead).
//
// Plain HTTP on 127.0.0.1 is deliberate and required: it is codex's `base_url`, and
// giving it TLS would mean provisioning a cert codex trusts, for a throwaway loopback
// listener that serves one static 400 and carries no credentials or payload. Snyk flags
// this as CWE-319; accepted — test-only, never bound off-loopback.
const stub = http.createServer((req, res) => {
  setTimeout(() => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'c730 stub', type: 'invalid_request_error' } }));
  }, STUB_DELAY_MS);
});

const codexArgs = [
  '--sandbox', 'read-only', '--ask-for-approval', 'never',
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

// One inject, telepty force-path shaped: body (optionally paste-wrapped), then a bare
// CR after GAP_MS. Returns the screen truth right after.
async function inject(body, settleMs = 2500) {
  const before = cap();
  const t0 = Date.now();
  writeBytes(WRAP ? BP_START + body + BP_END : body);
  const tText = Date.now();
  await sleep(GAP_MS);
  writeBytes('\r');
  const tCr = Date.now();
  await sleep(settleMs);
  const after = cap();
  return {
    body,
    textToCrMs: tCr - tText,
    busyBefore: isBusy(before),
    busyAfter: isBusy(after),
    composer: composerRow(after),
    // THE symptom: the injected body is still sitting in the composer, unsubmitted.
    parked: composerRow(after).includes(body.split('\n')[0]) || /Pasted text/.test(composerRow(after)),
    elapsedMs: Date.now() - t0,
    screen: after,
  };
}

(async () => {
  stub.listen(STUB_PORT, '127.0.0.1');
  try { tmux('kill-session', '-t', SESS); } catch {}
  tmux('new-session', '-d', '-s', SESS, '-x', '120', '-y', '40',
    `CODEX_HOME=${CWD}/codex-home ${CODEX} ${codexArgs.map((a) => `'${a}'`).join(' ')}`);

  log(`## repro-730-tmux tag=${TAG} WRAP=${WRAP ? 1 : 0} GAP_MS=${GAP_MS} BUSY=${BUSY ? 1 : 0} STUB_DELAY_MS=${STUB_DELAY_MS}`);
  const ready = await waitFor((s) => /gpt-\S+/.test(s) && !isBusy(s), 30000, 'codex composer ready');
  log(`[boot] ready=${ready}`);
  log(`[boot] composer=${JSON.stringify(composerRow(cap()))}`);
  if (!ready) { log(`[boot] screen:\n${cap()}`); }

  const results = [];

  if (BUSY) {
    // Put codex mid-turn first — this is the state the field reports implicate.
    log(`[busy] starting a long turn (stub holds ${STUB_DELAY_MS}ms)`);
    writeBytes('KEEPBUSY');
    await sleep(120);
    writeBytes('\r');
    const wentBusy = await waitFor(isBusy, 8000, 'turn to start (esc to interrupt)');
    log(`[busy] codex is mid-turn=${wentBusy}`);
  }

  // Real injects are REPORT-sized blobs, not 8 chars. Size/line-count matters: a big
  // burst is exactly what a composer's paste-burst heuristic keys on.
  const pad = (i) => {
    const n = Number(process.env.BODY_CHARS || 0);
    const nl = Number(process.env.BODY_LINES || 0);
    let b = `C730MSG${i}`;
    if (nl > 0) b += '\n' + Array.from({ length: nl }, (_, k) => `line${k} of msg${i} xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`).join('\n');
    if (n > b.length) b += ' ' + 'y'.repeat(n - b.length - 1);
    return b;
  };

  for (let i = 1; i <= 2; i++) {
    const r = await inject(pad(i));
    results.push(r);
    log(`[msg${i}] text->CR=${r.textToCrMs}ms busyBefore=${r.busyBefore} PARKED=${r.parked} composer=${JSON.stringify(r.composer)}`);
  }

  // Wait out the turn, then the reported workaround: one manual bare Enter.
  await waitFor((s) => !isBusy(s), STUB_DELAY_MS + 15000, 'turn to finish');
  const beforeEnter = cap();
  const parkedBeforeEnter = composerRow(beforeEnter);
  writeBytes('\r');
  await sleep(3000);
  const afterEnter = cap();
  const flushed = parkedBeforeEnter.length > 1 && !composerRow(afterEnter).includes('C730MSG');
  log(`[manualEnter] composerBefore=${JSON.stringify(parkedBeforeEnter)}`);
  log(`[manualEnter] composerAfter=${JSON.stringify(composerRow(afterEnter))} flushed=${flushed}`);

  const verdict = {
    tag: TAG, wrap: WRAP, gapMs: GAP_MS, busy: BUSY, stubDelayMs: STUB_DELAY_MS,
    parked: results.filter((r) => r.parked).length,
    total: results.length,
    manualEnterFlushed: flushed,
    results: results.map(({ screen: _s, ...rest }) => rest),
  };
  log(`## VERDICT ${JSON.stringify(verdict)}`);

  fs.writeFileSync(`${OUT}.verdict.json`, JSON.stringify(verdict, null, 2));
  fs.writeFileSync(`${OUT}.screens.txt`,
    results.map((r) => `===== after ${r.body} =====\n${r.screen}`).join('\n\n') +
    `\n\n===== before manual Enter =====\n${beforeEnter}\n\n===== after manual Enter =====\n${afterEnter}\n`);
  fs.writeFileSync(`${OUT}.log`, lines.join('\n') + '\n');

  if (process.env.KEEP !== '1') { try { tmux('kill-session', '-t', SESS); } catch {} }
  stub.close();
  process.exit(0);
})().catch((e) => { log(`[ERROR] ${e.message}`); try { tmux('kill-session', '-t', SESS); } catch {} stub.close(); process.exit(1); });
