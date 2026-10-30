# Staged Principal Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inspect declared client grants without changing authentication or implying enrollment.

**Architecture:** A small offline module reads explicit files through the existing
Linux authority adapter, validates bounded inventory and compares configured grants.
A standalone script reports sanitized JSON with activation always denied.

**Tech Stack:** Existing Node.js CommonJS, built-in test runner; no new dependencies.

**Spec:** ../specs/2026-10-30-staged-principal-design.md

## Global Constraints

- No network, private-key reads, environment-selected default inputs or mutations.
- Keep REPORT authority and foreign trust unchanged; activation always false.
- Inventory maximum 64 KiB, 128 clients, 128 requirements per client.

## Review Focus

- A declared grant match must never become an authentication/cutover claim.
- Missing keys/principal mismatches/legacy clients must produce fixed blockers.
- Ambiguous JSON, unsafe files and malformed inventory must fail without input disclosure.
- Unsupported platforms and omitted/unknown CLI flags must refuse without fallback.
- Wildcards must match only the grants already accepted by production trust validation.

### Task 1: Offline static preparation

**Files:** create `src/principal/migration-preflight.js`,
`scripts/principal-preflight.js`, `test/principal-migration-preflight.test.js`;
register the test in both package scripts before the fixture guard.

**Interfaces:** `inspectPrincipalMigration({trustFile, inventoryFile})` returns a
sanitized report; script accepts exactly `--trust` and `--inventory` absolute paths.

- [x] Add fixtures for exact matches, legacy/missing/mismatched grants, bounded malformed
  inputs, unsafe files, CLI refusal, no mutation and no sensitive output; observe failure.
- [x] Implement using `loadPrincipalTrust`, `readAuthorityFile`, strict JSON and existing
  `HTTP_ACTIONS`; preserve all unverified/disabled markers even on exit zero.
- [x] Run focused tests, independent review, full npm test, pinned typecheck and diff checks.
- [x] Document exact command, exit semantics, isolated enrollment follow-up and platform limits;
  commit locally without operational or remote changes.

Execution evidence: [delivery report](../../reports/2026-10-30-staged-auth-preparation.md).
Pre-flight: one task, no shared interfaces. Builder and final review found no
production blocker. Review corrected test portability without altering the adapter's
existing unsupported-platform refusal; final preflight 11/11 and full suite
2,526 passed / zero failed / three skipped. No product-policy deviation was needed.
