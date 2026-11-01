'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
for(const scenario of ['unsupported','fresh-instance','wrong-generation','wrong-epoch'])test(`successor refuses ${scenario} registration before child or owner socket`,{skip:process.platform!=='linux',timeout:10000},async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'handoff-adoption-cli-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const epoch=crypto.randomBytes(16).toString('base64url'),token=epoch+'.'+crypto.randomBytes(32).toString('base64url'),pair=crypto.generateKeyPairSync('ed25519');
 const key=path.join(home,'key.pem'),config=path.join(home,'client.json'),proof=path.join(home,'proof.json'),marker=path.join(home,'child-started');
 fs.writeFileSync(key,pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});let registration,upgrades=0;
 const server=http.createServer((req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.url==='/api/auth/challenge'){res.end(JSON.stringify({schema:'telepty.principal-challenge/v1',audience:'fixture',transport:'http',max_lifetime_seconds:60,identity_source:'configured-ed25519-key',challenge:'c'.repeat(32)}));return;}
  if(req.url==='/api/sessions/register'){
   let bytes='';req.on('data',b=>bytes+=b);req.on('end',()=>{registration=JSON.parse(bytes);const reply={reregistered:true,registration_instance_matched:true,session_epoch:epoch,credential_generation:2};
    if(scenario==='unsupported')delete reply.registration_instance_matched;
    if(scenario==='fresh-instance'){res.statusCode=201;reply.reregistered=false;reply.session_epoch='x'.repeat(22);}
    if(scenario==='wrong-generation')reply.credential_generation=3;
    if(scenario==='wrong-epoch')reply.session_epoch='x'.repeat(22);
    res.end(JSON.stringify(reply));});return;
  }
  res.statusCode=404;res.end('{}');
 });server.on('upgrade',(_req,socket)=>{upgrades++;socket.destroy();});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());const origin=`http://127.0.0.1:${server.address().port}`;
 fs.writeFileSync(config,JSON.stringify({schema:'telepty.principal-client/v1',daemon_url:origin,principal_id:'owner',key_id:'owner',audience:'fixture',private_key_path:key}),{mode:0o600});
 fs.writeFileSync(proof,JSON.stringify({schema:'telepty.handoff-credential/v1',session_id:'fixture',origin,session_epoch:epoch,session_token:token,session_nonce:'n'.repeat(24),credential_generation:2}),{mode:0o600});
 const child=spawn(process.execPath,['--require','./test-support/setup-env.js','cli.js','allow','--id','fixture',process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(marker)},'unsafe')`],{cwd:path.resolve(__dirname,'..'),env:{...process.env,HOME:home,TELEPTY_HOST:'127.0.0.1',TELEPTY_PORT:String(server.address().port),TELEPTY_PRINCIPAL_CLIENT_FILE:config,TELEPTY_COOPERATIVE_HANDOFF:'1',TELEPTY_HANDOFF_CREDENTIAL_FILE:proof},stdio:['ignore','pipe','pipe']});t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
 const exit=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('successor did not refuse promptly'));},5000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve(code);});});
 assert.notEqual(exit,0);assert.match(logs,/did not confirm the exact handoff instance/);assert.equal(fs.existsSync(marker),false);assert.equal(upgrades,0);assert.ok(!logs.includes(token));assert.equal(registration.expected_epoch,epoch);assert.equal(registration.expected_credential_generation,2);
});
