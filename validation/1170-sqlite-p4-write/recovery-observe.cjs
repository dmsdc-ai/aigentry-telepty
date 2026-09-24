"use strict";

// P4 TESTER-LANE RECOVERY OBSERVER - P4-CONTRACT.md section 9 / R2-2.
//
// R2-2 replaces the v1 W7 sentence "A fresh writer then reopens read-write". A killed writer
// returns nothing, and this slice performs no recovery: the W7 reopen is performed HERE, in the
// tester lane, by a file whose entire body is one read-write open followed by one close.
//
// Deliberately absent, and asserted absent by W9:
//   - no statement of any kind: no SELECT, no INSERT, no UPDATE, no DDL;
//   - no PRAGMA, no transaction, no BEGIN, no COMMIT, no ROLLBACK;
//   - no call to applyExperimentalStoreMutation and no require of write-cas.cjs;
//   - no unlink, rm, truncate, rename, mkdir or any other filesystem mutation;
//   - no repair SQL. If opening and closing alone does NOT bring the store back to a state the
//     independent P2 opener accepts, that is a FAILED ORACLE to be reported verbatim, never a
//     licence to add a repair statement here.
//
// What a rollback-journal playback does on this open is SQLite behaviour OBSERVED, not a repair
// this lane performs or claims, and it decides nothing about D2 (journal policy stays open).
// This file is NOT a product repair endpoint, is not exported by the slice, and is never
// required by write-cas.cjs or write-child.cjs.

const Database = require("better-sqlite3"); // pinned 13.0.3

// Codes only - never a message. R2-7: no verdict is derived from a thrown error message.
function faultFacts(error) {
  if (!error) return null;
  return {
    name: typeof error.name === "string" ? error.name : null,
    code: typeof error.code === "string" && error.code !== "" ? error.code : null,
    errno: error.errno === undefined ? null : error.errno,
    syscall: typeof error.syscall === "string" ? error.syscall : null,
  };
}

/**
 * Open an existing store read-write and close it again. Nothing else.
 *
 * @param {string} dbPath absolute path supplied by the caller; never defaulted, never $HOME.
 * @returns {{dbPath: string, opened: boolean, closed: boolean,
 *            openError: object|null, closeError: object|null, note: string}}
 *          The record is an OBSERVATION. It carries no reason code, no committed value and no
 *          retrySafe value, because this file is not the mutation API and observes no write.
 */
function observeRecoveryOpen(dbPath) {
  const record = {
    dbPath,
    opened: false,
    closed: false,
    openError: null,
    closeError: null,
    note: "read-write open + close only; any journal playback is SQLite behaviour observed, "
      + "not a repair performed or claimed here",
  };

  let db;
  try {
    db = new Database(dbPath, { fileMustExist: true, timeout: 0 });
    record.opened = true;
  } catch (error) {
    // Nothing to close: the handle was never constructed. A failed open is recorded, never
    // retried, never worked around.
    record.openError = faultFacts(error);
    return record;
  }

  try {
    db.close();
    record.closed = true;
  } catch (error) {
    record.closeError = faultFacts(error);
  }
  return record;
}

module.exports = { observeRecoveryOpen };
