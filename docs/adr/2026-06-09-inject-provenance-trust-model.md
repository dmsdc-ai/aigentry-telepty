# ADR 2026-06-09 — Inject provenance trust model: verified-sender vs claimed-from, and the delivery wrapper

- **Status:** Accepted — IMPLEMENTED (shipped **opt-in**: #43 P1–P3 inject audit log + verified-sender token + read API in 0.6.0, commit `f91e71a`; #47 P4–P5 nonce-gated delivery provenance banner + broker/blocked audit seams in 0.6.1, commit `0e587f1`)
- **Date:** 2026-06-09 (status header corrected 2026-06-10 — task #588)
- **Repo:** `aigentry-telepty` (branch `wt/telepty-43-audit-spec`, off `main`@`3f5e5f2`)
- **Tasks:** #573 / #43 (inject audit log + verified sender identity + delivery provenance wrapper)
- **Author role:** architect (`telepty-43-audit-spec`)
- **Spec (companion):** `docs/specs/2026-06-09-inject-audit-provenance.md`
- **Relates:** #42 (broker — already carries JWT `sub` node identity + an `audit()` hook), #45 (fan-out gate — `peer_inject_blocked`), `classifyPeerLaneInject` (`daemon.js:402`), `src/protocol/http-auth.js` (auth middleware, `signNodeJwt`)

> **2026-06-10 correction (task #588, per `docs/reports/2026-06-10-structure-audit.md` RISK 3):**
> This ADR's original header ("Proposed — NO implementation in this dispatch") was true for the
> spec-only authoring dispatch but went stale after implementation shipped: `src/audit/inject-log.js`
> and `src/audit/provenance.js` plus audit/provenance test files landed 2026-06-09 — #43 P1–P3
> (inject audit log + verified-sender token + read API, `f91e71a`, release 0.6.0 `3255c41`) and
> #47 P4–P5 (nonce-gated delivery provenance banner + broker/blocked audit seams, `0e587f1`,
> release 0.6.1 `d0e5338`). The feature is **shipped but opt-in** (banner is capability-gated per
> §5 "must be opt-in"). Note: the 2026-06-10 structure audit assessed the implementation as
> *partial* ("banner prepend and session-token validation not yet visible" in its module reads) —
> if portions remain unimplemented, that is an implementation-completeness question, not a license
> to read this ADR as unimplemented.

---

## 1. Context — three trust layers, one missing primitive

telepty has **no daemon-verified notion of who sent an inject**, and the byte stream a receiving
agent reads carries **no trustworthy origin marker**. Concretely (source-cited):

- The inject is a **stateless HTTP POST** to `/api/sessions/:id/inject` (`daemon.js:2554`). The only
  sender signal is `body.from`, extracted CLI-side from `process.env.TELEPTY_SESSION_ID`
  (`cli.js:1983`, shipped as `body.from` at `cli.js:294`) and **trusted verbatim** by the daemon
  (`daemon.js:2610` `session.lastInjectFrom = from`). The auth middleware authenticates the
  *connection* by localhost-trust or shared token/JWT (`http-auth.js:76–96`) — it does **not** bind
  the connection to a session identity.
- The only existing "anti-spoof" is `classifyPeerLaneInject` envelope self-consistency
  (`daemon.js:447` `env.from !== from → block`). The attacker controls **both** `env.from` and
  `from`, so this proves nothing about authenticity (issue #43 body confirms this).
- The payload is written to the target PTY **raw** (`daemon.js:1391` `payload: prompt`). The only
  "sender" a receiving agent sees is an **unvalidated CLI onboarding convention** —
  "always include `[from: …]`" (`cli.js:3114`). A receiving agent cannot tell a genuine
  `[from: orchestrator]` from one an attacker typed into the prompt body.

So there are **three distinct trust questions**, and today none is answered:

| Layer | Question | Who needs the answer | Status today |
|---|---|---|---|
| **Audit** | "who injected what, into whom, when?" (after the fact) | operator / incident response | ❌ no log |
| **Daemon trust** | "is the claimed sender real?" (at delivery time) | the daemon, defenses, #42 authz | ❌ `from` trusted verbatim |
| **Receiver trust** | "is this from trusted-local or untrusted-remote?" (when reading bytes) | the downstream LLM agent | ❌ unvalidated `[from:]` text |

The crux decision this ADR settles: **what is the daemon-side source of truth for sender identity,
and how (if at all) can that truth be made trustworthy to an LLM that reads plain text and cannot
run cryptographic verification on its input?**

---

## 2. Decision

### D1 — `verified_sender_sid` is a daemon-minted capability identity, logged ALONGSIDE (never replacing) `claimed_from`

The daemon mints a **per-session capability token** at `/api/sessions/register` (`daemon.js:1788/1878`)
and returns it to the `allow` wrapper, which stores it in the **same parent-hijack-protected env**
that already shields `TELEPTY_SESSION_ID` (`cli.js:1236–1243` — parent value is *deleted then
re-set*, so a parent process cannot inject its own). `telepty inject` presents that token (header
`x-telepty-session-token`); the daemon maps **token → registered sid = `verified_sender_sid`**.

- `claimed_from` = `body.from` (status quo, kept verbatim — never dropped).
- `verified_sender_sid` = the daemon's own mapping, or `null` when unverifiable.
- A **spoof is `claimed_from !== verified_sender_sid` with both present** — now *visible* in the audit
  log, which is the issue's core ask. We **detect and record**, we do **not** silently block (blocking
  is #45's job; over-blocking here would brick legitimate operator/CLI traffic — see §3 fail-open).

Source of truth by origin:

| Inject origin | `verified_sender_sid` source | `origin` label |
|---|---|---|
| Local session → session (token presented) | daemon token→sid map | `trusted-local` |
| Operator / human CLI (no session token) | `null` → recorded as `operator(local)` w/ auth principal | `trusted-local` (operator) |
| Cross-machine via broker (#42) | broker-verified JWT **`sub`** (`broker-server.js:131,276`) | `untrusted-remote` |
| Daemon-internal (mailbox, bootstrap) | `daemon` (literal) | `trusted-local` (system) |

**Why not** make `verified_sender_sid` *replace* `from`? Because `from` is also a **routing/reply**
field (`reply_to` defaults to it, `daemon.js:2564`; REPORT reverse-match keys on it, `daemon.js:2634`).
Replacing it would entangle this security change with routing behavior (Rule 29 surgical-edit
violation) and lose the spoof-visibility signal. **Log both.**

### D2 — Authoritative provenance is OUT-OF-BAND (the daemon API), not the byte stream

A receiving agent that needs to *trust* origin **queries the daemon** (`GET /api/injects?to=<self>&since=…`,
token-gated) rather than trusting any marker in the delivered bytes. The daemon is the only party
that knows `verified_sender_sid`; an authenticated query to it is **unforgeable by prompt-body
content**, because the body never transits that channel.

### D3 — The in-band delivery wrapper is a per-session-nonce-gated banner: best-effort + defense-in-depth, explicitly NON-authoritative

The daemon **prepends** a fenced banner to every genuine delivery:

```
⟦telepty:provenance v=1 from=<verified_sender_sid|claimed:?> origin=<trusted-local|untrusted-remote> nonce=<N>⟧
<the actual payload>
⟦telepty:end⟧
```

`<N>` is a **per-session random nonce** shared with the receiving agent **once at bootstrap** over
the trusted onboarding channel (the same protected context that carries `TELEPTY_SESSION_ID`), and
which the agent is instructed to **treat as secret and never echo**. The agent trusts an origin
banner **only if it carries the session's current `nonce`**; a `[from:]` or banner an attacker types
into the body lacks `N` and is therefore non-authoritative.

**This is deliberately not cryptographic.** See §4 for the rejected HMAC/PKI alternative and why it
is over-engineering (§1 경량) for an LLM consumer.

---

## 3. The central tension (argued explicitly, per dispatch)

> "in-band markers are themselves injectable; argue the trust model explicitly."

**Any in-band marker an LLM verifies by pattern-matching can be forged by another part of the same
text stream** — unless it carries a secret the body author does not possess. The only secret the
daemon and the receiving agent share, that the body author cannot read, is something delivered over
the **protected bootstrap channel** (where `TELEPTY_SESSION_ID` already lives, parent-hijack-proof).
So the in-band nonce reduces to: **"a shared secret the LLM string-matches; its strength = the
secrecy of the nonce."** Honest consequences:

- **It is not unforgeable.** If the nonce ever leaks (the agent echoes it into output that is later
  fed back as an inject, or a transcript is shared), the banner is forgeable until rotation.
  Mitigations: instruct "never echo `N`"; **ratchet** `N` per delivery (daemon advances, includes
  prior-tag) for high-assurance sessions; and fall back to D2 for any trust-critical decision.
- **An LLM cannot compute HMAC over its input.** It can only do string-equality on a nonce. That is
  the hard §2-cross-CLI constraint (claude/codex/gemini all consume bytes as text into a model, none
  run a verifier on the input). This is *why* the authoritative path (D2) is out-of-band: the daemon,
  not the model, does the verification.

**Therefore the trust model is layered, and the layering is the decision:**

1. **Authoritative:** out-of-band daemon API / audit log (D2). Unforgeable. Used for any trust-critical
   gate.
2. **Best-effort + UX:** in-band nonce-gated banner (D3). Trustworthy in the common case, secret-gated,
   cheap, human-readable, cross-CLI. Used for at-a-glance "this is untrusted-remote" labeling.
3. **Never authoritative:** any unkeyed `[from:]` text (the status-quo convention) — demoted to a hint.

The wrapper makes the *common case* trustworthy and the *spoofed case* detectable; the API makes the
*adversarial case* provable. We do not claim the in-band banner is tamper-**proof** — only
tamper-**evident** (a banner without the right nonce is visibly untrusted), which is exactly what the
audit layer (`claimed != verified`) gives the daemon.

---

## 4. Alternatives considered

**A1 — Trust `body.from` (status quo).** Rejected: the documented incident (#43) is untraceable
precisely because `from` is spoofable; this is the bug.

**A2 — Bind sender by source IP / socket.** Rejected: inject is stateless HTTP and every local sender
arrives as `127.0.0.1` (`http-auth.js:61`); SSH peers also arrive as localhost. No discriminating
signal.

**A3 — Deliver injects over each session's existing owner WebSocket** (which *is* identity-bound)
instead of stateless HTTP. Tempting and architecturally cleaner, but a **large refactor** of the
delivery path (`daemon.js:1300–1313`) touching every transport — violates §1 경량 / Rule 29 for this
change. **Deferred** as the eventual "right" substrate; the per-session token (D1) gets the same
identity guarantee with an additive change. Noted in the spec's future-work.

**A4 — Per-delivery HMAC/signature the agent verifies (cryptographic in-band envelope).** Rejected as
**§1 경량 over-engineering**: the consumer is an LLM that **cannot verify an HMAC over its input**, so
the signature would be decorative — it buys nothing the nonce-string-match doesn't, while adding key
management, rotation, and a verifier the agent can't run. If a *program* (not an LLM) ever consumes
deliveries, revisit. This is the explicit 위헌 line for this feature.

**A5 — Block on `claimed != verified` (hard fail).** Rejected for *this* ADR: operator/CLI and
fail-open cases (`classifyPeerLaneInject` already degrades to allow when orch-sids unconfigured,
`daemon.js:408`) make hard-blocking here a mesh-bricking risk. We **record**; #45 owns blocking
policy. Consistent with the existing fail-open posture.

---

## 5. Consequences

**Positive**
- Every inject becomes traceable (`injects.jsonl`); patient-zero and blast-radius become answerable.
- Spoofing becomes **visible** (`claimed != verified`) without changing routing/reply semantics.
- `verified_sender_sid` is the **same primitive #42 needs** for per-peer authz — built once, reused
  (broker `sub` already supplies it cross-machine; the broker's existing `audit()` is the
  cross-machine emission seam).
- Receiving agents gain a real (if best-effort) trusted-local vs untrusted-remote signal, with an
  unforgeable escalation path (the API).

**Negative / accepted**
- The in-band banner is tamper-**evident**, not tamper-**proof** (§3) — accepted; the API is the
  backstop.
- A per-session token is new state the `allow` wrapper must carry and the daemon must map — additive,
  but it *is* new surface (mitigated: reuses the existing protected-env mechanism, no new crypto).
- Banner prepend changes the exact bytes a session receives — must be **opt-in / capability-gated per
  session** so CLIs that don't understand the fence aren't confused (§2-cross compatibility; see spec
  §6 rollout).
- Operator/human injects have `verified_sender_sid = null` by design — honest, but means "unverified"
  is a normal, frequent state, not an alarm.

---

## 6. 위헌 심사 (constitutional review) — summary

Full 5-question review lives in the spec (§10). ADR-level verdict: **PASS with one watched line.**
The §1 경량 risk is **A4 (cryptographic in-band envelope)** — explicitly rejected here. As long as the
in-band layer stays a nonce string-match and the authoritative layer stays the existing token-gated
API + an append-only file (no new datastore, no new crypto, no PKI), the feature is minimal and each
primitive is load-bearing. The moment someone proposes signed envelopes the LLM "verifies," that is
the 위헌 line — flag and stop.
