# Principal Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read exact readiness through existing strict authentication without enrollment.

**Architecture:** A small principal CLI adapter reuses the checked signer and bounded
HTTP client. It validates and projects the existing readiness response; the main
CLI only dispatches and prints it.

**Tech Stack:** Existing CommonJS Node.js and built-in test runner; no dependencies.

**Spec:** ../specs/2026-10-30-principal-readiness-design.md

## Global Constraints

- No fallback, discovery, registration, mutation, external transmission or operational change.
- Existing five-second request deadline; response bound 16 KiB.
- Retain original REPORT/foreign trust and null completion/unknown consumption/reply.

## Review Focus

- Exact epoch must bind assertion, route query and returned identity.
- A successful signed GET must not be promoted into registration or identity attestation.
- Unsafe signer/usage and cancellation must refuse without legacy credential fallback.
- Invalid/oversized/contradictory responses must not be echoed or accepted.
- Help/old readiness behavior and unsupported native key boundaries must remain intact.

### Task 1: Signed readiness adapter and command

**Files:** create `src/principal/readiness-cli.js`,
`test/principal-readiness.test.js`, modify dispatch/help in `cli.js` and both package
test lists. Document in `docs/security/principal-readiness.md`.

**Interface:** `runPrincipalReadiness(parameters, {signal} = {})` returns one sanitized
observation for exactly `--config <file> --session <id> --epoch <epoch>`.

- [x] Write and observe failing actual HTTP middleware/route and CLI tests.
- [x] Reuse bodyless GET hashing, challenge, exact signed epoch and timeout-zero query;
  validate/project bounded response and fixed error codes, no added authority.
- [x] Run focused and composition tests, pinned typecheck and independent review.
- [x] Run full suite/fixture and diff checks, then commit locally with evidence.

Evidence: focused six passed, composition41/41, independent13/13 and cancellation
probes, full suite2,532 passed / zero failed / three skipped. Pinned typecheck,
syntax, links, fixture and whitespace checks passed. No policy deviation or
deferred review finding; operational enrollment/native acceptance remain external.

The first implementation sent `{}` in the signed GET binding while transmitting
no body; actual production authentication correctly refused it. The adapter now
signs the absent body, matching production request hashing. No server check was
relaxed. Tests remain actual accepted middleware observations, not mock auth.
