# Snyk Code findings — telepty PR #108 head 9cff4bf (task #2026101201)

Source: `SNYK-9CFF4BF.md` (Mac scan, 15 findings). SCAN.json is Mac-local, so the exact data-flow
traces were **not seen** here. Each verdict comes from the flagged line at 9cff4bf, `git blame`, and
the input's path to the sink. True positives are reproduced by `test/snyk-9cff4bf-findings.test.js`:
- RED on 9cff4bf: 4/4 fail (`fu108-evidence/snyk-red-on-9cff4bf.log`).
- GREEN on the new head: 4/4 pass.

Attribution: "pre-existing" means the same code is present on db2f532 **and** e86f414 (checked with
`git show <rev>:<file> | grep`) and blame points before PR #108. Line numbers are at 9cff4bf.

Trust boundary (as in `FINDINGS.md` / ROUND2-REVIEW): every daemon route after `/api/health` needs the
daemon token or a JWT, and a holder can already run any program via spawn. CLI findings take input
from the local user's own argv/env.

| id | sev | location | attribution | verdict | evidence | fix commit |
|---|---|---|---|---|---|---|
| ace25647 | HIGH | daemon.js:3572 `pty.spawn(shell, shellArgs)` | pre-existing (87707ef6, 2026-03-11) | PARTIAL CLOSURE + EXPLICIT CAPABILITY (not scanner-zero) | see §ace25647 | id/type → PS1 closed: f8d43bf, 9826617, 136e276; command/args capability kept; Windows #115 open |
| 4fc6e5b9 | HIGH | daemon.js:3973 `mailbox.purge(id)` (DELETE /mailbox) | pre-existing (6790a0aa) | TRUE POSITIVE | registered `../x` → `~/.aigentry/x/*.jsonl` truncated (reproduced on a real daemon) | fad5878 (storage), 7bc4c36 (register/WS), 5089d92 (rename) |
| 4158b586 | HIGH | daemon.js:3984 `mailbox.purgeDeadLetter(id)` | pre-existing (6790a0aa) | TRUE POSITIVE | same; `dead-letter.jsonl` outside root truncated | fad5878 (storage), 7bc4c36 (register/WS), 5089d92 (rename) |
| 20746b91 | HIGH | daemon.js:5452 `mailbox.purge(id)` (session DELETE) | pre-existing (fa803cfa) | TRUE POSITIVE | same | fad5878 (storage), 7bc4c36 (register/WS), 5089d92 (rename) |
| aadc4863 | MED | cli.js:4749 `crossMachine.connect(target)` | pre-existing (44d9fc39) | TRUE POSITIVE (sink); local-user input | `u@h;touch M;#` ran `touch` via `/bin/sh` (cross-machine.js:191-224 `execSync` strings) | 09bc039 (+5364137 test) |
| 0ab74261 | MED | cli.js:4804 `crossMachine.disconnect(name)` | pre-existing (44d9fc39) | TRUE POSITIVE (sink), same class | `execSync` string with `peer.target` (cross-machine.js:258) ran the injected `touch` | 09bc039 |
| deee8c0c | MED | cli.js:4820 `crossMachine.removePeer(name)` | pre-existing (44d9fc39) | TRUE POSITIVE (sink), same class | `removePeer` → `disconnect` → same sink | 09bc039 |
| 60abffa8 | MED | cli.js:1084 `execSync(TELEPTY_UPDATE_COMMAND)` | pre-existing (d6e51135) | INTENTIONAL CAPABILITY under a trusted env (no boundary crossed) | the source is the CLI user's own environment; setting it already requires control of that user's shell | none |
| 22ba77be | MED | cli.js:2581 `pty.spawn(resolvedCommand, cmdArgs)` | pre-existing (874d14a2) | INTENTIONAL CAPABILITY under a trusted caller | `telepty allow <command> [args]`: the user's argv goes to node-pty as an argv array, with no shell on POSIX; running that program is the feature | none |
| 3ea0a390 | MED | cli.js:2581 (same line) | pre-existing (874d14a2) | INTENTIONAL CAPABILITY, as 22ba77be | Two ids on one line; probably the command and args flows (not measured) | none |
| 7e65d918 | MED | daemon.js:3532 spawn route | pre-existing (76203de0) | ACCEPTED AVAILABILITY RISK under principal trust (not a blanket FP) | see §7e65d918 | none |
| 0b79a913 | LOW | cli.js:3066 `bridgeMailbox.purge(bridgeTarget)` | pre-existing (8e59c287) | TRUE POSITIVE (low; local-user input) | `bridgeTarget` is `--id` or `${basename(cwd)}-${cli}`. `--id ../x` resolved outside `~/.aigentry/mailbox/bridge`. Same FileMailbox sink | fad5878 (FileMailbox under `mailbox/bridge` in the R1 test; the CLI process itself was not run) |
| 1d1bef5e | LOW | test/shell-string-class-pr108-r2.test.js:298 | introduced round 2 (29a9108) | SCOPED FIXTURE FALSE POSITIVE | test-only `http.createServer` bound to `127.0.0.1:0` (line 299), loopback fixture | none |
| 2345e040 | LOW | test/shell-string-class-pr108-r2.test.js:118 | introduced round 2 (29a9108) | FALSE POSITIVE | test-only server, `listen(0, '127.0.0.1')` (line 119) | none |
| 4c549f8b | LOW | test/inject-owner-pairing-pr108.test.js:97 | introduced round 1 (08561b6) | FALSE POSITIVE | test-only server, `listen(0, '127.0.0.1')` (line 101) | none |

