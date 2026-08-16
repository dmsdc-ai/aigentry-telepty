# SPEC — Scope the daemon sweep to the daemon the CLI is addressing (#902 / sp902)

- **Status**: SPEC ONLY — nothing implemented. Implementation is a separate dispatch after owner approval.
- **Author**: architect session `sp902-sp902-sweep`, 2026-08-16
- **Repo**: `aigentry-telepty` @ `2589bd7` (v0.8.0), read-only measurement on the live host
- **Structure freeze**: owner granted an explicit exception for this task ("근본 원인은 고쳐야지"). The exception is for a fix, not a refactor — see §6.
- **Constraint honored while writing**: no daemon was started, stopped, restarted or signalled; no `npm test`; no `telepty` CLI invocation of any kind. All measurement is `ps` / `lsof` / file reads / `gh issue view` / source reading.

---

## §0 Measurement log — Rule 39 re-measurement and deltas

Every claim in the dispatch brief was re-measured at the source. Three deltas, two of them material to the design.

| # | Brief claim | Re-measured verdict |
|---|---|---|
| 0.1 | `isLikelyTeleptyDaemon` at `daemon-control.js:109` | **CONFIRMED.** Line 109 is exactly `if (text.includes('telepty-daemon')) {`. |
| 0.2 | `findPortOwnerPid` port source defaults `o.port \|\| 3848` | **CONFIRMED.** `daemon-control.js:401`. |
| 0.3 | CLI warns about the hazard at `cli.js:1046` and `daemon.js:476` | **CONFIRMED** at both lines, verbatim. |
| 0.4 | "all three selection sources hit the production daemon" | **DELTA — only two do, today.** `~/.telepty/daemon-state.json` **does not exist** while a live daemon runs (measured 2026-08-16). The state-file source therefore contributes nothing. See §0.a — this is a second latent defect and it changes the design. |
| 0.5 | The 23:54:55 kill came from a worker's `telepty inject --ref …` | **PARTIALLY CONFIRMED, with a new fact.** `~/.telepty/supervisor-defer.json` (mtime 2026-08-15 23:54, `recordedAt: 2026-08-15T14:54:26.658Z` = 23:54:26 KST, 29 s before the kill) carries signature **`launchd:52209`**. The signature is `${supervisor.kind}:${PORT}` (`cli.js:1031`), so the CLI that walked the restart path was addressing **port 52209** — while the sweep it then ran targeted the owner of **3848**. See §0.b. This is the strongest available evidence for the whole spec and it was not in the brief. |
| 0.6 | Production daemon pid 47956 | Superseded — the live daemon is now **pid 98714**, ppid 1 (launchd), title `telepty-daemon`, owner of `:3848`. |
| 0.7 | "the resident daemon does not run this code path" | **CONFIRMED for the daemon process, MISLEADING for blast radius.** `daemon.js:9` imports only `{ claimDaemonState, clearDaemonState, isProcessRunning }` — the sweep is never in the daemon's image. But the daemon *parents every PTY session*, and those sessions run `telepty inject` to report. The sweep therefore executes as the daemon's own grandchild, dozens of times an hour. See §4.2. |

### §0.a Delta: the production daemon never writes `daemon-state.json`

```
$ ls ~/.telepty/          → no daemon-state.json (config.json, peers.json, sessions/, shared/, supervisor-defer.json)
$ lsof -nP -iTCP:3848 -sTCP:LISTEN -t   → 98714
$ ps -axo pid=,command= | grep telepty  → 98714 telepty-daemon
$ ps -p 98714 -o ppid=                  → 1   (launchd)
```

Cause (`daemon.js:490`):

```js
if (require.main === module) {                       // ← FALSE in production
  const daemonClaim = claimDaemonState({ host: HOST, port: Number(PORT), version: pkg.version });
```

The launchd plist runs `telepty daemon` → `cli.js` → `require('./daemon.js')`, so `require.main` is **cli.js**, not daemon.js. `#896` fixed exactly this guard for the *title* three lines above (`require.main === module || AIGENTRY_TELEPTY_DAEMON_MAIN === '1'`, `daemon.js:485`) and left the *state claim* on the old guard. Consequences measured today:

- the state-file source of the sweep is inert (only 2 of 3 sources are live);
- `telepty daemon stop` currently depends **entirely** on the port-owner source — which is why removing that source would brick the operator (§2.3);
- the singleton "already running, exiting" guard is inert;
- `scripts/postinstall.js:81` gates on the state file, so it logs *"No running daemon detected — nothing to restart"* on every `npm i -g` and never upgrades the daemon.

**This is out of scope for #902** (it is not the sweep) but the design must not assume the state file exists. Filed as an open question (§7.1).

### §0.b Delta: the smoking gun is a port mismatch, and it is on disk

