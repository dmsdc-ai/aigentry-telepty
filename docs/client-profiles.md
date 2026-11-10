# Client profiles — `client-profile-scope-v1` (0.11.0, opt-in; issue #144 / Telesession issue16)

Status: **opt-in, default OFF.** If you configure nothing, the daemon behaves and answers byte-for-byte as 0.10.1:
- no capability is advertised;
- `/api/meta` has no `caller`;
- the `x-telepty-client-token` header is ignored;
- no id is reserved.

## What it is for

Two assistants on one host, run by the same OS user, should each get:
- their own inbox namespace;
- their own allowed targets;
- their own credential;
- a health answer that is truthful.

Each should be able to create, read, inject into and delete its **own** inbox. Each should be refused the same four operations on the other's inbox.

The shared host token (`x-telepty-token`) cannot do that. It is admin for every session, so it is **not** offered as a profile mode.

A profile is a **server-enforced** scope:
- The daemon verifies the profile credential.
- The daemon computes the caller.
- The daemon refuses everything outside the scope before any effect.

A client that only refuses on its own side, or prefix filtering, is not this feature.

## Enabling it

Set **one** of these:
- `TELEPTY_CLIENT_PROFILES_FILE=<absolute path>`. A non-empty value wins.
- `"clientProfilesFile": "<absolute path>"` in `~/.telepty/config.json`. A service-managed daemon reads this key; its descriptor carries no `TELEPTY_*` variable.

The daemon removes `TELEPTY_CLIENT_PROFILES_FILE` from its own environment after reading it, as it does for the supervision variables. Spawned sessions therefore never inherit it, and neither does a replacement daemon. For a setting that must survive restarts, use the config key.

When configured, the daemon **refuses to start**, with a fixed code and reason that never include the path or the file contents, if any of these holds:

| Condition | Code / reason |
|---|---|
| path not absolute / not normalized / control characters | `CLIENT_PROFILES_UNAVAILABLE` / `path_invalid` |
| native Windows | `CLIENT_PROFILES_UNAVAILABLE` / `platform_unsupported` |
| `TELEPTY_PRINCIPAL_MODE=strict` | `CLIENT_PROFILES_MODE_CONFLICT` |
| macOS without the bundled authority reader | `CLIENT_PROFILES_UNAVAILABLE` / `darwin_native_reader_unavailable` |
| file unreadable, unsafe or invalid | `CLIENT_PROFILES_UNAVAILABLE` / `<reason>` |

There is one exception to refusing start. If `TELEPTY_AUTH_TOKEN` supplied the secret and `~/.telepty/config.json` then cannot be read, the daemon starts with profiles **OFF**. It logs `[CLIENT-PROFILES] … UNAVAILABLE`. This is the same recovery shape as `supervisionTrustFile`. In that state a profile token gets the legacy `401 PERMISSION_DENIED`, so the fail-closed property holds.

## The profiles file (`telepty.client-profiles/v1`)

The file is private. The daemon reads it and nothing writes it except the operator.

It is read with the same reader as the principal trust files, `readAuthorityFile`:
- owner = euid or root;
- regular file, `nlink == 1`, mode `& 0o077 == 0`;
- descriptor-relative walk with no symlinks and no group/other-writable parent;
- stable read, **≤ 64 KiB**.

It is then parsed with `parseUnambiguousJSON`, which refuses duplicate keys and caps the document at 4096 JSON nodes and depth 32.

Synthetic example:

```json
{
  "schema": "telepty.client-profiles/v1",
  "profiles": [
    { "profile": "example-a", "inbox_prefix": "exa", "targets": ["example-target-1"], "generation": 1,
      "token_verifier": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      "not_before": "2026-11-11T00:00:00.000Z" }
  ]
}
```

Validation is whole-file and fail-closed. One bad entry refuses every profile.

| Field | Rule |
|---|---|
| keys | exactly `schema`, `profiles`; each entry exactly the six keys shown |
| `profile` | `^[a-z0-9][a-z0-9._-]{0,63}$`, unique |
| `inbox_prefix` | `^[A-Za-z0-9._]{1,48}$`, unique **case-insensitively** (no `-`, so namespaces are delimiter-anchored) |
| `targets` | ≥ 1 unique valid session ids, ≤ 128 B each. No target may be inside **any** profile's namespace (case-insensitive), and none may be `register`, `spawn`, `submit-all`, `multicast` or `broadcast` (any case) |
| `generation` | positive safe integer |
| `token_verifier` | `sha256:` + 64 lowercase hex, unique. Only the verifier is stored, never a token |
| `not_before` | RFC 3339 UTC `YYYY-MM-DDTHH:MM:SS[.mmm]Z`. **Keep it on rotation; use a fresh value whenever a prefix is (re-)granted** |

There are no profile-count or target-count caps. The bounds are the 64 KiB file, the field lengths above and the parser's 4096-node limit.

