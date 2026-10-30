# Opt-in signed HTTP principals (#132)

This implements a configured-key HTTP principal mode and a portable Ed25519 proof
core. It does not implement kernel account identification, OIDC, automatic key
registration, or signed WebSocket frames. Legacy daemon-token/JWT authentication
remains the default.

## Operator configuration

Only the operator controlling daemon startup and its trusted configuration can
choose this mode. There is no API to enroll keys, change grants or enable it.
The daemon reads public verification keys; it never generates, loads or stores a
user's private signing key.

Startup settings are `TELEPTY_PRINCIPAL_MODE=strict`, an absolute
`TELEPTY_PRINCIPAL_TRUST_FILE`, and optionally
`TELEPTY_PRINCIPAL_REPLAY_CAPACITY` (integer 1..65536, default 4096). An absent mode,
empty mode or `legacy` retains the existing behavior. Other values, missing or
unsafe trust files, invalid trust contents and unsupported integrity adapters
refuse startup before a listener is created. Configuration changes require an
explicit daemon restart.

The production trust-file integrity adapter is currently Linux-only. It walks
checked directory descriptors through `/proc/self/fd` with `O_NOFOLLOW`, refuses
untrusted owner/group/world-writable ancestors (except a root-owned sticky temp
directory), and checks the public trust file's owner, non-writable-by-others mode,
regular-file type, single link, size and stable read. The accepted owner is root or
the daemon account. Control of that account/configuration remains operator
control; this is not isolation from arbitrary code already running as that same
account. Native macOS/Windows integrity adapters are unavailable, so requesting
strict mode there fails closed. No Windows DACL or kernel UID/SID authentication
is claimed. The signature core itself is portable Node crypto.

The trust file is JSON, at most 100 KiB, with this shape (the PEM below is an
external operator-provided **public** key, not a literal example key):

```json
{
  "schema": "telepty.principals/v1",
  "audience": "configured-machine-id",
  "keys": [{
    "key_id": "worker-key-1",
    "principal_id": "worker-user",
    "public_key_spki": "<Ed25519 SPKI PUBLIC KEY PEM>",
    "authority": "principal",
    "grants": [
      { "action": "session.register", "targets": ["worker-1"] },
      { "action": "session.inspect", "targets": ["worker-1"] },
      { "action": "session.inject", "targets": ["worker-1"] }
    ]
  }]
}
```

Audience defaults to the daemon's configured `TELEPTY_MACHINE_ID`, or hostname
when that setting is absent. Key IDs are unique; public-key material is unique;
several different keys may deliberately map to the same stable principal ID.
Only Ed25519 SPKI public PEM is accepted. Private PEM, unknown fields/actions,
ambiguous JSON and malformed identities/grants refuse configuration.
`authority` is either `principal` (the default) or explicitly `operator` in this
trusted file. Request claims cannot select or upgrade it.

## Wire proof and external signer helper

`GET /api/auth/challenge` returns the audience and a fixed random challenge for
this daemon process. It is public, sends `Cache-Control: no-store`, and grants no
authority. `/api/health` remains the existing public liveness endpoint.

Each authenticated request supplies exactly one `x-telepty-principal` header:
`v1.<base64url canonical assertion>.<base64url Ed25519 signature>`. No assertion or
credential belongs in a URL. The signed bytes are the UTF-8 domain prefix
`telepty.principal-assertion/v1\n` followed by the canonical assertion JSON.

The document contains `v:1`, `key_id`, `principal_id`, `audience`, `transport`,
`method`, `target`, `action`, `body_sha256`, `challenge`, `nonce`, `issued_at` and
`expires_at`; it may also contain `session_epoch`. `target` is the exact request
path **and raw query string**, not an absolute URL or an alias. Method, action,
transport and digest must match the server adapter's own classification. Duplicate
query keys and credential query parameters refuse. Unknown assertion fields,
including `sub` or caller-selected roles, refuse.

`issued_at`/`expires_at` are integer Unix seconds. Lifetime is 1..60 seconds;
future or expired proofs refuse. Nonces are unique per configured key within the
window. Replays refuse; capacity exhaustion refuses new admissions without
removing live nonce entries. Clock rollback after a later observed timestamp
refuses admissions until the clock catches up. Restart changes the challenge, so
losing the in-memory replay cache does not make old proofs reusable.

