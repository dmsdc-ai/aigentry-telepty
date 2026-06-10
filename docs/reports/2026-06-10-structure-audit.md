# Structure Audit — aigentry-telepty

- **Date:** 2026-06-10
- **Auditor:** architect (`audit-telepty-structure`, Fable 5) — read-only structure audit; no code modified
- **Scope:** 6 dimensions — role violation (§3), boundary violation (§4), coupling/cohesion, circular deps, abstraction/over-engineering (§1), ADR/doc compliance
- **Method:** repo-wide structure scan, targeted module reads, programmatic require-graph cycle detection, ADR cross-check. All findings carry file:line evidence.

---

## Headline — Top 3 structural risks

### RISK 1 (critical) — Identity contradiction: BOUNDARY.md declares a "stateless dumb pipe"; the code is a stateful message broker with policy enforcement

`BOUNDARY.md` states telepty does NOT own: message queue/retry/ordering, session recovery/persistence, output parsing, cross-session routing, report semantics ("telepty = stateless dumb pipe ... moves bytes ... All higher-level semantics ... are the responsibility of the layer above"). The shipped code implements **every one of those**:

| BOUNDARY.md "does NOT own" | What actually exists | Evidence |
|---|---|---|
| "no retry logic, no queue, no ordering guarantees" | Full file-backed mailbox: enqueue/dequeue/ack/nack, exponential-backoff retry, TTL expiry, dead-letter queue, FIFO ordering | `src/mailbox/index.js` (395 LOC), `src/mailbox/delivery.js` (193 LOC), `protocol/mailbox.md` |
| "sessions are in-memory; a daemon restart loses all sessions" | Sessions persisted to disk and restored on daemon startup | `src/session-store/persistence.js`; `daemon.js:1760-1767` (restore loop), persist calls at `daemon.js:130-136, 1742, 1938, 2059, 2139, 3273, 3281, 3364, 4055`; `test/session-store-persistence.test.js` |
| "telepty streams raw bytes; callers parse meaning" | Prompt-glyph detection per CLI, REPL-readiness gating, echo/settle detection, body-visibility confirmation | `src/prompt-symbol-registry.js:16-103`; `src/submit-gate.js:51-160`; `daemon.js:2682-2762` |
| "cross-session routing ... belongs to the caller or an orchestration layer above" | Reverse-match REPORT classification routing, peer-lane fan-out blocking | `daemon.js:2954-2992`, `daemon.js:2270-2403` |
| (implied: no orchestration policy) | pendingReports registry, auto-report firing on idle/dead transitions, idle-TTL reaper | `daemon.js:70-127, 282-507, 2994-3010, 3815-4100` |

This is not one violation; it is a **systemic divergence between the component's declared identity and its implementation**. Either reading is a HARD problem:

- If BOUNDARY.md is authoritative → ~2,500+ LOC of orchestration-layer logic lives inside telepty (§3/§4 violations, extraction required).
- If the code is authoritative → BOUNDARY.md is dead governance text that every reviewer and ADR (e.g. the broker ADR cites it) is reasoning from incorrectly.

**Recommendation:** Escalate to orchestrator as a constitutional decision (already flagged in REPORT): either (a) formally amend BOUNDARY.md to define telepty as a "session transport + delivery-assurance layer" and re-draw the line above it, or (b) extract mailbox / report-enforcement / submit-gating into the orchestration layer over a phased plan. Do NOT continue landing features against a boundary document that no longer describes the system.

### RISK 2 (critical) — God-file `daemon.js`: 4,154 LOC, ~22 distinct concerns

`daemon.js` mixes: HTTP/WS server, PTY spawn, session registry, bootstrap operation queue (`daemon.js:1044-1183`), inject delivery + output ring (`1493-1650`), submit gating with retry loop (`2533-2806`), report enforcement (`282-507`), REPORT reverse-matching (`2954-2992`), persistence (`130-136`), deliberation-thread tracking (`3518-3700`), broker mounting (`3697-3810`), idle-TTL reaper + surface GC (`3815-4100`). `cli.js` is the same pattern at 3,824 LOC / ~18 concerns (terminal I/O, auth, broker ACL, discovery, daemon lifecycle control, interactive menus, SSH/HTTP relay, bus listener).

Cohesion is low; any change to submit semantics, report policy, or lifecycle policy lands in the same 4K-line file. Note: ADR 2026-05-30 Wave 2 ("decompose god-modules") is **in progress** — `src/` extraction exists and daemon.js mostly delegates rather than duplicates (good) — but the policy clusters above were extracted *into* telepty's `src/`, not *out of* telepty.

