'use strict';
// #896 — `process.title = 'telepty-daemon'` is an identity claim, and only the daemon may make it.
//
// ── The bug ──────────────────────────────────────────────────────────────────────
// daemon.js set the title at module load, outside any guard. On macOS/Linux that REPLACES what
// `ps -axo command=` reports for the process, and that string is how the stop path finds a daemon
// (telepty#44 → isLikelyTeleptyDaemon, daemon-control.js:99-122). So every process that merely
// `require`d daemon.js for its exported pure seams — 22 test files do — presented as a daemon, and
// any concurrent cleanupDaemonProcesses() sweep SIGTERMed it.
//
// Measured in #850: one flagless `npm test` run lost two whole test FILES to `signal: 'SIGTERM'`
// (queued-inject-not-success-860, submit-gate-restore-register-678) plus two daemons killed
// mid-test, ending 1109/1110 tests with 4 fails. The same sweep is system-wide and reaches the
// operator's production daemon on :3848 — the hazard test-support/kickstart-race-738-racer.js
// stubs out by hand, in a comment that names it.
//
// ── The contract ─────────────────────────────────────────────────────────────────
// require ⇒ no claim. Real daemon ⇒ claim, so `telepty daemon stop` keeps working.
//
// ── Isolation ────────────────────────────────────────────────────────────────────
// PORT=0 in both children, so the one that DOES take the real-daemon path binds an OS-assigned
// ephemeral port and never 3848; HOME is the per-process temp home test-support/setup-env.js
// installs, so no live session state is read or restored. Each child exits immediately after
// recording its title. The production daemon on :3848 is never contacted.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const { isLikelyTeleptyDaemon } = require('../daemon-control');

// Require daemon.js in a CHILD and report the title it ended up with. A child, not this process:
// `process.title` is per-process, so setting it here would BE the pollution under test.
// `process.title` is what `ps -axo command=` reports on darwin/linux, so reading it back is the
// same string the sweep matches on — asserted against the real predicate, not a copy of it.
//
// The title goes out through a FILE, not stdout: requiring daemon.js leaves timers (and, on the
// real-daemon path, a listening socket) that would keep the child alive past the read, so it has
// to `process.exit` — and an exit immediately after an async pipe write can truncate it.
// fs.writeFileSync cannot.
function titleAfterRequire(env) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-896-')), 'title');
  try {
    execFileSync(
      process.execPath,
      ['-e', "require('./daemon.js');require('fs').writeFileSync(process.env.TELEPTY_896_OUT,process.title);process.exit(0);"],
      {
        cwd: projectRoot,
        timeout: 30000,
        killSignal: 'SIGKILL',
        stdio: ['ignore', 'ignore', 'ignore'],
        env: {
          ...env,
          TELEPTY_896_OUT: out,
          PORT: '0',                    // daemon.js:302 — never the production port
          TELEPTY_PORT: '0',
          TELEPTY_NO_TAILNET_AUTO: '1'
        }
      }
    );
    return fs.readFileSync(out, 'utf8');
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
}

test('#896: a process that merely requires daemon.js does not claim the daemon title', () => {
  const env = { ...process.env };
  delete env.AIGENTRY_TELEPTY_DAEMON_MAIN; // never inherit a real daemon's signal

  const title = titleAfterRequire(env);

  assert.notEqual(title, 'telepty-daemon',
    `a bare require claimed the daemon title (got ${JSON.stringify(title)})`);
  // The assertion that actually matters: the sweep must not select this process. Asserted through
  // the real predicate, so a future widening of isLikelyTeleptyDaemon cannot silently re-open this.
  assert.equal(isLikelyTeleptyDaemon(title), false,
    `a requiring process still reads as a daemon to the stop path (title ${JSON.stringify(title)})`);
});

test('#896: the real daemon still claims the title, so the stop path can still find it', () => {
  // AIGENTRY_TELEPTY_DAEMON_MAIN is exactly what cli.js sets before `require('./daemon.js')` on the
  // `telepty daemon` path (cli.js:1659) — i.e. this is the production launch, minus the listen.
  const title = titleAfterRequire({ ...process.env, AIGENTRY_TELEPTY_DAEMON_MAIN: '1' });

  assert.equal(title, 'telepty-daemon', 'the daemon must keep presenting as telepty-daemon');
  assert.equal(isLikelyTeleptyDaemon(title), true, 'telepty#44: the stop path finds it by title');
});
