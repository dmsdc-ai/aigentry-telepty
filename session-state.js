// session-state.js — PTY output-based session state machine for telepty.
//
// Automatically detects session state from PTY output patterns:
//   running      — PTY output actively flowing
//   idle         — no output for idle_timeout_ms + prompt pattern detected
//   thinking     — AI CLI spinner/progress patterns detected
//   stuck        — same error repeated stuck_repeat_count times within stuck_window_ms
//   waiting_input— Y/n or interactive prompt pattern detected
//
// Usage:
//   const { SessionStateMachine } = require('./session-state');
//   const sm = new SessionStateMachine(sessionId, config);
//   sm.feed(data);              // call on every PTY output chunk
//   sm.getState();              // → { state, since, confidence, last_output_preview, detail }
//   sm.onTransition(callback);  // (from, to, detail) => {}
//   sm.destroy();               // cleanup timers

'use strict';

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

const STATES = Object.freeze({
  RUNNING:       'running',
  IDLE:          'idle',
  THINKING:      'thinking',
  STUCK:         'stuck',
  WAITING_INPUT: 'waiting_input',
});

// ---------------------------------------------------------------------------
// Default configurable thresholds
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = Object.freeze({
  idle_timeout_ms:      5000,    // 5s silence + prompt → idle
  stuck_repeat_count:   3,       // same error N times → stuck
  stuck_window_ms:      180000,  // 3 min window for stuck detection
  thinking_timeout_ms:  300000,  // 5 min thinking before → stuck
  poll_interval_ms:     1000,    // state check tick interval
  output_preview_len:   200,     // last N chars for preview
  error_dedup_len:      120,     // error line length for dedup fingerprint
});

// ---------------------------------------------------------------------------
// Pattern sets (all terminal-agnostic, CLI-agnostic)
// ---------------------------------------------------------------------------

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
  /\.{3,}\s*$/,                // trailing dots "..."
];

// Interactive input prompts — session is waiting for user input
const WAITING_INPUT_PATTERNS = [
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

// Error patterns for stuck detection
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

// ANSI escape stripper
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b\[[\?]?[0-9;]*[hlm]/g;

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
    this._state = STATES.RUNNING;
    this._since = Date.now();
    this._confidence = 0.5;
    this._detail = null;

    // Output tracking
    this._lastOutputAt = Date.now();
    this._lastOutputPreview = '';
    this._recentLines = [];         // last N stripped lines
    this._maxRecentLines = 50;

    // Stuck detection: error fingerprints with timestamps
    this._errorHistory = [];        // [{ fingerprint, timestamp }]

    // Thinking start time (for thinking → stuck timeout)
    this._thinkingStartedAt = null;

    // Transition listeners
    this._listeners = [];

    // Periodic state check
    this._pollTimer = setInterval(() => this._tick(), this.config.poll_interval_ms);
  }

  // --- Public API ---

  feed(data) {
    if (typeof data !== 'string' || data.length === 0) return;

    const now = Date.now();
    this._lastOutputAt = now;

    // Store preview (last N chars, raw)
    const previewLen = this.config.output_preview_len;
    this._lastOutputPreview = (this._lastOutputPreview + data).slice(-previewLen);

    // Strip ANSI and split into lines for pattern analysis
    const cleaned = stripAnsi(data);
    const lines = cleaned.split(/\r?\n/).filter(l => l.trim().length > 0);

    for (const line of lines) {
      this._recentLines.push({ text: line.trim(), timestamp: now });
    }
    // Trim to max
    while (this._recentLines.length > this._maxRecentLines) {
      this._recentLines.shift();
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

    // --- Priority 1: waiting_input (most specific, must act on immediately) ---
    if (this._matchesAny(lastLine, WAITING_INPUT_PATTERNS)) {
      this._transition(STATES.WAITING_INPUT, 0.9, {
        trigger: 'pattern',
        matched_line: lastLine.slice(0, 100),
      });
      return;
    }

    // --- Priority 2: stuck detection (repeated errors) ---
    this._trackErrors(now);
    const stuckResult = this._checkStuck(now);
    if (stuckResult) {
      this._transition(STATES.STUCK, stuckResult.confidence, stuckResult.detail);
      return;
    }

    // --- Priority 3: thinking (AI spinner/progress) ---
    if (this._matchesAny(lastLine, THINKING_PATTERNS)) {
      this._transition(STATES.THINKING, 0.8, {
        trigger: 'pattern',
        matched_line: lastLine.slice(0, 100),
      });
      return;
    }

    // --- Priority 4: running (we just received output, not matching other patterns) ---
    this._transition(STATES.RUNNING, 0.9, {
      trigger: 'output_received',
    });
  }

  _tick() {
    const now = Date.now();
    const silenceMs = now - this._lastOutputAt;

    // Thinking → stuck after timeout
    if (this._state === STATES.THINKING && this._thinkingStartedAt) {
      const thinkingDuration = now - this._thinkingStartedAt;
      if (thinkingDuration > this.config.thinking_timeout_ms) {
        this._transition(STATES.STUCK, 0.7, {
          trigger: 'thinking_timeout',
          thinking_duration_ms: thinkingDuration,
        });
        return;
      }
    }

    // Silence → idle (only if last output looks like a prompt)
    if (silenceMs > this.config.idle_timeout_ms) {
      // Don't override stuck or waiting_input with idle
      if (this._state === STATES.STUCK || this._state === STATES.WAITING_INPUT) {
        return;
      }

      const lastLine = this._recentLines.length > 0
        ? this._recentLines[this._recentLines.length - 1].text
        : '';

      const hasPrompt = this._matchesAny(lastLine, PROMPT_PATTERNS);
      const confidence = hasPrompt ? 0.9 : 0.6;

      this._transition(STATES.IDLE, confidence, {
        trigger: hasPrompt ? 'prompt_detected' : 'silence_timeout',
        silence_ms: silenceMs,
        last_line: lastLine.slice(0, 100),
      });
    }
  }

  _trackErrors(now) {
    const cutoff = now - this.config.stuck_window_ms;
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

  _checkStuck(now) {
    if (this._errorHistory.length < this.config.stuck_repeat_count) {
      return null;
    }

    // Count fingerprint occurrences
    const counts = {};
    for (const e of this._errorHistory) {
      counts[e.fingerprint] = (counts[e.fingerprint] || 0) + 1;
    }

    for (const [fp, count] of Object.entries(counts)) {
      if (count >= this.config.stuck_repeat_count) {
        return {
          confidence: Math.min(0.95, 0.7 + (count - this.config.stuck_repeat_count) * 0.05),
          detail: {
            trigger: 'repeated_error',
            error_fingerprint: fp,
            repeat_count: count,
            window_ms: this.config.stuck_window_ms,
          },
        };
      }
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

module.exports = {
  STATES,
  DEFAULT_CONFIG,
  SessionStateMachine,
  SessionStateManager,
  // Exported for testing
  PROMPT_PATTERNS,
  THINKING_PATTERNS,
  WAITING_INPUT_PATTERNS,
  ERROR_PATTERNS,
  stripAnsi,
};
