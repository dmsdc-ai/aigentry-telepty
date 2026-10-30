# Scoped application publication

This opt-in strict-principal feature complements signed bus state/turn effects. It is an ephemeral application channel, separate from trusted daemon session events and legacy bus publishing. It does not implement arbitrary legacy bus behavior.

`POST /api/sessions/:exactId/events` requires a normal HTTP Ed25519 assertion with exact `session.publish` grant and current session epoch. The handler also requires the private verified-request context, exact stored session owner (matching configured principal ID/audience, no operator exemption), current `expected_epoch`, and literal socket loopback or actual TLS. A body claim or public `authenticationPrincipal` property cannot substitute for verified request context. Origin/peer checks still narrow access. There is no daemon/JWT/session-bearer fallback.

The exact body is `{expected_epoch,topic,data}`. Topic is an ASCII `app/` name, optionally with further slash-separated name segments, at most 96 bytes. Data is opaque JSON, including arrays/scalars/null: at most 4096 canonical UTF-8 bytes, depth 8, 256 value nodes, 128 keys per object (128 bytes per key) and 128 items per array. The body cannot override event type, actor, SID or envelope fields. Nested data may contain names such as `turn_request` or `sender:daemon`; they remain inert untrusted application content. They never route, inject, update state or publish trusted daemon facts.

The daemon creates a UUID and sends this envelope only to authorized application readers for that exact session object:

```json
{
  "schema":"telepty.application-event/v1",
  "type":"application_event",
  "session_id":"exact-id",
  "session_epoch":"current-epoch",
  "publication_id":"server-generated-UUID",
  "timestamp":"daemon-publication-time",
  "topic":"app/example",
  "data":{"caller":"supplied content"},
  "actor":{"id":"configured-principal","key_id":"configured-key","audience":"configured-audience","source":"ed25519"},
  "trusted_daemon_event":false,
  "data_untrusted":true,
  "foreign_session_identity_verified":false
}
```

Application data is intentionally preserved, not redacted: authorized readers receive its full content, which may contain user-supplied sensitive information. The actor identifies the configured signing principal; it does not prove a foreign session identity or make application claims into daemon facts. Request assertions, transport credentials and internal session metadata are not added to the envelope.

`GET /api/application-events/sessions/:exactId` is a separate read-only WebSocket upgrade with exact `session.app_events` grant, current epoch, empty-body digest, `websocket` transport and header-only principal assertion. The reader must own that session, or be an operator with the explicit read grant. Literal socket loopback or actual TLS is required for readers too; forwarded headers do not establish either. The initial `telepty.read-only-application-events/v1` frame names SID/epoch, expiry and `read_only:true`. No history or state snapshot follows. Every client application frame closes the connection.

Readers reuse the scoped read transport's finite assertion lifetime (at most 60 seconds), global 64/per-principal-session 8 caps, ownership/record/epoch/credential/owner-generation fences and shutdown handling. Application frames are capped at 8192 bytes and sockets close before exceeding 128 KiB buffered output. This profile owns a distinct subscriber map; sockets never join `busClients` or `session.clients`. Trusted session events never enter it, and application publication never enters the trusted-session hook or auto-router.

The HTTP result exposes `publication_id`, `matched_socket_count` and `delivery_ack:false`, plus success and SID. The count describes eligible sockets handed a frame at publication time. It is not a receipt from a reader, consumption evidence or a delivery guarantee. A publication with no readers succeeds with count 0 and is discarded.

The strict bus supports `app_publish`, with the same exact body and a signed normal HTTP assertion for `POST /api/sessions/:id/events`, action `session.publish`. Its shared transport checks the same connection key/principal/audience, crypto/grant/epoch and owner policy before durable reservation. Actual HTTP authorization independently consumes the nonce and rechecks owner authority. Its effect namespace/fingerprint is distinct from state/turn operations. Known receipt projection contains only the UUID/count/non-ACK result; no application data. A lost/malformed response, storage failure or timeout remains `outcome_unknown`; query the same actor/SID/epoch/effect/idempotency key. There is no automatic republish.

Events themselves are never durably queued or replayed. Only bus operation digest/receipt metadata is durable. Client/CLI support is maintained separately; existing global `listen`/`monitor` and legacy publish callers do not automatically acquire scoped access.
