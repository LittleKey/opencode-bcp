// Additive compatibility evidence for the user's already-installed host version.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {cpSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,relative} from 'node:path';
import {verifyCandidateAgainstManifest} from './profile/opencode/runtime/lib/activate.mjs';
import {controller,baseline,LIVE} from './upgrade.mjs';
const root=import.meta.dirname,proof=join(root,'proof'),out=join(proof,'host-1.18.35'),scratch='/tmp/opencode/omo303-host11835';
const json=p=>JSON.parse(readFileSync(p)),hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const save=(p,obj)=>writeFileSync(p,JSON.stringify(obj,null,2)+'\n',{flag:'wx',mode:0o600});
const version='1.18.35',exe='/home/littlekey/.local/share/mise/installs/opencode/1.18.35/opencode';
const source=json(join(proof,'CANDIDATE-r2.json')),production=json(join(root,'production/CANDIDATE.json'));
const sourceManifest=join(source.candidateDir,'.oprofile/profile-manifest.json');
const installed=()=>controller(LIVE,join(root,'production/transaction'),baseline).installed();
function inputGate(){
 assert.equal(execFileSync(exe,['--version'],{encoding:'utf8',timeout:15000}).trim(),version);
 assert.equal(hash(sourceManifest),source.manifestSha256);
 assert.deepEqual(verifyCandidateAgainstManifest(source.candidateDir,json(sourceManifest)),[]);
 assert.equal(source.entrySha256,production.entrySha256);installed();
}
const inventory=(dir,base=dir)=>Object.fromEntries(readdirSync(dir).sort().flatMap(name=>{
 const path=join(dir,name),s=lstatSync(path);assert.ok(!s.isSymbolicLink(),path);
 return s.isDirectory()?Object.entries(inventory(path,base)):[[relative(base,path),hash(path)]];
}));
const mode=process.argv[2];
if(mode==='prepare'){
 inputGate();assert.ok(!existsSync(out)&&!existsSync(scratch));mkdirSync(out,{mode:0o700});mkdirSync(scratch,{mode:0o700});
 const pin={at:new Date().toISOString(),kind:'additional-host-compatibility-input',basis:'User confirmed the host upgrade and requested retaining 1.18.35.',candidateDir:source.candidateDir,manifestSha256:source.manifestSha256,profilePath:source.profilePath,profileSha256:source.profileSha256,omoVersion:source.omoVersion,entrySha256:source.entrySha256,hostVersion:version,hostExecutable:exe,hostExecutableSha256:hash(exe),originalHostVersion:source.hostVersion,productionManifestSha256:production.manifestSha256,productionAuthoritySha256:hash(join(LIVE,'.oprofile/active.json'))};
 save(join(proof,'CANDIDATE-host11835.json'),pin);
 save(join(out,'INPUTS.json'),{...pin,sources:Object.fromEntries(['host-11835.mjs','probe-11835.py','run_roles.py','run_bcp.py','check-production.mjs','proof/expected-v1.json'].map(p=>[p,hash(join(root,p))]))});
 const candidate=join(scratch,'metadata/candidate');mkdirSync(join(scratch,'metadata'),{recursive:true});cpSync(source.candidateDir,candidate,{recursive:true,verbatimSymlinks:true});
 assert.deepEqual(verifyCandidateAgainstManifest(candidate,json(sourceManifest)),[]);
 mkdirSync(join(scratch,'project'));writeFileSync(join(scratch,'project/README.md'),'Neutral compatibility probe project.\n',{flag:'wx'});
 console.log(JSON.stringify({version,hostExecutableSha256:pin.hostExecutableSha256,manifestSha256:pin.manifestSha256,productionUnchanged:true},null,2));
}else if(mode==='metadata'){
 const inputs=json(join(out,'INPUTS.json'));assert.equal(hash(exe),inputs.hostExecutableSha256);inputGate();
 const candidate=join(scratch,'metadata/candidate'),runtime=join(root,'profile/opencode/runtime');
 let output='',status=0;
 try{output=execFileSync(process.execPath,[join(runtime,'bin/oprofile.mjs'),'verify','--stage',candidate,'--opencode',exe,'--profile',source.profilePath,'--project',join(scratch,'project'),'--cache-dir',join(scratch,'cache')],{env:{...process.env,npm_config_cache:join(scratch,'npm-cache')},encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});}
 catch(e){output=String(e.stdout??'')+String(e.stderr??'');status=e.status??1;}
 writeFileSync(join(out,'METADATA.log'),output,{flag:'wx',mode:0o600});
 if(existsSync(join(candidate,'.oprofile/verify-report.json')))save(join(out,'METADATA.json'),json(join(candidate,'.oprofile/verify-report.json')));
 assert.equal(status,0,output);const report=json(join(out,'METADATA.json'));assert.equal(report.passed,true);assert.ok(report.checks.some(c=>c.id==='sandbox-db'&&c.pass));
 console.log(JSON.stringify({passed:true,checks:report.checks.length,report:join(out,'METADATA.json')},null,2));
}else if(mode==='seal'){
 inputGate();const inputs=json(join(out,'INPUTS.json'));assert.equal(hash(exe),inputs.hostExecutableSha256);
 for(const [p,digest] of Object.entries(inputs.sources))assert.equal(hash(join(root,p)),digest,p);
 assert.equal(hash(join(LIVE,'.oprofile/active.json')),inputs.productionAuthoritySha256);
 const metadata=json(join(out,'METADATA.json'));assert.equal(metadata.passed,true);
 const evidence={metadata:{checks:metadata.checks.length,sha256:hash(join(out,'METADATA.json'))}};
 for(const name of ['ROLES','BCP']){
  const path=join(proof,`HOST-${name}-host11835.json`),report=json(path);assert.equal(report.passed,true);assert.equal(report.candidateManifest,inputs.manifestSha256);
  const art=join(report.case,'artifacts'),health=json(join(art,'HEALTH.json')),binding=json(join(art,'HOST-BINDING.json'));
  assert.equal(health.fdAudit.status,'verified');assert.equal(health.realModelRequests,0);assert.equal(binding.version,version);assert.equal(binding.executableSha256,inputs.hostExecutableSha256);
  const target=join(out,name.toLowerCase());assert.equal(existsSync(target),false);cpSync(art,target,{recursive:true,verbatimSymlinks:true});assert.deepEqual(inventory(target),inventory(art));
  evidence[name.toLowerCase()]={checks:report.checks.length,reportSha256:hash(path),artifacts:target,files:inventory(target),host:binding,realModelRequests:0,limits:report.limits};
 }
 const result={at:new Date().toISOString(),passed:true,hostVersion:version,hostExecutable:exe,hostExecutableSha256:inputs.hostExecutableSha256,omoVersion:inputs.omoVersion,entrySha256:inputs.entrySha256,candidateManifestSha256:inputs.manifestSha256,productionManifestSha256:inputs.productionManifestSha256,productionAuthoritySha256:inputs.productionAuthoritySha256,inputsSha256:hash(join(out,'INPUTS.json')),evidence,productionUnchanged:true,limits:['Local scripted provider only; no real model intelligence, full compression recovery, external MCP services, v2 or performance certification.','Previously accepted source/installer tests remain historical evidence; only host-dependent checks were rerun.']};
 save(join(out,'COMPATIBILITY.json'),result);
 // Keep the original 1.18.33 gate and its failed report intact. This new gate
 // accepts only the exact binary after the additive compatibility record passes.
 let text=readFileSync(join(root,'check-production.mjs'),'utf8');
 const anchor="const spec=json(join(root,'production/CANDIDATE.json')),beforeRestart=process.argv.includes('--before-restart'),preflight=process.argv.includes('--preflight')||beforeRestart;";
 assert.equal(text.split(anchor).length,2);
 text=text.replace(anchor,`const originalSpec=json(join(root,'production/CANDIDATE.json'));\nconst compatibilityPath=join(root,'proof/host-1.18.35/COMPATIBILITY.json'),compatibility=json(compatibilityPath);\nassert.equal(compatibility.passed,true);assert.equal(compatibility.hostVersion,'1.18.35');assert.equal(compatibility.productionManifestSha256,originalSpec.manifestSha256);assert.equal(compatibility.entrySha256,originalSpec.entrySha256);\nassert.equal(hash(compatibilityPath),'${hash(join(out,'COMPATIBILITY.json'))}');\nassert.equal(readlinkSync('/proc/'+pid+'/exe'),compatibility.hostExecutable);assert.equal(hash(compatibility.hostExecutable),compatibility.hostExecutableSha256);\nconst spec={...originalSpec,hostVersion:compatibility.hostVersion},beforeRestart=false,preflight=false;`);
 text=text.replace('production/HOST-${','production/HOST-11835-${');
 text=text.replace('report.passed=true;','report.compatibilityReportSha256=hash(compatibilityPath);report.passed=true;');
 writeFileSync(join(root,'check-production-11835.mjs'),text,{flag:'wx'});
 console.log(JSON.stringify({passed:true,checks:Object.fromEntries(Object.entries(evidence).map(([k,v])=>[k,v.checks])),productionUnchanged:true},null,2));
}else throw new Error('Expected prepare, metadata or seal');
