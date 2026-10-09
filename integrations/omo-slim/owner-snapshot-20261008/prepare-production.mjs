// Private candidate preparation; no production activation or service operations.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {cpSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,readlinkSync,statfsSync,writeFileSync} from 'node:fs';
import {dirname,join,relative} from 'node:path';
import {isDeepStrictEqual as equal} from 'node:util';
import {verifyAllInputs} from './profile/opencode/runtime/lib/inputs.mjs';
import {verifyCandidateAgainstManifest} from './profile/opencode/runtime/lib/activate.mjs';
const root=import.meta.dirname,proof=join(root,'proof'),production=join(root,'production'),live='/home/littlekey/.config/opencode';
const source='/home/littlekey/github/dotfiles/.slim/worktrees/phase1-upstream-defaults/opencode';
const json=p=>JSON.parse(readFileSync(p)),hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const save=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});
const pin=json(join(proof,'CANDIDATE-r2.json')),host=json(join(proof,'HOST.json')),baseline=json(join(proof,'LIVE-MANAGED-BASELINE.json'));
assert.equal(host.passed,true);assert.equal(host.manifestSha256,pin.manifestSha256);assert.equal(hash(join(pin.candidateDir,'.oprofile/profile-manifest.json')),pin.manifestSha256);
const accepted=json(join(pin.candidateDir,'.oprofile/profile-manifest.json'));
assert.deepEqual(verifyCandidateAgainstManifest(pin.candidateDir,accepted),[]);
assert.equal(hash(join(live,'.oprofile/active.json')),baseline.authoritySha256,'production authority drift');
for(const [path,e] of Object.entries(baseline.files)){const s=lstatSync(join(live,path));assert.ok(s.isFile()&&!s.isSymbolicLink());assert.equal(hash(join(live,path)),e.sha256,path);assert.equal((s.mode&0o777).toString(8).padStart(4,'0'),e.mode,path);}
const profile=json(join(source,'runtime/profile.json')),oldProfile=json(pin.profilePath);
for(const input of Object.values(oldProfile.inputs))if(input.source.startsWith(join(root,'profile/opencode')+'/'))input.source=join(source,relative(join(root,'profile/opencode'),input.source));
for(const name of ['omoPlugin','omoPluginV1'])oldProfile.components[name].candidateNote=profile.components[name].candidateNote;
assert.ok(equal(profile,oldProfile),'profile changes exceed the approved candidateNote clarification');verifyAllInputs(profile);
const inventory=dir=>{const out={};function visit(p,rel){const s=lstatSync(p),mode=s.mode&0o777;if(s.isSymbolicLink())out[rel]={type:'link',target:readlinkSync(p)};else if(s.isDirectory()){out[rel]={type:'dir',mode};for(const n of readdirSync(p).sort())visit(join(p,n),rel?rel+'/'+n:n);}else{assert.ok(s.isFile());out[rel]={type:'file',mode,sha256:hash(p),bytes:s.size};}}visit(dir,'');return out;};
const scopes=[...new Set(['.oprofile',...Object.keys(baseline.files).map(p=>p.split('/')[0]),...accepted.files.map(f=>f.path.split('/')[0])])].sort();
const initial={authoritySha256:baseline.authoritySha256,scopes:Object.fromEntries(scopes.map(p=>[p,inventory(join(live,p))]))};
for(const path of Object.keys(baseline.files)){for(let p=dirname(join(live,path));p.startsWith(live);p=dirname(p))assert.ok(!lstatSync(p).isSymbolicLink(),'production ancestor link');}
const candidateBytes=accepted.files.reduce((n,f)=>n+lstatSync(join(pin.candidateDir,f.path)).size,0);
const backupBytes=Object.values(baseline.files).reduce((n,_,i)=>n+lstatSync(join(live,Object.keys(baseline.files)[i])).size,0);
const free=()=>{const s=statfsSync(root);return s.bavail*s.bsize;};
assert.ok(free()>candidateBytes+backupBytes+256*1024**2,'insufficient candidate + rollback + 256MiB headroom');
assert.equal(existsSync(production),false,'production preparation already exists; inspect before retry');mkdirSync(production,{mode:0o700});
save(join(production,'BASELINE.json'),initial);
const frozen=join(production,'profile/opencode');mkdirSync(frozen,{recursive:true,mode:0o700});
for(const p of ['AGENTS.md','opencode.json','oh-my-opencode-slim.json','oh-my-opencode-slim','runtime'])cpSync(join(source,p),join(frozen,p),{recursive:true,verbatimSymlinks:true});
for(const input of Object.values(profile.inputs))if(input.source.startsWith(source+'/'))input.source=join(frozen,relative(source,input.source));
const profilePath=join(frozen,'runtime/profile.json');writeFileSync(profilePath,JSON.stringify(profile,null,2)+'\n',{mode:0o600});verifyAllInputs(profile);
const output=join(production,'candidates');mkdirSync(output,{mode:0o700});
const flags={omoPluginV1:'--omo-v1-plugin',bcpPlugin:'--bcp-plugin',compressionPlugin:'--compression-plugin',vibeguardV1:'--vibeguard-v1'};
const args=[join(frozen,'runtime/bin/oprofile.mjs'),'stage','--flavor','v1','--production-private','--opencode',pin.hostExecutable,'--profile',profilePath,'--out',output];
for(const [name,c] of Object.entries(accepted.components))if(c.staged){assert.ok(flags[name],name);args.push(flags[name],c.source);}
const log=execFileSync(process.execPath,args,{encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});writeFileSync(join(production,'stage.log'),log,{flag:'wx',mode:0o600});
const candidate=/^staged (.+)$/m.exec(log)?.[1];assert.ok(candidate);
const manifest=json(join(candidate,'.oprofile/profile-manifest.json'));assert.deepEqual(verifyCandidateAgainstManifest(candidate,manifest),[]);
assert.equal(manifest.privateProduction?.enabled,true);assert.equal(manifest.privateProduction.credentialKeyCount,0,'unexpected private credential delta; inspect without logging values');
assert.equal(manifest.files.length,accepted.files.length);const acceptedByPath=new Map(accepted.files.map(f=>[f.path,f]));
for(const f of manifest.files){const old=acceptedByPath.get(f.path);assert.ok(old,f.path);assert.equal(f.sha256??f.sourceSha256,old.sha256??old.sourceSha256,f.path);assert.equal(f.mode,f.path==='opencode.json'?'0600':old.mode,f.path);}
assert.ok(equal(json(join(candidate,'opencode.json')),json(join(pin.candidateDir,'opencode.json'))),'private config differs from accepted probe; values not logged');
const retired=Object.keys(baseline.files).filter(p=>!manifest.files.some(f=>f.path===p));assert.deepEqual(retired,pin.removed);
const record={at:new Date().toISOString(),candidate,manifestSha256:hash(join(candidate,'.oprofile/profile-manifest.json')),acceptedCandidate:pin.candidateDir,acceptedManifestSha256:pin.manifestSha256,entrySha256:pin.entrySha256,profilePath,profileSha256:hash(profilePath),runtime:join(frozen,'runtime'),baselineSha256:hash(join(production,'BASELINE.json')),retired,files:manifest.files.length,scopes,candidateBytes,backupBytes,freeBytes:free(),delta:['opencode.json mode 0644 -> 0600','profile candidateNote clarification and source relocation','private-production manifest metadata; managed file bytes are identical'],hostVersion:'1.18.33',omoVersion:'3.0.3'};
save(join(production,'CANDIDATE.json'),record);assert.equal(hash(join(live,'.oprofile/active.json')),baseline.authoritySha256);console.log(JSON.stringify({candidate,manifestSha256:record.manifestSha256,files:record.files,retired:retired.length,candidateBytes,backupBytes,freeBytes:record.freeBytes},null,2));
