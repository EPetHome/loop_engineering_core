// Filesystem fixtures ONLY: never discover or modify a real host profile.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { foreignResources, fingerprint } from './evidence.mjs';
import { generateMarket } from '../card-generation/index.mjs';

const marketName = 'owned-market', pluginName = 'target-card', id = `${pluginName}@${marketName}`;
const foreignId = 'other-card@other-market';
function fixture(t, populated = false) {
  const root = mkdtempSync('/private/tmp/loop-card-foreign-unit-'), profile = join(root, 'profile');
  mkdirSync(profile, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = { known: join(profile, 'plugins/known_marketplaces.json'),
    registry: join(profile, 'plugins/installed_plugins.json'), settings: join(profile, 'settings.json') };
  const put = (path, data) => { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, JSON.stringify(data), { mode: 0o600 }); };
  const known = {}, registry = { version: 2, plugins: {} }, settings = {};
  const foreignFile = join(profile, 'plugins/cache/other-market/other-card/3.0.0/.codebuddy-plugin/plugin.json');
  if (populated) {
    known['other-market'] = { source: { source: 'directory', path: join(root, 'other-market') }, lastUpdated: 'fixture' };
    registry.plugins[foreignId] = [{ scope: 'user', installPath: dirname(dirname(foreignFile)), version: '3.0.0', lastUpdated: 'fixture' }];
    settings.enabledPlugins = { [foreignId]: true };
    settings.extraKnownMarketplaces = { 'other-market': { source: { source: 'directory', path: join(root, 'other-market') } } };
    settings.theme = 'dark';
    put(foreignFile, { name: 'other-card', version: '3.0.0' });
  }
  const save = () => { put(paths.known, known); put(paths.registry, registry); put(paths.settings, settings); };
  const installTarget = () => {
    known[marketName] = { source: { source: 'directory', path: join(root, 'target-market') } };
    registry.plugins[id] = [{ scope: 'user', version: '1.0.0', installPath: join(profile, 'plugins/cache', marketName, pluginName, '1.0.0') }];
    settings.enabledPlugins ??= {}; settings.enabledPlugins[id] = true;
    settings.extraKnownMarketplaces ??= {}; settings.extraKnownMarketplaces[marketName] = known[marketName];
    put(join(profile, 'plugins/cache', marketName, pluginName, '1.0.0/.codebuddy-plugin/plugin.json'), { name: pluginName, version: '1.0.0' });
    save();
  };
  if (populated) save();
  return { root, profile, paths, put, known, registry, settings, foreignFile, save, installTarget,
    snapshot: () => foreignResources(profile, marketName, pluginName) };
}

async function sourceFixture(t) {
  const f = fixture(t, true), ownerId = 'source-protection-unit', isolationToken = 'owned-fixture-token';
  writeFileSync(join(f.root, '.owner'), isolationToken, { mode: 0o600 });
  const market = await generateMarket({ outputRoot: join(f.root, 'non-target-generated'), ownerId,
    marketName: 'source-market', card: { resourceId: 'source-card', name: 'Non-target fixture', description: 'unchanged', version: '1.0.0' } });
  const ownership = JSON.parse(readFileSync(join(market.marketRoot, '.loop-card-owner.json'), 'utf8'));
  const protection = { isolationRoot: f.root, isolationToken, ownerId, market, ownership };
  const pluginFile = join(market.marketRoot, 'plugins', market.pluginName, '.codebuddy-plugin/plugin.json');
  const sourceId = `${market.pluginName}@${market.marketName}`;
  f.known[market.marketName] = { source: { source: 'directory', path: market.marketRoot }, manifestName: market.marketName };
  const cache = join(f.profile, 'plugins/cache', market.marketName, market.pluginName, '1.0.0');
  f.registry.plugins[sourceId] = [{ scope: 'user', installPath: cache, version: '1.0.0' }];
  f.settings.enabledPlugins[sourceId] = true;
  f.put(join(cache, '.codebuddy-plugin/plugin.json'), JSON.parse(readFileSync(pluginFile, 'utf8'))); f.save();
  return { ...f, market, pluginFile, protection,
    snapshot: () => foreignResources(f.profile, marketName, pluginName, protection) };
}

test('P2-1 source-only plugin description change is detected without touching profile or cache', async t => {
  const f = await sourceFixture(t), before = f.snapshot(), profileBefore = fingerprint(f.profile);
  const plugin = JSON.parse(readFileSync(f.pluginFile, 'utf8'));
  f.put(f.pluginFile, { ...plugin, description: 'changed in source only' });
  assert.deepEqual(fingerprint(f.profile), profileBefore);
  assert.notEqual(f.snapshot().digest, before.digest, 'non-target generated source must enter the snapshot');
});

