'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const evidence = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'conditional-admission-'));
// tt1170aa PORTABILITY-3 (child-environment default only; no assertion changed): this file lives
// at `<repo root>/test`, and the release branch package is at the ROOT with its dependencies in
// `<repo root>/node_modules`. The previous fallback was an absolute worker path that resolves on
// no other machine, so on a clean checkout every child fixture failed to resolve `express`. An
// inherited `NODE_PATH` still wins, so an externally selected dependency tree is unaffected.
const DEFAULT_NODE_PATH = path.resolve(__dirname, '..', 'node_modules');
function run(name, home) {
  const child=spawnSync(process.execPath,[path.join(__dirname,'conditional-admission-fixture.cjs'),name],{timeout:15000,encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:evidence,NODE_PATH:process.env.NODE_PATH || DEFAULT_NODE_PATH,...(home?{FIXTURE_HOME:home}:{})}});
  fs.writeFileSync(path.join(evidence,name+'.log'),child.stdout+'\n'+child.stderr);
  assert.equal(child.status,0,child.stdout+'\n'+child.stderr);
  const line=child.stdout.split('\n').find(l=>l.startsWith('FIXTURE_RESULT '));
  assert.ok(line,'fixture result required');return JSON.parse(line.slice(15));
}
for(const name of ['fence-inject','fence-submit','fence-viewer','fence-submitroute','fence-submitall','fence-multicast','fence-broadcast','fence-fault-inject','fence-fault-submit','fence-fault-viewer','fence-fault-submitroute','fence-fault-submitall','fence-fault-multicast','fence-fault-broadcast','fence-fault-dir-inject','fence-restart-inject']) {
  test(name+': permanently bound record refuses unbound bytes',()=>{const r=run(name);assert.deepEqual(r.writes,[],JSON.stringify(r));});
}
test('AC1/3/8 real binding and queue emit one body and CR; receipt never semantic ACK',()=>{
  const r=run('happy');assert.equal(r.writes.length,2);assert.equal(r.writes[1].data,'\r');assert.match(r.writes[0].data,/controller/);
  assert.equal(r.duplicate.status,200);assert.equal(r.duplicate.body.inject_id,r.response.body.inject_id);assert.equal(r.conflict.status,409);assert.equal(r.response.body.semantic_ack,'pending');assert.equal(r.record.body_phase,'emitted');assert.equal(r.record.cr_phase,'emitted');
});
for(const name of ['replace-cr','revoke-cr']) test('AC2/4 '+name+' suppresses CR',()=>{const r=run(name);assert.equal(r.writes.filter(w=>w.data==='\r').length,0);assert.equal(r.record.cr_phase,'held');});
test('AC2 owner replacement before admission refuses',()=>{const r=run('stale-before');assert.equal(r.response.status,409);assert.deepEqual(r.writes,[]);});
test('AC4 host and bearer both required; unknown from refused',()=>{const r=run('auth');assert.equal(r.missingHost.status,401);assert.equal(r.missingBearer.status,401);assert.equal(r.spoof.status,400);assert.deepEqual(r.writes,[]);});
test('AC5/7 forged conditional mailbox identity writes no bytes',()=>{assert.deepEqual(run('forged').writes,[]);});
test('AC1 production CLI builds authenticated conditional request once',()=>{const r=run('cli');assert.equal(r.requests,1);assert.equal(r.response.status,202);assert.equal(r.writes.length,2);});
test('AC2 registration mutation invalidates prior delivery pin',()=>{const r=run('registration-mutation');assert.equal(r.response.status,409);assert.deepEqual(r.writes,[]);});
test('AC3/6 fresh process restores exact duplicate without resend',()=>{const seed=run('restart-seed');const r=run('restart-read',seed.home);assert.equal(r.response.status,200);assert.equal(r.response.body.inject_id,r.original);assert.deepEqual(r.writes,[]);});
test('AC6/7 fresh process retains permanent fence with corrupt ledger',()=>{const seed=run('restart-corrupt-seed');const r=run('restart-read',seed.home);assert.deepEqual(r.writes,[],JSON.stringify(r));});
test('AC3 simultaneous duplicates have one admission/body/CR',()=>{const r=run('concurrent');assert.equal(r.responses[0].body.inject_id,r.responses[1].body.inject_id);assert.equal(r.writes.length,2);});
test('AC4 expired binding refuses without bytes',()=>{const r=run('expired');assert.equal(r.response.status,410);assert.deepEqual(r.writes,[]);});
test('AC4 noncanonical JSON refuses without bytes',()=>{const r=run('noncanonical');assert.equal(r.response.status,400);assert.deepEqual(r.writes,[]);});
test('AC5 real bootstrap queue parks and drains one body/CR',()=>{const r=run('bootstrap');assert.equal(r.writes.length,2);});
test('AC5 real modal queue parks and drains one body/CR',()=>{const r=run('modal');assert.equal(r.writes.length,2);});
test('AC2/5 replacement while modal parked suppresses body and CR',()=>{const r=run('modal-replace');assert.deepEqual(r.writes,[]);});

