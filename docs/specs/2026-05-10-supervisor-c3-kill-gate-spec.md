# Telepty L2 Supervisor Kill Gate Specification (Phase 0 C3 closure)

| Field | Value |
|---|---|
| **Status** | **r1 — post cross-LLM review** (codex MAJOR_FIXES + gemini MINOR_FIXES addressed) |
| **Date** | 2026-05-10 (r0) → **2026-05-12 (r1)** |
| **Author** | session `E-architect-c3-killgate` (telepty repo) |
| **Repo placement** | `aigentry-telepty/docs/specs/` (component-level mechanism — Article 3 역할) |
| **Closes** | V1 ADR Phase 0 precondition C3 |
| **Phase impact** | Phase 1 sidecar spike unblocked; Phase 2 entry gate per `2026-05-10-telepty-l2-architecture-q-prime-bis.md` §12.7.1 |
| **Output ID** | SPEC-C3-r1 |
| **Cross-LLM review** | r1 incorporates: codex (implementer, ACCEPT_WITH_MAJOR_FIXES) + gemini (researcher, ACCEPT_WITH_MINOR_FIXES) |

## Changelog

- **r1 (2026-05-12)** — post cross-LLM review (codex MAJOR + gemini MINOR). 9 binding issues addressed:
  1. Windows ConPTY/Job Object — declared **custom adapter required** (stock `portable-pty` 0.9.0 insufficient); §3.2 lists 6 adapter surface items.
  2. POSIX grandchild reaping — rewritten: **reap only direct child**; verify no live procs in pgrp post-kill; `PR_SET_CHILD_SUBREAPER` Linux-only enhancement; macOS no equivalent.
  3. V1 ADR conflicts (M34, A8, wire envelope) — **resolved by aligning spec to V1 ADR** (not by mandating ADR amendments): default `restart_policy: respawn` (M34), `delete` → unlink manifest (A8), wire uses `v:1` only.
  4. Blocking calls in single-thread tokio — invariant added: **no blocking call on the single-thread reactor**; all blocking I/O via `spawn_blocking` pool; `try_wait + tokio::time::sleep` poll pattern.
  5. SIGINT↔CTRL_C_EVENT mapping removed — `CTRL_C_EVENT` cannot be group-targeted per Microsoft docs; only `CTRL_BREAK_EVENT` is the graceful Windows escalation.
  6. Service-manager assumption replaced — **orchestrator-initiated respawn** (control-tower pattern per V1 ADR §1.4), not OS service-manager auto-restart. Dynamic per-session unit registration is out of scope.
  7. §9.3 ADR amendments — **all 5 marked mandatory preconditions** with binding-required headers; Amendment 4 (kill_gate manifest fields) folded into spec (no V1 ADR change required for the additive field block).
  8. §8 tests reorganized into 3 buckets (always-on CI / controlled-host integration / destructive-manual); §8.K cross-OS matrix split from scenario count; §8.H K1 moved to Phase 4 measurement gate.
  9. Windows Job Object integrity — added atomic spawn+attach pattern (`PROC_THREAD_ATTRIBUTE_JOB_LIST` Win10+ OR `CREATE_SUSPENDED`+`AssignProcessToJobObject`+`ResumeThread`); `bInheritHandle=FALSE` on `CreateJobObjectW`; new §8.A "crash-before-attach" race test.

  Lower-severity fixes applied (~25 items from codex + gemini lower-tier): `signal_dispatch_timeout_ms` removed; `kill_force_after_ms` collapsed to invariant; jemalloc-freed invariant moved to Phase 4 measurement; `pre_exec` citation removed (uses portable-pty internal `setsid()`); `lsof` post-exit assertion replaced with stale-socket + live-pid check; `unkillable` reconciled with §6 (exempted from no-process invariant); D-state poll cadence tied to `child_reap_timeout_ms`; Q3 closed (omit `PR_SET_PDEATHSIG`); Q1-Q9 marked binding-required vs informational.

- **r0 (2026-05-10)** — initial draft, 9/9 scope checklist, 14 test scenarios baseline.

---

## §0 Scope and Non-Goals

### §0.1 What this spec defines

