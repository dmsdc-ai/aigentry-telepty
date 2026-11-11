'use strict';
// Issue #144 — `telepty client-profile mint|check`. Local only: never contacts a daemon, never edits the profiles
// file (a grant stays an explicit operator act), never prints a token or a verifier it did not just mint.
//
//   telepty client-profile mint --profile <name> --generation <n> --token-file <abs>
//     Creates <abs> with O_CREAT|O_EXCL|O_NOFOLLOW, mode 0600, under an existing same-owner parent that is not
//     group/other-writable; writes the bare `tpc1.<n>.<43 b64url>` token (no newline). Prints ONE JSON line with
//     {profile, generation, token_verifier, not_before} for the operator to paste into the profiles file.
//     `not_before` is a fresh instant: keep it on rotation; use a fresh one whenever a prefix is (re-)granted.
//   telepty client-profile check [--file <abs>]
//     Validates the file with the daemon's own reader and validator (env/config resolution when --file is absent).
//     Prints profile names, prefixes, target counts, generations and not_before — never verifiers or tokens.
// Both refuse on win32 (no authority-file backend; profile scope is unsupported on native Windows).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const profiles = require('../protocol/client-profiles');

const USAGE = 'usage: telepty client-profile mint --profile <name> --generation <n> --token-file <abs>\n'
  + '       telepty client-profile check [--file <abs>]';
const PROFILE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function fail(code, reason) {
  return Object.assign(new Error(`${code}${reason ? `: ${reason}` : ''}`), { code, ...(reason ? { reason } : {}) });
}

// Exact flag parsing: each flag once, each with a value, nothing else.
function parseFlags(argv, allowed) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (!allowed.includes(flag) || Object.prototype.hasOwnProperty.call(out, flag) || typeof value !== 'string' || value.startsWith('--')) return null;
    out[flag] = value;
  }
  return out;
}

function safeParent(dir) {
  let stat;
  try { stat = fs.lstatSync(dir); } catch { return false; }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return stat.isDirectory() && !stat.isSymbolicLink() && uid !== null && [0, uid].includes(stat.uid) && (stat.mode & 0o022) === 0;
}

function mint(argv, { platform = process.platform, now = () => Date.now(), randomBytes = crypto.randomBytes } = {}) {
  if (platform === 'win32') throw fail('CLIENT_PROFILES_UNAVAILABLE', 'platform_unsupported');
  const flags = parseFlags(argv, ['--profile', '--generation', '--token-file']);
  if (!flags || Object.keys(flags).length !== 3) throw fail('CLIENT_PROFILE_USAGE');
  const name = flags['--profile'];
  if (!PROFILE_RE.test(name)) throw fail('CLIENT_PROFILE_USAGE', 'profile');
  if (!/^[1-9][0-9]{0,15}$/.test(flags['--generation']) || !Number.isSafeInteger(Number(flags['--generation']))) throw fail('CLIENT_PROFILE_USAGE', 'generation');
  const generation = Number(flags['--generation']);
  const file = flags['--token-file'];
  if (profiles.invalidPathReason(file)) throw fail('CLIENT_PROFILE_USAGE', 'token_file');
  if (!safeParent(path.dirname(file))) throw fail('CLIENT_PROFILE_TOKEN_FILE_UNSAFE', 'parent');
  const token = `tpc1.${generation}.${randomBytes(32).toString('base64url')}`;
  if (!profiles.TOKEN_RE.test(token)) throw fail('CLIENT_PROFILE_MINT_FAILED');
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  } catch (error) {
    throw fail('CLIENT_PROFILE_TOKEN_FILE_UNSAFE', error && error.code === 'EEXIST' ? 'exists' : 'create_failed');
  }
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, token);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  return {
    profile: name,
    generation,
    token_verifier: `sha256:${crypto.createHash('sha256').update(token).digest('hex')}`,
    not_before: new Date(now()).toISOString(),
  };
}

function check(argv, { env = process.env, platform = process.platform, readOperatorConfig = () => require('../principal/supervision-config').readOperatorConfig() } = {}) {
  if (platform === 'win32') throw fail('CLIENT_PROFILES_UNAVAILABLE', 'platform_unsupported');
  const flags = parseFlags(argv, ['--file']);
  if (!flags) throw fail('CLIENT_PROFILE_USAGE');
  let file = flags['--file'];
  if (file === undefined) {
    let selection;
    try { selection = profiles.resolveClientProfilesFile({ env, loadConfig: readOperatorConfig }); }
    catch { throw fail('CLIENT_PROFILES_CONFIG_UNREADABLE'); }
    if (selection.file === null) return { configured: false };
    file = selection.file;
  }
  if (profiles.invalidPathReason(file)) throw fail('CLIENT_PROFILES_UNAVAILABLE', 'path_invalid');
  const { bytes } = profiles.readClientProfilesFile(file, { platform });   // throws CLIENT_PROFILES_UNAVAILABLE/<reason>
  const snapshot = profiles.parseClientProfiles(bytes);
  return { configured: true, schema: profiles.SCHEMA, profiles: snapshot.summary.map((entry) => ({ ...entry })) };
}

// → exit code. Output is JSON on stdout (success) or a JSON {success:false, code, reason} on stderr.
function runClientProfileCommand(argv, { stdout = process.stdout, stderr = process.stderr, ...options } = {}) {
  const sub = argv[0];
  try {
    if (sub === 'mint') { stdout.write(`${JSON.stringify(mint(argv.slice(1), options))}\n`); return 0; }
    if (sub === 'check') { stdout.write(`${JSON.stringify(check(argv.slice(1), options))}\n`); return 0; }
    stderr.write(`${USAGE}\n`);
    return 2;
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : 'CLIENT_PROFILE_FAILED';
    const reason = error && typeof error.reason === 'string' ? error.reason : undefined;
    stderr.write(`${JSON.stringify({ success: false, code, ...(reason ? { reason } : {}) })}\n`);
    if (code === 'CLIENT_PROFILE_USAGE') stderr.write(`${USAGE}\n`);
    return code === 'CLIENT_PROFILE_USAGE' ? 2 : 1;
  }
}

module.exports = { mint, check, runClientProfileCommand, USAGE };
