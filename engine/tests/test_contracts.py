"""Fast rule/protocol/persistence tests; never call a model."""
import copy
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from loop_engineering.adapters import ENGINE_DIR, command, expand
from loop_engineering.common import (LoopError, IntegrityError, FileLock, atomic_write, load_json,
    digest, tree_manifest, check_boundary, safe_child, environment, copy_manifest)
from loop_engineering.protocol import validate_report
from loop_engineering.rules import normalize, load_rules

class ContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='loop-contract-')
        self.path = Path(self.temp.name)
        self.raw = load_json(ENGINE_DIR / 'examples/demo.json')
    def tearDown(self):
        self.temp.cleanup()
    def reject(self, mutate):
        mutate(self.raw)
        with self.assertRaises(LoopError):
            normalize(self.raw, ENGINE_DIR / 'examples')
    def test_valid_rule(self):
        self.assertTrue(Path(normalize(self.raw, ENGINE_DIR/'examples')['source']).is_absolute())
    def test_unknown_field(self):
        self.reject(lambda r:r.update(forever=True))
    def test_todo(self):
        self.reject(lambda r:r.update(title='TODO: unfinished'))
    def test_bool_schema(self):
        self.reject(lambda r:r.update(schema_version=True))
    def test_duplicate_units(self):
        self.reject(lambda r:r['units'].append(copy.deepcopy(r['units'][0])))
    def test_cycle(self):
        self.reject(lambda r:r['units'][0].update(depends_on=['invite']))
    def test_unknown_dependency(self):
        self.reject(lambda r:r['units'][0].update(depends_on=['unknown']))
    def test_unknown_gate(self):
        self.reject(lambda r:r['units'][0]['criteria'][0].update(gate_ids=['NO']))
    def test_unmapped_gate(self):
        self.reject(lambda r:r['units'][0]['criteria'][0].update(gate_ids=[]))
    def test_no_criteria(self):
        self.reject(lambda r:r['units'][0].update(criteria=[]))
    def test_same_member_identity(self):
        self.reject(lambda r:r['agents']['review'].update(identity=r['agents']['dev']['identity']))
    def test_path_traversal(self):
        self.reject(lambda r:r['units'][0].update(writable_paths=['../a']))
    def test_absolute_path(self):
        self.reject(lambda r:r['units'][0].update(writable_paths=['/tmp/a']))
    def test_glob_path(self):
        self.reject(lambda r:r['units'][0].update(writable_paths=['src/*.py']))
    def test_bool_budget(self):
        self.reject(lambda r:r['limits'].update(max_member_invocations=True))
    def test_negative_timeout(self):
        self.reject(lambda r:r['units'][0].update(stage_timeout_seconds=-1))
    def test_write_conflict(self):
        def change(r):
            u=copy.deepcopy(r['units'][0]);u['id']='second';r['units'].append(u);r['completion']={'mode':'independent'}
        self.reject(change)
    def test_read_conflict(self):
        def change(r):
            u=copy.deepcopy(r['units'][0]);u.update(id='second',writable_paths=['other.py'],read_paths=['invites.py']);r['units'].append(u);r['completion']={'mode':'independent'}
        self.reject(change)
    def test_explicit_multi_completion(self):
        def change(r):
            u=copy.deepcopy(r['units'][0]);u.update(id='second',writable_paths=['other.py']);r['units'].append(u)
        self.reject(change)
    def test_integration_all_dependencies(self):
        self.raw=load_json(ENGINE_DIR/'examples/dag.json')
        self.reject(lambda r:r['units'][-1].update(depends_on=['front']))
    def test_valid_dag(self):
        self.assertEqual(load_rules(ENGINE_DIR/'examples/dag.json')['completion']['unit'],'integration')
    def test_json_duplicate_keys(self):
        p=self.path/'a.json';p.write_text('{"x":1,"x":2}')
        with self.assertRaises(LoopError):load_json(p)
    def test_json_nan(self):
        p=self.path/'a.json';p.write_text('{"x":NaN}')
        with self.assertRaises(LoopError):load_json(p)
    def test_atomic_failure_preserves_old(self):
        p=self.path/'state';atomic_write(p,'old')
        with patch('loop_engineering.common.os.replace',side_effect=OSError('injected crash')):
            with self.assertRaises(OSError):atomic_write(p,'new')
        self.assertEqual(p.read_text(),'old');self.assertFalse(list(self.path.glob('.tmp-*')))
    def test_owner_lock_exclusive(self):
        with FileLock(self.path/'lock'):
            with self.assertRaises(LoopError):
                with FileLock(self.path/'lock'):pass
    def test_snapshot_symlink(self):
        (self.path/'evil').symlink_to('/etc/passwd')
        with self.assertRaises(IntegrityError):tree_manifest(self.path)
    def test_snapshot_secrets_excluded(self):
        (self.path/'.env').write_text('SYNTHETIC_TOKEN=1');(self.path/'.env.example').write_text('TOKEN=')
        m=tree_manifest(self.path);self.assertNotIn('.env',m);self.assertIn('.env.example',m)
    def test_executable_identity(self):
        p=self.path/'f';p.write_text('x');p.chmod(0o600);a=digest(tree_manifest(self.path));p.chmod(0o700)
        self.assertNotEqual(a,digest(tree_manifest(self.path)))
    def test_empty_directory_boundary(self):
        before=tree_manifest(self.path);(self.path/'bad').mkdir()
        with self.assertRaises(IntegrityError):check_boundary(before,tree_manifest(self.path),['ok.py'],[])
    def test_safe_child(self):
        with self.assertRaises(LoopError):safe_child(self.path,'../x')
    def test_export_cannot_overwrite(self):
        (self.path/'a').mkdir();(self.path/'b').mkdir()
        with self.assertRaises(IntegrityError):copy_manifest(self.path/'a',self.path/'b',{})
    def test_env_opt_in(self):
        with patch.dict(os.environ,{'SYNTHETIC_KEY':'test'}):
            self.assertNotIn('SYNTHETIC_KEY',environment());self.assertEqual(environment(['SYNTHETIC_KEY'])['SYNTHETIC_KEY'],'test')
    def test_braces_safe(self):
        self.assertEqual(expand(['{python}',"print({'a': 1})"],{'python':'/p y'}),['/p y',"print({'a': 1})"])
    def test_codex_safe_args(self):
        args,out=command({'kind':'codex','extra_args':[]},'reviewer',{'schema':'s','response':'o'})
        self.assertIn('read-only',args);self.assertNotIn('--yolo',args);self.assertEqual(args[-1],'-');self.assertEqual(out,'file')
    def test_pi_readonly_tool_selection(self):
        args,out=command({'kind':'pi','extra_args':[]},'reviewer',{})
        self.assertEqual(args[args.index('--tools')+1],'read,grep,find,ls');self.assertIn('--no-session',args)

