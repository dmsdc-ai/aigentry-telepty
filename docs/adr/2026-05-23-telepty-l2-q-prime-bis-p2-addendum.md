# ADR addendum — P2 Node↔Rust IPC bridge landed via δ1 dispatch

- Date: 2026-05-23
- Status: implemented (commit pending — local-only per dispatch
  `[SAWP] NO push`)
- Owner: δ1-telepty-p2-bridge-coder (dispatch session
  `delta-1-telepty-p2-bridge`)
- Tracking: task #430 P2; orchestrator-side review gate before merge
- Sibling: `docs/adr/2026-05-23-telepty-l2-q-prime-bis-p1-addendum.md`
  (P1 supervisor-core-finish — base layer this work extends)

## Cross-repo reference (carried over)

The synthesis ADR (`docs/adr/2026-05-10-telepty-l2-architecture-q-prime-bis.md`,
status r5+amend-A1A3+r6) and the 6-phase plan live in the
**orchestrator repo** (`~/projects/aigentry-orchestrator/`). Per the P1
hybrid (b)+(c) CLDR finding, this telepty-local addendum mirrors the
record the orchestrator should also land against the synthesis ADR.

## What landed (one-line)

**2026-05-23 P2 Node↔Rust IPC bridge landed via δ1 dispatch** —
`src/bridge/supervisor-ipc.js` (BridgeClient: NDJSON over UDS,
trace_id correlation, ERR_TIMEOUT drift guard, AsyncIterator output
stream with AbortSignal + return() cleanup, ERR_SUPERVISOR_GONE on
close), `src/bridge/j3-shim.js` (0.3.x inject / output / list
translator with 150 ms inline-error window for B3 / duplicate / shutting-down
rejections; list filtered to live ready/draining sessions),
`src/bridge/supervisor-launcher.js` (binary discovery chain
`TELEPTY_SUPERVISOR_BIN` → `target/release` → `target/debug` → PATH;
spawn with stdio shaping; waitReady gated on BOTH manifest status AND
socket existence — closes the supervisor.rs `write_atomic` →
`bind_socket` race without modifying the supervisor crate), plus
`cli.js` minimal-touch (+27 LOC: list merge at L915 dedup by id, inject
bridge-first guard at L1755 with daemon HTTP fallthrough). E2E test
exercises spawn → inject → output via supervisor binary with
daemon.js never started. **375/375 npm tests pass** (343 baseline
preserved + 32 new bridge). **Snyk 0 findings** on bridge code.

## Acceptance criteria (β2 plan §2.4 P2)

| Criterion | Status | Evidence |
|---|---|---|
| E2E `telepty spawn → inject → output` works with daemon.js stopped | ✅ | `test/bridge-e2e.test.js` "spawn → inject → output via bridge alone" — isolated `HOME`, supervisor spawned via launcher, `cat -u` echo loop, inject yields echoed payload through `j3-shim.output` AsyncIterator |
| Bridge protocol covers spawn / inject / output / list / kill / delete (subset of full wire surface) | ✅ subset | inject + output + list wired in P2 J3-shim surface; kill / delete reachable through BridgeClient.send / request (not yet 0.3.x-shimmed — P3 scope). Spawn reachable via supervisor-launcher.spawn (binary subprocess, not wire frame). |
| daemon.js NOT removed | ✅ | `daemon.js` untouched. Bridge-first wiring in `cli.js` falls through to the existing daemon HTTP path on bridge failure or unsupported flag (`--submit`). |
| All existing daemon.js tests preserved (regression guard) | ✅ | 343 baseline tests unchanged; 32 new bridge tests added — total 375/375 pass |

## Surfaces landed (file:line)

