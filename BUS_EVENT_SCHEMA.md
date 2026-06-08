# Telepty Bus Event Schema Standard

Version: 2.0 (2026-03-15)
Agreed by: telepty, deliberation, devkit, brain, orchestrator

## Transport

- **HTTP**: `POST /api/bus/publish` with JSON body
- **WebSocket**: `ws://HOST:3848/api/bus` send JSON message
- Both paths trigger bus auto-router for routable events

## Envelope Structure (All Events)

```json
{
  "version": 1,
  "message_id": "string (UUID or prefixed ID)",
  "kind": "string (event type)",
  "source": "string (sender identifier)",
  "source_host": "string (machine_id of sender, e.g. hostname or Tailscale IP)",
  "target": "string | null (target session ID, optional @host suffix)",
  "ts": "ISO 8601 timestamp"
}
```

### Canonical Field Names

| Field | Type | Description |
|-------|------|-------------|
| `version` | number | Envelope schema version (currently 1) |
| `kind` | string | Event type (NOT `type` — `kind` is canonical) |
| `target` | string | Target telepty session ID. May include `@host` suffix for remote |
| `source` | string | Sender identifier (format: `project:session_id`) |
| `source_host` | string | Machine ID of sender (hostname or TELEPTY_MACHINE_ID) |
| `message_id` | string | Unique message identifier |
| `ts` | string | ISO 8601 timestamp |

## Cross-Machine Addressing

### Session Locator
Every session is uniquely identified by a locator triple:
```json
{ "machine_id": "hostname", "session_id": "aigentry-devkit-001", "project_id": "aigentry-devkit" }
```

### Remote Target Format
`target` field supports `@host` suffix: `aigentry-devkit-001@100.100.100.5`
- Router strips suffix, resolves session on local daemon
- For cross-machine relay (P3), daemon forwards to target host

### Machine ID
- Default: `os.hostname()`
- Override: `TELEPTY_MACHINE_ID` env var
- Exposed in: `GET /api/meta` (`machine_id` field), session `locator` object, bus event `source_host`

### Global Session ID Uniqueness (P4)
- Convention: `{project}-{NNN}` (e.g. `aigentry-devkit-001`)
- Cross-machine uniqueness: guaranteed by `locator.machine_id` prefix in bus events
- Collision resolution: `resolveSessionAlias` returns local session only; remote sessions discovered via `source_host` field
- If two machines have `aigentry-devkit-001`, inject uses `target@host` to disambiguate
- Short form `aigentry-devkit-001` resolves to LOCAL session; remote requires explicit `@host`

### Peer Auth
- Localhost: always trusted
- Tailscale (100.x.y.z): trusted by default
- Custom peers: `TELEPTY_PEER_ALLOWLIST=ip1,ip2` env var
- All others: require `x-telepty-token` header

## Routable Events (Auto-Router)

### `turn_request`

Published by deliberation to request a turn from a session. Telepty daemon auto-routes to target session PTY.

```json
{
  "message_id": "turn_request-<uuid>",
  "session_id": "<deliberation_session_id>",
  "project": "<project_name>",
  "kind": "turn_request",
  "source": "deliberation:<deliberation_session_id>",
  "target": "<telepty_session_id>[@<host>]",
  "reply_to": "<deliberation_session_id>",
  "trace": ["project:<name>", "speaker:<id>", "turn:<turn_id>"],
  "payload": {
    "turn_id": "string",
    "round": "number",
    "max_rounds": "number",
    "speaker": "string (target telepty session ID)",
    "role": "string | null",
    "prompt": "string (full prompt text — inject as-is to PTY)",
    "prompt_sha1": "string (40-char SHA1)",
    "history_entries": "number",
    "transport_timeout_ms": "number",
    "semantic_timeout_ms": "number"
  },
  "ts": "ISO 8601"
}
```

**Important Notes:**
- `session_id` is the DELIBERATION session ID, NOT the target telepty session
- `target` is the telepty session ID to inject into
- `payload.prompt` is the full text to write to PTY (no further processing needed)
- `@host` suffix on target: strip before resolving, use for remote routing

**Auto-Router Behavior:**
1. Daemon receives turn_request via HTTP POST or WS
2. Extracts `target` field, strips `@host` suffix
3. Resolves session via `resolveSessionAlias()`
4. Delivers `payload.prompt` to session PTY (kitty primary, WS fallback)
5. Emits `inject_written` ack on bus

### `inject_written` (ACK)

