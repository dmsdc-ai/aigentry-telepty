# Broker v1: exact inject over an outbound channel

This opt-in Linux-tested slice supports an independently started hub, an outbound recipient SSE bridge, exact inject and receipt queries. It is a new versioned protocol; dormant `connectBroker`/HS256-JWT discovery helpers are not compatible and are not enabled. Broadcast, `--ref`, session discovery, broker-routed `reply`, automatic reconnect, automatic enrollment and installation as a service are unsupported. Normal daemon and peer discovery behavior does not change.

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
