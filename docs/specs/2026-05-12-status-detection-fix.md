# SPEC: Telepty status detection fix for REPORT-completed idle sessions

**Issue:** dmsdc-ai/aigentry-telepty#16  
**Date:** 2026-05-12  
**Status:** draft, awaiting orchestrator approval  
**Chosen direction:** (d) REPORT-event-based status transition, plus one minimal control-only PTY guard

## 1. Problem

`telepty list` can show a wrapped CLI session as `CONNECTED (OWNER_CONNECTED) 🔨 working` after the session has finished its assigned work, sent a `REPORT: ...` inject back to its caller, and returned to an idle prompt. The verified production case is a Gemini CLI session in its "standing by" prompt state.

This breaks orchestration because callers that wait for `working -> idle` can wait forever even though the session has semantically completed the task.

## 2. Verified Root Cause

The bug is not in CLI list formatting. `cli.js` only prints the daemon-provided `autoState`:

- `cli.js:897-903` renders `s.autoState.emoji` and `s.autoState.state`.
- `daemon.js:759-803` serializes `autoState` directly from `sessionStateManager.getState(id)`.

The incorrect value is produced before formatting, in the daemon state path:

- Wrapped sessions forward every PTY output chunk to the daemon as `{ type: 'output', data }` from `cli.js:1347-1354`.
- The daemon handles owner output at `daemon.js:2655-2662`, appends it to `outputRing`, and feeds it into `sessionStateManager.feed(sessionId, data)`.
- `session-state.js:204-222` strips ANSI and records non-empty lines, but still calls `_detect(now)` even when the stripped chunk contains no non-whitespace text.
- `_detect()` falls through to `WORKING` for any chunk that is not waiting/error/thinking (`session-state.js:340-343`).

Therefore a cursor blink or terminal-control redraw can call `feed()`, add no meaningful text, and still move the session to `working`.

The existing REPORT enforcement path also does not correct the sender's auto-state:

- Reverse-match REPORT detection happens in `daemon.js:1792-1828`.
- On a matching report, it deletes `pendingReports[senderAlias]` and broadcasts `TASK_COMPLETE_WITH_REPORT`.
- It does not call the state manager to mark the reporting sender idle.

So the verified failure is a combination of:

1. Gemini standby/prompt redraws keep producing PTY output chunks.
2. The state machine treats any such chunk as `working`, including control-only chunks.
3. A semantically completed `REPORT:` event is observed but not reflected in auto-state.

## 3. Decision

Implement direction (d): when a session sends a reverse-matched REPORT inject back to the source that assigned its pending work, force the reporting session's auto-state to `idle`.

Also add a narrow guard in `SessionStateMachine.feed()` so control-only chunks do not transition a session to `working`. This is not Gemini fingerprinting and does not change prompt heuristics; it only prevents zero-text terminal-control frames from being classified as work.

Rationale:

- REPORT reverse-match is already implemented and is the strongest available semantic signal that the task completed.
- It is CLI-agnostic and works across Claude, Codex, and Gemini when they use the documented `telepty inject --from <self> ... "REPORT: ..."` workflow.
- The control-only guard fixes the direct code-level false positive where cursor blink frames are currently classified as output work.
- No new dependency, no protocol break, no frame/PTY redesign.

Rejected alternatives:

- (b) Per-Gemini prompt fingerprinting: too CLI-specific and brittle.
- (c) Time-window frame counting: still treats decorative redraws as work and adds tuning knobs.
- Full output significance heuristics: larger behavioral surface than needed for issue #16.

## 4. Code Changes

### `session-state.js`

Add public state-manager support for semantic idle marking:

- `SessionStateMachine.markIdle(confidence, detail)`
- `SessionStateManager.markIdle(sessionId, confidence, detail)`

The detail should include:

```js
{
  trigger: 'report_inject',
  report_inject_id,
  report_status,
  source
}
```

Add a guard in `feed(data)` after ANSI stripping:

