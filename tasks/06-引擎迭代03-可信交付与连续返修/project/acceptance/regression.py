"""Frozen regression entry: run candidate code, require real test discovery."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / 'engine'


def main():
    if len(sys.argv) == 4 and sys.argv[1] == '--suite':
        directory, minimum = sys.argv[2], int(sys.argv[3])
        if directory == 'engine/tests':
            sys.path.insert(0, str(ENGINE))
        else:
            sys.path.insert(0, str(ROOT))
        suite = unittest.defaultTestLoader.discover(str(ROOT / directory), pattern='test_*.py')
        count = suite.countTestCases()
        if count < minimum:
            raise SystemExit(f'发现 {count} 项测试，少于冻结下限 {minimum}')
        result = unittest.TextTestRunner(verbosity=1).run(suite)
        return 0 if result.wasSuccessful() else 1
    failures=[]
    frozen=json.loads((ROOT/'acceptance/protected.json').read_text())
    for name, expected in frozen.items():
        p=ROOT/name
        if not p.is_file() or p.is_symlink() or hashlib.sha256(p.read_bytes()).hexdigest()!=expected:
            failures.append('受保护文件变化：'+name)
    if failures:
        print('\n'.join(failures));return 1
    env=dict(os.environ,PYTHONDONTWRITEBYTECODE='1',LOOP_NO_NOTIFY='1')
    suites=[('engine/tests',156),('adapters',1),('.',4)]
    if (ROOT/'tests').is_dir():suites.append(('tests',1))
    for directory, minimum in suites:
        result=subprocess.run([sys.executable,__file__,'--suite',directory,str(minimum)],cwd=ROOT,env=env)
        if result.returncode:return result.returncode
    for name in ['check_u1.py','check_u2.py','check_u3.py','check_u4.py']:
        result=subprocess.run([sys.executable,str(ENGINE/'acceptance'/name)],cwd=ENGINE,env=env)
        if result.returncode:return result.returncode
    return 0


if __name__=='__main__':
    raise SystemExit(main())
