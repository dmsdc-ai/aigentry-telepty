# 2026-05-02 — `inject --submit-force` + idempotent client retry

Closes task #347 (telepty 0.3.2 `--submit` prompt-symbol gate reliability —
context-ref inject arrived at orchestrator but Enter was skipped when the
input area had a transient render mismatch: autocomplete dropdown open,
cursor moved, mid-render race).

## Problem

`telepty inject --submit` runs three layers of gating before pressing
Enter:

| Layer | File | Trigger | Skip behavior |
|---|---|---|---|
| 3. Prompt-symbol (0.3.2) | `src/submit-gate.js` `awaitPromptSymbol` | `cmux read-screen` does not show the per-CLI prompt symbol stably for ≥200 ms within 8 s | Falls through to Layer 1 (`no_prompt_symbol_seen`) |
| 1. State-gated (0.3.1) | `src/submit-gate.js` `awaitReplReady` | `sessionStateManager` is not in `idle`/`waiting` with conf ≥ 0.5 within 10 s | Best-effort dispatch on `timeout`; hard-fail short-circuits to 504 on `session_dead`/`error`/`restarting`/`no_state` |
| Verify | `src/submit-gate.js` `verifyBodyConsumed` | Injected body still visible in `outputRing` after dispatch | One bounded retry; if still visible, 504 with `reason: 'gated_dispatch_unconsumed'` |

In production this still produces a residual failure rate when the
orchestrator session has a transient render mismatch (autocomplete drop-down,
cursor outside input area, mid-paste). The body is injected, the gate times
out, the dispatch fires Enter into a "wrong" focus, and `verifyBodyConsumed`
correctly sees the body still in the input box → 504. Sub-sessions then
print `⚠️ Submit gated-timeout` and the human user has to press Enter
manually for the orchestrator to consume the inject.

## Constraints

- **Article 1 (경량)**: minimum-touch fix. No new modules, no new daemon
  endpoint, no new helper module.
- **Article 17 (무의존)**: no new runtime dependency.
- **Article 9 (독립)**: telepty must keep working standalone (no cmux/kitty
  required for the new flags).
- **Backward compat**: existing `--submit` semantics unchanged. Default
  `--submit-retry` value MUST be 0-effect on the happy path (which is the
  vast majority of calls, currently shipping reliably).
- **Idempotency**: a retry must never double-press Enter.

## Approach

Two opt-in CLI knobs on `telepty inject`, both implemented client-side
in `cli.js`. Daemon `/submit` endpoint is untouched — `force: true` is
already supported (introduced in 0.3.1 for `telepty send-key`); we just
plumb it through from the inject path.

### `--submit-force`

Adds `force: true` to the `/submit` POST body. Daemon-side this skips
both Layer 3 (prompt-symbol) and Layer 1 (state-gate) and dispatches Enter
once via the existing `terminalLevelSubmit` chain (kitty → cmux → PTY).

