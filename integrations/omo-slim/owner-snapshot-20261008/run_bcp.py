"""Actual v1 foreground/background/revival handoffs with current-input identity."""
import hashlib
import json
import os
import sys
import time
from pathlib import Path
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT.parent/'upstream-defaults-20261006/effective-probe'))
import probe as P
import probe_router as R
import behaviors as B
from case_collab import read_bcp_records

revision=os.environ.get('OMO_REVISION','')
pin=json.loads((ROOT/('proof/CANDIDATE'+revision+'.json')).read_text())
candidate=Path(pin['candidateDir'])
assert P.sha256_file(candidate/'.oprofile/profile-manifest.json')==pin['manifestSha256']
case=Path('/tmp/opencode')/('omo303-bcp-'+time.strftime('%Y%m%dT%H%M%S',time.gmtime()))
paths=P.CasePaths.layout(case)
art=case/'artifacts'
def save(name,obj): (art/name).write_text(json.dumps(obj,indent=2,ensure_ascii=False))
copy=P.copy_candidate(candidate,paths.config_dir)
assert not copy['mismatches']
save('CANDIDATE-COPY.json',copy)
ids={}
receipts=[]
turns=[]
checks=[]
def check(name,ok,detail=None):
    checks.append({'name':name,'pass':bool(ok),'detail':detail})
    save('CHECKS.json',checks)
def route(body):
    messages=body.get('messages',[])
    texts=[(i,R._text(m.get('content',''))) for i,m in enumerate(messages) if m.get('role')=='user']
    parent=[(i,t) for i,t in texts if t.startswith('BCP303_PARENT_')]
    if not parent:
        child=[t for _,t in texts if 'BCP303_CHILD_' in t]
        if not child:return {'role':'assistant','content':'Auxiliary fixture request.'}
        return {'role':'assistant','content':B.original_body(2 if 'BCP303_CHILD_B' in child[-1] else 1)}
    boundary,tag=parent[-1]
    tag=tag.split()[0].removeprefix('BCP303_PARENT_')
    parts=[r for r in B.tool_results(messages) if r['index']>boundary]
    if not parts:
        if tag=='FG_FIRST':tool,args='task',{'subagent_type':'fixer','description':'Foreground first','prompt':'BCP303_CHILD_A'}
        elif tag=='FG_RESUME':tool,args='task',{'subagent_type':'fixer','description':'Foreground resume','prompt':'BCP303_CHILD_B','task_id':ids['fg']}
        elif tag=='BG_FIRST':tool,args='task',{'subagent_type':'fixer','description':'Background first','prompt':'BCP303_CHILD_A','background':True}
        elif tag=='BG_REVIVE':tool,args='task_revive',{'task_id':ids['bg'],'prompt':'BCP303_CHILD_B'}
        elif tag in ('BG_RESULT1','BG_RESULT2'):tool,args='task_result',{'task_id':ids['bg']}
        else:raise AssertionError(tag)
        return {'role':'assistant','content':'','tool_calls':[R._call(tool,args)]}
    if tag in ('BG_FIRST','BG_REVIVE'):
        return {'role':'assistant','content':tag+' admission received.'}
    if len(parts)==1:
        ref=B.extract_receipt_record_id(str(parts[0]['content']))
        if not ref:return {'role':'assistant','content':'FIXTURE-FAIL missing retained reference: '+str(parts[0]['content'])}
        return {'role':'assistant','content':'','tool_calls':[R._call('board_get',{'ids':[ref]})]}
    return {'role':'assistant','content':tag+' retained original read.'}

