---
status: draft
date: 2026-04-26
topic: prompt-symbol-render-gate
predecessors:
  - docs/superpowers/specs/2026-04-26-inject-submit-enter-reliability.md (δ Phase 1+2, telepty 0.3.0 commit 0c66d87)
  - docs/superpowers/specs/2026-04-26-submit-gate-fixes-v2.md (δ-fix-2/3/4 cluster, telepty 0.3.1 commit 4ba07d9)
fix: δ-fix-5 (Layer 3 root — prompt symbol render gate)
constitution_rules: [Rule 1 경량, Rule 5 최선, Rule 13 비판적+건설적+객관적, Rule 17 무의존, Rule 26 cross-OS]
---

# SPEC: prompt-symbol-render-gate — δ-fix-5

**Date:** 2026-04-26
**Author:** aigentry-telepty-coder
**Status:** SPEC — Phase 1, awaiting orchestrator approval
**Track:** orchestrator UX recurring trap — δ-fix-5 (fundamental — prompt symbol render gate, the unfixed Layer 3)
**Authority:** orchestrator's root-cause analysis 2026-04-26 (3-layer breakdown)
**Predecessors:**
- `docs/superpowers/specs/2026-04-26-inject-submit-enter-reliability.md` — δ Phase 1+2, render-gated submit (telepty 0.3.0, commit `0c66d87`)
- `docs/superpowers/specs/2026-04-26-submit-gate-fixes-v2.md` — δ-fix-2/3/4 cluster (telepty 0.3.1, commit `4ba07d9`)

---

## 0. Problem statement

After 0.3.0 (render-gated submit) and 0.3.1 (regression cluster — send-key bypass + threshold relax + dispatch-on-timeout), the orchestrator still observes Enter-not-applied incidents on freshly-spawned `claude` and `codex` REPLs. Live evidence captured 2026-04-26 from `cmux read-screen` of workspace:22 (`aigentry-devkit-impl-b-codex`) — verbatim:

> "telepty injected the context successfully, but returned a submit gated-timeout warning, so manual Enter may be needed on the orchestrator side."

The 0.3.1 fix bundle reduced the failure rate but **the gate's signal source — `sessionStateManager` — is heuristic, not deterministic**. The state machine reports `idle` based on (a) OSC 133;A/B marks (claude/codex/gemini emit none — confirmed by `OSC_133_RE` never firing in `session-state.js:194-204`), (b) `PROMPT_PATTERNS` regex match against the last raw output line (claude's Unicode-box input UI does not match — `❯` is followed by spaces, not end-of-line), or (c) silence-fallback after `idle_timeout_ms` (5 s) with confidence 0.6 (`session-state.js:378-380`).

For the dominant case (claude/codex/gemini fresh spawn), the state machine falls into the silence-fallback bucket. After 0.3.1, that bucket *passes* the gate (threshold lowered to 0.5), but the gate now lies: **"silence ≠ ready to accept Enter"**. A session can be silent because it is rendering a model-select dialog, a trust-this-folder prompt, or paint-only redraw frames — none of which accept a body Enter on the input line.