Use case: caller is confident the target REPL is ready (e.g., orchestrator
visibly idle, or Phase-6 cascade where sub-session has just verified the
orchestrator's last bus event). Mirrors the existing `telepty send-key`
escape hatch but at the inject level so a single command does both.

### `--submit-retry N` (default 1, clamp [0, 3])

After a 504 from `/submit` with a **retry-safe** reason, wait 300 ms and
re-issue the same `/submit` request up to N times. Retry-safe reasons:

| Reason | Source | Why retry is idempotent |
|---|---|---|
| `gated_dispatch_unconsumed` | `daemon.js:1680` | The verify path saw the body STILL in the input box after best-effort dispatch. Re-firing Enter when the body is visibly un-consumed cannot double-submit. |
| `gate_timeout` | `awaitReplReady` returning `timeout` (no longer reaches 504 directly in 0.3.1, but kept for forward-compat) | Same: body has not been consumed if we're still on the gated path. |
| `no_prompt_symbol_seen` | `awaitPromptSymbol` Layer 3 timeout (also not currently a 504 source, but kept for forward-compat) | Layer 3 alone never emits 504 today. Listed for completeness. |

Retry is **explicitly NOT** safe for hard-fail reasons — `session_dead`,
`session_error`, `session_restarting`, `no_state`, `no_state_manager`. Those
short-circuit the loop immediately because re-firing won't recover. Same
for any non-504 status (4xx) — no point retrying a malformed request.

The retry preserves the original flag set (`force` stays `force`, etc.).
The `attemptsMade` counter is rendered into the success line as
`[retry K/N]` so operators can see when the retry path actually fired.

### Why client-side (not daemon-side)?

- Server-side already retries once internally inside `verifyBodyConsumed`
  (`daemon.js:1663-1672`). Adding a second loop server-side conflates two
  feedback signals (the inner verify retry vs. the outer client retry) in
  one response shape.
- Per-call client control is more flexible — sub-sessions that have
  cheap evidence of orchestrator readiness can pass `--submit-retry 0`
  to avoid the extra round-trip; ones that don't can pass `--submit-retry 2`.
- Keeps the daemon stable. 0.3.0 cluster (memory:
  `feedback_telepty_send_key_regression.md`) was a daemon-side change that
  rippled into manual-override breakage. Client-side change has a strictly
  smaller blast radius.

## File map

| File | Change | LoC delta |
|---|---|---|
| `cli.js` (inject command) | Parse `--submit-force` + `--submit-retry`. Wrap existing `useSubmit` block in idempotent retry loop on 504-with-safe-reason. | +~55, -~25 |
| `test/cli.test.js` | Three new tests: --submit-force passes force=true; --submit-retry retries on safe-reason 504; --submit-retry does NOT retry on hard-fail 504. | +~120 |
| `CHANGELOG.md` | 0.3.3 entry. | +~30 |
| `package.json` | 0.3.2 → 0.3.3. | +1, -1 |
| `test/enforce-report.test.js:280` | Update stale version assertion 0.2.0 → 0.3.3. | +1, -1 |
| `README.md` | Mention new flags in inject summary. | +~6 |

No new files outside `test/` and `docs/`. No daemon changes. No new
dependencies. Total surface ≪ 200 LoC including tests.

## Tests

### Unit / integration (`test/cli.test.js`)

1. **`--submit-force` passes `force: true` to /submit**
   Spawn a session, intercept `/submit` (use existing harness method or
   inspect bus event), invoke `telepty inject --submit --submit-force <id>
   "x"`, assert daemon received `{ force: true }` in the request body.

2. **`--submit-retry N` retries on safe-reason 504**
   Mock the daemon to return 504 `{reason: 'gated_dispatch_unconsumed'}`
   on the first call and 200 on the second. Assert the CLI made exactly
   2 POST /submit calls and exited 0. Assert `[retry 1/N]` is present
   in stdout.

3. **`--submit-retry N` does NOT retry on hard-fail 504**
   Mock the daemon to return 504 `{reason: 'session_dead'}`. Assert the
   CLI made exactly 1 POST /submit call (no retry).

### Regression — full suite

`npm test` — 229 tests, all should pass after updating the stale
`enforce-report.test.js:280` version assertion.

## Future-proofing notes

- If the daemon adds new 504 reasons, they are by default **NOT** retry-
  safe (the safe set is an explicit allowlist). Adding a new safe reason
  is a one-line `RETRY_SAFE_REASONS.add(...)` change in `cli.js`.
- The flag pair composes: `--submit-force --submit-retry 0` (force-once),
  `--submit-force --submit-retry 2` (force, with idempotent retry on the
  rare 503 — though force never returns 504 today).
- The 300 ms retry delay is a constant, not a flag, to keep the surface
  small. Empirically chosen at the upper end of the architect's
  100–300 ms window for the autocomplete-dropdown-close case.
