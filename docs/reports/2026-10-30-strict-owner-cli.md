# Strict principal owner and CLI continuation

Baseline: local 5f972ed8aea856cb5ac7865f276abcc7c1fcf812, branch
fix/issues-128-135. This batch extends the partial #132 implementation and preserves
#133/#134 ownership restrictions. PR125 ancestry and all preceding local changes
remain intact. This report does not claim all open issues are resolved.

## Implemented boundary

- Checked Linux signer configuration and Ed25519 key load through the existing
  descriptor-relative authority file checks. Fixed-origin requests fetch a fresh
  bounded challenge, refuse redirects, keep a mandatory five-second deadline when
  callers also supply cancellation, and never fall back to shared daemon tokens.
- `principal-observe-v1 --config <private-file> --session <exact-id> --epoch <epoch>`
  connects to the existing output-only observer. JSON Lines output, initial
  identity checks, local advertised-expiry enforcement, bounded frames and stdout
  backpressure refusal are explicit; no daemon start, registration, enrollment or
  automatic reconnect is performed.
- The strict owner adapter and explicit signer selection for local `allow` retain
  existing owner lifecycle and instance-bearing credentials. Exact session.owner
  proof, the stored owning principal, current epoch and current session bearer are
  all required; operator status alone cannot claim another principal's session.
  The route never auto-registers, adopts a missing owner record, trusts URL PID or
  command metadata, or performs lost-bearer takeover.
- Duplex owner transport requires actual TLS or a literal loopback socket.
  Forwarded headers are not transport proof. Each finite connection has its own
  random ID, ordered sequence, expiry and exact record/epoch/credential/owner
  generation fences. Viewer input, resize, subscription and bus messages are
  refused. Existing HTTP inject authority can still dispatch through the owner
  protocol; dispatch is not child-write or consumption evidence.
- Owner output is split within frame bounds with surrogate pairs, UTF16 stream
  offsets and order preserved. Partial backpressure failures retain only the
  unsent tail; server send refusal throws or calls back an error instead of
  silently suggesting delivery. Stale-owner teardown checks remain in place,
  with a checked header carrier for signed DELETE rather than a secret query.

## Independent review

Client review identified a CONNECTING cancellation race, missing local advertised
expiry enforcement and caller cancellation replacing the finite deadline. All
three were corrected and regression tested; re-review reported no remaining
important finding. Owner review identified oversized reconnect output loss;
chunking and exact unsent-tail retention fixed it. Independent pure checks
verified CJK/surrogate data, offsets and partial failures; the reviewer also checked
server refusal propagation and reported no remaining important finding.

## Remaining implementation and acceptance

Strict legacy attach/viewer input and bus upgrades remain refused. Existing bus
publication is not a harmless event stream: state reports mutate sessions, routed
turns inject PTY bytes, and raw daemon events expose cross-session process and
workspace metadata. A compatible strict bus requires trusted event provenance,
allowlisted per-session projections and fresh action/target/epoch authority for
every state/input effect. Calling legacy busAutoRoute or placing strict clients
in global busClients would weaken these boundaries. An application-only pubsub
would be a separate feature, not completion of the existing protocol.

A general input stream must preserve inject approval, audit, exact-target and
uncertainty rules with no raw-input bypass or automatic uncertain-write replay.
Those adapters remain source work, not an external permission denial. Wrapped
lost-bearer takeover still needs incumbent acknowledgement and process-custody
proof; the new owner connection does not claim to implement it. Native OS-account
identity, hostile same-UID isolation, external enrollment and native Windows/Mac
acceptance remain outside this Linux evidence. The historical Mac no-ACK incident
has not been reproduced or attributed to these changes.

No installed package, user daemon, live network/security setting, real credential,
remote repository or release was changed. Fixtures use synthetic keys, private
temporary HOMEs and test-owned loopback servers/PTYs only.

## Verification evidence

- Integrated full command: `NODE_PATH=/tmp/telepty-vt-deps/node_modules npm test`.
  **2393 total, 2390 passed, 0 failed, 3 skipped**, exit 0, 57.0 seconds.
  Log: `/tmp/telepty-strict-owner-integrated-final.log`.
- The three skips remain the opt-in >90-second TCP-stall test and two native
  Windows argv/update guards. They are not counted as passing native acceptance.
- After the full run, a single Node20 compatibility change replaced optional
  AbortSignal.any with the existing signal combiner. Affected owner/client suites
  then passed **14/14**, exit 0, log
  `/tmp/telepty-strict-owner-node20-final.log`. No transport policy changed.
- Pinned TypeScript no-emit check, changed JS syntax checks, diff whitespace check,
  and PR125 ancestor check passed. Test scripts now include 205/204 unique files
  for test/test:ci respectively, including both new files before the unchanged
  protocol snapshot guard; the existing separate PTY CI split remains.
- An earlier full attempt exposed a synthetic HTTP lost-response test whose 60ms
  connection budget expired before its fixture received the body under suite
  concurrency. The fixture budget is now a finite 1000ms; product timeout and
  unknown/no-retry behavior were unchanged. The targeted uncertainty/client/owner
  composition passed 21/21 and the corrected full run above passed.
- Author composition additionally passed 213 scoped regressions, including
  legacy auth, credential bridge, security context and strict proof/HTTP/observer
  paths. The private restart smoke retained a 90,000-character CJK backlog through
  signed owner reconnect. Independent review separately checked the chunk/tail
  property and source boundaries, rather than claiming to rerun that restart.

Local commits: c4369b9 (signer/observer CLI), 7149589 (client documentation/deadline),
6f6880d (integrated owner adapter; source clone commit51f109f). Final verification,
Node20 compatibility and report/script changes are recorded by this report's
commit. Main checkout is
`/home/duckyoung-kim/Documents/Codex/2026-10-29/task/telepty-issues-128-135`;
owner implementation clone is `../telepty-strict-owner`. No push or remote mutation
was performed. Overall issue disposition remains 23 local implementations,
29 partial and 3 remaining; this batch advances partial #132 without closing it.
