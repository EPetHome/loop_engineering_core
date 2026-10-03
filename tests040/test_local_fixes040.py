"""Regressions for defects found on a real Mac + Pi 0.87.1 (2026-10-02 Opus review).

The original Linux suite could not see them: the TS host mock did not filter --tools,
the demo ran audit-only, and Linux has no sandbox-exec. No model is called here.
"""
import json,os,shutil,subprocess,sys,tempfile,time,unittest
from pathlib import Path
from helpers import *
from loop_engineering.common import tree_manifest,LoopError
from loop_engineering.execution import ExecutionError,inspect_gate_outputs,sandbox_command,darwin_user_temp
from loop_engineering.capabilities import V2_LIMITS as V2

ADAPTER=BUNDLE/'adapters/pi_member.py'
MAC=sys.platform=='darwin' and Path('/usr/bin/sandbox-exec').is_file()
sys.path.insert(0,str(BUNDLE/'adapters'))
import pi_member


def jdk():
    for home in (os.environ.get('JAVA_HOME'),'/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home',
                 '/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home'):
        if home and (Path(home)/'bin/javac').is_file():return Path(home)
    return None


class PiMemberTools(unittest.TestCase):
    def run_adapter(self,role,repair_only=False):
        with tempfile.TemporaryDirectory() as t:
            t=Path(t);code=t/'code';code.mkdir();ws=t/'ws';ws.mkdir();capture=t/'argv.json'
            fake=t/'fake_pi';fake.write_text('#!'+sys.executable+'\nimport json,os,sys\n'
                'open(os.environ["CAPTURE"],"w").write(json.dumps(sys.argv[1:]))\n');fake.chmod(0o700)
            context={'role':role,'protocol_repair_only':repair_only,'managed_tools':True,'security':'audit-only',
                     'code_path':str(code),'workspace_path':str(ws),'execution_profiles':{},
                     'unit':{'stage_timeout_seconds':30,'protected_paths':[]},'limits':{}}
            (t/'context.json').write_text(json.dumps(context))
            subprocess.run([sys.executable,str(ADAPTER),'--model','m/x','--thinking','max','--tools','read,bash'],
                           input='task',text=True,capture_output=True,cwd=code,timeout=30,
                           env=dict(os.environ,LOOP_PI_BIN=str(fake),CAPTURE=str(capture),LOOP_CONTEXT=str(t/'context.json')))
            return json.loads(capture.read_text())

    def test_extension_tools_survive_pi_allowlist(self):
        # Pi 0.87.1: --tools filters extension tools too; omitting them means no build tool at all.
        argv=self.run_adapter('developer')
        tools=argv[argv.index('--tools')+1].split(',')
        self.assertIn('loop_build',tools);self.assertIn('loop_submit_check',tools);self.assertNotIn('bash',tools)
        self.assertTrue(argv[argv.index('-e')+1].endswith('extensions/pi/loop-member-tools.ts'))

    def test_readonly_members_get_no_build_or_write(self):
        for role,repair in (('reviewer',False),('developer',True)):
            tools=(lambda a:a[a.index('--tools')+1].split(','))(self.run_adapter(role,repair))
            self.assertEqual(tools,['read','grep','find','ls','loop_submit_check'])

    def test_pi_state_paths_follow_agent_dir(self):
        w=pi_member.pi_state_writes({'PI_CODING_AGENT_DIR':'/tmp/agent-x','HOME':'/nonexistent'})
        self.assertEqual(w['write_files'],[Path('/tmp/agent-x').resolve()/'auth.json'])
        self.assertTrue(w['write_regexes'][0].endswith(r'/[^/]+\.lock(/.*)?$'))


