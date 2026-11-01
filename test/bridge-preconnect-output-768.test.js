'use strict';

// #135 supersedes the old bootstrap sequence: a wrapped command must wait for
// the owner token. Hold the WS upgrade explicitly while HTTP registration proceeds,
// verify no child output/success, then release it and verify initial and live output.
// All resources use temporary HOME, ephemeral ports and test-owned processes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const H = require('../test-support/bridge-pipe-harness');

const SKIP = process.platform === 'win32' ? 'POSIX-only (node-pty master fd semantics)' : false;

const MARKER = 'C768BOOT';

test('#135/#768: delayed owner claim gates startup and preserves initial PTY output',
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
    proxy = H.startProxy({ targetPort: port, manualHoldWsUpgrade: true });
    const proxyPort = await proxy.listen();

    bridge = H.startBridge({ home, port: proxyPort, sid, env: { PS1: `${MARKER}$ ` } });

    await H.waitFor(async () => (await A.session(sid)).id === sid, {
      timeoutMs: 5000, description: 'HTTP registration while WS upgrade is held'
    });
    const early = await A.session(sid);
    assert.notEqual(early.healthStatus, 'CONNECTED');
    assert.doesNotMatch(bridge.out, /C768BOOT|Inject allowed/);
    assert.equal(early.ptyPid, null, 'no PTY starts before ownership is accepted');
    assert.equal(early.transport.upstream_bytes, 0,
      `the daemon already had upstream bytes before the owner connected\n${JSON.stringify(early.transport)}`);

    proxy.releaseUpgrades();

    // Now let the handshake through and wait for the owner to actually be connected.
    await H.waitFor(async () => (await A.session(sid)).healthStatus === 'CONNECTED', {
      timeoutMs: 20000, intervalMs: 100,
      description: 'the owner WS to connect once the proxy releases the held bytes'
    });

    // Initial output must still reach the ring after the delayed claim.
    await H.waitFor(async () => (await A.screen(sid)).screen.includes(MARKER), {
      timeoutMs: 10000, intervalMs: 100,
      description: 'initial PTY output to reach the daemon ring',
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
      description: 'post-claim output to keep flowing'
    });
    assert.match((await A.screen(sid)).screen, new RegExp(`${MARKER}[\\s\\S]*C768_LIVE`),
      'initial prompt bytes must precede subsequent live output');
  });
