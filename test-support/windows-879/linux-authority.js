'use strict';

// telepty #879 — the supported-platform condition for Linux-only authority readers. Test-support only.
//
// src/principal/authority-file.js:15 (readAuthorityFile) and src/broker/audit-storage.js:8 refuse every
// platform except linux: their integrity check is /proc/self/fd descriptor anchoring plus POSIX
// uid/mode bits, and "Unsupported platforms fail closed". Principal trust files, principal/broker key
// and config files, private request files and the private broker audit are therefore Linux-only
// PRODUCT contracts — not Windows defects — on win32 AND darwin alike.
//
// A case that needs such a file ACCEPTED is skipped off Linux with this reason. A skipped case is not
// coverage for that platform: each consuming file keeps an explicit non-Linux refusal case that runs
// the same product entry point and asserts it fails closed.

const assert = require('node:assert/strict');

const IS_LINUX = process.platform === 'linux';

const LINUX_AUTHORITY_REASON =
  `${process.platform}: authority files are a Linux-only contract (src/principal/authority-file.js:15, `
  + 'src/broker/audit-storage.js:8 fail closed elsewhere); the non-Linux refusal is asserted in this file';

// `{ skip }` value for a case that needs a Linux authority file to be accepted.
const linuxOnly = IS_LINUX ? false : LINUX_AUTHORITY_REASON;

// `{ skip }` value for the matching refusal case, which has nothing to refuse on Linux.
const nonLinuxOnly = IS_LINUX
  ? 'linux: authority files are supported here; acceptance is asserted by the Linux cases in this file'
  : false;

// The strict-principal daemon must refuse to start off Linux rather than run without its trust file.
async function assertStrictDaemonRefused(startTestDaemon, options) {
  await assert.rejects(startTestDaemon(options), (error) => {
    assert.match(error.message, /Daemon exited early/);
    assert.match(error.message, /PRINCIPAL_TRUST_UNAVAILABLE/);
    return true;
  });
}

module.exports = { IS_LINUX, LINUX_AUTHORITY_REASON, linuxOnly, nonLinuxOnly, assertStrictDaemonRefused };
