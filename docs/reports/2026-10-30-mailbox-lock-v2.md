# Mailbox lock ABA repair

Scope: local source, coherent local filesystem and one OS PID namespace. No live
mailbox, installed daemon, service, credentials or remote repository was changed.
Baseline e18fc6881000874ea3a662377e67c30053b1a390.

## Cause and replacement

The old PID file was visible before its PID was written. Contenders could delete
that empty file, enter together, and later unlink each other's successors. Age
sweeps and the delivery engine's repeated-failure force-unlink also evicted live
writers. Checking an inode before unlink would not make that sequence atomic.

The replacement uses a permanent `.lock` directory and a unique PID plus random
128-bit acquisition directory. The directory announces choosing before scanning
published numbers. A bounded immutable ticket number is published by atomic
rename; admission waits for choosing peers and smaller (number, acquisition-ID)
pairs. Only the acquisition's own never-reused directory is released. Release is
idempotent. No common lock path is removed or reassigned.

This adapts the choosing/number ordering from [Lamport's original bakery
algorithm](https://lamport.azurewebsites.net/pubs/bakery.pdf). Correctness depends
on local filesystem visibility of existing tickets through directory enumeration;
Node does not promise an atomic directory snapshot. Network/FUSE/shared-container
PID-namespace storage is outside the supported contract; these tests do not prove
universal filesystem behavior. PID reuse and worker-thread failure conservatively
retain tickets while their PID is live. Only an exact ESRCH owner probe permits
reaping; age, invalid contents, permission errors and unknown errors do not.

Normal release during an open ticket read is recognized only when its descriptor
is unlinked and unique pathname is gone. Independent review reproduced this
transient case; a deterministic regression now covers it. Unknown entries,
corrupt live ticket numbers and unsafe paths are refused without deleting them.
Dead-letter purge now takes the same lock before truncating data.

## Compatibility

JSONL payload format is unchanged. Lock protocol compatibility is deliberately
stricter: a regular legacy `.lock` file returns MAILBOX_LOCK_LEGACY and is never
automatically removed, even if empty, invalid, old or apparently dead. Operators
must quiesce **all** mailbox writers before any explicit migration. The retained
v2 directory makes the inspected old Node implementation fail its regular-file
boundary check. Rust and other external clients have not been inspected or
validated; they must remain quiesced until upgraded and verified. Do not claim
concurrent interoperability from the shared JSONL format alone. No migration of
an actual installed mailbox was performed. Legacy age/force-break config fields
remain readable for compatibility but no longer authorize eviction.

## Evidence

The new tests failed on the original implementation, including actual simultaneous
critical-region entry by separate processes. Current regressions cover five
writers/200 increments with a concurrent 350-pass sweeper; exclusive entry and
exact final count; live old locks; repeated old release; killed holder recovery;
killed chooser before publication; normal departure during open read; legacy
refusal; corrupt evidence preservation; symlink boundaries; delivery backoff
without eviction; and dead-letter purge contention.

`test-support/mailbox-lock-aba-repro.js` is now a passing regression diagnostic:
aged_live_lock_broken=false, successor_survived_old_release=true,
known_defect_reproduced=false. It accepts no target and creates/removes its own
private fixture. Targeted lock/custody checks pass. Final full suite:
**2,446 total / 2,443 pass / zero fail / three skip**, 60.4 seconds;
log /tmp/telepty-lock-v2-full-final.log. Existing unsafe age/force-break tests
were replaced by consolidated refusal/exclusion regressions, explaining the
changed test count. The initial full run failed the overly broad registry fault
injection described below; the corrected seam and complete rerun pass.
TypeScript noEmit, syntax and diff checks pass.
The existing registry-failure injection test now targets the registry rename
rather than all renames, so new lock publication does not mask its intended seam.

Independent review found and confirmed the departure handling issue, now fixed;
no further concrete exclusion/ABA/caller-bypass defects were found within the
stated contract. Native Windows/macOS concurrency remains unverified.
