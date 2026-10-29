'use strict';
const fs = require('node:fs');
const path = require('node:path');
const C = fs.constants;
function unavailable() { throw Object.assign(new Error('Authority file is unavailable or unsafe'), { code: 'AUTHORITY_FILE_UNAVAILABLE' }); }
function anchor(fd, name) {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) unavailable();
  return `/proc/self/fd/${fd}/${name}`;
}

// Linux descriptor-relative integrity adapter. Unsupported platforms fail closed.
function readAuthorityFile(filePath, { maximum = 100 * 1024, privateFile = false, platform = process.platform } = {}) {
  let dir, file;
  try {
    if (platform !== 'linux' || typeof process.getuid !== 'function' || !C.O_NOFOLLOW || !C.O_DIRECTORY
        || typeof filePath !== 'string' || !path.isAbsolute(filePath) || path.normalize(filePath) !== filePath) unavailable();
    const uid = process.getuid();
    dir = fs.openSync('/', C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    const parts = filePath.split('/').filter(Boolean), leaf = parts.pop();
    if (!leaf) unavailable();
    for (const component of parts) {
      const next = fs.openSync(anchor(dir, component), C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
      fs.closeSync(dir); dir = next;
      const stat = fs.fstatSync(dir);
      const trustedStickyTemp = stat.uid === 0 && (stat.mode & 0o1777) === 0o1777;
      if (!stat.isDirectory() || ![0, uid].includes(stat.uid) || ((stat.mode & 0o022) && !trustedStickyTemp)) unavailable();
    }
    file = fs.openSync(anchor(dir, leaf), C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    const stat = fs.fstatSync(file);
    if (!stat.isFile() || ![0, uid].includes(stat.uid) || (stat.mode & 0o022) || stat.nlink !== 1 || stat.size < 1 || stat.size > maximum || (privateFile && (stat.mode & 0o077))) unavailable();
    const buffer = Buffer.alloc(stat.size + 1);
    const bytes = fs.readSync(file, buffer, 0, buffer.length, 0);
    const after = fs.fstatSync(file);
    if (bytes !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) unavailable();
    return buffer.subarray(0, bytes);
  } catch { unavailable(); }
  finally {
    if (file !== undefined) { try { fs.closeSync(file); } catch {} }
    if (dir !== undefined) { try { fs.closeSync(dir); } catch {} }
  }
}
module.exports = { readAuthorityFile };
