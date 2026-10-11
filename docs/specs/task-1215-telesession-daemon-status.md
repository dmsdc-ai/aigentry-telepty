# STATUS — task 1215: opt-in telesession daemon capability candidate

- **Branch**: `wip/task-1215-telesession-daemon` (work in progress; not for merge as-is)
- **Kind**: source patch only. This branch is not a release, does not publish to npm, and does not activate anything on a running daemon.
- **Baseline**: `main` at `1b954c292b93572ac24b4fb72923d83c6b84a2fb` (package version 0.8.5)

## 1. What the patch adds

The patch changes only `daemon.js`. It adds three opt-in capabilities, and `GET /api/meta` advertises them in `capabilities`:

| Capability | Opt-in trigger | Behaviour when opted in |
|---|---|---|
| `register-create-only` | `POST /api/sessions/register` with body `create_only: true` (boolean) | If the id already exists, returns `409 SESSION_EXISTS` and leaves the existing record unchanged. A non-string id returns `400 INVALID_REQUEST`. The check runs before any existing-record mutation, and the handler stays synchronous up to the insert. |
| `inject-exact-target` | `POST /api/sessions/:id/inject` with body `exact_target: true` (boolean) | Resolves only an own-property session id, with no alias or sibling fallback. A miss returns `404 SESSION_NOT_FOUND` with `exact_target: true`. On success the response echoes `exact_target: true` and `session_id`. |
| `delete-owned-session` | `DELETE /api/sessions/:id?owned=true` | Matches only the exact own-property id, with no alias resolution. The caller's verified principal must match the session's current sid, epoch and credential generation. Otherwise it returns `403 OWNED_DELETE_FORBIDDEN` before any side effect. |

## 2. Backward compatibility intent (not proven)

The **intent** is that a caller that does not opt in sees the baseline behaviour:
- Without `create_only === true`, register keeps its existing idempotent re-register path.
- Without `exact_target === true`, inject still uses `resolveSessionAlias`.
- Without `owned=true`, delete still uses `resolveSessionForDestroy`.
- The only change visible to every caller is three extra strings in `/api/meta` `capabilities`.

This is a statement of intent, read from the source. **It is not proof.** No daemon test has been run against this branch (§4).

## 3. Known limitation (preserved, not fixed)

The capability patch does **not** implement or change:
- credential restoration or adoption on restart;
- the session GC sweep;
- the WebSocket owner-claim gate;
- persistence of claims.

Those code paths are byte-identical to the baseline. Restart risks in those areas (for example, a restored record that is garbage-collected before its owner reclaims it) still apply to this candidate.

## 4. Evidence status

| Item | Status |
|---|---|
| Patch identity | `daemon.js` on this branch equals the baseline plus the candidate diff, byte for byte (checked at assembly with sha256 and `cmp`). |
| `test/restart-credential-reclaim-1215.test.js` | Supplied as-is from the authoring stage. That stage reported a syntax check (`node --check`) only. Assembly did not run it. **All actual daemon tests: NOTRUN.** |
| Test fixture | `test-support/restart-credential-child-1215.js` is the in-PTY sender used by the RC suite. It was supplied as-is from the authoring stage, needs only Node built-ins, and talks only to loopback fixture daemons (never port 3848). Assembly did not run it: **NOTRUN**. The RC suite is not listed in `npm test` / `test:ci` / `test:ci:pty`. |
| Earlier fake-VM run (22 acceptance checks, 36 pass, 13 excluded) | Ran against a fake telepty and a synthetic suite. **It is not real-daemon evidence** for this candidate. |
| Current `main` / live 0.8.5 | Does **not** advertise or implement these three capabilities. |
| Real end-to-end check (Dot client, tunnel) | **Pending.** Not run. |
| Security scan | No new scan was run for this branch. `daemon.js` is the supplied candidate bytes, and the RC test and its fixture were authored upstream with a Snyk scan reported as owed (CLI unavailable at authoring). This branch makes no "clean" claim. |

## 5. Hashes (sha256)

| Artifact | sha256 |
|---|---|
| baseline `daemon.js` (at `1b954c29`) | `a99e58872ed4d969f23d25bce6abf97eb6d01691657dd892699d6a591e0464ae` |
| candidate `daemon.js` (this branch) | `70dd0ca7a322e465f7c940b9b6cdd8c4e3446ba799034ba25b3e0269f1dabdcf` |
| candidate diff (`diff -u`, `a/daemon.js` → `b/daemon.js`) | `ddcd4a5f2974a3869e6028f2c43724fff94daedfc4d309fd7875d60776298f54` |
| `test/restart-credential-reclaim-1215.test.js` | `190ad68503885b32c57513c0cb6cb5c8a7fb65a6f515df0f8768007c40d39e5f` |
| `test-support/restart-credential-child-1215.js` | `e72407ec02f6cf85859f17dc0ba5346d85fbeaf6097b0e448708780dd3c29d6f` |

## 6. What this branch does not imply

- No version bump, tag, npm publish or GitHub Release.
- No restart or reconfiguration of any operating daemon.
- No claim of release readiness. Moving forward needs at least: a real-daemon test run, a security scan of the new first-party test code, and the pending end-to-end verification.
