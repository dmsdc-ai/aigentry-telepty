# Wrapped takeover reassessment (#133)

Read-only source assessment at `eba1f74cfff494abcf4746af223c037e53a0a645`.
The exact issue asks for explicit same-principal takeover, graceful incumbent
termination when alive, credential/epoch rotation, pending-message inheritance
with original sender/time, and an authority audit. Default refusal must remain.
The new strict owner transport removes the previously missing signed-connection
prerequisite; it does not complete those other requirements. #133 stays Partial,
and the overall55-issue disposition stays23 local /29 partial /3 remaining.
No runtime, service, process or authority mutation was performed for this review.

## Evidence in the current source

- `src/transport/strict-owner.js` authenticates an exact owner grant, current epoch,
  stored principal and existing bearer over literal loopback or actual TLS. It
  binds record, credential generation and current owner socket/generation for a
  finite connection. It does not provide lost-bearer recovery. The supported
  reconnect path retains the epoch; it does not rotate session credentials.
- `src/transport/websocket.js` retains the existing current-bearer owner replacement
  lifecycle, including closing the previous owner with4001. A signed caller with
  the existing bearer can use that lifecycle; this is not a separately authorized
  `session.takeover` transaction or an incumbent graceful-stop acknowledgement.
  The owner whitelist contains no stop-request/stop-ack protocol. Socket expiry,
  disconnect and close4001 do not prove the child exited.
- `src/routes/session-records.js` accepts reported `owner_pid` on registration;
  `src/session-store/persistence.js` stores/restores reported owner/PTY PIDs.
  Neither establishes kernel-observed process birth or custody. The strict owner
  URL intentionally supplies no PID/command authority. A `/proc` PID lookup alone
  cannot upgrade a caller-selected PID into an owned child handle.
- `src/principal/takeover.js` deliberately accepts only expired poll-only mailboxes
  without an owner socket, PTY or recorded PID. It commits new authority/verifier
  and a bounded audit together, then updates the credential index. It refuses
  wrapped records before any mutation. Its locked custody snapshot protects
  existing mailbox rows; that does not settle a delivery already written to a
  live PTY or held by a bridge's separate pending queue.
- The existing `handoff` CLI/API is synthesis/task data exchange. It is not an
  authority-transfer protocol and must not become one by sharing the name.

## Safe next implementation slice

A bounded, read-only takeover preflight could report the exact current epoch,
owner generation and measured transport state after existing owner inspection
proof. It must label process custody and outstanding write outcomes unknown and
must neither mint credentials, signal PIDs, mark a socket stale nor move messages.
Existing inspection already exposes much of this information. An unused pure
planner would add no recovery capability, so this assessment adds no dormant
runtime or new grant.

The useful next behavioral slice is an explicitly authorized handoff-intent
transaction, designed separately before changing the live lifecycle:

1. A same-owner `session.takeover` request binds exact SID, epoch, credential and
   owner generations, a random intent ID and a short expiry. Persist the intent
   before publication. Admission alone leaves current authority unchanged. A
   repeated intent queries its state; it never silently repeats a stop or write.
2. Fence new automated delivery while retaining pending rows. Snapshot message
   identifiers, original claimed sender/time and known dispatch receipts. Unknown
   or already-written delivery must not become fresh pending work after transfer.
   The safe proposed default is refusal of automatic inheritance whenever an
   unsettled physical write exists; explicit recovery policy must resolve it.
3. Send a stop request only over the bound incumbent owner connection. Its ACK
   must bind intent/old generations and report the actual production child exit
   callback, with no raw output or bearer. A reported ACK is still a report, not
   independent process-custody proof. Missing ACK, disconnect or timeout leaves
   the intent refused/uncertain; none authorizes force-kill, rotation or takeover.
4. Establish process birth/custody before any autonomous signal or direct stale
   transfer. A Linux-safe option is a separately authorized daemon-owned launcher:
   the daemon retains its actual ChildProcess handle and verified `/proc` boot ID
   and start ticks at creation, and never substitutes registered PID metadata.
   This needs explicit launch authority and a defined relationship to the PTY
   child. Alternatively a kernel-authenticated local IPC enrollment adapter needs
   its own reviewed platform support; the current TCP WebSocket supplies no peer
   process identity. Same UID, a TTY and claimed PID ancestry are not enrollment.
5. After both the ACK and required independent birth/custody checks, re-read the
   exact original record and generations. Commit epoch, verifier, nonce, audit,
   delivery fences and the authorized custody disposition with compare-and-swap.
   Reuse the existing uncertain-commit discipline: a visible renamed generation
   cannot be rolled back to disclose stale authority, and uncertain success
   discloses no new bearer. Only a committed successor may claim an owner socket.
6. A crashed incumbent without a valid ACK remains a distinct explicit recovery
   operation. Absence of a socket is insufficient. Verify the enrolled original
   process birth is gone, or refuse when unsupported/unknown; never signal an
   unrelated process that reused the PID. No timeout or heartbeat observation
   silently grants the recovery permission.

These are proposed requirements, not implemented endpoints, enrollment or policy.
Before execution, the handoff contract must settle pending versus uncertain-write
custody, whether recovery without ACK is permitted under a dedicated exact grant,
and which enrollment mechanism supplies independently observed process custody.
The existing configured-principal model is not a human-attestation mechanism;
Linux process-birth checks do not establish Windows/Mac behavior or isolation from
an unrestricted hostile same-UID process. No platform-native blocker is invented:
Linux can read process birth, but current source lacks the enrollment and state
transition that would make that observation authoritative for this operation.

## Validation scope

This is a documentation/source reassessment, not a runtime feature change.
References above were checked against the pinned baseline and the preserved
issue body in `/tmp/telepty-open-issues.json`; `git diff --check` verifies edits.
Previously passing signed-owner/CLI tests remain their own evidence and are not
relabelled as takeover tests. No GitHub issue/status, key enrollment, installed
package, live daemon, native provider or remote resource was changed.