```json
// ~/.telepty/supervisor-defer.json  (written 23:54:26 KST, kill at 23:54:55)
{ "signature": "launchd:52209", "recordedAt": "2026-08-15T14:54:26.658Z" }
```

Written by `deferToSupervisor` (`cli.js:1054`) at the moment it gave up waiting and printed *"launchd did not restore the daemon in time — starting one directly"* — which is the line immediately preceding `doRestart()`. The signature proves the addressed port was 52209 (an ephemeral/test port), and `cleanupDaemonProcesses()` is called from `restartDaemonGraceful` with **no options** (`cli.js:580`), so its port-owner source fell back to `3848` and its process scan matched every `telepty-daemon`-titled process on the machine.

A CLI that was configured to talk to :52209 destroyed the daemon on :3848. That single sentence is the defect.

There is also a **second, independent destruction path in the same function** that the brief did not name: on a supervised host `restartDaemonGraceful` calls `restartSupervisorDaemon()` (`cli.js:617`) → `launchctl kickstart -k gui/<uid>/com.aigentry.telepty` (`src/supervisor.js:151`). `-k` SIGTERMs the running job. That is **label-scoped, not port-scoped**: it kills the supervised daemon no matter which port the CLI is addressing, and it is the more literal explanation of the reported `launchctl … last exit -15`. Both paths must be scoped (§2.4).

---

## §1 The trigger census

### 1.1 Direct call sites of `cleanupDaemonProcesses()` — 7, one of them dead

| # | Site | Scope today | Notes |
|---|------|-------------|-------|
| C1 | `cli.js:580` — `restartDaemonGraceful` step (a), `const cleanup = options._cleanupDaemonProcesses \|\| cleanupDaemonProcesses` (`cli.js:564`) | machine-wide, **no port passed** | The hazard. Reached by 22 CLI commands (§1.2). |
| C2 | `cli.js:769` — `repairLocalDaemon` | machine-wide, no port | Then calls `restartDaemonGraceful` → sweeps **twice**. |
| C3 | `cli.js:1297` — interactive `response.action === 'daemon'` | machine-wide | **DEAD CODE**: the menu (`cli.js:1254-1264`) emits no `'daemon'` value. Rule 29 — reported, not deleted. |
| C4 | `cli.js:1593` — `telepty cleanup-daemons` | machine-wide | Legitimate: this command's whole contract is "kill every telepty daemon on this box". |
| C5 | `install.js:42` — `cleanupLocalDaemons()` | machine-wide | Legitimate: service (re)install. |
| C6 | `scripts/postinstall.js:101` | machine-wide | Currently unreachable in production (§0.a). |
| C7 | `src/uninstall.js:57` | machine-wide | Legitimate: uninstall. |
| — | `daemon-control.js:440` — `stopDaemon()` | **already surgical** (`listDaemonProcesses: () => []`, port from caller) | telepty#55. The fix reuses this; it does not invent anything. |

### 1.2 CLI entry points that reach C1/C2 — 25 command paths through 1 funnel

`ensureDaemonRunning()` (`cli.js:1059`) is the funnel: whenever `decideDaemonAction` returns `start` or `restart` it calls `doRestart()` → C1.

**`ensureDaemonRunning` call sites (5):** `cli.js:795` (`discoverSessions`), `1353` (interactive spawn), `1878` (`allow`/`enable`/`wrap`), `3671` (`deliberate`), `4232` (`listen`/`monitor`).

Because `discoverSessions()` calls it first thing, every command that discovers or resolves a session inherits it:

- **via `discoverSessions()` directly** — `list` (1666), `attach` (2652), `multicast` (3332), `broadcast` (3385), `clean` (3529), `session info` (3628), `handoff` (3765), interactive menu (1325, 1396)
- **via `resolveSessionTarget()` miss path** — `attach` (2678), `read-screen` (2774), **`inject` (2871)**, `enter` (3061), `send-key` (3108), `reply` (3141), `status` (3162), `status-report` (3281), `multicast` (3335), `delete` (3453), `kill` (3485), `rename` (3603), `session info` (3629)
- **direct** — `allow`/`enable`/`wrap`, `deliberate`, `listen`, `monitor`, interactive spawn
- **via `repairLocalDaemon()` (C2)** — `update` (1537), interactive *update* (1277), interactive *repair-daemon* (1305)
- **explicit** — `cleanup-daemons` (C4), `uninstall` (C7)
- **non-CLI** — `npm install` postinstall (C6), service install (C5)

**Count: 25 CLI entry points (22 through `ensureDaemonRunning`, 2 through `repairLocalDaemon`, 2 explicit, 1 interactive menu) + 2 install-time entry points.**

