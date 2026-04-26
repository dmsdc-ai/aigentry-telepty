---
status: draft
date: 2026-04-26
topic: submit-gate-fixes-v2
predecessors:
  - docs/superpowers/specs/2026-04-26-inject-submit-enter-reliability.md (δ Phase 1+2, telepty 0.3.0 commit 0c66d87)
fixes:
  - δ-fix-2: send-key bypass gate (P0)
  - δ-fix-3: gate threshold relaxation (P1)
  - δ-fix-4: timeout extension + dispatch-on-timeout (P1)
constitution_rules: [Rule 17 무의존, Rule 26 cross-OS]
---

# SPEC: submit-gate-fixes-v2 — δ-fix-2/3/4

**Date:** 2026-04-26
**Author:** aigentry-telepty-coder
**Status:** SPEC — Phase 1, awaiting orchestrator approval
**Track:** orchestrator UX trap — δ-fix-2/3/4 (post-δ-Phase-2 regression cluster)
**Authority:** orchestrator's root-cause analysis 2026-04-26
**Predecessor:** `docs/superpowers/specs/2026-04-26-inject-submit-enter-reliability.md` (δ Phase 1, landed as 0.3.0 commit `0c66d87`)
**Memory citations:** `feedback_telepty_send_key_regression.md`, `feedback_evidence_based_bugfix.md`, `feedback_dustcraw_evidence_required.md`, `feedback_git_explicit_paths.md`

---

## 0. Problem statement

After δ Phase 2 (telepty 0.3.0, `0c66d87`) shipped, three regressions were observed across 4 fresh-spawned sessions (impl-a, impl-b, v3-tester, builder-e2e) on 2026-04-26:

1. **`telepty send-key <sid> enter` returns 504** on fresh-spawned claude/codex sessions. The CLI's send-key path (`cli.js:1741`) routes through the same gated `/submit` endpoint. Even the manual Enter override fails — the orchestrator is forced to bypass telepty entirely (`cmux send-key --workspace workspace:N enter`).
2. **Gate confidence threshold 0.85 is too strict for fresh sessions.** `sessionStateManager` reports `state='idle'` once silence detection fires, but with `confidence=0.6` when neither OSC 133 nor a shell-prompt pattern matched (the common case for the claude TUI). `awaitReplReady` (`src/submit-gate.js:62`) then rejects, and the gate eventually times out with `reason='timeout'`.
3. **Default `gate_timeout_ms=5000` is too short** for fresh REPLs (claude observed at 3–6 s; with stale silence detection on top, 5 s is borderline). When the gate times out, dispatch is abandoned entirely (`daemon.js:1558-1568`) — strictly worse than the pre-0.3.0 blind retry, which at least *attempted* the dispatch.

These three regressions all stem from a single decision in 0.3.0: gating became binary ("ready or 504") with strict thresholds tuned to high-confidence states (OSC 133 / shell prompt pattern), while the most common AI-CLI ready state on fresh spawn is the silence-fallback (`confidence=0.6`).

---

## 1. Root cause analysis

### 1.1 Fix 1 — send-key routes through gate (P0)

**`cli.js:1741`** (verbatim):

```js
const res = await fetchWithAuth(`http://${target.host}:${PORT}/api/sessions/${encodeURIComponent(target.id)}/submit`, { method: 'POST' });
```

The `send-key` command was unchanged by δ Phase 2 — it still POSTs to `/submit` with an empty body. But that endpoint's behaviour was changed to gate by default (`daemon.js:1552-1568`):

```js
// daemon.js:1554-1569 — gate runs unconditionally when TELEPTY_SUBMIT_GATE != 'off'
const gateResult = await submitGate.awaitReplReady(id, sessionStateManager, {
  timeoutMs: gateTimeoutMs,
});
if (!gateResult.ready) {
  return res.status(504).json({
    error: 'Submit gated-timeout — target REPL never readied for input',
    reason: gateResult.reason, last_state: gateResult.last_state,
    strategy: 'none', attempts: 0, gated: true, gate_wait_ms: gateResult.waited_ms,
  });
}
```

There is no per-request opt-out, only a daemon-global env var (`TELEPTY_SUBMIT_GATE=off` at line `daemon.js:1511`). Thus a manual Enter — explicitly the "press this key, no questions" semantic — inherits `inject --submit`'s render-readiness gate. **This is the regression.**

The δ Phase 1 spec §4 contemplated `send-key` benefiting from the same gate (§4.2 line 322 in the predecessor spec) — that turned out to be wrong. **Manual override must remain manual.** Memory `feedback_telepty_send_key_regression.md` records the workaround in production (`cmux send-key` direct).

### 1.2 Fix 2 — confidence threshold too strict (P1)

**`src/submit-gate.js:50-51`** (verbatim):

```js
const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 5000;
const minConfidence = Number.isFinite(opts.minConfidence) ? opts.minConfidence : 0.85;
```

**`session-state.js:378-380`** (verbatim — the only IDLE-confidence assignment site):

```js
const hasOsc133 = this._lastOsc133At && (now - this._lastOsc133At) < this.config.idle_timeout_ms * 2;
const hasPrompt = this._matchesAny(lastLine, PROMPT_PATTERNS);
const confidence = hasOsc133 ? 0.95 : (hasPrompt ? 0.9 : 0.6);
```

The state machine emits exactly three `IDLE` confidences in normal operation:

| Trigger | Confidence | Source |
|---|---|---|
| OSC 133;A or 133;B mark within last 2× idle_timeout | **0.95** | `session-state.js:380` |
| Last line matches `PROMPT_PATTERNS` (shell-style `$#%>❯›»`, python `>>>`, etc.) | **0.9** | `session-state.js:380` |
| Silence > `idle_timeout_ms` (5 s default), no prompt match | **0.6** | `session-state.js:380` |

