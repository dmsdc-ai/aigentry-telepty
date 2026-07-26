'use strict';

// #754 — a bridge reconnect can silently strip a session's CLI identity: the registry ends
// up holding the literal string `wrapped` as the session's `command`, and every
// identity-gated feature turns itself off with nothing logged.
//
// Written RED against c5a663b (0.6.18 + #760).
//
// ── Where the generic string comes from ───────────────────────────────────────────────
// src/transport/websocket.js, WS `connection` handler: when the URL names a session the
// daemon does not know, it FABRICATES a record —
//     command: 'wrapped',   cwd: process.cwd(),      // the DAEMON's cwd
// — and only then does the owner claim run. `telepty allow` re-registers before reconnecting
// (cli.js connectDaemonWs, `reconnectAttempts > 0`), but that POST is fire-and-forget behind
// a bare `catch {}`: when the daemon is still coming up it fails, the WS connect a moment
// later succeeds, and the fabricated record is what survives. The bridge knows perfectly
// well which CLI it wraps; the daemon just never asked.
//
// ── What silently switches off, all keyed on session.command ─────────────────────────
//   isBootstrapGatedSession (daemon.js)    → injects stop waiting for CLI readiness
//   detectSurfaceModal / modalRemedy       → #737 codex hold and #760 claude park go dark
//   isPasteCapableCli                      → #730/#716 bracketed-paste envelope dropped
//   ENTRIES lookup (submit render-gate)    → 'unknown_cli'
// No error, no warning: `readyRegistry.isKnownAiCli('wrapped')` is simply false.
//
// Fix: the bridge states its identity on the owner-claim URL (it already carries owner=1 and
// owner_pid there), and the auto-register uses it. Absent → the old 'wrapped' fallback, so a
// pre-fix bridge behaves exactly as before.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

const { startTestDaemon, createSessionId, waitFor } = require('../test-support/daemon-harness');

let harness;
before(async () => { harness = await startTestDaemon(); });
after(async () => { if (harness) await harness.stop(); });

// The exact shape of the failed-re-register reconnect: an owner WS for a session the daemon
// has no record of.
async function ownerConnect(sessionId, query = '') {
  const ws = new WebSocket(
    `ws://${harness.host}:${harness.port}/api/sessions/${encodeURIComponent(sessionId)}`
    + `?owner=1&owner_pid=${process.pid}${query}`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  await waitFor(async () => {
    const list = await harness.request('/api/sessions');
    return Array.isArray(list.body) && list.body.find((s) => s.id === sessionId);
  }, { timeoutMs: 4000, description: 'auto-registered session visible' });
  const list = await harness.request('/api/sessions');
  return { ws, session: list.body.find((s) => s.id === sessionId) };
}

test('#754 RED: a reconnecting bridge keeps its CLI identity through WS auto-register', async (t) => {
  const sessionId = createSessionId('c754-reconnect');
  const { ws, session } = await ownerConnect(sessionId, '&command=claude');
  t.after(() => { try { ws.close(); } catch {} });

  assert.equal(session.command, 'claude',
    'the WS auto-register stamped a generic string over the CLI name — every '
    + 'identity-gated feature (#730 paste envelope, #737/#760 modal gates, bootstrap '
    + 'readiness) is now silently off for this session');
});

test('#754 RED: the identity-gated bootstrap gate is ON for an auto-registered claude', async (t) => {
  // `ready` IS the gate's observable: initializeBootstrapState marks a known AI CLI
  // not-ready until it signals readiness, and flips a generic command ready immediately
  // ('generic_command_compat'). A restamped `wrapped` therefore makes injects stop waiting
  // for the CLI to come up — the #150 compat path, applied to a session that needs the gate.
  const gated = await ownerConnect(createSessionId('c754-gated'), '&command=claude');
  const generic = await ownerConnect(createSessionId('c754-generic'), '&command=bash');
  t.after(() => { try { gated.ws.close(); generic.ws.close(); } catch {} });

  assert.equal(gated.session.ready, false, 'a known AI CLI must keep its bootstrap gate across a reconnect');
  assert.equal(generic.session.ready, true, 'a generic command keeps the #150 compat path');
});

test('#754: a bridge that states no identity keeps the legacy fallback', async (t) => {
  const sessionId = createSessionId('c754-legacy');
  const { ws, session } = await ownerConnect(sessionId);
  t.after(() => { try { ws.close(); } catch {} });

  assert.equal(session.command, 'wrapped');
});

test('#754: auto-register never downgrades a session the daemon already knows', async (t) => {
  const sessionId = createSessionId('c754-known');
  await harness.registerSession(sessionId, { command: 'codex' });
  const { ws, session } = await ownerConnect(sessionId, '&command=claude');
  t.after(() => { try { ws.close(); } catch {} });

  assert.equal(session.command, 'codex',
    'the registered record is authoritative — an owner claim must not restamp it');
});