Commands that do **not** reach it (useful contrast — they talk to the daemon without managing it): `spawn`, `injects`, `connect`, `connect-http`, `disconnect`, `peers`, `init`, `--version`, and `daemon start|stop|restart` (which uses the surgical `stopDaemon`).

### 1.3 Why a plain `inject` reaches daemon management — the exact branch

**One line:** `inject` never calls daemon management directly; `resolveSessionTarget` (`cli.js:908`) tries the local daemon with a **1.5 s** budget (`cli.js:894-896`, `AbortSignal.timeout(1500)`), and *any* miss — slow, non-200, malformed — returns `null` and drops into `discoverSessions()` (`cli.js:915`), whose first statement is `await ensureDaemonRunning()` (`cli.js:795`).

Full chain, with the probe budget that decides a live daemon is dead:

```
telepty inject <sid> …                                  cli.js:2871
└─ resolveSessionTarget(sid)                            cli.js:908
   ├─ resolveLocalSessionTarget → GET /api/sessions, timeout 1500 ms   cli.js:894
   │     miss (slow / non-OK / not in list) ⇒ null      cli.js:897-899
   └─ discoverSessions()                                cli.js:915
      └─ ensureDaemonRunning()                          cli.js:795
         ├─ 3 × GET /api/meta, timeout 1500 ms each, backoff 200/400 ms   cli.js:367,1081
         ├─ (only if meta never came) GET /api/sessions, timeout 5000 ms  cli.js:1095
         ├─ decideDaemonAction ⇒ { action:'start', reason:'daemon-unreachable' }   cli.js:994
         ├─ deferToSupervisor() → "managed by launchd; waiting up to 10s"  cli.js:1035
         │     10 s elapse ⇒ writeMarker({signature:`launchd:${PORT}`})    cli.js:1054   ← the 23:54:26 artifact
         └─ doRestart() = restartDaemonGraceful()       cli.js:1166
            ├─ cleanup()  ← cleanupDaemonProcesses() with NO port         cli.js:580   ← KILL #1 (3848 default + title scan)
            └─ restartSupervisorDaemon() → launchctl kickstart -k <label> cli.js:617   ← KILL #2 (label-scoped)
```

**Total silence required to reach the kill: ~1.5 s (local) + 3 × 1.5 s + 0.6 s backoff (meta) + 5 s (sessions) ≈ 11.6 s of unanswered HTTP.** On a host running a full `npm test` (dozens of PTY spawns) or a 30-session fan-out, an alive-but-busy daemon exceeds that. Note the failure is *not* a version mismatch and *not* a refusal — #820/#835/#844 already hardened every branch where the daemon **answers**. The surviving hole is the branch where a healthy daemon merely stays **quiet** long enough, which no amount of answer-classification can close.

Second, faster route to the same place: once `supervisor-defer.json` holds a **fresh** marker for the same signature, `deferToSupervisor` returns `null` immediately (`cli.js:1032`) and the 10 s grace disappears — the marker makes the hazard *faster*, not safer.

**Correctness gate for the rest of this spec:** the trigger is a *timeout classification*, and the kill is *unscoped*. This spec fixes the second. Widening the timeouts would only move the threshold; it is listed as a rejected alternative (§5.F).

---

## §2 The scoping design

### 2.1 The invariant

> **A CLI process may only signal the daemon it is addressing.** The addressed daemon is defined by the CLI's own resolved endpoint — `REMOTE_HOST` + `PORT` (`cli.js:152-153`). "A process on this machine whose title looks like a daemon" is not an address and must never authorize a signal on a non-operator-initiated path.

Corollary: machine-wide sweeps remain available, but only where the operator explicitly asked for one (`cleanup-daemons`, `install`, `uninstall`).

### 2.2 The change (recommended: **D1 — reuse the surgical stop that already exists**)

The codebase already contains the correctly-scoped function. telepty#55 wrote `stopDaemon()` (`daemon-control.js:438`) with this comment, which is the design statement for this spec:

> *"Unlike cleanupDaemonProcesses (which ALSO sweeps the whole process table for ANY telepty daemon …), stop must be SURGICAL: it targets only the daemon THIS CLI is configured for … so it can never reap an unrelated telepty daemon."*

The repair path never adopted it. D1 is therefore three edits, not a new subsystem:

**D1.1 — `restartDaemonGraceful` and `repairLocalDaemon` use the surgical stop.**
`cli.js:564` → `const cleanup = options._cleanupDaemonProcesses || ((o) => stopDaemon({ ...o, port: Number(PORT) }))`, and `cli.js:769` likewise. Effect: no process-table scan, port-owner scoped to the addressed port. The injectable seam name is unchanged, so `test/supervisor-restart-757.test.js`, `test/daemon-restart-fallback-15.test.js` and `test-support/kickstart-race-738-racer.js` keep working verbatim.

