// Frozen task-specific contract; filesystem-only, no host/profile discovery.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, lstatSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const code = resolve(process.argv[2]);
const root = mkdtempSync('/private/tmp/loop-card-name-contract-');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const within = (parent, child) => { const part = relative(parent, child); assert.ok(part && part !== '..' && !part.startsWith('../') && !isAbsolute(part)); };
function snapshot(dir) {
  return Object.fromEntries(readdirSync(dir).sort().map(name => {
    const path = join(dir, name), stat = lstatSync(path);
    assert.ok(!stat.isSymbolicLink());
    return [name, stat.isDirectory() ? snapshot(path) : readFileSync(path).toString('base64')];
  }));
}
try {
  const { generateMarket } = await import(pathToFileURL(join(code, 'experiments/ecosystem-cards/card-generation/index.mjs')));
  const input = { outputRoot: join(root, 'output'), ownerId: 'cards03-acceptance', marketName: 'promate-ecology-test',
    card: { resourceId: 'promate-shell-resource', name: 'promate-shell', description: 'Promate 空壳卡片：本机验证', version: '1.0.0' } };
  const first = await generateMarket(input);
  within(realpathSync(root), realpathSync(first.marketRoot)); snapshot(first.marketRoot);
  assert.equal(first.pluginName, input.card.name, '原生安装键和可读英文名称必须一致，不能继续使用摘要名');
  assert.equal(first.resourceId, input.card.resourceId); assert.equal(first.marketName, input.marketName);
  const manifestPath = join(first.marketRoot, '.codebuddy-plugin/marketplace.json');
  const manifest = json(manifestPath);
  assert.equal(manifest.name, input.marketName); assert.equal(manifest.plugins.length, 1); assert.equal(manifest.plugins[0].name, input.card.name);
  const pluginPath = resolve(first.marketRoot, manifest.plugins[0].source, '.codebuddy-plugin/plugin.json');
  within(realpathSync(first.marketRoot), realpathSync(pluginPath));
  assert.deepEqual(Object.keys(snapshot(resolve(pluginPath, '../..'))), ['.codebuddy-plugin']);
  const plugin = json(pluginPath);
  assert.equal(plugin.name, input.card.name); assert.equal(plugin.description, input.card.description); assert.equal(plugin.version, '1.0.0');
  const repeated = await generateMarket(input);
  assert.equal(repeated.pluginName, first.pluginName); assert.equal(repeated.marketRoot, first.marketRoot);
  const upgraded = await generateMarket({ ...input, card: { ...input.card, version: '1.0.1' } });
  assert.equal(upgraded.pluginName, first.pluginName); assert.equal(upgraded.marketRoot, first.marketRoot);
  assert.equal(json(manifestPath).plugins.length, 1); assert.equal(json(pluginPath).version, '1.0.1');
  const before = snapshot(first.marketRoot);
  for (const change of [
    { card: { ...input.card, version: '1.0.1', name: 'renamed-shell' } },
    { card: { ...input.card, resourceId: 'another-resource' } },
    { ownerId: 'another-owner' }, { marketName: '../outside' },
  ]) {
    await assert.rejects(() => generateMarket({ ...input, ...change }));
    assert.deepEqual(snapshot(first.marketRoot), before, '拒绝后必须保留原输出');
  }
  console.log('PASS N1/N2：可读英文名、中文简介、重复生成/升级身份及拒绝覆盖。仅文件级验证。');
} catch (error) {
  console.log('LOOP_FAIL_REASON=approved-name-contract'); throw error;
} finally { rmSync(root, { recursive: true, force: true }); }
