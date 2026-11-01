'use strict';

function parseSpawnInvocation(argv) {
  let sessionId;
  let background = false;
  let index = 0;
  for (; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') { index++; break; }
    if (arg === '--id') {
      if (sessionId || !argv[index + 1] || argv[index + 1].startsWith('--')) {
        throw new Error('Usage: telepty spawn --id <session_id> [--background] [--] <command> [args...]');
      }
      sessionId = argv[++index];
    } else if (arg === '--background') {
      background = true;
    } else {
      break;
    }
  }
  if (!sessionId || index >= argv.length) {
    throw new Error('Usage: telepty spawn --id <session_id> [--background] [--] <command> [args...]');
  }
  return { sessionId, background, command: argv[index], cmdArgs: argv.slice(index + 1) };
}
module.exports = { parseSpawnInvocation };
