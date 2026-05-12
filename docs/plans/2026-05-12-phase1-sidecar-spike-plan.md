# Phase 1 Sidecar Spike Implementation Plan

Date: 2026-05-12
Status: **draft (r2-patched — codex r2 verification minor fixes applied)** — see §10 changelog
Target binary: `telepty-supervisor` (Rust)
Scope: minimal working spike — not production. Spike validates the architecture, not the full feature set.
Authoring session: `E-architect-phase1-plan` (architect role; planning, not implementation)

**Bindings (cite-by-section, no re-derivation in this plan):**
- V1 ADR Q'''-bis (status `r5+amend-A1A3+r6`, supervisor language LOCKED → Rust): `aigentry-orchestrator/docs/adr/2026-05-10-telepty-l2-architecture-q-prime-bis.md`
- SPEC-C3-r1 kill gate (r1, closes Phase 0 C3): `aigentry-telepty/docs/specs/2026-05-10-supervisor-c3-kill-gate-spec.md`
- C4 bilingual ops cost report (Path B selected): `aigentry-orchestrator/docs/reports/2026-05-10-telepty-bilingual-ops-cost.md`
- C2 cdylib-in-tokio PoC (PASS_WITH_CONDITIONS, RSS 3.25 MiB / 1 sess): `aigentry-aterm/docs/experiments/2026-05-10-cdylib-tokio-nesting-poc/report.md`
- Current 0.3.5 Node telepty (coexistence target): repo root files `cli.js`, `daemon.js`, `tui.js`, `src/`

---

## 1. Goal + non-goals

### 1.1 Phase 1 success criteria (concrete, measurable)

The Phase 1 spike is **accepted** when the following invariants are demonstrable on macOS arm64 and Linux x86_64 (Windows native is Phase 2+, see §1.2 and §4.6):

| # | Criterion | Measurement | Cite |
|---|---|---|---|
| G1 | A single `telepty-supervisor` process spawns one CLI child via `portable-pty`, owning exactly one PTY pair. | `ps -p <child_pid>` shows child reparented under supervisor; `ls /dev/ptmx`-equivalent / `tty` reports a PTY. | V1 ADR §9.1 per-session supervisor |
| G2 | Supervisor exposes a per-session IPC endpoint (UDS on POSIX) at the path declared by its manifest. | `nc -U <manifest.ipc.path>` connects; NDJSON `ping` → `pong` round-trip succeeds. | V1 ADR M22, §3.2, §6.2 |
| G3 | NDJSON wire frames on the IPC socket conform to V1 ADR §6.1 envelope and §6.2 kind-conditional fields. | Snapshot fixture in `tests/wire/v1-envelope.ndjson.golden` parses without `ERR_BAD_FRAME`. | V1 ADR §6.1, §6.2, M37'/M38' |
| G4 | `signal_kind` **wire schema** covers the full V1 ADR A1 enum `{SIGINT, SIGTERM, SIGHUP, SIGKILL, JOB_TERMINATE, CTRL_BREAK_EVENT}`; Phase 1 supervisor **emits** only the POSIX subset `{SIGINT, SIGTERM, SIGHUP, SIGKILL}`. Windows variants are valid wire schema (parse/round-trip) but `unreachable!()` in Phase 1 emit paths. Receivers MUST fail-closed on values outside the full enum (`ERR_BAD_FRAME`). | Unit test: forced kill on macOS+Linux emits `signal: "SIGKILL"`. Golden fixture round-trips all 6 variants. | V1 ADR §6.2.1 A1; Q-A hybrid (r2) |
| G5 | `error_code` **wire schema** covers the full V1 ADR §6.4 A2 enum `{ERR_UNKNOWN_SESSION, ERR_BAD_FRAME, ERR_UNSUPPORTED_VERSION, ERR_PERMISSION_DENIED, ERR_NOT_REACHABLE, ERR_DUPLICATE_OP, ERR_SPAWN_FAILED, ERR_SHUTTING_DOWN, ERR_UNKNOWN_KIND, ERR_UNKILLABLE_CHILD, ERR_PARENT_GONE, ERR_SUPERVISOR_GONE, ERR_MANIFEST_WRITE_FAIL, ERR_ESCAPED_DESCENDANT, ERR_PGRP_LIVE_AFTER_KILL}`. Phase 1 supervisor **emits** the minimal POSIX-relevant subset (`ERR_UNKNOWN_SESSION`, `ERR_BAD_FRAME`, `ERR_UNSUPPORTED_VERSION`, `ERR_PERMISSION_DENIED`, `ERR_SPAWN_FAILED` for manifest-collision per §6, `ERR_SHUTTING_DOWN`, `ERR_UNKNOWN_KIND`, `ERR_UNKILLABLE_CHILD`, `ERR_MANIFEST_WRITE_FAIL`, `ERR_DUPLICATE_OP` for idempotency in §8.A); the remainder are valid wire schema but `unreachable!()` on emit paths in Phase 1. Cross-machine codes (`ERR_NOT_REACHABLE`, `ERR_PARENT_GONE`, `ERR_SUPERVISOR_GONE`, `ERR_ESCAPED_DESCENDANT`, `ERR_PGRP_LIVE_AFTER_KILL`) are Phase 2 semantics. | Golden fixture round-trips all 15 variants; emission unit tests per Phase 1 code. | V1 ADR §6.4 (A2); Q-A hybrid (r2) |
| G6 | Manifest is atomically written (`tmp + rename`), schema-valid per V1 ADR §7.3, and `exit_reason` follows A3 enum. | Crash supervisor mid-write → no `manifest.json.tmp` survivors; reader never sees partial. | V1 ADR §7.3 (A3) |
| G7 | Clean exit (`exit_reason ∈ {normal, signaled, killed}`) **unlinks** `manifest.json`; `unkillable` or `crashed` writes a tombstone manifest. | §8.A1, §8.A2-escalate, §8.C1 (manual) replicate. | A8 unlink rule; SPEC-C3-r1 §1.1–§1.3, §6.3 |
| G8 | Kill gate state machine implements §1.1–§1.3 (normal / graceful / forced) with timeout matrix §2.1 defaults (`graceful_grace_ms=3000`, `child_reap_timeout_ms=2000`, `pty_read_drain_deadline_ms=500`). | §8.A1, §8.A2, §8.A2-escalate, §8.A3, §8.A3-tree pass on macOS+Linux CI. | SPEC-C3-r1 §1, §2.1, §5.1 |
| G9 | Idle supervisor RSS ≤ **15 MB** (E3 ceiling, amended 2026-05-10) measured on macOS arm64 + Linux x86_64 for both 1-session and 10-session workloads. | `ps -o rss=` (POSIX); 10 concurrent supervisors each ≤ 15 MB. | V1 ADR §10.1 E3, M31 |
| G10 | `cargo build --release` cold ≤ 8 min, warm ≤ 90 s with `Swatinem/rust-cache@v2` + `mozilla-actions/sccache-action`. | CI timing recorded in PR check. | M27, C4 §4 Dim 2 |

**Total scope budget**: spike implementation ≤ **1500 LOC** excluding tests (Article 1 경량; reasonable for a 5–6 module skeleton when most heavy lifting is delegated to `portable-pty`, `tokio`, `serde_json`, `nix`). Tests may exceed this; that is normal. If the implementation drifts above 1500 LOC, **stop and re-scope before continuing** (do not silently expand).

### 1.2 Out-of-scope (explicitly deferred)

The following are **not** Phase 1 work. Anyone reviewing this plan: if you find yourself adding any of these, you are out of scope.

| Item | Deferred to | Reason |
|---|---|---|
| Windows native ConPTY full parity (Job Object, `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`, ConPTY pipe drain ordering) | **Phase 2+** | SPEC-C3-r1 §0.3: stock `portable-pty` 0.9.0 is insufficient on Windows; custom adapter / fork required. Phase 1 ships a Windows-stub IPC module that compiles but rejects spawn with `ERR_UNSUPPORTED_VERSION`. |
| V4 cross-mesh transport (cross-machine relay, M39 inbox notifications, Tailscale + SSH binary reachability) | **Phase 2+** (separate ADR) | V1 ADR §1.6 phasing; this ADR only locks the M39/M40 *contract surface* for forward-compat. No relay binary in Phase 1. |
| Persistent per-host `telepty-relay` (L1 machine boundary) | **Phase 3** | V1 ADR §12 Phase 3 work. |
| AI-mediated triage / inbox aggregation | **Phase 3** | V1 ADR §12 Phase 3 work. |
| Hot-reload / cdylib live-upgrade of supervisor while sessions active | **Phase 4+** | C4 §11 open question Q2; needs separate design. |
| Library API (`telepty_spawn` / `telepty_inject` / `telepty_close` C ABI) for in-process embedding (D1–D3) | **Phase 1 stretch / Phase 2** | Spike validates standalone binary first. cdylib crate-type is configured (M28) but smoke-test of the C ABI is a stretch goal, not an acceptance gate. |
| Full implementation of remaining cross-machine / advisory A2 error codes (`ERR_NOT_REACHABLE`, `ERR_PARENT_GONE`, `ERR_SUPERVISOR_GONE`, `ERR_ESCAPED_DESCENDANT`, `ERR_PGRP_LIVE_AFTER_KILL`) | **Phase 2–3** | Wire-side enums exist (no schema break later); semantics are partly cross-machine. **Note**: `ERR_SPAWN_FAILED` (manifest collision per §6) and `ERR_DUPLICATE_OP` (idempotency LRU per §8.A-idempotency) ARE emitted in Phase 1 — see G5 (L30), §3 wire schema (L188–L193), §4 M3 (L424), §6 (L646). |
| Bridge between Phase 1 supervisor and 0.3.5 Node `daemon.js` (port 3848 HTTP/WS shim) | **Phase 1 stretch (M5)** | M5 is one integration smoke test, not a full bridge. Full bridge belongs to Phase 2 alongside 0.3.x cutover. |
| Full replay-suppression semantics (cross-supervisor reconciliation, durable replay journal) | **Phase 2** | Phase 1 `op_id` is optional per V1 ADR §6.1; **minimal duplicate delete/inject LRU IS Phase 1** for §8.A-idempotency scenarios — see §3 IPC queue (L265), §4 M3 (L424), §5.1 §8.A-idempotency (L578). |
| `cost_budget`, `env_policy`, `parent_id` on `spawn` frames | **Phase 2+** | V1 ADR §6.2 explicitly marks these optional. |
| `restart_policy` orchestrator-side respawn on supervisor crash (§1.5 A.5) | **Phase 2** | SPEC-C3-r1 §1.5: orchestrator-driven, not supervisor-driven. Spike emits the tombstone; orchestrator-side respawn logic lives in `aigentry-orchestrator`. |
| `trace_id` propagation as required field for `inject` / `output` (V1 ADR B3) | **Phase 1 minimum** | B3 says required for `inject`/`output` in Phase 1 — so this IS in scope, listed here for completeness. UUID v7 minted at supervisor boundary if absent. |
| Performance tuning beyond jemalloc env-var (M31 baseline) | **Phase 4** | Phase 4 owns E1–E4 measurement gates. |

---

## 2. Crate layout

### 2.1 Workspace structure

Single cargo workspace at repo root `aigentry-telepty/`, adjacent to the existing `cli.js` / `daemon.js`. Concretely:

```
aigentry-telepty/
├── cli.js, daemon.js, tui.js, src/      # existing 0.3.5 Node surface (untouched in Phase 1)
├── package.json
├── Cargo.toml                            # workspace manifest (NEW)
├── rust-toolchain.toml                   # pin MSRV (NEW)
├── crates/                               # (NEW)
│   ├── telepty-supervisor-core/          # library: PTY, manifest, IPC, kill-gate, wire
│   │   ├── Cargo.toml                    # crate-type = ["cdylib", "rlib"] per M28
│   │   ├── src/lib.rs
│   │   └── src/{supervisor,wire,manifest,ipc,kill_gate,boot}.rs
│   └── telepty-supervisor-bin/           # binary: thin main() + CLI arg parsing
│       ├── Cargo.toml
│       └── src/main.rs
└── docs/plans/2026-05-12-phase1-sidecar-spike-plan.md   # THIS DOC
```

**Rationale**: cargo workspace lets `bin` depend on `core` as `rlib` for the standalone process while `core` simultaneously emits a `cdylib` artifact for future in-process embedding (M28 / D1). This is the **one source tree, two artifacts** pattern locked by V1 ADR M28 and validated by C2 PoC §7 D1/D2/D3.

**MSRV**: Rust **1.82.0** (exact pin; not "current stable"). `rust-toolchain.toml` contents:
```toml
[toolchain]
channel = "1.82.0"
components = ["rustfmt", "clippy"]
profile = "minimal"
```
CI uses this file; deterministic builds across runners. Bump requires a separate PR with cross-LLM review per Article 5 (F1, r2).

**No nested workspaces**, no `cargo-chef` in Phase 1 (M27 lists sccache + Swatinem cache as primary; cargo-chef adds Docker layer complexity not justified at spike scope per C4 §4 Dim 3 "complexity ≈ 3").

### 2.2 Library + binary split

| Crate | `crate-type` | Purpose |
|---|---|---|
| `telepty-supervisor-core` | `["cdylib", "rlib"]` | All logic (PTY, IPC, manifest, kill-gate, wire). Exposes Rust API (rlib, used by bin). Per M28 + D1. |
| `telepty-supervisor-bin` | `["bin"]` (default) | `fn main()`: parse `<sid>`, `<cwd>`, `<argv...>` from CLI args; call `core::run()`. No business logic. |

The `cdylib` crate-type is configured **for build verification only** in Phase 1 — **no callable C ABI symbol is exposed** (no `#[no_mangle] pub extern "C" fn telepty_spawn` stub). Per codex F2 review: panicking across a C ABI boundary via `unimplemented!()` inside `extern "C"` is undefined behavior on most platforms and the wrong failure mode for an unimplemented ABI. The cdylib artifact builds and links (proving M28 packaging works per C2 §7 D1); the actual `telepty_spawn` / `telepty_inject` / `telepty_close` symbols land in Phase 2 alongside the host-loader smoke test (Q4). Phase 1 ships zero callable C ABI surface.

### 2.3 Dependencies

Pinned versions; Phase 1 keeps the dependency surface minimal (Article 17 무의존).

| Crate | Version (target) | Why | Cite |
|---|---|---|---|
| `tokio` | `1.x`, features = `["rt", "macros", "sync", "time", "io-util", "net"]` | Runtime. **`rt` not `rt-multi-thread`** — single-thread executor mandatory. | M24 single-thread tokio |
| `portable-pty` | `0.9.x` | PTY allocation, child spawn (POSIX). Windows path uses it for compile-time stub only. | C4 §3 Path B feasibility evidence; SPEC-C3-r1 §0.3 |
| `nix` | `0.29.x`, features = `["signal", "process", "fs"]` | `kill(-pgid, sig)`, `killpg`, `setsid`. `portable-pty::ChildKiller::kill` is insufficient (pgrp-targeted needed) — SPEC-C3-r1 §5.1. **All `libc` surface (`killpg(pgid, 0)` existence test, `waitpid`) goes through `nix::libc` — no direct `libc` crate dependency** (F3, r2: single-source for libc bindings keeps the dep graph tight per Article 17). |
| `tikv-jemallocator` | `0.6.x` | Allocator override + `MALLOC_CONF=dirty_decay_ms:0,muzzy_decay_ms:0`. | M31 jemalloc tuning |
| `serde` + `serde_json` | `1.x` | NDJSON wire frames. | M37' NDJSON |
| `uuid` | `1.x`, features = `["v7"]` | `trace_id` minting per V1 ADR §6.1 B3 (UUID v7). |
| `tracing` + `tracing-subscriber` | `0.1.x` / `0.3.x` | Structured logs → `log.jsonl`. Disabled in cdylib host-loaded mode (avoid double init). |
| `clap` | `4.x`, features = `["derive"]` | Binary arg parsing (`bin` crate only). |
| `anyhow` + `thiserror` | latest | Error types — `thiserror` for the public `error_code` enum, `anyhow` for internal flow only. |

**Explicitly excluded** in Phase 1:
- `reqwest` / `hyper` (no HTTP in supervisor — M22 OS-native IPC only).
- `tonic` / `prost` (no gRPC; NDJSON per M37').
- `windows-rs` / `winapi` (Windows ConPTY adapter is Phase 2).
- `tracing-tree`, `console-subscriber` (`tokio-console`) — pulled in by dev profile only if needed for §7.3 debugging.
- standalone `libc` crate (use `nix::libc` re-export — F3).

**Release profile (M27 selective LTO)**: `Cargo.toml` `[profile.release]` uses `lto = "thin"` and `codegen-units = 1` for binary size + RSS reduction. Debug builds skip LTO (`lto = false`) to preserve PR-cycle compile time. Full `lto = "fat"` is **explicitly deferred to Phase 4** measurement gates (avoid doubling CI time per M27).

### 2.4 Feature flags

`telepty-supervisor-core` Cargo features:

| Feature | Default? | Effect |
|---|---|---|
| `standalone` | yes | Initializes tracing subscriber, jemalloc, signal handlers. Used by `bin`. |
| `embed` | no | Skips global initializers (host already owns them). Used by future cdylib consumers. |
| `windows-stub` | yes on `target_os = "windows"` only | Compile Windows IPC + spawn paths as `unimplemented!()`. Lets CI on `windows-latest` confirm build success without claiming functional parity. |

**No** `--features test-only-internal` or similar in Phase 1; if internal types need exposure for tests, use `pub(crate)` + integration tests in the same crate (`tests/` dir).

---

## 3. Module breakdown

Six modules under `telepty-supervisor-core/src/`. One file per module; each is single-responsibility per Article 1 경량. Estimated LOC totals are **budgets**, not requirements — coming in under is fine.

### 3.1 `supervisor` — lifecycle, PTY mgmt, child (≤ 350 LOC)

**Responsibility**: own the `tokio::runtime::Runtime` (single-thread), own the `portable_pty::PtyPair`, own the `Box<dyn portable_pty::Child>`. Drive the §1 state machine: `spawning → ready → draining → stopped|error`.

**Public surface** (rlib API):
```text
struct SupervisorConfig { sid: String, cwd: PathBuf, argv: Vec<String>, kill_gate: KillGateConfig }
fn run(cfg: SupervisorConfig) -> Result<()>   // blocks current thread until exit
```

**Key invariants**:
- Reactor is **single-thread** (M24). Any `portable_pty::Child::try_wait` or `kill` call goes through `tokio::task::spawn_blocking` (SPEC-C3-r1 §4.1.1, C2 PoC §6 recommendation).
- The child's `setsid()` happens via `portable_pty::CommandBuilder` (it calls `setsid()` post-fork on POSIX automatically) — confirm this in M1 with a `ps -o pgid=` smoke test.
- Status transitions go through `manifest::write_status()` (atomic write) before any side-effecting kernel call. Reader-side observers see the new status within `manifest_sync_interval_ms` (§2.1: 1000 ms).

### 3.2 `wire` — NDJSON envelope + enums (≤ 200 LOC)

**Responsibility**: serialize/deserialize V1 ADR §6.1 envelope and §6.2 kind-conditional fields. Define enums.

**Types** (serde-derived; **full V1 ADR A1/A2 schema** per Q-A hybrid r2):
```text
#[derive(Serialize, Deserialize)] struct Frame { v: u32, sid: Option<String>, kind: Kind, trace_id: Option<String>, op_id: Option<String>, ts: Option<String>, data: Option<String>, /* kind-conditional: signal, code, frame_ref, cols/rows, argv/cwd/env_policy, force, reason, idempotency_key, from */ }

enum Kind { Inject, Output, Spawn, Delete, Resize, Signal, Ping, Pong, Error }

// FULL A1 enum — wire schema, all 6 variants serialize/deserialize in Phase 1
enum SignalKind { Sigint, Sigterm, Sighup, Sigkill, JobTerminate, CtrlBreakEvent }   // V1 ADR §6.2.1 A1

// FULL A2 enum — wire schema, all 15 variants serialize/deserialize in Phase 1
enum ErrorCode {
    UnknownSession, BadFrame, UnsupportedVersion, PermissionDenied,
    NotReachable, DuplicateOp, SpawnFailed, ShuttingDown, UnknownKind,
    UnkillableChild, ParentGone, SupervisorGone, ManifestWriteFail,
    EscapedDescendant, PgrpLiveAfterKill,
}   // V1 ADR §6.4 (A2)

enum ExitReason { Normal, Signaled, Killed, Crashed, Unkillable }   // V1 ADR §7.3 A3
```

**Emission gate (Q-A hybrid r2)**:
- All wire types **parse and round-trip** the full enums on every platform — receivers conforming to the V1 ADR contract see the same schema regardless of supervisor build.
- Phase 1 supervisor **emits** values from the platform-relevant subset only:
  - `SignalKind`: POSIX-only `{Sigint, Sigterm, Sighup, Sigkill}` (gated by `cfg(unix)` + runtime platform check). `JobTerminate` and `CtrlBreakEvent` are `unreachable!()` on emit paths in Phase 1; Phase 2 Windows adapter populates them.
  - `ErrorCode`: Phase 1 emit set = `{UnknownSession, BadFrame, UnsupportedVersion, PermissionDenied, SpawnFailed (manifest collision), ShuttingDown, UnknownKind, UnkillableChild, ManifestWriteFail, DuplicateOp (idempotency only)}`. Cross-machine codes (`NotReachable`, `ParentGone`, `SupervisorGone`, `EscapedDescendant`, `PgrpLiveAfterKill`) are wire schema only — `unreachable!()` on emit in Phase 1.

**Behavior**:
- Receiver MUST fail-closed on `signal` values **outside the full 6-variant enum**: emit `kind:"error" code:"ERR_BAD_FRAME"` (V1 ADR §6.2.1 closing rule).
- Receiver MUST emit `code:"ERR_UNKNOWN_KIND"` for unknown `kind`, not crash (V1 ADR §6.4 graceful degrade).
- `trace_id`: base `Frame.trace_id` is `Option<String>` (forward-compat for `ping`/`pong`), but **per-kind validators enforce `trace_id` REQUIRED for `kind ∈ {inject, output}`** (V1 ADR §6.1 B3). Contract test: an `inject` frame missing `trace_id` MUST return `ERR_BAD_FRAME`. Supervisor mints UUID v7 only for unsolicited `output` (PTY emissions with no triggering inject) — incoming `inject` without `trace_id` is rejected, not auto-minted.
- Schema version: receiver MUST emit `ERR_UNSUPPORTED_VERSION` for any `v != 1` (V1 ADR §6.4). Contract test: `v: 2` frame is rejected with that exact code.
- Wire encoding = one frame per line, UTF-8, terminated by `\n`. No prettyprint, no embedded newlines in `data` (must be JSON-escaped).

**Golden fixtures (M3 deliverable per F7)**:
- `tests/wire/v1-envelope.ndjson.golden` — covers every `Kind` variant.
- `tests/wire/v1-signal-enum.ndjson.golden` — every `SignalKind` variant (all 6) round-trips.
- `tests/wire/v1-error-enum.ndjson.golden` — every `ErrorCode` variant (all 15) round-trips.
- `tests/wire/v1-exit-reason.ndjson.golden` — every `ExitReason` variant (all 5) round-trips.

Snapshot review via `insta` — adding a wire variant requires updating the golden file, which the reviewer can spot in the PR diff (mitigates R9 contract drift).

### 3.3 `manifest` — atomic write, schema, tombstone (≤ 200 LOC)

**Responsibility**: read/write `~/.telepty/sessions/<sid>/manifest.json` atomically; enforce V1 ADR §7.3 schema; implement A8 unlink-on-clean and §6.3.2 tombstone.

**Operations**:
```text
write(path: &Path, m: &Manifest) -> Result<()>    // tmp + fsync(tmp) + rename + fsync(parent_dir) (F4 r2)
unlink_clean(path: &Path) -> Result<()>           // for exit_reason ∈ {normal, signaled, killed}; A8 rule; fsync(parent_dir) after unlink
write_tombstone(path: &Path, exit_reason: ExitReason, audit: TombstoneFields) -> Result<()>    // exit_reason ∈ {crashed, unkillable}
read(path: &Path) -> Result<Manifest>             // validation: schema_version, id matches dirname, ipc.kind ∈ {uds, named_pipe}, status ∈ enum
```

**Schema fields (Phase 1 minimum)**:
- `schema_version: u32` (= 1)
- `id: String` (matches dir basename)
- `pid: u32`
- `ipc: { kind: "uds", path: String }`
- `status: "spawning" | "ready" | "draining" | "stopped" | "error"`
- `restart_count: u32` (= 0 for first spawn)
- `created_at: String` (RFC 3339)
- Tombstone-only: `exit_reason`, `crashed_at` or `unkillable_at`

**Atomicity (F4 r2)**: write to `manifest.json.tmp`, `fsync(tmp_fd)`, `rename` to `manifest.json`, then `fsync(parent_dir_fd)` — the trailing parent-dir `fsync` ensures the rename itself is durable on POSIX (without it, the directory entry may not survive crash even though file contents are stable). Linux + macOS both honor `fsync` on directory descriptors. On error → `code:"ERR_MANIFEST_WRITE_FAIL"` (V1 ADR §6.4 A2 / SPEC-C3-r1 §7.F). No leftover `.tmp` files after process exit, even on crash mid-write (verified by §8.A6 fuzz scenario — see §5).

**Audit detail (`exit_signal`, `exit_code`, `escalated`)** lives in `log.jsonl`, **not** in the manifest (V1 ADR §7.3 A3 last bullet).

### 3.4 `ipc` — UDS POSIX, Named Pipe Windows-stub (≤ 200 LOC)

**Responsibility**: per-session IPC server. POSIX = `UnixListener` at `manifest.ipc.path`; Windows = `unimplemented!()` behind `windows-stub` feature.

**Path discipline**:
- POSIX socket lives at `~/.telepty/sessions/<sid>/supervisor.sock` (manifest declares the absolute path).
- Permissions: `0700` on the parent dir, `0600` on the socket (V1 ADR M22 file-permission semantics).
- On supervisor startup: `unlink()` any stale socket at the path (ignore ENOENT). Listener bound after manifest atomic write.
- On clean exit: `unlink()` socket explicitly (SPEC-C3-r1 §1.1 step 6).

**Connection lifecycle**:
- One listener, accept loop; each connection = one `tokio::spawn` task reading NDJSON frames line by line (`tokio::io::BufReader::read_line`).
- Per-connection frame budget: drop the connection on first parse error after emitting `ERR_BAD_FRAME` response.
- No authentication in Phase 1; permissions are sufficient (V1 ADR §3.7).

**Linearization queue invariant (F5, SPEC-C3-r1 §7.G; r2)**:
- All inbound frames from every connection funnel through a single `tokio::sync::mpsc::channel` ("ingest queue") consumed by **one** supervisor task. Per-connection tasks parse → enqueue; the consumer dispatches to PTY/kill_gate/manifest.
- Sketch:
  ```text
  // module-level singleton, owned by supervisor::run
  let (tx, mut rx) = tokio::sync::mpsc::channel::<(ConnId, Frame)>(IPC_QUEUE_DEPTH);

  // per-connection task (one per accepted UDS connection)
  while let Some(line) = lines.next().await { let f = parse(line)?; tx.send((conn_id, f)).await?; }

  // single supervisor consumer task
  while let Some((conn_id, frame)) = rx.recv().await { dispatch(conn_id, frame).await; }
  ```
- FIFO is **per-stream** (preserved by `read_line` ordering). **Global ordering across streams** is established by the queue, not by `current_thread` tokio alone — the codex review correctly notes that per-connection `tokio::spawn` does NOT serialize cross-stream events even on a single-thread runtime (tasks interleave at `.await` points).
- `IPC_QUEUE_DEPTH` = 256 (Phase 1 default; revisited in Phase 4 measurement). Bounded channel: if the queue saturates, producer back-pressures the connection — clients see slower acks rather than lost frames. Saturation event logged as `kind:"warn"` (no dedicated error code in Phase 1).
- Idempotency (`ERR_DUPLICATE_OP`) is enforced by the **consumer** task using a small LRU keyed on `op_id`/`idempotency_key` (Phase 1: only used in §8.A-idempotency test scenario; full replay-suppression semantics = Phase 2).

### 3.5 `kill_gate` — SPEC-C3-r1 §1–§5 state machine (≤ 350 LOC, the heaviest module)

**Responsibility**: implement §1.1–§1.3 lifecycle stages and §5 PTY-kill ordering.

**State machine**:
```text
ReadyState ──signal(SIGTERM) or delete{force:false}──▶ Draining
Draining ──drain in-flight + kill(-pgid, SIGTERM)──▶ wait child up to graceful_grace_ms
                                                      ├─ reaped → Stopped (exit_reason ∈ {normal, signaled})
                                                      └─ timeout → Forced
ReadyState ──delete{force:true}──▶ Forced
Forced ──kill(-pgid, SIGKILL)──▶ wait child up to child_reap_timeout_ms
                                  ├─ reaped → Stopped (exit_reason = killed)
                                  └─ timeout → Unkillable (tombstone)
```

**Concrete primitives** (POSIX):
- Graceful: `nix::sys::signal::killpg(Pid::from_raw(pgid), Signal::SIGTERM)`. **Not** `portable_pty::ChildKiller::kill` (SPEC-C3-r1 §5.1 explicit warning: it sends SIGHUP and is pid-targeted, not pgrp-targeted).
- Forced: `nix::sys::signal::killpg(Pid::from_raw(pgid), Signal::SIGKILL)`.
- Reap loop: `spawn_blocking` + `Child::try_wait()` polling at `reap_poll_ms` cadence (default 100 ms) until `child_reap_timeout_ms` deadline (SPEC-C3-r1 §4.1.1).
- Pgrp existence test: `libc::killpg(pgid, 0)` returns `ESRCH` when empty (SPEC-C3-r1 §4.1.2).

**PTY teardown ordering (POSIX Order A, SPEC-C3-r1 §5.1)**:
1. Signal child (`killpg(-pgid, SIGTERM|SIGKILL)`).
2. `Child::try_wait()` reap loop on `spawn_blocking`.
3. Drain remaining PTY master bytes up to `pty_read_drain_deadline_ms` (default 500 ms).
4. `drop(pty.master)` → kernel closes master FD.
5. Emit `kind:"shutdown_drain"` to `log.jsonl` with `exit_reason`, `exit_signal`, `exit_code`, `escalated`, `in_flight`, `completed`.
6. `manifest::unlink_clean()` or `manifest::write_tombstone()` per A8.

**Timeout defaults (SPEC-C3-r1 §2.1)**: hard-coded constants in `kill_gate.rs` for Phase 1; per-session override via manifest field `kill_gate.graceful_grace_ms` is a stretch goal. Defaults:
```text
GRACEFUL_GRACE_MS = 3000
CHILD_REAP_TIMEOUT_MS = 2000
REAP_POLL_MS = 100   // bounded as child_reap_timeout_ms / 20, floor 100
PTY_READ_DRAIN_DEADLINE_MS = 500
ORPHAN_DETECT_INTERVAL_MS = 5000   // Phase 1 may stub; A.4 orphan handling is partial
PARENT_DEATH_GRACE_MS = 15000      // Phase 1 may stub
MANIFEST_SYNC_INTERVAL_MS = 1000
```

**§1.4 parent-death (A.4) — explicit Phase 1 C3 exception (Q-B r2)**: minimum viable in Phase 1 = supervisor does NOT self-terminate when orchestrator disappears (V1 ADR Q'''-bis policy). Detection logic (heartbeat / EOF / `prctl(PR_SET_PDEATHSIG)`) is stubbed; `ERR_PARENT_GONE` emission and the §8.A4 always-on test scenario are **declared exceptions to SPEC-C3-r1 §8.A coverage** for Phase 1, recorded in §5.1 (deferred-with-exception table) and §9 (acceptance gate). Phase 1 supervisor keeps running per Article 9 self-evidence; Phase 2 wires the full handler. **Phase 1 acceptance is POSIX-only and parent-death-light.**

