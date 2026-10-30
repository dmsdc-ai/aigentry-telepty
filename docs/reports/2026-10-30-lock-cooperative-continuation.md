# Mailbox ABA repair and cooperative owner release

Repository dmsdc-ai/aigentry-telepty, isolated local branch fix/issues-128-135.
Baseline e18fc6881000874ea3a662377e67c30053b1a390. No installed daemon, service,
credential, live mailbox or network/security setting was changed. No push,
remote issue/PR update, merge or release was performed.

## Mailbox exclusion

Commit 21066b2ead7485159e9fdbeecb7863cbe08d16b1 replaces the shared PID file with
never-reused acquisition tickets. Live owners cannot be evicted by age or repeated
failures. Dead owners and pre-publication crashes are recoverable only with an
ESRCH probe; unknown/permission failures and legacy PID files fail closed.
See [lock protocol, migration limits and evidence](2026-10-30-mailbox-lock-v2.md).
Five writer processes and a concurrent sweeper preserved 200 exact increments
without critical-region overlap. Crash, departure, old-release ABA, corruption,
legacy refusal, path boundary and delivery backoff regressions pass. The previous
diagnostic now confirms no reproduced ABA defect.

The first lock full run exposed a broad registry rename failure stub interfering
with ticket publication. The stub now targets the actual registry path, its
intended boundary. The complete rerun passed 2,443 / 2,446 with zero failures and
three existing skips. Independent review found and helped fix one normal-release
read race; final re-review found no further concrete exclusion defects.

## Cooperative wrapped-child release

The exact process-release protocol and private successor file contract are in
[the security contract](../security/cooperative-handoff-133.md). This advances
partial #133 and the per-principal #132/#134 boundary; it does not close those
issues or make same-UID identity an authorization principal.

Only an opted-in local strict wrapper, the same configured owning principal,
exact session.takeover grant and current session bearer may initiate release.
The daemon durably records an epoch/generation-bound intent and fences writes.
The incumbent checks its own queue/timers, fences local writes and signals only
its directly held child. Its production child-exit callback supplies the ACK.
After a fresh exact-instance check and empty custody under the mailbox lock, the
daemon commits the new verifier/epoch/generation and release audit together,
then updates its runtime nonce index. The nonce retains existing ephemeral
semantics and is not stored in the session registry. The new
bearer is returned once and can be supplied through a checked private file to a
successor strict allow. The predecessor does not auto-restart or DELETE the SID.

Missing or stale ACKs, changed owners, uncertain work, custody errors and
uncertain saves never authorize automatic re-execution or takeover. Pending and unknown intents
also fence rename, teardown, re-registration, owner admission, delayed writes and
automatic disconnected/idle cleanup, including after restart. Malformed persisted
intent/audit fields restore an unknown fence. This is incumbent-reported direct
child release, not independently verified OS process-tree death or human consent.

## Remaining scope

This first slice requires empty settled queues. Pending-message live transfer,
automatic no-ACK/lost-bearer recovery, general raw/sensitive UI control and native
Windows/macOS acceptance remain incomplete. Existing expired poll-only mailbox
takeover retains its distinct narrow contract. The broad telepty handoff CLI still
means deliberation/synthesis; it is not an implicit process takeover command.
The historical Mac no-ACK incident is not proven resolved.

External mailbox writers must be quiesced/upgraded before using the new lock
protocol on a shared root. Rust/other clients and non-coherent network filesystems
were not validated. No installed mailbox was migrated during this work.

## Final integration evidence

Cooperative implementation 1324749 (source commit 00a691a8da8c7b46a7fdc135a7fd9721246c6d3e)
is integrated onto lock commit 21066b2. Both npm test lists include the new
cooperative regressions before the existing fixture diff guard.

Final full suite: **2,457 total / 2,454 passed / zero failed / three skipped**,
62.0 seconds; /tmp/telepty-lock-cooperative-full.log. Skips remain the opt-in long
TCP stall and two native Windows cases. TypeScript noEmit, node syntax and git
diff checks pass. Original PR125 head remains an ancestor, and a read-only GitHub
refresh still finds 55 open issues with PR125 OPEN/draft at
2ead16824bf95ad33f8b183a042bf1fa44bf4409. The canonical 23 local / 29 partial /
3 remaining disposition is unchanged; no remote issue is declared closed.

The author ran 210 composed regressions. Actual private Linux fixtures verify
incumbent child exit, exactly one authority rotation, subsequent allow startup,
missing-ACK refusal surviving restart and shortened cleanup, and denied namespace
mutations. Wrong SID/origin/epoch, unsafe file mode, missing opt-in/principal and
missing daemon capability all refuse before a new child starts. Faults before or
after authority rename reveal no new bearer. Later ACKs do not retry an intent.
Focused independent review found no authority-file/custody bypass. The original
rename finding and root cleanup/persistence findings were fixed with regressions;
final independent re-review of 1324749 found no remaining concrete important
defect. The reviewer independently exercised both awaiting_ack and
outcome_unknown through the production rename route: both returned
HANDOFF_FENCED without changing SID or publishing persistence/credential effects.
It also confirmed malformed persisted primitive values retain an unknown fence.
