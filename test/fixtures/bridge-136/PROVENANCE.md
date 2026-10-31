# test/fixtures/bridge-136 — provenance

Every file in this directory is SYNTHETIC. Each was hand-authored for the telepty task 1215
regression tests (#136/#137). None was captured from a user's session, terminal, transcript,
log or screen. The files contain no host names, user paths, tokens or credentials. The only
path used is the placeholder `/tmp/x`.

Each `*.json` file is a stream RECIPE. The test builds the byte stream as
`preamble.join('') + cycle[k % cycle.length] for k < repeat + epilogue.join('')`.
Using recipes keeps raw control bytes out of the repository files.

The recipes imitate the *shape* of a differential TUI repaint (CUP `ESC[r;cH` + EL `ESC[2K`).
They do not claim to be any real CLI version's output. Native-frame efficacy is a separate,
unverified hypothesis (design §F1). A native idle capture, if added later, must be labelled
separately and must not replace these.
