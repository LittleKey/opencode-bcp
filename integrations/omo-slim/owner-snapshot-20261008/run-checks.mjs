import {execFileSync} from 'node:child_process';
import {readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const root=import.meta.dirname,work=join(root,'../../worktrees/omo-3.0.3-upgrade');
const tests=readdirSync(join(work,'integrations/omo-slim/test')).filter(p=>p.endsWith('.test.mjs')).sort().map(p=>'integrations/omo-slim/test/'+p);
let output,status=0;
try {output=execFileSync(process.execPath,['--test','--test-concurrency=1',...tests],{cwd:work,env:{...process.env,OMO_303_PACKAGE:join(root,'upstream/node_modules/oh-my-opencode-slim'),OMO_REMEDIATION_ROOT:join(root,'../upstream-defaults-20261006'),OPROFILE_RUNTIME_DIR:'/home/littlekey/github/dotfiles/.slim/worktrees/phase1-upstream-defaults/opencode/runtime'},encoding:'utf8',timeout:240000,maxBuffer:8*1024*1024});}
catch(error){output=String(error.stdout??'')+String(error.stderr??'');status=error.status??1;}
writeFileSync(join(root,'proof/TESTS-r2.log'),output,{flag:'wx',mode:0o600});
writeFileSync(join(root,'proof/TESTS-r2.json'),JSON.stringify({at:new Date().toISOString(),work,tests,status,output:'TESTS-r2.log'},null,2)+'\n',{flag:'wx',mode:0o600});
console.log(output);process.exit(status);
