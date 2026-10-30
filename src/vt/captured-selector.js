'use strict';
const { SessionScreen } = require('./session-screen');
const interaction = require('../interaction');
const PROFILE = 'claude-2.1.220-captured-color-v1';
const CODEX_PROFILE = 'codex-0.144.1-captured-update-v1';
// Exact normalized capture from test/claude-modal-inject-760.test.js. This is
// reconstructed VT input, not a claim that the original raw ANSI dump survived.
const COLOR_LINES = ['thought for 1s)', 'n65', '90', '─'.repeat(120),
  '☐ Color choice', 'Which color do you prefer?', '❯ 1. Red', 'A warm, boldcolor',
  '2. Blue', 'A cool, calm color', '3.Typesomething.', '─'.repeat(120),
  '4.Chataboutthis', 'Entertoselect·↑/↓tonavigate·Esctocancel'];
const providerObservations = new WeakMap();
const SENSITIVE = /trust|permission|approv|update available|update now|resume|authenticat|sign.?in|sandbox|execute|auto.accept|proceed/i;
function bindingForSession(s) {
  if(require('../principal/cooperative-handoff').activeHandoff(s))return null;
  if (!s || s.sessionEpochProved !== s.sessionEpoch || !s.ownerWs || s.ownerWs.readyState !== 1) return null;
  return { sid: s.id, session_epoch: s.sessionEpoch, credential_generation: s.credentialGeneration || 1,
    owner_generation: s.interactionOwnerGeneration, input_generation: s.interactionInputGeneration || 0,
    geometry_generation: s.interactionGeometryGeneration || 0, surface_id: s.cmuxSurfaceId || s.id,
    cols: s.cols, rows: s.rows };
}
function supportedProfile(profile) { return [PROFILE, CODEX_PROFILE].includes(profile); }
function fence(binding) {
  if (!binding) return null;
  return Object.fromEntries(['sid', 'session_epoch', 'credential_generation', 'owner_generation',
    'input_generation', 'geometry_generation', 'surface_id', 'cols', 'rows'].map(key => [key, binding[key]]));
}
function createCapturedSelector({ profile, binding, cols, rows, sessionId, streamId, localSource = true, now = Date.now }) {
  if (!supportedProfile(profile)) return null;
  const screen = new SessionScreen({ sessionId, cause: 'stream_origin', localSource, streamId,
    cols, rows, geometrySource: localSource ? 'local_pty' : 'bridge_reported' });
  let lastOutputBinding = null, geometry = { cols, rows }, disposed = false, consumedFrame = null;
  return {
    profile, screen,
    feed(data, meta) {
      if (disposed || typeof data !== 'string' || data.length === 0) return;
      const current = fence(binding());
      if (!current) return;
      if (geometry.cols !== current.cols || geometry.rows !== current.rows) {
        screen.noteGeometry({ cols: current.cols, rows: current.rows, source: localSource ? 'local_pty' : 'bridge_reported', streamId });
        geometry = { cols: current.cols, rows: current.rows };
      }
      lastOutputBinding = current;
      screen.noteOutput(data, meta);
    },
    observe() {
      const current = fence(binding());
      const unavailable = () => interaction.unavailableObservation();
      if (disposed || !current || !lastOutputBinding || interaction.digest(current) !== interaction.digest(lastOutputBinding)) return unavailable();
      const frame = screen.readFrameSync();
      if (frame.observation_basis !== 'vt_grid' || frame.snapshot_truncated || frame.cols !== current.cols || frame.rows !== current.rows) return unavailable();
      const lines = frame.rows_text.map(line => line.trim()).filter(Boolean);
      const text = lines.join('\n');
      const base = { ...current, available: true, current_frame: true, provenance: 'measured-provider',
        provider: profile, provider_version: profile === PROFILE ? '2.1.220' : '0.144.1',
        version_evidence: 'operator-selected-captured-profile', native_behavior_verified: false,
        expires_at: now() + 2000, frame_digest: interaction.digest({ profile, cols: frame.cols, rows: frame.rows,
          screen: frame.screen_kind, stream: frame.stream_id, generation: frame.vt_generation, cursor: frame.cursor, lines: frame.rows_text }),
        supported_operations: [], option_ids: [], routine: false, mode: 'unknown' };
      base.prompt_revision = interaction.digest({ profile, frame: base.frame_digest, generation: current.input_generation });
      base.question_id = profile === PROFILE ? 'claude-color-2.1.220-v1' : 'codex-update-0.144.1-v1';
      if (SENSITIVE.test(text)) return { ...base, mode: 'permission_trust', reason: 'authority_required' };
      if (profile !== PROFILE || interaction.digest(lines) !== interaction.digest(COLOR_LINES)) return unavailable();
      if (consumedFrame === base.frame_digest) return { ...base, reason: 'stale_prompt' };
      const observation = { ...base, routine: true, mode: 'single_select', supported_operations: ['select'], option_ids: ['red', 'blue'] };
      providerObservations.set(observation, () => {
        if (disposed || consumedFrame === base.frame_digest) return false;
        consumedFrame = base.frame_digest; // a partial/unknown write must never become retry authority
        return true;
      });
      return observation;
    },
    dispose() { disposed = true; lastOutputBinding = null; screen.dispose(); }
  };
}
function encodeCapturedSelector(request, observation) {
  if (observation?.provider !== PROFILE || observation.routine !== true || observation.mode !== 'single_select'
      || request.operation !== 'select' || !observation.option_ids?.includes(request.value)) return null;
  const consume = providerObservations.get(observation);
  if (!consume || !consume()) return null;
  return request.value === 'red' ? '\r' : '\x1b[B\r';
}
module.exports = { PROFILE, CODEX_PROFILE, supportedProfile, createCapturedSelector, encodeCapturedSelector, bindingForSession };
