#!/usr/bin/env node
'use strict';
// #737 end-to-end: does the REAL telepty daemon notice a codex update modal?
//
// Boots a HARNESS daemon (PORT=0, isolated HOME — never the production daemon on 3848),
// attaches a recording owner-WS bridge whose relayed startup output is codex's blocking
// "Update available … Press enter to continue" MODAL rather than a composer, then runs
// the real CLI for each inject path and records the exact bytes the daemon delivers.
//
// The registry already classifies that screen as `codex_modal_ui` (not ready) — this
// measures whether any delivery path acts on it. Pair with repro-737-tmux.js, which
// shows what real codex 0.144.1 does when it receives these bytes.
//
// usage: node e2e-737.js            (all paths)
//        ONLY=force node e2e-737.js

const { spawn, execFileSync } = require('child_process');
const execFileAsync = require('util').promisify(require('child_process').execFile);
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

// Repo root = the checkout this script lives in. Must NOT be hardcoded to the main
// worktree: a fix branch would otherwise be validated against unfixed daemon.js.
const ROOT = path.resolve(__dirname, '..');
const OUT = '/tmp/c737-work/e2e';
const registry = require(path.join(ROOT, 'src', 'prompt-symbol-registry.js'));

const lines = [];
const log = (m) => { lines.push(m); process.stdout.write(m + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BODY = ['REPORT: [c737-e2e] dispatch payload', 'line A of the report blob', 'line B of the report blob'].join('\n');

// Byte-for-byte the screen a fresh codex 0.144.1 paints when version.json has
// dismissed_version < latest_version (captured from repro-737-tmux.js boot).
// ESC[?2004h is included because real codex emits it in the same first chunk.
const MODAL_BOOT =
  '\x1b[?2004h\x1b[?25l\r\n' +
  '  ✨ Update available! 0.144.1 -> 0.145.0\r\n\r\n' +
  '  Release notes: https://github.com/openai/codex/releases/latest\r\n\r\n' +
  '› 1. Update now (runs `brew upgrade --cask codex`)\r\n' +
  '  2. Skip\r\n' +
  '  3. Skip until next version\r\n\r\n' +
  '  Press enter to continue\r\n';

// Control: the same codex, one version.json field different — straight to the composer.
const COMPOSER_BOOT =
  '\x1b[?2004h\x1b[?25l>_ OpenAI Codex (v0.144.1)\r\n› \r\ngpt-5.5 xhigh fast · /tmp/c737-work\r\n';

async function bootDaemon() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'c737-home-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'daemon.js')], {
    cwd: ROOT,
    // The #737 hold bound is 30s in production; shorten it here so a "nobody ever dismisses
    // it" variant reaches its reject branch without stalling the harness for half a minute.
    env: {
      ...process.env, PORT: '0', HOME: home, TELEPTY_HOME: home, TELEPTY_AUTH_TOKEN: '',
      TELEPTY_MODAL_HOLD_MS: process.env.TELEPTY_MODAL_HOLD_MS || '4000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`daemon boot timeout:\n${buf}`)), 20000);
    const scan = (d) => {
      buf += d.toString();
      const m = /listening on https?:\/\/[^\s]+:(\d+)/.exec(buf);
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    };
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);
  });
  child.stdout.on('data', (d) => fs.appendFileSync(`${OUT}.daemon.log`, d));
  child.stderr.on('data', (d) => fs.appendFileSync(`${OUT}.daemon.log`, d));
  return { child, port, home };
}

