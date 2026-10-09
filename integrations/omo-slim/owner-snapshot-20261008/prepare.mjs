// Immutable v1 staging only. No activation and no host serve process.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cpSync,readFileSync,writeFileSync,mkdirSync,existsSync,lstatSync,readdirSync,readlinkSync} from 'node:fs';
import {join,dirname,relative} from 'node:path';
import {execFileSync} from 'node:child_process';
import {loadProfile,verifyAllInputs} from '/home/littlekey/github/dotfiles/.slim/worktrees/phase1-upstream-defaults/opencode/runtime/lib/inputs.mjs';
import {verifyCandidateAgainstManifest} from '/home/littlekey/github/dotfiles/.slim/worktrees/phase1-upstream-defaults/opencode/runtime/lib/activate.mjs';
import {personalCore} from '/home/littlekey/github/dotfiles/.slim/worktrees/phase1-upstream-defaults/opencode/runtime/lib/render.mjs';
const root=import.meta.dirname,proof=join(root,'proof'),live='/home/littlekey/.config/opencode';
const revision=process.env.OMO_REVISION??'';assert.match(revision,/^(?:-r\d+)?$/);
const source='/home/littlekey/github/dotfiles/.slim/worktrees/phase1-upstream-defaults/opencode',target=join(root,'profile/opencode');
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex'),json=p=>JSON.parse(readFileSync(p));
const save=(name,data)=>writeFileSync(join(proof,name),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
const baseline=json(join(proof,'LIVE-MANAGED-BASELINE.json'));
assert.equal(hash(join(live,'.oprofile/active.json')),baseline.authoritySha256,'authority drift');
for(const [rel,expected] of Object.entries(baseline.files)) {
  const path=join(live,rel),s=lstatSync(path);assert.ok(s.isFile()&&!s.isSymbolicLink(),rel);
  assert.equal(hash(path),expected.sha256,rel);assert.equal((s.mode&0o777).toString(8).padStart(4,'0'),expected.mode,rel);
}
const inventory=(dir,base=dir)=>Object.fromEntries(readdirSync(dir).sort().flatMap(name=>{
  const path=join(dir,name),s=lstatSync(path),rel=relative(base,path),mode=(s.mode&0o777).toString(8).padStart(4,'0');
  if(s.isSymbolicLink())return [[rel,{type:'link',mode,target:readlinkSync(path)}]];
  if(s.isDirectory())return [[rel,{type:'dir',mode}],...Object.entries(inventory(path,base))];
  assert.ok(s.isFile(),path);return [[rel,{type:'file',mode,sha256:hash(path)}]];
}));
const roots=['plugins/omoPluginV1','oh-my-opencode-slim','skills'];
const topology={};
for(const rel of roots) {
  const path=join(live,rel),s=lstatSync(path);assert.ok(s.isDirectory()&&!s.isSymbolicLink(),`${rel}: actual directory required`);
  for(let p=dirname(path);p.startsWith(live);p=dirname(p))assert.ok(!lstatSync(p).isSymbolicLink(),`${p}: ancestor link`);
  topology[rel]={mode:(s.mode&0o777).toString(8).padStart(4,'0'),files:inventory(path)};
}
if(existsSync(join(proof,'TOPOLOGY-BASELINE.json')))assert.deepEqual(json(join(proof,'TOPOLOGY-BASELINE.json')).roots,topology,'topology drift since interrupted preparation');
else save('TOPOLOGY-BASELINE.json',{at:new Date().toISOString(),authoritySha256:baseline.authoritySha256,roots:topology});
const {profile}=loadProfile(join(source,'runtime/profile.json'));verifyAllInputs(profile);
const alreadyFrozen=existsSync(target);
if(!alreadyFrozen){mkdirSync(target,{recursive:true,mode:0o700});for(const rel of ['AGENTS.md','opencode.json','oh-my-opencode-slim.json','oh-my-opencode-slim','runtime'])cpSync(join(source,rel),join(target,rel),{recursive:true,verbatimSymlinks:true});}
for(const input of Object.values(profile.inputs))if(input.source.startsWith(source+'/'))input.source=join(target,relative(source,input.source));
const profilePath=join(target,'runtime/profile.json');
if(alreadyFrozen){assert.deepEqual(json(profilePath),profile,'frozen profile drift');const frozen=inventory(join(target,'runtime'));for(const [rel,entry] of Object.entries(inventory(join(source,'runtime'))))if(rel!=='profile.json')assert.deepEqual(frozen[rel],entry,rel);}
else writeFileSync(profilePath,JSON.stringify(profile,null,2)+'\n',{mode:0o600});
verifyAllInputs(profile);
const authority=json(join(live,'.oprofile/active.json')),old=json(join(authority.stage.candidateDir,'.oprofile/profile-manifest.json'));
assert.equal(old.host.version,'1.18.33');
const artifact=join(root,`artifact${revision}/omoPlugin`),build=json(join(proof,`BUILD${revision}.json`));
for(const entry of Object.values(build.entries))for(const [rel,sha] of Object.entries(entry.files))assert.equal(hash(join(artifact,rel)),sha,rel);
const flags={omoPlugin:'--omo-plugin',omoPluginV1:'--omo-v1-plugin',bcpPlugin:'--bcp-plugin',compressionPlugin:'--compression-plugin',vibeguardV1:'--vibeguard-v1',vibeguardV2:'--vibeguard-plugin'};
mkdirSync(join(root,'candidates'),{recursive:true,mode:0o700});
const args=[join(target,'runtime/bin/oprofile.mjs'),'stage','--flavor','v1','--opencode',old.host.executable,'--out',join(root,'candidates'),'--profile',profilePath];
for(const [name,c] of Object.entries(old.components))if(c.staged){assert.ok(flags[name],name);args.push(flags[name],name.startsWith('omoPlugin')?artifact:c.source);}
const stageLog=join(proof,`stage-v1${revision}.log`);
const log=existsSync(stageLog)?readFileSync(stageLog,'utf8'):execFileSync(process.execPath,args,{encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
if(!existsSync(stageLog))writeFileSync(stageLog,log,{flag:'wx',mode:0o600});
const candidateDir=/^staged (.+)$/m.exec(log)?.[1];assert.ok(candidateDir);
const manifestPath=join(candidateDir,'.oprofile/profile-manifest.json'),manifest=json(manifestPath);
assert.deepEqual(verifyCandidateAgainstManifest(candidateDir,manifest),[]);
const rendered=json(join(candidateDir,'opencode.json')),current=json(join(live,'opencode.json'));
assert.deepEqual(personalCore(rendered),personalCore(current),'preserved settings');
assert.deepEqual(rendered.agent,current.agent,'existing native role permissions');
const fileSha=f=>f.sha256??f.sourceSha256;
for(const f of manifest.files)assert.equal(hash(join(candidateDir,f.path)),fileSha(f),f.path);
const changed=manifest.files.filter(f=>baseline.files[f.path]?.sha256!==fileSha(f)||baseline.files[f.path]?.mode!==f.mode).map(f=>f.path);
const removed=Object.keys(baseline.files).filter(p=>!manifest.files.some(f=>f.path===p));
const allowed=p=>p.startsWith('plugins/omoPluginV1/')||p==='skills/deepwork/SKILL.md'||p==='opencode.json'||p==='plugins/blackboard.js';
if(!changed.every(allowed)) {
  const unexpected=manifest.files.filter(f=>changed.includes(f.path)&&!allowed(f.path)).map(f=>({path:f.path,before:baseline.files[f.path],after:{sha256:fileSha(f),mode:f.mode}}));
  save('CANDIDATE-DIFF-REJECTED.json',{candidateDir,manifestSha256:hash(manifestPath),unexpected});
  console.log(JSON.stringify({unexpectedChanges:unexpected.length,examples:unexpected.slice(0,3)},null,2));
  throw new Error('unapproved candidate changes; see CANDIDATE-DIFF-REJECTED.json');
}
assert.ok(removed.every(allowed),`unapproved removals: ${removed.filter(p=>!allowed(p))}`);
assert.equal(manifest.components.omoPluginV1.entrySha256,build.entries.index.bundleSha256);
const record={at:new Date().toISOString(),candidateDir,manifestSha256:hash(manifestPath),profilePath,profileSha256:hash(profilePath),baselineSha256:hash(join(proof,'LIVE-MANAGED-BASELINE.json')),topologySha256:hash(join(proof,'TOPOLOGY-BASELINE.json')),hostVersion:old.host.version,hostExecutable:old.host.executable,omoVersion:'3.0.3',entrySha256:build.entries.index.bundleSha256,files:manifest.files.length,changed,removed,components:Object.fromEntries(Object.entries(manifest.components).map(([n,c])=>[n,{status:c.status,source:c.source,entrySha256:c.entrySha256}])),frozenFiles:inventory(target),limits:['Probe candidate scrubs credential keys. Production-private staging and transactional cutover require later approval.','Rendered plugin paths are staged relative paths; activation normalization remains separate.','Metadata and actual host behavior not yet verified.']};
save(`CANDIDATE${revision}.json`,record);
console.log(JSON.stringify({candidateDir,manifestSha256:record.manifestSha256,profileSha256:record.profileSha256,files:record.files,changed:changed.length,removed:removed.length,components:record.components},null,2));
