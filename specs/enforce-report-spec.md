# SPEC: Enforce result-summary REPORT when sessions go idle

**Source:** orchestrator inject d94c9990...
**Session:** aigentry-telepty
**Status:** SPEC — awaiting orchestrator approval
**Topic:** REPORT enforcement after inject-driven idle transitions

---

## 1. Design options & recommendation

### Option A — Gate idle transition until REPORT arrives
Prevent `idle` transition from firing for N seconds until content REPORT
detected as sent by the session.

- ❌ Violates invariant: "Do NOT break existing idle detection"
- ❌ Requires invasive state machine changes
- **Rejected.**

### Option B — Auto-summarize PTY output
Scrape last X lines of session PTY output, strip ANSI, attach as
`auto_summary` field on `TASK_COMPLETE`.

- ✅ Zero session-side changes
- ✅ Always provides content payload
- ❌ PTY scraping is noisy (progress bars, status lines, spinner remnants)
- ❌ Masks the root cause — sessions still forget to REPORT
- **Keep as fallback, not primary.**

### Option C — Two-stage notification
On idle transition, fire `TASK_IDLE_NO_REPORT` (not `TASK_COMPLETE`).
Watch for content REPORT inject BACK to the source session for N seconds.
If REPORT detected → emit `TASK_COMPLETE_WITH_REPORT`. Else → emit
`TASK_TIMEOUT_NO_REPORT` with `auto_summary` fallback (Option B).

- ✅ Observable from orchestrator without code changes (richer events)
- ✅ Doesn't break existing idle detection (fires AFTER idle transition)
- ✅ No session-side changes required
- ✅ Backward-compat (old consumers see bus event, just with new `type`)
- ✅ Provides clear state difference between "REPORTed" and "idled silently"
- **Recommended primary.**

### Option D — Prompt-injection reminder
When session about to go idle after inject, auto-inject reminder text.

- ❌ Interferes with active work
- ❌ Doesn't guarantee compliance
- ❌ Session might be in final cleanup — inject causes confusion
- **Rejected.**

### Recommendation: **Option C + Option B fallback**

Two-stage notification with PTY-scrape auto-summary as timeout fallback.
Minimal blast radius, maximal observability, preserves all invariants.

---

## 2. Content REPORT schema

Parse from inject body text via prefix. Structured envelope would require
session-side library; free-text prefix keeps all LLMs compatible.

