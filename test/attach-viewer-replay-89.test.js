'use strict';

// #89 — `telepty attach` to a live, idle TUI session joined BLANK.
//
// The daemon held the screen: `outputRing` (what GET /api/sessions/:id/screen renders) had it, and
// the viewer socket was attached (`[WS] Client attached ... (Total: 2)`). But the viewer branch of
// the WS connect handler only logged. A viewer got `output` frames relayed from the owner from that
// moment on — and an idle TUI emits none, while the frames it does emit later are cursor-relative
// diffs against a screen the viewer never received.
//
// What this pins: a viewer that attaches to a wrapped session with a non-empty ring is sent the
// ring tail, from the last full-screen reset, as an ordinary `output` frame BEFORE any live frame;
// every later viewer gets its own; the owner socket gets nothing. The first-frame assertion is the
// mutation check — with the replay removed, the viewer's first frame is the live one.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

const { outputRingReplay } = require('../src/transport/websocket');
const { startTestDaemon, createSessionId } = require('../test-support/daemon-harness');

const ESC = '\x1b';

// --- unit: the slicing policy, no sockets -------------------------------------------------

test('no reset marker: the whole ring is replayed', () => {
  assert.equal(outputRingReplay(['$ ls\r\n', 'a b c\r\n', '$ ']), '$ ls\r\na b c\r\n$ ');
});

test('ESC[2J: replay starts at the LAST one', () => {
  const ring = ['old', `${ESC}[2Jfirst screen`, 'x', `${ESC}[2Jsecond screen`, ' tail'];
  assert.equal(outputRingReplay(ring), `${ESC}[2Jsecond screen tail`);
});

test('ESC[H ESC[2J: replay starts at the ESC[H, not inside the pair', () => {
  const ring = ['old', `${ESC}[H${ESC}[2Jfirst`, `junk${ESC}[H${ESC}[2Jsecond`, ' tail'];
  assert.equal(outputRingReplay(ring), `${ESC}[H${ESC}[2Jsecond tail`);
});

test('ESC c (RIS): replay starts at the last one', () => {
  const ring = [`${ESC}cone`, 'mid', `${ESC}ctwo`, ' tail'];
  assert.equal(outputRingReplay(ring), `${ESC}ctwo tail`);
});

test('ESC[?1049h (alternate screen enter): replay starts at the last one', () => {
  const ring = ['shell prompt$ vim\r\n', `${ESC}[?1049h${ESC}[1;1Hbuffer`, ' tail'];
  assert.equal(outputRingReplay(ring), `${ESC}[?1049h${ESC}[1;1Hbuffer tail`);
});

test('the latest marker wins across marker kinds', () => {
  const ring = [`${ESC}[?1049hA`, `${ESC}[2JB`, `${ESC}cC`, ' tail'];
  assert.equal(outputRingReplay(ring), `${ESC}cC tail`);
  assert.equal(outputRingReplay([`${ESC}cC`, `${ESC}[2JB`, ' tail']), `${ESC}[2JB tail`);
});

test('a marker split across a chunk boundary is found (the ring is joined first)', () => {
  assert.equal(outputRingReplay(['old', `x${ESC}[`, `2Jnew`, ' tail']), `${ESC}[2Jnew tail`);
  assert.equal(outputRingReplay(['old', `x${ESC}[H${ESC}`, `[2Jnew`]), `${ESC}[H${ESC}[2Jnew`);
  assert.equal(outputRingReplay(['old', `x${ESC}[?10`, `49hnew`]), `${ESC}[?1049hnew`);
  assert.equal(outputRingReplay(['old', `x${ESC}`, `cnew`]), `${ESC}cnew`);
});

test('an empty ring replays nothing', () => {
  assert.equal(outputRingReplay([]), '');
  assert.equal(outputRingReplay(['', '']), '');
  assert.equal(outputRingReplay(undefined), '');
});

// --- integration: a real daemon, a real owner socket, real viewer sockets ------------------

