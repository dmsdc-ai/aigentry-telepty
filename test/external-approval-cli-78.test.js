'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { startTestDaemon, createSessionId } = require('../test-support/daemon-harness');
const { approvalOptionRequested, parseApprovalArgs, readApprovalFile, runApprovalCommand } = require('../src/cli/external-approval');
const keys = crypto.generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
let daemon;
before(async () => { daemon = await startTestDaemon(); });
after(async () => { if (daemon) await daemon.stop(); });
// #879: readApprovalFile refuses every approval file on win32 before any filesystem access
// (src/cli/external-approval.js:63, APPROVAL_FILE_PLATFORM_UNSUPPORTED — no O_NOFOLLOW/POSIX-mode
// private-file contract there). Cases that need an ACCEPTED or inspected approval file are POSIX-only;
// the Windows refusal is asserted by the win32 cases below and inside the signed-submit case.
const APPROVAL_FILE_POSIX_ONLY = process.platform === 'win32'
  ? 'win32: approval files are refused before reading (src/cli/external-approval.js:63); refusal covered below'
  : false;
function proof(document) { return { document, signature: crypto.sign(null, Buffer.from(JSON.stringify(document)), keys.privateKey).toString('base64url') }; }
async function owner(t, protectedSession = true) {
  const sid = createSessionId('approvalcli');
  const reg = await daemon.registerSession(sid, { command: 'test-wrap', ...(protectedSession ? { external_approval_policy: { public_key_spki: publicKey } } : {}) });
  assert.equal(reg.status, 201);
  const WebSocket = require('ws');
  const ws = new WebSocket(`ws://${daemon.host}:${daemon.port}/api/sessions/${sid}?owner=1&token=${encodeURIComponent(daemon.authToken())}`, daemon.ownerAuth(sid));
  const frames = [];
  ws.on('message', raw => { const msg = JSON.parse(raw); if (msg.type === 'inject') frames.push(msg.data); });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  t.after(() => ws.close());
  return { sid, frames, token: reg.body.session_token };
}

test('CLI digest-only handoff then private approval file accepts once without printing payload or credentials', { skip: APPROVAL_FILE_POSIX_ONLY }, async t => {
  const target = await owner(t);
  const payload = 'unique private prompt → --help --approval-file literal';
  const handoff = await daemon.runCli(['approval-challenge', '--no-enter', target.sid, '--', payload]);
  assert.equal(handoff.code, 0, handoff.stderr);
  const document = JSON.parse(handoff.stdout);
  assert.equal(document.sid, target.sid);
  assert.equal(document.no_enter, true);
  assert.equal(document.payload_sha256, crypto.createHash('sha256').update(payload).digest('hex'));
  const file = path.join(daemon.homeDir, 'approval.json');
  fs.writeFileSync(file, JSON.stringify(proof(document)), { mode: 0o600 });
  const accepted = await daemon.runCli(['inject', '--approval-file', file, '--no-enter', target.sid, '--', payload]);
  assert.equal(accepted.code, 0, accepted.stderr);
  await daemon.waitFor(() => target.frames.length === 1);
  assert.deepEqual(target.frames, [payload]);
  assert.equal(fs.existsSync(file), true, 'client reads but never deletes proof files');
  const replay = await daemon.runCli(['inject', '--approval-file', file, '--no-enter', target.sid, '--', payload]);
  assert.equal(replay.code, 1);
  assert.equal(JSON.parse(replay.stderr).code, 'APPROVAL_DENIED');
  const changed = await daemon.runCli(['inject', '--approval-file', file, '--no-enter', target.sid, '--', payload + ' changed']);
  assert.equal(changed.code, 1);
  assert.equal(JSON.parse(changed.stderr).code, 'INVALID_APPROVAL_DOCUMENT');
  for (const output of [handoff.stdout, handoff.stderr, accepted.stdout, accepted.stderr, replay.stdout, replay.stderr, changed.stdout, changed.stderr]) {
    assert.equal(output.includes(payload), false);
    assert.equal(output.includes(target.token), false);
    assert.equal(output.includes(daemon.authToken()), false);
    assert.equal(output.includes('PRIVATE KEY'), false);
    assert.equal(output.includes(proof(document).signature), false);
  }
  assert.deepEqual(target.frames, [payload]);
});

