'use strict';
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const expectedOperations = ["import-lifecycle","fixture-root","setup-01","setup-02","setup-03","setup-04","setup-05","setup-06","setup-07","setup-08","setup-09","valid-0","setup-10","setup-11","setup-12","valid-1","setup-13","setup-14","setup-15","valid-2","setup-16","setup-17","setup-18","valid-3","setup-19","setup-20","setup-21","valid-4","repeat-absent","setup-22","one-leaf","invalid-undefined","invalid-null","invalid-number","invalid-boolean","invalid-array","invalid-object","invalid-boxed","invalid-empty","invalid-dot","invalid-dotdot","invalid-slash","invalid-backslash","invalid-nul","invalid-c0","invalid-del","invalid-c1","invalid-colon","invalid-drive","invalid-unc","invalid-absolute","missing-root","setup-23","file-root","setup-24","setup-25","trusted-root-link","missing-child","setup-26","file-child","setup-27","setup-28","setup-29","child-inside","setup-30","child-outside","setup-31","child-dangling","setup-32","setup-33","setup-34","setup-35","leaf-inside","setup-36","setup-37","setup-38","leaf-outside","setup-39","setup-40","setup-41","leaf-dangling","setup-42","setup-43","setup-44","leaf-directory","setup-45","setup-46","setup-47","leaf-hard"];
const expectedCases = ["valid-0","valid-1","valid-2","valid-3","valid-4","repeat-absent","one-leaf","invalid-undefined","invalid-null","invalid-number","invalid-boolean","invalid-array","invalid-object","invalid-boxed","invalid-empty","invalid-dot","invalid-dotdot","invalid-slash","invalid-backslash","invalid-nul","invalid-c0","invalid-del","invalid-c1","invalid-colon","invalid-drive","invalid-unc","invalid-absolute","missing-root","file-root","trusted-root-link","missing-child","file-child","child-inside","child-outside","child-dangling","leaf-inside","leaf-outside","leaf-dangling","leaf-directory","leaf-hard"];
const fs=require('node:fs'), path=require('node:path'), os=require('node:os'), crypto=require('node:crypto');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
// Regular .sock files are controls, not native sockets; permissions/races remain untested.
nodeTest('lifecycle-cleanup-681', { concurrency: false }, async t => {
  let opCount = 0;
  function step(id, fn) {
    assert.equal(expectedOperations[opCount], id);
    assert.ok(++opCount <= expectedOperations.length);
    return fn();
  }
  const lifecycle=step('import-lifecycle',()=>require('../src/lifecycle'));
  const fixtureRoot=fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-cleanup-681-'));
  try {
    step('fixture-root',()=>assert.ok(fs.statSync(fixtureRoot).isDirectory()));
  const helperOutcomes = [];
  let helperCalls = 0, helperSetupSteps = 0, helperEntries = 0;
  async function supplementalCleanup() {
    const base = path.join(fixtureRoot, 'cleanup-controls');
    const roots = path.join(base, 'sessions'), outside = path.join(base, 'outside');
    const leaves = ['supervisor.sock','session.sock'];
    function entry(kind, p, value) {
      assert.ok(p.startsWith(base + path.sep) || p === base);
      assert.ok(++helperSetupSteps <= 56); assert.ok(++helperEntries <= 64);
      step('setup-'+String(helperSetupSteps).padStart(2,'0'),()=>{
      if(kind === 'dir') fs.mkdirSync(p,{mode:0o700});
      if(kind === 'file') fs.writeFileSync(p,value||'private cleanup sentinel',{flag:'wx',mode:0o600});
      if(kind === 'link') { assert.ok(value.startsWith(base + path.sep)); fs.symlinkSync(value,p); }
      if(kind === 'hard') { assert.ok(value.startsWith(base + path.sep)); fs.linkSync(value,p); }
      });
    }
    function inventory() {
      const rows=[]; let bytes=0;
      function visit(dir) {
        for(const name of fs.readdirSync(dir).sort()) {
          const full=path.join(dir,name), st=fs.lstatSync(full);
          const row={path:path.relative(base,full),mode:st.mode&0o777,ino:st.ino,nlink:st.nlink};
          if(st.isSymbolicLink()) {row.type='link';row.target=fs.readlinkSync(full);}
          else if(st.isDirectory()) {row.type='directory';}
          else if(st.isFile()) {
            row.type='file';row.size=st.size;row.mtimeMs=st.mtimeMs;
            assert.ok(st.size<=1048576);const b=fs.readFileSync(full);
            bytes+=b.length;assert.ok(bytes<=2097152);row.sha256=sha(b);row.base64=b.toString('base64');
          } else { assert.ok(st.isSocket());row.type='socket'; } // never read socket contents
          rows.push(row); assert.ok(rows.length<=64);
          if(st.isDirectory())visit(full);
        }
      }
      visit(base);return rows;
    }
    let coercions=0;
    async function check(label,id,selectedRoot,removed=[]) {
      assert.equal(expectedCases[helperCalls], label);
      await t.test('cleanup / ' + label, { concurrency: false }, () => {
        const before=inventory(); let actual;
        assert.ok(++helperCalls<=48);
        step(label,()=>{
        actual=lifecycle.cleanupSessionArtifacts(id,{sessionsRoot:selectedRoot});
        assert.deepEqual(actual,removed,'canonical removal list/order: '+label);
        const expected=before.filter(row=>!removed.includes(path.join(base,row.path)));
        const portable=rows=>rows.map(row=>{
          if(row.type==='directory' && removed.some(p=>path.dirname(p)===path.join(base,row.path))){const {nlink,...stable}=row;return stable;}
          return row;
        });
        assert.deepEqual(portable(inventory()),portable(expected),'only specified regular leaves removed: '+label);
        assert.equal(coercions,0,'invalid ID must not coerce');
        assert.ok(2+helperSetupSteps+helperCalls<=96);
        });
        helperOutcomes.push(label);
      });
    }
    entry('dir',base);entry('dir',roots);entry('dir',outside);
    entry('file',path.join(outside,'sentinel'));
    for(const [index,id] of ['ordinary','__proto__','constructor','prototype','한글'].entries()) {
      const dir=path.join(roots,id);entry('dir',dir);
      for(const leaf of leaves)entry('file',path.join(dir,leaf));
      if(index===0) {entry('file',path.join(dir,'unrelated'));entry('dir',path.join(dir,'unrelated-dir'));}
      await check('valid-'+index,id,roots,leaves.map(x=>path.join(dir,x)));
    }
    await check('repeat-absent','ordinary',roots);
    entry('file',path.join(roots,'ordinary','session.sock'));
    await check('one-leaf','ordinary',roots,[path.join(roots,'ordinary','session.sock')]);
    const invalid=[
      ['undefined',undefined],['null',null],['number',7],['boolean',false],['array',[]],
      ['object',{toString(){coercions++;throw Error('coercion forbidden');}}],
      ['boxed',new String('ordinary')],['empty',''],['dot','.'],['dotdot','..'],
      ['slash','../outside'],['backslash','a\\b'],['nul','a\0b'],['c0','a\nb'],
      ['del','a\x7fb'],['c1','a\x85b'],['colon','a:b'],['drive','C:\\owned'],
      ['unc','\\\\owned\\share'],['absolute',outside]
    ];
    for(const [label,id] of invalid)await check('invalid-'+label,id,roots);
    await check('missing-root','ordinary',path.join(base,'missing-root'));
    entry('file',path.join(base,'root-file'));await check('file-root','ordinary',path.join(base,'root-file'));
    entry('link',path.join(base,'root-link'),roots);
    entry('file',path.join(roots,'ordinary','supervisor.sock'));
    await check('trusted-root-link','ordinary',path.join(base,'root-link'),[path.join(roots,'ordinary','supervisor.sock')]);
    await check('missing-child','missing-child',roots);
    entry('file',path.join(roots,'file-child'));await check('file-child','file-child',roots);
    entry('dir',path.join(roots,'inside-target'));entry('file',path.join(roots,'inside-target','sentinel'));
    for(const [label,target] of [['inside',path.join(roots,'inside-target')],['outside',outside],['dangling',path.join(base,'missing-target')]]) {
      const id='child-'+label;entry('link',path.join(roots,id),target);await check(id,id,roots);
    }
    entry('file',path.join(outside,'hard-target'));
    for(const kind of ['inside','outside','dangling','directory','hard']) {
      const id='leaf-'+kind,dir=path.join(roots,id);entry('dir',dir);
      const bad=path.join(dir,'supervisor.sock'),safe=path.join(dir,'session.sock');
      if(kind==='directory')entry('dir',bad);
      else if(kind==='hard')entry('hard',bad,path.join(outside,'hard-target'));
      else entry('link',bad,kind==='inside'?path.join(roots,'inside-target','sentinel'):
        kind==='outside'?path.join(outside,'sentinel'):path.join(base,'missing-leaf'));
      entry('file',safe);await check(id,id,roots,[safe]);
    }
    assert.equal(helperCalls,40);assert.equal(helperSetupSteps,47);
    assert.equal(helperOutcomes.length,40);
  }

    await supplementalCleanup();
    assert.equal(opCount,89);
    assert.deepEqual(helperOutcomes, expectedCases);
  } finally {
    // Only the owned mkdtemp result is removed; this is fixture teardown, not product cleanup.
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
