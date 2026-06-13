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
  let everObservedOutput = false;

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
    if (visibility.observable && visibility.empty === false) everObservedOutput = true;
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
    } else if (everVisible) {
      // Body was visible then disappeared — the CR consumed the input line.
      return {
        accepted: true,
        retryable: false,
        waited_ms: now() - start,
        reason: 'body_consumed',
        visibility,
      };
    } else if (!getState) {
      // No state probe → preserve the optimistic body-absent accept so callers
      // without a sessionStateManager keep the prior screen-free behavior.
      return {
        accepted: true,
        retryable: false,
        waited_ms: now() - start,
        reason: 'body_absent',
        visibility,
      };
    }
    // else: body never observably present AND a state probe IS available — do NOT
    // optimistically accept on absence. A dropped CR on codex alt-screen renders
    // the body OFF the outputRing tail, so absence is not positive submit evidence
    // (#568 FM3). Keep polling within the window for the primary signal — a state
    // transition idle→working/thinking. If none arrives, fall through to no_land.

    if (now() - start >= timeoutMs) {
      if (visibility.visible) {
        // Body stayed in the input box the whole window — the CR was not consumed.
        return {
          accepted: false,
          retryable: true,
          waited_ms: now() - start,
          reason: 'body_still_visible',
          visibility,
          state: state || undefined,
        };
      }
      if (everObservedOutput) {
        // The terminal produced output (it is alive) but the body was never consumed
        // AND no state transition occurred — the CR did not land (#568 FM3, e.g. a
        // dropped CR on codex alt-screen). Truthful retryable failure, never a false
        // success on an unsent CR.
        return {
          accepted: false,
          retryable: true,
          waited_ms: now() - start,
          reason: 'no_land',
          visibility,
          state: state || undefined,
        };
      }
      // No observable terminal output at all for the whole window — we have zero
      // screen evidence either way. Preserve the long-standing optimistic accept
      // (back-compat: a wrapped session that never echoes), but mark it ambiguous.
      return {
        accepted: true,
        retryable: false,
        waited_ms: now() - start,
        reason: 'no_observable',
        ambiguous: true,
        visibility,
        state: state || undefined,
      };
    }

    await sleep(intervalMs);
  }
}

/**
 * Render-gate the submit CR (#568). Resolve `ready` only when the input is
 * settled enough to safely receive a bare 0x0D:
 *   - the injected body is echoed in the outputRing tail (the input is present), AND
 *   - the render has gone quiet — the tail is unchanged for ≥ quietWindowMs.
 *
 * This closes the FM1 busy-render race: the pre-#568 submit fired the CR with no
 * readiness gate, so under load the CR landed mid-render and the TUI dropped it.
 * The daemon applies the same gate before each retry CR (FM2).
 *
 * Bounded + best-effort: if the render never goes quiet within timeoutMs (e.g. a
 * continuous spinner), resolve { ready:false, reason:'timeout' } so the caller
 * STILL writes the CR — never worse than the pre-gate behavior. When the body
 * never echoes into the tail (alt-screen / non-echoing TUI), settle on the quiet
 * window alone once echoGraceMs has elapsed (reason:'settled_no_echo').
 *
 * Pure: outputRing-only, DI now/sleep — no I/O, no daemon coupling.
 *
 * @param {{ outputRing?: string[] }} session
 * @param {string} bodyText
 * @param {{ timeoutMs?: number, quietWindowMs?: number, echoGraceMs?: number, pollIntervalMs?: number, tailBytes?: number, stripAnsi?: Function, now?: Function, sleep?: Function }} [opts]
 * @returns {Promise<{ ready: boolean, reason: string, echoed: boolean, settled: boolean, waited_ms: number }>}
 */
async function awaitInputSettled(session, bodyText, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 1500;
  const quietWindowMs = Number.isFinite(opts.quietWindowMs) ? opts.quietWindowMs : 100;
  const echoGraceMs = Number.isFinite(opts.echoGraceMs) ? opts.echoGraceMs : 400;
  const pollIntervalMs = Number.isFinite(opts.pollIntervalMs) ? opts.pollIntervalMs : 30;
  const tailBytes = Number.isFinite(opts.tailBytes) ? opts.tailBytes : 8192;
  const stripAnsi = typeof opts.stripAnsi === 'function' ? opts.stripAnsi : (s) => s;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : (ms) => new Promise((r) => setTimeout(r, ms));

  const needle = normalize(bodyText);
  if (!needle) {
    return { ready: true, reason: 'empty_body', echoed: false, settled: true, waited_ms: 0 };
  }
  if (!session || !Array.isArray(session.outputRing)) {
    // No ring to observe — cannot gate; stay optimistic and never block the CR.
    return { ready: true, reason: 'no_ring', echoed: false, settled: false, waited_ms: 0 };
  }

  const start = now();
  let lastTail = null;
  let lastChangeAt = start;
  let everEchoed = false;

  while (true) {
    const tail = normalize(stripAnsi(readTail(session, tailBytes)));
    if (tail.indexOf(needle) !== -1) everEchoed = true;

    if (lastTail === null || tail !== lastTail) {
      // Render still active — reset the quiet-window timer.
      lastTail = tail;
      lastChangeAt = now();
    } else if (now() - lastChangeAt >= quietWindowMs) {
      // Tail unchanged for the full quiet window → render settled.
      if (everEchoed) {
        return { ready: true, reason: 'settled', echoed: true, settled: true, waited_ms: now() - start };
      }
      if (now() - start >= echoGraceMs) {
        return { ready: true, reason: 'settled_no_echo', echoed: false, settled: true, waited_ms: now() - start };
      }
    }

    if (now() - start >= timeoutMs) {
      return { ready: false, reason: 'timeout', echoed: everEchoed, settled: false, waited_ms: now() - start };
    }
    await sleep(pollIntervalMs);
  }
}

