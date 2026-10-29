# Security decisions and remaining trust requirements

Date: 2026-10-29. Read-only review of the integrated local branch through `f633cad`, plus shared-reference candidate `a7ab984` in `telepty-routing`. This is a source review, not a penetration test or a claim that the open security issues are closed. No production credentials, services, network settings, installations, or trust stores were changed.

## Current boundary and evidence

The daemon-wide token remains an operator-equivalent bearer: `src/protocol/http-auth.js:createAuthMiddleware` admits the token or an HS256 JWT but does not attach a distinct authorized user or role. A socket address, session name, caller `from`, JWT `sub` under a shared signing secret, and matching OS account are not independent proof of the original agent. Session credentials prove possession of the current session instance's credential, not historical authorship of a reused name.

At the original review baseline, `src/routes/session-actions.js:registerKillRoute` had no current-session authorization check. The owned-kill follow-up below adds an exact-instance opt-in and protected-session requirement. `registerDeleteRoute` checks a current `(sid, epoch, generation)` credential only when `owned=true`; the ordinary delete path retains daemon-token authority. `registerInjectRoute` verifies local session credentials for provenance but stores caller-provided `from`/`reply_to` as routing metadata. These observations keep #113, #134, and the foreign-sender portion of #100 open.

Two additional credential leaks were confirmed during review. `fetchWithAuth` forwarded the local `TELEPTY_SESSION_TOKEN` to foreign destinations, and default Fetch redirects retained both custom credential headers across a different origin. An isolated two-server loopback experiment with synthetic values returned `{daemonHeader:true, sessionHeader:true}` at the redirect destination. Fix candidate **`7e6be46`** denies redirects in CLI, cross-machine, and MCP credential-bearing requests, scopes session bearers to their minting origin, and binds newly issued wrapper credentials to that origin. Its combined isolated security/diagnostics suite passed **229 tests**. The deliberately documented `TELEPTY_AUTH_TOKEN` fleet override remains unchanged; it is an explicit operator credential choice, not foreign session-identity proof.

## Issue decisions