**Recommendation:** Continue Wave 2 with an explicit target decomposition: `daemon-core` (HTTP/WS + PTY + bus, ~1,000 LOC), with report-enforcement, submit-gate orchestration, bootstrap queue, and TTL policy as separately-owned modules whose final home depends on the RISK 1 decision. cli.js: extract the interactive-UI layer from the daemon-control/client layer.

### RISK 3 (major) — Governance docs are stale: 2 ADRs claim "NO implementation" for shipped, tested features; AGENTS.md omits ~28 modules

- `docs/adr/2026-06-08-cross-machine-relay-broker.md:3` — "Status: Proposed (SPEC-FIRST — awaiting user approval; NO implementation in this dispatch)". Reality: broker is fully implemented (`src/transport/broker-server.js`, `broker-client.js`, `broker-protocol.js`), CLI-wired (`cli.js:1070-1114` broker ACL, `cli.js:243-261` handshake), daemon-wired (`daemon.js:3697-3810`), with 7+ test files in the npm test list.
- `docs/adr/2026-06-09-inject-provenance-trust-model.md:3` — same "NO implementation" status. Reality: `src/audit/inject-log.js`, `src/audit/provenance.js` exist with 4+ provenance/audit test files (partial implementation — banner prepend and session-token validation not yet visible).
- `AGENTS.md` architecture table lists 8 files; reality has ~28 additional substantial modules undocumented: the entire `src/` tree (mailbox, transport/broker, bridge/supervisor IPC, audit, submit-gate, lifecycle, session-store), plus `session-state.js` (639 LOC FSM), `cross-machine.js` (621 LOC), `terminal-backend.js` (525 LOC), `mcp-server/`.

The ecosystem's spec-first / doc-driven workflow depends on ADR status fields being true. Two consecutive ADRs whose headers contradict the tree means reviewers and future architects reason from false premises.

**Recommendation:** Update both ADR status headers (Implemented / Partially Implemented + landing date or addendum); expand AGENTS.md architecture table by subsystem (transport, bridge, mailbox, audit, gating, lifecycle); state Phase status of the supervisor bridge.

---

## 1. Role violations (헌법 §3) — telepty's role: cross-layer resolution, session/machine/OS connection. Forbidden: UI rendering, memory storage

| # | Severity | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| 1-1 | critical | **Session persistence to disk** — directly forbidden by both the constitution (기억 저장 금지) and BOUNDARY.md ("in-memory; restart loses all sessions") | `src/session-store/persistence.js` (save/load/restore); `daemon.js:1760-1767` startup restore; 9 persist callsites; `test/session-store-persistence.test.js` | Decide per RISK 1: amend boundary or move persistence to orchestration layer (thin reconnect protocol instead) |
| 1-2 | critical | **Mailbox = message-broker role** — queue/retry/ack/dead-letter is orchestration-layer messaging, not session/OS connection | `src/mailbox/` (~1,000 LOC across index/storage/delivery/notifier/config); `protocol/mailbox.md` documents FIFO + idempotency + DLQ guarantees | Extract to orchestrator-owned service, or formally re-scope telepty as delivery-assurance layer |
| 1-3 | critical | **Report enforcement = orchestration policy** — daemon tracks which session owes a REPORT to whom, fires auto-reports, classifies report prompts | `daemon.js:70-127` (transition listener), `:282-507` (pendingReports + fireAutoReport), `:2954-2992` (reverse-match), `:2994-3010` (pending tracking); `src/report-enforcement.js:35-73` (prompt classification + outputRing summarization) | Report policy belongs to the orchestrator; telepty should at most emit raw events the orchestrator interprets |
| 1-4 | major | **UI rendering: blessed TUI dashboard** — full terminal UI framework (screen, session list rendering, live event log) inside the "nervous system" repo | `tui.js` (538 LOC, `blessed.screen()`, `TuiDashboard`); invoked from `cli.js` `tui`/`dashboard` command | Move to the UI-owning component of the ecosystem, or ship as a separate optional package; telepty exposes the bus, others render it |
| 1-5 | major | **Memory storage: shared-context file store** — writes/TTL-manages content files under `~/.telepty/shared/` and builds `[context-ref]` prompts | `shared-context.js:50-96` (ensure/cleanup files, 7-day TTL), `:132-137` (prompt construction); used by `cli.js`, `cross-machine.js` | Context/memory caching is orchestration- or memory-component territory; telepty should pass references, not own the store |
| 1-6 | major | **Output interpretation cluster** — prompt-glyph regexes per CLI brand (claude `❯`, codex `›`), REPL-ready gating, echo/settle detection | `src/prompt-symbol-registry.js:16-103`, `src/submit-gate.js` (563 LOC), call sites `daemon.js:2682-2732` | See note below — resolve consistently with `session-state.js` |

