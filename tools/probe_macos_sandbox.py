#!/usr/bin/env python3
"""Explicit local installation probe; no Pi, model, project edits or remote network."""
import json,os,subprocess,sys,tempfile
from pathlib import Path
BUNDLE=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(BUNDLE/'engine'))
from loop_engineering.execution import sandbox_command

def main():
    if sys.platform!='darwin' or not Path('/usr/bin/sandbox-exec').is_file():
        print(json.dumps({'status':'NOT_RUN','reason':'requires macOS sandbox-exec','real_model_calls':0}));return 3
    with tempfile.TemporaryDirectory(prefix='loop-sandbox-probe-') as t:
        # Non-ASCII + space: real data roots often live under Chinese folder names.
        root=Path(t).resolve();allowed=root/'允许 写入';allowed.mkdir();outside=root/'protected.txt';outside.write_text('keep')
        (allowed/'link').symlink_to(outside)
        script=root/'probe.py';script.write_text('''from pathlib import Path
import json,sys
ok={}
Path(sys.argv[1],"new.txt").write_text("permitted")
ok["allowed_write"]=True
for name,path in (("outside_denied",sys.argv[2]),("symlink_denied",str(Path(sys.argv[1],"link")))):
    try: Path(path).write_text("bad");ok[name]=False
    except OSError:ok[name]=True
print(json.dumps(ok))
''')
        argv=sandbox_command([sys.executable,str(script),str(allowed),str(outside)],[allowed],network=False,mode='strict')
        cp=subprocess.run(argv,capture_output=True,text=True,timeout=10,env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1'})
        result={'status':'FAIL','exit_code':cp.returncode,'stdout':cp.stdout,'stderr':cp.stderr,'real_model_calls':0,
                'coverage':'Python child allowed write (non-ASCII path with space)/outside write/symlink write only; no Pi/Java/network/authentication proof'}
        if cp.returncode==0:
            values=json.loads(cp.stdout)
            if all(values.get(k) is True for k in ('allowed_write','outside_denied','symlink_denied')) and outside.read_text()=='keep':result['status']='PASS'
        print(json.dumps(result,ensure_ascii=False,indent=2));return 0 if result['status']=='PASS' else 1
if __name__=='__main__':raise SystemExit(main())
