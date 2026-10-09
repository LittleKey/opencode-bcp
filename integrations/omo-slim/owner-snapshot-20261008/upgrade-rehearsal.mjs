import assert from 'node:assert/strict';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,renameSync,rmSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

export function runRehearsal(api){
 const {controller,snapshot,walkConfig,copyTree,hash,json,mode,save,same,LIVE,ROOT,spec,baseline,candidateGate,sourceDigests}=api;
 candidateGate();same(snapshot(LIVE),baseline,'production baseline drift');
 const work=mkdtempSync('/tmp/opencode/omo303-upgrade-'),cfg=join(work,'config'),txn=join(work,'transaction');mkdirSync(cfg);mkdirSync(txn);
 for(const scope of spec.scopes)copyTree(join(LIVE,scope),join(cfg,scope),work,{from:LIVE,to:cfg});
 const authority=join(cfg,'.oprofile/active.json'),authorityMode=mode(authority),old=json(authority);old.backupsRoot=join(cfg,old.backupsRoot.slice(LIVE.length+1));for(const f of old.files)if(f.backup)f.backup=join(cfg,f.backup.slice(LIVE.length+1));save(authority,old);chmodSync(authority,authorityMode);
 const initial=snapshot(cfg),c=controller(cfg,txn,initial),checks={};
 const check=(name,fn)=>{console.log('checking '+name);fn();checks[name]=true;};
 const noWrites=fn=>{const before={config:walkConfig(cfg),transaction:walkConfig(txn,['.'])};assert.throws(fn);same({config:walkConfig(cfg),transaction:walkConfig(txn,['.'])},before,'rejected operation wrote files');};
 const mutate=(p,change,fn)=>{const bytes=readFileSync(p),bits=mode(p);try{change(p);noWrites(fn);}finally{writeFileSync(p,bytes);chmodSync(p,bits);}};
 const resetAudit=()=>{if(existsSync(join(txn,'runtime-audit')))rmSync(join(txn,'runtime-audit'),{recursive:true});};
 try{
  check('candidate-baseline',c.preflight);
  check('candidate-manifest-drift-zero-writes',()=>{const bad=join(work,'bad-candidate');mkdirSync(join(bad,'.oprofile'),{recursive:true});writeFileSync(join(bad,'.oprofile/profile-manifest.json'),readFileSync(join(spec.candidate,'.oprofile/profile-manifest.json'),'utf8')+' ');noWrites(controller(cfg,txn,initial,bad).apply);});
  check('current-file-drift-zero-writes',()=>mutate(join(cfg,'AGENTS.md'),p=>writeFileSync(p,readFileSync(p,'utf8')+'\ndrift'),c.apply));
  check('ancestor-link-zero-writes',()=>{renameSync(join(cfg,'plugins'),join(work,'held'));symlinkSync(join(work,'held'),join(cfg,'plugins'));try{noWrites(c.apply);}finally{unlinkSync(join(cfg,'plugins'));renameSync(join(work,'held'),join(cfg,'plugins'));}c.preflight();});
  check('preparation-failure-full-restore',()=>{assert.throws(()=>c.apply({failAfterPreparation:true}),/injected/);same(snapshot(cfg),initial);});
  for(const failure of ['missing','truncated'])check(`installed-snapshot-${failure}-full-restore`,()=>{assert.throws(()=>c.apply({failInstalledSnapshot:failure}),/injected/);same(snapshot(cfg),initial);resetAudit();});
  check('install-exact-private-candidate',()=>{c.apply();c.installed();});
  check('reinstall-idempotent',()=>{const before=walkConfig(cfg);c.apply();same(walkConfig(cfg),before);});
  check('post-install-file-drift-zero-writes',()=>mutate(join(cfg,'AGENTS.md'),p=>writeFileSync(p,readFileSync(p,'utf8')+'\ndrift'),c.recover));
  check('backup-drift-zero-writes',()=>{const p=json(authority).files.find(f=>f.backup).backup;mutate(p,q=>writeFileSync(q,readFileSync(q,'utf8')+'\ndrift'),c.recover);});
  check('quarantine-drift-zero-writes',()=>{const p=join(txn,'quarantine',spec.retired[0]);mutate(p,q=>writeFileSync(q,Buffer.concat([readFileSync(q),Buffer.from('drift')])),c.recover);});
  check('authority-operations-drift-zero-writes',()=>{
   const mutations=[r=>r.files.pop(),r=>r.files.push(r.files[0]),r=>r.files[0].path='../escape',r=>r.files[0].action='create',r=>r.files[0].sha256Before='0'.repeat(64),r=>r.files[0].sha256After='0'.repeat(64),r=>r.files[0].modeBefore='0777',r=>r.files[0].mode='0777',r=>r.files[0].backup=join(cfg,'AGENTS.md'),r=>r.backupsRoot=cfg,r=>r.stage.manifestSha256='0'.repeat(64)];
   for(const withoutHash of [false,true])for(const change of mutations){const remembered=c.state().authoritySha256;if(withoutHash)c.state().authoritySha256=null;try{mutate(authority,p=>{const r=json(p);change(r);save(p,r);},c.recover);}finally{c.state().authoritySha256=remembered;}}
  });
  check('rollback-restores-bytes-modes-topology-authority',()=>{c.recover();same(snapshot(cfg),initial);resetAudit();});
  check('second-install-full-rollback',()=>{c.apply();c.installed();c.recover();same(snapshot(cfg),initial);resetAudit();});
  check('production-unchanged',()=>same(snapshot(LIVE),baseline));
  const result={at:new Date().toISOString(),passed:true,checks,candidate:spec.candidate,manifestSha256:spec.manifestSha256,specSha256:hash(join(ROOT,'production/CANDIDATE.json')),sourceDigests:sourceDigests(),retired:spec.retired,limits:['Serial isolated replica; no production mutation.','Caught failures covered; this is not a power-loss-atomic multi-file transaction.']};
   assert.equal(existsSync(join(ROOT,'production/REHEARSAL-r2.json')),false);save(join(ROOT,'production/REHEARSAL-r2.json'),result);rmSync(work,{recursive:true});console.log(JSON.stringify({passed:true,checks:Object.keys(checks).length,manifestSha256:spec.manifestSha256},null,2));
 }catch(error){console.error(JSON.stringify({failedReplica:work,error:error.message}));throw error;}
}
if(process.argv[1]===import.meta.filename)runRehearsal(await import('./upgrade.mjs'));
