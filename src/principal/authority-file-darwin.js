'use strict';
// Task 1215 — Darwin backend of readAuthorityFile. Loads ONLY the bundled prebuilt Node-API reader
// (src/principal/native/authority-darwin.c, built by scripts/build-authority-darwin.mjs) from a fixed
// package-relative path: no environment variable, argument or search path can redirect it, and nothing
// is compiled or downloaded at runtime. The binding is a single verified-read entry point, not a
// generic filesystem primitive. Absent or malformed binary => fail closed, named.
const path = require('node:path');

const BINARY = path.join(__dirname, 'native', 'prebuilt', 'darwin', 'authority-darwin.node');
const MAXIMUM_LIMIT = 16 * 1024 * 1024;
const PATH_LIMIT = 1024;
let binding;   // undefined = not tried; null = unavailable

function unavailable(reason, errno) {
  throw Object.assign(new Error('Authority file is unavailable or unsafe'), { code: 'AUTHORITY_FILE_UNAVAILABLE',
    reason, ...(Number.isSafeInteger(errno) ? { errno } : {}) });
}

function load() {
  if (binding !== undefined) return binding;
  binding = null;
  try {
    const module = { exports: {} };
    process.dlopen(module, BINARY);
    const exported = module.exports;
    const keys = exported && typeof exported === 'object' ? Object.keys(exported).sort() : [];
    if (keys.length === 2 && keys[0] === 'abi' && keys[1] === 'readVerified' && exported.abi === 1
        && typeof exported.readVerified === 'function') binding = Object.freeze({ readVerified: exported.readVerified });
  } catch { binding = null; }
  return binding;
}

function readAuthorityFileDarwin(filePath, { maximum, privateFile }) {
  if (typeof filePath !== 'string' || filePath.includes('\0') || Buffer.byteLength(filePath) > PATH_LIMIT
      || !path.isAbsolute(filePath) || path.normalize(filePath) !== filePath || filePath.endsWith('/')) unavailable('path_shape');
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAXIMUM_LIMIT || typeof privateFile !== 'boolean') unavailable('invalid_argument');
  const native = load();
  if (!native) unavailable('darwin_native_reader_unavailable');
  try {
    const bytes = native.readVerified(filePath, maximum, privateFile);
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > maximum) unavailable('native_result_invalid');
    return bytes;
  } catch (error) {
    if (error && error.code === 'AUTHORITY_FILE_UNAVAILABLE' && typeof error.reason === 'string' && /^[a-z_]{1,48}$/.test(error.reason)) {
      unavailable(error.reason, error.errno);
    }
    unavailable('native_error');
  }
}

module.exports = { readAuthorityFileDarwin, BINARY_RELATIVE: 'src/principal/native/prebuilt/darwin/authority-darwin.node' };