No suppression comments or waivers were added.

## The three HIGH path traversals (4fc6e5b9, 4158b586, 20746b91)

Flow:
1. `req.params.id` is decoded by express and passed through `resolveSessionAlias`.
2. The route checks `sessions[id]` exists.
3. `FileMailbox._sessionDir` builds `path.join(root, id)` (src/mailbox/index.js:36-38, 6790a0aa).
4. `fs.writeFileSync(<dir>/inbox.jsonl|state.jsonl|dead-letter.jsonl, '')` truncates.

`enqueue` used `ensureSessionDir`, which builds the same unchecked `path.join`.

**NB4 dot ids are one cause, not the only one.** On 9cff4bf:
- Spawn admitted `.`/`..`.
- `POST /api/sessions/register` and `PATCH` rename (`new_id`) admitted any id, including `../victim`.
- WS auto-register takes `url.pathname.split('/').pop()`, so it can never carry `/`. `..` is
  normalised away, but `...`, `constructor` and `__proto__` arrive raw.

Producer-side fixes:
- 136e276: spawn refuses dots-only ids.
- 7bc4c36: register refuses with 400; WS closes 4400 without registering.
- 5089d92: rename refuses with 400.
- Register, WS and rename use the option-A rule: dots only, `/`, `\`, C0/DEL/C1, prototype names.
  The full spawn allowlist is not applied there (HOLD.md: `telepty allow` defaults to
  `${basename(cwd)}-${cli}`).

Reproduced on a real daemon at 9cff4bf:
- register `../x`, then `DELETE /api/sessions/..%2Fx/mailbox`, `/mailbox/dead-letter` and `/api/sessions/..%2Fx`.
- `~/.aigentry/x/{inbox,state,dead-letter}.jsonl` were truncated from `keep\n` to `''`.
- `..%2Fx` survives URL normalisation; express decodes it.

Fix (fad5878): `sessionDirPath(root, id)` in src/mailbox/storage.js.
- It keeps `path.join` (the same dir for every contained id) and throws unless `path.resolve(dir)` is strictly inside `path.resolve(root)`.
- `_sessionDir` and `ensureSessionDir` both use it, so every FileMailbox method, the daemon routes and the CLI bridge mailbox are covered at the sink.
- `delivery.js` only passes `readdir` names of the root, which are always contained.

Client-visible effect for an escaping id:
- `DELETE /api/sessions/:id/mailbox` and `/dead-letter` answer 500 `Invalid mailbox session id`.
- Session DELETE still answers its normal status, because the purge error was already swallowed.
- An enqueue to such an id throws instead of writing outside the root.
- Ordinary ids are unchanged.

Regression test (`test/snyk-9cff4bf-findings.test.js` "R1"; RED on 9cff4bf and on 7bc4c36 before the rename fix). Sibling files of the mailbox root stay unchanged across:
- register `../victim`, `..` and `a/../../victim`;
- spawn of the same ids;
- PATCH rename to `../renamed` / `..`;
- a WS connect as `...`;
- a **legacy `../victim` record restored from sessions.json** (no migration);
- the encoded routes `/api/sessions/..%2Fvictim{/inject,/mailbox,/mailbox/dead-letter,}`;
- the CLI bridge mailbox (FileMailbox under `mailbox/bridge`).

Residual (lexical check): the check is not symlink-race proof. A symlink planted *inside* the mailbox root (owner-only, mode 0700) would still be followed. Writing there already needs the daemon user.

**DELETE / purge ownership (assessed, no change).** These routes need the daemon token or a JWT, not the session's own bearer:
- `DELETE /api/sessions/:id`
- `DELETE …/mailbox`
- `DELETE …/mailbox/dead-letter`

That is the documented principal model: a token holder can already spawn any command and kill any session, and `telepty kill` / orchestrator teardown rely on it. Requiring the session bearer would break those callers. After fad5878 a purge can only touch that session's own mailbox dir.

## cross-machine ssh (aadc4863, 0ab74261, deee8c0c)

`connect()` joined `sshTarget` into five `/bin/sh` strings (cross-machine.js:191, 209, 218, 224, 258).
`disconnect()` used one more. The target is CLI argv (`telepty connect <target>`). No daemon route
calls these functions (grep of daemon.js and src/).

In a fresh CLI process `activePeers` is empty, so `telepty disconnect`/`peers --remove` reach the exec
only inside the process that ran `connect`. Reproduced with a fake `ssh` (logs argv, exits 0) and
`touch` on PATH: target `u@h;touch <marker>;#` created the marker on 9cff4bf.

