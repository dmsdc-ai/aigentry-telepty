#!/usr/bin/env node
'use strict';
// #760 end-to-end: does the REAL telepty daemon protect a claude session showing a REAL
// blocking modal — and does the parked message actually arrive afterwards, in order?
//
// Boots a HARNESS daemon (PORT=0, isolated HOME — the production daemon on 3848 is never
// touched), attaches a recording owner-WS bridge, and relays as that session's startup
// output the VERBATIM PTY bytes captured from a real Claude Code 2.1.220 modal
// (scratchpad/capture-760-claude-modals.js). Then it runs the real cli.js for each inject
// path and records the exact frames the daemon pushes, with arrival timestamps.
//
// The `before` arm is TELEPTY_MODAL_REMEDY=off — the documented rollback lever, i.e. the
// pre-#760 behavior — so before/after are measured on ONE build.
//
// usage: node e2e-760.js            (all arms)
//        ONLY=park node e2e-760.js

const { spawn, execFileSync } = require('child_process');
const execFileAsync = require('util').promisify(require('child_process').execFile);
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const CAP = '/tmp/c760-work';
const OUT = `${CAP}/e2e`;
const registry = require(path.join(ROOT, 'src', 'prompt-symbol-registry.js'));

const lines = [];
const log = (m) => { lines.push(m); process.stdout.write(m + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Real captured PTY streams. Not hand-written: these are what claude actually emitted.
function capture(name) {
  const p = `${CAP}/${name}.raw.bin`;
  if (!fs.existsSync(p)) throw new Error(`missing capture ${p} — run capture-760-claude-modals.js ${name}`);
  return fs.readFileSync(p, 'utf8');
}
const ASK_BOOT = capture('ask');            // AskUserQuestion option list
const PLAN_BOOT = capture('plan');          // ExitPlanMode approval
const COMPOSER_BOOT = capture('composer');  // control: live composer

const BODY_A = ['REPORT: [c760-e2e] first worker report', 'line A of the blob'].join('\n');
const BODY_B = 'REPORT: [c760-e2e] second worker report';

async function bootDaemon(extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'c760-home-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'daemon.js')], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: '0', HOME: home, TELEPTY_HOME: home, TELEPTY_AUTH_TOKEN: '',
      // Production park budget is 600s; shrink it here so the "nobody ever answers"
      // arm reaches its TTL flush without stalling the harness for ten minutes.
      TELEPTY_MODAL_PARK_TTL_MS: '6000',
      TELEPTY_MODAL_HOLD_MS: '4000',
      ...extraEnv,
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

function attachBridge(port, sessionId, { boot, token }) {
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
      ws.send(JSON.stringify({ type: 'output', data: boot }));
      ws.send(JSON.stringify({ type: 'ready' }));
      setTimeout(() => resolve({ ws, frames }), 400);
    });
  });
}

function cliEnv(ctx, port) {
  const env = { ...process.env, HOME: ctx.home, TELEPTY_PORT: String(port), TELEPTY_HOST: '127.0.0.1' };
  delete env.TELEPTY_SESSION_ID;   // operator lane, which is what orchestrator dispatch is
  return env;
}

const ARMS = {
  // name        boot           cli args                            clears?  env
  'before-off':  { boot: PLAN_BOOT, args: ['--submit', '--submit-force'], env: { TELEPTY_MODAL_REMEDY: 'off' } },
  force:         { boot: PLAN_BOOT, args: ['--submit', '--submit-force'] },
  gated:         { boot: ASK_BOOT,  args: ['--submit'] },
  plain:         { boot: ASK_BOOT,  args: [] },
  control:       { boot: COMPOSER_BOOT, args: ['--submit', '--submit-force'] },
  // The contract: parked, then delivered once whoever owns the surface answers the prompt.
  park:          { boot: PLAN_BOOT, args: ['--submit', '--submit-force'], clearAfterMs: 1500 },
  // Two dispatches parked behind one modal — must arrive in the order they were sent.
  order:         { boot: ASK_BOOT,  args: [], clearAfterMs: 2000, second: true },
  // The race the FIFO alone does not close: the modal clears BETWEEN the two dispatches, so
  // the second one sees a clear surface. It must still queue behind the first.
  orderRace:     { boot: ASK_BOOT,  args: [], clearAfterMs: 900, second: true, gapMs: 1400 },
  // Nobody ever answers: the park must expire into an actionable flush, not accumulate.
  ttl:           { boot: ASK_BOOT,  args: [], waitMs: 9000 },
};

