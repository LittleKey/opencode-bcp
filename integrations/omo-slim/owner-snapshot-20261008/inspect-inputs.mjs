import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync, lstatSync, readlinkSync} from 'node:fs';
import {join} from 'node:path';
import {PATCHES_3_0_1} from '../../worktrees/omo-3.0.3-upgrade/integrations/omo-slim/omo-patch.mjs';
const root=import.meta.dirname, proof=join(root,'proof');
mkdirSync(proof,{recursive:true});
const pkg=join(root,'upstream/node_modules/oh-my-opencode-slim');
const hash=(bytes,algorithm='sha256',encoding='hex')=>createHash(algorithm).update(bytes).digest(encoding);
const json=p=>JSON.parse(readFileSync(p));
const save=(name,data)=>writeFileSync(join(proof,name),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
const lock=json(join(root,'upstream/package-lock.json'));
const metadata=await (await fetch('https://registry.npmjs.org/oh-my-opencode-slim/3.0.3')).json();
const archive=Buffer.from(await (await fetch(metadata.dist.tarball)).arrayBuffer());
assert.equal('sha512-'+hash(archive,'sha512','base64'),metadata.dist.integrity);
assert.equal(lock.packages['node_modules/oh-my-opencode-slim'].integrity,metadata.dist.integrity);
const entries=Object.fromEntries(['index','server'].map(entry=>{
  const path=join(pkg,entry==='index'?'dist/index.js':'dist/server/index.js');
  const source=readFileSync(path,'utf8');
  return [entry,{path,sha256:hash(source),bytes:Buffer.byteLength(source),anchors:PATCHES_3_0_1.map(p=>{
    const anchor=typeof p.anchor==='string'?p.anchor:p.anchor[entry];
    const replacement=typeof p.replacement==='string'?p.replacement:p.replacement[entry];
    const at=source.indexOf(anchor);
    return {id:p.id,anchorMatches:source.split(anchor).length-1,replacementMatches:source.split(replacement).length-1,line:at<0?null:source.slice(0,at).split('\n').length};
  })}];
}));
save('UPSTREAM.json',{at:new Date().toISOString(),version:metadata.version,integrity:metadata.dist.integrity,tarball:metadata.dist.tarball,gitHead:metadata.gitHead,lockSha256:hash(readFileSync(join(root,'upstream/package-lock.json'))),entries,packages:Object.fromEntries(Object.entries(lock.packages).map(([p,v])=>[p,{version:v.version,integrity:v.integrity}]))});
const live='/home/littlekey/.config/opencode', authorityPath=join(live,'.oprofile/active.json'), authority=json(authorityPath);
const changes=[],files={};
for(const f of authority.files){
  const path=join(live,f.path);
  let actual;
  try {const s=lstatSync(path);actual=s.isSymbolicLink()?{type:'link',target:readlinkSync(path)}:{type:s.isFile()?'file':'other',mode:(s.mode&0o777).toString(8).padStart(4,'0'),sha256:s.isFile()?hash(readFileSync(path)):null};}
  catch(e){if(e.code!=='ENOENT')throw e;actual=null;}
  files[f.path]=actual;
  if(!actual||actual.type!=='file'||actual.sha256!==f.sha256After||(f.mode&&actual.mode!==f.mode))changes.push({path:f.path,expected:{sha256:f.sha256After,mode:f.mode},actual});
}
save('LIVE-MANAGED-BASELINE.json',{at:new Date().toISOString(),authoritySha256:hash(readFileSync(authorityPath)),stage:authority.stage,files,changes});
console.log(JSON.stringify({entries,managedFiles:authority.files.length,changes},null,2));
