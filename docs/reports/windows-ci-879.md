# Windows CI diagnostic — telepty #879 (phase 1: bounded per-file runner)

Status: **candidate for one Windows CI reproduction run.** No product change, no package script
change, no test body change. `test-install.yml` is untouched. Nothing here claims Windows support,
a green suite, or a fix for the hang — it makes the next Windows run *diagnostic and bounded*.

Immutable scope (carried verbatim from the task):

> goal = Windows CI COMPLETION/green only. NO structural changes to telepty product code — live
> production tool, side-effect risk too high (merge-is-deploy host). Allowed: CI config,
> test-harness fixes, platform-aware ANNOUNCED skips (silent skip = defect class), timeout/hang
> diagnosis. Windows-native runtime work (signals/service/ConPTY hardening) is DEFERRED, not part
> of this task. Any future dispatch on this task must carry this constraint verbatim.

## What was observed (three Windows runs at 7ee2cfe and its two predecessors)

| run | reporter ✖ lines | last reporter output → cancel | orphans listed at cancel |
|---|---|---|---|
| BASELINE a3c45e6 | 21 | 1070.8 s | conhost, powershell |
| CANDIDATE 4732b5a | 21 | 1079.4 s | (none) |
| FINAL 7ee2cfe (job 122148002651) | 22 | ~1076 s | conhost ×3, powershell ×2, bash |

The same 21 reporter labels appear, in the same order, in all three runs; FINAL adds one more,
a timing-sensitive PTY wait (`cli.test.js` "attach resumes stdin…", 7.9 s timeout) that the two
earlier runs did not show. Two of the labels are suite aggregates, so the shared set is 19
independent assertions plus the one additional FINAL failure. Because the shared 21 are present
before and after the three-capability hotfix (#1215), they are not attributable to it.

The hung file is **not identifiable from these logs**: `node --test` reports in bursts, not in
inventory order (642 order back-steps between attributed top-level lines in FINAL), and the
final summary never printed. The last printed test is not evidence.

## What this candidate adds

1. `scripts/windows-ci-diagnostic.mjs` — runner-only, built-in modules only.
   * Inventory derived at runtime from `package.json` `test:ci` (main phase) and `test:ci:pty`
     (serialized PTY phase). No second list to go stale.
   * One `node --require ./test-support/setup-env.js --require <handle-dump preload> --test
     --test-reporter=tap <file>` invocation per file — the same caller shape as `test:ci`, so
     `NODE_TEST_CONTEXT` and the child-test process semantics match CI; only the reporter differs.
     Concurrency ≤ 4 (default 3), per-file deadline 60 s with two evidence-based exceptions at
     120 s (cli.test.js measured 60.1 s, daemon.test.js 48.0 s of reported test time in FINAL),
     whole diagnostic ≤ 10 min; files not started by then stay `notrun`.
   * Every selected file has a record from the start (`notrun` → `running` → final class) and the
     summary is rewritten after every state change, so an aborted run still shows exactly what
     was and was not covered; in-flight records become `aborted`.
   * Records per file: start/end, pid, exit code/signal, **exit time vs stream-close time**, the
     TAP tally, raw stdout/stderr logs, and on any deadline the **descendant process tree** before
     a bounded tree kill. Kill verification is reported as `verified-clean`, `survivors`
     (→ `lost-process`), or `unknown` / `budget-exhausted` (→ `cleanup-unknown`); a failed
     snapshot is never read as "clean". Helpers are short (5 s each), capped at 16 kill calls per
     round, and charged to a finite 90 s global cleanup budget; on exhaustion the record names the
     job's termination as the remaining owner. Only processes descending from the runner's own
     per-file children are ever targeted or reported; the diagnostic's own snapshot helpers are
     excluded and nothing is matched by name.
   * A file is `pass` only with exit 0, a complete reconciled TAP summary, a positive pass count,
     and zero fail/cancelled. An all-skipped file is `skipped`, not a pass. A partial or
     inconsistent tally is `unknown-tally`. `allPassed` additionally requires verified cleanup and
     no leftover owned process; the exit code is 0 only when every file is `pass` or `skipped`
     under those conditions.
   * The generated preload dumps the process's active resources every 15 s on an unref'd timer
     (`process.getActiveResourcesInfo()` for the type — Timeout, TCPSocketWrap, ChildProcessStdio…
     — plus the internal handle list for child pids and ports), in the `node --test` parent and,
     via execArgv propagation, in the test child, so a process held open after its last test names
     the holder.
   * Recorded coverage limits: the trailing `git diff --exit-code tests/snippet-protocol/v1/`
     gate of `test:ci` is **not** executed by the diagnostic, and one file per invocation does not
     reproduce the worker co-scheduling of the original parallel run.
2. `.github/workflows/windows-diagnostic-879.yml` — `workflow_dispatch` (inputs: concurrency,
   per-file timeout, path filter, `git_autocrlf`) **and** `pull_request` filtered to its own
   three files so it runs on the PR that introduces it. `timeout-minutes: 15`, artifact uploaded
   with `if: always()`.
3. This report.

## Ranked hypotheses for the 18-minute silence (each falsifiable by the run)

1. **Inherited pipe from an orphaned grandchild.** A test file's process exits (or is killed by
   the harness) but a grandchild — powershell/conhost/bash spawned through the daemon's ConPTY
   session or a detached daemon — still holds the inherited stdout/stderr pipe. `node --test`
   waits for the child's stdout to end, so the file never "finishes". Evidence: the orphans the
   runner killed at cancel. Falsified if no file shows `exit-without-close` and no descendants
   remain at any deadline.