**§1.5 crash recovery (A.5)**: Phase 1 supervisor side = tombstone write happens (if process survives long enough to write). Orchestrator-side respawn is explicitly Phase 2 (out of scope per §1.2).

### 3.6 `boot` — claude/codex/gemini wrapper integration (≤ 100 LOC)

**Responsibility**: translate the high-level "wrap a CLI like `claude`/`codex`/`gemini`" UX into a `SupervisorConfig`. The dispatch references "V1 ADR §4.5.1 boot adapter" but cross-LLM extraction (see §8 open Qs) found **no §4.5.1 heading exists** in the V1 ADR — the closest binding is V1 ADR §2.1 boundary ("telepty owns transport/runtime, devkit owns disk-side content/per-CLI integration").

**Phase 1 interpretation**: keep `boot` minimal — it only resolves argv from a profile name (e.g., `--profile claude` → `argv = ["claude", "--resume"]`) and sets env vars. No prompt-symbol detection, no submit-gate (those live in 0.3.5 Node `src/submit-gate.js`, retained for the 0.3.x process during coexistence per §6). **If §6 cutover requires submit-gate parity in Rust, that is Phase 2 work** — log as open question Q3.

**Public surface**:
```text
fn resolve_profile(name: &str, extra_args: &[String]) -> Result<(Vec<String>, HashMap<String, String>)>
// Returns (argv, env). Supported names in Phase 1: "claude", "codex", "gemini", "shell" (raw passthrough).
```

