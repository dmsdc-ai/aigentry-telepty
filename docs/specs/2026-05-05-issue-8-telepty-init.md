# Spec: Telepty Issue #8 — `telepty init --print-snippet`

| Field | Value |
|---|---|
| **Status** | DRAFT — awaiting user approval before implementation |
| **Issue** | #8 (`telepty init` for AGENTS.md/CLAUDE.md/GEMINI.md graceful integration) |
| **Authoring date** | 2026-05-05 |
| **Authoring session** | aigentry-telepty (issue #8 dispatch) |
| **Dispatch envelope** | `~/.telepty/shared/bc208165370fee6bcce1d5cb28b0e32b188636f5b0bb74b1bd14dc0a34dde6e9.md` (also `/tmp/aigentry-dispatch/issue-8-telepty-init.md`) |
| **Binding ADR** | `~/projects/aigentry-orchestrator/docs/adr/2026-05-05-telepty-devkit-boundary.md` (commit `e4b072b`, status ACCEPTED) |
| **Protocol surface** | `telepty-snippet/v1` |
| **SSOT registry** | `~/projects/aigentry-ssot/contracts/telepty-snippet-v1.md` (created by this PR — Option B atomic delivery) |
| **Telepty version target** | `@dmsdc-ai/aigentry-telepty` ≥ 0.3.5 (next minor, additive) |
| **Workflow gate** | SAWP Rule 24 — SPEC FIRST. NO implementation before user approval. |

---

## §1 Background & dispatch context

Issue #8 introduces `telepty init` so users can graft a telepty-baseline reference into their per-CLI agent files (`~/CLAUDE.md`, `~/AGENTS.md`, `~/GEMINI.md`). The Boundary ADR (commit `e4b072b`) splits this across two repos:

- **Telepty owns the snippet content + emit mechanism** — `telepty init --print-snippet` writes versioned, sha256-hashable canonical text to stdout. **No file I/O.**
- **Devkit owns all per-AI-CLI file editing** — `aigentry scaffold --integrate-telepty` consumes the stdout and performs the idempotent sentinel-bracketed insertion.

This spec covers the telepty side only. Devkit's `--integrate-telepty` is a separate dispatch (Phase 3 follow-up under aigentry-devkit ownership; tracked at ADR §3.1.1.3).

**Pre-flight gate audit (M0, §6.5.1):** at spec-author time, this session observed:
- G1 (`telepty-snippet/v1` SSOT stub) — ABSENT before this PR. **This PR creates it** (Option B atomic delivery, confirmed by user).
- G7 (telepty README receiver-side cleanup) — failing (line 155 still names `telepty install hooks`). **Out of scope here**; needs a separate doc-only PR per ADR §3.1.2.5.

The orchestrator must either accept G1 closure as part of this PR's merge or close G7/G8/G9 in parallel. This spec ships G1 only; the other M0 doc gates are flagged for the orchestrator's separate dispatches.

---

## §2 Decision (locked)

`telepty init` ships a single subcommand in v1: `--print-snippet`. The CLI surface is:

```
telepty init --print-snippet [--target {claude|agents|gemini|all}] [--format {markdown|json}]
```

with stdin never consumed, stderr reserved for warnings only, and exit codes per ADR §3.1.1.2 (`0` success / `2` unsupported target / `3` legacy "command not found" / `4` internal failure).

The canonical body content is locked in this spec's normative appendix (§A). Body content is **identical across all three targets except the section header line** (`## telepty-snippet:<target>`). Per §3.4 row 1 + Article 3, telepty does not encode CLI-specific placement guidance ("paste this into CLAUDE.md vs AGENTS.md") — that is devkit's territory.

---

## §3 UX & CLI surface

### §3.1 Invocation matrix

| Invocation | Output |
|---|---|
| `telepty init` (no flags) | One-line help: `usage: telepty init --print-snippet [--target ...] [--format ...]`; exit 0. |
| `telepty init --print-snippet` | All three sentinel-bracketed markdown sections concatenated in order claude → agents → gemini; exit 0. |
| `telepty init --print-snippet --target claude` | Single sentinel envelope for `target=claude`; exit 0. |
| `telepty init --print-snippet --target agents` | Same shape, `target=agents`. |
| `telepty init --print-snippet --target gemini` | Same shape, `target=gemini`. |
| `telepty init --print-snippet --target all --format json` | 3 NDJSON lines, one per target, schema `{version,target,sha256,body}`. |
| `telepty init --print-snippet --target zsh` | Exit 2; stderr: `error: --target must be one of claude, agents, gemini, all`. |
| `telepty init --help` | Same help line as `telepty init`; exit 0. |
| Stdin piped to any invocation | Stdin is closed/ignored; output unchanged. |

### §3.2 stdout sentinel envelope (markdown)

Per ADR §3.1.1.1 row "stdout — envelope":

```
<!-- telepty-snippet/v1 BEGIN target=<name> sha256=<hex8> -->
<body — UTF-8, LF-only, no CRLF>
<!-- telepty-snippet/v1 END target=<name> -->
```

Empty newline between consecutive envelopes when `--target=all`. The 8-character `sha256=<hex8>` is the first 8 hex chars of the sha256 of the body bytes (between BEGIN and END sentinels, *excluding* the sentinel lines themselves and the surrounding newlines).

### §3.3 stdout NDJSON form (--format json)

```
{"version":"telepty-snippet/v1","target":"claude","sha256":"<full-64-hex>","body":"<markdown text with literal \n>"}
```

One line per target. `sha256` here is the **full** 64-char digest (NOT truncated 8-char) — devkit consumers can compare with `--format markdown`'s 8-char prefix via `digest.slice(0,8)`.

### §3.4 stderr policy

- Warnings only. Never errors. Never status messages.
- Allowed warnings (v1 enumeration):
  - `warn: telepty version <X.Y.Z> emits telepty-snippet/v1 forward-compat lines; consumers expecting strict v1 line set may see additive content.` (when telepty version exceeds the version range it was last fixture-pinned to.)
- Tee-safe: devkit consumers may redirect stderr to a log file without affecting stdout pipeline integrity.

### §3.5 Exit codes (per ADR §3.1.1.2 — paraphrased)

| Code | Meaning |
|---|---|
| 0 | Success — snippet emitted to stdout |
| 2 | Unsupported `--target` value |
| 3 | Telepty version older than `--print-snippet` introduction (legacy telepty, command not found); consumers detect shell exit 127 OR exit 3 |
| 4 | Internal failure (snippet generation error, e.g., template file unreadable) |

`v1` MAY add new non-zero codes; consumers MUST treat any non-zero as fail-closed (refuse to write into user files).

---

## §4 Boundary respect — verbatim ADR cites

### §4.1 Files telepty TOUCHES

| Path | Why telepty owns it | ADR rule |
|---|---|---|
| `src/init/print-snippet.js` (new) | Transport+protocol primitive (stdout contract). | §3.1 rule 1 — "Telepty owns transport/runtime primitives and normative protocol semantics." |
| `src/init/snippets/{claude,agents,gemini}.md` (new) | Telepty-self reference content describing its own CLI/protocol surface. | §3.1 rule 2 — "Telepty may own reference content only when it documents telepty's own CLI/protocol surface." |
| `cli.js` (modified — `init` dispatch block) | Telepty's CLI surface. | §3.2 row 1 (transport primitives) |
| `tests/snippet-protocol/v1/golden-{claude,agents,gemini,all}.md` and `.json` (new) | Conformance fixtures (telepty-side). | §3.1.1.4 — "Telepty repo: `tests/snippet-protocol/v1/golden-*` fixed-output snapshot tests." |
| `package.json` `scripts.regen-fixtures` (new) | Fixture maintenance pattern (OC-2=B). | implementation choice; not ADR-mandated |
| `~/projects/aigentry-ssot/contracts/telepty-snippet-v1.md` (new, cross-repo) | SSOT registry stub for `telepty-snippet/v1` (G1 gate artifact). | §6.5/§6.5.1 G1 |

### §4.2 Files telepty HANDS OFF (devkit-owned)

| Path | Why devkit owns it | ADR rule |
|---|---|---|
| `~/CLAUDE.md`, `~/AGENTS.md`, `~/GEMINI.md` editing | "All mutation of user/project files." | §3.1 rule 3 |
| Sentinel `<!-- BEGIN telepty setup v1 -->`…`<!-- END -->` insertion | Devkit-owned consumer-side sentinel labels. | §3.1.1.3 row "Sentinel labels (file edit)" |
| `--dry-run`, `--backup`, `--uninstall` of file edits | Devkit-side flags on `aigentry scaffold --integrate-telepty`. | §3.1.1.3 |
| Idempotency-via-sha256 detection on disk | Devkit consumer logic. | §3.1.1.3 row "Idempotency" |

### §4.3 Verbatim ADR §3.5 / §3.4 / §3.3.1.5 citations

Reproduced for the spec record (and to satisfy the dispatch envelope's "verbatim cite" requirement):

> **§3.4 row 1 (issue #8 placement):** "telepty exposes stable stdout contract (versioned snippet); devkit consumes it. **No file editing in telepty.**"

> **§3.5 codex-conditions table, row 1:** "Contract spec gate: before #8/#10.2/#3 implementation, publish SSOT entries and conformance fixtures for `telepty-snippet/v1`, `[context-ref/v1]`, `telepty list --json`, and `--scaffold`." (RESOLVED at §3.1.1, §3.1.2, §3.3.1, §6.5.)

> **§3.3.1.5 (what telepty MUST NOT do):** "Telepty CI MUST pass on a clean machine without devkit installed (Article 9 / §8 M3). Telepty's core test suite MUST NOT invoke `aigentry scaffold` for any non-`--scaffold` codepath."

### §4.4 §3.1 4-rule self-test (first match wins)

Apply rules 1→2→3→4 to each new artifact:

- `src/init/print-snippet.js` → **rule 1 match** (transport primitive: stdout contract). STOP.
- `src/init/snippets/*.md` → rule 1 no (not transport itself); **rule 2 match** (telepty-self reference content). STOP.
- `tests/snippet-protocol/v1/*` → rule 1 match (conformance fixtures for protocol semantics). STOP.
- `aigentry-ssot/contracts/telepty-snippet-v1.md` → registry stub; placement fixed by §6.5 (cross-repo to ssot, not telepty proper); not subject to §3.1 rules.

No artifact triggers two rules; no artifact requires decomposition.

---

## §5 Graceful integration — explicitly NOT telepty's concern

The dispatch envelope's question (c) ("Graceful integration: merge strategy when AGENTS.md/CLAUDE.md/GEMINI.md already exist. NEVER overwrite.") is answered by the boundary itself: **telepty performs zero file I/O in this issue.** The merge strategy is owned by devkit's `aigentry scaffold --integrate-telepty`, fully specified at ADR §3.1.1.3:

| Aspect | Devkit specification (reference) |
|---|---|
| Sentinel format | `<!-- BEGIN telepty setup v1 sha256=<hex8> -->` … `<!-- END telepty setup v1 -->` |
| First-time write | Append section at EOF; create file if absent (mode 0644). |
| Re-run, identical body sha256 | No-op. |
| Re-run, different body sha256 | In-place replacement (with `--backup` writes `.bak.<ISO8601>`). |
| `--dry-run` | Print intended diff; modify nothing; exit 0 if would-change, exit 1 if no-change. |
| `--uninstall` | Remove sentinel-bracketed section; backup always ON. |
| Failure if telepty missing/broken | Refuse to write; print actionable error; exit 4. |

**Telepty's contribution** to making the merge possible: a stable, sha256-hashable byte sequence per target. That's the entirety of the mechanism contribution. Invariant I1 (boundary direction LOCKED) and I2 (NEVER overwrite existing files) are upheld by **not touching files at all**.

---

## §6 Mechanism contract — handoff to devkit

### §6.1 Subprocess invocation (devkit side, reference)

Per ADR §3.1.1.3 row "Subprocess":

```js
const { spawn } = require('node:child_process');
const child = spawn(
  'telepty',
  ['init', '--print-snippet', '--target', target, '--format', 'markdown'],
  { stdio: ['ignore', 'pipe', 'pipe'] }   // stdin ignored — matches §3.1.1.1 row "stdin"
);
```

- **Timeout:** 10 seconds (devkit responsibility; not enforced telepty-side).
- **Stdin:** ignored. Telepty is contractually required NEVER to read stdin.
- **Exit:** non-zero → devkit fail-closed (refuse to write user file).

### §6.2 No env vars, no IPC, no file marker

- Telepty does NOT read environment variables to alter snippet content.
- No `~/.telepty/init.json` config consumed at print-snippet time.
- No daemon connection required (`telepty init` is daemon-free; runs on a clean machine).
- The full handoff channel is: argv in, stdout out, exit code out, stderr warnings out. POSIX-portable.

### §6.3 Article 17 / Article 9 compliance

- **Article 9 (independence):** `telepty init --print-snippet` runs on a fresh machine without devkit installed (it's a self-describing emitter; it does not call `aigentry`). M3 smoke test will exercise this.
- **Article 17 (zero external dep):** no new runtime npm dependency. Implementation uses node built-ins (`fs`, `crypto`, `process`).

---

## §7 Implementation plan

### §7.1 File layout (new)

```
src/init/
  print-snippet.js                # main implementation
  snippets/
    claude.md                     # canonical body — claude target
    agents.md                     # canonical body — agents target
    gemini.md                     # canonical body — gemini target
tests/snippet-protocol/v1/
  golden-claude.md                # snapshot of --target claude --format markdown
  golden-agents.md                # snapshot of --target agents --format markdown
  golden-gemini.md                # snapshot of --target gemini --format markdown
  golden-all.md                   # snapshot of --target all --format markdown
  golden-claude.json              # snapshot of --target claude --format json
  golden-agents.json              # snapshot of --target agents --format json
  golden-gemini.json              # snapshot of --target gemini --format json
  golden-all.json                 # snapshot of --target all --format json
test/
  init.test.js                    # node:test suite, 14 tests (§8)
docs/specs/
  2026-05-05-issue-8-telepty-init.md  # this spec
scripts/
  regen-snippet-fixtures.js       # OC-2=B: writes runtime stdout to fixture paths
```

### §7.2 cli.js dispatch (modified)

A new `if (cmd === 'init')` block at the same nesting level as existing `daemon`/`list`/`allow` dispatches (insertion point near `cli.js:861` group). Block delegates to `require('./src/init/print-snippet').main(args)` and propagates the returned exit code.

### §7.3 print-snippet.js skeleton (illustrative — not binding)

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const TARGETS = ['claude', 'agents', 'gemini'];
const SNIPPET_DIR = path.join(__dirname, 'snippets');

function loadBody(target) {
  return fs.readFileSync(path.join(SNIPPET_DIR, `${target}.md`), 'utf8');
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

function emitMarkdown(target, body) {
  const sha8 = sha256Hex(body).slice(0, 8);
  return `<!-- telepty-snippet/v1 BEGIN target=${target} sha256=${sha8} -->\n${body}<!-- telepty-snippet/v1 END target=${target} -->\n`;
}

function emitJson(target, body) {
  const sha = sha256Hex(body);
  return JSON.stringify({ version: 'telepty-snippet/v1', target, sha256: sha, body }) + '\n';
}

exports.main = function main(args) {
  // argv parser: --print-snippet (required for v1), --target <X>, --format <Y>
  // returns 0 on success, 2 on bad target, 4 on internal failure
};
```

### §7.4 Snippet body source-of-truth

Per OC-1=B, canonical body lives in `src/init/snippets/{claude,agents,gemini}.md`. The bodies are byte-equal *except* for the first line section header (`## telepty-snippet:<target>`). The locked content text appears in this spec's §A normative appendix. Implementer MUST byte-equal the §A text (including line endings) when authoring the three template files.

### §7.5 Conformance fixtures (OC-2=B)

`scripts/regen-snippet-fixtures.js` invokes the runtime emitter for each (target × format) combination and writes byte-equal output to `tests/snippet-protocol/v1/golden-*.{md,json}`. CI runs `npm test` which includes a step `git diff --exit-code tests/snippet-protocol/v1/` — any drift between runtime and fixture is a CI failure. Intentional snippet body changes flow through: edit `src/init/snippets/<target>.md` → run `npm run regen-fixtures` → commit both the source change and the fixture diff.

### §7.6 SSOT stub (G1 — cross-repo)

File: `~/projects/aigentry-ssot/contracts/telepty-snippet-v1.md`

Body shape:

```markdown
# Contract: telepty-snippet/v1

| Field | Value |
|---|---|
| Tag | `telepty-snippet/v1` |
| Owning repo | `aigentry-telepty` |
| Consuming repo | `aigentry-devkit` (via `aigentry scaffold --integrate-telepty`) |
| Spec doc | `aigentry-telepty/docs/specs/2026-05-05-issue-8-telepty-init.md` |
| ADR ref | `aigentry-orchestrator/docs/adr/2026-05-05-telepty-devkit-boundary.md` §3.1.1, §3.4 row 1 |
| Telepty fixtures | `aigentry-telepty/tests/snippet-protocol/v1/golden-{claude,agents,gemini,all}.{md,json}` |
| Devkit fixtures | `aigentry-devkit/tests/scaffold-integrate-telepty/v1/` (separate dispatch) |
| Deprecation policy | 14-day pre-announce + dual-emit during overlap (per §3.1.1.5) |
| Semver | additive within v1; breaking → v2 + 14-day announce |

(Section bodies inlined or link to spec doc as appropriate.)
```

Cross-repo PR coordination: a sibling PR to `aigentry-ssot` lands G1 stub; this telepty PR will not merge until G1 is referenced from the merged stub.

---

## §8 Test plan (TDD per superpowers)

All tests live in `test/init.test.js` (node:test, matching existing 17-file convention). Each item is a failing-test-first checkpoint per `superpowers:test-driven-development`.

### §8.1 Envelope/format (5)

1. `--target=claude --format=markdown` emits BEGIN line containing literal `target=claude` and matches `/sha256=[0-9a-f]{8}/`.
2. `--target=agents --format=markdown` ditto with `target=agents`.
3. `--target=gemini --format=markdown` ditto with `target=gemini`.
4. `--target=all --format=markdown` emits exactly 3 envelopes in order claude→agents→gemini, separated by an empty line.
5. `--format=json --target=all` emits exactly 3 NDJSON lines, each parses to `{version: "telepty-snippet/v1", target, sha256, body}`; the four keys exist and types are (string, string, hex string of length 64, string).

### §8.2 Body invariants (3)

6. For each target, body bytes contain none of: `$HOME`, `$(`, backtick (`` ` ``) outside fenced code blocks, literal `~` anywhere in body. (Defends §3.1.1.1 line 161 "no shell substitution.")
7. For each target, body is UTF-8 LF-only — `body.includes('\r')` is false.
8. For each target, two sequential `--print-snippet --target <X>` invocations produce byte-identical stdout. (§3.1.1.1 idempotency row.)

### §8.3 Exit codes (3)

9. `--print-snippet` (no other args) exits 0.
10. `--print-snippet --target zsh` exits 2; stderr matches `/--target must be one of claude, agents, gemini, all/`; stdout is empty.
11. Internal failure path (mock `fs.readFileSync` throws via stub or non-existent template path injection) exits 4; stderr non-empty; stdout empty.

### §8.4 stdin/stderr discipline (2)

12. Stdin closed/ignored at spawn — node:test spawns telepty as child with `stdio: ['pipe', 'pipe', 'pipe']`, immediately closes child stdin, child still exits 0 with full stdout. Verifies §3.1.1.1 stdin row.
13. No warnings on the happy path → stderr is empty for `--print-snippet --target claude`.

### §8.5 Golden snapshot (1)

14. `tests/snippet-protocol/v1/golden-{claude,agents,gemini,all}.{md,json}` (8 files) byte-equal the runtime emitter's stdout for the matching invocation. Test uses `fs.readFileSync` and `assert.strictEqual`. Test will fail if `git diff --exit-code tests/snippet-protocol/v1/` is non-empty after running `npm run regen-fixtures`.

### §8.6 Devkit-free path enforcement (1, M3 in-suite)

15. Run `telepty init --print-snippet --target all` in a child process with `PATH` filtered to remove any directory containing an `aigentry` executable; assert exit 0 and stdout matches the golden fixture. Defends Article 9 / §8 M3 inside the test suite (not just narratively).

**Total: 15 tests.** All run under `npm test` (node:test runner, devkit-free per Article 9 / M3).

### §8.7 Cross-cutting verification

- `npm test` runs to green on a clean checkout without `aigentry` on PATH (M3) — enforced by test 15 (§8.6) plus narrative external smoke.
- Telepty CI does not invoke `aigentry scaffold` (§3.3.1.5).

---

## §9 G-gate contribution (§6.5.1 audit)

| Gate | Contribution | Verification (post-merge) |
|---|---|---|
| **G1** | ✅ DIRECT — this PR's cross-repo sibling lands `aigentry-ssot/contracts/telepty-snippet-v1.md`. | `test -f ~/projects/aigentry-ssot/contracts/telepty-snippet-v1.md && grep -q 'telepty-snippet/v1' ~/projects/aigentry-ssot/contracts/telepty-snippet-v1.md` |
| **G2** | ❌ none — `[context-ref/v1]` is #10.2 scope. |
| **G3** | ❌ none — `scaffold/v1` is devkit (#3) scope. |
| **G4** | ❌ none — `scaffold-shim/v1` is `--scaffold` flag work, separate. |
| **G5** | ❌ none — `telepty-list-json/v1` is a separate surface. |
| **G6** | ❌ none — `posix-command-v-aigentry` is `--scaffold` shim concern. (Dispatch envelope's "likely G1/G6" prediction is corrected here: G6 is not contributed by this PR.) |
| **G7** | ❌ none — telepty README cleanup is a separate doc-only PR per §3.1.2.5. |
| **G8** | ❌ none — telepty AGENTS.md legacy-exception subsection is separate per §6.2.1. |
| **G9** | ❌ none — `skill-installer.js` legacy header is separate per §6.2.1.3. |
| **M3** | ✅ INDIRECT — `telepty init --print-snippet` is exercised on devkit-free CI. |
| **M6** | ✅ DIRECT — ships `tests/snippet-protocol/v1/golden-*` (8 fixture files), unblocking the §3.1.1.4 conformance set. |

---

## §10 Out-of-scope (explicit)

The following are NOT in this issue, NOT in this PR, and any drift toward them constitutes scope creep that must be split:

1. **No file I/O on user files** (`~/CLAUDE.md`, `~/AGENTS.md`, `~/GEMINI.md`). Devkit owns this (#3 / `--integrate-telepty`).
2. **No interactive UX** (no readline, no tty prompt, no `--yes`/`--no` confirmation flow).
3. **No `[context-ref]` hook installation** — that is issue #10.2, separate dispatch (devkit-side `aigentry scaffold install-hooks <cli>`).
4. **No project-scope `CLAUDE.md` / `.claude/settings.json` scaffolding** — that is issue #3, separate dispatch (devkit `aigentry scaffold --project`).
5. **No `telepty install hooks` resurrection** — explicitly rejected by ADR §3.1.2 / §3.4 row 2.
6. **No `--scaffold` shim work** (`scaffold-shim/v1`) — that is the §3.3.1.2 follow-up, separate.
7. **No `telepty list --json` schema work** — that is its own surface (§3.6.1, §6.5.1 G5).
8. **No README §"Integration scope" cleanup (G7)**, **no AGENTS.md legacy exception subsection (G8)**, **no `skill-installer.js` header (G9)** — these are M0 doc-only PRs separate from this implementation work, per ADR §3.1.2.5 / §6.2.1.
9. **No new external runtime dependency** (Article 17 / M4).
10. **No content for unfamiliar CLIs** (e.g., `roo`, `cursor`) — v1 ships exactly the three documented targets. New CLI = MINOR additive within v1, but not in this PR.

Lessons honored:
- **F1** (past article-3 violations on session-scaffold logic in telepty): No telepty session-scaffold logic introduced; only stdout emitter.
- **F2** (aggressive merge/rewrite of dotfiles burns trust): No file I/O at all in telepty.
- **F3** (sub-issue creep): Item 3, 4, 6, 7, 8 above explicitly fence creep into #3 / #10.2 / G7-G9.

---

## §11 Risks & open questions

### §11.1 Risks

| ID | Risk | Mitigation |
|---|---|---|
| R1 | Snippet body content drifts as telepty evolves; sha256 churn breaks devkit's idempotency check on user files. | OC-2=B regen-fixtures gate + 14-day pre-announce policy (§3.1.1.1 versioning row). Body changes are deliberate, reviewed, and visible in PR diff. |
| R2 | G1 SSOT stub PR lands separately and lags telepty PR — cross-repo merge order race. | Ship G1 stub PR FIRST and require its merge SHA to be cited in this telepty PR description. CI gate on existence of stub at merge time. |
| R3 | Dispatch envelope's "G1/G6" prediction misled. Spec corrects to G1 + M6. | Surface deviation explicitly to orchestrator in §9 + REPORT envelope. |
| R4 | Devkit `aigentry scaffold --integrate-telepty` PR not yet authored — telepty users may run `--print-snippet` and have no consumer. | Acceptable: telepty's stdout is self-documenting and a user can hand-paste between sentinels. Coordinate devkit dispatch as Phase 3 follow-up (separate). |
| R5 | M0 gate composite still failing (G7/G8/G9) at merge time. | Out of scope here, but flag in the REPORT so orchestrator can dispatch their closures in parallel before the 7-day window expires (2026-05-12). |

### §11.2 Open questions (for user / orchestrator review)

- **OQ-A** — Should the G1 SSOT stub PR be co-authored from this session (single agent ships both repos) or dispatched as a sibling to a different session? **Author lean:** single agent ships both for atomic correctness; user has confirmed Option B which implies single-agent atomic.
- ~~**OQ-B**~~ — *Resolved by §3.1 invocation matrix row 1: `telepty init` with no flags prints help to stdout, exit 0. Help is a documented happy-path output, not an error.*
- **OQ-C** — Is the 8-char sha256 prefix in the markdown sentinel sufficient for devkit's idempotency check, or should the markdown form also carry the full 64-char digest in a comment? **Author lean:** 8-char is sufficient for tag-line collision detection (2^32 namespace, deterministic input set ≤ 3 targets); full digest is available via `--format json` if devkit needs it.

User/orchestrator: signal preferences on OQ-A/C in the approval round, or accept author-leans.

---

## §12 Self-review against ADR §3.1 4-rule sharpening

Per dispatch step 2, this section runs the 4-rule test on every artifact this PR introduces, in rule order, first match wins.

| Artifact | Rule 1 (transport) | Rule 2 (telepty-self ref) | Rule 3 (devkit territory) | Rule 4 (provisioning) | Verdict |
|---|---|---|---|---|---|
| `src/init/print-snippet.js` | ✅ stdout contract | — | — | — | **Telepty (rule 1).** |
| `src/init/snippets/{claude,agents,gemini}.md` | — (not transport itself) | ✅ documents telepty's own CLI/protocol | — | — | **Telepty (rule 2).** |
| `cli.js` `init` block | ✅ CLI surface | — | — | — | **Telepty (rule 1).** |
| `tests/snippet-protocol/v1/*` | ✅ protocol conformance fixtures | — | — | — | **Telepty (rule 1).** |
| `package.json regen-fixtures` script | ✅ test-tooling for protocol fixtures | — | — | — | **Telepty (rule 1).** |
| `aigentry-ssot/contracts/telepty-snippet-v1.md` | — (not in telepty repo) | — | — | — | **SSOT registry (separate repo); placement fixed by §6.5.** |

No artifact triggers rule 3 (devkit territory). No artifact triggers two rules → no decomposition needed. Boundary direction respected.

---

## §A Normative appendix — canonical snippet body (LOCKED)

The three target template files MUST byte-equal the corresponding text below, UTF-8 LF-only, including the trailing blank line. Body-byte sha256 (full 64 hex) is recorded for idempotency audit.

### §A.1 `src/init/snippets/claude.md`

```
## telepty-snippet:claude

**telepty** is the aigentry ecosystem's PTY multiplexer and session orchestrator. It allows wrapping AI CLI sessions under stable IDs and addressing them across local and cross-machine boundaries via a daemon-mediated transport.

Quick-start (5 commands):

    telepty daemon
    telepty allow --id <name> claude
    telepty list
    telepty inject <name> "<prompt>"
    telepty attach <name>

`telepty allow` wraps a CLI under the chosen `<name>`; `telepty list` enumerates known sessions; `telepty inject` sends a prompt to a wrapped session; `telepty attach` interactively connects to one.

Run `telepty --help` for the full command list. Run `telepty <command> --help` for per-command flags.
```

### §A.2 `src/init/snippets/agents.md`

Identical to §A.1 except line 1 reads `## telepty-snippet:agents`.

### §A.3 `src/init/snippets/gemini.md`

Identical to §A.1 except line 1 reads `## telepty-snippet:gemini`.

### §A.4 Per-target body sha256 (computed at first commit)

To be filled by implementation PR. Spec acceptance does not require these values; they are recorded in the conformance fixture filenames at test time and in the SSOT stub at merge time.

---

## §13 Implementation gate — explicit user-approval requirement

Per SAWP Rule 24 + dispatch step 3:

> Step 3. Commit spec to `~/projects/aigentry-telepty` + report to orchestrator. WAIT for user approval before implementation.

This spec is the deliverable for the SPEC FIRST gate. **No code lands until the user (via orchestrator) approves this spec.** After approval, implementation proceeds per `superpowers:test-driven-development` + `superpowers:writing-plans` with frequent commits, fixture regeneration via `npm run regen-fixtures`, and a final REPORT confirming all 15 tests green.

---

*End of spec.*
