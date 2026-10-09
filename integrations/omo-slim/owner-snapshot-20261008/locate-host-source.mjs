import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {personalCore} from '/home/littlekey/github/dotfiles/.slim/worktrees/phase1-upstream-defaults/opencode/runtime/lib/render.mjs';
const authority=JSON.parse(readFileSync('/home/littlekey/.config/opencode/.oprofile/active.json'));
const before=JSON.parse(readFileSync(authority.files.find(f=>f.path==='opencode.json').backup));
const paths=[
  '/home/littlekey/github/dotfiles/.slim/worktrees/phase1-upstream-defaults/opencode/opencode.json',
  '/home/littlekey/github/opencode-bcp/.slim/deepwork/upstream-defaults-20261006/dotfiles/opencode/opencode.json',
];
for(const path of paths) {
  try {const bytes=readFileSync(path),config=JSON.parse(bytes);console.log(JSON.stringify({path,sha256:createHash('sha256').update(bytes).digest('hex'),jsonIdentical:isDeepStrictEqual(before,config),personalCoreIdentical:isDeepStrictEqual(personalCore(before,{preserveCredentials:true}),personalCore(config,{preserveCredentials:true})),differentRoots:[...new Set([...Object.keys(before),...Object.keys(config)])].filter(k=>!isDeepStrictEqual(before[k],config[k])).sort()}));}
  catch(error) {console.log(JSON.stringify({path,error:error.code}));}
}