**True ready-state requires direct observation of the prompt symbol** (`❯` for claude, `›` for codex, gemini's box-drawn input area for gemini). When the prompt symbol is rendered at a stable screen position and the cursor is parked there, the REPL is — by terminal-rendered evidence — actually ready.

---

## 1. Root cause analysis (3-layer Layer 3 framing)

### 1.1 Layer 1 (current 0.3.1 fix)

`src/submit-gate.js` gates submission on `sessionStateManager.getState(id).state ∈ {idle, waiting}` with `confidence ≥ 0.5`. Plus dispatch-on-timeout best-effort. **Heuristic.** Helps but does not see the screen.

### 1.2 Layer 2 (operational workaround)

Orchestrator policy: wait 6+ s after `telepty allow ... claude` before any inject; use `telepty send-key` (now `force:true` per 0.3.1) as the last-resort. **Timing-dependent.** Memory `feedback_inject_enter.md` records the workaround. Works because 6 s exceeds the ~3–6 s claude ready window with margin, but it (a) regresses parallel-fanout latency and (b) breaks down when claude takes >6 s on a cold cache or trust-dialog path.

### 1.3 Layer 3 (true root, this spec)

Claude Code, Codex CLI, and Gemini CLI expose **no programmatic ready signal** to external automation:

- No OSC 133 emission (verified: grep for `\x1b]133;` returns 0 hits in claude-code's Ink renderer; codex Rust TUI does not emit it; gemini does not emit it).
- No exit-on-prompt mode applicable to long-running TUIs.
- No file/socket signal.

Therefore the only deterministic, observable readiness is the **rendered terminal state**. The most reliable observable is the per-CLI prompt symbol: when stably rendered for ≥ N ms with the cursor parked at it, the REPL is ready. This requires reading the *rendered screen* (post-ANSI-state), not the raw delta byte stream.

### 1.4 Why current `outputRing` cannot solve this

`outputRing` (`daemon.js:731-737`, `daemon.js:1916`) accumulates **raw byte deltas** as the PTY emits them — including ANSI cursor moves, color toggles, and partial re-paint frames. It is a stream-of-changes log, not a terminal screen state.

**Empirical evidence (2026-04-26 capture, 5 live sessions):** counted UTF-8 occurrences of `❯`/`›`/`»` in the last 200 lines of `outputRing` via `GET /api/sessions/:id/screen?raw=1`:

| Session | command | bytes | `❯` | `›` | `»` | tail (cleaned) |
|---|---|---:|---:|---:|---:|---|
| `aigentry-orchestrator` | claude | 1687 | 0 | 0 | 0 | `(thinking with xhigh effort)` repeats |
| `Q1-builder-instrument` | claude | 16 | 0 | 0 | 0 | (single redraw fragment) |
| `Q1-architect-redesign` | claude | 16 | 0 | 0 | 0 | (single redraw fragment) |
| `Q1-codex-reviewer` | codex | 0 | 0 | 0 | 0 | (empty — outputRing flushed by aterm-style guards) |
| `Q1-gemini-reviewer` | gemini | 264 | 0 | 0 | 0 | (OSC 11 background-color queries only) |

**Zero literal prompt symbols in any outputRing.** The TUI renders the prompt by cursor positioning + character emission — but only on *change*. A parked prompt at rest produces no further bytes; the symbol exists only in the terminal emulator's screen-state buffer, not in the byte history.

### 1.5 Why `cmux read-screen` solves it

`cmux read-screen --workspace <id> --lines <n>` (verified 2026-04-26 from `cmux --help` and direct invocation) returns the **rendered terminal text** — the result of applying all ANSI sequences to the screen-state buffer. Live capture from `cmux read-screen --workspace workspace:9 --lines 30` (Q1-architect-redesign, claude, idle):

```
─────────────────...─────  ← horizontal-rule border
❯                          ← THE PROMPT SYMBOL (rendered, U+276F at column 1)
─────────────────...─────  ← horizontal-rule border
  aigentry-architect | Opus 4.7 (1M context) | [█░░░░░░░░░░░░░░] 11% 113.4K/1.0M
  ⏵⏵ bypass permissions on (shift+tab to cycle)         new task? /clear to save 113.5k tokens
```

Live capture from `cmux read-screen --workspace workspace:22 --lines 50` (impl-b, codex, idle):

```
 › Explain this codebase    ← THE PROMPT SYMBOL (rendered, U+203A at column 2)

  gpt-5.5 xhigh fast · ~/projects/aigentry-devkit
```

**Conclusion:** prompt-symbol detection is implementable today via `cmux read-screen` for any session with `session.backend === 'cmux' && session.cmuxWorkspaceId` (the dominant case in this codebase — every aigentry session). For non-cmux backends (kitty-only, daemon-PTY-only, aterm), no rendered-screen primitive is available; the new gate must skip cleanly and fall back to the existing 0.3.1 layer.

### 1.6 Existing telepty primitives we can reuse (Rule 17)

- `submitViaCmux` (`daemon.js:1459-1473`) — established `execSync('cmux send-key …')` shellout pattern with 5 s timeout and piped stdio. **The new screen-read uses the same pattern.**
- `src/submit-gate.js` — `awaitReplReady` and `verifyBodyConsumed` are already self-contained pure helpers. New `awaitPromptSymbol` follows the same shape (Promise, bounded timeout, structured `{ ready, last_state, waited_ms, reason? }` result).
- `session.command` (`sessions[id].command`, set at allow time) — the per-CLI key the registry maps from.
- `TELEPTY_SUBMIT_GATE=off` env-var escape hatch (`daemon.js:1520`) — extended to disable both layers.
- `force` request body field (`daemon.js:1518`) — extended to bypass both layers.

**Zero new external dependencies.**

---

## 2. Goal

Add a **prompt-symbol render gate** to telepty's `/submit` pipeline, layered ABOVE the existing 0.3.1 `sessionStateManager` gate. The new gate:

1. Looks up the per-CLI prompt symbol via a small registry.
2. Polls the rendered terminal screen via `cmux read-screen` (cmux backend only).
3. Confirms the prompt symbol is stably rendered on the most recent input-row for ≥ N ms.
4. Then yields to the existing 0.3.1 gate, which yields to dispatch.

If the new gate cannot apply (non-cmux backend, unknown CLI, cmux read-screen unavailable), it skips with a structured `reason` and the request proceeds to the existing 0.3.1 layer unchanged. **Strictly additive — never makes the 0.3.1 path worse.**

---

## 3. Per-CLI prompt-symbol catalog

All entries verified 2026-04-26 against live `cmux read-screen` output and the binary byte sequence printed by `printf '%s\n' "❯" "›" "»"  | xxd` (raw output: `e29d af0a e280 ba0a c2bb 0a`).

| CLI | Symbol | Codepoint | UTF-8 bytes | Screen position (idle) | Detection regex |
|---|---|---|---|---|---|
| `claude` | `❯` | U+276F | `E2 9D AF` | column 1, line below the lower of two `─` (U+2500) horizontal-rule borders that bracket the input row | `^❯ +$` (line is `❯` + spaces only when input is empty) |
| `codex` | `›` | U+203A | `E2 80 BA` | column 2 (one leading space), followed by space + ghost-placeholder text | `^ › ` (line starts with space-symbol-space) |
| `gemini` | `*` (with placeholder text) | U+002A | `2A` | inside a `▀…▄` (U+2580 / U+2584) box border, line `^ \* +Type your message` when empty, `^ \* +<text>` otherwise | `^ \* +(?:Type your message\|.+)$` between `▀…` and `▄…` border lines |

**Disambiguation note (history echo):** `❯` and `›` also appear in screen HISTORY for both claude and codex when the orchestrator has previously injected `> TASK_COMPLETE…`-style report bodies (echoed back in transcript). The detection algorithm therefore must **anchor on the LAST occurrence** (closest to the bottom of the rendered viewport) AND verify the line geometry — for claude, the symbol must be sandwiched between two `─` border lines; for codex, the symbol must be on or just above the status footer line (`gpt-5.5 …`).

**Cross-CLI fallback:** unknown CLI → registry lookup returns `null` → gate skips with `reason: 'unknown_cli'` → 0.3.1 layer proceeds unchanged. No false positives possible from a missing registry entry.

---

## 4. Gate algorithm

```
awaitPromptSymbol(session, opts) → Promise<{ ready, last_seen_at, waited_ms, reason? }>

1. If session.backend !== 'cmux' || !session.cmuxWorkspaceId
     → resolve { ready: false, reason: 'no_screen_primitive' }   // skip, not fail

2. const entry = promptSymbolRegistry.lookup(session.command)
   If !entry
     → resolve { ready: false, reason: 'unknown_cli' }            // skip, not fail

3. let lastSeenAt = null
   start = Date.now()
   loop every opts.poll_interval_ms (default 150 ms):
     a. screen = execCmuxReadScreen(session.cmuxWorkspaceId, opts.tail_lines /*default 30*/)
        // execSync wrapper — 1 s timeout, stdio piped, stdout = string. On error
        // (cmux missing, workspace closed, permission denied) → return ''
     b. If screen === '' → continue (transient)
     c. match = entry.detect(screen)
        // returns { found: bool, line_index: int, col: int }
     d. If !match.found
          lastSeenAt = null     // reset stability streak
          continue
     e. If lastSeenAt === null
          lastSeenAt = Date.now()
          continue              // first sighting — start the stability window
     f. If Date.now() - lastSeenAt >= opts.stability_ms (default 200 ms)
          return { ready: true, last_seen_at: lastSeenAt, waited_ms: Date.now() - start }

4. Timeout (Date.now() - start > opts.timeout_ms, default 8000 ms):
     → resolve { ready: false, reason: 'no_prompt_symbol_seen', waited_ms: ... }
```

**Why stability check (step 3.f) and not single sighting?** TUIs flicker the symbol during welcome-banner render (drawn, immediately overwritten). A 200 ms stable window confirms the symbol survived the next paint cycle. Empirically, claude's stable-prompt phase begins ~2 s after the symbol's first appearance; 200 ms is comfortable margin without padding latency.

**Why 8 s default timeout (longer than 0.3.1's 10 s gate)?** The new gate runs *before* the 0.3.1 gate. They share the same wall budget: 8 s for prompt-symbol + 2 s headroom for 0.3.1 sessionStateManager check + dispatch + verify ≤ 10 s total request budget. If the prompt symbol never renders within 8 s, the 0.3.1 dispatch-on-timeout path inherits the remaining budget and still attempts dispatch (preserves 0.3.1's strictly-additive guarantee).

---

## 5. Integration with 0.3.1 gate

**Layered, sequential, strictly additive:**

```
POST /submit
  → if force:true → bypass BOTH gates (unchanged 0.3.1 behavior)
  → if TELEPTY_SUBMIT_GATE=off → bypass BOTH gates (unchanged 0.3.1 behavior)
  → Layer 3 (NEW): awaitPromptSymbol(session, opts)
       ├─ ready:true  → proceed
       ├─ ready:false, reason in {'no_screen_primitive','unknown_cli'} → skip, proceed
       └─ ready:false, reason='no_prompt_symbol_seen' → log warning, proceed (best-effort)
                                                       // do NOT 504 here
  → Layer 1 (0.3.1): submitGate.awaitReplReady(id, sessionStateManager, ...)
  → terminalLevelSubmit (kitty → cmux → PTY chain)
  → submitGate.verifyBodyConsumed (when injected_body provided)
  → response
```

**Failure mode `no_prompt_symbol_seen` does NOT 504.** Rationale:

- The 0.3.1 layer's `gated_dispatch_after_timeout` semantics already cover "we tried best-effort and the body is/isn't consumed". Returning 504 from Layer 3 alone would regress to the strict-fail behavior that 0.3.1 explicitly removed.
- Instead, the response surfaces a new optional flag `prompt_symbol: { found: false, reason: 'no_prompt_symbol_seen', waited_ms: <n> }` for telemetry. The existing 0.3.1 outcome (success / 504 with `gated_dispatch_unconsumed`) is unchanged.
- This matches predecessor-spec §1.5's "best-effort" doctrine (`docs/superpowers/specs/2026-04-26-submit-gate-fixes-v2.md` §2.3 D₁).

**Hard-fail path (preserved from 0.3.1):** if `awaitReplReady` returns `reason ∈ {session_dead, session_error, session_restarting, no_state, no_state_manager}`, still 504 immediately — no point dispatching to a dead PTY.

**Escape hatches preserved:**

| Escape hatch | Effect |
|---|---|
| `POST /submit { force: true }` | Bypass Layer 3 + Layer 1, single dispatch, same 0.3.1 contract |
| `process.env.TELEPTY_SUBMIT_GATE === 'off'` | Bypass Layer 3 + Layer 1, legacy 0.2.x blind retry |
| `POST /submit { prompt_symbol_gate: false }` (NEW) | Per-request bypass of Layer 3 only; Layer 1 still applies. For callers that want 0.3.1 semantics exactly. |

---

## 6. Per-CLI customization

### 6.1 New file: `src/prompt-symbol-registry.js` (~50 LOC)

```js
'use strict';

// Per-CLI prompt-symbol detection. Maps session.command (e.g. 'claude',
// 'codex', 'gemini') to a {symbol, byteSeq, detect(screen)→match} entry.
//
// The detect() function takes the rendered screen text from `cmux read-screen`
// (already terminal-state-applied; no ANSI stripping needed) and returns
// { found: bool, line_index: int, col: int } anchored on the LAST occurrence
// from the bottom (history-echo disambiguation — see spec §3).
//
// Adding a new CLI: append a new entry + write a unit test against a captured
// `cmux read-screen` sample under test/fixtures/prompt-screens/<cli>.txt.

const ENTRIES = {
  claude: {
    symbol: '❯',
    byteSeq: Buffer.from([0xE2, 0x9D, 0xAF]),
    // claude renders an empty input row as "❯" + N spaces, sandwiched between
    // two horizontal-rule lines made of U+2500 ('─').
    detect(screen) {
      const lines = screen.split('\n');
      for (let i = lines.length - 1; i >= 1; i--) {
        const line = lines[i];
        if (/^❯ *$/.test(line.trimEnd() === '❯' ? '❯' : line)) {
          // Geometry sanity: line above OR below contains box-drawing.
          const above = lines[i - 1] || '';
          const below = lines[i + 1] || '';
          if (above.includes('─') || below.includes('─')) {
            return { found: true, line_index: i, col: line.indexOf('❯') + 1 };
          }
        }
      }
      return { found: false };
    },
  },
  codex: {
    symbol: '›',
    byteSeq: Buffer.from([0xE2, 0x80, 0xBA]),
    detect(screen) {
      const lines = screen.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        // codex renders idle as " › <placeholder>" (column 2). Status footer
        // ("gpt-5.5 …" or "gpt-5 …") sits 1–2 lines below.
        if (/^ › /.test(line)) {
          const footer = (lines[i + 1] || '') + (lines[i + 2] || '');
          if (/gpt-\d/.test(footer)) {
            return { found: true, line_index: i, col: 2 };
          }
        }
      }
      return { found: false };
    },
  },
  gemini: {
    symbol: '*',
    byteSeq: Buffer.from([0x2A]),
    detect(screen) {
      const lines = screen.split('\n');
      for (let i = lines.length - 1; i >= 1; i--) {
        const line = lines[i];
        // gemini empty input: " *   Type your message or @path/to/file"
        // gemini non-empty: " *   <user typed text>"
        // Geometry: bracketed by U+2580 ('▀') above and U+2584 ('▄') below.
        if (/^ \* {2,}/.test(line)) {
          const above = lines[i - 1] || '';
          const below = lines[i + 1] || '';
          if (above.includes('▀') || below.includes('▄')) {
            return { found: true, line_index: i, col: 2 };
          }
        }
      }
      return { found: false };
    },
  },
};

function lookup(command) {
  if (!command) return null;
  // Normalize: strip path and args (`/usr/local/bin/claude --resume` → `claude`).
  const base = String(command).split(/[\s/]/).filter(Boolean).pop() || '';
  return ENTRIES[base.toLowerCase()] || null;
}

module.exports = { lookup, ENTRIES };
```

### 6.2 New helper in `src/submit-gate.js` (~50 LOC, additive)

```js
async function awaitPromptSymbol(session, opts = {}) {
  const timeoutMs       = Number.isFinite(opts.timeoutMs)     ? opts.timeoutMs     : 8000;
  const pollIntervalMs  = Number.isFinite(opts.pollIntervalMs) ? opts.pollIntervalMs : 150;
  const stabilityMs     = Number.isFinite(opts.stabilityMs)   ? opts.stabilityMs   : 200;
  const tailLines       = Number.isFinite(opts.tailLines)     ? opts.tailLines     : 30;
  const readScreen      = typeof opts.readScreen === 'function' ? opts.readScreen : defaultReadScreen;
  const registry        = opts.registry || require('./prompt-symbol-registry');
  const now             = typeof opts.now   === 'function' ? opts.now   : () => Date.now();
  const sleep           = typeof opts.sleep === 'function' ? opts.sleep : (ms) => new Promise(r => setTimeout(r, ms));

  if (!session || session.backend !== 'cmux' || !session.cmuxWorkspaceId) {
    return { ready: false, reason: 'no_screen_primitive', waited_ms: 0 };
  }
  const entry = registry.lookup(session.command);
  if (!entry) {
    return { ready: false, reason: 'unknown_cli', waited_ms: 0 };
  }

  const start = now();
  let lastSeenAt = null;
  while (true) {
    const screen = readScreen(session.cmuxWorkspaceId, tailLines);
    if (screen) {
      const match = entry.detect(screen);
      if (match.found) {
        if (lastSeenAt === null) lastSeenAt = now();
        else if (now() - lastSeenAt >= stabilityMs) {
          return { ready: true, last_seen_at: lastSeenAt, waited_ms: now() - start };
        }
      } else {
        lastSeenAt = null;
      }
    }
    if (now() - start >= timeoutMs) {
      return { ready: false, reason: 'no_prompt_symbol_seen', waited_ms: now() - start };
    }
    await sleep(pollIntervalMs);
  }
}

function defaultReadScreen(workspaceId, lines) {
  const { execSync } = require('child_process');
  try {
    const out = execSync(
      `cmux read-screen --workspace ${workspaceId} --lines ${lines}`,
      { timeout: 1000, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 20 }
    );
    return out.toString('utf8');
  } catch (_err) {
    return '';
  }
}
```

### 6.3 Wire-up in `daemon.js` POST /submit (~10 LOC)

Insert immediately after the `force` short-circuit block (`daemon.js:1554`) and before the `gateOff` block:

```js
const promptSymbolGate = req.body?.prompt_symbol_gate !== false;   // default ON
let promptSymbol = null;
if (promptSymbolGate && !gateOff) {
  promptSymbol = await submitGate.awaitPromptSymbol(session, {
    timeoutMs: Math.min(Math.max(Number(req.body?.prompt_symbol_timeout_ms) || 8000, 500), 30000),
  });
  if (promptSymbol.reason && !['no_screen_primitive', 'unknown_cli', 'no_prompt_symbol_seen'].includes(promptSymbol.reason)) {
    // Defensive — shouldn't happen, but log if a future reason is added without callsite update.
    console.log(`[SUBMIT] prompt-symbol gate unexpected reason: ${promptSymbol.reason}`);
  }
  if (promptSymbol.reason === 'no_prompt_symbol_seen') {
    console.log(`[SUBMIT] prompt-symbol gate timeout for ${id} after ${promptSymbol.waited_ms}ms — proceeding to Layer 1`);
  }
}
```

Then thread `promptSymbol` into the success and failure response bodies as an optional field (additive — clients ignore unknown JSON keys).

---

## 7. Test plan

All new tests use `node:test` (existing harness, no new dev deps). Memory `feedback_inject_enter.md` applies — every assertion grounded in primitives we can cite.

### 7.1 Unit — `src/prompt-symbol-registry.js`

In `test/prompt-symbol-registry.test.js` (new file):

1. `lookup('claude')` → returns claude entry; `lookup('/usr/local/bin/claude --resume')` → returns claude entry (path-normalize); `lookup('unknown')` → `null`.
2. claude `detect(<idle fixture>)` → `found:true, col:1`; `detect(<welcome-banner fixture>)` → `found:false` (no border geometry).
3. codex `detect(<idle fixture>)` → `found:true, col:2`; `detect(<no-footer fixture>)` → `found:false`.
4. gemini `detect(<empty-input fixture>)` → `found:true`; `detect(<midconvo fixture>)` → `found:true`; `detect(<no-border fixture>)` → `found:false`.
5. **History-echo disambiguation:** claude fixture containing `❯ TASK_COMPLETE: ...` in the transcript AND a separate empty `❯` prompt at the bottom → `detect()` returns the BOTTOM occurrence (line_index higher).
6. Empty screen `detect('')` → `found:false` for all CLIs.

Fixtures stored under `test/fixtures/prompt-screens/{claude,codex,gemini}-{idle,banner,welcome,midconvo}.txt` — captured 2026-04-26 from `cmux read-screen` of live workspaces (workspace:9 claude, workspace:22 codex, workspace:11 gemini).

### 7.2 Unit — `awaitPromptSymbol` (in `test/submit-gate.test.js`)

7. `session.backend !== 'cmux'` → resolves `{ready:false, reason:'no_screen_primitive', waited_ms:0}` immediately.
8. `session.command` unknown → resolves `{ready:false, reason:'unknown_cli', waited_ms:0}` immediately.
9. Stable claude screen on first poll → resolves `{ready:true}` after `stabilityMs` (200 ms).
10. Symbol appears at poll 2 then disappears at poll 3 → stability streak resets; eventually times out.
11. `readScreen` injected mock returns `''` consistently (cmux unavailable) → times out with `no_prompt_symbol_seen`.
12. `readScreen` throws inside `defaultReadScreen` → returns `''` (verified by spying), no crash; gate proceeds to next poll until timeout.
13. Honors injected `now`/`sleep` for deterministic tests (fakeClock pattern already established at `test/submit-gate.test.js:41`).

### 7.3 Integration — daemon `/submit` (in `test/daemon.test.js`)

14. `POST /submit { }` on a session with `backend:'cmux'`, `command:'claude'`, mocked `awaitPromptSymbol` returning `ready:true` → response includes `prompt_symbol: { found: true, ... }`. Existing 0.3.1 fields preserved.
15. `POST /submit { }` on `backend:'kitty'` (no cmux workspace) → `prompt_symbol: { found: false, reason: 'no_screen_primitive' }`; Layer 1 still runs; existing 200/504 outcome unchanged.
16. `POST /submit { prompt_symbol_gate: false }` → `awaitPromptSymbol` is NOT called; `prompt_symbol` field absent or `null`. Validates per-request opt-out.
17. `POST /submit { force: true }` → BOTH gates skipped (existing 0.3.1 behavior preserved); `prompt_symbol` field absent.
18. `TELEPTY_SUBMIT_GATE=off` env → BOTH gates skipped; legacy blind path. `prompt_symbol` field absent.
19. `POST /submit { prompt_symbol_timeout_ms: 200 }` on a session whose mocked screen never shows the symbol → `prompt_symbol: { found:false, reason:'no_prompt_symbol_seen', waited_ms ≈ 200 }`; **Layer 1 still runs** (best-effort, no Layer-3 504).

### 7.4 Reliability — `test/e2e-prompt-symbol.manual.js` (new opt-in, `TELEPTY_E2E=1`)

20. **100× spawn-and-inject on fresh `claude`** (extends predecessor §4.4 #20): same harness; pass criterion ≥ 99/100. Compare against 0.3.1 baseline reported in commit `4ba07d9` evidence.
21. **100× spawn-and-inject on fresh `codex`** (NEW): claude+codex coverage parity. Pass ≥ 99/100.
22. **`prompt_symbol_gate: false` regression**: same harness with the new flag opted out → pass-rate matches 0.3.1 baseline (no regression of opt-out path).

### 7.5 Regression — existing 0.3.1 surface

23. All 28 existing `test/submit-gate.test.js` tests pass unchanged.
24. All daemon tests pass unchanged.
25. `inject --ref` (no `--submit`) — Layer 3 not invoked; mailbox path unchanged.
26. `aterm` sessions (`backend !== 'cmux'`) — Layer 3 returns `no_screen_primitive` cleanly; aterm-specific guards in `terminalLevelSubmit` unchanged.
27. Cross-machine remote inject (`crossMachine.remoteInject`) — Layer 3 runs only on the LOCAL daemon (where cmux is reachable); remote daemon may have no cmux → returns `no_screen_primitive`; behavior unchanged.

---

## 8. Failed approaches (must NOT propose)

| Anti-approach | Why rejected |
|---|---|
| Hardcoded `setTimeout(N)` before dispatch | The very trap orchestrator's analysis identifies as the unfixed Layer 3. Defeats deterministic detection; pays latency on warm sessions and still fails on cold ones. |
| Reading the inject body BACK from the rendered screen and waiting for it | Confirms the BODY was rendered, not that the REPL is READY to consume it. Body can render into a model-select dialog or trust prompt. Wrong signal class. |
| Modifying `sessionStateManager` to demote `idle` confidence for unknown-prompt sessions | Orthogonal — that change affects ALL state-machine consumers (TUI dashboard, bus events, autoreport). This spec ADDS a new layer; does not retune existing. |
| Adding OSC 133 emission to claude/codex/gemini | Requires upstream changes outside telepty's domain. Tracked as out-of-scope per predecessor §9 and δ-fix-v2 §9. |
| Per-CLI banner/welcome detection (regex on "Welcome to Claude Code" etc.) | Brittle across versions; banner localization (Korean/Japanese) breaks regex; doesn't actually signal ready state, only signals "we're past the banner". The prompt symbol IS the ready signal. |
| New external dependency (`tty-state`, `xterm-headless`, `node-screen`) | Violates Rule 17 (무의존). `cmux read-screen` is already on the box and already shellouted-from in `daemon.js:1464`. |
| Replacing the 0.3.1 gate with prompt-symbol gate alone | Layer 3 needs Layer 1's hard-fail short-circuit (`session_dead`/`session_error`) and dispatch-on-timeout best-effort. Layered, not replaced. |
| Layer-3 gate fires its own 504 on `no_prompt_symbol_seen` | Regresses to 0.3.0's strict-fail behavior that δ-fix-4 (`gated_dispatch_after_timeout`) explicitly removed. Layer 3 is best-effort; only Layer 1's hard-fail reasons emit 504. |
| Writing the gate in CLI (`cli.js`) instead of daemon | Couples CLI to in-process daemon state and breaks remote injects. Predecessor §5 already settled this. |
| Polling from inside `awaitReplReady` (extending 0.3.1 helper) | Conflates two layers in one helper; harder to disable independently; harder to test in isolation. Separate helper = separate test surface = cleaner override. |

---

## 9. Constitution check

| Rule | Compliance |
|---|---|
| **Rule 1 — 경량** | ✅ One new ~50-LOC registry module + one new ~50-LOC helper + ~10 LOC daemon wire-up + tests. No new long-running timers/goroutines (poll loop runs only during a single `/submit` request, bounded by `timeoutMs`). |
| **Rule 5 — 최선 (best-first)** | ✅ Closes Layer 3 with deterministic terminal-state observation. Refuses the workaround of "wait 6 s before any inject" (Layer 2). |
| **Rule 13 — 비판적+건설적+객관적** | ✅ All decisions cite live evidence (cmux read-screen captures, byte-sequence dump, outputRing empty-result table). Anti-approaches enumerated with reasons. |
| **Rule 17 — 무의존** | ✅ Zero new external deps. `cmux read-screen` and `child_process.execSync` already established in `daemon.js:1459-1473`. |
| **Rule 26 — cross-OS** | ✅ Detection logic operates on terminal-rendered text — same byte-string regardless of host OS. The cross-OS axis is "is `cmux` available" — handled by the `no_screen_primitive` skip path, identical on macOS/Linux/Windows-WSL. The `cmux read-screen` shellout itself is OS-neutral (cmux is a single Mac app today; WSL/Linux paths would substitute a `tmux capture-pane` adapter via the same `defaultReadScreen` injection point — out of scope but designed-for). |
| **Constitution Rule 1 (AI gap)** | ✅ Removes the recurring orchestrator UX trap that wastes parallel-fanout latency budget AND requires manual `cmux send-key --workspace workspace:N enter` workarounds. |

---

## 10. Invariants (must NOT change vs δ Phase 2 + δ-fix-v2)

- ✅ **Default behavior of `inject --submit` on warm sessions**: Layer 3 short-circuits at first stable symbol sighting (typically <500 ms on warm sessions); Layer 1 short-circuits as before. Combined `gate_wait_ms` ≤ 750 ms warm-path expected.
- ✅ **HTTP 504 trigger conditions narrow**: 504 still fires on Layer 1's hard-fail reasons (`session_dead`, etc.) and on `gated_dispatch_unconsumed`. **No new 504 source from Layer 3.**
- ✅ **HTTP 503 (dispatch-failure)**: preserved when all strategies (kitty/cmux/pty) return null.
- ✅ **`force: true`**: bypasses BOTH gates (Layer 3 + Layer 1). Memory `feedback_inject_enter.md` semantic preserved — manual override is manual.
- ✅ **`TELEPTY_SUBMIT_GATE=off`**: bypasses BOTH gates. Legacy 0.2.x blind path preserved.
- ✅ **All 28 existing `test/submit-gate.test.js` tests**: unchanged; new tests added in dedicated sections.
- ✅ **`session.command` resolution**: registry uses the same `session.command` field already populated at allow time. No new session-creation-site changes.
- ✅ **Bus event `submit` shape**: `prompt_symbol` is an optional new field (additive).
- ✅ **Aterm sessions**: untouched — Layer 3 detects `backend !== 'cmux'` and skips with `no_screen_primitive`; existing aterm guards in `terminalLevelSubmit` unchanged.
- ✅ **Cross-machine remote inject**: Layer 3 lives in the daemon receiving the inject; if the remote daemon has no cmux, gate cleanly skips. No protocol change.

---

## 11. Implementation estimate

| File | Net LOC | Tests | Notes |
|---|---:|---:|---|
| `src/prompt-symbol-registry.js` (NEW) | +55 | +60 (registry tests + 3 fixture files) | Pure JS module |
| `src/submit-gate.js` (extend) | +55 | +50 (awaitPromptSymbol unit) | New exported helper, additive |
| `daemon.js` (POST /submit wire-up) | +12 | +40 (3 daemon integration tests) | Insert between `force` and `gateOff` blocks |
| `cli.js` (optional `--verbose` surfacing) | +3 | 0 | Cosmetic; default output unchanged |
| `test/fixtures/prompt-screens/*.txt` (NEW) | +120 | — | Captured cmux read-screen samples |
| `CHANGELOG.md` | +12 | — | Entry under 0.3.2 / 0.4.0 |
| **Total** | **~140 net LOC, ~150 test LOC, ~120 fixture LOC** | | |

**Wall budget for Phase 2 implementation:** ≤ 4 h.

- Code edits: ~75 min
- Fixture capture (`cmux read-screen` for 9 scenarios across 3 CLIs): ~30 min
- Test scaffolding + unit tests: ~75 min
- Local smoke (`npm test`, manual claude/codex/gemini spawn × 5 each): ~30 min
- E2E §7.4 #20-22 (100× spawns × 3 CLIs): ~30 min if feasible locally; otherwise gated under TELEPTY_E2E=1

**Risk surface:** confined to one new module (`prompt-symbol-registry.js`), one new helper in an existing module (`src/submit-gate.js`), and one ~12-LOC insertion in `daemon.js`. No state-machine changes, no bus-schema breaking changes, no CLI behavior changes (CLI optionally surfaces a new field on `--verbose`).

---

## 12. Out of scope

- **Architectural shift to 1-shot `claude --print` orchestration** — separate, larger spec covering whether the orchestrator should give up persistent REPLs entirely.
- **Upstream Anthropic / OpenAI / Google ready-signal request** — external; outside telepty's authority.
- **Per-CLI banner / welcome / model-select / trust-dialog detection** — this spec is prompt-only. If banners need their own gate (for sequencing dismiss-Enter through a model-select), file a follow-up spec.
- **Tuning `idle_timeout_ms` in `session-state.js`** — orthogonal; affects all state-machine consumers.
- **Replacing `cmux send-key` with cmux's `paste-text` for body delivery** — separate concern.
- **WSL/Linux `tmux capture-pane` adapter** for `defaultReadScreen` — designed-for via injection point, but no implementation in this spec (no Linux/Windows test rig in current dev environment).
- **Cursor-position verification** (CSI 6n DSR query) — `cmux read-screen` does not expose cursor coords today. Cursor-on-prompt-line could be a future v3 enhancement; symbol-only is sufficient for the named failure modes.

---

## 13. Semver impact

**Recommendation: PATCH bump 0.3.1 → 0.3.2.**

Rationale:

1. **Strictly additive new layer**: Layer 3 only ADDS a check. Failure modes either skip cleanly (`no_screen_primitive`, `unknown_cli`) or fall through to the existing 0.3.1 behavior (`no_prompt_symbol_seen` → log + proceed). **No new 504 source.**
2. **All escape hatches preserved**: `force:true`, `TELEPTY_SUBMIT_GATE=off`, plus a NEW per-request `prompt_symbol_gate:false` opt-out for callers that want exactly 0.3.1 semantics.
3. **No breaking response shape changes**: `prompt_symbol` is an optional new field. Existing fields unchanged.
4. **No new HTTP endpoints**.
5. **Bug-fix character**: this is the predecessor specs' acknowledged Layer 3 (predecessor §1.5, δ-fix-v2 §1.4) — patch is the conventional vehicle.

**Alternative considered: MINOR (0.3.1 → 0.4.0)** for visibility ("new gating layer is a feature"). Rejected because:
(a) the change is semantically a continuation of the 0.3.0 "render-gated submit" goal, not a new capability;
(b) consumers tolerate unknown JSON fields per JSON convention;
(c) δ Phase 2's CHANGELOG positioning ("render-gated submit reliability") is more honestly extended via a patch than via a minor that implies new surface.

If the orchestrator prefers MINOR for visibility, the impl is identical — only the version literal in `package.json` changes. The decision is non-blocking for Phase 2.

---

## 14. Phase 2 entry criteria

- Orchestrator approves:
  1. Layered architecture (Layer 3 above Layer 1) per §5
  2. Per-CLI registry approach per §6.1 (vs. e.g. per-CLI plugin module split)
  3. `cmux read-screen` as the screen-state primitive (vs. building telepty-internal screen-state)
  4. Best-effort fall-through on `no_prompt_symbol_seen` (vs. 504)
  5. Semver: PATCH 0.3.2 (or MINOR 0.4.0 if preferred for visibility)
- Phase 2 implementation budget ≤ 4 h wall, ≤ 140 net LOC + 150 test LOC + 120 fixture LOC.
- Phase 2 success: §7 assertions pass; §7.4 reliability harness ≥ 99/100 on claude AND codex; existing 28 submit-gate tests pass unchanged; no regression on `inject --ref`, aterm, or non-cmux backends.
- Stage with explicit paths only (consistent with 0.3.1 commit `4ba07d9` pattern):
  ```bash
  git add src/prompt-symbol-registry.js src/submit-gate.js daemon.js cli.js \
          test/prompt-symbol-registry.test.js test/submit-gate.test.js test/daemon.test.js \
          test/fixtures/prompt-screens/ \
          docs/superpowers/specs/2026-04-26-prompt-symbol-render-gate.md \
          package.json CHANGELOG.md
  ```
- Commit message follows 0.3.1 pattern: `feat(submit-gate): δ-fix-5 prompt-symbol render gate (0.3.2)`.

---

## 15. Open questions (for Phase 2 input — non-blocking)

1. **`cmux read-screen` exit-code contract on a closed workspace**: empirically returns non-zero with `Error: not_found: Workspace not found` on stderr (verified 2026-04-26 against workspace:21 which had been auto-cleaned). The `defaultReadScreen` wrapper catches via `try/catch` and returns `''`. **Non-blocking; current handling is correct.** If the orchestrator later wants explicit telemetry on cmux-disappeared workspaces, file a follow-up.
2. **`tailLines` default 30 sufficient?** claude's idle layout occupies ~5 lines (border + symbol + border + statusline + statusline-2). codex's idle layout occupies ~3 lines. gemini's idle layout occupies ~3 lines. 30 is comfortable margin; tunable per-request via `tail_lines`. Recommendation: ship with 30.
3. **Should Layer 3 also fire the bus event `submit-gate` separately**? Currently telepty emits one `submit` bus event with all gate fields merged. Adding a separate `submit-gate` event for downstream filtering (TUI dashboard could highlight prompt-symbol gate timeouts) is a follow-up. Recommendation: ship merged into existing `submit` event for now.
4. **Should the registry support multiple symbols per CLI** (e.g. claude's `❯` + a backup `>`)? Current spec uses single symbol per CLI; the `detect()` function is freeform JS so a future entry could check multiple internally without registry-shape changes. Recommendation: single symbol; revisit if claude version-skew breaks detection.
5. **Phase 3 follow-up — cursor position via DSR (CSI 6n)?** `cmux read-screen` does not expose cursor coords today. A second confirm-signal beyond symbol-rendered would tighten the gate from "symbol present" to "cursor parked on symbol". Not needed for the named failure modes; revisit only if §7.4 #20-22 surfaces residual <99% pass-rate.
