# Changelog

All notable changes to `@dmsdc-ai/aigentry-telepty` are documented here.

## [0.3.5] — 2026-05-05

### Added — `telepty init --print-snippet` (Issue #8)

New subcommand that emits the canonical telepty-baseline snippet to stdout for
graceful integration into per-CLI agent files. **Mechanism only** — telepty
emits the versioned snippet text; downstream tooling (`aigentry-devkit
scaffold --integrate-telepty`) owns idempotent insertion into
`~/CLAUDE.md` / `~/AGENTS.md` / `~/GEMINI.md`. Boundary contract per ADR
`2026-05-05-telepty-devkit-boundary` (commit `e4b072b`).

```
telepty init --print-snippet [--target {claude|agents|gemini|all}] [--format {markdown|json}]
```

- **argv-only**: never consumes stdin (safe in scripted pipelines).
- **zero file I/O**: pure stdout emission; nothing read from or written to disk.
- **deterministic**: byte-identical output for a given (target, format) pair —
  fixtures can be hashed for verification.
- **LF-only bodies**: no CRLF leakage on cross-platform consumers.
- **stderr clean**: success path emits no warnings.

Spec: `docs/specs/2026-05-05-issue-8-telepty-init.md` (commit `8d2dc94`).
Implementation: `f5c6bad`. Protocol SSOT: `aigentry-ssot/contracts/telepty-snippet-v1.md`
(commit `f4ff0cd`). 15 conformance fixtures shipped at `tests/snippet-protocol/v1/`
covering markdown envelopes (claude, agents, gemini, all), JSON records,
shell-hazard guards, deterministic LF output, default targeting, unsupported-target
rejection, internal-failure exit codes, stdin-pipe ignore, devkit-free invocation,
and the snippet golden fixtures themselves.

### Docs — G7/G8/G9 M0 audit gate closure (commit `d7b8b21`)

Per ADR `2026-05-05-telepty-devkit-boundary` §3.1.2 (devkit owns content
placement; telepty owns mechanism), three gates closed:

- **G7 — `README.md`**: removed reference to the rejected `telepty install
  hooks` subcommand. Per ADR §3.1.2, that responsibility lives in devkit.
- **G8 — `AGENTS.md`**: added Legacy exception subsection documenting the
  remaining devkit-shaped legacy surface.
- **G9 — `skill-installer.js`**: top-of-file LEGACY header per ADR §6.2.1
  marking the module as legacy-track (devkit migration pending).

### Internal

- Cross-LLM review pattern applied: Codex implemented the `init` subcommand
  + fixtures; Claude reviewed and ACCEPTed (commit `d06e1e9`).
- `test/enforce-report.test.js` version assertion bumped to track release
  (commit `d0f4495`).

### Tests

- `test/init.test.js` — full coverage of the new subcommand (snippet
  emission, target/format permutations, stdin-ignore, error exits, devkit-free
  invocation).
- `tests/snippet-protocol/v1/` — golden fixtures for protocol conformance;
  `npm test` runs `git diff --exit-code` against them so any drift fails CI.

### Invariants preserved

- Daemon code unchanged. No new dependencies. No `bin` field changes.
- Existing CLI subcommands (`allow`, `inject`, `list`, `tui`, `daemon`, …)
  unchanged.
- Cross-host inject path (0.3.4) unchanged.

## [0.3.4] — 2026-05-05

### Added — Cross-host inject (`<id>@<host>` syntax)

Enables `telepty inject <id>@<host> "msg"` to deliver to a remote daemon
without SSH wrapping, by resolving `<host>` against the peer registry and
issuing direct HTTP `POST /api/sessions/<id>/inject`. Closes the gap that
forced operators to either pre-shell into the host or pipe through SSH.

- **`connect-http` peer mode** (commit `a92cacc`) — new HTTP-only peer
  registration path that does not require a reverse PTY tunnel; suitable
  for daemons reachable via Tailscale / private DNS.
- **`TELEPTY_HOST` env parser fix** (commit `a92cacc`) — `<id>@<host>` now
  parses correctly when the host segment contains a port or non-default
  scheme; prior parser dropped the host portion silently.
- **Peer registry HTTP-only mode** — registry entries can be marked
  HTTP-only so the daemon does not attempt PTY fan-out for them.

### Added — Skill installer auto-detect (`486bc1e`)

