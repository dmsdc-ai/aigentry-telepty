#!/usr/bin/env node
'use strict';
// #801 end-to-end: what does the REAL telepty daemon tell the orchestrator when a wrapped
// AI-CLI session DIES on an API error instead of doing the work?
//
// Boots a HARNESS daemon (PORT=0, mkdtemp HOME — the production daemon on 3848 is never
// touched, never kickstarted, never killed), attaches a recording bridge as the orchestrator
// and another as the worker, dispatches one `telepty inject --submit --submit-force` from
// orch → worker, and then relays as the worker's PTY output the VERBATIM bytes a real CLI
// emitted when its turn died (scratchpad/capture-801-api-error.js). Then it goes quiet and we
// record the exact auto-report frame the orchestrator receives.
//
// BEFORE/AFTER on two real builds rather than a rollback lever: the `before-*` arms spawn
// daemon.js from the pristine main checkout (read-only), the rest from this worktree. No new
// env knob is introduced just to measure the fix (제1조).
//
// The production shape being reproduced is the worker-launcher one (#721): wrapped session,
// force-confirmed submit, ring advanced, elapsed past the launcher-consumption floor — which
// is what makes the daemon call the idle CONFIRMED and emit TASK_COMPLETE. The floor is
// shrunk from 30s to 2s via its existing env knob so the harness runs in seconds.
//
// usage: node e2e-801.js            (all arms)
//        ONLY=claude-529 node e2e-801.js

const { spawn } = require('child_process');
const execFileAsync = require('util').promisify(require('child_process').execFile);
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const MAIN = process.env.MAIN_ROOT || '/Users/duckyoungkim/projects/aigentry-telepty';
const CAP = '/tmp/c801-work';
const OUT = `${CAP}/e2e`;