test('CLI defaults to signed text plus Enter; ordinary inject and literal approval option remain unchanged', async t => {
  const target = await owner(t);
  const challenge = await daemon.runCli(['approval-challenge', target.sid, '--', 'submit this']);
  assert.equal(challenge.code, 0, challenge.stderr);
  const document = JSON.parse(challenge.stdout); assert.equal(document.no_enter, false);
  const file = path.join(daemon.homeDir, 'approval-submit.json');
  fs.writeFileSync(file, JSON.stringify(proof(document)), { mode: 0o600 });
  const sent = await daemon.runCli(['inject', '--approval-file', file, target.sid, '--', 'submit this']);
  if (process.platform === 'win32') {
    // #879: the supported win32 contract is refusal before any request (src/cli/external-approval.js:63).
    assert.equal(sent.code, 1);
    assert.equal(JSON.parse(sent.stderr).code, 'APPROVAL_FILE_PLATFORM_UNSUPPORTED');
    assert.equal(sent.stdout.includes('submit this') || sent.stderr.includes('submit this'), false);
    assert.deepEqual(target.frames, []);
  } else {
    assert.equal(sent.code, 0, sent.stderr);
    await daemon.waitFor(() => target.frames.length === 2);
    assert.deepEqual(target.frames, ['submit this', '\r']);
  }
  const normal = await owner(t, false);
  const legacy = await daemon.runCli(['inject', normal.sid, '--', 'literal --approval-file value']);
  assert.equal(legacy.code, 0, legacy.stderr);
  await daemon.waitFor(() => normal.frames.length === 2);
  assert.deepEqual(normal.frames, ['literal --approval-file value', '\r']);
});

test('CLI approval fanout refuses explicitly and help never opens a proof file', async () => {
  for (const command of ['multicast', 'broadcast']) {
    const result = await daemon.runCli([command, '--approval-file', '/does/not/exist', 'target', 'text']);
    assert.equal(result.code, 1); assert.equal(JSON.parse(result.stderr).code, 'APPROVAL_FANOUT_UNSUPPORTED');
  }
  const help = await daemon.runCli(['inject', '--approval-file', '/does/not/exist', '--help']);
  assert.equal(help.code, 0); assert.match(help.stdout, /Usage/);
  assert.equal(help.stderr, '');
});

test('approval challenge with a fresh HOME creates no credential/config or daemon and sends no request', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'approvalcli-fresh-'));
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, TELEPTY_PORT: '1' };
    for (const key of ['TELEPTY_AUTH_TOKEN', 'TELEPTY_SESSION_TOKEN', 'TELEPTY_SESSION_ORIGIN']) delete env[key];
    const result = spawnSync(process.execPath, ['cli.js', 'approval-challenge', 'target', '--', 'do not print this'], {
      cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code, 'CREDENTIALS_UNAVAILABLE');
    assert.deepEqual(fs.readdirSync(home), []);
    assert.equal(result.stdout, '');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('parser keeps literal words, rejects unsupported flags, and never selects approval mode from payload', () => {
  assert.equal(approvalOptionRequested(['target', '--', '--approval-file', 'proof']), false);
  assert.equal(approvalOptionRequested(['target', 'payload', '--approval-file', 'proof']), false);
  assert.equal(approvalOptionRequested(['--approval-file', 'proof', 'target', '--', '--help']), true);
  const parsed = parseApprovalArgs('inject', ['--approval-file', 'proof', '--no-enter', 'target', '--', '--help', '--submit', '']);
  assert.equal(parsed.prompt, '--help --submit '); assert.equal(parsed.noEnter, true);
  assert.throws(() => parseApprovalArgs('inject', ['--approval-file', 'proof', '--submit', 'target', 'payload']), { code: 'UNSUPPORTED_APPROVAL_OPTION' });
});

test('approval file loader refuses symlinks, public modes, oversized files and private key material before a request', { skip: APPROVAL_FILE_POSIX_ONLY }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'approvalcli-files-'));
  const input = parseApprovalArgs('inject', ['--approval-file', 'x', 'target', 'payload']);
  try {
    const privateFile = path.join(root, 'private'); fs.writeFileSync(privateFile, 'PRIVATE KEY', { mode: 0o600 });
    let keyBytesRead = 0;
    const observedFs = Object.create(fs);
    observedFs.readSync = (...args) => { const bytes = fs.readSync(...args); keyBytesRead += bytes; return bytes; };
    assert.throws(() => readApprovalFile(privateFile, input, { filesystem: observedFs }), { code: 'INVALID_APPROVAL_FILE' });
    assert.equal(keyBytesRead, 1, 'reject non-JSON/key input before reading key material');
    const link = path.join(root, 'link'); fs.symlinkSync(privateFile, link);
    assert.throws(() => readApprovalFile(link, input), { code: 'UNSAFE_APPROVAL_FILE' });
    const publicFile = path.join(root, 'public'); fs.writeFileSync(publicFile, '{}', { mode: 0o644 });
    assert.throws(() => readApprovalFile(publicFile, input), { code: 'UNSAFE_APPROVAL_FILE' });
    const hardlink = path.join(root, 'hardlink'); fs.linkSync(privateFile, hardlink);
    assert.throws(() => readApprovalFile(hardlink, input), { code: 'UNSAFE_APPROVAL_FILE' });
    const growing = path.join(root, 'growing'); fs.writeFileSync(growing, '{}', { mode: 0o600 });
    let growthBytesRead = 0;
    const growthFs = Object.create(fs);
    growthFs.fstatSync = fd => { const stat = fs.fstatSync(fd); fs.appendFileSync(growing, Buffer.alloc(20000)); return stat; };
    growthFs.readSync = (...args) => { const bytes = fs.readSync(...args); growthBytesRead += bytes; return bytes; };
    assert.throws(() => readApprovalFile(growing, input, { filesystem: growthFs }), { code: 'UNSAFE_APPROVAL_FILE' });
    assert.equal(growthBytesRead, 16385, 'read budget remains bounded when file grows after preflight');
    const huge = path.join(root, 'huge'); fs.writeFileSync(huge, Buffer.alloc(16385), { mode: 0o600 });
    assert.throws(() => readApprovalFile(huge, input), { code: 'UNSAFE_APPROVAL_FILE' });
    let requests = 0; const errors = [];
    const code = await runApprovalCommand('inject', ['--approval-file', link, 'target', 'payload'], {
      daemonUrl: () => 'http://127.0.0.1:1', fetchWithAuth: () => { requests++; throw new Error('must not call'); }, printError: value => errors.push(JSON.parse(value)) });
    assert.equal(code, 1); assert.equal(requests, 0); assert.equal(errors[0].code, 'UNSAFE_APPROVAL_FILE');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('old approval cannot fall back to unsigned injection after target id is recreated without protection', { skip: APPROVAL_FILE_POSIX_ONLY }, async t => {
  const target = await owner(t);
  const challenge = await daemon.runCli(['approval-challenge', '--no-enter', target.sid, '--', 'old signed text']);
  assert.equal(challenge.code, 0, challenge.stderr);
  const file = path.join(daemon.homeDir, 'approval-replaced.json');
  fs.writeFileSync(file, JSON.stringify(proof(JSON.parse(challenge.stdout))), { mode: 0o600 });
  const deleted = await daemon.request(`/api/sessions/${target.sid}?owned=true`, { method: 'DELETE', headers: { 'x-telepty-session-token': target.token } });
  assert.equal(deleted.status, 200);
  assert.equal((await daemon.registerSession(target.sid, { command: 'test-wrap' })).status, 201);
  const result = await daemon.runCli(['inject', '--approval-file', file, '--no-enter', target.sid, '--', 'old signed text']);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).code, 'APPROVAL_POLICY_REQUIRED');
  const mailbox = await daemon.request(`/api/sessions/${target.sid}/mailbox`);
  assert.equal(mailbox.body.pending.length, 0, 'old proof must never enter a replacement mailbox');
});

