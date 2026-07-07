'use strict';

// #716 — codex (and other paste-capable CLI) composers swallow a submit CR that
// arrives coalesced with the injected text burst (paste-burst / coalesced read).
// Fix: for sessions the CLI marked paste-capable (it emitted ESC[?2004h), wrap the
// injected TEXT in bracketed-paste markers so the burst is an explicit, delimited
// paste; the submit CR is written SEPARATELY, OUTSIDE the 200~/201~ envelope, so it
// is an unambiguous keystroke regardless of inter-write timing. Non-paste-capable
// sessions (legacy claude/gemini/agy that never advertised ?2004h) are byte-identical.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const daemon = require('../daemon');
const { maybeBracketedPaste, appendToOutputRing } = daemon;

const BP_START = '\x1b[200~';
const BP_END = '\x1b[201~';

class PasteBurstComposer {
  constructor({ burstWindowMs = 150 } = {}) {
    this.burstWindowMs = burstWindowMs;
    this.body = '';
    this.submits = 0;
    this.lastTextAtMs = null;
    this.justClosedPaste = false;
  }

  write(data, nowMs) {
    let rest = data;
    while (rest.length > 0) {
      if (rest.startsWith(BP_START)) {
        const end = rest.indexOf(BP_END, BP_START.length);
        assert.notEqual(end, -1, 'test fixture must close bracketed paste');
        this.body += rest.slice(BP_START.length, end);
        this.lastTextAtMs = nowMs;
        this.justClosedPaste = true;
        rest = rest.slice(end + BP_END.length);
        continue;
      }

      const cr = rest.indexOf('\r');
      const text = cr === -1 ? rest : rest.slice(0, cr);
      if (text) {
        this.body += text;
        this.lastTextAtMs = nowMs;
        this.justClosedPaste = false;
      }
      if (cr === -1) break;

      const coalesced = this.lastTextAtMs != null && nowMs - this.lastTextAtMs <= this.burstWindowMs;
      if (this.justClosedPaste || !coalesced) this.submits += 1;
      this.justClosedPaste = false;
      rest = rest.slice(cr + 1);
    }
  }
}

test('appendToOutputRing marks bracketedPasteCapable when the CLI enables ESC[?2004h — #716', () => {
  const session = { outputRing: [] };
  appendToOutputRing(session, 'boot…\x1b[?2004hready');
  assert.equal(session.bracketedPasteCapable, true);
});

test('appendToOutputRing clears bracketedPasteCapable on ESC[?2004l — #716', () => {
  const session = { outputRing: [], bracketedPasteCapable: true };
  appendToOutputRing(session, 'shutting down\x1b[?2004l');
  assert.equal(session.bracketedPasteCapable, false);
});

test('appendToOutputRing: last h/l in the chunk wins — #716', () => {
  const on = { outputRing: [] };
  appendToOutputRing(on, '\x1b[?2004l…\x1b[?2004h');
  assert.equal(on.bracketedPasteCapable, true);
  const off = { outputRing: [] };
  appendToOutputRing(off, '\x1b[?2004h…\x1b[?2004l');
  assert.equal(off.bracketedPasteCapable, false);
});

test('maybeBracketedPaste wraps injected text for a paste-capable session — #716', () => {
  const session = { bracketedPasteCapable: true };
  assert.equal(maybeBracketedPaste('echo ALIVE > f', session), BP_START + 'echo ALIVE > f' + BP_END);
});

test('maybeBracketedPaste preserves multi-line bodies inside one paste envelope — #716', () => {
  const session = { bracketedPasteCapable: true };
  assert.equal(maybeBracketedPaste('line1\nline2', session), BP_START + 'line1\nline2' + BP_END);
});

test('bracketed paste makes the following CR a keystroke even inside the paste-burst window — #716', () => {
  const buggy = new PasteBurstComposer();
  buggy.write('wrapped142\r', 0);
  assert.equal(buggy.body, 'wrapped142');
  assert.equal(buggy.submits, 0, 'legacy coalesced text+CR is swallowed as paste-burst content');

  const fixed = new PasteBurstComposer();
  fixed.write(maybeBracketedPaste('wrapped142', { bracketedPasteCapable: true }), 0);
  fixed.write('\r', 1);
  assert.equal(fixed.body, 'wrapped142');
  assert.equal(fixed.submits, 1, 'CR after ESC[201~ submits even with no timing floor');
});

test('non-paste-capable sessions keep the legacy separated-CR behavior — #716', () => {
  const composer = new PasteBurstComposer();
  composer.write(maybeBracketedPaste('hello', { bracketedPasteCapable: false }), 0);
  composer.write('\r', 200);
  assert.equal(composer.body, 'hello');
  assert.equal(composer.submits, 1);
});

test('maybeBracketedPaste leaves NON-paste-capable sessions BYTE-IDENTICAL (legacy claude/gemini/agy) — #716', () => {
  // Regression guard: no 200~/201~ leakage into a composer that never advertised paste.
  assert.equal(maybeBracketedPaste('hello', { bracketedPasteCapable: false }), 'hello');
  assert.equal(maybeBracketedPaste('hello', {}), 'hello');            // capability unknown → unchanged
  assert.equal(maybeBracketedPaste('hello', null), 'hello');
});

test('maybeBracketedPaste never wraps an empty body — #716', () => {
  assert.equal(maybeBracketedPaste('', { bracketedPasteCapable: true }), '');
});

// Requiring daemon.js loads persisted sessions for read-only helper seams; match the
// existing daemon-unit tests so this child test process exits cleanly under node --test.
test.after(() => { setImmediate(() => process.exit(0)); });
