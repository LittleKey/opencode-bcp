// Discard reproducible npm caches in this task's two exited, isolated probe HOMEs.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,readdirSync,readlinkSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {join,relative} from 'node:path';
const root=import.meta.dirname;
const targets=['home-run-2026-10-08T15-09-23-789Z-298465','home-run-2026-10-08T15-44-28-276Z-303762'].map(n=>join(root,'candidates/state',n,'.npm'));
const records=[];
for(const target of targets){const files={};let bytes=0;function walk(dir){for(const name of readdirSync(dir).sort()){const p=join(dir,name),s=lstatSync(p);assert.ok(!s.isSymbolicLink(),p);assert.equal(s.uid,process.getuid());if(s.isDirectory())walk(p);else{assert.ok(s.isFile());bytes+=s.size;files[relative(target,p)]={sha256:createHash('sha256').update(readFileSync(p)).digest('hex'),bytes:s.size,mode:s.mode&0o777};}}}walk(target);records.push({target,bytes,files});}
for(const pid of readdirSync('/proc').filter(p=>/^\d+$/.test(p))){let names;try{if(statSync('/proc/'+pid).uid!==process.getuid())continue;names=readdirSync('/proc/'+pid+'/fd');}catch{continue;}for(const fd of names){let target;try{target=readlinkSync('/proc/'+pid+'/fd/'+fd);}catch{continue;}assert.ok(!targets.some(p=>target.startsWith(p+'/')),`cache still open by ${pid}`);}}
const proof=join(root,'proof/METADATA-NPM-CLEANUP.json');const record={at:new Date().toISOString(),purpose:'Reproducible npm download caches only; isolated probe DBs, configs, logs, candidates and captured evidence retained.',records,removed:false};writeFileSync(proof,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
for(const target of targets)rmSync(target,{recursive:true});record.removed=true;writeFileSync(proof,JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify({removed:targets,bytes:records.reduce((n,r)=>n+r.bytes,0)},null,2));