class MemberFileOperations(unittest.TestCase):
    # 2026-10-03: b3-config had to delete 30 connection.dat files and keep 29 identical copies;
    # developers had no delete/copy tool, so the unit could never pass.
    def test_developer_deletes_and_copies_inside_scope_only(self):
        with tempfile.TemporaryDirectory() as t:
            base=Path(t);raw=project(base,True);src=Path(raw['source'])
            for name in ('gone.txt','gone2.txt','keep.txt','locked.txt'):(src/name).write_text(name)
            unit=raw['units'][0]
            unit.update(writable_paths=['value.txt','gone.txt','gone2.txt','keep.txt','copies/'],protected_paths=['locked.txt'])
            for agent in raw['agents'].values():agent['argv']=agent['argv']+['--file-ops']
            m,state,root,s,aid=execute_prepared(base,raw)
            result=m['units']['check']['result'];self.assertEqual(result['stop'],'PASSED',result['reason'])
            code=Path(result['candidate']['path'])
            self.assertFalse((code/'gone.txt').exists());self.assertFalse((code/'gone2.txt').exists())
            self.assertTrue((code/'keep.txt').exists());self.assertEqual((code/'locked.txt').read_text(),'locked.txt')
            for name in ('a.txt','b.txt'):self.assertEqual((code/'copies'/name).read_bytes(),(code/'value.txt').read_bytes())
            self.assertFalse((code/'copies/c.txt').exists())
            run=next((root/'runs').iterdir())
            events=[e.get('event') for e in map(json.loads,(run/'events.jsonl').read_text().splitlines())]
            self.assertIn('member_files_deleted',events);self.assertIn('member_files_copied',events)

    def test_developer_tool_allowlist_includes_file_operations(self):
        self.assertEqual(pi_member.managed_tools({'role':'developer','protocol_repair_only':False}).split(','),
                         ['read','edit','write','grep','find','ls','loop_build','loop_submit_check','loop_delete','loop_copy'])


class ContinueStoppedRun(unittest.TestCase):
    # 2026-10-03: managed runs refuse retry/seed, so a stopped multi-unit run was resumed twice
    # with hand-written plans (source path, dropped units, carried issues all edited manually).
    def test_continue_drops_passed_units_and_resumes_from_latest_candidate(self):
        with tempfile.TemporaryDirectory() as t:
            base=Path(t);raw=project(base,True)
            raw['agents']['review_fail']=dict(raw['agents']['review'],identity='offline-review-fail',
                                              argv=raw['agents']['review']['argv']+['--repair'])
            second=json.loads(json.dumps(raw['units'][0]))
            second.update(id='second',kind='integration',depends_on=['check'],reviewer='review_fail',max_repairs=0)
            raw['units'].append(second);raw['completion']={'mode':'integration','unit':'second'}
            m,state,root,s,aid=execute_prepared(base,raw)
            self.assertEqual(m['units']['check']['result']['stop'],'PASSED')
            self.assertEqual(m['units']['second']['result']['stop'],'NOT_MET')
            run=next((root/'runs').iterdir()).name;out=base/'cont.json'
            r=prep.continue_plan(root,run,'p2',out)
            plan=json.loads(out.read_text())
            self.assertEqual(([u['id'] for u in plan['units']],plan['units'][0]['depends_on']),(['second'],[]))
            self.assertEqual(plan['source'],m['units']['second']['result']['candidate']['path'])
            self.assertEqual((r['resume_unit'],r['dropped_passed_units']),('second',['check']))
            self.assertGreaterEqual(r['carried_open_issues'],1)
            self.assertIn('fixture requires second development round',plan['units'][0]['goal'])
            self.assertIn('以本段为准',plan['notes'])
            with self.assertRaises(LoopError):prep.continue_plan(root,run,'p3',out)     # never overwrites
            # The draft goes through the normal managed path and finishes.
            plan['agents']['review_fail']['argv']=raw['agents']['review']['argv']
            prep.register_project(state,'p2',plan,base,root)
            d=prep.begin(state,'p2');rid,s2,aid2=create_prepared_run(state,root,d);Controller(root,rid).execute()
            m2=json.loads((root/'runs'/rid/'manifest.json').read_text())
            self.assertEqual(m2['units']['second']['result']['stop'],'PASSED')
            self.assertIn('成员能做什么',Path(s2['preview_path']).read_text())
            rules=json.loads(json.dumps(s2['rules']));rules['agents']['dev']['argv']=['{python}','{engine}/../adapters/pi_member.py']
            text=prep.render_preview(rules,rules,base/'rules.json')
            for tool in ('loop_build','loop_delete','loop_copy','不能执行任意命令','担任评审时：只读','schema v2 不提供评审执行命令'):self.assertIn(tool,text)

    def test_continue_refuses_parallel_frontier_instead_of_guessing(self):
        from loop_engineering.common import digest
        with tempfile.TemporaryDirectory() as t:
            root=Path(t)/'data';run=root/'runs'/'r1';run.mkdir(parents=True)
            unit=lambda uid:{'id':uid,'depends_on':[]}
            rules={'schema_version':2,'units':[unit('a'),unit('b')],'limits':{}}
            (run/'rules.json').write_text(json.dumps(rules))
            (run/'manifest.json').write_text(json.dumps({'state':'TERMINAL','rule_hash':digest(rules),
                'units':{'a':{'result':{'stop':'NOT_MET'}},'b':{'result':{'stop':'NOT_RUN'}}}}))
            with self.assertRaises(LoopError) as e:prep.continue_plan(root,'r1','p',Path(t)/'out.json')
            self.assertIn('并行分支',str(e.exception));self.assertFalse((Path(t)/'out.json').exists())


