import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const ROOT=import.meta.dirname,revision=process.env.OMO_TX_REVISION??'red';
const pin=JSON.parse(readFileSync(join(ROOT,'production/CANDIDATE.json')));
const atomicURL=pathToFileURL(join(pin.runtime,'lib/atomic.mjs')).href,atomic=await import(atomicURL);
let failPath=null,injected=false;
mock.module(atomicURL,{namedExports:{...atomic,atomicWriteFileSync(path,...args){if(path===failPath){failPath=null;injected=true;throw new Error('injected native write after backup');}return atomic.atomicWriteFileSync(path,...args);}}});
const api=await import('./upgrade.mjs');
const {controller,snapshot,walkConfig,copyTree,json,mode,save,same,LIVE,spec,baseline,sourceDigests}=api;
const results=[];
for(const name of ['native-write-after-backup-full-restore','audit-link-zero-writes','legacy-twin-zero-writes']) {
 const work=mkdtempSync('/tmp/opencode/omo303-regression-'),cfg=join(work,'config'),txn=join(work,'transaction');mkdirSync(cfg);mkdirSync(txn);
 try {
  for(const scope of spec.scopes)if(existsSync(join(LIVE,scope)))copyTree(join(LIVE,scope),join(cfg,scope),work,{from:LIVE,to:cfg});
  const authority=join(cfg,'.oprofile/active.json'),bits=mode(authority),old=json(authority);old.backupsRoot=join(cfg,old.backupsRoot.slice(LIVE.length+1));for(const f of old.files)if(f.backup)f.backup=join(cfg,f.backup.slice(LIVE.length+1));save(authority,old);chmodSync(authority,bits);
  const initial=snapshot(cfg),c=controller(cfg,txn,initial);
  const full=()=>({config:walkConfig(cfg,[...new Set([...spec.scopes,'plugin'])]),transaction:walkConfig(txn,['.'])});
  if(name==='native-write-after-backup-full-restore') {
   failPath=join(cfg,'AGENTS.md');injected=false;assert.throws(()=>c.apply(),/injected native write/);assert.equal(injected,true);same(snapshot(cfg),initial,'caught native activation failure did not fully restore');assert.equal(c.state().status,'rolled-back');
  } else if(name==='audit-link-zero-writes') {
   c.apply();const outside=join(work,'outside');mkdirSync(outside);symlinkSync(outside,join(txn,'runtime-audit'));const before=full();assert.throws(c.recover);same(full(),before,'audit topology rejection wrote files');
  } else {
   const twin=join(cfg,'plugin/omoPluginV1/index/dist/index.js');mkdirSync(join(twin,'..'),{recursive:true});writeFileSync(twin,'unmanaged legacy twin\n');const before=full();assert.throws(c.apply);same(full(),before,'legacy conflict rejection wrote files');
  }
  results.push({name,passed:true});
 }catch(error){results.push({name,passed:false,error:error.message});}
 finally{failPath=null;rmSync(work,{recursive:true,force:true});}
}
same(snapshot(LIVE),baseline,'production changed');
const result={at:new Date().toISOString(),passed:results.every(r=>r.passed),sourceDigests:sourceDigests(),manifestSha256:spec.manifestSha256,results,limits:['Real native atomic-write boundary is injected once; no runtime source mutation or production writes.']};
writeFileSync(join(ROOT,`production/TRANSACTION-REGRESSIONS-${revision}.json`),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(result,null,2));process.exitCode=result.passed?0:1;
