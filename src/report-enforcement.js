// src/report-enforcement.js — REPORT enforcement helpers (0.2.0)
// See specs/enforce-report-spec.md
//
// Exports pure, testable helpers:
//   - classifyReportPrompt(prompt): categorize an inject prompt
//   - buildAutoSummary(session, opts): scrape last lines of output with redaction
//   - ANSI_STRIPPER_RE, SECRET_DENYLIST_RE: regex constants (exported for tests)
//   - REPORT_PREFIX_RE, REPORT_STATUS_*_RE: classification regexes

'use strict';

// Prefix patterns that identify a content REPORT inject (reverse-match required)
const REPORT_PREFIX_RE = /^\s*(REPORT|STATUS|SPEC|OWNER-DIAGNOSIS|ENFORCE-SPEC|LOG-FIX-SPEC|LOG-FIX-IMPLEMENTED|FIX-SPEC|FIX-IMPLEMENTED|SPEC-SYNC|DIAGNOSIS|ENFORCE-IMPLEMENTED)[:\s]/;
const REPORT_STATUS_BLOCKED_RE = /^\s*STATUS:\s*blocked\b/i;
const REPORT_STATUS_DISMISSED_RE = /^\s*STATUS:\s*dismissed\b/i;
const REPORT_STATUS_ERROR_RE = /^\s*STATUS:\s*error\b/i;

// ANSI stripper (matches session-state.js)
const ANSI_STRIPPER_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b\[[\?]?[0-9;]*[hlm]/g;

// Secret denylist — redact common credential patterns
const SECRET_DENYLIST_RE = /(api[_-]?key\s*[:=]\s*\S+|password\s*[:=]\s*\S+|token\s*[:=]\s*\S+|secret\s*[:=]\s*\S+)/gi;

// Default config (overridable via options)
const DEFAULT_AUTO_SUMMARY_LINES = 40;
const DEFAULT_AUTO_SUMMARY_MAX_BYTES = 4096;

/**
 * Classify incoming inject prompt for REPORT enforcement.
 * Returns one of: 'report_dismissed', 'report_blocked', 'report_error',
 * 'report_complete', or null (not a report).
 *
 * Order matters: STATUS variants checked before generic prefix.
 */
function classifyReportPrompt(prompt) {
  if (typeof prompt !== 'string') return null;
  if (REPORT_STATUS_DISMISSED_RE.test(prompt)) return 'report_dismissed';
  if (REPORT_STATUS_BLOCKED_RE.test(prompt)) return 'report_blocked';
  if (REPORT_STATUS_ERROR_RE.test(prompt)) return 'report_error';
  if (REPORT_PREFIX_RE.test(prompt)) return 'report_complete';
  return null;
}

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
  classifyReportPrompt,
  buildAutoSummary,
  REPORT_PREFIX_RE,
  REPORT_STATUS_BLOCKED_RE,
  REPORT_STATUS_DISMISSED_RE,
  REPORT_STATUS_ERROR_RE,
  ANSI_STRIPPER_RE,
  SECRET_DENYLIST_RE,
  DEFAULT_AUTO_SUMMARY_LINES,
  DEFAULT_AUTO_SUMMARY_MAX_BYTES,
};
