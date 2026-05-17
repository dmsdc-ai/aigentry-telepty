// src/win-resolve-executable.js — Windows PATHEXT-aware executable resolver
//
// Fixes #25: `telepty allow ... <bare-command>` on Windows fails with
// `ERROR_FILE_NOT_FOUND` because node-pty's `CreateProcessW` does not walk
// `%PATHEXT%` the way cmd.exe shell does. npm-global CLIs install as
// `<cmd>.cmd` / `<cmd>.ps1`, so the bare name `claude` resolves to nothing.
//
// On POSIX this resolver is a no-op (execve handles PATH lookup natively).
//
// Exports:
//   resolveWindowsExecutable(command, env = process.env, opts = {})
//     → resolved absolute path on Windows when bare command is found via
//       PATH × PATHEXT walk, the original `command` on POSIX, or throws.
//
// Constraints honored:
//   - Constitution §1 lightweight: ≤80 lines, fs + path + process only.
//   - Constitution §2 cross-platform: POSIX behavior unchanged.
//   - Constitution §17 무의존: no new dependencies.

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.JS';

function resolveWindowsExecutable(command, env, opts) {
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error('telepty: resolveWindowsExecutable requires a non-empty command');
  }
  const e = env || process.env;
  const o = opts || {};
  const platform = o.platform || process.platform;
  const existsSync = o.existsSync || fs.existsSync;

  if (platform !== 'win32') return command;

  // Always use win32 path semantics in the Windows branch so behavior is
  // identical when the resolver runs on a Windows host AND when tests mock
  // `platform: 'win32'` on a POSIX host.
  const p = path.win32;

  // Already extension-bearing absolute path → trust if it exists.
  if (p.isAbsolute(command)) {
    return existsSync(command) ? command : tryWithExt(command, e, existsSync, command);
  }

  // Contains a separator → resolve relative to cwd, then try with extensions.
  if (command.includes('\\') || command.includes('/')) {
    const abs = p.resolve(command);
    return existsSync(abs) ? abs : tryWithExt(abs, e, existsSync, command);
  }

  // Bare name → walk PATH × PATHEXT. If the bare name has an explicit
  // extension (e.g., `claude.cmd`) probe as-is first via empty-ext; else
  // skip empty-ext so an extensionless sibling (npm ships a POSIX shell
  // script `claude` alongside `claude.cmd`) does NOT shadow the PATHEXT
  // match — matches real cmd.exe shell semantics.
  const allExts = parseExts(e.PATHEXT || DEFAULT_PATHEXT);
  const hasOwnExt = p.extname(command) !== '';
  const exts = hasOwnExt ? allExts : allExts.filter((x) => x !== '');
  const dirs = (e.PATH || '').split(';').filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = p.join(dir, command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(
    `telepty: cannot find executable "${command}" on PATH (Windows PATHEXT walk failed)`
  );
}

function tryWithExt(absPath, env, existsSync, originalCommand) {
  const exts = parseExts(env.PATHEXT || DEFAULT_PATHEXT);
  for (const ext of exts) {
    if (ext === '') continue;
    const candidate = absPath + ext;
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `telepty: cannot find executable "${originalCommand}" (Windows PATHEXT walk failed)`
  );
}

function parseExts(pathext) {
  // Always include empty string first so an already-extension-bearing command
  // matches before the PATHEXT-suffixed candidates.
  const list = pathext.split(';').map((s) => s.trim()).filter(Boolean);
  return ['', ...list];
}

module.exports = { resolveWindowsExecutable };
