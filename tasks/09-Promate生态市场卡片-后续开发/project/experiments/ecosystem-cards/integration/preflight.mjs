// Separate readiness completion from seven-operation resource protection; these are never interchangeable.
import { requireSafe } from '../fs-safety.mjs';

export const desktopActions = ['market-visible', 'install', 'disable', 'enable', 'uninstall', 'reinstall', 'upgrade'];
export function assertPreflightNativeRead(channel) {
  requireSafe(['plugin:getMarketplaces', 'plugin:getInstalled', 'plugin:getMarketplacePlugins', 'plugin:getDetail'].includes(channel),
    'PREFLIGHT_MUTATION_FORBIDDEN:' + channel);
}
export function requireCompatibleNesting(nesting) {
  requireSafe(nesting?.distinctPolicyNestingConfirmed === true,
    nesting?.reason || 'NATIVE_SANDBOX_COMPATIBILITY_UNPROVEN');
}
export function assessPreflight(report) {
  const notAttempted = report.steps?.length === desktopActions.length && desktopActions.every(action => {
    const matching = report.steps.filter(step => step.action === action);
    return matching.length === 1 && matching[0].attempted === false && matching[0].status !== 'PASS';
  });
  const required = {
    correctMode: report.mode === 'preflight',
    candidate: report.candidateBoundaryConfirmed === true && report.candidateUnchanged === true,
    host: !!report.hostVersion && report.hostBuildUnchanged === true,
    boundary: report.boundary?.pass === true,
    isolatedProfile: report.preflight?.profileIsolated === true,
    nativeProtection: report.preflight?.nativeProtectionRetained === true,
    visibleMarketplace: report.preflight?.marketPanelVisible === true,
    realCapture: report.preflight?.capture?.status === 'PASS' && !!report.preflight.screenshotPath,
    originalEvidence: !!report.preflight?.rawEvidencePath,
    noBusinessSteps: !!notAttempted,
    cleanup: report.managedProcessesStopped === true && report.cleanup?.detachedDetected !== true,
    noFailure: !report.failure && !report.integrityError,
  };
  const pass = Object.values(required).every(value => value === true);
  return { status: pass ? 'PASS' : 'UNKNOWN', checks: required,
    reason: pass ? 'ISOLATED_NATIVE_MARKETPLACE_READY' : 'PREFLIGHT_INCOMPLETE',
    // Deliberately not a seven-step protection result, even on a readiness PASS.
    otherResourcesUnchanged: null };
}
