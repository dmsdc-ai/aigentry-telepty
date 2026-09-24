'use strict';

// P2 experimental read-only opener for an ALREADY EXISTING SQLite conditional-admission store.
//
// Contract: input/P2-CONTRACT.md as amended by input/P2-CORRECTIONS.md (the corrections win on
// every contradictory phrase). This file is EXPERIMENTAL. Nothing in the product imports it, it
// is not a production adapter, and it is not caller parity with
// src/session-store/persistence.js#loadConditionalAdmissions — only the mappings enumerated
// below are claimed. Per C2 the returned `reason`/`detail` strings are experimental identifiers
// for this prototype only; no product refusal string is changed, added or removed by it.
//
// Deliberately absent, per §5 / §7 / C1 / C3:
//   - no write, create, initialize, migrate, repair or fallback path of any kind;
//   - no pre-open stat/lstat/access/existsSync probe on dbPath (C1: that is a TOCTOU window,
//     and the single native open() without SQLITE_OPEN_CREATE is the whole mechanism);
//   - no `node:fs` / `node:path` / product import at all — the only dependency is the pinned
//     native binding;
//   - no default path: dbPath is always supplied by the caller. There is no $HOME default and
//     no read of a real user store.
//
// Scope of what a green run of this file could support (C1/C3): a missing path is refused with a
// generic SQLITE_CANTOPEN and nothing is created there — which does NOT establish that the path
// was absent rather than inaccessible, and licenses no initialize decision. Byte identity across
// a read is an observation, NOT a zero-write filesystem proof.

const Database = require('better-sqlite3'); // pinned 13.0.3

// §3 storage format. Table names are module constants and are never taken from store data.
const SECTION_TABLES = ['bindings', 'admissions', 'tombstones', 'fenced_sessions'];
const STORE_META_TABLE = 'store_meta';

// §5: the reconstructed ledger has EXACTLY 7 keys and Object.keys() reports them in this order:
//   schema_version, generation, marker, bindings, admissions, tombstones, fenced_sessions.
// The order is produced by the defineOwn sequence at the end of loadConditionalAdmissionsSqlite;
// it is deliberately not a const here, so the tester cannot import the expectation it checks.

// store_meta holds TEXT (§3). The product's ledger holds the NUMBER 1
// (persistence.js CONDITIONAL_ADMISSIONS_SCHEMA_VERSION = 1), so the accepted text is '1' and
// the reconstructed value is 1. The refusal detail reports the raw stored text, as the product
// reports its raw parsed value.
const SCHEMA_VERSION_TEXT = '1';
const SCHEMA_VERSION_VALUE = 1;

// Canonical decimal digits only. This regex is the guard the dispatch calls for: it is what
// stops a missing ('' / absent), empty, signed, padded-with-space, fractional ('1.5'),
// exponential ('1e3') or otherwise non-integer generation from being coerced by Number() into an
// accepted integer. Range and safety are then checked separately.
const GENERATION_TEXT = /^[0-9]+$/;

// Byte-for-byte the product's marker_id predicate (persistence.js#validConditionalMarker).
const MARKER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// C7. Row keys are ARBITRARY STORE DATA. Plain `obj[key] = value` would, for key '__proto__',
// invoke the Object.prototype setter and mutate the prototype instead of storing the row —
// silently losing data. defineProperty on a {} literal stores it as an own enumerable property
// while keeping Object.prototype as the prototype, exactly as JSON.parse does for the product's
// JSON store (Object.create(null) would be safe but not prototype-identical, failing C2).
function defineOwn(target, key, value) {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  return target;
}

