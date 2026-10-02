import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, chmodSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { generateMarket } from './card-generation/index.mjs';
import { readCardState } from './card-state/index.mjs';

const root = mkdtempSync('/private/tmp/loop-card-unit-');
const put = (file, data) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify(data)); };
const json = file => JSON.parse(readFileSync(file));
const input = { ownerId: 'unit-test', marketName: 'unit-market', card: { resourceId: 'test-resource', name: '空壳测试', description: '只有卡片，不含业务内容', version: '1.0.0' } };
let checks = 0;
function snapshot(dir) {
  const result = {};
  function walk(d) {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n), stat = lstatSync(p);
      if (stat.isSymbolicLink()) result[relative(dir, p)] = 'symlink';
      else if (stat.isDirectory()) walk(p);
      else result[relative(dir, p)] = readFileSync(p).toString('base64');
    }
  }
  walk(dir); return result;
}
const outputRoot = join(root, 'output');
const first = await generateMarket({ ...input, outputRoot });
const before = snapshot(first.marketRoot);
assert.deepEqual(await generateMarket({ ...input, outputRoot }), first); checks++;
assert.deepEqual(snapshot(first.marketRoot), before); checks++;
const next = await generateMarket({ ...input, outputRoot, card: { ...input.card, name: '改名', version: '1.0.1' } });
assert.equal(next.pluginName, first.pluginName); assert.equal(next.marketRoot, first.marketRoot); checks++;
const pluginFile = join(first.marketRoot, 'plugins', first.pluginName, '.codebuddy-plugin/plugin.json');
assert.deepEqual(json(pluginFile), { name: first.pluginName, displayName: '改名', description: input.card.description, version: '1.0.1' }); checks++;
assert.deepEqual(Object.keys(snapshot(join(first.marketRoot, 'plugins'))), [first.pluginName + '/.codebuddy-plugin/plugin.json']); checks++;
async function rejected(change) {
  const old = snapshot(first.marketRoot);
  await assert.rejects(generateMarket({ ...input, outputRoot, ...change }));
  assert.deepEqual(snapshot(first.marketRoot), old); checks++;
}
await rejected({ ownerId: 'foreign' });
for (const marketName of ['../outside', '/absolute', 'a/b', 'a\\b', '.', '..', 'bad@market']) await rejected({ marketName });
await rejected({ card: { ...input.card, resourceId: 'other' } });
await rejected({ card: { ...input.card, version: '01.0.0' } });
symlinkSync(outputRoot, join(root, 'output-link'));
await rejected({ outputRoot: join(root, 'output-link') });
const originalPlugin = readFileSync(pluginFile);
writeFileSync(pluginFile, '{bad'); await rejected({}); writeFileSync(pluginFile, originalPlugin);
writeFileSync(join(first.marketRoot, 'unowned'), 'untouched'); await rejected({}); unlinkSync(join(first.marketRoot, 'unowned'));
mkdirSync(join(first.marketRoot, 'foreign-empty')); await rejected({}); rmSync(join(first.marketRoot, 'foreign-empty'), { recursive: true });
const rename = fs.renameSync;
try {
  fs.renameSync = (from, to) => {
    if (from.includes('.stage-') && to === first.marketRoot) throw Object.assign(new Error('injected rename IO failure'), { code: 'EIO' });
    return rename(from, to);
  };
  syncBuiltinESMExports();
  await rejected({ card: { ...input.card, version: '1.0.2' } });
} finally { fs.renameSync = rename; syncBuiltinESMExports(); }
unlinkSync(pluginFile); symlinkSync(join(root, 'fictional-canary'), pluginFile); await rejected({}); unlinkSync(pluginFile); writeFileSync(pluginFile, originalPlugin);
chmodSync(outputRoot, 0o500); await rejected({}); chmodSync(outputRoot, 0o700);
const unknownRoot = join(root, 'unknown'); mkdirSync(join(unknownRoot, input.marketName), { recursive: true });
writeFileSync(join(unknownRoot, input.marketName, 'foreign'), 'untouched');
await assert.rejects(generateMarket({ ...input, outputRoot: unknownRoot })); checks++;