`telepty install` now auto-detects which AI CLIs are present
(`claude`, `codex`, `gemini`) and only installs the corresponding skill
files. Reduces noisy "skipped" log lines and prevents stub installs
on machines that don't have the target CLI yet.

### Fixed — Node 18 ESM regression (`fc7ff9a`)

Pinned `uuid@9` (was floating to v10, which is ESM-only and caused
`ERR_REQUIRE_ESM` under Node 18 CommonJS consumers).

### Docs

- Cross-host inject `<id>@<host>` syntax documented (commit `c8b9bbb`).
- `[context-ref]` inject protocol standardized across docs (commit `8986a96`).
- REPORT pattern + orchestrator-id runtime resolution documented in skills
  (commit `658f712`).
- Korean trigger keywords added to skill `SKILL.md` descriptions for
  cross-locale activation (commit `57f46e1`).

### Note — never published to npm

`0.3.4` was version-bumped locally but never reached the registry; this
entry is added retrospectively alongside the `0.3.5` publish so the
changelog history matches the git log. Registry consumers go directly
from `0.3.3` → `0.3.5`.

## [0.3.3] — 2026-05-02

### Added — `inject --submit-force` + idempotent client retry (spec: `docs/superpowers/specs/2026-05-02-submit-force-and-retry.md`)

Closes task #347. Two opt-in CLI knobs on `telepty inject` for cases where
the 0.3.2 prompt-symbol gate has a transient render mismatch (autocomplete
dropdown open, cursor moved, mid-paste race) and the 504 fall-through
forces the human user to press Enter manually.

- **`--submit-force`** — passes `force: true` to `POST /submit`. Skips
  both Layer 3 (prompt-symbol) and Layer 1 (state-gate) and dispatches
  Enter once via the existing `terminalLevelSubmit` chain (kitty → cmux
  → PTY). Daemon-side `force` semantics already shipped in 0.3.1 for
  `telepty send-key`; this just plumbs the flag through inject.
- **`--submit-retry N`** (default 1, clamp [0, 3]) — on a 504 response
  with a retry-safe reason, wait 300 ms and retry the same `/submit`
  request up to N times. Retry-safe reasons (idempotent re-fire is
  guaranteed because the body is verifiably still in the input box):

  | Reason | Source |
  |---|---|
  | `gated_dispatch_unconsumed` | `daemon.js:1680` (verify said body still visible after best-effort dispatch) |
  | `gate_timeout` | reserved (Layer 1 plain timeout — falls through to dispatch in 0.3.1+, not currently a 504 source) |
  | `no_prompt_symbol_seen` | reserved (Layer 3 timeout — currently never emits 504) |

  Hard-fail reasons (`session_dead`, `session_error`, `session_restarting`,
  `no_state`, `no_state_manager`) and any non-504 status (4xx) **never**
  trigger client-side retry — re-firing won't recover.

- **Default behavior preserved**: a bare `telepty inject --submit ...`
  call now retries once on a retry-safe 504. This is a strict improvement
  over 0.3.2 (which surfaced a warning and required manual `send-key`)
  and remains backward-compatible because retry only fires when the
  server tells the client the dispatch demonstrably did not land.

### Tests

- `test/inject-submit-flags.test.js` (NEW, 9 tests) — mock-daemon
  coverage:
  - `--submit-force` adds `force:true` to `/submit` body; success line
    renders `[forced]` tag.
  - bare `--submit` does NOT add `force` to body.
  - default `--submit-retry 1` retries once on `gated_dispatch_unconsumed`
    504 then succeeds; output contains `[retry 1/1]`.
  - `--submit-retry 2` exhausts to 3 calls then prints
    `Submit gated-timeout … after 3 attempts`.
  - `--submit-retry 0` makes exactly 1 call, no `[retry`.
  - `session_dead` 504 → no retry even with `--submit-retry 3`.
  - `no_state` 504 → no retry even with `--submit-retry 3`.
  - `--submit-force --submit-retry 2` preserves `force:true` across retries.
  - 500 error → no retry, prints to stderr.
- `test/enforce-report.test.js` — version assertion 0.2.0 → 0.3.3.
- All 174 existing tests pass unchanged.

### Invariants preserved

- Daemon code unchanged. `force:true` and the gate layers behave exactly
  as in 0.3.2.
