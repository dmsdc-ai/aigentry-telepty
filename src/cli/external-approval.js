'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { parseSessionReference } = require('../../session-routing');
const { boundedJson } = require('../diagnostics/client');
const MAX_FILE_BYTES = 16384;
const DOC_KEYS = ['version', 'sid', 'epoch', 'owner_generation', 'operation', 'no_enter', 'payload_sha256', 'nonce', 'expires_at', 'daemon_challenge'];
function fail(code) { throw Object.assign(new Error(code), { code }); }

// Only options before the first payload token can select the new path. The
// explicit -- separator always makes the rest literal, including option names.
function approvalOptionRequested(argv, names = ['--approval-file']) {
  let positionals = 0;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') return false;
    if (names.includes(arg)) return true;
    if (['--from', '--reply-to', '--submit-retry', '--ref'].includes(arg)) { i++; continue; }
    if (!arg.startsWith('-') && ++positionals > 1) return false;
  }
  return false;
}
function parseApprovalArgs(command, argv) {
  let target, approvalFile, noEnter = false, literal = false, payloadStarted = false;
  const payload = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (literal || payloadStarted) {
      if (target === undefined) target = arg; else { payload.push(arg); payloadStarted = true; }
      continue;
    }
    if (arg === '--') { literal = true; continue; }
    if (arg === '--no-enter') { noEnter = true; continue; }
    if (arg === '--json') continue;
    if (arg === '--approval-file') {
      if (command !== 'inject' || approvalFile || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('INVALID_APPROVAL_ARGUMENTS');
      approvalFile = argv[++i]; continue;
    }
    if (arg.startsWith('-')) fail('UNSUPPORTED_APPROVAL_OPTION');
    if (target === undefined) target = arg; else { payload.push(arg); payloadStarted = true; }
  }
  if (!target || !payload.length || (command === 'inject' && !approvalFile)) fail('INVALID_APPROVAL_ARGUMENTS');
  const parsed = parseSessionReference(target);
  if (!parsed.id || Buffer.byteLength(parsed.id) > 128 || /[\x00-\x1f\x7f-\x9f]/.test(parsed.id)) fail('INVALID_APPROVAL_TARGET');
  const prompt = payload.join(' ');
  return { ...parsed, prompt, noEnter, approvalFile, payloadSha256: crypto.createHash('sha256').update(prompt).digest('hex') };
}
function validateDocument(value, expected, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== DOC_KEYS.length || DOC_KEYS.some(key => !Object.prototype.hasOwnProperty.call(value, key))
      || value.version !== 1 || value.sid !== expected.id || value.operation !== 'inject'
      || value.no_enter !== expected.noEnter || value.payload_sha256 !== expected.payloadSha256
      || typeof value.epoch !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.epoch)
      || !(value.owner_generation === null || typeof value.owner_generation === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.owner_generation))
      || typeof value.nonce !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(value.nonce)
      || typeof value.daemon_challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.daemon_challenge)
      || !Number.isSafeInteger(value.expires_at) || value.expires_at > now + 61000) fail('INVALID_APPROVAL_DOCUMENT');
  if (value.expires_at <= now) fail('APPROVAL_EXPIRED');
  // Public allowlist projection also preserves the server's documented signing order.
  return Object.fromEntries(DOC_KEYS.map(key => [key, value[key]]));
}
function readApprovalFile(file, expected, { filesystem = fs, platform = process.platform, uid = process.getuid?.(), now = Date.now() } = {}) {
  if (platform === 'win32' || !filesystem.constants.O_NOFOLLOW) fail('APPROVAL_FILE_PLATFORM_UNSUPPORTED');
  let fd;
  try {
    const before = filesystem.lstatSync(file);
    const privateFile = stat => stat.isFile() && stat.nlink === 1 && (stat.mode & 0o077) === 0
      && (uid === undefined || stat.uid === uid) && stat.size > 0 && stat.size <= MAX_FILE_BYTES;
    if (!privateFile(before) || before.isSymbolicLink()) fail('UNSAFE_APPROVAL_FILE');
    fd = filesystem.openSync(file, filesystem.constants.O_RDONLY | filesystem.constants.O_NOFOLLOW);
    const opened = filesystem.fstatSync(fd);
    if (!privateFile(opened) || opened.dev !== before.dev || opened.ino !== before.ino) fail('UNSAFE_APPROVAL_FILE');
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let bytes = 0, jsonStarted = false;
    while (bytes < buffer.length) {
      // Refuse PEM/key files from their first non-whitespace byte, before reading
      // any encoded key body. This command accepts a JSON proof, never a key.
      const count = filesystem.readSync(fd, buffer, bytes, jsonStarted ? buffer.length - bytes : 1, null);
      if (!count) break;
      bytes += count;
      if (!jsonStarted) {
        if ([9, 10, 13, 32].includes(buffer[bytes - 1])) {
          if (bytes > 128) fail('INVALID_APPROVAL_FILE');
        } else {
          if (buffer[bytes - 1] !== 123) fail('INVALID_APPROVAL_FILE');
          jsonStarted = true;
        }
      }
    }
    if (bytes > MAX_FILE_BYTES) fail('UNSAFE_APPROVAL_FILE');
    const raw = buffer.subarray(0, bytes).toString('utf8');
    if (raw.includes('PRIVATE KEY')) fail('INVALID_APPROVAL_FILE');
    const proof = JSON.parse(raw);
    if (!proof || typeof proof !== 'object' || Array.isArray(proof) || Object.keys(proof).length !== 2
        || typeof proof.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(proof.signature)) fail('INVALID_APPROVAL_FILE');
    return { document: validateDocument(proof.document, expected, now), signature: proof.signature };
  } catch (error) {
    if (['UNSAFE_APPROVAL_FILE', 'INVALID_APPROVAL_FILE', 'INVALID_APPROVAL_DOCUMENT', 'APPROVAL_EXPIRED'].includes(error.code)) throw error;
    fail('UNSAFE_APPROVAL_FILE');
  } finally { if (fd !== undefined) filesystem.closeSync(fd); }
}
const SERVER_CODES = new Set(['APPROVAL_DENIED', 'APPROVAL_EXPIRED', 'EXTERNAL_APPROVAL_REQUIRED', 'APPROVAL_TARGET_NOT_READY',
  'QUEUE_TIMEOUT', 'QUEUE_BUSY', 'SESSION_GONE', 'DISCONNECTED', 'STALE', 'PERMISSION_DENIED', 'APPROVAL_CAPACITY',
  'INVALID_APPROVAL_REQUEST', 'APPROVAL_POLICY_REQUIRED', 'APPROVAL_INGRESS_UNSUPPORTED', 'SSH_APPROVAL_TRANSPORT_UNSUPPORTED', 'DELIVERY_UNCERTAIN']);