| Surface | File:line(s) |
|---|---|
| BridgeClient connect / send / request | `src/bridge/supervisor-ipc.js:267` (connect), `:60` (send), `:88` (request) |
| BridgeClient subscribe (AsyncIterator + AbortSignal) | `src/bridge/supervisor-ipc.js:121` |
| B3 trace_id auto-fill | `src/bridge/supervisor-ipc.js:_prepareFrame` + `KINDS_REQUIRING_TRACE_ID` Set |
| j3-shim inject (0.3.x → Frame::inject) | `src/bridge/j3-shim.js:inject` |
| j3-shim output (Frame::output stream → async generator) | `src/bridge/j3-shim.js:output` |
| j3-shim list (manifest scan filtered to ready/draining) | `src/bridge/j3-shim.js:list` |
| Binary discovery chain | `src/bridge/supervisor-launcher.js:resolveBinary` |
| Supervisor spawn | `src/bridge/supervisor-launcher.js:spawn` |
| waitReady (manifest + socket gate) | `src/bridge/supervisor-launcher.js:waitReady` |
| cli.js list bridge merge | `cli.js:915-931` (dedup by id) |
| cli.js inject bridge-first | `cli.js:1755-1771` (guard: `!useSubmit && findSupervisorManifest`) |
| E2E acceptance test | `test/bridge-e2e.test.js` |

## supervisor.rs race-condition workaround (no crate edits)

`supervisor::run` writes the live manifest (`Status::Ready`) *before*
calling `ipc::bind_socket`. A naive `waitReady` that polls only the
manifest can therefore complete before the UDS socket exists,
producing intermittent `ENOENT` on the first `connect()` from the
bridge. Rather than patch the supervisor crate (which would expand
P2 scope into the P1 surface), `supervisor-launcher.waitReady` gates
on BOTH `manifest.status ∈ {ready, draining}` AND
`fs.existsSync(manifest.ipc.path)`. The supervisor crate is left
unchanged; the bridge side absorbs the ordering quirk. Documented
here so P3 can hoist the manifest-after-bind ordering into the
supervisor itself if desired.

## Constitution / Rule posture

- **§1 lightweight** — three small Node modules (~190-330 LOC each).
  No new framework, no abstraction layer added beyond what the wire
  protocol shape demands. Reused existing test framework (`node:test`).
- **§2 cross-platform** — UDS is POSIX-only in P2 per dispatch §2.
  Bridge tests skip on `process.platform === 'win32'`; launcher
  binary discovery handles `where` vs `which`. Windows native pipe
  = P4 scope.
- **§9 독립** — bridge runs standalone; daemon.js fallback path
  preserved in cli.js (untouched apart from the +27 LOC bridge-first
  guard). `npm test` works with or without the supervisor binary
  present.
- **§13 HOLD via real `telepty inject`** — phase-boundary HOLDs at
  1/4, 2/4, 3/4 delivered via real `telepty inject orchestrator …`
  with `--submit --submit-retry 2 --from delta-1-telepty-p2-bridge`.
- **§17 무의존** — zero new npm dependencies. Stdlib only
  (`net`, `readline`, `crypto`, `fs`, `child_process`).
- **Rule 29 surgical** — every changed line traceable to dispatch
  request. cli.js delta is purely additive (no edits to existing
  lines). cross-machine.js, daemon.js, daemon-control.js untouched.
  CHANGELOG and ADR addendum live alongside the code change in a
  single commit.
- **Rule 32 영구 fix** — bridge replaces the HTTP/WS roundtrip with
  UDS NDJSON: one socket open per inject (no daemon → HTTP server →
  daemon-side session router round-trip). E1 latency bench under
  P1 already shows the underlying wire is 40× under target;
  end-to-end Node→Rust latency through this client is bounded by
  the same window.
- **Snyk At-Inception** — `snyk_code_scan` on `src/bridge/` + new
  test files at the Phase 4 gate → **0 findings** on new code.
  Pre-existing `cli.js` findings (3× path-traversal, 2× command-
  injection) unchanged by this work — they live in dataflows
  separate from the L915 / L1755 insertions.

## Carry-overs

1. **`telepty spawn` cli command bridge wiring** — P2 dispatch
   limited cli.js touch to inject / list. The spawn path stays on
   daemon.js. P3 cli refactor (per orchestrator decision §6.1
   "A surgical") will route `telepty spawn` through
   `supervisor-launcher.spawn` for supervisor-managed sessions.
2. **Render-gated `--submit` over bridge** — daemon.js retains the
   submit gate for the migration window. Bridge inject appends a
   literal `\r` (mirroring 0.3.x `no_enter: false` default). REPL
   readiness detection moves to the bridge in P3+.
