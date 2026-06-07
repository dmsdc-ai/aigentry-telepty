# Spec — #533 Phase 2: telepty daemon peer-lane inject-validator (hard block)

- **Date:** 2026-06-07
- **Status:** SPEC FIRST — awaiting `533p2-APPROVED` (no impl until approved)
- **Author:** coder (`t533p2-impl`)
- **Lands with:** #549 → telepty **0.5.7** (orchestrator lands + deploys; NO push from this session)
- **Issue:** #533 session↔session guardrail, Phase 2 (in-band hard block)
- **Phase 1 (deployed):** orchestrator-side soft/warn auditor + `bin/ask.sh` sanctioned channel
  (ADR `aigentry-orchestrator/docs/adr/2026-06-07-session-comms-guardrail.md`).

---

## 1. Problem & goal

Phase 1 ships the **sanctioned** peer→peer info channel (`bin/ask.sh`) and an orchestrator-side
reconcile-tick auditor that **detects** raw `telepty inject` peer→peer bypass (warn + escalate). It
cannot **block** — by the time the auditor sees the bus event, the inject has already been delivered.

**Phase 2 goal:** the telepty daemon **hard-blocks out-of-policy peer-lane injects in-band** (before
delivery), so work-delegation laundering between peers is *prevented*, not merely detected. This
hardens the ADR-MF #8 spawn-gate (defense in depth): a worker can no longer hand work to another
worker by raw-injecting it.

**Non-goal:** blocking or altering orchestrator↔peer traffic, broadcast/multicast, or any existing
inject kind. The guardrail is *additive* and scoped strictly to the **peer lane**.

---

## 2. The sanctioned envelope contract (source of truth: `aigentry-orchestrator/bin/ask.sh` `build_envelope`)

A sanctioned peer inject body is a **one-line compact JSON** envelope (separators `(",",":")`):

```json
{"kind":"ask-request","from":"<sid>","to":"<sid>","thread_id":"<id>","round":<int>,"question":"<text>","reply_to":"<from>"}
{"kind":"ask-reply","from":"<sid>","to":"<sid>","thread_id":"<id>","round":<int>,"answer":"<text>"}
```

`kind ∈ {ask-request, ask-reply}` are the **only** sanctioned peer-lane kinds. Required fields:

| kind          | required fields                                                   |
|---------------|-------------------------------------------------------------------|
| `ask-request` | `kind`, `from`, `to`, `thread_id`, `round` (int), `question` (str), `reply_to` (str) |
| `ask-reply`   | `kind`, `from`, `to`, `thread_id`, `round` (int), `answer` (str)   |

`ask.sh` delivers the envelope via `telepty inject --from "$from" --submit "$to" "$msg"`, i.e. it
arrives at the daemon route `POST /api/sessions/:id/inject` with `from=<sender sid>` and the envelope
as `prompt`. That single route is the in-band choke point Phase 2 hooks.

---

## 3. Cross-repo split (two surgical changes, one feature)

Article 17 (무의존): **telepty must run standalone** — it cannot import the orchestrator package or
`@dmsdc-ai/aigentry-ssot`. Therefore the two repos own different halves:

| # | Repo                    | File                                  | Change |
|---|-------------------------|---------------------------------------|--------|
| 1 | `aigentry-orchestrator` | `src/session/inject-parser.ts`        | **Additive** `ask-request`/`ask-reply` kinds + validators, so the Phase-1 auditor *recognizes* sanctioned peer envelopes (does not flag them as bypass). |
| 2 | `aigentry-telepty`      | `daemon.js` (inject route + new pure validator) | **In-band enforcement**: classify peer-lane injects, block out-of-policy ones, emit `peer_inject_blocked`. |

The telepty side carries its **own minimal validator** (the 2 peer kinds only) — it is *not* a copy of
the full orchestrator 5-kind parser. §1 경량: the daemon validates only what it must enforce.

---

## 4. Orchestrator side (#1) — `inject-parser.ts` additive kinds

**Rule 29:** do **not** touch the existing `report | cleanup-request | extend-lifetime | hold |
test-report` branches. Add `ask-request` and `ask-reply` purely additively:

- Extend `ParsedInjectKind` union: `| "ask-request" | "ask-reply"`.
- Extend `ParsedInject` union with the two payload shapes (fields per §2 table).
- Add `interface AskRequestPayload` / `AskReplyPayload` (local, no ssot dependency — ssot owns only the
  originally-shipped kinds).
