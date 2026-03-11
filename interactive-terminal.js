'use strict';

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
  attachInteractiveTerminal
};
