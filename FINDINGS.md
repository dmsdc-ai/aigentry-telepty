# Snyk Code findings — telepty PR #108 head db2f532 (task #2026101201)

Source of the findings list: Mac scan 2026-10-16 17:14Z as relayed in the orchestrator's
`state/reviews/snyk-1238/2026-10-16-transport-findings.md`. SCAN.json is Mac-local, so the exact Snyk
rule ids and data-flow traces were **not seen** here; each verdict below is from reading the flagged
line and its flow, and the true positives are reproduced against a real daemon by
`test/snyk-pr108-findings.test.js` (RED on db2f532: `evidence-snyk/repro-before.log`, 8 fail / 1 pass;
GREEN after the fix: `evidence-snyk/repro-after.log`, 9 pass).

Every flagged line is pre-existing (blame: 87707ef and earlier, all ancestors of base e86f414).

Reachability, common to all routes: every route after `/api/health` is behind `createAuthMiddleware`
(daemon.js, `app.use(createAuthMiddleware(...))`): origin guard → peer allowlist → daemon token or
JWT for every address including loopback (#820; `test/loopback-not-a-credential-820.test.js` case 6
asserts an uncredentialed spawn is 401). So "attacker" below means a holder of the daemon token, or
input a token holder relays from somewhere else (e.g. a session id derived from a task name).

| id | sev | line | verdict | fix / disposition |
|---|---|---|---|---|
| ace25647 | HIGH | 3501 | TRUE POSITIVE (via session_id **and type** → PS1) | session_id: e40997d; type: **missed in round 1**, fixed 9826617 (round 2) |
| 9ca81d65 | MED | 251 | TRUE POSITIVE (information exposure) | fixed 29b0de7 |
| 4ce269b3 | MED | 3484 | TRUE POSITIVE (log rewriting) | fixed e40997d |
| 7e65d918 | MED | 3473 | FALSE POSITIVE as a security boundary | disposition below, no change |
| c28e5ccb | MED | 5240 | TRUE POSITIVE | fixed 25b1399 |
| 824c56bc | MED | 5654 | TRUE POSITIVE (conditional on a prior pollution) | fixed 25b1399 |
| f29f900e | MED | 5682 | TRUE POSITIVE | fixed 25b1399 |
| 655151ed | MED | 5786 | TRUE POSITIVE | fixed 25b1399 |
| d07e1fda | LOW | 3493 | TRUE POSITIVE | fixed e40997d |
| 39d3b3ec | LOW | 3495 | TRUE POSITIVE | fixed e40997d |
| e933068f | LOW | 5758 | TRUE POSITIVE | fixed 3600a8a |

(Line numbers are at db2f532; the fixes shift them.)

## ace25647 — HIGH — Command Injection, daemon.js:3501 `pty.spawn(shell, shellArgs, …)`

Flow: `req.body.{command,args,cwd,session_id}` → `pty.spawn`.

- `command`/`args` → spawn: on POSIX node-pty forks and execs `file` with the argv array
  (`node_modules/node-pty/lib/unixTerminal.js` → native `pty.fork`); no shell parses them. Running the
  program the caller names is what the endpoint is for (`telepty spawn --id X <command> [args…]`,
  cli.js), and only a token holder reaches it. This half of the flow is the designed capability, not an
  injection, and is unchanged — so the rescan is expected to keep reporting this id on that flow.
- `session_id` → `customEnv.PS1` (3494) / `customEnv.PROMPT` (3497) → the spawned shell. **This is a
  real injection.** bash expands PS1 on every prompt (backslash decoding, then parameter expansion and
  command substitution under the default `promptvars`), so data in the id is executed as code; `\NNN`
  octal can also produce `$`. Reproduced: `session_id = 'x$(touch <tmp>/ran)'` with the harness's
  `bash --noprofile --norc` created the marker file on db2f532. zsh does the same with `PROMPT_SUBST`.
  This turns a caller-chosen *name* into code, which matters when the id is relayed from elsewhere.
