#!/usr/bin/env node
// gen-readme.mjs — regenerate README.md from README.tmpl.md + package.json + ecosystem.json.
//
// Zero deps (Constitution §17). Deterministic: no timestamps, stable order, single
// trailing newline — same inputs always produce byte-identical output, so a no-op
// regen leaves README.md untouched (idempotent, no spurious CI diffs).
//
// Canonical copy lives in aigentry-devkit; each repo vendors a byte-identical copy at
// <repo>/scripts/gen-readme.mjs. scripts/sync-readme-tooling.mjs (devkit) refreshes them.
//
// Usage (run from anywhere — paths resolve relative to this file's repo root):
//   node scripts/gen-readme.mjs            # regenerate README.md
//   node scripts/gen-readme.mjs --check    # exit 1 if README.md is stale (CI/self-test)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/gen-readme.mjs -> repo root is one level up. cwd-independent.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const p = (f) => join(repoRoot, f);

const pkg = JSON.parse(readFileSync(p('package.json'), 'utf8'));
const eco = JSON.parse(readFileSync(p('ecosystem.json'), 'utf8'));
const tmpl = readFileSync(p('README.tmpl.md'), 'utf8');

// Self-override: the current repo's own row always uses its LOCAL package.json version,
// so a repo never displays a stale version of itself (other rows are the eco snapshot).
const modules = eco.modules.map((m) =>
  m.package === pkg.name ? { ...m, version: pkg.version } : m,
);

function renderEcosystemTable(mods) {
  const rows = mods.map((m) => {
    const unpublished = m.published === false;
    const pkgCell = unpublished ? '*(unpublished)*' : '`' + m.package + '`';
    const ver = unpublished ? '—' : m.version;
    return `| **${m.name}** | ${pkgCell} | ${ver} | ${m.role} | ${m.maturity} |`;
  });
  const table = [
    '| Module | Package | Version | Role | Maturity |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');

  // Honest license footnote (§13): auto-listed for any non-MIT module.
  const nonMit = mods.filter((m) => m.license && m.license !== 'MIT');
  if (!nonMit.length) return table;
  const names = nonMit
    .map((m) => '`' + m.package + '` (' + m.license + ')')
    .join(', ');
  return `${table}\n\n> Licenses: all MIT except ${names}.`;
}

const tokens = {
  '{{name}}': pkg.name,
  '{{version}}': pkg.version,
  '{{description}}': pkg.description || '',
  '{{install}}': `npm install -g ${pkg.name}`,
  '{{ecosystem_table}}': renderEcosystemTable(modules),
};

let out = tmpl;
for (const [k, v] of Object.entries(tokens)) out = out.split(k).join(v);

// Fail loudly on any unresolved {{token}} — catches template/data drift.
const leftover = out.match(/\{\{[a-z_]+\}\}/g);
if (leftover) {
  console.error(
    'gen-readme: unresolved tokens: ' + [...new Set(leftover)].join(', '),
  );
  process.exit(1);
}

out = out.replace(/\n*$/, '\n'); // normalize to exactly one trailing newline

if (process.argv.includes('--check')) {
  const cur = existsSync(p('README.md')) ? readFileSync(p('README.md'), 'utf8') : '';
  if (cur !== out) {
    console.error('gen-readme --check: README.md is stale — run `node scripts/gen-readme.mjs`');
    process.exit(1);
  }
  console.log('gen-readme --check: README.md up to date');
} else {
  writeFileSync(p('README.md'), out);
  console.log('gen-readme: wrote README.md');
}