**`session-state.js:77-83`** — `PROMPT_PATTERNS` (verbatim):

```js
const PROMPT_PATTERNS = [
  /[$#%>❯›»] *$/,              // common shell prompts
  />>> *$/,                     // python REPL
  /\.\.\. *$/,                  // python continuation
  /\(.*\) *[$#>] *$/,          // virtualenv / conda prefix
  /^\[.*@.*\][$#] *$/m,        // [user@host]$
];
```

The claude TUI is a custom Ink/React renderer: its input UI is a Unicode-box with a `│ > │` interior — `>` is followed by `│`, not end-of-line, so PROMPT_PATTERNS do NOT match. The claude TUI also does NOT emit OSC 133 (verified by reading the upstream Ink source — no `\x1b]133;` in claude-code's prompt component). **Therefore fresh claude lands in the silence-fallback bucket → confidence 0.6.**

With `minConfidence=0.85` (the hard-coded default), 0.6 is rejected and the gate either waits for a transition (none comes — the session is already at peak readiness) or times out. **The state machine considers the session ready; the gate disagrees.** Mismatch.

### 1.3 Fix 3 — timeout too short + dispatch abandoned on timeout (P1)

**Two sub-problems compounded:**

(a) **Timeout default 5000 ms is below empirical claude-ready time.** Predecessor spec §1.2 (line 144) cites "freshly-spawned `claude` REPL takes 3–6 s before its input loop is ready". With `idle_timeout_ms=5000` (`session-state.js:58`), silence detection itself takes 5 s before any IDLE transition. A 5 s gate timeout is on the failure side of that distribution.

(b) **Gate timeout abandons dispatch (`daemon.js:1558-1568`):**

```js
if (!gateResult.ready) {
  return res.status(504).json({ ... attempts: 0, gated: true, ... });   // ← never calls terminalLevelSubmit
}
```

Pre-0.3.0 (legacy blind path) always called `terminalLevelSubmit` at least once. Post-0.3.0, on gate timeout, *zero* dispatch attempts happen. This is **strictly worse than the pre-0.3.0 worst case**: previously the body might land late (silently); now it never lands and the orchestrator sees 504. The gate was supposed to be *additive* (verify ready, *then* dispatch); on timeout it became *subtractive* (skip dispatch entirely).

The verify step (§5.4 of predecessor, `src/submit-gate.js:125-162`) already returns optimistic `consumed:true` when the body was never visible (`reason: 'never_visible'`) — it would handle the "we dispatched blind, body got consumed" case. We just never get there.

### 1.4 Why this is most reproducible on fresh sessions

- Long-running claude sessions: have already had OSC-133 events (if any plugin ever fired one) cached, OR have produced enough output to push prior shell prompts into recent lines, OR have completed at least one full cycle that bumped confidence. Less common to hit 0.6 fallback.
- Fresh sessions: no event history. Spawn → render banner (~1 s) → trust dialog → blank input box. The first IDLE transition on a 5 s silence after spawn produces 0.6 confidence. Gate rejects. The orchestrator's "spawn-then-immediately-inject" pattern (used for parallel session fan-out) maximally exposes the trap — which exactly matches the production observations.

### 1.5 Existing primitives (no new deps — Rule 17)

- `src/submit-gate.js` is already a self-contained module with `awaitReplReady` and `verifyBodyConsumed`. All three fixes can be implemented by adding parameters to its existing API surface and one early-exit branch in the `/submit` endpoint.
- `terminalLevelSubmit` (`daemon.js:636-644`) is unchanged — it remains the single dispatch primitive.
- HTTP body parameters (`pre_delay_ms`, `retries`, `injected_body`, etc.) already pass-through pattern via `req.body?.<field>` clamping; adding `force`, `min_confidence` follows the same convention.

---

## 2. Decision matrix per fix

### 2.1 Fix 1 — send-key bypass gate

| Approach | What it does | API impact | LOC | Cross-OS | Backwards compat | Verdict |
|---|---|---|---|---|---|---|
| **A. `force` body param on `/submit`** | `POST /submit { force: true }` skips gate + verify, dispatches once via `terminalLevelSubmit`, returns `{ success, strategy, attempts:1, gated:false }`. CLI's `send-key` command always sets `force:true`. | Additive body field; response shape unchanged when `force:false`. | ~15 daemon + ~5 CLI | ✅ same path | ✅ default opt-in gate for inject; opt-out per-request for send-key | ✅ **Recommended.** |
| B. New `POST /api/sessions/:id/key` endpoint | Dedicated never-gated endpoint. CLI's `send-key` POSTs `/key`. `/submit` retains gate semantics. | New endpoint; new test surface; bus event duplication. | ~40 daemon + ~10 CLI + ~30 test | ✅ same path | ✅ but doubles routes | ⚠️ Cleaner contract but heavier. |

**Recommendation: A.** Rationale tied to constitution:

- **Rule 1 (경량) / KISS**: One endpoint, one contract. New endpoint duplicates routing, body parsing, bus emission, and tests.
- **Rule 17 (무의존)**: No new dependency surface. `force` is a body field — same JSON serializer, same bus event format.
- **Symmetry with the existing `TELEPTY_SUBMIT_GATE=off` env var**: that flag is the daemon-wide opt-out at `daemon.js:1511`. `force` is the per-request opt-out — same code path, narrower scope.
- **Backwards compatibility**: every existing caller omits `force` → unchanged behaviour. Only `cli.js:1741` needs to pass `{ force:true }` when the user types `send-key`.

The trade-off is conceptual purity (B's argument: send-key and submit are semantically different operations) versus operational simplicity (A's argument: same dispatch primitive, one switch). Given this codebase's existing pattern of body-field gating (e.g. `injected_body`, `gate_timeout_ms`), A is more idiomatic.

### 2.2 Fix 2 — gate confidence threshold

| Approach | What it does | Tuning vs evidence | Risk of false-ready | Verdict |
|---|---|---|---|---|
| (i) **Lower default `minConfidence` to 0.5** | Allows the silence-fallback IDLE (conf=0.6) through. Per-request `min_confidence` body param remains for callers wanting tighter gating. | Matches `session-state.js:380` lowest legitimate IDLE confidence; 0.5 is comfortably below 0.6 with margin. | Very low — IDLE is only entered after `idle_timeout_ms` (5 s) silence. Low-confidence IDLE is the *dominant* ready state for AI-CLI TUIs (no OSC 133, no shell prompt). | ✅ **Recommended.** |
| (ii) Allow `confidence === undefined` to pass | Loophole tactic; current state machine never emits undefined confidence (the `_transition` constructor always assigns one). Adopts a contract that doesn't actually exist today and creates fragility if state shape changes. | No empirical basis. | Higher — future state shape changes could leak through. | ❌ |
| (iii) Per-CLI threshold table | Map `claude→0.5`, `codex→0.7`, `gemini→0.7`, default 0.85. | Over-tuned; current state machine emits the same {0.95, 0.9, 0.6} regardless of CLI. The CLI-specific axis is *prompt-pattern matchability*, not confidence semantics. | Low but with maintenance cost as new CLIs appear. | ⚠️ Premature optimization (YAGNI). |

**Recommendation: (i) — single default `minConfidence = 0.5`**, plus per-request override `min_confidence` (already accepted but un-clamped — clamp `[0, 1]`).

Why 0.5 specifically (not 0.6 or 0.7)?
- 0.5 sits below the lowest legitimate IDLE conf (0.6) with explicit margin.
- 0.7 would still admit shell-prompt and OSC 133 only — same regression.
- 0.6 (exact match) is fragile: if `session-state.js:380` ever drops the silence-fallback to 0.55 (e.g. when stale), 0.6 threshold breaks silently. 0.5 is the conservative "below all legitimate IDLEs" boundary.
- The state machine's `WAITING` state is set to 0.9 (`session-state.js:316`), so 0.5 also admits all WAITING.
- 0.5 is well above the "no signal" floor — the state machine never emits an IDLE/WAITING below 0.6 today.

**Test impact:** the existing test at `test/submit-gate.test.js:185-193` ("rejects ready transition with low confidence and falls through to timeout") uses `minConfidence: 0.85` + `confidence: 0.6` and expects timeout. It tests **the threshold mechanism** (not the specific value). Update test to: pass `minConfidence: 0.7`, sim transition to `confidence: 0.5` — same assertion, different numbers.

### 2.3 Fix 3 — timeout extension + dispatch-on-timeout

Two concerns; recommended jointly because the right fix for (b) reduces the operational sting of (a).

**(a) Default `gate_timeout_ms`:**

| Option | Value | Rationale |
|---|---|---|
| Keep 5000 | regression untouched | ❌ |
| Raise to 10000 | matches claude 3–6 s ready window with margin | ✅ |
| Per-CLI (claude=10000, codex=8000, gemini=8000) | tighter on faster CLIs | YAGNI; the gate short-circuits when ready, so a 10 s ceiling pays nothing on warm sessions and 2 extra seconds on cold codex/gemini if they ever miss the 8 s mark | ⚠️ |

**Recommendation: 10000 ms uniform default.** Per-CLI is over-engineered until evidence (E2E §4.3 below) shows codex/gemini routinely paying the extra 2 s.

**(b) Dispatch-on-timeout (best-effort):**

| Option | Behaviour on timeout | Distinguishability of failure | Verdict |
|---|---|---|---|
| **D₁. Dispatch + verify (recommended)** | Call `terminalLevelSubmit` once, then `verifyBodyConsumed` (timeout 2 s, polling outputRing). Three terminal states: <br/>- ready=true, dispatch ok → 200 (normal path) <br/>- ready=false (gate timeout), dispatched, `consumed=true` → 200 with `gated_dispatch_after_timeout: true` flag <br/>- ready=false, dispatched, `consumed=false` → 504 honest fail (`reason: 'gated_dispatch_unconsumed'`) <br/>- ready=false, no `injected_body` (e.g. `inject --submit ""` empty body / send-key edge) → 200 with flag (no way to verify; trust dispatch) | High — flag distinguishes "gate failed but body landed" from "ready and consumed". | ✅ **Recommended.** |
| D₂. Dispatch blind on timeout (no verify) | Single `terminalLevelSubmit` on timeout, return 200. | Low — collapses two outcomes into one; loses honesty signal. | ❌ regression of 0.3.0's main goal. |
| D₃. Keep 504-on-timeout (strict) | 0.3.0 behaviour. | High — but unhelpfully so; 504 means "we didn't even try" today. | ❌ status quo. |

**Recommendation: D₁ — dispatch + verify on timeout.** This restores the dispatch attempt that pre-0.3.0 would have made, while keeping the new honesty signal (504 only fires when verification confirms the body is still in the input box). It strictly Pareto-dominates D₂ and D₃.

The new response field `gated_dispatch_after_timeout: true` is additive — clients that don't handle it see a normal 200 OK. Clients that special-cased 504 to retry will see fewer 504s, which is a relaxation, not a tightening.

---

## 3. Implementation plan per fix

All three fixes ship in **one commit** (telepty 0.3.1). Rationale: they share the same endpoint and helper module; splitting would produce three commits each touching daemon.js:1497-1624 with merge conflicts. Memory `feedback_git_explicit_paths.md` applies — stage with explicit paths only:

```bash
git add src/submit-gate.js daemon.js cli.js test/submit-gate.test.js test/daemon.test.js docs/superpowers/specs/2026-04-26-submit-gate-fixes-v2.md package.json CHANGELOG.md
```

### 3.1 Fix 1 (send-key bypass)

**File: `daemon.js:1497-1550` (POST /submit, near top after body parsing).**

Insert immediately after `gateOff` block:

```js
// Per-request bypass: { force: true } skips gate + verify, single dispatch.
// Used by `telepty send-key` (manual override) and any caller explicitly
// opting out of render-readiness gating.
const force = req.body?.force === true;
if (force) {
  const strategy = terminalLevelSubmit(id, session);
  if (strategy) {
    emitSubmitBus({ strategy, attempts: 1, gated: false, forced: true });
    return res.json({ success: true, strategy, attempts: 1, gated: false, forced: true });
  }
  return res.status(503).json({
    error: 'Submit failed via all strategies (kitty/cmux/pty)',
    strategy: 'none', attempts: 0, gated: false, forced: true,
  });
}
```

**File: `cli.js:1741` (send-key command).**

Change:

```js
const res = await fetchWithAuth(`http://${target.host}:${PORT}/api/sessions/${encodeURIComponent(target.id)}/submit`, { method: 'POST' });
```

To:

```js
const res = await fetchWithAuth(`http://${target.host}:${PORT}/api/sessions/${encodeURIComponent(target.id)}/submit`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ force: true }),
});
```

### 3.2 Fix 2 (threshold relaxation)

**File: `src/submit-gate.js:51`.**

Change:

```js
const minConfidence = Number.isFinite(opts.minConfidence) ? opts.minConfidence : 0.85;
```

To:

```js
const minConfidence = Number.isFinite(opts.minConfidence) ? opts.minConfidence : 0.5;
```

**File: `daemon.js:1507-1508` (POST /submit body parsing).**

Add per-request override (clamped) immediately after `verifyTimeoutMs`:

```js
const minConfidence = req.body?.min_confidence != null
  ? Math.min(Math.max(Number(req.body.min_confidence), 0), 1)
  : undefined; // undefined → src/submit-gate.js default
