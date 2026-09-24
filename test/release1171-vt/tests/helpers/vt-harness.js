'use strict';

// ---------------------------------------------------------------------------
// vt1136ak — independent tester harness for #1136 stateful VT observation
// ---------------------------------------------------------------------------
//
// SEAM DECLARATION (dispatch: "named actual-vs-fake seams").
//
//   ACTUAL  — `realTerminalCtor()` returns the constructor exported by the REAL, pinned
//             @xterm/headless 6.0.0 unpacked at output/node_modules/@xterm/headless from the
//             exact dispatch tarball. Every parser/grid/width/split/alt-screen assertion in this
//             suite goes through it. No stub parses ANSI anywhere in this suite.
//
//   ACTUAL+  — `instrumentedTerminalCtor()` SUBCLASSES the real constructor. It parses with the
//             real parser and only RECORDS which methods/events the module touched. It is not a
//             fake: behaviour is unmodified.
//
//   FAKE    — `FakeTerminal` in ../vt-failure-timing.test.js. Used ONLY for failure injection and
//             callback-ordering control, which a real parser cannot be made to exhibit on demand.
//             It never appears in a test that asserts parsed screen content.
//
// All helpers here are read-only with respect to input/; nothing writes outside output/.

const path = require('path');
const assert = require('node:assert');

// vg1136am DELTA-0 (harness, declared): the source tree under test is selected by
// `VT_SOURCE_ROOT` so that the IDENTICAL behavioural oracles can be re-run, unmodified, against
// the baseline candidate and against the controller's corrective module. Nothing else about the
// harness changed; with the variable unset it resolves to the baseline exactly as before.
// The suite refuses to run against a tree with no VT module rather than silently passing.
// tt1170aa PORTABILITY-1 (defaults only; no oracle changed): the release branch package lives at
// the REPOSITORY ROOT, with no `source/` sibling, so the unset-variable default must resolve to
// the repo root itself — `test/release1171-vt/tests/helpers` is four levels below it. The former
// default appended a `source/` segment that exists only in the old nested staging layout, and the
// dependency default was an absolute worker path that exists on no other machine. Both now
// resolve from the repo root, so a clean checkout runs with no variables set at all.
// `VT_SOURCE_ROOT` / `TELEPTY_DEPENDENCY_ROOT` remain honoured purely as fixture selectors.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SOURCE_ROOT = process.env.VT_SOURCE_ROOT
  ? path.resolve(process.env.VT_SOURCE_ROOT)
  : REPO_ROOT;
const DEPENDENCY_ROOT = process.env.TELEPTY_DEPENDENCY_ROOT
  ? path.resolve(process.env.TELEPTY_DEPENDENCY_ROOT)
  : path.join(REPO_ROOT, 'node_modules');
const VT_MODULE_PATH = path.join(SOURCE_ROOT, 'src', 'vt', 'session-screen.js');

function loadVt() {
  if (!require('fs').existsSync(VT_MODULE_PATH)) {
    throw new Error(
      `no VT module at ${VT_MODULE_PATH} — refusing to run the suite against a tree that has none `
      + '(an absent module must be a loud failure, never a silently green run)'
    );
  }
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(VT_MODULE_PATH);
}

/** Which tree this run measured — recorded in every evidence file. */
function variantLabel() {
  return SOURCE_ROOT;
}

function realTerminalCtor() {
  // Resolve from the module under test's own location so we prove the SAME resolution path the
  // daemon would take — output/node_modules/@xterm/headless.
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const mod = require(require.resolve('@xterm/headless', { paths: [DEPENDENCY_ROOT] }));
  return mod.Terminal;
}

/**
 * ACTUAL+ seam. A real Terminal that records the module's interactions with it.
 * `record` is shared mutable state the test inspects afterwards.
 */
function instrumentedTerminalCtor(record) {
  const Real = realTerminalCtor();
  return class InstrumentedTerminal extends Real {
    constructor(options) {
      super(options);
      record.constructedWith = record.constructedWith || [];
      record.constructedWith.push(options);

      // vg1136am ORACLE-CORRECTION item 2: ordering must be provable "tied to THAT terminal
      // instance". The flat `record.writes` / `record.resizes` arrays cannot express which
      // instance a call landed on once a generation rotates and a second Terminal exists. Each
      // instance therefore also records its OWN construction options and its own call order.
      record.instances = record.instances || [];
      this.__vtInstance = {
        index: record.instances.length,
        // the real Terminal itself, so a test can read the PARSER's own buffer rather than the
        // module's frame metadata (ORACLE-CORRECTION item 2: "prove BRAVO layout, not merely
        // mutable frame metadata")
        terminal: this,
        constructedWith: options,
        cols: options && options.cols,
        rows: options && options.rows,
        writes: [],
        resizes: [],
      };
      record.instances.push(this.__vtInstance);
      record.subscribed = record.subscribed || [];
      record.inputCalls = record.inputCalls || 0;
      record.writes = record.writes || [];
      record.resizes = record.resizes || [];

      // Wrap the outbound event getters so ANY subscription by the module is recorded.
      for (const evt of ['onData', 'onBinary', 'onTitleChange', 'onBell', 'onWriteParsed']) {
        const inner = super[evt];
        if (typeof inner !== 'function') continue;
        Object.defineProperty(this, evt, {
          configurable: true,
          value: (...args) => {
            record.subscribed.push(evt);
            return inner.call(this, ...args);
          },
        });
      }
    }

    write(data, cb) {
      const s = typeof data === 'string' ? data : String(data);
      record.writes.push(s);
      this.__vtInstance.writes.push(s);
      return super.write(data, cb);
    }

    resize(cols, rows) {
      record.resizes.push({ cols, rows, afterWrites: record.writes.length });
      this.__vtInstance.resizes.push({ cols, rows, afterWrites: this.__vtInstance.writes.length });
      return super.resize(cols, rows);
    }

    input(...args) {
      record.inputCalls += 1;
      return super.input(...args);
    }
  };
}

