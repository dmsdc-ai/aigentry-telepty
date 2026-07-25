'use strict';

// #730 — RED. codex CLI 0.144.1: `telepty inject --submit --submit-force` reports
// `✅ Submitted via pty_cr [forced]` but the text parks in the composer and the CR
// never registers; injects accumulate until a manual `send-key enter` flushes the
// whole blob as ONE message.
//
// NOT a new codex regression. #716's fix (wrap the body in bracketed paste so the
// separately-written CR cannot be absorbed into the paste burst) still works on
// 0.144.1 — it is simply NOT APPLIED to most real sessions, because the capability
// that gates it is inferred from a ONE-SHOT observation that is easy to miss and is
// never persisted.
//
// Measured against real codex 0.144.1 (scratchpad/repro-730-tmux.js, tmux
// capture-pane as the VT — see scratchpad/EVIDENCE-730.md), runs with a swallowed CR:
//
//   envelope    body shape          text->CR gap    swallowed
//   none        multi-line           16ms           10/11
//   none        multi-line           57 / 86ms       2/2, 2/2
//   none        multi-line          107ms            1/2
//   none        multi-line          127ms            1/7
//   none        multi-line          157 / 307 / 607ms  0/2, 0/7, 0/2
//   none        single-line 600ch    17ms            0/5
//   bracketed   multi-line           16ms            0/9
//
// So the swallow needs ALL THREE: no bracketed-paste envelope, embedded newlines,
// and a short text->CR gap. It is a PROBABILITY that decays with the gap, not a
// clean threshold — 127ms still failed 1/7. The force path (daemon.js:3045-3050)
// writes the CR with NO gate and NO delay — measured 0ms on the real path
// (scratchpad/e2e-730.js) — while the ordinary deferred path waits 300/500ms
// (daemon.js:1987) and is safe. That is why `--submit-force` is the flag that fails.
//
// These tests are RED on purpose: they assert the invariants that make #716's
// envelope actually reach a real session. Not registered in package.json — repro
// phase only, no product fix in this branch.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const daemon = require('../daemon');
const { maybeBracketedPaste, appendToOutputRing } = daemon;
const {
  serializePersistedSessions,
  buildRestoredWrappedSession,
} = require('../src/session-store/persistence');

const BP_START = '\x1b[200~';
const BP_END = '\x1b[201~';

// Model constant for the characterization composer below — NOT a measured hard floor.
// Real 0.144.1 is probabilistic (1/7 runs still failed at 127ms); the tests model it as
// a step at 150ms, the lowest gap where no swallow was observed. Any fix that relies on
// a timing floor must be sized with margin, not against this number.
const CODEX_0144_PASTE_BURST_MODEL_MS = 150;

const isWrapped = (s) => s.startsWith(BP_START) && s.endsWith(BP_END);

// ── Loss path 1: the capability signal is one-shot ────────────────────────────
// Verified against the real binary (scratchpad/probe-codex.js): codex 0.144.1
// emits ESC[?2004h EXACTLY ONCE, inside its first ~1.4KB of output, and never
// again for the life of the process. appendToOutputRing (daemon.js:2041-2043) is
// the only place the flag is ever set, so any session whose output capture was not
// live for that single chunk stays un-wrapped forever.

test('#730 RED: a codex session that missed the one-shot ESC[?2004h still needs the paste envelope', () => {
  // A wrapped session registered/attached AFTER codex printed its banner: every
  // frame the owner bridge relays from here on is steady-state UI, no mode-set.
  const lateAttach = { outputRing: [], command: 'codex' };
  appendToOutputRing(lateAttach, '› \r\ngpt-5.5 xhigh fast · /tmp/demo\r\n');

  assert.equal(lateAttach.bracketedPasteCapable, undefined,
    'precondition: the 2004h frame was never observed');

  const body = 'REPORT: done\nline A\nline B';
  assert.ok(
    isWrapped(maybeBracketedPaste(body, lateAttach)),
    'codex is a KNOWN paste-capable CLI — the envelope must not depend on having ' +
    'caught a single startup byte sequence, or #716 silently no-ops for this session'
  );
});

// ── Loss path 2: the capability is never persisted ────────────────────────────
// Restart the daemon and every restored wrapped session comes back without the
// flag — and codex already burned its only ESC[?2004h long ago, so it can never
// be re-learned. #716 is permanently inert for that session.

