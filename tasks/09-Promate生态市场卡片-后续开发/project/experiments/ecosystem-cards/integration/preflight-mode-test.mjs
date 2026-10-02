// Logical fixtures and failure reports only, never real desktop acceptance.
import assert from 'node:assert/strict';
import { assessPreflight, assertPreflightNativeRead, requireCompatibleNesting, desktopActions } from './preflight.mjs';
import { assessResourceProtection } from './evidence.mjs';
import { environment, ManagedDesktop } from './isolation.mjs';
let checks = 0;
const fixture = () => ({
  mode: 'preflight', candidateBoundaryConfirmed: true, candidateUnchanged: true,
  hostVersion: 'fixture-only', hostBuildUnchanged: true, boundary: { pass: true },
  managedProcessesStopped: true, cleanup: { detachedDetected: false },
  steps: desktopActions.map(action => ({ action, attempted: false, status: 'UNKNOWN' })),
  preflight: { profileIsolated: true, nativeProtectionRetained: true, marketPanelVisible: true,
    capture: { status: 'PASS' }, rawEvidencePath: 'logical-fixture-only', screenshotPath: 'logical-fixture-only' },
});
const ready = fixture();
assert.equal(assessPreflight(ready).status, 'PASS');
assert.equal(assessPreflight(ready).otherResourcesUnchanged, null); checks++;
// Identical empty before/after and zero actions still cannot pass full protection.
assert.equal(assessResourceProtection({ steps: ready.steps, before: { digest: 'a'.repeat(64) },
  after: { digest: 'a'.repeat(64) } }).status, 'UNKNOWN'); checks++;
for (const mutate of [
  r => { r.steps[0].attempted = true; },
  r => { r.steps[0].status = 'PASS'; },
  r => { r.steps.pop(); },
  r => { r.steps[0].action = 'install'; },
  r => { r.mode = 'full'; },
  r => { r.candidateBoundaryConfirmed = false; },
  r => { r.candidateUnchanged = false; },
  r => { r.hostBuildUnchanged = false; },
  r => { r.boundary.pass = false; },
  r => { r.preflight.profileIsolated = null; },
  r => { r.preflight.nativeProtectionRetained = null; },
  r => { r.preflight.marketPanelVisible = false; },
  r => { r.preflight.capture.status = 'UNKNOWN'; },
  r => { r.preflight.screenshotPath = null; },
  r => { r.preflight.rawEvidencePath = null; },
  r => { r.managedProcessesStopped = false; },
  r => { r.cleanup.detachedDetected = true; },
  r => { r.failure = { reason: 'fixture-failure' }; },
  r => { r.integrityError = 'fixture-integrity'; },
]) {
  const r = fixture(); mutate(r); assert.equal(assessPreflight(r).status, 'UNKNOWN'); checks++;
}
for (const channel of ['plugin:getMarketplaces', 'plugin:getInstalled', 'plugin:getMarketplacePlugins', 'plugin:getDetail']) {
  assert.doesNotThrow(() => assertPreflightNativeRead(channel)); checks++;
}
for (const channel of ['plugin:install', 'plugin:addMarketplace', 'plugin:update', 'plugin:uninstall', 'plugin:batchToggle',
  'plugin:refreshMarketplace', 'session:sendMessage']) {
  assert.throws(() => assertPreflightNativeRead(channel), /PREFLIGHT_MUTATION_FORBIDDEN/); checks++;
}
assert.doesNotThrow(() => requireCompatibleNesting({ distinctPolicyNestingConfirmed: true })); checks++;
for (const nesting of [null, {}, { distinctPolicyNestingConfirmed: false, reason: 'DISTINCT_NATIVE_SANDBOX_LAYER_DENIED' }]) {
  assert.throws(() => requireCompatibleNesting(nesting), /SANDBOX/); checks++;
}
const isolatedRoot = '/private/tmp/loop-card-logical-fixture';
const launch = new ManagedDesktop({ root: isolatedRoot }, 54321, () => {}).launchSpecification();
assert.equal(launch.detached, false); assert.equal(launch.executable, '/usr/bin/sandbox-exec');
assert.deepEqual(launch.argv, ['-f', isolatedRoot + '/sandbox.sb', '/Applications/WorkBuddy.app/Contents/MacOS/Electron',
  '--user-data-dir=' + isolatedRoot + '/user-data']);
assert.deepEqual(launch.env, environment(isolatedRoot, 54321));
assert.equal(launch.env.WORKBUDDY_CONFIG_DIR, isolatedRoot + '/profile');
assert.equal(launch.env.WORKBUDDY_USER_DATA_DIR, isolatedRoot + '/user-data');
assert.equal(launch.env.HOME, isolatedRoot + '/home');
assert.equal(launch.env.WB_E2E_DISABLE_STARTUP_REPAIR, 'true');
for (const forbidden of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ANTHROPIC_API_KEY', 'CODEBUDDY_API_KEY']) {
  assert.equal(launch.env[forbidden], undefined);
}
checks++;
console.log(JSON.stringify({ status: 'PASS', checks, scope: 'readiness completion, no-operation guard, native compatibility stop, isolated launch allowlist; no desktop started' }));
