# SPEC: Welcome-bootstrap handshake fix for first inject after spawn

**Issue:** dmsdc-ai/aigentry-telepty#18  
**Date:** 2026-05-12  
**Status:** draft, awaiting orchestrator approval  
**Chosen direction:** hybrid: (3) daemon-side bootstrap queue + stricter wrapped-CLI ready signal

## 1. Problem

A fresh wrapped AI CLI session can lose its first dispatch when `telepty inject`
runs immediately after `telepty allow` starts the session. The payload can land
while Claude/Codex/Gemini is still rendering a welcome/bootstrap input surface,
then remain unprocessed or be overwritten by a later inject/broadcast. The issue
body records five verified reproductions on 2026-05-12.

This breaks autonomous orchestration because the daemon reports successful
delivery while the target session never reaches the assigned task.

## 2. Verified Root Cause

The root cause is a readiness contract mismatch between daemon registration,
the allow bridge, and submit delivery.

Verified code path:

- `cli.js:1002-1015` registers the wrapped session before the child CLI has
  reached its REPL prompt.
- `daemon.js:1029-1053` stores new wrapped sessions with `ready: true`, so the
  daemon considers them injectable immediately after registration.
- `cli.js:1294-1298` connects the owner WebSocket and prints `Inject allowed.`
  before any prompt-ready signal has been observed.
- `daemon.js:1742-1762` accepts `/api/sessions/:id/inject` immediately and
  calls `deliverInjectionToSession`.
- `daemon.js:660-677` enqueues the prompt into the daemon mailbox and forces an
  immediate delivery tick; `daemon.js:614-619` then sends `{type:"inject"}` to
  the allow bridge owner WebSocket.

There is a bridge-side queue, but it is not a bootstrap-safe handshake:

- `cli.js:1228-1257` queues text when `isIdle()` is false.
- `cli.js:1240-1244` receives `\r` while text is queued, queues the CR, and
  immediately calls `flushBridgeMailbox()` without checking `isIdle()` again.
  This can release the first dispatch into the welcome input box.
- `cli.js:1167-1175` has a 5 second safety timer that flushes queued text even
  if no prompt was detected.
- `cli.js:1355-1358` treats a raw chunk matching `/[❯>]\s*$/` as prompt-ready
  and flushes immediately. That detector is too weak for AI CLI welcome screens
  because a bootstrap/welcome input row can also end in a prompt-like glyph.
- `daemon.js:1475-1707` gates terminal-level submit, but the gate uses the
  general session state. During bootstrap, `session-state.js:380-399` can mark
  an idle state after silence with confidence 0.6, and `src/submit-gate.js:49-70`
  accepts that by default (`minConfidence` 0.5). That is sufficient for ordinary
  submit timing but not strong enough to prove first-REPL readiness.

Therefore the first dispatch can be released before the target CLI has crossed
the welcome/bootstrap boundary. The daemon has no authoritative "this wrapped
CLI is ready for its first command" state, and the existing queues can flush on
weak prompt evidence, elapsed time, or CR arrival.

## 3. Decision

Implement a daemon-owned bootstrap handshake for wrapped AI CLI sessions:

1. Wrapped sessions for known AI CLIs (`claude`, `codex`, `gemini`) start in
   `bootstrap_ready = false`.
2. Inject and submit operations delivered before bootstrap readiness are queued
   in daemon memory in arrival order. The daemon returns success for queued
   injects, but does not write payload bytes to the allow bridge until readiness
   is proven.
3. Bootstrap readiness is marked only by a strong ready detector:
   - preferred: rendered prompt-symbol detection using the existing
     `src/prompt-symbol-registry.js` rules for `cmux read-screen`;
   - fallback: allow-bridge `type:"ready"` emitted from the same centralized
     per-CLI ready registry, not the current bare `/[❯>]\s*$/` chunk regex;
   - generic/unknown commands keep current permissive behavior for backwards
     compatibility.
4. When bootstrap readiness is marked, the daemon drains queued operations
   sequentially: inject text first, submit/CR second, preserving the exact order
   in which the caller issued them.
5. The bridge must stop using bootstrap-unsafe release paths for known AI CLIs:
   CR must not force a queued-text flush while not ready, and the 5 second
   safety flush must not apply before first ready for known AI CLIs.

This is a hybrid because the durable behavioral guarantee belongs in the daemon
(direction 3), while the daemon still needs a trustworthy ready signal from the
terminal/CLI side.

