'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Regression: #846 / #60 Stage A.
//
// 0.8.0 removed every terminal task-outcome label from the daemon. Two specs kept
// prescribing the removed contract under `**Status:** SPEC — awaiting orchestrator
// approval`, so a reader following the repo's own specs would re-implement exactly what
// the release deleted — this release's defect class, committed in the spec directory.
//
// This is a static lint, not a behaviour test: any tracked *.md that names a removed
// label must either carry a supersession marker where a reader who reads only the top
// will see it, or be a listed dated record — a document where the label is the
// measurement, not an instruction. New docs default to "must be marked": the lint fails
// closed, so the next spec to name a dead label has to say it is dead.

const ROOT = path.resolve(__dirname, '..');

// Deleted by #60 Stage A. `task_completion_unknown` replaces all of them.
const REMOVED_LABELS = [
  'TASK_COMPLETE', 'TASK_COMPLETE_WITH_REPORT', 'TASK_IDLE_UNCONFIRMED', 'TASK_ERROR',
  'TASK_IDLE_NO_REPORT', 'TASK_DEAD_NO_REPORT', 'TASK_TIMEOUT_NO_REPORT', 'TASK_BLOCKED_WITH_REASON'
];

// A dated record states what was true on a date; marking it superseded would falsify a
// true record.
//
// THIS LIST IS HAND-MAINTAINED, AND THAT IS THE DESIGN — not an oversight to automate away.
// Whether a document *prescribes* a contract or *records* an observation is a judgment no
// regex makes: the same `TASK_COMPLETE` string is an instruction in a spec and a measurement
// in an incident write-up. So the list is the mechanism, and it fails CLOSED — a new dated
// record that names a removed label turns this test red until someone adds it here. That red
// is the test working. If you hit it: confirm the file really is a record (a statement about
// a date, not something a reader should implement), then add its pattern and say why in a
// comment, as the entries below do. If it is not a record, mark the document instead.
const DATED_RECORDS = [
  /^CHANGELOG\.md$/,
  /^docs\/reports\//,
  // Stays in scratchpad/: #846 considered moving these to docs/reports/ and rejected it —
  // the move would have needed path edits in two files that ship to npm, for a cosmetic
  // gain, and scratchpad/README.md already says the directory is not disposable.
  /^scratchpad\/EVIDENCE-\d+\.md$/,
  // Not a carrier: its label hits are example screen-history text for a prompt-glyph
  // disambiguation fixture, and the render gate itself survives Stage A.
  /^docs\/superpowers\/specs\/2026-04-26-prompt-symbol-render-gate\.md$/
];

const MARKER = /SUPERSEDED|HISTORICAL/;
const MARKER_WINDOW = 25; // lines — "a reader who reads only the top" must be enough

test('#846: no tracked doc prescribes a removed terminal label without saying it is superseded', () => {
  const tracked = execFileSync('git', ['ls-files', '*.md'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  assert.ok(tracked.length > 50, `expected the tracked *.md set, got ${tracked.length} entries`);

  const offenders = [];
  for (const rel of tracked) {
    if (DATED_RECORDS.some((re) => re.test(rel))) continue;
    const body = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const named = REMOVED_LABELS.filter((label) => body.includes(label));
    if (named.length === 0) continue;
    const top = body.split('\n').slice(0, MARKER_WINDOW).join('\n');
    if (!MARKER.test(top)) {
      offenders.push(`${rel} names ${named.join(', ')} with no SUPERSEDED/HISTORICAL marker in its first ${MARKER_WINDOW} lines`);
    }
  }

  assert.deepEqual(offenders, [], `docs prescribing a contract #60 Stage A removed:\n  ${offenders.join('\n  ')}\n`);
});
