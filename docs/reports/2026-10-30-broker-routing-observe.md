# Broker routing, discovery and strict read-only observation

Local continuation from 84e3f8dced343a9ad4d08c5340bae2829107cf1c. Read-only remote
refresh still lists 55 open issues and 11 open PRs. Existing fixes and PR #125 ancestry
are preserved; no remote status, branch, registry or release was changed.

## Added scope

| Issues | Implemented | Explicit limits |
|---|---|---|
| #42 | Broadcast up to 8 exact targets, per-target grants/epochs, durable group+child intents, receipt queries and private request-file CLI | Mixed/offline/unknown results are explicit; no all-or-none physical promise or automatic retry |
| #42/#100 | Reply-context lookup bound to the original recipient and new exact return operation bound to original source node, explicit return SID/epoch and reply grant | No routing from unverified from/reply_to claims, automatic semantic reply or foreign session principal |
| #42 | Optional signed node advertisements and exact-node SDK/CLI discovery; at most 32 explicitly selected local SIDs, minimum 5s refresh, bounded TTL and whitelisted SID/epoch | Node-reported metadata only; no automatic enrollment, readiness, legacy-list aggregation or implied input grant |
| #132 | Separate signed output-only /api/observe/sessions/:id WS with exact session.observe grant, current epoch, shared replay cache, expiry and identity fences | Strict owner/input/resize/bus protocols remain unsupported; native account identity/same-UID isolation not supplied |

Broadcast/reply share the existing inject dispatcher, budgets, one-hop forwarding,
durable keys, protected-input and uncertainty rules. The same verified signing key
must grant all broadcast children. All reservations precede stream writes; failed
partial reservation leaves consumed intents, and retries never fill missing or
unknown children. Group/child/ordinary namespaces remain distinct. Reply fingerprints
bind their original receipt as well as exact destination and epoch. Endpoint
acceptance is not agent consumption, ACK, answer or completion.

Discovery makes no local reads unless configured. Strict local reads retain the
existing inspect/ownership/operator policy and never inherit authority from an
inject grant. Advertisements require the current outbound stream challenge; stop,
reconnect and backward-clock checks invalidate old snapshots. Failed/refused/alias
reads produce partial metadata, not a falsely complete empty list. Missing/expired/
disconnected data uses sessions:null. Only public SID/epoch fields leave the node;
local credentials, cwd, command, output, policies and raw errors are not copied.

Observers use a dedicated fanout, never session.clients or the owner protocol.
They accept header-only transport:websocket proofs, including no request body,
query proof or legacy fallback. Owner or explicitly granted operator observation
requires an exact grant; wildcard observe grants are refused. Bounds: 64 global,
8 principal/session, at most 60s verified expiry, 64 KiB frames/replay, 1024 replay chunks,
128 KiB backpressure. Session object, owning principal, epoch, credential generation,
owner socket/generation and closing state are checked before output. Every client
application frame closes the connection. No write or lifecycle action is authorized.

## Verification and independent review

Full integration: **2,379 total; 2,376 passed, zero failed, three skipped**, 55.5s,
exit 0. Command: NODE_PATH=/tmp/telepty-vt-deps/node_modules npm test.
Log: `/tmp/telepty-routing-observe-final-full.log`.

The skipped cases are the existing opt-in slow TCP-stall regression and two native
Windows cases (shim argv/update guard). None is counted as passed in this run.
After the full run, a stale generic strict-WS HTTP-only refusal hint was aligned
with the new output-only route; the affected observer/principal HTTP suites passed
19/19 (`/tmp/telepty-observe-refusal-final.log`). Pinned TypeScript, changed-JS
syntax and diff checks passed. All new files are in explicit npm test/CI lists.
No native Windows/macOS/VPN, live provider or clean npm-ci acceptance is claimed.

Focused evidence includes 53 broad routing regressions, actual owned hub/daemon/two
recipient broadcast/reply topology, private checked CLI files, same-principal but
wrong-key denial, stale return epoch, partial reservation with zero writes, and
lost-result uncertainty without replay. The combined strict local discovery/CLI/
reconnect tests passed 23/23; observer composition passed 71 tests, then 7 observer cases
passed with the bounded replay follow-up. These are overlapping focused suites,
not extra counts added to the full total.

Independent reviews covered routing grants/reservation/key binding; observer proof,
output-only transport, capacity and identity fencing; and discovery authorization,
redaction, freshness and cancellation. Discovery review reproduced a listener leak:
13 refreshes retained 14 global abort listeners. Publication now uses the stream job's
own cancellation signal; the regression retains one global stop listener and zero
after stop. Sampling has a finite deadline and skips needless timeout composition
for an explicitly empty selection. Re-review confirmed cleanup and stream fences.

The observer initially bounded replay bytes but not empty-chunk scans. A proxy-
backed 10-million-entry ring regression now proves exactly 1024 reads with recent
output retained. The global legacy ring implementation was not changed. Final
composition review found no new actionable Important/Critical defect in the scoped
routing, discovery or observation boundaries. Independent review used isolated
pure/network fixtures as available; the full-suite claim is this task's own run.

## Deliverables and remaining work

Primary local clone: telepty-issues-128-135, branch fix/issues-128-135. Core commits:
68193a4(shared broadcast/reply), b268d1c(observer), 21e59b8(replay scan bound),
c800664(discovery), 5fc1a51(refresh cancellation cleanup). Design/API contracts are
in the committed design and docs/api/broker-v1.md / docs/security/principal-http-132.md.

The 55 issue source disposition remains 23 local implementations, 29 partial, 3 remaining.
This phase supplies the scoped broker APIs, not automatic migration of legacy
inject/broadcast/reply/list commands or unscoped discovery. Ref transfer over broker,
key enrollment, strict signed owner/input/bus WS, native account adapters and full
live wrapped-session takeover remain absent. #116/#31 need native incident traces;
#30's terminal-surface lifecycle belongs to the orchestration Workspace Host. The
Mac no-ACK cause remains unproven. No trust or protection boundary was relaxed.

No installed Telepty, running user daemon/service, actual credential, security/
network policy or remote resource was modified. All tests used synthetic keys,
private temporary HOME and owned ephemeral loopback daemons/PTYs. Runtime deps
remain borrowed read-only and the previously pinned VT archive remains in /tmp.
No scan/source upload, TLS bypass or new installation was performed. A discovery
review helper hit model capacity; another independent reviewer completed that work.
There is no unresolved permission blocker; native/protocol limits above remain.