- `telepty send-key` unchanged.
- `telepty enter` unchanged.
- `telepty inject --ref` (no `--submit`) unchanged.
- Cross-machine remote inject path unchanged (the SSH branch in `cli.js`
  bypasses the new flags by design — remote daemons handle their own
  submit semantics).
- Exit code on soft failure (504) remains 0; orchestrator scripts that
  check for non-zero exits are unaffected.

## [0.3.2] — 2026-04-26

### Added — Layer 3 prompt-symbol render gate (spec: `docs/superpowers/specs/2026-04-26-prompt-symbol-render-gate.md`)

Strictly additive layer above the 0.3.1 `sessionStateManager` gate. Closes
the recurring "Enter not applied on freshly-spawned `claude`/`codex`" trap
by directly observing the rendered terminal screen for a per-CLI prompt
symbol — the only deterministic ready-signal these TUIs expose to external
automation (no OSC 133, no exit-on-prompt, no socket signal).

- **`src/prompt-symbol-registry.js`** (NEW) — per-CLI prompt-symbol catalog:

  | CLI | Symbol | Codepoint | UTF-8 | Geometry sanity |
  |---|---|---|---|---|
  | `claude` | `❯` | U+276F | `E2 9D AF` | sandwiched between U+2500 (`─`) horizontal-rule borders |
  | `codex` | `›` | U+203A | `E2 80 BA` | model footer (`gpt-N…`) within 2 lines below |
  | `gemini` | `*` | U+002A | `2A` | bracketed by U+2580 (`▀`) above / U+2584 (`▄`) below |

  `lookup(command)` normalizes path + args (`/usr/local/bin/claude --resume`
  → claude entry; `codex resume` → codex entry). Unknown CLIs return `null`,
  causing the gate to skip cleanly via `unknown_cli`.

- **`src/submit-gate.js` `awaitPromptSymbol(session, opts)`** (NEW) — polls
  `cmux read-screen --workspace <id> --lines <n>` (default 30) every
  `pollIntervalMs` (default 150 ms) and resolves only when the symbol has
  been stably detected for ≥ `stabilityMs` (default 200 ms). Bounded by
  `timeoutMs` (default 8000 ms; clamp [500, 30000]). Resolves cleanly with
  one of:
  - `{ ready: true, last_seen_at, waited_ms }`
  - `{ ready: false, reason: 'no_screen_primitive', waited_ms: 0 }` (non-cmux backend)
  - `{ ready: false, reason: 'unknown_cli', waited_ms: 0 }`
  - `{ ready: false, reason: 'no_prompt_symbol_seen', waited_ms }` (timeout, fall through)
  Pure helper: `now`/`sleep`/`readScreen`/`registry` are all injectable for
  deterministic tests (fakeClock harness from `verifyBodyConsumed`).

- **`daemon.js` POST /submit** — Layer 3 runs immediately before Layer 1
  on the gated path. Result threaded into success and 504 response bodies
  as optional `prompt_symbol: { found, waited_ms, [reason], [last_seen_at] }`.
  **Never emits its own 504** — best-effort fall-through to Layer 1, which
  retains all existing 0.3.1 outcomes (success / `gated_dispatch_unconsumed`
  / hard-fail). Per-request bypass via `{ "prompt_symbol_gate": false }`
  (Layer 3 only); `force:true` and `TELEPTY_SUBMIT_GATE=off` continue to
  bypass BOTH layers.

### Tests

- `test/prompt-symbol-registry.test.js` (NEW) — registry coverage with
  inline cmux read-screen fixtures: claude/codex/gemini detect on idle
  screens, banner-stage rejection (no border geometry), history-echo
  disambiguation (LAST occurrence anchored), `lookup()` path/args
  normalization + case-insensitivity + unknown/null inputs, `byteSeq`
  matches `Buffer.from(symbol, 'utf8')`.
- `test/submit-gate.test.js` (extended) — `awaitPromptSymbol` covers:
  non-cmux → `no_screen_primitive`; missing workspace → same; unknown CLI
  → `unknown_cli`; stable claude/codex screen → ready after `stabilityMs`;
  empty `readScreen` returns → `no_prompt_symbol_seen` after `timeoutMs`;
  symbol-then-disappear → stability streak resets; injected registry
  override is honored; `readScreen` receives `(workspaceId, tailLines)`.

### Invariants preserved

