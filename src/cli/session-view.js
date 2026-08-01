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

// #60 Stage A §8.5 — presentation for the external activity vocabulary.
//
// Keyed by TONE, which the daemon already decided (session-state.js OBSERVATION_DISPLAY) and
// serializes beside the observation. Keying on tone rather than re-deriving from the kind means a
// daemon that emits an observation this CLI has never heard of still renders with the daemon's own
// styling instead of falling through to a default that flatters it.
//
// There is deliberately NO green. STATE_DISPLAY maps internal `idle` to a green sleeping pill and
// every consumer downstream — the cmux sidebar especially — reads that green as "the task
// succeeded". Quiet is not success; it is the absence of bytes. Nothing in this table may claim
// otherwise.
const OBSERVATION_TONE_COLOR = Object.freeze({
  neutral:   '\x1b[90m',  // gray  — quiet, prompt-shaped, OSC marker, manual mark
  active:    '\x1b[36m',  // cyan  — output/busy markers
  attention: '\x1b[33m',  // yellow— input request, classification timeout
  pending:   '\x1b[33m',  // yellow— start/restart phase
  error:     '\x1b[31m',  // red   — repeated error, process exit
});

// Fails to NEUTRAL, never to success styling. §8.5.12: delete a mapping or inject an unknown name
// and the result must still be a neutral observation, not a fallback to the internal `idle` pill.
function observationTone(tone) {
  return OBSERVATION_TONE_COLOR[tone] || OBSERVATION_TONE_COLOR.neutral;
}

/**
 * One line of activity observation, styled by the daemon's tone.
 *
 * Renders the measured KIND — never an internal FSM state name, never a word that answers "is the
 * task done". An absent observation is stated as an absence rather than omitted, because an empty
 * column reads as "nothing is wrong" (that is exactly the blank this cutover shipped when cli.js
 * kept reading the removed `autoState`).
 */
function formatActivityObservation(observation) {
  const reset = '\x1b[0m';
  if (!observation || !observation.kind) {
    return `${OBSERVATION_TONE_COLOR.neutral}no activity observation${reset}`;
  }
  const color = observationTone(observation.tone);
  const emoji = observation.emoji ? `${observation.emoji} ` : '';
  return `${color}${emoji}${observation.kind}${reset}`;
}

// §A4 — the capability gap, stated outright. A reader who is not told the outcome protocol is
// unavailable will read the activity line as the answer to "is it finished".
function formatOutcomeProtocol(completion) {
  const capability = (completion && completion.capability) || {};
  const state = capability.outcome_protocol || 'unavailable';
  const reason = capability.outcome_protocol_reason === 'stage_b_deferred_to_0.9.0'
    ? 'Stage B deferred: #816, #817'
    : (capability.outcome_protocol_reason || 'stage_b_deferred_to_0.9.0');
  return `${state} (${reason})`;
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
  printSessionInfo,
  // #60 Stage A
  OBSERVATION_TONE_COLOR,
  observationTone,
  formatActivityObservation,
  formatOutcomeProtocol
};
