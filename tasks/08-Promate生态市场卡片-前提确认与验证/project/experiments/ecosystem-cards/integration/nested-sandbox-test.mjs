// Foreground diagnostic, no desktop or account: preserve raw OS rejection, do not claim host PASS.
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { createIsolation, allocatePort, confirmBoundary, sandboxPolicy } from './isolation.mjs';
import { probeSandboxNesting } from './sandbox-nesting.mjs';
import { evidenceWorkspace, writeJSON } from './evidence.mjs';

const workspace = resolve(process.argv[2]);
evidenceWorkspace(workspace, join(workspace, 'nested-sandbox.json'));
const isolation = createIsolation(), port = await allocatePort();
const boundary = await confirmBoundary(isolation, port);
assert.equal(boundary.pass, true);
writeFileSync(join(isolation.root, 'sandbox.sb'), sandboxPolicy(isolation.root, [port]), { mode: 0o600 });
const report = { boundary, ...(await probeSandboxNesting(isolation, port, { controls: true })) };
assert.equal(report.innerControlConfirmed, true, 'inner policy must be valid and actually deny the canary');
assert.equal(report.runs.length, 3);
for (const run of report.runs) {
  assert.equal(run.timedOut, false); assert.ok(run.nested);
  assert.ok(Number.isInteger(run.nested.status));
  assert.equal(run.nested.signal, null);
}
writeJSON(join(workspace, 'nested-sandbox.json'), report);
console.log(JSON.stringify({ status: 'DIAGNOSTIC_COMPLETE', root: isolation.root, innerControlConfirmed: report.innerControlConfirmed,
  distinctPolicyNestingConfirmed: report.distinctPolicyNestingConfirmed, reason: report.reason, reportPath: join(workspace, 'nested-sandbox.json') }));