class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='loop-protocol-');self.code=Path(self.temp.name);(self.code/'x.py').write_text('x=1')
        self.context={'attempt_id':'current','role':'reviewer','candidate_hash':'current-hash','unit':{'criteria':[{'id':'S1'}]}}
        self.report={'attempt_id':'current','role':'reviewer','candidate_hash':'current-hash','summary':'review','blocked':False,'rule_gaps':[],'issues':[],
            'criteria':[{'id':'S1','status':'PASS','note':'verified','evidence':['code:x.py']}]}
    def tearDown(self):self.temp.cleanup()
    def rejected(self,fn):
        fn(self.report)
        with self.assertRaises(LoopError):validate_report(self.report,self.context,self.code,{})
    def test_valid(self):validate_report(self.report,self.context,self.code,{})
    def test_late_attempt(self):self.rejected(lambda r:r.update(attempt_id='old'))
    def test_old_candidate(self):self.rejected(lambda r:r.update(candidate_hash='old'))
    def test_missing_id(self):self.rejected(lambda r:r.update(criteria=[]))
    def test_duplicate_id(self):self.rejected(lambda r:r['criteria'].append(copy.deepcopy(r['criteria'][0])))
    def test_empty_evidence(self):self.rejected(lambda r:r['criteria'][0].update(evidence=[]))
    def test_external_evidence(self):self.rejected(lambda r:r['criteria'][0].update(evidence=['https://invalid.example']))
    def test_invented_gate(self):self.rejected(lambda r:r['criteria'][0].update(evidence=['gate:NO']))
    def test_unknown_valid_but_not_pass(self):
        self.report['criteria'][0].update(status='UNKNOWN',evidence=[])
        self.assertEqual(validate_report(self.report,self.context,self.code,{})['criteria'][0]['status'],'UNKNOWN')
    def test_no_new_scope(self):self.rejected(lambda r:r['issues'].append({'criterion_id':'NEW','description':'new','suggested_fix':'more'}))
    def test_blocked_requires_gap(self):self.rejected(lambda r:r.update(blocked=True))
