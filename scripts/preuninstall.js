#!/usr/bin/env node
'use strict';

const path = require('path');
const pkg = require('../package.json');
const { installScope, readDaemonState, stopRecordedDaemon } = require('./postinstall');
const { detectSupervisor } = require('../src/supervisor');
const { compareSemver } = require('../src/version-handshake');

// npm 7+ removed uninstall hooks. Older managers may invoke this before removal.
async function main(options = {}) {
  const logger = options.logger || console;
  const skip = installScope(options.env || process.env, options.packageRoot || path.dirname(__dirname));
  if (skip) {
    logger.log(`[telepty preuninstall] Skipped (${skip}).`);
    return;
  }
  const state = (options.readDaemonState || readDaemonState)();
  if (!state || compareSemver(state.version, pkg.version) !== 0) return;
  const supervisor = (options.detectSupervisor || detectSupervisor)();
  if (supervisor?.present || supervisor?.detail === 'disabled-by-env') {
    logger.log('[telepty preuninstall] Service left running. To remove it deliberately, run telepty uninstall before removing the package.');
    return;
  }
  if (!(await (options.stopRecordedDaemon || stopRecordedDaemon)(state, false))) {
    logger.log('[telepty preuninstall] Recorded daemon exit could not be confirmed. Check telepty service status.');
  }
}

if (require.main === module) main().catch(() => {}); // A hook failure must never block removal.
module.exports = { main };
