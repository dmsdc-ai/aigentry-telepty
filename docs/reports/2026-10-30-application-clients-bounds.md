# Scoped application publication, signed effect clients and bounded output

Baseline f3d10d00d4543300b767a9f94858c2a4fbe0c33b, branch fix/issues-128-135.
Read-only GitHub reconciliation still finds 55 open issues; the canonical 55-row
inventory contains 23 local implementations, 29 partial and 3 remaining. PR125 is
still open/draft/unmerged at 2ead16824bf95ad33f8b183a042bf1fa44bf4409 and remains a
local ancestor. No remote issue/PR status or branch was changed. This batch advances
partial #132/#42 and fixes two additional measured local client/buffering defects;
it does not claim all 55 issues or the historical Mac no-ACK incident are resolved.

## Implemented and reviewed

1. Owner-only signed application publication at POST /api/sessions/:exactId/events,
   independently authorized application readers at /api/application-events/sessions/:id,
   and app_publish through the exact bus effect adapter. Public request fields do
   not substitute for private verified middleware context. Exact principal/owner,
   audience/key/action/epoch, protected socket transport and existing peer/origin
   restrictions remain required. The same owner preflight and signature inspection
   precede bus durable reservation; actual HTTP verifies and consumes the nonce.
2. Application payloads are bounded opaque JSON inside a server-authored envelope
   with configured actor, SID/epoch and UUID. They are explicitly untrusted and
   never enter trusted daemon event fanout, global busClients, terminal injection,
   state mutation or alias/turn routing. Data is preserved intentionally, including
   caller-supplied sensitive content; authorized readers get it under their exact
   read grant. This is not payload redaction or foreign-session identity proof.
3. Publication receipts expose UUID, matched socket count and delivery_ack:false.
   Neither a matched socket nor accepted publication proves receipt, consumption
   or reply. Events are ephemeral, without history/durable replay. Bus operation
   digests/receipts remain durable: lost/5xx/malformed/storage-uncertain outcomes
   stay unknown across reconnect/restart and never automatically republish.
4. New principal-bus-v1 / principal-bus-receipt-v1 CLI commands cover state_report,
   routed_turn and app_publish using checked private request/config/key files.
   The existing input client and bus client share the finite signed-effect client;
   old input API/namespace/wire behavior remains compatible. Receipt projections
   exclude raw application/state/turn data and force unknown consumption/reply.
   Contradictory accepted/success flags, missing receipt identity, wrong effect,
   malformed UUID or a claimed publication ACK become unknown rather than CLI
   success. No token fallback, daemon startup, enrollment or automatic retry occurs.
5. Existing allow reconnect holding could retain a single oversized callback beyond
   its 256Ki-unit limit, and unlimited empty callbacks grew chunk metadata. The
   production helper now caps text at 256Ki UTF16 units and chunks at 1024, skips
   empty input and retains only recent bounded text with Unicode/order and partial
   sent-prefix handling. It is bounded scrollback, not a lossless output receipt.

See [application protocol](../api/application-events.md),
[signed bus effects](../api/strict-bus-effects.md) and
[effect CLI](../api/principal-bus-cli.md).

## Independent findings and corrections

- The first bounded-text implementation used V8 slices that still pinned the entire
  oversized backing allocation. An independent 32MiB/GC fixture retained about 33.5MB
  despite a logical 262144-unit hold. Every retained range now owns a bounded UTF16LE
  copy, clipped BEFORE encoding, including borrowed small substrings and partial
  consumption. Independent rechecks retained about 258–272KB in the ASCII fixtures;
  code-unit/surrogate fidelity and actual default bounds are tested. This does not
  establish any native Windows/Warp output-stall root cause.
- A fake-server regression reproduced the previous input client's acceptance of
  state:accepted with success:false. The shared client now checks consistency and
  durable/effect-specific result identities before returning accepted. Independent
  review also caught a permissive publication-ID regex; canonical UUIDv4 checks
  now match the backend, including a 36-hyphen negative fixture. Application ACK
  true/missing is rejected by both backend projection and client contract.
- Application authority/provenance, reader extraction, memory ownership and SDK/CLI
  were independently reviewed. Final reviews report no remaining important finding.
  Reader compatibility and secure appreader restrictions were checked separately;
  no deployment or live identity/credential enrollment was performed.

## Verification

Full integrated command: NODE_PATH=/tmp/telepty-vt-deps/node_modules npm test.
**2441 total,2438 passed,0 failed,3 skipped**, exit0,58.4seconds at 744289d.
Log:/tmp/telepty-application-clients-full.log. All final production changes were
included; the final report commit contains documentation/status reconciliation.

