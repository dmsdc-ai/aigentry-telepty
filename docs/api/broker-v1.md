# Broker v1: exact inject over an outbound channel

This opt-in Linux-tested slice supports an independently started hub, an outbound recipient SSE bridge, exact inject and receipt queries. It is a new versioned protocol; dormant `connectBroker`/HS256-JWT discovery helpers are not compatible and are not enabled. Broadcast, `--ref`, session discovery, broker-routed `reply`, automatic enrollment and installation as a service are unsupported. Normal daemon and peer discovery behavior does not change.

No node must reach another node. A source signs an HTTP POST to the hub. The destination maintains an outbound SSE request to that hub; it verifies the pinned hub's signature on each delivery and submits the exact operation to its own literal loopback daemon. Only this last loopback request contains the recipient's own daemon token. The source, hub and stream never receive that token or a session bearer.

## Explicit enrollment and grants

Operators provision separate Ed25519 node and hub keys; this implementation does not generate, enroll or copy real credentials. Public trust uses `telepty.principals/v1` from the principal assertion core. Configuration, signing keys, and TLS key/certificate files require absolute normalized paths and the same Linux descriptor-anchored integrity checks as strict principal trust. Every ancestor must be owned by root or the current user and must not be group/other writable (root-owned sticky temporary directories are allowed). Files must be regular, singly linked, root/current-user owned, and not group/other writable; private keys additionally forbid all group/other permissions. Symlinks are refused at every component, reads are bounded, and mutation during a read fails closed. Public config rejects ambiguous JSON. Unsupported platforms fail closed; Windows key/DACL isolation is not claimed.

The hub config schema is `telepty.broker-hub/v1`, with:

- `audience`, `principal_id`, `key_id`, `private_key_path` naming the hub signer.
- Explicit `listen: {host, port}`. Plain HTTP binds only literal loopback. Non-loopback requires `listen.tls: {key_path, cert_path}`; clients always validate HTTPS normally. There is no insecure TLS option.
- `trust` containing enrolled node public keys and exact grants. Node A needs `broker.inject` targets such as `node-b/worker` and `broker.receipt` target `node-a`. Node B needs `broker.stream` and `broker.result` targets `node-b`.
- `nodes`, a map from enrolled node ID to `{audience: "that-recipient-audience"}`.
- `limits`, a per-node map. Each entry requires `max_payload_bytes` (1–65536), `max_requests` (1–100), `window_ms` (1000–86400000), `timeout_ms` (100–10000) and `max_pending` (1–16).
- `stream_ms` (1000–3600000), the maximum held-channel lifetime. The bridge exits on expiry/disconnect; an operator may establish a fresh stream. Operations are never resent automatically.

A recipient config schema is `telepty.broker-node/v1`: `principal_id`, `key_id`, `private_key_path`, `hub_url`, `hub_audience`, `hub_principal_id`, `audience`, `local_daemon_url`, `local_timeout_ms` (100–10000) and `hub_trust`. The last trust file contains only pinned hub keys with exact `broker.envelope` grants such as `node-a/worker`. `local_daemon_url` must use literal `127.0.0.1` or `[::1]`; redirects are denied. The bridge reads its own existing daemon token without creating or rotating credentials, with no environment-token override. Strict-principal local daemons that refuse that operator token fail closed; automatic enrollment of a local signer is not implemented.

A source config schema is `telepty.broker-source/v1`: `principal_id`, `key_id`, `private_key_path`, `hub_url` and `hub_audience`. `hub_url` must be HTTPS, or HTTP on literal loopback for local operation/tests. Credentials in URLs, non-root paths, fragments and query strings are rejected.

Start explicitly:

```text
telepty broker-v1 --config <hub-config-file>
telepty relay-node-v1 --config <recipient-config-file>
telepty broker-inject-v1 --config <source-config-file> <node> <sid> <epoch> <idempotency-key> <prompt>
telepty broker-receipt-v1 --config <source-config-file> <idempotency-key>
```

The minimal inject CLI sends text with `no_enter: true`; it does not assert that a REPL consumed a turn. The API client `createBrokerClient` also supports an explicit `no_enter` boolean. Source requests do not cause a local daemon to start.

## Protocol, receipts and limits

`GET /v1/challenge` returns the hub's startup challenge and audience. Every other request carries `x-telepty-assertion`, an enrolled Ed25519 assertion binding method, exact raw target, canonical JSON body digest, audience, startup challenge, nonce, expiry and exact action/target grant. GET bodies are the canonical empty object. Shared daemon tokens and HS256 subjects are not broker authentication. Revoking startup trust requires restarting the corresponding hub/bridge; startup challenges prevent old proofs surviving that restart.

The recipient posts `/v1/nodes/:node/stream` with its own verifier challenge. The hub signs each SSE envelope as method `EVENT`, target `/v1/envelopes/:receiptId`, action `broker.envelope`, recipient audience/challenge, nonce/expiry, body digest and expected session epoch. Recipient grants bind the original source node and exact session. This authenticates a configured hub/node forwarding channel, not a foreign user or session principal. Destination delivery continues to set verified foreign session identity to false and never adopts a claimed `from` as a principal.

Source inject uses `/v1/nodes/:source/to/:target/sessions/:sid/inject`; receipt queries use `/v1/nodes/:source/receipts/:idempotencyKey`. Expected destination epoch and a 16–128 character idempotency key are mandatory. The destination's existing one-hop exact ingress rechecks epoch and reserves its own persistent tombstone before delivery. Reserved route names cannot become broadcast operations.

