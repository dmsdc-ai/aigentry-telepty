'use strict';
// Observation only: no lock acquisition, pruning, initialization or migration.
const fs = require('node:fs');
const path = require('node:path');
const { checkRoot, resolveSessionDir, validateSessionId } = require('./path-boundary');
const same = (a, b) => a === null && b === null || !!a && !!b &&
  ['dev','ino','size','nlink','mtimeMs','ctimeMs'].every(key => a[key] === b[key]);
function optionalStat(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function inspectMailboxCompatibility(root, {entryBudget = 1000} = {}) {
  if (!Number.isSafeInteger(entryBudget) || entryBudget < 1 || entryBudget > 10000) throw new Error('Invalid entry budget');
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('An explicit absolute mailbox root is required');
  checkRoot(root);
  const before = fs.lstatSync(root);
  const report = {schema:'telepty.mailbox-compatibility/v1',root,mutated:false,migration_permitted:false,
    writer_quiescence:'unverified',external_client_compatibility:'unverified',complete:true,sessions:[]};
  let remaining = entryBudget;
  function boundedNames(dir) {
    const stream = fs.opendirSync(dir), names = [];
    try {
      for (let entry; (entry = stream.readSync());) {
        if (--remaining < 0) throw Object.assign(new Error('Entry budget reached'), {code:'INSPECTION_BUDGET'});
        names.push(entry.name);
      }
    } finally { stream.closeSync(); }
    return names.sort();
  }
  try {
    for (const id of boundedNames(root)) {
      const row = {session_id:id,lock_format:'unknown',holder_state:'unknown',acquisition_entries:null};
      try {
        validateSessionId(id);
        const dir = resolveSessionDir(root,id), initial = fs.lstatSync(dir);
        if (!initial.isDirectory() || initial.isSymbolicLink()) throw Object.assign(new Error(),{code:'MAILBOX_UNSAFE_PATH'});
        const file = path.join(dir,'.lock'), lock = optionalStat(file);
        if (!lock) row.lock_format = 'absent';
        else if (lock.isFile() && !lock.isSymbolicLink() && lock.nlink === 1) row.lock_format = 'legacy_file';
        else if (lock.isDirectory() && !lock.isSymbolicLink()) {
          const names = boundedNames(file);
          let valid = true;
          for (const name of names) {
            if (!/^[1-9][0-9]*-[a-f0-9]{32}$/.test(name) || !Number.isSafeInteger(Number(name.split('-')[0]))
                || Number(name.split('-')[0]) > 0x7fffffff) { valid = false; break; }
            const st = optionalStat(path.join(file,name));
            if (!st || !st.isDirectory() || st.isSymbolicLink()) { valid = false; break; }
          }
          row.lock_format = valid ? 'v2_directory_observed' : 'unknown_directory';
          row.acquisition_entries = valid ? names.length : null;
        } else row.lock_format = 'unsafe';
        if (!same(initial,optionalStat(dir)) || !same(lock,optionalStat(file))) {
          row.lock_format='changing';row.acquisition_entries=null;
        }
      } catch (error) {
        if (error.code === 'INSPECTION_BUDGET') throw error;
        row.lock_format = error.code === 'MAILBOX_UNSAFE_PATH' || error.code === 'MAILBOX_INVALID_SESSION_ID' ? 'unsafe' : 'unknown';
      }
      report.sessions.push(row);
      if (['unknown','unknown_directory','unsafe','changing'].includes(row.lock_format)) {
        report.complete=false;report.reason='unsafe_or_unavailable_entries';
      }
    }
    checkRoot(root);
    if (!same(before,optionalStat(root))) { report.complete=false;report.reason='changed_during_inspection'; }
  } catch (error) {
    report.complete=false;
    report.reason=error.code === 'INSPECTION_BUDGET' ? 'entry_budget' : 'unavailable_or_changed';
  }
  return report;
}
module.exports={inspectMailboxCompatibility};
