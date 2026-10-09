// Bind completed actual-host evidence to the immutable revision; no host launch.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cpSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,relative} from 'node:path';
import {verifyCandidateAgainstManifest} from './profile/opencode/runtime/lib/activate.mjs';
import {PATCHES_3_0_1,PATCHES_3_0_3} from '../../worktrees/omo-3.0.3-upgrade/integrations/omo-slim/omo-patch.mjs';
const root=import.meta.dirname,proof=join(root,'proof'),pin=JSON.parse(readFileSync(join(proof,'CANDIDATE-r2.json')));
const json=p=>JSON.parse(readFileSync(p)),hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const save=(name,data)=>writeFileSync(join(proof,name),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
assert.equal(hash(join(pin.candidateDir,'.oprofile/profile-manifest.json')),pin.manifestSha256);
assert.deepEqual(verifyCandidateAgainstManifest(pin.candidateDir,json(join(pin.candidateDir,'.oprofile/profile-manifest.json'))),[]);
const metadataPath=join(pin.candidateDir,'.oprofile/verify-report.json'),metadata=json(metadataPath);
assert.equal(metadata.passed,true);
assert.ok(metadata.checks.some(c=>c.id==='sandbox-db'&&c.pass));
const evidence={metadata:{checks:metadata.checks.length,sha256:hash(metadataPath)}};
const inventory=(dir,base=dir)=>Object.fromEntries(readdirSync(dir).sort().flatMap(name=>{
 const path=join(dir,name),s=lstatSync(path);assert.ok(!s.isSymbolicLink(),path);
 return s.isDirectory()?Object.entries(inventory(path,base)):[[relative(base,path),hash(path)]];
}));
for(const name of ['ROLES','BCP']) {
 const report=json(join(proof,`HOST-${name}-r2.json`));assert.equal(report.passed,true);assert.equal(report.candidateManifest,pin.manifestSha256);
 const artifacts=join(report.case,'artifacts'),health=json(join(artifacts,'HEALTH.json'));
 assert.equal(health.realModelRequests,0);assert.equal(health.fdAudit.status,'verified');
 const target=join(proof,`host-${name.toLowerCase()}-r2`);assert.equal(existsSync(target),false);
 mkdirSync(target,{recursive:true,mode:0o700});cpSync(artifacts,target,{recursive:true,verbatimSymlinks:true});
 assert.deepEqual(inventory(target),inventory(artifacts));
 evidence[name.toLowerCase()]={checks:report.checks.length,reportSha256:hash(join(proof,`HOST-${name}-r2.json`)),artifacts:target,files:inventory(target),requests:health.requests,realModelRequests:0,limits:report.limits};
}
const live='/home/littlekey/.config/opencode',baseline=json(join(proof,'LIVE-MANAGED-BASELINE.json'));
assert.equal(hash(join(live,'.oprofile/active.json')),baseline.authoritySha256);
for(const [path,expected] of Object.entries(baseline.files)){assert.equal(hash(join(live,path)),expected.sha256,path);assert.equal((lstatSync(join(live,path)).mode&0o777).toString(8).padStart(4,'0'),expected.mode,path);}
const build=json(join(proof,'BUILD-r2.json'));
const audit=build.patches.map(item=>{
 const patch=PATCHES_3_0_3.find(p=>p.id===item.id)??PATCHES_3_0_1.find(p=>p.id===item.id);
 return {...item,entries:Object.fromEntries(['index','server'].map(entry=>{
   const anchor=typeof patch.anchor==='string'?patch.anchor:patch.anchor[entry];
   const path=join(root,'upstream/node_modules/oh-my-opencode-slim',entry==='index'?'dist/index.js':'dist/server/index.js');
   const text=readFileSync(path,'utf8');return [entry,{sourceSha256:hash(path),anchorLine:text.includes(anchor)?text.slice(0,text.indexOf(anchor)).split('\n').length:null,anchorOccurrences:text.split(anchor).length-1}];
 }))};
});
save('PATCH-AUDIT.json',{at:new Date().toISOString(),sourceFiles:build.sourceFiles,patches:audit,tests:'TESTS-r2.json',limits:['Absorbed alias guards are source-reviewed; no v2 host acceptance.']});
save('HOST.json',{at:new Date().toISOString(),candidateDir:pin.candidateDir,manifestSha256:pin.manifestSha256,entrySha256:pin.entrySha256,profileSha256:pin.profileSha256,hostVersion:pin.hostVersion,omoVersion:pin.omoVersion,passed:true,evidence,production:{unchanged:true,authoritySha256:baseline.authoritySha256,managedFiles:Object.keys(baseline.files).length},limits:['Only the local scripted provider was called. Real model workflows, compression recovery, external MCP service behavior and v2 hosts are not certified.','A production-private candidate, transactional rehearsal and activation are still approval-gated.']});
console.log(JSON.stringify({passed:true,manifestSha256:pin.manifestSha256,checks:Object.fromEntries(Object.entries(evidence).map(([key,value])=>[key,value.checks])),productionUnchanged:true},null,2));
