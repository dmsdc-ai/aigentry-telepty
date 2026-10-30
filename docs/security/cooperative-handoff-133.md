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
four-second ACK budget. It first refuses pending/unknown delivery, held interaction,
bootstrap work or unreadable/corrupt custody. It durably records the intent before
sending a stop request. Awaiting and uncertain intents fence injection, typed/raw
input, geometry, replacement owner claims, re-registration, rename, teardown and
stale-session cleanup. A missing or late ACK cannot release that namespace.

After the ACK, the daemon rechecks exact record, actor, epoch, credential and owner
generations/socket. It holds the mailbox custody lock across the final empty and
unsettled-work checks plus synchronous authority commit. It never moves/dequeues
messages. A publisher acquiring the lock after commit retains its original sender
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
actor and current bearer. The successor's child starts only after its owner ACK.

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