Profile table is a hard-coded `phf` map or plain `match` — no config file, no plugin (Article 17 무의존).

---

## 4. Milestones

Five milestones (M1–M5) bounded to **≤ 2 weeks total** at sustained pace; longer is acceptable but each milestone must end with a passing demo before the next starts. Windows ConPTY is a sixth track explicitly deferred (§4.6).

### 4.1 M1: spawn + observe (1–2 days)

**Goal**: `cargo run -p telepty-supervisor-bin -- --sid demo --cwd /tmp -- echo hello` spawns the child via `portable-pty`, reads PTY output, logs `"hello\n"` to stdout, child exits, supervisor exits 0.

**Demo command**:
```bash
cargo run -p telepty-supervisor-bin -- --sid demo --cwd /tmp -- echo "hello from M1"
# expected stdout: hello from M1
```

**Deliverables**:
- `supervisor::run` happy-path on POSIX (macOS + Linux).
- `wire::Frame` types compile and round-trip via `serde_json` unit tests.
- Tracing initialized; minimal `log.jsonl` writes (start, stop).
- `manifest::write` writes the file but **no atomic rename yet** (will tighten in M3).

**Skip in M1**: IPC server, kill gate, atomic manifest, jemalloc env tuning (use defaults first), `boot` profiles (raw argv only).

