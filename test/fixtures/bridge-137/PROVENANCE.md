# test/fixtures/bridge-137 — provenance

Every file in this directory is SYNTHETIC. It was hand-authored for the telepty task 1215
regression tests (#137, `test/bridge-actual-wiring-137.test.js`). None of it was captured from
a user's session, terminal, transcript, log or screen. It holds no host names, paths, payloads,
tokens or credentials.

`receipt-cases.json` is a table of `bridge_receipt` frames: one genuine base frame plus patches
that each break exactly one rule of `src/mailbox/bridge-stage.js` `validateBridgeReceipt`.
`pad_reason_units` replaces `reason` with that many `x` characters, so the oversize case needs no
long literal in the file.
