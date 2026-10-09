// Read-only inspection of an existing host; never restarts it or sends a model request.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,readlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const root=import.meta.dirname,live='/home/littlekey/.config/opencode',directory='/home/littlekey/github/document-writer';
const json=p=>JSON.parse(readFileSync(p)),sha=b=>createHash('sha256').update(b).digest('hex'),hash=p=>sha(readFileSync(p));
const option=name=>process.argv.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
const pid=option('pid'),port=option('port');assert.match(pid??'',/^\d+$/);assert.match(port??'',/^\d+$/);assert.ok(Number(port)>0&&Number(port)<65536);
const spec=json(join(root,'production/CANDIDATE.json')),beforeRestart=process.argv.includes('--before-restart'),preflight=process.argv.includes('--preflight')||beforeRestart;
const cmd=readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0');assert.ok(cmd.includes('serve'));assert.equal(cmd[cmd.indexOf('--port')+1],port);
const env=Object.fromEntries(readFileSync(`/proc/${pid}/environ`,'utf8').split('\0').filter(x=>x.includes('=')).map(x=>{const i=x.indexOf('=');return[x.slice(0,i),x.slice(i+1)];}));
assert.ok(env.OPENCODE_SERVER_PASSWORD,'host authentication unavailable');
const headers={Authorization:'Basic '+Buffer.from(`${env.OPENCODE_SERVER_USERNAME??'opencode'}:${env.OPENCODE_SERVER_PASSWORD}`).toString('base64')};
// /proc uptime and process start time can use different namespace offsets.
// Bind restart evidence to process identity, not a reconstructed wall-clock date.
const processStartTicks=readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1].split(' ')[19],bootId=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
const report={at:new Date().toISOString(),pid:Number(pid),port:Number(port),processStartTicks,bootId,executable:readlinkSync(`/proc/${pid}/exe`),directory,preflight,beforeRestart,passed:false,modelRequests:0,manifestSha256:spec.manifestSha256};
const request=async path=>{const r=await fetch(`http://127.0.0.1:${port}${path}`,{headers,signal:AbortSignal.timeout(30000)});assert.ok(r.ok,`${path}: HTTP ${r.status}`);return r.json();};
const out=join(root,`production/HOST-${preflight?'PREFLIGHT-':''}${report.at.replace(/[:.]/g,'-')}.json`);
try {
 report.health=await request('/global/health');assert.equal(report.health.healthy,true);assert.equal(report.health.version,spec.hostVersion);
 const query='?directory='+encodeURIComponent(directory),status=await request('/session/status'+query);
 report.busySessions=Object.entries(status).filter(([,s])=>s.type!=='idle').map(([id])=>id);
 if(beforeRestart){const activation=json(join(root,'production/ACTIVATION.json'));assert.equal(activation.passed,true);assert.equal(activation.manifestSha256,spec.manifestSha256);assert.equal(hash(join(live,'.oprofile/active.json')),activation.authoritySha256);}
 if(!preflight) {
  const activation=json(join(root,'production/ACTIVATION.json'));assert.equal(activation.passed,true);assert.equal(activation.manifestSha256,spec.manifestSha256);
  const prior=json(join(root,'production/HOST-BEFORE-RESTART.json'));assert.equal(prior.passed,true);assert.equal(prior.beforeRestart,true);assert.equal(prior.manifestSha256,spec.manifestSha256);
  assert.ok(prior.bootId!==bootId||prior.pid!==Number(pid)||prior.processStartTicks!==processStartTicks,'host is still the pre-restart process');
  if(prior.bootId===bootId)assert.ok(BigInt(processStartTicks)>BigInt(prior.processStartTicks),'host was not started after the pre-restart process');
  report.restartVerified=true;report.previousHost={pid:prior.pid,processStartTicks:prior.processStartTicks,bootId:prior.bootId};
  assert.equal(hash(join(live,'.oprofile/active.json')),activation.authoritySha256);
  const {controller,baseline}=await import('./upgrade.mjs');controller(live,join(root,'production/transaction'),baseline).installed();
  assert.equal(hash(join(live,'plugins/omoPluginV1/index/dist/index.js')),spec.entrySha256);
  report.omoVersion=json(join(live,'plugins/omoPluginV1/index/package.json')).version;assert.equal(report.omoVersion,spec.omoVersion);
  assert.equal(lstatSync(join(live,'opencode.json')).mode&0o777,0o600);
  const expected=json(join(root,'proof/expected-v1.json')).agentConfigs;
  expected['lark-operator'].prompt=readFileSync(join(spec.candidate,'agents/lark-operator.md'),'utf8').split('---',3)[2].trim();
  const agents=await request('/agent'+query),skills=await request('/skill'+query);
  report.agents=Object.fromEntries(['orchestrator','designer','explorer','librarian','oracle','fixer','observer','document-writer','lark-operator'].map(name=>{
   const a=agents.find(a=>a.name===name),e=expected[name];assert.ok(a,`missing role ${name}`);
   const expectedModel=e.model;assert.equal(a.prompt,e.prompt,`prompt differs: ${name}`);
   if(expectedModel)assert.equal(`${a.model?.providerID}/${a.model?.modelID}`,expectedModel,`model differs: ${name}`);
   assert.equal(a.variant??null,e.variant??null,`variant differs: ${name}`);
   assert.equal(a.mode,name==='lark-operator'?'all':e.mode??'subagent',`mode differs: ${name}`);
   return[name,{promptSha256:sha(a.prompt),promptMatches:true,model:a.model,variant:a.variant,mode:a.mode}];
  }));
  for(const name of ['explorer','oracle','librarian','observer'])for(const permission of ['write','edit','apply_patch','ast_grep_replace']) {
   const rules=agents.find(a=>a.name===name).permission.filter(r=>r.permission===permission);
   assert.ok(rules.some(r=>r.pattern==='*'&&r.action==='deny')&&!rules.some(r=>r.action==='allow'),`${name}/${permission} not readonly`);
  }
  report.readonlyRoles=['explorer','oracle','librarian','observer'];
  report.skills=Object.fromEntries(['clonedeps','deepwork','executing-plans','writing-plans'].map(name=>{
   const s=skills.find(s=>s.name===name),file=join(live,'skills',name,'SKILL.md'),text=readFileSync(file,'utf8');
   const body=text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'').trim();
   assert.ok(s&&typeof s.content==='string'&&(s.content.trim()===body||s.content===text),`skill content differs: ${name}`);
   return[name,{fileSha256:sha(text),contentMatches:true,location:s.location}];
  }));
  for(const name of ['plan-workspace','review-package','task-brief','task-done','task-start'])assert.equal(lstatSync(join(live,'skills/executing-plans/scripts',name)).mode&0o777,0o755,name);
  report.executableHelpers=5;report.managedFiles=spec.files-1;
  report.limits=['Existing-host configuration and registry checks only; no real model request or full compression-recovery claim.'];
 }
 report.passed=true;
}catch(error){report.error=error.message;process.exitCode=1;}
writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
if(beforeRestart&&report.passed)writeFileSync(join(root,'production/HOST-BEFORE-RESTART.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({passed:report.passed,preflight,pid:report.pid,port:report.port,processStartTicks,busySessions:report.busySessions,error:report.error,report:out},null,2));
