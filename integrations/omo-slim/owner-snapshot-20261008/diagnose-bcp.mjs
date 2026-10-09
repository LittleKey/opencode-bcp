import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {presentDelivery} from '../../worktrees/omo-3.0.3-upgrade/integrations/omo-slim/omo-delivery.mjs';
const turns=JSON.parse(readFileSync('/tmp/opencode/omo303-bcp-20261008T152837/artifacts/TURNS.json'));
for(const turn of turns){
 const part=turn.parts.find(p=>p.tool==='task');
 const text=part?.state.output,meta=part?.state.metadata?.bcp_delivery;
 if(!text){console.log(turn.tag,part?.state);continue;}
 const body=text.split('<task_result>\n')[1]?.split('\n</task_result>')[0];
 const suffix=text.split('\n</task_result>')[1];
 console.log(JSON.stringify({turn:turn.tag,bytes:Buffer.byteLength(text),bodyBytes:body&&Buffer.byteLength(body),bodyHash:body&&createHash('sha256').update(body).digest('hex'),suffix,expected:meta?.result_reference,execution:meta?.execution,recheckBytes:Buffer.byteLength(presentDelivery(text,meta))},null,2));
}