// #879: the win32 refusal contract. The loader case runs on every platform through the injectable
// platform seam; the CLI case is the real Windows command against a protected live session.
test('approval file loader refuses win32 before touching the file', () => {
  const input = parseApprovalArgs('inject', ['--approval-file', 'x', 'target', 'payload']);
  const touched = [];
  const observedFs = Object.create(fs);
  for (const name of ['lstatSync', 'openSync', 'fstatSync', 'readSync']) observedFs[name] = (...args) => { touched.push(name); return fs[name](...args); };
  assert.throws(() => readApprovalFile(path.join(os.tmpdir(), 'approval-879-never-read.json'), input, { filesystem: observedFs, platform: 'win32' }),
    { code: 'APPROVAL_FILE_PLATFORM_UNSUPPORTED' });
  assert.deepEqual(touched, [], 'the refusal precedes every filesystem call');
});

test('win32 CLI refuses an approval file before any request and delivers nothing', { skip: process.platform !== 'win32' }, async t => {
  const target = await owner(t);
  const challenge = await daemon.runCli(['approval-challenge', '--no-enter', target.sid, '--', 'win32 refused text']);
  assert.equal(challenge.code, 0, challenge.stderr);
  const document = JSON.parse(challenge.stdout);
  const file = path.join(daemon.homeDir, 'approval-win32.json');
  fs.writeFileSync(file, JSON.stringify(proof(document)), { mode: 0o600 });
  const result = await daemon.runCli(['inject', '--approval-file', file, '--no-enter', target.sid, '--', 'win32 refused text']);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).code, 'APPROVAL_FILE_PLATFORM_UNSUPPORTED');
  for (const output of [result.stdout, result.stderr]) {
    assert.equal(output.includes('win32 refused text'), false);
    assert.equal(output.includes(target.token), false);
    assert.equal(output.includes(daemon.authToken()), false);
  }
  assert.deepEqual(target.frames, [], 'a refused approval must deliver nothing');
  assert.equal(fs.existsSync(file), true, 'client never deletes proof files');
});
