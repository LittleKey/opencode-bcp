"""Correct the mock-factory expectation using the pinned native role source.

No host rerun. Preserve the original failed checks and captured requests.
"""
import hashlib
import json
import sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT.parent/'upstream-defaults-20261006/effective-probe'))
import probe_router as R
original=json.loads((ROOT/'proof/HOST-ROLES.json').read_text())
pin=json.loads((ROOT/'proof/CANDIDATE.json').read_text())
candidate=Path(pin['candidateDir'])
assert hashlib.sha256((candidate/'.oprofile/profile-manifest.json').read_bytes()).hexdigest()==pin['manifestSha256']
art=Path(original['case'])/'artifacts'
registry=json.loads((art/'REGISTRY.json').read_text())
actual=next(a for a in registry if a['name']=='lark-operator')
expected=(candidate/'agents/lark-operator.md').read_text().split('---',2)[2].strip()
assert actual['prompt']==expected, {'actual':hashlib.sha256(actual['prompt'].encode()).hexdigest(),'expected':hashlib.sha256(expected.encode()).hexdigest(),'actualLength':len(actual['prompt']),'expectedLength':len(expected)}
assert actual['mode']=='all'
requests=[data.get('body',data) for data in json.loads((art/'provider/requests.json').read_text())]
if not requests:
    raise AssertionError('no retained provider requests')
checks=[]
for check in original['checks']:
    fixed=dict(check)
    if check['name']=='registry-prompt/lark-operator':
        fixed.update({'pass':True,'detail':{'source':'agents/lark-operator.md native explicit role, ahead of the generic OMO factory fallback','sha256':hashlib.sha256(expected.encode()).hexdigest(),'mode':actual['mode']}})
    elif check['name'].startswith('provider-prompt/OMO303-lark-operator'):
        marker=check['name'].split('/',1)[1]
        matching=[r for r in requests if any(marker in R._text(m.get('content','')) for m in r.get('messages',[]) if m.get('role')=='user')]
        assert matching,marker
        fixed['pass']=all(expected in '\n'.join(R._text(m.get('content','')) for m in r['messages'] if m.get('role')=='system') for r in matching)
        fixed['detail']={'source':'pinned native agent file','captures':len(matching),'expectedSha256':hashlib.sha256(expected.encode()).hexdigest()}
    checks.append(fixed)
result={**original,'checks':checks,'passed':all(c['pass'] for c in checks),'correction':'The extracted OMO createAgents mock omitted the v1 native agents/lark-operator.md overlay. Actual registry and existing provider captures are checked against that pinned source; no candidate, host or captured evidence changed.','originalReportSha256':hashlib.sha256((ROOT/'proof/HOST-ROLES.json').read_bytes()).hexdigest()}
with (ROOT/'proof/HOST-ROLES-VERIFIED.json').open('x') as f:json.dump(result,f,indent=2)
print(json.dumps({'checks':len(checks),'passed':result['passed'],'failures':[c for c in checks if not c['pass']]},indent=2))
sys.exit(0 if result['passed'] else 2)
