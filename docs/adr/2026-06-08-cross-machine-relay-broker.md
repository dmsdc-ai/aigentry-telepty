# ADR 2026-06-08 — Cross-machine relay / broker (hub) mode for `inject`/`broadcast` under client-isolation

- **Status:** Accepted — IMPLEMENTED (shipped 0.6.0 dark-launch: **opt-in, default-OFF, not GA**; broker #42 commits `e59112e`/`b195e6e`/`60e3695`/`331e748`/`835e7b2`/`dc0612c`/`1b5fa12`, release `3255c41`; broker/blocked audit seams shipped 0.6.1, commit `0e587f1`)
- **Date:** 2026-06-08 (status header corrected 2026-06-10 — task #588)
- **Repo:** `aigentry-telepty` (branch `wt/telepty-42-broker-adr`, off `main`@`8f3bf17`)
- **Tasks:** #564 / #42 (telepty cross-machine relay/broker)
- **Author role:** architect (`telepty-42-architect`)
- **Relates:** #13 (`connect-http` — transport, not topology), ADR 2026-05-30 (tech stack — stay Node, §17/§1), `BUS_EVENT_SCHEMA.md` (locator triple, `@host` routing, peer auth)

> **2026-06-10 correction (task #588, per `docs/reports/2026-06-10-structure-audit.md` RISK 3):**
> This ADR's original header ("Proposed — NO implementation in this dispatch") was true for the
> spec-only authoring dispatch but went stale after the broker MVP was implemented and shipped:
> `src/transport/broker-protocol.js` / `broker-server.js` / `broker-client.js`, CLI wiring
> (`connect-broker`, broker admin commands, ACL), daemon broker-mode mount, install service variant,
> and an end-to-end + security test suite — landed 2026-06-09 in release 0.6.0 (`3255c41`,
> "broker (#42) dark-launch (opt-in, default-OFF, not GA)"), with broker/blocked audit seams in
> 0.6.1 (`0e587f1`). The feature is **shipped but default-OFF / opt-in** — the Phase 0 MVP scope of
> §7. "No implementation in this dispatch" statements in the body below refer to the original
> spec dispatch, not to the current tree.

## 1. Context — problem & topology

Telepty's cross-machine `inject`/`broadcast`/`reply` is **strictly peer-to-peer (P2P)**: the
initiating node must open a connection **directly to the target node's daemon**. This is true on
every existing transport, confirmed in source:

- **SSH peers** (`cross-machine.js` `connect`/`remoteInject`): `connect(target)` opens an SSH
  ControlMaster *to the target* (lines 103–179); `remoteInject` runs `telepty inject` over that
  socket (lines 244–263). Direction: **caller → target's sshd/daemon**.
- **HTTP peers** (`#13 connect-http`): `connectHttp(target)` health-checks `GET
  http://<target>/api/health` and records the target in `peers.json` (lines 358–419);
  `listHttpRemoteSessions` polls `GET http://<target>/api/sessions` (lines 435–462); inject POSTs go
  to `…/api/sessions/:id/inject` on the **same target daemon** (`cli.js:828,1863,2029`). Direction:
  **caller → target's daemon**.
- **Bus relay** (`src/transport/peer-relay.js`): even the existing fan-out relay POSTs each event to
  `http://<peer>:<port>/api/bus/publish` (lines 38–45) — i.e. it is a **mesh push that still
  requires the initiator to reach each peer daemon directly**. It is *not* a hub.
- **No central routing exists today**: `getConnectedHosts()` returns `[]` and `getPeerHost()`
  returns `null` ("No HTTP host - use SSH direct", `cross-machine.js:336–342`). Every cross-machine
  call resolves to the target daemon and hits it directly.

So to inject into B's session, **A must reach B's daemon**. This fails wherever two nodes can each
reach a *central server* but **not each other**:

- **Corporate VPN client-isolation** (hub-and-spoke): laptops reach intranet servers, not peers.
- **NAT**: no inbound path to a WFH laptop.
- **EDR-restricted fleets**: peer-to-peer / mesh transports blocked at the process or network level.

The common WFH↔WFH-through-corp-VPN case is therefore broken. **`#13 connect-http` ("no SSH
required") changed the *transport* (SSH → HTTP) but not the *topology*** — it is still A → B's laptop
daemon, which client-isolation blocks.

### Feasibility evidence (spike, 2026-06-08)

1. **Client-isolation is real here**: a WFH laptop reached intranet server `172.28.2.31` fine;
   **laptop-to-laptop was blocked**.
2. **The reverse channel a broker needs already survives EDR**: a plain `node.exe` HTTP client held a
   **90-second long-lived streaming connection** (30 chunks, no cuts) to the intranet server. ⇒ A
   telepty daemon **can hold an outbound persistent channel to a central server** to receive pushes.
3. **Mesh VPN is not an option**: `tailscaled.exe` was **blocked by the same EDR at the process
   level**. ⇒ An **HTTP-family relay is the viable path**, not a mesh overlay. (Note: telepty's
   *current* cross-machine substrate is exactly Tailscale — `peers.json` targets are `*.ts.net` — so
   the thing that fails is today's default.)

## 2. Decision — broker (hub) mode

Add a **first-party broker mode to the telepty daemon** (`telepty broker`). Each node opens an
**outbound persistent reverse channel** to a central broker that both nodes can reach; the broker
maintains a routing table `{node → held-channel}`, aggregates connected nodes' session lists, and
forwards `inject`/`broadcast`/`reply` by node name.

```
A (WFH) ──outbound persistent (SSE down + HTTPS POST up)──┐
                                                          ▼
                              telepty broker (central daemon)   ← both nodes reach only THIS
                                                          ▲
B (WFH) ──outbound persistent (SSE down + HTTPS POST up)──┘

inject id@B :  A ──POST──▶ broker ──(push down B's held SSE channel)──▶ B's daemon ──local inject──▶ session
```

Neither node ever connects to the other. This **inverts** the existing `peer-relay` model (which
*pushes from* the initiator *to* each peer — requiring direct reachability) into a **pull-then-push**
model (each node *holds open* a channel so the broker pushes down an already-established connection).

### 2.1 Transport choice — **SSE downstream + HTTPS POST upstream** (not WebSocket, not raw chunked)

The three HTTP-family candidates are **not interchangeable**, and the spike only verified one of them
through the EDR:

| Candidate | EDR/proxy fit | Duplex | Dependency | Verdict |
|---|---|---|---|---|
| **Raw chunked HTTP** | **Proven** (the 90s/30-chunk spike was exactly this) | down-only | none | basis, but unframed |
| **SSE (`text/event-stream`)** | **Same wire shape as the proven chunked stream** + standard framing & `Last-Event-ID` reconnect | down-only | none (Node core `http`) | **chosen (downstream)** |
| **WebSocket** | `Upgrade` handshake + non-HTTP framing is the **least** proxy/EDR-friendly and was **NOT** the mechanism verified | full | `ws` (already vendored) | deferred |

**Decision: SSE for the broker→node push channel, plain HTTPS POST for node→broker.** Rationale,
grounded in the evidence:

1. **SSE *is* the chunked-HTTP stream the spike proved survives this EDR** — it is `text/event-stream`
   over a never-ending response body — so it inherits the strongest deployment evidence we have. It
   adds event framing + ordered IDs on top of raw chunking for free.
2. **Zero new dependency (§17)**: implementable on Node core `http` (telepty already runs its own
   HTTP server); an EventSource-style client is a thin line-parser. No message-broker library.
3. **The traffic shape is half-duplex anyway**: pushes are broker→node (`inject`); node→broker
   (register, heartbeat, session-list, inject *result*/reply) is naturally request/response = POST.
   WebSocket's full-duplex buys nothing the MVP needs, and its `Upgrade` is precisely what corporate
   proxies/EDR break first. **WebSocket is deferred** as a future optimization *if* a high-rate
   downstream ever needs single-connection backpressure — not MVP.

### 2.2 Reconnect / keepalive / backpressure

- **Keepalive**: SSE comment heartbeat (`: ping\n\n`) every ~20–25s so idle intermediaries don't reap
  the channel (the spike held 90s; periodic bytes extend that indefinitely). Node also heartbeats
  upstream so the broker can mark a node dead and reject `inject id@deadnode` fast.
- **Reconnect**: exponential backoff + jitter; on reconnect the node sends `Last-Event-ID`; the
  broker redelivers buffered-but-unacked inject events from a **bounded per-node queue** (TTL + max
  depth). Delivery is **at-least-once** → consumers **dedup by `message_id`**, reusing the exact
  mechanism `peer-relay.js` already implements (the bounded `relaySeen` set, lines 24–32).
- **Backpressure**: bounded per-node queue; on overflow drop-oldest + return an error to the sender.
  Because `inject` is request/reply, the sender always gets a definitive ack / `node
  unreachable|backlogged` / timeout — no silent loss.

### 2.3 `id@host` → `id@<node>` addressing (reused unchanged)

This is the cleanest reuse in the design. `session-routing.js` already splits on the last `@`
(`parseSessionReference`) and resolves `id@X` against **either** `session.host` **or**
`session.peerName` (`pickSessionTarget`, lines 43–47). The broker tags each connected node's
aggregated sessions with `peerName = host = <node-name>` (the node's `machine_id` from the locator
triple / `GET /api/meta`), so `inject id@nodeB` resolves through the **identical** code path. **Only
the resolution *backend* changes** — from "iterate peers, hit each daemon" to "ask broker; broker
maps `<node>` → its held channel." The user-facing addressing grammar is untouched.

## 3. Security threat model (a NEW network surface — REQUIRED)

The broker becomes a **central relay that sees and routes all inject traffic across the fleet**. Today
P2P means only the two endpoints see a given inject; the broker collapses that into one party. This
is the section that most needs defense-in-depth + least-privilege (헌법 보안 원칙).

| # | Threat | Today (P2P) | With broker | Mitigation |
|---|---|---|---|---|
| T1 | **Broker-as-MITM / confidentiality** — broker sees every inject payload (prompts may carry secrets, source, context-refs) | only 2 endpoints | central party sees all | **TLS mandatory** (HTTPS/WSS) node↔broker, day 1. **Trust-bounding**: broker is **first-party + self-hosted** (the fleet operator runs it; §17 — *not* a third-party SaaS relay), so broker-operator == fleet-owner == same trust domain. Hardening phase: optional **E2E sealed payload** (node→node, broker routes but can't read). |
| T2 | **AuthZ — who may inject into whom** — today's `x-telepty-token` is a **flat fleet token** (anyone with it is fully trusted; Tailscale 100.x trusted by default; `TELEPTY_PEER_ALLOWLIST`). On a shared broker, flat token = **any node injects into any session fleet-wide** = privilege escalation. A prompt-injection into an agent session is **RCE-equivalent** in an agent fleet. | flat trust, but reachability already gates it | reachability no longer gates → authz is the only gate | **Per-node identity** (Phase 2): each node authenticates with **its own** credential; broker enforces **default-deny / same-fleet** cross-node authz. The existing optional **JWT path** (`TELEPTY_JWT_SECRET`, `daemon.js`) is the natural basis to upgrade flat-token → per-node least-privilege **with no new dependency**. **Last line: the receiving daemon applies its OWN local authz** before executing a broker-relayed inject. |
| T3 | **Node-identity spoofing / name-squatting / replay** — attacker registers name `nodeB` first, or replays nodeB's registration, to intercept `inject id@nodeB` | n/a | real | Bind node identity to a per-node key/credential (not a self-asserted name); broker rejects duplicate-name registration from a different identity; nonce+timestamp on the channel handshake; reuse `message_id` dedup for inject-level replay. |
| T4 | **Broker impersonation** — DNS/route attacker poses as the broker that nodes are configured to *trust as router* | n/a | real | Node-side **TLS cert validation** (CA-trust or pin) of the broker endpoint. |
| T5 | **Tenancy / cross-fleet leakage** — if multiple fleets share one broker, a bug/weak authz lets fleet A see/inject fleet B | n/a | real | **MVP = single fleet per broker** (sidesteps the entire class). Multi-tenant is an explicit later phase: tenant namespace derived from credential; hard isolation in the routing table (a node may only see/address its own tenant). |
| T6 | **Availability / DoS / amplification** — broker is a SPOF and a fan-out amplifier (one POST → broadcast to N) | no SPOF | SPOF + amplifier | Per-node rate-limit; bounded queues (T §2.2). **Graceful degradation**: broker outage disables *cross-machine* inject but **local inject is unaffected** (제9조). SPOF is an accepted MVP cost; HA is a later phase. |

**Credential boundary (REQUIRED).** Each node **self-owns its auth** — the broker must **not** become
a credential choke-point. Concretely: the broker authenticates the **channel**, not the node's local
daemon; the node's **local daemon token never transits the broker**. A cross-node inject ultimately
lands as a **local inject on nodeB executed under nodeB's own authority** — the broker only conveys
"nodeA requests inject X into `id@nodeB`," and **nodeB's daemon applies its own local authz before
executing** (T2 last line). Therefore compromising the broker does **not** hand an attacker node
credentials; worst case is traffic visibility (mitigated by T1 TLS/E2E) and the ability to *attempt*
injects that the receiving daemon still independently authorizes.

**Defense-in-depth layering**: TLS (T1/T4) · per-node authn (T2/T3) · receiving-daemon authz (T2) ·
tenant isolation (T5) · dedup+nonce (T3) · bounded queues + rate-limit (T6). No single failure yields
full compromise.

## 4. 위헌 심사 (Constitution review — MANDATORY; §1.2 framework-introduction self-application)

A runtime/topology addition triggers the §1.2 self-application. Answering the mandated questions:

**(a) AI 기술 격차 해소에 복무하는가? — YES.** It lets a non-expert orchestrate a cross-machine agent
fleet through a corporate VPN/EDR with **no networking expertise** — no SSH tunnels, no jump-hosts, no
VPN install. It **removes** a "how" burden, directly serving the gap-closing Preamble.

**(b) 어느 컴포넌트의 역할인가? — telepty (a new *mode*, not a new component).** The constitution's
component table assigns telepty "모든 크로스 레이어 해결. 세션/머신/OS 연결" (§3) — cross-machine
session routing/transport is *definitionally* telepty's role (it already owns `cross-machine.js`,
`peer-relay.js`, `session-routing.js`). It is **not** the orchestrator's role (orchestrator owns task
fan-out/decisions, not transport). Spawning a **separate component** for this would itself violate §1
(over-engineering). ⇒ It is a net-new **daemon mode within an existing component**, reusing its auth,
dedup, and addressing.

**(c) 이 프레임워크/추가가 정말 필요한가? — CONDITIONALLY YES.**
- **§1 경량 (sharpest lens — over-engineering risk).** §1.2 asks "이거 없이 직접 구현할 수 있는가?"
  and §1.6 asks "기존 메커니즘이 이 목적을 이미 달성하는가?". Answer: **no existing mechanism solves
  client-isolation** — SSH/HTTP/peer-relay all need direct reachability; Tailscale is EDR-blocked. The
  *minimal* thing that solves NAT/isolation is "a rendezvous both reach + outbound channels," which
  **is** a broker; there is no lighter primitive. **BUT** the genuine §1 risk is scope-creep into a
  full multi-tenant message bus. ⇒ **Passes §1 *iff* held to the inject-only single-fleet MVP**;
  **fails §1** if built as the full broker up front. (This is the proposer-sketch's blind spot — see §8.)
- **§17 무의존.** Broker is **first-party telepty over Node core HTTP** (SSE = no new lib). **No
  third-party relay service**, **no external broker** (not Redis/RabbitMQ/MQTT/cloud pub-sub),
  self-hosted. ⇒ **Passes §17 *iff* no message-broker dependency is pulled in.** Adopting an external
  broker would be a direct §17 violation.
- **§2 크로스.** `telepty inject id@node` behaves identically whether the peer is reachable directly,
  via Tailscale, or via broker — the transport is invisible (resolution swaps under `pickSessionTarget`).
  Broker mode is **opt-in**; default topology is unchanged, so existing direct/Tailscale users see **no
  regression**. ⇒ Passes §2 (incl. §2.1 Cross-Machine "머신 간 경계 없음").

**(d) 모든 크로스 환경에서 동작하는가? — YES.** Node-core HTTP ⇒ Win/macOS/Linux. The entire point is
that it works **where direct P2P (including Tailscale) does NOT**.

**(e) 사용자에게 "어떻게"를 강요하지 않는가? — YES.** The user sets a broker URL once (or it is
fleet-configured) and keeps using the **same** `inject` command — no SSH keys, no VPN, no per-pair
setup. (Caveat: *someone* must run the broker — the fleet operator/orchestrator host, one-time, not
the end user per session.)

Also from the §위헌심사 checklist: **제9조** (broker down ⇒ local still works — yes, §3 T6); **제14조**
안전장치 (TLS + authz + bounded queues — yes); **제15조** SSOT (the `peers.json` `transport:'broker'`
entry + this ADR register the contract change).

**Verdict: PASSES — CONDITIONALLY — on §1 / §2 / §17**, owned by **telepty (new daemon mode)**,
*provided* it is the first-party self-hosted **MVP** (single fleet, inject-first, reuse
auth/dedup/addressing, no external broker lib, opt-in default-off). It **FAILS §1/§17** if built as a
full multi-tenant message bus or on a third-party relay.

## 5. Alternatives considered

1. **Mesh VPN (Tailscale / WireGuard).** *Rejected.* Spike: `tailscaled.exe` is **EDR
   process-blocked**. It is also an external dependency (§17) and forces install/login "how" (§2/e).
   It is moreover **today's substrate** (`peers.json` `*.ts.net`) — i.e. exactly what fails.
2. **SSH bastion / jump-host relay** (`ssh -J bastion B`, or reverse tunnels through a shared host).
   *Rejected as primary; retained as fallback.* Requires reachable sshd + key distribution + tunnel
   lifecycle = heavy "how" (§2/e); corporate egress often blocks SSH too; reverse tunnels are fragile.
   It is a *valid hardening fallback transport* (reuses the existing SSH ControlMaster code) but **the
   spike proved HTTP-chunked survives the EDR; SSH was not proven** against it.
3. **Manual relay / file-drop rendezvous** (e.g. extend the `~/.telepty/shared` context-ref pattern
   both nodes already poll). *Rejected as primary.* Polling latency, no real-time push, no clean reply
   path — but it is the **lowest-tech degraded fallback** and notable because the shared-context
   mechanism already exists.
4. **Do nothing** (keep P2P + Tailscale). *Rejected.* Leaves the reported common WFH↔WFH-through-corp-
   VPN case broken — the exact failure this task exists to fix.

**Why broker wins:** it is the only option that (a) survives the *verified* EDR (HTTP-chunked/SSE), (b)
needs **no external dependency** (first-party), (c) imposes **no per-pair "how"** on users, and (d)
**reuses** existing auth, dedup, and `id@host` addressing.

## 6. Relation to existing work

- **#13 `connect-http`** — changed the **transport** (SSH→HTTP) but **not the topology** (still
  A→B's daemon). The broker changes **topology** (A→broker→B). **Reuses** connect-http's HTTP-client
  patterns, `x-telepty-token`, and the `peers.json` `transport` field (add `transport:'broker'`).
- **`cross-machine.js`** — **reuse**: `peers.json` schema (+ a `broker` entry), session-list
  aggregation + `peerName`/`host` tagging, `getPeerTransport`. **Net-new**: an outbound
  persistent-channel client (`connectBroker`) + the broker-side forwarder.
- **`session-routing.js`** — `parseSessionReference` / `pickSessionTarget` **reused unchanged**;
  `id@node` already matches on `peerName` (§2.3). Cleanest reuse in the design.
- **`src/transport/peer-relay.js`** — **directly relevant**: it already does push fan-out with
  `message_id` dedup, `source_host` stamping, and a bounded `relaySeen` set. The broker is the
  **inversion** of peer-relay (peer-relay *pushes to* each peer = the broken direct-reachability
  model; broker has nodes *hold* channels so it pushes down already-open connections). **Reuse** the
  dedup + `source_host` + bounded-set patterns. **Net-new**: the hold-open channel + per-node queue.
- **`BUS_EVENT_SCHEMA.md`** — the **locator triple** `{machine_id, session_id, project_id}`, `@host`
  routing, `source_host`, and the peer-auth model all map onto the broker (node name = `machine_id`).
  The schema already foreshadows **"P3 cross-machine relay (daemon forwards to target host)"** — the
  broker realizes that for the isolation case.
- **Auth (`daemon.js`)** — `x-telepty-token`, Tailscale-trusted, `TELEPTY_PEER_ALLOWLIST`, optional
  JWT (`TELEPTY_JWT_SECRET`). The **JWT path is the basis for per-node identity** (T2/T3) with no new
  dependency.

## 7. Phased rollout / scope

- **Phase 0 — MVP** *(the recommended build)*: **single broker, single fleet, inject-only, one
  direction at a time.**
  - Node: `telepty connect-broker <url> --token` opens the **SSE downstream + HTTPS POST upstream**
    channel, registers its node name, and pushes its session list.
  - Broker: `telepty broker` daemon mode; routing table `{node → channel}`; forwards `inject id@node`
    down the held channel; **TLS required**; flat `x-telepty-token` accepted (single fleet = single
    trust domain); `message_id` dedup; bounded per-node queue.
  - **Reuse** `session-routing` + `peers.json` + peer-relay dedup. **Goal: WFH↔WFH inject through the
    corp VPN works.**
- **Phase 1 — broadcast + reply**: `broadcast` fan-out; reply rides the upstream POST / a reply event
  back down the requester's channel; live session-list updates (push-on-change vs poll);
  `Last-Event-ID` redelivery on reconnect.
- **Phase 2 — security hardening**: per-node identity (JWT-per-node), receiving-daemon cross-node
  authz (default-deny), rate-limit, broker HA (remove the SPOF).
- **Phase 3 — multi-tenant**: tenant namespace isolation, optional E2E payload encryption, audit log.

**Explicitly out of scope** (this dispatch *and* the MVP): multi-tenancy; E2E encryption; broker
HA/clustering; **non-inject session ops through the broker** (interactive `attach`/`screen`
high-bandwidth streaming — defer); broker auto-discovery; the WebSocket transport (SSE first). **No
implementation in this dispatch.**

## 8. Recommendation

**Build the reduced MVP (Phase 0)** — broker as a first-party telepty daemon mode, **SSE-down +
HTTPS-POST-up**, single fleet, **inject-only**, reusing `session-routing`/auth/dedup. **Do NOT build
the full broker** (multi-tenant message bus) now — that would fail §1.

**Conditions:**
1. **§1**: keep strictly to MVP scope — no multi-tenant / E2E / HA up front.
2. **§17**: first-party self-hosted only — **no external broker library/service**.
3. **§2**: opt-in, **default topology unchanged** — zero regression for direct/Tailscale users.
4. **Security**: **TLS mandatory from day 1** (it is a real network surface), even in MVP.
5. **Evidence**: run a follow-up spike confirming an **SSE-framed** channel (not just raw chunked)
   survives the same corp EDR before GA. The 90s chunked spike is strong but SSE framing should be
   confirmed end-to-end.

### Critique of the proposer's sketch (비판적 + 건설적 + 객관적)

The sketch is directionally correct (outbound persistent + central forwarder) and the EDR evidence is
solid. Sharpened weaknesses:

1. **Transport is hand-waved** ("SSE/WS/chunked — all verified"). They are **not** equivalent: only
   *chunked HTTP* was verified through this EDR; WebSocket's `Upgrade` is the **least** proxy-friendly
   and unproven. Resolved → **SSE chosen, WebSocket deferred** (§2.1).
2. **Upstream path under-specified.** A persistent *downstream* channel does not carry inject
   *results/replies* or registration. Resolved → explicit **POST-up half** (§2.1/§2.2).
3. **AuthZ gap (biggest).** "id@host maps to id@<node>" solves *addressing* but the sketch is silent
   on *authorization*: a central broker + today's flat shared-token = **any node injects into any
   session fleet-wide** (prompt-injection → agent-RCE). Surfaced as **T2** (deferred to Phase 2, but
   called out as the sharpest hole).
4. **§1 over-engineering risk.** "Broker mode" can balloon into a message bus; the sketch has no scope
   discipline. Bounded hard to **inject-only MVP** (§4c, §7).
5. **SPOF/availability unmentioned.** Broker down = cross-machine down → must degrade gracefully (local
   unaffected). Added as **T6**.
