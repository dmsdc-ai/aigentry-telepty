// Test-env hygiene (#555): strip ambient TELEPTY_SESSION_ID before any test runs.
//
// `telepty inject` auto-stamps `from = TELEPTY_SESSION_ID` when `--from` is omitted
// (cli.js). That convenience is intentional for real sessions, but when the suite is
// run from a telepty session shell the test process inherits a real session id and
// leaks it into spawned cli.js subprocesses (the harness builds spawn env from
// `...process.env`), producing local-only reds that are CLEAN in CI where the var is
// unset. Loaded via `node --require` so it runs at startup in every test process,
// the deletion keeps the suite deterministic regardless of the ambient environment.
// Tests that need a session id still set it explicitly via their spawn env override.
delete process.env.TELEPTY_SESSION_ID;

// #672 tailnet auto-bind: the suite must be deterministic regardless of whether the host
// running it is on a Tailscale tailnet. Default the opt-out so spawned daemons bind
// loopback (the #50 policy the integration tests assert) instead of the host's live
// tailnet IP; the spawn harness builds child env from `...process.env`, so this
// propagates to spawned daemons. The tailnet path itself is covered by the pure decision
// fns (test/tailnet-autobind.test.js), not a live bind. A test can override by setting
// TELEPTY_NO_TAILNET_AUTO explicitly in its spawn env.
if (process.env.TELEPTY_NO_TAILNET_AUTO == null) process.env.TELEPTY_NO_TAILNET_AUTO = '1';

// #829 PRODUCTION-SAFETY: give every test process its own HOME, before anything reads one.
//
// Every state path in the product resolves through `os.homedir()` — the session store
// (src/session-store/persistence.js), the tracked-injection ledger, the audit log
// (daemon.js AUDIT_LOG_PATH), config (src/config-file.js), sessions (src/lifecycle.js).
// `os.homedir()` reads $HOME on POSIX at call time, so until this line ran, a test that did a
// bare `require('../daemon')` — several unit suites do, for the exported pure seams — loaded the
// developer's REAL ~/.telepty, RESTORED the live sessions found there, and began supervising
// them. Observed on this host: `orchestrator`, `r4x`, `s820` and `m808` restored by a unit test,
// with the process then spinning at ~96% CPU. The orchestrator session dispatching the suite was
// among them.
//
// That is a production-safety hazard, not untidiness: a test run must never touch live session
// state. It is also the likely head of the chain behind #822/#828 — a process supervising real
// sessions has timers it will never clear, so it cannot exit, which is what made the truncating
// `--test-force-exit` feel mandatory in the first place.
//
// The spawn harness already does exactly this per daemon (test-support/daemon-harness.js:62-67);
// this closes the gap for the in-process case. Set before any product module is required,
// because `--require` runs this file first. USERPROFILE too: `os.homedir()` reads that on win32.
//
// Deliberately NOT overridable. A test that needs the real HOME is a finding to be named, not a
// case to be special-cased quietly.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-test-home-'));
process.env.HOME = isolatedHome;
if (process.platform === 'win32') process.env.USERPROFILE = isolatedHome;

// Best-effort: a process that exits cleanly takes its temp home with it. A process that hangs
// (#822) leaks one empty directory into the OS temp dir, which is the lesser problem by far.
process.on('exit', () => {
  try { fs.rmSync(isolatedHome, { recursive: true, force: true }); } catch { /* best effort */ }
});