- All 32 existing `test/submit-gate.test.js` tests pass unchanged.
- `force: true` and `TELEPTY_SUBMIT_GATE=off` bypass BOTH layers.
- Layer 1 hard-fail short-circuits (`session_dead`/`error`/`restarting`/
  `no_state`/`no_state_manager`) still emit 504; Layer 3 never adds a new
  504 source.
- `inject --ref` (no `--submit`) path unchanged.
- aterm / non-cmux backends skip Layer 3 cleanly via `no_screen_primitive`.
- Cross-machine remote inject unchanged: Layer 3 runs only on the daemon
  with cmux access; remote daemons fall through.
- Response shape additive — `prompt_symbol` is an optional field; existing
  callers ignore unknown JSON keys.

## [0.3.1] — 2026-04-26

### Fixed — submit-gate regression cluster (spec: `docs/superpowers/specs/2026-04-26-submit-gate-fixes-v2.md`)

Three regressions surfaced post-`0.3.0` against fresh-spawned `claude`/`codex`
sessions where the gate's strict thresholds and timeout-abandon path made the
new `/submit` endpoint less reliable than the pre-`0.3.0` blind retry on cold
REPLs. All three fixes ship in this single patch.

- **δ-fix-2 — `send-key` bypass (P0).** `POST /api/sessions/:id/submit` now
  accepts `{ "force": true }` to skip the render-readiness gate and verify
  step, dispatching once via the existing kitty/cmux/PTY chain. `cli.js`
  `send-key` always sets `force:true`, restoring the manual Enter override.
  Response shape additive (`forced:true`); existing callers unaffected.
- **δ-fix-3 — gate threshold relaxed 0.85 → 0.5 (P1).** `sessionStateManager`
  emits IDLE `confidence=0.6` when neither OSC 133 nor a shell-prompt pattern
  matches (`session-state.js:380`) — the dominant case for AI-CLI TUIs whose
  Unicode-box input line bypasses `PROMPT_PATTERNS`. Default `minConfidence`
  lowered to `0.5` (below the 0.6 silence-fallback with margin); per-request
  override `min_confidence` body field accepted (clamped `[0, 1]`).
- **δ-fix-4 — timeout extension + best-effort dispatch on timeout (P1).**
  Default `gate_timeout_ms` raised `5000 → 10000` (upper clamp `15000 →
  30000`) to cover empirical `claude` ready window (3-6 s on fresh spawn).
  On a plain `timeout` reason, `/submit` now dispatches anyway and verifies
  body consumption — the pre-`0.3.0` blind dispatch is restored as a fallback
  while keeping the new honesty signal: 504 only fires when
  `verifyBodyConsumed` confirms the body is still in the input box (new
  `reason: 'gated_dispatch_unconsumed'`). Dispatch-on-timeout success path
  adds `gated_dispatch_after_timeout: true` (additive).
  Hard-fail reasons (`session_dead`/`error`/`restarting`/`no_state`) still
  short-circuit to 504 immediately.

### Invariants preserved

- `inject --submit` warm-session reliability ≥99% target (gate short-circuits
  at conf≥0.85 still passes after default drops to 0.5).
- 504 still emitted in true-fail case (after best-effort dispatch + verify
  reports `still_visible`).
- `TELEPTY_SUBMIT_GATE=off` daemon-wide escape hatch preserved.
- `inject --ref` (no `--submit`) path unchanged.
- 22/23 existing `test/submit-gate.test.js` tests pass unchanged; one test
  (line 185-193) updated to preserve the below-threshold-rejection semantic
  with literals shifted away from the new 0.5 default.

## [0.3.0] — 2026-04-26

### Added — render-gated submit (specs: `docs/superpowers/specs/2026-04-26-inject-submit-enter-reliability.md`)

- **`src/submit-gate.js`** — pure helpers exported for unit tests:
  - `awaitReplReady(sessionId, stateManager, opts)` — waits for the target REPL
    to reach an input-ready state (`idle` or `waiting`) with confidence ≥ 0.85
    before Enter is fired. Bounded by `timeoutMs` (default 5000).
  - `verifyBodyConsumed(session, bodyText, opts)` — polls the session's
    `outputRing` for the inject body to disappear from the input box,
    confirming Enter was actually consumed by the REPL (default 1500 ms,
    200 ms interval). Optimistic when body never visible (ANSI/wrap edge).
  - `isReady`, `isFailed`, `READY_STATES`, `FAIL_STATES` — test surface.
