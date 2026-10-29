# Open Telepty issues: local delivery outcome — 2026-10-29

This is **not a claim that all 55 open issues are resolved**. Every issue and all 11 open PRs were inventoried. Safe independent fixes/features were implemented and composed locally; policy, native runtime and missing-provider work remains explicit. No GitHub issues/PRs were changed.

Input repository: `dmsdc-ai/aigentry-telepty`. Original preserved PR125 head: `2ead16824bf95ad33f8b183a042bf1fa44bf4409`. Earlier local repairs `b6eb33c` and `426df96` remain ancestors. Primary isolated clone: `telepty-issues-128-135`, branch `fix/issues-128-135`.

## Status definitions

- **Local implementation:** requested core code is present and regression-tested here, including three existing fixes retained from the base. This does not mean native acceptance or remote closure.
- **Partial:** a useful correction/surface exists, but explicit requirements or the original reported incident remain unresolved.
- **Remaining:** no complete implementation; native evidence, security authority, provider dependencies, repository ownership or prohibited publication blocks completion.

Counts: **21 local implementations, 15 partial items, 19 remaining**. Of the 21 local implementations, #60/#61/#82 were already present; they were preserved and regression-checked.

## All 55 outcomes

| Issue | Status | Evidence / exact remaining scope |
|---|---|---|
| [#135](https://github.com/dmsdc-ai/aigentry-telepty/issues/135) | Local implementation | Child startup, mailbox recovery and success wait for WS owner token after HTTP registration; refused challenger leaves incumbent untouched. |
| [#134](https://github.com/dmsdc-ai/aigentry-telepty/issues/134) | Remaining | POST kill still has daemon-token operator authority. Owner/operator policy and migration must be resolved with132/113; no arbitrary new identity or weakened owner check added. |
| [#133](https://github.com/dmsdc-ai/aigentry-telepty/issues/133) | Remaining | Explicit takeover waits for trusted principal/operator model, epoch CAS, rotation, mailbox custody and audit; default owner protection remains. |
| [#132](https://github.com/dmsdc-ai/aigentry-telepty/issues/132) | Remaining | No cross-platform user-principal model exists. Kernel identity/verified asymmetric enrollment, roles, revocation and recovery require concrete policy/platform work; same UID/name/token is not distinct identity. |
| [#131](https://github.com/dmsdc-ai/aigentry-telepty/issues/131) | Remaining | Windows native locking not reproduced. Installed npm dispatcher shows retirement/unpack precede hooks; a preinstall hook alone is not a verified solution. External quiescence/recovery coordinator and handle-owner evidence needed. |
| [#130](https://github.com/dmsdc-ai/aigentry-telepty/issues/130) | Partial | Independent incumbent-PID overwrite defect reproduced/fixed. Original Windows owner-refusal then not-found sequence remains unreproduced. |
| [#129](https://github.com/dmsdc-ai/aigentry-telepty/issues/129) | Local implementation | Kill errors use natural exitCode/return for transport teardown. Actual Windows UV assertion acceptance remains native-only. |
| [#128](https://github.com/dmsdc-ai/aigentry-telepty/issues/128) | Local implementation | Owning package CLI launched with Node, spawn errors awaited/caught. Windows global install not run; unrelated startup failures can still require explicit recovery. |
| [#124](https://github.com/dmsdc-ai/aigentry-telepty/issues/124) | Local implementation | Actual listen --json stdout remains JSON across startup, ordinary bus messages and real session reconnect; billboard remains human-oriented. |
| [#123](https://github.com/dmsdc-ai/aigentry-telepty/issues/123) | Local implementation | Output/exit callbacks are child/lifetime-bound; replaced/exited/closed child callbacks cannot alter successor readiness/output/queue. |
| [#122](https://github.com/dmsdc-ai/aigentry-telepty/issues/122) | Partial | Atomic/private store generations and explicit failure-aware ACK/event ordering repaired. Failed irreversible teardown can leave an older committed disk generation recoverable after restart; tombstone/precommit redesign remains. |
| [#121](https://github.com/dmsdc-ai/aigentry-telepty/issues/121) | Local implementation | Idle-port test now checks invocation-owned state, with independent-listener negative control; it no longer blames another suite for occupying a released port. |
| [#116](https://github.com/dmsdc-ai/aigentry-telepty/issues/116) | Remaining | Native Windows/Warp output-relay stall not reproduced; node-pty stream inspection did not establish a missing fallback. No speculative recovery/restart added. |
| [#115](https://github.com/dmsdc-ai/aigentry-telepty/issues/115) | Partial | Shared Windows spawn builder avoids cmd for executables and escapes or refuses unsafe batch input; process execution-policy bypass removed. Native Windows argv acceptance is skipped here. |
| [#114](https://github.com/dmsdc-ai/aigentry-telepty/issues/114) | Local implementation | Graceful shutdown awaits pending/in-flight audit writes; SIGTERM restart regression verifies retained audit row. |
| [#113](https://github.com/dmsdc-ai/aigentry-telepty/issues/113) | Remaining | Shared-token kill/delete/name-squatting policy gap remains; redaction/origin fencing limits leakage but does not create user identity or namespace ownership. |
| [#111](https://github.com/dmsdc-ai/aigentry-telepty/issues/111) | Remaining | Daemon forwarding would delegate stored peer authority to local-token callers; scoped forward permission/hop/receipt identity contract remains unresolved. Existing exact-local and CLI peer routing preserved. |
| [#110](https://github.com/dmsdc-ai/aigentry-telepty/issues/110) | Local implementation | Peer API exposes a public field allowlist and has_token, never stored bearer fields; private stored credentials unchanged. |
| [#109](https://github.com/dmsdc-ai/aigentry-telepty/issues/109) | Local implementation | Post-wait identity/epoch/liveness checks, bounded barrier and owner-bound deferred CR; obsolete pending text is withdrawn. |
| [#107](https://github.com/dmsdc-ai/aigentry-telepty/issues/107) | Local implementation | Ported PR108 deferred-submit pairing and owner-frame tests into current extracted modules. External telesession RC5 suite unavailable. |
| [#106](https://github.com/dmsdc-ai/aigentry-telepty/issues/106) | Partial | Event-loop windows and content-free slow-handler telemetry added; intermittent stall root cause was not measured or fixed. |
| [#105](https://github.com/dmsdc-ai/aigentry-telepty/issues/105) | Local implementation | Registered peer machine IDs/aliases select canonical address, port and credential lane; ambiguity/unknown aliases fail. |
| [#103](https://github.com/dmsdc-ai/aigentry-telepty/issues/103) | Local implementation | Reused PR104 uppercase Codex footer correction and its tests. |
| [#102](https://github.com/dmsdc-ai/aigentry-telepty/issues/102) | Partial | Read-only exact layered API/CLI/MCP scaffold added with bounded probes and explicit unknowns. Per-request correlation, independent host/TCP/scheduler/forwarding proof and external telesession integration remain. |
| [#101](https://github.com/dmsdc-ai/aigentry-telepty/issues/101) | Local implementation | Leased poll-only sessions; owner-only exact poll/ack/renew token lane; enqueue-only outcomes and restart persistence. CLI credential origin/redirect protection retained. |
| [#100](https://github.com/dmsdc-ai/aigentry-telepty/issues/100) | Remaining | Current shared daemon bearer cannot authenticate a foreign session principal. No caller-provided sender host/name is promoted to verified identity. |
| [#99](https://github.com/dmsdc-ai/aigentry-telepty/issues/99) | Local implementation | HTTP shared content is bounded, hash-verified, privately committed and flushed before pointer delivery. SSH retained. Receiver ref_missing/provenance extensions remain separate. |
| [#98](https://github.com/dmsdc-ai/aigentry-telepty/issues/98) | Partial | Tracker remains partial because discovery/auth/native upgrade prerequisites are unresolved. |
| [#97](https://github.com/dmsdc-ai/aigentry-telepty/issues/97) | Remaining | Issue proposes tailnet address as authentication, conflicting with current protect-auth scope and existing regression invariant. No IP-only trust bypass added. |
| [#96](https://github.com/dmsdc-ai/aigentry-telepty/issues/96) | Remaining | Automatic discovery remains unimplemented; observed addresses cannot mint peer credentials or authorization. Auth-preserving enrollment contract needed with97/132. |
| [#95](https://github.com/dmsdc-ai/aigentry-telepty/issues/95) | Partial | Spawn parser preserves literal child arguments and -- separator; explicit --background returns while initial output remains readable. Original reported native blank-screen cause is not proven. |
| [#94](https://github.com/dmsdc-ai/aigentry-telepty/issues/94) | Partial | Local service/bin ownership and migration diagnostics ported from PR112. npm registry deprecation/final legacy publication is forbidden by current no-publish scope and was not attempted. |
| [#93](https://github.com/dmsdc-ai/aigentry-telepty/issues/93) | Local implementation | Existing PR112 user-service implementation ported; fresh descriptor ownership and truthful startup status corrected. Service-manager calls tested through mocks, not native execution. |
| [#92](https://github.com/dmsdc-ai/aigentry-telepty/issues/92) | Partial | Successful registration credentials now update future child environments and are origin-bound. Already running child credential refresh is NOT implemented; secure channel design recorded. |
| [#83](https://github.com/dmsdc-ai/aigentry-telepty/issues/83) | Local implementation | UTF-8 bounded JSON snapshots/splice deltas, unchanged cursors, epoch/id/mode/reset fences and bounded history. |
| [#82](https://github.com/dmsdc-ai/aigentry-telepty/issues/82) | Local implementation | Existing positive absence, restart-off, supervisor and refusal protections retained and regression-verified. |
| [#78](https://github.com/dmsdc-ai/aigentry-telepty/issues/78) | Remaining | Independent one-use digest/epoch-bound approval authority is unspecified. Shared daemon token cannot prove human approval; no bypassable gate was shipped. |
| [#67](https://github.com/dmsdc-ai/aigentry-telepty/issues/67) | Local implementation | Bare-CR wrapping and whole-line spinner detection fixed; actual AI activity does not become task completion. |
| [#61](https://github.com/dmsdc-ai/aigentry-telepty/issues/61) | Local implementation | Existing update/help/restart-verdict and generated launchd PATH fixes retained; no installed plist migrated. |
| [#60](https://github.com/dmsdc-ai/aigentry-telepty/issues/60) | Local implementation | Existing Stage A readiness-versus-completion contract retained and regression-verified; no success/completion inferred from quiet output. |
| [#58](https://github.com/dmsdc-ai/aigentry-telepty/issues/58) | Partial | Existing force-submit API behavior covered by regressions; the original launchd/native sender incident was not independently reproduced. |
| [#57](https://github.com/dmsdc-ai/aigentry-telepty/issues/57) | Partial | Mailbox/submit pairing improved through107/109; live Claude TUI/provider acceptance remains unverified, and no-submit cannot promise a fired turn. |
| [#47](https://github.com/dmsdc-ai/aigentry-telepty/issues/47) | Partial | Existing opt-in nonce provenance supported; full broker/P5 foreign identity and nonce ratchet remain pending. |
| [#43](https://github.com/dmsdc-ai/aigentry-telepty/issues/43) | Partial | Existing local inject audit/verified session-bearer attribution retained, audit shutdown repaired; foreign sender identity is still unavailable. |
| [#42](https://github.com/dmsdc-ai/aigentry-telepty/issues/42) | Remaining | Dormant broker helpers are not a functioning relay product; scoped authentication, forwarding and delivery/return-proof contracts remain design dependencies. |
| [#40](https://github.com/dmsdc-ai/aigentry-telepty/issues/40) | Remaining | Update-modal detection exists; automatic dismissal/provider policy is unimplemented and must not accidentally select an upgrade or trust action. |
| [#39](https://github.com/dmsdc-ai/aigentry-telepty/issues/39) | Remaining | Typed interaction contract is fail-closed; live full-screen selector observation/action provider is missing and needs native measured binding. |
| [#37](https://github.com/dmsdc-ai/aigentry-telepty/issues/37) | Partial | Existing event measures inactivity only; truthful limits documented, free/awaiting-input/stalled classification is not implemented. |
| [#36](https://github.com/dmsdc-ai/aigentry-telepty/issues/36) | Remaining | Force Enter escape hatch exists, but trusted typed modal provider and explicit human approval remain missing; no automatic folder-trust approval added. |
| [#31](https://github.com/dmsdc-ai/aigentry-telepty/issues/31) | Remaining | Requires native cmux/Codex foreground-versus-background MCP-init reproduction; output silence is not proof of MCP/provider failure. |
| [#30](https://github.com/dmsdc-ai/aigentry-telepty/issues/30) | Remaining | Warp UI surface close/focus belongs to orchestration Workspace Host per BOUNDARY.md; no Telepty-owned surface adapter or external repository change was made. |
| [#22](https://github.com/dmsdc-ai/aigentry-telepty/issues/22) | Local implementation | Owner/epoch/generation-bound readiness inspect/wait CLI and exact API; no credential mint, keys or repair. Unsupported/uncertain surfaces remain explicit. |
| [#21](https://github.com/dmsdc-ai/aigentry-telepty/issues/21) | Partial | Windows/Codex/Warp tracker; source fixes exist but native acceptance is not established by Linux mocks. |
| [#12](https://github.com/dmsdc-ai/aigentry-telepty/issues/12) | Remaining | Remote AI cwd/resume/version/bootstrap aggregate feature remains; depends on persistent SSH/readiness/native selector support. No remote CLI installation/upgrades were authorized or performed. |
| [#11](https://github.com/dmsdc-ai/aigentry-telepty/issues/11) | Remaining | Native persistent SSH lifecycle is not implemented. Requires reconnect/input-custody and remote bootstrap/host-key acceptance tests; generic auto-restart is not represented as equivalent. |

## Integration and review

Existing PR work was reused instead of replaced: PR104 readiness expressions/tests, PR108 submit pairing, PR112 service/bin ownership; PR125 contracts were preserved. Changes live in isolated clones and were cherry-picked into the primary clone. Conflicts preserved atomic storage/save-before-publication, async audit shutdown plus telemetry cleanup, credential-origin/redirect protection plus read-only auth, and both mailbox/shared-reference route registration.

Review found and corrected additional Windows/macOS uninstall ownership errors, misleading disabled-service startup reporting, PowerShell policy bypass, session bearer/cross-origin redirect leaks (including the new poller), shared-reference directory durability, and screen cursor epoch binding. Readiness and modal fixture composition was corrected without weakening production owner/identity checks.

## Explicit limits and authorization

No installed Telepty, production daemon, service manager, network/security configuration, credential provisioning, remote branch, release or registry entry was modified. No live SSH/provider/UI test, npm global upgrade, Snyk/source-upload scan or TLS bypass was performed. Native Windows ConPTY/DACL/NTFS/npm locking and native systemd/launchd/schtasks/Warp/cmux acceptance remain unverified. No denied operation was retried or bypassed; isolated test execution used approved permissions after sandbox-only OS/subprocess failures.

The Mac no-ACK incident is not attributed to these defects and is not claimed resolved. Delivery acceptance, PTY writes, consumption and reply remain separate observations. Per-request messaging facts in the new diagnostics remain unknown when no correlation is available.

Security decisions and required authority/enrollment/revocation/recovery contracts are detailed in [security-decisions](2026-10-29-security-decisions.md). Original source/PR classifications are retained in [inventory](2026-10-29-open-issue-inventory.md); the earlier focused repair evidence is in [128–135 report](2026-10-29-issues-128-135.md).

## Verification

Final integrated verification: **2,092 tests; 2,090 passed, 0 failed, 2 skipped**, 47.3 seconds. Log: `/tmp/telepty-all-integrated-release-review.log`. Skips: existing slow #732 TCP-stall test (`TELEPTY_732_SLOW=1` required) and the new native Windows shim-argv test. Neither is represented as passed. Pinned TypeScript check and `git diff --check` passed. Interim first composition: 2,031 passed, eight failures (seven obsolete unregistered modal fixtures, one initial-PTY metadata race), two skipped. Next composition: 2,084 passed, one failure (new readiness fixture lacked the explicit successful persistence result), two skipped. The fixtures were corrected, not the production guards; targeted final readiness/durability/mailbox composition passed 30/30. The fresh full-suite result above is from the corrected final composition.

Pinned compiler: TypeScript6.0.3 and @types/node20.19.41 in `/tmp/telepty-typecheck-deps`; typecheck is run against primary source with `--noEmit --typeRoots /tmp/telepty-typecheck-deps/node_modules/@types`. Runtime dependencies are borrowed read-only through a local symlink; a clean npm-ci/install was not performed.


Final independent review also reproduced a service confirmation-time ownership race.
Commit `98e653f` now snapshots the approved target/descriptor/actions and rebuilds the
plan after confirmation; a changed or newly refused plan performs no mutation.
Independent in-memory install/uninstall changed/unchanged assertions passed, with no
remaining important findings. The final full-suite numbers above include that fix.

All final test files are registered in the repository's explicit npm test commands.
No application installation, service execution, credential enrollment, publication,
remote push, issue closure or PR update is part of this delivery. The primary clone
and local commit chain are the reviewable deliverables; the 34 partial/remaining
items above are explicitly **not** declared resolved.
