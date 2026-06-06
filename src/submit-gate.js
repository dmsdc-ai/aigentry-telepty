// src/submit-gate.js — Render-gated submit helpers (0.3.0)
// See docs/superpowers/specs/2026-04-26-inject-submit-enter-reliability.md
//
// Pure helpers (no I/O, no module-level state) used by daemon.js POST /submit
// to close the open-loop trap where Enter is fired before the target REPL is
// ready to consume it.
//
// Exports:
//   - awaitReplReady(sessionId, stateManager, opts) → Promise<{ ready, last_state, waited_ms, reason? }>
//   - verifyBodyConsumed(session, bodyText, opts)   → Promise<{ consumed, waited_ms, reason? }>
//   - confirmSubmitAccepted(session, bodyText, opts) → Promise<{ accepted, retryable, waited_ms, reason? }>
//   - isReady(state, minConfidence)                  (test surface)
//   - isFailed(state)                                (test surface)
//   - READY_STATES, FAIL_STATES                      (test surface)

'use strict';

// States where the REPL is willing to accept a keystroke.
// `idle`   — prompt detected, silence + (OSC 133 OR matched prompt pattern)
// `waiting` — interactive prompt (y/n, password, etc.) — Enter still applies
const READY_STATES = new Set(['idle', 'waiting']);

// States where waiting will never produce readiness; resolve immediately.
const FAIL_STATES = new Set(['dead', 'error', 'restarting']);
const ACCEPTED_AFTER_SUBMIT_STATES = new Set(['working', 'thinking']);

function isReady(state, minConfidence) {
  if (!state) return false;
  if (!READY_STATES.has(state.state)) return false;
  if (typeof state.confidence === 'number' && state.confidence < minConfidence) return false;
  return true;
}

function isFailed(state) {
  return !!(state && FAIL_STATES.has(state.state));
}

/**
 * Wait until the session's REPL is ready to accept Enter.
 *
 * Resolves immediately when the session is already in a READY_STATES with
 * confidence ≥ minConfidence, or when the state is unrecoverable (FAIL_STATES).
 * Otherwise listens for transitions until the session reaches readiness or
 * the bounded timeout elapses.
 *
 * @param {string} sessionId
 * @param {{ getState: Function, onTransition: Function }} stateManager
 * @param {{ timeoutMs?: number, minConfidence?: number }} [opts]
 * @returns {Promise<{ ready: boolean, last_state: string|null, waited_ms: number, reason?: string }>}
 */
function awaitReplReady(sessionId, stateManager, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 5000;
  // Default 0.5: below the lowest legitimate IDLE confidence (0.6, the
  // silence-fallback emit at session-state.js:380) with explicit margin.
  // Admits AI-CLI TUIs that emit no OSC 133 and whose Unicode-box input
  // line does not match PROMPT_PATTERNS — the dominant fresh-spawn case.
  // Per-request override via `min_confidence` body field on POST /submit.
  // See: docs/superpowers/specs/2026-04-26-submit-gate-fixes-v2.md §2.2
  const minConfidence = Number.isFinite(opts.minConfidence) ? opts.minConfidence : 0.5;
  const start = Date.now();

  if (!stateManager || typeof stateManager.getState !== 'function') {
    return Promise.resolve({ ready: false, reason: 'no_state_manager', last_state: null, waited_ms: 0 });
  }

  const initial = stateManager.getState(sessionId);
  if (!initial) {
    return Promise.resolve({ ready: false, reason: 'no_state', last_state: null, waited_ms: 0 });
  }
  if (isReady(initial, minConfidence)) {
    return Promise.resolve({ ready: true, last_state: initial.state, waited_ms: 0 });
  }
  if (isFailed(initial)) {
    return Promise.resolve({
      ready: false,
      reason: `session_${initial.state}`,
      last_state: initial.state,
      waited_ms: 0,
    });
  }

  return new Promise((resolve) => {
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, waited_ms: Date.now() - start });
    };

    // stateManager.onTransition is add-only (no removal API). We make the
    // listener idempotent via the `settled` flag so it harmlessly no-ops
    // after this call resolves.
    const handler = (id, _from, to) => {
      if (settled) return;
      if (id !== sessionId) return;
      if (READY_STATES.has(to)) {
        const cur = stateManager.getState(sessionId);
        if (isReady(cur, minConfidence)) {
          finish({ ready: true, last_state: to });
        }
      } else if (FAIL_STATES.has(to)) {
        finish({ ready: false, reason: `session_${to}`, last_state: to });
      }
    };

    stateManager.onTransition(handler);

    const timer = setTimeout(() => {
      const cur = stateManager.getState(sessionId);
      finish({ ready: false, reason: 'timeout', last_state: cur ? cur.state : null });
    }, timeoutMs);
  });
}

