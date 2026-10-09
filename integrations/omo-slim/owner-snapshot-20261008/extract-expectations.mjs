import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const root=import.meta.dirname;
let script=readFileSync('/home/littlekey/github/opencode-bcp/.slim/deepwork/upstream-defaults-20261006/effective-probe/extract_expected.mjs','utf8');
function replace(from,to){assert.equal(script.split(from).length,2,from);script=script.replace(from,to);}
replace('"COUNCIL_SYNTHESIS_REINFORCEMENT", "COUNCIL_COMPACTION_EXCEPTION",','"COUNCIL_SYNTHESIS_POINTER", "COUNCIL_SYNTHESIS_FALLBACK", "COUNCIL_COMPACTION_EXCEPTION",');
replace('"PROMPTS_DIR_NAME", "TASK_CONTROL_TOOL_NAMES", "MARKETPLACE_TOOL_NAMES2",','"PROMPTS_DIR_NAME", "ORCHESTRATOR_DEFAULT_TOOL_NAMES", "MARKETPLACE_TOOL_NAMES2",');
replace('"ensureCouncilCompactionException", "appendTaskRejectionInstruction", "resolvePrompt",','"ensureCouncilCompactionException", "ensureCouncilSynthesisReinforcement", "appendTaskRejectionInstruction", "resolvePrompt",');
replace('"getPrimaryModelFromOverride", "loadAgentPrompt", "getConfigSearchDirs",','"getPrimaryModelFromOverride", "loadAgentPrompt", "getConfigSearchDirs", "getProjectConfigDirectories", "isProjectConfigDisabled",');
replace('.filter((n) => !(missingVars.has(n) && missingFns.has(n)));','.filter((n) => findDeclaration(n, "var") || findDeclaration(n, "function"));');
replace('  disabledAgents,\n  disabledSkills: [],','  disabledAgents,\n  disabledHooks: new Set(pluginConfig.disabled_hooks ?? []),\n  disabledSkills: [],');
// Actual upstream merge precedence is checked later against the real host registry;
// this extraction supplies expected role bodies, not runtime acceptance itself.
const path=join(root,'proof/extractor-3.0.3.mjs');writeFileSync(path,script);
const candidate=JSON.parse(readFileSync(join(root,'proof/CANDIDATE.json'))).candidateDir;
execFileSync(process.execPath,[path,join(root,'artifact/omoPlugin/index/dist/index.js'),candidate,join(root,'proof/expected-v1.json'),'v1'],{stdio:'inherit'});
