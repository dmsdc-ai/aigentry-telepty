# C3 r1 spec - codex r2 verification

## Verdict

ACCEPT_WITH_MINOR_FIXES

r1 fixes the substantive C3 design gaps: Windows now requires a custom ConPTY/Job adapter, reaping is specified off the reactor path, crash recovery is orchestrator-driven, and the tests are split into CI/nightly/manual buckets. The remaining problems are mostly stale contradictory text and mandate-table drift, not a new architecture gap. I count 8/9 binding issues fully fixed, with the POSIX child/grandchild reaping issue only partial because §3.1 still contradicts §4.

## 9 binding issues - r1 fix status

| # | Issue | Status (FIXED/PARTIAL/NOT_FIXED) | Evidence (line ref) |
|---|---|---|---|
| 1 | Windows ConPTY/Job scope was underspecified. | FIXED | §0.3 states stock Windows `portable-pty` is insufficient and a custom adapter/fork is mandatory (56-59). §3.2 enumerates required process, job, HPCON, STARTUPINFOEX, and console-group surfaces (354-369). |
| 2 | POSIX child/grandchild reaping semantics conflicted with implementable ownership. | PARTIAL | §4 now says only the direct child is reaped, grandchildren are not reaped, and post-SIGKILL group liveness is checked instead (487-545). However §3.1 still says a SIGCHLD handler may reap sub-children spawned by L3 (336-338), which contradicts the direct-child-only model. |
| 3 | V1 ADR conflicts on restart policy, manifest lifecycle, and wire versioning. | FIXED | Restart policy defaults to orchestrator respawn with manual opt-out (236-240). Clean exits unlink manifests and failure exits tombstone (720-743). Wire envelopes use `v:1`, while manifest schema versioning is separate (763-767). |
| 4 | Blocking waits on a `current_thread` reactor were unsafe. | FIXED | §0.3 bans blocking calls on the reactor and requires `spawn_blocking` or a dedicated OS thread (61-63). POSIX and Windows reaping are specified through blocking-safe paths (493-517, 547-558), with a reactor-stall test (995-1002). |
| 5 | SIGINT/CTRL_C_EVENT parity was incorrectly specified. | FIXED | Cross-OS signal mapping now marks POSIX SIGINT as POSIX-only and Windows `SIGINT` as `ERR_BAD_FRAME` (279-292). §3.2.3 removes `CTRL_C_EVENT` parity and documents observable-only equivalence (412-421). |
| 6 | Supervisor crash recovery depended on an external service-manager assumption. | FIXED | §1.5 replaces that with orchestrator-driven respawn after stale-supervisor detection (227-244). Windows also states no parent job/service assumption (438-440). The nightly tests cover respawn and manual policy (1039-1055). |
| 7 | A1-A3 amendments were not made binding for closure. | FIXED | §9.3 makes enum, field, and error-code amendments mandatory before closure or declares the spec itself as SSOT with ADR xrefs (1137-1141). A1-A3 are listed as mandatory (1143-1168), with summary language preserving A4/A5 as non-blocking (1190-1200). |
| 8 | Test plan mixed CI, destructive, timing, and future-scope tests. | FIXED | §8 splits tests into PR CI, controlled-host nightly, and destructive/manual/Phase 4 buckets (903-921), with cross-OS matrix dimensions separated from scenario count (1097-1099). |
| 9 | Windows Job Object assignment integrity lacked a race-free contract. | FIXED | §3.2.2 requires `PROC_THREAD_ATTRIBUTE_JOB_LIST` where available, a `CREATE_SUSPENDED` fallback otherwise, `bInheritHandles=FALSE`, and fail-fast behavior if assignment cannot be guaranteed (371-410). §8.A.W-jobrace tests the race (968-975). |

## Lower-severity (~25) - fix status sample

- SIGKILL-self semantics: FIXED. Supervisor self-SIGKILL is explicitly removed from forced-kill triggers (149-157).
- Duplicate timeout knobs: FIXED. `kill_force_after_ms` and `signal_dispatch_timeout_ms` are removed, with grace/reap/drain semantics separated (273-277).
- Public `pre_exec` dependency: FIXED. POSIX now relies on `portable-pty` internals for `setsid()` and does not require public `pre_exec` access (324-326).
- `PR_SET_PDEATHSIG`: PARTIAL. §3.5 and Q3 reject it as a portability primitive (459-475, 1228-1231), but §3.1 still says the supervisor MAY install it (342-350).
- Non-cancellable terminal state: FIXED. §4.1 requires holding the reap `JoinHandle` until completion or timeout, with no `select!` branch that can drop it early (481-485).
- `ClosePseudoConsole` ordering: FIXED. Windows teardown now has explicit drain, handle-close, `ClosePseudoConsole`, and Job/child handle ordering, with deadlock caveats (638-666).
- RAM/jemalloc invariant: PARTIAL. §6.6 correctly moves RSS cleanup to Phase 4 and removes it from per-kill invariants (773-780), but §9.1 still has stale mandate-table language about RAM returning within milliseconds (1116-1119).
- FIFO/concurrent frame behavior: FIXED. Concurrent requests use per-stream FIFO with an internal queue and no global ordering guarantee (793-795, 876-882).

## New issues introduced in r1 (if any)

- Stale contradiction in §3.1: lines 336-338 still describe a SIGCHLD handler reaping L3-spawned sub-children, while §4 says the supervisor reaps only its direct child and never grandchildren (487-545). This should be removed or rewritten as optional subreaper-disabled behavior.
- Stale `PR_SET_PDEATHSIG` text: lines 342-350 still allow the supervisor to install `PR_SET_PDEATHSIG`, conflicting with the Q3 closure and §3.5 portability stance (459-475, 1228-1231).
- Stale mandate table entries: §9.1 lines 1116-1119 still refer to RAM returning to the OS within milliseconds, service-manager respawn, and old §8.I/§8.J names. Those entries contradict §6.6, §1.5, and the new §8 bucket names.
- Stale API wording: §5.1 line 628 refers to `portable-pty` `MasterPty::kill()`. The implementable API is `ChildKiller::kill`; keeping the old name will mislead implementers.
- Minor lifecycle wording drift: §1.2 line 131 still presents `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, console_group_id)` as the Windows equivalent to POSIX SIGTERM-to-process-group. §3.2.3 and §3.5 correctly narrow this to observable parity, so §1.2 should use the same wording.

## Q6 recommendation (SSOT)

Recommend folding A1-A3 directly into V1 ADR r7 as the single SSOT, with the r1 C3 spec linking to the exact ADR anchors. The amendments are protocol/contract fields, not local implementation notes; splitting them into a separate amendment ADR would leave implementers checking two normative documents for `exit_reason`, manifest lifecycle, `trace_id`, wire `v:1`, and error taxonomy. A separate amendment ADR is only worthwhile if V1 ADR r7 is frozen for publication mechanics, and even then it should be immediately cross-linked from the V1 ADR normative sections.

## C3 closure recommendation

NEEDS_ADR_AMENDMENT_FIRST

The r1 spec is close enough for acceptance with minor fixes, but C3 should not be marked fully closed until A1-A3 are folded into the SSOT path or the spec is explicitly declared the SSOT with ADR cross-references. Before final signoff, patch the stale §3.1, §5.1, and §9.1 contradictions above; no full r2 architecture rewrite is required unless closure policy treats the §3.1 reaping contradiction as binding.