test('owned source manifest, plugin manifest and package file additions/deletions enter the snapshot', async t => {
  const f = await sourceFixture(t), before = f.snapshot().digest;
  for (const file of [join(f.market.marketRoot, '.codebuddy-plugin/marketplace.json'), f.pluginFile]) {
    const bytes = readFileSync(file), json = JSON.parse(bytes);
    f.put(file, { ...json, description: 'source mutation' }); assert.notEqual(f.snapshot().digest, before);
    writeFileSync(file, bytes); assert.equal(f.snapshot().digest, before);
  }
  const added = join(f.market.marketRoot, 'plugins', f.market.pluginName, 'extra.txt');
  writeFileSync(added, 'new file', { mode: 0o600 }); const withAdded = f.snapshot().digest;
  assert.notEqual(withAdded, before); rmSync(added); assert.notEqual(f.snapshot().digest, withAdded); assert.equal(f.snapshot().digest, before);
  rmSync(f.pluginFile); assert.notEqual(f.snapshot().digest, before, 'deletion of original plugin file');
});

test('owned source disappearance and unreadability reject comparison', async t => {
  const f = await sourceFixture(t);
  chmodSync(f.pluginFile, 0o000);
  try { assert.throws(f.snapshot, /PATH_UNREADABLE/); } finally { chmodSync(f.pluginFile, 0o600); }
  chmodSync(f.market.marketRoot, 0o000);
  try { assert.throws(f.snapshot, /PATH_UNREADABLE/); } finally { chmodSync(f.market.marketRoot, 0o700); }
  rmSync(f.market.marketRoot, { recursive: true }); assert.throws(f.snapshot, /ENOENT/);
});

test('source links, including linked files, directories and source root, are rejected', async t => {
  const f = await sourceFixture(t), link = join(f.market.marketRoot, 'linked');
  for (const target of [f.foreignFile, f.profile]) {
    symlinkSync(target, link); assert.throws(f.snapshot, /SYMLINK_REJECTED/); rmSync(link);
  }
  rmSync(f.market.marketRoot, { recursive: true }); symlinkSync(f.profile, f.market.marketRoot);
  assert.throws(f.snapshot, /SYMLINK_REJECTED/);
});

test('source traversal, wrong generated location and unknown ownership are rejected', async t => {
  const f = await sourceFixture(t);
  const snapshot = protection => foreignResources(f.profile, marketName, pluginName, protection);
  for (const marketRoot of [f.profile, join(f.root, 'generated', f.market.marketName), join(f.root, '..', 'not-owned')]) {
    assert.throws(() => snapshot({ ...f.protection, market: { ...f.market, marketRoot } }), /NON_TARGET_SOURCE_OUTSIDE_ISOLATION/);
  }
  assert.throws(() => snapshot({ ...f.protection, market: { ...f.market, marketRoot: f.root + '/../not-owned' } }), /PATH_INVALID/);
  for (const protection of [{}, { ...f.protection, ownership: null }, { ...f.protection, ownerId: 'unknown-owner' },
    { ...f.protection, isolationToken: 'unknown-token' }]) assert.throws(() => snapshot(protection), /OWNERSHIP_UNPROVEN|OWNER_UNPROVEN/);
  const marker = join(f.market.marketRoot, '.loop-card-owner.json');
  f.put(marker, { ...f.protection.ownership, ownerId: 'unknown-owner' }); assert.throws(f.snapshot, /OWNERSHIP_UNPROVEN/);
  rmSync(marker); assert.throws(f.snapshot, /ENOENT/);
});

test('same owned source stays protected through target updates; registered arbitrary paths are never scanned', async t => {
  const f = await sourceFixture(t), before = f.snapshot().digest, bytesBefore = fingerprint(f.market.marketRoot);
  f.installTarget(); assert.equal(f.snapshot().digest, before);
  f.registry.plugins[id][0].version = '1.0.1'; f.settings.enabledPlugins[id] = false; f.save();
  f.put(join(f.profile, 'plugins/cache', marketName, pluginName, '1.0.1/.codebuddy-plugin/plugin.json'), { name: pluginName, version: '1.0.1' });
  assert.equal(f.snapshot().digest, before); assert.deepEqual(fingerprint(f.market.marketRoot), bytesBefore);
  f.known['unowned-declaration'] = { source: { source: 'directory', path: join(f.root, 'never-created') } }; f.save();
  assert.doesNotThrow(f.snapshot, 'registration declarations are values, NOT scan instructions');
  assert.notEqual(foreignResources(f.profile, marketName, pluginName).digest, f.snapshot().digest, 'omitting source context cannot match protected baseline');
});

test('only target install and valid empty containers equal missing registrations', t => {
  const f = fixture(t), before = f.snapshot();
  f.installTarget();
  assert.equal(f.snapshot().digest, before.digest);
  delete f.known[marketName]; delete f.registry.plugins[id];
  delete f.settings.enabledPlugins[id]; delete f.settings.extraKnownMarketplaces[marketName]; f.save();
  assert.equal(f.snapshot().digest, before.digest);
});

