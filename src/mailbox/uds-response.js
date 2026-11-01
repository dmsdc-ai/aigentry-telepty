'use strict';
const MAX_UDS_RESPONSE_BYTES = 65536;
function createBoundedUdsResponse(maxBytes = MAX_UDS_RESPONSE_BYTES) {
  let chunks = [], size = 0, exceeded = false;
  return {
    append(chunk) {
      if (exceeded) return false;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (size + bytes.length > maxBytes) { exceeded = true; chunks = []; return false; }
      size += bytes.length; chunks.push(Buffer.from(bytes)); return true;
    },
    text() { if (exceeded) throw new Error('response_budget_exceeded'); return Buffer.concat(chunks, size).toString('utf8'); },
    get bytes() { return size; }
  };
}
module.exports = { MAX_UDS_RESPONSE_BYTES, createBoundedUdsResponse };
