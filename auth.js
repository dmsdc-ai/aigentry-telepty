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

// #839: no retry on a file that will not parse. Every telepty write of this file is atomic (see
// getConfig below), so a torn config.json is by definition not one of ours mid-flight — it came
// from an editor, a restore, a half-finished copy — and there is no reason to believe a second
// read milliseconds later finds it whole. A retry would only make the refusal nondeterministic,
// which is precisely the property that made this bug hard to see in the first place.
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

  // First run — the only place a token may be created. Two properties have to hold at once:
  //
  //   exclusive — a process that loses the race to another one starting at the same moment
  //               ADOPTS the winner's token instead of clobbering it. Observed without this:
  //               8 processes against one fresh HOME produced 3 different tokens, i.e. the same
  //               desync as a corrupt read, by another door.
  //   atomic    — a concurrent reader observes either nothing or the COMPLETE file.
  //
  // #839: `flag: 'wx'` alone bought only the first. The create is exclusive, but the bytes then
  // land in the file everyone can already see, so a process that opened config.json between the
  // create and the write got truncated JSON — and readConfig() above, fail-closed since #835,
  // then throws on it. The window turned a silent mis-mint into an exit 1 on a busy machine.
  //
  // Same-directory temp file → hard link into place. link(2) is atomic AND fails EEXIST when the
  // name is taken, which is both properties in one syscall; the rename used by the ledger writer
  // in src/session-store/persistence.js would have given the exclusivity back by overwriting the
  // winner. That is the one deviation from the precedent's shape — plus the directory fsync,
  // dropped on purpose: there, losing the rename to a crash loses a delivery record, here it only
  // means the next run mints again. The file fsync stays, because a config that survived a crash
  // EMPTY would now be a fail-closed refusal a human has to clear by hand, and that is worth one
  // syscall on a once-per-machine path.
  //
  // ponytail: link(2) needs a filesystem that has hard links — APFS, ext4, NTFS all do. A HOME on
  // exFAT would fail the mint outright rather than corrupt anything; O_EXCL + fsync + rename is
  // the fallback if one ever shows up.
  const newConfig = {
    authToken: randomUUID(),
    createdAt: new Date().toISOString()
  };

  // randomUUID, not pid+time: a temp collision here would surface as EEXIST and be misread below
  // as "someone else won the race".
  const tmp = path.join(CONFIG_DIR, `.config.json.${randomUUID()}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(newConfig, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.linkSync(tmp, CONFIG_FILE);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return readConfig();
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
  }
  return newConfig;
}

module.exports = { getConfig };