- If the stripped chunk has no non-whitespace text and no OSC 133 prompt marker, update last-output preview/timestamp as today, but do not call `_detect(now)`.
- This prevents cursor-only/control-only chunks from toggling `idle -> working`.
- Lifecycle states (`dead`, `restarting`) remain protected as today.

Estimated code change: ~35 LOC.

### `daemon.js`

In the reverse-match REPORT block (`daemon.js:1792-1828`):

- After delivery succeeds and `classification` is truthy, call `sessionStateManager.markIdle(senderAlias, 1.0, detail)`.
- Keep the existing `TASK_COMPLETE_WITH_REPORT`, `TASK_BLOCKED_WITH_REASON`, and `TASK_DISMISSED` events unchanged.
- Keep deleting `pendingReports[senderAlias]` as today.

For future work dispatch into that same session:

- No special protocol change is required. The next meaningful PTY output after a new inject will move the state back to `working` through the existing output path.
- The new control-only guard only ignores zero-text frames; substantive task output still transitions to `working`.

Estimated code change: ~15 LOC.

### Tests

Add/extend tests in existing files:

- `test/session-state.test.js`
  - Control-only ANSI/cursor chunk after `idle` does not transition to `working`.
  - `SessionStateManager.markIdle()` forces a `working` session to `idle` with `trigger: 'report_inject'`.

- `test/enforce-report.test.js` or `test/daemon.test.js`
  - With two sessions, create `pendingReports[sender]`, force sender to `working`, then send reverse-matched `REPORT: done` from sender to receiver; assert `/api/sessions/:sender/state` reports `auto.state === 'idle'`.
  - After the forced idle, simulate an owner output chunk containing only ANSI cursor/control data; assert state remains `idle`.
  - After the forced idle, simulate meaningful output (`"new task output\n"`); assert state becomes `working`.

Estimated test change: ~45 LOC.

Total estimated implementation delta: ~95 LOC.

## 5. Compatibility

- `telepty list` output shape is unchanged.
- `/api/sessions`, `/api/sessions/:id`, and `/api/sessions/:id/state` response shapes are unchanged unless tests choose to expose extra `detail` values already supported by the existing structure.
- Existing bus events are unchanged.
- Existing REPORT classification is reused.
- No new dependencies.
- No new environment variables.

## 6. Test Plan

Automated tests:

1. `node --test test/session-state.test.js`
2. `node --test test/enforce-report.test.js`
3. `npm test`

Manual/macOS verification:

1. Start daemon: `telepty daemon`.
2. Start Claude session via `telepty allow --id test-claude claude`.
3. Inject a long-running task with `--from orchestrator`; while it streams output, confirm `telepty list` shows `🔨 working`.
4. Let Claude finish and report back with `telepty inject --from test-claude orchestrator "REPORT: done"`; confirm `telepty list` shows `💤 idle` within normal state latency.
5. Repeat the same flow with Codex.
6. Repeat with Gemini. After Gemini displays its standby/input prompt and sends `REPORT: done`, confirm `telepty list` shows `💤 idle` and remains idle despite prompt cursor blink/control redraws.

Manual/Linux verification:

1. Run the same daemon + allow + inject flow on Linux for Claude and Codex.
2. If Gemini CLI is available on the Linux host, run the same Gemini standby verification.
3. If Gemini is unavailable, run the automated wrapped-session regression that simulates control-only PTY output after a reverse-matched REPORT.

Windows:

- Deferred unless current CI already covers Windows PTY behavior. The change is daemon/state-machine logic and has no OS-specific API dependency.

## 7. Risks

- If a CLI sends a `REPORT:` before doing real post-report cleanup output, the sender will briefly show `idle` and then return to `working` on substantive cleanup output. This is acceptable because the state machine should only ignore control-only chunks, not meaningful text.
- If a CLI emits decorative non-control text forever after reporting, this spec will not mask it indefinitely. That would require a broader significance heuristic or CLI-specific prompt fingerprinting, both intentionally out of scope for issue #16.

## 8. Approval Gate

No source code changes should land until orchestrator approves this draft.
