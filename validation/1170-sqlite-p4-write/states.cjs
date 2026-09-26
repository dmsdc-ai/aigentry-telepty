"use strict";

// P4 pre-existing store states - FIXTURE WRITER, TEST ONLY.
//
// W9 scopes the single-writer oracle to the RUNTIME leaf: this file DOES write, by design, as a
// declared fixture writer confined to roots the caller owns. It is NEVER required by
// write-cas.cjs and NEVER required by write-child.cjs, so the slice under test stays unreachable
// from every fixture. A fixture writer is NOT the runtime writer, and nothing here is a product
// initialize, repair or migrate path.
//
// Each root is created inside a parent the CALLER already created and owns. No parent is ever
// created, no recursive create is used, there is no default path and no $HOME fallback, and NO
// LIVE STORE IS EVER TOUCHED.
//
// All content is deterministic: fixed literals and caller-supplied values only - no randomness,
// no clock, no pid. The journal mode is left at the SQLite default and every handle is closed
// before a builder returns, so this file leaves no hot sidecar behind. The hot journal W7
// measures is produced by an interrupted writer, never here.
//
// Expected ANSWERS are deliberately NOT exported: createState returns the dbPath only, never an
// expected ledger. The tester authors its expected literals independently from the contract
// prose, so a passing oracle cannot mean self-agreement.

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3"); // pinned 13.0.3, default creating constructor

// The P3 initializer, mechanically copied in by the CI byte-identity step and verified identical
// there. The "valid" kind delegates to it so that a valid P4 fixture is produced by the exact
// bytes P3 measured, never by a second re-implementation of the schema.
const { initializeExperimentalSqliteStore } = require("./p3-init-exclusive.cjs");

const DB_FILENAME = "conditional-admissions.sqlite3";

// W5 (b), (c), (d) and the W1/W2/W4/W6/W7/W10/W12 base store, in that vocabulary:
//   valid       - a complete initialized store at the requested generation
//   corrupt     - the P2 F7 body: SQLite header magic followed by deterministic non-random bytes
//   legacy-json - the P2 F8 body: the legacy JSON ledger the product used to write
//   empty-root  - an existing store root with NO database file inside it
// W5 (a) needs no fixture at all - the tester names a root it never creates - and W5 (e) is a
// parent-permission arrangement the tester owns, not a store body.
const STATE_KINDS = ["valid", "corrupt", "legacy-json", "empty-root"];

const SCHEMA_VERSION_VALUE = 1;
const DEFAULT_GENERATION = 1;

// The initializer accepts the number 0 and nothing else: the caller declares that it initializes
// from nothing. The initialized result is generation 1.
const REQUIRED_INITIAL_GENERATION = 0;

// A SYNTHETIC test precondition, NOT production authentication proof: no real credential,
// account, network or live store is involved. Deterministic, so two fixtures never differ by it.
const FIXTURE_INIT_INTENT = {
  declaredBy: "validation-1170-sqlite-p4-write",
  requestId: "p4-fixture-init",
  authority: "isolated-experiment-fixture",
};

// Reproduced from the P2 F7 body: the 16-byte SQLite header magic, then 4096 deterministic
// non-random bytes.
const CORRUPT_HEADER = "SQLite format 3\0";
const CORRUPT_BODY_BYTES = 4096;
const corruptByte = index => (index * 31 + 7) & 0xff;

// One non-recursive create. The parent belongs to the caller and is never created here. The
// recursive option is FORBIDDEN: it succeeds on an existing directory and would silently adopt a
// root this module does not own.
function claimStoreRootDirectory(storeRoot) {
  fs.mkdirSync(storeRoot);
}

// Structural only: a fixture marker is NOT required to satisfy the product predicate for the
// kinds that merely record one, because W4 deliberately builds a store carrying a marker the
// writer under test will not supply. The "valid" kind is the exception - the initializer applies
// the real predicate to it and refuses a marker that fails.
function requireMarker(marker, kind) {
  if (!marker || typeof marker !== "object" || typeof marker.marker_id !== "string"
    || typeof marker.initialized_at !== "string") {
    throw new TypeError(
      `state kind ${kind} records a marker: pass { marker: { marker_id, initialized_at } }`,
    );
  }
  return marker;
}

function requireGeneration(generation, kind) {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new TypeError(
      `state kind ${kind} records a generation: pass a safe integer >= 1, received ${String(generation)}`,
    );
  }
  return generation;
}

// P2 F8 shape: the legacy JSON store body written exactly as the product wrote
// conditional-admissions.json - JSON.stringify(ledger, null, 2), no trailing newline. Sections are
// empty, matching the "valid" kind. The slice under test never reads this body; it is here so W5
// can show that a JSON body is refused rather than adopted, migrated or overwritten.
function legacyJsonBody(marker, generation) {
  return JSON.stringify({
    schema_version: SCHEMA_VERSION_VALUE,
    generation,
    marker: { marker_id: marker.marker_id, initialized_at: marker.initialized_at },
    bindings: {},
    admissions: {},
    tombstones: {},
    fenced_sessions: {},
  }, null, 2);
}

