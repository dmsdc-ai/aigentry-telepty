# Signed read-only readiness for staged clients

Approved staged strict migration needs a way to inspect existing composer
evidence without legacy authentication. Existing `readiness` uses the legacy
fetch path. Add `telepty principal-readiness-v1 --config <private-file> --session
<exact-id> --epoch <expected-epoch>`, following existing principal CLI adapters.
It uses only the checked config's origin, current daemon challenge and an exact
`session.inspect` signed GET to `/api/sessions/:id/handshake?timeout_ms=0`.
No discovery, alias/foreign routing, registration, key provisioning, token fallback,
input, submit, daemon startup or repair occurs. Required epoch pins a reused SID.

Reuse `createPrincipalClient` deadlines, origin/redirect restrictions and key reader;
bound response to 16 KiB using existing strict JSON response reader. Non-2xx,
wrong identity/schema, contradictory ready/status, completion claims or unsafe
input fail with fixed non-sensitive codes. Print only selected measured fields.
Keep completion null, terminal false, consumption/reply unknown and authenticated
registration unverified. Label the result `signed_request_http_2xx`, not a server
identity attestation or proof that a real client was enrolled. Exit zero means a
valid inspection response, including unknown/blocked readiness; errors exit one.

Tests must exercise actual principal middleware and readiness route with synthetic
keys/private loopback server, wrong key and stale epoch refusal, no credential
carrier/fallback, no state mutation, sanitized responses, bounded body and CLI.
Unsupported native key readers refuse. Independent review and full suite remain
required; no live/external request is permitted during this task.
