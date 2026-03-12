'use strict';

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

function attachInteractiveTerminal(input, output, handlers = {}) {
  const { onData = null, onResize = null } = handlers;

  if (input && input.isTTY && typeof input.setRawMode === 'function') {
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
    }

    if (input && typeof input.pause === 'function') {
      input.pause();
    }
  };
}

module.exports = {
  attachInteractiveTerminal,
  getTerminalSize
};
