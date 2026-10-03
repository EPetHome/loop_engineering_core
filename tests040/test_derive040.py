"""D1 regressions for the derive command: one case per numbered acceptance behavior.

Only the public CLI and the public prep API are used; no model is called and nothing is
registered for the user beyond the test's own temporary state.
"""
import json,os,shlex,stat,subprocess,sys,tempfile,unittest
from pathlib import Path
from helpers import BUNDLE,prep,project
from loop_engineering.common import LoopError
from loop_engineering.ledger import Ledger


def guard(state,*args):
    env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1','LOOP_NO_NOTIFY':'1'}
    return subprocess.run([sys.executable,'-B',str(BUNDLE/'loop_guard.py'),'--state',str(state),*map(str,args)],
                          capture_output=True,text=True,cwd=BUNDLE,env=env,timeout=120)


def stdout_json(done):
    start=done.stdout.find('{')
    return json.loads(done.stdout[start:]) if start>=0 else {}


def chmod_tree(root,dir_mode,file_mode):
    for path in root.rglob('*'):
        path.chmod(dir_mode if path.is_dir() else file_mode)
    root.chmod(dir_mode)


def writable_all(root):
    return all(path.stat().st_mode & stat.S_IWUSR for path in [root,*root.rglob('*')])


class Derive(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory();self.addCleanup(self.t.cleanup)
        self.base=Path(self.t.name).resolve()
        self.raw=project(self.base)
        self.state,self.root=self.base/'state',self.base/'data'
        prep.register_project(self.state,'old',self.raw,self.base,self.root)
        self.registered=Ledger(self.state).get('project','old')['rules']

    # 1. 不带 --source/--copy-source：计划等于上一轮登记规则，输出含 plan 与 next_commands
    def test_1_verbatim_copy_matches_registered_rules_and_reports_commands(self):
        out=self.base/'p1.json'
        done=guard(self.state,'derive','old','--project-id','new1','--out',out)
        self.assertEqual(done.returncode,0,done.stderr)
        self.assertEqual(json.loads(out.read_text()),self.registered)
        body=stdout_json(done)
        self.assertEqual(body['plan'],str(out))
        self.assertEqual(len(body['next_commands']),2)
        self.assertIn(' register ',body['next_commands'][0])
        self.assertIn(' begin ',body['next_commands'][1])
        self.assertIn('new1',body['next_commands'][0]);self.assertIn('new1',body['next_commands'][1])
        self.assertIn(str(self.root),body['next_commands'][0])
        self.assertEqual(body['source'],self.registered['source'])

    # 2. --source 只改 source，新计划能直接登记
    def test_2_source_replacement_changes_only_source_and_registers(self):
        src2=self.base/'src2';src2.mkdir()
        (src2/'build.py').write_text((Path(self.raw['source'])/'build.py').read_text())
        out=self.base/'p2.json'
        done=guard(self.state,'derive','old','--project-id','new2','--out',out,'--source',src2)
        self.assertEqual(done.returncode,0,done.stderr)
        plan=json.loads(out.read_text())
        self.assertEqual(plan['source'],str(src2.resolve()))
        self.assertEqual({k:v for k,v in plan.items() if k!='source'},
                         {k:v for k,v in self.registered.items() if k!='source'})
        body=stdout_json(done)
        command=shlex.split(body['next_commands'][0])
        done=subprocess.run(command,capture_output=True,text=True,cwd=BUNDLE,
                            env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1','LOOP_NO_NOTIFY':'1'},timeout=120)
        self.assertEqual(done.returncode,0,done.stderr)
        self.assertEqual(Ledger(self.state).get('project','new2')['rules']['source'],str(src2.resolve()))

    # 3. --copy-source 复制出内容一致且可写的源码并让 source 指向它（原源码只读时也一样）
    def test_3_copy_source_is_identical_and_writable_after_readonly_original(self):
        src=Path(self.raw['source'])
        chmod_tree(src,0o555,0o444)
        self.addCleanup(chmod_tree,src,0o755,0o644)
        dest=self.base/'copy3'
        done=guard(self.state,'derive','old','--project-id','new3','--out',self.base/'p3.json','--copy-source',dest)
        self.assertEqual(done.returncode,0,done.stderr)
        plan=json.loads((self.base/'p3.json').read_text())
        self.assertEqual(plan['source'],str(dest.resolve()))
        self.assertEqual(sorted(p.relative_to(dest).as_posix() for p in dest.rglob('*')),
                         sorted(p.relative_to(src).as_posix() for p in src.rglob('*')))
        for path in src.rglob('*'):
            if path.is_file():
                self.assertEqual((dest/path.relative_to(src)).read_bytes(),path.read_bytes())
        self.assertTrue(writable_all(dest))
        done=guard(self.state,'register','new3',self.base/'p3.json','--root',self.root,'--no-verify')
        self.assertEqual(done.returncode,0,done.stderr)
        self.assertEqual(Ledger(self.state).get('project','new3')['rules']['source'],str(dest.resolve()))

    def test_3_copy_source_uses_explicit_source_when_both_options_given(self):
        src2=self.base/'src2b';src2.mkdir();(src2/'marker.txt').write_text('from-src2')
        dest=self.base/'copy3b'
        done=guard(self.state,'derive','old','--project-id','new3b','--out',self.base/'p3b.json',
                   '--source',src2,'--copy-source',dest)
        self.assertEqual(done.returncode,0,done.stderr)
        self.assertEqual(json.loads((self.base/'p3b.json').read_text())['source'],str(dest.resolve()))
        self.assertEqual((dest/'marker.txt').read_text(),'from-src2')
        self.assertTrue(writable_all(dest))

    def test_3_nested_copy_target_refused_by_api(self):
        src=Path(self.raw['source'])
        with self.assertRaises(LoopError):
            prep.derive_plan(self.state,'old','nested',self.base/'nested.json',copy_source=src/'inner')
        with self.assertRaises(LoopError):
            prep.derive_plan(self.state,'old','nested',self.base/'nested.json',copy_source=src)
        self.assertFalse((self.base/'nested.json').exists());self.assertFalse((src/'inner').exists())

    # 4. 不覆盖已有计划文件或已有目录
    def test_4_never_overwrites_existing_plan_file_or_copy_directory(self):
        plan=self.base/'p4.json';plan.write_text('{"keep":1}')
        done=guard(self.state,'derive','old','--project-id','new4','--out',plan)
        self.assertNotEqual(done.returncode,0)
        self.assertEqual(plan.read_text(),'{"keep":1}')
        self.assertFalse((self.base/'copy4').exists())
        dest=self.base/'copy4';dest.mkdir();(dest/'sentinel.txt').write_text('s')
        out=self.base/'p4b.json'
        done=guard(self.state,'derive','old','--project-id','new4b','--out',out,'--copy-source',dest)
        self.assertNotEqual(done.returncode,0)
        self.assertFalse(out.exists())
        self.assertEqual((dest/'sentinel.txt').read_text(),'s')

    # 5. 上一轮项目不存在时报错且不生成文件
    def test_5_unknown_previous_project_errors_without_writing(self):
        out=self.base/'p5.json'
        done=guard(self.state,'derive','nope','--project-id','new5','--out',out)
        self.assertNotEqual(done.returncode,0)
        self.assertFalse(out.exists())
        self.assertIn('nope',done.stderr)

    # 6. 新项目编号非法时报错
    def test_6_invalid_new_project_id_errors_without_writing(self):
        for index,bad in enumerate(('bad id!','../escape','')):
            out=self.base/('p6-%d.json'%index)
            done=guard(self.state,'derive','old','--project-id',bad,'--out',out)
            self.assertNotEqual(done.returncode,0,'bad id: '+repr(bad))
            self.assertFalse(out.exists(),bad)

    # 7. --source 目录不存在时报错
    def test_7_missing_source_directory_errors_without_writing(self):
        missing=self.base/'missing'
        out=self.base/'p7.json'
        done=guard(self.state,'derive','old','--project-id','new7','--out',out,'--source',missing)
        self.assertNotEqual(done.returncode,0)
        self.assertFalse(out.exists())
        file_source=self.base/'not-a-dir.txt';file_source.write_text('x')
        done=guard(self.state,'derive','old','--project-id','new7b','--out',out,'--source',file_source)
        self.assertNotEqual(done.returncode,0)
        self.assertFalse(out.exists())
        out2=self.base/'p7c.json';dest=self.base/'copy7'
        done=guard(self.state,'derive','old','--project-id','new7c','--out',out2,'--source',missing,'--copy-source',dest)
        self.assertNotEqual(done.returncode,0)
        self.assertFalse(out2.exists());self.assertFalse(dest.exists())


if __name__=='__main__':unittest.main()
