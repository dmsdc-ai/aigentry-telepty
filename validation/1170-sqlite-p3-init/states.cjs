"use strict";

// P3 synthetic pre-existing states - FIXTURE WRITER, TEST ONLY.
//
// K3 scopes the single-writer oracle to the RUNTIME leaf: this file DOES write, by design, as a
// declared fixture writer confined to roots the caller owns. It is NEVER required by
// init-exclusive.cjs and NEVER required by race-child.cjs, so the slice under test stays
// unreachable from every fixture.
//
// Each state is written into a storeRoot this module creates with ONE non-recursive mkdirSync
// inside a parent the CALLER already created and owns - except kind "root-file", where
// storeRoot is written as a regular file instead. No parent is ever created, no recursive mkdir
// is used, there is no default path and no $HOME fallback, and no live store is ever touched.
//
// All content is deterministic: fixed literals and caller-supplied values only, no randomness,
// no clock, no pid. journal_mode is left at the SQLite default (delete) and every handle is
// closed before a builder returns, so this file leaves no hot sidecar behind. The hot -journal
// K1 measures is produced by an interrupted initializer, never here.
//
// Expected ANSWERS are deliberately NOT exported: createState returns the dbPath only, never an
// expected ledger. The tester authors its expected literal independently from the contract
// prose, so a passing oracle cannot mean self-agreement.

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3"); // pinned 13.0.3, default creating constructor

const DB_FILENAME = "conditional-admissions.sqlite3";
const JOURNAL_SUFFIX = "-journal";

// N1..N6 in order: complete valid store, zero-byte db, corrupt bytes, orphan sidecar, legacy
// JSON body, storeRoot present as a regular file.
const STATE_KINDS = ["valid", "zero", "corrupt", "orphan-journal", "legacy-json", "root-file"];

// P2-CONTRACT section 3 schema, verbatim.
const SCHEMA_SQL = `
CREATE TABLE store_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE bindings        (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE admissions      (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE tombstones      (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE fenced_sessions (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
`;

const SCHEMA_VERSION_TEXT = "1";
const DEFAULT_GENERATION = 1;

// Reproduced from the P2 F7 body: the 16-byte SQLite header magic, then 4096 deterministic
// non-random bytes.
const CORRUPT_HEADER = "SQLite format 3\0";
const CORRUPT_BODY_BYTES = 4096;
const corruptByte = index => (index * 31 + 7) & 0xff;

// A rollback-journal header magic, then deterministic filler. N4 needs an ORPHAN sidecar: a
// -journal with no database file beside it.
const JOURNAL_HEADER = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);
const JOURNAL_BODY_BYTES = 512;
const journalByte = index => (index * 17 + 3) & 0xff;

// N6: storeRoot itself is a regular FILE, so the claim fails on the root name rather than on
// anything inside it - and because the contents are never read, N6 refuses with the same
// envelope as every other pre-existing state.
const ROOT_FILE_BODY = "p3 synthetic state: storeRoot is a regular file, not a directory\n";

// One non-recursive create, exactly as the slice claims its own root. The parent belongs to the
// caller and is never created here.
function claimStoreRootDirectory(storeRoot) {
  fs.mkdirSync(storeRoot);
}

// Structural only: a fixture marker is NOT required to satisfy the product predicate, because
// K2 deliberately uses a marker the store under comparison does not carry.
function requireMarker(marker, kind) {
  if (!marker || typeof marker !== "object" || typeof marker.marker_id !== "string"
    || typeof marker.initialized_at !== "string") {
    throw new TypeError(
      `state kind ${kind} records a marker: pass { marker: { marker_id, initialized_at } }`,
    );
  }
  return marker;
}

// P2 F8 shape: a legacy JSON store body written exactly as the product wrote
// conditional-admissions.json - JSON.stringify(ledger, null, 2), no trailing newline. Sections
// are empty, matching the "valid" kind; N5 asserts only the EEXIST refusal and byte identity,
// and the slice never reads this body.
function legacyJsonBody(marker, generation) {
  return JSON.stringify({
    schema_version: 1,
    generation,
    marker: { marker_id: marker.marker_id, initialized_at: marker.initialized_at },
    bindings: {},
    admissions: {},
    tombstones: {},
    fenced_sessions: {},
  }, null, 2);
}