/** Build a SessionScreen wired to the REAL pinned parser. */
function makeScreen(vt, options = {}) {
  return new vt.SessionScreen({
    sessionId: options.sessionId || 'vt1136ak-test',
    terminalFactory: options.terminalFactory || realTerminalCtor(),
    ...options,
  });
}

/**
 * Read a frame after letting the module's own bounded drain wait run, then confirm the queue
 * actually drained. Bounded by `deadlineMs` (default 5000) so no test can hang.
 *
 * This never reaches into module internals to force a flush: it uses only the public read.
 */
async function frameAfterDrain(screen, options = {}) {
  const deadline = Date.now() + (options.deadlineMs || 5000);
  return keepAlive(async () => {
  let frame = await screen.readFrame({ drainWaitMs: 250, ...options });
  // A STOPPED generation (cell-growth breach, disposal) never drains by design: its terminal is
  // gone and applied_units stays behind observed_units permanently. Polling it is not waiting for
  // anything, so stop as soon as the frame says the observation is unavailable.
  while (frame.lag_units > 0
         && frame.observation_basis !== 'unavailable'
         && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    frame = await screen.readFrame({ drainWaitMs: 250, ...options });
  }
  return frame;
  });
}

/**
 * Hold the event loop open across an await.
 *
 * The module's drain timer is deliberately `unref`'d (coder REPORT §5: "no timers except the
 * bounded drain wait, and that timer is unref'd") so an idle VT can never keep the daemon
 * process alive. In the real daemon the HTTP server holds the loop open, so the wait elapses
 * normally. In a bare test process there is nothing else pending, so node would drain the loop
 * and cancel the test while the promise is still pending. This supplies the missing ref.
 */
async function keepAlive(fn) {
  const ticker = setInterval(() => {}, 20);
  try {
    return await fn();
  } finally {
    clearInterval(ticker);
  }
}

/** Non-blank rows of the grid, trimmed — the "what is on the screen" view. */
function visibleRows(frame) {
  return frame.rows_text.map((r) => r.replace(/\s+$/, '')).filter((r) => r.length > 0);
}

function screenText(frame) {
  return frame.rows_text.join('\n');
}

/** Assert a degraded reason is present, with the whole list in the failure message. */
function assertReason(frame, reason) {
  assert.ok(
    frame.degraded_reasons.includes(reason),
    `expected degraded_reasons to include ${JSON.stringify(reason)}; got ${JSON.stringify(frame.degraded_reasons)}`
  );
}

function assertNoReason(frame, reason) {
  assert.ok(
    !frame.degraded_reasons.includes(reason),
    `expected degraded_reasons NOT to include ${JSON.stringify(reason)}; got ${JSON.stringify(frame.degraded_reasons)}`
  );
}

// --- genuine ANSI fixture builders (contract §12: real sequences, never the flattened capture) --
const ANSI = {
  CUP: (row, col) => `\u001b[${row};${col}H`,
  HOME: '\u001b[H',
  ED: (n) => `\u001b[${n}J`,            // 0 to end, 1 to start, 2 all
  EL: (n) => `\u001b[${n}K`,            // 0 to end of line, 1 to start, 2 whole line
  CUU: (n) => `\u001b[${n}A`,
  CUD: (n) => `\u001b[${n}B`,
  CUF: (n) => `\u001b[${n}C`,
  CUB: (n) => `\u001b[${n}D`,
  ALT_ON: '\u001b[?1049h',
  ALT_OFF: '\u001b[?1049l',
  DSR: '\u001b[6n',
  DA: '\u001b[c',
  OSC_TITLE: (t) => `\u001b]0;${t}\u0007`,
  OSC_CLIPBOARD: (b64) => `\u001b]52;c;${b64}\u0007`,
  OSC_LINK: (url, text) => `\u001b]8;;${url}\u0007${text}\u001b]8;;\u0007`,
  CR: '\r',
  LF: '\n',
  CRLF: '\r\n',
};

module.exports = {
  REPO_ROOT,
  SOURCE_ROOT,
  DEPENDENCY_ROOT,
  VT_MODULE_PATH,
  loadVt,
  variantLabel,
  realTerminalCtor,
  instrumentedTerminalCtor,
  makeScreen,
  frameAfterDrain,
  keepAlive,
  visibleRows,
  screenText,
  assertReason,
  assertNoReason,
  ANSI,
};
