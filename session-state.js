// session-state.js — PTY output-based session state machine for telepty.
//
// 8-state dynamic session control (#185):
//   starting     — PTY not yet spawned / initializing
//   idle         — prompt detected (OSC 133;B or pattern), ready for input
//   working      — PTY output actively flowing (AI generating text)
//   thinking     — AI spinner/progress patterns (no substantive text)
//   waiting      — interactive prompt detected (approve, y/n, confirm)
//   error        — error patterns detected in output
//   restarting   — CLI restart triggered
//   dead         — PTY process terminated
//
// Usage:
//   const { SessionStateMachine } = require('./session-state');
//   const sm = new SessionStateMachine(sessionId, config);
//   sm.feed(data);              // call on every PTY output chunk
//   sm.markStarting();          // daemon: PTY spawn initiated
//   sm.markDead(exitCode);      // daemon: PTY exited
//   sm.markRestarting();        // daemon: auto-restart triggered
//   sm.getState();              // → { state, since, confidence, last_output_preview, detail }
//   sm.onTransition(callback);  // (from, to, detail) => {}
//   sm.destroy();               // cleanup timers

'use strict';

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

const STATES = Object.freeze({
  STARTING:    'starting',
  IDLE:        'idle',
  WORKING:     'working',
  THINKING:    'thinking',
  WAITING:     'waiting',
  ERROR:       'error',
  RESTARTING:  'restarting',
  DEAD:        'dead',
});

// State display metadata
const STATE_DISPLAY = Object.freeze({
  [STATES.STARTING]:   { emoji: '🔄', color: '\x1b[33m' },  // yellow
  [STATES.IDLE]:       { emoji: '💤', color: '\x1b[32m' },   // green
  [STATES.WORKING]:    { emoji: '🔨', color: '\x1b[36m' },   // cyan
  [STATES.THINKING]:   { emoji: '🧠', color: '\x1b[35m' },   // magenta
  [STATES.WAITING]:    { emoji: '⏳', color: '\x1b[33m' },   // yellow
  [STATES.ERROR]:      { emoji: '🔴', color: '\x1b[31m' },   // red
  [STATES.RESTARTING]: { emoji: '🔄', color: '\x1b[33m' },   // yellow
  [STATES.DEAD]:       { emoji: '☠️', color: '\x1b[90m' },    // gray
});

// ---------------------------------------------------------------------------
// Default configurable thresholds
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = Object.freeze({
  idle_timeout_ms:      5000,    // 5s silence + prompt → idle
  error_repeat_count:   3,       // same error N times → high confidence
  error_window_ms:      180000,  // 3 min window for error dedup
  thinking_timeout_ms:  300000,  // 5 min thinking before → error
  poll_interval_ms:     1000,    // state check tick interval
  output_preview_len:   200,     // last N chars for preview
  error_dedup_len:      120,     // error line length for dedup fingerprint
});

// ---------------------------------------------------------------------------
// Pattern sets (all terminal-agnostic, CLI-agnostic)
// ---------------------------------------------------------------------------

// OSC 133 prompt marks — high-confidence idle detection
// OSC 133;A = prompt start, OSC 133;B = command start (prompt ready)
// Both indicate the shell/CLI is at a prompt waiting for input.
const OSC_133_RE = /\x1b\]133;[AB](?:\x07|\x1b\\)/;

