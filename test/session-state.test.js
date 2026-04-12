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
    assert.equal(state.detail.trigger, 'osc_133_prompt');
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
    assert.equal(sm.getState().detail.trigger, 'repeated_error');
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
});