**Namespace** of a profile: ids equal to `<inbox_prefix>-i<32 lowercase hex>`. This is an exact, case-sensitive match, never a `startsWith` test, so prefix `ex` does not own `exa-i…`.

### Reload, rotation, revocation (no restart)

On every profile request, the daemon re-reads the file and takes its sha256:
- **Same digest:** the frozen, already-validated snapshot is reused.
- **Different digest:** the file is validated again and swapped in with a single assignment.

A stat signature is not used, so a same-size in-place edit with its mtime restored is still seen.

| Action | How | Effect |
|---|---|---|
| Rotate | Mint a new token, replace `token_verifier`, bump `generation`, keep `not_before` | The old token is `401 PROFILE_CREDENTIAL_INVALID` on the next request |
| Revoke | Delete the entry | Sessions created under it are **not** deleted. They stay operable by the host token and by their own #815 bearer where that already applies |
| Re-grant a prefix to another assistant | Give the entry a **fresh** `not_before` | The new holder sees none of the previous holder's inboxes, audit rows or observations created before that instant |

If a re-read fails after a good load, every profile request gets `503 PROFILE_REGISTRY_UNAVAILABLE` until a good read:
- the stale set is never served;
- there is no admin fallback;
- host-token callers are unaffected;
- configured namespaces stay reserved from the last good file.

**Linearization point = the gate.**
- A request admitted before a replacement file became visible completes, bounded by its handler's own timeouts.
- Every request whose gate starts afterwards sees the new set.
- This is **not** instant revocation of a request already admitted.

## The credential

- Format: `x-telepty-client-token: tpc1.<generation>.<43 base64url chars of 32 random bytes>`.
- The shape is checked first; only then is the sha256 verifier looked up and compared in constant time.
- The `<generation>` field is informative only. Editing it buys nothing.

On a request that carries the header (configured daemons only), these checks run after the origin and peer checks and before any strict / host-token / JWT / session-bearer admission:

| Rule | Refusal |
|---|---|
| Header presence is counted on raw headers, case-insensitively; an empty value counts. Exactly **one** `x-telepty-client-token`; at most one `x-telepty-session-token`, and only on inject / owned delete; **no** `authorization`, `x-telepty-token`, `x-telepty-principal`, `x-telepty-owner-token`, `x-telepty-input-policy-capability`, `x-telepty-bridge-capabilities`, `x-telepty-assertion`; no `token` / `owner_token` query key | `400 CREDENTIAL_AMBIGUOUS` |
| The **socket** peer must be loopback. The tailnet and `TELEPTY_HOST` listeners share the app | `403 PROFILE_REMOTE_DENIED` |
| registry unreadable / invalid | `503 PROFILE_REGISTRY_UNAVAILABLE` |
| unknown, stale or revoked token | `401 PROFILE_CREDENTIAL_INVALID` |
| any WebSocket upgrade carrying the header | `401 PROFILE_WEBSOCKET_UNSUPPORTED` |

A profile request **never** falls through to host-token, JWT, session-bearer or ordinary admission.

`telepty client-profile mint --profile <name> --generation <n> --token-file <abs>`:
- creates the token file with `O_CREAT|O_EXCL|O_NOFOLLOW` and mode 0600, under an existing same-owner parent that is not group- or other-writable;
- writes the bare token;
- prints `{profile, generation, token_verifier, not_before}`.

`telepty client-profile check [--file <abs>]`:
- validates the file with the daemon's reader and validator;
- prints names, prefixes, target counts, generations and `not_before`, never a verifier or a token.

Neither command contacts a daemon or edits the profiles file. Both refuse on Windows.

## The scope (default deny)

Paths match `req.path` exactly and case-sensitively, with no trailing slash. A `:id` segment is decoded once, may not contain `/`, and may not be a reserved segment. Everything else is `403 PROFILE_ACTION_DENIED` before any effect. That includes:
- spawn, kill and rename;
- submit, screen, state, diagnostics and handshake;
- mailbox, lease, handoff, takeover and threads;
- peers, forwarded, multicast, broadcast and `submit-all` injects, and bus publish;
- ledger and interaction routes, and `pendingReports`;
- daemon stop, approval challenges, `GET /api/sessions/:id`, `HEAD` and every WebSocket.

