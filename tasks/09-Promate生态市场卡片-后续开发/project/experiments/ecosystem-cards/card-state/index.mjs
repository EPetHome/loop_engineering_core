import { join } from 'node:path';
import { safePath, absolutePath, readSafeFile, record, segment, version, contained, requireSafe } from '../fs-safety.mjs';

/** Read only user-scope facts in the explicitly supplied profile. Never consult HOME or run a host command. */
export async function readCardState({ profile, marketName, pluginName } = {}) {
  const result = { marketRegistered: null, installed: null, enabled: null, version: null, reason: null };
  const snapshots = new Map(), foreignPaths = new Set();
  let profileRoot;
  function load(path, optional = false, ownershipRoot = profileRoot) {
    const info = safePath(path, { missing: optional, owned: true, ownedFrom: ownershipRoot });
    if (!info.exists) { snapshots.set(info.path, { raw: null, ownershipRoot }); return null; }
    const raw = readSafeFile(info.path);
    snapshots.set(info.path, { raw, ownershipRoot });
    const value = JSON.parse(raw.toString('utf8'));
    requireSafe(record(value), 'RECORD_NOT_OBJECT');
    return value;
  }
  try {
    segment(marketName, 'MARKET'); segment(pluginName, 'PLUGIN');
    const root = safePath(profile, { directory: true, owned: true }).path;
    profileRoot = root;
    const markets = load(join(root, 'plugins/known_marketplaces.json'), true);
    const registry = load(join(root, 'plugins/installed_plugins.json'), true);
    const settings = load(join(root, 'settings.json'), true);
    const id = `${pluginName}@${marketName}`;
    if (settings?.enabledPlugins !== undefined) requireSafe(record(settings.enabledPlugins), 'ENABLEMENT_INVALID');
    if (settings?.extraKnownMarketplaces !== undefined) requireSafe(record(settings.extraKnownMarketplaces), 'MARKET_SETTINGS_INVALID');
    const flag = settings?.enabledPlugins?.[id];
    requireSafe(flag === undefined || typeof flag === 'boolean', 'ENABLEMENT_INVALID');
    const known = markets?.[marketName];
    let marketplaceManifest;
    if (known !== undefined) {
      requireSafe(record(known) && known.manifestName === marketName && record(known.source)
        && known.source.source === 'directory' && (known.type === undefined || known.type === 'directory'), 'MARKET_OWNERSHIP_UNPROVEN');
      const sourcePath = safePath(known.source.path, { directory: true, owned: true }).path;
      const location = safePath(known.installLocation, { directory: true, owned: true }).path;
      requireSafe(location === sourcePath || contained(join(root, 'plugins/marketplaces'), location), 'MARKET_LOCATION_CONFLICT');
      marketplaceManifest = load(join(location, '.codebuddy-plugin/marketplace.json'), false, location);
      requireSafe(marketplaceManifest.name === marketName && Array.isArray(marketplaceManifest.plugins)
        && marketplaceManifest.plugins.every(p => record(p) && typeof p.name === 'string')
        && new Set(marketplaceManifest.plugins.map(p => p.name)).size === marketplaceManifest.plugins.length, 'MARKET_MANIFEST_CONFLICT');
      result.marketRegistered = true;
      const overlay = settings?.extraKnownMarketplaces?.[marketName];
      if (overlay !== undefined) requireSafe(record(overlay) && record(overlay.source)
        && overlay.source.source === 'directory' && absolutePath(overlay.source.path) === sourcePath, 'MARKET_SETTINGS_CONFLICT');
    } else {
      requireSafe(settings?.extraKnownMarketplaces?.[marketName] === undefined, 'MARKET_PENDING_OR_CONFLICT');
      result.marketRegistered = false;
    }
    if (registry !== null) requireSafe(registry.version === 2 && record(registry.plugins), 'INSTALL_REGISTRY_INVALID');
    // Ownership is registry-wide, including when the target has no row. A foreign identity
    // claiming this card's cache cannot be reported as enabled OR simply not installed.
    // Compare declarations only: never follow a foreign path or read another profile.
    const comparisonPath = raw => {
      const path = absolutePath(raw);
      return process.platform === 'darwin' ? path.toLowerCase() : path;
    };
    const cardCache = comparisonPath(join(root, 'plugins/cache', marketName, pluginName));
    for (const [otherId, otherRows] of Object.entries(registry?.plugins || {})) {
      if (otherId === id) continue;
      requireSafe(Array.isArray(otherRows) && otherRows.every(record), 'FOREIGN_INSTALL_RECORD_INVALID');
      for (const otherRow of otherRows) {
        requireSafe(['user', 'managed', 'project', 'local'].includes(otherRow.scope), 'FOREIGN_INSTALL_RECORD_INVALID');
        const claimed = comparisonPath(otherRow.installPath);
        requireSafe(claimed !== cardCache && !contained(cardCache, claimed) && !contained(claimed, cardCache),
          'CROSS_IDENTITY_INSTALL_PATH_CONFLICT');
        const declaredPath = absolutePath(otherRow.installPath);
        // Do not follow another profile's path to discover whether it aliases ours.
        // Unproven external declarations are UNKNOWN, never silently treated as disjoint.
        requireSafe(contained(root, declaredPath), 'FOREIGN_INSTALL_PATH_UNPROVEN');
        safePath(declaredPath, { directory: true, missing: true, owned: true, ownedFrom: root });
        foreignPaths.add(declaredPath);
      }
    }
    const rows = registry?.plugins?.[id];
    if (rows !== undefined) {
      requireSafe(Array.isArray(rows) && rows.length === 1 && record(rows[0]) && rows[0].scope === 'user'
        && rows[0].projectPath === undefined, 'INSTALL_SCOPE_OR_IDENTITY_CONFLICT');
      requireSafe(result.marketRegistered === true, 'INSTALLED_MARKET_UNPROVEN');
      const row = rows[0]; version(row.version);
      const expectedPath = join(root, 'plugins/cache', marketName, pluginName, row.version);
      const path = safePath(row.installPath, { directory: true, owned: true, ownedFrom: root }).path;
      requireSafe(path === expectedPath, 'INSTALL_PATH_OWNERSHIP_CONFLICT');
      const manifest = load(join(path, '.codebuddy-plugin/plugin.json'), false, path);
      requireSafe(manifest.name === pluginName && manifest.version === row.version, 'INSTALL_MANIFEST_CONFLICT');
      requireSafe(['skills', 'commands', 'agents', 'hooks', 'mcpServers', 'lspServers'].every(key => manifest[key] === undefined), 'NOT_A_SHELL_CARD');
      const entries = marketplaceManifest.plugins.filter(p => p.name === pluginName);
      requireSafe(entries.length === 1 && typeof entries[0].source === 'string'
        && entries[0].source.startsWith('./') && !entries[0].source.includes('\\') && !entries[0].source.includes('\0')
        && entries[0].source.slice(2).split('/').every(p => p && p !== '.' && p !== '..'), 'CARD_MARKET_IDENTITY_CONFLICT');
      if (entries[0].version !== undefined) version(entries[0].version);
      result.installed = true; result.version = row.version;
      result.enabled = flag === undefined ? null : flag;
      result.reason = flag === undefined ? 'ENABLEMENT_NOT_RECORDED' : (flag ? 'ENABLED' : 'DISABLED');
    } else {
      // Retained caches and stale false flags after uninstall do not prove installation.
      requireSafe(flag !== true, 'ENABLED_WITHOUT_INSTALL_RECORD');
      result.installed = false; result.enabled = false;
      result.reason = 'NOT_INSTALLED';
    }
    // Do not return a normal answer from records that changed while being read.
    for (const [path, { raw: before, ownershipRoot }] of snapshots) {
      const exists = safePath(path, { missing: true, owned: true, ownedFrom: ownershipRoot }).exists;
      requireSafe(before === null ? !exists : exists && readSafeFile(path).equals(before), 'STATE_CHANGED_DURING_READ');
    }
    for (const path of foreignPaths) safePath(path, { directory: true, missing: true, owned: true, ownedFrom: root });
    return result;
  } catch (error) {
    return { marketRegistered: null, installed: null, enabled: null, version: null,
      reason: `STATE_UNKNOWN:${error.code || error.message || 'UNREADABLE'}` };
  }
}
