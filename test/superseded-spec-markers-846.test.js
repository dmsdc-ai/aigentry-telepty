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

// A marker is only useful if the reader can follow it. These pointers have broken twice:
// they named `*Unreleased*` and a sibling renamed the heading; they were repointed at
// `*0.8.0 — unreleased*`, which is the half of the heading the PUBLISH STEP REWRITES — that
// one would have broken at the tag, with nothing in the suite to notice. Hence a check that
// runs the publish step at the pointers rather than a third round of fixing strings.
const CHANGELOG_POINTER = /`CHANGELOG\.md`\s*→\s*\*([^*]+)\*/g;

// Resolves = a reader searching CHANGELOG.md for the pointed-at text finds a section. Prefix
// PLUS the heading's free-text separator, not a bare prefix, so `0.6.1` cannot resolve against
// `## 0.6.11`. Bracketed headings (`## [0.6.11] - ...`, the older style) are unwrapped first.
function resolvesInChangelog(pointer, changelog) {
  return changelog.split('\n')
    .filter((line) => /^##\s+\S/.test(line))
    .map((line) => line.replace(/^##\s+/, '').replace(/^\[(.+?)\]/, '$1').trim())
    .some((h) => h === pointer
      || (h.startsWith(pointer) && /^[—-]/.test(h.slice(pointer.length).trim())));
}

// The publish step fills the date into the newest heading by hand — 0.8.0 is the only undated
// section; every one below it reads `## X.Y.Z — YYYY-MM-DD`. First match only: `m` without `g`.
const NEWEST_VERSION_HEADING = /^(##\s+\[?\d+\.\d+\.\d+\]?).*$/m;

function withPublishedDate(changelog) {
  return changelog.replace(NEWEST_VERSION_HEADING, '$1 — 2026-08-15');
}

test('#846: every CHANGELOG cross-reference resolves, and still resolves once publishing dates the heading', () => {
  // Self-check on a fixture, so this cannot pass by matching nothing or by accepting anything.
  const FIXTURE = '## 0.9.0 — unreleased\n\ntext\n\n## 0.8.0 — 2026-08-15\n';
  assert.equal(resolvesInChangelog('0.9.0', FIXTURE), true,
    'the resolver must match a heading by the stable half of its text');
  assert.equal(resolvesInChangelog('0.9.0 — unreleased', withPublishedDate(FIXTURE)), false,
    'the resolver must refuse a pointer that embeds the free text the publish step rewrites — '
    + 'if it does not, the scan below cannot fail and this whole test is decoration');
  assert.equal(resolvesInChangelog('0.9', FIXTURE), false,
    'a bare prefix must not resolve — 0.6.1 is not 0.6.11');

  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const published = withPublishedDate(changelog);
  // The substitution must have had a target. Asserted on the heading rather than on
  // `published !== changelog`, because once the release IS dated the rewrite is a no-op that
  // proves the same thing — this check has to survive the tag it is guarding.
  assert.ok(NEWEST_VERSION_HEADING.test(changelog),
    'CHANGELOG.md has no version-shaped `## ` heading, so the simulated publish step rewrites '
    + 'nothing and this test no longer exercises the edit that broke these pointers twice');

  const tracked = execFileSync('git', ['ls-files', '*.md'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);

  const broken = [];
  let pointers = 0;
  for (const rel of tracked) {
    const body = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of body.matchAll(CHANGELOG_POINTER)) {
      pointers += 1;
      const pointer = m[1].trim();
      if (!resolvesInChangelog(pointer, changelog)) {
        broken.push(`${rel}: → *${pointer}* matches no CHANGELOG.md section today`);
      } else if (!resolvesInChangelog(pointer, published)) {
        broken.push(`${rel}: → *${pointer}* resolves today and STOPS resolving the moment the `
          + 'release is dated — point at the version, which publishing keeps, not at the free text '
          + 'after it, which publishing rewrites');
      }
    }
  }

  // Guards the vacuous case only — that the matcher found no pointers at all, e.g. because the
  // arrow form changed. It does NOT guard against a pointer being deleted; deleting one is a
  // legitimate edit and this count is deliberately not a hand-maintained expected total.
  assert.ok(pointers > 0,
    'no `CHANGELOG.md` → *section* pointer matched in any tracked *.md — if the pointer form '
    + 'changed, teach CHANGELOG_POINTER the new form rather than leaving it matching nothing');

  assert.deepEqual(broken, [], `CHANGELOG.md cross-references that a reader cannot follow:\n  ${broken.join('\n  ')}\n`);
});

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
