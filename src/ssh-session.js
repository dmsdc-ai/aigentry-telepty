'use strict';
const crypto = require('node:crypto');
const registry = require('./prompt-symbol-registry');

const PHASES = new Set(['connecting', 'unknown', 'ready', 'awaiting_submit', 'busy', 'blocked', 'reconnecting']);
const SSH_BLOCKERS = /(?:password:|passphrase for key|are you sure you want to continue connecting|host key verification failed|remote host identification has changed|permission denied|authentication failed|connection refused|could not resolve hostname|update available|update now|loading sessions|resume a previous session)/ig;
const MAX_INPUT_BYTES = 256 * 1024;
const pendingWrites = new WeakMap();
const quote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
const text = (value, name, max = 4096) => {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Invalid ${name}.`);
  return value;
};
function number(value, name, min, max) {
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error(`Invalid ${name}: expected ${min}..${max}.`);
  return Number(value);
}

function buildSshPlan(argv) {
  const values = { interval: 15, count: 3, timeout: 10, backoff: 1000, max: 30000 };
  const target = text(argv[0], 'SSH target', 255);
  if (!/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?(?:[A-Za-z0-9_][A-Za-z0-9_.-]*|\[[A-Fa-f0-9:]+\])$/.test(target)) throw new Error('Invalid SSH target; use [user@]host and --port.');
  const flags = { '--id': 'id', '--remote-command': 'remoteCommand', '--cwd': 'cwd', '--resume': 'resume',
    '--port': 'port', '--server-alive-interval': 'interval', '--server-alive-count-max': 'count',
    '--connect-timeout': 'timeout', '--backoff-ms': 'backoff', '--backoff-max-ms': 'max' };
  let persistent = false; let remoteArgs = [];
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--persistent') { persistent = true; continue; }
    if (flag === '--') { remoteArgs = argv.slice(i + 1).map(v => text(v, 'remote argument')); break; }
    const key = flags[flag];
    if (!key || values[`set_${key}`]) throw new Error(`Unknown or repeated SSH option: ${flag}`);
    values[key] = text(argv[++i], flag); values[`set_${key}`] = true;
  }
  const id = text(values.id, 'session id', 128);
  if (id.startsWith('-') || !/^[A-Za-z0-9_.-]+$/.test(id)) throw new Error('Invalid SSH session id.');
  for (const [key, min, max] of [['interval',1,300],['count',1,10],['timeout',1,120],['backoff',10,30000],['max',10,60000]]) {
    values[key] = number(String(values[key]), key, min, max);
  }
  if (values.max < values.backoff) throw new Error('Backoff maximum must be at least the initial backoff.');
  if (values.port) values.port = number(values.port, 'port', 1, 65535);
  if (values.cwd && !values.remoteCommand) throw new Error('--cwd requires --remote-command.');
  if (remoteArgs.length && !values.remoteCommand) throw new Error('Remote arguments require --remote-command.');
  const agent = values.remoteCommand ? registry.commandKey(values.remoteCommand) : null;
  if (values.resume) {
    if (!['codex', 'claude'].includes(agent)) throw new Error('Explicit resume is supported only for declared Codex or Claude commands.');
    remoteArgs = agent === 'codex' ? ['resume', values.resume, ...remoteArgs] : ['--resume', values.resume, ...remoteArgs];
  }
  const args = ['-tt', '-o', 'BatchMode=yes', '-o', `ServerAliveInterval=${values.interval}`,
    '-o', `ServerAliveCountMax=${values.count}`, '-o', `ConnectTimeout=${values.timeout}`];
  if (values.port) args.push('-p', String(values.port));
  args.push(target);
  if (values.remoteCommand) {
    let script = `exec ${[values.remoteCommand, ...remoteArgs].map(quote).join(' ')}`;
    if (values.cwd) {
      const cwd = values.cwd === '~' ? '"$HOME"' : values.cwd.startsWith('~/')
        ? `"$HOME"/${quote(values.cwd.slice(2))}` : quote(values.cwd);
      script = `cd ${cwd} && ${script}`;
    }
    args.push(script);
  }
  const uri = `ssh://${target}${values.port ? `:${values.port}` : ''}/${(values.cwd || '').split('/').map(encodeURIComponent).join('/')}`;
  const metadata = { target, port: values.port || 22, agent, remote_cwd: values.cwd || null,
    uri, persistent, resume_requested: !!values.resume, identity: 'operator_declared',
    version_status: 'unsupported', remote_shell: 'posix' };
  return { id, command: 'ssh', args, persistent, backoffMs: values.backoff, backoffMaxMs: values.max, metadata };
}

