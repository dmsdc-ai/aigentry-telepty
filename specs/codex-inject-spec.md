# SPEC: Codex inject reliability — 4 issues

**Bug source:** orchestrator inject e9f41301...
**Session:** aigentry-telepty
**Status:** SPEC — awaiting orchestrator approval

---

## Goal

Make `telepty inject` work reliably with codex sessions. Currently 4 failure
modes: Enter not pressed, active work overwrite, REPORT not sent, multi-task
partial processing.

---

## Root Cause Analysis

### Issue 1: inject succeeds but Enter NOT pressed

**Flow:** daemon `deliverInjectionToSession()` → mailbox → `tick()` →
`writeDataToSession()` sends text via WS → allow-bridge → `child.write(text)`.
Then 500ms later, `writeDataToSession(id, session, '\r')` → WS → allow-bridge →
`child.write('\r')`.

**Root cause:** codex CLI puts terminal in raw mode with custom input handling.
PTY-level `\r` via `child.write('\r')` is NOT equivalent to pressing Enter in
codex's input model. codex reads PTY input character by character in raw mode
and interprets `\r` differently than a keyboard Enter event.

**Evidence:** Project memory: "PTY `\r` 직접 의존 금지" — don't depend on PTY
`\r` directly. "inject submit은 항상 osascript/kitty terminal-level submit 우선".

The `--submit` flag exists in CLI but POST /submit also uses `submitViaPty()` →
same `\r` via WS. It does NOT use terminal-level submit (kitty/cmux).

### Issue 2: New inject overwrites active work

**Flow:** `deliverInjectionToSession()` enqueues to mailbox and calls
`mailboxDelivery.tick()` immediately. Text goes via WS → allow-bridge.

Allow-bridge has queuing: if `isIdle()` is false, text goes to
`enqueueBridgeMessage()`. The safety timer flushes after 5s regardless. But the
daemon doesn't check session state — it pushes immediately.

**Root cause:** Two layers of the problem:
1. Daemon sends inject regardless of session state (working/thinking/idle)
2. Allow-bridge 5s safety flush writes queued text to PTY even if session is
   still working, which interrupts codex's current task

### Issue 3: REPORT not sent after completion

**Flow:** Auto-report mechanism (`pendingReports`) triggers when allow-bridge
sends `{ type: 'ready' }` WS message. The `ready` signal fires when
`promptPattern.test(data)` matches in the PTY output.

**Root cause:** codex prompt pattern `codex: /[❯>]\s*$/` doesn't reliably match
codex's actual prompt output. If prompt is never detected → `ready` never sent →
`pendingReports` never cleared → auto-report never fires.

