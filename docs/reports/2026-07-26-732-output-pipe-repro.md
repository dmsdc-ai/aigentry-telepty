# #732 — bridge→daemon output pipe silent death: REPRODUCE + DIAGNOSE

Branch: `fix/732-output-pipe-repro`. Date: 2026-07-26.

> **Status: FIXED.** This document is the repro/diagnosis record, written before the
> fix and kept as the historical account — §5 lists what was then still open. The
> approved fix landed in four commits on this branch; see §8 for what shipped and
> which of the hypotheses below it acts on.

---

## 1. The two legs, mapped

A wrapped session's legs share **one socket** — the owner WebSocket — but are
otherwise unrelated pieces of code.

**UPSTREAM (PTY → daemon ring)**

| step | location |
|---|---|
| PTY bytes handed to the bridge | `cli.js:2064` `child.onData(...)` |
| gate | `cli.js:2067` `if (wsReady && daemonWs.readyState === 1)` |
| frame | `cli.js:2068` `daemonWs.send({type:'output', data})` |
| daemon accepts, only if this ws is the current owner | `src/transport/websocket.js:155-161` |
| ring + state fed | `websocket.js:159-161` → `appendToOutputRing` (`daemon.js:~1210`), `sessionStateManager.feed` |
| fan-out to attach viewers | `websocket.js:162-166` (`activeSession.clients`) |

**DOWNSTREAM (inject → PTY)**

| step | location |
|---|---|
| HTTP inject | `daemon.js:3409` → `deliverInjectionToSession` → daemon mailbox → `writeDataToSession` |
| wrapped delivery | `daemon.js:1823-1828` `session.ownerWs.send({type:'inject', data})` |
| bridge receives | `cli.js:1901-1955` |
| write to PTY | `cli.js:1933/1936/1941` → `flushBridgeMailbox` `cli.js:1817` → `child.write(...)` |

**Why one can die while the other lives.** Not because of two transports — because
of two *independent halves inside node-pty*. `UnixTerminal` builds the read side
and the write side as separate objects over the same master fd:

- read : `_socket = new tty.ReadStream(term.fd)` — `node_modules/node-pty/lib/unixTerminal.js:96`
- write: `_writeStream = new CustomWriteStream(term.fd)` — `unixTerminal.js:97`, used by `_write` at `:154`

So `child.write()` (downstream) is completely unaffected by anything that happens
to the read stream (upstream). And node-pty has an in-tree path that kills the
read side **without telling the consumer**:

```js
// node_modules/node-pty/lib/unixTerminal.js:99-105
_this._socket.on('error', function (err) {
  // NOTE: fs.ReadStream gets EAGAIN twice at first:
  if (err.code) {
    if (~err.code.indexOf('EAGAIN')) {
      return;                 // <- no _close(), no 'close', no 'exit'
    }
  }
```

`cli.js` only subscribes to `child.onExit` (`cli.js:2085`). A read side that stops
delivering therefore produces **no exit, no restart, no log line, no WS close** —
the bridge keeps ponging the daemon's heartbeat and keeps writing injects into the
PTY, forever.

**What is supposed to catch this — and does not**

| mechanism | location | verdict |
|---|---|---|
| daemon → bridge ping/pong, 30s, terminate after 2 misses | `websocket.js:48-59` | works, but only proves the *socket* is alive |
| bridge → daemon heartbeat | — | **does not exist** |
| session health | `daemon.js:902-915` — `isOpenWebSocket(session.ownerWs)` only | reports CONNECTED for a dead pipe |
| `lastActivityAt` | stamped by the daemon's OWN delivery path at `daemon.js:1119, 2033, 2061, 4415` | self-poisoning: injects refresh it with zero upstream bytes |
| `outputRingTotalBytes` | `appendToOutputRing` | a genuine upstream-only watermark — **nothing reads it** |

---

## 2. Deterministic repro (seconds, not overnight)

`test/bridge-output-pipe-732.test.js` + `test-support/bridge-pipe-harness.js` +
`test-support/pty-read-fault.js` (test-only preload; never required by product code).

```
node --require ./test-support/setup-env.js --test test/bridge-output-pipe-732.test.js
```