### 4.2 M2: graceful + forced kill — split into M2-core and M2-faults (F6 r2)

#### 4.2.A M2-core: §1.2/§1.3 happy-path on POSIX (2–3 days)

**Goal**: SPEC-C3-r1 §1.2 graceful and §1.3 forced kill state machines work on POSIX **for the well-behaved-child path**. `kill_gate` module complete enough to pass §8.A1/A2/A2-escalate/A3/A3-tree always-on tests on macOS + Linux.

**Demo command**:
```bash
# Terminal 1: long-running child that ignores SIGTERM
cargo run -p telepty-supervisor-bin -- --sid sig-test --cwd /tmp -- bash -c 'trap "" TERM; sleep 60' &

# Terminal 2: forced kill via in-process IPC (M2 uses a CLI hand-built signal, not yet wire-driven)
kill -TERM <supervisor_pid>   # supervisor escalates to SIGKILL after 3000ms
# expected: child gone within 4000ms; log.jsonl shows exit_reason="killed", escalated=true
```

**Deliverables**:
- `kill_gate::handle_signal()` implements §1.2/§1.3 fully on POSIX.
- `setsid()`-confirmed pgrp targeting; `nix::killpg` calls.
- `Child::try_wait` reap loop on `spawn_blocking` per §4.1.1.
- §5.1 Order A PTY teardown (signal → reap → drain → close).
- `log.jsonl` `shutdown_drain` events with all audit fields.
- A8 unlink for clean exits.

#### 4.2.B M2-faults: tombstone + unkillable demo (1–2 days, can land in parallel with M3)

**Goal**: tombstone write path validated via fault-injected unkillable child. Separable from M2-core because the unkillable path exercises §6.3.2/§6.3.3 manifest semantics and `ERR_UNKILLABLE_CHILD` emission, not the happy-path state machine.

