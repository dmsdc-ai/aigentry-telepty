#!/usr/bin/env node
'use strict';
// #752 repro with the REAL claude binary, on a HARNESS daemon (PORT=0 + mkdtemp HOME).
// The production daemon on 3848 is never contacted.
//
//   pane:  telepty allow --id P claude --permission-mode bypassPermissions
//   probe: telepty inject --submit P "hello"     (env TELEPTY_SESSION_ID=orchestrator)
//
// Records: raw PTY bytes of the pane (fixture material), daemon log, bus events, and the
// daemon's own view of the session (command / bootstrap / modal verdict) at each step.
//
// usage: node scratchpad/repro-752-real.js [--flags "--permission-mode bypassPermissions"]

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const OUT = '/tmp/c752-work';
fs.mkdirSync(OUT, { recursive: true });
const REAL_HOME = process.env.REAL_HOME || '/Users/duckyoungkim';

const flagsArg = process.argv.indexOf('--flags');
const CLAUDE_FLAGS = flagsArg !== -1 ? process.argv[flagsArg + 1].split(/\s+/).filter(Boolean) : ['--permission-mode', 'bypassPermissions'];

const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(2);
const lines = [];
const log = (m) => { const s = `[${el()}s] ${m}`; lines.push(s); process.stdout.write(s + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'c752-home-'));
  const sid = `c752-real-${process.pid}`;

  // Seed the harness daemon's isolated HOME with the host's telepty auth token, so a CLI
  // running under the REAL HOME (see below) authenticates against THIS daemon. Nothing here
  // reaches the production daemon: every CLI call is pinned to TELEPTY_HOST/TELEPTY_PORT.
  fs.mkdirSync(path.join(home, '.telepty'), { recursive: true });
  fs.copyFileSync(path.join(REAL_HOME, '.telepty', 'config.json'), path.join(home, '.telepty', 'config.json'));

  const daemonLines = [];
  const daemon = spawn(process.execPath, ['daemon.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', HOME: home, USERPROFILE: home,
      NO_UPDATE_NOTIFIER: '1', TELEPTY_DISABLE_UPDATE_NOTIFIER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let dbuf = '';
  const onD = (c) => {
    dbuf += c.toString();
    for (const l of c.toString().split('\n')) if (l.trim()) daemonLines.push(`[${el()}s] ${l}`);
  };
  daemon.stdout.on('data', onD);
  daemon.stderr.on('data', onD);

  let port = 0;
  for (let i = 0; i < 140 && !port; i++) {
    const m = dbuf.match(/listening on https?:\/\/[^\s]+:(\d+)/);
    if (m) port = Number(m[1]); else await sleep(50);
  }
  if (!port) throw new Error('daemon never listened');
  log(`harness daemon on 127.0.0.1:${port} (HOME=${home})`);

  const api = async (p, init) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, init);
    const text = await res.text();
    try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
  };

  const bus = new WebSocket(`ws://127.0.0.1:${port}/api/bus`);
  const busEvents = [];
  bus.on('message', (m) => {
    try { const e = JSON.parse(m); busEvents.push(`[${el()}s] ${e.type} :: ${String(e.content || e.message || JSON.stringify(e).slice(0, 200)).slice(0, 220)}`); } catch {}
  });
  await new Promise((r) => bus.once('open', r));

  // The field repro ran a fully-onboarded claude on a live composer. A temp HOME puts claude
  // into first-run onboarding ("Choose the text style") — a genuine modal, i.e. the WRONG
  // surface. So the pane keeps the real HOME (real claude state) while telepty's daemon stays
  // isolated on its temp HOME; the two only have to agree on the auth token, seeded above.
  const env = {
    ...process.env,
    HOME: REAL_HOME, USERPROFILE: REAL_HOME,
    TELEPTY_HOST: '127.0.0.1', TELEPTY_PORT: String(port),
    TELEPTY_SESSION_ID: 'orchestrator',      // the field probe's inherited env
    NO_UPDATE_NOTIFIER: '1', TELEPTY_DISABLE_UPDATE_NOTIFIER: '1',
  };
  delete env.CLAUDECODE; delete env.CLAUDE_CODE_SSE_PORT; delete env.CLAUDE_CODE_ENTRYPOINT;

  const rawPath = path.join(OUT, `${sid}.raw.bin`);
  const rawFd = fs.openSync(rawPath, 'w');
  let paneOut = '';
  // cli.js by ABSOLUTE path: the pane's cwd is the main repo (claude's trusted folder),
  // but the CLI under test must be this worktree's, not the checkout the cwd points at.
  const pane = pty.spawn(process.execPath, [path.join(ROOT, 'cli.js'), 'allow', '--id', sid, 'claude', ...CLAUDE_FLAGS], {
    cwd: '/Users/duckyoungkim/projects/aigentry-telepty', cols: 120, rows: 40, name: 'xterm-256color', env,
  });
  pane.onData((c) => { paneOut += c; fs.writeSync(rawFd, c); });
  log(`pane: telepty allow --id ${sid} claude ${CLAUDE_FLAGS.join(' ')}`);

  const snap = async (label) => {
    const s = await api(`/api/sessions/${sid}`);
    const b = s.body || {};
    log(`  [${label}] command=${JSON.stringify(b.command)} ready=${b.ready} bootstrap=${JSON.stringify(b.bootstrap)} health=${b.healthStatus} state=${JSON.stringify(b.state || b.autoState || null)}`);
  };

  for (let i = 0; i < 120; i++) {
    const list = await api('/api/sessions');
    const s = Array.isArray(list.body) && list.body.find((x) => x.id === sid);
    if (s && s.healthStatus === 'CONNECTED') break;
    await sleep(100);
  }
  await snap('registered');

  // Boot wait. The field repro injected as soon as the pane came up, which is what
  // catches the working→idle startup edge; --wait lets both timings be measured.
  const waitArg = process.argv.indexOf('--wait');
  await sleep(waitArg !== -1 ? Number(process.argv[waitArg + 1]) : 12000);
  await snap('pre-inject');

  log('--- telepty inject --submit ---');
  const injectAt = Date.now();
  const inj = spawn(process.execPath, [path.join(ROOT, 'cli.js'), 'inject', '--submit', sid, 'say the single word PONG'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let injOut = '';
  inj.stdout.on('data', (c) => { injOut += c; });
  inj.stderr.on('data', (c) => { injOut += c; });
  await new Promise((r) => inj.on('close', r));
  for (const l of injOut.split('\n')) if (l.trim()) log(`  CLI> ${l.replace(/\[[0-9;]*m/g, '')}`);

  const paneAtInject = paneOut.length;
  for (const w of [3, 6, 10, 20, 35]) {
    while (Date.now() - injectAt < w * 1000) await sleep(200);
    await snap(`T+${w}s`);
  }

  const after = paneOut.slice(paneAtInject);
  const strip = (s) => s.replace(/\[[0-9;?]*[a-zA-Z]/g, '').replace(/\][^]*/g, '');
  log(`--- pane bytes after inject: ${after.length} ---`);
  log(`--- does the pane show the injected body? ${/say\s*the\s*single\s*word\s*PONG/.test(strip(after)) ? 'YES' : 'NO'}`);
  log(`--- does the pane show a reply (PONG)? ${/PONG/.test(strip(after).replace(/say\s*the\s*single\s*word\s*PONG/g, '')) ? 'YES' : 'NO'}`);

  log('--- bus events ---');
  for (const e of busEvents) log('  ' + e);
  log('--- daemon log (filtered) ---');
  for (const l of daemonLines) if (/INJECT|SUBMIT|MODAL|AUTO-REPORT|BOOTSTRAP|REGISTER|PEER-GUARD|READY|WS/.test(l)) log('  ' + l);

  fs.writeFileSync(path.join(OUT, `${sid}.daemon.log`), daemonLines.join('\n'));
  fs.writeFileSync(path.join(OUT, `${sid}.report.txt`), lines.join('\n'));
  fs.closeSync(rawFd);
  log(`raw pane bytes → ${rawPath}`);

  try { bus.close(); } catch {}
  pane.kill();
  daemon.kill();
  await sleep(400);
  try { daemon.kill('SIGKILL'); } catch {}
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
