'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSshPlan, createSshInputState, sshInputFailure, requestSshWrite, acceptSshWriteReceipt,
  sshChildEnvironment, remoteAgentCommand } = require('../src/ssh-session');

test('#11 OpenSSH plan is argv-only, bounded and preserves host verification', () => {
  const p = buildSshPlan(['user@example.test', '--id', 'remote', '--persistent', '--remote-command', 'codex',
    '--cwd', "~/project's $() space", '--resume', 'conversation-id', '--server-alive-interval', '20',
    '--connect-timeout', '7', '--', '--model', 'chosen']);
  assert.equal(p.command, 'ssh'); assert.equal(p.persistent, true); assert.equal(p.id, 'remote');
  assert.deepEqual(p.args.slice(0, 8), ['-tt', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3', '-o']);
  assert.ok(p.args.includes('ConnectTimeout=7')); assert.equal(p.args.at(-2), 'user@example.test');
  assert.match(p.args.at(-1), /cd "\$HOME"\/'project'"'"'s \$\(\) space' && exec 'codex' 'resume' 'conversation-id' '--model' 'chosen'/);
  assert.doesNotMatch(p.args.join(' '), /StrictHostKeyChecking=no|UserKnownHostsFile|SendEnv|ForwardAgent|password/i);
  assert.equal(p.metadata.agent, 'codex'); assert.equal(p.metadata.identity, 'operator_declared');
  assert.equal(p.metadata.version_status, 'unsupported');
  assert.equal(remoteAgentCommand({ command: 'ssh', sshRemote: p.metadata }), 'codex');
});

for (const argv of [ ['-oProxyCommand=evil','--id','s'], ['host','--id','s','--connect-timeout','0'],
  ['host','--id','s','--resume'], ['host','--id','s','--remote-command','bash','--resume','x'],
  ['host\nother','--id','s'], ['host','--id','s','--backoff-max-ms','999999'] ]) {
  test(`#11 malformed SSH plan is refused: ${JSON.stringify(argv)}`, () => assert.throws(() => buildSshPlan(argv)));
}

test('#11 local credentials are absent from the SSH child environment', () => {
  const env = sshChildEnvironment({ PATH: '/bin', SSH_AUTH_SOCK: '/test/agent', TELEPTY_AUTH_TOKEN: 'local',
    TELEPTY_SESSION_TOKEN: 'session', TELEPTY_SESSION_NONCE: 'nonce', TELEPTY_SESSION_ORIGIN: 'origin',
    TELEPTY_SESSION_CREDENTIAL_PATH: 'path', TELEPTY_SESSION_CREDENTIAL_INSTANCE: 'instance', TELEPTY_SESSION_ID: 'id' });
  assert.deepEqual(env, { PATH: '/bin', SSH_AUTH_SOCK: '/test/agent' });
});

const composer = 'OpenAI Codex (v0.160.0)\n› \nGPT-6-Astra xhigh fast';
test('#11 automation is denied before composer, during dialogs and across child replacement', () => {
  const changes = []; const state = createSshInputState('codex', change => changes.push(change));
  const a = { write: () => {} }, b = { write: () => {} }; const written = [];
  state.start(a); assert.equal(state.write(a, 'payload', x => written.push(x)).stage, 'refused');
  state.output(a, 'Password: '); assert.equal(state.snapshot().phase, 'blocked');
  state.output(a, composer); assert.equal(state.snapshot().phase, 'ready');
  assert.equal(state.write(a, 'payload', x => written.push(x)).stage, 'written');
  state.output(a, '1. Update now\n2. Skip\nUpdate available');
  assert.equal(state.write(a, '\r', x => written.push(x)).stage, 'refused');
  state.exit(a); state.start(b);
  assert.equal(state.write(a, 'stale', x => written.push(x)).stage, 'refused');
  assert.equal(state.write(b, '\r', x => written.push(x)).stage, 'refused');
  state.output(a, composer); assert.notEqual(state.snapshot().phase, 'ready');
  state.output(b, composer); assert.equal(state.snapshot().phase, 'ready');
  assert.deepEqual(written, ['payload']); assert.ok(changes.length > 0);
});

test('#11 deferred Enter is one-use, current-child bound and never released into authentication', () => {
  const state = createSshInputState('codex'); const child = {}; const writes = [];
  state.start(child); state.output(child, composer);
  assert.equal(state.write(child, 'text', x => writes.push(x)).stage, 'written');
  state.output(child, 'echo of text');
  assert.equal(state.write(child, '\r', x => writes.push(x)).stage, 'written');
  assert.equal(state.write(child, '\r', x => writes.push(x)).stage, 'refused');
  state.output(child, composer); state.write(child, 'again', x => writes.push(x));
  state.output(child, 'Are you sure you want to continue connecting (yes/no/[fingerprint])?');
  assert.equal(state.write(child, '\r', x => writes.push(x)).stage, 'refused');
  assert.deepEqual(writes, ['text','\r','again']);
});

test('#11 daemon receipts are owner/generation bound and waiting is bounded', async () => {
  const messages = [];
  const session = { sshRemote: { agent: 'codex' }, interactionOwnerGeneration: 'owner',
    ownerWs: { readyState: 1, send: value => messages.push(JSON.parse(value)) },
    sshState: { phase: 'ready', generation: 1, owner_generation: 'owner' } };
  assert.equal(sshInputFailure(session, 'payload'), null);
  const pending = requestSshWrite(session, 'payload', { timeoutMs: 100 });
  const msg = messages[0];
  assert.equal(acceptSshWriteReceipt(session, {}, { ...msg, stage: 'written' }), false);
  assert.equal(acceptSshWriteReceipt(session, session.ownerWs, { ...msg, stage: 'written' }), true);
  assert.equal((await pending).success, true);
  const timeout = await requestSshWrite(session, 'payload', { timeoutMs: 1 });
  assert.equal(timeout.code, 'SSH_WRITE_UNCONFIRMED');
  session.sshState = { phase: 'reconnecting', generation: 2, owner_generation: 'owner' };
  assert.equal(sshInputFailure(session, 'payload').code, 'SSH_NOT_READY');
});

test('#11 composer repaint with unsent text retains only its owed Enter permit', () => {
  const state = createSshInputState('codex'); const child = {}; const written = [];
  state.start(child); state.output(child, composer);
  state.write(child, 'draft', x => written.push(x));
  assert.equal(state.output(child, composer), false);
  assert.equal(state.snapshot().phase, 'awaiting_submit');
  assert.equal(state.write(child, 'second prompt', x => written.push(x)).stage, 'refused');
  assert.equal(state.write(child, '\r', x => written.push(x)).stage, 'written');
  assert.deepEqual(written, ['draft', '\r']);
});

test('#11 killing persistent SSH targets stable owner, not a stale child PID', async () => {
  const { killSessionProcess } = require('../src/lifecycle'); const signals = [];
  await killSessionProcess({ sshRemote: { persistent: true }, ownerPid: 111, ptyPid: 222 }, {
    force: true, platform: 'linux', processKill: (pid, signal) => signals.push([pid, signal])
  });
  assert.deepEqual(signals, [[111, 'SIGKILL']]);
});

test('#12 SSH metadata persists without readiness or authenticated remote identity claims', () => {
  const { serializePersistedSessions, buildRestoredWrappedSession } = require('../src/session-store/persistence');
  const { readinessSnapshot } = require('../src/readiness');
  const plan = buildSshPlan(['host', '--id', 's', '--persistent', '--remote-command', 'codex']);
  const stored = serializePersistedSessions({ s: { id: 's', type: 'wrapped', command: 'ssh', sshRemote: plan.metadata,
    sshState: { phase: 'ready', generation: 99 } } }).s;
  assert.equal(stored.sshState, undefined);
  const restored = buildRestoredWrappedSession('s', stored);
  assert.deepEqual(restored.sshRemote, plan.metadata);
  assert.equal(readinessSnapshot(restored).ready, false);
  const shell = buildRestoredWrappedSession('shell', { ...stored,
    sshRemote: buildSshPlan(['host', '--id', 'shell']).metadata });
  assert.equal(readinessSnapshot(shell).status, 'unsupported');
});

test('#12 remote POSIX quoting preserves cwd and literal argv without shell evaluation', {
  skip: process.platform === 'win32' ? 'Local POSIX shell fixture; native Windows SSH validation remains open' : false
}, t => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-ssh-quote-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "directory's $() space"); fs.mkdirSync(cwd);
  const script = path.join(root, 'record.js');
  fs.writeFileSync(script, 'process.stdout.write(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}))');
  const payload = `literal'; touch ${path.join(root,'must-not-exist')}; $(echo NO) \\"`;
  const plan = buildSshPlan(['host', '--id', 'quote', '--remote-command', process.execPath, '--cwd', cwd,
    '--', script, payload, '']);
  const run = spawnSync('/bin/sh', ['-c', plan.args.at(-1)], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { cwd, args: [payload, ''] });
  assert.equal(fs.existsSync(path.join(root, 'must-not-exist')), false);
});

