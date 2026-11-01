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

### Implemented observer transport

Strict mode now admits only `GET /api/observe/sessions/:exactId` using a single
`x-telepty-principal` header. Sign the raw path with `transport: websocket`,
`action: session.observe`, body `{}` and the current session epoch, using the
existing startup challenge and audience. Query strings and application request
bodies are refused. A separate exact `session.observe` grant is required even for
an owner; configured operators may read only explicitly granted exact sessions.
The existing verifier and nonce cache are shared with HTTP. Trust enrollment and
legacy owner/viewer/bus upgrade denial are unchanged.

The first frame is `telepty.read-only-observer/v1` identity/expiry metadata. Later
frames contain only `type: output` and terminal bytes, which can contain terminal
secrets: an explicit observation grant is a read disclosure permission. There are
no readiness, completion, delivery or owner credential envelopes. Replay is a
bounded suffix of existing output, at most 64KiB and1,024 scanned chunks, and may be incomplete. Each
serialized output frame is at most 64KiB; oversized output closes the observer.
Sockets with more than 128KiB queued output are terminated. At most64 observers
and8 per principal/session are admitted, independent of key aliases. Application
frames of any type close the socket. Control ping/pong carry no application
command authority.

Expiry is no later than the verified proof expiry or60s after admission. Every
outbound output rechecks exact session object, owning principal, epoch, credential
generation, owner generation/socket and closing state; a50ms timer also closes
idle invalidated observers. Shutdown explicitly terminates this separate WSS.
Fresh proof is necessary for reconnect; no token/JWT/query fallback is supported.
Tests use synthetic configured keys, temporary HOME private daemons and an owned
Node PTY fixture. No installed provider, trust store or service is changed.

## Strict owner WebSocket continuation

`GET /api/owner/sessions/:exactId` is a distinct wrapped-owner endpoint. It requires
an exact `session.owner` grant, the stored owning principal (including for configured
operators), the current signed epoch and the current session bearer header. There
is no auto-registration, operator cross-owner override, query proof, or URL PID or
command claim. The actual socket must be literal loopback or encrypted TLS; proxy
headers confer no transport security. Admission retains existing origin/peer
narrowing, and existing legacy owner/viewer/bus routes remain denied in strict mode.

The current wrapped-owner protocol is connection bound: a random connection ID,
monotonic sequences in both directions, proof expiry at most60s, exact record,
epoch, credential generation, owner socket/generation and stored principal checks
before processing or emitting each application frame. Idle changes are checked
within50ms. Reconnect requires fresh signed proof and bearer. No swapped record
can implicitly re-adopt an old socket. At most64 owner sockets are admitted;
inbound messages and serialized outbound envelopes are bounded128KiB, with262144byte
backpressure cutoff. Only existing owner output, heartbeat, qualified-ready,
child lifecycle, interaction observation/receipt and SSH state/receipt frame types
are accepted. Viewer input/resize/subscribe and bus state-report frames close the
owner connection. These telemetry frames create no approval or completion authority.

For a local synthetic or operator-selected child, `telepty allow` can opt in using
`TELEPTY_PRINCIPAL_CLIENT_FILE`, the checked private `telepty.principal-client/v1`
configuration. Its fixed daemon origin must match the command's configured daemon.
This path never starts or upgrades a daemon, and presently refuses SSH child mode.
Wrapped HTTP registration requires the existing explicit operator registration
policy; the exact owner grant alone does not permit creation. Reconnect registration
and teardown use signed HTTP requests plus the current scoped bearer. Teardown
moves its stale-owner token into `x-telepty-owner-token`, retaining the existing
comparison and refusing duplicate/conflicting carriers. Child startup still waits
for the actual owner ACK; the signing configuration path is not inherited by the
child. Configuration possession and same-user file access remain existing trust
boundaries, not proof of descendant identity or process custody. No installed
provider, key enrollment, service or native terminal automation is exercised.

Strict allow splits live and buffered output into at most8,192 UTF16 units per
frame, preserving surrogate pairs, stream offsets and sequence order. On partial
backpressure failure it retains only the unsent suffix for reconnect. This is
bounded output observation, not lossless scrollback: the existing256KiB-character
holding limit and replay ring bounds still apply. Failed server sends raise an
error or invoke the caller error callback. The client freezes its first owner
expiry (at most60s locally), rejects expiry extension and independently terminates
at the deadline. Signed allow HTTP operations compose caller cancellation with a
finite5s deadline. Hermetic tests cover actual CLI startup and a private-daemon
restart with90,000 buffered CJK characters; native provider behavior is unverified.
