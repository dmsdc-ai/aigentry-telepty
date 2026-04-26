const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyReportPrompt,
  buildAutoSummary,
  REPORT_PREFIX_RE,
  REPORT_STATUS_BLOCKED_RE,
  REPORT_STATUS_DISMISSED_RE,
  SECRET_DENYLIST_RE,
} = require('../src/report-enforcement');

// ---------------- classifyReportPrompt ----------------

describe('classifyReportPrompt', () => {
  it('classifies REPORT: prefix as report_complete', () => {
    assert.equal(classifyReportPrompt('REPORT: files=x | result=ok'), 'report_complete');
  });

  it('classifies STATUS: blocked as report_blocked', () => {
    assert.equal(classifyReportPrompt('STATUS: blocked waiting on review'), 'report_blocked');
  });

  it('classifies STATUS: dismissed as report_dismissed', () => {
    assert.equal(classifyReportPrompt('STATUS: dismissed by orchestrator'), 'report_dismissed');
  });

  it('classifies STATUS: error as report_error', () => {
    assert.equal(classifyReportPrompt('STATUS: error build failed'), 'report_error');
  });

  it('classifies SPEC: prefix as report_complete', () => {
    assert.equal(classifyReportPrompt('SPEC: some architectural spec'), 'report_complete');
  });

  it('classifies ENFORCE-SPEC: as report_complete', () => {
    assert.equal(classifyReportPrompt('ENFORCE-SPEC: approach C'), 'report_complete');
  });

  it('classifies ENFORCE-IMPLEMENTED: as report_complete', () => {
    assert.equal(classifyReportPrompt('ENFORCE-IMPLEMENTED: files=daemon.js'), 'report_complete');
  });

  it('classifies OWNER-DIAGNOSIS: as report_complete', () => {
    assert.equal(classifyReportPrompt('OWNER-DIAGNOSIS: root cause'), 'report_complete');
  });

  it('returns null for plain text prompt', () => {
    assert.equal(classifyReportPrompt('please fix the bug'), null);
  });

  it('returns null for non-string input', () => {
    assert.equal(classifyReportPrompt(null), null);
    assert.equal(classifyReportPrompt(undefined), null);
    assert.equal(classifyReportPrompt(42), null);
  });

  it('allows leading whitespace', () => {
    assert.equal(classifyReportPrompt('   REPORT: trimmed'), 'report_complete');
  });

  it('STATUS variants beat generic REPORT prefix (ordering)', () => {
    // STATUS: blocked should win, not generic report_complete
    assert.equal(classifyReportPrompt('STATUS: blocked'), 'report_blocked');
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
  it('REPORT_PREFIX_RE matches expected prefixes', () => {
    const prefixes = ['REPORT:', 'STATUS:', 'SPEC:', 'OWNER-DIAGNOSIS:', 'ENFORCE-SPEC:',
      'LOG-FIX-SPEC:', 'LOG-FIX-IMPLEMENTED:', 'FIX-SPEC:', 'FIX-IMPLEMENTED:',
      'SPEC-SYNC:', 'DIAGNOSIS:', 'ENFORCE-IMPLEMENTED:'];
    for (const p of prefixes) {
      assert.ok(REPORT_PREFIX_RE.test(`${p} body`), `should match ${p}`);
    }
  });

  it('REPORT_STATUS_BLOCKED_RE matches case-insensitively', () => {
    assert.ok(REPORT_STATUS_BLOCKED_RE.test('STATUS: blocked'));
    assert.ok(REPORT_STATUS_BLOCKED_RE.test('status: blocked'));
    assert.ok(REPORT_STATUS_BLOCKED_RE.test('STATUS: BLOCKED'));
  });

  it('REPORT_STATUS_DISMISSED_RE matches dismissed state', () => {
    assert.ok(REPORT_STATUS_DISMISSED_RE.test('STATUS: dismissed'));
    assert.ok(!REPORT_STATUS_DISMISSED_RE.test('STATUS: blocked'));
  });

  it('SECRET_DENYLIST_RE matches common secret patterns', () => {
    const samples = ['api_key=abc', 'api-key=xyz', 'password=pw', 'token=tk', 'secret=sc'];
    for (const s of samples) {
      SECRET_DENYLIST_RE.lastIndex = 0;
      assert.ok(SECRET_DENYLIST_RE.test(s), `should match ${s}`);
    }
  });
});