**Internal inconsistency to resolve:** `session-state.js` (639 LOC, output→8-state FSM) is the same *class* of behavior as the prompt-symbol/submit-gate cluster (parsing PTY output to infer meaning), yet the team treats the FSM as core telepty and BOUNDARY.md forbids "output parsing" outright. Pick one line: either output→state inference is in-scope "cross-layer resolution" (then amend BOUNDARY.md and findings 1-6 reduce to cohesion issues), or it is out of scope (then the FSM goes too). The current half-and-half is what lets boundary creep continue.

## 2. Boundary violations (헌법 §4 — duplicate implementation / fat-where-thin / SSOT)

| # | Severity | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| 2-1 | major | **Dormant Rust duplicate of cross-machine.js** — `crates/telepty-cross-machine` has feature parity (peers, addressing, HTTP transport, inject subcommands) with the shipped `cross-machine.js` (621 LOC) but is never spawned or invoked from any JS code; not in package.json `files` | `crates/telepty-cross-machine/src/` (peers.rs, addressing.rs, http_transport.rs, main.rs + 6 test files); zero invocation hits in cli.js/daemon.js/install.js; ADR 2026-05-30 explicitly rejected Rust migration "today" | Archive the crate (or move behind an explicit phase-gated ADR with activation criteria). Two parallel implementations of cross-machine logic = SSOT violation waiting to drift |
| 2-2 | major | **Mailbox retry/ordering duplicates transport-layer concerns** — broker-client already implements reconnect+backoff+dedup (`src/transport/broker-client.js:15-50`); mailbox implements its own retry/backoff/ordering on top | `src/mailbox/delivery.js` (backoff 5s×2^n) vs `src/transport/broker-client.js` reconnect/dedup | If mailbox survives the RISK 1 decision, define one retry layer; the other becomes pass-through |
| 2-3 | minor | **Two spec locations** — root `specs/` (`enforce-report-spec.md`, `codex-inject-spec.md`) coexists with `docs/specs/` (7 files) | `specs/` vs `docs/specs/` directory listing | Consolidate into `docs/specs/`; leave a pointer if external links exist |
| 2-4 | note (compliant) | `skill-installer.js` is a **named legacy exception** properly governed by ADR 2026-05-05 §6.2.1 with scope limits and migration triggers documented in AGENTS.md | `AGENTS.md` "Legacy exception" section; `skill-installer.js` (305 LOC) | No action; this is the model for how exceptions should be documented |

## 3. Coupling / cohesion

- **God-files (2):** `daemon.js` 4,154 LOC / ~22 concerns (critical), `cli.js` 3,824 LOC / ~18 concerns (major). Detailed cluster maps in RISK 2. Largest extracted module is `src/submit-gate.js` at 563 LOC — i.e., the decomposition wave has so far peeled ~14% of the two God-files.
- **Positive:** no logic duplication *between* daemon.js and cli.js — cli.js is a proper HTTP/WS client of the daemon (verified: discovery vs alias-resolution are different scopes, `cli.js:644-668` vs `daemon.js:1795-1818`). `src/` modules are small, single-purpose, and properly delegated to (no inline duplicates of extracted logic found).
- **Minor:** `cli.js:1066,1117` does `require('./daemon.js')` to launch the daemon in-process. Deliberate and guarded (`daemon.js:3747` entry guard keeps bare require side-effect-free), but it transitively couples the CLI to the entire server dependency tree. Acceptable; document it as the sanctioned launch path.
- **tui.js → auth.js only** (loose, good); `src/transport`, `src/bridge`, `src/mailbox` have clean internal layering (client/server → protocol; shim → ipc).

## 4. Circular dependencies

**None.** Programmatic require-graph analysis over all non-test JS (39 edges) found **0 real cycles**. Three self-edges flagged by the scanner (`cli.js→cli.js`, `daemon.js→daemon.js`, `session-state.js→session-state.js`) were verified to be false positives — the literal string `require('./cli.js')` etc. appearing in *comments* (`cli.js:3811`, `daemon.js:3747` area, `session-state.js:14`). The dependency graph is a clean DAG: `cli.js`/`daemon.js` at the top, `src/*` leaves below. The Rust workspace (supervisor-bin → supervisor-core; cross-machine standalone) is also acyclic.

## 5. Over-engineering / abstraction boundaries (헌법 §1)