for (const route of ['binding','inject']) for (const variant of ['duplicate','escaped','order','nested','unknown','schema','partial','utf8']) {
  test('raw '+route+' rejects '+variant+' without bytes',()=>{
    const r=run('raw-'+route+'-'+variant);assert.equal(r.response.status,400);assert.deepEqual(r.writes,[]);
  });
}
for (const key of ['provenance_capable','command','cwd','backend','cmux_workspace_id','cmux_surface_id','term_program','term','owner_pid','pty_pid','delivery_type','delivery_endpoint','delivery']) {
  test('registration '+key+' invalidates pin',()=>{
    const r=run('mutation-'+key);assert.equal(r.changed.status,200);assert.notEqual(r.before,r.after);assert.equal(r.response.status,409);assert.deepEqual(r.writes,[]);
  });
}
test('owner close invalidates pin before clearing owner',()=>{
  const r=run('owner-close');assert.notEqual(r.before,r.after);assert.equal(r.response.status,409);assert.deepEqual(r.writes,[]);
});
test('valid readoption rotates pin and reverifies principal',()=>{
  const r=run('readopt-valid');assert.notEqual(r.before,r.after);assert.equal(r.target.status,200);assert.equal(r.response.status,409);assert.deepEqual(r.writes,[]);
});
test('revoked readoption cannot inherit successor proof',()=>{
  const r=run('readopt-revoked');assert.notEqual(r.target.status,200);assert.equal(r.proved,null);assert.deepEqual(r.writes,[]);
});
test('pending unbound CR is cancelled by a subsequent binding',()=>{assert.deepEqual(run('delayed-unbound-cr').writes,[]);});
test('KNOWN UNIMPLEMENTED: fresh process with both initialization artifacts absent stays fenced',()=>{
  const seed=run('both-missing-seed');const r=run('both-missing-read',seed.home);
  assert.deepEqual(r.writes,[],JSON.stringify(r));assert.equal(r.fenced,true);
});

for (const route of ['binding','inject']) for (const variant of ['duplicate','escaped','order','nested','unknown','schema','partial','utf8']) {
  test('CLI '+route+' rejects '+variant+' before transport',()=>{
    const r=run('cli-raw-'+route+'-'+variant);assert.equal(r.cliExit,1);assert.equal(r.requests,0);assert.deepEqual(r.writes,[]);
  });
}
test('pending synthetic UDS callback rechecks new fence before adapter write',()=>{assert.deepEqual(run('delayed-unbound-uds').writes,[]);});
for(const section of ['marker','missing','fenced_sessions','bindings','admissions','tombstones']) {
  test('reload losing '+section+' fails closed and cannot reinitialize',()=>{
    const r=run('reload-'+section);assert.equal(r.beforeFault,['admissions','tombstones'].includes(section)?1:0);assert.equal(r.reloaded.ok,false);assert.equal(r.second.ok,false);assert.equal(r.fenced,true);assert.deepEqual(r.writes,[]);
  });
}

test('rename rotates delivery pin before moving session',()=>{
  const r=run('rename');assert.equal(r.renamed.status,200);assert.notEqual(r.before,r.after);assert.notEqual(r.response.status,202);assert.deepEqual(r.writes,[]);
});
test('production CLI submits canonical binding once and retrieves identical binding',()=>{
  const r=run('cli-binding');assert.equal(r.requests,1);assert.equal(r.response.status,200);assert.ok(r.response.body.binding);assert.deepEqual(r.writes,[]);
});

// ---------------------------------------------------------------------------
// it1170x — explicit authenticated FIRST initialization (ti1170w candidate).
// Every case below drives the real production route, principal check, canonical
// intent check and persistence. Nothing about initialization is mocked.
// ---------------------------------------------------------------------------