- Add `case "ask-request":` / `case "ask-reply":` to `narrowSsotEnvelope()` with
  `validateAskRequest()` / `validateAskReply()` (mirror the existing `isRecord` + typed-field-check
  style). **JSON-only** — no markdown fallback (the envelope is always compact JSON from `ask.sh`).
- No change to `parseInject()` control flow beyond the two new `case`s being reachable.

This makes the orchestrator auditor treat sanctioned peer envelopes as **known kinds** instead of
`"unknown envelope kind"`, so they are not mis-flagged as bypass once Phase 2 starts allowing them.

> Note: this file is in the orchestrator repo; the orchestrator lands it. This spec specifies it so
> both halves land coherently in the 0.5.7 cut.

---

## 5. Telepty side (#2) — the validator + hook

### 5.1 New pure classifier (unit-testable, no I/O)

Add a pure function to `daemon.js` and export it from the existing `module.exports` block
(daemon.js:3494) alongside the other DI-testable helpers:

```js
// classifyPeerLaneInject — pure peer-lane policy verdict for an inject.
// Returns { lane, decision, reason, kind }:
//   lane ∈ 'orchestrator' | 'peer' | 'disabled'
//   decision ∈ 'allow' | 'block'
//   kind ∈ 'ask-request' | 'ask-reply' | null   (parsed sanctioned kind, when allowed on peer lane)
function classifyPeerLaneInject({ from, to, prompt, orchestratorSids }) { ... }
```

Logic (in order):

1. **Fail-open guard.** If `orchestratorSids` is empty → `{ lane:'disabled', decision:'allow',
   reason:'orch-sid-unconfigured-fail-open' }`. (Caller warns once — see §7.)
2. **No sender.** If `!from` → `{ lane:'orchestrator', decision:'allow', reason:'no-sender' }`
   (operator/CLI/multicast/broadcast — never peer-lane).
3. **Orchestrator lane.** If `from ∈ orchestratorSids` OR `to ∈ orchestratorSids` →
   `{ lane:'orchestrator', decision:'allow', reason:'orch-lane' }` (untouched — orch↔peer always
   allowed, including work-delegation prose).
4. **Peer lane** (neither end is the orchestrator): parse `prompt` as the §2 envelope:
   - first non-empty line → `JSON.parse` → object with `kind ∈ {ask-request, ask-reply}` and all
     required fields present + correctly typed (`round` is an integer; `question`/`answer`/`reply_to`
     are non-empty strings), **and** `envelope.from === from` (sender-consistency — cheap anti-spoof;
     `to` is *not* cross-checked because the route resolves aliases, which would false-block).
   - well-formed → `{ lane:'peer', decision:'allow', kind, reason:'sanctioned-envelope' }`.
   - anything else (no envelope / bad JSON / wrong kind / missing field / from-mismatch) →
     `{ lane:'peer', decision:'block', reason:<specific>, kind:null }`.

The parse is wrapped in try/catch; any throw → block (fail-closed *within* the peer lane — a peer
sending an unparseable body is exactly the bypass we block).

### 5.2 Hook point — `POST /api/sessions/:id/inject` (daemon.js:2423)

The gate runs **after** `from`/`prompt` are read and `reply_to` defaulted (daemon.js:2430–2433) and
**before** `deliverInjectionToSession` (daemon.js:2439). Concretely, insert between the current
line 2433 (`if (from && !reply_to) reply_to = from;`) and line 2435 (`// Routing metadata...`):

```js
// #533 Phase 2 — peer-lane inject guardrail (in-band hard block).
const verdict = classifyPeerLaneInject({
  from, to: requestedId, prompt, orchestratorSids: ORCHESTRATOR_SIDS,
});
if (verdict.decision === 'block') {
  broadcastSessionEvent('peer_inject_blocked', id, session, {
    extra: {
      target_agent: id, from: from || null, reason: verdict.reason,
      attempted_kind: verdict.kind, envelope_present: /* parse-attempted bool */,
      inject_id,
    },
  });
  console.warn(`[PEER-GUARD] blocked peer inject ${from} → ${id} (${verdict.reason})`);
  return respondWithError(res, 403, 'PEER_INJECT_BLOCKED',
    'Peer-lane inject blocked: not a sanctioned ask-request/ask-reply envelope. Use bin/ask.sh.',
    { reason: verdict.reason, sanctioned_channel: 'bin/ask.sh' });
}
if (verdict.lane === 'disabled') {
  console.warn('[PEER-GUARD] orchestrator sid unconfigured — peer guardrail disabled (fail-open)');
}
```

- `to: requestedId` (the raw target sid, matching how `from` is the raw sender sid) — symmetric so
  orchestrator-alias detection works before `resolveSessionAlias`.