// FIXTURE-ONLY generation override, recorded here as exactly that.
//
// The initializer produces generation 1 and nothing else, by design. W6, W7 and the W10 family
// need a base store at a controlled generation g above 1, so this function performs one direct
// bound update of the single store_meta generation row on a store this module just created and
// owns. It is NOT a second initializer, NOT a migration, NOT a repair, and NOT reachable from the
// slice under test: it edits a fixture, never operating data, and it is deliberately the ONLY
// write in this module that touches an already-initialized store. The initializer is still the
// thing that created every byte of schema and metadata around it.
function applyFixtureOnlyGenerationOverride(dbPath, generation) {
  const db = new Database(dbPath);
  try {
    const updated = db.prepare(`UPDATE store_meta SET value = ? WHERE key = ?`)
      .run(String(generation), "generation");
    if (updated.changes !== 1) {
      throw new Error(
        `fixture generation override expected exactly 1 changed row, observed ${updated.changes}`,
      );
    }
  } finally {
    db.close();
  }
}

// The initializer creates storeRoot itself with its own single non-recursive create - that create
// IS its claim - so this builder must NOT create the root first.
function buildValid({ storeRoot, dbPath, marker, generation }) {
  requireMarker(marker, "valid");
  requireGeneration(generation, "valid");
  const result = initializeExperimentalSqliteStore(storeRoot, {
    marker,
    initIntent: FIXTURE_INIT_INTENT,
    initialGeneration: REQUIRED_INITIAL_GENERATION,
  });
  if (!result || result.ok !== true) {
    // A refused initializer is a FIXTURE BUILD FAILURE and is thrown, never returned as though it
    // were a state the tester asked for.
    const reason = result && result.reason ? result.reason : "unknown";
    throw new Error(`fixture kind valid could not be initialized: ${reason}`);
  }
  if (generation !== 1) applyFixtureOnlyGenerationOverride(dbPath, generation);
}

function buildCorrupt({ storeRoot, dbPath }) {
  claimStoreRootDirectory(storeRoot);
  const body = Buffer.alloc(CORRUPT_BODY_BYTES);
  for (let index = 0; index < CORRUPT_BODY_BYTES; index += 1) body[index] = corruptByte(index);
  fs.writeFileSync(dbPath, Buffer.concat([Buffer.from(CORRUPT_HEADER, "latin1"), body]));
}

function buildLegacyJson({ storeRoot, dbPath, marker, generation }) {
  requireMarker(marker, "legacy-json");
  requireGeneration(generation, "legacy-json");
  claimStoreRootDirectory(storeRoot);
  fs.writeFileSync(dbPath, legacyJsonBody(marker, generation), "utf8");
}

// W5 (b): the root exists and is owned, and there is no database file inside it. Nothing else is
// written, so the directory inventory the tester records afterwards is exactly empty.
function buildEmptyRoot({ storeRoot }) {
  claimStoreRootDirectory(storeRoot);
}

const BUILDERS = {
  valid: buildValid,
  corrupt: buildCorrupt,
  "legacy-json": buildLegacyJson,
  "empty-root": buildEmptyRoot,
};

/**
 * Create one pre-existing store state at `storeRoot`.
 *
 * @param {string} storeRoot absolute path inside a parent the caller already created and owns.
 *        This directory must NOT exist: every kind creates it, and no kind adopts, reads, repairs
 *        or removes an existing one.
 * @param {string} kind one of STATE_KINDS.
 * @param {{marker?: object, generation?: number}} options marker is required by the kinds that
 *        record one ("valid" and "legacy-json") and generation defaults to 1. Both are IGNORED by
 *        "corrupt" and "empty-root", whose bytes record neither.
 * @returns {string} path.join(storeRoot, DB_FILENAME), uniformly for every kind - for
 *        "empty-root" NO file exists at that path. The dbPath is the ONLY thing returned: no
 *        expected ledger, no expected generation and no expected inventory is ever handed back,
 *        so no oracle can check a fixture against the fixture builder.
 * @throws {TypeError} on an unknown kind, a non-string storeRoot, a missing marker or an invalid
 *        generation for a kind that records one.
 * @throws {Error} when the copied initializer refuses to build the "valid" kind.
 */
function createState(storeRoot, kind, options) {
  if (!Object.hasOwn(BUILDERS, kind)) {
    throw new TypeError(
      `unknown state kind: ${String(kind)} (expected one of ${STATE_KINDS.join(", ")})`,
    );
  }
  if (typeof storeRoot !== "string" || storeRoot === "") {
    throw new TypeError(
      "storeRoot must be a non-empty string inside an existing caller-owned parent directory",
    );
  }
  const settings = options === undefined || options === null ? {} : options;
  const { marker, generation = DEFAULT_GENERATION } = settings;
  const dbPath = path.join(storeRoot, DB_FILENAME);
  BUILDERS[kind]({ storeRoot, dbPath, marker, generation });
  return dbPath;
}

module.exports = { createState, STATE_KINDS, DB_FILENAME };
