# Exact bus effects and raw viewer correctness

Baseline 7694dc931dedd83a4786b153e15fbb0e67c953be, branch fix/issues-128-135.
Read-only reconciliation still finds 55 open issues and 11 open PRs. PR125 remains
open/draft/unmerged at 2ead16824bf95ad33f8b183a042bf1fa44bf4409, preserved as an
ancestor. This batch advances partial #132 and #43/#47; it does not close all 55.
Overall disposition stays 23 local implementations, 29 partial and 3 remaining.

## Delivered

- Exact signed bus effects at GET /api/bus/sessions/:exactId. A separately granted
  session.bus connection is only admission. Every state_report or routed_turn
  carries a same-key/principal/audience HTTP effect proof for its fixed exact path,
  current epoch, body and independent state/inject grant. Cryptographic precheck
  and state ownership policy run before durable reservation; real HTTP middleware
  still consumes the nonce and enforces ownership, approval, audit and delivery.
  Operator status cannot mutate another principal's state. No legacy busAutoRoute,
  caller-from routing, alias/fanout or raw global bus membership is introduced.
- Shared signed-effect transport preserves old strict-input wire API, key tuple,
  body fingerprint and pre-existing receipts. Bus state and turn use separate
  effect-bound keys/fingerprints. Receipt projections drop state/task/transport
  prose and raw prompts/assertions. Normal session/mailbox/audit persistence retains
  its configured policy; only receipt storage is digest-only.
- Lost/malformed/5xx/storage-uncertain results remain unknown and never redispatch
  across reconnect/restart. State success is state commit acceptance; turn success
  may be queued input. Both retain consumption/reply:unknown. Connection fences
  stop new frames; closing a transport cannot atomically cancel HTTP work already
  submitted under normal effect authority. No uncertain effect is rolled back.
- Existing raw viewer bug fixed: undefined/null/object/array/number/boolean data
  can no longer be audited/classified as empty then delivered as coerced text.
  Strings above 65536 UTF8 bytes refuse before gate/audit/writer. Exact-size CJK
  data and empty strings preserve their bytes and prior accepted behavior.
- Existing false dispatch evidence fixed: allowed raw input records a separate
  authorized admission before attempt, then ws-viewer:forwarded only after socket
  callback/native write return. Sync/async failure records outcome_unknown and a
  named null-byte/nonretryable refusal. Once guards prevent later success after
  failure. Forwarded remains transport dispatch rather than child/agent evidence.

See [bus protocol](../api/strict-bus-effects.md) and
[viewer audit contract](../api/viewer-input-audit.md).

## Review and verification

Independent review found no remaining important defect in the bus effect/transport
compatibility scope or raw validation/outcome scope. During integration, an exact
state grant without ownership was identified as insufficient to consume permanent
receipt capacity. A same-stored-owner preflight was added before reservation,
without an operator exception; actual HTTP rechecks remain. Tests assert refused
cross-owner state does not add a ledger row, as well as direct HTTP policy parity.

Focused integrated bus/input/viewer/audit composition: 32 passed,0 failed. Log:
/tmp/telepty-bus-viewer-integrated-target.log. Bus author additionally ran 58 focused
owner/events/principal/input/bus regressions. Viewer validation author ran 27;
independent reviews also checked the pure validation and audit callback boundaries.
These counts overlap and are not additional distinct full-suite tests.

Full integrated command: NODE_PATH=/tmp/telepty-vt-deps/node_modules npm test.
**2421 total,2418 passed,0 failed,3 skipped**, exit0,57.3seconds, at278cfd0.
Log:/tmp/telepty-bus-viewer-complete-full.log. All final production changes were
included; this report's commit adds documentation/status reconciliation only.

Two earlier final attempts exposed fixture defects rather than demonstrated
production authorization failures. A forged-signature test could leave a valid
signature unchanged when its original suffix was AA; it now XORs an actual decoded
byte and asserts the proof differs. The existing TP2 timeout test used other HTTP
callers as backlog, but those callers could withdraw their own queued work before
the target deadline. It now seeds six private fixture rows and waits for observed
worker delivery. Its504/TIMEOUT/no-late-write assertions and all production
timeouts are unchanged. Both corrections were independently reviewed; bus8/8 and
pairing5/5 targeted checks passed before the final green full run. The initial
pre-CLI full run also passed2420 tests total; the counts above supersede it.

The 3 unchanged skips are the opt-in >90-second TCP-stall test and 2 native Windows
argv/update guards. Native Windows/Mac acceptance was not established. Pinned
TypeScript no-emit, changed JS syntax, whitespace and PR125 ancestry checks passed.
Test/test:ci scripts include 210/209 unique files respectively, with the unchanged
protocol snapshot guard and separate existing PTY CI split.

## Remaining scope and concrete decisions

General new raw controls are still unavailable in strict mode. Existing prompt
approval has operation:inject, while arbitrary terminal controls/resize have no
compatible approval operation. The typed final writer requires a current measured
provider, exact UI/owner/input/geometry fences and routine controller authority;
it rejects permission/trust, authentication, unknown and running surfaces. A raw
writer shortcut would bypass those conditions. Linux source can implement a future
explicit contract, but this batch does not silently grant it or reinterpret an
inject signature. Legacy malformed-input/audit defects were independently fixable
and are fixed without adding that authority.

Bus supports only exact owner state and exact delegated turn dispatch. Arbitrary
application publishing, legacy aliases/turn envelopes, target lists and a bus CLI
remain unsupported. Read-only event subscription remains separate and does not
imply mutation rights. These are source implementation limits, not external
permission denials. Per-adapter sockets/frames/deadlines remain bounded, and all
namespaces share the existing 512-record permanent receipt limit; no tombstone is
automatically evicted into permission to replay.

Live/lost-bearer #133 takeover still needs authenticated incumbent stop ACK,
independently established process/child custody, atomic epoch/CAS/audit transition,
and explicit handling of pending versus possibly written work. A reported PID,
owner socket expiry or Linux process-birth lookup alone does not authorize transfer
or kill. The [handoff assessment](2026-10-30-wrapped-takeover-assessment.md) remains
the concrete proposal. No live owner is stopped or credential rotated by this
batch. The existing same-bearer reconnect and expired poll-only mailbox takeover
remain distinct supported operations. No new permission action was denied or is
pending; source/protocol decisions and native-environment acceptance are stated
separately. The historical Mac no-ACK incident is not reproduced or attributed.

## Local deliverables

Main checkout: /home/duckyoung-kim/Documents/Codex/2026-10-29/task/telepty-issues-128-135.
Commits: b191b7e(viewer admission/outcome),2662ccb(validation; source1dd9e5f),
4ea6283(bus effects; sourcefff94f5),de4fd26(suite registration),b9cd313(attach
feedback),72944cd(signature fixture),278cfd0(backlog fixture). Isolated source
clones:../telepty-viewer-validation and ../telepty-strict-bus-effects. The final
report commit is local only and the working tree is clean after it.

No installed package, live user daemon, network/security setting, actual credential,
remote repository or release was changed. Tests used synthetic keys, private
HOMEs and owned loopback daemons/PTY fixtures. No push or deployment occurred.