- `inject_id` is already computed at daemon.js:2437; move the gate below that line (or compute the
  verdict above and emit using the existing id) — impl detail, kept surgical.
- `multicast`/`broadcast` routes (daemon.js:1907, 1947) carry **no `from`** → rule 2 allows them;
  they are not edited.

### 5.3 Orchestrator-sid config (resolves the OPEN DESIGN POINT)

```js
// Top-of-file config block (near daemon.js:140 PEER_ALLOWLIST), additive:
const ORCHESTRATOR_SIDS = (process.env.AIGENTRY_ORCHESTRATOR_SIDS
  || 'orchestrator aigentry-orchestrator-claude')
  .split(/\s+/).map(s => s.trim()).filter(Boolean);
```

---

## 6. OPEN DESIGN POINT — decisions

### 6.1 How the daemon identifies the orchestrator sid → **(a) env config, reusing `ask.sh`'s var**

Evaluated:

- **(a) env `AIGENTRY_ORCHESTRATOR_SIDS`** (default `orchestrator aigentry-orchestrator-claude`).
- **(b) session ROLE metadata.** *Rejected:* the daemon **has no role field.** The register record
  (daemon.js:1697–1725) stores `command/cwd/backend/...` but **no role** — the daemon is
  role-agnostic transport (§3 역할: telepty enforces transport policy, it does not model roles).
  Adding a role field is a new subsystem (§1 경량 violation) and still needs an out-of-band source of
  truth for *which* role is "orchestrator."
- **(c) registered "orchestrator" flag at allow-time.** *Rejected:* same problem as (b) plus a new
  registration field + lifecycle; over-engineering for a single known sid.

**Chosen (a)** because: (1) it **exactly reuses** `ask.sh`'s `AIGENTRY_ORCHESTRATOR_SIDS`
(orchestrator/bin/ask.sh:44) — both ends of the policy agree on "who is the orchestrator" from one
config, no drift; (2) it matches the daemon's established `process.env.TELEPTY_*` config idiom
(daemon.js:28–187); (3) zero new subsystem, zero schema change (§1, §17). The space-separated,
multi-sid format matches `ask.sh` verbatim so a single env export configures both.

### 6.2 Block mechanism → **reject the inject API call (HTTP 403), do not deliver**

The gate returns `respondWithError(res, 403, 'PEER_INJECT_BLOCKED', …)` and **never calls
`deliverInjectionToSession`**. Chosen over "drop-with-NACK" because:

- It is the natural in-band point — the request synchronously fails, the target never receives bytes.
- It reuses the existing `respondWithError` surface (no new NACK transport — §1 경량).
- "Drop-with-NACK" implies acking success then sending a side-channel NACK, which is racier and gives
  the false impression of delivery.

### 6.3 How the sender (`ask.sh`) learns it was blocked

- The daemon returns `403 { code:'PEER_INJECT_BLOCKED', error, reason, sanctioned_channel:'bin/ask.sh' }`.
- The CLI inject path **already surfaces non-ok responses**:
  `cli.js:1867 → if (!res.ok) { console.error(\`❌ ${formatApiError(data)}\`); return; }`. The blocked
  sender sees `❌ Peer-lane inject blocked… Use bin/ask.sh` on **stderr** with a remediation hint.
- **Sanctioned `ask.sh` traffic is never blocked** (the daemon allows valid envelopes), so `ask.sh`'s
  own flow is unaffected. Only **raw bypass** attempts (a session calling `telepty inject` directly
  with work-delegation) hit the 403 — and that misbehaving session is told why.

**Known pre-existing gap (out of scope — Rule 29 flag, do not silently expand):** `cli.js:1867`
`return`s **without** setting a non-zero exit code, so `telepty inject` currently exits 0 even on a
non-ok response. The hard-block does **not** depend on this (delivery is already prevented daemon-side
and the block is telemetered), and the stderr `❌` is visible. Propagating a non-zero exit code from a
blocked inject is a **separate one-line tightening** for the orchestrator to approve, not part of this
surgical task.

### 6.4 Fail-open vs fail-closed when the orchestrator sid is unknown → **fail-OPEN + warn**

"Unknown" can only occur if `AIGENTRY_ORCHESTRATOR_SIDS` is explicitly set empty (normal operation has
the baked-in default, so the orch sid is effectively always known). In that empty case the validator
**disables itself** (allow all) and `console.warn`s once. Justification:

1. **§3 역할 / transport safety:** an empty orch-sid set makes *every* inject look peer-lane (neither
   end matches an empty set), which would over-block **orchestrator↔peer** traffic and brick the whole
   mesh. Fail-open prevents a config typo from taking down all session comms.
2. **Defense in depth backstop:** the Phase-1 orchestrator-side auditor **still detects** raw bypass
   on the bus, so a fail-open window is *detected and escalated*, not silent.
3. **Article 17 resilience:** ship a fallback path — the guardrail degrades to Phase-1 behavior rather
   than failing the transport.

---

## 7. Telemetry → `peer_inject_blocked` (no #118 schema break)

Emitted via the existing `broadcastSessionEvent('peer_inject_blocked', id, session, { extra })`
surface (daemon.js:993 → `buildSessionEvent` → `broadcastBusEvent`). This is **additive**: a new
`type`/`event_type` value on the **unchanged** version-1 bus envelope (BUS_EVENT_SCHEMA.md §`version`),
so it is not a #118 schema break. `extra` fields:

| field             | meaning                                                   |
|-------------------|-----------------------------------------------------------|
| `target_agent`    | blocked target sid                                        |
| `from`            | sender sid                                                |
| `reason`          | specific block reason (`no-envelope`/`bad-json`/`wrong-kind`/`missing-field`/`from-mismatch`) |
| `attempted_kind`  | parsed kind if any, else `null`                           |
| `envelope_present`| whether a JSON object was parseable from the first line   |
| `inject_id`       | correlation id                                            |

The Phase-1 auditor already consumes the bus; it records this event (reuse, no new sink). A
one-line `peer_inject_blocked` entry is added to **BUS_EVENT_SCHEMA.md** (doc-only, additive).

---

## 8. Rule 29 surgical boundary

**In scope:**
- orchestrator `inject-parser.ts`: +2 kinds, +2 validators, union extensions (additive only).
- telepty `daemon.js`: +`ORCHESTRATOR_SIDS` const, +`classifyPeerLaneInject` pure fn, +export it,
  +the one gate block in `POST /api/sessions/:id/inject`, +`peer_inject_blocked` emit.
- telepty `BUS_EVENT_SCHEMA.md`: +1 event row (doc).
- tests (§9).

**Explicitly NOT touched:** existing inject kinds/branches; `deliverInjectionToSession`;
multicast/broadcast routes; `cli.js` exit-code behavior (flagged §6.3); register/role model; any
reformatting of adjacent code.

---

## 9. Test plan (TDD — write red first, then implement)

Unit tests on the pure `classifyPeerLaneInject` in **`test/peer-inject-validator.test.js`** (node:test,
matching the repo convention) + an integration test for the 403 via the HTTP route in the
`test/daemon.test.js` style. The **4 mandated scenarios**:

1. **peer work-delegation BLOCKED** — `from='coder-a'`, `to='coder-b'`, `prompt='Implement foo() in
   bar.ts and report back'` (no envelope) → `decision:'block'`, route returns **403
   PEER_INJECT_BLOCKED**, `deliverInjectionToSession` **not called**, `peer_inject_blocked` emitted.
2. **peer ask-request ALLOWED** — valid `ask-request` envelope (and a sibling case: valid `ask-reply`)
   between two peers → `decision:'allow'`, `kind` set, delivered normally (200).
3. **orch↔peer ALLOWED** — `from='orchestrator'`, `to='coder-b'` with work-delegation prose → allowed
   untouched; and `from='coder-b'`, `to='orchestrator'` (REPORT) → allowed untouched.
4. **unknown-orch-sid fail-OPEN** — `AIGENTRY_ORCHESTRATOR_SIDS=''` → `lane:'disabled'`,
   peer work-delegation **ALLOWED** + warn (no 403).

**Additional edge unit cases:**
- malformed envelope (`ask-request` missing `question`, or `round` non-integer) → block.
- envelope `from` ≠ inject `from` → block (`from-mismatch`).
- no `from` (operator/CLI) → allow.
- multicast/broadcast (no `from`) → unaffected (allow).
- well-formed envelope with leading/trailing whitespace / trailing log lines after line 1 → allow
  (first-line parse).

**Regression:** full `npm test` suite → **no new reds**. `node --check daemon.js`. Snyk on changed
`.ts`/`.js` → **0 new findings**.

---

## 10. Landing

After `533p2-APPROVED`: implement surgically, TDD the scenarios above, `node --check`, full suite
(no new reds), Snyk 0-new, commit small. **NO push** — orchestrator lands both repo halves and cuts
telepty **0.5.7** together with #549. Then REPORT → orchestrator (Rule 16).
