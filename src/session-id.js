'use strict';

// Session ids end up in strings a shell or a terminal interprets (PS1/PROMPT, OSC titles). The
// allowlist covers every id shape in use (createSessionId, `tp-r2-108`, `kkoma-<hex>`, dotted and
// underscored names, `name@host`); it has no shell, prompt (`%`, `\`, `$`) or control characters.
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:@-]+$/;
// Accepted by the null-prototype session maps, but plain objects elsewhere (sessions.json,
// getAllStates) treat them as the prototype (PR #108 review N5).
const RESERVED_SESSION_IDS = new Set(['__proto__', 'constructor', 'prototype']);
// `.`/`..` are path segments: the mailbox dir is path.join(root, id) (PR #108 review NB4).
const DOTS_ONLY = /^\.+$/;

function isValidSessionId(id) {
  return typeof id === 'string' && SESSION_ID_PATTERN.test(id) && !RESERVED_SESSION_IDS.has(id) && !DOTS_ONLY.test(id);
}

// Register and WS auto-register take ids the spawn allowlist would break (`telepty allow` defaults
// to `${basename(cwd)}-${cli}`; the owner WS URL is percent-encoded), so they refuse only what is
// unsafe for every producer: path separators, dots only, controls, prototype names (NB4, option A).
const UNSAFE_REGISTERED_ID_CHARS = /[/\\\u0000-\u001f\u007f-\u009f]/;

function isSafeRegisteredSessionId(id) {
  return typeof id === 'string' && id.length > 0 && !UNSAFE_REGISTERED_ID_CHARS.test(id)
    && !DOTS_ONLY.test(id) && !RESERVED_SESSION_IDS.has(id);
}

// C0, DEL and C1 controls: ESC/BEL/CSI in an id would end or rewrite an escape sequence.
function stripControlChars(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

function formatTerminalTitle(sessionId, suffix = '') {
  return `\x1b]0;⚡ telepty :: ${stripControlChars(sessionId)}${stripControlChars(suffix)}\x07`;
}

module.exports = { SESSION_ID_PATTERN, isValidSessionId, isSafeRegisteredSessionId, stripControlChars, formatTerminalTitle };
