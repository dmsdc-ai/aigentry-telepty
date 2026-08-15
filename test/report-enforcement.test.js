const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const reportEnforcement = require('../src/report-enforcement');
const {
  buildAutoSummary,
  SECRET_DENYLIST_RE,
} = reportEnforcement;

// ---------------- the deleted report classifier (#60 Stage A) ----------------
//
// This suite used to assert that report-shaped TEXT could be classified into an outcome:
// `REPORT:` → report_complete, `STATUS: blocked` → report_blocked, and so on. That claim is
// WITHDRAWN, not renamed. No text can authenticate its sender or correlate itself to a dispatch,
// so no text may name an outcome; `classifyReportPrompt`, REPORT_PREFIX_RE and the
// REPORT_STATUS_*_RE family are deleted, and their sole production caller
// (`resolveOutboundReportStatus`) is deleted with them. An authenticated, correlated validator
// returns in Stage B / 0.9.0 behind #816 + #817.
//
// So the migration pins the ABSENCE rather than a new spelling. That is the stronger assertion:
// the old tests only proved the classifier worked, while these fail the moment anyone re-exports
// it or wires a production caller back up — which is the actual way this regresses.

describe('report classifier removal (#60 Stage A)', () => {
  it('exports no report-text classifier', () => {
    assert.equal(reportEnforcement.classifyReportPrompt, undefined,
      'classifyReportPrompt must stay deleted — 0.8.0 classifies no report-shaped text');
  });

  it('exports no report-prefix or report-status matchers', () => {
    for (const name of ['REPORT_PREFIX_RE', 'REPORT_STATUS_BLOCKED_RE',
      'REPORT_STATUS_DISMISSED_RE', 'REPORT_STATUS_ERROR_RE']) {
      assert.equal(reportEnforcement[name], undefined, `${name} must stay deleted`);
    }
  });

  it('exports no outcome vocabulary at all', () => {
    // The four values the deleted classifier could return. None may reappear as an export,
    // under any name — a renamed classifier is the same claim in a different costume.
    const serialized = JSON.stringify(Object.entries(reportEnforcement)
      .map(([k, v]) => [k, typeof v === 'function' ? 'fn' : String(v)]));
    for (const outcome of ['report_complete', 'report_blocked', 'report_dismissed', 'report_error']) {
      assert.ok(!serialized.includes(outcome), `${outcome} must not appear in the export surface`);
    }
  });

  it('has no production consumer (source invariant)', () => {
    const root = path.join(__dirname, '..');
    const srcFiles = fs.readdirSync(path.join(root, 'src'), { recursive: true })
      .filter(f => typeof f === 'string' && /\.(js|mjs)$/.test(f))
      .map(f => path.join('src', f));
    const files = ['daemon.js', 'cli.js', 'session-state.js', 'mcp-server/index.mjs', ...srcFiles];
    for (const rel of files) {
      // Strip line comments: both surviving mentions of these names are prose explaining the
      // deletion, and prose is not a consumer.
      const code = fs.readFileSync(path.join(root, rel), 'utf8')
        .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
      assert.ok(!/classifyReportPrompt/.test(code),
        `${rel} must not reference the deleted classifier`);
      assert.ok(!/REPORT_(PREFIX|STATUS)_/.test(code),
        `${rel} must not reference the deleted report matchers`);
    }
  });
});

// ---------------- buildAutoSummary ----------------

describe('buildAutoSummary', () => {
  it('returns empty string for session with no outputRing', () => {
    assert.equal(buildAutoSummary(null), '');
    assert.equal(buildAutoSummary({}), '');
    assert.equal(buildAutoSummary({ outputRing: [] }), '');
  });

  it('strips ANSI color codes', () => {
    const session = { outputRing: ['\x1b[32mhello\x1b[0m\nworld\n'] };
    const summary = buildAutoSummary(session);
    assert.equal(summary, 'hello\nworld');
  });

  it('filters blank/whitespace-only lines', () => {
    const session = { outputRing: ['line1\n\n   \nline2\n\t\nline3\n'] };
    const summary = buildAutoSummary(session);
    assert.equal(summary, 'line1\nline2\nline3');
  });

  it('takes last N non-blank lines', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n');
    const session = { outputRing: [lines] };
    const summary = buildAutoSummary(session, { maxLines: 10 });
    const resultLines = summary.split('\n');
    assert.equal(resultLines.length, 10);
    assert.equal(resultLines[0], 'line90');
    assert.equal(resultLines[9], 'line99');
  });

  it('defaults to 40 lines max', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n');
    const session = { outputRing: [lines] };
    const summary = buildAutoSummary(session);
    assert.equal(summary.split('\n').length, 40);
  });

  it('caps at maxBytes', () => {
    const session = { outputRing: ['x'.repeat(10000)] };
    const summary = buildAutoSummary(session, { maxBytes: 100 });
    assert.ok(Buffer.byteLength(summary, 'utf8') <= 100);
  });

  it('redacts api_key=...', () => {
    const session = { outputRing: ['DEBUG: api_key=abc123xyz\ndone\n'] };
    const summary = buildAutoSummary(session);
    assert.ok(summary.includes('[REDACTED]'));
    assert.ok(!summary.includes('abc123xyz'));
  });

  it('redacts password=...', () => {
    const session = { outputRing: ['login: password=secret123\n'] };
    const summary = buildAutoSummary(session);
    assert.ok(summary.includes('[REDACTED]'));
    assert.ok(!summary.includes('secret123'));
  });

  it('redacts token=...', () => {
    const session = { outputRing: ['Authorization: token=ghp_abc123\n'] };
    const summary = buildAutoSummary(session);
    assert.ok(summary.includes('[REDACTED]'));
    assert.ok(!summary.includes('ghp_abc123'));
  });

  it('redacts secret=...', () => {
    const session = { outputRing: ['config: secret=xyz789\n'] };
    const summary = buildAutoSummary(session);
    assert.ok(summary.includes('[REDACTED]'));
    assert.ok(!summary.includes('xyz789'));
  });

  it('preserves non-sensitive content', () => {
    const session = { outputRing: ['Build complete\nTests passed: 42\n'] };
    const summary = buildAutoSummary(session);
    assert.equal(summary, 'Build complete\nTests passed: 42');
  });

  it('joins multiple outputRing entries', () => {
    const session = { outputRing: ['first\n', 'second\n', 'third\n'] };
    const summary = buildAutoSummary(session);
    assert.equal(summary, 'first\nsecond\nthird');
  });
});

// ---------------- regex exports ----------------

describe('regex exports', () => {
  // The REPORT_PREFIX_RE / REPORT_STATUS_*_RE cases that lived here are deleted with the
  // classifier; their absence is pinned above. SECRET_DENYLIST_RE is untouched by #60 — it
  // serves buildAutoSummary redaction, which measures nothing about task outcome.
  it('SECRET_DENYLIST_RE matches common secret patterns', () => {
    const samples = ['api_key=abc', 'api-key=xyz', 'password=pw', 'token=tk', 'secret=sc'];
    for (const s of samples) {
      SECRET_DENYLIST_RE.lastIndex = 0;
      assert.ok(SECRET_DENYLIST_RE.test(s), `should match ${s}`);
    }
  });
});