// Scoped to this block so the unit tests above never depend on a daemon starting.
describe('#89 viewer replay over a live daemon', () => {
  let daemon;

  before(async () => {
    daemon = await startTestDaemon();
  });

  after(async () => { if (daemon) await daemon.stop(); });

  // Collect from BEFORE 'open': the replay is sent synchronously in the server's connect handler,
  // so it can arrive in the same read as the handshake. A listener attached after `await open`
  // could miss it and report a false RED.
  function openCollecting(sessionId, wsOptions, query = '') {
    const url = `ws://${daemon.host}:${daemon.port}/api/sessions/${encodeURIComponent(sessionId)}`
      + `?token=${encodeURIComponent(daemon.authToken())}${query}`;
    const ws = new WebSocket(url, wsOptions);
    const frames = [];
    ws.on('message', (buf) => {
      try { frames.push(JSON.parse(buf.toString())); } catch {}
    });
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve({ ws, frames }));
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => reject(new Error(`upgrade refused ${res.statusCode}`)));
    });
  }

  function outputs(frames) {
    return frames.filter((f) => f.type === 'output');
  }

  async function rawScreen(sid) {
    const res = await daemon.request(`/api/sessions/${encodeURIComponent(sid)}/screen?raw=1&lines=1000`);
    return res.body && typeof res.body.screen === 'string' ? res.body.screen : '';
  }

  test('a viewer attaching after output gets the ring replay FIRST, then live frames; the owner gets none', async () => {
    const sid = createSessionId('replay89');
    const reg = await daemon.registerSession(sid);
    assert.ok([200, 201].includes(reg.status), `register: ${reg.status}`);

    const owner = await openCollecting(sid, daemon.ownerAuth(sid),
      `&owner=1&owner_pid=${process.pid}&command=test-wrap`);
    try {
      // A TUI that drew a screen, then cleared and redrew, then went idle.
      owner.ws.send(JSON.stringify({ type: 'output', data: 'boot noise\r\n' }));
      owner.ws.send(JSON.stringify({ type: 'output', data: `${ESC}[H${ESC}[2JSCREEN-A` }));
      owner.ws.send(JSON.stringify({ type: 'output', data: ' idle-prompt> ' }));
      await daemon.waitFor(async () => (await rawScreen(sid)).includes('idle-prompt>'),
        { timeoutMs: 4000, description: 'owner frames to reach the ring' });

      const v1 = await openCollecting(sid);
      try {
        await daemon.waitFor(() => outputs(v1.frames).length >= 1,
          { timeoutMs: 3000, description: 'viewer 1 replay frame' });

        owner.ws.send(JSON.stringify({ type: 'output', data: 'LIVE-1' }));
        await daemon.waitFor(() => outputs(v1.frames).length >= 2,
          { timeoutMs: 3000, description: 'viewer 1 live frame' });

        const v1Out = outputs(v1.frames);
        assert.equal(v1Out[0].data, `${ESC}[H${ESC}[2JSCREEN-A idle-prompt> `,
          'the FIRST frame a viewer gets is the screen it joined, from the last reset');
        assert.equal(v1Out[1].data, 'LIVE-1', 'live frames follow the replay');
        assert.equal(v1Out.length, 2, 'one replay, then the live frame — nothing replayed twice');

        // A later viewer gets its OWN replay, which now includes what went live since.
        const v2 = await openCollecting(sid);
        try {
          await daemon.waitFor(() => outputs(v2.frames).length >= 1,
            { timeoutMs: 3000, description: 'viewer 2 replay frame' });
          assert.equal(outputs(v2.frames)[0].data, `${ESC}[H${ESC}[2JSCREEN-A idle-prompt> LIVE-1`);

          // v1 must not have been re-sent anything by v2's attach.
          owner.ws.send(JSON.stringify({ type: 'output', data: 'LIVE-2' }));
          await daemon.waitFor(() => outputs(v2.frames).length >= 2 && outputs(v1.frames).length >= 3,
            { timeoutMs: 3000, description: 'LIVE-2 at both viewers' });
          assert.deepEqual(outputs(v1.frames).map((f) => f.data).slice(1), ['LIVE-1', 'LIVE-2']);
          assert.deepEqual(outputs(v2.frames).map((f) => f.data).slice(1), ['LIVE-2']);
        } finally {
          v2.ws.close();
        }
      } finally {
        v1.ws.close();
      }

      assert.deepEqual(outputs(owner.frames), [], 'the owner socket is never sent a replay');
    } finally {
      owner.ws.close();
    }
  });

  test('a viewer attaching to a session with an empty ring is sent no output frame', async () => {
    const sid = createSessionId('replay89empty');
    await daemon.registerSession(sid);
    const owner = await openCollecting(sid, daemon.ownerAuth(sid),
      `&owner=1&owner_pid=${process.pid}&command=test-wrap`);
    const v = await openCollecting(sid);
    try {
      owner.ws.send(JSON.stringify({ type: 'output', data: 'FIRST-LIVE' }));
      await daemon.waitFor(() => outputs(v.frames).length >= 1,
        { timeoutMs: 3000, description: 'first live frame' });
      assert.deepEqual(outputs(v.frames).map((f) => f.data), ['FIRST-LIVE']);
    } finally {
      v.ws.close();
      owner.ws.close();
    }
  });
});