```

Then in the `awaitReplReady` call (`daemon.js:1555-1557`), pass it through:

```js
const gateResult = await submitGate.awaitReplReady(id, sessionStateManager, {
  timeoutMs: gateTimeoutMs,
  ...(minConfidence !== undefined ? { minConfidence } : {}),
});
```

**File: `test/submit-gate.test.js:185-193` (existing test — UPDATE).**

Change literals to keep the same semantic ("below threshold rejects") but with values that don't conflate with the new default:

```js
test('awaitReplReady rejects ready transition with below-threshold confidence and falls through to timeout', async () => {
  const sm = makeStateManager({ s1: { state: 'working', confidence: 0.9 } });
  const promise = awaitReplReady('s1', sm, { timeoutMs: 80, minConfidence: 0.7 });
  // idle but with confidence below the explicit threshold — should NOT settle.
  setImmediate(() => sm.setState('s1', 'idle', 0.5));
  const result = await promise;
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'timeout');
});
```

### 3.3 Fix 3 (timeout + dispatch-on-timeout)

**File: `daemon.js:1507` (POST /submit body parsing).**

Change:

```js
const gateTimeoutMs = Math.min(Math.max(Number(req.body?.gate_timeout_ms) || 5000, 500), 15000);
```

To:

```js
const gateTimeoutMs = Math.min(Math.max(Number(req.body?.gate_timeout_ms) || 10000, 500), 30000);
```

(Upper clamp raised to 30 s for the rare extreme-cold case; default 10 s is the operative change.)

**File: `daemon.js:1554-1606` (gate + dispatch + verify block — REWRITE).**

Replace:

```js
// Step 1: wait for REPL readiness via session state machine.
const gateResult = await submitGate.awaitReplReady(...);
if (!gateResult.ready) {
  return res.status(504).json({ ... });
}

