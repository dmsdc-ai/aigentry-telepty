# Cooperative wrapped-child handoff (#133)

This opt-in Linux signer/CLI slice terminates the incumbent's directly held PTY
child cooperatively before rotating its session authority. It does not force
recovery without an ACK, signal a reported PID, attest a human, prove all process
descendants died, or replay an uncertain write. Existing external approval policy
remains immutable. Default `allow` and the expired poll-mailbox takeover protocol
are unchanged. This process-release API is distinct from the existing `telepty
handoff` deliberation/synthesis commands; those commands confer no process authority.

## Enroll a new local wrapper

Use an already configured strict principal client file with explicit exact grants
for `session.register`, `session.owner`, and `session.takeover` on the selected SID.
Existing registration policy requires an operator key to create a wrapped record.
Set `TELEPTY_COOPERATIVE_HANDOFF=1` and `TELEPTY_PRINCIPAL_CLIENT_FILE` when launching
`allow`. This initializes strict empty custody for the daemon and bridge before
handoff can be offered. The capability is fixed at first registration; enabling an
environment flag cannot retroactively adopt an existing record. SSH child mode is
unsupported. The owner ACK must explicitly advertise cooperative handoff before
the child starts; an older daemon cannot silently downgrade this opt-in.
No key enrollment or daemon/service startup is performed.

The bridge retains its actual child handle. A stop request is accepted only over
the current signed owner channel with matching epoch, credential generation and
owner generation. The bridge checks its own pending mailbox, scheduled writes and
pending frames, fences local/automated writes, and sends SIGTERM through that
handle. Only its production callback for that same child may report exit. It does
not restart the child or send a teardown DELETE during release. A child ignoring
SIGTERM is retained, including after socket loss; no timeout escalates to SIGKILL.

## Request and inspect

`GET /api/sessions/:exactId/handoff` and `POST` on the same path require an exact
`session.takeover` HTTP assertion, current signed epoch and the same stored owning
principal. POST additionally requires the current `x-telepty-session-token`.
An operator role for another principal is not an override. The POST body is:

```json
{
  "intent_id": "a freshly generated UUID",
  "expected_epoch": "current epoch",
  "credential_generation": 1,
  "owner_generation": "current owner generation"
}
```

GET provides the current public generations and intent state. POST uses a finite
four-second ACK budget. By default it refuses pending/unknown delivery, held interaction,
bootstrap work or unreadable/corrupt custody. It durably records the intent before
sending a stop request. The explicitly consented pending-text extension below is
opt-in; old unmarked queues retain the refusal. Awaiting and uncertain intents fence injection, typed/raw
input, geometry, replacement owner claims, re-registration, rename, teardown and
stale-session cleanup. A missing or late ACK cannot release that namespace.

After the ACK, the daemon rechecks exact record, actor, epoch, credential and owner
generations/socket. It holds the mailbox custody lock across the final empty and
unsettled-work checks plus synchronous authority commit. The authority-transfer operation never moves/dequeues
messages. The successor later dispatches eligible text through the separate one-attempt path below. A publisher acquiring the lock after commit retains its original sender
label and timestamp; those labels are not upgraded to authenticated provenance.
Any unsettled physical write or unaccounted bridge queue refuses transfer.

A successful commit persists epoch/verifier/generation and a bounded
32-event handoff audit with actor/key/audience, old/new instance, intent and measured
incumbent exit report. Old credentials are revoked before the successor credential
is returned once. The runtime nonce/index is updated after the visible commit;
the registry stores neither raw bearer nor provenance nonce, and this feature does
not add nonce persistence across restart. `child_exit: incumbent_report_only` and `process_tree: unknown`
make the guarantee explicit. There is no consumption, completion or reply claim.

## Start the explicitly chosen successor

The successful response contains the new session token and nonce. Do not log it.
An explicit private file can carry these fields to a new `allow`:

```json
{
  "schema": "telepty.handoff-credential/v1",
  "session_id": "exact SID",
  "origin": "http://127.0.0.1:configured-port",
  "session_epoch": "response session_epoch",
  "session_token": "response session_token",
  "session_nonce": "response session_nonce",
  "credential_generation": 2
}
```

Set `TELEPTY_HANDOFF_CREDENTIAL_FILE` alongside the checked signer file and
cooperative flag for that successor launch. The file is read through the existing
Linux private authority-file checks, with exact SID/origin/epoch binding; both
file handles' environment paths are removed from the child. The product does not
write this credential file or infer authority from inherited ambient session
tokens. The signed registration and owner handshake still verify the configured
actor and current bearer. The private-file path also sends both
`expected_epoch` and `expected_credential_generation` registration preconditions.
The server refuses a missing/mismatched instance before issuing any credential;
the CLI requires `registration_instance_matched: true`, a re-registration and
matching epoch/generation. Older responses lacking this evidence refuse before
an owner socket or successor child starts. The successor's child starts only after its owner ACK.

