'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_SHARED_REF_TTL_DAYS = 7;
const SHARED_REF_DIR_SEGMENTS = ['.telepty', 'shared'];

function getSharedContextDir(homeDir = os.homedir()) {
  return path.join(homeDir, ...SHARED_REF_DIR_SEGMENTS);
}

function getSharedContextPromptPath(fileName) {
  return path.posix.join('~', ...SHARED_REF_DIR_SEGMENTS, fileName);
}

function getSharedContextTtlMs(env = process.env) {
  const rawDays = env.TELEPTY_SHARED_REF_TTL_DAYS;
  if (rawDays == null || rawDays === '') {
    return DEFAULT_SHARED_REF_TTL_DAYS * 24 * 60 * 60 * 1000;
  }

  const days = Number(rawDays);
  if (!Number.isFinite(days) || days < 0) {
    return DEFAULT_SHARED_REF_TTL_DAYS * 24 * 60 * 60 * 1000;
  }

  return days * 24 * 60 * 60 * 1000;
}

function createSharedContextDescriptor(content) {
  const normalized = String(content ?? '');
  if (!normalized.trim()) {
    throw new Error('Shared reference content cannot be empty.');
  }

  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  const fileName = `${hash}.md`;

  return {
    content: normalized,
    hash,
    fileName,
    promptPath: getSharedContextPromptPath(fileName)
  };
}

function cleanupSharedContextFiles(options = {}) {
  const dir = options.dir || getSharedContextDir(options.homeDir);
  const ttlMs = options.ttlMs ?? getSharedContextTtlMs(options.env);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    return { removed: 0 };
  }

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { removed: 0 };
    }
    throw error;
  }

  const cutoff = (options.now ?? Date.now()) - ttlMs;
  let removed = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }

    const entryPath = path.join(dir, entry.name);
    let stat;
    try {
      stat = fs.statSync(entryPath);
    } catch {
      continue;
    }

    if (stat.mtimeMs >= cutoff) {
      continue;
    }

    try {
      fs.unlinkSync(entryPath);
      removed += 1;
    } catch {
      // Ignore best-effort cleanup failures.
    }
  }

  return { removed };
}

function ensureSharedContextFile(descriptor, options = {}) {
  const dir = options.dir || getSharedContextDir(options.homeDir);
  cleanupSharedContextFiles({ dir, ttlMs: options.ttlMs, env: options.env, now: options.now });
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, descriptor.fileName);
  let created = false;

  if (!fs.existsSync(filePath)) {
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, descriptor.content, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(tempPath, filePath);
      created = true;
    } catch (error) {
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // Ignore temp cleanup failures when another process won the race.
        }
      } else {
        throw error;
      }
    }
  }

  return {
    ...descriptor,
    filePath,
    created
  };
}

function buildSharedContextPrompt(descriptorOrPath) {
  const promptPath = typeof descriptorOrPath === 'string'
    ? descriptorOrPath
    : descriptorOrPath.promptPath;
  return `[context-ref] Read ${promptPath} and use it as the source of truth for this task.`;
}

module.exports = {
  buildSharedContextPrompt,
  cleanupSharedContextFiles,
  createSharedContextDescriptor,
  ensureSharedContextFile,
  getSharedContextDir,
  getSharedContextPromptPath,
  getSharedContextTtlMs
};
