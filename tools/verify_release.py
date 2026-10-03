#!/usr/bin/env python3
"""Explicit release acceptance only; never called by normal preparation Hooks."""
import argparse,datetime,hashlib,json,os,platform,subprocess,sys,time
from pathlib import Path
BUNDLE=Path(__file__).resolve().parents[1]

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--all',action='store_true');p.add_argument('--out',type=Path,required=True)
    a=p.parse_args();out=a.out.expanduser().absolute()
    if out.exists():raise SystemExit('Output exists; choose a new log directory')
    out.mkdir(parents=True)
    suites=[('040', ['-m','unittest','discover','-s','tests040','-p','test_*040.py','-v'])]
    if a.all:
        suites += [('engine',['-m','unittest','discover','-s','engine/tests','-v']),
                   ('integration',['-m','unittest','discover','-s','tests','-v']),
                   ('root',['-m','unittest','test_run_loop','-v']),
                   ('adapter',['-m','unittest','discover','-s','adapters','-p','test_*.py','-v'])]
    report={'version':'0.4.0','python':sys.version,'platform':platform.platform(),
            'real_models_called':False,'created_at':datetime.datetime.now(datetime.timezone.utc).isoformat(), 'suites':[]}
    for name,args in suites:
        begin=time.monotonic();path=out/(name+'.log');command=[sys.executable,*args]
        with path.open('w') as f:
            try:
                done=subprocess.run(command,cwd=BUNDLE,stdout=f,stderr=subprocess.STDOUT,timeout=1800,
                                    env={**os.environ,'LOOP_NO_NOTIFY':'1','PYTHONDONTWRITEBYTECODE':'1','PYTHONPATH':str(BUNDLE/'tests040')})
                code=done.returncode
            except subprocess.TimeoutExpired:code=124
        record={'name':name,'command':command,'exit_code':code,'seconds':round(time.monotonic()-begin,3),'log':str(path),
                'sha256':hashlib.sha256(path.read_bytes()).hexdigest()};report['suites'].append(record);print(json.dumps(record),flush=True)
    (out/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    return 0 if all(x['exit_code']==0 for x in report['suites']) else 1
if __name__=='__main__':raise SystemExit(main())