Emitted by telepty after successful auto-route delivery.

```json
{
  "type": "inject_written",
  "inject_id": "UUID",
  "sender": "daemon",
  "target_agent": "<session_id>",
  "source_type": "bus_auto_route",
  "delivered": true,
  "timestamp": "ISO 8601"
}
```

## Session Lifecycle Events

### `session_register`
```json
{ "type": "session_register", "sender": "daemon", "session_id": "string", "command": "string", "cwd": "string", "timestamp": "ISO 8601" }
```

### `session.replaced`
```json
{ "type": "session.replaced", "sender": "daemon", "old_id": "string", "new_id": "string", "alias": "string", "timestamp": "ISO 8601" }
```

### `session.idle`
```json
{ "type": "session.idle", "session_id": "string", "idleSeconds": "number", "lastActivityAt": "ISO 8601", "timestamp": "ISO 8601" }
```

### `session_health` (periodic, every 10s)
```json
{ "type": "session_health", "session_id": "string", "payload": { "alive": true, "pid": "number|null", "type": "string", "clients": "number", "idleSeconds": "number|null" }, "timestamp": "ISO 8601" }
```

## Inject Events

### `inject_written`
```json
{ "type": "inject_written", "inject_id": "UUID", "sender": "daemon", "target_agent": "string", "content": "string", "from": "string|null", "reply_to": "string|null", "thread_id": "string|null", "reply_expected": "boolean", "timestamp": "ISO 8601" }
```

### `message_routed`
```json
{ "type": "message_routed", "message_id": "UUID", "from": "string", "to": "string", "reply_to": "string", "inject_id": "UUID", "deliberation_session_id": "string|null", "thread_id": "string|null", "timestamp": "ISO 8601" }
```

## Broker Relay Events (telepty #42 — cross-machine inject hub)

The broker is an opt-in, default-OFF intranet relay that forwards `inject` across
client-isolated nodes (WFH laptops that cannot reach each other reach the broker
outbound-only). Broker mode is enabled only on the dedicated broker host
(`telepty broker`, spec §5/§6). When unconfigured, none of these events are emitted
and no behavior changes. All broker traffic is TLS; the events below are bus events
emitted by the broker host for observability/audit and follow the canonical envelope
(`kind`, `source`, `source_host`, `ts`).

### `broker_enroll`

Emitted by the broker host on **every** `POST /broker/enroll` attempt (automated
self-enroll, spec §4.6b). Mirrors the `~/.telepty/broker-enroll.log` audit line.
**Enrolled ≠ authorized** — a successful enroll grants only a node identity (JWT);
the node's ACL starts empty (default-deny), so it can inject nobody until an admin
runs `telepty broker allow` (spec §4.6 core safety argument).

```json
{
  "version": 1,
  "message_id": "broker_enroll-<uuid>",
  "kind": "broker_enroll",
  "source": "broker:<broker_host>",
  "source_host": "<broker machine_id>",
  "target": null,
  "ts": "ISO 8601",
  "payload": {
    "node": "string (requested node name)",
    "source_ip": "string (remote IP of the enroll request)",
    "result": "issued | rejected_secret | rejected_duplicate_name | rejected_revoked | rate_limited | cap_exceeded",
    "reason": "string | null (human-readable detail; null on success)"
  }
}
```

**Field notes:**
- `payload.source_ip` is the network source of the enroll request (per-IP rate-limit key, spec §4.6b).
- `result` enumerates the §4.6 outcomes: `issued` (200, JWT minted), `rejected_secret` (401 bad/missing enroll-secret), `rejected_duplicate_name` (409, anti-squat — name taken and no ownership JWT), `rejected_revoked` (sub in `broker-revoked.json`), `rate_limited` / `cap_exceeded` (429, per-IP limit or global `TELEPTY_ENROLL_MAX_NODES`).
- Audited on the broker host only; never carries the enroll-secret or the minted JWT.

### `broker_node_register`

Emitted when a node enrolls its presence / refreshes its session list via
`POST /broker/register` or `POST /broker/heartbeat` (spec §3.1). Lets the fleet
observe broker connectivity and liveness.

```json
{
  "version": 1,
  "message_id": "broker_node_register-<uuid>",
  "kind": "broker_node_register",
  "source": "broker:<broker_host>",
  "source_host": "<broker machine_id>",
  "target": null,
  "ts": "ISO 8601",
  "payload": {
    "node": "string (node name = JWT sub)",
    "sessions": "number (count of sessions the node advertised)",
    "status": "online | heartbeat | offline",
    "last_seen": "ISO 8601"
  }
}
```