test('fresh startup mints no scoped authority and creates no store files',()=>{
  const r=run('init-fresh-startup');
  for(const state of [r.before,r.after]) {
    assert.equal(state.ledger,false,JSON.stringify(state));
    assert.equal(state.marker,false,JSON.stringify(state));
    assert.deepEqual(state.temps,[],JSON.stringify(state));
    assert.equal(state.available,false,JSON.stringify(state));
  }
  assert.equal(r.fenced,true);
  assert.deepEqual(r.writes,[],JSON.stringify(r.writes));
  // The GET snapshot is a non-secret identity (¶16) and is NOT scoped authority. Authority is the
  // binding, and with no initialized store it must be refused as unavailable.
  assert.equal(r.binding.status,503,JSON.stringify(r.binding));
  assert.equal(r.binding.body.code,'STORE_UNAVAILABLE');
  if(r.target.status===200) {
    assert.deepEqual(Object.keys(r.target.body).sort(),['target','version']);
    assert.deepEqual(Object.keys(r.target.body.target).sort(),
      ['credential_generation','delivery_generation','session_epoch','sid']);
  }
});

for(const [scenario,status] of [['init-unauthenticated',401],['init-host-only',401],
  ['init-worker-bearer',403],['init-spoofed-principal',403],['init-revoked-principal',401]]) {
  test('first initialization refuses '+scenario.slice(5)+' with zero artifacts',()=>{
    const r=run(scenario);
    assert.equal(r.response.status,status,JSON.stringify(r.response));
    assert.equal(r.artifacts.ledger,false,JSON.stringify(r.artifacts));
    assert.equal(r.artifacts.marker,false,JSON.stringify(r.artifacts));
    assert.deepEqual(r.artifacts.temps,[],JSON.stringify(r.artifacts));
    assert.equal(r.artifacts.available,false);
    assert.deepEqual(r.writes,[]);
  });
}

for(const variant of ['duplicate','escaped','order','unknown','schema','partial','intent','force','pretty','utf8']) {
  test('first initialization rejects noncanonical intent '+variant,()=>{
    const r=run('init-raw-'+variant);
    assert.equal(r.response.status,400,JSON.stringify(r.response));
    assert.equal(r.artifacts.ledger,false,JSON.stringify(r.artifacts));
    assert.equal(r.artifacts.marker,false,JSON.stringify(r.artifacts));
    assert.deepEqual(r.artifacts.temps,[],JSON.stringify(r.artifacts));
  });
}

test('repeated initialization of a ready store conflicts and rewrites nothing',()=>{
  const r=run('init-existing');
  assert.equal(r.first.status,201,JSON.stringify(r.first));
  assert.equal(r.second.status,409,JSON.stringify(r.second));
  assert.equal(r.second.body.code,'CONFLICT');
  assert.equal(r.third.status,409,JSON.stringify(r.third));
  assert.equal(r.markerId,r.markerAfter);
  assert.equal(r.after.available,true);
  assert.deepEqual(r.after.temps,[]);
});

test('simultaneous first initializations create exactly one store',()=>{
  const r=run('init-concurrent');
  const created=r.responses.filter(x=>x.status===201);
  assert.equal(created.length,1,JSON.stringify(r.responses));
  const refused=r.responses.filter(x=>x.status!==201);
  assert.equal(refused.length,1,JSON.stringify(r.responses));
  assert.equal(refused[0].body.acceptance,'refused',JSON.stringify(refused[0]));
  assert.equal(refused[0].body.code,'CONFLICT',JSON.stringify(refused[0]));
  assert.equal(created[0].body.marker_id,r.markerId);
  assert.equal(r.after.ledger,true);assert.equal(r.after.marker,true);
  assert.deepEqual(r.after.temps,[]);
});

for(const [scenario,detail] of [['init-partial-marker','a marker without its ledger'],
  ['init-partial-ledger','a ledger without its marker'],['init-corrupt','a corrupt ledger'],
  ['init-unsupported','an unsupported schema'],['init-orphan-temp','orphan transaction evidence']]) {
  test('first initialization refuses '+detail+' and preserves it',()=>{
    const r=run(scenario);
    assert.equal(r.response.status,503,JSON.stringify(r.response));
    assert.equal(r.response.body.code,'STORE_UNAVAILABLE');
    assert.equal(r.after.available,false);
    assert.equal(r.ledgerUnchanged,true,JSON.stringify(r));
    assert.equal(r.after.marker,r.before.marker,JSON.stringify(r));
    assert.equal(r.after.ledger,r.before.ledger,JSON.stringify(r));
    assert.deepEqual(r.after.temps,r.before.temps,JSON.stringify(r));
  });
}

