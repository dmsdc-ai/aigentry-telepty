#!/usr/bin/env node
'use strict';

// telepty#49 — npm preuninstall hook: stop the running daemon and unload the
// launchd plist QUIETLY before the package files disappear, so `npm rm -g`
// does not leave a live daemon answering on 3848 or a plist that launchd keeps
// trying to resurrect. State directories and the plist file itself are left to
// the explicit `telepty uninstall [--purge]` path.
//
// NOTE: npm 7+ no longer executes uninstall lifecycle scripts — this hook
// covers npm 6 and package managers that still honor it. The documented,
// reliable cleanup path is `telepty uninstall` (run it BEFORE `npm rm -g`).
//
// HARD RULE: this script must never fail — a broken preuninstall would break
// `npm rm` itself, which is strictly worse than leaving a daemon running.

try {
  const { runPreuninstall } = require('../src/uninstall');
  runPreuninstall();
} catch {
  // Swallow everything — see HARD RULE above.
}
process.exit(0);