- Fix (e40997d): spawn refuses a `session_id` containing `$`, `` ` `` or `\` with
  400 `INVALID_SESSION_ID`, before any env is built. Ordinary ids (`createSessionId` shape) still spawn
  (test "an ordinary session id still spawns").
- **Correction (round 2):** that fix was incomplete. `type` is upper-cased into the same PS1/PROMPT
  label and was only checked to be a string, so `USER$($'\164…' …)` still ran a command
  (review B1/C1, reproduced on 5ddcecb). The id denylist also let control characters and zsh `%`
  sequences through (C2). Both are fixed in round 2 below.
- Residual, not changed: on Windows the daemon runs `cmd.exe /c <command> <args…>`, so cmd
  metacharacters in `args` are interpreted by cmd. Same principal (the caller already chooses the
  command), not testable on this Linux host, and switching to direct exec changes `.cmd` shim
  resolution (see `src/win-resolve-executable.js`). Raised as a follow-up, not fixed here.

## 9ca81d65 — MEDIUM — X-Powered-By header, daemon.js:251

`express()` default sends `X-Powered-By: Express` on every response, including the unauthenticated
`/api/health`. Reproduced (header value `Express`). Fix (29b0de7): `app.disable('x-powered-by')`.

## 4ce269b3 — MEDIUM — externally-controlled format string, daemon.js:3484

`console.log(\`[SPAWN] Spawning ${shell} with args:\`, shellArgs, …)` made the caller's `command` the
`util.format` format string. Reproduced: command `no-such-command-%s-%o` logged
`Spawning no-such-command-[ 'ARGV-SENTINEL' ]-'in cwd:' with args: <cwd>` — the args and cwd were
pulled into the command position, so the log no longer says what was run. Fix (e40997d): constant
format `'[SPAWN] Spawning %s with args:'` with `shell` as an argument.

## 7e65d918 — MEDIUM — resources without limits, daemon.js:3473 (spawn route)

Disposition: no change; not a security boundary here.
- The route is token-gated (see Reachability). The token holder can already run any program and type
  into every session; a per-route throttle bounds nothing that holder cannot do another way.
- Request size is bounded by `express.json()`'s default 100 kB body limit (daemon.js:254).
- `cols`/`rows` go to `parseInt` → node-pty → the kernel `winsize` (16-bit); the daemon allocates
  nothing proportional to them. `args` is bounded by the body limit and now type-checked (e40997d).
- Adding a rate limiter would be a new dependency or a new mechanism (Article 1/17) for no boundary.
Not measured: the exact Snyk rule behind this id (SCAN.json is Mac-local).

## c28e5ccb — MEDIUM — Prototype Pollution, daemon.js:5240 (PATCH /api/sessions/:id)

`sessions` was `{}`. `PATCH /api/sessions/__proto__ {new_id}`: `resolveSessionAlias('__proto__')`
returned `'__proto__'` (because `sessions['__proto__']` is the truthy `Object.prototype`), so
`session = Object.prototype`, then `session.id = new_id` wrote `Object.prototype.id` in the daemon.
Reproduced: 200 on db2f532. Fix (25b1399): `sessions`, `handoffs`, `threads` are
`Object.create(null)`, so `__proto__`/`constructor` are ordinary absent keys → 404. No code calls
prototype methods on these maps (checked: only `Object.keys/values/entries`, indexing, `delete`, and
`Object.prototype.hasOwnProperty.call`).

## 824c56bc — MEDIUM — Prototype Pollution, daemon.js:5654 (POST /api/handoff/:id/claim)

`handoffs['__proto__']` → `Object.prototype`. On a clean prototype the `status !== 'pending'` guard
answers 409, but once anything has set `Object.prototype.status = 'pending'` (e.g. the PATCH sibling
below) the claim writes `status`, `claimed_by`, `updated_at` onto `Object.prototype`. Reproduced as
not-404 on db2f532. Fixed by the same null-prototype change (25b1399).

## f29f900e — MEDIUM — Prototype Pollution, daemon.js:5682 (PATCH /api/handoff/:id)

With no `status` in the body, `handoff.result = result` and `handoff.updated_at = …` write straight
onto `Object.prototype`. Reproduced as not-404 on db2f532. Fixed by 25b1399.

## 655151ed — MEDIUM — Prototype Pollution, daemon.js:5786 (PATCH /api/threads/:id)

`thread.message_count = message_count` / `thread.updated_at` on `Object.prototype`. Reproduced as
not-404 on db2f532. Fixed by 25b1399.

## d07e1fda / 39d3b3ec — LOW — Improper Type Validation, daemon.js:3493 / 3495

`command.includes('bash')` / `command.includes('zsh')` (and `type.toUpperCase()`) on unchecked body
values: an array `command` passes `.includes` and reaches `pty.spawn`; other shapes throw.
Reproduced: `command: ['bash']` → 500 on db2f532. Fix (e40997d): `session_id`, `command`, `cwd`,
`type` must be strings and `args` an array of strings, else 400 `INVALID_REQUEST` before any use.

## e933068f — LOW — Improper Type Validation, daemon.js:5758 (POST /api/threads)

`participant_session_ids` was stored and `.length`-counted as given: `"abc"` was accepted (201) and
broadcast to the bus as a participant list. Fix (3600a8a): when supplied (truthy) it must be an array
of strings, else 400; omitted still defaults to `[]`. The CLI sends an array of ids (cli.js `threads`).

# Mac static re-review of db2f532 — TP1 / TP2 (P1, owned here)

Source: orchestrator `state/reviews/snyk-1238/2026-10-16-mac-transport-rereview.md` (source-derived,
not executed). Both are reproduced here as tests (`test/inject-owner-pairing-pr108.test.js`, RED on
29498cd before the fix, 4 fail / 1 pass: `evidence-snyk/tp-repro-before-full.log`; GREEN after,
5/5).

| id | verdict | fix |
|---|---|---|
| TP1 owner takeover | TRUE POSITIVE, reproduced | f0525371 |
| TP2 CR before text | TRUE POSITIVE, reproduced | 1845b131 + f0525371 |

## TP1 — same-bearer owner takeover during the queued wait / deferred CR

A second `?owner=1` claim that presents the same bearer keeps the session record and its epoch
(`verify(bearer).epoch` does not change), so the #109 checks (`sessions[id] === session` and the
epoch) pass, but `ownerWs` is replaced (src/transport/websocket.js ownership transfer). Measured:
- deferred CR: the replacement owner received `["\r"]` for text that went to the displaced owner;
- queued inject: the replacement received `["\r","second queued behind it","\r"]`, and the call
  answered 200.

