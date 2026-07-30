// src/report-enforcement.js — output-summary helper.
//
// telepty#60 Stage A (0.8.0) REMOVED the report classifier that used to live here.
// `classifyReportPrompt` + REPORT_PREFIX_RE + REPORT_STATUS_*_RE are gone: 0.8.0 does not
// classify report-shaped text at all, because no text can authenticate its sender or correlate
// itself to a dispatch, and its only consumer mapped every non-matching payload to
// `report_complete` anyway (daemon.js resolveOutboundReportStatus, also deleted). An
// authenticated, correlated report validator returns in Stage B / 0.9.0, gated on #816 (private
// capability + report channel) and #817 (cross-machine sender identity). A classifier left
// exported with no consumer is the thing someone rewires by mistake, so it is not left.
//
// Exports pure, testable helpers:
//   - buildAutoSummary(session, opts): scrape last lines of output with redaction
//   - ANSI_STRIPPER_RE, SECRET_DENYLIST_RE: regex constants (exported for tests)

'use strict';

// ANSI stripper (matches session-state.js)
const ANSI_STRIPPER_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b\[[\?]?[0-9;]*[hlm]/g;

// Secret denylist — redact common credential patterns
const SECRET_DENYLIST_RE = /(api[_-]?key\s*[:=]\s*\S+|password\s*[:=]\s*\S+|token\s*[:=]\s*\S+|secret\s*[:=]\s*\S+)/gi;

// Default config (overridable via options)
const DEFAULT_AUTO_SUMMARY_LINES = 40;
const DEFAULT_AUTO_SUMMARY_MAX_BYTES = 4096;

/**
 * Build an auto_summary from a session's output ring.
 * - Strips ANSI sequences
 * - Filters blank lines
 * - Takes last N non-blank lines
 * - Redacts secrets via denylist regex
 * - Caps at max_bytes total (UTF-8 byte length)
 *
 * @param {Object} session — { outputRing: string[] }
 * @param {Object} [options]
 * @param {number} [options.maxLines] — default 40
 * @param {number} [options.maxBytes] — default 4096
 * @returns {string}
 */
function buildAutoSummary(session, options = {}) {
  const maxLines = options.maxLines || DEFAULT_AUTO_SUMMARY_LINES;
  const maxBytes = options.maxBytes || DEFAULT_AUTO_SUMMARY_MAX_BYTES;
  if (!session || !session.outputRing || session.outputRing.length === 0) return '';

  const raw = session.outputRing.join('');
  const stripped = raw.replace(ANSI_STRIPPER_RE, '');
  const lines = stripped.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  const tail = lines.slice(-maxLines);
  let joined = tail.join('\n');
  joined = joined.replace(SECRET_DENYLIST_RE, '[REDACTED]');
  if (Buffer.byteLength(joined, 'utf8') > maxBytes) {
    joined = joined.slice(0, maxBytes);
  }
  return joined;
}

module.exports = {
  buildAutoSummary,
  ANSI_STRIPPER_RE,
  SECRET_DENYLIST_RE,
  DEFAULT_AUTO_SUMMARY_LINES,
  DEFAULT_AUTO_SUMMARY_MAX_BYTES,
};