// Own-property read: `meta.constructor` must never fall through to Object.prototype when the
// store happens not to carry that row.
function ownValue(map, key) {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

function unavailable(detail) {
  return { ok: false, reason: 'conditional_store_unavailable', detail };
}

// §5 last table row: "any other throw" is the only case carrying `error`.
function unexpected(error) {
  return { ok: false, reason: 'conditional_store_unavailable', detail: 'unparseable', error };
}

// Distinguishes a row whose value is not JSON from a SQLite-level failure.
class RowValueNotJsonError extends Error {}

// C1: a generic SQLITE_CANTOPEN is NOT positive proof of absence — the same primary code covers a
// denied path, an unreadable directory, an invalid or over-long path and a path that is a
// directory. It therefore maps to unavailable/open_failed_unknown and MUST NOT emit
// conditional_store_not_initialized, which is read downstream as "initialize now".
// Only primary codes are matched; no extended result code was measured on any runner, so an
// extended code is not silently treated as its primary (it falls through to the generic branch).
function classifyOpenError(error) {
  const code = error && error.code;
  if (code === 'SQLITE_CANTOPEN') return unavailable('open_failed_unknown');
  if (code === 'SQLITE_NOTADB' || code === 'SQLITE_CORRUPT') return unavailable('unparseable');
  return unexpected(error);
}

function classifyReadError(error) {
  if (error instanceof RowValueNotJsonError) return unavailable('invalid_store_shape');
  const code = error && error.code;
  if (code === 'SQLITE_ERROR') return unavailable('invalid_store_shape'); // missing table / column
  if (code === 'SQLITE_NOTADB' || code === 'SQLITE_CORRUPT') return unavailable('unparseable');
  return unexpected(error);
}

// §3: store_meta values are TEXT and are NOT JSON — they are read raw.
function readStoreMeta(db) {
  const meta = {};
  for (const row of db.prepare(`SELECT key, value FROM ${STORE_META_TABLE} ORDER BY key`).all()) {
    defineOwn(meta, row.key, row.value);
  }
  return meta;
}

// ORDER BY key uses the TEXT PRIMARY KEY index, so reconstruction is deterministic across
// runners without a sort step.
function readSection(db, table) {
  const section = {};
  for (const row of db.prepare(`SELECT key, value FROM ${table} ORDER BY key`).all()) {
    let value;
    try {
      value = JSON.parse(row.value);
    } catch {
      // The bad row is named as a shape failure, never skipped (§6 C7).
      throw new RowValueNotJsonError();
    }
    defineOwn(section, row.key, value);
  }
  return section;
}

// C7 "no stricter validation is introduced": the source establishes object-ness checks only
// (persistence.js L357-362) and no constraint on section KEYS, so '__proto__', 'constructor' and
// 'prototype' are ordinary data and are preserved. No key filtering, no allowlist, no domain
// validation of binding/admission payloads, and no row-value schema beyond "is JSON" is added.

function decodeGeneration(text) {
  if (typeof text !== 'string' || !GENERATION_TEXT.test(text)) return null;
  const generation = Number(text);
  // Number.isSafeInteger also rejects a digit string above 2^53-1, which Number() would have
  // rounded into a finite integer.
  if (!Number.isSafeInteger(generation) || generation < 1) return null;
  return generation;
}

// Same predicate as the product's validConditionalMarker, reimplemented rather than imported
// (no product import, §2). The marker object is built with exactly the two keys the predicate
// requires, so the length check below is structural rather than defensive.
function validConditionalMarker(marker) {
  return marker && typeof marker === 'object' && !Array.isArray(marker)
    && Object.keys(marker).length === 2
    && typeof marker.marker_id === 'string'
    && MARKER_ID.test(marker.marker_id)
    && typeof marker.initialized_at === 'string'
    && Number.isFinite(Date.parse(marker.initialized_at))
    && new Date(marker.initialized_at).toISOString() === marker.initialized_at;
}

/**
 * Open an already existing SQLite conditional-admission store, read only.
 *
 * @param {string} dbPath absolute path supplied by the caller; never defaulted, never $HOME.
 * @returns {{ok: true, ledger: object} | {ok: false, reason: string, detail?: string, error?: Error}}
 *
 * Enumerated mappings (the complete list of what is CLAIMED, not a model of the product):
 *   generic SQLITE_CANTOPEN at open        -> unavailable / open_failed_unknown   (C1)
 *   SQLITE_NOTADB | SQLITE_CORRUPT         -> unavailable / unparseable
 *   missing table or column (SQLITE_ERROR) -> unavailable / invalid_store_shape
 *   schema_version text !== '1'            -> unavailable / schema_version=<raw text>
 *   generation absent / non-canonical / non-safe-integer / < 1
 *                                          -> unavailable / invalid_store_shape
 *   marker fails validConditionalMarker    -> unavailable / marker_invalid
 *   a section row value is not JSON        -> unavailable / invalid_store_shape
 *   any other throw                        -> unavailable / unparseable + error
 */
function loadConditionalAdmissionsSqlite(dbPath) {
  let db;
  try {
    // §4, exact. readonly:true -> SQLITE_OPEN_READONLY, and neither option adds
    // SQLITE_OPEN_CREATE (database.cpp JS_new). fileMustExist:true is ignored in the mask while
    // readonly is true (the source ternary short-circuits); it is retained as intent
    // documentation so the call site reads "existing store, read only", not as a second
    // mechanism. No timeout, verbose, nativeBinding, and no PRAGMA is ever issued.
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (error) {
    // Nothing to close: the handle was never constructed.
    return classifyOpenError(error);
  }

  try {
    const meta = readStoreMeta(db);

    const schemaVersionText = ownValue(meta, 'schema_version');
    if (schemaVersionText !== SCHEMA_VERSION_TEXT) {
      // Absent row reports schema_version=undefined, mirroring the product's own template over
      // an absent parsed.schema_version.
      return unavailable(`schema_version=${schemaVersionText}`);
    }

    const generation = decodeGeneration(ownValue(meta, 'generation'));
    if (generation === null) return unavailable('invalid_store_shape');

    // Sections are read before the marker check so that a missing table (invalid_store_shape)
    // outranks a marker verdict, matching the product's order (shape, then marker).
    const sections = [];
    for (const table of SECTION_TABLES) sections.push(readSection(db, table));

    const marker = {};
    defineOwn(marker, 'marker_id', ownValue(meta, 'marker_id'));
    defineOwn(marker, 'initialized_at', ownValue(meta, 'initialized_at'));
    // C2: 'marker_invalid' is a NEW, P2-experimental string the product never produces. P2 holds
    // the marker in one artifact and therefore has no analogue for marker_store_mismatch.
    if (!validConditionalMarker(marker)) return unavailable('marker_invalid');

    const ledger = {};
    defineOwn(ledger, 'schema_version', SCHEMA_VERSION_VALUE);
    defineOwn(ledger, 'generation', generation);
    defineOwn(ledger, 'marker', marker);
    SECTION_TABLES.forEach((table, index) => defineOwn(ledger, table, sections[index]));

    return { ok: true, ledger };
  } catch (error) {
    return classifyReadError(error);
  } finally {
    // §4: every handle is closed in a finally before any further work. Rows are already
    // materialised by .all(), so closing cannot affect the returned value. A close failure is
    // swallowed so it cannot mask the result computed above.
    try { db.close(); } catch { /* handle already closed or closing failed; result stands */ }
  }
}

// §5 "exports exactly": one function, nothing else. LEDGER_KEYS stays module-private on purpose
// — the tester's 7-key expectation must be written independently, not imported from the file
// under test.
module.exports = { loadConditionalAdmissionsSqlite };