The new session state machine (#185) detects `idle` via OSC 133 + silence
timeout, but auto-report still uses the legacy `ready` WS signal (daemon.js
line 2290-2315), not the `session_auto_state` transitions.

### Issue 4: Multiple tasks in one inject — partial processing

**Root cause:** AI behavior, not telepty bug. When a --ref file contains Task A
+ Task B, codex processes Task A and returns to prompt. This is standard LLM
behavior — no telepty fix needed.

**Mitigation:** Orchestrator should split multi-task injects into separate
sequential calls with idle-gating between them (orchestrator-side logic).

---

## Scope

**Phase 1 (this spec):** Fix Issues 1 and 3 (guaranteed Enter + guaranteed
REPORT). These are telepty-side fixes.

**Phase 2 (separate task):** Fix Issue 2 (inject queuing during active work).
Requires daemon-side session state awareness.

**Out of scope:** Issue 4 (orchestrator-level task splitting).

---

## Files to Modify

| File | Change |
|---|---|
| `daemon.js` | Fix 1: `deliverInjectionToSession()` — use `sendViaKitty()` for CR instead of PTY `\r`. Fix 3: Wire auto-report to session state `idle` transition instead of legacy `ready` signal. |
| `daemon.js` | Fix 1: POST `/submit` endpoint — use kitty send-text with cmux fallback instead of `submitViaPty()`. |

---

## Approach

### Fix 1: Terminal-level submit for wrapped sessions

Replace PTY `\r` with `sendViaKitty()` in `deliverInjectionToSession()`:

```js
// BEFORE (daemon.js ~line 590):
if (!options.noEnter && session.type !== 'aterm') {
  const submitDelay = session.type === 'wrapped' ? 500 : 300;
  setTimeout(async () => {
    const submitResult = await writeDataToSession(id, session, '\r');
    // ...
  }, submitDelay);
}

// AFTER:
if (!options.noEnter && session.type !== 'aterm') {
  const submitDelay = session.type === 'wrapped' ? 500 : 300;
  setTimeout(async () => {
    let submitted = false;
    // Priority 1: kitty send-text (terminal-level, bypasses PTY quirks)
    if (session.type === 'wrapped') {
      submitted = sendViaKitty(id, '\r');
    }
    // Priority 2: cmux send-key (for cmux-managed sessions)
    if (!submitted && session.backend === 'cmux' && session.cmuxWorkspaceId) {
      submitted = submitViaCmux(id);
    }
    // Priority 3: PTY fallback (spawned sessions without kitty)
    if (!submitted) {
      const submitResult = await writeDataToSession(id, session, '\r');
      if (!submitResult.success) {
        emitInjectFailureEvent(id, submitResult.code, submitResult.error, {
          phase: 'submit', source: options.source || 'inject'
        }, session);
      }
    }
  }, submitDelay);
}
```

Also update POST `/submit` endpoint to use same priority chain instead of
always calling `submitViaPty()`.

### Fix 3: Auto-report via session state machine

Wire auto-report to the `session_auto_state` transition event (already emitted
by `sessionStateManager.onTransition()`). When a session transitions to `idle`
and has a pending report, fire the auto-report.

```js
// In the existing sessionStateManager.onTransition callback (daemon.js ~line 37):
sessionStateManager.onTransition((sessionId, from, to, detail) => {
  const session = sessions[sessionId];
  if (!session) return;
  broadcastSessionEvent('session_auto_state', sessionId, session, {
    extra: { auto_state: to, auto_state_from: from, auto_detail: detail }
  });

  // Auto-report: fire when session transitions to idle after inject
  if (to === 'idle' && pendingReports[sessionId]) {
    const pendingReport = pendingReports[sessionId];
    delete pendingReports[sessionId];
    const elapsed = ((Date.now() - new Date(pendingReport.injectedAt).getTime()) / 1000).toFixed(1);
    const reportMsg = `TASK_COMPLETE: ${sessionId} is now idle after processing inject (${elapsed}s)`;
    const srcId = resolveSessionAlias(pendingReport.source) || pendingReport.source;
    const srcSession = sessions[srcId];
    if (srcSession) {
      deliverInjectionToSession(srcId, srcSession, reportMsg, { noEnter: false, source: 'auto_report' });
      console.log(`[AUTO-REPORT] ${sessionId} → ${srcId}: idle after ${elapsed}s`);
    }
  }
});
```

Keep the legacy `ready`-based auto-report as fallback (don't remove it).

---

## Verification

1. **Test:** `telepty inject xtem-rtm "echo hello"` → codex processes it
   (Enter pressed via kitty send-text)
2. **Test:** `telepty inject --ref --from orchestrator xtem-rtm 'task'` → after
   codex completes → auto-report fires via idle state transition
3. **Test:** Sessions without kitty (spawned) → PTY `\r` fallback still works
4. **Test:** Existing 131 tests still pass

---

## Risks

1. **kitty not available.** Mitigated: 3-tier fallback (kitty → cmux → PTY).
   PTY path preserved as last resort.
2. **`sendViaKitty()` needs kitty socket + window ID match.** Already
   implemented and working for other features. If kitty window not found,
   falls through to PTY.
3. **Auto-report via state machine may fire too early.** The idle detection
   uses 5s silence timeout. If codex pauses >5s mid-task, it may fire
   prematurely. Mitigated: auto-report has `AUTO_REPORT_IDLE_SECONDS` (10s)
   threshold. Can add a minimum elapsed time guard.
4. **Dual auto-report paths (state machine + legacy ready).** Could fire
   twice. Mitigated: `delete pendingReports[sessionId]` in both paths —
   whichever fires first consumes the pending report.
