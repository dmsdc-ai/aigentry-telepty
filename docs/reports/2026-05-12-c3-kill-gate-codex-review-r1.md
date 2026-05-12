# C3 Kill Gate Spec - codex review r1 (implementer perspective)

## Verdict
ACCEPT_WITH_MAJOR_FIXES

The direction is viable, but r0 is not yet protocol-grade. Several requirements are stated as if they are direct `portable-pty`/Tokio implementation facts, but current APIs either do not expose the needed controls or have different semantics. The next revision should tighten the adapter contract before C3 is considered closed.

## Top 3 most important issues
1. Windows ConPTY/job/process-group behavior is not implementable with stock `portable-pty` 0.9.0 as written, and the `SIGTERM`/`SIGINT` equivalence map overclaims Windows console-control semantics.
2. POSIX child reaping is wrong for grandchildren: a supervisor cannot `waitpid(-1)` children spawned by the L3 child unless they have been reparented to it, and macOS has no `PR_SET_CHILD_SUBREAPER` equivalent.
3. The spec conflicts with the V1 ADR on crash restart/default tombstone, delete manifest retention/unlink, and wire envelope fields (`v` vs `schema_version`); the five ADR amendments cannot be "optional" if r0 depends on them.

## Section-by-section findings

### §0 Scope
- Rust + `portable-pty` + single-thread Tokio is feasible for POSIX, but the Windows kill-gate surface requires either a `portable-pty` fork/patch or a custom Windows adapter. `portable-pty::SlavePty::spawn_command` returns a boxed `Child`, and `PtySystem` only exposes `openpty`; no job object handle, creation flag override, or console process group id is part of the public trait surface. Evidence: `PtySystem::openpty` and `SlavePty::spawn_command` docs at <https://docs.rs/portable-pty/latest/portable_pty/trait.PtySystem.html> and <https://docs.rs/portable-pty/latest/portable_pty/trait.SlavePty.html>.
- The spec says implementation choice is free per M25, but §0.3 simultaneously names `portable-pty` as a language assumption. The next rev should state explicitly whether Windows may bypass/fork `portable-pty`; otherwise §3.2 is not implementable.
- The scope says the spec does not modify the V1 ADR, while §9.3 proposes required schema and manifest extensions. That is acceptable only if the spec marks those amendments as mandatory preconditions for acceptance.

### §1 Lifecycle (A.1-A.5)
- §1.2/§1.3 are implementable on POSIX with explicit process-group signaling, but not through `portable-pty` child killing. `portable-pty::ChildKiller::kill` is "terminate child process"; in source it sends SIGHUP first on Unix and only later falls back to `std::process::Child::kill`, which targets the direct pid, not the process group. The spec's conclusion "do not rely on portable-pty kill for graceful SIGTERM" is correct, but it cites `MasterPty::kill`, which does not exist in the current `MasterPty` trait. Evidence: <https://docs.rs/portable-pty/latest/portable_pty/trait.MasterPty.html> and <https://docs.rs/portable-pty/latest/portable_pty/trait.ChildKiller.html>.
- §1.2 says Windows `CTRL_BREAK_EVENT` is equivalent to POSIX `SIGTERM`. It is only loosely analogous. Microsoft documents console-control delivery to processes in the same console process group; it is handler-based and not a POSIX signal. This must be stated as "best observable equivalent", not semantic equivalence. Source: <https://learn.microsoft.com/en-us/windows/console/generateconsolectrlevent>.
- §1.3 lists "supervisor receives SIGKILL itself" as a forced-kill trigger. A SIGKILLed supervisor cannot run §1.3 behavior; this belongs only to crash recovery/stale manifest handling.
- §1.5 default `restart_policy: tombstone` conflicts with V1 ADR M34/H1, which says service-manager restart yields a fresh PTY and fresh child invocation under the same session id. If tombstone is desired, M34 needs a real amendment.
- §1.5 assumes an OS service manager can respawn a per-session supervisor with the same `<sid>` after install-time registration. Dynamic per-session launchd/systemd/Windows Service registration is not specified and is not a property of "install time". This is a major implementation gap.
- POSIX crash behavior says master FD close causes child SIGHUP and child default termination. A child can handle/ignore SIGHUP, create a new session, or have descendants outside the controlling pgrp. The spec needs a stale-process policy for "supervisor died, child survived".