/**
 * Verify that the inject body has been consumed (i.e., disappeared from the
 * input box) by polling the session's outputRing tail.
 *
 * Semantics:
 *   - body never visible in tail (ANSI-heavy render, line wrap, truncation):
 *     return { consumed: true, waited_ms: 0, reason: 'never_visible' }
 *     This is optimistic — without screen evidence we trust the dispatch.
 *   - body visible, then disappears: { consumed: true }
 *   - body visible for the entire timeout: { consumed: false, reason: 'still_visible' }
 *
 * @param {{ outputRing?: string[] }} session
 * @param {string} bodyText
 * @param {{ timeoutMs?: number, intervalMs?: number, tailBytes?: number, stripAnsi?: Function, now?: Function, sleep?: Function }} [opts]
 * @returns {Promise<{ consumed: boolean, waited_ms: number, reason?: string }>}
 */
async function verifyBodyConsumed(session, bodyText, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 1500;
  const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : 200;
  const tailBytes = Number.isFinite(opts.tailBytes) ? opts.tailBytes : 8192;
  const stripAnsi = typeof opts.stripAnsi === 'function' ? opts.stripAnsi : (s) => s;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : (ms) => new Promise((r) => setTimeout(r, ms));

  if (!session || !Array.isArray(session.outputRing)) {
    return { consumed: false, reason: 'no_ring', waited_ms: 0 };
  }

  const needle = normalize(bodyText);
  if (!needle) {
    return { consumed: true, reason: 'empty_body', waited_ms: 0 };
  }

  const start = now();
  let everSeen = false;

  while (true) {
    const haystack = normalize(stripAnsi(readTail(session, tailBytes)));
    const visible = haystack.indexOf(needle) !== -1;
    if (visible) {
      everSeen = true;
    } else {
      return {
        consumed: true,
        waited_ms: now() - start,
        reason: everSeen ? 'consumed' : 'never_visible',
      };
    }
    if (now() - start >= timeoutMs) {
      return { consumed: false, reason: 'still_visible', waited_ms: now() - start };
    }
    await sleep(intervalMs);
  }
}

/**
 * Confirm that a submitted prompt was accepted by the target TUI.
 *
 * Accepted signals short-circuit immediately:
 *   - the injected body is absent from the current screen/output tail;
 *   - the session transitions to working/thinking after the CR was sent.
 *
 * The only retryable failure is confirmed-unsubmitted: the body stayed visible
 * for the whole bounded window. Ambiguous/no-observable cases are treated as
 * success for back-compat, but marked `ambiguous` so callers can report that
 * the success was optimistic. This keeps CR resend idempotent: resend only
 * when `retryable === true`.
 *
 * @param {{ outputRing?: string[], backend?: string, cmuxWorkspaceId?: string|null }} session
 * @param {string} bodyText
 * @param {{ timeoutMs?: number, intervalMs?: number, tailBytes?: number, stripAnsi?: Function, readScreen?: Function, tailLines?: number, getState?: Function, submittedAtMs?: number, now?: Function, sleep?: Function }} [opts]
 * @returns {Promise<{ accepted: boolean, retryable: boolean, waited_ms: number, reason?: string, ambiguous?: boolean, visibility?: object, state?: object }>}
 */