Rejected alternatives:

- **Direction 1 only (`allow` waits/prints later):** insufficient. `telepty allow`
  is the long-running bridge process, and launch helpers can still inject via the
  daemon before a human-visible "ready" print is observed.
- **Direction 2 only (`inject --wait-ready`):** opt-in flags do not protect
  existing orchestrator calls or broadcasts.
- **Direction 4 only (`telepty handshake`):** useful for diagnostics, but it
  still relies on every caller remembering to use it.
- **Keep bridge queue and tune timers:** does not fix the verified CR-forces-flush
  and weak prompt-regex paths.

## 4. API and Data Model

No existing command or REST response shape is removed.

Additive internal/session fields:

- `session.bootstrapReady` boolean for wrapped sessions.
- `session.bootstrapReadyAt` ISO timestamp or `null`.
- `session.bootstrapReadyReason`, e.g. `cmux_prompt_symbol`, `bridge_ready`,
  `generic_command_compat`.
- `session.bootstrapQueue`, an in-memory FIFO of pending operations:
  `{ type: "inject" | "submit", inject_id?, prompt?, options?, submit_body? }`.

Existing `/api/sessions`, `/api/sessions/:id`, and `/api/sessions/:id/state`
may expose these values under `transport.bootstrap` or equivalent additive
metadata. Existing `ready` remains present; for known wrapped AI CLIs it should
mean "ready for immediate delivery", while pre-ready sessions still accept
injects by queuing them.

Optional additive CLI/API surface:

- `telepty handshake <sid> [--timeout <ms>]`
- `GET /api/sessions/:id/handshake?timeout_ms=<ms>`

The handshake command is diagnostic and orchestration-friendly, not required for
correctness. Existing callers must keep working without it because pre-ready
injects are queued automatically.

## 5. Ready Detection Rules

Define all per-CLI readiness rules in one module. Prefer extending
`src/prompt-symbol-registry.js` or replacing it with a broader
`src/cli-ready-registry.js` that is imported by both daemon submit gates and the
allow bridge.

Required known CLI rules:

- `claude`: ready when the rendered screen shows the active empty `❯` input row
  adjacent to Claude's prompt box border. Do not use a bare trailing `>` or `❯`
  chunk as bootstrap-ready.
- `codex`: ready when the rendered screen shows ` › ` in the active input row and
  a `gpt-*` model footer within the expected nearby lines.
- `gemini`: ready when the rendered screen shows the active ` *   ...` input row
  bracketed by Gemini's box geometry (`▀`/`▄`).
- generic/unknown command: preserve current permissive behavior so `telepty allow
  --id x bash` and existing tests do not regress.

Readiness sources, in priority order:

1. `cmux read-screen` via the existing `awaitPromptSymbol` path when
   `session.backend === "cmux" && session.cmuxWorkspaceId`.
2. Bridge-emitted `type:"ready"` generated by the same centralized registry over
   a rolling PTY output/screen-like buffer.
3. Generic command compatibility fallback only for commands not recognized as
   Claude/Codex/Gemini.

Do not let `session-state` `silence_timeout` alone mark bootstrap readiness for
known AI CLIs.

## 6. Implementation Plan

### `daemon.js`

- Initialize known wrapped AI CLI sessions with `bootstrapReady: false`.
- Preserve permissive readiness for unknown wrapped commands and non-wrapped
  session types.
- Add `isBootstrapReady(session)` and `markBootstrapReady(id, session, reason)`.
- In `/api/sessions/:id/inject`, if the target is a known wrapped AI CLI and
  `bootstrapReady` is false, enqueue the inject operation in `session.bootstrapQueue`
  and return a successful queued response. Do not call `writeDataToSession`.
- In `/api/sessions/:id/submit`, if bootstrap is not ready or the bootstrap queue
  is non-empty, enqueue the submit operation after already queued injects and
  wait for drain within the existing bounded timeout. This preserves
  `telepty inject --submit` ordering.
- On owner `type:"ready"` and on successful cmux prompt-symbol detection, call
  `markBootstrapReady`.
- Drain `session.bootstrapQueue` sequentially after marking ready. Text delivery
  must complete before any related submit operation runs.
- Broadcast additive bus events for observability:
  `bootstrap_queue_queued`, `bootstrap_ready`, `bootstrap_queue_drained`,
  `bootstrap_queue_failed`.

### `cli.js`

