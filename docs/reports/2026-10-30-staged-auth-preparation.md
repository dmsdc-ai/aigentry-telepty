# Approved staged-auth preparation

Baseline deb0cef63ef920c81cf1bb1d674ccd8566cdd6c4, isolated primary branch
fix/issues-128-135. The user approved the three conservative directions: original
target REPORT authority; staged strict authentication with authenticated registration;
current foreign principal trust retained. These directions are settled for this
local work and were not asked again. No operational cutover was authorized.

## Delivered scope

The [staged transition contract](../security/staged-principal-migration.md) separates
static inventory, isolated authenticated registration, actual fleet acceptance and
separately authorized cutover. No mixed shared-token fallback was added to strict
authentication. REPORT delegation and foreign trust expansion remain disabled.

`scripts/principal-preflight.js` inspects explicitly supplied proposed public trust
and client inventory through the existing checked Linux authority reader. It
compares only declared action/target grants. Legacy authentication, missing keys,
principal mismatch and missing grants are fixed blockers; ambiguous/unsafe/bounded
invalid input refuses with sanitized output. No key material, signature, token,
input path or raw exception is output. No private signer or implicit environment
configuration is loaded, and no network/effect/enrollment/configuration operation
is performed.

Exit zero is **only a declared-grant match**. Every success/error output retains
activation false and authenticated registration, runtime authorization and inventory
completeness unverified. A grant match does not prove possession, route support,
role/ownership eligibility or that a real client works. No actual inventory was
read from the user's fleet. Independent input snapshots are not an atomic cutover
transaction. Native adapters remain unsupported and fail closed.

## Evidence

Test-first missing-module/script failures preceded implementation. Final focused
preflight tests: 11/11 passed. Composition with actual private principal HTTP,
owner WS, cooperative handoff and claimed-return fixtures: 46/46 passed. These
use synthetic keys and private daemons; they do not establish real client enrollment.

Independent review found a test portability issue, now corrected: Linux success
fixtures are gated, and actual CLI subprocesses explicitly check darwin/win32
refusal. The independent final preflight suite passed 11/11; an earlier principal
HTTP composition passed 22/22. No remaining Important/Critical finding was reported
in this bounded review. Native simulation is not native security acceptance.

Logs: `/tmp/telepty-principal-preflight-red.log`,
`/tmp/telepty-staged-auth-targeted.log`,
`/tmp/telepty-independent-staged-auth-final.log`.

Final full suite: **2,529 total / 2,526 passed / zero failed / three skipped**,
64.9 seconds; `/tmp/telepty-staged-auth-full.log`. The three skips remain the
default-excluded long TCP test and two native Windows tests. The TCP test passed
separately on ancestor dab2952, not rerun here; Windows remains unverified.
Pinned TypeScript noEmit, JavaScript syntax, fixture guard, documentation links,
both package test registrations and whitespace checks passed. No new dependencies
or clean install were required.

## Remaining work

The cached 55-row disposition remains 23 local / 29 partial / three remaining;
the same 32 residual items are not declared closed. #132/#134/#113 now have an
offline preparation tool, but actual client inventory, enrollment, native authority,
writer compatibility and operational acceptance remain unverified. #133 retains
original REPORT authority; historical/ambiguous custody is not replayed. #100/#47/
#43/#42 foreign proof/reference extensions require a separate future safe contract.

No operating service, installed package, trust store, credential, network/security
setting, live mailbox or remote repository was changed. No external transmission,
installation, restart, publication or deployment was performed. No approval action
was denied or left pending.