async function confirmSubmitAccepted(session, bodyText, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 1500;
  const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : 50;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const getState = typeof opts.getState === 'function' ? opts.getState : null;
  const submittedAtMs = Number.isFinite(opts.submittedAtMs) ? opts.submittedAtMs : now();
  const start = now();

  let lastVisibility = null;
  let everVisible = false;

  while (true) {
    const state = getState ? getState() : null;
    if (isAcceptedSubmitState(state, submittedAtMs)) {
      return {
        accepted: true,
        retryable: false,
        waited_ms: now() - start,
        reason: `state_${state.state}`,
        state,
        visibility: lastVisibility || undefined,
      };
    }

    const visibility = observeBodyVisibility(session, bodyText, opts);
    lastVisibility = visibility;
    if (visibility.reason === 'empty_body') {
      return {
        accepted: true,
        retryable: false,
        waited_ms: now() - start,
        reason: 'empty_body',
        visibility,
      };
    }
    if (!visibility.observable) {
      return {
        accepted: true,
        retryable: false,
        waited_ms: now() - start,
        reason: visibility.reason || 'no_observable',
        ambiguous: true,
        visibility,
      };
    }
    if (visibility.visible) {
      everVisible = true;
    } else {
      return {
        accepted: true,
        retryable: false,
        waited_ms: now() - start,
        reason: everVisible ? 'body_consumed' : 'body_absent',
        visibility,
      };
    }

    if (now() - start >= timeoutMs) {
      return {
        accepted: false,
        retryable: true,
        waited_ms: now() - start,
        reason: 'body_still_visible',
        visibility,
        state: state || undefined,
      };
    }

    await sleep(intervalMs);
  }
}

function isAcceptedSubmitState(state, submittedAtMs) {
  if (!state || !ACCEPTED_AFTER_SUBMIT_STATES.has(state.state)) return false;
  if (!Number.isFinite(submittedAtMs)) {
    return true;
  }
  if (Number.isFinite(state.since_ms) && state.since_ms >= submittedAtMs) {
    return true;
  }
  const lastOutputMs = state.last_output_at ? new Date(state.last_output_at).getTime() : NaN;
  if (Number.isFinite(lastOutputMs) && lastOutputMs >= submittedAtMs) {
    return true;
  }
  if (Number.isFinite(state.since_ms) && state.since_ms < submittedAtMs) {
    return false;
  }
  return false;
}

function observeBodyVisibility(session, bodyText, opts = {}) {
  const needle = normalize(bodyText);
  if (!needle) {
    return { observable: true, visible: false, source: 'body', reason: 'empty_body' };
  }

  const stripAnsi = typeof opts.stripAnsi === 'function' ? opts.stripAnsi : (s) => s;
  const screen = readCurrentScreen(session, opts);
  if (typeof screen === 'string' && screen.length > 0) {
    const haystack = normalize(stripAnsi(screen));
    return {
      observable: true,
      visible: haystack.indexOf(needle) !== -1,
      source: 'screen',
    };
  }

  if (!session || !Array.isArray(session.outputRing)) {
    return { observable: false, visible: false, source: 'none', reason: 'no_ring' };
  }

  const tailBytes = Number.isFinite(opts.tailBytes) ? opts.tailBytes : 8192;
  const haystack = normalize(stripAnsi(readTail(session, tailBytes)));
  return {
    observable: true,
    visible: haystack.indexOf(needle) !== -1,
    source: 'output_ring',
  };
}

function readCurrentScreen(session, opts = {}) {
  const readScreen = typeof opts.readScreen === 'function'
    ? opts.readScreen
    : (session && session.backend === 'cmux' && session.cmuxWorkspaceId ? defaultReadScreen : null);
  if (!readScreen || !session || !session.cmuxWorkspaceId) return null;
  const tailLines = Number.isFinite(opts.tailLines) ? opts.tailLines : 30;
  try {
    return readScreen(session.cmuxWorkspaceId, tailLines);
  } catch (_err) {
    return null;
  }
}

