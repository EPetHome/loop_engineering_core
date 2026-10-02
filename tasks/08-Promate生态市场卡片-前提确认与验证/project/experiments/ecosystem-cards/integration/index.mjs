#!/usr/bin/env node
import { mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { generateMarket } from '../card-generation/index.mjs';
import { readCardState } from '../card-state/index.mjs';
import { requireSafe, safePath } from '../fs-safety.mjs';
import { APP, createIsolation, allocatePort, confirmBoundary, sandboxPolicy, ManagedDesktop } from './isolation.mjs';
import { DesktopCDP } from './cdp.mjs';
import { probeSandboxNesting } from './sandbox-nesting.mjs';
import { confirmCandidate } from './candidate.mjs';
import { sha, fingerprint, asarHeaderDigest, preserveHostLogs, evidenceWorkspace, writeJSON, foreignResources, ownProfileRecords, assessResourceProtection, desktopScreenshot } from './evidence.mjs';

const actions = ['market-visible', 'install', 'disable', 'enable', 'uninstall', 'reinstall', 'upgrade'];
const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
requireSafe(args.includes('--workspace') && args.includes('--report'), 'WORKSPACE_AND_REPORT_REQUIRED');
const reportPath = resolve(value('--report')), workspace = evidenceWorkspace(value('--workspace'), reportPath);
const evidenceRoot = join(workspace, 'desktop-' + randomUUID()); mkdirSync(evidenceRoot, { mode: 0o700 });
let candidateCodeRoot = resolve(dirname(process.argv[1]), '../../..'), candidateFiles, isolation;
// Initialize inside the proven evidence directory BEFORE any candidate/host preflight.
const report = { candidateCodeRoot, candidateDigest: null, candidateFiles: null,
  candidateInvocation: { entryPath: process.argv[1], moduleURL: import.meta.url, cwd: process.cwd() },
  candidateBoundaryConfirmed: false, desktopStartAttempted: false,
  status: 'UNKNOWN', hostVersion: null, profile: null, isolationRoot: null,
  otherResourcesUnchanged: null, resourceProtection: null, managedProcessesStopped: false, evidenceRoot, startedAt: new Date().toISOString(),
  steps: actions.map(action => ({ action, attempted: false, status: 'UNKNOWN', foreignResourcesUnchanged: null,
    rawEvidencePath: join(evidenceRoot, action + '.json'), screenshotPath: null, reason: 'NOT_ATTEMPTED' })) };
let desktop, cdp, interrupted = false, foreignBefore, market, activeStep, nativeStartupFailure;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const logPaths = { stdout: join(evidenceRoot, 'desktop.stdout.log'), stderr: join(evidenceRoot, 'desktop.stderr.log') };
for (const path of Object.values(logPaths)) writeFileSync(path, '', { mode: 0o600 });
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
try {
  report.candidateIdentity = confirmCandidate({ moduleURL: import.meta.url, entryPath: process.argv[1], cwd: process.cwd() });
  candidateCodeRoot = report.candidateCodeRoot = report.candidateIdentity.candidateCodeRoot;
  report.candidateBoundaryConfirmed = true;
  candidateFiles = report.candidateFiles = fingerprint(candidateCodeRoot);
  report.candidateDigest = sha(JSON.stringify(candidateFiles));
  isolation = createIsolation(); report.profile = isolation.profile; report.isolationRoot = isolation.root;
  requireSafe(process.platform === 'darwin', 'REAL_MACOS_WORKBUDDY_REQUIRED');
  const plist = readFileSync(join(APP, 'Info.plist'), 'utf8');
  report.hostVersion = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  requireSafe(report.hostVersion === '5.6.2', 'UNVERIFIED_HOST_BUILD');
  report.hostArtifacts = { infoPlist: sha(plist), asarHeader: asarHeaderDigest(join(APP, 'Resources/app.asar')),
    cliBundle: sha(readFileSync(join(APP, 'Resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs'))) };
  const knownBuild = 'b340564b2410d99846397776a25fd99e11d86647a7c219ad06fedc441e364ddd';
  requireSafe(report.hostArtifacts.cliBundle === knownBuild && report.hostArtifacts.asarHeader === '72df4e8ec84f4058b33df8357abd5a6c0bf18c67cd1d750e8b7c35cd5d6ac21c', 'UNVERIFIED_HOST_BUNDLE');
  report.ownerId = 'loop-card-host-' + randomUUID();
  report.card = { resourceId: 'loop-ecology-shell-probe', name: 'Loop 空壳卡片', description: '本次独立桌面测试，不含技能、代码、钩子或服务', version: '1.0.0' };
  market = await generateMarket({ outputRoot: join(isolation.root, 'generated'), ownerId: report.ownerId,
    marketName: 'loop-ecology-test', card: report.card });
  report.market = market;
  const port = await allocatePort();
  report.boundary = await confirmBoundary(isolation, port); writeJSON(join(evidenceRoot, 'boundary.json'), report.boundary);
  requireSafe(report.boundary.pass, 'ISOLATION_BOUNDARY_NOT_CONFIRMED'); checkAbort();
  // After the boundary probe, remove its now-closed test-server exception. Never widen the sandbox for the host.
  writeFileSync(join(isolation.root, 'sandbox.sb'), sandboxPolicy(isolation.root, [port]), { mode: 0o600 });
  report.desktopPolicy = readFileSync(join(isolation.root, 'sandbox.sb'), 'utf8');
  report.sandboxNesting = await probeSandboxNesting(isolation, port);
  writeJSON(join(evidenceRoot, 'sandbox-nesting.json'), report.sandboxNesting);
  // This is a compatibility diagnostic, not a permission to skip or weaken Chromium's native sandbox.
  checkAbort();
  foreignBefore = foreignResources(isolation.profile, market.marketName, market.pluginName);
  writeJSON(join(evidenceRoot, 'foreign-before.json'), foreignBefore);
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
  report.desktopStartAttempted = true; desktop.start();
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
  // No login, account injection, security bypass, or model requests. A login wall will fail the visible-control checks.
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
      activeStep.nameVerification = await cdp.evaluate(`(()=>{const titles=[...document.querySelectorAll('.cb-plugins-card-name,.cb-plugin-detail-title')].filter(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height).map(e=>e.textContent.trim());return {expected:${JSON.stringify(report.card.name)},titles,correct:titles.includes(${JSON.stringify(report.card.name)})};})()`);
      requireSafe(activeStep.nameVerification.correct === true, 'INPUT_CARD_NAME_NOT_DISPLAYED');
      requireSafe(activeStep.desktopDOM.text.includes(report.card.description), 'CARD_DESCRIPTION_NOT_VISIBLE_ON_DESKTOP');
      activeStep.capture = await desktopScreenshot({ workspace: evidenceRoot, action: step.action, desktop, isolation,
        helperPath: join(dirname(fileURLToPath(import.meta.url)), 'window.jxa'), cdp });
      step.screenshotPath = activeStep.capture.screenshotPath;
      requireSafe(activeStep.capture.status === 'PASS', activeStep.capture.reason);
      activeStep.foreign = foreignResources(isolation.profile, market.marketName, market.pluginName);
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
      activeStep.after = ownProfileRecords(isolation.profile);
      activeStep.foreignResourcesUnchanged = step.foreignResourcesUnchanged;
      activeStep.finishedAt = new Date().toISOString(); writeJSON(step.rawEvidencePath, activeStep);
    }
  }
  report.status = 'PASS';
} catch (error) {
  report.failure = { reason: error.message, stack: error.stack, desktopExit: desktop?.exit, interrupted,
    nativeStartupFailure, originalOutputPaths: logPaths };
  // An owned splash/error window is diagnostic evidence, never a card-operation screenshot.
  if (desktop?.child) try {
    report.failureCapture = await desktopScreenshot({ workspace: evidenceRoot, action: 'startup-failure', desktop, isolation,
      helperPath: join(dirname(fileURLToPath(import.meta.url)), 'window.jxa'), cdp });
  } catch (captureError) { report.failureCapture = { status: 'UNKNOWN', reason: captureError.message }; }
  console.error('HOST_UNVERIFIED=' + error.message);
} finally {
  clearTimeout(deadline); if (cdp) cdp.close();
  try {
    report.cleanup = desktop ? await desktop.stop() : { stopped: true, processes: [], reason: 'DESKTOP_NOT_STARTED' };
    report.managedProcessesStopped = report.cleanup.stopped;
  } catch (error) { report.cleanup = { stopped: false, error: error.stack }; }
  let foreignAfter;
  if (foreignBefore) {
    try { foreignAfter = foreignResources(isolation.profile, market.marketName, market.pluginName); writeJSON(join(evidenceRoot, 'foreign-after.json'), foreignAfter); }
    catch (error) { report.resourceProtectionError = error.message; }
  }
  report.resourceProtection = assessResourceProtection({ steps: report.steps, before: foreignBefore, after: foreignAfter });
  report.otherResourcesUnchanged = report.resourceProtection.otherResourcesUnchanged;
  writeJSON(join(evidenceRoot, 'resource-protection.json'), report.resourceProtection);
  try {
    report.candidateUnchanged = candidateFiles ? JSON.stringify(fingerprint(candidateCodeRoot)) === JSON.stringify(candidateFiles) : null;
    if (candidateFiles) requireSafe(report.candidateUnchanged, 'CANDIDATE_CHANGED_DURING_HOST_TEST');
    const logs = isolation && join(isolation.profile, 'logs');
    if (logs && safePath(logs, { missing: true }).exists) report.originalHostLogs = preserveHostLogs(logs, join(evidenceRoot, 'native-host-logs'));
    if (report.hostArtifacts) {
      report.hostBuildUnchanged = sha(readFileSync(join(APP, 'Info.plist'))) === report.hostArtifacts.infoPlist
        && asarHeaderDigest(join(APP, 'Resources/app.asar')) === report.hostArtifacts.asarHeader;
      requireSafe(report.hostBuildUnchanged, 'HOST_BUILD_CHANGED_DURING_TEST');
    }
  } catch (error) { report.integrityError = error.message; report.status = 'UNKNOWN'; }
  if (!report.managedProcessesStopped || report.otherResourcesUnchanged !== true || report.cleanup?.detachedDetected) report.status = 'UNKNOWN';
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
  writeJSON(reportPath, report);
  process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
}
console.log(JSON.stringify({ status: report.status, reportPath, evidenceRoot, profile: report.profile,
  reason: report.failure?.reason, managedProcessesStopped: report.managedProcessesStopped }));
process.exitCode = report.status === 'PASS' ? 0 : 1;
