# Explicit expired-mailbox recovery (#133)

This is a restricted recovery operation for expired poll-only mailbox sessions.
It does not implement `allow --takeover`, wrapped-process replacement, graceful
incumbent termination, TTY verification or signed WebSocket ownership transfer.
Those paths remain refusals until their custody and handshake protocols exist.

## Admission

The endpoint is `POST /api/sessions/:id/takeover`. It requires all of:

- Strict signed HTTP principal authentication, with the explicitly configured
  `session.takeover` action grant for the exact existing session ID.
- The same stable principal ID and audience as the record's verified
  `owningPrincipal`. An operator key belonging to a different principal is not an
  override. Historical owner-unknown records cannot be adopted.
- The current epoch in the signed assertion's `session_epoch` and in the JSON
  body's `expected_epoch`. Both are checked before mutation; stale concurrent
  operations cannot rotate a successor.
- Type `mailbox`, an expired finite lease, no closing transition, and no owner
  socket, PTY or recorded process PID. Active, wrapped/external/native-process,
  unknown-lease and malformed credential states refuse.
- Valid bounded audit history and a strict readable mailbox custody snapshot.

The body accepts only `expected_epoch` and optional `lease_seconds` (integer
1..3600, default 300). The explicit trusted-key grant is the recovery authority
when the old session bearer is unavailable; a shared daemon secret, ordinary JWT,
same OS account, session name, inherited request metadata or old session bearer
alone cannot invoke it. No grant is enrolled or enabled automatically.

Existing injection approval and ownership-proof policies remain on the record.
Recovery does not approve an inject, rewrite those policies or establish an OS
account/process identity. An ordinary exact-target inject grant elsewhere in the
HTTP adapter addresses the current existing ID at admission; it pins an epoch
only when the signer includes one. Takeover always requires the exact epoch.

## Atomic authority transition

The daemon generates a fresh epoch, bearer, provenance nonce and incremented
credential generation. It writes the verifier and the authority audit event in
one atomic sessions-store generation before indexing or disclosing the new
credential. No raw bearer or provenance nonce is stored in the session file or
audit event. The prior credential is revoked after the committed generation
becomes authoritative; successful responses disclose the new bearer/nonce once.

A pre-rename save failure restores the old live record, credential index, nonce
and audit unchanged and returns 503. If rename succeeded but directory fsync
failed, the new visible generation stays authoritative in memory, the old bearer
is revoked, and the response is 503 with **no bearer disclosure**. It does not
claim durable success. The owner can inspect the visible epoch and recover again
after that lease expires; an active lease is never bypassed to conceal an
uncertain commit. Native filesystem crash guarantees remain those of the session
store; no Windows directory-fsync/DACL guarantee is added here.

## Custody and audit

Mailbox inbox/state rows are never rewritten, dequeued, acknowledged or purged by
recovery. Pending rows keep their original payload, claimed sender and creation
time. Sender labels remain unverified labels; recovery does not authenticate a
foreign sender or turn message custody into task completion.

The transfer uses `FileMailbox.snapshotCustody`, a separate strict reader under
the existing per-session advisory lock. It requires both initialized inbox and
state files and validates their bounded JSONL, message/state relationships,
receiver IDs and stable reads. Missing files, duplicate JSON members, corrupt
records, orphan/unsettled state or excessive data refuse rather than reading as
an empty queue. Limits are 8 MiB per component, 20,000 rows per component, 100 KiB
per JSON record and at most 1,000 pending rows. An uninitialized queue is therefore
not eligible until a valid inbox/state pair exists. Normal delivery's tolerant
readers and the shared JSONL format are unchanged.

The record retains up to 32 `authorityAudit` events. Each event records the verified
principal/key ID, timestamp, old/new epoch and generation, the measured prior state
`mailbox_lease_expired`, pending count and a digest of observed message IDs,
claimed sender labels and creation times. It is a bounded authority history in the
same commit, separate from the asynchronous inject audit log. The snapshot digest
is not a cross-store transactional ledger or a sender/completion proof.

Malformed audit history restores as `authorityAuditInvalid:true`; that marker
survives subsequent saves and blocks recovery until explicit operator repair.
Corruption is not erased into a fresh empty history. Valid history is visible to
already-authorized session inspection callers and restored after restart. Live
`session_takeover` notification is best-effort; the durable event does not depend
on a bus subscriber being connected.

## Evidence and remaining scope

Synthetic tests cover exact ownership/epoch admission, active and unsupported
incumbents, precommit rollback, post-rename uncertainty, concurrent epoch CAS,
invalid audit restoration, strict custody corruption refusal and an owned real
HTTP daemon restart retaining pending rows while rejecting the old bearer.
No production key, mailbox, service or configuration is touched.

Full wrapped takeover still needs a signed ownership transport, an authenticated
graceful-stop acknowledgment, process-birth/custody evidence and a defined handoff
for in-flight PTY writes. A disconnected socket or a reported PID alone does not
supply those facts, so this slice does not claim full acceptance of #133.

New poll-mailbox registration initializes custody before issuing or persisting its session
credential. A newly created queue receives exclusive, private `inbox.jsonl` and `state.jsonl`
files; both files and, on POSIX, their directory ancestry are flushed before registration
can acknowledge success. Existing storage is strictly validated and flushed without
truncation. An existing missing component or corrupt queue is refused, never repaired as
an empty queue.

Initialization and the session registry are separate commits. An initialization failure
returns 503 without a session record, credential or publication event. Unpublished storage
artifacts are retained: incomplete artifacts continue to fail closed and need operator
inspection; complete artifacts from an uncertain flush can be validated and flushed on a
later registration attempt. Registry precommit failure likewise leaves initialized custody
available for retry. Registry post-rename uncertainty retains the existing registry failure
contract (503 without disclosing a bearer). Windows has file flushes but no portable directory
fsync guarantee; this does not establish native Windows account identity or ACL isolation.
