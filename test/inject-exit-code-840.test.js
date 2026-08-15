'use strict';

// telepty#840 — `telepty inject` exited 0 when delivery did not happen, so `$?` could not be
// trusted by any script. The orchestrator's `bin/orchestrator-report-target.sh` says so in a
// comment ("that path exits 0 while printing a failure") and measures the endpoint by hand
// instead; `bin/dispatch.sh` gates on the exit code and therefore never saw a failure.
//
// The mechanism is one line repeated: every failure arm in the `inject` handler is
// `console.error(…); return;`. #844 already shipped the pattern that fixes it —
// `markCommandFailed()` (cli.js:313), which sets `process.exitCode = 1` and is guarded on
// `require.main === module` so cli.js required as a library (mcp-server, tests) never has its
// host process's exit code rewritten under it.
//
// THE EXIT-CODE TABLE this file pins. The distinction is not "did an error print" but "did the
// daemon measure a delivery" — `delivery_result` in BOUNDARY.md has five words and only some of
// them are failures:
//
//   arm                                       exit  why
//   ─────────────────────────────────────────────────────────────────────────────────────────
//   session not found on any host             1     (already 1 before this change; guarded here)
//   local daemon answered non-2xx             1     403 blocked / 409 modal / 410 stale /
//                                                   500 / 502 / 503 / 504 — the route only
//                                                   answers non-2xx on `success: false`
//   transport failure (no daemon reached)     1     covered in
//                                                   test/local-write-peer-independence-837.test.js
//   remote (SSH) inject returned success=false 1    the hop reported the delivery did not happen
//   --submit failed (transport or non-2xx)    1     text landed, no turn fired, nothing else
//                                                   will fire it
//   ─────────────────────────────────────────────────────────────────────────────────────────
//   delivery parked (`queued`, HTTP 200)      0     DELIBERATE. BOUNDARY.md: `queued` means
//                                                   accepted and parked on the bootstrap/modal
//                                                   FIFO. Not a failure, and the caller must not
//                                                   re-dispatch it.
//   consumption === 'queued' after --submit    0    DELIBERATE. Same word, recipient busy: the
//                                                   text is in the composer and will be
//                                                   processed after the current turn.
//   --submit 504 gated-timeout                 0    DELIBERATE. Pre-existing contract stated at
//                                                   cli.js ("Orchestrator scripts depend on exit
//                                                   0 here"), and the daemon may still dispatch
//                                                   after the gate times out
//                                                   (`gated_dispatch_after_timeout`). Changing it
//                                                   would fail every gated dispatch.
//
// The daemon here binds PORT=0 with a temp HOME. Nothing touches the production daemon.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestDaemon, createSessionId } = require('../test-support/daemon-harness');

let daemon;
before(async () => { daemon = await startTestDaemon(); });
after(async () => { if (daemon) await daemon.stop(); });

test('#840: a refused delivery exits non-zero', async () => {
  // Registered, never bridged: the route answers 503 DISCONNECTED. Nothing was written.
  const sid = createSessionId('refused');
  const reg = await daemon.registerSession(sid);
  assert.equal(reg.status, 201, `register failed: ${JSON.stringify(reg.body)}`);

  const result = await daemon.runCli(['inject', sid, 'hello'], { timeoutMs: 15000 });
  assert.match(result.stderr, /\[DISCONNECTED\]/, `precondition: ${JSON.stringify(result.stderr)}`);
  assert.notEqual(result.code, 0, 'a delivery the daemon refused exited 0');
});

test('#840: a session that does not exist exits non-zero', async () => {
  const result = await daemon.runCli(['inject', 'no-such-session-anywhere', 'hello'], { timeoutMs: 15000 });
  assert.match(result.stderr, /was not found/);
  assert.notEqual(result.code, 0, 'an undeliverable dispatch exited 0');
});

test('#840: a PARKED delivery deliberately exits 0 — `queued` is not a failure', async () => {
  // `claude` is a known AI CLI, so the session is bootstrap-gated: the inject is accepted and
  // parked on the FIFO with zero bytes written, and the route answers 200 (#860). A caller that
  // read this as a failure would re-dispatch a delivery that is still going to land.
  const sid = createSessionId('parked');
  const reg = await daemon.registerSession(sid, { command: 'claude' });
  assert.equal(reg.status, 201, `register failed: ${JSON.stringify(reg.body)}`);

  const result = await daemon.runCli(['inject', sid, 'hello'], { timeoutMs: 15000 });
  assert.match(result.stdout, /Context injected successfully/, `precondition: ${JSON.stringify(result.stdout)}${JSON.stringify(result.stderr)}`);
  assert.equal(result.code, 0, 'a parked-but-accepted delivery was reported as a failure');
});

test('#840: a delivery that landed still exits 0', async () => {
  // The over-correction guard: a real PTY-backed session accepts the write, and the command
  // must stay 0. Without this, "make failures non-zero" has no lower bound.
  const sid = createSessionId('live');
  const spawned = await daemon.spawnSession(sid);
  assert.equal(spawned.status, 201, `spawn failed: ${JSON.stringify(spawned.body)}`);

  const result = await daemon.runCli(['inject', sid, 'echo hello'], { timeoutMs: 15000 });
  assert.match(result.stdout, /Context injected successfully/, `precondition: ${JSON.stringify(result.stdout)}${JSON.stringify(result.stderr)}`);
  assert.equal(result.code, 0, 'a successful delivery exited non-zero');
});
