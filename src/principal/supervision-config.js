'use strict';
// Task 1215 service36 — the PERSISTENT source of the combined-mode supervision trust file.
//
// A supervised daemon (launchd / systemd --user / a detached restart) does not inherit the operator's shell, so
// `TELEPTY_SUPERVISION_TRUST_FILE` exported there never reaches it, and descriptors carry a fixed environment that
// every install regenerates. The persistent setting is therefore ONE key, `supervisionTrustFile`, in the existing
// operator config `~/.telepty/config.json`; a non-empty env value keeps precedence (the authToken env-then-file
// rule, daemon.js). Only a path is stored — never trust bytes or keys.
//
// - Absent everywhere ⇒ off (guarded), exactly as before. A missing config file (ENOENT) is absent.
// - An existing config that cannot be read or parsed is NOT absence: callers get SUPERVISION_CONFIG_UNREADABLE.
// - A present key that is not a usable path ⇒ SUPERVISION_CONFIG_INVALID (never silently ignored).
// - Verification is the existing `loadPrincipalTrust` (readAuthorityFile + parse + validateTrustConfiguration);
//   nothing here re-implements a check or any crypto.
// - Messages carry a fixed code and reason only — never the path, the config contents or trust bytes.
// - Preflight is a statement, at THIS moment, about two local views: this process's (env first) and, when the env
//   decided, the persistent setting a service-managed replacement reads (service46 S1). It is not the running
//   daemon's effective policy, which only `GET /api/auth/challenge` on that daemon shows.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONFIG_KEY = 'supervisionTrustFile';
const ENV_KEY = 'TELEPTY_SUPERVISION_TRUST_FILE';
const MAX_PATH_BYTES = 4096;
const MESSAGES = Object.freeze({
  SUPERVISION_CONFIG_INVALID: 'the supervisionTrustFile setting is not a usable absolute trust file path',
  SUPERVISION_CONFIG_UNREADABLE: 'the telepty config exists but could not be read, so the supervision setting is unknown',
  SUPERVISION_MODE_CONFLICT: 'supervision trust cannot be combined with TELEPTY_PRINCIPAL_MODE=strict',
  SUPERVISION_UNSUPPORTED_PLATFORM: 'supervision trust is not supported on this platform',
  PRINCIPAL_TRUST_UNAVAILABLE: 'the configured supervision trust file is unavailable, unsafe or invalid',
});
const CODES = Object.freeze(Object.keys(MESSAGES));

function refusal(code, reason) {
  return Object.assign(new Error(`${MESSAGES[code]} (${code}${reason ? `: ${reason}` : ''})`), { code, ...(reason ? { reason } : {}) });
}

// A known refusal code, or one fixed fallback — callers print this, never an arbitrary error's message.
function refusalCode(error) {
  return error && CODES.includes(error.code) ? error.code : 'SUPERVISION_PREFLIGHT_FAILED';
}

function defaultConfigPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.telepty', 'config.json');
}

