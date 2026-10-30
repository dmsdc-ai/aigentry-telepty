# Strict signed input stream

In strict principal mode, `GET /api/input/sessions/:exactId` upgrades with a fresh
header-only principal assertion: action `session.input_stream`, transport websocket,
exact GET path, body {}, current epoch and exact target grant. No legacy token,
JWT, alias, query credential or automatic registration is accepted. This explicit
stream grant permits connection admission, including a configured cross-owner
input delegate; it does not grant input effects or observation. Actual TLS or a
literal loopback socket is required, and Origin/peer policy can only narrow access.

The initial `telepty.input-stream/v1` frame supplies the exact SID/epoch, random
connection_id, expires_at, max_frames:64 and mode:signed-http-inject. Each client
message uses that connection_id and consecutive sequence starting at1. There are
at most64 global sockets,8 per signing key/session,64 frames per connection and
one in-flight operation. Proof lifetime is at most60s; record/principal/epoch,
credential generation, owner socket/generation and closing-state changes invalidate
it. Application payloads are at most32KiB, prompt UTF8 at most4096bytes. Buffering
above64KiB closes the socket. These are explicit v1 bounds, not raw-key or resize
support.

An inject message has `type:inject`, `idempotency_key` (16–128 URL-safe characters),
`body`, and `assertion`. Body fields are limited to prompt, expected_epoch,
exact_target:true, boolean no_enter, optional claimed from/reply_to and
external_approval. The assertion must be a fresh normal HTTP POST session.inject
proof from the SAME configured principal AND key as the connection, binding
`/api/sessions/:exactId/inject`, the exact body digest and current session epoch.
The independent exact session.inject grant is mandatory, including cross-owner
input. Claimed from/reply_to are not verified sender identity.

Before reserving durable storage, the shared verifier performs a non-consuming
cryptographic precheck, including grant, replay/capacity and clock checks. The
adapter then submits the same proof/body to this process's actual known loopback
HTTP listener. Real HTTP middleware rechecks the signature and consumes its nonce
before normal inject approval, audit, exact-target and delivery gates run. No
caller Host, arbitrary URL/header, shared-token fallback, redirect or second
forwarding hop can select a backend. A five-second finite deadline applies. A
non-loopback-only primary listener is conservatively unavailable for this adapter.

Durable keys are partitioned by protocol namespace, audience/principal/key,
SID/epoch and caller idempotency key. Prompt and approval material are represented
by body hash; raw payloads and assertions are not persisted. Reservations precede
HTTP attempts. Repeated keys never execute again; a changed body conflicts.
Receipt states are accepted, failed, pending, outcome_unknown or not_found.
5xx, response loss, invalid acceptance or storage uncertainty never implies zero
write and never triggers replay. The existing global forward-receipt ledger caps
all its protocol namespaces at512 records; tombstones are not automatically evicted
because eviction could turn unknown writes into permission to resend.

A `type:receipt` frame with the same connection metadata and idempotency_key reads
only this signer/session/epoch partition; it performs no HTTP inject. Normal
receipt fields are allowlisted. Acceptance means the HTTP endpoint accepted the
operation, possibly queued. Owner dispatch, child write, agent consumption and an
agent reply are different facts; this adapter always reports consumption/reply as
unknown. Unknown bytes_written is null and retryable:false.

## Explicit CLI

Use the checked Linux `telepty.principal-client/v1` configuration documented in
[principal security](../security/principal-http-132.md). Both the configuration,
Ed25519 private key and inject request file require private checked authority paths.

```
telepty principal-input-v1 --config /private/client.json --session exact-id --epoch epoch --request /private/request.json
telepty principal-input-receipt-v1 --config /private/client.json --session exact-id --epoch epoch --key caller-idempotency-key
```

Request JSON is `{ "idempotency_key": "caller-idempotency-key", "body": {
"prompt": "example", "expected_epoch": "epoch", "exact_target": true,
"no_enter": true } }`. The CLI emits one projected JSON receipt; any state other
than accepted returns nonzero. After a sent request loses its channel it reports
outcome_unknown and never resends. Query the same key instead. There is no automatic
reconnect, daemon startup, enrollment, credential creation or live-service repair.
General legacy attach input, raw control keys, resize, bus mutation and takeover
are not implemented by this protocol.