test('first initialization refuses an unwritable store directory',()=>{
  const r=run('init-denied');
  assert.equal(r.response.status,503,JSON.stringify(r.response));
  assert.equal(r.response.body.code,'STORE_UNAVAILABLE');
  assert.equal(r.after.ledger,false,JSON.stringify(r.after));
  assert.equal(r.after.marker,false,JSON.stringify(r.after));
  assert.equal(r.after.available,false);
});

for(const [fault,retained] of [['marker-fsync',{marker:true,ledger:false}],
  ['dir-fsync',{marker:true,ledger:false}],['post-reservation',{marker:true,ledger:true}]]) {
  test('initialization fault at '+fault+' stays uncertain and never self-heals',()=>{
    const r=run('init-fault-'+fault);
    assert.equal(r.response.status,503,JSON.stringify(r.response));
    assert.equal(r.afterFault.marker,retained.marker,JSON.stringify(r.afterFault));
    assert.equal(r.afterFault.ledger,retained.ledger,JSON.stringify(r.afterFault));
    assert.equal(r.afterFault.available,false,JSON.stringify(r.afterFault));
    assert.deepEqual(r.afterFault.temps,[],JSON.stringify(r.afterFault));
    assert.equal(r.retry.status,503,JSON.stringify(r.retry));
    assert.equal(r.after.available,false,JSON.stringify(r.after));
  });
}

test('an initialized store leaves ordinary unbound legacy traffic working',()=>{
  const r=run('init-legacy-traffic');
  assert.equal(r.initialization.status,201,JSON.stringify(r.initialization));
  assert.equal(r.response.status,200,JSON.stringify(r.response));
  assert.equal(r.fenced,false);
  assert.ok(r.writes.length>0,JSON.stringify(r.writes));
  assert.equal(r.after.available,true);
});

test('initialization survives restart, is not repeated and resends nothing',()=>{
  const seed=run('init-restart-seed');
  const r=run('init-restart-read',seed.home);
  assert.equal(r.state.available,true,JSON.stringify(r.state));
  assert.equal(r.markerId,seed.markerId);
  assert.equal(r.duplicate.status,200,JSON.stringify(r.duplicate));
  assert.equal(r.duplicate.body.inject_id,r.original);
  assert.deepEqual(r.writes,[],JSON.stringify(r.writes));
  assert.equal(r.reinit.status,409,JSON.stringify(r.reinit));
  assert.equal(r.after.marker,true);
});

test('production CLI sends one authenticated init POST and no daemon lifecycle call',()=>{
  const r=run('cli-init');
  assert.equal(r.requests,1,JSON.stringify(r));
  assert.equal(r.cliExit,0,r.stderr.join('\n'));
  assert.equal(r.after.available,true,JSON.stringify(r.after));
  assert.equal(r.after.marker,true);assert.equal(r.after.ledger,true);
  assert.equal(r.stdout.length,1,JSON.stringify(r.stdout));
  assert.deepEqual(JSON.parse(r.stdout[0]),{version:1,initialization:'created',marker_id:r.markerId});
  assert.deepEqual(r.writes,[]);
});

for(const variant of ['missing','extra','force','both','reset']) {
  test('CLI rejects conditional-store-init '+variant+' arguments before transport',()=>{
    const r=run('cli-init-args-'+variant);
    assert.equal(r.requests,0,JSON.stringify(r));
    assert.notEqual(r.cliExit,0,JSON.stringify(r));
    assert.equal(r.after.ledger,false,JSON.stringify(r.after));
    assert.equal(r.after.marker,false,JSON.stringify(r.after));
  });
}

test('CLI maps an unrecognized initialization response to a nonzero HOLD',()=>{
  const r=run('cli-init-unknown');
  assert.equal(r.requests,1,JSON.stringify(r));
  assert.notEqual(r.cliExit,0,JSON.stringify(r));
  assert.ok(r.stderr.some(l=>l.includes('HOLD initialization=unknown')),JSON.stringify(r.stderr));
  assert.equal(r.after.available,false,JSON.stringify(r.after));
});