Canonical JSON recursively sorts object member names, preserves array order and
uses Node JSON number/string serialization over the values Express will route.
It is a local protocol definition, not a claim of RFC 8785 compatibility. The HTTP
adapter retains the bounded JSON entity, rejects duplicate member names (including
escaped duplicates), and verifies that its independently parsed value agrees with
the routed body. Nonfinite numbers, accessors, unsupported object types, excessive
depth/size and uncaptured nonempty bodies refuse. No entity hashes as SHA256 of
empty bytes; JSON `null` hashes as the canonical text `null`.

External callers can use the helper without giving private keys to the daemon:

```js
const { createSignedAssertion } = require(
  '@dmsdc-ai/aigentry-telepty/src/principal/proof'
);
const target = '/api/sessions/worker-1/inject';
const body = { prompt: 'a synthetic example' };
const proof = createSignedAssertion({
  privateKey: externallyHeldSigningKey,
  keyId: 'worker-key-1', principalId: 'worker-user',
  audience: fetchedChallenge.audience,
  challenge: fetchedChallenge.challenge,
  method: 'POST', target, action: 'session.inject', body
});
// Send proof in x-telepty-principal and JSON.stringify(body) as the entity.
// Do not log the proof, private key or session credential.
```

The pure core exports `validateTrustConfiguration`, `createPrincipalVerifier`,
`createSignedAssertion`, `canonicalJSON` and `bodyDigest` (the last two from
`src/principal/encoding`). Trusted transport adapters may supply their own fixed
`allowedActions` while retaining the same proof/replay checks. A broker node key
identifies that configured node; it does not prove a foreign session/user identity.

## HTTP actions and ownership

All grants name an action and exact target IDs. There are no implicit grants from
loopback, same UID, display names, daemon tokens, JWT `sub` or peer credentials.

| Action | Supported route | Grant target / extra check |
| --- | --- | --- |
| `daemon.inspect` | `GET /api/meta` | `daemon` |
| `session.list` | `GET /api/sessions` | `*`, explicit operator key required |
| `session.register` | `POST /api/sessions/register` | Exact body session ID; ordinary keys may create/renew mailbox sessions only; other transport types require operator authority; existing records also require owner and current signed epoch |
| `session.create` | `POST /api/sessions/spawn` | Explicit operator key and exact body session ID; authorizes process creation through the existing route |
| `session.inspect` | `GET /api/sessions/:id`, `/diagnostics`, `/handshake`, `/screen` | Exact existing ID; owner or explicit operator inspection grant |
| `session.inject` | `POST /api/sessions/:id/inject` | Explicit exact-target grant, including configured cross-session grants |
| `session.forwarded_inject` | `POST /api/forwarded/sessions/:id/inject` | Separate explicit exact target grant; existing target, signed current epoch and matching body expected_epoch; one-hop/dedup/input policy retained |
| `session.state` | `POST /api/sessions/:id/state` | Owner and exact signed current epoch |
| `session.input` | `POST /api/sessions/:id/submit` | Owner and exact signed current epoch |
| `session.rename` | `PATCH /api/sessions/:id` | Owner, current signed epoch, and explicit grants for both old and new IDs |
| `session.takeover` | `POST /api/sessions/:id/takeover` | Same owner, exact signed/body epoch and explicit grant; expired poll-only mailbox recovery only ([contract](mailbox-takeover-133.md)) |
| `session.destroy` | `DELETE /api/sessions/:id`, `POST /api/sessions/:id/kill` | Owner and exact signed current epoch |
| `mailbox.read` | `GET /api/sessions/:id/mailbox` | Owner or explicit operator inspection grant |
| `mailbox.ack` | `POST /api/sessions/:id/mailbox/ack` | Owner and exact signed current epoch |
| `mailbox.renew` | `POST /api/sessions/:id/lease` | Owner, exact signed current epoch, existing session-bearer check |

