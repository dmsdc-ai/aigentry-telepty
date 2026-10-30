# Cooperative handoff: exact product choices

Subsequent implementation: the limited empty-queue cooperative release described
below is implemented and verified in [the continuation report](2026-10-30-lock-cooperative-continuation.md).
The separate legacy ABA finding is repaired by [versioned mailbox locking](2026-10-30-mailbox-lock-v2.md).
Earlier analysis below remains the decision record; its claims of missing source
or an unrepaired lock describe the preceding checkpoint.

Read-only reassessment at `fba220400895eeeb1985fe5f55bb83c565038a53`.
Configured Ed25519 principals establish actors. A kernel PID/UID or child handle
establishes different process facts and must not replace that actor identity.
The earlier [takeover assessment](2026-10-30-wrapped-takeover-assessment.md) was too
strict where it required independent kernel custody for every cooperative ACK.
That requirement is needed for independent process-control/recovery claims, not
for an explicitly authorized owner reporting its own voluntary release.

## Existing external allow can support cooperative release

The current bridge owns its actual node-pty child handle; the daemon does not need
to signal any reported PID. A same-principal, exact-grant handoff request can ask
the bound incumbent bridge to stop accepting writes, drain or refuse its explicit
pending work, terminate its own child through that retained handle and return an
intent/epoch/generation-bound ACK. A valid ACK proves an authenticated incumbent
reported release and, if included, its child-exit callback. It does not prove an
OS-wide process tree died, prove human consent or grant another principal access.

A cooperative-only first slice can therefore retain external `allow`, require the
existing current-bearer owner channel and same configured actor, and refuse every
missing/expired ACK. No kernel peer-credential adapter or daemon-owned launcher
is necessary for that deliberately limited claim. Durable intent, write fencing,
compare-and-swap rotation, pending-message accounting and no duplicate physical
write remain necessary implementation work. Current source has no stop/ACK frame
protocol or persisted transfer state; these facts must not be inferred from4001,
TTL expiry, a disconnected socket or a `ready` frame.

## What genuinely needs a product decision

| Choice | Concrete alternatives and consequences | Safe narrow default |
|---|---|---|
| Cooperative release meaning | Release only the bridge's writer while retaining a child, or terminate the directly held PTY child before ACK. These have different user-visible effects; neither implies all descendants died. | Terminate only the directly held child; ACK names the observed callback and retained handle generation. No daemon PID signals. |
| ACK authority | Accept a current authenticated incumbent's release report, or require independently enrolled OS process evidence before rotation. The latter expands the guarantee and required adapter. | Accept only the scoped cooperative report; expose process-tree status unknown. |
| Missing ACK | Refuse/uncertain, or add separately authorized stale/lost-bearer recovery using independent enrollment. A timeout is not a replacement for the latter. | Refuse without credential rotation or automatic retry. |
| Pending work | Preserve unstarted durable messages with sender/time; reject, quarantine or explicitly resolve already-dispatched/unknown writes and bridge-held text. Replaying unknown writes can duplicate effects. | Refuse transfer while any unsettled physical write or unaccounted bridge queue remains. Preserve unstarted rows unchanged. |
| Replacement launch | Successor continues to run an operator-selected external `allow`, or the daemon becomes responsible for launching a command. This changes process lifecycle and environment custody. | Keep the existing external launcher for a cooperative slice. |
| Automation versus human intent | Explicit same-principal scoped policy can authorize cooperative release; TTY presence is neither required for actor authentication nor proof of a human. A genuine interactive approval UX would be an additional product policy. | No human-attestation claim. No automatic trust/permission acceptance. |

These defaults are a proposal for review, not new granted permissions or shipped
behavior. Existing issuer/enrollment/revocation and immutable approval policies
must remain in force. Another key with the same UID or an operator role alone
must not become the owner principal.

## Kernel peer adapter versus daemon-owned launcher

| Design | What it can establish | What it cannot establish by itself | Required source/platform work |
|---|---|---|---|
| Retain external allow plus Linux Unix-domain kernel peer credentials | The connected peer's kernel-reported PID/UID/GID; with a stable `/proc` boot ID/start ticks, the process incarnation observed at enrollment. | Ed25519 actor, human intent, possession of an arbitrary reported child, or exclusive custody of its descendant tree. Current TCP WS has no peer PID. | A reviewed kernel-credential adapter and enrollment protocol. Node core's public Unix socket API does not expose SO_PEERCRED; an addon/helper would need an explicit supported runtime/packaging contract. `/proc/net` scanning or self-reported PIDs are not substitutes. |
| Daemon-owned launcher with retained child handle | The exact process the daemon itself spawned, its actual handle and observed birth. It can signal that handle within explicitly delegated launch/control policy. | That process's configured principal, a human, remote descendants, or all subprocesses surviving reparenting. A PTY child relationship still needs a defined boundary. | New exact launch authority, command/cwd/env/secret inheritance rules, output/exit ownership, restart/cleanup semantics and explicit integration with external allow. Existing shared-token spawn must not silently become principal-owned enrollment. |

Choose one of these only when requiring independent stale/no-ACK recovery or
central process control. They are not interchangeable identity providers and are
not prerequisites for a correctly labelled voluntary owner release. Linux birth
lookup is available, but its authority depends on which process was enrolled and
why; it cannot establish ownership by observing an arbitrary supplied number.

## Raw control stays a separate contract

A handoff grant must not become a raw-control grant. Existing signed input routes
to canonical HTTP inject, retaining modal/readiness/approval and uncertainty
handling. Typed selection remains limited to exact measured, nonsensitive VT
capabilities. An arbitrary raw key can acknowledge a permission prompt, modify a
command or submit on an unknown surface; a payload string filter cannot prove
otherwise. Existing external approval signs `operation: inject`, not arbitrary
raw text/control/resize. Reusing that signature for a different operation changes
its meaning and is forbidden. A new final-writer arbiter can share fences and
receipts, but it does not supply the missing UI/approval authority. Protected,
sensitive and unknown surfaces remain refused until such an explicit adapter
exists. No kernel identity mechanism supplies that semantic permission.

## Independent Linux locking finding

A separate temporary-fixture reproduction used actual `acquireLock` and
`breakStaleLocks`: acquireA, age its lock70s, sweep it, acquireB, releaseA. B's lock
was removed by A's unconditional release. Current lock tests explicitly require
breaking an aged lock even when its PID is alive. An inode/token check can prevent
that deterministic stale-release case but still has a cross-process check/unlink
race; it cannot make an expired writer's in-progress mutation safe. This finding
needs a lock lease/fencing or kernel-lock contract, not a claim that a PID-age
heuristic is atomic ownership. No live mailbox or lock policy was changed here.
