# Residual issue audit and custody durability continuation

Primary checkout telepty-issues-128-135, branch fix/issues-128-135; baseline
57a35f339d83bea24eae5b16a62f699a108902df. A read-only refresh reconciled all 55
open issue IDs with the [canonical per-issue outcomes](2026-10-29-open-issue-outcomes.md).
No issues were added/removed. Disposition remains 23 local implementations,
29 partial and 3 remaining; neither native acceptance nor remote closure is
implied. PR125 remains OPEN/draft at 2ead16824bf95ad33f8b183a042bf1fa44bf4409,
retained as a local ancestor. No Mac release work was replaced.

## Implemented and verified

**d807ab0 — observed natural exit, #122.** A daemon-owned child exit previously
removed its in-memory SID and revoked authority before a failed save, allowing
reuse while disk still described the predecessor. The callback now fences the
exited record and retires its process handle and every lifecycle PID hint. It
commits the serializer's closing-record omission before removal/revocation.
Pre-rename, visible-but-uncertain and thrown persistence failures retain the
fenced namespace. The existing health sweep retries metadata only, without
signalling a retired/recycled PID. Late exit/retry callbacks cannot touch a
successor. Client-close/publication errors do not prevent the persistence path.
Seven regressions pass, including actual private child exit, unavailable store,
reuse409 and restored-storage health retry404. The irreversible exit observation
is not rolled back; a full daemon/host crash while every write fails remains a
separate durability limitation.

**6f2343f — refuse unproven expired poll transfer, #133.** GET mailbox exposes
payload with peek and leaves it pending. Thus pending/in-flight plus expired
lease does not prove unseen bytes or a stopped consumer. The older permissive
nonempty takeover now refuses TAKEOVER_PENDING_UNPROVEN without changing data,
credential, epoch or audit. Empty-only takeover holds the mailbox lock across
strict custody/file-and-directory flush, exact owner/record/epoch/generation/
lease checks and authority commit. Ordinary read-only snapshots remain unchanged.
Twenty-five takeover tests pass, including real previously peeked bytes retained
through refusal and restart, empty success, flush failure and changed-owner
boundary. This intentionally tightens an earlier partial implementation to obey
the current no-unconsented-replay instruction; it does not attest consumer death.

**40dc588 — durable transport ACK settlement, #133.** Candidate
8bd368ef9cefab092d923ddb734fbdbd2e5893dc adds a bounded private
handoff-settlements.jsonl proof before compaction. Only an actual accepted, exact
owner/request/epoch/message-bound child-write response produces the private
one-use in-process result capability; a boolean, serialized object or normal
mailbox ACK cannot mint it. After the invocation fact is persisted, ACK validates
current custody under its lock, fsyncs the journal and atomically publishes the
settlement file before pruning rows. Exact new proof can release custody after
compaction/restart; old/generic missing proof still refuses. Unknown journal/DLQ
history overrides all settlement evidence. Storage faults preserve payload and
unknown status, never authorize another physical send.

Independent review reproduced unsafe writable evidence files/directories. The
new Linux descriptor-relative adapter now rejects unsafe ownership, modes,
ancestors, links, replacement/unstable data and unsupported platforms; it never
chmods an existing object to make it trusted. Newly created files are private.
The ledger is limited to 512 records/512 KiB and is not automatically expired or
compacted. It is trusted local storage, not cryptographic authentication against
privileged/same-UID filesystem editors. See the
[settlement contract](../security/pending-transport-ack.md).

The receipt remains **child_write_invoked**, submitted argument bytes, physical
bytes unknown, and consumption/reply unknown. No app completion or human consent
is manufactured. Existing unconsented, historical or tracked/report-bound
messages do not gain transfer authority. The separate legacy
[read-only migration preflight](../security/mailbox-migration.md) does not migrate
or authorize migration of an operational mailbox.

## Verification

Final integrated npm test: **2,515 total / 2,512 passed / zero failed / three
skipped**, 64.9s; /tmp/telepty-residual-integrated-full.log. Skips remain the opt-in
long TCP stall and two native Windows cases. TypeScript noEmit, node syntax,
fixture-diff guard and git diff checks pass. Natural-exit checkpoint full suite:
2,499/2,496/0/3. Settlement author's 81 scoped tests and formatted 27-test
composition passed; root poll/cooperative composition passed46. Independent
reviews found no remaining important production finding after the fixes.
All services, files, principals and child processes exercised were private test
fixtures. No installed daemon, credential, live mailbox, network/security setting,
remote repository, registry publication, merge, release or operational migration
was changed. The historical Mac no-ACK incident is still not causally resolved.

## Latest remaining scope, issue by issue

