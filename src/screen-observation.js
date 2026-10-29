'use strict';
const { randomUUID, createHash } = require('node:crypto');
const DEFAULT_MAX_BYTES = 4096;
const MAX_BYTES = 262144;
// Weak ownership prevents dead sessions from retaining snapshots. At most four rendering
// modes, each with eight bounded snapshots, are retained for any live session.
const sessions = new WeakMap();
function prefixBytes(text, limit) {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  let end = limit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
function parseBudget(value) {
  if (value === undefined) return DEFAULT_MAX_BYTES;
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > MAX_BYTES) {
    throw new Error(`max_bytes must be an integer from 0 to ${MAX_BYTES}`);
  }
  return Number(value);
}
function observeScreen(session, { sessionId, screen, raw, lines, since, maxBytes, rollover = 0 }) {
  const budget = parseBudget(maxBytes);
  let state = sessions.get(session);
  if (!state) { state = { instance: randomUUID(), modes: new Map(), revision: 0 }; sessions.set(session, state); }
  const modeKey = JSON.stringify([raw, lines]);
  let mode = state.modes.get(modeKey);
  if (!mode) {
    if (state.modes.size >= 4) state.modes.delete(state.modes.keys().next().value);
    mode = { history: [] }; state.modes.set(modeKey, mode);
  }
  const totalBytes = Buffer.byteLength(screen);
  const bounded = prefixBytes(screen, MAX_BYTES);
  const digest = createHash('sha256').update(screen).digest('hex');
  let current = mode.history.at(-1);
  if (!current || current.digest !== digest || current.rollover !== rollover) {
    current = { screen: bounded, digest, totalBytes, rollover, revision: ++state.revision };
    current.cursor = `${state.instance}:${current.revision}`;
    mode.history.push(current);
    if (mode.history.length > 8) mode.history.shift();
  }
  const previous = mode.history.find(item => item.cursor === since);
  const unchanged = previous === current;
  let resetReason = since && !previous ? 'stale_cursor' : null;
  if (previous && previous.rollover !== rollover) resetReason = 'ring_rollover';
  let content = unchanged ? '' : bounded;
  let kind = unchanged ? 'unchanged' : 'snapshot';
  let splice;
  if (previous && !unchanged && !resetReason && previous.totalBytes <= MAX_BYTES && totalBytes <= MAX_BYTES) {
    // Unicode code-point indices, never UTF-16 half-surrogates. One splice handles
    // append-only output and full-screen repaints without pretending a repaint is a log.
    const before = Array.from(previous.screen), after = Array.from(bounded);
    let start = 0, suffix = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    while (suffix < before.length - start && suffix < after.length - start && before.at(-1 - suffix) === after.at(-1 - suffix)) suffix++;
    content = after.slice(start, after.length - suffix).join('');
    splice = { start, delete_count: before.length - start - suffix, index_unit: 'unicode_code_points' };
    kind = 'delta';
    if (Buffer.byteLength(content) > budget) { resetReason = 'byte_budget'; content = bounded; kind = 'snapshot'; splice = undefined; }
  } else if (previous && !unchanged && !resetReason) resetReason = 'snapshot_limit';
  const availableBytes = Buffer.byteLength(content);
  content = prefixBytes(content, budget);
  return { session_id: sessionId, session_instance: state.instance, cursor: current.cursor,
    revision: current.revision, changed: !unchanged, reset: !!resetReason, reset_reason: resetReason,
    truncated: !unchanged && (availableBytes > budget || totalBytes > MAX_BYTES),
    total_bytes: totalBytes, available_bytes: availableBytes, returned_bytes: Buffer.byteLength(content),
    kind, raw, lines, ...(splice ? { splice } : {}), content };
}
module.exports = { observeScreen, parseBudget, prefixBytes };
