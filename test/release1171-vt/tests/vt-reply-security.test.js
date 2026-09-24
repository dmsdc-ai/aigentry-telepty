'use strict';

// G-REPLY — zero parser-generated units reach any PTY / host / bridge / log write path.
//
// Contract §9 untrusted-text invariants; controller correction 7.
//
// SCOPE, stated exactly (dispatch: "state EXACT seam/limits, not fullsecuritycertification"):
// this file establishes that (a) the real parser DOES generate replies for DSR/DA and DOES fire
// a title event carrying attacker-controlled text, so the invariant is load-bearing and not
// vacuous; and (b) the module under test subscribes to none of those events, calls `input()`
// never, sets `windowOptions` never, and puts no frame TEXT into any sink IT owns.
//
// NOT established here, and not claimed: the behaviour of the /frame HTTP route, the
// `read-frame` CLI command, or any daemon logger. Those are source-reviewed in REPORT.md and
// remain the builder's and G-SEC's to run. This file bounds itself to `src/vt/session-screen.js`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const H = require('./helpers/vt-harness');
const { ANSI } = H;

const vt = H.loadVt();

// A payload that tries every answer-back channel the contract names.
const HOSTILE = [
  ANSI.DSR,                                          // -> CPR reply on onData
  ANSI.DA,                                           // -> Device Attributes reply on onData
  ANSI.OSC_TITLE('PWNED-TITLE'),                     // -> onTitleChange
  ANSI.OSC_CLIPBOARD('cHduZWQ='),                    // OSC 52 clipboard write attempt
  ANSI.OSC_LINK('http://evil.example/pwned', 'link text'),
  '\u001b[?1049h',                                   // alt screen, to move state under the reply
  '\u0007',                                          // BEL
  'visible surface text',
].join('');

