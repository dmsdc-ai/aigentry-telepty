# scratchpad — dated evidence, not current code

Nothing in this directory is a contract, a test, or a supported entry point. It is not in
`package.json` `files`, so it never ships to npm, and no CI job runs it.

Two kinds of file live here:

- **`EVIDENCE-*.md`** — dated write-ups of what was measured for a specific issue (#730, #737,
  #760, #801), including verbatim production output. They are *records*: accurate as of their
  date, and deliberately kept, because they are the evidence behind fixes that shipped. They are
  not descriptions of how the daemon behaves today.
- **`e2e-*.js`, `repro-*`, `probe-*`, `peek-*`, `capture-*`** — one-off drivers written to
  reproduce one bug against a harness daemon. They bit-rot silently, since nothing runs them.

**Known rot:** `e2e-801.js` asserts `want: 'TASK_COMPLETE'` on five of its seven arms, and
`EVIDENCE-801.md` records `TASK_COMPLETE` / `TASK_ERROR` frames. Those labels no longer exist —
#60 Stage A removed every terminal task-outcome claim from the daemon and replaced them with one
`task_completion_unknown` observation (`src/completion-observation.js`; `CHANGELOG.md` →
*Unreleased* → "BREAKING: telepty no longer asserts task completion"). Read those two files as
history. Do not treat their expectations as the contract, and do not port them into `test/`.
