# telepty Tech-Stack Decision Report

## 1. Ranked table (post-adversarial)

| Rank | Stack | Score | One-line verdict |
|------|-------|-------|------------------|
| 1 | **Node.js (stay) + gradual JSDoc `@ts-check` (CI-only `tsc --noEmit`, ZERO build) + decompose god-modules + add daemon-launch integration test** | **4/5** | RECOMMENDED — correct baseline; preserves the entire battle-tested I/O core and ship=source at near-zero cost. De-bundle: decomposition + integration test are the real wins; `@ts-check` value is real but back-loaded behind hand-written typedefs. |
| 2 | Node.js + full TypeScript (tsc/esbuild, ship compiled `dist/`) | 2/5 | REJECT — zero runtime gain, breaks §1/ship=source, and ~90% of its type benefit is reachable via JSDoc `@ts-check` at zero build. Strictly dominated by #1. (Still better than any non-Node rewrite.) |
| 3 | Rust (tokio; portable-pty; single binary) | 2/5 | REJECT for migration — strongest PTY analog (portable-pty) and single-binary install, but no official MCP SDK, breaks §1/ship=source, 8-12+ wk rewrite discarding ~8K LOC of edge-case tests; perf win irrelevant to I/O-bound work. The *only* coherent native target if one were ever forced (native code already lives in Rust). |
| 4 | Go (goroutines; creack/pty; net/http) | 1/5 | REJECT — `creack/pty` regresses the working Windows ConPTY path; cgo to fix it kills the static-binary win; maximizes language count (JS-removed + Rust-staying + Go-arriving) when native code already lives in Rust. Worst option overall. |
| 5 | Bun / Deno (TS-native, built-in PTY, single-binary compile) | 2/5 | REJECT — Bun PTY is POSIX-only (breaks §2 크로스); Deno can't even load node-pty (#31032) and has no native PTY (#3994). Orthogonal to the actual debt. Cherry-pick `bun build --compile` later as a *packaging* layer only, never a runtime swap. |

> Scoring note: a strict reading of #1 separates two items that the bundle conflates. **Decompose + integration test = a clear 5** (they fix the class of bug that actually shipped). **`@ts-check` today = a 2-3** (it catches *nothing* meaningful on untyped JS until JSDoc typedefs for the FSM/NDJSON/session contracts are hand-written). The blended 4/5 reflects an excellent path with one oversold component.

## 2. The recommendation

**Stay on Node.js. Do not change the runtime or the language.** Execute the prior deliberation's path, but **de-bundle and re-sequence it by value/risk**:

1. **Decompose the god-modules first** (`daemon.js` 3,592 LOC, `cli.js` 3,536 LOC) into single-responsibility modules *behind the same entry files / export surface*, in small reviewed steps covered by the existing 34-test suite. This is the durable structural win and is **independent of any type decision** — it requires zero `@ts-check`.
2. **Add the daemon-launch integration test.** This is the *load-bearing* fix. The one real production regression (0.5.0 `require.main` / port-never-bound, git `c567543`) is a control-flow bug **no type system catches** — Rust, Go, TS, and `@ts-check` all miss it. An integration test is the only thing that would have caught it. Do this regardless of everything else.
3. **Adopt JSDoc `@ts-check` module-by-module** with a **BLOCKING** (not advisory) CI `tsc --noEmit` gate and a **no-new-`@ts-ignore` ratchet** — but set honest expectations: its contract value is **zero until** you hand-write JSDoc typedefs for the 8-state session FSM, NDJSON frame variants, and session objects. Budget that typing as the real cost; the CI plumbing is ~free, the safety is not. Start with the highest-churn multi-AI-edited seams.

Why this wins on the stated goal (debt-min + efficiency for an I/O-bound workload), with migration cost weighted heavily:
- **Efficiency is a non-argument.** telepty is I/O-bound (PTY read → WS fan-out → regex FSM → JSONL mailbox); the bottleneck is syscalls/network/SSH latency, not CPU or GC. libuv already saturates the kernel. No language buys user-perceptible speed here. Any "Rust/Go is faster" claim is marketing for this workload.
- **It preserves the battle-tested core** (node-pty 4-platform prebuilts incl. Windows ConPTY, mailbox advisory-lock delivery, SSH ControlMaster pooling, the FSM, Windows taskkill/PATH shims) — i.e. ~22K LOC + ~8K LOC of tests that encode production scar tissue. Rewrites reset that bug-discovery clock to zero.
- **It honors all three hard constraints.** §17: adds only `typescript` as a CI-time devDependency, no runtime/toolchain burden on users. §1 경량: `node daemon.js` still runs directly, zero build. ship=source: the published tarball remains the source; `tsc --noEmit` *only* gates in CI and never emits — the trivial edit→publish hotfix survives intact.

