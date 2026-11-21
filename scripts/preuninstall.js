#!/usr/bin/env node
'use strict';

// npm 7+ removed uninstall hooks. Older managers may invoke this before removal.
async function main(options = {}) {
  const path = require('path');
  const pkg = require('../package.json');
  const { installScope, readDaemonState, stopRecordedDaemon } = require('./postinstall');
  const { detectSupervisor } = require('../src/supervisor');
  const { compareSemver } = require('../src/version-handshake');
  const logger = options.logger || console;
  const skip = installScope(options.env || process.env, options.packageRoot || path.dirname(__dirname));
  if (skip) {
    logger.log(`[telepty preuninstall] Skipped (${skip}).`);
    return;
  }
  const state = (options.readDaemonState || readDaemonState)();
  if (!state || compareSemver(state.version, pkg.version) !== 0) {
    logger.log('[telepty preuninstall] No matching package version in daemon state. Skipping stop.');
    return;
  }
  const supervisor = (options.detectSupervisor || detectSupervisor)();
  if (supervisor?.present || supervisor?.detail === 'disabled-by-env') {
    logger.log('[telepty preuninstall] Automatic service teardown skipped. To remove it deliberately, run telepty uninstall before removing the package.');
    return;
  }
  if (!(await (options.stopRecordedDaemon || stopRecordedDaemon)(state, false)).startReplacement) {
    logger.log('[telepty preuninstall] Automatic teardown deferred. Check telepty service status.');
  }
}

// HARD RULE: even missing dependencies must never break npm removal.
if (require.main === module) (async () => {
  try { await main(); } catch { /* best effort */ }
  process.exit(0);
})();
module.exports = { main };