function normalize(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function readTail(session, maxBytes) {
  if (!session.outputRing || session.outputRing.length === 0) return '';
  let total = 0;
  const parts = [];
  for (let i = session.outputRing.length - 1; i >= 0 && total < maxBytes; i--) {
    const chunk = session.outputRing[i];
    parts.unshift(chunk);
    total += chunk.length;
  }
  return parts.join('');
}

/**
 * Layer 3 (0.3.2+): poll the rendered terminal screen via `cmux read-screen`
 * for the per-CLI prompt symbol and resolve only when the symbol has been
 * stably rendered for ≥ stabilityMs. Layered ABOVE awaitReplReady — strictly
 * additive: skips cleanly on non-cmux backends and unknown CLIs.
 *
 * Resolution shape:
 *   - { ready: true,  last_seen_at, waited_ms }
 *   - { ready: false, reason: 'no_screen_primitive', waited_ms: 0 }   // skip
 *   - { ready: false, reason: 'unknown_cli',         waited_ms: 0 }   // skip
 *   - { ready: false, reason: 'no_prompt_symbol_seen', waited_ms }    // best-effort fall-through
 *
 * @param {{ backend?: string, cmuxWorkspaceId?: string|null, command?: string }} session
 * @param {{ timeoutMs?: number, pollIntervalMs?: number, stabilityMs?: number, tailLines?: number, readScreen?: Function, registry?: { lookup: Function }, now?: Function, sleep?: Function }} [opts]
 * @returns {Promise<{ ready: boolean, waited_ms: number, last_seen_at?: number, reason?: string }>}
 */
async function awaitPromptSymbol(session, opts = {}) {
  const timeoutMs      = Number.isFinite(opts.timeoutMs)      ? opts.timeoutMs      : 8000;
  const pollIntervalMs = Number.isFinite(opts.pollIntervalMs) ? opts.pollIntervalMs : 150;
  const stabilityMs    = Number.isFinite(opts.stabilityMs)    ? opts.stabilityMs    : 200;
  const tailLines      = Number.isFinite(opts.tailLines)      ? opts.tailLines      : 30;
  const readScreen     = typeof opts.readScreen === 'function' ? opts.readScreen : defaultReadScreen;
  const registry       = opts.registry || require('./prompt-symbol-registry');
  const now            = typeof opts.now   === 'function' ? opts.now   : () => Date.now();
  const sleep          = typeof opts.sleep === 'function' ? opts.sleep : (ms) => new Promise((r) => setTimeout(r, ms));

  if (!session || session.backend !== 'cmux' || !session.cmuxWorkspaceId) {
    return { ready: false, reason: 'no_screen_primitive', waited_ms: 0 };
  }
  const entry = registry.lookup(session.command);
  if (!entry) {
    return { ready: false, reason: 'unknown_cli', waited_ms: 0 };
  }

  const start = now();
  let lastSeenAt = null;
  while (true) {
    const screen = readScreen(session.cmuxWorkspaceId, tailLines);
    if (screen) {
      const match = entry.detect(screen);
      if (match && match.found) {
        if (lastSeenAt === null) {
          lastSeenAt = now();
        } else if (now() - lastSeenAt >= stabilityMs) {
          // #472 (0.4.5): tag the success reason for debuggability — pairs
          // with daemon.js startup-restore optimistic-ready logging so we
          // can attribute every bootstrap_ready flip to a concrete signal.
          if (match.reason && typeof console !== 'undefined' && console.log) {
            console.log(`[bootstrap] ${session.command} ready via: ${match.reason}`);
          }
          return { ready: true, last_seen_at: lastSeenAt, waited_ms: now() - start, reason: match.reason };
        }
      } else {
        // symbol disappeared — reset the stability streak
        lastSeenAt = null;
      }
    }
    if (now() - start >= timeoutMs) {
      return { ready: false, reason: 'no_prompt_symbol_seen', waited_ms: now() - start };
    }
    await sleep(pollIntervalMs);
  }
}

function defaultReadScreen(workspaceId, lines) {
  const { execSync } = require('child_process');
  try {
    const out = execSync(
      `cmux read-screen --workspace ${workspaceId} --lines ${lines}`,
      { timeout: 1000, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 20 }
    );
    return out.toString('utf8');
  } catch (_err) {
    // cmux missing, workspace closed, permission denied — skip silently and
    // let the caller decide (typically: poll again until timeout, then fall
    // through to Layer 1).
    return '';
  }
}

module.exports = {
  awaitReplReady,
  verifyBodyConsumed,
  confirmSubmitAccepted,
  observeBodyVisibility,
  awaitPromptSymbol,
  defaultReadScreen,
  isReady,
  isFailed,
  READY_STATES,
  FAIL_STATES,
  ACCEPTED_AFTER_SUBMIT_STATES,
};
