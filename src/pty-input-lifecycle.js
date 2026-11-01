'use strict';
// #1215 pipe200 — first-party ownership and availability of the Windows node-pty INPUT channel of a spawned session.
//
// Measured (Windows run 41295961906, owner-daemon-744-1.json): the daemon died of an unhandled EPIPE `write` on the
// node-pty agent input socket, first written by WindowsTerminal._doWrite. node-pty gives that socket no 'error'
// listener, and its non-DLL kill never destroys it. A write queued in the deferred queue that runs at first output,
// immediately before the kill, can therefore fail after the console closed. The emit then had no owner and terminated
// the whole daemon, every other session included.
//
// node-pty's PUBLIC API cannot observe this. IPty exposes onData/onExit. The deprecated `on('error')` is wired to the
// OUTPUT socket handler (windowsTerminal.js, inside ready_datapipe) and never sees the input socket. So this binds ONE
// internal interface, validated on use. It was checked identical in node-pty 1.2.0-beta.11 (O) and 1.2.0-beta.18 (B):
//   WindowsTerminal#_agent (WindowsPtyAgent) -> `inSocket` getter -> net.Socket({ fd: conin, readable: false,
//   writable: true }), written only by WindowsTerminal#_doWrite.
// Admission (`state`):
//   'owned'          the interface is present: its 'error' is owned from before the first possible write;
//   'unsupported'    an agent without a valid inSocket, or no agent at all on win32. The caller must NOT publish a
//                    writable session (src/routes/spawn.js refuses the spawn with one rollback kill), because nothing
//                    would own a later input error;
//   'not_applicable' no agent off Windows (Unix node-pty owns its own socket errors); behaviour unchanged.
//
// On an input-channel error the owner records an explicit first-party failure ({ kind, code, syscall }; kind
// 'input_closed' for broken-pipe/closed codes, otherwise 'unexpected' or 'invalid') and logs one fixed line.
// Every first-party write path then refuses through ptyInputFailure(session):
//   - HTTP delivery (session-delivery) answers DISCONNECTED with reason 'pty_input_failed';
//   - the deferred submit (delivery-runtime submitViaPty) returns false;
//   - WebSocket viewer input (websocket.js) gets input_refused;
//   - health reports DISCONNECTED / PTY_INPUT_FAILED: an input failure is never reported as an observed exit.
// It never kills, closes or retries the PTY, so a kill already in progress is not repeated. Exit and cleanup stay with
// the existing onExit / DELETE paths. The PTY object is not modified.
//
// Disposal: the listener is removed only on the socket's own 'close'. A stream emits no 'error' after 'close', so a
// late failure can never become unowned again. In particular onExit does NOT remove it: the measured failure is
// exactly a late write error.
const EXPECTED_INPUT_CODES = new Set(['EPIPE', 'ECONNRESET', 'EOF', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END', 'ERR_SOCKET_CLOSED']);

function windowsAgent(ptyProcess) {
  try {
    const agent = ptyProcess && typeof ptyProcess === 'object' ? ptyProcess._agent : undefined;
    return agent && typeof agent === 'object' ? agent : null;
  } catch {
    return null;
  }
}

function windowsAgentInputSocket(agent) {
  let socket;
  try { socket = agent.inSocket; } catch { return null; }
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

function ownPtyInputErrors(ptyProcess, { sessionId, platform, log = console.error } = {}) {
  const agent = windowsAgent(ptyProcess);
  const socket = agent ? windowsAgentInputSocket(agent) : null;
  if (!socket) {
    const state = agent || platform === 'win32' ? 'unsupported' : 'not_applicable';
    if (state === 'unsupported') log('[PTY] Session %s: input-channel error ownership unavailable (unsupported node-pty shape)', sessionId);
    return { state, failure: null, later_errors: 0 };
  }
  const status = { state: 'owned', failure: null, later_errors: 0 };
  const onError = (error) => {
    if (status.failure) { status.later_errors++; return; }
    status.failure = classifyInputError(error);
    log('[PTY] Session %s input channel failed (%s %s); input refused, the daemon and other sessions continue',
      sessionId, status.failure.kind, status.failure.code || '-');
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
    try { socket.removeListener('error', onError); socket.removeListener('close', onClose); } catch { /* best effort */ }
    log('[PTY] Session %s: input-channel error ownership unavailable (listener attach failed)', sessionId);
    return { state: 'unsupported', failure: null, later_errors: 0 };
  }
  return status;
}

// The single shared write guard. Null when input is available; otherwise the recorded failure.
function ptyInputFailure(session) {
  const input = session && typeof session === 'object' ? session.ptyInput : null;
  return input && input.failure ? input.failure : null;
}

module.exports = { ownPtyInputErrors, ptyInputFailure, classifyInputError };
