'use strict';

function buildInjectEnvelope(input) {
  const payload = input.payload || {};
  const toNode = requireString(input.to_node, 'to_node');
  const toSession = requireString(input.to_session, 'to_session');
  const fromNode = requireString(input.from_node, 'from_node');

  return {
    type: 'inject',
    message_id: requireString(input.message_id, 'message_id'),
    inject_id: requireString(input.inject_id, 'inject_id'),
    target: input.target || `${toSession}@${toNode}`,
    to_node: toNode,
    to_session: toSession,
    from_node: fromNode,
    source_host: input.source_host || fromNode,
    payload: {
      prompt: payload.prompt,
      from: payload.from,
      reply_to: payload.reply_to,
      no_enter: payload.no_enter === true,
    },
  };
}

function parseInjectEnvelope(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || parsed.type !== 'inject') {
    throw new Error('Expected inject envelope');
  }
  return buildInjectEnvelope(parsed);
}

function createMessageIdDeduper(options = {}) {
  const seen = options.seen || new Set();
  const maxSize = options.maxSize || 10000;
  const trimSize = options.trimSize || 5000;

  return {
    accept(messageOrId) {
      const messageId = getMessageId(messageOrId);
      if (!messageId) return false;
      if (seen.has(messageId)) return false;
      seen.add(messageId);

      if (seen.size > maxSize) {
        const ids = [...seen];
        ids.splice(trimSize);
        for (const id of ids) seen.delete(id);
      }

      return true;
    },
    has(messageOrId) {
      return seen.has(getMessageId(messageOrId));
    },
    get size() {
      return seen.size;
    },
    seen,
  };
}

function createSseSequencer(options = {}) {
  let current = parseLastEventId(options.initial) || 0;

  return {
    next() {
      current += 1;
      return current;
    },
    get current() {
      return current;
    },
  };
}

function parseLastEventId(value) {
  if (value === null || value === undefined || value === '') return null;
  const seq = Number(value);
  if (!Number.isSafeInteger(seq) || seq < 0) return null;
  return seq;
}

function buildSseInjectFrame(seq, envelope) {
  const eventId = parseLastEventId(seq);
  if (eventId === null) throw new Error('Invalid SSE sequence id');
  return `id: ${eventId}\nevent: inject\ndata: ${JSON.stringify(envelope)}\n\n`;
}

function parseSseFrame(frame) {
  const fields = { id: null, event: null, data: [] };
  for (const line of String(frame).split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const delimiter = line.indexOf(':');
    const name = delimiter === -1 ? line : line.slice(0, delimiter);
    let value = delimiter === -1 ? '' : line.slice(delimiter + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (name === 'id') fields.id = value;
    if (name === 'event') fields.event = value;
    if (name === 'data') fields.data.push(value);
  }

  const data = fields.data.join('\n');
  return {
    id: fields.id,
    event: fields.event,
    data: parseFrameData(data),
  };
}

function buildAck(input) {
  return {
    type: 'ack',
    inject_id: requireString(input.inject_id, 'inject_id'),
    success: input.success === true,
    code: input.code || null,
    error: input.error || null,
  };
}

function getMessageId(messageOrId) {
  if (typeof messageOrId === 'string') return messageOrId;
  if (messageOrId && typeof messageOrId.message_id === 'string') return messageOrId.message_id;
  return null;
}

function parseFrameData(data) {
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

module.exports = {
  buildAck,
  buildInjectEnvelope,
  buildSseInjectFrame,
  createMessageIdDeduper,
  createSseSequencer,
  parseInjectEnvelope,
  parseLastEventId,
  parseSseFrame,
};
