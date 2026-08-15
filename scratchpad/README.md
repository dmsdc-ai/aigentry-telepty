# scratchpad — dated evidence and the harnesses that produced it

Nothing here is a contract, a test, or a supported entry point. It is not in `package.json`
`files`, so it never ships to npm, and no CI job runs any of it.

What remains is deliberate, but not for one uniform reason — and the reason is per file, so it is
stated per file rather than as a count. Every file below **except `EVIDENCE-801.md`** is **cited by
name** from something that stays: an `EVIDENCE-*.md` write-up, a `test/*.test.js` provenance
comment, `daemon.js`, `src/prompt-symbol-registry.js`, or `CHANGELOG.md`:

- **`EVIDENCE-*.md`** (#730, #737, #760, #801) — dated write-ups of what was measured for one
  issue, including verbatim production output. They are *records*: accurate as of their date,
  and the evidence behind fixes that shipped. They do not describe how the daemon behaves today.
- **`e2e-*.js`, `repro-*`, `probe-*`, `capture-*`, `evidence/modal-force.screens.txt`** — the
  one-off harnesses and raw captures those write-ups point at. They are kept because a test that
  says "measured against real codex 0.144.1 (`scratchpad/repro-737-tmux.js`)" is only checkable
  while the cited artifact exists. Nothing keeps them running, so assume they have rotted:
  `e2e-801.js` still expects terminal task-outcome labels on five of its seven arms, and those
  labels were removed by #60 Stage A.

**`EVIDENCE-801.md` is the exception, and is cited by nothing.** It stays on the other ground: it
is the primary evidence for #801. `test/idle-error-vs-complete-801.test.js` cites the harnesses it
wrote up (`capture-801-api-error.js`, `e2e-801.js`) but not the write-up itself. Being linked was
never the whole test for keeping a file here — it is just the test the other files happen to pass.

**Read all of it as history.** The daemon no longer asserts task outcome at all — it emits one
`task_completion_unknown` observation (`src/completion-observation.js`,
`GET /api/inject-observations/:inject_id`; `CHANGELOG.md` → *0.8.0* → "BREAKING:
telepty no longer asserts task completion"). Do not treat any expectation in this directory as the
current contract, and do not port one into `test/`.

Ten orphaned files — eight raw `evidence/*.txt` captures that no write-up indexed, plus
`peek-752.js` and `repro-737.sh` — were removed in #846: an uncited capture has lost the
provenance that made it evidence. Do not add new files here without citing them from the
write-up that uses them.