// Shell prompt patterns — last line of output looks like a prompt
const PROMPT_PATTERNS = [
  /[$#%>❯›»] *$/,              // common shell prompts
  />>> *$/,                     // python REPL
  /\.\.\. *$/,                  // python continuation
  /\(.*\) *[$#>] *$/,          // virtualenv / conda prefix
  /^\[.*@.*\][$#] *$/m,        // [user@host]$
];

// AI CLI thinking indicators (spinner frames, progress text)
const THINKING_PATTERNS = [
  /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,             // braille spinner frames
  /[⣾⣽⣻⢿⡿⣟⣯⣷]/,               // braille spinner alt
  /[|/\-\\]\s/,                 // classic spinner |/-\
  /[◐◓◑◒]/,                    // circle spinner
  /[⠁⠂⠄⡀⢀⠠⠐⠈]/,               // dot spinner
  /\bthinking\b/i,             // literal "thinking"
  /\banalyzing\b/i,            // literal "analyzing"
  /\bprocessing\b/i,           // literal "processing"
  /\bwriting\b/i,              // Claude Code "Writing..."
  /\breading\b/i,              // Claude Code "Reading..."
  /\bsearching\b/i,            // Claude Code "Searching..."
  /\bplanning\b/i,             // Claude Code "Planning..."
  // codex CLI active-work markers (#558): codex emits NO braille spinner and NO OSC 133, so its
  // "busy" state went unrecognized → blank sidebar pill. These are high-signal codex/claude markers
  // shown ONLY while actively generating/running tools. ("Working" is intentionally NOT matched —
  // it false-positives on common dev output like "working tree" / "working directory".)
  /\besc to interrupt\b/i,     // codex + claude: shown only during active generation / tool run
  /\bstarting mcp servers?\b/i,// codex: MCP bootstrap on launch
  /\bbooting mcp server\b/i,   // codex: MCP server boot
  /\bexploring\b/i,            // codex activity verb (parallels Claude Code "Searching")
  /\.{3,}\s*$/,                // trailing dots "..."
];

// Interactive input prompts — session is waiting for user input
const WAITING_PATTERNS = [
  /\[Y\/n\]/i,                 // [Y/n]
  /\(y\/N\)/i,                 // (y/N)
  /\[yes\/no\]/i,              // [yes/no]
  /\bpress enter\b/i,          // press enter
  /\bcontinue\?\s*$/i,         // Continue?
  /\bproceed\?\s*$/i,          // Proceed?
  /\bconfirm\?\s*$/i,          // Confirm?
  /\boverwrite\?\s*$/i,        // Overwrite?
  /\(y\)\s*$/i,                // (y)
  /\breplace\?\s*$/i,          // Replace?
  /\bpassword[:\s]*$/i,        // Password:
  /\bpassphrase[:\s]*$/i,      // Passphrase:
  /\btoken[:\s]*$/i,           // Token:
  /\benter .*[:\s]*$/i,        // Enter something:
];

// Error patterns for error detection
const ERROR_PATTERNS = [
  /\berror\b[:\[]/i,
  /\bError:/,
  /\bFAILED\b/,
  /\bfailed\b/,
  /\bpanic\b/i,
  /\bfatal\b/i,
  /\bEXCEPTION\b/i,
  /\btraceback\b/i,
  /\bsegmentation fault\b/i,
  /\bcommand not found\b/i,
  /\bpermission denied\b/i,
  /\bENOENT\b/,
  /\bEACCES\b/,
  /\bECONNREFUSED\b/,
];

// ANSI escape stripper (preserves OSC 133 detection by running after OSC check)
// CSI branch = ECMA-48 CSI (see #715): params 0x30-0x3f (incl. < > = : ? used by
// kitty-keyboard/modifyOtherKeys), intermediates 0x20-0x2f, final 0x40-0x7e. The
// prior [0-9;] param class leaked claude v2.1.198's ESC[<u/ESC[>1u/ESC[>4;2m (#713).
const ANSI_RE = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b\][^\x07]*\x07|\x1b[()][AB012]/g;

function stripAnsi(str) {
  return str.replace(ANSI_RE, '');
}

// ---------------------------------------------------------------------------
// SessionStateMachine
// ---------------------------------------------------------------------------

class SessionStateMachine {
  constructor(sessionId, config = {}) {
    this.sessionId = sessionId;
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Current state
    this._state = STATES.STARTING;
    this._since = Date.now();
    this._confidence = 1.0;
    this._detail = null;

    // Output tracking
    this._lastOutputAt = Date.now();
    this._lastOutputPreview = '';
    this._recentLines = [];         // last N stripped lines
    this._maxRecentLines = 50;

    // OSC 133 tracking
    this._lastOsc133At = null;

    // Error detection: error fingerprints with timestamps
    this._errorHistory = [];        // [{ fingerprint, timestamp }]

    // Thinking start time (for thinking → error timeout)
    this._thinkingStartedAt = null;

    // Transition listeners
    this._listeners = [];

    // Periodic state check
    this._pollTimer = setInterval(() => this._tick(), this.config.poll_interval_ms);

    // #60 §2.3 row 1 — stamp the start phase through markStarting() rather than leaving `_detail`
    // null. The constructor used to assign the STARTING state directly, so a session that had only
    // been registered carried no measured cause and mapObservationCause failed closed to
    // `unmapped_transition_cause`. That is not a transient window: `_tick` early-returns while the
    // state is STARTING, so a session which never emits output stays there permanently, and an
    // observation that can never fire is an absence this release promised to emit.
    //
    // Routed through markStarting() deliberately, not by assigning the detail here: that keeps ONE
    // definition of the initial cause. Two definitions, with this one silently skipped, IS the
    // defect. `_transition` short-circuits on same-state (it updates confidence/detail and fires no
    // listeners), so this records the cause without inventing a transition or disturbing `_since`.
    this.markStarting();
  }

  // --- Public API ---

  feed(data) {
    if (typeof data !== 'string' || data.length === 0) return;

    const now = Date.now();
    this._lastOutputAt = now;

    // Store preview (last N chars, raw)
    const previewLen = this.config.output_preview_len;
    this._lastOutputPreview = (this._lastOutputPreview + data).slice(-previewLen);

    // Check for OSC 133 prompt mark in RAW data (before ANSI stripping)
    if (OSC_133_RE.test(data)) {
      this._lastOsc133At = now;
      this._transition(STATES.IDLE, 0.95, {
        // #60 §2.3: the RAW marker arrival. Distinct from the _tick "quiet after a recent
        // marker" cause below — those two used to share `osc_133_prompt`, which let a quiet
        // timeout borrow the authority of a marker it never saw.
        trigger: 'osc_133_a_or_b_received',
        timestamp: new Date(now).toISOString(),
      });
      return;
    }

    // Strip ANSI and split into lines for pattern analysis
    const cleaned = stripAnsi(data);
    if (cleaned.trim().length === 0) {
      return;
    }
    const lines = cleaned.split(/\r?\n/).filter(l => l.trim().length > 0);

    for (const line of lines) {
      this._recentLines.push({ text: line.trim(), timestamp: now });
    }
    // Trim to max
    while (this._recentLines.length > this._maxRecentLines) {
      this._recentLines.shift();
    }

    // Don't run detection on lifecycle states managed externally
    if (this._state === STATES.DEAD || this._state === STATES.RESTARTING) {
      return;
    }

    // Run detection pipeline (order matters: most specific first)
    this._detect(now);
  }

  getState() {
    return {
      state: this._state,
      since: new Date(this._since).toISOString(),
      since_ms: this._since,
      duration_ms: Date.now() - this._since,
      confidence: this._confidence,
      last_output_at: new Date(this._lastOutputAt).toISOString(),
      last_output_preview: this._lastOutputPreview.slice(-this.config.output_preview_len),
      detail: this._detail,
    };
  }

  onTransition(callback) {
    this._listeners.push(callback);
  }

  reconfigure(config) {
    Object.assign(this.config, config);
  }

  destroy() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    this._listeners = [];
  }

  // --- Lifecycle methods (called by daemon) ---

  // #60 §2.3: start / restart / death used to share the single trigger `lifecycle`, so three
  // measurements with nothing in common serialized identically. Each now names its own cause.
  markStarting() {
    this._transition(STATES.STARTING, 1.0, { trigger: 'lifecycle_starting' });
  }

  markDead(exitCode, signal) {
    this._transition(STATES.DEAD, 1.0, {
      trigger: 'process_exit',
      exit_code: exitCode ?? null,
      signal: signal ?? null,
    });
  }

  markRestarting() {
    this._transition(STATES.RESTARTING, 1.0, { trigger: 'lifecycle_restarting' });
  }

  markIdle(confidence = 1.0, detail = {}) {
    if (this._state === STATES.DEAD || this._state === STATES.RESTARTING) {
      return;
    }
    this._transition(STATES.IDLE, confidence, {
      // #60 §2.3: caller detail is spread FIRST so a caller can never overwrite the normalized
      // cause. It used to be spread last, which let any caller passing `trigger` dress a bare
      // caller mark up as a screen-derived measurement.
      ...detail,
      trigger: 'manual_state_mark',
    });
  }

  // --- Internal ---

  _transition(newState, confidence, detail) {
    if (newState === this._state) {
      // Update confidence/detail without firing transition
      this._confidence = confidence;
      this._detail = detail;
      return;
    }

    const from = this._state;
    this._state = newState;
    this._since = Date.now();
    this._confidence = confidence;
    this._detail = detail;

    // Thinking timer management
    if (newState === STATES.THINKING) {
      this._thinkingStartedAt = this._thinkingStartedAt || Date.now();
    } else {
      this._thinkingStartedAt = null;
    }

    for (const cb of this._listeners) {
      try {
        cb(from, newState, {
          session_id: this.sessionId,
          confidence,
          detail,
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        // Don't let listener errors break the state machine
      }
    }
  }

  _detect(now) {
    const lastLine = this._recentLines.length > 0
      ? this._recentLines[this._recentLines.length - 1].text
      : '';

    // --- Priority 1: waiting (most specific, must act on immediately) ---
    if (this._matchesAny(lastLine, WAITING_PATTERNS)) {
      this._transition(STATES.WAITING, 0.9, {
        // #60 §2.3: was the shared `pattern`, indistinguishable from a thinking-spinner match.
        trigger: 'input_request_pattern',
        matched_line: lastLine.slice(0, 100),
      });
      return;
    }

    // --- Priority 2: error detection (error patterns in output) ---
    this._trackErrors(now);
    const errorResult = this._checkError(now);
    if (errorResult) {
      this._transition(STATES.ERROR, errorResult.confidence, errorResult.detail);
      return;
    }

    // --- Priority 3: thinking (AI spinner/progress) ---
    if (this._matchesAny(lastLine, THINKING_PATTERNS)) {
      this._transition(STATES.THINKING, 0.8, {
        // #60 §2.3: was the shared `pattern` (see the waiting entrance above).
        trigger: 'busy_indicator_pattern',
        matched_line: lastLine.slice(0, 100),
      });
      return;
    }

    // --- Priority 4: working (we just received output, not matching other patterns) ---
    this._transition(STATES.WORKING, 0.9, {
      trigger: 'output_received',
    });
  }

  _tick(now = Date.now()) {
    const silenceMs = now - this._lastOutputAt;

    // Don't override lifecycle states
    if (this._state === STATES.DEAD || this._state === STATES.RESTARTING || this._state === STATES.STARTING) {
      return;
    }

    // Thinking → error after timeout
    if (this._state === STATES.THINKING && this._thinkingStartedAt) {
      const thinkingDuration = now - this._thinkingStartedAt;
      if (thinkingDuration > this.config.thinking_timeout_ms) {
        this._transition(STATES.ERROR, 0.7, {
          trigger: 'thinking_timeout',
          thinking_duration_ms: thinkingDuration,
        });
        return;
      }
    }

    // Silence → idle (only if last output looks like a prompt or OSC 133 was recent)
    if (silenceMs > this.config.idle_timeout_ms) {
      // Don't override error or waiting with idle
      if (this._state === STATES.ERROR || this._state === STATES.WAITING) {
        return;
      }

      const lastLine = this._recentLines.length > 0
        ? this._recentLines[this._recentLines.length - 1].text
        : '';

      const hasOsc133 = this._lastOsc133At && (now - this._lastOsc133At) < this.config.idle_timeout_ms * 2;

      // #545: a THINKING session that merely went quiet is STILL thinking. The claude TUI
      // input-box glyph (›/❯) false-matches PROMPT_PATTERNS and pure silence flips at 0.6, so
      // a weak signal would wrongly end thinking. Only a reliable REPL-done mark (OSC 133) may.
      // WORKING is intentionally NOT guarded — a real shell prompt `$ ` legitimately settles
      // working→idle (test 255); the daemon real-idle gate covers the residual WORKING case.
      if (this._state === STATES.THINKING && !hasOsc133) {
        return;
      }

      const hasPrompt = this._matchesAny(lastLine, PROMPT_PATTERNS);
      const confidence = hasOsc133 ? 0.95 : (hasPrompt ? 0.9 : 0.6);

      this._transition(STATES.IDLE, confidence, {
        // #60 §2.3: three distinct measurements that used to collapse into two names. Quiet
        // AFTER a recent marker is not the marker itself, and a prompt-shaped suffix is a
        // detector match on untrusted current-frame bytes, not a turn boundary.
        trigger: hasOsc133
          ? 'quiet_after_recent_osc_133_a_or_b'
          : (hasPrompt ? 'prompt_suffix_after_quiet' : 'silence_timeout'),
        silence_ms: silenceMs,
        last_line: lastLine.slice(0, 100),
      });
    }
  }

  _trackErrors(now) {
    const cutoff = now - this.config.error_window_ms;
    // Expire old errors
    this._errorHistory = this._errorHistory.filter(e => e.timestamp > cutoff);

    // Check recent lines for errors
    for (const entry of this._recentLines) {
      if (entry._errorTracked) continue;
      entry._errorTracked = true;

      if (this._matchesAny(entry.text, ERROR_PATTERNS)) {
        const fingerprint = entry.text.slice(0, this.config.error_dedup_len).toLowerCase().trim();
        this._errorHistory.push({ fingerprint, timestamp: entry.timestamp });
      }
    }
  }

  _checkError(now) {
    if (this._errorHistory.length === 0) {
      return null;
    }

    // Count fingerprint occurrences
    const counts = {};
    for (const e of this._errorHistory) {
      counts[e.fingerprint] = (counts[e.fingerprint] || 0) + 1;
    }

    // Find the most repeated error
    let maxFp = null;
    let maxCount = 0;
    for (const [fp, count] of Object.entries(counts)) {
      if (count > maxCount) {
        maxCount = count;
        maxFp = fp;
      }
    }

    // Repeated errors → high confidence error state
    if (maxCount >= this.config.error_repeat_count) {
      return {
        confidence: Math.min(0.95, 0.7 + (maxCount - this.config.error_repeat_count) * 0.05),
        detail: {
          // #60 §2.3 / §7 item 5: the repeated-error entrance and the thinking-timeout
          // entrance both land in STATES.ERROR but measure different things. Naming the cause
          // is what stops a timeout from serializing as observed error text.
          trigger: 'repeated_error_pattern',
          error_fingerprint: maxFp,
          repeat_count: maxCount,
          window_ms: this.config.error_window_ms,
        },
      };
    }

    return null;
  }

  _matchesAny(text, patterns) {
    for (const pat of patterns) {
      if (pat.test(text)) return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// SessionStateManager — manages state machines for all sessions
// ---------------------------------------------------------------------------

class SessionStateManager {
  constructor(config = {}) {
    this.config = config;
    this._machines = new Map();  // sessionId → SessionStateMachine
    this._globalListeners = [];  // (sessionId, from, to, detail) => {}
  }

  /**
   * Initialize state tracking for a session.
   */
  register(sessionId, sessionConfig = {}) {
    if (this._machines.has(sessionId)) {
      return this._machines.get(sessionId);
    }

    const mergedConfig = { ...this.config, ...sessionConfig };
    const sm = new SessionStateMachine(sessionId, mergedConfig);

    // Wire global listeners
    sm.onTransition((from, to, detail) => {
      for (const cb of this._globalListeners) {
        try {
          cb(sessionId, from, to, detail);
        } catch (e) {
          // swallow
        }
      }
    });

    this._machines.set(sessionId, sm);
    return sm;
  }

  /**
   * Feed PTY output for a session.
   */
  feed(sessionId, data) {
    const sm = this._machines.get(sessionId);
    if (sm) sm.feed(data);
  }

  /**
   * Get state for a session.
   */
  getState(sessionId) {
    const sm = this._machines.get(sessionId);
    if (!sm) return null;
    return sm.getState();
  }

  /**
   * Get all session states.
   */
  getAllStates() {
    const result = {};
    for (const [id, sm] of this._machines) {
      result[id] = sm.getState();
    }
    return result;
  }

  /**
   * Mark a session as starting (PTY spawn initiated).
   */
  markStarting(sessionId) {
    const sm = this._machines.get(sessionId);
    if (sm) sm.markStarting();
  }

  /**
   * Mark a session as dead (PTY exited).
   */
  markDead(sessionId, exitCode, signal) {
    const sm = this._machines.get(sessionId);
    if (sm) sm.markDead(exitCode, signal);
  }

  /**
   * Mark a session as restarting (auto-restart triggered).
   */
  markRestarting(sessionId) {
    const sm = this._machines.get(sessionId);
    if (sm) sm.markRestarting();
  }

  /**
   * Mark a session as idle from a semantic daemon event.
   */
  markIdle(sessionId, confidence = 1.0, detail = {}) {
    const sm = this._machines.get(sessionId);
    if (!sm) return false;
    sm.markIdle(confidence, detail);
    return true;
  }

  /**
   * Unregister and cleanup a session's state machine.
   */
  unregister(sessionId) {
    const sm = this._machines.get(sessionId);
    if (sm) {
      sm.destroy();
      this._machines.delete(sessionId);
    }
  }

  /**
   * Reconfigure thresholds for a session (or all if no sessionId).
   */
  reconfigure(config, sessionId) {
    if (sessionId) {
      const sm = this._machines.get(sessionId);
      if (sm) sm.reconfigure(config);
    } else {
      Object.assign(this.config, config);
      for (const sm of this._machines.values()) {
        sm.reconfigure(config);
      }
    }
  }

  /**
   * Register a listener for ALL session state transitions.
   */
  onTransition(callback) {
    this._globalListeners.push(callback);
  }

  /**
   * Cleanup all state machines.
   */
  destroyAll() {
    for (const sm of this._machines.values()) {
      sm.destroy();
    }
    this._machines.clear();
    this._globalListeners = [];
  }
}

// ---------------------------------------------------------------------------
// #60 §2.3 — external observation vocabulary (pure)
// ---------------------------------------------------------------------------
//
// The external name is selected from the normalized measurement CAUSE, never from the
// destination state. That is the whole point: five different routes reach internal `idle`, and
// serializing the state name let a 0.6-confidence silence timeout present itself exactly like an
// OSC-133 REPL-done mark. Each row below names only what its entrance actually measured.
//
// `requires` lists the evidence fields the row cannot be stated without. A row whose evidence is
// missing fails closed to `unmapped_transition_cause` rather than emitting the stronger name with
// a hole in it.
const OBSERVATION_CAUSES = Object.freeze({
  lifecycle_starting:                { kind: 'session_start_phase_observed',            destinations: ['starting'],            requires: [] },
  osc_133_a_or_b_received:           { kind: 'osc_133_a_or_b_observed',                 destinations: ['idle'],                requires: ['timestamp'] },
  quiet_after_recent_osc_133_a_or_b: { kind: 'pty_quiet_after_osc_133_a_or_b_observed', destinations: ['idle'],                requires: ['silence_ms'] },
  prompt_suffix_after_quiet:         { kind: 'prompt_suffix_after_quiet_observed',      destinations: ['idle'],                requires: ['silence_ms'] },
  silence_timeout:                   { kind: 'pty_quiet',                               destinations: ['idle'],                requires: ['silence_ms'] },
  manual_state_mark:                 { kind: 'manual_state_mark_observed',              destinations: ['idle'],                requires: [] },
  output_received:                   { kind: 'output_observed',                         destinations: ['working'],             requires: [] },
  busy_indicator_pattern:            { kind: 'busy_indicator_pattern_observed',         destinations: ['thinking'],            requires: ['matched_line'] },
  input_request_pattern:             { kind: 'input_request_pattern_observed',          destinations: ['waiting'],             requires: ['matched_line'] },
  repeated_error_pattern:            { kind: 'repeated_error_pattern_observed',         destinations: ['error'],               requires: ['error_fingerprint', 'repeat_count', 'window_ms'] },
  thinking_timeout:                  { kind: 'thinking_classification_timeout_observed', destinations: ['error'],             requires: ['thinking_duration_ms'] },
  lifecycle_restarting:              { kind: 'session_restart_mark_observed',           destinations: ['restarting'],          requires: [] },
  process_exit:                      { kind: 'session_process_exited',                  destinations: ['dead'],                requires: [] },
  // #815 owner lifecycle, consumed by Stage A as lifecycle facts only (§3 "Stage A consumption
  // of #815 owner lifecycle"). Neither is a task outcome.
  owner_epoch_replaced:              { kind: 'owner_replaced_observed',                 destinations: ['*'],                   requires: ['displaced_session_epoch'] },
  owner_process_exited:              { kind: 'session_process_exited',                  destinations: ['*'],                   requires: [] },
  // §3.7 — qualified bridge readiness. DELIVERY-readiness hints only: they say a surface looks
  // ready to receive an inject, never that a turn ended. The unqualified legacy frame keeps its
  // own name so a 0.7.1 bridge's `{type:"ready"}` cannot borrow the qualified ones' meaning.
  ready_frame_composer_surface:      { kind: 'composer_surface_observed',               destinations: ['*'],                   requires: ['detector'] },
  ready_frame_prompt_suffix:         { kind: 'prompt_suffix_observed',                  destinations: ['*'],                   requires: ['detector'] },
  ready_frame_legacy_unqualified:    { kind: 'legacy_ready_observed',                   destinations: ['*'],                   requires: [] },
});

// Presentation, keyed by OBSERVATION KIND — not by internal state. STATE_DISPLAY maps internal
// `idle` to a GREEN sleeping pill, and that green is a done-semantics claim the sidebar reads as
// task success (§8.5.5). Quiet, prompt-shaped, marker and caller-mark observations are therefore
// NEUTRAL here. Nothing in this table is green.
const OBSERVATION_DISPLAY = Object.freeze({
  session_start_phase_observed:            { emoji: '🔄', color: '\x1b[33m', tone: 'pending' },
  osc_133_a_or_b_observed:                 { emoji: '•',  color: '\x1b[90m', tone: 'neutral' },
  pty_quiet_after_osc_133_a_or_b_observed: { emoji: '•',  color: '\x1b[90m', tone: 'neutral' },
  prompt_suffix_after_quiet_observed:      { emoji: '•',  color: '\x1b[90m', tone: 'neutral' },
  pty_quiet:                               { emoji: '·',  color: '\x1b[90m', tone: 'neutral' },
  manual_state_mark_observed:              { emoji: '✎',  color: '\x1b[90m', tone: 'neutral' },
  output_observed:                         { emoji: '🔨', color: '\x1b[36m', tone: 'active' },
  busy_indicator_pattern_observed:         { emoji: '🧠', color: '\x1b[35m', tone: 'active' },
  input_request_pattern_observed:          { emoji: '⏳', color: '\x1b[33m', tone: 'attention' },
  repeated_error_pattern_observed:         { emoji: '🔴', color: '\x1b[31m', tone: 'error' },
  thinking_classification_timeout_observed:{ emoji: '⏱',  color: '\x1b[33m', tone: 'attention' },
  session_restart_mark_observed:           { emoji: '🔄', color: '\x1b[33m', tone: 'pending' },
  session_process_exited:                  { emoji: '☠️', color: '\x1b[90m', tone: 'error' },
  owner_replaced_observed:                 { emoji: '⇄',  color: '\x1b[33m', tone: 'attention' },
  unmapped_transition_cause:               { emoji: '?',  color: '\x1b[37m', tone: 'neutral' },
});

/**
 * Map a measured transition to its external observation. PURE.
 *
 * Fails closed: an unknown cause, a cause that did not come from a destination it is defined
 * for, or a cause missing a required evidence field all return `unmapped_transition_cause`
 * carrying the raw destination and trigger. It NEVER falls back to a state-name mapping — that
 * fallback is the defect, because it is precisely how a weak cause inherits a strong name.
 *
 * @param {{destination?: string, cause?: string, evidence?: object}} input
 * @returns {{kind: string, cause: string|null, fields: object}}
 */
function mapObservationCause({ destination, cause, evidence } = {}) {
  const ev = evidence && typeof evidence === 'object' ? evidence : {};
  const row = Object.prototype.hasOwnProperty.call(OBSERVATION_CAUSES, String(cause))
    ? OBSERVATION_CAUSES[String(cause)]
    : null;
  const unmapped = (reason) => ({
    kind: 'unmapped_transition_cause',
    cause: cause == null ? null : String(cause),
    fields: { destination: destination == null ? null : String(destination), trigger: cause == null ? null : String(cause), reason },
  });

  if (!row) return unmapped('unknown_cause');
  if (!row.destinations.includes('*') && !row.destinations.includes(String(destination))) {
    return unmapped('cause_destination_mismatch');
  }
  const missing = row.requires.filter(f => ev[f] === undefined || ev[f] === null);
  if (missing.length > 0) return unmapped(`missing_evidence:${missing.join(',')}`);

  const fields = {};
  for (const f of row.requires) fields[f] = ev[f];
  // Always-useful qualifiers, included only when actually measured. `confidence` qualifies the
  // classifier; it never manufactures missing evidence and never qualifies completion.
  if (ev.last_output_at !== undefined) fields.last_output_at = ev.last_output_at;
  if (ev.confidence !== undefined) fields.confidence = ev.confidence;
  // Elapsed since the inject. A field, never a threshold: elapsed time is an observation and was
  // never a completion floor (§7 item 8).
  if (ev.elapsed_ms !== undefined) fields.elapsed_ms = ev.elapsed_ms;
  return { kind: row.kind, cause: String(cause), fields };
}

module.exports = {
  STATES,
  STATE_DISPLAY,
  OBSERVATION_CAUSES,
  OBSERVATION_DISPLAY,
  mapObservationCause,
  DEFAULT_CONFIG,
  SessionStateMachine,
  SessionStateManager,
  // Exported for testing
  PROMPT_PATTERNS,
  THINKING_PATTERNS,
  WAITING_PATTERNS,
  ERROR_PATTERNS,
  OSC_133_RE,
  stripAnsi,
};
