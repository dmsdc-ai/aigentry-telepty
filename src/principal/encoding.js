'use strict';
const crypto = require('node:crypto');
const MAX_JSON_BYTES = 100 * 1024;
function invalid() { throw Object.assign(new Error('Invalid principal request encoding'), { code: 'PRINCIPAL_ENCODING_INVALID' }); }
function canonicalJSON(value) {
  const ancestors = new Set();
  let nodes = 0;
  function visit(current, depth) {
    if (++nodes > 4096 || depth > 32) invalid();
    if (current === null || typeof current === 'boolean' || typeof current === 'string') return JSON.stringify(current);
    if (typeof current === 'number') { if (!Number.isFinite(current)) invalid(); return JSON.stringify(current); }
    if (!current || typeof current !== 'object' || ancestors.has(current)) invalid();
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (typeof key !== 'string' || !descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
    }
    ancestors.add(current);
    let result;
    if (Array.isArray(current)) {
      const values = [];
      for (let i = 0; i < current.length; i++) {
        const item = Object.getOwnPropertyDescriptor(current, String(i));
        if (!item || !Object.hasOwn(item, 'value')) invalid();
        values.push(visit(item.value, depth + 1));
      }
      result = `[${values.join(',')}]`;
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(current))) invalid();
      const values = [];
      for (const key of Object.keys(current).sort()) {
        const item = Object.getOwnPropertyDescriptor(current, key);
        if (!item || !Object.hasOwn(item, 'value')) invalid();
        values.push(`${JSON.stringify(key)}:${visit(item.value, depth + 1)}`);
      }
      result = `{${values.join(',')}}`;
    }
    ancestors.delete(current);
    return result;
  }
  const result = visit(value, 0);
  if (Buffer.byteLength(result) > MAX_JSON_BYTES) invalid();
  return result;
}

// JSON.parse loses duplicate member information. Reject duplicates before the parsed value
// reaches a route, including differently escaped spellings of the same member.
function parseUnambiguousJSON(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  if (bytes.length > MAX_JSON_BYTES) invalid();
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) invalid();
  let index = 0, nodes = 0;
  function whitespace() { while (/[\t\r\n ]/.test(text[index] || '\0')) index++; }
  function string() {
    const start = index++;
    while (index < text.length) {
      const char = text[index++];
      if (char === '"') { try { return JSON.parse(text.slice(start, index)); } catch { invalid(); } }
      if (char === '\\') index++;
      else if (char.charCodeAt(0) < 32) invalid();
    }
    invalid();
  }
  function value(depth) {
    if (++nodes > 4096 || depth > 32) invalid();
    whitespace();
    if (text[index] === '"') return string();
    if (text[index] === '{') {
      index++; whitespace();
      const object = {}, seen = new Set();
      if (text[index] === '}') { index++; return object; }
      while (true) {
        whitespace(); if (text[index] !== '"') invalid();
        const key = string();
        if (seen.has(key)) invalid();
        seen.add(key); whitespace(); if (text[index++] !== ':') invalid();
        Object.defineProperty(object, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        whitespace();
        if (text[index] === '}') { index++; return object; }
        if (text[index++] !== ',') invalid();
      }
    }
    if (text[index] === '[') {
      index++; whitespace(); const array = [];
      if (text[index] === ']') { index++; return array; }
      while (true) {
        array.push(value(depth + 1)); whitespace();
        if (text[index] === ']') { index++; return array; }
        if (text[index++] !== ',') invalid();
      }
    }
    for (const [literal, parsed] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, index)) { index += literal.length; return parsed; }
    }
    const number = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!number) invalid();
    index += number[0].length;
    const parsed = Number(number[0]); if (!Number.isFinite(parsed)) invalid();
    return parsed;
  }
  const parsed = value(0); whitespace(); if (index !== text.length) invalid();
  return parsed;
}
function bodyDigest(body) {
  return crypto.createHash('sha256').update(body === undefined ? '' : canonicalJSON(body)).digest('hex');
}
function requestBodyDigest(req) {
  const raw = req.principalRawBody;
  if (raw !== undefined) {
    if (!Buffer.isBuffer(raw)) invalid();
    if (raw.length === 0) return bodyDigest(undefined);
    const parsed = parseUnambiguousJSON(raw);
    if (canonicalJSON(parsed) !== canonicalJSON(req.body)) invalid();
    return bodyDigest(parsed);
  }
  // HTTP integration must capture every nonempty request body. Never hash an uncaptured
  // parsed object while pretending duplicate-member ambiguity was checked.
  if (req.body !== undefined && !(req.method === 'GET' && Object.keys(req.body || {}).length === 0)) invalid();
  if (req.headers?.['transfer-encoding'] || Number(req.headers?.['content-length'] || 0) > 0) invalid();
  return bodyDigest(undefined);
}
module.exports = { MAX_JSON_BYTES, canonicalJSON, parseUnambiguousJSON, bodyDigest, requestBodyDigest };
