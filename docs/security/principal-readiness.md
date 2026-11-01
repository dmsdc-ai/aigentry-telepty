# Signed read-only readiness inspection

For an already configured strict principal with `session.inspect` on the exact
session, use:

```sh
telepty principal-readiness-v1 --config /absolute/private-client.json --session exact-id --epoch expected-epoch
```

The private client configuration and signer use the existing checked Linux
authority reader. The configured origin is the only destination; no discovery,
alias expansion, host override or legacy/session credential fallback occurs.
The client fetches the current challenge and signs one exact bodyless HTTP GET
to the handshake route with timeout zero and expected epoch in both assertion
and query. Current server owner/grant policy is unchanged. No owner connection,
registration, process creation, input, submit, restart or repair is attempted.

The five-second client deadline and redirect restrictions remain in force.
Responses are bounded to 16 KiB and strictly parsed. Non-2xx, wrong session/epoch,
wrong schema, contradictory readiness/status, invalid timestamps or completion
claims refuse without printing the raw response. A successful result prints only
selected measured fields. Unknown fields, screen output and credentials are not
echoed. A valid unknown/blocked/disconnected/unsupported observation exits zero;
that means inspection succeeded, not that the session is ready. Errors exit one.

`authentication_observation: signed_request_http_2xx` records that the signed
request received HTTP success at the configured origin. It is not independent
server identity attestation, proof of authenticated registration or a fleet
enrollment result. `authenticated_registration` remains `unverified`;
`completion_fact` stays null, terminal false, and consumption/reply unknown.
The separate offline [preflight](staged-principal-migration.md) does not make even
this request and cannot establish authentication.

Linux synthetic-key tests exercise actual principal authentication and the
production readiness route, including wrong signer/owner/epoch refusal, no legacy
headers, no registration or session mutation and actual CLI output. They do not
enroll an actual client or validate native macOS/Windows key adapters. Existing
legacy `readiness`/`wait-ready` behavior is unchanged; the new command neither waits
nor enables permission or trust prompts. Original REPORT and foreign trust
boundaries remain unchanged.
