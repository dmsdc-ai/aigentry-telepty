# Mailbox Integration Plan — telepty Side

**Date**: 2026-04-07
**Spec Reference**: `~/projects/aigentry-orchestrator/state/docs/mailbox-crate-spec.md`
**Status**: Analysis complete, awaiting implementation approval

---

## 1. Current Inject Delivery Path — Complete Map

### 1.1 CLI → Daemon Entry Points

```
telepty inject <id> "msg"
  → CLI: cli.js:1820+ (cmd === 'inject')
    → HTTP POST /api/sessions/:id/inject  (daemon.js:1321)

telepty broadcast "msg"
  → CLI: cli.js:1860+ (cmd === 'broadcast')
    → HTTP POST /api/sessions/broadcast/inject  (daemon.js:1037)

telepty multicast --targets a,b "msg"
  → CLI: cli.js:1890+ (cmd === 'multicast')
    → HTTP POST /api/sessions/multicast/inject  (daemon.js:997)

Bus auto-route (deliberation turns, etc.)
  → daemon.js:1590-1617 (WS bus event → deliverInjectionToSession)

Auto-report (idle detection)
  → daemon.js:1957 + daemon.js:2156 (deliverInjectionToSession from sweep/WS)
```

### 1.2 Daemon Delivery Chain

All paths converge to one function chain:

```
POST /api/sessions/:id/inject  (daemon.js:1321)
  → deliverInjectionToSession(id, session, prompt, options)  (daemon.js:554)
    → getInjectFailure(session)  (daemon.js:398)  — pre-flight health check
    → writeDataToSession(id, session, data)  (daemon.js:458)  — actual delivery
    → [if !aterm] setTimeout → writeDataToSession(id, session, '\r')  — deferred CR
```

### 1.3 Three Delivery Backends in writeDataToSession (daemon.js:458)

| Backend | Session Type | Code Location | Mechanism | ACK | Persistent |
|---------|-------------|---------------|-----------|-----|------------|
| **UDS** | `aterm` | daemon.js:460-483 | `net.connect(socket) → JSON payload` | Empty response = success | No |
| **HTTP** | `aterm` (legacy) | daemon.js:487-516 | `fetch(deliveryEndpoint, POST)` | HTTP status code | No |
| **WebSocket** | `wrapped` | daemon.js:538-543 | `ownerWs.send(JSON {type:'inject', data})` | Fire-and-forget | No |
| **PTY direct** | `spawned` | daemon.js:550 | `session.ptyProcess.write(data)` | Fire-and-forget | No |

### 1.4 Allow-Bridge Delivery (wrapped sessions, CLI side)

When daemon delivers to a wrapped session via WS, the allow-bridge in cli.js receives it:

```
daemon WS → ownerWs.send({type:'inject', data})
  → cli.js:1100-1125 (allow-bridge WS message handler)
    → idle check → child.write(chunk) or injectQueue.push(chunk)
    → flushInjectQueue() → child.write(item)  (cli.js:1020-1021)
```

This is the **most fragile path**: fire-and-forget PTY write with in-memory queue (lost on crash).

### 1.5 Terminal-Level Submit (supplementary)

Separate from text delivery, submit (Enter key) uses terminal backends:

| Backend | Code Location | Mechanism |
|---------|--------------|-----------|
| cmux | terminal-backend.js:102-116 | `cmux send-key --surface return` |
| osascript | cli.js:2244 | `osascript -e 'keystroke return'` |
| PTY CR | daemon.js:1147 | `session.ptyProcess.write('\r')` |
| WS CR | daemon.js:1142 | `ownerWs.send({type:'inject', data:'\r'})` |
| aterm | Skipped | aterm handles Enter internally |

---

## 2. Non-aterm Delivery — Raw PTY Write Locations

These are the exact fire-and-forget writes that need mailbox replacement:

