# Opt-in exact HTTP peer forwarding

Forwarding is disabled unless a locally configured HTTP entry in `~/.telepty/peers.json` has an explicit `forwarding` grant. This is an operator's choice to delegate a bounded part of that stored peer credential to callers already admitted by the local daemon's existing authentication. It does not create separate user roles or authenticate a foreign session principal. No API enrolls credentials or changes grants.

A grant on one registered peer entry has this shape:

```json
{
  "forwarding": {
    "enabled": true,
    "operations": ["inject"],
    "sessions": ["exact-session-id"],
    "hop_limit": 1,
    "max_payload_bytes": 4096,
    "max_requests": 10,
    "window_ms": 60000,
    "timeout_ms": 3000
  }
}
```

Every field is required. Session scopes are literal exact IDs, including any `@` character; there are no wildcards. Only `inject` is implemented. Payload limits may be 1–65536 UTF-8 bytes, request budgets 1–100, windows 1000–86400000 ms, and timeouts 100–10000 ms. Removing or disabling the grant blocks subsequent forward requests, including replay requests; existing local receipt queries remain available. `/api/peers` does not publish the private grant or credential.

`POST /api/peers/:registeredPeerKey/sessions/:exactSessionId/inject` accepts:

```json
{
  "prompt": "payload",
  "expected_epoch": "the destination session_epoch",
  "idempotency_key": "a-random-unique-key-at-least-16-characters",
  "no_enter": true,
  "from": "optional-claimed-sender",
  "reply_to": "optional-claimed-return-session@registered-host"
}
```

Keys use 16–128 ASCII letters, digits, underscores or hyphens. Callers obtain `session_epoch` from destination session metadata or the initial registration response. The destination checks the epoch before exact-local delivery. The structured route never interprets a local session ID containing `@` as remote routing. Ordinary local inject routes retain their existing behavior; there is no implicit remote fallback.

Only the registered endpoint and its own stored token are used. Environment overrides, local daemon tokens, session bearer headers, payload-supplied URLs, redirects and automatic alternate destinations are not used. The dedicated `/api/forwarded/sessions/:id/inject` destination ingress accepts one hop and never forwards onward; reserved fan-out route names cannot redirect an exact-session request into a broadcast.

The response preserves the destination `inject_id` as `remote_inject_id` in `routing_receipt`, plus an explicit `verified_foreign_identity: false`. `accepted` means the remote API accepted the operation; a queued receipt is not proof of PTY consumption, reply or task completion. Request bodies and credentials are absent from persisted receipts; only scope metadata and digests are stored.

`GET /api/peers/forward-receipts/:idempotencyKey` reads the local receipt. A receipt is durably reserved before any outbound request, and the destination reserves its own receipt before delivery. Reusing a key with different content, endpoint, target or epoch returns `IDEMPOTENCY_CONFLICT`. Reusing the same key returns the existing result without another dispatch. A timeout, malformed remote response or uncertain server error returns HTTP 202 with `outcome_unknown`; never retry with a new key merely because acceptance is unknown. A pending record recovered after restart is also uncertain and cannot dispatch again.

Both inbound and outbound tombstones count toward a bounded 512-record ledger. They are never expired automatically, because deleting an uncertain tombstone would permit replay. Capacity, corruption or persistence failure denies new forwarding. Archival or reset requires explicit operator handling of replay risk; there is no HTTP deletion API. POSIX file and directory flushes protect receipts before acknowledgment. Windows receives file flushes only; this implementation does not claim portable directory durability or DACL isolation.

Known-peer configuration is authority; tailnet addresses and discovery advertisements are not enrollment or identity proof. Strong authenticated origin/session assertions remain part of the separate principal work in issue #132.

## Claimed return routing

HTTP CLI injects and daemon forwards mark their return metadata as a cross-host claim. An explicitly supplied `from`/`reply_to` such as `orchestrator@registered-machine` is preserved in `lastInjectReturn`, session metadata and hash-only audit records with `verification: "unverified"`. No hostname, socket address or shared daemon token is promoted into a verified foreign principal.

For marked cross-host traffic, `telepty reply` requires a host-qualified return locator naming a registered peer. A bare return is refused with `REPLY_AMBIGUOUS_SENDER`; an unknown peer is refused with `REPLY_UNKNOWN_CLAIMED_PEER`, including when an environment-wide token override is present. Replies use exact destination IDs. Existing unmarked legacy inputs cannot be reliably classified as foreign, so this does not claim complete issue #100 provenance or protection for clients that omit the marker. Strong foreign identity remains blocked on #132. The return claim is routing metadata, not an authorization grant or a verified statement of who sent the prompt.