Fix (f0525371): the ownership generation is the owner **socket**. `deliverInjectionToSession`
captures `session.ownerWs` on entry, and after the barrier wait it requires the same socket as well as
the same instance, or it answers 410 `SESSION_GONE`. The deferred CR goes only to the socket that
the text was actually written to, otherwise it emits `inject_failed` (`phase: submit`,
`SESSION_GONE`). The direct-fallback path applies the same rule. No token is compared or logged. Rename
keeps the socket, so it still gets its CR (the #109 rename test still passes). A reconnect *between* text and
CR now gets the typed failure and no CR, because the daemon cannot tell a reconnect from a same-bearer
takeover by the bearer alone. Injects sent after a reconnect deliver normally.

## TP2 — CR before text when `mailboxDelivery.tick()` returns during an in-flight tick

`DeliveryEngine._tick` returns immediately when `_tickInProgress` (src/mailbox/delivery.js), so the
inject path's `await mailboxDelivery.tick()` did not mean its text was written. The CR timer then
wrote `\r` first. Measured with an aterm session whose HTTP endpoint answers after 2 s occupying the
tick: the wrapped owner received `["\r","hello"]`.

Fix:
- 1845b131: `FileMailbox.withdraw(sessionId, msgId, reason)`. Under the session lock, a message
  still in `pending` goes to dead letter (existing state/vocabulary, so the Rust crate's format is
  unaffected). It returns false if a deliverer holds it (`in_flight`) or it is already done.
- f0525371: when an inject owes a CR (not `noEnter`, not aterm) it waits for **its msg_id** to be written.
  The mailbox `deliverFn` settles the waiter with the owner socket it wrote to, and any failed
  attempt is remembered while the engine's normal nack and retry continue. The wait is bounded by
  `2 × TELEPTY_DELIVERY_TIMEOUT_MS` (default 10000 ms): one in-flight delivery to another session plus
  our own.
  - Delivered → 200 as before, and the CR (after the same 500/300 ms delay) goes only to that socket.
  - Not delivered and still pending → withdrawn → typed failure (the last delivery error, else
    504 `TIMEOUT`). It can never land later without its CR, and a retry cannot duplicate it.
  - Not delivered but in flight → 504 `DELIVERY_UNCERTAIN` with no CR, so the caller is told not
    to retry blindly. No-duplicate is kept because nothing is re-sent.
  - The barrier is released on every outcome.
- `noEnter` and aterm injects keep the old path: no CR is owed.

Residuals (not changed):
- The engine's single-flight tick still makes one slow session delay other sessions'
  deliveries (head-of-line, pre-existing). This now shows up as a bounded wait or a typed TIMEOUT
  instead of a CR before its text.
- Not measured: how the route's ledger and audit classify the new `DELIVERY_UNCERTAIN`. It takes the
  generic refusal arm.
- The non-blocking review notes are not addressed here: `pendingSubmit` is not durable, and the
  10000 ms barrier bound sits against telesession's 10000 ms client deadline.

# Round 2 — shell-string class (independent review ROUND2-REVIEW.md, verdict REVISE)

Scope from the orchestrator: fix C1–C5, C7, C8 and N1. C6 is unchanged. N2/N3/N4 are unchanged.
Every item has a test in `test/shell-string-class-pr108-r2.test.js`. On 5ddcecb the final file
has 14 fail / 1 pass (`round2-fix-evidence/red-final-file-on-5ddcecb.log`; the committed RED
state, before the `messageState` unit test was added, was 13 / 1 in `red-on-5ddcecb.log`). The only
pass is "ids in use still spawn", a guard against over-blocking. On the new head: 15 / 15
(`green-on-head.log`).

| item | sink | reproduced on 5ddcecb | fix |
|---|---|---|---|
| C1 | spawn `type` → PS1/PROMPT label | marker created by `$'\NNN'` payload, 201 | 9826617: `type` ∈ {USER, AGENT}, else 400 `INVALID_SESSION_TYPE` |
| C2 | spawn `session_id` → PS1/PROMPT | ESC/BEL id → 201 | f8d43bf: `^[A-Za-z0-9._:@-]+$` and not `__proto__`/`constructor`/`prototype` (`src/session-id.js`), else 400 `INVALID_SESSION_ID` |
| C3 | WS id → `kitty @ … set-tab-title '…${id}'` via /bin/sh | `';touch$IFS$VAR;'` id ran `touch` in the transport | bc8d00d: `src/kitty-control.js`, `execFileSync('kitty', argv)` |
| C4 | `/tmp/kitty-sock*` name → same shell strings | `kitty-sock;touch <tmp>` name ran `touch` in the transport | bc8d00d: argv only, and the socket must match `kitty-sock[A-Za-z0-9._-]*` and pass `lstat` as a socket, not a symlink, owned by `process.getuid()` |
| C5 | id / cwd basename → AppleScript in `osascript -e '…'` via /bin/sh | `submitViaOsascript` was not exported (module-missing fail) | df90fcd: `execFileSync('osascript', ['-e', script, ...terms])` with `on run argv` |
| C7 | id → OSC 0 title in cli.js (3 sites) | helper missing; source still interpolated the raw id | 18ef9eb: `formatTerminalTitle` strips U+0000–001F, U+007F–009F |
| C8 | id → `ssh … telepty attach <id>` remote shell | `w1;touch <tmp>` ran `touch` when the joined remote command went through /bin/sh | d6bc8a9: `shellQuote(sessionId)`, as `remoteInject` already does |
| N1 | destroyed session's unpaired text | 504 `DELIVERY_UNCERTAIN` | 4cf6414: `FileMailbox.messageState()`. If `withdraw` fails: no record → 410 `SESSION_GONE`; `dead_letter` → typed non-delivery; else `DELIVERY_UNCERTAIN` |

How the C3/C4 reproduction was made safe: the test calls the real `installWebSocketTransport`. It
injects `findKittySocket` (the socket name) and `findKittyWindowId`, and sets `PATH` to a temp dir
that holds only `touch`. The real `kitty` installed on this host is never reached, and no
`/tmp/kitty-sock*` file is created. The `findKittySocket` ownership check uses an injected `fs`
for the socket cases, because this sandbox refuses `listen` on unix sockets (EPERM). It uses the
real fs for the planted regular file and the symlink.

C6 (Windows `cmd.exe /c`): unchanged. `test/win32-cmd-argv-characterisation-c6.test.js` pins the
current argv and command line on Linux (platform faked for the spawn route's `isWin` line only;
node-pty spawn recorded, nothing executed).

Not measured: macOS `osascript` with `on run argv` (no macOS here; only the argv is tested). A
live kitty with a real socket (sandbox EPERM; seam only). zsh. The ssh attach against a real peer
(the argv was checked through /bin/sh locally). Windows.

Remaining, not changed (Rule 29, mention only):
- `POST /api/sessions/register` and the WS auto-register accept ids without the allowlist. Their
  sinks are now argv or stripped. `constructor` via register remains (N5, register path).
- `cli.js` `findKittySocketCli` and `terminal-backend.js` `detectTerminal` still test
  `startsWith('kitty-sock')` in `/tmp`. They only check that such a file exists and execute nothing.