// Step 2: dispatch Enter via existing kitty → cmux → PTY chain.
let strategy = terminalLevelSubmit(id, session);
let attempts = strategy ? 1 : 0;
if (!strategy) { return res.status(503).json({...}); }

// Step 3: verify body consumption (only when the caller provided the body).
let verify = null;
if (injectedBody && injectedBody.length > 0) { ... }
```

With:

```js
// Step 1: wait for REPL readiness (best-effort — proceed on timeout).
const gateResult = await submitGate.awaitReplReady(id, sessionStateManager, {
  timeoutMs: gateTimeoutMs,
  ...(minConfidence !== undefined ? { minConfidence } : {}),
});
const gatedDispatchAfterTimeout = !gateResult.ready;
if (gatedDispatchAfterTimeout) {
  // Distinguish unrecoverable session states (dead/error/restarting/no_state) —
  // those still produce 504 (no point dispatching to a dead PTY).
  if (gateResult.reason && gateResult.reason !== 'timeout') {
    console.log(`[SUBMIT] gate hard-fail ${id}: ${gateResult.reason} (last_state=${gateResult.last_state})`);
    return res.status(504).json({
      error: 'Submit gated-timeout — target REPL not in a dispatchable state',
      reason: gateResult.reason, last_state: gateResult.last_state,
      strategy: 'none', attempts: 0, gated: true, gate_wait_ms: gateResult.waited_ms,
    });
  }
  console.log(`[SUBMIT] gate timeout ${id}: dispatching anyway (last_state=${gateResult.last_state})`);
}