**D1.2 — the state-file source must match the addressed port.**
`daemon-control.js:384` currently targets `state.pid` while ignoring the `host`/`port` that `claimDaemonState` wrote alongside it (`daemon-control.js:88-94`). Add the gate:

```js
if (state && Number.isInteger(state.pid) && state.pid > 0 && state.pid !== process.pid
    && (state.port == null || state.port === addressedPort)      // ← new
    && confirmCmdline(state.pid)) {
```

`state.port == null` keeps pre-0.4 state files (no port field) working — same tolerance #15 needed for daemons that predate the file entirely.

**D1.3 — drop the `|| 3848` fallback on the port-owner source; require an explicit port.**
`daemon-control.js:401` → `(o.findPortOwnerPid || findPortOwnerPid)(o.port)` with `findPortOwnerPid` already returning `null` for a non-integer port (`daemon-control.js:203`). Export `DEFAULT_PORT = 3848` and let the *callers* supply it: `stopDaemon` keeps its own `port: o.port || DEFAULT_PORT` default (`daemon-control.js:442`, unchanged — this is what preserves operator `daemon stop` on a default host), `cleanup-daemons`/`install`/`uninstall` pass `DEFAULT_PORT` explicitly. A silent global default is exactly the mechanism that killed :3848 from a :52209 CLI; making it explicit at three legitimate call sites is the whole point.

**D1.4 — port-gate the supervisor paths (the second kill route, §0.b).**
`deferToSupervisor` and `restartSupervisorDaemon` act on a **label**, not a port. Gate both on the CLI addressing the port the supervised job actually serves:

```js
// cli.js, one place, consumed by deferToSupervisor + restartDaemonGraceful
const supervisorOwnsThisPort = Number(PORT) === DEFAULT_PORT;   // the plist runs `telepty daemon` with no PORT override
const supervisor = supervisorOwnsThisPort ? detectSupervisor() : { present: false };
```

Measured justification: the live plist's `EnvironmentVariables` carries `PATH` and `TELEPTY_NO_TAILNET_AUTO` only — no `PORT` — so the supervised daemon binds the default. A CLI addressing any other port is, by construction, not addressing the supervised daemon and has no business kickstarting its label. Known regression, deliberately accepted: an operator who supervises a *non-default* port loses supervisor-aware restart and falls back to the pre-#738 detached spawn (which then hits the #15 blocked-port diagnostic instead of binding). That is a degraded restart, never a wrong kill. §7.2 asks the owner whether that configuration exists.

**Estimated production diff: ~28 lines across 2 files** (`daemon-control.js` ≈ 12, `cli.js` ≈ 16), plus new tests. No new file, no new module, no new abstraction.

### 2.3 Reconciliation — telepty#44

*What #44 was:* on macOS/Linux the daemon sets `process.title = 'telepty-daemon'`, which **replaces** the command field `ps -axo command=` returns, so `isLikelyTeleptyDaemon` matched nothing, `cleanupDaemonProcesses()` stopped zero daemons, the old daemon kept the port, and `telepty update` failed all 3 attempts leaving users on the old version. The widening (`daemon-control.js:109`, one token) restored detection.

*What #44 asked for:* the issue lists three candidate fixes and marks **#2 as preferred**:

> *"**Robust (preferred):** stop the daemon by **authoritative PID**, not by command-line text … target `readDaemonState().pid` and/or `findPortOwnerPid(port)` (both already exist), then fall back to the heuristic."*

The shipped fix was option 1 (the title token). **D1 is #44's own preferred option 2.** It keeps the title token — `isLikelyTeleptyDaemon` is untouched and still runs, now purely as the *confirmation* step on an authoritative pid (`pidMatchesTeleptyCmdline`, `daemon-control.js:359`), which is precisely "authoritative PID, heuristic as fallback".

*Does #44's scenario still get solved?* Yes, and the existing regression proves it: `test/daemon-restart-title-44.test.js:100` spawns a **real** `telepty-daemon`-titled child, points `findPortOwnerPid` at it, and asserts it is selected with `source: 'port-owner'` and the **real** `pidMatchesTeleptyCmdline` doing the confirming. That test exercises the port-owner+title path, which D1 keeps as the primary source. The `telepty update` upgrade path — old daemon on the addressed port, new CLI — is a *same-port* case in every configuration #44 describes.

*What D1 removes is only what #44 never asked for:* killing daemons that are **not** on the addressed port. **Verdict: compatible; D1 is a strict completion of #44, not a rollback.**

### 2.4 Reconciliation — telepty#15

*The contract, as stated by the issue and as implemented:*

