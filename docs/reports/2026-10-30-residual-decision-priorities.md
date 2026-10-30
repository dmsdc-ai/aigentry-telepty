# Residual decisions and external acceptance priorities

Follow-up: [fenced-write TTL custody repair and verification](2026-10-30-fenced-ttl-custody.md).
The decisions below remain unchanged; the following pass found and repaired an
independent uncertainty-preservation bug. Latest integrated counts are in that report.

Baseline: local commit 40f3eb99f04ded393d55e6ee8fb48e6bbeaaf10c. Read-only
GitHub reconciliation still contains 55 open issues: 23 local implementations,
29 partial and three remaining. The 32 residual rows are enumerated in the
[custody audit](2026-10-30-residual-custody-durability.md); the
[canonical outcomes](2026-10-29-open-issue-outcomes.md) remain authoritative for
implementation status. This document prioritizes next actions, not issue closure.

## Decisions, in order

| Priority / issues | Concrete choice | Recommended current boundary / implementation consequence |
|---|---|---|
| P0: #133 | May a separately signed task transfer delegate authoritative REPORT ownership to a successor, or must reporting remain bound to the original target? | Retain original reporting authority until an explicit task-transfer contract is chosen. A future contract must bind original task, target, epoch, cancellation and receipt/report delegation; plain-text transfer consent is insufficient. Historical/unconsented or ambiguously attempted rows need independent application deduplication/settlement evidence before resend, even if new consent is obtained. |
| P0: #132, #134, #113, #96, #97 | Which client versions and principal enrollment path must be supported before strict authentication becomes the default? | Stage a versioned strict-client rollout with authenticated enrollment and an inventory of every writer. Keep legacy behavior explicit until migration is authorized. IP/Tailnet membership alone does not establish owner identity; tokenless admission remains refused. General raw/bus/alias authority needs explicit grants, not inheritance from a transport label. |
| P0: #122, #133 | What independent evidence may recover custody after lost credentials, uncertain delivery, or a crash while every persistence write fails? | Retain fencing/unknown status. A recovery design needs an independently enrolled authority and durable evidence or application deduplication; lease expiry, a PID, owner silence or approval to resend does not erase a possible past effect. No forced takeover is enabled by this report. |
| P1: #100, #47, #43, #42 | Are foreign principals to be federated through explicit trusted keys and scoped grants? For references, what may recipients fetch and under whose authority? | Keep existing node-scoped proof until issuer, audience, revocation, replay protection, reference lifetime/content binding and audit durability are specified. Broker reference transfer is additional source/API work, not merely a platform test blocker. An inject grant must not silently become arbitrary fetch authority. |
| P1: #78, #40, #36, #39 | Which independent authority may approve protected SSH/bootstrap/trust/update/resume actions for a precisely identified provider surface? | Continue observation/refusal until an approval adapter and exact action bindings exist. TTY presence, idle state and a captured profile do not attest human consent or installed binary identity. |
| P2: #12, #30, #94 | Is scope to be expanded to provider/Workspace Host implementation or registry publication? | Keep these outside this local repair. Identify the responsible repository/API and authorize that work separately; remote publication remains prohibited in this task. |

These are specification choices, not requests to lower safeguards. Independent
Linux fixes can continue without waiting for unrelated choices when a defect is
reproduced and the expected behavior follows from existing authority contracts.

## External verification, in order

Use disposable installations, private credentials/ports/mailboxes and recorded
versions. Do not run these acceptance exercises against the user's active service.

