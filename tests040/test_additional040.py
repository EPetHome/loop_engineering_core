import copy,os,sys,tempfile,time,unittest
from pathlib import Path
from unittest import mock
from helpers import project,prepared,execute_prepared
from loop_engineering.rules import normalize
from loop_engineering.common import LoopError,tree_manifest
from loop_engineering.execution import execute_recipe
from loop_engineering import prep
from loop_engineering.guard_server import dispatch

class Additional040(unittest.TestCase):
    def test_tool_start_is_published_even_inside_throttle_window(self):
        import json
        from loop_engineering.pi_events import PiEvents
        with tempfile.TemporaryDirectory() as t:
            out=Path(t);p=PiEvents(out,65536,diagnostic_bytes=10,legacy_bytes=65536,persist_interval=600)
            events=[{'type':'session'},{'type':'turn_start'},{'type':'tool_execution_start','toolCallId':'one','toolName':'read'}]
            for event in events:p.feed((json.dumps(event)+'\n').encode())
            self.assertEqual(json.loads((out/'activity.json').read_text())['phase'],'tools')
            try:p.finish('cancelled')
            except Exception:pass
    def test_one_plugin_declares_the_same_mcp_server_for_both_hosts(self):
        import json
        from helpers import BUNDLE
        plugin=BUNDLE/'plugins/loop-guard'
        codex=json.loads((plugin/'.codex-plugin/plugin.json').read_text())
        codex_mcp=json.loads((plugin/codex['mcpServers']).read_text())['mcpServers']['loop_guard']
        self.assertEqual((codex_mcp['args'],codex_mcp['cwd']),(['./mcp/bridge.py'],'.'))  # Codex: contained ./ path
        claude=json.loads((plugin/'.claude-plugin/plugin.json').read_text())['mcpServers']['loop_guard']
        self.assertEqual(claude['args'],['${CLAUDE_PLUGIN_ROOT}/mcp/bridge.py'])
    def test_hooks_file_shared_and_not_auto_merged_twice(self):
        import json
        from helpers import BUNDLE
        plugin=BUNDLE/'plugins/loop-guard'
        # Claude Code always merges hooks/hooks.json with the manifest path; keep only the shared file.
        self.assertFalse((plugin/'hooks/hooks.json').exists())
        paths={json.loads((plugin/m).read_text())['hooks'] for m in ('.codex-plugin/plugin.json','.claude-plugin/plugin.json')}
        self.assertEqual(paths,{'./hooks/loop-guard-hooks.json'})
        config=json.loads((plugin/'hooks/loop-guard-hooks.json').read_text())
        self.assertEqual(set(config['hooks']),{'SessionStart','UserPromptSubmit','PreToolUse','Stop'})
        for rows in config['hooks'].values():
            for row in rows:
                for h in row['hooks']:
                    self.assertEqual(h['command'],'python3 "${CLAUDE_PLUGIN_ROOT}/hooks/dispatch.py"')
    def test_local_marketplaces_point_at_the_plugin(self):
        import json
        from helpers import BUNDLE
        claude=json.loads((BUNDLE/'.claude-plugin/marketplace.json').read_text())
        codex=json.loads((BUNDLE/'.agents/plugins/marketplace.json').read_text())
        self.assertEqual(claude['name'],codex['name'])
        self.assertEqual(claude['plugins'][0]['source'],'./plugins/loop-guard')
        self.assertEqual(codex['plugins'][0]['source'],{'source':'local','path':'./plugins/loop-guard'})
    def test_explicit_cache_is_reused_but_not_source_or_evidence(self):
        with tempfile.TemporaryDirectory() as t:
            b=Path(t);r=project(b);src=Path(r['source']);cache=b/'cache'
            r['execution_profiles']['test'].update(cache_dir=str(cache),argv=['{python}','build.py','{cache}'])
            (src/'build.py').write_text("from pathlib import Path\nimport sys\np=Path(sys.argv[1]);p.mkdir(exist_ok=True)\nf=p/'count';n=int(f.read_text()) if f.exists() else 0;f.write_text(str(n+1))\nt=Path('module/target');t.mkdir(parents=True);(t/'report.txt').write_text('current code tested')\n")
            r=normalize(r,b);before=tree_manifest(src)
            for i in range(2):
                v=execute_recipe(src,before,r['execution_profiles']['test'],b/f'build-{i}',r['limits'],purpose='SELF_TEST',security='audit-only',deadline=time.time()+15,cancel_file=b/'cancel')
                self.assertEqual(v['status'],'PASS',v)
                self.assertEqual(v['candidate_hash'],__import__('loop_engineering.common',fromlist=['digest']).digest(before))
            self.assertEqual((cache/'count').read_text(),'2');self.assertEqual(tree_manifest(src),before)
            self.assertFalse((src/'module/target').exists())
    def test_cache_quota_is_independent_and_blocks(self):
        with tempfile.TemporaryDirectory() as t:
            b=Path(t);r=project(b);src=Path(r['source']);cache=b/'cache'
            r['execution_profiles']['test'].update(cache_dir=str(cache),max_cache_bytes=50,argv=['{python}','build.py','{cache}'])
            (src/'build.py').write_text((src/'build.py').read_text()+"\nimport sys\np=Path(sys.argv[1]);p.mkdir(exist_ok=True);(p/'large').write_bytes(b'x'*100)\n")
            r=normalize(r,b)
            v=execute_recipe(src,tree_manifest(src),r['execution_profiles']['test'],b/'build',r['limits'],purpose='SELF_TEST',security='audit-only',deadline=time.time()+15,cancel_file=b/'cancel')
            self.assertEqual(v['reason'],'disk_limit',v);self.assertEqual(v['status'],'UNKNOWN')
    def test_v2_unknown_nonzero_is_not_retried(self):
        with tempfile.TemporaryDirectory() as t:
            b=Path(t);r=project(b,developer=True);r['agents']['dev']['argv']=['{python}','-c','raise SystemExit(9)']
            r['units'][0]['max_infra_retries']=3
            data,*_=execute_prepared(b,r)
            self.assertEqual(data['result']['stop'],'BLOCKED');self.assertEqual(data['result']['member_invocations'],1)
            self.assertEqual(data['units']['check']['stats']['infra_retries'],0)
    def test_managed_reviewer_execution_is_explicitly_unsupported(self):
        with tempfile.TemporaryDirectory() as t:
            b=Path(t);r=project(b,developer=True);r['units'][0]['reviewer_exec']=True
            with self.assertRaises(LoopError):normalize(r,b)
    def test_internal_ancestor_symlink_read_is_also_refused(self):
        with tempfile.TemporaryDirectory() as t:
            b=Path(t);r=project(b);state,root,d=prepared(b,r)
            src=Path(r['source']);(src/'alias').symlink_to(src/'module',target_is_directory=True);(src/'module'/'info').write_text('x')
            with self.assertRaises(LoopError):dispatch(state,{'method':'loop_project_read','args':{'project_id':'p','path':'alias/info'}})
    def test_mcp_patch_and_seal_do_not_repeat_full_rules(self):
        with tempfile.TemporaryDirectory() as t:
            b=Path(t);r=project(b);state,root,d=prepared(b,r)
            v=dispatch(state,{'method':'loop_prepare_patch','args':{'prep_id':d['id'],'revision':1,'changes':{'title':'changed'}}})
            self.assertNotIn('rules',v);self.assertEqual(v['revision'],2)
            v=dispatch(state,{'method':'loop_prepare_seal','args':{'prep_id':d['id'],'revision':2}})
            self.assertNotIn('rules',v);self.assertIn('launch_command',v)
            text=Path(v['preview_path']).read_text();self.assertIn('相对登记配置变化：title',text);self.assertNotIn('完整冻结配置（由程序生成）',text)
    def test_brief_requires_explicit_model_and_protection(self):
        import run_loop
        with mock.patch.dict(os.environ,{},clear=True):
            with self.assertRaises(LoopError):run_loop.brief_command()

if __name__=='__main__':unittest.main()
