'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lifecycle = require('../src/lifecycle');
const { loadTeleptyConfig } = require('../src/config-file');
const { createSessionId, startTestDaemon, waitFor } = require('../test-support/daemon-harness');

function collectJsonMessages(ws) {
  const messages = [];
  ws.on('message', (chunk) => {
    try {
      messages.push(JSON.parse(chunk.toString()));
    } catch {}
  });
  return messages;
}

test('config parser loads idle_ttl_default from config.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-config-'));
  try {
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ idle_ttl_default: '24h' }), 'utf8');
    const config = loadTeleptyConfig({ configDir: dir });
    assert.equal(config.path, configPath);
    assert.equal(config.idleTtlDefaultMs, 24 * 60 * 60 * 1000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('config parser supports simple config.yaml without js-yaml dependency', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-config-'));
  try {
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'idle_ttl_default: 30m\n', 'utf8');
    const config = loadTeleptyConfig({ configDir: dir });
    assert.equal(config.idleTtlDefaultMs, 30 * 60 * 1000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('duration parser rejects malformed idle TTL values', () => {
  assert.throws(
    () => lifecycle.parseDuration('soon', { fieldName: 'idle_ttl' }),
    /idle_ttl must be a duration/
  );
});

test('per-session idle TTL overrides config default', () => {
  const session = { idleTtlMs: 60 * 60 * 1000 };
  const config = { idleTtlDefaultMs: 24 * 60 * 60 * 1000 };
  assert.equal(lifecycle.effectiveIdleTtlMs(session, config), 60 * 60 * 1000);
});

test('daemon idle reaper removes a session whose per-session TTL is exceeded and emits tracing', async () => {
  const harness = await startTestDaemon({
    env: {
      TELEPTY_IDLE_REAPER_POLL_MS: '100',
      TELEPTY_HEALTH_POLL_MS: '1000',
      // #916.4: the reaper now defaults to WARN-ONLY — it names its victims and kills nothing.
      // This test asserts the KILL semantics, so it must ask for them explicitly. That the
      // default no longer reaps is the point of the block-4 change, not a regression here.
      TELEPTY_IDLE_TTL_MODE: 'enforce'
    }
  });

  try {
    const bus = await harness.connectBus();
    const messages = collectJsonMessages(bus);
    const sessionId = createSessionId('idle-ttl-reap');
    const old = new Date(Date.now() - 5000).toISOString();

    const register = await harness.registerSession(sessionId, {
      idle_ttl: '100ms',
      last_activity_at: old
    });
    assert.equal(register.status, 201);

    await waitFor(async () => {
      const list = await harness.request('/api/sessions');
      return list.body.every((session) => session.id !== sessionId);
    }, { timeoutMs: 5000, description: 'idle TTL reaper removal' });

    assert.ok(messages.some((message) => (
      message.type === 'tracing' &&
      message.session_id === sessionId &&
      message.action === 'idle_ttl_auto_kill' &&
      message.idle_duration_seconds >= 5
    )), 'expected idle_ttl_auto_kill tracing event');
    bus.close();
  } finally {
    await harness.stop();
  }
});

test('daemon rejects malformed per-session idle TTL on register', async () => {
  const harness = await startTestDaemon();
  try {
    const result = await harness.registerSession(createSessionId('bad-idle-ttl'), {
      idle_ttl: 'forever'
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'INVALID_IDLE_TTL');
  } finally {
    await harness.stop();
  }
});
