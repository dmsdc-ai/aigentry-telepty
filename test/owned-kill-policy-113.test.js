'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestDaemon, createSessionId } = require('../test-support/daemon-harness');
let daemon;
before(async () => { daemon = await startTestDaemon(); });
after(async () => { if (daemon) await daemon.stop(); });
async function register(protectedSession = false, sid = createSessionId('ownedkill')) {
  const result = await daemon.registerSession(sid, { command: 'test', ...(protectedSession ? { require_owner_proof: true } : {}) });
  assert.equal(result.status, 201); return { sid, token: result.body.session_token };
}
async function kill(sid, token, suffix = '?owned=true') {
  return daemon.request(`/api/sessions/${encodeURIComponent(sid)}/kill${suffix}`, { method: 'POST',
    headers: token ? { 'x-telepty-session-token': token } : {}, body: { timeout: 0 } });
}
test('owned kill refuses missing, foreign and stale bearers without removing target; owner succeeds', async () => {
  const target = await register(); const foreign = await register();
  for (const token of [undefined, foreign.token, 'stale.invalid']) {
    const result = await kill(target.sid, token);
    assert.equal(result.status, 403);
    assert.equal((await daemon.request(`/api/sessions/${target.sid}`)).status, 200);
  }
  assert.equal((await kill(target.sid, target.token)).status, 200);
  assert.equal((await daemon.request(`/api/sessions/${target.sid}`)).status, 404);
  await register(false, target.sid);
  assert.equal((await kill(target.sid, target.token)).status, 403);
});
test('owned kill refuses aliases even when the sole sibling is owned', async () => {
  const sid = createSessionId('aliasowner') + '-001'; const target = await register(false, sid);
  assert.equal((await kill(sid.replace(/-001$/, ''), target.token)).status, 404);
  assert.equal((await daemon.request(`/api/sessions/${sid}`)).status, 200);
});
test('protected-session kill and delete always require exact owner proof; policy cannot be disabled', async () => {
  const target = await register(true);
  assert.equal((await kill(target.sid, undefined, '')).status, 403);
  assert.equal((await daemon.request(`/api/sessions/${target.sid}`, { method: 'DELETE' })).status, 403);
  const changed = await daemon.request('/api/sessions/register', { method: 'POST',
    headers: { 'x-telepty-session-token': target.token }, body: { session_id: target.sid, require_owner_proof: false } });
  assert.equal(changed.status, 409);
  const unowned = await daemon.request('/api/sessions/register', { method: 'POST', body: { session_id: target.sid, command: 'replacement' } });
  assert.equal(unowned.status, 403);
  assert.equal((await kill(target.sid, target.token, '')).status, 200);
});
test('legacy operator kill remains available by default', async () => {
  const target = await register(); assert.equal((await kill(target.sid, undefined, '')).status, 200);
});