- **POST `/api/sessions/:id/submit`** rewritten to use the gate by default.
  Flow: gate on REPL readiness → dispatch via existing kitty/cmux/PTY chain →
  verify consumption (when caller passes `injected_body`) → bounded retry.
  Response now includes `gated`, `gate_wait_ms`, `verify` (when applicable).
- **HTTP `504 gate_timeout` response** on `/api/sessions/:id/submit` when the
  REPL never readies for input within `gate_timeout_ms` (default 5000).
  This is **why this is a minor bump** — consumers may need to handle the new
  status code. 504 (Gateway Timeout) is the correct semantic versus 408 or
  reused 503 — the daemon acted as a gateway to the upstream REPL and the
  upstream did not respond in time.
- **CLI `inject --submit`** now passes `injected_body` to the daemon for
  consumption verification, removed the legacy 500 ms blind sleep
  (gate handles timing), and treats 504 as a soft failure (logs a clear
  remediation hint, exits 0 — orchestrator scripts depend on exit 0 for
  recoverable conditions).
- New body fields accepted by `/submit`: `injected_body`, `gate_timeout_ms`,
  `verify_timeout_ms`. Existing `pre_delay_ms` / `retries` / `retry_delay_ms`
  remain accepted for back-compat.
- **`TELEPTY_SUBMIT_GATE=off`** env var — escape hatch to revert to the 0.2.x
  blind retry path for parity testing or rollback.

### Changed

- POST `/api/sessions/:id/submit` is no longer open-loop. Default behavior
  is gated; legacy blind retry preserved only behind `TELEPTY_SUBMIT_GATE=off`.
- CLI `✅ Submitted via <strategy>` line now optionally appends
  `[gate <N>ms]` when the gate had to wait. Default-on; pre-existing
  format preserved when gate fast-paths (warm sessions).
- `bus` event `submit` now carries optional fields `gated`, `gate_wait_ms`,
  `verify` (additive — consumers ignore unknown fields).

### Fixed

- Root cause: `/submit` previously fired Enter open-loop with a ~2.1 s
  blind retry budget while a fresh `claude` REPL needed 3–6 s to render
  (welcome banner, trust dialog, prompt setup). The legacy retry loop
  also discarded `terminalLevelSubmit`'s return value, so the reported
  `(N attempts)` count did not reflect verified dispatches. The new
  gate observes the existing `sessionStateManager` (`idle` / `waiting`
  with confidence ≥ 0.85) before dispatch, eliminating the race.
