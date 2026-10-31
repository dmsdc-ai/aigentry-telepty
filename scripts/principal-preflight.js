#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { inspectPrincipalMigration, boundaries } = require('../src/principal/migration-preflight');
const args = process.argv.slice(2), options = {};
let valid = args.length === 4;
for (let i = 0; valid && i < args.length; i += 2) {
  const name = args[i] === '--trust' ? 'trustFile' : args[i] === '--inventory' ? 'inventoryFile' : null;
  if (!name || options[name] || !path.isAbsolute(args[i + 1])) valid = false;
  else options[name] = args[i + 1];
}
try {
  if (!valid || !options.trustFile || !options.inventoryFile) throw new Error();
  const report = inspectPrincipalMigration(options);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.all_declared_grants_match ? 0 : 1;
} catch {
  console.log(JSON.stringify({ ...boundaries(), error: 'PRINCIPAL_PREFLIGHT_UNAVAILABLE' }));
  console.error('Read-only static inspection refused. Supply explicit --trust and --inventory absolute files. No enrollment or activation performed.');
  process.exitCode = 2;
}
