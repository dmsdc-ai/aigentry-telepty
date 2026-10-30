# Continued Linux broker work — 2026-10-30

Baseline: `4d7b6296185de49b66e681df7be29b71ca49e383` on local branch
`fix/issues-128-135`. Remote read-only refresh found the same 55 open issues and
11 open PRs. PR #125 is still draft/unmerged at
`2ead16824bf95ad33f8b183a042bf1fa44bf4409`; that commit remains an ancestor.
Existing release/candidate work and the installed/runtime environment are preserved.

## Delivered

| Scope | Local change | Limits retained |
|---|---|---|
| #42 | Explicit bounded recipient reconnect, fresh signed stream challenges, finite handshake deadlines and cancellation | Initial startup fails fast; auth/protocol/result-POST failures terminate; uncertain operations and result posts never replay |
| #43/#47 | Hub request/refusal/admission/forwarding/receipt audit observations, hash before queue, private Linux descriptor-anchored storage, graceful-close flush and bounded error counters | Node/key scope only; foreign session identity stays null; no preview, per-record fsync or transactional audit guarantee |
| #42/#132 | Recipient may use a checked local Ed25519 signer and separate exact `session.forwarded_inject` grant against a strict local daemon | Mandatory signed/current/body epoch; no token read/fallback in signer mode; no enrollment, WS support or user-account identity |
| #111/#106 | Destination receipts persist unknown outcomes and retain null bytes/nonretryable metadata on replay | Endpoint acceptance remains separate from agent consumption, ACK, reply and completion |

The destination receipt defect was reproduced before repair: first response said
unknown but its persisted receipt said failed and replay dropped null-byte and
nonretryable facts. Production handler/ledger tests now preserve these facts and
make exactly one owned HTTP endpoint request across replay and ledger reconstruction.

Strict-local proofs authorize only an explicitly granted exact input action. They
do not grant creation/destruction/listing/takeover, bypass protected input, adopt a
foreign session principal or fall back to a shared bearer. The combined actual
strict-daemon fixture closes only its owned hub sockets, reconnects with an unequal
fresh challenge, delivers the next operation and verifies exactly the three intended
mailbox messages. Failed grant/signature/epoch/challenge attacks add no messages.

## Independent review and repairs

- A malformed reconnect challenge containing JSON null initially became a TypeError
  classified as transient transport failure. Explicit object validation now returns
  terminal `BROKER_CHALLENGE_INVALID`; its regression failed before the fix.
- A new forwarded epoch/body check was moved after signature/grant verification so
  unauthenticated requests do not receive body-CAS diagnostics first. Tests retain
  separate wrong-action 401, missing-grant 403 and authenticated epoch 409 refusals.
- The audit backend originally leaked its directory descriptor if file-handle close
  rejected. A private real-FD reproduction showed zero directory closes; nested
  finally now guarantees one close and subsequent fstat yields EBADF.
- Independent final composition review found no remaining actionable Important or
  Critical defect in the reviewed reconnect, grant/epoch, receipt and audit paths.
  Separate storage and strict-local reviews passed their focused checks. This was
  focused source review, not whole-product/native security acceptance.

## Verification

Final full command:
`NODE_PATH=/tmp/telepty-vt-deps/node_modules npm test`

**2,362 total: 2,359 passed, zero failed, three skipped**, 54.9 seconds; exit 0.
Log: `/tmp/telepty-2026-10-30-broker-full.log`.

The three exclusions remain the opt-in long TCP-stall case and native Windows
shim-argv/update-guard cases. They are not counted as passed in this run. The older
separate TCP result belongs to the prior checkpoint. No native Windows/macOS/VPN,
real agent provider or clean npm-ci acceptance was performed.

Pinned TypeScript 6.0.3 with @types/node 20.19.41 passed using the previously isolated
`/tmp/telepty-typecheck-deps`; changed-JavaScript syntax and diff checks passed.
New regression files are registered in both explicit npm test and CI lists;
this full run covered them all. The existing separate PTY-CI split is preserved.
Focused evidence includes 9 forwarding/HTTP cases, 18 strict-local/principal cases,
29 composed audit/reconnect/strict-local cases and independent real-FD cleanup checks.

Runtime dependencies remain a read-only borrowed symlink. The exact pinned VT
parser remains the previously extracted source archive in `/tmp`, selected with
NODE_PATH. No dependency was installed or upgraded in the user's environment.

## Remaining scope

All 55 issue dispositions remain 23 local implementations, 29 partial and 3 remaining.
This batch advances partial rows without claiming them closed. Broker broadcast,
refs, list/discovery, reply and enrollment remain absent. Audit loss counters are
programmatic via hub.auditStats; there is no new remote audit-query endpoint.
Size limits are rotation thresholds, so a log file may exceed the threshold by one
bounded metadata batch; audit errors/overflow can lose observations. No audit row
becomes authority for delivery or retry. Strict WS/native-account identity and
full live wrapped-session takeover are still unsupported. The requested tokenless
tailnet policy is not silently enabled. #116/#31 need native incident reproduction;
#30's surface lifecycle belongs to the orchestration Workspace Host. Mac no-ACK
causality remains unproven.

## Operational record

Changes are local source commits only. No installed Telepty, user daemon/service,
network/security policy, actual credential, remote branch, issue/PR, registry or
release was changed. No scan/source upload or TLS bypass was attempted. Tests used
synthetic keys, private temporary HOME and owned ephemeral servers/PTYs. No automatic
approval rejection was bypassed.

One implementation helper stopped with a model-capacity error after its source and
18-test result were saved; the primary agent verified, committed and integrated that
work. A separate requested status update through send_message_to_thread targeting
parent 01a1727a-b041-75ba-a09c-3f72019370d0 returned thread not found: delivery failed,
not denied or uncertain; it was not retried. Progress was reported in commentary and
the platform's final notification remains the parent handoff. Neither event blocked
source work or changed production state.
