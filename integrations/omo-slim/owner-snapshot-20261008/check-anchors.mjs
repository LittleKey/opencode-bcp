import {readFileSync} from 'node:fs';
import {PATCHES_3_0_3} from '../../worktrees/omo-3.0.3-upgrade/integrations/omo-slim/omo-patch.mjs';
for (const entry of ['index', 'server']) {
  const source = readFileSync(new URL('upstream/node_modules/oh-my-opencode-slim/dist/' + (entry === 'index' ? 'index.js' : 'server/index.js'), import.meta.url), 'utf8');
  for (const p of PATCHES_3_0_3) {
    const anchor = typeof p.anchor === 'string' ? p.anchor : p.anchor[entry];
    const count = source.split(anchor).length - 1;
    if (count !== 1) { console.log(JSON.stringify({entry, id: p.id, count})); process.exitCode = 1; }
  }
}