### §2 Timeout matrix
- `child_reap_timeout_ms` is not directly compatible with `portable-pty::Child::wait`, because that method blocks execution. In a single-thread Tokio reactor, a blocking wait will stall IPC, timers, and signal handling. Use `try_wait` polling with `tokio::time::sleep`, or run blocking wait on a dedicated blocking thread. Evidence: `portable-pty::Child::wait` blocks and `try_wait` is nonblocking: <https://docs.rs/portable-pty/latest/portable_pty/trait.Child.html>.
- A `tokio::time::timeout(child.wait().await)` pattern only applies to `tokio::process::Child`, not to `portable-pty::Child`. Tokio's `Child::kill` is SIGKILL-plus-wait on Unix, but `portable-pty` is a separate synchronous trait. Source: <https://docs.rs/tokio/latest/tokio/process/struct.Child.html>.
- `signal_dispatch_timeout_ms = 100 ms` is not a meaningful invariant for `kill(2)`: the syscall either returns or errors. If the intent is "adapter call must not block the event loop", write that as an adapter rule and test it with a fake/hung Windows API wrapper.
- `kill_force_after_ms` duplicates `graceful_grace_ms` while also being overrideable. If force is immediate after grace, remove the second knob or define `kill_force_after_ms == graceful_grace_ms` as an invariant.
- The 3000 ms default may be reasonable as a proposal, but the cited CLI flush observations are not in this repo. Keep it as a proposal until measured in the Phase 1 sidecar spike.
- jemalloc: `dirty_decay_ms:0` does cause immediate purge of unused dirty pages according to jemalloc docs, but r0 overstates "tokio runtime drop calls jemalloc arena cleanup" and "all dirty pages are returned to OS within ms". The allocator setting is evidence for a tuning hypothesis, not a post-kill invariant. Source: <https://jemalloc.net/jemalloc.3.html>.

### §3 Cross-OS (3.5 equivalence)
- `SIGINT -> CTRL_C_EVENT` is wrong as scoped group behavior. Microsoft states `CTRL_C_EVENT` cannot be limited to a process group; if `dwProcessGroupId` is nonzero, the call can succeed but target processes do not receive it. Only `CTRL_BREAK_EVENT` has the group-targeting property r0 relies on. Source: <https://learn.microsoft.com/en-us/windows/console/generateconsolectrlevent>.
- `GenerateConsoleCtrlEvent` requires target processes to share the caller's console. ConPTY children are attached to a pseudoconsole/conhost; the spec must prove the supervisor can legally deliver CTRL_BREAK from a service/daemon context or define an `AttachConsole`/helper-console mechanism.
- Stock `portable-pty` Windows ConPTY spawning does not pass `CREATE_NEW_PROCESS_GROUP`, does not create/assign a Job Object, and does not expose a job handle. Its ConPTY source calls `CreateProcessW` with `EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT`. Therefore §3.2 is an adapter design, not a statement about using current `portable-pty` as-is.
- Job Object cascade is a good forced-kill mechanism, but it is not exactly equivalent to `kill(-pgid, SIGKILL)`: nested jobs, breakaway flags, and process-created jobs affect containment. Microsoft docs explicitly call out breakaway and nested-job behavior. Source: <https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects>.
- §3.1 says `CommandBuilder::pre_exec` exists. The public `portable-pty::CommandBuilder` docs show no `pre_exec` method. On Unix, `portable-pty` internally calls `setsid()` and sets the controlling tty; the contract should rely on that or require a fork/extension. Evidence: <https://docs.rs/portable-pty/latest/portable_pty/cmdbuilder/struct.CommandBuilder.html>.
- §3.5 "all behaviors must mirror" is too strong. For cross-OS protocol, define observable parity: final manifest, direct child gone, descendants policy, exit reason class, and emitted errors. Do not claim primitive equivalence.