**Deliverables**:
- Fault-injection child harness: a test fixture that NEVER reaps (simulates D-state without requiring NFS). Implementation hint: spawn a child that becomes a zombie deliberately by `pause()`-ing after `fork`, then deny the supervisor reap by intercepting via test-only `MockChild` impl behind a `#[cfg(test)]` trait.
- §6.3.2 tombstone manifest written with `exit_reason: "unkillable"`, audit detail in `log.jsonl`.
- `ERR_UNKILLABLE_CHILD` emitted on the wire to listeners before tombstone.
- §8.A6 manifest atomic-write fuzz (crash mid-write) passes.

#### 4.2.C M2 Q2 flush-time measurement micro-task (½–1 day, Q-E r2)

**Goal**: validate or revise the `graceful_grace_ms = 3000` hard-coded default per SPEC-C3-r1 §2.1 marked "**PROPOSED, to be measured in Phase 1**".

**Procedure**:
1. Spawn supervisor wrapping `claude` (then `codex`, then `gemini`) on 5 sample tasks each (e.g., 1-line echo, multi-line shell pipeline, single API call, file write, multi-line code generation).
2. After child issues last meaningful output, send SIGTERM; record wall-clock delta from SIGTERM to `read()` returning EOF on PTY master (= last flush).
3. Tally per-CLI p50 and p99 across the 5 samples.

**Acceptance rule for the default**:
- If max p99 across the 3 CLIs < 3000 ms → keep default; mark Q2 resolved.
- If any p99 ≥ 3000 ms → file follow-up task to either raise the default or expose per-CLI override (deferred to Phase 2 if config plumbing is not yet in place).

Result recorded in `docs/reports/2026-05-NN-phase1-q2-flush-measurement.md`. **Full per-CLI override / per-session configurability is Phase 4 task per Q-E hybrid** — Phase 1 only needs the hypothesis-confirm step.

**Skip across M2 sub-milestones**: IPC-wire-driven kill (M3 wires it); orphan detection (Phase 2 per §1.4 exception).

### 4.3 M3: contract-conformance — full wire enum + IPC linearization queue + golden fixtures (3–4 days, F7 r2)

**M3 is the contract-conformance milestone.** Everything that must conform exactly to the V1 ADR A1/A2 schema and SPEC-C3-r1 §7.G linearization lands here. Riskiest single milestone per codex review — keep scope tight, do not slip features.

**Goal**: external orchestrator (or test harness) connects to UDS, sends `inject` frame, supervisor writes to PTY master; receives `output` frames back. Manifest is atomically written and observable in `telepty list`-equivalent. Full A1/A2 enum schema serializes/deserializes; ingest queue serializes cross-stream events.

**Demo command**:
```bash
# Spawn
cargo run -p telepty-supervisor-bin -- --sid m3 --cwd /tmp -- bash -i &

# Connect with nc + send inject frame (trace_id REQUIRED for inject per B3)
echo '{"v":1,"sid":"m3","kind":"inject","trace_id":"01HMW0...","data":"echo hi\n"}' | nc -U ~/.telepty/sessions/m3/supervisor.sock
# expected: output frame with data="echo hi\n" and trace_id propagated; downstream "hi\n"; manifest.json shows status="ready"
```

