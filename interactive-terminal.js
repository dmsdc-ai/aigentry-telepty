'use strict';

const fs = require('fs');

const TERMINAL_CLEANUP_SEQUENCE = [
  '\x1b[?1049l', // Leave the alternate screen if the child died before cleanup.
  '\x1b[?25h',   // Ensure the cursor is visible again.
  '\x1b[?1l',    // Disable application cursor keys.
  '\x1b>',       // Disable application keypad mode.
  '\x1b[?1000l',
  '\x1b[?1002l',
  '\x1b[?1003l',
  '\x1b[?1004l',
  '\x1b[?1005l',
  '\x1b[?1006l',
  '\x1b[?1007l',
  '\x1b[?1015l',
  '\x1b[<u',     // Disable kitty keyboard protocol.
  '\x1b[>4;0m',  // Disable modifyOtherKeys.
  '\x1b[?2004l'  // Disable bracketed paste.
].join('');

function getTerminalSize(output, fallback = {}) {
  const envCols = Number.parseInt(process.env.COLUMNS || '', 10);
  const envRows = Number.parseInt(process.env.LINES || '', 10);
  const fallbackCols = Number.isInteger(fallback.cols) && fallback.cols > 0 ? fallback.cols : 120;
  const fallbackRows = Number.isInteger(fallback.rows) && fallback.rows > 0 ? fallback.rows : 40;

  const cols = Number.isInteger(output && output.columns) && output.columns > 0
    ? output.columns
    : (Number.isInteger(envCols) && envCols > 0 ? envCols : fallbackCols);
  const rows = Number.isInteger(output && output.rows) && output.rows > 0
    ? output.rows
    : (Number.isInteger(envRows) && envRows > 0 ? envRows : fallbackRows);

  return { cols, rows };
}

function removeListener(stream, eventName, handler) {
  if (!handler || !stream) {
    return;
  }

  if (typeof stream.off === 'function') {
    stream.off(eventName, handler);
    return;
  }

  if (typeof stream.removeListener === 'function') {
    stream.removeListener(eventName, handler);
  }
}

function restoreTerminalModes(output) {
  if (!output) {
    return;
  }

  try {
    if (typeof output.fd === 'number') {
      fs.writeSync(output.fd, TERMINAL_CLEANUP_SEQUENCE);
      return;
    }

    if (typeof output.write === 'function') {
      output.write(TERMINAL_CLEANUP_SEQUENCE);
    }
  } catch {
    // Ignore cleanup failures when the TTY is already gone.
  }
}

function attachInteractiveTerminal(input, output, handlers = {}) {
  const { onData = null, onResize = null } = handlers;

  if (input && input.isTTY && typeof input.setRawMode === 'function') {
    input.__teleptyRawModeActive = true;
    input.setRawMode(true);
  }

  if (input && typeof input.resume === 'function') {
    input.resume();
  }

  if (input && onData) {
    input.on('data', onData);
  }

  if (output && onResize) {
    output.on('resize', onResize);
    onResize();
  }

  return () => {
    removeListener(input, 'data', onData);
    removeListener(output, 'resize', onResize);

    if (input && input.isTTY && typeof input.setRawMode === 'function') {
      input.setRawMode(false);
      input.__teleptyRawModeActive = false;
    }

    if (input && typeof input.pause === 'function') {
      input.pause();
    }

    restoreTerminalModes(output);
  };
}

module.exports = {
  attachInteractiveTerminal,
  getTerminalSize,
  restoreTerminalModes,
  TERMINAL_CLEANUP_SEQUENCE
};
