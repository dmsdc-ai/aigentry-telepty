'use strict';
// #1215 pipe196 — error ownership for the Windows node-pty INPUT channel of a spawned session.
//
// Measured (Windows run 41295961906, owner-daemon-744-1.json): the daemon died of an unhandled EPIPE `write` on the
// node-pty agent input socket, first written by WindowsTerminal._doWrite. node-pty gives that socket no 'error'
// listener, and its non-DLL kill never destroys it. A write queued in the deferred queue that runs at first output,
// immediately before the kill, can therefore fail after the console closed. The emit then had no owner and terminated
// the whole daemon, every other session included.
//
// node-pty has NO public API for input-channel errors (IPty exposes onData/onExit only), so this binds ONE internal,
// validated interface. It was checked identical in node-pty 1.2.0-beta.11 (O) and 1.2.0-beta.18 (B):
//   WindowsTerminal#_agent (WindowsPtyAgent) -> `inSocket` getter -> net.Socket({ fd: conin, readable: false,
//   writable: true }), written only by WindowsTerminal#_doWrite.
// When the PTY does not have that shape (Unix node-pty has no `_agent`; an unknown future shape), nothing is attached
// and the state says why ('not_applicable' off Windows, 'unsupported' on Windows). Behaviour is then exactly as before.
//
// On an input-channel error this:
//   - owns that socket's 'error' only, never any other emitter, and never process-wide;
//   - classifies it ('input_closed' for broken-pipe/closed codes, otherwise 'unexpected' or 'invalid') and logs one
//     fixed line per session;
//   - fences the session's input through the EXISTING first-party write guard `ptyProcess.killed`. That is read by
//     session-delivery (DISCONNECTED instead of a false success) and by delivery-runtime health. node-pty itself never
//     defines or reads `killed`, so the own property changes no node-pty behaviour.
// It never kills, closes or retries the PTY, so a kill already in progress is not repeated. Exit and cleanup stay with
// the existing onExit / DELETE paths.
//
// Disposal: the listener is removed only on the socket's own 'close'. A stream emits no 'error' after 'close', so a
// late failure can never become unowned again. In particular onExit does NOT remove it: the measured failure is
// exactly a late write error.
const EXPECTED_INPUT_CODES = new Set(['EPIPE', 'ECONNRESET', 'EOF', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END', 'ERR_SOCKET_CLOSED']);

function windowsAgentInputSocket(ptyProcess) {
  let socket;
  try {
    const agent = ptyProcess && typeof ptyProcess === 'object' ? ptyProcess._agent : null;
    socket = agent && typeof agent === 'object' ? agent.inSocket : null;
  } catch {
    return null;
  }
  if (!socket || typeof socket !== 'object') return null;
  for (const method of ['on', 'removeListener', 'listenerCount', 'write']) if (typeof socket[method] !== 'function') return null;
  return socket;
}

function classifyInputError(error) {
  if (error === null || typeof error !== 'object') return { kind: 'invalid', code: null, syscall: null };
  const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,48}$/.test(error.code) ? error.code : null;
  const syscall = typeof error.syscall === 'string' && /^[a-z_]{1,32}$/.test(error.syscall) ? error.syscall : null;
  return { kind: code !== null && EXPECTED_INPUT_CODES.has(code) ? 'input_closed' : 'unexpected', code, syscall };
}

function fenceInput(ptyProcess) {
  try {
    Object.defineProperty(ptyProcess, 'killed', { configurable: true, enumerable: false, writable: true, value: true });
    return true;
  } catch {
    return false;
  }
}

function ownPtyInputErrors(ptyProcess, { sessionId, platform, log = console.error } = {}) {
  const socket = windowsAgentInputSocket(ptyProcess);
  if (!socket) {
    const state = platform === 'win32' ? 'unsupported' : 'not_applicable';
    if (state === 'unsupported') log('[PTY] Session %s: input-channel error ownership unavailable (unsupported node-pty shape)', sessionId);
    return { state, failure: null, fenced: false, later_errors: 0 };
  }
  const status = { state: 'owned', failure: null, fenced: false, later_errors: 0 };
  const onError = (error) => {
    if (status.failure) { status.later_errors++; return; }
    status.failure = classifyInputError(error);
    status.fenced = fenceInput(ptyProcess);
    log('[PTY] Session %s input channel failed (%s %s); input fenced=%s, the daemon and other sessions continue',
      sessionId, status.failure.kind, status.failure.code || '-', status.fenced);
  };
  const onClose = () => {
    socket.removeListener('error', onError);
    socket.removeListener('close', onClose);
    status.state = 'closed';
  };
  try {
    socket.on('error', onError);
    socket.on('close', onClose);
  } catch {
    // Never turn a spawn into a 500 with a live, unreferenced PTY: report the shape as unsupported instead.
    try { socket.removeListener('error', onError); socket.removeListener('close', onClose); } catch { /* best effort */ }
    log('[PTY] Session %s: input-channel error ownership unavailable (listener attach failed)', sessionId);
    return { state: 'unsupported', failure: null, fenced: false, later_errors: 0 };
  }
  return status;
}

module.exports = { ownPtyInputErrors, classifyInputError, windowsAgentInputSocket };
