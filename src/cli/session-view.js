const { formatHostLabel } = require('../../session-routing');
const lifecycle = require('../lifecycle');

function detectTerminalProgram(env = process.env) {
  const rawTermProgram = typeof env.TERM_PROGRAM === 'string' ? env.TERM_PROGRAM.trim() : '';
  if (rawTermProgram) {
    return rawTermProgram;
  }

  if (env.TMUX) {
    return 'tmux';
  }

  const term = typeof env.TERM === 'string' ? env.TERM.toLowerCase() : '';
  if (term.includes('kitty')) return 'kitty';
  if (term.includes('ghostty')) return 'ghostty';
  if (term.includes('tmux')) return 'tmux';

  return null;
}

function formatSessionTerminal(session) {
  const terminal = session.terminal || session.termProgram || null;
  const term = session.term || null;
  if (terminal && term) {
    return `${terminal} (${term})`;
  }
  return terminal || term || 'unknown';
}

function formatSessionHealth(session) {
  const status = session.healthStatus || 'UNKNOWN';
  const reason = session.healthReason || null;
  if (reason && reason !== status) {
    return `${status} (${reason})`;
  }
  return status;
}

function enrichSessionIdle(session, nowMs = Date.now()) {
  const idleSeconds = typeof session.idleSeconds === 'number'
    ? session.idleSeconds
    : lifecycle.computeIdleSeconds(session.lastActivityAt, nowMs);
  return {
    ...session,
    idleSeconds,
    idle_seconds: idleSeconds
  };
}

function formatSessionStatusWithIdle(session) {
  const base = formatSessionHealth(session);
  const idleSeconds = typeof session.idleSeconds === 'number' ? session.idleSeconds : null;
  if (idleSeconds !== null && idleSeconds > 60) {
    return `${base} 💤 idle (${lifecycle.formatIdleDuration(idleSeconds)})`;
  }
  return base;
}

function printSessionInfo(session, options = {}) {
  const host = options.host || session.host || '127.0.0.1';
  console.log('\x1b[1mSession Info:\x1b[0m');
  console.log(`  - ID: \x1b[36m${session.id}\x1b[0m`);
  console.log(`    Host: ${formatHostLabel(host)}`);
  console.log(`    Command: ${session.command}`);
  console.log(`    Type: ${session.type || 'unknown'}`);
  console.log(`    Status: ${formatSessionHealth(session)}`);
  console.log(`    Terminal: ${session.terminal || session.termProgram || 'unknown'}`);
  console.log(`    TERM: ${session.term || 'n/a'}`);
  console.log(`    CWD: ${session.cwd}`);
  console.log(`    Clients: ${session.active_clients ?? 0}`);
  if (session.createdAt) {
    console.log(`    Started: ${new Date(session.createdAt).toLocaleString()}`);
  }
  if (session.lastActivityAt) {
    console.log(`    Last Activity: ${new Date(session.lastActivityAt).toLocaleString()}`);
  }
  if (typeof session.idleSeconds === 'number') {
    console.log(`    Idle: ${session.idleSeconds}s`);
  }
  if (session.semantic && session.semantic.phase) {
    console.log(`    Phase: ${session.semantic.phase}`);
  }
  if (session.semantic && session.semantic.current_task) {
    console.log(`    Current Task: ${session.semantic.current_task}`);
  }
  if (session.semantic && session.semantic.blocker) {
    console.log(`    Blocker: ${session.semantic.blocker}`);
  }
  console.log('');
}

module.exports = {
  detectTerminalProgram,
  formatSessionTerminal,
  formatSessionHealth,
  enrichSessionIdle,
  formatSessionStatusWithIdle,
  printSessionInfo
};