The unchanged skips are the opt-in >90-second TCP-stall fixture and 2 native Windows
argv/update guards. Pinned TypeScript no-emit, changed JS syntax, whitespace and
PR125 ancestor checks passed. Test/test:ci contain 213/212 unique files respectively,
with the unchanged protocol snapshot guard and existing separate PTY CI split.

Focused application/client/hold composition passed 20 tests. Actual CLI tests use
all 3 bus effects, separate receipts for the same caller key, duplicate/query calls,
one mailbox item/one application publication, distinct trusted/application feeds,
wrong legacy token ignored and no client token-file creation. Earlier input CLI
regressions also pass after the shared-client extraction. Author compositions
reported 150 memory/owner/credential tests and 63 app/reader/bus/principal tests, plus
6 final publication checks; these overlap the integrated suite. Logs include
/tmp/telepty-publication-client-hold-target.log and /tmp/telepty-effect-cli-integrated.log.

## All-issue residual reconciliation

The per-issue canonical source is [the 55-row inventory](2026-10-29-open-issue-outcomes.md).
The groups below overlap; they distinguish what is still source work from actual
external acceptance or policy/scope limits, without relabeling partial issues as done.

| Remaining class | Issues/examples | Concrete next condition |
|---|---|---|
| Source/protocol work | #132 identity enrollment/verifier adapters/raw controls; #42 broker refs/legacy migration; #43/#47 foreign-session proof or stronger audit guarantees | Implement and test explicit authority/protocol contracts; existing key signatures do not manufacture native account or foreign-session identity |
| Raw/UI authority contract | #132/#78/#36/#39/#40/#12 | Current approval operation is inject, not arbitrary controls/resize. Typed final writing requires current measured provider and exact UI/owner/input/geometry fences; permission/trust/authentication/unknown surfaces remain refused |
| Live/lost-bearer handoff | #133, related #134/#113 | Authenticated incumbent stop ACK, independent process/child custody, atomic epoch/CAS/audit transition and pending-versus-possibly-written policy. PID fields/socket expiry do not authorize kill, transfer or replay |
| Native/platform acceptance | #116/#130/#131/#115/#92/#21; #31/#58/#57 and original #95 symptom | Native Windows/ConPTY/Warp, macOS/launchd/cmux or real CLI/provider reproduction. Linux mocks/JS memory checks do not establish those causes |
| Unmeasured live symptom or external integration | #106/#102/#100 | Reproduce original stall, integrate external telesession and establish actual end-consumer/session identity evidence; absent ACK/reply remains unknown |
| Trust/enrollment policy conflict | #97/#96 and tracking #98 | IP-only admission conflicts with existing credential authority. Signed enrollment needs an authorized trust path and two-device acceptance; no network policy is changed here |
| Physical/durability boundary | #122 | A naturally exited child cannot be rolled back when stable storage fails. Define truthful uncertain/durability semantics rather than promise an atomic physical rollback |
| Explicitly outside current mutation scope | #94; #30 Workspace Host ownership | Registry deprecation/publication is forbidden in this task; Warp surface lifecycle belongs to the orchestration Workspace Host. Neither was attempted in another service/repository |
| Trackers/aggregates | #98/#21 | Retain partial status while their native/trust prerequisites remain open |

No new general raw-control path or live handoff authority was added. These are
concrete source/protocol and product-authority conditions, not a claim that Linux
cannot provide process-birth or IPC evidence. Publishing application data named stop_ack does not create independent child-exit
evidence. Existing same-bearer owner reconnect
and expired poll-only mailbox takeover keep their distinct scopes. Default legacy
operator-token authority is unchanged. Hostile same-UID isolation cannot be claimed
from a checked private key file alone. Bus now supports scoped app publication and
its effect CLI, but arbitrary legacy global publishing/alias routing and an app
subscription CLI are not migrated automatically. The 512-record permanent effect
receipt bound remains; no uncertain tombstone is silently evicted into replay.

No permission action was denied or left pending. Native environment validation,
source work and explicit no-remote/no-live constraints are separated above.

## Local deliverables

Main checkout: /home/duckyoung-kim/Documents/Codex/2026-10-29/task/telepty-issues-128-135.
Commits: f373c57+7c64220(output hold; source8ab0dae+5373e13),545b94f+60806b7(application
publication; sourceb68acf9+702553c),744289d(effect CLI/receipt validation/suite lists).
Isolated sources:../telepty-output-hold and ../telepty-application-events.

All changes are local. No installed package, live user daemon, actual credential,
network/security setting, remote repository, registry or release was changed.
Tests used synthetic keys, private HOMEs and owned loopback/PTY/GC fixtures only.