**Detection rule:** An inject from session X BACK to session Y (where Y was
the original `--from` source for X's last inject) whose prompt text starts
with one of:
- `REPORT:` (completed / partial result)
- `STATUS:` (blocked / dismissed / error)
- `ENFORCE-SPEC:`, `SPEC:`, `OWNER-DIAGNOSIS:` — recognized REPORT variants

Required fields (parsed from pipe-separated text):
- `source_session` — auto (sender of the reply inject)
- `target_session` — auto (recipient, i.e. the original orchestrator)
- `inject_ref` — auto (matched via pendingReports tracking)
- `status` — parsed from prefix: `REPORT:` → completed; `STATUS: blocked` → blocked; etc.
- `summary` — the full prompt text (20-500 chars recommended, not enforced)
- `artifacts` — optional, parsed from `files={...}` pipe-field
- `next_action` — optional, parsed from `next={...}` pipe-field

**Non-breaking:** If the reply inject doesn't match any REPORT prefix, it's
treated as a regular inject (current behavior preserved).

---

## 3. Timeout + failure handling

| Condition | Action | Notification |
|---|---|---|
| REPORT arrives within `reportTimeoutSecs` (default 120s) | Cancel timer, mark as reported | `TASK_COMPLETE_WITH_REPORT` (rich payload) |
| No REPORT within `reportTimeoutSecs` | Fire timeout | `TASK_TIMEOUT_NO_REPORT` with `auto_summary` (last 40 non-blank stripAnsi lines from `session.outputRing`) |
| Session sends `STATUS: blocked` explicitly | Immediate settlement | `TASK_BLOCKED_WITH_REASON` |
| Session dies before REPORT | Detected via `dead` transition | `TASK_DEAD_NO_REPORT` with `auto_summary` |

**Interaction with existing 60s deliberation timeout:** Orthogonal. Deliberation
timeout is a separate orchestrator-level concept. This daemon-level REPORT
timeout fires AFTER idle but BEFORE any orchestrator follow-up. Default 120s
gives orchestrator time to see `TASK_IDLE_NO_REPORT` and follow up before
auto-summary fires.

---

## 4. Back-compat

- Legacy `TASK_COMPLETE: {session} is now idle after processing inject ({N}s)`
  text format: **deprecated but kept emitting** for 1 minor version. Emit BOTH
  the new `TASK_IDLE_NO_REPORT` bus event AND the legacy text-inject-to-source
  during transition period.
- New bus event types: `TASK_IDLE_NO_REPORT`, `TASK_COMPLETE_WITH_REPORT`,
  `TASK_TIMEOUT_NO_REPORT`, `TASK_BLOCKED_WITH_REASON`, `TASK_DEAD_NO_REPORT`.
- Sessions that never send REPORT: grandfathered — they get
  `TASK_TIMEOUT_NO_REPORT` with auto-summary fallback (no hard failure).
- Orchestrator code that parses legacy `TASK_COMPLETE: ...` text: still works
  (text still emitted during transition).

---

## 5. Scope boundaries

| Work source | Require REPORT? | How distinguished |
|---|---|---|
| Inject with `--from X` | ✅ Yes (track in `pendingReports[sessionId]`) | `pendingReports` map populated on inject |
| Inject without `--from` | ❌ No (no one to report to) | `pendingReports` key absent |
| User typed directly | ❌ No | No inject event, no pendingReport entry |
| Self-initiated REPORT inject | ❌ No (it IS the report) | prefix match: `REPORT:` etc. |

**Key rule:** Only sessions with a `pendingReports[id]` entry are subject to
enforcement. User-driven work naturally doesn't populate this map.

---

## 6. Files to modify

| File | Change |
|---|---|
| `daemon.js` — sessionStateManager.onTransition (lines 37-57) | Replace direct auto-report with two-stage notification. Fire `TASK_IDLE_NO_REPORT`, start REPORT watch timer. |
| `daemon.js` — inject endpoint (lines 1547-1550) | Extend `pendingReports[id]` with `awaitingReport: true`, `reportWatchUntil: ts`. |
| `daemon.js` — inject endpoint (new detection) | Check incoming inject prompt for REPORT prefix + reverse-match to originating pendingReport. If matched: cancel timer, fire `TASK_COMPLETE_WITH_REPORT`. |
| `daemon.js` — state machine `dead` transition handler | Fire `TASK_DEAD_NO_REPORT` with auto-summary. |
| `daemon.js` — new helper `buildAutoSummary(session)` | Read `session.outputRing`, strip ANSI, filter blanks, take last 40 lines, max 4KB. |
| `src/mailbox/config.js` or similar config | Add `reportTimeoutSecs: 120`, `autoSummaryLines: 40`, `autoSummaryMaxBytes: 4096`. |
| `daemon.js` — legacy auto-report removal (lines 2131-2147, 2328-2346) | Retire duplicate legacy paths (or keep with deprecation flag). |
| `test/daemon.test.js` | New tests: REPORT-detected path, timeout path, dead-before-report path, no-inject-source ignored path. |

No new files. No new ports. No new process spawning.

---

## 7. Test plan

**Unit tests (test/daemon.test.js additions):**
1. Idle after inject → emits `TASK_IDLE_NO_REPORT` bus event (NOT `TASK_COMPLETE`)
2. REPORT-prefixed inject reply within timeout → emits `TASK_COMPLETE_WITH_REPORT` with parsed fields
3. No REPORT within timeout → emits `TASK_TIMEOUT_NO_REPORT` with auto_summary containing last session output
4. `STATUS: blocked` reply → immediate `TASK_BLOCKED_WITH_REASON`
5. Session dies before report → `TASK_DEAD_NO_REPORT` with auto_summary
6. Idle WITHOUT pendingReports entry (user-driven work) → no enforcement events
7. `buildAutoSummary()`: strips ANSI, drops blanks, truncates to 40 lines / 4KB
8. Legacy text-inject to source still fires (back-compat grandfathering)

**E2E tests:**
1. Full cycle: `inject --from A B "task"` → B works → B sends `telepty inject --from B A "REPORT: ..."` → A receives REPORT → bus emits `TASK_COMPLETE_WITH_REPORT`
2. Timeout cycle: same but B never replies → after 120s → A receives `TASK_TIMEOUT_NO_REPORT` with auto_summary

**Regression:**
- All 131 existing tests pass unchanged
- Existing `TASK_COMPLETE:` text format still emitted (grandfather)

---

## 8. Semver

**Minor bump → 0.2.0.**

Justification:
- New bus event types (additive, not breaking)
- New config keys (additive with defaults)
- Legacy notification text preserved (back-compat)
- No breaking API changes
- Observable new behavior that consumers may opt into

Not a patch because it introduces new observable event types.
Not major because nothing is removed or renamed.

---

## 9. Risks — top 3

1. **REPORT detection false positives** — an inject back to source that
   happens to start with "REPORT:" but is actually a new task request gets
   miscategorized. Mitigation: REPORT detection requires BOTH prefix match
   AND reverse-match to `pendingReports[senderSession]` with matching
   `inject_ref`. If no pending outbound report tracked, treat as new inject.
2. **Auto-summary leaks sensitive output** — PTY output may contain secrets
   (tokens, passwords echoed). Mitigation: honor a denylist regex
   (`api[_-]?key|password|token=\\S+`) before attaching; truncate aggressive.
   Document that auto_summary is best-effort preview, not full transcript.
3. **Timeout storm on orchestrator** — if many sessions timeout simultaneously,
   orchestrator receives a flurry of `TASK_TIMEOUT_NO_REPORT` events.
   Mitigation: rate-limit timeout emissions per-orchestrator via mailbox
   coalescing (existing `notifyCoalesceMs`).

---

## 10. Open questions

1. **Should `TASK_IDLE_NO_REPORT` be delivered as an inject (legacy) or ONLY
   as a bus event?** Recommendation: bus event only during transition — legacy
   text-inject preserved unchanged. Rich event flows via bus where consumers
   can subscribe.
2. **Cross-machine:** Does the REPORT watch timer survive tailnet peer relay?
   Current `pendingReports` is in-memory on the daemon handling the inject.
   If orchestrator is on a different machine, does the remote peer also track?
   Recommendation: timer stays on the daemon that accepted the original
   inject; remote orchestrator gets events via existing bus relay. No
   cross-machine state sync needed.
3. **Should `dismissed` be session-initiated or orchestrator-initiated?**
   Proposed: session sends `STATUS: dismissed` (I decided not to do this);
   orchestrator can also mark via `DELETE /api/pendingReports/{id}`
   (new endpoint). Both clear the watch.
4. **Two injects in quick succession from same orchestrator:** First inject
   creates pendingReport; second inject arrives before REPORT for first.
   Does second inject overwrite or queue? Recommendation: overwrite (only
   latest inject expects REPORT). Log `[AUTO-REPORT] overwritten pending`
   warning for observability.
5. **reportTimeoutSecs default (120s):** Is this the right baseline? Evidence
   table shows tasks ranging 7.5s → 649s. 120s too short for long tasks.
   Alternative: no default timer — only fire fallback when `dead` detected
   or explicit orchestrator-side query. Needs orchestrator input.

---

## Invariants honored

- ✅ Existing idle detection unchanged (state machine onTransition fires as before)
- ✅ Orchestrator needs no code changes to benefit (bus events flow passively)
- ✅ No new process spawning / no new network ports
- ✅ Cross-machine sync via existing mailbox unchanged
- ✅ Scoped to REPORT enforcement — no inject rewrite