function validateSshMetadata(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid SSH metadata.');
  const allowed = ['target','port','agent','remote_cwd','uri','persistent','resume_requested','identity','version_status','remote_shell'];
  if (Object.keys(value).some(k => !allowed.includes(k))) throw new Error('Invalid SSH metadata field.');
  text(value.target, 'SSH target', 255); text(value.uri, 'SSH URI', 8192);
  if (value.remote_cwd !== null) text(value.remote_cwd, 'remote cwd');
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535
      || (value.agent !== null && !['codex','claude','gemini'].includes(value.agent))
      || typeof value.persistent !== 'boolean' || typeof value.resume_requested !== 'boolean'
      || value.identity !== 'operator_declared' || value.version_status !== 'unsupported' || value.remote_shell !== 'posix') throw new Error('Invalid SSH metadata.');
  return { ...value };
}

function remoteAgentCommand(session) { return session.sshRemote ? session.sshRemote.agent || '' : session.command; }
function sshChildEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('TELEPTY_')));
}

function createSshInputState(agent, changed = () => {}) {
  let child = null, generation = 0, phase = 'connecting', reason = 'waiting_for_composer', tail = '', owed = false, expires = 0;
  const snapshot = () => ({ generation, phase, reason });
  const update = (next, why) => { phase = next; reason = why; changed(snapshot()); };
  return {
    snapshot,
    start(current) { child = current; generation++; tail = ''; owed = false; update('connecting', 'waiting_for_composer'); },
    exit(current) { if (current !== child) return; child = null; owed = false; tail = ''; update('reconnecting', 'ssh_child_exited'); },
    output(current, data) {
      if (current !== child) return false;
      if (phase === 'ready') tail = '';
      tail = (tail + data).slice(-20000);
      SSH_BLOCKERS.lastIndex = 0;
      let blocker, last = null;
      while ((blocker = SSH_BLOCKERS.exec(tail))) last = blocker;
      const afterBlocker = last ? tail.slice(last.index + last[0].length) : tail;
      const modal = registry.detectSurfaceModal(agent, afterBlocker);
      const hit = agent && registry.detectOutput(agent, afterBlocker);
      if (modal.blocked || (last && !hit?.found)) {
        owed = false; update('blocked', modal.blocked ? modal.reason : 'ssh_authentication_or_connection_blocked'); return false;
      }
      if (hit?.found) { update('ready', 'qualified_remote_composer'); return true; }
      update(owed ? 'awaiting_submit' : 'unknown', agent ? 'waiting_for_composer' : 'remote_agent_readiness_unsupported');
      return false;
    },
    localInput(current) {
      if (!child || current !== child) return false;
      owed = false; tail = ''; update('busy', 'operator_input'); return true;
    },
    write(current, data, write, nowMs = Date.now()) {
      if (!child || current !== child || phase === 'blocked' || phase === 'reconnecting') return { stage: 'refused', reason: 'ssh_not_ready' };
      const submit = data === '\r';
      if (submit ? !(owed && nowMs <= expires) : phase !== 'ready') return { stage: 'refused', reason: 'ssh_not_ready' };
      try {
        write(data);
        owed = !submit; expires = nowMs + 5000; tail = '';
        update(submit ? 'busy' : 'awaiting_submit', submit ? 'input_submitted' : 'input_written_awaiting_submit');
        return { stage: 'written' };
      } catch { owed = false; update('unknown', 'ssh_write_unconfirmed'); return { stage: 'unknown', reason: 'ssh_write_unconfirmed' }; }
    }
  };
}