test('empty enablement and marketplace settings maps equal absent maps', t => {
  const f = fixture(t), before = f.snapshot();
  f.put(f.paths.settings, {}); assert.equal(f.snapshot().digest, before.digest);
  f.put(f.paths.settings, { enabledPlugins: {}, extraKnownMarketplaces: {} });
  assert.equal(f.snapshot().digest, before.digest);
});

test('target disable/enable/upgrade do not change populated non-target digest', t => {
  const f = fixture(t, true), before = f.snapshot().digest;
  f.installTarget(); assert.equal(f.snapshot().digest, before);
  for (const enabled of [false, true]) {
    f.settings.enabledPlugins[id] = enabled; f.save(); assert.equal(f.snapshot().digest, before);
  }
  f.registry.plugins[id][0].version = '1.0.1'; f.save();
  f.put(join(f.profile, 'plugins/cache', marketName, pluginName, '1.0.1/.codebuddy-plugin/plugin.json'), { name: pluginName, version: '1.0.1' });
  assert.equal(f.snapshot().digest, before);
});

test('non-target disable and enable are detected', t => {
  const f = fixture(t, true), before = f.snapshot().digest;
  f.settings.enabledPlugins[foreignId] = false; f.save();
  const disabled = f.snapshot().digest; assert.notEqual(disabled, before);
  f.settings.enabledPlugins[foreignId] = true; f.save();
  assert.notEqual(f.snapshot().digest, disabled); assert.equal(f.snapshot().digest, before);
});

test('non-target registry fields and global metadata remain protected', t => {
  const f = fixture(t, true), before = f.snapshot().digest;
  for (const [field, value] of [['lastUpdated', 'changed'], ['version', '3.0.1'], ['scope', 'managed'], ['unknownField', 'preserve-me']]) {
    const original = f.registry.plugins[foreignId][0][field];
    f.registry.plugins[foreignId][0][field] = value; f.save(); assert.notEqual(f.snapshot().digest, before, field);
    if (original === undefined) delete f.registry.plugins[foreignId][0][field];
    else f.registry.plugins[foreignId][0][field] = original;
    f.save(); assert.equal(f.snapshot().digest, before);
  }
  f.registry.metadata = { origin: 'non-target' }; f.save(); assert.notEqual(f.snapshot().digest, before);
});

test('non-target marketplace records and unrelated settings remain protected', t => {
  const f = fixture(t, true), before = f.snapshot().digest;
  f.known['other-market'].lastUpdated = 'changed'; f.save(); assert.notEqual(f.snapshot().digest, before);
  f.known['other-market'].lastUpdated = 'fixture'; f.save(); assert.equal(f.snapshot().digest, before);
  f.settings.extraKnownMarketplaces['other-market'].autoUpdate = true; f.save(); assert.notEqual(f.snapshot().digest, before);
  delete f.settings.extraKnownMarketplaces['other-market'].autoUpdate;
  f.settings.theme = 'light'; f.save(); assert.notEqual(f.snapshot().digest, before);
});

test('non-target file content including sibling cache in target market is protected', t => {
  const f = fixture(t, true), before = f.snapshot().digest;
  f.put(f.foreignFile, { name: 'other-card', version: '3.0.1' }); assert.notEqual(f.snapshot().digest, before);
  f.put(f.foreignFile, { name: 'other-card', version: '3.0.0' }); assert.equal(f.snapshot().digest, before);
  const sibling = join(f.profile, 'plugins/cache', marketName, 'non-target-card/1.0.0/.codebuddy-plugin/plugin.json');
  f.put(sibling, { name: 'non-target-card', version: '1.0.0' }); const withSibling = f.snapshot().digest;
  f.put(sibling, { name: 'non-target-card', version: '1.0.1' }); assert.notEqual(f.snapshot().digest, withSibling);
});

test('JSON key ordering and whitespace do not report semantic changes; reader is read-only', t => {
  const f = fixture(t, true), before = f.snapshot().digest;
  const reverse = value => Array.isArray(value) ? value.map(reverse)
    : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverse(v)])) : value;
  for (const path of Object.values(f.paths)) writeFileSync(path, JSON.stringify(reverse(JSON.parse(readFileSync(path))), null, 2));
  const bytesBefore = fingerprint(f.profile);
  assert.equal(f.snapshot().digest, before); assert.deepEqual(fingerprint(f.profile), bytesBefore);
});

test('malformed root records, maps and registry versions fail closed, never normalize to empty', t => {
  const f = fixture(t);
  for (const [path, values] of [
    [f.paths.known, [null, []]],
    [f.paths.registry, [null, [], {}, { version: 3, plugins: {} }, { version: 2, plugins: [] }]],
    [f.paths.settings, [null, [], { enabledPlugins: null }, { enabledPlugins: [] }, { extraKnownMarketplaces: [] }]],
  ]) {
    for (const value of values) {
      f.put(path, value); assert.throws(f.snapshot, undefined, JSON.stringify(value)); rmSync(path);
    }
  }
});