## Refusal, uncertainty and restart

An explicit incumbent refusal commits `refused` without rotation. Missing ACK,
late ACK, changed generations, new pending work or failed uncertain storage never
mint a success response. A pre-rename authority failure restores the old verifier
and retains an uncertainty fence; a visible post-rename generation remains
indexed, revokes the old credential, and returns503 without disclosing a bearer.
A lost response or repeated intent never repeats stop/rotation or discloses the
credential again. Inspect first; there is no automatic retry or force recovery.

Intent and audit state persist. Restart does not manufacture an ACK, resume a stop
request, clear an uncertainty fence or remove the reserved SID. Present malformed
intent/audit data restores as an invalid uncertainty fence, not absent authority.
There is currently no automatic recovery operation for an unresolved fence or a
lost successor credential. Such recovery needs a separately reviewed explicit
policy; deleting by name or timing out is not that policy.

Tests use synthetic keys, temporary HOME private daemons and owned Node PTY children.
They exercise child-exit success, actual successor launch, ignored SIGTERM/no ACK,
restart and shortened stale cleanup, namespace/input denial, late ACK/generation
changes, corrupt restoration, held write timers, mailbox lock exclusion and
pre/post-rename fault handling. No installed provider or user service is controlled.

## Explicit never-attempted pending custody

The default remains empty-only. A sender may use the strict signed HTTP inject
route with `allow_cooperative_handoff:true`, `exact_target:true`, the current
`expected_epoch`, and `no_enter:true`. The first slice accepts nonempty valid
Unicode text up to4096 UTF8 bytes without control characters. It refuses truthy
`from` (which retains the existing tracked-task semantics), submits, SSH,
externally approved/protected targets and provenance-capable targets. Ordinary
unflagged injection and tracking are unchanged. The stored default claimed sender
label remains `inject`; the separate consent descriptor records the configured
verified sender principal/key/audience, request/proof digests, recipient principal,
original epoch/owner generation and exact stored-message digest. This is
producer-recorded consent under the cooperating private-file protocol, not a
cryptographic at-rest signature or foreign/human identity attestation.

The receiving owner must additionally request `pending_policy:"never-attempted"`
on the signed handoff POST. At most8 messages qualify. Each must have one original
attempt-zero inbox row and one producer-marked initial pending journal row, with
valid sender consent for that exact recipient principal and original instance.
Old unmarked rows, retries, in-flight work, unknown results or incomplete/corrupt
history refuse. Compaction preserves the marker only for an inspected untouched
history; it never reconstructs consent or eligibility from a latest pending label.
Both custody files and their directory are flushed before the intent/authority
records can claim durable custody. Final comparison and epoch CAS hold the mailbox
lock and require the same full-content digest and count captured before stop.
Message payload, claimed sender label and creation time are never rewritten.

The handoff audit retains the exact captured message IDs/digests plus aggregate
content digest/count and policy. Only those sender-consented IDs may cross the
old in-memory target binding after the authority commit; no generic binding is
cleared. A successor must present its current owner proof and advertise
`pending_handoff_receipts:"v1"` on a generation-bound ready frame. This capability
is not persisted or inherited by a replacement socket. Missing/older capability
leaves custody untouched; there is no legacy inject fallback or implicit upgrade.
Each pending attempt also waits for fresh current-owner readiness and existing
modal checks. The bridge independently checks current child/owner/input/geometry,
deadline, readiness, known modal denial and an empty bridge queue.

Before sending, the daemon durably records `pending_dispatch_started` for that
exact ID. A separate bounded `pending_handoff` frame binds request ID, SID, new
epoch/owner, intent, message/content digest and payload hash. The bridge consumes
one cached attempt before invoking its actual held child's `write`; it never parks
this frame or retries it through the generic bridge queue. Its receipt says
`child_write_invoked`, reports argument `submitted_bytes`, and keeps
`bytes_written:null`. That is not proof of OS-level byte consumption, agent
consumption, completion or reply. Current-owner receipts are checked against the
exact attempt and deadline even if a timer callback was delayed. The daemon
persists the invocation report before allowing normal mailbox ACK processing.
A second pending message requires fresh ready evidence, rather than concatenation
or a stale ready flag from the first.

Missing/refused/late receipts, partial throws or storage uncertainty retain the
original payload in quarantined unknown custody and never authorize another
attempt. A visible dispatch claim survives restart and prevents replay even if a
known-ACK row was subsequently compacted and the same old ID/content reappeared.
Explicit unknown journal/payload tombstones survive compaction and remain a fence
even after the optional DLQ is purged; a generic later ACK cannot settle them.
Malformed evidence is not repaired away by compaction. A normal attempt fence
followed by a known terminal result is dispatch history, not an unknown result
or a consumption assertion.

