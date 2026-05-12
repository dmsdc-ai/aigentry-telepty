# Phase 1 sidecar plan — codex r1 review (implementer)

## Verdict
ACCEPT_WITH_MAJOR_FIXES

The plan is implementable in the large: Rust, `portable-pty`, current-thread Tokio, POSIX UDS, atomic manifests, and kill-gate ordering are the right direction. It should not be dispatched to M1 as-is because several contract surfaces are described as Phase 1 acceptance gates while the implementation/test plan only covers a subset.

## Top 3 issues
1. **Wire enum scope is narrower than the accepted V1 ADR A1/A2 contract.** The plan's G4 limits emitted `signal_kind` to POSIX `{SIGINT, SIGTERM, SIGHUP, SIGKILL}` (plan:L29), and `wire::SignalKind` comments Windows values as Phase 2 (plan:L162). V1 ADR A1 already includes `JOB_TERMINATE` and `CTRL_BREAK_EVENT`, with fail-closed receiver behavior. Similarly, G5 defines a Phase 1 error-code subset and stubs the rest (plan:L30) while the plan also includes idempotency tests (plan:L416), which need a clear relationship to `ERR_DUPLICATE_OP`. Fix: define the full A1/A2 enum set in `wire.rs` and golden fixtures in Phase 1; platform-gate emission/semantics, not schema.
2. **The §8.A always-on test bucket is not fully aligned with SPEC-C3-r1.** The plan commits to 8 scenarios (plan:L406-L418), defers parent-death detection (plan:L419-L421), and does not list standalone trace-id propagation / schema-version enforcement scenarios equivalent to SPEC-C3-r1 §8.A-trace-id and §8.A-schema. If Phase 1 is intentionally POSIX-only and parent-death-light, the plan must state this as a C3 exception with acceptance impact, not just a skipped item.
3. **M5/coexistence scope contradicts the rollback story and likely breaks the LOC budget.** M5 says a bridge accepts POSTs from `daemon.js` (plan:L374-L377), §6 says the daemon checks backend tags and routes to Rust UDS (plan:L470-L473), but rollback says `daemon.js` / `cli.js` / `tui.js` are not modified (plan:L489). Also, the module budgets sum to ~1400 LOC before `main`, errors/config, CI glue, bridge code, and measurement scripts (plan:L37, L137-L214). Fix: either make M5 a documented manual shim outside daemon code, or declare the exact Node files touched and exclude bridge LOC from the Rust spike budget.

## Section + milestone findings

### §2 crate layout
- Workspace split is realistic and matches M28: `core` as `cdylib` + `rlib`, thin `bin` wrapper (plan:L71-L80, L92-L97).
- `Rust 1.82 (or whichever is current stable)` is not a deterministic MSRV pin (plan:L86). Pick one exact toolchain in `rust-toolchain.toml`.
- The C ABI stub should not use `unimplemented!()` inside `extern "C"` (plan:L97). A panic across a C ABI boundary is the wrong failure mode; return a stable error code or expose no callable symbol until a smoke test exists.
- Dependency set is mostly right (plan:L103-L113). Add an explicit `libc` dependency or state that all libc calls go through `nix::libc`, because the kill gate uses `libc::killpg` / `waitpid` semantics (plan:L234).
- M27 caching is covered via `Swatinem/rust-cache` + `sccache` (plan:L355), but selective LTO is not specified. Add a release-profile note or defer it explicitly.

### §3 modules
- `supervisor`, `wire`, `manifest`, `ipc`, `kill_gate`, and `boot` are reasonable module cuts (plan:L135-L271).
- `manifest::write` includes tmp + fsync + rename (plan:L179-L195), but omits fsync of the containing directory, which the V1 ADR manifest atomicity sequence includes. Add directory fsync where supported.
- `ipc` spawns one task per connection (plan:L209-L211), but the C3 concurrent-frame rule requires all inbound frames to funnel through one internal linearization queue. Add this as an `ipc -> supervisor` channel invariant before M3.
- Parent death is stubbed to Phase 2 (plan:L255), while C3 treats parent death as an always-on bucket scenario. This can be an explicit Phase 1 exception, but it must be reflected in the acceptance gate.
- The `boot` module's minimal profile table is acceptable for a spike (plan:L261-L271), but it depends on Q1 resolution because the cited V1 ADR section is missing.