| # | File:Line | Code | Context |
|---|-----------|------|---------|
| 1 | daemon.js:550 | `session.ptyProcess.write(data)` | Spawned session text delivery |
| 2 | daemon.js:1147 | `session.ptyProcess.write('\r')` | Spawned session CR submit |
| 3 | daemon.js:542 | `ownerWs.send(JSON {type:'inject', data})` | Wrapped session text delivery |
| 4 | daemon.js:1142 | `ownerWs.send(JSON {type:'inject', data:'\r'})` | Wrapped session CR submit |
| 5 | daemon.js:2172 | `activeSession.ptyProcess.write(data)` | WS client → spawned session input |
| 6 | daemon.js:2164 | `activeSession.ownerWs.send(JSON {type:'inject', data})` | WS client → wrapped session input |
| 7 | cli.js:1021 | `child.write(item)` | Allow-bridge flushInjectQueue |
| 8 | cli.js:1114 | `child.write(chunk)` | Allow-bridge direct CR write |
| 9 | cli.js:1117 | `child.write(chunk)` | Allow-bridge idle text write |
| 10 | cli.js:1170 | `child.write(data.toString())` | Allow-bridge stdin passthrough |

**Locations #1-6** are daemon-side (mailbox enqueue point).
**Locations #7-10** are allow-bridge-side (mailbox dequeue + deliver point).

---

## 3. Aterm Delivery — Socket-Based Path

| # | File:Line | Code | Context |
|---|-----------|------|---------|
| 1 | daemon.js:460-483 | `net.connect(session.delivery.address)` → JSON payload | UDS primary path |
| 2 | daemon.js:487-516 | `fetch(session.deliveryEndpoint, POST)` | HTTP fallback path |

**UDS payload format**: `{ action: "Inject", workspace: id, text: data }`
**Registration**: daemon.js:827-889 (`POST /api/sessions/register`)

---

## 4. Integration Plan — Mailbox Adoption

### 4.1 Architecture Decision: Where Does the Mailbox Live?

The `aigentry-mailbox` crate is Rust. telepty is Node.js. Two integration options:

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| **A: Native Node.js port** | Reimplement FileMailbox in JS | Same process, no IPC overhead | Two implementations to maintain |
| **B: Shared filesystem** | Both Rust and Node read/write ~/.aigentry/mailbox/ JSONL | Single storage format, crate handles aterm | Cross-language file locking, JSONL compat |
| **C: Mailbox CLI wrapper** | Rust binary `aigentry-mailbox-cli enqueue/dequeue/ack` | Single implementation, easy for Node | Process spawn overhead per operation |

**Recommendation: Option B (shared filesystem)**. Rationale:
- JSONL + advisory lock is trivially implementable in Node.js
- The file format IS the API — no RPC needed
- aterm and telepty share the same mailbox storage at `~/.aigentry/mailbox/`
- Both sides can independently enqueue/dequeue without coordination
- Aligns with 헌법 제1조 (lightweight) and 제9조 (independent)

### 4.2 Enqueue Points (Sender Side)

Replace fire-and-forget delivery with mailbox enqueue:

```
CURRENT:
  POST /api/sessions/:id/inject → deliverInjectionToSession → writeDataToSession → PTY write

AFTER:
  POST /api/sessions/:id/inject → mailbox.enqueue(msg) → return EnqueueAck to caller
```

**Specific changes:**

| Function | Current | After |
|----------|---------|-------|
| `deliverInjectionToSession()` daemon.js:554 | Calls `writeDataToSession()` directly | Calls `mailbox.enqueue()`, returns msg_id |
| `writeDataToSession()` daemon.js:458 | 4-way dispatch (UDS/HTTP/WS/PTY) | Becomes delivery engine's concern |
| Bus auto-route daemon.js:1607 | Calls `deliverInjectionToSession()` | Same — enqueue goes through same path |
| Auto-report daemon.js:1957 | Calls `deliverInjectionToSession()` | Same |