Captured pending/unknown work also reserves rename/delete/kill and unsafe delivery,
SSH or provenance reconfiguration; legitimate successor command/cwd/PID registration
remains supported and updates the current command classifier. Known invocation
reports alone do not release custody. Normal explicit close requires every
captured ID's matching known ACK evidence, flushed under the custody lock. If
compaction already removed that evidence, missing rows do not prove settlement:
the first slice conservatively retains the reservation. Automatic stale cleanup
also retains committed pending histories. No force-discard or uncertainty-settlement
policy is added. A sender/owner may inspect or arrange separately reviewed recovery;
there is no automatic replay to trade safety for availability.

Additional tests use a sender key distinct from the recipient owner's key, two
actual HTTP-consented messages and real successor PTY capture, including private
daemon restart. They verify one invocation per message with fresh prompts, exact
stored metadata/content, default/unconsented refusal, durable claim faults, late or
duplicate receipts, one-attempt timeout quarantine, old-capability refusal,
malformed/compacted uncertainty and pending-aware teardown. These tests do not
establish native Codex/Claude/provider or mixed Rust mailbox acceptance.


## Explicit consent for pending text

The default POST policy remains `empty`. The optional `pending_policy` value
`never-attempted` permits at most eight bounded, producer-recorded, unattempted
messages, and requires **both** sender and current-owner consent. The sender must
use a configured HTTP `session.inject` key on the exact current SID/epoch with
`exact_target: true`, `no_enter: true`, and `allow_cooperative_handoff: true`.
The current owner separately requests the above policy under its takeover grant
and current bearer. An owner's takeover grant alone never overrides a sender's
original epoch binding.

This first slice accepts only untracked printable text of at most 4,096 UTF-8
bytes: no nonempty `from`, control/newline/separator bytes, invalid UTF-8, automatic
submit, SSH, protected external-approval target or provenance-banner target.
Ordinary unflagged tracked injection is unchanged. A nonempty `from` retains its
normal task/report semantics and is refused for this opt-in rather than silently
converted into an untracked message. For supported untracked requests the stored
claimed origin remains `inject`; the configured sender principal is a separate,
verified-at-admission record. Neither label becomes human or OS identity.

The queued descriptor records sender/key/audience, original SID/epoch/owner
generation, recipient principal, request/proof digests and the exact message hash.
The initial pending journal marker is emitted only by this opted-in producer.
Legacy, retried, in-flight, duplicate-history, uncertain or unmarked rows cannot
acquire eligibility through compaction. Capture checks all pending messages; it
does not drop an ineligible subset. Original ID, claimed sender, creation time,
payload and queue bytes remain unchanged. Custody files/entries are flushed before
claiming durable transfer, and their full digest/count must match under the final
lock. These are trusted-storage admission records, not signed at-rest attestations
against arbitrary same-UID file tampering.

A successor must prove the new owner epoch/generation, advertise the authenticated
v1 pending-write receipt capability and present fresh current-owner readiness.
Old consumers or stale/missing capability leave the queue untouched before
dequeue; they do not fall back to generic inject or force a client upgrade.
Observed prompt/readiness evidence and known modal filters are dispatch gates,
not evidence of human approval. Protected/sensitive control authority is not
transferred by a text flag.

Before one bounded WS frame, the daemon fsyncs the attempt fence and persists an
exact message dispatch claim. The bridge checks exact SID/new epoch/current owner,
intent/message/request IDs, full message and literal payload hashes, deadline,
actual held child, input/geometry generations, idle/modal state and an empty
bridge queue. It records the one-use result **before** `child.write` and never
parks or retries this frame. The cache has eight entries without eviction. It
rechecks binding and deadline after potentially blocking readiness inspection.
Duplicate frames, changed payloads, late ACKs, partial exceptions and lost receipts
never authorize a second write.

A matching response reports `child_write_invoked`, submitted argument bytes,
`bytes_written: null`, and consumption/reply `unknown`. It proves the held-child
write API was invoked, not actual PTY consumption or application completion.
A persisted invocation receipt plus strict ACK custody may settle the transport
reservation. A dispatch-started claim alone does not. Late/partial/timeout or
uncertain storage preserves original payload and uncertainty, without replay.

Committed pending custody additionally reserves its SID from rename, deletion,
kill, automatic cleanup and unsafe delivery/provenance reconfiguration until
settlement is provable. Legitimate checked successor registration remains
available. Explicit unknown journal history and payload survive compaction and
DLQ purge; generic later ACKs cannot erase them. Malformed evidence is not repaired
away. A [new private transport-ACK proof](pending-transport-ack.md) can preserve exact
settlement before normal compaction. Legacy/generic ACK rows pruned without that
proof remain reserved rather than manufacturing settlement from absence.
Unresolved fences still have no automatic recovery API.