- Recurring orchestrator UX trap (parallel to #329 Track E27) where
  every `inject --submit` required a manual `sleep N && telepty send-key
  <id> enter` follow-up. Spec target: ≥ 99% on a 100× spawn-and-inject
  E2E harness (current baseline ~0%); E2E harness execution is dispatched
  to the builder (out of scope for this commit).

### Tests

- `test/submit-gate.test.js` — 23 new unit tests (all pass) covering
  `awaitReplReady` fast-paths, transition resolution, timeout, fail-state
  short-circuits; `verifyBodyConsumed` happy-path / optimistic / timeout /
  empty / no-ring / whitespace normalization / ANSI strip / injectable
  clock for deterministic timing.
- Pre-existing test suite is unmodified; integration coverage of the new
  endpoint behavior is delegated to the builder per SAWP scope.

### Compatibility / migration

- **Default behavior changes** for callers of `/api/sessions/:id/submit`:
  responses now succeed only when the REPL reaches readiness within
  `gate_timeout_ms`. Most callers will see equivalent or better behavior;
  callers that depended on "best effort fire-and-forget" can opt out via
  `TELEPTY_SUBMIT_GATE=off`.
- `inject --ref` (without `--submit`), `telepty allow`, `telepty list`,
  and `telepty send-key` semantics unchanged.
- Aterm sessions unaffected (gate is bypassed via existing
  `session.type === 'aterm'` guards).
- No new external dependencies (Rule 17). No schema, persistence, or
  state-machine changes (gate is read-only on `sessionStateManager`).

## [0.2.0] — 2026-04-15

### Added — REPORT enforcement (specs/enforce-report-spec.md)

- **New bus event types** for observable REPORT lifecycle:
  - `TASK_IDLE_NO_REPORT` — fires once on idle transition for inject-driven sessions
  - `TASK_COMPLETE_WITH_REPORT` — fires when matching REPORT inject detected via reverse-match
  - `TASK_BLOCKED_WITH_REASON` — fires on `STATUS: blocked` reply inject
  - `TASK_DISMISSED` — fires on `STATUS: dismissed` inject OR via DELETE endpoint
  - `TASK_DEAD_NO_REPORT` — fires when session dies with pending report (attaches `auto_summary`)
- **New HTTP endpoints** on daemon:
  - `GET /api/pendingReports/:id` — inspect pending report entry + optional auto_summary
  - `DELETE /api/pendingReports/:id` — orchestrator-side dismissal; fires `TASK_DISMISSED`
- **New module** `src/report-enforcement.js` exports pure helpers:
  - `classifyReportPrompt(prompt)` — classify inject prompt by prefix
  - `buildAutoSummary(session, opts)` — scrape last N non-blank lines from outputRing with ANSI stripping and secret redaction
- **REPORT detection via reverse-match** in POST `/api/sessions/:id/inject`:
  - An inject with `from=X` whose prompt starts with a REPORT prefix (`REPORT:`, `STATUS:`, `SPEC:`, `OWNER-DIAGNOSIS:`, `ENFORCE-SPEC:`, `ENFORCE-IMPLEMENTED:`, `LOG-FIX-SPEC:`, `LOG-FIX-IMPLEMENTED:`, `FIX-SPEC:`, `FIX-IMPLEMENTED:`, `SPEC-SYNC:`, `DIAGNOSIS:`) and whose recipient matches `pendingReports[X].source` fires the matching enforcement event.
  - Prevents false positives: prefix alone is NOT enough; reverse-match to originating inject required.
- **Auto-summary with secret redaction**:
  - Strips ANSI via shared regex
  - Filters blank lines
  - Caps at `DELIBERATION_REPORT_AUTO_SUMMARY_LINES` (default 40) + `DELIBERATION_REPORT_AUTO_SUMMARY_MAX_BYTES` (default 4096)
  - Redacts `api_key`, `password`, `token`, `secret` assignment patterns → `[REDACTED]`
  - Attached to `TASK_DEAD_NO_REPORT` events and GET query responses

### Changed

- `sessionStateManager.onTransition` handler now fires the enforcement events above. Legacy `TASK_COMPLETE:` text-inject to source session is preserved during 0.2.x grandfather period.
- Legacy auto-report paths (health-poll idle threshold + ready-WS signal) now coordinate via `pendingReports[id].idleNotified` flag to prevent double-fire.
- `pendingReports[id]` schema extended with `awaitingReport: true`, `idleNotified: bool`, `idleAt: ISO8601`. Entry is now cleared only when REPORT arrives, session dies, or orchestrator dismisses.
- Duplicate pendingReports overwrite now emits `[AUTO-REPORT] overwritten pending` warning.

### Configuration (new env vars)

- `DELIBERATION_REPORT_AUTO_SUMMARY_ON_QUERY` — bool, default `true`. Gates auto_summary on GET pendingReports.
- `DELIBERATION_REPORT_AUTO_SUMMARY_LINES` — int, default 40. Max lines in auto_summary.
- `DELIBERATION_REPORT_AUTO_SUMMARY_MAX_BYTES` — int, default 4096. Byte cap on auto_summary.

### Deprecated

- `reportTimeoutSecs` env var — emits deprecation warning if set. Removed in 0.3.x. Evidence (7.5s–649s task range) showed a default timer is arbitrary and prone to false timeouts; replaced with event-driven detection (idle + dead + explicit query).

### Tests

- `test/report-enforcement.test.js` — 28 new unit tests for `classifyReportPrompt`, `buildAutoSummary`, regex exports
- `test/enforce-report.test.js` — 11 new integration tests for bus events and endpoints
- Full suite: **170/170 passing** (131 pre-existing + 39 new)

### Migration notes

- **No orchestrator-side changes required** to benefit. New bus events flow passively; legacy `TASK_COMPLETE:` text-inject still fires.
- Consumers that subscribe to the bus now see richer event types — optional to consume.
- Orchestrators wanting to dismiss a pending report can use `DELETE /api/pendingReports/{id}`.
- Orchestrators wanting on-demand summary can use `GET /api/pendingReports/{id}` (honors `DELIBERATION_REPORT_AUTO_SUMMARY_ON_QUERY`).
