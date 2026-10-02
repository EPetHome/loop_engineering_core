import { createHash } from 'node:crypto';
import { readdirSync, lstatSync, readFileSync, readlinkSync, mkdirSync, writeFileSync, openSync, closeSync, readSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { safePath, absolutePath, readSafeFile, contained, requireSafe, record, segment, text } from '../fs-safety.mjs';
import { runBounded, environment } from './isolation.mjs';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function asarHeaderDigest(path) {
  const fd = openSync(path, 'r');
  try {
    const prefix = Buffer.alloc(16); requireSafe(readSync(fd, prefix, 0, 16, 0) === 16, 'ASAR_HEADER_UNREADABLE');
    const length = prefix.readUInt32LE(12); requireSafe(length > 0 && length <= 16 * 1024 * 1024, 'ASAR_HEADER_SIZE_INVALID');
    const header = Buffer.alloc(length); requireSafe(readSync(fd, header, 0, length, 16) === length, 'ASAR_HEADER_UNREADABLE');
    JSON.parse(header.toString()); return sha(header);
  } finally { closeSync(fd); }
}
export function preserveHostLogs(source, destination) {
  const inventory = fingerprint(source);
  const paths = [];
  for (const [name, hash] of Object.entries(inventory)) {
    requireSafe(typeof hash === 'string', 'HOST_LOG_SYMLINK_REJECTED');
    const target = join(destination, name); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const bytes = readFileSync(join(source, name)); requireSafe(sha(bytes) === hash, 'HOST_LOG_CHANGED_DURING_COPY');
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 }); paths.push({ path: target, sourceRelativePath: name, sha256: hash });
  }
  return paths;
}
export function fingerprint(root, { ownedFrom = null } = {}) {
  if (ownedFrom) safePath(root, { directory: true, owned: true, ownedFrom });
  const files = {};
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (ownedFrom) safePath(path, { owned: true, ownedFrom }); // Reject links/unreadable/unowned entries BEFORE reading.
      const stat = lstatSync(path), rel = relative(root, path);
      if (stat.isSymbolicLink()) files[rel] = { link: readlinkSync(path) };
      else if (stat.isDirectory()) walk(path);
      else { requireSafe(stat.isFile(), 'INVENTORY_KIND_INVALID'); files[rel] = sha(ownedFrom ? readSafeFile(path) : readFileSync(path)); }
    }
  }
  walk(root); return files;
}
export function evidenceWorkspace(raw, reportPath) {
  const workspace = resolve(raw);
  safePath(workspace, { directory: true, missing: true, owned: true });
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  safePath(workspace, { directory: true, owned: true });
  requireSafe(contained(workspace, resolve(reportPath)), 'REPORT_OUTSIDE_WORKSPACE');
  safePath(resolve(reportPath), { missing: true, owned: true });
  return workspace;
}
export function writeJSON(path, value) { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }
export function ownProfileRecords(profile) {
  const records = {};
  for (const path of ['plugins/known_marketplaces.json', 'plugins/installed_plugins.json', 'settings.json']) {
    const full = join(profile, path);
    if (!safePath(full, { missing: true }).exists) records[path] = null;
    else records[path] = { raw: readFileSync(full, 'utf8') };
  }
  return records;
}
// Sort object keys only; arrays, unknown fields and non-target values remain significant.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
// Only this run's generated non-target market is eligible. Never discover source paths from registration records.
function protectedSourceSnapshot(protection, targetMarket, targetPlugin) {
  requireSafe(record(protection) && record(protection.market) && record(protection.ownership), 'NON_TARGET_SOURCE_OWNERSHIP_UNPROVEN');
  const { market, ownership, ownerId, isolationToken } = protection;
  segment(market.marketName, 'SOURCE_MARKET'); segment(market.pluginName, 'SOURCE_PLUGIN');
  text(ownerId, 'SOURCE_OWNER', 128); text(market.resourceId, 'SOURCE_RESOURCE', 256); text(isolationToken, 'ISOLATION_TOKEN', 128);
  const isolationRoot = absolutePath(protection.isolationRoot), marketRoot = absolutePath(market.marketRoot);
  requireSafe(contained(isolationRoot, marketRoot)
    && marketRoot === join(isolationRoot, 'non-target-generated', market.marketName), 'NON_TARGET_SOURCE_OUTSIDE_ISOLATION');
  requireSafe(market.marketName !== targetMarket && market.pluginName !== targetPlugin, 'NON_TARGET_SOURCE_IDENTITY_CONFLICT');
  safePath(isolationRoot, { directory: true, owned: true });
  const tokenPath = join(isolationRoot, '.owner'); safePath(tokenPath, { owned: true, ownedFrom: isolationRoot });
  requireSafe(readSafeFile(tokenPath).toString('utf8') === isolationToken, 'ISOLATION_ROOT_OWNER_UNPROVEN');
  safePath(marketRoot, { directory: true, owned: true, ownedFrom: isolationRoot });
  const markerPath = join(marketRoot, '.loop-card-owner.json'); safePath(markerPath, { owned: true, ownedFrom: isolationRoot });
  const marker = JSON.parse(readSafeFile(markerPath).toString('utf8'));
  const required = ['.codebuddy-plugin/marketplace.json', `plugins/${market.pluginName}/.codebuddy-plugin/plugin.json`];
  requireSafe(ownership.format === 1 && ownership.ownerId === ownerId
    && ['marketName', 'pluginName', 'resourceId'].every(key => ownership[key] === market[key])
    && record(ownership.files) && JSON.stringify(Object.keys(ownership.files).sort()) === JSON.stringify(required.sort())
    && Object.values(ownership.files).every(hash => /^[a-f0-9]{64}$/.test(hash))
    && JSON.stringify(canonical(marker)) === JSON.stringify(canonical(ownership)), 'NON_TARGET_SOURCE_OWNERSHIP_UNPROVEN');
  return { isolationRoot, marketRoot, ownerId, marketName: market.marketName, pluginName: market.pluginName, resourceId: market.resourceId,
    ownershipSha256: sha(JSON.stringify(canonical(ownership))), expectedFiles: { ...ownership.files },
    files: fingerprint(marketRoot, { ownedFrom: isolationRoot }) };
}
function completeSourceEvidence(snapshot, baseline = false) {
  const sources = snapshot?.value?.sources;
  if (!Array.isArray(sources) || sources.length !== 1) return false;
  return sources.every(source => {
    if (!record(source) || typeof source.isolationRoot !== 'string' || typeof source.marketRoot !== 'string'
      || !source.isolationRoot.startsWith('/') || !/^[a-z0-9][a-z0-9_-]{0,95}$/.test(source.marketName || '')
      || !/^[a-z0-9][a-z0-9_-]{0,95}$/.test(source.pluginName || '') || !source.ownerId || !source.resourceId
      || source.marketRoot !== join(source.isolationRoot, 'non-target-generated', source.marketName)
      || !/^[a-f0-9]{64}$/.test(source.ownershipSha256 || '') || !record(source.expectedFiles) || !record(source.files)) return false;
    const required = ['.codebuddy-plugin/marketplace.json', `plugins/${source.pluginName}/.codebuddy-plugin/plugin.json`];
    return Object.keys(source.expectedFiles).length === required.length
      && required.every(name => /^[a-f0-9]{64}$/.test(source.expectedFiles[name] || '') && /^[a-f0-9]{64}$/.test(source.files[name] || ''))
      && /^[a-f0-9]{64}$/.test(source.files['.loop-card-owner.json'] || '')
      && Object.values(source.files).every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))
      && (!baseline || Object.keys(source.files).length === required.length + 1 && required.every(name => source.files[name] === source.expectedFiles[name]));
  });
}
export function foreignResources(profile, marketName, pluginName, sourceProtection = null) {
  const sources = sourceProtection === null ? {} : { sources: [protectedSourceSnapshot(sourceProtection, marketName, pluginName)] };
  if (sourceProtection !== null) {
    const isolationRoot = sources.sources[0].isolationRoot;
    requireSafe(absolutePath(profile) === join(isolationRoot, 'profile'), 'NON_TARGET_SOURCE_PROFILE_CONFLICT');
    safePath(profile, { directory: true, owned: true, ownedFrom: isolationRoot });
  }
  const records = ownProfileRecords(profile), id = `${pluginName}@${marketName}`;
  const parse = (name, absent = {}) => {
    const value = records[name] === null ? absent : JSON.parse(records[name].raw);
    requireSafe(record(value), 'FOREIGN_RESOURCE_RECORD_INVALID:' + name); return value;
  };
  const known = parse('plugins/known_marketplaces.json'); delete known[marketName];
  // A missing registry is the native v2 empty registry, not an arbitrary invalid object.
  const registry = parse('plugins/installed_plugins.json', { version: 2, plugins: {} });
  requireSafe(registry.version === 2 && record(registry.plugins), 'FOREIGN_RESOURCE_REGISTRY_INVALID');
  delete registry.plugins[id];
  const settings = parse('settings.json');
  for (const key of ['enabledPlugins', 'extraKnownMarketplaces']) {
    if (settings[key] === undefined) settings[key] = {};
    requireSafe(record(settings[key]), 'FOREIGN_RESOURCE_SETTINGS_INVALID:' + key);
  }
  delete settings.enabledPlugins[id]; delete settings.extraKnownMarketplaces[marketName];
  const pluginRoot = join(profile, 'plugins');
  const files = safePath(pluginRoot, { missing: true }).exists ? fingerprint(pluginRoot) : {};
  for (const name of Object.keys(files)) {
    if (['known_marketplaces.json', 'installed_plugins.json'].includes(name)
      || name.startsWith(`cache/${marketName}/${pluginName}/`) || name.startsWith(`marketplaces/${marketName}/`)
      || /(?:^|\/)(?:\.in_use|\.locks?|[^/]+\.lock)(?:\/|$)/.test(name)) delete files[name];
  }
  const value = canonical({ known, registry, settings, files, ...sources });
  return { digest: sha(JSON.stringify(value)), value };
}
// Startup-only equality is diagnostic, not proof of protection across unperformed operations.
export function assessResourceProtection({ steps = [], before, after, nonTargetBaselineConfirmed = false } = {}) {
  const actions = ['market-visible', 'install', 'disable', 'enable', 'uninstall', 'reinstall', 'upgrade'];
  const comparable = /^[a-f0-9]{64}$/.test(before?.digest || '') && /^[a-f0-9]{64}$/.test(after?.digest || '');
  const diagnosticBeforeAfterUnchanged = comparable ? before.digest === after.digest : null;
  const nonEmptyBaseline = record(before?.value?.registry?.plugins)
    && Object.values(before.value.registry.plugins).some(rows => Array.isArray(rows) && rows.length > 0)
    && record(before?.value?.files) && Object.values(before.value.files).some(hash => /^[a-f0-9]{64}$/.test(hash));
  const protectedSourceBaselineConfirmed = completeSourceEvidence(before, true);
  const sourceIdentity = snapshot => snapshot.value.sources.map(({ files, ...identity }) => canonical(identity));
  const protectedSourceSetConfirmed = protectedSourceBaselineConfirmed && completeSourceEvidence(after)
    && JSON.stringify(sourceIdentity(before)) === JSON.stringify(sourceIdentity(after));
  const ownedNonTargetBaselineConfirmed = nonTargetBaselineConfirmed === true && !!nonEmptyBaseline && protectedSourceBaselineConfirmed;
  const completedActions = steps.filter(s => s.attempted === true && s.status === 'PASS').map(s => s.action);
  const coverage = steps.length === actions.length && actions.every(action => {
    const matching = steps.filter(s => s.action === action);
    return matching.length === 1 && matching[0].attempted === true && matching[0].status === 'PASS'
      && matching[0].foreignResourcesUnchanged === true && !!matching[0].screenshotPath && !!matching[0].rawEvidencePath;
  });
  const observedChange = diagnosticBeforeAfterUnchanged === false || steps.some(s => s.foreignResourcesUnchanged === false);
  const status = observedChange ? 'FAIL' : diagnosticBeforeAfterUnchanged === true && coverage && ownedNonTargetBaselineConfirmed && protectedSourceSetConfirmed ? 'PASS' : 'UNKNOWN';
  return { status, otherResourcesUnchanged: status === 'UNKNOWN' ? null : status === 'PASS',
    diagnosticBeforeAfterUnchanged, completedActions, operationCoverageConfirmed: coverage, ownedNonTargetBaselineConfirmed,
    protectedSourceBaselineConfirmed, protectedSourceSetConfirmed,
    reason: observedChange ? 'NON_TARGET_RESOURCE_CHANGE_OBSERVED' : status === 'PASS' ? 'ALL_DESKTOP_OPERATIONS_PROTECTED'
      : !comparable ? 'RESOURCE_COMPARISON_UNAVAILABLE' : !ownedNonTargetBaselineConfirmed ? 'OWNED_NON_TARGET_BASELINE_UNPROVEN'
        : !protectedSourceSetConfirmed ? 'NON_TARGET_SOURCE_COMPARISON_UNPROVEN' : 'DESKTOP_OPERATION_PROTECTION_UNPROVEN' };
}
export async function desktopScreenshot({ workspace, action, desktop, isolation, helperPath, cdp }) {
  const pids = desktop.track().map(p => String(p.pid));
  const helper = join(isolation.root, 'window-helper.jxa'), helperBytes = readFileSync(helperPath);
  if (safePath(helper, { missing: true, owned: true }).exists) requireSafe(readFileSync(helper).equals(helperBytes), 'CAPTURE_HELPER_CHANGED');
  else writeFileSync(helper, helperBytes, { flag: 'wx', mode: 0o600 });
  const windows = await runBounded('/usr/bin/sandbox-exec', ['-f', join(isolation.root, 'sandbox.sb'),
    '/usr/bin/osascript', '-l', 'JavaScript', helper, ...pids],
    { cwd: isolation.root, env: environment(isolation.root, desktop.port) });
  let list = [];
  try { list = JSON.parse(windows.stdout); } catch {}
  const target = list.filter(w => w.onScreen && w.pid === desktop.child.pid && w.bounds.Width >= 200 && w.bounds.Height >= 200)
    .sort((a, b) => b.bounds.Width * b.bounds.Height - a.bounds.Width * a.bounds.Height)[0];
  const screenshotPath = join(workspace, action + '.png');
  if (target) {
    requireSafe(/^[a-z-]+$/.test(action), 'CAPTURE_ACTION_INVALID');
    const isolatedImage = join(isolation.root, action + '.window.png');
    const capture = await runBounded('/usr/bin/sandbox-exec', ['-f', join(isolation.root, 'sandbox.sb'),
      '/usr/sbin/screencapture', '-x', '-l', String(target.id), isolatedImage],
      { cwd: isolation.root, env: environment(isolation.root, desktop.port) }, 10000);
    if (capture.code === 0 && safePath(isolatedImage, { missing: true, owned: true }).exists
      && readFileSync(isolatedImage).subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
      const bytes = readFileSync(isolatedImage); writeFileSync(screenshotPath, bytes, { flag: 'wx', mode: 0o600 });
      return { status: 'PASS', screenshotPath, windows, target, capture, isolatedImage, sha256: sha(bytes) };
    }
    return { status: 'UNKNOWN', screenshotPath: null, windows, target, capture, reason: 'NATIVE_WINDOW_CAPTURE_FAILED' };
  }
  // Diagnostic only. A renderer image without proof of an onscreen native window cannot pass S4.
  let diagnosticScreenshotPath;
  try {
    const reply = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    diagnosticScreenshotPath = join(workspace, action + '.renderer-diagnostic.png');
    writeFileSync(diagnosticScreenshotPath, Buffer.from(reply.data, 'base64'), { mode: 0o600 });
  } catch {}
  return { status: 'UNKNOWN', screenshotPath: null, diagnosticScreenshotPath, windows, reason: 'OWNED_ONSCREEN_WINDOW_UNPROVEN' };
}