| Priority / environment / issues | Required fixture and evidence | Pass condition |
|---|---|---|
| P0: native Windows — #131, #130, #115, #116, #21; local-source caveats #128/#129 | Record Windows, Node, npm, shell and terminal versions; test isolated 0.8.5-to-0.9.1 install topology, literal/metacharacter argv and batch launch, controlled file holders, owner-refusal then lookup, missing-session kill, and Warp output relay. Preserve command, stderr, exit status, holder lifetime and before/after installation files. | No libuv assertion/unhandled spawn error, unrelated-process signal or half-installed rollback. Argv reaches the intended child literally; refusal preserves the correct session; output relay continues or returns a measured bounded failure. Linux mocks do not satisfy this gate. |
| P0: native macOS and Windows credential adapters — #92 | Native owner/handle/DACL and ancestor replacement fixtures, unsafe permissions/links, concurrent replacement and unsupported-store cases. | Private authority is read only through a verified native boundary; unsafe/replaced objects fail closed without permission repair. Linux UID checks are not substituted for native evidence. |
| P1: macOS cmux/Warp/launchd/Codex — #31, #58, #95, #106 | Record exact app/provider versions and launch environment. Compare foreground/background MCP initialization, owner claim, PTY output, screen observation and submit timing. Capture causal timestamps and bounded traces around the original stall/blank screen. | Reproduce the original failure, then demonstrate its absence with the relevant fix and a repeatable control. An unrelated parser test or absence of logs does not establish cause. Historical Mac no-ACK remains unresolved until correlated evidence exists. |
| P1: two authorized devices / Telesession / SSH — #96, #98, #102; discovery/trust portions #42/#113/#134 | Explicit enrolled keys/grants and client versions, current owner/epoch, private peers and controlled disconnect, reconnect, lost-response and recipient-claim cases. | Unauthorized principals cannot claim/control. Delivery, child-write invocation, consumption and reply are reported separately; lost response remains unknown unless independent evidence settles it. No inference from IP or silence. |
| P1: Node/Rust/external mailbox clients — #133 migration; compatibility portions #42/#132/#134 | Obtain actual external source/protocol/version and inventory every writer/sweeper. Verify the same lock, custody markers and schema with multiprocess contention/crash tests. Operational migration additionally requires authorized quiescence, backup and rollback rehearsal. | No writer overlaps incompatible protocols; no loss, replay or lock exclusion violation. A stale PID, preflight exit zero or empty snapshot is not proof of quiescence or migration permission. No operational conversion was attempted here. |
| P1: actual provider acceptance — #57, #37, #39, #40, #36, #78 | Known provider/binary version, exact captured surface and independently approved protected actions where relevant. Observe a benign task's accepted turn and correlated result separately from transport receipt. | Actual application acceptance/completion evidence is available. child_write_invoked, submitted argument length, idle and no-enter success alone do not count as consumption or reply. |
| P2: external product/release surfaces — #12, #30, #94 | Responsible provider/Workspace Host repository, intended model/update/picker/focus contract and explicit publication scope. | Implement and validate in the owning surface under separate authorization; this repository's declared metadata cannot attest remote state or registry publication. |

## Verification and limits of this pass

All 32 residual issue IDs occur in the decision/acceptance tables above. The
read-only issue inventory has 55 unique IDs, unchanged from the custody audit.
Additional local inspection did not reproduce a new defect; no runtime behavior
was changed in this pass. The last integrated source checkpoint remains 2,512
passed / zero failed / three skipped out of 2,515, with TypeScript noEmit, syntax
and fixture checks passing, as recorded in the custody audit. That unchanged
suite was not rerun for this documentation-only pass.

The exact three full-suite skips are:

| Test | Skip condition | Separate execution / remaining verification |
|---|---|---|
| `#732 levers (b)(c): an upstream TCP stall is reaped by the daemon heartbeat (not silent)` | `TELEPTY_732_SLOW !== '1'` on the full Linux run; POSIX fixture also excludes Windows. It must outlast the owner WS heartbeat intervals. | Explicit follow-up on dab2952 passed one selected test in 91.3s, `/tmp/telepty-tcp-stall-latest.log`; one unrelated test was excluded by name. This proves fixture heartbeat reaping, not the historical Mac incident's cause. |
| `native Windows npm-style shim preserves literal argv` | `process.platform !== 'win32'` | Native Windows result unavailable; Linux argv fixtures do not replace it. Source: `test/win-spawn-target-115.test.js:62`. |
| `native Windows update refuses before the explicit mock override` | `process.platform !== 'win32'` | Native Windows result unavailable. It asserts exit 1, `guard_blocks_update: true` and no mock npm sentinel; it does not test a successful upgrade/rollback. Source: `test/windows-update-plan-131.test.js:97`. |

No operating service, installed package, credential, network/security setting,
live mailbox, remote repository or registry was changed. External acceptance and
publication were not attempted, rather than denied by an approval tool.