const profile = join(root, 'profile'); mkdirSync(profile);
const args = { profile, marketName: input.marketName, pluginName: first.pluginName }, id = `${args.pluginName}@${args.marketName}`;
assert.deepEqual(await readCardState(args), { marketRegistered: false, installed: false, enabled: false, version: null, reason: 'NOT_INSTALLED' }); checks++;
const installPath = join(profile, 'plugins/cache', args.marketName, args.pluginName, '1.0.1');
const market = { [args.marketName]: { source: { source: 'directory', path: first.marketRoot }, installLocation: first.marketRoot, manifestName: args.marketName } };
const registry = { version: 2, plugins: { [id]: [{ scope: 'user', installPath, version: '1.0.1' }] } };
const knownFile = join(profile, 'plugins/known_marketplaces.json'), registryFile = join(profile, 'plugins/installed_plugins.json'), settingsFile = join(profile, 'settings.json');
put(join(installPath, '.codebuddy-plugin/plugin.json'), json(pluginFile));
function reset() { put(knownFile, market); put(registryFile, registry); put(settingsFile, { enabledPlugins: { [id]: true } }); }
async function state(expected) { const before = snapshot(profile); const result = await readCardState(args); assert.deepEqual(snapshot(profile), before); for (const [key, value] of Object.entries(expected)) assert.equal(result[key], value); checks++; return result; }
reset(); await state({ marketRegistered: true, installed: true, enabled: true, version: '1.0.1' });
put(settingsFile, { enabledPlugins: { [id]: false } }); await state({ installed: true, enabled: false });
put(registryFile, { version: 2, plugins: {} }); await state({ installed: false, version: null });
put(settingsFile, { enabledPlugins: { [id]: true } }); await state({ installed: null });
for (const file of [knownFile, registryFile, settingsFile]) { reset(); writeFileSync(file, '{bad'); assert.ok((await state({ installed: null })).reason); }
for (const file of [knownFile, registryFile, settingsFile]) { reset(); const bytes = readFileSync(file); unlinkSync(file); symlinkSync(join(root, 'fictional-canary'), file); await state({ installed: null }); unlinkSync(file); writeFileSync(file, bytes); }
reset(); put(settingsFile, {}); await state({ installed: true, enabled: null });
reset(); put(registryFile, { version: 2, plugins: { [id]: [...registry.plugins[id], ...registry.plugins[id]] } }); await state({ installed: null });
const foreignId = 'foreign-card@other-market';
for (const claimedPath of [installPath, installPath.replace('/private/tmp/', '/tmp/'), join(installPath, '..'), join(installPath, '../1.0.0')]) {
  // Normalize test declarations to valid absolute paths; '/tmp' is the system alias.
  reset(); put(registryFile, { version: 2, plugins: { ...registry.plugins,
    [foreignId]: [{ scope: 'user', installPath: claimedPath, version: '1.0.1' }] } });
  assert.match((await state({ installed: null, enabled: null, version: null })).reason, /CROSS_IDENTITY_INSTALL_PATH_CONFLICT/);
}
reset(); put(registryFile, { version: 2, plugins: { [foreignId]: registry.plugins[id] } });
assert.match((await state({ installed: null })).reason, /CROSS_IDENTITY_INSTALL_PATH_CONFLICT/);
reset(); put(registryFile, { version: 2, plugins: { ...registry.plugins, [foreignId]: { installPath } } }); await state({ installed: null });
reset(); put(registryFile, { version: 2, plugins: { ...registry.plugins,
  [foreignId]: [{ scope: 'user', installPath: join(profile, 'plugins/cache/other-market/foreign-card/1.0.0'), version: '1.0.0' }] } });
await state({ installed: true, enabled: true });
if (process.platform === 'darwin') {
  reset(); put(registryFile, { version: 2, plugins: { ...registry.plugins,
    [foreignId]: [{ scope: 'user', installPath: installPath.toUpperCase(), version: '1.0.1' }] } });
  assert.match((await state({ installed: null })).reason, /CROSS_IDENTITY_INSTALL_PATH_CONFLICT/);
}
const foreignLink = join(profile, 'foreign-install'); symlinkSync(installPath, foreignLink);
reset(); put(registryFile, { version: 2, plugins: { ...registry.plugins,
  [foreignId]: [{ scope: 'user', installPath: foreignLink, version: '1.0.1' }] } });
assert.match((await state({ installed: null })).reason, /SYMLINK_REJECTED/); unlinkSync(foreignLink);
const outsideForeignLink = join(root, 'external-foreign-install'); symlinkSync(installPath, outsideForeignLink);
reset(); put(registryFile, { version: 2, plugins: { ...registry.plugins,
  [foreignId]: [{ scope: 'user', installPath: outsideForeignLink, version: '1.0.1' }] } });
assert.match((await state({ installed: null })).reason, /FOREIGN_INSTALL_PATH_UNPROVEN/); unlinkSync(outsideForeignLink);
reset(); put(registryFile, { version: 2, plugins: { ...registry.plugins,
  [foreignId]: [{ installPath: join(profile, 'plugins/cache/other-market/foreign-card/1.0.0') }] } });
assert.match((await state({ installed: null })).reason, /FOREIGN_INSTALL_RECORD_INVALID/);
reset(); put(registryFile, { version: 2, plugins: { [id]: [{ ...registry.plugins[id][0], scope: 'project' }] } }); await state({ installed: null });
reset(); put(registryFile, { version: 2, plugins: { [id]: [{ ...registry.plugins[id][0], installPath: first.marketRoot }] } }); await state({ installed: null });
reset(); put(knownFile, { [args.marketName]: { ...market[args.marketName], manifestName: 'foreign' } }); await state({ installed: null });
reset(); put(settingsFile, { enabledPlugins: { [id]: 'true' } }); await state({ installed: null });
reset(); put(settingsFile, { extraKnownMarketplaces: [] }); await state({ installed: null });
reset(); chmodSync(join(profile, 'plugins'), 0o777); await state({ installed: null }); chmodSync(join(profile, 'plugins'), 0o755);
reset(); put(settingsFile, { enabledPlugins: { [id]: true }, extraKnownMarketplaces: { [args.marketName]: { source: { source: 'directory', path: root } } } }); await state({ installed: null });
reset(); const installedManifest = join(installPath, '.codebuddy-plugin/plugin.json'); put(installedManifest, { name: args.pluginName, version: '1.0.0' }); await state({ installed: null });
put(installedManifest, json(pluginFile)); chmodSync(registryFile, 0); const denied = await readCardState(args); assert.equal(denied.installed, null); checks++; chmodSync(registryFile, 0o600);
reset(); symlinkSync(profile, join(root, 'profile-link')); assert.equal((await readCardState({ ...args, profile: join(root, 'profile-link') })).installed, null); checks++;
assert.equal((await readCardState({ ...args, profile: join(root, 'missing-profile') })).installed, null); checks++;
console.log(JSON.stringify({ status: 'PASS', checks, root, scope: 'isolated unit fixtures, not desktop evidence' }));
// Only this test-created root; no profile discovery or global cleanup.
rmSync(root, { recursive: true, force: true });