### 4.3 Delivery + ACK Points (Receiver Side)

A new **delivery engine** (Node.js setInterval loop) replaces direct writes:

```javascript
// New: daemon.js delivery engine (runs every 100-500ms)
setInterval(async () => {
  for (const [id, session] of Object.entries(sessions)) {
    const msg = mailbox.dequeue(id);
    if (!msg) continue;

    const result = await writeDataToSession(id, session, msg.payload);
    if (result.success) {
      mailbox.ack(id, msg.msg_id);
    } else {
      mailbox.nack(id, msg.msg_id, result.error);
    }
  }
}, DELIVERY_POLL_MS);
```

**writeDataToSession remains** but is called by the delivery engine, not by the inject endpoint.

### 4.4 HTTP API Changes

| Endpoint | Change |
|----------|--------|
| `POST /api/sessions/:id/inject` | Returns `{ success: true, msg_id, queued: true, pending: N }` instead of `{ success: true, strategy: '...' }` |
| `GET /api/sessions/:id/mailbox` | **NEW** — peek at pending messages for a session |
| `POST /api/sessions/:id/mailbox/ack` | **NEW** — external ACK (for aterm HTTP callback) |
| `DELETE /api/sessions/:id/mailbox` | **NEW** — purge mailbox on session destroy |
| `GET /api/sessions` | Add `mailbox: { pending: N, dead_letter: N }` to session serialization |

### 4.5 Storage Location

```
~/.aigentry/mailbox/
  {session_id}/
    inbox.jsonl      # Enqueued messages
    state.jsonl      # State transitions
    dead-letter.jsonl
    .lock
```

Both aterm (Rust) and telepty (Node.js) read/write the same directory. Advisory file locking ensures mutual exclusion.

### 4.6 Allow-Bridge Changes

The allow-bridge (`cli.js` wrapped session handler) currently has its own in-memory `injectQueue`. With mailbox:

```
CURRENT:
  daemon WS inject → allow-bridge injectQueue (in-memory) → child.write()

AFTER:
  daemon enqueues to mailbox → allow-bridge polls mailbox.dequeue() → child.write() → mailbox.ack()
```

The allow-bridge's idle-detection and prompt-ready gating logic STAYS — it moves from "queue text, flush when idle" to "dequeue from mailbox when idle, ack after write."

---

## 5. File Inventory — Modification Scope

| # | File | Lines | Change Scope | Description |
|---|------|-------|-------------|-------------|
| 1 | `daemon.js` | 2281 | **LARGE** | Enqueue in inject endpoints, delivery engine, new HTTP API endpoints, session serialization |
| 2 | `cli.js` | 2903 | **MEDIUM** | Allow-bridge: replace in-memory injectQueue with mailbox dequeue/ack loop |
| 3 | **NEW** `mailbox.js` | ~300 est | **NEW** | Node.js FileMailbox implementation (JSONL read/write, file locking, compaction) |
| 4 | `daemon-control.js` | 223 | **SMALL** | Mailbox cleanup on daemon stop |
| 5 | `test/daemon.test.js` | ~800 | **MEDIUM** | Update inject tests to verify mailbox enqueue/ack, add mailbox-specific tests |
| 6 | `test/mailbox.test.js` | ~200 est | **NEW** | Unit tests for mailbox.js |
| 7 | `package.json` | - | **SMALL** | No new deps needed (fs + JSON only) |
| 8 | `shared-context.js` | 147 | **NONE** | No changes needed |
| 9 | `session-routing.js` | 83 | **NONE** | No changes needed |
| 10 | `terminal-backend.js` | 137 | **NONE** | No changes needed (cmux submit is separate from inject) |
| 11 | `auth.js` | 33 | **NONE** | No changes needed |

**Total new code**: ~300 lines (mailbox.js)
**Total modified code**: ~200 lines in daemon.js + ~100 lines in cli.js
**Total new tests**: ~200 lines