## 3. The honest verdict on language migration

**Do not migrate languages. Stay in Node.** This is not a hedge — it is the correct answer on the merits, and it holds *a fortiori* given the prior unanimous deliberation already rejected even a same-language TS rewrite.

The reasoning is decisive and converges across all four adversarial passes:

- **The workload removes the usual reason to switch.** For I/O-bound PTY/IPC multiplexing, runtime/language is not the bottleneck. The single honest technical win of every non-Node option (lower idle memory, faster cold start, single binary) is **irrelevant to telepty's actual workload and users**. A migration whose headline rationale is irrelevant is debt *relocation*, not debt *reduction*.
- **Ecosystem lock-in is real and asymmetric.** `@modelcontextprotocol/sdk` is the official, spec-authoritative SDK and is Node-only in practice; the MCP server *is* part of telepty's product surface. Go/Rust would force an unofficial, spec-lagging community SDK (§17 violation in spirit — a *new* hard dependency on immature third-party code) or an FFI bridge. node-pty's 4-platform prebuilt matrix (including real Windows ConPTY artifacts `conpty.node` + `conpty_console_list.node`) has no equal: `creack/pty` (Go) has no real ConPTY; Bun's PTY is POSIX-only; Deno can't load node-pty at all.
- **The constraints are HARD, not soft.** §1 경량 (zero build), ship=source (the 0.5.0 hotfix was a 2-minute edit→publish *because* shipped == source), and §17 무의존 are load-bearing operational properties. Every non-Node option and full-TS converts the hotfix path into build/cross-compile/release — under outage pressure, across a 5-target matrix. That is disqualifying for a tool the whole orchestration ecosystem depends on daily.
- **Migration cost dominates and buys nothing on the real problem.** 8-12+ weeks (Rust/Go) of rewriting ~22K LOC, discarding ~8K LOC of tests that encode silent behavioral contracts, with high regression risk in exactly the FSM/mailbox paths that are load-bearing — *and it still does not fix the one bug that motivated the exercise* (a missing integration test). The high-value, low-risk fixes (decompose + integration test) are available today in plain Node at near-zero migration cost.
- **Multi-LLM editing argues against native rewrites.** Async Rust borrow/lifetime/`Send+Sync` errors are precisely the failure class that traps codex/gemini in repeated failed-fix loops; Node's single-threaded event loop gives the FSM's strictly-ordered output-driven transitions for free, which goroutines would actually make *harder* (shared-state races).

**Plainly: no full language rewrite is justified for telepty.** The optimal path stays in Node with gradual typing + decomposition + the integration test.

**The one narrow, conditional carve-out** (not a recommendation, a guardrail): a native rewrite would only become *arguable* if **all** of the following held simultaneously, none of which is true today:
1. An **official, spec-authoritative MCP SDK** ships for the target language (removes the §17 unofficial-SDK risk).
2. Single-binary, runtime-free distribution becomes a **demonstrated, hard requirement** (not a hypothetical) — and even then, Node SEA (`node --experimental-sea`) / pkg bundling captures the install win *without* surrendering ship=source, so this rarely justifies a rewrite either.
3. The workload becomes **genuinely CPU/throughput-bound** (thousands of concurrent sessions per host) — which contradicts telepty's few-to-dozens-of-sessions profile.
4. There is a **from-scratch successor** with no 22K-LOC sunk asset and no existing Windows user base / npm-wired installers to preserve.

If those ever align, the target is **Rust, never Go** — because native code (`telepty-supervisor-core`, `telepty-cross-machine`) *already lives in Rust*, `portable-pty` is the most credible PTY analog with real ConPTY, and choosing Go would maximize language count for no benefit.

## 4. If the user still wants a migration branch anyway

**Least-bad choice: Rust** (not Go, not Bun/Deno, not full-TS-as-"migration").

