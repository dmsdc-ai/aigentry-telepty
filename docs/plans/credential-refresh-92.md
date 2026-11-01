# Linux session credential refresh (#92)

Status: implemented as an opt-in Linux capability. Ordinary `allow` remains
unchanged. Enable it before launching the wrapper:

```sh
TELEPTY_SESSION_CREDENTIAL_REFRESH=1 telepty allow --id worker codex
```

A request on Windows or macOS fails closed before registration or child spawn.
No Windows DACL guarantee or portable Unix implementation is claimed. Linux needs
`/proc`, directory FDs, `O_DIRECTORY`, `O_NOFOLLOW`, and filesystem support for
file/directory fsync and same-directory atomic rename. If those checks fail, the
requested channel refuses publication.

## Consumer contract

The wrapper sets `TELEPTY_SESSION_CREDENTIAL_PATH` and
`TELEPTY_SESSION_CREDENTIAL_INSTANCE` in the child environment before first spawn.
The path stays stable while that wrapper lives. A running process cannot have its
environment rewritten; consumers explicitly reread the record when needed.

Use the shipped programmatic helper, which returns data without printing it:

```js
const { readSessionCredential } = require('@dmsdc-ai/aigentry-telepty/src/session-credential-channel');
const current = readSessionCredential();
// Validate current against an authenticated current-session snapshot, then use
// current.session_token only for that session's credential-checking consumer.
// Never log current or current.session_token.
```

The default helper uses the inherited path, instance, and session ID. Callers
outside that environment can pass `{ credentialPath, instance, sessionId }`.
Optional `epoch` and `generation` require equality with an authenticated snapshot;
a mismatch refuses rather than falling back to the ambient bearer. The file is a
transport for credentials, not an authorization oracle or an approval receipt.
Consumers still decide whether this principal may refresh their authority.

The JSON record has schema `telepty.session-credential/v1` and these fields:

- `session_id`, `session_epoch`, `credential_generation`: daemon-issued principal.
- `wrapper_pid`, `wrapper_birth: { boot_id, start_ticks }`: Linux process identity,
  checked against `/proc/PID/stat` and `/proc/sys/kernel/random/boot_id` on reads.
- `wrapper_instance`: random 128-bit instance also bound to the directory name.
- `sequence`: local publication sequence, distinct from credential generation.
- `session_token`: only this session's bearer. No daemon token, peer credential,
  provenance nonce, or owner token is published.

## Publication and lifecycle

Successful registration stages issuance in wrapper memory. It does not publish.
For each WebSocket connection the wrapper captures its bearer and a fresh attempt
ID. Only the current connection's `owner_token` acknowledgment can publish; its
session ID, epoch and credential generation must match the staged issuance.
Superseded attempts, mismatched bearers, rejected registrations, duplicate or stale
acknowledgments and closed wrappers cannot publish. Publication precedes initial
child spawn. Re-registration can then replace the record for an existing child.

The wrapper creates a random directory under the temporary directory with mode
0700 and exclusive ownership. The file is mode 0600. Every path component is opened
through a verified directory FD with `O_DIRECTORY | O_NOFOLLOW`. Ordinary ancestors
must belong to root or the account and cannot be group/other writable; a sticky
1777 temporary ancestor is allowed. The private random child, its inode and its
parent inode are revalidated before publication and cleanup. A parent swap refuses;
operations remain anchored to the opened directory rather than following a replaced
pathname. A sticky-directory owner can disrupt availability, but cannot redirect
publication into a different instance or read the account-private child directory.

Publication creates an exclusive private temporary file via
`/proc/self/fd/<directory-fd>/<leaf>`, writes and fsyncs it, atomically renames it over
the fixed record leaf in the same directory, then fsyncs the directory. Readers
observe a complete old or new record; an already-open old descriptor stays valid.
The reader rejects symlinks, hard links, nonregular files, loose modes, wrong
ownership, path escapes, wrong instance/principal and stale wrapper birth identity.
Errors contain fixed refusal codes, never record or bearer contents.

Normal close, owner displacement/refusal and process exit remove only the fixed
record and the verified directory of this random wrapper instance. Cleanup never
scans by session ID, follows a replacement directory or recursively removes
unexpected files. A SIGKILL/crash can leave an inaccessible private artifact; the
read helper rejects it once its wrapper birth identity is no longer live. No
cross-instance garbage collector is supplied.

## Trust boundary and verification

The existing same-UID trust boundary is explicit: another process running as the
account can already read child environments. This channel does not prove descent,
human approval, executable identity, or independent authorization. Never forward
its path/instance into a remote agent as that agent's credential identity.

The Linux tests use only synthetic credentials and test-owned temporary paths.
They exercise actual FD-anchored rename and fsync, old-descriptor/new-record reads,
symlink/hardlink/directory swaps, stale process identity, mismatched owner attempt,
principal generation and epoch, refused-old-wrapper cleanup, and an already-running
isolated child reading the updated record through its inherited stable path.

A separate hermetic integration test runs this checkout's actual `cli.js allow`,
node-pty child and daemon under a temporary HOME on an ephemeral loopback port.
Held WS upgrades prove no record or child exists before the real owner ACK.
The child reports only hashes and nonsecret identity fields, which match the
test daemon's durable credential verifier, epoch, generation and owner PID.
The test restarts only its own daemon and discards only that daemon's test-owned
session snapshot to exercise new-epoch re-registration while the same child reads
the same channel path. A fabricated challenger bearer is refused by the real WS
owner gate without publishing or changing the incumbent record. Ordinary opt-out
startup is exercised too. No production daemon or native service manager is used.
