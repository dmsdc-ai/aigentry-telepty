# External signer approval: wrapped direct inject

This opt-in supports an independent Ed25519 signer for HTTP direct inject into a
wrapped session. It does not prove a human approved anything: the external signer
is the authority. The daemon accepts only its public key, never a private key.
Ordinary sessions retain their existing input behavior.

## Enroll and approve

1. At initial `/api/sessions/register`, supply `external_approval_policy` with one
   field, `public_key_spki`, containing a PEM Ed25519 SubjectPublicKeyInfo public
   key. The policy and implied `require_owner_proof` are immutable for that
   instance. Protected re-registration requires the current instance credential.
2. Request `POST /api/sessions/<exact-id>/approval-challenge` with
   `{operation:"inject", no_enter:<boolean>, payload_sha256:<lowercase SHA256>}`.
   Hash the UTF-8 prompt bytes, without transport bracketed-paste framing. The
   response's `approval` object is the exact signing document. It includes sid,
   credential epoch, current owner generation, a one-use nonce, a fresh daemon
   challenge, and a 60-second expiration in Unix milliseconds. No prompt is sent
   to this endpoint. The default cache holds at most 256 live challenges and
   refuses excess requests; expired entries are removed before allocation.
3. The external authority signs UTF-8 `JSON.stringify(approval)` in the returned
   property order using Ed25519. Send the document unchanged and base64url
   signature as `external_approval:{document,signature}` on the ordinary direct
   `/inject` request, alongside exactly that `prompt` and `no_enter` value.
4. The daemon waits only for its bounded submit barrier, checks readiness and
   instance/owner bindings again, and verifies/consumes the approval immediately
   before sending. It neither parks approved text nor retries it. A submit Enter
   stays behind that text's barrier and rechecks owner identity and expiration.
   Owner changes, session replacement, replay, payload/Enter mismatch, expiration,
   and a daemon restart invalidate the approval. A transport error after
   consumption is uncertain and cannot be retried with the spent approval.

The signing document's hash covers message content. Existing bracketed-paste
framing may surround it; no provenance banner or extra text is added on this path.
A successful response means the owner transport accepted the write, not that the
child consumed it or completed a task. The daemon never creates signing keys,
enrolls a real key, or issues approvals on behalf of the external authority.

## Supported boundaries and explicit gaps

Only HTTP direct inject into a live wrapped owner supports signatures. Fanout,
bus writes, viewer input/resize, standalone submit/send-key, typed interaction,
bootstrap replay and other delivery retries fail closed for protected records.
Protected SSH transport is refused until a signature-bound SSH write receipt
adapter is implemented. A protected mailbox or aterm session has no approved
write adapter. Spawn refuses protection fields rather than silently ignoring
them; protected sessions must be enrolled through register. CLI enrollment and
approval-file handoff are not implemented.

Read-only status, screen and attach output remain available. Viewer writes return
`input_refused`; other refusal paths preserve their typed error contracts. Owner
credential proof is required for protected kill/DELETE, including daemon-token
callers, so deleting and re-registering is not an uncredentialed policy bypass.
Internal lifecycle cleanup remains daemon authority, not a human identity claim.
Recovery for a lost owner credential or signer-key rotation requires a separately
specified operator policy; no recovery bypass was introduced.

This is a partial implementation of #78. Unsupported paths remain refused, rather
than being represented as approved. Direct same-account OS/PTY access outside
Telepty, foreign principals, signer trust enrollment, signer revocation/rotation,
and a human UI approval channel are separate boundaries.
