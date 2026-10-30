# Signed input, trusted session events and handoff reassessment

Baseline: eba1f74cfff494abcf4746af223c037e53a0a645, branch fix/issues-128-135.
Read-only GitHub refresh found 55 open issues and 11 open PRs, matching the existing
55-row outcome inventory. PR125 remains open/draft/unmerged with head
2ead16824bf95ad33f8b183a042bf1fa44bf4409, preserved as an ancestor. No issue, PR,
branch or release was changed remotely. Disposition remains 23 local implementations,
29 partial and 3 remaining; this batch advances partial work rather than declaring
all 55 resolved.

## Delivered

| Issue scope | Local change | Explicit remaining scope |
|---|---|---|
| #132, with #78/#43 gates retained | Dedicated exact signed input WS and explicit CLI/receipt query, separate stream+inject grants, protected transport and current-instance fences | General raw attach keys/resize and native account identity are absent; receipt acceptance is not consumption |
| #132/#37 | Separate exact read-only trusted session event stream, owner/operator grant, explicit projection/redaction, expiry/capacity/fences | No global bus subscription, arbitrary publish, state mutation, turn routing or complete event history; event CLI is not added |
| #133/#134 | Corrected takeover status after signed owner reconnect, concrete Linux handoff/custody proposal | No live ownership rotation, incumbent kill, invented OS identity or default authorization relaxation |

Input endpoint: `GET /api/input/sessions/:exactId`, action session.input_stream,
current signed epoch. Each operation also carries a fresh normal HTTP session.inject
assertion from the same principal/key, bound to the fixed exact inject path/body.
A cryptographic non-consuming verifier precheck runs before durable reservation;
real HTTP middleware re-verifies and consumes the nonce before existing approval,
audit and delivery gates execute. The backend is derived from this process's
known loopback listener, never caller Host or a supplied URL. External approval
refusal was tested with zero queued bytes. Stream authority alone cannot manufacture
inject authority, owner custody, sender SID or an operator role.

Durable namespaced input keys include principal/key/SID/epoch and caller key.
The receipt ledger stores body hashes and projected receipts, without raw
payloads/assertions. Normal mailbox/audit persistence retains its existing policy.
Response loss,5xx, invalid receipts or channel loss after send remain unknown,
bytes_written:null and non-retryable. Reconnect/adapter restart and explicit
receipt query never resend the operation. Unknown writes are not changed to zero
or accepted as child-write/consumption/reply evidence. Connection closure prevents
new frames; it cannot atomically revoke already-submitted HTTP work, whose normal
approval/epoch/delivery semantics remain. Uncertain effects are not rolled back. Storage shares the existing
512-record global forward ledger; tombstones are never silently evicted.

CLI commands are `principal-input-v1 --config <private-file> --session <id> --epoch
<epoch> --request <private-file>` and `principal-input-receipt-v1` with --key instead
of --request. Both use checked Linux config/key/request paths, normal TLS checks,
finite deadlines, projected JSON output and no daemon-token fallback or automatic
reconnect/startup/enrollment. Repeated-key, actual CLI and separate client HOME
fixtures confirm one mailbox write and no shared client token-file creation.
See [input protocol](../api/strict-input.md).

Event endpoint: `GET /api/events/sessions/:exactId`, action session.events.
Only the trusted daemon broadcastSessionEvent producer feeds it. Client sockets
never enter global busClients or session.clients; arbitrary app frames close the
connection. Allowlisted types expose only exact SID/epoch, server timestamp,
observation-only flags and optional enumerated transport health. Raw prompt,
command, cwd, PID, task/state prose, cross-session links and credentials are dropped.
This is a live event subset with no replay or implicit readiness/completion claim.
See [event protocol](../api/strict-session-events.md).

## Review and verification

- Input review found a P2 before release: checking only decoded claims let a
  stream-only caller fill the shared permanent receipt ledger with forged inject
  requests. Fixed by the full cryptographic/grant/replay precheck BEFORE reservation;
  ordinary consuming verification still runs in HTTP middleware. Actual daemon
  tests cover same-key forged signature, foreign verified signer and stream-only
  missing inject grant with no extra ledger row or mailbox write. Independent
  re-review found no remaining important issue and ran 22 input/proof tests.
- Independent event review checked trusted provenance, projection/redaction,
  cross-session isolation, shared replay cache, owner/operator policy and identity
  fences, with no important finding. Author focused composition passed 48 tests.
- Independent SDK/CLI review found no important issue and ran 8 input tests. A final
  additional approval-policy regression then passed; final input file has 9 tests.
- Full integrated command: `NODE_PATH=/tmp/telepty-vt-deps/node_modules npm test`.
  **2408 total,2405 passed,0 failed,3 skipped**, exit0,57.2seconds. Log:
  `/tmp/telepty-input-events-integrated-full.log`.
- The 3 skips remain opt-in >90-second TCP-stall and 2 native Windows argv/update
  guards. Native Windows/Mac acceptance and the historical Mac no-ACK incident
  were not established by this Linux suite.
- Pinned TypeScript no-emit, changed JS syntax, diff whitespace and preserved PR125
  ancestry checks passed. Scripts contain 207/206 unique files for test/test:ci,
  both new transport tests before the unchanged protocol snapshot guard. Existing
  separate PTY CI split is retained.
- Input/proof/event focused composition passed30 tests before the final approval
  regression. The full run above includes all production changes at 9f829aa.
  A later test-only extension restarted the actual private daemon and confirmed
  the CLI same key still returned its old receipt with one restored mailbox item;
  all 9 input tests then passed, log `/tmp/telepty-input-daemon-restart-final.log`.
  Transient
  merge-marker syntax failures during local integration were resolved before
  these checks; no such failure remains.

## Remaining work and environment boundaries

General attach/raw input needs action-specific authority with the same approval,
audit, epoch and uncertainty semantics. Full bus mutation/turn routing needs
per-effect grants, verified sender context and exact target/epoch dispatch rather
than legacy alias/caller-from routing. These are remaining source implementation
work, not permission denials or a claim of an unavailable external environment.

Live/lost-bearer #133 takeover still lacks authenticated incumbent stop ACK,
independent process-custody/death evidence and a policy for pending versus possibly
written work. A PID field, socket disconnect or elapsed lease is not that evidence.
The [handoff assessment](2026-10-30-wrapped-takeover-assessment.md) describes a
bounded intent/fence/ACK/custody/CAS/audit proposal and unresolved recovery choices.
No transfer or credential rotation was added. Existing same-principal owner
reconnect and expired poll-only mailbox takeover retain their respective scopes.
Native OS identity, hostile same-UID isolation, identity enrollment and native fleet
acceptance remain separate. No actual permission action was denied or left pending.

## Local deliverables

Main checkout: /home/duckyoung-kim/Documents/Codex/2026-10-29/task/telepty-issues-128-135.
Commits 2dfbcfe(input authority),44f79be(events, source519a55f),b194897(handoff docs,
source7f0b5a8) and9f829aa(input CLI/final regression). This report's commit contains
final documentation/status reconciliation and the additional private-daemon
restart acceptance assertion, with no production-code change. Isolated source clones are
../telepty-strict-session-events and ../telepty-takeover-assessment.

All work remains local. No installed package, live user daemon, network/security
setting, actual credential, remote repository or release was changed. Tests used
synthetic keys, private temporary HOMEs and owned loopback daemons/servers only.
