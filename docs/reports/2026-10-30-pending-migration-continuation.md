# Consented pending custody and migration preflight

Primary checkout: telepty-issues-128-135, branch fix/issues-128-135.
Baseline cb4a344d92bb47486cdef34ef0f0e43106a4d8dc. All work is local source;
no installed service, live mailbox, credential or network/security setting was
changed. No remote push, issue update, merge, release, installation or migration.

## Deliverables

- 2d87c93: [read-only migration preflight](../security/mailbox-migration.md) and
  legacy/corrupt lock refusal backoff. Explicit-root metadata inventory never
  initializes/reaps a lock, reads message contents or grants migration permission.
  Six compatibility regressions and the real legacy backoff case pass.
- a2199db: exact epoch/generation CAS for a private handoff credential's adoption.
  Missing, stale, partial or malformed preconditions refuse before namespace or
  verifier issuance. The CLI requires the explicit applied bit and matching
  existing epoch/generation before any owner socket/child; unsupported old
  responses cannot silently create a different session. Nine new server/actual-CLI
  cases plus existing real successor tests pass. Ordinary create is unchanged.
- 5bcb889: normal lock release can leave a zero-link inode visible during lstat.
  Full-suite writer/sweeper churn reproduced the false unsafe-path error. The
  deterministic held-descriptor regression now accepts only a vanished regular
  zero-link ticket; hard links, symlinks or present substitutions remain refused.
- 657aa60 (candidate 23a5f1110a7bac803dd6cd14e75aab0b6d3d1d7d): explicit
  [pending text handoff](../security/cooperative-handoff-133.md). It requires
  signed sender opt-in plus the current owner's separate takeover approval,
  exact captured message bindings and never-attempted producer history. At most
  eight untracked printable messages of 4,096 bytes each are supported; tracked
  `from`/report tasks, controls/newlines, protected/provenance targets and SSH
  retain refusal. Unflagged/old queues never acquire consent retroactively.

The authority commit preserves original message IDs, stored claimed sender,
creation time and full queue bytes under a flushed custody lock. Tests use distinct
configured sender/recipient principals; the supported stored claimed origin stays
`inject` and is not upgraded into verified identity. A fresh capable successor
receives one bounded attempt per captured ID. A durable dispatch claim precedes
one WS frame; the bridge binds hashes/generations/deadline/actual child and caches
before one child.write call. It never parks/retries this frame. Old capability,
late response, partial exception, changed binding or lost receipt cannot authorize
another attempt. The result is child_write_invoked with submitted argument bytes,
physical bytes unknown, and consumption/reply unknown—not task completion.

Committed pending custody reserves the SID against rename, teardown, automatic
cleanup and incompatible reconfiguration until persisted invocation receipts and
matching strict ACK custody are available. Legitimate checked successor startup
remains allowed. Unknown journal history and original payload survive compaction
and DLQ purge; malformed evidence is not silently repaired. Missing/pruned ACK
proof stays reserved. No automatic settlement or forced unknown recovery was added.

## Verification

Final integrated full npm test: **2,492 total / 2,489 passed / zero failed /
three skipped**, 64.9 seconds; /tmp/telepty-pending-migration-full-final.log.
Skipped cases remain the opt-in long TCP stall and two native Windows cases.
TypeScript noEmit, node syntax, fixture-diff guard and git diff checks pass.
The original PR125 SHA remains an ancestor.

Actual private Linux topologies verify two independently consented Unicode
messages reaching a real successor child once, including across daemon restart,
with unchanged queue bytes/sender/time at transfer and no replay after compaction.
Unconsented pending text refuses before stopping the incumbent. Pure cases cover
stale resolver snapshots, malformed/unknown history, compact/purge retention,
one-use cache, blocked/expired gates, late ACKs, lost receipts, pre/post-rename
claim faults, restored claims, production teardown and missing ACK evidence.
Candidate focused run: 29/29; earlier broad composition: 235/235. The initial
adoption full run had one normal lock-departure failure; it is reproduced and
fixed in 5bcb889, and the final complete rerun passes.

Independent reviews found and confirmed fixes for unknown-history erasure,
committed-pending rename/delete loss, deadline crossings and ordinary lock
release races. Final review of 657aa60 found no remaining concrete important
finding; separate adoption/frame reviews also found none after fixes. Reviewers
ran isolated tests; only the root's full run establishes the complete count above.

Read-only GitHub refresh still reports 55 open issues, no additions/removals from
the previous inventory, and PR125 OPEN/draft at
2ead16824bf95ad33f8b183a042bf1fa44bf4409. Source disposition remains 23 local /
29 partial / 3 remaining. This advances partial #133; it does not close all issues
or establish the cause/fix of the historical Mac no-ACK incident.

## Remaining work and operational blockers

Source limitations: tracked task/report transfer, legacy/unconsented import,
multiline/control/provenance/protected input transfer, automatic recovery from
lost credentials/unknown outcomes, and a durable settlement ledger after ACK
pruning remain unimplemented. They are not claimed solved by the narrow text path.

Operational conversion of a legacy `.lock` and upgrades of existing clients were
**not attempted**: service/install changes are outside this authorization, and
metadata, stale PIDs or a new sentinel cannot prove every old writer quiescent.
A controlled all-writer maintenance boundary, backups and verified compatible
Node/Rust/external clients are prerequisites. Local source search and accessible
owner-scoped GitHub code search found only Telepty references, not the referenced
Rust implementation/spec; this is not proof that no such implementation exists.
The read-only preflight reports quiescence and external compatibility unverified.
Windows/Warp relay #116, native cmux/Codex MCP reproduction #31, and the external
Workspace Host responsibility in #30 retain their previously recorded blockers.
Native Windows/macOS acceptance was not performed.

## Execution provenance

The parent Codex thread 01a1727a-b041-75ba-a09c-3f72019370d0 delegated this work to
this Linux Codex workspace; implementation and independent review used subordinate
agents. Runtime metadata reports process.platform=linux and the checkout above;
TELEPTY_SESSION_ID and TELEPTY_AVAILABLE are unset. No live Telepty orchestrator
session was contacted or commanded. These observations do not establish whether
an existing Linux orchestrator directs other tasks or its overall activity.
