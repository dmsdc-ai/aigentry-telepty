# Linux candidate and Telesession compatibility completion

Telepty source tested: b842f0c5044b938977d5c64358ab6f7c8042dc43. Original
Telesession: 90d88aa212d73a5fba3862da17e76310e5b13c98, preserved unchanged.
Consumer repairs are isolated in sibling `telesession-candidate-compat-20261031`,
branch fix/telepty-uncertain-http, commit5dd25835baa50f7529879b19bb9912ba142e4bdb.
No installed package, operating daemon, real configuration/credential/mailbox,
network/security policy, remote repository or Mac target was changed or contacted.
The gateway429 was not retried or resolved by this work.

## Three actual contracts

The existing real-daemon capability suite passed **16/16**, no failures/skips,
3.4s: `/tmp/telepty-capabilities-compat-20261031.log`. This checks actual effects
and refusals independently of capability advertisement:

| Capability | Success | Refusal / retained boundary |
|---|---|---|
| inject-exact-target | Boolean exact_target:true targets the exact own record; response confirms session_id and exact_target, measured sink/audit agree | Missing/alias/sibling-only names404; nothing reaches sibling. Existing peer-lane guard still refuses. No-flag alias behavior remains unchanged. |
| register-create-only | Fresh exact SID201 with instance credential; exact inject reaches its endpoint | Collision409 SESSION_EXISTS before re-registration mutation; endpoint/record preserved. Existing ID validation and ordinary re-registration remain. |
| delete-owned-session | Exact owned=true plus current SID/epoch/generation credential deletes only its own record | Missing/foreign/stale credential403 OWNED_DELETE_FORBIDDEN; alias404; original session remains deliverable. Ordinary operator-token delete semantics are unchanged. |

Implementations: daemon capability list; src/routes/session-records.js create_only
check; src/routes/session-actions.js exact injection and owned-delete checks.
They are opt-in contracts, not a general strict-principal migration or identity
claim. Installed0.9.1 was not replaced and does not acquire these capabilities
because a candidate passed tests.

## Consumer integration and actual repairs

The unmodified consumer against this candidate passed8 real integration cases,
but failed its receiver-full expectation of200 plus automatic503 retry. The
candidate instead preserves unknown effect without replay. The old expectation
was not restored by weakening Telepty.

Two consumer defects were reproduced and repaired locally: inject5xx/explicit
delivery uncertainty was falsely stored as accepted:false/refused; and durable
audit recovery converted real failed:DELIVERY_UNCERTAIN back to refused. Both now
retain uncertain acceptance without resend. Verified attribution alone cannot
prove zero effect; failed:* stays unverified. Known403 and explicit blocked
refusal remain, as do success/queued acceptance and register/delete behavior.

New tests cover real bytes followed by503, memory/durable request-ID dedupe,
close/reopen against the candidate's real audit, and exact original payload in
quarantine. The updated receiver-full test frees space and confirms no replay.
The original consumer checkout remains unchanged; see the sibling repair report
`docs/2026-10-31-candidate-compatibility.md` for exact test corrections and evidence.

Final consumer full suite: **190 total /187 passed /zero failed /three skipped**,
33.5s; `/tmp/telesession-candidate-complete-20261031.log`. Skips are native Windows
credential persistence, native Windows path refusals and intentionally incoherent
simulated-win32 credential storage over POSIX paths. Real consumer integration9/9
passed (13 other tests excluded by name in that scoped run). Independent final
uncertainty/durability55/56 passed, zero failed, one native skip; no remaining
Important/Critical findings in bounded review. Syntax/diff checks passed.
The checked-in consumer-owned child fixture also enabled actual private-daemon
restart acceptance with its spawn-time credential. This is not Mac/provider proof.

No Telepty runtime code changed in this compatibility pass. Its prior full source
checkpoint remains2,532 pass/zero fail/three skip out of2,535, plus the fresh16
contract tests above. Those counts are separate, not summed or called a fresh
full-suite run. All network and process effects were private test fixtures.

## All55 cached issues, reclassified against current candidates

