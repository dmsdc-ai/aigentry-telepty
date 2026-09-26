'use strict';

// P2 fixture builder — TEST ONLY.
//
// This file is NEVER required by open-existing.cjs. The split is a reviewability aid (C3): the
// opener's import list makes it cheap to confirm it names no creation, write, migrate or repair
// entry point. It is NOT a proof of transitive filesystem behaviour.
//
// Every artifact is written to a directory the CALLER owns and supplies. There is no default
// path, no $HOME fallback, no mkdir and no temp-root creation here: the caller creates its own
// fs.mkdtempSync root (under P2_WORK_DIR / RUNNER_TEMP) and passes a directory that already
// exists. No live store is ever touched.
//
// All fixture content is deterministic — fixed literals only, no randomness, no clock, no pid.
// Two builds of the same id in two empty directories differ only by path.
//
// journal_mode is left at the SQLite default (`delete`) for every fixture and every handle is
// closed before the builder returns, so the opener never sees a hot -wal/-shm sidecar. P2
// therefore does not qualify a WAL store or a crash-interrupted store (§3).
//
// The exported surface is documented in output/FIXTURE-API.md. Expected ANSWERS are deliberately
// not exported: the tester writes its expected F1/F10 ledger literal independently of this file.

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3'); // pinned 13.0.3, default (creating) constructor

// Every fixture — SQLite, corrupt-bytes and legacy-JSON alike — is written at this name inside
// the supplied directory, so a caller can treat `buildFixture` uniformly.
const DB_FILENAME = 'conditional-admissions.sqlite3';

const FIXTURE_IDS = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10'];

// §3 schema, verbatim.
const SCHEMA_SQL = `
CREATE TABLE store_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE bindings        (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE admissions      (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE tombstones      (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE fenced_sessions (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
`;

// --- deterministic F1 values -------------------------------------------------------------
// uuid v4 shaped: matches the product's marker_id regex (version nibble 4, variant nibble 8).
const MARKER_ID = '9f8b7a6c-5d4e-4f3a-8b2c-1d0e9f8a7b6c';
// Canonical: new Date(x).toISOString() === x, as the product's predicate requires.
const INITIALIZED_AT = '2026-01-02T03:04:05.006Z';
const SCHEMA_VERSION = '1';
const GENERATION = '7';

// Rows are [key, valueText] pairs. valueText is stored EXACTLY as written here, so the tester can
// derive the parsed expectation from FIXTURE-API.md without importing anything.
const BINDINGS = [
  ['binding-alpha', '{"session_id":"sess-alpha","manifest_id":"mf-alpha","generation":1}'],
  ['binding-beta', '{"session_id":"sess-beta","manifest_id":"mf-beta","generation":2}'],
];
const ADMISSIONS = [
  ['admission-one', '{"task":"1170","attempt":1,"granted":true}'],
];
const TOMBSTONES = [
  ['tombstone-one', '{"revoked_at":"2026-01-02T03:04:05.006Z","reason":"superseded"}'],
];
const FENCED_SESSIONS = [
  ['fenced-one', '{"fenced_at":"2026-01-02T03:04:05.006Z","generation":7}'],
];

// F10: reserved-LOOKING keys are ordinary store data (C7). Values are ordinary JSON objects.
const RESERVED_KEY_BINDINGS = [
  ['__proto__', '{"kind":"proto-key","polluted":false}'],
  ['constructor', '{"kind":"constructor-key","polluted":false}'],
  ['prototype', '{"kind":"prototype-key","polluted":false}'],
];

// F6: a section row whose value is not JSON at all.
const NON_JSON_ADMISSIONS = [
  ['admission-one', 'this row value is not JSON'],
];

// F7: 16-byte SQLite header magic, then 4096 deterministic non-random bytes.
const CORRUPT_HEADER = 'SQLite format 3\0';
const CORRUPT_BODY_BYTES = 4096;
const corruptByte = index => (index * 31 + 7) & 0xff;

// F8: a legacy JSON store body, shaped exactly like the product's on-disk
// conditional-admissions.json (JSON.stringify(ledger, null, 2), no trailing newline).
function legacyJsonBody() {
  const section = rows => {
    const out = {};
    for (const [key, valueText] of rows) {
      Object.defineProperty(out, key, {
        value: JSON.parse(valueText), writable: true, enumerable: true, configurable: true,
      });
    }
    return out;
  };
  return JSON.stringify({
    schema_version: 1,
    generation: Number(GENERATION),
    marker: { marker_id: MARKER_ID, initialized_at: INITIALIZED_AT },
    bindings: section(BINDINGS),
    admissions: section(ADMISSIONS),
    tombstones: section(TOMBSTONES),
    fenced_sessions: section(FENCED_SESSIONS),
  }, null, 2);
}

