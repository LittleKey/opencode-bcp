import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {lstatSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const root=import.meta.dirname,proof=join(root,'proof'),json=p=>JSON.parse(readFileSync(p));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const reviewed=json(join(proof,'review/manifest.json'));
for(const repo of Object.values(reviewed.repos)) {
 assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:repo.path,encoding:'utf8'}).trim(),repo.head);
 for(const [path,expected] of Object.entries(repo.files))assert.equal(hash(join(repo.path,path)),expected,path);
}
for(const [path,expected] of Object.entries(reviewed.controllers))assert.equal(hash(path),expected,path);
for(const [path,expected] of Object.entries(reviewed.proofs))assert.equal(hash(join(proof,path)),expected,path);
for(const item of [reviewed.plan,reviewed.ledger])assert.equal(hash(item.path),item.sha256,item.path);
const pin=json(join(proof,'CANDIDATE-r2.json'));
assert.equal(hash(join(pin.candidateDir,'.oprofile/profile-manifest.json')),pin.manifestSha256);
assert.equal(hash(join(pin.candidateDir,'plugins/omoPluginV1/index/dist/index.js')),pin.entrySha256);
const baseline=json(join(proof,'LIVE-MANAGED-BASELINE.json')),live='/home/littlekey/.config/opencode';
assert.equal(hash(join(live,'.oprofile/active.json')),baseline.authoritySha256);
for(const [path,expected] of Object.entries(baseline.files)) {
 assert.equal(hash(join(live,path)),expected.sha256,path);
 assert.equal((lstatSync(join(live,path)).mode&0o777).toString(8).padStart(4,'0'),expected.mode,path);
}
assert.equal(json(join(live,'plugins/omoPluginV1/index/package.json')).version,'3.0.1');
const record={at:new Date().toISOString(),passed:true,review:'bb://3871adbf-ec76-47e5-a3f8-32a3a0fcb113/30199efb-1419-4331-b356-2de604ebc230/e000001',reviewTextSha256:'4a0ab76888a855246a057008609ff4c1b2ae904e1792ad31aee0a4a2822d52a7',reviewPackageSha256:hash(join(proof,'review/manifest.json')),sourceAndEvidenceUnchanged:true,candidateManifest:pin.manifestSha256,candidateEntry:pin.entrySha256,liveOmoVersion:'3.0.1',productionAuthoritySha256:baseline.authoritySha256,productionFilesUnchanged:Object.keys(baseline.files).length,limits:['Read-only candidate acceptance for tasks 1–3. Production transaction, activation and reload are not authorized by this record.','Reviewer source retention has no historical edit journal; current source hashes and direct reads are the evidence, not retained text alone.']};
writeFileSync(join(proof,'REVIEW-SEAL.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(record,null,2));
