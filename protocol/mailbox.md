# Aigentry Mailbox Protocol — SSOT

**Version**: 1.0-draft  
**Status**: Design  
**Scope**: Transport-agnostic protocol spec (message format, ACK semantics, state machine)  
**Date**: 2026-04-07

This document is the single source of truth for the aigentry mailbox protocol.
Implementation details (storage backend, locking, transport) are in `aigentry-mailbox` crate spec.

---

## 1. Purpose

The mailbox protocol defines guaranteed, ordered, ACK-able message delivery between aigentry sessions (aterm workspaces, telepty sessions, orchestrators). It is transport-agnostic: the same protocol runs over files, Unix sockets, HTTP, or WebSocket.

---

## 2. Message Format

All messages are JSON objects. Field names use snake_case (Rust) / camelCase (TypeScript/Node.js) — both representations are valid; implementations must accept both via alias.

```json
{
  "msg_id":    "orchestrator:1743999600123456789",
  "from":      "aigentry-orchestrator-claude",
  "to":        "aigentry-analyst-claude",
  "payload":   "analyze the auth module",
  "created_at": 1743999600,
  "attempt":   0
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `msg_id` | string | yes | Globally unique message ID. Format: `{from}:{nanoseconds}` or UUID. Used for idempotency and ACK. |
| `from` | string | yes | Sender session ID or alias. |
| `to` | string | yes | Target session ID or alias. |
| `payload` | string | yes | Message body. Arbitrary UTF-8. Typically a CLI command string. |
| `created_at` | uint64 | yes | Unix timestamp (seconds) when message was first created by sender. Immutable across retries. |
| `attempt` | uint32 | yes | Delivery attempt count. 0 = first attempt. Incremented by mailbox on NACK+retry. |

### msg_id Requirements
- MUST be unique per logical message (not per delivery attempt)
- MUST remain the same across retries
- MUST be stable: same logical send operation always produces the same msg_id
- Recommended format: `"{from}:{created_at_nanos}"` — deterministic, no UUID library needed

---

## 3. Message State Machine

```
          ┌─────────────────────────────────────────────┐
          │                  enqueue()                   │
          ▼                                              │
       PENDING ──────── dequeue() ──────► IN_FLIGHT      │  (idempotent: duplicate
          ▲                                   │           │   enqueue → PENDING skip)
          │                         ack() ───┤
          │                                   ▼
          │                               ACKED (terminal)
          │
          │              nack(reason) ────► NACKED
          │                                   │
          │              attempt < max ────────┘──── re-enqueue ──► PENDING
          │              attempt ≥ max ──────────────────────────► DEAD_LETTER (terminal)
          │
          └──── TTL exceeded ───────────────────────────────────► EXPIRED (terminal)