Fix (09bc039):
- `execFileSync('ssh', [...])` everywhere.
- A target that starts with `-` is refused, because ssh reads `-oProxyCommand=…` as an option even from argv.
- The remote commands `hostname` / `telepty list --json` are the same remote strings as before (the old local shell only stripped their quotes).

R3 (Mac re-review), checked against 09bc039:
- All five sinks are `execFileSync('ssh', [...])`: 191, 209, 218, 224 (cleanup), 258.
- `grep execSync cross-machine.js` → 0, and the unused import was removed.
- ssh option parsing: `sshTarget` starting with `-` is refused before any exec. `controlPath()` reduces the target to `[a-zA-Z0-9@.-]`, so ssh's `%`-token expansion in `ControlPath` sees no caller text.
- Remote-command parsing: the remote commands are constants (`hostname`, `telepty list --json`), and the target is a single argv element before them.
- `disconnect`/`removePeer` reach the exec only through the in-process `activePeers` set by `connect` (a fresh CLI has none). The test therefore runs connect → disconnect → removePeer in one process.

## ace25647 — daemon.js:3572 — what Snyk still sees

The tainted values that reach `pty.spawn(shell, shellArgs, { env })` at 9cff4bf:
- `command`/`args` → `shell`/`shellArgs`. This is the endpoint's purpose (`telepty spawn --id X <command> [args…]`). On POSIX node-pty execs an argv array and no shell parses it. Only a token holder reaches it, and that holder can run any program by design. Snyk has no sanitizer for "caller chooses the program", so this flow will always be reported. Changing it would remove the feature.
- `session_id`/`type` → `customEnv.PS1/PROMPT` → `env`. These are closed by:
  - the `type ∈ {USER, AGENT}` equality check (9826617);
  - the id allowlist (f8d43bf);
  - the dots-only refusal (136e276).

  Snyk's engine probably does not treat a custom regex test or an equality check as a sanitizer, so it may still trace this flow (not measured: SCAN.json is Mac-local).