### §4 Child reaping
- The SIGCHLD model is the largest POSIX bug. The supervisor receives SIGCHLD for its direct children, not for grandchildren that the L3 child spawned. `waitpid(-1, WNOHANG)` in the supervisor cannot reap grandchildren while their actual parent is alive. Linux `PR_SET_CHILD_SUBREAPER` only helps after orphaning, and macOS has no equivalent.
- The spec should replace "reap any sub-children that the L3 child spawned" with "verify no live descendants remain in the targeted pgrp after process-group kill; reap only direct supervisor children; optionally use Linux subreaper for orphaned descendants".
- §4.1 allows `waitpid(child_pid, 0)` within a timeout. A blocking raw `waitpid` has no timeout unless it runs on a separate thread or is replaced with WNOHANG polling.
- Tokio `SignalKind::child()` is a notification stream, not a reaper. Tokio also documents signal coalescing and global signal-handler side effects; the spec must still define the actual `try_wait`/`waitpid` loop. Source: <https://docs.rs/tokio/latest/tokio/signal/unix/struct.Signal.html>.
- Runtime shutdown race is not closed. If shutdown cancels the reaper future or drops the runtime before manifest/log finalization, §6 invariants can be skipped. Make the kill gate a non-cancellable terminal state: once entered, it owns the runtime until child status, manifest, log flush, and IPC close are complete.

### §5 PTY concerns
- The `PtyPair` slave-first drop claim is correct in source and is a valid reason to drop `pty.slave` after spawn. Public docs expose fields in `slave, master` order: <https://docs.rs/portable-pty/latest/portable_pty/struct.PtyPair.html>.
- §5.2 says `ClosePseudoConsole` does not terminate the child directly and the child must observe broken pipe. Microsoft's "Creating a Pseudoconsole Session" documentation says closing the pseudoconsole stops attached character-mode applications and associated attached tree; it also warns close can deadlock unless pipes are drained. Source: <https://learn.microsoft.com/fr-fr/windows/console/creating-a-pseudoconsole-session>. The spec should treat ClosePseudoConsole as a terminating teardown primitive with drain/deadlock constraints, not merely a broken-pipe signal.
- `pty_close_grace_ms = 500` is not a portable flush guarantee. Better contract: after child exit, keep reading master until EOF or read-drain deadline, then close.
- `MasterPty::take_writer` docs say dropping the writer sends EOF to the slave. That is separate from dropping the master. The spec should distinguish writer EOF, master read-side EOF, and pty object teardown.

### §6 State invariants
- "No process in the supervisor's session/pgrp remains" is only verifiable if all descendants stayed in the pgrp/session. Children can call `setsid`, daemonize, or use Windows breakaway/job behavior. Define escaped descendants as a separate failure mode or explicitly out of scope.
- The manifest keeps stopped tombstones, but V1 ADR A8 says delete unlinks the manifest. Pick one: retain tombstone for audit, or unlink after a tombstone retention window. This must be reflected in the ADR.
- `exit_reason: "orphan"` appears in §6.3 but §1.4 says orphaned supervisors remain `status:"ready"` and do not exit. Remove `orphan` from terminal `exit_reason` or define a terminal orphan cleanup path.
- §6.5 "jemalloc heap freed" is not a session-level invariant. After process exit, heap is gone because the OS tears down the process; while still running, allocator RSS behavior is probabilistic and workload-dependent. Keep RSS as a Phase 4 measurement gate, not a per-kill invariant.
- `lsof -p <supervisor_pid>` after the supervisor is gone is not a useful FD assertion. Check stale socket inode removal and no live process by pid instead.