// #52: observe whether the injected body was ECHOED by the target TUI in frames
// appended AFTER the inject (composer/transcript redraw) — consumption evidence that
// gates the TASK_IDLE_UNCONFIRMED warning. Conservative by design (never-false-complete):
//   - the normalized body must be ≥ minChars (short/common strings claim nothing);
//   - matching samples fixed-length windows of the body (step minChars/2) so a echo
//     wrapped across bordered composer lines is still observed, while requiring
//     `needed` distinct window hits for long bodies;
//   - only frames past the `sinceBytes` watermark count, and a window that ALSO appears
//     in the pre-inject portion of the ring is discarded — a redraw of an identical
//     earlier message is NOT fresh echo.
// Pure: outputRing-only, DI stripAnsi — no I/O, no daemon coupling.
function observeInjectEcho(session, bodyText, opts = {}) {
  const minChars = Number.isFinite(opts.minChars) ? opts.minChars : 24;
  const stripAnsi = typeof opts.stripAnsi === 'function' ? opts.stripAnsi : (s) => s;
  const sinceBytes = Number.isFinite(opts.sinceBytes) ? opts.sinceBytes : null;

  const body = normalize(bodyText);
  if (body.length < minChars) {
    return { observed: false, reason: body.length === 0 ? 'empty_body' : 'body_too_short' };
  }
  if (!session || !Array.isArray(session.outputRing) || session.outputRing.length === 0) {
    return { observed: false, reason: 'no_ring' };
  }

  // Split the ring at the inject watermark: only post-inject frames may witness echo,
  // and pre-inject frames veto windows that already existed on screen before the inject.
  let preRaw = '';
  let postRaw = '';
  if (sinceBytes !== null && Number.isFinite(session.outputRingTotalBytes)) {
    const appended = Math.max(0, session.outputRingTotalBytes - sinceBytes);
    if (appended === 0) return { observed: false, reason: 'no_frames_since_inject' };
    const all = session.outputRing.join('');
    const splitAt = Math.max(0, all.length - appended);
    preRaw = all.slice(0, splitAt);
    postRaw = all.slice(splitAt);
  } else {
    // No watermark (legacy entry) — treat the whole ring as post-inject, with no veto.
    postRaw = session.outputRing.join('');
  }
  const post = normalize(stripAnsi(postRaw));
  const pre = normalize(stripAnsi(preRaw));

  const step = Math.max(1, Math.floor(minChars / 2));
  const windows = [];
  for (let i = 0; i + minChars <= body.length; i += step) {
    windows.push(body.slice(i, i + minChars));
  }

  const needed = body.length >= minChars * 2 ? 2 : 1;
  let hits = 0;
  for (const w of windows) {
    if (post.indexOf(w) !== -1 && pre.indexOf(w) === -1) {
      hits++;
      if (hits >= needed) return { observed: true, reason: 'echo', windows_matched: hits };
    }
  }
  return { observed: false, reason: 'no_echo', windows_matched: hits };
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
      empty: haystack.length === 0,
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
    // #568: distinguish "terminal alive but body off-screen" (empty=false → a
    // dropped CR is no_land) from "no screen evidence at all" (empty=true → stay
    // optimistic). Used by confirmSubmitAccepted's bounded timeout fallback.
    empty: haystack.length === 0,
  };
}

// PTY-native confirm (#544): do NOT shell to `cmux read-screen` for the submit
// confirm. The body-visibility source is the PTY-fed outputRing
// (observeBodyVisibility falls through to it when this returns null). An explicit
// opts.readScreen seam is still honored (tests / future surface adaptors); the
// cmux default is dropped so confirmation is screen-free and no longer depends on
// the flaky cmux surface. The pre-submit readiness probe (awaitPromptSymbol) keeps
// its own defaultReadScreen — that is a separate concern, out of scope here.
// See docs/adr/2026-06-07-submit-via-pty-context-layer.md.
function readCurrentScreen(session, opts = {}) {
  const readScreen = typeof opts.readScreen === 'function' ? opts.readScreen : null;
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
  awaitInputSettled,
  verifyBodyConsumed,
  confirmSubmitAccepted,
  observeBodyVisibility,
  observeInjectEcho,
  awaitPromptSymbol,
  defaultReadScreen,
  isReady,
  isFailed,
  READY_STATES,
  FAIL_STATES,
  ACCEPTED_AFTER_SUBMIT_STATES,
};