- Replace the local `PROMPT_PATTERNS` map with the centralized ready registry.
- For known AI CLIs, remove the first-bootstrap 5 second safety flush.
- For known AI CLIs, change CR handling so `\r` is queued behind pending text but
  does not force `flushBridgeMailbox()` until readiness is proven.
- Keep generic command behavior compatible with current `telepty allow` tests.
- On reconnect, re-send `type:"ready"` only if the bridge has already observed a
  strong ready signal for the current child process.

### `src/prompt-symbol-registry.js` or new `src/cli-ready-registry.js`

- Keep `lookup(command)` behavior, including path/arg normalization.
- Export `isKnownAiCli(command)`.
- Export screen detector and bridge/output detector from a single registry.
- Keep existing prompt-symbol tests and add bootstrap/welcome negative fixtures.

Estimated implementation delta: about +220/-45 LOC.

## 7. Backwards Compatibility

- Existing `telepty inject`, `broadcast`, `multicast`, and `allow` commands keep
  their current syntax.
- Pre-ready injects still return success; the difference is that success means
  "accepted and queued for bootstrap-safe delivery" until ready.
- Unknown wrapped commands keep current permissive behavior.
- Existing `/api/sessions/*` response shapes remain valid; any bootstrap metadata
  is additive.
- No new npm dependency.
- No devkit-owned behavior is added.

## 8. Test Plan

Automated tests:

1. **Race regression:** spawn a fresh fake-Claude session through
   `telepty allow`, immediately issue `telepty inject --ref --submit --from orch
   <sid> <payload>` within 10 ms of the session becoming registered, and assert
   the fake CLI processes the original payload. Repeat 10 times; all pass.
2. **Welcome negative detector:** fake-Claude first renders a welcome input row
   containing `❯`/`>` before the real REPL prompt. Assert the first payload is
   not written during the welcome phase.
3. **Backwards compatibility:** delayed inject after 5 seconds still delivers and
   submits exactly once.
4. **Cross-CLI detectors:** run the same readiness detector tests for Claude,
   Codex, and Gemini fixtures. If the real CLI is unavailable in CI, use captured
   rendered-screen fixtures plus fake CLI bootstrap scripts.
5. **Multiple inject race:** spawn, immediately send three sequential injects,
   and assert all three are processed in order with no overwrite/loss.
6. **`--submit` ordering:** call `/inject` with `no_enter:true`, immediately call
   `/submit`, and assert queued text drains before submit fires.
7. **Default-enter ordering:** call `/inject` without `no_enter`; assert queued
   text and CR are drained in order after bootstrap readiness.
8. **CR does not force bootstrap flush:** with queued text and no ready signal,
   send CR; assert no bytes are written to the child until ready.
9. **Safety timer scoped:** for known AI CLIs, no first-bootstrap safety flush
   occurs before readiness; for unknown commands, compatibility fallback still
   allows delivery.
10. **Broadcast race:** broadcast while a known wrapped session is pre-ready;
    assert its broadcast is queued and delivered after the original dispatch
    only if it arrived after the dispatch.
11. **Session state compatibility:** `telepty list` and `/api/sessions/:id/state`
    still serialize valid `autoState` and additive bootstrap metadata.
12. Run `npm test`.

Manual/macOS verification:

1. Start daemon: `telepty daemon`.
2. Spawn Claude with `telepty allow --id race-claude claude`.
3. From a separate shell, inject within 10 ms after registration:
   `telepty inject --ref --submit --submit-retry 2 --from orch race-claude
   "REPORT test payload <token>"`.
4. Confirm Claude processes the original dispatch, not a later broadcast.
5. Repeat 10 times.
6. Repeat with Codex and Gemini when available.
7. Repeat a three-inject sequence and verify order.

## 9. Risks

- A too-strict detector can queue indefinitely. Mitigation: known AI CLIs emit
  `bootstrap_ready_timeout` telemetry and the optional handshake endpoint returns
  a structured timeout instead of silently dropping payloads.
- A too-loose detector recreates the bug. Mitigation: negative welcome fixtures
  are required for Claude/Codex/Gemini before implementation is accepted.
- Holding pre-ready injects in daemon memory does not survive daemon death.
  Acceptable for this issue because the named race is within a live spawn path;
  persistence can be a follow-up if the queue metadata is promoted into
  `FileMailbox`.

## 10. Approval Gate

Do not implement source changes until orchestrator approves this spec.
