// Archive only the cache created by this task's completed metadata probes.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync,lstatSync,readFileSync,readdirSync,readlinkSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {join,relative} from 'node:path';
const root=import.meta.dirname,base=join(root,'candidates/state'),cache=join(base,'cache'),archive=join(root,'proof/metadata-cache.tar.gz');
assert.equal(existsSync(archive),false);assert.ok(lstatSync(cache).isDirectory()&&!lstatSync(cache).isSymbolicLink());
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const entries={};let bytes=0;
function inventory(dir){for(const name of readdirSync(dir).sort()){const path=join(dir,name),s=lstatSync(path),rel=relative(cache,path);const mode=(s.mode&0o777).toString(8).padStart(4,'0');if(s.isSymbolicLink())entries[rel]={type:'link',mode,target:readlinkSync(path)};else if(s.isDirectory()){entries[rel]={type:'dir',mode};inventory(path);}else{assert.ok(s.isFile());entries[rel]={type:'file',mode,sha256:hash(path),bytes:s.size};bytes+=s.size;}}}
inventory(cache);
for(const pid of readdirSync('/proc').filter(p=>/^\d+$/.test(p))){let names;try{if(statSync('/proc/'+pid).uid!==process.getuid())continue;names=readdirSync('/proc/'+pid+'/fd');}catch{continue;}for(const fd of names){let target;try{target=readlinkSync('/proc/'+pid+'/fd/'+fd);}catch{continue;}assert.ok(!target.startsWith(cache+'/'),`cache still open by ${pid}`);}}
execFileSync('tar',['--create','--gzip','--file',archive,'--directory',base,'cache'],{timeout:120000});
execFileSync('tar',['--compare','--gzip','--file',archive,'--directory',base],{timeout:120000});
const result={at:new Date().toISOString(),cache,archive,archiveSha256:hash(archive),archiveBytes:statSync(archive).size,originalBytes:bytes,entries,verified:'tar compare against original; no owned process held cache file descriptors',removed:false};
const proof=join(root,'proof/METADATA-CACHE-ARCHIVE.json');writeFileSync(proof,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
rmSync(cache,{recursive:true});result.removed=true;writeFileSync(proof,JSON.stringify(result,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({archive,originalBytes:bytes,archiveBytes:result.archiveBytes,files:Object.keys(entries).length,removed:true},null,2));
