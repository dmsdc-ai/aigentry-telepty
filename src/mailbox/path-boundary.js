'use strict';

const fs = require('fs');
const path = require('path');
const LEAVES = ['inbox.jsonl', 'state.jsonl', 'dead-letter.jsonl', '.lock'];

function unsafePath() {
  return Object.assign(new Error('Unsafe mailbox storage path'), { code: 'MAILBOX_UNSAFE_PATH' });
}

function validateSessionId(id) {
  if (typeof id !== 'string' || !id || Buffer.byteLength(id, 'utf8') > 128 ||
      /[\x00-\x1f\x7f-\x9f/\\]/.test(id) || id === '.' || id === '..' ||
      /^[a-z]:/i.test(id) || path.posix.isAbsolute(id) || path.win32.isAbsolute(id)) {
    throw Object.assign(new Error('Invalid mailbox session identifier'), { code: 'MAILBOX_INVALID_SESSION_ID' });
  }
  // These spellings have filesystem-specific aliases/stream semantics on Windows.
  if (process.platform === 'win32' &&
      (/[<>:"|?*]/.test(id) || /[. ]$/.test(id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id))) {
    throw unsafePath();
  }
}

function lstatOptional(p) {
  try { return fs.lstatSync(p); } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function checkRoot(root) {
  const st = lstatOptional(root);
  if (!st || !st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(root) !== root) throw unsafePath();
}

function canonicalRoot(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const canonical = fs.realpathSync(root);
  checkRoot(canonical);
  return canonical;
}

function checkLeaf(p) {
  const st = lstatOptional(p);
  if (st && (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1)) throw unsafePath();
  return st;
}

function resolveSessionDir(root, id) {
  validateSessionId(id);
  checkRoot(root);
  const dir = path.join(root, id);
  if (path.dirname(dir) !== root) throw unsafePath();
  const st = lstatOptional(dir);
  if (st) {
    if (!st.isDirectory() || st.isSymbolicLink()) throw unsafePath();
    // Inspect links without following their targets; preflight before any effects.
    for (const leaf of LEAVES) {
      const file = path.join(dir, leaf), lock = leaf === '.lock' && lstatOptional(file);
      if (lock && lock.isDirectory() && !lock.isSymbolicLink()) continue;
      checkLeaf(file);
    }
  }
  return dir;
}

function checkFile(p) {
  if (!LEAVES.includes(path.basename(p))) throw unsafePath();
  const dir = path.dirname(p);
  if (resolveSessionDir(path.dirname(dir), path.basename(dir)) !== dir) throw unsafePath();
  return checkLeaf(p);
}

function openFile(p, flags, mode = 0o666) {
  const st = checkFile(p);
  // Exclusive creation prevents following a newly substituted leaf when absent.
  if (!st && (flags & fs.constants.O_CREAT)) flags |= fs.constants.O_EXCL;
  let fd;
  try {
    fd = fs.openSync(p, flags | (fs.constants.O_NOFOLLOW || 0), mode);
  } catch (err) {
    if (err.code === 'ELOOP') throw unsafePath();
    if (err.code === 'EEXIST') checkFile(p);
    throw err;
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1) throw unsafePath();
    return fd;
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}

function readFile(p) {
  const fd = openFile(p, fs.constants.O_RDONLY);
  try { return fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
}

function writeFile(p, content, append = false) {
  const fd = openFile(p, fs.constants.O_WRONLY | fs.constants.O_CREAT |
    (append ? fs.constants.O_APPEND : 0));
  try {
    if (!append) fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, content);
  } finally { fs.closeSync(fd); }
}

function unlinkFile(p) {
  checkFile(p);
  fs.unlinkSync(p);
}

function rethrowBoundary(err) {
  if (err.code === 'MAILBOX_INVALID_SESSION_ID' || err.code === 'MAILBOX_UNSAFE_PATH') throw err;
}

module.exports = { validateSessionId, canonicalRoot, resolveSessionDir, checkRoot, checkFile, openFile, readFile, writeFile, unlinkFile, rethrowBoundary };
