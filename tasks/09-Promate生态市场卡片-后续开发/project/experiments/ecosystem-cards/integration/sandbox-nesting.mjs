// Tests whether a DISTINCT native seatbelt layer can tighten the inherited outer policy.
// A successful same-policy /usr/bin/true invocation would not prove this property.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ELECTRON, environment, runBounded, sandboxPolicy } from './isolation.mjs';
import { safePath, requireSafe } from '../fs-safety.mjs';

export async function probeSandboxNesting(isolation, port, { controls = false } = {}) {
  const { root } = isolation;
  safePath(root, { directory: true, owned: true });
  const token = randomUUID(), canary = join(root, 'nested-canary-' + token);
  writeFileSync(canary, 'fictional nested-layer canary', { flag: 'wx', mode: 0o600 });
  const outer = sandboxPolicy(root, [port]);
  const inner = outer + `\n(deny file-read-data (literal ${JSON.stringify(canary)}))\n`;
  const innerPath = join(root, 'nested-inner-' + token + '.sb');
  writeFileSync(innerPath, inner, { flag: 'wx', mode: 0o600 });
  const finalCode = `const fs=require('fs');try{fs.readFileSync(${JSON.stringify(canary)});console.log('INNER_DENIAL_NOT_APPLIED');process.exit(2);}catch(e){console.log(JSON.stringify({innerDenial:e.code}));process.exit(['EPERM','EACCES'].includes(e.code)?0:3);}`;
  const code = `const cp=require('child_process');const run=cp.spawnSync('/usr/bin/sandbox-exec',['-f',${JSON.stringify(innerPath)},${JSON.stringify(ELECTRON)},'-e',${JSON.stringify(finalCode)}],{encoding:'utf8',timeout:5000});console.log(JSON.stringify({status:run.status,signal:run.signal,error:run.error?.message,stdout:run.stdout,stderr:run.stderr}));process.exit(run.status===0?0:1);`;
  const options = { cwd: root, env: { ...environment(root, port), ELECTRON_RUN_AS_NODE: '1' } };
  const report = { kind: 'distinct-policy nesting diagnostic; NOT desktop evidence', canary, innerPath,
    startedAt: new Date().toISOString(), outerPolicy: outer, innerPolicy: inner, runs: [] };
  report.innerControl = await runBounded('/usr/bin/sandbox-exec', ['-f', innerPath, ELECTRON, '-e', finalCode], options);
  const variants = [['full-boundary', outer]];
  if (controls) variants.push(['without-process-info-control', outer.replace('(deny process-info* (target others))', '')],
    ['default-only-control', '(version 1)\n(allow default)\n']);
  for (const [label, policy] of variants) {
    const run = await runBounded('/usr/bin/sandbox-exec', ['-p', policy, ELECTRON, '-e', code], options);
    let nested = null;
    try { nested = JSON.parse(run.stdout); } catch {}
    report.runs.push({ label, outerPolicy: policy, ...run, nested });
  }
  const succeeded = run => run.code === 0 && !run.signal && !run.timedOut && !run.error;
  const parsed = report.runs[0].nested;
  requireSafe(report.runs.length > 0, 'NESTED_PROBE_MISSING');
  report.innerControlConfirmed = succeeded(report.innerControl) && /"innerDenial":"(?:EPERM|EACCES)"/.test(report.innerControl.stdout);
  report.distinctPolicyNestingConfirmed = report.innerControlConfirmed && succeeded(report.runs[0])
    && parsed?.status === 0 && /"innerDenial":"(?:EPERM|EACCES)"/.test(parsed.stdout || '');
  report.reason = report.distinctPolicyNestingConfirmed ? 'DISTINCT_LAYER_ENFORCED'
    : /sandbox_apply: Operation not permitted/.test(parsed?.stderr || '') ? 'DISTINCT_NATIVE_SANDBOX_LAYER_DENIED' : 'NESTING_UNPROVEN';
  report.finishedAt = new Date().toISOString();
  report.note = 'Control policies apply only to fixed fictional-canary probes. WorkBuddy desktop always retains the full outer boundary and all original Chromium protection; this diagnostic does not authorize a relaxed host launch.';
  return report;
}
