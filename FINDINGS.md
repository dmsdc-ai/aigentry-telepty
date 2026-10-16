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
| ace25647 | HIGH | 3501 | TRUE POSITIVE (via session_id → PS1) | fixed e40997d |
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