Must anything else change? No, for POSIX. The residual is Windows `cmd.exe /c <command> <args…>`: cmd parses metacharacters in `args`. The caller is the same principal. It is pinned by `test/win32-cmd-argv-characterisation-c6.test.js` and tracked as telepty#115 (C6).

Disposition: **partial closure plus explicit capability.**
- **Principal:** the daemon token / JWT holder, the same user or an allowlisted peer.
- **Capability:** "run this program in a PTY", which is the endpoint's purpose.
- **Closed:** the injection of caller *names* (id, type) into prompt strings, on POSIX.
- **Open:** Windows #115.

Snyk is expected to keep reporting this id. It is not scanner-zero and is not claimed to be.

## 7e65d918 — spawn route without rate limits — explicit disposition

This is an availability risk, accepted under principal trust; the finding is real, not a false positive.

What the principal can do: any token / JWT holder can spawn PTYs until the host runs out of processes, file descriptors or PTYs. That holder can equally run `command` itself, so a throttle on this route would not take away any capability the holder lacks.

What bounds a request:
- The body is capped at 100 kB by `express.json()`.
- `cols`/`rows` go to a 16-bit winsize.
- `args` is type-checked.

There is no per-principal quota. Adding one is a new mechanism (Article 1/17) and a product decision. It is not done here.

## Other Mac re-review items

- **C4:** one test uses a valid-name **regular file we own** on the real fs. Another uses a valid-name **symlink to our real socket**, and is skipped where `listen` is EPERM (this sandbox), so it runs on the Mac/CI. The injected-fs NB1 test kills both mutations here. Mutation logs: `fu108-evidence/nb1-mutation-*.log`.
- **osascript cwd-derived argv:** a new test pins the cwd basename as an argv term (`sessionMap` seam). It kills the mutation that puts the basename back into the script; the old C5 test survives that mutation (`fu108-evidence/c5-cwd-mutation.log`).
- **DELIVERY_UNCERTAIN abort consumers:** the inject route's refusal arm closed the tracked record as `inject_delivery_refused` with a **measured** `bytes_written: 0`, i.e. "definitely unsent". It now records `inject_delivery_uncertain` with `bytes_written: null` (e3f3052).
  - The other consumers carry the code as-is: multicast/broadcast `results.failed[].code`, `failed:DELIVERY_UNCERTAIN` in the audit, and `inject_failed` with the code on the bus.
  - The response is still 504 `DELIVERY_UNCERTAIN` with "may still arrive … Do not retry blindly".
  - Not reproduced end to end: a message has to be in flight at the exact instant the wait expires. Only the cause mapping is unit-tested.
- **R2 (TP1 while text is queued):** fixed in e3f3052.
  - Each enqueued inject is bound to `{session, epoch, ownerWs}` at admission.
  - `deliverFn` writes only to that binding. Otherwise it refuses the waiter (410 `SESSION_GONE`), and `onDelivery` withdraws the message to dead letter.
  - Reproduced RED: the same-bearer replacement got `['queued text', '\r']`, and with `no_enter` it got `['queued text']`.
  - Same-name re-create: the destroy purge already removed the text; this is a characterisation test.
  - Residuals:
    - The binding is in memory. A message restored after a daemon restart has no binding and is delivered as before; every owner after a restart is a new socket anyway.
    - A binding whose message was purged with its session is kept until the process exits.

## Not measured
- `DELIVERY_UNCERTAIN` end to end (only the cause mapping is tested).
- The real-socket C4 case on this host (`listen` EPERM).

- Snyk's own traces and rule ids (SCAN.json is Mac-local). A rescan is needed to see which ids clear.
- Real ssh, a real remote peer.
- The Windows paths: `.cmd` shim via node-pty, `cmd.exe /c`.
- The CLI bridge mailbox (`cli.js:3066`) with `--id ../x` end to end. Only FileMailbox itself is tested.
- Inject responses for a registered escaping id (the enqueue now throws).
