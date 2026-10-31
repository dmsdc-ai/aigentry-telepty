# Explicit signed bus effect CLI

Use a checked Linux telepty.principal-client/v1 configuration as documented in
[principal security](../security/principal-http-132.md). Config, Ed25519 private key
and request file require private descriptor-relative authority paths. No daemon
startup, enrollment, shared token, TLS bypass, redirect or automatic retry is added.

```
telepty principal-bus-v1 --config /private/client.json --session exact-id --epoch epoch --request /private/request.json
telepty principal-bus-receipt-v1 --config /private/client.json --session exact-id --epoch epoch --effect app_publish --key caller-operation-key
```

A request file contains exactly effect, idempotency_key and body. For example:

```json
{
  "effect":"app_publish",
  "idempotency_key":"caller-operation-key",
  "body":{"expected_epoch":"epoch","topic":"app/example","data":{"text":"application content"}}
}
```

Other effects are state_report with its bounded phase/current_task/blocker/needs_input/seq
body, and routed_turn with prompt, expected_epoch, exact_target:true, boolean no_enter
and optional external approval. See [bus effects](strict-bus-effects.md) for the
precise separate grants and owner restrictions. Each effect has a distinct receipt
namespace; the same caller key can identify independent state, turn and publication
operations. A query performs no effect. Repeating a consumed key reads its receipt;
changing that operation's body conflicts rather than executing again.

Each command creates a fresh exact session.bus proof, then a separate normal HTTP
effect proof from the same configured key/principal. It sends one connection-bound
operation, with finite challenge/channel/advertised-expiry deadlines. Output is
one projected JSON receipt and nonzero exit unless its state is accepted. Receipt
acceptance must have consistent success and durable/effect-specific identities;
malformed, contradictory or mismatched results after send become outcome_unknown,
null bytes and non-retryable. Publication additionally requires canonical UUIDv4,
bounded matched_socket_count and explicit delivery_ack:false. Counts never prove
reader receipt or agent consumption. State/turn/application payloads and remote
error text are not printed, and consumption/reply are always unknown.

The input CLI uses the same client implementation with its prior command/wire
contract. No reconnect, resubmit or semantic reply is automatic after a lost result.
Application event reading remains the separate protected WebSocket API; legacy
listen/monitor do not acquire that read grant or new behavior automatically.