// Step 2: dispatch Enter (always attempts at least once unless hard-fail above).
let strategy = terminalLevelSubmit(id, session);
let attempts = strategy ? 1 : 0;
if (!strategy) {
  return res.status(503).json({
    error: 'Submit failed via all strategies (kitty/cmux/pty)',
    strategy: 'none', attempts: 0, gated: true, gate_wait_ms: gateResult.waited_ms,
  });
}

// Step 3: verify body consumption.
let verify = null;
if (injectedBody && injectedBody.length > 0) {
  verify = await submitGate.verifyBodyConsumed(session, injectedBody, {
    timeoutMs: verifyTimeoutMs, stripAnsi: stripAnsiState,
  });
  if (!verify.consumed) {
    await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    const retryStrategy = terminalLevelSubmit(id, session);
    if (retryStrategy) {
      strategy = retryStrategy;
      attempts++;
      verify = await submitGate.verifyBodyConsumed(session, injectedBody, {
        timeoutMs: verifyTimeoutMs, stripAnsi: stripAnsiState,
      });
    }
  }
  // If gate timed out AND verify still says still_visible → honest 504.
  if (gatedDispatchAfterTimeout && !verify.consumed) {
    emitSubmitBus({ strategy, attempts, gated: true, gate_wait_ms: gateResult.waited_ms, verify, gated_dispatch_after_timeout: true });
    return res.status(504).json({
      error: 'Submit gated-timeout and body not consumed after best-effort dispatch',
      reason: 'gated_dispatch_unconsumed',
      last_state: gateResult.last_state,
      strategy, attempts, gated: true, gate_wait_ms: gateResult.waited_ms, verify,
    });
  }
}