2. **A test file's event loop never drains** (undisposed timer, WS/HTTP socket, child handle) so
   the process never exits — the #645/#678 pattern. Falsified if the handle dump stops appearing
   (i.e. the process exited) for every file; confirmed when dumps keep appearing after the last
   TAP line and name the handle.
3. **A synchronous call that never returns** (`execFileSync`/`spawnSync` without a timeout
   waiting on a child whose pipes never close). Signature: partial TAP, *no* periodic handle dump
   (timers cannot fire inside a sync block), deadline reached.
4. **The parent runner, not a worker, is stuck** (reporter/stream state in `node --test` itself).
   Signature: every per-file run completes within bound under this runner, yet `test:ci` hangs —
   then the next step is a parent-side trace, not a test fix.

## Failure map (summary — full detail in `FAILURE-MAP.json` of the checkpoint)

The cause column is a **hypothesis read from the log text and the test source**, not a measured
root cause; each stays a hypothesis until the Windows run confirms it.

| hypothesised class | tests | owner | phase-2 candidate |
|---|---|---|---|
| checkout CRLF (`core.autocrlf=true`; `.gitattributes` covers only the golden fixtures) | init.test.js ×3, consumer-vocabulary-matrix-60 | 879 / controller (`.gitattributes` outside this writable set) | dispatch with `git_autocrlf=false` falsifies in one run |
| fixture redirects HOME but not USERPROFILE | cross-machine-ssh-routing ×4 | 879 | 2-line fixture fix, evidence-backed |
| POSIX mode bits asserted (Windows ACL unmeasured) | auth-corrupt-config-835 ×2, interaction-core-681 C7 | 879 | announced skip of the mode assertion only |
| POSIX chmod on a directory does not deny writes on Windows | completion-unknown-observation-60 failed_commit | 879 | announced skip, replacement coverage: none (stated) |
| `process.title` is the shared console title on Windows | daemon-title-claim-896 | 879 | announced skip (sweep predicate is `ps`-based) |
| darwin-only artifact built with `path.join` | install-service-generation launchd | 879 | announced skip of that test |
| POSIX shebang stub as the wrapped CLI | adhoc-allow-inject-752, cli.test.js fake-claude | 879 (fixture) / 577 | decide from per-file log |
| ConPTY/TUI interaction timeouts | cli.test.js attach (FINAL only, timing-sensitive), interactive update, EIO | **577 — deferred, kept visible** | none |
| opaque assertion (values suppressed) | cli-security-context-681 actual-spawn-metadata | 879 → reclassify | per-file raw log |

Silent `if (win32) return;` early-returns exist in daemon-restart-title-44, daemon-shutdown-
handlers-916 and sweep-scoping-902; they are the "silent skip" defect class and are listed for
phase 2, unchanged here.

## Exact next CI invocation

Controller-owned (this worker performs no Git/GitHub operation):

1. Open the PR with the three candidate files. The `pull_request` path filter starts the
   diagnostic on that PR automatically (defaults: concurrency 3, 60 s/file, no filter,
   runner-default line endings).
2. Then, from the Actions tab, dispatch **Windows CI diagnostic (#879)** once more with
   `git_autocrlf=false` and everything else default. Comparing the two `summary.md` artifacts
   isolates the CRLF class without any code change.
3. Read, in this order: `summary.md` → the `exit-without-close` / `timeout` / `lost-process` /
   `cleanup-unknown` rows → that file's `logs/*.stderr.log` (handle dumps) →
   `descendantsAtDeadline` and `kill` in `summary.json`.

## Limits

* Authored on macOS from the tracked text tree only; **not executed on Windows and not executed
  against this repository's tests**. The only local check on the revised runner is pinned Node 20
  `--check`; YAML was reviewed statically, which is not YAML validation.
* `process._getActiveHandles` is a Node internal, guarded by `typeof`; the public
  `process.getActiveResourcesInfo()` is used first.
* Cleanup is bounded, not guaranteed: survivors and unverifiable snapshots are reported as such
  and left to the job termination; on a runner crash the summary is still written but no final
  snapshot is taken (`leftoverCheck.status = unknown`).
* Security scan: PENDING for the changed-source list (`scripts/windows-ci-diagnostic.mjs`) —
  not run by this worker; the five-file Snyk approval covers only hotfix #1215.
