'use strict';

// #732 — bridge→daemon output pipe silent death.
//
// Live signature (2026-07-13, session demo-codex4): a wrapped session's UPSTREAM
// leg (PTY → owner-WS 'output' frame → daemon ring) died while the DOWNSTREAM leg
// (inject → owner-WS → child.write → PTY) kept working. The daemon still reported
// the session CONNECTED, still answered inject with 200, and read-screen kept
// returning pre-death content. Nothing on either side noticed; only a bridge
// respawn cured it.
//
// This file has two jobs:
//   1. REPRO (passes today) — pin the observable signature, so the fix has a
//      before/after reference.
//   2. RED (fails today)    — pin the contract the product does not hold:
//      upstream must recover, and while it has not, the session must not be
//      advertised as healthy.
//
// NOT registered in package.json `test`/`test:ci` — REPRO phase artifact (#732).
// Run directly:
//   node --require ./test-support/setup-env.js --test test/bridge-output-pipe-732.test.js
//
// #524 guard: isolated HOME + ephemeral port; the production daemon on 3848 and
// any session this file did not create are never touched.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const H = require('../test-support/bridge-pipe-harness');

const SKIP = process.platform === 'win32' ? 'POSIX-only (node-pty master fd semantics)' : false;

// How long the product may take to notice a dead upstream and restore it. Generous
// on purpose: the daemon's own owner-WS heartbeat runs on a 30s interval
// (src/transport/websocket.js:51-59), so anything shorter than that could be
// called an unfair bar. Today upstream never comes back at all.
const UPSTREAM_RECOVERY_MS = 45000;

let home;
let daemon;
let bridge;
let A;
let sid;
let proofFile;
let ringBeforeFault = '';
let sessionBeforeFault = null;
let downstreamProven = false;

before(async () => {
  if (SKIP) return;
  home = H.makeHome();
  sid = `c732-${process.pid}`;
  proofFile = path.join(home, 'c732-downstream-proof.txt');

  daemon = H.startDaemon({ home });
  const port = await H.daemonReady(daemon);
  A = H.api(port);

  bridge = H.startBridge({ home, port, sid, faultInjector: true });
  await H.waitFor(async () => (await A.session(sid)).id === sid, { description: 'session register' });
  await H.waitFor(async () => (await A.screen(sid)).screen.length > 0, { description: 'first PTY output in ring' });

  // Both legs healthy before the fault — otherwise the repro proves nothing.
  await A.inject(sid, 'echo C732_PRE\n');
  await H.waitFor(() => bridge.out.includes('C732_PRE'), { description: 'pre-fault inject reached the PTY' });
  await H.waitFor(async () => (await A.screen(sid)).screen.includes('C732_PRE'),
    { description: 'pre-fault PTY output reached the daemon ring' });

  ringBeforeFault = (await A.screen(sid)).screen;
  sessionBeforeFault = await A.session(sid);

  // Sever ONLY the upstream leg (see test-support/pty-read-fault.js).
  bridge.severUpstream();
  await H.delay(1000);

  // Downstream proof must not depend on either the ring or the bridge's stdout —
  // both ride the severed leg. A file written by the shell is independent evidence
  // that the injected bytes reached the PTY and the CLI executed them.
  await A.inject(sid, `echo PROVEN > ${proofFile}\n`);
  try {
    await H.waitFor(() => fs.existsSync(proofFile) && fs.readFileSync(proofFile, 'utf8').includes('PROVEN'),
      { timeoutMs: 20000, description: 'post-fault inject executed by the PTY' });
    downstreamProven = true;
  } catch { downstreamProven = false; }
});

after(async () => {
  H.killBridge(bridge);
  await H.stopDaemon(daemon);
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

test('#732 REPRO: downstream survives while upstream is dead (the live signature)', { skip: SKIP }, async () => {
  assert.equal(bridge.alive(), true,
    'bridge process must still be running — a dead bridge is a different (already handled) failure');
  assert.equal(downstreamProven, true,
    'inject must still reach the PTY and be executed (the live evidence: codex kept processing turns)');

  const screen = (await A.screen(sid)).screen;
  assert.ok(!screen.includes('PROVEN'),
    'repro precondition: the post-fault command must NOT have reached the ring');
  assert.equal(screen, ringBeforeFault,
    'read-screen returns pre-death content, byte-identical (live: "read-screen returned old content")');
});

test('#732 RED: PTY output must reach the daemon ring after an upstream stall', { skip: SKIP }, async () => {
  const marker = `C732_RECOVERY_${Date.now()}`;
  await A.inject(sid, `echo ${marker}\n`);

  await H.waitFor(async () => (await A.screen(sid)).screen.includes(marker), {
    timeoutMs: UPSTREAM_RECOVERY_MS,
    intervalMs: 500,
    description: `PTY output to reach the daemon ring within ${UPSTREAM_RECOVERY_MS}ms of an upstream stall`
  });
});

test('#732 RED: a session with a dead upstream must not be advertised as healthy', { skip: SKIP }, async () => {
  const s = await A.session(sid);

  // Today: CONNECTED / OWNER_CONNECTED, because health is derived purely from
  // isOpenWebSocket(session.ownerWs) (daemon.js:902-915). The owner socket is
  // open and answering pings; it just never sends anything. Liveness of the
  // socket is not liveness of the pipe.
  assert.notEqual(s.healthStatus, 'CONNECTED',
    'health must degrade when the owner WS is open but has delivered no upstream bytes');
});

test('#732 RED: inject must not report plain success into a session whose upstream is dead', { skip: SKIP }, async () => {
  const r = await A.inject(sid, 'echo C732_BLIND\n');

  // Today: 200 {success:true}. The caller cannot distinguish "delivered and
  // observable" from "delivered into a session whose output nobody can see" —
  // which is what made the live incident invisible for ~9h.
  assert.notEqual(r.status, 200,
    'inject into a session with an unobservable upstream must not look like an ordinary success');
});

test('#732 CONTROL: lastActivityAt is not an upstream signal (it is bumped by the daemon itself)', { skip: SKIP }, async () => {
  // Not a contract — a diagnostic fact worth pinning: daemon.js:2033/2061/4415/1119
  // stamp lastActivityAt on the daemon's OWN delivery path, so an operator polling
  // activity sees a "live" session even though no byte has come back since the
  // fault. This is why the break stayed invisible.
  const after1 = await A.session(sid);
  assert.notEqual(sessionBeforeFault.lastActivityAt, after1.lastActivityAt,
    'lastActivityAt advanced purely from injects, with zero upstream bytes');
});