R.route=route
fixture=P.ProbeProvider(route,output_dir=art/'provider',model_ids=P.NEWAPI_MODELS+P.OPENAI_MODELS)
fixture.MAX_REQUESTS=80
with fixture:
    overlay=P.build_overlay(P.V1,fixture.base_url);overlay.pop('permission',None)
    original=json.loads((paths.config_dir/'opencode.json').read_text())
    overlay['mcp']={name:{'enabled':False} for name in original.get('mcp',{})}
    for name in original.get('provider',{}):overlay['provider'].setdefault(name,overlay['provider']['newapi'])
    P.apply_overlay_to_copy(paths.config_dir,overlay,art)
    env=paths.env_plan();env.update({'BILLION_CONTEXT_PLUGIN':'0','BILI_NATIVE_OPENCODE':'0','BILI_PROVIDER_REWRITES':'0','OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS':'true'})
    spec=P.HostSpec(host=P.V1,cli=Path(pin['hostExecutable']),bundle=ROOT,case=paths,ready_seconds=120,deadline_seconds=360,max_calls=10000,safety_module=P.COLLAB.parent/'probe_safety.py')
    with P.HostSession(spec,env) as host:
        client=P.V1Client(host,spec.max_calls,spec.deadline_seconds)
        parent=client.create_session('OMO303 BCP handoffs')
        def turn(tag):
            before={p['id'] for p in client.tool_parts(client.messages(parent))}
            client.prompt_async(parent,'orchestrator','BCP303_PARENT_'+tag+' Execute the bounded scripted handoff and stop.')
            client.wait_idle([parent])
            messages=client.messages(parent);save(parent+'.messages.json',messages)
            parts=[p for p in client.tool_parts(messages) if p['id'] not in before]
            turns.append({'tag':tag,'parts':parts});save('TURNS.json',turns)
            check('tools-completed/'+tag,bool(parts) and all(p.get('state',{}).get('status')=='completed' for p in parts))
            return parts
        first=turn('FG_FIRST')
        output=next(p['state']['output'] for p in first if p['tool']=='task')
        ids['fg']=B.extract_receipt_child_id(output,'v1');assert ids['fg'],output
        turn('FG_RESUME')
        background=turn('BG_FIRST')
        output=next(p['state']['output'] for p in background if p['tool']=='task')
        ids['bg']=B.extract_receipt_child_id(output,'v1');assert ids['bg'],output
        def wait_child(round):
            deadline=time.monotonic()+60
            while time.monotonic()<deadline:
                messages=client.messages(ids['bg']);save(ids['bg']+'.messages.json',messages)
                user=[m for m in messages if m.get('info',{}).get('role')=='user' and 'BCP303_CHILD_' in client.text(m)]
                final=client.final_assistant(messages)
                if len(user)>=round and final and final['info'].get('parentID')==user[-1]['info']['id'] and (client.status().get(ids['bg']) or {}).get('type','idle')=='idle':return
                time.sleep(0.5)
            raise TimeoutError('background round '+str(round))
        wait_child(1);turn('BG_RESULT1')
        turn('BG_REVIVE');wait_child(2);turn('BG_RESULT2')
        records=read_bcp_records(case)
        save('RECORDS.json',records)
        expected_inputs={}
        for lane,sid in ids.items():
            messages=client.messages(sid);save(sid+'.messages.json',messages)
            users=[m for m in messages if m.get('info',{}).get('role')=='user' and 'BCP303_CHILD_' in client.text(m)]
            check('same-child-two-inputs/'+lane,len(users)==2,{'session':sid,'userIDs':[m['info']['id'] for m in users]})
            expected_inputs[lane]=[m['info']['id'] for m in users]
            for index,user in enumerate(users,1):
                match=[r for r in records if r.get('writer',{}).get('session_id')==sid and r.get('content')==B.original_body(index)]
                check('record-identity/'+lane+'/'+str(index),len(match)==1 and match[0]['writer']['agent']=='fixer' and match[0].get('origin',{}).get('input_message_id')==user['info']['id'],{'recordIDs':[r.get('id') for r in match],'inputID':user['info']['id']})
        for t in turns:
            if t['tag'] in ('BG_FIRST','BG_REVIVE'):continue
            result=next(p for p in t['parts'] if p['tool'] in ('task','task_result'))
            receipt=result['state']['output']
            ref=B.extract_receipt_record_id(receipt)
            lookup=next((p for p in t['parts'] if p['tool']=='board_get'),None)
            index=2 if t['tag'] in ('FG_RESUME','BG_RESULT2') else 1
            check('compact-receipt/'+t['tag'],bool(ref) and len(receipt.encode())<4096 and B.original_body(index) not in receipt,{'reference':ref,'bytes':len(receipt.encode())})
            fetched=[]
            if lookup:
                try:fetched=json.JSONDecoder().raw_decode(lookup['state']['output'].lstrip())[0]
                except (ValueError,TypeError):pass
            check('board-get-original/'+t['tag'],any(r.get('status')=='found' and r.get('record',{}).get('content')==B.original_body(index) for r in fetched))
            lane='fg' if t['tag'].startswith('FG_') else 'bg'
            check('receipt-current-owner/'+t['tag'],any(r.get('status')=='found' and r.get('record',{}).get('writer',{}).get('session_id')==ids[lane] and r.get('record',{}).get('origin',{}).get('input_message_id')==expected_inputs[lane][index-1] for r in fetched))
            receipts.append({'tag':t['tag'],'reference':ref,'receipt':receipt})
        check('new-current-reference/foreground',receipts[0]['reference']!=receipts[1]['reference'])
        check('new-current-reference/background',receipts[2]['reference']!=receipts[3]['reference'])
        check('no-pending-prompts',not any(client.pending().values()))
        save('HEALTH.json',{'fdAudit':host.fd_audit,'requests':len(fixture.requests),'realModelRequests':0})
result={'case':str(case),'candidateManifest':pin['manifestSha256'],'passed':all(c['pass'] for c in checks),'checks':checks,'receipts':receipts,'limits':['Scripted local provider, not model intelligence.','Compression proxy disabled; BCP retention and delivery plugins remain active. No full compaction/recovery proof.']}
save('RESULT.json',result)
with (ROOT/('proof/HOST-BCP'+revision+'.json')).open('x') as f:json.dump(result,f,indent=2)
print(json.dumps({'case':str(case),'passed':result['passed'],'checks':len(checks),'failures':[c for c in checks if not c['pass']]},indent=2))
sys.exit(0 if result['passed'] else 2)
