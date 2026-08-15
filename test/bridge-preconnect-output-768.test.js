'use strict';

// #768 — the bridge's UPSTREAM leg has a blind spot at BOOTSTRAP, not only mid-session.
//
// relayPtyOutput (cli.js) forwards PTY bytes to the daemon only while the owner WS is open.
// It used to hold nothing back, so every byte the wrapped CLI printed before that handshake
// completed was dropped — permanently, because an idle CLI never reprints. The daemon's ring
// therefore stayed EMPTY for the life of the session, and so did `telepty read-screen` and
// every predicate that reads the ring (#737/#760 modal detection, #801 idle classification).
//
// Live signature (CI, ubuntu-latest, run 30200189371): bridge_pty_bytes=23 while
// upstream_bytes=0, bridge_read_side=ok, session CONNECTED, ring empty. It is the #732
// asymmetry — upstream dead, downstream alive, nothing noticing — arrived at through
// bootstrap timing instead of a fault. Linux loses this race almost always (bash prints its
// prompt in ~200ms; a WS handshake to a just-booted daemon takes longer), macOS usually wins
// it, which is why it only ever surfaced as a "flaky" test rather than as the product bug.
//
// The lever is deterministic on every platform: a TCP proxy postpones the bridge's WebSocket
// UPGRADE by 2.5s while forwarding plain HTTP untouched, so the PTY has certainly booted and
// printed before the owner WS can possibly open. The proxy QUEUES the upgrade rather than
// dropping it, HTTP health/version probes still answer instantly (a fully held leg makes the
// CLI decide the daemon is broken and restart it), and the test proves the ordering it depends
// on rather than assuming it — so a failure here is the bridge's own loss, not the harness's.
//
// #524 guard: isolated HOME + ephemeral ports, every process owned and killed here. The
// production daemon on 3848 is never contacted — the daemon binds its own port under its
// own HOME.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const H = require('../test-support/bridge-pipe-harness');

const SKIP = process.platform === 'win32' ? 'POSIX-only (node-pty master fd semantics)' : false;

// Long enough that the shell's prompt is unambiguously history by the time the owner WS can
// open, short enough to keep the file a few seconds long.
const WS_UPGRADE_HOLD_MS = 2500;
// A prompt nothing else in the suite emits, so finding it in the ring cannot be a false
// positive from another session's bytes. startBridge sets PS1 before spreading `env`, so
// this wins.
const MARKER = 'C768BOOT';

test('#768 RED: PTY output printed before the owner WS opens still reaches the daemon ring',
  { skip: SKIP }, async (t) => {
    const home = H.makeHome();
    const sid = `c768-preconnect-${process.pid}`;
    const daemon = H.startDaemon({ home });
    let bridge = null;
    let proxy = null;
    t.after(async () => {
      H.killBridge(bridge);
      if (proxy) proxy.close();
      await H.stopDaemon(daemon);
      fs.rmSync(home, { recursive: true, force: true });
    });

    const port = await H.daemonReady(daemon);
    // The test talks to the daemon directly; only the BRIDGE goes through the held proxy, so
    // these assertions are never themselves delayed by the lever.
    const A = H.api(port, home);
    proxy = H.startProxy({ targetPort: port, holdWsUpgradeMs: WS_UPGRADE_HOLD_MS });
    const proxyPort = await proxy.listen();

    bridge = H.startBridge({ home, port: proxyPort, sid, env: { PS1: `${MARKER}$ ` } });

    // The shell prints its prompt into the PTY within a few hundred ms — inside the hold.
    await H.waitFor(() => bridge.out.includes(MARKER), {
      timeoutMs: 15000,
      description: 'the shell to print its prompt into the PTY'
    });

    // Prove the ordering this test rests on instead of trusting the timing: the session is
    // registered (HTTP is not delayed) but its owner is NOT connected yet, so the owner WS
    // provably was not open when those bytes were printed.
    const early = await A.session(sid);
    assert.notEqual(early.healthStatus, 'CONNECTED',
      `the owner WS was already connected — the upgrade hold did not take, so this run ` +
      `proves nothing about pre-connect output\n${JSON.stringify(early)}`);
    assert.equal(early.transport.upstream_bytes, 0,
      `the daemon already had upstream bytes before the owner connected\n${JSON.stringify(early.transport)}`);

    // Now let the handshake through and wait for the owner to actually be connected.
    await H.waitFor(async () => (await A.session(sid)).healthStatus === 'CONNECTED', {
      timeoutMs: 20000, intervalMs: 100,
      description: 'the owner WS to connect once the proxy releases the held bytes'
    });

    // --- was RED: upstream_bytes stayed 0 and the ring stayed empty for the whole session ---
    await H.waitFor(async () => (await A.screen(sid)).screen.includes(MARKER), {
      timeoutMs: 10000, intervalMs: 100,
      description: 'the pre-connect PTY output to reach the daemon ring',
      context: async () => {
        const s = await A.session(sid).catch((e) => ({ error: e.message }));
        return `[diag] transport=${JSON.stringify(s.transport)}\n` +
               `[diag] bridge.out=${JSON.stringify(bridge.out)}\n` +
               `[diag] screen=${JSON.stringify((await A.screen(sid)).screen)}`;
      }
    });

    const s = await A.session(sid);
    assert.ok(s.transport.upstream_bytes > 0,
      'the daemon must have been handed upstream bytes, not merely a connected owner');

    // The session is ordinarily healthy afterwards — a flush must not look like a stall.
    assert.equal(s.healthStatus, 'CONNECTED');

    // And the leg keeps working live: the held bytes are a prefix, not a replacement.
    await A.inject(sid, 'echo C768_LIVE\n');
    await H.waitFor(async () => (await A.screen(sid)).screen.includes('C768_LIVE'), {
      timeoutMs: 15000, intervalMs: 100,
      description: 'post-connect output to keep flowing after the pre-connect flush'
    });
    assert.match((await A.screen(sid)).screen, new RegExp(`${MARKER}[\\s\\S]*C768_LIVE`),
      'the flushed pre-connect bytes must land BEFORE the bytes that came after them');
  });