### §4 M1-M5 milestones
- M1 is bounded and concrete (plan:L279-L295).
- M2 is feasible but dense for 2-3 days: process-group confirmation, graceful escalation, reap loop, PTY drain, tombstone path, and A8 unlink all land together (plan:L297-L318). Consider making the fault-injected unkillable path a separate demo checkpoint.
- M3 is the critical integration milestone and is probably the riskiest: UDS server, NDJSON dispatch, PTY write/read broadcast, kill frames, delete frames, ping/pong, and error taxonomy all land in 3-4 days (plan:L321-L344). This is where internal queueing and full wire enum definition must be fixed.
- M4 has the right CI/RSS shape (plan:L346-L367), but the RSS script is not reproducible enough as written: `pgrep -f telepty-supervisor-bin` can sample unrelated stale processes (plan:L359-L364). Add cleanup/trap, exact child command, and per-run session namespace.
- M5 is not concrete enough for dispatch. The plan needs a precise write scope for `bridge-phase1.js`, `cli.js`, and `daemon.js`, or else the "daemon unchanged" rollback claim should be removed.

### §5 tests
- The three-bucket split follows SPEC-C3-r1 structurally (plan:L400-L455).
- The always-on bucket should add explicit tests for trace-id propagation through kill/shutdown paths and unsupported `v` rejection. The snapshot fixture (plan:L460) is useful but not enough by itself unless it is tied to runnable contract tests.
- Deferring Windows functional tests is explicit (plan:L353, L388-L396) and acceptable only if Phase 1 acceptance is declared POSIX-only everywhere. Do not describe C3 as fully satisfied by this plan without that exception.
- The no-mocks rule for kill semantics is correct (plan:L434). Fault-injected unkillable behavior is acceptable because real D-state testing belongs to destructive/manual scope.

### §6 migration
- Sidecar/off-by-default coexistence is the right rollback posture (plan:L468-L473).
- Collision behavior should not return an `ERR_SHUTTING_DOWN`-shaped error when a live manifest already exists (plan:L472). This is a spawn/collision failure; use a stable A2 code such as `ERR_SPAWN_FAILED` or define a precise Phase 1 mapping.
- The cutover criteria are concrete (plan:L477-L485), especially 50 flake-free PR runs and 1h RSS soak.
- The rollback path is only true if M5 does not modify existing Node files (plan:L489). Resolve the contradiction with M5 before implementation starts.

### §7 risks
- R1 correctly names the Windows `portable-pty` gap and defers real Windows parity (plan:L499).
- R2 correctly recognizes that the C2 PoC measured sequential dummy supervisors, not persistent real PTY supervisors (plan:L500). Tighten the phrase "15 MB total RSS / process" to "each supervisor process <= 15 MB RSS."
- R3 should mention that `MALLOC_CONF` must be effective before jemalloc initializes. Setting it inside `bin::main` may be too late depending on allocator initialization order (plan:L366, L501).
- Add a risk for "contract-test subset passes while ADR enum set drifts"; R8 gestures at this (plan:L506), but the fix must be a full enum golden, not only local snapshots.

### §8 open Qs (1-by-1 binding-required vs informational)
- Q1 boot adapter reference: **binding-required before M5**, informational before M1 if M1-M3 use raw argv only (plan:L515).
- Q2 `graceful_grace_ms`: **binding-required before M2 acceptance**. The plan admits there is no CLI flush-time measurement task (plan:L517); add one or formally accept the default as a spike hypothesis.
- Q3 submit-gate parity: **binding-required before M5** if the orchestrator smoke test uses real AI CLI REPL injection; informational if M5 uses a raw shell fixture (plan:L519).
- Q4 cdylib smoke: **binding-required before Phase 2**, optional for Phase 1. If left optional, the C ABI stub must not be called (plan:L521).
- Q5 RSS methodology: **binding-required before M4/G9** because it defines the E3 evidence quality (plan:L523).
- Q6 session directory collision: **binding-required before M3/M5** because it affects manifest/socket path ownership (plan:L525).
- Q7 CI runner sizing: **informational** unless G10 fails (plan:L527).