// --- builders ----------------------------------------------------------------------------

function buildSqliteStore(dbPath, options) {
  const {
    schemaVersion = SCHEMA_VERSION,
    generation = GENERATION,
    markerId = MARKER_ID,
    initializedAt = INITIALIZED_AT,
    bindings = BINDINGS,
    admissions = ADMISSIONS,
    tombstones = TOMBSTONES,
    fencedSessions = FENCED_SESSIONS,
    dropBindings = false,
  } = options;

  const db = new Database(dbPath);
  try {
    db.exec(SCHEMA_SQL);
    const insert = table => db.prepare(`INSERT INTO ${table} (key, value) VALUES (?, ?)`);

    const meta = insert('store_meta');
    meta.run('schema_version', schemaVersion);
    meta.run('generation', generation);
    meta.run('marker_id', markerId);
    meta.run('initialized_at', initializedAt);

    for (const [table, rows] of [
      ['bindings', bindings], ['admissions', admissions],
      ['tombstones', tombstones], ['fenced_sessions', fencedSessions],
    ]) {
      const statement = insert(table);
      for (const [key, valueText] of rows) statement.run(key, valueText);
    }

    // Built complete, then dropped — the fixture is "a valid store with the bindings table
    // dropped", not a store that was never fully created.
    if (dropBindings) db.exec('DROP TABLE bindings');
  } finally {
    db.close();
  }
}

const BUILDERS = {
  F1: dbPath => buildSqliteStore(dbPath, {}),
  F2: dbPath => buildSqliteStore(dbPath, { schemaVersion: '2' }),
  F3: dbPath => buildSqliteStore(dbPath, { generation: '0' }),
  F4: dbPath => buildSqliteStore(dbPath, { dropBindings: true }),
  F5: dbPath => buildSqliteStore(dbPath, { markerId: 'not-a-uuid' }),
  F6: dbPath => buildSqliteStore(dbPath, { admissions: NON_JSON_ADMISSIONS }),
  F7: (dbPath) => {
    const body = Buffer.alloc(CORRUPT_BODY_BYTES);
    for (let index = 0; index < CORRUPT_BODY_BYTES; index += 1) body[index] = corruptByte(index);
    fs.writeFileSync(dbPath, Buffer.concat([Buffer.from(CORRUPT_HEADER, 'latin1'), body]));
  },
  F8: dbPath => fs.writeFileSync(dbPath, legacyJsonBody(), 'utf8'),
  // F9 is the absent-path fixture: it deliberately creates NOTHING. The caller's directory stays
  // empty, which is what makes the C1 inventory assertion meaningful.
  F9: () => {},
  F10: dbPath => buildSqliteStore(dbPath, { bindings: [...BINDINGS, ...RESERVED_KEY_BINDINGS] }),
};

/**
 * Build fixture `id` inside the caller-owned directory `dirPath`.
 *
 * @param {string} id one of FIXTURE_IDS.
 * @param {string} dirPath an EXISTING directory the caller owns. Not created here, never $HOME.
 * @returns {string} the absolute path the opener should be pointed at
 *                   (path.join(dirPath, DB_FILENAME)) — for F9 no file exists there.
 * @throws {TypeError} on an unknown id or a non-string dirPath. Never throws to signal a fixture
 *                     state: every fixture below is built successfully, including the invalid and
 *                     corrupt ones.
 */
function buildFixture(id, dirPath) {
  if (!Object.hasOwn(BUILDERS, id)) {
    throw new TypeError(`unknown fixture id: ${String(id)} (expected one of ${FIXTURE_IDS.join(', ')})`);
  }
  if (typeof dirPath !== 'string' || dirPath === '') {
    throw new TypeError('dirPath must be a non-empty string naming an existing caller-owned directory');
  }
  const dbPath = path.join(dirPath, DB_FILENAME);
  BUILDERS[id](dbPath);
  return dbPath;
}

module.exports = { buildFixture, FIXTURE_IDS, DB_FILENAME };