A hub receipt is reserved and flushed before sending an SSE frame. Reusing a key with changed content/scope is a conflict; an identical request only returns its existing receipt. Only the enrolled destination can post the result to `/v1/nodes/:destination/results/:receiptId`. `accepted` preserves the destination inject ID and whether it reported queueing; it is not reply, turn-consumption or task-completion proof.

Timeout or channel loss yields `outcome_unknown`. A late first authenticated destination receipt may resolve a hub timeout; a new stream or same-key source query never resends a prompt. Never replace an uncertain operation with a new key merely to retry. Hub tombstones contain digests and routing metadata, not raw prompts or credentials, and share the bounded 512-record ledger; they are never automatically expired. Capacity, corrupt state or failed persistence denies new operations. POSIX receipts flush files and directory entries; Windows directory durability is not claimed.

Request bodies are bounded to 100 KiB including JSON encoding, SSE frames and writable queues to 128 KiB, response bodies to 16 KiB, header count to 32, connections to 128, nodes to 64 and per-source pending operations to the configured cap. Backpressure refuses new operations instead of creating an unbounded prompt queue. Replay caches are bounded and fail closed at capacity. Redirects, alternate endpoints, peer-to-peer fallback and automatic unknown-operation retries are absent.

The acceptance test starts three owned child processes on loopback: hub, recipient daemon and recipient bridge. Source transport capture permits only the hub origin and rejects credential headers. It proves the application topology without changing network policy or requiring a live VPN/EDR deployment; real fleet/platform acceptance remains external evidence.

Recipient connection recovery is opt-in with `reconnect: { "max_attempts": 3, "initial_backoff_ms": 250, "max_backoff_ms": 2000 }` in the node config. Without this field, EOF ends the node as before. `max_attempts` is a total reconnect budget per node process (1–10), not a budget reset by successful connections; delays double up to the configured cap (10–30000 ms). Initial startup refusal/failure still fails startup. Subsequent clean EOF or transient stream/network failure may establish a fresh stream with a new recipient challenge and fresh signed request. Challenge fetch/body and stream headers have 3-second deadlines. Stop cancels backoff, handshakes and the current reader. Authentication, signature, malformed/truncated protocol, configuration and result-POST failures terminate recovery. No accepted or uncertain envelope or result POST is replayed by reconnect; durable hub and destination deduplication remain authoritative. Recovery does not restore lost in-flight operations: query their receipts and treat unknown outcomes conservatively.

## Hub audit observations (#43 / #47)

The hub writes bounded async JSONL observations to `~/.telepty/logs/broker.jsonl`, using
schema v1 from the existing inject audit writer. Events distinguish HTTP requests/refusals,
fresh admission, idempotent retries, envelope forwarding, and recorded receipt outcomes.
Granted inject admission/forwarding/retry events include the bounded exact requested SID
in `to` and destination node in `broker_target_node`; these describe routing, not foreign
session ownership. Unverified requests and denied grants expose no raw destination metadata.
The public startup-challenge endpoint is excluded. Unknown request paths are hashed rather
than logged. Selected internal refusal codes are allowlisted; arbitrary errors and
recipient-supplied result codes are omitted.

`authenticated_node_id` and `authenticated_node_key_id` identify only a successfully verified
configured broker node/key at that request seam; `authenticated_identity_scope` is
`broker-node`. They never establish a foreign user or session principal. In particular,
`verified_sender_sid`/epoch/generation and `claimed_from` remain null,
`foreign_session_identity_verified` remains false, and origin is `untrusted-remote`.
Timer/stream-loss receipt updates have no authenticated request actor. Payloads are hashed
before enqueueing; previews remain null even when `TELEPTY_AUDIT_PREVIEW=1`. Assertions,
signatures, tokens, private keys, raw request paths and claimed sender labels are not logged.

The default queue holds at most 10,000 metadata records, drops the oldest on overflow, and
uses the existing size/age rotation (50 MiB active threshold, five rotated files, 30 days).
`createBrokerHub().auditStats()` exposes saturating submitted, overflow-drop, write-error
and append-error counters, without retaining error text. A failed append batch is lost,
counted as a write error, and never retried as a delivery. Graceful hub close, including the
standalone SIGTERM/SIGINT path, waits for pending audit writes. There is no per-record fsync
or transactional audit/delivery guarantee; hard crashes and storage failures can lose rows.
An `envelope_forwarded` observation records a hub stream write, not a physical terminal
attempt, destination acceptance, or task completion. Idempotent operation retries add no
new forwarding event.

Broker audit storage uses an opt-in Linux descriptor-anchored backend to that writer.
Ancestors must be root/current-user owned and not group/other writable, except root-owned
sticky temporary directories. The final log directory must be current-user owned and
private. Existing log and rotation leaves must be private, singly linked, current-user
owned regular files; newly created leaves are exclusive and mode 0600. Symlinks, hardlinks,
unsafe modes/owners and unsupported platforms discard the audit batch with an observable
write-error count. Existing paths are never chmod'ed to make them pass. Rotation/pruning
uses the same checked directory descriptor. These checks do not isolate hostile code
already running under the same account, or establish native Windows/macOS ACL integrity.
