'use strict';
const { parseBudget } = require('../screen-observation');
function screenQuery(args) {
  const json = args.includes('--json');
  const value = (flag, fallback) => {
    const index = args.indexOf(flag);
    if (index === -1) return fallback;
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${flag} requires a value`);
    return args[index + 1];
  };
  if (!json && (args.includes('--since') || args.includes('--max-bytes'))) throw new Error('--since and --max-bytes require --json');
  const lines = value('--lines', '50');
  if (json && (!/^[1-9]\d*$/.test(lines) || !Number.isSafeInteger(Number(lines)))) throw new Error('--lines must be a positive integer');
  const query = new URLSearchParams({ lines });
  if (args.includes('--raw')) query.set('raw', '1');
  if (json) {
    query.set('json', '1');
    query.set('max_bytes', String(parseBudget(value('--max-bytes', undefined))));
    const since = value('--since', undefined);
    if (since !== undefined) query.set('since', since);
  }
  return query.toString();
}
async function readScreen(args, { resolveTarget, daemonUrl, fetchWithAuth, print = console.log }) {
  const query = screenQuery(args);
  const sessionId = args[1];
  const target = await resolveTarget(sessionId);
  if (!target) throw new Error(`Session '${sessionId}' was not found on any discovered host.`);
  const response = await fetchWithAuth(`${daemonUrl(target.host)}/api/sessions/${encodeURIComponent(target.id)}/screen?${query}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  print(args.includes('--json') ? JSON.stringify(data) : data.screen || '(empty screen)');
}
module.exports = { screenQuery, readScreen };
