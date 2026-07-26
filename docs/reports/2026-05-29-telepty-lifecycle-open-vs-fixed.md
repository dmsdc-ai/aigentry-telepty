# telepty lifecycle/bootstrap issues — open-vs-fixed adjudication

- **Analyst session**: `T-telepty-lifecycle-verify` (role = analyst, READ-ONLY)
- **Date**: 2026-05-29
- **Scope**: `/Users/duckyoungkim/projects/aigentry-telepty` @ HEAD `08cd796`
- **Mandate**: evidence-based verdict (TRUE-OPEN | ALREADY-FIXED | PARTIAL) per issue, with commit SHA / file:line citation. No code edits, no design.
- **Commits in scope**: `08cd796` (SIGHUP decouple), `900c3ae` (0.4.5 bundle), `bfe4bee` (version-mismatch/port-owner/banner), `874d14a` (Windows PATHEXT).

> **Live evidence captured mid-analysis (#32):** when this session injected a HOLD into `orchestrator`, the daemon immediately fired back `TASK_COMPLETE: orchestrator is now idle after processing inject (0.0s)` into this session's prompt — a `0.0s` ready-signal false positive, indistinguishable from a genuine orchestrator completion. This is the exact #32 symptom, observed in production.

---

## Verdict table

| Issue | Verdict | needs #487 |
|---|---|---|
| #17 stale entry after cmux close | **PARTIAL** (symptom-shifted, not fixed) | YES |
| #32 TASK_COMPLETE 3-path / false positive | **PARTIAL** (dedup'd; indistinguishability open) | NO |
| #29 Warp+Codex CONNECTED but bootstrap.ready=false | **PARTIAL / uncertain** (needs runtime repro) | NO |
| #31 codex via cmux hangs / never foreground | **PARTIAL** (matcher ok; focus/surface open) | needs-design (see note) |
| #30 daemon session closed, Warp UI tab not | **TRUE-OPEN** | YES |
| #19 Windows codex PATH-shim STALE | **ALREADY-FIXED** (resolution) by `874d14a`; residual = generic GC | NO |
| #26 Snyk 5 pre-existing cli.js findings | **PARTIAL-assessment** (1 by-design waived; rest need fresh scan) | NO |

---

## #17 — stale `DISCONNECTED (OWNER_DISCONNECTED) 💤` after `cmux close-workspace`
**Verdict: PARTIAL — `08cd796` SHIFTED the symptom, did not fix it.**

Evidence:
- `08cd796` installs a `process.on('SIGHUP', () => {})` no-op + `process.stdout.on('error', …)` guard in `cli.js`, so a `telepty allow` bridge now **survives** the SIGHUP cascade that `cmux close-workspace` (or any terminal app death) sends.
- Consequence on the daemon GC path: `daemon.js:3109-3113` `shouldCleanupDisconnected` requires `!isOpenWebSocket(session.ownerWs) && (!clients||size===0) && disconnectedSeconds >= SESSION_CLEANUP_SECONDS (300s)`.
- **Because the bridge process now survives, its owner WS stays OPEN.** So the session no longer flips to `DISCONNECTED`; it shows `CONNECTED (OWNER_CONNECTED)` with **no visible terminal**, and `shouldCleanupDisconnected` NEVER fires (the `!isOpenWebSocket(ownerWs)` precondition is never met).
- Pre-`08cd796` flow: terminal close → bridge dies → ownerWs closes → `DISCONNECTED` → GC after 300s. The original "stale accumulation" was a 300s GC-latency problem.
- Post-`08cd796` flow: terminal close → bridge survives → `CONNECTED` zombie with no UI → **never GC'd**. The symptom moved from "stale DISCONNECTED entries" to "surviving headless zombies" (this now overlaps #30).

Scoped fix sketch (route through #487 boundary first):
- A coordinated close: when cmux closes a workspace, signal telepty to close the matching session (match on `cmuxWorkspaceId`/`cmuxSurfaceId`); OR add a cmux-surface-liveness probe in the daemon health loop so backend==cmux sessions GC on surface-gone independent of ownerWs.
- File: `daemon.js` health/cleanup loop (~`3109`) + a new surface-liveness probe. Ownership decision (who closes whom) is exactly the #487 boundary question → **architect first**.

---

## #32 — `TASK_COMPLETE` auto-report from three daemon paths / false positives
**Verdict: PARTIAL — triple-fire is now dedup'd, but the false-positive indistinguishability is TRUE-OPEN.**

Evidence:
- Three text-inject paths remain: `daemon.js:93` (`onTransition` idle), `daemon.js:3066` (threshold fallback), `daemon.js:3284` (ready-signal). The issue's original line hints (90/2829/3047) drifted but the three paths persist.
- All three are now guarded by `pendingReport.idleNotified` (`daemon.js:75, 3053, 3271`) so only the first fires — **no triple-fire**. (The `onTransition` path traces to `0c66d87`; guards present at HEAD.)
- **Open core complaint:** the legacy text-inject message is byte-identical across all three paths — `TASK_COMPLETE: <id> is now idle after processing inject (Ns)` — with no trigger-path tag and **no guard against near-zero `elapsed`**. The richer `TASK_IDLE_NO_REPORT` bus event carries `source`/`inject_id` (`daemon.js:82-89`) but is NOT what lands in the recipient's prompt.
- **Live proof:** this session received `…(0.0s)` immediately after a HOLD inject — a ready-signal false positive a recipient cannot distinguish from a real completion.

Scoped fix sketch:
- Consolidate the 3 `reportMsg` builders into one helper that (a) suppresses or explicitly tags `elapsed < ~1s` ready-signal triggers, and (b) embeds trigger-path + `inject_id` in the text — or drop the legacy text-inject entirely and rely on the bus event.
- File: `daemon.js` (3 call sites → 1 helper). Pure daemon.js. **No #487 dependency.**

---

## #29 — foreground Warp + Codex: `CONNECTED` but `transport.bootstrap.ready` stays `false`
**Verdict: PARTIAL / uncertain — `#472` matcher helps but the non-cmux render gap remains; definitive verdict needs runtime repro.**

Evidence:
- `bootstrapReady` flips via: WS `'ready'` from the cli.js bridge → `markBootstrapReady('bridge_ready')` (`daemon.js:3252`); the cmux prompt-symbol poll → `markBootstrapReady('cmux_prompt_symbol')` (`daemon.js:670`); startup-restore optimistic (`daemon.js:2898-2924`).
- The cmux poll is **gated to backend==cmux** (`scheduleBootstrapPromptPoll`, `daemon.js:662`: `session.backend !== 'cmux' || !session.cmuxWorkspaceId → return`). For **Warp (backend != cmux)** it is skipped — readiness depends entirely on the cli.js bridge.
- cli.js bridge readiness = `observePromptReady` (`cli.js:1246-1252`) → `readyRegistry.detectOutput(command, outputTail)` over the **raw PTY stream tail** (ANSI-stripped, last 20000 chars). `#472` made `codex.detect` tolerant (`src/prompt-symbol-registry.js:43-83`) and `detectOutput` shares it, so the bridge path benefits.
- **Residual gap:** `codex.detect`'s multi-signal needs `"OpenAI Codex (v"` + `"gpt-N … fast"` present contiguously. The file header (`src/prompt-symbol-registry.js:5-9`) states it expects a **rendered `cmux read-screen` snapshot**, not a raw alternate-screen TUI byte-stream where redraws/cursor moves fragment the text. For Warp+codex there is **no rendered-screen primitive**, so detection can still miss → no `'ready'` WS → `bootstrapReady` stays false → `bootstrap_not_ready` (`daemon.js:692-693`). `#472` improves but does not close this.

Scoped fix sketch:
- Provide a render probe for non-cmux backends (server-side terminal emulator over `outputRing`, run `entry.detect` on the rendered grid); OR add an optimistic-ready timeout for backend!=cmux wrapped AI CLIs (mirror `startup_owner_alive`).
- File: `daemon.js` `scheduleBootstrapPromptPoll` + a non-cmux fallback; possibly `src/submit-gate.js` render abstraction. **No #487 dependency** (but cross-check). **Definitive verdict needs a Warp+codex runtime repro I cannot run read-only → uncertain.**

---

## #31 — codex via `cmux new-workspace --command "telepty allow … codex"` hangs at `Starting MCP servers (0/3)`
**Verdict: PARTIAL — `#472` matcher behaves correctly; the focus/foreground + inject-not-read symptoms are TRUE-OPEN.**

Evidence:
- `#472` codex matcher correctly returns NOT-ready while codex sits at "Starting MCP servers" (no prompt symbol, no `gpt-N fast` status row yet) — telepty correctly withholds inject until ready. That part is sound (`src/prompt-symbol-registry.js:46-81`).
- **Open:** the core symptoms — codex never becomes foreground/focused, inject written to PTY but never read — are NOT addressed. `grep` for focus/foreground across `cli.js`/`daemon.js`/`terminal-backend.js` finds only `daemon.js:1802` *reading* `foreground_processes` for status; **nothing ever sets focus**. No cmux focus call exists.
- If codex stalls at MCP startup and never renders a prompt, `awaitPromptSymbol` times out → `bootstrap_ready_timeout` (`daemon.js:672`) and inject queues forever — same family as #29.

Scoped fix sketch:
- (a) cmux focus/foreground call after spawn — requires a **spawn-time focus/foreground primitive** (codex hangs without a focused TTY); (b) `bootstrap_ready_timeout` should surface an actionable error rather than silent queue-forever (`daemon.js` timeout handling).
- **needs-design (NOT firm #487):** #487's scope is session SURVIVAL/reattach, whereas #31 is a SPAWN-TIME focus concern. The focus gap may close under **#487 Phase 2(c) daemon-initiated-spawn** (if the daemon owns the PTY at spawn it can focus it), OR it may be a separate cmux-spawn / telepty-spawn concern. **Architect to decide which** — do not force under #487.

---

## #30 — `telepty` closes daemon-side session but NOT the visible Warp UI tab
**Verdict: TRUE-OPEN — the requested terminal-surface lifecycle adapter does not exist.**

Evidence:
- `cmuxSurfaceId` / `cmuxWorkspaceId` are **stored as session metadata only** (`daemon.js:135, 1154, 1252, 1443, 1477`) and are **never used to close/destroy a terminal surface**. `grep` finds no `cmux close-workspace`, no Warp tab close, no surface-kill anywhere in `cli.js`/`daemon.js`/`terminal-backend.js`.
- `closeAllowSession`/`exitAllowSession` (`cli.js:1446`/`1467`) only kill the child PTY + log death; they never touch the host terminal UI.

Scoped fix sketch:
- A terminal-surface adapter interface (`close(surfaceId)` per backend: cmux `close-workspace`, Warp/iTerm/kitty equivalents) invoked on session close. New design = who owns surface lifecycle → **#487 boundary → architect**.
- **needs #487.**

---

## #19 — Windows: `telepty allow … codex` PATH-shim fails, leaves `STALE`
**Verdict: ALREADY-FIXED (resolution) by `874d14a`; residual STALE = generic GC, not a distinct bug.**

Evidence:
- `874d14a` added `src/win-resolve-executable.js`, wired at `cli.js:1184` (`resolveWindowsExecutable(command, process.env)` immediately before `pty.spawn` at `cli.js:1185`) inside `spawnChild`. It is **generic for any bare command** (not claude-specific) — a `codex.cmd` PATH shim resolves via PATH×PATHEXT walk on Windows, the same root cause as #25.
- So the `ERROR_FILE_NOT_FOUND` spawn failure is fixed for codex too. If resolution genuinely fails (codex not on PATH at all), the registered session goes STALE — but that is correct behavior, cleaned by the generic 300s GC (`daemon.js:3109`).

Scoped fix sketch:
- Likely only needs a Windows codex-shim verification test (claude-shape test already exists). If a repro persists, check codex shim extension coverage vs the default PATHEXT list. **No #487.**

---

## #26 — Snyk: 5 pre-existing cli.js findings
**Verdict: PARTIAL-assessment — 1 finding accepted-by-design (correctly waived); the rest need a fresh line-accurate scan (issue line numbers are stale).**

Evidence:
- CHANGELOG documents the "5 pre-existing findings (2 Medium Command Injection + 3 PathTraversal)" as a baseline waiver across 0.4.1–0.4.5 (`CHANGELOG.md:251, 489, 515, …`), never fixed in `cli.js`.
- The `pty.spawn` finding (issue's finding #2, "telepty allow wraps a user CLI") is **genuinely accepted-by-design** — spawning the user's chosen CLI IS the feature; not fixable without removing `telepty allow`.
- The issue's cited line numbers (469/1075/2287/2598/2289) are **STALE**: `cli.js` has grown ~33% (135KB). At HEAD, line ~1075 sits in the allow-spawn region (consistent with the pty.spawn finding), but 469 is `renderInteractiveHeader` and 2287/2289 are a broadcast-inject `fetch` (not obviously path-traversal). A per-finding fixable-vs-waived verdict **requires a current `snyk_code_scan`**, which the analyst role cannot run (spec: Snyk N/A here).

Scoped fix sketch (for the fixable subset, pending rescan):
- Path-traversal: harden `fs.readdirSync('/tmp')` kitty-sock scan (`cli.js:1081`) and similar with path normalization / allowlist. Command-injection: prefer `execFile` + arg arrays over shell strings. **Confirm against a fresh Snyk report first.** **No #487.**

---

## Dependency / serialization map

- **`daemon.js` (shared — SERIALIZE)**: #17, #29, #31, #32 all edit `daemon.js`. One coder at a time, or careful sequencing. Group: `daemon.js = {17, 29, 31, 32}`.
- **`cli.js` (shared)**: #26 (findings), #29 (bridge ready-signal), #19 (already mostly fixed). Group: `cli.js = {26, 29, 19}`.
- **`src/prompt-symbol-registry.js` + `src/submit-gate.js`**: #29, #31 (detection/render gap).
- **needs #487 ADR (architect first, FIRM)**: **{17, 30}** — both hinge on the cmux↔telepty surface/lifecycle (survival/close) boundary.
- **needs-design (architect to decide scope)**: **{31}** — spawn-time focus/foreground primitive; POSSIBLY #487 Phase 2(c) daemon-initiated-spawn, possibly a separate cmux-spawn/telepty-spawn concern. NOT forced under #487.
- **Pure daemon.js, no #487, can start immediately**: #32.
- **Likely closeable as fixed / verify-only**: #19.
- **Needs fresh tooling before scoping**: #26 (Snyk rescan), #29 (Warp+codex runtime repro).
