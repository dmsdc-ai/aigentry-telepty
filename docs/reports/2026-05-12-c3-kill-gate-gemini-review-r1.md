# C3 Kill Gate Spec — gemini review r1 (researcher perspective)

## Verdict
ACCEPT_WITH_MINOR_FIXES

## Top 3 industry-comparison findings
1. **Graceful Escalation Pattern Alignment**: The spec's "graceful (SIGTERM) -> timeout -> forced (SIGKILL)" pattern perfectly mirrors modern cross-platform process management standards, specifically Go 1.20+ `os/exec`'s `WaitDelay`/`Cancel` mechanism and the Rust `tokio-process-tools` crate. (Citation: Go 1.20 Release Notes, tokio-process-tools documentation)
2. **Windows Job Object Race Condition Gap**: The spec omits a critical mitigation for a known Windows race condition. If a parent crashes between `CreateProcess` and `AssignProcessToJobObject`, the child becomes orphaned. Modern Windows apps resolve this using `PROC_THREAD_ATTRIBUTE_JOB_LIST` (Win 10+) or spawning with `CREATE_SUSPENDED`. (Citation: Microsoft Win32 Job Object Documentation, GitHub/StackOverflow discussions on orphaned processes)
3. **portable-pty `kill()` Semantics Recognized**: The spec correctly identifies that `portable-pty`'s built-in `kill()` method aggressively sends `SIGKILL` on POSIX systems, bypassing graceful cleanup. The spec's mandate to use explicit `libc::kill(-pgid, SIGTERM)` is necessary and correct. (Citation: portable-pty issue #2504 equivalent behaviors)

## Section-by-section research findings

### §1 Lifecycle — compare to systemd / kubelet / VS Code pty-host
The 5-stage lifecycle matches the structure of `systemd-run` and `kubelet` pod termination. In `kubelet`, a `preStop` hook runs, followed by `SIGTERM`, a grace period timer, and finally `SIGKILL`. The spec's `draining` state effectively maps to this sequence, making it highly robust.

### §2 Timeout matrix — industry defaults
The `graceful_grace_ms` default of 3000 ms is aggressive compared to general-purpose orchestrators (e.g., `kubelet` defaults to 30s `terminationGracePeriodSeconds`). However, for interactive CLIs (like AI assistants), 3s is historically adequate for final buffer flushes. It is highly recommended to expose this as a configurable parameter if the L3 child is executing long-running workloads (like ML training).

### §3 Cross-OS — established uniformity patterns
The mapping in §3.5 correctly aligns POSIX process groups with Windows Job Objects (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`). However, the spec needs to explicitly address handle inheritance on Windows. If `bInheritHandles=TRUE` is used inadvertently when spawning the child, the child can inherit the job handle, preventing the `KILL_ON_JOB_CLOSE` cascade if the supervisor crashes.

### §4 Child reaping — tokio + SIGCHLD established patterns
The approach aligns with the standard tokio model. Using `tokio::process::Child::wait()` handles the direct child, and an explicit SIGCHLD handler with a `waitpid(-1, WNOHANG)` loop is the established industry pattern to prevent zombie sub-children.

### §5 PTY — portable-pty actual behavior
As noted, `portable-pty` drops slave and master handles. The spec's "Order A" (kill first, master close after reap) is safer than relying on kernel `SIGHUP` generation from dropping the master FD. In standard multiplexers (tmux/zellij), dropping the PTY simply issues `SIGHUP`, but providing explicit `SIGTERM` guarantees the child knows a shutdown is requested before its terminal vanishes.

### §6-7 State / failure — comparable system patterns
Handling uninterruptible sleep (D-state) by logging and abandoning is standard. `kubelet` and Docker handle unresponsive nodes or processes similarly by eventually marking them in an error state rather than hanging the supervisor indefinitely.

### §8 Test scenarios — coverage gaps vs industry CI
The test scenarios are comprehensive. One gap: A test scenario should be added for the Windows race condition (e.g., asserting that if the supervisor crashes immediately after process creation, the child is still part of the Job Object and is killed).

## Missing patterns the spec should adopt
- **Windows Job Assignment Integrity**: Explicitly specify using `PROC_THREAD_ATTRIBUTE_JOB_LIST` or `CREATE_SUSPENDED` during `CreateProcess` to guarantee the child never executes outside the Job Object.
- **Windows Handle Inheritance Mitigation**: Explicitly state that `CreateJobObjectW` must use `bInheritHandle = FALSE` to prevent the child from holding the job open.

## Citations
- [1] tokio-process-tools documentation (Graceful termination phase implementation)
- [2] Go 1.20 `os/exec` WaitDelay release notes (SIGTERM to SIGKILL fallback standard)
- [3] Microsoft Learn: Job Objects - `AssignProcessToJobObject` and `PROC_THREAD_ATTRIBUTE_JOB_LIST`
- [4] Kubernetes documentation: `terminationGracePeriodSeconds` default behavior
- [5] Zellij/tmux signal handling behavior regarding `SIGHUP` and PTY destruction

## Recommendation for next rev
Implement the missing Windows Job Object assignment integrity patterns (PROC_THREAD_ATTRIBUTE_JOB_LIST or CREATE_SUSPENDED) into §3.2 and §8. Accept the rest of the spec.
