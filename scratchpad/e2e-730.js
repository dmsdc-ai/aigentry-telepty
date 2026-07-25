#!/usr/bin/env node
'use strict';
// #730 end-to-end byte capture on the REAL telepty submit path.
//
// Boots a HARNESS daemon (PORT=0, isolated HOME — never the production daemon on
// 3848), attaches a recording owner-WS bridge as a wrapped session, then runs the
// real `telepty inject --submit --submit-force` CLI and records the EXACT bytes and
// inter-write timing the daemon delivers to the PTY.
//
// Two variants, differing only in whether the bridge ever relayed codex's startup
// `ESC[?2004h` before the inject:
//   seen2004h=true  -> session.bracketedPasteCapable set  -> body wrapped (#716 fix live)
//   seen2004h=false -> flag never set                     -> body RAW, CR ~ms later
// The raw shape is the one real codex 0.144.1 swallows (see repro-730-tmux.js).
//
// usage: node e2e-730.js

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = '/Users/duckyoungkim/projects/aigentry-telepty';
const OUT = '/tmp/c730-work/e2e';
const lines = [];
const log = (m) => { lines.push(m); process.stdout.write(m + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Multi-line body: the shape that makes codex 0.144.1 swallow an un-enveloped CR.
const BODY = ['REPORT: [c730-e2e] byte capture', 'line A of the report blob', 'line B of the report blob', 'line C of the report blob'].join('\n');

async function bootDaemon() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'c730-home-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'daemon.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', HOME: home, TELEPTY_HOME: home, TELEPTY_AUTH_TOKEN: '' },
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

// Minimal owner bridge: claims the wrapped session and RECORDS every inject frame
// the daemon pushes, with arrival timestamps. Stands in for cli.js's allow bridge.
function attachBridge(port, sessionId, { emit2004h, token }) {
  const frames = [];
  // Upgrade path must live under /api/sessions/ — anything else is destroyed by the
  // shared upgrade handler (src/transport/websocket.js:302).
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
      // Relay a startup frame exactly like a real bridge relays codex's first output.
      // codex 0.144.1 emits ESC[?2004h ONCE, in its first ~1.4KB — there is exactly one
      // chance for the daemon to observe it (verified: probe-codex.js boot capture).
      const boot = emit2004h
        ? '\x1b[?2004h\x1b[?25l>_ OpenAI Codex (v0.144.1)\r\n› \r\ngpt-5.5 xhigh fast · /tmp/c730-work\r\n'
        : '>_ OpenAI Codex (v0.144.1)\r\n› \r\ngpt-5.5 xhigh fast · /tmp/c730-work\r\n';
      ws.send(JSON.stringify({ type: 'output', data: boot }));
      ws.send(JSON.stringify({ type: 'ready' }));
      setTimeout(() => resolve({ ws, frames }), 400);
    });
  });
}

const hex = (s) => Buffer.from(s, 'utf8').toString('hex');
const describe = (d) => {
  if (d === '\r') return 'BARE CR (0x0d)';
  const wrapped = d.startsWith('\x1b[200~') && d.endsWith('\x1b[201~');
  return `${wrapped ? 'BRACKETED-PASTE body' : 'RAW body (no envelope)'} len=${d.length}`;
};

// TELEPTY_SESSION_ID must be cleared: cli.js defaults `--from` to it (cli.js:2367), and a
// worker-sid `from` puts the inject on the PEER lane, which the #45 guard 403s. Unset =
// operator lane, which is what an orchestrator-side inject actually is.
function cliEnv(ctx, port) {
  const env = { ...process.env, HOME: ctx.home, TELEPTY_PORT: String(port), TELEPTY_HOST: '127.0.0.1' };
  delete env.TELEPTY_SESSION_ID;
  return env;
}

async function runVariant(port, emit2004h, ctx) {
  const sessionId = `c730-e2e-${emit2004h ? 'sees2004h' : 'misses2004h'}`;
  log(`[variant] attaching bridge for ${sessionId}`);
  const { ws, frames } = await attachBridge(port, sessionId, { emit2004h, token: ctx.token });
  log(`[variant] bridge attached, running CLI inject`);

  execFileSync(process.execPath, [
    path.join(ROOT, 'cli.js'), 'inject', '--submit', '--submit-force', sessionId, BODY,
  ], { cwd: ROOT, env: cliEnv(ctx, port), encoding: 'utf8' });

  await sleep(1500);
  const t0 = frames.length ? frames[0].at : 0;
  log(`\n--- variant: bridge ${emit2004h ? 'RELAYED' : 'MISSED'} codex's ESC[?2004h  (session ${sessionId}) ---`);
  frames.forEach((f, i) => {
    log(`  frame${i} +${f.at - t0}ms  ${describe(f.data)}`);
    log(`    head=${hex(f.data.slice(0, 8))}  tail=${hex(f.data.slice(-8))}`);
  });
  const bodyFrame = frames.find((f) => f.data !== '\r');
  const crFrame = frames.find((f) => f.data === '\r');
  const result = {
    seen2004h: emit2004h,
    frames: frames.length,
    bodyWrapped: !!bodyFrame && bodyFrame.data.startsWith('\x1b[200~') && bodyFrame.data.endsWith('\x1b[201~'),
    crSeparate: !!crFrame,
    textToCrMs: bodyFrame && crFrame ? crFrame.at - bodyFrame.at : null,
  };
  log(`  => bodyWrapped=${result.bodyWrapped} crSeparate=${result.crSeparate} text->CR=${result.textToCrMs}ms`);
  // The daemon must never see this session again once the bridge drops.
  try { execFileSync(process.execPath, [path.join(ROOT, 'cli.js'), 'kill', sessionId], {
    cwd: ROOT, env: cliEnv(ctx, port), encoding: 'utf8' }); } catch {}
  ws.close();
  return result;
}

(async () => {
  const { child, port, home } = await bootDaemon();
  log(`## e2e-730 — harness daemon on port ${port} (production 3848 untouched), HOME=${home}`);
  log(`## body: ${BODY.split('\n').length} lines, ${BODY.length} chars`);
  let results = [];
  try {
    const token = JSON.parse(fs.readFileSync(path.join(home, '.telepty', 'config.json'), 'utf8')).authToken;
    const ctx = { token, home };
    const only = process.env.ONLY;
    if (only !== 'miss') results.push(await runVariant(port, true, ctx));
    if (only !== 'sees') results.push(await runVariant(port, false, ctx));
  } finally {
    child.kill('SIGKILL');
  }
  log(`\n## VERDICT ${JSON.stringify(results)}`);
  fs.writeFileSync(`${OUT}.json`, JSON.stringify(results, null, 2));
  fs.writeFileSync(`${OUT}.log`, lines.join('\n') + '\n');
  process.exit(0);
})().catch((e) => { log(`[ERROR] ${e.stack || e.message}`); process.exit(1); });
