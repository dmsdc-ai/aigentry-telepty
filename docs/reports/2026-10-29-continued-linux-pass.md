# Continued Linux issue repair pass

This pass follows the explicit request to continue all 15 partial and 19 remaining
items from the first checkpoint. The complete 55-issue disposition is maintained
in [open issue outcomes](2026-10-29-open-issue-outcomes.md). Local implementation
means source and hermetic regression evidence, not native acceptance or a closed
GitHub issue. PR125 and all earlier local changes remain in the commit ancestry.

## Added implementations

| Issues | Delivered source and evidence | Remaining limit |
|---|---|---|
| #122 | Removal precommit before revoke/kill/close; reserved closing state; failure/retry/concurrent-write tests | Natural child exit during persistent I/O failure cannot be undone |
| #92 | Linux opt-in private descriptor-anchored credential channel, exact WS-ACK publication; real child observes new epoch after its test daemon restarts | Consumers must reread; Windows DACL/macOS adapters absent |
| #113/#134 | Exact owned kill plus immutable protected-instance policy; strict principal owner mutations | Legacy operator token stays privileged; no cross-owner operator recovery |
| #78 | One-use external Ed25519 signed inject and digest-only CLI handoff | No human-attestation claim, enrollment service or protected SSH/typed adapter |
| #132 | Linux checked startup public trust, exact signed HTTP action grants, persisted owner principal, bounded replay/clock handling | Strict WS is refused; no hostile same-UID isolation or Windows/macOS identity adapter |
| #133 | Explicit expired-mailbox same-principal takeover with signed epoch CAS, atomic credential/audit rotation and strict locked custody | Active/wrapped takeover still needs signed WS, graceful owner ACK and verified process custody |
| #111/#100 | Scoped exact forwarding, expected epoch, one hop, durable dedup receipts, explicit unverified return host; ambiguity refusal | Foreign session principal remains unverified |
| #42 | Signed hub and outbound recipient stream; exact injection without peer reachability; own three-process topology test | Discovery/ref/broadcast/reply/reconnect and strict-local signer adapter absent |
| #102/#106 | Exact inject correlation, bounded TCP/process probes, bounded UDS replies, durable uncertain-attempt quarantine, asynchronous bounded audit worker queries | Original intermittent stall and missing agent ACK/reply evidence remain unknown |
| #11/#12 | Persistent SSH keepalive/backoff/cancellation, explicit cwd/resume argv, child-bound write receipts; old-daemon capability refusal before registration | No real SSH/native-provider run; metadata declared, not remotely verified; auto-update/model/latest-picker absent |
| #37 | Freshness-bound sustained-idle observations and real bus fixture with zero injected input | Silence cannot establish free/stalled/hung/completed work |
| #96/#97 | Bounded read-only Tailscale candidate listing and accurate README authentication requirements | No address-only trust or automatic enrollment; requested tokenless mode conflicts with current authority boundary |
| #39/#36/#40 | Exact captured Red/Blue selector with bounded VT, owner/epoch/generation/stream/geometry and one-consumption fences; sensitive captured update observable only | Operator-selected profile, native acceptance absent; trust/update/resume/raw-key/protected bypasses refuse |
| #131 | Windows self-update refuses before npm/repair; bounded read-only external recovery plan | Direct npm, native holder verification and transactional rollback absent |

Independent review corrected two broker defects before integration: pending or malformed successful receipts now retain outcome_unknown, and result submission combines shutdown cancellation with a finite timeout. The composed close, signed-inject, SSH-refusal and UDS uncertainty paths had no further Important/Critical findings. A separate strict-principal review passed 34 tests without an important defect.

Independent takeover review also found two defects before integration: tolerant JSONL readers could turn corrupt custody into an empty queue, and restore could discard invalid authority history. A strict lock-held bounded snapshot now refuses unknown custody; a persisted invalid-history marker blocks transfer across restarts. Re-review found both addressed. The Node broker cancellation helper also preserves deadlines without requiring optional AbortSignal.any; abort reason/listener cleanup assertions passed.

