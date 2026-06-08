# Spec — telepty #42 broker MVP: cross-machine relay (hub) for `inject` under client-isolation

- **Date:** 2026-06-08
- **Status:** SPEC FIRST — awaiting user approval (no impl until approved; orchestrator surfaces this spec to the USER)
- **Author role:** architect (`telepty-42-architect`)
- **Branch:** `wt/telepty-42-broker-adr` (commit ONLY this spec; NO push — orchestrator lands)
- **ADR (source of truth):** `docs/adr/2026-06-08-cross-machine-relay-broker.md` (commit 7d6945a) — user-APPROVED reduced MVP
- **Tasks:** #564 / #42. **Cross-refs:** #13 (`connect-http`), #41 (service install), `BUS_EVENT_SCHEMA.md`
- **§1.2 self-application:** satisfied by the ADR. This spec inherits the verdict — *inject-only single-fleet MVP keeps Art.1 passing*. Any drift toward a multi-tenant message bus is the 위헌 line (flagged §11).

---

## 1. Scope & non-goals

### LOCKED scope (user-approved — design to these exactly)
1. **Reduced MVP (Phase 0):** single broker, single fleet, **inject-only**, **opt-in / default-OFF** (zero behavior change for existing P2P/SSH/connect-http users), **TLS day 1**, reuse existing routing + dedup.
2. **Broker host = dedicated always-on intranet server** (spike-class `172.28.2.31`), running `telepty` in **broker mode**. WFH nodes reach it **outbound only**; they never reach each other. NOT the orchestrator host.
3. **Per-node authz IS IN the MVP** (fully mitigate T2): per-node identity via the existing JWT path, broker authenticates+authorizes per node, **receiving daemon enforces local authz as the last line**. TLS mandatory. Node self-owns its auth — the **local daemon token NEVER transits the broker**.

