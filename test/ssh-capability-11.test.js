'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
for (const capabilities of [undefined, ['wrapped-sessions'], { 'ssh-child-write-receipts-v1': true }]) {
  test(`#11 an old or malformed daemon capability list refuses SSH before registration: ${JSON.stringify(capabilities)}`, async t => {
    const seen = []; const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-ssh-cap-'));
    const server = http.createServer((req,res) => { seen.push([req.method, req.url]); res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({ version: '0.9.2', capabilities })); });
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(home,{recursive:true,force:true}); });
    let failure;
    try { await promisify(execFile)(process.execPath, ['cli.js','ssh','fixture.invalid','--id','refused','--persistent','--remote-command','codex'], {
      cwd: path.resolve(__dirname,'..'), env: { ...process.env, HOME: home, USERPROFILE: home,
        TELEPTY_AUTH_TOKEN: 'private-fixture-token', TELEPTY_HOST: '127.0.0.1', TELEPTY_PORT: String(server.address().port) }
    }); } catch (error) { failure = error; }
    assert.equal(failure?.code,1);
    assert.match(failure.stderr,/requires a running daemon advertising ssh-child-write-receipts-v1/);
    assert.deepEqual(seen,[['GET','/api/meta']], 'no register, restart, daemon management or SSH child launch');
    assert.deepEqual(fs.readdirSync(home),[],'no credential or state files created');
  });
}
