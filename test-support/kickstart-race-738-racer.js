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

const { ensureDaemonRunning, restartDaemonGraceful } = require('../cli');

ensureDaemonRunning({
  _restartDaemonGraceful: (options) => restartDaemonGraceful({
    ...options,
    // SAFETY (the only stubbed seam): the real cleanupDaemonProcesses does a system-wide
    // `ps -axo pid=,command=` sweep and SIGTERMs every process whose title looks like a
    // telepty daemon (daemon-control.js:160-197) — which includes the operator's
    // production daemon on port 3848. In the gap being reproduced the old daemon has
    // ALREADY been killed by the supervisor, so the real sweep stops nothing and this
    // no-op is behaviorally identical for this scenario.
    _cleanupDaemonProcesses: () => ({ stopped: [], failed: [] })
  })
})
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`[RACER] ${error && error.message}`);
    process.exit(1);
  });
