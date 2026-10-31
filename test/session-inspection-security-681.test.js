'use strict';
// Exact historical stimuli migrated to repository subtests; runtime and exact scan pending.
const {test:nodeTest}=require('node:test');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),os=require('node:os');
const http=require('node:http'),{Duplex}=require('node:stream');
const assert=require('node:assert/strict');
nodeTest('session-inspection-security-681',{concurrency:false},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'telepty-inspection-681-'));
 const fixtureRoot=path.join(root,'fixture');
 const privateEnv={HOME:path.join(root,'private','home'),USERPROFILE:path.join(root,'private','home'),
  XDG_CONFIG_HOME:path.join(root,'private','config'),XDG_DATA_HOME:path.join(root,'private','data'),TMPDIR:path.join(root,'private','tmp')};
 const saved=new Map(Object.keys(privateEnv).map(k=>[k,process.env[k]]));
 const plan={"status":"AUTHORED_NOTRUN","operations":[{"id":"s01","transport":"DIRECT_SETUP_OR_PUBLIC","call":"credential store","status":"NOTRUN"},{"id":"s02","transport":"DIRECT_SETUP_OR_PUBLIC","call":"state manager constructor with interval seam","status":"NOTRUN"},{"id":"s03","transport":"DIRECT_SETUP_OR_PUBLIC","call":"real record context","status":"NOTRUN"},{"id":"s04","transport":"DIRECT_SETUP_OR_PUBLIC","call":"real empty ledger","status":"NOTRUN"},{"id":"s05","transport":"DIRECT_SETUP_OR_PUBLIC","call":"real FileMailbox maxRetries1","status":"NOTRUN"},{"id":"s06","transport":"DIRECT_SETUP_OR_PUBLIC","call":"real delivery runtime","status":"NOTRUN"},{"id":"s07","transport":"DIRECT_SETUP_OR_PUBLIC","call":"real interaction core","status":"NOTRUN"},{"id":"a01","transport":"direct"},{"id":"s08","transport":"DIRECT_SETUP_OR_PUBLIC","call":"real inspection context","status":"NOTRUN"},{"id":"s09","transport":"DIRECT_SETUP_OR_PUBLIC","call":"real HTTP app","status":"NOTRUN"},{"id":"s10","transport":"DIRECT_SETUP_OR_PUBLIC","call":"real JWT verifier","status":"NOTRUN"},{"id":"s11","transport":"DIRECT_SETUP_OR_PUBLIC","call":"real peer predicate","status":"NOTRUN"},{"id":"s12","transport":"DIRECT_SETUP_OR_PUBLIC","call":"real origin guard","status":"NOTRUN"},{"id":"s13","transport":"DIRECT_SETUP_OR_PUBLIC","call":"register health and auth","status":"NOTRUN"},{"id":"s14","transport":"DIRECT_SETUP_OR_PUBLIC","call":"real signNodeJwt synthetic host claims","status":"NOTRUN"},{"id":"s15","transport":"DIRECT_SETUP_OR_PUBLIC","call":"register session registration","status":"NOTRUN"},{"id":"s16","transport":"DIRECT_SETUP_OR_PUBLIC","call":"register list","status":"NOTRUN"},{"id":"s17","transport":"DIRECT_SETUP_OR_PUBLIC","call":"register detail","status":"NOTRUN"},{"id":"s18","transport":"DIRECT_SETUP_OR_PUBLIC","call":"register submit-all","status":"NOTRUN"},{"id":"h01","group":"auth","transport":"HTTP","method":"GET","path":"/api/health","status":200,"auth":"missing","safety":"SELECTED_ORACLES_ONLY"},{"id":"h02","group":"auth","transport":"HTTP","method":"GET","path":"/api/health","status":200,"auth":"origin","safety":"SELECTED_ORACLES_ONLY"},{"id":"h03","group":"auth","transport":"HTTP","method":"GET","path":"/api/sessions","status":401,"auth":"missing","safety":"SELECTED_ORACLES_ONLY"},{"id":"h04","group":"auth","transport":"HTTP","method":"GET","path":"/api/sessions","status":401,"auth":"wrong","safety":"SELECTED_ORACLES_ONLY"},{"id":"h05","group":"auth","transport":"HTTP","method":"GET","path":"/api/sessions","status":403,"auth":"origin","safety":"SELECTED_ORACLES_ONLY"},{"id":"h06","group":"auth","transport":"HTTP","method":"GET","path":"/api/sessions","status":403,"auth":"peer","safety":"SELECTED_ORACLES_ONLY"},{"id":"h07","group":"auth","transport":"HTTP","method":"GET","path":"/api/sessions","status":200,"auth":"host","safety":"SELECTED_ORACLES_ONLY"},{"id":"h08","group":"auth","transport":"HTTP","method":"GET","path":"/api/sessions","status":200,"auth":"query","safety":"SELECTED_ORACLES_ONLY"},{"id":"h09","group":"auth","transport":"HTTP","method":"GET","path":"/api/sessions","status":200,"auth":"jwt","safety":"SELECTED_ORACLES_ONLY"},{"id":"h10","group":"auth","transport":"HTTP","method":"GET","path":"/api/sessions","status":401,"auth":"bad-jwt","safety":"SELECTED_ORACLES_ONLY"},{"id":"g01","group":"register","transport":"HTTP","method":"POST","path":"/api/sessions/register","status":201,"auth":"host","safety":"SELECTED_ORACLES_ONLY","registerId":"alpha-1"},{"id":"v01","transport":"DIRECT_PUBLIC","call":"real credentials.verify issued bearer","status":"NOTRUN"},{"id":"g02","group":"register","transport":"HTTP","method":"POST","path":"/api/sessions/register","status":201,"auth":"host","safety":"SELECTED_ORACLES_ONLY","registerId":"alpha-2"},{"id":"v02","transport":"DIRECT_PUBLIC","call":"real credentials.verify issued bearer","status":"NOTRUN"},{"id":"g03","group":"register","transport":"HTTP","method":"POST","path":"/api/sessions/register","status":201,"auth":"host","safety":"SELECTED_ORACLES_ONLY","registerId":"__proto__"},{"id":"v03","transport":"DIRECT_PUBLIC","call":"real credentials.verify issued bearer","status":"NOTRUN"},{"id":"g04","group":"register","transport":"HTTP","method":"POST","path":"/api/sessions/register","status":201,"auth":"host","safety":"SELECTED_ORACLES_ONLY","registerId":"constructor"},{"id":"v04","transport":"DIRECT_PUBLIC","call":"real credentials.verify issued bearer","status":"NOTRUN"},{"id":"g05","group":"register","transport":"HTTP","method":"POST","path":"/api/sessions/register","status":201,"auth":"host","safety":"SELECTED_ORACLES_ONLY","registerId":"prototype"},{"id":"v05","transport":"DIRECT_PUBLIC","call":"real credentials.verify issued bearer","status":"NOTRUN"},{"id":"g06","group":"register","transport":"HTTP","method":"POST","path":"/api/sessions/register","status":201,"auth":"host","safety":"SELECTED_ORACLES_ONLY","registerId":"../owned-outside"},{"id":"v06","transport":"DIRECT_PUBLIC","call":"real credentials.verify issued bearer","status":"NOTRUN"},{"id":"g07","group":"register","transport":"HTTP","method":"POST","path":"/api/sessions/register","status":201,"auth":"host","safety":"SELECTED_ORACLES_ONLY","registerId":"unsafe-child"},{"id":"v07","transport":"DIRECT_PUBLIC","call":"real credentials.verify issued bearer","status":"NOTRUN"},{"id":"g08","group":"register","transport":"HTTP","method":"POST","path":"/api/sessions/register","status":201,"auth":"host","safety":"SELECTED_ORACLES_ONLY","registerId":"unsafe-leaf"},{"id":"v08","transport":"DIRECT_PUBLIC","call":"real credentials.verify issued bearer","status":"NOTRUN"},{"id":"s19","transport":"DIRECT_SETUP_OR_PUBLIC","call":"explicit timestamp INPUT","status":"NOTRUN"},{"id":"s20","transport":"DIRECT_SETUP_OR_PUBLIC","call":"mailbox enqueue pending","status":"NOTRUN"},{"id":"s21","transport":"DIRECT_SETUP_OR_PUBLIC","call":"mailbox enqueue dead","status":"NOTRUN"},{"id":"s22","transport":"DIRECT_SETUP_OR_PUBLIC","call":"mailbox nack dead","status":"NOTRUN"},{"id":"s23","transport":"DIRECT_SETUP_OR_PUBLIC","call":"real peek positive control","status":"NOTRUN"},{"id":"s24","transport":"DIRECT_SETUP_OR_PUBLIC","call":"real peekDeadLetter positive","status":"NOTRUN"},{"id":"i01","group":"inspect","transport":"HTTP","method":"GET","path":"/api/sessions","status":200,"auth":"host","safety":"SELECTED_ORACLES_ONLY","resolvedId":null},{"id":"i02","group":"inspect","transport":"HTTP","method":"GET","path":"/api/sessions/alpha-1","status":200,"auth":"host","safety":"SELECTED_ORACLES_ONLY","resolvedId":"alpha-1"},{"id":"i03","group":"inspect","transport":"HTTP","method":"GET","path":"/api/sessions/missing","status":404,"auth":"host","safety":"SELECTED_ORACLES_ONLY","resolvedId":null},{"id":"i04","group":"inspect","transport":"HTTP","method":"GET","path":"/api/sessions/alpha","status":200,"auth":"host","safety":"SELECTED_ORACLES_ONLY","resolvedId":"alpha-2"},{"id":"i05","group":"inspect","transport":"HTTP","method":"GET","path":"/api/sessions/__proto__","status":200,"auth":"host","safety":"SELECTED_ORACLES_ONLY","resolvedId":"__proto__"},{"id":"i06","group":"inspect","transport":"HTTP","method":"GET","path":"/api/sessions/constructor","status":200,"auth":"host","safety":"SELECTED_ORACLES_ONLY","resolvedId":"constructor"},{"id":"i07","group":"inspect","transport":"HTTP","method":"GET","path":"/api/sessions/prototype","status":200,"auth":"host","safety":"SELECTED_ORACLES_ONLY","resolvedId":"prototype"},{"id":"i08","group":"inspect","transport":"HTTP","method":"GET","path":"/api/sessions?idle_gt=3600","status":200,"auth":"host","safety":"SELECTED_ORACLES_ONLY","resolvedId":null},{"id":"i09","group":"inspect","transport":"HTTP","method":"GET","path":"/api/sessions/alpha-1","status":200,"auth":"host","safety":"SELECTED_ORACLES_ONLY","resolvedId":"alpha-1"},{"id":"s25","transport":"DIRECT_SETUP_OR_PUBLIC","call":"state markTerminationRequested","status":"NOTRUN"},{"id":"i10","group":"activity","transport":"HTTP","method":"GET","path":"/api/sessions/alpha-1","status":200,"auth":"host","safety":"SELECTED_ORACLES_ONLY"},{"id":"s26","transport":"DIRECT_SETUP_OR_PUBLIC","call":"mkdir owned outside","status":"NOTRUN"},{"id":"s27","transport":"DIRECT_SETUP_OR_PUBLIC","call":"write owned sentinel","status":"NOTRUN"},{"id":"s28","transport":"DIRECT_SETUP_OR_PUBLIC","call":"symlink unsafe mailbox child","status":"NOTRUN"},{"id":"s29","transport":"DIRECT_SETUP_OR_PUBLIC","call":"mkdir unsafe mailbox leaf dir","status":"NOTRUN"},{"id":"s30","transport":"DIRECT_SETUP_OR_PUBLIC","call":"symlink unsafe inbox leaf","status":"NOTRUN"},{"id":"s31","transport":"DIRECT_SETUP_OR_PUBLIC","call":"direct pathlike peek refusal","status":"NOTRUN"},{"id":"s32","transport":"DIRECT_SETUP_OR_PUBLIC","call":"direct child peek refusal","status":"NOTRUN"},{"id":"s33","transport":"DIRECT_SETUP_OR_PUBLIC","call":"direct leaf peek refusal","status":"NOTRUN"},{"id":"i11","group":"unsafe","transport":"HTTP","method":"GET","path":"/api/sessions/..%2Fowned-outside","status":200,"auth":"host","safety":"ZERO_COUNTS_ARE_CAUGHT_REFUSAL_NOT_ABSENCE"},{"id":"i12","group":"unsafe","transport":"HTTP","method":"GET","path":"/api/sessions/unsafe-child","status":200,"auth":"host","safety":"ZERO_COUNTS_ARE_CAUGHT_REFUSAL_NOT_ABSENCE"},{"id":"i13","group":"unsafe","transport":"HTTP","method":"GET","path":"/api/sessions/unsafe-leaf","status":200,"auth":"host","safety":"ZERO_COUNTS_ARE_CAUGHT_REFUSAL_NOT_ABSENCE"},{"id":"s34","transport":"DIRECT_SETUP_OR_PUBLIC","call":"select two real issued sessions and terminal captures INPUT","status":"NOTRUN"},{"id":"t01","group":"submit","transport":"HTTP","method":"POST","path":"/api/sessions/submit-all","status":200,"auth":"host","safety":"RATE_ASSESSMENT_IN_POLICY_RECEIPT"},{"id":"t02","group":"submit","transport":"HTTP","method":"POST","path":"/api/sessions/submit-all","status":429,"auth":"host","safety":"SELECTED_RATE_REFUSAL_MATCH"},{"id":"t03","group":"submit","transport":"HTTP","method":"POST","path":"/api/sessions/submit-all","status":429,"auth":"host","safety":"SELECTED_RATE_REFUSAL_MATCH"},{"id":"s35","transport":"DIRECT_SETUP_OR_PUBLIC","call":"trusted interaction ledger busy/held INPUT","status":"NOTRUN"},{"id":"a-clock-4","transport":"direct"},{"id":"t04","group":"submit","transport":"HTTP","method":"POST","path":"/api/sessions/submit-all","status":200,"auth":"host","safety":"SELECTED_ORACLES_ONLY"},{"id":"a-no-refund-4","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":429,"safety":"SELECTED_NO_REFUND_MATCH"},{"id":"s36","transport":"DIRECT_SETUP_OR_PUBLIC","call":"clear ledger INPUT and close captured owner","status":"NOTRUN"},{"id":"a-clock-5","transport":"direct"},{"id":"t05","group":"submit","transport":"HTTP","method":"POST","path":"/api/sessions/submit-all","status":200,"auth":"host","safety":"SELECTED_ORACLES_ONLY"},{"id":"a-no-refund-5","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":429,"safety":"SELECTED_NO_REFUND_MATCH"},{"id":"s37","transport":"DIRECT_SETUP_OR_PUBLIC","call":"throwing first terminal INPUT","status":"NOTRUN"},{"id":"a-clock-6","transport":"direct"},{"id":"t06","group":"submit","transport":"HTTP","method":"POST","path":"/api/sessions/submit-all","status":500,"auth":"host","safety":"BATCH_THROW_ABORT_CHARACTERIZATION"},{"id":"a-no-refund-6","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":429,"safety":"SELECTED_NO_REFUND_MATCH"},{"id":"s38","transport":"DIRECT_SETUP_OR_PUBLIC","call":"available first/throwing closed PTY INPUT","status":"NOTRUN"},{"id":"a-clock-7","transport":"direct"},{"id":"t07","group":"submit","transport":"HTTP","method":"POST","path":"/api/sessions/submit-all","status":500,"auth":"host","safety":"BATCH_THROW_ABORT_CHARACTERIZATION"},{"id":"a-no-refund-7","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":429,"safety":"SELECTED_NO_REFUND_MATCH"},{"id":"x-restore-terminal","transport":"direct","group":"focused","purpose":"x-restore-terminal"},{"id":"default-a-context","transport":"direct","group":"focused","purpose":"default-a-context"},{"id":"default-a-app","transport":"direct","group":"focused","purpose":"default-a-app"},{"id":"default-a-auth","transport":"direct","group":"focused","purpose":"default-a-auth"},{"id":"default-a-route","transport":"direct","group":"focused","purpose":"default-a-route"},{"id":"default-b-context","transport":"direct","group":"focused","purpose":"default-b-context"},{"id":"default-b-app","transport":"direct","group":"focused","purpose":"default-b-app"},{"id":"default-b-auth","transport":"direct","group":"focused","purpose":"default-b-auth"},{"id":"default-b-route","transport":"direct","group":"focused","purpose":"default-b-route"},{"id":"x-default-first","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":200,"safety":"SELECTED_ORACLES_ONLY"},{"id":"x-default-second","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":429,"allowTimingInconclusive":true,"safety":"TIMING_CONDITIONAL"},{"id":"x-fraction-bucket","transport":"direct","group":"focused","purpose":"x-fraction-bucket"},{"id":"fraction-context","transport":"direct","group":"focused","purpose":"fraction-context"},{"id":"fraction-app","transport":"direct","group":"focused","purpose":"fraction-app"},{"id":"fraction-auth","transport":"direct","group":"focused","purpose":"fraction-auth"},{"id":"fraction-route","transport":"direct","group":"focused","purpose":"fraction-route"},{"id":"x-fraction-first","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":200,"safety":"SELECTED_ORACLES_ONLY"},{"id":"x-clock-quarter","transport":"direct","group":"focused","purpose":"x-clock-quarter"},{"id":"x-quarter-refusal","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":429,"safety":"SELECTED_ORACLES_ONLY"},{"id":"x-clock-one","transport":"direct","group":"focused","purpose":"x-clock-one"},{"id":"x-exact-refill","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":200,"safety":"SELECTED_ORACLES_ONLY"},{"id":"x-clock-long","transport":"direct","group":"focused","purpose":"x-clock-long"},{"id":"x-long-gap","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":200,"safety":"SELECTED_ORACLES_ONLY"},{"id":"x-credit-cap","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":429,"safety":"SELECTED_ORACLES_ONLY"},{"id":"x-single-registry","transport":"direct"},{"id":"x-single-clock","transport":"direct"},{"id":"x-single-target","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":200,"safety":"SELECTED_ORACLES_ONLY"},{"id":"x-single-charged","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":429,"safety":"SELECTED_ORACLES_ONLY"},{"id":"x-two-registry","transport":"direct"},{"id":"x-direct-distinction","transport":"direct","group":"focused","purpose":"x-direct-distinction"},{"id":"x-invalid-initial","transport":"direct","group":"focused","purpose":"x-invalid-initial"},{"id":"x-invalid-bucket","transport":"direct","group":"focused","purpose":"x-invalid-bucket"},{"id":"invalid-context","transport":"direct","group":"focused","purpose":"invalid-context"},{"id":"invalid-app","transport":"direct","group":"focused","purpose":"invalid-app"},{"id":"invalid-auth","transport":"direct","group":"focused","purpose":"invalid-auth"},{"id":"invalid-route","transport":"direct","group":"focused","purpose":"invalid-route"},{"id":"x-invalid-first","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":503,"safety":"SELECTED_ORACLES_ONLY"},{"id":"x-invalid-zero","transport":"direct","group":"focused","purpose":"x-invalid-zero"},{"id":"x-invalid-recover-token","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":200,"safety":"SELECTED_ORACLES_ONLY"},{"id":"x-invalid-half","transport":"direct","group":"focused","purpose":"x-invalid-half"},{"id":"x-invalid-half-refusal","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":429,"safety":"SELECTED_ORACLES_ONLY"},{"id":"x-clock-infinity","transport":"direct","group":"focused","purpose":"x-clock-infinity"},{"id":"x-infinity","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":503,"safety":"SELECTED_ORACLES_ONLY"},{"id":"x-recover-infinity","transport":"direct","group":"focused","purpose":"x-recover-infinity"},{"id":"x-recovery-infinity","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":429,"safety":"SELECTED_ORACLES_ONLY"},{"id":"x-clock-negative","transport":"direct","group":"focused","purpose":"x-clock-negative"},{"id":"x-negative","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":503,"safety":"SELECTED_ORACLES_ONLY"},{"id":"x-recover-negative","transport":"direct","group":"focused","purpose":"x-recover-negative"},{"id":"x-recovery-negative","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":429,"safety":"SELECTED_ORACLES_ONLY"},{"id":"x-clock-unsafe","transport":"direct","group":"focused","purpose":"x-clock-unsafe"},{"id":"x-unsafe","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":503,"safety":"SELECTED_ORACLES_ONLY"},{"id":"x-recover-unsafe","transport":"direct","group":"focused","purpose":"x-recover-unsafe"},{"id":"x-recovery-unsafe","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":429,"safety":"SELECTED_ORACLES_ONLY"},{"id":"x-clock-regressing","transport":"direct","group":"focused","purpose":"x-clock-regressing"},{"id":"x-regressing","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":503,"safety":"SELECTED_ORACLES_ONLY"},{"id":"x-recover-regressing","transport":"direct","group":"focused","purpose":"x-recover-regressing"},{"id":"x-recovery-regressing","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":429,"safety":"SELECTED_ORACLES_ONLY"},{"id":"x-clock-throwing","transport":"direct","group":"focused","purpose":"x-clock-throwing"},{"id":"x-throwing","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":503,"safety":"SELECTED_ORACLES_ONLY"},{"id":"x-recover-throwing","transport":"direct","group":"focused","purpose":"x-recover-throwing"},{"id":"x-recovery-throwing","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":429,"safety":"SELECTED_ORACLES_ONLY"},{"id":"x-invalid-final-one","transport":"direct","group":"focused","purpose":"x-invalid-final-one"},{"id":"x-invalid-final-refill","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":200,"safety":"SELECTED_ORACLES_ONLY"},{"id":"x-auth-clock","transport":"direct","group":"focused","purpose":"x-auth-clock"},{"id":"x-auth-bucket","transport":"direct","group":"focused","purpose":"x-auth-bucket"},{"id":"authcase-context","transport":"direct","group":"focused","purpose":"authcase-context"},{"id":"authcase-app","transport":"direct","group":"focused","purpose":"authcase-app"},{"id":"authcase-auth","transport":"direct","group":"focused","purpose":"authcase-auth"},{"id":"authcase-route","transport":"direct","group":"focused","purpose":"authcase-route"},{"id":"x-auth-denied","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"missing","status":401,"safety":"SELECTED_ORACLES_ONLY"},{"id":"x-parser-error","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":400,"safety":"SELECTED_ORACLES_ONLY","raw":"{"},{"id":"x-auth-allowed","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":200,"safety":"SELECTED_ORACLES_ONLY"},{"id":"x-auth-charged","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":429,"safety":"SELECTED_ORACLES_ONLY"},{"id":"x-empty-clock-bucket","transport":"direct","group":"focused","purpose":"x-empty-clock-bucket"},{"id":"emptycase-context","transport":"direct","group":"focused","purpose":"emptycase-context"},{"id":"emptycase-app","transport":"direct","group":"focused","purpose":"emptycase-app"},{"id":"emptycase-auth","transport":"direct","group":"focused","purpose":"emptycase-auth"},{"id":"emptycase-route","transport":"direct","group":"focused","purpose":"emptycase-route"},{"id":"x-empty-registry","transport":"direct","group":"focused","purpose":"x-empty-registry"},{"id":"x-empty","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":200,"safety":"SELECTED_ORACLES_ONLY"},{"id":"x-restore-registry","transport":"direct","group":"focused","purpose":"x-restore-registry"},{"id":"x-unavailable-state","transport":"direct","group":"focused","purpose":"x-unavailable-state"},{"id":"x-unavailable-clock","transport":"direct","group":"focused","purpose":"x-unavailable-clock"},{"id":"x-all-unavailable","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":200,"safety":"SELECTED_ORACLES_ONLY"},{"id":"x-unavailable-charged","transport":"HTTP","group":"focused","method":"POST","path":"/api/sessions/submit-all","auth":"host","status":429,"safety":"SELECTED_ORACLES_ONLY"},{"id":"s39","transport":"DIRECT_SETUP_OR_PUBLIC","call":"restore registry INPUT","status":"NOTRUN"},{"id":"f01","transport":"DIRECT_PUBLIC_CLEANUP","call":"real state.destroyAll;zero scheduler handles","status":"NOTRUN"}],"http":72,"countedOperations":180,"allHeaderBaseline":"Desired absent on every actual response; runtime NOTRUN","desiredRate":"Actual constructor bucket capacity1/refill1s; t01 admitted,t02/t03 refused; singleton timing>=1s INCONCLUSIVE","runtime":"NOTRUN"};
 const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
 let count=0,wireBytes=0,opCount=0,active=null,hostToken,jwt;
 const outcomes=plan.operations.map(r=>({id:r.id,status:'NOTRUN'}));
 const effects=[],bus=[],directEvidence=[],handles=new Map(),timeouts=new Map(),measurements=[],pendingHTTP=new Set();
 let state,scheduled=0,timeoutSeq=0,callbacks=0,stateCleanupAttempted=false;
 function enter(id){
  active=outcomes.find(r=>r.id===id);assert.ok(active&&active.status==='NOTRUN');
  if(id!=='f01')assert.equal(plan.operations[opCount].id,id,'planned chronology');
  assert.ok(++opCount<=256);active.status='RUNNING';
 }
 async function group(id,fn){
  enter(id);let value,failed=false;
  await t.test(id,{concurrency:false},async sub=>{
   try{value=await fn(sub);if(active.status==='RUNNING')active.status='MATCH';}
   catch(error){failed=true;active.status='MISMATCH';
    const identity=['AssertionError','TypeError','RangeError'].includes(error?.name)?error.name:'Error';
    throw new Error(identity+' in '+id+'; private diagnostic values suppressed');
   }
  });
  if(failed)throw new Error('Dependent sequence stopped after '+id);
  return value;
 }
 async function direct(id,fn){return await group(id,fn);}
function files(){
  const rows=[];let total=0;
  function visit(dir){for(const n of fs.readdirSync(dir).sort()){
    const p=path.join(dir,n),s=fs.lstatSync(p),rel=path.relative(fixtureRoot,p);
    const r={path:rel,mode:s.mode&0o777,ino:s.ino,nlink:s.nlink};
    if(s.isSymbolicLink()){
      const target=fs.readlinkSync(p),absolute=path.resolve(path.dirname(p),target);
      assert.ok(absolute.startsWith(fixtureRoot+path.sep));rows.push({...r,type:'link',target});
    }else if(s.isDirectory()){rows.push({...r,type:'directory'});visit(p);}
    else{
      assert.ok(s.isFile()&&s.size<=65536);const b=fs.readFileSync(p);total+=b.length;assert.ok(total<=65536);
      rows.push({...r,type:'file',mtimeMs:s.mtimeMs,size:b.length,sha256:sha(b),base64:b.toString('base64')});
    }
  }}
  visit(fixtureRoot);return rows;
}
function requestImpl(app, row) {
  return new Promise((resolve, reject) => {
    assert.ok(++count <= 128);
    const bytes = Buffer.from(row.raw === undefined ? JSON.stringify(row.body || {}) : row.raw);
    assert.ok(bytes.length <= 1024);
    const chunks = [];
    let responseBytes = 0, fed = false, finished = false, settled = false;
    const transport = new Duplex({read(){},write(_c,_e,cb){cb();},autoDestroy:false});
    transport.remoteAddress = row.auth === 'peer' ? '198.51.100.1' : '127.0.0.1';
    const sink = new Duplex({read(){},write(chunk,_enc,cb){
      responseBytes += chunk.length; wireBytes += chunk.length;
      if(responseBytes > 65536 || wireBytes > 1048576) return cb(Error('response budget'));
      chunks.push(Buffer.from(chunk)); cb();
    },autoDestroy:false});
    const req = new http.IncomingMessage(transport);
    req.method = row.method; req.url = row.path;
    if(row.auth==='query')req.url+=(req.url.includes('?')?'&':'?')+'token='+encodeURIComponent(hostToken);
    req.httpVersion = '1.1'; req.httpVersionMajor = 1; req.httpVersionMinor = 1;
    req.headers = {'content-type':'application/json','content-length':String(bytes.length),connection:'close'};
    if(!['missing','query','jwt','bad-jwt'].includes(row.auth)) req.headers['x-telepty-token'] = row.auth === 'wrong' ? 'wrong-private-token' : hostToken;
    if(row.auth==='jwt'||row.auth==='bad-jwt')req.headers.authorization='Bearer '+(row.auth==='jwt'?jwt:'invalid.jwt.signature');
    if(row.auth === 'origin') req.headers.origin = 'https://denied.invalid';
    if(row.sessionBearer)req.headers['x-telepty-session-token']=row.sessionBearer;
    req.rawHeaders = Object.entries(req.headers).flat();
    req._read = function(){
      if(fed) return; fed = true; this.push(bytes); this.complete = true; this.push(null);
    };
    const res = new http.ServerResponse(req);
    res.shouldKeepAlive = false; res.assignSocket(sink);
    const objects = [req,res,sink,transport];
    const timer = setTimeout(() => done(Error('request timeout ' + row.id)), 2000);
    const errorHandler = error => done(error);
    objects.forEach(o => o.on('error',errorHandler));
    res.once('finish',()=>{finished=true;setImmediate(()=>done());});
    function done(error) {
      if(settled) return; settled=true;clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const split = raw.indexOf('\r\n\r\n');
      const result = {status:res.statusCode,raw,body:raw.slice(split+4),finished,
        requestBytes:bytes.length,fed,requestComplete:req.complete,requestEnded:req.readableEnded,
        responseBytes,request:{method:row.method,path:req.url,headers:{...req.headers},body:bytes.toString('utf8')}};
      Promise.all(objects.map(o=>new Promise(close=>{
        if(o.closed) return close();
        o.once('close',close);o.destroy();
      }))).then(()=>{
        objects.forEach(o=>o.removeAllListeners());
        result.disposed=objects.every(o=>o.destroyed);
        result.listeners=objects.reduce((n,o)=>n+o.eventNames().length,0);
        if(error){error.wire=result;reject(error);}else resolve(result);
      },reject);
    }
    try { app.handle(req,res); } catch(error) { done(error); }
  });
}


function request(app,row){
 const pending=requestImpl(app,row);pendingHTTP.add(pending);
 pending.then(()=>pendingHTTP.delete(pending),()=>pendingHTTP.delete(pending));
 return pending;
}

 try{
  for(const dir of new Set(Object.values(privateEnv)))fs.mkdirSync(dir,{recursive:true,mode:0o700});
  for(const [k,v] of Object.entries(privateEnv))process.env[k]=v;
  fs.mkdirSync(fixtureRoot,{mode:0o700});
  await main();
 }finally{
  const cleanupErrors=[];
  try{
   try{await Promise.allSettled([...pendingHTTP]);}catch{cleanupErrors.push('HTTP cleanup');}
   if(state&&!stateCleanupAttempted){
    stateCleanupAttempted=true;try{state.destroyAll();}catch{cleanupErrors.push('state cleanup');}
   }
   try{assert.equal(handles.size,0);assert.equal(timeouts.size,0);if(state){assert.equal(state._machines.size,0);assert.equal(state._globalListeners.length,0);}}catch{cleanupErrors.push('remaining resources');}
  }finally{
   try{for(const [k,v] of saved){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
   finally{fs.rmSync(root,{recursive:true,force:true});}
  }
  if(cleanupErrors.length)throw new Error('Owned resource cleanup failed');
 }
 async function main(){
  for(const name of ['../auth.js','../src/protocol/http-auth.js']){
   assert.equal(require.cache[require.resolve(name)],undefined,'auth must first load inside private HOME');
  }
  const local=p=>p.startsWith('node_modules/')?require(p.slice('node_modules/'.length)):require('../'+p);
  const express=local('node_modules/express'),cors=local('node_modules/cors');
  const httpApp=local('src/protocol/http-app.js'),auth=local('src/protocol/http-auth.js');
  const metadata=local('src/session-store/route-metadata.js');
  const records=local('src/routes/session-records.js'),persistence=local('src/session-store/persistence.js');
  const {createCredentialStore}=local('src/session-store/session-credentials.js');
  const stateModule=local('session-state.js'),completion=local('src/completion-observation.js');
  const {createDeliveryRuntime}=local('src/mailbox/delivery-runtime.js');
  const {createSessionInspectionContext}=local('src/routes/session-inspection.js');
  const {createSubmitAdmission}=local('src/submit-admission.js');
  const {FileMailbox}=local('src/mailbox/index.js'),lifecycle=local('src/lifecycle.js');
  const interaction=local('src/interaction.js'),readyRegistry=local('src/prompt-symbol-registry.js');
  const {isOpenWebSocket}=local('src/transport/websocket.js');

  const sessions=Object.create(null),tokens=new Map(),nonces=new Map();
  const credentials=await direct('s01',()=>createCredentialStore());
  const scheduler={setInterval(fn,ms){assert.ok(++scheduled<=128);handles.set(scheduled,{fn,ms});return scheduled;},
    clearInterval(id){assert.ok(handles.delete(id));}};
  state=await direct('s02',()=>new stateModule.SessionStateManager({},scheduler));
  const context=await direct('s03',()=>records.createSessionRecordContext({sessions,sessionCredentials:credentials,
    sidNonces:nonces,sessionPersistPath:path.join(fixtureRoot,'sessions.json')}));
  const ledger=await direct('s04',()=>persistence.emptyTrackedInjections());
  // #1207: the product no longer reads an in-memory `trackedInjections` mirror; held/busy interaction
  // state comes from the ledger client's committed read model. The same explicit INPUT reaches that
  // seam: a real, never-opened client (no worker, no files) whose read model mirrors `ledger`.
  const {createLedgerClient}=local('src/session-store/ledger-client.js');
  const ledgerClient=createLedgerClient({dir:path.join(fixtureRoot,'ledger-store'),lockPath:path.join(fixtureRoot,'ledger.lock')});
  const mirrorLedger=()=>{const m=ledgerClient._internal.readModel;m.actions=new Map(Object.entries(ledger.interactions.actions));m.pending=new Map(Object.entries(ledger.interactions.pending));};
  const mailbox=await direct('s05',()=>new FileMailbox({root:path.join(fixtureRoot,'mailbox'),maxRetries:1}));
  const busClients=new Set([{readyState:1,send(text){assert.ok(bus.length<256);bus.push(JSON.parse(text));}}]);
  const shared={sessions,sessionStateManager:state,sessionPersistence:persistence,trackedInjections:ledger,ledgerClient,
    trackedLedgerHealthy:true,trackedLedgerUnavailableReason:null,TRACKED_INJECTIONS_PATH:path.join(fixtureRoot,'ledger.json'),
    interaction,readyRegistry,isOpenWebSocket,fs,isBootstrapGatedSession:metadata.isBootstrapGatedSession,interactionWaiters:new Map(),
    UPSTREAM_STALL_SECONDS:30,SESSION_STALE_SECONDS:300};
  const timers={setTimeout(fn,ms){assert.ok(++timeoutSeq<=128);const h={unref(){return this;}};
    timeouts.set(h,{fn,ms});return h;},clearTimeout(h){timeouts.delete(h);}};
  const runtime=await direct('s06',()=>createDeliveryRuntime(shared,timers));
  shared.interactionCore=await direct('s07',()=>runtime.createInteractionRuntime());
  // Exact daemon table data, not a replacement native-submit route.
  const SUBMIT_STRATEGIES={claude:'pty_cr',gemini:'pty_cr',codex:'pty_cr'};
  let originalNow=0;
  const originalAdmission=await direct('a01',()=>createSubmitAdmission({now:()=>originalNow}));
  const inspectionShared={...runtime,...completion,
    mapObservationCause:stateModule.mapObservationCause,OBSERVATION_DISPLAY:stateModule.OBSERVATION_DISPLAY,
    sessionStateManager:state,MACHINE_ID:'private-inspection',lifecycle,teleptyConfig:{},mailbox,sessions,
    resolveSessionAlias:context.resolveSessionAlias,SUBMIT_STRATEGIES};
  const inspection=await direct('s08',()=>createSessionInspectionContext(inspectionShared,{admission:originalAdmission}));
  const app=await direct('s09',()=>httpApp.createHttpApp({express,cors}));
  hostToken=crypto.randomBytes(24).toString('hex');
  const jwtSecret=crypto.randomBytes(32).toString('hex'); // private generated host authentication inputs
  const verifyJwt=await direct('s10',()=>auth.createVerifyJwt(jwtSecret));
  const isAllowedPeer=await direct('s11',()=>auth.createIsAllowedPeer(['192.0.2.0/24']));
  const isForbiddenOrigin=await direct('s12',()=>auth.createOriginGuard(['https://fixture.invalid']));
  await direct('s13',()=>httpApp.registerHealthAndAuth(app,{pkg:local('package.json'),createAuthMiddleware:auth.createAuthMiddleware,
    EXPECTED_TOKEN:hostToken,verifyJwt,isAllowedPeer,isForbiddenOrigin}));
  jwt=await direct('s14',()=>auth.signNodeJwt(jwtSecret,{sub:'synthetic-host-controller',exp:Math.floor(Date.now()/1000)+60}));
  await direct('s15',()=>records.registerSessionRegisterRoute(app,{context,sessionStateManager:state,busClients}));
  await direct('s16',()=>inspection.registerListRoute(app));
  await direct('s17',()=>inspection.registerGetRoute(app));
  await direct('s18',()=>inspection.registerSubmitAllRoute(app));
  const all=plan.operations.filter(r=>r.transport==='HTTP');
  const globalBefore=Object.getOwnPropertyDescriptors(Object.prototype);
  const snapshot=()=>({files:files(),issuedCredentials:tokens.size,stateMachines:state._machines.size,
    intervals:handles.size,timeouts:timeouts.size,bus:bus.length,effects:effects.length,
    sessionInputs:Object.entries(sessions).map(([id,s])=>({id,type:s.type,
      ownerReady:s.ownerWs?s.ownerWs.readyState:null,ptyKilled:s.ptyProcess?s.ptyProcess.killed:null,
      inputGeneration:s.interactionInputGeneration||0,invalidation:s.interactionInvalidation||null,
      probeAt:s.upstreamProbeAt??null,probeWatermark:s.upstreamProbeWatermark??null})),
    interactionLedger:JSON.parse(JSON.stringify(shared.trackedInjections.interactions))});

  async function runHttp(id,check,selectedApp=app){
    const row=all.find(r=>r.id===id);assert.ok(row);
    return await group(id,async sub=>{
    const before=snapshot(),start=process.hrtime.bigint();let wire;
      const requestRow={...row};
      if(row.registerId)requestRow.body={session_id:row.registerId,command:'generic-tool',cwd:fixtureRoot};
      wire=await request(selectedApp,requestRow);
      if(row.allowTimingInconclusive)assert.ok([200,429].includes(wire.status));else assert.equal(wire.status,row.status);
      assert.ok(wire.finished&&wire.disposed);assert.equal(wire.listeners,0);
      const header=/\r\nx-powered-by: ([^\r]+)/i.exec(wire.raw);
      assert.equal(header,null,'X-Powered-By must be absent');
      assert.match(wire.raw,/\r\nAccess-Control-Allow-Origin: \*\r\n/i,'original CORS header retained');
      let body;if(![400,500].includes(wire.status))body=JSON.parse(wire.body);
      const observation=check?check(body,wire):null;
      assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype),globalBefore);
      active.status=observation?.assessment==='INCONCLUSIVE'?'INCONCLUSIVE':'MATCH';
      measurements.push({id,before,after:snapshot(),effects:effects.slice(before.effects),
        bus:bus.slice(before.bus),elapsedNs:String(process.hrtime.bigint()-start),observation});
      if(observation?.assessment==='INCONCLUSIVE'){
       assert.equal(id,'x-default-second');
       sub.diagnostic('INCONCLUSIVE singleton timing elapsedNs='+observation.elapsedNs+'; status='+wire.status);
       sub.skip('INCONCLUSIVE: elapsed >=1s; shared allowance not established');
      }
      return {wire,body,start,end:process.hrtime.bigint()};
    });
  }

  try{
    for(const row of all.filter(r=>r.group==='auth'))await runHttp(row.id,body=>{
      if(row.status===401)assert.equal(body.code,'PERMISSION_DENIED');
      if(row.auth==='origin'&&row.status===403)assert.equal(body.code,'ORIGIN_NOT_ALLOWED');
      if(row.auth==='peer')assert.equal(body.code,'PEER_NOT_ALLOWED');
      if(row.path==='/api/health')assert.equal(body.status,'ok');
      else if(row.status===200)assert.deepEqual(body,[]);
    });
    for(const row of all.filter(r=>r.group==='register')){
      await runHttp(row.id,body=>{tokens.set(row.registerId,body.session_token);});
      await direct('v'+row.id.slice(1),()=>assert.equal(credentials.verify(tokens.get(row.registerId)).sid,row.registerId));
    }
    await direct('s19',()=>{
      // Explicit timestamp INPUT, not a fabricated observed clock advance.
      sessions['alpha-1'].lastActivityAt='2000-01-01T00:00:00Z';
      sessions['alpha-1'].createdAt='2026-01-01T00:00:00Z';
      sessions['alpha-2'].createdAt='2026-01-02T00:00:00Z';
    });
    const now=Math.floor(Date.now()/1000);
    await direct('s20',()=>{assert.equal(mailbox.enqueue({msg_id:'pending',from:'fixture',to:'alpha-1',payload:'pending INPUT',created_at:now}).queued,true);});
    await direct('s21',()=>{assert.equal(mailbox.enqueue({msg_id:'dead',from:'fixture',to:'alpha-1',payload:'dead INPUT',created_at:now}).queued,true);});
    await direct('s22',()=>mailbox.nack('alpha-1','dead','owned negative input'));
    await direct('s23',()=>assert.equal(mailbox.peek('alpha-1').filter(x=>x.state==='pending').length,1));
    await direct('s24',()=>assert.equal(mailbox.peekDeadLetter('alpha-1').length,1));
    for(const row of all.filter(r=>r.group==='inspect'))await runHttp(row.id,body=>{
      if(row.id==='i03'){assert.equal(body.error,'Session not found');return;}
      if(row.id==='i01'){assert.equal(body.length,8);return;}
      if(row.id==='i08'){assert.deepEqual(body.map(x=>x.id),['alpha-1']);return;}
      assert.equal(body.id,row.resolvedId);
      assert.equal(body.completion.completion_fact,null);assert.equal(body.completion.terminal,false);
      assert.ok(body.activityObservation&&typeof body.activityObservation.kind==='string');
      assert.equal(Object.hasOwn(body,'autoState'),false);
      if(row.id==='i04')assert.equal(body.alias,'alpha');
      if(row.id==='i09')assert.deepEqual(body.mailbox,{pending:1,dead_letter:1});
    });
    await direct('s25',()=>state.markTerminationRequested('alpha-1','fixture-direct-observation',null));
    await runHttp('i10',body=>{
      assert.equal(body.activityObservation.kind,'session_termination_requested');
      assert.equal(body.completion.completion_fact,null);assert.equal(body.completion.terminal,false);
    });
    const outside=path.join(fixtureRoot,'owned-outside'),sentinel=path.join(outside,'sentinel');
    await direct('s26',()=>fs.mkdirSync(outside,{mode:0o700}));
    await direct('s27',()=>fs.writeFileSync(sentinel,'private sentinel\n',{flag:'wx',mode:0o600}));
    await direct('s28',()=>fs.symlinkSync(outside,path.join(fixtureRoot,'mailbox','unsafe-child'),'dir'));
    await direct('s29',()=>fs.mkdirSync(path.join(fixtureRoot,'mailbox','unsafe-leaf'),{mode:0o700}));
    await direct('s30',()=>fs.symlinkSync(sentinel,path.join(fixtureRoot,'mailbox','unsafe-leaf','inbox.jsonl')));
    for(const [sid,id,code] of [['../owned-outside','s31','MAILBOX_INVALID_SESSION_ID'],
      ['unsafe-child','s32','MAILBOX_UNSAFE_PATH'],['unsafe-leaf','s33','MAILBOX_UNSAFE_PATH']]){
      await direct(id,()=>{assert.throws(()=>mailbox.peek(sid),e=>{
        directEvidence.push({id,sid,error:{name:e.name,message:e.message,stack:e.stack,code:e.code}});
        return e.code===code;
      });});
    }
    const protectedBefore=files();
    for(const id of ['i11','i12','i13'])await runHttp(id,body=>{
      assert.deepEqual(body.mailbox,{pending:0,dead_letter:0});
      assert.deepEqual(files(),protectedBefore);
      return {countMeaning:'serializer caught actual mailbox refusal; not empty-mailbox proof'};
    });
    const saved=Object.entries(sessions);
    const first=sessions['alpha-1'],second=sessions['alpha-2'];
    function terminal(session,kind,throws=false){
      return data=>{assert.ok(effects.length<64);const value=kind==='owner'?JSON.parse(data).data:data;
        assert.equal(value,'\r');effects.push({sid:session.id,kind,data:value,throws});
        if(throws)throw Error('captured terminal failure '+session.id);};
    }
    await direct('s34',()=>{for(const key of Object.keys(sessions))delete sessions[key];
      sessions['alpha-1']=first;sessions['alpha-2']=second;
      first.type='wrapped';first.ownerWs={readyState:1,send:terminal(first,'owner')};
      second.type='spawned';second.ptyProcess={pid:null,killed:false,write:terminal(second,'pty')};});
    const batch=[];
    for(const id of ['t01','t02','t03']){
      const startEffects=effects.length,gen1=first.interactionInputGeneration||0,gen2=second.interactionInputGeneration||0;
      const admissionBefore=snapshot();
      batch.push(await runHttp(id,(body,wire)=>{
        if(id!=='t01'){assert.equal(body.code,'RATE_LIMITED');assert.match(wire.raw,/\r\nRetry-After: 1\r\n/i);assert.deepEqual(snapshot(),admissionBefore);return;}
        assert.deepEqual(body.results.successful.map(x=>x.id),['alpha-1','alpha-2']);
        assert.deepEqual(body.results.failed,[]);assert.equal(effects.length-startEffects,2);
        assert.equal(first.interactionInputGeneration,gen1+1);assert.equal(second.interactionInputGeneration,gen2+1);
        assert.equal(first.interactionInvalidation,'submit');assert.ok(first.upstreamProbeAt!=null);
      }));
    }
    const intervalNs=batch[2].end-batch[0].start;
    const rateObservation={elapsedNs:String(intervalNs),accepted:1,refused:2,constructorClockSeconds:0,assessment:'SELECTED_ORACLES_MATCH'};
    await direct('s35',()=>{ // Explicit trusted ledger INPUT; real core/held checks, not remote valid-frame reproduction.
      ledger.interactions.actions.fixture={sid:'alpha-1',stage:'dispatched'};
      ledger.interactions.pending.fixture={sid:'alpha-2',state:'held'};mirrorLedger();
    });
    const heldGen=[first.interactionInputGeneration,second.interactionInputGeneration],heldWrites=effects.length;
    await direct('a-clock-4',()=>{originalNow=1;});
    await runHttp('t04',body=>{
      assert.deepEqual(body.results.successful,[]);assert.deepEqual(body.results.failed.map(x=>x.id),['alpha-1','alpha-2']);
      assert.equal(effects.length,heldWrites);
      assert.deepEqual([first.interactionInputGeneration,second.interactionInputGeneration],heldGen);
    });
    const refundBefore4=snapshot();
    await runHttp('a-no-refund-4',(body,wire)=>{assert.equal(body.code,'RATE_LIMITED');assert.match(wire.raw,/\r\nRetry-After: 1\r\n/i);assert.deepEqual(snapshot(),refundBefore4);});
    await direct('s36',()=>{ledger.interactions.actions={};ledger.interactions.pending={};mirrorLedger();first.ownerWs.readyState=3;});
    await direct('a-clock-5',()=>{originalNow=2;});
    await runHttp('t05',body=>{
      assert.deepEqual(body.results.successful.map(x=>x.id),['alpha-2']);
      assert.deepEqual(body.results.failed.map(x=>x.id),['alpha-1']);
    });
    const refundBefore5=snapshot();
    await runHttp('a-no-refund-5',(body,wire)=>{assert.equal(body.code,'RATE_LIMITED');assert.match(wire.raw,/\r\nRetry-After: 1\r\n/i);assert.deepEqual(snapshot(),refundBefore5);});
    await direct('s37',()=>{first.ownerWs={readyState:1,send:terminal(first,'owner',true)};});
    let beforeThrow=effects.length;
    await direct('a-clock-6',()=>{originalNow=3;});
    await runHttp('t06',()=>{assert.deepEqual(effects.slice(beforeThrow).map(x=>x.sid),['alpha-1']);});
    const refundBefore6=snapshot();
    await runHttp('a-no-refund-6',(body,wire)=>{assert.equal(body.code,'RATE_LIMITED');assert.match(wire.raw,/\r\nRetry-After: 1\r\n/i);assert.deepEqual(snapshot(),refundBefore6);});
    await direct('s38',()=>{first.ownerWs={readyState:1,send:terminal(first,'owner')};
      second.ptyProcess={pid:null,killed:true,write:terminal(second,'pty',true)};});
    beforeThrow=effects.length;
    await direct('a-clock-7',()=>{originalNow=4;});
    await runHttp('t07',()=>{assert.deepEqual(effects.slice(beforeThrow).map(x=>x.sid),['alpha-1','alpha-2']);});
    const refundBefore7=snapshot();
    await runHttp('a-no-refund-7',(body,wire)=>{assert.equal(body.code,'RATE_LIMITED');assert.match(wire.raw,/\r\nRetry-After: 1\r\n/i);assert.deepEqual(snapshot(),refundBefore7);});
const defaultA={},defaultB={},fraction={},invalid={},authCase={},emptyCase={};let clockValue=0,clockCalls=0,focusedBefore;
const selectedClock=()=>{clockCalls++;if(clockValue==='THROW')throw Error('private constructor clock failure');return clockValue;};
let fractionBucket,invalidBucket,authBucket,emptyBucket,defaultStart,defaultElapsed;

await direct('x-restore-terminal',()=>{ledger.interactions.actions={};ledger.interactions.pending={};mirrorLedger();first.type='wrapped';first.ownerWs={readyState:1,send:terminal(first,'owner')};second.type='spawned';second.ptyProcess={pid:null,killed:false,write:terminal(second,'pty')};});
await direct('default-a-context',()=>{defaultA.context=createSessionInspectionContext(inspectionShared,{});});
await direct('default-a-app',()=>{defaultA.app=httpApp.createHttpApp({express,cors});});
await direct('default-a-auth',()=>{httpApp.registerHealthAndAuth(defaultA.app,{pkg:local('package.json'),createAuthMiddleware:auth.createAuthMiddleware,EXPECTED_TOKEN:hostToken,verifyJwt,isAllowedPeer,isForbiddenOrigin});});
await direct('default-a-route',()=>{defaultA.context.registerSubmitAllRoute(defaultA.app);});
await direct('default-b-context',()=>{defaultB.context=createSessionInspectionContext(inspectionShared,{});});
await direct('default-b-app',()=>{defaultB.app=httpApp.createHttpApp({express,cors});});
await direct('default-b-auth',()=>{httpApp.registerHealthAndAuth(defaultB.app,{pkg:local('package.json'),createAuthMiddleware:auth.createAuthMiddleware,EXPECTED_TOKEN:hostToken,verifyJwt,isAllowedPeer,isForbiddenOrigin});});
await direct('default-b-route',()=>{defaultB.context.registerSubmitAllRoute(defaultB.app);});
defaultStart=process.hrtime.bigint();
await runHttp('x-default-first',(body,wire)=>{assert.deepEqual(body.results.successful.map(x=>x.id),['alpha-1','alpha-2']);assert.deepEqual(body.results.failed,[]);},defaultA.app);
focusedBefore=snapshot();
await runHttp('x-default-second',(body,wire)=>{
defaultElapsed=process.hrtime.bigint()-defaultStart;
if(defaultElapsed<1000000000n){assert.equal(wire.status,429);assert.equal(body.code,'RATE_LIMITED');assert.match(wire.raw,/\r\nRetry-After: 1\r\n/i);assert.deepEqual(snapshot(),focusedBefore);}
else {assert.ok([200,429].includes(wire.status));if(wire.status===429){assert.equal(body.code,'RATE_LIMITED');assert.match(wire.raw,/\r\nRetry-After: 1\r\n/i);assert.deepEqual(snapshot(),focusedBefore);}else{assert.deepEqual(body.results.successful.map(x=>x.id),['alpha-1','alpha-2']);assert.deepEqual(body.results.failed,[]);}}
return {elapsedNs:String(defaultElapsed),assessment:defaultElapsed<1000000000n?'SHARED_ALLOWANCE_MATCH':'INCONCLUSIVE'};
},defaultB.app);
await direct('x-fraction-bucket',()=>{fractionBucket=createSubmitAdmission({now:selectedClock});});
await direct('fraction-context',()=>{fraction.context=createSessionInspectionContext(inspectionShared,{admission:fractionBucket});});
await direct('fraction-app',()=>{fraction.app=httpApp.createHttpApp({express,cors});});
await direct('fraction-auth',()=>{httpApp.registerHealthAndAuth(fraction.app,{pkg:local('package.json'),createAuthMiddleware:auth.createAuthMiddleware,EXPECTED_TOKEN:hostToken,verifyJwt,isAllowedPeer,isForbiddenOrigin});});
await direct('fraction-route',()=>{fraction.context.registerSubmitAllRoute(fraction.app);});
await runHttp('x-fraction-first',(body,wire)=>{assert.deepEqual(body.results.successful.map(x=>x.id),['alpha-1','alpha-2']);assert.deepEqual(body.results.failed,[]);},fraction.app);
await direct('x-clock-quarter',()=>{clockValue=.25;});
focusedBefore=snapshot();
await runHttp('x-quarter-refusal',(body,wire)=>{assert.equal(body.code,'RATE_LIMITED');assert.match(wire.raw,/\r\nRetry-After: 1\r\n/i);assert.deepEqual(snapshot(),focusedBefore);},fraction.app);
await direct('x-clock-one',()=>{clockValue=1;});
await runHttp('x-exact-refill',(body,wire)=>{assert.deepEqual(body.results.successful.map(x=>x.id),['alpha-1','alpha-2']);assert.deepEqual(body.results.failed,[]);},fraction.app);
await direct('x-clock-long',()=>{clockValue=100;});
await runHttp('x-long-gap',(body,wire)=>{assert.deepEqual(body.results.successful.map(x=>x.id),['alpha-1','alpha-2']);assert.deepEqual(body.results.failed,[]);},fraction.app);
focusedBefore=snapshot();
await runHttp('x-credit-cap',(body,wire)=>{assert.equal(body.code,'RATE_LIMITED');assert.match(wire.raw,/\r\nRetry-After: 1\r\n/i);assert.deepEqual(snapshot(),focusedBefore);},fraction.app);
await direct('x-single-registry',()=>{delete sessions['alpha-2'];});
await direct('x-single-clock',()=>{clockValue=101;});
await runHttp('x-single-target',(body)=>{assert.deepEqual(body.results.successful.map(x=>x.id),['alpha-1']);assert.deepEqual(body.results.failed,[]);},fraction.app);
focusedBefore=snapshot();
await runHttp('x-single-charged',(body,wire)=>{assert.equal(body.code,'RATE_LIMITED');assert.match(wire.raw,/\r\nRetry-After: 1\r\n/i);assert.deepEqual(snapshot(),focusedBefore);},fraction.app);
await direct('x-two-registry',()=>{sessions['alpha-2']=second;});
await direct('x-direct-distinction',()=>{const beforeClock=clockCalls,beforeEffects=effects.length;const r=fraction.context.runSubmitAll(sessions);assert.deepEqual(r.successful.map(x=>x.id),['alpha-1','alpha-2']);assert.equal(effects.length-beforeEffects,2);assert.equal(clockCalls,beforeClock);directEvidence.push({id:'x-direct-distinction',meaning:'local runSubmitAll has no HTTP admission; not remote route or bypass'});});
await direct('x-invalid-initial',()=>{clockValue=NaN;});
await direct('x-invalid-bucket',()=>{invalidBucket=createSubmitAdmission({now:selectedClock});});
await direct('invalid-context',()=>{invalid.context=createSessionInspectionContext(inspectionShared,{admission:invalidBucket});});
await direct('invalid-app',()=>{invalid.app=httpApp.createHttpApp({express,cors});});
await direct('invalid-auth',()=>{httpApp.registerHealthAndAuth(invalid.app,{pkg:local('package.json'),createAuthMiddleware:auth.createAuthMiddleware,EXPECTED_TOKEN:hostToken,verifyJwt,isAllowedPeer,isForbiddenOrigin});});
await direct('invalid-route',()=>{invalid.context.registerSubmitAllRoute(invalid.app);});
focusedBefore=snapshot();
await runHttp('x-invalid-first',(body,wire)=>{assert.equal(body.code,'SUBMIT_ADMISSION_UNAVAILABLE');assert.deepEqual(snapshot(),focusedBefore);},invalid.app);
await direct('x-invalid-zero',()=>{clockValue=0;});
await runHttp('x-invalid-recover-token',(body,wire)=>{assert.deepEqual(body.results.successful.map(x=>x.id),['alpha-1','alpha-2']);assert.deepEqual(body.results.failed,[]);},invalid.app);
await direct('x-invalid-half',()=>{clockValue=.5;});
focusedBefore=snapshot();
await runHttp('x-invalid-half-refusal',(body,wire)=>{assert.equal(body.code,'RATE_LIMITED');assert.match(wire.raw,/\r\nRetry-After: 1\r\n/i);assert.deepEqual(snapshot(),focusedBefore);},invalid.app);
await direct('x-clock-infinity',()=>{clockValue=Infinity;});
focusedBefore=snapshot();
await runHttp('x-infinity',(body,wire)=>{assert.equal(body.code,'SUBMIT_ADMISSION_UNAVAILABLE');assert.deepEqual(snapshot(),focusedBefore);},invalid.app);
await direct('x-recover-infinity',()=>{clockValue=.75;});
focusedBefore=snapshot();
await runHttp('x-recovery-infinity',(body,wire)=>{assert.equal(body.code,'RATE_LIMITED');assert.match(wire.raw,/\r\nRetry-After: 1\r\n/i);assert.deepEqual(snapshot(),focusedBefore);},invalid.app);
await direct('x-clock-negative',()=>{clockValue=-1;});
focusedBefore=snapshot();
await runHttp('x-negative',(body,wire)=>{assert.equal(body.code,'SUBMIT_ADMISSION_UNAVAILABLE');assert.deepEqual(snapshot(),focusedBefore);},invalid.app);
await direct('x-recover-negative',()=>{clockValue=.75;});
focusedBefore=snapshot();
await runHttp('x-recovery-negative',(body,wire)=>{assert.equal(body.code,'RATE_LIMITED');assert.match(wire.raw,/\r\nRetry-After: 1\r\n/i);assert.deepEqual(snapshot(),focusedBefore);},invalid.app);
await direct('x-clock-unsafe',()=>{clockValue=Number.MAX_SAFE_INTEGER+1;});
focusedBefore=snapshot();
await runHttp('x-unsafe',(body,wire)=>{assert.equal(body.code,'SUBMIT_ADMISSION_UNAVAILABLE');assert.deepEqual(snapshot(),focusedBefore);},invalid.app);
await direct('x-recover-unsafe',()=>{clockValue=.75;});
focusedBefore=snapshot();
await runHttp('x-recovery-unsafe',(body,wire)=>{assert.equal(body.code,'RATE_LIMITED');assert.match(wire.raw,/\r\nRetry-After: 1\r\n/i);assert.deepEqual(snapshot(),focusedBefore);},invalid.app);
await direct('x-clock-regressing',()=>{clockValue=.25;});
focusedBefore=snapshot();
await runHttp('x-regressing',(body,wire)=>{assert.equal(body.code,'SUBMIT_ADMISSION_UNAVAILABLE');assert.deepEqual(snapshot(),focusedBefore);},invalid.app);
await direct('x-recover-regressing',()=>{clockValue=.75;});
focusedBefore=snapshot();
await runHttp('x-recovery-regressing',(body,wire)=>{assert.equal(body.code,'RATE_LIMITED');assert.match(wire.raw,/\r\nRetry-After: 1\r\n/i);assert.deepEqual(snapshot(),focusedBefore);},invalid.app);
await direct('x-clock-throwing',()=>{clockValue='THROW';});
focusedBefore=snapshot();
await runHttp('x-throwing',(body,wire)=>{assert.equal(body.code,'SUBMIT_ADMISSION_UNAVAILABLE');assert.deepEqual(snapshot(),focusedBefore);},invalid.app);
await direct('x-recover-throwing',()=>{clockValue=.75;});
focusedBefore=snapshot();
await runHttp('x-recovery-throwing',(body,wire)=>{assert.equal(body.code,'RATE_LIMITED');assert.match(wire.raw,/\r\nRetry-After: 1\r\n/i);assert.deepEqual(snapshot(),focusedBefore);},invalid.app);
await direct('x-invalid-final-one',()=>{clockValue=1;});
await runHttp('x-invalid-final-refill',(body,wire)=>{assert.deepEqual(body.results.successful.map(x=>x.id),['alpha-1','alpha-2']);assert.deepEqual(body.results.failed,[]);},invalid.app);
await direct('x-auth-clock',()=>{clockValue=0;});
await direct('x-auth-bucket',()=>{authBucket=createSubmitAdmission({now:selectedClock});});
await direct('authcase-context',()=>{authCase.context=createSessionInspectionContext(inspectionShared,{admission:authBucket});});
await direct('authcase-app',()=>{authCase.app=httpApp.createHttpApp({express,cors});});
await direct('authcase-auth',()=>{httpApp.registerHealthAndAuth(authCase.app,{pkg:local('package.json'),createAuthMiddleware:auth.createAuthMiddleware,EXPECTED_TOKEN:hostToken,verifyJwt,isAllowedPeer,isForbiddenOrigin});});
await direct('authcase-route',()=>{authCase.context.registerSubmitAllRoute(authCase.app);});
focusedBefore=snapshot();const authClockBefore=clockCalls;
await runHttp('x-auth-denied',(body,wire)=>{assert.equal(body.code,'PERMISSION_DENIED');assert.equal(clockCalls,authClockBefore);assert.deepEqual(snapshot(),focusedBefore);},authCase.app);
await runHttp('x-parser-error',(body,wire)=>{assert.equal(clockCalls,authClockBefore);assert.deepEqual(snapshot(),focusedBefore);},authCase.app);
await runHttp('x-auth-allowed',(body,wire)=>{assert.deepEqual(body.results.successful.map(x=>x.id),['alpha-1','alpha-2']);assert.deepEqual(body.results.failed,[]);},authCase.app);
focusedBefore=snapshot();
await runHttp('x-auth-charged',(body,wire)=>{assert.equal(body.code,'RATE_LIMITED');assert.match(wire.raw,/\r\nRetry-After: 1\r\n/i);assert.deepEqual(snapshot(),focusedBefore);},authCase.app);
await direct('x-empty-clock-bucket',()=>{emptyBucket=createSubmitAdmission({now(){clockCalls++;throw Error('empty must not consult clock');}});});
await direct('emptycase-context',()=>{emptyCase.context=createSessionInspectionContext(inspectionShared,{admission:emptyBucket});});
await direct('emptycase-app',()=>{emptyCase.app=httpApp.createHttpApp({express,cors});});
await direct('emptycase-auth',()=>{httpApp.registerHealthAndAuth(emptyCase.app,{pkg:local('package.json'),createAuthMiddleware:auth.createAuthMiddleware,EXPECTED_TOKEN:hostToken,verifyJwt,isAllowedPeer,isForbiddenOrigin});});
await direct('emptycase-route',()=>{emptyCase.context.registerSubmitAllRoute(emptyCase.app);});
await direct('x-empty-registry',()=>{for(const k of Object.keys(sessions))delete sessions[k];});
focusedBefore=snapshot();const emptyClockBefore=clockCalls;
await runHttp('x-empty',(body,wire)=>{assert.deepEqual(body,{success:true,results:{successful:[],failed:[]}});assert.equal(clockCalls,emptyClockBefore);assert.deepEqual(snapshot(),focusedBefore);},emptyCase.app);
await direct('x-restore-registry',()=>{sessions['alpha-1']=first;sessions['alpha-2']=second;});
await direct('x-unavailable-state',()=>{first.ownerWs.readyState=3;second.type='wrapped';second.ownerWs={readyState:3,send:terminal(second,'owner')};});
await direct('x-unavailable-clock',()=>{clockValue=102;});
const unavailableEffects=effects.length;
await runHttp('x-all-unavailable',(body,wire)=>{assert.deepEqual(body.results.successful,[]);assert.deepEqual(body.results.failed.map(x=>x.id),['alpha-1','alpha-2']);assert.equal(effects.length,unavailableEffects);},fraction.app);
focusedBefore=snapshot();
await runHttp('x-unavailable-charged',(body,wire)=>{assert.equal(body.code,'RATE_LIMITED');assert.match(wire.raw,/\r\nRetry-After: 1\r\n/i);assert.deepEqual(snapshot(),focusedBefore);},fraction.app);
    await direct('s39',()=>{for(const key of Object.keys(sessions))delete sessions[key];
      for(const [key,value] of saved)sessions[key]=value;});

    assert.equal(count,72);assert.equal(opCount,plan.operations.length-1);
    assert.ok(outcomes.filter(x=>x.id!=='f01').every(x=>x.status==='MATCH'||(x.id==='x-default-second'&&x.status==='INCONCLUSIVE')));
  }finally{
    await direct('f01',()=>{stateCleanupAttempted=true;state.destroyAll();assert.equal(handles.size,0);assert.equal(timeouts.size,0);});
    assert.equal(shared.interactionWaiters.size,0);assert.equal(state._machines.size,0);
    assert.equal(state._globalListeners.length,0);assert.equal(callbacks,0);
    assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype),globalBefore);
  }
  assert.equal(opCount,180);
 }
});
