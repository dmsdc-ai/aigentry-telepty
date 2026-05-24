'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { parseDuration } = require('./lifecycle');

function configDir(options = {}) {
  return options.configDir || path.join(os.homedir(), '.telepty');
}

function candidateConfigPaths(options = {}) {
  const dir = configDir(options);
  return [
    path.join(dir, 'config.json'),
    path.join(dir, 'config.yaml'),
    path.join(dir, 'config.yml')
  ];
}

function parseScalar(value) {
  const trimmed = String(value || '').trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseSimpleYaml(raw, filePath) {
  const result = {};
  const lines = String(raw || '').split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const withoutComment = line.replace(/\s+#.*$/, '').trim();
    if (!withoutComment) continue;
    const match = withoutComment.match(/^([A-Za-z0-9_]+)\s*:\s*(.*?)\s*$/);
    if (!match) {
      throw new Error(`Invalid config syntax in ${filePath}:${index + 1}`);
    }
    result[match[1]] = parseScalar(match[2]);
  }
  return result;
}

function parseConfigContent(raw, filePath) {
  if (filePath.endsWith('.json')) {
    return JSON.parse(raw);
  }
  return parseSimpleYaml(raw, filePath);
}

function normalizeConfig(parsed, filePath) {
  const input = parsed && typeof parsed === 'object' ? parsed : {};
  const idleTtlRaw = Object.prototype.hasOwnProperty.call(input, 'idle_ttl_default')
    ? input.idle_ttl_default
    : 'off';
  const idleTtlDefaultMs = parseDuration(idleTtlRaw, { fieldName: 'idle_ttl_default' });

  return {
    path: filePath || null,
    idle_ttl_default: idleTtlRaw == null ? 'off' : String(idleTtlRaw),
    idleTtlDefaultMs
  };
}

function loadTeleptyConfig(options = {}) {
  const paths = options.paths || candidateConfigPaths(options);
  for (const filePath of paths) {
    if (!fs.existsSync(filePath)) continue;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = parseConfigContent(raw, filePath);
    return normalizeConfig(parsed, filePath);
  }
  return normalizeConfig({ idle_ttl_default: 'off' }, null);
}

module.exports = {
  candidateConfigPaths,
  parseSimpleYaml,
  parseConfigContent,
  normalizeConfig,
  loadTeleptyConfig
};
