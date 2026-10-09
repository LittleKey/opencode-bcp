// Owner transaction for the current real-directory topology. No service actions.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmodSync,copyFileSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,readlinkSync,renameSync,rmdirSync,statfsSync,statSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual as equal} from 'node:util';
export const ROOT=import.meta.dirname,LIVE='/home/littlekey/.config/opencode';
export const json=p=>JSON.parse(readFileSync(p)),hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
export const same=(a,b,message='snapshot mismatch')=>assert.ok(equal(a,b),message);
const stat=p=>{try{return lstatSync(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
export const mode=p=>lstatSync(p).mode&0o777;
const put=(p,bytes,bits=0o600)=>{mkdirSync(dirname(p),{recursive:true,mode:0o700});writeFileSync(p,bytes);chmodSync(p,bits);};
export const save=(p,value)=>{const tmp=p+'.tmp';try{put(tmp,JSON.stringify(value,null,2)+'\n');renameSync(tmp,p);}finally{if(stat(tmp))unlinkSync(tmp);}};
const originalSpec=json(join(ROOT,'production/CANDIDATE.json')),originalBaseline=json(join(ROOT,'production/BASELINE.json')),extra=json(join(ROOT,'production/TRANSACTION-INPUTS.json'));
assert.equal(extra.specSha256,hash(join(ROOT,'production/CANDIDATE.json')));assert.equal(extra.baselineSha256,hash(join(ROOT,'production/BASELINE.json')));
assert.deepEqual(Object.keys(extra.additionalScopes),['plugin']);
export const spec={...originalSpec,scopes:[...originalSpec.scopes,'plugin']},baseline={...originalBaseline,scopes:{...originalBaseline.scopes,...extra.additionalScopes}};
const accepted=json(join(ROOT,'proof/CANDIDATE-r2.json'));
const safeRel=p=>{assert.ok(typeof p==='string'&&p.length>0&&!isAbsolute(p)&&!p.split('/').some(n=>n==='..'||n===''||n==='.'),'unsafe relative path');};
function guard(root,p){assert.ok(p===root||resolve(p).startsWith(resolve(root)+sep),'escaped root');let cursor=root;assert.ok(!stat(root)?.isSymbolicLink(),'root link');for(const n of relative(root,p).split(sep).slice(0,-1)){cursor=join(cursor,n);assert.ok(!stat(cursor)?.isSymbolicLink(),'ancestor link');}}
function regular(root,p){guard(root,p);const s=stat(p);assert.ok(s?.isFile()&&!s.isSymbolicLink(),`non-file: ${p}`);assert.equal(s.nlink,1,`hardlink: ${p}`);}
function walk(root){const out={};function visit(p,rel){const s=lstatSync(p);if(s.isSymbolicLink())out[rel]={type:'link',target:readlinkSync(p)};else if(s.isDirectory()){out[rel]={type:'dir',mode:s.mode&0o777};for(const n of readdirSync(p).sort())visit(join(p,n),rel?rel+'/'+n:n);}else{assert.ok(s.isFile());out[rel]={type:'file',mode:s.mode&0o777,sha256:hash(p),bytes:s.size};}}if(stat(root))visit(root,'');return out;}
export const walkConfig=(cfg,scopes=spec.scopes)=>Object.fromEntries(scopes.flatMap(scope=>Object.entries(walk(join(cfg,scope))).map(([p,e])=>[scope==='.'?p:p?scope+'/'+p:scope,e])));
export const snapshot=cfg=>({authoritySha256:hash(join(cfg,'.oprofile/active.json')),scopes:Object.fromEntries(spec.scopes.map(scope=>[scope,walk(join(cfg,scope))]))});
const flatten=initial=>Object.fromEntries(Object.entries(initial.scopes).flatMap(([scope,entries])=>Object.entries(entries).map(([p,e])=>[p?scope+'/'+p:scope,e])));
function runtimeGate(){for(const dir of ['lib','bin']){const a=walk(join(dirname(accepted.profilePath),dir)),b=walk(join(spec.runtime,dir));same(a,b,'runtime differs from accepted candidate');}}
runtimeGate();
const {activate,rollback,planActivation,verifyCandidateAgainstManifest}=await import(pathToFileURL(join(spec.runtime,'lib/activate.mjs')));
const manifest=json(join(spec.candidate,'.oprofile/profile-manifest.json'));
const paths=manifest.files.filter(f=>f.path!=='.oprofile/profile-manifest.json'),candidates=new Set(paths.map(f=>f.path));
for(const p of [...candidates,...spec.retired])safeRel(p);assert.equal(new Set(spec.retired).size,spec.retired.length);assert.ok(spec.retired.every(p=>p.startsWith('plugins/omoPluginV1/')&&!candidates.has(p)));
export function candidateGate(candidate=spec.candidate){
 runtimeGate();assert.equal(hash(join(candidate,'.oprofile/profile-manifest.json')),spec.manifestSha256,'candidate manifest drift');
 assert.equal(hash(join(ROOT,'production/BASELINE.json')),spec.baselineSha256,'baseline drift');
 same(verifyCandidateAgainstManifest(candidate,manifest),[],'candidate integrity drift');
}
export function sourceDigests(){return Object.fromEntries(['upgrade.mjs','upgrade-rehearsal.mjs','transaction-regressions.mjs','production/TRANSACTION-INPUTS.json'].map(p=>[p,hash(join(ROOT,p))]));}
export function copyTree(src,dst,root,mapping){guard(root,dst);const s=lstatSync(src);mkdirSync(dirname(dst),{recursive:true});if(s.isSymbolicLink()){assert.ok(mapping);const target=readlinkSync(src),absolute=resolve(dirname(src),target);assert.ok(absolute===mapping.from||absolute.startsWith(mapping.from+'/'),'external replica link');const mapped=join(mapping.to,relative(mapping.from,absolute));symlinkSync(isAbsolute(target)?mapped:relative(dirname(dst),mapped),dst);}else if(s.isDirectory()){mkdirSync(dst,{recursive:true});chmodSync(dst,s.mode&0o777);for(const n of readdirSync(src))copyTree(join(src,n),join(dst,n),root,mapping);}else{assert.ok(s.isFile());copyFileSync(src,dst);chmodSync(dst,s.mode&0o777);assert.equal(lstatSync(dst).nlink,1);}}

export function controller(cfg,work,initial,candidate=spec.candidate){
 const authority=join(cfg,'.oprofile/active.json'),stateFile=join(work,'STATE.json'),before=flatten(initial);
 let state=existsSync(stateFile)?json(stateFile):{status:'new',cfg,candidate,manifestSha256:spec.manifestSha256,moved:[],authoritySha256:null};
 const journal=()=>save(stateFile,state);
 const stateGate=()=>{assert.equal(state.cfg,cfg);assert.equal(state.candidate,candidate);assert.equal(state.manifestSha256,spec.manifestSha256);same(state.moved,spec.retired.slice(0,state.moved.length),'retirement journal mismatch');assert.ok(state.moved.length<=spec.retired.length);};
  const preflight=()=>{candidateGate(candidate);stateGate();same(snapshot(cfg),initial,'baseline drift before first write');same(planActivation({candidateDir:candidate,liveRoot:cfg,replace:true}).conflicts,[],'activation conflicts before first write');for(const f of paths){guard(cfg,join(cfg,f.path));if(stat(join(cfg,f.path)))regular(cfg,join(cfg,f.path));}for(const p of spec.retired)regular(cfg,join(cfg,p));regular(cfg,authority);};
 const quarantineGate=()=>{for(const p of state.moved){const q=join(work,'quarantine',p);regular(work,q);same(walk(q)[''],before[p],`quarantine drift: ${p}`);assert.equal(stat(join(cfg,p)),null,'retired path recreated');}regular(work,join(work,'prior-authority.json'));assert.equal(hash(join(work,'prior-authority.json')),initial.authoritySha256,'prior authority backup drift');assert.equal(mode(join(work,'prior-authority.json')),before['.oprofile/active.json'].mode);};
  const prepared=()=>Object.fromEntries(Object.entries(before).filter(([p])=>!state.moved.includes(p)));
  const handledFailureGate=()=>{
   assert.equal(state.status,'activation-failed');const failure=state.activationFailure;
   assert.ok(Number.isInteger(failure?.rolledBack)&&failure.rolledBack>=0&&failure.rolledBack<=paths.length,'not a handled native failure');same(failure.rollbackProblems,[],'native rollback had problems');
   const actual=walkConfig(cfg),base=prepared();for(const [p,e] of Object.entries(base))same(actual[p],e,`native restore differs: ${p}`);
   const extras=Object.keys(actual).filter(p=>!base[p]);const roots=extras.filter(p=>/^\.oprofile\/backup\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(p));assert.ok(roots.length<=1,'unexpected native backup roots');
   const prefix=paths.slice(0,Math.min(paths.length,failure.rolledBack+1)),allowedDirs=new Set(),allowedFiles={};
   const parents=p=>{for(let d=dirname(p);d!=='.';d=dirname(d))if(!base[d])allowedDirs.add(d);};
   for(const f of prefix){parents(f.path);if(roots[0]&&base[f.path]){const p=join(roots[0],f.path);allowedFiles[p]=base[f.path];parents(p);}}
   for(const p of extras){const e=actual[p];if(e.type==='dir'){assert.ok(allowedDirs.has(p),`unexpected native directory: ${p}`);assert.equal(e.mode,0o777&~process.umask());}else{assert.ok(allowedFiles[p],`unexpected native residue: ${p}`);regular(cfg,join(cfg,p));same(e,allowedFiles[p],`native backup drift: ${p}`);}}
   for(const f of paths.slice(0,failure.rolledBack))if(base[f.path]){assert.ok(roots[0],'missing native backup root');same(actual[join(roots[0],f.path)],base[f.path],`missing applied backup: ${f.path}`);}
  };
 const installed=()=>{
  candidateGate(candidate);stateGate();assert.equal(state.moved.length,spec.retired.length);quarantineGate();regular(cfg,authority);
  if(state.authoritySha256)assert.equal(hash(authority),state.authoritySha256,'authority bytes changed');
  const rec=json(authority),base=prepared();assert.equal(typeof rec.backupsRoot,'string');const backupRel=relative(cfg,rec.backupsRoot);
  assert.match(backupRel,/^\.oprofile\/backup\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);assert.equal(resolve(cfg,backupRel),rec.backupsRoot);assert.ok(!base[backupRel]);assert.equal(new Date(rec.activatedAt).toISOString(),rec.activatedAt);
  const files=paths.map(f=>{const old=base[f.path];if(old)assert.equal(old.type,'file');return {path:f.path,action:old?'replace':'create',sha256Before:old?.sha256??null,sha256After:f.sha256??f.sourceSha256,backup:old?join(rec.backupsRoot,f.path):null,mode:f.mode??null,modeBefore:old?old.mode.toString(8).padStart(4,'0'):null};});
  same(rec,{schemaVersion:1,lane:'personal-profile',kind:'active-authority',activatedAt:rec.activatedAt,stage:{candidateDir:candidate,manifestSha256:spec.manifestSha256,flavor:manifest.flavor},backupsRoot:rec.backupsRoot,files,limits:manifest.limits},'authority operation list changed');
  const expected={...base};const addParents=p=>{for(let d=dirname(p);d!=='.';d=dirname(d))expected[d]??={type:'dir',mode:0o777&~process.umask()};};
  for(const f of paths){regular(cfg,join(cfg,f.path));expected[f.path]={type:'file',mode:parseInt(f.mode,8),sha256:f.sha256??f.sourceSha256,bytes:statSync(join(candidate,f.path)).size};addParents(f.path);}
  expected['.oprofile/active.json']={type:'file',mode:0o666&~process.umask(),sha256:hash(authority),bytes:lstatSync(authority).size};
  for(const f of files)if(f.backup){regular(cfg,f.backup);const rel=relative(cfg,f.backup);expected[rel]=base[f.path];addParents(rel);}
  const actual=walkConfig(cfg);
  if(!equal(actual,expected)){const delta=[...new Set([...Object.keys(actual),...Object.keys(expected)])].filter(p=>!equal(actual[p],expected[p]));throw new Error('installed tree, preserved files or backup drift: '+JSON.stringify(delta.slice(0,5).map(p=>({path:p,expected:expected[p],actual:actual[p]}))));}return rec;
 };
 const recover=()=>{
  candidateGate(candidate);stateGate();assert.ok(['installed','activated','prepared','preparing','activation-failed'].includes(state.status),'unsupported recovery state');regular(cfg,authority);quarantineGate();
  const prior=hash(authority)===initial.authoritySha256;
   if(prior){assert.ok(!['installed','activated'].includes(state.status),'installed authority replaced by old record');if(state.status==='activation-failed')handledFailureGate();else same(walkConfig(cfg),prepared(),'pre-activation restore contains unexpected writes');}
   else installed(); // All files, authority, backups and quarantines verified BEFORE writing.
   const auditRoot=join(work,'runtime-audit');guard(work,auditRoot);assert.equal(stat(auditRoot),null,'recovery audit destination exists');
   for(const [p,e] of Object.entries(walkConfig(cfg)))if(e.type==='file'&&!before[p]&&p.startsWith('.oprofile/')){const dst=join(auditRoot,p);guard(work,dst);assert.equal(stat(dst),null,'recovery audit collision');}
   for(const p of state.moved){guard(cfg,join(cfg,p));assert.equal(stat(join(cfg,p)),null,'retired destination recreated');}
  if(!prior)same(rollback({liveRoot:cfg}).blocked,[],'product rollback blocked');
  for(const [p,e] of Object.entries(walkConfig(cfg)))if(e.type==='file'&&!before[p]&&p.startsWith('.oprofile/')){const dst=join(work,'runtime-audit',p);guard(work,dst);assert.ok(!stat(dst));mkdirSync(dirname(dst),{recursive:true});renameSync(join(cfg,p),dst);}
  for(const p of [...state.moved].reverse()){const dst=join(cfg,p);guard(cfg,dst);assert.equal(stat(dst),null);mkdirSync(dirname(dst),{recursive:true});renameSync(join(work,'quarantine',p),dst);}
  put(authority,readFileSync(join(work,'prior-authority.json')),before['.oprofile/active.json'].mode);
  for(const [p,e] of Object.entries(walkConfig(cfg)).sort(([a],[b])=>b.length-a.length))if(e.type==='dir'&&!before[p]&&readdirSync(join(cfg,p)).length===0)rmdirSync(join(cfg,p));
  same(snapshot(cfg),initial,'full rollback mismatch');state.status='rolled-back';journal();
 };
 const apply=({failAfterPreparation=false,failInstalledSnapshot=null}={})=>{
  if(state.status==='installed'){installed();return;}
  preflight();assert.ok(['new','rolled-back'].includes(state.status));
  save(join(work,'initial-tree.json'),before);save(join(work,'baseline.json'),initial);put(join(work,'prior-authority.json'),readFileSync(authority),mode(authority));
   state={...state,status:'preparing',moved:[],authoritySha256:null,activationFailure:null};journal();
  try{
   for(const p of spec.retired){const src=join(cfg,p),dst=join(work,'quarantine',p);regular(cfg,src);guard(work,dst);assert.ok(!stat(dst));mkdirSync(dirname(dst),{recursive:true});renameSync(src,dst);state.moved.push(p);journal();}
   same(planActivation({candidateDir:candidate,liveRoot:cfg,replace:true}).conflicts,[],'prepared activation conflicts');save(join(work,'prepared.json'),prepared());state.status='prepared';journal();
   if(failAfterPreparation)throw new Error('injected preparation failure');
    try{activate({candidateDir:candidate,liveRoot:cfg,replace:true});}catch(e){state.status='activation-failed';state.activationFailure={rolledBack:e.rolledBack??null,rollbackProblems:e.rollbackProblems??null};journal();throw e;}
   state.status='activated';state.authoritySha256=hash(authority);journal();installed();
   if(failInstalledSnapshot){const path=join(work,'installed.json');if(stat(path))unlinkSync(path);if(failInstalledSnapshot==='truncated')put(path,'{');throw new Error('injected installed snapshot '+failInstalledSnapshot);}
   save(join(work,'installed.json'),walkConfig(cfg));state.status='installed';journal();
  }catch(error){try{recover();}catch(recovery){throw new Error(`${error.message}; recovery refused: ${recovery.message}`,{cause:error});}throw error;}
 };
 return {preflight,apply,installed,recover,state:()=>state};
}

async function main(){const action=process.argv[2];assert.ok(['--rehearse','--activate','--rollback'].includes(action));candidateGate();
 if(action==='--rehearse'){const {runRehearsal}=await import('./upgrade-rehearsal.mjs');runRehearsal({controller,snapshot,walkConfig,copyTree,hash,json,mode,save,same,LIVE,ROOT,spec,baseline,candidateGate,sourceDigests});return;}
 const transaction=join(ROOT,'production/transaction');
 if(action==='--activate'){
   const proof=json(join(ROOT,'production/REHEARSAL-r2.json'));assert.equal(proof.passed,true);assert.equal(proof.specSha256,hash(join(ROOT,'production/CANDIDATE.json')));same(proof.sourceDigests,sourceDigests(),'script changed after rehearsal');
   const regressions=json(join(ROOT,'production/TRANSACTION-REGRESSIONS-green.json'));assert.equal(regressions.passed,true);same(regressions.sourceDigests,sourceDigests(),'script changed after regressions');
  const review=json(join(ROOT,'production/TRANSACTION-REVIEW.json'));assert.equal(review.passed,true);same(review.sourceDigests,sourceDigests(),'script changed after review');assert.equal(review.manifestSha256,spec.manifestSha256);
  assert.ok(!existsSync(transaction),'transaction already exists; inspect before retry');same(snapshot(LIVE),baseline,'production drift');const fs=statfsSync(ROOT);assert.ok(fs.bavail*fs.bsize>spec.backupBytes+256*1024**2,'insufficient rollback headroom');
  mkdirSync(transaction,{mode:0o700});const c=controller(LIVE,transaction,baseline);c.apply();c.installed();save(join(ROOT,'production/ACTIVATION.json'),{at:new Date().toISOString(),passed:true,candidate:spec.candidate,manifestSha256:spec.manifestSha256,authoritySha256:hash(join(LIVE,'.oprofile/active.json')),managedFiles:paths.length,retired:spec.retired,transaction,serviceReloaded:false});console.log(JSON.stringify({activated:true,managedFiles:paths.length,transaction}));
 }else{assert.ok(existsSync(transaction));controller(LIVE,transaction,baseline).recover();console.log(JSON.stringify({rolledBack:true,authoritySha256:hash(join(LIVE,'.oprofile/active.json'))}));}
}
if(process.argv[1]===import.meta.filename)await main();