This spec defines **how a per-session supervisor process terminates the L3 child it owns** under the Q'''-bis architecture (V1 ADR §3.3, §9). It is the binding contract between:

- **supervisor** ↔ **L3 child** (claude / codex / gemini / shell) — signal delivery, PTY teardown, reaping, state invariants;
- **orchestrator** ↔ **supervisor** — `signal` and `delete` wire kinds (per V1 ADR §6.2), trace propagation, error taxonomy;
- **relay** ↔ **supervisor** — orphan detection, parent-death policy, manifest sync (per V1 ADR §8.2 L3a / §3.3 / §17.3 r3 closure note);
- **OS service manager** (launchd / systemd-user / Windows Service) ↔ **supervisor** — supervisor crash recovery (M34) without resurrecting a dead PTY.

### §0.2 What this spec does NOT define

- **Child CLI conversation recovery**. Per V1 ADR §17.3 r3 closure note, killing the supervisor kills the PTY master FD; the child CLI's conversation state is owned by the child process itself, not telepty. Recovery is observability-only (manifest + `log.jsonl` preserved); live PTY recovery is intentionally out of scope.
- **Implementation code**. The Phase 1 sidecar spike (Phase 1 entry per §12.7.1) implements this contract. This spec is binding on the contract surface only (signals, timeouts, state invariants, wire frames). Per-OS adapter implementation choice is free per M25.
- **Mailbox / store-and-forward.** If a kill operation cannot reach a remote relay, it fails fast per M40 binary reachability — no queueing.
- **V1 ADR amendments.** This spec references M22–M40 and §3, §6, §7, §8, §9, §13.1, §13.3, §17.3, §17.5; it does not modify any mandate or §-text. If review surfaces a contradiction, this spec is amended, not the ADR.
- **Constitution amendments.** Per §3.13 of CONSTITUTION.md, only the orchestrator may amend constitutional text. This spec only references Articles 1, 2, 3, 5, 9, 13, 17 as the reasoning frame.

### §0.3 Language and adapter assumption

Per dispatch and §17.5 / parallel r6 dispatch lock, the supervisor is **Rust** with single-thread `tokio` + `jemalloc`. Path A (Node 0.3.x maintained) substitution is out of scope; if C2 PoC FAILs and Path A is selected, this spec is **re-derived** for Node-equivalent primitives (no transparent translation is binding).

**PTY adapter scope** (r1 clarification, addressing codex Issue 1):

- **POSIX (Linux + macOS)**: stock `portable-pty` 0.9.0 is sufficient. The supervisor uses `portable-pty` for PTY allocation and spawn; **direct `nix::sys::signal::kill` and `libc::waitpid` are used for the kill gate path** because `portable-pty::ChildKiller::kill` sends SIGHUP-then-pid-targeted SIGKILL (not pgrp-targeted) — see §1.2 rationale.
- **Windows native**: stock `portable-pty` 0.9.0 is **insufficient** for the Q'''-bis kill gate. `portable-pty::PtySystem::openpty` and `SlavePty::spawn_command` (see <https://docs.rs/portable-pty/latest/portable_pty/trait.PtySystem.html> and <https://docs.rs/portable-pty/latest/portable_pty/trait.SlavePty.html>) do not expose: Job Object handle, `CreateProcess` creation flags, ConPTY HPCON handle, console process-group id, or `PROCESS_INFORMATION`. The spec mandates a **custom Windows ConPTY adapter** (or `portable-pty` fork) that exposes the surface enumerated in §3.2.1 (6 items). M25 leaves implementation choice free — this is a contract specification, not an implementation choice.

**Single-thread reactor invariant** (r1 addition, addressing codex Issue 4):

> The supervisor runs a `tokio` runtime in `current_thread` mode (per V1 ADR M24). **No blocking call may execute on the reactor thread.** All blocking I/O — `libc::waitpid(_, 0)`, `WaitForSingleObject(_, INFINITE)`, synchronous ConPTY pipe ops, `portable-pty::Child::wait` (which is a synchronous trait, NOT `tokio::process::Child`) — MUST execute on `tokio::task::spawn_blocking` or a dedicated OS thread. Polling alternatives (`try_wait + tokio::time::sleep(N)`) are preferred for short-budget waits. Tested by §8.A "reactor-stall" scenario.

### §0.4 Terminology

| Term | Definition |
|---|---|
| **supervisor** | the per-session OS process owning exactly one PTY master + one PTY slave, one UDS / Named Pipe endpoint, one manifest, one `log.jsonl` (V1 ADR §3.3 / §9.1). |
| **child** / **L3 child** | the program running under the PTY (claude / codex / gemini / bash / pwsh). |
| **orchestrator** | the control-tower session issuing `signal` / `delete` frames (V1 ADR §3.3 boundary). |
| **relay** | per-host `telepty-relay` process; never owns a PTY (V1 ADR §3.4 / §8.4). |
| **graceful** | termination path that issues SIGTERM-equivalent first and waits at most `graceful_grace_ms` before escalating. |
| **forced** | termination path that issues SIGKILL-equivalent immediately, no grace. |
| **kill gate** | the union of mechanisms in §1–§7 that takes the supervisor + child from `ready` / `draining` to `stopped` (or `error`). |
| **observable behavior** | facts an external observer can verify via `ps`, `lsof`, `wmic process`, `Get-Process`, manifest read, `log.jsonl` read. The acceptance basis per Article 13 객관성. |

---

## §1 Lifecycle stages (scope A.1–A.5)

The kill gate covers five lifecycle stages. Every supervisor instance MUST traverse exactly one of these on its way from `ready` to `stopped` / `error` (manifest `status` field per V1 ADR §7.3).

### §1.1 Normal termination (A.1)

**Trigger**: child exits on its own (zero or non-zero exit code). No external kill signal.

**Supervisor behavior** (r1 — reap via spawn_blocking per §0.3; A8 align per §6.3):

1. PTY master read side detects EOF (POSIX kernel close of child's PTY end / Windows ConPTY pipe close).
2. Supervisor reaps direct child via spawn_blocking + WNOHANG poll (§4.1.1 POSIX / §4.2 Windows) within `child_reap_timeout_ms`.
3. Drain remaining PTY output (≤ `pty_read_drain_deadline_ms`).
4. Append `kind:"shutdown_drain"` event to `log.jsonl` (audit fields `exit_reason: "normal"`, `exit_code: <int>`, `escalated: false`); `fsync` log.
5. Per A8: **unlink** `manifest.json` (§6.3.1). For clean exits, no tombstone is written.
6. Close / unlink UDS socket (POSIX) or release Named Pipe (Windows).
7. Supervisor process exits with code 0.

**Observable invariants** (post-state, after `child_reap_timeout_ms` budget elapses):

- `ps -p <child_pid>` returns no row (POSIX); `Get-Process -Id <child_pid>` raises ObjectNotFound (Windows).
- `ps -p <supervisor_pid>` returns no row.
- `~/.telepty/sessions/<sid>/manifest.json` returns ENOENT (per A8 unlink).
- `~/.telepty/sessions/<sid>/log.jsonl` exists and is readable (audit artifact per V1 ADR §3.5 + §7.4).
- No file with prefix `manifest.json.tmp` remains in the session directory.
- POSIX UDS socket inode at `supervisor.sock` is unlinked; Windows Named Pipe is closed.

**Wire frames emitted** (to subscribed clients before exit; `v:1` only per §6.4 r1):

```ndjson
{"v":1,"sid":"<sid>","kind":"output","data":"<final stdout/stderr>","trace_id":"<W3C>","seq":<int>}
{"v":1,"sid":"<sid>","kind":"shutdown_drain","trace_id":"<minted>","data":"{\"in_flight\":0,\"completed\":<N>,\"escalated\":false,\"exit_reason\":\"normal\",\"exit_code\":<int>}"}
```

After `shutdown_drain`, the supervisor closes all client WS / pipe sessions with code 1000 / `STATUS_PIPE_DISCONNECTED`.

### §1.2 Graceful shutdown (A.2)

**Trigger** — any of:

- orchestrator-issued `delete` frame with `force: false` (or `force` unset, default false per V1 ADR §6.2);
- orchestrator-issued `signal` frame with `signal: "SIGTERM"`;
- supervisor process itself receives SIGTERM (POSIX) / `CTRL_BREAK_EVENT` (Windows ConPTY console group);
- host shutdown signal (`launchd kickstart -k`, `systemctl stop`, `Stop-Service`).

**Supervisor behavior**:

1. **Enter `draining` state** — manifest atomic write `status: "draining"` (per V1 ADR §7.3 enum). Reject all *new* inject frames with `ERR_SHUTTING_DOWN` (V1 ADR §6.4) — `trace_id` propagation MUST mirror the rejected inject's `trace_id`.
2. **Drain in-flight ops** — wait until all currently-acked inject frames have been written to PTY master and acked, *or* `graceful_grace_ms` elapses, whichever comes first (per V1 ADR M36 — "graceful drain on SIGTERM, flush log, ack in-flight, write final manifest entry, exit").
3. **Forward signal to child**:
   - **POSIX**: `kill(-pgid, SIGTERM)` — process-group-scoped (see §3.1 process group rationale). The PTY child runs in its own pgrp via `setsid()` at spawn.
   - **Windows ConPTY**: `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, console_group_id)` — Windows **observable parity** for POSIX SIGTERM-to-pgrp (NOT primitive equivalence per §3.2.3 / §3.5: control events are handler-based, not POSIX signals; the child MAY ignore in either OS). The supervisor created the ConPTY with `CREATE_NEW_PROCESS_GROUP` and owns the console group ID; see §3.2.4 for the console-attachment caveat (supervisor may need `AttachConsole`/`FreeConsole` toggle from a service/daemon context).
4. **Wait for child reap** — up to `graceful_grace_ms` total (combined with step 2). If child exits during this window, transition to A.1 normal termination.
5. **Escalate on timeout** — if `graceful_grace_ms` elapses with the child still alive, the supervisor MUST escalate to forced kill per §1.3 step 3 (SIGKILL / job termination). This is the **graceful-to-forced escalation contract**.
6. **Final `shutdown_drain` log event** — record `in_flight: <N_unacked>, completed: <N_acked>, escalated: <bool>, exit_reason ∈ {signaled, killed}, exit_signal, exit_code`.
7. Per A8: **unlink** `manifest.json` (clean exit, §6.3.1) — even if escalation to forced fired (still a clean termination outcome, not a tombstone).

**Observable invariants** (post-state):

- Same as §1.1 observable invariants. `exit_reason ∈ {signaled, killed}` and `exit_signal` are recorded in `log.jsonl`, NOT in a residual manifest.

**Wire frames emitted** (`v:1` only):

```ndjson
{"v":1,"sid":"<sid>","kind":"signal","signal":"SIGTERM","trace_id":"<from-orch>"}
{"v":1,"sid":"<sid>","kind":"error","code":"ERR_SHUTTING_DOWN","trace_id":"<rejected-inject-trace>","data":"new injects rejected during drain"}
{"v":1,"sid":"<sid>","kind":"shutdown_drain","trace_id":"<minted>","data":"{\"in_flight\":<N>,\"completed\":<M>,\"escalated\":false,\"exit_reason\":\"signaled\",\"exit_signal\":\"SIGTERM\",\"exit_code\":<int>}"}
```

### §1.3 Forced kill (A.3)

**Trigger** — any of:

- orchestrator-issued `delete` frame with `force: true`;
- user CLI: `cmux close-workspace --force`, `telepty kill <sid> --force`;
- escalation from §1.2 step 5 (graceful timeout).

(r1 removed: "supervisor receives SIGKILL itself" — codex correctly flagged that a SIGKILLed supervisor cannot execute kill-gate behavior. Supervisor SIGKILL is handled by §1.5 crash recovery + §7.E mid-shutdown.)

**Supervisor behavior**:

1. **Skip drain** — no `graceful_grace_ms`. Manifest atomic write `status: "draining"` (transient marker for observers — even forced kill traverses `draining` to keep the state machine total).
2. **Reject in-flight injects** with `ERR_SHUTTING_DOWN` (per V1 ADR §6.4) — same trace propagation rule as §1.2.1.
3. **Forced child kill**:
   - **POSIX**: `kill(-pgid, SIGKILL)`. Cannot be caught by child. Process-group-scoped to handle child sub-spawns.
   - **Windows**: `TerminateJobObject(job_handle, exit_code=1)` — cascades to all descendants because the supervisor at spawn time set `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` on the job and assigned the child to it (see §3.2). This is the documented cross-OS equivalence (`TerminateJobObject` ≡ `kill(-pgid, SIGKILL)`).
4. **Reap child** — WNOHANG poll on spawn_blocking (§4.1.1 POSIX / §4.2 Windows) within `child_reap_timeout_ms`. If unkillable per §7.B–§7.C, write **tombstone manifest** (§6.3.2/§6.3.3) with `exit_reason: "unkillable"`, exit code 0.
5. **PTY teardown** — POSIX: kill-then-close with read-drain deadline (§5.1 Order A); Windows: drain-then-close-then-`ClosePseudoConsole` (§5.2).
6. Per A8 (clean exit `exit_reason ∈ {killed}`): write `shutdown_drain` log event then **unlink** `manifest.json`. For `unkillable`: write tombstone manifest, do NOT unlink (§6.3.2).
7. Supervisor process exits with code 0.

**Observable invariants** — same as §1.2 except:

- `exit_reason ∈ {killed, unkillable}`;
- `escalated: true` in `shutdown_drain` log if escalated from §1.2.

**Wire frames** — same shape as §1.2 with `signal: "SIGKILL"` (POSIX) / `"JOB_TERMINATE"` (Windows). The wire `signal` enum (V1 ADR §6.2 extended per §2.2 r1) accepts `{SIGINT (POSIX-only), SIGTERM, SIGHUP, SIGKILL, JOB_TERMINATE, CTRL_BREAK_EVENT}`; SIGINT on Windows returns `ERR_BAD_FRAME { reason: "signal_not_supported_on_windows" }` per codex Issue 5.

### §1.4 Parent death (orphan prevention) (A.4)

**Trigger**: supervisor detects orchestrator and/or relay disappearance. Detection sources (any one fires):

- TCP FIN / EOF on the orchestrator-bound WS / UDS (V1 ADR §3.7);
- relay heartbeat absent for more than `parent_death_grace_ms` (heartbeat = relay-emitted `ping` frame per V1 ADR §6.2, expected at least every `orphan_detect_interval_ms`);
- POSIX: `prctl(PR_SET_PDEATHSIG, SIGTERM)` fires (Linux only) — when the supervisor's parent PID disappears (Linux-specific; macOS uses `kqueue NOTE_EXIT` on parent PID; see §3.3); Windows: Job Object inherited from parent terminates → cascade kills supervisor.

**Q'''-bis policy decision** (per V1 ADR §3.3 supervisor responsibility "Drain in-flight ops on termination" + §17.3 r3 closure note + Article 9 독립):

> When orchestrator/relay disappears, the supervisor **does NOT self-terminate by default**. Each supervisor independently operable per Article 9. Orphan supervisors are **detected by the next live relay/orchestrator and either reattached or explicitly cleaned up via `delete` frame**.

This is the **(b) leave child running detached** option from the dispatch's three-way choice. Rationale:

- (a) self-terminate kills user work — unacceptable when a relay restart (§8.2 L3a) takes seconds;
- (c) reattach to new parent matches Q'''-bis L3a relay restart semantics — manifest is the SSOT, so a fresh relay reads existing manifests on startup (V1 ADR §8.2 L3a);
- (b) is the only choice consistent with Article 9 (each supervisor independently operable).

**Supervisor behavior** when orphan-detected:

1. Emit `kind:"error" code:"ERR_PARENT_GONE"` (new error code — see §9 amendment proposal) to any remaining listeners (best-effort).
2. Flush `log.jsonl` and `fsync()`. **Do not exit.**
3. Continue PTY ownership and manifest updates as normal (V1 ADR M32 — idle timeout default unlimited).
4. The next time a relay starts and reads `~/.telepty/sessions/<sid>/manifest.json`, the orphaned supervisor is rediscoverable via UDS at `manifest.ipc.path` — Article 9 self-evidence.

**Cleanup path** — orphaned supervisors persist until:

- the user issues `telepty delete <sid>` (`delete` frame, §1.2 graceful) or `telepty kill <sid> --force` (§1.3) — both terminate via §1.2 / §1.3 path and unlink manifest per A8;
- the host reboots (OS reaps every process);
- supervisor itself crashes (§1.5 crash recovery).

**Observable invariants** while orphaned (supervisor still running, so manifest is live, not unlinked):

- manifest `status: "ready"` (unchanged);
- manifest gains optional field `orphaned_since: <RFC3339>` set on orphan detection, cleared if a fresh parent reattaches.

**`orphan` is NOT a terminal `exit_reason`** (r1 — codex Issue 7 §6.3). Orphan is a transient marker on a live supervisor's manifest. When the orphan is eventually killed (via §1.2 / §1.3) or crashes (§1.5), the terminal `exit_reason` is `signaled` / `killed` / `crashed` / `unkillable` — not `orphan`.

**No wire frames** are emitted to the dead parent (M40 binary reachability — fail-fast, no queueing). The `ERR_PARENT_GONE` log entry is the audit record.

### §1.5 Crash recovery (A.5) — r1: orchestrator-driven respawn (Issue 6 + Q2 close)

**Trigger**: supervisor process itself crashes (panic, OOM kill, hardware fault, SIGKILL by user on the supervisor process).

**Consequence chain** (immediate, kernel-level):

- **POSIX**: PTY master FD is closed by kernel as supervisor process is reaped → child receives `SIGHUP` from PTY hangup → child default action terminates child. If the child has installed a SIGHUP handler, or has called `setsid()` itself, or has daemonized, it MAY survive the supervisor — see §6.7 escaped-descendant failure mode (r1 addition).
- **Windows**: supervisor crash → all handles owned by supervisor closed by kernel → Job Object handle close triggers `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` cascade (§3.2.1 + Issue 9) → all child descendants killed atomically. ConPTY HPCON closed → ConPTY pipes broken.

**Recovery responsibility — orchestrator-driven (r1 change from r0)**:

r0 assumed an OS service manager (launchd / systemd-user / Windows Service) would auto-restart per-session supervisors with the same `<sid>` via install-time registration. Codex Issue 6 correctly flagged this as unspec'd: dynamic per-session unit registration is not a property of install-time registration. r1 replaces this with **orchestrator-driven respawn**:

1. Orchestrator (or any client) periodically lists sessions via manifest discovery (V1 ADR §3.5).
2. Stale-supervisor detection: for each manifest with `status: "ready"` or `"draining"`, verify supervisor liveness via `kill(manifest.pid, 0)` (POSIX) / `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, …)` (Windows). On ESRCH / ERROR_INVALID_PARAMETER, the supervisor is gone.
3. **Detection writer**: the *first observer* that detects the dead supervisor atomically updates manifest: `status: "error"`, `exit_reason: "crashed"`, `crashed_at: <RFC3339>`. Atomic-rename semantics ensure no double-write race; if two observers race, the second sees the updated manifest and skips. This means the manifest preservation is **best-effort observer-driven**, not supervisor-self-written (the dead supervisor cannot write).
4. **Respawn decision is the orchestrator's** (control-tower pattern per V1 ADR §1.4). It reads manifest `cmd` + `cwd` + `env` and issues `telepty spawn` with the same `<sid>` and `restart_count: <prev + 1>`. The new supervisor writes a fresh manifest **replacing** the crashed-state manifest (atomic rename); the `log.jsonl` is preserved (append-only) and gains a `kind:"crash_recovered"` event recording `crashed_pid` and `restart_count`.

**Restart policy** (Q2 closed in r1):

- **Default = `"respawn"`** (orchestrator-initiated). Matches V1 ADR M34 "restart yields a fresh PTY + fresh child invocation under the same session id" + H1.
- **Opt-out = `"manual"`** (no automatic respawn; manifest remains in `status: "error"` until human intervention). Set via session config `kill_gate.restart_policy: "manual"`.
- (r0's `"tombstone"` default removed — codex correctly flagged direct M34 conflict.)

**The PTY is NOT recovered** — the §17.3 r3 trade-off stands. Child conversation state is lost on respawn; manifest + `log.jsonl` preserved as observability artifacts.

**No OS service manager dependency in Phase 1**: the spec does not require launchd / systemd-user / Windows Service unit registration. Such mechanisms remain an **optional** Phase 2+ ADR addition; orchestrator-driven respawn is the binding Phase 1 default.

**Detection-of-crash wire emission**: when the detection writer transitions manifest to `status: "error"` (step 3 above), it MAY emit `kind:"error" code:"ERR_SUPERVISOR_GONE"` to any of *its own* subscribed clients (best-effort; the dead supervisor's UDS clients are already disconnected via kernel pipe closure).

**Observable invariants** (post-state, after orchestrator respawn):

- `restart_policy: "respawn"` + respawn succeeded: new `pid` in manifest; `restart_count: ≥1`; `status: "ready"`; `log.jsonl` contains `crash_recovered` event.
- `restart_policy: "manual"` or respawn deferred: `status: "error"`, `exit_reason: "crashed"`. Persists until manual cleanup.

**Multi-child note**: helper subprocess kill-on-supervisor-crash is identical to POSIX pgrp / Windows Job Object cascade above. V1 ADR §3.3 supervisor "Non-responsibilities" implies helper count is typically 0; see §4.3.

---

## §2 Timeout matrix (scope B) — PROPOSALS

All defaults below are **proposals** flagged for orchestrator + cross-LLM debate per dispatch line 147 ("Defaults proposed in B (timeout matrix) are PROPOSALS — flag them clearly so orchestrator + cross-LLM can debate. Don't lock arbitrary numbers.").

### §2.1 Default values (PROPOSED)

| Parameter | Default (proposed) | Override source | Justification |
|---|---|---|---|
| `graceful_grace_ms` | **3000 ms** (**proposal — to be measured in Phase 1 sidecar spike**) | session config (manifest field `kill_gate.graceful_grace_ms`) | Aggressive vs general-purpose orchestrators (gemini: kubelet defaults to 30 s `terminationGracePeriodSeconds`). For interactive AI CLIs (claude / codex / gemini), 3 s is conjectured adequate for buffer flushes; **codex correctly flagged that no in-repo measurement of CLI flush times exists**. r1 marks default as proposal pending Phase 1 sidecar measurement. **Must be configurable** for long-running workloads (ML training children); gemini cites kubelet 30 s as alternative. Q1 remains open until Phase 1 measurement. |
| `child_reap_timeout_ms` | **2000 ms** | hard-coded in Phase 1 (Q4 — codex flags configurability binding for tests; revisit after Phase 1 D-state false-positive data) | After SIGKILL / `TerminateJobObject`, kernel typically reaps within ms. 2000 ms is a sanity ceiling; if exceeded, child is in D-state / Windows unkillable per §7.B–§7.C. Hard-coded in Phase 1 to prevent user misconfiguration hiding D-state hangs. |
| `reap_poll_ms` | **`child_reap_timeout_ms / 20`** (≥ 100 ms, ≤ 250 ms) | hard-coded | WNOHANG poll cadence inside the reap loop (§4.1.1). Tied explicitly to `child_reap_timeout_ms` per codex Issue 7.D. Ensures ≥ 20 poll cycles within the timeout window. |
| `orphan_detect_interval_ms` | **5000 ms** | hard-coded | Heartbeat polling interval. 5 s balances detection latency vs CPU/IPC overhead at N=100 supervisors (5 s × 100 = 20 polls/s ≈ negligible). |
| `parent_death_grace_ms` | **15000 ms** | session config | 3× `orphan_detect_interval_ms` — must miss 3 consecutive heartbeats before declaring orphan. Tolerates relay restart per V1 ADR §8.2 L3a (lazy spawn + fresh process) without false orphan declarations. |
| `manifest_sync_interval_ms` | **1000 ms** | hard-coded | Maximum staleness window between supervisor write and relay read of manifest. Used in §6 state invariant "Relay's view eventually consistent within `manifest_sync_interval_ms`". |
| `pty_read_drain_deadline_ms` | **500 ms** | hard-coded | After child exit / kill, supervisor keeps reading PTY master until EOF or this deadline before close. **r1 reframe** (codex Issue 5): not a "flush guarantee" but a bounded drain ceiling. POSIX-only; Windows uses `ClosePseudoConsole` ordering per §5.2. |

**Removed in r1**:

- `kill_force_after_ms` — duplicated `graceful_grace_ms` and was overrideable independently (codex). r1 collapses to invariant: **force kill begins immediately when `graceful_grace_ms` elapses** (no "extra grace before SIGKILL" period). Single knob, no override.
- `signal_dispatch_timeout_ms` — codex correctly noted this is not a meaningful invariant for `kill(2)` (the syscall either returns or errors). The intent ("adapter call must not block the event loop") is re-stated as the §0.3 single-thread reactor invariant: any syscall that could block runs on `spawn_blocking`. No timer required.
- `pty_read_drain_deadline_ms` r0 wording — renamed to `pty_read_drain_deadline_ms` with clarified semantics (read-until-EOF-or-deadline, not arbitrary sleep).

### §2.2 Cross-OS signal name mapping (r1 — codex Issue 5)

The `signal` kind wire frame carries a POSIX name (or one Windows-native label). Supervisor normalizes per:

| Wire `signal` value | POSIX action | Windows ConPTY action |
|---|---|---|
| `"SIGTERM"` | `kill(-pgid, SIGTERM)` | `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, <child_pid>)` |
| `"SIGINT"` | `kill(-pgid, SIGINT)` | **POSIX-only** — returns `ERR_BAD_FRAME { reason: "signal_not_supported_on_windows" }`. `CTRL_C_EVENT` is not group-targetable per [Microsoft][ms-ctrl]; spec does not provide a Windows path. |
| `"SIGHUP"` | `kill(-pgid, SIGHUP)` | normalized to `ClosePseudoConsole(hPC)` — PTY hangup-equivalent (no Job termination) |
| `"SIGKILL"` | `kill(-pgid, SIGKILL)` | `TerminateJobObject(job_handle, 1)` |
| `"CTRL_BREAK_EVENT"` | (Windows-only label) → on POSIX, normalized to `kill(-pgid, SIGTERM)` for cross-OS sender compat | direct `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, ...)` |
| `"JOB_TERMINATE"` | (Windows-only label) → on POSIX, normalized to `kill(-pgid, SIGKILL)` for cross-OS sender compat | direct `TerminateJobObject(...)` |

**Rejection rule**: any other `signal` value → `ERR_BAD_FRAME` per V1 ADR §6.4. The previous V1 ADR §6.2 enum `{SIGINT, SIGTERM, SIGHUP}` is **extended** to `{SIGINT (POSIX-only), SIGTERM, SIGHUP, SIGKILL, CTRL_BREAK_EVENT, JOB_TERMINATE}`; additive schema change per M38'.

### §2.3 Override mechanism

Session config values (`graceful_grace_ms`, `parent_death_grace_ms`, `restart_policy`) are written to the manifest at spawn time:

```json
"kill_gate": {
  "graceful_grace_ms": 3000,
  "parent_death_grace_ms": 15000,
  "restart_policy": "respawn"
}
```

(`kill_force_after_ms` removed in r1 — collapsed to invariant per §2.1 "Removed in r1" list. `restart_policy` default = `"respawn"` per Q2 r1 close.)

If absent at spawn, defaults from §2.1 apply. Mid-session override is **not supported in Phase 1** (would require a new `reconfigure` wire kind, deferred to Phase 2+).

### §2.4 Failed approach (excluded)

**Rejected**: per-host global default config file (`~/.telepty/kill-gate.toml`). Rejection rationale (Article 1 경량): adds discoverability surface and config-precedence rules. Manifest-only override is sufficient because spawn time is the only point where defaults need overriding for legitimate use cases (long-running ML training in the child → larger `graceful_grace_ms`).

---

## §3 Cross-OS behavior (scope C — Article 2 binding)

Article 2 requires identical observable behavior from orchestrator's POV regardless of host OS. This section enumerates the per-OS mechanism for each behavior; §3.5 cross-references the equivalence map.

### §3.1 POSIX (Linux + macOS)

**Process group setup at spawn**:

`portable-pty` internally calls `setsid()` and sets the controlling tty during slave-side setup on Unix (see [portable-pty source][pp-unix]); the child therefore becomes its own session leader / pgrp leader automatically, and sub-spawns (e.g., claude → bash → grep) inherit the pgrp. The supervisor MUST capture the child's pid (= pgid) at spawn return and store it for pgrp-scoped signaling.

The public `portable-pty::CommandBuilder` does not expose a `pre_exec` hook (see <https://docs.rs/portable-pty/latest/portable_pty/cmdbuilder/struct.CommandBuilder.html>); the spec relies on portable-pty's internal `setsid()` behavior — no additional pre-exec is required.

[pp-unix]: https://github.com/wez/wezterm/blob/main/pty/src/unix.rs "portable-pty unix slave spawn (cited 2026-05-12)"

**Signal delivery**:

- `kill(-pgid, SIGTERM)` — sent to all processes in pgrp. Negative pid argument is the documented POSIX semantics for pgrp-scoped kill.
- `kill(-pgid, SIGKILL)` — same, escalation path.
- `kill(-pgid, SIGHUP)` — used implicitly when supervisor closes PTY master before kill (PTY kernel driver issues SIGHUP to the controlling pgrp).

**Reap**: `waitpid(child_pid, &status, 0)` blocking, or `waitpid(child_pid, &status, WNOHANG)` polling. After `child_reap_timeout_ms` budget exhausted, switch to `WNOHANG` poll; if still ECHILD/0 returns, treat as unkillable per §1.3.4.

**SIGCHLD handling**: per §4.1 r1, the supervisor reaps **only its direct child**. Sub-children spawned by the L3 child (e.g., claude → bash → grep) are reparented to PID 1 on POSIX (or to a Linux subreaper if §4.1.3 opt-in is enabled) and reaped by the new parent — the supervisor MUST NOT install a `waitpid(-1, …, WNOHANG)` reaper for grandchildren, as that contradicts the §4.1 direct-child-only ownership model and §4 r1's pgrp-liveness verification path. tokio's `Child::wait()` covers the direct child's terminal status; no separate SIGCHLD reaper for non-direct descendants is required (informational note: the optional `prctl PR_SET_CHILD_SUBREAPER` Linux-only opt-in per §4.1.3 changes this only for orphaned descendants after the L3 child exits, and the supervisor still reaps them as direct children at that point — not as grandchildren).

**PTY master/slave drop ordering** (per portable-pty design, RFC 1857 stable drop): in `PtyPair`, slave is dropped first, then master. The supervisor SHOULD explicitly `drop(pty.slave)` after spawn (slave is held only briefly for the child's stdio dup); master remains owned by supervisor until kill completes.

**Linux-specific (parent death)**: `prctl PR_SET_PDEATHSIG` is **REJECTED** in r1 (Q3 closure, §10) and per §3.5 row 6 — do NOT install it. Two binding reasons: (1) the only deliverable signal would be `SIGTERM`, which §1.2 binds to *graceful shutdown*, but §1.4 binds parent death to *do NOT self-terminate* — the two policies are incompatible; (2) macOS has no `PR_SET_PDEATHSIG` equivalent, so the mechanism is non-portable and would require POSIX/Linux-only forks of the supervisor's startup path. The binding parent-death detection mechanism is the heartbeat poll per §2.1 `parent_death_grace_ms`; macOS MAY additionally use `kqueue NOTE_EXIT` per §3.5 (notification-only — supervisor still does NOT self-terminate per §1.4).

**macOS-specific (parent death)**: `kqueue` with `EVFILT_PROC, NOTE_EXIT` on parent PID. Supervisor SHOULD register this on macOS to obtain immediate notification of parent death (vs heartbeat polling).

### §3.2 Windows native (ConPTY) — custom adapter required

Stock `portable-pty` 0.9.0 ConPTY spawning calls `CreateProcessW` with `EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT` only; it does **not** pass `CREATE_NEW_PROCESS_GROUP`, does **not** create or assign a Job Object, and does **not** expose `PROCESS_INFORMATION`, the Job Object handle, the HPCON handle, or creation flags through any public trait. §0.3 mandates a custom adapter; this section enumerates its surface.

#### §3.2.1 Required custom-adapter surface (binding)

The Windows adapter MUST expose to the kill gate:

1. **`PROCESS_INFORMATION` of the direct child** (`hProcess`, `hThread`, `dwProcessId`) for reap + `WaitForSingleObject`.
2. **Job Object `HANDLE`** owned by the supervisor, created with `bInheritHandles = FALSE` (gemini Issue 9: prevents child inheriting the job handle and keeping it open across supervisor crash) — see [Microsoft Job Objects][js-jobs].
3. **`CreateProcess` creation flags** override (`CREATE_NEW_PROCESS_GROUP`, `CREATE_SUSPENDED`, `EXTENDED_STARTUPINFO_PRESENT`) chosen by the adapter, not by `portable-pty`.
4. **`STARTUPINFOEX` attribute list** with at least `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` (mandatory for ConPTY per Microsoft) and, where available (Win 10 build 1809+), `PROC_THREAD_ATTRIBUTE_JOB_LIST`.
5. **HPCON handle** for `ClosePseudoConsole` ordering control (see §5.2).
6. **Child console group id** for `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, <gid>)`. The group id equals the child's process id when `CREATE_NEW_PROCESS_GROUP` is used and the child has not called `SetProcessGroupId` itself.

If `portable-pty` upstream adds these (e.g., via a `WinChildKillerExt` trait), the spec is satisfied without a fork. Otherwise a Windows-only adapter crate is required.

#### §3.2.2 Atomic spawn-and-attach (race-free Job assignment)

There is a known Windows race: if the supervisor crashes between `CreateProcess` and `AssignProcessToJobObject`, the child runs **outside** the Job Object and is not killed when the supervisor dies (gemini Issue 9 + Industry-Comparison #2). r1 mandates one of two atomic patterns:

**Pattern J1 — `PROC_THREAD_ATTRIBUTE_JOB_LIST` (preferred, Windows 10 build 1809+)**:

```rust
let job_handle = CreateJobObjectW(/* lpJobAttributes */ None, /* lpName */ None)?;
//   ^ default SECURITY_ATTRIBUTES with bInheritHandle = FALSE (binding per Issue 9)
let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
    | JOB_OBJECT_LIMIT_BREAKAWAY_OK;  // documented; not strictly required
SetInformationJobObject(job_handle, JobObjectExtendedLimitInformation, &info)?;

// Build STARTUPINFOEX with attribute list containing PROC_THREAD_ATTRIBUTE_JOB_LIST
let job_list = [job_handle];
UpdateProcThreadAttribute(attr_list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
                          job_list.as_ptr() as _, size_of::<HANDLE>(),
                          null_mut(), null_mut())?;
// + PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE on the same attribute list

CreateProcessW(/* lpApplicationName */ null,
               /* lpCommandLine */ command_line,
               /* lpProcessAttributes */ null, /* lpThreadAttributes */ null,
               /* bInheritHandles */ FALSE,
               EXTENDED_STARTUPINFO_PRESENT | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT,
               env, cwd, &startup_info_ex.StartupInfo, &mut pi)?;
// Child is already in the job; no race window.
```

**Pattern J2 — `CREATE_SUSPENDED` fallback (older Windows)**:

```rust
CreateProcessW(..., CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP | EXTENDED_STARTUPINFO_PRESENT, ..., &mut pi)?;
AssignProcessToJobObject(job_handle, pi.hProcess)?;  // race-free: child not yet running
ResumeThread(pi.hThread)?;
```

The adapter MUST attempt J1 first and fall back to J2 only if `PROC_THREAD_ATTRIBUTE_JOB_LIST` is unavailable at runtime (detected via Windows build number ≥ 17763). Tested by §8.A.W-jobrace (Issue 9).

#### §3.2.3 Signal-equivalent dispatch (observable parity, NOT primitive equivalence)

Per codex Issue 5 + §3.5 r1 wording: these are **observable parity mechanisms**, not semantic equivalents. Listed by observable kill-gate outcome:

| Kill gate outcome | Windows mechanism | Notes |
|---|---|---|
| Graceful (allow child to exit cleanly) | `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, <child_pid>)` | Group-targetable per Microsoft docs. Caller must share child's console or use `AttachConsole`-then-`FreeConsole` helper-console mechanism (adapter responsibility; see §3.2.4). |
| Forced (tree kill, uncatchable) | `TerminateJobObject(job_handle, exit_code=1)` | Cascades to all processes in the job. Not equivalent to `SIGKILL` semantics — Job Object cascade observes breakaway flags and nested-job containment per [Microsoft Job Objects][js-jobs]. |
| Hangup (terminal disappearance) | `ClosePseudoConsole(hPC)` | Terminating teardown primitive — see §5.2 for drain/deadlock constraints. |
| No equivalent | `CTRL_C_EVENT` group-targeted | **Removed** in r1: Microsoft documents that `CTRL_C_EVENT` cannot be group-targeted; if `dwProcessGroupId` is nonzero, the call may succeed but targets do not receive the event. The wire `signal: "SIGINT"` is therefore POSIX-only — see §2.2 and §3.5 r1. |

#### §3.2.4 Console attachment for `GenerateConsoleCtrlEvent`

`GenerateConsoleCtrlEvent` requires the caller and target to share a console. For a service / daemon supervisor running without an attached console, the adapter MUST either:

- **(a)** attach to the child's console via `AttachConsole(child_pid)` immediately before the call, then `FreeConsole()` after (caveat: only one console per process at a time — must not interfere with the ConPTY HPCON); or
- **(b)** spawn an intermediary helper process that owns the console and proxies the `CTRL_BREAK_EVENT` request.

Pattern (b) adds a process. Pattern (a) is preferred. Phase 1 sidecar spike measures whether the `AttachConsole`/`FreeConsole` toggle interferes with the active HPCON; if it does, fall back to (b).

#### §3.2.5 Reap (Windows)

`WaitForSingleObject(child_handle, child_reap_timeout_ms)` MUST run on `spawn_blocking` per §0.3 invariant (`WaitForSingleObject(INFINITE)` blocks indefinitely; even with a finite timeout, the call ties up the calling thread). On `WAIT_OBJECT_0`, call `GetExitCodeProcess(child_handle, &mut exit_code)`. On `WAIT_TIMEOUT`, treat as unkillable per §1.3.4 / §7.B.

**No SIGCHLD equivalent needed** — Job Object cascade handles descendants atomically. Reaping non-direct descendants is not required because they exit when the job is terminated.

#### §3.2.6 Parent death detection (Windows)

The supervisor process is NOT assumed to be assigned to a parent's Job Object (per Issue 6 r1: no OS service manager dependency). Detection is heartbeat-based per §2.1 `parent_death_grace_ms` + an optional `WaitForSingleObject(parent_handle)` on a `spawn_blocking` task if the orchestrator passes its PID at spawn time.

[js-jobs]: https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects "Job Objects — Win32 apps | Microsoft Learn (cited 2026-05-10)"
[ms-ctrl]: https://learn.microsoft.com/en-us/windows/console/generateconsolectrlevent "GenerateConsoleCtrlEvent — Microsoft Learn (cited 2026-05-12)"

### §3.3 WSL

WSL uses the Linux IPC and signal model inside the WSL boundary (V1 ADR §3.7). Per V1 ADR §13.1 acceptance scope, **WSL is NOT a separate kill-gate acceptance target** — it inherits Linux semantics. Spec rejects WSL as a Windows native parity substitute (per V1 ADR §17.10).

### §3.4 Cross-OS uniformity check (Article 2 binding)

Per V1 ADR M25 (protocol contract test is binding; per-OS adapter implementation is free), this spec mandates that the kill gate adapters MUST pass the always-on CI test bucket (§8.A) on:

1. macOS arm64 (native);
2. Linux x86_64/glibc (native);
3. Windows native (no WSL substitution per V1 ADR §17.10).

If any of (1)–(3) fails the §8.A bucket, the affected platform is **not green** for Phase 1 sidecar spike entry. §8.B (controlled-host) and §8.C (destructive) buckets are non-blocking for PR CI per Issue 8.

### §3.5 POSIX / Windows observable parity (r1 reframed — codex Issue 5)

r0 claimed "all behaviors must mirror" — codex correctly flagged this as overclaim. Cross-OS uniformity is defined by **observable parity assertions**, not primitive equivalence. Two OSes pass the contract iff an external observer sees the same end state (manifest, process-table emptiness, exit_reason class, emitted errors) — the internal mechanisms differ and that is acceptable.

| Observable assertion | POSIX mechanism | Windows mechanism | Notes |
|---|---|---|---|
| Child spawned in isolated process tree | `portable-pty` internal `setsid()` | Custom adapter §3.2: `CREATE_NEW_PROCESS_GROUP` + Job Object via atomic spawn-and-attach (§3.2.2) | child's id = pgid (POSIX) / id = console-group-id (Windows when CNPG used) |
| Graceful kill request reaches child (catchable) | `kill(-pgid, SIGTERM)` | `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, <child_pid>)` | Best-observable equivalent — Windows control events are handler-based, not POSIX signals. Child MAY ignore in either OS. |
| Forced tree termination (uncatchable) | `kill(-pgid, SIGKILL)` | `TerminateJobObject(job_handle, 1)` | Caveat (codex): Job Object cascade observes breakaway flags and nested-job semantics per [Microsoft Job Objects][js-jobs]; spec recommends rejecting nested-job breakaway via `JOB_OBJECT_LIMIT_BREAKAWAY_OK` only when explicitly required. |
| Terminal-disappearance signal to child | `close(pty_master_fd)` → kernel SIGHUP to controlling pgrp | `ClosePseudoConsole(hPC)` → child's pipe ops fail with `ERROR_BROKEN_PIPE` | See §5.2 for `ClosePseudoConsole` drain/deadlock constraints. |
| Direct-child exit code observable | `waitpid(child_pid, &s, 0)` on spawn_blocking | `WaitForSingleObject + GetExitCodeProcess` on spawn_blocking | r1: both run on `spawn_blocking` per §0.3. |
| Parent death detection | heartbeat poll (default); optional macOS `kqueue NOTE_EXIT` on parent PID | heartbeat poll (default); optional `WaitForSingleObject(parent_handle)` on spawn_blocking | Linux `PR_SET_PDEATHSIG` is **rejected** in r1 — closes Q3 (conflicts with §1.4 "do not self-terminate on parent death"). |
| No zombie direct child after exit | SIGCHLD handler + `waitpid(child_pid, &s, WNOHANG)` polling | Job Object cascade — no explicit reap loop for descendants | **r1**: supervisor reaps only its direct child (codex Issue 2). Grandchildren are NOT reaped by supervisor — see §4.1 r1 rewrite. |
| Atomic manifest write | `write tmp + fsync + rename + fsync_dir` | `WriteFile + FlushFileBuffers + MoveFileExW(MOVEFILE_REPLACE_EXISTING + MOVEFILE_WRITE_THROUGH)` | reader never sees partial manifest |
| Supervisor restart on crash | r1: **orchestrator-driven respawn** (not OS service manager) — see §1.5 r1 | r1: same | Codex Issue 6 + Q2 close: dynamic per-session unit registration is out of scope. |

**Removed in r1**: `SIGINT ↔ CTRL_C_EVENT` row. `CTRL_C_EVENT` cannot be group-targeted per [Microsoft GenerateConsoleCtrlEvent][ms-ctrl]; if `dwProcessGroupId` is nonzero, the call returns success but targets do not receive the event. Wire `signal: "SIGINT"` is POSIX-only — on Windows it returns `ERR_BAD_FRAME` with reason `signal_not_supported`.

---

## §4 Child reaping (scope D) — r1 rewrite (codex Issue 2 + Issue 4)

### §4.0 Non-cancellable terminal state (r1 invariant, codex Issue 4)

Once the supervisor enters the kill gate (`status: "draining"` per §1.2 / §1.3), the kill gate is **non-cancellable terminal state**: it MUST run to completion or escape via §7 failure modes — it cannot be aborted by a tokio runtime drop, a parent cancellation, or a subsequent inbound frame.

Implementation: the kill gate runs as a top-level task held by a `JoinHandle` that the supervisor's `main` keeps until the kill gate transitions to `stopped` / `error`. The tokio runtime is **shutdown_background**-ed only after this handle completes. No `tokio::select!` arm above the kill gate may early-return — drop guards (`scopeguard`) enforce manifest finalization on panic / cancellation.

### §4.1 POSIX reaping — direct child only

**r1 correction** (codex Issue 2): the supervisor reaps **only its direct child**. The L3 child's grandchildren (e.g., claude → bash → grep) are NOT reaped by the supervisor. They are direct children of the L3 child; their parent owns their reap. After the supervisor signals the pgrp and the L3 child dies, grandchildren are reparented to PID 1 (`init`) on POSIX (or to the Linux subreaper if one is set — see §4.1.3) and reaped there. The supervisor's responsibility is to **verify no live processes remain in the targeted pgrp** after `kill(-pgid, SIGKILL)`; it does not claim grandchildren as its own.

#### §4.1.1 Direct-child reap (the only reap the supervisor performs)

```rust
// All `waitpid` runs on spawn_blocking per §0.3 invariant (no INFINITE waits on reactor).
let exit_status = tokio::task::spawn_blocking(move || {
    let mut status = 0i32;
    // try_wait-style polling driven by an external timeout:
    loop {
        let r = unsafe { libc::waitpid(child_pid, &mut status, libc::WNOHANG) };
        match r {
            0 => std::thread::sleep(Duration::from_millis(POLL_MS)),  // alive, sleep + retry
            pid if pid == child_pid => return Ok(status),
            -1 => {
                if errno() == libc::EINTR { continue; }
                return Err(io::Error::last_os_error());
            }
            _ => unreachable!(),
        }
    }
}).await?;
```

The poll cadence `POLL_MS` is bounded by `child_reap_timeout_ms / 20` (≥ 100 ms minimum). Tied explicitly to §2.1 `child_reap_timeout_ms` — codex Issue 7.D.

**Why not `waitpid(child_pid, &status, 0)` (blocking)?** Blocking `waitpid` cannot be interrupted by tokio's timeout machinery; combined with the spawn_blocking thread, it would tie up a thread until the child exits, defeating the timeout budget. WNOHANG polling is bounded by the timeout.

**Why not `tokio::process::Child::wait`?** The supervisor spawns the child via `portable-pty`, which returns a `Box<dyn portable_pty::Child>` (synchronous trait), not a `tokio::process::Child`. The two are not interchangeable (codex Issue 4). `portable-pty::Child::try_wait` and `kill` are both synchronous and MUST run on `spawn_blocking`.

#### §4.1.2 Sub-children (grandchildren) — NOT reaped by supervisor

Per Issue 2: `waitpid(-1, WNOHANG)` on the supervisor only reaps processes whose parent is the supervisor. Grandchildren's parent is the L3 child; once the L3 child dies, grandchildren are reparented to `init` (PID 1) and reaped there. The supervisor MUST NOT call `waitpid(-1, ...)` expecting to reap grandchildren — that is wrong on POSIX.

After `kill(-pgid, SIGKILL)`, the supervisor verifies no live processes remain in the pgrp via:

```rust
// POSIX pgrp liveness check (best-effort observable parity per §3.5):
let r = unsafe { libc::killpg(pgid, 0) };  // sig=0: existence test, no signal sent
match (r, errno()) {
    (0, _) => {/* at least one process in pgrp still exists */}
    (-1, libc::ESRCH) => {/* pgrp empty — desired post-kill state */}
    _ => {/* permission error — unexpected */}
}
```

If the pgrp is not empty within `child_reap_timeout_ms`, log `kind:"warn" code:"ERR_PGRP_LIVE_AFTER_KILL"` (advisory; not blocking the kill gate completion). Escaped-descendant policy is §6.7 (r1 addition).

#### §4.1.3 Linux `PR_SET_CHILD_SUBREAPER` (optional enhancement)

Linux-only. If the supervisor calls `prctl(PR_SET_CHILD_SUBREAPER, 1)` at startup, then orphaned grandchildren (after L3 child death) are reparented **to the supervisor** instead of to PID 1. The supervisor can then reap them via the SIGCHLD + `waitpid(-1, WNOHANG)` loop.

**Spec position**: Phase 1 default is **disabled** (no subreaper). The supervisor reaps only its direct child. Subreaper is a Phase 1+ enhancement that supervisor implementations MAY enable on Linux if measurements show grandchild zombies escape via PID-1 reaping latency. macOS has no equivalent; Windows uses Job Object cascade and does not need subreaper semantics.

#### §4.1.4 SIGCHLD handling during shutdown

The supervisor's SIGCHLD handler (via `tokio::signal::unix::signal(SignalKind::child())`) MUST remain registered throughout the kill gate. Tokio coalesces SIGCHLD into a notification stream; the handler reaps only the direct child via the loop in §4.1.1 (NOT `waitpid(-1, ...)`).

### §4.2 Windows reaping (r1 — runs on spawn_blocking)

Job Object handles cascade automatically — no explicit reap loop for descendants. Supervisor reaps only the direct child, runs on spawn_blocking:

```rust
let exit_code = tokio::task::spawn_blocking(move || {
    let r = unsafe { WaitForSingleObject(child_handle, child_reap_timeout_ms_u32) };
    if r != WAIT_OBJECT_0 { return Err(Error::Timeout); }
    let mut code = 0u32;
    unsafe { GetExitCodeProcess(child_handle, &mut code) };
    Ok(code)
}).await??;

unsafe {
    CloseHandle(child_handle);
    CloseHandle(job_handle);  // idempotent with prior TerminateJobObject
}
```

`CloseHandle(job_handle)` triggers `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` if not already triggered by `TerminateJobObject` — idempotent. Both calls are safe.

### §4.3 Multi-child reap order

If the supervisor spawned helper subprocesses (per-session log shipper, optional V4 inbox writer in Phase 2+), they MUST be killed and reaped **before** the L3 child. The supervisor's "Non-responsibilities" in V1 ADR §3.3 implies helper count is typically 0; spec position is helpers ≤ 3 if present (Q9 r1 — informational; binding only if helpers materialize in Phase 1).

**Order** (per stage in §1.2 step 3 / §1.3 step 3):

1. helper subprocesses (each reap on spawn_blocking, budget = `(graceful_grace_ms / 4) / N` per helper);
2. L3 child (reaps remaining grace budget, ≥ 75% of `graceful_grace_ms`);
3. PTY master close (POSIX) / `ClosePseudoConsole` (Windows) per §5;
4. supervisor exits.

If helper count > 3 exists at Phase 1 ship, the kill-gate spec MUST be amended (Article 1 경량 — implies helpers should not exist).

### §4.4 Timeout budget walk-through (worked example)

`graceful_grace_ms = 3000 ms`, 0 helpers, child claude:

| Elapsed | Action |
|---|---|
| 0 ms | `delete force:false` arrives; supervisor enters `draining`; `kill(-pgid, SIGTERM)` (spawn_blocking thread issues syscall) |
| 100 ms | claude flushes API call, prints `^C\n`, exits with code 130 |
| 100 ms | spawn_blocking WNOHANG poll observes child exit; `exit_reason: "signaled"`, `exit_signal: "SIGTERM"`, `exit_code: 130` |
| 100 ms | manifest atomic write (`status: "stopped"`); per A8 (Issue 3 align): manifest **unlinked** after final write of audit fields to `log.jsonl` |
| 105 ms | UDS close; supervisor process exit |

Same setup, claude stuck on `model:` API hang:

| Elapsed | Action |
|---|---|
| 0 ms | SIGTERM sent (via spawn_blocking) |
| 0–3000 ms | child unresponsive (HTTP keepalive blocked); WNOHANG poll returns 0 repeatedly at POLL_MS cadence |
| 3000 ms | `graceful_grace_ms` exhausted; escalate per §1.2.5 → §1.3.3 |
| 3000 ms | `kill(-pgid, SIGKILL)` (spawn_blocking) |
| 3010 ms | child reaped; `exit_reason: "killed"`, `exit_signal: "SIGKILL"` |
| 3010 ms | per A8: manifest unlinked; supervisor exits |

---

## §5 PTY-specific concerns (scope E)

### §5.1 POSIX master close vs child kill ordering

Two viable orderings exist:

**Order A — kill first, master close after reap**:

1. `kill(-pgid, SIGTERM)` — child receives signal directly.
2. `child.wait()` reap.
3. `drop(pty.master)` — closes master FD.

**Order B — master close first, child gets SIGHUP via PTY**:

1. `drop(pty.master)` — kernel issues SIGHUP to pgrp.
2. `child.wait()` reap.
3. (optional escalation: explicit `kill(-pgid, SIGKILL)` if SIGHUP is ignored).

**Spec choice: Order A** with `pty_read_drain_deadline_ms = 500 ms` between reap and master close.

**Rationale**:

- portable-pty's child-kill API is `ChildKiller::kill` (the `MasterPty` trait does NOT expose a `kill` method — see [portable-pty ChildKiller][pp-childkiller] and §12.3 r1 corrected note); on Unix `ChildKiller::kill` sends SIGHUP first, then falls back to `std::process::Child::kill` which targets the direct pid (NOT pgrp-targeted) — neither is the right primitive for graceful kill of the child's pgrp. This means relying on `ChildKiller::kill` for the graceful path conflates two signal paths (SIGHUP from kernel + portable-pty SIGHUP) and misses pgrp scope, creating an ordering bug if the child's signal handler differentiates them.
- Order A makes the signal explicit and observable in the wire frame `signal: "SIGTERM"` — orchestrator knows what was sent.
- The 500 ms `pty_read_drain_deadline_ms` allows kernel to flush PTY buffers (final stdout/stderr from child arrives on supervisor's read side) before close.
- Order A is what tokio-process-tools' `terminate(sigterm_timeout, sigkill_timeout)` pattern implements (see [tokio-process-tools][tpt]).

[pp-childkiller]: https://docs.rs/portable-pty/latest/portable_pty/trait.ChildKiller.html "ChildKiller in portable_pty (cited 2026-05-12, codex r2 stale-API correction)"
[tpt]: https://docs.rs/tokio-process-tools/latest/tokio_process_tools/ "tokio_process_tools (cited 2026-05-10)"

**Important**: `portable-pty::ChildKiller::kill` MUST NOT be relied on for the graceful path because (a) it sends SIGHUP first, not SIGTERM, and (b) its `std::process::Child::kill` fallback is direct-pid-targeted, not pgrp-targeted. Spec mandates direct `nix::sys::signal::kill(Pid::from_raw(-pgid), Signal::SIGTERM)` for the graceful step (pgrp-scoped via the negative pid argument).

### §5.2 Windows ConPTY close cascade (r1 — codex Issue 5)

`ClosePseudoConsole(hPC)` is a **terminating teardown primitive**, not merely a broken-pipe signal. Per [Microsoft "Creating a Pseudoconsole Session"][ms-conpty]:

- it stops attached character-mode applications and the entire attached tree;
- it **can deadlock** unless the supervisor has drained the ConPTY output pipes before calling close;
- it closes both ConPTY input read handle and output write handle synchronously.

**Required ordering** (drain → close):

1. After child exit / kill, supervisor reads remaining ConPTY output pipe bytes until EOF or `pty_read_drain_deadline_ms` elapses;
2. `CloseHandle(hOutputRead)` and `CloseHandle(hInputWrite)` (the supervisor-side ConPTY pipe endpoints);
3. `ClosePseudoConsole(hPC)`;
4. `CloseHandle(job_handle)` — triggers `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` if not already terminated;
5. `CloseHandle(child_handle)`.

If the drain step is skipped, `ClosePseudoConsole` may block indefinitely waiting for the consumer to read pending output — a known footgun. Phase 1 sidecar spike validates the drain deadline (proposal: 500 ms).

**Full Windows kill-gate sequence**:

1. `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, gid)` — graceful (§3.2.4 console attachment caveat applies);
2. `WaitForSingleObject(child_handle, graceful_grace_ms)` on spawn_blocking;
3. on timeout: `TerminateJobObject(job, 1)` — forced;
4. drain ConPTY output pipe (≤ `pty_read_drain_deadline_ms`);
5. ordered close per the list above.

Order matches POSIX Order A.

[ms-conpty]: https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session "Creating a Pseudoconsole Session — Microsoft Learn (cited 2026-05-12)"

### §5.3 SIGPIPE / EIO race (master close ↔ child write)

If child writes to stdout exactly as master closes:

- **POSIX**: child receives SIGPIPE (default action: terminate). If child has a SIGPIPE handler (e.g., bash sets SIG_IGN), child's `write(2)` returns EPIPE.
- **Windows**: child's `WriteFile` returns `ERROR_BROKEN_PIPE` (109) — same outcome regardless of handler.

**Spec mandate**: this race is **acceptable** behavior. The 500 ms `pty_read_drain_deadline_ms` minimizes occurrence, but cannot eliminate it. Children that need clean stdout flush must do so before exiting graceful (step 1 of §1.2). Documented behavior, no further mitigation required.

### §5.4 `PtyPair` slave drop

The supervisor SHOULD `drop(pty.slave)` immediately after spawn (slave is only needed to dup to child's stdio). This is per portable-pty's documented `PtyPair` field ordering: slave first, master second (RFC 1857 stable drop, see [PtyPair docs][pp-pair]). Holding slave alive in the supervisor process leaks an FD and can interfere with PTY hangup propagation.

[pp-pair]: https://docs.rs/portable-pty/latest/portable_pty/struct.PtyPair.html "PtyPair — docs.rs (cited 2026-05-12)"

### §5.5 Three distinct EOFs / closes (r1 — codex Issue 5)

r0 conflated three separate PTY teardown events. r1 distinguishes:

| Event | POSIX trigger | Windows trigger | Observable to child |
|---|---|---|---|
| **Writer EOF** | `drop(pty.master_writer)` (or `MasterPty::take_writer` then drop) → kernel sends EOF on child stdin read | `CloseHandle(hInputWrite)` → child stdin read returns `ERROR_BROKEN_PIPE` | child's `stdin.read()` returns 0 / EOF / EOF-like |
| **Master read-side EOF** | child exits → kernel closes its end of PTY → master `read(2)` returns 0 | child exit → ConPTY pipe closes → master `ReadFile` returns 0 | supervisor's reader observes EOF; can drain remaining buffered bytes before close |
| **PTY object teardown** | `drop(pty.master)` → PTY destroyed, kernel SIGHUPs the controlling pgrp | `ClosePseudoConsole(hPC)` → entire attached tree stops | child's terminal disappears (controlling tty gone) |

The supervisor uses these distinctly:
- Writer EOF is **not** part of the kill gate (it's an `inject`-side concern for "EOF-to-stdin" patterns).
- Master read-side EOF is the **drain boundary** before close (§5.2 step 4).
- PTY object teardown is the **terminal step** (§5.2 step 5 / Order A step 3 POSIX).

---

## §6 State invariants after kill (scope F)

After the kill gate completes for a session (i.e., supervisor process has exited or transitioned to `status: "stopped"` / `"error"`), the following MUST hold:

### §6.1 Process state

- **POSIX**: `ps -p <child_pid>` returns no row (or `Z` zombie row, reaped by init within 1 s after L3 child exit). `ps -p <supervisor_pid>` returns no row. **Pgrp liveness check**: `killpg(pgid, 0)` returns -1 with ESRCH (pgrp empty). **r1 exemption** (codex Issue 7.B): when `exit_reason == "unkillable"`, this invariant is **waived** — the abandoned child/pgrp remains for operator action; supervisor exits normally; manifest preserved per §6.3 unkillable override.
- **Windows**: `Get-Process -Id <child_pid>` raises `ObjectNotFound`. `Get-Process -Id <supervisor_pid>` raises `ObjectNotFound`. The Job Object is gone (verifiable via `OpenJobObjectW(JOB_OBJECT_QUERY, FALSE, name)` returning `ERROR_FILE_NOT_FOUND` if named; for unnamed jobs, handle closure is implicit at supervisor exit). Same unkillable exemption applies.

### §6.2 IPC endpoint state (r1 — codex Issue lower-sev)

r0 used `lsof -p <supervisor_pid>` post-exit as an FD assertion — codex correctly noted this is not useful after process exit (kernel has already reaped FDs). r1 replaces with **observable IPC endpoint state**:

- **POSIX**:
  - **Stale socket inode**: `stat(~/.telepty/sessions/<sid>/supervisor.sock)` should return ENOENT (supervisor unlinked the socket on clean exit). If the inode remains (supervisor SIGKILLed mid-shutdown), the cleanup is **best-effort observer-driven** (orchestrator / next list operation `unlink()`s after verifying `kill(manifest.pid, 0) == ESRCH`).
  - **Live-pid check**: `kill(manifest.pid, 0)` returns ESRCH. This is the **authoritative liveness signal** — do not trust socket path alone.
- **Windows**:
  - **Named Pipe**: `\\.\pipe\telepty-<sid>` no longer enumerated by `Get-ChildItem \\.\pipe\`. Named Pipe instances are closed by kernel when the last server-side handle closes; no inode-like leak.
  - **Live-pid check**: `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, manifest.pid)` returns `INVALID_HANDLE_VALUE` with `GetLastError() == ERROR_INVALID_PARAMETER` (PID does not exist).

### §6.3 Manifest state — r1: align to V1 ADR A8 (Issue 3)

V1 ADR A8 mandates: `delete` → SIGTERM supervisor → drain in-flight → **unlink manifest**. r0 retained a "stopped" tombstone manifest; r1 aligns:

#### §6.3.1 Default behavior — manifest unlinked after kill

After the kill gate completes normally (any of §1.1–§1.3 ending in successful child reap), the supervisor:

1. Writes final `kind:"shutdown_drain"` log event to `log.jsonl` with `escalated`, `exit_reason`, `exit_code`, `exit_signal` fields (these audit fields live in the log, NOT the manifest, per A8 unlink semantics).
2. Calls `flush()` + `fsync()` on `log.jsonl`.
3. **Unlinks** `manifest.json` (atomic per POSIX `unlink(2)` / Windows `DeleteFile`).
4. Closes / unlinks UDS socket (POSIX) or releases Named Pipe (Windows).
5. Supervisor exits with code 0.

After this, `~/.telepty/sessions/<sid>/log.jsonl` remains as an audit artifact (V1 ADR §3.5 — log is "the source of audit and recovery explanation"; survives delete). The session directory may be retained until disk-policy cleanup (V1 ADR §7.4 default: log retained until explicit cleanup or 100 MB rotation).

#### §6.3.2 Exception — manifest preserved on `crashed` / `unkillable`

The default unlink applies to **clean exits** (`exit_reason ∈ {normal, signaled, killed}`). For non-clean exits, the manifest is **preserved as a tombstone** for orchestrator visibility:

- `exit_reason: "crashed"` — written by §1.5 detection writer (orchestrator or any observer); supervisor itself cannot write because it's dead. Manifest remains until orchestrator respawn (manifest replaced) or manual cleanup.
- `exit_reason: "unkillable"` — supervisor writes the tombstone manifest itself before exit (§7.B). Preserved for operator action because the child is still consuming resources.

This split resolves the r0 contradiction: clean exits unlink (A8), failure exits tombstone. The terminal `exit_reason` enum {`normal`, `signaled`, `killed`, `crashed`, `unkillable`} — `orphan` REMOVED from terminal set per codex Issue 7 §6.3 (orphan is a `status` modifier, not a terminal `exit_reason` because §1.4 says orphaned supervisors do not exit).

#### §6.3.3 Tombstone schema (when written)

```json
{
  "schema_version": 1,
  "id": "<sid>",
  ...
  "status": "error",
  "exit_reason": "crashed" | "unkillable",
  "exit_code": <int|null>,
  "exit_signal": "SIGTERM" | "SIGKILL" | "SIGHUP" | "JOB_TERMINATE" | "CTRL_BREAK_EVENT" | null,
  "kill_gate": { ... session config ... },
  "stopped_at": "<RFC3339>",
  "crashed_at": "<RFC3339|null>",
  "restart_count": <int>
}
```

Manifest preserves `schema_version` (per V1 ADR §3.5 manifest schema). Wire frames use `v: 1` only — see §6.4 r1.

### §6.4 Wire envelope — `v` only, no `schema_version` on wire (r1 — codex Issue 3)

r0 wire frame examples included both `v` and `schema_version`. r1 aligns to V1 ADR §6.1 envelope which uses `v: 1` only. **Manifest** has `schema_version`; **wire** has `v`. They are distinct schemas (manifest discovery / disk vs NDJSON wire transport) and the V1 ADR keeps them separate. r1 wire-frame examples updated throughout §1.1–§1.3 (see r1 changelog).

### §6.5 Relay manifest sync

Per V1 ADR §8.2 L4a, relay reads supervisor manifests by walking `~/.telepty/sessions/`. The relay's view becomes consistent within `manifest_sync_interval_ms` (default 1000 ms) of the supervisor's manifest write — i.e., a session that transitions to `stopped` (unlink) or `error` (tombstone) at time T will be observed by `telepty list` within T + 1000 ms.

### §6.6 RAM cleanup — Phase 4 measurement, NOT per-kill invariant (r1 — codex Issue lower-sev)

r0 stated "jemalloc heap freed within ms of supervisor exit" as a per-kill invariant. Codex correctly noted:

- After process exit, heap is gone because the OS tears down the address space — this is trivially true, not a spec-level invariant.
- While supervisor is *still running*, allocator RSS behavior is probabilistic and workload-dependent. `MALLOC_CONF=dirty_decay_ms:0` is a tuning hypothesis (per V1 ADR M31 + ADR-E3-r1), not a post-kill invariant.

r1 removes the jemalloc invariant from §6. RAM characterization is moved to V1 ADR §13.1 / Phase 4 measurement gates per §10.3 of V1 ADR. C2 PoC report (§5 RSS Measurements) remains as evidence the **architecture** is RAM-feasible; not as a per-kill assertion.

### §6.7 Escaped descendants — explicit failure mode (r1 addition — codex Issue 7 §6)

A child can call `setsid()` itself, daemonize, fork into a new pgrp, or (on Windows) request `JOB_OBJECT_LIMIT_BREAKAWAY_OK` to escape the supervisor's pgrp / Job Object. After such escape:

- **POSIX**: `killpg(pgid, SIGKILL)` does not reach the escaped descendant; `killpg(pgid, 0)` still returns ESRCH because the descendant is no longer in `pgid`. The supervisor cannot kill what it cannot target.
- **Windows**: a process that has `CREATE_BREAKAWAY_FROM_JOB` + `JOB_OBJECT_LIMIT_BREAKAWAY_OK` set on the job can escape `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` cascade.

**Spec policy**: escaped descendants are **out of scope for the supervisor kill gate**. The supervisor reports successful kill once the targeted pgrp / Job Object is empty / terminated; escaped descendants are the user's responsibility (or a future Phase 2+ extension for "session quarantine" semantics). The supervisor SHOULD NOT scan the system for orphaned descendants post-kill — that is scope creep and crosses the cwd / non-responsibility boundary.

Detection (best-effort, advisory): if `killpg(pgid, 0) == ESRCH` but the supervisor observes that processes claiming `parent_session_id: <sid>` (via an out-of-band env-var marker the supervisor could inject at spawn) still exist, it MAY emit `kind:"warn" code:"ERR_ESCAPED_DESCENDANT"`. This is **optional** and not required for kill-gate acceptance.

### §6.8 Idempotency on repeated kill

A `delete` / kill issued against a session whose manifest is already unlinked (clean exit) MUST return `ERR_UNKNOWN_SESSION` per V1 ADR §6.4. A `delete` issued against a tombstone (`exit_reason: "crashed"` / `"unkillable"`) is a no-op returning success. Supervisor implementations MUST handle the race where two `delete` frames arrive concurrently — the first transitions to `draining`, the second sees `isClosing` flag set (matching current 0.3.x `daemon.js:2030` pattern) and returns `success: true, status: "closing"`. This race is serialized through the single-thread tokio reactor (V1 ADR M24); FIFO holds **per stream**, not globally — codex Issue 7.G note.

---

## §7 Failure modes (scope G)

### §7.A Child ignores SIGTERM

**Scenario**: claude is in a stuck `requests.post()` call to api.anthropic.com with a 600 s timeout, ignoring SIGTERM.

**Supervisor behavior**: §1.2.5 escalation to §1.3.3 SIGKILL. SIGKILL is uncatchable per POSIX. Reap succeeds within `child_reap_timeout_ms`.

**Verified**: this is the canonical use case. Test §8.G1.

### §7.B Child stuck in uninterruptible sleep (D state) — POSIX

**Scenario**: child is blocked in a kernel syscall (NFS mount hang, broken USB device, kernel module deadlock). On Linux, `ps` shows status `D`. SIGKILL is queued but not delivered until the syscall returns.

**Supervisor behavior** (r1 — poll cadence explicit per codex Issue 7.D):

1. `kill(-pgid, SIGKILL)` returns 0 (signal queued) — runs on spawn_blocking.
2. The reap loop (§4.1.1) polls `waitpid(child_pid, &status, WNOHANG)` at `reap_poll_ms` cadence (default ≈ 100 ms).
3. After `child_reap_timeout_ms` (2000 ms) of WNOHANG returning 0, the supervisor declares the child unkillable. **No retry, no escalation** — there is no signal stronger than SIGKILL.
4. Supervisor:
   - writes **tombstone manifest** (§6.3.2): `status: "error"`, `exit_reason: "unkillable"`, `exit_signal: "SIGKILL"`, `crashed_at: <RFC3339>`;
   - emits `kind:"error" code:"ERR_UNKILLABLE_CHILD"` to subscribed clients (best-effort);
   - **abandons the child** (the §6.1 no-process invariant is waived for this exit_reason);
   - supervisor process exits with code 0 (the supervisor itself completed its abandonment correctly).
5. The abandoned child remains on the host until kernel resolves the D-state (NFS server returns, USB device removed, etc.). Phase 1 surfaces this in `telepty list` via `status: "error"` row visible until manual cleanup. V4 inbox notification (Phase 2+ M39) is the future user-page surface — explicitly deferred to V4 ADR per codex Q7 close.

### §7.C Windows analog — rare, manual-test category (r1 — codex Issue 7.C)

Windows does not have a POSIX D-state equivalent in the strict kernel-wait sense. Possible analogs:

- IRP-stuck thread in kernel-mode with no driver cancel routine (rare on modern Windows; legacy driver dependency);
- Process suspended via `NtSuspendProcess` (intentional debugger-style state).

`TerminateProcess` / `TerminateJobObject` can kill threads stuck in kernel-mode IRP **only if** the IRP cancel routine is implemented by the driver. If not, the process is effectively unkillable.

**Spec position** (r1 change): Windows unkillable is rare and not assumed symmetric with POSIX D-state. Supervisor behavior: if `WaitForSingleObject(child_handle, child_reap_timeout_ms)` returns `WAIT_TIMEOUT`, retry **once** with `child_reap_timeout_ms * 2`; if still timeout, mark `unkillable` and proceed as §7.B step 4. Test §8.G.W-unkillable is **destructive-manual bucket** per §8 reorganization (Issue 8).

### §7.D PTY master close races with child write

**POSIX**: child sees SIGPIPE (default terminate) or EPIPE on `write(2)`. Supervisor's read side may receive a partial last-line of output before EOF.

**Windows**: child's `WriteFile` returns `ERROR_BROKEN_PIPE`. Supervisor's read side sees the closed pipe.

**Spec behavior** (per §5.3): documented and accepted. Child's responsibility to flush before graceful exit.

### §7.E Supervisor itself receives SIGKILL mid-shutdown (r1 — codex Issue 7.E)

**Scenario**: user runs `kill -9 <supervisor_pid>` while supervisor is in `draining`.

**Consequence**:

1. Supervisor exits immediately, no further log writes.
2. PTY master FD closed by kernel reap → child receives SIGHUP → child default terminate. Caveat: child may handle / ignore SIGHUP, call `setsid()`, or daemonize — see §6.7 escaped-descendants policy.
3. Child (if it exits) becomes adopted by `init` (PID 1) — reaped there.
4. Manifest left in `status: "draining"` — stale (supervisor died before writing terminal state).
5. **Stale UDS socket file**: only remains if the supervisor created a pathname socket and did not unlink on startup. r1 mandate: supervisors MUST `unlink()` the socket path at startup before bind (idempotent — handles prior-crash stale inodes). Even with this mandate, a SIGKILLed supervisor cannot unlink its own socket on exit; the inode is left until next start-up reuse or external cleanup.

**Recovery** (orchestrator-driven per §1.5 r1, NOT relay-only):

1. Orchestrator's `telepty list` walks manifests.
2. For each `status ∈ {ready, draining}` manifest, verify supervisor liveness via `kill(manifest.pid, 0)` (POSIX) / `OpenProcess` (Windows). **Authoritative signal = live pid**, NOT socket reachability (codex Issue 7.E: socket file may remain stale after SIGKILL).
3. On confirmed dead pid: detection writer (first observer) atomically updates manifest to `status: "error"`, `exit_reason: "crashed"`, `crashed_at: <RFC3339>`. Best-effort `unlink()` of the stale UDS socket; ignore EBUSY / ENOENT.
4. Subsequent orchestrator action per `restart_policy` (§1.5).

Eventual consistency within `manifest_sync_interval_ms` of the next list operation.

### §7.F Manifest write fails after kill (disk full, fs error)

**Scenario**: supervisor enters `draining`, kills child, writes `manifest.json.tmp` — `fsync` fails (ENOSPC).

**Supervisor behavior**:

1. Log `kind:"error" code:"ERR_MANIFEST_WRITE_FAIL" data:"<errno>"` to `log.jsonl` (best-effort — log may also be on full disk).
2. Emit error wire frame to subscribed clients.
3. Exit with code 1 (supervisor-level failure — distinct from successful supervisor exit code 0 of §1.1–§1.3).
4. Child is already dead (kill happened before manifest write). Manifest remains stale in pre-kill state — orphan detector will eventually clean per §7.E.

### §7.G Concurrent `delete` and `signal` frames (r1 — codex Issue 7.G FIFO note)

**Scenario**: orchestrator sends `delete force:true` and `signal SIGINT` simultaneously, possibly from 5 different clients.

**Supervisor behavior**: the single-thread tokio reactor (V1 ADR M24) makes the **state-machine transition race-free** — but FIFO ordering is **per-stream**, not global. Across multiple UDS / pipe connections, the supervisor's acceptance order is kernel-scheduler-dependent. The supervisor MUST funnel all incoming frames through one **internal queue** before applying state transitions; this guarantees a single linearization order even with multiple inbound streams. The first `delete force:true` in this internal order wins; subsequent `signal` / `delete` frames return `ERR_SHUTTING_DOWN`.

Idempotency (V1 ADR §6.5) ensures duplicate `delete` frames return success regardless of order.

### §7.H Relay unreachable during kill propagation

**Scenario**: orchestrator on machine A tells supervisor on machine B to kill via `delete` frame; relay-B has just crashed.

**Supervisor behavior**: orchestrator's `delete` frame fails at the relay-A → relay-B SSH stream level (M40 binary reachability — sender immediately rejects with `ERR_NOT_REACHABLE` per V1 ADR §6.4). Supervisor on machine B is unaware of the kill request. **No queueing, no store-and-forward** per dispatch lessons §159 + V1 ADR M40.

Cleanup: orchestrator retries when relay-B is back up. Idempotency (V1 ADR §6.5) ensures duplicate `delete` frames are no-ops if the session is already stopped.

### §7.I Supervisor crash during graceful drain (r1 — orchestrator-driven recovery)

**Scenario**: in §1.2 step 2, supervisor segfaults after issuing SIGTERM but before reaping child.

**Consequence chain** = §1.5 crash recovery + §7.E mid-shutdown. Child likely already received SIGTERM and may exit cleanly via PTY hangup; otherwise becomes orphan adopted by init. **Orchestrator** (not OS service manager — per Issue 6 r1) detects dead supervisor pid via manifest poll, writes tombstone manifest `status: "error"`, `exit_reason: "crashed"`, then applies `restart_policy`:

- `respawn` (default per Q2 r1): orchestrator issues `telepty spawn` to fresh supervisor with same `<sid>`; `restart_count: ≥1`; `log.jsonl` preserved.
- `manual`: tombstone manifest persists; no automatic respawn.

---

## §8 Test scenarios (scope H) — r1 reorganized into 3 buckets (codex Issue 8)

r0 mixed always-on CI tests, controlled-host integration tests, and destructive/manual fault tests into one list of 14 scenarios. r1 splits them into 3 buckets per codex Issue 8:

| Bucket | What it covers | Where it runs | Blocks PR merge? |
|---|---|---|---|
| **§8.A always-on PR CI** | Deterministic, no privileged kernel manipulation, no service-manager registration. Pure userland fixtures with bounded timing. | Standard GitHub Actions matrix: ubuntu-latest, macos-latest, windows-latest. | **YES — blocking** for any kill-gate-touching change (M25 contract test). |
| **§8.B controlled-host integration** | Per-user launchd / systemd-user / Windows Service registration; orchestrator-driven respawn happy-path. | Dedicated runners with pre-installed service units; nightly schedule. | NO — failure files an issue; not a per-PR gate. |
| **§8.C destructive / manual** | D-state (NFS hangs), Windows IRP unkillable, kernel-fault simulation, cross-machine K1 measurement, RSS measurement gates. | Quarantined runners or manual operator. | NO — Phase 4 measurement gates (V1 ADR §10) own this bucket. |

Notation per scenario:

- **Bucket**: A / B / C.
- **Setup**: how to spawn supervisor + child (fixtures, OS-specific equivalents listed).
- **Trigger**: signal/event injected.
- **Expected**: observable post-state via `ps` / live-pid check / manifest read (not implementation-internal state).
- **Timing**: bounded upper limits, not tight equality (codex Issue 8: `<200 ms` is too tight for Windows/macOS CI).

**Scenario count vs platform-matrix expansion**: §8.K (cross-OS contract) is a **matrix dimension**, not a separate scenario. Bucket §8.A scenarios run on all 3 OSes; a scenario count of N means N test definitions, with up to 3N actual CI runs.

### §8.A1 Normal termination — Bucket A

| Aspect | Definition |
|---|---|
| Setup | Spawn `telepty supervisor --sid test-a1 --cmd "<echo-and-exit-fixture>"` (POSIX: `sh -c 'echo hello && exit 0'`; Windows: `cmd /c echo hello`). Observe `manifest.status: "ready"` then manifest unlinked. |
| Trigger | (none — child exits on its own) |
| Expected | manifest unlinked per A8 (§6.3.1). `log.jsonl` contains `kind:"shutdown_drain"` with `exit_reason: "normal"`, `exit_code: 0`. `kill(supervisor_pid, 0) == ESRCH` (POSIX) / `OpenProcess` returns invalid (Windows). Stale UDS / Named Pipe absent. |
| Timing | All assertions hold within **2000 ms** of supervisor spawn. |

### §8.A2 Graceful shutdown — Bucket A

| Aspect | Definition |
|---|---|
| Setup | POSIX: child = `sh -c 'trap "echo got-term; exit 0" TERM; sleep 60'`. Windows: child = a small fixture exe that handles `CTRL_BREAK_EVENT` and exits cleanly. |
| Trigger | Send `delete force:false` frame. |
| Expected | manifest unlinked (A8). `log.jsonl` `shutdown_drain` shows `exit_reason: "signaled"`, `exit_signal: "SIGTERM"` (POSIX) / `"CTRL_BREAK_EVENT"` (Windows), `escalated: false`. Child stdout (captured pre-exit) shows `got-term` (POSIX fixture). |
| Timing | Total elapsed < **2000 ms** (well within 3000 ms grace; tolerant of Windows scheduler jitter). |

### §8.A2-escalate Graceful escalates to forced — Bucket A

| Aspect | Definition |
|---|---|
| Setup | POSIX: child = `sh -c 'trap "" TERM; sleep 60'` (ignores SIGTERM). Windows: fixture exe with `SetConsoleCtrlHandler` returning TRUE (consumes CTRL_BREAK_EVENT). |
| Trigger | Send `delete force:false`. |
| Expected | `log.jsonl` `shutdown_drain` `escalated: true`, `exit_reason: "killed"`, `exit_signal: "SIGKILL"` (POSIX) / `"JOB_TERMINATE"` (Windows). Manifest unlinked. |
| Timing | Total elapsed ∈ [3000, **4000**] ms (graceful_grace_ms + generous CI tolerance per codex Issue 8). |

### §8.A3 Forced kill — Bucket A

| Aspect | Definition |
|---|---|
| Setup | Child = `sleep 60` (POSIX) / `timeout /t 60 /nobreak` (Windows). |
| Trigger | Send `delete force:true`. |
| Expected | `log.jsonl` `shutdown_drain` `exit_reason: "killed"`, `exit_signal: "SIGKILL"` (POSIX) / `"JOB_TERMINATE"` (Windows), `escalated: false`. Manifest unlinked. |
| Timing | Total elapsed < **1500 ms**. |

### §8.A3-tree Forced kill cascades to grandchildren — Bucket A

| Aspect | Definition |
|---|---|
| Setup | POSIX: `sh -c 'sleep 60 & sleep 60 & wait'`. Windows: fixture that spawns 2 child processes within the supervisor's job. |
| Trigger | Send `delete force:true`. |
| Expected | `killpg(pgid, 0)` returns ESRCH within timing window (POSIX). `OpenJobObject` returns invalid (Windows). All descendant pids gone. |
| Timing | Total elapsed < **2000 ms**. |

### §8.A.W-jobrace Windows crash-before-attach race — Bucket A, Windows only (gemini Issue 9)

| Aspect | Definition |
|---|---|
| Setup | Windows native. Build adapter using Pattern J1 (`PROC_THREAD_ATTRIBUTE_JOB_LIST`). Spawn supervisor; configure to crash immediately after `CreateProcess` returns (test hook). |
| Trigger | Trigger the supervisor crash hook. |
| Expected | Child is **already in the Job Object** at `CreateProcess` return (J1 atomicity). When supervisor crashes, `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` cascade kills the child. `Get-Process -Id <child_pid>` raises ObjectNotFound. |
| Timing | Child gone within **1000 ms** of supervisor crash. |

### §8.A4 Parent death — supervisor stays alive — Bucket A

| Aspect | Definition |
|---|---|
| Setup | Spawn supervisor + child = `sleep 60`. Spawn the supervisor as a **child of a dummy parent process** (so OS-parent death is observable), not just a peer; orchestrator-WS is held by the dummy parent. |
| Trigger | Kill dummy parent with SIGKILL (POSIX) / `taskkill /F /PID <parent>` (Windows). |
| Expected | Supervisor remains alive past `parent_death_grace_ms + 1000` ms. manifest gains `orphaned_since: <RFC3339>`. `log.jsonl` has `code:"ERR_PARENT_GONE"`. Child still running. |
| Timing | Orphan detection triggers within **17000 ms** (`parent_death_grace_ms` + 2000 ms tolerance). |

### §8.A4-cleanup Orphan cleanup via explicit delete — Bucket A

| Aspect | Definition |
|---|---|
| Setup | Continue from §8.A4 — orphan supervisor present. |
| Trigger | Issue `telepty delete <sid>` from a fresh client. |
| Expected | Supervisor transitions §1.2 graceful path. Manifest unlinked per A8. |
| Timing | Supervisor exits within **5000 ms** of `delete`. |

### §8.A-reactor-stall Single-thread reactor non-blocking invariant — Bucket A (codex Issue 4)

| Aspect | Definition |
|---|---|
| Setup | Spawn supervisor with child = `sleep 60`. From another client, hold a synchronous request that would normally block (e.g., poll a status endpoint). |
| Trigger | Issue `delete force:true` from a separate client during the synchronous-request hold. |
| Expected | The kill gate runs to completion (manifest unlinked, supervisor exits) while the synchronous-request handler continues to make progress. No reactor stall observable as IPC timeout on the parallel client. |
| Timing | Kill gate completes within **1500 ms**; parallel client receives at least one response inside the same window. |

### §8.A-trace-id Trace ID propagation through kill path — Bucket A

| Aspect | Definition |
|---|---|
| Setup | Orchestrator sends `delete` with explicit `trace_id: "01HX..."`. |
| Trigger | (the delete frame) |
| Expected | `log.jsonl` `kind:"signal"` event has matching `trace_id`. `kind:"shutdown_drain"` event has its own minted `trace_id` plus `parent_trace_id` referencing the orig. Final `error` rejection of any pending inject during drain has `trace_id` of the rejected inject (NOT the delete trace_id). |

### §8.A-schema Wire envelope version enforcement — Bucket A

| Aspect | Definition |
|---|---|
| Setup | Send `delete` frame with `v: 99` (unsupported wire version per V1 ADR §6.1). |
| Trigger | (the malformed frame) |
| Expected | Supervisor responds with `kind:"error" code:"ERR_UNSUPPORTED_VERSION"` per V1 ADR §6.4. No state change. |

### §8.A-windows-no-sigint SIGINT on Windows rejected — Bucket A (codex Issue 5)

| Aspect | Definition |
|---|---|
| Setup | Windows native. Spawn supervisor + child. |
| Trigger | Send `{"v":1,"sid":"…","kind":"signal","signal":"SIGINT","trace_id":"…"}`. |
| Expected | Supervisor responds with `kind:"error" code:"ERR_BAD_FRAME" data:"signal_not_supported_on_windows"`. Child unaffected. |

### §8.A-idempotency Concurrent delete idempotency — Bucket A

| Aspect | Definition |
|---|---|
| Setup | Spawn supervisor with child = `sleep 60`. |
| Trigger | Issue 5 × `delete force:true` concurrently from 5 different client connections. |
| Expected | All 5 calls return `success: true` (idempotent per §6.8). Supervisor exits exactly once. Manifest unlinked. |
| Timing | All 5 responses within **2500 ms** of first call. |

---

### §8.B1 Orchestrator-driven respawn — Bucket B (controlled-host)

| Aspect | Definition |
|---|---|
| Setup | `restart_policy: "respawn"`. Child = `sleep 60`. Orchestrator process running with manifest-poller. |
| Trigger | `kill -9 <supervisor_pid>` (POSIX) / `Stop-Process -Force` (Windows). |
| Expected | Orchestrator detects dead pid within `manifest_sync_interval_ms` × few cycles, writes tombstone manifest (`status: "error"`, `exit_reason: "crashed"`), then issues `telepty spawn` to respawn. New supervisor with fresh `pid`, `restart_count: 1`. `log.jsonl` has `crash_recovered` event. |
| Timing | New supervisor `status: "ready"` within **8000 ms**. |

### §8.B2 Manual restart policy — Bucket B

| Aspect | Definition |
|---|---|
| Setup | `restart_policy: "manual"`. Child = `sleep 60`. Orchestrator running. |
| Trigger | `kill -9 <supervisor_pid>`. |
| Expected | Orchestrator writes tombstone manifest but does NOT respawn. Manifest persists in `status: "error"` until manual cleanup. |
| Timing | Tombstone visible within **5000 ms**. |

### §8.B3 Timeout override — Bucket B

| Aspect | Definition |
|---|---|
| Setup | Spawn supervisor with `kill_gate.graceful_grace_ms: 500` in manifest. POSIX child = `sh -c 'trap "" TERM; sleep 60'`. |
| Trigger | `delete force:false`. |
| Expected | Escalation occurs at ≤ **1200 ms** (override + tolerance). |

---

### §8.C1 D-state child unkillable — Bucket C (destructive / manual)

| Aspect | Definition |
|---|---|
| Setup | Linux only. Quarantined runner. Mount NFS to unreachable server in a network namespace; child = `cat /mnt/unreachable/file` under that namespace. |
| Trigger | `delete force:true`. |
| Expected | After `child_reap_timeout_ms` elapses with no reap, supervisor writes tombstone manifest `exit_reason: "unkillable"`, `log.jsonl` has `code:"ERR_UNKILLABLE_CHILD"`. Supervisor exits with code 0. **§6.1 no-process invariant is waived** for this exit_reason. |
| Timing | Supervisor exits within `child_reap_timeout_ms + 1000` ms ≈ **3000 ms** despite child still in D state. |
| Acceptance | Manual or quarantined runner only; not blocking PR merge. Phase 1 sidecar spike runs once to validate. |

### §8.C2 Windows IRP-stuck unkillable — Bucket C (rare, manual)

| Aspect | Definition |
|---|---|
| Setup | Windows. Legacy driver without IRP cancel routine (operator provisions). |
| Trigger | `delete force:true`. |
| Expected | After `WaitForSingleObject` returns `WAIT_TIMEOUT` twice (`child_reap_timeout_ms` × 2 ≈ 4000 ms), supervisor writes tombstone manifest. |
| Acceptance | Manual operator validation, not CI. Documented as rare per codex Issue 7.C. |

### §8.C3 Cross-machine `delete` rejection — Bucket C (operational; not K1 measurement)

| Aspect | Definition |
|---|---|
| Setup | Two hosts A, B. Supervisor on B. Relay-B stopped. Orchestrator on A. |
| Trigger | Orchestrator issues `delete force:true` for B's session. |
| Expected | Orchestrator receives `ERR_NOT_REACHABLE` per V1 ADR §6.4 / M40. Supervisor on B unchanged. After relay-B restart, retry succeeds; supervisor stops cleanly. |
| Timing | Initial `ERR_NOT_REACHABLE` is **observational, NOT a Phase 1 timing assertion**. K1 latency measurement (≤ 100 ms p99) is **Phase 4 measurement gate** per V1 ADR §10.1 + codex Issue 8. |

---

### §8.K Cross-OS uniformity (matrix dimension, NOT a separate scenario)

§8.A bucket scenarios run on macOS arm64, Linux x86_64, Windows native (no WSL substitution per V1 ADR §17.10). The test harness MUST fail-fast on detected WSL execution attempting to claim Windows parity. **Observable parity assertion** (§3.5 r1): same `kind:"shutdown_drain"` event class, same `exit_reason` value, same manifest unlink/preserve behavior — modulo platform-specific `exit_signal` (`SIGTERM` vs `CTRL_BREAK_EVENT`, etc.).

---

## §9 Integration with V1 ADR (scope I)

### §9.1 Mandate cross-references (r1 — codex Issue 9 §9 note)

r0 §11 implied "full M22-M40 alignment" via a 10-row table. r1 corrects: this spec **materially integrates** only the mandates listed below. M23, M26, M27, M30, M32, M33, M35, M39 are out of kill-gate scope; this spec does not touch them. §11 closure check uses the integrated-set count, not the M22-M40 superset.

This spec implements / extends the following V1 ADR mandates:

| Mandate | Where in spec | Notes |
|---|---|---|
| **M22** (OS-native local IPC) | §2.2, §3.2, §6.2 | UDS / Named Pipe close as part of teardown |
| **M24** (single-thread tokio) | §7.G | Race-free serialization of concurrent kill frames |
| **M25** (protocol contract test) | §8 | Tests are M25-binding |
| **M28** (cdylib + rlib) | §6.5 | jemalloc cleanup verified by C2 PoC |
| **M29** (no N cap) | §2.1 | `orphan_detect_interval_ms = 5 s` × N=100 still negligible |
| **M31** (jemalloc tuning) | §6.6 | RAM cleanup is a Phase 4 measurement, NOT a per-kill invariant — see §6.6 r1 (codex Issue lower-sev) |
| **M34** (crash detection + restart) | §1.5, §8.B1 | Orchestrator-driven respawn (default `restart_policy: "respawn"`); no OS service-manager dependency in Phase 1 — see §1.5 r1 (codex Issue 6, Q2 closed) |
| **M36** (graceful drain on SIGTERM) | §1.2 | Drain → flush → ack → final manifest → exit |
| **M37'/M38'** (NDJSON wire, kind-conditional) | §1.1–§1.3, §8.A-schema, §8.A-trace-id, §8.A-windows-no-sigint | All kill protocol messages are NDJSON with kind-conditional fields; wire envelope uses `v:1` only (manifest `schema_version` is a separate disk schema) — see §6.4 r1 (codex Issue 3) |
| **M40** (binary reachability, no mailbox) | §7.H | Cross-machine kill fails fast, no queue |

### §9.2 Section cross-references

- **§3.3 Per-session supervisor — "Drain in-flight ops on termination"** → §1.2 graceful drain (this spec is the binding definition of "drain in-flight ops").
- **§3.6 Structured per-session log — `shutdown_drain`** → §1.1.3, §1.2.6, §1.3 step 6.
- **§6.2 Wire kinds — `signal` and `delete`** → §1.2 (delete force:false), §1.3 (delete force:true), §2.2 (signal name mapping).
- **§7.3 Manifest invariants — `status` enum** → §6.3 extends `exit_reason` enum; spec proposes adding `unkillable` per §7.B.
- **§8.2 Relay lifecycle L3a** → §1.4 (relay restart not transparent, supervisor remains independent).
- **§9.5 1-process per session** → §0.2 (no live PTY recovery).
- **§13.1 C1 (E3 RAM amendment)** → §6.5 (jemalloc cleanup post-exit).
- **§13.3 C3 closure** → THIS SPEC (closes the precondition).
- **§17.3 r3 closure note** → §1.5 (no transparent live recovery).
- **§17.5 Supervisor language Rust bias** → §0.3 language assumption.

### §9.3 V1 ADR amendments — MANDATORY preconditions for C3 closure (r1 — codex Issue 7)

r0 listed amendments as "Required" then later "optional" — codex correctly flagged this contradiction. r1: **all enum / field amendments below are MANDATORY** for this spec's contract to be valid. A1–A4 are **binding for C3 closure**; A5 is binding but redundant (can be implemented without ADR change since `shutdown_drain` schema is internal to telepty's log format and already specified by V1 ADR §3.6 with extensible fields).

> **C3 closure blocked until V1 ADR formally amends**: A1 (wire signal enum extension), A2 (error codes), A3 (exit_reason enum), A4 (manifest kill_gate block) — OR the spec is updated to declare itself as the SSOT for these fields with explicit cross-reference from V1 ADR §6.2/§6.4/§7.

#### A1 — Wire `signal` enum extension (MANDATORY)

V1 ADR §6.2 currently: `signal` enum = `{SIGINT, SIGTERM, SIGHUP}`.

**Required**: extend to `{SIGINT (POSIX-only), SIGTERM, SIGHUP, SIGKILL, JOB_TERMINATE, CTRL_BREAK_EVENT}`. Per §1.3 / §2.2 r1 of this spec. Additive schema change per M38'.

**Refinement**: amendment text MUST specify the per-OS mapping (POSIX-only SIGINT; CTRL_BREAK_EVENT / JOB_TERMINATE Windows-only labels with POSIX normalization paths per §2.2). Removing the false equivalence `SIGINT ↔ CTRL_C_EVENT` is part of this amendment.

#### A2 — Error codes (MANDATORY)

V1 ADR §6.4 currently lists 9 error codes. **Required additions**:

| Code | Trigger | Source section |
|---|---|---|
| `ERR_UNKILLABLE_CHILD` | child still alive after `child_reap_timeout_ms` post-SIGKILL | §7.B |
| `ERR_PARENT_GONE` | parent disappearance detected past `parent_death_grace_ms` | §1.4 |
| `ERR_SUPERVISOR_GONE` | detection writer observes dead supervisor pid | §1.5 |
| `ERR_MANIFEST_WRITE_FAIL` | atomic manifest write fails (ENOSPC, fs error) | §7.F |
| `ERR_ESCAPED_DESCENDANT` | optional advisory; pgrp empty but external descendants observable | §6.7 |
| `ERR_PGRP_LIVE_AFTER_KILL` | optional warn; pgrp non-empty after expected kill window | §4.1.2 |

#### A3 — Manifest `exit_reason` enum (MANDATORY)

V1 ADR §7.3 currently defines `status` enum: `{spawning, ready, draining, stopped, error}`. It does NOT define `exit_reason`.

**Required**: define `exit_reason` enum: `{normal, signaled, killed, crashed, unkillable}`. **`orphan` is NOT terminal** (per §1.4 r1 / §6.3 r1). Codex correctly noted r0 included `orphan` in terminal set — removed in r1.

Per §6.3.1 / §6.3.2: manifest is **unlinked for clean exits** (A8) and **preserved for `crashed` / `unkillable` tombstones**. A3 amendment MUST clarify that V1 ADR §7.4 disk policy ("manifest while session exists; tombstone optional after delete") is satisfied by both: clean-exit unlink (no tombstone), crash/unkillable tombstone retained.

#### A4 — Manifest `kill_gate` block + `restart_policy` (CONDITIONAL — folded into spec, no ADR change required)

Per V1 ADR §7.2 manifest example, additional fields are allowed (§7.3 only mandates `schema_version`, `id`, `ipc.kind`, `status`; other fields are free). r1 folds this amendment **into the spec** — V1 ADR does not require formal amendment because the schema accepts additional fields:

```json
"kill_gate": {
  "graceful_grace_ms": 3000,
  "parent_death_grace_ms": 15000,
  "restart_policy": "respawn"
}
```

Default `restart_policy: "respawn"` matches V1 ADR M34/H1 — no conflict per Issue 3 r1 resolution. Q2 closed.

#### A5 — `shutdown_drain` log event fields (FOLDED, no ADR change required)

V1 ADR §3.6 specifies `shutdown_drain` minimum fields as `(ts, sid, in_flight, completed)`. r1 adds `escalated: bool`, `exit_reason: enum`, `exit_signal: enum`, `exit_code: int`. These are additive log fields and do not break consumers (V1 ADR §3.6 explicitly says minimum-required fields; supersets are allowed for forward compat per M38').

#### Summary

| Amendment | Status | C3 closure impact |
|---|---|---|
| A1 wire signal enum | **MANDATORY ADR amendment** | blocking |
| A2 error codes | **MANDATORY ADR amendment** | blocking |
| A3 exit_reason enum | **MANDATORY ADR amendment** | blocking |
| A4 manifest kill_gate block | folded (additive; no ADR change) | non-blocking |
| A5 shutdown_drain log fields | folded (additive; no ADR change) | non-blocking |

If orchestrator prefers to keep V1 ADR stable, the spec MAY stand as SSOT for A1–A3 with V1 ADR §6.2 / §6.4 / §7.3 gaining a single cross-reference line: "See SPEC-C3-r1 for the binding kill-gate extensions to these enums." This is Q6 r1 — informational; orchestrator decides.

### §9.4 Protocol-grade message requirement (dispatch lesson §160)

Per dispatch line 160 ("every kill protocol message MUST include trace_id + schema_version + error_taxonomy"), every wire frame defined in this spec includes (r1 reconciled with §6.4):

- `trace_id` — required (per V1 ADR B3 r3 + dispatch lesson);
- **wire schema version** = `v: 1` per V1 ADR §6.1 envelope. The dispatch's "schema_version" instruction is satisfied by V1 ADR's `v` field on the wire; manifest's `schema_version` field is a distinct on-disk concept and not part of the wire envelope (codex Issue 3 r1 resolution);
- error frames carry `code` from the V1 ADR §6.4 enum (extended per §9.3 A2).

Verified per §1.1–§1.3 wire frame examples updated in r1.

### §9.5 Constitution check (Article 4 위헌 심사)

| Question | Answer |
|---|---|
| Q1. Does this serve closing the AI tech gap? | PASS. Reliable kill semantics are the precondition for ∞ parallelism (V1) — orphan supervisors consuming RAM/quota are the failure mode this spec prevents. |
| Q2. Whose role is this feature? | PASS. telepty L2 mechanism owner per V1 ADR §3.3 / §9. Supervisor process is telepty's responsibility. |
| Q3. Is this framework / library actually needed? | PASS. portable-pty + tokio + jemalloc are V1 ADR-locked. No new dependency introduced. |
| Q4. Does it work in all cross environments? | PASS (verification gated). §3.5 enumerates POSIX ↔ Windows equivalence; §8.K cross-OS contract test enforces. |
| Q5. Does it avoid forcing "how" on users? | PASS. Defaults (§2.1) override-able via session config (§2.3); `restart_policy` is a runtime choice. |

---

## §10 Open questions (r1 — Q3 closed; Q1-Q9 marked binding vs informational per codex)

| ID | Status | Question | Owner | Resolution path |
|---|---|---|---|---|
| **Q1** | **informational (binding before Phase 2 if tests depend on exact default)** | Should `graceful_grace_ms` default be per-CLI (claude:3000, codex:2000, gemini:2000) or single-default (3000)? | architect + orchestrator | Measure CLI flush times in Phase 1 sidecar spike. r1 keeps 3000 ms as proposal pending measurement. Gemini suggests configurability for long-running workloads (kubelet 30 s precedent). |
| **Q2** | **CLOSED (r1)** | Restart policy default. | — | **Default = `"respawn"` (orchestrator-driven)**. Matches V1 ADR M34/H1. Opt-out via `"manual"`. r0's `"tombstone"` default removed per Issue 3 r1 resolution. |
| **Q3** | **CLOSED (r1) — omit** | Should the supervisor install Linux `prctl PR_SET_PDEATHSIG`? | — | **Omit**. Rationale: `PDEATHSIG=SIGTERM` conflicts with §1.4 ("do not self-terminate on parent death") and §1.2 (SIGTERM = graceful shutdown). Heartbeat (§2.1 `parent_death_grace_ms`) is the binding mechanism. Codex Q3 close adopted. |
| **Q4** | **binding-required for §8.A tests** | Should `child_reap_timeout_ms` be configurable? | architect | Hard-coded in Phase 1 per §2.1. §8.A tests must not require privileged D-state manipulation. Revisit if Phase 1 production data shows false-positive D-state events. |
| **Q5** | **informational (Phase 4 measurement gate)** | Cross-machine `delete` latency vs K1 budget. | tester | Phase 4 measurement per V1 ADR §10.1 / §17.11. NOT a Phase 1/2 acceptance assertion. §8.C3 captures the operational rejection-on-unreachable path; latency is separate. |
| **Q6** | **binding-required** | A1–A3 amendments: fold into V1 ADR r6, or SPEC-C3-r1 stands as SSOT? | orchestrator | r1 default: SPEC-C3-r1 is the SSOT for kill-gate enum/error/exit_reason extensions; V1 ADR §6.2/§6.4/§7.3 gain one cross-reference line each. Orchestrator MAY override and fold; resolved before C3 closure. |
| **Q7** | **informational (deferred to V4 ADR)** | V4 inbox notification for `unkillable` sessions. | architect (V4 ADR) | Phase 1: logs `code:"ERR_UNKILLABLE_CHILD"` + tombstone manifest; `telepty list` surfaces `status: "error"`. V4 ADR owns user-page UX. |
| **Q8** | **informational (not really open — recovery semantics)** | Supervisor OOM-killed. | architect | Identical to §1.5 crash recovery + §7.E mid-shutdown. Orchestrator detects + respawns per `restart_policy`. Phase 4 measures whether E3 ≤ 15 MB makes OOM rare. |
| **Q9** | **binding only if helpers exist in Phase 1** | Helper subprocess count bound. | architect | Spec recommends ≤ 3 per §4.3. V1 ADR §3.3 "Non-responsibilities" implies typical 0. If Phase 1 sidecar spike introduces helpers, this Q becomes binding and the kill gate timeout budget is re-derived. |

---

## §11 Closure check (architect 7-item rubric) — r1

Per V1 ADR §22 self-check pattern — applied to this spec:

| Item | Result |
|---|---|
| 1. Scope checklist A–I covered? | ✅ A (§1) B (§2) C (§3) D (§4) E (§5) F (§6) G (§7) H (§8) I (§9) — 9/9 preserved from r0 |
| 2. Cross-OS observable parity (NOT primitive equivalence)? | ✅ §3.5 r1 reframed as observable parity assertions; §8.K matrix dimension. SIGINT-on-Windows correctly reported as unsupported per codex Issue 5. |
| 3. Test scenarios bucketed (codex Issue 8)? | ✅ §8 r1 — Bucket A (always-on PR CI, blocking), Bucket B (controlled-host integration, nightly), Bucket C (destructive/manual, Phase 4 owner). 16 scenario definitions; §8.A 11 scenarios, §8.B 3, §8.C 3 (incl. §8.A.W-jobrace new). §8.H K1 moved to Phase 4 per Issue 8. |
| 4. Defaults flagged as PROPOSALS pending Phase 1 measurement? | ✅ §2.1 r1: `graceful_grace_ms = 3000 ms` marked "proposal — to be measured in Phase 1 sidecar spike". `child_reap_timeout_ms` hard-coded per Q4. |
| 5. `trace_id` on every protocol-grade message; wire envelope uses `v:1` only (NOT `schema_version`)? | ✅ §6.4 r1 + §1.1–§1.3 wire examples updated. Manifest keeps `schema_version` per V1 ADR §3.5; wire keeps `v` per V1 ADR §6.1. Codex Issue 3 resolved. |
| 6. Mandate integration scoped (NOT claiming full M22-M40)? | ✅ §9.1 r1 — explicit integrated set: M22, M24, M25, M28, M29, M31, M34, M36, M37'/M38', M40. Not claiming M23/M26/M27/M30/M32/M33/M35/M39 alignment. |
| 7. Lessons / failed approaches preserved? | ✅ no mailbox (§0.2 + §7.H); no Linux-only signals in protocol enum (§2.2); no SIGUSR1; no PR_SET_PDEATHSIG (Q3 closed); no SIGINT↔CTRL_C_EVENT (codex Issue 5); no service-manager auto-restart assumption (Issue 6); orchestrator-driven respawn per V1 ADR §1.4. |

---

## §12 Appendix — sources

### §12.1 V1 ADR + closed preconditions

- V1 ADR: `aigentry-orchestrator/docs/adr/2026-05-10-telepty-l2-architecture-q-prime-bis.md` (§3.3, §3.6, §6, §7, §8, §9, §13.1, §13.3, §17.3, §17.5).
- C2 PoC report: `aigentry-aterm/docs/experiments/2026-05-10-cdylib-tokio-nesting-poc/report.md` (RSS measurement methodology + tokio shutdown evidence).
- C4 cost report: `aigentry-orchestrator/docs/reports/2026-05-10-telepty-bilingual-ops-cost.md` (Path B Rust lock).
- E3 amendment: `aigentry-orchestrator/docs/adr/2026-05-10-e3-amendment-rss-15mb.md` (RSS ≤ 15 MB ceiling).

### §12.2 Telepty 0.3.x source patterns referenced

- `cli.js:1426–1440` — current allow-bridge SIGTERM/SIGHUP/SIGQUIT handler (signal-then-exit pattern).
- `daemon.js:2030–2052` — current `delete` route with `isClosing` re-entry guard (§7.G match).
- `daemon.js:978` — `ptyProcess.onExit` reaping (matches §1.1 normal termination).
- `daemon.js:2817–2826` — `shutdown(code)` and `process.on('SIGTERM/SIGINT', ...)` daemon-level handlers.

### §12.3 External references (cited 2026-05-10 / 2026-05-12)

- portable-pty crate (lib.rs): <https://lib.rs/crates/portable-pty> (cited 2026-05-10).
- portable-pty `PtySystem` trait (no Job Object surface): <https://docs.rs/portable-pty/latest/portable_pty/trait.PtySystem.html> (cited 2026-05-12, codex Issue 1).
- portable-pty `SlavePty::spawn_command`: <https://docs.rs/portable-pty/latest/portable_pty/trait.SlavePty.html> (cited 2026-05-12, codex Issue 1).
- portable-pty `MasterPty`: <https://docs.rs/portable-pty/latest/portable_pty/trait.MasterPty.html> (r0 r1 — corrected note: `MasterPty::kill` is not a method; killing goes through `ChildKiller`).
- portable-pty `ChildKiller` (sends SIGHUP-then-pid-targeted SIGKILL, NOT pgrp-targeted): <https://docs.rs/portable-pty/latest/portable_pty/trait.ChildKiller.html> (cited 2026-05-12, codex §1).
- portable-pty `CommandBuilder` (no `pre_exec` public method): <https://docs.rs/portable-pty/latest/portable_pty/cmdbuilder/struct.CommandBuilder.html> (cited 2026-05-12, codex §3.1).
- portable-pty `Child` trait (synchronous `wait`/`try_wait`/`kill`): <https://docs.rs/portable-pty/latest/portable_pty/trait.Child.html> (cited 2026-05-12, codex Issue 4).
- portable-pty `PtyPair` (slave-first drop, RFC 1857): <https://docs.rs/portable-pty/latest/portable_pty/struct.PtyPair.html> (cited 2026-05-12).
- portable-pty unix slave source (`setsid()` internal): <https://github.com/wez/wezterm/blob/main/pty/src/unix.rs> (cited 2026-05-12).
- tokio-process-tools graceful `terminate(SIGINT_timeout, SIGTERM_timeout)` pattern: <https://docs.rs/tokio-process-tools/latest/tokio_process_tools/> (cited 2026-05-10; gemini #1).
- tokio Child kill_on_drop sends SIGKILL (issue #2504): <https://github.com/tokio-rs/tokio/issues/2504> (cited 2026-05-10).
- tokio `tokio::process::Child` reference: <https://docs.rs/tokio/latest/tokio/process/struct.Child.html> (cited 2026-05-12, codex §2).
- tokio `tokio::signal::unix::Signal` (coalescing semantics): <https://docs.rs/tokio/latest/tokio/signal/unix/struct.Signal.html> (cited 2026-05-12, codex §4).
- Win32 Job Objects + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` + nested-job / breakaway semantics: <https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects> (cited 2026-05-10).
- Windows ConPTY (`CreatePseudoConsole`, `ClosePseudoConsole` drain/deadlock note): <https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session> (cited 2026-05-12, codex §5.2).
- `GenerateConsoleCtrlEvent` (CTRL_C_EVENT NOT group-targetable; CTRL_BREAK_EVENT is): <https://learn.microsoft.com/en-us/windows/console/generateconsolectrlevent> (cited 2026-05-10, reaffirmed 2026-05-12 codex Issue 5).
- `PROC_THREAD_ATTRIBUTE_JOB_LIST` (Win10+, atomic spawn+attach): see [Microsoft Job Objects][js-jobs] linked from §3.2.1 (cited 2026-05-12, gemini Issue 9).
- Go 1.20 `os/exec` `WaitDelay` graceful-to-SIGKILL escalation precedent: gemini-cited 2026-05-12.
- Kubernetes `terminationGracePeriodSeconds` (default 30 s): gemini-cited 2026-05-12 (relevant to §2.1 `graceful_grace_ms` configurability discussion).
- jemalloc `dirty_decay_ms` / `muzzy_decay_ms` tuning (per V1 ADR M31, ADR-E3-r1): <https://jemalloc.net/jemalloc.3.html> (cited 2026-05-10; r1 reframes as tuning hypothesis, NOT per-kill invariant — codex §2 / §6.5).
- POSIX `kill(2)` negative pid pgrp semantics: <https://pubs.opengroup.org/onlinepubs/9699919799/functions/kill.html> (cited 2026-05-10).
- Linux `prctl PR_SET_PDEATHSIG`: <https://man7.org/linux/man-pages/man2/prctl.2.html> (cited 2026-05-10; r1 Q3 close: omit).
- Codex review report: `docs/reports/2026-05-12-c3-kill-gate-codex-review-r1.md` (in this repo).
- Gemini review report: `docs/reports/2026-05-12-c3-kill-gate-gemini-review-r1.md` (in this repo).

---

*End of SPEC-C3-r1. NO commit performed; awaiting orchestrator review per dispatch r1.*
