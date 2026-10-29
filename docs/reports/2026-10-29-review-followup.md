# Independent review follow-up: delivery, custody and broker authority

Baseline: `34320a09cd20abc46cd4383f43f1b219144ba1cc`.
Independent review thread: `01a186e1-342e-7536-a0e7-a8651c106011`.
The three reproduced findings were accepted after source/reproduction checks.
The previous passing suite did not cover these cases and was not evidence that
all uncertainty or authority paths were safe.

## Fixes

1. **HTTP uncertain delivery (`3bfc157`).** An invoked Fetch failure, timeout,
   non-2xx response or refused redirect no longer removes the durable attempt
   fence and requeues the same payload. It is quarantined as `DELIVERY_UNCERTAIN`,
   `delivery_uncertain: true`, `bytes_written: null`, `retryable: false`, with no
   automatic CR or direct fallback. Fetch exposes no reliable body-write boundary:
   even an unavailable endpoint is conservatively unknown after invocation.
   Definite pre-write persistence refusal remains zero-write; UDS connection
   refusal before a write retains its existing retry behavior.

   HTTP 2xx is only endpoint acceptance. UDS EOF with empty, malformed or no
   explicitly positive response is unknown, not success; explicit `success:true`
   or `status:"Ok"` is only that endpoint's claimed positive receipt. Neither
   is an authenticated agent ACK, turn consumption, reply or completion. Existing
   wrapped WebSocket dispatch likewise remains dispatch, not those stronger facts.

2. **Unused mailbox custody (`ddd10bd`).** Creation initializes both private JSONL
   components exclusively, flushes them and POSIX directory ancestry, and validates
   strict custody before credential issuance, registry publication or success ACK.
   The daemon injects its actual mailbox singleton. Registration, expiry, takeover
   with zero messages and restart are covered. Existing missing, partial or corrupt
   components remain failures; no repair/truncate/empty substitution was added.
   Incomplete unpublished initialization artifacts can require operator inspection.
   Complete uncertain-flush artifacts must be revalidated and flushed on retry.

3. **Broker authority files (`bf5c933`).** Strict-principal trust and broker
   configuration, signing keys and TLS files share a checked Linux descriptor-
   anchored authority-file reader. Every ancestor and leaf is traversed without
   following symlinks; root/current ownership, no group/other writes, single leaf
   link, bounded stable read and private-key privacy are checked. Only the existing
   root-owned sticky temporary ancestor exception is retained. Unsupported platform
   adapters refuse. No filesystem permissions are changed to make an unsafe path
   pass. This protects integrity from other UIDs, not a hostile unrestricted process
   sharing the daemon's UID or root authority.

## Regression evidence

- Original HTTP tests failed **6/6** before the fix; real owned endpoints simulate
  body received then reset, response timeout, post-effect 503 and 307 redirect.
  Repeated engine ticks plus reconstructed mailbox/engine prove one body attempt,
  unknown dead letter and no CR/redirect/fallback. The real API ledger separately
  preserves unknown bytes and null completion. Final HTTP suite: **7/7 passed**.
- HTTP+UDS composition: **20/20 passed**, including empty/malformed/no-ACK UDS,
  durable prewrite refusal, crash-before-response recovery and definitive UDS retry.
- Broker authority/principal/topology: **18 passed**, including unsafe permissions,
  links/ancestors/replacement and a valid owned three-process topology.
- Custody creation/takeover/durability and related poll/principal tests:
  **59 passed**. Empty registration→expiry→takeover reproduced 503 before the fix
  and succeeds after the fix, including restart.
- Internal independent re-review found no important defect in the inspected fixes.
  HTTP/UDS/broker focused review ran 21 passing tests. Another authority review could
  not run valid-path assertions in its sandbox: `/tmp` appeared owned by 65534 and
  workspace ancestry was group-writable; checked readers correctly refused rather
  than weaken permissions. Its custody assertions passed. Approved main test runs
  use owned safe temporary paths and validate the successful broker topology.
- First full integration exposed two stale fixtures, not two production failures:
  an HTTP timeout expecting retry-queued success, and an authentication negative
  control whose UDS sink sent no receipt. Updated tests retain unknown timeout and
  retain the separate rule that a positive endpoint response proves no session
  authentication. Both focused cases passed.

The original independent reviewer was explicitly asked to re-review exact source
HEAD `35afdf553727209446a0b3da65fc6f06024f0a39`; subsequent `f907e48` only changes
the two fixtures above. Its result and final full-suite evidence are recorded below.

## Operational scope

Local source only. No installed Telepty, user daemon, service manager, actual trust
file, credential, network/security setting, registry/release or remote branch was
changed. Temporary HOME, synthetic keys, owned ephemeral loopback servers and test
daemons were used. No automatic approval rejection was bypassed. Native Windows/
macOS filesystem or provider acceptance remains unverified; Mac no-ACK causality
is still unproven. The 55-issue disposition is unchanged by these regression fixes.

## Final result

Full command: `NODE_PATH=/tmp/telepty-vt-deps/node_modules npm test`.
**2,332 total; 2,329 passed, zero failed, three skipped**, 54.6 seconds; exit 0.
Final log: `/tmp/telepty-review-fixes-final-full.log`. Pinned TypeScript and
`git diff --check` passed. Skips are the existing opt-in slow TCP-stall case and
two native Windows cases (shim argv and update guard); none is counted as passed.
The earlier slow TCP test result belongs to the preceding checkpoint and was not
repeated for this follow-up. No clean npm-ci or native platform run was performed.

The original independent reviewer completed re-review of all three findings and
reported all addressed, with no new actionable defect in the focused scope. Its
independent HTTP reproduction now makes one attempt and remains dead-lettered
after restart; its signed-handler empty-custody reproduction returns 201 then 200
with a rotated epoch. Its loopback tests encountered listen EPERM and its valid
authority paths encountered sandbox ownership mapping, so that review explicitly
relies on this environment's successful network/ownership integration evidence.
The reviewer inspected 35afdf5 and confirmed the production files stayed identical
at f907e48. Its reference to 2 failed tests is the first integration log
`/tmp/telepty-review-fixes-full.log`; both stale fixtures were then corrected and
the fresh final log above passed. No production guard was relaxed to make them pass.
