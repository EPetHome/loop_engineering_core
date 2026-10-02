// Static read-only inspection of the installed app. This is NOT desktop acceptance evidence.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { requireSafe } from './fs-safety.mjs';
import { readHostArchive } from './host-source.mjs';
const app = '/Applications/WorkBuddy.app/Contents', sha = bytes => createHash('sha256').update(bytes).digest('hex');
function excerpt(source, anchor, before = 80, after = 180) {
  const offset = source.indexOf(anchor); requireSafe(offset >= 0, 'HOST_CONTRACT_ANCHOR_MISSING:' + anchor);
  return { anchor, offset, raw: source.slice(Math.max(0, offset - before), offset + anchor.length + after) };
}
const rendererPath = 'renderer/assets/lib-chat-ui-C7y1ZM_R.js', panelPath = 'renderer/assets/plugins-xKLHRllH.js';
const archive = readHostArchive([rendererPath, panelPath, 'main/index.js']), renderer = archive.entries[rendererPath], panel = archive.entries[panelPath];
const cliPath = 'Resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs';
const cli = readFileSync(join(app, cliPath), 'utf8'), plist = readFileSync(join(app, 'Info.plist'), 'utf8');
const result = { attempt_id: 'developer-r003-d9bd63d9c00c', capturedAt: new Date().toISOString(),
  kind: 'original host static source excerpts; NOT a desktop result',
  hostVersion: /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1],
  infoPlistSha256: sha(plist), asarHeaderSha256: archive.headerSha256,
  sources: [
    { path: rendererPath, sha256: renderer.sha256, excerpts: [
      excerpt(renderer.text, 'className: "cb-plugins-card-name"'),
      excerpt(renderer.text, 'className: "cb-plugin-detail-title"') ] },
    { path: panelPath, sha256: panel.sha256, excerpts: [
      excerpt(panel.text, 'const loadInstalledPlugins =', 0, 1550),
      excerpt(panel.text, 'const loadMarketplacePlugins =', 0, 1350),
      excerpt(panel.text, 'adapter.installPlugins([plugin.name]', 200, 300) ] },
    { path: cliPath, sha256: sha(cli), excerpts: [
      excerpt(cli, 'name:es.name,description:es.description,version:es.version,marketplaceName:this.storageName||this.name'),
      excerpt(cli, 'getPluginId(ei,ea){return`${ei}@${ea}`}') ] },
    { path: 'main/index.js', sha256: archive.entries['main/index.js'].sha256, excerpts: [
      excerpt(archive.entries['main/index.js'].text, 'const gotTheLock = electron.app.requestSingleInstanceLock();'),
      excerpt(archive.entries['main/index.js'].text, 'if (process.env.WB_E2E_DISABLE_STARTUP_REPAIR === "true")'),
      excerpt(archive.entries['main/index.js'].text, 'function createSecureWebPreferences(kind, options = {})', 0, 1100) ] }
  ],
  observed: { cardAndDetailTitleUseName: true, nativeIdUsesNameAtMarket: true,
    installedAndMarketplacePanelCopyNameVerbatim: true, panelDisplayNameOccurrences: panel.text.split('displayName').length - 1,
    displayNameHonoredOnInspectedPanelPath: false, mutableDisplayNameSupport: null },
  note: '当前5.6.2面板将p.name原样映射为卡片name，未传入displayName；安装也直接使用plugin.name。生成器的displayName不能当作名称展示通过。未发现可变标题与固定插件身份分离的原生接法；不修改宿主、DOM或登记补齐。静态映射不替代本次桌面截图。' };
const path = join(dirname(fileURLToPath(import.meta.url)), 'host-contract-r003.json');
writeFileSync(path, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ hostVersion: result.hostVersion, sourceChecks: result.sources.length, mutableDisplayNameSupport: null, report: path }));