const responseBody = {
  success: true, strategy, attempts,
  gated: true, gate_wait_ms: gateResult.waited_ms, verify,
  ...(gatedDispatchAfterTimeout ? { gated_dispatch_after_timeout: true } : {}),
};
emitSubmitBus(responseBody);
return res.json(responseBody);
```

**File: `cli.js:1665-1671` (inject --submit response handling).**

Surface the new flag in the success path:

```js
if (submitRes.ok) {
  const gateNote = submitData.gated && submitData.gate_wait_ms > 0
    ? ` [gate ${submitData.gate_wait_ms}ms]`
    : '';
  const lateNote = submitData.gated_dispatch_after_timeout
    ? ' (dispatched-after-gate-timeout)'
    : '';
  const attemptsNote = submitData.attempts > 1 ? ` (${submitData.attempts} attempts)` : '';
  console.log(`✅ Submitted via ${submitData.strategy}${attemptsNote}${gateNote}${lateNote}.`);
}
```

---

## 4. Test plan per fix

All new tests use `node:test` (existing harness). No new dev deps. Memory `feedback_evidence_based_bugfix.md` applies — every assertion is grounded in code we can cite.

### 4.1 Fix 1 — send-key bypass (unit + daemon integration)

In `test/submit-gate.test.js` — Fix 1 needs no submit-gate-module changes (it short-circuits before the gate is invoked). Cover at the daemon level only.

In `test/daemon.test.js` (or new `test/submit-force.test.js`):

1. `POST /api/sessions/:id/submit { force: true }` on a session in `state='starting'` (would normally fail gate) → response `{ success:true, strategy:'pty_cr', attempts:1, gated:false, forced:true }`, HTTP 200.
2. Same call on a missing session → 404 (existing behaviour, regression check).
3. Same call when all dispatch strategies fail (mock `terminalLevelSubmit` returning null) → 503 with `forced:true`.
4. **Regression**: `POST /submit { }` (no `force`) on a `state='starting'` fresh session — gate path still runs; with new defaults this resolves either via Fix 3 dispatch-on-timeout (200) or via 504 if hard-fail. Captured in §4.3.
5. **Smoke**: `telepty send-key <id> enter` against a fresh `claude` session in the live E2E — succeeds without manual workaround.

### 4.2 Fix 2 — threshold relaxation (unit)

In `test/submit-gate.test.js`:

6. `awaitReplReady` with default opts (no `minConfidence` passed), session `{state:'idle', confidence: 0.6}` → resolves immediately `ready:true`. **This is the pre-fix failure case.**
7. With explicit `minConfidence: 0.85`, session `{state:'idle', confidence: 0.6}` → respects override, falls through to timeout. (Verifies the override still works.)
8. With `minConfidence: 0.5` (new default), session `{state:'idle', confidence: 0.5}` → ready (boundary inclusive, since `isReady` checks `< minConfidence` strictly).
9. With `minConfidence: 0.5`, session `{state:'idle', confidence: 0.49}` → not ready, falls through to timeout.
10. **Update existing test** at submit-gate.test.js:185-193 per §3.2 above.

In `test/daemon.test.js`:

11. `POST /submit { min_confidence: 0.95 }` on a session that just hit IDLE with conf=0.9 (prompt-match) → 504 (per-request stricter override). Validates clamp + pass-through.
12. `POST /submit { min_confidence: -1 }` (invalid) → clamped to 0, no error. Validates clamp.
13. `POST /submit { min_confidence: 2 }` (invalid) → clamped to 1, gate effectively never passes for non-1.0 confidence — expect 504. Validates clamp.

### 4.3 Fix 3 — timeout extension + dispatch-on-timeout

In `test/submit-gate.test.js` — `awaitReplReady` defaults are tested at the submit-gate module layer; daemon integration covers the dispatch-on-timeout branch.

In `test/daemon.test.js`:

14. **Pre-existing regression check**: `POST /submit { injected_body: 'X' }` on a session that goes IDLE (conf=0.95) within 200 ms → 200, `attempts:1`, `gate_wait_ms <= 250`, no `gated_dispatch_after_timeout`. (Warm-session happy path unchanged.)
15. **Dispatch-on-timeout success**: `POST /submit { injected_body: 'X', gate_timeout_ms: 100 }` against a session that never reaches IDLE; mock outputRing such that `verifyBodyConsumed` returns `consumed:true` (body never visible OR cleared) → 200, `gated_dispatch_after_timeout:true`, `attempts >= 1`.
16. **Dispatch-on-timeout honest fail**: same setup, but outputRing keeps body visible past `verify_timeout_ms` → 504 with `reason:'gated_dispatch_unconsumed'`.
17. **Hard-fail short-circuit**: session in `state='dead'` → `awaitReplReady` returns `reason:'session_dead'` (not `'timeout'`) → 504 immediately, no dispatch attempted (the hard-fail branch in §3.3).
18. **Bare Enter (no injected_body) on timeout**: `POST /submit { force: false, gate_timeout_ms: 50 }` empty body → dispatches anyway, returns 200 with `gated_dispatch_after_timeout:true`, no `verify` field.
19. **Default timeout verification**: `POST /submit { }` on warm session — `gate_wait_ms` should be `< 200`; `gate_timeout_ms` default of 10000 confirmed by reading response shape (a 504 timeout case in test should report `gate_wait_ms ≈ 10000`).

### 4.4 E2E reliability harness (test/e2e-submit.manual.js — extend)

Already-opt-in (`TELEPTY_E2E=1`). Extend the harness from δ Phase 1 spec §4.3:

20. **100× spawn-and-inject on fresh `claude`** — same harness; pass criterion ≥99/100 maintained or improved.
21. **100× send-key on fresh `claude`** (NEW): `telepty allow --id e2e-claude-NN claude` then immediately `telepty send-key e2e-claude-NN enter`. Pass ≥99/100. **Currently 0/100 by orchestrator's evidence.**

### 4.5 Regression coverage

22. All 23 existing `test/submit-gate.test.js` tests pass — except test at line 185 (semantically preserved, literals updated per §3.2).
23. All daemon tests pass unchanged.
24. `inject --ref` (without `--submit`) — unchanged daemon path (`deliverInjectionToSession`), unchanged tests.
25. `TELEPTY_SUBMIT_GATE=off` legacy escape hatch — preserved verbatim.
26. Aterm sessions — `terminalLevelSubmit` already short-circuits via `session.type === 'aterm'` guards; aterm path is skipped (existing test `test/daemon.test.js:135` covers).

---

## 5. Failed approaches (must NOT propose)

| Anti-approach | Why rejected |
|---|---|
| Set `TELEPTY_SUBMIT_GATE=off` as default | Defeats the purpose of the gate; reverts to 0.2.x's open-loop blind retry. Memory `feedback_telepty_send_key_regression.md` lines 21-22 — the env var is a parity-test escape hatch only. |
| Remove the gate entirely from `/submit` | Regression of 0.3.0; predecessor spec §4.3 reliability target (≥99% on warm sessions) would rely on dispatch-on-timeout alone — weaker than gate-then-dispatch. |
| Add a new external dependency (e.g. `osc-detect`, `tty-cursor`) | Violates Rule 17 (무의존). All required primitives exist in `src/submit-gate.js` + `session-state.js` + `daemon.js`. |
| Lower `idle_timeout_ms` from 5000 to e.g. 1500 in `session-state.js` | Out of scope — that is a state-machine tuning, not a gate fix. Would over-fire IDLE on long-running working sessions. Memory `feedback_evidence_based_bugfix.md` — no evidence supports this change. |
| Detect claude TUI specifically (regex on banner / Ink markers) | Couples gate to a specific CLI's UI string. Fragile; breaks across claude versions; violates Rule 26 (cross-OS / cross-CLI). |
| Move gate to CLI side (have `cli.js` poll state before POST) | Couples CLI to in-process daemon state and breaks remote injects (`crossMachine.remoteInject`). Predecessor spec §5 already rejected this. |
| "Just ship a 30 s default timeout" | Inflates latency floor on warm-session fan-out without addressing root cause (threshold + dispatch-on-timeout). |
| Per-CLI threshold table | YAGNI — current state machine emits same {0.95, 0.9, 0.6} for every CLI. The CLI-specific axis is *prompt-pattern matchability*, not confidence; the right fix lives in the threshold, not a table. |
| Bundle unrelated fixes (e.g. enforce-report tweaks) into this commit | δ Phase 2's hygiene issue per the task brief. Memory `feedback_git_explicit_paths.md` — explicit-path staging only. |

---

## 6. Constitution check

| Rule | Compliance |
|---|---|
| **Rule 1 — 경량** | ✅ All three fixes are parameter additions and a single branch insertion. ~50 net LOC including tests. No new helper modules; reuses `awaitReplReady`/`verifyBodyConsumed`/`terminalLevelSubmit`. |
| **Rule 5 — 최선 (best-first)** | ✅ Restores send-key as a true manual override (no workaround); identifies the actual confidence gap (state-machine evidence cited verbatim); replaces the 0.3.0 strict-fail with best-effort dispatch + honest verification. |
| **Rule 13 — 비판적+건설적+객관적** | ✅ Anti-approaches enumerated with reasons. Recommendations cite line numbers + evidence, not assertion. Decision matrices show losing options. |
| **Rule 17 — 무의존** | ✅ Zero new external dependencies. All edits within `src/submit-gate.js`, `daemon.js`, `cli.js`, existing test files. |
| **Rule 26 — cross-OS** | ✅ No new per-OS branches. The fixes are pure JS reading in-memory state. The OS-specific shell-outs (`kitty`, `cmux`, `osascript`) are unchanged — only the *gate parameters* and the *dispatch-on-timeout* branch are new. |
| **Constitution Rule 1 (AI gap)** | ✅ Closes the orchestrator UX trap that wastes parallel-fanout latency budget AND breaks the manual-override fallback. |

---

## 7. Invariants (what MUST NOT change vs δ Phase 2 spec)

- ✅ **Default behaviour of `inject --submit` on already-warm sessions**: gate short-circuits at conf≥0.85 (still passes after threshold drop to 0.5). `gate_wait_ms` remains <250 ms in the warm path. ≥99% reliability target preserved.
- ✅ **504 still emitted in true-fail case**: when `verifyBodyConsumed` returns `consumed:false` after best-effort dispatch on timeout, response is 504 with `reason:'gated_dispatch_unconsumed'` (new) — the old `reason:'gate_timeout'` is replaced. 504 is preserved as a status code; consumers checking for "any 504" continue to work.
- ✅ **`TELEPTY_SUBMIT_GATE=off` escape hatch**: preserved verbatim (`daemon.js:1511, 1529-1550` block unchanged).
- ✅ **Bus event `submit` shape**: existing fields (`strategy`, `attempts`, `gated`, `gate_wait_ms`, `verify`) preserved. New optional fields `forced`, `gated_dispatch_after_timeout` are additive.
- ✅ **HTTP 503 (dispatch-failure)**: preserved when all strategies (kitty/cmux/pty) return null.
- ✅ **HTTP 200 success shape**: existing fields preserved. `forced:true` and `gated_dispatch_after_timeout:true` are additive optional fields.
- ✅ **23 existing unit tests in `test/submit-gate.test.js`**: 22 pass unchanged. **1 changes**: test at line 185-193 must be updated per §3.2 — its semantic is preserved (threshold-rejects-low-confidence) but literals shift to avoid colliding with the new default.
- ✅ **Aterm sessions**: unaffected (gate path is bypassed via `session.type === 'aterm'` guards in `terminalLevelSubmit`).
- ✅ **Cross-machine remote inject**: `crossMachine.remoteInject` path unchanged; only local-daemon `/submit` callers affected.

---

## 8. Implementation estimate

**LOC (net add):**

| Fix | daemon.js | cli.js | src/submit-gate.js | tests | Total |
|---|---|---|---|---|---|
| 1 (send-key bypass) | +14 | +5 | 0 | +30 (3 new) | +49 |
| 2 (threshold relax) | +5 | 0 | -1 / +1 | +25 (4 new + 1 update) | +30 |
| 3 (timeout + dispatch) | +35 (mostly rewriting an existing block) | +4 | 0 | +60 (6 new) | +99 |
| **Total** | **~50 net** | **~9 net** | **~1 net** | **~115** | **~175 LOC** |

**Wall budget for Phase 2 implementation:** ≤ 4 h (matches δ Phase 1 spec §11). Within sub-budgets:

- Code edits: ~45 min
- Test scaffolding + new tests: ~90 min
- Local smoke (`npm test`, manual claude spawn × 5): ~30 min
- E2E §4.4 #21 (100× send-key on fresh claude): ~30 min if feasible locally; otherwise gated under TELEPTY_E2E=1

**Risk surface:** confined to `src/submit-gate.js` (1-line default change + 1 clamp) and `daemon.js:1497-1624` (one branch + one block rewrite). No state-machine changes. No bus-schema changes. CLI changes are body-field additions in two call sites.

---

## 9. Out of scope

- **Claude TUI ready detection via screen content**: Detecting claude's specific input box (`│ > │`) via screen scraping to short-circuit the silence-fallback. Speculative; better solved by lowering threshold (Fix 2). Separate spec if ever needed.
- **Daemon refactor `/submit` vs `/key` architectural debate beyond Fix 1**: We chose A (force flag); B (new endpoint) is rejected for this iteration. Re-litigation belongs in a follow-up if A proves insufficient.
- **Tuning `idle_timeout_ms` (currently 5000) in `session-state.js`**: Affects all state-machine consumers, not just submit. Out of scope.
- **Per-CLI confidence tables in `session-state.js`**: Same — state-machine concern.
- **Adding OSC 133 emission to claude/codex/gemini**: Requires upstream changes; not telepty's domain.
- **REPORT enforcement (`specs/enforce-report-spec.md`)**: orthogonal — that spec governs post-idle behaviour after inject succeeds; we handle whether inject submitted at all.

---

## 10. Semver impact

**Recommendation: PATCH bump 0.3.0 → 0.3.1.**

Rationale:

1. **Fix 1 (`force` body field)**: additive opt-in body parameter. Existing callers (omitting `force`) see unchanged behaviour. CLI's send-key client is the only caller flipping the new flag. Non-breaking.
2. **Fix 2 (threshold default 0.85 → 0.5)**: a relaxation. Sessions that previously failed gate now pass; sessions that previously passed still pass. No new failure modes. Per-request `min_confidence` override preserves strict-mode availability for callers who need it. Non-breaking.
3. **Fix 3 (timeout 5000 → 10000 + dispatch-on-timeout)**: latency ceiling extension is conservative (warm sessions short-circuit; only cold sessions pay). Dispatch-on-timeout converts some 504s into 200s — strictly a relaxation of failure semantics. New optional fields (`gated_dispatch_after_timeout`) are additive. The 504 status code surface itself is preserved; only the trigger conditions narrow.
4. **No new HTTP endpoints, no removed fields, no schema changes.**
5. **All three fixes are bug fixes against regressions introduced in 0.3.0** — patch is the conventional vehicle.

**Alternative considered: MINOR (0.3.0 → 0.4.0).** The rationale would be: visibility of new optional fields and the threshold semantic shift. Rejected because (a) consumers tolerate unknown fields per JSON convention; (b) the threshold change is a behaviour fix in service of the stated 0.3.0 goal, not a new feature; (c) δ Phase 2's CHANGELOG positioned 0.3.0 specifically as "render-gated submit reliability" — a follow-up patch is more honest than a minor that implies new capability.

If the orchestrator prefers the conservative MINOR for visibility reasons, the impl is identical — only the version literal in `package.json` changes.

---

## 11. Phase 2 entry criteria

- Orchestrator approves:
  1. Fix 1 approach: **A** (force body param)
  2. Fix 2 approach: **(i)** lower default to 0.5
  3. Fix 3 approach: **D₁** dispatch + verify on timeout, default `gate_timeout_ms=10000`
  4. Semver: **PATCH 0.3.1**
- Phase 2 implementation budget ≤ 4 h wall, ≤ 175 net LOC.
- Phase 2 success: all assertions in §4 pass, no regression on `inject --ref` (no-submit), `inject --submit` warm path, or aterm paths.
- Stage with explicit paths only (memory `feedback_git_explicit_paths.md`); commit message follows δ Phase 1 commit pattern (`fix(submit): …`).

---

## 12. Open questions (for Phase 2 input — non-blocking)

1. **Should `cli.js`'s `send-key` ALSO accept an optional `--gate` flag** to opt back into gating (e.g. `telepty send-key <id> enter --gate`)? Recommendation: not in this spec. YAGNI; if a caller wants gating, they should use `inject --submit` semantics. Revisit only if a use case appears.
2. **Should the bus event distinguish `gated_dispatch_after_timeout` vs `forced:true` consumers**? Today both produce a `submit` event; only the new optional flags differ. Recommendation: ship as-is; downstream listeners can inspect the flags.
3. **Should `gate_wait_ms` upper-bound be raised in the bus emission for telemetry**? Currently uncapped in event but capped at `gateTimeoutMs` (10 s default). Recommendation: leave as-is; the cap is implicit in the dispatch-on-timeout path.