const lines = [];
const log = (m) => { lines.push(m); process.stdout.write(m + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Real captured PTY streams. Not hand-written: these are what the CLIs actually emitted.
function capture(name) {
  const p = `${CAP}/${name}.raw.bin`;
  if (!fs.existsSync(p)) throw new Error(`missing capture ${p} — run capture-801-api-error.js ${name}`);
  return fs.readFileSync(p, 'utf8');
}

const BODY = 'TASK: [t801e-e2e] read the README, summarize it in two sentences, then REPORT back to orchestrator';

async function bootDaemon(root) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'c801-home-'));
  const child = spawn(process.execPath, [path.join(root, 'daemon.js')], {
    cwd: root,
    env: {
      ...process.env, PORT: '0', HOME: home, TELEPTY_HOME: home, TELEPTY_AUTH_TOKEN: '',
      // #721's launcher-consumption floor is 30s in production. Shrink it, do not remove it:
      // it is the guard that makes the idle CONFIRMED, i.e. the very thing under test.
      TELEPTY_LAUNCHER_CONSUMPTION_MIN_SECONDS: '2',
      // The dispatcher in this harness IS the orchestrator lane; without this the #533
      // peer-guard blocks the inject as a malformed peer→peer envelope.
      AIGENTRY_ORCHESTRATOR_SIDS: `orch801-${process.env.ARM_SID || ''}`,
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

async function attachBridge(port, sessionId, { command, token }) {
  await fetch(`http://127.0.0.1:${port}/api/sessions/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ session_id: sessionId, command, cwd: CAP }),
  });
  const frames = [];
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
      ws.send(JSON.stringify({ type: 'ready' }));
      setTimeout(() => resolve({ ws, frames, out: (d) => ws.send(JSON.stringify({ type: 'output', data: d })) }), 400);
    });
  });
}

const ARMS = {
  // The defect: claude exhausted its retries on 529 and returned to its prompt.
  'claude-529': { root: ROOT, command: 'claude', boot: 'claude-ok', turn: 'claude-529', want: 'TASK_ERROR' },
  // Same bytes, pre-fix build — the RED.
  'before-claude-529': { root: MAIN, command: 'claude', boot: 'claude-ok', turn: 'claude-529', want: 'TASK_COMPLETE' },
  // codex died on the API's model rejection 10.8s in.
  'codex-400': { root: ROOT, command: 'codex', boot: 'codex-ok', turn: 'codex-400', want: 'TASK_ERROR' },
  'before-codex-400': { root: MAIN, command: 'codex', boot: 'codex-ok', turn: 'codex-400', want: 'TASK_COMPLETE' },
  // CONTROL: a genuine completion must keep behaving exactly as today, on both builds.
  'control-claude': { root: ROOT, command: 'claude', boot: 'claude-ok', turn: 'claude-ok', want: 'TASK_COMPLETE' },
  'before-control-claude': { root: MAIN, command: 'claude', boot: 'claude-ok', turn: 'claude-ok', want: 'TASK_COMPLETE' },
  'control-codex': { root: ROOT, command: 'codex', boot: 'codex-ok', turn: 'codex-ok', want: 'TASK_COMPLETE' },
};

async function runArm(name, ctx, port) {
  const arm = ARMS[name];
  const worker = `w801-${name}`;
  const orch = `orch801-${name}`;

  const orchBridge = await attachBridge(port, orch, { command: 'claude', token: ctx.token });
  const workerBridge = await attachBridge(port, worker, { command: arm.command, token: ctx.token });
  workerBridge.out(capture(arm.boot));   // a live composer, no modal — the surface at dispatch time
  await sleep(600);

  const env = { ...process.env, HOME: ctx.home, TELEPTY_PORT: String(port), TELEPTY_HOST: '127.0.0.1' };
  delete env.TELEPTY_SESSION_ID;         // operator lane — which is what orchestrator dispatch is
  let cliOut;
  try {
    const r = await execFileAsync(process.execPath,
      [path.join(arm.root, 'cli.js'), 'inject', '--submit', '--submit-force', '--from', orch, worker, BODY],
      { cwd: arm.root, env, encoding: 'utf8', timeout: 60000 });
    cliOut = (r.stdout || '').trim().split('\n').pop();
  } catch (err) {
    cliOut = `NONZERO: ${(err.stderr || err.stdout || err.message || '').toString().trim().slice(0, 200)}`;
  }

  // The turn: the CLI echoes the dispatched body, then emits whatever the capture recorded —
  // an error banner it never recovered from, or a real answer — and goes quiet.
  workerBridge.out(BODY + '\n');
  await sleep(400);
  workerBridge.out(capture(arm.turn));

  // idle_timeout_ms is 5s of silence; the auto-report fires on that transition.
  await sleep(11000);

  const auto = orchBridge.frames.map((f) => f.data).join('').match(/TASK_[A-Z_]+[^\n]*/);
  const got = auto ? auto[0] : null;
  const label = got ? got.split(':')[0] : 'NOTHING';
  const pass = label === arm.want;
  log(`\n--- arm ${name} (${arm.root === MAIN ? 'pre-fix main' : 'fix build'}, ${arm.command}, turn=${arm.turn}) ---`);
  log(`  cli said: ${JSON.stringify(cliOut)}`);
  log(`  orchestrator received: ${got ? JSON.stringify(got.slice(0, 200)) : '(no auto-report)'}`);
  log(`  => ${pass ? 'PASS' : 'FAIL'} want=${arm.want} got=${label}`);

  orchBridge.ws.close();
  workerBridge.ws.close();
  return { arm: name, build: arm.root === MAIN ? 'pre-fix' : 'fix', want: arm.want, got: label, pass, message: got };
}

(async () => {
  fs.mkdirSync(CAP, { recursive: true });
  try { fs.unlinkSync(`${OUT}.daemon.log`); } catch {}
  const results = [];
  const only = process.env.ONLY;
  for (const name of Object.keys(ARMS)) {
    if (only && only !== name) continue;
    process.env.ARM_SID = name;
    const { child, port, home } = await bootDaemon(ARMS[name].root);
    log(`## e2e-801 arm=${name} harness daemon port=${port} root=${ARMS[name].root} (production 3848 untouched)`);
    try {
      const token = JSON.parse(fs.readFileSync(path.join(home, '.telepty', 'config.json'), 'utf8')).authToken;
      results.push(await runArm(name, { token, home }, port));
    } finally {
      child.kill('SIGKILL');
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
  log(`\n## VERDICT ${results.every((r) => r.pass) ? 'ALL PASS' : 'FAILURES'}`);
  results.forEach((r) => log(`  ${r.pass ? 'ok  ' : 'FAIL'} ${r.arm.padEnd(24)} ${r.build.padEnd(8)} want=${r.want.padEnd(18)} got=${r.got}`));
  fs.writeFileSync(`${OUT}.json`, JSON.stringify(results, null, 2));
  fs.writeFileSync(`${OUT}.log`, lines.join('\n') + '\n');
  process.exit(results.every((r) => r.pass) ? 0 : 1);
})().catch((e) => { log(`[ERROR] ${e.stack || e.message}`); process.exit(1); });
