"""Actual v1 host, immutable candidate copy, scripted loopback provider."""
import hashlib
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EFF = ROOT.parent / 'upstream-defaults-20261006/effective-probe'
sys.path.insert(0, str(EFF))
import probe as P
import probe_router as R

revision=os.environ.get('OMO_REVISION','')
pin = json.loads((ROOT / ('proof/CANDIDATE'+revision+'.json')).read_text())
candidate = Path(pin['candidateDir'])
expected = json.loads((ROOT / 'proof/expected-v1.json').read_text())['agentConfigs']
expected['lark-operator']['prompt']=(candidate/'agents/lark-operator.md').read_text().split('---',2)[2].strip()
assert P.sha256_file(candidate / '.oprofile/profile-manifest.json') == pin['manifestSha256']
case = Path('/tmp/opencode') / ('omo303-roles-' + time.strftime('%Y%m%dT%H%M%S', time.gmtime()))
paths = P.CasePaths.layout(case)
art = case / 'artifacts'
def save(name, data):
    (art / name).write_text(json.dumps(data, indent=2, ensure_ascii=False))
copy = P.copy_candidate(candidate, paths.config_dir)
assert not copy['mismatches']
save('CANDIDATE-COPY.json', copy)
checks = []
def check(name, ok, detail=None):
    checks.append({'name': name, 'pass': bool(ok), 'detail': detail})
    save('CHECKS.json', checks)

# Each direct session has one unique user marker. Retries route from actual
# conversation tool results, not provider request counts.
scenarios = {}
def route(body):
    users = [R._text(m.get('content', '')) for m in body.get('messages', []) if m.get('role') == 'user']
    marker = next((s for s in scenarios if any(s in u for u in users)), None)
    if marker is None:
        return {'role': 'assistant', 'content': 'Unrelated host auxiliary request.'}
    spec = scenarios[marker]
    if not spec.get('tool'):
        return {'role': 'assistant', 'content': marker + ' captured.'}
    if any(m.get('role') == 'tool' for m in body.get('messages', [])):
        return {'role': 'assistant', 'content': marker + ' tool attempt completed.'}
    return {'role': 'assistant', 'content': '', 'tool_calls': [R._call(spec['tool'], spec['args'])]}

