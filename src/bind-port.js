'use strict';

// #1124: one policy for daemon startup and explicitly configured service ports.
// Zero requests an OS-assigned ephemeral port (also used by the test harness).
function resolveBindPort(env) {
  const value = env.TELEPTY_PORT || env.PORT || 3848;
  const port = Number(value);
  if (Number.isInteger(port) && port >= 0 && port <= 65535) return port;
  console.error('[telepty] Invalid bind port; using 3848 (expected an integer from 0 to 65535).');
  return 3848;
}

module.exports = { resolveBindPort };
