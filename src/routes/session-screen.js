'use strict';
const { observeScreen, parseBudget } = require('../screen-observation');
const { stripAnsiForScreen } = require('../screen-ansi');
function createScreenHandler({ sessions, resolveSessionAlias }) {
function screenHandler(req, res) {
  const requestedId = req.params.id;
  const resolvedId = resolveSessionAlias(requestedId);
  if (!resolvedId) return res.status(404).json({ error: 'Session not found', requested: requestedId });
  const session = sessions[resolvedId];

  const lines = parseInt(req.query.lines) || 50;
  const raw = req.query.raw === '1' || req.query.raw === 'true';

  const observation = req.query.json === '1' || req.query.json === 'true';
  if (observation) {
    try { parseBudget(req.query.max_bytes); } catch (error) { return res.status(400).json({ error: error.message }); }
    if (!/^[1-9]\d*$/.test(String(req.query.lines ?? 50)) || !Number.isSafeInteger(Number(req.query.lines ?? 50))) {
      return res.status(400).json({ error: 'lines must be a positive integer' });
    }
  }
  if ((!session.outputRing || session.outputRing.length === 0) && !observation) {
    return res.json({ session_id: resolvedId, screen: '', lines: 0, raw: false });
  }

  // Join all buffered output
  const fullOutput = (session.outputRing || []).join('');

  const cleaned = raw ? fullOutput : stripAnsiForScreen(fullOutput);

  // Take last N lines
  const allLines = cleaned.split('\n');
  const lastLines = allLines.slice(-lines);
  const screen = lastLines.join('\n').trim();

  if (observation) return res.json(observeScreen(session, { sessionId: resolvedId, screen, raw,
    lines, since: req.query.since, maxBytes: req.query.max_bytes, rollover: session.outputRingRollover || 0 }));

  res.json({
    session_id: resolvedId,
    screen,
    lines: lastLines.length,
    total_lines: allLines.length,
    raw: !!raw
  });
}
return screenHandler;
}
module.exports = { createScreenHandler };