### §7 Failure modes
- §7.B says after D-state timeout the supervisor abandons the child and exits with code 0, while §6.1 says no process in the pgrp remains after kill. Those conflict. If `unkillable` is allowed, §6 must exempt `exit_reason:"unkillable"` from no-process invariants and preserve the abandoned pid/pgrp for operator action.
- The "3 consecutive WNOHANG returns of 0 (~6 seconds total)" math depends on polling interval, but no interval is specified. Tie it to `child_reap_timeout_ms` or define a separate poll cadence.
- §7.C Windows "D-state equivalent" is too hand-wavy for CI/protocol. `TerminateJobObject`/`TerminateProcess` can leave a process object signaled only after kernel teardown completes; abandoned unkillable state should be treated as rare manual-test behavior, not assumed symmetric.
- §7.E says stale UDS socket inode remains after supervisor SIGKILL. Unix domain socket path files commonly remain, but only if the program created pathname sockets and did not unlink on startup. State that cleanup is best-effort and list must validate pid/IPC, not trust socket path.
- §7.G says single-thread Tokio makes concurrent delete/signal race-free with no mutex. FIFO is only true per connection/stream. Across five clients, accept order is scheduler/IPC order; the state machine can be race-free, but not globally FIFO unless the supervisor serializes frames through one queue.
- §7.H is consistent with M40.

### §8 Test scenarios
- The test count is not 14 if §8.K runs every prior scenario on 3 OSes; it becomes a matrix. The spec should distinguish scenario definitions from platform matrix expansion.
- Many fixtures are POSIX-only (`bash`, `trap`, `sleep`, `ps`, `lsof`, `unshare`, NFS). Windows-native equivalents are not provided, so §8.K cannot pass as written.
- §8.G2 D-state test is not suitable for standard CI. It requires privileged/network filesystem manipulation and can leave a stuck host process. Make it a manual/destructive test or replace CI coverage with a fake child/reaper adapter that simulates unkillable wait.
- Service-manager restart tests (§8.A5) are not runnable in normal GitHub Actions without installing per-user launchd/systemd/Windows Service units. Split them into adapter integration tests run on controlled hosts and a unit test for stale-manifest restart policy.
- Timing assertions like `<200 ms` and `[3000,3200] ms` are too tight for Windows/macOS CI. Use configured timeout plus wider tolerance or assert ordering and bounded upper limits.
- §8.A4 parent-death fixture is underspecified. Killing a dummy WS holder is not the same as killing the supervisor's OS parent. If parent-death policy is heartbeat-based, test heartbeat absence; if OS parent death is intended, the dummy process must actually spawn the supervisor.
- §8.H expects `ERR_NOT_REACHABLE` within K1 p99 <= 100 ms. Cross-machine K1 is a Phase 4 measurement gate, not a deterministic PR CI assertion.

### §9 V1 ADR integration (+ §9.3 proposed amendments)
- Mandates M22-M40 exist in the V1 ADR. The spec touches M22, M24, M25, M28, M29, M31, M34, M36, M37'/M38', and M40. It does not materially integrate M23, M26, M27, M30, M32, M33, M35, or M39. That is fine, but §11 should not claim full M22-M40 alignment from a 10-row table.
- M34 conflict: V1 ADR says crash detection restarts a fresh PTY and fresh child under the same sid; r0 default is `restart_policy:"tombstone"`. This is not additive; it changes default operability semantics.
- A8 conflict: V1 ADR says `delete` unlinks manifest; r0 requires final stopped manifest as observable invariant. This needs an ADR amendment or spec adjustment.
- Wire envelope conflict: V1 ADR uses `v:1`; manifest uses `schema_version`. r0 wire examples include both `v` and `schema_version`, and §9.4 says `schema_version` is placed in the NDJSON envelope. If wire frames require both, amend §6.1. Otherwise use only `v`.
- Trace conflict: V1 ADR requires `trace_id` for `inject` and `output`; r0 requires every kill protocol message to include trace_id. That may be a good stricter rule, but it is an amendment to §6.1/§6.2 examples.
- §9.3 calls amendments "Required" and later "optional". They are required for r0's protocol and manifest to validate. Make them binding-required before acceptance.
- Amendment 1 (signal enum) is necessary but insufficient. It must also define platform-normalized observable exit semantics and remove/repair `CTRL_C_EVENT` as a group-targeted SIGINT mapping.
- Amendment 2 (error codes) is necessary.
- Amendment 3 (exit_reason enum) is necessary, but `orphan` should not be a terminal reason unless an orphan terminal path exists.
- Amendment 4 (`kill_gate`, `restart_policy`) is necessary only if the ADR accepts a tombstone option; default tombstone conflicts with M34.
- Amendment 5 (`shutdown_drain.escalated`) is useful, but `shutdown_drain` should also specify parent trace linkage if §8.I expects it.

