import assert from 'node:assert/strict';
import { assessResourceProtection } from './evidence.mjs';

const source = { isolationRoot: '/fixture', marketRoot: '/fixture/non-target-generated/other', ownerId: 'fixture-owner',
  marketName: 'other', pluginName: 'fixture', resourceId: 'fixture-resource', ownershipSha256: 'c'.repeat(64),
  expectedFiles: { '.codebuddy-plugin/marketplace.json': 'b'.repeat(64), 'plugins/fixture/.codebuddy-plugin/plugin.json': 'c'.repeat(64) },
  files: { '.codebuddy-plugin/marketplace.json': 'b'.repeat(64), 'plugins/fixture/.codebuddy-plugin/plugin.json': 'c'.repeat(64), '.loop-card-owner.json': 'd'.repeat(64) } };
const before = { digest: 'a'.repeat(64), value: { registry: { plugins: { 'fixture@other': [{ scope: 'user' }] } },
  files: { 'cache/other/fixture/1.0.0/plugin.json': 'b'.repeat(64) }, sources: [source] } }, after = { ...before };
const actions = ['market-visible', 'install', 'disable', 'enable', 'uninstall', 'reinstall', 'upgrade'];
const steps = actions.map(action => ({ action, attempted: true, status: 'PASS', foreignResourcesUnchanged: true,
  rawEvidencePath: '/fixture/' + action + '.json', screenshotPath: '/fixture/' + action + '.png' }));
let checks = 0;
const check = (input, status, unchanged) => {
  const result = assessResourceProtection({ nonTargetBaselineConfirmed: true, ...input });
  assert.equal(result.status, status); assert.equal(result.otherResourcesUnchanged, unchanged); checks++;
  return result;
};
check({}, 'UNKNOWN', null);
const startupOnly = check({ steps: actions.map(action => ({ action, attempted: false, status: 'UNKNOWN' })), before, after }, 'UNKNOWN', null);
assert.equal(startupOnly.diagnosticBeforeAfterUnchanged, true);
assert.equal(startupOnly.operationCoverageConfirmed, false);
check({ steps: steps.slice(0, 6), before, after }, 'UNKNOWN', null);
const protectedResult = check({ steps, before, after }, 'PASS', true);
assert.equal(protectedResult.protectedSourceBaselineConfirmed, true); assert.equal(protectedResult.protectedSourceSetConfirmed, true);
check({ steps, before, after, nonTargetBaselineConfirmed: false }, 'UNKNOWN', null);
check({ steps, before: { digest: before.digest }, after }, 'UNKNOWN', null);
check({ steps, before: { digest: before.digest, value: { registry: { plugins: {} }, files: {} } }, after }, 'UNKNOWN', null);
check({ steps, before, after: { digest: 'b'.repeat(64) } }, 'FAIL', false);
for (const invalid of [{ attempted: false }, { status: 'UNKNOWN' }, { foreignResourcesUnchanged: null },
  { screenshotPath: null }, { rawEvidencePath: null }, { action: 'install' }]) {
  check({ steps: steps.map((s, i) => i === 0 ? { ...s, ...invalid } : s), before, after }, 'UNKNOWN', null);
}
// A temporary non-target mutation is not erased by identical final snapshots.
check({ steps: steps.map((s, i) => i === 0 ? { ...s, foreignResourcesUnchanged: false } : s), before, after }, 'FAIL', false);
check({ steps, before, after: { digest: 'unreadable' } }, 'UNKNOWN', null);
// Identical hashes/complete seven-step booleans cannot compensate for omitted/incomplete source evidence.
for (const sources of [undefined, [], [{ ...source, files: {} }], [{ ...source, expectedFiles: {} }],
  [{ ...source, files: { ...source.files, 'plugins/fixture/.codebuddy-plugin/plugin.json': 'e'.repeat(64) } }]]) {
  check({ steps, before: { ...before, value: { ...before.value, sources } }, after }, 'UNKNOWN', null);
}
for (const sources of [undefined, [], [{ ...source, marketRoot: '/outside' }], [{ ...source, files: {} }]]) {
  check({ steps, before, after: { ...after, value: { ...after.value, sources } } }, 'UNKNOWN', null);
}
check({ steps, before, after: undefined }, 'UNKNOWN', null);
console.log(JSON.stringify({ status: 'PASS', checks, scope: 'report classification fixtures ONLY; no desktop or resource mutation evidence' }));