### `broker_inject_relay`

Emitted when the broker forwards an inject from one node to another over the held
SSE downstream (spec §3.2). The wire envelope pushed down the stream is:

```json
{
  "type": "inject",
  "message_id": "<uuid>",
  "inject_id": "<uuid>",
  "target": "aigentry-devkit-001@nodeB",
  "to_node": "nodeB",
  "to_session": "aigentry-devkit-001",
  "from_node": "nodeA",
  "source_host": "nodeA",
  "payload": { "prompt": "string", "from": "<sid>", "reply_to": "<sid>", "no_enter": false }
}
```

- `message_id` reuses the peer-relay dedup pattern (at-least-once delivery → target dedups by `message_id`).
- `inject_id` correlates the synchronous ack: target POSTs `/broker/ack` `{ "type":"ack", "inject_id":"…", "success":true, "code":null, "error":null }`, which resolves the originator's held `/broker/inject` response (15s timeout, spec §3.1/§3.3).
- `source_host` follows the existing cross-machine convention (machine_id of the originating node).
- The corresponding bus event mirrors this envelope under `kind: "broker_inject_relay"` with `payload` carrying `{ inject_id, from_node, to_node, to_session, result }` where `result` is `delivered | acked | unreachable | node_backlogged | timeout`.

### Broker Peer Transport (`transport: 'broker'`)

`telepty connect-broker` records a broker peer in `peers.json` for discovery symmetry
with the existing `ssh` / `http` transports (resolved by `getPeerTransport`, default
`ssh`). Broker-discovered sessions are tagged `peerName = host = <node-name>` so the
**unchanged** `pickSessionTarget` / `parseSessionReference` resolve `id@<node>` against
them (spec §2 reuse).

```json
{
  "peers": {
    "nodeB": {
      "transport": "broker",
      "node": "nodeB",
      "url": "https://broker.intranet:8443",
      "machineId": "nodeB",
      "lastConnected": "ISO 8601"
    }
  }
}
```

The node's own broker credentials live separately in `~/.telepty/broker.json` (mode
0600, NOT in `peers.json` — the minted JWT never sits beside peer routing data):

```json
{ "url": "https://broker.intranet:8443", "node": "nodeA", "jwt": "<minted node-JWT>",
  "pin": "sha256:…", "accept_from": null }
```

- `transport: 'broker'` peers carry no `token` (the daemon token NEVER transits the broker — spec §4.3); cross-node inject is authorized by the node-JWT + broker ACL, then delivered in-process on the receiving daemon.
- `pin` is the broker's self-signed TLS cert SHA-256 fingerprint the node pins (spec §4.4 — self-signed + fingerprint-pin is the LOCKED MVP default).
- `accept_from` is the node-side last-line accept allow/deny-list (`null` = accept what the broker authorized, spec §4.2).

## Handoff Events

### `handoff.created` / `handoff.claimed` / `handoff.executing` / `handoff.completed`
```json
{ "type": "handoff.<status>", "handoff_id": "UUID", "source_session_id": "string|null", "deliberation_id": "string|null", "auto_execute": "boolean", "task_count": "number", "timestamp": "ISO 8601" }
```

## Thread Events

### `thread.opened`
```json
{ "type": "thread.opened", "thread_id": "UUID", "topic": "string", "orchestrator_session_id": "string|null", "participant_session_ids": ["string"], "timestamp": "ISO 8601" }
```

### `thread.closed`
```json
{ "type": "thread.closed", "thread_id": "UUID", "topic": "string", "message_count": "number", "timestamp": "ISO 8601" }
```

## Termination Signal Detection

Messages containing these strings suppress auto-reply guide footer:
- `no further reply needed`
- `thread closed` / `closed on X side`
- `ack received` / `ack-only`
- `회신 불필요` / `스레드 종료`

## Inject API Reference

### `POST /api/sessions/:id/inject`

```json
{
  "prompt": "string (REQUIRED — canonical body field)",
  "from": "string (sender session ID)",
  "reply_to": "string (defaults to from if omitted)",
  "thread_id": "string (optional)",
  "reply_expected": "boolean (optional)",
  "no_enter": "boolean (skip Enter after inject)"
}
```

**Note:** The canonical body field is `prompt`, NOT `text`, `content`, or `message`.