// The operator config as an object, or null when the file does not exist. Read-only: never creates or rewrites.
function readOperatorConfig({ configPath = defaultConfigPath() } = {}) {
  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw refusal('SUPERVISION_CONFIG_UNREADABLE', 'read_failed');
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw refusal('SUPERVISION_CONFIG_UNREADABLE', 'not_json'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw refusal('SUPERVISION_CONFIG_UNREADABLE', 'not_an_object');
  return parsed;
}

function invalidReason(value) {
  if (typeof value !== 'string') return 'not_a_string';
  if (value === '') return 'empty';
  if (Buffer.byteLength(value) > MAX_PATH_BYTES) return 'too_long';
  if (/[\x00-\x1f\x7f]/.test(value)) return 'control_character';
  if (!path.isAbsolute(value)) return 'not_absolute';
  if (path.normalize(value) !== value) return 'not_normalized';
  return null;
}

// → { file, source: 'env' | 'config' | null }. `config` is an already-read config object (or null); when it is
// undefined, `loadConfig()` is called — only if the env value did not already decide.
function resolveSupervisionTrustFile({ env = process.env, config, loadConfig = () => readOperatorConfig() } = {}) {
  const fromEnv = env[ENV_KEY];
  if (typeof fromEnv === 'string' && fromEnv !== '') return { file: fromEnv, source: 'env' };
  const source = config === undefined ? loadConfig() : config;
  if (!source || typeof source !== 'object' || !Object.prototype.hasOwnProperty.call(source, CONFIG_KEY)) return { file: null, source: null };
  const reason = invalidReason(source[CONFIG_KEY]);
  if (reason) throw refusal('SUPERVISION_CONFIG_INVALID', reason);
  return { file: source[CONFIG_KEY], source: 'config' };
}

// The same refusals the daemon applies at boot (src/principal/http.js createSupervisionAuthenticationFromEnvironment),
// plus an explicit platform refusal: the authority-file reader has no Windows backend.
function checkSelection(selection, { env, machineId, platform }) {
  if (!selection.file) return { configured: false, source: null };
  if (env.TELEPTY_PRINCIPAL_MODE === 'strict') throw refusal('SUPERVISION_MODE_CONFLICT');
  if (platform === 'win32') throw refusal('SUPERVISION_UNSUPPORTED_PLATFORM');
  const { loadPrincipalTrust } = require('./http');
  try {
    loadPrincipalTrust(selection.file, { audience: machineId || env.TELEPTY_MACHINE_ID || os.hostname(), platform });
  } catch {
    throw refusal('PRINCIPAL_TRUST_UNAVAILABLE');
  }
  return { configured: true, source: selection.source };
}

function selectionOf({ env, config, configPath }) {
  return resolveSupervisionTrustFile({ env, config, loadConfig: () => readOperatorConfig(configPath ? { configPath } : {}) });
}

// Task 1215 service46 (S1): a lifecycle replacement does not always run with THIS process's environment. A detached or
// inherited start does (calling-process view: env first, then the config). A service-managed replacement (launchd /
// systemd --user / schtasks) does NOT: its descriptor carries no TELEPTY_* variable (install.js resolveServiceProfile
// extraEnv {}), so it resolves the persistent config key alone (service-persistence view; no strict mode, no
// TELEPTY_MACHINE_ID, i.e. the daemon's own hostname audience fallback). Whenever the env value decides the calling
// view, the service view is checked too, with the identical path and trust rules, so a valid shell override can no
// longer carry an invalid persistent setting past preflight into a stop. The daemon's own env-wins resolution
// (resolveSupervisionTrustFile, used by daemon.js) is unchanged.
const SERVICE_ENV = Object.freeze({});
const SCOPE_LABELS = Object.freeze({
  calling_process: 'this process',
  service_persistence: 'the persistent setting a service-managed replacement reads',
});
function scoped(error, scope) {
  if (error && Object.prototype.hasOwnProperty.call(MESSAGES, error.code) && !error.scope) {
    error.scope = scope;
    error.message = `${SCOPE_LABELS[scope]}: ${error.message}`;
  }
  return error;
}
// Only the caller's environment can carry strict mode; every other refusal belongs to the selection's own source.
function scopeOf(error, source) {
  if (error && error.code === 'SUPERVISION_MODE_CONFLICT') return 'calling_process';
  return source === 'env' ? 'calling_process' : 'service_persistence';
}
function checkLifecycle({ env, config, configPath, machineId, platform }) {
  let selection;
  try { selection = selectionOf({ env, config, configPath }); } catch (error) { throw scoped(error, 'service_persistence'); }
  let result;
  try { result = checkSelection(selection, { env, machineId, platform }); } catch (error) { throw scoped(error, scopeOf(error, selection.source)); }
  if (selection.source !== 'env') return { ...result, service_persistence: result.configured ? 'configured' : 'not_configured' };
  let service;
  try { service = selectionOf({ env: SERVICE_ENV, config, configPath }); } catch (error) { throw scoped(error, 'service_persistence'); }
  try { checkSelection(service, { env: SERVICE_ENV, machineId, platform }); } catch (error) { throw scoped(error, 'service_persistence'); }
  return { ...result, service_persistence: service.file ? 'configured' : 'not_configured' };
}

// Throws a typed refusal (with `scope`), or → { configured, source, service_persistence }. Lifecycle callers run this
// BEFORE any stop/unload/cleanup. `configured`/`source` describe the calling-process view; `service_persistence` says
// whether a service-managed replacement would find a (valid) persistent setting or run guarded.
function preflightSupervision({ env = process.env, config, configPath, machineId, platform = process.platform } = {}) {
  return checkLifecycle({ env, config, configPath, machineId, platform });
}

// Read-only status view; never throws. `daemon_effective` is deliberately unmeasured here.
function describeSupervision({ env = process.env, config, configPath, machineId, platform = process.platform } = {}) {
  const view = (configured, source, preflight, failedScope, servicePersistence) => ({ configured, source, preflight,
    failed_scope: failedScope, service_persistence: servicePersistence, daemon_effective: 'unmeasured' });
  let persistence;
  try { persistence = selectionOf({ env: SERVICE_ENV, config, configPath }).file ? 'configured' : 'not_configured'; }
  catch (error) { persistence = refusalCode(error) === 'SUPERVISION_CONFIG_INVALID' ? 'invalid' : 'unreadable'; }
  let selection;
  try {
    selection = selectionOf({ env, config, configPath });
  } catch (error) {
    const code = refusalCode(error);
    return code === 'SUPERVISION_CONFIG_INVALID' ? view(true, 'config', code, 'service_persistence', persistence)
      : view(null, null, code, 'service_persistence', persistence);
  }
  try {
    const result = checkLifecycle({ env, config, configPath, machineId, platform });
    return view(result.configured, result.source, result.configured ? 'ok' : 'not_configured', null, persistence);
  } catch (error) {
    return view(true, selection.source, refusalCode(error), error && error.scope ? error.scope : null, persistence);
  }
}

module.exports = {
  CONFIG_KEY,
  ENV_KEY,
  MAX_PATH_BYTES,
  defaultConfigPath,
  readOperatorConfig,
  resolveSupervisionTrustFile,
  preflightSupervision,
  describeSupervision,
  refusalCode,
};