### §9 acceptance gate
- The acceptance gate is measurable and correctly includes M1-M5 demos, §8.A, G1-G10, RSS, cross-LLM review, Node regression, and LOC budget (plan:L533-L542).
- G9 is concrete in threshold but not yet concrete in workload. Define exact idle child, warm-up duration, sampling commands per OS, cleanup, and whether RSS or PSS is authoritative (plan:L34, L538).
- The LOC gate needs a counting rule: include/exclude generated code, bridge JS, CI scripts, and FFI stubs. Without that, the 1500 LOC ceiling is not enforceable.

## C3 spec alignment audit
- §1 lifecycle: normal / graceful / forced are mapped to M2-M3 (plan:L299-L318, L339-L340). Parent death and crash recovery are explicitly partial/deferred (plan:L255-L257), which is the main C3 exception.
- §2 timeouts: default constants are mapped (plan:L244-L253), but `graceful_grace_ms` measurement/configurability remains unresolved (plan:L517).
- §3 cross-OS behavior: POSIX is mapped; Windows is compile-only stub (plan:L388-L396). This is acceptable for a POSIX Phase 1 spike but not for claiming full C3 green.
- §4 reaping: direct-child `try_wait` on `spawn_blocking` and pgrp existence checks are mapped (plan:L233-L234), but the internal linearization queue for concurrent frames is missing.
- §5 PTY ordering: POSIX Order A is mapped exactly (plan:L236-L242).
- §6 post-kill invariants: clean unlink vs tombstone is mapped (plan:L31-L32, L175-L197, L317).
- §7 failure modes: unkillable and manifest-write-fail are partially mapped (plan:L195, L317); escaped descendants are not mapped and should be explicitly deferred or logged as advisory-only.
- §8 tests: bucket structure is present, but the scenario subset needs an explicit C3 exception and missing trace/schema tests.
- §9 V1 integration: A1-A3 are cited, but A1/A2 schema coverage needs the fixes above.

## V1 ADR A1-A3 wire alignment audit
- A1 `signal`: **partial**. POSIX emission is covered (plan:L29, L162), but full accepted enum should be in Phase 1 wire types and fixtures.
- A2 `error_code`: **partial**. The Phase 1 minimum subset is defined (plan:L30), but excluded codes still need stable enum variants. `ERR_DUPLICATE_OP` especially conflicts with the planned idempotency scenario.
- A3 `exit_reason`: **aligned**. The plan uses `{normal, signaled, killed, crashed, unkillable}` and clean unlink / tombstone split (plan:L31-L32, L164, L175-L197).
- B3 trace_id: **mostly aligned in behavior**, but `Frame.trace_id` is optional at the base type level (plan:L160). Add validation that requires it for `inject` and `output`, plus contract tests.

## Anti-patterns / hidden assumptions
- `extern "C"` + `unimplemented!()` is a bad stub for a future ABI.
- "Current stable" MSRV undermines reproducibility.
- Setting jemalloc tuning from `main` assumes allocator init has not already happened.
- `daemon.js` can route to a bridge while also being "untouched."
- `ps`/`pgrep` RSS sampling assumes a clean host.
- The LOC budget assumes glue code is nearly free; it is not.
- Per-connection `tokio::spawn` assumes current-thread serialization is enough; C3 requires an explicit internal ordering queue.

## Recommendation
- NEEDS_PLAN_R2

R2 should be small and surgical: full A1/A2 wire enum + tests, explicit C3 scenario exception/mapping, resolved M5 coexistence write scope, exact RSS/LOC counting rules, and a concrete answer for Q2/Q5 before M2/M4 respectively. After that, M1 can start.
