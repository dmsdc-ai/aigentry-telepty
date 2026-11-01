'use strict';

// Linux-only, opt-in current-credential transport. Same-UID processes remain in
// the trust boundary; this is neither descendant proof nor independent approval.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const C = fs.constants;
const PREFIX = 'telepty-credential-';
const LEAF = 'credential.json';
const SCHEMA = 'telepty.session-credential/v1';
const MAX_BYTES = 16384;

function refuse(code = 'UNSAFE_PATH') {
  const error = new Error(`Credential refresh refused (${code}).`);
  error.code = `CREDENTIAL_CHANNEL_${code}`;
  throw error;
}
function supported(platform = process.platform) {
  if (platform !== 'linux' || !C.O_DIRECTORY || !C.O_NOFOLLOW || typeof process.getuid !== 'function') refuse('UNSUPPORTED');
}
function same(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function anchor(fd, leaf) {
  if (typeof leaf !== 'string' || !leaf || /[\/\x00]/.test(leaf) || leaf === '.' || leaf === '..') refuse();
  return `/proc/self/fd/${fd}/${leaf}`;
}
function privateDir(fd) {
  const stat = fs.fstatSync(fd);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) refuse();
  return stat;
}
// Walk each component with O_NOFOLLOW, relative to an already-open directory.
// A sticky temp directory is allowed; its random child is verified private.
function openDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.normalize(directory) !== directory) refuse();
  let fd = fs.openSync('/', C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  try {
    for (const component of directory.split('/').filter(Boolean)) {
      const next = fs.openSync(anchor(fd, component), C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
      fs.closeSync(fd);
      fd = next;
      const stat = fs.fstatSync(fd);
      const stickyTemp = (stat.mode & 0o1777) === 0o1777;
      if (!stat.isDirectory() || (!stickyTemp && (![0, process.getuid()].includes(stat.uid) || (stat.mode & 0o022)))) refuse();
    }
    return fd;
  } catch (error) { fs.closeSync(fd); throw error; }
}
function birthIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) refuse('IDENTITY');
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const closing = stat.lastIndexOf(')');
  const start = stat.slice(closing + 2).trim().split(/\s+/)[19];
  const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  if (closing < 0 || !/^\d+$/.test(start || '') || !/^[a-f0-9-]{36}$/.test(boot)) refuse('IDENTITY');
  return { boot_id: boot, start_ticks: start };
}
function readPrivate(fd, leaf) {
  let file;
  try {
    file = fs.openSync(anchor(fd, leaf), C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    const stat = fs.fstatSync(file);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600
        || stat.nlink !== 1 || stat.size <= 0 || stat.size > MAX_BYTES) refuse();
    return fs.readFileSync(file, 'utf8');
  } finally { if (file !== undefined) fs.closeSync(file); }
}
function validateRecord(record, instance, sid) {
  if (!record || record.schema !== SCHEMA || record.wrapper_instance !== instance || record.session_id !== sid
      || !Number.isSafeInteger(record.wrapper_pid) || !Number.isSafeInteger(record.sequence) || record.sequence < 1
      || !Number.isSafeInteger(record.credential_generation) || record.credential_generation < 1
      || typeof record.session_epoch !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(record.session_epoch)
      || typeof record.session_token !== 'string' || !new RegExp(`^${record.session_epoch}\\.[A-Za-z0-9_-]{43}$`).test(record.session_token)) refuse('RECORD');
  let birth;
  try { birth = birthIdentity(record.wrapper_pid); } catch { refuse('STALE_WRAPPER'); }
  if (record.wrapper_birth?.boot_id !== birth.boot_id || record.wrapper_birth?.start_ticks !== birth.start_ticks) refuse('STALE_WRAPPER');
  return record;
}
function readSessionCredential({ credentialPath = process.env.TELEPTY_SESSION_CREDENTIAL_PATH,
  instance = process.env.TELEPTY_SESSION_CREDENTIAL_INSTANCE, sessionId = process.env.TELEPTY_SESSION_ID,
  epoch, generation } = {}) {
  let fd;
  try {
    supported();
    if (!/^[a-f0-9]{32}$/.test(instance || '') || typeof sessionId !== 'string' || !sessionId
        || typeof credentialPath !== 'string' || path.basename(credentialPath) !== LEAF
        || path.basename(path.dirname(credentialPath)) !== PREFIX + instance) refuse();
    fd = openDirectory(path.dirname(credentialPath));
    privateDir(fd);
    const record = validateRecord(JSON.parse(readPrivate(fd, LEAF)), instance, sessionId);
    if ((epoch !== undefined && record.session_epoch !== epoch)
        || (generation !== undefined && record.credential_generation !== generation)) refuse('STALE_PRINCIPAL');
    return record;
  } catch (error) {
    if (error.code?.startsWith('CREDENTIAL_CHANNEL_')) throw error;
    refuse('UNSAFE_PATH');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function createSessionCredentialChannel({ sessionId, root = os.tmpdir(), platform = process.platform } = {}) {
  supported(platform);
  if (typeof sessionId !== 'string' || !sessionId || Buffer.byteLength(sessionId) > 128 || /[\x00-\x1f\x7f]/.test(sessionId)) refuse('IDENTITY');
  let parentFd, directoryFd;
  const instance = crypto.randomBytes(16).toString('hex');
  const directoryName = PREFIX + instance;
  const directoryPath = path.join(root, directoryName);
  const credentialPath = path.join(directoryPath, LEAF);
  let closed = false, candidate = null, currentAttempt = null, sequence = 0;
  let directoryStat;
  let birth;
  try { birth = birthIdentity(process.pid); } catch { refuse('IDENTITY'); }
  try {
    parentFd = openDirectory(root);
    fs.mkdirSync(anchor(parentFd, directoryName), { mode: 0o700 });
    directoryFd = fs.openSync(anchor(parentFd, directoryName), C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    directoryStat = privateDir(directoryFd);
    fs.fsyncSync(parentFd);
  } catch (error) {
    if (directoryFd !== undefined) fs.closeSync(directoryFd);
    if (parentFd !== undefined) fs.closeSync(parentFd);
    refuse();
  }
  function checkOwned() {
    if (closed) refuse('CLOSED');
    privateDir(directoryFd);
    const freshParent = openDirectory(root);
    try {
      if (!same(fs.fstatSync(freshParent), fs.fstatSync(parentFd))) refuse();
      const current = fs.lstatSync(anchor(parentFd, directoryName));
      if (current.isSymbolicLink() || !same(current, directoryStat)) refuse();
    } finally { fs.closeSync(freshParent); }
  }
  function publish(issued) {
    checkOwned();
    try { readPrivate(directoryFd, LEAF); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const record = {
      schema: SCHEMA, session_id: sessionId, session_epoch: issued.epoch,
      credential_generation: issued.generation, wrapper_pid: process.pid,
      wrapper_birth: birth, wrapper_instance: instance, sequence: sequence + 1,
      session_token: issued.bearer
    };
    const temporary = `next-${crypto.randomBytes(16).toString('hex')}.json`;
    let file;
    try {
      file = fs.openSync(anchor(directoryFd, temporary), C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
      fs.writeFileSync(file, JSON.stringify(record));
      const stat = fs.fstatSync(file);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) refuse();
      fs.fsyncSync(file);
      fs.closeSync(file); file = undefined;
      checkOwned();
      fs.renameSync(anchor(directoryFd, temporary), anchor(directoryFd, LEAF));
      fs.fsyncSync(directoryFd);
      sequence++;
    } finally {
      if (file !== undefined) fs.closeSync(file);
      try { fs.unlinkSync(anchor(directoryFd, temporary)); } catch {}
    }
  }
  return {
    credentialPath, instance,
    stageRegistration(response, data) {
      if (closed || !response?.ok || !data?.session_token) return false;
      const epoch = data.session_epoch;
      if (data.session_id !== sessionId || typeof epoch !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(epoch)
          || !Number.isSafeInteger(data.credential_generation) || data.credential_generation < 1
          || typeof data.session_token !== 'string' || !new RegExp(`^${epoch}\\.[A-Za-z0-9_-]{43}$`).test(data.session_token)) refuse('REGISTRATION');
      candidate = { epoch, generation: data.credential_generation, bearer: data.session_token };
      return true;
    },
    beginAttempt(bearer) {
      currentAttempt = { id: crypto.randomBytes(16).toString('hex'), bearer, candidate, consumed: false };
      return currentAttempt.id;
    },
    acknowledgeOwner({ attempt, bearer, ownerToken, binding }) {
      if (closed || typeof ownerToken !== 'string' || !ownerToken || !currentAttempt || currentAttempt.consumed || attempt !== currentAttempt.id
          || bearer !== currentAttempt.bearer || !candidate || candidate !== currentAttempt.candidate || bearer !== candidate.bearer
          || binding?.sid !== sessionId || binding?.session_epoch !== candidate.epoch
          || binding?.credential_generation !== candidate.generation) return false;
      try { publish(candidate); currentAttempt.consumed = true; return true; }
      catch (error) { if (error.code?.startsWith('CREDENTIAL_CHANNEL_')) throw error; refuse(); }
    },
    close() {
      if (closed) return false;
      try {
        checkOwned();
        // Only the fixed leaf inside our verified random instance is removed.
        try { readPrivate(directoryFd, LEAF); fs.unlinkSync(anchor(directoryFd, LEAF)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        fs.fsyncSync(directoryFd);
        fs.rmdirSync(anchor(parentFd, directoryName));
        fs.fsyncSync(parentFd);
        return true;
      } catch { return false; }
      finally { closed = true; candidate = null; currentAttempt = null; fs.closeSync(directoryFd); fs.closeSync(parentFd); }
    }
  };
}

module.exports = { createSessionCredentialChannel, readSessionCredential, birthIdentity };
