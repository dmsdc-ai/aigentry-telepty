# Bridge delivery contract (`bridge-stage-receipts-v1`)

Applies to `telepty allow` bridges and the daemon from Telepty 0.10.0 (task 1215, #136/#137).
This page describes what the bridge does with daemon `inject` frames it cannot write at once, and
what it reports back. Nothing here establishes that a model read, accepted or completed anything.

## Readiness (F1)

> Task 1215 repair: everything in this section is the **guarded worker's per-delivery interaction
> guard** (withhold while busy, modal, permission prompt, composer not observed, or user typing).
> It is not spawn readiness. Spawn readiness for every role is the authenticated transport
> handshake in *Spawn readiness milestones* below; `bridge_queue.first_ready_observed` and
> `ready_source` describe this guard only.

For a known AI CLI (codex, claude, gemini) on a local PTY, the bridge keeps a bounded VT grid
(`src/vt/session-screen.js`) fed with the child's actual output and resizes. While records are
pending, the 500 ms tick reads the rendered frame after 750 ms of output quiet
(`TELEPTY_BRIDGE_READY_SETTLE_MS`). A frame is ready only when it is a complete, current `vt_grid`,
no busy marker is in its bottom 6 rows, no modal owns it, and the user has not typed within the
idle threshold. A ready frame uses the same `onReady` route as the raw-tail detector.

There is no blind timer for a known AI CLI. This covers the first write and every write after the
first ready (the old 5 s fallback ignored busy and modal frames). If the VT library is unavailable,
or `TELEPTY_BRIDGE_VT_READY=0` is set, the raw-tail detector is the only ready source. Without a
ready, nothing is written.

## Bounded, visible wait (F2)

- **15 s** (`TELEPTY_BRIDGE_STALL_MS`): a pending record gets one `withheld` receipt per reason
  change. The reason is one of `first_ready_unobserved`, `ready_unobserved`, `busy_indicator`,
  `modal_ui`, `user_input_recent`, `handoff_pending` or `vt_unavailable`. Nothing is written.
- **600 s** (`TELEPTY_BRIDGE_INJECT_TTL_SECS`): the tick moves the record to dead letter as
  `expired_unwritten`, with its payload kept in `dead-letter.jsonl`. The receipt is `quarantined`
  with certainty `not_written`.
- A submit CR paired with an expired body is withdrawn in the same tick as `pair_unwritten`.
  A CR that arrives later for a quarantined body is `refused`. It is never written alone.

`bridge_queue` summaries (pending, in-flight, oldest age, phase `open|waiting|stalled|draining`,
reason, ready source, `vt`, `bridge_version`, `bridge_code_digest`) are sent on change, at most
once per second, and also ride the heartbeat. They are computed from an in-memory record index;
the tick never re-reads queue history. `vt` is `available`, `unavailable:<reason>`, `disabled`,
`awaiting_output` or `not_applicable`.

## Stage receipts (F3)

Every daemon inject frame carries `daemon_msg_id`, `inject_id`, `part` (`body`/`submit`), `pair`
(the body id, on a submit) and `owner_generation` when the daemon knows them. Old bridges ignore
these fields. The bridge sends payload-free `bridge_receipt` frames of at most 512 B. Each stage
allows only certain certainties:

| stage | certainty | meaning |
|---|---|---|
| `queued` | `not_written` | durably appended to the bridge mailbox |
| `withheld` | `not_written` | still pending; `reason` says why |
| `pty_written` | `written` | `child.write()` returned for this record. **A PTY master write only.** |
| `quarantined` | `not_written` / `unknown` | moved to dead letter with its payload; never written afterwards |
| `refused` | `not_written` | refused before any write |
| `unknown` | `unknown` | the write threw. Do not retry blindly. |

`consumed`, `turn_accepted` and `completed` are never emitted. The daemon refuses them.

The daemon advertises `bridge-stage-receipts-v1` in `/api/meta`. It accepts `bridge_receipt` and
`bridge_queue` only from the current owner socket, with the current `owner_generation`, and also
through the strict-owner transport. Shape and size are validated before any effect. A receipt is
filed on a tracked inject only when that record belongs to the same session, epoch and owner
generation. Diagnostics derive `input_written` and `submit_written` from `pty_written`, and
`queue` and `rejection` from the other stages. Consumption is never derived from a receipt.

A session whose bridge has not reported in the current owner generation shows
`bridge_receipts: unsupported_by_bridge`. That is an old bridge, not a delivered one.

## No relabel, no replay (F4)

- Flush drops (TTL, consecutive duplicate) are dead-lettered (`expired_unwritten`,
  `bridge_duplicate`), never acked.
- On start, records left by a previous bridge are quarantined, never replayed. Pending records
  become `recovered_previous_bridge` (`not_written`). In-flight records become
  `recovered_in_flight_unknown` (`unknown`).
- On a destroying exit (child exit, SIGTERM, daemon close 1000/4001), every record still pending
  or in flight is dead-lettered with its payload before the live queue files are cleared
  (`bridge_exit_unwritten` / `bridge_exit_in_flight_unknown`). If any record cannot be moved,
  nothing is purged. A refused claim (4003) touches nothing.
- Daemon ids are kept in the bridge's in-memory record index and in the dead-letter row. They are
  not written to `inbox.jsonl`/`state.jsonl`, whose strict custody schema does not admit them.

## Recipient input policy: user-supervised orchestrator vs guarded worker (task 1215)

Workers can show interaction and permission prompts, so they keep every screen gate above. The
orchestrator is watched and controlled by the user, so its input is not gated on screen
inspection. The authority is `src/mailbox/input-policy.js`.

| | `user-supervised` (orchestrator) | `guarded` (workers, unknown, default) |
|---|---|---|
| Daemon admission | Authenticated current owner, live owner WebSocket and that owner's `input_transport_ready` milestone. No screen ready gate (`isBootstrapGatedSession` is false), no modal classifier or park (`modalDeliveryDecision` delivers). Items queued before the handshake drain FIFO when it arrives. | `input_transport_ready` (never a screen `ready`) releases the bootstrap gate; then modal hold/park/refuse as before. |
| Bridge admission | Live child plus the user's own typing quiet (`IDLE_THRESHOLD`). No tail detector, no VT grid, no busy/modal/glyph/model/case matching. TEXT, paired CR, flush and own-record re-admission all use this rule. | Unchanged: tail or VT-frame ready; busy, modal, recent input, VT-unavailable and kill switch fail closed; no blind timer. |
| Always kept | Receipts, duplicate suppression, TTL/pair quarantine, previous-bridge quarantine (no blind replay), payload preservation, body-before-submit order. | Same. |

**How the policy is established (never inferred).** It is not read from a process or command name,
SID text, `--from`, payload text, inject-frame fields or bridge-reported fields.

1. *Request (registration).* `POST /api/sessions/register` takes `input_policy: "user-supervised" | "guarded"`.
   `user-supervised` is refused (the session stays guarded; the response sets
   `input_policy_refused: <code>`) in these cases:
   - another session's `x-telepty-session-token` is presented, or a new registration presents
     any session bearer (`INPUT_POLICY_SESSION_BEARER`);
   - a re-registration of a live instance does not present that instance's input-policy
     capability (`INPUT_POLICY_CAPABILITY_REQUIRED`) — **the session's own bearer is never enough**:
     the bridge exports it to the child, so it proves "a process of this session", not the host;
   - the request is not authenticated by a server-verified strict **operator principal**
     (`INPUT_POLICY_OPERATOR_REQUIRED`) — new instance or capability re-request alike. The legacy
     daemon token never qualifies: every wrapped child inherits it (`sessionEnv`, shared HOME
     config), so a token match, an omitted session header, SID/role text or a client env check is
     not host authority (task 1215 R1);
   - the request re-registers a live credentialed instance without that instance's own bearer
     (`SESSION_CREDENTIAL_REQUIRED`; this also applies to `guarded`, so an uncredentialed caller
     cannot downgrade it either);
   - the record has no credential (`INPUT_POLICY_CREDENTIAL_REQUIRED`);
   - the session is SSH, mailbox/aterm or external-approval protected (`INPUT_POLICY_UNSUPPORTED`);
   - in strict principal mode, the principal is not an `operator` (`INPUT_POLICY_OPERATOR_REQUIRED`;
     the principal middleware already refuses non-operator wrapped registrations).

   A granted request is only **pending**: `input_policy_pending: true`. The 201 of a granted host
   registration — and only it — also returns `input_policy_capability` (once, with the bearer). The
   bridge keeps it in memory only: never in `process.env`, the child's environment, logs or any
   view; the daemon keeps only its SHA-256, bound to the instance epoch, credential generation and
   the grant attempt, in memory (`WeakMap`, never in `sessions.json`).
2. *Bind (owner claim).* The next bearer-proved owner claim that ALSO presents
   `x-telepty-input-policy-capability` mints a new `owner_generation` and binds the pending policy to
   exactly that generation. A claim without the capability (for example a child holding the
   exported bearer) leaves the pending request untouched for its rightful owner and is guarded. A
   later claim without a fresh pending request is guarded. Stale capabilities stop verifying on
   downgrade, credential rotation, destroy/recreate or daemon restart; after a restart the bridge's
   re-registration is refused and prints the GUARDED warning — supervision fails closed and needs a
   relaunch.
3. *Bridge.* The bridge is supervised only when it was launched with
   `--input-policy user-supervised` **and** the daemon's `owner_token` for the current generation
   says `user-supervised`. On disconnect it is guarded. A launch from inside a telepty session
   (`TELEPTY_SESSION_ID`/`TELEPTY_SESSION_TOKEN` inherited) is refused. If supervision is lost
   mid-child, VT readiness reports `unavailable:mid_stream_after_supervision` and fails closed.

**Interface for the orchestrator boot helper (package consumer).** Run this from the host terminal,
not from inside a telepty-wrapped shell:

```
telepty allow --id <orchestrator-sid> --input-policy user-supervised <cli> [args...]
```

Check stderr: `input_policy user-supervised was not granted (...); this session runs GUARDED`
means the grant failed. Effective state is `GET /api/sessions/<sid>` → `transport.input_policy`
(`user-supervised` or `guarded`) and `transport.input_policy_source` (`operator_principal_registration`).
The launch must run with `TELEPTY_PRINCIPAL_CLIENT_FILE` naming an enrolled operator key (trust file
entry `authority: "operator"`) against a daemon started with `TELEPTY_PRINCIPAL_MODE=strict`; in legacy
mode the request is refused and the session runs guarded. Workers are launched without the flag, or with
`--input-policy guarded`.

**Combined mode (task 1215 auth-resume6 — source only, not yet independently run).** Ordinary
deployments keep their transport credentials (daemon token, session bearer, JWT peers); supervision needs
an ADDITIONAL operator proof:
- Daemon: `TELEPTY_SUPERVISION_TRUST_FILE=<trust file>` (same `telepty.principals/v1` format and reader
  as strict mode; the operator key needs a `session.register` grant for the orchestrator sid). Unset ⇒
  feature off, every `user-supervised` request refused `INPUT_POLICY_OPERATOR_REQUIRED`. Set but
  unreadable/invalid ⇒ the daemon does not start. Set together with `TELEPTY_PRINCIPAL_MODE=strict` ⇒
  `SUPERVISION_MODE_CONFLICT`, the daemon does not start. The challenge is served at
  `GET /api/auth/challenge`. The daemon removes both supervision variables from its own environment, so
  spawned sessions never inherit them.
- Verification: after ordinary admission, only `POST /api/sessions/register` with
  `input_policy: "user-supervised"` that carries `x-telepty-principal` is verified by the real principal
  verifier (method, target, body digest, action, audience, expiry, nonce replay, grant, operator-only,
  owner + epoch on re-registration). A presented proof that fails ⇒ the request is refused
  (`SUPERVISION_PROOF_INVALID`, `detail` = verifier code); no proof ⇒ registered guarded with the explicit
  refusal. The shared token, body flags, worker principals, forged, malformed or replayed proofs never
  grant. Every other request ignores the header.
- Bridge: `TELEPTY_SUPERVISION_CLIENT_FILE=<operator client config> telepty allow --id <sid>
  --input-policy user-supervised <cli>`. The client must target this local daemon (no SSH). It signs only
  the user-supervised registration (and its reconnect re-registration, epoch-bound). It does not switch
  to strict owner transport; combining it with `TELEPTY_PRINCIPAL_CLIENT_FILE`, or setting it without
  `--input-policy user-supervised`, is refused before anything starts. Both variables are removed from
  the child's environment. Removing variables does NOT keep the key from same-uid workers that know its
  path — key isolation remains a separately measured deployment gate.
- Strict mode (`TELEPTY_PRINCIPAL_MODE=strict`) is unchanged: no token fallback, no downgrade.
- Daemon restart / restore (task 1215 lifecycle-resume8 — source only, not yet independently run): the
  input-policy capability is memory-only and never persisted, so after a restore the bridge's held
  capability no longer verifies. The persisted owner can obtain a FRESH one by re-registering with
  `input_policy: "user-supervised"` when ALL of these hold: the request carries an operator assertion
  verified for `session.register` on that sid and bound to the record's current epoch; the principal
  equals the persisted `owningPrincipal` (id/source/audience); the presented session bearer verifies to
  that sid, epoch and current credential generation; and no live grant exists. The 200 response then
  returns the new capability once (the old one is never accepted); the next owner claim must present it.
  Other operators, workers, stale epochs, missing or failed bearers, and records without an
  `owningPrincipal` are refused and stay guarded. Limitation: a legacy record registered without an
  operator owner, or a bridge relaunched without the instance's bearer, cannot be promoted — there is no
  automatic takeover or credential reset; relaunch as a new instance instead.
- macOS: trust and client files are read by the native reader, whose directory-handle experiment is
  still unmeasured; until it is confirmed, combined mode on macOS cannot load its files. No prompt
  delivery or ACK is claimed from source.

**Trust boundary, stated plainly.** Supervision authority is the strict operator principal, verified
by the daemon (Ed25519 assertion bound to method, target, body digest, action, challenge, nonce and
epoch). The legacy daemon token grants no supervision at all, so a guarded worker child that strips
its session environment and reuses the inherited token is refused (`INPUT_POLICY_OPERATOR_REQUIRED`).
**Deployment prerequisite (pending, not provided by this package):** the operator private key must be
unreadable by guarded workers. cli.js removes `TELEPTY_PRINCIPAL_CLIENT_FILE` from the child env, but a
same-uid, same-HOME key file is not isolated merely because the env omits it; isolation needs confined
workers, a separate uid or a sandbox that denies the key path. Strict mode reads its trust and key files through `readAuthorityFile`, whose backend follows the
actual host platform (a `platform` option that disagrees fails closed).

**Platform support (task 1215 native-resume3 — SOURCE ONLY, native build and verification pending).**
- Linux: descriptor-relative reads via `/proc/self/fd` (unchanged).
- macOS: measured that `/dev/fd/<dirfd>/<name>` is not descriptor-relative there (`ENOENT`) and Node has
  no `openat`. The Darwin backend is a first-party Node-API reader,
  `src/principal/native/authority-darwin.c`, with ONE export `readVerified(path, maximum, privateFile)`:
  it pins every directory with `openat(…, O_EVTONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)` (an event-only
  handle: no directory data access is requested; whether openat/fstat/ACL reads accept it under a sandbox
  is UNMEASURED, pending an unchanged independent retest; no O_RDONLY or pathname fallback) relative to the
  previous descriptor, applies the Linux owner/mode/root-sticky rules, opens the leaf with
  `O_NOFOLLOW|O_NONBLOCK`, requires a regular file owned by root/uid with `nlink == 1`, size within
  `maximum`, no group/other bits when private, reads with a bounded loop and re-checks
  dev/ino/size/mtime/ctime; any extended-ACL ALLOW entry granting write/delete/security/owner rights, or
  an unreadable ACL, is unsafe. Every descriptor is closed and the buffer zeroed on all paths. Pathnames
  are never re-read, so a rename after a directory is pinned cannot redirect the read.
- Loading: `src/principal/authority-file-darwin.js` loads ONLY
  `src/principal/native/prebuilt/darwin/authority-darwin.node` (fixed package path, no override, no
  runtime compile or download). Absent or malformed → `reason: "darwin_native_reader_unavailable"`.
- Build (release/CI only): `node scripts/build-authority-darwin.mjs --cc <clang> --sdk <MacOSX SDK>
  --node-headers <dir with node_api.h>` → universal arm64+x86_64 bundle, `-mmacosx-version-min=11.0`,
  `NAPI_VERSION=8`, plus `authority-darwin.node.provenance.json` (source/header/compiler hashes, argv,
  archs, output sha256). Every compiler/lipo child gets only PATH, ZERO_AR_DATE, SOURCE_DATE_EPOCH,
  LANG and a private HOME/TMPDIR/TMP/TEMP inside a fresh 0700 `.build-*` directory beside the output
  (verified before any spawn, removed on success and failure; no inherited credentials, proxies or SDK
  search variables). Not hooked to any npm lifecycle script; the binary is not committed
  (`.gitignore`) and ships through `files: ["src/"]`. Supported runtime: macOS ≥ 11 on arm64 or
  x86_64, Node ≥ 20.
- CI: `test-install.yml` and `release.yml` macOS legs build before the suite; release job
  `authority-darwin` builds, checks `lipo -archs`, runs the native tests with **zero skips**, and
  `publish` re-verifies the sha256 and fails unless the tarball contains the binary + provenance.
- **Status: the binary has NOT been compiled; nothing above is measured yet.** Until the independent
  builder compiles, loads and tests it, macOS strict mode fails closed and the Mac orchestrator is not
  supervised. Sandboxed/confined filesystems may refuse `O_RDONLY` directory opens — not yet measured.
Windows: unsupported (fails closed).
Independent of platform, the threat model is other-uid substitution; a guarded worker running as the
operator's uid can read a `0600` key, so operator-key exclusion from workers remains a deployment gate.
Intentionally unsupported: earlier fixtures that obtained supervision with the legacy token (prior
independent IND-4, repair IND-R4, the legacy-harness #1215 daemon cases in
`test/bridge-actual-wiring-137.test.js`) now observe a refusal by design.
This repository change does not alter already-installed or
running sessions: they need the upgraded package, and the orchestrator must be relaunched with the
flag.

## Spawn readiness milestones (`input-transport-ready-v1`, every role)

A current bridge declares `x-telepty-bridge-capabilities: input-transport-ready-v1` on its owner
claim. `owner_token` then carries `transport_readiness: "input-transport-ready-v1"` and a fresh
per-generation `readiness_nonce`. The bridge sends two frames on the owner socket:

```
{"type":"process_started","schema":1,"session_id":"<sid>","session_epoch":"<epoch>","owner_generation":"<gen>",
 "readiness_nonce":"<nonce>","child_seq":1,"pid":12345,"exec":"unverified"}
{"type":"input_transport_ready","schema":1,"session_id":"<sid>","session_epoch":"<epoch>","owner_generation":"<gen>",
 "readiness_nonce":"<nonce>","child_seq":1,"input_loop":"attached"}
```

- `process_started`: node-pty returned the child. `exec: "unverified"` — a PID is not execution or
  application readiness.
- `input_transport_ready`: that child exists, its output/exit subscription is attached and the
  owner inject loop is live. Sent after start, after a restart, and re-sent to each new owner
  generation for a live child.
- The daemon accepts them only from the current owner socket with the exact sid, epoch, owner
  generation, nonce and an increasing `child_seq`; out-of-order, replayed, stale or wrong-owner
  frames are ignored. Readiness clears on child exit/restart, owner disconnect and owner replacement.
- For a negotiated owner, `input_transport_ready` is the ONLY release of the bootstrap gate for
  every role. Screen `ready` frames, the cmux prompt-symbol poll, the owner-alive floor and startup
  restore do not release it. If the handshake does not arrive within the bootstrap timeout, queued
  deliveries fail with `input_transport_ready_timeout` (never a blind write).
- An owner that does not declare the capability is LEGACY: pre-1215 behavior, milestones reported
  `unknown` with `legacy_bridge_no_handshake`.
- View: `GET /api/sessions/<sid>` → `transport.readiness` (`capability`, `process_started`,
  `input_transport_ready` each `observed|not_observed|unknown`, `meaning:
  "transport_only_not_instruction_receipt"`); diagnostics `layers.spawn_readiness`; bus events
  `session_process_started` / `session_input_transport_ready`.

Milestones are session facts, not message receipts. `instruction_received` needs a message-bound
application/provider acknowledgement; none exists today, so `transport.instruction_received` and
`diagnose --inject-id` → `messaging.instruction_received` are `unknown`
(`no_message_bound_provider_acknowledgement`). PTY write, Enter and the handshake never set it. The
real Telepty prompt+nonce ACK remains the final delivery gate.

## Consumer integration API for orchestrator-boot / dispatch (F3 — not integrated here)

This repository does not contain or change the orchestrator consumer. Installed consumer
integration is NOT claimed. What the consumer needs:

1. **Launch** (host shell, never inside a telepty session):
   `telepty allow --id <orch-sid> --input-policy user-supervised <cli> [args...]`.
   Workers: no flag (or `--input-policy guarded`).
2. **Confirm policy**: poll `GET /api/sessions/<orch-sid>` (host token) until
   `transport.input_policy == "user-supervised"`; treat stderr `this session runs GUARDED` or
   `guarded` as a failed launch (relaunch; do not fall back silently).
3. **Spawn readiness** (orchestrator and every worker): wait until
   `transport.readiness.input_transport_ready.status == "observed"` (or the bus event
   `session_input_transport_ready` for that sid and `owner_generation`). Do not wait on screen text,
   `transport.ready` or `bridge_queue.first_ready_observed`. `capability ==
   "legacy_bridge_no_handshake"` means an old bridge: keep the consumer's previous wait and flag it.
4. **Dispatch**: `POST /api/sessions/<sid>/inject` with the prompt. `bootstrap_queued: true` is
   accepted-and-waiting, not written. Per-message evidence:
   `telepty diagnose <sid> --inject-id <id>` → `messaging.input_written` / `submit_written`
   (`pty_master_write_only`), `instruction_received: unknown`.
5. **Receipt**: completion of a dispatched instruction is only the worker's own prompt+nonce ACK
   (real Telepty route). The consumer must keep that gate.

Compatibility transition: new daemon + old bridge = legacy behavior; old daemon + new bridge = the
bridge sends nothing (no `readiness_nonce`), and the `input_policy_capability` field is simply
absent, so a new bridge on an old daemon is guarded.

**Result semantics.** The inject response's `success` means accepted (and `bootstrap_queued` means
queued). It never means PTY-written or consumed. A force or terminal submit is reported as
"handed to the session transport; PTY write and consumption unconfirmed". A body still queued in
the bridge keeps its forced CR behind it. `pty_written` receipts (`diagnose --inject-id`) are the
PTY-write evidence. Consumption stays unknown.

## Limits

Synthetic fixtures and loopback tests show the mechanism only. They do not show native CLI frame
efficacy, the CPU and memory cost of the bridge VT, or actual Mac↔Linux model input and semantic
nonce ACK. Those are separate, measured prepublication gates.
