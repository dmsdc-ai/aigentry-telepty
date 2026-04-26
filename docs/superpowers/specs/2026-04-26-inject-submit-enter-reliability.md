# SPEC: `inject --submit` Enter reliability — render-gated submit

**Date:** 2026-04-26
**Author:** aigentry-telepty-coder
**Status:** SPEC — Phase 1, awaiting orchestrator approval
**Track:** orchestrator UX recurring trap (parallel to #329 Track E27)
**Related prior specs:**
- `specs/codex-inject-spec.md` (Phase 1, established kitty/cmux priority chain — landed)
- `specs/enforce-report-spec.md` (in-flight, REPORT enforcement, orthogonal)

---

## 0. Problem statement

`telepty inject --ref --submit --from <orch> <target> "<body>"` reports
`✅ Submitted via cmux (3 attempts).` but the body remains in the target
session's input prompt with Enter NOT applied. The target then idles
without ever processing the inject. Most reproducible against
freshly-spawned `claude` sessions where the REPL is still rendering its
welcome / model-select / trust-prompt UI when telepty fires Enter.

Workaround in production: orchestrator follows every inject with
`sleep N && telepty send-key <id> enter` (4–6s). This is the trap
this spec exists to remove.

---

## 1. Root cause analysis

### 1.1 Code path for `inject --submit`

CLI side (`cli.js:1540-1660`):

```js
// cli.js:1626-1635 — inject body with no_enter:true
const body = buildInjectRequestBody(injectPrompt, {
  fromId, replyTo, replyExpected,
  noEnter: useSubmit                     // <-- daemon won't send CR after text
});
const res = await fetchWithAuth(`http://${target.host}:${PORT}/api/sessions/${encodeURIComponent(target.id)}/inject`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});
// cli.js:1641-1659 — terminal-level submit
if (useSubmit) {
  await new Promise(resolve => setTimeout(resolve, 500));         // (A) 500ms gap CLI-side
  try {
    const submitRes = await fetchWithAuth(`http://${target.host}:${PORT}/api/sessions/${encodeURIComponent(target.id)}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pre_delay_ms: 600, retries: 2, retry_delay_ms: 500 })  // (B)
    });
    const submitData = await submitRes.json();
    if (submitRes.ok) {
      console.log(`✅ Submitted via ${submitData.strategy}${submitData.attempts > 1 ? ` (${submitData.attempts} attempts)` : ''}.`);
    }
    ...
```

Daemon side (`daemon.js:1474-1520`, full body verbatim):

```js
// daemon.js:1474 — POST /api/sessions/:id/submit
app.post('/api/sessions/:id/submit', async (req, res) => {
  const requestedId = req.params.id;
  const resolvedId = resolveSessionAlias(requestedId);
  if (!resolvedId) return res.status(404).json({ error: 'Session not found', requested: requestedId });
  const session = sessions[resolvedId];
  const id = resolvedId;

  const retries = Math.min(Math.max(Number(req.body?.retries) || 0, 0), 3);
  const retryDelayMs = Math.min(Math.max(Number(req.body?.retry_delay_ms) || 500, 100), 2000);
  const preDelayMs = Math.min(Math.max(Number(req.body?.pre_delay_ms) || 0, 0), 1000);

  console.log(`[SUBMIT] Session ${id} (${session.command})${retries > 0 ? `, retries: ${retries}, pre_delay: ${preDelayMs}ms` : ''}`);

  // Pre-delay: wait for paste rendering to complete before sending CR
  if (preDelayMs > 0) {
    await new Promise(resolve => setTimeout(resolve, preDelayMs));
  }

  let strategy = terminalLevelSubmit(id, session);
  let attempts = 1;

  // Retry: resend CR if paste may have absorbed the first one
  for (let i = 0; i < retries && strategy; i++) {
    await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    terminalLevelSubmit(id, session);   // ← BUG: return value discarded
    attempts++;
  }

  if (strategy) {
    ...
    res.json({ success: true, strategy, attempts });
  } else {
    res.status(503).json({ error: 'Submit failed via all strategies (kitty/cmux/pty)', strategy: 'none', attempts });
  }
});
```

`terminalLevelSubmit` (`daemon.js:635-643`):

```js
function terminalLevelSubmit(id, session) {
  if (session.type === 'wrapped' && sendViaKitty(id, '\r')) return 'kitty';
  if (session.backend === 'cmux' && session.cmuxWorkspaceId && submitViaCmux(id)) return 'cmux';
  if (submitViaPty(session)) return 'pty_cr';
  return null;
}
```

`submitViaCmux` (`daemon.js:1458-1472`):

```js
function submitViaCmux(sessionId) {
  const { execSync } = require('child_process');
  const session = sessions[sessionId];
  if (!session || !session.cmuxWorkspaceId) return false;
  try {
    execSync(`cmux send-key --workspace ${session.cmuxWorkspaceId} return`, {
      timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
    });
    console.log(`[SUBMIT] cmux send-key return for ${sessionId} (workspace ${session.cmuxWorkspaceId})`);
    return true;     // ← "true" only confirms cmux process exit code 0,
                     //   NOT that the REPL consumed the key
  } catch (err) { ... return false; }
}
```

### 1.2 Timing assumptions (the actual root cause)

The CLI / daemon path does not check whether the target REPL is ready.
It blindly fires Enter with bounded delays:

| Step | Wall time after `/inject` returned |
|---|---|
| CLI sleeps before /submit (cli.js:1643) | +500ms |
| Daemon `pre_delay_ms` (cli sends 600) | +1100ms |
| Submit attempt 1 (`terminalLevelSubmit` returns) | +1100ms |
| `retry_delay_ms` (cli sends 500) → attempt 2 | +1600ms |
| `retry_delay_ms` → attempt 3 | +2100ms |

Total wall budget: **~2.1 s** to complete all 3 Enter dispatches.

A freshly-spawned `claude` REPL takes **3–6 s** before its input
loop is ready to accept Enter. Empirically observed phases on a fresh
spawn:

1. Process launch + Node bootstrap (~0.8–1.5 s, no terminal output yet)
2. Welcome banner / `Welcome to Claude Code!` render
3. Trust-this-folder dialog OR model-select dialog (consumes 1 Enter to dismiss)
4. Initial empty prompt rendered with cursor in input box
5. Inject text appears in input box (delivered via mailbox/PTY in step 4)
6. Ready for submit-Enter

If telepty's 3 Enter attempts land in phases 2–3, they are absorbed by
the welcome screen / dialog. By the time phase 6 starts (>2.1s later),
no further Enter is queued — the body sits in the input box, claude
goes idle waiting for keystroke.

### 1.3 Compounding bugs (in addition to the timing miss)

1. **Retry return value discarded** (`daemon.js:1500`). The retry loop
   ignores the result of `terminalLevelSubmit`, so attempts 2 and 3 are
   not actually verified. The reported `attempts` count includes silent
   no-ops if cmux reports failure or kitty socket disappears mid-loop.
2. **`true` does not mean "consumed"**. `submitViaCmux` returns `true`
   on `cmux send-key return` exit-0 — that confirms the cmux process
   accepted the request, **not** that the target REPL processed the key.
   Same for `sendViaKitty` (kitty `send-text` exit-0) and `submitViaPty`
   (PTY write syscall succeeded).
3. **No render-completion check**. There is no observation of the
   target's screen state, no use of the `sessionStateManager` `idle`
   transition, no OSC 133 watch. The submit decision is purely
   open-loop.

### 1.4 Why this is most reproducible on fresh sessions

- Long-running claude sessions are already at phase 6 → first Enter
  attempt at +1.1 s is consumed correctly. Submit "feels" reliable.
- Fresh sessions are mid phase 2–3 at +1.1 s → all 3 attempts wasted.
- The orchestrator's "spawn-then-immediately-inject" pattern (used
  for parallel session fan-out) maximally exposes the trap.

### 1.5 Existing telepty primitives we can use (no new deps)

- `sessionStateManager.getState(id)` → `{ state, since, confidence, ... }`
  with states `starting | idle | working | thinking | waiting | error | restarting | dead`.
  `idle` with confidence ≥ 0.9 is a high-quality "ready for Enter" signal
  (OSC 133;A/B mark or matched prompt pattern).
  (`session-state.js:225-238`, `daemon.js:54,767,1123`)
- `sessionStateManager.onTransition(cb)` → callback on state changes
  (`session-state.js:570`, `daemon.js:54-117` already wires this).
- `GET /api/sessions/:id/screen?lines=N` → returns ANSI-stripped recent
  screen text from `outputRing` (`daemon.js:1748-1802`). Usable for
  detecting the body text in the input box if state machine is
  inconclusive.
- `outputRing` is already maintained per-session, capped at 200KB
  (`daemon.js:729-738`).

---

## 2. Decision matrix

Every option below preserves the `/submit` HTTP contract, the
`✅ Submitted via <strategy>` CLI output, and the kitty / cmux / PTY
priority chain. Only the *internal* "when do we fire Enter, and how do
we know it landed" logic changes.

| Approach | What it does | Reliability | Latency (typical) | Latency (worst) | Code changes | Cross-OS | Verdict |
|---|---|---|---|---|---|---|---|
| **A. Bigger blind delays** | Raise `pre_delay_ms` default to e.g. 4000ms; raise `retry_delay_ms`. | Better but still open-loop. Will miss slower spawns; will pay 4 s on already-ready sessions. | +4 s | +5+ s | trivial (constants) | OK | ❌ Brittle. Pure regression on warm sessions. |
| **B. Render-completion gate via `sessionStateManager`** | Before firing Enter, await `getState(id).state === 'idle'` (or `working` returning to `idle`) with bounded timeout. | High when state machine sees prompt or OSC 133. Lower (silence-fallback @ 0.6 conf) for CLIs that don't emit OSC 133 and have unusual prompts (claude UI is one). | +1.1 s typical | +5 s + idle_timeout (bounded) | ~30 LOC daemon + helper | ✅ pure JS, no shell-out | ✅ Best primary. Already-existing primitive. |
| **C. Cursor-position / input-box check via `read-screen`** | Poll `outputRing` after inject. Look for the body text in the last screen. Once visible, fire Enter. After Enter, wait for body to disappear from screen → success. | High but fragile. Body text may render across line wraps; ANSI box-drawing complicates matching; long bodies truncated. | +1–2 s | +5 s | ~80 LOC matcher + edge cases | ✅ pure JS | ⚠️ Reasonable as fallback when state machine is inconclusive. Heavy alone. |
| **D. Hybrid (B + C-as-fallback + bounded retries)** | Primary: wait for `idle` state with conf ≥ 0.85 (timeout 5 s). If timeout, fallback: confirm body present in screen (timeout 2 s). Then fire Enter via existing kitty→cmux→PTY chain. Then verify via screen poll: body left input → success. Else one bounded retry, then surface a structured failure. | Highest. Closes the loop on both render and consumption. | +1.2 s typical | +8 s | ~70 LOC daemon + 1 helper module | ✅ pure JS | ✅ **Recommended.** |

### 2.1 Recommendation: **Approach D (hybrid)**

**Rationale tied to constitutional rules:**

- **Rule 1 (경량)**: Reuses `sessionStateManager` and `outputRing` —
  primitives already shipped and exercised. New code is one
  ~70-LOC daemon helper + targeted edits in two functions. No new
  module imports, no new long-running goroutines/timers.
- **Rule 17 (무의존)**: Zero new external dependencies. Uses only
  Node built-ins, existing `child_process` paths, and existing
  internal modules.
- **Rule 26 (cross-OS)**: All logic is pure JS evaluating the same
  in-memory `outputRing` and state machine that already runs on every
  supported OS. The OS-specific shell-outs (`kitty`, `cmux`,
  `osascript`) are unchanged — only the *gate* before invoking them
  is added.
- **Reliability vs latency**: Warm sessions (state already `idle`)
  pay ~0 ms extra gate cost — they short-circuit the wait immediately.
  Cold sessions pay an honest 1–5 s wait that matches actual REPL
  readiness, instead of guessing 600 ms × 3.

### 2.2 Approaches explicitly rejected

- **A** alone — raises latency floor for the common case without
  closing the open-loop hole.
- **C** alone — fragile against ANSI box-drawing / line-wrap; high
  maintenance burden as CLIs evolve their input UI.
- "Send Enter twice" — pure brute force, see §5.
- "Hardcode 10 s sleep" — see §5.
- "Force tmux fallback" — see §5.

---

## 3. Cross-OS abstraction (Rule 26)

The change does **not** introduce per-OS code paths. The new gate is
pure JS reading in-memory state. The existing `kitty` / `cmux` /
`osascript` shell-outs already encode OS behavior and are unchanged.

`telepty` does not have a `lib/platform.sh` style abstraction layer —
backend selection currently happens via:
- `terminal-backend.js:detectTerminal` (env vars + file probes)
- `daemon.js:terminalLevelSubmit` (priority chain)
- `daemon.js:getSubmitStrategy` (CLI binary → strategy table)

This spec adds **no new OS conditionals**. If a future spec wants to
unify these three sites into a single platform module, that is
out-of-scope here and should be raised as a follow-up.

---

## 4. Test plan

All new tests use `node:test` (existing harness). No new dev deps.

### 4.1 Unit-style (test/submit-gate.test.js — new file)

1. `awaitReplReady(id, sm, opts)` resolves immediately when state is
   already `idle` with conf ≥ 0.85.
2. Resolves on transition to `idle` from `starting`/`working` within
   timeout.
3. Times out after `opts.timeout_ms` and resolves with
   `{ ready: false, reason: 'timeout', last_state }`.
4. Honors `waiting` state — does not gate (waiting *is* a prompt, just
   for y/n) — resolves immediately so a body-Enter still fires.
5. `verifyBodyConsumed(session, bodyText, opts)` returns `{ consumed: true }`
   when last `outputRing` screen no longer contains `bodyText`.
6. Returns `{ consumed: false, reason: 'still_visible' }` when body
   still in screen after `opts.timeout_ms`.
7. Tolerates ANSI in the screen (uses existing `stripAnsi` from
   daemon.js:1766) and tolerates whitespace collapsing.

### 4.2 Daemon endpoint integration (test/daemon.test.js additions)

8. `POST /submit` with the new gate path, simulated state machine
   already `idle` → exactly 1 Enter dispatch, response
   `{ success: true, strategy: ..., attempts: 1, gated: true, gate_wait_ms: <small> }`.
9. `POST /submit` with simulated never-idle session → response
   `{ success: false, error: 'gate_timeout', attempts: 0, gated: true, gate_wait_ms: <opts.timeout_ms> }`,
   HTTP 504 (new), CLI prints structured warning.
10. `POST /submit` retry: simulated body-still-visible after first
    Enter → attempts=2, eventual success.
11. **Regression: response shape compatibility.** When `gated: true`
    is omitted (legacy path / opt-out env var), response remains
    exactly the current `{ success, strategy, attempts }` shape.

### 4.3 End-to-end reliability harness (test/e2e-submit.manual.js — new opt-in)

Not run in `npm test` (kept gated behind `TELEPTY_E2E=1`):

12. **100× spawn-and-inject loop on fresh `claude`** (the failure mode
    cited in the bug report). For each iteration:
    - `telepty allow --id e2e-claude-NN claude` (background)
    - `telepty inject --submit --from e2e e2e-claude-NN "ECHO: <nonce>"`
    - Within 30 s, expect `<nonce>` to appear in claude's response.
    - Pass criterion: ≥ 99/100 iterations succeed without manual
      `send-key` follow-up. Current baseline: ~0/100.
13. Same harness against `codex` and `gemini` sessions — ≥ 99/100.

### 4.4 Regression coverage

14. All 170 existing tests pass unchanged.
15. `inject --ref` (without `--submit`) — unchanged daemon path
    (`deliverInjectionToSession` mailbox+CR), unchanged tests.
16. `send-key <id> enter` — same `/submit` endpoint, same gate,
    confirms latency budget acceptable for solo-Enter use case.
17. Non-cmux strategies (kitty-only, PTY-only) — gate still applies,
    chain unchanged.
18. Aterm sessions — `terminalLevelSubmit` already short-circuits via
    `session.type === 'aterm'` guards in `deliverInjectionToSession`;
    aterm path is skipped. Verified by existing test
    `test/daemon.test.js:135 'inject endpoint accepts an empty prompt
    and still submits enter'`.

---

## 5. Failed approaches (must NOT propose)

| Anti-approach | Why rejected |
|---|---|
| "Just send Enter twice" | Fresh-session welcome screens consume one Enter and may not preserve the input body across the resulting UI transition. Brute-forcing risks data loss, not just latency. |
| Hardcode `setTimeout(10000)` in `/submit` before firing | Imposes 10 s latency on every warm-session inject (regression; orchestrator fan-out runs at high frequency). Violates Rule 1 (경량). |
| Drop cmux strategy, force tmux fallback | Cross-environment regression. The orchestrator and most aigentry sessions run inside cmux; this would break their primary submit path. |
| Add a new external dependency (e.g. `xdotool`, `node-keypress`, `terminus-screen`) | Violates Rule 17 (무의존). Existing primitives suffice. |
| Spam Enter in a tight loop until the body disappears | Risks submitting partial state if claude's input echoes mid-Enter. Pollutes input on UI transitions. Indistinguishable from genuine user keyboard mashing. |
| Move the gate to the CLI (`cli.js`) | Couples CLI to in-process daemon state. Breaks remote injects (`crossMachine.remoteInject` — `cli.js:1606`). Daemon is the only component that owns `sessionStateManager` + `outputRing`, so the gate must live there. |

---

## 6. Constitution check

| Rule | Compliance |
|---|---|
| **Rule 1 — 경량** | ✅ Reuses existing `sessionStateManager`, `outputRing`, kitty/cmux/PTY chain. ~70 LOC net add. |
| **Rule 5 — 최선** | ✅ Closes the open-loop instead of widening the blind delay. No "차선책 workaround" of `sleep N && send-key`. |
| **Rule 13 — 비판적+건설적+객관적** | ✅ Anti-approaches and risks listed verbatim with reasons; no rhetoric. |
| **Rule 17 — 무의존** | ✅ Zero new external dependencies. |
| **Rule 26 — cross-OS** | ✅ No new per-OS branches. New code is OS-neutral pure JS. |
| **Constitution Rule 1 (AI gap)** | ✅ Removes a recurring orchestrator UX trap that wastes parallel-fanout latency budget. |
| **Constitution Rule 5 (best-first)** | ✅ Identifies and fixes the actual cause; refuses brittle workarounds. |

---

## 7. Invariants preserved

- ✅ `telepty list`, `telepty allow` semantics unchanged.
- ✅ `inject --ref` without `--submit` behavior unchanged (mailbox-text +
  deferred `\r` path remains the default for non-`--submit` injects).
- ✅ `send-key <id> enter` still works; uses the same gated `/submit`
  endpoint. Fresh-session use case for `send-key` *also* benefits.
- ✅ Non-cmux strategies (kitty, daemon PTY \r, osascript fallback)
  unchanged in dispatch order.
- ✅ Output contract: `✅ Submitted via <strategy>` line preserved on
  success. New optional fields (`gated`, `gate_wait_ms`, `attempts`) are
  additive in the daemon JSON response; CLI may surface them only when
  `--verbose` is set (out of scope; default CLI output unchanged).
- ✅ HTTP status codes: `200` on success, `503` on dispatch-failure
  preserved. New `504 gate_timeout` distinguishes "we never even tried
  to fire Enter because the REPL never readied" from "we tried and
  failed".
- ✅ Aterm sessions unaffected (gate is bypassed for `session.type === 'aterm'`).
- ✅ Bus event `submit` still emitted on success with the same shape;
  optional `gated`/`gate_wait_ms` fields added.
- ✅ Existing 170-test suite passes unchanged.

---

## 8. Implementation outline (for Phase 2 — orchestrator approval required first)

**Files to modify:**

| File | Change |
|---|---|
| `daemon.js` (new helper, ~40 LOC near line 643) | `awaitReplReady(sessionId, opts)` — promise that resolves when `sessionStateManager.getState(id)` reports `idle` (conf ≥ 0.85), `waiting`, or already had OSC 133 within last `idle_timeout_ms`. Bounded by `opts.timeout_ms` (default 5000). Listens via `sessionStateManager.onTransition`; immediate-resolve fast path when already ready. |
| `daemon.js` (new helper, ~25 LOC) | `verifyBodyConsumed(session, bodyText, opts)` — reads last N lines of `session.outputRing` via the existing `stripAnsi` (extract or import from line 1766). Returns truthy when normalized body text no longer present in screen tail. Bounded poll (default 1500 ms, 200 ms interval). |
| `daemon.js:1474-1520` (POST `/submit`) | Replace blind retry loop with: (a) `await awaitReplReady`, (b) single `terminalLevelSubmit`, (c) if injected body provided in POST (new optional field), `await verifyBodyConsumed` → if not consumed, one bounded retry; (d) return augmented JSON. Preserve existing shape on legacy callers (no `injected_body` field). |
| `cli.js:1641-1659` (inject --submit) | Pass `{ injected_body: injectPrompt }` in the `/submit` POST body so the daemon can verify consumption. Remove the CLI-side 500 ms `setTimeout` (gate handles timing). Keep `pre_delay_ms`/`retries`/`retry_delay_ms` accepted for back-compat but treat them as upper bounds, not floors. |
| `cli.js:1706-1730` (send-key) | Optional cosmetic: surface `gated`/`gate_wait_ms` on `--verbose`. Default output unchanged. |
| `daemon.js` env-var opt-out | `TELEPTY_SUBMIT_GATE=off` reverts to the legacy 3-attempt blind path (escape hatch for parity testing). Default: `on`. |
| `test/submit-gate.test.js` (new) | Unit tests §4.1, daemon integration §4.2. |
| `test/e2e-submit.manual.js` (new, opt-in) | §4.3 reliability harness. |
| `CHANGELOG.md` | Entry under upcoming patch (`0.2.1` or `0.3.0` depending on whether the new HTTP 504 path is judged breaking — see §10). |

**LOC estimate:** ~70 net add (helpers) + ~30 modified (endpoint refactor) + ~120 new test LOC. Total ≤ 250 LOC.

**Risk surface:** confined to one HTTP endpoint and the CLI submit branch. No bus-event schema changes, no persistence-layer changes, no state-machine changes — only *reading* state.

---

## 9. Reliability target

Current baseline (estimated from 2026-04-26 orchestrator evidence
across ≥ 5 incidents in one session-day): **~0%** of fresh-session
`inject --submit` calls land Enter without manual `send-key`
follow-up.

Target: **≥ 99%** in the 100× spawn-and-inject E2E harness (§4.3 #12).
Failure cases above 1% must surface a structured `gate_timeout` /
`body_not_consumed` reason for orchestrator visibility.

---

## 10. Open questions (Phase 2 input requested)

1. **HTTP 504 introduction**: Adding a new `504 gate_timeout` status to
   `/submit` is technically an additive change but consumers may treat
   any non-2xx as fatal. Is this a patch (0.2.1) or minor (0.3.0)?
   Recommendation: minor (0.3.0) since it is observable new behavior.
2. **CLI default verbosity**: Should the gate timing (`gate_wait_ms`)
   be surfaced in the default `✅ Submitted via cmux ...` line, or
   only on `--verbose`? Default-on increases noise during fan-out;
   default-off hides the new diagnostic value. Recommendation: hide
   by default, expose via `--verbose`.
3. **Per-CLI tuning**: claude takes 3–6 s to ready; codex and gemini
   are usually faster. Should `awaitReplReady` timeout be CLI-aware
   (5 s for claude, 3 s for others)? Recommendation: single 5 s
   default for now; revisit only if E2E harness §4.3 shows latency
   regressions on warm sessions.
4. **Interaction with REPORT enforcement (`specs/enforce-report-spec.md`)**:
   None — that spec governs what happens *after* a session goes idle
   post-inject. This spec governs whether the inject ever submitted
   in the first place. Orthogonal.

---

## 11. Phase 2 entry criteria

- Orchestrator approves Approach D.
- Open question §10.1 (semver) decided.
- Phase 2 implementation budget ≤ 250 LOC, ≤ 4 h wall.
- Phase 2 success: §4.3 harness ≥ 99/100, full suite green, no
  regression on `inject --ref` (no-submit) or aterm paths.
