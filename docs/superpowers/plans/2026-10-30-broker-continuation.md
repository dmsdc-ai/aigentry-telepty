# Broker continuation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task by task.

**Goal:** Extend the existing explicit broker safely with connection recovery, audit seams and strict-local signing, and retain honest destination receipts.

**Architecture:** Existing versioned broker routes and durable receipt tombstones remain authoritative. Independent changes are made in isolated clones, reviewed and composed in the primary local branch.

**Tech Stack:** Node20, existing Ed25519 principal proofs, HTTP/SSE, current async audit writer and JSON receipt ledger; no new dependency.

**Spec:** docs/api/broker-v1.md; docs/security/principal-http-132.md; docs/specs/2026-06-09-inject-audit-provenance.md; open issues42/43/47/132.

## Global constraints

Local source only; no installation, live daemon/service, credentials, security/network configuration or remote writes. No source uploads or TLS bypass. Unknown physical outcomes never authorize replay. Node identity never becomes verified foreign session identity. Every new signer and reconnect mode is explicit and fails closed. Native/provider acceptance remains separate from Linux fixtures.

## Review focus

- Disconnect after physical input must not cause prompt/result replay.
- Stop during handshake/backoff must finish promptly and leave no reconnect timer.
- Auth/signature/protocol refusal must not become an infinite retry loop.
- Audit rows must not reveal prompt bytes/signatures/tokens or infer session/human identity.
- Strict local signing must not read or fall back to a daemon token and must bind exact epoch/route/body.

### Task1: Optional reconnect controller (#42)

Files: src/broker/node.js and narrow main wiring; new reconnect tests.

- [ ] Prove current recipient completes on stream loss and lacks recovery with an owned hub fixture.
- [ ] Add explicit bounded attempts/backoff, finite handshake and cancellation; transient transport only.
- [ ] Test fresh signed stream, future operation, no old-operation replay, exhaustion and terminal auth refusal.
- [ ] Commit and request independent review.

### Task2: Broker audit seams (#43/#47)

Files: broker hub and a small adapter; existing audit schema builder if needed.

- [ ] Test signed admission/refusal and terminal unknown records with hash-only payloads.
- [ ] Reuse bounded async writer; keep node verification separate from null foreign session verification.
- [ ] Test shutdown flush, overflow/error visibility, replay and no raw content under preview settings.
- [ ] Commit and request independent review.

### Task3: Strict-local recipient signer (#42/#132)

Files: principal exact-action resolver/proof actions, broker local request helper and main config loader.

- [ ] Test strict daemon refusal of the existing recipient bearer path.
- [ ] Add an explicit exact forwarded-inject grant with mandatory signed/current epoch and checked private signer path.
- [ ] Test a signed broker delivery to a real strict mailbox, denied grant/stale epoch/forged challenge and zero token fallback.
- [ ] Commit and request independent review.

### Task4: Preserve destination uncertainty (#111/#106)

Files: src/peer-forwarding.js and destination receipt regression.

- [ ] Reproduce a post-effect503 whose first response is unknown but whose persisted destination receipt says failed and loses null bytes/uncertainty on replay.
- [ ] Persist unknown state and a bounded safe uncertainty projection without re-dispatch.
- [ ] Verify repeated requests and a reconstructed receipt ledger preserve unknown and one physical request.
- [ ] Compose all tasks; run focused and full setup-env suites, pinned typecheck and independent final review; record remaining platform/protocol scope.