Real `daemon.js` process + real `telepty allow` bridge, isolated `HOME`, ephemeral
port (#524 guard — production 3848 is never contacted). The lever severs *only*
the PTY→consumer hand-off (`_onData.fire`), keeping the master fd draining so the
child never back-pressures — which is required to model a session that kept
working for hours.

**Observed, matching every live symptom:**

| live observation (2026-07-13, demo-codex4) | repro |
|---|---|
| inject → PTY → codex processed turns | inject 200; injected `echo PROVEN > file` executed (file proof, independent of ring and of bridge stdout) |
| read-screen returned old content | screen **byte-identical** to pre-fault |
| PING inject's composer echo never appeared | post-fault marker never reaches the ring |
| cross-host attach streamed 0 bytes | no output frames to fan out (attach has no ring replay on connect — `websocket.js:147-149`) |
| only a bridge respawn cured it | bridge alive, health CONNECTED, no recovery within 45s |

Current result: **2 pass (repro + control), 3 RED**.

| test | today |
|---|---|
| REPRO: downstream survives while upstream is dead | PASS (pins the signature) |
| RED: PTY output must reach the ring within 45s of an upstream stall | **FAIL** — never arrives |
| RED: a session with a dead upstream must not be advertised as healthy | **FAIL** — `CONNECTED / OWNER_CONNECTED` |
| RED: inject must not report plain success into an unobservable session | **FAIL** — `200 {success:true}` |
| CONTROL: `lastActivityAt` is not an upstream signal | PASS (diagnostic) |

The dispatch's conditional second RED ("reconnect-must-restore-upstream") is **not
warranted** — lever (a) does not reproduce; see below.

---

## 3. Lever results — `test/bridge-output-pipe-732-levers.test.js` (both PASS = both negative)

**(a) Restart the daemon; does reconnect restore both legs, or only downstream?**
→ **BOTH.** SIGKILL + restart on the same port, bridge re-registers and reclaims
via `?owner=1`; upstream resumes. Also stressed 15 sever/restart cycles with
randomised downtime (0.1–3.5s): 15/15 restored both legs, 0 asymmetric. Compressing
the GC windows (`TELEPTY_SESSION_CLEANUP_SECONDS=1`, `TELEPTY_HEALTH_POLL_MS=200`)
so the restored session is GC-eligible at restore time also stayed clean.

**(b)+(c) Sever the owner WS server-side without FIN (upstream blackhole), and
check keepalive coverage.** → **NOT silent.** The daemon's ping/pong
(`websocket.js:51-59`) misses two pongs and terminates within ~60s
(`[WS] Terminating stale connection (no pong)`); health → DISCONNECTED, inject →
**503**. That is the opposite of the live signature, where inject kept returning
200. A network-level half-open is **ruled out** as the #732 mechanism.

It does expose the detection asymmetry the fix must close: the daemon heartbeats
its peer, the bridge heartbeats nothing. After the daemon reaps its side, the
bridge holds a `readyState === 1` socket and only learns the truth if it next
*writes* — which an idle session never does.

---

## 4. Root-cause hypotheses, ranked

**H1 — the bridge's PTY→consumer hand-off died while child, write side and socket
stayed alive.** Best fit; reproduces 100% of the live signature.
- **PROVEN:** the state is structurally reachable, fully asymmetric, and detected
  by nothing on either side (repro above).
- **PROVEN:** node-pty's read/write split (`unixTerminal.js:96-97`) makes downstream
  survival automatic, and `unixTerminal.js:99-105` is a named in-tree path that
  leaves exactly this state (swallowed EAGAIN: no `_close()`, no `'close'`, no
  `'exit'`).
- **INFERRED:** that EAGAIN specifically — rather than some other read-side stall —
  was the trigger on 2026-07-13. No bridge-side log exists to confirm it; the
  bridge is deliberately silent to protect TUI rendering (`cli.js:1992-1994`).

**H2 — the bridge's send gate `wsReady && daemonWs.readyState === 1` latched
false.** Would produce the same signature. **Downgraded, not eliminated.** Static
analysis says a new socket is only ever created from a close handler
(`cli.js:1980 → 1988-1999 → 1862`), so `wsReady=false` is always followed by a
reconnect that sets it true; and 15/15 stress cycles never latched it. Kept on the
list because it is the only other single-line explanation.

**H3 — network half-open / NAT idle reaping. RULED OUT.** Lever (b): reaped in
≤60s, inject 503, not 200.

**H4 — reconnect mis-wiring after the 22:20 daemon restart. RULED OUT as a
deterministic cause.** Lever (a): both legs restored, every time.

**H5 — daemon-side session-object orphaning. RULED OUT for this incident, kept as
a latent hazard.** `websocket.js:99` snapshots `const activeSession =
sessions[sessionId]` for the socket's lifetime; if `sessions[id]` were deleted and
recreated under a live owner (`daemon.js:3819`, `daemon.js:4632`), output frames
would fall into the non-owner branch (`websocket.js:193-199`) and be dropped
silently while injects still routed to `sessions[id].ownerWs`. It does not explain
#732 because every path that creates a replacement session object starts with
`outputRing: []` — read-screen would have returned empty, not the old content that
was actually observed. Worth its own guard, separately.

**Why overnight idle correlates**
- **PROVEN:** nothing measures upstream liveness, so time-to-*discovery* is bounded
  only by when a human next reads the screen. A break at 22:20 and a break at 04:00
  are indistinguishable the next morning — part of the "overnight" correlation is a
  discovery artifact, not an occurrence-time signal.
- **PROVEN:** the bridge's only accidental recovery is discover-on-write (an RST on
  its next `send`). An idle session never writes, so it never discovers.