The 23 local implementation rows remain in the canonical 55-row table with their
platform caveats (including #128/#129 native Windows and #11 real SSH acceptance).
The other 32 rows are classified here for the next action; this is a frozen audit,
not a second source of implementation truth.

| Issue | Exact residual boundary / next evidence or decision |
|---|---|
| #134 | Legacy daemon bearer remains privileged. Strict-mode default/client migration needs an explicit compatibility rollout; no silent permission flip. |
| #133 | Tracked task/report transfer, old/unconsented import and lost-bearer/no-ACK recovery remain refused. Text transfer consent does not grant authoritative successor REPORT ownership. |
| #132 | General raw/bus/legacy alias control, native account identity and hostile same-UID isolation remain unsupported. No identity is inferred from a shared token or UID. |
| #131 | Native Windows npm holder/transaction/rollback verification is required; plan-only diagnostics and self-update refusal do not establish it. |
| #130 | Original Windows owner-refusal followed by not-found requires native reproduction; the independent PID-overwrite defect is already fixed. |
| #122 | A complete crash while all persistence is unavailable can lose the exit observation. Retained in-memory closing/retry is now fixed; restart recovery needs independent evidence. |
| #116 | Windows/Warp output-relay stall requires native logs and reproduction. No speculative restart/fallback. |
| #115 | Windows argv/batch acceptance requires the native harness; Linux escaping tests are insufficient. |
| #113 | Legacy shared-token name ownership requires compatible strict-principal rollout. Existing exact owned kill/delete proof remains required. |
| #106 | Original intermittent stall needs measured causal evidence. Bounded UDS/worker/probe fixes do not prove its cause. |
| #102 | External Telesession integration and consumption/reply evidence remain unavailable; missing ACK stays unknown. |
| #100 | Foreign session-principal attestation needs an explicit federated trust contract; claimed from/reply_to is not proof. |
| #98 | Tracker depends on discovery/auth/native upgrade acceptance, not one missing local parser fix. |
| #97 | Tokenless IP/Tailnet admission conflicts with the retained authenticated-owner boundary; remains refused. |
| #96 | Automatic authenticated enrollment and fresh two-device acceptance need an authorized trust path/environment. |
| #95 | Original native blank-screen cause remains unproven despite literal argv/background source fixes. |
| #94 | Registry deprecation/final legacy publication is outside the no-publish authorization; not attempted. |
| #92 | macOS/Windows private credential adapters need native owner/handle/DACL verification; no Linux UID substitute. |
| #78 | Protected SSH and other unsupported ingress need an independent approval adapter; TTY presence is not human consent. |
| #58 | Original launchd/native force-submit incident needs Mac reproduction; current source regressions do not prove it fixed. |
| #57 | Actual provider turn firing needs live provider acceptance. No-submit and child-write invocation are not consumption/reply proof. |
| #47 | Foreign session proof and optional nonce ratchet remain absent; no provenance label is promoted into identity. |
| #43 | Foreign principal proof and transactional audit guarantees remain unimplemented. Node-scoped bounded audit is retained. |
| #42 | Broker reference transfer is further source/API work; automatic enrollment/legacy migration needs a trust contract and real fleet acceptance. |
| #40 | Sensitive update/trust/resume actions need measured semantics and explicit independent authority; observation alone cannot authorize dismissal. |
| #39 | Real provider/native acceptance and binary/version attestation are absent; an operator-selected captured profile is not attestation. |
| #37 | Actual task completion remains independent of idle/silence observations; provider acceptance cannot be inferred from time. |
| #36 | Trust/bootstrap approval requires an independent-authority adapter, not raw-key fallback. |
| #31 | Native cmux/Codex foreground-versus-background MCP-init reproduction is required. |
| #30 | Workspace surface close/focus belongs to the external Workspace Host repository; no cross-repository change was authorized here. |
| #21 | Windows/Codex/Warp tracker still needs native acceptance of its constituent reports. |
| #12 | Remote model/update/latest-picker/workspace behavior remains unimplemented or provider-dependent; declared metadata is not verified remote state. |

For tracked/report handoff the concrete unresolved policy is whether a newly
signed task transfer may delegate authoritative reporting to a successor, with
exact original task/target/epoch/cancellation/receipt bindings. Recommendation:
keep the current old-target/report authority and refuse transfer until that
separate contract is chosen; do not reuse the plain-text flag as report consent.
For historical unconsented rows, even fresh consent cannot prove an erased past
attempt; independent application dedup/settlement evidence is needed before any
resend. No such evidence was invented.

Operational lock/client conversion still requires quiescing every writer,
backups and verified matching Node/Rust/external protocols. A stale PID or empty
metadata snapshot cannot establish that boundary. Operational migration was not
attempted (outside scope), not denied by an approval tool. Native platform work
and the explicitly prohibited publications were also not attempted.