test('#730 RED: bracketed-paste capability survives a daemon restart', () => {
  const live = {
    id: 'c730-codex',
    type: 'wrapped',
    command: 'codex',
    cwd: '/tmp/demo',
    createdAt: new Date().toISOString(),
    outputRing: [],
  };
  appendToOutputRing(live, '\x1b[?2004h>_ OpenAI Codex (v0.144.1)\r\n');
  assert.equal(live.bracketedPasteCapable, true, 'precondition: capability learned while live');

  const persisted = serializePersistedSessions({ 'c730-codex': live })['c730-codex'];
  const restored = buildRestoredWrappedSession('c730-codex', persisted, { cwd: '/tmp/demo' });

  assert.equal(restored.bracketedPasteCapable, true,
    'restored session lost paste capability — codex emits ESC[?2004h only at startup, ' +
    'so it can never be re-learned and every later inject goes out un-enveloped');
});

test('#730 RED: a restored codex session still gets the paste envelope', () => {
  const persisted = serializePersistedSessions({
    s: { id: 's', type: 'wrapped', command: 'codex', cwd: '/tmp/demo', createdAt: new Date().toISOString(), bracketedPasteCapable: true },
  }).s;
  const restored = buildRestoredWrappedSession('s', persisted, { cwd: '/tmp/demo' });

  assert.ok(
    isWrapped(maybeBracketedPaste('REPORT: done\nline A\nline B', restored)),
    'post-restart inject is delivered raw; with the force path CR at 0ms this is the ' +
    'exact shape real codex 0.144.1 swallows'
  );
});

// ── Characterization: what the composer actually does with each byte shape ─────
// Models real codex 0.144.1 behavior as measured. Guards the direction of any fix:
// either the envelope is applied, or the CR is held past the burst window.

class Codex0144Composer {
  constructor() { this.body = ''; this.submits = 0; this.lastTextAtMs = null; }

  // Returns nothing; inspect `.body` / `.submits`.
  write(data, nowMs) {
    if (data === '\r') {
      // Measured: a CR lands as a real submit only when the composer is not inside
      // a paste burst — i.e. the body was an explicit bracketed paste, was
      // single-line, or the CR arrived >= the burst window after the text.
      const multiline = this.body.includes('\n');
      const inBurst = this.lastTextAtMs !== null &&
        (nowMs - this.lastTextAtMs) < CODEX_0144_PASTE_BURST_MODEL_MS;
      if (multiline && inBurst && !this.lastWasExplicitPaste) {
        this.body += '\n'; // absorbed as another newline — text stays parked
        return;
      }
      this.submits += 1;
      this.body = '';
      return;
    }
    this.lastWasExplicitPaste = isWrapped(data);
    this.body += this.lastWasExplicitPaste ? data.slice(BP_START.length, -BP_END.length) : data;
    this.lastTextAtMs = nowMs;
  }
}

test('#730 characterization: un-enveloped multi-line body + 0ms CR accumulates, never submits', () => {
  const c = new Codex0144Composer();
  const bare = { command: 'codex' }; // no bracketedPasteCapable — the field condition

  // Two injects, force-path shaped: body then CR at +0ms (measured, e2e-730.js).
  c.write(maybeBracketedPaste('REPORT one\nline A', bare), 1000);
  c.write('\r', 1000);
  c.write(maybeBracketedPaste('REPORT two\nline B', bare), 2000);
  c.write('\r', 2000);

  assert.equal(c.submits, 0, 'no turn ever started');
  assert.match(c.body, /REPORT one/);
  assert.match(c.body, /REPORT two/, 'both injects accumulated in the same composer');

  // The reported workaround: one manual Enter, well after the burst window.
  c.write('\r', 9000);
  assert.equal(c.submits, 1, 'the accumulated blob flushes as ONE message');
});

test('#730 characterization: the paste envelope makes the CR land regardless of gap', () => {
  const c = new Codex0144Composer();
  const capable = { command: 'codex', bracketedPasteCapable: true };

  c.write(maybeBracketedPaste('REPORT one\nline A', capable), 1000);
  c.write('\r', 1000);
  c.write(maybeBracketedPaste('REPORT two\nline B', capable), 2000);
  c.write('\r', 2000);

  assert.equal(c.submits, 2, 'each inject consumed as its own turn');
  assert.equal(c.body, '');
});

test('#730 characterization: holding the CR past the burst window also lands it', () => {
  const c = new Codex0144Composer();
  const bare = { command: 'codex' };

  c.write(maybeBracketedPaste('REPORT one\nline A', bare), 1000);
  c.write('\r', 1000 + CODEX_0144_PASTE_BURST_MODEL_MS);

  assert.equal(c.submits, 1,
    'the deferred inject path (300/500ms, daemon.js:1987) clears this window — ' +
    'only the force path (daemon.js:3045-3050, 0ms) does not');
});