| Issue | Safe default / concrete next implementation | Required trust decision or native prerequisite | Provisioning, revocation, and recovery |
|---|---|---|---|
| #113 / #134 destructive authorization | Keep `owned=true` exact-instance deletion; add the equivalent current-session-credential kill capability and refusal tests as an additive mode. In a future principal mode, deny destructive operations unless the authenticated principal owns the exact epoch or has an explicit operator grant. Internal cleanup has a separate system identity and audit cause. | A single shared daemon token cannot distinguish a peer, agent, user, and operator. Silently interpreting that same bearer as both “ordinary peer” and “privileged operator” cannot fix this. Changing default kill/delete semantics requires an explicit compatibility and operator-recovery policy. | Provision a separate operator authority and explicit scoped peer credentials. Revoke grants and rotate affected credentials; never grant a recreated name the predecessor's ownership automatically. Recovery must require the separately provisioned operator authority, with exact target/epoch and an audit record. A fallback shared token must not silently bypass principal mode. |
| #132 principals | Keep existing single-user mode explicitly labeled as operator-equivalent. Add opt-in principal mode with default-deny action grants and creation-time owner binding. Signed assertions must bind key ID, principal, target machine/audience, method/path, payload digest, target epoch when relevant, short expiry, and nonce. Bound the replay cache and deny when replay protection is unavailable/full. | Trust bootstrap must identify who may enroll/revoke keys and who is operator. Unix sockets alone do not prove UID: Linux/macOS peer credentials and Windows client SID need supported native/kernel APIs and platform tests. Core Node TCP contains no account identity. Per-user keys also do not isolate mutually hostile agents running with the same unrestricted UID; that guarantee needs protected signer/capability storage or pre-existing OS isolation. | Explicit local enrollment or verified out-of-band public-key exchange; no discovery-based enrollment. Persist public-key grants atomically with restrictive platform permissions. Revoke key IDs, invalidate their outstanding assertions/approvals, and rotate compromised session credentials. Keep offline/local operator recovery separate from ordinary keys. External JWT/OIDC verifiers must pin issuer/audience/allowed asymmetric algorithms and bounded key retrieval, rather than trust token-supplied URLs. |
| #133 takeover | Continue refusal by default. An opt-in takeover needs a separately authenticated owner/operator, expected current epoch/owner generation, bounded graceful-stop attempt, and compare-and-swap transfer. Mint a new epoch and revoke the old owner before accepting replacement frames. | Same name, same UID, stale heartbeat, TTY presence, or possession of the daemon operator token alone does not establish “same original principal.” Pending-mailbox inheritance is an authorization decision, not merely a queue move. | Explicit owner/operator authorization; record old/new principal, epoch, reason and measured incumbent state without secrets. Pending messages transfer only under an explicit authorized handover record preserving original sender/time; otherwise quarantine or reject them. Recovery uses the operator channel, never silent takeover on timeout. |
| #78 message approval | An opt-in protected-session gate can be implemented independently once its approval authority is defined. Bind approval to exact target epoch/owner generation, operation, byte-exact payload digest, random one-time ID and short expiry. Atomically consume before enqueue/write; deny missing/expired/replayed approval. Revalidate queued delivery after generation changes. | The injecting daemon-token holder cannot also be the unrestricted approval issuer, or the gate is self-approval. Choose an independently controlled owner capability, external signer, or authenticated human approval channel. A TTY flag is not proof of a human. Telepty cannot prevent direct OS-level PTY access by an unrestricted same-account process. | Explicit protected-session enrollment, separate approval authority, bounded pending approvals with atomic persistence or fail-closed restart invalidation. Revocation/epoch change invalidates pending approvals. Operator recovery must be explicit and audited; ordinary read-only APIs remain available. Gate every write ingress, including inject/fanout, bus, viewer input, send-key, Enter, interaction operations and delivery retries; otherwise alternate routes remain a bypass. |
| #97 tailnet authentication | Preserve current authentication and browser-origin protections. Tailnet interface/IP classification may narrow reachability; it must not by itself create an authenticated principal. Correct documentation to describe the behavior actually shipped. | The historical issue requests IP-only admission, but this task explicitly requires preserving protections. Zero-token trust requires a separately specified authenticated transport identity (for example a bounded verified local Tailscale identity adapter) and an explicit authorization mapping. `100.64.0.0/10` membership, a reachable listener, or caller headers are not proof. | Any future opt-in verifier must pin the local identity service/socket, fail closed on lookup failure/staleness, and enforce configured node/user/device grants. Revocation must follow live policy with bounded caching. Token-based loopback/operator recovery remains available; no tokenless fallback after verifier failure. Real multi-device/platform acceptance remains external evidence. |
| #100 sender/return routing | Safe independent changes: preserve an explicit claimed host-qualified return locator, label it unverified, and refuse ambiguous bare-name cross-host replies. Record claimed origin separately from verified local principal; output silence is not a confirmed dead pipe. | An authenticated destination-daemon token proves access to that destination, not the foreign sending host/session. Source IP can identify an observed connection address, not a portable session principal. Strong foreign provenance requires authenticated origin assertions or a trusted forwarding envelope with an explicit verifier/grant. | Configure trusted origin keys/forwarders and audiences, bind origin session epoch plus message ID, preserve observed socket address separately, reject replay and unknown origin keys. Revocation removes forwarder/key grants. Recovery can use an explicit exact return destination without upgrading that claim into verified provenance. |
| #111 daemon-side forwarding | A narrow forwarder can use an explicitly registered peer endpoint, exact remote session ID, bounded request, no redirects, typed errors, and the remote inject ID. Never silently strip `@host` into local routing; never accept an arbitrary caller-supplied destination URL. Keep routing acceptance, remote write/ACK and reply/completion separate. | Decide whether this daemon is authorized to spend the stored peer credential on behalf of every local caller. Otherwise it becomes a confused deputy. Define forwarding grants, payload limits, hop limit, origin-proof semantics and target epoch checks before advertising verified end-to-end identity. | Explicit peer enrollment and per-peer forwarding scopes; revoke peer/key grants and cached credentials without exposing them via API. Keep timeout outcomes uncertain if remote acceptance may have happened; use a deduplication key and queryable receipt before retry. No automatic alternate peer/local fallback. |

## Integrated change review