1. **Discover the daemon when `daemon-state.json` is absent** — the reporter's daemon was v0.1.98 bundled in aterm, predating the state file. Fallbacks required: process title, and `lsof -i :3848` port owner ("definitive").
2. **Fail fast with an actionable diagnostic naming the parent app** instead of 3 blind retries (`cli.js:603-612`, `formatDaemonStopDiagnostic` at `cli.js:551`).
3. **Warn once per blocked state**, not on every command (`restart-failure.json`, `daemon-control.js:327`).

*How D1 honors each:*

1. **Preserved and promoted.** The port-owner source survives untouched and becomes the *primary* discovery source — which is not a theoretical nicety: §0.a measured that on this very host it is the **only** working source today. #15's own words ("port owner PID (definitive)") are D1's design principle applied to one port instead of a machine.
2. **Untouched, and already correctly scoped.** `restartDaemonGraceful`'s survivor probe already reads `portOwner(Number(PORT))` (`cli.js:607`) — the addressed port, not 3848. D1 makes the *kill* consistent with the *diagnostic* that already exists two statements later. The `kill <pid> && telepty daemon` recovery line is unchanged.
3. **Untouched.** `restart-failure.json` signature already embeds the port-owner pid.

One honest note: #15's daemon was **foreign-parented and unkillable**, so D1 changes nothing for it — that daemon was never stopped by the sweep either; it was reported. **Verdict: compatible; D1 strengthens #15's fallback rather than competing with it.**

### 2.5 Reconciliation — `telepty daemon stop` must keep working (the bricking risk)

This is the risk that outranks the bug. A wrong fix strands an operator with an unstoppable daemon.

*Measured baseline (today, this host):* `stopDaemon({port: 3848})` → state-file source contributes **nothing** (no file, §0.a) → port-owner source finds 98714 → `pidMatchesTeleptyCmdline` confirms via the `telepty-daemon` title → SIGTERM→SIGKILL. **The port-owner source is single-handedly keeping `telepty daemon stop` alive.**

*Under D1:*
- `stopDaemon` keeps its own `port: o.port || 3848` default (`daemon-control.js:442`) — **explicitly retained**, and `cli.js:1623/1642` keep passing `Number(PORT)`. The default-3848 behavior operators rely on is untouched.
- D1.2's state-file port gate is a no-op today (no file) and a correctness win when §7.1 restores the file.
- D1.3 removes the *implicit* 3848 only from callers that never chose it. `stopDaemon`'s default is a *chosen* one at an operator-initiated site.
- `cleanup-daemons` keeps the full machine-wide sweep: the documented escape hatch when a daemon is on an unexpected port or unreachable by address. The `restartDaemonGraceful` failure banner (`cli.js:670`) should gain `— or run "telepty cleanup-daemons"` so the escape hatch is discoverable at the moment it is needed (2 words, counted in the diff estimate).

*Residual bricking surface after D1:* a daemon that is (a) not on the addressed port **and** (b) not in the state file can no longer be reaped by an automatic path. That is by design — it is somebody else's daemon — and it remains reachable by `telepty cleanup-daemons` and by `kill <pid>`, both already printed in the failure diagnostics. **Verdict: no new bricking surface.**

---

## §3 Behavioral contract table

`A` = the daemon on the CLI's addressed `host:PORT`. `X` = any other telepty daemon on the machine (different port, or a foreign/bundled one). ✱ marks a changed cell.

