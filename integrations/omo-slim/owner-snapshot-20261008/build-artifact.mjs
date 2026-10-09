import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {join, relative} from 'node:path';
import {buildOmoIntegration} from '../../worktrees/omo-3.0.3-upgrade/integrations/omo-slim/build-omo.mjs';
import {PATCHES_3_0_1, PATCHES_3_0_3} from '../../worktrees/omo-3.0.3-upgrade/integrations/omo-slim/omo-patch.mjs';
const revision=process.env.OMO_REVISION??'';
assert.match(revision,/^(?:-r\d+)?$/);
const root=import.meta.dirname, out=join(root,`artifact${revision}/omoPlugin`);
const sourceDir=join(root,'../../worktrees/omo-3.0.3-upgrade/integrations/omo-slim');
assert.equal(existsSync(out),false,'immutable artifact already exists');
mkdirSync(out,{recursive:true});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const entries={};
for(const entry of ['index','server']) {
  const result=await buildOmoIntegration({packageDir:join(root,'upstream/node_modules/oh-my-opencode-slim'),sourceDir,outputDir:join(out,entry),version:'3.0.3',entry});
  for(const file of result.files)assert.equal(hash(readFileSync(file.path)),file.digest,file.path);
  entries[entry]={bundleSha256:result.manifest.bundle.digest,manifestSha256:hash(readFileSync(join(out,entry,'manifest.json'))),packages:result.manifest.closure.packages.length,files:Object.fromEntries(result.files.map(f=>[relative(out,f.path),f.digest]))};
}
const patches=PATCHES_3_0_1.map(old=>{
  const next=PATCHES_3_0_3.find(p=>p.id===old.id);
  return {id:old.id,disposition:!next?'retired-upstream-absorbed':JSON.stringify(old)===JSON.stringify(next)?'retained-unchanged':'adapted-to-3.0.3',purpose:next?.purpose??old.purpose};
});
for(const p of PATCHES_3_0_3.filter(p=>!PATCHES_3_0_1.some(old=>old.id===p.id)))patches.push({id:p.id,disposition:'new-3.0.3-path',purpose:p.purpose});
const record={at:new Date().toISOString(),version:'3.0.3',sourceDir,sourceFiles:Object.fromEntries(['build-omo.mjs','omo-patch.mjs','omo-closure.mjs','omo-delivery.mjs'].map(p=>[p,hash(readFileSync(join(sourceDir,p)))])),entries,patches,limits:['Build/import tests cover both entries; no v2 host acceptance in this upgrade.','Node 25.6.1 is outside jsdom 30.1.2 declared engines; relocated Node and Bun smoke passed but do not certify an unsupported runtime.']};
writeFileSync(join(out,'ARTIFACT.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx'});
writeFileSync(join(root,`proof/BUILD${revision}.json`),JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({artifact:out,entries:Object.fromEntries(Object.entries(entries).map(([k,v])=>[k,{bundleSha256:v.bundleSha256,packages:v.packages,files:Object.keys(v.files).length}])),patches:patches.reduce((acc,p)=>(acc[p.disposition]=(acc[p.disposition]??0)+1,acc),{})},null,2));
