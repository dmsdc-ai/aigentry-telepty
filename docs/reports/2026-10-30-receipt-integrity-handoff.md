# Receipt integrity and remaining live-handoff scope

Subsequent continuation: the legacy ABA defect below is repaired by the
[versioned mailbox lock](2026-10-30-mailbox-lock-v2.md). The earlier finding and
verification checkpoint below are retained as historical evidence.

Repository: dmsdc-ai/aigentry-telepty. Local branch fix/issues-128-135;
implementation commits e2ab893 (receipt correlation/envelopes), 85fc4bb
(persisted receipt reader) and 5d3c75a (handoff assessment correction).
Read-only GitHub refresh: 55 open issues; PR125 remains OPEN/draft at
2ead16824bf95ad33f8b183a042bf1fa44bf4409, preserved as a local ancestor.
The canonical issue inventory still has 23 local implementations, 29 partial and
3 remaining; this is not completion or closure of all 55 issues.

## Implemented

- Input and bus clients bind a returned receipt ID to the actual configured
  principal, exact session/epoch, effect and caller idempotency key. The existing
  v1 deterministic hash is shared with the server; it is correlation, not a
  cryptographic receipt signature.
- Persisted remote receipt fields cannot overwrite authoritative state, identity,
  epoch or effect. Bounded result fields are reprojected through the effect's
  validator; inconsistent accepted records fail unknown without replay. Present
  actor metadata must match the authenticated actor; absent legacy metadata
  remains compatible. Explicit delivery uncertainty wins over success-looking
  HTTP/publication data. Dispatch still does not establish consumption or reply.
- The generic persisted ledger reader rejects duplicate JSON keys, invalid UTF-8,
  changed inode between observation/open, nonregular or multiply linked files,
  partial/oversized reads, observed disappearance and mutation during reading.
  These checks are not at-rest authentication against a hostile same-UID writer.
- The four new ledger integrity regressions are included in both npm test lists,
  before their existing fixture-diff guard.

## Verification

Full npm test with NODE_PATH=/tmp/telepty-vt-deps/node_modules:
**2,450 total / 2,447 passed / zero failed / three skipped**, 58.6 seconds.
Log: /tmp/telepty-receipt-integrity-full.log. Skips remain the opt-in long TCP stall
and two native Windows cases. TypeScript noEmit and git diff --check pass.
Independent reviewers found no concrete defect in the receipt binding/cache
changes and in the descriptor/JSON reader. The final integrated follow-up also
found no concrete defect in uncertainty projection or present-actor validation. Private fixtures only; no installed daemon was used.
Windows/macOS native acceptance and the historical Mac no-ACK incident remain
unverified.

## Remaining implementation and decisions

See [cooperative handoff choices](2026-10-30-cooperative-handoff-choices.md).
A cooperative live handoff can rely on the authenticated incumbent quiescing its
writer, terminating its directly held PTY child and acknowledging a durable exact
intent. Label this incumbent-reported release, not independently verified process
tree death or human approval. It still needs a complete write fence, durable
intent/ACK protocol, epoch CAS, restart suppression and pending/uncertain work
accounting. No live-handoff runtime or general raw-control route was added here.
Do not weaken current refusals or treat owner WS dispatch as release proof.

Recommended limited first contract: retain external allow, require cooperative
intent-bound ACK after the held child callback, preserve only unstarted pending
messages with their original sender/time, and refuse unaccounted/uncertain writes.
No-ACK recovery, independently verified process custody, and daemon-owned launch
are separate stronger authority/deployment choices. TTY presence proves neither
human consent nor configured principal identity.

A further legacy mailbox-lock defect is reproduced, not repaired:
`node test-support/mailbox-lock-aba-repro.js` creates its own temporary fixture;
it shows an aged live owner's lock being broken and its later release deleting
the successor's lock. Its exit zero means the known defect reproduced, not a
passing product regression. The full green suite does not negate this finding.
An inode check followed by unlink alone cannot solve the concurrent ABA problem.
A sound replacement needs a reviewed atomic locking protocol/backend, no live
age preemption and an explicit mixed-version policy for external mailbox clients.
The diagnostic never accepts an operational mailbox path and cleans its fixture.

All changes are local source only. No push, remote issue update, release,
installation, daemon restart, live network/security setting or credential change.