3. **Single-binary `telepty supervisor` mode** — P2 still spawns
   the standalone `telepty-supervisor-bin`. Per orchestrator
   decision §6.6 A, the consolidated `telepty supervisor` /
   `telepty relay` / `telepty cli` / `telepty embed` mode lands
   post-P2. Binary discovery in `supervisor-launcher.resolveBinary`
   is shaped to absorb that future location with minimal change.
4. **kill / delete 0.3.x shim entries** — the BridgeClient surface
   already carries these (with B3 trace_id auto-fill), but no
   `j3-shim` wrapper or cli.js wiring yet. P3 owns these.

## Test parity

| Bucket | Status | Where |
|---|---|---|
| BridgeClient connect failures | ✅ | `test/bridge-supervisor-ipc.test.js` (missing socket, empty path) |
| BridgeClient send + auto trace_id | ✅ | (inject default, caller-supplied passthrough, B3 parity for signal/kill/delete) |
| BridgeClient request correlation | ✅ | (pong correlate, ERR_TIMEOUT, supervisor ERR_* preserved) |
| BridgeClient subscribe behaviors | ✅ | (multi-frame order, sid filter w/ sid-less passthrough, AbortSignal cancel, server-close exits cleanly) |
| BridgeClient close semantics | ✅ | (rejects pending, idempotent, send/request after close → ERR_SUPERVISOR_GONE) |
| BridgeClient parse resilience | ✅ | (malformed line surfaces synthetic ERR_BAD_FRAME without tearing down) |
| j3-shim list discovery | ✅ | `test/bridge-j3-shim.test.js` (missing dir → [], non-ready filtered, malformed manifests skipped) |
| j3-shim inject success / error / op_id | ✅ | (success w/o error frame, error in window surfaces ERR_*, idempotency_key → op_id) |
| j3-shim output stream + cancel | ✅ | (yields output + shutdown_drain exit-marker; AbortSignal cancels mid-stream) |
| E2E spawn → inject → output (daemon-stopped) | ✅ | `test/bridge-e2e.test.js` (isolated HOME, `cat -u` echo round-trip) |
| Launcher arg validation + env override | ✅ | (ERR_BAD_ARG on missing sid/argv; TELEPTY_SUPERVISOR_BIN path-not-exist → ERR_BIN_NOT_FOUND) |
| Launcher isAlive negative | ✅ | (phantom session → false) |

## Performance — bridge inject envelope

The Node→Rust path is dominated by:

1. `net.createConnection` on UDS (~µs on local socket)
2. `socket.write(NDJSON line)` flush (~µs)
3. Supervisor `BufReader.lines().next_line()` → `serde_json::from_str`
   → `mpsc::send` (~µs; supervisor inject E1 p50 = 0.025 ms per P1
   bench)
4. PTY write (~µs)
5. Optional 150 ms error window in `j3-shim.inject`

For fire-and-forget inject (no `--submit`), the wall-clock minimum is
~150 ms (the error-window dwell). For latency-sensitive callers, the
window is configurable per call (`{ errorWindowMs }`) or replaceable
with `client.send` + a separate ping-pong for ordered confirmation.

The error window is a deliberate trade-off: catching B3 /
duplicate-op rejections inline matches the 0.3.x daemon's response
shape (callers expect `{success: false, code, error}` on the same
call). A dedicated future `wait_until_dispatched` ping-pong handshake
would tighten this; explicit follow-up if E1 bench reveals it
matters.

## Sources of truth

- This addendum is local to `aigentry-telepty/`.
- Synthesis ADR + 6-phase plan live in
  `~/projects/aigentry-orchestrator/` (per P1 CLDR finding).
- C3 kill-gate spec (`docs/specs/2026-05-10-supervisor-c3-kill-gate-spec.md`)
  + Phase 1 plan (`docs/plans/2026-05-12-phase1-sidecar-spike-plan.md`)
  + P1 addendum
  (`docs/adr/2026-05-23-telepty-l2-q-prime-bis-p1-addendum.md`) are
  the local sources of truth; this work extends them.
