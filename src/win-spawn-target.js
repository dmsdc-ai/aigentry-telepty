'use strict';

const path = require('path');
const { resolveWindowsExecutable } = require('./win-resolve-executable');

// cmd's parser is distinct from CreateProcess argv parsing. Quote/backslash
// encoding alone (PR #27) leaves shell operators exposed after embedded quotes.
// Apply the cross-spawn escape algorithm at both cmd/npm-shim parsing layers.
const meta = /([()\][%!^"`<>&|;, *?])/g;
function escapeArgument(value) {
  let arg = String(value)
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, '$1$1');
  arg = `"${arg}"`.replace(meta, '^$1');
  return arg.replace(meta, '^$1');
}

function buildPtySpawnTarget(command, args = [], env = process.env, opts = {}) {
  if ((opts.platform || process.platform) !== 'win32') return { file: command, args: args.slice() };
  const resolved = resolveWindowsExecutable(command, env, opts);
  const ext = path.win32.extname(resolved).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { file: resolved, args: args.slice() };
  if (ext === '.ps1') {
    return { file: env.PSExecutablePath || 'powershell.exe', args: ['-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', resolved, ...args] };
  }
  if (ext !== '.cmd' && ext !== '.bat') throw new Error(`telepty: unsupported Windows executable type: ${ext || '(none)'}`);
  // Percent expansion happens before cmd caret removal; batch files also have
  // positional expansion. Refuse values we cannot transmit literally rather
  // than silently expanding environment variables or introducing a new command.
  if ([resolved, ...args].some(value => /[%\r\n]/.test(value))) {
    throw new Error('telepty: Windows batch arguments cannot contain percent signs or line breaks; invoke the underlying executable directly');
  }
  const file = env.ComSpec || env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe';
  const executable = resolved.replace(meta, '^$1');
  // node-pty accepts a raw command-line string on Windows; an argv array would
  // apply another quoting layer and invalidate the deliberate cmd escaping.
  return { file, args: `/d /v:off /s /c "${[executable, ...args.map(escapeArgument)].join(' ')}"` };
}

module.exports = { buildPtySpawnTarget };