test('G-REPLY/premise: the REAL parser genuinely answers back — the invariant is load-bearing', async () => {
  // If this test ever stops finding replies, the invariant below becomes vacuous and the whole
  // gate would silently stop proving anything. So the premise is asserted first, directly.
  const Terminal = H.realTerminalCtor();
  const term = new Terminal({ cols: 40, rows: 6, scrollback: 0, allowProposedApi: true });

  const data = [];
  const binary = [];
  const titles = [];
  term.onData((s) => data.push(s));
  term.onBinary((s) => binary.push(s));
  term.onTitleChange((s) => titles.push(s));

  await new Promise((resolve) => term.write(HOSTILE, resolve));

  assert.ok(data.length >= 2, `the parser emitted answer-back units: ${JSON.stringify(data)}`);
  assert.ok(data.some((s) => /\u001b\[\d+;\d+R/.test(s)), 'DSR produced a CPR reply');
  assert.ok(data.some((s) => /\u001b\[\?[\d;]+c/.test(s)), 'DA produced a Device Attributes reply');
  assert.deepStrictEqual(titles, ['PWNED-TITLE'],
    'the title event carries ATTACKER-CONTROLLED text');
  // Recorded as measured, not asserted as a guarantee: this build emitted nothing on onBinary
  // for the OSC 52 attempt. The module subscribes to it regardless, which is what matters.
  assert.deepStrictEqual(binary, []);
  term.dispose();
});

test('G-REPLY: the module subscribes to NO outbound event and never calls input()', async () => {
  const record = {};
  const screen = new vt.SessionScreen({
    sessionId: 'reply',
    cause: 'stream_origin',
    localSource: true,
    geometrySource: 'local_pty',
    cols: 40,
    rows: 6,
    terminalFactory: H.instrumentedTerminalCtor(record),
  });

  screen.noteOutput(HOSTILE);
  const frame = await H.frameAfterDrain(screen);

  assert.deepStrictEqual(record.subscribed, [],
    `the module subscribed to ${JSON.stringify(record.subscribed)} — no reply sink may be wired`);
  assert.strictEqual(record.inputCalls, 0, 'input() is never called');
  // §9: onWriteParsed must not be the watermark, so it must not even be subscribed.
  assert.ok(!record.subscribed.includes('onWriteParsed'));
  assert.ok(frame.applied_units > 0, 'the payload really was parsed, so the check is not vacuous');
  screen.dispose();
});

test('G-REPLY: windowOptions is never set and scrollback/allowProposedApi are exactly as declared', async () => {
  const record = {};
  const screen = new vt.SessionScreen({
    sessionId: 'reply-opts',
    cause: 'stream_origin',
    localSource: true,
    geometrySource: 'local_pty',
    cols: 40,
    rows: 6,
    terminalFactory: H.instrumentedTerminalCtor(record),
  });
  screen.noteOutput('x');
  await H.frameAfterDrain(screen);

  assert.strictEqual(record.constructedWith.length, 1);
  const opts = record.constructedWith[0];
  assert.deepStrictEqual(Object.keys(opts).sort(),
    ['allowProposedApi', 'cols', 'rows', 'scrollback']);
  assert.strictEqual(opts.allowProposedApi, true);
  assert.strictEqual(opts.scrollback, 0, 'no scrollback: the grid, never accumulated history');
  assert.ok(!('windowOptions' in opts),
    'xterm: "All features are disabled by default for security reasons" — it stays that way');
  screen.dispose();
});

test('G-REPLY: a hostile OSC payload never appears in the frame as text or as a field', async () => {
  const screen = new vt.SessionScreen({
    sessionId: 'reply-frame',
    cause: 'stream_origin',
    localSource: true,
    geometrySource: 'local_pty',
    cols: 40,
    rows: 6,
    terminalFactory: H.realTerminalCtor(),
  });
  screen.noteOutput(HOSTILE);
  const frame = await H.frameAfterDrain(screen);

  const serialized = JSON.stringify(frame);
  assert.ok(!serialized.includes('PWNED-TITLE'), 'the OSC title is not carried anywhere in the frame');
  assert.ok(!serialized.includes('cHduZWQ='), 'the OSC 52 clipboard payload is not carried');
  assert.ok(!serialized.includes('evil.example'), 'the OSC 8 link target is not carried');
  // The frame has no title/link/clipboard field at all.
  for (const forbidden of ['title', 'clipboard', 'link', 'reply', 'osc']) {
    assert.ok(!(forbidden in frame), `frame must not carry a \`${forbidden}\` field`);
  }
  // The printable text the child actually wrote IS on the screen — the grid is not censored,
  // it simply has no outbound channel.
  assert.match(H.screenText(frame), /visible surface text/);
  screen.dispose();
});

test('G-REPLY/source: the module wires no reply sink and logs nothing (contract §9)', () => {
  const src = fs.readFileSync(H.VT_MODULE_PATH, 'utf8');
  // Strip block and line comments so the prose ABOUT these APIs cannot mask a real call.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n');

  for (const forbidden of [
    'onData', 'onBinary', 'onTitleChange', 'onBell', 'onWriteParsed',
    'windowOptions', '.input(',
  ]) {
    assert.ok(!code.includes(forbidden),
      `session-screen.js code must not reference ${forbidden}`);
  }
  // No log/escalation sink of any kind, per §9 ("Frame text never enters logs or escalation
  // records — counts and field values only").
  for (const sink of ['console.', 'process.stdout', 'process.stderr', 'child_process', 'fs.']) {
    assert.ok(!code.includes(sink), `session-screen.js must not reference ${sink}`);
  }
});

test('G-REPLY: DSR/DA/OSC sequences are consumed as controls, not printed into the grid', async () => {
  const screen = new vt.SessionScreen({
    sessionId: 'reply-grid',
    cause: 'stream_origin',
    localSource: true,
    geometrySource: 'local_pty',
    cols: 40,
    rows: 3,
    terminalFactory: H.realTerminalCtor(),
  });
  screen.noteOutput(`${ANSI.DSR}A${ANSI.DA}B${ANSI.OSC_TITLE('T')}C`);
  const frame = await H.frameAfterDrain(screen);

  assert.strictEqual(frame.rows_text[0], 'ABC',
    'only the printable units landed; no control leaked as literal text');
  screen.dispose();
});

test('§9: the frame qualifies an observation and authorizes nothing', async () => {
  // A worker that merely ECHOES modal-shaped text produces a GENUINE frame containing it.
  // The frame must not gain any field that could be read as authority.
  const screen = new vt.SessionScreen({
    sessionId: 'authority',
    cause: 'stream_origin',
    localSource: true,
    geometrySource: 'local_pty',
    cols: 60,
    rows: 4,
    terminalFactory: H.realTerminalCtor(),
  });
  screen.noteOutput('Do you want to proceed? [y/N]');
  const frame = await H.frameAfterDrain(screen);

  assert.strictEqual(frame.observation_basis, 'vt_grid', 'the observation is genuinely complete');
  assert.match(frame.rows_text[0], /Do you want to proceed/, 'and the text really is on the screen');

  // ...and nothing in it says who put it there or what may be done about it.
  for (const forbidden of [
    'actuation_qualified', 'approved', 'authorized', 'permission', 'decision',
    'ready', 'idle', 'complete_turn', 'activity', 'surface',
  ]) {
    assert.ok(!(forbidden in frame), `frame must not carry \`${forbidden}\``);
  }
});