### Out of scope (deferred — with phase)
| Deferred item | Phase | Why out of MVP |
|---|---|---|
| `broadcast` / `reply` fan-out & reply-threads | Phase 1 | MVP confirms the topology with the single most-used verb (`inject`). |
| Live session-list push-on-change | Phase 1 | MVP uses register + heartbeat poll-aggregate (good enough for discovery). |
| Multi-tenant broker (>1 fleet) | Phase 3 | The Art.1/§17 위헌 line — single fleet sidesteps the whole tenancy threat class (T5). |
| End-to-end payload encryption (broker can't read) | Phase 3 | TLS + self-hosted-broker trust-bounding is the MVP mitigation for T1. |
| WebSocket transport | later | SSE chosen (ADR §2.1) — it *is* the EDR-proven chunked stream; WS `Upgrade` unproven. |
| Interactive `attach`/`screen` through broker | later | High-bandwidth interactive streaming — defer; MVP is request/reply inject only. |
| Broker HA / clustering (remove SPOF) | Phase 2 | MVP accepts SPOF; graceful degradation covers it (T6). |
| Per-**session** authz granularity | Phase 2 | MVP authorizes at **node** granularity (closes T2 fleet-wide escalation; finer-grained later). |

---

## 2. Component / file map

Reuse is named explicitly; **net-new** is isolated to two transport modules so the surgical boundary (Rule 29) is clean.

| # | File | New / Change | Owns |
|---|---|---|---|
| A | `src/transport/broker-protocol.js` | **NEW** (pure, no I/O) | Envelope build/parse, `message_id` dedup helper, Last-Event-ID seq, ack shape. Unit-testable. |
| B | `src/transport/broker-server.js` | **NEW** | Broker-side: register/stream(SSE)/inject/heartbeat/ack endpoints, routing table `{node→channel}`, bounded per-node queue, ACL authz. Mounted only in broker mode. |
| C | `src/transport/broker-client.js` | **NEW** | Node-side, **daemon-held**: outbound SSE downstream + HTTPS POST upstream, reconnect, heartbeat, on-inject → **in-process** `deliverInjectionToSession`, ack up. |
| D | `cross-machine.js` | **Change** (additive) | `connectBroker(url, opts)` (writes broker config, mirrors `connectHttp` line 358), `listBrokerRemoteSessions(opts)` (mirrors `listHttpRemoteSessions` line 435), `peers.json` `transport:'broker'` entry. Reuse `getPeerTransport` (line 13). |
| E | `cli.js` | **Change** (additive) | New commands `connect-broker`, `broker`, `broker enroll` — each an additive `if (cmd === …)` block mirroring `connect-http` (line 3209) and `daemon` (line 884). Integrate broker discovery into the `list` path (line 514, beside `discoverHttpRemoteSessions`). |
| F | `daemon.js` | **Change** (additive) | (i) Broker-mode branch: mount broker-server when `TELEPTY_BROKER_MODE`. (ii) Node-mode: start broker-client when broker config present. (iii) Config block additions near line 139. Reuse `createVerifyJwt` (line 161), `deliverInjectionToSession` (line 1308), the `relayToPeers` dedup pattern (`createPeerRelay`, line 150). |
| G | `src/protocol/http-auth.js` | **Reuse + tiny add** | Reuse `createVerifyJwt` for per-node JWT verification. Add `createBrokerAcl(aclTable)` pure authz helper (default-deny). |
| H | `install.js` | **Change** (additive) | Broker-host service variant: launchd/systemd `ExecStart … broker` (vs `daemon`). #41 cross-ref. |
| I | `BUS_EVENT_SCHEMA.md` | **Change** (doc) | Document broker event types + the `transport:'broker'` peer shape. |

**Reused UNCHANGED (name the exact functions):**
- `session-routing.js` → **`pickSessionTarget`** + **`parseSessionReference`** (lines 34, 7). `id@<node>` already matches on `session.peerName` (line 44–47). **No change** — broker-discovered sessions are tagged `peerName = host = <node-name>`.
- `src/transport/peer-relay.js` → the **`message_id` dedup pattern** (`relaySeen` bounded set, lines 24–32) and **`source_host` stamping** (lines 34–35). Broker-protocol reuses this dedup verbatim (extract the bounded-set helper if cleaner).
- `daemon.js` → **`deliverInjectionToSession`** (line 1308) — the broker-client calls it **in-process** (this is what keeps the local daemon token off the wire, §4).
- `src/protocol/http-auth.js` → **`createVerifyJwt`** (HS256, no external dep — §17).

---

## 3. Wire protocol

All broker traffic is **TLS (HTTPS/`wss`-free — SSE over HTTPS)**. Node→broker auth = `Authorization: Bearer <node-JWT>` on every request (reuses `createVerifyJwt`). Base path `/broker/*` (kept off `/api/*` so the existing auth middleware and routes are untouched; broker-server has its own JWT gate).

### 3.1 Endpoints (broker-side, module B)

| Method · Path | Auth | Purpose |
|---|---|---|
| `POST /broker/register` | node-JWT | Node enrolls its presence + pushes session list. Returns `{ ok, node, since }`. Broker records `{node → {sub, sessions, lastSeen}}`. |
| `GET /broker/stream` | node-JWT + `Last-Event-ID` | The **held SSE downstream**. Broker pushes `inject` events down it. `text/event-stream`, heartbeat comments. |
| `POST /broker/inject` | node-JWT | Originating node asks broker to forward an inject to `id@<targetNode>`. Broker **authorizes** (ACL), enqueues to target's channel, **holds the response** until the target acks (or timeout). Returns the delivery result (synchronous parity with direct inject). |
| `POST /broker/ack` | node-JWT | Target node acks a delivered inject `{ inject_id, success, code, error }`. Broker correlates → resolves the held `/broker/inject` response. |
| `POST /broker/heartbeat` | node-JWT | Keepalive + liveness + (optional) session-list refresh. |
| `GET /broker/sessions` | node-JWT | Aggregate session list across connected nodes (for `telepty list` discovery), each tagged `peerName=host=<node>`. |

### 3.2 Inject envelope (extends the existing inject body)

The existing inject POST body is `{ prompt, from, reply_to, no_enter, thread_id, reply_expected }` (daemon.js:2516). The broker wraps it:

```json
{
  "type": "inject",
  "message_id": "<uuid>",          // dedup key — reuses peer-relay relaySeen pattern
  "inject_id": "<uuid>",           // ack correlation
  "target": "aigentry-devkit-001@nodeB",
  "to_node": "nodeB",              // resolved node name (locator.machine_id)
  "to_session": "aigentry-devkit-001",
  "from_node": "nodeA",
  "source_host": "nodeA",          // reuses BUS_EVENT_SCHEMA source_host
  "payload": { "prompt": "…", "from": "<sid>", "reply_to": "<sid>", "no_enter": false }
}
```

- SSE frame down the stream: `id: <seq>\nevent: inject\ndata: <envelope-json>\n\n`.
- Ack frame (upstream POST `/broker/ack`): `{ "type":"ack", "inject_id":"…", "success":true, "code":null, "error":null }`.
- **Addressing:** the originating CLI resolves `id@<node>` via the **unchanged** `parseSessionReference`/`pickSessionTarget`; for a `transport:'broker'` peer the target node is `parsed.host` (matches `session.peerName`). `to_node`/`to_session` are filled from that.

### 3.3 Reconnect / keepalive / backpressure

- **Keepalive:** broker emits an SSE comment `: ping\n\n` every ~20–25s (the spike held 90s; periodic bytes extend indefinitely). Node POSTs `/broker/heartbeat` on the same cadence so the broker marks dead nodes fast and fails `inject id@deadNode` with a clear error.
- **Reconnect:** node broker-client uses exponential backoff + jitter; on reconnect sends `Last-Event-ID`. Broker holds a **bounded per-node replay buffer** (TTL + max depth) and redelivers unacked events after the given id. **At-least-once** → target dedups by `message_id` (reused pattern). 
- **Backpressure:** bounded per-node queue; on overflow → drop-oldest + the held `/broker/inject` resolves with `node_backlogged` error. Because inject is request/reply, the originator always gets `ack | unreachable | backlogged | timeout` — never silent loss.

---

## 4. Security design (per-node authz — MVP, REQUIRED)

Defense-in-depth, mapped to ADR threats. **The broker is a semi-trusted router, not a trusted endpoint.**

### 4.1 Per-node identity (T2, T3)
- Each node holds a **per-node JWT** (HS256), `sub = <node-name>`, claims `{ sub, fleet, iat, exp }`, signed with the **broker's** `TELEPTY_JWT_SECRET`. Verified by the reused **`createVerifyJwt`** on every `/broker/*` request.
- **Identity ≠ authz** (decoupled for least-privilege & rotation): the JWT only *proves who the node is*. Authorization lives in a **broker-side ACL table** (`~/.telepty/broker-acl.json` on the broker host):
  ```json
  { "nodeA": ["nodeB", "nodeC"], "nodeB": ["nodeA"] }
  ```
  `createBrokerAcl(table)` (new pure helper in `http-auth.js`) returns `canInject(fromNode, toNode) → bool`, **default-deny** (a node absent from the table, or a target not in its list, cannot inject). This **fully closes T2**: a stolen `nodeA` token reaches only `nodeA`'s permitted targets, never the whole fleet. (Node granularity; per-session is Phase 2.)

### 4.2 Receiving-daemon last line (T2 defense-in-depth)
- The broker-client, on an `inject` SSE event, delivers **in-process** via `deliverInjectionToSession` — but FIRST applies a node-side accept check: an optional `accept_from` deny/allow-list in `~/.telepty/broker.json` (default: accept what the broker authorized). This is the **last line** — even a misbehaving/compromised broker cannot push an inject the receiving node hasn't agreed to accept. The existing **`classifyPeerLaneInject`** peer-guard (daemon.js:2510 route) still applies to any inject that re-enters via HTTP; the broker path bypasses HTTP entirely (in-process), so it is gated solely by `accept_from` + the broker ACL.

### 4.3 Credential boundary (REQUIRED invariant)
- The node's **local daemon token** (`EXPECTED_TOKEN`) **NEVER** leaves the node. Cross-node inject executes **in-process on the receiving daemon** (broker-client → `deliverInjectionToSession` directly), so **no local token is needed on the wire**. The broker only ever sees the **node-JWT** (channel identity) — never a daemon token.
- ⇒ Broker compromise yields, at worst: traffic visibility (mitigated by 4.4 TLS) + the ability to *attempt* injects the receiving node still independently accepts (4.2). It does **not** hand an attacker any node's daemon credentials.

### 4.4 Transport encryption (T1, broker-impersonation)
- **TLS mandatory day 1.** Broker URL is `https://`. Broker host loads `TELEPTY_TLS_CERT` / `TELEPTY_TLS_KEY`. Node **validates the broker cert** (CA-trust, or pinned fingerprint in `broker.json` for self-signed) to stop a DNS/route attacker impersonating the broker the nodes trust as router.
- **MVP default (no external CA — §17):** self-signed cert on the broker host + **fingerprint pin** in each node's `broker.json`. Internal-CA is supported (set node trust store) but not required.

### 4.5 Replay / DoS (T3, T6)
- **Replay:** `message_id` dedup (reused) on the receiving node; nonce+timestamp on the register handshake; JWT `exp` bounds token lifetime.
- **DoS / SPOF:** per-node rate-limit on `/broker/inject`; bounded queues (3.3). **Graceful degradation:** broker down → broker-client retries; cross-machine inject fails with a clear error; **local inject is unaffected**; and because broker mode is **default-OFF**, existing P2P users are entirely unaffected (제9조 — system works without the broker component).

### 4.6 Threat → control map
| Threat (ADR §3) | MVP control |
|---|---|
| **T1** broker-as-MITM / confidentiality | TLS mandatory (4.4) + first-party self-hosted broker on the dedicated host (operator == fleet owner). |
| **T2** flat-token → fleet-wide inject escalation | Per-node JWT identity (4.1) + broker default-deny ACL (4.1) + receiving-daemon `accept_from` last line (4.2). |
| **T3** node spoof / name-squat / replay | JWT `sub` binds identity (4.1) + `message_id` dedup + nonce/`exp` (4.5). |
| **T6** SPOF / DoS / amplification | Rate-limit + bounded queue (4.5) + graceful degradation, default-OFF (4.5). |

---

## 5. Config & opt-in (default-OFF; backward-compat)

### Node side
- Enroll once: `telepty connect-broker https://broker.intranet:8443 --node <name> --jwt <path|inline> [--pin <sha256>]` → writes `~/.telepty/broker.json` (mode 0600):
  ```json
  { "url": "https://broker.intranet:8443", "node": "nodeA", "jwt_path": "~/.telepty/broker.jwt",
    "pin": "sha256:…", "accept_from": null }
  ```
  Also records a `transport:'broker'` entry in `peers.json` for discovery symmetry.
- Daemon reads `broker.json` (or env `TELEPTY_BROKER_URL` + `TELEPTY_BROKER_JWT`) **on start/reload**; if absent → **broker-client not started** (default-OFF, zero new behavior).

### Broker host side
- `telepty broker` (mirrors the `daemon` command, line 884: sets `TELEPTY_BROKER_MODE=1` + `AIGENTRY_TELEPTY_DAEMON_MAIN=1`, then `require('./daemon.js')`).
- Env: `TELEPTY_JWT_SECRET` (required — mints/verifies node JWTs), `TELEPTY_TLS_CERT`/`TELEPTY_TLS_KEY` (required), `TELEPTY_BROKER_ACL` (path, default `~/.telepty/broker-acl.json`), `PORT` (e.g. 8443).
- Mint a node identity: `telepty broker enroll <node> --allow nodeB,nodeC [--ttl 30d]` → signs a JWT with `TELEPTY_JWT_SECRET`, **prints it once** (copied to the node out-of-band, like an SSH key), and adds `<node>: [nodeB,nodeC]` to the ACL. Rotation = re-enroll (new `exp`); revoke = remove from ACL (effective immediately, no re-mint needed since authz is broker-side).

### Backward-compat (REQUIRED)
- No broker config ⇒ **no code path changes**: `connect`/`connectHttp`/`remoteInject`/`discoverAllRemoteSessions` are untouched; the broker-client/server are inert. The `list`/`inject` flows add broker discovery **only when** a `transport:'broker'` peer exists.

---

## 6. Deployment (dedicated intranet broker host — locked decision 2)

- The always-on intranet server runs **`telepty broker`** under a service (launchd/systemd) — extend `install.js` (#41) with a broker variant whose `ExecStart`/`ProgramArguments` is `telepty broker` instead of `telepty daemon` (the post-fix #41 service-install path applies to the broker daemon too). Selected via `telepty install --broker` or env.
- **Firewall / outbound assumptions:** the broker listens on its TLS port (e.g. 8443) reachable from the intranet; **WFH nodes need outbound-only** reachability to that host (the exact shape the spike verified: laptop → `172.28.2.31` works, laptop↔laptop blocked). No inbound to nodes required — the whole point.
- **Provision TLS** on the broker host (self-signed + node pin for MVP; internal CA optional). Set `TELEPTY_JWT_SECRET` (kept ONLY on the broker host). Enroll each node (§5).

---

## 7. Test plan

### Host-runnable (CI / single dev host)
- **Unit (module A, G):** envelope build/parse round-trip; `message_id` dedup (duplicate dropped); Last-Event-ID seq/replay-buffer logic; `createVerifyJwt` valid / expired (`exp`) / wrong-signature; `createBrokerAcl` allow / default-deny / target-not-listed.
- **Unit (routing):** `pickSessionTarget` resolves `id@nodeB` against a broker-tagged session (`peerName='nodeB'`) — **proves the unchanged reuse**.
- **Integration (loopback, no real network):** spin one broker daemon + two node daemons on distinct localhost ports; nodes connect **only** to the broker (no SSH/http peer between them). Assert `inject A→broker→B` delivers to B's session and A receives the ack; assert reconnect after dropping/reopening B's SSE channel redelivers buffered injects (dedup → single delivery). TLS via self-signed cert + pin.
- **Security (host-runnable):** (a) node with bad/expired JWT → `/broker/register` & `/broker/stream` return **401**; (b) node injecting into a target **not in its ACL** → **403** (cross-node escalation blocked = T2); (c) plain `http://` rejected when TLS configured (T1/T4); (d) duplicate `message_id` deduped (T3); (e) **credential-boundary assertion**: capture broker-client outbound requests and assert they carry **only** the node-JWT, **never** `EXPECTED_TOKEN` (the daemon token) — locks the §4.3 invariant.
- **Regression:** full `npm test` → no new reds; `node --check` on changed files; Snyk on changed `.js` → 0 new findings.

### Need-real-topology (NOT host-runnable — FLAG, do not block CI)
- **EDR survival of the SSE-framed channel** through the real corp VPN/EDR (the ADR §8 GA condition — the 90s spike was raw-chunked; confirm `text/event-stream` framing survives end-to-end).
- **True client-isolation E2E:** two real WFH laptops + the intranet broker, neither laptop reaching the other, `inject A→B` succeeds.

---

## 8. Phasing / task breakdown (dispatch plan)

Coder-sized tasks. **T1 is the sequential gate** (shapes); then parallel where files are disjoint.

| Task | Scope | Files | Depends | Parallel? |
|---|---|---|---|---|
| **T1** | Broker wire-protocol + envelope + dedup helper (pure) | A | — | gate (do first) |
| **T2** | Broker-server: endpoints, routing table, per-node queue | B | T1 | ∥ with T3,T4,T6 |
| **T3** | Node broker-client: SSE hold, reconnect, in-process deliver, ack | C | T1 | ∥ with T2,T4,T6 |
| **T4** | CLI `connect-broker`/`broker`/`broker enroll` + `cross-machine.js` `connectBroker`/`listBrokerRemoteSessions` + peers.json | D, E | T1 | ∥ with T2,T3,T6 |
| **T6** | Auth: JWT enroll/mint, `createBrokerAcl`, ACL loader, reuse `createVerifyJwt` | G | T1 | ∥ with T2,T3,T4 |
| **T5** | `daemon.js` wiring (mount server in broker mode / start client in node mode) + config block | F | T2, T3, T6 | join |
| **T7** | Discovery: integrate `listBrokerRemoteSessions` into `list` path | E | T2, T3 | after T5 |
| **T8** | `install.js` broker-host service variant (#41) + deployment docs | H | T5 | ∥ with T7,T9,T10 |
| **T9** | Tests: unit (per module, TDD) + integration + security | tests | per module | rolling; integration after T5 |
| **T10** | `BUS_EVENT_SCHEMA.md` + config/deploy docs | I | T1 | ∥ throughout (doc) |

**Critical path:** T1 → {T2 ∥ T3 ∥ T6} → T5 → T7 → T9(integration). T4/T8/T10 ride alongside.

---

## 9. Rule 29 surgical boundary

- **NEW files** (isolated): `src/transport/broker-protocol.js`, `broker-server.js`, `broker-client.js`.
- **Additive only** in `cli.js` (new `if (cmd===…)` blocks), `cross-machine.js` (new exports + `transport:'broker'` branch), `daemon.js` (broker-mode/node-mode branches + config consts), `http-auth.js` (`createBrokerAcl`), `install.js` (broker variant), `BUS_EVENT_SCHEMA.md` (doc rows).
- **Explicitly NOT touched:** `session-routing.js` (reused unchanged); existing `connect`/`connectHttp`/`remoteInject`/`discover*`; the `POST /api/sessions/:id/inject` route and `deliverInjectionToSession` *signature*; existing peer auth defaults; any adjacent reformatting.

---

## 10. Self-review — Art.1 경량 (no scope drift)

- **Inject-only:** no broadcast/reply/attach/multi-tenant in any file above. ✓
- **Single fleet:** one ACL table, one JWT secret, one broker — no tenancy namespace. ✓
- **Reuse over rebuild:** routing (`pickSessionTarget`), dedup (peer-relay pattern), JWT (`createVerifyJwt`), delivery (`deliverInjectionToSession`) all reused — net-new is two transport modules + thin wiring. ✓
- **No external dependency (§17):** SSE on Node core `http`, HS256 JWT in-house, self-signed-cert+pin — **no message-broker lib, no external relay/IdP/CA**. ✓
- **Default-OFF (§2):** zero behavior change when unconfigured. ✓
- **Drift watch:** if T2 (broker-server) starts growing topic routing / fan-out subscriptions / tenant partitions → that is the message-bus 위헌 line; STOP and re-scope.

---

## 11. Open risks / decisions still needed

These are flagged for the USER/orchestrator (HOLD candidates — not guessed past):

1. **TLS PKI choice (proposed default, confirm):** MVP defaults to **self-signed cert on the broker + fingerprint pin in each node's `broker.json`** (keeps §17 — no external CA). If the fleet has an internal CA it should be used instead. *Need:* confirm self-signed+pin is acceptable for MVP, or specify the internal CA.
2. **JWT secret distribution:** `TELEPTY_JWT_SECRET` lives only on the broker host; `enroll` prints the node JWT once for out-of-band copy (SSH-key-style). *Need:* confirm this manual enroll is acceptable for MVP (vs an automated enrollment endpoint — which is more surface, deferred).
3. **Ack timeout / UX:** `/broker/inject` holds synchronously for the target ack to preserve direct-inject UX parity. Proposed default timeout 15s (matches existing SSH `remoteInject` timeout). *Need:* confirm synchronous-with-timeout is desired (vs 202-accepted fire-and-forget, which regresses delivery confirmation).
4. **(Not an open question — stated):** authz is **node-granularity** in MVP (per-session is Phase 2). This is exactly the approved "per-node identity" (locked decision 3) and fully closes T2 fleet-wide escalation.

If any of #1–#3 needs a call beyond the constitution, HOLD-inject to `orchestrator` before a coder is dispatched.
