# Issue #8 Claude Review of Codex Implementation (2026-05-05)

| Field | Value |
|---|---|
| Reviewer | Claude (cross-LLM rule — Codex impl → Claude review) |
| Implementer | Codex (`aigentry-telepty-coder-issue-8`, closed) |
| Range | `d7b8b21..d0f4495` (16 commits) + `aigentry-ssot@f4ff0cd` |
| Spec | `~/projects/aigentry-telepty/docs/specs/2026-05-05-issue-8-telepty-init.md` (commits 609092b → 8d2dc94) |
| Boundary ADR | `aigentry-orchestrator/docs/adr/2026-05-05-telepty-devkit-boundary.md` (e4b072b ACCEPTED) |
| Test result | 269/269 full suite PASS; 15/15 init suite PASS |
| Mode | Read-only audit per Invariant I1 |

---

## §1 Summary

- **Verdict:** **ACCEPT**
- **Top issue:** None blocking. Two non-blocking process observations (N1: TDD ordering, N2: version bump deferred to release).
- **Tests-pass / spec-fidelity gap:** **0 mismatches.** All 15 init tests map 1:1 to spec §8.1-§8.6 items; assertions match spec text (with one minor interpretation noted at §7.1).

---

## §2 Spec Fidelity Audit

| Check | Result | Evidence |
|---|---|---|
| CLI surface matches §3.1/§4 verbatim | PASS | `src/init/print-snippet.js:11` HELP string is `usage: telepty init --print-snippet [--target {claude\|agents\|gemini\|all}] [--format {markdown\|json}]` — byte-equal to spec §3.1 row 1 wording |
| argv-only, stdin closed | PASS | `cli.js:844` dispatches `runInit(args.slice(1))`; `print-snippet.js` never reads stdin; test 12 verifies stdin pipe payload is ignored |
| Exit codes 0/2/4 implemented (3 reserved-not-emitted) | PASS | `print-snippet.js:77,82,87,97,100`. Code 3 is "telepty too old" (only emitted by absent telepty itself; spec §3.5 confirms detection via shell exit 127 OR exit 3 — not by current telepty). |
| Default `--target=all --format=markdown` | PASS | `print-snippet.js:43-44` defaults; test 9 verifies |
| §3.2 markdown sentinel envelope | PASS | `print-snippet.js:28` emits `<!-- telepty-snippet/v1 BEGIN target=<t> sha256=<hex8> -->\n<body><!-- ... END target=<t> -->\n` matching spec §3.2 byte-for-byte |
| §3.3 NDJSON shape | PASS | `print-snippet.js:31-38` emits `{version,target,sha256,body}` with full 64-hex digest; test 5 verifies |
| §3.4 stderr policy (warnings only on happy path) | PASS | Test 13 asserts `result.stderr === ''` for `--target claude` |
| `--target=all` separator (empty line between envelopes) | PASS | `print-snippet.js:96` joins with `'\n'` (single LF after each envelope's trailing LF → blank line); test 4 asserts the `END target=claude -->\n\n<!-- telepty-snippet/v1 BEGIN target=agents` literal |

**8/8 fidelity checks PASS.**

---

## §3 Boundary ADR Audit

| Check | Result | Evidence |
|---|---|---|
| No file I/O on user dotfiles | PASS | `grep -nE 'writeFile\|writeFileSync\|appendFile\|chmod\|unlink' src/init/` returns zero matches; only `fs.readFileSync` of own `src/init/snippets/*.md` |
| No subprocess invocation of devkit | PASS | `grep -nE 'child_process\|spawn\|exec\|aigentry\|scaffold' src/init/print-snippet.js` returns zero matches; `aigentry` only appears as descriptive text inside snippet body (per §3.1 rule 2) |
| §3.4 row 1 "no file editing in telepty" | PASS | Verified by file-mutation grep above |
| §3.5 mechanism-vs-content split (telepty = mechanism) | PASS | Snippet bodies describe telepty's own CLI surface only (rule 2); zero per-CLI placement guidance ("paste this into CLAUDE.md…") in body or section headers |
| §3.3.1.5 telepty CI runs without `aigentry` | PASS | Manually verified: `env -i HOME=/tmp/empty PATH=/usr/bin:/bin:<node-dir> node cli.js init --print-snippet --target claude` → exit 0, full envelope emitted; test 15 enforces in-suite |

**Boundary ADR: PASS (5/5).**

---

## §4 OC Choice Verification

| Choice | Spec | Impl Evidence | Result |
|---|---|---|---|
| **OC-1=B** | snippet bodies in `src/init/snippets/{claude,agents,gemini}.md` (NOT inline JS, NOT JSON manifest) | Three files exist, `loadBody()` reads via `fs.readFileSync(path.join(snippetDir, '${target}.md'), 'utf8')` | PASS |
| **OC-2=B** | `npm run regen-fixtures` script + CI uses `git diff --exit-code` | `package.json:15` `regen-fixtures` script exists; `package.json:12,14` `test`/`test:ci` end with `&& git diff --exit-code tests/snippet-protocol/v1/` | PASS |
| **OC-3=A** | section header is mechanism-only (no per-CLI prelude) | Each `snippets/<t>.md` line 1 is `## telepty-snippet:<target>`; no "Add this block to AGENTS.md" prelude anywhere in body | PASS |
| **OQ-A** | G1 SSOT stub merged sibling cross-repo | `aigentry-ssot@f4ff0cd` adds `contracts/telepty-snippet-v1.md`; commit time 14:35:07 < final telepty commit 14:36:19 (correct atomic ordering); SSOT stub references spec doc URL | PASS |
| **OQ-C** | markdown=8-char sha256 prefix; JSON=64-char full digest | Markdown sentinel: `sha256=305aad81` (8 hex); JSON record: `"sha256":"305aad8181c1e75bb94589386cbc34f2b5103d6b5c1f6a7f01c99f1fbf6ed8c3"` (64 hex). Test 1 asserts `/sha256=[0-9a-f]{8}/`; test 5 asserts `/^[0-9a-f]{64}$/`. SSOT stub publishes the 64-hex hash table per target. | PASS |

**OC choices: 4/4 honored.** (OQ-A and OQ-C are bundled — count as 4 since orchestrator dispatch listed them as 4 distinct items; logical mapping = 5/5 if OQ-A and OQ-C are scored separately.)

---

## §5 Constitutional Audit

| Article | Check | Result |
|---|---|---|
| **1 경량** | No premature abstractions. Two helpers added beyond spec §7.3 skeleton: (a) `loadBody(target, options)` accepts `options.snippetDir` for test injection — justified by §8.3 test 11 spec text "non-existent template path injection"; (b) `cli.js` lazifies `getAuthToken()` — necessary so `init --print-snippet` works on a fresh machine with no `~/.telepty/config.json` (Article 9). Both are minimal seams, neither is speculative. | PASS |
| **3 역할** | Telepty does mechanism (stdout contract + sha256 envelope) only. Snippet body content describes telepty's own CLI surface — rule 2 of §3.1 4-rule sharpening. | PASS |
| **9 독립** | Verified manually: `env -i HOME=… PATH=…<no aigentry>… node cli.js init --print-snippet` exits 0 with full envelope. Test 15 enforces inside the test suite. | PASS |
| **15 SSOT** | `aigentry-ssot/contracts/telepty-snippet-v1.md@f4ff0cd` registered before final telepty commit; spec doc and ADR references present in stub. | PASS |
| **17 무의존** | `git diff d7b8b21 d0f4495 -- package.json` shows zero new entries under `dependencies`. Only test-runner additions and `regen-fixtures` script. | PASS |

**Constitutional: 5/5.**

---

## §6 Test Coverage vs Spec Map

15 init tests → spec §8.1-§8.6. All consistent.

| # | Test (file:line) | Spec § | Verdict |
|---|---|---|---|
| 1 | markdown for claude includes target+8-char sha256 (`init.test.js:94`) | §8.1.1 | ✓ literal |
| 2 | markdown for agents (`:102`) | §8.1.2 | ✓ literal |
| 3 | markdown for gemini (`:110`) | §8.1.3 | ✓ literal |
| 4 | markdown all = 3 envelopes ordered claude→agents→gemini, blank-line separator (`:118`) | §8.1.4 | ✓ literal — also asserts `END target=claude -->\n\n<!-- telepty-snippet/v1 BEGIN target=agents` |
| 5 | json all = 3 NDJSON typed records (4 keys, 64-char sha256) (`:132`) | §8.1.5 | ✓ literal — `Object.keys` deepEqual + per-key type assertions |
| 6 | bodies no shell-substitution hazards (`:149`) | §8.2.6 | ✓ semantic — see §7.1 below for interpretation note |
| 7 | bodies LF-only (`:162`) | §8.2.7 | ✓ literal |
| 8 | byte-identical sequential invocations (`:170`) | §8.2.8 | ✓ literal |
| 9 | print-snippet defaults exit 0, all/markdown (`:181`) | §8.3.9 | ✓ literal — also verifies default `--target=all` order |
| 10 | unsupported target → exit 2, stderr matches, empty stdout (`:192`) | §8.3.10 | ✓ literal — stderr regex `/--target must be one of claude, agents, gemini, all/` exact |
| 11 | internal failure → exit 4, empty stdout, stderr non-empty (`:200`) | §8.3.11 | ✓ literal — uses `snippetDir` injection (path-injection seam, matches spec wording "non-existent template path injection") |
| 12 | stdin pipe ignored, output unchanged (`:214`) | §8.4.12 | ✓ stronger — pipes `'ignored stdin payload\n'` before close (spec said only "immediately closes child stdin") |
| 13 | clean stderr happy path (`:224`) | §8.4.13 | ✓ literal |
| 14 | golden fixtures byte-equal × 8 (`:231`) | §8.5.14 | ✓ literal — `fs.readFileSync` + `assert.strictEqual` × 4 targets × 2 formats; `npm test` also runs `git diff --exit-code tests/snippet-protocol/v1/` per spec §7.5 |
| 15 | devkit-free PATH (`:245`) | §8.6.15 | ✓ literal — `pathWithoutAigentryExecutables()` filter + asserts exit 0 + `assert.equal(result.stdout, expected)` against `golden-all.md` |

**Map consistency: 15/15.** No test misreads its spec section. No orphan tests, no orphan spec items.

---

## §7 Cross-LLM Blind Spot Findings

### §7.1 Test 6 wording-stretch (NON-BLOCKING)

Spec §8.2 item 6 reads:

> "For each target, body bytes contain none of: `$HOME`, `$(`, backtick (`` ` ``) outside fenced code blocks, literal `~` anywhere in body."

The literal-strict reading of "backtick outside fenced code blocks" means **bare backticks should not appear at all** in the body (since the body has no fenced ```` ``` ```` blocks). However, the body does contain inline-code spans (single-backtick `<name>`, `telepty allow`, etc.) which are markdown-legitimate.

The test (`init.test.js:156-158`) takes the **security-intent reading**: backticks are allowed inside inline code spans, but the inline code content must not contain shell metacharacters `[$;|&]`:

```js
for (const inlineCode of body.matchAll(/`([^`\n]+)`/g)) {
  assert.doesNotMatch(inlineCode[1], /[$;|&]/);
}
```

This stretches the spec wording but preserves the spec's stated security intent ("Defends §3.1.1.1 line 161 'no shell substitution.'"). Without this interpretation, the spec would be self-contradictory — the canonical body in §A intentionally uses inline backticks. **Recommendation:** spec §8.2 item 6 should be amended to say "no shell metacharacters inside inline-code spans" rather than the literally-impossible "no backtick outside fenced code blocks." Not a blocker; existing implementation is correct in spirit.

### §7.2 `loadBody(target, options)` test seam (NON-BLOCKING)

`print-snippet.js:17` accepts an `options.snippetDir` parameter that is not in spec §7.3 skeleton. This is the path-injection seam used by test 11 (`init.test.js:206`) to drive the exit-code-4 internal-failure branch. Spec §8.3 item 11 explicitly mentions "non-existent template path injection" as the test mechanism, so the helper is justified. Codex tendency: lightly extends API surface for test ergonomics — here the extension is limited (one option, single call site) and warranted.

### §7.3 `cli.js` lazy `getAuthToken()` (NON-BLOCKING — actually defensible)

`cli.js` was changed to lazify `getAuthToken()` from a module-load-time `const TOKEN`. Without this change, `telepty init --print-snippet` would fail on a fresh machine (no `~/.telepty/config.json`). **This is a prerequisite for Article 9 / §8 M3 compliance**, not scope creep — the test 15 devkit-free path would otherwise fail. Side benefit: every CLI command that doesn't need the daemon now starts without touching the config. Net positive.

### §7.4 TDD ordering — spec procedural directive not honored at commit level (NON-BLOCKING)

Spec §8 says "Each item is a failing-test-first checkpoint per `superpowers:test-driven-development`." Commit log shows:

- `f5c6bad feat(init): emit claude markdown snippet` (introduces impl + 1 test as a single commit)
- 14 follow-up `test(init): …` commits adding tests after-the-fact

This is **test-after development packaged as TDD-style commits**, not red-green-refactor. All tests do pass, all spec items are covered, all assertions match spec text — so the **outcome** is identical to TDD. The **process** does not match spec wording. Codex tendency: optimizes for test pass speed by writing impl first, then back-filling tests in clean commits. Flagging for orchestrator awareness; not a correctness blocker.

### §7.5 Cross-repo coupling check

SSOT stub at `aigentry-ssot@f4ff0cd` and telepty PR are atomically deliverable (commit timestamps: SSOT 14:35:07 < final telepty 14:36:19). The SSOT stub references the spec doc path. Spec §7.6 also requires "telepty PR description cite SSOT SHA" — since these are local commits without a PR description yet, this requirement attaches to the eventual `git push` / PR creation step (out of this review's scope but flagged for the orchestrator's push action).

---

## §8 Code Quality Notes

- **Diff hygiene:** 16 commits, each test in its own commit (`test(init): …`). Excellent reviewability; bisect-friendly. Process flag at §7.4 about ordering does not detract from per-commit quality.
- **No unused code:** `print-snippet.js:104-114` exports include `HELP`, `TARGETS`, `VERSION`, `buildOutput`, `emitJson`, `emitMarkdown`, `loadBody`, `main: buildOutput`, `sha256Hex`. The aliased `main: buildOutput` is consumed by `cli.js:843` (`const { main: runInit } = require(...)`); `buildOutput` directly is consumed by tests; helpers `emitJson`/`emitMarkdown`/`loadBody`/`sha256Hex` are not externally consumed (could be flagged as over-export, but test ergonomics make them defensible). NOT a blocker.
- **No dead branches:** every condition path is tested (defaults, help, all/single targets, format markdown/json, bad target → 2, internal fail → 4).
- **No security issues:** snippet bodies are static template files baked into the repo; no shell-eval, no template substitution, no env-var expansion. Test 6 (security intent) verifies inline-code spans stay free of `[$;|&]`.
- **Stderr policy:** all 4 stderr writes use `error: …` prefix and a literal newline. Spec §3.4 says "warnings only" on happy path; all error stderr writes are accompanied by non-zero exit code, satisfying the "errors are reflected by exit code, stderr carries diagnostic" model.
- **Argv parser:** `parseArgs` (lines 40-68) handles `--key value` and `--key=value` forms for `--target` and `--format`. Spec didn't mandate `--key=value` form, but supporting both is conventional and harmless. Edge case: unrecognized flags are silently ignored. Spec doesn't require strict argv validation; acceptable for v1.
- **Version pin:** `package.json` is at `0.3.4`; spec target was "≥ 0.3.5 (next minor, additive)." The version bump to `0.3.5` is implicitly deferred to the actual `npm version` release commit (separate from this implementation PR). Acceptable as release-time work.

---

## §9 Conditions (none blocking)

No `ACCEPT_WITH_CONDITIONS` triggered. The four §7 findings are all NON-BLOCKING and either (a) a recommended spec-wording amendment (§7.1), (b) a defensible deviation explained by spec text (§7.2, §7.3), (c) a process observation that doesn't affect correctness (§7.4), or (d) a coordination note for the eventual PR push (§7.5).

If the orchestrator wishes to attach optional follow-ups:
1. **Spec amendment (recommended):** rewrite §8.2 item 6's "backtick outside fenced code blocks" to "no shell metacharacters `$;|&` inside inline-code spans" to match the implemented (and correct-in-spirit) test.
2. **Release commit:** `npm version 0.3.5 --no-git-tag-version` + `npm publish` should be a separate commit after this PR's merge per §7.5 release-time deferral.

---

## §10 Verdict + Push Recommendation

**Final verdict:** **ACCEPT.**

**Atomic batch push readiness:** **YES.**

**Recommended commit range:**
- `aigentry-telepty`: `d7b8b21..d0f4495` (16 commits, 15 tests + 8 fixtures + impl + cli wiring + scripts/regen-snippet-fixtures.js + version-test alignment)
- `aigentry-ssot`: `f4ff0cd` (G1 SSOT stub, single commit)

**Push order:** SSOT stub first (already committed at 14:35:07, before the final telepty test commit at 14:36:19); telepty PR description should cite `f4ff0cd` per spec §7.6 cross-repo coordination requirement.

**Verification evidence captured this review:**
- `npm test` → 269/269 pass (full suite); 15/15 init suite
- `git diff --exit-code tests/snippet-protocol/v1/` clean (golden fixtures byte-equal)
- Manual M3 smoke: `env -i HOME=/tmp/empty PATH=/usr/bin:/bin:<node> node cli.js init --print-snippet --target claude` → exit 0
- SSOT body hashes verified equal to runtime `sha256` digests for all 3 targets
- Boundary scan: zero file-mutation, zero subprocess-of-devkit in `src/init/`

---

*End of review.*