`session_epoch` goes in the assertion when the table requires it. Optional epochs
on other existing-session operations are checked when supplied. Wildcard targets
are available only to explicitly configured operator **read** grants for
`daemon.inspect`, `session.inspect` and `session.list`; inject and mutation targets
are always exact. Operator status does not permit cross-owner destruction or
adoption of historical records. A future operator recovery adapter would need a
separate explicit grant and current-epoch contract.

An ordinary key cannot establish OS process custody merely by naming an `owner_pid`
or `pty_pid`, or choose arbitrary external delivery endpoints. Its new registrations
must explicitly use `delivery_type:mailbox`; that route clears process PIDs and
refuses delivery endpoints. Native-PTY creation and other transport registrations
require configured operator authority as well as the exact action/target grant.
An inject grant intentionally delegates terminal input and can imply code execution
when its target is a shell or an agent allowed to run commands; this mode does not
sandbox that process or isolate arbitrary code running as the daemon account.
Transport encryption remains a deployment responsibility; assertions do not encrypt
HTTP bodies or responses.

New sessions record `owningPrincipal` only from the verified middleware context,
with stable ID, configured audience and `source:ed25519`. Request-body owner fields
are ignored. This metadata persists and restores; records created in legacy mode
stay owner-unknown and cannot be silently adopted by re-registration. Strict
native-PTY creation also returns its instance epoch. Existing session-token,
create-only, ownership-proof, external-approval, stale-owner and delivery-policy
checks still run; a principal proof does not replace those proofs.

Broadcast, multicast, submit-all, bus publication, outbound peer forwarding, shared-reference
upload, configuration endpoints and unknown routes are not authorized by the first
HTTP adapter. Reserved static session path names cannot become exact-session
grants, including encoded variants. Missing exact records never fall through to
legacy alias resolution.

Strict mode refuses owner, input-capable attach and bus WebSocket upgrades,
including ones carrying a shared daemon/JWT/session credential. Those clients
need a future signed-handshake/per-frame authority adapter. A separate output-only
observer is supported under its own exact grant as described below. The
first slice is useful for independently signed HTTP/mailbox/control clients; it
is not full acceptance of #132's wrapped-client, OS-account or external identity
provider proposal. Default legacy clients retain their existing behavior.

## Verification and remaining platform scope

Tests use synthetic in-memory Ed25519 private keys, checked public files in private
temporary directories, owned loopback HTTP servers and owned temporary-HOME daemon
restarts. They cover signature/request mismatch, unknown principal/key, invalid
configuration, unsupported platforms, replay/capacity/clock rollback, reserved
routes, encoded aliases, historical ownership refusal and retention of session
bearer checks. No production key, configuration, service or enrollment is touched.

The explicitly scoped forwarded-inject action also supports a broker recipient's
separate local signer. It delegates input only, including configured cross-owner
input, and does not grant session creation, destruction, listing, takeover or
WebSocket access. See [broker local signer](../api/broker-v1.md).

## Signed read-only observation

`GET /api/observe/sessions/:exactId` upgrades only with a single header
`x-telepty-principal` assertion for `session.observe`, `transport:websocket`, exact
raw path, empty body and current session epoch. Obtain the existing startup
challenge from `/api/auth/challenge` and create a fresh proof for each connection.
A separate exact `session.observe` grant is required, including for an operator;
wildcards are refused. The caller must own the session or be an explicitly granted
operator observer. The existing origin/peer restrictions still apply. No query
proof, token/JWT fallback, request body or automatic registration is accepted.

This is a dedicated output-only transport. It emits an initial read-only identity
envelope and bounded output frames only. Every client application frame, including
input, resize or subscribe, closes the connection. Owner and bus routes remain
unsupported. Verified proof expiry closes the connection within at most 60 seconds;
capacity is 64 global and 8 per principal/session. Before each output and periodically,
it rechecks the exact session object, closing state, owning principal, epoch,
credential generation, owner socket and owner generation. Changed identity cannot
reuse an old observation connection. Shutdown refuses new admission and terminates
existing observers.

Replay scans at most 1024 recent chunks and 64 KiB, frames are capped 64 KiB, and
backpressure above 128 KiB closes the observer. No owner/session credentials, policy
state, readiness inference or completion receipt is emitted. Output bytes prove no
agent consumption or answer. This does not make legacy attach or allow clients
strict-mode compatible; a signed owner/input protocol remains future work.
