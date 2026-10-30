'use strict';
const fs = require('node:fs');
const path = require('node:path');
const C = fs.constants;
function unsafe() { throw Object.assign(new Error('Broker audit storage unavailable'), { code: 'BROKER_AUDIT_STORAGE_UNAVAILABLE' }); }
function anchor(fd, name) { return `/proc/self/fd/${fd}/${name}`; }
function checkedDirectory(file) {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || !C.O_NOFOLLOW || !C.O_DIRECTORY
      || typeof file !== 'string' || !path.isAbsolute(file) || path.normalize(file) !== file) unsafe();
  const uid = process.getuid(), parts = path.dirname(file).split('/').filter(Boolean);
  if (parts.length === 0) unsafe();
  let fd = fs.openSync('/', C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  try {
    for (const [index, component] of parts.entries()) {
      let next;
      try { next = fs.openSync(anchor(fd, component), C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW); }
      catch (reason) {
        if (reason.code !== 'ENOENT') throw reason;
        try { fs.mkdirSync(anchor(fd, component), { mode: 0o700 }); } catch (created) { if (created.code !== 'EEXIST') throw created; }
        next = fs.openSync(anchor(fd, component), C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
      }
      fs.closeSync(fd); fd = next;
      const stat = fs.fstatSync(fd), stickyTemp = stat.uid === 0 && (stat.mode & 0o1777) === 0o1777;
      if (!stat.isDirectory() || ![0, uid].includes(stat.uid) || ((stat.mode & 0o022) && !stickyTemp)) unsafe();
      if (index === parts.length - 1 && (stat.uid !== uid || (stat.mode & 0o077))) unsafe();
    }
    return fd;
  } catch (reason) { fs.closeSync(fd); throw reason; }
}
function validLeaf(stat) {
  if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o077)) unsafe();
  return stat;
}
function leafStat(file) {
  try { return validLeaf(fs.lstatSync(file)); }
  catch (reason) { if (reason.code === 'ENOENT') return null; throw reason; }
}
// Optional storage backend for the existing async writer. Descriptor anchoring prevents
// ancestor replacement redirecting append/rotation; no existing object is chmod'ed safe.
// Linux only: unsupported integrity semantics discard the audit batch observably.
function createPrivateAuditStorage(file) {
  const leaf = path.basename(file);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(leaf)) unsafe();
  return {
    async writeBatch(data, { maxBytes, maxFiles, maxAgeDays }) {
      const dir = checkedDirectory(file);
      let handle;
      try {
        const active = anchor(dir, leaf);
        const stats = [];
        // Refuse unsafe rotations too, before performing any rename or prune.
        for (let n = 0; n <= maxFiles; n++) stats.push(leafStat(anchor(dir, leaf + (n ? `.${n}` : ''))));
        if (stats[0] && stats[0].size >= maxBytes) {
          for (let n = maxFiles - 1; n >= 1; n--) if (stats[n]) await fs.promises.rename(anchor(dir, `${leaf}.${n}`), anchor(dir, `${leaf}.${n + 1}`));
          await fs.promises.rename(active, anchor(dir, `${leaf}.1`));
        }
        if (maxAgeDays > 0) {
          const cutoff = Date.now() - maxAgeDays * 86400000;
          for (let n = 1; n <= maxFiles; n++) {
            const rotated = anchor(dir, `${leaf}.${n}`), stat = leafStat(rotated);
            if (stat && stat.mtimeMs < cutoff) await fs.promises.unlink(rotated);
          }
        }
        const existing = leafStat(active);
        handle = await fs.promises.open(active, C.O_WRONLY | C.O_APPEND | C.O_NOFOLLOW | C.O_NONBLOCK
          | (existing ? 0 : C.O_CREAT | C.O_EXCL), 0o600);
        const opened = validLeaf(await handle.stat());
        if (existing && (opened.dev !== existing.dev || opened.ino !== existing.ino)) unsafe();
        await handle.writeFile(data);
      } finally {
        try { if (handle) await handle.close(); }
        finally { fs.closeSync(dir); }
      }
    }
  };
}
module.exports = { createPrivateAuditStorage };
