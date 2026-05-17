// src/win-spawn-target.js — Windows .cmd/.bat/.ps1 shim spawn wrapper.
//
// Fixes #25 follow-up: node-pty on Windows calls CreateProcessW directly,
// which can launch .exe/.com but cannot execute .cmd/.bat/.ps1 (they need a
// shell interpreter). After `resolveWindowsExecutable` walks PATH×PATHEXT to
// find `claude.cmd`, calling `pty.spawn('claude.cmd', ...)` fails with
// `Cannot create process, error code: 193`. This module wraps such targets
// in the appropriate interpreter (cmd.exe or powershell.exe) so the bare-
// name UX (`telepty allow ... claude --continue`) works identically on
// macOS, Linux, and Windows.
//
// On POSIX this module is a pass-through (execve handles PATH lookup and
// there is no shim layer).
//
// For the .cmd/.bat branch we pass the args field to node-pty as a single
// pre-formatted command-line string, bypassing node-pty's array-based
// quoting layer that would otherwise re-quote our already-quoted args and
// confuse cmd.exe's `/s /c` parser. The string format is the one cmd.exe
// documents for `/s /c`: outer `"..."` wrap (stripped by /s), inner tokens
// each quoted with CreateProcessW backslash-quote encoding for embedded `"`.
//
// Constitution §1 lightweight: ≤80 lines, path + local imports only.
// Constitution §17 무의존: no new dependencies.

'use strict';

const path = require('path');
const { resolveWindowsExecutable } = require('./win-resolve-executable');

const NEEDS_QUOTING_RE = /[ \t"&|<>()^!,;]/;

function buildPtySpawnTarget(command, args, env, opts) {
  const e = env || process.env;
  const o = opts || {};
  const platform = o.platform || process.platform;
  const argv = Array.isArray(args) ? args.slice() : [];

  if (platform !== 'win32') {
    return { file: command, args: argv };
  }

  const resolved = resolveWindowsExecutable(command, e, o);
  const ext = path.win32.extname(resolved).toLowerCase();

  if (ext === '.exe' || ext === '.com') {
    return { file: resolved, args: argv };
  }

  if (ext === '.ps1') {
    const ps = e.PSExecutablePath || 'powershell.exe';
    return {
      file: ps,
      args: ['-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', resolved, ...argv],
    };
  }

  const comspec = e.ComSpec || e.COMSPEC || 'C:\\Windows\\System32\\cmd.exe';
  const tokens = [resolved, ...argv].map(quoteCmdToken);
  // Pass args as a single string so node-pty uses it verbatim instead of
  // applying its array-quoting on each element (which would double-quote our
  // already-quoted tokens and break cmd /s /c parsing).
  return {
    file: comspec,
    args: `/d /s /c "${tokens.join(' ')}"`,
  };
}

function quoteCmdToken(s) {
  const arg = String(s);
  if (arg === '') return '""';
  if (!NEEDS_QUOTING_RE.test(arg)) return arg;
  const escaped = arg
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, '$1$1');
  return `"${escaped}"`;
}

module.exports = { buildPtySpawnTarget };