async function runApprovalCommand(command, argv, { daemonUrl, remoteHost = '127.0.0.1', fetchWithAuth,
  print = console.log, printError = console.error }) {
  try {
    const input = parseApprovalArgs(command, argv);
    const externalApproval = command === 'inject' ? readApprovalFile(input.approvalFile, input) : null;
    const suffix = command === 'inject' ? 'inject' : 'approval-challenge';
    const body = command === 'inject' ? { prompt: input.prompt, no_enter: input.noEnter, exact_target: true, external_approval: externalApproval }
      : { operation: 'inject', no_enter: input.noEnter, payload_sha256: input.payloadSha256 };
    const response = await fetchWithAuth(`${daemonUrl(input.host || remoteHost)}/api/sessions/${encodeURIComponent(input.id)}/${suffix}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), readOnlyAuth: true,
      signal: AbortSignal.timeout(command === 'inject' ? 65000 : 5000), redirect: 'error' });
    const result = await boundedJson(response, MAX_FILE_BYTES);
    if (!response.ok) fail(SERVER_CODES.has(result.code) ? result.code : 'APPROVAL_REQUEST_REFUSED');
    if (command === 'approval-challenge') print(JSON.stringify(validateDocument(result.approval, input), null, 2));
    else {
      if (result.success !== true || result.strategy !== 'external_approved_owner_write') fail('INVALID_APPROVAL_RESPONSE');
      print(JSON.stringify({ success: true, strategy: 'external_approved_owner_write', submit: input.noEnter ? 'skipped' : 'deferred' }));
    }
    return 0;
  } catch (error) {
    const localCodes = new Set(['INVALID_APPROVAL_ARGUMENTS', 'UNSUPPORTED_APPROVAL_OPTION', 'INVALID_APPROVAL_TARGET',
      'INVALID_APPROVAL_DOCUMENT', 'APPROVAL_EXPIRED', 'APPROVAL_FILE_PLATFORM_UNSUPPORTED', 'UNSAFE_APPROVAL_FILE', 'INVALID_APPROVAL_FILE', 'INVALID_APPROVAL_RESPONSE']);
    const code = SERVER_CODES.has(error.code) || localCodes.has(error.code) ? error.code
      : error.code === 'TELEPTY_CONFIG_UNREADABLE' || error.name === 'CredentialRefusalError' ? 'CREDENTIALS_UNAVAILABLE' : 'APPROVAL_REQUEST_FAILED';
    printError(JSON.stringify({ success: false, code })); return 1;
  }
}
module.exports = { approvalOptionRequested, parseApprovalArgs, readApprovalFile, validateDocument, runApprovalCommand };