| # | Severity | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| 5-1 | major | **Speculative Rust crate** (`telepty-cross-machine`) — built, tested, never wired; pure forward-bet against an ADR that rejected the migration | see 2-1 | Archive; reinstate only behind explicit activation criteria |
| 5-2 | major | **Mailbox broker semantics** — dead-letter queue, idempotency keys, FIFO guarantees, advisory locking for a system whose own boundary doc says "no queue". Even if re-scoped, DLQ+idempotency may exceed actual need ("이거 없이 직접 구현 가능?") | `src/mailbox/` 5 files ~1,000 LOC; `protocol/mailbox.md` 245 LOC | If kept: justify each guarantee against a real consumer; strip unused ones |
| 5-3 | minor | Single-caller modules: `src/cli/session-view.js` (100 LOC, only cli.js), `src/init/print-snippet.js` (114 LOC, only cli.js + fixture script) | import scan | Borderline-acceptable (testability); keep but don't multiply the pattern |
| 5-4 | note (compliant) | **Supervisor bridge is NOT over-engineered** — 3 small stdlib-only modules (`supervisor-launcher.js`, `supervisor-ipc.js`, `j3-shim.js`), zero new npm deps, phased per L2 addendums; 375/375 tests green. The J3 shim is transitional — record its sunset condition | `src/bridge/` (~790 LOC); ADR 2026-05-23 P1/P2 addendums verified compliant | Add an explicit "delete j3-shim when Phase N lands" note to the plan |
| 5-5 | minor | **Repo-root hygiene** — stale working artifacts committed at root: 6 `.deliberation_request*.json` / `.cross_session_deliberation.json` (March), `aigentry-telepty-0.0.4.tgz`, `clipboard_image.png` (152KB), `monitor_*.log`, `.telepty_bus_events.log`, `test-pty.js` | root listing | Separate cleanup task (Rule 29: not touched in this audit); add to .gitignore |

## 6. ADR / documentation compliance

| ADR / doc | Status claimed | Reality | Verdict |
|---|---|---|---|
| 2026-05-23 P1 addendum (supervisor core) | Landed | Crate modules + 42/42 tests match (wire.rs Resume/from_seq, ipc.rs replay, kill-gate, E1 bench) | ✅ compliant |
| 2026-05-23 P2 addendum (Node↔Rust bridge) | Landed | BridgeClient/j3-shim/launcher + cli.js wiring (`cli.js:915-931` list merge, `:1755-1771` bridge-first inject) match | ✅ compliant |
| 2026-05-30 tech-stack (stay Node; typing+decompose+integration test) | Accepted | `test/integration/daemon-launch.test.js` in suite; `tsconfig.json` + `npm run typecheck`; `src/` decomposition underway | ✅ compliant (Wave 2 incomplete — see RISK 2) |
| 2026-06-07 submit-via-PTY | Accepted | Single PTY submit path, PTY-native confirm, aterm exclusion all verified (`daemon.js:1474-1489, 1241-1278`) | ✅ compliant |
| **2026-06-08 broker** | **"Proposed — NO implementation"** | **Fully implemented + 7 test files + CLI/daemon wiring** | 🚨 **stale status — critical doc-integrity gap** |
| **2026-06-09 provenance** | **"Proposed — NO implementation"** | **Partially implemented** (`src/audit/` + 4 test files; banner/session-token portions not found) | 🚨 **stale status — major** |
| AGENTS.md architecture table | 8 modules | ~28 substantial modules undocumented (entire `src/` tree, session-state.js, cross-machine.js, terminal-backend.js, mcp-server/) | 🚨 **major gap** |
| BOUNDARY.md | "stateless dumb pipe" | Contradicted on 5 of its own bullet points (see RISK 1) | 🚨 **critical** |

## Summary counts

- **역할 침범 (§3):** 6 findings (3 critical, 3 major) — top: mailbox, session persistence, report enforcement
- **경계 위반 (§4):** 3 findings + 1 compliant note (2 major, 1 minor) — top: dormant Rust cross-machine duplicate
- **순환 의존:** 0 (verified false positives excluded)
- **God-file:** 2 (`daemon.js` 4,154 LOC max; `cli.js` 3,824 LOC)
- **오버엔지니어링 (§1):** 4 findings (2 major, 2 minor) + 1 compliant note
- **ADR/문서 불일치:** 4 (BOUNDARY.md critical, ADR-0608 critical, ADR-0609 major, AGENTS.md major)

## Recommended sequencing (implementation = separate coder dispatches; architect recommends only)

1. **Decision first (orchestrator):** resolve RISK 1 — amend BOUNDARY.md vs extract features. Every other refactor's direction depends on this. (No code; ADR amendment.)
2. **Doc truth restoration (cheap, immediate):** fix ADR 2026-06-08/06-09 status headers; expand AGENTS.md table; consolidate `specs/` → `docs/specs/`.
3. **Decomposition Wave 2 continuation:** extract report-enforcement state, bootstrap queue, TTL/surface policy out of daemon.js per the RISK 1 decision; target daemon-core ≤ ~1,500 LOC.
4. **§4 cleanup:** archive `crates/telepty-cross-machine` (or gate it); de-duplicate mailbox-vs-transport retry.
5. **Hygiene:** root artifact cleanup + .gitignore (separate task).
