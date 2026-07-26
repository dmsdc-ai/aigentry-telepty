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
// Two shapes of the fault, two contracts:
//   * UNRECOVERABLE (fault mode `mute`) — bytes stop reaching the consumer and no
//     amount of re-arming brings them back. The daemon cannot repair this, so the
//     contract is that it must NOTICE: health degrades to UPSTREAM_STALLED and
//     inject stops reporting plain success.
//   * RECOVERABLE (fault mode `pause`) — the PTY read side merely stopped flowing.
//     The bridge's own watchdog must re-arm it and upstream must resume.
//
// #524 guard: isolated HOME + ephemeral port; the production daemon on 3848 and
// any session this file did not create are never touched.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// NOTE: daemon.js is deliberately NOT required here — a bare require binds a listener,
// which would contend with the operator's daemon. The pure decision logic lives in
// test/upstream-stall-predicate-732.test.js, which pins PORT/HOME before requiring it.
const H = require('../test-support/bridge-pipe-harness');

const SKIP = process.platform === 'win32' ? 'POSIX-only (node-pty master fd semantics)' : false;

// Compressed detection windows so the e2e runs in seconds. Production defaults
// (30s stall / 10s heartbeat) are pinned in test/upstream-stall-predicate-732.test.js.
const FAST = {
  daemon: { TELEPTY_UPSTREAM_STALL_SECONDS: '5', TELEPTY_HEALTH_POLL_MS: '500' },
  bridge: { TELEPTY_BRIDGE_HEARTBEAT_MS: '1000' }
};

// Stand up a real daemon + real `telepty allow` bridge with both legs verified.
async function bothLegsUp(t, { faultMode }) {
  const home = H.makeHome();
  const sid = `c732-${faultMode}-${process.pid}`;
  const daemon = H.startDaemon({ home, env: FAST.daemon });
  let bridge = null;
  t.after(async () => {
    H.killBridge(bridge);
    await H.stopDaemon(daemon);
    fs.rmSync(home, { recursive: true, force: true });
  });

  const port = await H.daemonReady(daemon);
  const A = H.api(port);
  bridge = H.startBridge({
    home, port, sid,
    faultInjector: true,
    env: { ...FAST.bridge, TELEPTY_FAULT_MODE: faultMode }
  });

  await H.waitFor(async () => (await A.session(sid)).id === sid, { description: 'session register' });
  await H.waitFor(async () => (await A.screen(sid)).screen.length > 0, { description: 'first PTY output in ring' });
  await A.inject(sid, 'echo C732_PRE\n');
  await H.waitFor(() => bridge.out.includes('C732_PRE'), { description: 'pre-fault inject reached the PTY' });
  await H.waitFor(async () => (await A.screen(sid)).screen.includes('C732_PRE'),
    { description: 'pre-fault PTY output reached the daemon ring' });

  return { home, sid, daemon, bridge, A };
}

test('#732 REPRO + DETECT: an unrecoverable upstream death is caught, not silently served', { skip: SKIP }, async (t) => {
  const { home, sid, daemon, bridge, A } = await bothLegsUp(t, { faultMode: 'mute' });
  const ringBeforeFault = (await A.screen(sid)).screen;
  const proofFile = path.join(home, 'c732-downstream-proof.txt');

  bridge.severUpstream();
  await H.delay(1000);

  // Downstream proof must not depend on the ring or on the bridge's stdout — both
  // ride the severed leg. A file written by the shell is independent evidence that
  // the injected bytes reached the PTY and the CLI executed them.
  await A.inject(sid, `echo PROVEN > ${proofFile}\n`);
  await H.waitFor(() => fs.existsSync(proofFile) && fs.readFileSync(proofFile, 'utf8').includes('PROVEN'),
    { timeoutMs: 20000, description: 'post-fault inject executed by the PTY' });

  // --- the live signature is still reproduced (the daemon cannot un-lose the bytes) ---
  assert.equal(bridge.alive(), true,
    'bridge process must still be running — a dead bridge is a different (already handled) failure');
  const screen = (await A.screen(sid)).screen;
  assert.ok(!screen.includes('PROVEN'), 'the post-fault command must NOT have reached the ring');
  assert.equal(screen, ringBeforeFault,
    'read-screen returns pre-death content, byte-identical (live: "read-screen returned old content")');

  // --- was RED: health must stop calling an unobservable session healthy ---
  await H.waitFor(async () => (await A.session(sid)).healthStatus === 'UPSTREAM_STALLED', {
    timeoutMs: 30000, intervalMs: 250,
    description: 'health to degrade once the owner is connected but has returned no bytes'
  });
  const s = await A.session(sid);
  assert.equal(s.healthStatus, 'UPSTREAM_STALLED');
  assert.equal(s.healthReason, 'OWNER_CONNECTED_UPSTREAM_STALLED');

  // --- was RED: inject must not look like an ordinary success ---
  const blind = await A.inject(sid, 'echo C732_BLIND\n');
  assert.equal(blind.status, 503, 'inject into an unobservable session must hard-fail');
  assert.equal(blind.body.code, 'UPSTREAM_STALLED',
    'and must say WHICH failure it is, so a caller can tell it apart from a disconnected owner');

  // --- the diagnosis the operator needs: which leg broke? ---
  const tr = s.transport;
  assert.ok(tr.upstream_silent_seconds >= 0, 'upstream silence is measured, not guessed');
  assert.ok(tr.bridge_heartbeat_at,
    'the bridge heartbeat still arrives — so the bridge→daemon leg is fine and the break is above it');
  const beforeBytes = tr.bridge_pty_bytes;
  await H.delay(3000);
  const after = await A.session(sid);
  assert.equal(after.transport.bridge_pty_bytes, beforeBytes,
    'bridge_pty_bytes frozen while heartbeats keep arriving == the PTY read side died inside the bridge');
  assert.notEqual(after.transport.bridge_heartbeat_at, tr.bridge_heartbeat_at,
    'heartbeats are still flowing (silent PIPE, not silent SESSION)');

  assert.match(daemon.log(), /\[UPSTREAM\] Session .* output pipe is dead/,
    'the daemon must announce the stall instead of waiting for a human to read the screen');
});

test('#732 SELF-HEAL: a recoverable PTY read-side stall re-arms and upstream resumes', { skip: SKIP }, async (t) => {
  const { sid, bridge, A } = await bothLegsUp(t, { faultMode: 'pause' });

  bridge.severUpstream();          // read side stops flowing; nothing is destroyed
  await H.delay(500);

  const marker = `C732_HEAL_${Date.now()}`;
  await A.inject(sid, `echo ${marker}\n`);

  // The bridge's own watchdog (cli.js checkPtyReadSide) must notice a read stream
  // that stopped flowing and resume it — without it, the PTY buffer fills, the child
  // blocks, and the session is dead in both directions.
  await H.waitFor(async () => (await A.screen(sid)).screen.includes(marker), {
    timeoutMs: 30000, intervalMs: 250,
    description: 'PTY output to reach the daemon ring again after a recoverable read-side stall'
  });

  assert.equal((await A.session(sid)).healthStatus, 'CONNECTED',
    'once bytes flow again the session is healthy — the stall verdict must clear itself');
});

