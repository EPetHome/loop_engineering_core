import importlib.util,json,os,socket,subprocess,sys,tempfile,time,unittest
from pathlib import Path
from helpers import *
from loop_engineering.plugin_config import generate


def module(path,name):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
HOOK=module(BUNDLE/'plugins/loop-guard/hooks/dispatch.py','hook040')
BRIDGE=module(BUNDLE/'plugins/loop-guard/mcp/bridge.py','bridge040')

CLAUDE_PREFIX='mcp__plugin_loop-guard_loop_guard__'  # Claude Code: mcp__plugin_<plugin>_<server>__
CODEX_PREFIX='mcp__loop_guard__'                      # Codex keeps plain MCP names


class Hook(unittest.TestCase):
    def setUp(self):
        t=tempfile.TemporaryDirectory();self.addCleanup(t.cleanup);self.base=Path(t.name)
        self.prep=self.base/'prep'/'sub';self.prep.mkdir(parents=True);(self.base/'prep'/'.loop-guard-prep.json').write_text('{}')
        self.outside=self.base/'other';self.outside.mkdir()
    def event(self,name,host='claude',cwd=None,**extra):
        e={'hook_event_name':'PreToolUse','tool_name':name,'tool_input':{'command':'anything'},'cwd':str(cwd or self.prep),**extra}
        if host=='codex':e['turn_id']='t1'
        return e
    def test_claude_allows_only_own_preparation_tools(self):
        code,out,err=HOOK.decide(self.event(CLAUDE_PREFIX+'loop_prepare_check'))
        self.assertEqual((code,out['hookSpecificOutput']['permissionDecision']),(0,'allow'))
        for name in (CODEX_PREFIX.replace('loop_guard','evil')+'loop_prepare_check','mcp__plugin_evil_loop_guard__loop_prepare_check',
                     CLAUDE_PREFIX+'launch','loop_prepare_check'):
            self.assertEqual(HOOK.decide(self.event(name))[0],2,name)
    def test_codex_allow_is_silent_because_it_rejects_allow_output(self):
        for name in (CODEX_PREFIX+'loop_prepare_seal','loop_prepare_seal','update_plan'):
            self.assertEqual(HOOK.decide(self.event(name,'codex')),(0,None,None),name)
    def test_shell_patch_and_subagent_are_denied_on_both_hosts(self):
        for host in ('claude','codex'):
            for name in ('Bash','exec_command','shell','apply_patch','Write','Edit','Read','Task','Agent','spawn_agent','python'):
                code,out,err=HOOK.decide(self.event(name,host))
                self.assertEqual((code,out),(2,None),(host,name));self.assertTrue(err)
    def test_claude_skill_tool_limited_to_loop_prepare(self):
        ok=self.event('Skill');ok['tool_input']={'skill':'loop-guard:loop-prepare'}
        bad=self.event('Skill');bad['tool_input']={'skill':'update-config'}
        self.assertEqual(HOOK.decide(ok)[0],0);self.assertEqual(HOOK.decide(bad)[0],2)
    def test_outside_prep_workspace_hook_is_inert(self):
        for host in ('claude','codex'):
            self.assertEqual(HOOK.decide(self.event('Bash',host,cwd=self.outside)),(0,None,None))
            self.assertEqual(HOOK.decide({'hook_event_name':'SessionStart','cwd':str(self.outside)}),(0,None,None))
    def test_stop_never_injects_continue(self):
        self.assertEqual(HOOK.decide({'hook_event_name':'Stop','cwd':str(self.prep)}),(0,None,None))
    def test_prompt_context_is_short_no_full_manual(self):
        code,out,err=HOOK.decide({'hook_event_name':'SessionStart','cwd':str(self.prep)});self.assertLess(len(json.dumps(out)),2500)
    def test_script_runs_on_system_python_and_denies_with_exit_2(self):
        for python in [p for p in (sys.executable,'/usr/bin/python3') if Path(p).is_file()]:
            run=lambda e:subprocess.run([python,str(BUNDLE/'plugins/loop-guard/hooks/dispatch.py')],input=json.dumps(e),
                                        text=True,capture_output=True,cwd=self.prep,timeout=20)
            denied=run(self.event('Bash','codex'));self.assertEqual(denied.returncode,2,denied.stderr);self.assertIn('不允许',denied.stderr)
            allowed=run(self.event(CODEX_PREFIX+'loop_prepare_begin','codex'));self.assertEqual((allowed.returncode,allowed.stdout),(0,''))
            broken=subprocess.run([python,str(BUNDLE/'plugins/loop-guard/hooks/dispatch.py')],input='not json',text=True,
                                  capture_output=True,cwd=self.prep,timeout=20)
            self.assertEqual(broken.returncode,2)  # fail closed inside the workspace
            outside=subprocess.run([python,str(BUNDLE/'plugins/loop-guard/hooks/dispatch.py')],input='not json',text=True,
                                   capture_output=True,cwd=self.outside,timeout=20)
            self.assertEqual((outside.returncode,outside.stdout),(0,''))
    def test_mcp_tools_schema_has_no_authorization(self):
        names={x['name'] for x in BRIDGE.tools()}
        self.assertEqual(len(names),9);self.assertFalse(any('launch' in x or 'authorize' in x or 'shell' in x for x in names))
    def test_unknown_rpc_not_proxied(self):
        r=BRIDGE.handle({'jsonrpc':'2.0','id':1,'method':'launch'},{});self.assertEqual(r['error']['code'],-32601)
    def test_config_generation_creates_scoped_workspace_without_installing(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/'prep';runtime=Path(t)/'state'/'runtime.json'
            result=generate(Path(t)/'server.sock',p,runtime=runtime)
            self.assertFalse(result['installed']);self.assertTrue((p/'.loop-guard-prep.json').is_file())
            self.assertEqual(json.loads(runtime.read_text())['socket'],str((Path(t)/'server.sock').absolute()))
            settings=json.loads((p/'.claude/settings.json').read_text())
            self.assertEqual(settings['enabledPlugins'],{'loop-guard@loop-guard-local':True})
            self.assertEqual(settings['extraKnownMarketplaces']['loop-guard-local']['source'],{'source':'directory','path':str(BUNDLE)})
            self.assertTrue((p/'AGENTS.md').is_file() and (p/'CLAUDE.md').is_file())
            with self.assertRaises(Exception):generate(Path(t)/'s',p,runtime=runtime)
            with self.assertRaises(Exception):generate(Path(t)/'s',Path(t)/'p2',runtime=Path(t)/'p2'/'runtime.json')
    def test_bridge_without_service_lists_tools_and_explains(self):
        with tempfile.TemporaryDirectory() as t:
            env={**os.environ,'LOOP_GUARD_CONFIG':str(Path(t)/'missing.json')}
            requests=[{'jsonrpc':'2.0','id':1,'method':'tools/list'},
                      {'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'loop_prepare_status','arguments':{'prep_id':'x'}}}]
            for python in [p for p in (sys.executable,'/usr/bin/python3') if Path(p).is_file()]:
                cp=subprocess.run([python,str(BUNDLE/'plugins/loop-guard/mcp/bridge.py')],input=''.join(json.dumps(x)+'\n' for x in requests),
                                  env=env,text=True,capture_output=True,timeout=20)
                self.assertEqual(cp.returncode,0,cp.stderr);r=[json.loads(x) for x in cp.stdout.splitlines()]
                self.assertEqual(len(r[0]['result']['tools']),9)
                self.assertTrue(r[1]['result']['isError']);self.assertIn('未配置',r[1]['result']['content'][0]['text'])

class StdioIntegration(unittest.TestCase):
    def test_real_stdio_bridge_to_local_prep_controller(self):
        with tempfile.TemporaryDirectory(prefix='lg-') as t:
            base=Path(t);raw=project(base);state,root,d=prepared(base,raw)
            sock=base/'s';config=base/'runtime.json';config.write_text(json.dumps({'socket':str(sock)}))
            with (base/'server.log').open('w') as log:
                server=subprocess.Popen([sys.executable,str(BUNDLE/'loop_guard.py'),'--state',str(state),'serve','--socket',str(sock)],stdout=log,stderr=log)
                try:
                    for _ in range(80):
                        if sock.exists():break
                        if server.poll() is not None:self.fail((base/'server.log').read_text())
                        time.sleep(.05)
                    env={**os.environ,'LOOP_GUARD_CONFIG':str(config)}
                    requests=[{'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-06-18','clientInfo':{'name':'test','version':'1'},'capabilities':{}}},
                              {'jsonrpc':'2.0','method':'notifications/initialized'},
                              {'jsonrpc':'2.0','id':2,'method':'tools/list'},
                              {'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'loop_prepare_check','arguments':{'prep_id':d['id'],'revision':1}}},
                              {'jsonrpc':'2.0','id':4,'method':'tools/call','params':{'name':'launch','arguments':{}}}]
                    cp=subprocess.run([sys.executable,str(BUNDLE/'plugins/loop-guard/mcp/bridge.py')],input=''.join(json.dumps(x)+'\n' for x in requests),env=env,text=True,capture_output=True,timeout=20)
                    self.assertEqual(cp.returncode,0,cp.stderr)
                    result=[json.loads(x) for x in cp.stdout.splitlines()]
                    self.assertEqual(len(result),4);self.assertEqual(result[0]['result']['serverInfo']['version'],'0.4.0')
                    self.assertFalse(result[2]['result']['isError']);self.assertEqual(json.loads(result[2]['result']['content'][0]['text'])['status'],'READY')
                    self.assertTrue(result[3]['result']['isError'])
                    self.assertFalse((root/'runs').exists())
                finally:
                    server.terminate();server.wait(timeout=5)

if __name__=='__main__':unittest.main()