test('#11 an unexpected submit-path exception never retries text through the mailbox fallback', async () => {
  const { createSessionDeliveryContext } = require('../src/mailbox/session-delivery');
  const packets = []; const s = { id: 'ssh', type: 'wrapped', command: 'ssh', sessionEpoch: 'epoch',
    sshRemote: { agent: 'codex' }, interactionOwnerGeneration: 'owner',
    sshState: { phase: 'ready', generation: 1, owner_generation: 'owner' } };
  s.ownerWs = { readyState: 1, send(value) {
    const msg = JSON.parse(value); packets.push(msg);
    s.sshState.phase = 'awaiting_submit';
    acceptSshWriteReceipt(s, s.ownerWs, { ...msg, stage: 'written' });
  } };
  const ctx = createSessionDeliveryContext({ sessions: { ssh: s }, shouldQueueBootstrapOperation: () => false,
    getInjectFailure: () => null, resolveModalGate: async () => null, modalRemedy: () => 'reject',
    hasBootstrapBacklog: () => false, crypto: require('node:crypto'),
    applyProvenance: payload => ({ payload }), maybeBracketedPaste: payload => payload,
    setTimeout: () => { throw new Error('fixture submit timer failure'); }
  });
  const result = await ctx.deliverInjectionToSession('ssh', s, 'only once');
  assert.equal(result.code, 'SSH_WRITE_UNCONFIRMED');
  assert.equal(packets.length, 1, 'no text replay through generic fallback');
  assert.equal(s.pendingSubmit, null);
});