- **INFERRED, and now unsupported:** that the 22:20 restart caused it. Lever (a)
  says restart+reconnect is clean.

**Primary timeline question (died AT reconnect vs LATER): the "at reconnect"
branch is not supported.** Reconnect restores both legs deterministically. The H1
mechanism is time-independent, so "later, undiscovered until morning" is the
surviving reading — unfalsified rather than positively proven.

---

## 5. For the FIX phase (not done — HOLD)

Hooks that already exist and would close the gap cheaply:
1. `outputRingTotalBytes` is a true upstream-only watermark. Frozen while
   `isOpenWebSocket(ownerWs)` is a direct "socket alive, pipe dead" predicate for
   `getSessionHealthStatus` (`daemon.js:902-915`).
2. The daemon already pings every 30s; a bridge-side liveness frame would let the
   daemon separate a *silent session* from a *silent pipe*.
3. Whether the bridge should additionally defend against node-pty's swallowed read
   errors (re-arm / verify `onData` still fires) is a **scope decision for the
   orchestrator**, not a technical one.

## 6. Remaining unknowns
- Exact trigger of the read-side stall on 2026-07-13 — unrecoverable without
  bridge-side logging, which does not exist today.
- `lastActivity: None` does not match any daemon code path (every session
  constructor sets `lastActivityAt`; `buildRestoredWrappedSession` falls back to
  `nowIso()`). Either the raw capture was a different field, or the observing host
  was reading a peer/relay-cached record. Not investigated — the local repro
  reproduces the signature without needing it.

## 7. Artifacts
- `test/bridge-output-pipe-732.test.js` — repro + contract tests
- `test/bridge-output-pipe-732-levers.test.js` — lever (a)/(b)/(c) negatives
- `test/upstream-stall-predicate-732.test.js` — pure stall-decision logic at production defaults
- `test/ws-owner-record-swap-732.test.js` — H5 record-swap guard
- `test-support/bridge-pipe-harness.js` — daemon+bridge+proxy harness
- `test-support/pty-read-fault.js` — test-only upstream-sever preload

All four are registered in `package.json` `test` / `test:watch` / `test:ci`.

---

## 8. What shipped (fix phase, approved after the HOLD)

| # | commit | acts on |
|---|---|---|
| 1 | `fix(#732): detect a dead output pipe behind a live owner socket` | the detection gap — the reason H1 was invisible |
| 2 | `fix(#732): route owner frames through the live session record…` | H5, the latent record-swap hazard |
| 3 | `fix(#732): bridge-side liveness frame + PTY read-side self-defense` | H1's mechanism, plus the leg-attribution gap |
| 4 | `test(#732): flip the repro RED tests to contract tests…` | RED → GREEN + suite registration |

**Detection (§5 hook 1).** `outputRingTotalBytes` — the upstream-only counter that
already existed and nothing read — is now a probe: each wrapped delivery records
"I wrote at T, the counter stood at N", and if it has not passed N after
`TELEPTY_UPSTREAM_STALL_SECONDS` (default 30) the pipe is declared dead. The probe
re-arms only once answered, so a chatty caller cannot reset the clock and hide the
break. Health becomes `UPSTREAM_STALLED` / `OWNER_CONNECTED_UPSTREAM_STALLED`,
inject returns `503 UPSTREAM_STALLED` instead of `200`, and the daemon emits
`session_upstream_stalled` / `session_upstream_recovered` plus a `[UPSTREAM]` log
line. Entirely daemon-side, so it protects sessions whose long-lived bridges predate
the fix.

**Attribution (§5 hook 2).** The bridge now heartbeats the daemon on the same gate an
`output` frame rides, carrying the bytes it has read from the PTY and its read-side
state. Heartbeat arriving + `bridge_pty_bytes` frozen ⇒ the PTY read side died inside
the bridge; heartbeat stopped ⇒ the bridge→daemon leg is gone; both moving ⇒ the
session is simply quiet. Surfaced in the session transport block.

**Self-defense (§5 hook 3 — the scope call).** The bridge polls its own node-pty read
side. A stream that merely stopped flowing is resumed; a destroyed one is reported
rather than vanishing. A destroyed master fd is unrecoverable by construction, so the
honest contract splits: recoverable stalls must self-heal (SELF-HEAL test),
unrecoverable ones must be *noticed* (REPRO + DETECT test).

**Not fixed, by nature.** Bytes that never leave the bridge are gone; the daemon can
report the loss but not replay it. `read-screen` still returns pre-death content
while stalled — now with `health_status: UPSTREAM_STALLED` beside it.

**§6 unknowns unchanged.** The 2026-07-13 trigger remains unrecoverable (no
bridge-side logging existed), and the `lastActivity: None` observation still matches
no daemon code path — the local repro never needed it.