@unittest.skipUnless(MAC,'needs macOS sandbox-exec')
class StrictSandboxOnMac(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory();self.addCleanup(self.t.cleanup);self.base=Path(self.t.name).resolve()

    def sandboxed(self,script,writes,**kw):
        cmd=sandbox_command(['/bin/sh','-c',script],writes,mode='strict',**kw)
        return subprocess.run(cmd,capture_output=True,text=True,timeout=120,
                              env={'PATH':'/usr/bin:/bin','HOME':str(self.base),'TMPDIR':str(self.base)})

    def test_pi_agent_locks_and_auth_writable_but_settings_not(self):
        agent=self.base/'agent';agent.mkdir();(agent/'settings.json').write_text('{}');(agent/'auth.json').write_text('{}')
        work=self.base/'work';work.mkdir()
        out=self.sandboxed(f'mkdir "{agent}/settings.json.lock" && rmdir "{agent}/settings.json.lock" && echo lock-ok;'
                           f'echo new > "{agent}/auth.json" && echo auth-ok;'
                           f'(echo x > "{agent}/settings.json") 2>/dev/null && echo settings-WRITTEN || echo settings-denied;'
                           f'(echo x > "{agent}/other.json") 2>/dev/null && echo other-WRITTEN || echo other-denied',
                           [work],network=True,**pi_member.pi_state_writes({'PI_CODING_AGENT_DIR':str(agent)}))
        self.assertEqual(out.stdout.split(),['lock-ok','auth-ok','settings-denied','other-denied'],out.stderr)
        self.assertEqual((agent/'settings.json').read_text(),'{}')

    def test_build_jvm_attach_works_and_signals_stay_inside(self):
        home=jdk()
        if home is None or darwin_user_temp() is None:self.skipTest('no local JDK')
        src=self.base/'SelfAttach.java';src.write_text(
            'import com.sun.tools.attach.VirtualMachine;public class SelfAttach{public static void main(String[] a)throws Exception{'
            'VirtualMachine v=VirtualMachine.attach(Long.toString(ProcessHandle.current().pid()));System.out.println("ATTACH_OK");v.detach();}}')
        classes=self.base/'classes';subprocess.run([str(home/'bin/javac'),'-d',str(classes),str(src)],check=True,timeout=120)
        java=f'"{home}/bin/java" -Djdk.attach.allowAttachSelf=true -cp "{classes}" SelfAttach'
        self.assertNotIn('ATTACH_OK',self.sandboxed(java,[self.base],network=False).stdout)  # why the rule exists
        self.assertIn('ATTACH_OK',self.sandboxed(java,[self.base],network=False,jvm_attach=True).stdout)
        outside=subprocess.Popen(['/bin/sleep','60'],start_new_session=True);self.addCleanup(outside.wait);self.addCleanup(outside.kill)
        r=self.sandboxed(f'kill -TERM {outside.pid} 2>/dev/null && echo SIGNALLED || echo denied',[self.base],network=False,jvm_attach=True)
        self.assertEqual(r.stdout.strip(),'denied');time.sleep(.2);self.assertIsNone(outside.poll())
        net=self.sandboxed('/usr/bin/curl -sS -m 5 https://1.1.1.1 -o /dev/null && echo NET || echo nonet',[self.base],network=False,jvm_attach=True)
        self.assertEqual(net.stdout.strip(),'nonet')

    def test_non_ascii_paths_stay_writable_in_strict_mode(self):
        # json.dumps' default \\uXXXX escape names a different path in SBPL: every write was denied.
        target=self.base/'产品 资料'/'执行';target.mkdir(parents=True)
        out=self.sandboxed(f'mkdir "{target}/new" && echo ok',[target],network=False,jvm_attach=True,
                           write_files=[self.base/'产品 资料'/'单个.json'],protected=[target/'保护'])
        self.assertEqual(out.stdout.strip(),'ok',out.stderr)
        out=self.sandboxed(f'echo x > "{self.base}/产品 资料/单个.json" && echo ok',[target],network=False,
                           write_files=[self.base/'产品 资料'/'单个.json'])
        self.assertEqual(out.stdout.strip(),'ok',out.stderr)
        (target/'保护').mkdir()
        out=self.sandboxed(f'(echo x > "{target}/保护/f") 2>/dev/null && echo WRITTEN || echo denied',[target],network=False,protected=[target/'保护'])
        self.assertEqual(out.stdout.strip(),'denied')

    def test_strict_build_supports_mockito_style_temp_jar_and_attach(self):
        # Mockito inline writes its agent jar via File.createTempFile, then self-attaches.
        home=jdk()
        if home is None:self.skipTest('no local JDK')
        self.base=self.base/'中文 目录';self.base.mkdir()  # also covers JAVA_TOOL_OPTIONS quoting
        src=self.base/'src';src.mkdir()
        (src/'Probe.java').write_text('import com.sun.tools.attach.VirtualMachine;public class Probe{public static void main(String[] a)throws Exception{'
            'java.io.File f=java.io.File.createTempFile("agent",".jar");f.delete();'
            'VirtualMachine v=VirtualMachine.attach(Long.toString(ProcessHandle.current().pid()));v.detach();'
            'java.nio.file.Files.createDirectories(java.nio.file.Path.of("out"));java.nio.file.Files.writeString(java.nio.file.Path.of("out/ok"),f.getParent());}}')
        subprocess.run([str(home/'bin/javac'),'-d',str(src/'classes'),str(src/'Probe.java')],check=True,timeout=120)
        profile={'argv':[str(home/'bin/java'),'-Djdk.attach.allowAttachSelf=true','-cp','classes','Probe'],'cwd':'.','output_paths':['out/'],
                 'evidence_paths':['out/ok'],'timeout_seconds':60,'network':False,'inherit_env':[],'max_reruns':0,'cache_dir':None,
                 'max_cache_bytes':1,'max_cache_files':1}
        from loop_engineering.execution import execute_recipe
        r=execute_recipe(src,tree_manifest(src),profile,self.base/'exec',{'max_source_files':100,'max_source_bytes':10**7,'max_log_bytes':10**6},
                         purpose='SELF_TEST',security='strict',deadline=time.time()+60,cancel_file=self.base/'cancel')
        self.assertEqual(r['status'],'PASS',(self.base/'exec/job/stderr.log').read_text()[-800:])
        self.assertEqual(Path(r['reports']['out/ok']['path']).read_text(),str(self.base/'exec/tmp'))


class BuildEnvironment(unittest.TestCase):
    def test_every_jvm_temp_dir_points_into_the_build(self):
        with tempfile.TemporaryDirectory() as t:
            base=Path(t).resolve();raw=project(base);src=Path(raw['source'])
            (src/'build.py').write_text(BUILD+"import os;(p/'jto.txt').write_text(os.environ['JAVA_TOOL_OPTIONS'])\n")
            r=normalize(raw,base)
            from loop_engineering.execution import execute_recipe
            x=execute_recipe(src,tree_manifest(src),r['execution_profiles']['test'],base/'b',r['limits'],purpose='SELF_TEST',
                             security='audit-only',deadline=time.time()+30,cancel_file=base/'cancel')
            self.assertEqual(x['status'],'PASS',x)
            self.assertEqual((base/'b/source/module/target/jto.txt').read_text(),'-Djava.io.tmpdir='+str(base/'b/tmp'))


class OutputDeclarations(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory();self.addCleanup(self.t.cleanup);self.base=Path(self.t.name)

    def test_all_undeclared_outputs_reported_in_one_error(self):
        src=self.base/'s'
        for d in ('common/src','skill/src','mcp/src'):(src/d).mkdir(parents=True);(src/d/'A.java').write_text('x')
        before=tree_manifest(src)
        for d in ('common','skill','mcp'):(src/d/'target/classes').mkdir(parents=True);(src/d/'target/classes/A.class').write_text('c')
        (src/'skill/logs').mkdir();(src/'skill/logs/t.log').write_text('l')
        with self.assertRaises(ExecutionError) as e:
            inspect_gate_outputs(before,tree_manifest(src),['common/target/'],V2)
        self.assertEqual(e.exception.reason,'output_violation')
        for root in ('skill/target/','mcp/target/','skill/logs/'):self.assertIn(root,str(e.exception))
        self.assertNotIn('classes/A.class',str(e.exception))

    def raw_with_build(self,extra,**unit):
        raw=project(self.base)
        (Path(raw['source'])/'build.py').write_text(BUILD+extra)
        raw['units'][0].update(unit)
        return raw

    def test_registration_rejects_undeclared_output_before_any_model_time(self):
        raw=self.raw_with_build("Path('logs').mkdir();Path('logs/t.log').write_text('x')\n")
        state=self.base/'state'
        with self.assertRaises(LoopError) as e:
            prep.register_project(state,'p',raw,self.base,self.base/'data',verify=True)
        self.assertIn('logs/',str(e.exception))
        with self.assertRaises(LoopError):Ledger(state).get('project','p')

    def test_registration_records_verified_outputs_in_preview(self):
        state=self.base/'state'
        p=prep.register_project(state,'p',project(self.base),self.base,self.base/'data',verify=True)
        entry=p['verification']['profiles']['test']
        self.assertEqual((entry['status'],entry['outputs']),('VERIFIED',['module/target/']))
        d=prep.begin(state,'p');s=prep.seal(state,d['id'],d['revision'])
        self.assertIn('配方登记验证：test=VERIFIED',Path(s['preview_path']).read_text())

    def test_missing_report_after_failure_rejects_registration(self):
        # The 2026-10-02 acceptance case: sandbox denied the report dir, script crashed, nothing ran.
        raw=self.raw_with_build('',)
        (Path(raw['source'])/'build.py').write_text("raise SystemExit(1)\n")
        state=self.base/'state'
        with self.assertRaises(LoopError) as e:
            prep.register_project(state,'p',raw,self.base,self.base/'data',verify=True)
        self.assertIn('evidence_limit',str(e.exception));self.assertIn('--skip-verify test',str(e.exception))
        with self.assertRaises(LoopError):Ledger(state).get('project','p')
        p=prep.register_project(state,'p',raw,self.base,self.base/'data',verify=True,skip_verify=['test'])
        self.assertEqual(p['verification']['profiles'],{});self.assertIn('test',p['verification']['skipped'])
        d=prep.begin(state,'p');s=prep.seal(state,d['id'],d['revision'])
        self.assertIn('test=未验证',Path(s['preview_path']).read_text())

    def test_declared_outputs_that_never_appear_reject_registration(self):
        raw=self.raw_with_build('')
        r=raw['execution_profiles']['test'];r['evidence_paths']=[]
        (Path(raw['source'])/'build.py').write_text("print('did nothing')\n")
        with self.assertRaises(LoopError) as e:
            prep.register_project(self.base/'state','p',raw,self.base,self.base/'data',verify=True)
        self.assertIn('no_output',str(e.exception))

    def test_staged_units_may_remove_a_file_protected_by_earlier_units(self):
        # 2026-10-03: unit 1 protects conf.dat, unit 2 removes it; the registered plan failed its own check.
        raw=project(self.base,True);src=Path(raw['source']);(src/'conf.dat').write_text('secret')
        first=raw['units'][0];first.update(id='early',protected_paths=['conf.dat'])
        second=json.loads(json.dumps(first));second.update(id='late',depends_on=['early'],writable_paths=['value.txt','conf.dat'],protected_paths=[])
        raw['units'].append(second);raw['completion']={'mode':'integration','unit':'late'}
        second['kind']='integration'
        state,root,d=prepared(self.base,raw)
        self.assertEqual(prep.check(state,d['id'],d['revision'])['status'],'READY')
        units=json.loads(json.dumps(d['rules']['units']));units[0]['protected_paths']=[]          # weaken early unit
        with self.assertRaises(LoopError):prep.patch(state,d['id'],d['revision'],{'units':units})
        units=json.loads(json.dumps(d['rules']['units']));units[0]['writable_paths']=['value.txt','conf.dat']  # widen early unit
        with self.assertRaises(LoopError):prep.patch(state,d['id'],d['revision'],{'units':units})

    def test_nonzero_on_current_source_is_reported_not_rejected(self):
        raw=self.raw_with_build("print('feature missing');raise SystemExit(3)\n")
        p=prep.register_project(self.base/'state','p',raw,self.base,self.base/'data',verify=True)
        entry=p['verification']['profiles']['test']
        self.assertEqual(entry['status'],'VERIFIED_NONZERO');self.assertIn('feature missing',entry['stdout_tail'])

    def test_long_inline_argument_registers_and_is_flagged(self):
        # 2026-10-03: a 15850-byte inline script in argv crashed registration with ENAMETOOLONG.
        raw=project(self.base)
        raw['execution_profiles']['test']['argv']=['{python}','-c',"import runpy;runpy.run_path('build.py')#"+'x'*6000]
        state=self.base/'state'
        p=prep.register_project(state,'p',raw,self.base,self.base/'data',verify=True)
        self.assertEqual(p['verification']['profiles']['test']['status'],'VERIFIED')
        d=prep.begin(state,'p')
        warnings=prep.check(state,d['id'],d['revision'])['warnings']
        self.assertTrue(any('配方 test' in w and '内联' in w for w in warnings),warnings)

    def test_budgeted_scenario_profile_not_run_at_registration(self):
        raw=project(self.base,failed_verify=True)
        raw['units'][0]['gates']=[{'id':'G','profile':'fail','budget_key':'C06'}]
        p=prep.register_project(self.base/'state','p',raw,self.base,self.base/'data',verify=True)
        self.assertEqual(p['verification']['profiles'],{});self.assertIn('fail',p['verification']['skipped'])

    def test_gate_stop_reason_names_the_missing_outputs(self):
        raw=self.raw_with_build("Path('logs').mkdir();Path('logs/t.log').write_text('x')\n")
        m,state,root,s,aid=execute_prepared(self.base,raw)
        result=m['units']['check']['result']
        self.assertEqual(result['stop'],'BLOCKED')
        self.assertIn('["logs/"]',result['reason'])  # visible in result.md, not only in evidence files


if __name__=='__main__':unittest.main()
