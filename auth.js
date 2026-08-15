const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');

const CONFIG_DIR = path.join(os.homedir(), '.telepty');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// #835: a secret we cannot read is a condition to REPORT, never to silently replace.
//
// This function used to answer an unparseable config by minting a new UUID and writing it OVER
// the file — real token gone, every other key gone, exit 0, nothing thrown, one `console.warn`
// in whichever process happened to read it. daemon.js freezes EXPECTED_TOKEN at module load
// while every CLI process re-reads the file, so a single partial write desynced a long-lived
// daemon from every subsequent CLI call, permanently. The rotation also REPAIRED the file into
// valid JSON, which hid the corruption from the loadTeleptyConfig() guard further down
// daemon.js that would otherwise have refused the boot.
//
// Fail closed: throw, and leave the bytes on disk exactly as found. Callers decide what to do
// with the refusal; nothing here writes over a file it could not read.
function configUnreadable(reason) {
  const err = new Error(
    `${CONFIG_FILE} exists but holds no usable auth token (${reason}). Refusing to overwrite it: ` +
    'that would destroy the shared secret and every telepty call would start failing auth. ' +
    'Restore the file from a backup, or — accepting that all running daemons must be restarted ' +
    'to pick up a new secret — move it aside and let telepty mint a fresh one.'
  );
  err.code = 'TELEPTY_CONFIG_UNREADABLE';
  err.configFile = CONFIG_FILE;
  return err;
}

function readConfig() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    throw configUnreadable(e.message);
  }
  // Parsing is not reading. `{}`, `null` and a non-string token all survive JSON.parse and hand
  // the daemon `EXPECTED_TOKEN === undefined` — which the middleware then compares against
  // `req.headers['x-telepty-token']`, undefined === undefined, authenticating every request that
  // sends no token at all. A config that yields no usable secret is the same refusal as one that
  // will not parse.
  if (!parsed || typeof parsed !== 'object' || typeof parsed.authToken !== 'string' || parsed.authToken === '') {
    throw configUnreadable('no authToken string');
  }
  return parsed;
}

function getConfig() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 }); // Restrict permissions
  }

  if (fs.existsSync(CONFIG_FILE)) {
    return readConfig();
  }

  // First run — the only place a token may be created. `wx` makes that an exclusive create, so
  // a process that loses the race to another one starting at the same moment ADOPTS the winner's
  // token instead of clobbering it. Observed without this: 8 processes against one fresh HOME
  // produced 3 different tokens, i.e. the same desync as a corrupt read, by another door.
  const newConfig = {
    authToken: randomUUID(),
    createdAt: new Date().toISOString()
  };

  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2), { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return readConfig();
  }
  return newConfig;
}

module.exports = { getConfig };