| Operation | Request | Server-side conditions (all before any effect) |
|---|---|---|
| meta | `GET /api/meta`, no query | adds `caller` (below) |
| list | `GET /api/sessions`, no query | answers `[{id}]` only: granted targets that exist, plus own-namespace sessions with `createdAt ≥ not_before`. Never `deliveryEndpoint`/`delivery` |
| create | `POST /api/sessions/register`, no query | keys ⊆ {`session_id`,`delivery_type`,`delivery_endpoint`,`command`,`create_only`}; `session_id` in own namespace (`PROFILE_NAMESPACE_DENIED`); `delivery_type:"aterm"`, `create_only:true`; `delivery_endpoint` `http://127.0.0.1:<1–65535>/<43 base64url>`; optional `command` printable ASCII ≤ 128 B (`PROFILE_REQUEST_FIELD_DENIED`). An existing id gets the unchanged `409 SESSION_EXISTS` |
| inject | `POST /api/sessions/:id/inject`, no query | keys ⊆ {`prompt`,`from`,`reply_to`,`exact_target`,`expected_epoch`}, `exact_target:true` (`PROFILE_REQUEST_FIELD_DENIED`); `:id` exactly one of the granted targets (`PROFILE_TARGET_DENIED`); `from` in own namespace, `reply_to === from`, exactly one `x-telepty-session-token` that verifies to `from` **with the live session's epoch and generation**, session not closing, `createdAt ≥ not_before` (`PROFILE_SENDER_DENIED`). `verified_sender_sid` is recorded as before |
| audit | `GET /api/injects` | query ⊆ {`to`,`from`,`since`,`until`,`limit`,`cursor`}, each a single non-empty string; `to` in own namespace, or `from` in own namespace with `to` absent or granted (`PROFILE_READ_DENIED`). Rows are **exact**: `to` ⇒ the resolved sid only (no alias row), `from` ⇒ `verified_sender_sid` only (never a claimed sender). `since := max(since, not_before)`. `cursor` is an offset into the caller's own filtered list |
| observe | `GET /api/inject-observations/:id`, no query | the record is the caller's only if `transport_source` is a string in its namespace **and** `created_at ≥ not_before`. Foreign, unknown, cold-offline and pre-`not_before` ids all get one uniform `tracking_unavailable` body with `reason:"not_observed_by_daemon_epoch"`. `consumption.active_inject_id` is never shown to a profile caller. The ledger-unhealthy reason stays global |
| delete | `DELETE /api/sessions/:id?owned=true` (the only query key) | `:id` in own namespace and an existing session with `createdAt ≥ not_before` (`PROFILE_NAMESPACE_DENIED`), then the unchanged #815 bearer + epoch + generation check (`403 OWNED_DELETE_FORBIDDEN`) |

The peer-lane guard (`AIGENTRY_ORCHESTRATOR_SIDS`), tracking capacity and every inject fence still run inside the handlers, unchanged.

### `/api/meta` health proof

When the feature is configured, `capabilities` includes `client-profile-scope-v1`, and `caller` is computed from the verified credential:
- profile caller: `{kind:"client-profile", profile, generation, inbox_prefix, targets, enforcement:"server", shared_token:false}`;
- any other caller: `{kind:"shared-control", enforcement:"none", shared_token:true}`.

The value is never echoed from the request.

### What changes for host-token callers when configured

One thing only: a non-profile `POST /api/sessions/register` of a **new** id, or a `PATCH` rename, **into** a configured namespace is refused with `403 PROFILE_NAMESPACE_RESERVED`. This stops a legacy holder from planting an inbox and history that a (re-)granted profile would then read. Everything else is unchanged.

## Boundary and residuals (stated, not fixed)

- **Same OS user.** A process running as the same user can read another profile's token file, the profiles file and any process environment. It can also **write** the profiles file, which grants profile scopes, though never admin. Choosing a profile by environment (`TELEPTY_CLIENT_PROFILES_FILE`, Telesession's `TELESESSION_PROFILE`) is configuration, not authentication. See BOUNDARY.md.
- **Shared capacity.** The two audit-query workers (`429 AUDIT_QUERY_BUSY`), tracking capacity (`503 TRACKING_CAPACITY`) and the 64 MiB hot budget are per-daemon, not per-profile. One profile can degrade another's reads and injects. Clients must treat these as retryable, not as enforcement failures.
- **Admitted requests are not revoked** (see the linearization point above).
- **Replay.** A captured inject request (client token plus inbox bearer) replays as a new inject. This is the bearer model, and same-host capture is out of scope.
- **Host-token holders stay admin.** They still see every session's `deliveryEndpoint`. An E1 inject with a claimed `from` in a profile namespace sets that record's `transport_source`, so the profile can observe it. It never appears in the profile's exact `from=` audit rows.
- **Other host-token creation paths** (spawn, handoff/takeover) are not namespace-reserved in v1. They are admin-originated.
- **Push primitive.** A profile inbox's `delivery_endpoint` makes the daemon POST `{text, session_id}` to a loopback port at one 43-character path. It uses `redirect:'error'` and sends no credentials.
- **Port squatting.** Something listening on the daemon port before it starts can capture whatever token a client sends. This is pre-existing for the host token too.
- **Native Windows: unsupported.** The daemon refuses to start with profiles configured. Shared-control mode is unchanged there.

## Evidence status

The finite maintained tests are `test/client-profile-scope.test.js` (unit) and `test/client-profile-daemon.test.js` (real spawned daemons: two profiles with own positives, cross-profile denials with byte-compared state, lifecycle, carriers, WebSocket, loopback, startup, feature-off). Native macOS and Linux runs, plus the Windows refusal run, are the acceptance evidence. A fake daemon is not.