function sshInputFailure(session, data, expectedGeneration) {
  if (!session?.sshRemote) return null;
  const s = session.sshState;
  const allowed = s && s.owner_generation === session.interactionOwnerGeneration
    && (!expectedGeneration || s.generation === expectedGeneration)
    && (data === '\r' ? s.phase === 'awaiting_submit' : s.phase === 'ready');
  return allowed ? null : { success: false, httpStatus: 409, code: 'SSH_NOT_READY', bytes_written: 0,
    error: 'SSH remote composer is not ready for this write; nothing was queued. Resolve authentication/bootstrap locally or wait for qualified readiness.',
    ssh_phase: s?.phase || 'connecting' };
}

function applySshState(session, message) {
  if (!session.sshRemote || !Number.isSafeInteger(message.generation) || message.generation < 1 || !PHASES.has(message.phase)) return false;
  const previous = session.sshState;
  if (previous?.owner_generation === session.interactionOwnerGeneration && message.generation < previous.generation) return false;
  session.sshState = { generation: message.generation, phase: message.phase,
    reason: typeof message.reason === 'string' ? message.reason.slice(0,128) : 'unknown',
    owner_generation: session.interactionOwnerGeneration, observed_at: new Date().toISOString() };
  return true;
}

function requestSshWrite(session, data, { timeoutMs = 3000, expectedGeneration } = {}) {
  const failure = sshInputFailure(session, data, expectedGeneration);
  if (failure) return Promise.resolve(failure);
  if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_INPUT_BYTES) return Promise.resolve({ success: false, httpStatus: 413, code: 'SSH_INPUT_TOO_LARGE', bytes_written: 0, error: 'SSH input exceeds 256 KiB.' });
  const owner = session.ownerWs; const generation = session.sshState.generation;
  if (!owner || owner.readyState !== 1) return Promise.resolve({ success: false, httpStatus: 503, code: 'DISCONNECTED', error: 'SSH bridge disconnected.' });
  let pending = pendingWrites.get(session);
  if (!pending) { pending = new Map(); pendingWrites.set(session, pending); }
  if (pending.size >= 32) return Promise.resolve({ success: false, httpStatus: 429, code: 'SSH_WRITE_CAPACITY', error: 'Too many pending SSH writes.' });
  return new Promise(resolve => {
    const request_id = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(request_id); resolve({ success: false, httpStatus: 504,
      code: 'SSH_WRITE_UNCONFIRMED', error: 'No current-child write receipt; input may have been written. Do not retry blindly.' }); }, timeoutMs);
    const finish = result => { clearTimeout(timer); pending.delete(request_id); resolve(result); };
    pending.set(request_id, { owner, generation, finish, bytes: Buffer.byteLength(data) });
    try { owner.send(JSON.stringify({ type: 'ssh_inject', request_id, generation, data })); }
    catch { finish({ success: false, httpStatus: 503, code: 'DISCONNECTED', bytes_written: 0, error: 'SSH bridge send failed.' }); }
  });
}

function acceptSshWriteReceipt(session, ws, message) {
  const pending = pendingWrites.get(session); const item = pending?.get(message.request_id);
  if (!item || item.owner !== ws || session.ownerWs !== ws || item.generation !== message.generation) return false;
  if (message.stage === 'written') item.finish({ success: true, strategy: 'ssh_bridge', bytes_written: item.bytes, consumption: 'unknown' });
  else if (message.stage === 'refused') item.finish({ success: false, httpStatus: 409, code: 'SSH_NOT_READY', bytes_written: 0, error: 'SSH bridge refused input; no bytes were written or queued.' });
  else if (message.stage === 'unknown') item.finish({ success: false, httpStatus: 504, code: 'SSH_WRITE_UNCONFIRMED', error: 'SSH child write was not confirmed. Do not retry blindly.' });
  else return false;
  return true;
}
module.exports = { buildSshPlan, validateSshMetadata, createSshInputState, sshInputFailure,
  applySshState, requestSshWrite, acceptSshWriteReceipt, sshChildEnvironment, remoteAgentCommand };
