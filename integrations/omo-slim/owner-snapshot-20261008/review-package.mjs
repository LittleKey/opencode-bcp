import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const root=import.meta.dirname,out=join(root,'proof/review');assert.equal(existsSync(out),false);mkdirSync(out,{mode:0o700});
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',maxBuffer:8*1024*1024});
const repos={bcp:{path:join(root,'../../worktrees/omo-3.0.3-upgrade'),base:'8a6119d'},dotfiles:{path:'/home/littlekey/github/dotfiles/.slim/worktrees/phase1-upstream-defaults',base:'09f0d4a'}};
for(const [name,repo] of Object.entries(repos)) {
 repo.head=git(repo.path,'rev-parse','HEAD').trim();assert.ok(repo.head.startsWith(repo.base));
 repo.status=git(repo.path,'status','--short');
 const files=[...new Set([...git(repo.path,'diff','--name-only','HEAD').trim().split('\n'),...git(repo.path,'ls-files','--others','--exclude-standard').trim().split('\n')])].filter(Boolean);
 repo.files=Object.fromEntries(files.map(p=>[p,hash(join(repo.path,p))]));
 writeFileSync(join(out,name+'.patch'),git(repo.path,'diff','--unified=8','HEAD'),{flag:'wx'});
 repo.untracked=git(repo.path,'ls-files','--others','--exclude-standard').trim().split('\n').filter(Boolean);
}
const plan='/home/littlekey/github/opencode-bcp/docs/plans/2026-10-08-omo-3.0.3-upgrade.md';
const ledger='/home/littlekey/github/opencode-bcp/.plans/2026-10-08-omo-3.0.3-upgrade/progress.md';
const controllerFiles=readdirSync(root).filter(p=>/\.(mjs|py)$/.test(p));
const manifest={at:new Date().toISOString(),repos,plan:{path:plan,sha256:hash(plan)},ledger:{path:ledger,sha256:hash(ledger)},controllers:Object.fromEntries(controllerFiles.map(p=>[join(root,p),hash(join(root,p))])),proofs:Object.fromEntries(['HOST.json','BUILD-r2.json','PATCH-AUDIT.json','CANDIDATE-r2.json','SKILL-GENERATION.json','HOST-SOURCE-SELECTION.json','TESTS-r2.json','TESTS-r2.log'].map(p=>[p,hash(join(root,'proof',p))]))};
writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
const focus=readFileSync(plan,'utf8').split('## Review Focus\n')[1].split('\n## ')[0].trim();
writeFileSync(join(out,'REVIEW.md'),`# OMO 3.0.3 candidate review\n\nReview only the approved tasks 1–3 and their evidence before production approval. Task 4 transaction/rehearsal/activation is explicitly pending. No commits were authorized; both HEADs equal their bases, so use the working-tree diffs plus untracked source files in manifest.json rather than an empty commit range. Do not mutate either repository or launch hosts; no subagents or broad test reruns.\n\nPlan: ${plan}\n\nLedger (including Ruling lines): ${ledger}\n\nTemplate: /home/littlekey/.config/opencode/skills/executing-plans/references/code-reviewer.md\n\n## Review Focus (verbatim)\n\n${focus}\n\n## Sources\n\n- Read manifest.json and both .patch files here; untracked new tests/overrides are listed with their actual paths and hashes under repos.\n- Read ${root}/proof/HOST.json, PATCH-AUDIT.json, PATCH-AUDIT.md, CANDIDATE-r2.json, SKILL-GENERATION.json, HOST-SOURCE-SELECTION.json and TESTS-r2.log. The frozen candidate/artifact paths are in those records.\n- Actual role and BCP reports: ${root}/proof/HOST-ROLES-r2.json and HOST-BCP-r2.json; retained raw tool/provider data: proof/host-roles-r2 and proof/host-bcp-r2. Only loopback scripted-provider requests, not real models.\n- Controllers: prepare.mjs, run_roles.py, run_bcp.py and verify-host.mjs under ${root}; no upgrade.mjs exists yet.\n\n## Acceptance question\n\nCan this exact v1 candidate proceed to the separately approved production-transaction preparation? Identify concrete identity, permission, source-pin, resource or evidence failures; grade by user impact. Check all five focus items; distinguish task-4 deferral from falsely claiming it passed. Include explicit Declined to judge items and a concise verdict with source lines and limits. Production still OMO3.0.1/OpenCode1.18.33.\n`,{flag:'wx'});
console.log(join(out,'REVIEW.md'));
