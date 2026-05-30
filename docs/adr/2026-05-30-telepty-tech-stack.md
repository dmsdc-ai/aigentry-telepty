# ADR 2026-05-30 — telepty tech stack: stay Node.js, reject language migration, harden in-place

**Status:** Accepted (user-ratified 2026-05-30)
**Deciders:** orchestrator + 2 independent reviews — (1) multi-LLM deliberation (codex×2, gemini×2, unanimous `[AGREE]`); (2) ultracode 13-agent adversarial stack-eval. Both converged.
**Supersedes/relates:** task-queue #501 (umbrella), #500 (0.5.1 daemon hotfix), #495 (god-module extraction). Basis report: `docs/adr/2026-05-30-telepty-tech-stack-eval-report.md`.

## Context

telepty is a mature, shipped Node.js CLI + daemon (PTY multiplexer; HTTP/WS daemon; MCP server; cross-machine/Tailnet routing; mailbox; supervisor bridge). ~22K LOC + ~8K LOC of tests encoding production scar-tissue. Pain points that triggered the review: a 3000+-line `daemon.js` / `cli.js` god-module pair (hard to refactor safely, multi-AI-edited) and a 0.5.0 regression where a `require.main === module` guard skipped `app.listen()` so the daemon never bound.

The question asked: **what tech stack minimizes long-term technical debt — open to other languages (Go/Rust/Bun/Deno) or staying put?**

Hard constraints (constitution): **§17 무의존** (minimal toolchain/runtime dep), **§1 경량** (zero build — `node daemon.js` runs directly), **ship=source** (the 0.5.0 hotfix was a 2-minute edit→publish *because* shipped == source), **§2 크로스** (Windows/macOS/Linux), and the codebase is edited by multiple AI sessions (claude/codex/gemini).

## Decision

**Stay on Node.js. Reject all language migration AND a full-TS rewrite. Harden in-place via gradual typing + decomposition + the missing integration test, re-sequenced by value/risk.**

Execution waves (value/risk order — de-bundled from the naive plan):

1. **Wave 1 (high-value, low-risk, do regardless):**
   (a) **daemon-launch integration test** — spawn the daemon via the real CLI path, assert the port binds. This is the *load-bearing* fix: the 0.5.0 regression was a control-flow bug **no type system catches** (Rust/Go/TS/@ts-check all miss it). Plus a Windows/PTY/submit-gate test matrix.
   (b) **tsconfig.json** (`allowJs/checkJs/noEmit/strict`) + `npm run typecheck` as a **BLOCKING** CI-only gate. No build, no runtime change, ship=source intact.
2. **Wave 2:** decompose `daemon.js` (~3592) + `cli.js` (~3536) into single-responsibility `src/` modules *behind the same entry/export surface*, in small reviewed steps under the existing 34-test suite (= #495). The durable structural win; independent of typing.
3. **Wave 3:** adopt JSDoc `@ts-check` module-by-module with a no-new-`@ts-ignore` ratchet. **Honest cost:** its contract value is ~0 until JSDoc typedefs are hand-written for the 8-state session FSM, NDJSON frame variants, and session contracts — *that typing is the real cost*, not the CI plumbing. Add a `parseCommand()` runtime validator at the wire boundary (types alone are insufficient).

## Rationale

- **Efficiency is a non-argument.** telepty is I/O-bound (PTY read → WS fan-out → regex FSM → JSONL mailbox); the bottleneck is syscalls/network/SSH latency, not CPU/GC. No language buys user-perceptible speed. A migration whose headline rationale (perf/single-binary) is irrelevant is debt *relocation*, not *reduction*.
- **Ecosystem lock-in is real + asymmetric.** `@modelcontextprotocol/sdk` is the official, spec-authoritative SDK and Node-only in practice (the MCP server *is* product surface); node-pty's 4-platform prebuilts incl. real Windows **ConPTY** (`conpty.node`) have no equal (`creack/pty` Go has no real ConPTY; Bun PTY is POSIX-only; Deno can't load node-pty).
- **The constraints are HARD operational properties.** Every non-Node option and full-TS converts the 2-minute hotfix into a 5-target build/cross-compile/release under outage pressure — disqualifying for a tool the whole ecosystem depends on daily.
- **Migration cost dominates + fixes nothing real.** ~22K LOC / 8–12+ wk, discarding ~8K LOC of contract-encoding tests, high regression risk in the load-bearing FSM/mailbox paths — and still doesn't fix the one bug that motivated the review (needs an integration test, available today in plain Node).
- **Multi-LLM editing argues against native.** Async Rust borrow/`Send+Sync` errors are exactly the failure class that traps codex/gemini in failed-fix loops; Node's single-threaded loop gives the FSM's strictly-ordered transitions for free.
- **Precedent:** Svelte (2023) reverted TS→JS+JSDoc to kill the build step and recover debug velocity while keeping CI type-safety — a direct mirror of telepty's `ship=source`.

## Consequences

- Positive: preserves the battle-tested I/O core + 4-platform PTY + MCP surface; zero build/ship=source/§17 intact; the real bug class (boot regressions) gets locked down; the god-module gets structurally fixed; AI-edit guardrails arrive at the boundaries.
- Negative / accepted: `typescript` added as a **CI-time devDependency** only; the hand-written-typedef effort (Wave 3) is real work back-loaded behind decomposition; `@ts-check` alone catches nothing meaningful until then (do not oversell it).

## Alternatives rejected

- **Full TypeScript (build, ship dist/):** rejected — zero runtime gain, breaks §1/ship=source, ~90% of its benefit reachable via JSDoc `@ts-check` at zero build. Strictly dominated.
- **Go:** rejected (worst) — `creack/pty` regresses Windows ConPTY; cgo to fix kills the static-binary win; maximizes language count when native code already lives in Rust.
- **Bun/Deno:** rejected — PTY POSIX-only / node-pty unloadable; orthogonal to the actual debt. (`bun build --compile` may be cherry-picked later as a *packaging* layer only, never a runtime swap.)
- **Rust:** rejected for migration; noted as the *only coherent* native target if ever forced (native supervisor/cross-machine already in Rust; `portable-pty` has real ConPTY).

### Conditional carve-out (guardrail, not a recommendation)
A native (Rust) rewrite becomes *arguable* only if **all** hold (none true today): (1) an official spec-authoritative Rust MCP SDK ships; (2) single-binary runtime-free distribution is a demonstrated hard requirement (and even then Node SEA captures most of it); (3) the workload becomes genuinely CPU/throughput-bound (thousands of concurrent sessions/host); (4) a from-scratch successor with no 22K-LOC sunk asset / Windows user base to preserve.
