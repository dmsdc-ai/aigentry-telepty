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

// Windows environment names are case-insensitive, but a plain-object copy of process.env (cli.js sessionEnv
// `{ ...process.env }`) keeps the OS spelling (`Path`), so an exact `env.PATH` read missed an existing executable
// (#752, native 3b2c44a: path_key_other_case, resolver_walk_finds:false). Among keys that match case-insensitively
// the lexicographically first one wins — the rule Node's child_process applies to duplicate Windows env keys — so
// an exact upper-case key keeps its existing precedence and the choice never depends on insertion order.
// Read-only: the env object (and process.env) is never modified.
function envValue(env, name) {
  const keys = Object.keys(env).filter((key) => key.toUpperCase() === name).sort();
  return keys.length ? env[keys[0]] : undefined;
}

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

  // Bare name → walk PATH × PATHEXT.
  const exts = parseExtsForPathWalk(envValue(e, 'PATHEXT') || DEFAULT_PATHEXT);
  const dirs = (envValue(e, 'PATH') || '').split(';').filter(Boolean);
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
  const exts = parseExts(envValue(env, 'PATHEXT') || DEFAULT_PATHEXT);
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

function parseExtsForPathWalk(pathext) {
  const list = pathext.split(';').map((s) => s.trim()).filter(Boolean);
  return [...list, ''];
}

module.exports = { resolveWindowsExecutable };
