'use strict';
const fs = require('node:fs');
function processState(pid, { platform = process.platform, read = file => {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { const bytes = Buffer.alloc(4097); const size = fs.readSync(fd, bytes, 0, bytes.length, 0); if (size > 4096) throw Object.assign(Error(), { code: 'BUDGET' }); return bytes.subarray(0, size).toString('utf8'); }
  finally { fs.closeSync(fd); }
}, now = Date.now } = {}) {
  const unknown = reason => ({ status: 'unknown', reason, source: platform === 'linux' ? 'linux_proc_stat' : 'unsupported_platform', observed_at: new Date(now()).toISOString() });
  if (platform !== 'linux') return unknown('scheduler_state_unavailable_on_platform');
  if (!Number.isSafeInteger(pid) || pid <= 0) return unknown('pid_unavailable');
  try {
    const value = read(`/proc/${pid}/stat`);
    if (Buffer.byteLength(value) > 4096) return unknown('process_stat_budget_exceeded');
    // comm may contain spaces and parentheses; fields start after its final closing parenthesis.
    const end = value.lastIndexOf(')'), match = value.slice(end + 1).match(/^\s+([A-Za-z])\s/);
    const states = { R: 'running', S: 'sleeping', D: 'uninterruptible_sleep', T: 'stopped', t: 'tracing_stop', Z: 'zombie', X: 'dead', I: 'idle' };
    if (end < 0 || !value.startsWith(`${pid} (`) || !match || !states[match[1]]) return unknown('unrecognized_process_stat');
    return { status: 'observed', state: states[match[1]], source: 'linux_proc_stat', observed_at: new Date(now()).toISOString(),
      identity: 'pid_only_not_process_start_identity', reason: 'scheduler_snapshot_does_not_establish_agent_responsiveness_or_provider_health' };
  } catch (error) { return unknown(['EACCES','EPERM'].includes(error.code) ? 'permission_denied' : error.code === 'ENOENT' ? 'process_not_found' : error.code === 'BUDGET' ? 'process_stat_budget_exceeded' : 'process_inspection_unavailable'); }
}
module.exports = { processState };