Rationale: it is the only target where (a) native code already lives in-tree (Rust supervisor + cross-machine crates), making it the *coherent* native consolidation rather than a third language; (b) `portable-pty` (WezTerm's crate) is a mature, cross-platform PTY with real Windows ConPTY — the closest analog to node-pty; (c) axum + tokio-tungstenite (WS/HTTP) and clap (CLI) are best-in-class and idiomatic. Full-TS is rejected as a "migration" because it pays a build/ship-debt tax for a benefit JSDoc delivers free; Go regresses Windows and maximizes language count; Bun/Deno break §2 크로스 on PTY.

**Realistic cost of a Rust branch:**

| Surface | LOC to reimplement | Risk / what's involved |
|---------|--------------------|------------------------|
| `daemon.js` core | ~3,592 | The 622-LOC 8-state output-driven FSM (regex on live PTY bytes, OSC-133 + heuristics) — **highest silent-regression risk**; behavior is tuned against node-pty's exact output timing/buffering, which does **not** port. |
| `cli.js` | ~3,536 | Raw-mode/SIGWINCH interactive terminal handling → `crossterm`/`x` term; fiddly cross-platform glue, full re-validation needed (esp. Windows console mode). |
| PTY | (binding swap) | node-pty → `portable-pty`. The spawn line is trivial; the **platform matrix** (SIGTERM→SIGKILL vs Windows `taskkill`, ConPTY resize/kill, TERM naming) is the real work. Re-derive `win-kill-process.js` + `win-resolve-executable.js` (both independently tested today). |
| MCP server | ~184 | **Biggest structural risk.** No official Anthropic Rust SDK; ride unofficial `rmcp`/`mcp-sdk-rs` (spec-lagging) + re-express zod schema validation in Rust's type system. Perpetual spec-drift maintenance tax, **not a one-time cost**. |
| WS/HTTP daemon | (express+ws) | Clean win → axum + tokio-tungstenite/hyper. Genuinely idiomatic; lowest-risk surface. |
| Mailbox | ~995 | File-backed advisory-lock (O_EXCL) delivery engine → `fs2`/`nix`. Mechanically portable; **semantics carry regression risk** (delivery ordering the orchestration layer silently depends on). |
| Cross-machine | ~498 | SSH ControlMaster = `std::process` subprocess + `peers.json`. Runtime-agnostic; low risk (and partly already in the Rust crate). |
| Supervisor bridge | ~787 | NDJSON/UDS — ironically the one place Rust already lives; consolidation opportunity. |
| TUI | ~538 (blessed) | Full ground-up re-implementation in `ratatui`/`bubbletea`-equivalent — **not a port**, high behavioral drift. |
| Tests | ~8,171 (34 files) | **Zero reuse across language.** All edge-case knowledge (require.main singleton, cross-host inject, version handshake, submit-gate render detection) must be re-authored and re-validated. |

**Total: ~22,337 LOC rewrite, realistically 8–12+ weeks** of focused work plus a long tail of silent-regression discovery in load-bearing orchestration paths.

**Mandatory phased de-risking if proceeding anyway:**
1. **Do not start until** the in-Node fixes ship first (decompose + the daemon-launch integration test + a hardened Windows/PTY/submit-gate test matrix). That integration test is the behavioral oracle the rewrite will be validated against — without it the rewrite is flying blind on exactly the bug class telepty actually suffers.
2. **Strangler-fig, not big-bang.** Keep the Node daemon shipping. Move one surface at a time behind the existing NDJSON/UDS bridge (start with WS/HTTP — lowest risk; then mailbox; FSM and MCP **last**). Dual-run and diff outputs against the Node implementation on a real session corpus.
3. **Gate cutover on the MCP SDK condition** — do not move the MCP surface onto an unofficial crate as a load-bearing dependency until an official Rust SDK exists or the unofficial one is pinned, audited, and CI-verified against the spec.
4. **Accept the ship=source loss explicitly** — wire a 5-target cross-compile + Release pipeline and a fast hotfix story *before* cutover, or the first prod outage becomes a multi-step release under pressure.

**Bottom line: even the least-bad migration is a net-negative trade for a mature, working, I/O-bound tool.** Recommend the branch be exploratory/spike-only, time-boxed, and explicitly NOT on the critical path — and that the in-Node hardening ship regardless, since it is the path that actually reduces debt and fixes the bug class that has historically shipped.