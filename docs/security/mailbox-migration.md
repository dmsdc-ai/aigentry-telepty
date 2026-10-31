# Mailbox lock and client migration boundary

The v2 lock protocol preserves JSONL payloads but does not make unmodified Node,
Rust or external mailbox writers compatible. A regular legacy `.lock` is refused
with MAILBOX_LOCK_LEGACY; no timeout, stale PID, empty content or repeated failure
authorizes its removal. Delivery backs off after this refusal instead of trying
recovery, expiry and dequeue repeatedly in the same poll.

## Read-only inventory

With the source checkout, explicitly select a root:

```
node scripts/mailbox-preflight.js --root /absolute/mailbox/root
```

The script is included in the package file list. It never defaults to HOME or
opens an installed mailbox implicitly. It only reads bounded directory entries
and filesystem metadata: no FileMailbox construction, canonicalRoot creation,
lock acquisition/reaping, chmod, rename, deletion, process signal or data copy.
It neither reads nor emits inbox payloads, lock contents, ticket nonces or process
command lines. Every report states mutated=false, migration_permitted=false,
writer_quiescence=unverified and external_client_compatibility=unverified.

Lock observations distinguish absent, legacy regular file, v2 directory shape,
unknown, unsafe and changing paths. Acquisition entry counts are participation
observations; they never identify a confirmed holder. An idle-looking v2 directory
or absent file is not evidence that all writers stopped. Unknown/unsafe/changed
or over-budget observations are partial, and CLI exit1 reflects incomplete
inspection. Exit0 means inspection completed, not permission to migrate. Bad
arguments (including --force/--migrate) return2 and perform no inspection.

## Why there is no automatic in-place conversion

An unmodified writer does not honor a new migration sentinel or v2 lock. A dead
PID probe cannot exclude a new writer starting later, or a writer holding an
already unlinked legacy lock. Preserving a regular lock and then making a v2
directory leaves a name gap that such a writer could acquire. A --yes switch or
one-off /proc/open-file observation cannot turn those facts into exclusion.

Real migration therefore requires a controlled maintenance boundary: quiesce all
Node/Rust/external clients, retain custody and lock evidence, upgrade every writer
to the same reviewed locking contract, then validate the target filesystem and
PID namespace before reopening access. These are operational prerequisites, not
an implemented automatic permission or a claim that this session proved them.
No installed storage was inspected or migrated while developing this tool.

Rust mailbox locking sources were not available in the searched local project
and task trees. Shared JSONL alone proves no concurrency compatibility. External
client verification and an actual all-writer maintenance window remain blockers
for an operational migration; no source fallback weakens the refusal meanwhile.

Verification checkpoint: six compatibility tests and the real legacy-delivery
backoff regression pass. Independent review found no important read-only/path or
migration-claim defect. Full suite: 2,464 total / 2,461 pass / zero fail / three
existing skips, /tmp/telepty-compatibility-full.log; TypeScript noEmit and diff
checks pass. All exercised roots and child processes were private fixtures.