The source security defaults remain fail-closed. Synthetic test keys do not become
production enrollment. No code interprets a shared bearer, name, IP address,
reported PID, or same OS account as a distinct original user/agent principal.

## Final integrated verification

**2,311 tests: 2,308 passed, zero failed, three skipped**, 53.5 seconds.
Command: `NODE_PATH=/tmp/telepty-vt-deps/node_modules npm test`.
Log: `/tmp/telepty-remaining-final-full.log`; process exit 0.
The long TCP-stall skip passed separately as recorded below. The other two skips
require native Windows: npm-style shim argv preservation and update refusal before
an explicit mock override. They are not represented as passed. Pinned TypeScript,
changed-JavaScript syntax checks and `git diff --check` passed. All new tests are
registered in both explicit npm test/CI lists (the separate existing PTY-CI split
is retained); the final full run covered every newly registered file.

Disposition: **23 local implementations, 29 partial, three remaining** across all
55 issues. The three remaining are #116 (native Windows/Warp relay stall), #31
(native cmux/Codex MCP-init reproduction), and #30 (orchestration-owned terminal
surface lifecycle). Partial rows explicitly retain unimplemented protocol and
provider/native scope; they are not claims of resolution. Source review completed
without remaining Important/Critical findings in the reviewed broker, principal,
takeover, selector, update-guard and composed close/approval/uncertainty paths.
This is bounded review evidence, not a claim that the entire product is defect-free.

## Earlier verification checkpoints

Before the captured-profile/native-update/takeover follow-ups, full integrated
verification passed **2,229 tests: 2,227 passed, zero failed, two skipped** in 52.4s:
`/tmp/telepty-remaining-integration-3.log`. The skips were the existing opt-in long
TCP-stall test and native Windows argv acceptance. The long TCP-stall case was
then run separately with `TELEPTY_732_SLOW=1`: **one passed**, one unrelated test
excluded by name, in 90.9s (`/tmp/telepty-tcp-stall-slow.log`). Its owned proxy and
PTY demonstrate heartbeat reaping, not the cause of the historical Mac incident.

Additional composed security/audit/broker tests passed 41/41; composed principal
security tests passed 37/37; SSH/UDS tests passed 29/29. Initial integration found
two stale tests: successful mailbox admission after a UDS post-write rejection,
and an exact capability count excluding the new SSH receipt capability. They now
assert conservative uncertainty and the additive receipt contract, respectively;
no production authorization guard was relaxed. Pinned TypeScript and diff checks
passed at each composition checkpoint.

The bounded VT parser is reused from PR84 with exact `@xterm/headless@6.0.0`;
its source archive integrity matches PR84's lock metadata and its MIT notice is
included. Runtime tests use the isolated extracted archive via
`NODE_PATH=/tmp/telepty-vt-deps/node_modules`. Borrowed installed dependencies were
not modified. A clean npm-ci and native platform acceptance were not performed.

## Scope and blockers

All changes are local in `telepty-issues-128-135`, branch `fix/issues-128-135`.
Nothing was pushed, published, released, installed globally, or written to GitHub.
No live user daemon, service, firewall/tailnet policy, credential or SSH host-key
configuration was changed. No Snyk/source-upload scan or TLS bypass was attempted.
The only daemon restarts/kills were test-owned processes under temporary HOME.
No action was denied by automatic approval review; approved hermetic test runs
were used where sandbox OS/subprocess restrictions prevented valid execution.

#116 and #130 need native Windows/Warp traces to tie the original observation to
source behavior; #31 needs native cmux/Codex foreground/background reproduction.
#30's terminal-surface close/focus belongs to the orchestration Workspace Host
under BOUNDARY.md. #94's npm deprecation/publication is outside the authorized
local-only scope. The Mac no-ACK incident remains unattributed. Receipt acceptance,
local PTY write, agent consumption and a reply are always separate facts.
