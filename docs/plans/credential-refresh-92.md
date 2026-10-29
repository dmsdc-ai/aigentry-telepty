# Session credential refresh channel proposal (#92)

Status: proposed, not implemented. Existing children retain their spawn-time
credential. The adoption fix updates only the wrapper and future child-spawn
environment, and accepts issuance only from successful registration responses.
No credential publication or consumer refresh command ships in this change.

## Trust boundary and identity

The channel would retain the existing same-UID trust boundary: another process
running as the account can already inspect child environments. It would not prove
that a reader is a descendant. Consumers must validate the returned bearer against
an authenticated current-session snapshot before granting authority.

A versioned record must bind the session ID, daemon-issued session epoch and
credential generation, wrapper PID, OS process birth identity, and a random wrapper
instance ID. PID alone is insufficient because the OS reuses it. A local monotonically
increasing publication sequence is distinct from daemon credential generation.

The child must inherit a stable `TELEPTY_SESSION_CREDENTIAL_PATH` before its first
spawn. The path must identify a random wrapper instance, never just the reusable
session ID. A new wrapper must use a different private directory. A refused old
wrapper must neither overwrite nor remove the incumbent's record.

## Proposed publication lifecycle

1. Establish an owner-private directory and supported birth identity before spawn.
2. Retain newly issued credentials in wrapper memory only after HTTP success.
3. Publish only after the matching WebSocket attempt receives its owner token.
   Bind that acknowledgment to the exact pending bearer, attempt, epoch and live
   wrapper instance. A superseded or refused attempt must not publish.
4. Create a new private file exclusively, write and fsync it, then atomically
   replace the current record within the same validated directory. Readers must
   observe either complete record. Never append credentials to lifecycle logs.
5. On close, remove only the directory whose ownership, instance marker and birth
   identity still match this wrapper. Refusal must not target an incumbent's path.

The record must contain the bearer, not a verifier, because consumers need the
current credential. It must never include unrelated daemon credentials or the
provenance nonce. Diagnostics must report only fixed error codes and nonsecret
identity fields, never the raw record or bearer.

## Filesystem and platform requirements

On POSIX, directory mode must be 0700 and record mode 0600 with account ownership
verified. Reject symlinks, hard-linked files, nonregular files, unsafe ancestors,
relative paths and path escapes for publication, reading and cleanup. Resolve
operations relative to verified directory handles; a check-then-open path sequence
alone does not establish race resistance. File and directory identities must be
checked again before replacement and cleanup. Unsafe-path failures must refuse
refresh rather than use an ambient environment credential as current authority.

On Windows, Node file modes do not establish an owner-only DACL. An implementation
needs a tested Windows ACL and process-birth-identity adapter plus atomic replacement
semantics. Until that exists, channel creation and refresh must fail closed on
Windows; POSIX permissions must never be described as equivalent Windows protection.

## Remaining implementation gates

- Provide tested Linux/macOS process-birth identity and directory-relative safe
  filesystem operations, or choose authenticated local IPC with equivalent identity
  and cleanup guarantees. Node core has no portable openat/renameat interface.
- Provide and verify the Windows DACL/birth adapter, or explicitly ship a documented
  unsupported-platform refusal before advertising refresh there.
- Extend registration response metadata with authoritative epoch/generation if it
  is unavailable; never infer generation from a local counter.
- Add stale-incarnation/new-token, mismatched owner acknowledgment, refused-owner
  cleanup, interrupted atomic write, unsafe ancestor/symlink/path escape and native
  Windows ACL tests. No unsafe publication should precede these gates.

This proposal does not claim to solve the running-child recovery requested by #92.