**Deliverables**:
- `manifest::write_status` uses `tmp + fsync(tmp) + rename + fsync(dir)` (atomic + durable per F4; G6 acceptance).
- `ipc::serve` accepts UDS connections, parses NDJSON, dispatches by `kind`.
- **Full A1 `SignalKind` + A2 `ErrorCode` enum** declared in `wire.rs` (15-variant `ErrorCode`, 6-variant `SignalKind`) with serde round-trip tests.
- **Per-kind validators**: `inject`/`output` frames missing `trace_id` rejected with `ERR_BAD_FRAME` (B3 enforcement).
- **`v != 1` rejection** with `ERR_UNSUPPORTED_VERSION`.
- **IPC linearization queue (F5)**: per-connection task → `mpsc::channel` → single consumer; global FIFO across streams.
- **Idempotency**: `ERR_DUPLICATE_OP` emitted for repeated `op_id`/`idempotency_key` within Phase 1 LRU window (used in §8.A-idempotency).
- **Golden fixtures land**: `tests/wire/v1-envelope.ndjson.golden`, `v1-signal-enum.ndjson.golden`, `v1-error-enum.ndjson.golden`, `v1-exit-reason.ndjson.golden` per §3.2.
- `inject` → PTY master write; `output` → broadcast to all connected listeners with trace_id propagated.
- `signal {SIGTERM|SIGKILL}` frame triggers kill gate (replaces M2's hand-rolled signal).
- `delete {force: bool}` → drives §1.2 or §1.3.
- `ping`/`pong` round-trip.
- `ERR_*` codes (Phase 1 emit set): all 10 codes reachable per G5.

**Skip in M3**: cdylib C ABI smoke test (Q4: Phase 2 default); cross-machine A2 codes (Phase 2 semantics).

### 4.4 M4: cross-OS POSIX parity (2 days)

**Goal**: M1–M3 demos pass on **both** macOS arm64 and Linux x86_64 CI. RSS measurement gate G9 satisfied.

**CI matrix** (`.github/workflows/rust-supervisor.yml`):
- `macos-latest` (arm64): build + test.
- `ubuntu-latest` (x86_64): build + test.
- `windows-latest`: build only (`--features windows-stub`). Tests skipped; CI passes if build succeeds.

**Caching**: `Swatinem/rust-cache@v2` (cargo registry + git deps + target/) + `mozilla-actions/sccache-action` (compiler artifact cache). Target: warm build < 90 s per matrix entry, cold < 8 min (G10).

**Deliverables**:
- Green CI on macOS + Linux for §8.A always-on bucket.
- RSS measurement script `scripts/measure-rss.sh` — **reproducible methodology (F8 r2; Q-E hybrid)**:
  ```bash
  #!/usr/bin/env bash
  set -euo pipefail

  # Per-run isolation namespace
  RUN_ID="$(uuidgen | tr -d '-' | head -c 16)"
  RUN_DIR="/tmp/p1-rss-${RUN_ID}"
  mkdir -p "${RUN_DIR}"
  TELEPTY_SESSIONS_DIR="${RUN_DIR}/sessions"

  # Track exact PIDs we spawn (no pgrep heuristics)
  PIDS=()
  cleanup() {
    for pid in "${PIDS[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
    sleep 1
    for pid in "${PIDS[@]}"; do kill -KILL "$pid" 2>/dev/null || true; done
    rm -rf "${RUN_DIR}"
  }
  trap cleanup EXIT INT TERM

  # Spawn N=10 supervisors with exact child command (sleep 600, not bash -i)
  N=${N:-10}
  for i in $(seq 1 "$N"); do
    TELEPTY_SESSIONS_DIR="${TELEPTY_SESSIONS_DIR}" \
      ./target/release/telepty-supervisor-bin --sid "rss-${RUN_ID}-${i}" --cwd /tmp -- sleep 600 &
    PIDS+=($!)
  done

  # Warmup window: 5s for tokio + jemalloc steady state
  sleep 5

  # Sample exact PIDs only
  echo "pid,rss_kb,vsz_kb"
  for pid in "${PIDS[@]}"; do
    ps -o pid=,rss=,vsz= -p "$pid" | awk '{print $1","$2","$3}'
  done

  # Linux: also capture /proc/<pid>/status VmRSS for second-source confirmation
  if [[ "$(uname)" == "Linux" ]]; then
    for pid in "${PIDS[@]}"; do
      awk -v p="$pid" '/^VmRSS:/ {print p","$2"_kB_proc"}' "/proc/${pid}/status"
    done
  fi
  ```
  Methodology choices:
  - **Exact child command**: `sleep 600` (deterministic; not `bash -i` which loads rcfiles → variable RSS).
  - **PID tracking**: shell-array of spawned PIDs (no `pgrep -f telepty-supervisor-bin` which can include unrelated stale processes per codex L33).
  - **Cleanup trap**: kills supervisors + removes session dir on script exit, even on Ctrl-C.
  - **Per-run namespace**: `/tmp/p1-rss-<ulid>/` keeps reruns isolated.
  - **Authoritative metric**: `ps -o rss=` (POSIX-uniform). On Linux only, `/proc/<pid>/status VmRSS` is captured as a second source. **PSS via smaps is explicitly deferred to Phase 4** measurement gates (full methodology spec lives there per Q-E hybrid).
- Recorded RSS table in `docs/reports/2026-05-NN-phase1-rss.md` showing **each supervisor process ≤ 15 MB RSS** (G9; phrasing tightened per codex L50).
- jemalloc `MALLOC_CONF` threaded through process env before allocator init (see §7 R3 init-order risk).

**Skip in M4**: Windows functional tests; cdylib host-loader smoke (Q4 → Phase 2).

### 4.5 M5: manual integration test — bridge-phase1.js standalone (Q-C + F9 r2)

**Goal**: validate wire-level parity between Phase 1 Rust supervisor and 0.3.5 Node daemon for a single session, **without modifying any existing Node files**. This is a manual integration test, not a production routing path.

**Scope discipline (Q-C r2)**: M5 produces **one new file** and modifies **zero existing files**. The rollback claim "`daemon.js` / `cli.js` / `tui.js` untouched" is preserved. Real `daemon.js` routing logic is **Phase 2** work (dispatched separately).

**Concrete write scope (F9 r2)**:

| File | Action | Purpose |
|---|---|---|
| `scripts/bridge-phase1.js` | **CREATE** (≤ ~150 LOC Node, excluded from Rust LOC budget per Q-D) | Standalone Node script. Spawns one rust supervisor via `child_process.spawn('./target/release/telepty-supervisor-bin', ...)`. Connects to its UDS. Reads NDJSON. Pretty-prints. Accepts inject lines from stdin. |
| `cli.js` | **NO CHANGE** | Existing 0.3.x CLI is unaware of Rust supervisor. |
| `daemon.js` | **NO CHANGE** | No backend tag, no routing fork, no bridge calls. |
| `tui.js` | **NO CHANGE** | TUI does not see Rust sessions. |

**Manual integration procedure (orchestrator runs both backends in parallel)**:
1. Operator starts the existing 0.3.5 daemon: `node daemon.js &` (unchanged from current behavior).
2. Operator allows a session via the Node path: `telepty allow --id m5-node claude` (uses existing routing).
3. Operator runs the bridge as a separate process: `node scripts/bridge-phase1.js --sid m5-rust --cwd /tmp -- claude` (spawns Rust supervisor wrapping `claude`).
4. Operator injects the **same prompt** to both sessions via two CLI invocations:
   - `telepty inject --from orch m5-node "hello"` (goes through node daemon → PTY → claude).
   - `node scripts/bridge-phase1.js --inject m5-rust "hello"` (goes through Rust UDS → PTY → claude).
5. Wire-level parity is asserted by capturing NDJSON output frames from each side and `diff`-ing them (modulo timestamps and trace_ids). The two sessions should produce equivalent `output` frame sequences.

**Demo command (M5 acceptance)**:
```bash
# In one shell:
node daemon.js &
telepty allow --id m5-node claude
telepty inject --from orch m5-node "echo hi"

# In another shell:
node scripts/bridge-phase1.js --sid m5-rust --cwd /tmp -- claude &
node scripts/bridge-phase1.js --inject m5-rust "echo hi"

# Compare last 20 output frames from both → wire-level diff
diff <(jq -c '. | del(.ts,.trace_id)' < ~/.telepty/sessions/m5-node/log.jsonl | tail -20) \
     <(jq -c '. | del(.ts,.trace_id)' < ~/.telepty/sessions/m5-rust/log.jsonl | tail -20)
# expected: empty diff (or only `kind:"output"` data ordering tolerated)
```

**Deliverables**:
- `scripts/bridge-phase1.js` standalone (read by tests, not by daemon.js).
- `docs/reports/2026-05-NN-phase1-m5-parity.md` showing recorded wire diff over 3 sample CLI workflows.

**Skip in M5**: full cutover, prompt-symbol rendering, submit-gate parity, TUI integration, **daemon.js modifications of any kind**.

### 4.6 Windows ConPTY — explicit Phase 2 deferral

Per SPEC-C3-r1 §0.3, stock `portable-pty 0.9.0` does NOT expose Job Object handle, ConPTY HPCON, `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`, or console process-group id. Phase 1 ships:

- `cfg(target_os = "windows")` + `feature = "windows-stub"` paths that compile.
- `supervisor::run()` on Windows returns `Err(WindowsNotImplemented)` immediately with `ERR_UNSUPPORTED_VERSION`-equivalent wire response.
- CI on `windows-latest` only checks **build success**, not functional behavior.

Phase 2 work (separate plan): fork/extend `portable-pty` to expose the 6-item surface from SPEC-C3-r1 §3.2.1; implement `TerminateJobObject` + `GenerateConsoleCtrlEvent` + ConPTY drain-then-close ordering (§5.2); add `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` cascade on supervisor crash (§8.A.W-jobrace).

---

## 5. Test strategy

Three buckets per SPEC-C3-r1 §8 (organizationally critical — keeps PR latency bounded).

### 5.1 Bucket §8.A — always-on PR CI tests (BLOCKING)

These run on every PR touching kill-gate code (M25 contract test). Pure userland, deterministic, bounded timing. The Phase 1 spike commits to **10 scenarios** out of the §8.A catalog (2 added in r2 per Binding 2 codex review):

| Test | What it asserts | OS coverage in Phase 1 |
|---|---|---|
| §8.A1 normal termination | Child exits 0; manifest unlinked (A8); `log.jsonl` `exit_reason="normal"`. < 2000 ms. | macOS + Linux |
| §8.A2 graceful shutdown | `delete{force:false}` → child handler runs → exit_reason="signaled", escalated=false. < 2000 ms. | macOS + Linux |
| §8.A2-escalate graceful escalates to forced | Child ignores SIGTERM → escalation → exit_reason="killed", escalated=true. ∈ [3000, 4000] ms. | macOS + Linux |
| §8.A3 forced kill | `delete{force:true}` on `sleep 60` → exit_reason="killed", escalated=false. < 1500 ms. | macOS + Linux |
| §8.A3-tree cascades to grandchildren | Child spawns 2 sub-processes; force-kill leaves `killpg(pgid, 0) == ESRCH`. < 2000 ms. | macOS + Linux |
| §8.A-reactor-stall | Kill gate completes while parallel ping/pong proceeds. < 1500 ms. | macOS + Linux |
| §8.A-idempotency | 5 concurrent `delete{force:true}` all return success (one `ERR_DUPLICATE_OP` per replay if `op_id` repeats); supervisor exits once. < 2500 ms. | macOS + Linux |
| §8.A6 manifest atomic-write fuzz | Crash supervisor between `tmp` write and `rename`; reader sees either pre-state or post-state, never `.tmp` leftover. | macOS + Linux |
| **§8.A-trace-id propagation (NEW in r2 per Binding 2)** | `inject` frame with `trace_id=T1` → resulting `output` frames all carry `trace_id=T1`; the `shutdown_drain` log entry carries `trace_id=T1` for the kill that completed the session. `inject` with missing `trace_id` is rejected with `ERR_BAD_FRAME`. | macOS + Linux |
| **§8.A-schema-version enforcement (NEW in r2 per Binding 2)** | Frame with `v: 2` (any kind) is rejected with `ERR_UNSUPPORTED_VERSION`. Frame with malformed `v` (string, missing) → `ERR_BAD_FRAME`. | macOS + Linux |

**Phase 1 C3 §8.A exceptions (declared per Q-B r2, recorded in §9 acceptance gate)**:

The Phase 1 spike does NOT claim full SPEC-C3-r1 §8.A coverage. The following always-on scenarios from the C3 spec are **explicitly deferred** with declared acceptance impact:

| Deferred scenario | Reason | Where deferred to |
|---|---|---|
| **§8.A4 parent-death detection** | Phase 1 supervisor stays alive on orchestrator disappearance per V1 ADR Q'''-bis policy (§3.5 + §1.4 note). Full orphan-handler with `ERR_PARENT_GONE` + heartbeat logic = Phase 2. | Phase 2 |
| **§8.A-windows-no-sigint** + all Windows §8.A scenarios | Stock `portable-pty 0.9.0` insufficient on Windows (§4.6); custom ConPTY adapter required per SPEC-C3-r1 §0.3. Phase 1 ships compile-only Windows stub. | Phase 2 W2 (Windows adapter track) |
| §8.A.W-jobrace Windows crash-before-attach | Same — Windows-only, needs Phase 2 adapter. | Phase 2 W2 |

**Phase 1 acceptance is therefore "C3 §8.A bucket covered modulo the 2 categories above" (POSIX-only and parent-death-light).** This is recorded as a binding caveat in §9.

**Test layout**:
```text
crates/telepty-supervisor-core/tests/
├── kill_gate_normal.rs        // §8.A1
├── kill_gate_graceful.rs      // §8.A2 + escalate
├── kill_gate_forced.rs        // §8.A3 + tree
├── reactor_stall.rs           // §8.A-reactor-stall
├── idempotency.rs             // §8.A-idempotency
├── manifest_atomic_fuzz.rs    // §8.A6
├── trace_id_propagation.rs    // §8.A-trace-id (NEW r2)
└── schema_version.rs          // §8.A-schema-version (NEW r2)
```

Each test spawns a real supervisor via `tokio::process::Command`, drives it through UDS NDJSON, asserts on `log.jsonl` + filesystem state. **No mocks** for kill semantics (the whole point is OS-level behavior; mocked tests would not validate the architecture per §5 of `/Users/duckyoungkim/projects/CLAUDE.md` analog). The `MockChild` referenced in §4.2.B M2-faults (L379) is used **only** for tombstone-path + fault-injection unit coverage; **OS kill semantics (SIGTERM / SIGKILL / CTRL_BREAK_EVENT) are tested against real supervisor processes; no mocking of kill primitives**.

### 5.2 Bucket §8.B — controlled-host integration (NIGHTLY, NOT BLOCKING)

Requires launchd / systemd-user / Windows Service registration. Phase 1 lists these but **does not implement them** — they remain as nightly jobs once Phase 2 produces the service-unit scaffolding:

| Test | Deferred reason |
|---|---|
| §8.B1 orchestrator-driven respawn | Requires `restart_policy` orchestrator-side; that lives in `aigentry-orchestrator`. |
| §8.B2 manual restart policy | Same. |
| §8.B3 timeout override (per-session) | Requires manifest config field implementation (stretch, Phase 1 hard-codes defaults). |

### 5.3 Bucket §8.C — destructive/manual (PHASE 4)

Phase 4 measurement gates own these. Listed for completeness:

| Test | Deferral target |
|---|---|
| §8.C1 D-state unkillable child (NFS hang) | Phase 4 manual; tombstone write path validated in §8.A6 by fault injection. |
| §8.C2 Windows IRP-stuck unkillable | Phase 4 manual, Windows-only, depends on Phase 2 ConPTY adapter. |
| §8.C3 cross-machine `delete` rejection (K1 latency) | Phase 4 measurement gate per V1 ADR §10. |

### 5.4 Test runners and reporting

- `cargo nextest` (faster, better isolation than `cargo test`). Optional but recommended.
- Test artifacts (`log.jsonl`, manifest snapshots) uploaded via `actions/upload-artifact@v4` on failure for post-mortem.
- One snapshot fixture: `tests/wire/v1-envelope.ndjson.golden` for G3 (NDJSON conformance). Use `insta` for inline snapshot review.

---

## 6. Migration / coexistence with 0.3.5 Node telepty

### 6.1 Coexistence plan during Phase 1 development

The Phase 1 supervisor is a **sidecar**, not a replacement. The 0.3.5 Node stack (`daemon.js` on port 3848, `cli.js`, `tui.js`, `src/`) continues unchanged. **No `daemon.js` / `cli.js` / `tui.js` edits in Phase 1 (Q-C r2)**. Concretely:

- **`telepty allow --id <name> claude` continues to route through the 0.3.5 Node daemon** unchanged. No backend tag, no routing fork, no `--backend=rust-supervisor` flag — the existing CLI is unaware of the Rust supervisor in Phase 1.
- **Rust supervisor is invoked separately** via the standalone `scripts/bridge-phase1.js` helper (see §4.5 M5). That script spawns `telepty-supervisor-bin` as a child process, connects to its UDS, and exposes a hand-driven inject interface for the manual integration test only.
- Both backends write manifests under `~/.telepty/sessions/<sid>/` — they MUST NOT collide on `<sid>`. Phase 1 supervisor refuses to start if a manifest already exists with `status ∈ {ready, draining, spawning}` and returns **`ERR_SPAWN_FAILED`** (V1 ADR §6.4 A2; spawn-class failure per codex F11 — not `ERR_SHUTTING_DOWN` which is reserved for in-flight rejection during drain).
- Inject path during coexistence: there is no automatic routing. Existing sessions use the existing path; Rust-supervised sessions are reached only through the bridge-phase1.js helper. **Real `daemon.js` routing logic is the first Phase 2 dispatch task.**

### 6.2 Switch criteria for Phase 1 → Phase 2 cutover

Phase 1 → Phase 2 transition (= "real `daemon.js` routing dispatched, Rust supervisor becomes a default-eligible backend for at least one CLI profile") gated on:

| Criterion | Threshold |
|---|---|
| Acceptance gate §9 fully met | All G1–G10 green for ≥ 7 days on `main`. |
| §8.A bucket green on macOS + Linux | Zero kill-gate flakes in last 50 PR runs (covered modulo the 2 declared C3 exceptions). |
| RSS measurement | Each of 10 concurrent supervisors idle RSS ≤ 15 MB sustained over 1h soak test. |
| Cross-LLM review | Plan + impl reviewed by at least one of {codex, gemini} per Article 5; concerns addressed. |
| Manual M5 parity demo recorded | Wire diff captured in `docs/reports/2026-05-NN-phase1-m5-parity.md` for ≥ 3 sample workflows. |

### 6.3 Rollback path

Phase 1 is **revert-safe by construction**: the Rust crates live in `crates/`, the bridge helper (`scripts/bridge-phase1.js`) is opt-in standalone, and `daemon.js` / `cli.js` / `tui.js` are **not modified** (Q-C r2). Rollback = stop invoking the bridge; delete `crates/` and `scripts/bridge-phase1.js`; existing 0.3.5 Node behavior is byte-identical to before Phase 1. No data migration, no manifest format flag-day.

If Phase 1 acceptance fails (e.g., RSS drift, kill-gate flakes that can't be fixed), the documented fallback per V1 ADR §17.5 / C4 §10.1 is **Path A: Node 0.3.x maintained**. The Phase 1 Rust artifacts stay in tree (no value in deleting) but are unbuilt by default until Phase 1 re-spike.

---

## 7. Risks + mitigations

| # | Risk | Likelihood | Mitigation | Cite |
|---|---|---|---|---|
| R1 | `portable-pty 0.9.0` Windows limitation invalidates any "build but don't run" assumption | high (already known) | Phase 1 explicitly scopes Windows to compile-only via `windows-stub` feature. CI on `windows-latest` only checks `cargo build`. Phase 2 owns the adapter fork. | SPEC-C3-r1 §0.3 |
| R2 | jemalloc binding cost balloons RSS above E3 = 15 MB | medium | C2 PoC measured 3.25 MiB / 1 sess and 3.42 MiB / 10 sess sequential — well under ceiling. Phase 1 M4 re-measures with **persistent** 10 supervisors (PoC was sequential), and aggressive `MALLOC_CONF=dirty_decay_ms:0,muzzy_decay_ms:0` is applied at startup. Gate: **each supervisor process RSS ≤ 15 MB** (phrasing tightened r2 per codex L50; not "10 supervisors total ≤ 15 MB"). If exceeded, treat as gate failure and re-spike with lighter alloc strategy. | M31, C2 §5 caveat |
| R3 | `tokio` reactor stall from accidental blocking call (e.g., `std::fs::write` in hot path) **AND** jemalloc init-order race | medium | (a) All `portable_pty::Child` and `manifest::write` calls go through `tokio::task::spawn_blocking`. Lint with `tokio-console` during M4 to confirm zero `Blocked` reactor warnings. (b) **`MALLOC_CONF` init-order (F10 r2)**: setting `MALLOC_CONF` env var from `bin::main()` is **too late** — jemalloc reads the variable during its static-init constructor, which runs before `main`. Phase 1 mitigation: declare `MALLOC_CONF` either via `tikv_jemallocator::Jemalloc` with the compile-time `#[export_name = "_rjem_malloc_conf"]` static-string approach, OR set it in CI/launcher env before process spawn (preferred for the spike — `scripts/bridge-phase1.js` and tests set the env before fork). Document both paths in `bin/main.rs` so downstream users don't repeat the mistake. | M24, M31, C2 PoC §6 |
| R4 | Code volume drifts above 1500 LOC budget (Article 1 경량) | medium | Per-module budget tracked in §3. If any single module exceeds budget, **stop and re-scope** — do not silently expand. Self-review at end of each milestone (§8 workflow). | Article 1 |
| R5 | Cargo cold-build > 10 min on GitHub Actions; PR latency tax | medium | sccache + Swatinem cache (M27). C4 §4 Dim 2 models warm at 90–150 s; spike commits to G10 (warm ≤ 90 s, cold ≤ 8 min). If cold exceeds 8 min, evaluate cargo-chef in Phase 2. | M27, C4 §4 |
| R6 | C2 PoC ran with dummy supervisor (no `portable-pty`) — real PTY behavior may differ | low–medium | M1 explicitly re-validates: spawn a real CLI (`claude --help`), measure idle RSS, confirm no Tokio nesting panic. C2 §8 caveats this directly. | C2 §8 |
| R7 | Single-thread reactor + spawn_blocking creates thread-pool exhaustion under 10+ supervisors | low | Each supervisor owns its own reactor (M24). Phase 1 RSS measurement at G9 captures 10-process workload. If thread count per supervisor > 8, investigate. | M24 |
| R8 | `signal_kind` / `error_code` / `exit_reason` enum drift between Phase 1 impl and V1 ADR amendments | low | Enums defined ONCE in `wire.rs`. **Full A1/A2/A3 enum schema** (not just emission subset) is fixed by golden fixtures in `tests/wire/*.golden`. Any new variant requires updating golden file → code review touchpoint. | V1 ADR §6.2.1 A1 / §6.4 A2 / §7.3 A3 |
| R9 | **Contract test passes locally while A1/A2 enum drifts (F12 r2)** | low | Per codex L52 review: a Phase 1 contract test that only exercises emitted variants can pass while V1 ADR amendments add variants the supervisor doesn't know about — silent schema divergence. Mitigation: golden fixtures (`tests/wire/v1-signal-enum.ndjson.golden`, `v1-error-enum.ndjson.golden`) cover **every enum variant** for serialization round-trip, not just emission paths. CI fails if any A1/A2/A3 variant fails to round-trip. Reviewers who add an A4 amendment MUST update the goldens — caught at PR review. | V1 ADR §6.2.1 / §6.4 / §7.3; codex L52 |
| R10 | Bridge-phase1.js or manual M5 procedure becomes "the real integration path" by inertia | medium | M5 is **manual + standalone** (Q-C r2). No `daemon.js` reference to `bridge-phase1.js`. Phase 2 dispatch task for real routing is a separate scope; until then, the bridge helper is documented as test scaffolding only. If a user runs production traffic through it, they're outside the supported path. | Q-C r2 |

---

## 8. Open questions for orchestrator

Each Q is tagged with binding classification per F13 r2 (codex L54–61). `binding-pre-X` = must resolve before milestone X dispatches; `informational` = does not block any milestone, recorded for context.

**Q1. "V1 ADR §4.5.1 boot adapter" reference in dispatch — section not found.** [**informational pre-M1; binding-pre-M5**] The dispatch task list mentions `§4.5.1 boot adapter (claude/codex/gemini wrapping)` but the V1 ADR (status r5+amend-A1A3+r6) has no §4.5.1 heading per cross-LLM extraction. The closest binding is §2.1 boundary (telepty owns transport/runtime; devkit owns per-CLI integration). M1–M3 use raw argv only, so informational at that stage. M5 manual integration test wraps `claude`/`codex`/`gemini` profile — binding-required at M5 dispatch. **Resolution needed**: (a) is there an amendment we missed? (b) should Phase 1 `boot` module be minimal-profile-table only (§3.6 current proposal)? (c) or should boot adapter be deferred entirely to devkit?

**Q2. SPEC-C3-r1 §2.1 `graceful_grace_ms = 3000` default — measure or trust?** [**binding-pre-M2 acceptance** per Q-E r2] The spec marks 3000 ms as "**PROPOSED**, to be measured in Phase 1 sidecar spike". r2 adopts approach (a): §4.2.C M2 measurement micro-task (1 day) measures p50/p99 across claude/codex/gemini × 5 sample tasks and confirms or revises the default. Full per-CLI override / per-session configurability is **Phase 4** task (Q-E hybrid). **Resolution status**: addressed by §4.2.C; orchestrator confirmation only needed if measurement reveals p99 ≥ 3000 ms.

**Q3. Submit-gate parity for the manual M5 integration test.** [**binding-pre-M5** if M5 uses real AI CLI REPL; **informational** if M5 uses raw shell only] 0.3.5 has `src/submit-gate.js` + `src/prompt-symbol-registry.js` for REPL-ready detection before pressing Enter. Phase 1 `boot` module does NOT replicate this. **Resolution**: (a) M5 sessions skip submit-gate entirely (acceptable for spike but degraded UX for `claude` REPL specifically)? (b) M5 uses raw shell (`bash -i`) as the test child, bypassing the question? (c) port submit-gate to Rust as part of Phase 1 (would push LOC over 1500 budget per Q-D)? Recommended: (b) — manual M5 uses `bash -c 'echo hi'` fixtures rather than real `claude` REPL. Real submit-gate parity → Phase 2.

**Q4. cdylib C ABI smoke test scope.** [**binding-pre-Phase-2; optional Phase 1**, with F2 constraint] §2.2 r2 removed the callable `extern "C"` stub (F2). The cdylib crate-type builds for M28 packaging verification only — no symbols are callable in Phase 1. Phase 2 default = adds the symbol + host-loader smoke. **Resolution**: confirm Phase 1 ships zero callable C ABI (current r2 stance) vs add a smoke test in M4 stretch with a properly-defined `Result<i32>`-shaped stub (no `unimplemented!()`).

**Q5. Phase 1 RSS measurement methodology.** [**binding-pre-M4/G9** per Q-E r2] r2 §4.4 M4 adopts `ps -o rss=` as authoritative + `/proc/<pid>/status VmRSS` on Linux as second source. **PSS via smaps deferred to Phase 4** measurement-gate spec (Q-E hybrid). **Resolution status**: addressed by §4.4 reproducible script.

**Q6. `~/.telepty/sessions/<sid>/` directory ownership during coexistence.** [**binding-pre-M3 and pre-M5**] 0.3.5 Node daemon writes some metadata there. Phase 1 Rust supervisor writes `manifest.json`, `log.jsonl`, `supervisor.sock`. **Resolution needed before M3** (UDS path collision risk) and **before M5** (parity test compares `~/.telepty/sessions/<sid>/log.jsonl` from both backends — they must not share the same path). Recommended namespacing: Rust paths under `~/.telepty/sessions/<sid>/rust/{manifest.json,log.jsonl,supervisor.sock}`; node paths stay where they are.

**Q7. CI runner sizing.** [**informational unless G10 fails**] GitHub-hosted `macos-latest` runners are arm64; cold cargo builds with portable-pty + tokio + jemalloc stack are slow on these (no SSD persistence). If M4 measurements show G10 (cold ≤ 8 min, warm ≤ 90 s) cannot be met, this escalates to binding. **Resolution**: accept slower macOS CI (8 min cold OK per G10) or invest in self-hosted runners (Phase 2 work).

---

## 9. Acceptance gate

Phase 1 spike is **accepted** when **all** the following hold:

1. **M1–M5 demos all pass** on macOS arm64 + Linux x86_64. (M2 split into M2-core + M2-faults + M2-Q2 per §4.2 r2; all three sub-milestones complete.)
2. **§8.A always-on bucket** (10 scenarios listed in §5.1) green on both OS for ≥ 7 consecutive CI days, zero flakes. **C3 §8.A bucket is covered modulo 2 declared exceptions** (Q-B r2): (a) §8.A4 parent-death — Phase 2; (b) all Windows §8.A scenarios — Phase 2 W2 (Windows adapter track). Acceptance reviewer must confirm both exceptions are present in `docs/reports/2026-05-NN-phase1-acceptance.md`.
3. **G1–G10** (§1.1 success criteria table) each have a recorded measurement or passing test in `docs/reports/2026-05-NN-phase1-acceptance.md`. **G4/G5** require golden fixtures covering full A1/A2 enum schema (not just emitted variants).
4. **RSS measurement** per G9: 1-session **each ≤ 15 MB** AND 10-session **each ≤ 15 MB** on both POSIX targets, measured via the reproducible script in §4.4 (cleanup trap, exact PID tracking, per-run namespace). E3 binding; non-negotiable.
5. **Cross-LLM review** (Article 5): plan reviewed by at least one of {codex, gemini}; concerns recorded and addressed or explicitly deferred with rationale. (R1 done: gemini ACCEPT_AS_IS, codex MAJOR_FIXES → r2.)
6. **No regression** in 0.3.5 Node `npm test` (43 tests) — coexistence proven. **Daemon.js / cli.js / tui.js byte-identical** to pre-Phase-1 main (Q-C r2).
7. **LOC budget (Q-D r2)**: Rust implementation ≤ **1500 LOC** measured by `tokei crates/telepty-supervisor-core/src crates/telepty-supervisor-bin/src --type rust` (or equivalent `cloc --include-lang=Rust`). **Counted**: `*.rs` files under `crates/*/src/`. **Excluded**: tests (`crates/*/tests/`, `crates/*/src/**/*tests.rs`), `scripts/bridge-phase1.js` (Node, not counted toward Rust budget; itself bounded to ≤ ~150 LOC), CI workflow YAML, RSS measurement scripts, generated code (none expected in Phase 1), `build.rs` (none expected), golden fixture files (data, not code), FFI stubs (no callable C ABI in Phase 1 per F2). Overage requires written justification in the acceptance report.

After acceptance, the orchestrator decides Phase 2 entry per V1 ADR §12.7.1 (Phase 2 also requires C2 PASS + C3 closed — both already satisfied as of 2026-05-10). Phase 2 dispatch tasks include: (a) Windows ConPTY adapter; (b) real `daemon.js` routing for Rust-backend sessions; (c) parent-death detection + `ERR_PARENT_GONE`; (d) cdylib C ABI symbols + host-loader smoke; (e) submit-gate parity.

---

## 10. Changelog

| Revision | Date | Notes |
|---|---|---|
| r1 | 2026-05-12 | Initial draft. 9 sections per dispatch; 5 milestones (M1–M5) + Windows §4.6 deferred. 7 open Qs surfaced. |
| **r2** | **2026-05-12** | **Post cross-LLM review (codex MAJOR_FIXES + gemini ACCEPT_AS_IS).** 5 orchestrator-locked grilling decisions (Q-A/B/C/D/E) applied. 3 binding fixes (full A1/A2 wire enum schema with POSIX-only emission gate; §8.A trace-id + schema-version tests + declared C3 exceptions for parent-death and Windows; M5 manual standalone bridge with daemon.js untouched + LOC counting rule). 13 additional fixes (F1 exact MSRV pin 1.82.0, F2 drop callable extern "C" stub, F3 nix::libc single source, F4 manifest parent-dir fsync, F5 ipc mpsc linearization queue, F6 M2 split into core+faults+Q2-measurement, F7 M3 contract-conformance milestone, F8 reproducible RSS script, F9 M5 concrete write scope, F10 jemalloc init-order risk, F11 ERR_SPAWN_FAILED for manifest collision, F12 R9 contract drift risk + golden enum fixtures, F13 Q1–Q7 binding classification). r2 = small + surgical (codex direction). Architecture sections preserved (gemini ACCEPT). |
| **r2-patches** | **2026-05-12** | **3 minor textual patches per codex r2 verification (`docs/reports/2026-05-12-phase1-plan-codex-review-r2.md`).** Phase 1 `ERR_DUPLICATE_OP` / `ERR_SPAWN_FAILED` scope clarification (deferred row L51 — codes removed from Phase 2–3 deferred list, cross-references to G5/§3/§4/§6 added) + idempotency Phase 1 / Phase 2 split (L53 — full replay-suppression semantics stays Phase 2; minimal duplicate delete/inject LRU is Phase 1 for §8.A-idempotency) + MockChild scope clarification at §5.1 (L608 — `MockChild` confined to tombstone/fault-injection unit coverage; OS kill primitives tested via real supervisor processes only). Architecture untouched. R10 (bridge-inertia) APPROVED by codex r2. M1 dispatch unblocked. |

---

*End of plan r2. Awaiting orchestrator approval. Orchestrator may dispatch codex r2 verification before M1.*