---

## 6. Open Questions — Recommendations

### Q1: Shared mailbox root vs separate roots?

**Recommendation: SHARED** (`~/.aigentry/mailbox/`)

Rationale:
- telepty and aterm are BOTH on the same machine in all current deployment scenarios
- Cross-process file locking via `.lock` files is well-understood and works on macOS/Linux
- Separate roots would require a sync mechanism — more complexity, violates 헌법 제1조
- aterm enqueues messages for other aterm workspaces internally; telepty enqueues for any session type. Same directory serves both.

### Q2: Notification mechanism after enqueue?

**Recommendation: Option (b) — Hybrid mailbox + socket notification**

Rationale:
- Mailbox provides persistence and ACK guarantees
- Socket/WS notification provides 0ms latency (no polling delay)
- Implementation: after `mailbox.enqueue()`, send a lightweight "wake" signal:
  - For aterm: UDS notify `{ action: "MailboxWake", workspace: id }` (no payload, just a poke)
  - For wrapped: WS `{ type: "mailbox_wake" }` to ownerWs
  - For spawned: delivery engine polls (no external notification needed — daemon IS the process)
- Fallback: delivery engine polls every 500ms regardless, so even if notification is lost, delivery happens within 500ms

### Q3: msg_id generation — sender or mailbox?

**Recommendation: Sender-generated** (as spec proposes)

Rationale:
- Enables idempotent retries: CLI can retry `telepty inject` with same msg_id without duplication
- telepty already generates `inject_id = crypto.randomUUID()` in the inject endpoint (daemon.js:1335)
- Rename `inject_id` → `msg_id` and pass it to `mailbox.enqueue()`
- Natural format: `{from}:{uuid}` for traceability

### Q4 (not in spec): Migration ordering — aterm first or telepty first?

**Recommendation: telepty first (Phase 3 before Phase 2)**

Rationale:
- telepty is Node.js — faster iteration, easier to test the JSONL format
- telepty's delivery engine can be built and validated against the file format
- Once the file format is battle-tested, aterm adopts it with confidence
- Lower risk: telepty doesn't need to coordinate with aterm's Rust release cycle

### Q5 (not in spec): Backward compatibility during migration?

**Recommendation: Dual-write during transition**

- Phase A: telepty enqueues to mailbox AND does direct delivery (current behavior). Compare results.
- Phase B: telepty enqueues to mailbox ONLY. Delivery engine handles delivery.
- Phase C: Remove direct delivery code paths.

This ensures zero downtime during migration.

---

## 7. Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| File locking contention between Node.js and Rust | Delivery delays | Advisory lock with 500ms timeout + PID staleness check |
| JSONL format divergence between implementations | Message corruption | Shared test fixtures, integration tests |
| Delivery engine polling latency (500ms) | User-perceived lag | Hybrid notification (Q2 recommendation) |
| Disk I/O overhead for high-volume inject | Performance regression | Compaction at 100 entries, async I/O for reads |
| Allow-bridge crash loses in-flight messages | Message loss | In-flight timeout (30s) → auto-nack → retry |

---

## 8. Implementation Order

1. **mailbox.js** — Node.js FileMailbox implementation (JSONL, file locking, compaction)
2. **test/mailbox.test.js** — Unit tests for mailbox.js
3. **daemon.js: enqueue side** — Replace `deliverInjectionToSession` with mailbox enqueue
4. **daemon.js: delivery engine** — New setInterval loop: dequeue → deliver → ack/nack
5. **daemon.js: HTTP API** — New mailbox endpoints (peek, ack, purge)
6. **cli.js: allow-bridge** — Replace in-memory injectQueue with mailbox dequeue/ack
7. **Integration tests** — End-to-end inject → mailbox → delivery → ack
8. **Dual-write validation** — Run both paths, compare results
9. **Cutover** — Remove direct delivery code paths
