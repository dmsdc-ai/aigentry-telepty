# #738 — supervisor-aware defer-and-wait — FIX PHASE

**Status: DONE** · **Branch:** `fix/738-kickstart-race-repro` · **Date:** 2026-07-26
**Direction:** (a) Rank 2 as approved. (b0) left to orchestrator task #742 — this fix does
not depend on it. (c) **skipped** — rationale in §6.

---

## 1. RED → GREEN

| | before fix | after fix |
|---|---|---|
| `#738: with a supervisor installed, a CLI racing the kickstart gap defers — no orphan` | **FAIL** — `orphan daemon (pid 82351) owns :51404; the supervisor instance (pid 82358) exited instead of taking it over` | **PASS** — supervisor pid owns the port, still serving, CLI never spawned |
| `#738: with no supervisor installed, the CLI still auto-starts the daemon (unchanged)` | (new) | **PASS** |
| `#738 characterization: two daemons racing one port — loser exits 0, singleton lock never engages (#742)` | (was the REPRO test) | **PASS** |

The old REPRO test asserted the orphan signature end-to-end, so the fix necessarily
invalidates it. Rather than delete the evidence, it was **re-scoped to the primitive it
actually proved** and that the fix does not touch: two daemons racing one port, the loser
exiting 0 via the EADDRINUSE health probe, and `daemon-state.json` never being written
because `claimDaemonState` (daemon.js:382) is `require.main === module`-guarded while
production launches via cli.js. That is #742's territory, and the test now carries an
explicit tripwire — if it ever fails, #742 landed and this fix should be revisited.

Observed timeline of the GREEN run (breadcrumbs are part of the test output):

```
[738 +   626ms] original daemon serving (pid 44930)
[738 +   628ms] kickstart gap open (old daemon dead)
[738 +  1829ms] supervisor relaunch spawned (pid 45000)
[738 +  2232ms] racer exit={"code":0,"signal":null}     ← deferred, never spawned
[738 + 17232ms] supervisor relaunch exit=null           ← still serving
[738 + 19236ms] supervisor pid 45000 owns :54113 — contract satisfied
```

## 2. What changed

| file | change |
|---|---|
| `src/supervisor.js` | **new.** Per-OS detection + the "supervisor didn't deliver" marker helpers. No new deps (§17). |
| `cli.js` | `deferToSupervisor()` (+ `SUPERVISOR_DEFER_MS`), a 12-line gate in `ensureDaemonRunning`, one require, one export. |
| `package.json` | registered the two new test files in `test`, `test:watch`, `test:ci`. |
| `test/kickstart-race-738.test.js` | RED → GREEN, repro re-scoped to characterization, no-supervisor regression added. |
| `test/supervisor-defer-738.test.js` | **new.** 16 unit tests, all seams injected — no sockets, no daemons, no real fs. |

Gate placement (cli.js, `ensureDaemonRunning`):

```js
// ONLY the 'start' path (nothing answered on the port) can be a supervisor restart gap.
// 'restart' means a daemon IS answering and we have decided to replace it — #733,
// deliberately left untouched here.
if (decision.action === 'start') {
  const supervised = await deferToSupervisor(options);
  if (supervised) {
    meta = supervised;
    decision = decideDaemonAction({ meta, requiredCapabilities, cliVersion: pkg.version, sessionsReachable: true });
    if (decision.action === 'noop') return;
  }
}
```

**A gap I found in my own first cut and closed:** the initial version returned early on a
successful defer, silently accepting whatever daemon the supervisor produced. An upgrade
window can leave the supervisor launching an *older* install, so deferring would have
downgraded the CLI's version/capability guarantees. It now re-runs the same
`decideDaemonAction` policy against the delivered daemon: healthy ⇒ done; stale or missing a
required capability ⇒ falls through to the normal restart path. Covered by
*"supervisor restores a STALE daemon → still restarts (no blind accept)"*.

## 3. Per-OS behavior (constitution §2)

Detection is per-OS because the install surfaces are; the **policy is identical everywhere**.

| OS | detected via | source of truth | supervisor present | supervisor absent |
|---|---|---|---|---|
| **macOS** | `fs.existsSync(~/Library/LaunchAgents/com.aigentry.telepty.plist)` | install.js:363 | wait ≤10s (300ms poll) for the launchd daemon, then re-decide on its `/api/meta` | **byte-identical pre-#738 auto-spawn** |
| **Linux (root install)** | `fs.existsSync(/etc/systemd/system/telepty.service)` | install.js:402 | same | — |
| **Linux (non-root install)** | no unit is written at all | install.js:388 (root-gated) | n/a — correctly detects absent | **byte-identical pre-#738 auto-spawn** |
| **Windows** | exit code of `schtasks /query /tn "telepty-daemon" /fo LIST` | install.js:170-180 | same | **byte-identical pre-#738 auto-spawn** |
| **any other platform** | falls into the systemd branch → unit file absent | — | n/a | **byte-identical pre-#738 auto-spawn** |

Cost control:
- **Lazy** — detection runs only when the CLI is about to spawn (nothing answered on the
  port), never on the healthy fast path. The one Windows shell-out therefore never happens
  during normal operation.