### §10 Open Q1-Q9
- Q1 per-CLI grace default: informational for now; binding before Phase 2 if tests depend on exact default.
- Q2 restart default: binding-required. It currently conflicts with M34 and must be answered before C3 closure.
- Q3 `PR_SET_PDEATHSIG`: should be closed in r1 as "omit". Installing `PDEATHSIG=SIGTERM` conflicts with §1.4's "do not self-terminate on parent death" and §1.2's "SIGTERM means graceful shutdown".
- Q4 child reap timeout configurability: binding-required for tests. If hard-coded, tests must not require privileged D-state behavior in CI.
- Q5 K1 for delete: informational/Phase 4 measurement. Do not make it a Phase 1/2 kill-gate acceptance assertion.
- Q6 ADR amendments folded or separate: binding-required. The spec must name the SSOT for new enum/error/manifest fields.
- Q7 unkillable user notification: correctly deferred to V4, but Phase 1 still needs CLI/list surfacing.
- Q8 OOM-killed supervisor: not really open; it is crash recovery. What remains open is whether child-survival/stale-process detection differs after OOM.
- Q9 helper subprocess bound: binding only if helpers are in Phase 1. If helper count is "typically 0", keep helpers out of the Phase 1 kill-gate contract.

## Anti-patterns / hidden assumptions
- Equivalence by label: `SIGTERM == CTRL_BREAK_EVENT` and `SIGKILL == TerminateJobObject` are useful mapping names, not identical semantics.
- Service-manager magic: install-time registration cannot automatically restart arbitrary dynamic per-session supervisors with the right sid unless the spawn path registers per-session units/services.
- Blocking calls inside `current_thread`: `portable-pty::Child::wait`, raw `waitpid(0)`, `WaitForSingleObject(INFINITE)`, and synchronous ConPTY pipe operations must be isolated from the single-thread Tokio reactor.
- Reaping non-children: process-group membership lets the supervisor signal descendants; it does not let it reap descendants.
- Manifest double duty: r0 wants manifests as durable tombstones and V1 A8 wants delete to unlink manifests. Pick one.
- CI-as-kernel-fault-lab: D-state/NFS hangs, service-manager restarts, and cross-machine K1 are not normal PR CI tests.
- Global signal handler drift: Tokio Unix signal listeners coalesce signals and do not restore default handlers after registration. The supervisor must explicitly decide exit behavior after receiving SIGTERM/SIGINT.
- `portable-pty` abstraction leak: r0 relies on handles and creation options that are deliberately outside the portable trait surface.

## Recommendation for next rev
- Produce SPEC-C3-r1 with a concrete adapter contract: POSIX may use stock `portable-pty` plus direct pgid signaling; Windows must either fork/extend `portable-pty` or own a custom ConPTY spawn path that exposes `PROCESS_INFORMATION`, Job Object handle, creation flags, and close ordering.
- Replace primitive equivalence claims with observable parity assertions and per-platform mechanism notes.
- Rewrite POSIX reaping around direct-child reaping, process-group liveness verification, and optional Linux-only subreaper behavior.
- Make the five ADR amendments mandatory or remove the dependent fields from the spec. Resolve M34 restart default and A8 delete/tombstone behavior explicitly.
- Split §8 into always-on CI tests, controlled-host integration tests, and destructive/manual fault tests.
- Define a non-cancellable kill-gate shutdown sequence that cannot be aborted by Tokio runtime teardown.
