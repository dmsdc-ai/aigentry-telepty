# Scoped broker routing and strict observation

Authorized continuation of issues42/100/132, preserving local-only restrictions.
These are implementation choices under the existing explicit-grant model, not a
migration of any installed daemon, trust store or default authority.

## Shared boundaries

Existing Ed25519 assertions bind raw route/method/body/audience/challenge/nonce/expiry.
New grants are exact/default-deny. No automatic enrollment, no IP/UID/name authority,
no foreign session-principal claim. Existing one-hop destination epoch, durable
idempotency, closing and independent approval gates remain. Unknown attempts never
replay automatically. Node metadata and endpoint receipts are not consumption/reply
semantics. No dependencies, live configuration, daemon/service or remote writes.

## Broadcast

POST /v1/nodes/:source/broadcast; action broker.broadcast targets the source node.
Body: idempotency_key, prompt, no_enter and targets1..8 exact node/session/expected_epoch.
Each target ALSO requires that same key's explicit broker.inject grant. Refuse
invalid/duplicate targets before any physical stream write. Reserve group and child
intents durably before writes; reuse the existing one-hop dispatch implementation.
Children have deterministic distinct keys and remain normal broker receipts. Group
replay/query returns child states, never sends missing/unknown children. There is
no physical all-or-none promise: expose mixed/offline/unknown results explicitly.
A global512record ledger and existing per-source budgets still bound admission.
GET /v1/nodes/:source/broadcast-receipts/:key uses existing broker.receipt grant.
SDK broadcast()/broadcastReceipt(); explicit private checked request-file CLI.

## Reply

GET /v1/nodes/:responder/reply-context/:receiptId requires broker.reply_context
for the responder itself; expose only receipts whose target_node is that responder,
with source node, receipt ID and target session/epoch, never payload or credentials.
POST /v1/nodes/:responder/replies/:receiptId uses broker.reply grant for the exact
return node/session. Body includes target_node, return_session, expected_epoch,
idempotency_key, prompt, no_enter. After signature verification, require target_node
match the original receipt source and responder match original target. Source SID
and epoch are explicit: never derive them from caller from/reply_to strings. A reply
is a new one-hop scoped operation and receipt, not proof the earlier agent consumed
or answered. Bind in_reply_to in durable fingerprint/metadata to prevent key reuse.
SDK reply() may obtain checked context first; no automatic reply/fallback.

## Discovery

Explicit recipient discovery config selects at most32 exact local session IDs.
No discovery means no local reads. For a configured strict local signer, minimal
metadata is derived from existing exact session.inspect requests: owner/operator
inspection grants are still necessary; inject grants never imply read access.
Only literal-loopback local requests, bounded response/deadline/cancellation, no
credentials or cwd/command/output in advertisements. Failed local reads are marked
partial rather than a false complete empty list.

POST /v1/nodes/:node/advertise uses broker.advertise grant for the same node and
requires its active signed outbound stream. Up to32 unique SID/epoch pairs, complete
boolean, configured_count and TTL5000..120000ms; hub received_at supplies freshness.
Store one bounded in-memory snapshot per configured node; disconnect clears it.
GET /v1/nodes/:caller/discovery/:node uses broker.discover grant for that exact node.
Return observed/unavailable + partial/freshness and foreign_session_identity_verified:false.
No unknown nodes, wildcard enrollment, auto target selection or implied readiness.
Recipient refresh5000..120000ms, one in-flight snapshot, stop cancels reads/timer;
optional maximum sessions32 and snapshot reply16KiB. SDK discover() and explicit CLI.

## Strict read-only WebSocket

A separate /api/observe/sessions/:exactId endpoint only, with header-only principal
assertion transport:websocket, GET, action session.observe, current session epoch
and empty body. Separate exact grant; session owner or explicit operator read grant.
Origin/peer narrowing still applies. No legacy/JWT/session-token fallback. TTL at
most60s from the verified assertion; fresh proof required for reconnect. Max64global
and8per principal/session. No auto-registration and no owner claim or bus endpoint.

Dedicated observer transport accepts no client application frames (including input,
resize or subscribe); closes on them, expiry, shutdown, closing/replaced session,
changed epoch/credential generation/owner generation. Outbound allowlist is output
only plus an initial read-only identity envelope; never owner/session credentials.
Bound replay/live frame size and terminate on backpressure. It observes bytes and
never authorizes writes, reports readiness or proves a turn outcome. Existing owner,
attach-write and bus WS protocols remain unsupported in strict mode.

## Verification

Use setup-env with synthetic keys/private paths and owned loopback daemons only.
Test denied grants, stale epochs, duplicate keys, corrupt/failed reservation, offline
and lost responses, freshness/disconnect, cancellation, conflicting authority, and
no raw secret output. Meaningful real topology tests precede full suite, pinned
TypeScript and independent security review. Preserve all existing local commits.