- **Memoized** per process (injected deps bypass the cache so tests cannot poison it).
- **Cached negative verdict** — `~/.telepty/supervisor-defer.json`, signature
  `<kind>:<port>`, TTL 5 min, mirroring `restart-failure.json` (telepty#15). An installed
  but broken supervisor (unloaded, disabled, crash-looping) costs the full wait **once**,
  then every command for the next 5 minutes goes straight to the spawn path. The TTL means
  a repaired supervisor is picked up again with no manual cleanup, and a supervisor that
  *does* deliver clears the marker immediately.

Operator controls: `TELEPTY_NO_SUPERVISOR_DEFER=1` (kill-switch → pre-#738 behavior on every
platform) and `TELEPTY_SUPERVISOR_WAIT_MS` (tune the ceiling). Both unit-tested.

Worst case on a supervised host whose supervisor is dead: one command waits 10s, then
behaves exactly as before. Best case (the #738 scenario): the CLI waits ~1s and no orphan is
ever created.

## 4. Snyk — 0 new on changed regions

| target | issues | verdict |
|---|---|---|
| `src/supervisor.js` (new file) | **0** | clean |
| `cli.js` (changed) | 2 Medium `IndirectCommandInjection` | **both pre-existing** |

The two `cli.js` findings carry fingerprints `6eb481d6.…83183368` (line 614, the documented
`TELEPTY_UPDATE_COMMAND` operator override — CHANGELOG baseline waiver) and
`24799351.…83183368` (line 1794, `node-pty.spawn` in the allow/wrap path). Both fingerprints
are **byte-identical** to a scan of the unmodified `cli.js` on main, and neither line is in a
region this change touched. The `schtasks` probe in `src/supervisor.js` interpolates nothing
— the task name is a module constant — and scanned clean.

## 5. Test results

**Per-file run (each file in its own process, 200s cap, strays reaped between files):
71 PASS / 9 TIMEOUT out of 80 files.** Both new files pass:

```
test/kickstart-race-738.test.js       PASS pass=3
test/supervisor-defer-738.test.js     PASS pass=16
```

### The 9 timeouts are pre-existing and environmental, not from this change

Evidence chain:

1. A single `npm test` invocation **stalls on this host at exactly 121 subtests**, at the
   file boundary right after `test/cli.test.js`.
2. **The same stall, at the same subtest, occurs on unmodified `main`** (a full baseline run
   from `/Users/duckyoungkim/projects/aigentry-telepty`).
3. When both runs were force-unblocked, they reported failing-file sets that are
   **byte-identical** (`diff` → no output): the same 9 files.
4. Those 9 files are **exactly** the 9 that TIMEOUT in the per-file run.
5. **All 9 were then re-run per-file against unmodified `main` and every one TIMEOUTs there
   too** — `diff` of the two verdict tables is empty. This is the direct control, not an
   inference.
6. Test counts line up: baseline 854 tests, changed 873 = 854 + 19 new.

Mechanism of the host-level stall: leaked daemons. The box had **107 `telepty-daemon`
processes but only 2 listeners** — ~105 hung daemons accumulated from prior runs. Killing
them (by explicit PID, production excluded) immediately unblocked all three in-flight runs.
`node --test` waits on a test file's stdio pipes, and a leaked daemon holding one keeps the
runner waiting forever.

The 9 files:
`tailnet-autobind`, `daemon-broker-wiring`, `daemon-bind-default`, `peer-inject-validator`,
`submit-gate-restore-register-678`, `codex-submit-0144-730`, `idle-unconfirmed-consumption`,
`idle-unconfirmed-decayed-619`, `idle-unconfirmed-false-negative-721`.

None of them touch `ensureDaemonRunning`'s start path, and the daemon/CLI files that *do*
all pass: `ensure-daemon-running`, `daemon-restart-fallback-15`, `cli`, `subcommand-help`,
`banner-stderr-jq-safety`, `daemon-singleton`, `daemon-lifecycle-55`,
`daemon-control-port-owner`, `integration/daemon-launch`, `version-handshake`.

> **Caveat, stated plainly:** I could not obtain a clean single-invocation full-suite pass on
> this host — and neither could unmodified `main`. The per-file run is the strongest green I
> can produce here. The daemon-leak hygiene problem is worth its own ticket; it is not
> something this change introduced or should fix.

## 6. (c) log-path inheritance — skipped, with reason

Not trivially separable. `startDetachedDaemon` would have to know the supervisor's log path,
and it cannot be derived: install.js's default is `~/.telepty/logs/launchd.{out,err}.log`,
but the **actually installed** plist on this host points at
`~/Library/Logs/aigentry-orchestrator/telepty-daemon.log`. Resolving it correctly means
parsing the plist XML (and the systemd unit, and the Windows task) — a new per-OS parser for
a diagnostic-only benefit. Deferred rather than bolted on.

## 7. Scope compliance

- Rule 29: production diff is `cli.js` (+81/-1) and one new module. No drive-by edits.
- (b0)/#742 untouched — no `require.main` guard was modified; the characterization test
  documents the dependency without creating one.
- No merge, no publish, no version bump. Branch pushed only.
- Every process spawned by the tests is reaped; the leaked-daemon cleanup during
  investigation used **explicit PID lists with the production pid excluded by verified port
  ownership** — never a title pattern (that is what caused the earlier incident).
- Production daemon verified healthy throughout: pid 14592, launchd-owned,
  `/api/health` → `{"status":"ok","version":"0.6.17"}`.
