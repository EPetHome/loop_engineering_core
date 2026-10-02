#!/usr/bin/env node
import { mkdirSync, writeFileSync, readFileSync, appendFileSync, readdirSync, lstatSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { generateMarket } from '../card-generation/index.mjs';
import { readCardState } from '../card-state/index.mjs';
import { requireSafe, safePath, readJSON } from '../fs-safety.mjs';
import { APP, createIsolation, allocatePort, confirmBoundary, sandboxPolicy, ManagedDesktop } from './isolation.mjs';
import { DesktopCDP } from './cdp.mjs';
import { targetVersionExpression, targetVersionEvidenceMatches } from './target-version.mjs';
import { probeSandboxNesting } from './sandbox-nesting.mjs';
import { confirmCandidate } from './candidate.mjs';
import { inspectCurrentHost } from './readiness-inspect.mjs';
import { desktopActions as actions, assertPreflightNativeRead, requireCompatibleNesting, assessPreflight } from './preflight.mjs';
import { sha, fingerprint, asarHeaderDigest, preserveHostLogs, evidenceWorkspace, writeJSON, foreignResources, ownProfileRecords, assessResourceProtection, desktopScreenshot } from './evidence.mjs';

const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
const preflightOnly = args.includes('--preflight-only'), technicalProbe = args.includes('--technical-probe');
requireSafe(args.includes('--workspace') && args.includes('--report'), 'WORKSPACE_AND_REPORT_REQUIRED');
const reportPath = resolve(value('--report')), workspace = evidenceWorkspace(value('--workspace'), reportPath);
const evidenceRoot = join(workspace, 'desktop-' + randomUUID()); mkdirSync(evidenceRoot, { mode: 0o700 });
let candidateCodeRoot = resolve(dirname(process.argv[1]), '../../..'), candidateFiles, isolation;
// Initialize inside the proven evidence directory BEFORE any candidate/host preflight.
const report = { mode: preflightOnly ? 'preflight' : 'full', phase: 'initialized',
  verificationScope: preflightOnly ? 'desktop-readiness' : technicalProbe ? 'native-ascii-technical-probe' : 'unconfirmed-product-name',
  businessAcceptance: 'NOT_VERIFIED', nonTargetBaselineConfirmed: false, nonTargetFixture: null,
  candidateCodeRoot, candidateDigest: null, candidateFiles: null,
  preflight: preflightOnly ? { profileIsolated: null, nativeProtectionRetained: null, marketPanelVisible: null,
    rawEvidencePath: join(evidenceRoot, 'preflight.json'), screenshotPath: null,
    nameMappingSource: 'experiments/ecosystem-cards/readiness-source.json' } : null,
  candidateInvocation: { entryPath: process.argv[1], moduleURL: import.meta.url, cwd: process.cwd() },
  candidateUnchanged: null, hostBuildUnchanged: null,
  candidateBoundaryConfirmed: false, desktopStartAttempted: false,
  status: 'UNKNOWN', hostVersion: null, profile: null, isolationRoot: null,
  otherResourcesUnchanged: null, resourceProtection: null, managedProcessesStopped: false, evidenceRoot, startedAt: new Date().toISOString(),
  steps: actions.map(action => ({ action, attempted: false, status: 'UNKNOWN', foreignResourcesUnchanged: null,
    rawEvidencePath: join(evidenceRoot, action + '.json'), screenshotPath: null, reason: 'NOT_ATTEMPTED' })) };
let desktop, cdp, interrupted = false, foreignBefore, snapshotForeign, market, activeStep, nativeStartupFailure;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const logPaths = { stdout: join(evidenceRoot, 'desktop.stdout.log'), stderr: join(evidenceRoot, 'desktop.stderr.log') };
for (const path of Object.values(logPaths)) writeFileSync(path, '', { mode: 0o600 });
writeJSON(reportPath, report); // Persist an UNKNOWN report even if any subsequent precondition fails.
const checkAbort = () => requireSafe(!interrupted, 'HOST_RUN_INTERRUPTED');
const interrupt = () => { interrupted = true; cdp?.close(); desktop?.child?.kill('SIGTERM'); };
process.on('SIGTERM', interrupt); process.on('SIGINT', interrupt);
const deadline = setTimeout(interrupt, 600000);
async function poll(fn, timeout = 30000) {
  const until = Date.now() + timeout;
  do {
    checkAbort(); requireSafe(!nativeStartupFailure, nativeStartupFailure);
    const result = await fn(); if (result) return result;
    if (desktop?.exit) throw new Error('DESKTOP_EXITED_BEFORE_READY');
    await sleep(300);
  } while (Date.now() < until);
  throw new Error('DESKTOP_EXPECTATION_TIMEOUT');
}
async function native(channel, ...params) {
  if (preflightOnly) assertPreflightNativeRead(channel);
  const reply = await cdp.evaluate(`window.__wbInvoke(${JSON.stringify(channel)},undefined,...${JSON.stringify(params)})`, 25000);
  requireSafe(reply && !reply.__wbError, 'NATIVE_DESKTOP_RPC_REJECTED:' + JSON.stringify(reply)); return reply;
}
async function nativeSnapshot() {
  return { markets: await native('plugin:getMarketplaces', true), installed: await native('plugin:getInstalled', true),
    cards: await native('plugin:getMarketplacePlugins', market.marketName, true) };
}
async function visible(selector) {
  return await cdp.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e?.getBoundingClientRect();return !!(r&&r.width&&r.height);})()`);
}
async function clickAnyText(candidates) {
  for (const text of candidates) {
    const found = await cdp.evaluate(`Array.from(document.querySelectorAll('button,a,span,div')).some(e=>e.textContent.trim()===${JSON.stringify(text)}&&e.getBoundingClientRect().width&&e.getBoundingClientRect().height)`);
    if (found) { await cdp.clickText(text); return; }
  }
  throw new Error('NATIVE_PLUGIN_CONTROL_UNAVAILABLE:' + candidates.join('|'));
}
async function openDetail() {
  if (await visible('.cb-plugin-detail-title')) {
    const name = await cdp.evaluate(`document.querySelector('.cb-plugin-detail-title')?.textContent`);
    requireSafe(name === market.pluginName, 'WRONG_PLUGIN_DETAIL'); return;
  }
  await cdp.clickCard(market.pluginName, '.cb-plugins-card-name');
  await poll(() => visible('.cb-plugin-detail-title'));
  requireSafe(await cdp.evaluate(`document.querySelector('.cb-plugin-detail-title').textContent`) === market.pluginName, 'WRONG_PLUGIN_DETAIL');
}
async function perform(action) {
  requireSafe(!preflightOnly, 'PREFLIGHT_BUSINESS_OPERATION_FORBIDDEN');
  if (action === 'market-visible') {
    const added = await native('plugin:addMarketplace', market.marketRoot, market.marketName, false);
    requireSafe(added.success === true, 'DIRECTORY_MARKET_REJECTED:' + JSON.stringify(added));
    activeStep.marketRegistrationOutput = added;
    await clickAnyText(['插件市场', 'Plugin Marketplace', '插件', 'Plugins']);
    await poll(() => visible('.cb-plugins-card'));
    await clickAnyText([market.marketName]);
    await poll(async () => await cdp.evaluate(`Array.from(document.querySelectorAll('.cb-plugins-card-name')).some(e=>e.textContent.trim()===${JSON.stringify(market.pluginName)})`));
  } else if (action === 'install' || action === 'reinstall') {
    if (await visible('.cb-plugin-detail-title')) {
      await openDetail(); await cdp.click('.cb-plugin-detail-install-btn:not([disabled])');
    } else {
      await cdp.clickCard(market.pluginName, '.cb-plugins-card-install-btn');
      if (await visible('.cb-plugins-card-install-dropdown')) await cdp.clickCard(market.pluginName, '.cb-plugins-card-install-dropdown .cb-plugins-card-dropdown-item');
    }
  } else if (action === 'disable' || action === 'enable') {
    await openDetail();
    if (await visible('.cb-plugin-detail-toggle input')) await cdp.click('.cb-plugin-detail-toggle input');
    else {
      await cdp.click('.cb-plugin-detail-more-btn');
      await clickAnyText(action === 'disable' ? ['停用', '禁用', 'Disable', '停用（用户）', '禁用（用户）', 'Disable (User)'] : ['启用', 'Enable', '启用（用户）', 'Enable (User)']);
    }
  } else if (action === 'uninstall') {
    await openDetail(); await cdp.click('.cb-plugin-detail-more-btn');
    await cdp.click('.cb-plugin-detail-dropdown-item--danger');
  } else if (action === 'upgrade') {
    const next = await generateMarket({ outputRoot: join(isolation.root, 'generated'), ownerId: report.ownerId,
      marketName: market.marketName, card: { ...report.card, version: '1.0.1' } });
    requireSafe(next.resourceId === market.resourceId && next.pluginName === market.pluginName && next.marketRoot === market.marketRoot, 'UPGRADE_IDENTITY_CHANGED');
    const refreshed = await native('plugin:refreshMarketplace', market.marketName);
    activeStep.refreshOutput = refreshed; requireSafe(refreshed.success === true, 'NATIVE_MARKET_REFRESH_FAILED');
    await openDetail(); await cdp.click('.cb-plugin-detail-more-btn');
    await cdp.click('.cb-plugin-detail-dropdown-item'); // Native detail menu's first item is Upgrade.
  }
}
function stateExpected(action, state) {
  if (state.marketRegistered !== true) return false;
  if (action === 'market-visible' || action === 'uninstall') return state.installed === false;
  return state.installed === true && state.enabled === (action !== 'disable') && state.version === (action === 'upgrade' ? '1.0.1' : '1.0.0');
}
async function prepareNonTargetFixture() {
  const fixture = report.nonTargetFixture = { rawEvidencePath: join(evidenceRoot, 'non-target-baseline.json'), confirmed: false };
  try {
    const processes = desktop.track();
    requireSafe(!desktop.detachedDetected && !desktop.trackingError
      && !processes.some(p => /--(?:no-sandbox|disable-.*sandbox)(?:[ =]|$)/.test(p.command)), 'NATIVE_PROTECTION_NOT_RETAINED');
    fixture.market = await generateMarket({ outputRoot: join(isolation.root, 'non-target-generated'), ownerId: report.ownerId,
      marketName: 'loop-non-target-test', card: { resourceId: 'loop-non-target-shell-probe', name: 'Non-target protection fixture',
        description: '本次原生安装的非目标空壳测试资源，不含业务内容', version: '1.0.0' } });
    const other = fixture.market;
    requireSafe(other.marketName !== market.marketName && other.pluginName !== market.pluginName, 'NON_TARGET_IDENTITY_CONFLICT');
    const ownership = readJSON(join(other.marketRoot, '.loop-card-owner.json'));
    const sourceProtection = fixture.sourceProtection = Object.freeze({ isolationRoot: isolation.root, isolationToken: isolation.token,
      ownerId: report.ownerId, market: Object.freeze({ ...other }), ownership: Object.freeze({ ...ownership, files: Object.freeze({ ...ownership.files }) }) });
    // Bind the same generated/owned source to preparation, EVERY step and exit; registrations never supply scan paths.
    snapshotForeign = () => foreignResources(isolation.profile, market.marketName, market.pluginName, sourceProtection);
    // Provision through the genuine host service, never by writing settings or installation records.
    fixture.registrationOutput = await native('plugin:addMarketplace', other.marketRoot, other.marketName, false);
    requireSafe(fixture.registrationOutput.success === true, 'NON_TARGET_MARKET_REGISTRATION_FAILED');
    fixture.installOutput = await native('plugin:install', [other.pluginName], other.marketName, 'user');
    requireSafe(fixture.installOutput.success === true, 'NON_TARGET_NATIVE_INSTALL_FAILED');
    fixture.stateArgs = { profile: isolation.profile, marketName: other.marketName, pluginName: other.pluginName };
    fixture.state = await poll(async () => {
      const state = await readCardState(fixture.stateArgs);
      return state.marketRegistered === true && state.installed === true && state.enabled === true && state.version === '1.0.0' ? state : null;
    });
    fixture.nativeInstalled = await native('plugin:getInstalled', true);
    const matching = fixture.nativeInstalled.filter(p => p.name === other.pluginName && p.marketplaceName === other.marketName);
    requireSafe(matching.length === 1 && matching[0].version === '1.0.0' && matching[0].status === 'enabled', 'NON_TARGET_NATIVE_STATE_UNPROVEN');
    foreignBefore = snapshotForeign();
    const otherId = `${other.pluginName}@${other.marketName}`;
    requireSafe(foreignBefore.value.registry.plugins[otherId]?.length === 1
      && foreignBefore.value.settings.enabledPlugins[otherId] === true
      && Object.keys(foreignBefore.value.files).some(name => name.startsWith(`cache/${other.marketName}/${other.pluginName}/`)),
      'NON_TARGET_BASELINE_EMPTY_OR_EXCLUDED');
    const source = foreignBefore.value.sources[0];
    requireSafe(source.marketRoot === other.marketRoot && Object.keys(source.files).length === Object.keys(ownership.files).length + 1
      && Object.entries(ownership.files).every(([name, hash]) => source.files[name] === hash), 'NON_TARGET_SOURCE_BASELINE_INCOMPLETE');
    fixture.confirmed = report.nonTargetBaselineConfirmed = true;
    fixture.baselineDigest = foreignBefore.digest;
    writeJSON(join(evidenceRoot, 'foreign-before.json'), foreignBefore);
  } finally {
    fixture.profileRecords = ownProfileRecords(isolation.profile);
    writeJSON(fixture.rawEvidencePath, fixture);
  }
}
try {
  report.candidateIdentity = confirmCandidate({ moduleURL: import.meta.url, entryPath: process.argv[1], cwd: process.cwd() });
  candidateCodeRoot = report.candidateCodeRoot = report.candidateIdentity.candidateCodeRoot;
  report.candidateBoundaryConfirmed = true;
  candidateFiles = report.candidateFiles = fingerprint(candidateCodeRoot);
  report.candidateDigest = sha(JSON.stringify(candidateFiles));
  report.phase = 'candidate-confirmed'; writeJSON(reportPath, report);
  // Product naming is not approved yet. Only an explicitly labelled ASCII probe may exercise full mode.
  requireSafe(preflightOnly || technicalProbe, 'NAME_SCHEME_UNCONFIRMED');
  isolation = createIsolation(); report.profile = isolation.profile; report.isolationRoot = isolation.root;
  report.freshIsolation = ['home', 'profile', 'user-data', 'workspace'].map(name => {
    const path = join(isolation.root, name), info = lstatSync(path);
    return { path, uid: info.uid, mode: info.mode & 0o777, dev: String(info.dev), ino: String(info.ino),
      empty: readdirSync(path).length === 0, noSymlink: !info.isSymbolicLink() };
  });
  requireSafe(report.freshIsolation.every(p => p.uid === process.getuid() && p.mode === 0o700 && p.empty && p.noSymlink), 'FRESH_PROFILE_UNPROVEN');
  report.profileBefore = ownProfileRecords(isolation.profile);
  report.phase = 'fresh-profile-created'; writeJSON(reportPath, report);
  requireSafe(process.platform === 'darwin', 'REAL_MACOS_WORKBUDDY_REQUIRED');
  const plist = readFileSync(join(APP, 'Info.plist'), 'utf8');
  report.hostVersion = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  requireSafe(report.hostVersion === '5.6.2', 'UNVERIFIED_HOST_BUILD');
  report.hostArtifacts = { infoPlist: sha(plist), asarHeader: asarHeaderDigest(join(APP, 'Resources/app.asar')),
    cliBundle: sha(readFileSync(join(APP, 'Resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs'))) };
  const knownBuild = 'b340564b2410d99846397776a25fd99e11d86647a7c219ad06fedc441e364ddd';
  requireSafe(report.hostArtifacts.cliBundle === knownBuild && report.hostArtifacts.asarHeader === '72df4e8ec84f4058b33df8357abd5a6c0bf18c67cd1d750e8b7c35cd5d6ac21c', 'UNVERIFIED_HOST_BUNDLE');
  report.currentHostSource = inspectCurrentHost();
  requireSafe(report.currentHostSource.observed.mainWindowNativeProtectionConfigured
    && report.currentHostSource.observed.macOSDoesNotUseWindowsNoSandboxBranch, 'NATIVE_PROTECTION_CONFIGURATION_UNPROVEN');
  writeJSON(join(evidenceRoot, 'host-source.json'), report.currentHostSource);
  // Readiness never generates/registers a card or performs any of the seven business operations.
  if (!preflightOnly) {
    report.ownerId = 'loop-card-host-' + randomUUID();
    report.card = { resourceId: 'loop-ecology-shell-probe', name: 'Loop 空壳卡片', description: '本次独立桌面测试，不含技能、代码、钩子或服务', version: '1.0.0' };
    market = await generateMarket({ outputRoot: join(isolation.root, 'generated'), ownerId: report.ownerId,
      marketName: 'loop-ecology-test', card: report.card });
    report.market = market;
    report.expectedTitle = market.pluginName; // Technical sample only; not the Chinese resource-name requirement.
  }
  const port = await allocatePort();
  report.cdpPort = port;
  report.desktopLaunchPlan = new ManagedDesktop(isolation, port, () => {}).launchSpecification();
  report.boundary = await confirmBoundary(isolation, port); writeJSON(join(evidenceRoot, 'boundary.json'), report.boundary);
  requireSafe(report.boundary.pass, 'ISOLATION_BOUNDARY_NOT_CONFIRMED'); checkAbort();
  // After the boundary probe, remove its now-closed test-server exception. Never widen the sandbox for the host.
  writeFileSync(join(isolation.root, 'sandbox.sb'), sandboxPolicy(isolation.root, [port]), { mode: 0o600 });
  report.desktopPolicy = readFileSync(join(isolation.root, 'sandbox.sb'), 'utf8');
  report.phase = 'boundary-confirmed'; writeJSON(reportPath, report);
  report.sandboxNesting = await probeSandboxNesting(isolation, port);
  writeJSON(join(evidenceRoot, 'sandbox-nesting.json'), report.sandboxNesting);
  report.phase = 'native-compatibility-probed'; writeJSON(reportPath, report);
  // Fail closed BEFORE the known-incompatible desktop launch, never retry it or weaken Chromium.
  requireCompatibleNesting(report.sandboxNesting); checkAbort();
  let stderrTail = '';
  desktop = new ManagedDesktop(isolation, port, (stream, bytes) => {
    appendFileSync(logPaths[stream], bytes);
    if (stream === 'stderr') {
      stderrTail = (stderrTail + bytes.toString()).slice(-8192);
      if (/sandbox initialization failed: Operation not permitted/.test(stderrTail)) {
        nativeStartupFailure = 'NATIVE_CHROMIUM_SANDBOX_INITIALIZATION_DENIED';
      }
    }
  });
  report.desktopLaunch = desktop.launchSpecification();
  report.phase = 'desktop-starting'; report.desktopStartAttempted = true; writeJSON(reportPath, report);
  desktop.start();
  report.listener = await poll(() => desktop.proveListener(), 45000);
  // The first target is normally the real splash window, not the application renderer.
  const target = await poll(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
    writeJSON(join(evidenceRoot, 'cdp-targets.json'), targets);
    return targets.find(t => t.type === 'page' && t.url.startsWith('file://' + APP + '/Resources/app.asar/renderer/'));
  }, 45000);
  requireSafe(new URL(target.webSocketDebuggerUrl).port === String(port), 'OWNED_DESKTOP_RENDERER_NOT_AVAILABLE');
  const transcript = join(evidenceRoot, 'cdp-raw.jsonl');
  cdp = new DesktopCDP(target.webSocketDebuggerUrl, event => appendFileSync(transcript, JSON.stringify(event) + '\n', { mode: 0o600 }));
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  report.desktopIdentity = await poll(async () => {
    const identity = await cdp.evaluate('({profile:window.workbuddyDesktop?.configDir,version:window.workbuddyDesktop?.appVersion,url:location.href})');
    return identity?.profile ? identity : null;
  });
  requireSafe(report.desktopIdentity.profile === isolation.profile && report.desktopIdentity.version === report.hostVersion, 'DESKTOP_PROFILE_OR_BUILD_UNPROVEN');
  report.phase = 'desktop-identity-confirmed'; writeJSON(reportPath, report);
  // No login, account injection, security bypass, or model requests. A login wall fails the visible-control checks.
  if (preflightOnly) {
    report.preflight.profileIsolated = report.boundary.pass === true && report.desktopIdentity.profile === isolation.profile;
    report.preflight.nativeProcesses = desktop.track();
    requireSafe(!desktop.detachedDetected && !desktop.trackingError
      && !report.preflight.nativeProcesses.some(p => /--(?:no-sandbox|disable-.*sandbox)(?:[ =]|$)/.test(p.command)), 'NATIVE_PROTECTION_NOT_RETAINED');
    report.preflight.nativeProtectionRetained = true;
    await clickAnyText(['插件市场', 'Plugin Marketplace', '插件', 'Plugins']);
    report.preflight.marketObservation = await poll(async () => {
      const result = await cdp.evaluate(`(()=>{const selectors=['.cb-plugins-header','.cb-plugins-marketplace-tabs','.cb-plugins-marketplace-add-btn'];const controls=selectors.map(selector=>{const e=document.querySelector(selector),r=e?.getBoundingClientRect(),s=e&&getComputedStyle(e);return {selector,visible:!!(r&&r.width&&r.height&&s.visibility!=='hidden'&&s.display!=='none'),text:e?.textContent.trim()};});return {url:location.href,title:document.title,controls,visible:controls.every(c=>c.visible),text:document.body.innerText};})()`);
      return result?.visible ? result : null;
    });
    report.preflight.nativeMarkets = await native('plugin:getMarketplaces', true);
    requireSafe(Array.isArray(report.preflight.nativeMarkets), 'NATIVE_MARKETPLACE_READ_UNPROVEN');
    report.preflight.capture = await desktopScreenshot({ workspace: evidenceRoot, action: 'preflight', desktop, isolation,
      helperPath: join(dirname(fileURLToPath(import.meta.url)), 'window.jxa'), cdp });
    report.preflight.screenshotPath = report.preflight.capture.screenshotPath;
    requireSafe(report.preflight.capture.status === 'PASS', report.preflight.capture.reason);
    report.preflight.marketPanelVisible = true;
  } else {
    await prepareNonTargetFixture();
    for (const step of report.steps) {
    step.attempted = true;
    activeStep = { action: step.action, attempted: true, status: 'UNKNOWN', startedAt: new Date().toISOString(), candidateDigest: report.candidateDigest,
      desktopIdentity: report.desktopIdentity, listener: report.listener, before: ownProfileRecords(isolation.profile) };
    try {
      await perform(step.action);
      activeStep.state = await poll(async () => {
        const state = await readCardState({ profile: isolation.profile, marketName: market.marketName, pluginName: market.pluginName });
        return stateExpected(step.action, state) ? state : null;
      });
      activeStep.native = await nativeSnapshot();
      requireSafe(Array.isArray(activeStep.native.cards) && activeStep.native.cards.filter(p => p.name === market.pluginName).length === 1, 'NATIVE_CARD_IDENTITY_UNPROVEN');
      const installed = activeStep.native.installed.filter(p => p.name === market.pluginName && p.marketplaceName === market.marketName);
      requireSafe(activeStep.state.installed ? installed.length === 1 && installed[0].version === activeStep.state.version
        && installed[0].status === (activeStep.state.enabled ? 'enabled' : 'disabled') : installed.length === 0, 'NATIVE_AND_DISK_STATE_CONFLICT');
      requireSafe(!desktop.detachedDetected && !desktop.trackingError, 'CHILD_PROCESS_BOUNDARY_UNPROVEN');
      activeStep.desktopDOM = await cdp.evaluate('({title:document.title,url:location.href,text:document.body.innerText})');
      activeStep.nameVerification = await cdp.evaluate(`(()=>{const titles=[...document.querySelectorAll('.cb-plugins-card-name,.cb-plugin-detail-title')].filter(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height).map(e=>e.textContent.trim());return {scope:${JSON.stringify(report.verificationScope)},expected:${JSON.stringify(report.expectedTitle)},titles,correct:titles.includes(${JSON.stringify(report.expectedTitle)})};})()`);
      const versionTarget = { pluginName: market.pluginName, marketName: market.marketName,
        expectedVersion: activeStep.state.version || report.card.version, scope: report.verificationScope };
      activeStep.versionVerification = await cdp.evaluate(targetVersionExpression(versionTarget));
      requireSafe(activeStep.nameVerification.correct === true, 'EXPECTED_NATIVE_CARD_NAME_NOT_DISPLAYED');
      requireSafe(activeStep.desktopDOM.text.includes(report.card.description), 'CARD_DESCRIPTION_NOT_VISIBLE_ON_DESKTOP');
      requireSafe(targetVersionEvidenceMatches(activeStep.versionVerification, versionTarget),
        activeStep.versionVerification?.reason || 'TARGET_VERSION_OBSERVATION_UNAVAILABLE');
      activeStep.nonTargetState = await readCardState(report.nonTargetFixture.stateArgs);
      requireSafe(JSON.stringify(activeStep.nonTargetState) === JSON.stringify(report.nonTargetFixture.state), 'NON_TARGET_STATE_CHANGED');
      activeStep.capture = await desktopScreenshot({ workspace: evidenceRoot, action: step.action, desktop, isolation,
        helperPath: join(dirname(fileURLToPath(import.meta.url)), 'window.jxa'), cdp });
      step.screenshotPath = activeStep.capture.screenshotPath;
      requireSafe(activeStep.capture.status === 'PASS', activeStep.capture.reason);
      activeStep.foreign = snapshotForeign();
      step.foreignResourcesUnchanged = activeStep.foreign.digest === foreignBefore.digest;
      requireSafe(step.foreignResourcesUnchanged, 'OTHER_RESOURCES_CHANGED');
      activeStep.status = step.status = 'PASS'; step.reason = 'NATIVE_DESKTOP_AND_READ_ONLY_STATE_CONFIRMED';
    } catch (error) {
      step.reason = error.message; activeStep.error = error.stack;
      activeStep.after = ownProfileRecords(isolation.profile);
      if (!activeStep.desktopDOM) try { activeStep.desktopDOM = await cdp.evaluate('({title:document.title,url:location.href,text:document.body.innerText})'); } catch {}
      if (!activeStep.capture) try { activeStep.capture = await desktopScreenshot({ workspace: evidenceRoot, action: step.action,
        desktop, isolation, helperPath: join(dirname(fileURLToPath(import.meta.url)), 'window.jxa'), cdp }); step.screenshotPath = activeStep.capture.screenshotPath; } catch (e) { activeStep.captureError = e.message; }
      throw error;
    } finally {
      // Failure evidence also observes the SAME protected source, not just profile records.
      if (!activeStep.foreign) try {
        activeStep.foreign = snapshotForeign();
        step.foreignResourcesUnchanged = activeStep.foreign.digest === foreignBefore.digest;
      } catch (error) { activeStep.foreignSnapshotError = error.message; step.foreignResourcesUnchanged = null; }
      activeStep.after = ownProfileRecords(isolation.profile);
      activeStep.foreignResourcesUnchanged = step.foreignResourcesUnchanged;
      activeStep.finishedAt = new Date().toISOString(); writeJSON(step.rawEvidencePath, activeStep);
    }
    }
  }
  report.status = 'PASS';
} catch (error) {
  report.failure = { reason: error.message, stack: error.stack, phase: report.phase,
    classification: /SANDBOX|NATIVE_CHROMIUM|ISOLATION_BOUNDARY/.test(error.message) ? 'environment-precondition' : 'unverified',
    desktopExit: desktop?.exit, interrupted, nativeStartupFailure, originalOutputPaths: logPaths };
  // An owned splash/error window is diagnostic evidence, never a card-operation screenshot.
  if (desktop?.child) try {
    report.failureCapture = await desktopScreenshot({ workspace: evidenceRoot, action: 'startup-failure', desktop, isolation,
      helperPath: join(dirname(fileURLToPath(import.meta.url)), 'window.jxa'), cdp });
  } catch (captureError) { report.failureCapture = { status: 'UNKNOWN', reason: captureError.message }; }
  console.error('HOST_UNVERIFIED=' + error.message);
} finally {
  clearTimeout(deadline); if (cdp) cdp.close();
  try {
    report.cleanup = desktop ? await desktop.stop() : { stopped: true, processes: [], remaining: [],
      detachedDetected: false, reason: 'DESKTOP_NOT_STARTED' };
    // Each bounded diagnostic was awaited through close; the inner probe used spawnSync, not a detached job.
    report.cleanup.diagnostics = [report.boundary, report.sandboxNesting?.innerControl, ...(report.sandboxNesting?.runs || [])]
      .filter(Boolean).map(run => ({ pid: run.pid, code: run.code, signal: run.signal, timedOut: run.timedOut,
        nested: run.nested, command: run.command, closeAwaited: true }));
    report.managedProcessesStopped = report.cleanup.stopped;
  } catch (error) { report.cleanup = { stopped: false, error: error.stack }; }
  let foreignAfter;
  if (foreignBefore) {
    try { foreignAfter = snapshotForeign(); writeJSON(join(evidenceRoot, 'foreign-after.json'), foreignAfter); }
    catch (error) { report.resourceProtectionError = error.message; }
  }
  report.resourceProtection = assessResourceProtection({ steps: report.steps, before: foreignBefore, after: foreignAfter,
    nonTargetBaselineConfirmed: report.nonTargetBaselineConfirmed });
  report.otherResourcesUnchanged = report.resourceProtection.otherResourcesUnchanged;
  writeJSON(join(evidenceRoot, 'resource-protection.json'), report.resourceProtection);
  try {
    report.candidateUnchanged = candidateFiles ? JSON.stringify(fingerprint(candidateCodeRoot)) === JSON.stringify(candidateFiles) : null;
    if (candidateFiles) requireSafe(report.candidateUnchanged, 'CANDIDATE_CHANGED_DURING_HOST_TEST');
    if (preflightOnly && isolation) report.preflight.profileAfter = ownProfileRecords(isolation.profile);
    const logs = isolation && join(isolation.profile, 'logs');
    if (logs && safePath(logs, { missing: true }).exists) report.originalHostLogs = preserveHostLogs(logs, join(evidenceRoot, 'native-host-logs'));
    if (report.hostArtifacts) {
      report.hostBuildUnchanged = sha(readFileSync(join(APP, 'Info.plist'))) === report.hostArtifacts.infoPlist
        && asarHeaderDigest(join(APP, 'Resources/app.asar')) === report.hostArtifacts.asarHeader
        && sha(readFileSync(join(APP, 'Resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs'))) === report.hostArtifacts.cliBundle;
      requireSafe(report.hostBuildUnchanged, 'HOST_BUILD_CHANGED_DURING_TEST');
    }
  } catch (error) { report.integrityError = error.message; report.status = 'UNKNOWN'; }
  if (preflightOnly) {
    report.preflight.assessment = assessPreflight(report);
    report.status = report.preflight.assessment.status;
    report.otherResourcesUnchanged = null; // Unperformed operations are not resource-protection evidence.
  } else if (!report.managedProcessesStopped || report.otherResourcesUnchanged !== true || report.cleanup?.detachedDetected) report.status = 'UNKNOWN';
  report.finishedAt = new Date().toISOString();
  report.recovery = { isolationRoot: isolation?.root || null, ownerToken: isolation?.token || null, retained: true,
    desktopStartAttempted: report.desktopStartAttempted,
    instruction: '保留整个隔离根和本次证据；不得删除用户资料、未知进程或未知临时目录。只按cleanup中的精确PID和启动时间核对本次进程。' };
  writeJSON(join(evidenceRoot, 'recovery.json'), report.recovery);
  for (const step of report.steps) if (step.reason === 'NOT_ATTEMPTED') {
    step.reason = report.failure?.reason || 'PRIOR_STEP_UNVERIFIED';
    writeJSON(step.rawEvidencePath, { action: step.action, status: 'UNKNOWN', reason: step.reason, attempted: false,
      candidateDigest: report.candidateDigest, originalOutputPaths: logPaths, boundary: report.boundary,
      sandboxNesting: report.sandboxNesting, resourceProtection: report.resourceProtection, cleanup: report.cleanup });
  }
  if (preflightOnly) {
    writeJSON(report.preflight.rawEvidencePath, { mode: 'preflight', status: report.status,
      candidateCodeRoot: report.candidateCodeRoot, candidateDigest: report.candidateDigest,
      candidateIdentity: report.candidateIdentity, candidateInvocation: report.candidateInvocation,
      candidateUnchanged: report.candidateUnchanged, hostVersion: report.hostVersion,
      hostArtifacts: report.hostArtifacts, hostBuildUnchanged: report.hostBuildUnchanged,
      currentHostSource: report.currentHostSource, profile: report.profile, freshIsolation: report.freshIsolation,
      profileBefore: report.profileBefore, desktopIdentity: report.desktopIdentity,
      plannedLaunch: report.desktopLaunchPlan || null,
      actualLaunch: report.desktopLaunch || null, desktopStartAttempted: report.desktopStartAttempted,
      boundary: report.boundary, desktopPolicy: report.desktopPolicy, sandboxNesting: report.sandboxNesting,
      preflight: report.preflight, businessStepsAttempted: report.steps.some(s => s.attempted),
      originalOutputPaths: logPaths, stdout: readFileSync(logPaths.stdout, 'utf8'), stderr: readFileSync(logPaths.stderr, 'utf8'),
      originalHostLogs: report.originalHostLogs, failure: report.failure, failureCapture: report.failureCapture,
      cleanup: report.cleanup, recovery: report.recovery, startedAt: report.startedAt, finishedAt: report.finishedAt });
  }
  report.phase = 'finished'; writeJSON(reportPath, report);
  process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
}
console.log(JSON.stringify({ status: report.status, verificationScope: report.verificationScope, businessAcceptance: report.businessAcceptance,
  reportPath, evidenceRoot, profile: report.profile,
  reason: report.failure?.reason, managedProcessesStopped: report.managedProcessesStopped }));
process.exitCode = report.status === 'PASS' ? 0 : 1;