| Command class | May signal `A` — before | May signal `X` — before | May signal `A` — after | May signal `X` — after | Justification for the change |
|---|---|---|---|---|---|
| `daemon stop` / `daemon restart` | yes (state pid + port owner) | no | yes | no | Unchanged — already surgical (telepty#55). Only the state-file source gains a port match (no-op today, §0.a). |
| `cleanup-daemons` | yes | yes | yes | yes | Unchanged by design. The operator's explicit "kill every telepty daemon here" command; the escape hatch that keeps §2.5 honest. |
| `install` / `uninstall` / postinstall | yes | yes | yes | yes | Unchanged. Machine-level lifecycle; the operator is installing/removing the product, not addressing a session. |
| `inject`, `enter`, `send-key`, `reply`, `read-screen`, `attach`, `status`, `status-report`, `multicast`, `broadcast`, `delete`, `kill`, `clean`, `rename`, `session info`, `handoff`, `list` | yes | **yes** ✱ | yes | **no** ✱ | The measured defect. A session-addressed command has no mandate over any daemon but its own. Kill route #1 (`cleanup()` with no port) closed. |
| `allow` / `enable` / `wrap`, `deliberate`, `listen`, `monitor`, interactive spawn | yes | **yes** ✱ | yes | **no** ✱ | Same funnel (`ensureDaemonRunning`), same verdict. |
| `update`, interactive *update* / *repair-daemon* | yes | **yes** ✱ | yes | **no** ✱ | `repairLocalDaemon` is "repair **my** daemon". #44's upgrade scenario is a same-port case and is preserved (§2.3). |
| Any of the above **on a supervised host, addressing a non-default port** | yes + `launchctl kickstart -k <label>` ✱ | **yes** ✱ | yes (spawn path) | **no** ✱ | Kill route #2 (§0.b/D1.4). A label-scoped restart is not an address-scoped one. Accepted cost: no supervisor-aware restart for non-default supervised ports (§7.2). |
| `spawn`, `injects`, `connect`, `connect-http`, `disconnect`, `peers`, `init`, `--version` | no | no | no | no | Never reached daemon management. Listed to bound the census. |

**Every changed cell is the same change**: "may signal a daemon it is not addressing: yes → no". No cell moves from `no` to `yes`.

---

## §4 Blast radius and rollout

### 4.1 What breaks if this is wrong

| Failure mode | Severity | Detection | Mitigation |
|---|---|---|---|
| Sweep too narrow → `telepty update` leaves the old daemon running (a #44 relapse) | HIGH — the exact regression #44 filed | `test/daemon-restart-title-44.test.js` + R6 (§4.4); `telepty --version` vs `/api/meta` version after update | Port-owner source retained as primary; upgrade is a same-port case |
| Sweep too narrow → operator cannot stop a daemon (**bricking**) | CRITICAL | R8 + manual `daemon stop` on the live host | `stopDaemon`'s 3848 default retained; `cleanup-daemons` retained machine-wide; failure banner points at both |
| Port gate wrong (e.g. `PORT` read before env resolution) → sweep targets nothing, restart loops | MEDIUM | R1/R4 red-first | `PORT` is a module-level const resolved at `cli.js:153`, before any command dispatch |
| Supervisor gate too strict → orphan daemons return (#738) on non-default supervised ports | LOW (no known config, §7.2) | `test/kickstart-race-738.test.js` (temp HOME, ephemeral port — will exercise the gated-off branch and must be updated to pin the default port or assert the new gate) | Degradation is a failed restart with a diagnostic, never a kill |
| A latent caller passes no port after D1.3 | LOW | `findPortOwnerPid(undefined)` returns `null` → source silently contributes nothing | R1 asserts it; all 4 call sites are in the census (§1.1) |

### 4.2 Why this deploys to CLI invocations only — claim verified, with a correction

**Verified:** `daemon.js:9` imports exactly `{ claimDaemonState, clearDaemonState, isProcessRunning }`. `cleanupDaemonProcesses` / `stopDaemon` / `listDaemonProcesses` never enter the daemon's image; the only `cleanupDaemonProcesses` mention in `daemon.js` is the hazard comment at line 476. The resident daemon does not sweep, and a fix ships entirely in the CLI. **A daemon restart is therefore NOT required to adopt the fix.**

**Correction to the inherited framing:** "CLI invocations only" understates the blast radius. The daemon parents every PTY session, and those sessions run `telepty inject` to report — so the sweep executes as the daemon's own **grandchild**, on the mandated reporting path, dozens of times per hour. That is why the 23:54 incident was self-inflicted: the report command a worker is *required* to run is one of the 25 entry points. Rollout is "next CLI invocation after `npm i -g`", with no daemon restart — which is convenient, but it also means *every unpatched CLI on the box remains armed until it is upgraded*, including any `telepty` resolved from a stale PATH (`resolveTeleptyEntryPoint`, `cli.js:503`).

### 4.3 Rollout sequence

1. Land D1 behind no flag (a flag would be a second code path to test — §5.A).
2. `npm i -g` on the operator host; no daemon restart needed (§4.2).
3. Verify `which telepty` resolves to the upgraded install and that no worker session holds a stale PATH entry.
4. Run the suite-level acceptance (§4.5). Only after 0 deaths across N runs does #902's "no `npm test` on this host" restriction lift.
5. `state/` bookkeeping: close #902; leave #905 (STALE bounce / allow-bridge re-registration) open — D1 removes the *cause* of daemon replacement but does not make the bridge re-register.

### 4.4 Test plan — REDs first

All unit REDs use injected seams (`stopDaemonProcess`, `findPortOwnerPid`, `readDaemonState`) so **nothing is ever signalled**, matching the existing discipline in `test/daemon-control-port-owner.test.js` and `test/positive-evidence-844.test.js`.

| ID | RED (must fail before the fix) | Asserts |
|---|---|---|
| **R1** | `cleanupDaemonProcesses({ port: 52209, findPortOwnerPid: (p) => p === 3848 ? 98714 : null, … })` currently targets 98714 | port-owner source consults **only** the addressed port; no 3848 fallback |
| **R2** | state file `{ pid: 4242, port: 3848 }`, addressed port 52209 → currently targeted | state-file source gated on port match; `port == null` still targeted (back-compat) |
| **R3** | `restartDaemonGraceful` with a spy `listDaemonProcesses` → currently invoked | the repair path performs **no** process-table scan |
| **R4** | **The fl850/sp902 fixture, promoted to a regression.** Spawn a real `telepty-daemon`-titled child (reuse `spawnTitledChild` from `daemon-restart-title-44.test.js`), have it own port A; drive the CLI addressing port B; assert **zero** targets from all three sources | the measured incident cannot recur |
| **R5** | `restartDaemonGraceful` with `PORT=52209` on a fake-launchd host, spy on the `execFileSync` seam → currently `launchctl kickstart -k` fires | kill route #2 closed; no supervisor action for a non-supervised port |
| **R6** | (**GREEN before and after** — the #44 guard) titled port owner **on the addressed port** → still selected, `source: 'port-owner'` | #44 not regressed |
| **R7** | (**GREEN before and after** — the #15 guard) state file absent + foreign-parented port owner on the addressed port → fail-fast diagnostic names the parent, no retries | #15 contract intact |
| **R8** | (**GREEN before and after** — the anti-brick guard) `stopDaemon()` with no explicit port + owner on 3848 → stopped | `telepty daemon stop` default preserved |

Also to be updated, not added: `test/kickstart-race-738.test.js` runs on an ephemeral port under a temp HOME and will now take the gated-off supervisor branch — it must either pin `TELEPTY_PORT=3848` inside its temp environment or assert the new gate explicitly. `test-support/kickstart-race-738-racer.js`'s hand-written `_cleanupDaemonProcesses` no-op stub (and its SAFETY comment) becomes unnecessary; leaving it is harmless, and removing it is the honest signal that the hazard is gone.

### 4.5 Suite-level acceptance — the gate that lifts #902's restriction

On the operator host, **with the live production daemon running**:

```bash
DAEMON_PID_BEFORE=$(lsof -nP -iTCP:3848 -sTCP:LISTEN -t)
for i in $(seq 1 10); do npm test; done
DAEMON_PID_AFTER=$(lsof -nP -iTCP:3848 -sTCP:LISTEN -t)
launchctl print gui/$UID/com.aigentry.telepty | grep -i 'last exit'
```

**Pass = all three:** `PID_BEFORE == PID_AFTER` after every run; `last exit` shows no new `-15`; `~/.telepty/supervisor-defer.json` is not rewritten with a foreign-port signature during the runs. N=10 (the 2026-08-15 baseline produced a death in a single run, so 10 clean runs is a ~2-decade improvement in odds, not a formality).

Only after this passes does the "no full `npm test` on this host" restriction lift. Until then it stands — and note that D1 alone does not make the suite *safe* to run: it makes the suite's **CLI children** harmless (ephemeral ports, temp HOMEs, no table scan). Any test exercising `cleanup-daemons` / `install` / `uninstall` with the **real** (un-stubbed) machine-wide sweep must be audited as part of implementation; today's copies all inject seams, and that must be asserted, not assumed.

---

## §5 Alternatives rejected

- **A. Env kill-switch only** (`TELEPTY_NO_DAEMON_SWEEP=1`, mirroring the existing `TELEPTY_NO_SUPERVISOR_DEFER` at `src/supervisor.js:54`) — rejected: it leaves the default path destructive and requires every operator, every worker session, every CI job and every `npm test` invocation to remember an opt-out. Both measured kills came from processes nobody thought to opt out. It also adds a second code path to test while fixing nothing. (`TELEPTY_NO_SUPERVISOR_DEFER=1` does disable kill route #2 today and is a legitimate *interim mitigation* until D1 ships — it does **not** disable route #1.)
- **B. Change the port default only** (`o.port || 3848` → `o.port`) — necessary but **insufficient, and provably so on this host**: with `daemon-state.json` missing (§0.a), the **process-scan** source alone selects pid 98714 by title. Measured: `ps -axo pid=,command= | grep telepty-daemon` → `98714 telepty-daemon`. Fixing the port default while leaving the table scan in the repair path changes nothing about the 23:54 incident. (This restates fl850's conclusion from an independent measurement.)
- **C. Confirm-before-kill via an HTTP `/api/health` version check** — rejected: a version match is not an address match. It would still authorize killing a healthy daemon of the right version on the wrong port, which is exactly the incident.
- **D. Never kill; always fail fast with a diagnostic** — rejected: that is a #44 relapse. The sweep exists so `telepty update` can replace a daemon that owns the port; removing the capability re-opens the "silently stays on the old version" defect for every user.
- **E. Make the daemon resist termination (signal handler / pidfile lock)** — rejected: it does not stop `launchctl kickstart -k`, it breaks `daemon stop`, and a daemon that cannot be stopped is the bricking failure this spec is most concerned with.
- **F. Widen the probe timeouts so a busy daemon is not classified dead** — rejected as *the* fix (it only moves the threshold; a loaded host will cross any finite budget) but worth revisiting **separately**: the 1.5 s local probe at `cli.js:894` is the single cheapest reduction in how often the funnel is entered at all. Not in this spec's scope — D1 makes the entry harmless, which is the property that matters.
- **G. Replace the process scan with `pgrep`/richer identity (bind address in the title, e.g. `telepty-daemon:3848`)** — rejected for now: it changes the daemon's identity claim (#896 territory), needs a daemon restart to take effect, and buys nothing D1 does not already get from the port owner. Reconsider only if a scan-based source is ever needed again.

---

## §6 Structure-freeze impact statement

The owner approved an **exception for a fix**, not a refactor. Exactly what changes:

**Files touched: 2 production files + tests.**

| File | Function | Change | Est. lines |
|---|---|---|---|
| `daemon-control.js` | `cleanupDaemonProcesses` | state-file source gains `state.port === addressedPort` gate (D1.2); port-owner source loses the `\|\| 3848` implicit default (D1.3) | ~8 |
| `daemon-control.js` | module exports | export `DEFAULT_PORT = 3848` (named constant replacing 3 literals) | ~4 |
| `cli.js` | `restartDaemonGraceful` | `cleanup` seam default → `stopDaemon({ port: Number(PORT) })` (D1.1); failure banner mentions `cleanup-daemons` (§2.5) | ~6 |
| `cli.js` | `repairLocalDaemon` | same seam swap (D1.1) | ~2 |
| `cli.js` | `ensureDaemonRunning` / supervisor detection | `supervisorOwnsThisPort` gate (D1.4) | ~6 |
| `cli.js:1593`, `install.js:42`, `src/uninstall.js:57`, `scripts/postinstall.js:101` | machine-wide callers | pass `DEFAULT_PORT` explicitly (behavior identical) | ~4 |

**Production total: ~28-30 lines across 2 files (+4 one-line call-site edits).** Tests: 5 new REDs (R1-R5) ≈ 120 lines, 3 existing tests kept green as guards (R6-R8), 1 existing test updated (`kickstart-race-738`).

**What does NOT change** — stated explicitly so the exception cannot be read as a licence:

- No new file, module, class, interface, factory, or config surface. (Constitution §1.)
- No new dependency. (Constitution §17.)
- `isLikelyTeleptyDaemon`, `listDaemonProcesses`, `listUnixProcesses`, `listWindowsProcesses`, `stopDaemonProcess`, `findPortOwnerPid`, `probeTeleptyOnPort`, `findParentProcessInfo`, the restart-failure marker, and the supervisor-defer marker: **untouched**.
- `cleanupDaemonProcesses`'s machine-wide semantics: **untouched**; only who calls it changes.
- `stopDaemon`'s signature and its 3848 default: **untouched**.
- `decideDaemonAction`, `deferToSupervisor`'s wait/marker logic, `waitForDaemonHealth`, every #820/#835/#844 refusal classification: **untouched**.
- The probe budgets (1.5 s / 3× / 5 s / 10 s): **untouched** (§5.F).
- No reformatting, no renames, no adjacent-style harmonization. (Rule 29.)
- **Pre-existing dead code reported, not deleted**: `cli.js:1295-1301` (interactive `action === 'daemon'` — no menu entry emits that value). Separate cleanup task.
- **Adjacent defect reported, not fixed**: `daemon.js:490`'s `require.main === module` guard (§0.a). Separate task; D1 does not depend on it.

---

## §7 Open questions — owner only

1. **`daemon-state.json` is never written in production** (§0.a: `daemon.js:490` guard, the sibling of the one #896 fixed at line 485). Side effects measured: no singleton guard, `postinstall` never upgrades the daemon, and the sweep runs on 2 of 3 sources. Fix in the #902 implementation dispatch, or file separately? **Recommendation: separately** — it is a different defect, it needs a daemon restart to take effect (D1 does not), and D1 is correct with or without it.
2. **Is there any host where the supervised daemon serves a non-default port?** D1.4 gates supervisor restart on `PORT === 3848`, justified by the live plist carrying no `PORT`. If such a configuration exists anywhere in the fleet, the gate needs the supervised port read from the plist/unit instead (~10 more lines) and I will revise before implementation.
3. **Should `telepty inject`'s report path stop entering the funnel at all?** §5.F: raising the 1.5 s local probe (`cli.js:894`) would cut how often *any* command reaches daemon management on a loaded host. Out of scope here by construction — asking only whether you want it queued as its own task.
