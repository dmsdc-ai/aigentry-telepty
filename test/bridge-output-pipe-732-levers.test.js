'use strict';

// #732 — lever elimination. These are the candidate causes the dispatch listed;
// each is driven end-to-end so the NEGATIVE result is reproducible rather than
// asserted in prose. Both currently PASS, i.e. neither lever reproduces #732.
//
// NOT registered in package.json `test`/`test:ci` — REPRO phase artifact (#732).
//   node --require ./test-support/setup-env.js --test test/bridge-output-pipe-732-levers.test.js
//
// #524 guard: isolated HOME + ephemeral port; nothing outside this file is touched.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const H = require('../test-support/bridge-pipe-harness');

const SKIP = process.platform === 'win32' ? 'POSIX-only (node-pty master fd semantics)' : false;
const SKIP_SLOW = process.env.TELEPTY_732_SLOW === '1'
  ? false
  : 'slow (>90s: must outlast two 30s owner-WS ping intervals) — set TELEPTY_732_SLOW=1';

async function bothLegs(A, bridge, sid, marker) {
  const before = bridge.out.length;
  const r = await A.inject(sid, `echo ${marker}\n`);
  let downstream = false;
  let upstream = false;
  try {
    await H.waitFor(() => bridge.out.slice(before).includes(marker), { timeoutMs: 15000, description: 'PTY' });
    downstream = true;
  } catch { /* reported below */ }
  try {
    await H.waitFor(async () => (await A.screen(sid)).screen.includes(marker), { timeoutMs: 15000, description: 'ring' });
    upstream = true;
  } catch { /* reported below */ }
  return { downstream, upstream, injectStatus: r.status };
}

// Lever (a) — dispatch §2a: "restart the harness daemon and observe whether the
// bridge's reconnect restores BOTH legs or only downstream."
//
// Result: BOTH. A hard daemon restart (SIGKILL, same port) is fully survived —
// the bridge re-registers, reclaims ownership via ?owner=1, and upstream resumes.
// This rules out "the pipe died AT the 22:20 reconnect" as a deterministic
// consequence of restart+reconnect alone.
test('#732 lever (a): a hard daemon restart restores BOTH legs, not just downstream', { skip: SKIP }, async (t) => {
  const home = H.makeHome();
  const sid = `c732a-${process.pid}`;
  let d = H.startDaemon({ home });
  let bridge = null;
  t.after(async () => {
    H.killBridge(bridge);
    await H.stopDaemon(d);
    fs.rmSync(home, { recursive: true, force: true });
  });

  const port = await H.daemonReady(d);
  const A = H.api(port);
  bridge = H.startBridge({ home, port, sid });
  await H.waitFor(async () => (await A.session(sid)).id === sid, { description: 'register' });
  await H.waitFor(async () => (await A.screen(sid)).screen.length > 0, { description: 'first output' });
  assert.deepEqual(await bothLegs(A, bridge, sid, 'C732A_PRE'),
    { downstream: true, upstream: true, injectStatus: 200 }, 'precondition: both legs healthy');

  await H.stopDaemon(d, 'SIGKILL');
  await H.delay(500);
  d = H.startDaemon({ home, port });          // same port — the bridge reconnects to it
  await H.daemonReady(d);

  await H.waitFor(() => /Wrap owner .*connected for session/.test(d.stdout),
    { timeoutMs: 45000, intervalMs: 200, description: 'bridge reconnect + owner reclaim' });
  await H.delay(1000);

  assert.deepEqual(await bothLegs(A, bridge, sid, 'C732A_POST'),
    { downstream: true, upstream: true, injectStatus: 200 },
    'reconnect after a daemon restart restores BOTH legs — restart alone does not reproduce #732');
});

// Levers (b) + (c) — dispatch §2b/§2c: sever the owner WS at the socket layer
// without a clean close, and check for keepalive coverage.
//
// Result: an upstream TCP stall is NOT silent. The daemon's owner-WS ping/pong
// (src/transport/websocket.js:51-59, 30s interval) misses two pongs and calls
// ws.terminate() within ~60s; health drops to DISCONNECTED and inject hard-fails
// 503. That is the opposite of the live signature (inject kept succeeding), so a
// network-level half-open is ruled out as the #732 mechanism.
//
// It does expose the asymmetry in DETECTION that the fix must close: the daemon
// heartbeats its peer, the bridge heartbeats nothing. Once the daemon reaps its
// side, the bridge holds a readyState===1 socket and only discovers the truth if
// and when it next writes — never, for an idle session.
test('#732 levers (b)(c): an upstream TCP stall is reaped by the daemon heartbeat (not silent)', { skip: SKIP || SKIP_SLOW }, async (t) => {
  const home = H.makeHome();
  const sid = `c732b-${process.pid}`;
  const d = H.startDaemon({ home });
  let bridge = null;
  let px = null;
  t.after(async () => {
    H.killBridge(bridge);
    if (px) px.close();
    await H.stopDaemon(d);
    fs.rmSync(home, { recursive: true, force: true });
  });

  const port = await H.daemonReady(d);
  px = H.startProxy({ targetPort: port });
  const pxPort = await px.listen();
  const A = H.api(port);                       // control plane goes direct
  bridge = H.startBridge({ home, port: pxPort, sid });   // only the bridge is proxied

  await H.waitFor(async () => (await A.session(sid)).id === sid, { description: 'register' });
  await H.waitFor(async () => (await A.screen(sid)).screen.length > 0, { description: 'first output' });
  assert.deepEqual(await bothLegs(A, bridge, sid, 'C732B_PRE'),
    { downstream: true, upstream: true, injectStatus: 200 }, 'precondition: both legs healthy');

  px.blackhole('up');                          // bridge→daemon bytes vanish; no FIN, no RST

  await H.waitFor(async () => (await A.session(sid)).healthStatus === 'DISCONNECTED', {
    timeoutMs: 90000, intervalMs: 1000,
    description: 'daemon owner-WS heartbeat to reap the stalled connection'
  });
  assert.match(d.stdout, /Terminating stale connection \(no pong\)/,
    'the reap must come from the server-side ping/pong heartbeat');

  const legs = await bothLegs(A, bridge, sid, 'C732B_POST');
  assert.equal(legs.injectStatus, 503,
    'a reaped owner fails inject hard (503) — unlike #732, where inject kept returning 200');
  assert.equal(legs.downstream, false, 'downstream dies with the socket');
  assert.equal(legs.upstream, false, 'upstream dies with the socket');
});