```

### States

| State | Terminal | Description |
|-------|----------|-------------|
| `pending` | no | Awaiting dequeue by receiver |
| `in_flight` | no | Dequeued, receiver processing, awaiting ACK |
| `acked` | yes | Delivery confirmed by receiver |
| `nacked` | no | Delivery failed, scheduled for retry |
| `dead_letter` | yes | Exhausted retry count |
| `expired` | yes | TTL exceeded before delivery |

### State Transition Rules
1. Only `pending` → `in_flight` (via `dequeue`)
2. Only `in_flight` → `acked` or `nacked` (via `ack`/`nack`)
3. `nacked` with `attempt < max_retries` → new `pending` entry (same msg_id, attempt+1)
4. `nacked` with `attempt >= max_retries` → `dead_letter`
5. `pending` or `in_flight` past TTL → `expired` (by DeliveryEngine sweep)
6. Terminal states are immutable

---

## 4. ACK Semantics

### enqueue → EnqueueAck
```
enqueue(msg) → { msg_id, queued: bool, pending: usize }
```
- `queued: true` — message newly added
- `queued: false` — msg_id already seen (idempotent, no-op). Safe to call multiple times.

### dequeue
```
dequeue(session_id) → Option<Message>
```
- Returns oldest `pending` message
- Transitions it to `in_flight`
- Returns `None` if no pending messages

### ack
```
ack(session_id, msg_id) → Result<()>
```
- Transitions `in_flight` → `acked`
- MUST be called after successful delivery to PTY or host

### nack
```
nack(session_id, msg_id, reason: string) → Result<()>
```
- Transitions `in_flight` → `nacked`
- Mailbox schedules retry with backoff: `retry_delay = base_backoff_secs × 2^attempt`
- After `max_retries` NACKs: transitions to `dead_letter`

---

## 5. Retry Policy

| Parameter | Default | Description |
|-----------|---------|-------------|
| `max_retries` | 3 | NACK count before dead-lettering |
| `base_backoff_secs` | 5 | First retry delay (seconds) |
| Backoff strategy | Exponential | `delay = base × 2^attempt`: 5s, 10s, 20s |
| `inflight_timeout_secs` | 30 | Auto-nack if ACK not received within this window |

---

## 6. Dead Letter Queue

Messages in `dead_letter` state are preserved indefinitely (no TTL). Dead letter entries contain:

```json
{
  "msg_id": "orchestrator:...",
  "from": "...",
  "to": "...",
  "payload": "...",
  "reason": "max_retries exhausted",
  "failed_at": 1744086000,
  "attempts": 3
}
```

Dead letter queue is inspectable (`peek_dead_letter(session_id)`) and purgeable (`purge_dead_letter(session_id)`).

---

## 7. Ordering Guarantee

- Messages are delivered FIFO per `(from, to)` pair
- Messages from different senders to the same receiver are interleaved by `created_at`
- No total ordering across all receivers

---

## 8. Idempotency

- `enqueue` with duplicate `msg_id` is a no-op (returns `queued: false`)
- `ack` with already-acked `msg_id` is a no-op (returns `Ok(())`)
- `nack` with already-dead-lettered `msg_id` is a no-op
- Implementations MUST enforce idempotency at the storage layer, not the caller

---

## 9. Protocol Versioning

Messages MAY include `"protocol_version": "1.0"` field. Receivers MUST ignore unknown fields (forward compatibility). Senders SHOULD include version for diagnostics.

---

## 10. TypeScript Interface (Node.js / telepty)

```typescript
// message.ts

export interface Message {
  msg_id: string;       // or msgId (both accepted)
  from: string;
  to: string;
  payload: string;
  created_at: number;   // or createdAt (Unix seconds)
  attempt: number;
}

export interface MessageSummary {
  msg_id: string;
  from: string;
  created_at: number;
  attempt: number;
  state: MessageState;
}

export type MessageState =
  | 'pending'
  | 'in_flight'
  | 'acked'
  | 'nacked'
  | 'dead_letter'
  | 'expired';

export interface EnqueueAck {
  msg_id: string;
  queued: boolean;
  pending: number;
}

export interface DeadLetterEntry extends Message {
  reason: string;
  failed_at: number;    // Unix seconds
  attempts: number;
}
```

```typescript
// mailbox.ts — transport-agnostic interface

export interface MailboxProtocol {
  enqueue(msg: Message): Promise<EnqueueAck>;
  dequeue(sessionId: string): Promise<Message | null>;
  ack(sessionId: string, msgId: string): Promise<void>;
  nack(sessionId: string, msgId: string, reason: string): Promise<void>;
  peek(sessionId: string): Promise<MessageSummary[]>;
  purge(sessionId: string): Promise<void>;
  peekDeadLetter(sessionId: string): Promise<DeadLetterEntry[]>;
  purgeDeadLetter(sessionId: string): Promise<void>;
}
```

---

## 11. Changelog

| Version | Date | Change |
|---------|------|--------|
| 1.0-draft | 2026-04-07 | Initial protocol definition |