async function runArm(name, ctx, port) {
  const arm = ARMS[name];
  const sessionId = `c760-e2e-${name}`;
  const { ws, frames } = await attachBridge(port, sessionId, { boot: arm.boot, token: ctx.token });

  // A bridge-only session is stamped `command: 'wrapped'` by the WS auto-register path, so
  // no CLI-identity feature would apply. A real `telepty allow` registers over HTTP first —
  // do the same, or this harness measures a session shape production does not have.
  await fetch(`http://127.0.0.1:${port}/api/sessions/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
    body: JSON.stringify({ session_id: sessionId, command: 'claude', cwd: `${CAP}/trusted` }),
  }).catch(() => {});

  const detected = registry.detectSurfaceModal('claude', arm.boot);
  if (arm.clearAfterMs) {
    setTimeout(() => { try { ws.send(JSON.stringify({ type: 'output', data: COMPOSER_BOOT })); } catch {} }, arm.clearAfterMs);
  }

  const startedAt = Date.now();
  const runCli = async (body) => {
    try {
      const r = await execFileAsync(process.execPath,
        [path.join(ROOT, 'cli.js'), 'inject', ...arm.args, sessionId, body],
        { cwd: ROOT, env: cliEnv(ctx, port), encoding: 'utf8', timeout: 60000 });
      return (r.stdout || '').trim();
    } catch (err) {
      return `NONZERO: ${(err.stderr || err.stdout || err.message || '').toString().trim().slice(0, 200)}`;
    }
  };
  const cliOut = [await runCli(BODY_A)];
  const cliElapsedMs = Date.now() - startedAt;
  if (arm.gapMs) await sleep(arm.gapMs);
  if (arm.second) cliOut.push(await runCli(BODY_B));

  await sleep(arm.waitMs || 4000);

  const t0 = frames.length ? frames[0].at : 0;
  log(`\n--- arm ${name}: telepty inject ${arm.args.join(' ') || '(none)'} into a claude showing `
    + `${arm.boot === COMPOSER_BOOT ? 'the COMPOSER' : (arm.boot === PLAN_BOOT ? 'the PLAN-APPROVAL modal' : 'the ASK-QUESTION modal')} ---`);
  log(`  detectSurfaceModal => ${JSON.stringify(detected)}`);
  log(`  cli said: ${cliOut.map((s) => JSON.stringify(s.split('\n').pop())).join(' | ')}`);
  frames.forEach((f, i) => {
    const d = f.data;
    const shape = d === '\r' ? 'BARE CR (0x0d)'
      : `${d.startsWith('\x1b[200~') ? 'BRACKETED-PASTE body' : 'RAW body'} len=${d.length} ${JSON.stringify(d.slice(0, 46))}`;
    log(`  frame${i} +${f.at - t0}ms  ${shape}`);
  });

  const bodyFrames = frames.filter((f) => f.data !== '\r');
  const clearedAt = arm.clearAfterMs ? startedAt + arm.clearAfterMs : null;
  const result = {
    arm: name,
    cliArgs: arm.args.join(' ') || '(none)',
    surface: arm.boot === COMPOSER_BOOT ? 'composer' : (arm.boot === PLAN_BOOT ? 'plan-modal' : 'ask-modal'),
    detectBlocked: detected.blocked,
    detectReason: detected.reason,
    cliAcked: cliOut.every((s) => !s.startsWith('NONZERO')),
    cliElapsedMs,
    bodiesDelivered: bodyFrames.length,
    crDelivered: frames.some((f) => f.data === '\r'),
    // THE #760 signature: did any byte reach the surface WHILE the modal was up?
    deliveredIntoModal: clearedAt
      ? bodyFrames.some((f) => f.at < clearedAt)
      : (detected.blocked && bodyFrames.length > 0),
    // Order across a park.
    deliveryOrder: bodyFrames.map((f) => (f.data.includes('first worker') ? 'A' : (f.data.includes('second worker') ? 'B' : '?'))),
    deliveredAfterClearMs: clearedAt && bodyFrames.length ? bodyFrames[0].at - clearedAt : null,
  };
  log(`  => blocked=${result.detectBlocked} cliAcked=${result.cliAcked} (${result.cliElapsedMs}ms) `
    + `bodies=${result.bodiesDelivered} order=${result.deliveryOrder.join('')} `
    + `INTO-MODAL=${result.deliveredIntoModal} afterClear=${result.deliveredAfterClearMs}ms`);

  // No `telepty kill` here: the bridge registers owner_pid=process.pid (this harness), and
  // kill → lifecycle.killSessionProcess signals THAT pid — i.e. SIGTERMs the harness itself
  // (observed: every arm exited 143 right after printing its result). The per-arm daemon is
  // SIGKILLed by the caller and its HOME is a mkdtemp, so there is nothing else to clean up.
  ws.close();
  return result;
}

(async () => {
  fs.mkdirSync(CAP, { recursive: true });
  try { fs.unlinkSync(`${OUT}.daemon.log`); } catch {}
  const results = [];
  const only = process.env.ONLY;
  for (const name of Object.keys(ARMS)) {
    if (only && only !== name) continue;
    // One daemon per arm: TELEPTY_MODAL_REMEDY is process-wide, so the `before` arm cannot
    // share a process with the others.
    const { child, port, home } = await bootDaemon(ARMS[name].env || {});
    log(`## e2e-760 arm=${name} harness daemon port=${port} (production 3848 untouched)`);
    try {
      const token = JSON.parse(fs.readFileSync(path.join(home, '.telepty', 'config.json'), 'utf8')).authToken;
      results.push(await runArm(name, { token, home }, port));
    } finally {
      child.kill('SIGKILL');
    }
  }
  log(`\n## VERDICT ${JSON.stringify(results)}`);
  fs.writeFileSync(`${OUT}.json`, JSON.stringify(results, null, 2));
  fs.writeFileSync(`${OUT}.log`, lines.join('\n') + '\n');
  process.exit(0);
})().catch((e) => { log(`[ERROR] ${e.stack || e.message}`); process.exit(1); });
