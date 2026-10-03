import json,os,subprocess,sys,tempfile,time,unittest
from pathlib import Path
from helpers import BUNDLE
from loop_engineering.pi_events import PiEvents,EventError
from loop_engineering.diagnostics import PrefixLog
from loop_engineering.common import atomic_json,atomic_write
from loop_engineering.runner import process_identity,_quota_exceeded
from loop_engineering import outcomes


def wire(events):return b''.join(json.dumps(x,ensure_ascii=False).encode()+b'\n' for x in events)
def final(text='{"ok":true}'):
    return [{'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':text}],'stopReason':'stop',
            'usage':{'input':1,'output':2,'cacheRead':0,'cacheWrite':0}}}, {'type':'agent_end','messages':[],'willRetry':False},{'type':'agent_settled'}]

class SoftLog(unittest.TestCase):
    def test_more_than_old_eight_mib_still_delivers_and_bounds_storage(self):
        with tempfile.TemporaryDirectory() as t:
            p=PiEvents(Path(t),1024*1024,diagnostic_bytes=1024,legacy_bytes=1024*1024,persist_interval=.5)
            chunk=wire([{'type':'message_update','padding':'x'*2048,'usage':{'input':999}}])
            for _ in range(5000):p.feed(chunk)
            p.feed(wire(final()));self.assertEqual(json.loads(p.finish('ok')),{'ok':True})
            r=json.loads((Path(t)/'pi-events.jsonl.retention.json').read_text())
            self.assertGreater(r['observed_bytes'],8*1024*1024);self.assertLessEqual(r['retained_bytes'],1024)
            self.assertFalse(r['complete']);self.assertEqual(json.loads((Path(t)/'usage.json').read_text())['tokens']['input'],1)
    def test_missing_settled_after_log_truncation_not_accepted(self):
        with tempfile.TemporaryDirectory() as t:
            p=PiEvents(Path(t),65536,diagnostic_bytes=10,legacy_bytes=65536,persist_interval=.5)
            p.feed(wire(final()[:-1]))
            with self.assertRaises(EventError):p.finish('ok')
    def test_new_work_after_old_reply_not_accepted(self):
        with tempfile.TemporaryDirectory() as t:
            p=PiEvents(Path(t),65536,diagnostic_bytes=10,legacy_bytes=65536,persist_interval=.5)
            p.feed(wire(final()+[{'type':'tool_execution_start','toolCallId':'new','toolName':'read'},{'type':'tool_execution_end','toolCallId':'new'},{'type':'agent_settled'}]))
            with self.assertRaises(EventError):p.finish('ok')
    def test_event_hard_limit_is_distinct(self):
        p=PiEvents(None,1024,diagnostic_bytes=10,legacy_bytes=1024,persist_interval=.5)
        p.feed(wire([{'type':'session'}]))
        with self.assertRaises(EventError) as ctx:p.feed(b'{"type":"message_update","x":"'+b'x'*2048)
        self.assertEqual(ctx.exception.reason,'event_limit')
        try:p.finish('event_limit')
        except EventError:pass
    def test_response_limit_not_diagnostic_limit(self):
        with tempfile.TemporaryDirectory() as t:
            p=PiEvents(Path(t),65536,diagnostic_bytes=10,legacy_bytes=65536,persist_interval=.5)
            p.feed(wire(final(json.dumps({'x':'abc'*100}))))
            with self.assertRaises(EventError) as ctx:p.finish('ok',max_response_bytes=100)
            self.assertEqual(ctx.exception.reason,'response_limit')
    def test_quota_adds_all_run_roots(self):
        with tempfile.TemporaryDirectory() as t:
            a,b=Path(t)/'a',Path(t)/'b';a.mkdir();b.mkdir();(a/'x').write_bytes(b'x'*60);(b/'y').write_bytes(b'y'*60)
            self.assertTrue(_quota_exceeded({'quotas':[{'path':str(x),'group':'run','max_bytes':100,'max_files':100} for x in (a,b)]}))

class GuardianControl(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory();self.addCleanup(self.t.cleanup);self.base=Path(self.t.name);self.job=self.base/'job';self.job.mkdir()
    def run_guard(self,body,*,protocol=True,timeout=5,max_response=10000):
        script=self.base/'adapter.py';script.write_text(body)
        spec={'argv':[sys.executable,str(script)],'cwd':str(self.base),'owner_pid':os.getpid(),'owner_start':process_identity(os.getpid()),
              'timeout_seconds':timeout,'deadline_epoch':time.time()+timeout+1,'idle_output_seconds':0,'cancel_file':str(self.base/'cancel'),
              'soft_diagnostics':True,'stdout_kind':'response','max_log_bytes':128,'max_response_bytes':max_response}
        if protocol:spec['adapter_protocol']=outcomes.PROTOCOL
        atomic_json(self.job/'job.json',spec);atomic_write(self.job/'stdin.txt','')
        cp=subprocess.run([sys.executable,str(BUNDLE/'engine/loop_engineering/runner.py'),str(self.job)],capture_output=True,timeout=timeout+10)
        self.assertTrue((self.job/'receipt.json').exists(),cp.stderr)
        return json.loads((self.job/'receipt.json').read_text())
    def test_typed_log_limit_preserved_with_143(self):
        code="import os,json,sys\nr={'protocol':'loop-outcome-v1','nonce':os.environ['LOOP_CONTROL_NONCE'],'kind':'outcome','reason':'log_limit','exit_code':143}\nos.write(int(os.environ['LOOP_CONTROL_FD']),(json.dumps(r)+'\\n').encode())\nsys.exit(143)\n"
        r=self.run_guard(code);self.assertEqual(r['reason'],'log_limit');self.assertEqual(r['exit_code'],143)
    def test_missing_control_is_not_success_even_exit_zero(self):
        r=self.run_guard("print('{}')\n");self.assertEqual(r['reason'],'adapter_protocol_error')
    def test_wrong_nonce_rejected(self):
        code="import os,json\nr={'protocol':'loop-outcome-v1','nonce':'old','kind':'outcome','reason':'ok','exit_code':0}\nos.write(int(os.environ['LOOP_CONTROL_FD']),(json.dumps(r)+'\\n').encode())\n"
        self.assertEqual(self.run_guard(code)['reason'],'adapter_protocol_error')
    def test_stderr_words_are_not_control(self):
        r=self.run_guard("import sys\nprint('log_limit',file=sys.stderr)\nsys.exit(9)\n",protocol=False)
        self.assertEqual(r['reason'],'nonzero_exit')
    def test_response_still_hard_limited(self):
        r=self.run_guard("print('x'*10000)\n",protocol=False,max_response=100)
        self.assertEqual(r['reason'],'response_limit')
    def test_outer_cancel_wins_over_adapter_outcome(self):
        (self.base/'cancel').write_text('user stop')
        code="import os,json,time\nr={'protocol':'loop-outcome-v1','nonce':os.environ['LOOP_CONTROL_NONCE'],'kind':'outcome','reason':'log_limit','exit_code':2}\nos.write(int(os.environ['LOOP_CONTROL_FD']),(json.dumps(r)+'\\n').encode())\ntime.sleep(2)\n"
        self.assertEqual(self.run_guard(code)['reason'],'cancelled')
    def test_no_unknown_error_in_retryable_allowlist(self):
        for x in ('nonzero_exit','log_limit','config_error','event_limit','output_violation','adapter_protocol_error'):
            self.assertNotIn(x,outcomes.RETRYABLE)

if __name__=='__main__':unittest.main()
