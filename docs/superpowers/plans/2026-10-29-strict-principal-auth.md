# Strict principal authentication implementation plan

> **For agentic workers:** Execute these approved, focused steps inline; use test-first verification.

**Goal:** Add an explicit HTTP principal mode authenticated by configured Ed25519 public keys, without changing legacy authentication.

**Architecture:** A portable signature verifier consumes validated public trust configuration. Linux startup loads that configuration through checked directory/file descriptors. A bounded nonce cache and random startup challenge prevent replay; exact action/target grants and independently retained session-credential gates constrain authority.

**Tech stack:** Node core crypto/fs, existing Express middleware and node:test. No enrollment, private-key storage, identity provider, native OS-account authentication, or dependency installation.

**Spec:** Parent delegation for issue #132 and its confirmed strict-mode design in this session.

## Constraints and review focus

- Strict mode is startup configuration only; missing/unsafe/unsupported trust configuration fails before listening. Legacy remains the default.
- Signed assertions bind configured key/principal, audience, transport, exact method/path/query, canonical parsed JSON digest, startup challenge, nonce, and at most 60 seconds of validity.
- Duplicate JSON members, accessors, unsafe targets and unknown actions refuse. Signature claims never establish arbitrary roles or caller-selected identity.
- Cache exhaustion denies new admissions until entries expire; live entries are never evicted. A restart changes the challenge.
- New session ownership comes only from verified middleware context; historical sessions remain owner-unknown. Explicit cross-session inject grants do not bypass existing session-token or external-approval checks.
- Strict WebSocket traffic is refused until separately authorized per-frame semantics exist. Native Windows/macOS trust-file integrity is unsupported, not described as verified OS identity.

## Task 1: portable proof and authorization core

- [x] Write failing synthetic-key tests for valid proofs, malformed proofs, wrong method/target/body/audience/challenge/principal, expiry, replay and full cache.
- [x] Implement bounded JSON parsing/canonicalization, fixed action mapping, validated public key/grant configuration and signature verification.
- [x] Add a small caller-side assertion builder that accepts an external signer/key argument without printing or storing it.
- [x] Run the focused tests and commit the core.

## Task 2: trusted startup and HTTP wiring

- [x] Write failing private-fixture tests for safe/missing/unsafe public configuration and strict-vs-legacy behavior.
- [x] Add Linux descriptor-anchored public trust-file loading and fail-closed startup configuration.
- [x] Capture request JSON bytes, expose the fixed startup challenge and connect strict admission before every legacy credential branch; reject strict WebSocket upgrades.
- [x] Persist verified owning-principal metadata on creation, preserve it on restore, refuse ordinary mutation of legacy/foreign-owned records, and retain existing credential/policy gates.
- [x] Verify real owned HTTP fixtures, run the full suite and typecheck, document the exact implemented contract, and commit.
