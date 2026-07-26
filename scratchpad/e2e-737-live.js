#!/usr/bin/env node
'use strict';
// #737 live end-to-end: REAL codex 0.144.1 behind a REAL telepty daemon, driven by the
// REAL cli.js. This is the whole loop the other harnesses only cover in halves —
// repro-737-tmux.js proves what codex does with the bytes, e2e-737.js proves what the
// daemon emits; this one wires them together and measures the actual outcome.
//
// Runs the same scenario twice on the same harness:
//   before  TELEPTY_MODAL_REMEDY=off   — the documented rollback lever, i.e. exactly the
//                                        pre-#737 code path
//   after   (default: hold)            — the shipped fix
//
// Expected: before => stub `brew` invoked + codex exits + message lost;
//           after  => nothing written, actionable refusal, codex alive, and the message
//                     delivers normally once the modal is dismissed.
//
// SAFETY: `brew` is a stub on PATH that records the invocation and exits 0 — the modal's
// pre-selected "Update now" is observed, never performed. Isolated CODEX_HOME, harness
// daemon on PORT=0; the production daemon (3848) and the real ~/.codex are untouched.
//
// usage: node scratchpad/e2e-737-live.js

const { spawn, execFile } = require('child_process');
const execFileAsync = require('util').promisify(execFile);
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const pty = require('node-pty');

const ROOT = path.resolve(__dirname, '..');
const WORK = '/tmp/c737-work';
const CODEX_HOME = `${WORK}/codex-home`;
const BREW_LOG = `${WORK}/brew-invocations.log`;
const BODY = ['REPORT: [c737-live] dispatch payload', 'line A of the report blob'].join('\n');

