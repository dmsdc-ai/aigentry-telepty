# ADR addendum — P1 supervisor-core-finish landed via γ1 dispatch

- Date: 2026-05-23
- Status: implemented (PR pending — branch `feat/supervisor-p1-finish`,
  no git push per dispatch)
- Owner: γ1-telepty-supervisor-core-coder (dispatch session
  `gamma-1-telepty-supervisor-core`)
- Tracking: task #430 P1; orchestrator-side review gate before merge

## Cross-repo reference

The **synthesis ADR** (`docs/adr/2026-05-10-telepty-l2-architecture-q-prime-bis.md`,
status: accepted r5+amend-A1A3+r6) and the **6-phase plan**
(`docs/reports/2026-05-23-telepty-l2-supervisor-plan.md`) live in the
**orchestrator repo** (`~/projects/aigentry-orchestrator/`), not in
this repo. They are referenced by the P1 dispatch but are not visible
from `aigentry-telepty/`. This addendum is therefore the
**telepty-local mirror** of the addendum the orchestrator should also
land against the synthesis ADR.

Per Phase 1 CLDR finding + orchestrator hybrid (b)+(c) decision, P1
contract requirements were derived from the **telepty-local sources of
truth** that *are* in this repo:

- `docs/specs/2026-05-10-supervisor-c3-kill-gate-spec.md` (`SPEC-C3-r1`)
- `docs/plans/2026-05-12-phase1-sidecar-spike-plan.md`

## What landed (one-line)

**2026-05-23 P1 supervisor-core-finish landed via γ1 dispatch** —
A5 (reattach + log offset replay), A7 (list discovery via filesystem
manifest scan), A8 (delete graceful drain contract test), B3 (trace_id
enforcement extended to Signal/Kill/Delete), F3 (atomic manifest write
concurrent-reader contract test), G3 (audit trail ingest event logging
+ rejection logging), §8.A1 (Normal termination contract test), and E1
local-inject latency bench all green. **E1-p50 = 0.025 ms (40× under the
1 ms target) on Apple M4 Pro.** 42/42 tests pass; baseline 23 preserved
per Rule 29 surgical; Snyk 0 findings.

## §8.A contract test parity (C3 spec §8 r1 — Bucket A)

| §8.A scenario | Status | Where |
|---|---|---|
| §8.A1 Normal termination | ✅ Phase 5 | `tests/normal_termination.rs` |
| §8.A2 Graceful shutdown | ✅ Phase 3 | `tests/delete_drain.rs::delete_graceful_*` |
| §8.A2-escalate | ✅ baseline | `kill_gate::tests::graceful_escalates_*` |
| §8.A3 Forced kill | ✅ Phase 3 | `tests/delete_drain.rs::delete_forced_*` |
| §8.A3-tree grandchild cascade | ⚠️ **Follow-up task** | killpg(pgid,_) semantics already correct; explicit fixture deferred to standalone dispatch per orchestrator Phase 5 disposition |
| §8.A.W-jobrace Windows-only | ⏭️ P4 scope | per dispatch §6.2 |
| §8.A4 Parent death | ⚠️ Bucket B | controlled-host scope per C3 spec §8 r1 L901; out of P1 spike scope |
| §8.A4-cleanup | ⚠️ Bucket B | depends on §8.A4 fixture |
| §8.A-reactor-stall | ✅ Phase 6 (code-review annotation) | `supervisor.rs` doc-header; per orchestrator Phase 6 disposition |
| §8.A-trace-id | ✅ Phase 4 | `wire::tests::{inject,signal,kill,delete}_*_trace_id_*` |
| §8.A-schema | ✅ baseline | `wire::tests::version_two_rejected` |
| §8.A-windows-no-sigint | ⏭️ P4 scope | per dispatch §6.2 |
| §8.A-idempotency | ✅ baseline | `ipc::tests::lru_dedupes_repeats` + `ipc_protocol::duplicate_inject_op_id_*` |

**Extras** beyond C3 §8.A (synthesis-ADR surfaces):
- A5 reattach + log replay — `tests/reattach_replay.rs` (3 tests)
- F3 atomic-write concurrent-reader contract — `tests/atomic_manifest.rs` (5 tests)

## Surfaces landed (file-line)

| Surface | File:line(s) |
|---|---|
| A5 | `wire.rs:Kind::Resume + Frame::from_seq`; `ipc.rs:replay_log`; `audit.rs:AuditLogger`; `supervisor.rs:drain_pty_dual` |
| A7 | `manifest.rs:scan_sessions`; `telepty-supervisor-bin/src/main.rs:drive_list` |
| A8 | production code already in `supervisor.rs:run` (unchanged); test `tests/delete_drain.rs` |
| B3 | `wire.rs:validate_incoming` Signal/Kill/Delete arms |
| F3 | production code unchanged (`manifest.rs:write_atomic`); test `tests/atomic_manifest.rs` |
| G3 | `audit.rs` (Phase 2 + Phase 4 extension); `supervisor.rs:dispatch_ingest` ingest log + rejection log |
| §8.A1 | `tests/normal_termination.rs` |
| §8.A-reactor-stall | `supervisor.rs` doc-header annotation |
| E1 bench | `benches/inject_e1.rs` (custom harness, no criterion per Constitution §17) |

## Carry-overs

1. **§8.A3-tree grandchild-cascade test** — registered by orchestrator
   as follow-up task: "telepty supervisor-core §8.A3-tree grandchild
   cascade cleanup test (~100 LOC follow-up to #430 P1)". `killpg`
   semantics already correct; only the explicit fixture is missing.
2. **§8.A4 / §8.A4-cleanup parent-death tests** — Bucket B per C3 spec
   §8 r1; out of Phase 1 spike scope (always-on PR CI = Bucket A only).
3. **R4 TelemetryEvent translation at the P3 cli bridge** — per
   orchestrator Phase 4 decision (`audit.rs` currently writes raw
   `wire::Frame` NDJSON; P3 owns translation).
4. **Windows code paths** — P4 scope per dispatch §6.2. Cargo features
   may gate Windows surfaces but P1 does not implement them.

## Constitution / Rule posture

- **§1 lightweight** — `audit.rs` extended in Phase 4 rather than
  fragmenting into a new submodule; A7 lands as flat `--list` flag on
  existing bin rather than a new `telepty-cli-core` crate.
- **§17 무의존** — no new Rust deps. `tokio` `fs` feature enabled
  (feature flag only); `serde_json` already in workspace deps. Bench
  uses `harness = false` custom main rather than criterion.
- **Rule 29 surgical** — every changed line traceable to dispatch
  request. 23 baseline tests preserved. No drive-by refactors.
- **Snyk At-Inception** — `snyk_code_scan` on `crates/` after each
  Phase 4+ boundary; **0 findings** at every gate.

## Performance — E1 bench data point

```
E1 local-inject latency (1000 samples after 100 warmup)
  platform: macos/aarch64 / Mac16,8 / Apple M4 Pro
  p50: 0.025 ms (target < 1.0 ms)
  p90: 0.057 ms
  p99: 0.091 ms
  min: 0.016 ms  max: 0.197 ms  mean: 0.035 ms
E1-result: PASS
```

40× under target. Run with `cargo bench --bench inject_e1`.
