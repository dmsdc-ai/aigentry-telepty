# Signed readiness continuation

Baseline e9773983e776d0c98e3d195c0cbbd86a34fb1534, isolated primary checkout
telepty-issues-128-135 / fix/issues-128-135. Existing changes and cached 55-row
inventory were retained; no remote refresh or external transmission was performed.
The last offline preflight only compares declared grants. This slice closes a
local strict-client inspection gap: legacy readiness uses legacy authentication,
while the new explicit principal command can issue an exact signed read-only query.

## Delivered

`telepty principal-readiness-v1 --config <private-file> --session <exact-id>
--epoch <expected-epoch>` reuses the checked signer, sole configured origin,
fresh challenge, redirect restrictions and five-second client deadline. A
`session.inspect` assertion binds the bodyless GET, exact target and epoch; the
readiness route also receives the expected epoch. The response is bounded to
16 KiB, strictly parsed, identity checked and projected to selected fields.
Contradictory readiness/status, malformed timestamps, wrong identity/schema,
non-2xx and completion claims refuse without printing raw response data.

No registration, discover/alias routing, owner claim, input, submit, daemon repair,
token fallback or privilege/trust expansion was added. Legacy readiness behavior
is unchanged. The [command contract](../security/principal-readiness.md) explicitly
separates three facts:

- Offline preflight: declared public grants match; no authenticated request made.
- This command: a signed request received HTTP 2xx at the configured origin, and
  the returned readiness observation passed local validation.
- Actual authenticated registration/client enrollment: still unverified here.

The result's `signed_request_http_2xx` is not independent server identity
attestation. Completion remains null, terminal false, consumption/reply unknown.
Unknown/blocked/disconnected observations are valid inspections, not readiness.
Original REPORT target authority and foreign principal trust are retained.

## Tests and limitations

Six new tests exercise actual principal middleware and the production readiness
route using synthetic keys, private loopback HTTP and actual CLI execution.
They assert verified request principal, unchanged session record, only two GETs,
no legacy/JWT/session headers, no created auth store, stale epoch/wrong signer/
foreign-owner refusal, cancellation/usage before network, oversized/invalid
responses and no raw unknown-field output. Initial test-first failures preceded
implementation. An initial implementation incorrectly hashed `{}` for a bodyless
GET and was refused; the adapter now signs the absent body. No server check was
relaxed to obtain success.

Focused six passed; existing principal client/readiness/help composition passed
41/41. Log: `/tmp/telepty-principal-readiness-composition.log`.
Tests use only private fixtures, not actual operational client registration.
Linux-only success fixtures do not validate macOS/Windows native key adapters.

Independent readiness/client composition passed 13/13, no failures/skips;
`/tmp/telepty-independent-principal-readiness.log`. Additional private stalled
challenge-header and readiness-body probes each respected caller cancellation
within one second without fallback/effects. No Important/Critical finding remained
in the bounded review; help, docs and test registrations matched the implementation.

Final integrated npm test: **2,535 total / 2,532 passed / zero failed / three
skipped**, 64.7 seconds; `/tmp/telepty-principal-readiness-full.log`. Skips remain
the opt-in long TCP test and two native Windows tests. Earlier explicit TCP run
passed on ancestor dab2952, not rerun in this slice; Windows is still unverified.
Pinned TypeScript noEmit, modified JavaScript syntax, fixture guard, local doc
links and whitespace checks passed. No dependency installation was performed.

No installed package, operating service, authentication setting, credential,
security/network policy, live mailbox, registry or remote repository was changed.
No publication, deployment, installation, restart or external send was attempted.
The 32 residual items remain partial/remaining; no entire issue was closed by
adding this bounded inspection adapter.
