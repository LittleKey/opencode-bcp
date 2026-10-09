"""Reuse the accepted behavior probes, adding explicit actual-process version evidence."""
import hashlib
import json
import os
import runpy
import sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent
pin=json.loads((ROOT/'proof/CANDIDATE-host11835.json').read_text())
inputs=json.loads((ROOT/'proof/host-1.18.35/INPUTS.json').read_text())
kind=sys.argv[1]
assert kind in ('roles','bcp')
script=ROOT/('run_'+kind+'.py')
assert hashlib.sha256(script.read_bytes()).hexdigest()==inputs['sources'][script.name]
sys.path.insert(0,str(ROOT.parent/'upstream-defaults-20261006/effective-probe'))
import probe as P
class BoundHost(P.HostSession):
    def __enter__(self):
        super().__enter__()
        try:
            health=self.request('GET','/global/health')
            assert health['healthy'] is True and health['version']==pin['hostVersion'],health
            executable=os.readlink('/proc/'+str(self.proc.pid)+'/exe')
            assert executable==pin['hostExecutable'],executable
            digest=P.sha256_file(Path(executable))
            assert digest==pin['hostExecutableSha256']
            with (self.spec.case.case/'artifacts/HOST-BINDING.json').open('x') as f:
                json.dump({'pid':self.proc.pid,'version':health['version'],'executable':executable,'executableSha256':digest},f,indent=2)
            return self
        except BaseException:
            self.stop()
            raise
P.HostSession=BoundHost
os.environ['OMO_REVISION']='-host11835'
runpy.run_path(str(script),run_name='__main__')