- **Windows spawn (`6022026`, `973dc68`):** native executable argv bypasses cmd; batch paths use a dedicated escaping path and reject percent signs/line breaks; PowerShell uses `-File` without overriding execution policy. These changes do not add authentication or weaken host policy. Native Windows shim/ConPTY and PowerShell behavior still need the platform CI lane; Linux mock tests are not native proof. Caller-controlled PATH/ComSpec remain part of the existing operator process environment, not a new identity boundary.
- **Peer projection/resolution (`1ee961b`):** public API uses an allowlist projection and exposes only a token-presence boolean. Qualified resolution uses explicitly persisted peer aliases/endpoints and rejects multiple matches; it does not enroll discovery advertisements or infer tailnet trust. This fixes token disclosure but does not turn the stored full daemon token into a scoped peer credential. Persisted aliases and machine IDs still rely on trusted enrollment.
- **Session delivery (`00da1ba`):** new runtime fences check record identity, epoch and owner socket before delayed text/CR; this reduces replacement and rename misdelivery. The `injectionTargets` map is in memory. Restored mailbox messages without a persisted destination binding do not gain durable epoch/owner identity from this map. Do not advertise “destination generation always bound across restart” until persisted records carry and validate that binding. Existing aterm UDS responses also accumulate an unbounded response string; bounding that response is independent safe hardening.
- **Shared-reference candidate (`a7ab984`):** upload accepts bytes/hash/fixed hash filename rather than arbitrary paths/URLs; verifies UTF-8 and SHA256; caps each payload at 64 KiB; uses private files, exclusive temporary creation, atomic hard-link commit and existing-file verification; CLI waits for the matching receipt before sending a pointer and forbids redirects. This does not establish foreign sender identity. Aggregate stored reference count/bytes are not bounded by the per-upload cap, and this endpoint does not run the legacy TTL cleanup. Add an aggregate quota/retention policy before claiming bounded disk consumption. Directory checks do not create isolation from an adversarial process with the same unrestricted UID that can rename directory ancestors; that needs an actual filesystem/OS boundary. Windows ACL/hard-link behavior remains native validation, with current failures denied rather than silently weakened.

## Delivery boundaries

These are implementation/design prerequisites, not requests to alter live settings. None authorize installing a native addon, enrolling keys, changing firewall/tailnet rules, rotating real credentials, or restarting services. Existing tests can safely cover refusal, replay, redirect, malformed assertion, stale epoch, wrong owner, denied writes and redaction with synthetic identities. Live/native identity verification and any new authorization-mode migration require their own explicit implementation and operator rollout evidence. The issues above must remain open or be marked partial until those guarantees exist.

## Owned kill and protected instance policy follow-up

`POST /api/sessions/:id/kill?owned=true` and `telepty kill <id> --owned`
require the exact current sid, credential epoch, and credential generation before
teardown admission. Aliases are refused. New registrations may set
`require_owner_proof: true`; the immutable instance policy applies to both kill
and DELETE, and protected metadata re-registration requires the same credential.
The legacy single-user operator default remains available for unprotected
sessions. This is an instance credential boundary, not an OS/user/human principal
model; #113/#134 remain partial until scoped peer/operator principals exist.


## External signer approval follow-up (#78, partial)

The wrapped HTTP direct-inject path now verifies independent Ed25519 signatures
against immutable creation-time public keys. Its one-use signing document binds
canonical sid, credential epoch, current owner generation, operation, Enter mode,
payload SHA256, daemon challenge and 60-second expiry. A bounded cache is reset
on restart; no approval survives daemon replacement. Protected prompts remain
hash-only in audit output even when legacy preview is configured.

Unsupported protected ingress is denied, including fanout, bus, viewer input and
resize, standalone submit/send-key, typed interaction, bootstrap retries, SSH,
mailbox and aterm delivery. No approval-bearing message is parked or automatically
retried. Status, screen and attach output remain readable. Protected destruction
requires the current instance credential; no private signing key is accepted or
created by the daemon. This is external signer authority, not human proof.

The API contract, signed-byte format, digest-only CLI/private-file handoff and remaining enrollment/rotation/recovery
and unsupported-adapter gaps are in
[external signer approval](../specs/2026-10-29-external-signer-approval.md).

## Continued Linux pass: opt-in asymmetric HTTP principals and forwarding

The continued pass implements the earlier design as an explicit Linux-only strict
HTTP mode. Checked startup public trust, exact Ed25519 action grants, replay
fencing and persisted owner labels are described in
[principal HTTP](../security/principal-http-132.md). The shared daemon token/JWT
does not fall through in this mode. Ordinary creation is restricted to mailbox
sessions: arbitrary process PIDs and native child creation would otherwise let an
ordinary principal act with the daemon account's OS authority. Existing session
mutations require the owning configured principal and signed current epoch;
operator cross-owner mutation/recovery is not silently enabled. Strict WebSocket
upgrades are currently refused, so wrapped clients need a future signed adapter.
This does not isolate hostile processes that share unrestricted access to signer
keys or the daemon's OS account. Native identity providers remain unsupported.

Scoped forwarding now requires explicit stored-peer action/SID/byte grants, an
exact expected epoch and one hop. Persistent digest-only tombstones precede any
remote effect; uncertain results cannot authorize an automatic retry. The opt-in
[broker v1](../api/broker-v1.md) uses independently enrolled node/hub signatures
and an outbound recipient stream, keeping recipient daemon/session tokens away
from the source/hub. Neither path claims to verify a foreign session principal.

The protected inject CLI now supports a digest-only external signing handoff;
its private signing authority stays outside Telepty. Protected SSH and unsupported
input adapters still refuse. No live trust configuration, signer, secret or
network policy was created or changed to test any of these source features.