// Minimal owner bridge: claims the wrapped session, relays a boot screen, and RECORDS
// every inject frame the daemon pushes with arrival timestamps. Stands in for cli.js's
// allow bridge.
function attachBridge(port, sessionId, { boot, token }) {
  const frames = [];
  // Upgrade path must live under /api/sessions/ — anything else is destroyed by the
  // shared upgrade handler (src/transport/websocket.js).
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${sessionId}?owner=1&owner_pid=${process.pid}&token=${encodeURIComponent(token)}`);
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'inject') frames.push({ at: Date.now(), data: msg.data });
    } catch {}
  });
  return new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'output', data: boot }));
      ws.send(JSON.stringify({ type: 'ready' }));
      setTimeout(() => resolve({ ws, frames }), 400);
    });
  });
}

// TELEPTY_SESSION_ID must be cleared: cli.js defaults `--from` to it, and a worker-sid
// `from` puts the inject on the PEER lane, which the #45 guard 403s. Unset = operator
// lane, which is what an orchestrator-side dispatch actually is.
function cliEnv(ctx, port) {
  const env = { ...process.env, HOME: ctx.home, TELEPTY_PORT: String(port), TELEPTY_HOST: '127.0.0.1' };
  delete env.TELEPTY_SESSION_ID;
  return env;
}

const VARIANTS = {
  // name          boot          cli args after `inject`              surface clears mid-hold?
  force:      { boot: MODAL_BOOT,    args: ['--submit', '--submit-force'] },
  gated:      { boot: MODAL_BOOT,    args: ['--submit'] },
  plain:      { boot: MODAL_BOOT,    args: [] },
  control:    { boot: COMPOSER_BOOT, args: ['--submit', '--submit-force'] },
  // #737 A: somebody dismisses the modal while the inject is parked. The body must then be
  // delivered normally — the hold is a delay, not a drop.
  holdRelease: { boot: MODAL_BOOT,   args: ['--submit', '--submit-force'], clearAfterMs: 1200 },
};

async function runVariant(port, name, ctx) {
  const { boot, args, clearAfterMs } = VARIANTS[name];
  const sessionId = `c737-e2e-${name}`;
  const { ws, frames } = await attachBridge(port, sessionId, { boot, token: ctx.token });

  // The WS auto-register path stamps `command: 'wrapped'` (src/transport/websocket.js), not
  // the real CLI — so a bridge-only session is not identifiable as codex and every
  // CLI-identity feature (#730 paste capability, #737 modal predicate) reads as
  // not-applicable. A real `telepty allow` registers over HTTP first; do the same here, or
  // this harness measures a session shape production does not have.
  await fetch(`http://127.0.0.1:${port}/api/sessions/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
    body: JSON.stringify({ session_id: sessionId, command: 'codex', cwd: '/tmp/c737-work' }),
  }).catch(() => {});

  // What the shipped matcher thinks of the screen the bridge just relayed.
  const detected = registry.detectOutput('codex', boot);

  // Simulate the surface owner dismissing the modal mid-hold: codex repaints its composer,
  // which is the watermark the positional predicate keys on.
  if (clearAfterMs) setTimeout(() => { try { ws.send(JSON.stringify({ type: 'output', data: COMPOSER_BOOT })); } catch {} }, clearAfterMs);

  const startedAt = Date.now();
  try {
    await execFileAsync(process.execPath, [
      path.join(ROOT, 'cli.js'), 'inject', ...args, sessionId, BODY,
    ], { cwd: ROOT, env: cliEnv(ctx, port), encoding: 'utf8', timeout: 60000 });
  } catch (err) {
    log(`  [cli] non-zero exit: ${(err.stderr || err.message || '').toString().trim().slice(0, 300)}`);
  }

  await sleep(2500);
  const t0 = frames.length ? frames[0].at : 0;
  log(`\n--- variant ${name}: telepty inject ${args.join(' ')} into a session showing ${boot === MODAL_BOOT ? 'the UPDATE MODAL' : 'the composer'} ---`);
  log(`  registry.detectOutput('codex', screen) => ${JSON.stringify(detected)}`);
  frames.forEach((f, i) => {
    const d = f.data;
    const shape = d === '\r' ? 'BARE CR (0x0d)'
      : `${d.startsWith('\x1b[200~') ? 'BRACKETED-PASTE body' : 'RAW body'} len=${d.length}`;
    log(`  frame${i} +${f.at - t0}ms  ${shape}`);
  });
  const bodyFrame = frames.find((f) => f.data !== '\r');
  const crFrame = frames.find((f) => f.data === '\r');
  const result = {
    variant: name,
    cliArgs: args.join(' ') || '(none)',
    screenIsModal: boot === MODAL_BOOT,
    registryReason: detected.reason || null,
    registryFound: detected.found,
    // The whole point: did anything stop the delivery?
    bodyDelivered: !!bodyFrame,
    bodyWrapped: !!bodyFrame && bodyFrame.data.startsWith('\x1b[200~'),
    crDelivered: !!crFrame,
    textToCrMs: bodyFrame && crFrame ? crFrame.at - bodyFrame.at : null,
    // How long the CLI call took — for holdRelease this is the parked time, and for a
    // never-clearing modal it is the TELEPTY_MODAL_HOLD_MS bound before the reject.
    cliElapsedMs: bodyFrame ? bodyFrame.at - startedAt : Date.now() - startedAt,
  };
  log(`  => registry says ready=${result.registryFound} (${result.registryReason}); bodyDelivered=${result.bodyDelivered} crDelivered=${result.crDelivered} text->CR=${result.textToCrMs}ms elapsed=${result.cliElapsedMs}ms`);

  try {
    execFileSync(process.execPath, [path.join(ROOT, 'cli.js'), 'kill', sessionId],
      { cwd: ROOT, env: cliEnv(ctx, port), encoding: 'utf8', timeout: 15000, stdio: 'ignore' });
  } catch {}
  ws.close();
  return result;
}

(async () => {
  fs.mkdirSync('/tmp/c737-work', { recursive: true });
  const { child, port, home } = await bootDaemon();
  log(`## e2e-737 — harness daemon on port ${port} (production 3848 untouched), HOME=${home}`);
  const results = [];
  try {
    const token = JSON.parse(fs.readFileSync(path.join(home, '.telepty', 'config.json'), 'utf8')).authToken;
    const ctx = { token, home };
    const only = process.env.ONLY;
    for (const name of Object.keys(VARIANTS)) {
      if (only && only !== name) continue;
      results.push(await runVariant(port, name, ctx));
    }
  } finally {
    child.kill('SIGKILL');
  }
  log(`\n## VERDICT ${JSON.stringify(results)}`);
  fs.writeFileSync(`${OUT}.json`, JSON.stringify(results, null, 2));
  fs.writeFileSync(`${OUT}.log`, lines.join('\n') + '\n');
  process.exit(0);
})().catch((e) => { log(`[ERROR] ${e.stack || e.message}`); process.exit(1); });
