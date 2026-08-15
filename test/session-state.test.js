const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  STATES,
  STATE_DISPLAY,
  SessionStateMachine,
  SessionStateManager,
  PROMPT_PATTERNS,
  THINKING_PATTERNS,
  WAITING_PATTERNS,
  ERROR_PATTERNS,
  OSC_133_RE,
  stripAnsi,
} = require('../session-state');

// Helpers
function createSM(config = {}) {
  return new SessionStateMachine('test-session', {
    idle_timeout_ms: 100,
    poll_interval_ms: 50,
    thinking_timeout_ms: 500,
    error_repeat_count: 3,
    error_window_ms: 10000,
    ...config,
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- STATES ---

describe('STATES enum', () => {
  it('has exactly 8 states', () => {
    assert.equal(Object.keys(STATES).length, 8);
  });

  it('includes all required states', () => {
    assert.equal(STATES.STARTING, 'starting');
    assert.equal(STATES.IDLE, 'idle');
    assert.equal(STATES.WORKING, 'working');
    assert.equal(STATES.THINKING, 'thinking');
    assert.equal(STATES.WAITING, 'waiting');
    assert.equal(STATES.ERROR, 'error');
    assert.equal(STATES.RESTARTING, 'restarting');
    assert.equal(STATES.DEAD, 'dead');
  });
});

describe('STATE_DISPLAY', () => {
  it('has emoji for every state', () => {
    for (const state of Object.values(STATES)) {
      assert.ok(STATE_DISPLAY[state], `missing display for ${state}`);
      assert.ok(STATE_DISPLAY[state].emoji, `missing emoji for ${state}`);
      assert.ok(STATE_DISPLAY[state].color, `missing color for ${state}`);
    }
  });
});

// --- OSC 133 ---

describe('OSC 133 detection', () => {
  it('matches OSC 133;B with BEL terminator', () => {
    assert.ok(OSC_133_RE.test('\x1b]133;B\x07'));
  });

  it('matches OSC 133;A with BEL terminator', () => {
    assert.ok(OSC_133_RE.test('\x1b]133;A\x07'));
  });

  it('matches OSC 133;B with ST terminator', () => {
    assert.ok(OSC_133_RE.test('\x1b]133;B\x1b\\'));
  });

  it('does not match random OSC sequences', () => {
    assert.ok(!OSC_133_RE.test('\x1b]0;title\x07'));
  });
});

// --- State machine initial state ---

describe('SessionStateMachine initial state', () => {
  it('starts in starting state', () => {
    const sm = createSM();
    const state = sm.getState();
    assert.equal(state.state, 'starting');
    assert.equal(state.confidence, 1.0);
    sm.destroy();
  });
});

// --- OSC 133 → idle ---

describe('OSC 133 prompt → idle', () => {
  it('transitions to idle on OSC 133;B', () => {
    const sm = createSM();
    sm.feed('\x1b]133;B\x07');
    const state = sm.getState();
    assert.equal(state.state, 'idle');
    assert.equal(state.confidence, 0.95);
    // #60 §2.3: `osc_133_prompt` split. The RAW marker arrival keeps its measurement under
    // `osc_133_a_or_b_received`; the _tick "quiet after a recent marker" cause is a separate
    // name now, so a silence timeout can no longer borrow a marker it never saw.
    assert.equal(state.detail.trigger, 'osc_133_a_or_b_received');
    // The cause row cannot be stated without it, so its absence would fail closed.
    assert.ok(state.detail.timestamp, 'raw marker arrival carries its timestamp evidence');
    sm.destroy();
  });
});

// --- working detection ---

describe('working state', () => {
  it('transitions to working on regular output', () => {
    const sm = createSM();
    sm.feed('Building project files...\nCompiling module A\n');
    const state = sm.getState();
    assert.equal(state.state, 'working');
    assert.equal(state.confidence, 0.9);
    sm.destroy();
  });

  it('does not transition idle to working on control-only output', () => {
    const sm = createSM();
    sm.feed('\x1b]133;B\x07');
    assert.equal(sm.getState().state, 'idle');

    sm.feed('\x1b[?25l\r\x1b[2K\x1b[?25h');

    const state = sm.getState();
    assert.equal(state.state, 'idle');
    assert.equal(state.detail.trigger, 'osc_133_a_or_b_received');
    sm.destroy();
  });
});

// --- thinking detection ---

describe('thinking state', () => {
  it('detects braille spinner as thinking', () => {
    const sm = createSM();
    sm.feed('⠋ Processing...');
    assert.equal(sm.getState().state, 'thinking');
    sm.destroy();
  });

  it('detects "thinking" keyword', () => {
    const sm = createSM();
    sm.feed('Thinking about the problem...');
    assert.equal(sm.getState().state, 'thinking');
    sm.destroy();
  });

  it('transitions to error after thinking timeout', async () => {
    const sm = createSM({ thinking_timeout_ms: 100, poll_interval_ms: 30 });
    sm.feed('⠋');
    assert.equal(sm.getState().state, 'thinking');
    await sleep(200);
    assert.equal(sm.getState().state, 'error');
    assert.equal(sm.getState().detail.trigger, 'thinking_timeout');
    sm.destroy();
  });
});

// --- #558: non-claude CLI state classification (codex / gemini) ---
// codex and gemini emit NO OSC 133 prompt mark. gemini drives a braille spinner (already matched),
// but codex uses none — its active state is only conveyed by text markers ("esc to interrupt",
// "Starting MCP servers", activity verbs). Without these the codex sidebar pill stays blank.

describe('codex CLI state classification', () => {
  it('classifies active codex generation ("esc to interrupt") as thinking', () => {
    const sm = createSM();
    sm.feed('Implementing the change… (12s • esc to interrupt)');
    assert.equal(sm.getState().state, 'thinking');
    sm.destroy();
  });

  it('classifies codex MCP bootstrap as thinking', () => {
    const sm = createSM();
    sm.feed('• Starting MCP servers (1/6): aigentry-brain, codex_apps, context7');
    assert.equal(sm.getState().state, 'thinking');
    sm.destroy();
  });

  it('classifies codex "Exploring" activity as thinking', () => {
    const sm = createSM();
    sm.feed('Exploring the repository structure');
    assert.equal(sm.getState().state, 'thinking');
    sm.destroy();
  });

  it('settles to idle at the codex "›" prompt after silence', async () => {
    const sm = createSM({ idle_timeout_ms: 100, poll_interval_ms: 30 });
    sm.feed('Exploring the repository structure'); // active → thinking
    assert.equal(sm.getState().state, 'thinking');
    sm.feed('›'); // codex idle composer prompt (no OSC 133) → working, then silence → idle
    await sleep(250);
    assert.equal(sm.getState().state, 'idle');
    sm.destroy();
  });

  it('does NOT misclassify "working tree"/"working directory" as thinking', () => {
    const sm = createSM();
    sm.feed('On branch main; your working tree is clean');
    assert.equal(sm.getState().state, 'working');
    sm.destroy();
  });
});

describe('gemini CLI state classification', () => {
  it('classifies gemini braille spinner as thinking (already supported)', () => {
    const sm = createSM();
    sm.feed('⠹ Thinking… (Press Esc to cancel)');
    assert.equal(sm.getState().state, 'thinking');
    sm.destroy();
  });
});

// --- waiting detection ---

describe('waiting state', () => {
  it('detects [Y/n] prompt', () => {
    const sm = createSM();
    sm.feed('Do you want to continue? [Y/n]');
    assert.equal(sm.getState().state, 'waiting');
    sm.destroy();
  });

  it('detects Proceed? prompt', () => {
    const sm = createSM();
    sm.feed('Proceed?');
    assert.equal(sm.getState().state, 'waiting');
    sm.destroy();
  });

  it('waiting has higher priority than working', () => {
    const sm = createSM();
    sm.feed('Some output here\nOverwrite? ');
    assert.equal(sm.getState().state, 'waiting');
    sm.destroy();
  });
});

// --- error detection ---

describe('error state', () => {
  it('transitions to error on repeated errors', () => {
    const sm = createSM({ error_repeat_count: 3 });
    sm.feed('Error: connection refused\n');
    assert.notEqual(sm.getState().state, 'error'); // 1 error not enough
    sm.feed('Error: connection refused\n');
    assert.notEqual(sm.getState().state, 'error'); // 2 errors not enough
    sm.feed('Error: connection refused\n');
    assert.equal(sm.getState().state, 'error'); // 3 errors → error
    // #60 §2.3: renamed `repeated_error` → `repeated_error_pattern`. Both error entrances land
    // in `error`, but they measure different things (a repeated pattern vs a thinking timeout);
    // the destination alone can no longer name either one.
    const detail = sm.getState().detail;
    assert.equal(detail.trigger, 'repeated_error_pattern');
    // The evidence the cause row cannot be stated without — absence fails closed to
    // `unmapped_transition_cause` rather than emitting the strong name with a hole in it.
    assert.ok(detail.error_fingerprint, 'carries the error fingerprint');
    assert.equal(detail.repeat_count, 3);
    assert.ok(Number.isFinite(detail.window_ms), 'carries the dedup window');
    sm.destroy();
  });
});

// --- lifecycle methods ---

describe('lifecycle methods', () => {
  it('markStarting transitions to starting', () => {
    const sm = createSM();
    sm.feed('some output');
    assert.equal(sm.getState().state, 'working');
    sm.markStarting();
    assert.equal(sm.getState().state, 'starting');
    assert.equal(sm.getState().confidence, 1.0);
    sm.destroy();
  });

  it('markDead transitions to dead with exit info', () => {
    const sm = createSM();
    sm.feed('some output');
    sm.markDead(1, 'SIGTERM');
    const state = sm.getState();
    assert.equal(state.state, 'dead');
    assert.equal(state.confidence, 1.0);
    assert.equal(state.detail.exit_code, 1);
    assert.equal(state.detail.signal, 'SIGTERM');
    sm.destroy();
  });

  it('markRestarting transitions to restarting', () => {
    const sm = createSM();
    sm.markDead(1, null);
    sm.markRestarting();
    assert.equal(sm.getState().state, 'restarting');
    sm.destroy();
  });

  it('dead state ignores PTY output', () => {
    const sm = createSM();
    sm.markDead(0, null);
    sm.feed('ghost output');
    assert.equal(sm.getState().state, 'dead');
    sm.destroy();
  });

  it('restarting state ignores PTY output', () => {
    const sm = createSM();
    sm.markRestarting();
    sm.feed('startup noise');
    assert.equal(sm.getState().state, 'restarting');
    sm.destroy();
  });
});

// --- idle via silence timeout ---

describe('idle via silence timeout', () => {
  it('transitions to idle after silence with prompt', async () => {
    const sm = createSM({ idle_timeout_ms: 80, poll_interval_ms: 30 });
    sm.feed('$ ');
    assert.equal(sm.getState().state, 'working');
    await sleep(150);
    assert.equal(sm.getState().state, 'idle');
    sm.destroy();
  });

  it('does not override waiting with idle', async () => {
    const sm = createSM({ idle_timeout_ms: 80, poll_interval_ms: 30 });
    sm.feed('Continue? [Y/n]');
    assert.equal(sm.getState().state, 'waiting');
    await sleep(150);
    assert.equal(sm.getState().state, 'waiting');
    sm.destroy();
  });
});

// --- #545: THINKING must not silence-idle without a reliable OSC133 mark ---
// A real claude worker that is still thinking (spinner shown) but whose PTY output pauses
// > idle_timeout was being flipped to idle (the claude TUI input-box glyph ›/❯ false-matches
// PROMPT_PATTERNS, and pure silence flips at confidence 0.6). Only OSC 133 (REPL-done) may end
// THINKING. WORKING is intentionally NOT guarded — a real shell prompt still settles idle.
describe('#545 idle gate: THINKING-only OSC133 guard', () => {
  it('a still-THINKING session that goes silent without OSC133 STAYS thinking (never idle)', () => {
    const sm = createSM({ idle_timeout_ms: 1000, thinking_timeout_ms: 60000, poll_interval_ms: 60000 });
    sm.feed('⠋ Thinking…');           // braille spinner → thinking
    assert.equal(sm.getState().state, 'thinking');
    // Drive the tick deterministically past idle_timeout (but under thinking_timeout), no
    // OSC133, non-prompt last line.
    sm._tick(Date.now() + 5000);
    assert.equal(sm.getState().state, 'thinking', 'a still-thinking worker must NOT be flipped idle by silence');
    sm.destroy();
  });

  it('no-regression (Option B): a WORKING session with a shell prompt still settles idle on silence', () => {
    const sm = createSM({ idle_timeout_ms: 1000, poll_interval_ms: 60000 });
    sm.feed('$ ');
    assert.equal(sm.getState().state, 'working');
    sm._tick(Date.now() + 5000);
    assert.equal(sm.getState().state, 'idle', 'legitimate shell prompt idle-detection must NOT regress');
    sm.destroy();
  });
});

// --- transition callbacks ---

describe('transition callbacks', () => {
  it('fires onTransition with from/to/detail', () => {
    const sm = createSM();
    const transitions = [];
    sm.onTransition((from, to, detail) => {
      transitions.push({ from, to, detail });
    });
    sm.feed('hello world');
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].from, 'starting');
    assert.equal(transitions[0].to, 'working');
    sm.destroy();
  });
});

// --- SessionStateManager ---

describe('SessionStateManager', () => {
  it('register creates state machine in starting state', () => {
    const mgr = new SessionStateManager();
    mgr.register('s1');
    const state = mgr.getState('s1');
    assert.equal(state.state, 'starting');
    mgr.destroyAll();
  });

  it('feed updates session state', () => {
    const mgr = new SessionStateManager();
    mgr.register('s1');
    mgr.feed('s1', 'hello');
    assert.equal(mgr.getState('s1').state, 'working');
    mgr.destroyAll();
  });

  it('markDead sets dead state', () => {
    const mgr = new SessionStateManager();
    mgr.register('s1');
    mgr.markDead('s1', 1, null);
    assert.equal(mgr.getState('s1').state, 'dead');
    mgr.destroyAll();
  });

  it('markStarting sets starting state', () => {
    const mgr = new SessionStateManager();
    mgr.register('s1');
    mgr.feed('s1', 'output');
    mgr.markStarting('s1');
    assert.equal(mgr.getState('s1').state, 'starting');
    mgr.destroyAll();
  });

  it('markRestarting sets restarting state', () => {
    const mgr = new SessionStateManager();
    mgr.register('s1');
    mgr.markRestarting('s1');
    assert.equal(mgr.getState('s1').state, 'restarting');
    mgr.destroyAll();
  });

  it('markIdle forces a working session to idle and normalizes the caller trigger', () => {
    const mgr = new SessionStateManager();
    mgr.register('s1');
    mgr.feed('s1', 'task output\n');
    assert.equal(mgr.getState('s1').state, 'working');

    // This used to assert `detail.trigger === 'report_inject'` — that a CALLER could name the
    // cause of an idle mark. #60 §2.3 withdraws that: a caller mark measures nothing about the
    // screen, so caller detail is now spread BEFORE the cause and the cause is always
    // `manual_state_mark`. `report_status` is gone with the report classifier and is not passed.
    const marked = mgr.markIdle('s1', 1.0, {
      trigger: 'report_inject',
      report_inject_id: 'report-1',
      source: 'orchestrator',
    });

    const state = mgr.getState('s1');
    assert.equal(marked, true);
    assert.equal(state.state, 'idle');
    assert.equal(state.confidence, 1.0);
    assert.equal(state.detail.trigger, 'manual_state_mark');
    // Caller CONTEXT still passes through — it just cannot rename the measurement.
    assert.equal(state.detail.report_inject_id, 'report-1');
    assert.equal(state.detail.source, 'orchestrator');
    mgr.destroyAll();
  });

  it('markIdle caller cannot borrow a screen-derived cause', () => {
    const mgr = new SessionStateManager();
    mgr.register('s1');
    mgr.feed('s1', 'task output\n');

    // The strong form of the above: the exact string a real marker arrival produces, supplied by
    // a caller who saw no marker, must not survive. Overwriting here is how a bare caller mark
    // used to present itself as a 0.95-confidence OSC-133 measurement.
    mgr.markIdle('s1', 1.0, { trigger: 'osc_133_a_or_b_received' });
    assert.equal(mgr.getState('s1').detail.trigger, 'manual_state_mark');
    mgr.destroyAll();
  });

  it('getAllStates returns all session states', () => {
    const mgr = new SessionStateManager();
    mgr.register('s1');
    mgr.register('s2');
    const all = mgr.getAllStates();
    assert.equal(Object.keys(all).length, 2);
    assert.ok(all.s1);
    assert.ok(all.s2);
    mgr.destroyAll();
  });

  it('unregister cleans up state machine', () => {
    const mgr = new SessionStateManager();
    mgr.register('s1');
    mgr.unregister('s1');
    assert.equal(mgr.getState('s1'), null);
    mgr.destroyAll();
  });

  it('global onTransition fires for any session', () => {
    const mgr = new SessionStateManager();
    const events = [];
    mgr.onTransition((sessionId, from, to) => {
      events.push({ sessionId, from, to });
    });
    mgr.register('s1');
    mgr.feed('s1', 'output');
    assert.equal(events.length, 1);
    assert.equal(events[0].sessionId, 's1');
    assert.equal(events[0].to, 'working');
    mgr.destroyAll();
  });
});

// --- Pattern coverage ---

describe('pattern matching', () => {
  it('PROMPT_PATTERNS match shell prompts', () => {
    const prompts = ['$ ', '# ', '% ', '>>> ', '[user@host]$ '];
    for (const p of prompts) {
      assert.ok(PROMPT_PATTERNS.some(pat => pat.test(p)), `should match: ${p}`);
    }
  });

  it('THINKING_PATTERNS match spinners and keywords', () => {
    const thinking = ['⠋', '⣾', 'Thinking...', 'Analyzing the code', 'Writing...'];
    for (const t of thinking) {
      assert.ok(THINKING_PATTERNS.some(pat => pat.test(t)), `should match: ${t}`);
    }
  });

  it('WAITING_PATTERNS match interactive prompts', () => {
    const waiting = ['[Y/n]', '(y/N)', 'Continue?', 'Proceed?', 'Password:'];
    for (const w of waiting) {
      assert.ok(WAITING_PATTERNS.some(pat => pat.test(w)), `should match: ${w}`);
    }
  });

  it('ERROR_PATTERNS match error messages', () => {
    const errors = ['Error: something', 'FAILED', 'panic: runtime error', 'ENOENT'];
    for (const e of errors) {
      assert.ok(ERROR_PATTERNS.some(pat => pat.test(e)), `should match: ${e}`);
    }
  });
});

// --- stripAnsi ---

describe('stripAnsi', () => {
  it('removes ANSI color codes', () => {
    assert.equal(stripAnsi('\x1b[32mhello\x1b[0m'), 'hello');
  });

  it('removes OSC sequences', () => {
    assert.equal(stripAnsi('\x1b]0;title\x07text'), 'text');
  });

  it('preserves plain text', () => {
    assert.equal(stripAnsi('plain text'), 'plain text');
  });

  it('removes kitty-keyboard / modifyOtherKeys CSI sequences (< > = params) — #713', () => {
    // claude v2.1.198 and codex re-emit these every render. The <, >, = param
    // bytes are valid ECMA-48 CSI parameter bytes (0x30-0x3f); the pre-#713
    // [0-9;] class dropped them, leaking the escapes into state classification.
    assert.equal(stripAnsi('A\x1b[<uB'), 'AB');    // kitty keyboard pop
    assert.equal(stripAnsi('A\x1b[>1uB'), 'AB');   // kitty keyboard push flags=1
    assert.equal(stripAnsi('A\x1b[>7uB'), 'AB');   // kitty keyboard push flags=7
    assert.equal(stripAnsi('A\x1b[>4;2mB'), 'AB');  // modifyOtherKeys mode 2
    assert.equal(stripAnsi('A\x1b[>0qB'), 'AB');   // XTVERSION query
  });

  it('still strips normal + truecolor SGR (no over-strip regression)', () => {
    assert.equal(stripAnsi('A\x1b[39mB'), 'AB');
    assert.equal(stripAnsi('A\x1b[38;2;215;119;87mB'), 'AB');
  });
});