function buildValid({ storeRoot, dbPath, marker, generation }) {
  requireMarker(marker, "valid");
  claimStoreRootDirectory(storeRoot);
  const db = new Database(dbPath);
  try {
    db.exec(SCHEMA_SQL);
    const insertMeta = db.prepare("INSERT INTO store_meta (key, value) VALUES (?, ?)");
    insertMeta.run("schema_version", SCHEMA_VERSION_TEXT);
    insertMeta.run("generation", String(generation));
    insertMeta.run("marker_id", marker.marker_id);
    insertMeta.run("initialized_at", marker.initialized_at);
    // Sections stay EMPTY, so a complete valid store here carries the same shape an initialized
    // store carries and differs only in the marker and generation the caller supplied. K2 uses
    // this kind with a different marker, or with a generation above 1.
  } finally {
    db.close();
  }
}

function buildZero({ storeRoot, dbPath }) {
  claimStoreRootDirectory(storeRoot);
  fs.writeFileSync(dbPath, Buffer.alloc(0));
}

function buildCorrupt({ storeRoot, dbPath }) {
  claimStoreRootDirectory(storeRoot);
  const body = Buffer.alloc(CORRUPT_BODY_BYTES);
  for (let index = 0; index < CORRUPT_BODY_BYTES; index += 1) body[index] = corruptByte(index);
  fs.writeFileSync(dbPath, Buffer.concat([Buffer.from(CORRUPT_HEADER, "latin1"), body]));
}

function buildOrphanJournal({ storeRoot, dbPath }) {
  claimStoreRootDirectory(storeRoot);
  const body = Buffer.alloc(JOURNAL_BODY_BYTES);
  for (let index = 0; index < JOURNAL_BODY_BYTES; index += 1) body[index] = journalByte(index);
  // Only the sidecar: no database file is written beside it.
  fs.writeFileSync(dbPath + JOURNAL_SUFFIX, Buffer.concat([JOURNAL_HEADER, body]));
}

function buildLegacyJson({ storeRoot, dbPath, marker, generation }) {
  requireMarker(marker, "legacy-json");
  claimStoreRootDirectory(storeRoot);
  fs.writeFileSync(dbPath, legacyJsonBody(marker, generation), "utf8");
}

function buildRootFile({ storeRoot }) {
  // No mkdir at all: storeRoot IS the file. Its parent is supplied by the caller and already
  // exists, exactly as for every other kind.
  fs.writeFileSync(storeRoot, ROOT_FILE_BODY, "utf8");
}

const BUILDERS = {
  valid: buildValid,
  zero: buildZero,
  corrupt: buildCorrupt,
  "orphan-journal": buildOrphanJournal,
  "legacy-json": buildLegacyJson,
  "root-file": buildRootFile,
};

/**
 * Create one synthetic pre-existing state at `storeRoot`.
 *
 * @param {string} storeRoot absolute path inside a parent the caller already created and owns.
 * @param {string} kind one of STATE_KINDS.
 * @param {{marker?: object, generation?: number}} options marker is required by the kinds that
 *        record one ("valid" and "legacy-json") and generation defaults to 1. Both are IGNORED
 *        by "zero", "corrupt", "orphan-journal" and "root-file", whose bytes record neither.
 * @returns {string} path.join(storeRoot, DB_FILENAME), uniformly for every kind - for
 *        "orphan-journal" and "root-file" NO file exists at that path.
 * @throws {TypeError} on an unknown kind, a non-string storeRoot, or a missing marker for a
 *        kind that records one. Never throws to signal a state: every state below is built
 *        successfully, the corrupt and legacy ones included.
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

module.exports = { createState, STATE_KINDS, DB_FILENAME, JOURNAL_SUFFIX };
