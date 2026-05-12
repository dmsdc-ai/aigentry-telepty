# Phase 1 plan r2 — codex r2 verification

## Verdict
ACCEPT_WITH_MINOR_FIXES

The r2 plan fixes the three r1 binding issues, applies the five orchestrator-locked grilling decisions, and addresses the 13 additional codex fixes. No R3 is needed. Two stale-text contradictions and one wording tension should be patched before M1 dispatch so implementers do not read Phase 1 idempotency / `ERR_*` scope two different ways.

## 3 binding — r2 status

| # | Issue | Status | Evidence |
|---|---|---|---|
| 1 | Wire enum scope | FIXED | G4/G5 now define full A1/A2 wire schema with POSIX-only emission gates (plan:L29-L30). `wire` declares all 6 `SignalKind` variants and all 15 `ErrorCode` variants (plan:L168-L185), gates emission paths (plan:L188-L193), enforces B3 per-kind trace validation and `v != 1` rejection (plan:L194-L199), and lists full golden fixtures (plan:L201-L207). |
| 2 | §8.A test bucket | FIXED | §5.1 adds trace-id propagation and schema-version enforcement scenarios (plan:L568-L581), declares parent-death and Windows §8.A exceptions with acceptance impact (plan:L583-L593), and carries the caveat into §9 acceptance (plan:L710-L712). |
| 3 | M5 / LOC | FIXED | M5 is now a standalone manual bridge with zero existing Node-file changes (plan:L503-L548). Migration says `daemon.js` / `cli.js` / `tui.js` remain unchanged and no automatic routing exists (plan:L642-L648). LOC counting is Rust-only and excludes bridge/CI/tests/goldens/FFI stubs (plan:L716). |

## 13 additional fixes — status

| # | Item | Status | Evidence |
|---|---|---|---|
| F1 | MSRV pin | FIXED | Exact `rust-toolchain.toml` pin to `1.82.0` is specified (plan:L86-L93). |
| F2 | extern C stub | FIXED | Phase 1 exposes no callable C ABI symbol; `extern "C" unimplemented!()` stub is removed (plan:L104). |
| F3 | libc dep | FIXED | Plan commits to `nix::libc` for libc surface and excludes standalone `libc` dependency (plan:L114, L127). |
| F4 | Manifest dir fsync | FIXED | Manifest operations include `fsync(parent_dir)` after rename/unlink and explain POSIX durability rationale (plan:L215-L231). |
| F5 | IPC queue | FIXED | Per-connection tasks enqueue to a single `mpsc` consumer, with global ordering documented (plan:L250-L265). |
| F6 | M2 split | FIXED | M2 is split into M2-core, M2-faults, and Q2 measurement subtasks (plan:L350-L399). |
| F7 | M3 critical | FIXED | M3 is explicitly the contract-conformance milestone and lands full enums, validators, queue, idempotency, and goldens (plan:L401-L430). |
| F8 | M4 RSS script | FIXED | RSS script now has cleanup trap, exact PIDs, exact child command, per-run namespace, and Linux second-source capture (plan:L447-L498). |
| F9 | M5 write scope | FIXED | Write scope lists only `scripts/bridge-phase1.js` as CREATE and explicitly marks `cli.js`, `daemon.js`, `tui.js` as NO CHANGE (plan:L509-L516). |
| F10 | jemalloc init order | FIXED | R3 states `bin::main()` is too late and requires compile-time config or launcher/test env before spawn (plan:L675). |
| F11 | spawn collision | FIXED | Existing live manifest collision now returns `ERR_SPAWN_FAILED`, not `ERR_SHUTTING_DOWN` (plan:L646). |
| F12 | contract drift R9 | FIXED | R8/R9 require full enum golden fixtures and explain emitted-subset-only tests are insufficient (plan:L680-L681). |
| F13 | Q1-Q7 binding | FIXED | Each open question is tagged informational or binding-pre-milestone (plan:L688-L702). |

## 5 grilling decisions — applied check

| Q | Status | Evidence |
|---|---|---|
| Q-A | FIXED | Hybrid full schema / POSIX emission gate appears in G4/G5 and `wire` (plan:L29-L30, L188-L193), with full golden fixtures (plan:L201-L207). |
| Q-B | FIXED | Parent-death is explicitly Phase 2 and recorded as a C3 §8.A exception (plan:L308, L583-L593, L711-L712). |
| Q-C | FIXED | M5 is manual standalone bridge; no `daemon.js` / `cli.js` / `tui.js` edits (plan:L503-L548, L642-L648, L663). |
| Q-D | FIXED | LOC budget counts Rust `src/` only and excludes bridge/test/CI/generated/golden/FFI surfaces (plan:L716). |
| Q-E | FIXED | M2 adds flush-time measurement (plan:L384-L397); M4 defines minimal reproducible RSS sampling and defers PSS/smaps to Phase 4 (plan:L447-L498). |

## R10 judgment
- APPROVE_R10
- Rationale: R10 is a legitimate implementation-risk reminder, not scope creep. It is tightly connected to Q-C: the plan deliberately keeps `bridge-phase1.js` manual and outside `daemon.js`, so the risk that the helper becomes a production path by inertia is worth tracking (plan:L682). No new work is required beyond documentation and Phase 2 routing discipline.

## C3-style stale contradictions (if any)
- Stale out-of-scope text: the row deferring "Full implementation of A2 error codes" still lists `ERR_DUPLICATE_OP` and `ERR_SPAWN_FAILED` as Phase 2-3 (plan:L51), while r2 requires Phase 1 emission for both manifest collision and idempotency (plan:L30, L424, L646). Minor patch: change that row to "remaining cross-machine/advisory A2 semantics" and remove those two codes from the deferred list.
- Stale out-of-scope text: "Idempotency keys, replay suppression (`ERR_DUPLICATE_OP`) = Phase 2" (plan:L53) conflicts with Phase 1 LRU/idempotency test scope (plan:L265, L424, L578). Minor patch: rewrite as "full replay suppression semantics = Phase 2; minimal duplicate delete/inject LRU for §8.A-idempotency = Phase 1."
- Minor wording tension: M2-faults suggests a test-only `MockChild` for unkillable/tombstone simulation (plan:L378-L382), while §5 says no mocks for kill semantics (plan:L608). Patch wording to clarify the mock is only for tombstone/fault-injection unit coverage; OS kill semantics remain real-supervisor tests.

## New issues introduced in r2 (if any)
- No blocking new issues. The only new concern is the mock-vs-no-mocks wording above; it is documentation hygiene, not an architecture or M1 blocker once clarified.

## M1 dispatch recommendation
- NEEDS_MINOR_PATCHES_FIRST

Patch the three stale-text items above, then proceed with M1. The binding fixes are complete: 3/3; additional fixes verified: 13/13; grilling decisions applied: 5/5.
