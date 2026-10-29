'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSharedContextDescriptor, getSharedContextPromptPath } = require('../shared-context');

// Base64 plus metadata remains below the daemon's existing 100 KiB JSON limit.
const MAX_SHARED_REFERENCE_BYTES = 64 * 1024;

function refusal(code, status = 400) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function validateTransfer(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => !['content_base64', 'hash', 'fileName'].includes(key))
    || typeof body.content_base64 !== 'string'
    || typeof body.hash !== 'string' || !/^[a-f0-9]{64}$/.test(body.hash)
    || body.fileName !== `${body.hash}.md`) throw refusal('SHARED_REF_INVALID');
  if (body.content_base64.length > Math.ceil(MAX_SHARED_REFERENCE_BYTES / 3) * 4) {
    throw refusal('SHARED_REF_TOO_LARGE', 413);
  }
  const bytes = Buffer.from(body.content_base64, 'base64');
  if (bytes.length > MAX_SHARED_REFERENCE_BYTES) throw refusal('SHARED_REF_TOO_LARGE', 413);
  if (bytes.toString('base64') !== body.content_base64
    || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) throw refusal('SHARED_REF_INVALID');
  let descriptor;
  try { descriptor = createSharedContextDescriptor(bytes.toString('utf8')); }
  catch { throw refusal('SHARED_REF_INVALID'); }
  if (descriptor.hash !== body.hash) throw refusal('SHARED_REF_HASH_MISMATCH', 409);
  return { descriptor, bytes };
}

function ensurePrivateDirectory(dir) {
  try { fs.mkdirSync(dir, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw refusal('SHARED_REF_STORAGE_UNSAFE', 409);
}

function syncDirectory(dir) {
  // Node has no portable Windows directory-fsync or DACL API. Windows gets file
  // data flushes below; POSIX additionally commits directory entries and modes.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
  try { fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function verifyExisting(filePath, bytes) {
  let fd;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== bytes.length) {
      throw refusal('SHARED_REF_STORAGE_CONFLICT', 409);
    }
    fd = fs.openSync(filePath, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    const existing = Buffer.alloc(bytes.length + 1);
    const count = fs.readSync(fd, existing, 0, existing.length, 0);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.nlink !== 1
      || opened.size !== bytes.length || count !== bytes.length
      || !existing.subarray(0, count).equals(bytes)) throw refusal('SHARED_REF_STORAGE_CONFLICT', 409);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function commitSharedReference(body, { homeDir = os.homedir() } = {}) {
  const { descriptor, bytes } = validateTransfer(body);
  const teleptyDir = path.join(homeDir, '.telepty');
  ensurePrivateDirectory(teleptyDir);
  const dir = path.join(teleptyDir, 'shared');
  ensurePrivateDirectory(dir);
  fs.chmodSync(dir, 0o700);
  const filePath = path.join(dir, descriptor.fileName);
  let created = false;
  if (!verifyExisting(filePath, bytes)) {
    const temporary = path.join(dir, `.${descriptor.hash}.${crypto.randomBytes(16).toString('hex')}.tmp`);
    let fd;
    try {
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      try { fs.linkSync(temporary, filePath); created = true; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!verifyExisting(filePath, bytes)) throw refusal('SHARED_REF_STORAGE_CONFLICT', 409);
  }
  syncDirectory(dir);
  // Flush ancestors on retries too: an earlier attempt may have created these
  // directories but failed before their parent entries reached durable storage.
  syncDirectory(teleptyDir);
  syncDirectory(homeDir);
  return { success: true, hash: descriptor.hash, fileName: descriptor.fileName,
    promptPath: getSharedContextPromptPath(descriptor.fileName), created };
}

module.exports = { MAX_SHARED_REFERENCE_BYTES, commitSharedReference };