The canonical55-row inventory was checked locally: **23 local implementations,
29 partial, three remaining**. No remote refresh/issue closure was performed.
The23 local rows retain their original native/platform caveats:
#135,#129,#128,#124,#123,#121,#114,#111,#110,#109,#107,#105,#103,#101,#99,#93,
#83,#82,#67,#61,#60,#22,#11. Local compatibility evidence strengthens partial#102;
it does not establish the external/Mac path. The same32 residual rows are grouped
below exactly once, using the user's approved original REPORT/current foreign
trust/staged-auth directions. No repeated preparation tool is proposed here.

| Residual issues | Concrete remaining gate |
|---|---|
| #131,#130,#116,#115,#95,#92,#58,#31,#21 | Native Windows/macOS repro and acceptance: npm file holders/rollback, original ownership sequence, argv/ConPTY/Warp/cmux/launchd and native credential boundaries. Linux mocks cannot close them. |
| #106,#102,#98,#57,#39,#37 | Original stall causal trace and actual external Telesession/provider integration, turn acceptance/consumption/reply/completion evidence. Core-loopback success is now measured, but gateway429/current Mac/provider are not. |
| #134,#113,#96 | Actual client/writer inventory, authenticated registration/compatibility acceptance and separately authorized operational rollout. Static preflight and signed read-only inspection are not enrollment. |
| #133,#132,#100,#97,#47,#43,#42,#78,#40,#36 | Existing security refusals remain. REPORT delegation, historical/ambiguous replay, general raw control, foreign proof/reference fetch and protected action approval need separate exact contracts. IP membership and caller labels do not grant identity. #42 still includes source/API work after fetch authority/content/revocation contract, not merely native testing. |
| #122 | Full crash while all persistence fails requires independent durable exit/custody evidence. Existing observed-exit fencing and metadata retry cannot recreate information that was never persisted. |
| #94,#30,#12 | Publication authorization/target, owning Workspace Host repository scope, and actual remote provider/API contract for unsupported model/update/picker/workspace behavior. No cross-repository operational or remote change is authorized. |

There is no further independently reproduced Telepty product defect in this pass.
User-requested install/startup usability work continues in the isolated consumer
clone; it must not be misreported as deployment or a recovered gateway.

## Install-flow completion follow-up

The isolated consumer advanced to91b8c9b69cc7648def83f9c951b5d3a9975dbdda.
Actual help/version/unknown-argument and missing-tarball-document defects were
reproduced and fixed. Its full suite now passes190/193, zero failed, three
native/platform skips; exact CI unit passes103/105, zero failed, two skips.
Independent entrypoint/pack3/3 and real installed-MCP acceptance passed.

A clean local archive was actually installed offline into a new private npm prefix,
with lifecycle scripts disabled and a separate sanitized public dependency cache.
The installed package/SDK/zod are real directories, not source symlinks. Installed
npm shim, five MCP tools, durable send, stable request-ID dedupe, credential-bound
reply and owned close/target preservation all pass. The reusable runner's timeout
and realpath truthfulness issues were corrected before final artifact acceptance.

Artifact: sibling workspace folder `telesession-artifacts-20261031`, containing
`dmsdc-ai-telesession-0.1.0.tgz`, manifest.json and SHA256SUMS. Archive size59,909
bytes; SHA256 b3b4d63ad61c263cef9951e194354968b7c79ab482c2daf110408bcca62dc732.
Manifest captures exact source, Node20.20.0/npm10.8.2 and installed SDK1.32.2/zod3.25.76.
Final installed acceptance: `/tmp/telesession-final-artifact-acceptance-20261031.log`.
Source core and installation reports are in the sibling consumer's docs directory.

No external publish or operating change occurred. Source target is
dmsdc-ai/aigentry-telesession; current package remains @dmsdc-ai/telesession@0.1.0,
private:true. Final registry version/dist-tag/access and posting authorization
remain unresolved. Compatible operating Telepty activation, gateway429, actual
Mac/provider and native cross-OS acceptance remain separate gates. The55-row
disposition and32 residual conditions above are unchanged; Linux local repair and
isolated installation completion must not be described as all issues closed.