const lines = [];
const log = (m) => { lines.push(m); process.stdout.write(m + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const brewCalls = () => { try { return fs.readFileSync(BREW_LOG, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };

function seed() {
  fs.mkdirSync(CODEX_HOME, { recursive: true });
  if (!fs.existsSync(`${CODEX_HOME}/auth.json`)) fs.copyFileSync(`${process.env.HOME}/.codex/auth.json`, `${CODEX_HOME}/auth.json`);
  fs.writeFileSync(`${CODEX_HOME}/version.json`, JSON.stringify({
    latest_version: '0.145.0', last_checked_at: '2126-01-01T00:00:00Z', dismissed_version: '0.140.0',
  }) + '\n');
  fs.writeFileSync(`${CODEX_HOME}/config.toml`,
    'model = "gpt-5.5"\napproval_policy = "never"\nsandbox_mode = "read-only"\n\n' +
    `[projects."${WORK}"]\ntrust_level = "trusted"\n\n[projects."/private${WORK}"]\ntrust_level = "trusted"\n`);
  fs.mkdirSync(`${WORK}/bin`, { recursive: true });
  fs.writeFileSync(`${WORK}/bin/brew`, '#!/bin/sh\n' +
    `echo "$(date -u +%FT%TZ) brew $*" >> ${BREW_LOG}\n` +
    'echo "c737 stub brew: refused to run \'$*\'"\nexit 0\n');
  fs.chmodSync(`${WORK}/bin/brew`, 0o755);
  try { fs.unlinkSync(BREW_LOG); } catch {}
}

async function bootDaemon(extraEnv) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'c737-live-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'daemon.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', HOME: home, TELEPTY_HOME: home, TELEPTY_AUTH_TOKEN: '', TELEPTY_MODAL_HOLD_MS: '4000', ...extraEnv },
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
  return { child, port, home };
}

// Owner bridge standing in for cli.js's allow bridge: relays real codex output UP to the
// daemon (so the ring holds the real surface) and daemon inject frames DOWN to the PTY.
function attachBridge(port, sessionId, token, ptyProc) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${sessionId}?owner=1&owner_pid=${process.pid}&token=${encodeURIComponent(token)}`);
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'inject') ptyProc.write(msg.data);
    } catch {}
  });
  return new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('open', () => {
      ptyProc.onData((d) => { try { ws.send(JSON.stringify({ type: 'output', data: d })); } catch {} });
      ws.send(JSON.stringify({ type: 'ready' }));
      resolve(ws);
    });
  });
}

function cliEnv(home, port) {
  const env = { ...process.env, HOME: home, TELEPTY_PORT: String(port), TELEPTY_HOST: '127.0.0.1' };
  delete env.TELEPTY_SESSION_ID;
  return env;
}

// NOTE: cli.js prints inject failures to stderr and RETURNS — it does not set a non-zero
// exit code, for #737's refusal or for any pre-existing failure (STALE, DISCONNECTED, …).
// So the exit status is not a usable signal; capture both streams and read the text.
// (Pre-existing CLI behavior, out of scope here — flagged in EVIDENCE-737.md.)
async function inject(home, port, sessionId) {
  const run = execFileAsync(process.execPath,
    [path.join(ROOT, 'cli.js'), 'inject', '--submit', '--submit-force', sessionId, BODY],
    { cwd: ROOT, env: cliEnv(home, port), encoding: 'utf8', timeout: 60000 });
  try {
    const { stdout, stderr } = await run;
    const text = `${stdout}${stderr}`.trim();
    return { exitedZero: true, refused: /SURFACE_MODAL/.test(text), out: text };
  } catch (err) {
    const text = String(`${err.stdout || ''}${err.stderr || ''}` || err.message).trim();
    return { exitedZero: false, refused: /SURFACE_MODAL/.test(text), out: text };
  }
}

async function runArm(label, extraEnv) {
  seed();
  const { child, port, home } = await bootDaemon(extraEnv);
  const sessionId = `c737-live-${label}`;
  const token = JSON.parse(fs.readFileSync(path.join(home, '.telepty', 'config.json'), 'utf8')).authToken;

  const p = pty.spawn('/opt/homebrew/bin/codex', [
    '--sandbox', 'read-only', '--ask-for-approval', 'never',
    '-c', 'model_providers.stub={name="stub",base_url="http://127.0.0.1:47411/v1",wire_api="responses",request_max_retries=0,stream_max_retries=0}',
    '-c', 'model_provider="stub"',
  ], {
    name: 'xterm-256color', cols: 120, rows: 40, cwd: WORK,
    env: { ...process.env, CODEX_HOME, PATH: `${WORK}/bin:${process.env.PATH}` },
  });
  let codexAlive = true;
  let screen = '';
  p.onExit(() => { codexAlive = false; });
  p.onData((d) => { screen += d; });

  const ws = await attachBridge(port, sessionId, token, p);
  await sleep(6000);                                   // codex boots into the modal
  await fetch(`http://127.0.0.1:${port}/api/sessions/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ session_id: sessionId, command: 'codex', cwd: WORK }),
  }).catch(() => {});

  log(`\n=== arm "${label}"  (${JSON.stringify(extraEnv)}) ===`);
  const r1 = await inject(home, port, sessionId);
  await sleep(3000);
  const afterFirst = {
    refused: r1.refused,
    cliSaid: r1.out.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 160),
    brewInvocations: brewCalls().length,
    codexAlive,
    bodyOnSurface: screen.includes('c737-live'),
  };
  log(`  inject #1 (modal up): refused=${afterFirst.refused} brew=${afterFirst.brewInvocations} codexAlive=${afterFirst.codexAlive} bodyOnSurface=${afterFirst.bodyOnSurface}`);
  log(`    cli: ${afterFirst.cliSaid}`);

  // Now the operator dismisses the modal the SAFE way — down twice to "3. Skip until next
  // version", then Enter. Never Enter on the pre-selected default; that is #737 itself.
  let afterDismiss = null;
  if (codexAlive) {
    p.write('\x1b[B'); await sleep(200);
    p.write('\x1b[B'); await sleep(200);
    p.write('\r');
    await sleep(6000);
    screen = '';
    const r2 = await inject(home, port, sessionId);
    await sleep(5000);
    afterDismiss = {
      refused: r2.refused,
      cliSaid: r2.out.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 160),
      brewInvocations: brewCalls().length,
      codexAlive,
      // Submitted, not parked: codex echoes the body into the transcript above the composer.
      bodyOnSurface: screen.includes('c737-live'),
    };
    log(`  inject #2 (modal dismissed): refused=${afterDismiss.refused} brew=${afterDismiss.brewInvocations} codexAlive=${afterDismiss.codexAlive} bodyOnSurface=${afterDismiss.bodyOnSurface}`);
    log(`    cli: ${afterDismiss.cliSaid}`);
  } else {
    log('  inject #2: SKIPPED — codex is already dead (it ran the update and exited)');
  }

  try { ws.close(); } catch {}
  try { p.kill(); } catch {}
  child.kill('SIGKILL');
  await sleep(500);
  return { label, afterFirst, afterDismiss };
}

(async () => {
  const results = [];
  // "before" first: TELEPTY_MODAL_REMEDY=off is the documented rollback lever, so this arm
  // exercises the exact pre-#737 delivery path through the post-#737 binary.
  results.push(await runArm('before-remedy-off', { TELEPTY_MODAL_REMEDY: 'off' }));
  results.push(await runArm('after-default-hold', {}));

  log(`\n## VERDICT ${JSON.stringify(results, null, 2)}`);
  fs.writeFileSync(`${WORK}/e2e-737-live.json`, JSON.stringify(results, null, 2));
  fs.writeFileSync(`${WORK}/e2e-737-live.txt`, lines.join('\n') + '\n');
  process.exit(0);
})().catch((e) => { log(`[ERROR] ${e.stack || e.message}`); process.exit(1); });
