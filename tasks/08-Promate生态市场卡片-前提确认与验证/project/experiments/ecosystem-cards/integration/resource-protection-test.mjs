import assert from 'node:assert/strict';
import { assessResourceProtection } from './evidence.mjs';

const before = { digest: 'a'.repeat(64) }, after = { ...before };
const actions = ['market-visible', 'install', 'disable', 'enable', 'uninstall', 'reinstall', 'upgrade'];
const steps = actions.map(action => ({ action, attempted: true, status: 'PASS', foreignResourcesUnchanged: true,
  rawEvidencePath: '/fixture/' + action + '.json', screenshotPath: '/fixture/' + action + '.png' }));
let checks = 0;
const check = (input, status, unchanged) => {
  const result = assessResourceProtection(input);
  assert.equal(result.status, status); assert.equal(result.otherResourcesUnchanged, unchanged); checks++;
  return result;
};
check({}, 'UNKNOWN', null);
const startupOnly = check({ steps: actions.map(action => ({ action, attempted: false, status: 'UNKNOWN' })), before, after }, 'UNKNOWN', null);
assert.equal(startupOnly.diagnosticBeforeAfterUnchanged, true);
assert.equal(startupOnly.operationCoverageConfirmed, false);
check({ steps: steps.slice(0, 6), before, after }, 'UNKNOWN', null);
check({ steps, before, after }, 'PASS', true);
check({ steps, before, after: { digest: 'b'.repeat(64) } }, 'FAIL', false);
for (const invalid of [{ attempted: false }, { status: 'UNKNOWN' }, { foreignResourcesUnchanged: null },
  { screenshotPath: null }, { rawEvidencePath: null }, { action: 'install' }]) {
  check({ steps: steps.map((s, i) => i === 0 ? { ...s, ...invalid } : s), before, after }, 'UNKNOWN', null);
}
// A temporary non-target mutation is not erased by identical final snapshots.
check({ steps: steps.map((s, i) => i === 0 ? { ...s, foreignResourcesUnchanged: false } : s), before, after }, 'FAIL', false);
check({ steps, before, after: { digest: 'unreadable' } }, 'UNKNOWN', null);
console.log(JSON.stringify({ status: 'PASS', checks, scope: 'report classification fixtures ONLY; no desktop or resource mutation evidence' }));