R.route = route
fixture = P.ProbeProvider(route, output_dir=art / 'provider', model_ids=P.NEWAPI_MODELS + P.OPENAI_MODELS)
fixture.MAX_REQUESTS = 100
with fixture:
    overlay = P.build_overlay(P.V1, fixture.base_url)
    overlay.pop('permission', None)
    original = json.loads((paths.config_dir / 'opencode.json').read_text())
    # Only the local fixture may receive model requests. External MCPs are
    # disabled for the probe, without changing native role permissions.
    overlay['mcp'] = {name: {'enabled': False} for name in original.get('mcp', {})}
    for name in original.get('provider', {}):
        overlay['provider'].setdefault(name, overlay['provider']['newapi'])
    P.apply_overlay_to_copy(paths.config_dir, overlay, art)
    P.write_toy_skills(paths.work)
    env = paths.env_plan()
    env.update({'BILLION_CONTEXT_PLUGIN': '0', 'BILI_NATIVE_OPENCODE': '0', 'BILI_PROVIDER_REWRITES': '0'})
    spec = P.HostSpec(host=P.V1, cli=Path(pin['hostExecutable']), bundle=ROOT, case=paths,
                      ready_seconds=120, deadline_seconds=420, max_calls=10000,
                      safety_module=P.COLLAB.parent / 'probe_safety.py')
    with P.HostSession(spec, env) as host:
        client = P.V1Client(host, spec.max_calls, spec.deadline_seconds)
        registry = client.get('/agent')
        save('REGISTRY.json', registry)
        agents = {a['name']: a for a in registry}
        check('native-custom-mode/lark-operator',agents.get('lark-operator',{}).get('mode')=='all')
        roles = ['orchestrator', 'explorer', 'librarian', 'oracle', 'designer', 'fixer', 'observer', 'document-writer', 'lark-operator']
        for role in roles:
            actual = agents.get(role, {})
            want = expected[role]
            check('registry-prompt/' + role, actual.get('prompt') == want['prompt'],
                  {'actualSha': hashlib.sha256(actual.get('prompt', '').encode()).hexdigest(), 'expectedSha': hashlib.sha256(want['prompt'].encode()).hexdigest()})
            model = actual.get('model', {})
            actual_model = f"{model.get('providerID')}/{model.get('modelID')}" if isinstance(model, dict) else model
            check('registry-model/' + role, actual_model == want['model'] and actual.get('variant') == want.get('variant'),
                  {'actual': actual_model, 'expected': want['model'], 'variant': actual.get('variant')})
        def run(role, tool=None, args=None, label=None):
            marker = 'OMO303-' + (label or role) + '-' + str(len(scenarios))
            scenarios[marker] = {'tool': tool, 'args': args}
            sid = client.create_session(marker)
            start = len(fixture.requests)
            client.prompt_async(sid, role, marker + ' Execute the scripted verification action once, then stop.')
            deadline = time.monotonic() + 35
            asks = []
            while True:
                messages = client.messages(sid)
                pending = client.pending()
                for ask in pending['permissions']:
                    if ask.get('sessionID') == sid:
                        # Only the explicit parent write control may be approved.
                        reply = 'once' if label == 'parent-write' else 'reject'
                        client.post('/permission/' + ask['id'] + '/reply', {'reply': reply})
                        asks.append({'request': ask, 'reply': reply})
                if client.final_assistant(messages) and (client.status().get(sid) or {}).get('type', 'idle') == 'idle':
                    break
                if time.monotonic() > deadline:
                    save(sid + '.messages.json', messages)
                    raise TimeoutError(marker)
                time.sleep(0.4)
            save(sid + '.messages.json', messages)
            save(sid + '.permissions.json', asks)
            requests = [r['body'] for r in fixture.requests[start:] if any(marker in R._text(m.get('content', '')) for m in r['body'].get('messages', []))]
            check('provider-prompt/' + marker, bool(requests) and expected[role]['prompt'] in '\n'.join(R._text(m.get('content', '')) for m in requests[0]['messages'] if m.get('role') == 'system'))
            return messages, requests, asks
        for role in roles:
            run(role)
        for role in ['explorer', 'librarian', 'oracle', 'observer']:
            for tool in ['write', 'edit']:
                file = paths.work / (role + '-' + tool + '.txt')
                if tool == 'edit':
                    file.write_text('original')
                args = {'filePath': str(file), 'content': 'unexpected write'} if tool == 'write' else {'filePath': str(file), 'oldString': 'original', 'newString': 'unexpected edit'}
                messages, requests, asks = run(role, tool, args, role + '-' + tool)
                tools = {t['function']['name'] for t in requests[0].get('tools', [])} if requests else set()
                errors = json.dumps(P.V1Client.tool_parts(messages))
                unchanged = not file.exists() if tool == 'write' else file.read_text() == 'original'
                check('denial/' + role + '/' + tool, tool not in tools and 'unavailable tool' in errors and unchanged and not asks, {'unadvertised': tool not in tools, 'fileUnchanged': unchanged, 'permissionAsks': len(asks)})
        control = paths.work / 'parent-control.txt'
        run('orchestrator', 'write', {'filePath': str(control), 'content': 'parent write allowed'}, 'parent-write')
        check('parent-write-control', control.exists() and control.read_text() == 'parent write allowed')
        for role, skill, allowed in [('orchestrator', 'clonedeps', True), ('orchestrator', 'deepwork', True), ('orchestrator', 'executing-plans', True), ('orchestrator', 'lark-doc', False), ('document-writer', 'lark-doc', True), ('lark-operator', 'lark-doc', True)]:
            messages, requests, asks = run(role, 'skill', {'name': skill}, role + '-skill-' + skill)
            parts = P.V1Client.tool_parts(messages)
            output = '\n'.join(str(p.get('state', {}).get('output', '')) for p in parts if p.get('tool') == 'skill')
            if allowed:
                path = candidate / 'skills' / skill / 'SKILL.md'
                expected_body = path.read_text().split('---', 2)[-1].strip() if path.exists() else 'TOY-LARK-DOC-BODY-7712'
                check('skill/' + role + '/' + skill, expected_body in output, {'bodySha': hashlib.sha256(expected_body.encode()).hexdigest(), 'permissionAsks': len(asks)})
            else:
                check('skill-denial/' + role + '/' + skill, 'TOY-LARK-DOC-BODY-7712' not in output and any(p.get('state', {}).get('status') == 'error' for p in parts) and not asks)
        save('HEALTH.json', {'fdAudit': host.fd_audit, 'requests': len(fixture.requests), 'realModelRequests': 0})
result = {'candidateManifest': pin['manifestSha256'], 'case': str(case), 'checks': checks, 'passed': all(c['pass'] for c in checks),
          'limits': ['Loopback scripted provider; no model intelligence evaluated.', 'Compression proxy disabled for deterministic routing; full compaction recovery not exercised.', 'External MCPs disabled; no Lark service call.']}
save('RESULT.json', result)
with (ROOT / ('proof/HOST-ROLES'+revision+'.json')).open('x') as f:json.dump(result,f,indent=2)
print(json.dumps({'case': str(case), 'checks': len(checks), 'passed': result['passed'], 'failures': [c for c in checks if not c['pass']]}, indent=2))
sys.exit(0 if result['passed'] else 2)
