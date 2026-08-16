'use strict';
// #738 repro racer — an "ambient" telepty CLI invocation that happens to run inside the
// launchd kickstart gap (old daemon killed, supervisor instance not yet listening).
//
// This is the REAL cli.js ensureDaemonRunning path: real /api/meta probes with the real
// retry budget (3 attempts, 200ms backoff), the real decideDaemonAction policy, the real
// restartDaemonGraceful, and the real startDetachedDaemon spawn. Only ONE seam is
// replaced — see the SAFETY note below.
//
// Env contract (set by test/kickstart-race-738.test.js):
//   HOME / USERPROFILE  isolated temp home (daemon-state.json, restart-failure.json)
//   TELEPTY_PORT        port cli.js talks to          (cli.js:146)
//   PORT                port the spawned daemon binds (daemon.js:302)
//   PATH                prefixed with a shim dir whose `telepty` symlinks to THIS
//                       worktree's cli.js, so resolveTeleptyEntryPoint() (cli.js:413)
//                       spawns the worktree daemon and never the globally installed one.

const { ensureDaemonRunning } = require('../cli');

// #902: the hand-written `_cleanupDaemonProcesses` no-op that used to live here is GONE, and
// its absence is the point. It existed because the repair path ran a system-wide `ps` sweep
// that SIGTERMed every `telepty-daemon`-titled process on the machine — including the
// operator's production daemon on :3848 — so this racer had to stub the seam out by hand to be
// safe to run. The repair path is now scoped to the daemon the CLI addresses (this racer's
// TELEPTY_PORT, an OS-assigned ephemeral port under a temp HOME), so the REAL stop path cannot
// reach any daemon but this fixture's own. Running it unstubbed is the honest regression.
ensureDaemonRunning()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`[RACER] ${error && error.message}`);
    process.exit(1);
  });
